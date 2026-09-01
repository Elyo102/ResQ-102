'use strict';

// Adversarial compatibility checks for the one current appointment contract.
// These make an accidental import of the obsolete token/grant architecture
// visible without introducing that architecture into the application.

const assert = require('node:assert/strict');
const access = require('./schedule-access');

const SID = 'eilat_102';
const UID = 'firefighter_1';
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log('✓ ' + name);
}

function legacyStyleGrant(extra) {
  return Object.assign({
    active: true,
    uid: UID,
    stationId: SID,
    schedule_manager: true,
    version: 'old-token-version',
    schedule_manager_version: 'old-token-version'
  }, extra || {});
}

test('a token/grant-style record is never mistaken for the current local appointment', () => {
  assert.equal(access.isManagerAccess(legacyStyleGrant(), SID, UID), false);
  assert.equal(access.isManagerAccess(legacyStyleGrant({ roles: ['schedule_manager'] }), SID, UID), false);
  assert.equal(access.isManagerAccess(legacyStyleGrant({
    schema_version: 1,
    station_id: SID,
    roles: ['schedule_manager'],
    active: false
  }), SID, UID), false);
});

test('nextRecord emits only the canonical local capability and discards alternate authority fields', () => {
  const previous = Object.assign(legacyStyleGrant(), {
    schema_version: 1,
    station_id: SID,
    roles: ['schedule_manager'],
    revision: 8,
    revoked_at: 'not-used-here',
    primary_role: 'station_commander'
  });
  const record = access.nextRecord(previous, SID, UID, true);
  assert.deepEqual(record, {
    schema_version: 1,
    station_id: SID,
    uid: UID,
    roles: ['schedule_manager'],
    active: true,
    revision: 9
  });
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'schedule_manager'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'version'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'revoked_at'), false);
  assert.equal(access.isManagerAccess(record, SID, UID), true);
});

test('the appointment remains station-local and exact even when unrelated primary-role fields are present', () => {
  const valid = access.nextRecord(null, SID, UID, true);
  const withPrimaryRole = Object.assign({}, valid, { primary_role: 'station_commander' });
  assert.equal(access.isManagerAccess(withPrimaryRole, SID, UID), true);
  assert.equal(access.isManagerAccess(Object.assign({}, withPrimaryRole, { station_id: 'other_102' }), SID, UID), false);
  assert.equal(access.isManagerAccess(Object.assign({}, withPrimaryRole, { uid: 'other_user' }), SID, UID), false);
  assert.equal(access.isManagerAccess(Object.assign({}, withPrimaryRole, {
    roles: ['schedule_manager', 'another_capability']
  }), SID, UID), false);
});

assert.equal(passed, 3);
console.log('\n3 schedule-access contract checks passed.');
