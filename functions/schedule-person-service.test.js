'use strict';
const assert = require('node:assert/strict');
const subject = require('./schedule-person-service');

const person = { person_id:'sp_person_001', station_id:'eilat_102', kind:'external', linked_uid:null,
  display_name:'אותו שם', active:true, revision:4 };
const input = { person, expected_revision:4, actor_uid:'admin_1', uid:'uid_1',
  actor:{ uid:'admin_1', station_id:'eilat_102', authorized:true },
  expected_link_revision:2,
  link_index:{ uid:'uid_1', person_id:null, revision:2 },
  user:{ exists:true, active:true, station_id:'eilat_102', uid:'uid_1' } };
const linked = subject.planLink(input);
assert.equal(linked.after.person_id, person.person_id);
assert.equal(linked.after.kind, 'registered');
assert.equal(linked.after.linked_uid, 'uid_1');
assert.equal(linked.after.revision, 5);
assert.throws(() => subject.planLink(Object.assign({}, input, { expected_revision:3 })), /השתנה/);
assert.throws(() => subject.planLink(Object.assign({}, input, {
  link_index:{ uid:'uid_1', person_id:'sp_other_001', revision:2 }
})), /כבר מקושר/);
assert.throws(() => subject.planLink(Object.assign({}, input, { expected_link_revision:1 })), /אינדקס/);
assert.throws(() => subject.planLink(Object.assign({}, input, { user:Object.assign({}, input.user, { station_id:'other_102' }) })), /באותה תחנה/);
assert.throws(() => subject.planLink(Object.assign({}, input, { user:Object.assign({}, input.user, { active:false }) })), /פעיל/);
assert.throws(() => subject.planLink(Object.assign({}, input, {
  actor:{ uid:'admin_1', station_id:'other_102', authorized:true }
})), /הרשאה/);
const unlinked = subject.planUnlink({ person:linked.after, expected_revision:5, actor_uid:'admin_1',
  actor:{ uid:'admin_1', station_id:'eilat_102', authorized:true }, expected_link_revision:3,
  link_index:{ uid:'uid_1', person_id:'sp_person_001', revision:3 } });
assert.equal(unlinked.after.person_id, person.person_id);
assert.equal(unlinked.after.kind, 'external');
assert.equal(unlinked.after.linked_uid, null);
assert.equal(unlinked.link_index_after.person_id, null);
console.log('14 schedule-person service checks passed.');
