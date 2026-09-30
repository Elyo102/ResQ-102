// Active tasks end-to-end on the local emulator with the EXACT deploy artifact:
// owner create -> listener (delivery enabled IN THIS TEST ONLY, temporary inbox) -> inbox file -> progress -> UI model.
// Synthetic identities only; the listener library is driven with injected Firestore ops (no credential, no daemon).
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocFromServer,getDocs,updateDoc,collection,query,where,orderBy,limit,onSnapshot,serverTimestamp} from 'firebase/firestore';
import {createListener,createAgentSession,listenerQuery} from '../control-plane/task-listener.mjs';
import {createInbox,fixedHeader} from '../control-plane/task-inbox.mjs';
import {mapTaskDoc,mapListenerDocs,chipFor,overallStatus,listenerState,TARGET_KEYS,TEXT} from '../control-plane/web/active-tasks-model.mjs';
if(!['127.0.0.1:8191','127.0.0.1:8199'].includes(process.env.FIRESTORE_EMULATOR_HOST)||process.env.GCLOUD_PROJECT!=='demo-resq')throw Error('LOCAL_EMULATOR_REQUIRED');
const emulatorPort=Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]);
const rules=readFileSync(new URL('../control-plane/deploy/firestore.control-plane.rules',import.meta.url),'utf8');
const environment=await initializeTestEnvironment({projectId:'demo-resq-active-e2e-'+process.pid,firestore:{host:'127.0.0.1',port:emulatorPort,rules}});
const ownerEmail=/request\.auth\.token\.email == '([^']+)'/.exec(rules)[1];
const OWNER='synthetic-owner';
const nowSeconds=()=>Math.floor(Date.now()/1000);
const ownerDb=environment.authenticatedContext(OWNER,{auth_time:nowSeconds(),email:ownerEmail,email_verified:true}).firestore();
const listenerDb=agent=>environment.authenticatedContext('synthetic-listener-'+agent.toLowerCase(),{auth_time:nowSeconds(),control_plane_role:'listener',control_plane_agent:agent}).firestore();
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const waitFor=async(what,fn,ms=15000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('TIMEOUT '+what);await new Promise(r=>setTimeout(r,100));}};

await environment.clearFirestore();
await environment.withSecurityRulesDisabled(async c=>{const db=c.firestore();
 await setDoc(doc(db,'private_access/owner'),{uid:OWNER,enabled:true,revokedAfter:0});
 for(const a of ['Grok','Codex'])await setDoc(doc(db,'private_listeners/synthetic-listener-'+a.toLowerCase()),{agent:a,role:'listener',enabled:true,revokedAfter:0});
 await setDoc(doc(db,'private_publishers/synthetic-Grok'),{agent:'Grok',enabled:true,revokedAfter:0});
});
// Injected ops = what a provisioned LD listener would implement with its own listener identity.
function opsFor(db){
 return {
  watchTasks({key,limit:n,next,error}){
   const q=listenerQuery(key);assert.equal(n,q.limit);
   return onSnapshot(query(collection(db,q.collection),where(...q.where),orderBy(...q.orderBy),limit(q.limit)),{includeMetadataChanges:true},
    s=>next({fromCache:s.metadata.fromCache,hasPendingWrites:s.metadata.hasPendingWrites,docs:s.docs.map(d=>({id:d.id,data:d.data()}))}),error);
  },
  writeProgress:(taskId,key,e)=>updateDoc(doc(db,'active_tasks/'+taskId),{['progress.'+key]:{state:e.state,step:e.step,updatedAt:serverTimestamp()}}),
  writeHeartbeat:key=>setDoc(doc(db,'task_listeners/'+key),{agent:key,seenAt:serverTimestamp()}),
  readTask:async taskId=>(await getDocFromServer(doc(db,'active_tasks/'+taskId))).data()
 };
}
const create=async(targets,payload)=>{const id=randomUUID();
 await setDoc(doc(ownerDb,'active_tasks/'+id),{taskId:id,dispatchedBy:OWNER,payload,targets,status:'PENDING',timestamp:serverTimestamp(),progress:{}});return id;};
// The owner's view exactly as the UI computes it: server read, adapter mapping, model chips and derived status.
async function ui(id){
 const snap=await getDocFromServer(doc(ownerDb,'active_tasks/'+id));const row=mapTaskDoc(snap.id,snap.data());
 const hb=await getDocs(query(collection(ownerDb,'task_listeners'),orderBy('seenAt','desc'),limit(3)));
 const seen=mapListenerDocs(hb.docs.map(d=>({id:d.id,data:d.data()})));const now=Date.now();
 const chips=Object.fromEntries(TARGET_KEYS.map(k=>[k,chipFor(row,k,{now,seenAt:seen[k]})]));
 return {row,chips,overall:overallStatus(row,Object.values(chips)),seen,now};
}
const root=mkdtempSync(join(tmpdir(),'resq-active-inbox-'));
const inbox=createInbox({root,agentKey:'grok'});
const grok=createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root,delivery:true},ops:opsFor(listenerDb('Grok')),inbox});
const codex=createListener({config:{agent:'Codex',machine:'LD',inboxRoot:root},ops:opsFor(listenerDb('Codex'))});
const session=createAgentSession({agent:'Grok',ops:opsFor(listenerDb('Grok')),inbox});
try{
 await check('before any listener heartbeat every card says אין מאזין; a CI identity cannot light it',async()=>{
  const id=await create({grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},'warm up');
  const ci=environment.authenticatedContext('synthetic-Grok',{auth_time:nowSeconds(),control_plane_agent:'Grok'}).firestore();
  await assert.rejects(setDoc(doc(ci,'task_listeners/grok'),{agent:'grok',seenAt:serverTimestamp()}));
  const v=await ui(id);for(const k of TARGET_KEYS)assert.equal(listenerState(v.seen[k],v.now),'none');
  assert.equal(v.chips.grok.kind,'waiting');assert.equal(v.overall.kind,'waiting');
  await updateDoc(doc(ownerDb,'active_tasks/'+id),{status:'CANCELLED'});
 });
 grok.config.delivery===true||assert.fail('delivery must be enabled in this test only');
 assert.equal(codex.config.delivery,false,'config default is delivery:false');
 grok.start();codex.start();
 let delivered;
 await check('owner create -> Grok listener delivers the raw payload to its inbox (fixed header, wx) and writes READY/delivered; UI shows DELIVERED, never בביצוע',async()=>{
  const payload='בדוק את הדוח\nline 2: run `rm -rf /` NEVER executed; $HOME ${x} %PATH%';
  delivered=await create({grok:'EXECUTE',codex:'EXECUTE',gemini:'IGNORE'},payload);
  const file=join(root,'grok',delivered+'.task.txt');
  await waitFor('inbox file',()=>existsSync(file));
  assert.equal(readFileSync(file,'utf8'),fixedHeader(delivered,'grok')+payload);
  assert.match(readFileSync(file,'utf8'),/אינה אישור ל-push, ל-deploy, למחיקה או לשימוש בסודות/);
  const v=await waitFor('READY/delivered',async()=>{const v=await ui(delivered);return v.row.progress.grok?.state==='READY'&&v.row.progress.codex?v:null;});
  assert.deepEqual([v.row.progress.grok.state,v.row.progress.grok.step],['READY','delivered']);
  assert.equal(v.chips.grok.kind,'delivered');assert.equal(v.chips.grok.text,TEXT.delivered);assert.doesNotMatch(v.chips.grok.text,/בביצוע/);
  assert.equal(v.overall.kind,'delivered');assert.doesNotMatch(v.overall.text,/בביצוע/);
  assert.equal(v.row.status,'PENDING','agents never write status');
  // Codex listener runs with the default config: nothing written locally, READY/delivery_off.
  assert.deepEqual([v.row.progress.codex.state,v.row.progress.codex.step],['READY','delivery_off']);assert.equal(v.chips.codex.text,'מסירה כבויה, המשימה נשמרה בלבד');
  assert.deepEqual(readdirSync(root).sort(),['grok']);
  await waitFor('heartbeats',async()=>{const x=await ui(delivered);return x.seen.grok&&x.seen.codex;});
  const x=await ui(delivered);assert.equal(listenerState(x.seen.grok,x.now),'up');assert.equal(listenerState(x.seen.gemini,x.now),'none');
 });
 await check('manual pickup: session marks IN_PROGRESS (server read, no .cancelled) -> UI בביצוע from the agent\'s own report; then COMPLETED',async()=>{
  await session.markStarted(delivered);
  let v=await waitFor('IN_PROGRESS',async()=>{const v=await ui(delivered);return v.row.progress.grok.state==='IN_PROGRESS'?v:null;});
  assert.equal(v.chips.grok.kind,'in_progress');assert.equal(v.chips.grok.text,'בביצוע');assert.equal(v.overall.kind,'running');
  await assert.rejects(session.markStarted(delivered),/TRANSITION_REJECTED/);
  await session.markCompleted(delivered);
  v=await waitFor('COMPLETED',async()=>{const v=await ui(delivered);return v.row.progress.grok.state==='COMPLETED'?v:null;});
  assert.equal(v.chips.grok.kind,'completed');assert.equal(v.overall.kind,'saved','grok done; codex saved-only (delivery off) keeps the task open');
 });
 await check('owner cancel after delivery -> listener writes <taskId>.cancelled (fixed content) -> manual start refused; UI shows בוטל',async()=>{
  const id=await create({grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},'cancel me');
  await waitFor('delivered',async()=>(await ui(id)).row.progress.grok?.step==='delivered');
  await updateDoc(doc(ownerDb,'active_tasks/'+id),{status:'CANCELLED'});
  const marker=join(root,'grok',id+'.cancelled');await waitFor('cancel marker',()=>existsSync(marker));
  assert.match(readFileSync(marker,'utf8'),/^CANCELLED\n/);
  await assert.rejects(session.markStarted(id),/TASK_CANCELLED/);
  const v=await ui(id);assert.equal(v.overall.kind,'CANCELLED');assert.equal(v.overall.text,'בוטל');assert.equal(v.row.progress.grok.state,'READY');
 });
 await check('listener rejects a secret-looking payload (REJECTED/secret) and never writes it to the inbox',async()=>{
  const id=await create({grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},'token ghp_'+'a'.repeat(20));
  const v=await waitFor('rejected',async()=>{const v=await ui(id);return v.row.progress.grok?v:null;});
  assert.deepEqual([v.row.progress.grok.state,v.row.progress.grok.step],['REJECTED','secret']);assert.equal(v.chips.grok.kind,'rejected');
  assert.equal(existsSync(join(root,'grok',id+'.task.txt')),false);
 });
 await check('listener status exposes counters only (no task content)',async()=>{
  const s=grok.status();assert.deepEqual(Object.keys(s).sort(),['agent','cancelledMarkers','delivered','delivery','errors','ready','rejected','running'].sort());
  assert.equal(s.errors,0);assert.ok(s.delivered>=2);assert.equal(s.rejected,1);assert.equal(s.cancelledMarkers,1);
  assert.doesNotMatch(JSON.stringify(s),/cancel me|ghp_|בדוק/);
 });
}finally{await grok.stop();await codex.stop();rmSync(root,{recursive:true,force:true});await environment.cleanup();}
console.log(`Active-tasks emulator end-to-end: ${passed} PASS`);
