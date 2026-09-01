'use strict';

const assert = require('node:assert/strict');
const compat = require('./schedule-legacy-compat');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('✓ ' + name);
}

function rotation(crew, position, extra, id) {
  return { id: id || crew, value: Object.assign({
    crew, position_in_cycle: position, cycle_days: 3,
    anchor_date: '2026-09-01', is_active: true,
    shift_start: '07:00', shift_end: '07:00', shift_hours: 24
  }, extra || {}) };
}

function validRotations(extraByCrew) {
  const extras = extraByCrew || {};
  return [['A', 0], ['B', 1], ['C', 2]].map(([crew, position]) =>
    rotation(crew, position, extras[crew]));
}

function override(id, extra) {
  return { id, value: Object.assign({
    date: id, kind: 'standby', crew: '', extra_crews: ['B']
  }, extra || {}) };
}

function input(extra) {
  return Object.assign({ mode: 'shadow', rotations: validRotations(), overrides: [] }, extra || {});
}

function rejects(code, extra) {
  assert.throws(() => compat.projectLegacyScheduleCompatibility(input(extra)),
    (error) => error.code === code, code);
}

test('compatibility range accepts exact canonical inclusive boundaries up to 397 days', () => {
  const oneDay = compat.parseLegacyCompatibilityRange({
    from: '2026-09-01', to: '2026-09-01'
  });
  assert.deepEqual(oneDay, { from: '2026-09-01', to: '2026-09-01', days: 1 });
  assert.equal(Object.isFrozen(oneDay), true);
  const maximum = compat.parseLegacyCompatibilityRange({
    from: '2026-09-01', to: '2027-10-02'
  });
  assert.equal(maximum.days, 397);
  assert.equal(compat.MAX_OVERRIDES, 397);
});

test('compatibility range rejects missing, foreign and non-object request fields', () => {
  for (const value of [undefined, null, [], {},
    { from: '2026-09-01' }, { to: '2026-09-01' },
    { from: '2026-09-01', to: '2026-09-01', sid: 'foreign' },
    { from: '2026-09-01', to: '2026-09-01', stationId: 'foreign' }]) {
    assert.throws(() => compat.parseLegacyCompatibilityRange(value),
      (error) => error.code === 'legacy-compatibility-request');
  }
});

test('compatibility range rejects impossible, reversed and 398-day ranges', () => {
  for (const value of [
    { from: '2026-02-30', to: '2026-09-01' },
    { from: '2026-09-01', to: 'not-a-date' },
    { from: '2026-09-02', to: '2026-09-01' },
    { from: '2026-09-01', to: '2027-10-03' }
  ]) {
    assert.throws(() => compat.parseLegacyCompatibilityRange(value),
      (error) => error.code === 'legacy-compatibility-range');
  }
});

test('off and shadow return the exact public response shape', () => {
  for (const mode of ['off', 'shadow']) {
    const out = compat.projectLegacyScheduleCompatibility(input({
      mode, overrides: [override('2026-09-01')]
    }));
    assert.deepEqual(Object.keys(out), ['mode', 'rotations', 'overrides']);
    assert.equal(out.mode, mode);
    assert.deepEqual(out.rotations.map((row) => row.crew), ['A', 'B', 'C']);
    assert.deepEqual(out.overrides['2026-09-01'], {
      date: '2026-09-01', kind: 'standby', crew: '', extra_crews: ['B']
    });
  }
});

test('new and unknown modes are rejected instead of exposing stale legacy data', () => {
  for (const mode of ['new', 'invalid', '', undefined]) {
    assert.throws(() => compat.projectLegacyScheduleCompatibility({
      mode, rotations: [], overrides: []
    }), (error) => error.code === 'legacy-compatibility-input', String(mode));
  }
});

test('rotation projection is an allowlist, not a copied raw document', () => {
  const out = compat.projectLegacyScheduleCompatibility(input({
    rotations: validRotations({ A: {
      note: 'medical note', email: 'person@example.test', medical: 'private',
      by_uid: 'manager', created_at: 'timestamp', updated_at: 'timestamp',
      unknown_future_field: 'must not escape'
    } })
  }));
  assert.deepEqual(Object.keys(out.rotations[0]).sort(), compat.ROTATION_FIELDS.slice().sort());
  const serialized = JSON.stringify(out);
  for (const secret of ['medical note', 'person@example.test', 'private', 'manager',
    'timestamp', 'must not escape']) assert.equal(serialized.includes(secret), false, secret);
});

test('override projection uses the document id and omits every sensitive or unknown field', () => {
  const out = compat.projectLegacyScheduleCompatibility(input({
    mode: 'off', overrides: [override('2026-09-02', {
      extra_crews: ['B', 'C'], note: 'medical note', email: 'person@example.test',
      medical: 'private', by_uid: 'manager', created_at: 'timestamp',
      updated_at: 'timestamp', unknown_future_field: 'must not escape'
    })]
  }));
  assert.deepEqual(out.overrides['2026-09-02'], {
    date: '2026-09-02', kind: 'standby', crew: '', extra_crews: ['B', 'C']
  });
  const serialized = JSON.stringify(out);
  for (const secret of ['medical note', 'person@example.test', 'private', 'manager',
    'timestamp', 'must not escape']) assert.equal(serialized.includes(secret), false, secret);
});

test('a complete active A/B/C cycle is mandatory and inactive rows never affect output order', () => {
  rejects('legacy-rotation-active-cycle', { rotations: [] });
  rejects('legacy-rotation-active-cycle', {
    rotations: validRotations({ A: { is_active: false }, B: { is_active: false }, C: { is_active: false } })
  });
  rejects('legacy-rotation-crew', {
    rotations: [rotation('A', 0), rotation('A', 1, {}, 'duplicate'), rotation('C', 2)]
  });
  rejects('legacy-rotation-crew', {
    rotations: [rotation('A', 0), rotation('B', 1), rotation('X', 2)]
  });
  const inactiveFirst = rotation('A', 0, {
    is_active: false, shift_start: '01:00', shift_end: '02:00', shift_hours: 1
  }, '00_inactive');
  const out = compat.projectLegacyScheduleCompatibility(input({
    rotations: [inactiveFirst].concat(validRotations())
  }));
  assert.deepEqual(out.rotations.map((row) => row.crew), ['A', 'B', 'C']);
  assert.equal(out.rotations[0].shift_start, '07:00');
  assert.equal(out.rotations.some((row) => row.is_active === false), false);
});

test('cycle anchor, length and positions must be canonical and consistent', () => {
  rejects('legacy-rotation-anchor', {
    rotations: validRotations({ B: { anchor_date: '2026-02-30' } })
  });
  rejects('legacy-rotation-anchor', {
    rotations: validRotations({ B: { anchor_date: '2026-09-02' } })
  });
  rejects('legacy-rotation-cycle', {
    rotations: validRotations({ A: { cycle_days: -1 } })
  });
  rejects('legacy-rotation-cycle', {
    rotations: validRotations({ A: { cycle_days: 4 }, B: { cycle_days: 4 }, C: { cycle_days: 4 } })
  });
  rejects('legacy-rotation-position', {
    rotations: validRotations({ C: { position_in_cycle: 1 } })
  });
  const normalized = compat.projectLegacyScheduleCompatibility(input({
    rotations: validRotations({ B: { cycle_days: '3', position_in_cycle: '1' } })
  }));
  assert.equal(normalized.rotations[1].cycle_days, 3);
  assert.equal(normalized.rotations[1].position_in_cycle, 1);
  for (const badCycle of [true, [3], ['3'], { valueOf: () => 3 }]) {
    rejects('legacy-rotation-cycle', {
      rotations: validRotations({ A: { cycle_days: badCycle } })
    });
  }
  for (const badPosition of [true, [0], ['0'], { valueOf: () => 0 }]) {
    rejects('legacy-rotation-position', {
      rotations: validRotations({ A: { position_in_cycle: badPosition } })
    });
  }
});

test('active flags, clock fields and hour fields are strict and consistent', () => {
  rejects('legacy-rotation-active-flag', {
    rotations: validRotations({ A: { is_active: null } })
  });
  rejects('legacy-rotation-time', {
    rotations: validRotations({ A: { shift_start: '25:00' }, B: { shift_start: '25:00' }, C: { shift_start: '25:00' } })
  });
  const defaults = compat.projectLegacyScheduleCompatibility(input({
    rotations: validRotations({
      A: { commander_start: null }, B: { commander_start: '' }, C: { commander_start: undefined }
    })
  }));
  assert.ok(defaults.rotations.every((row) => row.commander_start === ''));
  rejects('legacy-rotation-hours', {
    rotations: validRotations({ A: { shift_hours: 0 }, B: { shift_hours: 0 }, C: { shift_hours: 0 } })
  });
  rejects('legacy-rotation-hours', {
    rotations: validRotations({ A: { shift_hours: 24.333 }, B: { shift_hours: 24.333 }, C: { shift_hours: 24.333 } })
  });
  for (const nonScalarHours of [true, [24], ['24'], { valueOf: () => 24 }]) {
    rejects('legacy-rotation-hours', {
      rotations: validRotations({
        A: { shift_hours: nonScalarHours },
        B: { shift_hours: nonScalarHours },
        C: { shift_hours: nonScalarHours }
      })
    });
  }
  const stringHours = compat.projectLegacyScheduleCompatibility(input({
    rotations: validRotations({ A: { shift_hours: '24' } })
  }));
  assert.ok(stringHours.rotations.every((row) => row.shift_hours === 24));
  const consensus = compat.projectLegacyScheduleCompatibility(input({
    rotations: validRotations({ A: { special_end: '06:00' } })
  }));
  assert.ok(consensus.rotations.every((row) => row.special_end === '06:00'));
  rejects('legacy-rotation-field-consistency', {
    rotations: validRotations({ A: { special_end: '06:00' }, B: { special_end: '08:00' } })
  });
});

test('override kinds form a closed set with kind-specific crew semantics', () => {
  rejects('legacy-override-kind', {
    overrides: [override('2026-09-01', { kind: 'unknown' })]
  });
  rejects('legacy-override-crew', {
    overrides: [override('2026-09-01', { kind: 'swap', crew: 'X', extra_crews: [] })]
  });
  rejects('legacy-override-assignment', {
    overrides: [override('2026-09-01', { kind: 'swap', crew: 'B', extra_crews: ['C'] })]
  });
  rejects('legacy-override-assignment', {
    overrides: [override('2026-09-01', { kind: 'standby', crew: 'A' })]
  });
  rejects('legacy-override-extra-crews', {
    overrides: [override('2026-09-01', { kind: 'standby', extra_crews: [] })]
  });
  rejects('legacy-override-extra-crews', {
    overrides: [override('2026-09-01', { kind: 'standby', extra_crews: ['B', 'B'] })]
  });
  for (const kind of ['holiday', 'training']) {
    rejects('legacy-override-assignment', {
      overrides: [override('2026-09-01', { kind, crew: 'A', extra_crews: [] })]
    });
  }
});

test('override payload dates normalize absent values and reject only a nonempty mismatch', () => {
  for (const date of [undefined, null, '']) {
    const out = compat.projectLegacyScheduleCompatibility(input({
      overrides: [{ id: '2026-09-01', value: { date, kind: 'holiday' } }]
    }));
    assert.equal(out.overrides['2026-09-01'].date, '2026-09-01');
  }
  rejects('legacy-override-date-mismatch', {
    overrides: [override('2026-09-01', { date: '2026-09-02' })]
  });
});

test('historic assignment-neutral overrides still satisfy the exact client contract', () => {
  const out = compat.projectLegacyScheduleCompatibility(input({
    mode: 'off', overrides: [{ id: '2026-09-03', value: { kind: 'holiday' } }]
  }));
  assert.deepEqual(out.overrides['2026-09-03'], {
    date: '2026-09-03', kind: 'holiday', crew: '', extra_crews: []
  });
  assert.equal(Object.isFrozen(out.overrides['2026-09-03'].extra_crews), true);
});

test('invalid calendar document ids and duplicate dates fail closed', () => {
  rejects('legacy-override-date-invalid', { overrides: [override('2026-02-30')] });
  rejects('legacy-override-duplicate', {
    overrides: [override('2026-09-01'), override('2026-09-01')]
  });
});

test('nested values cannot use an allowed field as a privacy tunnel', () => {
  rejects('legacy-rotation-time', {
    rotations: validRotations({
      A: { shift_start: { email: 'private@example.test' } },
      B: { shift_start: { email: 'private@example.test' } },
      C: { shift_start: { email: 'private@example.test' } }
    })
  });
  rejects('legacy-field-invalid', {
    overrides: [override('2026-09-01', { extra_crews: ['B', { email: 'private@example.test' }] })]
  });
});

test('output and nested arrays are immutable detached copies', () => {
  const extras = ['B'];
  const out = compat.projectLegacyScheduleCompatibility(input({
    overrides: [override('2026-09-01', { extra_crews: extras })]
  }));
  extras.push('C');
  assert.deepEqual(out.overrides['2026-09-01'].extra_crews, ['B']);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.rotations), true);
  assert.equal(Object.isFrozen(out.overrides), true);
  assert.equal(Object.isFrozen(out.overrides['2026-09-01'].extra_crews), true);
});

test('both collection caps accept the boundary and reject one extra row', () => {
  const rotations = validRotations();
  for (let index = 0; index < compat.MAX_ROTATIONS - 3; index += 1) {
    rotations.push(rotation('A', 0, { is_active: false }, 'inactive_' + index));
  }
  const overrides = Array.from({ length: compat.MAX_OVERRIDES }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
    return { id: date, value: { date, kind: 'holiday' } };
  });
  const accepted = compat.projectLegacyScheduleCompatibility(input({ mode: 'off', rotations, overrides }));
  assert.equal(accepted.rotations.length, 3);
  assert.equal(Object.keys(accepted.overrides).length, compat.MAX_OVERRIDES);
  assert.throws(() => compat.projectLegacyScheduleCompatibility(input({
    mode: 'off', rotations: rotations.concat(rotation('A', 0, { is_active: false }, 'overflow')),
    overrides: []
  })), (error) => error.code === 'legacy-rotations-too-large');
  assert.throws(() => compat.projectLegacyScheduleCompatibility(input({
    mode: 'off', overrides: overrides.concat({
      id: '2027-05-16', value: { date: '2027-05-16', kind: 'holiday' }
    })
  })), (error) => error.code === 'legacy-overrides-too-large');
});

assert.equal(passed, 17);
console.log('\n17 legacy schedule compatibility unit checks passed.');
