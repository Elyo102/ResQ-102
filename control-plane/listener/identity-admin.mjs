// Owner-side Identity Toolkit client, used ONLY by provision-listener.mjs (run once per agent by the owner on LD).
// Authenticated with the owner's existing admin session token (passed in as a function, never printed or stored);
// no service account. The listener runner never imports this module.
// signInWithPassword is the one non-admin call (public API key); it needs the Email/Password provider enabled.
import {requestJson,fail,API_KEY} from './listener-auth.mjs';

export const IDTK_URL='https://identitytoolkit.googleapis.com';
const UID=/^[A-Za-z0-9_-]{6,128}$/;
export function createIdentityAdmin({projectId,accessToken,fetcher=fetch}){
  if(typeof accessToken!=='function')fail('OWNER_TOKEN_SOURCE');
  const admin=async(path,body,method='POST')=>requestJson(fetcher,`${IDTK_URL}/${path}`,{method,
    headers:{Authorization:'Bearer '+await accessToken(),'Content-Type':'application/json','x-goog-user-project':projectId},
    ...(body===undefined?{}:{body:JSON.stringify(body)})},{maxBytes:1<<20});
  const uidOk=uid=>{if(typeof uid!=='string'||!UID.test(uid))fail('UID_FORMAT');return uid;};
  const pick=u=>u?Object.freeze({uid:u.localId,email:u.email??null,disabled:u.disabled===true,
    claims:(()=>{try{return u.customAttributes?JSON.parse(u.customAttributes):{};}catch{return null;}})(),validSince:u.validSince?Number(u.validSince):null}):null;
  return Object.freeze({
    async providerStatus(){
      const c=await admin(`admin/v2/projects/${projectId}/config`,undefined,'GET');
      return Object.freeze({emailPasswordEnabled:c.signIn?.email?.enabled===true,passwordRequired:c.signIn?.email?.passwordRequired===true,
        disabledUserSignup:c.client?.permissions?.disabledUserSignup===true,subtype:typeof c.subtype==='string'?c.subtype:null});
    },
    async lookupEmail(email){const r=await admin(`v1/projects/${projectId}/accounts:lookup`,{email:[email]});return pick(r.users?.[0]);},
    async lookupUid(uid){const r=await admin(`v1/projects/${projectId}/accounts:lookup`,{localId:[uidOk(uid)]});return pick(r.users?.[0]);},
    async createUser({email,password,displayName}){
      const r=await admin(`v1/projects/${projectId}/accounts`,{email,password,displayName,emailVerified:false,disabled:false});
      return uidOk(r.localId);
    },
    setClaims:(uid,claims)=>admin(`v1/projects/${projectId}/accounts:update`,{localId:uidOk(uid),customAttributes:JSON.stringify(claims)}).then(()=>{}),
    setPassword:(uid,password)=>admin(`v1/projects/${projectId}/accounts:update`,{localId:uidOk(uid),password}).then(()=>{}),
    revokeTokens:(uid,seconds)=>{if(!Number.isSafeInteger(seconds)||seconds<=0)fail('VALID_SINCE');return admin(`v1/projects/${projectId}/accounts:update`,{localId:uidOk(uid),validSince:String(seconds)}).then(()=>{});},
    setDisabled:(uid,disabled)=>admin(`v1/projects/${projectId}/accounts:update`,{localId:uidOk(uid),disableUser:disabled===true}).then(()=>{}),
    // Public-key sign-in for the freshly created listener user. Returns tokens to the caller only; never logged.
    async signInWithPassword(email,password){
      const r=await requestJson(fetcher,`${IDTK_URL}/v1/accounts:signInWithPassword?key=${API_KEY}`,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})},{maxBytes:65536});
      if(typeof r.idToken!=='string'||typeof r.refreshToken!=='string'||typeof r.localId!=='string')fail('SIGN_IN_RESPONSE');
      return {uid:r.localId,idToken:r.idToken,refreshToken:r.refreshToken};
    }
  });
}
