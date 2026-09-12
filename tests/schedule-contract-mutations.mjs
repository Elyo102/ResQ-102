import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');

const mutations = [
  {
    name:'external cannot carry uid', file:'schedule-person-contract.js',
    from:"if (kind === 'external' && linkedUid !== null)", to:"if (false)",
    probe:"const s=require('./schedule-person-contract'); let ok=false; try{s.normalizeSchedulePerson({person_id:'sp_person_001',station_id:'eilat_102',kind:'external',linked_uid:'uid_1',display_name:'x',active:true,revision:1});}catch(e){ok=e.code==='external-link-forbidden';} if(!ok)process.exit(1);"
  },
  {
    name:'link requires current revision', file:'schedule-person-service.js',
    from:'if (person.revision !== expected)', to:'if (false)',
    probe:"const s=require('./schedule-person-service'); let ok=false; try{s.planLink({person:{person_id:'sp_person_001',station_id:'eilat_102',kind:'external',linked_uid:null,display_name:'x',active:true,revision:4},expected_revision:3,actor_uid:'a',actor:{uid:'a',station_id:'eilat_102',authorized:true},uid:'u',user:{exists:true,active:true,station_id:'eilat_102',uid:'u'},link_index:{uid:'u',person_id:null,revision:0},expected_link_revision:0});}catch(e){ok=e.code==='link-stale';} if(!ok)process.exit(1);"
  },
  {
    name:'inactive user excluded from push', file:'schedule-recipient-contract.js',
    from:"person.kind === 'registered' && person.active && person.linked_uid",
    to:"person.kind === 'registered' && person.linked_uid",
    probe:"const s=require('./schedule-recipient-contract'); const p={person_id:'sp_person_001',station_id:'eilat_102',kind:'registered',linked_uid:'uid_1',display_name:'x',active:false,revision:1}; if(s.recipientsForChanges({station_id:'eilat_102',changed_person_ids:[p.person_id],people:[p],verified_users:[{uid:'uid_1',active:true,station_id:'eilat_102'}]}).length!==0)process.exit(1);"
  },
  {
    name:'range rejects 367 days', file:'schedule-range-contract.js',
    from:'if (days > MAX_DAYS)', to:'if (false)',
    probe:"const s=require('./schedule-range-contract'); let ok=false; try{s.normalizeScheduleRange({from:'2024-01-01',to:'2025-01-01',people:1});}catch(e){ok=e.code==='range-too-large';} if(!ok)process.exit(1);"
  },
  {
    name:'link requires authorized actor', file:'schedule-person-service.js',
    from:"if (!actor || actor.authorized !== true", to:"if (!actor || false",
    probe:"const s=require('./schedule-person-service'); let ok=false; try{s.planLink({person:{person_id:'sp_person_001',station_id:'eilat_102',kind:'external',linked_uid:null,display_name:'x',active:true,revision:1},expected_revision:1,actor_uid:'a',actor:{uid:'a',station_id:'eilat_102',authorized:false},uid:'u',user:{exists:true,active:true,station_id:'eilat_102',uid:'u'},link_index:{uid:'u',person_id:null,revision:0},expected_link_revision:0});}catch(e){ok=e.code==='actor-forbidden';} if(!ok)process.exit(1);"
  },
  {
    name:'uid namespace cannot collide with person ids', file:'schedule-person-contract.js',
    from:"!uid.startsWith('sp_')", to:"true",
    probe:"const s=require('./schedule-person-contract'); let ok=false; try{s.normalizeSchedulePerson({person_id:'sp_person_001',station_id:'eilat_102',kind:'registered',linked_uid:'sp_account_001',display_name:'x',active:true,revision:1});}catch(e){ok=e.code==='linked-uid';} if(!ok)process.exit(1);"
  },
  {
    name:'inactive live account excluded from push', file:'schedule-recipient-contract.js',
    from:"if (user.active) recipients.push", to:"if (true) recipients.push",
    probe:"const s=require('./schedule-recipient-contract'); const p={person_id:'sp_person_001',station_id:'eilat_102',kind:'registered',linked_uid:'uid_1',display_name:'x',active:true,revision:1}; if(s.recipientsForChanges({station_id:'eilat_102',changed_person_ids:[p.person_id],people:[p],verified_users:[{uid:'uid_1',active:false,station_id:'eilat_102'}]}).length!==0)process.exit(1);"
  },
  {
    name:'range enforces reachable payload capacity', file:'schedule-range-contract.js',
    from:"if (days * people > MAX_CELLS)", to:"if (false)",
    probe:"const s=require('./schedule-range-contract'); let ok=false; try{s.normalizeScheduleRange({from:'2024-01-01',to:'2024-12-31',people:684});}catch(e){ok=e.code==='range-capacity';} if(!ok)process.exit(1);"
  },
  {
    name:'import never links a matching name implicitly', file:'schedule-import-identity.js',
    from:'const found = inventory.get(personId);',
    to:"const found = [...inventory.values()].find((item) => item.person.display_name === entry.display_name) || inventory.get(personId);",
    probe:"const s=require('./schedule-import-identity'); const p={person_id:'sp_registered_001',station_id:'eilat_102',kind:'registered',linked_uid:'u',display_name:'x',active:true,revision:1}; const r=s.planImportIdentities({station_id:'eilat_102',source_namespace:'station-workbook-v1',entries:[{source_key:{kind:'employee',value:'1'},display_name:'x'}],inventory:[p],bindings:[]}); if(r.proposed_people.length!==1||r.assignments[0].person.person_id===p.person_id)process.exit(1);"
  },
  {
    name:'import binding requires current revision', file:'schedule-import-identity.js',
    from:'found.person.revision !== binding.expected_person_revision', to:'false',
    probe:"const s=require('./schedule-import-identity'); const p={person_id:'sp_registered_001',station_id:'eilat_102',kind:'registered',linked_uid:'u',display_name:'x',active:true,revision:2}; const b={station_id:'eilat_102',source_namespace:'station-workbook-v1',source_key:{kind:'employee',value:'1'},person_id:p.person_id,expected_person_revision:1}; const r=s.planImportIdentities({station_id:'eilat_102',source_namespace:'station-workbook-v1',entries:[{source_key:b.source_key,display_name:'x'}],inventory:[p],bindings:[b]}); if(r.ready||r.conflicts[0]?.code!=='binding-stale')process.exit(1);"
  },
  {
    name:'import collision never adopts foreign provenance', file:'schedule-import-identity.js',
    from:"found.person.kind !== 'external' || !sameSourceRef(found.source_ref, ref)", to:'false',
    probe:"const s=require('./schedule-import-identity'); const k={kind:'employee',value:'1'}; const p={person_id:s.generatedPersonId('eilat_102',k),station_id:'eilat_102',kind:'external',linked_uid:null,display_name:'x',active:true,revision:1,source_ref:{station_id:'eilat_102',source_namespace:'station-workbook-v1',source_key:{kind:'employee',value:'other'}}}; const r=s.planImportIdentities({station_id:'eilat_102',source_namespace:'station-workbook-v1',entries:[{source_key:k,display_name:'x'}],inventory:[p],bindings:[]}); if(r.ready||r.conflicts[0]?.code!=='identity-collision')process.exit(1);"
  },
  {
    name:'import result never leaks linked uid', file:'schedule-import-identity.js',
    from:'revision:person.revision', to:'revision:person.revision, linked_uid:person.linked_uid',
    probe:"const s=require('./schedule-import-identity'); const p={person_id:'sp_registered_001',station_id:'eilat_102',kind:'registered',linked_uid:'secret',display_name:'x',active:true,revision:1}; const b={station_id:'eilat_102',source_namespace:'station-workbook-v1',source_key:{kind:'employee',value:'1'},person_id:p.person_id,expected_person_revision:1}; const r=s.planImportIdentities({station_id:'eilat_102',source_namespace:'station-workbook-v1',entries:[{source_key:b.source_key,display_name:'x'}],inventory:[p],bindings:[b]}); if(Object.hasOwn(r.assignments[0].person,'linked_uid'))process.exit(1);"
  },
  {
    name:'employee source identifiers remain opaque', file:'schedule-import-identity.js',
    from:"? cleanOpaqueText(value.value, 128, 'source-key-value')", to:"? cleanText(value.value, 128, 'source-key-value')",
    probe:"const s=require('./schedule-import-identity'); const a=s.generatedPersonId('eilat_102',{kind:'employee',value:'e\\u0301'}); const b=s.generatedPersonId('eilat_102',{kind:'employee',value:'é'}); if(a===b)process.exit(1);"
  },
  {
    name:'duplicate source provenance blocks readiness', file:'schedule-import-identity.js',
    from:"if (inventoryProvenance.has(refId)) duplicateProvenance.set(refId, refKey);", to:'if (false) duplicateProvenance.set(refId, refKey);',
    probe:"const s=require('./schedule-import-identity'); const k={kind:'employee',value:'1'}; const id=s.generatedPersonId('eilat_102',k); const ref={station_id:'eilat_102',source_namespace:'station-workbook-v1',source_key:k}; const base={station_id:'eilat_102',kind:'external',linked_uid:null,display_name:'x',active:true,revision:1,source_ref:ref}; const r=s.planImportIdentities({station_id:'eilat_102',source_namespace:'station-workbook-v1',entries:[{source_key:k,display_name:'x'}],inventory:[{...base,person_id:id},{...base,person_id:'sp_duplicate_001'}],bindings:[]}); if(r.ready||!r.conflicts.some(x=>x.code==='duplicate-provenance'))process.exit(1);"
  }
];

for (const mutation of mutations) {
  const dir = mkdtempSync(join(tmpdir(), 'resq-schedule-contract-'));
  for (const file of ['schedule-person-contract.js', 'schedule-person-service.js',
    'schedule-recipient-contract.js', 'schedule-range-contract.js', 'schedule-import-identity.js']) {
    cpSync(join(root, 'functions', file), join(dir, file));
  }
  const target = join(dir, mutation.file);
  const source = readFileSync(target, 'utf8');
  assert.equal(source.includes(mutation.from), true, mutation.name + ': mutation anchor missing');
  writeFileSync(target, source.replace(mutation.from, mutation.to));
  const result = spawnSync(process.execPath, ['-e', mutation.probe], { cwd:dir, encoding:'utf8' });
  assert.notEqual(result.status, 0, mutation.name + ': broken implementation escaped its probe');
  console.log('✓ ' + mutation.name);
}

console.log(mutations.length + '/' + mutations.length + ' schedule-contract mutations caught.');
