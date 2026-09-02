/* ====================================================================
 *  schedule-notice-text-probe
 *
 *  מה בדיוק כתוב על המסך הנעול.
 *
 *  ----------------------------------------------------------------
 *  למה זו בדיקה נפרדת
 *  ----------------------------------------------------------------
 *
 *  „שינוי אחד בסידור שלך" ו„יש עדכון לאבטחה בסידור שלך" הם נכונים,
 *  עוברים כל בדיקת מבנה, ו**חסרי תועלת**: מי שמקבל אותם בשתיים
 *  בלילה חייב לפתוח את האפליקציה רק כדי לדעת אם זה נוגע למשמרת של
 *  מחר בבוקר. בדיקה שסופרת שדות במטען לא הייתה תופסת את זה לעולם.
 *
 *  ⭐ לכן הבדיקה הזאת משווה **מחרוזות**. היא שואלת שאלה אחת: אם
 *  שיבצו אותי מחדש, ההודעה אומרת לאיזה יום ולאיזו תחנה?
 *
 *  ובאותה נשימה, הצד השני של אותו מטבע: ההודעה **אינה** אומרת מי
 *  עוד שם. מי שרוצה לדעת עם מי הוא עובד פותח את האפליקציה.
 *
 *  הפונקציות ברנטיים סגורות בתוך המפעל, ולכן הן נשלפות מהמקור
 *  ומורצות — לא משוכפלות.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { readFileSync } from 'node:fs';
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
  ok(name, actual === expected, 'קיבלתי „' + actual + '" במקום „' + expected + '"');
}

let RUNTIME_SRC, publication;
try {
  RUNTIME_SRC = readFileSync(resolve(FN, 'schedule-runtime.js'), 'utf8');
  publication = require_(resolve(FN, 'schedule-publication.js'));
} catch (e) {
  console.error('NOT RUN — לא ניתן לטעון: ' + e.message);
  process.exit(2);
}

/* ==================================================================
 *  1 · אבטחה · הפונקציות נשלפות מהרנטיים ומורצות
 * ================================================================== */

function extractFn(src, signature) {
  const at = src.indexOf(signature);
  if (at === -1) return null;
  const end = src.indexOf('\n  }\n', at);
  return end === -1 ? null : src.slice(at, end + 4);
}

const guardText = (() => {
  const parts = ['function shortDate(iso) {', 'function guardPlaceText(value) {',
    'function guardOutboxText(value) {'].map((sig) => extractFn(RUNTIME_SRC, sig));
  if (parts.some((part) => !part)) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(
      "const DATE_RE = /^\\d{4}-\\d{2}-\\d{2}$/;\n"
      + 'const CONTROL_RE = /[\\u0000-\\u001F\\u007F]/g;\n'
      + parts.join('\n') + '\nreturn guardOutboxText;')();
  } catch (_) { return null; }
})();

ok('1.1 הפונקציות נשלפו והורצו', !!guardText);

if (guardText) {
  const guard = { date: '2026-09-04', start: '18:00', end: '23:00', place: 'אצטדיון העיר' };

  // ⭐ השאלה האמיתית: אם שובצתי לאבטחה, ההודעה אומרת מתי ואיפה?
  eq('1.2 שיבוץ לאבטחה · כותרת',
    guardText(Object.assign({ kind: 'assigned' }, guard)).title, 'שובצת לאבטחה');
  eq('1.3 שיבוץ לאבטחה · מתי ואיפה',
    guardText(Object.assign({ kind: 'assigned' }, guard)).body,
    'אבטחה נוספה לסידור שלך: 4/9 · 18:00–23:00 · אצטדיון העיר');

  eq('1.4 הסרה משיבוץ אומרת על איזו אבטחה',
    guardText(Object.assign({ kind: 'removed' }, guard)).body,
    'האבטחה אינה משובצת לך עוד: 4/9 · 18:00–23:00 · אצטדיון העיר');
  eq('1.5 שינוי מועד',
    guardText(Object.assign({ kind: 'rescheduled' }, guard)).body,
    'בדוק/י את המועד החדש בסידור שלך: 4/9 · 18:00–23:00 · אצטדיון העיר');
  eq('1.6 ביטול',
    guardText(Object.assign({ kind: 'cancelled' }, guard)).body,
    'האבטחה בוטלה: 4/9 · 18:00–23:00 · אצטדיון העיר');

  // אבטחה בלי מקום אינה מקבלת מקום מומצא, והמשפט נשאר תקין.
  eq('1.7 בלי מקום — בלי מקום',
    guardText({ kind: 'assigned', date: '2026-09-04', start: '18:00', end: '23:00' }).body,
    'אבטחה נוספה לסידור שלך: 4/9 · 18:00–23:00');
  eq('1.8 מקום ריק אינו מוסיף מפריד',
    guardText({ kind: 'assigned', date: '2026-09-04', start: '18:00', end: '23:00', place: '   ' }).body,
    'אבטחה נוספה לסידור שלך: 4/9 · 18:00–23:00');

  // ⭐ טקסט חופשי שמישהו הקליד מגיע למסך נעול. הוא מנוקה.
  // התווים כתובים כבריחות ולא כתווים גולמיים, כדי שהכוונה תשרוד
  // עורך שמנקה קבצים — ובלי זה הבדיקה יכולה להפוך לריקה בשקט.
  const dirtyPlace = 'אצטדיון\u0007\nהעיר\tהצפוני';
  const dirty = guardText({ kind: 'assigned', date: '2026-09-04', start: '18:00',
    end: '23:00', place: dirtyPlace }).body;
  ok('1.9a הקלט באמת מכיל תווי בקרה', /[\u0000-\u001F]/.test(dirtyPlace));
  ok('1.9 תווי בקרה מוסרים', !/[\u0000-\u001F]/.test(dirty), JSON.stringify(dirty));
  ok('1.9b והטקסט עצמו נשמר', dirty.indexOf('אצטדיון') > -1 && dirty.indexOf('הצפוני') > -1,
    dirty);

  const long = guardText({ kind: 'assigned', date: '2026-09-04', start: '18:00',
    end: '23:00', place: 'א'.repeat(300) }).body;
  ok('1.10 אורך נחתך', long.length < 120, 'אורך ' + long.length);

  // תאריך קצר, ובלי אפסים מובילים.
  eq('1.11 תאריך קצר',
    guardText({ kind: 'assigned', date: '2026-12-01', start: '08:00', end: '20:00' }).body,
    'אבטחה נוספה לסידור שלך: 1/12 · 08:00–20:00');

  // „נפתחה אבטחה" הוא כרוז לכל התחנה ולא שיבוץ אישי, ולכן אין בו
  // מקום ואין בו מועד — הוא אינו נוגע לאדם מסוים.
  ok('1.12 הודעת פתיחה נשארת כללית',
    guardText(Object.assign({ kind: 'open' }, guard)).body.indexOf('אצטדיון') === -1);
}

/* ==================================================================
 *  2 · סידור · דרך המודול האמיתי, מקצה לקצה
 * ================================================================== */

const HASH = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const P = publication.createPublication({
  clock: () => '2026-09-02T06:00:00.000Z', hash: HASH,
  rules: { max_attempts: 3, retry_backoff_ms: [1000, 5000] }
});

const slot = (person, role, label) => ({
  person, role, label, hours: '07:00-07:00', shift: null, cancelled: false
});
const row = (date, sub, label, slots) => ({
  date, station_id: '102', sub_station: sub, label,
  rotation_group: null, slots, complete: true
});
const plan = (rows) => ({
  kind: 'schedule-plan', station_id: '102', source_snapshot: 'snap_1',
  source_version: 'v1', contract_station_id: '102', source_revision: 'r17',
  source_digest: 'd', policy_version: 'v1', policy_digest: 'p',
  source_complete: true, rows,
  summary: { blocking_gaps: 0, days_below_minimum: 0, rejected_manual: 0 }
});
function notify(previous, next, person) {
  const result = P.planPublication({
    next, previous, publication_id: 'pub_2', publication_revision: previous ? 2 : 1,
    source_draft_id: 'draft_1', previous_publication_id: previous ? 'pub_1' : null,
    actor: 'רמי'
  });
  return result.notifications.filter((item) => item.person === person)[0] || null;
}

// ⭐ המקרה שבגללו כל זה נכתב: שיבצו אותי מחדש לתחנה אחרת.
const moved = notify(
  plan([row('2026-09-04', 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')])]),
  plan([row('2026-09-04', 'timna', 'תמנע', [slot('דן', 'driver', 'נהג')])]),
  'דן');
ok('2.1 נשלחה התראה', !!moved);
if (moved) {
  eq('2.2 שיבוץ מחדש · לאיזה יום ולאיזו תחנה',
    moved.push.body, 'שובצת מחדש · 4/9 · תמנע');
  eq('2.3 והמטען נושא את התאריך', moved.push.items[0].date, '2026-09-04');
  eq('2.4 והמטען נושא את התחנה', moved.push.items[0].sub_station, 'timna');
  eq('2.5 ואת התווית שלה', moved.push.items[0].sub_station_label, 'תמנע');
}

const added = notify(
  null,
  plan([row('2026-09-07', 'timna', 'תמנע', [slot('דן', 'driver', 'נהג')])]),
  'דן');
if (added) eq('2.6 שיבוץ חדש', added.push.body, 'שובצת · 7/9 · תמנע');

const removed = notify(
  plan([row('2026-09-04', 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')])]),
  plan([row('2026-09-04', 'rashit', 'ראשית', [slot('רון', 'driver', 'נהג')])]),
  'דן');
if (removed) {
  // בהסרה אין תחנה חדשה, ולכן נאמרת זו שממנה הוסר — כדי שיהיה
  // ברור על איזה שיבוץ מדובר.
  eq('2.7 ביטול שיבוץ', removed.push.body, 'בוטל שיבוץ · 4/9 · ראשית');
}

const hours = notify(
  plan([row('2026-09-04', 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')])]),
  plan([row('2026-09-04', 'rashit', 'ראשית',
    [Object.assign(slot('דן', 'driver', 'נהג'), { hours: '19:00-07:00' })])]),
  'דן');
if (hours) eq('2.8 שינוי שעות', hours.push.body, 'שונו השעות · 4/9 · ראשית');

// כמה שינויים — כל אחד נאמר, ולא „3 שינויים".
const many = notify(
  plan([
    row('2026-09-04', 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')]),
    row('2026-09-05', 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')])
  ]),
  plan([
    row('2026-09-04', 'timna', 'תמנע', [slot('דן', 'driver', 'נהג')]),
    row('2026-09-05', 'timna', 'תמנע', [slot('דן', 'driver', 'נהג')])
  ]),
  'דן');
if (many) {
  ok('2.9 שני ימים — שניהם נאמרים',
    many.push.body.indexOf('4/9') > -1 && many.push.body.indexOf('5/9') > -1,
    many.push.body);
  ok('2.10 ושתי התחנות',
    (many.push.body.match(/תמנע/g) || []).length >= 2, many.push.body);
  ok('2.11 ולא ספירה יבשה', many.push.body.indexOf('שינויים בסידור') === -1);
}

/* ==================================================================
 *  3 · הצד השני · ההתראה אינה אומרת מי עוד שם
 * ================================================================== */

const crewChanged = notify(
  plan([row('2026-09-04', 'rashit', 'ראשית',
    [slot('דן', 'driver', 'נהג'), slot('רון', 'ff', 'כבאי')])]),
  plan([row('2026-09-04', 'rashit', 'ראשית',
    [slot('דן', 'driver', 'נהג'), slot('אבי', 'ff', 'כבאי')])]),
  'דן');
ok('3.1 שינוי בהרכב הצוות מייצר התראה', !!crewChanged);
if (crewChanged) {
  const text = JSON.stringify(crewChanged.push);
  // ⭐ הרכב הצוות השתנה — וההתראה אומרת שהוא השתנה, לא מי נכנס.
  ok('3.2 שם מי שנכנס אינו במטען', text.indexOf('אבי') === -1, text);
  ok('3.3 שם מי שיצא אינו במטען', text.indexOf('רון') === -1, text);
  ok('3.4 שם מי שפרסם אינו במטען', text.indexOf('רמי') === -1, text);
  eq('3.5 והנוסח אומר מה השתנה',
    crewChanged.push.body, 'השתנה הצוות · 4/9 · ראשית');
}

// אירוע אינו יושב בתחנת קצה, ולכן אין להמציא לו אחת.
const event = P.planPublication({
  next: plan([row('2026-09-04', 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')])]),
  previous: plan([row('2026-09-04', 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')])]),
  events: [{ id: 'e1', date: '2026-09-09', title: 'קורס חילוץ', hours: '10:00-12:00',
    people: ['דן'], cancelled: false }],
  previous_events: [],
  publication_id: 'pub_2', publication_revision: 2, source_draft_id: 'draft_1',
  previous_publication_id: 'pub_1', actor: 'רמי'
}).notifications.filter((item) => item.person === 'דן')[0];
if (event) {
  eq('3.6 אירוע · תאריך בלי תחנה מומצאת', event.push.body, 'שובצת לאירוע · 9/9');
  ok('3.7 ואין בו תחנת קצה', event.push.items[0].sub_station === null,
    JSON.stringify(event.push.items[0]));
}

/* ==================================================================
 *  4 · המטען נשאר בגבולות
 * ================================================================== */

const wide = [];
const wideNext = [];
for (let day = 1; day <= 28; day++) {
  const date = '2026-09-' + String(day).padStart(2, '0');
  wide.push(row(date, 'rashit', 'ראשית', [slot('דן', 'driver', 'נהג')]));
  wideNext.push(row(date, 'timna', 'תמנע', [slot('דן', 'driver', 'נהג')]));
}
const big = notify(plan(wide), plan(wideNext), 'דן');
ok('4.1 חודש שלם של שינויים אינו מפיל את הפרסום', !!big);
if (big) {
  ok('4.2 הנוסח נשאר קצר', big.push.body.length < 120, big.push.body);
  ok('4.3 והוא אומר כמה עוד', big.push.body.indexOf('ועוד') > -1, big.push.body);
  ok('4.4 והימים הראשונים נקובים', big.push.body.indexOf('1/9') > -1, big.push.body);
}

/* ================================================================== */

if (fails.length) {
  console.error('schedule-notice-text-probe · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('schedule-notice-text-probe · ' + pass + '/' + pass + ' עברו');
console.log('  לא נבדק כאן: המסירה בפועל ל-FCM. זו בדיקה של הטקסט.');
