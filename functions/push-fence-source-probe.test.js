'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'functions/index.js'),'utf8');
const {createStationDeliveryFence}=require(path.join(root,'functions/station-delivery-fence'));
const defs=source.slice(source.indexOf('const PUSH_SUPPRESSION_REASONS'),source.indexOf('const FV =',source.indexOf('const PUSH_SUPPRESSION_REASONS')));
const body=source.slice(source.indexOf('const PUSH_CONCURRENCY'),source.indexOf('async function uidsInCrew'));
assert(body.includes('stationDeliveryFence.check'), 'actual final fence must have landed');
function setup(options={}){
 const state={provider:0,tokenReads:0,stationReads:0,global:{silent:false},station:{active:true,silent:false}};
 Object.assign(state,options.state||{});
 const db={doc(p){return{async get(){if(p.includes('/push_tokens/')){state.tokenReads++;if(options.afterToken)options.afterToken(state);return{exists:true,data:()=>({tokens:[{token:p.split('/').pop()}]})};}state.stationReads++;if(options.stationError)throw Error('read failed');return{exists:true,data:()=>state.station};},async set(){}};}};
 const context={console,Set,db,FV:{serverTimestamp:()=>1},stationDeliveryFence:createStationDeliveryFence({db}),
  silentFor:async uid=>options.earlySilent===true,logSilenced:async()=>{},allowedByRuntime:async(r,uid)=>r.allowed===uid,
  runtimeFresh:async()=>{if(options.globalError)throw Error('global failed');return state.global;},
  admin:{messaging:()=>({sendEachForMulticast:async({tokens})=>{state.provider++;return{responses:tokens.map(token=>options.partial?{success:false,error:{code:'internal'}}:{success:true})};}})}};
 vm.createContext(context);vm.runInContext(defs+'\n'+body+'\nthis.push=pushToOne;this.group=pushToUsers;',context);
 return {state,context,push:()=>context.push('station_1','person_1','callout','test','mock','/',true,undefined,options.snapshot)};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await test('ready station reaches mocked provider',async()=>{const f=setup();assert.equal((await f.push()).sent,1);assert.equal(f.state.provider,1);assert.equal(f.state.stationReads,1);});
 await test('early global suppression remains explicit',async()=>{const f=setup({earlySilent:true});const r=await f.push();assert.equal(r.suppressed,true);assert.equal(f.state.provider,0);});
 await test('global flips during token read prevents send',async()=>{const f=setup({afterToken:s=>s.global={silent:true}});assert.equal((await f.push()).reason,'global-silence');assert.equal(f.state.provider,0);});
 await test('station flips during token read prevents send',async()=>{const f=setup({afterToken:s=>s.station.silent=true});assert.equal((await f.push()).reason,'station-silence');assert.equal(f.state.provider,0);});
 await test('station silence overrides global owner allowance',async()=>{const f=setup({state:{global:{silent:true,allowed:'person_1'},station:{active:true,silent:true}}});assert.equal((await f.push()).reason,'station-silence');assert.equal(f.state.provider,0);});
 await test('station read failure remains retryable failure',async()=>{const f=setup({stationError:true});const r=await f.push();assert.equal(r.failed,true);assert.equal(r.suppressed,undefined);assert.equal(f.state.provider,0);});
 await test('global read failure remains retryable failure',async()=>{const f=setup({globalError:true});const r=await f.push();assert.equal(r.failed,true);assert.equal(r.suppressed,undefined);assert.equal(f.state.provider,0);});
 await test('stricter original snapshot cannot be bypassed',async()=>{const f=setup({snapshot:{silent:true}});assert.equal((await f.push()).suppressed,true);assert.equal(f.state.provider,0);});
 await test('aggregate counts suppression separately',async()=>{const f=setup({state:{global:{silent:true,allowed:'owner'}}});const r=await f.context.group('station_1',['owner','other'],'callout','mock','mock','/',true);assert.equal(r.people,1);assert.equal(r.devices,1);assert.equal(r.failed,0);assert.equal(r.suppressed,1);assert.equal(r.suppressed_uids[0],'other');});
 await test('provider error retains failed recipient',async()=>{const f=setup({partial:true});const r=await f.context.group('station_1',['person_1'],'callout','mock','mock','/',true);assert.equal(r.failed,1);assert.equal(r.suppressed,0);assert.equal(r.people,0);});
 console.log(passed+' PASS; extracted actual index functions + real fence; mock DB/provider only');
})().catch(e=>{console.error(e);process.exitCode=1;});
