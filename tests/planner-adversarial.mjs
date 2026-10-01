import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
const require=createRequire(import.meta.url);
assert.equal(Number(process.versions.node.split('.')[0]),22);
const source=fs.readFileSync(new URL('../functions/schedule-calendar-engine.js',import.meta.url),'utf8');
const baseline=require('../functions/schedule-calendar-engine.js');
const loop='for (const person of candidates[demandIndex]) {';
const entry='function augment(demandIndex, seenPeople, seenDemands) {';
const exit='      for (let i = 0; i < demands.length; i += 1) {';
assert.equal(source.split(loop).length-1,2,'instrument both matching loops exactly');
assert.equal(source.split(entry).length-1,1,'unique matching function');
assert.equal(source.split(exit).length-1,2,'matching and output loops are distinct');
const begin=source.indexOf(entry),end=source.indexOf(exit,begin);
const body=source.slice(begin,end);
assert.ok(body.endsWith('      }\n') || body.endsWith('      }\r\n'));
const instrumented=source.slice(0,begin)+body
  .replace(entry,entry+' __metrics.calls++; __metrics.depth++; __metrics.maxDepth=Math.max(__metrics.maxDepth,__metrics.depth); try {')
  .replaceAll(loop,loop+' __metrics.visits++;')
  .replace(/      }\r?\n$/, '        } finally { __metrics.depth--; }\n      }\n')+source.slice(end);
function counted(){
  const metrics={calls:0,visits:0,depth:0,maxDepth:0},sandbox={module:{exports:{}},__metrics:metrics};
  vm.runInNewContext(instrumented,sandbox,{timeout:1000});
  return {engine:sandbox.module.exports.createCalendarEngine,metrics};
}
const clock=()=> '2026-10-01T00:00:00.000Z',sid='planner-synthetic';
function fixture(roleSets,{count=1,days=1,load={},unavailable={}}={}){
  const roles=[...new Set(roleSets.flat())].sort();
  const policy={station_id:sid,version:'v1',digest:'policy',
    sub_stations:{main:{label:'Synthetic',minimum:roles.length*count,
      requirements:roles.map(role=>({role,label:role,count,required:true}))}},
    rest:{min_gap_days:0},rotation:null,max_shifts_per_month:null};
  const input={station_id:sid,source_snapshot:'snapshot',source_version:'v1',
    contract_station_id:sid,source_revision:'r1',source_digest:'source',policy_digest:'policy',source_complete:true,
    availability:unavailable,locked:{},carry:{load,lastDay:{},byRole:{}},
    days:Array.from({length:days},(_,i)=>'2026-09-'+String(i+1).padStart(2,'0')),
    roster:roleSets.map((set,i)=>({id:'p'+String(i).padStart(4,'0'),station_id:sid,sub_station:'main',active:true,
      roles:set,source_snapshot:'snapshot',source_version:'v1',contract_station_id:sid,
      source_revision:'r1',source_digest:'source',source_complete:true}))};
  return {policy,input,roles};
}
function run(f){
  const original=JSON.stringify(f.input),instrument=counted();
  const expected=baseline.createCalendarEngine({clock,policy:f.policy}).planPeriod(f.input);
  const heap=process.memoryUsage().heapUsed,t0=performance.now();
  const actual=instrument.engine({clock,policy:f.policy}).planPeriod(f.input);
  const elapsedMs=Math.round(performance.now()-t0),heapDeltaBytes=process.memoryUsage().heapUsed-heap;
  assert.equal(JSON.stringify(actual),JSON.stringify(expected),'instrumentation must preserve complete output');
  assert.equal(JSON.stringify(f.input),original,'input unchanged');
  assert.equal(instrument.metrics.depth,0,'all recursive paths unwind');
  return {result:expected,metrics:instrument.metrics,elapsedMs,heapDeltaBytes};
}
// Exhaustive assignment enumeration independent of the engine's augment solver.
function maximum(roleSets,roles){
  const memo=new Map();
  function visit(index,mask){
    if(index===roles.length)return 0;
    const key=index+':'+mask;if(memo.has(key))return memo.get(key);
    let best=visit(index+1,mask);
    for(let person=0;person<roleSets.length;person++){
      if(!(mask&(1<<person)) && roleSets[person].includes(roles[index]))
        best=Math.max(best,1+visit(index+1,mask|(1<<person)));
    }
    memo.set(key,best);return best;
  }
  return visit(0,0);
}
let seed=1701,totalVisits=0,totalCalls=0;
for(let i=0;i<32;i++){
  const sets=Array.from({length:6},()=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const mask=(seed>>>8)&63;
    return Array.from({length:6},(_,r)=>r).filter(r=>(mask||1)&(1<<r)).map(r=>'r'+r);
  });
  const f=fixture(sets),out=run(f),slots=out.result.rows[0].slots;
  assert.equal(slots.length,maximum(sets,f.roles));
  assert.equal(new Set(slots.map(s=>s.person)).size,slots.length);
  for(const slot of slots)assert.ok(sets[Number(slot.person.slice(1))].includes(slot.role));
  totalVisits+=out.metrics.visits;totalCalls+=out.metrics.calls;
}
console.log(JSON.stringify({fixture:'32 independent small graphs',visits:totalVisits,augmentCalls:totalCalls}));
const chain=fixture([['r0','r1'],['r1','r2'],['r2','r3'],['r3','r4'],['r4','r5'],['r0'],['r5']],
  {load:{p0005:100},unavailable:{p0006:{'2026-09-01':true}}});
const chainRun=run(chain);
assert.equal(chainRun.result.summary.filled,6);
assert.ok(chainRun.metrics.maxDepth>=6,'fixture must force a six-demand augmenting chain');
const mutant={module:{exports:{}}};
vm.runInNewContext(source.replace('if (augment(current, seenPeople, seenDemands)) {','if (false) {'),mutant,{timeout:1000});
assert.ok(mutant.module.exports.createCalendarEngine({clock,policy:chain.policy}).planPeriod(chain.input).summary.filled<6);
console.log(JSON.stringify({fixture:'six-demand augment chain',...chainRun.metrics}));
const large=run(fixture(Array.from({length:3000},()=>['firefighter']),{count:500,days:30}));
assert.equal(large.result.summary.filled,15000);assert.equal(large.result.summary.blocking_gaps,0);
console.log(JSON.stringify({fixture:'3000 people, 500 slots, 30 days',preflightEdgeUpperBound:45000000,
  instrumentedElapsedMs:large.elapsedMs,heapDeltaBytes:large.heapDeltaBytes,...large.metrics}));
console.log('PASS planner adversarial parity/oracle/measurement; local heap delta is not peak or production SLO.');
