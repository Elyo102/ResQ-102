// Unit tests for the LD listener runner, its real Firestore REST adapter, identity/credential handling and the
// owner provisioning script (security provisioning verdict 30/09/2026). Synthetic tokens and fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,realpathSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requestJson,decodeJwt,verifyListenerClaims,verifyIdToken,createTokenSource,SafeError,PROJECT,PROJECT_NUMBER,
  SECURETOKEN_URL,CERTS_URL,LISTENER_AGENTS,FATAL_AUTH} from './listener/listener-auth.mjs';
import {firestoreBase,encodeValue,decodeFields,createListenerOps,createFirestoreClient,structuredListenerQuery,POLL_MS,FIRESTORE_URL} from './listener/firestore-rest.mjs';
import {createCredentialStore,listenerPaths} from './listener/credential-store.mjs';
import {aclVerdict,createWindowsProtector,SCRIPTS,POWERSHELL} from './listener/win-protect.mjs';
import {createIdentityAdmin} from './listener/identity-admin.mjs';
import {provisionListener,parseProvisionArgs,listenerEmail} from './provision-listener.mjs';
import {startRunner,parseRunnerArgs,EXIT,MAX_POLL_FAILURES} from './task-listener-run.mjs';
import {HEARTBEAT_MS} from './task-listener.mjs';

const UID='listenerUid123';const NOW=1790000000000;const S=Math.floor(NOW/1000);
const code=c=>e=>e instanceof SafeError&&e.code===c;
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const PEM=publicKey.export({type:'spki',format:'pem'});
const claims=(x={})=>({aud:PROJECT,iss:'https://securetoken.google.com/'+PROJECT,sub:UID,user_id:UID,auth_time:S-100,iat:S-10,exp:S+3500,
  control_plane_role:'listener',control_plane_agent:'Grok',firebase:{sign_in_provider:'password'},...x});
function rs256(body,kid='k1'){const h=b64({alg:'RS256',kid,typ:'JWT'}),p=b64(body);const s=createSign('RSA-SHA256');s.update(h+'.'+p);s.end();return h+'.'+p+'.'+s.sign(privateKey).toString('base64url');}
const unsigned=body=>b64({alg:'none',typ:'JWT'})+'.'+b64(body)+'.';
const resp=(status,body)=>new Response(body===undefined?'':JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const getCerts=async()=>({k1:PEM});

test('requestJson: bounded, redirect:error, safe codes only (upstream allowlist or HTTP_<n>), never the body',async()=>{
  let seen;const f=async(u,o)=>{seen=o;return resp(400,{error:{message:'TOKEN_EXPIRED : secret-detail-xyz',status:'INVALID_ARGUMENT'}});};
  await assert.rejects(requestJson(f,'https://x.test/'),e=>e.code==='TOKEN_EXPIRED'&&!String(e.message).includes('secret')&&!e.stack.includes('secret-detail'));
  assert.equal(seen.redirect,'error');assert.ok(seen.signal);
  await assert.rejects(requestJson(async()=>resp(500,{error:{message:'internal leak sk-123'}}),'https://x.test/'),e=>e.code==='HTTP_500'&&!e.message.includes('leak'));
  await assert.rejects(requestJson(async()=>resp(403,{error:{code:403,message:'Missing or insufficient permissions.',status:'PERMISSION_DENIED'}}),'https://x.test/'),code('PERMISSION_DENIED'));
  await assert.rejects(requestJson(async()=>new Response('x'.repeat(2000)),'https://x.test/',{},{maxBytes:1000}),code('RESPONSE_TOO_LARGE'));
  await assert.rejects(requestJson(async()=>{throw Error('ECONNRESET token=abc');},'https://x.test/'),e=>e.code==='NETWORK'&&!e.message.includes('abc'));
  assert.equal(await requestJson(async()=>resp(404,{error:{}}),'https://x.test/',{},{allow404:true}),null);
});

test('ID token claims: listener role + agent + uid + project + integer auth_time; budget/authorization claims and other agents rejected',()=>{
  assert.equal(verifyListenerClaims(claims(),{projectId:PROJECT,uid:UID,agent:'Grok',now:NOW}),S-100);
  for(const bad of [{aud:'other'},{iss:'https://securetoken.google.com/other'},{sub:'x'},{user_id:'x'},{control_plane_role:'publisher'},{control_plane_role:undefined},
    {control_plane_agent:'Codex'},{control_plane_budget:true},{control_plane_budget:false},{control_plane_authorization:'x'},{auth_time:'1'},{auth_time:1.5},
    {auth_time:S+3600},{exp:S-1},{iat:S-200}])
    assert.throws(()=>verifyListenerClaims(claims(bad),{projectId:PROJECT,uid:UID,agent:'Grok',now:NOW}),code('TOKEN_CLAIMS'),JSON.stringify(bad));
  assert.throws(()=>verifyListenerClaims(claims({control_plane_agent:'Gemini'}),{projectId:PROJECT,uid:UID,agent:'Gemini',now:NOW}),code('TOKEN_CLAIMS'));
  assert.deepEqual(Object.keys(LISTENER_AGENTS),['Grok','Codex']);
});

test('production verification: RS256 with a known kid only; unsigned, wrong key, unknown kid rejected; emulator mode needs demo-* and unsigned',async()=>{
  const o={mode:'production',projectId:PROJECT,uid:UID,agent:'Grok',getCerts,now:NOW};
  assert.equal(await verifyIdToken(rs256(claims()),o),S-100);
  await assert.rejects(verifyIdToken(unsigned(claims()),o),code('TOKEN_SIGNATURE'));
  await assert.rejects(verifyIdToken(rs256(claims(),'k2'),o),code('TOKEN_SIGNATURE'));
  const t=rs256(claims());const parts=t.split('.');parts[1]=b64(claims({control_plane_agent:'Codex'}));
  await assert.rejects(verifyIdToken(parts.join('.'),{...o,agent:'Codex'}),code('TOKEN_SIGNATURE'));
  await assert.rejects(verifyIdToken(rs256(claims()),{...o,projectId:'demo-x'}),code('PROJECT_REJECTED'));
  const eo={mode:'emulator',projectId:'demo-e2e',uid:UID,agent:'Grok',now:NOW};
  const ec=claims({aud:'demo-e2e',iss:'https://securetoken.google.com/demo-e2e'});
  assert.equal(await verifyIdToken(unsigned(ec),eo),S-100);
  await assert.rejects(verifyIdToken(unsigned(ec),{...eo,projectId:PROJECT}),code('EMULATOR_PROJECT_REJECTED'));
  await assert.rejects(verifyIdToken(unsigned(ec),{...eo,mode:'debug'}),code('MODE_REJECTED'));
  assert.throws(()=>decodeJwt('a.b'),code('TOKEN_FORMAT'));
});

function secureTokenFake({authTime=S-100,userId=UID,projectNumber=PROJECT_NUMBER,error=null,clock=()=>NOW}={}){
  const calls=[];let at=authTime;
  const f=async(url,o)=>{
    calls.push(url);
    if(url===CERTS_URL)return resp(200,{k1:PEM});
    assert.equal(url,SECURETOKEN_URL);assert.equal(o.method,'POST');
    const p=new URLSearchParams(o.body);assert.equal(p.get('grant_type'),'refresh_token');
    if(error)return resp(400,{error:{message:error}});
    const n=Math.floor(clock()/1000);
    return resp(200,{id_token:rs256(claims({auth_time:at,iat:n-10,exp:n+3500})),refresh_token:p.get('refresh_token'),user_id:userId,project_id:projectNumber,expires_in:'3600'});
  };
  f.calls=calls;f.setAuthTime=v=>{at=v;};return f;
}
test('token source: exchange + verify, cached until 5 min before expiry, auth_time must never change, dead credential is fatal',async()=>{
  let now=NOW;const f=secureTokenFake({clock:()=>now});
  const ts=createTokenSource({projectId:PROJECT,uid:UID,agent:'Grok',refreshToken:'r'.repeat(40),fetcher:f,now:()=>now});
  const t1=await ts.getIdToken();assert.equal(ts.authTime,S-100);assert.equal(await ts.getIdToken(),t1);
  assert.equal(f.calls.filter(u=>u===SECURETOKEN_URL).length,1);
  now+=3400*1000;await ts.getIdToken();assert.equal(f.calls.filter(u=>u===SECURETOKEN_URL).length,2);
  f.setAuthTime(S-50);now+=3400*1000;await assert.rejects(ts.getIdToken(),code('AUTH_TIME_CHANGED'));
  await assert.rejects(createTokenSource({projectId:PROJECT,uid:UID,agent:'Grok',refreshToken:'r'.repeat(40),fetcher:secureTokenFake({userId:'other1'}),now:()=>NOW}).getIdToken(),code('IDENTITY_MISMATCH'));
  await assert.rejects(createTokenSource({projectId:PROJECT,uid:UID,agent:'Grok',refreshToken:'r'.repeat(40),fetcher:secureTokenFake({projectNumber:'1'}),now:()=>NOW}).getIdToken(),code('IDENTITY_MISMATCH'));
  for(const err of FATAL_AUTH){
    const d=createTokenSource({projectId:PROJECT,uid:UID,agent:'Grok',refreshToken:'r'.repeat(40),fetcher:secureTokenFake({error:err}),now:()=>NOW});
    await assert.rejects(d.getIdToken(),code(err));assert.equal(d.fatal,err);await assert.rejects(d.getIdToken(),code(err));
  }
  const soft=createTokenSource({projectId:PROJECT,uid:UID,agent:'Grok',refreshToken:'r'.repeat(40),fetcher:async()=>resp(503,{}),now:()=>NOW});
  await assert.rejects(soft.getIdToken(),code('HTTP_503'));assert.equal(soft.fatal,null);
  for(const bad of [{agent:'Gemini'},{agent:'Claude'},{uid:'a/b'},{refreshToken:'short'},{projectId:'station-102'}])
    assert.throws(()=>createTokenSource({projectId:PROJECT,uid:UID,agent:'Grok',refreshToken:'r'.repeat(40),...bad}));
});

function restFake(){
  const reqs=[];const handlers={query:()=>[],commit:w=>({writeResults:w.map(()=>({})),commitTime:'2026-09-30T00:00:00Z'}),get:()=>null};
  const f=async(url,o)=>{
    const body=o.body?JSON.parse(o.body):null;reqs.push({url,method:o.method,auth:o.headers.Authorization,body});
    if(url.endsWith(':runQuery'))return resp(200,handlers.query(body));
    if(url.endsWith(':commit'))return resp(200,handlers.commit(body.writes));
    const r=handlers.get(url);return r?resp(200,r):resp(404,{error:{status:'NOT_FOUND'}});
  };
  return {f,reqs,handlers};
}
test('REST adapter: endpoint guards; exact listener query; progress = ONE masked update of progress.<key> + REQUEST_TIME; heartbeat set; own key only',async()=>{
  assert.equal(firestoreBase({mode:'production',projectId:PROJECT}),FIRESTORE_URL);
  assert.throws(()=>firestoreBase({mode:'production',projectId:'station-102'}),code('PROJECT_REJECTED'));
  assert.equal(firestoreBase({mode:'emulator',projectId:'demo-x',emulatorHost:'127.0.0.1:8191'}),'http://127.0.0.1:8191');
  for(const h of ['127.0.0.1:8080','localhost:8191','10.0.0.1:8191',undefined])assert.throws(()=>firestoreBase({mode:'emulator',projectId:'demo-x',emulatorHost:h}),code('EMULATOR_HOST_REJECTED'));
  assert.throws(()=>firestoreBase({mode:'emulator',projectId:PROJECT,emulatorHost:'127.0.0.1:8191'}),code('EMULATOR_PROJECT_REJECTED'));
  const {f,reqs,handlers}=restFake();
  const client=createFirestoreClient({base:FIRESTORE_URL,projectId:PROJECT,token:async()=>'ID-TOKEN',fetcher:f});
  const timers=[];const ops=createListenerOps({client,key:'grok',setTimer:(fn,ms)=>{timers.push([fn,ms]);return timers.length;},clearTimer:()=>{}});
  const ID='3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
  handlers.query=()=>[{readTime:'t'},{document:{name:`projects/${PROJECT}/databases/(default)/documents/active_tasks/${ID}`,fields:{
    taskId:{stringValue:ID},payload:{stringValue:'שלום'},targets:encodeValue({grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'}),status:{stringValue:'PENDING'},
    timestamp:{timestampValue:'2026-09-30T10:00:00Z'},dispatchedBy:{stringValue:'o'},progress:{mapValue:{}}}}}];
  const snaps=[];const stop=ops.watchTasks({key:'grok',limit:5,next:s=>snaps.push(s),error:()=>{}});
  await new Promise(r=>setImmediate(r));
  assert.equal(timers[0][1],POLL_MS);assert.equal(POLL_MS,120000);
  assert.deepEqual(reqs[0].body,{structuredQuery:structuredListenerQuery('grok')});
  assert.deepEqual(structuredListenerQuery('grok'),{from:[{collectionId:'active_tasks'}],where:{fieldFilter:{field:{fieldPath:'targets.grok'},op:'EQUAL',value:{stringValue:'EXECUTE'}}},orderBy:[{field:{fieldPath:'timestamp'},direction:'DESCENDING'}],limit:5});
  assert.equal(reqs[0].auth,'Bearer ID-TOKEN');assert.match(reqs[0].url,/^https:\/\/firestore\.googleapis\.com\/v1\/projects\/resq-agent-control-20260928\/databases\/\(default\)\/documents:runQuery$/);
  assert.equal(snaps.length,1);assert.equal(snaps[0].fromCache,false);assert.equal(snaps[0].hasPendingWrites,false);
  assert.deepEqual(snaps[0].docs[0],{id:ID,data:{taskId:ID,payload:'שלום',targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},status:'PENDING',timestamp:{timestamp:'2026-09-30T10:00:00Z'},dispatchedBy:'o',progress:{}}});
  stop();await timers[0][0]();assert.equal(snaps.length,1,'no snapshot after stop');
  assert.throws(()=>ops.watchTasks({key:'codex',limit:5,next(){},error(){}}),code('LISTENER_KEY'));
  assert.throws(()=>ops.watchTasks({key:'grok',limit:20,next(){},error(){}}),code('LISTENER_LIMIT'));
  reqs.length=0;
  await ops.writeProgress(ID,'grok',{state:'READY',step:'delivered'});
  assert.deepEqual(reqs[0].body,{writes:[{update:{name:`projects/${PROJECT}/databases/(default)/documents/active_tasks/${ID}`,fields:{progress:{mapValue:{fields:{grok:{mapValue:{fields:{state:{stringValue:'READY'},step:{stringValue:'delivered'}}}}}}}}},
    updateMask:{fieldPaths:['progress.grok']},updateTransforms:[{fieldPath:'progress.grok.updatedAt',setToServerValue:'REQUEST_TIME'}],currentDocument:{exists:true}}]});
  await ops.writeHeartbeat('grok');
  assert.deepEqual(reqs[1].body,{writes:[{update:{name:`projects/${PROJECT}/databases/(default)/documents/task_listeners/grok`,fields:{agent:{stringValue:'grok'}}},updateTransforms:[{fieldPath:'seenAt',setToServerValue:'REQUEST_TIME'}]}]});
  await assert.rejects(ops.writeProgress(ID,'codex',{state:'READY',step:'delivered'}),code('LISTENER_KEY'));
  await assert.rejects(ops.writeHeartbeat('codex'),code('LISTENER_KEY'));
  for(const e of [{state:'PENDING',step:'x'},{state:'READY',step:'started'},{state:'COMPLETED',step:'done'},{state:'CANCELLED',step:'x'},null])
    await assert.rejects(ops.writeProgress(ID,'grok',e),code('PROGRESS_ENTRY'));
  await assert.rejects(ops.writeProgress('../x','grok',{state:'READY',step:'delivered'}),code('TASK_ID'));
  assert.equal(await ops.readTask(ID),null);
  await assert.rejects(client.get('../../x'),code('DOC_PATH'));
  assert.deepEqual(decodeFields({a:{integerValue:'7'},b:{booleanValue:true},c:{nullValue:null},d:{arrayValue:{values:[{stringValue:'x'}]}}}),{a:7,b:true,c:null,d:['x']});
});
test('REST adapter: overlapping polls are skipped; a failed poll reports error without a snapshot',async()=>{
  let release;const pending=new Promise(r=>{release=r;});let calls=0;
  const client={runQuery:async()=>{calls++;if(calls===1){await pending;return [];}throw new SafeError('HTTP_503');}};
  const timers=[];const polls=[];
  const ops=createListenerOps({client,key:'grok',setTimer:fn=>{timers.push(fn);return 1;},clearTimer:()=>{},onPoll:(ok,e)=>polls.push([ok,e?.code])});
  const snaps=[],errs=[];ops.watchTasks({key:'grok',limit:5,next:s=>snaps.push(s),error:e=>errs.push(e.code)});
  await timers[0]();assert.equal(calls,1,'busy: second poll skipped');
  release();await new Promise(r=>setImmediate(r));assert.equal(snaps.length,1);
  await timers[0]();assert.deepEqual(errs,['HTTP_503']);assert.deepEqual(polls,[[true,undefined],[false,'HTTP_503']]);
});

// Reversible fake DPAPI (tests only) + ACL result switch.
function fakeProtector(){
  const p={acl:null,locked:[],broken:false};
  p.protect=b=>Buffer.concat([Buffer.from('DPAPI:'),Buffer.from(b).map(x=>x^0x5a)]);
  p.unprotect=b=>{if(p.broken||!Buffer.from(b).subarray(0,6).equals(Buffer.from('DPAPI:')))throw Error('bad');return Buffer.from(b).subarray(6).map(x=>x^0x5a);};
  p.checkAcl=()=>{if(p.acl)throw new SafeError(p.acl);};
  p.lockDown=d=>p.locked.push(d);
  return p;
}
const tmp=()=>realpathSync(mkdtempSync(join(tmpdir(),'resq-listener-unit-')));
test('credential store: DPAPI-protected refresh token (never plain on disk), ACL + DPAPI fail closed, fixed location, no links, not in git',()=>{
  const home=tmp();const prot=fakeProtector();const store=createCredentialStore({home,protector:prot});
  assert.throws(()=>store.readCredential('Grok'));
  store.ensureDir();assert.deepEqual(prot.locked,[join(home,'.resq-listeners')]);
  const w=store.writeCredential('Grok',{uid:UID,projectId:PROJECT,revokedAfter:S-100,refreshToken:'REFRESH-'+'x'.repeat(40)});
  assert.equal(w.path,join(home,'.resq-listeners','grok.credential.json'));assert.match(w.sha256,/^[a-f0-9]{64}$/);
  const disk=readFileSync(w.path,'utf8');assert.doesNotMatch(disk,/REFRESH-/);
  assert.deepEqual(Object.keys(JSON.parse(disk)),['v','agent','uid','projectId','revokedAfter','protected']);
  assert.deepEqual({...store.readCredential('Grok')},{agent:'Grok',uid:UID,projectId:PROJECT,revokedAfter:S-100,refreshToken:'REFRESH-'+'x'.repeat(40)});
  assert.deepEqual(readdirSync(join(home,'.resq-listeners')).sort(),['grok.credential.json'],'no temp files left');
  assert.throws(()=>store.readCredential('Codex'));
  prot.acl='ACL_OTHER_PRINCIPAL';assert.throws(()=>store.readCredential('Grok'),code('ACL_OTHER_PRINCIPAL'));prot.acl=null;
  prot.broken=true;assert.throws(()=>store.readCredential('Grok'),code('CREDENTIAL_UNPROTECT'));prot.broken=false;
  const d=JSON.parse(disk);writeFileSync(w.path,JSON.stringify({...d,extra:1}));assert.throws(()=>store.readCredential('Grok'),code('CREDENTIAL_SHAPE'));
  writeFileSync(w.path,JSON.stringify({...d,agent:'Codex'}));assert.throws(()=>store.readCredential('Grok'),code('CREDENTIAL_SHAPE'));
  store.writeConfig('Grok',{inboxRoot:'/inbox',delivery:false});assert.deepEqual({...store.readConfig('Grok')},{inboxRoot:'/inbox',delivery:false});
  writeFileSync(listenerPaths(home,'Grok').config,JSON.stringify({inboxRoot:'/i',delivery:true,autostart:true}));assert.throws(()=>store.readConfig('Grok'),code('CONFIG_UNKNOWN_KEY'));
  writeFileSync(listenerPaths(home,'Grok').config,JSON.stringify({inboxRoot:'/i',delivery:'true'}));assert.throws(()=>store.readConfig('Grok'),code('CONFIG_SHAPE'));
  assert.throws(()=>listenerPaths(home,'Gemini'),code('AGENT_REJECTED'));assert.throws(()=>listenerPaths(home,'Claude'),code('AGENT_REJECTED'));
  // linked folder, git worktree, work\ segment
  const h2=tmp();const real=join(h2,'real');mkdirSync(real);symlinkSync(real,join(h2,'.resq-listeners'));
  assert.throws(()=>createCredentialStore({home:h2,protector:fakeProtector()}).ensureDir(),code('CREDENTIAL_LINK_REJECTED'));
  const h3=tmp();mkdirSync(join(h3,'.git'));assert.throws(()=>createCredentialStore({home:h3,protector:fakeProtector()}).ensureDir(),code('CREDENTIAL_IN_GIT_WORKTREE'));
  const h4=join(tmp(),'work');mkdirSync(h4);assert.throws(()=>createCredentialStore({home:h4,protector:fakeProtector()}).ensureDir(),code('CREDENTIAL_UNDER_WORK'));
  assert.throws(()=>createCredentialStore({home:'relative',protector:fakeProtector()}),code('HOME_REJECTED'));
  assert.throws(()=>createCredentialStore({home,protector:{}}),code('PROTECTOR_REQUIRED'));
});
test('Windows protector: ACL policy; fixed PowerShell binary, constant scripts, data on stdin only, no shell; other OS fail closed',()=>{
  const me='S-1-5-21-1-2-3-1001';const ok={me,owner:me,protected:true,rules:[{sid:me,type:'Allow',inherited:false}]};
  assert.equal(aclVerdict(ok,{directory:true}),null);
  assert.equal(aclVerdict({...ok,rules:{sid:me,type:'Allow'}},{directory:true}),null,'single rule serialised as object');
  assert.equal(aclVerdict({...ok,protected:false},{directory:true}),'ACL_INHERITANCE');
  assert.equal(aclVerdict({...ok,protected:false,rules:[{sid:me,type:'Allow',inherited:true}]},{directory:false}),null);
  assert.equal(aclVerdict({...ok,owner:'S-1-5-32-544'},{directory:true}),'ACL_OWNER');
  for(const sid of ['S-1-5-18','S-1-5-32-544','S-1-1-0','S-1-5-11','S-1-5-21-1-2-3-1002'])
    assert.equal(aclVerdict({...ok,rules:[...ok.rules,{sid,type:'Allow'}]},{directory:true}),'ACL_OTHER_PRINCIPAL',sid);
  assert.equal(aclVerdict({...ok,rules:[]},{directory:true}),'ACL_EMPTY');
  assert.equal(aclVerdict({...ok,me:'S-1-5-18'},{directory:true}),'ACL_UNKNOWN_USER');
  const calls=[];const spawn=(bin,args,o)=>{calls.push({bin,args,o});return {status:0,stdout:args[5]===SCRIPTS.acl?JSON.stringify(ok):args[5]===SCRIPTS.lockdown?'ok':Buffer.from('cipher').toString('base64')};};
  const p=createWindowsProtector({platform:'win32',spawn,exists:()=>true});
  p.protect(Buffer.from('secret-refresh'));p.checkAcl('C:\\Users\\User\\.resq-listeners',{directory:true});p.lockDown('C:\\Users\\User\\.resq-listeners');
  for(const c of calls){
    assert.equal(c.bin,POWERSHELL);assert.deepEqual(c.args.slice(0,5),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command']);
    assert.ok(Object.values(SCRIPTS).includes(c.args[5]));assert.equal(c.args.length,6);assert.equal(c.o.shell,false);assert.ok(c.o.timeout>0);
  }
  assert.equal(calls[0].o.input,Buffer.from('secret-refresh').toString('base64'));assert.ok(!calls[0].args.join(' ').includes('secret'));
  assert.equal(calls[1].o.input,'C:\\Users\\User\\.resq-listeners');
  for(const s of Object.values(SCRIPTS))assert.doesNotMatch(s,/"/,'single quotes only');
  assert.match(SCRIPTS.protect,/'CurrentUser'/);assert.match(SCRIPTS.unprotect,/'CurrentUser'/);assert.doesNotMatch(SCRIPTS.protect,/LocalMachine/);
  const bad=createWindowsProtector({platform:'win32',spawn:()=>({status:1,stdout:'',stderr:'Access denied C:\\secret'}),exists:()=>true});
  assert.throws(()=>bad.unprotect(Buffer.from('x')),e=>e.code==='PROTECTOR_UNPROTECT_FAILED'&&!e.message.includes('secret'));
  assert.throws(()=>createWindowsProtector({platform:'linux'}).protect(Buffer.from('x')),code('DPAPI_WINDOWS_ONLY'));
  const aclBad=createWindowsProtector({platform:'win32',spawn:()=>({status:0,stdout:JSON.stringify({...ok,rules:[...ok.rules,{sid:'S-1-1-0',type:'Allow'}]})}),exists:()=>true});
  assert.throws(()=>aclBad.checkAcl('C:\\x',{directory:false}),code('ACL_OTHER_PRINCIPAL'));
});
test('CLIs: strict arguments (explicit project, Grok|Codex only, one operation); runner takes only --agent',()=>{
  assert.deepEqual(parseProvisionArgs(['--project',PROJECT,'--agent','Grok']),{project:PROJECT,agent:'Grok',op:'create',inboxRoot:undefined});
  assert.equal(parseProvisionArgs(['--project',PROJECT,'--agent','Codex','--rotate']).op,'rotate');
  assert.equal(parseProvisionArgs(['--project',PROJECT,'--agent','Codex','--delivery','on']).op,'delivery-on');
  assert.equal(parseProvisionArgs(['--project',PROJECT,'--agent','Grok','--inbox-root','C:\\Users\\User\\ResQ-Inbox']).inboxRoot,'C:\\Users\\User\\ResQ-Inbox');
  for(const bad of [['--agent','Grok'],['--project','station-102','--agent','Grok'],['--project',PROJECT,'--agent','Gemini'],['--project',PROJECT,'--agent','Claude'],
    ['--project',PROJECT,'--agent','Grok','--rotate','--revoke'],['--project',PROJECT,'--agent','Grok','--force'],['--project',PROJECT,'--agent','Grok','--delivery','yes'],
    ['--project',PROJECT,'--agent','Grok','--inbox-root','\\\\srv\\share'],['--project',PROJECT,'--agent','Grok','--rotate','--inbox-root','C:\\x']])
    assert.throws(()=>parseProvisionArgs(bad),SafeError,bad.join(' '));
  assert.deepEqual(parseRunnerArgs(['--agent','Codex']),{agent:'Codex'});
  for(const bad of [[],['--agent','Gemini'],['--agent','Grok','--delivery'],['--agent','grok'],['--emulator','--agent','Grok']])assert.throws(()=>parseRunnerArgs(bad),SafeError);
});

// Provisioning flow with in-memory fakes (the emulator e2e runs the same code against the Rules).
function provisionFakes(opts={}){
  const {emailEnabled=true,collide=null}=opts;const signupBlocked=Object.hasOwn(opts,'signupBlocked')?opts.signupBlocked:true;
  const users=new Map();const docs=new Map([['private_access/owner',{uid:'ownerUid001'}]]);if(collide)docs.set(collide+'/'+'newUid00001',{agent:'Grok'});
  const log=[];let at=S-100;
  const idtk={
    providerStatus:async()=>({emailPasswordEnabled:emailEnabled,disabledUserSignup:signupBlocked,subtype:'FIREBASE_AUTH'}),
    lookupEmail:async e=>{const u=[...users.values()].find(x=>x.email===e);return u?{...u}:null;},
    createUser:async({email,password})=>{log.push('createUser');assert.ok(password.length>=40);users.set('newUid00001',{uid:'newUid00001',email,password,claims:{},disabled:false});return 'newUid00001';},
    setClaims:async(uid,c)=>{log.push('setClaims');users.get(uid).claims=c;},
    setDisabled:async(uid,d)=>{log.push('setDisabled:'+d);users.get(uid).disabled=d;},
    signInWithPassword:async(email,password)=>{log.push('signIn');const u=users.get('newUid00001');assert.equal(u.password,password);
      return {uid:u.uid,idToken:rs256(claims({sub:u.uid,user_id:u.uid,auth_time:at,iat:at,control_plane_agent:u.claims.control_plane_agent})),refreshToken:'refresh-'+'y'.repeat(40)};}
  };
  const ownerDb={name:p=>'projects/p/databases/(default)/documents/'+p,get:async p=>docs.has(p)?{id:p.split('/')[1],data:docs.get(p)}:null,
    commit:async w=>{log.push('commit');docs.set(w[0].update.name.split('/documents/')[1],decodeFields(w[0].update.fields));return {writeResults:[{}]};}};
  return {idtk,ownerDb,users,docs,log};
}
test('provisioning: provider must be enabled and client sign-up blocked (PROVIDER_SIGNUP_OPEN); uid collision disables the new user before claims/doc; revokedAfter = auth_time of the fresh token',async()=>{
  const base=()=>({mode:'production',projectId:PROJECT,getCerts,now:()=>NOW,sleep:async()=>{},home:tmp()});
  const f0=provisionFakes({emailEnabled:false});
  await assert.rejects(provisionListener({op:'create',agent:'Grok',deps:{...base(),...f0,store:createCredentialStore({home:tmp(),protector:fakeProtector()})}}),code('PROVIDER_EMAIL_PASSWORD_DISABLED'));
  assert.deepEqual(f0.log,[]);
  for(const open of [false,undefined,null,'true']){
    const fs0=provisionFakes({signupBlocked:open});
    await assert.rejects(provisionListener({op:'create',agent:'Grok',deps:{...base(),...fs0,store:createCredentialStore({home:tmp(),protector:fakeProtector()})}}),code('PROVIDER_SIGNUP_OPEN'),String(open));
    await assert.rejects(provisionListener({op:'rotate',agent:'Grok',deps:{...base(),...fs0,store:createCredentialStore({home:tmp(),protector:fakeProtector()})}}),code('PROVIDER_SIGNUP_OPEN'));
    assert.deepEqual(fs0.log,[],'nothing created when sign-up is open');
  }
  for(const col of ['private_publishers','private_budget_publishers','private_listeners']){
    const f=provisionFakes({collide:col});
    await assert.rejects(provisionListener({op:'create',agent:'Grok',deps:{...base(),...f,store:createCredentialStore({home:tmp(),protector:fakeProtector()})}}),SafeError);
    assert.deepEqual(f.log,['createUser','setDisabled:true'],col);assert.equal(f.users.get('newUid00001').disabled,true);
  }
  const f=provisionFakes();const b=base();const store=createCredentialStore({home:b.home,protector:fakeProtector()});
  let tokenForVerify=null;
  const fetcher=async(url,o)=>{assert.equal(url,SECURETOKEN_URL);return resp(200,{id_token:rs256(claims({sub:'newUid00001',user_id:'newUid00001',auth_time:S-100})),user_id:'newUid00001',project_id:PROJECT_NUMBER});};
  const r=await provisionListener({op:'create',agent:'Grok',deps:{...b,...f,store,fetcher,listenerClientFor:ts=>{tokenForVerify=ts;return {runQuery:async()=>[]};}}});
  assert.deepEqual(f.log,['createUser','setClaims','signIn','commit']);
  assert.deepEqual(f.users.get('newUid00001').claims,{control_plane_role:'listener',control_plane_agent:'Grok'});
  assert.deepEqual(f.docs.get('private_listeners/newUid00001'),{agent:'Grok',role:'listener',enabled:true,revokedAfter:S-100});
  assert.equal(r.revokedAfter,S-100);assert.equal(r.authTimeEqualsRevokedAfter,true);assert.equal(r.listenerQuery,'granted');assert.equal(r.delivery,false);
  assert.equal(r.email,listenerEmail('grok',PROJECT));assert.equal(tokenForVerify.authTime,S-100);
  assert.ok(existsSync(join(b.home,'ResQ-Inbox')));
  const out=JSON.stringify(r);assert.doesNotMatch(out,/refresh-|yyyy|password/i);
  await assert.rejects(provisionListener({op:'create',agent:'Grok',deps:{...b,...f,store,fetcher,listenerClientFor:()=>({runQuery:async()=>[]})}}),code('ALREADY_PROVISIONED'));
  await assert.rejects(provisionListener({op:'create',agent:'Gemini',deps:{...b,...f,store}}),code('AGENT_REJECTED'));
});

test('runner: fail-closed startup (config/credential/token), counters-only output, stops on a dead credential and on repeated poll failures',async()=>{
  const home=tmp();const prot=fakeProtector();const store=createCredentialStore({home,protector:prot});store.ensureDir();
  const deps0={mode:'production',projectId:PROJECT,store,getCerts,now:()=>NOW,out:()=>{}};
  await assert.rejects(startRunner({agent:'Grok',deps:{...deps0,fetcher:async()=>resp(500,{})}}));           // no config
  store.writeConfig('Grok',{inboxRoot:join(home,'inbox'),delivery:false});
  await assert.rejects(startRunner({agent:'Grok',deps:{...deps0,fetcher:async()=>resp(500,{})}}));           // no credential
  store.writeCredential('Grok',{uid:UID,projectId:PROJECT,revokedAfter:S-100,refreshToken:'r'.repeat(40)});
  prot.acl='ACL_INHERITANCE';await assert.rejects(startRunner({agent:'Grok',deps:{...deps0,fetcher:secureTokenFake()}}),code('ACL_INHERITANCE'));prot.acl=null;
  await assert.rejects(startRunner({agent:'Grok',deps:{...deps0,fetcher:secureTokenFake({error:'USER_DISABLED'})}}),code('USER_DISABLED'));
  await assert.rejects(startRunner({agent:'Gemini',deps:{...deps0,fetcher:secureTokenFake()}}),code('RUNNER_AGENT_REJECTED'));
  store.writeCredential('Grok',{uid:UID,projectId:PROJECT,revokedAfter:S-50,refreshToken:'r'.repeat(40)});
  await assert.rejects(startRunner({agent:'Grok',deps:{...deps0,fetcher:secureTokenFake()}}),code('CREDENTIAL_OLDER_THAN_REVOCATION'));
  store.writeCredential('Grok',{uid:UID,projectId:PROJECT,revokedAfter:S-100,refreshToken:'r'.repeat(40)});
  // running: firestore fails -> poll failures -> stop(3)
  const st=secureTokenFake();const lines=[];const timers=[];
  const fetcher=async(url,o)=>url.startsWith(FIRESTORE_URL)?resp(503,{error:{message:'payload-secret'}}):st(url,o);
  const r=await startRunner({agent:'Grok',deps:{...deps0,fetcher,pollMs:1111,statusMs:2222,out:l=>lines.push(l),setTimer:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimer:()=>{}}});
  assert.equal(r.listener.config.delivery,false);assert.equal(JSON.parse(lines[0]).heartbeatMs,HEARTBEAT_MS);
  assert.deepEqual(timers.map(t=>t.ms).sort(),[1111,2222,HEARTBEAT_MS].sort());
  const poll=timers.find(t=>t.ms===1111);
  for(let i=0;i<MAX_POLL_FAILURES;i++){await poll.fn();await new Promise(r=>setTimeout(r,5));}
  r.check();assert.equal(await r.done,EXIT.POLL_FAILURES);
  const allowed=['agent','delivery','running','ready','delivered','rejected','cancelledMarkers','errors','pollFailures','lastError','started','heartbeatMs','pollMs','stopped'];
  for(const l of lines){const o=JSON.parse(l);assert.deepEqual(Object.keys(o).filter(k=>!allowed.includes(k)),[]);assert.doesNotMatch(l,/secret|Bearer|eyJ/);}
  assert.equal(JSON.parse(lines.at(-1)).stopped,'poll_failures');assert.equal(JSON.parse(lines.at(-1)).lastError,'HTTP_503');
  // credential dies while running (refresh -> TOKEN_EXPIRED) -> stop with EXIT.CREDENTIAL_DEAD
  let now=NOW,dead=false;const st2=secureTokenFake({clock:()=>now});const st3=secureTokenFake({error:'TOKEN_EXPIRED'});
  const out2=[];
  const r2=await startRunner({agent:'Grok',deps:{...deps0,now:()=>now,out:l=>out2.push(l),fetcher:async(url,o)=>url.startsWith(FIRESTORE_URL)?resp(200,[]):(dead?st3:st2)(url,o),setTimer:()=>1,clearTimer:()=>{}}});
  dead=true;now+=3600*1000;
  await assert.rejects(r2.tokens.getIdToken(),code('TOKEN_EXPIRED'));assert.equal(r2.tokens.fatal,'TOKEN_EXPIRED');
  r2.check();assert.equal(await r2.done,EXIT.CREDENTIAL_DEAD);assert.equal(JSON.parse(out2.at(-1)).stopped,'credential_token_expired');
});

test('static guard: runner/adapter/auth/store never spawn (except the fixed DPAPI helper), eval, import dynamically, read env, log, or call other hosts',()=>{
  const files={'task-listener-run.mjs':{},'listener/firestore-rest.mjs':{},'listener/listener-auth.mjs':{},'listener/credential-store.mjs':{},
    'listener/identity-admin.mjs':{},'listener/win-protect.mjs':{spawn:true},'provision-listener.mjs':{env:true}};
  const HOSTS=['securetoken.googleapis.com','www.googleapis.com','firestore.googleapis.com','identitytoolkit.googleapis.com','securetoken.google.com'];
  for(const [f,allow] of Object.entries(files)){
    const src=readFileSync(new URL('./'+f,import.meta.url),'utf8');const code=src.replace(/^\s*\/\/.*$/gm,'');
    assert.doesNotMatch(code,/\beval\s*\(|new Function|Function\s*\(|\bimport\s*\(|console\.|require\s*\(\s*['"]|marked|markdown/,f);
    if(!allow.spawn)assert.doesNotMatch(code,/child_process|\bspawn|\bexec(?:Sync|File)?\s*\(/,f);
    if(!allow.env)assert.doesNotMatch(code,/process\.env/,f);
    for(const m of code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi))assert.ok(HOSTS.includes(m[1])||(f==='listener/firestore-rest.mjs'&&m[0]==='http://'),f+': '+m[0]);
  }
  const ps=readFileSync(new URL('./listener/win-protect.mjs',import.meta.url),'utf8');
  assert.equal((ps.match(/spawnSync\(|spawn\(/g)||[]).length,1,'exactly one process start');assert.match(ps,/shell:false/);assert.doesNotMatch(ps,/shell:true/);
  const prov=readFileSync(new URL('./provision-listener.mjs',import.meta.url),'utf8');
  assert.deepEqual([...prov.matchAll(/process\.env\.([A-Z_]+)/g)].map(m=>m[1]),['APPDATA']);
  const runner=readFileSync(new URL('./task-listener-run.mjs',import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,'');
  assert.doesNotMatch(runner,/identity-admin|provision-listener|payload|signInWithPassword|password/i,'runner never touches admin identity or payloads');
  assert.doesNotMatch(runner,/emulator['"]?\s*[,:]|--emulator/,'the runner CLI has no emulator switch');
  assert.doesNotMatch(prov,/\.log\(|password['"]?\s*[:,]\s*password\b.*out|stdout\.write\([^)]*password/i);
  for(const f of ['task-listener-run.mjs','provision-listener.mjs','listener/firestore-rest.mjs'])assert.doesNotMatch(readFileSync(new URL('./'+f,import.meta.url),'utf8'),/station-102|--force/,f);
});
