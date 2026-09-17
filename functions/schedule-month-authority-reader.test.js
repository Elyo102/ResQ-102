'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('./schedule-month-authority');
const {createMonthAuthorityReader}=require('./schedule-month-authority-reader');
function setup(){
  const owners={},snapshots=new Map(),calls=[];let generation=1,revoked=false,onSnapshot=()=>{},onFinal=async()=>{};
  const root=()=>({schema_version:1,station_id:'s1',generation,migrated:true,seed_publication_id:null,last_operation_id:'op'});
  const reader=createMonthAuthorityReader({authorityStore:{async read(sid,months){return {root:root(),owners:Object.fromEntries(months.map(m=>[m,owners[m]??null]))};}},
    async verifySnapshot({publication_id}){calls.push(publication_id);await onSnapshot();return snapshots.get(publication_id);},
    async verifyContext({phase,expected_context}){if(phase==='final'){await onFinal();assert.equal(expected_context,'context');}if(revoked)throw Error('viewer-revoked');return 'context';}});
  function add(id,from,to){const p={station_id:'s1',publication_id:id,revision:1,content_digest:C.hash(id),from,to,
    plan:{station_id:'s1',from,to,rows:[{policy:id,person:'external_'+id}],policy_digest:id},events:[],roster:[{id:'external_'+id}]};
    snapshots.set(id,p);Object.assign(owners,C.publicationOwners(p,'s1'));return p;}
  return {reader,owners,snapshots,calls,add,bump:()=>generation++,revoke:()=>{revoked=true;},onSnapshot:fn=>{onSnapshot=fn;},onFinal:fn=>{onFinal=fn;}};
}
test('different monthly signed plans stay separate and unavailable spans are explicit',async()=>{
  const f=setup();f.add('sep','2026-09-02','2026-09-03');f.add('oct','2026-10-01','2026-10-31');
  const read=await f.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-10-02'});
  assert.deepEqual(read.segments.map(s=>[s.from,s.to,s.available]),[
    ['2026-09-01','2026-09-01',false],['2026-09-02','2026-09-03',true],['2026-09-04','2026-09-30',false],['2026-10-01','2026-10-02',true]]);
  const projected=await f.reader.projectRange(read,async s=>s.snapshot.plan.policy_digest);
  assert.deepEqual(projected.segments.map(s=>s.value),[null,'sep',null,'oct']);
  assert.equal(read.segments[1].snapshot.roster[0].id,'external_sep');
  assert.throws(()=>{read.segments[1].snapshot.plan.rows.push({});},TypeError);
});
test('multi-month snapshot verified once and conflicting same-ID tuples refused',async()=>{
  const f=setup();f.add('annual','2026-09-01','2026-10-31');
  await f.reader.readRange({station_id:'s1',from:'2026-09-30',to:'2026-10-01'});assert.deepEqual(f.calls,['annual']);
  f.owners['2026-10'].revision=2;
  await assert.rejects(()=>f.reader.readRange({station_id:'s1',from:'2026-09-30',to:'2026-10-01'}),/reader-owner-mismatch/);
});
test('readRange awaits final authority and live context checks',async()=>{
  const f=setup();f.add('sep','2026-09-01','2026-09-30');f.onSnapshot(async()=>f.bump());
  await assert.rejects(()=>f.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-09-02'}),/authority-stale/);
  const g=setup();g.add('sep','2026-09-01','2026-09-30');let release;
  g.onFinal(()=>new Promise(resolve=>{release=resolve;}));let settled=false;
  const pending=g.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-09-02'}).then(()=>{settled=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);g.revoke();release();
  await assert.rejects(()=>pending,/viewer-revoked/);
});
test('projection cannot return after awaited work changes generation or live viewer',async()=>{
  for(const action of ['bump','revoke']){
    const f=setup();f.add('sep','2026-09-01','2026-09-30');const read=await f.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-09-02'});
    await assert.rejects(()=>f.reader.projectRange(read,async()=>{await Promise.resolve();f[action]();return 'stale';}),action==='bump'?/authority-stale/:/viewer-revoked/);
  }
});
test('missing months have no source fallback and forged handles fail',async()=>{
  const f=setup();const read=await f.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-10-01'});
  const result=await f.reader.projectRange(read,()=>{throw Error('must-not-project');});assert.ok(result.segments.every(s=>s.value===null));
  await assert.rejects(()=>f.reader.projectRange(structuredClone(read),()=>null),/reader-handle/);
});
test('owner and verified snapshot mutations fail closed',async()=>{
  for(const mutate of [f=>{f.owners['2026-09'].station_id='s2';},f=>{f.owners['2026-09'].coverage_to='2026-09-02';},
    f=>{f.snapshots.get('sep').plan.station_id='s2';},f=>{f.snapshots.get('sep').content_digest='a'.repeat(64);},f=>{f.snapshots.get('sep').roster=null;}]){
    const f=setup();f.add('sep','2026-09-01','2026-09-30');mutate(f);
    await assert.rejects(()=>f.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-09-02'}));
  }
});
test('publication during awaited final context lookup cannot return stale data',async()=>{
  const f=setup();f.add('sep','2026-09-01','2026-09-30');f.onFinal(async()=>{await Promise.resolve();f.bump();});
  await assert.rejects(()=>f.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-09-02'}),/authority-stale/);
  const g=setup();g.add('sep','2026-09-01','2026-09-30');
  const read=await g.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-09-02'});
  g.onFinal(async()=>{await Promise.resolve();g.bump();});
  await assert.rejects(()=>g.reader.projectRange(read,async()=>true),/authority-stale/);
});
test('unowned tombstone stays unavailable without consulting any old snapshot',async()=>{
  const f=setup();f.add('old','2026-09-01','2026-09-30');
  f.owners['2026-09']={schema_version:2,state:'unowned',station_id:'s1',month:'2026-09',activation_id:C.activationId('s1','rollback','undo','2026-09'),operation_id:'undo',operation_publication_id:'rollback_envelope'};
  const read=await f.reader.readRange({station_id:'s1',from:'2026-09-01',to:'2026-09-03'});
  assert.equal(read.segments[0].available,false);assert.equal(read.segments[0].snapshot,null);assert.deepEqual(f.calls,[]);
});
