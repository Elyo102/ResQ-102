'use strict';

// Dormant, injected adapter. verifySnapshot must perform the existing complete
// signed-snapshot verification; caller authorization belongs to the future runtime.
const C = require('./schedule-month-authority');
function createMonthAuthorityStore({ db, verifySnapshot }) {
  if (!db || typeof db.runTransaction !== 'function' || typeof verifySnapshot !== 'function') throw new TypeError('authority dependencies');
  const base = sid => 'stations/' + C.id(sid);
  const rootRef = sid => db.doc(base(sid)+'/schedule_state/publication_authority');
  const monthRef = (sid,m) => db.doc(base(sid)+'/schedule_publication_months/'+m);
  const opRef = (sid,op) => db.doc(base(sid)+'/schedule_publication_authority_operations/'+C.id(op));
  const data = snap => snap.exists ? snap.data() : null;
  const equal = (a,b) => C.stable(a) === C.stable(b);
  const preparedStates = new WeakMap(), validatedPlans = new WeakMap();
  function freeze(v) { if(v && typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v; }
  function checkMeta(meta,p,status='active') {
    if (!meta || meta.status !== status || meta.snapshot_complete !== true
        || ['station_id','revision','content_digest','from','to'].some(k => meta[k] !== p[k])) C.fail('publication-changed');
  }
  async function verified(sid,pid) {
    C.id(pid); const p = await verifySnapshot({ station_id:sid, publication_id:pid });
    if (!p || p.publication_id !== pid) C.fail('publication-id');
    C.publicationOwners(p,sid); return structuredClone(p);
  }
  async function migrate(sid) {
    const existing = data(await rootRef(sid).get());
    if (existing) return C.root(existing,sid);
    const activeRef = db.doc(base(sid)+'/schedule_state/active');
    const active = data(await activeRef.get());
    if (active !== null && (!active.publication_id || !Number.isSafeInteger(active.revision)
        || active.revision < 1 || typeof active.content_digest !== 'string')) C.fail('singleton-invalid');
    const p = active && active.publication_id ? await verified(sid,active.publication_id) : null;
    if (p && (active.revision !== p.revision || active.content_digest !== p.content_digest)) C.fail('singleton-mismatch');
    const owners = p ? C.publicationOwners(p,sid) : {};
    for(const value of Object.values(owners))value.activation_id=C.migrationActivation(sid,value);
    return db.runTransaction(async tx => {
      const current = data(await tx.get(rootRef(sid)));
      if (current) return C.root(current,sid);
      const existingMonths = await tx.get(db.collection(base(sid)+'/schedule_publication_months').limit(1));
      if (!existingMonths.empty) C.fail('orphan-month');
      if (!equal(data(await tx.get(activeRef)),active)) C.fail('migration-race');
      if (p) {
        const meta = data(await tx.get(db.doc(base(sid)+'/schedule_publications/'+p.publication_id)));
        checkMeta(meta,p); if (meta.status !== 'active') C.fail('singleton-inactive');
      }
      const root = { schema_version:1, station_id:sid, generation:0, migrated:true,
        seed_publication_id:p ? p.publication_id : null, last_operation_id:'migration' };
      for (const [m,value] of Object.entries(owners)) tx.set(monthRef(sid,m),value);
      tx.create(rootRef(sid),root); return root;
    });
  }
  async function read(sid,months) {
    const requested = C.patch(Object.fromEntries(months.map(m => [m,null])),sid);
    return db.runTransaction(async tx => {
      const root = data(await tx.get(rootRef(sid))); if (!root) C.fail('migration-required');
      C.root(root,sid); const owners = {};
      for (const m of Object.keys(requested)) {
        const value = data(await tx.get(monthRef(sid,m)));
        owners[m] = value === null ? null : C.entry(value,sid,m);
      }
      return { root, owners };
    });
  }
  async function readBaseline(sid,months) {
    const existing=data(await rootRef(sid).get());
    if(existing)return read(sid,months);
    const active=data(await db.doc(base(sid)+'/schedule_state/active').get());
    let seeds={};
    if(active!==null){
      const p=await verified(sid,active.publication_id);
      if(active.revision!==p.revision || active.content_digest!==p.content_digest)C.fail('singleton-mismatch');
      seeds=C.publicationOwners(p,sid);
      for(const value of Object.values(seeds))value.activation_id=C.migrationActivation(sid,value);
    }
    const requested=C.patch(Object.fromEntries(months.map(m=>[m,null])),sid);
    return {root:{schema_version:1,station_id:sid,generation:0,migrated:true,seed_publication_id:active?active.publication_id:null,last_operation_id:'migration'},
      owners:Object.fromEntries(Object.keys(requested).map(m=>[m,seeds[m]||null])),initialize:true};
  }
  async function prepareVerifiedOperation(raw) {
    const input=structuredClone(raw),kind=input.kind || 'publish';
    if(!['publish','rollback'].includes(kind))C.fail('operation-kind');
    const lifecycle=input.lifecycle || 'active';
    if(!['active','staging-to-active'].includes(lifecycle) || (kind==='rollback' && lifecycle!=='active'))C.fail('operation-lifecycle');
    const sid = C.id(input.station_id), operation = C.id(input.operation_id);
    const operationPublicationId=C.id(input.operation_publication_id || (kind==='publish'?input.publication_id:operation));
    C.generation(input.expected_generation);
    const baseline = C.patch(input.expected_owners,sid);
    const fingerprint = C.hash({kind,lifecycle,station_id:sid,operation_id:operation,operation_publication_id:operationPublicationId,expected_generation:input.expected_generation,
      expected_owners:baseline,...(kind==='publish' ? {publication_id:C.id(input.publication_id)} : {target_operation_id:C.id(input.target_operation_id)})});
    // Replay before verification: a completed operation remains replayable after
    // its publication has subsequently been superseded.
    const replay = data(await opRef(sid,operation).get());
    if (replay) {
      const result=replayResult(replay,sid,operation,fingerprint);
      const handle=freeze({station_id:sid,operation_id:operation,kind,lifecycle,fingerprint});
      preparedStates.set(handle,{sid,operation,fingerprint,input,baseline,replay:result});return handle;
    }
    const p = kind==='publish' ? await verified(sid,input.publication_id) : null;
    let migration=null;
    if(input.initialize===true && !data(await rootRef(sid).get())){
      const active=data(await db.doc(base(sid)+'/schedule_state/active').get());
      const seed=active?await verified(sid,active.publication_id):null;
      if(seed && (active.revision!==seed.revision || active.content_digest!==seed.content_digest))C.fail('singleton-mismatch');
      const owners=seed?C.publicationOwners(seed,sid):{};
      for(const value of Object.values(owners))value.activation_id=C.migrationActivation(sid,value);
      migration={active,seed,owners};
    }
    let rollbackTarget = null;
    const restored = new Map();
    if (kind==='rollback') {
      rollbackTarget = C.receipt(data(await opRef(sid,input.target_operation_id).get()));
      if (rollbackTarget.station_id !== sid || rollbackTarget.operation_id !== input.target_operation_id) C.fail('rollback-target');
      for (const value of Object.values(rollbackTarget.before)) {
        if (value === null || value.state==='unowned') continue;
        if (!restored.has(value.publication_id)) restored.set(value.publication_id,await verified(sid,value.publication_id));
        const expected = C.publicationOwners(restored.get(value.publication_id),sid)[value.month];
        if(value.activation_id)expected.activation_id=value.activation_id;
        if (!equal(expected,value)) C.fail('rollback-snapshot-changed');
      }
    }
    const handle=freeze({station_id:sid,operation_id:operation,kind,lifecycle,fingerprint});
    preparedStates.set(handle,{sid,operation,operationPublicationId,fingerprint,input,kind,lifecycle,baseline,p,rollbackTarget,restored,migration});return handle;
  }
  async function readAndValidate(tx,prepared,expected) {
      const state=preparedStates.get(prepared);if(!state)C.fail('prepared-handle');
      const {sid,operation,operationPublicationId,fingerprint,input,kind,lifecycle,baseline,p,rollbackTarget,restored}=state;
      if(expected && (!input || expected.generation!==input.expected_generation || !equal(expected.owners,baseline)))C.fail('expected-baseline');
      const again = data(await tx.get(opRef(sid,operation)));
      if (again) {
        const receipt=replayResult(again,sid,operation,fingerprint);
        const plan=freeze({replay:true,receipt});validatedPlans.set(plan,{tx,sid,operation,replay:true});return plan;
      }
      if(state.replay)C.fail('replay-receipt-missing');
      let root=data(await tx.get(rootRef(sid))), seeds={};
      if(!root && state.migration){
        const migration=state.migration;
        if(!equal(data(await tx.get(db.doc(base(sid)+'/schedule_state/active'))),migration.active))C.fail('migration-race');
        if(!(await tx.get(db.collection(base(sid)+'/schedule_publication_months').limit(1))).empty)C.fail('orphan-month');
        if(migration.seed)checkMeta(data(await tx.get(db.doc(base(sid)+'/schedule_publications/'+migration.seed.publication_id))),migration.seed);
        seeds=migration.owners;
        root={schema_version:1,station_id:sid,generation:0,migrated:true,seed_publication_id:migration.seed?migration.seed.publication_id:null,last_operation_id:'migration'};
      }
      root=C.root(root,sid);
      if (root.generation !== input.expected_generation) C.fail('authority-stale');
      let after;
      if (p) {
        checkMeta(data(await tx.get(db.doc(base(sid)+'/schedule_publications/'+p.publication_id))),p,lifecycle==='staging-to-active'?'staging':'active');
        after = C.publicationOwners(p,sid);
        if(p.plan && p.plan.affected_months!==undefined){
          const months=p.plan.affected_months;
          if(!Array.isArray(months) || !months.length || C.stable(months)!==C.stable(Array.from(new Set(months)).sort()) || months.some(m=>!after[m]))C.fail('affected-months');
          after=Object.fromEntries(months.map(m=>[m,after[m]]));
        }
      } else {
        const target = C.receipt(data(await tx.get(opRef(sid,input.target_operation_id))));
        if (!equal(target,rollbackTarget)) C.fail('rollback-receipt-changed');
        if (target.station_id !== sid || target.operation_id !== input.target_operation_id) C.fail('rollback-target');
        if (!equal(target.after,baseline)) C.fail('rollback-owner-changed');
        after = structuredClone(target.before);
        for (const snapshot of restored.values()) checkMeta(data(await tx.get(db.doc(base(sid)+'/schedule_publications/'+snapshot.publication_id))),snapshot);
      }
      if (Object.keys(after).sort().join() !== Object.keys(baseline).sort().join()) C.fail('baseline-months');
      for (const m of Object.keys(baseline)) {
        const value = data(await tx.get(monthRef(sid,m))) || seeds[m] || null;
        if (value !== null) C.entry(value,sid,m);
        if (!equal(value,baseline[m])) C.fail('owner-stale');
      }
      for(const [m,value]of Object.entries(after)) {
        const activation_id=C.activationId(sid,kind,operation,m);
        if(kind==='rollback' && (value===null || value.state==='unowned'))after[m]=C.tombstone({schema_version:2,state:'unowned',station_id:sid,month:m,activation_id,operation_id:operation,operation_publication_id:operationPublicationId},sid,m);
        else if(value)value.activation_id=activation_id;
      }
      const receipt = C.makeReceipt({schema_version:1,station_id:sid,operation_id:operation,kind,fingerprint,
        operation_publication_id:operationPublicationId,
        generation_before:root.generation,generation_after:root.generation+1,before:baseline,after,
        result:{ok:true,operation_id:operation,generation:root.generation+1}});
      const plan=freeze({replay:false,receipt,activation:lifecycle==='staging-to-active'?{publication_id:p.publication_id,from:'staging',to:'active'}:null});
      if(new Set([...Object.keys(seeds),...Object.keys(after)]).size>C.MAX_TOUCHED_MONTHS)C.fail('transaction-capacity');
      validatedPlans.set(plan,{tx,sid,operation,root,seeds,after:receipt.after,activation:plan.activation,applied:false});return plan;
  }
  function applyWrites(tx,plan) {
      const state=validatedPlans.get(plan);
      if(!state || state.tx!==tx)C.fail('validated-plan');
      if(state.replay)return plan.receipt;
      if(state.applied)C.fail('plan-already-applied');state.applied=true;
      const {sid,operation,root,seeds,after,activation}=state;
      // Every read is finished. Publication activation and authority changes
      // join the caller's transaction; an abort also rolls back activation.
      if(activation)tx.update(db.doc(base(sid)+'/schedule_publications/'+activation.publication_id),{status:'active'});
      for(const [m,value]of Object.entries(seeds))if(!Object.hasOwn(after,m))tx.set(monthRef(sid,m),value);
      for (const [m,value] of Object.entries(after)) {
        if (value===null) tx.delete(monthRef(sid,m)); else tx.set(monthRef(sid,m),value);
      }
      tx.set(rootRef(sid),{...root,generation:root.generation+1,last_operation_id:operation});
      tx.create(opRef(sid,operation),plan.receipt); return plan.receipt;
  }
  async function commit(input,kind) {
    if(input.lifecycle && input.lifecycle!=='active')C.fail('standalone-lifecycle');
    const prepared=await prepareVerifiedOperation({...input,kind,lifecycle:'active'});
    return db.runTransaction(async tx=>applyWrites(tx,await readAndValidate(tx,prepared)));
  }
  function replayResult(value,sid,operation,fingerprint) {
    const receipt = C.receipt(value);
    if (receipt.station_id !== sid || receipt.operation_id !== operation || receipt.fingerprint !== fingerprint) C.fail('request-conflict');
    return receipt;
  }
  return Object.freeze({migrate,read,readBaseline,prepareVerifiedOperation,readAndValidate,applyWrites,publish:input=>commit(input,'publish'),rollback:input=>commit(input,'rollback')});
}
module.exports = { createMonthAuthorityStore };
