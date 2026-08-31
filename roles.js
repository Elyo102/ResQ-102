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
// אחראי/ת סידור הוא תפקיד נוסף. הוא בכוונה לא נכנס ל-ROLES:
// אדם ממשיך להיות, למשל, לוחם אש וגם מקבל סמכות ממוקדת לעריכת
// הסידור — בלי לרשת סמכויות של מפקד/ת או של משאבי אנוש.
export const SCHEDULE_MANAGER_HE = 'אחראי/ת סידור';

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
export function isScheduleManager(c) {
  return !!c && c.schedule_manager === true;
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
//  מי רשאי לשבץ תפקיד למי
// ---------------------------------------------------------------
//
//  אלדד, 25.8.2026: "עד סגן מפקד משמרת."
//
//  **למה יש כאן תקרה בכלל.**
//
//  באפליקציה שהתחנה משתמשת בה היום, שיבוץ תפקיד נעול לקוד
//  אחד בלבד — שלו. ההערה שם מסבירה למה במילים האלה:
//  "כדי שאף אחד לא יוכל לשדרג את עצמו למנהל בטעות או בזדון."
//
//  פתחנו את זה לרכזת כוח האדם, כי בלי זה היא לא יכולה לעשות
//  את העבודה שלה. אבל לפתוח בלי תקרה זה לא "לתת לה הרשאה",
//  זה לתת לה את המערכת: מי שיכול למנות מפקד יכול למנות את
//  עצמה מפקדת, ומשם הכל.
//
//  התקרה היא דרגה 3 — מפקד צוות. כלומר הרכזת משבצת את דרגות
//  השטח, שזו העבודה היומיומית, ומינוי סגל פיקודי נשאר אצל
//  מנהל-על. זה גם לא מקרי שהתקרה נמוכה מהדרגה שלה עצמה: כלל
//  "עד הדרגה שלי" היה מאפשר לה למנות רכזת שנייה, ומשם שתיהן
//  יכולות למנות זו את זו לכל דבר.
//
//  ⚠️ הכלל הזה נאכף **בשרת**, ב-setUserRole. הפונקציה כאן
//  משמשת את המסכים כדי לא להציג אפשרות שתידחה ממילא. מסך
//  שמסתיר כפתור אינו הרשאה.

export const ASSIGN_MAX_RANK = {
  hr_coordinator: 3   // עד מפקד צוות, כולל
};

// מה מותר ל-actor לשבץ. מנהל-על — הכל. אחרת לפי הטבלה למעלה,
// וברירת המחדל היא אפס, כלומר אסור. תפקיד חדש שיתווסף למערכת
// לא יקבל סמכות שיבוץ במקרה.
export function maxAssignRank(claims) {
  if (isSuper(claims)) return Infinity;
  const r = claims && claims.role;
  return ASSIGN_MAX_RANK[r] || 0;
}

// שתי בדיקות, לא אחת: גם התפקיד **החדש** וגם התפקיד **הקיים**
// של היעד חייבים להיות מתחת לתקרה.
//
// בלי הבדיקה השנייה, רכזת יכולה להוריד מפקד משמרת לדרגת לוחם —
// פעולה שכל כולה מתחת לתקרה מבחינת התפקיד החדש, ובכל זאת היא
// הדחה של בכיר ממנה. הורדה בדרגה היא שינוי סמכות בדיוק כמו
// העלאה, ומי שאינו רשאי למנות מפקד אינו רשאי גם לפרק אותו.
export function mayAssignRole(claims, targetRoleId, targetCurrentRoleId) {
  const cap = maxAssignRank(claims);
  if (cap === Infinity) return true;
  if (cap === 0) return false;
  if (targetRoleId && roleRank(targetRoleId) > cap) return false;
  if (targetCurrentRoleId && roleRank(targetCurrentRoleId) > cap) return false;
  return true;
}

// רשימת התפקידים שה-actor רשאי לבחור מהם, לבניית הבורר במסך.
export function assignableRoles(claims) {
  const cap = maxAssignRank(claims);
  if (cap === Infinity) return ROLES.slice();
  return ROLES.filter(function (r) { return r.rank <= cap; });
}

export function assignableRoleOptionsHtml(claims, extra) {
  const esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  const list = assignableRoles(claims)
    .sort(function (a, b) { return a.rank - b.rank; })
    .concat(extra || []);
  return list.map(function (r) {
    return '<option value="' + esc(r.id) + '">' + esc(r.he) + '</option>';
  }).join('');
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
