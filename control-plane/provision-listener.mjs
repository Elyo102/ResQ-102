// One-time listener provisioning, run BY THE OWNER on LD (never by an agent, never in CI). Reviewed before any run.
// Security review 30/09/2026 (listener provisioning verdict SAFE_TO_PROCEED_WITH_CONDITIONS):
// - Uses the owner's existing firebase-tools admin session token (in memory, never printed). No service account.
// - Only Grok and Codex (LISTENER_AGENTS). Gemini/Claude get no identity.
// - create: Email/Password provider must already be enabled (read-only check; this script never changes project
//   config) and client sign-up must stay blocked (disabledUserSignup===true, else PROVIDER_SIGNUP_OPEN) -> admin-create user listener-<key>@<project>.invalid with a random in-memory password -> uid checks
//   (not the owner uid, not in private_publishers / private_budget_publishers, no existing private_listeners doc;
//   on a collision the new user is disabled and the script stops) -> custom claims {control_plane_role:'listener',
//   control_plane_agent} -> ONE password sign-in -> verify the ID token -> private_listeners/<uid> =
//   {agent, role:'listener', enabled:true, revokedAfter: THAT token's auth_time (integer)} -> DPAPI credential file ->
//   config with delivery:false -> verify: stored credential -> refresh -> auth_time == revokedAfter -> listener query OK.
//   The password is never stored or printed.
// - rotate: validSince=now (old refresh tokens die) -> new random password -> sign-in -> revokedAfter = the NEW
//   auth_time (the Rules then reject every older token) -> new credential -> the same verification.
// - revoke: private_listeners enabled:false + revokedAfter=now+1 (Rules deny at once), validSince=now, disable user.
// - delivery on|off: edits only the local config file. status: read-only.
// Output: JSON with agent/uid/paths/hashes/flags only. Errors: safe codes only.
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import * as nodeFs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {LISTENER_AGENTS,PROJECT,fail,safeCode,verifyIdToken,createTokenSource,createCertCache} from './listener/listener-auth.mjs';
import {createFirestoreClient,encodeValue,structuredListenerQuery,FIRESTORE_URL} from './listener/firestore-rest.mjs';
import {createIdentityAdmin} from './listener/identity-admin.mjs';
import {createCredentialStore} from './listener/credential-store.mjs';
import {createWindowsProtector} from './listener/win-protect.mjs';

export const OWNER_EMAIL='eldad50@gmail.com';
export const listenerEmail=(key,projectId)=>`listener-${key}@${projectId}.invalid`;
export const randomPassword=()=>randomBytes(32).toString('base64url');
const OPS=['create','rotate','revoke','status','delivery-on','delivery-off'];

// deps: {mode, projectId, idtk, ownerDb, store, listenerClientFor(tokenSource), fetcher, getCerts, now, sleep, fs, home, inboxRoot?}
export async function provisionListener({op,agent,deps}){
  if(!OPS.includes(op))fail('OP_REJECTED');
  if(!Object.hasOwn(LISTENER_AGENTS,agent))fail('AGENT_REJECTED');
  const {mode,projectId,idtk,ownerDb,store,listenerClientFor,fetcher,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),fs=nodeFs,home}=deps;
  const getCerts=deps.getCerts||createCertCache({fetcher,now});
  const key=LISTENER_AGENTS[agent];const email=listenerEmail(key,projectId);
  const secs=()=>Math.floor(now()/1000);
  const ownerUid=async()=>{const d=await ownerDb.get('private_access/owner');if(!d||typeof d.data.uid!=='string'||!d.data.uid)fail('OWNER_CONFIG_MISSING');return d.data.uid;};
  async function assertUidFree(uid,owner,{ownDocAllowed}){
    if(uid===owner)fail('LISTENER_UID_IS_OWNER');
    if(await ownerDb.get('private_publishers/'+uid))fail('LISTENER_UID_IS_PUBLISHER');
    if(await ownerDb.get('private_budget_publishers/'+uid))fail('LISTENER_UID_IS_BUDGET_PUBLISHER');
    if(!ownDocAllowed&&await ownerDb.get('private_listeners/'+uid))fail('LISTENER_DOC_EXISTS');
  }
  const claimsOk=c=>c&&Object.keys(c).length===2&&c.control_plane_role==='listener'&&c.control_plane_agent===agent;
  async function listenerDoc(uid){
    const d=await ownerDb.get('private_listeners/'+uid);
    if(!d)fail('LISTENER_DOC_MISSING');
    if(d.data.agent!==agent||d.data.role!=='listener'||!Number.isSafeInteger(d.data.revokedAfter))fail('LISTENER_DOC_MISMATCH');
    return d.data;
  }
  async function signInFresh(uid,password){
    const s=await idtk.signInWithPassword(email,password);
    if(s.uid!==uid)fail('IDENTITY_MISMATCH');
    const authTime=await verifyIdToken(s.idToken,{mode,projectId,uid,agent,getCerts,now:now()});
    return {authTime,refreshToken:s.refreshToken};
  }
  // Reads the credential back through the store (DPAPI + ACL), refreshes, and proves Rules access as the listener.
  async function verifyAccess(uid,revokedAfter){
    const cred=store.readCredential(agent);
    if(cred.uid!==uid||cred.revokedAfter!==revokedAfter)fail('CREDENTIAL_MISMATCH');
    const ts=createTokenSource({mode,projectId,uid,agent,refreshToken:cred.refreshToken,fetcher,now,getCerts});
    await ts.getIdToken();
    if(ts.authTime!==revokedAfter)fail('REVOKED_AFTER_MISMATCH');
    const docs=await listenerClientFor(ts).runQuery(structuredListenerQuery(key));
    return {authTimeEqualsRevokedAfter:true,listenerQuery:'granted',visibleTasks:docs.length};
  }
  async function existingUser(){const u=await idtk.lookupEmail(email);if(!u)fail('NOT_PROVISIONED');return u;}

  if(op==='status'){
    const u=await idtk.lookupEmail(email);const d=u?await ownerDb.get('private_listeners/'+u.uid):null;
    let config=null,configError=null;if(store.hasConfig(agent)){try{config=store.readConfig(agent);}catch(e){configError=safeCode(e);}}
    return {op,agent,email,uid:u?.uid??null,authDisabled:u?.disabled??null,claimsOk:u?claimsOk(u.claims):null,
      listenerDoc:d?{enabled:d.data.enabled===true,revokedAfter:d.data.revokedAfter??null}:null,
      credentialFile:store.hasCredential(agent),delivery:config?config.delivery:null,configError};
  }
  if(op==='delivery-on'||op==='delivery-off'){
    if(!store.hasCredential(agent))fail('NOT_PROVISIONED');
    const c=store.readConfig(agent);const w=store.writeConfig(agent,{inboxRoot:c.inboxRoot,delivery:op==='delivery-on'});
    return {op,agent,configPath:w.path,sha256:w.sha256,delivery:op==='delivery-on'};
  }
  if(op==='revoke'){
    const u=await existingUser();await listenerDoc(u.uid);
    const cut=secs()+1;
    await ownerDb.commit([{update:{name:ownerDb.name('private_listeners/'+u.uid),fields:{enabled:encodeValue(false),revokedAfter:encodeValue(cut)}},
      updateMask:{fieldPaths:['enabled','revokedAfter']},currentDocument:{exists:true}}]);
    await idtk.revokeTokens(u.uid,secs());await idtk.setDisabled(u.uid,true);
    return {op,agent,uid:u.uid,enabled:false,revokedAfter:cut,authDisabled:true,refreshTokensRevoked:true,
      credentialPath:store.paths(agent).credential,next:'stop the runner (Ctrl+C) and delete the credential file'};
  }
  const provider=await idtk.providerStatus();
  if(!provider.emailPasswordEnabled)fail('PROVIDER_EMAIL_PASSWORD_DISABLED');
  if(provider.disabledUserSignup!==true)fail('PROVIDER_SIGNUP_OPEN');   // security run verdict condition 1: client sign-up must stay blocked
  const owner=await ownerUid();
  if(op==='create'){
    if(await idtk.lookupEmail(email))fail('ALREADY_PROVISIONED');
    const inboxRoot=deps.inboxRoot??join(home,'ResQ-Inbox');
    if(!isAbsolute(inboxRoot))fail('INBOX_ROOT_ABSOLUTE_REQUIRED');
    let password=randomPassword();
    const uid=await idtk.createUser({email,password,displayName:'listener-'+key});
    try{await assertUidFree(uid,owner,{ownDocAllowed:false});}
    catch(e){password=null;try{await idtk.setDisabled(uid,true);}catch{}throw e;}
    await idtk.setClaims(uid,{control_plane_role:'listener',control_plane_agent:agent});
    const s=await signInFresh(uid,password);password=null;
    await ownerDb.commit([{update:{name:ownerDb.name('private_listeners/'+uid),fields:{agent:encodeValue(agent),role:encodeValue('listener'),
      enabled:encodeValue(true),revokedAfter:encodeValue(s.authTime)}},currentDocument:{exists:false}}]);
    store.ensureDir();
    const cred=store.writeCredential(agent,{uid,projectId,revokedAfter:s.authTime,refreshToken:s.refreshToken});
    let config=null;
    if(!store.hasConfig(agent))config=store.writeConfig(agent,{inboxRoot,delivery:false});
    try{fs.lstatSync(inboxRoot);}catch(e){if(e?.code!=='ENOENT')throw e;fs.mkdirSync(inboxRoot);}   // non-recursive
    const v=await verifyAccess(uid,s.authTime);
    return {op,agent,uid,email,revokedAfter:s.authTime,credentialPath:cred.path,credentialSha256:cred.sha256,
      configPath:store.paths(agent).config,configSha256:config?.sha256??'unchanged',delivery:store.readConfig(agent).delivery,inboxRoot,...v};
  }
  // rotate
  const u=await existingUser();
  if(u.disabled)fail('LISTENER_AUTH_DISABLED');
  if(!claimsOk(u.claims))fail('LISTENER_CLAIMS_MISMATCH');
  const doc=await listenerDoc(u.uid);
  if(doc.enabled!==true)fail('LISTENER_DOC_DISABLED');
  await assertUidFree(u.uid,owner,{ownDocAllowed:true});
  const since=secs();
  await idtk.revokeTokens(u.uid,since);
  await sleep(1100);                                   // the new sign-in must be strictly after validSince
  let password=randomPassword();
  await idtk.setPassword(u.uid,password);
  const s=await signInFresh(u.uid,password);password=null;
  if(s.authTime<=doc.revokedAfter||s.authTime<since)fail('AUTH_TIME_NOT_NEWER');
  await ownerDb.commit([{update:{name:ownerDb.name('private_listeners/'+u.uid),fields:{revokedAfter:encodeValue(s.authTime)}},
    updateMask:{fieldPaths:['revokedAfter']},currentDocument:{exists:true}}]);
  const cred=store.writeCredential(agent,{uid:u.uid,projectId,revokedAfter:s.authTime,refreshToken:s.refreshToken});
  const v=await verifyAccess(u.uid,s.authTime);
  return {op,agent,uid:u.uid,previousRevokedAfter:doc.revokedAfter,revokedAfter:s.authTime,refreshTokensRevokedAt:since,
    credentialPath:cred.path,credentialSha256:cred.sha256,...v};
}

// Strict argv: --project resq-agent-control-20260928 --agent Grok|Codex [--rotate|--revoke|--status|--delivery on|off] [--inbox-root <abs>]
export function parseProvisionArgs(argv){
  const a=[...argv];let project=null,agent=null,op='create',inboxRoot;
  const setOp=o=>{if(op!=='create')fail('ARGS_ONE_OPERATION');op=o;};
  while(a.length){
    const f=a.shift();
    if(f==='--project')project=a.shift();
    else if(f==='--agent')agent=a.shift();
    else if(f==='--rotate')setOp('rotate');
    else if(f==='--revoke')setOp('revoke');
    else if(f==='--status')setOp('status');
    else if(f==='--delivery'){const v=a.shift();if(v!=='on'&&v!=='off')fail('ARGS_DELIVERY');setOp('delivery-'+v);}
    else if(f==='--inbox-root')inboxRoot=a.shift();
    else fail('ARGS_UNKNOWN');
  }
  if(project!==PROJECT)fail('ARGS_PROJECT');   // no default project
  if(!Object.hasOwn(LISTENER_AGENTS,agent))fail('ARGS_AGENT');
  if(inboxRoot!==undefined&&(op!=='create'||typeof inboxRoot!=='string'||!/^[A-Za-z]:\\(?![\\/])/.test(inboxRoot)))fail('ARGS_INBOX_ROOT');
  return {project,agent,op,inboxRoot};
}
// The owner's existing firebase-tools login (same pattern as the read-only capture scripts). Token stays in memory.
function ownerTokenSource(){
  const appData=process.env.APPDATA;
  if(typeof appData!=='string'||!isAbsolute(appData))fail('OWNER_SESSION_UNAVAILABLE');
  const base=join(appData,'npm','node_modules','firebase-tools','lib');
  const req=createRequire(import.meta.url);
  let logger,auth;
  try{logger=req(join(base,'logger.js')).logger;logger.silent=true;logger.clear?.();auth=req(join(base,'auth.js'));}catch{fail('OWNER_SESSION_UNAVAILABLE');}
  let token=null,until=0;
  return async()=>{
    if(token&&Date.now()<until)return token;
    const acct=auth.getAllAccounts().find(x=>x.user?.email?.toLowerCase()===OWNER_EMAIL);
    if(!acct?.tokens)fail('NO_STORED_OWNER_SESSION');
    if(acct.tokens.access_token&&Number(acct.tokens.expires_at)>Date.now()+300000){token=acct.tokens.access_token;until=Number(acct.tokens.expires_at)-120000;return token;}
    if(!acct.tokens.refresh_token)fail('NO_REFRESH_CREDENTIAL');
    let r;try{r=await auth.getAccessToken(acct.tokens.refresh_token,acct.tokens.scopes||['https://www.googleapis.com/auth/cloud-platform']);}catch{fail('SESSION_REFRESH_REJECTED');}
    if(!r?.access_token)fail('SESSION_REFRESH_REJECTED');
    token=r.access_token;until=Date.now()+30*60000;return token;
  };
}
async function main(){
  if(process.platform!=='win32')fail('PROVISION_WINDOWS_ONLY');
  const args=parseProvisionArgs(process.argv.slice(2));
  const ownerToken=ownerTokenSource();const home=homedir();
  const deps={mode:'production',projectId:PROJECT,fetcher:fetch,home,inboxRoot:args.inboxRoot,
    idtk:createIdentityAdmin({projectId:PROJECT,accessToken:ownerToken}),
    ownerDb:createFirestoreClient({base:FIRESTORE_URL,projectId:PROJECT,token:ownerToken,userProject:PROJECT}),
    store:createCredentialStore({home,protector:createWindowsProtector()}),
    listenerClientFor:ts=>createFirestoreClient({base:FIRESTORE_URL,projectId:PROJECT,token:()=>ts.getIdToken()})};
  return provisionListener({op:args.op,agent:args.agent,deps});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().then(r=>{process.stdout.write(JSON.stringify({status:'OK',...r},null,1)+'\n');},
    e=>{process.stderr.write(JSON.stringify({status:'FAILED',code:safeCode(e)})+'\n');process.exitCode=1;});
}
