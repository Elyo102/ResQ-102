'use strict';

/* ======================================================================
 * ימי עבודה אפקטיביים — „מי עובד בתאריך X?" · מודול טהור (seq377/385 D)
 *
 * העיקרון (אושר ב-seq385): התשובה היא **רשימת אנשים, או „לא ידוע"**.
 * לעולם לא צוות, ולעולם לא „לא עובד" מחוץ לכיסוי.
 *
 * המודול אינו קורא דבר. הוא מקבל את מה שהמתאם הקיים
 * (`schedule-effective-reader` → `schedule-operational-projection`) כבר
 * הפיק — חלונות של ≤93 יום בצורה `{date, assignments:[{uid, display,
 * sub_station?, role?, source}]}` — יחד עם הכיסוי של המקור, ומרכיב מהם
 * את התשובה לטווח המבוקש (עד 397 יום כולל שני הקצוות).
 *
 * שני סוגי „לא ידוע", ושניהם מפורשים:
 *   · `unknown_dates`  — תאריך בטווח שאף חלון לא כיסה (מחוץ לפרסום).
 *   · `unknown_uids`   — מזהה שנשאל עליו ואינו בסגל של המקור
 *                        (`not-in-roster`), או שאינו מזהה תקין (`invalid`).
 *     אדם כזה אינו „בחופש" — עליו פשוט אין תשובה מהמקור הזה.
 *
 * מה שאינו כאן בכוונה (Codex, seq385 §4): שעות משמרת. אין כאן `hours`,
 * ואין ברירת מחדל של 24. משך, אם קיים, יגיע per-assignment ממקורו.
 * ====================================================================== */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/u;
const MAX_RANGE_DAYS = 397;        // כולל שני הקצוות
const MAX_WINDOW_DAYS = 93;        // תקרת המתאם הקיים — לא מעלים בשקט
const MAX_UIDS = 500;
const DAY_MS = 86400000;

class EffectiveWorkdaysError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EffectiveWorkdaysError';
    this.code = code;
  }
}
function fail(code, message) {
  throw new EffectiveWorkdaysError(code, message);
}
function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function ordinal(iso) {
  if (!DATE_RE.test(String(iso || ''))) fail('range-date', 'תאריך אינו בצורה YYYY-MM-DD');
  const t = Date.parse(iso + 'T00:00:00Z');
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== iso) {
    fail('range-date', 'תאריך אינו קיים בלוח השנה');
  }
  return Math.floor(t / DAY_MS);
}
function isoOf(ord) {
  return new Date(ord * DAY_MS).toISOString().slice(0, 10);
}

/* מפתחות UID במפות: null-prototype בפנים, ו-own-properties בפלט —
 * "__proto__" כ-uid היה קובע את ה-prototype של המפה במקום להיכתב כשדה
 * (אותה משפחה כמו 0a52c2a/ae17ea3). UID אינו נפסל; המפה נזהרת. */
function plainCopy(map) {
  const out = {};
  Object.keys(map).forEach((key) => {
    Object.defineProperty(out, key, { value: map[key], enumerable: true, writable: true, configurable: true });
  });
  return out;
}

/* טווח כולל: `to - from + 1 ≤ 397`. */
function normalizeRange(from, to) {
  const a = ordinal(from);
  const b = ordinal(to);
  if (b < a) fail('range-order', 'תאריך הסיום לפני ההתחלה');
  if (b - a + 1 > MAX_RANGE_DAYS) fail('range-too-long', 'הטווח ארוך מ-' + MAX_RANGE_DAYS + ' ימים');
  const dates = [];
  for (let o = a; o <= b; o += 1) dates.push(isoOf(o));
  return Object.freeze({ from, to, dates });
}

/* מזהים: מחרוזות בלבד. ערך שאינו מחרוזת נדחה במפורש (417 §5) — עד כאן
 * המספר 7 הפך ל-'7' ב-invalid והעלים את המחרוזת '7' התקינה שלצדו.
 * מחרוזת שאינה בתבנית — מדווחת כ-`invalid`, לא נזרקת. */
function normalizeUids(uids) {
  if (!Array.isArray(uids)) fail('uids-shape', 'uids חייב להיות מערך');
  if (uids.length > MAX_UIDS) fail('uids-too-many', 'יותר מ-' + MAX_UIDS + ' מזהים');
  if (uids.some((raw) => typeof raw !== 'string')) fail('uids-type', 'כל מזהה חייב להיות מחרוזת');
  const out = [];
  const invalid = [];
  const seen = new Set();
  uids.forEach((uid) => {
    if (!UID_RE.test(uid)) { if (invalid.indexOf(uid) === -1) invalid.push(uid); return; }
    if (seen.has(uid)) return;
    seen.add(uid);
    out.push(uid);
  });
  return { uids: out, invalid };
}

/* מחלק טווח (ואם ניתן — את החיתוך שלו עם הכיסוי) לחלונות של ≤93 יום.
 * מחוץ לכיסוי אין חלון — אלה ימים „לא ידועים". */
function windowsFor(range, coverage) {
  const a = ordinal(range.from);
  const b = ordinal(range.to);
  let lo = a;
  let hi = b;
  if (coverage) {
    lo = Math.max(a, ordinal(coverage.from));
    hi = Math.min(b, ordinal(coverage.to));
  }
  const windows = [];
  for (let start = lo; start <= hi; start += MAX_WINDOW_DAYS) {
    const end = Math.min(hi, start + MAX_WINDOW_DAYS - 1);
    windows.push(Object.freeze({ from: isoOf(start), to: isoOf(end) }));
  }
  return Object.freeze(windows);
}

/* מרכיב את התשובה מחלונות שכבר הופקו.
 *
 * input = {
 *   source: 'legacy' | 'publication',
 *   range: { from, to },
 *   coverage: { from, to } | null,        // publication: plan.from/to · legacy: הטווח עצמו
 *   windows: [ { from, to, days:[{date, assignments:[{uid, display, sub_station?, role?}]}] } ],
 *   uids: [uid],                            // על מי שואלים
 *   roster: [uid] | null                    // הסגל של המקור (publication); null = לא נבדק
 * } */
function assemble(input) {
  if (!plain(input)) fail('input-shape', 'קלט חסר');
  if (input.source !== 'legacy' && input.source !== 'publication') fail('source', 'מקור לא מוכר');
  const range = normalizeRange(String(input.range && input.range.from || ''),
    String(input.range && input.range.to || ''));
  const coverage = input.coverage ? Object.freeze({
    from: String(input.coverage.from || ''), to: String(input.coverage.to || '')
  }) : null;
  if (coverage) { ordinal(coverage.from); ordinal(coverage.to); }
  const { uids, invalid } = normalizeUids(input.uids);

  const expected = windowsFor(range, coverage);
  const given = Array.isArray(input.windows) ? input.windows : [];
  if (given.length !== expected.length) fail('windows-mismatch', 'מספר החלונות אינו תואם לטווח');
  const byDate = new Map();
  expected.forEach((w, i) => {
    const g = given[i];
    if (!plain(g) || g.from !== w.from || g.to !== w.to || !Array.isArray(g.days)) {
      fail('windows-mismatch', 'חלון ' + i + ' אינו תואם');
    }
    g.days.forEach((day) => {
      if (!plain(day) || !DATE_RE.test(String(day.date || '')) || !Array.isArray(day.assignments)) {
        fail('window-day', 'יום בחלון אינו תקין');
      }
      // יום מחוץ לחלון שלו (ולכן מחוץ לכיסוי) — המתאם הקיים מסנן, וכאן
      // נסגר בכל זאת: תשובה שמכילה יום שלא ביקשו היא תשובה זרה.
      if (day.date < w.from || day.date > w.to) fail('window-day-outside', 'יום מחוץ לחלון שלו');
      if (byDate.has(day.date)) fail('window-day-duplicate', 'יום מופיע בשני חלונות');
      byDate.set(day.date, day.assignments);
    });
  });

  const rosterSet = Array.isArray(input.roster) ? new Set(input.roster.map(String)) : null;
  const unknownUids = Object.create(null);
  invalid.forEach((raw) => { unknownUids[raw] = 'invalid'; });
  const asked = new Set(uids);
  if (rosterSet) {
    uids.forEach((uid) => { if (!rosterSet.has(uid)) unknownUids[uid] = 'not-in-roster'; });
  }

  const byUid = Object.create(null);
  uids.forEach((uid) => { if (!unknownUids[uid]) byUid[uid] = []; });
  const unknownDates = [];
  const working = Object.create(null);
  range.dates.forEach((date) => {
    if (!byDate.has(date)) { unknownDates.push(date); return; }
    const list = byDate.get(date);
    const people = [];
    const seen = new Set();
    list.forEach((assignment) => {
      if (!plain(assignment) || !UID_RE.test(String(assignment.uid || ''))) fail('assignment', 'שיבוץ אינו תקין');
      if (seen.has(assignment.uid)) fail('assignment-duplicate', 'אדם משובץ פעמיים באותו יום');
      seen.add(assignment.uid);
      const entry = { uid: assignment.uid };
      if (typeof assignment.display === 'string') entry.display = assignment.display;
      if (typeof assignment.sub_station === 'string') entry.sub_station = assignment.sub_station;
      if (typeof assignment.role === 'string') entry.role = assignment.role;
      people.push(Object.freeze(entry));
      if (asked.has(assignment.uid) && byUid[assignment.uid]) byUid[assignment.uid].push(date);
    });
    working[date] = Object.freeze(people);
  });

  return Object.freeze({
    source: input.source,
    range: Object.freeze({ from: range.from, to: range.to }),
    coverage,
    unknown_dates: Object.freeze(unknownDates),
    unknown_uids: Object.freeze(plainCopy(unknownUids)),
    by_uid: Object.freeze(plainCopy(Object.keys(byUid).reduce((acc, uid) => {
      acc[uid] = Object.freeze(byUid[uid]);
      return acc;
    }, Object.create(null)))),
    working: Object.freeze(plainCopy(working))
  });
}

/* תשובה שכולה „לא ידוע": למקור אין שום סידור לטווח (למשל תחנה שאין
 * לה אף רשומת מחזור). אין כאן חלונות, אין כיסוי, ואין יום אחד שבו
 * מישהו „בחופש" — כל יום בטווח נכנס ל-unknown_dates. מי שנשאל עליו
 * ואינו בסגל של המקור → not-in-roster; מי שבסגל מקבל רשימה ריקה,
 * שאינה אומרת דבר כי כל הימים לא ידועים. (419) */
function assembleUnknown(input) {
  if (!plain(input)) fail('input-shape', 'קלט חסר');
  if (input.source !== 'legacy' && input.source !== 'publication') fail('source', 'מקור לא מוכר');
  const range = normalizeRange(String(input.range && input.range.from || ''),
    String(input.range && input.range.to || ''));
  const { uids, invalid } = normalizeUids(input.uids);
  const rosterSet = Array.isArray(input.roster) ? new Set(input.roster.map(String)) : null;
  const unknownUids = Object.create(null);
  invalid.forEach((raw) => { unknownUids[raw] = 'invalid'; });
  if (rosterSet) {
    uids.forEach((uid) => { if (!rosterSet.has(uid)) unknownUids[uid] = 'not-in-roster'; });
  }
  const byUid = Object.create(null);
  uids.forEach((uid) => { if (!unknownUids[uid]) byUid[uid] = Object.freeze([]); });
  return Object.freeze({
    source: input.source,
    range: Object.freeze({ from: range.from, to: range.to }),
    coverage: null,
    unknown_dates: Object.freeze(range.dates.slice()),
    unknown_uids: Object.freeze(plainCopy(unknownUids)),
    by_uid: Object.freeze(plainCopy(byUid)),
    working: Object.freeze({})
  });
}

module.exports = Object.freeze({
  EffectiveWorkdaysError,
  MAX_RANGE_DAYS,
  MAX_WINDOW_DAYS,
  MAX_UIDS,
  normalizeRange,
  normalizeUids,
  windowsFor,
  assemble,
  assembleUnknown
});
