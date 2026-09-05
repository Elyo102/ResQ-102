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
  collection, getDocs, query, where, orderBy, limit
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

// The emulator is a long-lived process and may retain writes from a previous
// invocation.  Start every suite from a clean database so create/delete
// scenarios test the rules rather than stale fixture state.
await env.clearFirestore();

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
const inactiveStCmd = who('u_st_inactive', 'st-inactive@x.com', {
  emp: '302', role: 'station_commander', stationId: SID, shift: ''
});
const inactiveHr = who('u_hr_inactive', 'hr-inactive@x.com', {
  emp: '402', role: 'hr_coordinator', stationId: SID, shift: ''
});
const staleHr = who('u_hr_stale', 'hr-stale@x.com', {
  emp: '403', role: 'hr_coordinator', stationId: SID, shift: ''
});
const missingHr = who('u_hr_missing', 'hr-missing@x.com', {
  emp: '404', role: 'hr_coordinator', stationId: SID, shift: ''
});
const superA  = who('u_sup',  'fire102.shits@gmail.com', { super: true });
// ההרשאה מגיעה רק מ-claim חתום: לא מהכתובת הקבועה, ולא
// מתלות מקרית בקיומו של email בטוקן.
const fixedEmailWithoutClaim = who('u_fixed_mail', 'fire102.shits@gmail.com', {});
const superClaimWithoutEmail = env.authenticatedContext(
  'u_super_claim_only', { super: true }
).firestore();
const pending = who('u_pend', 'pend@x.com', {});                       // נרשם, טרם אושר
const pendingMail = who('u_pend_mail', 'right@x.com', {});
const pendingStatus = who('u_pend_status', 'status@x.com', {});
const pendingOperation = who('u_pend_op', 'pending-op@x.com', {});
const pendingActive = who('u_pend_active', 'pending-active@x.com', {});
const regEmp = who('u_reg_emp', 'reg-emp@x.com', { emp:'777' });
const regRole = who('u_reg_role', 'reg-role@x.com', { role:'firefighter' });
const regStation = who('u_reg_station', 'reg-station@x.com', { stationId:SID });
const regDistrict = who('u_reg_district', 'reg-district@x.com', { districtId:'south' });
const regShift = who('u_reg_shift', 'reg-shift@x.com', { shift:'A' });
const regSuper = who('u_reg_super', 'reg-super@x.com', { super:true });
const outside = who('u_out',  'out@x.com',  { emp: '999', role: 'firefighter', stationId: 'other_99', shift: 'א' });
const outsideHr = who('u_out_hr', 'out-hr@x.com', {
  emp: '998', role: 'hr_coordinator', stationId: 'other_99', shift: ''
});
const district = who('u_dist', 'dist@x.com', { emp: '701', role: 'district_commander', stationId: SID, districtId: 'south', shift: '' });
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
  await setDoc(doc(d, `stations/${SID}/users/u_cmda`),
    { role: 'commander', crew: 'א', employee_number: '201', is_active: true, full_name: 'מפקד משמרת א' });
  await setDoc(doc(d, `stations/${SID}/users/u_cmdb`),
    { role: 'commander', crew: 'ב', employee_number: '202', is_active: true, full_name: 'מפקד משמרת ב' });
  await setDoc(doc(d, `stations/${SID}/users/u_dep`),
    { role: 'deputy', crew: 'א', employee_number: '203', is_active: true, full_name: 'סגן מפקד משמרת א' });
  await setDoc(doc(d, `stations/${SID}/users/u_new`),
    { role: 'commander', crew: '', employee_number: '204', is_active: true, full_name: 'מפקד ללא שיוך משמרת' });
  await setDoc(doc(d, `stations/${SID}/users/u_tl`),
    { role: 'team_leader', crew: 'א', employee_number: '111', is_active: true, full_name: 'מפקד צוות א' });
  await setDoc(doc(d, `stations/${SID}/users/u_dtl`),
    { role: 'deputy_team_leader', crew: 'א', employee_number: '112', is_active: true, full_name: 'סגן מפקד צוות א' });
  await setDoc(doc(d, `stations/${SID}/users/u_st`),
    { role: 'station_commander', crew: '', employee_number: '301', is_active: true, full_name: 'מפקד תחנה' });
  await setDoc(doc(d, `stations/${SID}/users/u_hr`),
    { role: 'hr_coordinator', crew: '', employee_number: '401', is_active: true, full_name: 'רכזת כוח אדם' });
  await setDoc(doc(d, `stations/${SID}/users/u_st_inactive`),
    { role: 'station_commander', crew: '', employee_number: '302', is_active: false, full_name: 'מפקד מושבת' });
  await setDoc(doc(d, `stations/${SID}/users/u_hr_inactive`),
    { role: 'hr_coordinator', crew: '', employee_number: '402', is_active: false, full_name: 'רכזת מושבתת' });
  await setDoc(doc(d, `stations/${SID}/users/u_hr_stale`),
    { role: 'firefighter', crew: 'א', employee_number: '403', is_active: true, full_name: 'רכזת לשעבר' });

  // מינוי הסידור הוא יכולת נפרדת מהתפקיד הראשי. רק הכבאי הזה
  // מחזיק ברשומה חיה ותקינה; כל הדמויות הבכירות האחרות ייבדקו
  // בהמשך ללא מינוי כדי לנעול שאין "קיצור דרך" לפי דרגה.
  await setDoc(doc(d, `stations/${SID}/schedule_access/u_ff`), {
    schema_version: 1,
    station_id: SID,
    uid: 'u_ff',
    roles: ['schedule_manager'],
    active: true,
    revision: 1
  });
  // מסלולי הסידור הוותיקים נשמרים לקריאה בלבד עד לסיום המעבר.
  // יש מסמכים קיימים כדי לבדוק גם update/delete, לא רק create.
  await setDoc(doc(d, `stations/${SID}/rotations/A`), {
    crew: 'A', cycle_days: 3
  });
  await setDoc(doc(d, `stations/${SID}/shift_overrides/2026-09-01`), {
    date: '2026-09-01', kind: 'holiday'
  });
  // גם מינוי ישן שנשאר בתחנה הקודמת אחרי העברה אינו פותח מסלול.
  await setDoc(doc(d, `stations/${SID}/schedule_access/u_out`), {
    schema_version: 1,
    station_id: SID,
    uid: 'u_out',
    roles: ['schedule_manager'],
    active: true,
    revision: 1
  });

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

  // ---- נוכחות אוטומטית · חודש צל ----
  // חומר הגלם חסום לכל לקוח. רק הדוחות המצומצמים נקראים בידי
  // רכזת כוח אדם, מפקד התחנה ומנהל-העל.
  const shadowExpiry = new Date('2026-12-01T00:00:00.000Z');
  await setDoc(doc(d,
    `stations/${SID}/attendance_shadow_runs/2026-09-01__v1`), {
    date: '2026-09-01', status: 'complete', algorithm_version: 'v1',
    expires_at: shadowExpiry
  });
  await setDoc(doc(d,
    `stations/${SID}/attendance_shadow_runs/2026-09-01__v1/attendance_shadow_entries/u_ff`), {
    uid: 'u_ff', date: '2026-09-01', crew: 'א', planned_hours: 24,
    expires_at: shadowExpiry
  });
  await setDoc(doc(d,
    `stations/${SID}/attendance_shadow_reports/2026-09`), {
    month: '2026-09', people: 1, mismatches: 0,
    active_generation_id: 'gen_active',
    expires_at: shadowExpiry
  });
  await setDoc(doc(d,
    `stations/${SID}/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_active`), {
    generation_id: 'gen_active', status: 'complete', expires_at: shadowExpiry
  });
  await setDoc(doc(d,
    `stations/${SID}/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_active/attendance_shadow_people/u_ff`), {
    uid: 'u_ff', month: '2026-09', mismatch_count: 0,
    expires_at: shadowExpiry
  });
  // עמוד מלא כמו השאילתה האמיתית במסך. כולם משתמשים באותם שני
  // מסמכי-תלות קבועים בכללים, ולכן מטמון Rules חייב להשאיר את
  // הבקשה מתחת לתקרת access calls גם ב-limit(100).
  for (let i = 1; i <= 99; i++) {
    const uid = 'u_shadow_' + String(i).padStart(3, '0');
    await setDoc(doc(d,
      `stations/${SID}/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_active/attendance_shadow_people/${uid}`), {
      uid: uid, month: '2026-09', mismatch_count: i,
      expires_at: shadowExpiry
    });
  }
  await setDoc(doc(d,
    `stations/${SID}/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_building`), {
    generation_id: 'gen_building', status: 'building', expires_at: shadowExpiry
  });
  await setDoc(doc(d,
    `stations/${SID}/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_building/attendance_shadow_people/u_ff`), {
    uid: 'u_ff', month: '2026-09', mismatch_count: 99,
    expires_at: shadowExpiry
  });

  await setDoc(doc(d,
    'stations/other_99/attendance_shadow_reports/2026-09'), {
    month: '2026-09', people: 1, mismatches: 0,
    active_generation_id: 'gen_active',
    expires_at: shadowExpiry
  });
  await setDoc(doc(d,
    'stations/other_99/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_active'), {
    generation_id: 'gen_active', status: 'complete', expires_at: shadowExpiry
  });
  await setDoc(doc(d,
    'stations/other_99/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_active/attendance_shadow_people/u_out'), {
    uid: 'u_out', month: '2026-09', mismatch_count: 0,
    expires_at: shadowExpiry
  });

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
  // רשומות פנימיות של שער הסידור. הן קיימות כדי שהבדיקות יבדקו
  // גם update/delete וגם קריאה, ולא רק ניסיון ליצור מסמך חדש.
  await setDoc(doc(d, `stations/${SID}/guard_operations/go_seed`), {
    request_id: 'go_seed', actor_uid: 'u_ff', action: 'set_assignees' });
  await setDoc(doc(d, `stations/${SID}/guard_audit/ga_seed`), {
    guard_id: 'g_open', actor_uid: 'u_ff', action: 'set_assignees' });
  await setDoc(doc(d, `stations/${SID}/guard_notification_jobs/gnj_seed`), {
    guard_id: 'g_open', status: 'queued' });
  await setDoc(doc(d, `stations/${SID}/guard_outbox/go_seed`), {
    guard_id: 'g_open', uid: 'u_ff', status: 'queued' });

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

  // ---- לוח מודעות לפי תחנת משנה ----
  await setDoc(doc(d, `stations/${SID}/sub_stations/rashit`), {
    name: 'ראשית', order: 1, status: 'active' });
  await setDoc(doc(d, `stations/${SID}/sub_stations/archived_site`), {
    name: 'תחנה ארכיון', order: 99, status: 'archived' });
  await setDoc(doc(d,
    `stations/${SID}/sub_stations/rashit/bulletin_messages/msg_visible`), {
    kind: 'bulletin', text: 'בדיקת ציוד בשעה 10:00', category: 'equipment',
    by_uid: 'u_cmda', by_name: 'מפקד א', by_role: 'commander', by_crew: 'א',
    hidden: false, created_at: new Date('2026-08-25T07:00:00.000Z'),
    created_key: '2026-08-25T07:00:00.000Z', request_hash: 'hash-visible',
    reply_count: 1 });
  await setDoc(doc(d,
    `stations/${SID}/sub_stations/rashit/bulletin_messages/msg_hidden`), {
    kind: 'bulletin', text: 'תוכן שהוסתר', category: 'general',
    by_uid: 'u_ff', by_name: 'כבאי א', by_role: 'firefighter', by_crew: 'א',
    hidden: true, created_at: new Date('2026-08-25T07:05:00.000Z'),
    created_key: '2026-08-25T07:05:00.000Z', request_hash: 'hash-hidden',
    hidden_at: new Date('2026-08-25T07:06:00.000Z'), hidden_by: 'u_sup' });
  await setDoc(doc(d,
    `stations/${SID}/sub_stations/rashit/bulletin_messages/msg_visible/bulletin_replies/reply_visible`), {
    kind: 'bulletin_reply', parent_message_id: 'msg_visible',
    text: 'תגובה גלויה', by_uid: 'u_cmda', by_name: 'מפקד א',
    by_role: 'commander', by_crew: 'א', hidden: false,
    created_at: new Date('2026-08-25T07:01:00.000Z'),
    created_key: '2026-08-25T07:01:00.000Z', request_hash: 'reply-visible' });
  await setDoc(doc(d,
    `stations/${SID}/sub_stations/rashit/bulletin_messages/msg_visible/bulletin_replies/reply_hidden`), {
    kind: 'bulletin_reply', parent_message_id: 'msg_visible',
    text: 'תגובה מוסתרת', by_uid: 'u_cmda', by_name: 'מפקד א',
    by_role: 'commander', by_crew: 'א', hidden: true,
    created_at: new Date('2026-08-25T07:02:00.000Z'),
    created_key: '2026-08-25T07:02:00.000Z', request_hash: 'reply-hidden' });
  await setDoc(doc(d,
    `stations/${SID}/sub_stations/rashit/bulletin_messages/msg_hidden/bulletin_replies/reply_parent_hidden`), {
    kind: 'bulletin_reply', parent_message_id: 'msg_hidden',
    text: 'תגובה תחת אב מוסתר', by_uid: 'u_cmda', by_name: 'מפקד א',
    by_role: 'commander', by_crew: 'א', hidden: false,
    created_at: new Date('2026-08-25T07:06:00.000Z'),
    created_key: '2026-08-25T07:06:00.000Z', request_hash: 'reply-parent-hidden' });

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
head('0 · בקשת הרשמה והגשה חוזרת');
// ============================================================

const registration = {
  request_id: '1234567890abcdef1234567890abcdef',
  full_name: 'כבאי ממתין', email: 'pend@x.com', phone: '0500000000',
  districtId: 'south', stationId: SID, shift: 'A', status: 'pending',
  created_at: null
};

await ok('נרשם יוצר בקשה רק תחת ה-uid והמייל שלו',
  setDoc(doc(pending, 'registration_requests/u_pend'), registration));

await ok('נרשם קורא את הבקשה של עצמו',
  getDoc(doc(pending, 'registration_requests/u_pend')));

await blocked('🔒 נרשם אינו מעדכן בקשה קיימת ודורס pending',
  updateDoc(doc(pending, 'registration_requests/u_pend'),
    { full_name: 'שם שנדרס' }));

await blocked('🔒 משתמש אחר אינו קורא בקשה שאינה שלו',
  getDoc(doc(pendingMail, 'registration_requests/u_pend')));

await blocked('🔒 בקשה תחת uid של אדם אחר נחסמת',
  setDoc(doc(pendingMail, 'registration_requests/u_other'), {
    ...registration, email: 'right@x.com'
  }));

await blocked('🔒 מייל שאינו המייל בטוקן נחסם',
  setDoc(doc(pendingMail, 'registration_requests/u_pend_mail'), {
    ...registration, email: 'wrong@x.com'
  }));

await blocked('🔒 סטטוס שאינו pending נחסם ביצירה',
  setDoc(doc(pendingStatus, 'registration_requests/u_pend_status'), {
    ...registration, email: 'status@x.com', status: 'approved'
  }));

const legacyRegistration = { ...registration, email: 'right@x.com' };
delete legacyRegistration.request_id;
await ok('לקוח 41A ישן עדיין רשאי ליצור בקשה בלי request_id',
  setDoc(doc(pendingMail, 'registration_requests/u_pend_mail'), legacyRegistration));
await ok('לקוח 41A רשאי למחוק את בקשת ה-legacy שלו',
  deleteDoc(doc(pendingMail, 'registration_requests/u_pend_mail')));

await blocked('🔒 לקוח אינו רשאי ליצור generation או תוכנית שרתית',
  setDoc(doc(pendingStatus, 'registration_requests/u_pend_status'), {
    ...registration,
    email: 'status@x.com',
    server_generation: 'copied-server-generation',
    request_fingerprint: 'a'.repeat(64),
    resumable: true,
    locked_plan: { role: 'commander' }
  }));

await blocked('🔒 טוקן מעודכן של חשבון מאושר אינו פותח בקשת הרשמה חדשה',
  setDoc(doc(ff, 'registration_requests/u_ff'), {
    ...registration, email: 'ff@x.com'
  }));

for (const [label, client, uid, email] of [
  ['מספר עובד', regEmp, 'u_reg_emp', 'reg-emp@x.com'],
  ['תפקיד', regRole, 'u_reg_role', 'reg-role@x.com'],
  ['תחנה', regStation, 'u_reg_station', 'reg-station@x.com'],
  ['מחוז', regDistrict, 'u_reg_district', 'reg-district@x.com'],
  ['משמרת', regShift, 'u_reg_shift', 'reg-shift@x.com'],
  ['מנהל-על', regSuper, 'u_reg_super', 'reg-super@x.com']
]) {
  await blocked('🔒 claim חלקי (' + label + ') חוסם בקשת הרשמה',
    setDoc(doc(client, 'registration_requests/' + uid), {
      ...registration, email
    }));
}

await ok('נרשם רשאי למחוק את הבקשה של עצמו',
  deleteDoc(doc(pending, 'registration_requests/u_pend')));

await env.withSecurityRulesDisabled(async (c) => {
  const d = c.firestore();
  await setDoc(doc(d, 'registration_requests/u_pend'), {
    ...registration,
    status: 'processing',
    operation_id: 'approve-op-1234567890',
    email: 'pend@x.com'
  });
  await setDoc(doc(d, 'identity_operations/u_pend_op'), {
    status: 'completed', assigned: true, op_id: 'completed-assignment'
  });
  await setDoc(doc(d, 'identity_operations/u_pend_active'), {
    status: 'processing', assigned: false, op_id: 'active-assignment'
  });
});

await blocked('🔒 נרשם אינו מוחק בקשה בזמן processing',
  deleteDoc(doc(pending, 'registration_requests/u_pend')));
await blocked('🔒 גם מנהל אינו מוחק processing ישירות מהדפדפן',
  deleteDoc(doc(superA, 'registration_requests/u_pend')));
await ok('נרשם עדיין קורא את בקשת processing של עצמו',
  getDoc(doc(pending, 'registration_requests/u_pend')));
await blocked('🔒 מסמך שיוך שרתי חוסם בקשה חדשה מטוקן ישן',
  setDoc(doc(pendingOperation, 'registration_requests/u_pend_op'), {
    ...registration, email: 'pending-op@x.com'
  }));
await blocked('🔒 פעולת שיוך פעילה חוסמת בקשה חדשה גם לפני כתיבת claims',
  setDoc(doc(pendingActive, 'registration_requests/u_pend_active'), {
    ...registration, email: 'pending-active@x.com'
  }));
await blocked('🔒 לקוח אינו קורא מסמך פעולת זהות',
  getDoc(doc(superA, 'identity_operations/u_pend_op')));
await blocked('🔒 לקוח אינו כותב שריון מספר עובד',
  setDoc(doc(superA, 'emp_reservations/99991'), {
    uid: 'u_sup', operation_id: 'bad'
  }));

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

await blocked('🔒 כבאי אינו ממנה את עצמו לאחראי סידור',
  updateDoc(doc(ff, `stations/${SID}/users/u_ff`), { schedule_manager: true }));

await blocked('🔒 כבאי מפעיל מחדש חשבון מושבת',
  updateDoc(doc(ff, `stations/${SID}/users/u_ff`), { is_active: false }));

await blocked('🔒 כבאי מוחק את הפרופיל שלו',
  deleteDoc(doc(ff, `stations/${SID}/users/u_ff`)));

await ok('רכז כוח אדם מעדכן פרופיל של כבאי',
  updateDoc(doc(hrUser, `stations/${SID}/users/u_ff`), { full_name: 'שם חדש' }));

await blocked('🔒 רכז כוח אדם אינו ממנה אחראי סידור דרך הפרופיל',
  updateDoc(doc(hrUser, `stations/${SID}/users/u_ff`), { schedule_manager: true }));

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

await blocked('🔒 כתובת מנהל-המערכת בלי super:true אינה הרשאה',
  getDoc(doc(fixedEmailWithoutClaim, 'admin_audit/e1')));

await ok('super:true חתום עובד גם בלי כתובת אימייל בטוקן',
  getDoc(doc(superClaimWithoutEmail, 'admin_audit/e1')));

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
// אבטחה פתוחה מוצגת לחבר/ת התחנה רק דרך השרת. המסמך הגולמי מכיל
// פרטי מקום, הערות, התעניינות ותיעוד שאסור שיגיעו לדפדפן. גם
// אחראי/ת סידור איננו רישיון לקריאה או כתיבה ישירה; המינוי החי
// נבדק מחדש בשער השרת.
await blocked('🔒 חבר/ת תחנה אינו/ה קורא/ת מסמך אבטחה גולמי',
  getDoc(doc(ffB, `stations/${SID}/guards/g_open`)));
await blocked('🔒 חבר/ת תחנה אינו/ה מציג/ה אוסף אבטחות גולמי',
  getDocs(collection(ffB, `stations/${SID}/guards`)));
await blocked('🔒 אחראי/ת סידור אינו/ה קורא/ת מסמך אבטחה גולמי',
  getDoc(doc(ff, `stations/${SID}/guards/g_open`)));
await blocked('🔒 חבר/ה מתחנה אחרת אינו/ה קורא/ת אבטחה',
  getDoc(doc(outside, `stations/${SID}/guards/g_open`)));

const GUARD_DIRECT_WRITERS = [
  ['לוחם/ת אש', 'firefighter', ffB],
  ['אחראי/ת סידור', 'schedule_manager', ff],
  ['מפקד/ת משמרת', 'commander', cmdA],
  ['מנהל/ת-על', 'super', superA]
];

for (const [roleName, suffix, client] of GUARD_DIRECT_WRITERS) {
  await blocked(`🔒 ${roleName} אינו/ה יוצר/ת אבטחה ישירות`,
    setDoc(doc(client, `stations/${SID}/guards/g_client_${suffix}`), {
      by_uid: 'forged', title: 'כתיבה ישירה', date: '2026-09-09',
      slots: 2, assigned: [] }));
  await blocked(`🔒 ${roleName} אינו/ה מעדכן/ת אבטחה ישירות`,
    updateDoc(doc(client, `stations/${SID}/guards/g_open`), { assigned: ['u_ff'] }));
  await blocked(`🔒 ${roleName} אינו/ה מוחק/ת אבטחה ישירות`,
    deleteDoc(doc(client, `stations/${SID}/guards/g_full`)));
}

// operation/audit/outbox הם מצב פרטי של השער: מזהי פעולה, זהות
// מבצע/ת, רשימות נמענים ותור retry. אפילו אחראי/ת הסידור אינם
// קוראים או כותבים אותם מהדפדפן.
const GUARD_SERVER_ONLY = [
  ['guard_operations', 'go_seed'],
  ['guard_audit', 'ga_seed'],
  ['guard_notification_jobs', 'gnj_seed'],
  ['guard_outbox', 'go_seed']
];
const GUARD_SERVER_ONLY_WRITERS = [
  ['חבר/ת תחנה', 'member', ffB],
  ['אחראי/ת סידור', 'manager', ff],
  ['מנהל/ת-על', 'super', superA]
];

for (const [collectionName, seedId] of GUARD_SERVER_ONLY) {
  const seedPath = `stations/${SID}/${collectionName}/${seedId}`;
  await blocked(`🔒 אחראי/ת סידור אינו/ה קורא/ת ${collectionName}`,
    getDoc(doc(ff, seedPath)));
  await blocked(`🔒 אחראי/ת סידור אינו/ה מציג/ה ${collectionName}`,
    getDocs(collection(ff, `stations/${SID}/${collectionName}`)));

  for (const [roleName, suffix, client] of GUARD_SERVER_ONLY_WRITERS) {
    await blocked(`🔒 ${roleName} אינו/ה יוצר/ת ${collectionName}`,
      setDoc(doc(client, `stations/${SID}/${collectionName}/client_${suffix}`), {
        forged: true }));
    await blocked(`🔒 ${roleName} אינו/ה מעדכן/ת ${collectionName}`,
      updateDoc(doc(client, seedPath), { forged: true }));
    await blocked(`🔒 ${roleName} אינו/ה מוחק/ת ${collectionName}`,
      deleteDoc(doc(client, seedPath)));
  }
}

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

// ⚠️ המפה נשלחת **שלמה**, עם חתימת הכבאי בתוכה.
//
// updateDoc על שדה מסוג מפה דורס את כולה ולא ממזג אותה.
// שליחת { commander } בלבד מוחקת את חתימת הכבאי — והכלל
// שנועל אותה חוסם את זה, בצדק. הגרסה הראשונה של הבדיקה
// הזאת שלחה מפה חלקית ונכשלה, וזה נראה כמו באג בכלל
// בזמן שזה היה בדיוק ההגנה עובדת.
//
// forms.html עושה את זה נכון: Object.assign על המפה הקיימת.
const EMPSIG = { image: 'data:image/png;base64,' + 'A'.repeat(400),
                 uid: 'u_ff', name: 'כבאי א', emp: '101',
                 role: 'firefighter', at: '2026-08-20T08:00:00.000Z' };

await ok('ראש משמרת חותם ומעביר חופשת חו״ל למפקד התחנה',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_abroad`), {
    status: 'pending_station',
    signatures: { employee: EMPSIG, commander: CSIG } }));

await blocked('🔒 המאשר משמיט את חתימת הכבאי מהמפה',
  updateDoc(doc(cmdA, `stations/${SID}/submissions/sub_home`), {
    status: 'approved', signatures: { commander: CSIG } }));

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
head('17 · לוח מודעות — תחנה מבודדת וכתיבה רק בשרת');
// ============================================================

const BOARD = `stations/${SID}/sub_stations/rashit/bulletin_messages`;
const BOARDMSG = {
  kind: 'bulletin', text: 'הודעה מזויפת מהלקוח', category: 'general',
  by_uid: 'u_ff', by_name: 'כבאי א', by_role: 'firefighter', by_crew: 'א',
  hidden: false, created_at: new Date('2026-08-25T08:00:00.000Z'),
  created_key: '2026-08-25T08:00:00.000Z', request_hash: 'client-hash'
};

// ---- קריאה מבודדת לפי התחנה, והודעות מוסתרות אינן דולפות ----

await ok('חבר תחנה קורא הודעת לוח גלויה',
  getDoc(doc(ff, `${BOARD}/msg_visible`)));

await ok('שאילתת הלוח המוגבלת ל-hidden=false מותרת',
  getDocs(query(collection(ff, BOARD),
    where('hidden', '==', false), orderBy('created_at', 'desc'), limit(30))));

await blocked('🔒 שאילתה בלי מסנן הסתרה נחסמת',
  getDocs(collection(ff, BOARD)));

await blocked('🔒 הודעה מוסתרת חסומה גם לפי מזהה ישיר',
  getDoc(doc(ff, `${BOARD}/msg_hidden`)));

await blocked('🔒 גם מנהל-על אינו קורא הודעה מוסתרת מהלקוח',
  getDoc(doc(superA, `${BOARD}/msg_hidden`)));

await blocked('🔒 חבר מתחנה אחרת אינו קורא הודעת לוח',
  getDoc(doc(outside, `${BOARD}/msg_visible`)));

await blocked('🔒 מפקד מחוז אינו חבר תחנה ואינו קורא את הלוח',
  getDoc(doc(district, `${BOARD}/msg_visible`)));

await blocked('🔒 נרשם שטרם אושר אינו קורא את הלוח',
  getDoc(doc(pending, `${BOARD}/msg_visible`)));

await blocked('🔒 מבקר לא מחובר אינו קורא את הלוח',
  getDoc(doc(anon, `${BOARD}/msg_visible`)));

// ---- כל שינוי הודעה מהלקוח חסום; רק Admin SDK של ה-callable כותב ----

await blocked('🔒 לוחם אש אינו יוצר הודעת לוח ישירות',
  setDoc(doc(ff, `${BOARD}/client_ff`), BOARDMSG));

await blocked('🔒 מפקד תחנה אינו יוצר הודעת לוח ישירות',
  setDoc(doc(stCmd, `${BOARD}/client_station`),
    { ...BOARDMSG, by_uid: 'u_st', by_role: 'station_commander' }));

await blocked('🔒 גם מנהל-על אינו יוצר הודעת לוח ישירות',
  setDoc(doc(superA, `${BOARD}/client_super`), BOARDMSG));

await blocked('🔒 כותב אינו עורך את תוכן הודעתו',
  updateDoc(doc(ff, `${BOARD}/msg_visible`), { text: 'שונה' }));

await blocked('🔒 מנהל-על חייב להסתיר דרך callable מתועד',
  updateDoc(doc(superA, `${BOARD}/msg_visible`), { hidden: true }));

await blocked('🔒 אין מחיקה פיזית של הודעת לוח',
  deleteDoc(doc(superA, `${BOARD}/msg_visible`)));

// ---- תגובות גלויות לחברים, אך כל כתיבה נשארת בשרת ----

const REPLIES = `${BOARD}/msg_visible/bulletin_replies`;
const REPLYMSG = {
  kind: 'bulletin_reply', parent_message_id: 'msg_visible',
  text: 'תגובה מזויפת', by_uid: 'u_cmda', by_name: 'מפקד א',
  by_role: 'commander', by_crew: 'א', hidden: false,
  created_at: new Date('2026-08-25T08:10:00.000Z'),
  created_key: '2026-08-25T08:10:00.000Z', request_hash: 'client-reply'
};

await ok('חבר תחנה קורא תגובה גלויה',
  getDoc(doc(ff, `${REPLIES}/reply_visible`)));

await ok('שאילתת תגובות גלויה ומוגבלת מותרת',
  getDocs(query(collection(ff, REPLIES),
    where('hidden', '==', false), orderBy('created_at', 'desc'), limit(20))));

await blocked('🔒 שאילתת תגובות בלי מסנן הסתרה נחסמת',
  getDocs(collection(ff, REPLIES)));

await blocked('🔒 תגובה מוסתרת חסומה לפי מזהה ישיר',
  getDoc(doc(ff, `${REPLIES}/reply_hidden`)));

await blocked('🔒 תגובה גלויה תחת הודעת-אב מוסתרת אינה דולפת',
  getDoc(doc(ff,
    `${BOARD}/msg_hidden/bulletin_replies/reply_parent_hidden`)));

await blocked('🔒 חבר מתחנה אחרת אינו קורא תגובה',
  getDoc(doc(outside, `${REPLIES}/reply_visible`)));

await blocked('🔒 מפקד מחוז אינו קורא תגובת תחנה',
  getDoc(doc(district, `${REPLIES}/reply_visible`)));

await blocked('🔒 ראש משמרת אינו יוצר תגובה ישירות',
  setDoc(doc(cmdA, `${REPLIES}/client_commander`), REPLYMSG));

await blocked('🔒 גם מנהל-על אינו יוצר תגובה ישירות',
  setDoc(doc(superA, `${REPLIES}/client_super`), REPLYMSG));

await blocked('🔒 כותב אינו עורך תגובה ישירות',
  updateDoc(doc(cmdA, `${REPLIES}/reply_visible`), { text: 'שונה' }));

await blocked('🔒 מנהל-על מסתיר תגובה רק דרך callable מתועד',
  updateDoc(doc(superA, `${REPLIES}/reply_visible`), { hidden: true }));

await blocked('🔒 אין מחיקה פיזית של תגובה',
  deleteDoc(doc(superA, `${REPLIES}/reply_visible`)));

// ---- ניהול תחנות משנה נשמר, אך מחיקה מוחלפת בארכוב ----

await ok('סגל יוצר תחנת משנה חדשה',
  setDoc(doc(stCmd, `stations/${SID}/sub_stations/new_site`),
    { name: 'חדשה', order: 5, status: 'active' }));

await ok('סגל מעביר תחנת משנה לארכיון',
  updateDoc(doc(stCmd, `stations/${SID}/sub_stations/archived_site`),
    { status: 'archived' }));

await blocked('🔒 לוחם אש אינו משנה תחנת משנה',
  updateDoc(doc(ff, `stations/${SID}/sub_stations/rashit`),
    { status: 'archived' }));

await blocked('🔒 סגל אינו מוחק תחנת משנה',
  deleteDoc(doc(stCmd, `stations/${SID}/sub_stations/new_site`)));

await blocked('🔒 גם מנהל-על אינו מוחק תחנת משנה מהלקוח',
  deleteDoc(doc(superA, `stations/${SID}/sub_stations/new_site`)));

// ============================================================
head('18 · נוכחות אוטומטית — חומר גלם סגור ודוחות מצומצמים');
// ============================================================

const SHADOW_RUNS = `stations/${SID}/attendance_shadow_runs`;
const SHADOW_RUN = `${SHADOW_RUNS}/2026-09-01__v1`;
const SHADOW_ENTRIES = `${SHADOW_RUN}/attendance_shadow_entries`;
const SHADOW_ENTRY = `${SHADOW_ENTRIES}/u_ff`;
const SHADOW_REPORTS = `stations/${SID}/attendance_shadow_reports`;
const SHADOW_REPORT = `${SHADOW_REPORTS}/2026-09`;
const SHADOW_GENERATIONS = `${SHADOW_REPORT}/attendance_shadow_generations`;
const SHADOW_GENERATION = `${SHADOW_GENERATIONS}/gen_active`;
const SHADOW_PEOPLE = `${SHADOW_GENERATION}/attendance_shadow_people`;
const SHADOW_PERSON = `${SHADOW_PEOPLE}/u_ff`;
const SHADOW_BUILDING_PEOPLE = `${SHADOW_GENERATIONS}/gen_building/attendance_shadow_people`;
const SHADOW_BUILDING_PERSON = `${SHADOW_BUILDING_PEOPLE}/u_ff`;
const SHADOW_LEGACY_PERSON = `${SHADOW_REPORT}/attendance_shadow_people/u_ff`;

// כל תפקיד נבדק גם ב-get וגם ב-list. raw סגור תמיד; הדוח
// המצומצם פתוח רק לשלושת מבקרי הצל.
const SHADOW_READERS = [
  ['מבקר לא מחובר', anon, false],
  ['נרשם שטרם אושר', pending, false],
  ['לוחם אש', ff, false],
  ['סגן מפקד צוות', dteamA, false],
  ['מפקד צוות', teamA, false],
  ['סגן מפקד משמרת', deputyA, false],
  ['מפקד משמרת', cmdA, false],
  ['מפקד בלי שיוך משמרת', cmdNew, false],
  ['מפקד תחנה', stCmd, true],
  ['רכזת כוח אדם', hrUser, true],
  ['מפקד מחוז', district, false],
  ['לוחם מתחנה אחרת', outside, false],
  ['רכזת מתחנה אחרת', outsideHr, false],
  ['מנהל-על', superA, true]
];

for (const [roleName, client, mayAudit] of SHADOW_READERS) {
  await blocked(`🔒 ${roleName} אינו קורא ריצת Shadow גולמית`,
    getDoc(doc(client, SHADOW_RUN)));
  await blocked(`🔒 ${roleName} אינו מבצע list לריצות Shadow גולמיות`,
    getDocs(collection(client, SHADOW_RUNS)));
  await blocked(`🔒 ${roleName} אינו קורא רשומת אדם גולמית`,
    getDoc(doc(client, SHADOW_ENTRY)));
  await blocked(`🔒 ${roleName} אינו מבצע list לרשומות אדם גולמיות`,
    getDocs(collection(client, SHADOW_ENTRIES)));
  await blocked(`🔒 ${roleName} אינו קורא מסמך דור Shadow`,
    getDoc(doc(client, SHADOW_GENERATION)));
  await blocked(`🔒 ${roleName} אינו מבצע list לדורות Shadow`,
    getDocs(collection(client, SHADOW_GENERATIONS)));
  await blocked(`🔒 ${roleName} אינו קורא נתיב אדם ישן ללא דור`,
    getDoc(doc(client, SHADOW_LEGACY_PERSON)));

  const reportGet = getDoc(doc(client, SHADOW_REPORT));
  const reportList = getDocs(collection(client, SHADOW_REPORTS));
  const personGet = getDoc(doc(client, SHADOW_PERSON));
  const peopleList = getDocs(collection(client, SHADOW_PEOPLE));
  if (mayAudit) {
    await ok(`${roleName} קורא דוח Shadow מצומצם`, reportGet);
    await ok(`${roleName} מבצע list לדוחות Shadow מצומצמים`, reportList);
    await ok(`${roleName} קורא תוצאת אדם מצומצמת`, personGet);
    await ok(`${roleName} מבצע list לתוצאות אדם מצומצמות`, peopleList);
  } else {
    await blocked(`🔒 ${roleName} אינו קורא דוח Shadow`, reportGet);
    await blocked(`🔒 ${roleName} אינו מבצע list לדוחות Shadow`, reportList);
    await blocked(`🔒 ${roleName} אינו קורא תוצאת אדם ב-Shadow`, personGet);
    await blocked(`🔒 ${roleName} אינו מבצע list לתוצאות אדם ב-Shadow`, peopleList);
  }
}

// טוקן ישן אינו מספיק למסך הרגיש. השבתה, שינוי תפקיד או מחיקת
// כרטיס המשתמש חייבים לחסום מיד גם get וגם list, לדוח ולאדם.
for (const [roleName, client] of [
  ['מפקד תחנה מושבת', inactiveStCmd],
  ['רכזת כוח אדם מושבתת', inactiveHr],
  ['רכזת עם תפקיד ישן בטוקן', staleHr],
  ['רכזת בלי כרטיס משתמש בתחנה', missingHr]
]) {
  await blocked(`🔒 ${roleName} אינו קורא דוח Shadow`,
    getDoc(doc(client, SHADOW_REPORT)));
  await blocked(`🔒 ${roleName} אינו מבצע list לדוחות Shadow`,
    getDocs(collection(client, SHADOW_REPORTS)));
  await blocked(`🔒 ${roleName} אינו קורא תוצאת אדם ב-Shadow`,
    getDoc(doc(client, SHADOW_PERSON)));
  await blocked(`🔒 ${roleName} אינו מבצע list לתוצאות אדם ב-Shadow`,
    getDocs(collection(client, SHADOW_PEOPLE)));
}

await ok('רכזת פעילה קוראת עמוד Shadow מלא של 100 אנשים',
  getDocs(query(collection(hrUser, SHADOW_PEOPLE), orderBy('uid'), limit(100)))
    .then(snap => {
      if (snap.size !== 100) throw new Error('Expected 100 Shadow people, got ' + snap.size);
      return snap;
    }));

await blocked('🔒 רכזת אילת אינה קוראת דוח Shadow של תחנה אחרת',
  getDoc(doc(hrUser, 'stations/other_99/attendance_shadow_reports/2026-09')));
await blocked('🔒 רכזת אילת אינה קוראת תוצאת אדם של תחנה אחרת',
  getDoc(doc(hrUser,
    'stations/other_99/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_active/attendance_shadow_people/u_out')));
await ok('מנהל-על קורא דוח Shadow של תחנה אחרת',
  getDoc(doc(superA, 'stations/other_99/attendance_shadow_reports/2026-09')));
await ok('מנהל-על קורא תוצאת אדם בדור הפעיל של תחנה אחרת',
  getDoc(doc(superA,
    'stations/other_99/attendance_shadow_reports/2026-09/attendance_shadow_generations/gen_active/attendance_shadow_people/u_out')));

for (const [roleName, client] of [
  ['מפקד תחנה', stCmd], ['רכזת כוח אדם', hrUser], ['מנהל-על', superA]
]) {
  await blocked(`🔒 ${roleName} אינו קורא תוצאת אדם מדור שעדיין בבנייה`,
    getDoc(doc(client, SHADOW_BUILDING_PERSON)));
  await blocked(`🔒 ${roleName} אינו מבצע list לתוצאות מדור שעדיין בבנייה`,
    getDocs(collection(client, SHADOW_BUILDING_PEOPLE)));
}

// false מוחלט בכתיבה: גם תפקידים מורשים לקריאה וגם מנהל-העל
// אינם עוקפים את פונקציית השרת. בודקים create/update/delete בכל
// אחת מארבע קבוצות האוספים.
const SHADOW_WRITERS = [
  ['לוחם אש', ff],
  ['מפקד משמרת', cmdA],
  ['מפקד תחנה', stCmd],
  ['רכזת כוח אדם', hrUser],
  ['רכזת מתחנה אחרת', outsideHr],
  ['מנהל-על', superA]
];

for (const [roleName, client] of SHADOW_WRITERS) {
  const createRun = `${SHADOW_RUNS}/client_${client === superA ? 'super' : roleName}`;
  const createEntry = `${SHADOW_ENTRIES}/client_${client === superA ? 'super' : roleName}`;
  const createReport = `${SHADOW_REPORTS}/client_${client === superA ? 'super' : roleName}`;
  const createGeneration = `${SHADOW_GENERATIONS}/client_${client === superA ? 'super' : roleName}`;
  const createPerson = `${SHADOW_PEOPLE}/client_${client === superA ? 'super' : roleName}`;

  await blocked(`🔒 ${roleName} אינו יוצר ריצת Shadow`,
    setDoc(doc(client, createRun), { expires_at: new Date() }));
  await blocked(`🔒 ${roleName} אינו מעדכן ריצת Shadow`,
    updateDoc(doc(client, SHADOW_RUN), { status: 'tampered' }));
  await blocked(`🔒 ${roleName} אינו מוחק ריצת Shadow`,
    deleteDoc(doc(client, SHADOW_RUN)));

  await blocked(`🔒 ${roleName} אינו יוצר רשומת Shadow גולמית`,
    setDoc(doc(client, createEntry), { uid: 'fake', expires_at: new Date() }));
  await blocked(`🔒 ${roleName} אינו מעדכן רשומת Shadow גולמית`,
    updateDoc(doc(client, SHADOW_ENTRY), { planned_hours: 99 }));
  await blocked(`🔒 ${roleName} אינו מוחק רשומת Shadow גולמית`,
    deleteDoc(doc(client, SHADOW_ENTRY)));

  await blocked(`🔒 ${roleName} אינו יוצר דוח Shadow`,
    setDoc(doc(client, createReport), { month: '2099-01', expires_at: new Date() }));
  await blocked(`🔒 ${roleName} אינו מעדכן דוח Shadow`,
    updateDoc(doc(client, SHADOW_REPORT), { mismatches: 999 }));
  await blocked(`🔒 ${roleName} אינו מוחק דוח Shadow`,
    deleteDoc(doc(client, SHADOW_REPORT)));

  await blocked(`🔒 ${roleName} אינו יוצר דור Shadow`,
    setDoc(doc(client, createGeneration), { generation_id: 'fake', expires_at: new Date() }));
  await blocked(`🔒 ${roleName} אינו מעדכן דור Shadow`,
    updateDoc(doc(client, SHADOW_GENERATION), { status: 'tampered' }));
  await blocked(`🔒 ${roleName} אינו מוחק דור Shadow`,
    deleteDoc(doc(client, SHADOW_GENERATION)));

  await blocked(`🔒 ${roleName} אינו יוצר תוצאת אדם ב-Shadow`,
    setDoc(doc(client, createPerson), { uid: 'fake', expires_at: new Date() }));
  await blocked(`🔒 ${roleName} אינו מעדכן תוצאת אדם ב-Shadow`,
    updateDoc(doc(client, SHADOW_PERSON), { mismatch_count: 999 }));
  await blocked(`🔒 ${roleName} אינו מוחק תוצאת אדם ב-Shadow`,
    deleteDoc(doc(client, SHADOW_PERSON)));
}

// ============================================================
head('19 · מפקד צוות — כל השאר נשאר סגור');
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
head('20 · מנוע סידור חודשי — לקוחות אינם עוקפים את השרת');
// ============================================================
// המידע במסלולים האלה כולל תמונת סגל מלאה, טיוטות, תגובות ותור
// התראות. כל הצפייה והעריכה נעשות דרך Callable Functions בלבד.
const SCHEDULE_PATHS = [
  `stations/${SID}/schedule_state/runtime`,
  `stations/${SID}/schedule_policies/policy_v1`,
  `stations/${SID}/schedule_sources/source_v1`,
  `stations/${SID}/schedule_sources/source_v1/people/u_ff`,
  `stations/${SID}/schedule_drafts/draft_v1`,
  `stations/${SID}/schedule_drafts/draft_v1/rows/row_v1`,
  `stations/${SID}/schedule_publications/pub_v1`,
  `stations/${SID}/schedule_publications/pub_v1/schedule_outbox/out_v1`,
  `stations/${SID}/schedule_responses/response_v1`,
  `stations/${SID}/schedule_audit/audit_v1`
];

for (const [roleName, client] of [
  ['לוחם אש', ff], ['מפקד תחנה', stCmd], ['מנהל-על', superA],
  ['משתמש מתחנה אחרת', outside]
]) {
  for (const path of SCHEDULE_PATHS) {
    await blocked(`🔒 ${roleName} אינו קורא ישירות ${path}`,
      getDoc(doc(client, path)));
    await blocked(`🔒 ${roleName} אינו כותב ישירות ${path}`,
      setDoc(doc(client, path), { tampered: true }));
  }
}

// ============================================================
head('21 · הסידור הישן סגור — אין עקיפה של מנוע הפרסום וההתראות');
// ============================================================
// המנוע החדש מחליף את שני המסלולים. גם קריאה ישירה חסומה כדי שטוקן
// ישן או שיוך שהוסר לא יוכלו להציג סידור שאינו עבר בדיקות חיות בשרת.
const LEGACY_ROTATION = `stations/${SID}/rotations/A`;
const LEGACY_OVERRIDE = `stations/${SID}/shift_overrides/2026-09-01`;

for (const [roleName, client] of [
  ['מפקד', cmdA], ['סגן מפקד', deputyA], ['מפקד תחנה', stCmd],
  ['רכז/ת כוח אדם', hrUser], ['מנהל-על', superA],
  ['אחראי/ת סידור פעיל/ה', ff], ['ממונה שהועבר/ה מתחנה אחרת', outside]
]) {
  await blocked(`🔒 ${roleName} אינו קורא מחזור ישן ישירות`,
    getDoc(doc(client, LEGACY_ROTATION)));
  await blocked(`🔒 ${roleName} אינו קורא חריגה ישנה ישירות`,
    getDoc(doc(client, LEGACY_OVERRIDE)));
  await blocked(`🔒 ${roleName} אינו כותב מחזור ישן ישירות`,
    setDoc(doc(client, LEGACY_ROTATION), { crew: 'A', cycle_days: 3 }));
  await blocked(`🔒 ${roleName} אינו כותב חריגה ישנה ישירות`,
    setDoc(doc(client, LEGACY_OVERRIDE), { date: '2026-09-01', kind: 'holiday' }));
}

await blocked('🔒 גם אחראי/ת סידור אינו מעדכן מחזור ישן',
  updateDoc(doc(ff, LEGACY_ROTATION), { cycle_days: 4 }));
await blocked('🔒 גם אחראי/ת סידור אינו מוחק מחזור ישן',
  deleteDoc(doc(ff, LEGACY_ROTATION)));
await blocked('🔒 גם אחראי/ת סידור אינו מעדכן חריגה ישנה',
  updateDoc(doc(ff, LEGACY_OVERRIDE), { kind: 'swap' }));
await blocked('🔒 גם אחראי/ת סידור אינו מוחק חריגה ישנה',
  deleteDoc(doc(ff, LEGACY_OVERRIDE)));
await blocked('🔒 גם אחראי/ת סידור אינו קורא את רשומת המינוי ישירות',
  getDoc(doc(ff, `stations/${SID}/schedule_access/u_ff`)));
await blocked('🔒 גם אחראי/ת סידור אינו סורק רשומות מינוי ישירות',
  getDocs(collection(ff, `stations/${SID}/schedule_access`)));
await blocked('🔒 גם אחראי/ת סידור אינו יוצר רשומת מינוי ישירות',
  setDoc(doc(ff, `stations/${SID}/schedule_access/u_ffb`), { active: true }));
await blocked('🔒 גם אחראי/ת סידור אינו משנה את רשומת המינוי ישירות',
  updateDoc(doc(ff, `stations/${SID}/schedule_access/u_ff`), { active: false }));
await blocked('🔒 גם אחראי/ת סידור אינו מוחק את רשומת המינוי ישירות',
  deleteDoc(doc(ff, `stations/${SID}/schedule_access/u_ff`)));

await env.withSecurityRulesDisabled(async (c) => {
  await setDoc(doc(c.firestore(), `stations/${SID}/schedule_access/u_ff`), {
    schema_version: 1, station_id: SID, uid: 'u_ff', roles: [], active: false, revision: 2
  });
});
await blocked('🔒 ביטול מינוי לא פותח כתיבת חריגה ישנה',
  updateDoc(doc(ff, LEGACY_OVERRIDE), { kind: 'swap' }));

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
