// Active tasks: exact-byte provenance on top of the LIVE f30d3d85 artifact plus emulator Rules on the SAME bytes that
// would be deployed (control-plane/deploy/firestore.control-plane.rules). Local emulator only; synthetic identities only.
// Security review 30/09/2026 conditions B1-B4, C1-C8 (control-plane/ACTIVE-TASKS.md).
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
await check('B2/B4/C3 progress transitions: none->READY|REJECTED, READY->REJECTED, READY/delivered (only)->IN_PROGRESS, IN_PROGRESS->COMPLETED|FAILED; nothing leaves a terminal state',async()=>{
 await seed();const db=listener();
 await assertSucceeds(progress(db,T_GROK,'grok',entry('READY','delivered')));
 await assertFails(progress(db,T_GROK,'grok',entry('READY','delivery_off')));            // READY -> READY
 await assertFails(progress(db,T_GROK,'grok',entry('COMPLETED','completed')));          // READY -> COMPLETED
 await assertSucceeds(progress(db,T_GROK,'grok',entry('IN_PROGRESS','started')));
 await assertFails(progress(db,T_GROK,'grok',entry('READY','delivered')));              // back to READY
 await assertFails(progress(db,T_GROK,'grok',entry('REJECTED','declined')));           // IN_PROGRESS -> REJECTED
 await assertSucceeds(progress(db,T_GROK,'grok',entry('COMPLETED','completed')));
 for(const [s,st] of [['FAILED','failed'],['IN_PROGRESS','started'],['READY','delivered'],['REJECTED','declined'],['COMPLETED','completed']])await assertFails(progress(db,T_GROK,'grok',entry(s,st)));
 await seed();
 await assertFails(progress(db,T_GROK,'grok',entry('IN_PROGRESS','started')));          // none -> IN_PROGRESS
 await assertFails(progress(db,T_GROK,'grok',entry('COMPLETED','completed')));
 await assertFails(progress(db,T_GROK,'grok',entry('FAILED','failed')));
 await assertSucceeds(progress(db,T_GROK,'grok',entry('REJECTED','secret')));
 for(const [s,st] of [['READY','delivered'],['IN_PROGRESS','started'],['REJECTED','invalid']])await assertFails(progress(db,T_GROK,'grok',entry(s,st)));
 await seed();
 // hardening: READY/delivery_off (nothing written to the inbox) can never become IN_PROGRESS; it may only be REJECTED
 await assertSucceeds(progress(db,T_GROK,'grok',entry('READY','delivery_off')));
 await assertFails(progress(db,T_GROK,'grok',entry('IN_PROGRESS','started')));          // delivery_off -> IN_PROGRESS denied
 await assertSucceeds(progress(db,T_GROK,'grok',entry('REJECTED','declined')));
 await seed();
 await assertSucceeds(progress(db,T_GROK,'grok',entry('READY','delivered')));await assertSucceeds(progress(db,T_GROK,'grok',entry('IN_PROGRESS','started')));
 await assertSucceeds(progress(db,T_GROK,'grok',entry('FAILED','failed')));await assertFails(progress(db,T_GROK,'grok',entry('COMPLETED','completed')));
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
  {'progress.grok':entry('IN_PROGRESS','started')},{status:'cancelled'},{targets:{grok:'IGNORE',codex:'EXECUTE',gemini:'IGNORE'}}])await assertFails(updateDoc(ref(owner()),change));
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
  ['task_listeners/claude',{agent:'claude',seenAt:serverTimestamp()}]])await assertFails(setDoc(doc(listener(),path),data));
 for(const db of [owner(),ciPublisher(),ciAsListener(),budgetAsListener(),budget(),anon()])await assertFails(setDoc(doc(db,'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));
 for(const db of [owner(),listener()])await assertFails(deleteDoc(doc(db,'task_listeners/grok')));
 await assertSucceeds(getDoc(doc(owner(),'task_listeners/grok')));
 await assertSucceeds(getDocs(query(collection(owner(),'task_listeners'),orderBy('seenAt','desc'),limit(3))));
 await assertFails(getDocs(query(collection(owner(),'task_listeners'),orderBy('seenAt','desc'),limit(4))));
 for(const db of [listener(),ciPublisher(),anon()])await assertFails(getDoc(doc(db,'task_listeners/codex')));
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
