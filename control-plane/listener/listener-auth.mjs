// Listener identity: refresh-token exchange and ID-token verification (LD only, library only).
// Security review 30/09/2026 (listener provisioning verdict): the listener holds ONLY its own refresh token (DPAPI
// protected by credential-store.mjs). It never holds a password, an owner token or a service account.
// - Production endpoints are constants: securetoken.googleapis.com (exchange) and www.googleapis.com (public certs).
// - Every ID token is verified: RS256 against Google's securetoken certificates, aud/iss = the project, sub = the
//   provisioned uid, control_plane_role 'listener', control_plane_agent = the agent, no budget claim, integer auth_time.
// - auth_time is fixed at provisioning (sign-in) and a refresh never changes it; the Rules require
//   auth_time >= private_listeners/<uid>.revokedAfter, and provisioning writes revokedAfter = that auth_time.
// - Errors carry safe codes only: never a token, a password or a raw response body.
// - 'emulator' mode exists ONLY for the local e2e (demo-* project, unsigned emulator tokens); the CLIs never select it.
import {createVerify} from 'node:crypto';

export const PROJECT='resq-agent-control-20260928';
export const PROJECT_NUMBER='802712493259';
export const API_KEY='AIzaSyCe0_Wad4-4MS3OHWB0fPxGsiSJe2M2Hzk'; // Public Firebase client key (same as telemetry-ci.mjs).
export const SECURETOKEN_URL='https://securetoken.googleapis.com/v1/token?key='+API_KEY;
export const CERTS_URL='https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
// Only agents with a real LD intake get an identity. Gemini (display only) and Claude get none.
export const LISTENER_AGENTS=Object.freeze({Grok:'grok',Codex:'codex'});
export const REFRESH_MARGIN_S=300;
// Upstream error identifiers that may be surfaced as codes (never the body itself).
const KNOWN=Object.freeze(['TOKEN_EXPIRED','USER_DISABLED','USER_NOT_FOUND','INVALID_REFRESH_TOKEN','INVALID_GRANT_TYPE',
  'MISSING_REFRESH_TOKEN','PROJECT_NUMBER_MISMATCH','EMAIL_NOT_FOUND','INVALID_PASSWORD','INVALID_LOGIN_CREDENTIALS',
  'PASSWORD_LOGIN_DISABLED','OPERATION_NOT_ALLOWED','EMAIL_EXISTS','DUPLICATE_EMAIL','ADMIN_ONLY_OPERATION','INVALID_EMAIL',
  'PERMISSION_DENIED','NOT_FOUND','ALREADY_EXISTS','FAILED_PRECONDITION','UNAUTHENTICATED']);
// A refresh failing with one of these means the credential is dead: the runner stops instead of retrying.
export const FATAL_AUTH=Object.freeze(['TOKEN_EXPIRED','USER_DISABLED','USER_NOT_FOUND','INVALID_REFRESH_TOKEN','PROJECT_NUMBER_MISMATCH']);

export class SafeError extends Error{constructor(code,status){super(code);this.code=code;if(status)this.status=status;}}
export const fail=(code,status)=>{throw new SafeError(code,status);};
export const safeCode=e=>e instanceof SafeError?e.code:'FAILED';

async function readBounded(res,maxBytes){
  if(!res.body)return '';
  const reader=res.body.getReader();let size=0;const chunks=[];
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(value));}
  }finally{try{await reader.cancel();}catch{}}
  return Buffer.concat(chunks).toString('utf8');
}
// Bounded JSON request. Non-2xx -> SafeError(<allowlisted upstream code> | 'HTTP_<status>', status). Body never surfaced.
export async function requestJson(fetcher,url,options={},{maxBytes=1<<20,timeoutMs=15000,allow404=false}={}){
  let res;
  try{res=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch{fail('NETWORK');}
  let text;try{text=await readBounded(res,maxBytes);}catch(e){fail(e instanceof SafeError?e.code:'NETWORK');}
  let body=null;try{body=text?JSON.parse(text):null;}catch{body=null;}
  if(allow404&&res.status===404)return null;
  if(!res.ok){
    const raw=body?.error;const m=typeof raw?.message==='string'?raw.message.split(/[\s:]/)[0]:typeof raw==='string'?raw:'';
    const s=typeof raw?.status==='string'?raw.status:'';
    fail(KNOWN.includes(m)?m:KNOWN.includes(s)?s:'HTTP_'+res.status,res.status);
  }
  if(body===null||typeof body!=='object')fail('BAD_JSON');
  return body;
}

export function decodeJwt(token){
  try{
    if(typeof token!=='string'||token.length>20000)fail('TOKEN_FORMAT');
    const parts=token.split('.');if(parts.length!==3)fail('TOKEN_FORMAT');
    return {head:JSON.parse(Buffer.from(parts[0],'base64url')),body:JSON.parse(Buffer.from(parts[1],'base64url')),parts};
  }catch{fail('TOKEN_FORMAT');}
}
// Claim checks shared by the runner and the provisioning script. Returns auth_time (integer seconds).
export function verifyListenerClaims(body,{projectId,uid,agent,now=Date.now()}){
  const s=Math.floor(now/1000);
  const ok=body&&typeof body==='object'
    &&body.aud===projectId&&body.iss==='https://securetoken.google.com/'+projectId
    &&typeof uid==='string'&&body.sub===uid&&(body.user_id===undefined||body.user_id===uid)
    &&body.control_plane_role==='listener'&&Object.hasOwn(LISTENER_AGENTS,agent)&&body.control_plane_agent===agent
    &&body.control_plane_budget===undefined&&body.control_plane_authorization===undefined
    &&Number.isSafeInteger(body.auth_time)&&body.auth_time>0&&body.auth_time<=s+60
    &&Number.isSafeInteger(body.iat)&&body.iat>=body.auth_time&&body.iat<=s+60
    &&Number.isSafeInteger(body.exp)&&body.exp>s;
  if(!ok)fail('TOKEN_CLAIMS');
  return body.auth_time;
}
export function createCertCache({fetcher,now=()=>Date.now()}){
  let certs=null,until=0;
  return async()=>{if(!certs||now()>until){certs=await requestJson(fetcher,CERTS_URL,{method:'GET'},{maxBytes:65536});until=now()+3600000;}return certs;};
}
export async function verifySignature(token,getCerts){
  const {head,parts}=decodeJwt(token);
  const certs=await getCerts();
  if(head.alg!=='RS256'||typeof head.kid!=='string'||!Object.hasOwn(certs,head.kid))fail('TOKEN_SIGNATURE');
  let good=false;
  try{const v=createVerify('RSA-SHA256');v.update(parts[0]+'.'+parts[1]);v.end();good=v.verify(certs[head.kid],Buffer.from(parts[2],'base64url'));}catch{good=false;}
  if(!good)fail('TOKEN_SIGNATURE');
}
function modeCheck(mode,projectId){
  if(mode==='production'){if(projectId!==PROJECT)fail('PROJECT_REJECTED');return;}
  if(mode==='emulator'){if(typeof projectId!=='string'||!/^demo-[a-z0-9-]{1,60}$/.test(projectId))fail('EMULATOR_PROJECT_REJECTED');return;}
  fail('MODE_REJECTED');
}
// Verify an ID token fully (signature in production; emulator tokens are unsigned by design) and return auth_time.
export async function verifyIdToken(token,{mode,projectId,uid,agent,getCerts,now=Date.now()}){
  modeCheck(mode,projectId);
  const {head,body}=decodeJwt(token);
  if(mode==='production')await verifySignature(token,getCerts);
  else if(head.alg!=='none')fail('TOKEN_SIGNATURE');
  return verifyListenerClaims(body,{projectId,uid,agent,now});
}

// Refresh-token -> verified ID token, cached until REFRESH_MARGIN_S before expiry. auth_time must never change.
export function createTokenSource({mode='production',projectId,uid,agent,refreshToken,fetcher=fetch,now=()=>Date.now(),getCerts}){
  modeCheck(mode,projectId);
  if(!Object.hasOwn(LISTENER_AGENTS,agent))fail('AGENT_REJECTED');
  if(typeof uid!=='string'||!/^[A-Za-z0-9_-]{6,128}$/.test(uid))fail('UID_FORMAT');
  if(typeof refreshToken!=='string'||refreshToken.length<20||refreshToken.length>8192)fail('CREDENTIAL_FORMAT');
  const certs=getCerts||createCertCache({fetcher,now});
  let refresh=refreshToken,idToken=null,exp=0,iat=0,authTime=null,fatal=null,inflight=null;
  async function exchange(){
    let r;
    try{
      r=await requestJson(fetcher,SECURETOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh}).toString()},{maxBytes:65536});
    }catch(e){if(FATAL_AUTH.includes(safeCode(e)))fatal=safeCode(e);throw e;}
    if(r.user_id!==uid)fail('IDENTITY_MISMATCH');
    if(mode==='production'&&r.project_id!==PROJECT_NUMBER)fail('IDENTITY_MISMATCH');
    const t=r.id_token;
    const at=await verifyIdToken(t,{mode,projectId,uid,agent,getCerts:certs,now:now()});
    if(authTime!==null&&at!==authTime)fail('AUTH_TIME_CHANGED');
    authTime=at;idToken=t;const b=decodeJwt(t).body;exp=b.exp;iat=Number.isSafeInteger(b.iat)?b.iat:0;
    if(typeof r.refresh_token==='string'&&r.refresh_token.length>=20&&r.refresh_token.length<=8192)refresh=r.refresh_token; // memory only
    return t;
  }
  return Object.freeze({
    async getIdToken(){
      if(fatal)fail(fatal);
      if(idToken&&exp-REFRESH_MARGIN_S>Math.floor(now()/1000))return idToken;
      inflight??=exchange().finally(()=>{inflight=null;});
      return inflight;
    },
    get authTime(){return authTime;},
    get fatal(){return fatal;},
    get expiresAt(){return exp;},
    get issuedAt(){return iat;},    // seconds, SERVER time of the last verified ID token (ack cut-off, condition 2)   // seconds; the push stream restarts before it (firestore-listen.mjs)
    uid,agent,projectId,mode
  });
}
