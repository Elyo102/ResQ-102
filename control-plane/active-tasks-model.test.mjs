// Unit tests for the pure active-tasks model (no DOM, no SDK).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {blockedChars,blockedCharText,payloadProblem,buildTask,previewDoc,draftKey,reconcileTask,targetsValid,chipFor,overallStatus,orderTasks,listenerState,listenerText,
  mapTaskDoc,mapListenerDocs,validEntry,TEXT,PROGRESS_STEPS,TARGET_KEYS,TARGET_AGENTS,HEARTBEAT_FRESH_MS,QUIET_MS,STUCK_MS,OWNER_LIST_LIMIT,NOTE_RULES_PATTERN,PAYLOAD_CHAR,payloadThreshold,payloadThresholdText} from './web/active-tasks-model.mjs';
import {NOTE_PATTERN} from './web/dispatch-model.mjs';
const id='3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',now=Date.parse('2026-09-30T15:00:00Z');
const row=(extra={})=>({id,taskId:id,dispatchedBy:'u',payload:'p',status:'PENDING',timestamp:now-60000,targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},progress:{},...extra});
const e=(state,step,updatedAt=now-1000)=>({state,step,updatedAt});

test('blocked characters: code point, glyph when visible, 1-based line and column; no silent fix of tabs',()=>{
  assert.deepEqual(blockedChars('ok\nab“c'),[{cp:'U+201C',glyph:'“',line:2,column:3}]);
  assert.equal(blockedCharText(blockedChars('ok\nab“c')[0]),'U+201C (“) בשורה 2, עמודה 3');
  assert.equal(blockedCharText(blockedChars('a\tb')[0]),'U+0009 בשורה 1, עמודה 2');
  assert.equal(blockedCharText(blockedChars('שלום\u200f')[0]),'U+200F בשורה 1, עמודה 5');
  assert.equal(blockedCharText(blockedChars('x\r\ny׳')[0]),'U+05F3 (׳) בשורה 2, עמודה 2');     // CRLF counts as one line break
  assert.equal(blockedChars('😀')[0].cp,'U+1F600');assert.equal(blockedChars('a–b•')[1].column,4);
  assert.equal(blockedChars('x'.repeat(20).split('').join('“')).length,5);
  assert.equal(payloadProblem('a\tb'),'chars');assert.equal(payloadProblem('גרשיים״'),'chars');assert.equal(payloadProblem('ok'),null);
  assert.equal(payloadProblem('  \n'),'empty');assert.equal(payloadProblem('a'.repeat(10001)),'length');assert.equal(payloadProblem('a'.repeat(10000)),null);
  assert.equal(payloadProblem('use ghp_abcdefghijklmnop'),'secret');
});
test('allowlist is unchanged (no widening to ״ ׳ or curly quotes) and identical to the Rules class',()=>{
  const rules=readFileSync(new URL('./firestore-active-tasks.rules.fragment',import.meta.url),'utf8');
  assert.ok(rules.includes(`d.payload.matches('${NOTE_RULES_PATTERN}')`));
  assert.doesNotMatch(rules,/05F3|05F4|2018|2019|201C|201D/i);
});
test('buildTask/preview: exact doc, taskId is the idempotency key, all-IGNORE blocked, edits change the draft key',()=>{
  const targets={grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'};
  const t=buildTask({taskId:id,uid:'u',payload:'a\r\nb',targets});
  assert.deepEqual({...t,targets:{...t.targets},progress:{...t.progress}},{taskId:id,dispatchedBy:'u',payload:'a\nb',targets,status:'PENDING',progress:{}});
  assert.deepEqual(previewDoc(t),{taskId:id,dispatchedBy:'u',targets,status:'PENDING',timestamp:'ייקבע בשרת',progress:{}});
  assert.equal(Object.hasOwn(previewDoc(t),'payloadLength'),false);  // preview is exactly the stored document
  assert.throws(()=>buildTask({taskId:id,uid:'u',payload:'x',targets:{grok:'IGNORE',codex:'IGNORE',gemini:'IGNORE'}}),/NO_EXECUTE_TARGET/);
  assert.throws(()=>buildTask({taskId:id.toUpperCase(),uid:'u',payload:'x',targets}),/INVALID_TASK_ID/);
  assert.throws(()=>buildTask({taskId:id,uid:'u',payload:'a\tb',targets}),/INVALID_PAYLOAD/);
  assert.equal(targetsValid({grok:'EXECUTE',codex:'IGNORE'}),false);
  assert.notEqual(draftKey('a',targets),draftKey('a ',targets));assert.notEqual(draftKey('a',targets),draftKey('a',{...targets,codex:'EXECUTE'}));
  assert.equal(reconcileTask(t,{exists:true,taskId:id,dispatchedBy:'u',payload:'a\nb',targets}),'saved');
  assert.equal(reconcileTask(t,{exists:true,taskId:id,dispatchedBy:'u',payload:'other',targets}),'conflict');
  assert.equal(reconcileTask(t,{exists:false}),'missing');
});
test('chips: IGNORE is "לא נבחר"; DELIVERED is never בביצוע; delivery off text; rejected reasons; terminal states',()=>{
  const r=row({targets:{grok:'EXECUTE',codex:'EXECUTE',gemini:'IGNORE'},progress:{grok:e('READY','delivered'),codex:e('READY','delivery_off')}});
  const g=chipFor(r,'grok',{now,seenAt:now}),c=chipFor(r,'codex',{now,seenAt:now}),m=chipFor(r,'gemini',{now,seenAt:now});
  assert.equal(g.kind,'delivered');assert.equal(g.text,'נמסר — טרם התחיל');assert.doesNotMatch(g.text,/בביצוע/);
  assert.equal(c.text,'מסירה כבויה, המשימה נשמרה בלבד');assert.equal(m.text,'לא נבחר');assert.equal(m.kind,'ignore');
  const o=overallStatus(r,[g,c,m]);assert.equal(o.kind,'delivered');assert.doesNotMatch(o.text,/בביצוע/);
  for(const step of PROGRESS_STEPS.REJECTED)assert.match(chipFor(row({progress:{grok:e('REJECTED',step)}}),'grok',{now}).text,/נדחה/);
  assert.equal(chipFor(row({progress:{grok:e('COMPLETED','completed')}}),'grok',{now}).text,'הושלם');
  assert.equal(chipFor(row({progress:{grok:e('FAILED','failed')}}),'grok',{now}).text,'נכשל');
  assert.equal(chipFor(row({progress:{grok:{state:'READY',step:'started',updatedAt:now}}}),'grok',{now}).kind,'unknown');
  assert.equal(chipFor(row({progress:{grok:{...e('READY','delivered'),extra:true}}}),'grok',{now}).kind,'unknown');
});
test('IN_PROGRESS: בביצוע only with a fresh listener heartbeat; otherwise "אין דופק מאז HH:mm"; stale -> "לא ידוע / תקוע"',()=>{
  const r=row({progress:{grok:e('IN_PROGRESS','started',now-5*60000)}});
  assert.equal(chipFor(r,'grok',{now,seenAt:now-10000}).text,'בביצוע');
  const hb=Date.parse('2026-09-30T14:50:00Z');
  const np=chipFor(r,'grok',{now,seenAt:hb});assert.equal(np.kind,'no_pulse');assert.equal(np.text,'בביצוע — אין דופק מאז 17:50');
  assert.equal(chipFor(r,'grok',{now}).text,'בביצוע — אין דופק מהמאזין');
  const stuck=chipFor(row({progress:{grok:e('IN_PROGRESS','started',now-STUCK_MS-1)}}),'grok',{now,seenAt:now});
  assert.equal(stuck.kind,'stuck');assert.match(stuck.text,/^לא ידוע \/ תקוע · ללא עדכון מאז \d\d:\d\d$/);
  assert.equal(overallStatus(r,[chipFor(r,'grok',{now,seenAt:now})]).text,'בביצוע (לפי דיווח הסוכן)');
  // no_pulse / stuck are separate overall kinds, never "running"
  const o1=overallStatus(r,[np]);assert.equal(o1.kind,'no_pulse');assert.doesNotMatch(o1.text,/^בביצוע \(/);
  const o2=overallStatus(r,[stuck]);assert.equal(o2.kind,'stuck');
  assert.equal(overallStatus(r,[chipFor(r,'grok',{now,seenAt:now}),np]).kind,'running');
  // listener stream unknown (error / cache): pulse is unknown, never "אין דופק"-as-fact nor "בביצוע"
  const unk=chipFor(r,'grok',{now,seenAt:now,pulseKnown:false});assert.equal(unk.kind,'pulse_unknown');assert.equal(unk.text,'מצב המאזין לא ידוע');
  assert.equal(chipFor(r,'grok',{now,pulseKnown:false}).kind,'pulse_unknown');   // never no_pulse ("אין דופק מהמאזין") when the stream failed
  assert.deepEqual(overallStatus(r,[unk]),{kind:'pulse_unknown',text:'מצב המאזין לא ידוע'});
});
test('"ללא עדכון מאז" after 30 minutes on waiting/delivered chips; CANCELLED overall is text',()=>{
  const w=chipFor(row({timestamp:now-QUIET_MS-1}),'grok',{now});assert.equal(w.quiet,true);assert.match(w.text,/^ממתין למאזין · ללא עדכון מאז \d\d:\d\d$/);
  assert.equal(chipFor(row(),'grok',{now}).text,'ממתין למאזין');
  assert.match(chipFor(row({progress:{grok:e('READY','delivered',now-QUIET_MS-1)}}),'grok',{now}).text,/ללא עדכון מאז/);
  assert.deepEqual(overallStatus(row({status:'CANCELLED'}),[]),{kind:'CANCELLED',text:'בוטל'});
  assert.equal(overallStatus(row({progress:{grok:e('COMPLETED','completed')}}),[chipFor(row({progress:{grok:e('COMPLETED','completed')}}),'grok',{now})]).kind,'done');
});
test('listener liveness: אין מאזין / מנותק / מאזין only (never מוכן)',()=>{
  assert.equal(listenerText(undefined,now),'אין מאזין');assert.equal(listenerText(now-HEARTBEAT_FRESH_MS-1,now),'מנותק');assert.equal(listenerText(now-1000,now),'מאזין');
  assert.equal(listenerState(now+120000,now),'down');
  assert.equal(listenerState(undefined,now,false),'unknown');assert.equal(listenerState(now-1000,now,false),'unknown');
  assert.equal(listenerText(undefined,now,false),'לא ידוע (אין חיבור)');assert.equal(listenerText(undefined,now,true),'אין מאזין');
  assert.deepEqual([TEXT.listenerNone,TEXT.listenerDown,TEXT.listenerUp],['אין מאזין','מנותק','מאזין']);
  assert.doesNotMatch(readFileSync(new URL('./web/active-tasks-model.mjs',import.meta.url),'utf8')+readFileSync(new URL('./web/active-tasks-view.mjs',import.meta.url),'utf8'),/מוכן/);
});
test('mapping: exact 7 keys required; progress kept per known key; heartbeat docs validated',()=>{
  const ts=ms=>({toMillis:()=>ms});
  const x={taskId:id,dispatchedBy:'u',payload:'p',targets:{grok:'EXECUTE',codex:'IGNORE',gemini:'IGNORE'},status:'PENDING',timestamp:ts(5),progress:{grok:{state:'READY',step:'delivered',updatedAt:ts(6)},claude:{}}};
  const m=mapTaskDoc(id,x);assert.deepEqual(m.progress,{grok:{state:'READY',step:'delivered',updatedAt:6}});assert.ok(validEntry(m.progress.grok));
  assert.throws(()=>mapTaskDoc(id,{...x,extra:1}),/INVALID_ACTIVE_TASK/);assert.throws(()=>mapTaskDoc(id,{...x,timestamp:null}),/INVALID_ACTIVE_TASK/);
  assert.deepEqual(mapListenerDocs([{id:'grok',data:{agent:'grok',seenAt:ts(9)}},{id:'codex',data:{agent:'grok',seenAt:ts(9)}},{id:'claude',data:{agent:'claude',seenAt:ts(9)}},
    {id:'gemini',data:{agent:'gemini',seenAt:ts(1),x:1}}]),{grok:9});
  const rows=[row({id:'b'+id.slice(1),taskId:'b'+id.slice(1),timestamp:1}),row({timestamp:2}),row({id:'bad'})];
  assert.deepEqual(orderTasks(rows).map(r=>r.timestamp),[2,1]);assert.equal(OWNER_LIST_LIMIT,20);
});
test('agent map and step vocabulary match the Rules fragment exactly (Claude excluded)',()=>{
  const rules=readFileSync(new URL('./firestore-active-tasks.rules.fragment',import.meta.url),'utf8');
  assert.match(rules,/\{'Codex': 'codex', 'Grok': 'grok', 'Gemini': 'gemini'\}/);assert.doesNotMatch(rules,/'Claude'/);
  assert.deepEqual(TARGET_AGENTS.map(([a,k])=>[a,k]).sort(),[['Codex','codex'],['Gemini','gemini'],['Grok','grok']]);assert.deepEqual([...TARGET_KEYS].sort(),['codex','gemini','grok']);
  for(const [state,steps] of Object.entries(PROGRESS_STEPS))assert.ok(rules.includes(`'${state}': [${steps.map(s=>`'${s}'`).join(', ')}]`),state);
});
test('PAYLOAD_CHAR is exactly the dispatch NOTE_PATTERN alphabet; thresholds announce without maxlength',()=>{
  for(let cp=0;cp<=0x3000;cp++){const c=String.fromCodePoint(cp);assert.equal(PAYLOAD_CHAR.test(c),NOTE_PATTERN.test(c),'U+'+cp.toString(16));}
  for(const c of ['\u{1F600}','\uFEFF','\u202E','\u200F'])assert.equal(PAYLOAD_CHAR.test(c),NOTE_PATTERN.test(c));
  assert.equal(payloadThreshold('a'.repeat(8999)),null);assert.equal(payloadThreshold('a'.repeat(9000)),'9000');assert.equal(payloadThreshold('a'.repeat(9900)),'9900');
  assert.equal(payloadThreshold('a'.repeat(10000)),'10000');assert.equal(payloadThreshold('a'.repeat(10001)),'over');assert.match(payloadThresholdText('over'),/חסומה/);
});
