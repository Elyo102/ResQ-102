'use strict';
/* schedule-replicate · בדיקות עוינות למחולל „שכפל ציוות לכל המשמרות החודש".
 * מודול טהור — בלי Firebase. Claude, 1.10.2026. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rep = require('./schedule-replicate');
const edit = require('./schedule-edit');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }
const clone = (v) => JSON.parse(JSON.stringify(v));

/* רוטציה של 4 קבוצות, יום לכל קבוצה, עוגן 1.10.2026 = A.
 * ימי A באוקטובר: 1, 5, 9, 13, 17, 21, 25, 29. */
const POLICY = {
  sub_stations: {
    rashit: { label: 'ראשית', minimum: 2, requirements: [{ role: 'driver', label: 'נהג' }, { role: 'ff', label: 'לוחם' }] },
    timna: { label: 'תמנע', minimum: 1, requirements: [{ role: 'ff', label: 'לוחם' }] }
  },
  rotation: { strict: true, groups: ['A', 'B', 'C', 'D'], anchor: '2026-10-01', days_per_group: 1 }
};
const A_DAYS = ['2026-10-05', '2026-10-09', '2026-10-13', '2026-10-17', '2026-10-21', '2026-10-25', '2026-10-29'];
const person = (id, sub, roles, group = 'A') => ({ id, full_name: 'שם ' + id, sub_station: sub, roles, group, active: true });
const PEOPLE = [person('p1', 'rashit', ['driver', 'ff']), person('p2', 'rashit', ['ff']), person('p3', 'rashit', ['ff']),
  person('p4', 'rashit', ['ff']), person('p6', 'timna', ['ff'])];
const row = (date, sub, slots) => ({ date, station_id: 'eilat_102', sub_station: sub, label: sub, rotation_group: null,
  minimum: 0, slots, gaps: [], rejected_manual: [], coverage: 'ready', below_minimum: false, complete: true });
const slot = (person, role, source = 'auto') => ({ person, role, label: role, source });
function basePlan(extraRows = [], absences = []) {
  return { station_id: 'eilat_102', from: '2026-10-01', to: '2026-10-31',
    rows: [row('2026-10-01', 'rashit', [slot('p1', 'driver', 'manual'), slot('p2', 'ff', 'manual')])].concat(extraRows),
    absences };
}
const input = (over = {}) => Object.assign({ plan: basePlan(), policy: POLICY, people: PEOPLE, station_id: 'eilat_102',
  source: { date: '2026-10-01', sub_station: 'rashit' }, month: '2026-10', not_before: '2026-10-01' }, over);
const apply = (inp, out) => edit.applyEdits({ plan: inp.plan, edits: out.edits, people: inp.people, policy: inp.policy, station_id: 'eilat_102' });
const crew = (plan, date, sub) => (plan.rows.find((r) => r.date === date && r.sub_station === sub) || { slots: [] })
  .slots.map((s) => s.person + ':' + s.role).sort();
const codeIs = (code) => (e) => { assert.equal(e.code, code, e.message); return true; };

test('copies the crew to every same-rotation day of the month at the same sub-station, roles kept', () => {
  const inp = input(), out = rep.planReplication(inp);
  assert.deepEqual(out.target_dates, A_DAYS);
  assert.deepEqual(out.edits, [
    { kind: 'assign', uid: 'p1', dates: A_DAYS, sub_station: 'rashit', role: 'driver' },
    { kind: 'assign', uid: 'p2', dates: A_DAYS, sub_station: 'rashit', role: 'ff' }]);
  assert.equal(out.preview.changes, 14);
  const after = apply(inp, out).plan;
  for (const d of A_DAYS) assert.deepEqual(crew(after, d, 'rashit'), ['p1:driver', 'p2:ff']);
  assert.deepEqual(crew(after, '2026-10-02', 'rashit'), [], 'another rotation group is untouched');
});

test('never writes into the past: days before not_before are reported, not edited', () => {
  const out = rep.planReplication(input({ not_before: '2026-10-15' }));
  assert.deepEqual(out.target_dates, ['2026-10-17', '2026-10-21', '2026-10-25', '2026-10-29']);
  assert.deepEqual(out.skipped_dates.filter((s) => s.reason === 'past').map((s) => s.date), ['2026-10-05', '2026-10-09', '2026-10-13']);
});

test('default mode skips a day that already has a manual assignment; override replaces it', () => {
  const plan = basePlan([row('2026-10-09', 'rashit', [slot('p3', 'ff', 'manual')])]);
  const skip = rep.planReplication(input({ plan }));
  assert.deepEqual(skip.skipped_dates, [{ date: '2026-10-09', reason: 'manual-exists' }]);
  assert.equal(skip.target_dates.includes('2026-10-09'), false);
  assert.deepEqual(crew(apply(input({ plan }), skip).plan, '2026-10-09', 'rashit'), ['p3:ff'], 'manual day kept as is');
  const over = rep.planReplication(input({ plan, mode: 'override' }));
  assert.ok(over.edits.some((e) => e.kind === 'unassign' && e.uid === 'p3' && e.dates.includes('2026-10-09')));
  assert.deepEqual(crew(apply(input({ plan }), over).plan, '2026-10-09', 'rashit'), ['p1:driver', 'p2:ff']);
});

test('engine-made (non-manual) slots on a target day are replaced by the template crew', () => {
  const plan = basePlan([row('2026-10-13', 'rashit', [slot('p4', 'ff', 'auto')])]);
  const inp = input({ plan }), out = rep.planReplication(inp);
  assert.ok(out.edits.some((e) => e.kind === 'unassign' && e.uid === 'p4' && e.dates.join() === '2026-10-13'));
  assert.deepEqual(crew(apply(inp, out).plan, '2026-10-13', 'rashit'), ['p1:driver', 'p2:ff']);
});

test('an absent person is not placed; the day is reported as a gap', () => {
  const plan = basePlan([], [{ date: '2026-10-21', uid: 'p2', kind: 'sick' }]);
  const inp = input({ plan }), out = rep.planReplication(inp);
  assert.deepEqual(out.skipped_people, [{ uid: 'p2', date: '2026-10-21', reason: 'absent' }]);
  assert.deepEqual(out.gaps, [{ date: '2026-10-21', sub_station: 'rashit', expected: 2, placed: 1 }]);
  assert.equal(out.edits.find((e) => e.uid === 'p2').dates.includes('2026-10-21'), false);
  assert.deepEqual(crew(apply(inp, out).plan, '2026-10-21', 'rashit'), ['p1:driver']);
});

test('a person already posted elsewhere that day is not pulled away from the other sub-station', () => {
  const plan = basePlan([row('2026-10-25', 'timna', [slot('p1', 'ff', 'manual')])]);
  const inp = input({ plan }), out = rep.planReplication(inp);
  assert.deepEqual(out.skipped_people, [{ uid: 'p1', date: '2026-10-25', reason: 'assigned-elsewhere' }]);
  const after = apply(inp, out).plan;
  assert.deepEqual(crew(after, '2026-10-25', 'timna'), ['p1:ff']);
  assert.deepEqual(crew(after, '2026-10-25', 'rashit'), ['p2:ff']);
});

test('skipped template people already on target rows are removed consistently with gap reports', () => {
  for (const mode of ['skip_manual', 'override']) {
    for (const reason of ['absent', 'not-in-source']) {
      const plan = basePlan([row('2026-10-21', 'rashit', [slot('p2', 'ff', mode === 'override' ? 'manual' : 'auto')])],
        reason === 'absent' ? [{ date: '2026-10-21', uid: 'p2', kind: 'sick' }] : []);
      const inp = input({ plan, mode, people: reason === 'not-in-source' ? PEOPLE.filter(p => p.id !== 'p2') : PEOPLE });
      const out = rep.planReplication(inp);
      assert.ok(out.skipped_people.some(p => p.uid === 'p2' && p.date === '2026-10-21' && p.reason === reason));
      assert.deepEqual(crew(apply(inp, out).plan, '2026-10-21', 'rashit'), ['p1:driver']);
    }
  }
});

test('a template person who left the active source is skipped instead of failing the whole edit', () => {
  const people = PEOPLE.filter((p) => p.id !== 'p2');
  const out = rep.planReplication(input({ people }));
  assert.equal(out.skipped_people.filter((s) => s.uid === 'p2' && s.reason === 'not-in-source').length, A_DAYS.length);
  assert.equal(out.edits.some((e) => e.uid === 'p2'), false);
});

test('the change count is the real one from applyEdits, not people x days', () => {
  const plan = basePlan([row('2026-10-05', 'rashit', [slot('p1', 'driver', 'auto'), slot('p2', 'ff', 'auto')])]);
  const out = rep.planReplication(input({ plan }));
  assert.equal(out.preview.changes, 12, 'the day that already matches is not a change');
  const removals = rep.planReplication(input({ plan: basePlan([row('2026-10-05', 'rashit', [slot('p3', 'ff'), slot('p4', 'ff')])]) }));
  assert.equal(removals.preview.changes, 16, 'removals count too');
});

test('over the ceiling: refused as a whole with the real count — never split silently', () => {
  assert.throws(() => rep.planReplication(input({ max_changes: 13 })), (e) => {
    assert.equal(e.code, 'replicate-too-many-changes'); assert.deepEqual(e.detail, { changes: 14, max: 13 }); return true;
  });
  assert.equal(rep.planReplication(input({ max_changes: 14 })).preview.changes, 14);
});

test('running it again is a no-op (skip mode skips everything; override changes nothing)', () => {
  const inp = input(), first = rep.planReplication(inp), plan = apply(inp, first).plan;
  const again = rep.planReplication(input({ plan }));
  assert.equal(again.edits.length, 0); assert.equal(again.skipped_dates.length, A_DAYS.length);
  const over = rep.planReplication(input({ plan, mode: 'override' }));
  assert.equal(over.preview.changes, 0);
});

test('days outside the active publication are reported, not edited', () => {
  const plan = Object.assign(basePlan(), { to: '2026-10-20' });
  const out = rep.planReplication(input({ plan }));
  assert.deepEqual(out.target_dates, ['2026-10-05', '2026-10-09', '2026-10-13', '2026-10-17']);
  assert.deepEqual(out.skipped_dates.map((s) => s.reason), ['outside-publication', 'outside-publication', 'outside-publication']);
});

test('input plan is never mutated', () => {
  const inp = input({ plan: basePlan([row('2026-10-13', 'rashit', [slot('p4', 'ff')])]) }), before = clone(inp);
  rep.planReplication(inp); rep.planReplication(Object.assign({}, inp, { mode: 'override' }));
  assert.deepEqual(inp, before);
});

test('refusals: no rotation, empty source, wrong month, unknown sub-station, bad mode, missing today', () => {
  assert.throws(() => rep.planReplication(input({ policy: Object.assign({}, POLICY, { rotation: null }) })), codeIs('replicate-no-rotation'));
  assert.throws(() => rep.planReplication(input({ policy: Object.assign({}, POLICY, { rotation: Object.assign({}, POLICY.rotation, { strict: false }) }) })), codeIs('replicate-no-rotation'));
  assert.throws(() => rep.planReplication(input({ source: { date: '2026-10-02', sub_station: 'rashit' } })), codeIs('replicate-source-empty'));
  assert.throws(() => rep.planReplication(input({ month: '2026-11' })), codeIs('replicate-source-month'));
  assert.throws(() => rep.planReplication(input({ source: { date: '2026-10-01', sub_station: 'constructor' } })), codeIs('replicate-sub-station'));
  assert.throws(() => rep.planReplication(input({ mode: 'force' })), codeIs('replicate-mode'));
  assert.throws(() => rep.planReplication(input({ not_before: undefined })), codeIs('replicate-today'));
  assert.throws(() => rep.planReplication(input({ month: '2026-13' })), codeIs('replicate-month'));
});

test('every generated edit passes the real normalizeEdits (same validation as the server)', () => {
  const inp = input({ plan: basePlan([row('2026-10-13', 'rashit', [slot('p4', 'ff')])], [{ date: '2026-10-21', uid: 'p2', kind: 'sick' }]) });
  const out = rep.planReplication(inp);
  assert.doesNotThrow(() => edit.normalizeEdits(out.edits, { from: inp.plan.from, to: inp.plan.to }));
});

test('a source row whose slots name nobody is refused — it must never mass-unassign the target days', () => {
  const plan = basePlan([row('2026-10-05', 'rashit', [slot('p3', 'ff'), slot('p4', 'ff')])]);
  plan.rows[0].slots = [{ role: 'ff' }, { role: 'driver', person: '' }];
  assert.throws(() => rep.planReplication(input({ plan })), codeIs('replicate-source-empty'));
});

test('the 400 ceiling holds by default and cannot be raised by the caller', () => {
  const many = Array.from({ length: 14 }, (_, i) => person('m' + i, 'rashit', ['ff']));
  const daily = Object.assign({}, POLICY, { rotation: { strict: true, groups: ['A'], anchor: '2026-10-01', days_per_group: 1 } });
  const plan = { station_id: 'eilat_102', from: '2026-10-01', to: '2026-10-31', absences: [],
    rows: [row('2026-10-01', 'rashit', many.map((p) => slot(p.id, 'ff', 'manual')))] };
  const inp = input({ plan, policy: daily, people: many });
  assert.throws(() => rep.planReplication(inp), (e) => { assert.equal(e.code, 'replicate-too-many-changes'); assert.deepEqual(e.detail, { changes: 420, max: 400 }); return true; });
  assert.throws(() => rep.planReplication(Object.assign({}, inp, { max_changes: 5000 })), codeIs('replicate-too-many-changes'));
});

test('a role no longer in the policy skips that person with a reason, instead of failing in another module', () => {
  const plan = basePlan(); plan.rows[0].slots.push(slot('p3', 'medic', 'manual'));
  const out = rep.planReplication(input({ plan }));
  assert.equal(out.skipped_people.filter((s) => s.uid === 'p3' && s.reason === 'role-not-in-policy').length, A_DAYS.length);
  assert.equal(out.edits.some((e) => e.uid === 'p3'), false);
});

test('an engine slot that already matches is left untouched (not silently rewritten as manual)', () => {
  const plan = basePlan([row('2026-10-05', 'rashit', [slot('p1', 'driver', 'auto'), slot('p2', 'ff', 'auto')])]);
  const inp = input({ plan }), out = rep.planReplication(inp);
  assert.equal(out.edits.some((e) => e.dates.includes('2026-10-05')), false);
  const day = apply(inp, out).plan.rows.find((r) => r.date === '2026-10-05');
  assert.deepEqual(day.slots.map((s) => s.source), ['auto', 'auto']);
});

test('sync: ceiling equals the runtime constant, rotation formula equals schedule-edit', () => {
  const runtime = fs.readFileSync(path.join(__dirname, 'schedule-runtime.js'), 'utf8');
  assert.match(runtime, /const MAX_EDIT_REPORT_CHANGES = 400;/);
  assert.equal(rep.MAX_CHANGES, 400);
  const src = fs.readFileSync(path.join(__dirname, 'schedule-edit.js'), 'utf8');
  const body = src.slice(src.indexOf('function rotationGroup('), src.indexOf('function manualWarningCodes('));
  const plainFn = 'const DATE_RE = /^\\d{4}-\\d{2}-\\d{2}$/; function plain(v) { return !!v && typeof v === "object" && !Array.isArray(v); }';
  const helpers = plainFn + src.slice(src.indexOf('function dayNumber('), src.indexOf('function rotationGroup('))
    + src.slice(src.indexOf('function validIsoDate('), src.indexOf('/* ---------- ולידציה'));
  const theirs = new Function(helpers + body + 'return rotationGroup;')();
  const policies = [POLICY.rotation, { strict: true, groups: ['A', 'B', 'C'], anchor: '2025-12-31', days_per_group: 2 }];
  for (const rotation of policies) {
    for (let d = 0; d < 400; d += 1) {
      const date = new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10);
      assert.equal(rep.rotationGroup({ rotation }, date), theirs({ rotation }, date), date);
    }
  }
});

console.log('\nschedule-replicate: ' + passed + ' checks passed.');
