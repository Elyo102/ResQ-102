'use strict';
/* מחולל תלויות לבדיקות עלות ושימוש. */
const assert = require('node:assert/strict');
const { createCostUsageService } = require('./cost-usage-service');
const { createFakeMetricsSink } = require('./metrics-sink');

const NOW = Date.parse('2026-09-18T10:00:00.000Z');

function fakeDb(options) {
  const opts = options || {};
  const store = new Map();
  const versions = new Map();
  const stats = { reads: 0, writes: 0, transactions: 0, txRetries: 0 };
  let failBeforeCommitRemaining = 0;
  let transactionTail = Promise.resolve();
  const bump = (p) => versions.set(p, (versions.get(p) || 0) + 1);
  const clone = (v) => structuredClone(v);
  const snapOf = (path) => {
    stats.reads += 1;
    const v = store.get(path);
    return { exists: v !== undefined, id: path.split('/').pop(), ref: docRef(path), data: () => (v === undefined ? undefined : clone(v)) };
  };
  function apply(path, kind, value, options) {
    if (kind === 'set') store.set(path, options && options.merge ? Object.assign({}, store.get(path) || {}, value) : value);
    else if (kind === 'delete') store.delete(path);
    stats.writes += 1; bump(path);
  }
  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      get: async () => snapOf(path),
      set: async (v, o) => apply(path, 'set', v, o),
      delete: async () => apply(path, 'delete')
    };
  }
  function collection(colPath) {
    if (colPath === 'stations') {
      const query = (after, max) => ({
        orderBy(field) { assert.equal(field, '__name__'); return query(after, max); },
        startAfter(id) { return query(id, max); },
        limit(n) { return query(after, n); },
        async get() {
          const docs = [...store.keys()].filter(path => path.startsWith('stations/') &&
            !path.slice('stations/'.length).includes('/'))
            .map(path => path.slice('stations/'.length)).sort()
            .filter(id => !after || id > after).slice(0, max)
            .map(id => ({ id, exists: true, data: () => clone(store.get('stations/' + id)) }));
          stats.reads += docs.length;
          return { docs };
        }
      });
      return query(null, Infinity);
    }
    if (colPath === 'cost_usage_station_daily') {
      const query = (filters, max) => ({
        where(field, op, value) { return query([...filters, [field, op, value]], max); },
        limit(n) { return query(filters, n); },
        async get() {
          const docs = [];
          for (const [path, row] of store.entries()) {
            if (!path.startsWith(colPath + '/') || path.slice(colPath.length + 1).includes('/')) continue;
            if (!filters.every(([field, op, value]) => op === '>=' ? row[field] >= value
              : op === '<=' ? row[field] <= value : op === '==' ? row[field] === value : false)) continue;
            docs.push({ id: path.split('/').pop(), data: () => clone(row) });
          }
          docs.sort((a, b) => a.id.localeCompare(b.id));
          const result = docs.slice(0, max);
          stats.reads += result.length;
          return { docs: result };
        }
      });
      return query([], Infinity);
    }
    return {
      path: colPath,
      limit(n) {
        const lim = n;
        return {
          where(field, op, value) {
            return {
              limit(n2) {
                const lim2 = n2;
                return {
                  async get() {
                    stats.reads += 1;
                    const docs = [];
                    for (const [path, row] of store.entries()) {
                      if (!path.startsWith(colPath + '/')) continue;
                      if (path.slice(colPath.length + 1).includes('/')) continue;
                      if (op === '<=' && field === 'expires_at') {
                        const exp = row && row.expires_at;
                        const ms = exp instanceof Date ? exp.getTime() : Date.parse(exp);
                        if (!(Number.isFinite(ms) && ms <= (value instanceof Date ? value.getTime() : value))) continue;
                      }
                      docs.push({ id: path.split('/').pop(), ref: docRef(path), data: () => clone(row) });
                      if (docs.length >= lim2) break;
                    }
                    return { docs };
                  }
                };
              },
              async get() {
                stats.reads += 1;
                const docs = [];
                for (const [path, row] of store.entries()) {
                  if (!path.startsWith(colPath + '/')) continue;
                  if (path.slice(colPath.length + 1).includes('/')) continue;
                  if (op === '<=' && field === 'expires_at') {
                    const exp = row && row.expires_at;
                    const ms = exp instanceof Date ? exp.getTime() : Date.parse(exp);
                    if (!(Number.isFinite(ms) && ms <= (value instanceof Date ? value.getTime() : value))) continue;
                  }
                  docs.push({ id: path.split('/').pop(), ref: docRef(path), data: () => clone(row) });
                }
                return { docs };
              }
            };
          },
          async get() {
            stats.reads += 1;
            const docs = [];
            for (const [path, row] of store.entries()) {
              if (!path.startsWith(colPath + '/')) continue;
              if (path.slice(colPath.length + 1).includes('/')) continue;
              docs.push({ id: path.split('/').pop(), ref: docRef(path), data: () => clone(row), exists: true });
              if (docs.length >= lim) break;
            }
            return { docs };
          }
        };
      },
      where(field, op, value) {
        return collection(colPath).limit(1e9).where(field, op, value);
      },
      async get() {
        return collection(colPath).limit(1e9).get();
      }
    };
  }

  async function runTransactionNow(work) {
    stats.transactions += 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) stats.txRetries += 1;
      const readVersions = new Map();
      const writes = [];
      const tx = {
        get: async (ref) => {
          const path = ref.path;
          readVersions.set(path, versions.get(path) || 0);
          return snapOf(path);
        },
        set: (ref, value, options) => { writes.push(['set', ref.path, clone(value), options]); },
        delete: (ref) => { writes.push(['delete', ref.path]); }
      };
      const result = await work(tx);
      // Conflict if any read doc changed since read
      let conflict = false;
      for (const [path, ver] of readVersions.entries()) {
        if ((versions.get(path) || 0) !== ver) { conflict = true; break; }
      }
      if (conflict) continue;
      if (failBeforeCommitRemaining > 0) {
        failBeforeCommitRemaining -= 1;
        const err = new Error('simulated-crash-before-commit');
        err.code = 'simulated-crash';
        throw err;
      }
      for (const [kind, path, value, options] of writes) {
        apply(path, kind, value, options);
      }
      return result;
    }
    throw new Error('transaction retries exhausted');
  }

  return {
    _store: store, _stats: stats,
    _put(p, v) { store.set(p, v); bump(p); },
    _get(p) { return store.get(p); },
    _setFailBeforeCommit(n) { failBeforeCommitRemaining = n; },
    doc: docRef,
    getAll: async (...refs) => refs.map(ref => snapOf(ref.path)),
    collection,
    runTransaction(work) {
      // Serialize like Firestore client: overlapping txs queue; conflict retries inside.
      const run = transactionTail.then(() => runTransactionNow(work));
      // Parallel mode: when opts.parallelTransactions, don't fully serialize — race via shared store+versions.
      if (opts.parallelTransactions) {
        return runTransactionNow(work);
      }
      transactionTail = run.catch(() => {});
      return run;
    }
  };
}

class FakeHttpsError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'FakeHttpsError';
    this.status = status;
    this.code = code;
  }
}
const fail = (s, m, c) => { throw new FakeHttpsError(s, m, c); };
async function rejects(promise, code, status) {
  let caught = null;
  try { await promise; } catch (e) { caught = e; }
  assert.ok(caught, 'expected rejection ' + code);
  assert.equal(caught.code, code, 'code ' + caught.code + ' expected ' + code);
  if (status) assert.equal(caught.status, status);
  return caught;
}

const AUTH_USERS = new Map();
function authUser(uid, over) {
  AUTH_USERS.set(uid, Object.assign({ uid, disabled: false, customClaims: {}, email: uid + '@example.test', metadata: { lastSignInTime: '2026-09-17T12:00:00.000Z' } }, over || {}));
  return AUTH_USERS.get(uid);
}
function req(uid, data, claims) {
  const u = AUTH_USERS.get(uid) || {};
  return { auth: uid ? { uid, token: Object.assign({}, u.customClaims || {}, claims || {}) } : null, data: data === undefined ? {} : data };
}
authUser('super1', { customClaims: { super: true, stationId: 'eilat' }, email: 'super@example.test' });
authUser('super_stale', { customClaims: { super: true, stationId: 'eilat' } });
authUser('w1', { customClaims: { role: 'firefighter', stationId: 'eilat' }, email: 'w1@example.test' });
authUser('w2', { customClaims: { role: 'firefighter', stationId: 'haifa' }, email: 'w2@example.test' });
authUser('saas_admin', { customClaims: { role: 'station_commander', stationId: 'eilat', saasAdmin: true }, email: 'saas@example.test' });

let clock = NOW;
function build(over) {
  const o = over || {};
  const db = o.db || fakeDb(o.dbOptions || {});
  const sink = o.sink === undefined ? createFakeMetricsSink() : o.sink;
  const authList = o.authList || [...AUTH_USERS.values()].filter((u) => u.uid !== 'super_stale');
  const profiles = o.profiles || {
    w1: { full_name: 'עובד א' },
    w2: { full_name: 'עובד ב' },
    super1: { full_name: 'מנהל על' }
  };
  const profileReadCount = { n: 0 };
  const service = createCostUsageService({
    db,
    metricsSink: sink,
    billingReader: o.billingReader || null,
    fail,
    requireAuth: (r) => { if (!r || !r.auth) fail('unauthenticated', 'auth', 'auth'); return r.auth; },
    getAuthUser: async (uid) => AUTH_USERS.get(uid) || null,
    listAuthUsers: o.listAuthUsers === null ? null : async ({ pageSize, pageToken } = {}) => {
      if (typeof o.listAuthUsers === 'function') return o.listAuthUsers({ pageSize, pageToken });
      const size = Math.min(Math.max(pageSize || 25, 1), 100);
      const start = pageToken ? Number(pageToken) : 0;
      const slice = authList.slice(start, start + size);
      const next = start + size < authList.length ? String(start + size) : null;
      return { users: slice, nextPageToken: next };
    },
    loadUserProfiles: typeof o.loadUserProfiles === 'function'
      ? o.loadUserProfiles
      : async (authUsers) => {
          // Page-scoped profile reads only (one get per page uid) — never scan all station users.
          const list = Array.isArray(authUsers) ? authUsers : [];
          const out = {};
          for (const u of list) {
            if (!u || typeof u.uid !== 'string') continue;
            const claims = u.customClaims || {};
            const sid = typeof claims.stationId === 'string' ? claims.stationId : '';
            if (sid) {
              profileReadCount.n += 1;
              await db.doc('stations/' + sid + '/users/' + u.uid).get();
            }
            if (profiles[u.uid]) out[u.uid] = profiles[u.uid];
          }
          return out;
        },
    listExpiredCostUsageDocs: async (nowMs, limit) => {
      const out = [];
      for (const [path, row] of db._store.entries()) {
        if (!(path.startsWith('cost_usage_daily/') || path.startsWith('cost_usage_batch_ledger/') ||
            path.startsWith('cost_usage_station_daily/'))) continue;
        const exp = row && row.expires_at;
        const ms = exp instanceof Date ? exp.getTime() : Date.parse(exp);
        if (Number.isFinite(ms) && ms <= nowMs) out.push(path);
        if (out.length >= limit) break;
      }
      return out;
    },
    now: () => clock,
    hashKey: o.hashKey === undefined ? 'cost-usage-test-key-32b!!!!' : o.hashKey,
    serverTimestamp: () => new Date(clock)
  });
  return { db, sink, service, profileReadCount };
}

module.exports = Object.freeze({
  fakeDb, FakeHttpsError, fail, rejects, AUTH_USERS, authUser, req, build, NOW,
  setClock: (v) => { clock = v; }, getClock: () => clock
});
