// Pure Agent Dispatch Center model: no DOM, no SDK, no network. Unit-tested in control-plane/dispatch-model.test.mjs.
// A dispatch request is a REQUEST shown to the owner, never an authorization. The note is display-only text:
// it never flows into a prompt, shell, branch or commit name, or a routing decision.
import {formatDisplayStamp,formatSecondsStamp,displayParts,renderStamp} from './private-view.mjs?v=20260930-grok-dispatch6';
export {formatDisplayStamp,formatSecondsStamp,displayParts,renderStamp};

// Fixed map, mirrored byte-for-byte in the deployed Rules (dispatchTaskMap) and checked by dispatch-drift.test.mjs.
// Lowercase capability-matrix ids map explicitly to the capitalized Rules names. Excluded on purpose:
// 'executor', Codex 'commit-branch-dispatch', and Claude (no dispatchable task types).
export const AGENT_NAME_BY_ID=Object.freeze({gemini:'Gemini',codex:'Codex',grok:'Grok'});
export const DISPATCH_AGENTS=Object.freeze(['Gemini','Codex','Grok']);
export const DISPATCH_TASKS=Object.freeze({
  Gemini:Object.freeze(['docs','long-analysis','test-coverage','cross-browser']),
  Codex:Object.freeze(['integration','integration-tests']),
  Grok:Object.freeze(['realtime','service-workers','offline-outbox','telemetry-relays'])
});
export const EXCLUDED_TASK_TYPES=Object.freeze(['executor','commit-branch-dispatch']);
export const TASK_TYPE_TEXT=Object.freeze({docs:'תיעוד','long-analysis':'ניתוח ארוך','test-coverage':'כיסוי בדיקות','cross-browser':'בדיקות בין דפדפנים',
  integration:'אינטגרציה','integration-tests':'בדיקות אינטגרציה',realtime:'זמן אמת','service-workers':'Service Workers','offline-outbox':'תור יציאה לא מקוון','telemetry-relays':'ממסרי טלמטריה'});
export function taskTypeText(type){return typeof type==='string'&&Object.hasOwn(TASK_TYPE_TEXT,type)?`${TASK_TYPE_TEXT[type]} (${type})`:'סוג לא מוכר';}

// Note allowlist: LF, printable ASCII, Hebrew letters and Hebrew points only; at most 10,000 code points.
// The Rules use the same RE2 class written as \\x{....} (see NOTE_RULES_PATTERN) with `*` (no quantifier above 1000)
// plus size() <= 10000. Every allowed character is in the BMP, so code points == UTF-16 units == Rules size().
// Before counting, validating and sending, CRLF/CR become LF and a tab becomes two spaces (shown in the preview).
// No NFC/NFKC or any other change.
export const NOTE_MAX=10000;
export const NOTE_THRESHOLDS=Object.freeze([9000,9900,10000]);
export const NOTE_RULES_PATTERN='^[\\\\x{000A}\\\\x{0020}-\\\\x{007E}\\\\x{05D0}-\\\\x{05EA}\\\\x{05B0}-\\\\x{05C7}]*$';
export const NOTE_PATTERN=/^[\u{000A}\u{0020}-\u{007E}\u{05D0}-\u{05EA}\u{05B0}-\u{05C7}]*$/u;
const NOTE_CHAR=/^[\u{000A}\u{0020}-\u{007E}\u{05D0}-\u{05EA}\u{05B0}-\u{05C7}]$/u;
export const NOTE_BANNER='הערה לתצוגה בלבד, לא מבוצעת ולא מועברת לסוכן';
export const SECRET_TEXT='נראה שההערה מכילה סוד (טוקן, מפתח או אישור גישה). אין להדביק סודות בהערה — השליחה חסומה.';
// Client-side BLOCK for secret-looking content. 'sk-' is matched only at the start of a token so words such as
// "task-" do not trip it. The matched text is never displayed or logged.
const SECRET_PATTERN=/ghp_|github_pat_|gho_|AIza|(?:^|[^A-Za-z0-9_])sk-|xox[bpa]-|-----BEGIN|PRIVATE KEY|FIREBASE_TOKEN=|GOOGLE_APPLICATION_CREDENTIALS/;
export function normalizeNote(note){return typeof note==='string'?note.replace(/\r\n?/g,'\n').replace(/\t/g,'  '):note;}
export const noteLength=note=>typeof note==='string'?[...normalizeNote(note)].length:0;
export const hasSecret=note=>typeof note==='string'&&SECRET_PATTERN.test(normalizeNote(note));
export function noteProblem(raw){
  if(typeof raw!=='string')return 'type';
  const note=normalizeNote(raw);
  if(SECRET_PATTERN.test(note))return 'secret';
  if([...note].length>NOTE_MAX)return 'length';
  if(!NOTE_PATTERN.test(note))return 'chars';
  return null;
}
// Offending characters with their line numbers, e.g. 'U+201C בשורה 12' (first `limit` distinct findings).
export function invalidCharReport(raw,limit=5){
  if(typeof raw!=='string')return [];
  const out=[];let line=1;
  for(const c of normalizeNote(raw)){
    if(c==='\n'){line++;continue;}
    if(!NOTE_CHAR.test(c)){const item=`U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')} בשורה ${line}`;if(!out.includes(item))out.push(item);if(out.length>=limit)break;}
  }
  return out;
}
export function rejectedNoteChars(raw){return typeof raw==='string'?[...new Set([...normalizeNote(raw)].filter(c=>!NOTE_CHAR.test(c)))].map(c=>'U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')):[];}
export function counterText(raw){const n=noteLength(raw);return n>NOTE_MAX?`${n}/${NOTE_MAX} — חריגה של ${n-NOTE_MAX} תווים, השליחה חסומה`:`${n}/${NOTE_MAX}`;}
// Threshold level for the separate announcement region: null below 9000, then '9000', '9900', '10000', 'over'.
export function noteThreshold(raw){const n=noteLength(raw);if(n>NOTE_MAX)return 'over';if(n===NOTE_MAX)return '10000';if(n>=9900)return '9900';if(n>=9000)return '9000';return null;}
export function thresholdText(level){return {'9000':'ההערה הגיעה ל-9000 תווים מתוך 10000.','9900':'ההערה הגיעה ל-9900 תווים מתוך 10000.','10000':'ההערה הגיעה למגבלה של 10000 תווים.',over:'ההערה חורגת מ-10000 תווים. השליחה חסומה עד לקיצור.'}[level]??'';}
// Collapsed feed rendering: at most SNIPPET_CHARS code points and SNIPPET_LINES lines; full text only on expand.
export const SNIPPET_CHARS=500;
export const SNIPPET_LINES=8;
export function noteSnippet(note){
  const cps=[...(typeof note==='string'?note:'')];let text=cps.slice(0,SNIPPET_CHARS).join('');
  const lines=text.split('\n');if(lines.length>SNIPPET_LINES)text=lines.slice(0,SNIPPET_LINES).join('\n');
  return {text,truncated:text.length<(typeof note==='string'?note.length:0)};
}

export const UUID_V4=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const AUTH_MAX_AGE_MS=840000;   // client re-sign-in threshold; Rules allow 900s
export const COOLDOWN_MS=15000;        // client-side only; there is no server rate limit
export const SEND_TIMEOUT_MS=12000;
export const HISTORY_LIMIT=20;       // client feed size; the Rules still allow list limits up to 50

export function selectionsValid(selections){
  const chosen=DISPATCH_AGENTS.filter(a=>typeof selections?.[a]==='string'&&selections[a]!=='');
  return chosen.length>0&&chosen.every(a=>DISPATCH_TASKS[a].includes(selections[a]));
}
// Idempotency keys: one batchId plus one doc id per agent, all v4. Callers keep them across retries and only
// ask for new ones after a confirmed success or an explicit reset.
export function newKeys(uuid){const k={batchId:uuid(),ids:{}};for(const a of DISPATCH_AGENTS)k.ids[a]=uuid();
  if(![k.batchId,...Object.values(k.ids)].every(v=>UUID_V4.test(v)))throw Error('INVALID_UUID');return Object.freeze({batchId:k.batchId,ids:Object.freeze(k.ids)});}
// The exact snapshot shown in the preview and sent (createdAt is the server timestamp added by the adapter).
export function buildPayload({selections,note,keys,uid}){
  if(!selectionsValid(selections))throw Error('NO_VALID_SELECTION');
  if(noteProblem(note))throw Error('INVALID_NOTE');
  note=normalizeNote(note);
  if(!keys||!UUID_V4.test(keys.batchId))throw Error('INVALID_KEYS');
  if(typeof uid!=='string'||!uid)throw Error('UID_REQUIRED');
  const rows=DISPATCH_AGENTS.filter(a=>selections[a]).map(agent=>{
    const id=keys.ids[agent];if(!UUID_V4.test(id))throw Error('INVALID_KEYS');
    return Object.freeze({id,data:Object.freeze({agent,taskType:selections[agent],note,status:'queued',batchId:keys.batchId,createdBy:uid})});
  });
  return Object.freeze({batchId:keys.batchId,rows:Object.freeze(rows)});
}
export function payloadKey(payload){return JSON.stringify(payload.rows.map(r=>[r.id,r.data.agent,r.data.taskType,r.data.note,r.data.status,r.data.batchId,r.data.createdBy]));}
export function draftKey(selections,note){return JSON.stringify([DISPATCH_AGENTS.map(a=>selections?.[a]??''),note]);}

// Server statuses only; progress states are never inferred on the client.
export const STATUS_TEXT=Object.freeze({queued:'בתור',cancelled:'בוטל'});
export function statusText(status){
  if(typeof status==='string'&&Object.hasOwn(STATUS_TEXT,status))return STATUS_TEXT[status];
  const shown=typeof status==='string'?status.replace(/[^a-z0-9_-]/gi,'').slice(0,32):'';
  return shown?`סטטוס שרת: ${shown}`:'סטטוס לא מוכר';
}
// Feed rows come from the adapter as plain objects with numeric ms timestamps.
export function validFeedRow(r){
  return !!r&&UUID_V4.test(r.id)&&typeof r.agent==='string'&&typeof r.taskType==='string'&&typeof r.note==='string'
    &&typeof r.status==='string'&&Number.isSafeInteger(r.createdAt)&&(r.cancelledAt===null||Number.isSafeInteger(r.cancelledAt));
}
const historyAt=r=>r.status==='cancelled'&&Number.isSafeInteger(r.cancelledAt)?r.cancelledAt:Number.isSafeInteger(r.updatedAt)?r.updatedAt:r.createdAt;
const byDesc=key=>(a,b)=>(key(b)-key(a))||(a.id<b.id?-1:a.id>b.id?1:0);
// Stable ordering: pinned active (queued) by createdAt desc; history by cancelledAt/updatedAt/createdAt desc;
// ties broken by id; history capped at HISTORY_LIMIT (20). Duplicate ids keep the row with the latest server state.
export function orderFeed(rows){
  const byId=new Map();
  for(const r of Array.isArray(rows)?rows:[]){if(!validFeedRow(r))continue;const prior=byId.get(r.id);
    if(!prior||(prior.status==='queued'&&r.status!=='queued'))byId.set(r.id,r);}
  const all=[...byId.values()];
  return {active:all.filter(r=>r.status==='queued').sort(byDesc(r=>r.createdAt)),
    history:all.filter(r=>r.status!=='queued').sort(byDesc(historyAt)).slice(0,HISTORY_LIMIT)};
}
export function needsReauth(authTimeMs,now){return !Number.isSafeInteger(authTimeMs)||!Number.isSafeInteger(now)||now-authTimeMs>AUTH_MAX_AGE_MS||authTimeMs-now>60000;}
// Classify a failed commit. 'unconfirmed' = the write may still land later; never a success.
export function classifyFailure(error){
  const code=String(error?.code??'').replace(/^firestore\//,'');
  if(code==='permission-denied')return 'denied';
  return 'unconfirmed';
}
// Reconcile retry/denial against server reads (getDocFromServer) of every id of the batch.
export function reconcile(payload,found){
  const map=new Map((found||[]).map(f=>[f.id,f]));
  const results=payload.rows.map(r=>{const f=map.get(r.id);
    if(!f||f.exists!==true)return 'missing';
    return f.batchId===r.data.batchId&&f.agent===r.data.agent&&f.taskType===r.data.taskType&&f.createdBy===r.data.createdBy?'saved':'conflict';});
  if(results.every(r=>r==='saved'))return 'saved';
  if(results.every(r=>r==='missing'))return 'missing';
  return 'conflict';
}
