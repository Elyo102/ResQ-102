import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {assembleGitTasks} from './git-provenance.mjs';
import {runVerifiedLocalCycle,providerRequest} from './agent-cycle.mjs';
import {createAtomicBudget,PRINCIPAL,operationId} from './atomic-budget.mjs';
import {connectCloud,PROJECT,DATABASE} from './ci-cloud.mjs';
import {budgetFixture} from './budget-fixture.mjs';

// Synthetic Git commits, RSA keys and HTTP responses only. No fetch defaults.
function sourceFixture(t){
 const repo=mkdtempSync(join(tmpdir(),'resq-agent-integration-'));t.after(()=>rmSync(repo,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 git('init','--quiet');git('config','user.name','Synthetic');git('config','user.email','synthetic@example.invalid');git('config','commit.gpgsign','false');
 const ranges={Claude:{file:'functions/schedule-runtime.js',line_start:1513,line_end:1513},Grok:{file:'firestore.rules',line_start:1657,line_end:1657},Gemini:{file:'tests/package.json',line_start:1,line_end:1}};
 for(const r of Object.values(ranges)){const file=join(repo,r.file);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,Array(r.line_start-1).fill('// filler').concat('// synthetic reviewed source').join('\n')+'\n');}
 git('add','.');git('-c','core.hooksPath=NUL','commit','--quiet','-m','synthetic source');const sha=git('rev-parse','HEAD');
 return {sha,tasks:assembleGitTasks({repoPath:repo,approvedSha:sha,selections:Object.fromEntries(Object.entries(ranges).map(([a,r])=>[a,[r]]))})};
}
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const certificates={synthetic:keys.publicKey.export({type:'spki',format:'pem'})};
function jwt(uid,agent,authorizationId){
 const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',kid:'synthetic'})).toString('base64url');
 const payload={aud:PROJECT,iss:`https://securetoken.google.com/${PROJECT}`,sub:uid,iat:now,auth_time:now,exp:now+300,
  ...(agent?{control_plane_agent:agent}:{control_plane_budget:true,control_plane_authorization:authorizationId})};
 const body=Buffer.from(JSON.stringify(payload)).toString('base64url');const signer=createSign('RSA-SHA256');signer.update(head+'.'+body);signer.end();
 return head+'.'+body+'.'+signer.sign(keys.privateKey).toString('base64url');
}
function integration(t,{lost=false,wrongClaim=false}={}){
 const source=sourceFixture(t),authorizationId='integration-grant-001';
 const store=budgetFixture({approvedSha:source.sha,authorizationId});
 const tokens=new Map(),providerCalls=[],writes=[],events=[];let lose=lost;
 const env={GITHUB_REPOSITORY:'Elyo102/ResQ-102',GITHUB_REF:'refs/heads/dev',GITHUB_SHA:source.sha,TELEMETRY_APPROVED_SHA:source.sha,GITHUB_EVENT_NAME:'workflow_dispatch',TEST_RESULT:'success',
  TELEMETRY_AUTHORIZATION_ID:authorizationId,TELEMETRY_BUDGET_PRINCIPAL:PRINCIPAL,ANTHROPIC_API_KEY:'synthetic',XAI_API_KEY:'synthetic',GEMINI_API_KEY:'synthetic'};
 for(const agent of ['Budget','Codex','Claude','Grok','Gemini']){
  const refresh=`synthetic-refresh-token-${agent}`,uid=agent==='Budget'?PRINCIPAL:`resq-ci-${agent.toLowerCase()}-20260928`;
  tokens.set(refresh,{uid,agent:agent==='Budget'?undefined:agent});
  env[agent==='Budget'?'FIREBASE_BUDGET_REFRESH_TOKEN':agent==='Codex'?'FIREBASE_TELEMETRY_REFRESH_TOKEN':`FIREBASE_${agent.toUpperCase()}_REFRESH_TOKEN`]=refresh;
 }
 const response=data=>new Response(JSON.stringify(data));
 const fetcher=async(url,init={})=>{
  if(url.startsWith('https://securetoken.googleapis.com/')){const identity=tokens.get(new URLSearchParams(init.body).get('refresh_token'));assert.ok(identity);return response({user_id:identity.uid,project_id:'802712493259',id_token:jwt(identity.uid,identity.agent,wrongClaim?'wrong-grant':authorizationId)});}
  if(url==='https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com')return response(certificates);
  const root=`https://firestore.googleapis.com/v1/${DATABASE}/documents`;
  if(url.startsWith(root)){
   if(url===root+':batchGet')return response([{found:{name:DATABASE+'/documents/resq_budget_state/policy'},readTime:new Date(await store.transport.serverNow()).toISOString()}]);
   if(url===root+':commit'){
    const batch=JSON.parse(init.body).writes;
    if(batch.length===1){assert.ok(batch[0].update.name.startsWith(DATABASE+'/documents/events/'));events.push(batch[0]);return response({writeResults:[{}]});}
    assert.equal(batch.length,2);writes.push(structuredClone(batch));const result=await store.transport.commit(batch);
    if(lose){lose=false;throw Error('synthetic lost commit response');}return response(result);
   }
   const doc=await store.transport.get(url.slice(root.length+1));return doc?response(doc):new Response('{}',{status:404});
  }
  const agent=url==='https://api.anthropic.com/v1/messages'?'Claude':url==='https://api.x.ai/v1/responses'?'Grok':url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/')?'Gemini':null;
  assert.ok(agent,'No unexpected network route is permitted');providerCalls.push(agent);
  const text=JSON.stringify({verdict:'approve',summary:'Synthetic static review',findings:[],unverified:['No real execution performed'],...(agent==='Gemini'?{executive_summary_he:'סקירה מדומה בלבד'}:{})});
  return response(agent==='Claude'?{content:[{type:'text',text}]}:agent==='Grok'?{output:[{type:'message',content:[{type:'output_text',text}]}]}:{candidates:[{content:{parts:[{text}]}}]});
 };
 const args={env,tasks:source.tasks,connect:connectCloud,budgetFactory:createAtomicBudget,fetcher,
  capabilities:{atomicGrant:true,maxCycleMicroUsd:750000,maxReservations:3,providerMicroUsd:250000,taskAllowlist:true}};
 return {args,store,providerCalls,writes,events,authorizationId};
}
test('real local adapters compose with Git provenance, signed identity and two-write grants; restart cannot redispatch',async t=>{
 const x=integration(t);const first=await runVerifiedLocalCycle(x.args);assert.equal(first.status,'completed');assert.deepEqual(x.providerCalls,['Claude','Grok','Gemini']);assert.equal(x.writes.length,3);
 for(let i=0;i<3;i++)assert.equal(x.writes[i][1].update.fields.lastOperationId.stringValue,operationId(x.authorizationId,['Claude','Grok','Gemini'][i]));
 const snapshot=structuredClone([...x.store.docs]);const retry=await runVerifiedLocalCycle(x.args);assert.equal(retry.status,'partial');assert.equal(x.providerCalls.length,3);assert.equal(x.writes.length,3);assert.deepEqual([...x.store.docs],snapshot);
});
test('lost commit reply remains charged across fresh runner/budget instances with no resend or refund',async t=>{
 const x=integration(t,{lost:true});assert.equal((await runVerifiedLocalCycle(x.args)).status,'partial');assert.deepEqual(x.providerCalls,['Grok','Gemini']);assert.equal(x.writes.length,3);
 const task=x.args.tasks.Claude,provider=providerRequest('Claude',x.args.env,task);
 const request={id:operationId(x.authorizationId,'Claude'),provider:'Claude',model:provider.model,task:task.label,
  requestBody:provider.body,requestDigest:createHash('sha256').update(provider.body).digest('hex'),maxOutputTokens:task.maxOutputTokens};
 // A new OS process imports the actual budget module, with only synthetic state
 // via stdin. Any write, provider/network fetch or new permit fails this proof.
 const script=`import assert from 'node:assert/strict';
 import {readFileSync} from 'node:fs';
 import {createAtomicBudget} from ${JSON.stringify(new URL('./atomic-budget.mjs',import.meta.url).href)};
 const input=JSON.parse(readFileSync(0,'utf8')),docs=new Map(input.docs);let commits=0;
 globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN');};
 const budget=createAtomicBudget({authorizationId:input.authorizationId,approvedSha:input.approvedSha,principal:input.principal,
 transport:{get:async path=>docs.get(path)??null,serverNow:async()=>{throw Error('REPLAY_MUST_NOT_CREATE_PERMIT');},
 commit:async()=>{commits++;throw Error('REPLAY_WRITE_FORBIDDEN');}}});
 const result=await budget.reserveRequest(input.request);assert.equal(result.dispatch,false);assert.equal(result.reason,'ALREADY_RESERVED');assert.equal(commits,0);
 console.log(JSON.stringify({dispatch:result.dispatch,commits}));`;
 const replay=execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000,windowsHide:true,
  input:JSON.stringify({docs:[...x.store.docs],authorizationId:x.authorizationId,approvedSha:x.args.env.GITHUB_SHA,principal:PRINCIPAL,request}),stdio:['pipe','pipe','pipe']});
 assert.deepEqual(JSON.parse(replay),{dispatch:false,commits:0});
 const snapshot=structuredClone([...x.store.docs]);assert.equal((await runVerifiedLocalCycle(x.args)).status,'partial');assert.deepEqual(x.providerCalls,['Grok','Gemini']);assert.equal(x.writes.length,3);assert.deepEqual([...x.store.docs],snapshot);
});
test('wrong JWT authorization binding rejects before telemetry, budget writes or providers',async t=>{
 const x=integration(t,{wrongClaim:true});await assert.rejects(runVerifiedLocalCycle(x.args),/INVALID_CLOUD_IDENTITY/);
 assert.equal(x.writes.length,0);assert.equal(x.events.length,0);assert.equal(x.providerCalls.length,0);
});
