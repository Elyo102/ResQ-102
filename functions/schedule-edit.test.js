'use strict';

/* schedule-edit.test · 42H.2 חבילה א׳ — המודול הטהור. שמות מומצאים בלבד. */

const assert = require('node:assert/strict');
const edit = require('./schedule-edit');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }
function throwsCode(fn, code) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, 'expected ' + code);
  assert.equal(error.code, code, error.message);
}

const SID = 'station_t';
const policy = {
  sub_stations: {
    eilat: { label: 'אילת', minimum: 2, requirements: [{ role: 'ff', label: 'לוחם', count: 2, required: true }, { role: 'driver', label: 'נהג', count: 1, required: false }] },
    shahmon: { label: 'שחמון', minimum: 0, requirements: [{ role: 'ff', count: 1, required: false }] }
  }
};
const people = [
  { id: 'u1', full_name: 'רועי כהן', sub_station: 'eilat', roles: ['ff'], active: true },
  { id: 'u2', full_name: 'דניאל לוי', sub_station: 'eilat', roles: ['ff', 'driver'], active: true },
  { id: 'u3', full_name: 'יוסי מזרחי', sub_station: 'shahmon', roles: ['ff'], active: true },
  { id: 'u9', full_name: 'ליאור נחום', sub_station: 'eilat', roles: ['ff'], active: false }
];
function row(date, sub, slots, extra) {
  return Object.assign({
    date, station_id: SID, sub_station: sub, label: policy.sub_stations[sub].label, rotation_group: null,
    minimum: policy.sub_stations[sub].minimum, slots, gaps: [], rejected_manual: [], coverage: 'ready',
    below_minimum: false, complete: true
  }, extra || {});
}
function basePlan() {
  return {
    kind: 'schedule-plan', station_id: SID, from: '2026-09-01', to: '2026-09-03',
    rows: [
      row('2026-09-01', 'eilat', [{ person: 'u1', role: 'ff', label: 'לוחם', source: 'imported' }, { person: 'u2', role: null, label: null, source: 'imported' }]),
      row('2026-09-01', 'shahmon', [{ person: 'u3', role: null, label: null, source: 'imported' }]),
      row('2026-09-02', 'eilat', [{ person: 'u1', role: null, label: null, source: 'imported' }]),
      row('2026-09-02', 'shahmon', [], { coverage: 'missing' }),
      row('2026-09-03', 'eilat', [{ person: 'u9', role: null, label: null, source: 'imported' }])
    ],
    absences: [{ date: '2026-09-02', uid: 'u3', kind: 'sick' }],
    absence_coverage: { sick: 'ready', reserve: 'missing', course: 'ready', leave: 'ready' },
    summary: { filled: 5, blocking_gaps: 0, days_below_minimum: 0, rejected_manual: 0, open_rows: 0 }
  };
}
const frozen = JSON.stringify(basePlan());

test('assign moves a person within the day and never duplicates', () => {
  const plan = basePlan();
  const out = edit.applyEdits({ plan, people, policy, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-09-01'], sub_station: 'shahmon' }] });
  assert.equal(JSON.stringify(plan), frozen, 'the input plan was mutated');
  const day = out.plan.rows.filter((r) => r.date === '2026-09-01');
  assert.deepEqual(day.map((r) => r.sub_station + ':' + r.slots.map((s) => s.person).join(',')), ['eilat:u2', 'shahmon:u3,u1']);
  assert.equal(day[1].slots[1].source, 'edited');
  assert.deepEqual(out.changes, [{ uid: 'u1', date: '2026-09-01', before: { sub_station: 'eilat', role: 'ff', absence: null }, after: { sub_station: 'shahmon', role: null, absence: null } }]);
  assert.deepEqual(out.people_changed, ['u1']);
  assert.equal(day[0].below_minimum, true, 'eilat dropped below its line — shown, not blocking');
  assert.deepEqual([out.plan.summary.blocking_gaps, out.plan.summary.days_below_minimum, out.plan.summary.rejected_manual], [0, 0, 0]);
  assert.equal(out.plan.edited, true);
});

test('a week: assign over several dates creates rows and marks a missing station row as ready', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u2', dates: ['2026-09-02', '2026-09-03', '2026-09-02'], sub_station: 'shahmon', role: 'ff' }] });
  const r2 = out.plan.rows.find((r) => r.date === '2026-09-02' && r.sub_station === 'shahmon');
  const r3 = out.plan.rows.find((r) => r.date === '2026-09-03' && r.sub_station === 'shahmon');
  assert.equal(r2.coverage, 'ready');
  assert.deepEqual(r2.slots, [{ person: 'u2', role: 'ff', label: 'ff', source: 'edited' }]);
  assert.ok(r3 && r3.slots.length === 1 && r3.label === 'שחמון' && r3.complete === true);
  assert.equal(out.changes.length, 2, 'duplicate date collapsed');
  assert.equal(out.counts.dates, 2);
});

test('unassign removes; unknown removal is a warning, not a change', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01', '2026-09-03'] }] });
  assert.equal(out.plan.rows.find((r) => r.date === '2026-09-01' && r.sub_station === 'eilat').slots.length, 1);
  assert.deepEqual(out.warnings, [{ code: 'not-assigned', uid: 'u1', date: '2026-09-03' }]);
  assert.equal(out.changes.length, 1);
  assert.equal(out.counts.no_ops, 1);
});

test('a person who left the source can still be removed, but not added', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'unassign', uid: 'u9', dates: ['2026-09-03'] }] });
  assert.equal(out.plan.rows.find((r) => r.date === '2026-09-03').slots.length, 0);
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u9', dates: ['2026-09-01'], sub_station: 'eilat' }] }), 'edit-person-unknown');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'nobody', dates: ['2026-09-01'], sub_station: 'eilat' }] }), 'edit-person-unknown');
});

test('role: label from the policy; refusing a role for someone not assigned', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'role', uid: 'u2', dates: ['2026-09-01'], role: 'driver' }] });
  const slot = out.plan.rows[0].slots.find((s) => s.person === 'u2');
  assert.deepEqual([slot.role, slot.label, slot.source], ['driver', 'נהג', 'edited']);
  assert.deepEqual(out.changes[0].after, { sub_station: 'eilat', role: 'driver', absence: null });
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'role', uid: 'u3', dates: ['2026-09-02'], role: 'ff' }] }), 'edit-role-not-assigned');
});

test('absence: set, replace, clear; location only with leave; coverage becomes ready', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [
    { kind: 'absence', uid: 'u3', dates: ['2026-09-02'], absence: { kind: 'leave', location: 'north' } },
    { kind: 'absence', uid: 'u1', dates: ['2026-09-03'], absence: { kind: 'reserve' } },
    { kind: 'absence', uid: 'u2', dates: ['2026-09-01'], absence: null }
  ] });
  assert.deepEqual(out.plan.absences, [
    { date: '2026-09-02', uid: 'u3', kind: 'leave', location: 'north' },
    { date: '2026-09-03', uid: 'u1', kind: 'reserve' }
  ]);
  assert.equal(out.plan.absence_coverage.reserve, 'ready');
  assert.equal(out.changes.length, 2, 'clearing a non-existent absence is not a change');
  assert.deepEqual(out.changes.find((c) => c.uid === 'u3').before.absence, { kind: 'sick' });
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'absence', uid: 'u1', dates: ['2026-09-01'], absence: { kind: 'sick', location: 'north' } }] }), 'edit-absence');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'absence', uid: 'u1', dates: ['2026-09-01'] }] }), 'edit-absence');
});

test('assigning an absent person or marking an assigned person absent warns, does not block', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [
    { kind: 'assign', uid: 'u3', dates: ['2026-09-02'], sub_station: 'eilat' },
    { kind: 'absence', uid: 'u1', dates: ['2026-09-01'], absence: { kind: 'course' } }
  ] });
  assert.deepEqual(out.warnings.map((w) => w.code), ['assigned-while-absent', 'absent-while-assigned']);
});

test('validation: dates outside the publication, unknown station, bad kinds and limits', () => {
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-10-01'], sub_station: 'eilat' }] }), 'edit-date-outside');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-09-01'], sub_station: 'timna' }] }), 'edit-sub-station-unknown');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'swap', uid: 'u1', dates: ['2026-09-01'] }] }), 'edit-kind');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [] }), 'edits-required');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'unassign', uid: 'u1', dates: [] }] }), 'edit-dates');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'unassign', uid: 'u1', dates: Array.from({ length: 63 }, (_, i) => '2026-09-01') }] }), 'edit-dates');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy: null, edits: [{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] }] }), 'policy-required');
  throwsCode(() => edit.normalizeEdits(Array.from({ length: edit.MAX_EDITS + 1 }, () => ({ kind: 'unassign', uid: 'u1', dates: ['2026-09-01'] })), { from: '2026-09-01', to: '2026-09-03' }), 'edits-limit');
});

test('no-op edits produce no changes and a stable canonical form', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-09-01'], sub_station: 'eilat', role: 'ff' }] });
  assert.deepEqual(out.changes, []);
  assert.equal(out.counts.no_ops, 1);
  const a = edit.normalizeEdits([{ kind: 'unassign', uid: 'u1', dates: ['2026-09-03', '2026-09-01', '2026-09-01'] }], { from: '2026-09-01', to: '2026-09-03' });
  const b = edit.normalizeEdits([{ kind: 'unassign', uid: 'u1', dates: ['2026-09-01', '2026-09-03'] }], { from: '2026-09-01', to: '2026-09-03' });
  assert.deepEqual(a, b);
});

test('an empty row created by a move that was then undone is dropped; original empty rows stay', () => {
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [
    { kind: 'assign', uid: 'u1', dates: ['2026-09-03'], sub_station: 'shahmon' },
    { kind: 'unassign', uid: 'u1', dates: ['2026-09-03'] }
  ] });
  assert.equal(out.plan.rows.some((r) => r.date === '2026-09-03' && r.sub_station === 'shahmon'), false);
  assert.ok(out.plan.rows.some((r) => r.date === '2026-09-02' && r.sub_station === 'shahmon'), 'original empty row kept');
  assert.equal(out.plan.rows.find((r) => r.date === '2026-09-02' && r.sub_station === 'shahmon').coverage, 'missing');
});

test('searchPeople: prefix on any name part first, then contains; no query = first N', () => {
  const list = [
    { id: 'a', full_name: 'רועי כהן' }, { id: 'b', full_name: 'דניאל רועי' }, { id: 'c', full_name: 'אברהם לוי', employee_number: '77' },
    { id: 'd', full_name: 'שירועי בן' }
  ];
  assert.deepEqual(edit.searchPeople(list, 'רועי').map((p) => p.id), ['a', 'b', 'd']);
  assert.deepEqual(edit.searchPeople(list, '77').map((p) => p.id), ['c']);
  assert.deepEqual(edit.searchPeople(list, '', 2).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(edit.searchPeople(list, 'zzz'), []);
});

/* ---- ביקורת Codex על 0e9a8dc (seq453) ---- */

test('§4 uid is a Firebase UID as-is: e-mail style ids pass, separators and control characters fail', () => {
  const range = { from: '2026-09-01', to: '2026-09-03' };
  const ok = edit.normalizeEdits([{ kind: 'unassign', uid: 'user+shift@example.com', dates: ['2026-09-01'] }], range);
  assert.equal(ok[0].uid, 'user+shift@example.com');
  assert.equal(edit.normalizeEdits([{ kind: 'unassign', uid: 'שם-בעברית', dates: ['2026-09-01'] }], range)[0].uid, 'שם-בעברית');
  ['a/b', '', ' ', 'a b', 'x\ty', 'x'.repeat(129), 42, null].forEach((uid) => {
    throwsCode(() => edit.normalizeEdits([{ kind: 'unassign', uid, dates: ['2026-09-01'] }], range), 'edit-uid');
  });
});

test('§6 role must be one the policy defines for that sub-station (assign and role edits)', () => {
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-09-01'], sub_station: 'shahmon', role: 'driver' }] }), 'edit-role-unknown');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'role', uid: 'u1', dates: ['2026-09-01'], role: 'boss' }] }), 'edit-role-unknown');
  const out = edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-09-01'], sub_station: 'eilat', role: 'driver' }] });
  assert.equal(out.plan.rows.find((r) => r.date === '2026-09-01' && r.sub_station === 'eilat').slots.find((s) => s.person === 'u1').label, 'נהג');
  assert.deepEqual(edit.allowedRoles(policy, 'eilat'), ['ff', 'driver']);
  assert.deepEqual(edit.allowedRoles(policy, 'nowhere'), []);
});

test('§3 sub-station must be an own property of the effective policy (no prototype keys, no foreign keys)', () => {
  ['constructor', '__proto__', 'main', 'toString'].forEach((sub) => {
    throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-09-01'], sub_station: sub }] }), 'edit-sub-station-unknown');
  });
});

test('§5 warnings are capped at MAX_WARNINGS and the rest is counted', () => {
  const dates = [];
  for (let d = 1; d <= 30; d += 1) dates.push('2026-09-' + String(d).padStart(2, '0'));
  const plan = Object.assign(basePlan(), { to: '2026-09-30' });
  const edits = [];
  for (let i = 0; i < edit.MAX_EDITS; i += 1) edits.push({ kind: 'unassign', uid: 'u2', dates });
  const out = edit.applyEdits({ plan, people, policy, edits });
  assert.equal(out.warnings.length, edit.MAX_WARNINGS);
  assert.equal(out.warnings_total, edit.MAX_EDITS * 30 - 1);   // u2 היה משובץ ב-1.9 פעם אחת
  assert.equal(out.warnings_truncated, out.warnings_total - edit.MAX_WARNINGS);
  assert.equal(out.counts.warnings, out.warnings_total);
  assert.ok(JSON.stringify(out.warnings).length < 20000, 'warnings payload must stay small');
});

test('policy changed since the publication: rows are rebased onto the active policy (minimum, labels), unknown sub-stations warned, nothing refused', () => {
  const changed = {
    sub_stations: {
      eilat: { label: 'אילת מרכז', minimum: 3, requirements: [{ role: 'ff', label: 'כבאי', count: 3, required: true }, { role: 'driver', label: 'נהג', count: 1, required: false }] }
      // shahmon הוסרה מהמדיניות
    }
  };
  const out = edit.applyEdits({ plan: basePlan(), people, policy: changed, rebase_policy: true, edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }] });
  const eilat1 = out.plan.rows.find((r) => r.date === '2026-09-01' && r.sub_station === 'eilat');
  assert.deepEqual([eilat1.minimum, eilat1.label, eilat1.slots[0].label, eilat1.below_minimum], [3, 'אילת מרכז', 'כבאי', true]);
  assert.equal(out.policy_rebased, true);
  assert.ok(out.rows_rebased >= 3, String(out.rows_rebased));
  assert.deepEqual(out.warnings.filter((w) => w.code === 'sub-station-not-in-policy').map((w) => w.sub_station), ['shahmon']);
  const shahmon = out.plan.rows.find((r) => r.date === '2026-09-01' && r.sub_station === 'shahmon');
  assert.deepEqual([shahmon.minimum, shahmon.label], [0, 'שחמון'], 'a row whose station left the policy is kept as it was');
  throwsCode(() => edit.applyEdits({ plan: basePlan(), people, policy: changed, rebase_policy: true, edits: [{ kind: 'assign', uid: 'u1', dates: ['2026-09-02'], sub_station: 'shahmon' }] }), 'edit-sub-station-unknown');
  const plainRun = edit.applyEdits({ plan: basePlan(), people, policy: changed, edits: [{ kind: 'unassign', uid: 'u2', dates: ['2026-09-01'] }] });
  assert.equal(plainRun.plan.rows.find((r) => r.date === '2026-09-01' && r.sub_station === 'eilat').minimum, 2, 'without rebase_policy the rows keep their own minimum');
});

test('seq457 §1 a uid containing | (or any separator) keeps its own before/after state — no string keys', () => {
  const weird = 'a|2026-09-01|b';
  const ppl = people.concat([{ id: weird, full_name: 'פלוני', sub_station: 'eilat', roles: ['ff'], active: true }]);
  const plan = basePlan();
  plan.rows[0].slots.push({ person: weird, role: null, label: null, source: 'imported' });
  const out = edit.applyEdits({ plan, people: ppl, policy, edits: [
    { kind: 'assign', uid: weird, dates: ['2026-09-01', '2026-09-02'], sub_station: 'shahmon' },
    { kind: 'absence', uid: weird, dates: ['2026-09-03'], absence: { kind: 'sick' } }
  ] });
  assert.deepEqual(out.changes.map((c) => [c.uid, c.date, c.before.sub_station, c.after.sub_station]), [
    [weird, '2026-09-01', 'eilat', 'shahmon'], [weird, '2026-09-02', null, 'shahmon'], [weird, '2026-09-03', null, null]
  ]);
  assert.deepEqual(out.people_changed, [weird]);
  assert.equal(out.counts.dates, 3);
});

console.log('\n' + passed + ' schedule-edit unit checks passed.');
