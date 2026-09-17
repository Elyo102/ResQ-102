'use strict';
const C=require('./schedule-month-authority');
const SELECTED=Object.freeze(['getStatus','getManagerSetup','getModeOptions','setRuntimeMode','previewCutover','promoteToNew',
  'previewPolicy','savePolicy','previewSource','saveSource','runPlanner','previewScheduleImport','importScheduleSheet',
  'previewScheduleEdit','applyScheduleEdit','getGapReport','getDraftPreview','getScheduleDisplayStatus','setScheduleDisplay',
  'publish','rollback','getMy','getStation','getStationRange','getEffectiveWorkdays','getLegacyCompatibility','respond']);
const READERS=new Set(['getStatus','getManagerSetup','getModeOptions','previewCutover','previewPolicy','previewSource','previewScheduleImport',
  'previewScheduleEdit','getGapReport','getDraftPreview','getScheduleDisplayStatus','getMy','getStation','getStationRange','getEffectiveWorkdays','getLegacyCompatibility','effectiveWorkDaysForStation']);
function validateOutbox(ref,value,expectedSid){
  const match=/^stations\/([^/]+)\/schedule_publications\/([^/]+)\/schedule_outbox\/[^/]+$/.exec(String(ref && ref.path||''));
  if(!match || !value || value.station_id!==match[1] || value.publication_id!==match[2] || (expectedSid && match[1]!==expectedSid))C.fail('outbox-physical-scope');
  return match[1];
}
function createControlledRuntime({deps,api,createRuntime,resolveContext,verifySingleton,verifySuper,verifyOwners,translateError}){
  const raw=deps.db;
  const control=require('./schedule-month-authority-control').createAuthorityControl({db:raw,releaseId:deps.monthAuthorityReleaseId,
    clock:deps.clock,verifySingleton,verifySuper,verifyOwners});
  function selectedRuntime(selection){
    const db=new Proxy(raw,{get(target,key){
      if(key==='runTransaction')return callback=>target.runTransaction(async tx=>{
        await control.assertTx(tx,selection);
        const checked=new Proxy(tx,{get(transaction,method){
          if(method==='get')return async ref=>{const snap=await transaction.get(ref);
            if(ref && /\/schedule_outbox\/[^/]+$/.test(ref.path||'') && snap.exists)validateOutbox(ref,snap.data(),selection.station_id);
            return snap;};
          const value=transaction[method];return typeof value==='function'?value.bind(transaction):value;
        }});
        return callback(checked);
      });
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
    return createRuntime({...deps,db,monthAuthorityControlEnabled:false,monthAuthorityEnabled:selection.mode==='monthly',
      monthAuthorityTransitionFence:true,
      monthAuthorityOutcomeTransaction:callback=>raw.runTransaction(callback)});
  }
  async function dispatch(name,args,sid){
    const selected=await control.select(sid);
    if(selected.mode==='monthly' && ['promoteToNew','previewCutover'].includes(name))return control[name](args[0],sid);
    const result=await selectedRuntime(selected)[name](...args);
    if(READERS.has(name))await control.assertCurrent(selected);
    return result;
  }
  const result={...api};
  for(const name of SELECTED)result[name]=async req=>{const ctx=await resolveContext(req);return dispatch(name,[req],ctx.sid);};
  result.effectiveWorkDaysForStation=(sid,input)=>dispatch('effectiveWorkDaysForStation',[sid,input],C.id(sid));
  result.activateMonthAuthority=req=>control.activate(req);
  result.deliverOutbox=async ref=>{
    const snap=await ref.get();if(!snap.exists)return {skipped:true};
    const sid=validateOutbox(ref,snap.data()),selected=await control.select(sid);
    // Provider outcomes may be recorded after control changes; individual
    // claim/pre-provider transactions still use the fixed selection fence.
    return selectedRuntime(selected).deliverOutbox(ref);
  };
  result.resumeOutbox=async()=>{
    const jobs=new Map();
    for(const status of ['retry','sending','queued','blocked']){
      const found=await raw.collectionGroup('schedule_outbox').where('status','==',status).limit(100).get();
      found.docs.forEach(doc=>jobs.set(doc.ref.path,doc));
    }
    let queued=0;
    for(const doc of jobs.values()){
      const sid=validateOutbox(doc.ref,doc.data()),selected=await control.select(sid),runtime=selectedRuntime(selected);
      const state=await runtime.reconcileMonthControlledOutbox(doc.ref,Date.parse(deps.clock()));
      if(state.queued)queued++;
      if(state.deliver)await runtime.deliverOutbox(doc.ref);
    }
    return {scanned:jobs.size,queued};
  };
  for(const [name,method]of Object.entries(result))if(typeof method==='function' && method!==api[name])result[name]=async(...args)=>{
    try{return await method(...args);}catch(error){throw translateError(error);}
  };
  return Object.freeze(result);
}
module.exports={createControlledRuntime,SELECTED,validateOutbox};
