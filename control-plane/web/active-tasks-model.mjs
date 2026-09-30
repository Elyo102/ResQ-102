// Pure active-tasks model: no DOM, no SDK, no network. Unit-tested in control-plane/active-tasks-model.test.mjs.
// Security review 30/09/2026 (SAFE_WITH_CONDITIONS), see control-plane/ACTIVE-TASKS.md:
// - The owner writes the task document (status PENDING) and may only cancel it while PENDING.
// - Each agent's listener identity writes ONLY progress[own key]; nobody but the owner writes status.
// - The overall status shown here is DERIVED from progress; it is never stored.
// - A task is never approval for push, deploy, delete or secrets. Pickup is manual only.
// - READY/delivered (DELIVERED) is never shown as "בביצוע"; only the agent's own IN_PROGRESS report is.
import {NOTE_MAX,NOTE_PATTERN,NOTE_RULES_PATTERN,UUID_V4,hasSecret,AUTH_MAX_AGE_MS,needsReauth,classifyFailure,formatDisplayStamp,renderStamp} from './dispatch-model.mjs?v=20260930-grok-dispatch4';
export {NOTE_MAX,NOTE_PATTERN,NOTE_RULES_PATTERN,UUID_V4,AUTH_MAX_AGE_MS,needsReauth,classifyFailure,renderStamp};

// Fixed agent map (display name -> key), identical to atKeyFor() in the Rules. Claude is not a target.
export const TARGET_AGENTS=Object.freeze([['Gemini','gemini'],['Codex','codex'],['Grok','grok']].map(Object.freeze));
export const TARGET_KEYS=Object.freeze(TARGET_AGENTS.map(([,k])=>k));
export const TARGET_VALUES=Object.freeze(['EXECUTE','IGNORE']);
export const TASK_KEYS=Object.freeze(['taskId','dispatchedBy','payload','targets','status','timestamp','progress']);
export const TASK_STATUSES=Object.freeze(['PENDING','CANCELLED']);
// Closed progress vocabulary, identical to atSteps() in the Rules.
export const PROGRESS_STEPS=Object.freeze({READY:Object.freeze(['delivered','delivery_off']),REJECTED:Object.freeze(['invalid','secret','limit','declined']),
  IN_PROGRESS:Object.freeze(['started']),COMPLETED:Object.freeze(['completed']),FAILED:Object.freeze(['failed'])});
export const PAYLOAD_MAX=NOTE_MAX;
export const OWNER_LIST_LIMIT=20;     // Rules: owner list limit 1..20, orderBy(timestamp desc)
export const LISTENER_LIST_LIMIT=3;   // Rules: task_listeners list limit 1..3
export const HEARTBEAT_FRESH_MS=95000; // listener heartbeat every 60s; fresh when seen within 95s
export const CLOCK_SKEW_MS=60000;
export const QUIET_MS=30*60000;        // "ללא עדכון מאז" after 30 minutes without a progress change
export const STUCK_MS=60*60000;        // IN_PROGRESS without any update for 60 minutes -> "לא ידוע / תקוע"
export const SEND_TIMEOUT_MS=12000;

export const TEXT=Object.freeze({
  ignore:'לא נבחר',waiting:'ממתין למאזין',delivered:'נמסר — טרם התחיל',deliveryOff:'מסירה כבויה, המשימה נשמרה בלבד',
  inProgress:'בביצוע',noPulse:'בביצוע — אין דופק מאז ',noPulseEver:'בביצוע — אין דופק מהמאזין',pulseUnknown:'מצב המאזין לא ידוע',stuck:'לא ידוע / תקוע',
  completed:'הושלם',failed:'נכשל',unknown:'מצב לא מוכר',quiet:'ללא עדכון מאז ',
  rejected:{invalid:'נדחה — משימה לא תקינה',secret:'נדחה — נראה שיש סוד',limit:'נדחה — יותר מדי משימות פתוחות',declined:'נדחה ע"י הסוכן'},
  listenerNone:'אין מאזין',listenerDown:'מנותק',listenerUp:'מאזין',listenerUnknown:'לא ידוע (אין חיבור)',
  overall:{CANCELLED:'בוטל',done:'הסתיים',running:'בביצוע (לפי דיווח הסוכן)',no_pulse:'לא ידוע — דווח התחלה, אין דופק מהמאזין',pulse_unknown:'מצב המאזין לא ידוע',stuck:'לא ידוע / תקוע',
    delivered:'נמסר — טרם התחיל',saved:'נשמר בלבד (מסירה כבויה)',waiting:'ממתין'}
});

// Payload: same allowlist and size as the dispatch note (LF, printable ASCII, Hebrew letters and points; <= 10000).
// No silent fix: only CRLF/CR -> LF (what a textarea already reports). A tab or any other character is BLOCKED and
// reported with its code point, line and column. Widening (״ ׳ U+05F3/U+05F4, curly quotes) was suggested by the UI
// review but NOT approved by security, so the allowlist is unchanged.
export const PAYLOAD_CHAR=/^[\u{000A}\u{0020}-\u{007E}\u{05D0}-\u{05EA}\u{05B0}-\u{05C7}]$/u;
const VISIBLE=/^[\p{L}\p{N}\p{P}\p{S}]$/u;
export function normalizePayload(raw){return typeof raw==='string'?raw.replace(/\r\n?/g,'\n'):raw;}
// Threshold announcements (separate polite region): null below 9000, then '9000', '9900', '10000', 'over'.
export function payloadThreshold(raw){const n=payloadLength(raw);if(n>PAYLOAD_MAX)return 'over';if(n===PAYLOAD_MAX)return '10000';if(n>=9900)return '9900';if(n>=9000)return '9000';return null;}
export function payloadThresholdText(level){return {'9000':'התוכן הגיע ל-9000 תווים מתוך 10000.','9900':'התוכן הגיע ל-9900 תווים מתוך 10000.','10000':'התוכן הגיע למגבלה של 10000 תווים.',over:'התוכן חורג מ-10000 תווים. השמירה חסומה עד לקיצור.'}[level]??'';}
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
export function targetsValid(targets){
  return !!targets&&typeof targets==='object'&&Object.keys(targets).length===3&&TARGET_KEYS.every(k=>TARGET_VALUES.includes(targets[k]))
    &&TARGET_KEYS.some(k=>targets[k]==='EXECUTE');
}
// Exact document shown in the preview and sent; timestamp is the server time added by the adapter.
export function buildTask({taskId,uid,payload,targets}){
  if(!UUID_V4.test(taskId??''))throw Error('INVALID_TASK_ID');
  if(typeof uid!=='string'||!uid)throw Error('UID_REQUIRED');
  if(payloadProblem(payload))throw Error('INVALID_PAYLOAD');
  if(!targetsValid(targets))throw Error('NO_EXECUTE_TARGET');
  return Object.freeze({taskId,dispatchedBy:uid,payload:normalizePayload(payload),
    targets:Object.freeze(Object.fromEntries(TARGET_KEYS.map(k=>[k,targets[k]]))),status:'PENDING',progress:Object.freeze({})});
}
// Exactly the stored fields (payload shown separately as text); timestamp is filled by the server.
export function previewDoc(task){return {taskId:task.taskId,dispatchedBy:task.dispatchedBy,targets:{...task.targets},status:task.status,timestamp:'ייקבע בשרת',progress:{}};}
export function draftKey(payload,targets){return JSON.stringify([normalizePayload(payload),TARGET_KEYS.map(k=>targets?.[k]??'')]);}
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
    &&Number.isSafeInteger(r.timestamp)&&!!r.targets&&TARGET_KEYS.every(k=>TARGET_VALUES.includes(r.targets[k]))&&!!r.progress&&typeof r.progress==='object';
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
  // IN_PROGRESS: reported by that agent's own listener identity. Stale -> unknown/stuck; no fresh heartbeat -> say so.
  if(now-at>STUCK_MS)return Object.freeze({...base,kind:'stuck',text:TEXT.stuck+' · '+TEXT.quiet+hhmm(at),updatedAt:at,quiet:true});
  if(!pulseKnown)return Object.freeze({...base,kind:'pulse_unknown',text:TEXT.pulseUnknown,updatedAt:at});
  const live=listenerState(seenAt,now);
  if(live!=='up')return Object.freeze({...base,kind:'no_pulse',text:Number.isSafeInteger(seenAt)?TEXT.noPulse+hhmm(seenAt):TEXT.noPulseEver,updatedAt:at});
  return Object.freeze({...base,kind:'in_progress',text:TEXT.inProgress,updatedAt:at});
}
// Derived overall status (never stored). 'בביצוע' only if some agent itself reported IN_PROGRESS AND its listener
// heartbeat is fresh; a report without a pulse (no_pulse) or a stale one (stuck) gets its own "unknown" kind.
export function overallStatus(row,chips){
  if(row.status==='CANCELLED')return {kind:'CANCELLED',text:TEXT.overall.CANCELLED};
  const active=chips.filter(c=>c.kind!=='ignore');
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
  if(keys.length!==TASK_KEYS.length||!TASK_KEYS.every(k=>keys.includes(k))||toMs(x.timestamp)===null||!x.targets||typeof x.targets!=='object'
    ||!x.progress||typeof x.progress!=='object')throw Error('INVALID_ACTIVE_TASK');
  const progress={};
  for(const k of TARGET_KEYS)if(Object.hasOwn(x.progress,k)){const e=x.progress[k];
    progress[k]=e&&typeof e==='object'?{state:e.state,step:e.step,updatedAt:toMs(e.updatedAt),...(Object.keys(e).length!==3?{extra:true}:{})}:{state:null,step:null,updatedAt:null,extra:true};}
  return {id,taskId:x.taskId,dispatchedBy:x.dispatchedBy,payload:x.payload,status:x.status,timestamp:toMs(x.timestamp),
    targets:{codex:x.targets.codex,grok:x.targets.grok,gemini:x.targets.gemini},progress};
}
// task_listeners docs [{id,data}] -> {codex|grok|gemini: seenAt ms}; anything malformed is ignored ("אין מאזין").
export function mapListenerDocs(docs){
  const seen={};
  for(const {id,data} of Array.isArray(docs)?docs:[])if(TARGET_KEYS.includes(id)&&data&&Object.keys(data).length===2&&data.agent===id&&toMs(data.seenAt)!==null)seen[id]=toMs(data.seenAt);
  return seen;
}
