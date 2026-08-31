import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { createCalendarEngine } = require('../functions/schedule-calendar-engine.js');

const station = 'load-test-station';
const version = 'load-v1';
const revision = 'load-r17';
const sourceDigest = 'digest-synthetic-load';
const policyDigest = 'policy-digest-load-v1';
const engine = createCalendarEngine({
  clock: () => '2026-09-01T00:00:00.000Z',
  policy: {
    station_id: station,
    version,
    digest: policyDigest,
    sub_stations: {
      main: {
        label: 'תחנת בדיקה',
        minimum: 500,
        requirements: [{ role: 'firefighter', label: 'כבאי', count: 500, required: true }]
      }
    },
    rest: { min_gap_days: 0 },
    rotation: null,
    max_shifts_per_month: null
  }
});

const roster = Array.from({ length: 1000 }, (_, i) => ({
  id: 'synthetic-' + String(i).padStart(4, '0'),
  station_id: station,
  sub_station: 'main',
  active: true,
  roles: ['firefighter'],
  source_snapshot: 'synthetic-load-snapshot',
  source_version: version,
  contract_station_id: station,
  source_revision: revision,
  source_digest: sourceDigest,
  source_complete: true
}));
const days = engine.daysBetween('2026-09-01', '2026-09-30');
const heapBefore = process.memoryUsage().heapUsed;
const started = performance.now();
const result = engine.planPeriod({
  station_id: station,
  source_snapshot: 'synthetic-load-snapshot',
  source_version: version,
  contract_station_id: station,
  source_revision: revision,
  source_digest: sourceDigest,
  policy_digest: policyDigest,
  source_complete: true,
  availability: {},
  locked: {},
  carry: {},
  days,
  roster
});
const elapsed = Math.round(performance.now() - started);
const heapMb = Math.max(0, Math.round((process.memoryUsage().heapUsed - heapBefore) / 1048576));

assert.equal(result.rows.length, 30);
assert.equal(result.summary.filled, 15000);
assert.equal(result.summary.blocking_gaps, 0);
assert.equal(result.summary.days_below_minimum, 0);
assert.ok(elapsed < 15000, 'חריגה מתקציב 15 שניות: ' + elapsed + 'ms');
assert.ok(heapMb < 256, 'חריגה מתקציב זיכרון 256MB: ' + heapMb + 'MB');

console.log('✓ schedule-load-acceptance: 1000 משתמשים · 500 תקנים · חודש · 15000 שיבוצים · '
  + elapsed + 'ms · ' + heapMb + 'MB');

const boundaryRoster = Array.from({ length: 5000 }, (_, i) => ({
  id: 'boundary-' + String(i).padStart(4, '0'),
  station_id: station,
  sub_station: 'main',
  active: true,
  roles: ['firefighter'],
  source_snapshot: 'synthetic-boundary-snapshot',
  source_version: version,
  contract_station_id: station,
  source_revision: 'boundary-r17',
  source_digest: 'digest-synthetic-boundary',
  source_complete: true
}));
assert.throws(() => engine.planPeriod({
  station_id: station,
  source_snapshot: 'synthetic-boundary-snapshot',
  source_version: version,
  contract_station_id: station,
  source_revision: 'boundary-r17',
  source_digest: 'digest-synthetic-boundary',
  policy_digest: policyDigest,
  source_complete: true,
  availability: {},
  locked: {},
  carry: {},
  days: engine.daysBetween('2026-09-01', '2026-11-30'),
  roster: boundaryRoster
}), (error) => error && error.code === 'candidate-edges-too-many');
console.log('✓ schedule-load-boundary: 5000 משתמשים · 500 תקנים · 3 חודשים נחסם מראש ללא תוצאה חלקית');
