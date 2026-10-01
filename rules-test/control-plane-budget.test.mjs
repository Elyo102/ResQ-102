// Local-only full Rules harness: preserved owner/events plus atomic budget.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {initializeTestEnvironment,assertFails,assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc,getDoc,getDocs,updateDoc,deleteDoc,deleteField,collection,query,limit,serverTimestamp,Timestamp} from 'firebase/firestore';
import {createAtomicBudget,BUDGET_ROOT,PRINCIPAL,operationId,TASK_BINDINGS} from '../control-plane/atomic-budget.mjs';
import {budgetFixture} from '../control-plane/budget-fixture.mjs';
if(!['127.0.0.1:8191','127.0.0.1:8199'].includes(process.env.FIRESTORE_EMULATOR_HOST)||process.env.GCLOUD_PROJECT!=='demo-resq')throw Error('LOCAL_EMULATOR_REQUIRED');
const emulatorPort=Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]);
const projectId='demo-resq-budget-'+process.pid;
const fragment=readFileSync(new URL('../control-plane/firestore-budget.rules.fragment',import.meta.url),'utf8');
assert.doesNotMatch(fragment,/rules_version\s*=|service cloud\.firestore/);
const rules=readFileSync(new URL('../control-plane/firestore.rules',import.meta.url),'utf8');
assert.ok(rules.replace(/\r\n/g,'\n').includes(fragment.replace(/\r\n/g,'\n').trimEnd()));
let environment=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:emulatorPort,rules}});
const prefix='projects/'+projectId+'/databases/(default)/documents/';
const root='http://127.0.0.1:'+emulatorPort+'/v1/'+prefix.slice(0,-1);
const decode=v=>{
 if('stringValue'in v)return v.stringValue;if('integerValue'in v)return Number(v.integerValue);
 if('booleanValue'in v)return v.booleanValue;if('timestampValue'in v)return Timestamp.fromDate(new Date(v.timestampValue));
 if('mapValue'in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,decode(x)]));
 if('arrayValue'in v)return (v.arrayValue.values||[]).map(decode);throw Error('UNSUPPORTED_FIXTURE_VALUE');
};
let store,transport,api,claim,uid=PRINCIPAL,count=0,lastWrites,lastRejection,authTime,scenarios=0;
function jwt(){
 const at=Math.floor(Date.now()/1000),b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 return b64({alg:'none',typ:'JWT'})+'.'+b64({iss:'https://securetoken.google.com/'+projectId,aud:projectId,sub:uid,user_id:uid,iat:at,auth_time:authTime??at,exp:at+3600,control_plane_budget:true,control_plane_authorization:claim,firebase:{sign_in_provider:'custom',identities:{}}})+'.';
}
async function local(suffix,body){
 const response=await fetch(root+suffix,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+jwt(),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});
 const text=await response.text();if(text.length>1000000)throw Error('RESPONSE_LIMIT');
 if(!response.ok){lastRejection={status:response.status,message:JSON.parse(text)?.error?.message?.slice(0,1200)};const e=Error('LOCAL_REJECTED');e.status=response.status;throw e;}return JSON.parse(text);
}
async function seed(mutate=()=>{}){
 await environment.clearFirestore();uid=PRINCIPAL;authTime=Math.floor(Date.now()/1000)-60;
 store=budgetFixture({now:Date.now(),authorizationId:'rules-grant-'+(++count)});claim=store.authorizationId;mutate(store);
 await environment.withSecurityRulesDisabled(async c=>{for(const [path,value]of store.docs)await setDoc(doc(c.firestore(),path),Object.fromEntries(Object.entries(value.fields).map(([k,v])=>[k,decode(v)])));});
 await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'private_budget_publishers/'+PRINCIPAL),{enabled:true,revokedAfter:0}));
 transport={
  async get(path){try{const value=await local('/'+path);return {...value,name:BUDGET_ROOT+path};}catch(e){if(e.status===404)return null;throw e;}},
  async serverNow(){const rows=await local(':batchGet',{documents:[prefix+'resq_budget_state/policy']});assert.equal(rows.length,1);return Date.parse(rows[0].readTime);},
  async commit(writes){lastWrites=structuredClone(writes);return local(':commit',{writes:writes.map(w=>({...w,update:{...w.update,name:w.update.name.replace(BUDGET_ROOT,prefix)}}))});}
 };
 api=createAtomicBudget({...store,transport});lastWrites=null;
}
function request(provider='Claude'){
 const requestBody='{"synthetic":true}';return {id:operationId(store.authorizationId,provider),provider,model:store.docs.get('resq_budget_state/policy').fields.models.mapValue.fields[provider].stringValue,task:TASK_BINDINGS[provider],requestBody,requestDigest:createHash('sha256').update(requestBody).digest('hex'),maxOutputTokens:700};
}
async function candidate(provider='Claude'){
 const commit=transport.commit;let writes;transport.commit=async w=>{writes=structuredClone(w);throw Error('CAPTURE_ONLY');};
 try{await assert.rejects(api.reserveRequest(request(provider)),/COMMIT_UNKNOWN/);}finally{transport.commit=commit;}
 assert.ok(writes);return writes;
}
async function check(name,fn){lastRejection=null;try{await fn();}catch(e){if(lastRejection)console.error('Synthetic emulator rejection:',lastRejection);throw e;}scenarios++;console.log('PASS '+name);}
try{
 await check('three actual two-write reservations succeed; fourth and replay denied',async()=>{
  await seed();for(const p of ['Claude','Grok','Gemini']){const permit=await api.reserveRequest(request(p));assert.equal(api.assertDispatch(permit),true);assert.equal(lastWrites.length,2);}
  const grant=await transport.get(store.grantPath),month=await transport.get(store.monthPath);
  assert.equal(grant.fields.reservationCount.integerValue,'3');assert.equal(month.fields.chargedMicroUsd.integerValue,'750000');
  assert.equal((await api.reserveRequest(request())).dispatch,false);await assert.rejects(transport.commit(lastWrites));
  const fourth=structuredClone(lastWrites),g=fourth[1],provider='Codex';
  fourth[0].currentDocument.updateTime=month.updateTime;g.currentDocument.updateTime=grant.updateTime;
  fourth[0].update.fields.chargedMicroUsd={integerValue:'1000000'};fourth[0].update.fields.lastOperationId={stringValue:store.authorizationId+'_'+provider};
  g.update.fields.chargedMicroUsd={integerValue:'1000000'};g.update.fields.reservationCount={integerValue:'4'};
  g.update.fields.lastOperationId={stringValue:store.authorizationId+'_'+provider};g.update.fields.reservedProviders.arrayValue.values.push({stringValue:provider});
  g.update.fields.operations.mapValue.fields.Codex=g.update.fields.operations.mapValue.fields.Gemini;delete g.update.fields.operations.mapValue.fields.Gemini;
  g.update.fields.operations.mapValue.fields.Codex.mapValue.fields.provider={stringValue:provider};
  g.updateMask.fieldPaths[4]='operations.Codex';g.updateTransforms[0].fieldPath='operations.Codex.createdAt';
  await assert.rejects(transport.commit(fourth));
 });
 await check('concurrent generated CAS commits have exactly one winner',async()=>{
  await seed();const a=await candidate('Claude'),b=await candidate('Grok');
  const r=await Promise.allSettled([transport.commit(a),transport.commit(b)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await transport.get(store.monthPath)).fields.chargedMicroUsd.integerValue,'250000');
 });
 await check('single month or grant write never changes either document',async()=>{
  for(const index of [0,1]){await seed();const w=await candidate();await assert.rejects(transport.commit([w[index]]));assert.equal((await transport.get(store.monthPath)).fields.chargedMicroUsd.integerValue,'0');}
 });
 await check('wrong principal and authorization claim are denied',async()=>{
  for(const kind of ['uid','claim']){await seed();const w=await candidate();if(kind==='uid')uid='other-principal';else claim='different-grant';await assert.rejects(transport.commit(w));}
 });
 await check('fabricated counter-only grant and cross-grant pairing denied',async()=>{
  await seed();const fake=await candidate();delete fake[1].update.fields.operations;fake[1].updateMask.fieldPaths=fake[1].updateMask.fieldPaths.filter(p=>!p.startsWith('operations.'));delete fake[1].updateTransforms;
  await assert.rejects(transport.commit(fake));assert.equal((await transport.get(store.monthPath)).fields.chargedMicroUsd.integerValue,'0');
  await seed();const mixed=await candidate(),other='resq_budget_authorizations/other-grant-001';
  await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),other),Object.fromEntries(Object.entries(store.docs.get(store.grantPath).fields).map(([k,v])=>[k,decode(v)]))));
  mixed[1].update.name=BUDGET_ROOT+other;
  // Exact CAS of the other document, so authorization—not stale state—must deny.
  const saved=claim;claim='other-grant-001';mixed[1].currentDocument.updateTime=(await transport.get(other)).updateTime;claim=saved;
  await assert.rejects(transport.commit(mixed));assert.equal((await transport.get(store.monthPath)).fields.chargedMicroUsd.integerValue,'0');
 });
 await check('immutable SHA, grant binding, task and cost cannot be changed',async()=>{
  for(const kind of ['sha','authorization','task','cost']){
   await seed();const w=await candidate(),g=w[1],op=g.update.fields.operations.mapValue.fields.Claude.mapValue.fields;
   if(kind==='sha'||kind==='authorization'){const key=kind==='sha'?'approvedSha':'authorizationId';g.update.fields[key]={stringValue:kind==='sha'?'b'.repeat(40):'other-grant'};g.updateMask.fieldPaths.push(key);}
   if(kind==='task')op.task={stringValue:'swap_race_review'};if(kind==='cost')op.chargedMicroUsd={integerValue:'1'};
   await assert.rejects(transport.commit(w));
  }
 });
 await check('expired/revoked grant and expired operation denied at write time',async()=>{
  for(const kind of ['expired','revoked','operation']){
   await seed();const w=await candidate();
   if(kind==='operation')w[1].update.fields.operations.mapValue.fields.Claude.mapValue.fields.expiresAt={timestampValue:new Date(0).toISOString()};
   else await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),store.grantPath),kind==='revoked'?{enabled:false}:{expiresAt:Timestamp.fromMillis(0)},{merge:true}));
   w[1].currentDocument.updateTime=(await transport.get(store.grantPath)).updateTime;
   await assert.rejects(transport.commit(w));
  }
 });
 await check('previous operation history is immutable',async()=>{
  await seed();await api.reserveRequest(request('Claude'));const w=await candidate('Grok');
  const old=(await transport.get(store.grantPath)).fields.operations.mapValue.fields.Claude;
  old.mapValue.fields.requestDigest={stringValue:'b'.repeat(64)};w[1].update.fields.operations.mapValue.fields.Claude=old;w[1].updateMask.fieldPaths.push('operations.Claude');
  await assert.rejects(transport.commit(w));
 });
 await check('wrong month document name cannot represent the current ledger',async()=>{
  await seed();const w=await candidate(),oldPath=store.monthPath,bad='resq_budget_state/month_1999-01';
  await environment.withSecurityRulesDisabled(async c=>{
   await setDoc(doc(c.firestore(),bad),Object.fromEntries(Object.entries(store.docs.get(oldPath).fields).map(([k,v])=>[k,decode(v)])));
   await setDoc(doc(c.firestore(),store.grantPath),{monthId:'month_1999-01'},{merge:true});
  });
  w[0].update.name=BUDGET_ROOT+bad;w[0].currentDocument.updateTime=(await transport.get(bad)).updateTime;
  w[1].currentDocument.updateTime=(await transport.get(store.grantPath)).updateTime;
  await assert.rejects(transport.commit(w));
 });
 await check('monthly cap enforced by Rules independently of client',async()=>{
  await seed();const w=await candidate();
  await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),store.monthPath),{chargedMicroUsd:20000000,lastOperationId:'previous-grant_Claude',lastAuthorizationId:'previous-grant'},{merge:true}));
  w[0].currentDocument.updateTime=(await transport.get(store.monthPath)).updateTime;w[0].update.fields.chargedMicroUsd={integerValue:'20250000'};
  await assert.rejects(transport.commit(w));
 });
 await check('budget publisher disabled/missing/revoked and invalid auth time deny reads and writes',async()=>{
  for(const kind of ['disabled','missing','revoked','future','invalid']){
   await seed();const w=await candidate();
   await environment.withSecurityRulesDisabled(async c=>{
    const ref=doc(c.firestore(),'private_budget_publishers/'+PRINCIPAL);
    if(kind==='missing')await deleteDoc(ref);
    if(kind==='disabled')await updateDoc(ref,{enabled:false});
    if(kind==='revoked')await updateDoc(ref,{revokedAfter:Math.floor(Date.now()/1000)+60});
   });
   if(kind==='future')authTime=Math.floor(Date.now()/1000)+300;
   if(kind==='invalid')authTime='not-an-integer';
   await assert.rejects(transport.get('resq_budget_state/policy'));
   await assert.rejects(transport.commit(w));
  }
 });
 await check('all five exact-key validators reject every missing key and extra keys',async()=>{
  await seed();const sample=await candidate();
  const groups={
   month:Object.keys(store.docs.get(store.monthPath).fields),
   grant:Object.keys(store.docs.get(store.grantPath).fields),
   operation:[...new Set([...Object.keys(sample[1].update.fields.operations.mapValue.fields.Claude.mapValue.fields),'createdAt'])],
   policy:Object.keys(store.docs.get('resq_budget_state/policy').fields),
   pricing:Object.keys(store.docs.get('resq_budget_state/policy').fields.pricing.mapValue.fields.Claude.mapValue.fields)
  };
  for(const [group,keys]of Object.entries(groups))for(const key of [...keys,'__extra']){
   await seed();const w=await candidate();
   if(group==='policy'||group==='pricing'){
    const field=group==='policy'?key:'pricing.Claude.'+key;
    await environment.withSecurityRulesDisabled(c=>updateDoc(doc(c.firestore(),'resq_budget_state/policy'),{[field]:key==='__extra'?'extra':deleteField()}));
   }else{
    const entry=w[group==='month'?0:1];
    const fields=group==='operation'?entry.update.fields.operations.mapValue.fields.Claude.mapValue.fields:entry.update.fields;
    if(key==='__extra')fields[key]={stringValue:'extra'};else delete fields[key];
    if(group!=='operation'&&!entry.updateMask.fieldPaths.includes(key))entry.updateMask.fieldPaths.push(key);
    if(group==='operation'&&key==='createdAt')delete entry.updateTransforms;
   }
   await assert.rejects(transport.commit(w),undefined,`${group}:${key} must fail closed`);
  }
 });
 const ownerEmail=/request\.auth\.token\.email == '([^']+)'/.exec(rules)[1];
 const nowSeconds=()=>Math.floor(Date.now()/1000);
 const client=(id,claims={})=>environment.authenticatedContext(id,{auth_time:nowSeconds(),...claims}).firestore();
 const owner=()=>client('synthetic-owner',{email:ownerEmail,email_verified:true});
 const publisher=(agent='Grok',claims={})=>client('synthetic-'+agent,{control_plane_agent:agent,...claims});
 const event=(agent='Grok',extra={})=>({agent,kind:'heartbeat',task:'local_tests',step:'running',createdAt:serverTimestamp(),...extra});
 async function seedEvents(){
  await seed();
  await environment.withSecurityRulesDisabled(async c=>{
   const db=c.firestore();await setDoc(doc(db,'private_access/owner'),{uid:'synthetic-owner',enabled:true,revokedAfter:0});
   for(const agent of ['Codex','Claude','Grok','Gemini'])await setDoc(doc(db,'private_publishers/synthetic-'+agent),{agent,enabled:true,revokedAfter:0});
   await setDoc(doc(db,'events/existing-event'),{agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',createdAt:Timestamp.now()});
  });
 }
 await check('owner reads and bounded queries preserved, anonymous and impersonation denied',async()=>{
  await seedEvents();await assertSucceeds(getDoc(doc(owner(),'events/existing-event')));
  await assertSucceeds(getDocs(query(collection(owner(),'events'),limit(50))));
  await assertFails(getDocs(collection(owner(),'events')));
  await assertFails(getDocs(query(collection(owner(),'events'),limit(51))));
  for(const db of [environment.unauthenticatedContext().firestore(),client('other',{email:ownerEmail,email_verified:true}),client('synthetic-owner',{email:ownerEmail,email_verified:false}),client('synthetic-owner',{email:'synthetic-other@example.invalid',email_verified:true}),publisher()])await assertFails(getDoc(doc(db,'events/existing-event')));
 });
 await check('owner configuration revocation and authentication time gates preserved',async()=>{
  for(const kind of ['disabled','revoked','missing','future']){
   await seedEvents();await environment.withSecurityRulesDisabled(async c=>{
    const ref=doc(c.firestore(),'private_access/owner');
    if(kind==='missing')await deleteDoc(ref);
    if(kind==='disabled')await updateDoc(ref,{enabled:false});
    if(kind==='revoked')await updateDoc(ref,{revokedAfter:nowSeconds()+60});
   });
   const db=kind==='future'?client('synthetic-owner',{email:ownerEmail,email_verified:true,auth_time:nowSeconds()+300}):owner();
   await assertFails(getDoc(doc(db,'events/existing-event')));
  }
 });
 await check('all four configured publishers accept only the eight approved task labels',async()=>{
  await seedEvents();
  for(const agent of ['Codex','Claude','Grok','Gemini'])for(const task of ['local_tests','git_change','pull_request_review','deployment_check','agent_review_cycle','planner_draft_recovery','swap_race_review','clean_checkout_gates'])await assertSucceeds(setDoc(doc(publisher(agent),'events/'+randomUUID()),event(agent,{task})));
  await assertFails(setDoc(doc(owner(),'events/'+randomUUID()),event()));
  await assertFails(setDoc(doc(client('unconfigured',{control_plane_agent:'Grok'}),'events/'+randomUUID()),event()));
 });
 await check('event identity/schema/server time and append-only protections preserved',async()=>{
  await seedEvents();
  for(const extra of [{agent:'Claude'},{task:'unknown'},{kind:'unknown'},{step:'unknown'},{rawLog:'not-allowed'},{createdAt:Timestamp.fromMillis(0)}])await assertFails(setDoc(doc(publisher(),'events/'+randomUUID()),event('Grok',extra)));
  await assertFails(setDoc(doc(publisher(),'events/bad-id'),event()));
  await assertFails(setDoc(doc(publisher('Grok',{control_plane_agent:'Claude'}),'events/'+randomUUID()),event()));
  const id=randomUUID();await assertSucceeds(setDoc(doc(publisher(),'events/'+id),event()));
  for(const db of [publisher(),owner()]){
   await assertFails(updateDoc(doc(db,'events/'+id),{step:'completed'}));
   await assertFails(deleteDoc(doc(db,'events/'+id)));
  }
 });
 await check('publisher disablement/missing configuration/revocation/future auth time deny writes',async()=>{
  for(const kind of ['disabled','revoked','missing','future']){
   await seedEvents();await environment.withSecurityRulesDisabled(async c=>{
    const ref=doc(c.firestore(),'private_publishers/synthetic-Grok');
    if(kind==='missing')await deleteDoc(ref);
    if(kind==='disabled')await updateDoc(ref,{enabled:false});
    if(kind==='revoked')await updateDoc(ref,{revokedAfter:nowSeconds()+60});
   });
   await assertFails(setDoc(doc(kind==='future'?publisher('Grok',{auth_time:nowSeconds()+300}):publisher(),'events/'+randomUUID()),event()));
  }
 });
 await check('owner/events/budget identities cannot cross scopes or modify private configuration',async()=>{
  await seedEvents();
  const budget=client(PRINCIPAL,{control_plane_budget:true,control_plane_authorization:claim});
  for(const db of [owner(),publisher(),budget]){
   for(const path of ['private_access/owner','private_publishers/synthetic-Grok','private_budget_publishers/'+PRINCIPAL,'unknown/secret']){
    await assertFails(getDoc(doc(db,path)));await assertFails(setDoc(doc(db,path),{enabled:true}));
   }
  }
  await assertFails(getDoc(doc(budget,'events/existing-event')));await assertFails(setDoc(doc(budget,'events/'+randomUUID()),event()));
  for(const db of [owner(),publisher()])await assertFails(getDoc(doc(db,'resq_budget_state/policy')));
  await assertFails(getDocs(collection(budget,'resq_budget_state')));
  await assertFails(getDocs(collection(budget,'resq_budget_authorizations')));
  await assertFails(getDoc(doc(budget,'resq_budget_authorizations/other-grant-001')));
  const mixed=client(PRINCIPAL,{control_plane_budget:true,control_plane_authorization:claim,control_plane_agent:'Grok'});
  await assertFails(getDoc(doc(mixed,'resq_budget_state/policy')));
 });
 await check('legacy operation paths and budget create/delete/policy writes remain closed',async()=>{
  await seedEvents();const budget=client(PRINCIPAL,{control_plane_budget:true,control_plane_authorization:claim});
  const legacy='resq_budget_state/policy/operations/'+'a'.repeat(64);
  await environment.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),legacy),{existing:true}));
  for(const path of [legacy,'resq_budget_state/policy',store.monthPath,store.grantPath]){
   await assertFails(setDoc(doc(budget,path),{changed:true}));await assertFails(deleteDoc(doc(budget,path)));
  }
  await assertFails(getDoc(doc(budget,legacy)));
  await assertFails(setDoc(doc(budget,'resq_budget_authorizations/new-grant-001'),{enabled:true}));
  await assertFails(setDoc(doc(budget,'resq_budget_state/month_1999-01'),{chargedMicroUsd:0}));
 });
 // Emulator request.time is not adjustable. Only the pure blackout helper's
 // clock is replaced in these derived local rules; actual commit/policy/expiry
 // checks still run on emulator server time. Canonical rules remain unchanged.
 await check('server blackout blocks REST pairs and either partial write at month/year/leap boundaries',async()=>{
  const body=/function budgetWindow\(\) \{([\s\S]*?)\n  \}/.exec(rules);assert.ok(body);
  for(const [year,month,seconds,allowed]of [[2026,10,121,true],[2026,10,120,false],[2027,1,60,false],[2028,3,1,false]]){
   const expression=`(timestamp.date(${year}, ${month}, 1) - duration.value(${seconds}, 's'))`;
   const derived=rules.replace(body[0],body[0].replaceAll('request.time',expression));
   await environment.cleanup();
   const clockEnv=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:emulatorPort,rules:derived}});
   // Same project and transport; update environment handle for seed/cleanup.
   environment=clockEnv;await seed();const w=await candidate();
   if(allowed)await transport.commit(w);
   else{
    await assert.rejects(transport.commit(w));
    await assert.rejects(transport.commit([w[0]]));await assert.rejects(transport.commit([w[1]]));
    assert.equal((await transport.get(store.monthPath)).fields.chargedMicroUsd.integerValue,'0');
   }
  }
 });
 console.log(`${scenarios} combined owner/events/atomic budget Rules scenarios passed`);
}finally{await environment.clearFirestore();await environment.cleanup();}
