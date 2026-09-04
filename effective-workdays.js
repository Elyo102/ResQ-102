/* ======================================================================
 * הסידור האפקטיבי בדפדפן — „האם אדם X עובד בתאריך Y?"
 *
 * עד היום ארבעה מסכים (נוכחות, אבטחות, נתונים, החלפות) קיבלו מהשרת
 * את מחזור המשמרות והחריגים (getLegacyScheduleCompatibilityContext)
 * וחישבו לבד, ב-rotation.js, מי עובד. במצב `new` השרת מסרב לתת את
 * המחזור — ובצדק: הסידור הוא הפרסום, לא המחזור.
 *
 * עכשיו התשובה מגיעה מהשרת מוכנה, מ-getEffectiveWorkdays: לכל מזהה
 * שביקשנו — רשימת התאריכים שבהם הוא עובד; ובנפרד — אילו תאריכים
 * בטווח **לא ידועים** (מחוץ לכיסוי הפרסום) ואילו מזהים לא ידועים
 * (אינם בסגל הפרסום). שלושה ערכים, לא שניים:
 *
 *     worksOn(ctx, uid, key) → true · false · 'unknown'
 *
 * לא-ידוע **אינו** „לא עובד". מסך שמתייחס אליו כ„יום חופש" ימלא
 * נוכחות, יזכה שעות אבטחה או יאשר החלפה על סמך מידע שאין לו.
 *
 * המודול הזה אינו נוגע ב-DOM ולא ב-Firebase, כדי שייבדק לבד.
 * ====================================================================== */

import { swapEffect } from './rotation.js?v=42g0';

export const WORKDAYS_MODES = Object.freeze(['off', 'shadow', 'new']);
export const WORKDAYS_SOURCES = Object.freeze(['legacy', 'publication']);
export const WORKDAYS_MAX_UIDS = 500;
export const WORKDAYS_MAX_RANGE_DAYS = 397;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHIFT_HOUR_FIELDS = Object.freeze([
  'shift_start', 'shift_end', 'shift_hours', 'commander_start',
  'commander_shift_hours', 'special_end', 'special_shift_hours'
]);

function plain(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function dateKeyOf(value) {
  if (value instanceof Date) {
    return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') +
      '-' + String(value.getDate()).padStart(2, '0');
  }
  return String(value || '');
}

export function addDaysKey(key, n) {
  const p = String(key).split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return dateKeyOf(d);
}

/* התשובה מהשרת עוברת רשימת היתר קפדנית. תשובה פגומה נזרקת — לא הופכת
 * למערכים ריקים שמסווגים את כל התחנה כ„לא עובדים". */
export function parseEffectiveWorkdays(result) {
  const data = result && result.data;
  if (!plain(data)) fail('workdays-shape');
  if (WORKDAYS_MODES.indexOf(data.mode) === -1) fail('workdays-mode');
  if (WORKDAYS_SOURCES.indexOf(data.source) === -1) fail('workdays-source');
  if (data.fallback !== null && data.fallback !== 'legacy') fail('workdays-fallback');
  if (!DATE_RE.test(String(data.from || '')) || !DATE_RE.test(String(data.to || '')) || data.from > data.to) {
    fail('workdays-range');
  }
  if (!Array.isArray(data.unknown_dates) || data.unknown_dates.some((d) => !DATE_RE.test(String(d)))) {
    fail('workdays-unknown-dates');
  }
  if (!plain(data.by_uid)) fail('workdays-by-uid');
  if (!plain(data.unknown_uids)) fail('workdays-unknown-uids');
  const byUid = new Map();
  Object.keys(data.by_uid).forEach((uid) => {
    const list = data.by_uid[uid];
    if (!Array.isArray(list) || list.some((d) => !DATE_RE.test(String(d)) || d < data.from || d > data.to)) {
      fail('workdays-by-uid');
    }
    byUid.set(uid, new Set(list));
  });
  const unknownUids = Object.create(null);   // UID בשם __proto__ אינו קובע prototype
  Object.keys(data.unknown_uids).forEach((uid) => {
    const why = data.unknown_uids[uid];
    if (why !== 'not-in-roster' && why !== 'invalid') fail('workdays-unknown-uids');
    unknownUids[uid] = why;
  });
  let coverage = null;
  if (data.coverage !== null && data.coverage !== undefined) {
    if (!plain(data.coverage) || !DATE_RE.test(String(data.coverage.from || ''))
        || !DATE_RE.test(String(data.coverage.to || ''))) fail('workdays-coverage');
    coverage = { from: data.coverage.from, to: data.coverage.to };
  }
  let shiftHours = null;
  if (data.shift_hours !== null && data.shift_hours !== undefined) {
    if (!plain(data.shift_hours)) fail('workdays-shift-hours');
    shiftHours = {};
    SHIFT_HOUR_FIELDS.forEach((field) => {
      const v = data.shift_hours[field];
      if (typeof v === 'string' || typeof v === 'number') shiftHours[field] = v;
    });
  }
  return Object.freeze({
    mode: data.mode,
    source: data.source,
    fallback: data.fallback,
    from: data.from,
    to: data.to,
    coverage,
    unknownDates: new Set(data.unknown_dates),
    unknownUids: Object.freeze(unknownUids),
    byUid,
    shiftHours: shiftHours ? Object.freeze(shiftHours) : null,
    provenance: plain(data.provenance) ? JSON.parse(JSON.stringify(data.provenance)) : null
  });
}

/* שני חלונות (למשל היסטוריה ועתיד) מאותו מקור — מתאחדים. מקור שונה,
 * מצב שונה, או חפיפה בתאריכים — סירוב: תשובה מעורבבת גרועה מאין תשובה. */
export function mergeEffectiveWorkdays(parts) {
  const list = (parts || []).filter(Boolean);
  if (!list.length) fail('workdays-merge-empty');
  const head = list[0];
  const sig = (p) => JSON.stringify([p.mode, p.source, p.fallback, p.provenance]);
  const byUid = new Map();
  const unknownDates = new Set();
  const unknownUids = Object.create(null);   // UID בשם __proto__ אינו קובע prototype
  let from = head.from;
  let to = head.to;
  const seen = new Set();
  list.forEach((p) => {
    if (sig(p) !== sig(head)) fail('workdays-merge-source');
    if (seen.has(p.from + '..' + p.to)) fail('workdays-merge-overlap');
    // חפיפה בין חלונות: אותו יום בשני חלונות.
    list.forEach((q) => {
      if (q !== p && !(p.to < q.from || q.to < p.from)) fail('workdays-merge-overlap');
    });
    seen.add(p.from + '..' + p.to);
    if (p.from < from) from = p.from;
    if (p.to > to) to = p.to;
    p.unknownDates.forEach((d) => unknownDates.add(d));
    Object.keys(p.unknownUids).forEach((u) => { unknownUids[u] = p.unknownUids[u]; });
    p.byUid.forEach((dates, uid) => {
      if (!byUid.has(uid)) byUid.set(uid, new Set());
      dates.forEach((d) => byUid.get(uid).add(d));
    });
  });
  // מזהה שידוע בחלון אחד ולא-ידוע באחר: לא-ידוע גובר — לא ממציאים לו ימים.
  Object.keys(unknownUids).forEach((u) => byUid.delete(u));
  // ימים שבין החלונות (אם יש רווח) — לא ידועים.
  const covered = new Set();
  list.forEach((p) => { for (let k = p.from; k <= p.to; k = addDaysKey(k, 1)) covered.add(k); });
  for (let k = from; k <= to; k = addDaysKey(k, 1)) if (!covered.has(k)) unknownDates.add(k);
  return Object.freeze({
    mode: head.mode, source: head.source, fallback: head.fallback, from, to,
    coverage: head.coverage, unknownDates, unknownUids: Object.freeze(unknownUids), byUid,
    shiftHours: head.shiftHours, provenance: head.provenance
  });
}

/* true · false · 'unknown' */
export function worksOn(ctx, uid, dateKey) {
  if (!ctx || !uid) return 'unknown';
  const key = dateKeyOf(dateKey);
  if (!DATE_RE.test(key) || key < ctx.from || key > ctx.to) return 'unknown';
  if (ctx.unknownDates.has(key)) return 'unknown';
  if (Object.prototype.hasOwnProperty.call(ctx.unknownUids, uid)) return 'unknown';
  if (!ctx.byUid.has(uid)) return 'unknown';
  return ctx.byUid.get(uid).has(key);
}

/* כמה ימים לא ידועים יש בטווח נתון (למשל חודש מוצג). */
export function unknownDaysBetween(ctx, fromKey, toKey) {
  const out = [];
  if (!ctx) return out;
  for (let k = fromKey; k <= toKey; k = addDaysKey(k, 1)) {
    if (k < ctx.from || k > ctx.to || ctx.unknownDates.has(k)) out.push(k);
  }
  return out;
}

/* תצורת שעות המשמרת כאובייקט בצורת רשומת מחזור, כדי ש-shiftTimes()
 * הוותיק ימשיך לעבוד גם כשאין מחזור בדפדפן (מצב new). */
export function shiftRotationShim(ctx) {
  if (!ctx || !ctx.shiftHours) return null;
  return Object.assign({}, ctx.shiftHours);
}

/* ---------- החלפות: „האם יעבוד" אחרי החלפה מוצעת ----------
 *
 * החלפה שעדיין לא נשמרה: gainKey היום שנכנס אליו, loseKey היום
 * שיוצא ממנו. החלפות שכבר אושרו: ב-legacy הן כבר חלות בתשובת השרת,
 * ובפרסום (new) הן אינן חלק ממנו — השכבה כאן זהה בשני המקרים (סופה
 * זהה, ראה worksAfterSwap בשרת). */
export function wouldWorkEffective(ctx, swaps, uid, key, gainKey, loseKey) {
  if (!key) return 'unknown';
  if (loseKey && key === loseKey) return false;
  if (gainKey && key === gainKey) return true;
  const eff = swapEffect(swaps, uid, key);
  if (eff === 'out') return false;
  if (eff === 'in') return true;
  return worksOn(ctx, uid, key);
}

/* הימים הצמודים: `days` — עובד בהם (הפרה); `unknown` — אי אפשר לדעת. */
export function restConflictsEffective(ctx, swaps, uid, gainKey, loseKey) {
  const out = { days: [], unknown: [] };
  if (!gainKey) return out;
  [addDaysKey(gainKey, -1), addDaysKey(gainKey, 1)].forEach((k) => {
    const v = wouldWorkEffective(ctx, swaps, uid, k, gainKey, loseKey);
    if (v === true) out.days.push(k);
    else if (v === 'unknown') out.unknown.push(k);
  });
  return out;
}

/* a/b = { uid, name, gain, lose }. מחזיר הפרות; רשומה עם `unknown`
 * אינה „חוקית" — היא „לא ניתן לאמת". */
export function swapRestCheckEffective(ctx, swaps, a, b) {
  const out = [];
  [a, b].forEach((p) => {
    if (!p || !p.gain) return;
    const hits = restConflictsEffective(ctx, swaps, p.uid, p.gain, p.lose);
    if (hits.days.length || hits.unknown.length) {
      out.push({ uid: p.uid, name: p.name || '', gain: p.gain, days: hits.days, unknown: hits.unknown });
    }
  });
  return out;
}

export function restWhyEffective(v) {
  if (!v) return '';
  const dm = (k) => { const p = String(k).split('-'); return Number(p[2]) + '.' + Number(p[1]); };
  const g = dm(v.gain);
  if (v.unknown && v.unknown.length) {
    return (v.name || 'הכבאי') + ': ' + v.unknown.map(dm).join(' ו-') +
      ' מחוץ לסידור המפורסם, ולכן אי אפשר לאמת יום מנוחה סביב ' + g + '.';
  }
  return (v.name || 'הכבאי') + ' עובד ב-' + v.days.map(dm).join(' ו-') +
    ', והחלפה ל-' + g + ' תיצור 48 שעות רצוף.';
}

/* טקסט קצר למצב, למסכים שמציגים מקור. */
export function workdaysSourceLabel(ctx) {
  if (!ctx) return '';
  if (ctx.source === 'publication') return 'הסידור המפורסם';
  if (ctx.mode === 'new' && ctx.fallback === 'legacy') return 'הסידור הקיים (אין פרסום פעיל)';
  return 'הסידור הקיים';
}
