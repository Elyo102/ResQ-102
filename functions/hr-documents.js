'use strict';

// Private text publications and revision-specific receipts. No SDK setup,
// callable exports, files, mail, fanout worker or delivery claim.
const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity, MEMBER_ROLES } = require('./ops-member-identity');
const { decideNotification } = require('./hr-notification-policy');
const PAGE_SIZE = 25, QUOTA_MAX = 10, QUOTA_WINDOW_MS = 60000, CONSENT_MS = 3600000;
const KEY = /^[a-f0-9]{64}$/, REQUEST_ID = /^[A-Za-z0-9_-]{8,120}$/;
const KINDS = Object.freeze(['document', 'procedure']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validRevision = v => Number.isSafeInteger(v) && v > 0;

function createHrDocuments({ db, auth, HttpsError, clock = Date.now, hooks = {} }) {
  if (!db || !auth || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function') throw new TypeError('db, auth and HttpsError required');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  const root = sid => db.collection('stations').doc(sid);
  const documentRef = (sid, id) => root(sid).collection('hr_documents').doc(id);
  const revisionRef = (ref, revision) => ref.collection('revisions').doc(String(revision));
  const manager = ctx => ctx.super || ctx.role === 'hr_coordinator';
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) throw error('internal', 'Invalid clock.');
    return value;
  }
  function text(value, max) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw error('invalid-argument', 'Invalid plain text.');
    const result = value.replace(/\r\n?/g, '\n').trim();
    if (!result) throw error('invalid-argument', 'Text is required.');
    return result;
  }
  function request(req, keys) {
    const ctx = identity.context(req), data = req.data, authTime = req.auth.token.auth_time;
    if (!plain(data) || Object.keys(data).some(k => !keys.includes(k))) throw error('invalid-argument', 'Invalid request fields.');
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) throw error('unauthenticated', 'Refresh your sign-in.');
    return { ctx, data, authTime };
  }
  async function currentAuth(uid) {
    let record;
    try { record = await auth.getUser(uid); }
    catch (e) {
      if (e && e.code === 'auth/user-not-found') throw error('permission-denied', 'Current account is unavailable.');
      throw error('unavailable', 'Current authentication could not be verified.');
    }
    if (!record || record.uid !== uid || record.disabled === true || !plain(record.customClaims)) throw error('permission-denied', 'Current account is unavailable.');
    return record;
  }
  async function live(tx, r) {
    const record = await currentAuth(r.ctx.uid), claims = record.customClaims, ctx = r.ctx;
    if (claims.stationId !== ctx.sid || (claims.super === true) !== ctx.super || (!ctx.super && claims.role !== ctx.role)) throw error('permission-denied', 'Your role or station changed. Refresh your sign-in.');
    if (record.tokensValidAfterTime !== undefined) {
      const validAfter = typeof record.tokensValidAfterTime === 'string' ? Date.parse(record.tokensValidAfterTime) : NaN;
      if (!Number.isFinite(validAfter)) throw error('unavailable', 'Authentication validity is unavailable.');
      if (r.authTime * 1000 < validAfter) throw error('permission-denied', 'Your sign-in was revoked.');
    }
    await identity.requireLive(tx, ctx);
    return record;
  }
  // Management authority never manufactures a recipient. Even a signed super
  // needs an actual active station-member profile to be in this audience.
  async function recipient(tx, sid, uid) {
    const record = await currentAuth(uid), claims = record.customClaims;
    const snap = await tx.get(root(sid).collection('users').doc(uid)), p = snap.exists ? snap.data() : null;
    if (claims.stationId !== sid || !access.activeMember(p, sid) || !MEMBER_ROLES.includes(p.role)
      || (claims.super !== true && claims.role !== p.role)) throw error('permission-denied', 'The recipient is not a current local member.');
    return uid;
  }
  function metadata(snap, ctx) {
    if (!snap.exists) throw error('not-found', 'Publication not found.');
    const d = snap.data();
    if (!plain(d) || d.schema !== 'hr-document-v1' || d.station_id !== ctx.sid || d.document_id !== snap.id
      || !KINDS.includes(d.kind) || !validRevision(d.current_revision) || typeof d.title !== 'string'
      || (d.kind === 'document' ? !access.validUid(d.target_uid) : own(d, 'target_uid'))) throw error('failed-precondition', 'Publication data is invalid.');
    if (!manager(ctx) && d.kind === 'document' && d.target_uid !== ctx.uid) throw error('permission-denied', 'This document is private.');
    return d;
  }
  function version(snap, d, number) {
    const v = snap.exists ? snap.data() : null;
    if (!plain(v) || v.schema !== 'hr-document-revision-v1' || v.station_id !== d.station_id || v.document_id !== d.document_id
      || v.revision !== number || !validRevision(number) || number > d.current_revision || typeof v.title !== 'string'
      || v.title.length > 80 || typeof v.text !== 'string' || v.text.length > 20000 || typeof v.requires_ack !== 'boolean') throw error('failed-precondition', 'Publication revision is unavailable.');
    return v;
  }
  function receiptValue(snap, d, number, uid) {
    if (!snap.exists) return null;
    const v = snap.data();
    const validTime = n => n === null || (Number.isSafeInteger(n) && n >= 0);
    if (!plain(v) || v.schema !== 'hr-document-recipient-v1' || v.station_id !== d.station_id
      || v.document_id !== d.document_id || v.revision !== number || v.recipient_uid !== uid
      || !validTime(v.opened_at_ms) || !validTime(v.acknowledged_at_ms)
      || (v.acknowledged_at_ms !== null && (v.opened_at_ms === null || v.acknowledged_at_ms < v.opened_at_ms))) throw error('failed-precondition', 'Recipient receipt is invalid.');
    return v;
  }
  const summary = d => ({ document_id: d.document_id, kind: d.kind, title: d.title,
    ...(d.kind === 'document' ? { target_uid: d.target_uid } : {}), current_revision: d.current_revision,
    created_at_ms: d.created_at_ms, updated_at_ms: d.updated_at_ms });
  const receiptDto = r => r ? { recipient_uid: r.recipient_uid, revision: r.revision,
    opened_at_ms: r.opened_at_ms, acknowledged_at_ms: r.acknowledged_at_ms } : null;
  async function beforeWrites(stage) { if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ stage }); }
  function publicationInput(data, p) {
    p.title = text(data.title, 80); p.text = text(data.text, 20000);
    if (typeof data.requires_ack !== 'boolean' || typeof data.send_now !== 'boolean') throw error('invalid-argument', 'Invalid acknowledgement or notification choice.');
    p.requires_ack = data.requires_ack; p.send_now = data.send_now;
  }
  function mutation(req, op) {
    const keys = op === 'publish' ? ['request_id', 'kind', 'target_uid', 'title', 'text', 'requires_ack', 'send_now']
      : op === 'revise' ? ['request_id', 'document_id', 'expected_revision', 'title', 'text', 'requires_ack', 'send_now']
        : ['request_id', 'document_id', 'revision', ...(op === 'nudge' ? ['target_uid', 'send_now'] : [])];
    const r = request(req, keys), data = r.data, p = { op, request_id: data.request_id };
    if (typeof data.request_id !== 'string' || !REQUEST_ID.test(data.request_id)) throw error('invalid-argument', 'Invalid request identity.');
    if (['publish', 'revise', 'nudge'].includes(op) && !manager(r.ctx)) throw error('permission-denied', 'HR authority required.');
    if (op === 'publish') {
      if (!KINDS.includes(data.kind) || (data.kind === 'document' ? !access.validUid(data.target_uid) : own(data, 'target_uid'))) throw error('invalid-argument', 'Invalid publication audience.');
      p.kind = data.kind; if (data.kind === 'document') p.target_uid = data.target_uid;
      publicationInput(data, p);
    } else {
      if (typeof data.document_id !== 'string' || !KEY.test(data.document_id)) throw error('invalid-argument', 'Invalid document identity.');
      p.document_id = data.document_id;
      const key = op === 'revise' ? 'expected_revision' : 'revision';
      if (!validRevision(data[key])) throw error('invalid-argument', 'Invalid revision.');
      p[key] = data[key];
      if (op === 'revise') publicationInput(data, p);
      if (op === 'nudge') {
        if (!access.validUid(data.target_uid) || typeof data.send_now !== 'boolean') throw error('invalid-argument', 'Invalid reminder recipient.');
        p.target_uid = data.target_uid; p.send_now = data.send_now;
      }
    }
    return { ...r, plan: p };
  }
  async function mutate(req, op) {
    const r = mutation(req, op), { ctx, plan: p } = r;
    const opId = hash(['hr-document-operation-v1', ctx.uid, p.request_id]);
    const fingerprint = hash(['hr-document-payload-v1', ctx.sid, ctx.uid, p]);
    const ref = documentRef(ctx.sid, op === 'publish' ? hash(['hr-document-v1', ctx.uid, p.request_id]) : p.document_id);
    const operationRef = root(ctx.sid).collection('hr_document_operations').doc(opId);
    const quotaRef = db.collection('hr_document_actor_quotas').doc(hash(['hr-document-quota-v1', ctx.uid]));
    return db.runTransaction(async tx => {
      await live(tx, r);
      const [prior, parent] = await Promise.all([tx.get(operationRef), tx.get(ref)]);
      let d = parent.exists ? metadata(parent, ctx) : null;
      if (prior.exists && !d) throw error('failed-precondition', 'Recorded publication is missing.');
      if (op !== 'publish' && !d) throw error('not-found', 'Publication not found.');
      const recipientAction = op === 'markOpened' || op === 'acknowledge';
      if (recipientAction) {
        if (d.kind === 'document' && d.target_uid !== ctx.uid) throw error('permission-denied', 'Only the target can record this receipt.');
        await recipient(tx, ctx.sid, ctx.uid);
      }
      if (prior.exists) {
        const old = prior.data();
        if (old.fingerprint !== fingerprint || old.actor_uid !== ctx.uid || old.document_id !== ref.id) throw error('already-exists', 'Request identity already used for another action.');
        await beforeWrites('replay'); await live(tx, r);
        if (recipientAction) await recipient(tx, ctx.sid, ctx.uid);
        return { ...old.result, current_revision: d.current_revision, duplicate: true };
      }
      if (op === 'publish' && d) throw error('already-exists', 'Publication already exists.');
      if (op === 'revise' && d.current_revision !== p.expected_revision) throw error('aborted', 'Publication changed. Review the current revision.');
      if ((op === 'acknowledge' || op === 'nudge') && d.current_revision !== p.revision) throw error('aborted', 'Only the current revision can be acknowledged or reminded.');
      let v = null, receipt = null, targetUid = null, targetReceiptRef = null;
      if (d) {
        const number = op === 'revise' ? d.current_revision : p.revision;
        v = version(await tx.get(revisionRef(ref, number)), d, number);
      }
      if (op === 'publish' && p.kind === 'document') targetUid = p.target_uid;
      if (op === 'revise' && d.kind === 'document') targetUid = d.target_uid;
      if (op === 'nudge') {
        if (p.target_uid === ctx.uid || (d.kind === 'document' && p.target_uid !== d.target_uid)) throw error('failed-precondition', 'No eligible other recipient.');
        targetUid = p.target_uid;
      }
      if (targetUid) await recipient(tx, ctx.sid, targetUid);
      if (recipientAction || op === 'nudge') {
        const uid = recipientAction ? ctx.uid : targetUid;
        targetReceiptRef = revisionRef(ref, p.revision).collection('receipts').doc(uid);
        receipt = receiptValue(await tx.get(targetReceiptRef), d, p.revision, uid);
      }
      if (op === 'acknowledge' && (!v.requires_ack || receipt?.opened_at_ms == null)) throw error('failed-precondition', 'This revision must require acknowledgment and be opened first.');
      if (op === 'nudge' && (v.requires_ack ? receipt?.acknowledged_at_ms != null : receipt?.opened_at_ms != null)) throw error('failed-precondition', 'The recipient has no outstanding action.');
      const quota = await tx.get(quotaRef);
      let runtime = null;
      if (op === 'nudge') {
        const snap = await tx.get(db.doc('config/runtime')); runtime = snap.exists ? snap.data() : null;
        if (!plain(runtime) || typeof runtime.silent !== 'boolean') throw error('failed-precondition', 'Notification configuration is unavailable.');
      }
      await beforeWrites(op); await live(tx, r);
      if (recipientAction) await recipient(tx, ctx.sid, ctx.uid);
      if (targetUid) await recipient(tx, ctx.sid, targetUid);
      const at = now(), oldQuota = quota.exists ? quota.data().requests_at_ms : [];
      if (!Array.isArray(oldQuota) || oldQuota.some(t => !Number.isSafeInteger(t) || t < 0 || t > at)) throw error('failed-precondition', 'Quota data is invalid.');
      const recent = oldQuota.filter(t => t > at - QUOTA_WINDOW_MS);
      if (recent.length >= QUOTA_MAX) throw error('resource-exhausted', 'Too many new actions. Try again shortly.');
      const number = op === 'publish' ? 1 : op === 'revise' ? d.current_revision + 1 : p.revision;
      if (!validRevision(number)) throw error('failed-precondition', 'Revision overflow.');
      const eventId = hash(['hr-document-event-v1', opId]);
      let result = { document_id: ref.id, revision: number, current_revision: op === 'publish' || op === 'revise' ? number : d.current_revision,
        outcome: 'saved', notification_status: 'not_queued' };
      const policy = runtime ? decideNotification({ now_ms: at, mode: 'manual', silent: runtime.silent ? 'on' : 'off', send_now: p.send_now }) : null;
      if (op === 'publish' || op === 'revise') {
        const next = d ? { ...d, title: p.title, current_revision: number, updated_at_ms: at } : {
          schema: 'hr-document-v1', document_id: ref.id, station_id: ctx.sid, kind: p.kind,
          ...(p.kind === 'document' ? { target_uid: p.target_uid } : {}), title: p.title,
          current_revision: number, author_uid: ctx.uid, created_at_ms: at, updated_at_ms: at
        };
        tx.create(revisionRef(ref, number), { schema: 'hr-document-revision-v1', document_id: ref.id,
          station_id: ctx.sid, revision: number, title: p.title, text: p.text,
          requires_ack: p.requires_ack, author_uid: ctx.uid, created_at_ms: at });
        tx.set(ref, next); d = next;
      }
      if (recipientAction) {
        const next = receipt || { schema: 'hr-document-recipient-v1', document_id: ref.id, station_id: ctx.sid,
          revision: number, recipient_uid: ctx.uid, opened_at_ms: null, acknowledged_at_ms: null };
        const field = op === 'markOpened' ? 'opened_at_ms' : 'acknowledged_at_ms';
        if (next[field] !== null) result.outcome = 'no_change';
        else { next[field] = at; tx.set(targetReceiptRef, next); }
        result.receipt = receiptDto(next);
      }
      if (op === 'nudge' && policy.decision === 'confirmation_required') {
        result.outcome = 'confirmation_required'; result.not_before_ms = policy.not_before_ms;
      } else if (!recipientAction) {
        const personal = op === 'nudge' || d.kind === 'document';
        const uid = op === 'nudge' ? targetUid : personal ? d.target_uid : null;
        if (personal && uid === ctx.uid) result.notification_status = 'no_other_recipient';
        else {
          result.notification_status = policy?.decision === 'suppressed' ? 'suppressed' : 'policy_pending';
          tx.create(root(ctx.sid).collection('hr_document_notification_jobs').doc(eventId), {
            schema: 'hr-document-notification-v1', event_id: eventId, document_id: ref.id, station_id: ctx.sid,
            revision: number, actor_uid: ctx.uid, actor_auth_time: r.authTime,
            audience: personal ? 'person' : 'station_members', ...(personal ? { recipient_uid: uid } : {}),
            type: op === 'nudge' ? 'hr_nudge' : personal ? 'hr_document' : 'hr_procedure',
            status: result.notification_status, delivery_status: 'intent_only', created_at_ms: at,
            send_now: p.send_now, consent_expires_at_ms: p.send_now ? at + CONSENT_MS : 0,
            routine_after_quiet: op !== 'nudge', exclude_actor: true
          });
        }
      }
      // Each new operation receipt is a write, including an explicit no-change
      // or night-confirmation response. Only exact authorized replays are free.
      tx.set(quotaRef, { requests_at_ms: recent.concat(at) });
      tx.create(operationRef, { schema: 'hr-document-operation-v1', document_id: ref.id, actor_uid: ctx.uid,
        fingerprint, result, created_at_ms: at });
      return { ...result, duplicate: false };
    });
  }
  async function finalRead(r, ref) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize();
    await db.runTransaction(async tx => { await live(tx, r); if (ref) metadata(await tx.get(ref), r.ctx); });
  }
  async function list(req, mode) {
    const r = request(req, mode === 'managed' ? ['kind', 'cursor'] : ['cursor']);
    if (mode === 'managed' && !manager(r.ctx)) throw error('permission-denied', 'HR authority required.');
    if (mode === 'managed' && !KINDS.includes(r.data.kind)) throw error('invalid-argument', 'Invalid publication kind.');
    if (own(r.data, 'cursor') && (typeof r.data.cursor !== 'string' || !KEY.test(r.data.cursor))) throw error('invalid-argument', 'Invalid cursor.');
    const result = await db.runTransaction(async tx => {
      await live(tx, r);
      let q = root(r.ctx.sid).collection('hr_documents');
      q = mode === 'mine' ? q.where('target_uid', '==', r.ctx.uid) : q.where('kind', '==', mode === 'procedures' ? 'procedure' : r.data.kind);
      q = q.orderBy('__name__').limit(PAGE_SIZE + 1);
      if (r.data.cursor) q = q.startAfter(r.data.cursor);
      const page = await tx.get(q), docs = page.docs.slice(0, PAGE_SIZE);
      return { items: docs.map(s => summary(metadata(s, r.ctx))), next_cursor: page.size > PAGE_SIZE ? docs[docs.length - 1].id : null };
    });
    await finalRead(r); return result;
  }
  function readInput(req, receipts = false) {
    const r = request(req, receipts ? ['document_id', 'revision', 'cursor'] : ['document_id', 'revision']);
    if (typeof r.data.document_id !== 'string' || !KEY.test(r.data.document_id)
      || ((receipts || own(r.data, 'revision')) && !validRevision(r.data.revision))
      || (receipts && own(r.data, 'cursor') && !access.validUid(r.data.cursor))) throw error('invalid-argument', 'Invalid publication revision or cursor.');
    return r;
  }
  async function get(req) {
    const r = readInput(req), ref = documentRef(r.ctx.sid, r.data.document_id);
    const result = await db.runTransaction(async tx => {
      await live(tx, r);
      const d = metadata(await tx.get(ref), r.ctx), number = r.data.revision || d.current_revision;
      const v = version(await tx.get(revisionRef(ref, number)), d, number);
      let eligible = d.kind === 'procedure' || d.target_uid === r.ctx.uid;
      if (eligible && r.ctx.super) {
        const snap = await tx.get(root(r.ctx.sid).collection('users').doc(r.ctx.uid)), p = snap.exists ? snap.data() : null;
        eligible = access.activeMember(p, r.ctx.sid) && MEMBER_ROLES.includes(p.role);
      }
      const receipt = eligible ? receiptValue(await tx.get(revisionRef(ref, number).collection('receipts').doc(r.ctx.uid)), d, number, r.ctx.uid) : null;
      return { ...summary(d), revision: number, title: v.title, text: v.text, requires_ack: v.requires_ack,
        is_current: number === d.current_revision, recipient_eligible: eligible, receipt: receiptDto(receipt) };
    });
    await finalRead(r, ref); return result;
  }
  async function listReceipts(req) {
    const r = readInput(req, true), ref = documentRef(r.ctx.sid, r.data.document_id);
    if (!manager(r.ctx)) throw error('permission-denied', 'HR authority required.');
    const result = await db.runTransaction(async tx => {
      await live(tx, r);
      const d = metadata(await tx.get(ref), r.ctx), number = r.data.revision;
      version(await tx.get(revisionRef(ref, number)), d, number);
      let q = revisionRef(ref, number).collection('receipts').orderBy('__name__').limit(PAGE_SIZE + 1);
      if (r.data.cursor) q = q.startAfter(r.data.cursor);
      const page = await tx.get(q), docs = page.docs.slice(0, PAGE_SIZE);
      const items = docs.map(s => {
        if (!access.validUid(s.id) || (d.kind === 'document' && s.id !== d.target_uid)) throw error('failed-precondition', 'Recipient identity is invalid.');
        return receiptDto(receiptValue(s, d, number, s.id));
      });
      return { document_id: d.document_id, revision: number, current_revision: d.current_revision,
        items, next_cursor: page.size > PAGE_SIZE ? docs[docs.length - 1].id : null };
    });
    await finalRead(r, ref); return result;
  }
  return Object.freeze({ publish: req => mutate(req, 'publish'), revise: req => mutate(req, 'revise'),
    markOpened: req => mutate(req, 'markOpened'), acknowledge: req => mutate(req, 'acknowledge'), nudge: req => mutate(req, 'nudge'),
    listMine: req => list(req, 'mine'), listProcedures: req => list(req, 'procedures'), listManaged: req => list(req, 'managed'), get, listReceipts });
}
module.exports = Object.freeze({ createHrDocuments, PAGE_SIZE, QUOTA_MAX, QUOTA_WINDOW_MS, KINDS });
