'use strict';
const assert = require('node:assert/strict');
const subject = require('./schedule-person-contract');

const external = { person_id:'sp_person_001', station_id:'eilat_102', kind:'external',
  linked_uid:null, display_name:'יוסי כהן', active:true, revision:1 };
const registered = Object.assign({}, external, { kind:'registered', linked_uid:'uid_1' });
assert.deepEqual(subject.normalizeSchedulePerson(external), Object.assign({ schema_version:1 }, external));
assert.deepEqual(subject.normalizeSchedulePerson(registered), Object.assign({ schema_version:1 }, registered));
assert.throws(() => subject.normalizeSchedulePerson(Object.assign({}, external, { linked_uid:'uid_1' })), /חיצוני/);
assert.throws(() => subject.normalizeSchedulePerson(Object.assign({}, registered, { linked_uid:null })), /רשום/);
assert.throws(() => subject.normalizeSchedulePerson(Object.assign({}, external, { station_id:'' })), /תחנה/);
assert.throws(() => subject.normalizeSchedulePerson(Object.assign({}, registered, { linked_uid:'sp_account_001' })),
  (error) => error && error.code === 'linked-uid');
assert.throws(() => subject.normalizeSchedulePerson(Object.assign({}, registered, { linked_uid:'u'.repeat(129) })),
  (error) => error && error.code === 'linked-uid');
assert.deepEqual(subject.publicSchedulePerson(registered), {
  person_id:'sp_person_001', station_id:'eilat_102', display_name:'יוסי כהן', active:true
});
assert.equal(Object.prototype.hasOwnProperty.call(subject.publicSchedulePerson(registered), 'linked_uid'), false);
console.log('9 schedule-person contract checks passed.');
