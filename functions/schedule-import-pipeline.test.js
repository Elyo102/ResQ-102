'use strict';
const assert=require('node:assert/strict');
const pipeline=require('./schedule-import-pipeline');
const recipients=require('./schedule-publication-recipients');
let passed=0;
function test(name,fn){try{fn();passed+=1;console.log('PASS',name);}catch(e){console.error('FAIL',name,e);process.exitCode=1;}}
const base=[['','1/9','2/9','3/9'],['תחנה א','אלדד יונה','',''],['תחנה ב','','שרה כהן','']];
test('workbook creates dynamic stations and stable external people',()=>{const out=pipeline.buildWorkbookImport({station_id:'eilat_102',month:'2026-09',input:base,inventory:[],bindings:[]});assert.equal(out.blockers.length,0);assert.equal(out.layout.stations.length,2);assert.equal(out.identities.proposed_people.length,2);assert.ok(out.resolved.rows.some(r=>r.slots.some(s=>s.person.startsWith('sp_'))));assert.deepEqual(out.warnings,[{code:'unlinked-people',count:2}]);});
test('same workbook identity stays stable across imports',()=>{const a=pipeline.buildWorkbookImport({station_id:'eilat_102',month:'2026-09',input:base,inventory:[],bindings:[]});const b=pipeline.buildWorkbookImport({station_id:'eilat_102',month:'2026-09',input:base,inventory:a.identities.proposed_people,bindings:[]});assert.equal(b.identities.proposed_people.length,0);assert.equal(a.identities.assignments[0].person.person_id,b.identities.assignments[0].person.person_id);});
test('duplicate assignment is a hard blocker',()=>{const grid=[['','1/9','2/9','3/9'],['א','אלדד','',''],['ב','אלדד','','']];const out=pipeline.buildWorkbookImport({station_id:'eilat_102',month:'2026-09',input:grid,inventory:[],bindings:[]});assert.ok(out.blockers.includes('duplicate-assignment'));});
test('duplicate station label is rejected as ambiguous',()=>{const grid=[['','1/9','2/9','3/9'],['א','אלדד','',''],['א','','שרה','']];assert.throws(()=>pipeline.buildWorkbookImport({station_id:'eilat_102',month:'2026-09',input:grid,inventory:[],bindings:[]}),e=>e.code==='ambiguous-station-label');});
const external={schema_version:1,person_id:'sp_external_0001',station_id:'eilat_102',kind:'external',linked_uid:null,display_name:'חיצוני',active:true,revision:1,source_ref:{station_id:'eilat_102',source_namespace:'station-workbook-v1',source_key:{kind:'name',value:'חיצוני'}}};
const registered={schema_version:1,person_id:'sp_registered_01',station_id:'eilat_102',kind:'registered',linked_uid:'uid_live',display_name:'רשום',active:true,revision:2,source_ref:null};
test('publication maps person id to active linked uid and omits external',()=>{const out=recipients.resolvePublicationNotifications({station_id:'eilat_102',notifications:[{person:external.person_id,dedupe_key:'a'},{person:registered.person_id,dedupe_key:'b'}],people:[external,registered],verified_users:[{uid:'uid_live',station_id:'eilat_102',active:true}]});assert.equal(out.length,1);assert.equal(out[0].person,'uid_live');});
test('publication never emits sp namespace',()=>{const out=recipients.resolvePublicationNotifications({station_id:'eilat_102',notifications:[{person:external.person_id}],people:[external],verified_users:[]});assert.deepEqual(out,[]);});
test('inactive linked account is omitted',()=>{const out=recipients.resolvePublicationNotifications({station_id:'eilat_102',notifications:[{person:registered.person_id}],people:[registered],verified_users:[{uid:'uid_live',station_id:'eilat_102',active:false}]});assert.deepEqual(out,[]);});
test('workbook overlap warns and preserves assignment and absence',()=>{
  const out=pipeline.buildWorkbookImport({station_id:'eilat_102',month:'2026-09',
    input:[['','1/9','2/9','3/9'],['אילת','עובד בדיקה','',''],['מחלה','עובד בדיקה','','']],inventory:[],bindings:[]});
  assert.deepEqual(out.blockers,[]);
  assert.ok(out.warnings.some(w=>w.code==='assignment-absence-conflict'&&w.count===1));
  assert.equal(out.resolved.counts.assignments,1);
  assert.equal(out.resolved.counts.absences,1);
  assert.equal(out.resolved.assignment_absence_conflicts.length,1);
});
if(!process.exitCode)console.log(`${passed}/${passed} schedule import pipeline tests passed`);
