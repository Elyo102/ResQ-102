'use strict';

// Internal hours-only worker. No SDK initialization, export registration, FCM
// credentials, scheduler or logging. FCM is always outside retryable DB work.
const { createHash, randomBytes } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { projectEmployeeHours, HrHoursInputError } = require('./hr-hours-model');
const { decideNotification, notificationIntent } = require('./hr-notification-policy');
const LIMITS = Object.freeze({ candidates: 25, actionPages: 25, perAction: 5, intents: 25,
  concurrency: 5, devices: 500, startBudgetMs: 60000, leaseMs: 600000 });
const ACTIVE = ['discovering', 'queued', 'processing', 'deferred'];
const READY = ['queued', 'blocked', 'deferred'];
const FAILED = new Set(['messaging/invalid-argument', 'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered', 'messaging/mismatched-credential', 'messaging/sender-id-mismatch']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hash = v => createHash('sha256').update(v).digest('hex');
const authTimeValid = v => Number.isSafeInteger(v) && v >= 0 && Number.isSafeInteger(v * 1000);
const safeTime = v => Number.isSafeInteger(v) && Number.isFinite(new Date(v).getTime());
const codeOf = e => typeof e?.code === 'string' ? e.code : '';

function createHrHoursDispatch({ db, auth, messaging, HttpsError, processJob, clock = () => Date.now(), hooks = {} }) {
  if (!db || typeof auth?.getUser !== 'function' || typeof messaging?.sendEachForMulticast !== 'function'
    || typeof HttpsError !== 'function' || typeof processJob !== 'function') throw new TypeError('Dispatcher dependencies are required.');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const now = () => { const value = clock(); if (!safeTime(value)) throw new TypeError('Invalid clock.'); return value; };
  const fault = (reason, terminal = false) => Object.assign(new Error(reason), { dispatchReason: reason, terminal });
  const hook = async (name, value) => { if (typeof hooks[name] === 'function') await hooks[name](value); };
  const backoff = count => [60000, 120000, 240000, 480000, 900000][Math.min(Math.max(count - 1, 0), 4)];
  function locate(ref, collection) {
    const p = ref.path.split('/');
    if (p.length !== 4 || p[0] !== 'stations' || p[2] !== collection || !access.validId(p[1])
      || !/^[a-f0-9]{64}$/.test(p[3])) throw fault('invalid-path', true);
    return { sid: p[1], id: p[3] };
  }
  async function freshUser(uid) {
    try {
      const user = await auth.getUser(uid);
      if (!user || user.uid !== uid || user.disabled !== false || !plain(user.customClaims)) throw fault('identity-unavailable', true);
      return user;
    } catch (e) {
      if (e.dispatchReason) throw e;
      throw fault(codeOf(e) === 'auth/user-not-found' ? 'identity-missing' : 'auth-unavailable', codeOf(e) === 'auth/user-not-found');
    }
  }
  async function actor(tx, a) {
    if (!access.validUid(a.actor_uid) || !authTimeValid(a.actor_auth_time)) throw fault('invalid-actor', true);
    const user = await freshUser(a.actor_uid), c = user.customClaims;
    if (user.tokensValidAfterTime !== undefined) {
      const ms = typeof user.tokensValidAfterTime === 'string' && user.tokensValidAfterTime.trim() ? Date.parse(user.tokensValidAfterTime) : NaN;
      if (!Number.isFinite(ms) || a.actor_auth_time * 1000 < ms) throw fault('actor-revoked', true);
    }
    if (c.stationId !== a.station_id || (c.super !== true && c.role !== 'hr_coordinator')) throw fault('actor-revoked', true);
    try { await identity.requireLive(tx, identity.context({ auth: { uid: a.actor_uid, token: c } })); }
    catch (e) { throw fault('actor-profile-unavailable', codeOf(e) === 'permission-denied'); }
  }
  async function recipient(tx, sid, uid, month) {
    const user = await freshUser(uid);
    if (user.customClaims.stationId !== sid) throw fault('recipient-moved', true);
    const profile = await tx.get(db.doc('stations/' + sid + '/users/' + uid));
    const p = profile.exists ? profile.data() : null;
    if (!plain(p) || !access.activeMember(p, sid)) throw fault('recipient-inactive', true);
    const number = p.employee_number;
    if (!['string', 'number'].includes(typeof number) || (typeof number === 'number' && !Number.isFinite(number))) throw fault('recipient-invalid', true);
    const emp = String(number);
    if (!emp || emp.length > 64 || /[\u0000-\u001f\u007f/]/.test(emp)) throw fault('recipient-invalid', true);
    const [index, directory, report] = await Promise.all([tx.get(db.doc('emp_index/' + emp)),
      tx.get(db.doc('directory/' + uid)), tx.get(db.doc('stations/' + sid + '/monthly_reports/' + emp + '_' + month))]);
    const i = index.exists ? index.data() : null, d = directory.exists ? directory.data() : null;
    if (!plain(i) || i.uid !== uid || i.stationId !== sid || i.active === false || i.retired === true
      || i.status === 'retired' || !access.activeMember(d, sid)) throw fault('recipient-binding-changed', true);
    let projection;
    try { projection = projectEmployeeHours({ month, employee: { uid, employee_number: emp }, report: report.exists ? report.data() : null, attendance: [] }); }
    catch (e) { if (e instanceof HrHoursInputError) throw fault('report-invalid', true); throw e; }
    if (!['missing', 'draft'].includes(projection.state)) throw fault('report-completed', true);
    return projection.state === 'missing' ? 'report_submit' : 'report_confirm';
  }
  function validateIntent(v, loc) {
    if (!plain(v) || v.id !== loc.id || v.station_id !== loc.sid || !access.validUid(v.recipient_uid)
      || !/^[a-f0-9]{64}$/.test(v.action_id || '') || v.event_id !== v.action_id
      || !['report_submit', 'report_confirm'].includes(v.type) || v.transport_type !== 'report_mine'
      || !safeTime(v.expires_at_ms) || !safeTime(v.created_at_ms)) throw fault('invalid-intent', true);
    const expected = notificationIntent({ station_id: loc.sid, recipient_uid: v.recipient_uid, type: v.type, event_id: v.event_id });
    if (expected.id !== loc.id) throw fault('invalid-intent', true);
  }
  async function recordBlocked(ref, reason, terminal) {
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists) return;
      const v = snap.data(); if (!READY.includes(v.status)) return;
      const at = now(), n = Number.isSafeInteger(v.dispatch_check_count) ? v.dispatch_check_count + 1 : 1;
      tx.update(ref, { status: terminal ? 'cancelled' : 'blocked', reason,
        dispatch_check_count: n, next_check_ms: terminal ? null : Math.min(at + backoff(n), v.expires_at_ms), updated_at_ms: at });
    });
  }
  async function claim(ref, reserve) {
    const loc = locate(ref, 'hr_nudge_intents'), attempt = randomBytes(16).toString('hex');
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists) return null;
      const v = snap.data();
      if (!READY.includes(v.status) || (v.status === 'blocked' && v.terminal === true)) return null;
      validateIntent(v, loc);
      const aSnap = await tx.get(db.doc('stations/' + loc.sid + '/hr_nudge_actions/' + v.action_id));
      const a = aSnap.exists ? aSnap.data() : null;
      if (!plain(a) || a.schema !== 'hr-nudge-action-v1' || a.action_id !== v.action_id || a.station_id !== loc.sid
        || a.actor_uid !== v.actor_uid || a.month !== v.month || a.expires_at_ms !== v.expires_at_ms
        || (a.audience === 'person' && a.recipient_uid !== v.recipient_uid)) throw fault('parent-invalid', true);
      if (!['completed', ...ACTIVE].includes(a.status)) throw fault('parent-cancelled', true);
      await actor(tx, a);
      const dispatchType = await recipient(tx, loc.sid, v.recipient_uid, v.month);
      const [runtime, tokenDoc] = await Promise.all([tx.get(db.doc('config/runtime')),
        tx.get(db.doc('stations/' + loc.sid + '/push_tokens/' + v.recipient_uid))]);
      const rt = runtime.exists ? runtime.data() : null;
      if (!plain(rt) || typeof rt.silent !== 'boolean' || (rt.silent_allow !== undefined && (!Array.isArray(rt.silent_allow)
        || rt.silent_allow.some(x => typeof x !== 'string' || !x || x.length > 320)))) throw fault('silent-state-unavailable');
      const stored = tokenDoc.exists ? tokenDoc.data() : null;
      if (stored !== null && (!plain(stored) || !Array.isArray(stored.tokens))) throw fault('tokens-invalid');
      const list = stored?.tokens || [];
      if (list.some(t => !plain(t) || typeof t.token !== 'string' || !t.token.trim() || t.token.length > 4096)) throw fault('tokens-invalid');
      const tokens = [...new Set(list.map(t => t.token))];
      await hook('beforeClaim', { path: ref.path });
      const at = now();
      if (at >= a.expires_at_ms) { tx.update(ref, { status: 'cancelled', reason: 'expired', updated_at_ms: at }); return null; }
      if ((v.status === 'blocked' && v.next_check_ms > at) || (v.status === 'deferred' && v.not_before_ms > at)) return null;
      const decision = decideNotification({ now_ms: at, mode: 'manual', silent: rt.silent ? 'on' : 'off',
        silent_allow: (rt.silent_allow || []).some(x => x.toLowerCase() === v.recipient_uid.toLowerCase()),
        send_now: a.send_now === true && at < a.confirmation_expires_at_ms });
      if (decision.decision === 'suppressed') { tx.update(ref, { status: 'suppressed', reason: decision.reason, updated_at_ms: at }); return null; }
      if (decision.decision !== 'queue') { tx.update(ref, { status: 'deferred', reason: decision.reason, not_before_ms: decision.not_before_ms, updated_at_ms: at }); return null; }
      if (!tokens.length) { tx.update(ref, { status: 'no_device', reason: 'no-current-token', updated_at_ms: at }); return null; }
      if (tokens.length > LIMITS.devices) { tx.update(ref, { status: 'blocked', terminal: true, reason: 'token-limit', updated_at_ms: at }); return null; }
      if (!reserve(tokens.length)) return null;
      const note = notificationIntent({ station_id: loc.sid, recipient_uid: v.recipient_uid, type: dispatchType, event_id: v.event_id });
      tx.update(ref, { status: 'attempting', reason: null, attempt_id: attempt, lease_until_ms: at + LIMITS.leaseMs,
        dispatch_started_at_ms: at, dispatch_type: dispatchType, token_count: tokens.length, updated_at_ms: at });
      return { attempt, tokens, expires: a.expires_at_ms, sendNow: a.send_now === true,
        confirmationExpires: a.confirmation_expires_at_ms, payload: { tokens, data: { title: note.title, body: note.body,
        url: './attendance.html', tag: 'hr-' + v.id, important: '0' }, webpush: { headers: { Urgency: 'normal' } } } };
    });
  }
  function outcomes(result, tokens) {
    const valid = result && Array.isArray(result.responses) && result.responses.length === tokens.length;
    return tokens.map((token, i) => {
      const r = valid ? result.responses[i] : null, code = codeOf(r?.error);
      const status = r?.success === true && typeof r.messageId === 'string' && r.messageId ? 'accepted'
        : r?.success === false && FAILED.has(code) ? 'failed' : 'outcome_unknown';
      return { token_hash: hash(token), status, code: status === 'failed' ? code : status === 'outcome_unknown' ? 'unconfirmed-outcome' : null };
    });
  }
  async function finalize(ref, sent, result) {
    const devices = outcomes(result, sent.tokens), counts = { accepted: 0, failed: 0, outcome_unknown: 0 };
    devices.forEach(d => ++counts[d.status]);
    const status = counts.outcome_unknown ? 'outcome_unknown' : counts.accepted === devices.length ? 'accepted'
      : counts.failed === devices.length ? 'failed' : 'partial';
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().status !== 'attempting' || snap.data().attempt_id !== sent.attempt) return;
      tx.update(ref, { status, device_outcomes: devices, outcome_counts: counts, finished_at_ms: now(),
        delivery_status: 'provider_outcome_only', reason: counts.outcome_unknown ? 'unconfirmed-outcome' : null });
    });
    return status;
  }
  async function retire(ref) {
    locate(ref, 'hr_nudge_intents');
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists) return;
      const v = snap.data(), at = now();
      if (v.status === 'attempting' && (v.lease_until_ms <= at || v.expires_at_ms <= at)) {
        tx.update(ref, { status: 'outcome_unknown', reason: 'attempt-expired', finished_at_ms: at, delivery_status: 'provider_outcome_only' });
      } else if (READY.includes(v.status) && v.expires_at_ms <= at) {
        tx.update(ref, { status: 'cancelled', reason: 'expired', updated_at_ms: at });
      }
    });
  }
  async function actionBackoff(ref, failed) {
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref); if (!snap.exists || !ACTIVE.includes(snap.data().status)) return;
      const v = snap.data(), at = now(), n = Number.isSafeInteger(v.dispatch_check_count) ? v.dispatch_check_count : 0;
      tx.update(ref, { updated_at_ms: at, ...(failed ? { dispatch_check_count: n + 1,
        dispatch_next_check_ms: Math.min(at + backoff(n + 1), v.expires_at_ms), dispatch_reason: 'page-check-unavailable' } : {}) });
    });
  }
  function interleave(groups) {
    const out = [], seen = new Set();
    for (let i = 0; i < LIMITS.candidates; ++i) for (const docs of groups) {
      const d = docs[i]; if (d && !seen.has(d.ref.path)) { seen.add(d.ref.path); out.push(d); }
    }
    return out;
  }
  async function run() {
    const began = now(), within = () => now() < began + LIMITS.startBudgetMs;
    const stats = { action_pages: 0, intents_checked: 0, transport_calls: 0, device_starts: 0, errors: 0 };
    const ac = db.collectionGroup('hr_nudge_actions'), ic = db.collectionGroup('hr_nudge_intents');
    // Every family has a bounded query; indexes are a deployment prerequisite.
    const actionQueries = [ac.where('status', 'in', ACTIVE).where('expires_at_ms', '<=', began).orderBy('expires_at_ms'),
      ac.where('status', '==', 'deferred').where('not_before_ms', '<=', began).orderBy('not_before_ms'),
      ac.where('status', 'in', ACTIVE).orderBy('updated_at_ms')];
    const actions = interleave(await Promise.all(actionQueries.map(async q => (await q.limit(LIMITS.candidates).get()).docs)));
    const pages = new Map();
    async function advance(max) {
      let calls = 0;
      while (actions.length && calls < max && stats.action_pages < LIMITS.actionPages && within()) {
        const d = actions.shift(), count = pages.get(d.ref.path) || 0;
        if (count >= LIMITS.perAction) continue;
        let loc;
        try { loc = locate(d.ref, 'hr_nudge_actions'); } catch (_) { ++stats.errors; continue; }
        const v = d.data(), checkAt = now();
        if (v.expires_at_ms > checkAt && (v.dispatch_next_check_ms > checkAt
          || (v.status === 'deferred' && v.not_before_ms > checkAt))) {
          try { await actionBackoff(d.ref, false); } catch (_) { ++stats.errors; }
          continue;
        }
        ++calls; ++stats.action_pages; pages.set(d.ref.path, count + 1);
        try {
          const result = await processJob({ stationId: loc.sid, action_id: loc.id });
          if (['discovering', 'queued', 'processing'].includes(result.status)) actions.push(d);
        } catch (_) { ++stats.errors; try { await actionBackoff(d.ref, true); } catch (_) { ++stats.errors; } }
      }
    }
    await advance(5); // Reserve some generation progress even under send backlog.
    const at = now();
    const intentQueries = [ic.where('status', 'in', [...READY, 'attempting']).where('expires_at_ms', '<=', at).orderBy('expires_at_ms'),
      ic.where('status', '==', 'attempting').where('lease_until_ms', '<=', at).orderBy('lease_until_ms'),
      ic.where('status', '==', 'deferred').where('not_before_ms', '<=', at).orderBy('not_before_ms'),
      ic.where('status', '==', 'blocked').where('next_check_ms', '<=', at).orderBy('next_check_ms'),
      ic.where('status', '==', 'queued').orderBy('created_at_ms')];
    const intents = interleave(await Promise.all(intentQueries.map(async q => (await q.limit(LIMITS.candidates).get()).docs)));
    let reserved = 0;
    async function consume() {
      while (intents.length && stats.intents_checked < LIMITS.intents && within()) {
        const d = intents.shift(); ++stats.intents_checked;
        let held = 0, sent;
        const reserve = n => {
          if (!within() || reserved - held + n > LIMITS.devices) return false;
          reserved += n - held; held = n; return true;
        };
        try {
          await retire(d.ref);
          sent = await claim(d.ref, reserve);
          if (!sent) { reserved -= held; continue; }
        } catch (e) {
          reserved -= held; ++stats.errors;
          try { await recordBlocked(d.ref, e.dispatchReason || 'preflight-unavailable', e.terminal === true); } catch (_) { ++stats.errors; }
          continue;
        }
        // Hooks model crashes; once attempting is durable an exception must
        // leave it for unknown recovery, never create a new send attempt.
        try {
          await hook('afterClaim', { path: d.ref.path, attempt_id: sent.attempt });
          // A still-owned attempt that never entered the SDK can be cancelled
          // explicitly. Do not start a late call after a hook/clock boundary.
          const start = now(), policy = decideNotification({ now_ms: start, mode: 'manual', silent: 'off',
            send_now: sent.sendNow && start < sent.confirmationExpires });
          if (!within() || start >= sent.expires || policy.decision !== 'queue') {
            await db.runTransaction(async tx => {
              const latest = await tx.get(d.ref);
              if (latest.exists && latest.data().status === 'attempting' && latest.data().attempt_id === sent.attempt) {
                tx.update(d.ref, { status: 'cancelled', reason: 'dispatch-window-closed', finished_at_ms: start });
              }
            });
            continue;
          }
          ++stats.transport_calls; stats.device_starts += held;
          let result;
          try { result = await messaging.sendEachForMulticast(sent.payload); } catch (_) { result = null; }
          await hook('afterSend', { path: d.ref.path, attempt_id: sent.attempt });
          await finalize(d.ref, sent, result);
        } catch (_) { ++stats.errors; }
      }
    }
    await Promise.all(Array.from({ length: LIMITS.concurrency }, () => consume()));
    await advance(LIMITS.actionPages - stats.action_pages);
    return Object.freeze({ ...stats, delivery_status: 'provider_outcome_only' });
  }
  return Object.freeze({ run });
}
module.exports = Object.freeze({ createHrHoursDispatch, LIMITS });
