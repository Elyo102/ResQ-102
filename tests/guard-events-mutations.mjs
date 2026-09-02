// =====================================================================
//  מוטציות · guard-events
//
//  „הבדיקות עוברות" אינה טענה. **השאלה היא אם הן היו נופלות
//  אילו הקוד היה שבור.** הקובץ הזה פוגם במקור בכוונה, אחת אחת,
//  ומוודא שלפחות שמירה אחת נופלת בכל פגימה.
//
//  מוטציה ששורדת אינה תקלה בקוד — היא **חור בבדיקות**, ומסומנת
//  ככזאת בפלט.
//
//  ואחת מהפגימות כאן **מוסיפה** כלל במקום להסיר: פסילת אבטחה
//  שסיומה מוקדם מהתחלתה. הכלל הזה נראה נכון לחלוטין בקריאה,
//  והוא היה מוחק מהסידור את כל אבטחות הלילה.
//
//      node tests/guard-events-mutations.mjs
//
//  הפגימה נכתבת לקובץ זמני. **המקור אינו נוגע ואינו משתנה.**
// =====================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'functions', 'guard-events.js');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const require_ = createRequire(import.meta.url);

const ST = 'eilat_102';
const OTHER = 'station_777';
const ME = 'uid-me';
const MATE = 'uid-mate';
const GONE = 'uid-left-the-station';
const DATES = ['2026-09-01', '2026-09-02'];

const ROSTER = [
  { uid: ME, is_active: true },
  { uid: MATE, is_active: true },
  { uid: GONE, is_active: false }
];

function guard(extra) {
  return Object.assign({
    id: 'g_0001', date: '2026-09-01', title: 'אבטחת אירוע',
    start: '18:00', end: '23:00', status: 'staffed', assigned: [ME, MATE],
    notes: 'הערה פרטית', place: 'טיילת צפון', signups: [GONE],
    need_quals: ['q_driver'], by_uid: 'uid-commander', kind: 'אבטחת המונים',
    slots: 4, created_at: '2026-08-20T10:00:00Z'
  }, extra || {});
}

const st = (P, extra, over) => P.stationGuardEvents(Object.assign({
  guards: [guard(extra)], dates: DATES, roster: ROSTER, station_id: ST
}, over || {}));

const me = (P, extra, over) => P.personalGuardEvents(Object.assign({
  guards: [guard(extra)], dates: DATES, roster: ROSTER,
  viewer_uid: ME, station_id: ST
}, over || {}));

// ---------------------------------------------------------------------
//  השמירות · כל אחת חייבת להתקיים על הקוד התקין
// ---------------------------------------------------------------------

const GUARDS = [
  ['אבטחה תקינה יוצאת',
    (P) => st(P).events.length === 1],
  ['בדיוק שבעה שדות',
    (P) => Object.keys(st(P).events[0]).length === 7],
  ['assigned הופך ל-people',
    (P) => Array.isArray(st(P).events[0].people) && st(P).events[0].people.length === 2],
  ['אין דליפת שדה רגיש',
    (P) => {
      const t = JSON.stringify(st(P).events);
      return ['notes', 'place', 'signups', 'need_quals', 'by_uid', 'kind',
              'הערה פרטית', 'טיילת צפון', 'uid-commander'].every((n) => t.indexOf(n) === -1);
    }],
  ['מבוטלת אינה יוצאת',
    (P) => st(P, { status: 'cancelled' }).events.length === 0],
  ['מצב שאינו ברשימה נופל',
    (P) => st(P, { status: 'archived' }).events.length === 0],
  ['משובץ לא פעיל אינו ב-people',
    (P) => {
      const e = st(P, { assigned: [ME, GONE] }).events[0];
      return e && e.people.length === 1 && e.people[0] === ME;
    }],
  ['מזהה של לא פעיל אינו יוצא בשום צורה',
    (P) => JSON.stringify(st(P, { assigned: [ME, GONE] })).indexOf(GONE) === -1],
  ['תאריך מחוץ לטווח נופל',
    (P) => st(P, { date: '2026-09-09' }).events.length === 0],
  ['תאריך לא תקין נופל',
    (P) => st(P, { date: '2026-13-01' }).events.length === 0],
  ['29 בפברואר בשנה לא מעוברת נופל',
    (P) => P.stationGuardEvents({
      guards: [guard({ date: '2027-02-29' })], dates: ['2027-02-28', '2027-02-29'],
      roster: ROSTER
    }).events.length === 0],
  ['כותרת ריקה נופלת',
    (P) => st(P, { title: '' }).events.length === 0],
  ['תו בלתי נראה בכותרת מפיל',
    (P) => st(P, { title: 'אבטחה' + String.fromCharCode(0x200b) + 'רגילה' }).events.length === 0],
  ['שעה לא תקינה מפילה',
    (P) => st(P, { start: '99:99' }).events.length === 0],
  // ⚠️ השמירה שמגינה על אבטחות הלילה
  ['אבטחת לילה 22:00–06:00 נשארת',
    (P) => st(P, { start: '22:00', end: '06:00' }).events.length === 1],
  ['שעות חסרות מפילות',
    (P) => {
      const g = guard(); delete g.start; delete g.end;
      const r = P.stationGuardEvents({ guards: [g], dates: DATES, roster: ROSTER });
      return r.events.length === 0 && r.dropped.guard_time_invalid === 1;
    }],
  ['תחנה זרה במסמך נופלת',
    (P) => st(P, { stationId: OTHER }).events.length === 0],
  ['assigned שאינו מערך מפיל',
    (P) => {
      const r = st(P, { assigned: {} });
      return r.events.length === 0 && r.dropped.guard_assigned_invalid === 1;
    }],
  ['UID פגום בתוך assigned מפיל את האירוע',
    (P) => st(P, { assigned: [ME, 'uid/bad'] }).events.length === 0],
  ['אישי · רואה את שלו',
    (P) => me(P).events.length === 1],
  ['אישי · אינו רואה של אחר',
    (P) => me(P, { assigned: [MATE] }).events.length === 0],
  ['אישי · אין ולו מזהה עמית אחד',
    (P) => JSON.stringify(me(P).events).indexOf(MATE) === -1],
  // **הסיבה, לא רק הריקנות.** בדיקה שמסתפקת ב-„אפס אירועים"
  // עוברת גם בלי שער הצופה כלל: מי שאינו פעיל ממילא אינו
  // ב-`people`, ולכן הוא נופל שורה אחת מאוחר יותר על `not_mine`.
  // זו תוצאה נכונה מסיבה שגויה, ו„לא בסגל" אינו „האבטחה אינה
  // שלך" — הקורא עשוי לפעול אחרת על כל אחת מהן.
  ['אישי · צופה לא פעיל נחסם, ובסיבה הנכונה',
    (P) => {
      const r = me(P, {}, { viewer_uid: GONE });
      return r.events.length === 0 && r.dropped.viewer_not_active === 1;
    }],
  ['הסדר יציב',
    (P) => {
      const r = P.stationGuardEvents({
        guards: [
          guard({ id: 'g_c', date: '2026-09-02', start: '08:00' }),
          guard({ id: 'g_a', date: '2026-09-01', start: '20:00' }),
          guard({ id: 'g_b', date: '2026-09-01', start: '06:00' })
        ], dates: DATES, roster: ROSTER
      });
      return r.events.map((e) => e.id).join(',') === 'g_b,g_a,g_c';
    }],
  ['הקלט אינו משתנה',
    (P) => {
      const guards = [guard()];
      const before = JSON.stringify(guards);
      P.stationGuardEvents({ guards: guards, dates: DATES, roster: ROSTER });
      return JSON.stringify(guards) === before;
    }],
  ['קלט ריק אינו זורק',
    (P) => P.stationGuardEvents(undefined).events.length === 0]
];

// ---------------------------------------------------------------------
//  הפגימות
// ---------------------------------------------------------------------

const MUTATIONS = [
  ['מבוטלת מתקבלת',
    "if (guard.status === CANCELLED) { drops.add(DROP.GUARD_CANCELLED); return null; }",
    "if (false) { drops.add(DROP.GUARD_CANCELLED); return null; }"],

  ['כל מצב מתקבל',
    "if (typeof guard.status !== 'string' || GUARD_STATUSES.indexOf(guard.status) === -1) {",
    "if (false) {"],

  ['משובץ לא פעיל מתקבל',
    "if (!activeSet[uid]) { rejected++; continue; }",
    "if (false) { rejected++; continue; }"],

  ['UID פגום מתקבל',
    "if (typeof uid !== 'string' || !AUTH_UID_PATTERN.test(uid)) {",
    "if (false) {"],

  ['תאריך מחוץ לטווח מתקבל',
    "if (!dateSet[guard.date]) { drops.add(DROP.GUARD_DATE_OUT_OF_RANGE); return null; }",
    "if (false) { drops.add(DROP.GUARD_DATE_OUT_OF_RANGE); return null; }"],

  ['תאריך אינו מאומת כלוח אמיתי',
    "  if (month < 1 || month > 12 || day < 1) return false;",
    "  if (month < 1 || month > 12 || day < 1) return false;\n  return true;"],

  ['שנה מעוברת מתעלמת',
    "  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) max = 29;",
    "  if (month === 2) max = 29;"],

  ['כותרת אינה מאומתת',
    "if (!isCleanString(guard.title, TITLE_MAX)) {",
    "if (false) {"],

  ['תווים בלתי נראים מתקבלים',
    "         value.length <= max && !INVISIBLE.test(value);",
    "         value.length <= max;"],

  ['שעות אינן מאומתות',
    "if (!start.ok || !end.ok) { drops.add(DROP.GUARD_TIME_INVALID); return null; }",
    "if (false) { drops.add(DROP.GUARD_TIME_INVALID); return null; }"],

  // ⚠️ הפגימה היחידה כאן שמוסיפה כלל במקום להסיר אותו. היא
  // נראית נכונה לגמרי בקריאה — ומוחקת מהסידור כל אבטחת לילה.
  ['נוסף כלל שסיום חייב להיות אחרי התחלה',
    "if (!start.ok || !end.ok) { drops.add(DROP.GUARD_TIME_INVALID); return null; }",
    "if (!start.ok || !end.ok) { drops.add(DROP.GUARD_TIME_INVALID); return null; }\n"
    + "  if (start.value && end.value && end.value <= start.value) {\n"
    + "    drops.add(DROP.GUARD_TIME_INVALID); return null;\n  }"],

  ['תחנה זרה מתקבלת',
    "carried !== '' && carried !== stationId) {",
    "carried !== '' && false) {"],

  ['assigned שאינו מערך מתקבל',
    "if (!Array.isArray(assignedRaw)) { drops.add(DROP.GUARD_ASSIGNED_INVALID); return null; }",
    "if (false) { drops.add(DROP.GUARD_ASSIGNED_INVALID); return null; }"],

  ['המסמך מועתק במקום להיבנות',
    "  return {\n    id: guard.id,",
    "  return {\n    ...guard,\n    id: guard.id,"],

  ['התצוגה האישית מציגה גם של אחרים',
    "if (event.people.indexOf(viewer) === -1) { drops.add(DROP.NOT_MINE); continue; }",
    "if (false) { drops.add(DROP.NOT_MINE); continue; }"],

  ['התצוגה האישית מחזירה את כל המשובצים',
    "      people: Object.freeze([viewer])",
    "      people: event.people"],

  ['צופה לא פעיל מתקבל',
    "if (typeof viewer !== 'string' || viewer === '' || !ready.activeSet[viewer]) {",
    "if (typeof viewer !== 'string' || viewer === '') {"],

  ['הסדר אינו קבוע',
    "  events.sort(byDateThenStartThenId);\n  return result(events, drops.frozen());\n}\n\n// ---",
    "  return result(events, drops.frozen());\n}\n\n// ---"]
];

// ---------------------------------------------------------------------

let pass = 0, fail = 0;
const survivors = [];

function loadFrom(text, tag) {
  const file = path.join(os.tmpdir(), 'ge-mutation-' + tag + '-' + process.pid + '.js');
  fs.writeFileSync(file, text, 'utf8');
  try { delete require_.cache[require_.resolve(file)]; } catch (error) { /* טרם נטען */ }
  const loaded = require_(file);
  fs.unlinkSync(file);
  return loaded;
}

console.log('\n--- 0 · הקוד התקין · כל השמירות מתקיימות');

const clean = loadFrom(source, 'clean');
GUARDS.forEach(function (g) {
  let held;
  try { held = g[1](clean); } catch (error) { held = false; }
  if (held) { pass++; console.log('✓ ' + g[0]); }
  else { fail++; console.log('✗ ' + g[0] + ' — נכשלה על הקוד התקין'); }
});
assert.equal(fail, 0, 'שמירה נכשלה על הקוד התקין — אין טעם להמשיך למוטציות');

console.log('\n--- 1 · פגימות · כל אחת חייבת להיתפס');

MUTATIONS.forEach(function (mutation, index) {
  const label = mutation[0];
  assert.ok(source.includes(mutation[1]), 'הקטע לפגימה לא נמצא במקור · ' + label);

  const mutated = source.replace(mutation[1], mutation[2]);
  assert.notEqual(mutated, source, label);

  let caught = null;
  let broke = false;
  try {
    const P = loadFrom(mutated, String(index));
    for (let i = 0; i < GUARDS.length; i++) {
      let held;
      try { held = GUARDS[i][1](P); } catch (error) { held = false; }
      if (!held) { caught = GUARDS[i][0]; break; }
    }
  } catch (error) { broke = true; }

  if (broke) { pass++; console.log('✓ ' + label + '  →  המודול אינו נטען'); }
  else if (caught) { pass++; console.log('✓ ' + label + '  →  נתפסה ב: ' + caught); }
  else {
    fail++; survivors.push(label);
    console.log('✗ ' + label + '  →  **שרדה** · חור בבדיקות');
  }
});

console.log('\n============================================');
console.log('  עברו ' + pass + '  ·  נכשלו ' + fail);
if (survivors.length) {
  console.log('  מוטציות ששרדו:');
  survivors.forEach(function (name) { console.log('    ' + name); });
}
console.log('============================================');
process.exit(fail ? 1 : 0);
