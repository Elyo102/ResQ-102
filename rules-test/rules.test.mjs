/**
 * ============================================================
 *  בדיקת כללי האבטחה של ResQ מול Firestore אמיתי
 * ============================================================
 *
 *  זו הבדיקה שחסרה בפרויקט מהיום הראשון.
 *
 *  כל שאר הבדיקות (smoke, role, numbers) רצות מול Firestore
 *  מזויף — הן בודקות מה המסך מציג, לא מה השרת מרשה. כלל
 *  אבטחה שגוי היה עובר אותן בשקט, ומתגלה רק כשכבאי אחד רואה
 *  את השעות של כבאי אחר.
 *
 *  כאן רץ אמולטור Firestore אמיתי. הכללים מהודרים באמת,
 *  והתרחישים נבדקים כמו מדפדפן.
 *
 *  הרצה:  test-rules.bat
 * ============================================================
 */

import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs
} from 'firebase/firestore';

const SID = 'eilat_102';
let pass = 0, fail = 0;
const failures = [];

function head(t) { console.log('\n\x1b[1m--- ' + t + '\x1b[0m'); }

async function ok(name, p) {
  try { await assertSucceeds(p); console.log('  \x1b[32m✓\x1b[0m ' + name); pass++; }
  catch (e) {
    console.log('  \x1b[31m✗\x1b[0m ' + name + '  \x1b[2m← נחסם, והיה אמור להיות מותר\x1b[0m');
    failures.push(name + ' — נחסם והיה אמור להיות מותר'); fail++;
  }
}

async function blocked(name, p) {
  try { await assertFails(p); console.log('  \x1b[32m✓\x1b[0m ' + name); pass++; }
  catch (e) {
    console.log('  \x1b[31m✗\x1b[0m ' + name + '  \x1b[2m← עבר, והיה אמור להיחסם\x1b[0m');
    failures.push('🔓 ' + name + ' — עבר והיה אמור להיחסם'); fail++;
  }
}

const env = await initializeTestEnvironment({
  projectId: 'resq-rules-test',
  firestore: {
    rules: readFileSync('../firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080
  }
});

// ---------- דמויות ----------
// כל אחת מחזיקה בדיוק את ה-claims שהשרת היה נותן לה.

const who = (uid, email, claims) => env.authenticatedContext(uid, { email, ...claims }).firestore();

//
// ⚠️ שם השדה קריטי, וזו בדיוק המלכודת שהבדיקה הזו נועדה לתפוס.
//
// בטוקן המשמרת נקראת  shift  — כך כותב אותה השרת (index.js
// שורות 496 ו-1059), וכך קוראים אותה הכללים (myShift).
// במסמך עצמו אותו נתון נקרא  crew.
//
// שני שמות לאותו דבר, בשתי שכבות. הגרסה הראשונה של הבדיקה
// כתבה crew בטוקן, myShift קיבל מחרוזת ריקה, וההתנהגות
// שהתקבלה הייתה "בלי שיוך משמרת" — שלפי הכלל אינה ננעלת.
// זה נראה בדיוק כמו חור אבטחה, והיה בסך הכול שם שדה שגוי.

const ff      = who('u_ff',   'ff@x.com',   { emp: '101', role: 'firefighter',       stationId: SID, shift: 'א' });
const ffB     = who('u_ffb',  'ffb@x.com',  { emp: '102', role: 'firefighter',       stationId: SID, shift: 'ב' });
const cmdA    = who('u_cmda', 'cmda@x.com', { emp: '201', role: 'commander',         stationId: SID, shift: 'א' });
const cmdB    = who('u_cmdb', 'cmdb@x.com', { emp: '202', role: 'commander',         stationId: SID, shift: 'ב' });
const deputyA = who('u_dep',  'dep@x.com',  { emp: '203', role: 'deputy',            stationId: SID, shift: 'א' });
const stCmd   = who('u_st',   'st@x.com',   { emp: '301', role: 'station_commander', stationId: SID, shift: '' });
const hrUser  = who('u_hr',   'hr@x.com',   { emp: '401', role: 'hr_coordinator',    stationId: SID, shift: '' });
const superA  = who('u_sup',  'fire102.shits@gmail.com', { super: true });
const pending = who('u_pend', 'pend@x.com', {});                       // נרשם, טרם אושר
const outside = who('u_out',  'out@x.com',  { emp: '999', role: 'firefighter', stationId: 'other_99', shift: 'א' });
// מפקד שטרם שויך למשמרת. לפי הכלל הוא אינו ננעל — אחרת הוא
// היה חסום משלוש המשמרות בלי שום דרך לראות שזו הסיבה.
const cmdNew  = who('u_new',  'new@x.com',  { emp: '204', role: 'commander',         stationId: SID, shift: '' });
const anon    = env.unauthenticatedContext().firestore();

// ---------- זריעת נתונים ----------
// עוקפים כללים בכוונה: אנחנו בודקים קריאה וכתיבה, לא הקמה.

await env.withSecurityRulesDisabled(async (c) => {
  const d = c.firestore();
  await setDoc(doc(d, `stations/${SID}`), { name: 'אילת', districtId: 'south' });
  await setDoc(doc(d, `stations/${SID}/users/u_ff`),
    { role: 'firefighter', crew: 'א', employee_number: '101', is_active: true, full_name: 'כבאי א' });
  await setDoc(doc(d, `stations/${SID}/users/u_ffb`),
    { role: 'firefighter', crew: 'ב', employee_number: '102', is_active: true, full_name: 'כבאי ב' });

  // נוכחות — הלב של המערכת
  await setDoc(doc(d, `stations/${SID}/attendance/att_ff_a`),
    { emp_number: '101', crew: 'א', status: 'draft',    hours: 24 });
  await setDoc(doc(d, `stations/${SID}/attendance/att_ffb_b`),
    { emp_number: '102', crew: 'ב', status: 'draft',    hours: 24 });
  await setDoc(doc(d, `stations/${SID}/attendance/att_ff_locked`),
    { emp_number: '101', crew: 'א', status: 'approved', hours: 24 });

  await setDoc(doc(d, 'directory/u_ff'), { full_name: 'כבאי א', crew: 'א' });
  await setDoc(doc(d, 'admin_audit/e1'), { what: 'set_role' });
  await setDoc(doc(d, 'mail/m1'), { to: ['a@b.c'] });
  await setDoc(doc(d, 'mail_failures/f1'), { to: ['a@b.c'], error: 'x' });
  await setDoc(doc(d, 'config/mode'), { mode: 'live' });
  await setDoc(doc(d, 'config/runtime'), { silent: false });
  await setDoc(doc(d, 'silenced/s1'), { kind: 'mail' });
  await setDoc(doc(d, 'join_attempts/u_ff'), { n: 1 });
  await setDoc(doc(d, 'emp_index/101'), { uid: 'u_ff' });
  await setDoc(doc(d, 'salary_rules/v1'), { rate: 1 });
  await setDoc(doc(d, `stations/${SID}/push_tokens/u_ff`), { token: 'abc' });
});

console.log('\n\x1b[1m╔══════════════════════════════════════════════════╗');
console.log('║   בדיקת כללי האבטחה — Firestore אמיתי            ║');
console.log('╚══════════════════════════════════════════════════╝\x1b[0m');

// ============================================================
head('1 · דוחות נוכחות — הנתון הרגיש ביותר');
// ============================================================
// שעות הן שכר. כבאי שרואה או עורך שעות של אחר הוא הכשל
// החמור ביותר שהמערכת יכולה לייצר.

await ok('כבאי קורא את הנוכחות של עצמו',
  getDoc(doc(ff, `stations/${SID}/attendance/att_ff_a`)));

await blocked('🔒 כבאי קורא נוכחות של כבאי אחר',
  getDoc(doc(ff, `stations/${SID}/attendance/att_ffb_b`)));

await blocked('🔒 כבאי עורך נוכחות של כבאי אחר',
  updateDoc(doc(ff, `stations/${SID}/attendance/att_ffb_b`), { hours: 99 }));

await blocked('🔒 כבאי מאשר לעצמו את הדוח (status=approved)',
  updateDoc(doc(ff, `stations/${SID}/attendance/att_ff_a`), { status: 'approved' }));

await blocked('🔒 כבאי עורך דוח שכבר אושר',
  updateDoc(doc(ff, `stations/${SID}/attendance/att_ff_locked`), { hours: 99 }));

await blocked('🔒 כבאי מוחק דוח שכבר אושר',
  deleteDoc(doc(ff, `stations/${SID}/attendance/att_ff_locked`)));

await blocked('🔒 כבאי מחליף את מספר העובד בדוח שלו',
  updateDoc(doc(ff, `stations/${SID}/attendance/att_ff_a`), { emp_number: '102' }));

await ok('ראש משמרת א קורא נוכחות של המשמרת שלו',
  getDoc(doc(cmdA, `stations/${SID}/attendance/att_ff_a`)));

await blocked('🔒 ראש משמרת א קורא נוכחות של משמרת ב',
  getDoc(doc(cmdA, `stations/${SID}/attendance/att_ffb_b`)));

await ok('סגן ראש משמרת א — סמכות זהה לראש המשמרת',
  getDoc(doc(deputyA, `stations/${SID}/attendance/att_ff_a`)));

await blocked('🔒 סגן משמרת א קורא נוכחות של משמרת ב',
  getDoc(doc(deputyA, `stations/${SID}/attendance/att_ffb_b`)));

await ok('מפקד תחנה רואה את שלוש המשמרות',
  getDoc(doc(stCmd, `stations/${SID}/attendance/att_ffb_b`)));

await ok('רכז כוח אדם רואה הכל',
  getDoc(doc(hrUser, `stations/${SID}/attendance/att_ffb_b`)));

await ok('מפקד שטרם שויך למשמרת רואה הכל — מכוון, לא באג',
  getDoc(doc(cmdNew, `stations/${SID}/attendance/att_ffb_b`)));

await blocked('🔒 כבאי מתחנה אחרת קורא נוכחות באילת',
  getDoc(doc(outside, `stations/${SID}/attendance/att_ff_a`)));

await blocked('🔒 מבקר לא מחובר קורא נוכחות',
  getDoc(doc(anon, `stations/${SID}/attendance/att_ff_a`)));

// ============================================================
head('2 · פרופיל משתמש — הסלמת הרשאות');
// ============================================================
// זו דרך המתקפה הכי מפתה: לשנות לעצמך role ל-commander.

await ok('כבאי קורא את הפרופיל של עצמו',
  getDoc(doc(ff, `stations/${SID}/users/u_ff`)));

await blocked('🔒 כבאי קורא פרופיל של כבאי אחר',
  getDoc(doc(ff, `stations/${SID}/users/u_ffb`)));

await blocked('🔒 כבאי מקדם את עצמו ל-commander',
  updateDoc(doc(ff, `stations/${SID}/users/u_ff`), { role: 'commander' }));

await blocked('🔒 כבאי מעביר את עצמו למשמרת אחרת',
  updateDoc(doc(ff, `stations/${SID}/users/u_ff`), { crew: 'ב' }));

await blocked('🔒 כבאי משנה לעצמו מספר עובד',
  updateDoc(doc(ff, `stations/${SID}/users/u_ff`), { employee_number: '999' }));

await blocked('🔒 כבאי מפעיל מחדש חשבון מושבת',
  updateDoc(doc(ff, `stations/${SID}/users/u_ff`), { is_active: false }));

await blocked('🔒 כבאי מוחק את הפרופיל שלו',
  deleteDoc(doc(ff, `stations/${SID}/users/u_ff`)));

await ok('רכז כוח אדם מעדכן פרופיל של כבאי',
  updateDoc(doc(hrUser, `stations/${SID}/users/u_ff`), { full_name: 'שם חדש' }));

// ============================================================
head('3 · ספריית הכבאים — למה "מחובר" אינו "עובד"');
// ============================================================
// ההרשמה פתוחה לכל אחד. בלי ההבחנה הזו, כל אדם בעולם היה
// נרשם בכתובת חד-פעמית וקורא שם, תפקיד ומשמרת של כל כבאי.

await ok('כבאי מאושר קורא את הספרייה',
  getDoc(doc(ff, 'directory/u_ff')));

await blocked('🔒 נרשם שטרם אושר קורא את הספרייה',
  getDoc(doc(pending, 'directory/u_ff')));

await blocked('🔒 מבקר לא מחובר קורא את הספרייה',
  getDoc(doc(anon, 'directory/u_ff')));

await blocked('🔒 מישהו כותב לספרייה מהדפדפן',
  setDoc(doc(ff, 'directory/u_ff'), { full_name: 'זיוף' }));

// ============================================================
head('4 · אוספים שחייבים להיות סגורים ללקוח');
// ============================================================
// תור המיילים מכיל כתובות. יומן הביקורת הוא הראיה היחידה
// מי שינה הרשאה למי. מונה הניסיונות הוא הגבלת קצב — מי
// שיכול לאפס אותו יכול לנחש קודים בלי הגבלה.

await blocked('🔒 קריאת תור המיילים',
  getDoc(doc(ff, 'mail/m1')));

await blocked('🔒 כתיבה לתור המיילים (שליחת מייל מזויף)',
  setDoc(doc(ff, 'mail/m2'), { to: ['x@y.z'] }));

await blocked('🔒 קריאת יומן כשלי המיילים',
  getDoc(doc(ff, 'mail_failures/f1')));

await blocked('🔒 קריאת יומן שינויי ההרשאות בידי כבאי',
  getDoc(doc(ff, 'admin_audit/e1')));

await ok('מנהל-על קורא את יומן שינויי ההרשאות',
  getDoc(doc(superA, 'admin_audit/e1')));

await blocked('🔒 מנהל-על כותב ליומן הביקורת מהדפדפן',
  setDoc(doc(superA, 'admin_audit/e2'), { what: 'זיוף' }));

await blocked('🔒 איפוס מונה ניסיונות הכניסה',
  setDoc(doc(ff, 'join_attempts/u_ff'), { n: 0 }));

await blocked('🔒 קריאת אינדקס מספרי העובדים',
  getDoc(doc(ff, 'emp_index/101')));

await blocked('🔒 קריאת יומן ההתראות שהושתקו',
  getDoc(doc(hrUser, 'silenced/s1')));

// ============================================================
head('5 · מצב המערכת — ניסוי מול חי');
// ============================================================
// config/mode נקרא בידי כולם בכוונה: בלעדיו מפקד ששולח
// קריאת פתע במצב ניסוי לא רואה פס אזהרה, ומסיק שההזעקה
// שבורה. config/runtime נשאר סגור — הוא מכיל את דגל ההשתקה.

await ok('כבאי קורא את מצב המערכת',
  getDoc(doc(ff, 'config/mode')));

await blocked('🔒 כבאי משנה את מצב המערכת',
  setDoc(doc(ff, 'config/mode'), { mode: 'test' }));

await blocked('🔒 קריאת config/runtime — דגל ההשתקה',
  getDoc(doc(hrUser, 'config/runtime')));

await blocked('🔒 השתקת התראות התחנה מהדפדפן',
  setDoc(doc(hrUser, 'config/runtime'), { silent: true }));

// ============================================================
head('6 · מזהי מכשיר להתראות');
// ============================================================
// מזהה מכשיר הוא מפתח לשליחת התראה לטלפון מסוים. דליפה
// מאפשרת לשלוח הודעות בשם המערכת.

await ok('כבאי קורא את מזהה המכשיר של עצמו',
  getDoc(doc(ff, `stations/${SID}/push_tokens/u_ff`)));

await blocked('🔒 כבאי קורא מזהה מכשיר של כבאי אחר',
  getDoc(doc(ffB, `stations/${SID}/push_tokens/u_ff`)));

await blocked('🔒 כבאי כותב מזהה מכשיר לכבאי אחר',
  setDoc(doc(ffB, `stations/${SID}/push_tokens/u_ff`), { token: 'זיוף' }));

// ============================================================
head('7 · הפרדה בין תחנות');
// ============================================================
// המערכת מתוכננת להרחבה לתחנות נוספות. דליפה בין תחנות
// היא באג שיתגלה רק כשתחנה שנייה תצטרף — ואז זה יהיה מאוחר.

await blocked('🔒 כבאי מתחנה אחרת קורא את מסמך תחנת אילת',
  getDoc(doc(outside, `stations/${SID}`)));

await blocked('🔒 כבאי מתחנה אחרת קורא פרופילים באילת',
  getDoc(doc(outside, `stations/${SID}/users/u_ff`)));

await blocked('🔒 כבאי מתחנה אחרת כותב נוכחות באילת',
  setDoc(doc(outside, `stations/${SID}/attendance/x`),
    { emp_number: '999', crew: 'א', status: 'draft' }));

// ============================================================
head('8 · כללי שכר וברירת המחדל');
// ============================================================

await ok('כבאי מאושר קורא את כללי השכר',
  getDoc(doc(ff, 'salary_rules/v1')));

await blocked('🔒 כבאי משנה כללי שכר',
  setDoc(doc(ff, 'salary_rules/v1'), { rate: 999 }));

await ok('מנהל-על משנה כללי שכר',
  setDoc(doc(superA, 'salary_rules/v1'), { rate: 2 }));

// הכלל האחרון בקובץ הוא allow read, write: if false על הכל.
// בלעדיו, כל נתיב שנשכח נשאר פתוח לרווחה.
await blocked('🔒 נתיב שלא הוגדר כלל — ברירת המחדל חוסמת',
  getDoc(doc(ff, 'some_collection_nobody_defined/x')));

await blocked('🔒 כתיבה לנתיב שלא הוגדר',
  setDoc(doc(superA, 'another_undefined/x'), { a: 1 }));

// ============================================================
//  סיכום
// ============================================================
await env.cleanup();

console.log('\n\x1b[1m════════════════════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' הבדיקות עברו. הכללים תקינים.\x1b[0m');
  console.log('\x1b[2m  זו הפעם הראשונה שהכללים נבדקו מול Firestore אמיתי.\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m\n');
  failures.forEach(f => console.log('    ' + f));
  console.log('\n\x1b[1m  שורה שמתחילה ב-🔓 היא חור אבטחה: משהו שהיה');
  console.log('  אמור להיחסם ועבר. טפל בה לפני הפריסה הבאה.\x1b[0m');
}
console.log('\x1b[1m════════════════════════════════════════════════════\x1b[0m\n');

process.exit(fail === 0 ? 0 : 1);
