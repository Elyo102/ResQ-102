// Pure-function tests for the private dashboard (no DOM, no network, no Firebase).
process.env.TZ='UTC'; // The stamp must not depend on the host zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {formatStamp,taskLabel,TASK_TEXT,detailText,CI_LIVE_TEXT} from './web/private-view.mjs';
import {createPrivateController,compareNewestFirst,newestFirst,latestEvent,heartbeatLive,heartbeatAge,LIVE_ENTER_MS,LIVE_EXIT_MS,MAX_FUTURE_SKEW_MS,TELEMETRY_TASKS} from './web/private-controller.mjs';
import {TASK_LABELS} from './core.mjs';

const STAMP=/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/;
const at=iso=>Date.parse(iso);

test('formatStamp renders Asia/Jerusalem DD/MM/YYYY HH:mm independent of host TZ',()=>{
 assert.equal(new Date(0).getTimezoneOffset(),0);
 assert.equal(formatStamp(at('2026-09-30T06:36:05Z')),'30/09/2026 09:36');
 assert.equal(formatStamp(at('2026-09-29T21:30:00Z')),'30/09/2026 00:30'); // next Israel day
 assert.equal(formatStamp(at('2026-09-29T21:00:00Z')),'30/09/2026 00:00'); // midnight is 00, never 24
 assert.equal(formatStamp(at('2026-01-15T22:00:00Z')),'16/01/2026 00:00'); // winter UTC+2
 assert.match(formatStamp(Date.now()),STAMP);
 for(const ms of [at('2026-03-27T00:30:00Z'),0,1,Date.UTC(2099,11,31,23,59,59)]){const s=formatStamp(ms);assert.match(s,STAMP);assert.doesNotMatch(s,/[\u200e\u200f\u061c]/);}
});
test('formatStamp DST fall-back on 2026-10-25 (02:00 IDT -> 01:00 IST)',()=>{
 assert.equal(formatStamp(at('2026-10-24T22:30:00Z')),'25/10/2026 01:30'); // UTC+3 (first 01:30)
 assert.equal(formatStamp(at('2026-10-24T22:59:59Z')),'25/10/2026 01:59');
 assert.equal(formatStamp(at('2026-10-24T23:00:00Z')),'25/10/2026 01:00'); // clocks moved back
 assert.equal(formatStamp(at('2026-10-24T23:30:00Z')),'25/10/2026 01:30'); // UTC+2 (repeated 01:30)
 assert.equal(formatStamp(at('2026-10-25T00:30:00Z')),'25/10/2026 02:30');
});
test('formatStamp self-guards invalid input',()=>{
 for(const v of [undefined,null,NaN,Infinity,-Infinity,1.5,'1700000000000',{},[],9e15,-9e15,Number.MAX_SAFE_INTEGER,2**53,1e20])assert.equal(formatStamp(v),'—',String(v));
});
test('taskText covers every known task type and has a safe fallback',()=>{
 assert.deepEqual(Object.keys(TASK_TEXT).sort(),[...TASK_LABELS].sort());
 assert.deepEqual([...TELEMETRY_TASKS].sort(),[...TASK_LABELS].sort());
 for(const t of TASK_LABELS){const s=taskLabel(t);assert.equal(typeof s,'string');assert.ok(s.trim());assert.doesNotMatch(s,/undefined|null/);assert.match(s,/[\u0590-\u05ff]/);}
 assert.equal(taskLabel('mystery_task'),'פעולה (mystery_task)');
 for(const v of [undefined,null,'','  ',42,{}])assert.equal(taskLabel(v),'פעולה');
 assert.equal(taskLabel('\u202ex'),'פעולה (x)');
 assert.equal(taskLabel('constructor'),'פעולה (constructor)');
 assert.equal(taskLabel('toString'),'פעולה (toString)');
});
test('heartbeatLive: <=90s enters, stays until >95s only if already live, invalid never live',()=>{
 const n=1_000_000_000;
 assert.equal(LIVE_ENTER_MS,90000);assert.equal(LIVE_EXIT_MS,95000);
 assert.equal(heartbeatLive(n-30000,n),true);
 assert.equal(heartbeatLive(n-90000,n),true);
 assert.equal(heartbeatLive(n-90001,n),false);
 assert.equal(heartbeatLive(n-93000,n,true),true);
 assert.equal(heartbeatLive(n-95000,n,true),true);
 assert.equal(heartbeatLive(n-95001,n,true),false);
 assert.equal(heartbeatLive(n-120000,n,true),false);
 for(const hb of [undefined,null,NaN,-1,1.5,'1',n+60001])assert.equal(heartbeatLive(hb,n),false,String(hb));
 assert.equal(heartbeatLive(n+1,n),true); // a future heartbeat inside the skew window is live
 assert.equal(heartbeatLive(n-1,NaN),false);
});

function harness(t0){
 let now=t0,tick=null,cancelled=0,subs=0,listener=null;const renders=[];
 const c=createPrivateController({now:()=>now,render:s=>renders.push(s),
  schedule:fn=>{tick=fn;return 7;},cancel:id=>{if(id===7)cancelled++;},
  subscribe:h=>{subs++;listener=h;return()=>{};}});
 c.setIdentity({uid:'synthetic-owner',backendAuthorized:true});
 return {c,renders,advance:ms=>{now+=ms;tick();},send:ev=>listener.next(ev,{fromCache:false}),
  status:agent=>renders.at(-1).agents.find(a=>a.agent===agent).status,get subs(){return subs;},get cancelled(){return cancelled;},get now(){return now;}};
}
const ev=(n,extra)=>({id:`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`,agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',...extra});

test('controller: 30s live, 120s and missing disconnected, expires on refresh without new listener',()=>{
 const t0=at('2026-09-30T06:00:00Z');
 const h=harness(t0);
 h.send([ev(1,{at:t0-30000}),ev(2,{agent:'Grok',at:t0-120000}),ev(3,{agent:'Claude',kind:'task_started',step:'started',at:t0-1000})]);
 assert.equal(h.status('Codex'),'CONNECTED');
 assert.equal(h.status('Grok'),'DISCONNECTED');
 assert.equal(h.status('Claude'),'DISCONNECTED'); // no heartbeat => never live
 assert.equal(h.status('Gemini'),'DISCONNECTED');
 assert.equal(h.renders.at(-1).refresh,'data');
 h.advance(60000); // age 90s
 assert.equal(h.status('Codex'),'CONNECTED');assert.equal(h.renders.at(-1).refresh,'status');
 h.advance(4000); // age 94s: hysteresis keeps live
 assert.equal(h.status('Codex'),'CONNECTED');
 h.advance(1001); // age 95.001s
 assert.equal(h.status('Codex'),'DISCONNECTED');
 h.advance(-3000); // clock jitter back to 92s must not resurrect it
 assert.equal(h.status('Codex'),'DISCONNECTED');
 assert.equal(h.subs,1);
 h.c.dispose();assert.equal(h.cancelled,1);
});
test('controller: first observation at 92s is not live; invalid clock is never live',()=>{
 const t0=at('2026-09-30T06:00:00Z');
 const h=harness(t0);h.send([ev(1,{at:t0-92000})]);assert.equal(h.status('Codex'),'DISCONNECTED');
 let now=NaN;const renders=[];
 const c=createPrivateController({now:()=>now,render:s=>renders.push(s),schedule:()=>1,cancel:()=>{},subscribe:()=>()=>{}});
 assert.ok(renders.every(r=>r.agents.every(a=>a.status==='DISCONNECTED')));c.dispose();
});

test('skew window: t+1 and t+60000 are live with age clamped to 0; t+60001 is invalid',()=>{
 const n=1_000_000_000;assert.equal(MAX_FUTURE_SKEW_MS,60000);
 assert.equal(heartbeatAge(n+1,n),0);assert.equal(heartbeatAge(n+60000,n),0);assert.equal(heartbeatAge(n+60001,n),null);
 for(const d of [1,500,59999,60000])assert.ok(heartbeatAge(n+d,n)>=0); // negative ages are clamped
 assert.equal(heartbeatAge(n-30000,n),30000);assert.equal(heartbeatAge(-1,n),null);assert.equal(heartbeatAge(n,NaN),null);
 assert.equal(heartbeatLive(n+1,n),true);assert.equal(heartbeatLive(n+60000,n),true);assert.equal(heartbeatLive(n+60001,n,true),false);
});
test('controller: t+1 and t+60000 accepted and CONNECTED; t+60001 row dropped without whole-view error',()=>{
 const t0=at('2026-09-30T06:00:00Z');
 for(const d of [1,60000]){const h=harness(t0);h.send([ev(1,{at:t0+d})]);assert.equal(h.renders.at(-1).phase,'connected');assert.equal(h.status('Codex'),'CONNECTED');assert.equal(h.renders.at(-1).clockSkew,false);}
 const h=harness(t0);
 h.send([ev(1,{at:t0+60001}),ev(2,{agent:'Grok',kind:'test_passed',task:'swap_race_review',step:'passed',at:t0-5000}),
  ev(3,{agent:'Claude',kind:'task_completed',task:'planner_draft_recovery',step:'completed',at:t0-4000}),ev(4,{agent:'Gemini',at:t0-10000})]);
 const last=h.renders.at(-1);
 assert.equal(last.phase,'connected');assert.equal(last.clockSkew,true);
 assert.deepEqual(last.events.map(e=>e.id),[ev(3).id,ev(2).id,ev(4).id]); // only the far-future row dropped; newest first
 assert.equal(h.status('Codex'),'DISCONNECTED');assert.equal(h.status('Gemini'),'CONNECTED');
 h.send([ev(2,{agent:'Grok',kind:'test_passed',task:'swap_race_review',step:'passed',at:t0-5000})]);
 assert.equal(h.renders.at(-1).clockSkew,false);
});
test('controller: schema, enum, id and at-type violations still fail-closed for the whole batch',()=>{
 const t0=at('2026-09-30T06:00:00Z');
 const cases=[{at:-1},{at:1.5},{at:'1'},{agent:'Other'},{kind:'bogus'},{task:'unknown'},{step:'x'},{id:'not-a-uuid'}];
 for(const bad of cases){const b=harness(t0);b.send([ev(9,{at:t0-1000}),ev(1,{at:t0,...bad})]);
  assert.equal(b.renders.at(-1).phase,'error',JSON.stringify(bad));assert.deepEqual(b.renders.at(-1).events,[]);}
 const extra=harness(t0);extra.send([{...ev(1,{at:t0}),createdAt:1}]);assert.equal(extra.renders.at(-1).phase,'error');
 const dup=harness(t0);dup.send([ev(1,{at:t0}),ev(1,{at:t0+60001})]);assert.equal(dup.renders.at(-1).phase,'error'); // dup id even if one row is far-future
 const mix=harness(t0);mix.send([ev(1,{at:t0+60001}),ev(2,{at:t0,task:'unknown'})]);assert.equal(mix.renders.at(-1).phase,'error');
});
test('controller: no flicker when a newer future heartbeat arrives',()=>{
 const t0=at('2026-09-30T06:00:00Z');const h=harness(t0);
 h.send([ev(1,{at:t0-88000})]);assert.equal(h.status('Codex'),'CONNECTED'); // age 88s: live
 h.advance(5000);assert.equal(h.status('Codex'),'CONNECTED'); // age 93s, held by hysteresis
 const seen=[];const before=h.renders.length;
 h.send([ev(1,{at:t0-88000}),ev(2,{at:t0+5000+30000})]); // newer heartbeat, 30s in the future
 for(const r of h.renders.slice(before))seen.push(r.agents.find(a=>a.agent==='Codex').status);
 for(let i=0;i<10;i++){h.advance(1000);seen.push(h.status('Codex'));}
 assert.deepEqual([...new Set(seen)],['CONNECTED']);
});
test('detail text: CI note only for a heartbeat-derived CONNECTED Codex card',()=>{
 assert.equal(CI_LIVE_TEXT,'דווח חי ע"י CI');
 assert.equal(detailText({agent:'Codex',status:'CONNECTED',task:null}),CI_LIVE_TEXT);
 assert.equal(detailText({agent:'Codex',status:'RUNNING',task:'local_tests'}),'בדיקות מקומיות');
 for(const a of [{agent:'Codex',status:'DISCONNECTED',task:null},{agent:'Grok',status:'CONNECTED',task:null},{agent:'Claude',status:'DISCONNECTED',task:null},null])
  assert.equal(detailText(a),'אין משימה חיה מאומתת');
});
test('dashboard card list is unchanged: exactly the 4 agents, in order',()=>{
 const t0=at('2026-09-30T06:00:00Z');const h=harness(t0);h.send([ev(1,{at:t0-1000})]);
 for(const r of h.renders)assert.deepEqual(r.agents.map(a=>a.agent),['Codex','Grok','Claude','Gemini']);
});

test('newest first: numeric at descending, deterministic id tiebreak, non-finite at dropped, input untouched',()=>{
 const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
 const rows=[{id:id(1),at:1000},{id:id(10),at:3000},{id:id(2),at:3000},{id:id(3),at:NaN},{id:id(4),at:Infinity},{id:id(5),at:2000},{id:id(6),at:undefined},{id:id(7),at:'x'}];
 const frozen=Object.freeze([...rows]);
 assert.deepEqual(newestFirst(frozen).map(e=>e.id),[id(10),id(2),id(5),id(1)]); // tie at 3000: larger UUID first
 assert.deepEqual(newestFirst([...frozen].reverse()).map(e=>e.id),[id(10),id(2),id(5),id(1)]); // arrival order irrelevant
 assert.equal(frozen[0].id,id(1)); // sorted on a copy
 // Numeric, not string: 9_000 vs 10_000 would sort the other way as strings.
 assert.deepEqual(newestFirst([{id:id(1),at:9000},{id:id(2),at:10000}]).map(e=>e.id),[id(2),id(1)]);
 assert.ok(compareNewestFirst({id:id(1),at:5},{id:id(2),at:5})>0);assert.equal(compareNewestFirst({id:id(1),at:5},{id:id(1),at:5}),0);
 assert.equal(latestEvent([{id:id(1),at:1},{id:id(3),at:NaN},{id:id(2),at:2}]).id,id(2));assert.equal(latestEvent([]),undefined);
 const src=readFileSync(new URL('./web/private-controller.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(src,/localeCompare|\.at\(-1\)|\[0\]|length-1/);
});
test('controller: card state and log order are identical for ascending vs descending input; log is newest first',()=>{
 const t0=at('2026-09-30T06:00:00Z');
 const batch=[ev(1,{at:t0-80000}),ev(2,{at:t0-20000}),ev(3,{agent:'Grok',at:t0-10000}),ev(4,{agent:'Grok',kind:'task_started',step:'started',task:'git_change',at:t0+1500}),
  ev(5,{agent:'Grok',kind:'task_completed',step:'completed',task:'git_change',at:t0+500}),ev(6,{agent:'Claude',at:t0-200000}),ev(7,{agent:'Codex',kind:'task_started',step:'started',at:t0+2000})];
 const asc=harness(t0);asc.send([...batch].sort((a,b)=>a.at-b.at));
 const desc=harness(t0);desc.send([...batch].sort((a,b)=>b.at-a.at));
 const a=asc.renders.at(-1),d=desc.renders.at(-1);
 assert.deepEqual(a.agents,d.agents);assert.deepEqual(a.events,d.events);
 assert.deepEqual(a.agents.map(x=>x.status),['RUNNING','RUNNING','DISCONNECTED','DISCONNECTED']);
 assert.deepEqual(a.events.map(e=>e.id),[7,4,5,3,2,1,6].map(n=>ev(n).id));
 for(let i=1;i<a.events.length;i++)assert.ok(a.events[i-1].at>=a.events[i].at);
});
test('source query: orderBy(createdAt desc) before limit(50) keeps the newest of 60 events and shows it first',async()=>{
 const {createFirebaseAdapter}=await import('./web/firebase-adapter.mjs');
 const {firebaseConfig}=await import('./web/firebase-config.mjs');
 const t0=at('2026-09-30T06:00:00Z'),id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
 // 60 synthetic events stored OLDEST FIRST, so an ascending or limit-first query would miss the newest ones.
 const stored=Array.from({length:60},(_,i)=>({id:id(i+1),data:{agent:'Codex',kind:'heartbeat',task:'local_tests',step:'running',createdAt:{toMillis:()=>t0-60000+i*1000}}}));
 const constraints=[];let emit=null;
 const user={uid:'synthetic-owner',emailVerified:true,providerData:[{providerId:'google.com'}]};
 const auth={currentUser:user};
 const sdk={initializeApp:()=>({}),getAuth:()=>auth,setPersistence:async()=>{},browserSessionPersistence:'session',memoryLocalCache:()=>({}),initializeFirestore:()=>({}),
  doc:()=>({}),getDocFromServer:async()=>({exists:()=>false}),collection:(db,name)=>({name}),
  orderBy:(field,dir='asc')=>({type:'orderBy',field,dir}),limit:n=>({type:'limit',n}),where:()=>{throw Error('NO_WHERE_EXPECTED');},
  query:(col,...cs)=>{constraints.push(...cs);return {col,cs};},
  onIdTokenChanged:(a,fn)=>{fn(user);return()=>{};},
  onSnapshot:(q,opts,next)=>{emit=()=>{let docs=[...stored];
    for(const c of q.cs){if(c.type==='orderBy'){const k=d=>d.data[c.field].toMillis();docs.sort((a,b)=>c.dir==='desc'?k(b)-k(a):k(a)-k(b));}if(c.type==='limit')docs=docs.slice(0,c.n);}
    next({metadata:{fromCache:false,hasPendingWrites:false},docs:docs.map(d=>({id:d.id,data:()=>d.data}))});};return()=>{};}};
 const adapter=await createFirebaseAdapter({sdk,config:firebaseConfig,googleOauth:{initTokenClient:()=>({requestAccessToken(){}})}});
 await new Promise(resolve=>adapter.auth.onIdentity(u=>{if(u?.backendAuthorized)resolve();}));
 const renders=[];
 const c=createPrivateController({now:()=>t0,render:s=>renders.push(s),schedule:()=>1,cancel:()=>{},subscribe:h=>adapter.subscribe(h)});
 c.setIdentity({uid:'synthetic-owner',backendAuthorized:true});emit();
 assert.deepEqual(constraints.map(x=>x.type),['orderBy','limit']); // orderBy precedes limit
 assert.deepEqual(constraints[0],{type:'orderBy',field:'createdAt',dir:'desc'});assert.deepEqual(constraints[1],{type:'limit',n:50});
 const last=renders.at(-1);assert.equal(last.phase,'connected');assert.equal(last.events.length,50);
 assert.equal(last.events[0].id,id(60)); // the newest of 60 is first
 assert.equal(last.events.at(-1).id,id(11)); // the 10 oldest are outside the limit
 c.dispose();
});
