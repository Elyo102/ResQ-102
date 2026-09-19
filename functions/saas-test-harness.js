'use strict';
/* תשתית בדיקה לשכבת ה-SaaS: Firestore מזויף עם טרנזקציות אופטימיות (עותק
 * מצומצם של join-campaign-test-harness), ספק חיוב מזויף, חוזה אמיתי, שירות
 * אמיתי. אינו נטען בייצור. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const contract = require('./saas-contract');
const { createFakeBillingProvider } = require('./saas-billing-provider');
const { createSaasService } = require('./saas-service');

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const NOW = 1_800_000_000_000; // 2027-01-15T08:00:00Z

/* ---------- Firestore מזויף ---------- */
function fakeDb() {
  const store = new Map();
  const versions = new Map();
  const stats = { reads: 0, writes: 0, transactions: 0 };
  const clone = (v) => structuredClone(v);
  const bump = (p) => versions.set(p, (versions.get(p) || 0) + 1);
  const snapOf = (path) => { stats.reads += 1; const v = store.get(path); return { exists: v !== undefined, id: path.split('/').pop(), ref: docRef(path), data: () => (v === undefined ? undefined : clone(v)) }; };
  function docRef(path) { return { path, get: async () => snapOf(path), set: async (v, o) => apply(path, 'set', v, o), update: async (v) => apply(path, 'update', v) }; }
  function apply(path, kind, value, options) {
    if (kind === 'create') { if (store.has(path)) throw new Error('ALREADY_EXISTS ' + path); store.set(path, clone(value)); }
    else if (kind === 'set') store.set(path, options && options.merge ? Object.assign({}, store.get(path) || {}, clone(value)) : clone(value));
    else if (kind === 'update') { if (!store.has(path)) throw new Error('NOT_FOUND ' + path); store.set(path, Object.assign({}, store.get(path), clone(value))); }
    else if (kind === 'delete') store.delete(path);
    stats.writes += 1; bump(path);
  }
  function query(collection) {
    const q = { _c: collection, _w: [], _o: null, _l: Infinity, _after: undefined, _isQuery: true };
    q.where = (f, op, v) => { q._w.push([f, op, v]); return q; };
    q.orderBy = (f, dir) => { q._o = [f, dir || 'asc']; return q; };
    q.limit = (n) => { q._l = n; return q; };
    q.startAfter = (v) => { q._after = v; return q; };
    q.get = async () => {
      const prefix = collection + '/';
      let rows = [];
      for (const [p, v] of store) if (p.startsWith(prefix) && p.slice(prefix.length).indexOf('/') === -1) rows.push([p, v]);
      for (const [f, op, val] of q._w) rows = rows.filter(([, v]) => (op === '==' ? v[f] === val : true));
      if (q._o) rows.sort((a, b) => (a[1][q._o[0]] > b[1][q._o[0]] ? 1 : a[1][q._o[0]] < b[1][q._o[0]] ? -1 : 0) * (q._o[1] === 'desc' ? -1 : 1));
      if (q._after !== undefined && q._o) rows = rows.filter(([, v]) => (q._o[1] === 'desc' ? v[q._o[0]] < q._after : v[q._o[0]] > q._after));
      rows = rows.slice(0, q._l);
      return { docs: rows.map(([p]) => snapOf(p)), size: rows.length, empty: rows.length === 0 };
    };
    return q;
  }
  const db = {
    _store: store, _stats: stats, _put(p, v) { store.set(p, v); bump(p); }, _get(p) { return store.get(p); },
    doc: docRef,
    collection: (path) => Object.assign(query(path), { doc: (id) => docRef(path + '/' + id) }),
    async runTransaction(fn) {
      stats.transactions += 1;
      for (let attempt = 0; attempt < 6; attempt++) {
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

class FakeHttpsError extends Error { constructor(status, message, code) { super(message); this.name = 'FakeHttpsError'; this.status = status; this.code = code; } }
const fail = (s, m, c) => { throw new FakeHttpsError(s, m, c); };
async function rejects(promise, code, status) {
  let caught = null; try { await promise; } catch (e) { caught = e; }
  assert.ok(caught, 'expected rejection ' + code);
  assert.equal(caught.code, code, 'code ' + caught.code + ' (' + caught.message + ') expected ' + code);
  if (status) assert.equal(caught.status, status);
  return caught;
}

/* ---------- משתמשים ---------- */
const AUTH_USERS = new Map();
function authUser(uid, over) {
  AUTH_USERS.set(uid, Object.assign({ uid, disabled: false, emailVerified: true, email: uid + '@example.test', customClaims: {} }, over || {}));
  return AUTH_USERS.get(uid);
}
function req(uid, data, claims) {
  const u = AUTH_USERS.get(uid) || {};
  return { auth: uid ? { uid, token: Object.assign({ email: u.email, email_verified: u.emailVerified === true }, u.customClaims || {}, claims || {}) } : null, data: data === undefined ? {} : data };
}
authUser('super1', { customClaims: { super: true, stationId: 'eilat_102', districtId: 'south' } });
authUser('hr_eilat', { customClaims: { role: 'hr_coordinator', stationId: 'eilat_102', districtId: 'south' } });
authUser('cmd_haifa', { customClaims: { role: 'station_commander', stationId: 'haifa_201', districtId: 'north' } });
authUser('ff_eilat', { customClaims: { role: 'firefighter', stationId: 'eilat_102', districtId: 'south' } });

let clock = NOW;
let seq = 0;
function build(over) {
  const o = over || {};
  const db = o.db || fakeDb();
  db._put('stations/eilat_102', { name: 'תחנה א׳', districtId: 'south', active: true, status: 'active' });
  db._put('stations/beersheba_103', { name: 'תחנה ב׳', districtId: 'south', active: true, status: 'active' });
  db._put('stations/haifa_201', { name: 'תחנה ג׳', districtId: 'north', active: true, status: 'active' });
  db._put('stations/closed_104', { name: 'תחנה ד׳', districtId: 'south', active: false, status: 'closed' });
  const billing = o.billing || createFakeBillingProvider();
  const audits = [];
  const service = createSaasService({
    // הבדיקות מפעילות את השכבה במפורש; ברירת המחדל בייצור כבויה,
    // ויש בדיקה נפרדת שמוודאת שכבוי באמת חוסם הכול.
    enabled: 'enabled' in o ? o.enabled : true,
    db, contract, billing, fail,
    requireAuth: (r) => { if (!r || !r.auth) fail('unauthenticated', 'auth', 'auth'); return r.auth; },
    getAuthUser: async (uid) => AUTH_USERS.get(uid) || null,
    openAudit: async (auth, action, target, details) => { const row = { action, target, details, actor: auth.uid, sealed: null }; audits.push(row); return { set: async (x) => { row.sealed = x; } }; },
    sealAudit: async (ref, extra) => ref.set(extra),
    now: () => clock, hash, serverTimestamp: () => 'TS', randomId: () => String(++seq).padStart(6, '0')
  });
  return { db, service, billing, audits };
}
const rid = (label) => ('req_' + String(label || '') + '_' + crypto.randomBytes(6).toString('hex')).replace(/[^A-Za-z0-9_-]/g, '_').padEnd(16, '0');
const createInput = (over) => Object.assign({ request_id: rid('c'), organization_id: 'org_south', name: 'ארגון בדיקה', district_id: 'south', plan_id: 'evaluation' }, over || {});

/** ארגון עם תחנה מצורפת ומנוי פעיל (סימולציה) — נקודת פתיחה לבדיקות רבות. */
async function seedOrg(ctx, over) {
  const o = over || {};
  const created = await ctx.service.createOrganization(req('super1', createInput(Object.assign({ plan_id: o.plan_id || 'station' }, o.create || {}))));
  const oid = created.organization_id;
  for (const s of (o.stations || ['eilat_102'])) await ctx.service.attachStationToOrganization(req('super1', { request_id: rid('a'), organization_id: oid, station_id: s }));
  let revision = 1;
  if (o.activate !== false) { const r = await ctx.service.setSubscriptionStatus(req('super1', { request_id: rid('s'), organization_id: oid, action: 'activate', expected_revision: 1 })); revision = r.revision; }
  return { oid, subscription_id: created.subscription_id, revision };
}
const subOf = (db, oid) => { const org = db._get('organizations/' + oid); return db._get('organizations/' + oid + '/subscriptions/' + org.current_subscription_id); };

module.exports = { fakeDb, FakeHttpsError, fail, rejects, AUTH_USERS, authUser, req, build, rid, createInput, seedOrg, subOf, hash, NOW, contract,
  createFakeBillingProvider, setClock: (v) => { clock = v; }, getClock: () => clock };
