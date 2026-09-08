'use strict';

// Own-action read service only. Never invokes request replay/processJob or
// transport, and never writes. Status is a snapshot, not proof of delivery.
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { monthKey } = require('./hr-hours-model');
const { notificationIntent } = require('./hr-notification-policy');
const PAGE_SIZE = 25, KEY = /^[a-f0-9]{64}$/;
const ACTION_STATES = ['discovering', 'queued', 'processing', 'deferred', 'confirmation_required', 'completed', 'expired', 'expired_partial', 'cancelled'];
const INTENT_STATES = ['queued', 'suppressed', 'blocked', 'deferred', 'attempting', 'no_device', 'cancelled', 'accepted', 'failed', 'partial', 'outcome_unknown'];
const REASONS = new Set(['manual-quiet-hours-warning', 'job-expired', 'actor-no-longer-authorized', 'routine', 'system-silent',
  'manual-quiet-hours-confirmed', 'invalid-path', 'identity-unavailable', 'identity-missing', 'auth-unavailable', 'invalid-actor',
  'actor-revoked', 'actor-profile-unavailable', 'recipient-moved', 'recipient-inactive', 'recipient-invalid', 'recipient-binding-changed',
  'report-invalid', 'report-completed', 'invalid-intent', 'parent-invalid', 'parent-cancelled', 'silent-state-unavailable',
  'tokens-invalid', 'expired', 'no-current-token', 'token-limit', 'unconfirmed-outcome', 'attempt-expired',
  'dispatch-window-closed', 'preflight-unavailable', 'page-check-unavailable']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const validTime = n => integer(n) && Number.isFinite(new Date(n).getTime());
const reason = value => value == null ? null : typeof value === 'string' && REASONS.has(value) ? value : 'unavailable';

function createHrHoursNudgeStatus({ db, auth, HttpsError, hooks = {} }) {
  if (!db || typeof auth?.getUser !== 'function' || typeof HttpsError !== 'function') throw new TypeError('db, auth and HttpsError required');
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  const badData = () => error('failed-precondition', 'Reminder status data is unavailable.');
  const root = sid => db.collection('stations').doc(sid);
  function request(req, keys) {
    const ctx = identity.context(req), data = req.data, authTime = req.auth.token.auth_time;
    if (!ctx.super && ctx.role !== 'hr_coordinator') throw error('permission-denied', 'HR authority required.');
    if (!integer(authTime) || !Number.isSafeInteger(authTime * 1000)) throw error('unauthenticated', 'Refresh your sign-in.');
    if (!plain(data) || Object.keys(data).some(k => !keys.includes(k))
      || (own(data, 'cursor') && (typeof data.cursor !== 'string' || !KEY.test(data.cursor)))) throw error('invalid-argument', 'Invalid request.');
    return { ctx, data, authTime };
  }
  async function live(tx, r) {
    let user;
    try { user = await auth.getUser(r.ctx.uid); }
    catch (e) {
      throw error(e?.code === 'auth/user-not-found' ? 'permission-denied' : 'unavailable', 'Current authentication is unavailable.');
    }
    const c = user?.customClaims, ctx = r.ctx;
    if (!user || user.uid !== ctx.uid || user.disabled !== false || !plain(c) || c.stationId !== ctx.sid
      || (c.super === true) !== ctx.super || (!ctx.super && c.role !== 'hr_coordinator')) throw error('permission-denied', 'Your active identity changed.');
    if (user.tokensValidAfterTime !== undefined) {
      const value = user.tokensValidAfterTime;
      const ms = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
      if (!Number.isFinite(ms)) throw error('unavailable', 'Authentication validity is unavailable.');
      if (r.authTime * 1000 < ms) throw error('permission-denied', 'Your sign-in was revoked.');
    }
    await identity.requireLive(tx, ctx);
    // Deliberately do NOT compare the action's original actor_auth_time: a
    // fresh authorized login may inspect old history, but cannot revive it.
  }
  function countMap(value, keys) {
    if (!plain(value) || keys.some(k => !integer(value[k]))) throw badData();
    return Object.fromEntries(keys.map(k => [k, value[k]]));
  }
  function time(value, nullable = false) {
    if (nullable && value == null) return null;
    if (!validTime(value)) throw badData();
    return value;
  }
  function action(snap, r, month) {
    if (!snap.exists) throw error('not-found', 'Reminder action was not found.');
    const a = snap.data(), ctx = r.ctx;
    // Even signed super only reads their own actions through this endpoint.
    if (!plain(a) || a.actor_uid !== ctx.uid || a.station_id !== ctx.sid) throw error('not-found', 'Reminder action was not found.');
    if (a.schema !== 'hr-nudge-action-v1' || a.action_id !== snap.id || !KEY.test(snap.id)
      || !ACTION_STATES.includes(a.status) || !['person', 'station'].includes(a.audience)
      || !['person', 'discovery', 'enqueue', 'complete'].includes(a.phase) || !integer(a.discovery_scanned)
      || (a.audience === 'person' ? !access.validUid(a.recipient_uid) : a.recipient_uid !== null)) throw badData();
    try { monthKey(a.month); } catch (_) { throw badData(); }
    if (month !== undefined && a.month !== month) throw badData();
    const dto = { action_id: a.action_id, station_id: ctx.sid, month: a.month, audience: a.audience,
      recipient_uid: a.audience === 'person' ? a.recipient_uid : null, status: a.status, reason: reason(a.reason),
      counts: countMap(a.counts, ['scanned', 'queued', 'suppressed', 'skipped', 'invalid']),
      phase: a.phase, discovery_scanned: a.discovery_scanned, created_at_ms: time(a.created_at_ms),
      updated_at_ms: time(a.updated_at_ms), expires_at_ms: time(a.expires_at_ms), not_before_ms: time(a.not_before_ms, true),
      status_scope: 'generation_only', delivery_status: 'intent_only',
      audience_semantics: a.audience === 'person' ? 'active_when_requested' : 'active_when_enqueue_page_scanned_with_completed_discovery_uid_upper_bound' };
    return { value: a, dto };
  }
  function child(snap, a) {
    const v = snap.data();
    if (!plain(v) || v.id !== snap.id || !KEY.test(snap.id) || v.station_id !== a.station_id || v.actor_uid !== a.actor_uid
      || v.action_id !== a.action_id || v.event_id !== a.action_id || v.month !== a.month || v.expires_at_ms !== a.expires_at_ms
      || !access.validUid(v.recipient_uid) || (a.audience === 'person' && v.recipient_uid !== a.recipient_uid)
      || !['report_submit', 'report_confirm'].includes(v.type) || v.transport_type !== 'report_mine'
      || !INTENT_STATES.includes(v.status) || (v.dispatch_type != null && !['report_submit', 'report_confirm'].includes(v.dispatch_type))) throw badData();
    const expected = notificationIntent({ station_id: a.station_id, recipient_uid: v.recipient_uid, type: v.type, event_id: a.action_id });
    if (expected.id !== snap.id) throw badData();
    if (v.terminal !== undefined && typeof v.terminal !== 'boolean') throw badData();
    if (v.delivery_status !== undefined && !['intent_only', 'provider_outcome_only'].includes(v.delivery_status)) throw badData();
    return { id: snap.id, recipient_uid: v.recipient_uid, type: v.type, dispatch_type: v.dispatch_type || null,
      status: v.status, reason: reason(v.reason), terminal: v.terminal === true,
      created_at_ms: time(v.created_at_ms), expires_at_ms: time(v.expires_at_ms), updated_at_ms: time(v.updated_at_ms, true),
      finished_at_ms: time(v.finished_at_ms, true), not_before_ms: time(v.not_before_ms, true), next_check_ms: time(v.next_check_ms, true),
      outcome_counts: v.outcome_counts == null ? null : countMap(v.outcome_counts, ['accepted', 'failed', 'outcome_unknown']),
      delivery_status: v.delivery_status || 'intent_only' };
  }
  async function finalize(r, refs, month) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize();
    await db.runTransaction(async tx => {
      await live(tx, r);
      const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
      snaps.forEach(snap => action(snap, r, month));
    });
  }
  async function list(req) {
    const r = request(req, ['month', 'cursor']);
    try { monthKey(r.data.month); } catch (_) { throw error('invalid-argument', 'Invalid month.'); }
    let refs = [];
    const result = await db.runTransaction(async tx => {
      await live(tx, r);
      let q = root(r.ctx.sid).collection('hr_nudge_actions').where('actor_uid', '==', r.ctx.uid)
        .where('month', '==', r.data.month).orderBy('__name__').limit(PAGE_SIZE + 1);
      if (r.data.cursor) q = q.startAfter(r.data.cursor);
      const page = await tx.get(q), docs = page.docs.slice(0, PAGE_SIZE);
      refs = docs.map(s => s.ref);
      return { month: r.data.month, items: docs.map(s => action(s, r, r.data.month).dto),
        next_cursor: page.size > PAGE_SIZE ? docs[docs.length - 1].id : null };
    });
    await finalize(r, refs, r.data.month); return result;
  }
  async function get(req) {
    const r = request(req, ['action_id', 'cursor']);
    if (typeof r.data.action_id !== 'string' || !KEY.test(r.data.action_id)) throw error('invalid-argument', 'Invalid action identity.');
    const ref = root(r.ctx.sid).collection('hr_nudge_actions').doc(r.data.action_id);
    const result = await db.runTransaction(async tx => {
      await live(tx, r);
      const a = action(await tx.get(ref), r);
      let q = root(r.ctx.sid).collection('hr_nudge_intents').where('action_id', '==', ref.id).orderBy('__name__').limit(PAGE_SIZE + 1);
      if (r.data.cursor) q = q.startAfter(r.data.cursor);
      const page = await tx.get(q), docs = page.docs.slice(0, PAGE_SIZE);
      return { action: a.dto, items: docs.map(s => child(s, a.value)),
        next_cursor: page.size > PAGE_SIZE ? docs[docs.length - 1].id : null,
        outcomes_scope: 'this_page_only' };
    });
    await finalize(r, [ref]); return result;
  }
  return Object.freeze({ list, get });
}
module.exports = Object.freeze({ createHrHoursNudgeStatus, PAGE_SIZE });
