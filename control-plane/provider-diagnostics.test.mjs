import test from 'node:test';import assert from 'node:assert/strict';
import {diagnoseProviders} from './provider-diagnostics.mjs';import {MODELS} from './agent-cycle.mjs';
const env={ANTHROPIC_API_KEY:'synthetic-secret',GEMINI_API_KEY:'synthetic-secret'};
test('diagnostic makes only exact two GETs and prints no response or secrets',async()=>{
 const calls=[];const result=await diagnoseProviders(env,async(url,init)=>{calls.push(url);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  return new Response(JSON.stringify(url.includes('anthropic')?{id:MODELS.Claude,secret:'synthetic-secret'}:{name:'models/'+MODELS.Gemini,secret:'synthetic-secret'}));});
 assert.equal(calls.length,2);assert.deepEqual(result.map(r=>r.modelAvailable),[true,true]);assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
});
test('HTTP failures, unknown bodies and transport failures stay distinct and sanitized',async()=>{
 for(const status of [400,401,403,404,429,500]){const results=await diagnoseProviders(env,async()=>new Response('sensitive',{status}));assert.ok(results.every(r=>r.status===status&&r.modelAvailable===null));}
 for(const fetcher of [async()=>{throw Error('synthetic-secret');},async()=>new Response('x'.repeat(262145)),async()=>new Response('not-json')]){
  const results=await diagnoseProviders(env,fetcher);assert.ok(results.every(r=>r.status==='transport_or_response_unknown'));assert.equal(JSON.stringify(results).includes('synthetic-secret'),false);
 }
});
