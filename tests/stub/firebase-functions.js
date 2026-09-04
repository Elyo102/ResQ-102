import { STUB_SWAPS } from './firebase-firestore.js';

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
  if (name === 'getEffectiveWorkdays') return stubWorkdays(payload);
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
      window.__CALLABLE_CALLS.push({ name, payload });
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
        reject({ code:step.code || 'functions/unavailable', message:step.message || 'stub failure' });
        return;
      }
      resolve({ data:(step && step.data) || defaultCallableStep(name, payload).data });
    }, delay));
  };
}
