// Pure unit tests for web/dispatch-model.mjs (no DOM, no network, no Firebase).
process.env.TZ='UTC'; // Display dates must not depend on the host zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as M from './web/dispatch-model.mjs';
const at=iso=>Date.parse(iso);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row=(n,extra)=>({id:id(n),agent:'Grok',taskType:'realtime',note:'x',status:'queued',batchId:id(900),createdBy:'synthetic-owner',createdAt:1000+n,cancelledAt:null,...extra});

test('date format: DD/MM/YYYY HH:mm in Asia/Jerusalem from formatToParts, seconds only in the full stamp',()=>{
 assert.equal(new Date(0).getTimezoneOffset(),0);
 assert.equal(M.formatDisplayStamp(at('2026-09-30T09:26:00Z')),'30/09/2026 12:26');
 assert.equal(M.formatSecondsStamp(at('2026-09-30T09:26:07Z')),'30/09/2026 12:26:07');
 assert.equal(M.formatDisplayStamp(at('2026-09-29T21:30:00Z')),'30/09/2026 00:30'); // next Israel day
 assert.equal(M.formatDisplayStamp(at('2026-09-29T21:00:00Z')),'30/09/2026 00:00'); // midnight is 00, never 24
 assert.equal(M.formatDisplayStamp(at('2026-01-15T22:00:00Z')),'16/01/2026 00:00'); // winter UTC+2
 assert.equal(M.formatDisplayStamp(at('2026-10-24T22:30:00Z')),'25/10/2026 01:30'); // DST UTC+3
 assert.equal(M.formatDisplayStamp(at('2026-10-24T23:30:00Z')),'25/10/2026 01:30'); // repeated hour UTC+2
 assert.equal(M.formatDisplayStamp(at('2026-10-25T00:30:00Z')),'25/10/2026 02:30');
 for(const v of [undefined,null,NaN,1.5,'1',9e15,2**53,{}])assert.equal(M.formatDisplayStamp(v),'—');
 for(const ms of [0,Date.now(),Date.UTC(2099,11,31,23,59,59)])assert.match(M.formatDisplayStamp(ms),/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
 assert.deepEqual(M.displayParts(at('2026-09-30T09:26:07Z')),{day:'30',month:'09',year:'2026',hour:'12',minute:'26',second:'07'});
});
test('pin order: queued by createdAt desc; history by cancelledAt/updatedAt/createdAt desc; stable id ties; cap 50',()=>{
 const rows=[row(1),row(3),row(2),row(5,{createdAt:1003}),row(4,{status:'cancelled',cancelledAt:5000}),row(6,{status:'cancelled',cancelledAt:4000,createdAt:9999}),
  row(7,{status:'done',updatedAt:4500}),row(8,{status:'done',createdAt:4500})];
 const {active,history}=M.orderFeed(rows);
 assert.deepEqual(active.map(r=>r.id),[id(3),id(5),id(2),id(1)]); // 1003 tie: id(3) < id(5)
 assert.deepEqual(history.map(r=>r.id),[id(4),id(7),id(8),id(6)]);
 assert.deepEqual(M.orderFeed([...rows].reverse()),{active,history}); // input order never matters
 const many=Array.from({length:70},(_,i)=>row(i+10,{status:'cancelled',cancelledAt:10000+i}));
 const h=M.orderFeed(many).history;assert.equal(h.length,50);assert.equal(h[0].id,id(79));assert.equal(h.at(-1).id,id(30));
 // Duplicate from the two listeners: the non-queued server state wins; malformed rows are dropped.
 assert.deepEqual(M.orderFeed([row(1),row(1,{status:'cancelled',cancelledAt:2})]).active,[]);
 assert.equal(M.orderFeed([{...row(2),id:'bad'},{...row(3),createdAt:'1'},null]).active.length,0);
});
test('note allowlist and code-point counter mirror the Rules',()=>{
 for(const ok of ['','abc ~!','שָׁלוֹם','a'.repeat(280),'א'.repeat(280)])assert.equal(M.noteProblem(ok),null,ok);
 const bad=[0x200F,0x200E,0x061C,0x202A,0x202B,0x202C,0x202D,0x202E,0x2066,0x2067,0x2068,0x2069,0x2028,0x2029,0xFEFF,0x200B,0x200C,0x200D,0x7F,0x0A,0x09,0x00];
 for(let c=0x80;c<=0x9F;c++)bad.push(c);
 for(const cp of bad)assert.equal(M.noteProblem('a'+String.fromCodePoint(cp)),'chars','U+'+cp.toString(16));
 assert.equal(M.noteProblem('😀'),'chars');assert.equal(M.noteLength('😀'),1);assert.equal('😀'.length,2);
 assert.equal(M.noteProblem('a'.repeat(281)),'length');assert.equal(M.noteProblem(5),'type');
 assert.equal(M.noteLength('שָׁ'),3);assert.equal(M.counterText('אב'),'2/280');
 assert.deepEqual(M.rejectedNoteChars('a\u200fb\u200f😀'),['U+200F','U+1F600']);
});
test('payload is the exact frozen snapshot; keys are v4 and reused; edits change the draft key',()=>{
 const keys=M.newKeys(randomUUID);assert.match(keys.batchId,M.UUID_V4);for(const v of Object.values(keys.ids))assert.match(v,M.UUID_V4);
 assert.equal(new Set([keys.batchId,...Object.values(keys.ids)]).size,4);
 assert.throws(()=>M.newKeys(()=>'not-v4'),/INVALID_UUID/);
 const selections={Gemini:'docs',Codex:'',Grok:'realtime'};
 const p=M.buildPayload({selections,note:'בדיקה',keys,uid:'synthetic-owner'});
 assert.deepEqual(JSON.parse(JSON.stringify(p)),{batchId:keys.batchId,rows:[
  {id:keys.ids.Gemini,data:{agent:'Gemini',taskType:'docs',note:'בדיקה',status:'queued',batchId:keys.batchId,createdBy:'synthetic-owner'}},
  {id:keys.ids.Grok,data:{agent:'Grok',taskType:'realtime',note:'בדיקה',status:'queued',batchId:keys.batchId,createdBy:'synthetic-owner'}}]});
 assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.rows[0].data));
 assert.equal(M.payloadKey(M.buildPayload({selections,note:'בדיקה',keys,uid:'synthetic-owner'})),M.payloadKey(p));
 assert.notEqual(M.draftKey(selections,'בדיקה'),M.draftKey(selections,'בדיקה!'));assert.notEqual(M.draftKey(selections,'x'),M.draftKey({...selections,Codex:'integration'},'x'));
 for(const bad of [{Gemini:'realtime'},{Codex:'executor'},{Codex:'commit-branch-dispatch'},{Claude:'qa-review'},{}])assert.throws(()=>M.buildPayload({selections:bad,note:'',keys,uid:'u'}),/NO_VALID_SELECTION/);
 assert.throws(()=>M.buildPayload({selections,note:'\u202e',keys,uid:'u'}),/INVALID_NOTE/);assert.throws(()=>M.buildPayload({selections,note:'',keys,uid:''}),/UID_REQUIRED/);
});
test('freshness threshold, failure classification, reconciliation and server-only status text',()=>{
 const now=at('2026-09-30T09:00:00Z');
 assert.equal(M.needsReauth(now-840000,now),false);assert.equal(M.needsReauth(now-840001,now),true);assert.equal(M.needsReauth(null,now),true);assert.equal(M.needsReauth(now+120000,now),true);
 assert.equal(M.AUTH_MAX_AGE_MS<900000,true);assert.ok(M.COOLDOWN_MS>0);
 assert.equal(M.classifyFailure({code:'permission-denied'}),'denied');assert.equal(M.classifyFailure({code:'firestore/permission-denied'}),'denied');
 for(const e of [{code:'deadline-exceeded'},{code:'unavailable'},Error('x'),undefined])assert.equal(M.classifyFailure(e),'unconfirmed');
 const keys=M.newKeys(randomUUID);const p=M.buildPayload({selections:{Grok:'realtime',Codex:'integration'},note:'',keys,uid:'synthetic-owner'});
 const found=p.rows.map(r=>({id:r.id,exists:true,batchId:keys.batchId,agent:r.data.agent,taskType:r.data.taskType,createdBy:'synthetic-owner'}));
 assert.equal(M.reconcile(p,found),'saved');assert.equal(M.reconcile(p,p.rows.map(r=>({id:r.id,exists:false}))),'missing');
 assert.equal(M.reconcile(p,[{...found[0],batchId:randomUUID()},found[1]]),'conflict');assert.equal(M.reconcile(p,[found[0]]),'conflict');
 assert.equal(M.statusText('queued'),'בתור');assert.equal(M.statusText('cancelled'),'בוטל');assert.equal(M.statusText('claimed'),'סטטוס שרת: claimed');
 assert.equal(M.statusText('<b>x</b>'),'סטטוס שרת: bxb');assert.equal(M.statusText(undefined),'סטטוס לא מוכר');
 assert.equal(M.taskTypeText('realtime'),'זמן אמת (realtime)');assert.equal(M.taskTypeText('constructor'),'סוג לא מוכר');
});
