/* ======================================================================
 *  retro-report — „דיווח רטרואקטיבי" כעובדה נגזרת
 *
 *  מה נבדק כאן: הגזירה עצמה, וההבטחה שאין דגל שמור שאפשר לשקר בו.
 *
 *  למה זו בדיקה ולא הערה: דיווח ידני רגיל עובר כעת דרך גבול שרת
 *  שמפיק את `reported_at` מחותמת זמן שרת. רטרואקטיביות עדיין אינה
 *  יכולה להיות בוליאני שנשמר — היא נגזרת מהתאריך הקנוני ומהחותמת.
 *  כללי Firestore נשארים הגנת עומק למסלולי הלקוח ההיסטוריים עד
 *  שגם הם יועברו לגבול השרת.
 *
 *  מה **אינו** נבדק כאן: אכיפת הכללים עצמה. היא דורשת אמולטור
 *  Firestore ורצה ב-rules-test. כאן נבדקים הגזירה והמקור.
 * ====================================================================== */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retroDays, retroLabel, reportedAtMs, jerusalemDate } from '../hours.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0;
const failures = [];
function check(name, value, detail) {
  if (value) { passed += 1; console.log('✓ ' + name); }
  else { failures.push(name); console.log('✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const at = (iso) => ({ reported_at: { toMillis: () => Date.parse(iso) } });

/* ---------- 1 · הגזירה ---------- */

check('a report made on the day itself is not retroactive',
  retroDays('2026-09-19', at('2026-09-19T10:00:00+03:00')) === 0);
check('nor is one made a minute before midnight of that day',
  retroDays('2026-09-19', at('2026-09-19T23:59:00+03:00')) === 0);
check('the next calendar day counts as one',
  retroDays('2026-09-18', at('2026-09-19T00:05:00+03:00')) === 1);
/* ⭐ ספירה בימי לוח ולא בשעות: 2.4 ימים הם „שלושה ימים אחרי" לאדם
 * שמסתכל על התאריכים, ו„שניים" רק למי שסופר שעות. */
check('three calendar days later is three, not two and a half',
  retroDays('2026-09-16', at('2026-09-19T10:00:00+03:00')) === 3,
  'got ' + retroDays('2026-09-16', at('2026-09-19T10:00:00+03:00')));
check('a month later is counted in days, not clipped',
  retroDays('2026-08-19', at('2026-09-19T10:00:00+03:00')) === 31);

/* ---------- 2 · מה שאין בו מספיק כדי להכריע ---------- */

check('a record with no server stamp is never called retroactive',
  retroDays('2026-09-01', {}) === 0 && retroLabel('2026-09-01', {}) === '');
check('an invalid date key decides nothing',
  retroDays('19/09/2026', at('2026-09-19T10:00:00+03:00')) === 0);
check('a Firestore Timestamp, a Date and a seconds object all read the same', (() => {
  const ms = Date.parse('2026-09-19T10:00:00+03:00');
  return reportedAtMs({ reported_at: { toMillis: () => ms } }) === ms
    && reportedAtMs({ reported_at: new Date(ms) }) === ms
    && reportedAtMs({ reported_at: { seconds: Math.floor(ms / 1000) } }) === Math.floor(ms / 1000) * 1000;
})());

/* ---------- 3 · שעון ישראל, לא שעון המכשיר ---------- */

/* דיווח ב-00:30 בשעון ישראל על היום הקודם הוא יום אחד אחרי. אותו רגע
 * ב-UTC עדיין שייך ליום הקודם — ומי שיחשב לפי UTC יקבל אפס ויכריז
 * שהדיווח היה בזמן. */
check('the day boundary is Jerusalem, not UTC',
  retroDays('2026-09-18', at('2026-09-19T00:30:00+03:00')) === 1
  && jerusalemDate(Date.parse('2026-09-18T22:30:00Z')) === '2026-09-19');

/* ---------- 4 · הניסוח ---------- */

check('one day reads as one day, more reads as a count',
  retroLabel('2026-09-18', at('2026-09-19T09:00:00+03:00')) === 'דיווח רטרואקטיבי · יום אחרי'
  && retroLabel('2026-09-16', at('2026-09-19T09:00:00+03:00')) === 'דיווח רטרואקטיבי · 3 ימים אחרי');
check('a report on time carries no label at all',
  retroLabel('2026-09-19', at('2026-09-19T09:00:00+03:00')) === '');

/* ---------- 5 · המקור: אין דגל שמור, ו„מתי" בא מהשרת ---------- */

const rules = read('firestore.rules');
const page = read('attendance.html');
const selfService = read('functions/attendance-self-service.js');

check('the rules close direct employee attendance updates and deletes',
  /match \/attendance\/\{docId\}[\s\S]{0,2600}?allow update, delete: if false;/.test(rules));
check('the rules close every direct monthly report mutation',
  /match \/monthly_reports\/\{docId\}[\s\S]{0,700}?allow create, update, delete: if false;/.test(rules));
/* ⭐ הבדיקה שמונעת חזרה לדגל: אם מישהו יוסיף שדה בוליאני כזה, זה
 * ייפול כאן ולא יתגלה כשמישהו ישאל למה הדוח אומר משהו אחר. */
check('no stored retroactive flag is written anywhere on the page',
  !/\bretroactive\s*:/.test(page) && !/['"]retroactive['"]\s*:/.test(page));
check('the trusted service writes reported_at from a server timestamp on create',
  /const commit = serverTimestamp\(\)/.test(selfService)
  && /reported_at: commit/.test(selfService));
check('ordinary browser save sends no reported_at claim', (() => {
  const start = page.indexOf('async function saveRecord(');
  const end = page.indexOf('async function createMissingDays(', start);
  const save = start >= 0 && end > start ? page.slice(start, end) : '';
  return /callMutateMyAttendanceDay/.test(save) && !/reported_at|serverTimestamp|\bsetDoc\b/.test(save);
})());
check('the page offers a date field for reporting any day',
  /id="jumpDate"/.test(page) && /type="date"/.test(page));
check('and says plainly that a past day is allowed and will be marked',
  /אפשר לדווח גם על יום שכבר עבר/.test(page));

console.log('');
console.log('NOT RUN here — the rules themselves (emulator). This file checks the derivation');
console.log('and source contract; rules-test/attendance-retro.test.mjs checks direct denial.');
console.log('');
if (failures.length) {
  console.error(failures.length + ' retroactive reporting checks failed.');
  process.exit(1);
}
console.log(passed + ' retroactive reporting checks passed.');
