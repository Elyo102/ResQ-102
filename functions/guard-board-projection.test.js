'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const projection = require('./guard-board-projection');

const DATES = ['2026-09-01', '2026-09-02'];
const ROSTER = [
  { uid: 'viewer.uid', active: true },
  { uid: 'worker_a', active: true },
  { uid: 'former_worker', active: false }
];

function guard(patch) {
  return Object.assign({
    id: 'guard_001',
    value: {
      title: 'אבטחת משחק', kind: 'sport', place: 'מקום סודי',
      date: '2026-09-01', start: '22:00', end: '06:00', status: 'open', slots: 2,
      need_quals: ['driver'], notes: 'הערה רפואית שאסור להציג', revision: 3,
      assigned: [], signups: {}, by_uid: 'creator_uid', assignment_epochs: { worker_a: 2 },
      created_at: 'never-copy-me', future_secret: 'never-copy-me-either'
    }
  }, patch || {});
}

function input(patch) {
  return Object.assign({ station_id: 'station_102', dates: DATES, roster: ROSTER,
    viewer_uid: 'viewer.uid', guards: [guard()] }, patch || {});
}

test('member board preserves a genuinely unstaffed open guard', () => {
  const rows = projection.memberBoard(input());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'guard_001', date: '2026-09-01', title: 'אבטחת משחק', kind: 'sport',
    start: '22:00', end: '06:00', status: 'open', slots: 2,
    assigned_count: 0, open_slots: 2, viewer_assigned: false, viewer_signed_up: false
  });
});

test('member board is a whitelist and cannot leak raw or future fields', () => {
  const rows = projection.memberBoard(input({ guards: [guard({ value: Object.assign({}, guard().value, {
    assigned: ['worker_a'], signups: { 'viewer.uid': { name: 'אלדד', crew: 'A' } }
  }) })] }));
  assert.equal(rows[0].viewer_signed_up, true);
  assert.equal(rows[0].assigned_count, 1);
  const serialized = JSON.stringify(rows);
  for (const forbidden of ['מקום סודי', 'הערה רפואית', 'creator_uid', 'assignment_epochs',
    'never-copy-me', 'future_secret', 'worker_a', 'אלדד']) {
    assert.equal(serialized.includes(forbidden), false, forbidden + ' leaked to a member');
  }
});

test('manager board contains only manager action fields and signed-up active people', () => {
  const value = Object.assign({}, guard().value, {
    assigned: ['worker_a', 'former_worker'],
    signups: {
      'viewer.uid': { name: 'אלדד', crew: 'A', at: 'never-return-this' },
      former_worker: { name: 'עבר', crew: 'B' }
    }
  });
  const rows = projection.managerBoard(input({ guards: [guard({ value })] }));
  assert.deepEqual(rows, [{
    id: 'guard_001', date: '2026-09-01', title: 'אבטחת משחק', kind: 'sport',
    place: 'מקום סודי', start: '22:00', end: '06:00', status: 'open', slots: 2,
    need_quals: ['driver'], notes: 'הערה רפואית שאסור להציג', revision: 3,
    assigned: ['former_worker', 'worker_a'],
    signups: [{ uid: 'viewer.uid', name: 'אלדד', crew: 'A' }]
  }]);
  const serialized = JSON.stringify(rows);
  for (const forbidden of ['by_uid', 'creator_uid', 'assignment_epochs', 'created_at',
    'never-copy-me', 'future_secret', 'never-return-this']) {
    assert.equal(serialized.includes(forbidden), false, forbidden + ' leaked to a manager');
  }
});

test('personal attendance returns only the authenticated person and never location or colleagues', () => {
  const rows = projection.personalAttendance(input({ guards: [
    guard({ value: Object.assign({}, guard().value, { assigned: ['viewer.uid', 'worker_a'] }) }),
    guard({ id: 'guard_002', value: Object.assign({}, guard().value, {
      date: '2026-09-02', assigned: ['worker_a']
    }) })
  ] }));
  assert.deepEqual(rows, [{
    id: 'guard_001', date: '2026-09-01', title: 'אבטחת משחק',
    start: '22:00', end: '06:00', status: 'open'
  }]);
  const serialized = JSON.stringify(rows);
  for (const forbidden of ['מקום סודי', 'הערה רפואית', 'worker_a', 'viewer.uid', 'signups']) {
    assert.equal(serialized.includes(forbidden), false, forbidden + ' leaked to personal attendance');
  }
});

test('load rows retain only date, duration, state and staff assignment identifiers', () => {
  const rows = projection.loadRows(input({ guards: [guard({ value: Object.assign({}, guard().value, {
    assigned: ['viewer.uid', 'worker_a']
  }) })] }));
  assert.deepEqual(rows, [{
    date: '2026-09-01', start: '22:00', end: '06:00', status: 'open',
    assigned: ['viewer.uid', 'worker_a']
  }]);
  const serialized = JSON.stringify(rows);
  for (const forbidden of ['מקום סודי', 'הערה רפואית', 'signups', 'creator_uid', 'assignment_epochs']) {
    assert.equal(serialized.includes(forbidden), false, forbidden + ' leaked to load statistics');
  }
});

test('station mismatch, malformed assignment and invalid date fail closed without hiding valid neighbors', () => {
  const valid = guard();
  const wrongStation = guard({ id: 'guard_002', value: Object.assign({}, guard().value, { station_id: 'other_station' }) });
  const badAssigned = guard({ id: 'guard_003', value: Object.assign({}, guard().value, { assigned: ['bad/uid'] }) });
  const wrongDate = guard({ id: 'guard_004', value: Object.assign({}, guard().value, { date: '2026-09-09' }) });
  const rows = projection.memberBoard(input({ guards: [wrongDate, badAssigned, wrongStation, valid] }));
  assert.deepEqual(rows.map((row) => row.id), ['guard_001']);
});

test('inactive viewer, invalid UIDs and invalid input have no projection', () => {
  assert.deepEqual(projection.memberBoard(input({ viewer_uid: 'former_worker' })), []);
  assert.deepEqual(projection.memberBoard(input({ viewer_uid: 'bad/uid' })), []);
  assert.deepEqual(projection.memberBoard(Object.assign({}, input(), { dates: [] })), []);
  assert.deepEqual(projection.managerBoard(Object.assign({}, input(), { station_id: 'bad/station' })), []);
});

test('dotted Firebase UIDs remain valid while slash and control characters are rejected', () => {
  const dotted = projection.managerBoard(input({ guards: [guard({ value: Object.assign({}, guard().value, {
    assigned: ['viewer.uid'], signups: { 'viewer.uid': { name: 'דוט', crew: '' } }
  }) })] }));
  assert.deepEqual(dotted[0].assigned, ['viewer.uid']);
  assert.deepEqual(dotted[0].signups, [{ uid: 'viewer.uid', name: 'דוט', crew: '' }]);
  for (const bad of ['bad/uid', 'bad\nuid', '']) {
    assert.deepEqual(projection.managerBoard(input({ guards: [guard({ value: Object.assign({}, guard().value, {
      assigned: [bad]
    }) })] })), []);
  }
});

test('overnight guards and cancelled guards remain representable; the screen decides history visibility', () => {
  const rows = projection.memberBoard(input({ guards: [guard({ value: Object.assign({}, guard().value, {
    status: 'cancelled', start: '22:00', end: '06:00'
  }) })] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].start, '22:00');
  assert.equal(rows[0].end, '06:00');
});
