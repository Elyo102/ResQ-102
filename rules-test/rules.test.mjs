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
// מפקד צוות וסגנו. הסמכות היחידה שלהם היא לכתוב בלוג המשמרת —
// בכל השאר הם לוחם אש לכל דבר, וזה בדיוק מה שנבדק כאן.
const teamA   = who('u_tl',   'tl@x.com',   { emp: '111', role: 'team_leader',        stationId: SID, shift: 'א' });
const dteamA  = who('u_dtl',  'dtl@x.com',  { emp: '112', role: 'deputy_team_leader', stationId: SID, shift: 'א' });
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

  // ---- החלפות משמרת ----
  await setDoc(doc(d, `stations/${SID}/swaps/sw_open`), {
    from_uid: 'u_ff', from_crew: 'א', from_date: '2026-09-01',
    to_uid: '', to_crew: '', status: 'open' });
  await setDoc(doc(d, `stations/${SID}/swaps/sw_peer`), {
    from_uid: 'u_ff', from_crew: 'א', from_date: '2026-09-01',
    to_uid: 'u_ffb', to_crew: 'ב', to_date: '2026-09-02', status: 'peer' });

  // ---- תקלות ----
  await setDoc(doc(d, `stations/${SID}/faults/fa_mine`), {
    by_uid: 'u_ff', by_name: 'כבאי א', title: 'תקלה', desc: 'x',
    status: 'open', kind: 'general', created_key: 'k1' });
  await setDoc(doc(d, `stations/${SID}/faults/fa_damage`), {
    by_uid: 'u_ffb', by_name: 'כבאי ב', title: 'פגיעה', desc: 'x',
    status: 'open', kind: 'damage', created_key: 'k2' });

  // ---- אבטחות ----
  await setDoc(doc(d, `stations/${SID}/guards/g_open`), {
    by_uid: 'u_cmda', title: 'אבטחה', date: '2026-09-05',
    slots: 3, assigned: [], signups: [] });
  await setDoc(doc(d, `stations/${SID}/guards/g_full`), {
    by_uid: 'u_cmda', title: 'משובצת', date: '2026-09-06',
    slots: 1, assigned: ['u_ffb'], signups: [] });

  // ---- מסמכים אישיים ----
  await setDoc(doc(d, `stations/${SID}/documents/doc_mine`),
    { emp_number: '101', name: 'תלוש.pdf' });
  await setDoc(doc(d, `stations/${SID}/documents/doc_other`),
    { emp_number: '102', name: 'תלוש-של-אחר.pdf' });

  // ---- הודעות ----
  await setDoc(doc(d, `stations/${SID}/broadcasts/b1`),
    { by_uid: 'u_cmda', text: 'הודעה' });

  // ---- החלפות בשלבי המפקדים ----
  await setDoc(doc(d, `stations/${SID}/swaps/sw_cmdfrom`), {
    from_uid: 'u_ff', from_crew: 'א', from_date: '2026-09-01',
    to_uid: 'u_ffb', to_crew: 'ב', to_date: '2026-09-02',
    status: 'cmd_from' });
  await setDoc(doc(d, `stations/${SID}/swaps/sw_cmdto`), {
    from_uid: 'u_ff', from_crew: 'א', from_date: '2026-09-01',
    to_uid: 'u_ffb', to_crew: 'ב', to_date: '2026-09-02',
    status: 'cmd_to', from_appr_uid: 'u_cmda' });

  // ---- חתימות שמורות ----
  await setDoc(doc(d, `stations/${SID}/signatures/u_ff`),
    { image: 'data:image/png;base64,' + 'A'.repeat(400),
      full_name: 'כבאי א', emp_number: '101' });

  // ---- לוג המשמרת ----
  await setDoc(doc(d, `stations/${SID}/shift_log/lg_cmd`), {
    text: 'בוקר טוב, שני אנשים חסרים היום.', kind: 'chat',
    by_uid: 'u_cmda', by_name: 'מפקד א', by_role: 'commander',
    by_crew: 'א', hidden: false,
    created_key: '2026-08-25T06:00:00.000Z' });
  await setDoc(doc(d, `stations/${SID}/shift_log/lg_sys`), {
    text: '✅ ההחלפה אושרה.', kind: 'system',
    by_uid: '', by_name: 'המערכת', hidden: false,
    created_key: '2026-08-25T06:05:00.000Z' });

  // ---- טפסים ----
  const empSig = { image: 'data:image/png;base64,' + 'A'.repeat(400),
                   uid: 'u_ff', name: 'כבאי א', emp: '101',
                   role: 'firefighter', at: '2026-08-20T08:00:00.000Z' };

  // חופשה בארץ — שתי חתימות ודי.
  await setDoc(doc(d, `stations/${SID}/submissions/sub_home`), {
    form_id: 'leave', form_he: 'בקשת חופשה', kind: 'vacation',
    values: { from: '2026-09-10', to: '2026-09-12', where: 'בארץ' },
    signature: empSig.image, signatures: { employee: empSig },
    is_private: false, status: 'submitted',
    by_uid: 'u_ff', by_name: 'כבאי א', by_emp: '101', crew: 'א',
    created_key: '2026-08-20T08:00:00.000Z' });

  // חופשה בחו"ל — מחייבת גם את מפקד התחנה.
  await setDoc(doc(d, `stations/${SID}/submissions/sub_abroad`), {
    form_id: 'leave', form_he: 'בקשת חופשה', kind: 'vacation',
    values: { from: '2026-09-10', to: '2026-09-20', where: 'בחו״ל' },
    signature: empSig.image, signatures: { employee: empSig },
    is_private: false, status: 'submitted',
    by_uid: 'u_ff', by_name: 'כבאי א', by_emp: '101', crew: 'א',
    created_key: '2026-08-20T08:00:00.000Z' });

  // אותה בקשה, אחרי שראש המשמרת חתם והעביר הלאה.
  await setDoc(doc(d, `stations/${SID}/submissions/sub_at_station`), {
    form_id: 'leave', form_he: 'בקשת חופשה', kind: 'vacation',
    values: { from: '2026-09-10', to: '2026-09-20', where: 'בחו״ל' },
    signature: empSig.image,
    signatures: { employee: empSig,
                  commander: { image: empSig.image, uid: 'u_cmda',
                               name: 'מפקד א', emp: '201',
                               role: 'commander', at: '2026-08-21T08:00:00.000Z' } },
    is_private: false, status: 'pending_station',
    by_uid: 'u_ff', by_name: 'כבאי א', by_emp: '101', crew: 'א',
    created_key: '2026-08-20T08:00:00.000Z' });

  // בקשה שראש המשמרת עצמו הגיש.
  await setDoc(doc(d, `stations/${SID}/submissions/sub_by_cmd`), {
    form_id: 'leave', form_he: 'בקשת חופשה', kind: 'vacation',
    values: { from: '2026-09-10', to: '2026-09-12', where: 'בארץ' },
    signature: empSig.image, signatures: { employee: empSig },
    is_private: false, status: 'submitted',
    by_uid: 'u_cmda', by_name: 'מפקד א', by_emp: '201', crew: 'א',
    created_key: '2026-08-20T08:00:00.000Z' });
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
head('9 · החלפות משמרת');
// ============================================================
// החלפה מזיזה משמרת של שני אנשים. זיוף כאן הוא שינוי סידור
// העבודה של התחנה, ובעקיפין גם של השכר.

await ok('כבאי מפרסם בקשת החלפה פתוחה',
  setDoc(doc(ff, `stations/${SID}/swaps/new_open`), {
    from_uid: 'u_ff', from_crew: 'א', from_date: '2026-09-10',
    to_uid: '', to_crew: '', status: 'open' }));

await blocked('🔒 כבאי מפרסם בקשה בשם כבאי אחר',
  setDoc(doc(ff, `stations/${SID}/swaps/forge`), {
    from_uid: 'u_ffb', from_crew: 'ב', from_date: '2026-09-10',
    to_uid: '', to_crew: '', status: 'open' }));

await blocked('🔒 כבאי יוצר החלפה שכבר מאושרת',
  setDoc(doc(ff, `stations/${SID}/swaps/pre`), {
    from_uid: 'u_ff', from_crew: 'א', from_date: '2026-09-10',
    to_uid: 'u_ffb', to_crew: 'ב', status: 'approved' }));

await blocked('🔒 כבאי לוקח את הבקשה הפתוחה של עצמו',
  updateDoc(doc(ff, `stations/${SID}/swaps/sw_open`), {
    status: 'cmd_from', to_uid: 'u_ff', to_date: '2026-09-03', to_crew: 'א' }));

await ok('כבאי אחר לוקח בקשה פתוחה',
  updateDoc(doc(ffB, `stations/${SID}/swaps/sw_open`), {
    status: 'cmd_from', to_uid: 'u_ffb', to_date: '2026-09-03', to_crew: 'ב' }));

await blocked('🔒 מי שלוקח משנה את התאריך של המבקש',
  updateDoc(doc(ffB, `stations/${SID}/swaps/sw_peer`), {
    status: 'cmd_from', from_date: '2026-12-31' }));

await blocked('🔒 הצד השני מאשר סופית במקום המפקד',
  updateDoc(doc(ffB, `stations/${SID}/swaps/sw_peer`), { status: 'approved' }));

// התאריכים הם כל העניין בהחלפה. מי שיכול לשנות אותם בשלב
// אישור הופך את מה שאושר למשהו אחר ממה שהוגש — וזה בדיוק
// החור שהבדיקה מצאה ב-25.8.2026, בשלושה ענפים בבת אחת.

await blocked('🔒 מפקד המשמרת הראשון משנה תאריך תוך כדי אישור',
  updateDoc(doc(cmdA, `stations/${SID}/swaps/sw_cmdfrom`), {
    status: 'cmd_to', from_date: '2026-12-31' }));

await ok('מפקד המשמרת הראשון מאשר בלי לשנות',
  updateDoc(doc(cmdA, `stations/${SID}/swaps/sw_cmdfrom`), { status: 'cmd_to' }));

await blocked('🔒 מפקד המשמרת השני משנה תאריך תוך כדי אישור',
  updateDoc(doc(cmdB, `stations/${SID}/swaps/sw_cmdto`), {
    status: 'approved', to_date: '2026-12-31' }));

await blocked('🔒 אותו מפקד מאשר את שני השלבים לבדו',
  updateDoc(doc(cmdA, `stations/${SID}/swaps/sw_cmdto`), { status: 'approved' }));

await ok('מפקד המשמרת השנייה מאשר סופית',
  updateDoc(doc(cmdB, `stations/${SID}/swaps/sw_cmdto`), { status: 'approved' }));

await blocked('🔒 כבאי מתחנה אחרת קורא החלפות באילת',
  getDoc(doc(outside, `stations/${SID}/swaps/sw_open`)));

// ============================================================
head('10 · תקלות וחפיפת משמרת');
// ============================================================
// החומרה נקבעת בידי ראש המשמרת ולא בידי המדווח. תקלה רגילה
// נסגרת ונשארת בהיסטוריה; רק פגיעת רכב שתוקנה נמחקת.

await ok('כבאי מדווח תקלה',
  setDoc(doc(ff, `stations/${SID}/faults/new_f`), {
    by_uid: 'u_ff', by_name: 'כבאי א', title: 'ברז דולף',
    desc: 'תיאור', status: 'open', kind: 'general' }));

await blocked('🔒 כבאי מדווח תקלה בשם מישהו אחר',
  setDoc(doc(ff, `stations/${SID}/faults/forge_f`), {
    by_uid: 'u_ffb', by_name: 'כבאי ב', title: 'זיוף',
    desc: '', status: 'open', kind: 'general' }));

await blocked('🔒 תקלה נפתחת ישר כסגורה',
  setDoc(doc(ff, `stations/${SID}/faults/closed_f`), {
    by_uid: 'u_ff', by_name: 'כבאי א', title: 'תקלה',
    desc: '', status: 'closed', kind: 'general' }));

await blocked('🔒 כותרת ארוכה מהמותר',
  setDoc(doc(ff, `stations/${SID}/faults/long_f`), {
    by_uid: 'u_ff', by_name: 'כבאי א', title: 'א'.repeat(120),
    desc: '', status: 'open', kind: 'general' }));

await blocked('🔒 כבאי משכתב את המדווח בתקלה קיימת',
  updateDoc(doc(ff, `stations/${SID}/faults/fa_mine`), { by_uid: 'u_ffb' }));

await blocked('🔒 כבאי משנה כותרת של תקלה קיימת',
  updateDoc(doc(ff, `stations/${SID}/faults/fa_mine`), { title: 'אחרת' }));

await blocked('🔒 כבאי עורך תקלה של כבאי אחר',
  updateDoc(doc(ff, `stations/${SID}/faults/fa_damage`), { status: 'closed' }));

await blocked('🔒 כבאי מוחק תקלה',
  deleteDoc(doc(ff, `stations/${SID}/faults/fa_mine`)));

await blocked('🔒 ראש משמרת מוחק תקלה רגילה (סוגרים, לא מוחקים)',
  deleteDoc(doc(cmdA, `stations/${SID}/faults/fa_mine`)));

await ok('ראש משמרת מוחק פגיעת רכב שתוקנה',
  deleteDoc(doc(cmdA, `stations/${SID}/faults/fa_damage`)));

// ============================================================
head('11 · אבטחות');
// ============================================================
// השיבוץ נקבע בשרת לפי חלוקת עומס הוגנת. כתיבה ישירה לשדה
// assigned מהדפדפן היא עקיפה של החלוקה הזו.

await blocked('🔒 כבאי פותח אבטחה (רק סגל)',
  setDoc(doc(ff, `stations/${SID}/guards/g_new`), {
    by_uid: 'u_ff', title: 'אבטחה', date: '2026-09-09',
    slots: 2, assigned: [] }));

await blocked('🔒 אבטחה נפתחת עם משובצים מראש',
  setDoc(doc(cmdA, `stations/${SID}/guards/g_pre`), {
    by_uid: 'u_cmda', title: 'אבטחה', date: '2026-09-09',
    slots: 2, assigned: ['u_ff'] }));

await blocked('🔒 מספר מקומות בלתי סביר',
  setDoc(doc(cmdA, `stations/${SID}/guards/g_many`), {
    by_uid: 'u_cmda', title: 'אבטחה', date: '2026-09-09',
    slots: 500, assigned: [] }));

await blocked('🔒 שיבוץ עצמי ישיר לשדה assigned',
  updateDoc(doc(ff, `stations/${SID}/guards/g_open`), { assigned: ['u_ff'] }));

await blocked('🔒 סגל משנה שיבוץ באבטחה שכבר משובצת',
  updateDoc(doc(cmdA, `stations/${SID}/guards/g_full`), { assigned: [] }));

await ok('כל חבר תחנה רואה את לוח האבטחות',
  getDoc(doc(ff, `stations/${SID}/guards/g_open`)));

// ============================================================
head('12 · מסמכים אישיים');
// ============================================================
// כאן יושבים תלושי שכר. זו הדליפה שהכי קל לעשות בטעות.

await ok('כבאי קורא מסמך של עצמו',
  getDoc(doc(ff, `stations/${SID}/documents/doc_mine`)));

await blocked('🔒 כבאי קורא מסמך של כבאי אחר',
  getDoc(doc(ff, `stations/${SID}/documents/doc_other`)));

await blocked('🔒 ראש משמרת קורא מסמך אישי של כבאי',
  getDoc(doc(cmdA, `stations/${SID}/documents/doc_other`)));

await ok('רכז כוח אדם קורא מסמכים',
  getDoc(doc(hrUser, `stations/${SID}/documents/doc_other`)));

await blocked('🔒 כבאי מעלה מסמך על שם מספר עובד אחר',
  setDoc(doc(ff, `stations/${SID}/documents/d_forge`), { emp_number: '102' }));

await blocked('🔒 כבאי מוחק מסמך של עצמו',
  deleteDoc(doc(ff, `stations/${SID}/documents/doc_mine`)));

// ============================================================
head('13 · הודעות תחנה');
// ============================================================
// הודעה לכל המשמרת היא פעולה ניהולית. הכלל מונע תיעוד מזויף.

await ok('חבר תחנה קורא הודעות',
  getDoc(doc(ff, `stations/${SID}/broadcasts/b1`)));

await blocked('🔒 שליחת הודעה בשם מישהו אחר',
  setDoc(doc(ff, `stations/${SID}/broadcasts/b_forge`), {
    by_uid: 'u_cmda', text: 'הודעה מזויפת' }));

await blocked('🔒 כבאי מתחנה אחרת קורא הודעות',
  getDoc(doc(outside, `stations/${SID}/broadcasts/b1`)));

// ============================================================
head('14 · חתימה שמורה');
// ============================================================
// חתימה שמישהו אחר יכול לכתוב אינה חתימה. זו הנקודה היחידה
// במערכת שבה גם מנהל-על אינו רשאי לכתוב — הוא יכול למחוק
// חתימה שגויה, אבל לא להחליף חתימה של אדם בשלו.

const SIG = 'data:image/png;base64,' + 'A'.repeat(400);

await ok('כבאי קורא את החתימה של עצמו',
  getDoc(doc(ff, `stations/${SID}/signatures/u_ff`)));

await blocked('🔒 כבאי קורא חתימה של כבאי אחר',
  getDoc(doc(ffB, `stations/${SID}/signatures/u_ff`)));

await blocked('🔒 ראש משמרת קורא חתימה שמורה של כבאי',
  getDoc(doc(cmdA, `stations/${SID}/signatures/u_ff`)));

await blocked('🔒 רכזת כוח אדם קוראת חתימה שמורה',
  getDoc(doc(hrUser, `stations/${SID}/signatures/u_ff`)));

await ok('כבאי שומר את החתימה של עצמו',
  setDoc(doc(ff, `stations/${SID}/signatures/u_ff`),
    { image: SIG, full_name: 'כבאי א', emp_number: '101' }));

await blocked('🔒 כבאי כותב חתימה בתיק של כבאי אחר',
  setDoc(doc(ffB, `stations/${SID}/signatures/u_ff`),
    { image: SIG, full_name: 'זיוף' }));

await blocked('🔒 ראש משמרת כותב חתימה בשם כבאי',
  setDoc(doc(cmdA, `stations/${SID}/signatures/u_ff`),
    { image: SIG, full_name: 'זיוף' }));

await blocked('🔒 גם מנהל-על אינו כותב חתימה של אדם אחר',
  setDoc(doc(superA, `stations/${SID}/signatures/u_ff`),
    { image: SIG, full_name: 'זיוף' }));

await blocked('🔒 חתימה ריקה',
  setDoc(doc(ffB, `stations/${SID}/signatures/u_ffb`), { image: '' }));

await blocked('🔒 חתימה כבדה מהמותר',
  setDoc(doc(ffB, `stations/${SID}/signatures/u_ffb`),
    { image: 'd'.repeat(500000) }));

await blocked('🔒 מבקר לא מחובר קורא חתימות',
  getDoc(doc(anon, `stations/${SID}/signatures/u_ff`)));

await ok('מנהל-על מוחק חתימה שגויה',
  deleteDoc(doc(superA, `stations/${SID}/signatures/u_ff`)));

// ============================================================
head('15 · טפסים — שרשרת האישורים');
// ============================================================
// אישור הוא חתימה, ולחתימה יש סדר. שלושה דברים נבדקים כאן:
// שאיש אינו מאשר לעצמו, שחופשה בחו"ל אינה נסגרת בלי מפקד
// התחנה, ושמי שמאשר אינו עורך את מה שהוגש.

const CSIG = { image: 'data:image/png;base64,' + 'B'.repeat(400),
               uid: 'u_cmda', name: 'מפקד א', emp: '201',
               role: 'commander', at: '2026-08-22T08:00:00.000Z' };

await ok('ראש משמרת מאשר חופשה בארץ של כבאי במשמרתו',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_home`), {
    status: 'approved', signatures: { employee: { image: 'data:image/png;base64,' + 'A'.repeat(400),
      uid: 'u_ff', name: 'כבאי א', emp: '101', role: 'firefighter',
      at: '2026-08-20T08:00:00.000Z' }, commander: CSIG } }));

await blocked('🔒 ראש משמרת ממשמרת אחרת מאשר',
  updateDoc(doc(cmdB, `stations/${SID}/submissions/sub_abroad`), { status: 'approved' }));

await blocked('🔒 כבאי מאשר טופס',
  updateDoc(doc(ffB, `stations/${SID}/submissions/sub_abroad`), { status: 'approved' }));

await blocked('🔒 המגיש מאשר לעצמו',
  updateDoc(doc(ff, `stations/${SID}/submissions/sub_abroad`), { status: 'approved' }));

await blocked('🔒 ראש משמרת מאשר בקשה שהוא עצמו הגיש',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_by_cmd`), { status: 'approved' }));

await ok('מפקד התחנה מאשר בקשה שראש המשמרת הגיש',
  updateDoc(doc(stCmd, `stations/${SID}/submissions/sub_by_cmd`), { status: 'approved' }));

// ---- החריג של חו"ל ----

await blocked('🔓 🔒 ראש משמרת סוגר לבדו חופשה בחו״ל',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_abroad`), { status: 'approved' }));

await ok('ראש משמרת חותם ומעביר חופשת חו״ל למפקד התחנה',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_abroad`), {
    status: 'pending_station', signatures: { commander: CSIG } }));

await blocked('🔒 ראש משמרת מאשר בקשה שכבר אצל מפקד התחנה',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_at_station`), { status: 'approved' }));

await blocked('🔒 סגן ראש משמרת מאשר בקשה שאצל מפקד התחנה',
  updateDoc(doc(deputyA, `stations/${SID}/submissions/sub_at_station`), { status: 'approved' }));

await ok('מפקד התחנה מאשר חופשת חו״ל שהועברה אליו',
  updateDoc(doc(stCmd, `stations/${SID}/submissions/sub_at_station`), { status: 'approved' }));

// ---- מה שנעול בזמן האישור ----

await blocked('🔒 המאשר משנה את תאריכי החופשה',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_by_cmd`), {
    status: 'approved', values: { from: '2026-09-01', to: '2026-09-30', where: 'בארץ' } }));

await blocked('🔒 המאשר מחליף את חתימת הכבאי',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_by_cmd`), {
    status: 'approved',
    signatures: { employee: { image: 'data:image/png;base64,' + 'Z'.repeat(400),
                              uid: 'u_cmda', name: 'זיוף' } } }));

await blocked('🔒 המאשר מעביר את הטופס למשמרת אחרת',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_by_cmd`), {
    status: 'approved', crew: 'ב' }));

await blocked('🔒 המאשר מחליף את זהות המגיש',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_by_cmd`), {
    status: 'approved', by_uid: 'u_ffb' }));

await blocked('🔒 חתימת מפקד כבדה מהמותר',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_by_cmd`), {
    status: 'approved', signatures: { commander: { image: 'z'.repeat(500000) } } }));

// ---- הגשה ----

await ok('כבאי מגיש טופס חתום בשמו',
  setDoc(doc(ff, `stations/${SID}/submissions/sub_new_ok`), {
    form_id: 'noclock', kind: 'missed_punch', values: { date: '2026-09-01' },
    signature: 'data:image/png;base64,' + 'A'.repeat(400),
    signatures: { employee: { image: 'data:image/png;base64,' + 'A'.repeat(400),
                              uid: 'u_ff', name: 'כבאי א' } },
    status: 'submitted', by_uid: 'u_ff', crew: 'א', is_private: false }));

await blocked('🔒 כבאי מגיש טופס בשם כבאי אחר',
  setDoc(doc(ff, `stations/${SID}/submissions/sub_new_bad`), {
    form_id: 'noclock', values: {}, status: 'submitted', by_uid: 'u_ffb', crew: 'ב' }));

await blocked('🔒 כבאי מגיש טופס שכבר חתום בידי מפקד',
  setDoc(doc(ff, `stations/${SID}/submissions/sub_new_pre`), {
    form_id: 'leave', values: {}, status: 'submitted', by_uid: 'u_ff', crew: 'א',
    signatures: { employee: { image: 'x' }, commander: CSIG } }));

await blocked('🔒 כבאי מגיש טופס שנולד מאושר',
  setDoc(doc(ff, `stations/${SID}/submissions/sub_new_appr`), {
    form_id: 'leave', values: {}, status: 'approved', by_uid: 'u_ff', crew: 'א' }));

// ============================================================
head('16 · לוג המשמרת — קורא כולם, כותב הפיקוד');
// ============================================================
// זה בא להחליף קבוצת ווטסאפ שבה מתנהל תיאום אמיתי. שתי
// הנקודות שחייבות להחזיק: שלוחם אש קורא ולא כותב, ושאף
// אחד — כולל מי שכתב — אינו יכול לשנות הודעה בדיעבד.

const LOGMSG = (uid, extra) => Object.assign({
  text: 'הודעה', kind: 'chat', by_uid: uid, by_name: 'מישהו',
  by_role: 'commander', by_crew: 'א', hidden: false,
  created_key: '2026-08-25T07:00:00.000Z'
}, extra || {});

// ---- קריאה ----

await ok('לוחם אש קורא את הלוג',
  getDoc(doc(ff, `stations/${SID}/shift_log/lg_cmd`)));

await ok('לוחם אש ממשמרת אחרת קורא את הלוג',
  getDoc(doc(ffB, `stations/${SID}/shift_log/lg_cmd`)));

await ok('מפקד צוות קורא את הלוג',
  getDoc(doc(teamA, `stations/${SID}/shift_log/lg_cmd`)));

await blocked('🔒 מי שאינו בתחנה אינו קורא את הלוג',
  getDoc(doc(outside, `stations/${SID}/shift_log/lg_cmd`)));

await blocked('🔒 מבקר לא מחובר אינו קורא את הלוג',
  getDoc(doc(anon, `stations/${SID}/shift_log/lg_cmd`)));

await blocked('🔒 נרשם שטרם אושר אינו קורא את הלוג',
  getDoc(doc(pending, `stations/${SID}/shift_log/lg_cmd`)));

// ---- כתיבה ----

await ok('ראש משמרת כותב בלוג',
  setDoc(doc(cmdA, `stations/${SID}/shift_log/new_cmd`), LOGMSG('u_cmda')));

await ok('סגן ראש משמרת כותב בלוג',
  setDoc(doc(deputyA, `stations/${SID}/shift_log/new_dep`), LOGMSG('u_dep')));

await ok('מפקד צוות כותב בלוג',
  setDoc(doc(teamA, `stations/${SID}/shift_log/new_tl`),
    LOGMSG('u_tl', { by_role: 'team_leader' })));

await ok('סגן מפקד צוות כותב בלוג',
  setDoc(doc(dteamA, `stations/${SID}/shift_log/new_dtl`),
    LOGMSG('u_dtl', { by_role: 'deputy_team_leader' })));

await ok('מפקד התחנה כותב בלוג',
  setDoc(doc(stCmd, `stations/${SID}/shift_log/new_st`), LOGMSG('u_st')));

await blocked('🔒 לוחם אש כותב בלוג',
  setDoc(doc(ff, `stations/${SID}/shift_log/new_ff`), LOGMSG('u_ff')));

await blocked('🔒 מי שאינו בתחנה כותב בלוג',
  setDoc(doc(outside, `stations/${SID}/shift_log/new_out`), LOGMSG('u_out')));

await blocked('🔒 כתיבה בשם אדם אחר',
  setDoc(doc(cmdA, `stations/${SID}/shift_log/new_fake`), LOGMSG('u_cmdb')));

await blocked('🔒 הודעה ריקה',
  setDoc(doc(cmdA, `stations/${SID}/shift_log/new_empty`),
    LOGMSG('u_cmda', { text: '' })));

await blocked('🔒 הודעה ארוכה מהמותר',
  setDoc(doc(cmdA, `stations/${SID}/shift_log/new_long`),
    LOGMSG('u_cmda', { text: 'א'.repeat(2500) })));

await blocked('🔒 בלי חותמת זמן',
  setDoc(doc(cmdA, `stations/${SID}/shift_log/new_nokey`),
    LOGMSG('u_cmda', { created_key: '' })));

// ההודעה שאיש לא מפקפק בה. מפקד שמסמן את הודעתו כ"מערכת"
// מתחזה למקור אוטומטי — ולכן זה חסום גם למי שכן רשאי לכתוב.
await blocked('🔒 מפקד מזייף הודעת מערכת',
  setDoc(doc(cmdA, `stations/${SID}/shift_log/new_sys`),
    LOGMSG('u_cmda', { kind: 'system' })));

// ---- אין עריכה ואין מחיקה ----

await blocked('🔒 מפקד עורך הודעה שכתב בעצמו',
  updateDoc(doc(cmdA, `stations/${SID}/shift_log/lg_cmd`), { text: 'משהו אחר' }));

await blocked('🔒 מפקד עורך הודעה של מפקד אחר',
  updateDoc(doc(cmdB, `stations/${SID}/shift_log/lg_cmd`), { text: 'משהו אחר' }));

await blocked('🔒 מפקד מוחק הודעה מהלוג',
  deleteDoc(doc(cmdA, `stations/${SID}/shift_log/lg_cmd`)));

await blocked('🔒 לוחם אש מוחק הודעה מהלוג',
  deleteDoc(doc(ff, `stations/${SID}/shift_log/lg_cmd`)));

await blocked('🔒 גם מנהל-על אינו משנה טקסט של הודעה',
  updateDoc(doc(superA, `stations/${SID}/shift_log/lg_cmd`), { text: 'שוכתב' }));

await ok('מנהל-על מסתיר הודעה פוגענית',
  updateDoc(doc(superA, `stations/${SID}/shift_log/lg_cmd`), { hidden: true }));

await ok('מנהל-על מוחק הודעה',
  deleteDoc(doc(superA, `stations/${SID}/shift_log/lg_sys`)));

// ============================================================
head('17 · מפקד צוות — כל השאר נשאר סגור');
// ============================================================
// התפתיתי לתת לו סמכויות כי השם נשמע פיקודי. אלדד הגדיר
// במפורש: רק כתיבה בלוג. הבדיקות האלה הן מה שימנע מהתפקיד
// הזה לזחול לסמכויות נוספות בעדכון עתידי.

await blocked('🔒 מפקד צוות קורא נוכחות של כבאי אחר',
  getDoc(doc(teamA, `stations/${SID}/attendance/att_ffb_b`)));

await blocked('🔒 מפקד צוות מאשר דוח שעות',
  updateDoc(doc(teamA, `stations/${SID}/attendance/att_ff_a`), { status: 'approved' }));

await blocked('🔒 מפקד צוות מאשר טופס',
  updateDoc(doc(teamA, `stations/${SID}/submissions/sub_abroad`), { status: 'approved' }));

await blocked('🔒 מפקד צוות מאשר החלפת משמרת',
  updateDoc(doc(teamA, `stations/${SID}/swaps/sw_cmdfrom`), { status: 'cmd_to' }));

await blocked('🔒 מפקד צוות משנה תפקיד של עצמו',
  updateDoc(doc(teamA, `stations/${SID}/users/u_ff`), { role: 'commander' }));

await blocked('🔒 מפקד צוות קורא מסמך אישי של אחר',
  getDoc(doc(teamA, `stations/${SID}/documents/doc_other`)));

await blocked('🔒 מפקד צוות קורא חתימה שמורה של כבאי',
  getDoc(doc(teamA, `stations/${SID}/signatures/u_ffb`)));

await ok('מפקד צוות כן רואה את הסידור',
  getDoc(doc(teamA, `stations/${SID}/roster/u_ff`)).catch(() => null)
    .then(() => getDocs(collection(teamA, `stations/${SID}/broadcasts`))));

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
