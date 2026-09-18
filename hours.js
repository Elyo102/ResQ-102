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
  { id: 'regular',  he: 'רגיל',                       times: true  },
  { id: 'swap',     he: 'החלפה צרכי מערכת',           times: true  },
  { id: 'extra',    he: 'שעות ידני · נע״ת',           times: true  },
  { id: 'meeting',  he: 'ישיבות',                     times: true  },
  { id: 'guard',    he: 'אבטחה',                      times: true  },
  { id: 'vacation', he: 'חופש',                       times: false },
  { id: 'sick',     he: 'מחלה',                       times: false },
  { id: 'reserve',  he: 'מילואים',                    times: false }
];

// סוגי יום שדורשים נימוק תמיד, גם אם השעות רגילות לגמרי.
//
//   swap     המערכת ביקשה ממך לעבוד ביום שהמשמרת שלך לא עובדת.
//            משאבי אנוש צריכים לדעת מה קרה שם.
//   extra    נע״ת — נוסף על תפקיד. שעות מחוץ למסגרת המשמרת.
//   meeting  ישיבות.
//
// אבטחה איננה ברשימה במכוון. שם האירוע והמקום נשמרים על
// רשומת האבטחה עצמה, והם הנימוק — לבקש מהכבאי להקליד שוב
// "אבטחת משחק בטוטו טרנר" זו בקשה למלא טופס שהמערכת כבר
// מילאה.
//
// שים לב: סוג היום 'guard' רלוונטי רק לאבטחה **ביום חופש**.
// אבטחה בתוך המשמרת נבלעת ב-24 השעות ואינה רשומה בנפרד.
export const REASON_TYPES = ['swap', 'extra', 'meeting'];

// אורך משמרת ברירת מחדל, כשהסידור לא אומר אחרת.
//
// הסף לנימוק הוא אורך המשמרת של המקום שבו עבדת, ולא 24 קבוע:
// יטבתה היא 25 שעות בהגדרה, ולכן יום יטבתה שלם אינו חריגה
// ואינו דורש נימוק. אלדד תיקן אותי על זה במפורש.
export const DEFAULT_SHIFT_HOURS = 24;

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

// אורך קטע זמן אחד.
//
// dayOffset = בכמה ימים היציאה מאוחרת מהכניסה. 0 = אותו יום,
// 1 = למחרת, 2 = מחרתיים.
//
// למה זה חייב להיות מפורש: כניסה 07:00 ויציאה 09:00 יכולה
// להיות שעתיים או 26 שעות, ואין דרך להבדיל מהמספרים בלבד.
// הכלל הישן — "אם היציאה קטנה או שווה לכניסה, הוסף יממה" —
// מחזיר שעתיים בשני המקרים, ומי שנשאר יממה ועוד שעתיים
// מקבל שכר על שעתיים בלי שאיש ישים לב.
//
// בלי dayOffset נשמר הכלל הישן, כדי שרשומות שכבר נשמרו
// ימשיכו להתנהג כפי שהתנהגו.
export function segmentHours(start, end, dayOffset) {
  if (!validTime(start) || !validTime(end)) return null;
  const s = String(start).split(':').map(Number);
  const e = String(end).split(':').map(Number);
  let diff = (e[0] * 60 + e[1]) - (s[0] * 60 + s[1]);

  if (dayOffset == null || dayOffset === '') {
    if (diff <= 0) diff += 24 * 60;
  } else {
    diff += Number(dayOffset) * 24 * 60;
    if (diff <= 0) return null;
  }
  return Math.round((diff / 60) * 100) / 100;
}

// כמה ימים לדלג, לפי מה שנשמר. ברירת מחדל: הכלל הישן.
export function guessDayOffset(start, end) {
  if (!validTime(start) || !validTime(end)) return 0;
  const s = String(start).split(':').map(Number);
  const e = String(end).split(':').map(Number);
  return ((e[0] * 60 + e[1]) - (s[0] * 60 + s[1])) <= 0 ? 1 : 0;
}

// צורת המשמרת. שלוש צורות, ואלדד הגדיר אותן במילים שלו:
//
//   regular    כניסה ויציאה. עד יממה.
//   continued  המשך משמרת — יציאה למחרת, תמיד מעל 24 שעות.
//   split      משמרת מפוצלת — שתי כניסות ושתי יציאות באותו
//              יום, והסך הוא סכום שני הקטעים.
//
// הצורה נשמרת כשדה ולא מנוחשת מהשעות. 07:00 עד 09:00 יכולה
// להיות שעתיים או 26 שעות, ורק הצורה מבדילה ביניהן.
export const SHAPES = [
  { id: 'regular',   he: 'משמרת רגילה' },
  { id: 'continued', he: 'המשך משמרת — מעל 24 שעות' },
  { id: 'split',     he: 'משמרת מפוצלת — שני קטעים' }
];

export function shapeHe(id) {
  const s = SHAPES.filter(function (x) { return x.id === id; })[0];
  return s ? s.he : id;
}

// צורתה של רשומה קיימת. רשומות ישנות אינן נושאות shape,
// ולכן היא נגזרת ממה שיש בהן.
export function shapeOf(rec) {
  const r = rec || {};
  if (r.shape) return r.shape;
  if (isSplit(r)) return 'split';
  if (Number(r.end_day || 0) >= 1 && segmentHours(r.start, r.end, r.end_day) > 24) {
    return 'continued';
  }
  return 'regular';
}

export function isSplit(rec) {
  const r = rec || {};
  return !!(r.start2 && r.end2);
}

// מחזיר שעות, או null אם חסר מידע.
//
// rec:       { day_type, start, end, start2, end2 }
//            start2/end2 = קטע שני של משמרת מפוצלת. שני הקטעים
//            נסכמים. יום עם קטע אחד נשאר בדיוק כפי שהיה.
// siteHours: אורך משמרת קבוע של תחנת הקצה, או 0/undefined.
//            יטבתה = 25.
export function calcHours(rec, siteHours) {
  const r = rec || {};

  if (r.day_type === 'vacation') return VACATION_HOURS;
  if (r.day_type === 'sick')     return SICK_HOURS;
  if (r.day_type === 'reserve')  return RESERVE_HOURS;

  // אורך קבוע של תחנת קצה גובר גם על פיצול. יטבתה היא 25 שעות
  // בהגדרה, ולא סכום של מה שדווח.
  const fixed = Number(siteHours || 0);
  if (fixed > 0) return fixed;

  const h1 = segmentHours(r.start, r.end, r.end_day);
  if (h1 == null) return null;
  if (!isSplit(r)) return h1;

  const h2 = segmentHours(r.start2, r.end2, r.end_day2);
  if (h2 == null) return null;
  return Math.round((h1 + h2) * 100) / 100;
}


// ---------- שעות נוספות ----------
//
// שעה נוספת היא כל שעה מעל אורך המשמרת שהסידור קבע לאותו יום.
// באילת זה 24, ובתחנת קצה עם אורך קבוע זה האורך שלה — כך
// שמשמרת יטבתה של 25 אינה שעה נוספת, היא פשוט משמרת יטבתה.
//
// ימים בלי שעות — חופש, מחלה, מילואים — אינם מייצרים שעות
// נוספות: הם ממילא מספר קבוע.

export function expectedHours(rec, siteHours, shiftHours) {
  const r = rec || {};
  if (!needsTimes(r.day_type)) return null;
  // אורך קבוע של תחנת קצה הוא אורך המשמרת שם, ולא חריגה ממנה.
  const fixed = Number(siteHours || 0);
  if (fixed > 0) return fixed;
  return Number(shiftHours || DEFAULT_SHIFT_HOURS);
}

export function overtimeHours(rec, siteHours, shiftHours) {
  const exp = expectedHours(rec, siteHours, shiftHours);
  if (exp == null) return 0;
  const actual = calcHours(rec, siteHours);
  if (actual == null) return 0;
  const ot = Math.round((actual - exp) * 100) / 100;
  return ot > 0 ? ot : 0;
}

// למה נדרש נימוק ביום הזה. מחזיר מחרוזת להסבר, או '' אם לא נדרש.
//
// שלוש סיבות, וכולן של אלדד:
//   סוג היום      החלפה צרכי מערכת, נע״ת, ישיבות
//   המשך משמרת    לפי הגדרתו מעל יממה
//   מעל 24 שעות   כולל יטבתה של 25
export function reasonWhy(rec, siteHours, shiftHours) {
  const r = rec || {};

  if (REASON_TYPES.indexOf(r.day_type) !== -1) {
    return dayTypeHe(r.day_type);
  }
  if (!needsTimes(r.day_type)) return '';

  const h = calcHours(r, siteHours);
  if (h == null) return '';

  if (shapeOf(r) === 'continued') return 'המשך משמרת';

  const ot = overtimeHours(r, siteHours, shiftHours);
  if (ot > 0) return ot + ' שעות מעל המשמרת';

  return '';
}

export function needsReason(rec, siteHours, shiftHours) {
  return reasonWhy(rec, siteHours, shiftHours) !== '';
}

export function reasonMissing(rec, siteHours, shiftHours) {
  return needsReason(rec, siteHours, shiftHours)
         && !String((rec || {}).overtime_reason || '').trim();
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

// סיכום חודשי לתצוגה לפני שליחה לאישור: כמה שעות, כמה ימים
// מכל סוג, ואילו ימים חרגו ומה הנימוק שנרשם להם.
export function monthSummary(records, siteHoursOf, shiftHoursOf) {
  const f = siteHoursOf  || function () { return 0; };
  const g = shiftHoursOf || function () { return 24; };
  const recs = (records || []).slice().sort(function (a, b) {
    return String(a.date).localeCompare(String(b.date));
  });

  const byType = {};
  const overtime = [];
  let split = 0;

  recs.forEach(function (r) {
    const site = f(r.sub_station);
    byType[r.day_type] = (byType[r.day_type] || 0) + 1;
    if (isSplit(r)) split++;
    const why = reasonWhy(r, site, g(r.date));
    if (why) {
      overtime.push({ date: r.date, why: why,
                      hours: overtimeHours(r, site, g(r.date)),
                      reason: String(r.overtime_reason || '').trim() });
    }
  });

  return {
    days: recs.length,
    hours: monthTotal(recs, f),
    byType: byType,
    split: split,
    overtime: overtime,
    overtimeHours: Math.round(overtime.reduce(function (s, o) {
      return s + o.hours; }, 0) * 100) / 100,
    unexplained: overtime.filter(function (o) { return !o.reason; })
  };
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
