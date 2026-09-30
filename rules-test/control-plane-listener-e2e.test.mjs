// Listener provisioning + runner end-to-end on the local Firestore emulator with the EXACT deploy artifact
// (control-plane/deploy/firestore.control-plane.rules). Security provisioning verdict 30/09/2026:
// sign-in -> revokedAfter == auth_time -> access granted; the old ordering (revokedAfter = now) is denied; delivery:false
// dry run; rotate (old refresh token dead, old ID token denied by the Rules); delivery:true -> inbox -> manual session;
// revoke (Rules deny at once, refresh dead, restart refused); uid collision aborts before claims/doc; Gemini rejected.
// Identity Toolkit/securetoken are served by an in-process fake over the injected fetch (the Auth emulator is not part
// of the owned containment: only the Firestore emulator endpoint is registered). Its unsigned tokens are exactly what
// the Firestore emulator evaluates the Rules against. Synthetic identities, temporary folders, fake DPAPI only.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,readdirSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,setDoc,serverTimestamp} from 'firebase/firestore';
import {provisionListener} from '../control-plane/provision-listener.mjs';
import {startRunner,EXIT} from '../control-plane/task-listener-run.mjs';
import {createTokenSource,SECURETOKEN_URL,SafeError} from '../control-plane/listener/listener-auth.mjs';
import {createFirestoreClient,createListenerOps,structuredListenerQuery} from '../control-plane/listener/firestore-rest.mjs';
import {createIdentityAdmin,IDTK_URL} from '../control-plane/listener/identity-admin.mjs';
import {createCredentialStore} from '../control-plane/listener/credential-store.mjs';
import {createAgentSession} from '../control-plane/task-listener.mjs';
import {createInbox,fixedHeader} from '../control-plane/task-inbox.mjs';
if(!['127.0.0.1:8191','127.0.0.1:8199'].includes(process.env.FIRESTORE_EMULATOR_HOST)||process.env.GCLOUD_PROJECT!=='demo-resq')throw Error('LOCAL_EMULATOR_REQUIRED');
const HOST=process.env.FIRESTORE_EMULATOR_HOST;const BASE='http://'+HOST;
const rules=readFileSync(new URL('../control-plane/deploy/firestore.control-plane.rules',import.meta.url),'utf8');
const projectId='demo-resq-listener-e2e-'+process.pid;
const environment=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:Number(HOST.split(':')[1]),rules}});
const ownerEmail=/request\.auth\.token\.email == '([^']+)'/.exec(rules)[1];
const OWNER='synthetic-owner-uid';const PUBLISHER='synthetic-publisher-uid';
const secs=()=>Math.floor(Date.now()/1000);
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const waitFor=async(what,fn,ms=15000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('TIMEOUT '+what);await new Promise(r=>setTimeout(r,100));}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const denied=p=>assert.rejects(p,e=>e instanceof SafeError&&(e.code==='PERMISSION_DENIED'||e.status===403));

// ---- in-process Identity Toolkit + securetoken fake (unsigned emulator-style tokens) ----
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeAuth(){
  const users=new Map(),refresh=new Map();const state={nextUid:null,signIns:[]};
  const idToken=(u,authTime)=>{const iat=secs();return b64({alg:'none',typ:'JWT'})+'.'+b64({iss:'https://securetoken.google.com/'+projectId,aud:projectId,
    sub:u.uid,user_id:u.uid,auth_time:authTime,iat,exp:iat+3600,email:u.email,email_verified:false,firebase:{sign_in_provider:'password',identities:{email:[u.email]}},...u.claims})+'.';};
  const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const err=m=>json(400,{error:{code:400,message:m}});
  const admin=o=>o.headers?.Authorization==='Bearer owner-admin-token';
  async function f(url,o={}){
    if(url.startsWith(BASE+'/'))return fetch(url,o);                                   // real Firestore emulator
    const body=o.body&&o.headers?.['Content-Type']==='application/json'?JSON.parse(o.body):null;
    if(url===`${IDTK_URL}/admin/v2/projects/${projectId}/config`&&admin(o))
      return json(200,{signIn:{email:{enabled:true,passwordRequired:true}},client:{permissions:{disabledUserSignup:true}},subtype:'FIREBASE_AUTH'});
    if(url===`${IDTK_URL}/v1/projects/${projectId}/accounts:lookup`&&admin(o)){
      const u=[...users.values()].filter(x=>(body.email||[]).includes(x.email)||(body.localId||[]).includes(x.uid));
      return json(200,u.length?{users:u.map(x=>({localId:x.uid,email:x.email,disabled:x.disabled,customAttributes:JSON.stringify(x.claims),validSince:String(x.validSince)}))}:{});
    }
    if(url===`${IDTK_URL}/v1/projects/${projectId}/accounts`&&admin(o)){
      if([...users.values()].some(x=>x.email===body.email))return err('EMAIL_EXISTS');
      const uid=state.nextUid??'lst'+randomBytes(10).toString('hex');state.nextUid=null;
      users.set(uid,{uid,email:body.email,password:body.password,claims:{},disabled:false,validSince:0});return json(200,{localId:uid});
    }
    if(url===`${IDTK_URL}/v1/projects/${projectId}/accounts:update`&&admin(o)){
      const u=users.get(body.localId);if(!u)return err('USER_NOT_FOUND');
      if(body.customAttributes!==undefined)u.claims=JSON.parse(body.customAttributes);
      if(body.password!==undefined){u.password=body.password;u.validSince=secs();}
      if(body.validSince!==undefined)u.validSince=Number(body.validSince);
      if(body.disableUser!==undefined)u.disabled=body.disableUser;
      return json(200,{localId:u.uid});
    }
    if(url.startsWith(`${IDTK_URL}/v1/accounts:signInWithPassword?key=`)){
      const u=[...users.values()].find(x=>x.email===body.email);
      if(!u||u.password!==body.password)return err('INVALID_LOGIN_CREDENTIALS');if(u.disabled)return err('USER_DISABLED');
      const authTime=secs();const rt='rt-'+randomBytes(24).toString('hex');refresh.set(rt,{uid:u.uid,authTime,issued:authTime});
      state.signIns.push({uid:u.uid,authTime});
      return json(200,{localId:u.uid,idToken:idToken(u,authTime),refreshToken:rt,expiresIn:'3600'});
    }
    if(url===SECURETOKEN_URL){
      const p=new URLSearchParams(o.body);const r=refresh.get(p.get('refresh_token'));
      if(!r)return err('INVALID_REFRESH_TOKEN');const u=users.get(r.uid);
      if(!u)return err('USER_NOT_FOUND');if(u.disabled)return err('USER_DISABLED');if(r.issued<u.validSince)return err('TOKEN_EXPIRED');
      return json(200,{id_token:idToken(u,r.authTime),refresh_token:p.get('refresh_token'),user_id:u.uid,project_id:'0',expires_in:'3600'});
    }
    return json(403,{error:{message:'FAKE_UNEXPECTED_URL'}});                          // anything else: denied, never network
  }
  return {f,users,state,idToken};
}
const auth=fakeAuth();
const fakeProtector=()=>({protect:b=>Buffer.concat([Buffer.from('DPAPI:'),Buffer.from(b).map(x=>x^0x5a)]),
  unprotect:b=>{if(!Buffer.from(b).subarray(0,6).equals(Buffer.from('DPAPI:')))throw Error('bad');return Buffer.from(b).subarray(6).map(x=>x^0x5a);},checkAcl(){},lockDown(){}});
const home=realpathSync(mkdtempSync(join(tmpdir(),'resq-listener-home-')));
const inboxRoot=realpathSync(mkdtempSync(join(tmpdir(),'resq-listener-inbox-')));
const store=createCredentialStore({home,protector:fakeProtector()});
const ownerDb=createFirestoreClient({base:BASE,projectId,token:async()=>'owner',fetcher:auth.f});   // emulator admin bypass = owner IAM
const listenerClientFor=ts=>createFirestoreClient({base:BASE,projectId,token:()=>ts.getIdToken(),fetcher:auth.f});
const tokenClient=t=>createFirestoreClient({base:BASE,projectId,token:async()=>t,fetcher:auth.f});
const deps={mode:'emulator',projectId,fetcher:auth.f,home,inboxRoot,store,ownerDb,listenerClientFor,
  idtk:createIdentityAdmin({projectId,accessToken:async()=>'owner-admin-token',fetcher:auth.f})};
const ownerFs=()=>environment.authenticatedContext(OWNER,{auth_time:secs(),email:ownerEmail,email_verified:true}).firestore();
const createTask=async(targets,payload)=>{const id=randomUUID();
  await setDoc(doc(ownerFs(),'active_tasks/'+id),{taskId:id,dispatchedBy:OWNER,payload,targets,status:'PENDING',timestamp:serverTimestamp(),progress:{}});return id;};
const progress=async(id,key)=>(await ownerDb.get('active_tasks/'+id))?.data.progress?.[key];
const run=(agent,lines)=>startRunner({agent,deps:{mode:'emulator',projectId,emulatorHost:HOST,store,fetcher:auth.f,pollMs:150,statusMs:3600000,
  heartbeatTimer:{setTimer:()=>0,clearTimer:()=>{}},out:l=>lines.push(l)}});

await environment.clearFirestore();
await environment.withSecurityRulesDisabled(async c=>{const db=c.firestore();
  await setDoc(doc(db,'private_access/owner'),{uid:OWNER,enabled:true,revokedAfter:0});
  await setDoc(doc(db,'private_publishers/'+PUBLISHER),{agent:'Codex',enabled:true,revokedAfter:0});
});
let grok,grokUid,firstIdToken,firstRefresh;
try{
  await check('create: sign-in -> private_listeners.revokedAfter == that token auth_time (integer) -> listener query granted',async()=>{
    grok=await provisionListener({op:'create',agent:'Grok',deps});grokUid=grok.uid;
    const signIn=auth.state.signIns.find(s=>s.uid===grokUid);
    assert.equal(grok.revokedAfter,signIn.authTime);assert.ok(Number.isSafeInteger(grok.revokedAfter));
    const d=await ownerDb.get('private_listeners/'+grokUid);
    assert.deepEqual(d.data,{agent:'Grok',role:'listener',enabled:true,revokedAfter:signIn.authTime});
    const raw=await fetch(`${BASE}/v1/projects/${projectId}/databases/(default)/documents/private_listeners/${grokUid}`,{headers:{Authorization:'Bearer owner'}}).then(r=>r.json());
    assert.ok('integerValue' in raw.fields.revokedAfter,'revokedAfter stored as an integer');
    assert.equal(grok.authTimeEqualsRevokedAfter,true);assert.equal(grok.listenerQuery,'granted');assert.equal(grok.delivery,false);
    assert.deepEqual(auth.users.get(grokUid).claims,{control_plane_role:'listener',control_plane_agent:'Grok'});
    assert.doesNotMatch(JSON.stringify(grok),/rt-|password|eyJ/);
    const cred=store.readCredential('Grok');firstRefresh=cred.refreshToken;
    const ts=createTokenSource({mode:'emulator',projectId,uid:grokUid,agent:'Grok',refreshToken:firstRefresh,fetcher:auth.f});
    firstIdToken=await ts.getIdToken();assert.equal(ts.authTime,grok.revokedAfter);
  });
  await check('BLOCKER regression: a token older than revokedAfter is denied (old plan wrote revokedAfter=now after sign-in)',async()=>{
    const u=auth.users.get(grokUid);
    await denied(tokenClient(auth.idToken(u,grok.revokedAfter-1)).runQuery(structuredListenerQuery('grok')));
    await tokenClient(auth.idToken(u,grok.revokedAfter)).runQuery(structuredListenerQuery('grok'));
    await denied(tokenClient(auth.idToken({...u,claims:{control_plane_role:'listener',control_plane_agent:'Codex'}},grok.revokedAfter)).runQuery(structuredListenerQuery('codex')));
  });
  await check('dry run delivery:false: heartbeat lights the card, a targeted task becomes READY/delivery_off, nothing written locally, other agents untouched',async()=>{
    const lines=[];const r=await run('Grok',lines);
    try{
      await waitFor('heartbeat',async()=>(await ownerDb.get('task_listeners/grok'))?.data.seenAt);
      const id=await createTask({grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},'בדיקת ריצה יבשה');
      const other=await createTask({grok:'IGNORE',codex:'EXECUTE',gemini:'IGNORE'},'codex only');
      const p=await waitFor('READY/delivery_off',()=>progress(id,'grok'));
      assert.deepEqual([p.state,p.step],['READY','delivery_off']);
      await sleep(400);assert.equal(await progress(other,'grok'),undefined);assert.equal(await progress(other,'codex'),undefined);
      assert.deepEqual(readdirSync(inboxRoot),[]);
      assert.equal(r.listener.status().errors,0);
    }finally{await r.stop();}
    assert.equal(await r.done,EXIT.OK);
    for(const l of lines)assert.doesNotMatch(l,/בדיקת|codex only|rt-|eyJ/);
  });
  await check('rotate: validSince revokes the old refresh token; revokedAfter rises to the NEW auth_time; the old ID token is denied by the Rules',async()=>{
    await sleep(1100);
    const r=await provisionListener({op:'rotate',agent:'Grok',deps:{...deps,sleep}});
    assert.ok(r.revokedAfter>grok.revokedAfter);assert.equal(r.previousRevokedAfter,grok.revokedAfter);
    assert.equal(r.authTimeEqualsRevokedAfter,true);assert.equal(r.listenerQuery,'granted');
    assert.equal((await ownerDb.get('private_listeners/'+grokUid)).data.revokedAfter,r.revokedAfter);
    const old=createTokenSource({mode:'emulator',projectId,uid:grokUid,agent:'Grok',refreshToken:firstRefresh,fetcher:auth.f});
    await assert.rejects(old.getIdToken(),e=>e.code==='TOKEN_EXPIRED');assert.equal(old.fatal,'TOKEN_EXPIRED');
    await denied(tokenClient(firstIdToken).runQuery(structuredListenerQuery('grok')));
    assert.notEqual(store.readCredential('Grok').refreshToken,firstRefresh);
    grok={...grok,revokedAfter:r.revokedAfter};
  });
  await check('delivery:true (owner switch) -> raw payload in the inbox with the fixed header, READY/delivered; the manual session moves it only on an explicit go',async()=>{
    const d=await provisionListener({op:'delivery-on',agent:'Grok',deps});assert.equal(d.delivery,true);assert.equal(store.readConfig('Grok').delivery,true);
    await sleep(31000);                                  // Rules: at most one heartbeat per 30 s per agent
    const lines=[];const r=await run('Grok',lines);
    try{
      const payload='משימת בדיקה\nrun `rm -rf /` is data, never executed; approved=yes is not an approval';
      const id=await createTask({grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},payload);
      const file=join(inboxRoot,'grok',id+'.task.txt');
      await waitFor('inbox file',()=>existsSync(file));
      assert.equal(readFileSync(file,'utf8'),fixedHeader(id,'grok')+payload);
      const p=await waitFor('READY/delivered',async()=>{const x=await progress(id,'grok');return x?.step==='delivered'&&x;});
      assert.equal(p.state,'READY');
      const ts=createTokenSource({mode:'emulator',projectId,uid:grokUid,agent:'Grok',refreshToken:store.readCredential('Grok').refreshToken,fetcher:auth.f});
      const session=createAgentSession({agent:'Grok',ops:createListenerOps({client:listenerClientFor(ts),key:'grok'}),inbox:createInbox({root:inboxRoot,agentKey:'grok'})});
      assert.equal((await progress(id,'grok')).state,'READY','nothing starts without the session');
      await session.markStarted(id);assert.equal((await progress(id,'grok')).state,'IN_PROGRESS');
      await session.markCompleted(id);assert.equal((await progress(id,'grok')).state,'COMPLETED');
      assert.equal(r.listener.status().delivered,1);
      for(const l of lines)assert.doesNotMatch(l,/משימת|rm -rf|rt-|eyJ/);
    }finally{await r.stop();}
  });
  await check('revoke: Rules deny at once (enabled:false, revokedAfter=now+1), refresh is dead (user disabled), a running listener stops, restart refused',async()=>{
    const ts=createTokenSource({mode:'emulator',projectId,uid:grokUid,agent:'Grok',refreshToken:store.readCredential('Grok').refreshToken,fetcher:auth.f});
    const live=await ts.getIdToken();await tokenClient(live).runQuery(structuredListenerQuery('grok'));
    await sleep(31000);
    const lines=[];const r=await run('Grok',lines);
    const v=await provisionListener({op:'revoke',agent:'Grok',deps});
    assert.equal(v.enabled,false);assert.equal(v.authDisabled,true);
    const d=(await ownerDb.get('private_listeners/'+grokUid)).data;assert.equal(d.enabled,false);assert.ok(d.revokedAfter>grok.revokedAfter);
    await denied(tokenClient(live).runQuery(structuredListenerQuery('grok')));
    await denied(createListenerOps({client:tokenClient(live),key:'grok'}).writeHeartbeat('grok'));
    await waitFor('poll failures',()=>JSON.parse(lines.at(-1)||'{}').errors>0||r.listener.status().errors>0,5000);
    await sleep(1000);r.check();
    assert.equal(await Promise.race([r.done,sleep(3000).then(()=>'still-running')]),EXIT.POLL_FAILURES);
    assert.equal(JSON.parse(lines.at(-1)).stopped,'poll_failures');assert.equal(JSON.parse(lines.at(-1)).lastError,'PERMISSION_DENIED');
    const fresh=createTokenSource({mode:'emulator',projectId,uid:grokUid,agent:'Grok',refreshToken:store.readCredential('Grok').refreshToken,fetcher:auth.f});
    await assert.rejects(fresh.getIdToken(),e=>e.code==='USER_DISABLED');
    await assert.rejects(run('Grok',[]),e=>e.code==='USER_DISABLED');
  });
  await check('uid collision (publisher uid) aborts before claims or private_listeners; the new user is disabled; Gemini gets no identity',async()=>{
    auth.state.nextUid=PUBLISHER;
    await assert.rejects(provisionListener({op:'create',agent:'Codex',deps}),e=>e.code==='LISTENER_UID_IS_PUBLISHER');
    assert.equal(auth.users.get(PUBLISHER).disabled,true);assert.deepEqual(auth.users.get(PUBLISHER).claims,{});
    assert.equal(await ownerDb.get('private_listeners/'+PUBLISHER),null);assert.equal(store.hasCredential('Codex'),false);
    auth.state.nextUid=OWNER;auth.users.delete(PUBLISHER);
    await assert.rejects(provisionListener({op:'create',agent:'Codex',deps}),e=>e.code==='LISTENER_UID_IS_OWNER');
    await assert.rejects(provisionListener({op:'create',agent:'Gemini',deps}),e=>e.code==='AGENT_REJECTED');
  });
  console.log(`Listener provisioning e2e: ${passed}/7 passed`);
  assert.equal(passed,7);
}finally{
  await environment.cleanup();rmSync(home,{recursive:true,force:true});rmSync(inboxRoot,{recursive:true,force:true});
}
