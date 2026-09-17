import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeDb,buildRuntime,seed,req,ST,SHEET} from '../tests/_schedule-fake.mjs';
// Extend this test's old fake with Firestore nested-field equality support.
// Production still issues a bounded indexed query; this is only the in-memory evaluator.
function nestedQueries(db){
  function qwrap(query){return new Proxy(query,{get(q,key){
    if(key==='doc')return id=>dwrap(q.doc(id));
    if(key==='where')return(field,op,value)=>{
      if(!String(field).startsWith('after.'))return qwrap(q.where(field,op,value));
      assert.equal(op,'==');let max=Infinity;return {limit(n){max=n;return this;},async get(){
        const all=await q.get(),docs=all.docs.filter(d=>String(field).split('.').reduce((v,k)=>v && v[k],d.data())===value).slice(0,max);
        return {docs,size:docs.length,empty:!docs.length};}};
    };return q[key];}});}
  function dwrap(ref){return new Proxy(ref,{get(r,key){if(key==='collection')return name=>qwrap(r.collection(name));return r[key];}});}
  const collection=db.collection,doc=db.doc;db.collection=name=>qwrap(collection(name));db.doc=path=>dwrap(doc(path));return db;
}
async function fixture(hooks={}){const db=nestedQueries(createFakeDb()),rt=buildRuntime(db,{monthAuthorityEnabled:true,...hooks});await seed(db);db._put(ST+'/schedule_state/runtime',{...db._get(ST+'/schedule_state/runtime'),mode:'new'});return {db,rt};}
async function publish(f,month='2026-09',id='one'){
  const paste=SHEET.replace(/([123])\/9(\/26)?/g,'$1/'+Number(month.slice(5))+'$2'),input={month,paste,aliases:{'רועי':'u1','אבטחה':null,'גיא':'u5'}};
  const report=await f.rt.previewScheduleImport(req(input));assert.equal(report.blocked,false);
  const draft=await f.rt.importScheduleSheet(req({...input,request_id:'import_'+id,expected_report_digest:report.report_digest}));
  const preview=await f.rt.getDraftPreview(req({draft_id:draft.draft_id,start:draft.from}));
  return f.rt.publish(req({request_id:'publish_'+id,draft_id:draft.draft_id,expected_content_digest:preview.expected_content_digest}));
}
test('retained September, boundary unavailable and tombstone have exact date provenance',async()=>{
  const f=await fixture(),sep=await publish(f),oct=await publish(f,'2026-10','two');
  const result=await f.rt.getStationRange(req({from:'2026-09-01',to:'2026-09-03'}));
  assert.ok(result.days.every(d=>d.available && d.provenance.publication_id===sep.publication_id));
  assert.ok(result.days.some(d=>d.sub_stations.some(s=>s.people.length)));
  const boundary=await f.rt.getStation(req({date:'2026-10-01'}));
  assert.equal(boundary.previous_day.available,false);assert.equal(boundary.day.provenance.publication_id,oct.publication_id);
  await f.rt.rollback(req({request_id:'undo',target_operation_id:sep.publication_id,reason_code:'configuration_error'}));
  const missing=await f.rt.getStationRange(req({from:'2026-09-01',to:'2026-09-03'}));assert.ok(missing.days.every(d=>!d.available && d.provenance===null));
});
test('397-day workdays retain segmented provenance without fallback',async()=>{
  const f=await fixture(),sep=await publish(f);await publish(f,'2026-10','two');
  const result=await f.rt.getEffectiveWorkdays(req({from:'2026-01-01',to:'2027-02-01',uids:['u1']}));
  assert.equal(result.provenance.segments.length,2);assert.equal(result.provenance.segments[0].publication_id,sep.publication_id);
  assert.ok(result.unknown_dates.includes('2026-11-01'));assert.equal(result.fallback,null);
});
test('editing retained September leaves October owner byte-identical',async()=>{
  const f=await fixture(),sep=await publish(f);await publish(f,'2026-10','two');
  const expected=f.db._get(ST+'/schedule_publication_months/2026-09'),oct=f.db._get(ST+'/schedule_publication_months/2026-10');
  const row=f.db._paths(ST+'/schedule_publications/'+sep.publication_id+'/rows/').map(p=>f.db._get(p).row).find(r=>r.slots.length);
  const edits=[{kind:'unassign',uid:row.slots[0].person,dates:[row.date]}];
  const report=await f.rt.previewScheduleEdit(req({expected,edits}));assert.deepEqual(report.affected_months,['2026-09']);
  await f.rt.applyScheduleEdit(req({request_id:'edit_sep',expected,edits,expected_edit_digest:report.edit_digest}));
  assert.deepEqual(f.db._get(ST+'/schedule_publication_months/2026-10'),oct);
  assert.notEqual(f.db._get(ST+'/schedule_publication_months/2026-09').publication_id,sep.publication_id);
});
test('response binds retained item activation and rejects stale activation',async()=>{
  const f=await fixture(),sep=await publish(f);await publish(f,'2026-10','two');
  const owner=f.db._get(ST+'/schedule_publication_months/2026-09');
  const row=f.db._paths(ST+'/schedule_publications/'+sep.publication_id+'/rows/').map(p=>f.db._get(p).row).find(r=>r.slots.some(s=>s.person==='u1'));
  const request=req({request_id:'response',publication_id:sep.publication_id,item_id:row.date,answer:'confirm',activation_id:owner.activation_id});request.auth.uid='u1';
  assert.equal((await f.rt.respond(request)).duplicate,false);
  f.db._put(ST+'/schedule_publication_months/2026-09',{...owner,activation_id:'a'.repeat(64)});
  await assert.rejects(()=>f.rt.respond(request),/בעלות השיבוץ/);
});
test('rollback my view uses fresh operation-envelope notices for restored snapshot',async()=>{
  const f=await fixture(),first=await publish(f),owner=f.db._get(ST+'/schedule_publication_months/2026-09');
  const row=f.db._paths(ST+'/schedule_publications/'+first.publication_id+'/rows/').map(p=>f.db._get(p).row).find(r=>r.slots.some(s=>s.person==='u1'));
  const edits=[{kind:'unassign',uid:'u1',dates:[row.date]}],report=await f.rt.previewScheduleEdit(req({expected:owner,edits}));
  const edited=await f.rt.applyScheduleEdit(req({request_id:'remove_u1',expected:owner,edits,expected_edit_digest:report.edit_digest}));
  await f.rt.rollback(req({request_id:'restore_u1',target_operation_id:edited.publication_id,reason_code:'configuration_error'}));
  const request=req({date:row.date});request.auth.uid='u1';
  const view=await f.rt.getMy(request);
  assert.equal(view.publication_id,first.publication_id);assert.ok(view.days.length);assert.ok(view.days.some(day=>day.change && day.requires_answer));
  assert.notEqual(view.activation_id,owner.activation_id);
});
test('annual edit signs only affected months; mixed-owner edits reject before writes',async()=>{
  const f=await fixture();
  const draft=await f.rt.runPlanner(req({request_id:'annual',start:'2026-01-01',months:12}));
  const preview=await f.rt.getDraftPreview(req({draft_id:draft.draft_id,start:'2026-09-01'}));
  const annual=await f.rt.publish(req({request_id:'annual_pub',draft_id:draft.draft_id,expected_content_digest:preview.expected_content_digest}));
  await publish(f,'2026-10','oct');
  const before=Object.fromEntries(f.db._paths(ST+'/schedule_publication_months/').map(path=>[path,f.db._get(path)]));
  const expected=f.db._get(ST+'/schedule_publication_months/2026-09');
  const row=f.db._paths(ST+'/schedule_publications/'+annual.publication_id+'/rows/').map(p=>f.db._get(p).row).find(r=>r.date.startsWith('2026-09') && r.slots.length);
  const edits=[{kind:'unassign',uid:row.slots[0].person,dates:[row.date]}];
  const report=await f.rt.previewScheduleEdit(req({expected,edits}));
  await f.rt.applyScheduleEdit(req({request_id:'annual_edit',expected,edits,expected_edit_digest:report.edit_digest}));
  for(const [path,value]of Object.entries(before))if(!path.endsWith('2026-09'))assert.deepEqual(f.db._get(path),value);
  const count=f.db._paths(ST+'/schedule_drafts/').length;
  await assert.rejects(()=>f.rt.previewScheduleEdit(req({expected:f.db._get(ST+'/schedule_publication_months/2026-09'),edits:[{...edits[0],dates:[row.date,'2026-10-01']}]})),/בסיס אחר/);
  assert.equal(f.db._paths(ST+'/schedule_drafts/').length,count);
});
test('live permission loss after guard sidecar aborts month response',async()=>{
  let f;f=await fixture({beforeLiveGuardViewRecheck:async()=>{
    const p=ST+'/users/mgr',user=f.db._get(p);if(user)f.db._put(p,{...user,active:false,is_active:false});
  }});
  await publish(f);
  // Use the actual authenticated manager document rather than assuming its ID.
  const userPath=ST+'/users/'+req({}).auth.uid;
  const rt=buildRuntime(f.db,{monthAuthorityEnabled:true,beforeLiveGuardViewRecheck:async()=>f.db._put(userPath,{...f.db._get(userPath),active:false,is_active:false})});
  await assert.rejects(()=>rt.getStationRange(req({from:'2026-09-01',to:'2026-09-03'})),/השיוך החי/);
});
test('signed affected-month removal before finalization rejects edit atomically',async()=>{
  let f;f=await fixture({beforeSnapshotFinalize:async({kind,ref})=>{
    const meta=f.db._get(ref.path);if(kind==='draft' && meta.edited){const copy={...meta};delete copy.affected_months;f.db._put(ref.path,copy);}
  }});
  const publication=await publish(f),owner=f.db._get(ST+'/schedule_publication_months/2026-09');
  const row=f.db._paths(ST+'/schedule_publications/'+publication.publication_id+'/rows/').map(p=>f.db._get(p).row).find(r=>r.slots.length);
  const edits=[{kind:'unassign',uid:row.slots[0].person,dates:[row.date]}],report=await f.rt.previewScheduleEdit(req({expected:owner,edits}));
  await assert.rejects(()=>f.rt.applyScheduleEdit(req({request_id:'corrupt_edit',expected:owner,edits,expected_edit_digest:report.edit_digest})),/תמונת הסידור|חודשים חתומים/);
  assert.deepEqual(f.db._get(ST+'/schedule_publication_months/2026-09'),owner);
});
test('monthly edit rechecks authority generation and owner immediately before draft finalization',async()=>{
  for(const changed of ['generation','owner']){
    let armed=false,f;f=await fixture({beforeSnapshotFinalize:async({kind,ref})=>{
      const meta=f.db._get(ref.path);if(!armed || kind!=='draft' || !meta.edited)return;
      if(changed==='generation'){
        const path=ST+'/schedule_state/publication_authority',root=f.db._get(path);
        f.db._put(path,{...root,generation:root.generation+1});
      }else{
        const path=ST+'/schedule_publication_months/2026-09',owner=f.db._get(path);
        f.db._put(path,{...owner,activation_id:'f'.repeat(64)});
      }
    }});
    const publication=await publish(f),owner=f.db._get(ST+'/schedule_publication_months/2026-09');
    const row=f.db._paths(ST+'/schedule_publications/'+publication.publication_id+'/rows/').map(p=>f.db._get(p).row).find(r=>r.slots.length);
    const edits=[{kind:'unassign',uid:row.slots[0].person,dates:[row.date]}],report=await f.rt.previewScheduleEdit(req({expected:owner,edits}));
    const operationCount=f.db._paths(ST+'/schedule_publication_authority_operations/').length;
    armed=true;
    await assert.rejects(()=>f.rt.applyScheduleEdit(req({request_id:'authority_race_'+changed,expected:owner,edits,expected_edit_digest:report.edit_digest})),/בעלות/);
    assert.equal(f.db._paths(ST+'/schedule_publication_authority_operations/').length,operationCount);
    const editedDrafts=f.db._paths(ST+'/schedule_drafts/').map(path=>f.db._get(path)).filter(draft=>draft && draft.edited===true);
    assert.ok(editedDrafts.length>0);
    assert.ok(editedDrafts.every(draft=>draft.status!=='complete'),'stale monthly edit must stop before draft completion');
  }
});
test('status preserves signed full range and edited/delivery fields; migration is not rollbackable',async()=>{
  const f=await fixture(),publication=await publish(f);
  let status=await f.rt.getStatus(req({date:'2026-09-02'}));
  assert.equal(status.active.from,'2026-09-01');assert.equal(status.active.to,'2026-09-03');assert.equal(status.active.edited,false);
  assert.equal(status.active.delivery_alerts,0);assert.equal(status.active.can_rollback,true);
  const path=f.db._paths(ST+'/schedule_publications/'+publication.publication_id+'/schedule_outbox/')[0];f.db._put(path,{...f.db._get(path),status:'dead_letter'});
  status=await f.rt.getStatus(req({date:'2026-09-02'}));assert.equal(status.active.delivery_alerts,1);
  const legacy=await fixture();let counter=0;legacy.rt=buildRuntime(legacy.db,{randomId:()=>('legacy_'+(++counter))});await publish(legacy);
  legacy.rt=buildRuntime(legacy.db,{monthAuthorityEnabled:true,randomId:()=>('migrate_'+(++counter))});await publish(legacy,'2026-10','oct');
  status=await legacy.rt.getStatus(req({date:'2026-09-02'}));assert.equal(status.active.can_rollback,false);assert.equal(status.active.rollback_operation_id,null);
});
test('same-owner cross-month edit is one atomic operation and abort changes neither owner',async()=>{
  let abort=false;const f=await fixture({beforeSnapshotFinalize:async({kind})=>{if(abort && kind==='publication')throw Error('cross-month-abort');}});
  const draft=await f.rt.runPlanner(req({request_id:'two_months',start:'2026-09-01',months:2}));
  const preview=await f.rt.getDraftPreview(req({draft_id:draft.draft_id,start:'2026-09-01'}));
  const published=await f.rt.publish(req({request_id:'two_pub',draft_id:draft.draft_id,expected_content_digest:preview.expected_content_digest}));
  const rows=f.db._paths(ST+'/schedule_publications/'+published.publication_id+'/rows/').map(p=>f.db._get(p).row);
  const edits=['2026-09','2026-10'].map(month=>{const row=rows.find(r=>r.date.startsWith(month) && r.slots.length);return {kind:'unassign',uid:row.slots[0].person,dates:[row.date]};});
  const expected=f.db._get(ST+'/schedule_publication_months/2026-09'),oct=f.db._get(ST+'/schedule_publication_months/2026-10');
  const report=await f.rt.previewScheduleEdit(req({expected,edits}));assert.deepEqual(report.affected_months,['2026-09','2026-10']);
  const request=req({request_id:'cross_edit',expected,edits,expected_edit_digest:report.edit_digest});abort=true;
  await assert.rejects(()=>f.rt.applyScheduleEdit(request),/cross-month-abort/);
  assert.deepEqual(f.db._get(ST+'/schedule_publication_months/2026-09'),expected);assert.deepEqual(f.db._get(ST+'/schedule_publication_months/2026-10'),oct);
  abort=false;const result=await f.rt.applyScheduleEdit(request);
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-09').publication_id,result.publication_id);
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-10').publication_id,result.publication_id);
});
test('migration retains legacy confirmations only for the deterministic seed activation',async()=>{
  const f=await fixture();let count=0;f.rt=buildRuntime(f.db,{randomId:()=>('legacy_'+(++count))});const original=await publish(f);
  const row=f.db._paths(ST+'/schedule_publications/'+original.publication_id+'/rows/').map(p=>f.db._get(p).row).find(r=>r.slots.some(s=>s.person==='u1'));
  const response=req({request_id:'legacy_answer',publication_id:original.publication_id,item_id:row.date,answer:'confirm'});response.auth.uid='u1';await f.rt.respond(response);
  f.rt=buildRuntime(f.db,{monthAuthorityEnabled:true,randomId:()=>('enabled_'+(++count))});await publish(f,'2026-10','oct');
  const request=req({date:row.date});request.auth.uid='u1';let view=await f.rt.getMy(request);assert.equal(view.days[0].answer.status,'confirmed');
  const expected=f.db._get(ST+'/schedule_publication_months/2026-09'),edits=[{kind:'unassign',uid:'u1',dates:[row.date]}];
  const report=await f.rt.previewScheduleEdit(req({expected,edits})),edited=await f.rt.applyScheduleEdit(req({request_id:'edit_legacy',expected,edits,expected_edit_digest:report.edit_digest}));
  await f.rt.rollback(req({request_id:'restore_legacy',target_operation_id:edited.publication_id,reason_code:'configuration_error'}));
  view=await f.rt.getMy(request);assert.equal(view.days[0].answer,null);assert.equal(view.days[0].requires_answer,true);
});
