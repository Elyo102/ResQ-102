// Real loopback Firestore profiles; Auth is an explicit synthetic SDK double.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {assertHrQueryTarget} from './hr-query-target.mjs';
assertHrQueryTarget(process.env);
process.env.METADATA_SERVER_DETECTION='none';
const {initializeApp,deleteApp}=await import('firebase-admin/app');
const {getFirestore}=await import('firebase-admin/firestore');
const require=createRequire(import.meta.url);
const {createHrMonthlyReadAccess}=require('../functions/hr-monthly-read-access.js');
class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
const suffix=randomBytes(8).toString('hex'),sid='it_hr_read_'+suffix,uid='hr_'+suffix,superUid='super_'+suffix;
const app=initializeApp({projectId:'demo-resq'},'hr-read-'+suffix),db=getFirestore(app);
const profile=db.doc(`stations/${sid}/users/${uid}`);
const authTime=1788220800;
let records=new Map(),failure=null,authCalls=0,passed=0;
const auth={async getUser(id){authCalls++;if(failure)throw Object.assign(Error('synthetic'),{code:failure});
  if(!records.has(id))throw Object.assign(Error('synthetic'),{code:'auth/user-not-found'});return structuredClone(records.get(id));}};
const gate=createHrMonthlyReadAccess({db,auth,HttpsError});
const request=(superUser=false)=>({auth:{uid:superUser?superUid:uid,token:{stationId:sid,role:'hr_coordinator',auth_time:authTime,...(superUser?{super:true}:{})}},data:{}});
async function reset(){
 failure=null;authCalls=0;
 records=new Map([[uid,{uid,disabled:false,customClaims:{stationId:sid,role:'hr_coordinator'},tokensValidAfterTime:new Date(authTime*1000).toUTCString()}],
  [superUid,{uid:superUid,disabled:false,customClaims:{stationId:sid,super:true}}]]);
 await profile.set({stationId:sid,role:'hr_coordinator',active:true,is_active:true});
}
const denied=(fn,code='permission-denied')=>assert.rejects(fn,e=>e.code===code);
async function check(name,fn){await reset();await fn();passed++;console.log('PASS '+name);}
try{
 await check('valid HR returns once with fresh initial and final authorization',async()=>{
  let calls=0;const result={state:'over',items:[{synthetic:true}]};
  assert.equal(await gate.run(request(),async ctx=>{calls++;assert.equal(ctx.sid,sid);assert.equal(ctx.uid,uid);return result;}),result);
  assert.equal(calls,1);assert.ok(authCalls>=2);
 });
 await check('initial inactive profile prevents data operation',async()=>{
  await profile.update({active:false});let calls=0;await denied(()=>gate.run(request(),async()=>{calls++;}));assert.equal(calls,0);
 });
 await check('profile inactive transferred and demoted during read cannot return',async()=>{
  for(const patch of [{active:false},{stationId:sid+'_other'},{role:'firefighter'}]){
   await reset();let calls=0;await denied(()=>gate.run(request(),async()=>{calls++;await profile.update(patch);return {state:'over'};}));assert.equal(calls,1);
  }
 });
 await check('empty and not-built results still require final authorization',async()=>{
  for(const result of [{state:'not_built'},{state:'clear',over_employees:[]}]){
   await reset();await denied(()=>gate.run(request(),async()=>{await profile.update({is_active:false});return result;}));
  }
 });
 await check('Auth disabled claims transfer and revocation during read deny',async()=>{
  for(const mutate of [r=>r.disabled=true,r=>r.customClaims.stationId=sid+'_other',r=>r.customClaims.role='firefighter',r=>r.tokensValidAfterTime=new Date((authTime+1)*1000).toUTCString()]){
   await reset();await denied(()=>gate.run(request(),async()=>{mutate(records.get(uid));return {state:'clear'};}));
  }
 });
 await check('Auth missing and unavailable remain fail closed',async()=>{
  for(const [cause,expected] of [['auth/user-not-found','permission-denied'],['auth/internal-error','unavailable']]){
   await reset();await denied(()=>gate.run(request(),async()=>{failure=cause;return {state:'not_built'};}),expected);
  }
 });
 await check('super requires fresh Auth but no station profile',async()=>{
  assert.equal((await gate.run(request(true),async()=>({state:'clear'}))).state,'clear');assert.ok(authCalls>=2);
  await denied(()=>gate.run(request(true),async()=>{records.get(superUid).customClaims.super=false;return {state:'clear'};}));
 });
 await check('invalid authentication prevents operation',async()=>{
  for(const at of [undefined,-1,1.5,Number.MAX_SAFE_INTEGER]){
   let calls=0;const req=request();req.auth.token.auth_time=at;
   await denied(()=>gate.run(req,async()=>{calls++;}),'unauthenticated');assert.equal(calls,0);
  }
 });
 await check('request context cannot change station or uid during operation',async()=>{
  const req=request();await denied(()=>gate.run(req,async()=>{
   req.auth.uid=superUid;req.auth.token.stationId=sid+'_other';req.auth.token.super=true;
   await profile.update({active:false});return {state:'over'};
  }));
 });
 await check('operation failure propagates without replay',async()=>{
  let calls=0;await assert.rejects(gate.run(request(),async()=>{calls++;throw new HttpsError('aborted','synthetic');}),e=>e.code==='aborted');assert.equal(calls,1);
 });
 console.log(`hr-monthly-read-access: ${passed}/10 PASS`);
}finally{
 try{await profile.delete();console.log('Cleaned exactly one owned synthetic profile');}
 finally{await db.terminate();await deleteApp(app);}
}
