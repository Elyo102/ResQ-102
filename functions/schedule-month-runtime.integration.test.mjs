import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeDb,buildRuntime,seed,req,ST,SHEET} from '../tests/_schedule-fake.mjs';
async function fixture(enabled=true,hooks={}){
  const db=createFakeDb(), rt=buildRuntime(db,{monthAuthorityEnabled:enabled,...hooks});await seed(db);
  const config=db._get(ST+'/schedule_state/runtime');db._put(ST+'/schedule_state/runtime',{...config,mode:'new'});
  return {db,rt};
}
async function publish(f,month='2026-09',id='one'){
  const paste=SHEET.replace(/([123])\/9(\/26)?/g,'$1/'+Number(month.slice(5))+'$2');
  const input={month,paste,aliases:{'רועי':'u1','אבטחה':null,'גיא':'u5'}};
  const report=await f.rt.previewScheduleImport(req(input));assert.equal(report.blocked,false);
  const draft=await f.rt.importScheduleSheet(req({...input,request_id:'import_'+id,expected_report_digest:report.report_digest}));
  const preview=await f.rt.getDraftPreview(req({draft_id:draft.draft_id,start:draft.from}));
  const request=req({request_id:'publish_'+id,draft_id:draft.draft_id,expected_content_digest:preview.expected_content_digest});
  return {result:await f.rt.publish(request),request};
}
test('default false publication leaves authority entirely absent',async()=>{
  const f=await fixture(false);await publish(f);assert.equal(f.db._get(ST+'/schedule_state/publication_authority'),null);
  assert.equal(f.db._paths(ST+'/schedule_publication_months/').length,0);
});
test('enabled publish initializes atomically and retains earlier month with bound monthly jobs',async()=>{
  const f=await fixture(),first=await publish(f),second=await publish(f,'2026-10','two');
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-09').publication_id,first.result.publication_id);
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-10').publication_id,second.result.publication_id);
  const jobs=f.db._paths(ST+'/schedule_publications/').filter(p=>p.includes('/schedule_outbox/')).map(p=>f.db._get(p));
  assert.ok(jobs.length>0);assert.ok(jobs.every(j=>j.operation_publication_id===j.publication_id && j.activation_id && j.detail.every(x=>x.date.slice(0,7)===j.month)));
  const generation=f.db._get(ST+'/schedule_state/publication_authority').generation;
  assert.equal((await f.rt.publish(first.request)).duplicate,true);
  assert.equal(f.db._get(ST+'/schedule_state/publication_authority').generation,generation);
});
test('rollback first publication retains other month, creates tombstone removal jobs and replays once',async()=>{
  const f=await fixture(),sep=await publish(f),oct=await publish(f,'2026-10','two');
  const request=req({request_id:'undo_sep',target_operation_id:sep.result.publication_id,reason_code:'configuration_error'});
  const result=await f.rt.rollback(request);
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-09').state,'unowned');
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-10').publication_id,oct.result.publication_id);
  assert.equal(f.db._get(ST+'/schedule_state/active').publication_id,oct.result.publication_id);
  const jobs=f.db._paths(ST+'/schedule_publications/'+result.publication_id+'/schedule_outbox/').map(path=>({path,value:f.db._get(path)}));
  assert.ok(jobs.length>0);assert.ok(jobs.every(j=>j.value.authority_state==='unowned' && j.value.status==='queued'));
  await f.rt.deliverOutbox(f.db.doc(jobs[0].path));assert.equal(f.db._get(jobs[0].path).status,'sent');
  const generation=f.db._get(ST+'/schedule_state/publication_authority').generation;
  assert.equal((await f.rt.rollback(request)).duplicate,true);assert.equal(f.db._get(ST+'/schedule_state/publication_authority').generation,generation);
});
test('rollback restores original snapshot with fresh activation and old jobs cannot send',async()=>{
  const f=await fixture(),first=await publish(f),second=await publish(f,'2026-09','replacement');
  const original=f.db._get(ST+'/schedule_publication_authority_operations/'+first.result.publication_id).after['2026-09'];
  const result=await f.rt.rollback(req({request_id:'restore',target_operation_id:second.result.publication_id,reason_code:'configuration_error'}));
  const restored=f.db._get(ST+'/schedule_publication_months/2026-09');assert.equal(restored.publication_id,first.result.publication_id);assert.notEqual(restored.activation_id,original.activation_id);
  const old=f.db._paths(ST+'/schedule_publications/'+first.result.publication_id+'/schedule_outbox/')[0];
  await f.rt.deliverOutbox(f.db.doc(old));assert.equal(f.db._get(old).status,'cancelled');
  assert.equal(f.db._get(ST+'/schedule_publications/'+result.publication_id).snapshot_complete,undefined);
});
test('publication change between claim and SDK cancels the job',async()=>{
  let f,sent=0;
  f=await fixture(true,{sendPush:async()=>{sent++;return {sent:1};},beforeOutboxSend:async()=>{const o=f.db._get(ST+'/schedule_publication_months/2026-09');f.db._put(ST+'/schedule_publication_months/2026-09',{...o,activation_id:'b'.repeat(64)});}});
  const first=await publish(f),path=f.db._paths(ST+'/schedule_publications/'+first.result.publication_id+'/schedule_outbox/')[0];
  await f.rt.deliverOutbox(f.db.doc(path));assert.equal(sent,0);assert.equal(f.db._get(path).status,'cancelled');
});
test('abort before activation leaves migration and owners absent',async()=>{
  const f=await fixture(true,{beforeSnapshotFinalize:async({kind})=>{if(kind==='publication')throw Error('injected-abort');}});
  await assert.rejects(()=>publish(f),/injected-abort/);
  assert.equal(f.db._get(ST+'/schedule_state/publication_authority'),null);
  assert.equal(f.db._paths(ST+'/schedule_publication_months/').length,0);
});
test('shadow jobs remain suppressed and transaction reads precede all writes',async()=>{
  const f=await fixture();const original=f.db.runTransaction;
  f.db.runTransaction=callback=>original.call(f.db,tx=>{let writing=false;return callback(new Proxy(tx,{get(target,key){if(key==='get')return ref=>{assert.equal(writing,false,'transaction read after write');return target.get(ref);};if(['set','update','create','delete'].includes(key))return(...args)=>{writing=true;return target[key](...args);};return target[key];}}));});
  const config=f.db._get(ST+'/schedule_state/runtime');f.db._put(ST+'/schedule_state/runtime',{...config,mode:'shadow'});
  const first=await publish(f);const jobs=f.db._paths(ST+'/schedule_publications/'+first.result.publication_id+'/schedule_outbox/').map(p=>f.db._get(p));
  assert.ok(jobs.length>0);assert.ok(jobs.every(j=>j.status==='suppressed_trial' && j.delivery_allowed===false));
});
test('legacy migration preserves only seed-owned aggregate jobs and replacing its month cancels them',async()=>{
  const f=await fixture(false),old=await publish(f);
  const jobs=f.db._paths(ST+'/schedule_publications/'+old.result.publication_id+'/schedule_outbox/');
  let counter=0;f.rt=buildRuntime(f.db,{monthAuthorityEnabled:true,randomId:()=>('enabled_'+(++counter))});await publish(f,'2026-10','october');
  assert.equal(f.db._get(ST+'/schedule_state/publication_authority').seed_publication_id,old.result.publication_id);
  await f.rt.deliverOutbox(f.db.doc(jobs[0]));assert.equal(f.db._get(jobs[0]).status,'sent');
  await publish(f,'2026-09','newsep');await f.rt.deliverOutbox(f.db.doc(jobs[1]));assert.equal(f.db._get(jobs[1]).status,'cancelled');
});
test('changed monthly job binding before final activation aborts ownership transaction',async()=>{
  let f;f=await fixture(true,{beforeSnapshotFinalize:async({kind,ref})=>{
    if(kind!=='publication')return;const path=f.db._paths(ref.path+'/schedule_outbox/')[0];const value=f.db._get(path);f.db._put(path,{...value,activation_id:'a'.repeat(64)});
  }});
  await assert.rejects(()=>publish(f),/תור ההתראות השתנה/);assert.equal(f.db._get(ST+'/schedule_state/publication_authority'),null);
});
test('new job with detail in another month is rejected even with matching owner tuple',async()=>{
  const f=await fixture(),first=await publish(f);const path=f.db._paths(ST+'/schedule_publications/'+first.result.publication_id+'/schedule_outbox/')[0],value=f.db._get(path);
  f.db._put(path,{...value,detail:value.detail.map(x=>({...x,date:'2026-10-01'}))});
  await f.rt.deliverOutbox(f.db.doc(path));assert.equal(f.db._get(path).status,'cancelled');
});

test('staged queue scope, status and expiry mutations abort before authority activation',async()=>{
  for(const mutation of [{status:'queued'},{station_id:'foreign'},{publication_id:'foreign'},{attempt:1},{expires_at:1}]){
    let f;f=await fixture(true,{beforeSnapshotFinalize:async({kind,ref})=>{
      if(kind!=='publication')return;const path=f.db._paths(ref.path+'/schedule_outbox/')[0];f.db._put(path,{...f.db._get(path),...mutation});
    }});
    await assert.rejects(()=>publish(f),/תור ההתראות השתנה/);
    assert.equal(f.db._get(ST+'/schedule_state/publication_authority'),null);
  }
});

test('legacy rollback target must match the selected operation inverse',async()=>{
  const f=await fixture(),first=await publish(f),second=await publish(f,'2026-09','replacement');
  const generation=f.db._get(ST+'/schedule_state/publication_authority').generation;
  await assert.rejects(()=>f.rt.rollback(req({request_id:'wrong_target',expected_active_publication_id:second.result.publication_id,target_publication_id:'other',reason_code:'configuration_error'})),/גרסת היעד/);
  assert.equal(f.db._get(ST+'/schedule_state/publication_authority').generation,generation);
  await f.rt.rollback(req({request_id:'right_target',expected_active_publication_id:second.result.publication_id,target_publication_id:first.result.publication_id,reason_code:'configuration_error'}));
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-09').publication_id,first.result.publication_id);
});
