import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFakeDb,buildRuntime,seed,req,ST,SHEET} from '../tests/_schedule-fake.mjs';
const SID=ST.split('/')[1],RELEASE='42H.19.1';
function activation(){const r=req({station_id:SID,expected_release_id:RELEASE});r.auth.token.super=true;r.auth.token.auth_time=1787637600;return r;}
function superRequest(data={}){const r=activation();r.data=data;return r;}
async function fixture(hooks={}){const db=createFakeDb(),rt=buildRuntime(db,{monthAuthorityEnabled:true,monthAuthorityControlEnabled:true,monthAuthorityReleaseId:RELEASE,
  isSuper:auth=>auth.token.super===true,getAuthUser:async uid=>({uid,disabled:false,customClaims:{super:true},tokensValidAfterTime:'1970-01-01T00:00:00.000Z'}),...hooks});await seed(db);db._put(ST+'/schedule_state/runtime',{...db._get(ST+'/schedule_state/runtime'),mode:'new'});return {db,rt};}
async function publish(f,month='2026-09',id='one'){
  const input={month,paste:SHEET.replace(/([123])\/9(\/26)?/g,'$1/'+Number(month.slice(5))+'$2'),aliases:{'רועי':'u1','אבטחה':null,'גיא':'u5'}};
  const report=await f.rt.previewScheduleImport(req(input));const draft=await f.rt.importScheduleSheet(req({...input,request_id:'import_'+id,expected_report_digest:report.report_digest}));
  const preview=await f.rt.getDraftPreview(req({draft_id:draft.draft_id,start:draft.from}));
  return f.rt.publish(req({request_id:'publish_'+id,draft_id:draft.draft_id,expected_content_digest:preview.expected_content_digest}));
}
test('capable release remains compatibility until atomic super activation; next month retains seed',async()=>{
  const f=await fixture(),sep=await publish(f);assert.equal(f.db._get(ST+'/schedule_state/publication_authority'),null);
  const result=await f.rt.activateMonthAuthority(activation());assert.equal(result.duplicate,false);
  assert.equal(f.db._get(ST+'/schedule_state/publication_authority_control').enabled,true);
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-09').publication_id,sep.publication_id);
  await publish(f,'2026-10','oct');const view=await f.rt.getStationRange(req({from:'2026-09-01',to:'2026-09-03'}));assert.ok(view.days.every(day=>day.provenance.publication_id===sep.publication_id));
  assert.equal((await f.rt.activateMonthAuthority(activation())).duplicate,true);
});
test('activation rejects non-super, stale fresh claims and wrong release without writes',async()=>{
  const f=await fixture();await assert.rejects(()=>f.rt.activateMonthAuthority(req({station_id:SID,expected_release_id:RELEASE})),/מנהל־על/);
  const wrong=activation();wrong.data.expected_release_id='old';await assert.rejects(()=>f.rt.activateMonthAuthority(wrong),/release-mismatch/);
  const stale=await fixture({getAuthUser:async()=>({disabled:false,customClaims:{super:false}})});await assert.rejects(()=>stale.rt.activateMonthAuthority(activation()),/מנהל־על/);
  assert.equal(f.db._get(ST+'/schedule_state/publication_authority'),null);assert.equal(stale.db._get(ST+'/schedule_state/publication_authority'),null);
});
test('compatibility publication started before activation cannot finalize after it',async()=>{
  let f,activate=false;f=await fixture({beforeSnapshotFinalize:async({kind})=>{if(activate && kind==='publication'){activate=false;await f.rt.activateMonthAuthority(activation());}}});
  const original=await publish(f);activate=true;
  await assert.rejects(()=>publish(f,'2026-10','race'),/selection-changed/);
  assert.equal(f.db._get(ST+'/schedule_state/active').publication_id,original.publication_id);
  assert.equal(f.db._get(ST+'/schedule_publication_months/2026-10'),null);
});
test('provider result persists after activation while pre-provider activation prevents send',async()=>{
  let f,sends=0;f=await fixture({sendPush:async()=>{sends++;await f.rt.activateMonthAuthority(activation());return {sent:1};}});
  const pub=await publish(f),path=f.db._paths(ST+'/schedule_publications/'+pub.publication_id+'/schedule_outbox/')[0];
  await f.rt.deliverOutbox(f.db.doc(path));assert.equal(sends,1);assert.equal(f.db._get(path).status,'sent');
  let g;g=await fixture({beforeOutboxSend:async()=>g.rt.activateMonthAuthority(activation()),sendPush:async()=>{throw Error('must not send');}});
  const old=await publish(g),p=g.db._paths(ST+'/schedule_publications/'+old.publication_id+'/schedule_outbox/')[0];
  await assert.rejects(()=>g.rt.deliverOutbox(g.db.doc(p)),/selection-changed/);assert.notEqual(g.db._get(p).status,'sent');
});
test('cutover during snapshot chunks prevents completion and monthly gaps reject ambiguity',async()=>{
  let f,cutover=false;f=await fixture({beforeSnapshotWriteChunk:async()=>{if(cutover){cutover=false;await f.rt.activateMonthAuthority(activation());}}});
  await publish(f);cutover=true;await assert.rejects(()=>publish(f,'2026-10','staging_race'),/selection-changed/);
  const staged=f.db._paths(ST+'/schedule_drafts/').filter(p=>p.split('/').length===4).map(p=>f.db._get(p)).filter(d=>d.status==='staging');
  assert.ok(staged.length);assert.ok(staged.every(d=>d.snapshot_complete!==true));
  await assert.rejects(()=>f.rt.getGapReport(req({})),/טווח חודשים/);
  const gap=await f.rt.getGapReport(req({from:'2026-09-01',to:'2026-09-03'}));assert.equal(gap.target.kind,'publication');
});
test('activation transaction binds signed singleton coverage after fresh Auth recheck',async()=>{
  let f,pub,reads=0;f=await fixture({getAuthUser:async uid=>{if(++reads===2){const path=ST+'/schedule_publications/'+pub.publication_id;f.db._put(path,{...f.db._get(path),from:'2026-08-01'});}return {uid,customClaims:{super:true},tokensValidAfterTime:'1970-01-01T00:00:00Z'};}});
  pub=await publish(f);await assert.rejects(()=>f.rt.activateMonthAuthority(activation()),/singleton-changed/);assert.equal(f.db._get(ST+'/schedule_state/publication_authority'),null);
});
test('mixed-station worker chooses each authority independently and rejects forged physical station',async()=>{
  const sent=[];const f=await fixture({sendPush:async sid=>{sent.push(sid);return {sent:1};}}),pub=await publish(f);
  const source=f.db._paths(ST+'/schedule_publications/'+pub.publication_id+'/schedule_outbox/')[0],value=f.db._get(source),other='stations/other';
  f.db._put(other+'/schedule_state/runtime',{mode:'new'});f.db._put(other+'/schedule_state/active',f.db._get(ST+'/schedule_state/active'));
  f.db._put(other+'/schedule_publications/'+pub.publication_id,{...f.db._get(ST+'/schedule_publications/'+pub.publication_id),station_id:'other'});
  f.db._put(other+'/users/'+value.person,{...f.db._get(ST+'/users/'+value.person),station_id:'other',station:'other'});
  const otherPath=source.replace(ST,other);f.db._put(otherPath,{...value,station_id:'other'});
  await f.rt.activateMonthAuthority(activation());
  f.db.collectionGroup=name=>({where(field,op,status){
    assert.equal(name,'schedule_outbox');assert.equal(field,'status');assert.equal(op,'==');
    return {limit(max){return {async get(){
      const paths=f.db._paths('stations/').filter(p=>p.includes('/schedule_outbox/') && f.db._get(p).status===status).slice(0,max);
      const docs=await Promise.all(paths.map(p=>f.db.doc(p).get()));return {docs};
    }};}};
  }});
  await f.rt.resumeOutbox();assert.ok(sent.includes(SID));assert.ok(sent.includes('other'));
  f.db._put(otherPath,{...value,station_id:SID});await assert.rejects(()=>f.rt.deliverOutbox(f.db.doc(otherPath)),/physical-scope/);
});
test('publication committed before cutover returns durable success without retrying under new mode',async()=>{
  const f=await fixture(),original=f.db.runTransaction;let activated=false;
  f.db.runTransaction=async callback=>{
    const before=f.db._get(ST+'/schedule_state/active');
    const result=await original.call(f.db,callback);
    const after=f.db._get(ST+'/schedule_state/active');
    if(!activated && !before && after){activated=true;await f.rt.activateMonthAuthority(activation());}
    return result;
  };
  const published=await publish(f);assert.equal(published.duplicate,false);
  assert.equal(f.db._get(ST+'/schedule_state/active').publication_id,published.publication_id);
  assert.equal(f.db._get(ST+'/schedule_state/publication_authority').generation,0);
  assert.equal(f.db._paths(ST+'/schedule_publication_authority_operations/').length,0);
});
test('monthly shadow promotion changes mode only, replays after NEW, never releases old suppressed jobs',async()=>{
  let sent=0;const f=await fixture({sendPush:async()=>{sent++;return {sent:1};}});
  f.db._put(ST+'/schedule_state/runtime',{...f.db._get(ST+'/schedule_state/runtime'),mode:'shadow'});
  const pub=await publish(f);await f.rt.activateMonthAuthority(activation());
  const before=f.db._get(ST+'/schedule_publication_months/2026-09'),pointer=f.db._get(ST+'/schedule_state/active');
  const option=await f.rt.getModeOptions(superRequest());assert.equal(option.authority_mode,'monthly');assert.ok(option.targets.some(t=>t.to==='new' && t.available));
  const preview=await f.rt.previewCutover(superRequest());assert.equal(preview.schema,'schedule-month-cutover-preflight-v1');
  const request=superRequest({request_id:'monthly_live',preflight_signature:preview.preflight_signature,expected_generation:preview.expected_generation});
  const result=await f.rt.promoteToNew(request);assert.equal(result.mode,'new');assert.equal(result.duplicate,false);
  assert.equal((await f.rt.promoteToNew(request)).duplicate,true);
  assert.deepEqual(f.db._get(ST+'/schedule_publication_months/2026-09'),before);assert.deepEqual(f.db._get(ST+'/schedule_state/active'),pointer);
  const jobs=f.db._paths(ST+'/schedule_publications/'+pub.publication_id+'/schedule_outbox/');
  assert.ok(jobs.every(path=>f.db._get(path).status==='suppressed_trial'));
  await f.rt.deliverOutbox(f.db.doc(jobs[0]));assert.equal(sent,0);
  await assert.rejects(()=>f.rt.promoteToNew(superRequest({...request.data,preflight_signature:'a'.repeat(64)})),/request-conflict/);
});
test('monthly preflight refuses changed owners/control, OFF and revoked super before mode write',async()=>{
  let revoked=false;const f=await fixture({getAuthUser:async uid=>({uid,customClaims:{super:!revoked},tokensValidAfterTime:'1970-01-01T00:00:00Z'})});
  await publish(f);await f.rt.activateMonthAuthority(activation());f.db._put(ST+'/schedule_state/runtime',{...f.db._get(ST+'/schedule_state/runtime'),mode:'shadow'});
  const preview=await f.rt.previewCutover(superRequest()),request=superRequest({request_id:'race',preflight_signature:preview.preflight_signature,expected_generation:preview.expected_generation});
  const path=ST+'/schedule_publication_months/2026-09',owner=f.db._get(path);
  f.db._del(path);await assert.rejects(()=>f.rt.promoteToNew(request),/stale/);f.db._put(path,owner);
  const added=ST+'/schedule_publication_months/2026-10';
  f.db._put(added,{schema_version:2,state:'unowned',station_id:SID,month:'2026-10',activation_id:'c'.repeat(64),operation_id:'other',operation_publication_id:'other'});
  await assert.rejects(()=>f.rt.promoteToNew(request),/stale/);f.db._del(added);
  const controlPath=ST+'/schedule_state/publication_authority_control',control=f.db._get(controlPath);f.db._put(controlPath,{...control,activation_id:'b'.repeat(64)});
  await assert.rejects(()=>f.rt.promoteToNew(request),/stale/);f.db._put(controlPath,control);
  revoked=true;await assert.rejects(()=>f.rt.promoteToNew(request),/מנהל־על/);revoked=false;
  f.db._put(ST+'/schedule_state/runtime',{...f.db._get(ST+'/schedule_state/runtime'),mode:'off'});await assert.rejects(()=>f.rt.previewCutover(superRequest()),/shadow-required/);
  assert.equal(f.db._paths(ST+'/schedule_month_cutovers/').length,0);
});
test('monthly promotion inventory capacity is explicit and never writes a partial mode change',async()=>{
  const f=await fixture();await f.rt.activateMonthAuthority(activation());f.db._put(ST+'/schedule_state/runtime',{mode:'shadow'});
  for(let i=0;i<401;i++){
    const month=new Date(Date.UTC(2000+Math.floor(i/12),i%12,1)).toISOString().slice(0,7);
    f.db._put(ST+'/schedule_publication_months/'+month,{schema_version:2,state:'unowned',station_id:SID,month,activation_id:'d'.repeat(64),operation_id:'old',operation_publication_id:'old'});
  }
  await assert.rejects(()=>f.rt.previewCutover(superRequest()),/capacity/);
  assert.equal(f.db._get(ST+'/schedule_state/runtime').mode,'shadow');assert.equal(f.db._paths(ST+'/schedule_month_cutovers/').length,0);
});
test('monthly OFF preserves existing SHADOW target but never offers direct NEW',async()=>{
  const f=await fixture();await f.rt.activateMonthAuthority(activation());f.db._put(ST+'/schedule_state/runtime',{...f.db._get(ST+'/schedule_state/runtime'),mode:'off'});
  const options=await f.rt.getModeOptions(superRequest());assert.equal(options.authority_mode,'monthly');
  assert.ok(options.targets.some(target=>target.to==='shadow' && target.available));assert.equal(options.targets.some(target=>target.to==='new'),false);
});
