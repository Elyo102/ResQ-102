'use strict';
const assert=require('node:assert/strict');
const {randomBytes,createHash}=require('node:crypto');
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8080|8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const admin=require('firebase-admin');
const app=admin.initializeApp({projectId:'demo-resq'},'scan-runtime-'+randomBytes(8).toString('hex'));
const db=app.firestore(),sid='scan_runtime_'+randomBytes(12).toString('hex');
const cursor=db.doc('schedule_runtime_workers/outbox_resume');
const groups=['schedule_outbox','guard_notification_jobs','guard_outbox'];
const refs=[],roots={};let owned=false,sends=0;
const runtime=require('./schedule-runtime').createScheduleRuntime({db,
  FieldValue:admin.firestore.FieldValue,FieldPath:admin.firestore.FieldPath,
  clock:()=> '2026-10-01T00:00:00.000Z',hash:v=>createHash('sha256').update(String(v)).digest('hex'),
  randomId:()=>randomBytes(12).toString('hex'),
  createEngine:require('./schedule-calendar-engine').createCalendarEngine,
  createPublication:require('./schedule-publication').createPublication,
  createService:require('./schedule-service').createScheduleService,
  isSuper:()=>false,sendPush:async()=>{sends++;throw Error('provider forbidden');}
});
(async()=>{try{
  assert.equal((await cursor.get()).exists,false,'exclusive emulator required');
  for(const group of groups)assert.equal((await db.collectionGroup(group).limit(1).get()).empty,true);
  owned=true;
  const batch=db.batch();
  for(const group of groups){
    roots[group]=group==='schedule_outbox'?'stations/'+sid+'/schedule_publications/p/'+group:'stations/'+sid+'/'+group;
    for(let i=0;i<101;i++){
      const ref=db.doc(roots[group]+'/j'+String(i).padStart(3,'0'));refs.push(ref);
      // Deliberately invalid payload must never reach the provider.
      batch.create(ref,{status:'queued',fixture:sid});
    }
  }
  await batch.commit();
  assert.deepEqual(await runtime.resumeOutbox(),{scanned:100,queued:0});
  assert.deepEqual(await runtime.resumeGuardOutbox(),{scanned:100,queued:0,jobs:{scanned:100,fanned:0}});
  for(const group of groups)assert.equal((await db.doc(roots[group]+'/j100').get()).data().status,'queued');
  assert.deepEqual(await runtime.resumeOutbox(),{scanned:1,queued:0});
  assert.deepEqual(await runtime.resumeGuardOutbox(),{scanned:1,queued:0,jobs:{scanned:1,fanned:0}});
  for(const group of groups){
    const rows=await db.collection(roots[group]).get();
    assert.equal(rows.size,101);
    for(const row of rows.docs)assert.equal(row.data().status,'cancelled');
    console.log('PASS runtime '+group+' scans tail101 and rejects invalid payload');
  }
  assert.equal(sends,0);
}finally{
  try{if(owned){const batch=db.batch();for(const ref of refs)batch.delete(ref);batch.delete(cursor);await batch.commit();}}
  finally{await app.delete();}
}})().catch(error=>{console.error(error.message);process.exitCode=1;});
