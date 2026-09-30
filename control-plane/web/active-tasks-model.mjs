// Pure active-tasks model: no DOM, no SDK, no network. Unit-tested in control-plane/active-tasks-model.test.mjs.
// Security review 30/09/2026 (SAFE_WITH_CONDITIONS), see control-plane/ACTIVE-TASKS.md:
// - The owner writes the task document (status PENDING) and may only cancel it while PENDING.
// - Each agent's listener identity writes ONLY progress[own key]; nobody but the owner writes status.
// - The overall status shown here is DERIVED from progress; it is never stored.
// - A task is never approval for push, deploy, delete or secrets. Pickup is manual only.
// - READY/delivered (DELIVERED) is never shown as "בביצוע".
// Push trigger (t176u; UI review C1-C12, security review; review/push-trigger-verdicts.md):
// - kind TASK (EXECUTE/IGNORE, non-targets IGNORE) or MESSAGE (NOTIFY/IGNORE, >= 1 NOTIFY, <= 2000, blocked not cut).
// - acks[key] = LIT | UNDERSTOOD | UNREADABLE (+ summary <= 280) is written by that agent's listener. An ack is
//   never approval and never the start of work. "נדלק, אין תשובה" / "לא התקבל אישור קבלה" are computed against
//   SERVER time (an offset learned from server stamps), never the client clock; unknown offset -> not computed.
// - IN_PROGRESS / COMPLETED are set only by the owner's manual click (Rules atOwnerProgress).
import {NOTE_MAX,NOTE_PATTERN,NOTE_RULES_PATTERN,UUID_V4,hasSecret,AUTH_MAX_AGE_MS,needsReauth,classifyFailure,formatDisplayStamp,renderStamp} from './dispatch-model.mjs?v=20260930-grok-dispatch5';
export {NOTE_MAX,NOTE_PATTERN,NOTE_RULES_PATTERN,UUID_V4,AUTH_MAX_AGE_MS,needsReauth,classifyFailure,renderStamp};

// Fixed agent map (display name -> key), identical to atKeyFor() in the Rules. Claude is not a target.
export const TARGET_AGENTS=Object.freeze([['Gemini','gemini'],['Codex','codex'],['Grok','grok']].map(Object.freeze));
export const TARGET_KEYS=Object.freeze(TARGET_AGENTS.map(([,k])=>k));
export const TARGET_VALUES=Object.freeze(['EXECUTE','NOTIFY','IGNORE']);
export const KINDS=Object.freeze(['TASK','MESSAGE']);
export const KIND_VALUES=Object.freeze({TASK:Object.freeze(['IGNORE','EXECUTE']),MESSAGE:Object.freeze(['IGNORE','NOTIFY'])});
export const KIND_ACTIVE=Object.freeze({TASK:'EXECUTE',MESSAGE:'NOTIFY'});
export const TASK_KEYS=Object.freeze(['taskId','dispatchedBy','payload','targets','status','timestamp','progress']);
export const OPTIONAL_TASK_KEYS=Object.freeze(['kind','acks']);
export const ACK_STATES=Object.freeze(['LIT','UNDERSTOOD','UNREADABLE']);
export const SUMMARY_MAX=280;
export const MESSAGE_MAX=2000;
export const TASK_STATUSES=Object.freeze(['PENDING','CANCELLED']);
// Closed progress vocabulary, identical to atSteps() in the Rules.
export const PROGRESS_STEPS=Object.freeze({READY:Object.freeze(['delivered','delivery_off']),REJECTED:Object.freeze(['invalid','secret','limit','declined']),
  IN_PROGRESS:Object.freeze(['started']),COMPLETED:Object.freeze(['completed']),FAILED:Object.freeze(['failed'])});
export const PAYLOAD_MAX=NOTE_MAX;
export const OWNER_LIST_LIMIT=20;     // Rules: owner list limit 1..20, orderBy(timestamp desc)
export const LISTENER_LIST_LIMIT=3;   // Rules: task_listeners list limit 1..3
export const HEARTBEAT_FRESH_MS=165000; // C11: listener heartbeat every 120 s (t176u); fresh when seen within 165 s (150-180)
export const ACK_LIT_TIMEOUT_MS=90000;   // C3/C5: LIT without UNDERSTOOD/UNREADABLE for 90 s (server time) -> "נדלק, אין תשובה"
export const ACK_NONE_TIMEOUT_MS=180000; // C5: no ack at all 180 s (server time) after creation -> "לא התקבל אישור קבלה"
export const ACK_ANNOUNCE_MS=5000;       // C7: highlight at most 5 s (none under reduced motion)
export const CLOCK_SKEW_MS=60000;
export const QUIET_MS=30*60000;        // "ללא עדכון מאז" after 30 minutes without a progress change
export const STUCK_MS=60*60000;        // IN_PROGRESS without any update for 60 minutes -> "לא ידוע / תקוע"
export const SEND_TIMEOUT_MS=12000;

export const TEXT=Object.freeze({
  ignore:'לא נבחר',waiting:'ממתין למאזין',delivered:'נמסר — טרם התחיל',deliveryOff:'מסירה כבויה, המשימה נשמרה בלבד',
  inProgress:'בביצוע',noPulse:'בביצוע — אין דופק מאז ',noPulseEver:'בביצוע — אין דופק מהמאזין',pulseUnknown:'מצב המאזין לא ידוע',stuck:'לא ידוע / תקוע',
  completed:'הושלם',failed:'נכשל',unknown:'מצב לא מוכר',quiet:'ללא עדכון מאז ',
  rejected:{invalid:'נדחה — משימה לא תקינה',secret:'נדחה — נראה שיש סוד',limit:'נדחה — יותר מדי משימות פתוחות',declined:'נדחה ע"י הסוכן'},
  ack:{lit:'נדלק — קורא',litNoAnswer:'נדלק, אין תשובה',understood:'הבנתי',unreadable:'לא הצליח לקרוא',waiting:'ממתין לאישור קבלה',
    noAck:'לא התקבל אישור קבלה',noAckMaybeOff:'אין אישור קבלה (ייתכן שכבוי)',listenerOff:'אישורי קבלה כבויים במאזין',
    switchOff:'נעצר — אישורי קבלה כבויים',switchMissing:'לא מוגדר — אישורי קבלה חסומים',stale:'לא עדכני',closed:'—'},
  listenerNone:'אין מאזין',listenerDown:'מנותק',listenerUp:'מאזין',listenerUnknown:'לא ידוע (אין חיבור)',
  overall:{CANCELLED:'בוטל',done:'הסתיים',running:'בביצוע',no_pulse:'לא ידוע — דווח התחלה, אין דופק מהמאזין',pulse_unknown:'מצב המאזין לא ידוע',stuck:'לא ידוע / תקוע',
    delivered:'נמסר — טרם התחיל',saved:'נשמר בלבד (מסירה כבויה)',waiting:'ממתין',message:'הודעה'}
});

// Payload: same allowlist and size as the dispatch note (LF, printable ASCII, Hebrew letters and points; <= 10000).
// No silent fix: only CRLF/CR -> LF (what a textarea already reports). A tab or any other character is BLOCKED and
// reported with its code point, line and column. Widening (״ ׳ U+05F3/U+05F4, curly quotes) was suggested by the UI
// review but NOT approved by security, so the allowlist is unchanged.
export const PAYLOAD_CHAR=/^[\u{000A}\u{0020}-\u{007E}\u{05D0}-\u{05EA}\u{05B0}-\u{05C7}]$/u;
const VISIBLE=/^[\p{L}\p{N}\p{P}\p{S}]$/u;
export function normalizePayload(raw){return typeof raw==='string'?raw.replace(/\r\n?/g,'\n'):raw;}
// Threshold announcements (separate polite region): null below 9000, then '9000', '9900', '10000', 'over'.
export function payloadThreshold(raw,kind='TASK'){const n=payloadLength(raw);
  // UI 25572dc minor: in MESSAGE mode the announcements follow the 2000 limit ('m1800' | 'm2000' | 'mover').
  if(kind==='MESSAGE'){if(n>MESSAGE_MAX)return 'mover';if(n===MESSAGE_MAX)return 'm2000';if(n>=1800)return 'm1800';return null;}
  if(n>PAYLOAD_MAX)return 'over';if(n===PAYLOAD_MAX)return '10000';if(n>=9900)return '9900';if(n>=9000)return '9000';return null;}
export function payloadThresholdText(level){return {'9000':'התוכן הגיע ל-9000 תווים מתוך 10000.','9900':'התוכן הגיע ל-9900 תווים מתוך 10000.','10000':'התוכן הגיע למגבלה של 10000 תווים.',over:'התוכן חורג מ-10000 תווים. השמירה חסומה עד לקיצור.',
  m1800:'ההודעה הגיעה ל-1800 תווים מתוך 2000.',m2000:'ההודעה הגיעה למגבלה של 2000 תווים.',mover:'ההודעה חורגת מ-2000 תווים. השמירה חסומה עד לקיצור.'}[level]??'';}
export function payloadLength(raw){return typeof raw==='string'?[...normalizePayload(raw)].length:0;}
// [{cp:'U+2019',glyph:'’'|null,line,column}] — first `limit` findings, 1-based line and column in code points.
export function blockedChars(raw,limit=5){
  if(typeof raw!=='string')return [];
  const out=[];let line=1,column=0;
  for(const c of normalizePayload(raw)){
    if(c==='\n'){line++;column=0;continue;}
    column++;
    if(!PAYLOAD_CHAR.test(c)){out.push(Object.freeze({cp:'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0'),glyph:VISIBLE.test(c)?c:null,line,column}));
      if(out.length>=limit)break;}
  }
  return out;
}
export function blockedCharText(item){return `${item.cp}${item.glyph?` (${item.glyph})`:''} בשורה ${item.line}, עמודה ${item.column}`;}
// Returns null or one of 'type' | 'empty' | 'secret' | 'length' | 'chars'. The secret text is never echoed.
export function payloadProblem(raw){
  if(typeof raw!=='string')return 'type';
  const p=normalizePayload(raw);
  if(!p.trim())return 'empty';
  if(hasSecret(p))return 'secret';
  if([...p].length>PAYLOAD_MAX)return 'length';
  if(!NOTE_PATTERN.test(p))return 'chars';
  return null;
}
export function targetsValid(targets,kind='TASK'){
  const allowed=KIND_VALUES[kind];if(!allowed)return false;
  return !!targets&&typeof targets==='object'&&Object.keys(targets).length===3&&TARGET_KEYS.every(k=>allowed.includes(targets[k]))
    &&TARGET_KEYS.some(k=>targets[k]===KIND_ACTIVE[kind]);
}
// MESSAGE: <= 2000 code points, BLOCKED (never cut). Returns null or 'message_length'.
export function kindProblem(kind,payload){return kind==='MESSAGE'&&payloadLength(payload)>MESSAGE_MAX?'message_length':null;}
// Exact document shown in the preview and sent; timestamp is the server time added by the adapter.
export function buildTask({taskId,uid,payload,targets,kind='TASK'}){
  if(!UUID_V4.test(taskId??''))throw Error('INVALID_TASK_ID');
  if(typeof uid!=='string'||!uid)throw Error('UID_REQUIRED');
  if(!KINDS.includes(kind))throw Error('INVALID_KIND');
  if(payloadProblem(payload)||kindProblem(kind,payload))throw Error('INVALID_PAYLOAD');
  if(!targetsValid(targets,kind))throw Error(kind==='MESSAGE'?'NO_NOTIFY_TARGET':'NO_EXECUTE_TARGET');
  return Object.freeze({taskId,dispatchedBy:uid,payload:normalizePayload(payload),kind,
    targets:Object.freeze(Object.fromEntries(TARGET_KEYS.map(k=>[k,targets[k]]))),status:'PENDING',progress:Object.freeze({}),acks:Object.freeze({})});
}
// Exactly the stored fields (payload shown separately as text); timestamp is filled by the server. C8: kind + acks:{}.
export function previewDoc(task){return {taskId:task.taskId,dispatchedBy:task.dispatchedBy,kind:task.kind,targets:{...task.targets},status:task.status,timestamp:'ייקבע בשרת',progress:{},acks:{}};}
// C8: kind is part of the draft key, so changing it invalidates the preview.
export function draftKey(payload,targets,kind='TASK'){return JSON.stringify([kind,normalizePayload(payload),TARGET_KEYS.map(k=>targets?.[k]??'')]);}
// C8: defaults computed ONCE when the kind changes (never on a heartbeat). TASK: every agent IGNORE (non-targets
// stay IGNORE; the owner picks EXECUTE). MESSAGE: NOTIFY for agents whose listener is 'up' at that moment, else IGNORE.
// Switching TASK -> MESSAGE with any EXECUTE selected is BLOCKED (returns null); nothing is converted silently.
export function kindSwitch(fromKind,toKind,targets,liveness={}){
  if(!KINDS.includes(toKind))return null;
  if(fromKind===toKind)return {targets:{...targets},note:null};
  if(toKind==='MESSAGE'&&TARGET_KEYS.some(k=>targets?.[k]==='EXECUTE'))return null;
  if(toKind==='MESSAGE')return {targets:Object.fromEntries(TARGET_KEYS.map(k=>[k,liveness[k]==='up'?'NOTIFY':'IGNORE'])),note:null};
  const dropped=TARGET_KEYS.filter(k=>targets?.[k]==='NOTIFY');
  return {targets:Object.fromEntries(TARGET_KEYS.map(k=>[k,'IGNORE'])),note:dropped.length?'notify_dropped':null};
}
// Server snapshot of one of our own tasks (getDocFromServer after a failed or unconfirmed create).
export function reconcileTask(task,found){
  if(!found||found.exists!==true)return 'missing';
  return found.taskId===task.taskId&&found.dispatchedBy===task.dispatchedBy&&found.payload===task.payload
    &&TARGET_KEYS.every(k=>found.targets?.[k]===task.targets[k])?'saved':'conflict';
}

// Progress entries as mapped by the adapter: {state, step, updatedAt:ms}. Anything else is "unknown".
export function validEntry(e){
  return !!e&&typeof e==='object'&&Object.keys(e).length===3&&Object.hasOwn(PROGRESS_STEPS,e.state)&&PROGRESS_STEPS[e.state].includes(e.step)&&Number.isSafeInteger(e.updatedAt);
}
export function validTaskRow(r){
  return !!r&&UUID_V4.test(r.id)&&r.taskId===r.id&&typeof r.payload==='string'&&typeof r.dispatchedBy==='string'&&TASK_STATUSES.includes(r.status)
    &&Number.isSafeInteger(r.timestamp)&&!!r.targets&&TARGET_KEYS.every(k=>TARGET_VALUES.includes(r.targets[k]))&&!!r.progress&&typeof r.progress==='object'
    &&(r.kind===undefined||KINDS.includes(r.kind))&&(r.acks===undefined||(!!r.acks&&typeof r.acks==='object'));
}
export const rowKind=r=>r?.kind===undefined?'TASK':r.kind;
export function validAck(a){
  return !!a&&typeof a==='object'&&ACK_STATES.includes(a.state)&&typeof a.summary==='string'&&[...a.summary].length<=SUMMARY_MAX
    &&Number.isSafeInteger(a.updatedAt)&&((a.state==='UNDERSTOOD')===(a.summary.length>0));
}
// C3: server-time offset. Every server stamp observed on receipt is <= the true server time, so the offset is the
// max of (serverStamp - clientNowAtReceipt). null until a first server stamp arrives (then nothing is computed).
export function learnOffset(prev,serverMs,clientMs){
  if(!Number.isSafeInteger(serverMs)||!Number.isFinite(clientMs))return prev??null;
  const o=serverMs-clientMs;return prev===null||prev===undefined?o:Math.max(prev,o);
}
export const serverNow=(clientNow,offset)=>offset===null||offset===undefined?null:clientNow+offset;
// One ack line per TARGET agent (EXECUTE or NOTIFY); null for non-targets (C1: a non-target never lights up).
// opts: {serverNowMs|null, fresh (feed is live), switchState 'on'|'off'|'missing'|'unknown', listenerAck 'on'|'off'|null}
// kind: understood | unreadable | lit | lit_no_answer | waiting | no_ack | no_ack_maybe_off | listener_off | switch_off | switch_missing | closed
// C2: when the feed is not fresh the line is marked stale and "no answer" is never computed.
export function ackFor(row,key,{serverNowMs=null,fresh=true,switchState='unknown',listenerAck=null}={}){
  const target=row?.targets?.[key];if(target!=='EXECUTE'&&target!=='NOTIFY')return null;
  const agent=TARGET_AGENTS.find(([,k])=>k===key)[0];
  const raw=row.acks?.[key];const a=validAck(raw)?raw:null;
  const out=(kind,text,extra={})=>Object.freeze({key,agent,kind,text:fresh?text:text+' · '+TEXT.ack.stale,stale:!fresh,summary:null,updatedAt:a?.updatedAt??null,...extra});
  if(a?.state==='UNDERSTOOD')return out('understood',TEXT.ack.understood,{summary:a.summary});
  if(a?.state==='UNREADABLE')return out('unreadable',TEXT.ack.unreadable);
  const t=fresh?serverNowMs:null;
  // UI 25572dc condition 2: a stopped / missing switch explains a silent listener better than the LIT timeout does,
  // so it is checked BEFORE the LIT state (final UNDERSTOOD/UNREADABLE above stay as they are).
  if(row.status==='PENDING'&&switchState==='off')return out('switch_off',TEXT.ack.switchOff);
  if(row.status==='PENDING'&&switchState==='missing')return out('switch_missing',TEXT.ack.switchMissing);
  if(a?.state==='LIT'){
    if(t!==null&&t-a.updatedAt>ACK_LIT_TIMEOUT_MS)return out('lit_no_answer',TEXT.ack.litNoAnswer);
    return out('lit',TEXT.ack.lit);
  }
  if(row.status!=='PENDING')return out('closed',TEXT.ack.closed);
  if(listenerAck==='off')return out('listener_off',TEXT.ack.listenerOff);
  if(t!==null&&t-row.timestamp>ACK_NONE_TIMEOUT_MS)return listenerAck==='on'?out('no_ack',TEXT.ack.noAck):out('no_ack_maybe_off',TEXT.ack.noAckMaybeOff);
  return out('waiting',TEXT.ack.waiting);
}
// C10: which manual owner click is allowed now (mirrors Rules atOwnerTransition): 'start' | 'complete' | null.
export function ownerAction(row,key){
  if(row?.status!=='PENDING'||row.targets?.[key]!=='EXECUTE')return null;
  const p=row.progress?.[key];if(!validEntry(p))return null;
  if(p.state==='READY'&&p.step==='delivered')return 'start';
  if(p.state==='IN_PROGRESS')return 'complete';
  return null;
}
// Listener liveness from task_listeners/{key}.seenAt (ms): 'none' | 'down' | 'up'. Only a listener identity can write
// that document (Rules); CI telemetry heartbeats never reach it.
// known=false (listener stream failed or only a cached snapshot) -> 'unknown', never "אין מאזין".
export function listenerState(seenAt,now,known=true){
  if(!known)return 'unknown';
  if(!Number.isSafeInteger(seenAt))return 'none';
  if(seenAt-now>CLOCK_SKEW_MS)return 'down';
  return now-seenAt<=HEARTBEAT_FRESH_MS?'up':'down';
}
export function listenerText(seenAt,now,known=true){return {none:TEXT.listenerNone,down:TEXT.listenerDown,up:TEXT.listenerUp,unknown:TEXT.listenerUnknown}[listenerState(seenAt,now,known)];}
const hhmm=ms=>{const s=formatDisplayStamp(ms);return s==='—'?'—':s.slice(11);};
// One chip per target agent: {key, agent, kind, text, updatedAt|null, quiet:boolean}.
// kind: ignore | waiting | delivered | delivery_off | rejected | in_progress | no_pulse | pulse_unknown | stuck | completed | failed | unknown
// pulse_unknown: the listener stream failed / is offline, so the pulse is not known (never shown as no_pulse).
export function chipFor(row,key,{now,seenAt,pulseKnown=true}){
  const agent=TARGET_AGENTS.find(([,k])=>k===key)[0];
  if(row.targets[key]==='NOTIFY')return Object.freeze({key,agent,kind:'notify',text:'להודיע בלבד',updatedAt:null,quiet:false});
  if(row.targets[key]!=='EXECUTE')return Object.freeze({key,agent,kind:'ignore',text:TEXT.ignore,updatedAt:null,quiet:false});
  const raw=row.progress[key];
  const base={key,agent,updatedAt:null,quiet:false};
  if(raw===undefined){const quiet=row.status==='PENDING'&&now-row.timestamp>QUIET_MS;
    return Object.freeze({...base,kind:'waiting',text:quiet?TEXT.waiting+' · '+TEXT.quiet+hhmm(row.timestamp):TEXT.waiting,quiet});}
  if(!validEntry(raw))return Object.freeze({...base,kind:'unknown',text:TEXT.unknown});
  const at=raw.updatedAt,quiet=row.status==='PENDING'&&now-at>QUIET_MS;
  const withQuiet=text=>quiet?text+' · '+TEXT.quiet+hhmm(at):text;
  if(raw.state==='READY')return Object.freeze(raw.step==='delivered'?{...base,kind:'delivered',text:withQuiet(TEXT.delivered),updatedAt:at,quiet}:{...base,kind:'delivery_off',text:TEXT.deliveryOff,updatedAt:at,quiet:false});
  if(raw.state==='REJECTED')return Object.freeze({...base,kind:'rejected',text:TEXT.rejected[raw.step],updatedAt:at});
  if(raw.state==='COMPLETED')return Object.freeze({...base,kind:'completed',text:TEXT.completed,updatedAt:at});
  if(raw.state==='FAILED')return Object.freeze({...base,kind:'failed',text:TEXT.failed,updatedAt:at});
  // IN_PROGRESS: set ONLY by the owner's manual click (t176u); older docs may carry a listener-written IN_PROGRESS.
  // Stale -> unknown/stuck; no fresh heartbeat -> say so (C10 keeps this rendering for old docs).
  if(now-at>STUCK_MS)return Object.freeze({...base,kind:'stuck',text:TEXT.stuck+' · '+TEXT.quiet+hhmm(at),updatedAt:at,quiet:true});
  if(!pulseKnown)return Object.freeze({...base,kind:'pulse_unknown',text:TEXT.pulseUnknown,updatedAt:at});
  const live=listenerState(seenAt,now);
  if(live!=='up')return Object.freeze({...base,kind:'no_pulse',text:Number.isSafeInteger(seenAt)?TEXT.noPulse+hhmm(seenAt):TEXT.noPulseEver,updatedAt:at});
  return Object.freeze({...base,kind:'in_progress',text:TEXT.inProgress,updatedAt:at});
}
// Derived overall status (never stored). 'בביצוע' only if the owner marked IN_PROGRESS AND the listener
// heartbeat is fresh; a report without a pulse (no_pulse) or a stale one (stuck) gets its own "unknown" kind.
export function overallStatus(row,chips){
  if(row.status==='CANCELLED')return {kind:'CANCELLED',text:TEXT.overall.CANCELLED};
  if(rowKind(row)==='MESSAGE')return {kind:'message',text:TEXT.overall.message};
  const active=chips.filter(c=>c.kind!=='ignore'&&c.kind!=='notify');
  if(active.length&&active.every(c=>['completed','failed','rejected'].includes(c.kind)))return {kind:'done',text:TEXT.overall.done};
  if(active.some(c=>c.kind==='in_progress'))return {kind:'running',text:TEXT.overall.running};
  if(active.some(c=>c.kind==='pulse_unknown'))return {kind:'pulse_unknown',text:TEXT.overall.pulse_unknown};
  if(active.some(c=>c.kind==='no_pulse'))return {kind:'no_pulse',text:TEXT.overall.no_pulse};
  if(active.some(c=>c.kind==='stuck'))return {kind:'stuck',text:TEXT.overall.stuck};
  if(active.some(c=>c.kind==='delivered'))return {kind:'delivered',text:TEXT.overall.delivered};
  if(active.some(c=>c.kind==='delivery_off'))return {kind:'saved',text:TEXT.overall.saved};
  return {kind:'waiting',text:TEXT.overall.waiting};
}
// Feed: valid rows only, newest first by server timestamp (ties by id); duplicates keep the latest server snapshot.
export function orderTasks(rows){
  const byId=new Map();for(const r of Array.isArray(rows)?rows:[])if(validTaskRow(r))byId.set(r.id,r);
  return [...byId.values()].sort((a,b)=>(b.timestamp-a.timestamp)||(a.id<b.id?-1:a.id>b.id?1:0)).slice(0,OWNER_LIST_LIMIT);
}
// Server document -> plain row (used by the browser adapter and the emulator end-to-end test). Throws on a malformed
// task document; a malformed progress entry is kept as-is and rendered "מצב לא מוכר" (validEntry fails).
const toMs=v=>typeof v?.toMillis==='function'?v.toMillis():null;
export function mapTaskDoc(id,x){
  const keys=Object.keys(x??{});
  if(!TASK_KEYS.every(k=>keys.includes(k))||!keys.every(k=>TASK_KEYS.includes(k)||OPTIONAL_TASK_KEYS.includes(k))||toMs(x.timestamp)===null||!x.targets||typeof x.targets!=='object'
    ||!x.progress||typeof x.progress!=='object'||(x.kind!==undefined&&!KINDS.includes(x.kind))||(x.acks!==undefined&&(!x.acks||typeof x.acks!=='object')))throw Error('INVALID_ACTIVE_TASK');
  const progress={};
  for(const k of TARGET_KEYS)if(Object.hasOwn(x.progress,k)){const e=x.progress[k];
    progress[k]=e&&typeof e==='object'?{state:e.state,step:e.step,updatedAt:toMs(e.updatedAt),...(Object.keys(e).length!==3?{extra:true}:{})}:{state:null,step:null,updatedAt:null,extra:true};}
  const acks={};
  if(x.acks)for(const k of TARGET_KEYS)if(Object.hasOwn(x.acks,k)){const a=x.acks[k];
    acks[k]=a&&typeof a==='object'?{state:a.state,summary:typeof a.summary==='string'?a.summary:null,updatedAt:toMs(a.updatedAt)}:{state:null,summary:null,updatedAt:null};}
  return {id,taskId:x.taskId,dispatchedBy:x.dispatchedBy,payload:x.payload,status:x.status,timestamp:toMs(x.timestamp),kind:x.kind===undefined?'TASK':x.kind,
    targets:{codex:x.targets.codex,grok:x.targets.grok,gemini:x.targets.gemini},progress,acks};
}
// task_listeners docs [{id,data}] -> {codex|grok|gemini: seenAt ms}; anything malformed is ignored ("אין מאזין").
// Heartbeat docs may carry ack ('on'|'off') and mode ('push'|'poll') (C5); older docs have only {agent, seenAt}.
const HB_KEYS=['agent','seenAt','ack','mode'];
const validHb=(id,data)=>TARGET_KEYS.includes(id)&&data&&Object.keys(data).every(k=>HB_KEYS.includes(k))&&data.agent===id&&toMs(data.seenAt)!==null
  &&(data.ack===undefined||['on','off'].includes(data.ack))&&(data.mode===undefined||['push','poll'].includes(data.mode));
export function mapListenerDocs(docs){
  const seen={};
  for(const {id,data} of Array.isArray(docs)?docs:[])if(validHb(id,data))seen[id]=toMs(data.seenAt);
  return seen;
}
// {codex|grok|gemini: {ack:'on'|'off'|null, mode:'push'|'poll'|null}} — null when the heartbeat has no such field.
export function mapListenerMeta(docs){
  const meta={};
  for(const {id,data} of Array.isArray(docs)?docs:[])if(validHb(id,data))meta[id]={ack:data.ack??null,mode:data.mode??null};
  return meta;
}
// control/ack_switch -> 'on' | 'off' | 'missing' (server snapshot only; anything malformed is 'unknown').
export function mapAckSwitch(snap){
  if(!snap||snap.exists===false)return {state:'missing',updatedAt:null};
  const d=snap.data;if(!d||typeof d.enabled!=='boolean')return {state:'unknown',updatedAt:null};
  return {state:d.enabled?'on':'off',updatedAt:toMs(d.updatedAt)};
}
