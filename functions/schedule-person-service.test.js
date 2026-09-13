'use strict';
const assert = require('node:assert/strict');
const subject = require('./schedule-person-service');

const person = { schema_version:1, person_id:'sp_person_001', station_id:'eilat_102', kind:'external', linked_uid:null,
  display_name:'אותו שם', active:true, revision:4,
  source_ref:{ station_id:'eilat_102', source_namespace:'station-workbook-v1',
    source_key:{ kind:'employee', value:'00123' } } };
const input = { person, expected_revision:4, actor_uid:'admin_1', uid:'uid_1',
  actor:{ uid:'admin_1', station_id:'eilat_102', authorized:true },
  station_link:null, global_link:null,
  user:{ exists:true, active:true, station_id:'eilat_102', uid:'uid_1' } };
const linked = subject.planLink(input);
assert.equal(linked.after.person_id, person.person_id);
assert.equal(linked.after.kind, 'registered');
assert.equal(linked.after.linked_uid, 'uid_1');
assert.equal(linked.after.revision, 5);
assert.throws(() => subject.planLink(Object.assign({}, input, { expected_revision:3 })), /השתנה/);
assert.throws(() => subject.planLink(Object.assign({}, input, {
  person:{ ...person, active:false }
})), /לא פעיל/);
assert.equal(linked.after.source_ref.source_key.value, '00123');
assert.equal(linked.reservation.status, 'bound');
assert.throws(() => subject.planLink(Object.assign({}, input, {
  global_link:{ station_id:'other_102', person_id:'sp_other_001' }
})), /כבר קושר/);
assert.throws(() => subject.planLink(Object.assign({}, input, { user:Object.assign({}, input.user, { station_id:'other_102' }) })), /באותה תחנה/);
assert.throws(() => subject.planLink(Object.assign({}, input, { user:Object.assign({}, input.user, { active:false }) })), /פעיל/);
assert.throws(() => subject.planLink(Object.assign({}, input, {
  person:Object.assign({}, person, { active:false })
})), (error) => error.code === 'link-inactive');
assert.throws(() => subject.planLink(Object.assign({}, input, {
  actor:{ uid:'admin_1', station_id:'other_102', authorized:true }
})), /הרשאה/);
assert.equal(subject.planUnlink, undefined);
console.log('15 schedule-person service checks passed.');
