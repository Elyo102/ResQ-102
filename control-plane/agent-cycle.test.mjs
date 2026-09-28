import test from 'node:test';
import assert from 'node:assert/strict';
import {runCycle,providerRequest} from './agent-cycle.mjs';
const env={GITHUB_REPOSITORY:'Elyo102/ResQ-102',GITHUB_REF:'refs/heads/dev',GITHUB_SHA:'a'.repeat(40),TELEMETRY_APPROVED_SHA:'a'.repeat(40),GITHUB_EVENT_NAME:'push',TEST_RESULT:'success',ANTHROPIC_API_KEY:'synthetic',XAI_API_KEY:'synthetic',GEMINI_API_KEY:'synthetic'};
function fixture(){
 const events=[],calls=[],reservations=[],dispatches=[];
 return {events,calls,reservations,dispatches,args:{env,
  connect:async({agent,budget})=>budget?{}:{emit:async(kind,step)=>events.push({agent,kind,step})},
  budgetFactory:()=>({reserveRequest:async input=>{reservations.push(input);return input;},assertDispatch:p=>dispatches.push(p.id)}),
  fetcher:async(url,init)=>{calls.push({url,init});assert.equal(dispatches.length,calls.length);return new Response(JSON.stringify(url.includes('anthropic')?{content:[{type:'text',text:'review'}]}:url.includes('x.ai')?{output:[{type:'message',content:[{type:'output_text',text:'review'}]}]}:{candidates:[{content:{parts:[{text:'review'}]}}]}));}}};
}
test('three actual paid calls require three consumed permits and truthful four-agent lifecycle',async()=>{
 const x=fixture(),result=await runCycle(x.args);assert.equal(result.status,'completed');assert.equal(x.calls.length,3);assert.equal(x.reservations.length,3);
 for(const agent of ['Codex','Claude','Grok','Gemini'])assert.equal(x.events.filter(e=>e.agent===agent&&e.kind==='task_completed').length,1);
 assert.equal(new Set(x.reservations.map(r=>r.id)).size,3);
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
 const g=providerRequest('Grok',env);assert.equal(g.url,'https://api.x.ai/v1/responses');assert.equal(JSON.parse(g.body).max_output_tokens,2200);assert.equal(JSON.parse(g.body).store,false);
 assert.equal(JSON.parse(providerRequest('Gemini',env).body).generationConfig.thinkingConfig.thinkingBudget,0);
});
