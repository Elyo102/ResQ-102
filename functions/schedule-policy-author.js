'use strict';

/* ====================================================================
 *  schedule-policy-author — הפיכת מה שאחראי הסידור מקליד במסך
 *  למסמך `schedule_policies` שהמנוע החודשי מקבל.
 *
 *  מודול טהור. אין Firebase, אין רשת, אין תאריך מערכת — clock ו-hash
 *  מוזרקים. הוא **בונה ומאמת, ואינו כותב**.
 *
 *  --------------------------------------------------------------
 *  למה הוא קיים
 *  --------------------------------------------------------------
 *
 *  `schedule-calendar-engine.js:113` דורש מסמך מדיניות, ואומר
 *  במפורש „המנוע אינו מניח ערכים". `schedule-runtime.js` קורא
 *  אותו ב-`.get()` בלבד.
 *
 *  **ואף קוד בריפו אינו כותב אותו.** לא callable, לא סקריפט,
 *  לא מסך. זו הסיבה היחידה שהמנוע כבוי בייצור: לא דגל, לא באג —
 *  פשוט אין למנוע מה לאכול, כי לא נבנה הדבר שמאכיל אותו.
 *
 *  --------------------------------------------------------------
 *  ⭐ הכלל שקובע את כל המודול
 *  --------------------------------------------------------------
 *
 *  **אין ברירות מחדל עסקיות. בשום מקום.**
 *
 *  קו מינימום, כמה נהגים, כמה ימי מנוחה, תקרת משמרות — כל אחד
 *  מהם הוא החלטה של התחנה. ערך חסר הוא **שגיאה עם קוד**, ולא
 *  אפס, ולא „סביר".
 *
 *  זה לא קפדנות לשמה. קו מינימום שנשתל כ-0 בשקט הופך „מתחת
 *  לתקן" למצב שלעולם אינו קורה, והמסך יראה ירוק על תחנה ריקה.
 *  מספר שאיש לא בחר הוא הדבר המסוכן ביותר במערכת הזאת.
 *
 *  --------------------------------------------------------------
 *  מה הוא כן עושה מעבר לאימות
 *  --------------------------------------------------------------
 *
 *  **מראה מה משתנה לפני השמירה.** `changes[]` מפרט כל הפרש מול
 *  המדיניות הפעילה — תחנה שנוספה, קו שירד, תפקיד שהפך מרשות
 *  לחובה. הורדת קו מינימום או הפיכת דרישה לרשות מסומנות
 *  `weakens: true`, כי הן מרחיבות את מה שהמערכת תסכים לקרוא לו
 *  „תקין", ואדם צריך לראות את זה לפני שהוא לוחץ שמור.
 *
 *  **מזהיר על סתירה פנימית.** קו מינימום נמוך מסך הדרישות
 *  שסומנו חובה הוא מדיניות שסותרת את עצמה: יום יכול לעמוד בקו
 *  ועדיין לחסר תפקיד חובה. מותר — לפעמים זו הכוונה — אבל נאמר.
 * ==================================================================== */

const SCHEMA_VERSION = 1;

const LIMITS = Object.freeze({
  MAX_SUB_STATIONS: 64,
  MAX_ROLES_PER_SUB: 32,
  MAX_COUNT_PER_ROLE: 500,
  MAX_MIN_GAP_DAYS: 30,
  MAX_SHIFTS_PER_MONTH: 62,
  MAX_LABEL: 40,
  MAX_ID: 64
});

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * מזהה תחנת קצה הוא **מפתח במפה ב-Firestore**, ולא ערך.
 *
 * נקודה במפתח היא מפריד נתיב־שדה. מפה שנכתבת בשלמותה עוברת גם
 * עם נקודה, אבל כל `update()` עתידי על אותו שדה יפרש אותה כירידה
 * לתת־שדה ויכתוב במקום הלא נכון. זו תקלה שנולדת מאוחר, בקוד אחר,
 * ולכן היא נחסמת כאן ולא מתועדת שם.
 */
const SUB_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CODE = Object.freeze({
  SHAPE: 'policy-author-shape',
  STATION: 'policy-author-station',
  NO_SUB_STATIONS: 'policy-author-no-sub-stations',
  SUB_ID: 'policy-author-sub-id',
  SUB_LABEL: 'policy-author-sub-label',
  MINIMUM_MISSING: 'policy-author-minimum-missing',
  NO_REQUIREMENTS: 'policy-author-no-requirements',
  ROLE_INVALID: 'policy-author-role-invalid',
  ROLE_DUPLICATE: 'policy-author-role-duplicate',
  COUNT_INVALID: 'policy-author-count-invalid',
  REQUIRED_MISSING: 'policy-author-required-missing',
  REST_MISSING: 'policy-author-rest-missing',
  ROTATION_MISSING: 'policy-author-rotation-missing',
  ROTATION_INVALID: 'policy-author-rotation-invalid',
  LIMIT_MISSING: 'policy-author-limit-missing',
  LIMIT_INVALID: 'policy-author-limit-invalid',
  TOO_MANY: 'policy-author-too-many',
  NO_CHANGE: 'policy-author-no-change'
});

const CHANGE = Object.freeze({
  SUB_ADDED: 'sub-station-added',
  SUB_REMOVED: 'sub-station-removed',
  LABEL: 'sub-station-label',
  MINIMUM: 'minimum',
  ROLE_ADDED: 'role-added',
  ROLE_REMOVED: 'role-removed',
  COUNT: 'role-count',
  REQUIRED: 'role-required',
  REST: 'rest-min-gap-days',
  ROTATION: 'rotation',
  CAP: 'max-shifts-per-month'
});

const WARN = Object.freeze({
  MINIMUM_BELOW_REQUIRED: 'minimum-below-required-total',
  NO_REQUIRED_ROLE: 'sub-station-has-no-required-role',
  ZERO_MINIMUM: 'minimum-is-zero',
  CAP_ABSENT: 'no-monthly-shift-cap',
  REST_ZERO: 'no-rest-gap'
});

class PolicyAuthorError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'PolicyAuthorError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * ⭐ מראה מכוונת של `stable()` ב-`schedule-runtime.js:106`.
 *
 * `loadPolicy` שם מחשב מחדש את חתימת התוכן ומסרב למסמך שאינו
 * תואם. אם החתימה כאן תיווצר אחרת — ולו בסדר מפתחות — המסמך
 * ייכתב, ייראה תקין, וייפול ב-`policy-digest-mismatch` ברגע
 * שמישהו ינסה להריץ מנוע. כלומר: הכתיבה תצליח והמערכת תישבר
 * מאוחר יותר, אצל מישהו אחר.
 *
 * לכן הפונקציה הזאת זהה **מילה במילה** לזו שברנטיים, והבדיקה
 * `schedule-policy-author-probe` נועלת את זה בשלוש דרכים:
 * השוואת טקסט מקור, חישוב מקביל, והשוואה לבסיס שהרנטיים בונה.
 * שינוי באחד הצדדים חייב להפיל בדיקה.
 */
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}
function fail(code, message, detail) {
  throw new PolicyAuthorError(code, message, detail);
}

/**
 * מספר שנמסר מהמסך. **חייב להיות מספר שלם אמיתי.**
 *
 * מחרוזת אינה מתקבלת אפילו כשהיא נראית כמספר: `<input>` מחזיר
 * מחרוזת, והמרה שקטה כאן היא בדיוק המקום שבו `""` היה הופך
 * ל-0 והופך קו מינימום לחסר-משמעות.
 */
function requireInt(value, min, max, code, what) {
  if (value === undefined || value === null) {
    fail(code, what + ' — ערך חסר. אין ברירת מחדל.');
  }
  if (!isInt(value)) {
    fail(code, what + ' — חייב להיות מספר שלם. התקבל ' + JSON.stringify(value) + '.');
  }
  if (value < min || value > max) {
    fail(code, what + ' — מחוץ לתחום ' + min + '–' + max + '. התקבל ' + value + '.');
  }
  return value;
}

function cleanLabel(value, code, what) {
  if (!isNonEmptyString(value)) fail(code, what + ' — תווית חסרה.');
  const t = value.trim();
  if (t.length > LIMITS.MAX_LABEL) {
    fail(code, what + ' — תווית ארוכה מ-' + LIMITS.MAX_LABEL + ' תווים.');
  }
  return t;
}

/* ------------------------- בניית המסמך ------------------------- */

function normalizeSubStation(key, raw) {
  if (!SUB_KEY_RE.test(key)) {
    fail(CODE.SUB_ID, 'מזהה תחנת קצה לא תקין: ' + key
      + ' — מותרים אותיות לועזיות, ספרות, מקף וקו תחתון בלבד.');
  }
  if (!isPlainObject(raw)) {
    fail(CODE.SHAPE, 'תחנת הקצה ' + key + ' אינה תקינה.');
  }
  const label = cleanLabel(raw.label, CODE.SUB_LABEL, 'תחנת קצה ' + key);

  // ⭐ קו המינימום. הודעה מפורשת, כי זה השדה שאחראי הסידור
  // ישכח למלא, וזה גם השדה שדממה בו מסוכנת ביותר.
  const minimum = requireInt(raw.minimum, 0, LIMITS.MAX_COUNT_PER_ROLE,
    CODE.MINIMUM_MISSING, 'קו המינימום של ' + label);

  const rows = raw.requirements;
  if (!Array.isArray(rows) || rows.length === 0) {
    fail(CODE.NO_REQUIREMENTS, 'לתחנת הקצה ' + label + ' אין ולו דרישת תקן אחת.');
  }
  if (rows.length > LIMITS.MAX_ROLES_PER_SUB) {
    fail(CODE.TOO_MANY, 'יותר מדי תפקידים בתחנת הקצה ' + label + '.');
  }

  const seen = new Set();
  const requirements = rows.map((row, i) => {
    if (!isPlainObject(row)) fail(CODE.SHAPE, 'דרישה ' + i + ' בתחנת הקצה ' + label);
    if (!isNonEmptyString(row.role) || !ID_RE.test(row.role)) {
      fail(CODE.ROLE_INVALID, 'דרישה ' + i + ' בתחנת הקצה ' + label + ' — תפקיד לא תקין.');
    }
    if (seen.has(row.role)) {
      fail(CODE.ROLE_DUPLICATE, 'התפקיד ' + row.role + ' מופיע פעמיים בתחנת הקצה ' + label + '.');
    }
    seen.add(row.role);
    const count = requireInt(row.count, 0, LIMITS.MAX_COUNT_PER_ROLE,
      CODE.COUNT_INVALID, 'הכמות לתפקיד ' + row.role + ' בתחנת הקצה ' + label);
    // ⭐ חובה/רשות — בוליאני מפורש. „לא סימנו" אינו „רשות".
    if (typeof row.required !== 'boolean') {
      fail(CODE.REQUIRED_MISSING,
        'לדרישה ' + row.role + ' בתחנת הקצה ' + label + ' חסר סימון חובה/רשות מפורש.');
    }
    return {
      role: row.role,
      label: isNonEmptyString(row.label) ? row.label.trim().slice(0, LIMITS.MAX_LABEL) : row.role,
      count,
      required: row.required
    };
  });

  // סדר יציב: לפי תפקיד. אותה קלט → אותו מסמך → אותו digest.
  requirements.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  return { key, label, minimum, requirements };
}

function normalizeRotation(raw) {
  if (raw === null) return null;
  if (!isPlainObject(raw)) fail(CODE.ROTATION_INVALID, 'מחזוריות אינה תקינה.');
  const groups = raw.groups;
  if (!Array.isArray(groups) || groups.length === 0
      || groups.some((g) => !isNonEmptyString(g) || !ID_RE.test(g))) {
    fail(CODE.ROTATION_INVALID, 'למחזוריות חסרות קבוצות תקינות.');
  }
  if (new Set(groups).size !== groups.length) {
    fail(CODE.ROTATION_INVALID, 'קבוצה כפולה במחזוריות.');
  }
  if (!isNonEmptyString(raw.anchor) || !DATE_RE.test(raw.anchor)) {
    fail(CODE.ROTATION_INVALID, 'עוגן המחזוריות חייב להיות תאריך YYYY-MM-DD.');
  }
  const y = Number(raw.anchor.slice(0, 4)), m = Number(raw.anchor.slice(5, 7)),
        d = Number(raw.anchor.slice(8, 10));
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    fail(CODE.ROTATION_INVALID, 'עוגן המחזוריות אינו תאריך קיים: ' + raw.anchor);
  }
  const daysPerGroup = requireInt(raw.days_per_group, 1, 366,
    CODE.ROTATION_INVALID, 'days_per_group');
  if (typeof raw.strict !== 'boolean') {
    fail(CODE.ROTATION_INVALID, 'חובה להצהיר אם המחזוריות קשיחה.');
  }
  return { groups: groups.slice(), anchor: raw.anchor,
    days_per_group: daysPerGroup, strict: raw.strict };
}

/* --------------------------- הפרשים --------------------------- */

function diffPolicies(prev, next) {
  const out = [];
  if (!prev) return out;

  const pk = Object.keys(prev.sub_stations || {});
  const nk = Object.keys(next.sub_stations);
  for (const k of nk) if (pk.indexOf(k) === -1) {
    out.push({ kind: CHANGE.SUB_ADDED, sub_station: k, weakens: false });
  }
  for (const k of pk) if (nk.indexOf(k) === -1) {
    // הסרת תחנת קצה מוחקת את כל התקן שלה. זו החלשה.
    out.push({ kind: CHANGE.SUB_REMOVED, sub_station: k, weakens: true });
  }

  for (const k of nk) {
    const a = (prev.sub_stations || {})[k];
    const b = next.sub_stations[k];
    if (!a) continue;
    if (a.label !== b.label) {
      out.push({ kind: CHANGE.LABEL, sub_station: k, from: a.label, to: b.label, weakens: false });
    }
    if (a.minimum !== b.minimum) {
      out.push({ kind: CHANGE.MINIMUM, sub_station: k, from: a.minimum, to: b.minimum,
        weakens: b.minimum < a.minimum });
    }
    const am = new Map((a.requirements || []).map((r) => [r.role, r]));
    const bm = new Map(b.requirements.map((r) => [r.role, r]));
    for (const [role, r] of bm) {
      if (!am.has(role)) {
        out.push({ kind: CHANGE.ROLE_ADDED, sub_station: k, role, count: r.count,
          required: r.required, weakens: false });
        continue;
      }
      const p = am.get(role);
      if (p.count !== r.count) {
        out.push({ kind: CHANGE.COUNT, sub_station: k, role, from: p.count, to: r.count,
          weakens: r.count < p.count });
      }
      if (p.required !== r.required) {
        // חובה → רשות מרחיב את מה שייחשב תקין.
        out.push({ kind: CHANGE.REQUIRED, sub_station: k, role,
          from: p.required, to: r.required, weakens: p.required && !r.required });
      }
    }
    for (const role of am.keys()) if (!bm.has(role)) {
      out.push({ kind: CHANGE.ROLE_REMOVED, sub_station: k, role, weakens: true });
    }
  }

  const pr = prev.rest && isInt(prev.rest.min_gap_days) ? prev.rest.min_gap_days : null;
  if (pr !== next.rest.min_gap_days) {
    out.push({ kind: CHANGE.REST, from: pr, to: next.rest.min_gap_days,
      weakens: pr !== null && next.rest.min_gap_days < pr });
  }
  if (JSON.stringify(prev.rotation || null) !== JSON.stringify(next.rotation)) {
    out.push({ kind: CHANGE.ROTATION,
      from: prev.rotation ? 'set' : null, to: next.rotation ? 'set' : null,
      weakens: !!prev.rotation && !next.rotation });
  }
  const pc = Object.prototype.hasOwnProperty.call(prev, 'max_shifts_per_month')
    ? prev.max_shifts_per_month : undefined;
  if (pc !== next.max_shifts_per_month) {
    out.push({ kind: CHANGE.CAP, from: pc === undefined ? null : pc,
      to: next.max_shifts_per_month,
      weakens: next.max_shifts_per_month === null && pc !== null && pc !== undefined });
  }

  out.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  return out;
}

/* ============================ המודול ============================ */

function createPolicyAuthor(deps) {
  const d = deps || {};
  if (typeof d.clock !== 'function') fail(CODE.SHAPE, 'חובה להזריק clock');
  if (typeof d.hash !== 'function') fail(CODE.SHAPE, 'חובה להזריק hash');
  const clock = d.clock, hash = d.hash;

  /**
   * @param {object} input
   *   station_id     תחנת הארגון
   *   draft          מה שהמסך אסף:
   *                  { sub_stations:{key:{label,minimum,requirements[]}},
   *                    rest:{min_gap_days}, rotation:{...}|null,
   *                    max_shifts_per_month:number|null }
   *   previous       מסמך המדיניות הפעיל, או null
   *   actor_uid      מי שומר
   *
   * @returns {{document, policy_id, version, digest, changes, warnings, audit}}
   */
  function planPolicy(input) {
    if (!isPlainObject(input)) fail(CODE.SHAPE, 'קלט לא תקין');
    const stationId = input.station_id;
    if (!isNonEmptyString(stationId) || !ID_RE.test(stationId)) {
      fail(CODE.STATION, 'חסרה תחנה, או שהמזהה אינו תקין.');
    }
    const draft = input.draft;
    if (!isPlainObject(draft)) fail(CODE.SHAPE, 'חסרה טיוטת מדיניות.');

    /* --- תחנות קצה --- */
    const rawSubs = draft.sub_stations;
    if (!isPlainObject(rawSubs) || Object.keys(rawSubs).length === 0) {
      fail(CODE.NO_SUB_STATIONS, 'חובה להגדיר לפחות תחנת קצה אחת.');
    }
    const keys = Object.keys(rawSubs).sort();
    if (keys.length > LIMITS.MAX_SUB_STATIONS) {
      fail(CODE.TOO_MANY, 'יותר מדי תחנות קצה.');
    }
    const subs = {};
    for (const k of keys) subs[k] = normalizeSubStation(k, rawSubs[k]);

    /* --- מנוחה · חובה מפורשת --- */
    if (!isPlainObject(draft.rest)) {
      fail(CODE.REST_MISSING, 'חובה להגדיר מנוחה בין משמרות. אין ברירת מחדל.');
    }
    const minGap = requireInt(draft.rest.min_gap_days, 0, LIMITS.MAX_MIN_GAP_DAYS,
      CODE.REST_MISSING, 'ימי המנוחה בין משמרות');

    /* --- מחזוריות · חייבת להופיע, גם כ-null --- */
    if (!Object.prototype.hasOwnProperty.call(draft, 'rotation')) {
      fail(CODE.ROTATION_MISSING, 'חובה להצהיר על מחזוריות, גם אם אין — אז במפורש null.');
    }
    const rotation = normalizeRotation(draft.rotation);

    /* --- תקרת משמרות · חייבת להופיע, גם כ-null --- */
    if (!Object.prototype.hasOwnProperty.call(draft, 'max_shifts_per_month')) {
      fail(CODE.LIMIT_MISSING, 'חובה להצהיר על תקרת משמרות חודשית, גם אם אין — אז null.');
    }
    let cap = draft.max_shifts_per_month;
    if (cap !== null) {
      cap = requireInt(cap, 1, LIMITS.MAX_SHIFTS_PER_MONTH,
        CODE.LIMIT_INVALID, 'תקרת המשמרות החודשית');
    }

    /* --- התוכן, בלי הגרסה --- *
     * ⭐ שתי חתימות, ובכוונה.
     *
     * `content_key` היא חתימת **התוכן בלבד**. היא מה שעונה על
     * „האם באמת השתנה משהו", ולכן היא חייבת לא לכלול את הגרסה —
     * אחרת כל שמירה תיראה כשינוי והמסך ייצור טור גרסאות זהות.
     *
     * `content_digest` היא החתימה שהרנטיים מחשב מחדש ב-`loadPolicy`,
     * והיא **כן** כוללת את הגרסה, כי זה הבסיס שהוא בונה שם. אנחנו
     * לא בוחרים את הצורה שלה — אנחנו מצייתים לה. */
    const content = {
      station_id: stationId,
      sub_stations: {},
      rest: { min_gap_days: minGap },
      rotation,
      max_shifts_per_month: cap
    };
    for (const k of keys) content.sub_stations[k] = subs[k];

    const contentKey = String(hash(stable(content)));
    if (!isNonEmptyString(contentKey)) fail(CODE.SHAPE, 'hash לא החזיר חתימה.');

    /* --- גרסה --- *
     * נגזרת מהקודמת ולא נמסרת מבחוץ: גרסה שהמסך שולח יכולה
     * לחזור על עצמה בשתי לשוניות פתוחות. */
    const prev = isPlainObject(input.previous) ? input.previous : null;
    const prevNum = prev && typeof prev.version === 'string'
      ? Number((prev.version.match(/^v(\d+)$/) || [])[1]) : NaN;
    const version = 'v' + (Number.isInteger(prevNum) ? prevNum + 1 : 1);

    /* --- לא השתנה כלום --- *
     * שמירה חוזרת בלי שינוי אינה שגיאה שקטה ואינה מסמך חדש:
     * היא מדווחת, כדי שלא ייווצר טור גרסאות שכולו זהה. */
    if (prev && isNonEmptyString(prev.content_key) && prev.content_key === contentKey) {
      return Object.freeze({
        kind: 'unchanged',
        policy_id: prev.id || null,
        version: prev.version || null,
        digest: isNonEmptyString(prev.content_digest) ? prev.content_digest : null,
        content_key: contentKey,
        document: null,
        changes: [],
        warnings: [],
        weakening: [],
        audit: auditOf(stationId, input.actor_uid, contentKey, 0)
      });
    }

    /* --- הבסיס שהרנטיים חותם עליו --- *
     * `schedule-runtime.js:876` בונה בדיוק את ששת השדות האלה
     * ומחשב עליהם `digest(basis)`. השמות והצורה אינם שלנו. */
    const basis = {
      station_id: stationId,
      version,
      sub_stations: content.sub_stations,
      rest: content.rest,
      rotation,
      max_shifts_per_month: cap
    };
    const digest = String(hash(stable(basis)));

    /* --- אזהרות · מותר, אבל שייאמר --- */
    const warnings = [];
    for (const k of keys) {
      const s = subs[k];
      const requiredTotal = s.requirements
        .filter((r) => r.required).reduce((n, r) => n + r.count, 0);
      if (requiredTotal === 0) {
        warnings.push({ code: WARN.NO_REQUIRED_ROLE, sub_station: k,
          detail: 'בתחנת ' + s.label + ' אין ולו תפקיד אחד שסומן חובה. '
            + 'יום בלי אף אחד מהם לא ייחשב חסר.' });
      }
      if (s.minimum === 0) {
        warnings.push({ code: WARN.ZERO_MINIMUM, sub_station: k,
          detail: 'קו המינימום של ' + s.label + ' הוא 0. '
            + '„מתחת לקו" לא יופיע שם לעולם.' });
      } else if (s.minimum < requiredTotal) {
        warnings.push({ code: WARN.MINIMUM_BELOW_REQUIRED, sub_station: k,
          minimum: s.minimum, required_total: requiredTotal,
          detail: 'קו המינימום של ' + s.label + ' הוא ' + s.minimum
            + ' אך התקן דורש ' + requiredTotal + ' אנשי חובה. '
            + 'יום יוכל לעמוד בקו ועדיין לחסר תפקיד חובה.' });
      }
    }
    if (minGap === 0) {
      warnings.push({ code: WARN.REST_ZERO,
        detail: 'אין מנוחה נדרשת בין משמרות. אדם יוכל להשתבץ יומיים ברצף.' });
    }
    if (cap === null) {
      warnings.push({ code: WARN.CAP_ABSENT,
        detail: 'אין תקרת משמרות חודשית. עומס חריג לא יסומן.' });
    }

    const changes = diffPolicies(prev, content);
    const policyId = 'policy_' + version + '_' + contentKey.slice(0, 12);

    const document = Object.assign({}, basis, {
      schema_version: SCHEMA_VERSION,
      // ⭐ `loadPolicy` דורש `complete === true`. מסמך חלקי אינו
      // מסמך: אין „חצי מדיניות" שהמנוע יריץ.
      complete: true,
      content_digest: digest,
      // `digest` נשמר בנפרד כדי שהמנוע יוכל להיבנות ישירות על
      // המסמך הזה — `normalizePolicy` דורש `raw.digest`.
      digest,
      content_key: contentKey,
      created_at: new Date(clock()).toISOString(),
      created_by: isNonEmptyString(input.actor_uid) ? input.actor_uid : null,
      supersedes: prev && prev.id ? prev.id : null
    });

    return Object.freeze({
      kind: prev ? 'updated' : 'created',
      policy_id: policyId,
      version,
      digest,
      content_key: contentKey,
      document,
      changes,
      warnings,
      // ⭐ החלשות מרוכזות בנפרד: המסך צריך להציג אותן אחרת,
      // ואדם צריך לאשר אותן במפורש ולא לגלול מעליהן.
      weakening: changes.filter((c) => c.weakens === true),
      audit: auditOf(stationId, input.actor_uid, digest, changes.length)
    });
  }

  function auditOf(stationId, actor, digest, changeCount) {
    return {
      at: new Date(clock()).toISOString(),
      station_id: stationId,
      actor: isNonEmptyString(actor) ? actor : null,
      digest,
      change_count: changeCount
    };
  }

  /**
   * האם המדיניות מוכנה להפעלת המנוע. `getManagerSetup` מחזיר
   * `configured:false` כשחסר policy או source — זה מפרט **מה**
   * חסר, כדי שהמסך יאמר לאחראי הסידור מה לעשות ולא רק
   * „אינו זמין".
   */
  function readiness(input) {
    if (!isPlainObject(input)) fail(CODE.SHAPE, 'קלט לא תקין');
    const missing = [];
    if (!isPlainObject(input.policy)) missing.push('policy');
    if (!isPlainObject(input.source)) missing.push('source');
    const people = Array.isArray(input.people) ? input.people : [];
    if (isPlainObject(input.source) && people.length === 0) missing.push('people');
    if (!isNonEmptyString(input.mode)) missing.push('mode');
    return Object.freeze({
      ready: missing.length === 0,
      missing,
      // ⭐ מוכן אינו „אפשר להריץ בייצור". מעבר ל-new הוא פעולה
      // אנושית מפורשת, וזה נאמר כאן כדי שלא יוסק אחרת.
      may_run: missing.length === 0 && (input.mode === 'shadow' || input.mode === 'new'),
      mode: isNonEmptyString(input.mode) ? input.mode : null,
      people_count: people.length
    });
  }

  return Object.freeze({
    planPolicy, readiness,
    SCHEMA_VERSION, LIMITS, CODE, CHANGE, WARN
  });
}

module.exports = {
  createPolicyAuthor, PolicyAuthorError,
  SCHEMA_VERSION, LIMITS, CODE, CHANGE, WARN
};
