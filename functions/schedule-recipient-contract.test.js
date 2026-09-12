'use strict';
const assert = require('node:assert/strict');
const subject = require('./schedule-recipient-contract');

function person(id, extra) {
  return Object.assign({ person_id:id, station_id:'eilat_102', kind:'external', linked_uid:null,
    display_name:'שם זהה', active:true, revision:1 }, extra || {});
}
const people = [
  person('sp_external_01'),
  person('sp_registered_01', { kind:'registered', linked_uid:'uid_1' }),
  person('sp_inactive_001', { kind:'registered', linked_uid:'uid_2', active:false })
];
const verifiedUsers = [
  { uid:'uid_1', active:true, station_id:'eilat_102' },
  { uid:'uid_2', active:true, station_id:'eilat_102' }
];
assert.deepEqual(subject.recipientsForChanges({ station_id:'eilat_102',
  changed_person_ids:['sp_external_01', 'sp_registered_01', 'sp_inactive_001'], people, verified_users:verifiedUsers }), [
  { person_id:'sp_registered_01', uid:'uid_1' }
]);
assert.deepEqual(subject.recipientsForChanges({ station_id:'eilat_102', changed_person_ids:[], people, verified_users:verifiedUsers }), []);
assert.throws(() => subject.recipientsForChanges({ station_id:'eilat_102',
  changed_person_ids:['sp_missing_001'], people, verified_users:verifiedUsers }), /אינו קיים/);
assert.throws(() => subject.recipientsForChanges({ station_id:'eilat_102',
  changed_person_ids:['sp_registered_01', 'sp_registered_01'], people, verified_users:verifiedUsers }), /כפילות/);
assert.throws(() => subject.recipientsForChanges({ station_id:'eilat_102',
  changed_person_ids:['sp_registered_01'], verified_users:verifiedUsers,
  people:[people[1], person('sp_registered_02', { kind:'registered', linked_uid:'uid_1' })] }), /יותר מאדם/);
assert.throws(() => subject.recipientsForChanges({ station_id:'eilat_102',
  changed_person_ids:['sp_other_0001'], verified_users:[],
  people:[person('sp_other_0001', { station_id:'other_102' })] }), /מתחנה אחרת/);
assert.deepEqual(subject.recipientsForChanges({ station_id:'eilat_102',
  changed_person_ids:['sp_registered_01'], people,
  verified_users:[{ uid:'uid_1', active:false, station_id:'eilat_102' }] }), []);
assert.throws(() => subject.recipientsForChanges({ station_id:'eilat_102',
  changed_person_ids:['sp_registered_01'], people, verified_users:[] }),
  (error) => error && error.code === 'verified-user-missing');
console.log('8 schedule-recipient contract checks passed.');
