// Dispatch-only deploy artifact: exact-byte provenance plus emulator Rules on the SAME bytes that would be deployed.
// Local emulator only. Synthetic identities only (never the real owner uid).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,updateDoc,deleteDoc,collection,query,where,limit,serverTimestamp,Timestamp,writeBatch} from 'firebase/firestore';
import {assembleDispatchRules,CAPTURE_SHA256,DISPATCH_ANCHOR} from '../control-plane/assemble-rules.mjs';
if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8191'||process.env.GCLOUD_PROJECT!=='demo-resq')throw Error('LOCAL_EMULATOR_REQUIRED');
const hash=b=>createHash('sha256').update(b).digest('hex');
const artifact=readFileSync(new URL('../control-plane/deploy/firestore.dispatch.rules',import.meta.url));
const meta=JSON.parse(readFileSync(new URL('../control-plane/deploy/firestore-dispatch-provenance.json',import.meta.url),'utf8'));
const fragment=readFileSync(new URL('../control-plane/firestore-dispatch.rules.fragment',import.meta.url),'utf8');
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};

// ---- exact-byte provenance (no capture needed: prefix+suffix must hash to the pinned live capture) ----
await check('artifact bytes, provenance and byte-identical live-capture prefix/suffix',async()=>{
 assert.equal(meta.kind,'dispatch-only-deploy-artifact');assert.equal(meta.status,'DEPLOYED');
 assert.equal(meta.deployment.liveSourceSha256,meta.artifactSha256);assert.equal(meta.deployment.preDeploy.sourceSha256,CAPTURE_SHA256);
 assert.match(meta.deployment.rulesetName,/^projects\/resq-agent-control-20260928\/rulesets\/[0-9a-f-]{36}$/);assert.match(meta.deployment.command,/--config control-plane\/deploy\/firebase\.control-plane\.json --project resq-agent-control-20260928 --only firestore:rules/);
 assert.equal(meta.project,'resq-agent-control-20260928');assert.equal(meta.captureSha256,CAPTURE_SHA256);
 assert.equal(hash(artifact),meta.artifactSha256);assert.equal(artifact.length,meta.artifactBytes);
 assert.ok(!artifact.includes(0x0d),'artifact must be LF-only exact bytes');
 const prefix=artifact.subarray(0,meta.insertionOffsetBytes),block=artifact.subarray(meta.insertionOffsetBytes,meta.insertionOffsetBytes+meta.insertedBytes);
 const suffix=artifact.subarray(meta.insertionOffsetBytes+meta.insertedBytes);
 assert.equal(hash(Buffer.concat([prefix,suffix])),CAPTURE_SHA256,'prefix+suffix must be the live capture byte-for-byte');
 assert.equal(hash(prefix),meta.prefixSha256);assert.equal(hash(suffix),meta.suffixSha256);assert.equal(hash(block),meta.fragmentSha256);
 assert.equal(block.toString('utf8'),fragment.replace(/\r\n/g,'\n').trimEnd()+'\n');
 assert.ok(suffix.toString('utf8').startsWith(DISPATCH_ANCHOR));
 const text=artifact.toString('utf8');
 assert.equal((text.match(/match \/dispatchRequests\//g)||[]).length,1);assert.ok(text.includes('match /dispatchRequests/{id} {'));
 assert.doesNotMatch(text,/dispatchRequests\/\{[a-zA-Z]+=\*\*\}|match \/\{[a-zA-Z]+\}\/\{/,'no shared or wildcard match for dispatchRequests');
 assert.doesNotMatch(text,/Budget-only fragment|resq_budget_authorizations|agent_review_cycle|planner_draft_recovery|swap_race_review|clean_checkout_gates/,'no budget fragment and no new event labels');
 for(const name of ['dispatchTaskMap','dispatchUuid','dispatchFresh','dispatchValid','dispatchCancel'])assert.equal((text.match(new RegExp('function '+name+'\\('),'g')||[]).length,1,name);
 assert.doesNotMatch(block.toString('utf8'),/function (?:tasks|aid|policy|owner|publisher|budgetWindow|currentPrincipal)\(/);
 assert.throws(()=>assembleDispatchRules(Buffer.from('tampered'),fragment),/CAPTURE_HASH_MISMATCH/);
});
if(process.argv[2]){
 await check('private capture direct-byte comparison and deterministic reassembly',async()=>{
  const capture=readFileSync(process.argv[2]);const a=assembleDispatchRules(capture,fragment),b=assembleDispatchRules(capture,fragment);
  assert.deepEqual(a.result,artifact);assert.deepEqual(b.result,artifact);const {status,deployment,...generated}=meta;assert.deepEqual({...a.provenance,status:undefined},{...generated,status:undefined});assert.equal(a.provenance.status,'LOCAL_ARTIFACT_NOT_DEPLOYED');
  assert.deepEqual(Buffer.concat([artifact.subarray(0,meta.insertionOffsetBytes),artifact.subarray(meta.insertionOffsetBytes+meta.insertedBytes)]),capture);
 });
}

// ---- emulator Rules on the exact artifact bytes ----
const rules=artifact.toString('utf8');
const projectId='demo-resq-dispatch-'+process.pid;
const environment=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8191,rules}});
const ownerEmail=/request\.auth\.token\.email == '([^']+)'/.exec(rules)[1];
const OWNER='synthetic-owner';
const nowSeconds=()=>Math.floor(Date.now()/1000);
const client=(id,claims={})=>environment.authenticatedContext(id,{auth_time:nowSeconds(),...claims}).firestore();
const owner=(claims={})=>client(OWNER,{email:ownerEmail,email_verified:true,...claims});
const TASKS={Gemini:['docs','long-analysis','test-coverage','cross-browser'],Codex:['integration','integration-tests'],Grok:['realtime','service-workers','offline-outbox','telemetry-relays']};
const row=(extra={})=>({agent:'Grok',taskType:'realtime',note:'בדיקה quick check',status:'queued',batchId:randomUUID(),createdAt:serverTimestamp(),createdBy:OWNER,...extra});
const put=(db,data,id=randomUUID())=>setDoc(doc(db,'dispatchRequests/'+id),data);
async function seed(mutateOwner){
 await environment.clearFirestore();
 await environment.withSecurityRulesDisabled(async c=>{const db=c.firestore();
  const ownerDoc={uid:OWNER,enabled:true,revokedAfter:0,...(mutateOwner||{})};
  if(mutateOwner!=='missing')await setDoc(doc(db,'private_access/owner'),ownerDoc);
  await setDoc(doc(db,'private_publishers/synthetic-Grok'),{agent:'Grok',enabled:true,revokedAfter:0});
  await setDoc(doc(db,'private_budget_publishers/resq-ci-budget-20260928'),{enabled:true,revokedAfter:0});
  await setDoc(doc(db,'events/existing-event'),{agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',createdAt:Timestamp.now()});
  await setDoc(doc(db,'dispatchRequests/'+QUEUED),{agent:'Grok',taskType:'realtime',note:'seed',status:'queued',batchId:randomUUID(),createdAt:Timestamp.now(),createdBy:OWNER});
  await setDoc(doc(db,'dispatchRequests/'+FOREIGN),{agent:'Grok',taskType:'realtime',note:'seed',status:'queued',batchId:randomUUID(),createdAt:Timestamp.now(),createdBy:'someone-else'});
 });
}
const QUEUED=randomUUID(),FOREIGN=randomUUID();
const publisher=()=>client('synthetic-Grok',{control_plane_agent:'Grok'});
const budget=()=>client('resq-ci-budget-20260928',{control_plane_budget:true,control_plane_authorization:'rules-grant-1'});

await check('fresh owner creates every allowed agent/taskType, empty, 280 ASCII, 280 Hebrew and niqqud notes',async()=>{
 await seed();
 for(const [agent,list] of Object.entries(TASKS))for(const taskType of list)await assertSucceeds(put(owner(),row({agent,taskType})));
 for(const note of ['','a'.repeat(280),'א'.repeat(280),'שָׁלוֹם עוֹלָם ~ !?','Hebrew עברית mixed 123'])await assertSucceeds(put(owner(),row({note})));
 const odb=owner(),batch=writeBatch(odb);const batchId=randomUUID();
 for(const agent of ['Gemini','Codex','Grok'])batch.set(doc(odb,'dispatchRequests/'+randomUUID()),row({agent,taskType:TASKS[agent][0],batchId}));
 await assertSucceeds(batch.commit());
});
await check('excluded, cross-agent and unknown task types or agents are denied',async()=>{
 await seed();
 for(const extra of [{agent:'Codex',taskType:'executor'},{agent:'Codex',taskType:'commit-branch-dispatch'},{agent:'Grok',taskType:'docs'},{agent:'Gemini',taskType:'realtime'},
  {agent:'Claude',taskType:'qa-review'},{agent:'grok'},{agent:'GROK'},{taskType:'Realtime'},{taskType:''}])await assertFails(put(owner(),row(extra)));
});
await check('exact seven keys, string types, queued status, server time and self createdBy',async()=>{
 await seed();
 for(const key of ['agent','taskType','note','status','batchId','createdAt','createdBy']){const d=row();delete d[key];await assertFails(put(owner(),d));}
 for(const extra of [{cancelledAt:serverTimestamp()},{updatedAt:serverTimestamp()},{prompt:'x'},{agent:7},{agent:null},{taskType:['realtime']},{note:5},{note:null},{note:{t:'x'}},
  {status:'claimed'},{status:'in_progress'},{status:'completed'},{status:'cancelled'},{createdAt:Timestamp.fromMillis(Date.now())},{createdBy:'someone-else'},{createdBy:null}])await assertFails(put(owner(),row(extra)));
});
await check('document id and batchId must be lowercase RFC 4122 v4 UUIDs',async()=>{
 await seed();
 const bad=['not-a-uuid','00000000-0000-0000-0000-000000000000','6f1e2d3c-1a2b-1c3d-8e4f-123456789abc','6f1e2d3c-1a2b-4c3d-7e4f-123456789abc',randomUUID().toUpperCase(),randomUUID()+'0'];
 for(const id of bad)await assertFails(put(owner(),row(),id));
 for(const batchId of [...bad,7,null])await assertFails(put(owner(),row({batchId})));
});
const REJECTED=[0x200F,0x200E,0x061C,0x202A,0x202B,0x202C,0x202D,0x202E,0x2066,0x2067,0x2068,0x2069,0x2028,0x2029,0xFEFF,0x200B,0x200C,0x200D,0x05EB,0x05F0,0x0600,0x00A0,0x00AD];
for(let c=0x80;c<=0x9F;c++)REJECTED.push(c);for(let c=0;c<=0x1F;c++)REJECTED.push(c);REJECTED.push(0x7F);
await check(`note allowlist rejects each of ${REJECTED.length} code points, astral/emoji and 281 characters`,async()=>{
 await seed();
 for(const cp of REJECTED)await assertFails(put(owner(),row({note:'ok'+String.fromCodePoint(cp)+'ok'})),'U+'+cp.toString(16));
 for(const note of ['a'.repeat(281),'א'.repeat(281),'😀','a'.repeat(279)+'😀','𝐀','<script>'.replace('<','\u2039')])await assertFails(put(owner(),row({note})));
});
await check('freshness: auth_time within 900s required; stale, future and non-int auth_time denied',async()=>{
 await seed();
 await assertSucceeds(put(owner({auth_time:nowSeconds()-800}),row()));
 for(const auth_time of [nowSeconds()-905,nowSeconds()-3600,nowSeconds()+300,String(nowSeconds())])await assertFails(put(owner({auth_time}),row()));
});
await check('owner configuration and identity gates: disabled, revoked, missing, impersonation, publisher, budget, anonymous',async()=>{
 for(const mutate of [{enabled:false},{revokedAfter:nowSeconds()+60},'missing',{uid:'other-owner'}]){await seed(mutate);await assertFails(put(owner(),row()));}
 await seed();
 const others=[client('other',{email:ownerEmail,email_verified:true}),owner({email_verified:false}),owner({email:'synthetic-other@example.invalid'}),publisher(),budget(),environment.unauthenticatedContext().firestore()];
 for(const db of others){await assertFails(put(db,row({createdBy:'x'})));await assertFails(put(db,row()));}
 await assertFails(put(publisher(),row({createdBy:'synthetic-Grok'})));await assertFails(put(budget(),row({createdBy:'resq-ci-budget-20260928'})));
});
await check('reads: owner get and bounded list only; nobody else reads',async()=>{
 await seed();
 await assertSucceeds(getDoc(doc(owner(),'dispatchRequests/'+QUEUED)));
 await assertSucceeds(getDocs(query(collection(owner(),'dispatchRequests'),limit(50))));
 await assertSucceeds(getDocs(query(collection(owner(),'dispatchRequests'),where('status','==','queued'),limit(50))));
 await assertSucceeds(getDocs(query(collection(owner(),'dispatchRequests'),limit(1))));
 await assertFails(getDocs(collection(owner(),'dispatchRequests')));await assertFails(getDocs(query(collection(owner(),'dispatchRequests'),limit(51))));
 for(const db of [publisher(),budget(),client('other',{email:ownerEmail,email_verified:true}),environment.unauthenticatedContext().firestore()]){
  await assertFails(getDoc(doc(db,'dispatchRequests/'+QUEUED)));await assertFails(getDocs(query(collection(db,'dispatchRequests'),limit(10))));}
});
await check('cancel: only owner-authored queued -> cancelled with server cancelledAt and no other change',async()=>{
 await seed();
 const ref=db=>doc(db,'dispatchRequests/'+QUEUED);
 for(const change of [{status:'cancelled'},{status:'cancelled',cancelledAt:Timestamp.fromMillis(Date.now())},{status:'completed',cancelledAt:serverTimestamp()},
  {status:'in_progress',cancelledAt:serverTimestamp()},{status:'cancelled',cancelledAt:serverTimestamp(),note:'changed'},{status:'cancelled',cancelledAt:serverTimestamp(),createdBy:'someone-else'},
  {status:'cancelled',cancelledAt:serverTimestamp(),agent:'Codex'},{status:'cancelled',cancelledAt:serverTimestamp(),createdAt:serverTimestamp()},{note:'only-note'},{createdBy:'someone-else'}])await assertFails(updateDoc(ref(owner()),change));
 for(const db of [publisher(),budget(),environment.unauthenticatedContext().firestore()])await assertFails(updateDoc(ref(db),{status:'cancelled',cancelledAt:serverTimestamp()}));
 await assertFails(updateDoc(doc(owner(),'dispatchRequests/'+FOREIGN),{status:'cancelled',cancelledAt:serverTimestamp()}));
 await assertSucceeds(updateDoc(ref(owner()),{status:'cancelled',cancelledAt:serverTimestamp()}));
 await assertFails(updateDoc(ref(owner()),{status:'cancelled',cancelledAt:serverTimestamp()}));
 await assertFails(updateDoc(ref(owner()),{status:'queued'}));
});
await check('no delete, and a retried create of an existing id is denied (maybe-already-saved path) without changing it',async()=>{
 await seed();
 await assertFails(deleteDoc(doc(owner(),'dispatchRequests/'+QUEUED)));
 const id=randomUUID(),data=row();await assertSucceeds(put(owner(),data,id));
 await assertFails(put(owner(),{...data,note:'retry'},id));
 let snap;await environment.withSecurityRulesDisabled(async c=>{snap=await getDoc(doc(c.firestore(),'dispatchRequests/'+id));});assert.equal(snap.data().note,data.note);
});
await check('pre-existing live behaviour preserved: owner reads events, owner cannot write events or other collections',async()=>{
 await seed();
 await assertSucceeds(getDoc(doc(owner(),'events/existing-event')));
 await assertFails(setDoc(doc(owner(),'events/'+randomUUID()),{agent:'Grok',kind:'heartbeat',task:'local_tests',step:'running',createdAt:serverTimestamp()}));
 await assertFails(setDoc(doc(owner(),'dispatch_requests/'+randomUUID()),row()));await assertFails(setDoc(doc(owner(),'dispatchRequests/'+QUEUED+'/sub/x'),row()));
});
await environment.cleanup();
console.log(`Dispatch Rules on exact deploy artifact: ${passed} PASS; artifact sha256 ${meta.artifactSha256}`);
