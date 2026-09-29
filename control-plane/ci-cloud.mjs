import {createVerify,randomUUID} from 'node:crypto';
import {validateEvent} from './core.mjs';
export const PROJECT='resq-agent-control-20260928';
export const DATABASE=`projects/${PROJECT}/databases/(default)`;
const KEY='AIzaSyCe0_Wad4-4MS3OHWB0fPxGsiSJe2M2Hzk';
const CERTS='https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const fail=code=>{throw Error(code);};
export async function boundedJson(fetcher,url,options={},timeout=15000){
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>45000)fail('INVALID_TIMEOUT');
 const abort=new AbortController();let timer,reader;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error('REMOTE_UNAVAILABLE'));},timeout);});
 const work=(async()=>{
 let response;
 try {response=await fetcher(url,{...options,redirect:'error',signal:abort.signal});}catch{fail('REMOTE_UNAVAILABLE');}
 if(!response.ok){const error=Error('REMOTE_REJECTED');error.status=response.status;throw error;}
 reader=response.body.getReader();const chunks=[];let size=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144)fail('RESPONSE_LIMIT');chunks.push(Buffer.from(value));}}
 catch{fail('RESPONSE_UNAVAILABLE');}
 finally {try{void Promise.resolve(reader.cancel()).catch(()=>{});}catch{/* Never expose stream errors or secrets. */}}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_RESPONSE');}
 })();
 try{return await Promise.race([work,deadline]);}
 finally{clearTimeout(timer);abort.abort();try{void Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}}
}
export function verifyIdentity(token,certificates,{uid,agent,budget=false,authorizationId,principal,approvedSha},now=Date.now()){
 try{
  if(typeof token!=='string'||token.length>20000||!Number.isSafeInteger(now))fail('TOKEN');
  const parts=token.split('.');if(parts.length!==3)fail('TOKEN');
  const header=JSON.parse(Buffer.from(parts[0],'base64url')),body=JSON.parse(Buffer.from(parts[1],'base64url'));
  if(header.alg!=='RS256'||!Object.hasOwn(certificates,header.kid))fail('TOKEN');
  const verifier=createVerify('RSA-SHA256');verifier.update(parts[0]+'.'+parts[1]);verifier.end();
  if(!verifier.verify(certificates[header.kid],Buffer.from(parts[2],'base64url')))fail('TOKEN');
  const at=Math.floor(now/1000);
  if(body.aud!==PROJECT||body.iss!==`https://securetoken.google.com/${PROJECT}`||body.sub!==uid
   ||!Number.isSafeInteger(body.exp)||body.exp<=at||!Number.isSafeInteger(body.iat)||body.iat>at||body.iat<0
   ||!Number.isSafeInteger(body.auth_time)||body.auth_time>at||body.auth_time<0)fail('TOKEN');
  if(budget ? body.control_plane_budget!==true||body.control_plane_agent!==undefined
            : body.control_plane_agent!==agent||body.control_plane_budget!==undefined)fail('TOKEN');
  if(budget && (!/^[A-Za-z0-9-]{8,64}$/.test(authorizationId||'')||principal!==uid
   ||!/^[a-f0-9]{40}$/.test(approvedSha||'')||body.control_plane_authorization!==authorizationId))fail('TOKEN');
 }catch{fail('INVALID_CLOUD_IDENTITY');}
}
export async function connectCloud({refreshToken,uid,agent,budget=false,authorizationId,principal,approvedSha,fetcher=fetch}){
 if(typeof refreshToken!=='string'||refreshToken.length<20||refreshToken.length>8192
  ||typeof uid!=='string'||!/^resq-ci-[a-z0-9-]{4,100}$/.test(uid)
  ||(!budget&&!['Codex','Claude','Grok','Gemini'].includes(agent)))fail('MISSING_CLOUD_IDENTITY');
 if(budget&&(!/^[A-Za-z0-9-]{8,64}$/.test(authorizationId||'')||principal!==uid||!/^[a-f0-9]{40}$/.test(approvedSha||'')))fail('MISSING_BUDGET_AUTHORIZATION');
 const auth=await boundedJson(fetcher,`https://securetoken.googleapis.com/v1/token?key=${KEY}`,{
  method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}).toString()});
 if(auth.user_id!==uid||auth.project_id!=='802712493259')fail('WRONG_CLOUD_PROJECT');
 verifyIdentity(auth.id_token,await boundedJson(fetcher,CERTS),{uid,agent,budget,authorizationId,principal,approvedSha});
 const root=`https://firestore.googleapis.com/v1/${DATABASE}/documents`;
 const request=(suffix,body)=>boundedJson(fetcher,root+suffix,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+auth.id_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const grantPath=`resq_budget_authorizations/${authorizationId}`;
 const validPath=path=>typeof path==='string'&&(/^(?:resq_budget_state\/policy|resq_budget_state\/month_\d{4}-\d{2})$/.test(path)||path===grantPath);
 return Object.freeze({
  async get(path){if(!budget||!validPath(path))fail('CLOUD_PATH_DENIED');try{return await request('/'+path);}catch(e){if(e.status===404)return null;throw e;}},
  async serverNow(){
   if(!budget)fail('CLOUD_PATH_DENIED');const start=performance.now();
   const rows=await request(':batchGet',{documents:[`${DATABASE}/documents/resq_budget_state/policy`]});
   if(performance.now()-start>3000||!Array.isArray(rows)||rows.length!==1
    ||rows[0].found?.name!==`${DATABASE}/documents/resq_budget_state/policy`
    ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(rows[0].readTime||''))fail('SERVER_CLOCK_UNAVAILABLE');
   const at=Date.parse(rows[0].readTime);if(!Number.isSafeInteger(at)||at<0)fail('SERVER_CLOCK_UNAVAILABLE');return at;
  },
  async commit(writes){
   validateBudgetWrites(writes,{budget,authorizationId,principal,approvedSha});
   return request(':commit',{writes});
  },
  async emit(kind,step,task='deployment_check'){
   if(budget)fail('INVALID_EVENT');
   const event=validateEvent({agent,kind,step,task});
   const fields=Object.fromEntries(Object.entries(event).map(([k,v])=>[k,{stringValue:v}]));
   const result=await request(':commit',{writes:[{update:{name:`${DATABASE}/documents/events/${randomUUID()}`,fields},currentDocument:{exists:false},updateTransforms:[{fieldPath:'createdAt',setToServerValue:'REQUEST_TIME'}]}]});
   if(result.writeResults?.length!==1)fail('EVENT_DELIVERY_UNKNOWN');
  }
 });
}

// Defense in depth before REST. Rules enforce deltas/immutability against state.
export function validateBudgetWrites(writes,{budget,authorizationId,principal,approvedSha}){
 const root=DATABASE+'/documents/';
 const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
 const stamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
 if(!budget||!Array.isArray(writes)||writes.length!==2)fail('CLOUD_PATH_DENIED');
 const [month,grant]=writes;
 for(const w of writes){
  if(!w||!exact(w.currentDocument,['updateTime'])||!stamp(w.currentDocument.updateTime)
   ||!exact(w.update,['name','fields'])||!exact(w.updateMask,['fieldPaths']))fail('CLOUD_PATH_DENIED');
 }
 if(!exact(month,['update','updateMask','currentDocument'])||!exact(grant,['update','updateMask','currentDocument','updateTransforms'])
  ||!new RegExp('^'+root.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'resq_budget_state/month_\\d{4}-\\d{2}$').test(month.update.name)
  ||grant.update.name!==root+'resq_budget_authorizations/'+authorizationId)fail('CLOUD_PATH_DENIED');
 const mf=month.update.fields,gf=grant.update.fields;
 const mask=(w,names)=>Array.isArray(w.updateMask.fieldPaths)&&w.updateMask.fieldPaths.length===names.length&&names.every(n=>w.updateMask.fieldPaths.includes(n));
 if(!exact(mf,['chargedMicroUsd','lastOperationId','lastAuthorizationId'])||!mask(month,Object.keys(mf))
  ||!exact(gf,['chargedMicroUsd','reservationCount','reservedProviders','lastOperationId','operations'])
  ||mf.lastAuthorizationId?.stringValue!==authorizationId||mf.lastOperationId?.stringValue!==gf.lastOperationId?.stringValue)fail('CLOUD_PATH_DENIED');
 const ops=gf.operations?.mapValue?.fields,provider=gf.lastOperationId?.stringValue?.slice(authorizationId.length+1);
 if(!ops||!['Claude','Grok','Gemini'].includes(provider)||Object.keys(ops).length!==1
  ||Object.keys(ops).some(k=>!['Claude','Grok','Gemini'].includes(k))||gf.lastOperationId?.stringValue!==`${authorizationId}_${provider}`)fail('CLOUD_PATH_DENIED');
 if(!mask(grant,['chargedMicroUsd','reservationCount','reservedProviders','lastOperationId',`operations.${provider}`]))fail('CLOUD_PATH_DENIED');
 const op=ops[provider]?.mapValue?.fields;
 const task={Claude:'planner_draft_recovery',Grok:'swap_race_review',Gemini:'clean_checkout_gates'}[provider];
 if(!op||op.id?.stringValue!==`${authorizationId}_${provider}`||op.provider?.stringValue!==provider||op.task?.stringValue!==task
  ||op.chargedMicroUsd?.integerValue!=='250000'||!/^[a-f0-9]{64}$/.test(op.requestDigest?.stringValue||'')
  ||principal!=='resq-ci-budget-20260928'||!/^[a-f0-9]{40}$/.test(approvedSha||''))fail('CLOUD_PATH_DENIED');
 if(!Array.isArray(grant.updateTransforms)||grant.updateTransforms.length!==1
  ||!exact(grant.updateTransforms[0],['fieldPath','setToServerValue'])
  ||grant.updateTransforms[0].fieldPath!==`operations.${provider}.createdAt`||grant.updateTransforms[0].setToServerValue!=='REQUEST_TIME')fail('CLOUD_PATH_DENIED');
 return true;
}
