import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMutationOutcome, parseAssertionId } from './lib/mutation-outcome.mjs';
const suite='synthetic-suite';
const id=(n='test',hash='a'.repeat(64),op='strictEqual')=>JSON.stringify([suite,hash,op,n]);
const first=id(),second=id('second'),other=id('unrelated');
const expected={suite,allowed:[first],required:[first]};
const events=(ids)=>[{type:'module-loaded',suite},{type:'suite-start',suite},
  ...ids.map(id=>({type:'assertion-failure',suite,id,code:'ERR_ASSERTION',detail:JSON.parse(id)[2]})),
  {type:'suite-end',suite,failed:ids.length}];
const killed=()=>({status:1,signal:null,error:null,stderr:'',events:events([first])});
const kind=input=>classifyMutationOutcome(input,expected).kind;
test('genuine approved site is killed and result immutable',()=>{
  assert.equal(kind(killed()),'KILLED'); assert.ok(Object.isFrozen(classifyMutationOutcome(killed(),expected)));
});
test('passing suite survives; baseline with empty allowed cannot kill',()=>{
  assert.equal(kind({status:0,events:events([])}),'SURVIVED');
  assert.equal(classifyMutationOutcome({status:0,events:events([])},{suite,allowed:[],required:[]}).kind,'SURVIVED');
  assert.equal(classifyMutationOutcome(killed(),{suite,allowed:[],required:[]}).kind,'HARNESS_ERROR');
});
test('invalid mutant is pre-execution only',()=>{
  assert.equal(kind({status:null,events:[],invalidMutant:{code:'SYNTAX'}}),'INVALID_MUTANT');
  assert.equal(kind({...killed(),invalidMutant:{code:'SYNTAX'}}),'HARNESS_ERROR');
});
for(const [name,input] of Object.entries({
 syntax:{status:1,stderr:'SyntaxError',events:[]},missingModule:{status:1,stderr:'MODULE_NOT_FOUND',events:[]},
 explicitExit:{status:1,events:[]},exitAfterStart:{status:1,events:events([]).slice(0,2)},
 exitAfterPassingSuite:{status:1,events:events([])},timeout:{...killed(),error:{code:'ETIMEDOUT'}},
 signal:{...killed(),signal:'SIGTERM'},spawn:{...killed(),error:{code:'ENOENT'}},
 cleanup:{...killed(),cleanupError:'failed'},unrelatedFailure:{...killed(),events:events([other])},
 extraFailure:{...killed(),events:events([first,other])},duplicate:{...killed(),events:events([first,first])},
 noStart:{...killed(),events:events([first]).filter(e=>e.type!=='suite-start')},
 noLoad:{...killed(),events:events([first]).slice(1)},noEnd:{...killed(),events:events([first]).slice(0,-1)},
 reverse:{...killed(),events:events([first]).reverse()},wrongSuite:{...killed(),events:events([first]).map(e=>({...e,suite:'other'}))},
 wrongCount:{...killed(),events:[...events([first]).slice(0,-1),{type:'suite-end',suite,failed:2}]},
 passWithFailure:{...killed(),status:0},stderr:{...killed(),stderr:'unexpected'},adapter:{...killed(),adapterError:'bad output'},
 exitTwo:{...killed(),status:2},
}))test('not killed: '+name,()=>assert.equal(kind(input),'HARNESS_ERROR'));
test('exact approved multiple sites permitted, required sites cannot disappear',()=>{
 const contract={suite,allowed:[first,second],required:[first]};
 assert.equal(classifyMutationOutcome({...killed(),events:events([second,first])},contract).kind,'KILLED');
 assert.equal(classifyMutationOutcome(killed(),contract).kind,'KILLED');
 assert.equal(classifyMutationOutcome({...killed(),events:events([second])},contract).kind,'HARNESS_ERROR');
 assert.equal(classifyMutationOutcome({...killed(),events:events([first,second,other])},contract).kind,'HARNESS_ERROR');
});
test('same message or operator at wrong site is unrelated',()=>{
 assert.equal(kind({...killed(),events:events([id('test','b'.repeat(64))])}),'HARNESS_ERROR');
});
test('code and detail must match genuine assertion site protocol',()=>{
 for(const patch of [{code:'ENOENT'},{detail:'different'},{id:'malformed'}]){
  const e=events([first]);e[2]={...e[2],...patch};assert.equal(kind({...killed(),events:e}),'HARNESS_ERROR');
 }
});
test('malformed expectations reject, including duplicate and noncanonical IDs',()=>{
 for(const contract of [null,{}, {...expected,allowed:[first,first]}, {...expected,required:[other]},
  {...expected,allowed:['bad']},{...expected,extra:true}]){
  assert.equal(classifyMutationOutcome(killed(),contract).kind,'HARNESS_ERROR');
 }
 assert.equal(parseAssertionId(first+' ',suite),null);
 assert.equal(parseAssertionId(id('test','a'.repeat(64)+'\n'),suite),null);
 assert.equal(parseAssertionId(id('test','a'.repeat(64),'strictEqual\u2028'),suite),null);
});
