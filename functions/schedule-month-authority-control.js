'use strict';
const C=require('./schedule-month-authority');
function classify(station_id,root,control){
  C.id(station_id);
  if(control!==null){
    if(!control || typeof control!=='object' || Array.isArray(control) || control.schema_version!==1 || control.station_id!==station_id
      || typeof control.enabled!=='boolean')C.fail('authority-control-invalid');
    const keys=control.enabled?['schema_version','station_id','enabled','release_id','activation_id','activated_by','activated_at']:['schema_version','station_id','enabled'];
    if(Object.keys(control).sort().join()!==keys.sort().join())C.fail('authority-control-invalid');
    if(control.enabled && (typeof control.release_id!=='string' || !/^[A-Za-z0-9._-]{1,64}$/.test(control.release_id)
      || typeof control.activation_id!=='string' || !/^[a-f0-9]{64}$/.test(control.activation_id)
      || typeof control.activated_by!=='string' || !/^[^\s/\u0000-\u001f\u007f]{1,128}$/.test(control.activated_by)
      || typeof control.activated_at!=='string' || !Number.isFinite(Date.parse(control.activated_at))))C.fail('authority-control-invalid');
  }
  if(root===null && (control===null || control.enabled===false))return Object.freeze({station_id,mode:'compatibility',control_digest:C.hash(control)});
  if(root!==null && control && control.enabled===true){C.root(root,station_id);return Object.freeze({station_id,mode:'monthly',control_digest:C.hash(control)});}
  C.fail('authority-control-inconsistent');
}
function createAuthorityControl({db,releaseId,clock,verifySingleton,verifySuper,verifyOwners}){
  if(typeof releaseId!=='string' || !/^[A-Za-z0-9._-]{1,64}$/.test(releaseId))throw new TypeError('server release ID required');
  const state=sid=>db.doc('stations/'+C.id(sid)+'/schedule_state/publication_authority');
  const control=sid=>db.doc('stations/'+C.id(sid)+'/schedule_state/publication_authority_control');
  const value=snap=>snap.exists?snap.data():null;
  async function read(tx,sid){const [root,flag]=await Promise.all([tx.get(state(sid)),tx.get(control(sid))]);return classify(sid,value(root),value(flag));}
  async function select(sid){return db.runTransaction(tx=>read(tx,sid));}
  async function assertTx(tx,expected){const actual=await read(tx,expected.station_id);if(C.stable(actual)!==C.stable(expected))C.fail('authority-selection-changed');return actual;}
  async function assertCurrent(expected){return db.runTransaction(tx=>assertTx(tx,expected));}
  async function inventory(tx,sid,uid){
    const selected=await read(tx,sid);if(selected.mode!=='monthly')C.fail('monthly-authority-required');
    const root=value(await tx.get(state(sid))),runtime=value(await tx.get(db.doc('stations/'+sid+'/schedule_state/runtime')));
    const docs=await tx.get(db.collection('stations/'+sid+'/schedule_publication_months').limit(C.MAX_TOUCHED_MONTHS+1));
    if(docs.size>C.MAX_TOUCHED_MONTHS)C.fail('cutover-capacity');
    const owners=C.patch(Object.fromEntries(docs.docs.map(doc=>[doc.id,doc.data()])),sid);
    return {owners,payload:{schema:'schedule-month-cutover-preflight-v1',station_id:sid,actor_uid:uid,release_id:releaseId,
      control_digest:selected.control_digest,root_generation:root.generation,owners_digest:C.hash(owners),runtime_mode:runtime && runtime.mode}};
  }
  async function previewCutover(req,sid){
    await verifySuper(req);const captured=await db.runTransaction(tx=>inventory(tx,sid,req.auth.uid));
    if(captured.payload.runtime_mode!=='shadow')C.fail('monthly-cutover-shadow-required');
    await verifyOwners(sid,captured.owners);await verifySuper(req);
    await db.runTransaction(async tx=>{const current=await inventory(tx,sid,req.auth.uid);if(C.stable(current)!==C.stable(captured))C.fail('monthly-cutover-stale');});
    return {schema:'schedule-month-cutover-preflight-v1',authority_mode:'monthly',preflight_signature:C.hash(captured.payload),
      expected_generation:captured.payload.root_generation,summary:{months:Object.keys(captured.owners).length,
        publications:new Set(Object.values(captured.owners).filter(v=>v.state!=='unowned').map(v=>v.publication_id)).size,
        unavailable_months:Object.values(captured.owners).filter(v=>v.state==='unowned').length},mode:'shadow',target:'new'};
  }
  async function promoteToNew(req,sid){
    await verifySuper(req);
    const input=req.data||{},requestId=C.id(input.request_id);
    if(typeof input.preflight_signature!=='string' || !/^[a-f0-9]{64}$/.test(input.preflight_signature))C.fail('monthly-cutover-signature');
    C.generation(input.expected_generation);
    if(Object.keys(input).sort().join()!=='expected_generation,preflight_signature,request_id')C.fail('monthly-cutover-input');
    const fingerprint=C.hash({station_id:sid,actor_uid:req.auth.uid,requestId,signature:input.preflight_signature,generation:input.expected_generation,release_id:releaseId});
    const ref=db.doc('stations/'+sid+'/schedule_month_cutovers/c_'+C.hash({uid:req.auth.uid,requestId}));
    function replay(record){if(!record)return null;if(record.fingerprint!==fingerprint || record.station_id!==sid || record.actor_uid!==req.auth.uid || !record.result)C.fail('monthly-cutover-request-conflict');return {...record.result,duplicate:true};}
    const existing=replay(value(await ref.get()));if(existing)return existing;
    const captured=await db.runTransaction(tx=>inventory(tx,sid,req.auth.uid));
    if(captured.payload.runtime_mode!=='shadow')C.fail('monthly-cutover-shadow-required');
    if(captured.payload.root_generation!==input.expected_generation || C.hash(captured.payload)!==input.preflight_signature)C.fail('monthly-cutover-stale');
    await verifyOwners(sid,captured.owners);await verifySuper(req);
    return db.runTransaction(async tx=>{
      await verifySuper(req);
      const previous=replay(value(await tx.get(ref)));if(previous)return previous;
      const current=await inventory(tx,sid,req.auth.uid);
      if(C.stable(current)!==C.stable(captured))C.fail('monthly-cutover-stale');
      const result={mode:'new',authority_mode:'monthly',authority_generation:captured.payload.root_generation,duplicate:false};
      tx.update(db.doc('stations/'+sid+'/schedule_state/runtime'),{mode:'new',updated_by:req.auth.uid,updated_at:clock()});
      tx.create(ref,{schema_version:1,station_id:sid,actor_uid:req.auth.uid,request_id:requestId,fingerprint,result,created_at:clock()});
      tx.create(db.doc('stations/'+sid+'/schedule_audit/month_cutover_'+C.hash({uid:req.auth.uid,requestId})),{action:'month-authority-live',by:req.auth.uid,from:'shadow',to:'new',authority_generation:captured.payload.root_generation,at:clock()});
      return result;
    });
  }
  async function activate(req){
    const input=req && req.data || {},sid=C.id(input.station_id);
    if(Object.keys(input).sort().join()!=='expected_release_id,station_id')C.fail('authority-activation-input');
    if(input.expected_release_id!==releaseId)C.fail('authority-release-mismatch');
    await verifySuper(req);
    const existing=await select(sid);
    if(existing.mode==='monthly')return {duplicate:true,station_id:sid,enabled:true,release_id:releaseId};
    const verified=await verifySingleton(sid),pointer=verified?verified.pointer:null,p=verified?verified.snapshot:null;
    const owners=p?C.publicationOwners(p,sid):{};
    for(const owner of Object.values(owners))owner.activation_id=C.migrationActivation(sid,owner);
    await verifySuper(req);
    return db.runTransaction(async tx=>{
      await verifySuper(req);
      await assertTx(tx,existing);
      const live=await tx.get(db.doc('stations/'+sid+'/schedule_state/active'));
      if(C.stable(value(live))!==C.stable(pointer))C.fail('authority-singleton-changed');
      const orphan=await tx.get(db.collection('stations/'+sid+'/schedule_publication_months').limit(1));
      if(!orphan.empty)C.fail('orphan-month');
      if(p){
        const meta=value(await tx.get(db.doc('stations/'+sid+'/schedule_publications/'+p.publication_id)));
        if(!meta || meta.station_id!==sid || meta.status!=='active' || meta.snapshot_complete!==true || meta.revision!==p.revision || meta.content_digest!==p.content_digest || meta.from!==p.from || meta.to!==p.to)C.fail('authority-singleton-changed');
      }
      const activation_id=C.hash({station_id:sid,release_id:releaseId,pointer});
      const root={schema_version:1,station_id:sid,generation:0,migrated:true,seed_publication_id:p?p.publication_id:null,last_operation_id:'migration'};
      for(const [month,owner]of Object.entries(owners))tx.create(db.doc('stations/'+sid+'/schedule_publication_months/'+month),owner);
      tx.create(state(sid),root);
      tx.set(control(sid),{schema_version:1,station_id:sid,enabled:true,release_id:releaseId,activation_id,activated_by:req.auth.uid,activated_at:clock()});
      tx.create(db.doc('stations/'+sid+'/schedule_audit/month_authority_'+activation_id),{action:'activate-month-authority',by:req.auth.uid,release_id:releaseId,activation_id,at:clock()});
      return {duplicate:false,station_id:sid,enabled:true,release_id:releaseId,activation_id};
    });
  }
  return Object.freeze({select,assertTx,assertCurrent,activate,previewCutover,promoteToNew});
}
module.exports={classify,createAuthorityControl};
