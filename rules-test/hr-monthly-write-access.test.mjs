// Native transaction regression only: no live credentials or production paths.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {assertHrQueryTarget} from './hr-query-target.mjs';
assertHrQueryTarget(process.env);
process.env.METADATA_SERVER_DETECTION='none';
const {initializeApp,deleteApp}=await import('firebase-admin/app');
const {getFirestore}=await import('firebase-admin/firestore');
const require=createRequire(import.meta.url);
const {createHrMonthlySummary}=require('../functions/hr-monthly-summary');
const {createHrMonthlyReadAccess}=require('../functions/hr-monthly-read-access');
const {createHrMonthsBackfill,RECEIPT_DOC}=require('../functions/hr-months-backfill');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const suffix=randomBytes(8).toString('hex'),sid='it_hr_write_'+suffix,uid='actor',month='2026-09';
const app=initializeApp({projectId:'demo-resq'},'hr-write-'+suffix),db=getFirestore(app),owned=new Set();
const root=`stations/${sid}`,profile=db.doc(`${root}/users/${uid}`);
const auth={async getUser(){return {uid,disabled:false,customClaims:{stationId:sid,role:'hr_coordinator'}};}};
const req={auth:{uid,token:{stationId:sid,role:'hr_coordinator',auth_time:1700000000}},data:{}};
const session=createHrMonthlyReadAccess({db,auth,HttpsError}).capture(req);
const context={month,limit:265,absences:{byUid:new Map()},longAbsences:{byUid:new Map()}};
const service=(database=db)=>createHrMonthlySummary({db:database,HttpsError,authorize:session.inTransaction});
async function put(path,value){owned.add(path);await db.doc(path).set(value);}
async function begin(label){
 const result=await service().beginGeneration({station_id:sid,month,intent_id:label});
 const path=`${root}/hr_monthly_summaries/${month}/hr_monthly_generations/${result.generation_id}`;
 owned.add(path);for(const id of ['actor','u1','u2'])owned.add(`${path}/hr_monthly_rows/${id}`);
 return {path,input:{station_id:sid,month,generation_id:result.generation_id}};
}
let passed=0;
async function check(name,fn){await profile.update({active:true});await fn();passed++;console.log('PASS '+name);}
try{
 await put(profile.path,{stationId:sid,role:'hr_coordinator',active:true,employee_number:'actor',full_name:'Synthetic'});
 for(const id of ['u1','u2']){await put(`${root}/users/${id}`,{stationId:sid,role:'firefighter',active:true,employee_number:id,full_name:'Synthetic'});
  await put(`${root}/monthly_reports/${id}_${month}`,{total_hours:280,status:'approved'});}
 await check('native page rows and cursor commit atomically',async()=>{
  const b=await begin('atomic'),r=await service().runSlice(b.input,context),g=(await db.doc(b.path).get()).data();
  assert.equal(r.written,3);assert.equal(g.rows,3);assert.equal(g.cursor,'u2');assert.equal(g.state,'complete');
  assert.equal((await db.collection(`${b.path}/hr_monthly_rows`).get()).size,3);
 });
 await check('concurrent native slices cannot double count or duplicate page',async()=>{
  const b=await begin('concurrent');const results=await Promise.all([service().runSlice(b.input,context),service().runSlice(b.input,context)]);
  assert.equal(results.reduce((n,r)=>n+r.written,0),3);assert.equal((await db.doc(b.path).get()).data().rows,3);
  assert.equal((await db.collection(`${b.path}/hr_monthly_rows`).get()).size,3);
 });
 await check('abort after staged rows leaves no rows or cursor advance',async()=>{
  const b=await begin('abort');
  const wrapped=new Proxy(db,{get(target,key){if(key==='runTransaction')return fn=>target.runTransaction(tx=>fn(new Proxy(tx,{get(t,k){
   if(k==='set')return(ref,...args)=>{if(ref.path===b.path)throw Error('INJECTED_ABORT');return t.set(ref,...args);};
   const value=t[k];return typeof value==='function'?value.bind(t):value;
  }})));const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(service(wrapped).runSlice(b.input,context),/INJECTED_ABORT/);
  const g=(await db.doc(b.path).get()).data();assert.equal(g.rows,0);assert.equal(g.cursor,null);assert.equal(g.state,'building');
  assert.equal((await db.collection(`${b.path}/hr_monthly_rows`).get()).size,0);
 });
 await check('fresh inactive profile denies slice and begin replay without writes',async()=>{
  const b=await begin('revoked');await profile.update({active:false});
  await assert.rejects(service().runSlice(b.input,context),e=>e.code==='permission-denied');
  await assert.rejects(service().beginGeneration({station_id:sid,month,intent_id:'revoked'}),e=>e.code==='permission-denied');
  assert.equal((await db.doc(b.path).get()).data().rows,0);assert.equal((await db.collection(`${b.path}/hr_monthly_rows`).get()).size,0);
 });
 await check('dry-run backfill receipt refuses revoked profile',async()=>{
  const receipt=`${root}/hr_request_counters/${RECEIPT_DOC}`;owned.add(receipt);
  await profile.update({active:false});
  const backfill=createHrMonthsBackfill({db,HttpsError,authorize:session.inTransaction});
  await assert.rejects(backfill.run({station_id:sid,actor_uid:uid,dry_run:true}),e=>e.code==='permission-denied');
  assert.equal((await db.doc(receipt).get()).exists,false);
 });
 const receiptPath=`${root}/hr_request_counters/${RECEIPT_DOC}`;
 const sourcePath=`${root}/hr_requests/dated`;
 const backInput={station_id:sid,actor_uid:uid,dry_run:false};
 const backfill=(database=db)=>createHrMonthsBackfill({db:database,HttpsError,authorize:session.inTransaction});
 function beforeTransaction(hook){let count=0;return new Proxy(db,{get(target,key){
  if(key==='runTransaction')return async fn=>{await hook(++count);return target.runTransaction(fn);};
  const value=target[key];return typeof value==='function'?value.bind(target):value;
 }});}
 await check('fresh date changes classify current months, not stale queried months',async()=>{
  await put(sourcePath,{schema:'hr-request-v1',station_id:sid,kind:'sick',from_date:'2026-09-01',to_date:'2026-09-02'});
  const wrapped=beforeTransaction(async n=>{if(n===3)await db.doc(sourcePath).update({from_date:'2026-10-02',to_date:'2026-10-02'});});
  const result=await backfill(wrapped).run(backInput);
  assert.equal(result.classified,1);assert.deepEqual((await db.doc(sourcePath).get()).data().months,['2026-10']);
  const receipt=(await db.doc(receiptPath).get()).data();assert.equal(receipt.scan_phase,'complete');assert.ok(receipt.completed_at_ms>0);
 });
 await check('crash processing invalidates old completion and explicit restart recovers',async()=>{
  const wrapped=beforeTransaction(async n=>{if(n===3)throw Error('INJECTED_CRASH');});
  await assert.rejects(backfill(wrapped).run(backInput),/INJECTED_CRASH/);
  let receipt=(await db.doc(receiptPath).get()).data();assert.equal(receipt.scan_phase,'processing');
  assert.equal(Object.hasOwn(receipt,'completed_at_ms'),false);const abandoned=receipt.page_token;
  const result=await backfill().run(backInput);assert.equal(result.already,1);
  receipt=(await db.doc(receiptPath).get()).data();assert.equal(receipt.scan_phase,'complete');
  assert.notEqual(receipt.page_token,abandoned);assert.equal(receipt.totals.scanned,1);assert.ok(receipt.completed_at_ms>0);
 });
 await check('concurrent same-baseline begins have one winner and no double totals',async()=>{
  let reached=0,release;const barrier=new Promise(resolve=>release=resolve);
  const hook=async n=>{if(n===2){if(++reached===2)release();await barrier;}};
  const outcomes=await Promise.allSettled([backfill(beforeTransaction(hook)).run(backInput),backfill(beforeTransaction(hook)).run(backInput)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  const rejected=outcomes.find(r=>r.status==='rejected');assert.equal(rejected.reason.code,'aborted');
  const receipt=(await db.doc(receiptPath).get()).data();assert.equal(receipt.scan_phase,'complete');assert.equal(receipt.totals.scanned,1);
 });
 console.log(`hr-monthly-write-access: ${passed}/8 PASS`);
}finally{
 try{const batch=db.batch();for(const path of owned){assert.ok(path.startsWith(root+'/'));batch.delete(db.doc(path));}await batch.commit();console.log(`Cleaned exactly ${owned.size} owned paths`);}
 finally{await db.terminate();await deleteApp(app);}
}
