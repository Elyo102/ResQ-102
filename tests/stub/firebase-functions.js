import { STUB_SWAPS, collection, getDocs, query, where, orderBy, limit } from './firebase-firestore.js';

// 42H.20 · ביקורת Codex, חוסם 3 · getAlertsFeed בסטאב: אותה לוגיקה כמו
// functions/bulletin-receipts.js alertsFeed, מעל נתוני הסטאב של Firestore
// (הודעות, קריאות, __BULLETIN_RECEIPTS_SEEN / __CALLOUT_SEEN_EXTRA) — כדי
// שבדיקות הדפדפן של מסך ההתראות ופעמון הבית ירוצו מול אותה תשובה
// שהשרת מחזיר, בלי שהדפדפן יקרא קבלות בעצמו.
async function stubAlertsFeed(){
  const uid = (typeof window !== 'undefined' && window.__SMOKE_UID) || 'stub-uid';
  const sid = 'eilat_102';
  const db = {};
  const ms = value => {
    if (value && typeof value.toMillis === 'function') return Number(value.toMillis());
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const boards = (await getDocs(collection(db, 'stations', sid, 'sub_stations'))).docs
    .map(d => ({ id:d.id, name:(d.data() || {}).name || d.id }));
  const items = [];
  for (const board of boards) {
    const snap = await getDocs(query(collection(db, 'stations', sid, 'sub_stations', board.id, 'bulletin_messages'),
      where('hidden', '==', false), orderBy('created_at', 'desc'), limit(10)));
    for (const m of snap.docs) {
      const data = m.data() || {};
      // "השרת" רואה את הקבלות שלו ישירות — לא דרך getDoc של הדפדפן
      // (הנתיב חסום ל-client, ובדיקת הדפדפן מוודאת שאין קריאה כזו).
      const seenSet = typeof window !== 'undefined' && window.__BULLETIN_RECEIPTS_SEEN;
      const key = m.id + '/' + uid;
      const receiptSeen = !!seenSet && (seenSet.has ? seenSet.has(key) : seenSet.indexOf(key) !== -1);
      items.push({ kind:'bulletin', id:board.id + '/' + m.id, board_id:board.id, board_name:board.name,
        text:String(data.text || ''), by_name:String(data.by_name || 'חבר צוות'),
        time_ms:ms(data.created_at) || ms(data.created_key), viewed:data.by_uid === uid || receiptSeen });
    }
  }
  const callouts = await getDocs(query(collection(db, 'stations', sid, 'callouts'),
    where('uids', 'array-contains', uid), orderBy('created_key', 'desc'), limit(25)));
  for (const c of callouts.docs) {
    const data = c.data() || {};
    const calloutSeen = typeof window !== 'undefined' && window.__CALLOUT_SEEN_EXTRA;
    const seen = !!calloutSeen && (calloutSeen.has ? calloutSeen.has(c.id) : calloutSeen.indexOf(c.id) !== -1);
    items.push({ kind:'callout', id:c.id, text:String(data.text || ''), active:data.active !== false,
      by_name:String(data.by_name || ''), time_ms:ms(data.created_at) || ms(data.created_key), viewed:seen });
  }
  items.sort((a, b) => b.time_ms - a.time_ms);
  return { data:{ schema:'alerts-feed-v1', generated_at_ms:Date.now(),
    unread_count:items.filter(i => !i.viewed).length, items:items.slice(0, 30),
    window:{ boards:boards.length, messages_per_board:10, callouts:25, feed_limit:30, candidates:items.length } } };
}

async function stubCalloutRecipients(payload){
  const db = {};
  const crew = String((payload && payload.crew) || 'B');
  const snap = await getDocs(collection(db, 'stations', 'eilat_102', 'roster'));
  const recipients = [];
  snap.forEach(doc => {
    const value = doc.data() || {};
    if (value.is_active === false || String(value.crew || '') !== crew) return;
    recipients.push({ uid:doc.id, name:String(value.full_name || doc.id), crew:String(value.crew || '') });
  });
  recipients.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'he'));
  return { data:{ ok:true, station_id:'eilat_102', crew, recipients } };
}

export function getFunctions(){ return {}; }

// אותו סבב בדיוק כמו בתשובת התאימות למטה: A/B/C, עוגן 2026-01-01,
// חריגים ב-14.8 (A), 20.8 (אימון), 25.8 (כוננות + B). כך „מי עובד" בשני
// הנתיבים — הישן (rotation.js בדפדפן) והחדש (getEffectiveWorkdays) —
// מסכימים, והבדיקות שמשוות ביניהם רואות סתירה אמיתית ולא רעש.
const STUB_CREW_OF = { 'stub-uid':'C', u1:'C', u2:'A', u3:'A', u4:'B', u5:'B' };
const STUB_OVERRIDES = {
  '2026-08-14':{ crew:'A', extra_crews:[] },
  '2026-08-20':{ crew:'', extra_crews:[] },
  '2026-08-25':{ crew:'', extra_crews:['B'] }
};
function stubCrewOn(key){
  const ov = STUB_OVERRIDES[key];
  if (ov && ov.crew) return ov.crew;
  const p = key.split('-').map(Number);
  const diff = Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(2026, 0, 1)) / 86400000);
  return ['A', 'B', 'C'][((diff % 3) + 3) % 3];
}
function stubKeyPlus(key, n){
  const p = key.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}
function stubWorks(uid, key){
  for (const pair of STUB_SWAPS) {
    const sw = Array.isArray(pair) ? pair[1] : pair;
    if (!sw || sw.status !== 'approved') continue;
    if (key === sw.from_date) { if (uid === sw.from_uid) return false; if (uid === sw.to_uid) return true; }
    if (key === sw.to_date)   { if (uid === sw.to_uid) return false;   if (uid === sw.from_uid) return true; }
  }
  const crewOf = Object.assign({}, STUB_CREW_OF, (typeof window !== 'undefined' && window.__STUB_CREW_OF) || {});
  const crew = crewOf[uid];
  if (!crew) return null;
  if (stubCrewOn(key) === crew) return true;
  const ov = STUB_OVERRIDES[key];
  return !!(ov && ov.extra_crews.indexOf(crew) !== -1);
}
function stubWorkdays(payload){
  const data = payload || {};
  const unknownDates = (typeof window !== 'undefined' && window.__STUB_UNKNOWN_DATES) || [];
  const mode = (typeof window !== 'undefined' && window.__STUB_WORKDAYS_MODE) || 'shadow';
  const byUid = {};
  const unknownUids = {};
  (Array.isArray(data.uids) ? data.uids : []).forEach(function (uid) {
    const list = [];
    for (let k = data.from; k <= data.to; k = stubKeyPlus(k, 1)) {
      if (unknownDates.indexOf(k) !== -1) continue;
      const w = stubWorks(uid, k);
      if (w === null) { unknownUids[uid] = 'not-in-roster'; return; }
      if (w) list.push(k);
    }
    byUid[uid] = list;
  });
  return { data:{
    mode, source: mode === 'new' ? 'publication' : 'legacy', fallback: null,
    from: data.from, to: data.to,
    coverage: { from: data.from, to: data.to },
    unknown_dates: unknownDates.filter(k => k >= data.from && k <= data.to),
    unknown_uids: unknownUids, by_uid: byUid,
    shift_hours: { shift_start:'07:00', shift_end:'07:00', shift_hours:24, hours_source:'legacy-rotation-config' },
    provenance: { mode, source: mode === 'new' ? 'v2' : 'legacy' },
    generated_at: '2026-08-23T10:00:00.000Z'
  } };
}

function defaultCallableStep(name, payload){
  if (name === 'getAlertsFeed') return { data:{ __async:stubAlertsFeed } };
  if (name === 'listCalloutRecipients') return { data:{ __async:() => stubCalloutRecipients(payload) } };
  if (name === 'getPersonalLiveLabStatus') return { data:{ active:false, expires_at_ms:0 } };
  if (name === 'enablePersonalLiveLab') return { data:{ active:true, expires_at_ms:Date.now()+86400000 } };
  if (name === 'sendPersonalLiveLabPush') return { data:{ probe_id:String((payload || {}).request_id || ''), state:'accepted', duplicate:false } };
  if (name === 'ackPersonalLiveLabPush') return { data:{ ok:true } };
  if (name === 'getEffectiveWorkdays') return stubWorkdays(payload);
  if (name === 'getAttendanceCorrectionContext') {
    const data = payload || {};
    return { data:{
      station_id:'eilat_102', target_uid:String(data.target_uid || ''),
      employee_number:String(data.employee_number || ''), month:String(data.month || ''),
      target:{ full_name:'טל חודרה', crew:'A', role:'firefighter', inactive:false },
      report:{ exists:false, status:'draft', expected_version:null },
      days:[], missing_dates:[],
      eligibility:{ can_create:true, can_recalculate:true, can_reopen:false,
        historical:false, reopening_valid:false },
      snapshot_at_ms:Date.now()
    } };
  }
  if (name === 'getLegacyScheduleCompatibilityContext') {
    return { data:{
      mode:'shadow',
      rotations:[
        { crew:'A', position_in_cycle:0, cycle_days:3,
          anchor_date:'2026-01-01', is_active:true,
          shift_start:'07:00', shift_end:'07:00', shift_hours:24 },
        { crew:'B', position_in_cycle:1, cycle_days:3,
          anchor_date:'2026-01-01', is_active:true },
        { crew:'C', position_in_cycle:2, cycle_days:3,
          anchor_date:'2026-01-01', is_active:true }
      ],
      overrides:{
        '2026-08-14':{ date:'2026-08-14', kind:'swap', crew:'A', extra_crews:[] },
        '2026-08-20':{ date:'2026-08-20', kind:'training', crew:'', extra_crews:[] },
        '2026-08-25':{ date:'2026-08-25', kind:'standby', crew:'', extra_crews:['B'] }
      }
    } };
  }
  return { data:{ ok:true, id:'stub-message' } };
}

// קריאות שרת נשלטות בידי בדיקת הדפדפן. ברירת המחדל מצליחה,
// ואפשר להזריק מערך תוצאות/שגיאות דרך window.__CALLABLE_PLAN.
// כל ניסיון נשמר, כולל requestId, כדי לבדוק retry idempotent
// ומניעת שליחה כפולה בלי להתחבר לשרת אמיתי.
export function httpsCallable(_functions, name){
  if (typeof window !== 'undefined') {
    window.__CALLABLE_FACTORIES = window.__CALLABLE_FACTORIES || [];
    window.__CALLABLE_FACTORIES.push(name);
  }
  return payload => {
    if (typeof window !== 'undefined') {
      window.__CALLABLE_CALLS = window.__CALLABLE_CALLS || [];
      // Firebase serializes the payload at call time. Keep the probe faithful:
      // later client mutations must not rewrite the recorded first attempt.
      const recordedPayload = payload === undefined
        ? undefined
        : JSON.parse(JSON.stringify(payload));
      window.__CALLABLE_CALLS.push({ name, payload:recordedPayload });
      window.__CALLABLE_INFLIGHT = (window.__CALLABLE_INFLIGHT || 0) + 1;
      window.__CALLABLE_MAX_INFLIGHT = Math.max(
        window.__CALLABLE_MAX_INFLIGHT || 0,
        window.__CALLABLE_INFLIGHT
      );
    }

    const plans = (typeof window !== 'undefined' && window.__CALLABLE_PLAN) || {};
    const list = Array.isArray(plans[name]) ? plans[name] : [];
    const step = list.length ? list.shift() : defaultCallableStep(name, payload);
    const delay = Number(step && step.delay) || 0;

    return new Promise((resolve, reject) => setTimeout(() => {
      if (typeof window !== 'undefined') {
        window.__CALLABLE_INFLIGHT = Math.max(0, (window.__CALLABLE_INFLIGHT || 1) - 1);
      }
      if (step && step.reject) {
        reject({
          code:step.code || 'functions/unavailable',
          message:step.message || 'stub failure',
          details:step.details
        });
        return;
      }
      const data = (step && step.data) || defaultCallableStep(name, payload).data;
      if (data && typeof data.__async === 'function') { data.__async().then(resolve, reject); return; }
      resolve({ data });
    }, delay));
  };
}
