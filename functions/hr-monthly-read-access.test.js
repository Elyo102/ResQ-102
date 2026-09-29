'use strict';
// Local synthetic composition tests; no SDK, network, credentials or writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fakeDb, FakeHttpsError } = require('./hr-pilot-test-harness');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { createHrMonthlyReadAccess } = require('./hr-monthly-read-access');
const source = fs.readFileSync(require.resolve('./index'), 'utf8');
const start = 'function hrMonthlyContext(req) {';
const end = 'exports.buildHrMonthlySummaryNow =';
assert.equal(source.split(start).length, 2, 'unique real helper boundary');
assert.equal(source.split(end).length, 2, 'unique real wrapper boundary');
const extracted = source.slice(source.indexOf(start), source.indexOf(end));
const SID = 'demo_monthly', UID = 'synthetic_hr', AUTH_TIME = 1700000000;
const routes = ['getHrMonthlySummary', 'getHrMonthlyOverHours', 'compatibility'];
function fixture({ superUser = false, result = { state: 'over', over_employees: [{ full_name: 'Synthetic' }] }, during = () => {} } = {}) {
  const db = fakeDb(), profile = { stationId: SID, role: 'hr_coordinator', active: true, is_active: true };
  const path = `stations/${SID}/users/${UID}`;
  db._put(path, profile);
  let record = { uid: UID, disabled: false, customClaims: { stationId: SID, role: 'hr_coordinator', ...(superUser ? { super: true } : {}) } };
  let authError = null, calls = 0, inside = false, authCalls = 0;
  const original = db.runTransaction.bind(db);
  db.runTransaction = async fn => original(async tx => { inside = true; try { return await fn(tx); } finally { inside = false; } });
  const auth = { getUser: async () => { authCalls++; if (authError) throw authError; return structuredClone(record); } };
  const api = { db, profile, path, get record() { return record; }, set record(v) { record = v; },
    set authError(v) { authError = v; }, get calls() { return calls; }, get authCalls() { return authCalls; } };
  const operation = async input => {
    assert.equal(inside, false, 'data operation is outside retryable authorization transaction');
    assert.equal(input.station_id, SID); calls++; await during(api); return result;
  };
  const context = { exports: {}, onCall: (_options, fn) => fn, HR_MONTHLY_OPTIONS: {}, HttpsError: FakeHttpsError,
    hrMonthlyIdentity: createOpsMemberIdentity({ db, HttpsError: FakeHttpsError }),
    hrMonthlyReads: createHrMonthlyReadAccess({ db, auth, HttpsError: FakeHttpsError }),
    hrMonthly: { read: operation, overHours: operation }, prevMonthKey: () => '2026-09' };
  vm.runInNewContext(extracted + '\nexports.compatibility = getHrOverHoursCompatibility;', context, { timeout: 1000 });
  api.run = context.hrMonthlyReads.run.bind(context.hrMonthlyReads);
  api.req = { auth: { uid: UID, token: { ...record.customClaims, auth_time: AUTH_TIME } }, data: {} };
  api.invoke = route => context.exports[route](api.req);
  return api;
}
const mutations = [
  ['inactive', f => f.db._put(f.path, { ...f.profile, active: false }), 'permission-denied'],
  ['profile role', f => f.db._put(f.path, { ...f.profile, role: 'firefighter' }), 'permission-denied'],
  ['profile transfer', f => f.db._put(f.path, { ...f.profile, stationId: 'other_station' }), 'permission-denied'],
  ['disabled', f => { f.record.disabled = true; }, 'permission-denied'],
  ['Auth role', f => { f.record.customClaims.role = 'firefighter'; }, 'permission-denied'],
  ['Auth transfer', f => { f.record.customClaims.stationId = 'other_station'; }, 'permission-denied'],
  ['revoked', f => { f.record.tokensValidAfterTime = new Date((AUTH_TIME + 1) * 1000).toISOString(); }, 'permission-denied'],
  ['Auth missing', f => { f.authError = { code: 'auth/user-not-found' }; }, 'permission-denied'],
  ['Auth failure', f => { f.authError = { code: 'auth/internal-error' }; }, 'unavailable'],
];
for (const route of routes) {
  test(`${route}: real wrapper returns over and not_built only after both live checks`, async () => {
    for (const result of [{ state: 'over', over_employees: [{ full_name: 'Synthetic' }] }, { state: 'not_built', over_employees: [] }]) {
      const f = fixture({ result }); assert.equal(await f.invoke(route), result); assert.equal(f.calls, 1); assert.equal(f.authCalls, 2);
    }
  });
  for (const [label, mutate, code] of mutations) {
    test(`${route}: ${label} before data read denies`, async () => {
      const f = fixture(); mutate(f);
      // Keep the original signed identity rather than minting fresh mutated claims.
      await assert.rejects(f.invoke(route), e => e.code === code);
      assert.equal(f.calls, 0);
    });
    test(`${route}: ${label} during data read suppresses response`, async () => {
      const f = fixture({ during: mutate }); await assert.rejects(f.invoke(route), e => e.code === code); assert.equal(f.calls, 1);
    });
  }
  test(`${route}: live super is profile-free but disabled or demoted super is denied`, async () => {
    const f = fixture({ superUser: true }); f.db._store.delete(f.path); await f.invoke(route); assert.equal(f.authCalls, 2);
    for (const mutate of [g => { g.record.disabled = true; }, g => { delete g.record.customClaims.super; }]) {
      const g = fixture({ superUser: true, during: mutate }); await assert.rejects(g.invoke(route), e => e.code === 'permission-denied');
    }
  });
}
test('request context is frozen and callback executes once despite authorization retries', async () => {
  const f = fixture(); const base = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = async fn => base(async tx => { await fn(tx); return fn(tx); });
  let calls = 0; const before = structuredClone([...f.db._store]);
  await f.run(f.req, async ctx => { assert.ok(Object.isFrozen(ctx)); assert.equal(ctx.sid, SID); calls++; return {}; });
  assert.equal(calls, 1); assert.deepEqual([...f.db._store], before);
});
