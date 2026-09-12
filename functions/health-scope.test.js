'use strict';

const assert = require('node:assert/strict');
const scope = require('./health-scope');

const stations = [
  { station_id: 'alpha', silent: false },
  { station_id: 'beta', silent: true },
  { station_id: 'gamma', silent: false }
];
const finding = (code = 'TEST_FINDING') => ({ level: 'warn', code, title: 'בדיקה', detail: 'פרט' });
const report = (cycle, stationId, findings = []) => ({
  cycle_id: cycle.cycle_id, station_id: stationId, ok: true, findings
});
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('ok - ' + name); }

test('run id is required and is the cycle identity', () => {
  assert.throws(() => scope.openCycle({ stations }), /run_id/);
  const a = scope.openCycle({ run_id: 'run_20260911_0001', stations });
  const b = scope.openCycle({ run_id: 'run_20260911_0002', stations });
  assert.notEqual(a.cycle_id, b.cycle_id);
});

test('old reports cannot complete a new cycle', () => {
  const a = scope.openCycle({ run_id: 'run_20260911_0003', stations });
  const b = scope.openCycle({ run_id: 'run_20260911_0004', stations });
  const result = scope.summarizeCycle(b, a.inventory.map((id) => report(a, id)), { stations_now: stations });
  assert.notEqual(result.verdict, scope.VERDICT.ALL_CLEAR);
  assert.equal(result.reported, 0);
});

test('current inventory is mandatory', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0005', stations });
  assert.throws(() => scope.summarizeCycle(cycle, [], {}), /stations_now/);
  assert.throws(() => scope.planPage(cycle, { budget_ms: 10, per_station_ms: 1 }), /stations_now/);
});

test('inventory equality is exact, fingerprint is not authoritative', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0006', stations });
  const forged = { ...cycle, inventory: ['alpha', 'beta', 'other'], total: 3 };
  assert.throws(() => scope.validateCycle(forged), /inconsistent/);
  assert.equal(scope.inventoryMatches(cycle, [...stations].reverse()), true);
  assert.equal(scope.inventoryMatches(cycle, stations.slice(0, 2)), false);
});

test('invalid and terminal cursors fail closed', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0007', stations });
  assert.throws(() => scope.planPage(cycle, { stations_now: stations, budget_ms: 10, per_station_ms: 1, cursor: 'outside' }), /cycle inventory/);
  assert.throws(() => scope.planPage(cycle, { stations_now: stations, budget_ms: 10, per_station_ms: 1, cursor: 'gamma' }), /continuation/);
});

test('no station is forced beyond budget', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0008', stations });
  const page = scope.planPage(cycle, { stations_now: stations, budget_ms: 1, per_station_ms: 999 });
  assert.equal(page.verdict, scope.VERDICT.BUDGET_EXHAUSTED);
  assert.equal(page.scan.length, 0);
  assert.equal(page.page_is_last, false);
});

test('silence is refreshed for every page and global wins', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0009', stations });
  const changed = stations.map((row) => ({ ...row, silent: row.station_id === 'alpha' }));
  let page = scope.planPage(cycle, { stations_now: changed, global_silent: false, budget_ms: 1, per_station_ms: 1 });
  assert.equal(page.scan[0].silent, true);
  assert.equal(page.scan[0].silence_reason, 'station');
  page = scope.planPage(cycle, { stations_now: stations, global_silent: true, budget_ms: 1, per_station_ms: 1 });
  assert.equal(page.scan[0].silent, true);
  assert.equal(page.scan[0].silence_reason, 'global');
});

test('failed scan is rejected and remains missing', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0010', stations });
  const reports = cycle.inventory.map((id) => report(cycle, id));
  reports[0] = { ...reports[0], ok: false, error: 'timeout' };
  const result = scope.summarizeCycle(cycle, reports, { stations_now: stations });
  assert.equal(result.verdict, scope.VERDICT.PARTIAL);
  assert.deepEqual(result.missing, ['alpha']);
  assert.equal(result.rejected[0].reason, 'scan-incomplete');
});

test('malformed findings are rejected', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0011', stations });
  const reports = cycle.inventory.map((id) => report(cycle, id));
  reports[1] = { ...reports[1], findings: null };
  const result = scope.summarizeCycle(cycle, reports, { stations_now: stations });
  assert.equal(result.verdict, scope.VERDICT.PARTIAL);
  assert.equal(result.rejected[0].reason, 'invalid-findings');
});

test('duplicates and foreign reports cannot authorize all clear', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0012', stations });
  const reports = cycle.inventory.map((id) => report(cycle, id));
  reports.push(report(cycle, 'alpha'), report(cycle, 'outside'));
  const result = scope.summarizeCycle(cycle, reports, { stations_now: stations });
  assert.equal(result.verdict, scope.VERDICT.INVALID);
  assert.equal(result.rejected.length, 2);
});

test('inventory drift requires restart', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0013', stations });
  const changed = stations.concat({ station_id: 'delta', silent: false });
  assert.equal(scope.planPage(cycle, { stations_now: changed, budget_ms: 10, per_station_ms: 1 }).verdict,
    scope.VERDICT.RESTART_REQUIRED);
  assert.equal(scope.summarizeCycle(cycle, [], { stations_now: changed }).verdict,
    scope.VERDICT.RESTART_REQUIRED);
});

test('complete clean cycle can say all clear', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0014', stations });
  const result = scope.summarizeCycle(cycle, cycle.inventory.map((id) => report(cycle, id)), { stations_now: stations });
  assert.equal(result.verdict, scope.VERDICT.ALL_CLEAR);
});

test('complete cycle with findings is not clear', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0015', stations });
  const reports = cycle.inventory.map((id) => report(cycle, id, id === 'beta' ? [finding()] : []));
  const result = scope.summarizeCycle(cycle, reports, { stations_now: stations });
  assert.equal(result.verdict, scope.VERDICT.FINDINGS);
  assert.equal(result.findings, 1);
});

test('empty inventory never means healthy', () => {
  const cycle = scope.openCycle({ run_id: 'run_20260911_0016', stations: [] });
  assert.equal(scope.summarizeCycle(cycle, [], { stations_now: [] }).verdict, scope.VERDICT.EMPTY);
});

console.log('health-scope: ' + passed + ' tests passed');
