'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('./schedule-month-authority');
const {eligibility}=require('./schedule-month-outbox-authority');
function owner(id,month,op){return {...C.publicationOwners({station_id:'s1',publication_id:id,revision:1,content_digest:C.hash(id),from:month+'-01',to:month+'-02'},'s1')[month],activation_id:C.activationId('s1','publish',op,month)};}
const job=o=>Object.fromEntries(['month','activation_id','publication_id','revision','content_digest'].map(k=>[k,o[k]]));
const check=(o,j,extra={})=>eligibility({station_id:'s1',owner:o,job:j,phase:'claim',...extra});
test('annual publication partially replaced: unchanged month eligible, replaced month denied',()=>{
  const sep=owner('annual','2026-09','op1'),oct=owner('annual','2026-10','op1');
  assert.equal(check(sep,job(sep)).eligible,true);
  assert.equal(check(owner('new','2026-09','op2'),job(sep)).eligible,false);
  assert.equal(check(oct,job(oct)).eligible,true);
});
test('rollback activation cannot revive an old job and preSDK must recheck owner',()=>{
  const original=owner('annual','2026-09','op1'),j=job(original);
  assert.equal(check(original,j).eligible,true);
  const restored={...original,activation_id:C.activationId('s1','rollback','undo','2026-09')};
  assert.equal(check(restored,j,{phase:'pre_sdk'}).eligible,false);
  assert.equal(check(restored,job(restored),{phase:'pre_sdk'}).eligible,true);
});
test('removing or mutating any authority field is rejected at both gates',()=>{
  const o=owner('p','2026-09','op');
  for(const phase of ['claim','pre_sdk'])for(const key of ['month','activation_id','publication_id','revision','content_digest']){
    const removed=job(o);delete removed[key];assert.equal(check(o,removed,{phase}).eligible,false,key);
    const changed={...job(o),[key]:key==='revision'?99:'wrong'};assert.equal(check(o,changed,{phase}).eligible,false,key);
  }
  assert.equal(check(null,job(o)).eligible,false);
  assert.equal(check({...o,station_id:'s2'},job(o)).eligible,false);
  assert.equal(check(o,{...job(o),station_id:'s2'}).eligible,false);
});
test('legacy requires explicit deterministic migration mapping and cannot survive reactivation',()=>{
  const o=owner('p','2026-09','op');o.activation_id=C.migrationActivation('s1',o);
  const j=job(o);delete j.activation_id;
  assert.equal(check(o,j).eligible,false);assert.equal(check(o,j,{legacyMigration:true}).eligible,false);
  const legacyMigration={enabled:true,station_id:'s1',...job(o)};
  assert.equal(check(o,j,{legacyMigration}).eligible,true);
  const restored={...o,activation_id:C.activationId('s1','rollback','undo','2026-09')};
  assert.equal(check(restored,j,{legacyMigration:{...legacyMigration,activation_id:restored.activation_id}}).eligible,false);
});
test('trial fields cannot bypass ownership and eligibility does not claim delivery permission',()=>{
  const o=owner('p','2026-09','op');
  assert.equal(check(o,{...job(o),trial:true,delivery_allowed:false}).eligible,true);
  assert.equal(check(null,{...job(o),trial:false,delivery_allowed:true}).eligible,false);
});
test('tombstone removal requires exact completed envelope receipt and prior covered dates',()=>{
  const prior=owner('old','2026-09','first');
  const tomb={schema_version:2,state:'unowned',station_id:'s1',month:'2026-09',activation_id:C.activationId('s1','rollback','undo','2026-09'),operation_id:'undo',operation_publication_id:'envelope'};
  const receipt=C.makeReceipt({schema_version:1,station_id:'s1',operation_id:'undo',operation_publication_id:'envelope',kind:'rollback',fingerprint:C.hash('undo'),generation_before:1,generation_after:2,before:{'2026-09':prior},after:{'2026-09':tomb},result:{ok:true}});
  const operationEnvelope={station_id:'s1',operation_id:'undo',operation_publication_id:'envelope',status:'completed',receipt_digest:receipt.receipt_digest};
  const j={authority_state:'unowned',month:'2026-09',activation_id:tomb.activation_id,operation_id:'undo',operation_publication_id:'envelope',removed_dates:['2026-09-01','2026-09-02']};
  for(const phase of ['claim','pre_sdk']) {
    const extra={phase,receipt,operationEnvelope};
    assert.equal(check(tomb,j,extra).eligible,true);
    assert.equal(check(tomb,{...j,station_id:'s2'},extra).eligible,false);
    assert.equal(check(null,j,extra).eligible,false);
    assert.equal(check(tomb,j,{...extra,operationEnvelope:{...operationEnvelope,status:'staging'}}).eligible,false);
    assert.equal(check(tomb,{...j,removed_dates:['2026-09-03']},extra).eligible,false);
    assert.equal(check(tomb,{...j,removed_dates:['2026-10-01']},extra).eligible,false);
    for(const key of ['activation_id','operation_id','operation_publication_id','removed_dates']){const missing={...j};delete missing[key];assert.equal(check(tomb,missing,extra).eligible,false);}
    assert.equal(check(tomb,j,{...extra,receipt:{...receipt,after:{'2026-09':null}}}).eligible,false);
    assert.equal(check(owner('next','2026-09','nextop'),j,extra).eligible,false);
    assert.equal(check(tomb,job(prior),extra).eligible,false);
  }
});
