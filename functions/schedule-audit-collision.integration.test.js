'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
if(!/^127\.0\.0\.1:(8080|8191|8199)$/.test(process.env.FIRESTORE_EMULATOR_HOST||'') ||
  process.env.GCLOUD_PROJECT!=='demo-resq' || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error('owned demo emulator required before Admin import');
}
const admin=require('firebase-admin');
const app=admin.initializeApp({projectId:'demo-resq'},'audit-collision-'+crypto.randomBytes(6).toString('hex'));
const db=app.firestore();
const {createScheduleRuntime}=require('./schedule-runtime');
const {createCalendarEngine}=require('./schedule-calendar-engine');
const {createPublication}=require('./schedule-publication');
const {createScheduleService}=require('./schedule-service');
const sid='audit_'+crypto.randomBytes(10).toString('hex');
const station=db.collection('stations').doc(sid);
const cfg=station.collection('schedule_state').doc('runtime');
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
const clock=()=> '2026-09-01T06:00:00.000Z';
const employeeBase=70000000+crypto.randomInt(9000000);
const empRefs=Array.from({length:6},(_,i)=>db.collection('emp_index').doc(String(employeeBase+i)));
let owned=false,sends=0;
const api=createScheduleRuntime({db,FieldValue:admin.firestore.FieldValue,FieldPath:admin.firestore.FieldPath,
  clock,hash,randomId:()=>crypto.randomBytes(12).toString('hex'),createEngine:createCalendarEngine,
  createPublication,createService:createScheduleService,isSuper:()=>false,
  sendPush:async()=>{sends++;return {sent:1};}});
const request=(data,commander=false)=>({auth:{uid:commander?'commander':'manager',
  token:{stationId:sid,role:commander?'commander':'firefighter'}},data});
const draft={sub_stations:{a:{label:'Synthetic',minimum:2,requirements:[
  {role:'driver',label:'Driver',count:1,required:true},{role:'firefighter',label:'Firefighter',count:1,required:true}]}},
  rest:{min_gap_days:1},rotation:null,max_shifts_per_month:12};
const rows=empRefs.map((r,i)=>({row:i+2,employee_number:r.id,full_name:'Synthetic',sub_station:'a',
  active:true,roles:['driver','firefighter']}));
const audit=(kind,id)=>station.collection('schedule_'+kind+'_audit').doc(
  ({source:'sa_',policy:'pa_',mode:'ma_'})[kind]+hash(kind+'-audit|'+sid+'|'+id).slice(0,48));
const operation=(kind,id)=>station.collection('schedule_'+kind+'_operations').doc(id);
async function snapshot(ref){return (await ref.get()).data();}
async function state(collection){return (await station.collection(collection).get()).docs.map(d=>({id:d.id,data:d.data()})).sort((a,b)=>a.id.localeCompare(b.id));}
async function collision(fn){await assert.rejects(fn,e=>e.code===6 || e.code==='already-exists');}
let passed=0;
async function check(label,fn){await fn();passed++;console.log('PASS '+label);}
async function main(){
  assert.equal((await station.get()).exists,false);
  assert.ok((await db.getAll(...empRefs)).every(d=>!d.exists),'fixture indexes already occupied');
  owned=true;
  const batch=db.batch(); batch.create(station,{name:'Synthetic audit fixture'});
  for(const [uid,role]of [['manager','firefighter'],['commander','commander']])
    batch.create(station.collection('users').doc(uid),{station:sid,role,active:true,full_name:'Synthetic'});
  batch.create(station.collection('schedule_access').doc('manager'),{schema_version:1,station_id:sid,
    uid:'manager',roles:['schedule_manager'],active:true,revision:1});
  empRefs.forEach((ref,i)=>{batch.create(ref,{uid:'worker'+i,stationId:sid,active:true,retired:false});
    batch.create(station.collection('users').doc('worker'+i),{station:sid,employee_number:ref.id,
      full_name:'Synthetic '+i,role:'firefighter',active:true});});
  ['A','B','C'].forEach((crew,i)=>batch.create(station.collection('rotations').doc('r'+crew),
    {crew,position_in_cycle:i,cycle_days:3,anchor_date:'2026-09-01',is_active:true}));
  batch.create(cfg,{mode:'off'});await batch.commit();
  const policyRequest={request_id:'policy_audit',activate:true,expected_policy_id:null,draft};
  const policy=await api.savePolicy(request(policyRequest));
  await check('policy replay preserves audit; receipt removal cannot overwrite audit or policy',async()=>{
    const old=await snapshot(audit('policy','policy_audit'));
    assert.equal((await api.savePolicy(request(policyRequest))).duplicate,true);
    assert.deepEqual(await snapshot(audit('policy','policy_audit')),old);
    await operation('policy','policy_audit').delete();
    const before=await state('schedule_policies'),config=await snapshot(cfg);
    await collision(()=>api.savePolicy(request({...policyRequest,expected_policy_id:policy.policy_id,
      draft:{...draft,rest:{min_gap_days:2}}})));
    assert.deepEqual(await state('schedule_policies'),before);assert.deepEqual(await snapshot(cfg),config);
    assert.deepEqual(await snapshot(audit('policy','policy_audit')),old);
    assert.equal((await operation('policy','policy_audit').get()).exists,false);
  });
  const sourceRequest={request_id:'source_audit',activate:true,expected_source_id:null,rows};
  const source=await api.saveSource(request(sourceRequest));
  await check('source audit collision cleans owned staging and preserves active source children',async()=>{
    const old=await snapshot(audit('source','source_audit'));
    assert.equal((await api.saveSource(request(sourceRequest))).duplicate,true);
    await operation('source','source_audit').delete();
    const before=await state('schedule_sources'),config=await snapshot(cfg);
    const ref=station.collection('schedule_sources').doc(source.source_id);
    const children=(await ref.collection('people').get()).docs.map(d=>({id:d.id,data:d.data()}));
    await collision(()=>api.saveSource(request({...sourceRequest,expected_source_id:source.source_id,
      rows:rows.map((r,i)=>({...r,active:i!==0}))})));
    assert.deepEqual(await state('schedule_sources'),before);assert.deepEqual(await snapshot(cfg),config);
    assert.deepEqual((await ref.collection('people').get()).docs.map(d=>({id:d.id,data:d.data()})),children);
    assert.deepEqual(await snapshot(audit('source','source_audit')),old);
    assert.equal((await operation('source','source_audit').get()).exists,false);
  });
  const modeRequest={request_id:'mode_audit',target:'shadow',expected_mode:'off',confirmation:'shadow',reason_code:'initial_activation'};
  await api.setRuntimeMode(request(modeRequest,true));
  await check('mode replay and retained audit prevent replacement after receipt removal',async()=>{
    const old=await snapshot(audit('mode','mode_audit'));
    assert.equal((await api.setRuntimeMode(request(modeRequest,true))).duplicate,true);
    await operation('mode','mode_audit').delete();const config=await snapshot(cfg);
    await collision(()=>api.setRuntimeMode(request({request_id:'mode_audit',target:'off',expected_mode:'shadow',
      confirmation:'off',reason_code:'operational_safety'},true)));
    assert.deepEqual(await snapshot(cfg),config);assert.deepEqual(await snapshot(audit('mode','mode_audit')),old);
    assert.equal((await operation('mode','mode_audit').get()).exists,false);
  });
  const planned=await api.runPlanner(request({request_id:'audit_plan',start:'2026-09-01',months:1,overrides:[]}));
  const preview=await api.getDraftPreview(request({draft_id:planned.draft_id,start:'2026-09-01'}));
  const publication=await api.publish(request({draft_id:planned.draft_id,request_id:'audit_publish',
    expected_content_digest:preview.expected_content_digest}));
  const candidates=await station.collection('schedule_publications').where('trial_source_publication_id','==',publication.publication_id).get();
  assert.equal(candidates.size,1);const candidate=candidates.docs[0];
  const report=await api.previewCutover(request({candidate_publication_id:candidate.id},true));
  assert.equal(report.blocked,false,JSON.stringify(report.by_reason));
  const cut={request_id:'cut_audit',candidate_publication_id:candidate.id,expected_mode:'shadow',
    expected_preflight_signature:report.signature,accept_changes:report.signature};
  await check('cutover audit collision aborts promotion and keeps outbox blocked',async()=>{
    const ref=audit('mode','cut_audit');await ref.create({historical:true});
    const config=await snapshot(cfg),active=await snapshot(station.collection('schedule_state').doc('active'));
    const pub=await snapshot(candidate.ref),beforeSends=sends;
    const outbox=(await candidate.ref.collection('schedule_outbox').get()).docs.map(d=>({id:d.id,data:d.data()}));
    await collision(()=>api.promoteToNew(request(cut,true)));
    assert.deepEqual(await snapshot(ref),{historical:true});assert.deepEqual(await snapshot(cfg),config);
    assert.deepEqual(await snapshot(station.collection('schedule_state').doc('active')),active);
    assert.deepEqual(await snapshot(candidate.ref),pub);
    assert.deepEqual((await candidate.ref.collection('schedule_outbox').get()).docs.map(d=>({id:d.id,data:d.data()})),outbox);
    assert.equal(sends,beforeSends);assert.equal((await operation('mode','cut_audit').get()).exists,false);
  });
  await check('successful fresh cutover still replays without a second audit',async()=>{
    const next={...cut,request_id:'fresh_cut_audit'};
    await api.promoteToNew(request(next,true));const before=await state('schedule_mode_audit');
    assert.equal((await api.promoteToNew(request(next,true))).duplicate,true);
    assert.deepEqual(await state('schedule_mode_audit'),before);
  });
  console.log('audit collisions: '+passed+' PASS; native emulator, synthetic station only');
}
main().finally(async()=>{
  try {if(owned){await db.recursiveDelete(station);const batch=db.batch();empRefs.forEach(r=>batch.delete(r));await batch.commit();}}
  finally {await app.delete();}
}).catch(e=>{console.error(e);process.exitCode=1;});
