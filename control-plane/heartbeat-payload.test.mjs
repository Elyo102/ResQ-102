import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildHeartbeatPayload,createHeartbeatLimiter,EVENT_SCHEMA_KEYS,HEARTBEAT_MIN_INTERVAL_MS,HEARTBEAT_MAX_PER_RUN} from './heartbeat-payload.mjs';
import {AGENTS,TASK_LABELS} from './core.mjs';
import {publishResult,emitHeartbeat,PROJECT} from '../.github/scripts/telemetry-ci.mjs';

const rules=readFileSync(new URL('./firestore.rules',import.meta.url),'utf8');
const listIn=(re)=>[...rules.match(re)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);

const NAME='projects/resq-agent-control-20260928/databases/(default)/documents/events/0f8fad5b-d9cb-469f-a165-70867728950e';
test('payload matches the deployed validEvent 5-key schema and the receipt commit-write shape',()=>{
 const schema=listIn(/e\.keys\(\)\.hasOnly\(\[([^\]]+)\]\)/);
 assert.deepEqual([...EVENT_SCHEMA_KEYS].sort(),[...schema].sort());
 for(const agent of AGENTS){
  const {event,write}=buildHeartbeatPayload({agent,name:NAME});
  assert.deepEqual(event,{agent,kind:'heartbeat',task:'local_tests',step:'running'});
  assert.deepEqual(Object.keys(write),['update','currentDocument','updateTransforms']);
  assert.deepEqual(Object.keys(write.update),['name','fields']);
  assert.equal(write.update.name,NAME);
  const keys=[...Object.keys(write.update.fields),...write.updateTransforms.map(t=>t.fieldPath)];
  assert.deepEqual(keys.sort(),[...schema].sort());
  assert.deepEqual(write.currentDocument,{exists:false});
  assert.deepEqual(write.updateTransforms,[{fieldPath:'createdAt',setToServerValue:'REQUEST_TIME'}]);
  for(const v of Object.values(write.update.fields))assert.deepEqual(Object.keys(v),['stringValue']);
  assert.ok(Object.isFrozen(event)&&Object.isFrozen(write)&&Object.isFrozen(write.update)&&Object.isFrozen(write.update.fields));
 }
 assert.ok(listIn(/e\.kind in \[([^\]]+)\]/).includes('heartbeat'));
 assert.ok(listIn(/e\.step in \[([^\]]+)\]/).includes('running'));
 assert.deepEqual(listIn(/e\.task in \[([^\]]+)\]/),[...TASK_LABELS]);
 for(const task of TASK_LABELS)assert.equal(buildHeartbeatPayload({agent:'Codex',task,name:NAME}).event.task,task);
});

test('unknown agent, kind, task or document name is rejected',()=>{
 for(const agent of [undefined,'','codex','GPT','Codex ','Other',{},['Codex']])
  assert.throws(()=>buildHeartbeatPayload({agent,name:NAME}),/HEARTBEAT_AGENT_INVALID/);
 for(const kind of ['task_started','test_passed','beat','',null])
  assert.throws(()=>buildHeartbeatPayload({agent:'Codex',kind,name:NAME}),/HEARTBEAT_KIND_INVALID/);
 for(const task of ['unknown','',null,'LOCAL_TESTS'])
  assert.throws(()=>buildHeartbeatPayload({agent:'Codex',task,name:NAME}),/HEARTBEAT_TASK_INVALID/);
 for(const name of [undefined,'',NAME.replace('/events/','/private_access/'),NAME+'x',NAME.replace('0f8fad5b','ZZZZZZZZ'),'events/0f8fad5b-d9cb-469f-a165-70867728950e'])
  assert.throws(()=>buildHeartbeatPayload({agent:'Codex',name}),/HEARTBEAT_NAME_INVALID/);
 assert.throws(()=>buildHeartbeatPayload(),/HEARTBEAT_AGENT_INVALID/);
});

test('rate limiter: >=60s spacing, <=10 per run, clock guards',()=>{
 let t=1_000_000;const lim=createHeartbeatLimiter({now:()=>t});
 assert.equal(lim.tryAcquire().allowed,true);
 t+=59_999;let r=lim.tryAcquire();assert.equal(r.allowed,false);assert.equal(r.reason,'RATE_LIMITED');assert.equal(r.retryInMs,1);
 t+=1;assert.equal(lim.tryAcquire().allowed,true);
 for(let i=0;i<8;i++){t+=60_000;assert.equal(lim.tryAcquire().allowed,true);}
 assert.equal(lim.sent,10);
 t+=3_600_000;r=lim.tryAcquire();assert.equal(r.allowed,false);assert.equal(r.reason,'RUN_CAP_REACHED');
 let u=5_000_000;const back=createHeartbeatLimiter({now:()=>u});back.tryAcquire();u-=1;
 assert.equal(back.tryAcquire().reason,'CLOCK_REGRESSION');
 assert.equal(createHeartbeatLimiter({now:()=>NaN}).tryAcquire().reason,'CLOCK_INVALID');
 assert.equal(HEARTBEAT_MIN_INTERVAL_MS,60000);assert.equal(HEARTBEAT_MAX_PER_RUN,10);
 for(const opts of [{minIntervalMs:59_999},{maxPerRun:11},{maxPerRun:0},{now:1}])
  assert.throws(()=>createHeartbeatLimiter(opts),/HEARTBEAT_LIMITER_INVALID/);
 assert.equal(createHeartbeatLimiter({now:()=>0,maxPerRun:2,minIntervalMs:120000}).tryAcquire().remaining,1);
});

test('only telemetry-ci.mjs imports the module; agent-cycle, workflows and others never do',()=>{
 const src=readFileSync(new URL('./heartbeat-payload.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(src,/\bfetch\s*\(|https?:\/\/|node:(?:http|https|net|tls|child_process|dgram)|process\.env/);
 const root=fileURLToPath(new URL('../',import.meta.url));
 const allowed=new Set(['.github/scripts/telemetry-ci.mjs','control-plane/heartbeat-payload.mjs','control-plane/heartbeat-payload.test.mjs']);
 const skip=new Set(['node_modules','.git','test-results','playwright-report']);const offenders=[];
 (function walk(dir){for(const name of readdirSync(dir)){const full=join(dir,name);const st=statSync(full);
  if(st.isDirectory()){if(!skip.has(name))walk(full);continue;}
  if(!/\.(?:m?js|cjs|ya?ml|json)$/.test(name)||st.size>5*1024*1024)continue;
  const rel=relative(root,full).split(sep).join('/');if(allowed.has(rel))continue;
  if(/heartbeat-payload/.test(readFileSync(full,'utf8')))offenders.push(rel);}})(root);
 assert.deepEqual(offenders,[]);
 assert.match(readFileSync(join(root,'.github/scripts/telemetry-ci.mjs'),'utf8'),/from '\.\.\/\.\.\/control-plane\/heartbeat-payload\.mjs'/);
 assert.doesNotMatch(readFileSync(join(root,'control-plane/agent-cycle.mjs'),'utf8'),/heartbeat-payload/);
 for(const f of readdirSync(join(root,'.github/workflows')))assert.doesNotMatch(readFileSync(join(root,'.github/workflows',f),'utf8'),/heartbeat-payload/,f);
});

// ---- Dry run of the wired CI path with a mocked fetch (no network, synthetic credentials only).
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const certificates={test:keys.publicKey.export({type:'spki',format:'pem'})};
const uid='isolated-ci-publisher';
const env={GITHUB_REPOSITORY:'Elyo102/ResQ-102',GITHUB_REF:'refs/heads/dev',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_SHA:'a'.repeat(40),
 TELEMETRY_APPROVED_SHA:'a'.repeat(40),FIREBASE_TELEMETRY_UID:uid,FIREBASE_TELEMETRY_REFRESH_TOKEN:'synthetic-refresh-not-a-real-secret',TEST_RESULT:'success'};
function idToken(){const now=Math.floor(Date.now()/1000);
 const data=[{alg:'RS256',kid:'test'},{aud:PROJECT,iss:`https://securetoken.google.com/${PROJECT}`,sub:uid,control_plane_agent:'Codex',exp:now+600,iat:now-10,auth_time:now-20}]
  .map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 const signer=createSign('RSA-SHA256');signer.update(data);signer.end();return data+'.'+signer.sign(keys.privateKey).toString('base64url');}
const ALLOWED_HOSTS=new Set(['securetoken.googleapis.com','www.googleapis.com','firestore.googleapis.com']);
const PROVIDER=/anthropic|(?:^|\.)x\.ai$|generativelanguage|openai/i;
function mock({failHeartbeat=false,failReceipt=false,authPatch={},certFailure=false}={}){
 const calls=[];
 const fetcher=async(url,options)=>{calls.push({url,options});const host=new URL(url).hostname;
  assert.ok(ALLOWED_HOSTS.has(host),host);assert.doesNotMatch(host,PROVIDER);
  if(host==='securetoken.googleapis.com')return Response.json({id_token:idToken(),user_id:uid,project_id:'802712493259',...authPatch});
  if(host==='www.googleapis.com')return certFailure?new Response('no',{status:403}):Response.json(certificates);
  const n=JSON.parse(options.body).writes.length;
  if(n===1&&failHeartbeat)throw Error('synthetic failure with bearer secret');
  if(n===3&&failReceipt)throw Error('synthetic receipt failure');
  return Response.json({writeResults:Array(n).fill({}),commitTime:new Date().toISOString()});};
 const heartbeats=()=>calls.filter(c=>c.url.endsWith('/documents:commit')&&JSON.parse(c.options.body).writes.length===1);
 const receipts=()=>calls.filter(c=>c.url.endsWith('/documents:commit')&&JSON.parse(c.options.body).writes.length===3);
 return {fetcher,calls,heartbeats,receipts};
}
const schema=listIn(/e\.keys\(\)\.hasOnly\(\[([^\]]+)\]\)/);

test('wired heartbeat: 5 validEvent keys, same collection/path/token as the receipt',async()=>{
 const m=mock();
 assert.deepEqual(await publishResult(env,m.fetcher,{heartbeatLimiter:createHeartbeatLimiter()}),{status:'accepted',count:3});
 assert.equal(m.heartbeats().length,1);assert.equal(m.receipts().length,1);
 const hbCall=m.heartbeats()[0],rcCall=m.receipts()[0];
 assert.ok(m.calls.indexOf(hbCall)<m.calls.indexOf(rcCall)); // emitted before the receipt
 assert.equal(hbCall.url,`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:commit`);
 assert.equal(hbCall.url,rcCall.url);assert.equal(hbCall.options.headers.Authorization,rcCall.options.headers.Authorization);
 const hbBody=JSON.parse(hbCall.options.body),rcBody=JSON.parse(rcCall.options.body);
 assert.deepEqual(Object.keys(hbBody),['writes']);assert.equal(hbBody.writes.length,1);
 const [w]=hbBody.writes;
 // Exact same commit-write shape as each receipt write: update{name,fields}, currentDocument, updateTransforms.
 const shape=x=>({top:Object.keys(x).sort(),update:Object.keys(x.update).sort(),fields:Object.keys(x.update.fields).sort(),cd:x.currentDocument,ut:x.updateTransforms});
 for(const r of rcBody.writes)assert.deepEqual(shape(w),shape(r));
 for(const r of rcBody.writes)assert.notEqual(w.update.name,r.update.name);
 assert.deepEqual([...Object.keys(w.update.fields),...w.updateTransforms.map(t=>t.fieldPath)].sort(),[...schema].sort());
 assert.deepEqual(Object.fromEntries(Object.entries(w.update.fields).map(([k,v])=>[k,v.stringValue])),{agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running'});
 assert.deepEqual(w.currentDocument,{exists:false});
 assert.match(w.update.name,new RegExp(`^projects/${PROJECT}/databases/\\(default\\)/documents/events/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`));
 // Receipt is byte-for-byte the same shape as before: 3 writes heartbeat/test_passed/task_completed.
 assert.deepEqual(JSON.parse(rcCall.options.body).writes.map(x=>x.update.fields.kind.stringValue),['heartbeat','test_passed','task_completed']);
});

test('no heartbeat when any gate fails or on cancelled/skipped',async()=>{
 const patches=[{GITHUB_REPOSITORY:'fork/ResQ-102'},{GITHUB_REF:'refs/heads/main'},{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_SHA:'xyz'},
  {TELEMETRY_APPROVED_SHA:'b'.repeat(40)},{FIREBASE_TELEMETRY_UID:'bad uid'},{FIREBASE_TELEMETRY_REFRESH_TOKEN:''},{TEST_RESULT:'weird'}];
 for(const patch of patches){const m=mock();await assert.rejects(publishResult({...env,...patch},m.fetcher,{heartbeatLimiter:createHeartbeatLimiter()}),/TELEMETRY_/);
  assert.equal(m.heartbeats().length,0,JSON.stringify(patch));assert.equal(m.receipts().length,0);}
 for(const TEST_RESULT of ['cancelled','skipped']){const m=mock();
  assert.deepEqual(await publishResult({...env,TEST_RESULT},m.fetcher,{heartbeatLimiter:createHeartbeatLimiter()}),{status:'not_emitted',reason:TEST_RESULT});
  assert.equal(m.calls.length,0);}
 for(const opts of [{authPatch:{project_id:'wrong'}},{authPatch:{user_id:'wrong'}},{authPatch:{id_token:'broken'}},{certFailure:true}]){
  const m=mock(opts);await assert.rejects(publishResult(env,m.fetcher,{heartbeatLimiter:createHeartbeatLimiter()}),/TELEMETRY_/);
  assert.equal(m.heartbeats().length,0,JSON.stringify(opts));assert.ok(!m.calls.some(c=>c.url.startsWith('https://firestore.googleapis.com')));}
 // Test failure still emits (allowed) and the receipt still reports the failure.
 const f=mock();await publishResult({...env,TEST_RESULT:'failure'},f.fetcher,{heartbeatLimiter:createHeartbeatLimiter()});
 assert.equal(f.heartbeats().length,1);assert.deepEqual(JSON.parse(f.receipts()[0].options.body).writes.map(x=>x.update.fields.kind.stringValue),['heartbeat','test_failed','task_failed']);
});

test('at most 10 heartbeat writes even when invoked 50 times; <=1 per 60s',async()=>{
 let t=1_000_000;const limiter=createHeartbeatLimiter({now:()=>t});const m=mock();
 const results=[];for(let i=0;i<50;i++){results.push((await emitHeartbeat({fetcher:m.fetcher,idToken:'synthetic',limiter})).status);t+=61_000;}
 assert.equal(m.heartbeats().length,10);assert.equal(results.filter(s=>s==='accepted').length,10);assert.equal(results.filter(s=>s==='rate_limited').length,40);
 const burst=mock();const still=createHeartbeatLimiter({now:()=>5_000_000});
 for(let i=0;i<50;i++)await emitHeartbeat({fetcher:burst.fetcher,idToken:'synthetic',limiter:still});
 assert.equal(burst.heartbeats().length,1);
 // Through the full job path with a shared run limiter: receipts unaffected, heartbeats capped.
 let u=9_000_000;const shared=createHeartbeatLimiter({now:()=>u});const job=mock();
 for(let i=0;i<50;i++){await publishResult(env,job.fetcher,{heartbeatLimiter:shared});u+=61_000;}
 assert.equal(job.heartbeats().length,10);assert.equal(job.receipts().length,50);
 for(const c of job.calls)assert.doesNotMatch(new URL(c.url).hostname,PROVIDER);
});

test('no provider hosts are ever contacted and no provider secret leaks',async()=>{
 const m=mock();await publishResult({...env,ANTHROPIC_API_KEY:'not-for-telemetry',XAI_API_KEY:'nope-xai',GEMINI_API_KEY:'nope-gem'},m.fetcher,{heartbeatLimiter:createHeartbeatLimiter()});
 for(const c of m.calls){assert.ok(ALLOWED_HOSTS.has(new URL(c.url).hostname));assert.doesNotMatch(c.url,/anthropic|x\.ai|generativelanguage/);}
 assert.ok(!JSON.stringify(m.calls).match(/not-for-telemetry|nope-xai|nope-gem/));
});

test('heartbeat failure never throws and never alters the job outcome',async()=>{
 const m=mock({failHeartbeat:true});const logs=[];const orig=[console.log,console.error,console.warn];
 console.log=console.error=console.warn=(...a)=>logs.push(a.join(' '));
 try{
  assert.deepEqual(await publishResult(env,m.fetcher,{heartbeatLimiter:createHeartbeatLimiter()}),{status:'accepted',count:3});
  assert.deepEqual(await emitHeartbeat({fetcher:m.fetcher,idToken:'synthetic',limiter:createHeartbeatLimiter()}),{status:'failed'});
  assert.deepEqual(await emitHeartbeat({fetcher:async()=>{throw Error('x');},idToken:'synthetic',limiter:createHeartbeatLimiter()}),{status:'failed'});
  assert.deepEqual(await emitHeartbeat({fetcher:async()=>new Response('no',{status:500}),idToken:'synthetic',limiter:createHeartbeatLimiter()}),{status:'failed'});
  assert.deepEqual(await emitHeartbeat({fetcher:m.fetcher,idToken:'',limiter:createHeartbeatLimiter()}),{status:'skipped'});
  assert.deepEqual(await emitHeartbeat({fetcher:m.fetcher,idToken:'synthetic',limiter:{tryAcquire(){throw Error('boom');}}}),{status:'failed'});
 }finally{[console.log,console.error,console.warn]=orig;}
 assert.equal(m.receipts().length,1);assert.deepEqual(logs,[]);
 // A heartbeat never hides a receipt failure: the job error comes from the receipt.
 for(const failHeartbeat of [false,true]){const r=mock({failReceipt:true,failHeartbeat});
  await assert.rejects(publishResult(env,r.fetcher,{heartbeatLimiter:createHeartbeatLimiter()}),/^Error: TELEMETRY_DELIVERY_UNKNOWN$/);
  assert.equal(r.receipts().length,1);assert.equal(r.heartbeats().length,1);}
 // Heartbeat failure does not alter a failure result either.
 const ff=mock({failHeartbeat:true});
 assert.deepEqual(await publishResult({...env,TEST_RESULT:'failure'},ff.fetcher,{heartbeatLimiter:createHeartbeatLimiter()}),{status:'accepted',count:3});
 assert.ok(JSON.parse(ff.receipts()[0].options.body).writes.some(x=>x.update.fields.kind.stringValue==='task_failed'));
});
