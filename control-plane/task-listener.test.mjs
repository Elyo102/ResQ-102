// Unit tests for the LD active-task listener library and the hardened inbox (security conditions A1-A6, B2-B4).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateConfig,validateTask,createListener,createAgentSession,listenerQuery,MAX_OPEN,LISTENER_LIMIT} from './task-listener.mjs';
import {createInbox,fixedHeader,CANCELLED_CONTENT,INBOX_DIRS} from './task-inbox.mjs';
const ID='3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const task=(id,extra={})=>({taskId:id,dispatchedBy:'u',payload:'בדיקה',targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},status:'PENDING',timestamp:{},progress:{},...extra});
const tmp=()=>realpathSync(mkdtempSync(join(tmpdir(),'resq-inbox-unit-')));
function fakeOps(){
  const o={writes:[],beats:[],next:null,stopped:0,query:null};
  o.watchTasks=({key,limit,next})=>{o.query={key,limit};o.next=next;return()=>o.stopped++;};
  o.writeProgress=async(id,key,entry)=>{o.writes.push([id,key,entry.state,entry.step,Object.keys(entry).length]);};
  o.writeHeartbeat=async key=>{o.beats.push(key);};
  return o;
}
const noTimer={setTimer:()=>1,clearTimer:()=>{}};

test('config: delivery defaults to false; fixed agent map (Claude rejected); machine allowlist; unknown keys rejected',()=>{
  const c=validateConfig({agent:'Grok',machine:'LD',inboxRoot:'/x'});assert.equal(c.delivery,false);assert.equal(c.key,'grok');
  assert.equal(validateConfig({agent:'Gemini',machine:'LD',inboxRoot:'/x',delivery:true}).delivery,true);
  for(const bad of [{agent:'Claude',machine:'LD',inboxRoot:'/x'},{agent:'grok',machine:'LD',inboxRoot:'/x'},{agent:'Grok',machine:'station-102',inboxRoot:'/x'},
    {agent:'Grok',machine:'LD',inboxRoot:'/x',delivery:'true'},{agent:'Grok',machine:'LD',inboxRoot:'/x',autostart:true},{agent:'Grok',machine:'LD'},null,[]])assert.throws(()=>validateConfig(bad));
  assert.deepEqual(JSON.parse(JSON.stringify(listenerQuery('grok'))),{collection:'active_tasks',where:['targets.grok','==','EXECUTE'],orderBy:['timestamp','desc'],limit:5});
  assert.throws(()=>listenerQuery('claude'));assert.equal(LISTENER_LIMIT,5);
});
test('validateTask mirrors the Rules shape and allowlist; secret-looking payload is "secret"',()=>{
  assert.equal(validateTask(ID,task(ID)),null);
  for(const bad of [task(ID,{extra:1}),task(uuid(1)),task(ID,{payload:'a\tb'}),task(ID,{payload:'“x”'}),task(ID,{payload:'a'.repeat(10001)}),task(ID,{targets:{grok:'EXECUTE'}}),
    task(ID,{targets:{grok:'IGNORE',codex:'IGNORE',gemini:'IGNORE'}}),task(ID,{status:'DONE'}),task(ID,{progress:null})])assert.equal(validateTask(ID,bad),'invalid');
  assert.equal(validateTask('../etc',task('../etc')),'invalid');
  assert.equal(validateTask(ID,task(ID,{payload:'-----BEGIN PRIVATE KEY-----'})),'secret');
});
test('listener: server-confirmed snapshots only; default delivery off -> READY/delivery_off, nothing on disk; writes progress only',async()=>{
  const ops=fakeOps();const root=tmp();
  const l=createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root},ops,...noTimer});l.start();
  assert.deepEqual(ops.query,{key:'grok',limit:5});assert.deepEqual(ops.beats,[]);await l.idle();await new Promise(r=>setImmediate(r));assert.deepEqual(ops.beats,['grok']);
  ops.next({fromCache:true,hasPendingWrites:false,docs:[{id:ID,data:task(ID)}]});ops.next({fromCache:false,hasPendingWrites:true,docs:[{id:ID,data:task(ID)}]});
  await l.idle();assert.deepEqual(ops.writes,[]);
  ops.next({fromCache:false,hasPendingWrites:false,docs:[{id:ID,data:task(ID)}]});ops.next({fromCache:false,hasPendingWrites:false,docs:[{id:ID,data:task(ID)}]});await l.idle();
  assert.deepEqual(ops.writes,[[ID,'grok','READY','delivery_off',2]]);assert.deepEqual(readdirSync(root),[]);
  await l.stop();assert.equal(ops.stopped,1);rmSync(root,{recursive:true});
});
test('listener: invalid/secret -> REJECTED; not targeted, not PENDING, or already progressed -> untouched; limit of open tasks',async()=>{
  const ops=fakeOps();const root=tmp();const inbox=createInbox({root,agentKey:'grok'});
  const l=createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root,delivery:true},ops,inbox,...noTimer});l.start();
  const open=[1,2,3,4,5].map(n=>({id:uuid(n),data:task(uuid(n),{progress:{grok:{state:n%2?'IN_PROGRESS':'READY',step:n%2?'started':'delivered'}}})}));
  ops.next({fromCache:false,hasPendingWrites:false,docs:[...open,{id:uuid(9),data:task(uuid(9))}]});await l.idle();
  assert.deepEqual(ops.writes,[]);   // only 5 docs are ever considered (listener limit)
  ops.next({fromCache:false,hasPendingWrites:false,docs:[...open.slice(0,4),{id:uuid(9),data:task(uuid(9))}]});await l.idle();
  assert.deepEqual(ops.writes.at(-1),[uuid(9),'grok','READY','delivered',2]);assert.equal(MAX_OPEN,5);
  ops.next({fromCache:false,hasPendingWrites:false,docs:[...open.slice(0,4),{id:uuid(9),data:task(uuid(9),{progress:{grok:{state:'READY',step:'delivered'}}})},{id:uuid(10),data:task(uuid(10))}].slice(0,5)});await l.idle();
  ops.writes.length=0;
  const docs=[{id:uuid(11),data:task(uuid(11),{payload:'ghp_abcdefghijklmnopqrst'})},{id:uuid(12),data:task(uuid(12),{payload:'a\tb'})},
    {id:uuid(13),data:task(uuid(13),{targets:{grok:'IGNORE',codex:'EXECUTE',gemini:'IGNORE'}})},{id:uuid(14),data:task(uuid(14),{status:'CANCELLED'})},{id:uuid(15),data:task(uuid(15),{progress:{grok:{state:'REJECTED',step:'invalid'}}})}];
  ops.next({fromCache:false,hasPendingWrites:false,docs});await l.idle();
  assert.deepEqual(ops.writes,[[uuid(11),'grok','REJECTED','secret',2],[uuid(12),'grok','REJECTED','invalid',2]]);
  assert.equal(existsSync(join(root,'grok',uuid(11)+'.task.txt')),false);
  // A full window of open tasks rejects the next one with 'limit'.
  const five=[1,2,3,4].map(n=>({id:uuid(20+n),data:task(uuid(20+n),{progress:{grok:{state:'IN_PROGRESS',step:'started'}}})}));
  const l2ops=fakeOps();const l2=createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root,delivery:true},ops:l2ops,inbox,...noTimer});l2.start();
  l2ops.next({fromCache:false,hasPendingWrites:false,docs:[...five,{id:uuid(30),data:task(uuid(30),{progress:{grok:{state:'READY',step:'delivered'}}})}]});
  l2ops.next({fromCache:false,hasPendingWrites:false,docs:[...five,{id:uuid(31),data:task(uuid(31))}]});await l2.idle();
  assert.deepEqual(l2ops.writes,[[uuid(31),'grok','READY','delivered',2]]);
  await l.stop();await l2.stop();rmSync(root,{recursive:true});
});
test('listener: delivery writes header + raw payload with wx; EEXIST counts as delivered; other inbox errors write nothing',async()=>{
  const ops=fakeOps();const root=tmp();const inbox=createInbox({root,agentKey:'grok'});
  const payload='line1\n${HOME} $(whoami) `id` [link](http://x) <b>x</b>';
  const l=createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root,delivery:true},ops,inbox,...noTimer});l.start();
  ops.next({fromCache:false,hasPendingWrites:false,docs:[{id:ID,data:task(ID,{payload})}]});await l.idle();
  assert.equal(readFileSync(join(root,'grok',ID+'.task.txt'),'utf8'),fixedHeader(ID,'grok')+payload);
  const l2ops=fakeOps();const l2=createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root,delivery:true},ops:l2ops,inbox,...noTimer});l2.start();
  l2ops.next({fromCache:false,hasPendingWrites:false,docs:[{id:ID,data:task(ID,{payload:'second'})}]});await l2.idle();
  assert.deepEqual(l2ops.writes,[[ID,'grok','READY','delivered',2]]);assert.equal(readFileSync(join(root,'grok',ID+'.task.txt'),'utf8'),fixedHeader(ID,'grok')+payload);
  const broken={deliver(){throw Object.assign(Error('x'),{code:'EACCES'});},markCancelled(){}};
  const l3ops=fakeOps();const l3=createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root,delivery:true},ops:l3ops,inbox:broken,...noTimer});l3.start();
  l3ops.next({fromCache:false,hasPendingWrites:false,docs:[{id:uuid(2),data:task(uuid(2))}]});await l3.idle();assert.deepEqual(l3ops.writes,[]);assert.equal(l3.status().errors,1);
  // Cancel after delivery -> fixed marker, once.
  l.start();ops.next({fromCache:false,hasPendingWrites:false,docs:[{id:ID,data:task(ID,{status:'CANCELLED',progress:{grok:{state:'READY',step:'delivered'}}})}]});
  ops.next({fromCache:false,hasPendingWrites:false,docs:[{id:ID,data:task(ID,{status:'CANCELLED',progress:{grok:{state:'READY',step:'delivered'}}})}]});await l.idle();
  assert.equal(readFileSync(join(root,'grok',ID+'.cancelled'),'utf8'),CANCELLED_CONTENT);assert.equal(l.status().cancelledMarkers,1);
  assert.throws(()=>createListener({config:{agent:'Grok',machine:'LD',inboxRoot:root,delivery:true},ops}),/LISTENER_INBOX_REQUIRED/);
  await l.stop();await l2.stop();await l3.stop();rmSync(root,{recursive:true});
});
test('agent session: markStarted refuses when .cancelled exists or the task is not PENDING/READY-delivered; completes only from IN_PROGRESS',async()=>{
  const root=tmp();const inbox=createInbox({root,agentKey:'grok'});let doc=task(ID,{progress:{grok:{state:'READY',step:'delivered'}}});const writes=[];
  const ops={readTask:async()=>doc,writeProgress:async(id,k,e)=>{writes.push([k,e.state,e.step]);doc={...doc,progress:{grok:{state:e.state,step:e.step}}};}};
  const s=createAgentSession({agent:'Grok',ops,inbox});
  await assert.rejects(s.markCompleted(ID),/TRANSITION_REJECTED/);
  await s.markStarted(ID);await assert.rejects(s.markStarted(ID),/TRANSITION_REJECTED/);await s.markCompleted(ID);
  assert.deepEqual(writes,[['grok','IN_PROGRESS','started'],['grok','COMPLETED','completed']]);
  doc=task(ID,{progress:{grok:{state:'READY',step:'delivered'}}});inbox.markCancelled(ID);await assert.rejects(s.markStarted(ID),/TASK_CANCELLED/);
  doc=task(uuid(3),{status:'CANCELLED',progress:{grok:{state:'READY',step:'delivered'}}});await assert.rejects(s.markStarted(uuid(3)),/TASK_NOT_PENDING/);
  doc=task(uuid(4),{progress:{grok:{state:'READY',step:'delivery_off'}}});await assert.rejects(s.markStarted(uuid(4)),/TRANSITION_REJECTED/);
  await s.markDeclined(uuid(4));assert.deepEqual(writes.at(-1),['grok','REJECTED','declined']);
  assert.throws(()=>createAgentSession({agent:'Claude',ops,inbox}));await assert.rejects(s.markStarted('../x'),/SESSION_TASK_ID/);
  rmSync(root,{recursive:true});
});
test('inbox: fixed agent map, UUID-only names, header carries the A2 wording; wx never overwrites',()=>{
  const root=tmp();const inbox=createInbox({root,agentKey:'codex'});
  assert.deepEqual(Object.keys(INBOX_DIRS),['codex','grok','gemini']);assert.throws(()=>createInbox({root,agentKey:'claude'}),/INBOX_AGENT_REJECTED/);
  assert.throws(()=>createInbox({root:'relative/dir',agentKey:'grok'}),/ABSOLUTE/);
  for(const bad of ['../x','x',ID.toUpperCase(),ID+'/..','..\\'+ID,ID+'\u0000'])assert.throws(()=>inbox.deliver(bad,'p'),/INBOX_TASK_ID_REJECTED/);
  const file=inbox.deliver(ID,'payload');assert.equal(file,join(root,'codex',ID+'.task.txt'));
  const h=fixedHeader(ID,'codex');
  for(const needle of ['MANUAL PICKUP ONLY','אינה אישור ל-push, ל-deploy, למחיקה או לשימוש בסודות','NOT approval for push, deploy, delete or secrets',ID+'.cancelled','does not guarantee stopping'])assert.ok(h.includes(needle),needle);
  assert.throws(()=>inbox.deliver(ID,'again'),e=>e.code==='EEXIST');assert.equal(readFileSync(file,'utf8'),h+'payload');
  assert.equal(inbox.isCancelled(ID),false);inbox.markCancelled(ID);inbox.markCancelled(ID);assert.equal(inbox.isCancelled(ID),true);
  rmSync(root,{recursive:true});
});
test('inbox: symlinked root, symlinked component, symlinked agent dir and a pre-planted link at the target are rejected; nothing written outside',()=>{
  const base=tmp();const outside=join(base,'outside');mkdirSync(outside);const real=join(base,'real');mkdirSync(real);
  symlinkSync(real,join(base,'link-root'),'dir');
  assert.throws(()=>createInbox({root:join(base,'link-root'),agentKey:'grok'}),/INBOX_LINK_REJECTED/);
  mkdirSync(join(real,'nested'));assert.throws(()=>createInbox({root:join(base,'link-root','nested'),agentKey:'grok'}),/INBOX_LINK_REJECTED/);
  // The agent folder itself is a link (junction-style) pointing outside the root.
  symlinkSync(outside,join(real,'grok'),'dir');
  const inbox=createInbox({root:real,agentKey:'grok'});assert.throws(()=>inbox.deliver(ID,'x'),/INBOX_LINK_REJECTED/);assert.throws(()=>inbox.markCancelled(ID),/INBOX_LINK_REJECTED/);
  assert.deepEqual(readdirSync(outside),[]);
  // A link planted at the exact target file name: 'wx' refuses (EEXIST) and the link target is untouched.
  const r2=join(base,'r2');mkdirSync(join(r2,'gemini'),{recursive:true});writeFileSync(join(outside,'victim.txt'),'keep');
  symlinkSync(join(outside,'victim.txt'),join(r2,'gemini',ID+'.task.txt'));
  const i2=createInbox({root:r2,agentKey:'gemini'});assert.throws(()=>i2.deliver(ID,'x'),e=>e.code==='EEXIST');assert.equal(readFileSync(join(outside,'victim.txt'),'utf8'),'keep');
  symlinkSync(join(outside,'victim.txt'),join(r2,'gemini',uuid(7)+'.cancelled'));assert.throws(()=>i2.isCancelled(uuid(7)),/INBOX_LINK_REJECTED/);
  // A missing root is never created (no directory outside the root); a file as root is rejected.
  assert.throws(()=>createInbox({root:join(base,'missing'),agentKey:'grok'}),e=>e.code==='ENOENT');assert.equal(existsSync(join(base,'missing')),false);
  writeFileSync(join(base,'file-root'),'x');assert.throws(()=>createInbox({root:join(base,'file-root'),agentKey:'grok'}),/NOT_DIRECTORY/);
  rmSync(base,{recursive:true});
});
test('static guard: listener/inbox never spawn, eval, import dynamically, fetch, read env, log, or parse markdown/links',()=>{
  for(const f of ['task-listener.mjs','task-inbox.mjs']){
    const src=readFileSync(new URL('./'+f,import.meta.url),'utf8');const code=src.replace(/^\s*\/\/.*$/gm,'');
    assert.doesNotMatch(code,/child_process|\beval\s*\(|new Function|Function\s*\(|\bimport\s*\(|\bspawn\b|\bexec(?:Sync|File)?\s*\(|\bfetch\s*\(|process\.env|console\.|require\s*\(|marked|markdown|\bhttps?:\/\//,f);
    assert.doesNotMatch(code,/payload[^\n]*(?:join|resolve)\(|(?:join|resolve)\([^\n)]*payload/,f+': payload never reaches a path');
  }
  const inbox=readFileSync(new URL('./task-inbox.mjs',import.meta.url),'utf8');
  const code=inbox.replace(/^\s*\/\/.*$/gm,'');
  assert.match(code,/openSync\(file,'wx'/);assert.match(code,/realpathSync/);assert.match(code,/lstatSync/);assert.doesNotMatch(code,/recursive\s*:/);assert.match(code,/fs\.mkdirSync\(dir\);/);
});
