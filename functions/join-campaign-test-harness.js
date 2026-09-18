'use strict';
/* תשתית בדיקה משותפת לקליטה בקישור קבוצתי: Firestore מזויף עם טרנזקציות
 * אופטימיות ומרוצים, מנוע הזמנות אמיתי, חוזה קליטה אמיתי. אינו נטען בייצור. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const contract = require('./join-campaign');
const onboardingContract = require('./invitation-onboarding-contract');
const invitationsModule = require('./invitations');
const qualifications = require('./schedule-qualifications');
const registrationSafety = require('./registration-safety');
const { createJoinCampaignService } = require('./join-campaign-service');
const { createDeviceReadinessService } = require('./device-readiness-service');

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const NOW = 1_800_000_000_000;

/* ---------- Firestore מזויף עם טרנזקציות אופטימיות ---------- */
function fakeDb() {
  const store = new Map();      // path -> value
  const versions = new Map();   // path -> n
  const hooks = { beforeCommit: null };
  const stats = { reads: 0, writes: 0, transactions: 0, retries: 0 };
  const bump = (p) => versions.set(p, (versions.get(p) || 0) + 1);
  const snapOf = (path) => { stats.reads += 1; const v = store.get(path); return { exists: v !== undefined, id: path.split('/').pop(), ref: docRef(path), data: () => (v === undefined ? undefined : clone(v)) }; };
  const clone = (v) => structuredClone(v);
  function docRef(path) { return { path, get: async () => snapOf(path), set: async (v, o) => apply(path, 'set', v, o), update: async (v) => apply(path, 'update', v) }; }
  function apply(path, kind, value, options) {
    if (kind === 'create') { if (store.has(path)) throw new Error('ALREADY_EXISTS ' + path); store.set(path, resolveFV(value, {})); }
    else if (kind === 'set') store.set(path, options && options.merge ? Object.assign({}, store.get(path) || {}, resolveFV(value, store.get(path) || {})) : resolveFV(value, {}));
    else if (kind === 'update') { if (!store.has(path)) throw new Error('NOT_FOUND ' + path); store.set(path, Object.assign({}, store.get(path), resolveFV(value, store.get(path)))); }
    else if (kind === 'delete') store.delete(path);
    stats.writes += 1; bump(path);
  }
  function resolveFV(value, prev) {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      out[k] = v && v.__inc !== undefined ? (Number(prev[k] || 0) + v.__inc) : v;
    }
    return out;
  }
  function query(collection) {
    const q = { _c: collection, _w: [], _o: null, _l: Infinity, _after: undefined };
    q.where = (f, op, v) => { q._w.push([f, op, v]); return q; };
    q.orderBy = (f, dir) => { q._o = [f, dir || 'asc']; return q; };
    q.limit = (n) => { q._l = n; return q; };
    q.startAfter = (v) => { q._after = v; return q; };
    q.get = async () => run();
    function run() {
      const prefix = collection + '/';
      let rows = [];
      for (const [p, v] of store) if (p.startsWith(prefix) && p.slice(prefix.length).indexOf('/') === -1) rows.push([p, v]);
      for (const [f, op, val] of q._w) rows = rows.filter(([, v]) => op === '==' ? v[f] === val : true);
      if (q._o) rows.sort((a, b) => (a[1][q._o[0]] > b[1][q._o[0]] ? 1 : -1) * (q._o[1] === 'desc' ? -1 : 1));
      if (q._after !== undefined && q._o) rows = rows.filter(([, v]) => q._o[1] === 'desc' ? v[q._o[0]] < q._after : v[q._o[0]] > q._after);
      rows = rows.slice(0, q._l);
      return { docs: rows.map(([p]) => snapOf(p)), size: rows.length, empty: rows.length === 0 };
    }
    q._isQuery = true;
    return q;
  }
  const db = {
    _store: store, _hooks: hooks, _stats: stats, _put(p, v) { store.set(p, v); bump(p); }, _get(p) { return store.get(p); },
    doc: docRef,
    collection: (path) => Object.assign(query(path), { doc: (id) => docRef(path + '/' + id) }),
    getAll: async (...refs) => refs.map((r) => snapOf(r.path)),
    async runTransaction(fn) {
      stats.transactions += 1;
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt) stats.retries += 1;
        const reads = new Map(); const staged = [];
        const tx = {
          async get(ref) {
            if (ref._isQuery) { const r = await ref.get(); r.docs.forEach((s) => reads.set(s.ref.path, versions.get(s.ref.path) || 0)); return r; }
            reads.set(ref.path, versions.get(ref.path) || 0); return snapOf(ref.path);
          },
          create: (ref, v) => staged.push([ref.path, 'create', v]),
          set: (ref, v, o) => staged.push([ref.path, 'set', v, o]),
          update: (ref, v) => staged.push([ref.path, 'update', v]),
          delete: (ref) => staged.push([ref.path, 'delete'])
        };
        const out = await fn(tx);
        if (hooks.beforeCommit) { const h = hooks.beforeCommit; hooks.beforeCommit = null; await h(); }
        let conflict = false;
        for (const [p, ver] of reads) if ((versions.get(p) || 0) !== ver) conflict = true;
        if (conflict) continue;
        for (const [p, kind, v, o] of staged) apply(p, kind, v, o);
        return out;
      }
      throw new Error('transaction contention');
    }
  };
  return db;
}
const FieldValue = { increment: (n) => ({ __inc: n }) };

class FakeHttpsError extends Error { constructor(status, message, code) { super(message); this.name = 'FakeHttpsError'; this.status = status; this.code = code; } }
const fail = (s, m, c) => { throw new FakeHttpsError(s, m, c); };
async function rejects(promise, code, status) {
  let caught = null; try { await promise; } catch (e) { caught = e; }
  assert.ok(caught, 'expected rejection ' + code);
  assert.equal(caught.code, code, 'code ' + caught.code + ' (' + caught.message + ') expected ' + code);
  if (status) assert.equal(caught.status, status);
  return caught;
}

/* ---------- מנוע הזמנות אמיתי עם assertMayAssign כמו ב-index.js ---------- */
const ROLE_RANK = { firefighter: 1, deputy_team_leader: 2, team_leader: 3, deputy: 4, commander: 5, station_commander: 5, hr_coordinator: 6, district_commander: 7 };
function assertMayAssign(gate, targetRole, targetBefore, targetUid, wantSuper, targetDesired) {
  if (gate.cap === Infinity) return;
  if (targetRole && (ROLE_RANK[targetRole] || 99) > gate.cap) { const e = new Error('rank'); e.code = 'permission-denied'; throw e; }
  if (!registrationSafety.withinRoleSetterScope(gate, targetBefore || {}, targetDesired || {})) { const e = new Error('scope'); e.code = 'permission-denied'; throw e; }
}
const clockBox = { now: NOW };
let clock = NOW;
Object.defineProperty(clockBox, 'value', { get: () => clock, set: (v) => { clock = v; } });
const invitations = invitationsModule.createInvitations({
  clock: () => clock, randomBytes: (n) => crypto.randomBytes(n),
  createHash: (v) => crypto.createHash('sha256').update(String(v)).digest('hex'),
  timingSafeEqual: crypto.timingSafeEqual, assertMayAssign, withinRoleSetterScope: registrationSafety.withinRoleSetterScope
});

/* ---------- בנייה ---------- */
const AUTH_USERS = new Map();
function authUser(uid, over) {
  AUTH_USERS.set(uid, Object.assign({ uid, disabled: false, emailVerified: true, email: uid + '@example.test', customClaims: {} }, over || {}));
  return AUTH_USERS.get(uid);
}
function req(uid, data, claims) {
  const u = AUTH_USERS.get(uid) || {};
  return { auth: uid ? { uid, token: Object.assign({ email: u.email, email_verified: u.emailVerified === true }, u.customClaims || {}, claims || {}) } : null, data: data || {} };
}
function build(over) {
  const o = over || {};
  const db = o.db || fakeDb();
  db._put('stations/eilat', { name: 'אילת', districtId: 'south', active: true, status: 'active' });
  db._put('stations/haifa', { name: 'חיפה', districtId: 'north', active: true, status: 'active' });
  const audits = [];
  const qualCalls = [];
  const service = createJoinCampaignService({
    db, contract, invitations, onboardingContract, qualifications, serverTimestamp: () => new Date(clock), FieldValue, fail,
    requireSuper: async (r) => { const u = AUTH_USERS.get(r.auth && r.auth.uid); if (!r.auth || !u || u.customClaims.super !== true || u.disabled) fail('permission-denied', 'super', 'super'); return { uid: u.uid, token: Object.assign({ email: u.email }, u.customClaims) }; },
    requireIdentity: async (r) => { const u = AUTH_USERS.get(r.auth && r.auth.uid); if (!r.auth || !u || u.disabled || u.emailVerified !== true) fail('permission-denied', 'identity', 'identity'); return Object.freeze({ uid: u.uid, email: u.email, email_verified: true }); },
    requireAuth: (r) => { if (!r.auth) fail('unauthenticated', 'auth', 'auth'); return r.auth; },
    getAuthUser: async (uid) => AUTH_USERS.get(uid) || null,
    getAuthUsers: async (uids) => uids.map((u) => AUTH_USERS.get(u)).filter(Boolean),
    resolveStation: async (sid, tx) => { const s = tx ? (await tx.get(db.doc('stations/' + sid))).data() : db._get('stations/' + sid); return s ? { id: sid, name: s.name, districtId: s.districtId, active: s.active === true } : null; },
    openAudit: async (auth, action, target, details) => { const row = { action, target, details, sealed: null }; audits.push(row); return { set: async (x) => { row.sealed = x; } }; },
    sealAudit: async (ref, extra) => ref.set(extra),
    now: () => clock, randomBytes: (n) => crypto.randomBytes(n), hash, timingSafeEqual: crypto.timingSafeEqual,
    knownDistricts: ['south', 'north'], hrCap: 3
  });
  return { db, service, audits, qualCalls };
}
function approvalAuthority(db) {
  return approvalModule.createOnboardingApprovalAuthority({ db, invitations, contract: onboardingContract });
}

authUser('super1', { customClaims: { super: true, stationId: 'eilat', districtId: 'south' } });
authUser('hr1', { customClaims: { role: 'hr_coordinator', stationId: 'eilat', districtId: 'south' } });
authUser('hr_haifa', { customClaims: { role: 'hr_coordinator', stationId: 'haifa', districtId: 'north' } });
authUser('deputy1', { customClaims: { role: 'deputy', stationId: 'eilat', districtId: 'south' } });
authUser('w1'); authUser('w2'); authUser('w3'); authUser('w_unverified', { emailVerified: false });
function seedHr(db) {
  db._put('stations/eilat/users/hr1', { role: 'hr_coordinator', active: true, is_active: true, stationId: 'eilat', districtId: 'south' });
  db._put('stations/haifa/users/hr_haifa', { role: 'hr_coordinator', active: true, is_active: true, stationId: 'haifa', districtId: 'north' });
}
const createInput = (over) => Object.assign({ label: 'קליטה ספטמבר', allowed_shifts: ['A', 'B'], max_registrations: 2, expires_at_ms: NOW + 7 * 86400000 }, over || {});
const redeemInput = (token, over) => Object.assign({ request_id: 'req_' + crypto.randomBytes(8).toString('hex'), token, full_name: 'בודק דמה', phone: '0501234567', shift: 'A',
  qualifications: [{ key: 'driver', valid_until_ms: NOW + 86400000 * 30 }], ack: { correctness: true, terms_version: 'v1', privacy_version: 'v1' } }, over || {});


/* ---------- מוכנות מכשיר ---------- */
function buildReadiness(db) {
  const sent = []; const audits = [];
  let sendMode = 'ok';
  const service = createDeviceReadinessService({
    db, contract, fail,
    requireAuth: (r) => { if (!r.auth) fail('unauthenticated', 'auth', 'auth'); return r.auth; },
    getAuthUser: async (uid) => AUTH_USERS.get(uid) || null,
    sendToToken: async (p) => { if (sendMode === 'fail') { const e = new Error('x'); e.code = 'messaging/registration-token-not-registered'; throw e; } sent.push(p); return 'projects/x/messages/1'; },
    deliveryFence: { check: async ({ stationId, globalSuppressed }) => { if (typeof globalSuppressed !== 'boolean') return { allowed: false, reason: 'global-state-unavailable' }; const s = db._get('stations/' + stationId); return s && s.active ? { allowed: true, reason: 'ok' } : { allowed: false, reason: 'station-inactive' }; } },
    openAudit: async (auth, action, target, details) => { const row = { action, target, details, sealed: null }; audits.push(row); return { set: async (x) => { row.sealed = x; } }; },
    sealAudit: async (ref, extra) => ref.set(extra),
    now: () => clock, randomBytes: (n) => crypto.randomBytes(n), hash, dayKey: (ms) => String(Math.floor(ms / 86400000)), serverTimestamp: () => 'TS'
  });
  return { service, sent, audits, setSendMode: (m) => { sendMode = m; } };
}


module.exports = { fakeDb, FieldValue, FakeHttpsError, fail, rejects, invitations, AUTH_USERS, authUser, req, build, seedHr, createInput, redeemInput,
  buildReadiness, hash, NOW, contract, onboardingContract, qualifications, clockBox,
  setClock: (v) => { clock = v; }, getClock: () => clock };
