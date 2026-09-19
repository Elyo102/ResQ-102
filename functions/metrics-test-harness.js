'use strict';
/* תשתית בדיקה לשכבת המדדים: Firestore מזויף מינימלי עם טרנזקציות אופטימיות,
 * sink בזיכרון, ומשתמשי Auth מדומים. אינו נטען בייצור ואינו מייבא את תשתית
 * הקליטה הקבוצתית. */

const assert = require('node:assert/strict');
const { createMetricsService } = require('./metrics-service');
const { createFakeMetricsSink } = require('./metrics-sink');

const NOW = Date.parse('2026-09-18T10:00:00.000Z');

/* ---------- Firestore מזויף ---------- */
function fakeDb() {
  const store = new Map();
  const versions = new Map();
  const stats = { reads: 0, writes: 0, transactions: 0, retries: 0 };
  const bump = (p) => versions.set(p, (versions.get(p) || 0) + 1);
  const clone = (v) => structuredClone(v);
  const snapOf = (path) => { stats.reads += 1; const v = store.get(path); return { exists: v !== undefined, id: path.split('/').pop(), ref: docRef(path), data: () => (v === undefined ? undefined : clone(v)) }; };
  function docRef(path) {
    return { path, get: async () => snapOf(path), set: async (v, o) => apply(path, 'set', v, o), update: async (v) => apply(path, 'update', v), delete: async () => apply(path, 'delete'),
      collection: (name) => collectionRef(path + '/' + name) };
  }
  function resolveFV(value, prev) {
    const out = {};
    for (const k of Object.keys(value)) { const v = value[k]; out[k] = v && v.__inc !== undefined ? (Number(prev[k] || 0) + v.__inc) : v; }
    return out;
  }
  function apply(path, kind, value, options) {
    if (kind === 'create') { if (store.has(path)) throw new Error('ALREADY_EXISTS ' + path); store.set(path, resolveFV(value, {})); }
    else if (kind === 'set') store.set(path, options && options.merge ? Object.assign({}, store.get(path) || {}, resolveFV(value, store.get(path) || {})) : resolveFV(value, {}));
    else if (kind === 'update') { if (!store.has(path)) throw new Error('NOT_FOUND ' + path); store.set(path, Object.assign({}, store.get(path), resolveFV(value, store.get(path)))); }
    else if (kind === 'delete') store.delete(path);
    stats.writes += 1; bump(path);
  }
  function collectionRef(collection) {
    const q = { _c: collection, _w: [], _l: Infinity, _isQuery: true };
    q.where = (f, op, v) => { q._w.push([f, op, v]); return q; };
    q.limit = (n) => { q._l = n; return q; };
    q.doc = (id) => docRef(collection + '/' + id);
    q.get = async () => {
      const prefix = collection + '/';
      let rows = [];
      for (const [p, v] of store) if (p.startsWith(prefix) && p.slice(prefix.length).indexOf('/') === -1) rows.push([p, v]);
      for (const [f, op, val] of q._w) rows = rows.filter(([, v]) => {
        const x = v[f] instanceof Date ? v[f].getTime() : v[f]; const y = val instanceof Date ? val.getTime() : val;
        return op === '==' ? x === y : op === '<=' ? x <= y : true;
      });
      rows = rows.slice(0, q._l);
      return { docs: rows.map(([p]) => snapOf(p)), size: rows.length, empty: rows.length === 0 };
    };
    return q;
  }
  const db = {
    _store: store, _stats: stats, _put(p, v) { store.set(p, v); bump(p); }, _get(p) { return store.get(p); },
    doc: docRef, collection: collectionRef,
    batch() { const ops = []; return { delete: (ref) => ops.push([ref.path, 'delete']), set: (ref, v, o) => ops.push([ref.path, 'set', v, o]), commit: async () => { for (const [p, k, v, o] of ops) apply(p, k, v, o); } }; },
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

/* ---------- משתמשים מדומים (שמות בדויים בלבד) ---------- */
const AUTH_USERS = new Map();
function authUser(uid, over) {
  AUTH_USERS.set(uid, Object.assign({ uid, disabled: false, customClaims: {} }, over || {}));
  return AUTH_USERS.get(uid);
}
function req(uid, data, claims) {
  const u = AUTH_USERS.get(uid) || {};
  return { auth: uid ? { uid, token: Object.assign({}, u.customClaims || {}, claims || {}) } : null, data: data === undefined ? {} : data };
}
authUser('super1', { customClaims: { super: true, stationId: 'eilat' } });
authUser('super_stale', { customClaims: { super: true, stationId: 'eilat' } });
authUser('w1', { customClaims: { role: 'firefighter', stationId: 'eilat' } });
authUser('w2', { customClaims: { role: 'firefighter', stationId: 'eilat' } });
authUser('w_haifa', { customClaims: { role: 'firefighter', stationId: 'haifa' } });
authUser('w_nostation', { customClaims: { role: 'firefighter' } });
authUser('w_disabled', { disabled: true, customClaims: { role: 'firefighter', stationId: 'eilat' } });

let clock = NOW;
function build(over) {
  const o = over || {};
  const db = o.db || fakeDb();
  const sink = o.sink || createFakeMetricsSink();
  const shards = Array.isArray(o.shards) ? o.shards.slice() : null;
  const service = createMetricsService({
    db, sink, fail,
    requireAuth: (r) => { if (!r || !r.auth) fail('unauthenticated', 'auth', 'auth'); return r.auth; },
    getAuthUser: async (uid) => AUTH_USERS.get(uid) || null,
    now: () => clock,
    hashKey: o.hashKey === undefined ? 'test-key-0123456789abcdef' : o.hashKey,
    pickShard: shards ? () => (shards.length ? shards.shift() : 0) : (o.pickShard || (() => 0)),
    serverTimestamp: () => new Date(clock)
  });
  return { db, sink, service };
}
const rid = (n) => 'rd_' + String(n).padStart(40, '0').replace(/[^0-9a-f]/g, '0');
const event = (over) => Object.assign({ event_code: 'login_success', result: 'ok', duration_bucket_ms: 120, release: '42H.20', screen: 'login.html' }, over || {});

module.exports = Object.freeze({
  fakeDb, FieldValue, FakeHttpsError, fail, rejects, AUTH_USERS, authUser, req, build, rid, event, NOW,
  setClock: (v) => { clock = v; }, getClock: () => clock
});
