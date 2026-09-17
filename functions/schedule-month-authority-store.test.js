'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createMonthAuthorityStore}=require('./schedule-month-authority-store');
const C=require('./schedule-month-authority');
function setup(){
  const docs=new Map(), snapshots=new Map(); let writes=0, abort=false;
  const clone=v=>v===undefined?undefined:structuredClone(v);
  const snap=path=>({exists:docs.has(path),data:()=>clone(docs.get(path))});
  const db={doc:path=>({path,get:async()=>snap(path)}),collection:path=>({limit:n=>({query:path,limit:n})}),async runTransaction(fn){
    const staged=[];let writing=false;
    const result=await fn({get:async ref=>{assert.equal(writing,false,'reads precede writes');
      if(ref.query){const found=[...docs.keys()].filter(p=>p.startsWith(ref.query+'/')).slice(0,ref.limit);return {empty:found.length===0,docs:found.map(snap)};}
      return snap(ref.path);},
      set:(ref,v)=>{writing=true;staged.push(['set',ref.path,clone(v)]);},
      update:(ref,v)=>{writing=true;assert.equal(docs.has(ref.path),true);staged.push(['set',ref.path,{...clone(docs.get(ref.path)),...clone(v)}]);},
      create:(ref,v)=>{writing=true;assert.equal(docs.has(ref.path),false);staged.push(['set',ref.path,clone(v)]);},
      delete:ref=>{writing=true;staged.push(['delete',ref.path]);}});
    if(abort)throw new Error('injected-abort');
    for(const [op,path,v]of staged){if(op==='delete')docs.delete(path);else docs.set(path,v);writes++;}
    return result;
  }};
  const prefix='stations/s1/';
  const store=createMonthAuthorityStore({db,verifySnapshot:async({publication_id})=>{
    const value=snapshots.get(publication_id);if(!value)throw new Error('verification-failed');return clone(value);
  }});
  function publication(id,from,to){const value={station_id:'s1',publication_id:id,revision:snapshots.size+1,content_digest:C.hash(id),from,to};
    snapshots.set(id,value);docs.set(prefix+'schedule_publications/'+id,{...value,status:'active',snapshot_complete:true});return value;}
  async function publish(p,op){const s=await store.read('s1',Object.keys(C.publicationOwners(p,'s1')));
    const input={station_id:'s1',operation_id:op,publication_id:p.publication_id,expected_generation:s.root.generation,expected_owners:s.owners};
    return {input,receipt:await store.publish(input)};}
  return {store,db,docs,snapshots,publication,publish,prefix,writes:()=>writes,abort:value=>{abort=value;}};
}

test('verified annual edit subset only patches signed months and malformed subsets fail closed',async()=>{
  const f=setup();await f.store.migrate('s1');
  const annual=f.publication('annual','2026-01-01','2026-12-31');await f.publish(annual,'annual_op');
  const before=await f.store.read('s1',['2026-09','2026-10']);
  const edited=f.publication('edited','2026-01-01','2026-12-31');edited.plan={affected_months:['2026-09']};
  const input={station_id:'s1',operation_id:'edit_op',publication_id:edited.publication_id,expected_generation:before.root.generation,expected_owners:{'2026-09':before.owners['2026-09']}};
  await f.store.publish(input);
  const after=await f.store.read('s1',['2026-09','2026-10']);assert.equal(after.owners['2026-09'].publication_id,'edited');assert.deepEqual(after.owners['2026-10'],before.owners['2026-10']);
  for(const months of [[],['2026-09','2026-09'],['2027-01'],['2026-10','2026-09']]){
    const bad=f.publication('bad'+f.snapshots.size,'2026-01-01','2026-12-31');bad.plan={affected_months:months};const writes=f.writes();
    await assert.rejects(()=>f.store.publish({...input,operation_id:'badop'+f.snapshots.size,publication_id:bad.publication_id,expected_generation:after.root.generation,expected_owners:{'2026-09':after.owners['2026-09']}}),/affected-months/);
    assert.equal(f.writes(),writes);
  }
});
test('migration seeds only verified singleton, never older history; repeats without writes',async()=>{
  const f=setup();f.publication('old','2026-08-01','2026-08-31');const p=f.publication('current','2026-09-01','2026-09-03');
  f.docs.set(f.prefix+'schedule_state/active',{publication_id:p.publication_id,revision:p.revision,content_digest:p.content_digest});
  await f.store.migrate('s1');const n=f.writes();await f.store.migrate('s1');assert.equal(f.writes(),n);
  const state=await f.store.read('s1',['2026-08','2026-09']);assert.equal(state.owners['2026-08'],null);
  assert.equal(state.owners['2026-09'].coverage_to,'2026-09-03');
});
test('September survives October; partial replacement owns entire month; replay no writes',async()=>{
  const f=setup();await f.store.migrate('s1');
  const sept=f.publication('sept','2026-09-01','2026-09-30');await f.publish(sept,'op1');
  await f.publish(f.publication('oct','2026-10-01','2026-10-31'),'op2');
  const {input,receipt}=await f.publish(f.publication('partial','2026-09-01','2026-09-03'),'op3');
  const state=await f.store.read('s1',['2026-09','2026-10']);
  assert.equal(state.owners['2026-09'].publication_id,'partial');assert.equal(state.owners['2026-09'].coverage_to,'2026-09-03');
  assert.equal(state.owners['2026-10'].publication_id,'oct');
  const n=f.writes();f.snapshots.delete('partial');assert.deepEqual(await f.store.publish(input),receipt);assert.equal(f.writes(),n);
  await assert.rejects(()=>f.store.publish({...input,publication_id:'sept'}),/request-conflict/);
});
test('rollback restores touched owners after unrelated month change and is replayable',async()=>{
  const f=setup();await f.store.migrate('s1');await f.publish(f.publication('sept','2026-09-01','2026-09-30'),'op1');
  const second=await f.publish(f.publication('sept2','2026-09-01','2026-09-30'),'op2');
  await f.publish(f.publication('oct','2026-10-01','2026-10-31'),'op3');
  const state=await f.store.read('s1',['2026-09']);
  const input={station_id:'s1',operation_id:'rollback1',target_operation_id:'op2',expected_generation:state.root.generation,expected_owners:second.receipt.after};
  const receipt=await f.store.rollback(input),n=f.writes();assert.deepEqual(await f.store.rollback(input),receipt);assert.equal(f.writes(),n);
  const owners=(await f.store.read('s1',['2026-09','2026-10'])).owners;
  assert.equal(owners['2026-09'].publication_id,'sept');assert.equal(owners['2026-10'].publication_id,'oct');
  await assert.rejects(()=>f.store.rollback({...input,operation_id:'rollback2',expected_generation:receipt.generation_after}),/owner-stale/);
});
test('stale generation/owner, corrupt metadata, wrong month and transaction abort never partially write',async()=>{
  const f=setup();await f.store.migrate('s1');const p=f.publication('sept','2026-09-01','2026-09-30');
  const good={station_id:'s1',operation_id:'op',publication_id:'sept',expected_generation:0,expected_owners:{'2026-09':null}};
  for(const mutation of [{expected_generation:1},{expected_owners:{'2026-10':null}},
    {expected_owners:C.publicationOwners(p,'s1')}]){
    const n=f.writes();await assert.rejects(()=>f.store.publish({...good,...mutation}));assert.equal(f.writes(),n);
  }
  const meta=f.docs.get(f.prefix+'schedule_publications/sept');meta.content_digest='b'.repeat(64);
  await assert.rejects(()=>f.store.publish(good),/publication-changed/);meta.content_digest=p.content_digest;
  const before=structuredClone([...f.docs]);f.abort(true);await assert.rejects(()=>f.store.publish(good),/injected-abort/);
  assert.deepEqual([...f.docs],before);f.abort(false);await f.store.publish(good);
});
test('missing migration, malformed singleton, corrupt month and rollback receipt fail closed',async()=>{
  const f=setup();await assert.rejects(()=>f.store.read('s1',['2026-09']),/migration-required/);
  f.docs.set(f.prefix+'schedule_state/active',{});
  await assert.rejects(()=>f.store.migrate('s1'),/singleton-invalid/);
  const p=f.publication('sept','2026-09-01','2026-09-30');
  f.docs.set(f.prefix+'schedule_state/active',{publication_id:'sept',revision:999,content_digest:p.content_digest});
  await assert.rejects(()=>f.store.migrate('s1'),/singleton-mismatch/);f.docs.delete(f.prefix+'schedule_state/active');await f.store.migrate('s1');
  const {receipt}=await f.publish(p,'op');
  const path=f.prefix+'schedule_publication_months/2026-09';f.docs.get(path).station_id='s2';
  await assert.rejects(()=>f.store.read('s1',['2026-09']),/invalid-owner/);f.docs.get(path).station_id='s1';
  f.docs.get(f.prefix+'schedule_publication_authority_operations/op').before={'2026-09':receipt.after['2026-09']};
  await assert.rejects(()=>f.store.rollback({station_id:'s1',operation_id:'undo',target_operation_id:'op',expected_generation:1,expected_owners:receipt.after}),/invalid-receipt-digest/);
});
test('staging publication cannot own months and rollback revalidates restored snapshot',async()=>{
  const f=setup();await f.store.migrate('s1');const first=f.publication('first','2026-09-01','2026-09-30');
  const meta=f.docs.get(f.prefix+'schedule_publications/first');meta.status='staging';
  await assert.rejects(()=>f.publish(first,'firstop'),/publication-changed/);
  meta.status='active';await f.publish(first,'firstop');
  const second=await f.publish(f.publication('second','2026-09-01','2026-09-30'),'secondop');
  const input={station_id:'s1',operation_id:'undo',target_operation_id:'secondop',expected_generation:2,expected_owners:second.receipt.after};
  const n=f.writes();f.snapshots.delete('first');await assert.rejects(()=>f.store.rollback(input),/verification-failed/);assert.equal(f.writes(),n);
  f.snapshots.set('first',first);meta.snapshot_complete=false;
  await assert.rejects(()=>f.store.rollback(input),/publication-changed/);assert.equal(f.writes(),n);
});
test('migration rejects unrelated orphan months and stale interleaved publish is atomic',async()=>{
  const f=setup();f.docs.set(f.prefix+'schedule_publication_months/2020-01',{orphan:true});
  await assert.rejects(()=>f.store.migrate('s1'),/orphan-month/);assert.equal(f.writes(),0);
  f.docs.clear();await f.store.migrate('s1');
  f.publication('sept','2026-09-01','2026-09-30');
  const preview=await f.store.read('s1',['2026-09']);
  await f.publish(f.publication('oct','2026-10-01','2026-10-31'),'other');
  const before=structuredClone([...f.docs]);
  await assert.rejects(()=>f.store.publish({station_id:'s1',operation_id:'stale',publication_id:'sept',expected_generation:preview.root.generation,expected_owners:preview.owners}),/authority-stale/);
  assert.deepEqual([...f.docs],before);
});
test('composable validation is read-only and joined staging activation aborts atomically',async()=>{
  const f=setup();await f.store.migrate('s1');f.publication('staged','2026-09-01','2026-09-30');
  const path=f.prefix+'schedule_publications/staged';f.docs.get(path).status='staging';
  const input={station_id:'s1',operation_id:'joined',publication_id:'staged',expected_generation:0,expected_owners:{'2026-09':null},lifecycle:'staging-to-active'};
  await assert.rejects(()=>f.store.publish(input),/standalone-lifecycle/);
  const prepared=await f.store.prepareVerifiedOperation(input),before=structuredClone([...f.docs]);
  f.abort(true);
  await assert.rejects(()=>f.db.runTransaction(async tx=>{
    const n=f.writes(),plan=await f.store.readAndValidate(tx,prepared,{generation:0,owners:input.expected_owners});
    assert.equal(f.writes(),n);assert.equal(plan.activation.to,'active');
    await tx.get(f.db.doc('unrelated-read-before-writes'));
    f.store.applyWrites(tx,plan);tx.create(f.db.doc(f.prefix+'audit/joined'),{done:true});
  }),/injected-abort/);
  assert.deepEqual([...f.docs],before);f.abort(false);
  const receipt=await f.db.runTransaction(async tx=>f.store.applyWrites(tx,await f.store.readAndValidate(tx,prepared)));
  assert.equal(f.docs.get(path).status,'active');assert.equal(receipt.after['2026-09'].activation_id,C.activationId('s1','publish','joined','2026-09'));
  const n=f.writes(),replay=await f.store.prepareVerifiedOperation(input);
  const replayResult=await f.db.runTransaction(async tx=>f.store.applyWrites(tx,await f.store.readAndValidate(tx,replay)));
  assert.deepEqual(replayResult,receipt);assert.equal(f.writes(),n);
});
test('composable handles cannot be forged/reused across transactions and stale preparation fails',async()=>{
  const f=setup();await f.store.migrate('s1');f.publication('p','2026-09-01','2026-09-30');
  const input={station_id:'s1',operation_id:'op',publication_id:'p',expected_generation:0,expected_owners:{'2026-09':null}};
  const prepared=await f.store.prepareVerifiedOperation(input);let saved;
  await f.db.runTransaction(async tx=>{saved=await f.store.readAndValidate(tx,prepared);});
  await assert.rejects(()=>f.db.runTransaction(async tx=>f.store.applyWrites(tx,saved)),/validated-plan/);
  await assert.rejects(()=>f.db.runTransaction(async tx=>f.store.readAndValidate(tx,{...prepared})),/prepared-handle/);
  await assert.rejects(()=>f.db.runTransaction(async tx=>f.store.readAndValidate(tx,prepared,{generation:1,owners:input.expected_owners})),/expected-baseline/);
  await f.publish(f.publication('oct','2026-10-01','2026-10-31'),'other');
  await assert.rejects(()=>f.db.runTransaction(async tx=>f.store.readAndValidate(tx,prepared)),/authority-stale/);
});
test('rollback and migration use distinct deterministic activation epochs',async()=>{
  const f=setup(),p=f.publication('seed','2026-09-01','2026-09-30');
  f.docs.set(f.prefix+'schedule_state/active',{publication_id:'seed',revision:p.revision,content_digest:p.content_digest});
  await f.store.migrate('s1');const original=(await f.store.read('s1',['2026-09'])).owners['2026-09'];
  assert.equal(original.activation_id,C.migrationActivation('s1',original));
  const newer=await f.publish(f.publication('next','2026-09-01','2026-09-30'),'newer');
  const receipt=await f.store.rollback({station_id:'s1',operation_id:'undo',target_operation_id:'newer',expected_generation:1,expected_owners:newer.receipt.after});
  assert.equal(receipt.after['2026-09'].publication_id,'seed');
  assert.notEqual(receipt.after['2026-09'].activation_id,original.activation_id);
  assert.equal(receipt.after['2026-09'].activation_id,C.activationId('s1','rollback','undo','2026-09'));
});
test('rollback of first month writes receipt-bound tombstone and later publish replaces it',async()=>{
  const f=setup();await f.store.migrate('s1');const first=await f.publish(f.publication('first','2026-09-01','2026-09-03'),'firstop');
  const input={station_id:'s1',operation_id:'undo',operation_publication_id:'rollback_envelope',target_operation_id:'firstop',expected_generation:1,expected_owners:first.receipt.after};
  const result=await f.store.rollback(input), tomb=result.after['2026-09'];
  assert.deepEqual(tomb,{schema_version:2,state:'unowned',station_id:'s1',month:'2026-09',activation_id:C.activationId('s1','rollback','undo','2026-09'),operation_id:'undo',operation_publication_id:'rollback_envelope'});
  assert.deepEqual((await f.store.read('s1',['2026-09'])).owners['2026-09'],tomb);
  assert.deepEqual(await f.store.rollback(input),result);
  const next=await f.publish(f.publication('new','2026-09-01','2026-09-30'),'newop');
  assert.deepEqual(next.receipt.before['2026-09'],tomb);assert.equal(next.receipt.after['2026-09'].publication_id,'new');
});
