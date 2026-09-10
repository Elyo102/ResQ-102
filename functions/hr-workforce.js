'use strict';

// Private HR workforce cases: prolonged absence and approved leave abroad.
// This module has no callable/scheduler registration and emits notification
// work only. Transport, Firestore rules and UI are deliberately wired elsewhere.
const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity, MEMBER_ROLES } = require('./ops-member-identity');

const KINDS = Object.freeze(['long_absence', 'abroad_leave']);
const STATUSES = Object.freeze(['active', 'closed']);
const PAGE_SIZE = 25, QUOTA_MAX = 10, QUOTA_WINDOW_MS = 60000;
const KEY = /^[a-f0-9]{64}$/, REQUEST_ID = /^[A-Za-z0-9_-]{8,120}$/;
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function jerusalemDay(at) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(at)).reduce((out, part) => Object.assign(out, { [part.type]: part.value }), {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function createHrWorkforce({ db, auth, HttpsError, clock = Date.now, day = jerusalemDay, hooks = {} } = {}) {
  if (!db || !auth || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db, auth and HttpsError required');
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  const root = sid => db.collection('stations').doc(sid);
  const recordRef = (sid, id) => root(sid).collection('hr_workforce_cases').doc(id);
  const operationRef = (sid, id) => root(sid).collection('hr_workforce_operations').doc(id);
  const quotaRef = uid => db.collection('hr_workforce_actor_quotas').doc(hash(['hr-workforce-quota-v1', uid]));
  function now() {
    const at = clock();
    if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw error('internal', 'Invalid clock.');
    return at;
  }
  function date(value, nullable = false) {
    if (nullable && value === null) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw error('invalid-argument', 'Invalid date.');
    const parsed = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw error('invalid-argument', 'Invalid date.');
    return value;
  }
  function text(value, max) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      throw error('invalid-argument', 'Invalid text.');
    }
    const out = value.replace(/\r\n?/g, '\n').trim();
    if (!out) throw error('invalid-argument', 'Reason is required.');
    return out;
  }
  function request(req, keys) {
    const ctx = identity.context(req), data = req.data, authTime = req.auth.token.auth_time;
    if (!plain(data) || Object.keys(data).some(k => !keys.includes(k))) throw error('invalid-argument', 'Invalid request fields.');
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) throw error('unauthenticated', 'Refresh your sign-in.');
    if (!ctx.super && ctx.role !== 'hr_coordinator') throw error('permission-denied', 'HR authority required.');
    return { ctx, data, authTime };
  }
  async function live(tx, r) {
    let user;
    try { user = await auth.getUser(r.ctx.uid); }
    catch (cause) {
      if (cause?.code === 'auth/user-not-found') throw error('permission-denied', 'The current account is unavailable.');
      throw error('unavailable', 'Current authentication could not be verified.');
    }
    const claims = user?.customClaims;
    if (!user || user.uid !== r.ctx.uid || user.disabled === true || !plain(claims)
      || claims.stationId !== r.ctx.sid || (claims.super === true) !== r.ctx.super
      || (!r.ctx.super && claims.role !== r.ctx.role)) throw error('permission-denied', 'Your role or station changed.');
    if (user.tokensValidAfterTime !== undefined) {
      const validAfter = Date.parse(user.tokensValidAfterTime);
      if (!Number.isFinite(validAfter)) throw error('unavailable', 'Authentication validity is unavailable.');
      if (r.authTime * 1000 < validAfter) throw error('permission-denied', 'Your sign-in was revoked.');
    }
    return identity.requireLive(tx, r.ctx);
  }
  async function subject(tx, sid, uid) {
    if (!access.validUid(uid)) throw error('invalid-argument', 'Invalid employee.');
    let authUser;
    try { authUser = await auth.getUser(uid); }
    catch (cause) {
      if (cause?.code === 'auth/user-not-found') throw error('permission-denied', 'Employee is unavailable.');
      throw error('unavailable', 'Employee identity could not be verified.');
    }
    const claims = authUser?.customClaims, snap = await tx.get(root(sid).collection('users').doc(uid));
    const profile = snap.exists ? snap.data() : null;
    if (!authUser || authUser.uid !== uid || authUser.disabled === true || !plain(claims)
      || claims.stationId !== sid || claims.super === true || !MEMBER_ROLES.includes(claims.role)
      || !access.activeMember(profile, sid) || profile.role !== claims.role) {
      throw error('permission-denied', 'Employee is not an active member of this station.');
    }
    const fullName = typeof profile.full_name === 'string' ? profile.full_name.trim().slice(0, 160) : '';
    const employeeNumber = String(profile.employee_number ?? '').trim();
    if (!fullName || !employeeNumber || employeeNumber.length > 64 || /[\u0000-\u001f\u007f/]/.test(employeeNumber)) {
      throw error('failed-precondition', 'Employee identity is incomplete.');
    }
    return { uid, employee_number: employeeNumber, full_name: fullName, role: profile.role };
  }
  function normalized(data) {
    if (!KINDS.includes(data.kind) || !STATUSES.includes(data.status)) throw error('invalid-argument', 'Invalid case kind or status.');
    const start = date(data.start_date), end = date(data.end_date, true), followup = date(data.followup_date);
    if (end !== null && end < start || followup < start || data.kind === 'abroad_leave' && end === null
      || data.status === 'closed' && end === null) throw error('invalid-argument', 'Invalid case dates.');
    return { subject_uid: data.subject_uid, kind: data.kind, start_date: start, end_date: end,
      followup_date: followup, reason: text(data.reason, 2000), status: data.status };
  }
  function validRecord(snap, sid) {
    if (!snap.exists) throw error('not-found', 'HR case not found.');
    const d = snap.data();
    if (!plain(d) || d.schema !== 'hr-workforce-case-v1' || d.record_id !== snap.id || d.station_id !== sid
      || !access.validUid(d.subject_uid) || typeof d.subject_full_name !== 'string' || !d.subject_full_name.trim()
      || typeof d.subject_employee_number !== 'string' || !d.subject_employee_number.trim()
      || !KINDS.includes(d.kind) || !STATUSES.includes(d.status)
      || !Number.isSafeInteger(d.revision) || d.revision < 1) throw error('failed-precondition', 'HR case data is invalid.');
    normalized(d);
    return d;
  }
  async function beforeWrites(stage) { if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ stage }); }
  function mutation(req, op) {
    const base = ['request_id', 'subject_uid', 'kind', 'start_date', 'end_date', 'followup_date', 'reason', 'status'];
    const r = request(req, op === 'create' ? base : base.concat(['record_id', 'expected_revision']));
    if (typeof r.data.request_id !== 'string' || !REQUEST_ID.test(r.data.request_id)) throw error('invalid-argument', 'Invalid request identity.');
    if (op === 'update' && (typeof r.data.record_id !== 'string' || !KEY.test(r.data.record_id)
      || !Number.isSafeInteger(r.data.expected_revision) || r.data.expected_revision < 1)) throw error('invalid-argument', 'Invalid case revision.');
    const plan = normalized(r.data);
    if (op === 'create' && plan.status !== 'active') throw error('invalid-argument', 'A new case must be active.');
    return { ...r, plan };
  }
  async function mutate(req, op) {
    const r = mutation(req, op), p = r.plan;
    const id = op === 'create' ? hash(['hr-workforce-case-v1', r.ctx.uid, r.data.request_id]) : r.data.record_id;
    const opId = hash(['hr-workforce-operation-v1', r.ctx.uid, r.data.request_id]);
    const fingerprint = hash(['hr-workforce-payload-v1', r.ctx.sid, r.ctx.uid, op, id, p]);
    const ref = recordRef(r.ctx.sid, id), receipt = operationRef(r.ctx.sid, opId), quota = quotaRef(r.ctx.uid);
    return db.runTransaction(async tx => {
      const actor = await live(tx, r);
      const [prior, currentSnap, quotaSnap] = await Promise.all([tx.get(receipt), tx.get(ref), tx.get(quota)]);
      const current = currentSnap.exists ? validRecord(currentSnap, r.ctx.sid) : null;
      if (prior.exists) {
        const old = prior.data();
        if (old.fingerprint !== fingerprint || old.actor_uid !== r.ctx.uid || old.record_id !== id) throw error('already-exists', 'Request identity already used.');
        await beforeWrites('replay'); await live(tx, r); return { ...old.result, duplicate: true };
      }
      if (op === 'create' && current || op === 'update' && !current) throw error(op === 'create' ? 'already-exists' : 'not-found', 'HR case conflict.');
      if (current && (current.revision !== r.data.expected_revision || current.subject_uid !== p.subject_uid)) throw error('aborted', 'HR case changed.');
      const closing = op === 'update' && p.status === 'closed';
      if (!closing) await subject(tx, r.ctx.sid, p.subject_uid);
      const at = now(), oldQuota = quotaSnap.exists ? quotaSnap.data().requests_at_ms : [];
      if (!Array.isArray(oldQuota) || oldQuota.some(v => !Number.isSafeInteger(v) || v > at)) throw error('failed-precondition', 'Quota data is invalid.');
      const recent = oldQuota.filter(v => v > at - QUOTA_WINDOW_MS);
      if (recent.length >= QUOTA_MAX) throw error('resource-exhausted', 'Too many HR actions.');
      await beforeWrites(op); const freshActor = await live(tx, r);
      const freshSubject = closing ? {
        uid: current.subject_uid,
        employee_number: current.subject_employee_number,
        full_name: current.subject_full_name
      } : await subject(tx, r.ctx.sid, p.subject_uid);
      const revision = current ? current.revision + 1 : 1;
      const next = { schema: 'hr-workforce-case-v1', record_id: id, station_id: r.ctx.sid, ...p,
        subject_employee_number: freshSubject.employee_number, subject_full_name: freshSubject.full_name, revision,
        created_at_ms: current?.created_at_ms ?? at, updated_at_ms: at };
      const eventId = hash(['hr-workforce-event-v1', opId]);
      const event = { schema: 'hr-workforce-event-v1', event_id: eventId, record_id: id, station_id: r.ctx.sid,
        subject_uid: p.subject_uid, actor_uid: freshActor.uid, actor_role: freshActor.role,
        actor_employee_number: freshActor.employee_number, actor_auth_time: r.authTime, kind: op,
        revision, reason: p.reason, before: current, after: next, created_at_ms: at };
      const result = { record_id: id, revision, status: p.status, event_id: eventId };
      tx.set(ref, next); tx.create(ref.collection('events').doc(eventId), event);
      tx.create(receipt, { schema: 'hr-workforce-operation-v1', record_id: id, actor_uid: r.ctx.uid,
        fingerprint, result, created_at_ms: at });
      tx.set(quota, { requests_at_ms: recent.concat(at) });
      return { ...result, duplicate: false };
    });
  }
  async function queueReminder(req) {
    const r = request(req, ['request_id', 'record_id', 'expected_revision']);
    if (typeof r.data.request_id !== 'string' || !REQUEST_ID.test(r.data.request_id) || typeof r.data.record_id !== 'string'
      || !KEY.test(r.data.record_id) || !Number.isSafeInteger(r.data.expected_revision) || r.data.expected_revision < 1) throw error('invalid-argument', 'Invalid reminder request.');
    const opId = hash(['hr-workforce-reminder-operation-v1', r.ctx.uid, r.data.request_id]);
    const fingerprint = hash(['hr-workforce-reminder-payload-v1', r.ctx.sid, r.ctx.uid, r.data]);
    const ref = recordRef(r.ctx.sid, r.data.record_id), receipt = operationRef(r.ctx.sid, opId);
    return db.runTransaction(async tx => {
      await live(tx, r); const [prior, snap] = await Promise.all([tx.get(receipt), tx.get(ref)]); const current = validRecord(snap, r.ctx.sid);
      const reminderId = hash(['hr-workforce-followup-v1', r.ctx.sid, current.record_id, current.revision, current.followup_date]);
      const reminderRef = root(r.ctx.sid).collection('hr_workforce_reminder_locks').doc(reminderId);
      const reminder = await tx.get(reminderRef);
      if (prior.exists) { const old = prior.data(); if (old.fingerprint !== fingerprint) throw error('already-exists', 'Request identity already used.'); await beforeWrites('reminder-replay'); await live(tx, r); return { ...old.result, duplicate: true }; }
      if (current.revision !== r.data.expected_revision || current.status !== 'active') throw error('aborted', 'HR case is no longer due.');
      const today = date(day(now())); if (current.followup_date > today) throw error('failed-precondition', 'Follow-up is not due.');
      await subject(tx, r.ctx.sid, current.subject_uid); await beforeWrites('reminder'); const reminderActor = await live(tx, r); await subject(tx, r.ctx.sid, current.subject_uid);
      const at = now(), eventId = reminderId;
      const result = { record_id: current.record_id, revision: current.revision, event_id: eventId, notification_status: 'intent_only' };
      if (reminder.exists) {
        const old = reminder.data();
        if (!plain(old) || old.record_id !== current.record_id || old.revision !== current.revision
          || old.followup_date !== current.followup_date || old.event_id !== eventId) throw error('failed-precondition', 'Reminder lock is invalid.');
        tx.create(receipt, { schema: 'hr-workforce-operation-v1', record_id: current.record_id,
          actor_uid: r.ctx.uid, fingerprint, result, created_at_ms: at });
        return { ...result, duplicate: true };
      }
      tx.create(ref.collection('events').doc(eventId), { schema: 'hr-workforce-event-v1', event_id: eventId,
        record_id: current.record_id, station_id: r.ctx.sid, subject_uid: current.subject_uid,
        actor_uid: reminderActor.uid, actor_role: reminderActor.role,
        actor_employee_number: reminderActor.employee_number, actor_auth_time: r.authTime,
        kind: 'reminder', revision: current.revision, reason: 'followup_due', before: current, after: current, created_at_ms: at });
      // Deliberately contains no case kind, dates or reason. Provider delivery is outside this module.
      tx.create(root(r.ctx.sid).collection('hr_workforce_notification_jobs').doc(eventId), {
        schema: 'hr-workforce-notification-v1', event_id: eventId, record_id: current.record_id,
        station_id: r.ctx.sid, actor_uid: r.ctx.uid, actor_auth_time: r.authTime,
        audience: 'station_hr', type: 'hr_workforce_followup', status: 'policy_pending',
        delivery_status: 'intent_only', created_at_ms: at, neutral: true,
        send_now: false, consent_expires_at_ms: 0, routine_after_quiet: true, exclude_actor: true
      });
      tx.create(reminderRef, { schema: 'hr-workforce-reminder-lock-v1', record_id: current.record_id,
        revision: current.revision, followup_date: current.followup_date, event_id: eventId, created_at_ms: at });
      tx.create(receipt, { schema: 'hr-workforce-operation-v1', record_id: current.record_id,
        actor_uid: r.ctx.uid, fingerprint, result, created_at_ms: at });
      return { ...result, duplicate: false };
    });
  }
  async function list(req) {
    const r = request(req, ['cursor']);
    if (own(r.data, 'cursor') && (typeof r.data.cursor !== 'string' || !KEY.test(r.data.cursor))) throw error('invalid-argument', 'Invalid cursor.');
    const result = await db.runTransaction(async tx => {
      await live(tx, r); let q = root(r.ctx.sid).collection('hr_workforce_cases').orderBy('__name__').limit(PAGE_SIZE + 1);
      if (r.data.cursor) q = q.startAfter(r.data.cursor); const page = await tx.get(q), docs = page.docs.slice(0, PAGE_SIZE);
      return { items: docs.map(s => validRecord(s, r.ctx.sid)), next_cursor: page.size > PAGE_SIZE ? docs.at(-1).id : null };
    });
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize();
    await db.runTransaction(async tx => { await live(tx, r); });
    return result;
  }
  return Object.freeze({ create: req => mutate(req, 'create'), update: req => mutate(req, 'update'), list, queueReminder });
}

module.exports = Object.freeze({ createHrWorkforce, KINDS, STATUSES, PAGE_SIZE, QUOTA_MAX, QUOTA_WINDOW_MS });
