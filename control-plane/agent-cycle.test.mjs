import test from 'node:test';
import assert from 'node:assert/strict';
import {runLocalCycle as runCycle,runCycle as liveCycle,providerRequest as buildRequest,requestProvider} from './agent-cycle.mjs';
import {ACTIVATION_STATE,TASKS,buildTask,parseTaskResult} from './task-contracts.mjs';
const env={GITHUB_REPOSITORY:'Elyo102/ResQ-102',GITHUB_REF:'refs/heads/dev',GITHUB_SHA:'a'.repeat(40),TELEMETRY_APPROVED_SHA:'a'.repeat(40),TELEMETRY_AUTHORIZATION_ID:'synthetic-grant-001',TELEMETRY_BUDGET_PRINCIPAL:'resq-ci-budget-20260928',GITHUB_EVENT_NAME:'push',TEST_RESULT:'success',ANTHROPIC_API_KEY:'synthetic',XAI_API_KEY:'synthetic',GEMINI_API_KEY:'synthetic'};
const tasks=Object.fromEntries(Object.entries(TASKS).map(([agent,t])=>[agent,buildTask(agent,{sha:env.GITHUB_SHA,excerpts:[{file:t.files[0][0],line_start:t.files[0][1],line_end:t.files[0][1],text:'// synthetic excerpt'}]})]));
const providerRequest=(agent,e)=>buildRequest(agent,e,tasks[agent]);
const answer=agent=>JSON.stringify({verdict:'approve',summary:'Static review only',findings:[],unverified:['No execution performed'],...(agent==='Gemini'?{executive_summary_he:'בדיקת קוד בלבד; לא הורצו בדיקות.'}:{})});
function fixture(){
 const events=[],calls=[],reservations=[],dispatches=[];
 return {events,calls,reservations,dispatches,args:{env,tasks,capabilities:{atomicGrant:true,maxCycleMicroUsd:750000,maxReservations:3,providerMicroUsd:250000,taskAllowlist:true},
  connect:async({agent,budget})=>budget?{}:{emit:async(kind,step,task)=>events.push({agent,kind,step,task})},
  budgetFactory:()=>({reserveRequest:async input=>{reservations.push(input);return {...input,dispatch:true};},assertDispatch:p=>{dispatches.push(p.id);return true;}}),
  fetcher:async(url,init)=>{calls.push({url,init});assert.equal(dispatches.length,calls.length);return new Response(JSON.stringify(url.includes('anthropic')?{content:[{type:'text',text:answer('Claude')}]}:url.includes('x.ai')?{output:[{type:'message',content:[{type:'output_text',text:answer('Grok')}]}]}:{candidates:[{content:{parts:[{text:answer('Gemini')}]}}]}));}}};
}

test('live entry point remains disabled even with simulated capabilities',async()=>{
 const x=fixture();await assert.rejects(liveCycle(x.args),{message:ACTIVATION_STATE});assert.equal(x.events.length,0);assert.equal(x.calls.length,0);
 for(const patch of [{atomicGrant:false},{maxCycleMicroUsd:750001},{maxReservations:4},{providerMicroUsd:250001},{taskAllowlist:false}]){
  const y=fixture();Object.assign(y.args.capabilities,patch);await assert.rejects(runCycle(y.args),{message:ACTIVATION_STATE});assert.equal(y.events.length,0);
 }
});
test('budget denial/replay/false/Promise/wrong permits never emit provider running',async()=>{
 for(const mode of ['deny','replay','false','promise','rejected-promise','wrong']){
  const x=fixture();x.args.budgetFactory=()=>({reserveRequest:async input=>{if(mode==='deny')throw Error('denied');return {...input,dispatch:mode!=='replay',...(mode==='wrong'?{id:'bad'}:{})};},assertDispatch:()=>mode==='rejected-promise'?Promise.reject(Error('secret')):mode==='promise'?Promise.resolve(true):mode!=='false'});
  assert.equal((await runCycle(x.args)).status,'partial');assert.equal(x.calls.length,0);
  const provider=x.events.filter(e=>e.agent!=='Codex');assert.equal(provider.length,3);assert.ok(provider.every(e=>e.kind==='task_failed'));
  await new Promise(resolve=>setImmediate(resolve)); // node:test fails on unhandled rejection.
 }
});
test('running exactly once immediately before fetch, with handled pending telemetry',async()=>{
 const x=fixture(),order=[];let release;const pending=new Promise(resolve=>{release=resolve;});
 x.args.budgetFactory=()=>({reserveRequest:async i=>({...i,dispatch:true}),assertDispatch:p=>{order.push(p.provider+':permit');return true;}});
 x.args.connect=async({agent,budget})=>budget?{}:{emit(kind,step,task){order.push(agent+':'+kind);x.events.push({agent,kind,step,task});return agent==='Claude'&&kind==='heartbeat'?pending:Promise.resolve();}};
 const original=x.args.fetcher;x.args.fetcher=async(url,init)=>{const a=url.includes('anthropic')?'Claude':url.includes('x.ai')?'Grok':'Gemini';order.push(a+':fetch');x.dispatches.push(a);return original(url,init);};
 const run=runCycle(x.args);await new Promise(resolve=>setImmediate(resolve));assert.ok(order.includes('Claude:fetch'));release();assert.equal((await run).status,'completed');
 for(const a of ['Claude','Grok','Gemini']){
  const i=order.indexOf(a+':permit');assert.deepEqual(order.slice(i,i+4),[a+':permit',a+':heartbeat',a+':task_started',a+':fetch']);
  for(const kind of ['heartbeat','task_started','task_completed'])assert.equal(x.events.filter(e=>e.agent===a&&e.kind===kind&&e.task===TASKS[a].label).length,1);
 }
});
test('telemetry rejection is handled immediately and never produces completion',async()=>{
 const x=fixture();x.args.connect=async({agent,budget})=>budget?{}:{emit(kind,step,task){x.events.push({agent,kind,step,task});return agent!=='Codex'&&kind==='heartbeat'?Promise.reject(Error('secret')):Promise.resolve();}};
 assert.equal((await runCycle(x.args)).status,'partial');assert.equal(x.calls.length,3);assert.equal(x.events.some(e=>e.kind==='task_completed'),false);
});
test('task input rejects secret, email, unknown source, range and byte overflow',()=>{
 const base={file:TASKS.Claude.files[0][0],line_start:1513,line_end:1513,text:'// synthetic'};
 for(const patch of [{file:'../private.env'},{line_start:0},{line_end:999999},{text:'Bearer synthetic-secret'},{text:'user@example.test'},{text:'const password="secret-long-value"'},{text:'x'.repeat(12001)},{text:'two\nlines'}])assert.throws(()=>buildTask('Claude',{sha:env.GITHUB_SHA,excerpts:[{...base,...patch}]}));
});
test('strict JSON result rejects invalid citations, extra fields and unsafe output',()=>{
 const task=tasks.Claude;
 const make=()=>({...JSON.parse(answer('Claude')),findings:[{severity:'medium',file:task.excerpts[0].file,line_start:1513,line_end:1513,evidence:'Observed boundary',risk:'Concurrent update',recommendation:'Add fence',test:'Proposed emulator assertion'}]});
 assert.equal(parseTaskResult(JSON.stringify(make()),task).findings.length,1);
 for(const mutate of [o=>o.extra=true,o=>o.summary='',o=>o.summary='tests passed',o=>o.summary='https://evil.test',o=>o.summary='<script>',o=>o.summary='user@example.test',o=>o.unverified=[],o=>o.findings[0].file='other.js',o=>o.findings[0].line_end=999999,o=>o.findings[0].severity='critical',o=>o.findings=Array(4).fill(o.findings[0])]){const o=make();mutate(o);assert.throws(()=>parseTaskResult(JSON.stringify(o),task));}
 for(const raw of ['','not JSON','x'.repeat(24001),'[]','null'])assert.throws(()=>parseTaskResult(raw,task));
 const gemini=JSON.parse(answer('Gemini'));gemini.executive_summary_he='English only';assert.throws(()=>parseTaskResult(JSON.stringify(gemini),tasks.Gemini));
});
test('three simulated provider calls require consumed permits and truthful lifecycle',async()=>{
 const x=fixture(),result=await runCycle(x.args);assert.equal(result.status,'completed');assert.equal(x.calls.length,3);assert.equal(x.reservations.length,3);
 for(const agent of ['Codex','Claude','Grok','Gemini'])assert.equal(x.events.filter(e=>e.agent===agent&&e.kind==='task_completed').length,1);
 assert.equal(new Set(x.reservations.map(r=>r.id)).size,3);
 for(const r of x.reservations){assert.equal(r.id,`${env.TELEMETRY_AUTHORIZATION_ID}_${r.provider}`);assert.equal(r.task,TASKS[r.provider].label);}
});

test('authorization is threaded intact into transport and budget before reservation',async()=>{
 const x=fixture(),factory=x.args.budgetFactory,connect=x.args.connect;let transportArgs,budgetArgs;
 x.args.connect=async args=>{if(args.budget)transportArgs=args;return connect(args);};
 x.args.budgetFactory=args=>{budgetArgs=args;return factory(args);};
 await runCycle(x.args);
 for(const a of [transportArgs,budgetArgs]){assert.equal(a.authorizationId,env.TELEMETRY_AUTHORIZATION_ID);assert.equal(a.principal,env.TELEMETRY_BUDGET_PRINCIPAL);assert.equal(a.approvedSha,env.GITHUB_SHA);}
 for(const patch of [{TELEMETRY_AUTHORIZATION_ID:''},{TELEMETRY_BUDGET_PRINCIPAL:'owner'}]){
  const f=fixture();f.args.env={...env,...patch};await assert.rejects(runCycle(f.args),/INVALID_BUDGET_AUTHORIZATION/);assert.equal(f.calls.length,0);
 }
});

test('12KB limit includes instruction text and provider JSON envelope before connection',async()=>{
 for(const agent of ['Claude','Grok','Gemini']){
  const t=TASKS[agent],task=buildTask(agent,{sha:env.GITHUB_SHA,excerpts:[{file:t.files[0][0],line_start:t.files[0][1],line_end:t.files[0][1],text:'x'.repeat(11500)}]});
  assert.throws(()=>buildRequest(agent,env,task),/TASK_REQUEST_LIMIT/);
  const x=fixture();x.args.tasks={...tasks,[agent]:task};let connected=0;x.args.connect=async()=>{connected++;};await assert.rejects(runCycle(x.args),/TASK_REQUEST_LIMIT/);assert.equal(connected,0);
 }
});
test('denied reservations make no paid request and never emit completion',async()=>{
 const x=fixture();x.args.budgetFactory=()=>({reserveRequest:async()=>{throw Error('CAP');},assertDispatch(){throw Error('not reached');}});
 assert.equal((await runCycle(x.args)).status,'partial');assert.equal(x.calls.length,0);assert.equal(x.events.some(e=>e.kind==='task_completed'),false);
});
test('expired permit makes no paid request',async()=>{
 const x=fixture();x.args.budgetFactory=()=>({reserveRequest:async()=>({}),assertDispatch(){throw Error('EXPIRED');}});
 assert.equal((await runCycle(x.args)).status,'partial');assert.equal(x.calls.length,0);
});
test('provider timeout and malformed answer never retry or claim completion',async()=>{
 for(const fetcher of [async()=>{throw Error('secret');},async()=>new Response('{}')]){
  const x=fixture();let count=0;x.args.fetcher=async(...a)=>{count++;return fetcher(...a);};
  assert.equal((await runCycle(x.args)).status,'partial');assert.equal(count,3);assert.equal(x.events.some(e=>e.kind==='task_completed'),false);
 }
});
test('wrong target, missing key and failed tests stop before credentials or requests',async()=>{
 for(const patch of [{GITHUB_REF:'refs/heads/main'},{TEST_RESULT:'failure'},{XAI_API_KEY:''},{TELEMETRY_APPROVED_SHA:'b'.repeat(40)}]){
  const x=fixture();x.args.env={...env,...patch};let connected=0;x.args.connect=async()=>{connected++;};
  await assert.rejects(runCycle(x.args));assert.equal(connected,0);assert.equal(x.calls.length,0);
 }
});
test('provider requests are bounded text-only and Grok uses total-output Responses cap',()=>{
 for(const agent of ['Claude','Grok','Gemini']){const r=providerRequest(agent,env),body=JSON.parse(r.body);assert.ok(Buffer.byteLength(r.body)<4000);assert.equal(body.tools,undefined);}
 const g=providerRequest('Grok',env);assert.equal(g.url,'https://api.x.ai/v1/responses');assert.equal(JSON.parse(g.body).max_output_tokens,1800);assert.equal(JSON.parse(g.body).store,false);
 assert.deepEqual(JSON.parse(providerRequest('Gemini',env).body).generationConfig,{maxOutputTokens:700,thinkingConfig:{thinkingLevel:'minimal'}});
 assert.equal(providerRequest('Gemini',env).model,'gemini-3.5-flash-lite');
});
test('legacy model migration cannot bypass the fixed task cycle',async()=>{
 const x=fixture();x.args.env={...env,AGENT_SCOPE:'gemini-model-migration',ANTHROPIC_API_KEY:'',XAI_API_KEY:''};
 await assert.rejects(runCycle(x.args),/INVALID_AGENT_SCOPE/);assert.equal(x.calls.length,0);assert.equal(x.reservations.length,0);
});
test('legacy diagnostic cannot mint a second set of operation IDs',async()=>{
 const x=fixture();x.args.env={...env,AGENT_SCOPE:'failed-provider-diagnostic',XAI_API_KEY:''};
 await assert.rejects(runCycle(x.args),/INVALID_AGENT_SCOPE/);assert.equal(x.calls.length,0);assert.equal(x.reservations.length,0);
});
test('provider classifications never expose bodies or secrets and never retry',async()=>{
 for(const [status,message,expected] of [[401,'secret','auth'],[403,'secret','permission'],[404,'secret','model'],[429,'slow','rate_limit'],[400,'Your credit balance is too low secret','credit_or_quota_hint'],[429,'quota secret','credit_or_quota_hint'],[500,'secret','provider_failure'],[400,'bad secret','invalid_request']]){
  let calls=0;await assert.rejects(requestProvider(async()=>{calls++;return new Response(JSON.stringify({error:{message}}),{status});},providerRequest('Claude',env)),e=>{assert.equal(e.category,expected);assert.equal(e.http,status);assert.ok(!JSON.stringify(e).includes('secret'));return true;});assert.equal(calls,1);
 }
 for(const body of ['not json secret','x'.repeat(32769),'{"error":null}'])await assert.rejects(requestProvider(async()=>new Response(body,{status:400}),providerRequest('Claude',env)),e=>e.category==='unknown');
});
test('focused diagnostic preserves unknown reservations and preflight failure boundaries',async()=>{
 for(const mode of ['budget','transport','empty','stream']){
  const x=fixture();let calls=0;
  if(mode==='budget')x.args.budgetFactory=()=>({reserveRequest:async()=>{throw Error('secret');}});
  x.args.fetcher=async()=>{calls++;if(mode==='transport')throw Error('secret');if(mode==='stream')return new Response(new ReadableStream({start(c){c.error(Error('secret'));}}));return new Response('{}');};
  const r=await runCycle(x.args);assert.equal(r.status,'partial');assert.equal(calls,mode==='budget'?0:3);assert.ok(!JSON.stringify(r).includes('secret'));assert.ok(r.results.every(v=>v.stage===(mode==='budget'?'budget':'provider')));
 }
 const x=fixture();x.args.env={...env,AGENT_SCOPE:'failed-provider-diagnostic',GEMINI_API_KEY:''};await assert.rejects(runCycle(x.args));assert.equal(x.calls.length,0);
});
