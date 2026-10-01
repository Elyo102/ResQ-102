'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./index.js'),'utf8');
const start=source.indexOf('exports.onSwapChange = onDocumentWritten(');
const end=source.indexOf('exports.onReportChange = onDocumentWritten(',start);
assert.ok(start>=0&&end>start,'exact deployed swap handler must be present');
const stamp=(n,nanos=0)=>({seconds:n,nanoseconds:nanos,isEqual(other){return !!other&&other.seconds===n&&other.nanoseconds===nanos;}});
function harness({change=false,changeStatus='cancelled',readFailure=false,breaks=true,missingVersion=false,transactionFailure=false,currentMissing=false,currentNanoseconds=0}={}){
  let version=1,record={status:'approved',from_uid:'a',to_uid:'b',from_date:'2026-10-01',to_date:'2026-10-04'},writes=0,pushes=0;
  const snapshot=()=>({exists:!currentMissing,data:()=>({...record}),updateTime:stamp(version,currentNanoseconds)});
  const ref={async set(patch){record={...record,...patch};version++;writes++;}};
  const db={doc(path){assert.equal(path,'stations/synthetic/swaps/swap');return ref;},collection(){return {where(){return {async get(){return {forEach(){}};}};}};},async runTransaction(fn){if(transactionFailure)throw Error('synthetic-transaction-unavailable');let staged;const result=await fn({async get(r){assert.equal(r,ref);return snapshot();},update(r,patch){assert.equal(r,ref);staged=patch;}});if(staged){await ref.set(staged);}return result;}};
  const sandbox={exports:{},onDocumentWritten:(path,fn)=>fn,db,async writeShiftLog(){},swapSystemText:()=>'',swapScheduleRange:()=>({from:'2026-10-01',to:'2026-10-04'}),async loadEffectiveSchedule(){if(change){record={...record,status:changeStatus,newer:true};version++;}if(readFailure)throw Error('synthetic-read-failure');return {};},restBreaks:()=>breaks?[{who:'synthetic',gain:'2026-10-01',clash:'2026-10-02'}]:[],async pushToUsers(){pushes++;},dmyS:x=>x,console:{warn(){},error(){}},Date};
  vm.runInNewContext(source.slice(start,end),sandbox);
  const event={params:{sid:'synthetic',swapId:'swap'},data:{before:{exists:true,data:()=>({status:'cmd_to'})},after:{exists:true,data:()=>({status:'approved',from_uid:'a',to_uid:'b',from_date:'2026-10-01',to_date:'2026-10-04'}),updateTime:missingVersion?undefined:stamp(1)}}};
  return {run:()=>sandbox.exports.onSwapChange(event),state:()=>({record,writes,pushes})};
}
for(const readFailure of [false,true])test(`stale approved event cannot overwrite newer state after ${readFailure?'failed':'successful'} dependency read`,async()=>{
  const h=harness({change:true,readFailure});await h.run();assert.equal(h.state().record.status,'cancelled');assert.equal(h.state().writes,0);assert.equal(h.state().pushes,0);
});
for(const readFailure of [false,true])test(`current approved event applies ${readFailure?'pending':'rejection'} once across duplicate trigger`,async()=>{
  const h=harness({readFailure});await h.run();await h.run();assert.equal(h.state().record.status,readFailure?'cmd_to':'rejected');assert.equal(h.state().writes,1);assert.equal(h.state().pushes,1);
});
test('missing event version cannot authorize a corrective source write',async()=>{
  const h=harness({missingVersion:true});await h.run();assert.equal(h.state().record.status,'approved');assert.equal(h.state().writes,0);assert.equal(h.state().pushes,0);
});
test('same status with newer document version is not the original approval',async()=>{
  const h=harness({change:true,changeStatus:'approved'});await h.run();assert.equal(h.state().record.newer,true);assert.equal(h.state().record.status,'approved');assert.equal(h.state().writes,0);assert.equal(h.state().pushes,0);
});
for(const readFailure of [false,true])test(`transaction infrastructure failure propagates on ${readFailure?'pending':'rejection'} correction`,async()=>{
  const h=harness({readFailure,transactionFailure:true});await assert.rejects(h.run(),/synthetic-transaction-unavailable/);assert.equal(h.state().writes,0);assert.equal(h.state().pushes,0);assert.equal(h.state().record.status,'approved');
});

test('deleted current document cannot be resurrected by old approval',async()=>{
  const h=harness({currentMissing:true});await h.run();assert.equal(h.state().writes,0);assert.equal(h.state().pushes,0);
});
test('same seconds with different nanoseconds is a different approval version',async()=>{
  const h=harness({currentNanoseconds:1});await h.run();assert.equal(h.state().writes,0);assert.equal(h.state().pushes,0);
});
