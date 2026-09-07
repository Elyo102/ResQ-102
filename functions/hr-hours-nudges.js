'use strict';

// Unexported application service: durable manual intents only. No FCM, trigger,
// schedule, SDK initialization or logging. A future dispatcher MUST recheck the
// parent action, expiry, actor/recipient/report and fresh silent/quiet policy.
const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { monthKey, projectEmployeeHours, HrHoursInputError } = require('./hr-hours-model');
const { quietAt, decideNotification, notificationIntent } = (() => {
  const policy = require('./hr-notification-policy');
  return { ...policy, quietAt: now => policy.decideNotification({ now_ms: now, mode: 'manual', silent: 'off', send_now: false }).decision === 'confirmation_required' };
})();
const PAGE_SIZE = 25, LIFETIME_MS = 60 * 60 * 1000, QUOTA_WINDOW_MS = 60000, QUOTA_MAX = 10;
const ACTIVE = new Set(['discovering', 'queued', 'processing', 'deferred']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, key) => Object.prototype.hasOwnProperty.call(v, key);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emptyCounts = () => ({ scanned: 0, queued: 0, suppressed: 0, skipped: 0, invalid: 0 });
const hasProgress = action => action.counts.scanned > 0 || action.discovery_scanned > 0;

function createHrHoursNudges({ db, HttpsError, auth, clock = () => Date.now(), hooks = {} }) {
  if (!db || !auth || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function' || typeof clock !== 'function') throw new TypeError('db, HttpsError, auth and clock are required');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const err = (code, text) => new HttpsError(code, text);
  function now() { const n = clock(); if (!Number.isSafeInteger(n) || !Number.isFinite(new Date(n).getTime())) throw err('internal', 'Invalid clock.'); return n; }
  function denied() { const e = err('permission-denied', 'The active HR identity changed.'); e.hrActorDenied = true; return e; }
  const validAuthTime = value => Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000);
  function requireAuthBasis(authTime, validSince) {
    if (!validAuthTime(authTime) || (validSince !== null && authTime * 1000 < validSince)) throw denied();
  }
  function actionRef(sid, id) { return db.collection('stations').doc(sid).collection('hr_nudge_actions').doc(id); }
  function lockRef(uid, month) { return db.collection('hr_nudge_bulk_locks').doc(digest(['hr-bulk-v1', uid, month])); }
  function quotaRef(uid) { return db.collection('hr_nudge_actor_quotas').doc(digest(['hr-quota-v1', uid])); }
  function dto(a) {
    return { action_id: a.action_id, station_id: a.station_id, month: a.month, audience: a.audience,
      status: a.status, reason: a.reason || null, counts: { ...a.counts }, created_at_ms: a.created_at_ms,
      expires_at_ms: a.expires_at_ms, not_before_ms: a.not_before_ms || null,
      phase: a.phase, discovery_scanned: a.discovery_scanned,
      delivery_status: 'intent_only', audience_semantics: a.audience === 'station' ? 'active_when_enqueue_page_scanned_with_completed_discovery_uid_upper_bound' : 'active_when_requested' };
  }
  async function actor(tx, uid, sid, authTime) {
    let user;
    try { user = await auth.getUser(uid); }
    catch (e) { if (e && e.code === 'auth/user-not-found') throw denied(); throw err('unavailable', 'Current authentication could not be read.'); }
    if (!user || user.uid !== uid || user.disabled === true || !plain(user.customClaims)) throw denied();
    let validSince = null;
    if (user.tokensValidAfterTime !== undefined) {
      if (typeof user.tokensValidAfterTime !== 'string' || !user.tokensValidAfterTime.trim()) throw denied();
      validSince = Date.parse(user.tokensValidAfterTime);
      if (!Number.isFinite(validSince)) throw denied();
    }
    // Match Admin SDK revocation semantics: equality remains valid. Keep the
    // verified original authentication time, never refresh it from job claims.
    requireAuthBasis(authTime, validSince);
    const claims = user.customClaims;
    if (claims.stationId !== sid || (claims.super !== true && claims.role !== 'hr_coordinator')) throw denied();
    // Derive effective authority afresh; a formerly-super job never carries a
    // stored bypass. Auth and Firestore are not one atomic snapshot. This read
    // runs again on each Firestore retry, before that attempt's profile read.
    const ctx = identity.context({ auth: { uid, token: claims } });
    if (typeof hooks.afterAuth === 'function') await hooks.afterAuth({ uid, sid });
    try { await identity.requireLive(tx, ctx); }
    catch (e) { if (e instanceof HttpsError && e.code === 'permission-denied') throw denied(); throw e; }
    return { ctx, validSince };
  }
  async function runtime(tx) {
    const snap = await tx.get(db.doc('config/runtime')), r = snap.exists ? snap.data() : null;
    if (!plain(r) || typeof r.silent !== 'boolean' || (own(r, 'silent_allow') && (!Array.isArray(r.silent_allow)
      || r.silent_allow.some(v => typeof v !== 'string' || !v || v.length > 320)))) {
      throw err('failed-precondition', 'Silent configuration is unavailable.');
    }
    return { silent: r.silent ? 'on' : 'off', allow: new Set((r.silent_allow || []).map(v => v.toLowerCase())) };
  }
  async function target(tx, sid, month, snap) {
    const p = snap.exists ? snap.data() : null;
    if (!plain(p) || !access.activeMember(p, sid)) return { kind: 'skipped' };
    const number = p.employee_number;
    if (!['string', 'number'].includes(typeof number) || (typeof number === 'number' && !Number.isFinite(number))) return { kind: 'invalid' };
    const emp = String(number);
    if (!emp || emp.length > 64 || /[\u0000-\u001f\u007f/]/.test(emp)) return { kind: 'invalid' };
    const [index, directory, report] = await Promise.all([
      tx.get(db.collection('emp_index').doc(emp)), tx.get(db.collection('directory').doc(snap.id)),
      tx.get(db.collection('stations').doc(sid).collection('monthly_reports').doc(emp + '_' + month))
    ]);
    const i = index.exists ? index.data() : null, d = directory.exists ? directory.data() : null;
    if (!plain(i) || i.uid !== snap.id || i.stationId !== sid || i.active === false || i.retired === true
      || i.status === 'retired' || !access.activeMember(d, sid)) return { kind: 'invalid' };
    let projection;
    try { projection = projectEmployeeHours({ month, employee: { uid: snap.id, employee_number: emp }, report: report.exists ? report.data() : null, attendance: [] }); }
    catch (e) { if (e instanceof HrHoursInputError) return { kind: 'invalid' }; throw e; }
    if (!['missing', 'draft'].includes(projection.state)) return { kind: 'skipped' };
    return { kind: 'eligible', uid: snap.id, type: projection.state === 'missing' ? 'report_submit' : 'report_confirm' };
  }
  function intent(a, recipient, rt, at) {
    const policy = decideNotification({ now_ms: at, mode: 'manual', silent: rt.silent,
      silent_allow: rt.allow.has(recipient.uid.toLowerCase()), send_now: a.send_now && at < a.confirmation_expires_at_ms });
    if (!['queue', 'suppressed'].includes(policy.decision)) throw err('failed-precondition', 'Manual confirmation is required.');
    const base = notificationIntent({ station_id: a.station_id, recipient_uid: recipient.uid, type: recipient.type, event_id: a.action_id });
    return { ...base, action_id: a.action_id, actor_uid: a.actor_uid, month: a.month,
      transport_type: 'report_mine', status: policy.decision === 'queue' ? 'queued' : 'suppressed',
      reason: policy.reason, created_at_ms: at, expires_at_ms: a.expires_at_ms };
  }
  function collect(a, recipients, rt, at) {
    const counts = { ...a.counts }, intents = [];
    for (const p of recipients) {
      ++counts.scanned;
      if (p.kind !== 'eligible') { ++counts[p.kind]; continue; }
      const value = intent(a, p, rt, at); ++counts[value.status]; intents.push(value);
    }
    return { counts, intents };
  }
  async function beforeWrites(stage, actionId) { if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ stage, actionId }); }
  function putIntents(tx, a, intents) {
    for (const value of intents) tx.create(db.collection('stations').doc(a.station_id).collection('hr_nudge_intents').doc(value.id), value);
  }
  async function request(req) {
    const original = identity.context(req);
    if (!original.super && original.role !== 'hr_coordinator') throw err('permission-denied', 'HR authority is required.');
    const authTime = req.auth.token.auth_time;
    if (!validAuthTime(authTime)) throw err('unauthenticated', 'A verified authentication time is required.');
    const data = req.data;
    if (!plain(data) || Object.keys(data).some(k => !['month', 'request_id', 'uid', 'send_now'].includes(k))
      || !access.validUid(data.request_id) || typeof data.send_now !== 'boolean' || (own(data, 'uid') && !access.validUid(data.uid))) throw err('invalid-argument', 'Invalid request.');
    try { monthKey(data.month); } catch (_) { throw err('invalid-argument', 'Invalid month.'); }
    const sid = original.sid, uid = original.uid, single = own(data, 'uid');
    const id = digest(['hr-action-v1', uid, data.request_id]), ref = actionRef(sid, id);
    const fingerprint = digest(['hr-action-v1', uid, sid, data.month, single ? data.uid : null, data.send_now]);
    return db.runTransaction(async tx => {
      const currentActor = await actor(tx, uid, sid, authTime);
      const replay = await tx.get(ref);
      if (replay.exists) {
        const a = replay.data(); if (a.fingerprint !== fingerprint) throw err('already-exists', 'Request ID conflicts with the recorded action.');
        // A new login cannot revive an action created by a revoked session.
        requireAuthBasis(a.actor_auth_time, currentActor.validSince);
        if (a.audience === 'station' && ACTIVE.has(a.status)) {
          const held = await tx.get(lockRef(uid, data.month));
          await beforeWrites('replay', id);
          const at = now();
          if (at >= a.expires_at_ms) {
            a.status = hasProgress(a) ? 'expired_partial' : 'expired'; a.reason = 'job-expired'; a.updated_at_ms = at;
            tx.set(ref, a);
            // A delayed replay cannot release a newer action's lock.
            if (held.exists && held.data().action_path === ref.path) tx.delete(held.ref);
          }
        }
        return dto(a); // Replays still authorize, but consume no quota.
      }
      const rt = await runtime(tx), quota = await tx.get(quotaRef(uid));
      const old = quota.exists ? quota.data().requests_at_ms : [];
      let recipient = null, lock = null, oldAction = null;
      if (single) {
        const snap = await tx.get(db.collection('stations').doc(sid).collection('users').doc(data.uid));
        recipient = await target(tx, sid, data.month, snap);
      } else {
        lock = await tx.get(lockRef(uid, data.month));
        if (lock.exists) {
          const value = lock.data();
          if (typeof value.action_path !== 'string' || !/^stations\/[^/]+\/hr_nudge_actions\/[a-f0-9]{64}$/.test(value.action_path)
            || !Number.isSafeInteger(value.expires_at_ms)) throw err('failed-precondition', 'Bulk lock is invalid.');
          oldAction = await tx.get(db.doc(value.action_path));
        }
      }
      await beforeWrites('request', id);
      // All asynchronous reads/test barriers precede this decision. Firestore
      // fences the read documents; wall time cannot be part of its transaction,
      // so evaluate quiet hours, quota and deadlines immediately before writes.
      const at = now();
      if (!Array.isArray(old) || old.some(v => !Number.isSafeInteger(v) || v > at)) throw err('failed-precondition', 'Quota state is invalid.');
      const recent = old.filter(v => v > at - QUOTA_WINDOW_MS);
      if (recent.length >= QUOTA_MAX) throw err('resource-exhausted', 'Too many new HR actions.');
      const a = { schema: 'hr-nudge-action-v1', action_id: id, station_id: sid, actor_uid: uid, actor_auth_time: authTime, month: data.month,
        audience: single ? 'person' : 'station', recipient_uid: single ? data.uid : null, fingerprint,
        send_now: data.send_now, confirmation_expires_at_ms: data.send_now ? at + LIFETIME_MS : 0,
        created_at_ms: at, expires_at_ms: at + LIFETIME_MS, updated_at_ms: at,
        status: single ? 'queued' : 'discovering', reason: null, counts: emptyCounts(),
        phase: single ? 'person' : 'discovery', discovery_cursor: null, discovery_scanned: 0,
        cursor: null, max_uid: null, not_before_ms: null };
      let intents = [];
      if (quietAt(at) && !data.send_now) {
        a.status = 'confirmation_required'; a.reason = 'manual-quiet-hours-warning';
      } else if (single) {
        const result = collect(a, [recipient], rt, at);
        a.counts = result.counts; intents = result.intents; a.status = 'completed';
      } else {
        if (oldAction && oldAction.exists && ACTIVE.has(oldAction.data().status) && lock.data().expires_at_ms > at) throw err('already-exists', 'A bulk action is already pending for this actor and month.');
        // Ascending discovery is itself resumable and bounded. Freeze the
        // observed upper UID only when that pass completes, not at request time.
      }
      tx.set(quotaRef(uid), { requests_at_ms: recent.concat(at) });
      if (a.status !== 'confirmation_required' && oldAction && oldAction.exists && ACTIVE.has(oldAction.data().status)) {
        tx.update(oldAction.ref, { status: hasProgress(oldAction.data()) ? 'expired_partial' : 'expired', reason: 'job-expired', updated_at_ms: at });
      }
      if (!single && a.status === 'discovering') tx.set(lockRef(uid, data.month), { action_id: id, action_path: ref.path, expires_at_ms: a.expires_at_ms });
      else if (a.status !== 'confirmation_required' && lock && lock.exists) tx.delete(lock.ref);
      putIntents(tx, a, intents); tx.create(ref, a);
      return dto(a);
    });
  }
  // Trusted internal worker entry only, never a client-authorized station API.
  // It processes at most one 25-document discovery OR enqueue page. Discovery
  // reads IDs only and creates no intents. No transport is invoked here.
  async function processJob(input) {
    if (!plain(input) || Object.keys(input).some(k => !['stationId', 'action_id'].includes(k)) || !access.validId(input.stationId)
      || typeof input.action_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.action_id)) throw err('invalid-argument', 'Invalid internal job reference.');
    const ref = actionRef(input.stationId, input.action_id), initial = await ref.get();
    if (!initial.exists) throw err('not-found', 'Action was not found.');
    const actorUid = initial.data().actor_uid, authTime = initial.data().actor_auth_time;
    if (!access.validUid(actorUid) || !validAuthTime(authTime)) throw err('failed-precondition', 'Action actor is invalid.');
    return db.runTransaction(async tx => {
      let revoked = false;
      try { await actor(tx, actorUid, input.stationId, authTime); }
      catch (e) { if (e.hrActorDenied === true) revoked = true; else throw e; }
      const snap = await tx.get(ref);
      if (!snap.exists) throw err('not-found', 'Action was not found.');
      const a = snap.data();
      if (a.actor_uid !== actorUid || a.actor_auth_time !== authTime || a.station_id !== input.stationId || a.action_id !== input.action_id
        || a.schema !== 'hr-nudge-action-v1') throw err('failed-precondition', 'Action identity is invalid.');
      if (!ACTIVE.has(a.status) || a.audience !== 'station') return dto(a);
      const lock = await tx.get(lockRef(a.actor_uid, a.month));
      if (!lock.exists || lock.data().action_path !== ref.path) throw err('aborted', 'Bulk ownership changed.');
      if (revoked || now() >= a.expires_at_ms) {
        await beforeWrites('finalize', a.action_id); const at = now();
        a.status = revoked ? 'cancelled' : (hasProgress(a) ? 'expired_partial' : 'expired');
        a.reason = revoked ? 'actor-no-longer-authorized' : 'job-expired'; a.updated_at_ms = at;
        tx.set(ref, a); tx.delete(lock.ref); return dto(a);
      }
      const rt = await runtime(tx);
      const discovery = a.phase === 'discovery';
      if (!discovery && (a.phase !== 'enqueue' || !access.validUid(a.max_uid))) throw err('failed-precondition', 'Job phase is invalid.');
      let query = db.collection('stations').doc(a.station_id).collection('users').orderBy('__name__').limit(PAGE_SIZE);
      if (discovery) { if (a.discovery_cursor !== null) query = query.startAfter(a.discovery_cursor); query = query.select(); }
      else { query = query.endAt(a.max_uid); if (a.cursor !== null) query = query.startAfter(a.cursor); }
      const page = await tx.get(query);
      const recipients = discovery ? [] : await Promise.all(page.docs.map(p => target(tx, a.station_id, a.month, p)));
      await beforeWrites('page', a.action_id);
      const at = now();
      if (at >= a.expires_at_ms) {
        a.status = hasProgress(a) ? 'expired_partial' : 'expired'; a.reason = 'job-expired'; a.updated_at_ms = at;
        tx.set(ref, a); tx.delete(lock.ref); return dto(a);
      }
      if (quietAt(at) && !(a.send_now && at < a.confirmation_expires_at_ms)) {
        const p = decideNotification({ now_ms: at, mode: 'manual', silent: 'off', send_now: false });
        a.status = 'deferred'; a.reason = 'manual-quiet-hours-warning'; a.not_before_ms = p.not_before_ms; a.updated_at_ms = at;
        tx.set(ref, a); return dto(a);
      }
      if (discovery) {
        a.discovery_scanned += page.docs.length;
        if (page.docs.length) a.discovery_cursor = page.docs[page.docs.length - 1].id;
        a.updated_at_ms = at; a.reason = null; a.not_before_ms = null;
        if (page.docs.length < PAGE_SIZE) {
          // The final observed key remains a valid bound even if that document
          // was deleted meanwhile. This is not a frozen membership snapshot.
          a.max_uid = a.discovery_cursor;
          a.phase = a.max_uid === null ? 'complete' : 'enqueue';
          a.status = a.max_uid === null ? 'completed' : 'queued';
        } else a.status = 'discovering';
        tx.set(ref, a);
        if (a.status === 'completed') tx.delete(lock.ref);
        return dto(a);
      }
      const result = collect(a, recipients, rt, at);
      a.counts = result.counts; a.updated_at_ms = at; a.not_before_ms = null; a.reason = null;
      if (page.docs.length) a.cursor = page.docs[page.docs.length - 1].id;
      const complete = page.docs.length < PAGE_SIZE || a.cursor === a.max_uid;
      a.status = complete ? 'completed' : 'processing';
      if (complete) a.phase = 'complete';
      putIntents(tx, a, result.intents); tx.set(ref, a);
      if (complete) tx.delete(lock.ref);
      return dto(a);
    });
  }
  return Object.freeze({ request, processJob });
}
module.exports = Object.freeze({ createHrHoursNudges, PAGE_SIZE, LIFETIME_MS, QUOTA_WINDOW_MS, QUOTA_MAX });
