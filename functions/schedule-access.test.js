'use strict';

const assert = require('node:assert/strict');
const access = require('./schedule-access');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('✓ ' + name);
}

const SID = 'station_102';
const UID = 'uid_abc123';

function person(extra) {
  return Object.assign({ station: SID, active: true, role: 'firefighter' }, extra || {});
}

function manager(extra) {
  return Object.assign({
    schema_version: 1, station_id: SID, uid: UID,
    roles: ['schedule_manager'], active: true, revision: 1
  }, extra || {});
}

test('station alias written by the identity coordinator is accepted', () => {
  assert.deepEqual(access.liveStation(person()), { ok: true, stationId: SID });
});

test('matching station aliases are accepted', () => {
  assert.deepEqual(access.liveStation(person({ stationId: SID, station_id: SID })),
    { ok: true, stationId: SID });
});

test('conflicting or malformed station aliases fail closed', () => {
  assert.equal(access.liveStation(person({ stationId: 'other_station' })).ok, false);
  assert.equal(access.liveStation(person({ stationId: 'bad station' })).ok, false);
  assert.equal(access.liveStation(person({ station: '' })).ok, false);
});

test('an active member must have the requested live station', () => {
  assert.equal(access.activeMember(person(), SID), true);
  assert.equal(access.activeMember(person({ active: false }), SID), false);
  assert.equal(access.activeMember(person({ station: 'other_station' }), SID), false);
});

test('only the exact live local schedule-manager record grants management', () => {
  assert.equal(access.isManagerAccess(manager(), SID, UID), true);
  assert.equal(access.isManagerAccess(manager({ station_id: 'other_station' }), SID, UID), false);
  assert.equal(access.isManagerAccess(manager({ uid: 'uid_elsewhere' }), SID, UID), false);
  assert.equal(access.isManagerAccess(manager({ roles: ['commander'] }), SID, UID), false);
  assert.equal(access.isManagerAccess(manager({ roles: ['schedule_manager', 'other'] }), SID, UID), false);
  assert.equal(access.isManagerAccess(manager({ active: false }), SID, UID), false);
});

test('a live record is versioned and revocation clears the only role', () => {
  const grant = access.nextRecord(null, SID, UID, true);
  assert.deepEqual(grant, {
    schema_version: 1, station_id: SID, uid: UID,
    roles: ['schedule_manager'], active: true, revision: 1
  });
  const revoke = access.nextRecord(grant, SID, UID, false);
  assert.equal(revoke.active, false);
  assert.deepEqual(revoke.roles, []);
  assert.equal(revoke.revision, 2);
  assert.equal(access.isManagerAccess(revoke, SID, UID), false);
});

test('invalid ids or enable flags cannot create an access record', () => {
  assert.throws(() => access.nextRecord(null, 'bad station', UID, true), /invalid/);
  assert.throws(() => access.nextRecord(null, SID, UID, 'yes'), /invalid/);
  assert.equal(access.isManagerAccess(manager(), SID, '__proto__'), false);
});

assert.equal(passed, 7);
console.log('\n7 schedule access unit checks passed.');
