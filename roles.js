// =====================================================================
//  התפקידים במערכת — מקור אמת אחד
// =====================================================================
//
//  **למה הקובץ הזה נולד.**
//
//  עד עכשיו רשימת התפקידים והשמות בעברית היו כתובים חמש
//  פעמים: ב-admin.html, ב-login.html, ב-access.html,
//  ב-schedule.html וב-nav.js. חמישה עותקים של אותו נתון
//  פירושם שכל תפקיד חדש נוסף בארבעה מקומות ונשכח בחמישי —
//  ושם הוא יופיע למשתמש כמחרוזת באנגלית.
//
//  זה בדיוק מה שקרה בשם השדה crew/shift: אותו נתון בשני שמות,
//  ובאג שנראה כמו חור אבטחה.
//
//  **הרשימה בשרת חייבת להיות זהה.** functions/index.js מחזיק
//  את VALID_ROLES שלו, כי הוא CommonJS ולא יכול לייבא מודול
//  דפדפן. tests/roles.mjs משווה בין השניים ונופל אם הם
//  יוצאים מסנכרון.

// ---------------------------------------------------------------
//  הרשימה
// ---------------------------------------------------------------
//
//  rank   — סדר היררכי לתצוגה ולמיון בלבד. **אינו הרשאה.**
//           כל הרשאה נגזרת מהדגלים המפורשים למטה, כי "מי
//           שדרגתו גבוהה יותר רשאי ליותר" הוא בדיוק סוג
//           הכלל שנשבר ביום שמוסיפים תפקיד באמצע.
//  member — שייך לתחנה: רואה סידור, מדווח שעות, מגיש טפסים.
//  staff  — סגל פיקודי: מאשר, משבץ, ורואה נתוני אחרים.
//  logs   — רשאי לכתוב בלוג המשמרת.

export const ROLES = [
  { id: 'firefighter',        he: 'לוחם אש',
    rank: 1, member: true,  staff: false, logs: false },

  // ---- נוספו 25.8.2026, לבקשת אלדד ----
  //
  // מפקד צוות וסגנו הם **דרגות שטח**, לא דרגות מנהלה. אלדד
  // הגדיר במפורש: הסמכות היחידה שהם מקבלים היא לכתוב בלוג
  // המשמרת. הם אינם מאשרים טפסים, אינם מאשרים שעות ואינם
  // רואים נתונים של אחרים — בכל אלה הם לוחם אש לכל דבר.
  //
  // זה מכוון ולא זמני. תפקיד שמקבל סמכויות "כי הוא נשמע
  // בכיר" הוא איך שמערכת הרשאות נשחקת.
  { id: 'deputy_team_leader', he: 'סגן מפקד צוות',
    rank: 2, member: true,  staff: false, logs: true },
  { id: 'team_leader',        he: 'מפקד צוות',
    rank: 3, member: true,  staff: false, logs: true },

  { id: 'deputy',             he: 'סגן מפקד משמרת',
    rank: 4, member: true,  staff: true,  logs: true },
  { id: 'commander',          he: 'קצין / מפקד משמרת',
    rank: 5, member: true,  staff: true,  logs: true },
  { id: 'station_commander',  he: 'מפקד תחנה',
    rank: 6, member: true,  staff: true,  logs: true },
  { id: 'hr_coordinator',     he: 'רכז/ת משאבי אנוש',
    rank: 6, member: true,  staff: true,  logs: true },

  // מפקד מחוז אינו member באף כלל אבטחה. הצגת מסכי התחנה לו
  // הייתה שולחת אותו לדפים שכולם נחסמים בשרת.
  { id: 'district_commander', he: 'מפקד מחוז',
    rank: 7, member: false, staff: false, logs: false }
];

// מנהל-על אינו תפקיד ברשימה — הוא דגל נפרד (super) שנוסף
// **מעל** התפקיד. אלדד הוא לוחם אש וגם מנהל-על, ודריסה
// הייתה מנתקת אותו מהמערכת שלו.
export const SUPER_HE = 'מנהל מערכת';

// ---------------------------------------------------------------
//  נגזרות
// ---------------------------------------------------------------

const BY_ID = {};
ROLES.forEach(function (r) { BY_ID[r.id] = r; });

export const VALID_ROLES  = ROLES.map(function (r) { return r.id; });
export const MEMBER_ROLES = ROLES.filter(r => r.member).map(r => r.id);
export const STAFF_ROLES  = ROLES.filter(r => r.staff).map(r => r.id);
export const LOG_ROLES    = ROLES.filter(r => r.logs).map(r => r.id);

// מפת השמות, לתאימות עם המסכים שכבר משתמשים ב-ROLE_HE.
export const ROLE_HE = ROLES.reduce(function (acc, r) {
  acc[r.id] = r.he; return acc;
}, { super_admin: SUPER_HE });

export function roleHe(id) {
  return ROLE_HE[String(id || '')] || String(id || '');
}

export function roleRank(id) {
  const r = BY_ID[String(id || '')];
  return r ? r.rank : 0;
}

// ---------------------------------------------------------------
//  שאלות הרשאה
// ---------------------------------------------------------------
//
// כולן מקבלות את ה-claims של הטוקן, לא את מסמך המשתמש.
// המסמך יכול להיות ישן; הטוקן הוא מה שהשרת יאכוף.

export function isSuper(c) {
  return !!c && (c.super === true || c.role === 'super_admin');
}
export function isMember(c) {
  return isSuper(c) || (!!c && MEMBER_ROLES.indexOf(c.role) !== -1);
}
export function isStaff(c) {
  return isSuper(c) || (!!c && STAFF_ROLES.indexOf(c.role) !== -1);
}

// מי כותב בלוג המשמרת. זו הסמכות היחידה שמפקד צוות מקבל,
// ולכן היא נשאלת בנפרד ולא נגזרת מ-isStaff.
export function mayWriteLog(c) {
  return isSuper(c) || (!!c && LOG_ROLES.indexOf(c.role) !== -1);
}

// ---------------------------------------------------------------
//  שיוך צוות
// ---------------------------------------------------------------
//
//  אלדד: הצוות מוגדר **גם לפי תפקיד וגם לפי רכב.**
//
//  כלומר מפקד צוות אינו מפקד "בכללי" — הוא מפקד הצוות שמשובץ
//  איתו לאותו רכב באותה משמרת. השיבוץ כבר קיים במסך הציוות
//  (board.html) ונשמר ב-vehicle_views, ולכן אין כאן שדה חדש
//  ואין הזנה כפולה: התפקיד אומר **מה** הוא, והשיבוץ אומר
//  **על מי**.
//
//  היום זה משמש לתצוגה בלבד — "מפקד צוות · כבאית 5" ליד השם
//  בלוג — כי הסמכות היחידה שלו היא כתיבה, והיא אינה תלויה
//  בצוות. ברגע שתתווסף סמכות שכן תלויה בו, הפונקציה הזאת היא
//  המקום היחיד שצריך לגדול.

export function teamLabel(claims, vehicleName) {
  const he = roleHe(claims && claims.role);
  if (!isTeamRole(claims && claims.role)) return he;
  return vehicleName ? he + ' · ' + vehicleName : he;
}

export function isTeamRole(id) {
  return id === 'team_leader' || id === 'deputy_team_leader';
}

// ---------------------------------------------------------------
//  רשימת בחירה
// ---------------------------------------------------------------
//
// הבוררים במסך הניהול נכתבו ביד, ולכן **חסרו בהם שני תפקידים
// שכבר היו קיימים במערכת**: סגן מפקד משמרת ומפקד תחנה. אפשר
// היה להגדיר אותם רק דרך הקוד. כאן הרשימה נבנית מהמקור, ולכן
// תפקיד חדש מופיע בכל בורר מעצמו.
//
// מפקד מחוז נשאר ברשימה למרות שאינו member — הוא תפקיד אמיתי
// שאפשר להגדיר, הוא פשוט אינו רואה את מסכי התחנה.

export function roleOptionsHtml(extra) {
  const esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  const list = ROLES.slice().sort(function (a, b) { return a.rank - b.rank; })
    .concat(extra || []);
  return list.map(function (r) {
    return '<option value="' + esc(r.id) + '">' + esc(r.he) + '</option>';
  }).join('');
}
