'use strict';

const assert = require('node:assert/strict');
const { buildRosterCandidates } = require('./schedule-roster-candidates');

const stationId = 'test_station';
const policy = { sub_stations: {
  main: { requirements: [{ role: 'fighter' }, { role: 'driver' }] }
} };
const user = (uid, employee) => ({ uid, employee_number: employee, full_name: 'בדיקה ' + uid });
const old = (uid, sub = 'main', roles = ['fighter']) =>
  ({ id: uid, sub_station: sub, roles, active: true });
const index = (employee, uid, extra = {}) => new Map([[employee, Object.assign({
  uid, stationId, active: true, retired: false
}, extra)]]);
const build = (users, previous, indexes) => buildRosterCandidates({
  stationId, users, previous, policy, indexes
});

assert.deepEqual(build([user('a', '101')], [old('a')], index('101', 'a'))[0].roles,
  ['fighter'], 'signed UID assignment should be offered for manager review');
assert.equal(build([user('a', '101')], [old('a')], index('101', 'a'))[0].status,
  'carried_for_review');
assert.equal(build([user('b', '102')], [old('a')], index('102', 'b'))[0].status,
  'needs_assignment', 'new UID may not inherit another user assignment');
assert.equal(build([user('a', '101')], [old('a', 'removed')], index('101', 'a'))[0].status,
  'needs_assignment', 'removed sub-station must not be carried');
assert.equal(build([user('a', '101')], [old('a', 'main', ['unknown'])], index('101', 'a'))[0].status,
  'needs_assignment', 'removed role must not be carried');
assert.equal(build([user('a', '101')], [old('a')], index('101', 'other'))[0].status,
  'identity_conflict', 'wrong index UID blocks activation');
assert.equal(build([user('a', '101')], [old('a')], index('101', 'a', { retired:true }))[0].status,
  'identity_conflict', 'retired index blocks activation');
assert.ok(build([user('a', '101'), user('b', '101')], [old('a')], index('101', 'a'))
  .every((row) => row.status === 'identity_conflict'), 'duplicate employee number blocks both');
assert.equal(build([user('a', '')], [old('a')], new Map())[0].status,
  'identity_conflict', 'missing employee number is visible, not skipped');
assert.equal(build([user('a', '101')], [old('a'), old('a')], index('101', 'a'))[0].status,
  'needs_assignment', 'duplicate signed UID must not be inherited');
const disabled = Object.assign(old('a'), { active: false, group: 'C' });
assert.equal(build([user('a', '101')], [disabled], index('101', 'a'))[0].active, false,
  'signed inactive worker must not be reactivated by the editor');
assert.equal(build([user('a', '101')], [disabled], index('101', 'a'))[0].group, 'C',
  'signed rotation group must survive roster editing');

console.log('Schedule roster candidates: 12 PASS');
