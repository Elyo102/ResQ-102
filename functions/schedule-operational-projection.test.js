'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SOURCE,
  OperationalProjectionError,
  createOperationalProjection
} = require('./schedule-operational-projection');

const SID = 'eilat_102';
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log('✓ ' + name);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rejects(fn, code) {
  assert.throws(fn, function (error) {
    return error instanceof OperationalProjectionError && error.code === code;
  });
}

function roster() {
  return [
    { uid: 'alpha', crew: 'A', active: true, display: 'אלון', email: 'alpha@example.test', note: 'do not expose' },
    { uid: 'bravo', crew: 'B', active: true, full_name: 'ברק', phone: '0500000000' },
    { uid: 'charlie', crew: 'C', is_active: true, display_name: 'כרמל', employee_number: '7' },
    { uid: 'retired', crew: 'A', active: false, display: 'פרש' }
  ];
}

function rotations() {
  return [
    { id: 'A', crew: 'A', anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: 0, is_active: true },
    { id: 'B', crew: 'B', anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: 1, is_active: true },
    { id: 'C', crew: 'C', anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: 2, is_active: true }
  ];
}

function legacy(extra) {
  return Object.assign({
    source: SOURCE.LEGACY,
    station_id: SID,
    roster: roster(),
    legacy: { rotations: rotations(), overrides: [], approved_swaps: [] }
  }, extra || {});
}

function v2(extra) {
  return Object.assign({
    source: SOURCE.V2,
    station_id: SID,
    roster: roster(),
    plan: {
      kind: 'schedule-plan', station_id: SID,
      from: '2026-09-01', to: '2026-09-03',
      rows: [
        { date: '2026-09-01', station_id: SID, sub_station: 'main', slots: [
          { person: 'alpha', role: 'driver' },
          { person: 'bravo', role: 'firefighter', cancelled: true }
        ] },
        { date: '2026-09-02', station_id: SID, sub_station: 'main', slots: [
          { person: 'bravo', role: 'firefighter' }
        ] },
        { date: '2026-09-03', station_id: SID, sub_station: 'main', slots: [
          { person: 'charlie', role: 'firefighter' }
        ] }
      ]
    }
  }, extra || {});
}

test('legacy rotation answers deterministic daily work without a clock', () => {
  const projection = createOperationalProjection(legacy());
  assert.equal(projection.source, 'legacy');
  assert.equal(projection.station_id, SID);
  assert.equal(projection.isPersonWorking('alpha', '2026-09-01'), true);
  assert.equal(projection.isPersonWorking('alpha', '2026-09-02'), false);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-02'), true);
  assert.equal(projection.isPersonWorking('charlie', '2026-09-03'), true);
  assert.equal(projection.isPersonWorking('retired', '2026-09-01'), false);
  assert.equal(projection.isPersonWorking('unknown', '2026-09-01'), false);
});

test('legacy override preserves exact historical semantics for swap, standby and holiday', () => {
  const swapped = legacy();
  swapped.legacy.overrides = [{ date: '2026-09-01', kind: 'swap', crew: 'B' }];
  const swapProjection = createOperationalProjection(swapped);
  assert.equal(swapProjection.primaryCrewOn('2026-09-01'), 'B');
  assert.equal(swapProjection.isPersonWorking('alpha', '2026-09-01'), false);
  assert.equal(swapProjection.isPersonWorking('bravo', '2026-09-01'), true);

  const standby = legacy();
  standby.legacy.overrides = [{ date: '2026-09-01', kind: 'standby', extra_crews: ['B'] }];
  const standbyProjection = createOperationalProjection(standby);
  assert.equal(standbyProjection.primaryCrewOn('2026-09-01'), 'A');
  assert.equal(standbyProjection.isPersonWorking('alpha', '2026-09-01'), true);
  assert.equal(standbyProjection.isPersonWorking('bravo', '2026-09-01'), true);

  const holiday = legacy();
  holiday.legacy.overrides = [{ date: '2026-09-01', kind: 'holiday' }];
  const holidayProjection = createOperationalProjection(holiday);
  assert.equal(holidayProjection.primaryCrewOn('2026-09-01'), 'A');
  assert.equal(holidayProjection.isPersonWorking('alpha', '2026-09-01'), true);
  assert.equal(holidayProjection.isPersonWorking('bravo', '2026-09-01'), false);
});

test('primary crew follows the validated rotation even when nobody from that crew is in the roster', () => {
  const input = legacy();
  input.roster = [];
  const projection = createOperationalProjection(input);
  assert.deepEqual([
    projection.primaryCrewOn('2026-09-01'),
    projection.primaryCrewOn('2026-09-02'),
    projection.primaryCrewOn('2026-09-03')
  ], ['A', 'B', 'C']);
});

test('training annotates the day without replacing its primary crew', () => {
  const input = legacy();
  input.legacy.overrides = [{ date: '2026-09-02', kind: 'training' }];
  assert.equal(createOperationalProjection(input).primaryCrewOn('2026-09-02'), 'B');
});

test('an approved reciprocal legacy swap changes both days and its effective crew', () => {
  const input = legacy();
  input.legacy.approved_swaps = [{
    id: 'swap_1', status: 'approved', from_uid: 'alpha', from_crew: 'A', from_date: '2026-09-01',
    to_uid: 'bravo', to_crew: 'B', to_date: '2026-09-02'
  }];
  const projection = createOperationalProjection(input);
  assert.equal(projection.isPersonWorking('alpha', '2026-09-01'), false);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-01'), true);
  assert.equal(projection.isPersonWorking('alpha', '2026-09-02'), true);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-02'), false);
  const window = projection.stationWindow({ from: '2026-09-01', to: '2026-09-02' });
  assert.deepEqual(window.days[0].assignments, [
    { uid: 'bravo', display: 'ברק', crew: 'A', source: 'legacy_swap' }
  ]);
  assert.deepEqual(window.days[1].assignments, [
    { uid: 'alpha', display: 'אלון', crew: 'B', source: 'legacy_swap' }
  ]);
});

test('pending swaps in the raw legacy collection are ignored while only approved rows apply', () => {
  const input = legacy();
  delete input.legacy.approved_swaps;
  input.legacy.swaps = [{
    id: 'pending', status: 'pending', from_uid: 'alpha', from_crew: 'A', from_date: '2026-09-01',
    to_uid: 'bravo', to_crew: 'B', to_date: '2026-09-02'
  }];
  const projection = createOperationalProjection(input);
  assert.equal(projection.isPersonWorking('alpha', '2026-09-01'), true);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-02'), true);
});

test('a non-approved row inside the asserted approved-swaps envelope fails closed', () => {
  const input = legacy();
  input.legacy.approved_swaps = [{
    id: 'pending-in-approved-envelope', status: 'pending',
    from_uid: 'alpha', from_crew: 'A', from_date: '2026-09-01',
    to_uid: 'bravo', to_crew: 'B', to_date: '2026-09-02'
  }];
  assert.throws(() => createOperationalProjection(input), (error) =>
    error && error.code === 'approved-swaps-status');
});

test('approved historical swaps keep legacy personWorks effects despite anomalous old preconditions', () => {
  const input = legacy();
  delete input.legacy.approved_swaps;
  input.legacy.swaps = [{
    status: 'approved',
    from_uid: 'alpha', from_crew: 'not_a_real_crew', from_date: '2026-09-01',
    to_uid: 'bravo', to_crew: 'also_not_real', to_date: '2026-09-02'
  }];
  const projection = createOperationalProjection(input);

  // These four expectations mirror rotation.js/personWorks: an approved effect
  // wins even when the historical crew fields would fail present-day validation.
  assert.equal(projection.isPersonWorking('alpha', '2026-09-01'), false);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-01'), true);
  assert.equal(projection.isPersonWorking('alpha', '2026-09-02'), true);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-02'), false);
  const window = projection.stationWindow('2026-09-01', '2026-09-02');
  assert.deepEqual(window.days.map((day) => day.assignments.map((entry) => entry.uid)), [
    ['bravo'], ['alpha']
  ]);
  assert.deepEqual(window.days.map((day) => day.anomaly_codes), [
    ['legacy_swap_historical_anomaly'], ['legacy_swap_historical_anomaly']
  ]);
});

test('raw approved swaps preserve legacy first-match order and flag an ordered overlap', () => {
  const firstIn = {
    status: 'approved', from_uid: 'bravo', from_crew: 'B', from_date: '2026-09-02',
    to_uid: 'alpha', to_crew: 'A', to_date: '2026-09-01'
  };
  const laterOut = {
    status: 'approved', from_uid: 'alpha', from_crew: 'A', from_date: '2026-09-02',
    to_uid: 'charlie', to_crew: 'C', to_date: '2026-09-03'
  };
  const ordered = legacy();
  delete ordered.legacy.approved_swaps;
  ordered.legacy.swaps = [firstIn, laterOut];
  const firstProjection = createOperationalProjection(ordered);
  assert.equal(firstProjection.isPersonWorking('alpha', '2026-09-02'), true);
  assert.ok(firstProjection.stationWindow('2026-09-02', '2026-09-02').days[0]
    .anomaly_codes.includes('legacy_swap_ordered_overlap'));

  const reversed = legacy();
  delete reversed.legacy.approved_swaps;
  reversed.legacy.swaps = [laterOut, firstIn];
  assert.equal(createOperationalProjection(reversed).isPersonWorking('alpha', '2026-09-02'), false);
});

test('an approved effect for a no-longer-listed person remains queryable and is surfaced without identity expansion', () => {
  const input = legacy();
  delete input.legacy.approved_swaps;
  input.legacy.swaps = [{
    status: 'approved',
    from_uid: 'alpha', from_crew: 'A', from_date: '2026-09-01',
    to_uid: 'ghost', to_crew: 'B', to_date: '2026-09-02'
  }];
  const projection = createOperationalProjection(input);
  assert.equal(projection.isPersonWorking('ghost', '2026-09-01'), true);
  const day = projection.stationWindow('2026-09-01', '2026-09-01').days[0];
  assert.deepEqual(day.assignments, []);
  assert.deepEqual(day.anomaly_codes, ['legacy_swap_historical_anomaly']);
});

test('legacy input fails closed for a cycle gap, foreign explicit roster station and unsupported roster crew', () => {
  const gap = legacy();
  gap.legacy.rotations.pop();
  rejects(() => createOperationalProjection(gap), 'rotation-gap');

  const foreignStation = legacy();
  foreignStation.roster[0].station_id = 'other_102';
  rejects(() => createOperationalProjection(foreignStation), 'roster-station-mismatch');

  const foreignCrew = legacy();
  foreignCrew.roster[0].crew = 'Z';
  rejects(() => createOperationalProjection(foreignCrew), 'roster-crew-unknown');
});

test('a minimized legacy station window retains only operational fields and display identity', () => {
  const projection = createOperationalProjection(legacy());
  const window = projection.stationWindow('2026-09-01', '2026-09-03');
  assert.equal(window.kind, 'operational-station-window');
  assert.equal(window.source, 'legacy');
  assert.equal(Object.isFrozen(window), true);
  assert.equal(Object.isFrozen(window.days), true);
  assert.deepEqual(window.days.map((day) => day.assignments.map((assignment) => assignment.uid)), [
    ['alpha'], ['bravo'], ['charlie']
  ]);
  const serialized = JSON.stringify(window);
  assert.equal(serialized.includes('alpha@example.test'), false);
  assert.equal(serialized.includes('0500000000'), false);
  assert.equal(serialized.includes('do not expose'), false);
  assert.deepEqual(Object.keys(window.days[0].assignments[0]).sort(), ['crew', 'display', 'source', 'uid']);
});

test('V2 models direct daily assignments and does not depend on legacy rotations', () => {
  const input = v2();
  delete input.roster[0].crew;
  delete input.roster[1].crew;
  const projection = createOperationalProjection(input);
  assert.equal(projection.source, 'v2');
  assert.equal(projection.isPersonWorking('alpha', '2026-09-01'), true);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-01'), false);
  assert.equal(projection.isPersonWorking('bravo', '2026-09-02'), true);
  assert.equal(projection.isPersonWorking('charlie', '2026-09-03'), true);
  const day = projection.stationWindow({ from: '2026-09-01', to: '2026-09-01' }).days[0];
  assert.deepEqual(day.assignments, [{
    uid: 'alpha', display: 'אלון', sub_station: 'main', role: 'driver', source: 'v2'
  }]);
});

test('Firebase UIDs with dots survive legacy, map fallback, swaps and V2 projections', () => {
  const dottedRoster = [
    { uid: 'dot.user', crew: 'A', active: true, display: 'נקודה' },
    { uid: 'bravo', crew: 'B', active: true, display: 'ברק' },
    { uid: 'charlie', crew: 'C', active: true, display: 'כרמל' }
  ];
  const old = legacy({ roster: dottedRoster });
  old.legacy.approved_swaps = [{
    status: 'approved', from_uid: 'dot.user', from_crew: 'A',
    from_date: '2026-09-01', to_uid: 'bravo', to_crew: 'B', to_date: '2026-09-02'
  }];
  const oldProjection = createOperationalProjection(old);
  assert.equal(oldProjection.isPersonWorking('dot.user', '2026-09-02'), true);

  const mapped = legacy({
    roster: {
      'dot.user': { crew: 'A', active: true, display: 'נקודה' },
      bravo: { crew: 'B', active: true, display: 'ברק' },
      charlie: { crew: 'C', active: true, display: 'כרמל' }
    }
  });
  assert.equal(createOperationalProjection(mapped)
    .isPersonWorking('dot.user', '2026-09-01'), true);

  const next = v2({
    roster: dottedRoster,
    plan: {
      kind: 'schedule-plan', station_id: SID,
      from: '2026-09-01', to: '2026-09-01',
      rows: [{ date: '2026-09-01', station_id: SID, sub_station: 'main',
        slots: [{ person: 'dot.user', role: 'firefighter' }] }]
    }
  });
  assert.deepEqual(createOperationalProjection(next)
    .stationWindow('2026-09-01', '2026-09-01').days[0].assignments.map((row) => row.uid),
  ['dot.user']);
  rejects(() => createOperationalProjection(Object.assign({}, old, { station_id: 'eilat.102' })),
    'station-id');
});

test('V2 input fails closed for a duplicate daily person and dates outside its active plan', () => {
  const duplicate = v2();
  duplicate.plan.rows.push({
    date: '2026-09-01', station_id: SID, sub_station: 'other', slots: [{ person: 'alpha', role: 'firefighter' }]
  });
  rejects(() => createOperationalProjection(duplicate), 'plan-person-duplicate-day');

  const projection = createOperationalProjection(v2());
  rejects(() => projection.isPersonWorking('alpha', '2026-08-31'), 'query-outside-plan');
  rejects(() => projection.stationWindow({ from: '2026-08-31', to: '2026-09-01' }), 'window-outside-plan');
  rejects(() => projection.isPersonWorking('bad/uid', '2026-09-01'), 'query-uid');

  const inactive = v2();
  inactive.plan.rows[0].slots = [{ person: 'retired', role: 'firefighter' }];
  rejects(() => createOperationalProjection(inactive), 'plan-person-inactive');

  const missing = v2();
  missing.roster = missing.roster.filter((person) => person.uid !== 'alpha');
  rejects(() => createOperationalProjection(missing), 'plan-person-missing');

  const caseSensitiveOverride = legacy();
  caseSensitiveOverride.legacy.overrides = [{ date: '2026-09-01', kind: 'SWAP', crew: 'B' }];
  rejects(() => createOperationalProjection(caseSensitiveOverride), 'override-kind');
});

test('equivalent legacy and V2 daily assignments can be compared for parity', () => {
  const oldProjection = createOperationalProjection(legacy());
  const newProjection = createOperationalProjection(v2({
    plan: {
      kind: 'schedule-plan', station_id: SID,
      from: '2026-09-01', to: '2026-09-03',
      rows: [
        { date: '2026-09-01', station_id: SID, sub_station: 'main', slots: [{ person: 'alpha', role: 'firefighter' }] },
        { date: '2026-09-02', station_id: SID, sub_station: 'main', slots: [{ person: 'bravo', role: 'firefighter' }] },
        { date: '2026-09-03', station_id: SID, sub_station: 'main', slots: [{ person: 'charlie', role: 'firefighter' }] }
      ]
    }
  }));
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) {
    for (const uid of ['alpha', 'bravo', 'charlie', 'retired']) {
      assert.equal(newProjection.isPersonWorking(uid, date), oldProjection.isPersonWorking(uid, date), uid + ' ' + date);
    }
  }
});

test('the projection neither mutates caller input nor imports runtime services', () => {
  const input = legacy();
  const before = clone(input);
  createOperationalProjection(input).stationWindow({ from: '2026-09-01', to: '2026-09-03' });
  assert.deepEqual(input, before);
  const source = fs.readFileSync(path.join(__dirname, 'schedule-operational-projection.js'), 'utf8');
  assert.doesNotMatch(source, /firebase|firestore|https?:\/\/|fetch\s*\(|Date\.now|setTimeout|setInterval/i);
});

assert.equal(passed, 17);
console.log('\n17 operational projection unit checks passed.');
