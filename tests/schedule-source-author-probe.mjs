/* ====================================================================
 *  schedule-source-author-probe
 *
 *  יבוא רשימת כוח האדם — מי נכנס למקור, מי לא, ומי יודע על מי
 *  שלא נכנס.
 *
 *  ----------------------------------------------------------------
 *  שלושה דברים שהבדיקה הזאת שומרת עליהם
 *  ----------------------------------------------------------------
 *
 *  **1. זהות היא מספר עובד, לא שם.** התאמה לפי שם היא ניחוש, ושני
 *  „כהן" בתחנה אינם מקרה קצה. יש כאן מוטציה שמכניסה התאמת שם,
 *  והיא חייבת להיתפס.
 *
 *  **2. הדוח מדבר בשורות ולא בערכים.** הוא נכתב ליומן, נשלח למסך
 *  ומודבק בהודעות. „שורה 47 — חסר מספר עובד" עושה את העבודה בלי
 *  אף שם ובלי אף מספר עובד. יש כאן סריקה שמוודאת ששום ערך מהקלט
 *  לא דלף לדוח או ליומן.
 *
 *  **3. מי שנפל מהרשימה נספר.** ⭐ שורה שנדחתה היא אדם שהמנוע לא
 *  ישבץ ואיש לא ישים לב. לכן יבוא עם דחיות אינו מייצר מסמך אלא
 *  אחרי אישור של המספר **המדויק**.
 *
 *  ובנוסף, הבדיקה המרכזית: **המסמך שנוצר נטען בפועל** — החתימה
 *  מחושבת מחדש עם `stable()` של הרנטיים עצמו, מהבסיס ש-`loadSource`
 *  בונה, שדה בשדה.
 *
 *  ⭐ כל השמות כאן מומצאים לחלוטין. אין בקובץ הזה שם, מספר עובד או
 *  דוא"ל של אדם אמיתי, ואסור שיהיה.
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
  try { fn(); } catch (e) { ok(name, e && e.code === code, 'קוד ' + (e && e.code) + ' במקום ' + code); return; }
  ok(name, false, 'לא נזרקה שגיאה כלל');
}
function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

let mod, AUTHOR_SRC, RUNTIME_SRC;
try {
  AUTHOR_SRC = readSource(resolve(FN, 'schedule-source-author.js'));
  RUNTIME_SRC = readSource(resolve(FN, 'schedule-runtime.js'));
  mod = require_(resolve(FN, 'schedule-source-author.js'));
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון את המודול: ' + e.message);
  process.exit(2);
}

const hash = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const A = mod.createSourceAuthor({
  clock: () => new Date(Date.UTC(2026, 8, 2, 6, 0, 0)).toISOString(), hash
});
const CODE = mod.CODE, ROW = mod.ROW;

/* --- שמות מומצאים לחלוטין, ומסומנים ככאלה --- */
const POLICY = {
  station_id: 'station-102',
  sub_stations: {
    rashit: { label: 'ראשית', minimum: 4, requirements: [
      { role: 'officer', count: 1, required: true },
      { role: 'driver', count: 2, required: true },
      { role: 'ff', count: 2, required: false }] },
    timna: { label: 'תמנע', minimum: 2, requirements: [
      { role: 'driver', count: 1, required: true },
      { role: 'ff', count: 1, required: true }] }
  }
};
/* ⭐ P1-4. הספרייה נושאת את השם מהפרופיל החי. השם שבגיליון אינו
 * נשמר — עמודה בגיליון לא תקבע איך אדם נראה על הלוח של כל התחנה. */
const KNOWN = [
  { uid: 'uid-aaa', employee_number: '1001', full_name: 'פרופיל אלף' },
  { uid: 'uid-bbb', employee_number: '1002', full_name: 'פרופיל בית' },
  { uid: 'uid-ccc', employee_number: '1003', full_name: 'פרופיל גימל' },
  { uid: 'uid-ddd', employee_number: '1004', full_name: 'פרופיל דלת' }
];
function rows() {
  return [
    { row: 2, employee_number: '1001', full_name: 'בדיקה אלף', sub_station: 'rashit', active: true, roles: ['officer', 'driver'] },
    { row: 3, employee_number: '1002', full_name: 'בדיקה בית', sub_station: 'rashit', active: true, roles: ['driver'] },
    { row: 4, employee_number: '1003', full_name: 'בדיקה גימל', sub_station: 'timna', active: true, roles: ['driver', 'ff'] },
    { row: 5, employee_number: '1004', full_name: 'בדיקה דלת', sub_station: 'timna', active: false, roles: ['ff'] }
  ];
}
const plan = (over) => A.planSource(Object.assign({
  station_id: 'station-102', rows: rows(), known: KNOWN, policy: POLICY,
  previous: null, actor_uid: 'uid-mgr'
}, over || {}));

/* ==================================================================
 * 1 · יבוא נקי
 * ================================================================== */

let good;
try {
  good = plan();
  eq('1.1 נוצר', good.kind, 'created');
  eq('1.2 כל השורות נכנסו', good.counts.people, 4);
  eq('1.3 אין דחיות', good.report.rejected, 0);
  eq('1.4 מהדורה ראשונה', good.revision, '1');
  eq('1.5 המסמך שלם', good.meta.complete, true);
  eq('1.6 ספירות תואמות', [good.meta.person_count, good.meta.availability_count,
    good.meta.locked_count, good.meta.event_count], [4, 0, 0, 0]);
  eq('1.7 מזהי מסמכים הם uid', good.people.map((p) => p.id).sort(),
    ['uid-aaa', 'uid-bbb', 'uid-ccc', 'uid-ddd']);
  // ⭐ `loadSource` בונה Object.assign({id: doc.id}, doc.data()) —
  // שדה `id` סותר בגוף המסמך היה גובר בשקט על מזהה המסמך.
  ok('1.8 שדה id בגוף המסמך זהה למזהה',
    good.people.every((p) => p.data.id === p.id));
  eq('1.9 לא פעיל נשמר כלא פעיל',
    good.people.find((p) => p.id === 'uid-ddd').data.active, false);
  eq('1.10 התפקידים ממוינים',
    good.people.find((p) => p.id === 'uid-aaa').data.roles, ['driver', 'officer']);
} catch (e) {
  ok('1.x יבוא נקי', false, (e && e.code) + ' · ' + (e && e.message));
}

/* ==================================================================
 * 2 · ⭐ החתימה שהרנטיים יחשב מחדש
 *
 * לא השוואה למה שכתבתי — הרצה של `stable()` של הרנטיים עצמו, על
 * הבסיס ש-`loadSource` בונה, שדה בשדה.
 * ================================================================== */

function extractFn(src, signature) {
  const at = src.indexOf(signature);
  if (at === -1) return null;
  const end = src.indexOf('\n}\n', at);
  return end === -1 ? null : src.slice(at, end + 2);
}

/* ⭐ הבסיס נבנה מהתוצר של התוכנית עצמה, ולא מליטרלים ריקים.
 * הגרסה הקודמת של הבדיקה הזאת כתבה כאן `availability: {}` —
 * ולכן היא הסכימה עם הבאג של P0-1 במקום לחשוף אותו. מוטציה
 * שהחזירה את `basis` לריק שרדה אותה בשקט. */
function basisOf(plan) {
  const byId = (list) => {
    const out = {};
    list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .forEach((doc) => { out[doc.id] = doc.data.days || {}; });
    return out;
  };
  return {
    station_id: plan.meta.station_id,
    version: plan.meta.version,
    revision: plan.meta.revision,
    carry: plan.meta.carry,
    counts: {
      people: plan.meta.person_count,
      availability: plan.meta.availability_count,
      locked: plan.meta.locked_count,
      events: plan.meta.event_count
    },
    people: plan.people.slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((doc) => Object.assign({ id: doc.id }, doc.data)),
    availability: byId(plan.availability),
    locked: byId(plan.locked),
    events: plan.events.slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((doc) => Object.assign({ id: doc.id }, doc.data))
  };
}


const stableText = extractFn(RUNTIME_SRC, 'function stable(value) {');
const plainText = extractFn(RUNTIME_SRC, 'function plain(value) {');
ok('2.1 stable() של הרנטיים אותר', !!stableText);
let runtimeStable = null;
if (stableText && plainText) {
  try {
    // eslint-disable-next-line no-new-func
    runtimeStable = new Function(plainText + '\n' + stableText + '\nreturn stable;')();
  } catch (e) { ok('2.2 נטען', false, e.message); }
}
if (runtimeStable && good) {
  ok('2.2 נטען', true);
  // הבסיס — מועתק מ-`loadSource`, שדה בשדה.
  const peopleRaw = good.people.slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((doc) => Object.assign({ id: doc.id }, doc.data));
  eq('2.3 content_digest תואם לחישוב של הרנטיים',
    good.meta.content_digest, hash(runtimeStable(basisOf(good))));

  // המראה זהה בטקסט, ולא רק בתוצאה על הדוגמה הזאת.
  const mirror = extractFn(AUTHOR_SRC, 'function stable(value) {');
  ok('2.4 המראה קיימת', !!mirror);
  ok('2.5 המראה זהה בטקסט לרנטיים',
    !!mirror && mirror.split('isPlainObject').join('plain') === stableText);

  // והחוזה עצמו — אם `loadSource` ישנה צורה, ניפול כאן.
  ok('2.6 loadSource דורש complete', RUNTIME_SRC.indexOf('meta.complete !== true') !== -1);
  ok('2.7 loadSource מחשב מחדש digest(basis)',
    RUNTIME_SRC.indexOf('meta.content_digest !== actual') !== -1);
  ok('2.8 loadSource דורש התאמת ספירות',
    RUNTIME_SRC.indexOf("'source-count-mismatch'") !== -1);
  ok('2.9 הבסיס ברנטיים עדיין באותה צורה',
    /const basis = \{\s*station_id: meta\.station_id,\s*version: meta\.version,\s*revision: meta\.revision,\s*carry:/.test(RUNTIME_SRC),
    'צורת הבסיס ב-loadSource השתנתה — יש לעדכן את המודול');
}

/* ==================================================================
 * 3 · ⭐ זהות היא מספר עובד, לא שם
 * ================================================================== */

const noNumber = rows();
delete noNumber[1].employee_number;
let r3 = caught(() => plan({ rows: noNumber }));
eq('3.1 שורה בלי מספר עובד נדחית', r3.code, CODE.REJECTED);
eq('3.2 והקוד מדויק', r3.detail.report.rows[0].code, ROW.NO_IDENTITY);
eq('3.3 והשורה מזוהה במספרה', r3.detail.report.rows[0].row, 3);

// ⭐ השם תואם בדיוק לאדם קיים — ועדיין לא מתבצעת התאמה.
const nameOnly = rows();
delete nameOnly[1].employee_number;
nameOnly[1].full_name = 'בדיקה אלף';
r3 = caught(() => plan({ rows: nameOnly }));
eq('3.4 שם זהה לאדם קיים אינו מזהה אותו',
  r3.detail.report.rows[0].code, ROW.NO_IDENTITY);

const notNumber = rows();
notNumber[0].employee_number = 'א1001';
eq('3.5 מספר עובד שאינו מספר',
  caught(() => plan({ rows: notNumber })).detail.report.rows[0].code, ROW.IDENTITY_INVALID);

const unknown = rows();
unknown[0].employee_number = '9999';
eq('3.6 מספר עובד שאינו בתחנה',
  caught(() => plan({ rows: unknown })).detail.report.rows[0].code, ROW.UNKNOWN_PERSON);

const twice = rows();
twice[1].employee_number = '1001';
eq('3.7 אותו מספר עובד בשתי שורות',
  caught(() => plan({ rows: twice })).detail.report.rows[0].code, ROW.DUPLICATE);

// שני חשבונות על אותו מספר עובד — תקלת זהות, והמודול אינו בוחר.
const ambiguous = caught(() => plan({
  known: KNOWN.concat([{ uid: 'uid-eee', employee_number: '1001' }])
}));
eq('3.8 מספר עובד על שני חשבונות',
  ambiguous.detail.report.rows[0].code, ROW.AMBIGUOUS);
eq('3.9 וכמה חשבונות', ambiguous.detail.report.rows[0].matches, 2);

/* ==================================================================
 * 4 · שדות עסקיים · בלי ברירות מחדל
 * ================================================================== */

function rejectCode(mutate) {
  const list = rows();
  mutate(list);
  const error = caught(() => plan({ rows: list }));
  return error && error.detail && error.detail.report.rows[0]
    ? error.detail.report.rows[0].code : (error && error.code);
}

// ⭐ „לא כתוב" אינו „לא פעיל". אדם שנשמט מהעמודה הזאת היה נעלם
// מהסידור בשקט.
eq('4.1 בלי סימון פעיל', rejectCode((l) => { delete l[0].active; }), ROW.NO_ACTIVE);
eq('4.2 פעיל כמחרוזת', rejectCode((l) => { l[0].active = 'כן'; }), ROW.NO_ACTIVE);
eq('4.3 בלי תחנת קצה', rejectCode((l) => { delete l[0].sub_station; }), ROW.NO_SUB_STATION);
eq('4.4 תחנת קצה שאינה בחוקים',
  rejectCode((l) => { l[0].sub_station = 'yotvata'; }), ROW.SUB_STATION_UNKNOWN);
eq('4.5 בלי תפקידים', rejectCode((l) => { l[0].roles = []; }), ROW.NO_ROLES);
eq('4.6 תפקיד שאינו בחוקים',
  rejectCode((l) => { l[0].roles = ['paramedic']; }), ROW.ROLE_UNKNOWN);
eq('4.7 תפקיד כפול',
  rejectCode((l) => { l[0].roles = ['driver', 'driver']; }), ROW.ROLE_DUPLICATE);
eq('4.8 בלי שם', rejectCode((l) => { delete l[0].full_name; }), ROW.NAME_MISSING);
eq('4.9 שם עם תווי בקרה',
  rejectCode((l) => { l[0].full_name = 'בדיקה\u0007אלף'; }), ROW.NAME_INVALID);

throwsCode('4.10 בלי חוקי תחנה', () => plan({ policy: null }), CODE.NO_POLICY);
throwsCode('4.11 חוקי תחנה של תחנה אחרת',
  () => plan({ policy: Object.assign({}, POLICY, { station_id: 'station-999' }) }), CODE.STATION);
throwsCode('4.12 בלי שורות', () => plan({ rows: [] }), CODE.NO_ROWS);

/* ==================================================================
 * 5 · ⭐ מי שנפל מהרשימה נספר
 * ================================================================== */

const partial = rows();
delete partial[3].employee_number;
partial[2].active = 'כן';

const blocked = caught(() => plan({ rows: partial }));
eq('5.1 יבוא עם דחיות אינו מייצר מסמך', blocked.code, CODE.REJECTED);
eq('5.2 והדוח סופר', blocked.detail.report.rejected, 2);
eq('5.3 ומפרט לפי קוד', Object.keys(blocked.detail.report.by_code).sort(),
  [ROW.NO_ACTIVE, ROW.NO_IDENTITY].sort());

// אישור „בערך" אינו אישור.
const wrong = caught(() => plan({ rows: partial, accept_rejected: 1 }));
eq('5.4 אישור במספר שגוי נדחה', wrong.code, CODE.ACCEPT_MISMATCH);
const zero = caught(() => plan({ rows: partial, accept_rejected: 0 }));
eq('5.5 אישור 0 כשיש 2 נדחה', zero.code, CODE.ACCEPT_MISMATCH);

const accepted = plan({ rows: partial, accept_rejected: 2 });
eq('5.6 עם המספר המדויק — נכתב', accepted.counts.people, 2);
eq('5.7 והדחיות נשמרות בדוח', accepted.report.rejected, 2);
eq('5.8 והמסמך סופר אותן', accepted.meta.import_rejected_rows, 2);
eq('5.9 וגם את הסך הכול', accepted.meta.import_total_rows, 4);

const allBad = rows().map((row) => { const copy = Object.assign({}, row); delete copy.employee_number; return copy; });
eq('5.10 אף שורה לא עברה — לא מסמך ריק',
  caught(() => plan({ rows: allBad, accept_rejected: 4 })).code, CODE.EMPTY_RESULT);

/* ==================================================================
 * 6 · ⭐ הדוח והיומן מדברים בשורות, לא בערכים
 * ================================================================== */

const SECRETS = ['בדיקה אלף', 'בדיקה בית', 'בדיקה גימל', 'בדיקה דלת',
  '1001', '1002', '1003', '1004', 'uid-aaa', 'uid-bbb'];

const dirty = rows();
delete dirty[0].employee_number;
dirty[0].email = 'someone@example.com';
dirty[0].phone = '050-1234567';
const dirtyError = caught(() => plan({ rows: dirty }));

const reportText = JSON.stringify(dirtyError.detail.report);
ok('6.1 אין שם בדוח', SECRETS.slice(0, 4).every((v) => reportText.indexOf(v) === -1));
ok('6.2 אין מספר עובד בדוח', reportText.indexOf('1002') === -1);
ok('6.3 אין דוא"ל בדוח', reportText.indexOf('someone@example.com') === -1);
ok('6.4 אין טלפון בדוח', reportText.indexOf('050-1234567') === -1);
ok('6.5 אבל יש מספר שורה', reportText.indexOf('"row":2') !== -1, reportText.slice(0, 200));
ok('6.6 ויש הסבר בעברית',
  dirtyError.detail.report.rows[0].text.indexOf('מספר עובד') !== -1);

const auditText = JSON.stringify(plan().audit);
ok('6.7 אין שם ביומן', SECRETS.slice(0, 4).every((v) => auditText.indexOf(v) === -1));
ok('6.8 אין מספר עובד ביומן',
  ['1001', '1002', '1003', '1004'].every((v) => auditText.indexOf(v) === -1));
// ⭐ גם מספר שורה אינו ביומן: שורה מזהה אדם בגיליון.
ok('6.9 אין מספרי שורה ביומן', auditText.indexOf('"row"') === -1);
eq('6.10 היומן מחזיק ספירות וקודים בלבד', Object.keys(plan().audit).sort(),
  ['accepted_rows', 'actor', 'at', 'carry_dropped_availability',
    'carry_dropped_locked', 'content_digest', 'missing_staff',
    'rejected_by_code', 'rejected_rows', 'station_id', 'total_rows']);
eq('6.11 והשומר נשמר כ-uid בלבד', plan().audit.actor, 'uid-mgr');

// שדות זרים שנתחבו לשורה אינם שורדים את הנרמול.
const leaked = JSON.stringify(plan({ rows: (() => {
  const list = rows();
  list[0].email = 'someone@example.com';
  list[0].id_number = '123456789';
  list[0].notes = 'לתאם עם המפקד';
  return list;
})() }).people);
ok('6.12 דוא"ל שנתחב לשורה נשמט', leaked.indexOf('someone@example.com') === -1);
ok('6.13 ת"ז שנתחבה נשמטת', leaked.indexOf('123456789') === -1);
ok('6.14 הערה חופשית נשמטת', leaked.indexOf('לתאם עם המפקד') === -1);
/* ⭐ P1-4. `employee_number` אינו כאן יותר. המנוע ושכבת השירות אינם
 * קוראים אותו כלל, ולכן שמירתו בתמונת המקור הייתה החזקת מידע מזהה
 * בלי שימוש. הרשימה סגורה, ולכן החזרתו תפיל את הבדיקה. */
eq('6.15 מפתחות מסמך אדם סגורים',
  Object.keys(plan().people[0].data).sort(),
  ['active', 'full_name', 'group', 'id', 'roles', 'station_id', 'sub_station']);
ok('6.16 מספר עובד אינו נשמר בתמונת המקור',
  JSON.stringify(plan().people).indexOf('1001') === -1);
eq('6.17 השם נלקח מהפרופיל החי ולא מהגיליון',
  plan().people[0].data.full_name, 'פרופיל אלף');

/* ==================================================================
 * 7 · מהדורות ו„לא השתנה"
 * ================================================================== */

// ⭐ `readActiveSource` מצרף תמיד את `carried`. מקור פעיל בלי השדה
// הזה הוא בדיוק המצב שבו התוכן נמחק בשקט, ולכן הוא נחסם — ונבדק
// בסעיף 13.
function carriedOf(meta, extra) {
  return Object.assign({}, meta, {
    carried: Object.assign({
      carry: {}, availability: {}, locked: {}, events: []
    }, extra || {})
  });
}

try {
  const first = plan();
  const prev = carriedOf(Object.assign({ id: first.source_id }, first.meta));
  const same = plan({ previous: prev });
  eq('7.1 יבוא זהה מדווח כ-unchanged', same.kind, 'unchanged');
  eq('7.2 ואינו מייצר מסמך', same.meta, null);
  eq('7.3 והמהדורה נשמרת', same.revision, '1');

  const changed = rows();
  changed[0].sub_station = 'timna';
  const next = plan({ rows: changed, previous: prev });
  eq('7.4 שינוי מעלה מהדורה', next.revision, '2');
  eq('7.5 סוג', next.kind, 'updated');
  eq('7.6 supersedes מצביע לקודם', next.meta.supersedes, first.source_id);

  // סדר השורות בגיליון אינו משנה את החתימה.
  const shuffled = rows().reverse();
  eq('7.7 סדר השורות אינו משנה חתימה', plan({ rows: shuffled }).digest, first.digest);
  // ומי שמייבא אינו נכנס לחתימה.
  eq('7.8 המייבא אינו נכנס לחתימה',
    plan({ actor_uid: 'uid-other' }).digest, first.digest);
} catch (e) {
  ok('7.x מהדורות', false, (e && e.code) + ' · ' + e.message);
}

/* ==================================================================
 * 8 · מקור המיפוי · בשרת בלבד
 * ================================================================== */

const start = RUNTIME_SRC.indexOf('async function saveSource(req)');
const end = RUNTIME_SRC.indexOf('async function runPlanner(req)', start);
const wired = RUNTIME_SRC.slice(start, start === -1 ? 0 : RUNTIME_SRC.indexOf('\n  }\n', start) + 4);
ok('8.1 נתיב הכתיבה אותר', start > -1);
ok('8.2 המיפוי נקרא בשרת', RUNTIME_SRC.indexOf('async function stationDirectory(ctx)') !== -1);
// ⭐ מי שיכול לספק מיפוי משלו יכול לשבץ אדם אחר במקומו.
ok('8.3 המיפוי אינו מתקבל מהלקוח',
  !/known:\s*(plain\()?data\.|data\.known/.test(RUNTIME_SRC));
ok('8.4 המיפוי מגיע מרשימת המשתמשים החיה',
  RUNTIME_SRC.indexOf("stationRef(ctx.sid).collection('users')") !== -1);
ok('8.5 ורק חברים פעילים', RUNTIME_SRC.indexOf('scheduleAccess.activeMember(user, ctx.sid)') !== -1);
ok('8.6 הכתיבה מדורגת עם commitWrites', wired.indexOf('commitWrites(') !== -1);
// ⭐ המסמך נכתב לא-שלם, ורק טרנזקציה סוגרת אותו.
ok('8.7 המסמך נכתב תחילה כלא שלם', wired.indexOf('complete: false') !== -1);
ok('8.8 והדגל נכתב בטרנזקציה', wired.indexOf('complete: true') !== -1
  && wired.indexOf('db.runTransaction') !== -1
  && wired.indexOf('complete: false') < wired.indexOf('db.runTransaction'));
ok('8.9 והמינוי החי נבדק שוב בסגירה', wired.indexOf('requireLiveManager(') !== -1);
ok('8.10 התחנה אינה מתקבלת מהלקוח', !/data\.(station_id|stationId)/.test(wired));
ok('8.11 המודול טהור', !/require\(['"]firebase/.test(AUTHOR_SRC));
ok('8.12 המודול אינו קורא שעון מערכת', AUTHOR_SRC.indexOf('Date.now()') === -1);
ok('8.13 המודול אינו טוען שום מודול אחר', AUTHOR_SRC.indexOf('require(') === -1);
// ⭐ אין במודול שום רמז להתאמה לפי שם.
ok('8.14 אין במודול השוואת שמות',
  !/full_name\s*===|name\s*===\s*\w+\.name|localeCompare/.test(AUTHOR_SRC));

/* ==================================================================
 * 9 · מוטציות
 * ================================================================== */

function survives(name, from, to, check) {
  if (AUTHOR_SRC.indexOf(from) === -1) { ok(name, false, 'הטקסט לא נמצא: ' + from); return; }
  const src = AUTHOR_SRC.split(from).join(to);
  const m = { exports: {} };
  let api;
  try {
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', src)(m, m.exports, require_);
    api = m.exports.createSourceAuthor({
      clock: () => new Date(Date.UTC(2026, 8, 2, 6, 0, 0)).toISOString(), hash
    });
  } catch (e) { ok(name, false, 'הקוד המוטנטי לא נטען: ' + e.message); return; }
  let detected = false;
  try { detected = check(api) === false; } catch (_) { detected = true; }
  ok(name, detected, 'המוטציה שרדה — הבדיקה אינה בודקת דבר');
}

const P = (api, over) => api.planSource(Object.assign({
  station_id: 'station-102', rows: rows(), known: KNOWN, policy: POLICY,
  previous: null, actor_uid: 'uid-mgr'
}, over || {}));

// ⭐ 9.1 — התאמה לפי שם. זו התקלה שכל הקובץ קיים כדי למנוע.
survives('9.1 התאמה לפי שם נכנסת',
  "  const matches = directory.get(employee);",
  // ⭐ השם נוסף למומצא בכוונה: אחרי P1-4 חשבון בלי שם נדחה בקוד אחר,
  // והמוטציה הייתה „נתפסת" מהסיבה הלא נכונה ומפסיקה לבדוק את מה
  // שהיא קיימת בשבילו — שזהות לעולם אינה מנוחשת משם.
  "  let matches = directory.get(employee);\n  if (!matches) matches = [{ uid: 'guessed', full_name: 'שם מומצא' }];",
  (api) => {
    const list = rows(); list[0].employee_number = '9999';
    try { P(api, { rows: list }); return false; } catch (_) { return true; }
  });

/* ⭐ 9.2 — עמודה ריקה נופלת על הבדיקה הבאה ומקבלת „מספר העובד
 * אינו מספר". השורה עדיין נדחית, ולכן „האם נזרקה שגיאה" אינו
 * תופס כלום — אבל האדם שמתקן נשלח למקום הלא נכון: הוא יחפש מספר
 * שגוי במקום להבין שהתא ריק. הבדיקה בודקת את **הקוד**. */
survives('9.2 עמודה ריקה מדווחת כמספר שגוי במקום כחסר',
  "if (!employee) return { rejected: Object.assign({ code: ROW.NO_IDENTITY }, line) };",
  "if (!employee) { /* nothing */ }",
  (api) => {
    const list = rows(); delete list[0].employee_number;
    try { P(api, { rows: list }); return false; }
    catch (e) {
      return !!e.detail && e.detail.report.rows[0].code === 'row-no-employee-number';
    }
  });

survives('9.3 מספר עובד כפול על שני חשבונות נבלע',
  "if (matches.length > 1) {",
  "if (false) {",
  (api) => {
    try {
      P(api, { known: KNOWN.concat([{ uid: 'uid-eee', employee_number: '1001' }]) });
      return false;
    } catch (_) { return true; }
  });

// ⭐ 9.4 — הדחיות מפסיקות לחסום. אנשים נופלים מהרשימה בשקט.
survives('9.4 דחיות מפסיקות לחסום',
  "if (rejected.length) {",
  "if (false) {",
  (api) => {
    const list = rows(); delete list[0].employee_number;
    try { P(api, { rows: list }); return false; } catch (_) { return true; }
  });

survives('9.5 אישור „בערך" מתקבל',
  "if (input.accept_rejected !== rejected.length) {",
  "if (false) {",
  (api) => {
    const list = rows(); delete list[0].employee_number;
    try { P(api, { rows: list, accept_rejected: 99 }); return false; } catch (_) { return true; }
  });

survives('9.6 „לא כתוב" הופך ללא פעיל',
  "if (typeof raw.active !== 'boolean') {",
  "if (false) {",
  (api) => {
    const list = rows(); delete list[0].active;
    try { P(api, { rows: list }); return false; } catch (_) { return true; }
  });

survives('9.7 תפקיד שאינו בחוקים מתקבל',
  "!policy.roles.has(role.trim())",
  "false",
  (api) => {
    const list = rows(); list[0].roles = ['paramedic'];
    try { P(api, { rows: list }); return false; } catch (_) { return true; }
  });

survives('9.8 תחנת קצה שאינה בחוקים מתקבלת',
  "if (!policy.sub_stations[sub]) {",
  "if (false) {",
  (api) => {
    const list = rows(); list[0].sub_station = 'yotvata';
    try { P(api, { rows: list }); return false; } catch (_) { return true; }
  });

// ⭐ 9.9 — שם דולף לדוח.
survives('9.9 שם דולף לדוח',
  "row: item.row, code: item.code, text: ROW_TEXT[item.code] || item.code,",
  "row: item.row, code: item.code, text: ROW_TEXT[item.code] || item.code, name: 'בדיקה אלף',",
  (api) => {
    const list = rows(); delete list[0].employee_number;
    try { P(api, { rows: list }); return false; }
    catch (e) {
      return JSON.stringify(e.detail.report).indexOf('בדיקה אלף') === -1;
    }
  });

// 9.10 — החתימה מחושבת ב-JSON.stringify במקום ב-stable.
survives('9.10 חתימה שאינה קנונית',
  "const digest = String(hash(stable(basis)));",
  "const digest = String(hash(JSON.stringify(basis)));",
  (api) => {
    if (!runtimeStable) return false;
    const r = P(api);
    const peopleRaw = r.people.slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((doc) => Object.assign({ id: doc.id }, doc.data));
    return r.meta.content_digest === hash(runtimeStable({
      station_id: r.meta.station_id, version: r.meta.version, revision: r.meta.revision,
      carry: r.meta.carry,
      counts: { people: r.meta.person_count, availability: r.meta.availability_count,
        locked: r.meta.locked_count, events: r.meta.event_count },
      people: peopleRaw, availability: {}, locked: {}, events: []
    }));
  });

survives('9.11 מקור ריק מתקבל',
  "if (!accepted.length) {",
  "if (false) {",
  (api) => {
    const list = rows().map((row) => { const copy = Object.assign({}, row); delete copy.employee_number; return copy; });
    try { P(api, { rows: list, accept_rejected: 4 }); return false; } catch (_) { return true; }
  });

/* ==================================================================
 * 13 · ⭐ P0-1 · יבוא סגל אינו מוחק את מה שלא ייבאו
 *
 * זה הבאג החמור ביותר שנמצא בחבילה, והוא נמצא בביקורת של Codex ולא
 * באף בדיקה שכתבתי. `planSource` כתב `carry: {}`, `availability: {}`,
 * `locked: {}` ו-`events: []` — ארבעה ליטרלים ריקים — ולכן **כל
 * שמירה של רשימת סגל מחקה את זמינות התחנה, את הנעילות ואת האירועים.**
 *
 * הבדיקות שלי עברו כי הן בדקו מה שנכתב. אף אחת מהן לא שאלה מה נמחק.
 * ================================================================== */

const CARRY = Object.freeze({
  carry: { last_cycle: 'c7', offset: 3 },
  availability: {
    'uid-a': { '2026-09-01': 'yes', '2026-09-02': 'no' },
    'uid-b': { '2026-09-03': 'yes' }
  },
  locked: { 'uid-a': { '2026-09-10': 'course' } },
  events: [
    { id: 'ev_1', title: 'תרגיל', date: '2026-09-05' },
    { id: 'ev_2', title: 'קורס', date: '2026-09-12' }
  ]
});

// המקור הפעיל מכיל אנשים ותוכן. הייבוא החדש מביא את אותם אנשים.
function activeWith(extra) {
  const first = plan();
  return carriedOf(Object.assign({ id: first.source_id }, first.meta), extra);
}

try {
  const uids = plan().people.map((item) => item.id);
  // התוכן שעובר ממופה ל-uid-ים שקיימים בפועל ברשימה.
  const carried = {
    carry: CARRY.carry,
    availability: { [uids[0]]: CARRY.availability['uid-a'],
      [uids[1]]: CARRY.availability['uid-b'] },
    locked: { [uids[0]]: CARRY.locked['uid-a'] },
    events: CARRY.events
  };
  const changed = rows();
  changed[0].sub_station = 'timna';
  const next = plan({ rows: changed, previous: activeWith(carried) });

  // --- הליבה: שום דבר לא נמחק ---
  eq('13.1 carry עובר כפי שהוא', next.meta.carry, CARRY.carry);
  eq('13.2 זמינות עוברת', next.availability.length, 2);
  eq('13.3 נעילות עוברות', next.locked.length, 1);
  eq('13.4 אירועים עוברים', next.events.length, 2);

  // ⭐ בית-בית, ולא „בערך". הרנטיים מחשב מחדש חתימה על התוכן הזה;
  // שינוי של תו אחד היה מפיל את `loadSource` על digest-mismatch.
  eq('13.5 הזמינות זהה בתוכן',
    next.availability.find((x) => x.id === uids[0]).data.days,
    CARRY.availability['uid-a']);
  eq('13.6 הנעילה זהה בתוכן',
    next.locked[0].data.days, CARRY.locked['uid-a']);
  eq('13.7 האירוע זהה בתוכן', next.events[0].data, CARRY.events[0]);

  // הספירות החתומות משקפות את מה שבאמת עובר.
  eq('13.8 הספירה סופרת זמינות', next.counts.availability, 2);
  eq('13.9 הספירה סופרת נעילות', next.counts.locked, 1);
  eq('13.10 הספירה סופרת אירועים', next.counts.events, 2);

  // ⭐ והמבחן שהיה תופס את הבאג המקורי: אלה אינם אפס.
  ok('13.11 הספירות אינן אפס — זה בדיוק מה שהבאג עשה',
    next.counts.availability > 0 && next.counts.locked > 0
    && next.counts.events > 0);

  /* ⭐ 13.11b היא הטענה החזקה בסעיף הזה, והיא נוספה אחרי שמוטציה
   * שרדה: החזרתי את `basis` בכותב לליטרלים ריקים, וכל 13.1–13.11
   * המשיכו לעבור — כי הם בודקים את מסמכי התת-אוסף, ו-`basis` מזין
   * רק את החתימה.
   *
   * במציאות זה היה מסמך שנכתב עם תוכן וחתימה של ריק: הכתיבה
   * מצליחה, ואז `loadSource` נופל על `source-digest-mismatch` —
   * מקור שנשמר ואי אפשר להריץ. לכן החתימה מחושבת כאן מחדש עם
   * `stable()` של הרנטיים, מעל התוכן שבאמת עובר. */
  if (runtimeStable) {
    eq('13.11b החתימה מכסה את התוכן שעבר',
      next.digest, hash(runtimeStable(basisOf(next))));
  } else {
    ok('13.11b החתימה מכסה את התוכן שעבר', false, 'stable() של הרנטיים לא נטען');
  }
} catch (e) {
  ok('13.x העברת תוכן', false, (e && e.code) + ' · ' + e.message);
}

/* --- מי שיצא מהרשימה — יוצא, אבל לא בשקט --- */

try {
  const carried = {
    carry: {},
    availability: { 'uid-gone': { '2026-09-01': 'yes' } },
    locked: { 'uid-also-gone': { '2026-09-02': 'x' } },
    events: []
  };
  let blocked = null;
  try { plan({ previous: activeWith(carried) }); }
  catch (e) { blocked = e; }
  ok('13.12 רשומה של אדם שאינו ברשימה אינה נושרת בשקט',
    !!blocked && blocked.code === CODE.CARRY_ORPHANED,
    blocked ? blocked.code : 'לא נחסם');

  // ⭐ שורות שונות בכוונה: יבוא זהה חוזר במסלול `unchanged`, שאינו
  // כותב דבר ולכן גם אינו מפיל איש. מה שנבדק כאן הוא המסלול שכן כותב.
  const moved = rows();
  moved[0].sub_station = 'timna';

  // אישור מספרי מדויק — בדיוק כמו שורה שנדחתה.
  const acked = plan({ rows: moved, previous: activeWith(carried),
    accept_carry_dropped: 2 });
  eq('13.13 אישור מדויק מאפשר להמשיך', acked.carried_dropped,
    { availability: 1, locked: 1 });
  eq('13.14 והן באמת לא נכנסו', acked.counts.availability + acked.counts.locked, 0);

  let wrong = null;
  try { plan({ rows: moved, previous: activeWith(carried), accept_carry_dropped: 1 }); }
  catch (e) { wrong = e; }
  ok('13.15 מספר שאינו מדויק נחסם',
    !!wrong && wrong.code === CODE.CARRY_ACK_MISMATCH, wrong ? wrong.code : 'לא נחסם');

  // ⭐ וגם: היוצאים נספרים ביומן, כמספר ובלי מי.
  ok('13.16 היומן סופר את היוצאים בלי לנקוב בשם',
    acked.audit.carry_dropped_availability === 1
    && acked.audit.carry_dropped_locked === 1
    && JSON.stringify(acked.audit).indexOf('uid-gone') === -1);
} catch (e) {
  ok('13.y יוצאים', false, (e && e.code) + ' · ' + e.message);
}

/* --- מקור פעיל שאיננו יודעים לקרוא אינו „ריק" --- */

try {
  const first = plan();
  let noCarried = null;
  try { plan({ previous: Object.assign({ id: first.source_id }, first.meta) }); }
  catch (e) { noCarried = e; }
  // ⭐ זו הנקודה: „לא צורף תוכן" חייב להיות כשל ולא ברירת מחדל ריקה,
  // כי ברירת מחדל ריקה *היא* המחיקה.
  ok('13.17 מקור פעיל בלי תוכן שעובר נחסם',
    !!noCarried && noCarried.code === CODE.CARRY_SHAPE,
    noCarried ? noCarried.code : 'לא נחסם');

  for (const broken of [
    { carry: null, availability: {}, locked: {}, events: [] },
    { carry: {}, availability: [], locked: {}, events: [] },
    { carry: {}, availability: {}, locked: {}, events: {} },
    { carry: {}, availability: {}, locked: {}, events: [{ title: 'בלי מזהה' }] }
  ]) {
    let bad = null;
    try { plan({ previous: activeWith(broken) }); } catch (e) { bad = e; }
    ok('13.18 צורה פגומה נחסמת', !!bad && bad.code === CODE.CARRY_SHAPE,
      bad ? bad.code : 'לא נחסם');
  }

  // מקור ראשון בתחנה — אין ממה להעביר, וזה תקין.
  const fresh = plan({ previous: null });
  eq('13.19 מקור ראשון מתחיל ריק כדין', fresh.counts.availability, 0);
  eq('13.20 ובלי אירועים', fresh.counts.events, 0);
} catch (e) {
  ok('13.z צורה', false, (e && e.code) + ' · ' + e.message);
}

/* ==================================================================
 * 14 · ⭐ P1-4 · סגל פעיל שאינו בגיליון
 *
 * גיליון חלקי — עמודה שנגררה, סינון שנשכח פתוח, העתקה של חצי
 * טבלה — יצר מקור תקין לחלוטין שחסרים בו אנשים. הם לא שובצו, ואיש
 * לא קיבל הודעה, כי מבחינת המערכת הם לא היו קיימים.
 * ================================================================== */

try {
  const half = rows().slice(0, 2);

  // בדיקה מקדימה מדווחת ואינה חוסמת — אחרת אין מה לאשר.
  const preview = plan({ rows: half });
  eq('14.1 תצוגה מקדימה מדווחת כמה חסרים', preview.missing_staff, 2);
  eq('14.2 ואינה חוסמת', preview.kind, 'created');

  // הפעלה של מקור חלקי דורשת אישור מספרי מדויק.
  let blocked = null;
  try { plan({ rows: half, activate: true }); } catch (e) { blocked = e; }
  ok('14.3 הפעלת מקור חלקי נחסמת בלי אישור',
    !!blocked && blocked.code === CODE.MISSING_STAFF, blocked ? blocked.code : 'לא נחסם');
  eq('14.4 והמספר מוחזר לתיקון', blocked && blocked.detail && blocked.detail.missing, 2);

  let wrong = null;
  try { plan({ rows: half, activate: true, accept_missing: 1 }); } catch (e) { wrong = e; }
  ok('14.5 אישור שאינו מדויק נחסם',
    !!wrong && wrong.code === CODE.MISSING_ACK_MISMATCH, wrong ? wrong.code : 'לא נחסם');

  const acked = plan({ rows: half, activate: true, accept_missing: 2 });
  eq('14.6 אישור מדויק מאפשר להפעיל', acked.missing_staff, 2);
  eq('14.7 והיומן סופר אותם', acked.audit.missing_staff, 2);

  // גיליון מלא — אין חסרים, ואין מה לאשר.
  const full = plan({ activate: true });
  eq('14.8 גיליון מלא אינו דורש אישור', full.missing_staff, 0);

  // ⭐ ומי שחסר הוא אדם: המספר מדווח, השם והמזהה לא.
  const text = JSON.stringify({ report: acked.report, audit: acked.audit,
    missing: acked.missing_staff });
  ok('14.9 אין מזהה של מי שחסר בדוח וביומן',
    ['uid-ccc', 'uid-ddd', 'פרופיל גימל', 'פרופיל דלת']
      .every((v) => text.indexOf(v) === -1));
} catch (e) {
  ok('14.x סגל חסר', false, (e && e.code) + ' · ' + e.message);
}

/* --- פרופיל בלי שם אינו נופל חזרה על הגיליון --- */

try {
  const nameless = KNOWN.map((person) => person.employee_number === '1001'
    ? { uid: person.uid, employee_number: person.employee_number } : person);
  const out = plan({ known: nameless, accept_rejected: 1 });
  const row = out.report.rows.find((item) => item.code === ROW.PROFILE_NAME_MISSING);
  ok('14.10 חשבון בלי שם בפרופיל נדחה בקוד משלו', !!row, 'לא נמצא קוד');
  // ⭐ והנקודה: הוא **לא** נכנס עם השם שהודבק בגיליון.
  ok('14.11 והשם מהגיליון אינו משמש כגיבוי',
    JSON.stringify(out.people).indexOf('בדיקה אלף') === -1);
} catch (e) {
  ok('14.y פרופיל בלי שם', false, (e && e.code) + ' · ' + e.message);
}

/* ==================================================================
 * סיכום
 * ================================================================== */

if (fails.length) {
  console.error('schedule-source-author-probe · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('schedule-source-author-probe · ' + pass + '/' + pass + ' עברו');
console.log('  כל השמות והמספרים כאן מומצאים. לא נבדק כאן: כללי Firestore');
console.log('  והכתיבה המדורגת מול Firestore אמיתי — אלה דורשים אמולטור.');
