'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const engine = require('./attendance-shadow');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS', name);
  } catch (error) {
    failures.push({ name: name, error: error });
    console.error('FAIL', name);
    console.error(error && error.stack ? error.stack : error);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseRotations() {
  const common = {
    anchor_date: '2026-09-01',
    cycle_days: 3,
    shift_start: '07:00',
    shift_end: '07:00',
    shift_hours: 24,
    commander_start: '06:45',
    commander_shift_hours: 24.25,
    special_end: '08:00',
    special_shift_hours: 25,
    is_active: true
  };
  return [
    Object.assign({ id: 'rotation-a', crew: 'A', position_in_cycle: 0 }, common),
    Object.assign({ id: 'rotation-b', crew: 'B', position_in_cycle: 1 }, common),
    Object.assign({ id: 'rotation-c', crew: 'C', position_in_cycle: 2 }, common)
  ];
}

function baseInput(date) {
  return {
    date: date || '2026-09-01',
    stationId: 'station-102',
    rotations: baseRotations(),
    overrides: [],
    swaps: [],
    users: [
      { id: 'uA', full_name: 'Alpha Person', employee_number: '100',
        crew: 'A', role: 'firefighter', is_active: true },
      { id: 'uB', full_name: 'Bravo Person', employee_number: '200',
        crew: 'B', role: 'team_leader', is_active: true },
      { id: 'uC', full_name: 'Charlie Person', employee_number: '300',
        crew: 'C', role: 'commander', is_active: true },
      { id: 'uD', full_name: 'Delta Person', employee_number: '400',
        crew: 'A', role: 'deputy_team_leader', is_active: true },
      { id: 'inactive', full_name: 'Inactive Person', employee_number: '999',
        crew: 'A', role: 'firefighter', is_active: false }
    ],
    roster: [
      { id: 'uA', full_name: 'Alpha Person', crew: 'A', role: 'firefighter', is_active: true },
      { id: 'uB', full_name: 'Bravo Person', crew: 'B', role: 'team_leader', is_active: true },
      { id: 'uC', full_name: 'Charlie Person', crew: 'C', role: 'commander', is_active: true },
      { id: 'uD', full_name: 'Delta Person', crew: 'A', role: 'deputy_team_leader', is_active: true }
    ],
    board: {
      command: [{ id: 'command-1', site: 'rashit' }],
      vehicles: [{ id: 'engine-1', slots: [
        { id: 'a1', site: 'rashit' },
        { id: 'a2', site: 'rashit' },
        { id: 'b1', site: 'shahmon' },
        { id: 'c1', site: 'rashit' },
        { id: 'y1', site: 'yotvata' }
      ] }]
    },
    shifts: {
      A: { assign: { a1: 'uA', a2: 'uD' } },
      B: { assign: { b1: 'uB' } },
      C: { assign: { c1: 'uC' } }
    },
    subStations: [
      { id: 'rashit', fixed_hours: 0, is_active: true },
      { id: 'shahmon', fixed_hours: 0, is_active: true },
      { id: 'yotvata', fixed_hours: 25, is_active: true }
    ],
    config: { default_sub_station: 'rashit' }
  };
}

function row(snapshot, uid) {
  return snapshot.entries.find(function (entry) { return entry.uid === uid; });
}

function peopleFor(input) {
  return engine.personMap(input.users, input.roster);
}

function swapModel(input) {
  return engine.validateApprovedSwaps(
    input.swaps,
    peopleFor(input),
    engine.validateRotations(input.rotations),
    engine.normalizeOverrides(input.overrides)
  );
}

function validSwap() {
  return {
    id: 'swap-ab', status: 'approved',
    from_uid: 'uA', from_crew: 'A', from_date: '2026-09-01',
    to_uid: 'uB', to_crew: 'B', to_date: '2026-09-02'
  };
}

function actualFor(entry, changes) {
  const empByUid = { uA: '100', uB: '200', uC: '300', uD: '400' };
  return Object.assign({
    id: 'actual-' + entry.uid,
    uid: entry.uid,
    emp_number: empByUid[entry.uid],
    date: entry.date,
    crew: entry.home_crew,
    day_type: 'regular',
    start: entry.planned_start,
    end: entry.planned_end,
    end_day: entry.planned_end_day,
    hours: entry.planned_hours,
    sub_station: entry.sub_station,
    status: 'approved',
    source: 'manual'
  }, changes || {});
}

function compareOne(entry, actual, changes) {
  const input = baseInput(entry.date);
  return engine.compareShadowEntries(Object.assign({
    entries: [entry],
    attendance: actual ? (Array.isArray(actual) ? actual : [actual]) : [],
    users: input.users,
    guards: [],
    submissions: []
  }, changes || {}));
}

// Date, time and canonicalization invariants.
test('accepts a valid leap date', function () {
  assert.equal(engine.validDateKey('2028-02-29'), true);
});

test('rejects an impossible date', function () {
  assert.equal(engine.validDateKey('2027-02-29'), false);
});

test('rejects a non-canonical date key', function () {
  assert.equal(engine.validDateKey('2026-9-1'), false);
});

test('adds days across a month boundary', function () {
  assert.equal(engine.addDays('2026-09-30', 1), '2026-10-01');
});

test('adds days across a year boundary', function () {
  assert.equal(engine.addDays('2026-12-31', 1), '2027-01-01');
});

test('uses the Israel calendar date near UTC midnight', function () {
  assert.equal(engine.localDateKey('2026-08-31T21:30:00.000Z'), '2026-09-01');
});

test('validates a canonical clock', function () {
  assert.equal(engine.validClock('06:45'), true);
});

test('rejects an invalid clock', function () {
  assert.equal(engine.validClock('24:00'), false);
});

test('derives a next-day shift end', function () {
  assert.deepEqual(engine.endFrom('07:00', 1440), { end: '07:00', endDay: 1 });
});

test('derives commander quarter-hour duration', function () {
  assert.deepEqual(engine.endFrom('06:45', 1455), { end: '07:00', endDay: 1 });
});

test('canonical hash ignores object key insertion order', function () {
  assert.equal(engine.canonicalHash({ a: 1, b: 2 }), engine.canonicalHash({ b: 2, a: 1 }));
});

test('canonical hash preserves array order', function () {
  assert.notEqual(engine.canonicalHash([1, 2]), engine.canonicalHash([2, 1]));
});

test('canonical hash is a lowercase SHA-256 string', function () {
  assert.match(engine.canonicalHash({ ok: true }), /^[a-f0-9]{64}$/);
});

// Rotation and override behavior.
test('accepts the complete three-crew rotation', function () {
  assert.equal(engine.validateRotations(baseRotations()).ok, true);
});

test('resolves anchor day to crew A', function () {
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), [], '2026-09-01');
  assert.deepEqual(state.crews, ['A']);
});

test('resolves second day to crew B', function () {
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), [], '2026-09-02');
  assert.deepEqual(state.crews, ['B']);
});

test('resolves third day to crew C', function () {
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), [], '2026-09-03');
  assert.deepEqual(state.crews, ['C']);
});

test('resolves a day before the anchor without modulo drift', function () {
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), [], '2026-08-31');
  assert.deepEqual(state.crews, ['C']);
});

test('blocks a missing rotation model', function () {
  assert.ok(engine.validateRotations([]).conflicts.includes('missing_rotations'));
});

test('blocks duplicate rotation positions', function () {
  const rotations = baseRotations();
  rotations[1].position_in_cycle = 0;
  assert.ok(engine.validateRotations(rotations).conflicts.includes('duplicate_rotation_position'));
});

test('blocks inconsistent anchor dates', function () {
  const rotations = baseRotations();
  rotations[2].anchor_date = '2026-09-02';
  assert.ok(engine.validateRotations(rotations).conflicts.includes('inconsistent_anchor'));
});

test('blocks inconsistent cycle lengths', function () {
  const rotations = baseRotations();
  rotations[2].cycle_days = 4;
  assert.ok(engine.validateRotations(rotations).conflicts.includes('inconsistent_cycle'));
});

test('blocks an invalid rotation crew', function () {
  const rotations = baseRotations();
  rotations[2].crew = 'D';
  assert.ok(engine.validateRotations(rotations).conflicts.includes('invalid_rotation_crew'));
});

test('blocks inconsistent configured start times', function () {
  const rotations = baseRotations();
  rotations[2].shift_start = '08:00';
  assert.ok(engine.validateRotations(rotations).conflicts.includes('inconsistent_shift_start'));
});

test('reports a target-date rotation gap', function () {
  const rotations = baseRotations().slice(0, 2);
  const state = engine.crewStateOnDate(engine.validateRotations(rotations), [], '2026-09-03');
  assert.ok(state.conflicts.includes('rotation_gap'));
});

test('swap override replaces the scheduled crew', function () {
  const override = [{ id: 'o1', date: '2026-09-01', kind: 'swap', crew: 'B' }];
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), override, '2026-09-01');
  assert.deepEqual(state.crews, ['B']);
  assert.equal(state.sourceKind, 'override');
});

test('standby override adds crews deterministically', function () {
  const override = [{ id: 'o1', date: '2026-09-01', kind: 'standby', extra_crews: ['C', 'B'] }];
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), override, '2026-09-01');
  assert.deepEqual(state.crews, ['A', 'B', 'C']);
});

test('unknown override kind becomes a conflict', function () {
  const override = [{ id: 'o1', date: '2026-09-01', kind: 'mystery' }];
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), override, '2026-09-01');
  assert.ok(state.conflicts.includes('invalid_override_kind'));
});

test('duplicate overrides become a conflict', function () {
  const override = [
    { id: 'o1', date: '2026-09-01', kind: 'holiday' },
    { id: 'o2', date: '2026-09-01', kind: 'training' }
  ];
  const state = engine.crewStateOnDate(engine.validateRotations(baseRotations()), override, '2026-09-01');
  assert.ok(state.conflicts.includes('duplicate_override'));
});

// UID identity contract.
test('build emits one row per active UID only', function () {
  const snapshot = engine.buildDailySnapshot(baseInput());
  assert.deepEqual(snapshot.entries.map(function (entry) { return entry.uid; }), ['uA', 'uB', 'uC', 'uD']);
});

test('inactive user is excluded', function () {
  assert.equal(row(engine.buildDailySnapshot(baseInput()), 'inactive'), undefined);
});

test('missing employee number is an identity conflict', function () {
  const input = baseInput();
  delete input.users[0].employee_number;
  assert.ok(row(engine.buildDailySnapshot(input), 'uA').conflict_codes.includes('missing_emp'));
});

test('duplicate employee number is an identity conflict', function () {
  const input = baseInput();
  input.users[1].employee_number = '100';
  assert.ok(row(engine.buildDailySnapshot(input), 'uA').conflict_codes.includes('duplicate_emp'));
  assert.ok(row(engine.buildDailySnapshot(input), 'uB').conflict_codes.includes('duplicate_emp'));
});

test('missing roster mirror is a conflict', function () {
  const input = baseInput();
  input.roster = input.roster.filter(function (person) { return person.id !== 'uA'; });
  assert.ok(row(engine.buildDailySnapshot(input), 'uA').conflict_codes.includes('missing_roster'));
});

test('roster crew mismatch is a conflict', function () {
  const input = baseInput();
  input.roster[0].crew = 'B';
  assert.ok(row(engine.buildDailySnapshot(input), 'uA').conflict_codes.includes('roster_crew_mismatch'));
});

test('roster role mismatch is a conflict', function () {
  const input = baseInput();
  input.roster[0].role = 'commander';
  assert.ok(row(engine.buildDailySnapshot(input), 'uA').conflict_codes.includes('roster_role_mismatch'));
});

test('name mismatch is warning only and never an identity join', function () {
  const input = baseInput();
  input.roster[0].full_name = 'Different Display Name';
  const entry = row(engine.buildDailySnapshot(input), 'uA');
  assert.equal(entry.state, 'ready');
  assert.ok(entry.warning_codes.includes('roster_name_mismatch'));
});

test('duplicate display names do not merge UIDs', function () {
  const input = baseInput();
  input.users[1].full_name = input.users[0].full_name;
  input.roster[1].full_name = input.roster[0].full_name;
  assert.equal(engine.buildDailySnapshot(input).entries.length, 4);
});

// Station and hours resolution.
test('assigned slot resolves the station', function () {
  assert.equal(row(engine.buildDailySnapshot(baseInput()), 'uA').sub_station, 'rashit');
});

test('two assigned slots at the same site are unambiguous', function () {
  const input = baseInput();
  input.shifts.A.assign.a2 = 'uA';
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations });
  assert.equal(station.subStation, 'rashit');
  assert.equal(station.conflicts.length, 0);
});

test('assigned slots at different sites are a conflict', function () {
  const input = baseInput();
  input.board.vehicles[0].slots.find(function (slot) { return slot.id === 'a2'; }).site = 'shahmon';
  input.shifts.A.assign.a2 = 'uA';
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations });
  assert.ok(station.conflicts.includes('ambiguous_station'));
});

test('missing board assignment is a conflict', function () {
  const input = baseInput();
  input.shifts.A.assign = {};
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations });
  assert.ok(station.conflicts.includes('missing_assignment'));
});

test('unknown assigned slot is a conflict', function () {
  const input = baseInput();
  input.shifts.A.assign = { unknown: 'uA' };
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations });
  assert.ok(station.conflicts.includes('unknown_assigned_slot'));
});

test('configured default station is explicit and warned', function () {
  const input = baseInput();
  input.board.vehicles[0].slots.find(function (slot) { return slot.id === 'a1'; }).site = '';
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations, defaultSubStation: 'rashit' });
  assert.equal(station.stationSource, 'configured_default');
  assert.ok(station.warnings.includes('default_station_used'));
});

test('unlocated assignment without configured default is a conflict', function () {
  const input = baseInput();
  input.board.vehicles[0].slots.find(function (slot) { return slot.id === 'a1'; }).site = '';
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations });
  assert.ok(station.conflicts.includes('missing_station'));
});

test('inactive station is a conflict', function () {
  const input = baseInput();
  input.subStations[0].is_active = false;
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations });
  assert.ok(station.conflicts.includes('inactive_or_unknown_station'));
});

test('fractional station minutes are validated exactly', function () {
  const input = baseInput();
  input.subStations[0].fixed_hours = 24.333;
  const station = engine.resolveStation({ targetUid: 'uA', crew: 'A', shifts: input.shifts,
    board: input.board, subStations: input.subStations });
  assert.ok(station.conflicts.includes('invalid_station_hours'));
});

test('regular firefighter receives 24 configured hours', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  assert.equal(entry.planned_hours, 24);
  assert.equal(entry.hours_rule, 'regular');
});

test('commander receives explicit 24.25 hours', function () {
  const entry = row(engine.buildDailySnapshot(baseInput('2026-09-03')), 'uC');
  assert.equal(entry.state, 'ready');
  assert.equal(entry.planned_hours, 24.25);
  assert.equal(entry.planned_start, '06:45');
});

test('missing explicit commander start blocks commander hours', function () {
  const input = baseInput('2026-09-03');
  input.rotations.forEach(function (rotation) { delete rotation.commander_start; });
  const entry = row(engine.buildDailySnapshot(input), 'uC');
  assert.ok(entry.conflict_codes.includes('missing_commander_start'));
});

test('fixed-site firefighter receives 25 hours', function () {
  const input = baseInput();
  input.shifts.A.assign = { y1: 'uA', a2: 'uD' };
  const entry = row(engine.buildDailySnapshot(input), 'uA');
  assert.equal(entry.planned_hours, 25);
  assert.equal(entry.planned_end, '08:00');
  assert.equal(entry.hours_rule, 'site_fixed');
});

test('commander at fixed-hours site becomes an explicit conflict', function () {
  const input = baseInput('2026-09-03');
  input.shifts.C.assign = { y1: 'uC' };
  const entry = row(engine.buildDailySnapshot(input), 'uC');
  assert.ok(entry.conflict_codes.includes('commander_site_hours_unresolved'));
});

// Approved swap validation and precedence.
test('pending swap is ignored by the engine', function () {
  const input = baseInput();
  input.swaps = [Object.assign(validSwap(), { status: 'pending' })];
  assert.equal(swapModel(input).swaps.length, 0);
});

test('rejected swap is ignored by the engine', function () {
  const input = baseInput();
  input.swaps = [Object.assign(validSwap(), { status: 'rejected' })];
  assert.equal(swapModel(input).swaps.length, 0);
});

test('valid approved swap creates four deterministic effects', function () {
  const input = baseInput();
  input.swaps = [validSwap()];
  const model = swapModel(input);
  assert.equal(model.swaps[0].conflicts.length, 0);
  assert.equal(Object.keys(model.effects).length, 4);
});

test('swap removes the original worker on the source date', function () {
  const input = baseInput();
  input.swaps = [validSwap()];
  const entry = row(engine.buildDailySnapshot(input), 'uA');
  assert.equal(entry.planned_work, false);
  assert.equal(entry.source_kind, 'swap');
});

test('swap adds replacement and inherits covered station', function () {
  const input = baseInput();
  input.swaps = [validSwap()];
  const entry = row(engine.buildDailySnapshot(input), 'uB');
  assert.equal(entry.planned_work, true);
  assert.equal(entry.covered_uid, 'uA');
  assert.equal(entry.sub_station, 'rashit');
  assert.equal(entry.station_source, 'covered_slot');
});

test('swap rejects a missing party', function () {
  const input = baseInput();
  input.swaps = [Object.assign(validSwap(), { to_uid: '' })];
  assert.ok(swapModel(input).swaps[0].conflicts.includes('missing_swap_party'));
});

test('swap rejects the same party', function () {
  const input = baseInput();
  input.swaps = [Object.assign(validSwap(), { to_uid: 'uA', to_crew: 'A' })];
  assert.ok(swapModel(input).swaps[0].conflicts.includes('same_swap_party'));
});

test('swap rejects a declared crew mismatch', function () {
  const input = baseInput();
  input.swaps = [Object.assign(validSwap(), { from_crew: 'C' })];
  assert.ok(swapModel(input).swaps[0].conflicts.includes('from_crew_mismatch'));
});

test('swap rejects a date where declared crew is not scheduled', function () {
  const input = baseInput();
  input.swaps = [Object.assign(validSwap(), { to_date: '2026-09-03' })];
  assert.ok(swapModel(input).swaps[0].conflicts.includes('to_date_not_scheduled'));
});

test('swap blocks adjacent-shift rest violation', function () {
  const input = baseInput();
  input.swaps = [Object.assign(validSwap(), { to_date: '2026-09-05' })];
  assert.ok(swapModel(input).swaps[0].conflicts.includes('rest_violation'));
});

test('multiple effects for one UID and date become conflicts', function () {
  const input = baseInput();
  input.swaps = [validSwap(), Object.assign(validSwap(), { id: 'swap-ab-2' })];
  assert.ok(swapModel(input).swaps.every(function (swap) {
    return swap.conflicts.includes('multiple_swap_effects');
  }));
});

// Comparison classification, including strict UID-only matching.
test('exact past attendance matches', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  assert.equal(compareOne(entry, actualFor(entry), { asOfDate: '2026-09-02' }).rows[0].state, 'match');
});

test('past planned work without attendance is a mismatch', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = compareOne(entry, null, { asOfDate: '2026-09-02' });
  assert.equal(result.rows[0].state, 'mismatch');
  assert.ok(result.rows[0].mismatch_codes.includes('missing_attendance'));
});

test('today planned work without attendance is pending', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = compareOne(entry, null, { asOfDate: '2026-09-01' });
  assert.equal(result.rows[0].state, 'pending');
  assert.ok(result.rows[0].mismatch_codes.includes('pending'));
  assert.equal(result.summary.pending, 1);
  assert.equal(result.summary.missing_attendance, 0);
});

test('future planned work without attendance is pending', function () {
  const input = baseInput('2026-09-04');
  const entry = row(engine.buildDailySnapshot(input), 'uA');
  assert.equal(compareOne(entry, null, { asOfDate: '2026-09-01' }).rows[0].state, 'pending');
});

test('planned off without attendance matches', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  assert.equal(compareOne(entry, null, { asOfDate: '2026-09-02' }).rows[0].state, 'match');
});

test('hours mismatch is classified', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = compareOne(entry, actualFor(entry, { hours: 23 }), { asOfDate: '2026-09-02' });
  assert.ok(result.rows[0].mismatch_codes.includes('hours_mismatch'));
});

test('station mismatch is classified', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = compareOne(entry, actualFor(entry, { sub_station: 'shahmon' }), { asOfDate: '2026-09-02' });
  assert.ok(result.rows[0].mismatch_codes.includes('station_mismatch'));
});

test('missing actual station is classified', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = compareOne(entry, actualFor(entry, { sub_station: '' }), { asOfDate: '2026-09-02' });
  assert.ok(result.rows[0].mismatch_codes.includes('missing_actual_station'));
});

test('time mismatch is classified', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = compareOne(entry, actualFor(entry, { start: '08:00' }), { asOfDate: '2026-09-02' });
  assert.ok(result.rows[0].mismatch_codes.includes('time_mismatch'));
});

test('crew mismatch is classified against home crew', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = compareOne(entry, actualFor(entry, { crew: 'B' }), { asOfDate: '2026-09-02' });
  assert.ok(result.rows[0].mismatch_codes.includes('crew_mismatch'));
});

test('verified vacation explains an off-day record', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  const actual = actualFor(entry, { day_type: 'vacation', hours: 0 });
  const result = compareOne(entry, actual, { submissions: [{ id: 'leave-1', form_id: 'leave',
    status: 'approved', by_uid: 'uB', values: { from: entry.date, to: entry.date } }] });
  assert.equal(result.rows[0].state, 'explained');
});

test('unverified vacation on off day is unexpected attendance', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  const result = compareOne(entry, actualFor(entry, { day_type: 'vacation', hours: 0 }));
  assert.ok(result.rows[0].mismatch_codes.includes('unexpected_attendance'));
});

test('verified guard explains an off-day record', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  const actual = actualFor(entry, { day_type: 'guard', hours: 8 });
  const result = compareOne(entry, actual, { guards: [{ id: 'g1', date: entry.date,
    status: 'active', assigned: ['uB'] }] });
  assert.equal(result.rows[0].state, 'explained');
});

test('unverified guard on off day is unexpected attendance', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  const result = compareOne(entry, actualFor(entry, { day_type: 'guard', hours: 8 }));
  assert.ok(result.rows[0].mismatch_codes.includes('unexpected_attendance'));
});

test('reserve off-day record is explained but flagged for review', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  const result = compareOne(entry, actualFor(entry, { day_type: 'reserve', hours: 8 }));
  assert.equal(result.rows[0].state, 'explained');
  assert.ok(result.rows[0].warning_codes.includes('exception_requires_review'));
});

test('reasoned extra shift explains an off-day record', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  const actual = actualFor(entry, { day_type: 'extra', hours: 8, overtime_reason: 'approved callback' });
  assert.equal(compareOne(entry, actual).rows[0].state, 'explained');
});

test('unreasoned extra shift remains unexpected', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uB');
  const actual = actualFor(entry, { day_type: 'extra', hours: 8, overtime_reason: '' });
  assert.ok(compareOne(entry, actual).rows[0].mismatch_codes.includes('unexpected_attendance'));
});

test('duplicate actual UID/date records are uncomparable', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const actual = actualFor(entry);
  const result = compareOne(entry, [actual, Object.assign({}, actual, { id: 'duplicate' })]);
  assert.equal(result.rows[0].state, 'uncomparable');
  assert.ok(result.rows[0].mismatch_codes.includes('duplicate_actual'));
});

test('attendance without UID never falls back to employee number or name', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const actual = actualFor(entry, { uid: '', full_name: 'Alpha Person' });
  const result = compareOne(entry, actual, { asOfDate: '2026-09-02' });
  assert.ok(result.rows[0].mismatch_codes.includes('missing_attendance'));
  assert.deepEqual(result.global_conflicts, [{ code: 'attendance_missing_uid', count: 1 }]);
  assert.equal(result.summary.identity_conflict, 1);
});

test('wrong UID never falls back to matching employee number', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const actual = actualFor(entry, { uid: 'unknown-uid' });
  const result = compareOne(entry, actual, { asOfDate: '2026-09-02' });
  assert.ok(result.rows[0].mismatch_codes.includes('missing_attendance'));
  assert.deepEqual(result.global_conflicts, [{ code: 'attendance_uid_not_in_snapshot', count: 1 }]);
});

test('display name is irrelevant when UID matches', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const actual = actualFor(entry, { full_name: 'Entirely Different Name' });
  assert.equal(compareOne(entry, actual).rows[0].state, 'match');
});

test('missing comparison user makes row uncomparable', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const result = engine.compareShadowEntries({ entries: [entry], attendance: [actualFor(entry)], users: [] });
  assert.equal(result.rows[0].state, 'uncomparable');
  assert.ok(result.rows[0].mismatch_codes.includes('comparison_user_missing'));
});

test('snapshot source conflict makes comparison uncomparable', function () {
  const entry = clone(row(engine.buildDailySnapshot(baseInput()), 'uA'));
  entry.state = 'conflict';
  entry.conflict_codes = ['forced_test_conflict'];
  const result = compareOne(entry, actualFor(entry));
  assert.equal(result.rows[0].state, 'uncomparable');
  assert.ok(result.rows[0].mismatch_codes.includes('snapshot_conflict'));
});

test('legacy attendance source is warned without changing an exact match', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const actual = actualFor(entry);
  delete actual.source;
  const result = compareOne(entry, actual);
  assert.equal(result.rows[0].state, 'match');
  assert.ok(result.rows[0].warning_codes.includes('legacy_source'));
});

test('untrusted actual metadata is normalized and surfaced as warnings', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const actual = actualFor(entry, {
    source: 'Alpha Person', status: 'private note', sub_station: 'שם תחנה',
    start: '99:99', end: 'secret', end_day: 'invalid'
  });
  const result = compareOne(entry, actual);
  const output = result.rows[0];
  assert.equal(output.actual_source, 'unknown');
  assert.equal(output.actual_status, 'unknown');
  assert.equal(output.actual_station, '');
  assert.equal(output.actual_start, '');
  assert.equal(output.actual_end, '');
  assert.ok(output.warning_codes.includes('unknown_actual_source'));
  assert.ok(output.warning_codes.includes('unknown_actual_status'));
  assert.ok(output.warning_codes.includes('invalid_actual_station_id'));
});

test('unknown user role and crew become non-PII conflict enums', function () {
  const input = baseInput();
  input.users[0].role = 'Alpha Person';
  input.users[0].crew = 'private crew';
  input.roster[0].role = 'Alpha Person';
  input.roster[0].crew = 'private crew';
  const entry = row(engine.buildDailySnapshot(input), 'uA');
  assert.equal(entry.role, 'unknown');
  assert.equal(entry.home_crew, '');
  assert.ok(entry.conflict_codes.includes('unknown_role'));
  assert.ok(entry.conflict_codes.includes('missing_or_invalid_crew'));
  assert.equal(JSON.stringify(entry).includes('Alpha Person'), false);
  assert.equal(JSON.stringify(entry).includes('private crew'), false);
});

test('comparison summary counts exact and missing rows', function () {
  const snapshot = engine.buildDailySnapshot(baseInput());
  const uA = row(snapshot, 'uA');
  const uD = row(snapshot, 'uD');
  const result = engine.compareShadowEntries({ entries: [uA, uD], attendance: [actualFor(uA)],
    users: baseInput().users, asOfDate: '2026-09-02' });
  assert.equal(result.summary.exact_matches, 1);
  assert.equal(result.summary.missing_attendance, 1);
});

test('comparison indexes 5,000 UID/date rows instead of scanning quadratically', function () {
  const base = row(engine.buildDailySnapshot(baseInput()), 'uA');
  const entries = [], attendance = [], users = [];
  for (let index = 0; index < 5000; index++) {
    const uid = 'scale_' + index;
    const entry = Object.assign({}, base, { uid: uid });
    entries.push(entry);
    users.push({ id: uid, employee_number: String(index + 10000) });
    attendance.push(actualFor(entry, {
      uid: uid, emp_number: String(index + 10000), source: 'manual'
    }));
  }
  const started = Date.now();
  const result = engine.compareShadowEntries({
    entries: entries, attendance: attendance, users: users,
    guards: [], submissions: []
  });
  const elapsed = Date.now() - started;
  assert.equal(result.rows.length, 5000);
  assert.equal(result.summary.exact_matches, 5000);
  assert.ok(elapsed < 3000, '5,000-row comparison took ' + elapsed + 'ms');
});

// Privacy, determinism and immutability.
test('snapshot output passes recursive privacy-key scan', function () {
  assert.equal(engine.privacySafe(engine.buildDailySnapshot(baseInput())), true);
});

test('comparison output passes recursive privacy-key scan', function () {
  const entry = row(engine.buildDailySnapshot(baseInput()), 'uA');
  assert.equal(engine.privacySafe(compareOne(entry, actualFor(entry))), true);
});

test('privacy scan rejects name, email, phone and employee keys', function () {
  const unsafe = { name: 'n', nested: { email: 'e', phone: 'p', employee_number: '1' } };
  assert.equal(engine.privacyViolations(unsafe).length, 4);
});

test('snapshot contains no input display name values', function () {
  const text = JSON.stringify(engine.buildDailySnapshot(baseInput()));
  ['Alpha Person', 'Bravo Person', 'Charlie Person', 'Delta Person'].forEach(function (name) {
    assert.equal(text.includes(name), false);
  });
});

test('snapshot contains no employee-number values', function () {
  const text = JSON.stringify(engine.buildDailySnapshot(baseInput()));
  ['100', '200', '300', '400'].forEach(function (emp) {
    assert.equal(text.includes('"' + emp + '"'), false);
  });
});

test('changing synchronized display names leaves digests unchanged', function () {
  const left = baseInput();
  const right = baseInput();
  right.users[0].full_name = 'Renamed User';
  right.roster[0].full_name = 'Renamed User';
  assert.equal(engine.buildDailySnapshot(left).source_digest,
    engine.buildDailySnapshot(right).source_digest);
});

test('changing a unique employee number leaves shadow digests unchanged', function () {
  const left = baseInput();
  const right = baseInput();
  right.users[0].employee_number = '777';
  assert.equal(engine.buildDailySnapshot(left).rows_digest,
    engine.buildDailySnapshot(right).rows_digest);
});

test('reordering users and roster does not change digests', function () {
  const left = baseInput();
  const right = baseInput();
  right.users.reverse();
  right.roster.reverse();
  assert.equal(engine.buildDailySnapshot(left).source_digest,
    engine.buildDailySnapshot(right).source_digest);
});

test('reordering rotation documents does not change digests', function () {
  const left = baseInput();
  const right = baseInput();
  right.rotations.reverse();
  assert.equal(engine.buildDailySnapshot(left).source_digest,
    engine.buildDailySnapshot(right).source_digest);
});

test('free-text override note never affects the source digest', function () {
  const left = baseInput();
  const right = baseInput();
  left.overrides = [{ id: 'o1', date: '2026-09-01', kind: 'holiday', note: 'secret one' }];
  right.overrides = [{ id: 'o1', date: '2026-09-01', kind: 'holiday', note: 'secret two' }];
  assert.equal(engine.buildDailySnapshot(left).source_digest,
    engine.buildDailySnapshot(right).source_digest);
});

test('assignment change changes the source digest', function () {
  const left = baseInput();
  const right = baseInput();
  right.shifts.A.assign.a1 = 'uD';
  assert.notEqual(engine.buildDailySnapshot(left).source_digest,
    engine.buildDailySnapshot(right).source_digest);
});

test('building a snapshot does not mutate its input', function () {
  const input = baseInput();
  const before = JSON.stringify(input);
  engine.buildDailySnapshot(input);
  assert.equal(JSON.stringify(input), before);
});

test('same input creates byte-stable snapshot output', function () {
  const input = baseInput();
  assert.equal(JSON.stringify(engine.buildDailySnapshot(input)),
    JSON.stringify(engine.buildDailySnapshot(clone(input))));
});

test('all entry hashes are SHA-256 values', function () {
  engine.buildDailySnapshot(baseInput()).entries.forEach(function (entry) {
    assert.match(entry.input_hash, /^[a-f0-9]{64}$/);
  });
});

test('engine source has no Firebase Admin dependency or write calls', function () {
  const source = fs.readFileSync(require.resolve('./attendance-shadow'), 'utf8');
  assert.equal(/firebase-admin|admin\.firestore|getFirestore\s*\(|runTransaction\s*\(|batch\s*\(/.test(source), false);
});

test('public API exposes buildDailySnapshot and strict comparator', function () {
  assert.equal(typeof engine.buildDailySnapshot, 'function');
  assert.equal(typeof engine.compareShadowEntries, 'function');
});

if (failures.length) {
  console.error('\n' + failures.length + ' failed; ' + passed + ' passed');
  process.exitCode = 1;
} else {
  assert.ok(passed >= 50, 'expected at least 50 tests');
  console.log('\n' + passed + ' tests passed');
}
