/* ====================================================================
 *  schedule-policy-author-probe
 *
 *  בדיקה עצמאית ל-`functions/schedule-policy-author.js`.
 *
 *  היא לא מסתפקת ב„המודול לא זרק". היא מוכיחה ארבעה דברים:
 *
 *   1. **המסמך שהמודול מייצר מתקבל בפועל על ידי המנוע.**
 *      לא השוואה לסכימה שכתבתי לעצמי — `createCalendarEngine`
 *      האמיתי נבנה עליו. אם המנוע ישנה את החוזה, זה ייפול כאן.
 *
 *   2. **אין ברירת מחדל עסקית.** לכל שדה עסקי יש מקרה שבו הוא
 *      חסר — ונדרש קוד שגיאה, לא ערך שהומצא.
 *
 *   3. **הבדיקות נופלות על קוד שבור.** 12 מוטציות. מוטציה
 *      ששורדת פירושה בדיקה שאינה בודקת דבר.
 *
 *   4. **אין PII.** לא במסמך, לא ב-audit, לא בהודעות השגיאה.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { readSource } from './source-text.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'functions');
const AUTHOR_PATH = resolve(FN, 'schedule-policy-author.js');
const ENGINE_PATH = resolve(FN, 'schedule-calendar-engine.js');
const require_ = createRequire(import.meta.url);

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(name, a === b, 'קיבלתי ' + a + ' במקום ' + b);
}
function throwsCode(name, fn, code) {
  try { fn(); } catch (e) { ok(name, e.code === code, 'קוד ' + e.code + ' במקום ' + code); return; }
  ok(name, false, 'לא נזרקה שגיאה כלל');
}

/* ---------------- טעינה ---------------- */

let author, engineMod, AUTHOR_SRC, ENGINE_SRC;
try {
  AUTHOR_SRC = readSource(AUTHOR_PATH);
  ENGINE_SRC = readSource(ENGINE_PATH);
  author = require_(AUTHOR_PATH);
  engineMod = require_(ENGINE_PATH);
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון את המודולים: ' + e.message);
  process.exit(2);
}

function extractFn(src, signature) {
  const at = src.indexOf(signature);
  if (at === -1) return null;
  const end = src.indexOf('\n}\n', at);
  return end === -1 ? null : src.slice(at, end + 2);
}

const runtimeSrc = (() => {
  try { return readSource(resolve(FN, 'schedule-runtime.js')); }
  catch (_) { return null; }
})();

const FIXED = Date.UTC(2026, 8, 2, 6, 0, 0);
const clock = () => FIXED;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const A = author.createPolicyAuthor({ clock, hash });
const CODE = author.CODE, WARN = author.WARN, CHANGE = author.CHANGE;

/* ---------------- טיוטה תקינה ---------------- */

function draft(over) {
  const base = {
    sub_stations: {
      rashit: {
        label: 'ראשית',
        minimum: 6,
        requirements: [
          { role: 'officer', label: 'קצין', count: 1, required: true },
          { role: 'driver', label: 'נהג', count: 2, required: true },
          { role: 'ff', label: 'כבאי', count: 3, required: false }
        ]
      },
      timna: {
        label: 'תמנע',
        minimum: 3,
        requirements: [
          { role: 'driver', label: 'נהג', count: 1, required: true },
          { role: 'ff', label: 'כבאי', count: 2, required: true }
        ]
      }
    },
    rest: { min_gap_days: 2 },
    rotation: { groups: ['a', 'b', 'c'], anchor: '2026-01-01', days_per_group: 1, strict: true },
    max_shifts_per_month: 12
  };
  return Object.assign(base, over || {});
}
const plan = (over, extra) => A.planPolicy(Object.assign(
  { station_id: 'station-102', draft: draft(over), actor_uid: 'uid-abc' }, extra || {}));

/**
 * טיוטה שנמסרת **כמות שהיא**, בלי מיזוג מעל הבסיס.
 *
 * זה נחוץ דווקא למקרים של „שדה חסר": `Object.assign` על אובייקט
 * שממנו נמחק שדה **מחזיר את השדה מהבסיס**, ואז הבדיקה שאמורה
 * להוכיח שאין ברירת מחדל בודקת טיוטה מלאה ועוברת לשווא.
 */
const planRaw = (d, extra) => A.planPolicy(Object.assign(
  { station_id: 'station-102', draft: d, actor_uid: 'uid-abc' }, extra || {}));

/* ================================================================
 * 1 · המסמך מתקבל על ידי המנוע האמיתי
 * ================================================================ */

let good;
try {
  good = plan();
  eq('1.1 נוצר', good.kind, 'created');
  ok('1.2 יש מסמך', good.document && typeof good.document === 'object');
  eq('1.3 גרסה ראשונה', good.version, 'v1');

  // ⭐ ההוכחה. לא סכימה שכתבתי — המנוע עצמו.
  const eng = engineMod.createCalendarEngine({ clock, policy: good.document });
  ok('1.4 המנוע נבנה על המסמך', !!eng);
  ok('1.5 policy_id נגזר מחתימת התוכן',
    good.policy_id === 'policy_v1_' + good.content_key.slice(0, 12), good.policy_id);
  eq('1.7 המסמך מסומן שלם', good.document.complete, true);
  eq('1.8 content_digest נשמר', good.document.content_digest, good.digest);
  eq('1.6 אין החלשה במסמך ראשון', good.weakening, []);
} catch (e) {
  ok('1.x המנוע דחה את המסמך', false, e.code + ' · ' + e.message);
}

/* ================================================================
 * 2 · אין ברירות מחדל עסקיות
 * ================================================================ */

function without(path) {
  const d = draft();
  const parts = path.split('.');
  let node = d;
  for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]];
  delete node[parts[parts.length - 1]];
  return d;
}

throwsCode('2.1 קו מינימום חסר',
  () => planRaw(without('sub_stations.rashit.minimum')), CODE.MINIMUM_MISSING);
throwsCode('2.2 מנוחה חסרה',
  () => planRaw(without('rest')), CODE.REST_MISSING);
throwsCode('2.3 min_gap_days חסר',
  () => planRaw(without('rest.min_gap_days')), CODE.REST_MISSING);
throwsCode('2.4 מחזוריות לא הוצהרה',
  () => planRaw(without('rotation')), CODE.ROTATION_MISSING);
throwsCode('2.5 תקרה לא הוצהרה',
  () => planRaw(without('max_shifts_per_month')), CODE.LIMIT_MISSING);
throwsCode('2.6 סימון חובה/רשות חסר', () => {
  const d = draft();
  delete d.sub_stations.timna.requirements[0].required;
  return planRaw(d);
}, CODE.REQUIRED_MISSING);
throwsCode('2.7 כמות חסרה', () => {
  const d = draft();
  delete d.sub_stations.timna.requirements[0].count;
  return planRaw(d);
}, CODE.COUNT_INVALID);
throwsCode('2.8 אין תחנות קצה',
  () => plan({ sub_stations: {} }), CODE.NO_SUB_STATIONS);
throwsCode('2.9 תחנת קצה בלי דרישות', () => {
  const d = draft();
  d.sub_stations.timna.requirements = [];
  return planRaw(d);
}, CODE.NO_REQUIREMENTS);
throwsCode('2.10 אין תחנה',
  () => A.planPolicy({ draft: draft() }), CODE.STATION);

/* ⭐ מפתחות שמורים: "__proto__" עובר את regex המפתחות (קו תחתון מותר),
 * ו-`subs[k] = …` היה קובע prototype במקום ערך. "constructor"/"prototype"
 * חוזרים דרך ירושה מכל אובייקט רגיל. שלושתם נדחים — בתחנת קצה,
 * בתפקיד, בקבוצת מחזוריות ובמזהה התחנה. */
for (const key of ['__proto__', 'constructor', 'prototype']) {
  throwsCode('2.11 תחנת קצה בשם שמור: ' + key, () => {
    const d = draft();
    d.sub_stations = JSON.parse('{"' + key + '":' + JSON.stringify(d.sub_stations.timna) + '}');
    return planRaw(d);
  }, CODE.SUB_ID);
  throwsCode('2.12 תפקיד בשם שמור: ' + key, () => {
    const d = draft();
    d.sub_stations.timna.requirements = [{ role: key, label: 'x', count: 1, required: true }];
    return planRaw(d);
  }, CODE.ROLE_INVALID);
  throwsCode('2.13 קבוצת מחזוריות בשם שמור: ' + key,
    () => plan({ rotation: { groups: ['a', key], anchor: '2026-01-01', days_per_group: 1, strict: true } }),
    CODE.ROTATION_INVALID);
  throwsCode('2.14 מזהה תחנה שמור: ' + key,
    () => A.planPolicy({ station_id: key, draft: draft(), actor_uid: 'uid-abc' }), CODE.STATION);
}
ok('2.15 Object.prototype נשאר נקי אחרי הניסיונות',
  Object.getOwnPropertyNames(Object.prototype).indexOf('label') === -1
  && Object.getOwnPropertyNames(Object.prototype).indexOf('requirements') === -1);

// ⭐ null אינו „חסר" עבור rotation ו-cap — הוא הצהרה מפורשת.
try {
  const r = plan({ rotation: null, max_shifts_per_month: null });
  eq('2.11 rotation:null מתקבל', r.document.rotation, null);
  eq('2.12 cap:null מתקבל', r.document.max_shifts_per_month, null);
  engineMod.createCalendarEngine({ clock, policy: r.document });
  ok('2.13 המנוע מקבל גם את הצורה הזאת', true);
} catch (e) {
  ok('2.11–2.13 הצהרת null', false, e.code + ' · ' + e.message);
}

/* ================================================================
 * 3 · מחרוזת אינה מספר — זה מה שמגיע מ-<input>
 * ================================================================ */

throwsCode('3.1 מינימום כמחרוזת', () => {
  const d = draft(); d.sub_stations.rashit.minimum = '6'; return planRaw(d);
}, CODE.MINIMUM_MISSING);
throwsCode('3.2 מינימום כמחרוזת ריקה', () => {
  const d = draft(); d.sub_stations.rashit.minimum = ''; return planRaw(d);
}, CODE.MINIMUM_MISSING);
throwsCode('3.3 כמות עשרונית', () => {
  const d = draft(); d.sub_stations.rashit.requirements[0].count = 1.5; return planRaw(d);
}, CODE.COUNT_INVALID);
throwsCode('3.4 מנוחה כמחרוזת', () => {
  const d = draft(); d.rest.min_gap_days = '2'; return planRaw(d);
}, CODE.REST_MISSING);
throwsCode('3.5 required כמחרוזת "true"', () => {
  const d = draft(); d.sub_stations.timna.requirements[0].required = 'true'; return planRaw(d);
}, CODE.REQUIRED_MISSING);
throwsCode('3.6 מינימום שלילי', () => {
  const d = draft(); d.sub_stations.rashit.minimum = -1; return planRaw(d);
}, CODE.MINIMUM_MISSING);
throwsCode('3.7 תפקיד כפול', () => {
  const d = draft();
  d.sub_stations.timna.requirements.push({ role: 'driver', count: 1, required: false });
  return planRaw(d);
}, CODE.ROLE_DUPLICATE);
throwsCode('3.8 עוגן מחזוריות שאינו תאריך קיים',
  () => plan({ rotation: { groups: ['a'], anchor: '2026-02-30', days_per_group: 1, strict: false } }),
  CODE.ROTATION_INVALID);
throwsCode('3.9 קבוצה כפולה במחזוריות',
  () => plan({ rotation: { groups: ['a', 'a'], anchor: '2026-01-01', days_per_group: 1, strict: false } }),
  CODE.ROTATION_INVALID);
throwsCode('3.10 מחזוריות בלי הצהרת strict',
  () => plan({ rotation: { groups: ['a'], anchor: '2026-01-01', days_per_group: 1 } }),
  CODE.ROTATION_INVALID);
throwsCode('3.11 תקרה 0', () => plan({ max_shifts_per_month: 0 }), CODE.LIMIT_INVALID);

/* ================================================================
 * 4 · דטרמיניזם · אותו קלט → אותה חתימה
 * ================================================================ */

try {
  const a = plan();
  const b = plan();
  eq('4.1 חתימה יציבה', a.digest, b.digest);

  // סדר המפתחות בטיוטה אינו משנה את המסמך.
  const flipped = draft();
  const reordered = { timna: flipped.sub_stations.timna, rashit: flipped.sub_stations.rashit };
  flipped.sub_stations = reordered;
  const c = A.planPolicy({ station_id: 'station-102', draft: flipped, actor_uid: 'uid-abc' });
  eq('4.2 סדר תחנות הקצה אינו משנה חתימה', c.digest, a.digest);

  // סדר הדרישות בתוך תחנת קצה אינו משנה את החתימה.
  const rev = draft();
  rev.sub_stations.rashit.requirements.reverse();
  const e = A.planPolicy({ station_id: 'station-102', draft: rev, actor_uid: 'uid-abc' });
  eq('4.3 סדר הדרישות אינו משנה חתימה', e.digest, a.digest);

  // שינוי אמיתי כן משנה.
  const f = plan({ rest: { min_gap_days: 3 } });
  ok('4.4 שינוי אמיתי משנה חתימה', f.digest !== a.digest);

  // ⭐ מי שומר אינו חלק מהחתימה: אותה מדיניות בידי אדם אחר אינה
  // מדיניות אחרת.
  const g = A.planPolicy({ station_id: 'station-102', draft: draft(), actor_uid: 'uid-zzz' });
  eq('4.5 השומר אינו נכנס לחתימה', g.digest, a.digest);
} catch (e) {
  ok('4.x דטרמיניזם', false, e.message);
}

/* ================================================================
 * 5 · גרסאות ו„לא השתנה כלום"
 * ================================================================ */

try {
  const first = plan();
  const prev = Object.assign({ id: first.policy_id }, first.document);

  const same = plan(undefined, { previous: prev });
  eq('5.1 שמירה זהה מדווחת כ-unchanged', same.kind, 'unchanged');
  eq('5.2 unchanged אינו מייצר מסמך', same.document, null);
  eq('5.3 unchanged שומר על הגרסה הקיימת', same.version, 'v1');

  const next = plan({ rest: { min_gap_days: 3 } }, { previous: prev });
  eq('5.4 שינוי מעלה גרסה', next.version, 'v2');
  eq('5.5 סוג העדכון', next.kind, 'updated');
  eq('5.6 supersedes מצביע לקודם', next.document.supersedes, first.policy_id);

  const third = plan({ rest: { min_gap_days: 4 } },
    { previous: Object.assign({ id: next.policy_id }, next.document) });
  eq('5.7 גרסה שלישית', third.version, 'v3');

  // גרסה קודמת פגומה אינה מפילה — היא מתחילה מ-v1.
  const broken = plan({ rest: { min_gap_days: 5 } },
    { previous: { version: 'לא-גרסה', digest: 'x' } });
  eq('5.8 גרסה קודמת פגומה → v1', broken.version, 'v1');
} catch (e) {
  ok('5.x גרסאות', false, e.message);
}

/* ================================================================
 * 6 · הפרשים והחלשות
 * ================================================================ */

try {
  const first = plan();
  const prev = Object.assign({ id: first.policy_id }, first.document);

  const lower = draft();
  lower.sub_stations.rashit.minimum = 4;
  const r1 = A.planPolicy({ station_id: 'station-102', draft: lower,
    actor_uid: 'uid-abc', previous: prev });
  const m = r1.changes.find((c) => c.kind === CHANGE.MINIMUM);
  ok('6.1 ירידת קו מינימום מזוהה', !!m, JSON.stringify(r1.changes));
  eq('6.2 מ-6 ל-4', [m && m.from, m && m.to], [6, 4]);
  eq('6.3 ירידת קו מסומנת החלשה', m && m.weakens, true);
  eq('6.4 ההחלשה מרוכזת בנפרד', r1.weakening.length, 1);

  const raise = draft();
  raise.sub_stations.rashit.minimum = 8;
  const r2 = A.planPolicy({ station_id: 'station-102', draft: raise,
    actor_uid: 'uid-abc', previous: prev });
  eq('6.5 העלאת קו אינה החלשה',
    r2.changes.find((c) => c.kind === CHANGE.MINIMUM).weakens, false);
  eq('6.6 אין החלשות', r2.weakening, []);

  // חובה → רשות מרחיב את מה שייחשב תקין. זו החלשה.
  const relax = draft();
  relax.sub_stations.rashit.requirements[0].required = false;
  const r3 = A.planPolicy({ station_id: 'station-102', draft: relax,
    actor_uid: 'uid-abc', previous: prev });
  const rq = r3.changes.find((c) => c.kind === CHANGE.REQUIRED);
  eq('6.7 חובה→רשות מסומן החלשה', rq && rq.weakens, true);

  // רשות → חובה אינה החלשה.
  const tighten = draft();
  tighten.sub_stations.rashit.requirements[2].required = true;
  const r4 = A.planPolicy({ station_id: 'station-102', draft: tighten,
    actor_uid: 'uid-abc', previous: prev });
  eq('6.8 רשות→חובה אינה החלשה',
    r4.changes.find((c) => c.kind === CHANGE.REQUIRED).weakens, false);

  // הסרת תחנת קצה מוחקת את כל התקן שלה.
  const dropped = draft();
  delete dropped.sub_stations.timna;
  const r5 = A.planPolicy({ station_id: 'station-102', draft: dropped,
    actor_uid: 'uid-abc', previous: prev });
  const rm = r5.changes.find((c) => c.kind === CHANGE.SUB_REMOVED);
  eq('6.9 הסרת תחנת קצה היא החלשה', rm && rm.weakens, true);

  // הוספת תחנת קצה אינה החלשה.
  const added = draft();
  added.sub_stations.yotvata = { label: 'יטבתה', minimum: 2,
    requirements: [{ role: 'ff', count: 2, required: true }] };
  const r6 = A.planPolicy({ station_id: 'station-102', draft: added,
    actor_uid: 'uid-abc', previous: prev });
  eq('6.10 הוספת תחנת קצה אינה החלשה',
    r6.changes.find((c) => c.kind === CHANGE.SUB_ADDED).weakens, false);

  // ביטול תקרה הוא החלשה; ביטול מחזוריות קשיחה — גם.
  const noCap = A.planPolicy({ station_id: 'station-102',
    draft: draft({ max_shifts_per_month: null }), actor_uid: 'uid-abc', previous: prev });
  eq('6.11 ביטול תקרה הוא החלשה',
    noCap.changes.find((c) => c.kind === CHANGE.CAP).weakens, true);
  const noRot = A.planPolicy({ station_id: 'station-102',
    draft: draft({ rotation: null }), actor_uid: 'uid-abc', previous: prev });
  eq('6.12 ביטול מחזוריות הוא החלשה',
    noRot.changes.find((c) => c.kind === CHANGE.ROTATION).weakens, true);

  // שינוי תווית בלבד אינו החלשה ואינו נעלם.
  const renamed = draft();
  renamed.sub_stations.timna.label = 'תמנע דרום';
  const r7 = A.planPolicy({ station_id: 'station-102', draft: renamed,
    actor_uid: 'uid-abc', previous: prev });
  const lb = r7.changes.find((c) => c.kind === CHANGE.LABEL);
  eq('6.13 שינוי תווית מדווח ואינו החלשה', lb && lb.weakens, false);
} catch (e) {
  ok('6.x הפרשים', false, e.message);
}

/* ================================================================
 * 7 · אזהרות · מותר, אבל שייאמר
 * ================================================================ */

function warnCodes(res) { return res.warnings.map((w) => w.code).sort(); }

try {
  eq('7.1 מדיניות תקינה אינה מזהירה', warnCodes(plan()), []);

  const zero = draft();
  zero.sub_stations.timna.minimum = 0;
  const w1 = A.planPolicy({ station_id: 'station-102', draft: zero, actor_uid: 'u' });
  ok('7.2 קו 0 מזהיר', warnCodes(w1).indexOf(WARN.ZERO_MINIMUM) !== -1, warnCodes(w1).join(','));

  const below = draft();
  below.sub_stations.rashit.minimum = 2; // התקן דורש 3 אנשי חובה
  const w2 = A.planPolicy({ station_id: 'station-102', draft: below, actor_uid: 'u' });
  const bw = w2.warnings.find((w) => w.code === WARN.MINIMUM_BELOW_REQUIRED);
  ok('7.3 קו נמוך מהתקן מזהיר', !!bw);
  eq('7.4 האזהרה נוקבת במספרים', [bw && bw.minimum, bw && bw.required_total], [2, 3]);

  const optional = draft();
  optional.sub_stations.timna.requirements.forEach((r) => { r.required = false; });
  const w3 = A.planPolicy({ station_id: 'station-102', draft: optional, actor_uid: 'u' });
  ok('7.5 תחנה בלי תפקיד חובה מזהירה',
    warnCodes(w3).indexOf(WARN.NO_REQUIRED_ROLE) !== -1, warnCodes(w3).join(','));

  const w4 = A.planPolicy({ station_id: 'station-102',
    draft: draft({ rest: { min_gap_days: 0 } }), actor_uid: 'u' });
  ok('7.6 אפס מנוחה מזהיר', warnCodes(w4).indexOf(WARN.REST_ZERO) !== -1);

  const w5 = A.planPolicy({ station_id: 'station-102',
    draft: draft({ max_shifts_per_month: null }), actor_uid: 'u' });
  ok('7.7 אין תקרה — מזהיר', warnCodes(w5).indexOf(WARN.CAP_ABSENT) !== -1);

  // ⭐ אזהרה אינה חסימה: המנוע עדיין מקבל את המסמך.
  engineMod.createCalendarEngine({ clock, policy: w2.document });
  ok('7.8 אזהרה אינה חוסמת את המנוע', true);
} catch (e) {
  ok('7.x אזהרות', false, e.message);
}

/* ================================================================
 * 8 · מוכנות
 * ================================================================ */

try {
  const none = A.readiness({});
  eq('8.1 שום דבר לא מוגדר', none.ready, false);
  ok('8.2 מפרט מה חסר', none.missing.indexOf('policy') !== -1
    && none.missing.indexOf('source') !== -1 && none.missing.indexOf('mode') !== -1,
    none.missing.join(','));

  const noPeople = A.readiness({ policy: {}, source: {}, people: [], mode: 'shadow' });
  eq('8.3 מקור בלי אנשים אינו מוכן', noPeople.ready, false);
  ok('8.4 חוסר האנשים נאמר', noPeople.missing.indexOf('people') !== -1);

  const ready = A.readiness({ policy: {}, source: {}, people: [{}, {}], mode: 'shadow' });
  eq('8.5 מוכן', ready.ready, true);
  eq('8.6 מותר להריץ בצל', ready.may_run, true);
  eq('8.7 ספירת אנשים', ready.people_count, 2);

  const off = A.readiness({ policy: {}, source: {}, people: [{}], mode: 'off' });
  eq('8.8 מוכן אך כבוי — לא רץ', off.may_run, false);
  eq('8.9 מוכן נשאר מוכן', off.ready, true);
} catch (e) {
  ok('8.x מוכנות', false, e.message);
}

/* ================================================================
 * 9 · פרטיות · שום שם, שום דוא"ל, שום טלפון
 * ================================================================ */

const PII = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b05\d[- ]?\d{7}\b|\b\d{9}\b/;

try {
  const r = plan();
  const asText = JSON.stringify(r);
  ok('9.1 אין דוא"ל/טלפון/ת"ז בתוצאה', !PII.test(asText));
  eq('9.2 audit מחזיק רק את ה-uid', Object.keys(r.audit).sort(),
    ['actor', 'at', 'change_count', 'digest', 'station_id']);
  eq('9.3 השומר נשמר כ-uid בלבד', r.audit.actor, 'uid-abc');

  // ⭐ שמות אנשים אינם חלק ממדיניות. אם מישהו יתחוב אותם
  // לטיוטה, הם לא ישרדו את הנרמול.
  const dirty = draft();
  dirty.sub_stations.rashit.owner_name = 'ישראל ישראלי';
  dirty.sub_stations.rashit.owner_email = 'a@b.com';
  dirty.sub_stations.rashit.requirements[0].person = 'דני כהן';
  const r2 = A.planPolicy({ station_id: 'station-102', draft: dirty, actor_uid: 'u' });
  const doc = JSON.stringify(r2.document);
  ok('9.4 שדות זרים בתחנת קצה נשמטים', doc.indexOf('ישראל ישראלי') === -1);
  ok('9.5 דוא"ל שנתחב נשמט', doc.indexOf('a@b.com') === -1);
  ok('9.6 שם אדם בדרישה נשמט', doc.indexOf('דני כהן') === -1);
  eq('9.7 מפתחות תחנת קצה סגורים',
    Object.keys(r2.document.sub_stations.rashit).sort(),
    ['key', 'label', 'minimum', 'requirements']);
  eq('9.8 מפתחות דרישה סגורים',
    Object.keys(r2.document.sub_stations.rashit.requirements[0]).sort(),
    ['count', 'label', 'required', 'role']);

  // הודעת שגיאה אינה מחזירה ערך שהמשתמש הקליד כשהוא עלול
  // להיות מזהה אדם — אבל כן חייבת לומר מה לא בסדר.
  try {
    const bad = draft(); bad.sub_stations.rashit.minimum = null;
    A.planPolicy({ station_id: 'station-102', draft: bad, actor_uid: 'u' });
    ok('9.9 שגיאה נזרקת', false, 'לא נזרקה');
  } catch (e) {
    ok('9.9 שגיאה נזרקת', e.code === CODE.MINIMUM_MISSING);
    ok('9.10 ההודעה אינה מכילה PII', !PII.test(e.message));
    ok('9.11 ההודעה נוקבת בתחנה שבה הבעיה', e.message.indexOf('ראשית') !== -1, e.message);
  }
} catch (e) {
  ok('9.x פרטיות', false, e.message);
}

/* ================================================================
 * 10 · הצמדה למקור המנוע
 *
 * המודול הזה מייצר קלט למנוע. אם המנוע ישנה את דרישותיו
 * והמודול לא — נקבל מסמך שנראה תקין ונדחה בזמן ריצה.
 * הבדיקות האלה נועלות את החוזה בטקסט המקור, כדי שהסטייה
 * תיפול כאן ולא בייצור.
 * ================================================================ */

const engineNeeds = [
  ["10.1 המנוע דורש station_id", "policy-station"],
  ["10.2 המנוע דורש version", "policy-version"],
  ["10.3 המנוע דורש digest", "policy-digest"],
  ["10.4 המנוע דורש תחנת קצה אחת לפחות", "policy-sub-stations"],
  ["10.5 המנוע דורש קו מינימום", "sub-station-minimum"],
  ["10.6 המנוע דורש דרישות תקן", "sub-station-requirements"],
  ["10.7 המנוע דורש סימון חובה/רשות", "requirement-required"],
  ["10.8 המנוע דורש rest.min_gap_days", "policy-rest"],
  ["10.9 המנוע דורש הצהרת rotation", "policy-rotation-missing"],
  ["10.10 המנוע דורש הצהרת max_shifts_per_month", "policy-limit-missing"]
];
for (const [name, needle] of engineNeeds) {
  ok(name, ENGINE_SRC.indexOf(needle) !== -1, 'הקוד של המנוע כבר אינו מכיל ' + needle);
}
ok('10.11 המנוע קורא rest.min_gap_days ולא שדה שטוח',
  ENGINE_SRC.indexOf('raw.rest.min_gap_days') !== -1);
ok('10.12 המנוע קורא sub_stations',
  ENGINE_SRC.indexOf('raw.sub_stations') !== -1);
ok('10.13 המודול אינו טוען Firebase',
  !/require\(['"]firebase|firebase-admin/.test(AUTHOR_SRC));
ok('10.14 המודול אינו קורא ל-Date.now',
  AUTHOR_SRC.indexOf('Date.now()') === -1);
ok('10.15 המודול אינו טוען את המנוע',
  AUTHOR_SRC.indexOf("require(") === -1);

/* ================================================================
 * 11 · מוטציות · הבדיקות חייבות ליפול על קוד שבור
 * ================================================================ */

function mutate(from, to) {
  if (AUTHOR_SRC.indexOf(from) === -1) return { error: 'הטקסט לא נמצא: ' + from };
  const src = AUTHOR_SRC.split(from).join(to);
  const mod = { exports: {} };
  try {
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', src)(mod, mod.exports, require_);
  } catch (e) { return { error: 'הקוד המוטנטי לא נטען: ' + e.message }; }
  return { api: mod.exports.createPolicyAuthor({ clock, hash }) };
}

function survives(name, from, to, check) {
  const m = mutate(from, to);
  if (m.error) { ok(name, false, m.error); return; }
  let caught = false;
  try { caught = check(m.api) === false; } catch (_) { caught = true; }
  ok(name, caught, 'המוטציה שרדה — הבדיקה אינה בודקת דבר');
}

const P = (api, over, extra) => api.planPolicy(Object.assign(
  { station_id: 'station-102', draft: draft(over), actor_uid: 'uid-abc' }, extra || {}));
const PR = (api, d, extra) => api.planPolicy(Object.assign(
  { station_id: 'station-102', draft: d, actor_uid: 'uid-abc' }, extra || {}));

// 11.1 — קו מינימום חסר מקבל 0 בשקט. זו בדיוק התקלה שהמודול קיים כדי למנוע.
survives('11.1 מינימום שנשתל כ-0',
  "if (value === undefined || value === null) {\n    fail(code, what + ' — ערך חסר. אין ברירת מחדל.');\n  }",
  "if (value === undefined || value === null) return 0;",
  (api) => { PR(api, without('sub_stations.rashit.minimum')); return false; });

// 11.2 — מחרוזת מומרת בשקט למספר.
survives('11.2 המרה שקטה של מחרוזת',
  'if (!isInt(value)) {',
  'if (false) {',
  (api) => { const d = draft(); d.sub_stations.rashit.minimum = '6';
    PR(api, d); return false; });

// 11.3 — required חסר נחשב לרשות.
survives('11.3 „לא סימנו" הופך לרשות',
  "if (typeof row.required !== 'boolean') {",
  'if (false) {',
  (api) => { const d = draft();
    delete d.sub_stations.timna.requirements[0].required; PR(api, d); return false; });

// 11.4 — הצהרת rotation מפסיקה להיות חובה.
survives('11.4 rotation מותרת בהשמטה',
  "if (!Object.prototype.hasOwnProperty.call(draft, 'rotation')) {",
  'if (false) {',
  (api) => { PR(api, without('rotation')); return false; });

// 11.5 — הצהרת תקרה מפסיקה להיות חובה.
survives('11.5 תקרה מותרת בהשמטה',
  "if (!Object.prototype.hasOwnProperty.call(draft, 'max_shifts_per_month')) {",
  'if (false) {',
  (api) => { PR(api, without('max_shifts_per_month')); return false; });

// 11.6 — מיון הדרישות נעלם, והחתימה מפסיקה להיות יציבה.
survives('11.6 חתימה לא יציבה בלי מיון',
  'requirements.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));',
  '',
  (api) => {
    const a = P(api);
    const rev = draft(); rev.sub_stations.rashit.requirements.reverse();
    return P(api, rev).digest === a.digest;
  });

// 11.7 — החתימה מחושבת ב-JSON.stringify במקום ב-stable. על
// הדוגמה הזאת התוצאה נראית סבירה — והרנטיים ידחה אותה.
survives('11.7 חתימה שאינה קנונית',
  'const digest = String(hash(stable(basis)));',
  'const digest = String(hash(JSON.stringify(basis)));',
  (api) => {
    const r = P(api);
    const rt = extractFn(runtimeSrc || '', 'function stable(value) {');
    const pl = extractFn(runtimeSrc || '', 'function plain(value) {');
    if (!rt || !pl) return false;
    // eslint-disable-next-line no-new-func
    const st = new Function(pl + '\n' + rt + '\nreturn stable;')();
    const doc = r.document;
    return doc.content_digest === hash(st({
      station_id: doc.station_id, version: doc.version, sub_stations: doc.sub_stations,
      rest: doc.rest, rotation: doc.rotation, max_shifts_per_month: doc.max_shifts_per_month
    }));
  });

// 11.8 — ירידת קו מינימום מפסיקה להיחשב החלשה.
survives('11.8 ירידת קו אינה מסומנת',
  'weakens: b.minimum < a.minimum });',
  'weakens: false });',
  (api) => {
    const first = P(api);
    const prev = Object.assign({ id: first.policy_id }, first.document);
    const low = draft(); low.sub_stations.rashit.minimum = 4;
    const r = api.planPolicy({ station_id: 'station-102', draft: low,
      actor_uid: 'u', previous: prev });
    return r.weakening.length === 1;
  });

// 11.9 — חובה→רשות מפסיק להיחשב החלשה.
survives('11.9 חובה→רשות אינה מסומנת',
  'weakens: p.required && !r.required });',
  'weakens: false });',
  (api) => {
    const first = P(api);
    const prev = Object.assign({ id: first.policy_id }, first.document);
    const d = draft(); d.sub_stations.rashit.requirements[0].required = false;
    const r = api.planPolicy({ station_id: 'station-102', draft: d,
      actor_uid: 'u', previous: prev });
    return r.weakening.length === 1;
  });

// 11.10 — „לא השתנה" מפסיק להיות מזוהה, וכל שמירה מייצרת גרסה.
survives('11.10 unchanged אינו מזוהה',
  "if (prev && isNonEmptyString(prev.content_key) && prev.content_key === contentKey) {",
  'if (false) {',
  (api) => {
    const first = P(api);
    const prev = Object.assign({ id: first.policy_id }, first.document);
    return P(api, undefined, { previous: prev }).kind === 'unchanged';
  });

// 11.11 — הגרסה נלקחת מהקלט במקום להיגזר. שתי לשוניות → אותה גרסה.
survives('11.11 גרסה אינה עולה',
  "const version = 'v' + (Number.isInteger(prevNum) ? prevNum + 1 : 1);",
  "const version = 'v1';",
  (api) => {
    const first = P(api);
    const prev = Object.assign({ id: first.policy_id }, first.document);
    return P(api, { rest: { min_gap_days: 3 } }, { previous: prev }).version === 'v2';
  });

// 11.12 — אזהרת „קו נמוך מהתקן" נעלמת.
survives('11.12 אזהרת קו נמוך נעלמת',
  '} else if (s.minimum < requiredTotal) {',
  '} else if (false) {',
  (api) => {
    const d = draft(); d.sub_stations.rashit.minimum = 2;
    const r = api.planPolicy({ station_id: 'station-102', draft: d, actor_uid: 'u' });
    return r.warnings.some((w) => w.code === WARN.MINIMUM_BELOW_REQUIRED);
  });

// 11.13 — תחנת קצה בלי דרישות מתקבלת. המנוע יקרוס עליה.
survives('11.13 תחנת קצה ריקה מתקבלת',
  'if (!Array.isArray(rows) || rows.length === 0) {',
  'if (!Array.isArray(rows)) {',
  (api) => {
    const d = draft(); d.sub_stations.timna.requirements = [];
    PR(api, d); return false;
  });

/* ================================================================
 * 12 · החתימה שהרנטיים יחשב מחדש
 *
 * זו הבדיקה החשובה ביותר בקובץ, ולא בגלל שהיא מסובכת.
 *
 * `schedule-runtime.js:876` (`loadPolicy`) בונה בסיס משישה שדות
 * ומחשב עליו `digest(basis)`. אם המודול כאן חותם על משהו אחר —
 * ולו בסדר מפתחות — הכתיבה תצליח, המסמך ייראה תקין במסך,
 * והמנוע ייפול ב-`policy-digest-mismatch` בפעם הראשונה שמישהו
 * ינסה להריץ אותו. תקלה שמתגלה אצל מישהו אחר, מאוחר.
 *
 * לכן אני לא משווה למה שכתבתי — אני **מריץ את הפונקציה של
 * הרנטיים עצמה**, כפי שהיא בקובץ המקור ברגע זה.
 * ================================================================ */

if (!runtimeSrc) {
  ok('12.0 schedule-runtime.js נקרא', false, 'לא נמצא');
} else {
  const stableText = extractFn(runtimeSrc, 'function stable(value) {');
  const plainText = extractFn(runtimeSrc, 'function plain(value) {');
  ok('12.1 stable() של הרנטיים אותר', !!stableText);
  ok('12.2 plain() של הרנטיים אותר', !!plainText);

  if (stableText && plainText) {
    let runtimeStable = null;
    try {
      // eslint-disable-next-line no-new-func
      runtimeStable = new Function(plainText + '\n' + stableText + '\nreturn stable;')();
    } catch (e) { ok('12.3 stable() של הרנטיים נטען', false, e.message); }

    if (runtimeStable) {
      ok('12.3 stable() של הרנטיים נטען', true);
      const doc = good.document;

      // ⭐ הבסיס — מועתק מ-`loadPolicy`, שדה בשדה.
      const basis = {
        station_id: doc.station_id,
        version: doc.version,
        sub_stations: doc.sub_stations,
        rest: doc.rest,
        rotation: Object.prototype.hasOwnProperty.call(doc, 'rotation') ? doc.rotation : undefined,
        max_shifts_per_month: Object.prototype.hasOwnProperty.call(doc, 'max_shifts_per_month')
          ? doc.max_shifts_per_month : undefined
      };
      const expected = hash(runtimeStable(basis));
      eq('12.4 content_digest תואם לחישוב של הרנטיים', doc.content_digest, expected);
      eq('12.5 digest זהה ל-content_digest', doc.digest, expected);

      // המראה במודול חייבת להיות זהה בטקסט, לא רק בתוצאה על
      // הדוגמה הזאת. תוצאה זהה על קלט אחד אינה זהות.
      const mirrorText = extractFn(AUTHOR_SRC, 'function stable(value) {');
      ok('12.6 המראה קיימת במודול', !!mirrorText);
      ok('12.7 המראה זהה בטקסט לרנטיים',
        !!mirrorText && mirrorText.split('isPlainObject').join('plain') === stableText,
        'המראה סטתה מהמקור');

      // וגם: אותה תוצאה על מבנה עם מפתחות בסדר הפוך ועם null.
      const tricky = { z: 1, a: [3, { b: null }], m: { y: 2, x: 'ת' } };
      eq('12.8 המראה מסכימה גם על מבנה מסובך',
        hash(runtimeStable(tricky)), hash(runtimeStable(JSON.parse(JSON.stringify(tricky)))));

      // ⭐ הבדיקה שסוגרת את הלולאה: `loadPolicy` דורש complete
      // ו-station_id תואם. אם אחד מהם ישתנה בקוד — ניפול כאן.
      ok('12.9 loadPolicy דורש complete',
        runtimeSrc.indexOf('raw.complete !== true') !== -1);
      ok('12.10 loadPolicy מחשב מחדש digest(basis)',
        runtimeSrc.indexOf("raw.content_digest !== actual") !== -1);
      ok('12.11 loadPolicy דורש התאמת תחנה',
        runtimeSrc.indexOf('raw.station_id !== ctx.sid') !== -1);
      ok('12.12 הבסיס ברנטיים עדיין מונה שישה שדות',
        /const basis = \{\s*station_id: raw\.station_id,\s*version: raw\.version,\s*sub_stations: raw\.sub_stations,\s*rest: raw\.rest,/.test(runtimeSrc),
        'צורת הבסיס ב-loadPolicy השתנתה — יש לעדכן את המודול');
    }
  }
}

// מוטציה: המראה סוטה. חייב ליפול.
survives('12.13 מראה סוטה נתפסת',
  ".map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';",
  ".map((key) => JSON.stringify(key) + '=' + stable(value[key])).join(',') + '}';",
  (api) => {
    const r = P(api);
    const rt = extractFn(runtimeSrc || '', 'function stable(value) {');
    const pl = extractFn(runtimeSrc || '', 'function plain(value) {');
    if (!rt || !pl) return false;
    // eslint-disable-next-line no-new-func
    const st = new Function(pl + '\n' + rt + '\nreturn stable;')();
    const doc = r.document;
    return doc.content_digest === hash(st({
      station_id: doc.station_id, version: doc.version, sub_stations: doc.sub_stations,
      rest: doc.rest, rotation: doc.rotation, max_shifts_per_month: doc.max_shifts_per_month
    }));
  });

/* ================================================================
 * סיכום
 * ================================================================ */

if (fails.length) {
  console.error('schedule-policy-author-probe · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('schedule-policy-author-probe · ' + pass + '/' + pass + ' עברו');
