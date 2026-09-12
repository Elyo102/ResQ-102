'use strict';

const assert = require('node:assert/strict');
const subject = require('./schedule-identity-store-contract');

assert.deepEqual(subject.COLLECTIONS, {
  people:'schedule_people', bindings:'schedule_source_bindings',
  link_index:'schedule_person_link_index', state:'schedule_identity_state',
  operations:'schedule_identity_operations', audit:'schedule_identity_audit'
});
assert.equal(subject.STATE_DOCUMENT, 'current');

const key = { kind:'employee', value:'00123' };
const binding = subject.bindingDocumentId('station-workbook-v1', key);
assert.match(binding, /^sb_[a-f0-9]{48}$/);
assert.equal(binding, subject.bindingDocumentId('station-workbook-v1', key));
assert.notEqual(binding, subject.bindingDocumentId('station-workbook-v1', { kind:'employee', value:'123' }));
assert.throws(() => subject.bindingDocumentId('other', key), (error) => error.code === 'source-namespace');

const link = subject.linkIndexDocumentId('uid@example.com');
assert.match(link, /^sl_[a-f0-9]{48}$/);
assert.equal(link, subject.linkIndexDocumentId('uid@example.com'));
assert.notEqual(link, subject.linkIndexDocumentId('other@example.com'));
assert.equal(link.includes('uid@example.com'), false);
assert.throws(() => subject.linkIndexDocumentId('sp_person_001'), (error) => error.code === 'linked-uid');

const operation = subject.operationDocumentId('request_001');
assert.match(operation, /^so_[a-f0-9]{48}$/);
assert.throws(() => subject.operationDocumentId('../request'), (error) => error.code === 'request-id');

const projected = subject.publicPerson({
  person_id:'sp_person_001', station_id:'eilat_102', kind:'registered',
  linked_uid:'secret-uid', display_name:'יוסי כהן', active:true, revision:3
});
assert.deepEqual(projected, {
  person_id:'sp_person_001', station_id:'eilat_102', display_name:'יוסי כהן',
  active:true
});
assert.equal(Object.hasOwn(projected, 'linked_uid'), false);
assert.equal(Object.hasOwn(projected, 'revision'), false);
assert.equal(Object.hasOwn(projected, 'kind'), false);
assert.equal(Object.hasOwn(projected, 'linked'), false);

assert.deepEqual(subject.normalizeState({ schema_version:1, generation:'gen_001', revision:0 }),
  { schema_version:1, generation:'gen_001', revision:0 });
assert.throws(() => subject.normalizeState({ schema_version:1, generation:'gen_001', revision:0, extra:true }),
  (error) => error.code === 'state-shape');
assert.throws(() => subject.normalizeState({ schema_version:1, generation:'gen_001', revision:-1 }),
  (error) => error.code === 'state-shape');
assert.throws(() => subject.normalizeState({ schema_version:1, generation:'gen_001', revision:Number.MAX_SAFE_INTEGER }),
  (error) => error.code === 'state-shape');

console.log('schedule identity store contract: 19 checks passed.');
