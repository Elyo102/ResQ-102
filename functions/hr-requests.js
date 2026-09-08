'use strict';

// Private, unexported text-domain service. No transport, retention, Storage or
// SDK initialization. Notification jobs are work, never delivery receipts.
const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { decideNotification } = require('./hr-notification-policy');
const PAGE_SIZE = 25, QUOTA_MAX = 10, QUOTA_WINDOW_MS = 60000, CONSENT_MS = 3600000;
const STATES = Object.freeze(['open', 'in_progress', 'waiting_employee', 'closed']);
const REQUEST_ID = /^[A-Za-z0-9_-]{8,120}$/, KEY = /^[a-f0-9]{64}$/;
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);

function createHrRequests({ db, auth, HttpsError, clock = Date.now, hooks = {} }) {
  if (!db || !auth || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function') throw new TypeError('db, auth and HttpsError required');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  const root = sid => db.collection('stations').doc(sid);
  const caseRef = (sid, id) => root(sid).collection('hr_requests').doc(id);
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw error('internal', 'Invalid clock.');
    return value;
  }
  function text(value, max) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw error('invalid-argument', 'Invalid plain text.');
    const result = value.replace(/\r\n?/g, '\n').trim();
    if (!result) throw error('invalid-argument', 'Text is required.');
    return result; // Literal URLs remain text, never interpreted as links/files.
  }
  function request(req, keys) {
    const ctx = identity.context(req), data = req.data;
    if (!plain(data) || Object.keys(data).some(k => !keys.includes(k))) throw error('invalid-argument', 'Invalid request fields.');
    const authTime = req.auth.token.auth_time;
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) throw error('unauthenticated', 'Refresh your sign-in.');
    return { ctx, data, authTime };
  }
  async function live(tx, requestContext) {
    const { ctx, authTime } = requestContext;
    let record;
    try { record = await auth.getUser(ctx.uid); }
    catch (e) {
      if (e && e.code === 'auth/user-not-found') throw error('permission-denied', 'The current account is unavailable.');
      throw error('unavailable', 'Current authentication could not be verified.');
    }
    const claims = record && record.customClaims;
    if (!record || record.uid !== ctx.uid || record.disabled === true || !plain(claims)
      || claims.stationId !== ctx.sid || (claims.super === true) !== ctx.super
      || (!ctx.super && claims.role !== ctx.role)) throw error('permission-denied', 'Your role or station changed. Refresh your sign-in.');
    if (record.tokensValidAfterTime !== undefined) {
      const validAfter = typeof record.tokensValidAfterTime === 'string' ? Date.parse(record.tokensValidAfterTime) : NaN;
      if (!Number.isFinite(validAfter)) throw error('unavailable', 'Authentication validity is unavailable.');
      if (authTime * 1000 < validAfter) throw error('permission-denied', 'Your sign-in was revoked.');
    }
    return identity.requireLive(tx, ctx);
  }
  const manager = ctx => ctx.super || ctx.role === 'hr_coordinator';
  function caseData(snap, ctx) {
    if (!snap.exists) throw error('not-found', 'Request not found.');
    const value = snap.data();
    if (!plain(value) || value.schema !== 'hr-request-v1' || value.station_id !== ctx.sid
      || value.case_id !== snap.id || !access.validUid(value.owner_uid) || !STATES.includes(value.status)
      || !Number.isSafeInteger(value.revision) || value.revision < 1) throw error('failed-precondition', 'Request data is invalid.');
    if (value.owner_uid !== ctx.uid && !manager(ctx)) throw error('permission-denied', 'This request is private.');
    return value;
  }
  const summary = c => ({ case_id: c.case_id, owner_uid: c.owner_uid, subject: c.subject,
    status: c.status, revision: c.revision, created_at_ms: c.created_at_ms, updated_at_ms: c.updated_at_ms });
  async function beforeWrites(stage) { if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ stage }); }
  async function runtime(tx) {
    const snap = await tx.get(db.doc('config/runtime')), value = snap.exists ? snap.data() : null;
    if (!plain(value) || typeof value.silent !== 'boolean') throw error('failed-precondition', 'Notification configuration is unavailable.');
    return value;
  }
  function mutationInput(req, op) {
    const keys = op === 'create' ? ['request_id', 'subject', 'text', 'send_now']
      : ['request_id', 'case_id', 'expected_revision', 'send_now', ...(op === 'reply' ? ['text'] : op === 'setStatus' ? ['status'] : [])];
    const r = request(req, keys), d = r.data;
    if (typeof d.request_id !== 'string' || !REQUEST_ID.test(d.request_id) || typeof d.send_now !== 'boolean') throw error('invalid-argument', 'Invalid action identity or notification choice.');
    const p = { op, request_id: d.request_id, send_now: d.send_now };
    if (op === 'create') p.subject = text(d.subject, 80);
    else {
      if (typeof d.case_id !== 'string' || !KEY.test(d.case_id) || !Number.isSafeInteger(d.expected_revision) || d.expected_revision < 1) throw error('invalid-argument', 'Invalid request revision.');
      p.case_id = d.case_id; p.expected_revision = d.expected_revision;
    }
    if (op === 'create' || op === 'reply') p.text = text(d.text, 1000);
    if (op === 'setStatus') {
      if (!STATES.includes(d.status)) throw error('invalid-argument', 'Invalid status.');
      p.status = d.status;
    }
    return { ...r, plan: p };
  }
  async function mutate(req, op) {
    const r = mutationInput(req, op), { ctx, plan: p } = r;
    if (op === 'setStatus' && !manager(ctx)) throw error('permission-denied', 'HR authority required.');
    const operationId = hash(['hr-request-operation-v1', ctx.uid, p.request_id]);
    const fingerprint = hash(['hr-request-payload-v1', ctx.sid, ctx.uid, p]);
    const ref = caseRef(ctx.sid, op === 'create' ? hash(['hr-request-v1', ctx.uid, p.request_id]) : p.case_id);
    const receiptRef = root(ctx.sid).collection('hr_request_operations').doc(operationId);
    const quotaRef = db.collection('hr_request_actor_quotas').doc(hash(['hr-request-quota-v1', ctx.uid]));
    return db.runTransaction(async tx => {
      await live(tx, r);
      const [receipt, snap] = await Promise.all([tx.get(receiptRef), tx.get(ref)]);
      let current = snap.exists ? caseData(snap, ctx) : null;
      if (op !== 'create' && !current) throw error('not-found', 'Request not found.');
      if (receipt.exists) {
        if (!current) throw error('failed-precondition', 'The recorded request is missing.');
        const prior = receipt.data();
        if (prior.fingerprint !== fingerprint || prior.case_id !== ref.id || prior.actor_uid !== ctx.uid) throw error('already-exists', 'Request ID already used for another action.');
        await beforeWrites('replay'); await live(tx, r);
        return { ...prior.result, duplicate: true };
      }
      if (op === 'create' && current) throw error('already-exists', 'Request already exists.');
      if (current && current.revision !== p.expected_revision) throw error('aborted', 'The request changed. Refresh before saving.');
      const ownerSide = op === 'create' || current.owner_uid === ctx.uid;
      if (op === 'reply' && current.status === 'closed') throw error('failed-precondition', 'The request is closed.');
      if (op === 'nudge' && !(ownerSide ? ['open', 'in_progress'].includes(current.status) : current.status === 'waiting_employee')) throw error('failed-precondition', 'No outstanding action for the other side.');
      const quota = await tx.get(quotaRef);
      // Business text/status survives quiet/silent and receives durable pending
      // notification work. Standalone nudges need immediate policy evaluation.
      const rt = op === 'nudge' ? await runtime(tx) : null;
      await beforeWrites(op); await live(tx, r);
      const at = now(), old = quota.exists ? quota.data().requests_at_ms : [];
      if (!Array.isArray(old) || old.some(v => !Number.isSafeInteger(v) || v > at)) throw error('failed-precondition', 'Quota data is invalid.');
      const recent = old.filter(v => v > at - QUOTA_WINDOW_MS);
      const noChange = op === 'setStatus' && current.status === p.status;
      if (!noChange && recent.length >= QUOTA_MAX) throw error('resource-exhausted', 'Too many new actions. Try again shortly.');
      let nudgePolicy = null;
      if (rt) nudgePolicy = decideNotification({ now_ms: at, mode: 'manual', silent: rt.silent ? 'on' : 'off', send_now: p.send_now });
      const confirmation = nudgePolicy && nudgePolicy.decision === 'confirmation_required';
      let result;
      if (noChange || confirmation) {
        result = { case_id: ref.id, revision: current.revision, status: current.status,
          outcome: noChange ? 'no_change' : 'confirmation_required', notification_status: 'not_queued' };
      } else {
        const revision = current ? current.revision + 1 : 1;
        if (!Number.isSafeInteger(revision)) throw error('failed-precondition', 'Revision overflow.');
        const status = op === 'create' ? 'open' : op === 'setStatus' ? p.status
          : op === 'reply' && ownerSide && current.status === 'waiting_employee' ? 'open' : current.status;
        const next = current ? { ...current, revision, status, updated_at_ms: at } : {
          schema: 'hr-request-v1', case_id: ref.id, station_id: ctx.sid, owner_uid: ctx.uid,
          subject: p.subject, status, revision, created_at_ms: at, updated_at_ms: at
        };
        const eventId = hash(['hr-request-event-v1', operationId]);
        const event = { schema: 'hr-request-event-v1', event_id: eventId, case_id: ref.id, station_id: ctx.sid,
          actor_uid: ctx.uid, kind: op, revision, created_at_ms: at,
          ...(own(p, 'text') ? { text: p.text } : {}),
          ...(op === 'setStatus' ? { from_status: current.status, to_status: status } : {}) };
        // Status changes by an HR owner should not send back to the actor.
        const ownerNotification = op === 'setStatus' || !ownerSide;
        const notifySelf = ownerNotification && next.owner_uid === ctx.uid;
        const notificationStatus = notifySelf ? 'no_other_recipient'
          : nudgePolicy && nudgePolicy.decision === 'suppressed' ? 'suppressed' : 'policy_pending';
        if (notificationStatus !== 'no_other_recipient') {
          const job = { schema: 'hr-request-notification-v1', event_id: eventId, case_id: ref.id,
            station_id: ctx.sid, actor_uid: ctx.uid, actor_auth_time: r.authTime,
            audience: ownerNotification ? 'person' : 'station_hr',
            ...(ownerNotification ? { recipient_uid: next.owner_uid } : {}),
            type: op === 'nudge' ? 'hr_nudge' : ownerNotification ? 'hr_reply' : 'hr_request',
            status: notificationStatus, delivery_status: 'intent_only', created_at_ms: at,
            send_now: p.send_now, consent_expires_at_ms: p.send_now ? at + CONSENT_MS : 0,
            routine_after_quiet: op !== 'nudge', exclude_actor: true };
          tx.create(root(ctx.sid).collection('hr_request_notification_jobs').doc(eventId), job);
        }
        tx.create(ref.collection('events').doc(eventId), event);
        tx.set(ref, next);
        result = { case_id: ref.id, revision, status, outcome: 'saved', event_id: eventId, notification_status: notificationStatus };
      }
      if (!noChange) tx.set(quotaRef, { requests_at_ms: recent.concat(at) });
      tx.create(receiptRef, { schema: 'hr-request-operation-v1', case_id: ref.id, actor_uid: ctx.uid,
        fingerprint, result, created_at_ms: at });
      return { ...result, duplicate: false };
    });
  }
  async function finalRead(r, ref) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize();
    await db.runTransaction(async tx => {
      await live(tx, r);
      if (ref) caseData(await tx.get(ref), r.ctx);
    });
  }
  // Internal transaction ports, never callable endpoints. The caller owns the
  // attachment reservation/byte quota and ready receipt in this SAME transaction.
  // A ready replay uses read(), not prepare(): closing a case blocks new uploads,
  // not an authorized read of already published evidence.
  const attachmentBrand = Symbol('request-attachment-plan');
  function attachmentIds(value) {
    const ids = value === undefined ? [] : value;
    if (!Array.isArray(ids) || ids.length > 10 || ids.some(id => typeof id !== 'string' || !KEY.test(id))
      || new Set(ids).size !== ids.length) throw error('failed-precondition', 'Attachment membership is invalid.');
    return ids.slice();
  }
  function attachmentInput(input) {
    if (!plain(input) || !plain(input.ctx) || input.parent_kind !== 'request'
      || typeof input.parent_id !== 'string' || !KEY.test(input.parent_id)
      || !Number.isSafeInteger(input.authTime) || input.authTime < 0
      || !Number.isSafeInteger(input.authTime * 1000)) throw error('invalid-argument', 'Invalid attachment parent context.');
    const ctx = identity.context({ auth: { uid: input.ctx.uid, token: {
      stationId: input.ctx.sid, role: input.ctx.role, super: input.ctx.super
    } } });
    if (own(input, 'attachment_id') && (typeof input.attachment_id !== 'string' || !KEY.test(input.attachment_id))) throw error('invalid-argument', 'Invalid attachment identity.');
    if (own(input, 'revision')) throw error('invalid-argument', 'Request attachments use current case membership.');
    return { ctx, authTime: input.authTime };
  }
  async function readAttachment(tx, input) {
    const r = attachmentInput(input);
    await live(tx, r);
    const d = caseData(await tx.get(caseRef(r.ctx.sid, input.parent_id)), r.ctx), ids = attachmentIds(d.attachment_ids);
    if (own(input, 'attachment_id') && !ids.includes(input.attachment_id)) throw error('permission-denied', 'Attachment is not part of this request.');
    return { parent_kind: 'request', parent_id: d.case_id, revision: d.revision, attachment_ids: ids };
  }
  async function prepareAttachment(tx, input) {
    const r = attachmentInput(input), { ctx } = r;
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1
      || typeof input.attachment_id !== 'string' || !KEY.test(input.attachment_id)
      || typeof input.event_id !== 'string' || !KEY.test(input.event_id)) throw error('invalid-argument', 'Invalid attachment publication.');
    const attachmentId = input.attachment_id, eventId = input.event_id, expected = input.expected_revision;
    const ref = caseRef(ctx.sid, input.parent_id);
    await live(tx, r);
    const d = caseData(await tx.get(ref), ctx), ids = attachmentIds(d.attachment_ids);
    if (d.status === 'closed') throw error('failed-precondition', 'The request is closed.');
    if (d.revision !== expected) throw error('aborted', 'The request changed. Refresh before saving.');
    if (ids.includes(attachmentId)) throw error('already-exists', 'Attachment is already published.');
    if (ids.length >= 10) throw error('resource-exhausted', 'Attachment capacity reached.');
    const revision = d.revision + 1;
    if (!Number.isSafeInteger(revision)) throw error('failed-precondition', 'Revision overflow.');
    let checked = false, committed = false;
    return Object.freeze({ [attachmentBrand]: true,
      async recheck(currentTx) {
        if (currentTx !== tx || committed) throw error('failed-precondition', 'Invalid attachment transaction.');
        checked = false;
        await beforeWrites('attachment'); await live(tx, r);
        const current = caseData(await tx.get(ref), ctx);
        if (current.owner_uid !== d.owner_uid || current.revision !== expected || current.status !== d.status
          || JSON.stringify(attachmentIds(current.attachment_ids)) !== JSON.stringify(ids)) throw error('aborted', 'The request changed.');
        checked = true;
      },
      commit(currentTx, options) {
        const at = options && options.at;
        if (currentTx !== tx || !checked || committed || !Number.isSafeInteger(at) || at < 0
          || !Number.isFinite(new Date(at).getTime())) throw error('failed-precondition', 'Attachment publication was not rechecked.');
        committed = true;
        const personal = d.owner_uid !== ctx.uid;
        const event = { schema: 'hr-request-event-v1', event_id: eventId, case_id: ref.id, station_id: ctx.sid,
          actor_uid: ctx.uid, kind: 'attachment', attachment_id: attachmentId, revision, created_at_ms: at };
        tx.create(ref.collection('events').doc(eventId), event);
        // Adding evidence does not imply the employee has completed an answer.
        tx.set(ref, { ...d, revision, updated_at_ms: at, attachment_ids: ids.concat(attachmentId) });
        tx.create(root(ctx.sid).collection('hr_request_notification_jobs').doc(eventId), {
          schema: 'hr-request-notification-v1', event_id: eventId, case_id: ref.id, station_id: ctx.sid,
          actor_uid: ctx.uid, actor_auth_time: r.authTime, audience: personal ? 'person' : 'station_hr',
          ...(personal ? { recipient_uid: d.owner_uid } : {}), type: personal ? 'hr_reply' : 'hr_request',
          status: 'policy_pending', delivery_status: 'intent_only', created_at_ms: at,
          send_now: false, consent_expires_at_ms: 0, routine_after_quiet: true, exclude_actor: true
        });
        return { linked: true, revision, event_id: eventId, notification_status: 'policy_pending' };
      }
    });
  }
  const attachmentPorts = Object.freeze({ read: readAttachment, prepare: prepareAttachment,
    recheck(tx, plan) { if (!plan || plan[attachmentBrand] !== true) throw error('failed-precondition', 'Invalid attachment plan.'); return plan.recheck(tx); },
    commit(tx, plan, options) { if (!plan || plan[attachmentBrand] !== true) throw error('failed-precondition', 'Invalid attachment plan.'); return plan.commit(tx, options); }
  });
  async function list(req, inbox = false) {
    const r = request(req, ['cursor']);
    if (inbox && !manager(r.ctx)) throw error('permission-denied', 'HR authority required.');
    if (own(r.data, 'cursor') && (typeof r.data.cursor !== 'string' || !KEY.test(r.data.cursor))) throw error('invalid-argument', 'Invalid cursor.');
    const result = await db.runTransaction(async tx => {
      await live(tx, r);
      let q = root(r.ctx.sid).collection('hr_requests');
      if (!inbox) q = q.where('owner_uid', '==', r.ctx.uid);
      q = q.orderBy('__name__').limit(PAGE_SIZE + 1);
      if (r.data.cursor) q = q.startAfter(r.data.cursor);
      const page = await tx.get(q), docs = page.docs.slice(0, PAGE_SIZE);
      return { items: docs.map(s => summary(caseData(s, r.ctx))), next_cursor: page.size > PAGE_SIZE ? docs[docs.length - 1].id : null };
    });
    await finalRead(r); return result;
  }
  async function get(req) {
    const r = request(req, ['case_id', 'cursor']);
    if (typeof r.data.case_id !== 'string' || !KEY.test(r.data.case_id)
      || (own(r.data, 'cursor') && (!Number.isSafeInteger(r.data.cursor) || r.data.cursor < 1))) throw error('invalid-argument', 'Invalid request cursor.');
    const ref = caseRef(r.ctx.sid, r.data.case_id);
    const result = await db.runTransaction(async tx => {
      await live(tx, r);
      const c = caseData(await tx.get(ref), r.ctx);
      let q = ref.collection('events').orderBy('revision').limit(PAGE_SIZE + 1);
      if (r.data.cursor) q = q.startAfter(r.data.cursor);
      const page = await tx.get(q), docs = page.docs.slice(0, PAGE_SIZE);
      const events = docs.map(s => {
        const e = s.data();
        if (e.schema !== 'hr-request-event-v1' || e.case_id !== c.case_id || e.station_id !== r.ctx.sid
          || !Number.isSafeInteger(e.revision) || e.revision < 1 || e.revision > c.revision
          || (e.kind === 'attachment' && (e.event_id !== s.id || !access.validUid(e.actor_uid)
            || typeof e.attachment_id !== 'string' || !KEY.test(e.attachment_id)
            || !attachmentIds(c.attachment_ids).includes(e.attachment_id)
            || own(e, 'text') || own(e, 'from_status') || own(e, 'to_status')))) throw error('failed-precondition', 'Invalid request history.');
        return { event_id: s.id, actor_uid: e.actor_uid, kind: e.kind, revision: e.revision,
          created_at_ms: e.created_at_ms, ...(own(e, 'text') ? { text: e.text } : {}),
          ...(e.kind === 'attachment' ? { attachment_id: e.attachment_id } : {}),
          ...(own(e, 'from_status') ? { from_status: e.from_status, to_status: e.to_status } : {}) };
      });
      return { ...summary(c), events, next_cursor: page.size > PAGE_SIZE ? events[events.length - 1].revision : null };
    });
    await finalRead(r, ref); return result;
  }
  return Object.freeze({ create: req => mutate(req, 'create'), reply: req => mutate(req, 'reply'),
    setStatus: req => mutate(req, 'setStatus'), nudge: req => mutate(req, 'nudge'),
    list: req => list(req), listInbox: req => list(req, true), get, attachmentPorts });
}
module.exports = Object.freeze({ createHrRequests, PAGE_SIZE, QUOTA_MAX, QUOTA_WINDOW_MS, STATES });
