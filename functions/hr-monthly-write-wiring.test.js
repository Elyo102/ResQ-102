'use strict';
// Exact public-wrapper composition with real services and synthetic Firestore/Auth.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fakeDb, FakeHttpsError: HttpsError } = require('./hr-pilot-test-harness');
const { createHrMonthlyReadAccess } = require('./hr-monthly-read-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const hrMonthlyModule = require('./hr-monthly-summary');
const hrMonthsBackfillModule = require('./hr-months-backfill');
const source = fs.readFileSync(require.resolve('./index'), 'utf8');
function section(start, end) {
  assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
  const a = source.indexOf(start), b = source.indexOf(end); assert.ok(b > a);
  return source.slice(a, b);
}
const helpers = section('function hrMonthlyContext(req) {', 'exports.getHrMonthlySummary =');
const builder = section('exports.buildHrMonthlySummaryNow =', 'async function hrMonthlyStations()');
const backfill = section('const hrMonthsBackfill =', "const { onDocumentWritten, onDocumentCreated } =");
const sid = 'demo_wiring', uid = 'fixture_actor', authTime = 1700000000;
function fixture(superUser = true) {
  const db = fakeDb();
  db._put(`stations/${sid}/users/${uid}`, { stationId: sid, role: 'hr_coordinator', active: true });
  const record = { uid, disabled: false, customClaims: { stationId: sid, role: 'hr_coordinator', ...(superUser ? { super: true } : {}) } };
  const req = { auth: { uid, token: { ...record.customClaims, auth_time: authTime } }, data: {} };
  const counts = { build: 0, backfill: 0, status: 0, auth: 0 };
  const access = createHrMonthlyReadAccess({ db, HttpsError, auth: { getUser: async () => { counts.auth++; return structuredClone(record); } } });
  const context = { exports: {}, db, HttpsError, HR_MONTHLY_OPTIONS: {}, onCall: (_options, fn) => fn,
    hrMonthlyReads: access, hrMonthlyIdentity: createOpsMemberIdentity({ db, HttpsError }),
    STATION_ID_RE: /^[a-z0-9_-]{2,80}$/, isSuperAdmin: auth => auth.token.super === true,
    prevMonthKey: () => '2026-09',
    hrMonthlyModule: { createHrMonthlySummary(options) {
      assert.equal(options.trustedScheduler, undefined); assert.equal(typeof options.authorize, 'function');
      const service = hrMonthlyModule.createHrMonthlySummary(options);
      return { build: async input => { counts.build++; return service.build(input); } };
    } },
    hrMonthsBackfillModule: { createHrMonthsBackfill(options) {
      assert.equal(options.trustedMaintenance, undefined);
      const service = hrMonthsBackfillModule.createHrMonthsBackfill(options);
      return { run: async input => { assert.equal(typeof options.authorize, 'function'); counts.backfill++; return service.run(input); },
        status: async input => { counts.status++; return service.status(input); } };
    } } };
  vm.runInNewContext(helpers + builder + backfill, context, { timeout: 1000 });
  return { db, req, record, counts, invoke: name => context.exports[name](req) };
}
const routes = ['buildHrMonthlySummaryNow', 'backfillHrRequestMonths', 'getHrRequestMonthsBackfillStatus'];
for (const route of routes) {
  test(`${route}: valid captured super uses real service and fresh authorization`, async () => {
    const f = fixture(); const result = await f.invoke(route); assert.ok(result); assert.ok(f.counts.auth >= 2);
    assert.equal(f.counts.build + f.counts.backfill + f.counts.status, 1);
  });
  for (const [label, mutate] of [
    ['disabled', f => { f.record.disabled = true; }],
    ['revoked', f => { f.record.tokensValidAfterTime = new Date((authTime + 1) * 1000).toISOString(); }],
    ['super demoted', f => { delete f.record.customClaims.super; }],
  ]) test(`${route}: ${label} cannot enter service or write`, async () => {
    const f = fixture(); mutate(f); const before = structuredClone([...f.db._store]);
    await assert.rejects(f.invoke(route), e => e.code === 'permission-denied');
    assert.equal(f.counts.build + f.counts.backfill + f.counts.status, 0); assert.deepEqual([...f.db._store], before);
  });
  test(`${route}: client trusted bypass flags are rejected`, async () => {
    for (const key of ['trustedScheduler', 'trustedMaintenance', 'authorize']) {
      const f = fixture(); f.req.data = { [key]: true };
      await assert.rejects(f.invoke(route), e => e.code === 'invalid-argument');
      assert.equal(f.counts.build + f.counts.backfill + f.counts.status, 0);
    }
  });
}
test('ordinary HR can build but neither backfill nor view super-only backfill status', async () => {
  const f = fixture(false); assert.ok(await f.invoke('buildHrMonthlySummaryNow'));
  for (const route of routes.slice(1)) await assert.rejects(f.invoke(route), e => e.code === 'permission-denied');
  assert.equal(f.counts.backfill + f.counts.status, 0);
});
