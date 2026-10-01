'use strict';
const assert=require('node:assert/strict'),{randomBytes,createHash}=require('node:crypto');
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8080|8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const admin=require('firebase-admin');
const app=admin.initializeApp({projectId:'demo-resq'},'ack-'+randomBytes(8).toString('hex'));
const db=app.firestore(),sid='ack_'+randomBytes(12).toString('hex'),station=db.doc('stations/'+sid);
const owned=[];
async function create(path,value){const ref=station.collection(path.split('/')[0]).doc(path.split('/')[1]);assert.equal((await ref.get()).exists,false);owned.push(ref);await ref.create(value);return ref;}
const runtime=sendPush=>require('./schedule-runtime').createScheduleRuntime({db,FieldValue:admin.firestore.FieldValue,FieldPath:admin.firestore.FieldPath,
  clock:()=> '2026-09-01T06:00:00.000Z',hash:v=>createHash('sha256').update(String(v)).digest('hex'),randomId:()=>randomBytes(12).toString('hex'),
  createEngine:require('./schedule-calendar-engine').createCalendarEngine,createPublication:require('./schedule-publication').createPublication,
  createService:require('./schedule-service').createScheduleService,isSuper:()=>false,sendPush});
(async()=>{try{
  await create('users/viewer',{role:'firefighter',stationId:sid,station_id:sid,active:true,is_active:true});
  await create('schedule_state/runtime',{mode:'new'});
  await create('schedule_state/active',{publication_id:'pub',revision:1});
  const publication=await create('schedule_publications/pub',{status:'active',delivery_policy:'live',delivery_allowed:true});
  await create('guards/guard',{status:'open',revision:1});
  let passed=0;
  for(const kind of ['schedule','guard'])for(const change of ['none','lease','cancelled','deleted']){
    const id=kind+'_'+change;
    const ref=kind==='schedule'?publication.collection('schedule_outbox').doc(id):station.collection('guard_outbox').doc(id);
    assert.equal((await ref.get()).exists,false);owned.push(ref);
    const base={station_id:sid,status:'queued',attempt:0,expires_at:new Date('2026-10-01T00:00:00Z')};
    await ref.create(kind==='schedule'?{...base,publication_id:'pub',revision:1,person:'viewer',delivery_policy:'live',delivery_allowed:true,push:{title:'synthetic',body:'synthetic'}}
      :{...base,guard_id:'guard',recipient_uid:'viewer',kind:'open',revision:1,date:'2026-09-02',start:'08:00',end:'12:00'});
    let sends=0,newer;
    const api=runtime(async()=>{
      sends++;
      if(change==='lease')await ref.update({lease_token:'new-owner',newer_owner:true});
      if(change==='cancelled')await ref.update({status:'cancelled',lease_token:null,cancel_reason:'newer-cancellation'});
      if(change==='deleted')await ref.delete();
      const snap=await ref.get();newer=snap.exists?snap.data():null;
      return {sent:1};
    });
    const method=kind==='schedule'?'deliverOutbox':'deliverGuardOutbox';
    const result=await api[method](ref);
    assert.equal(sends,1);
    if(change==='none'){
      assert.deepEqual(result,{sent:true});assert.equal((await ref.get()).data().status,'sent');
      assert.deepEqual(await api[method](ref),{skipped:true});assert.equal(sends,1);
    }else{
      assert.deepEqual(result,{sent:false,provider_accepted:true,acknowledged:false,status:'provider-accepted-unacknowledged',delivery_semantics:'at-least-once'});
      const snap=await ref.get();assert.deepEqual(snap.exists?snap.data():null,newer);
    }
    passed++;console.log('PASS '+kind+' ACK '+change);
  }
  assert.equal(passed,8);
}finally{
  try{if(owned.length){const batch=db.batch();for(const ref of owned)batch.delete(ref);await batch.commit();}}
  finally{await app.delete();}
}})().catch(error=>{console.error(error.message);process.exitCode=1;});
