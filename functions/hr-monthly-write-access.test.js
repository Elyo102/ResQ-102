'use strict';
// Synthetic transaction/authorization regressions. No SDK or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeDb, FakeHttpsError: HttpsError } = require('./hr-pilot-test-harness');
const { createHrMonthlyReadAccess } = require('./hr-monthly-read-access');
const { createHrMonthlySummary } = require('./hr-monthly-summary');
const { createHrMonthsBackfill } = require('./hr-months-backfill');
const sid = 'demo_write', uid = 'synthetic_actor', month = '2026-09', at = 1700000000;
function fixture(superUser = false) {
  const db = fakeDb();
  const record = { uid, disabled: false, customClaims: { stationId: sid, role: 'hr_coordinator', ...(superUser ? { super: true } : {}) } };
  db._put(`stations/${sid}/users/${uid}`, { stationId: sid, role: 'hr_coordinator', active: true });
  const req = { auth: { uid, token: { ...record.customClaims, auth_time: at } }, data: {} };
  const gate = createHrMonthlyReadAccess({ db, HttpsError, auth: { getUser: async () => structuredClone(record) } });
  const session = gate.capture(req, { superOnly: superUser });
  const summary = createHrMonthlySummary({ db, HttpsError, authorize: session.inTransaction });
  const backfill = createHrMonthsBackfill({ db, HttpsError, authorize: session.inTransaction });
  const input = { station_id: sid, month, intent_id: 'synthetic_intent' };
  const backInput = { station_id: sid, actor_uid: uid, dry_run: true };
  return { db, record, req, gate, session, summary, backfill, input, backInput };
}
const snapshot = f => structuredClone([...f.db._store]);
const denied = promise => assert.rejects(promise, e => e.code === 'permission-denied');
test('mutation factories fail closed without explicit authorization, including empty dry-run receipt', async () => {
  const f = fixture(), before = snapshot(f);
  const summary = createHrMonthlySummary({ db: f.db, HttpsError });
  await denied(summary.beginGeneration(f.input));
  await denied(summary.runSlice({ ...f.input, generation_id: 'missing' }, {}));
  await denied(summary.activate({ ...f.input, generation_id: 'missing' }, {}));
  await denied(createHrMonthsBackfill({ db: f.db, HttpsError }).run(f.backInput));
  assert.deepEqual(snapshot(f), before);
});
for (const [label, revoke] of [
  ['disabled', f => { f.record.disabled = true; }],
  ['revoked', f => { f.record.tokensValidAfterTime = new Date((at + 1) * 1000).toISOString(); }],
  ['role removed', f => { f.record.customClaims.role = 'firefighter'; }],
  ['inactive profile', f => f.db._put(`stations/${sid}/users/${uid}`, { stationId: sid, role: 'hr_coordinator', active: false })],
]) {
  test(`${label}: captured authority rejects begin replay and every later generation boundary`, async () => {
    const f = fixture(), begun = await f.summary.beginGeneration(f.input);
    revoke(f); const before = snapshot(f);
    await denied(f.summary.beginGeneration(f.input));
    await denied(f.summary.build(f.input));
    await denied(f.summary.runSlice({ ...f.input, generation_id: begun.generation_id }, {}));
    await denied(f.summary.activate({ ...f.input, generation_id: begun.generation_id }, {}));
    assert.deepEqual(snapshot(f), before);
  });
  test(`${label}: backfill dry-run cannot write audit receipt`, async () => {
    const f = fixture(); revoke(f); const before = snapshot(f);
    await denied(f.backfill.run(f.backInput)); assert.deepEqual(snapshot(f), before);
  });
}
test('super-only capture rejects HR; captured super cannot regain authority through mutated request', async () => {
  const hr = fixture(); assert.throws(() => hr.gate.capture(hr.req, { superOnly: true }), e => e.code === 'permission-denied');
  const f = fixture(true); f.req.auth.uid = 'replacement'; f.req.auth.token.stationId = 'other';
  delete f.record.customClaims.super;
  await denied(f.backfill.run(f.backInput));
  await denied(f.db.runTransaction(tx => f.session.inTransaction(tx, 'other')));
});
test('revocation between successful classification and receipt blocks only later commit, preserving completed work', async () => {
  const f = fixture(true), path = `stations/${sid}/hr_requests/legacy`;
  const original = { schema: 'hr-request-v1', station_id: sid, kind: 'sick', from_date: '2026-09-01', to_date: '2026-09-02', revision: 7, updated_at_ms: 123 };
  f.db._put(path, original);
  const run = f.db.runTransaction.bind(f.db);
  f.db.runTransaction = async fn => { const out = await run(fn); if (f.db._get(path).months) f.record.disabled = true; return out; };
  await denied(f.backfill.run({ ...f.backInput, dry_run: false }));
  assert.deepEqual(f.db._get(path), { ...original, months: ['2026-09'] });
  const receipt = f.db._get(`stations/${sid}/hr_request_counters/hr-months-backfill-v1`);
  assert.equal(receipt.scan_phase, 'processing');
  assert.equal(Object.hasOwn(receipt, 'completed_at_ms'), false);
  assert.deepEqual(receipt.runs, []);
  assert.deepEqual(receipt.totals, {});
});
test('authorized dry-run records audit only and disabled replay leaves prior receipt unchanged', async () => {
  const f = fixture(true); await f.backfill.run(f.backInput); const before = snapshot(f);
  assert.ok(f.db._get(`stations/${sid}/hr_request_counters/hr-months-backfill-v1`));
  f.record.disabled = true; await denied(f.backfill.run(f.backInput)); assert.deepEqual(snapshot(f), before);
});
