import {createVerify,randomUUID} from 'node:crypto';
export const PROJECT='resq-agent-control-20260928';
export const DATABASE=`projects/${PROJECT}/databases/(default)`;
const KEY='AIzaSyCe0_Wad4-4MS3OHWB0fPxGsiSJe2M2Hzk';
const CERTS='https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const fail=code=>{throw Error(code);};
export async function boundedJson(fetcher,url,options={},timeout=15000){
 let response;
 try {response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeout)});}catch{fail('REMOTE_UNAVAILABLE');}
 if(!response.ok){const error=Error('REMOTE_REJECTED');error.status=response.status;throw error;}
 const reader=response.body.getReader(),chunks=[];let size=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144)fail('RESPONSE_LIMIT');chunks.push(Buffer.from(value));}}
 catch{fail('RESPONSE_UNAVAILABLE');}
 finally {try{await reader.cancel();}catch{/* Never expose stream errors or secrets. */}}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_RESPONSE');}
}
export function verifyIdentity(token,certificates,{uid,agent,budget=false},now=Date.now()){
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
 }catch{fail('INVALID_CLOUD_IDENTITY');}
}
export async function connectCloud({refreshToken,uid,agent,budget=false,fetcher=fetch}){
 if(typeof refreshToken!=='string'||refreshToken.length<20||refreshToken.length>8192
  ||typeof uid!=='string'||!/^resq-ci-[a-z0-9-]{4,100}$/.test(uid)
  ||(!budget&&!['Codex','Claude','Grok','Gemini'].includes(agent)))fail('MISSING_CLOUD_IDENTITY');
 const auth=await boundedJson(fetcher,`https://securetoken.googleapis.com/v1/token?key=${KEY}`,{
  method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken}).toString()});
 if(auth.user_id!==uid||auth.project_id!=='802712493259')fail('WRONG_CLOUD_PROJECT');
 verifyIdentity(auth.id_token,await boundedJson(fetcher,CERTS),{uid,agent,budget});
 const root=`https://firestore.googleapis.com/v1/${DATABASE}/documents`;
 const request=(suffix,body)=>boundedJson(fetcher,root+suffix,{method:body?'POST':'GET',
  headers:{Authorization:'Bearer '+auth.id_token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const validPath=path=>typeof path==='string'&&/^resq_budget_state\/(?:policy(?:\/operations\/[a-f0-9]{64})?|month_\d{4}-\d{2})$/.test(path);
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
   if(!budget||!Array.isArray(writes)||writes.length!==2||writes.some(w=>!w.update?.name?.startsWith(DATABASE+'/documents/')
    ||!validPath(w.update.name.slice((DATABASE+'/documents/').length))))fail('CLOUD_PATH_DENIED');
   return request(':commit',{writes});
  },
  async emit(kind,step){
   if(budget||!['heartbeat','task_started','task_completed','task_failed'].includes(kind)||!['running','started','completed','failed'].includes(step))fail('INVALID_EVENT');
   const fields=Object.fromEntries(Object.entries({agent,kind,step,task:'deployment_check'}).map(([k,v])=>[k,{stringValue:v}]));
   const result=await request(':commit',{writes:[{update:{name:`${DATABASE}/documents/events/${randomUUID()}`,fields},currentDocument:{exists:false},updateTransforms:[{fieldPath:'createdAt',setToServerValue:'REQUEST_TIME'}]}]});
   if(result.writeResults?.length!==1)fail('EVENT_DELIVERY_UNKNOWN');
  }
 });
}
