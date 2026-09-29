// Direct-client swap transitions only. No Functions trigger or durable offline queue.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {assertHrQueryTarget} from './hr-query-target.mjs';
assertHrQueryTarget(process.env);
process.env.METADATA_SERVER_DETECTION='none';
const {initializeTestEnvironment}=await import('@firebase/rules-unit-testing');
const {doc,setDoc,updateDoc,getDoc,deleteDoc,serverTimestamp,Timestamp,disableNetwork,enableNetwork}=await import('firebase/firestore');
const [host,port]=process.env.FIRESTORE_EMULATOR_HOST.split(':');
const env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host,port:Number(port),rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
const sid='it_swap_'+randomBytes(10).toString('hex'),owned=new Set(),clients=new Map();
const path=id=>`stations/${sid}/swaps/${id}`;
const db=uid=>{
  if(!clients.has(uid))clients.set(uid,env.authenticatedContext(uid,{email:`${uid}@example.test`,emp:uid,role:'firefighter',stationId:sid,shift:'B'}).firestore());
  return clients.get(uid);
};
async function admin(fn){return env.withSecurityRulesDisabled(async c=>fn(c.firestore()));}
async function seed(id,extra={}){owned.add(path(id));await admin(d=>setDoc(doc(d,path(id)),{from_uid:'owner',from_crew:'A',from_date:'2026-10-01',to_uid:'',to_crew:'',to_date:'',status:'open',...extra}));}
async function read(id){let value;await admin(async d=>{value=(await getDoc(doc(d,path(id)))).data();});return value;}
async function profile(uid,patch={}){const p=`stations/${sid}/users/${uid}`;owned.add(p);await admin(d=>setDoc(doc(d,p),{role:'firefighter',station:sid,is_active:true,...patch}));}
const take=(uid,id,extra={})=>updateDoc(doc(db(uid),path(id)),{status:'cmd_from',to_uid:uid,to_crew:'B',to_date:'2026-10-04',peer_at:serverTimestamp(),updated_at:serverTimestamp(),...extra});
async function denied(promise){await assert.rejects(promise,e=>e.code==='permission-denied');}
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
try{
  for(const uid of ['owner','first','second'])await profile(uid);
  await check('concurrent accept has exactly one winner and unchanged losing retry',async()=>{
    await seed('race');const results=await Promise.allSettled([take('first','race'),take('second','race')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const loser=results.findIndex(r=>r.status==='rejected');assert.equal(results[loser].reason.code,'permission-denied');
    const before=await read('race');assert.equal(before.to_uid,loser===0?'second':'first');assert.equal(before.status,'cmd_from');
    await denied(take(loser===0?'first':'second','race'));assert.deepEqual(await read('race'),before);
  });
  await check('same successful acceptance retry is conflict, never a second transition',async()=>{
    await seed('retry');await take('first','retry');const before=await read('retry');await denied(take('first','retry'));assert.deepEqual(await read('retry'),before);
  });
  await check('accept versus owner cancel finishes cancelled and cannot resurrect',async()=>{
    await seed('cancel');const results=await Promise.allSettled([take('first','cancel'),updateDoc(doc(db('owner'),path('cancel')),{status:'cancelled',updated_at:serverTimestamp()})]);
    assert.equal(results[1].status,'fulfilled');if(results[0].status==='rejected')assert.equal(results[0].reason.code,'permission-denied');
    assert.equal((await read('cancel')).status,'cancelled');await denied(take('second','cancel'));
  });
  await check('deactivation after client read denies acceptance with stale claims',async()=>{
    await seed('inactive');await getDoc(doc(db('first'),path('inactive')));await profile('first',{is_active:false});
    try{await denied(take('first','inactive'));assert.equal((await read('inactive')).status,'open');}finally{await profile('first');}
  });
  await check('station transfer after client read denies cancellation',async()=>{
    await seed('transfer');await getDoc(doc(db('owner'),path('transfer')));await profile('owner',{station:'elsewhere'});
    try{await denied(updateDoc(doc(db('owner'),path('transfer')),{status:'cancelled'}));assert.equal((await read('transfer')).status,'open');}finally{await profile('owner');}
  });
  await check('approved swap cannot be cancelled or accepted again',async()=>{
    await seed('approved',{status:'approved',to_uid:'first',to_crew:'B',to_date:'2026-10-04'});
    await denied(updateDoc(doc(db('owner'),path('approved')),{status:'cancelled'}));await denied(take('second','approved'));assert.equal((await read('approved')).status,'approved');
  });
  await check('server transforms resolve to equal operational timestamps',async()=>{
    await seed('time');const before=Date.now();await take('first','time');const value=await read('time');
    assert.ok(value.peer_at instanceof Timestamp);assert.ok(value.updated_at.isEqual(value.peer_at));assert.ok(value.updated_at.toMillis()>=before-1000&&value.updated_at.toMillis()<=Date.now()+1000);
  });
  await check('legacy timestamp schema remains permissive, not server-enforced',async()=>{
    await seed('legacy_time');const supplied=Timestamp.fromMillis(0);await take('first','legacy_time',{peer_at:supplied,updated_at:supplied});assert.equal((await read('legacy_time')).updated_at.toMillis(),0);
  });
  await check('in-memory disconnected acceptance is rejected after server cancellation',async()=>{
    await seed('offline');const client=db('second');await getDoc(doc(client,path('offline')));await disableNetwork(client);
    const pending=take('second','offline');const outcome=pending.then(()=>({ok:true}),e=>({ok:false,code:e.code}));
    try{await updateDoc(doc(db('owner'),path('offline')),{status:'cancelled',updated_at:serverTimestamp()});}finally{await enableNetwork(client);}
    assert.deepEqual(await outcome,{ok:false,code:'permission-denied'});assert.equal((await read('offline')).status,'cancelled');
  });
  assert.equal(passed,9);console.log('9 swap resilience Rules checks passed; no trigger or reload-persistence claim.');
}finally{
  await admin(async d=>{for(const p of owned)await deleteDoc(doc(d,p));});
  await env.cleanup();
}
