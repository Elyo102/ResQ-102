// חישובי השרת על הסידור האפקטיבי — סריקת נוכחות ומכסת המזהים.
//
// `functions/index.js` הוא CommonJS ואינו נטען בהארנס; הפונקציות
// נחלצות מהמקור ורצות מול רנטיים מזויף שמחזיר תשובת
// `effectiveWorkDaysForStation` ידועה. מה שנבדק:
//  · loadEffectiveSchedule מפצל >500 מזהים לקריאות, מאחד, ומסרב
//    אם המקור השתנה בין הקריאות.
//  · works(uid, key) → true · false · 'unknown' — מחוץ לטווח, יום מחוץ
//    לכיסוי, ואדם שאינו בתשובה: לא-ידוע.
//  · scanPerson: יום לא ידוע אינו מייצר „חסר דיווח" ולא „לא מתוכנן",
//    אבל הסכום, שעות לא סבירות, משמרת פתוחה ונימוק חסר — כן.
import fs from 'fs';
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const src = fs.readFileSync(__j(__TESTS, '..', 'functions/index.js'), 'utf8');

const grab = name => {
  const i = (() => { const a = src.indexOf('async function ' + name + '('); return a >= 0 ? a : src.indexOf('function ' + name + '('); })();
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + name);
};
const constant = name => {
  const m = src.match(new RegExp('const ' + name + ' = ([^;]+);'));
  if (!m) throw new Error('constant missing: ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
};

const mod = [constant('WORKDAYS_MAX_UIDS'), grab('pad2'), grab('keyOffset'),
  grab('loadEffectiveSchedule'), grab('scanPerson')].join('\n\n');

let bad = 0;
const ck = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log((ok ? '✓ ' : '✗ ') + what + (ok ? '' : ': ' + JSON.stringify(got) + '  — ציפיתי ' + JSON.stringify(want)));
};

function harness(answer) {
  const calls = [];
  const scheduleRuntime = {
    async effectiveWorkDaysForStation(sid, input) {
      calls.push({ sid, input });
      return typeof answer === 'function' ? answer(input, calls.length) : answer;
    }
  };
  const f = new Function('scheduleRuntime', mod + '\nreturn { loadEffectiveSchedule, scanPerson };')(scheduleRuntime);
  return { f, calls };
}

const baseAnswer = (uids) => ({
  mode: 'new', source: 'publication', fallback: null,
  from: '2026-09-01', to: '2026-09-30',
  coverage: { from: '2026-09-01', to: '2026-09-15' },
  unknown_dates: Array.from({ length: 15 }, (_, i) => '2026-09-' + String(16 + i).padStart(2, '0')),
  unknown_uids: {},
  by_uid: Object.fromEntries(uids.map(u => [u, ['2026-09-01', '2026-09-04', '2026-09-07']])),
  provenance: { mode: 'new', source: 'v2', publication_id: 'p1', revision: 3 }
});

// --- מכסה ופיצול
{
  const { f, calls } = harness((input) => baseAnswer(input.uids));
  const uids = Array.from({ length: 1203 }, (_, i) => 'u' + i);
  const sched = await f.loadEffectiveSchedule('eilat_102', '2026-09-01', '2026-09-30', uids);
  ck('1,203 מזהים → 3 קריאות של ≤500', calls.map(c => c.input.uids.length), [500, 500, 203]);
  ck('כל קריאה נושאת את התחנה והטווח', calls.every(c => c.sid === 'eilat_102' && c.input.from === '2026-09-01' && c.input.to === '2026-09-30'), true);
  ck('u1202 עובד ב-1.9', sched.works('u1202', '2026-09-01'), true);
  ck('u0 לא עובד ב-2.9', sched.works('u0', '2026-09-02'), false);
  ck('יום מחוץ לכיסוי הפרסום — לא ידוע', sched.works('u0', '2026-09-20'), 'unknown');
  ck('יום מחוץ לטווח הקריאה — לא ידוע', sched.works('u0', '2026-10-01'), 'unknown');
  ck('אדם שלא נשאל עליו — לא ידוע, לא false', sched.works('stranger', '2026-09-01'), 'unknown');
  ck('mode/source עוברים', [sched.mode, sched.source, sched.fallback], ['new', 'publication', null]);
}

// --- מקור שהשתנה בין שני חלקים → סירוב
{
  const { f } = harness((input, n) => Object.assign(baseAnswer(input.uids),
    n === 2 ? { provenance: { mode: 'new', source: 'v2', publication_id: 'p2', revision: 4 } } : {}));
  let threw = null;
  try { await f.loadEffectiveSchedule('eilat_102', '2026-09-01', '2026-09-30', Array.from({ length: 600 }, (_, i) => 'u' + i)); }
  catch (e) { threw = e.message; }
  ck('פרסום התחלף באמצע → שגיאה ולא תשובה מעורבבת', threw, 'effective schedule changed between reads');
}

// --- רשימה ריקה: קריאה אחת, בלי מזהים
{
  const { f, calls } = harness((input) => baseAnswer(input.uids));
  await f.loadEffectiveSchedule('eilat_102', '2026-09-01', '2026-09-30', []);
  ck('רשימה ריקה — קריאה אחת', calls.length, 1);
}

// --- scanPerson על לא-ידוע
{
  const { f } = harness((input) => baseAnswer(input.uids));
  const sched = await f.loadEffectiveSchedule('eilat_102', '2026-09-01', '2026-09-30', ['u1']);
  const recs = [
    { date: '2026-09-04', hours: 24, day_type: 'regular' },              // מתוכנן ודווח
    { date: '2026-09-02', hours: 8, day_type: 'regular' },               // לא מתוכנן, דווח רגיל → הערה
    { date: '2026-09-20', hours: 24, day_type: 'regular' },              // לא ידוע, דווח → בלי הערה
    { date: '2026-09-21', hours: 60, day_type: 'regular' },              // לא ידוע + שעות לא סבירות → כן
    { date: '2026-09-22', start: '08:00', end: '', hours: 0, day_type: 'regular' }, // פתוחה → כן
    { date: '2026-09-23', hours: 10, day_type: 'regular', reason_required: true }    // נימוק חסר → כן
  ];
  const out = f.scanPerson({ uid: 'u1', emp: '7', crew: '' }, recs, sched, '2026-09', 200, '2026-09-30');
  const kinds = out.findings.map(x => x.kind + ':' + x.date).sort();
  ck('סכום נשמר גם עם ימים לא ידועים', out.total, 126);
  ck('1.9 ו-7.9 מתוכננים ואין דיווח → missing; 2.9 → unscheduled; לא-ידוע (16–30) בלי missing/unscheduled',
    kinds, ['bad_hours:2026-09-21', 'missing:2026-09-01', 'missing:2026-09-07', 'no_reason:2026-09-23', 'open:2026-09-22', 'unscheduled:2026-09-02']);
  const noUid = f.scanPerson({ uid: '', emp: '8', crew: 'A' }, recs, sched, '2026-09', 200, '2026-09-30');
  ck('בלי uid — הכול לא ידוע: אין missing ואין unscheduled, השאר נשאר', noUid.findings.map(x => x.kind).sort(), ['bad_hours', 'no_reason', 'open']);
  const over = f.scanPerson({ uid: 'u1', emp: '7', crew: '' }, recs, sched, '2026-09', 100, '2026-09-30');
  ck('מעל הסף — נספר על הסכום, לא תלוי בסידור', over.findings.some(x => x.kind === 'over_limit'), true);
}

// --- ההגנה על המקור: אין יותר קריאה ישירה של rotations/shift_overrides ב-index.js
{
  const direct = /collection\('stations\/' \+ [a-zA-Z_]+ \+ '\/(rotations|shift_overrides)'\)/.test(src);
  ck('index.js אינו קורא rotations/shift_overrides ישירות לצורך „מי עובד"', direct, false);
  ck('הנוסחה הכפולה (crewOnKey/isWorking) נמחקה', /function (crewOnKey|isWorking)\(/.test(src), false);
}

console.log('\n' + (bad ? bad + ' כשלים בחישובי השרת' : 'חישובי השרת על הסידור האפקטיבי — עברו'));
process.exit(bad ? 1 : 0);
