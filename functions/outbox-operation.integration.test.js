'use strict';
const assert=require('node:assert/strict'),{randomBytes,createHash}=require('node:crypto');
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8080|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const admin=require('firebase-admin'),app=admin.initializeApp({projectId:'demo-resq'},'operation-'+randomBytes(8).toString('hex'));
const db=app.firestore(),sid='operation_'+randomBytes(10).toString('hex'),station=db.doc('stations/'+sid),owned=[];
async function create(ref,data){assert.equal((await ref.get()).exists,false);owned.push(ref);await ref.create(data);return ref;}
const runtime=hooks=>require('./schedule-runtime').createScheduleRuntime({db,FieldValue:admin.firestore.FieldValue,FieldPath:admin.firestore.FieldPath,
  monthAuthorityOutcomeTransaction:callback=>db.runTransaction(callback),
  clock:()=> '2026-09-01T06:00:00.000Z',hash:v=>createHash('sha256').update(String(v)).digest('hex'),randomId:()=>randomBytes(12).toString('hex'),
  createEngine:require('./schedule-calendar-engine').createCalendarEngine,createPublication:require('./schedule-publication').createPublication,
  createService:require('./schedule-service').createScheduleService,isSuper:()=>false,sendPush:async()=>({sent:1}),...hooks});
let passed=0;
(async()=>{try{
  // Sweeps use a shared cursor: run only in a fresh, exclusively owned emulator.
  const cursor=db.doc('schedule_runtime_workers/outbox_resume');
  assert.equal((await cursor.get()).exists,false,'fresh exclusive emulator required: cursor already exists');
  for(const group of ['guard_outbox','guard_notification_jobs']) {
    assert.equal((await db.collectionGroup(group).limit(1).get()).empty,true,
      'fresh exclusive emulator required: '+group+' is not empty');
  }
  // Register only after every preflight passes; never delete a preexisting cursor.
  owned.push(cursor);
  for(const uid of ['viewer','second'])await create(station.collection('users').doc(uid),{role:'firefighter',stationId:sid,station_id:sid,active:true,is_active:true});
  await create(station.collection('schedule_state').doc('runtime'),{mode:'new'});
  await create(station.collection('schedule_state').doc('active'),{publication_id:'pub',revision:1});
  const pub=await create(station.collection('schedule_publications').doc('pub'),{status:'active',delivery_policy:'live',delivery_allowed:true});
  const guard=await create(station.collection('guards').doc('guard'),{status:'open',revision:1,place:'synthetic place'});
  const make=async(kind,id)=>create(kind==='schedule'?pub.collection('schedule_outbox').doc(id):station.collection('guard_outbox').doc(id),{
    station_id:sid,status:'queued',attempt:0,dedupe_key:id,expires_at:new Date('2026-10-01T00:00:00Z'),
    ...(kind==='schedule'?{publication_id:'pub',revision:1,person:'viewer',delivery_policy:'live',delivery_allowed:true,push:{title:'synthetic',body:'synthetic'}}:
      {guard_id:'guard',recipient_uid:'viewer',kind:'open',revision:1,date:'2026-09-02',start:'08:00',end:'12:00'})});
  for(const kind of ['schedule','guard']){
    const method=kind==='schedule'?'deliverOutbox':'deliverGuardOutbox';
    for(const outcome of ['success','error','suppression']){
      const ref=await make(kind,kind+'_'+outcome);let newer;
      const api=runtime({sendPush:async()=>{
        await ref.update({delivery_attempt_id:'dat_replaced'});newer=(await ref.get()).data();
        if(outcome==='error')throw Object.assign(Error('synthetic'),{code:'TIMEOUT'});
        return outcome==='suppression'?{sent:0,suppressed:true,reason:'station-silence'}:{sent:1};
      }});
      const result=await api[method](ref);assert.deepEqual((await ref.get()).data(),newer);
      if(outcome==='success')assert.equal(result.acknowledged,false);
      passed++;console.log(`PASS ${kind} same-lease replaced attempt ${outcome}`);
    }
    for(const mutation of ['recipient','payload']){
      const ref=await make(kind,kind+'_'+mutation);let sends=0;
      // Generic open prompts intentionally omit place; personal updates include it.
      if(kind==='guard' && mutation==='payload')await ref.update({kind:'assigned'});
      const api=runtime({beforeOutboxSend:async()=>{
        if(mutation==='recipient')await ref.update(kind==='schedule'?{person:'second'}:{recipient_uid:'second'});
        else if(kind==='schedule')await ref.update({push:{title:'changed',body:'changed'}});
        else await guard.update({place:'changed place'});
      },sendPush:async()=>{sends++;return {sent:1};}});
      assert.deepEqual(await api[method](ref),{skipped:true});assert.equal(sends,0);
      await guard.update({place:'synthetic place'});
      passed++;console.log(`PASS ${kind} changed ${mutation} never enters provider`);
    }
    const ref=await make(kind,kind+'_retry');let crash=true,sends=0;
    const api=runtime({sendPush:async()=>{sends++;return {sent:1};},afterOutboxProvider:async()=>{if(crash)throw Error('synthetic ACK crash');}});
    await api[method](ref);const first=(await ref.get()).data();
    assert.equal(first.delivery_uncertain,true);assert.equal(first.provider_state,'uncertain');assert.equal(first.duplicate_risk_count,1);
    await ref.update({status:'queued',next_attempt_at:null});crash=false;
    assert.deepEqual(await api[method](ref),{sent:true});const second=(await ref.get()).data();
    assert.equal(sends,2);assert.equal(second.delivery_operation_id,first.delivery_operation_id);
    assert.equal(second.delivery_payload_digest,first.delivery_payload_digest);assert.notEqual(second.delivery_attempt_id,first.delivery_attempt_id);
    assert.equal(second.delivery_ack_attempt_id,second.delivery_attempt_id);assert.equal(second.duplicate_risk_count,1);
    passed++;console.log(`PASS ${kind} uncertain retry keeps operation and new attempt`);
    // Legacy lease provenance: direct reconciler for schedule, bounded sweep for guard.
    const legacy=await make(kind,kind+'_legacy');await legacy.update({status:'sending',lease_token:'old',lease_until:new Date(0)});
    if(kind==='schedule')await api.reconcileMonthControlledOutbox(legacy,Date.parse('2026-09-01T06:00:00Z'));
    else await api.resumeGuardOutbox();
    const value=(await legacy.get()).data();assert.equal(value.prior_acceptance_unknown,true);assert.equal(value.last_uncertain_attempt_id,'legacy-untracked');
    passed++;console.log(`PASS ${kind} legacy expired lease retains prior unknown acceptance`);
  }
  assert.equal(passed,14);console.log('Outbox operation native emulator: 14/14 PASS; provider synthetic, at-least-once only');
}finally{try{if(owned.length){const batch=db.batch();for(const ref of owned)batch.delete(ref);await batch.commit();}}finally{await app.delete();}}})().catch(e=>{console.error(e);process.exitCode=1;});
