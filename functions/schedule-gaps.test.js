'use strict';

/* schedule-gaps.test · 42H.2 חבילה ג׳ — המודול הטהור. שמות מומצאים. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const gaps = require('./schedule-gaps');

const hash = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

const catalog = [
  { key: 'shift_lead', label: 'ראש משמרת', critical: true, active: true, minimum: 1 },
  { key: 'deputy', label: 'סגן', critical: true, active: true, minimum: 0 },
  { key: 'driver', label: 'נהגים', critical: false, active: true, minimum: 2 },
  { key: 'monitoring', label: 'ניטור', critical: false, active: false, minimum: 5 }
];
const policy = { sub_stations: { eilat: { label: 'אילת', minimum: 3 }, shahmon: { label: 'שחמון', minimum: 0 } } };
const people = [
  { id: 'u1', full_name: 'רועי כהן', active: true }, { id: 'u2', full_name: 'דניאל לוי', active: true },
  { id: 'u3', full_name: 'יוסי מזרחי', active: true }, { id: 'u4', full_name: 'עמית פרץ', active: true },
  { id: 'u5', full_name: 'גיא ברק', active: true }, { id: 'u9', full_name: 'עזב', active: false }
];
const holdings = { u1: ['shift_lead', 'driver'], u2: ['driver'], u3: ['deputy'], u4: ['driver'], u5: ['shift_lead'], u9: ['shift_lead', 'driver'] };
function row(date, sub, uids, extra) {
  return Object.assign({ date, sub_station: sub, label: policy.sub_stations[sub].label, minimum: policy.sub_stations[sub].minimum, slots: uids.map((person) => ({ person })), coverage: 'ready' }, extra || {});
}
const plan = {
  station_id: 'st', rows: [
    row('2026-09-01', 'eilat', ['u1', 'u2', 'u3']), row('2026-09-01', 'shahmon', ['u4']),
    row('2026-09-02', 'eilat', ['u2', 'u3']), row('2026-09-02', 'shahmon', [], { coverage: 'missing' })
  ],
  absences: [{ date: '2026-09-02', uid: 'u5', kind: 'sick' }]
};

test('per day: station total vs station minimum, sub-station vs policy line, qualification vs catalog minimum', () => {
  const out = gaps.analyzeGaps({ plan, policy, catalog, holdings, people, station_minimum: 4, hash });
  assert.equal(out.days.length, 2);
  const d1 = out.days[0];
  assert.deepEqual([d1.total, d1.station_minimum, d1.station_gap], [4, 4, 0]);
  assert.deepEqual(d1.sub_stations.map((s) => s.sub_station + ':' + s.people + '/' + s.minimum + ':' + s.gap), ['eilat:3/3:0', 'shahmon:1/0:0']);
  assert.deepEqual(d1.qualifications.map((q) => q.key + ':' + q.present + '/' + q.minimum + ':' + q.gap), ['shift_lead:1/1:0', 'deputy:1/0:0', 'driver:3/2:0']);
  assert.equal(d1.has_gap, false);
  const d2 = out.days[1];
  assert.deepEqual([d2.total, d2.station_gap], [2, 2]);
  assert.deepEqual(d2.sub_stations.map((s) => s.sub_station + ':' + s.gap + ':' + s.coverage), ['eilat:1:ready', 'shahmon:0:missing'], 'a missing (unknown) station row is not a gap');
  assert.deepEqual(d2.qualifications.map((q) => q.key + ':' + q.gap), ['shift_lead:1', 'deputy:0', 'driver:1']);
  assert.equal(d2.has_critical_gap, true);
});

test('inactive catalog entries are ignored; minimum 0 never gaps', () => {
  const out = gaps.analyzeGaps({ plan, policy, catalog, holdings, people, station_minimum: 0, hash });
  assert.equal(out.days[0].qualifications.some((q) => q.key === 'monitoring'), false);
  assert.equal(out.days[0].station_gap, 0);
  assert.equal(out.summary.station_minimum, 0);
});

test('candidates only: free (not assigned, not absent), active, holding the qualification; never assigned by the module', () => {
  const before = JSON.stringify(plan);
  const out = gaps.analyzeGaps({ plan, policy, catalog, holdings, people, station_minimum: 4, hash });
  assert.equal(JSON.stringify(plan), before, 'plan mutated');
  const d2 = out.days[1];
  const lead = d2.qualifications.find((q) => q.key === 'shift_lead');
  // u1 חופשי ומחזיק; u5 חולה; u9 לא פעיל.
  assert.deepEqual(lead.candidates.map((c) => c.uid), ['u1']);
  const driver = d2.qualifications.find((q) => q.key === 'driver');
  assert.deepEqual(driver.candidates.map((c) => c.uid).sort(), ['u1', 'u4']);
  assert.deepEqual(d2.station_candidates.map((c) => c.uid).sort(), ['u1', 'u4']);
  assert.ok(lead.candidates.every((c) => typeof c.name === 'string'));
  assert.deepEqual(out.days[0].qualifications.find((q) => q.key === 'driver').candidates, [], 'no gap → no candidates');
});

test('critical gaps block; the rest are acknowledgeable with a digest bound to the exact list', () => {
  const out = gaps.analyzeGaps({ plan, policy, catalog, holdings, people, station_minimum: 4, hash });
  assert.deepEqual(out.blocking, [{ kind: 'qualification', date: '2026-09-02', key: 'shift_lead', label: 'ראש משמרת', minimum: 1, present: 0, gap: 1 }]);
  assert.deepEqual(out.acknowledgeable.map((g) => g.kind + ':' + g.date + ':' + (g.key || '') + ':' + g.gap), ['qualification:2026-09-02:driver:1', 'station:2026-09-02::2', 'sub_station:2026-09-02:eilat:1']);
  assert.deepEqual([out.summary.critical_gaps, out.summary.other_gaps, out.summary.days_with_gaps], [1, 3, 1]);
  assert.equal(typeof out.digest, 'string');
  assert.equal(gaps.acknowledgementValid(out, out.digest), true);
  assert.equal(gaps.acknowledgementValid(out, 'nope'), false);
  assert.equal(gaps.acknowledgementValid(out, ''), false);
  // שינוי בפער אחד משנה את החתימה.
  const other = gaps.analyzeGaps({ plan, policy, catalog, holdings, people, station_minimum: 5, hash });
  assert.notEqual(other.digest, out.digest);
  // בלי פערים לאישור — אין חתימה ואישור ריק תקף.
  const clean = gaps.analyzeGaps({ plan: { station_id: 'st', rows: [plan.rows[0], plan.rows[1]], absences: [] }, policy, catalog, holdings, people, station_minimum: 4, hash });
  assert.deepEqual([clean.digest, clean.acknowledgeable.length, clean.blocking.length], [null, 0, 0]);
  assert.equal(gaps.acknowledgementValid(clean, ''), true);
});

test('holdings may come as a Map of arrays or objects; input validation', () => {
  const map = new Map([['u1', ['shift_lead']], ['u2', { qualifications: ['driver'] }]]);
  const out = gaps.analyzeGaps({ plan, policy, catalog, holdings: map, people, station_minimum: 0, hash });
  assert.equal(out.days[0].qualifications.find((q) => q.key === 'shift_lead').present, 1);
  assert.throws(() => gaps.analyzeGaps({ plan: null, hash }), (e) => e.code === 'gaps-plan');
  assert.throws(() => gaps.analyzeGaps({ plan }), (e) => e.code === 'gaps-hash');
});

console.log('\n' + passed + ' schedule-gaps unit checks passed.');
