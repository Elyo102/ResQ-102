import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { classifyMutationOutcome } from './lib/mutation-outcome.mjs';
const require=createRequire(import.meta.url);
const {createMutationReporter,observeAssertion,mapAssertionObservation,bindAssertionSite,PREFIX}=require('./lib/mutation-reporter.cjs');
const suite='functions/schedule-calendar-engine.test.js',nonce='a'.repeat(64);
const filename=path.resolve('synthetic-suite.js');
const source="const x=1;\nassert.strictEqual(x,2);\n";
const site={hash:'b'.repeat(64),operator:'strictEqual',line:2,column:0,endLine:2,endColumn:23};
const index={schema:1,suites:{[suite]:{sourceHash:crypto.createHash('sha256').update(source).digest('hex'),sites:[site]}}};
const context={suite,source,index,filename};
function errorAt(line=2,column=1){
 const error=new assert.AssertionError({actual:1,expected:2,operator:'strictEqual',message:'SAME_DYNAMIC_MESSAGE secret=not-emitted'});
 error.stack='AssertionError\n    at fixture ('+filename+':'+line+':'+column+')\n    at caller ('+filename+':8:1)';
 return error;
}
function capture(env,fn){
 const names=['RESQ_MUTATION_SUITE','RESQ_MUTATION_NONCE'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 const write=process.stdout.write,lines=[];
 try{
  for(const n of names)if(env[n]===undefined)delete process.env[n];else process.env[n]=env[n];
  process.stdout.write=chunk=>{lines.push(String(chunk));return true;};fn();return lines;
 }finally{
  process.stdout.write=write;
  for(const n of names)if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];
 }
}
test('disabled reporter is silent and does not require index',()=>{
 assert.deepEqual(capture({},()=>{const r=createMutationReporter(suite);r.failure('name',Error('private'));r.end(1);}),[]);
});
test('genuine assertion resolves to stable exact AST site and never raw message',()=>{
 const event=bindAssertionSite(errorAt(),context,'existing test # name');
 assert.deepEqual(event,{type:'assertion-failure',suite,id:JSON.stringify([suite,site.hash,'strictEqual','existing test # name']),code:'ERR_ASSERTION',detail:'strictEqual'});
 assert.ok(!JSON.stringify(event).includes('not-emitted'));
 const events=[{type:'module-loaded',suite},{type:'suite-start',suite},{suite,...event},{type:'suite-end',suite,failed:1}];
 assert.equal(classifyMutationOutcome({status:1,events},{suite,allowed:[event.id],required:[event.id]}).kind,'KILLED');
});
test('LF normalized source identity accepts CRLF',()=>{
 assert.equal(bindAssertionSite(errorAt(),{...context,source:source.replace(/\n/g,'\r\n')},'test').type,'assertion-failure');
});
test('source line drift invalidates index before resolving stack',()=>{
 assert.equal(bindAssertionSite(errorAt(3),{...context,source:'\n'+source},'test').type,'harness-error');
});
test('same error message at different assertion site cannot match approved ID',()=>{
 const second={...site,hash:'c'.repeat(64),line:3,endLine:3};
 const ctx={...context,index:{schema:1,suites:{[suite]:{...index.suites[suite],sites:[site,second]}}}};
 const first=bindAssertionSite(errorAt(),ctx,'test'),other=bindAssertionSite(errorAt(3),ctx,'test');
 assert.notEqual(first.id,other.id);
 const events=[{type:'module-loaded',suite},{type:'suite-start',suite},{suite,...other},{type:'suite-end',suite,failed:1}];
 assert.equal(classifyMutationOutcome({status:1,events},{suite,allowed:[first.id],required:[first.id]}).kind,'HARNESS_ERROR');
});
test('first exact-suite frame must resolve; later good frame cannot rescue wrong site',()=>{
 const e=errorAt(99);e.stack+='\n    at later ('+filename+':2:1)';
 assert.equal(bindAssertionSite(e,context,'test').type,'harness-error');
});
test('file URL stack frame resolves to exact suite file',()=>{
 const e=errorAt();e.stack='AssertionError\n    at '+pathToFileURL(filename).href+':2:1';
 assert.equal(bindAssertionSite(e,context,'test').type,'assertion-failure');
});
test('overlapping or malformed indexed sites fail closed',()=>{
 for(const sites of [[site,site],[{...site,column:-1}],[{...site,hash:'bad'}],[{...site,endColumn:0}]]){
  const ctx={...context,index:{schema:1,suites:{[suite]:{...index.suites[suite],sites}}}};
  assert.equal(bindAssertionSite(errorAt(),ctx,'test').type,'harness-error');
 }
});
test('malformed, missing, foreign or oversized stack cannot authorize failure',()=>{
 for(const stack of [undefined,'bad','AssertionError\n at other.js:2:1','x'.repeat(65537)]){
  const e=errorAt();e.stack=stack;assert.equal(bindAssertionSite(e,context,'test').type,'harness-error');
 }
});
test('plain Error with forged code never counts as genuine assertion',()=>{
 assert.deepEqual(bindAssertionSite(Object.assign(Error('private'),{code:'ERR_ASSERTION'}),context,'test'),
  {type:'harness-error',code:'NON_ASSERTION_FAILURE'});
});
test('configuration rejects partial, unknown or malformed mode before output',()=>{
 for(const env of [{RESQ_MUTATION_SUITE:suite},{RESQ_MUTATION_NONCE:nonce},
  {RESQ_MUTATION_SUITE:'other',RESQ_MUTATION_NONCE:nonce},{RESQ_MUTATION_SUITE:suite,RESQ_MUTATION_NONCE:nonce+'\n'}]){
  assert.deepEqual(capture(env,()=>assert.throws(()=>createMutationReporter(suite),/CONFIGURATION/)),[]);
 }
});
test('live reporter emits nonce-bound completed baseline without any file reads',()=>{
 const read=fs.readFileSync,open=fs.openSync;
 let lines;
 try{
 fs.readFileSync=fs.openSync=()=>{throw Error('FORBIDDEN_CHILD_READ');};
 lines=capture({RESQ_MUTATION_SUITE:suite,RESQ_MUTATION_NONCE:nonce},()=>{
  const r=createMutationReporter(suite);assert.throws(()=>r.end(1),/END_COUNT/);r.end(0);
  assert.throws(()=>r.end(0),/END_COUNT/);
 });
 }finally{fs.readFileSync=read;fs.openSync=open;}
 const events=lines.map(line=>{
  assert.ok(line.startsWith(PREFIX));const value=JSON.parse(line.slice(PREFIX.length));
  assert.equal(value.nonce,nonce);const {nonce:ignored,...event}=value;return event;
 });
 assert.equal(classifyMutationOutcome({status:0,events},{suite,allowed:[],required:[]}).kind,'SURVIVED');
});
test('raw child observation contains no stack, path, message or index ID',()=>{
 const raw=observeAssertion(errorAt(),suite,filename,'test');
 assert.deepEqual(raw,{type:'assertion-observation',suite,testName:'test',code:'ERR_ASSERTION',operator:'strictEqual',line:2,column:0});
 for(const forbidden of [filename,'SAME_DYNAMIC_MESSAGE','not-emitted',site.hash])assert.ok(!JSON.stringify(raw).includes(forbidden));
 const events=[{type:'module-loaded',suite},{type:'suite-start',suite},raw,{type:'suite-end',suite,failed:1}];
 assert.equal(classifyMutationOutcome({status:1,events},{suite,allowed:[],required:[]}).kind,'HARNESS_ERROR');
});
test('only explicit tested Node assertion operator pairs map to static sites',()=>{
 const native=require('node:assert');
 const calls={assert:()=>native(false),ok:()=>native.ok(false),equal:()=>native.equal(1,2),notEqual:()=>native.notEqual(1,1),
  fail:()=>native.fail('expected'),strictEqual:()=>native.strictEqual(1,2),
  deepEqual:()=>native.deepEqual([1],[2]),deepStrictEqual:()=>native.deepStrictEqual([1],[2]),match:()=>native.match('a',/b/),
  doesNotThrow:()=>native.doesNotThrow(()=>{throw Error('expected');})};
 for(const [operator,call]of Object.entries(calls)){
  let error;try{call();}catch(e){error=e;}
  assert.ok(error instanceof native.AssertionError);
  error.stack=errorAt().stack;
  const ctx={...context,index:{schema:1,suites:{[suite]:{...index.suites[suite],sites:[{...site,operator}]}}}};
  const observation=observeAssertion(error,suite,filename,'test');
  assert.equal(mapAssertionObservation(observation,ctx).type,'assertion-failure',operator);
  assert.equal(mapAssertionObservation({...observation,operator:'unreviewed'},ctx).type,'harness-error');
 }
});
test('parent rejects malformed or extra raw observation fields',()=>{
 const raw=observeAssertion(errorAt(),suite,filename,'test');
 for(const patch of [{suite:'other'},{code:'ENOENT'},{line:0},{column:-1},{line:Infinity},{path:filename}])
  assert.equal(mapAssertionObservation({...raw,...patch},context).type,'harness-error');
});
