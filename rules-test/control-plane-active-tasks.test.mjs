// Active tasks: exact-byte provenance on top of the LIVE f30d3d85 artifact plus emulator Rules on the SAME bytes that
// would be deployed (control-plane/deploy/firestore.control-plane.rules). Local emulator only; synthetic identities only.
// Security review 30/09/2026 conditions B1-B4, C1-C8 (control-plane/ACTIVE-TASKS.md) and the push-trigger verdict
// (review/push-trigger-verdicts.md, security 2): kind/NOTIFY, acks, ack_switch, owner-only IN_PROGRESS/COMPLETED.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,updateDoc,deleteDoc,collection,query,where,orderBy,limit,serverTimestamp,Timestamp,deleteField} from 'firebase/firestore';
import {assembleActiveTasksRules,LIVE_BASE_SHA256,DISPATCH_ANCHOR} from '../control-plane/assemble-rules.mjs';
if(!['127.0.0.1:8191','127.0.0.1:8199'].includes(process.env.FIRESTORE_EMULATOR_HOST)||process.env.GCLOUD_PROJECT!=='demo-resq')throw Error('LOCAL_EMULATOR_REQUIRED');
const emulatorPort=Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]);
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=rel=>readFileSync(new URL('../'+rel,import.meta.url));
const artifact=read('control-plane/deploy/firestore.control-plane.rules');
const base=read('control-plane/deploy/firestore.dispatch.rules');
const meta=JSON.parse(read('control-plane/deploy/firestore-active-tasks-provenance.json').toString('utf8'));
const fragment=read('control-plane/firestore-active-tasks.rules.fragment').toString('utf8');
const deployConfig=JSON.parse(read('control-plane/deploy/firebase.control-plane.json').toString('utf8'));
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};

await check('artifact = live f30d3d85 bytes + active-tasks block before the deny-all; provenance, diff and deploy config agree',async()=>{
 assert.equal(hash(base),LIVE_BASE_SHA256);assert.equal(meta.baseSha256,LIVE_BASE_SHA256);
 assert.equal(meta.baseRulesetName,'projects/resq-agent-control-20260928/rulesets/569cfc0c-a798-45b6-b8f6-d3bd501369ba');
 assert.equal(meta.kind,'control-plane-active-tasks-deploy-artifact');assert.equal(meta.status,'LOCAL_ARTIFACT_NOT_DEPLOYED');assert.equal(meta.deployment,undefined);
 assert.equal(hash(artifact),meta.artifactSha256);assert.equal(artifact.length,meta.artifactBytes);assert.ok(!artifact.includes(0x0d));
 const prefix=artifact.subarray(0,meta.insertionOffsetBytes),block=artifact.subarray(meta.insertionOffsetBytes,meta.insertionOffsetBytes+meta.insertedBytes);
 const suffix=artifact.subarray(meta.insertionOffsetBytes+meta.insertedBytes);
 assert.deepEqual(Buffer.concat([prefix,suffix]),base,'prefix+suffix must be the live bytes exactly (events and dispatch rules unchanged)');
 assert.equal(hash(prefix),meta.prefixSha256);assert.equal(hash(suffix),meta.suffixSha256);assert.equal(hash(block),meta.fragmentSha256);
 assert.equal(block.toString('utf8'),fragment.replace(/\r\n/g,'\n').trimEnd()+'\n');assert.ok(suffix.toString('utf8').startsWith(DISPATCH_ANCHOR));
 const again=assembleActiveTasksRules(base,fragment);assert.deepEqual(again.result,artifact);assert.deepEqual(again.provenance,meta);
 assert.throws(()=>assembleActiveTasksRules(Buffer.from('tampered'),fragment),/LIVE_BASE_HASH_MISMATCH/);
 assert.throws(()=>assembleActiveTasksRules(base,fragment+'\n    function owner() { return true; }'),/ACTIVE_FUNCTION_NAME_COLLISION/);
 assert.throws(()=>assembleActiveTasksRules(base,fragment+'\n    match /events/{id} { allow read: if true; }'),/ACTIVE_FRAGMENT_REQUIRED/);
 const text=artifact.toString('utf8');
 for(const name of meta.functionsAdded){assert.match(name,/^at[A-Z]/);assert.equal((text.match(new RegExp('function '+name+'\\('),'g')||[]).length,1,name);}
 assert.doesNotMatch(block.toString('utf8'),/function (?:tasks|aid|policy|owner|publisher|currentPrincipal|validEvent|dispatch[A-Za-z]*)\(/);
 assert.equal((text.match(/match \/active_tasks\//g)||[]).length,1);assert.equal((text.match(/match \/task_listeners\//g)||[]).length,1);
 assert.ok(text.lastIndexOf('match /{document=**}')>text.indexOf('match /task_listeners/'));
 // The committed diff vs the live capture adds lines only (no live line removed or changed).
 const diff=read('control-plane/deploy/firestore-active-tasks.diff').toString('utf8');
 assert.match(diff,/^--- live\/f30d3d85\/source-0\.rules\n\+\+\+ control-plane\/deploy\/firestore\.control-plane\.rules\n/);
 const body=diff.split('\n').slice(2).filter(l=>l&&!l.startsWith('@@'));
 assert.equal(body.filter(l=>l.startsWith('-')).length,0);assert.equal(body.filter(l=>l.startsWith('+')).length,block.toString('utf8').trimEnd().split('\n').length);
 assert.equal(deployConfig.firestore.rules,'firestore.control-plane.rules');assert.deepEqual(Object.keys(deployConfig.firestore),['rules']);
});

const rules=artifact.toString('utf8');
const projectId='demo-resq-active-'+process.pid;
const environment=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:emulatorPort,rules}});
const ownerEmail=/request\.auth\.token\.email == '([^']+)'/.exec(rules)[1];
const OWNER='synthetic-owner';
const nowSeconds=()=>Math.floor(Date.now()/1000);
const client=(id,claims={})=>environment.authenticatedContext(id,{auth_time:nowSeconds(),...claims}).firestore();
const owner=(claims={})=>client(OWNER,{email:ownerEmail,email_verified:true,...claims});
const listener=(agent='Grok',claims={})=>client('synthetic-listener-'+agent.toLowerCase(),{control_plane_role:'listener',control_plane_agent:agent,...claims});
const ciPublisher=()=>client('synthetic-Grok',{control_plane_agent:'Grok'});
const ciAsListener=()=>client('synthetic-ci-listener',{control_plane_role:'listener',control_plane_agent:'Grok'});
const budgetAsListener=()=>client('synthetic-budget-listener',{control_plane_role:'listener',control_plane_agent:'Grok',control_plane_budget:true});
const budget=()=>client('resq-ci-budget-20260928',{control_plane_budget:true,control_plane_authorization:'rules-grant-1'});
const anon=()=>environment.unauthenticatedContext().firestore();
const T_GROK=randomUUID(),T_CODEX=randomUUID(),T_ALL=randomUUID(),T_FOREIGN=randomUUID(),T_CANCELLED=randomUUID();
const task=(id,extra={})=>({taskId:id,dispatchedBy:OWNER,payload:'בדיקה quick check',targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},status:'PENDING',timestamp:serverTimestamp(),progress:{},...extra});
const listenerDoc=agent=>({agent,role:'listener',enabled:true,revokedAfter:0});
async function seed(mutate={}){
 await environment.clearFirestore();
 await environment.withSecurityRulesDisabled(async c=>{const db=c.firestore();
  await setDoc(doc(db,'private_access/owner'),{uid:OWNER,enabled:true,revokedAfter:0});
  for(const a of ['Grok','Codex','Gemini'])await setDoc(doc(db,'private_listeners/synthetic-listener-'+a.toLowerCase()),{...listenerDoc(a),...(mutate[a]||{})});
  await setDoc(doc(db,'private_listeners/synthetic-listener-claude'),listenerDoc('Claude'));
  await setDoc(doc(db,'private_publishers/synthetic-Grok'),{agent:'Grok',enabled:true,revokedAfter:0});
  // A CI telemetry identity and a budget identity that ALSO got a listener doc: must still be rejected explicitly.
  await setDoc(doc(db,'private_publishers/synthetic-ci-listener'),{agent:'Grok',enabled:true,revokedAfter:0});
  await setDoc(doc(db,'private_listeners/synthetic-ci-listener'),listenerDoc('Grok'));
  await setDoc(doc(db,'private_budget_publishers/synthetic-budget-listener'),{enabled:true,revokedAfter:0});
  await setDoc(doc(db,'private_listeners/synthetic-budget-listener'),listenerDoc('Grok'));
  await setDoc(doc(db,'private_listeners/'+OWNER),listenerDoc('Grok'));
  await setDoc(doc(db,'private_budget_publishers/resq-ci-budget-20260928'),{enabled:true,revokedAfter:0});
  await setDoc(doc(db,'events/existing-event'),{agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',createdAt:Timestamp.now()});
  const ts=Timestamp.now();
  await setDoc(doc(db,'active_tasks/'+T_GROK),{...task(T_GROK),timestamp:ts});
  await setDoc(doc(db,'active_tasks/'+T_CODEX),{...task(T_CODEX,{targets:{grok:'IGNORE',codex:'EXECUTE',gemini:'IGNORE'}}),timestamp:ts});
  await setDoc(doc(db,'active_tasks/'+T_ALL),{...task(T_ALL,{targets:{grok:'EXECUTE',codex:'EXECUTE',gemini:'EXECUTE'}}),timestamp:ts});
  await setDoc(doc(db,'active_tasks/'+T_FOREIGN),{...task(T_FOREIGN,{dispatchedBy:'someone-else'}),timestamp:ts});
  await setDoc(doc(db,'active_tasks/'+T_CANCELLED),{...task(T_CANCELLED,{status:'CANCELLED'}),timestamp:ts});
  await setDoc(doc(db,'task_listeners/codex'),{agent:'codex',seenAt:ts});
 });
}
const put=(db,data,id=data.taskId)=>setDoc(doc(db,'active_tasks/'+id),data);
const entry=(state,step,extra={})=>({state,step,updatedAt:serverTimestamp(),...extra});
const progress=(db,id,key,value)=>updateDoc(doc(db,'active_tasks/'+id),{['progress.'+key]:value});
const listQ=(db,key,n=5)=>query(collection(db,'active_tasks'),where('targets.'+key,'==','EXECUTE'),orderBy('timestamp','desc'),limit(n));

await check('C1/C4 owner create: fresh sign-in, exact 7 keys, PENDING, empty progress, 3 targets with >=1 EXECUTE, payload allowlist, taskId == doc id (UUIDv4)',async()=>{
 await seed();
 for(const targets of [{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},{grok:'IGNORE',codex:'EXECUTE',gemini:'IGNORE'},{grok:'IGNORE',codex:'IGNORE',gemini:'EXECUTE'},{grok:'EXECUTE',codex:'EXECUTE',gemini:'EXECUTE'}]){
  const id=randomUUID();await assertSucceeds(put(owner(),task(id,{targets})));}
 for(const payload of ['','a'.repeat(10000),'א'.repeat(10000),'שורה 1\nline 2\n\n  ~!','שָׁלוֹם עוֹלָם'])await assertSucceeds(put(owner(),task(randomUUID(),{payload})));
 await assertSucceeds(put(owner({auth_time:nowSeconds()-800}),task(randomUUID())));
});
await check('C1/C4 owner create denials: stale/future auth_time, shape, targets, status, progress, ids, payload characters and size, client timestamp',async()=>{
 await seed();
 for(const auth_time of [nowSeconds()-905,nowSeconds()-3600,nowSeconds()+300,String(nowSeconds())])await assertFails(put(owner({auth_time}),task(randomUUID())));
 for(const key of ['taskId','dispatchedBy','payload','targets','status','timestamp','progress']){const id=randomUUID(),d=task(id);delete d[key];await assertFails(put(owner(),d,id));}
 const bad=[{extra:1},{status:'CANCELLED'},{status:'IN_PROGRESS'},{status:'READY'},{progress:{grok:{state:'READY',step:'delivered',updatedAt:serverTimestamp()}}},{progress:null},
  {targets:{grok:'IGNORE',codex:'IGNORE',gemini:'IGNORE'}},{targets:{grok:'EXECUTE',codex:'IGNORE'}},{targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE',claude:'IGNORE'}},
  {targets:{grok:'execute',codex:'IGNORE',gemini:'IGNORE'}},{targets:{grok:'EXECUTE',codex:'IGNORE',gemini:true}},{targets:'grok'},
  {dispatchedBy:'someone-else'},{timestamp:Timestamp.now()},{payload:7},{payload:null},{payload:'a'.repeat(10001)},{payload:'a\r\nb'},{payload:'a\tb'},
  {payload:'\u201cquoted\u201d'},{payload:'גרש\u05f3'},{payload:'גרשיים\u05f4'},{payload:'a\u200fb'},{payload:'😀'},{payload:'a\u2013b'},{payload:'\u2022'}];
 for(const extra of bad){const id=randomUUID();await assertFails(put(owner(),task(id,extra),id),JSON.stringify(extra).slice(0,60));}
 const id=randomUUID();await assertFails(put(owner(),task(id),randomUUID()));                      // taskId != doc id
 for(const badId of ['not-a-uuid',randomUUID().toUpperCase(),'6f1e2d3c-1a2b-1c3d-8e4f-123456789abc'])await assertFails(put(owner(),task(badId),badId));
 for(const db of [listener(),ciPublisher(),ciAsListener(),budget(),anon(),client('other',{email:ownerEmail,email_verified:true})])await assertFails(put(db,task(randomUUID())));
});
await check('owner reads: get, list orderBy(timestamp desc) limit 1..20 only',async()=>{
 await seed();
 await assertSucceeds(getDoc(doc(owner(),'active_tasks/'+T_CODEX)));
 await assertSucceeds(getDocs(query(collection(owner(),'active_tasks'),orderBy('timestamp','desc'),limit(20))));
 await assertFails(getDocs(query(collection(owner(),'active_tasks'),orderBy('timestamp','desc'),limit(21))));
 await assertFails(getDocs(collection(owner(),'active_tasks')));
});
await check('C6 listener reads: own EXECUTE targets only, where targets.<key>==EXECUTE, limit <= 5; deny another agent\'s get, list without where, limit 6',async()=>{
 await seed();
 await assertSucceeds(getDoc(doc(listener(),'active_tasks/'+T_GROK)));await assertSucceeds(getDoc(doc(listener('Codex'),'active_tasks/'+T_CODEX)));
 await assertSucceeds(getDocs(listQ(listener(),'grok')));await assertSucceeds(getDocs(listQ(listener('Gemini'),'gemini',1)));
 await assertFails(getDoc(doc(listener(),'active_tasks/'+T_CODEX)));                                  // another agent's task
 await assertFails(getDocs(listQ(listener(),'grok',6)));                                                // limit 6
 await assertFails(getDocs(query(collection(listener(),'active_tasks'),orderBy('timestamp','desc'),limit(5))));   // no where
 await assertFails(getDocs(query(collection(listener(),'active_tasks'),limit(5))));
 await assertFails(getDocs(listQ(listener(),'codex')));                                                  // another agent's key
 await assertFails(getDocs(query(collection(listener(),'active_tasks'),where('targets.grok','==','EXECUTE'))));       // no limit
});
await check('C6 listener has no access to other collections',async()=>{
 await seed();const db=listener();
 for(const path of ['events/existing-event','private_access/owner','private_listeners/synthetic-listener-grok','task_listeners/codex','dispatchRequests/'+randomUUID()])await assertFails(getDoc(doc(db,path)));
 for(const col of ['events','dispatchRequests','private_listeners','task_listeners'])await assertFails(getDocs(query(collection(db,col),limit(3))));
 await assertFails(setDoc(doc(db,'events/'+randomUUID()),{agent:'Grok',kind:'heartbeat',task:'local_tests',step:'running',createdAt:serverTimestamp()}));
 await assertFails(setDoc(doc(db,'private_listeners/synthetic-listener-grok'),listenerDoc('Grok')));
});
await check('B1 CI (private_publishers) and budget identities are rejected as listeners even with a listener doc and claims; other look-alikes too',async()=>{
 await seed();
 const rejected=[ciPublisher(),ciAsListener(),budgetAsListener(),budget(),listener('Claude'),listener('Grok',{control_plane_role:'publisher'}),
  client('synthetic-listener-grok',{control_plane_agent:'Grok'}),listener('Grok',{control_plane_agent:'Codex'}),client(OWNER,{control_plane_role:'listener',control_plane_agent:'Grok'}),
  listener('Grok',{control_plane_budget:true}),anon()];
 for(const db of rejected){
  await assertFails(getDoc(doc(db,'active_tasks/'+T_GROK)));await assertFails(getDocs(listQ(db,'grok')));
  await assertFails(progress(db,T_GROK,'grok',entry('READY','delivered')));
  await assertFails(setDoc(doc(db,'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));
 }
 for(const mutate of [{Grok:{enabled:false}},{Grok:{revokedAfter:nowSeconds()+60}},{Grok:{role:'publisher'}},{Grok:{agent:'Codex'}}]){await seed(mutate);
  await assertFails(getDoc(doc(listener(),'active_tasks/'+T_GROK)));await assertFails(progress(listener(),T_GROK,'grok',entry('READY','delivered')));}
});
await check('B2/B4/C3 + push trigger: the LISTENER may only write none->READY|REJECTED and READY->REJECTED; it can never start, complete or fail a task',async()=>{
 await seed();const db=listener();
 await assertSucceeds(progress(db,T_GROK,'grok',entry('READY','delivered')));
 await assertFails(progress(db,T_GROK,'grok',entry('READY','delivery_off')));            // READY -> READY
 for(const [s,st] of [['IN_PROGRESS','started'],['COMPLETED','completed'],['FAILED','failed']])await assertFails(progress(db,T_GROK,'grok',entry(s,st)));   // escalation denied
 await assertSucceeds(progress(db,T_GROK,'grok',entry('REJECTED','declined')));
 for(const [s,st] of [['FAILED','failed'],['IN_PROGRESS','started'],['READY','delivered'],['REJECTED','declined'],['COMPLETED','completed']])await assertFails(progress(db,T_GROK,'grok',entry(s,st)));
 await seed();
 for(const [s,st] of [['IN_PROGRESS','started'],['COMPLETED','completed'],['FAILED','failed']])await assertFails(progress(db,T_GROK,'grok',entry(s,st)));   // none -> escalation
 await assertSucceeds(progress(db,T_GROK,'grok',entry('REJECTED','secret')));
 for(const [s,st] of [['READY','delivered'],['IN_PROGRESS','started'],['REJECTED','invalid']])await assertFails(progress(db,T_GROK,'grok',entry(s,st)));
 await seed();
 await assertSucceeds(progress(db,T_GROK,'grok',entry('READY','delivery_off')));
 await assertFails(progress(db,T_GROK,'grok',entry('IN_PROGRESS','started')));
 await assertSucceeds(progress(db,T_GROK,'grok',entry('REJECTED','declined')));
});
await check('owner manual click (t176u): READY/delivered -> IN_PROGRESS -> COMPLETED on an EXECUTE target only; no other owner progress write',async()=>{
 await seed();const o=owner();
 await assertFails(progress(o,T_GROK,'grok',entry('IN_PROGRESS','started')));            // none -> IN_PROGRESS (no delivery)
 await assertFails(progress(o,T_GROK,'grok',entry('READY','delivered')));                // the owner never writes READY
 await assertSucceeds(progress(listener(),T_GROK,'grok',entry('READY','delivered')));
 await assertFails(progress(o,T_GROK,'grok',entry('COMPLETED','completed')));            // READY -> COMPLETED
 await assertFails(progress(o,T_GROK,'grok',entry('FAILED','failed')));
 await assertFails(progress(o,T_GROK,'grok',entry('IN_PROGRESS','started',{note:'x'})));
 await assertFails(updateDoc(doc(o,'active_tasks/'+T_GROK),{'progress.grok':entry('IN_PROGRESS','started'),status:'IN_PROGRESS'}));
 await assertFails(progress(ciPublisher(),T_GROK,'grok',entry('IN_PROGRESS','started')));
 await assertSucceeds(progress(o,T_GROK,'grok',entry('IN_PROGRESS','started')));
 await assertFails(progress(o,T_GROK,'grok',entry('IN_PROGRESS','started')));
 await assertFails(progress(o,T_GROK,'grok',entry('FAILED','failed')));
 await assertSucceeds(progress(o,T_GROK,'grok',entry('COMPLETED','completed')));
 for(const [s,st] of [['IN_PROGRESS','started'],['COMPLETED','completed'],['READY','delivered']])await assertFails(progress(o,T_GROK,'grok',entry(s,st)));
 await seed();
 await assertSucceeds(progress(listener(),T_GROK,'grok',entry('READY','delivery_off')));
 await assertFails(progress(o,T_GROK,'grok',entry('IN_PROGRESS','started')));            // delivery_off: no inbox file, no start
 await assertFails(progress(o,T_CODEX,'grok',entry('IN_PROGRESS','started')));           // not an EXECUTE target
 await assertSucceeds(updateDoc(doc(o,'active_tasks/'+T_GROK),{status:'CANCELLED'}));
 await seed();await assertSucceeds(progress(listener(),T_GROK,'grok',entry('READY','delivered')));
 await assertSucceeds(updateDoc(doc(o,'active_tasks/'+T_GROK),{status:'CANCELLED'}));
 await assertFails(progress(o,T_GROK,'grok',entry('IN_PROGRESS','started')));            // cancelled
});
await check('B2/B4 entry is exactly {state, step, updatedAt=server time} with a closed step enum; only own key; never status or any other field',async()=>{
 await seed();const db=listener();
 for(const value of [entry('READY','started'),entry('READY','delivered',{note:'x'}),{state:'READY',step:'delivered'},entry('READY','delivered',{updatedAt:Timestamp.now()}),
  entry('DELIVERED','delivered'),entry('READY','DELIVERED'),entry('PENDING','delivered'),{state:'READY',updatedAt:serverTimestamp()},'READY',null])await assertFails(progress(db,T_GROK,'grok',value),JSON.stringify(value));
 await assertFails(progress(db,T_ALL,'codex',entry('READY','delivered')));                   // another agent's key
 await assertFails(updateDoc(doc(db,'active_tasks/'+T_ALL),{'progress.grok':entry('READY','delivered'),'progress.codex':entry('READY','delivered')}));
 await assertFails(updateDoc(doc(db,'active_tasks/'+T_GROK),{status:'COMPLETED'}));
 await assertFails(updateDoc(doc(db,'active_tasks/'+T_GROK),{'progress.grok':entry('READY','delivered'),status:'IN_PROGRESS'}));
 await assertFails(updateDoc(doc(db,'active_tasks/'+T_GROK),{'progress.grok':entry('READY','delivered'),payload:'changed'}));
 await assertFails(updateDoc(doc(db,'active_tasks/'+T_GROK),{progress:{grok:entry('READY','delivered'),extra:1}}));
 await assertFails(progress(db,T_CODEX,'grok',entry('READY','delivered')));                  // not targeted at grok
 await assertSucceeds(progress(db,T_ALL,'grok',entry('READY','delivered')));
 await assertSucceeds(progress(listener('Codex'),T_ALL,'codex',entry('REJECTED','limit')));
 await assertFails(updateDoc(doc(db,'active_tasks/'+T_ALL),{'progress.codex':deleteField()}));
});
await check('C2 agent updates only while PENDING (cancelled task rejects every progress write)',async()=>{
 await seed();
 await assertFails(progress(listener(),T_CANCELLED,'grok',entry('READY','delivered')));
 await assertSucceeds(progress(listener(),T_GROK,'grok',entry('READY','delivered')));
 await assertSucceeds(updateDoc(doc(owner(),'active_tasks/'+T_GROK),{status:'CANCELLED'}));
 await assertFails(progress(listener(),T_GROK,'grok',entry('IN_PROGRESS','started')));
});
await check('C5 owner cancel: PENDING -> CANCELLED only, status key only, allowed with progress present; nothing else, no way back',async()=>{
 await seed();
 await assertSucceeds(progress(listener(),T_GROK,'grok',entry('READY','delivered')));
 const ref=db=>doc(db,'active_tasks/'+T_GROK);
 for(const change of [{status:'COMPLETED'},{status:'PENDING'},{status:'CANCELLED',payload:'x'},{status:'CANCELLED','progress.grok':entry('COMPLETED','completed')},
  {status:'CANCELLED','progress.grok':entry('IN_PROGRESS','started')},{status:'cancelled'},{targets:{grok:'IGNORE',codex:'EXECUTE',gemini:'IGNORE'}},{kind:'MESSAGE'},{acks:{grok:{state:'LIT',summary:'',updatedAt:serverTimestamp()}}}])await assertFails(updateDoc(ref(owner()),change));
 for(const db of [listener(),ciPublisher(),budget(),anon()])await assertFails(updateDoc(ref(db),{status:'CANCELLED'}));
 await assertFails(updateDoc(doc(owner(),'active_tasks/'+T_FOREIGN),{status:'CANCELLED'}));
 await assertSucceeds(updateDoc(ref(owner()),{status:'CANCELLED'}));
 await assertFails(updateDoc(ref(owner()),{status:'PENDING'}));await assertFails(updateDoc(ref(owner()),{status:'CANCELLED'}));
});
await check('no delete for anyone; retried create of an existing taskId is denied and leaves it unchanged (client then reads it: idempotent)',async()=>{
 await seed();
 for(const db of [owner(),listener(),ciPublisher(),budget(),anon()])await assertFails(deleteDoc(doc(db,'active_tasks/'+T_GROK)));
 const id=randomUUID(),data=task(id);await assertSucceeds(put(owner(),data));await assertFails(put(owner(),data));await assertFails(put(owner(),{...data,payload:'retry'}));
 let snap;await environment.withSecurityRulesDisabled(async c=>{snap=await getDoc(doc(c.firestore(),'active_tasks/'+id));});assert.equal(snap.data().payload,data.payload);
 await assertSucceeds(getDoc(doc(owner(),'active_tasks/'+id)));
});
await check('task_listeners heartbeat: only that agent\'s listener identity, exactly {agent, seenAt=server time}, at most one write per 30s; owner reads bounded; CI never lights it',async()=>{
 await seed();
 await assertSucceeds(setDoc(doc(listener(),'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));   // create
 await assertFails(setDoc(doc(listener(),'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));     // hardening: update within 30s denied
 const aged=ms=>environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'task_listeners/grok'),{agent:'grok',seenAt:Timestamp.fromMillis(Date.now()-ms)}));
 await aged(25000);await assertFails(setDoc(doc(listener(),'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));   // 25s old: still too soon
 await aged(31000);await assertSucceeds(setDoc(doc(listener(),'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));   // >30s old: allowed
 await assertFails(setDoc(doc(listener(),'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));     // and immediately limited again
 await aged(61000);
 for(const [path,data] of [['task_listeners/codex',{agent:'codex',seenAt:serverTimestamp()}],['task_listeners/grok',{agent:'codex',seenAt:serverTimestamp()}],
  ['task_listeners/grok',{agent:'grok',seenAt:Timestamp.now()}],['task_listeners/grok',{agent:'grok',seenAt:serverTimestamp(),x:1}],['task_listeners/grok',{agent:'grok'}],
  ['task_listeners/grok',{agent:'grok',seenAt:serverTimestamp(),ack:'ON'}],['task_listeners/grok',{agent:'grok',seenAt:serverTimestamp(),ack:true}],
  ['task_listeners/grok',{agent:'grok',seenAt:serverTimestamp(),mode:'grpc'}],['task_listeners/grok',{agent:'grok',seenAt:serverTimestamp(),ack:'on',mode:'push',summary:'x'}],
  ['task_listeners/claude',{agent:'claude',seenAt:serverTimestamp()}]])await assertFails(setDoc(doc(listener(),path),data));
 for(const db of [owner(),ciPublisher(),ciAsListener(),budgetAsListener(),budget(),anon()])await assertFails(setDoc(doc(db,'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));
 for(const db of [owner(),listener()])await assertFails(deleteDoc(doc(db,'task_listeners/grok')));
 await assertSucceeds(getDoc(doc(owner(),'task_listeners/grok')));
 await assertSucceeds(getDocs(query(collection(owner(),'task_listeners'),orderBy('seenAt','desc'),limit(3))));
 await assertFails(getDocs(query(collection(owner(),'task_listeners'),orderBy('seenAt','desc'),limit(4))));
 for(const db of [listener(),ciPublisher(),anon()])await assertFails(getDoc(doc(db,'task_listeners/codex')));
});
await check('heartbeat carries the ack mode (on|off) and transport (push|poll); both optional for the b41e775 runner',async()=>{
 await seed();
 const aged=ms=>environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'task_listeners/grok'),{agent:'grok',seenAt:Timestamp.fromMillis(Date.now()-ms)}));
 for(const extra of [{},{ack:'off'},{ack:'on'},{mode:'push'},{ack:'on',mode:'push'},{ack:'off',mode:'poll'}]){await aged(61000);
  await assertSucceeds(setDoc(doc(listener(),'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp(),...extra}));}
});
// ---------------- push trigger: kind / NOTIFY / acks / ack_switch ----------------
const ack=(db,id,key,value)=>updateDoc(doc(db,'active_tasks/'+id),{['acks.'+key]:value});
const ackEntry=(state,summary='',extra={})=>({state,summary,updatedAt:serverTimestamp(),...extra});
// Default: the switch has been ON since 48 h ago, so tasks seeded "now" are after its updatedAt (condition 2 tests move it).
const setSwitch=(enabled,updatedAt=Timestamp.fromMillis(Date.now()-48*3600000))=>environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'control/ack_switch'),{enabled,updatedAt}));
const MSG=(id,extra={})=>task(id,{kind:'MESSAGE',targets:{grok:'NOTIFY',codex:'NOTIFY',gemini:'IGNORE'},acks:{},payload:'הודעה לכולם',...extra});
async function seedMessages(){
 await seed();
 await environment.withSecurityRulesDisabled(async c=>{const db=c.firestore();const ts=Timestamp.now();
  await setDoc(doc(db,'active_tasks/'+M_ALL),{...MSG(M_ALL),timestamp:ts});
  await setDoc(doc(db,'active_tasks/'+M_OLD),{...MSG(M_OLD),timestamp:Timestamp.fromMillis(Date.now()-24*3600000-60000)});
  await setDoc(doc(db,'active_tasks/'+T_NEW),{...task(T_NEW,{kind:'TASK',acks:{}}),timestamp:ts});
 });
 await setSwitch(true);
}
const M_ALL=randomUUID(),M_OLD=randomUUID(),T_NEW=randomUUID();
await check('create kind: TASK (EXECUTE/IGNORE, >=1 EXECUTE) and MESSAGE (NOTIFY/IGNORE, >=1 NOTIFY, <= 2000, never EXECUTE); acks missing or {}',async()=>{
 await seed();
 await assertSucceeds(put(owner(),task(randomUUID(),{kind:'TASK'})));await assertSucceeds(put(owner(),task(randomUUID(),{kind:'TASK',acks:{}})));
 for(const targets of [{grok:'NOTIFY',codex:'NOTIFY',gemini:'NOTIFY'},{grok:'NOTIFY',codex:'IGNORE',gemini:'IGNORE'},{grok:'IGNORE',codex:'IGNORE',gemini:'NOTIFY'}])
  await assertSucceeds(put(owner(),MSG(randomUUID(),{targets})));
 await assertSucceeds(put(owner(),MSG(randomUUID(),{payload:'א'.repeat(2000)})));{const id=randomUUID();const d=MSG(id);delete d.acks;await assertSucceeds(put(owner(),d,id));}
 const bad=[{kind:'MESSAGE',targets:{grok:'EXECUTE',codex:'NOTIFY',gemini:'IGNORE'}},{targets:{grok:'IGNORE',codex:'IGNORE',gemini:'IGNORE'}},{payload:'א'.repeat(2001)},
  {kind:'TASK'},{kind:'message'},{kind:'BROADCAST'},{kind:7},{acks:{grok:{state:'LIT',summary:'',updatedAt:serverTimestamp()}}},{acks:null},{acks:'x'}];
 for(const extra of bad){const id=randomUUID();const d=MSG(id,extra);if(d.acks===undefined)delete d.acks;await assertFails(put(owner(),d,id),JSON.stringify(extra).slice(0,60));}
 for(const targets of [{grok:'NOTIFY',codex:'IGNORE',gemini:'IGNORE'},{grok:'EXECUTE',codex:'NOTIFY',gemini:'IGNORE'}])await assertFails(put(owner(),task(randomUUID(),{targets})));   // TASK: non-targets IGNORE, never NOTIFY
});
await check('listener list: targets.<key> in [EXECUTE, NOTIFY] + orderBy(timestamp desc), limit 1..5 ONLY with the filter; get of NOTIFY own; never another key',async()=>{
 await seedMessages();
 const inQ=(db,key,n=5)=>query(collection(db,'active_tasks'),where('targets.'+key,'in',['EXECUTE','NOTIFY']),orderBy('timestamp','desc'),limit(n));
 await assertSucceeds(getDocs(inQ(listener(),'grok')));await assertSucceeds(getDocs(inQ(listener('Codex'),'codex',1)));
 const got=await getDocs(inQ(listener(),'grok'));assert.ok(got.docs.some(d=>d.id===M_ALL)&&got.docs.some(d=>d.id===T_GROK));
 await assertFails(getDocs(inQ(listener(),'grok',6)));
 await assertFails(getDocs(query(collection(listener(),'active_tasks'),where('targets.grok','in',['EXECUTE','NOTIFY']),orderBy('timestamp','desc'))));   // no limit
 await assertFails(getDocs(query(collection(listener(),'active_tasks'),where('targets.grok','in',['EXECUTE','NOTIFY','IGNORE']),orderBy('timestamp','desc'),limit(5))));
 await assertFails(getDocs(query(collection(listener(),'active_tasks'),orderBy('timestamp','desc'),limit(5))));
 await assertFails(getDocs(inQ(listener(),'codex')));
 await assertSucceeds(getDoc(doc(listener(),'active_tasks/'+M_ALL)));await assertFails(getDoc(doc(listener('Gemini'),'active_tasks/'+M_ALL)));   // gemini IGNORE
});
await check('acks: own key only, EXECUTE or NOTIFY target, LIT -> UNDERSTOOD|UNREADABLE terminal, exact {state, summary, updatedAt}, only acks changes',async()=>{
 await seedMessages();const db=listener();
 await assertSucceeds(ack(db,M_ALL,'grok',ackEntry('LIT')));
 await assertFails(ack(db,M_ALL,'grok',ackEntry('LIT')));                                              // LIT -> LIT
 await assertSucceeds(ack(db,M_ALL,'grok',ackEntry('UNDERSTOOD','הבנתי: בדיקה של כפתור השליחה')));
 for(const v of [ackEntry('UNDERSTOOD','x'),ackEntry('UNREADABLE'),ackEntry('LIT')])await assertFails(ack(db,M_ALL,'grok',v));   // terminal
 await assertSucceeds(ack(listener('Codex'),M_ALL,'codex',ackEntry('UNREADABLE')));                   // direct final state
 await assertFails(ack(listener('Gemini'),M_ALL,'gemini',ackEntry('LIT')));                           // IGNORE target
 await assertFails(ack(db,M_ALL,'codex',ackEntry('LIT')));                                            // another agent's key
 await assertFails(ack(db,T_CODEX,'grok',ackEntry('LIT')));                                           // TASK not targeted at grok
 await assertSucceeds(ack(db,T_NEW,'grok',ackEntry('UNDERSTOOD','summary')));                         // EXECUTE target
 await assertSucceeds(ack(db,T_GROK,'grok',ackEntry('LIT')));                                         // legacy task without acks/kind
 await assertFails(updateDoc(doc(db,'active_tasks/'+T_ALL),{'acks.grok':ackEntry('LIT'),'progress.grok':entry('READY','delivered')}));   // acks + progress together
 for(const change of [{'acks.grok':ackEntry('LIT'),status:'CANCELLED'},{'acks.grok':ackEntry('LIT'),payload:'x'},{acks:{grok:ackEntry('LIT'),codex:ackEntry('LIT')}}])
  await assertFails(updateDoc(doc(db,'active_tasks/'+T_ALL),change),JSON.stringify(Object.keys(change)));
 for(const v of [{state:'LIT',summary:''},ackEntry('LIT','',{note:1}),ackEntry('LIT','',{updatedAt:Timestamp.now()}),ackEntry('lit'),ackEntry('ACK'),ackEntry('IN_PROGRESS'),
  ackEntry('LIT','x'),ackEntry('UNREADABLE','x'),ackEntry('UNDERSTOOD',''),ackEntry('UNDERSTOOD',7),'LIT',null])await assertFails(ack(db,T_ALL,'grok',v),JSON.stringify(v));
 for(const other of [owner(),ciPublisher(),ciAsListener(),budgetAsListener(),budget(),anon(),listener('Claude')])await assertFails(ack(other,T_ALL,'grok',ackEntry('LIT')));   // owner cannot forge an ack either
});
await check('NOTIFY (MESSAGE) targets write no progress at all (security: atProgress only for EXECUTE targets; no inbox file either)',async()=>{
 await seedMessages();
 for(const e of [entry('READY','delivered'),entry('READY','delivery_off'),entry('REJECTED','invalid'),entry('REJECTED','declined')]){
  await assertFails(progress(listener(),M_ALL,'grok',e),JSON.stringify(e.state+e.step));await assertFails(progress(listener('Codex'),M_ALL,'codex',e));}
 await environment.withSecurityRulesDisabled(c=>updateDoc(doc(c.firestore(),'active_tasks/'+M_ALL),{'progress.grok':{state:'READY',step:'delivered',updatedAt:Timestamp.now()}}));
 await assertFails(progress(owner(),M_ALL,'grok',entry('IN_PROGRESS','started')));                    // owner click needs an EXECUTE target too
 await assertSucceeds(ack(listener(),M_ALL,'grok',ackEntry('LIT')));                                   // the ack is the only listener write on a MESSAGE
});
await check('summary: size() <= 280 counted per character with Hebrew + niqqud (280 ok, 281 denied); RE2 allowlist compiles; no newline, bidi, zero-width, gershayim, emoji',async()=>{
 await seedMessages();const db=listener();
 const heb='שָׁלוֹם';const s280=(heb.repeat(60)).slice(0,280);assert.equal([...s280].length,280);assert.equal(s280.length,280);
 const fresh=async()=>{const id=randomUUID();await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'active_tasks/'+id),{...MSG(id),timestamp:Timestamp.now()}));return id;};
 await assertSucceeds(ack(db,await fresh(),'grok',ackEntry('UNDERSTOOD',s280)));
 await assertFails(ack(db,await fresh(),'grok',ackEntry('UNDERSTOOD',s280+'א')));
 await assertSucceeds(ack(db,await fresh(),'grok',ackEntry('UNDERSTOOD','a'.repeat(280))));await assertFails(ack(db,await fresh(),'grok',ackEntry('UNDERSTOOD','a'.repeat(281))));
 await assertSucceeds(ack(db,await fresh(),'grok',ackEntry('UNDERSTOOD','Fix: push/deploy? https://x.y ~!@#$%^&*()')));   // ':' and '/' allowed (UI renders textContent only)
 for(const bad of ['a\nb','a\rb','a\tb','a\u202eb','a\u2066b','a\u200fb','a\u200bb','a\ufeffb','גרש\u05f3','\u05f4','😀','a\u2013b','\u201cq\u201d','\u0000'])
  await assertFails(ack(db,await fresh(),'grok',ackEntry('UNDERSTOOD',bad)),JSON.stringify(bad));
});
await check('acks: only while PENDING and within 24 h of the task',async()=>{
 await seedMessages();
 await assertFails(ack(listener(),M_OLD,'grok',ackEntry('LIT')));
 await assertSucceeds(updateDoc(doc(owner(),'active_tasks/'+M_ALL),{status:'CANCELLED'}));
 await assertFails(ack(listener(),M_ALL,'grok',ackEntry('LIT')));
 await assertFails(ack(listener(),T_CANCELLED,'grok',ackEntry('LIT')));
});
await check('ack_switch: missing document or enabled:false denies every ack; enabled must be exactly true',async()=>{
 await seedMessages();
 await environment.withSecurityRulesDisabled(c=>deleteDoc(doc(c.firestore(),'control/ack_switch')));
 await assertFails(ack(listener(),M_ALL,'grok',ackEntry('LIT')));                                    // missing -> get fails -> denied
 await setSwitch(false);await assertFails(ack(listener(),M_ALL,'grok',ackEntry('LIT')));
 await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'control/ack_switch'),{enabled:'true',updatedAt:Timestamp.now()}));
 await assertFails(ack(listener(),M_ALL,'grok',ackEntry('LIT')));
 await setSwitch(true);await assertSucceeds(ack(listener(),M_ALL,'grok',ackEntry('LIT')));
});
await check('no retroactive ack (25572dc condition 2): task.timestamp >= control/ack_switch.updatedAt while ON; re-enabling moves the cut-off',async()=>{
 await seedMessages();const db=listener();
 const at=ms=>Timestamp.fromMillis(ms);const cut=Date.now()+60000;
 const msgAt=async ms=>{const id=randomUUID();await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'active_tasks/'+id),{...MSG(id),timestamp:at(ms)}));return id;};
 await setSwitch(true,at(cut));                                                        // switched ON after M_ALL was created
 await assertFails(ack(db,M_ALL,'grok',ackEntry('LIT')));                              // older task: never acked
 await assertFails(ack(db,await msgAt(cut-1),'grok',ackEntry('LIT')));                 // 1 ms before the cut-off
 await assertSucceeds(ack(db,await msgAt(cut),'grok',ackEntry('LIT')));                // exactly at the cut-off
 await assertSucceeds(ack(db,await msgAt(cut+1000),'grok',ackEntry('LIT')));
 for(const bad of [{enabled:true},{enabled:true,updatedAt:'2026-09-30'},{enabled:true,updatedAt:0}]){   // no/invalid updatedAt -> denied
  await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'control/ack_switch'),bad));
  await assertFails(ack(db,await msgAt(Date.now()),'grok',ackEntry('LIT')),JSON.stringify(bad));}
 // real owner flow: OFF, then ON by the owner (fresh sign-in) stamps updatedAt = request.time
 await setSwitch(false);const before=await msgAt(Date.now()-1000);
 const o=owner({auth_time:Math.floor(Date.now()/1000)});
 await assertSucceeds(updateDoc(doc(o,'control/ack_switch'),{enabled:true,updatedAt:serverTimestamp()}));
 await assertFails(ack(db,before,'grok',ackEntry('LIT')));                             // created while OFF / before ON
 await new Promise(r=>setTimeout(r,20));
 await assertSucceeds(ack(db,await msgAt(Date.now()+1000),'grok',ackEntry('LIT')));    // created after ON
});
await check('ack_switch document: owner-only seed with enabled:false + fresh sign-in; OFF always allowed, ON needs a fresh sign-in; no listener access, no list, no delete',async()=>{
 await seed();
 const sw=db=>doc(db,'control/ack_switch');const v=enabled=>({enabled,updatedAt:serverTimestamp()});
 await assertFails(setDoc(sw(owner()),v(true)));                                                      // seed must be false
 await assertFails(setDoc(sw(owner({auth_time:nowSeconds()-1000})),v(false)));                       // seed needs fresh auth
 for(const db of [listener(),ciPublisher(),budget(),anon()])await assertFails(setDoc(sw(db),v(false)));
 await assertFails(setDoc(sw(owner()),{enabled:false,updatedAt:Timestamp.now()}));
 await assertFails(setDoc(sw(owner()),{enabled:false,updatedAt:serverTimestamp(),by:'x'}));
 await assertSucceeds(setDoc(sw(owner()),v(false)));
 await assertFails(setDoc(sw(owner({auth_time:nowSeconds()-1000})),v(true)));                        // ON: stale auth denied
 await assertSucceeds(setDoc(sw(owner()),v(true)));await assertSucceeds(setDoc(sw(owner()),v(true)));  // idempotent
 await assertSucceeds(setDoc(sw(owner({auth_time:nowSeconds()-3000})),v(false)));                   // OFF: always allowed
 await assertFails(setDoc(sw(owner()),{enabled:'false',updatedAt:serverTimestamp()}));
 for(const db of [listener(),listener('Codex'),ciPublisher(),anon()]){await assertFails(getDoc(sw(db)));await assertFails(setDoc(sw(db),v(true)));await assertFails(updateDoc(sw(db),{enabled:true,updatedAt:serverTimestamp()}));}
 await assertSucceeds(getDoc(sw(owner())));await assertFails(getDocs(query(collection(owner(),'control'),limit(1))));
 for(const db of [owner(),listener()])await assertFails(deleteDoc(sw(db)));
 await assertFails(setDoc(doc(owner(),'control/other'),v(false)));
});
await check('C8 live behaviour preserved on the new artifact: dispatch create/read, events read-only for owner, deny-all elsewhere',async()=>{
 await seed();
 await assertSucceeds(getDoc(doc(owner(),'events/existing-event')));
 await assertFails(setDoc(doc(owner(),'events/'+randomUUID()),{agent:'Grok',kind:'heartbeat',task:'local_tests',step:'running',createdAt:serverTimestamp()}));
 await assertSucceeds(setDoc(doc(owner(),'dispatchRequests/'+randomUUID()),{agent:'Grok',taskType:'realtime',note:'x',status:'queued',batchId:randomUUID(),createdAt:serverTimestamp(),createdBy:OWNER}));
 await assertFails(setDoc(doc(owner(),'active_tasks/'+T_GROK+'/sub/x'),{a:1}));await assertFails(setDoc(doc(owner(),'activeTasks/'+randomUUID()),task(randomUUID())));
 await assertFails(getDoc(doc(listener(),'dispatchRequests/'+randomUUID())));
});
await environment.cleanup();
console.log(`Active-tasks Rules on exact deploy artifact: ${passed} PASS; artifact sha256 ${meta.artifactSha256}; base ${LIVE_BASE_SHA256}`);
