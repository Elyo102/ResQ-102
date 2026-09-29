// Local-only Rules harness. The fragment is never a deployable full ruleset.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,setDoc,Timestamp} from 'firebase/firestore';
import {createAtomicBudget,BUDGET_ROOT,PRINCIPAL,operationId,TASK_BINDINGS} from '../control-plane/atomic-budget.mjs';
import {budgetFixture} from '../control-plane/budget-fixture.mjs';
if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8191'||process.env.GCLOUD_PROJECT!=='demo-resq')throw Error('LOCAL_EMULATOR_REQUIRED');
const projectId='demo-resq-budget-'+process.pid;
const fragment=readFileSync(new URL('../control-plane/firestore-budget.rules.fragment',import.meta.url),'utf8');
assert.doesNotMatch(fragment,/rules_version\s*=|service cloud\.firestore/);
const rules="rules_version = '2'; service cloud.firestore { match /databases/{database}/documents {\n"+fragment+"\nmatch /{document=**} {allow read, write: if false;} }}";
const environment=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8191,rules}});
const prefix='projects/'+projectId+'/databases/(default)/documents/';
const root='http://127.0.0.1:8191/v1/'+prefix.slice(0,-1);
const decode=v=>{
 if('stringValue'in v)return v.stringValue;if('integerValue'in v)return Number(v.integerValue);
 if('booleanValue'in v)return v.booleanValue;if('timestampValue'in v)return Timestamp.fromDate(new Date(v.timestampValue));
 if('mapValue'in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,decode(x)]));
 if('arrayValue'in v)return (v.arrayValue.values||[]).map(decode);throw Error('UNSUPPORTED_FIXTURE_VALUE');
};
let store,transport,api,claim,uid=PRINCIPAL,count=0,lastWrites,lastRejection;
function jwt(){
 const at=Math.floor(Date.now()/1000),b64=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 return b64({alg:'none',typ:'JWT'})+'.'+b64({iss:'https://securetoken.google.com/'+projectId,aud:projectId,sub:uid,user_id:uid,iat:at,auth_time:at,exp:at+3600,control_plane_budget:true,control_plane_authorization:claim,firebase:{sign_in_provider:'custom',identities:{}}})+'.';
}
async function local(suffix,body){
 const response=await fetch(root+suffix,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+jwt(),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});
 const text=await response.text();if(text.length>1000000)throw Error('RESPONSE_LIMIT');
 if(!response.ok){lastRejection={status:response.status,message:JSON.parse(text)?.error?.message?.slice(0,1200)};const e=Error('LOCAL_REJECTED');e.status=response.status;throw e;}return JSON.parse(text);
}
async function seed(mutate=()=>{}){
 await environment.clearFirestore();uid=PRINCIPAL;
 store=budgetFixture({now:Date.now(),authorizationId:'rules-grant-'+(++count)});claim=store.authorizationId;mutate(store);
 await environment.withSecurityRulesDisabled(async c=>{for(const [path,value]of store.docs)await setDoc(doc(c.firestore(),path),Object.fromEntries(Object.entries(value.fields).map(([k,v])=>[k,decode(v)])));});
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
async function check(name,fn){lastRejection=null;try{await fn();}catch(e){if(lastRejection)console.error('Synthetic emulator rejection:',lastRejection);throw e;}console.log('PASS '+name);}
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
 console.log('10 isolated atomic budget Rules scenarios passed');
}finally{await environment.clearFirestore();await environment.cleanup();}
