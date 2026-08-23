// חישוב שעות ואוצר סוגי היום.
//
// הכללים כאן אינם המצאה שלי. הם נלקחו מהמערכת שכבאי אילת
// משתמשים בה בפועל (Apps Script + Google Sheets), אחרי קריאה
// של הקוד שלה. כל מספר כאן קיים היום בשטח.
//
// מה כן שיניתי, ובכוונה:
//
//   שם — במערכת הישנה סוג היום לא נשמר כשדה. הוא נוחש בדיעבד
//   לפי אילו עמודות בגיליון מלאות, ו"מילואים" זוהה לפי כך
//   שההערה החופשית מתחילה במילה הזו. מי שכתב "מילואים" בהערה
//   מסיבה אחרת קיבל 8.5 שעות. כאן הסוג הוא שדה.
//
//   יטבתה — זוהתה שם לפי חיפוש המחרוזת "יטבתה" או "יוטבתה"
//   בתוך ההערות. שגיאת כתיב אחת מאבדת 25 שעות בשקט. כאן זו
//   בחירה מפורשת.
//
// המזהים באנגלית והתצוגה בעברית, כדי ששינוי של מילה בממשק
// לא ישבור כלל אבטחה או רשומה שכבר נשמרה.

export const DAY_TYPES = [
  { id: 'regular',  he: 'רגיל',                times: true  },
  { id: 'swap',     he: 'החלפה צרכי מערכת',    times: true  },
  { id: 'vacation', he: 'חופש',                times: false },
  { id: 'sick',     he: 'מחלה',                times: false },
  { id: 'reserve',  he: 'מילואים',             times: false }
];

// מילואים — 8.5 שעות קבועות, בלי קשר לשעות בפועל.
export const RESERVE_HOURS = 8.5;

// חופש — 24 שעות.
//
// במערכת הקיימת יום חופש שווה 0 ואינו נספר בסך החודשי כלל.
// אלדד תיקן אותי: יום חופש הוא משמרת שלמה שהכבאי היה עובד
// בה, ולכן הוא נספר כ-24. זו סטייה מודעת מהמערכת הישנה,
// ולא העתקה שלה.
export const VACATION_HOURS = 24;

// מחלה — 0 שעות. אינה נספרת בסך החודשי.
//
// שים לב שזה שונה מחופש בכוונה. שאלתי את אלדד את שתי השאלות
// יחד והוא הפריד ביניהן: חופש 24, מחלה 0. אם השניים היו זהים
// לא היה טעם בשני קבועים.
export const SICK_HOURS = 0;

// משמרת יטבתה — 25 שעות. 07:00 עד 08:00 למחרת.
//
// חייבת טיפול נפרד: 08:00 גדול מ-07:00 מספרית, ולכן זיהוי
// חציית חצות הרגיל (סוף קטן או שווה להתחלה) לא תופס אותה,
// והחישוב היה מחזיר שעה אחת במקום 25.
//
// במערכת הקיימת זה קבוע בקוד ומזוהה לפי טקסט חופשי. כאן זה
// שדה על תחנת הקצה — "אורך משמרת קבוע". כך גם תחנת קצה אחרת
// תוכל לקבל אורך משלה בלי לגעת בקוד.
export const YOTVATA_HOURS = 25;

export function dayTypeHe(id) {
  const t = DAY_TYPES.filter(function (x) { return x.id === id; })[0];
  return t ? t.he : id;
}

export function needsTimes(id) {
  const t = DAY_TYPES.filter(function (x) { return x.id === id; })[0];
  return !!(t && t.times);
}

function validTime(s) {
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(s || ''));
}

// מחזיר שעות, או null אם חסר מידע.
//
// rec:       { day_type, start, end }
// siteHours: אורך משמרת קבוע של תחנת הקצה, או 0/undefined.
//            יטבתה = 25.
export function calcHours(rec, siteHours) {
  const r = rec || {};

  if (r.day_type === 'vacation') return VACATION_HOURS;
  if (r.day_type === 'sick')     return SICK_HOURS;
  if (r.day_type === 'reserve')  return RESERVE_HOURS;

  const fixed = Number(siteHours || 0);
  if (fixed > 0) return fixed;

  if (!validTime(r.start) || !validTime(r.end)) return null;

  const s = String(r.start).split(':').map(Number);
  const e = String(r.end).split(':').map(Number);
  let diff = (e[0] * 60 + e[1]) - (s[0] * 60 + s[1]);
  if (diff <= 0) diff += 24 * 60;      // חציית חצות
  return Math.round((diff / 60) * 100) / 100;
}

// סך חודשי. מחושב מהרשומות בכל פעם ולא נשמר בשום מקום.
//
// במערכת הקיימת הסך נשמר בנפרד מהגיליון, השניים התפצלו בפועל,
// ויש שם כפתור שכל תפקידו לתקן את הפער. מה שלא נשמר לא מתפצל.
// siteHoursOf — פונקציה שמקבלת מזהה תחנת קצה ומחזירה את אורך
// המשמרת הקבוע שלה. מועברת מבחוץ כי רשימת תחנות הקצה שייכת
// לתחנה ולא לקובץ הזה.
export function monthTotal(records, siteHoursOf) {
  const f = siteHoursOf || function () { return 0; };
  return Math.round((records || []).reduce(function (sum, r) {
    const h = calcHours(r, f(r && r.sub_station));
    return sum + (h || 0);
  }, 0) * 100) / 100;
}

// ברירת המחדל של תחנות הקצה באילת. נכתבת פעם אחת לתחנה שאין
// לה רשימה, וניתנת לעריכה מיד אחר כך.
export const SITE_SEED = [
  { id: 'rashit',  name: 'ראשית', fixed_hours: 0,  order: 1 },
  { id: 'shahmon', name: 'שחמון', fixed_hours: 0,  order: 2 },
  { id: 'timna',   name: 'תמנע',  fixed_hours: 0,  order: 3 },
  { id: 'yotvata', name: 'יטבתה', fixed_hours: 25, order: 4 }
];

// מפתח רשומה: אדם ויום. יום אחד לאדם, כמו במערכת הקיימת.
export function recordId(emp, date) {
  return String(emp) + '_' + String(date);
}

export function monthKey(y, m) {
  return y + '-' + String(m + 1).padStart(2, '0');
}

export function daysInMonth(y, m) {
  return new Date(y, m + 1, 0).getDate();
}

export function dateKey(y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
