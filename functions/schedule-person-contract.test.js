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

const imports = require('./schedule-import-identity');
const stationId = 'eilat_102';
const employeeEntry = (value, displayName = 'יוסי כהן') => ({
  source_key:{ kind:'employee', value }, display_name:displayName
});
const nameEntry = (value) => ({ source_key:{ kind:'name', value }, display_name:value });
const plan = (overrides = {}) => imports.planImportIdentities(Object.assign({
  station_id:stationId, source_namespace:'station-workbook-v1',
  entries:[employeeEntry('00123')], inventory:[], bindings:[]
}, overrides));

const firstImport = plan();
assert.equal(firstImport.ready, true);
assert.equal(firstImport.proposed_people.length, 1);
assert.equal(firstImport.proposed_people[0].kind, 'external');
assert.equal(firstImport.proposed_people[0].linked_uid, null);
assert.equal(Object.hasOwn(firstImport.assignments[0].person, 'linked_uid'), false);
assert.equal(firstImport.proposed_people[0].person_id,
  imports.generatedPersonId(stationId, { kind:'employee', value:'00123' }));

const reimport = plan({ inventory:[firstImport.proposed_people[0]] });
assert.equal(reimport.ready, true);
assert.equal(reimport.proposed_people.length, 0);
assert.equal(reimport.assignments[0].person.person_id, firstImport.proposed_people[0].person_id);
assert.notEqual(imports.generatedPersonId(stationId, { kind:'employee', value:'00123' }),
  imports.generatedPersonId(stationId, { kind:'employee', value:'123' }));
assert.notEqual(imports.generatedPersonId(stationId, { kind:'employee', value:'e\u0301' }),
  imports.generatedPersonId(stationId, { kind:'employee', value:'é' }));
assert.throws(() => imports.generatedPersonId('../other', { kind:'employee', value:'1' }),
  (error) => error.code === 'station-id');
assert.throws(() => plan({ entries:[employeeEntry(123)] }), (error) => error.code === 'source-key-value');
assert.throws(() => plan({ entries:[nameEntry('יוסי'), nameEntry('יוסי')] }),
  (error) => error.code === 'entry-duplicate');

const registeredPerson = Object.assign({}, registered, {
  person_id:'sp_registered_001', station_id:stationId, display_name:'יוסי כהן', revision:4
});
const binding = { station_id:stationId, source_namespace:'station-workbook-v1',
  source_key:{ kind:'employee', value:'00123' }, person_id:registeredPerson.person_id,
  expected_person_revision:4 };
const linked = plan({ inventory:[registeredPerson], bindings:[binding] });
assert.equal(linked.ready, true);
assert.equal(linked.assignments[0].person.person_id, registeredPerson.person_id);
assert.equal(Object.hasOwn(linked.assignments[0].person, 'linked_uid'), false);
assert.equal(plan({ inventory:[registeredPerson], bindings:[Object.assign({}, binding,
  { expected_person_revision:3 })] }).conflicts[0].code, 'binding-stale');
const aliasedBinding = plan({ entries:[employeeEntry('00123', 'יונה')], inventory:[registeredPerson],
  bindings:[binding] });
assert.equal(aliasedBinding.ready, true);
assert.equal(aliasedBinding.assignments[0].person.person_id, registeredPerson.person_id);
assert.equal(aliasedBinding.assignments[0].person.display_name, 'יוסי כהן');
assert.equal(Object.hasOwn(aliasedBinding.assignments[0].person, 'linked_uid'), false);
assert.throws(() => plan({ inventory:[registeredPerson], bindings:[Object.assign({}, binding,
  { station_id:'other_station' })] }), (error) => error.code === 'binding-cross-scope');
assert.throws(() => plan({ inventory:[registeredPerson], bindings:[Object.assign({}, binding,
  { person_id:'<script>' })] }), (error) => error.code === 'binding-shape');

const sameNameWithoutBinding = plan({ inventory:[registeredPerson] });
assert.equal(sameNameWithoutBinding.proposed_people.length, 1);
assert.notEqual(sameNameWithoutBinding.assignments[0].person.person_id, registeredPerson.person_id);
const collisionPerson = Object.assign({}, registeredPerson, {
  person_id:imports.generatedPersonId(stationId, { kind:'employee', value:'00123' })
});
assert.equal(plan({ inventory:[collisionPerson] }).conflicts[0].code, 'identity-collision');
const duplicateSourcePerson = Object.assign({}, firstImport.proposed_people[0], {
  person_id:'sp_duplicate_001'
});
const duplicateSource = plan({ inventory:[firstImport.proposed_people[0], duplicateSourcePerson] });
assert.equal(duplicateSource.ready, false);
assert.equal(duplicateSource.conflicts.some((item) => item.code === 'duplicate-provenance'), true);
assert.equal(plan({ entries:[employeeEntry('1'), employeeEntry('2')],
  inventory:[registeredPerson], bindings:[Object.assign({}, binding, { source_key:{ kind:'employee', value:'1' } }),
    Object.assign({}, binding, { source_key:{ kind:'employee', value:'2' } })] })
  .conflicts[0].code, 'effective-person-duplicate');
assert.equal(plan({ inventory:[Object.assign({}, registeredPerson, { active:false })], bindings:[binding] })
  .conflicts[0].code, 'binding-stale');
assert.equal(plan({ inventory:[], bindings:[binding] }).conflicts[0].code, 'binding-stale');
const homonyms = plan({ entries:[employeeEntry('10', 'יוסי כהן'), employeeEntry('11', 'יוסי כהן')] });
assert.equal(homonyms.ready, true);
assert.equal(new Set(homonyms.assignments.map((item) => item.person.person_id)).size, 2);
assert.throws(() => plan({ entries:[employeeEntry('12\u202e3')] }),
  (error) => error.code === 'source-key-value');

const a = employeeEntry('001', 'אחד');
const b = employeeEntry('002', 'שתיים');
const deterministicA = plan({ entries:[a, b], inventory:[registeredPerson], bindings:[binding] });
const deterministicB = plan({ entries:[b, a], inventory:[registeredPerson].reverse(), bindings:[binding].reverse() });
assert.deepEqual(deterministicA, deterministicB);
assert.deepEqual(a, employeeEntry('001', 'אחד'));
assert.deepEqual(Object.keys(firstImport).sort(), [
  'assignments', 'bindings_digest', 'conflicts', 'inventory_digest', 'proposed_people',
  'ready', 'schema_version', 'source_namespace', 'station_id'
].sort());
assert.throws(() => plan({ entries:Array.from({ length:3001 }, (_, i) => employeeEntry(String(i))) }),
  (error) => error.code === 'entries-limit');
console.log('16 schedule-import identity checks passed.');
