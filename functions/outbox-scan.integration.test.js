'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
if(!/^127\.0\.0\.1:(8080|8191|8199)$/.test(process.env.FIRESTORE_EMULATOR_HOST||'')||
  process.env.GCLOUD_PROJECT!=='demo-resq'||process.env.GOOGLE_APPLICATION_CREDENTIALS)throw Error('demo-loopback-required');
const admin=require('firebase-admin');
const app=admin.initializeApp({projectId:'demo-resq'},'scan-'+crypto.randomBytes(6).toString('hex'));
const db=app.firestore(),FieldPath=admin.firestore.FieldPath;
const {takeFairPage,STATE_COLLECTION,STATE_DOCUMENT}=require('./schedule-outbox-fair-scan');
const cursor=db.collection(STATE_COLLECTION).doc(STATE_DOCUMENT),sid='scan_'+crypto.randomBytes(8).toString('hex');
const station=db.collection('stations').doc(sid);
const groups=['schedule_outbox','guard_outbox','guard_notification_jobs'];
const ref=(group,i)=>group==='schedule_outbox'?station.collection('schedule_publications').doc('synthetic').collection(group).doc(String(i).padStart(4,'0')):station.collection(group).doc(String(i).padStart(4,'0'));
const page=(collection,status='queued')=>takeFairPage({db,FieldPath,collection,status});
let owned=false,passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function main(){
  assert.equal((await cursor.get()).exists,false,'do not reset existing shared cursor');
  for(const group of groups)assert.equal((await db.collectionGroup(group).limit(1).get()).empty,true,'foreign queue fixture present');
  assert.equal((await station.get()).exists,false);owned=true;
  for(const group of groups){const b=db.batch();for(let i=0;i<101;i++)b.create(ref(group,i),{status:'queued',created_at:admin.firestore.Timestamp.fromMillis(1)});await b.commit();}
  for(const group of groups)await check(group+' reaches101 despite unchanged first100 then wraps crashed page',async()=>{
    const a=await page(group),b=await page(group),c=await page(group);
    assert.equal(a.docs.length,100);assert.equal(b.docs.length,1);assert.equal(c.wrapped,true);
    assert.equal(new Set([...a.docs,...b.docs].map(d=>d.ref.path)).size,101);
    assert.deepEqual(c.docs.map(d=>d.ref.path),a.docs.map(d=>d.ref.path));
    assert.equal((await ref(group,0).get()).data().status,'queued','scan must not acknowledge work');
  });
  await check('concurrent claims advance distinct adjacent pages without losing other cursor keys',async()=>{
    const before=(await cursor.get()).data().cursors;
    const both=await Promise.all([page('schedule_outbox'),page('schedule_outbox')]);
    assert.deepEqual(both.map(p=>p.docs.length).sort((a,b)=>a-b),[1,100]);
    assert.equal(new Set(both.flatMap(p=>p.docs.map(d=>d.ref.path))).size,101);
    const after=(await cursor.get()).data().cursors;
    assert.equal(after.guard_outbox_queued,before.guard_outbox_queued);
    assert.equal(after.guard_notification_jobs_queued,before.guard_notification_jobs_queued);
  });
  await check('mixed status cursors are independent and deleted cursor document still advances',async()=>{
    await ref('guard_outbox',100).update({status:'retry'});
    const retry=await page('guard_outbox','retry');assert.equal(retry.docs.length,1);
    await ref('guard_outbox',99).delete();
    const queued=await page('guard_outbox');assert.ok(queued.docs.every(d=>d.data().status==='queued'));
    assert.equal(queued.docs.length,99);
    const state=(await cursor.get()).data().cursors;
    assert.equal(state.guard_outbox_retry,ref('guard_outbox',100).path);
  });
  await check('malformed persisted state fails closed without rewriting it',async()=>{
    const before=(await cursor.get()).data();
    for(const corrupt of [{cursors:[]},{cursors:{unknown:null}},
      {cursors:{schedule_outbox_queued:'stations/foreign/guard_outbox/x'}},
      {cursors:{guard_outbox_queued:'bad/path/odd'}},
      {cursors:{guard_outbox_queued:''}}]){
      await cursor.set(corrupt);
      await assert.rejects(()=>page('guard_outbox'),/outbox-scan-cursor-invalid/);
      assert.deepEqual((await cursor.get()).data(),corrupt);
    }
    await cursor.set(before);
  });
  await check('invalid query vocabulary does not read or mutate state',async()=>{
    const before=(await cursor.get()).data();
    await assert.rejects(()=>page('users'),/outbox-scan-key-invalid/);
    await assert.rejects(()=>page('guard_notification_jobs','retry'),/outbox-scan-key-invalid/);
    assert.deepEqual((await cursor.get()).data(),before);
  });
  console.log('outbox scan: '+passed+' PASS; finite synthetic queues, not provider delivery or bounded latency');
}
main().finally(async()=>{try{if(owned){await db.recursiveDelete(station);await cursor.delete();}}finally{await app.delete();}})
  .catch(e=>{console.error(e);process.exitCode=1;});
