// Direct-client swap transitions only. No Functions trigger or durable offline queue.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
const endpoint=process.env.FIRESTORE_EMULATOR_HOST || '';
assert.match(endpoint,/^127\.0\.0\.1:(8080|8191|8199)$/,'explicit owned loopback emulator required');
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const {initializeTestEnvironment}=await import('@firebase/rules-unit-testing');
const {doc,setDoc,updateDoc,getDoc,deleteDoc,serverTimestamp,Timestamp,disableNetwork,enableNetwork}=await import('firebase/firestore');
const [host,port]=process.env.FIRESTORE_EMULATOR_HOST.split(':');
const env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host,port:Number(port),rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
const sid='it_swap_'+randomBytes(10).toString('hex'),owned=new Set(),clients=new Map();
const uids={owner:'owner_'+sid,first:'first_'+sid,second:'second_'+sid};
const path=id=>`stations/${sid}/swaps/${id}`;
const db=uid=>{
  if(!clients.has(uid))clients.set(uid,env.authenticatedContext(uid,{email:`${uid}@example.test`,emp:uid,role:'firefighter',stationId:sid,shift:'B'}).firestore());
  return clients.get(uid);
};
async function admin(fn){return env.withSecurityRulesDisabled(async c=>fn(c.firestore()));}
async function seed(id,extra={}){owned.add(path(id));await admin(d=>setDoc(doc(d,path(id)),{from_uid:uids.owner,from_crew:'A',from_date:'2026-10-01',to_uid:'',to_crew:'',to_date:'',status:'open',...extra}));}
async function read(id){let value;await admin(async d=>{value=(await getDoc(doc(d,path(id)))).data();});return value;}
async function profile(uid,patch={}){const marker='registration_terms_active/'+uid;owned.add(marker);await admin(d=>setDoc(doc(d,marker),{uid,consent_key:'1.3|2026-09-24',terms_version:'1.3',privacy_version:'2026-09-24',receipt_path:'registration_consents/'+uid+'/events/fixture'}));const p=`stations/${sid}/users/${uid}`;owned.add(p);await admin(d=>setDoc(doc(d,p),{role:'firefighter',station:sid,is_active:true,...patch}));}
const take=(uid,id,extra={})=>updateDoc(doc(db(uid),path(id)),{status:'cmd_from',to_uid:uid,to_crew:'B',to_date:'2026-10-04',peer_at:serverTimestamp(),updated_at:serverTimestamp(),...extra});
async function denied(promise){await assert.rejects(promise,e=>e.code==='permission-denied');}
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
try{
  for(const uid of [uids.owner,uids.first,uids.second])await profile(uid);
  await check('concurrent accept has exactly one winner and unchanged losing retry',async()=>{
    await seed('race');const results=await Promise.allSettled([take(uids.first,'race'),take(uids.second,'race')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const loser=results.findIndex(r=>r.status==='rejected');assert.equal(results[loser].reason.code,'permission-denied');
    const before=await read('race');assert.equal(before.to_uid,loser===0?uids.second:uids.first);assert.equal(before.status,'cmd_from');
    await denied(take(loser===0?uids.first:uids.second,'race'));assert.deepEqual(await read('race'),before);
  });
  await check('same successful acceptance retry is conflict, never a second transition',async()=>{
    await seed('retry');await take(uids.first,'retry');const before=await read('retry');await denied(take(uids.first,'retry'));assert.deepEqual(await read('retry'),before);
  });
  await check('accept versus owner cancel finishes cancelled and cannot resurrect',async()=>{
    await seed('cancel');const results=await Promise.allSettled([take(uids.first,'cancel'),updateDoc(doc(db(uids.owner),path('cancel')),{status:'cancelled',updated_at:serverTimestamp()})]);
    assert.equal(results[1].status,'fulfilled');if(results[0].status==='rejected')assert.equal(results[0].reason.code,'permission-denied');
    assert.equal((await read('cancel')).status,'cancelled');await denied(take(uids.second,'cancel'));
  });
  await check('deactivation after client read denies acceptance with stale claims',async()=>{
    await seed('inactive');await getDoc(doc(db(uids.first),path('inactive')));await profile(uids.first,{is_active:false});
    try{await denied(take(uids.first,'inactive'));assert.equal((await read('inactive')).status,'open');}finally{await profile(uids.first);}
  });
  await check('station transfer after client read denies cancellation',async()=>{
    await seed('transfer');await getDoc(doc(db(uids.owner),path('transfer')));await profile(uids.owner,{station:'elsewhere'});
    try{await denied(updateDoc(doc(db(uids.owner),path('transfer')),{status:'cancelled'}));assert.equal((await read('transfer')).status,'open');}finally{await profile(uids.owner);}
  });
  await check('approved swap cannot be cancelled or accepted again',async()=>{
    await seed('approved',{status:'approved',to_uid:uids.first,to_crew:'B',to_date:'2026-10-04'});
    await denied(updateDoc(doc(db(uids.owner),path('approved')),{status:'cancelled'}));await denied(take(uids.second,'approved'));assert.equal((await read('approved')).status,'approved');
  });
  await check('server transforms resolve to equal operational timestamps',async()=>{
    await seed('time');const before=Date.now();await take(uids.first,'time');const value=await read('time');
    assert.ok(value.peer_at instanceof Timestamp);assert.ok(value.updated_at.isEqual(value.peer_at));assert.ok(value.updated_at.toMillis()>=before-1000&&value.updated_at.toMillis()<=Date.now()+1000);
  });
  await check('legacy timestamp schema remains permissive, not server-enforced',async()=>{
    await seed('legacy_time');const supplied=Timestamp.fromMillis(0);await take(uids.first,'legacy_time',{peer_at:supplied,updated_at:supplied});assert.equal((await read('legacy_time')).updated_at.toMillis(),0);
  });
  await check('in-memory disconnected acceptance is rejected after server cancellation',async()=>{
    await seed('offline');const client=db(uids.second);await getDoc(doc(client,path('offline')));await disableNetwork(client);
    const pending=take(uids.second,'offline');const outcome=pending.then(()=>({ok:true}),e=>({ok:false,code:e.code}));
    try{await updateDoc(doc(db(uids.owner),path('offline')),{status:'cancelled',updated_at:serverTimestamp()});}finally{await enableNetwork(client);}
    assert.deepEqual(await outcome,{ok:false,code:'permission-denied'});assert.equal((await read('offline')).status,'cancelled');
  });
  await check('missing current Terms consent denies otherwise active member',async()=>{
    await seed('no_terms');await admin(d=>deleteDoc(doc(d,'registration_terms_active/'+uids.first)));
    try{await denied(take(uids.first,'no_terms'));assert.equal((await read('no_terms')).status,'open');}
    finally{await profile(uids.first);}
  });
  assert.equal(passed,10);console.log('10 swap resilience Rules checks passed; no trigger or reload-persistence claim.');
}finally{
  await admin(async d=>{for(const p of owned)await deleteDoc(doc(d,p));});
  await env.cleanup();
}
