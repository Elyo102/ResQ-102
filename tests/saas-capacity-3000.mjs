import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
// This benchmark is intentionally narrower than a live SaaS load test. It
// measures the pure calendar solver with 3,000 synthetic roster records. It
// does not measure concurrent users, Firestore, Functions, Auth, FCM, cold
// starts, queues or quotas.
const enginePath = new URL('../functions/schedule-calendar-engine.js', import.meta.url);
const engineSource = fs.readFileSync(enginePath, 'utf8');
assert.doesNotMatch(engineSource, /\brequire\s*\(|\bimport\s+/,
  'calendar engine remains dependency-free');
for (const forbidden of [
  'firebase' + '-admin', 'firebase/' + 'auth', 'firebase/' + 'firestore',
  'firebase/' + 'functions', 'firebase/' + 'messaging',
  'https' + '://', 'http' + '://', 'fe' + 'tch(', 'send' + 'Push', 'send' + 'Mail'
]) {
  assert.equal(engineSource.includes(forbidden), false,
    'calendar engine remains a pure computation module: ' + forbidden);
}

const require = createRequire(import.meta.url);
const { createCalendarEngine } = require('../functions/schedule-calendar-engine.js');

const monthDays = Array.from({ length: 31 }, (_, index) =>
  '2026-10-' + String(index + 1).padStart(2, '0'));

function roster(stationId, count) {
  return Array.from({ length: count }, (_, index) => ({
    id: stationId + '-person-' + String(index).padStart(4, '0'),
    station_id: stationId,
    sub_station: 'main',
    active: true,
    roles: ['firefighter'],
    source_snapshot: stationId + '-snapshot',
    source_version: 'capacity-v1',
    contract_station_id: stationId,
    source_revision: 'capacity-r1',
    source_digest: stationId + '-source-digest',
    source_complete: true
  }));
}

function runStation(stationId, people, minimum) {
  const engine = createCalendarEngine({
    clock: () => '2026-10-01T00:00:00.000Z',
    policy: {
      station_id: stationId,
      version: 'capacity-v1',
      digest: stationId + '-policy-digest',
      sub_stations: {
        main: {
          label: 'תחנת עומס סינתטית',
          minimum,
          requirements: [{ role: 'firefighter', label: 'כבאי', count: minimum, required: true }]
        }
      },
      rest: { min_gap_days: 0 },
      rotation: null,
      max_shifts_per_month: null
    }
  });
  const started = performance.now();
  const result = engine.planPeriod({
    station_id: stationId,
    source_snapshot: stationId + '-snapshot',
    source_version: 'capacity-v1',
    contract_station_id: stationId,
    source_revision: 'capacity-r1',
    source_digest: stationId + '-source-digest',
    policy_digest: stationId + '-policy-digest',
    source_complete: true,
    availability: {}, locked: {}, carry: {}, days: monthDays,
    roster: roster(stationId, people)
  });
  return { elapsed_ms: performance.now() - started, result };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

const organizationStarted = performance.now();
const stationRuns = Array.from({ length: 30 }, (_, index) =>
  runStation('capacity-station-' + String(index + 1).padStart(2, '0'), 100, 25));
const organizationElapsed = performance.now() - organizationStarted;
const latencies = stationRuns.map((run) => run.elapsed_ms);

assert.equal(stationRuns.length * 100, 3000);
assert.equal(stationRuns.reduce((sum, run) => sum + run.result.summary.filled, 0), 30 * 31 * 25);
assert.equal(stationRuns.reduce((sum, run) => sum + run.result.summary.blocking_gaps, 0), 0);
assert.ok(organizationElapsed < 20_000,
  '3,000-user organization exceeded the 20-second local budget: ' + organizationElapsed + 'ms');

// One large tenant is measured separately so partitioning cannot hide a
// station-specific algorithmic cliff.
const largeTenant = runStation('capacity-large-tenant', 3000, 300);
assert.equal(largeTenant.result.summary.filled, 31 * 300);
assert.equal(largeTenant.result.summary.blocking_gaps, 0);
assert.ok(largeTenant.elapsed_ms < 20_000,
  'single 3,000-user tenant exceeded the 20-second local budget');

const observedRssMb = process.memoryUsage().rss / 1048576;
assert.ok(observedRssMb < 768,
  'calendar benchmark observed RSS above 768MB after both workloads: ' + observedRssMb + 'MB');

const report = Object.freeze({
  synthetic_users: 3000,
  stations: 30,
  days: 31,
  filled_assignments: 30 * 31 * 25,
  organization_ms: Math.round(organizationElapsed),
  station_p50_ms: Math.round(percentile(latencies, 0.50)),
  station_p95_ms: Math.round(percentile(latencies, 0.95)),
  station_p99_ms: Math.round(percentile(latencies, 0.99)),
  large_tenant_ms: Math.round(largeTenant.elapsed_ms),
  observed_rss_after_workloads_mb: Math.round(observedRssMb),
  scope: 'pure_calendar_solver_only'
});
console.log('Synthetic calendar solver benchmark PASS ' + JSON.stringify(report));
