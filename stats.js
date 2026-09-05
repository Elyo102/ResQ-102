// אנליטיקה.
//
// אלדד בחר שתי שאלות ולא ארבע: **רכבים** ו**חלוקת עומסים**.
// לכן אין כאן דוח שעות ואין מגמות כשירות — מסך שעונה על
// ארבע שאלות בבינוניות פחות שימושי ממסך שעונה על שתיים
// היטב.
//
// הכל מחושב בדפדפן מהנתונים שכבר נטענו. אין אוסף סיכומים
// ואין ריצה לילית שמייצרת אותם, מאותה סיבה שסכומי השעות
// מחושבים בכל תצוגה: סיכום שנשמר מתיישן, ואף אחד לא שם לב
// עד שמישהו מסתמך עליו.

import { isOpen, isDamage, sevRank } from './faults.js?v=42h2';
import { guardHours, assignedOf, dutyKind } from './guards.js?v=42h2';

export function toKey(d) {
  if (typeof d === 'string') return d;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const a = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + a;
}

export function dmy(key) {
  const p = String(key || '').split('-');
  return p.length === 3 ? Number(p[2]) + '.' + Number(p[1]) : String(key || '');
}

// חלונות זמן. שנה היא ברירת המחדל — קצר מדי מעניש מי שנפגע
// לאחרונה, ארוך מדי גורר לנצח רכב שהוחלף.
export const WINDOWS = [
  { id: '90',  he: '3 חודשים', days: 90  },
  { id: '180', he: 'חצי שנה',  days: 180 },
  { id: '365', he: 'שנה',      days: 365 },
  { id: 'all', he: 'הכל',      days: 0   }
];

export function sinceKey(windowId, today) {
  const w = WINDOWS.filter(function (x) { return x.id === windowId; })[0];
  if (!w || !w.days) return '';
  const d = today ? new Date(today) : new Date();
  d.setDate(d.getDate() - w.days);
  return toKey(d);
}

function inWindow(key, since) {
  if (!since) return true;
  return String(key || '').slice(0, 10) >= since;
}

// ------------------------------------------------------------------
//  רכבים
// ------------------------------------------------------------------
//
// שלוש שאלות שמפקד שואל על צי:
//
//   מי שובר הכי הרבה   מספר תקלות לרכב
//   כמה זמן זה לוקח    ימים ממוצעים עד סגירה
//   כמה זה עלה לי      ימים שהרכב היה משבית
//
// השלישית היא היחידה שמתורגמת לכשירות מבצעית, ולכן היא
// המיון המוביל.

export function vehicleStats(fleet, faults, since) {
  const rows = (fleet || []).map(function (v) {
    const mine = (faults || []).filter(function (f) {
      return f && f.vehicle_id === v.id && inWindow(f.created_key, since);
    });

    const damage = mine.filter(isDamage);
    const tech   = mine.filter(function (f) { return !isDamage(f); });
    const open   = mine.filter(isOpen);
    const closed = tech.filter(function (f) { return !isOpen(f); });

    // ימים לסגירה. רק תקלות שנסגרו בפועל — תקלה פתוחה
    // חודשיים אינה "ממוצע גבוה" אלא נתון אחר לגמרי, והיא
    // נספרת בעמודה של הפתוחות.
    let sumDays = 0, counted = 0;
    closed.forEach(function (f) {
      const a = Date.parse(String(f.created_key || ''));
      const b = Date.parse(String(f.fixed_key || ''));
      if (!a || !b || b < a) return;
      sumDays += (b - a) / 86400000;
      counted++;
    });

    // ימי השבתה. תקלה משביתה שנסגרה — הפרש התאריכים.
    // משביתה שעדיין פתוחה — עד היום.
    let downDays = 0;
    mine.filter(function (f) { return f.severity === 'blocking'; })
        .forEach(function (f) {
          const a = Date.parse(String(f.created_key || ''));
          if (!a) return;
          const b = isOpen(f) ? Date.now()
                              : Date.parse(String(f.fixed_key || '')) || Date.now();
          if (b > a) downDays += (b - a) / 86400000;
        });

    return {
      id: v.id, name: v.name, kind: v.kind,
      total: mine.length,
      tech: tech.length,
      damage: damage.length,
      open: open.length,
      avgClose: counted ? Math.round((sumDays / counted) * 10) / 10 : null,
      closedCount: counted,
      downDays: Math.round(downDays * 10) / 10,
      worst: mine.length
        ? mine.reduce(function (a, f) {
            return sevRank(f.severity) < sevRank(a.severity) ? f : a; }, mine[0])
        : null
    };
  });

  rows.sort(function (a, b) {
    if (b.downDays !== a.downDays) return b.downDays - a.downDays;
    if (b.total !== a.total) return b.total - a.total;
    return String(a.name).localeCompare(String(b.name), 'he');
  });
  return rows;
}

// המשפט שמסביר מה רואים. מספר בלי משמעות הוא מספר שלא
// מסתכלים עליו פעמיים.
export function vehicleWhy(r) {
  if (!r) return '';
  if (!r.total) return 'לא נפתחו תקלות בתקופה.';
  const bits = [];
  // תקלה שנפתחה היום היא שבר של יום. "0 ימי השבתה" נראה
  // כמו שהרכב תקין, וזה בדיוק ההפך.
  if (r.downDays > 0) {
    bits.push(r.downDays < 1 ? 'הושבת היום'
                             : Math.round(r.downDays) + ' ימי השבתה');
  }
  if (r.open) bits.push(r.open + ' פתוחות עכשיו');
  if (r.avgClose != null) bits.push('ממוצע סגירה ' + r.avgClose + ' ימים');
  if (r.damage) bits.push(r.damage + ' פגיעות');
  return bits.join(' · ') || (r.total + ' תקלות');
}

// ------------------------------------------------------------------
//  חלוקת עומסים
// ------------------------------------------------------------------
//
// שלושה סוגי עומס שלא מתערבבים:
//
//   אבטחות ביום חופש   יציאה מהבית. הנטל האמיתי
//   אבטחות במשמרת      נבלעות ב-24 השעות
//   החלפות             כמה פעמים הוא נכנס במקום מישהו
//
// ערבוב שלושתם למספר אחד היה מסתיר בדיוק את מה שאלדד רצה
// לראות: מי עושה הכל ומי לא נגע.

export function loadStats(people, guards, swaps, ctx, since) {
  const out = {};
  (people || []).forEach(function (p) {
    out[p.uid] = { uid: p.uid, name: p.name || '', crew: p.crew || '',
                   gOff: 0, gShift: 0, gUnknown: 0, gHours: 0,
                   swapIn: 0, swapOut: 0, last: '' };
  });

  (guards || []).forEach(function (g) {
    if (!g || g.status === 'cancelled') return;
    const key = String(g.date || '');
    if (!inWindow(key, since)) return;
    const hrs = guardHours(g) || 0;
    assignedOf(g).forEach(function (uid) {
      const r = out[uid];
      if (!r) return;
      const kind = dutyKind(ctx, uid, r.crew, key);
      if (kind === 'off') { r.gOff++; r.gHours += hrs; }
      else if (kind === 'shift') r.gShift++;
      else r.gUnknown++;     // מחוץ לסידור הידוע — לא נטל ולא „נבלע"; לא נכנס לציון
      if (key > r.last) r.last = key;
    });
  });

  (swaps || []).forEach(function (s) {
    if (!s || s.status !== 'approved') return;
    if (!inWindow(s.from_date, since) && !inWindow(s.to_date, since)) return;
    // מי שיצא מיום ומי שנכנס אליו. שני הכיוונים נספרים
    // בנפרד: מי שתמיד נכנס במקום אחרים נושא עומס, ומי
    // שתמיד יוצא — לא.
    const a = out[s.from_uid], b = out[s.to_uid];
    if (a) { a.swapOut++; a.swapIn++; }
    if (b) { b.swapIn++;  b.swapOut++; }
  });

  Object.keys(out).forEach(function (u) {
    out[u].gHours = Math.round(out[u].gHours * 100) / 100;
    out[u].score = out[u].gOff * 2 + out[u].gShift + out[u].swapIn;
  });
  return out;
}

// מדורג מהעמוס לפחות עמוס, כי השאלה היא "מי לוקח יותר מדי".
export function loadRank(map) {
  const list = Object.keys(map || {}).map(function (u) { return map[u]; });
  list.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.gOff !== a.gOff) return b.gOff - a.gOff;
    return String(a.name).localeCompare(String(b.name), 'he');
  });
  return list;
}

// עד כמה החלוקה הוגנת. פער בין העמוס ביותר לפחות עמוס,
// ביחס לממוצע.
//
// מספר בודד לא אומר אם המצב תקין, ולכן מוחזר גם משפט.
export function fairness(map) {
  const list = Object.keys(map || {}).map(function (u) { return map[u]; });
  if (list.length < 2) return { spread: 0, he: 'אין מספיק אנשים להשוואה.' };

  const scores = list.map(function (r) { return r.score; });
  const max = Math.max.apply(null, scores);
  const min = Math.min.apply(null, scores);
  const avg = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
  const spread = max - min;
  const zero = list.filter(function (r) { return r.score === 0; }).length;

  let he;
  if (!max) he = 'עוד לא נרשמו אבטחות או החלפות בתקופה.';
  else if (spread <= Math.max(2, avg * 0.5))
    he = 'החלוקה סבירה. הפער בין העמוס לפחות עמוס הוא ' + spread + ' נקודות.';
  else
    he = 'החלוקה לא אחידה: פער של ' + spread + ' נקודות בין העמוס ' +
         'לפחות עמוס' + (zero ? ', ו-' + zero + ' אנשים לא נגעו בכלל' : '') + '.';

  return { spread: spread, max: max, min: min,
           avg: Math.round(avg * 10) / 10, zero: zero, he: he };
}

// הסבר הניקוד. מדד שלא מסבירים אותו הוא מדד שמתווכחים עליו.
export const SCORE_WHY =
  'ניקוד = אבטחה ביום חופש שווה 2, אבטחה בתוך המשמרת שווה 1, ' +
  'וכניסה בהחלפה שווה 1. יום חופש שווה כפול כי שם הנטל האמיתי.';
