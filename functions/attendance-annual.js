'use strict';

/* ====================================================================
 *  attendance-annual — סיכום שנתי לכל עובד, ועדכון בטוח שלו כשיום
 *  ישן מתוקן.
 *
 *  מודול טהור. אין Firebase, אין רשת, אין תאריך מערכת — clock מוזרק.
 *  הוא **מתכנן ואינו כותב**.
 *
 *  --------------------------------------------------------------
 *  ⭐ קראו את זה לפני שמאשרים את המודול
 *  --------------------------------------------------------------
 *
 *  `hours.js:261-264` נושא הכרעה מפורשת של הקוד הזה:
 *
 *    „סך חודשי. מחושב מהרשומות בכל פעם ו**לא נשמר בשום מקום**.
 *     במערכת הקיימת הסך נשמר בנפרד מהגיליון, השניים התפצלו
 *     בפועל, ויש שם כפתור שכל תפקידו לתקן את הפער.
 *     **מה שלא נשמר לא מתפצל.**"
 *
 *  המשימה כאן היא בדיוק ההפך: לשמור סך. שנתי, לא חודשי, אבל
 *  אותה חשיפה — **מספר שמור שיכול להתפצל ממקור האמת.**
 *
 *  זה לא מקרי ולא נמנע: סך שנתי אי אפשר לחשב בדפדפן. 365 ימים
 *  כפול אלפי עובדים אינם שאילתה שמסך טוען. אז שומרים — אבל
 *  שומרים כך ש**פיצול לא יכול לקרות בשקט**:
 *
 *  1. **הסיכום נגזר, לעולם לא סמכותי.** רשומות היום הן מקור
 *     האמת. אם השניים חלוקים — הימים מנצחים, והסיכום מסומן
 *     `stale`.
 *
 *  2. **`digest` על התרומות.** כל סיכום נושא חתימה של בדיוק מה
 *     שנספר לתוכו. `verify()` בונה מחדש ומשווה שדה-שדה. זה
 *     „הכפתור" מהמערכת הישנה — רק שהוא אוטומטי ומדווח, ולא
 *     משהו שמישהו זוכר ללחוץ.
 *
 *  3. **דלתא אינה יכולה להתבצע בלי בסיס.** כדי לחסר יום ישן
 *     צריך לדעת מה הוא תרם. הפירוט המתגלגל ל-31 יום הוא
 *     הזיכרון הזה. מעבר לחלון — אין בסיס, ו`planDelta`
 *     **מסרב** ודורש בנייה מחדש. הוא אינו מנחש, אינו מאפס
 *     ואינו „מוסיף את החדש ומקווה".
 *
 *  4. **החלה חוזרת אינה סופרת פעמיים.** אותה תרומה בדיוק →
 *     `no-op`. ריצה כפולה של אותו תיקון היא תרחיש ודאי
 *     בענן, לא תרחיש קצה.
 *
 *  5. **שעות חסרות אינן אפס.** רשומה ישנה בלי שדה `hours`
 *     מסומנת `uncountable` ומדווחת. אפס שקט הוא בדיוק איך
 *     שסך שנתי יוצא נמוך ואיש לא שם לב.
 *
 *  --------------------------------------------------------------
 *  פרטיות
 *  --------------------------------------------------------------
 *
 *  רשומת היום נושאת `full_name`, `uid`, `emp_number`, ולעיתים
 *  `edited_by_name`. הסיכום נושא **`emp_number` ו-`uid` בלבד**.
 *
 *  שם אינו נשמר כאן בכוונה: הוא ניתן לצירוף מ-`users`, הוא
 *  מתיישן כשאדם משנה שם, והוא הופך אוסף סטטיסטי לאוסף שדליפה
 *  ממנו היא דליפת מידע אישי. `assertNoPii` סורק **ערכים** ולא
 *  רק שמות מפתחות.
 * ==================================================================== */

const SCHEMA_VERSION = 1;

const LIMITS = Object.freeze({
  DETAIL_DAYS: 31,          // חלון הפירוט המתגלגל
  MAX_DETAIL_ENTRIES: 40,   // גג קשיח, מעל החלון, לספיגת גלישה
  MAX_DAYS_PER_REBUILD: 400,
  MAX_SUB_STATIONS: 40,
  MAX_DAY_TYPES: 20
});

/* סוגי יום שנספרים כ**משמרת**.
 *
 * חופש, מחלה ומילואים נושאים שעות (24 · 0 · 8.5 ב-hours.js) אך
 * אינם משמרת שנעבדה. הם נספרים במלואם ב-by_day_type וב-hours,
 * ואינם נספרים ב-shifts. אם אלדד יחליט אחרת — זו שורה אחת.
 */
const SHIFT_DAY_TYPES = Object.freeze(
  ['regular', 'swap', 'extra', 'meeting', 'guard']);

const CODE = Object.freeze({
  SHAPE: 'annual-shape',
  YEAR_MISMATCH: 'annual-year-mismatch',
  EMP_MISMATCH: 'annual-emp-mismatch',
  NO_BASELINE: 'annual-no-baseline',
  TOO_MANY_DAYS: 'annual-too-many-days',
  PII: 'annual-pii'
});

const NOTE = Object.freeze({
  NOOP: 'delta-identical-no-op',
  UNCOUNTABLE: 'day-has-no-usable-hours',
  OUT_OF_WINDOW: 'day-older-than-detail-window',
  NEW_DAY: 'day-not-previously-counted',
  REMOVED: 'day-removed',
  STALE: 'summary-marked-stale'
});

class AnnualError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnnualError';
    this.code = code;
  }
}

/* ------------------------------ עזר ------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireDate(iso, what) {
  if (!isNonEmptyString(iso) || !DATE_RE.test(iso)) {
    throw new AnnualError(CODE.SHAPE, 'תאריך לא תקין: ' + what);
  }
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  const t = Date.UTC(y, m - 1, d), back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1
      || back.getUTCDate() !== d) {
    throw new AnnualError(CODE.SHAPE, 'תאריך שאינו קיים: ' + iso);
  }
  return iso;
}

function dayNumber(iso) {
  return Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10))) / 86400000);
}

// עיגול לשתי ספרות, כמו calcHours ב-hours.js. חיבור של floats
// בלי עיגול צובר שארית, ו-365 חיבורים כאלה מזיזים סך שנתי.
function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ------------------------------ PII ------------------------------ */

const FORBIDDEN_KEYS = Object.freeze([
  'full_name', 'name', 'display_name', 'first_name', 'last_name',
  'email', 'mail', 'phone', 'mobile', 'tel',
  'edited_by_name', 'approved_by_name', 'reopened_by_name',
  'notes', 'overtime_reason', 'id_number', 'personal_id'
]);

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(?:^|\D)(?:0\d{1,2}[- ]?\d{7}|\+972\d{8,9})(?:\D|$)/;
// שם מלא בעברית: שתי מילים עבריות ומעלה. הסיכום אינו אמור לשאת
// ולו מחרוזת עברית אחת חופשית, ולכן זה בטוח כאן.
const HEB_NAME_RE = /[֐-׿]{2,}\s+[֐-׿]{2,}/;

function assertNoPii(value, path) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) throw new AnnualError(CODE.PII, 'מייל ב-' + path);
    if (PHONE_RE.test(value)) throw new AnnualError(CODE.PII, 'טלפון ב-' + path);
    if (HEB_NAME_RE.test(value)) throw new AnnualError(CODE.PII, 'שם ב-' + path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPii(v, path + '[' + i + ']'));
    return;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.indexOf(k) !== -1) {
        throw new AnnualError(CODE.PII, 'שדה אסור ' + k + ' ב-' + path);
      }
      assertNoPii(value[k], path + '.' + k);
    }
  }
}

/* --------------------------- תרומת יום --------------------------- */

/**
 * מה יום אחד תורם לסיכום. **זו הישות היחידה שנספרת.**
 *
 * `hours` נלקח מהשדה השמור ואינו מחושב מחדש. חישוב מחדש כאן
 * היה עותק שני של calcHours שיוצא מסנכרון ביום שמישהו משנה
 * את אורך המשמרת של יטבתה.
 *
 * רשומה בלי `hours` שמיש → `countable: false`. לא אפס.
 */
function contributionOf(record) {
  if (!isPlainObject(record)) {
    throw new AnnualError(CODE.SHAPE, 'רשומת יום אינה תקינה');
  }
  const date = requireDate(record.date, 'רשומת יום');
  const dayType = isNonEmptyString(record.day_type) ? record.day_type : 'regular';
  const hours = record.hours;
  const countable = isFiniteNumber(hours) && hours >= 0;

  return Object.freeze({
    date,
    month: date.slice(5, 7),
    day_type: dayType,
    // תחנת קצה ריקה היא מצב חוקי — לא כל יום מיוחס לתחנת קצה.
    sub_station: isNonEmptyString(record.sub_station) ? record.sub_station : '',
    hours: countable ? round2(hours) : 0,
    countable,
    is_shift: SHIFT_DAY_TYPES.indexOf(dayType) !== -1
  });
}

/**
 * חתימה על תרומה. שתי תרומות עם אותה חתימה הן אותה תרומה
 * בדיוק, ולכן החלה חוזרת שלהן היא no-op.
 * מחרוזת ולא hash: קריאה בעין בלוג, ואין תלות ב-crypto.
 */
function contributionKey(c) {
  if (!c) return 'none';
  return [c.date, c.day_type, c.sub_station, c.hours,
    c.countable ? '1' : '0', c.is_shift ? '1' : '0'].join('|');
}

/* -------------------------- מבנה הסיכום -------------------------- */

function emptyBuckets() {
  return { shifts: 0, hours: 0, days: 0 };
}

function addTo(bucket, c, sign) {
  bucket.days += sign;
  if (c.is_shift) bucket.shifts += sign;
  bucket.hours = round2(bucket.hours + sign * c.hours);
  return bucket;
}

function bump(map, key, c, sign) {
  if (!Object.prototype.hasOwnProperty.call(map, key)) map[key] = emptyBuckets();
  addTo(map[key], c, sign);
  // דלי שהתרוקן נמחק. „yotvata: 0 משמרות" בסיכום של מי שלא
  // עבד שם מעולם הוא רעש שנראה כמו נתון.
  if (map[key].days === 0 && map[key].shifts === 0 && map[key].hours === 0) {
    delete map[key];
  }
}

function newSummary(emp, uid, year) {
  return {
    schema_version: SCHEMA_VERSION,
    emp_number: emp,
    uid: uid || null,
    year,
    shifts: 0,
    hours: 0,
    days: 0,
    uncountable_days: 0,
    by_month: {},
    by_sub_station: {},
    by_day_type: {},
    contribution_keys: {},   // date → contributionKey. זהו ה"בסיס".
    digest: '',
    revision: 0,
    stale: false,
    built_at: null,
    updated_at: null
  };
}

/**
 * חתימת הסיכום כולו — על התרומות, לא על המספרים. שני סיכומים
 * עם אותו digest נבנו מאותם ימים בדיוק.
 */
function summaryDigest(keys) {
  const dates = Object.keys(keys).sort();
  let h = 0;
  for (const d of dates) {
    const s = keys[d];
    for (let i = 0; i < s.length; i += 1) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
  }
  return dates.length + ':' + (h >>> 0).toString(16);
}

function recount(summary) {
  summary.digest = summaryDigest(summary.contribution_keys);
  return summary;
}

/* ============================ המודול ============================ */

function createAnnualAggregator(deps) {
  const d = deps || {};
  if (typeof d.clock !== 'function') {
    throw new AnnualError(CODE.SHAPE, 'חובה להזריק clock');
  }
  const clock = d.clock;
  const now = () => new Date(clock()).toISOString();

  /* -------------------- בנייה מלאה מחדש -------------------- */

  /**
   * @param {object} input  { emp_number, uid, year, days[] }
   * מקור האמת. `planDelta` מסרב במקרים שבהם רק זה נכון.
   */
  function rebuild(input) {
    if (!isPlainObject(input)) throw new AnnualError(CODE.SHAPE, 'קלט לא תקין');
    const emp = String(input.emp_number || '').trim();
    if (!emp) throw new AnnualError(CODE.SHAPE, 'חסר מספר עובד');
    const year = String(input.year || '').trim();
    if (!/^\d{4}$/.test(year)) throw new AnnualError(CODE.SHAPE, 'שנה לא תקינה');
    const days = Array.isArray(input.days) ? input.days : [];
    if (days.length > LIMITS.MAX_DAYS_PER_REBUILD) {
      throw new AnnualError(CODE.TOO_MANY_DAYS,
        'יותר מ-' + LIMITS.MAX_DAYS_PER_REBUILD + ' ימים לשנה אחת');
    }

    const s = newSummary(emp, input.uid || null, year);
    const notes = [];
    const seen = new Set();

    for (const rec of days) {
      const c = contributionOf(rec);
      if (c.date.slice(0, 4) !== year) {
        throw new AnnualError(CODE.YEAR_MISMATCH,
          'היום ' + c.date + ' אינו בשנה ' + year);
      }
      // מספר עובד: הרשומה שייכת לעובד הזה, או שהבנייה שגויה.
      if (rec.emp_number !== undefined && rec.emp_number !== null
          && String(rec.emp_number) !== emp) {
        throw new AnnualError(CODE.EMP_MISMATCH,
          'רשומת ' + c.date + ' שייכת לעובד אחר');
      }
      if (seen.has(c.date)) {
        // שני מסמכים לאותו יום. מזהה המסמך הוא emp_date, ולכן
        // זה לא אמור לקרות — אבל אם קרה, בליעה שקטה תכפיל יום.
        throw new AnnualError(CODE.SHAPE, 'היום ' + c.date + ' מופיע פעמיים');
      }
      seen.add(c.date);

      if (!c.countable) {
        s.uncountable_days += 1;
        notes.push({ code: NOTE.UNCOUNTABLE, date: c.date });
      }
      applyContribution(s, c, +1);
      s.contribution_keys[c.date] = contributionKey(c);
    }

    s.built_at = now();
    s.updated_at = s.built_at;
    s.revision = 1;
    s.stale = false;
    recount(s);
    assertNoPii(s, 'annual');
    return { summary: s, notes };
  }

  function applyContribution(s, c, sign) {
    s.days += sign;
    if (c.is_shift) s.shifts += sign;
    s.hours = round2(s.hours + sign * c.hours);
    bump(s.by_month, c.month, c, sign);
    bump(s.by_day_type, c.day_type, c, sign);
    if (c.sub_station) bump(s.by_sub_station, c.sub_station, c, sign);
  }

  /* ---------------------- הפירוט המתגלגל ---------------------- */

  /**
   * הפירוט הוא מסמך אחד לעובד: `days` מיפוי תאריך → תרומה,
   * חלון מתגלגל של 31 יום. מסמך אחד ולא אוסף — כדי שהעדכון
   * שלו והעדכון של הסיכום יוכלו לשבת ב**עסקה אחת**.
   */
  function planRetention(input) {
    if (!isPlainObject(input)) throw new AnnualError(CODE.SHAPE, 'קלט לא תקין');
    const today = requireDate(input.today, 'היום');
    const keep = isFiniteNumber(input.keep_days) ? input.keep_days : LIMITS.DETAIL_DAYS;
    const detail = isPlainObject(input.detail) && isPlainObject(input.detail.days)
      ? input.detail.days : {};
    const cutoff = dayNumber(today) - keep + 1;

    const drop = [];
    const kept = {};
    for (const date of Object.keys(detail).sort()) {
      if (dayNumber(date) < cutoff) drop.push(date);
      else kept[date] = detail[date];
    }
    return {
      window_from: fromDay(cutoff),
      window_to: today,
      keep_days: keep,
      drop,
      days: kept,
      // אחרי הגיזום, אלה הימים שעדיין אפשר לתקן בבטחה.
      correctable_from: fromDay(cutoff)
    };
  }

  function fromDay(n) {
    return new Date(n * 86400000).toISOString().slice(0, 10);
  }

  /* ------------------------ עדכון בטוח ------------------------ */

  /**
   * תיקון יום — חדש, שינוי או מחיקה.
   *
   * @param {object} input
   *   summary  הסיכום הקיים
   *   detail   מסמך הפירוט המתגלגל  { days: {date: contribution} }
   *   before   הרשומה כפי שהייתה, או null
   *   after    הרשומה החדשה, או null (מחיקה)
   *
   * מחזיר { kind, summary, detail, notes, refused? }
   *
   * ⭐ **מסרב** כשהיום כבר נספר בסיכום ואין לו בסיס — לא בפירוט
   * ולא ב-before שנמסר. בלי לדעת מה הוא תרם, כל חיסור הוא ניחוש.
   */
  function planDelta(input) {
    if (!isPlainObject(input) || !isPlainObject(input.summary)) {
      throw new AnnualError(CODE.SHAPE, 'חסר סיכום');
    }
    const s = clone(input.summary);
    if (s.schema_version !== SCHEMA_VERSION) {
      throw new AnnualError(CODE.SHAPE, 'גרסת סכמה לא נתמכת');
    }
    const detail = isPlainObject(input.detail) ? clone(input.detail) : { days: {} };
    if (!isPlainObject(detail.days)) detail.days = {};

    const after = input.after === null || input.after === undefined
      ? null : contributionOf(input.after);
    const beforeGiven = input.before === null || input.before === undefined
      ? null : contributionOf(input.before);

    const target = after || beforeGiven;
    if (!target) throw new AnnualError(CODE.SHAPE, 'אין לא before ולא after');
    const date = target.date;
    if (after && beforeGiven && after.date !== beforeGiven.date) {
      throw new AnnualError(CODE.SHAPE, 'before ו-after אינם על אותו יום');
    }
    if (date.slice(0, 4) !== s.year) {
      throw new AnnualError(CODE.YEAR_MISMATCH,
        'היום ' + date + ' אינו בשנה ' + s.year);
    }
    if (after && after.date && input.after.emp_number !== undefined
        && input.after.emp_number !== null
        && String(input.after.emp_number) !== String(s.emp_number)) {
      throw new AnnualError(CODE.EMP_MISMATCH, 'הרשומה שייכת לעובד אחר');
    }

    const notes = [];
    const counted = Object.prototype.hasOwnProperty.call(s.contribution_keys, date);
    const priorKey = counted ? s.contribution_keys[date] : null;

    // הבסיס: מה היום הזה תרם עד עכשיו.
    // סדר העדיפויות מכוון — הפירוט קודם ל-before שנמסר, כי
    // הפירוט הוא מה שהסיכום באמת נבנה ממנו.
    let baseline = null;
    if (counted) {
      const fromDetail = detail.days[date];
      if (isPlainObject(fromDetail)) {
        baseline = normalizeStoredContribution(fromDetail);
      } else if (beforeGiven && contributionKey(beforeGiven) === priorKey) {
        baseline = beforeGiven;
      } else {
        // ⭐ נספר, ואין ממה לחסר.
        return {
          kind: 'refused',
          code: CODE.NO_BASELINE,
          date,
          refused: true,
          summary: markStale(s, date),
          detail,
          notes: [{ code: NOTE.OUT_OF_WINDOW, date },
                  { code: NOTE.STALE, date }],
          remedy: 'rebuild',
          message: 'היום ' + date + ' כבר נספר בסיכום, אך אינו בחלון '
            + 'הפירוט ולא נמסר עבורו before תואם. חיסור בלי בסיס הוא '
            + 'ניחוש — הסיכום סומן stale ודורש rebuild.'
        };
      }
    }

    // החלה חוזרת: אותה תרומה בדיוק.
    const nextKey = after ? contributionKey(after) : null;
    if (counted && nextKey !== null && nextKey === priorKey) {
      return { kind: 'noop', summary: s, detail,
        notes: [{ code: NOTE.NOOP, date }] };
    }
    if (!counted && after === null) {
      // מחיקה של יום שמעולם לא נספר.
      return { kind: 'noop', summary: s, detail,
        notes: [{ code: NOTE.NOOP, date }] };
    }

    if (baseline) applyContribution(s, baseline, -1);
    else if (after) notes.push({ code: NOTE.NEW_DAY, date });

    if (after) {
      if (!after.countable) {
        notes.push({ code: NOTE.UNCOUNTABLE, date });
      }
      applyContribution(s, after, +1);
      s.contribution_keys[date] = nextKey;
      detail.days[date] = plainContribution(after);
    } else {
      delete s.contribution_keys[date];
      delete detail.days[date];
      notes.push({ code: NOTE.REMOVED, date });
    }

    // uncountable_days נספר מחדש מהמפתחות, ולא מתוחזק בדלתא —
    // מונה שמתוחזק בשני מקומות מתפצל.
    s.uncountable_days = countUncountable(s, detail);

    s.revision = (Number(s.revision) || 0) + 1;
    s.updated_at = now();
    recount(s);
    assertNoPii(s, 'annual');

    return {
      kind: after ? (counted ? 'updated' : 'created') : 'deleted',
      date,
      summary: s,
      detail,
      notes
    };
  }

  /* --------------------------- אימות --------------------------- */

  /**
   * בונה מחדש מהימים ומשווה. **זהו „הכפתור" מהמערכת הישנה** —
   * רק שהוא מדווח ואינו מתקן בשקט.
   */
  function verify(input) {
    if (!isPlainObject(input) || !isPlainObject(input.summary)) {
      throw new AnnualError(CODE.SHAPE, 'חסר סיכום');
    }
    const stored = input.summary;
    const fresh = rebuild({
      emp_number: stored.emp_number,
      uid: stored.uid,
      year: stored.year,
      days: input.days || []
    }).summary;

    const drift = [];
    for (const field of ['shifts', 'hours', 'days', 'uncountable_days']) {
      if (stored[field] !== fresh[field]) {
        drift.push({ field, stored: stored[field], actual: fresh[field] });
      }
    }
    for (const group of ['by_month', 'by_sub_station', 'by_day_type']) {
      const a = stored[group] || {}, b = fresh[group] || {};
      for (const k of new Set(Object.keys(a).concat(Object.keys(b)))) {
        if (JSON.stringify(a[k] || null) !== JSON.stringify(b[k] || null)) {
          drift.push({ field: group + '.' + k, stored: a[k] || null, actual: b[k] || null });
        }
      }
    }
    const digestMatch = stored.digest === fresh.digest;
    if (!digestMatch && !drift.length) {
      // המספרים זהים אך הימים אינם. זה קורה כששני ימים שונים
      // מבטלים זה את זה — וזו בדיוק הדליפה שמספרים לבדם מפספסים.
      drift.push({ field: 'digest', stored: stored.digest, actual: fresh.digest });
    }

    return {
      ok: drift.length === 0,
      digest_match: digestMatch,
      drift,
      rebuilt: fresh,
      checked_at: now()
    };
  }

  /* -------------------------- פנימיים -------------------------- */

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function markStale(s, date) {
    const out = clone(s);
    out.stale = true;
    out.stale_since = now();
    out.stale_date = date;
    return out;
  }

  function plainContribution(c) {
    return { date: c.date, month: c.month, day_type: c.day_type,
      sub_station: c.sub_station, hours: c.hours,
      countable: c.countable, is_shift: c.is_shift };
  }

  function normalizeStoredContribution(raw) {
    if (!isPlainObject(raw) || !isNonEmptyString(raw.date)) {
      throw new AnnualError(CODE.SHAPE, 'תרומה שמורה אינה תקינה');
    }
    return Object.freeze({
      date: requireDate(raw.date, 'תרומה שמורה'),
      month: isNonEmptyString(raw.month) ? raw.month : raw.date.slice(5, 7),
      day_type: isNonEmptyString(raw.day_type) ? raw.day_type : 'regular',
      sub_station: isNonEmptyString(raw.sub_station) ? raw.sub_station : '',
      hours: isFiniteNumber(raw.hours) ? round2(raw.hours) : 0,
      countable: raw.countable === true,
      is_shift: raw.is_shift === true
    });
  }

  function countUncountable(s, detail) {
    let n = 0;
    for (const date of Object.keys(s.contribution_keys)) {
      const stored = detail.days[date];
      if (isPlainObject(stored)) { if (stored.countable !== true) n += 1; continue; }
      // מחוץ לחלון: הדגל נלקח מהמפתח עצמו, השדה החמישי.
      const parts = String(s.contribution_keys[date]).split('|');
      if (parts[4] !== '1') n += 1;
    }
    return n;
  }

  return Object.freeze({
    rebuild,
    planDelta,
    planRetention,
    verify,
    contributionOf,
    contributionKey,
    assertNoPii,
    SCHEMA_VERSION,
    SHIFT_DAY_TYPES,
    LIMITS,
    CODE,
    NOTE
  });
}

module.exports = {
  createAnnualAggregator,
  AnnualError,
  contributionOf,
  contributionKey,
  assertNoPii,
  SCHEMA_VERSION,
  SHIFT_DAY_TYPES,
  LIMITS,
  CODE,
  NOTE,
  FORBIDDEN_KEYS
};
