'use strict';
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8080|8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const admin=require('firebase-admin');
const {createControlledRuntime}=require('./schedule-month-control-runtime');
const app=admin.initializeApp({projectId:'demo-resq'},'reuse-'+randomBytes(8).toString('hex'));
const db=app.firestore(),sid='it_reuse_'+randomBytes(12).toString('hex');
const statuses=['retry','sending','queued','blocked'],owned=new Map();
const control=db.doc('stations/'+sid+'/schedule_state/publication_authority_control');
let allocations=0,reconciliations=0,mutate=false;
async function noForeignJobs(){
  for(const status of statuses){
    const snapshot=await db.collectionGroup('schedule_outbox').where('status','==',status).limit(101).get();
    assert.ok(snapshot.docs.every(doc=>owned.has(doc.ref.path)),'foreign fixture outbox present; use exclusive emulator');
  }
}
const runtime=createControlledRuntime({
  deps:{db,clock:()=> '2026-10-01T00:00:00.000Z',monthAuthorityReleaseId:'test-reuse'},
  api:{},resolveContext:async()=>{throw Error('request forbidden');},translateError:error=>error,
  createRuntime:deps=>{
    allocations++;
    return {
      async reconcileMonthControlledOutbox(ref){
        assert.ok(owned.has(ref.path),'only owned synthetic jobs may execute');
        if(mutate){
          mutate=false;
          assert.equal((await control.get()).exists,false);
          await control.create({schema_version:1,station_id:sid,enabled:false});
          owned.set(control.path,control);
        }
        await deps.db.runTransaction(async tx=>{assert.equal((await tx.get(ref)).exists,true);});
        reconciliations++;
        return {queued:false,deliver:false};
      },
      async deliverOutbox(){throw Error('provider delivery forbidden');}
    };
  }
});
(async()=>{
  try{
    await noForeignJobs();
    assert.equal((await control.get()).exists,false);
    for(let i=0;i<100;i++){
      const ref=db.doc('stations/'+sid+'/schedule_publications/p/schedule_outbox/job'+i);
      assert.equal((await ref.get()).exists,false);
      await ref.create({station_id:sid,publication_id:'p',status:'queued'});
      owned.set(ref.path,ref);
    }
    await noForeignJobs();
    assert.deepEqual(await runtime.resumeOutbox(),{scanned:100,queued:0});
    assert.equal(allocations,1);assert.equal(reconciliations,100);
    console.log('PASS native 100 jobs use one runtime with real control transactions');
    await noForeignJobs();
    await runtime.resumeOutbox();
    assert.equal(allocations,2);assert.equal(reconciliations,200);
    console.log('PASS native next invocation constructs a fresh runtime');
    mutate=true;
    await noForeignJobs();
    await assert.rejects(()=>runtime.resumeOutbox(),/authority-selection-changed/);
    assert.equal(allocations,3);assert.equal(reconciliations,200);
    console.log('PASS native same-mode control digest change rejects stale transaction');
    console.log('3 native runtime-allocation checks passed; no provider delivery claim.');
  }finally{
    try{if(owned.size){const batch=db.batch();for(const ref of owned.values())batch.delete(ref);await batch.commit();}}
    finally{await app.delete();}
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
