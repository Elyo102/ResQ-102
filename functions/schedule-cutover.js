'use strict';

/* ====================================================================
 *  schedule-cutover · המעבר מ-shadow ל-new
 *
 *  ----------------------------------------------------------------
 *  מה הבעיה שהמודול הזה פותר
 *  ----------------------------------------------------------------
 *
 *  לפני המודול הזה, המעבר למנוע החדש היה שתי פעולות נפרדות: מישהו
 *  העביר את המצב ל-`new`, ואחר כך פרסם סידור. בין שתיהן נפתח חלון
 *  שבו התחנה כולה בלי לוח.
 *
 *  ⭐ החלון הזה אינו תיאורטי. `publish` דורש `mode === new`, ולכן
 *  אי אפשר לפרסם לפני המעבר — הסדר הזה **מכריח** את החלון להיפתח.
 *
 *  לכן: מכינים פרסום מלא **בזמן shadow**, בודקים אותו מול המצב
 *  הקיים, ורק אז מבצעים מעבר אחד ובלתי-ניתן-לחלוקה שמפעיל את
 *  הפרסום ומזיז את המצב יחד.
 *
 *  ----------------------------------------------------------------
 *  למה המודול הזה טהור
 *  ----------------------------------------------------------------
 *
 *  אין כאן Firebase, אין רשת, אין שעון ואין אקראיות. הזמן וה-hash
 *  מוזרקים. אותם קלטים נותנים תמיד את אותו פלט — וזה תנאי הכרחי,
 *  כי דוח ה-preflight **נחתם**, והחתימה נבדקת שוב ברגע המעבר. דוח
 *  שאינו דטרמיניסטי הוא דוח שאי אפשר לאמת.
 *
 *  ----------------------------------------------------------------
 *  מה הדוח לא מכיל
 *  ----------------------------------------------------------------
 *
 *  ⭐ ספירות, digests וקודי סיבה. **אין שמות, אין UID ואין הערות.**
 *  הדוח נשמר, מוצג ונכנס ליומן; כל אחד מהם הוא מקום שבו מידע אישי
 *  לא צריך להיות. מי שצריך לדעת מי חסר — פותח את הסידור.
 * ==================================================================== */

const SCHEMA_VERSION = 1;

/* המצבים. מחרוזת שאינה כאן אינה מצב. */
const MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', NEW: 'new' });

/* מה מותר להיות ממנו לאן. ⭐ `off → new` אינו כאן, ובמכוון: מעבר
 * ישיר מכבוי לחי מדלג על השלב שבו בכלל אפשר לבדוק משהו. */
const TRANSITIONS = Object.freeze({
  'off->shadow': true,
  'shadow->new': true,
  'shadow->off': true,
  'new->off': true,
  'new->shadow': true
});

const CODE = Object.freeze({
  SHAPE: 'cutover-shape',
  MODE_UNKNOWN: 'cutover-mode-unknown',
  TRANSITION_FORBIDDEN: 'cutover-transition-forbidden',
  EXPECTED_MODE: 'cutover-expected-mode',
  CANDIDATE_REQUIRED: 'cutover-candidate-required',
  CANDIDATE_NOT_PREPARED: 'cutover-candidate-not-prepared',
  CANDIDATE_MISMATCH: 'cutover-candidate-mismatch',
  PREFLIGHT_REQUIRED: 'cutover-preflight-required',
  PREFLIGHT_STALE: 'cutover-preflight-stale',
  PREFLIGHT_FAILED: 'cutover-preflight-failed',
  DIGEST_MISMATCH: 'cutover-digest-mismatch',
  ALREADY_ACTIVE: 'cutover-already-active'
});

/* קודי הסיבה של ה-preflight. רשימה סגורה — טקסט חופשי בדוח שנשמר
 * הוא דלת אחורית למידע אישי. */
const REASON = Object.freeze({
  MISSING: 'preflight-missing',        // אדם שיש לו שיבוץ ב-legacy ואין לו בחדש
  FOREIGN: 'preflight-foreign',        // שיבוץ למי שאינו במקור המאושר
  DUPLICATE: 'preflight-duplicate',    // אותו אדם פעמיים באותו יום
  EMPTY_DAY: 'preflight-empty-day',    // יום שיש בו legacy ואין בו חדש
  OUT_OF_RANGE: 'preflight-out-of-range'
});

class CutoverError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'CutoverError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/* ⭐ מראה מכוונת של `stable()` שברנטיים. אותה החלטה כמו
 * ב-schedule-policy-author: החתימה נבדקת מחדש על ידי מי שקורא, ולכן
 * הקנוניזציה חייבת להיות זהה מילה במילה. אילו כתבתי כאן
 * `JSON.stringify`, החתימה הייתה נכתבת יפה ונדחית בבדיקה. */
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function compareCanonical(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function createCutover(deps) {
  const options = isPlainObject(deps) ? deps : {};
  if (typeof options.hash !== 'function') {
    throw new CutoverError(CODE.SHAPE, 'createCutover דורש hash.');
  }
  if (typeof options.clock !== 'function') {
    throw new CutoverError(CODE.SHAPE, 'createCutover דורש clock.');
  }
  const hash = options.hash;
  const clock = options.clock;

  function fail(code, message, detail) {
    throw new CutoverError(code, message, detail);
  }

  /* ------------------------------------------------------------------
   * preflight · האם הסידור החדש מכסה את מה שהקיים מכסה
   *
   * הכיוון חשוב: אנחנו לא שואלים „האם החדש דומה". שואלים **האם
   * מישהו שהיה משובץ ייעלם**. זו השאלה שאדם מרגיש.
   * ------------------------------------------------------------------ */
  function preflight(input) {
    if (!isPlainObject(input)) fail(CODE.SHAPE, 'preflight מקבל אובייקט.');
    const stationId = input.station_id;
    if (!isNonEmptyString(stationId)) fail(CODE.SHAPE, 'preflight דורש station_id.');

    const allowed = new Set();
    if (!Array.isArray(input.allowed_uids)) {
      fail(CODE.SHAPE, 'preflight דורש רשימת הרשאה של מי שבמקור.');
    }
    for (const uid of input.allowed_uids) {
      if (!isNonEmptyString(uid)) fail(CODE.SHAPE, 'רשימת ההרשאה מכילה ערך שאינו מזהה.');
      allowed.add(uid);
    }

    const legacy = dayMap(input.legacy_days, 'legacy');
    const next = dayMap(input.next_days, 'next');

    const dates = Array.from(new Set([].concat(
      Array.from(legacy.keys()), Array.from(next.keys())
    ))).sort(compareCanonical);

    const findings = [];
    const byReason = {};
    for (const key of Object.values(REASON)) byReason[key] = 0;

    for (const date of dates) {
      const was = legacy.get(date) || [];
      const now = next.get(date) || [];
      const wasSet = new Set(was);
      const nowSet = new Set(now);

      // אותו אדם פעמיים באותו יום — תמיד כשל, גם אם אף אחד לא נעלם.
      if (now.length !== nowSet.size) {
        findings.push({ date, reason: REASON.DUPLICATE, count: now.length - nowSet.size });
        byReason[REASON.DUPLICATE] += now.length - nowSet.size;
      }
      // שיבוץ למי שאינו במקור המאושר.
      let foreign = 0;
      for (const uid of nowSet) if (!allowed.has(uid)) foreign += 1;
      if (foreign) {
        findings.push({ date, reason: REASON.FOREIGN, count: foreign });
        byReason[REASON.FOREIGN] += foreign;
      }
      // ⭐ הליבה: מי שהיה משובץ ואיננו.
      let missing = 0;
      for (const uid of wasSet) if (!nowSet.has(uid)) missing += 1;
      if (missing) {
        findings.push({ date, reason: REASON.MISSING, count: missing });
        byReason[REASON.MISSING] += missing;
      }
      // יום שהיה מאויש ונעשה ריק.
      if (was.length && !now.length) {
        findings.push({ date, reason: REASON.EMPTY_DAY, count: 1 });
        byReason[REASON.EMPTY_DAY] += 1;
      }
    }

    // יום שיש בחדש ואינו בטווח שנבדק אינו „בסדר" — הוא לא נבדק.
    if (isNonEmptyString(input.from) && isNonEmptyString(input.to)) {
      let outside = 0;
      for (const date of next.keys()) {
        if (date < input.from || date > input.to) outside += 1;
      }
      if (outside) {
        findings.push({ date: null, reason: REASON.OUT_OF_RANGE, count: outside });
        byReason[REASON.OUT_OF_RANGE] += outside;
      }
    }

    findings.sort((a, b) => compareCanonical(a.date || '', b.date || '')
      || compareCanonical(a.reason, b.reason));

    /* ⭐ fail-closed. כל ממצא חוסם. אין „אזהרה" שאפשר להתעלם ממנה:
     * הדבר היחיד שממצא כזה אומר הוא שאדם ייעלם מהלוח. */
    const blocked = findings.length > 0;

    const body = {
      schema_version: SCHEMA_VERSION,
      station_id: stationId,
      from: isNonEmptyString(input.from) ? input.from : null,
      to: isNonEmptyString(input.to) ? input.to : null,
      candidate_publication_id: isNonEmptyString(input.candidate_publication_id)
        ? input.candidate_publication_id : null,
      policy_digest: isNonEmptyString(input.policy_digest) ? input.policy_digest : null,
      source_digest: isNonEmptyString(input.source_digest) ? input.source_digest : null,
      content_hash: isNonEmptyString(input.content_hash) ? input.content_hash : null,
      counts: {
        days: dates.length,
        legacy_days: legacy.size,
        next_days: next.size,
        allowed: allowed.size
      },
      by_reason: byReason,
      // ⭐ תאריך, סיבה, מספר. אין כאן uid ואין שם.
      findings: findings.map((item) => ({
        date: item.date, reason: item.reason, count: item.count
      })),
      blocked
    };
    const signature = String(hash(stable(body)));
    return Object.freeze(Object.assign({}, body, {
      signature,
      generated_at: clock()
    }));
  }

  function dayMap(days, what) {
    const out = new Map();
    if (days === undefined || days === null) return out;
    if (!Array.isArray(days)) fail(CODE.SHAPE, what + ' חייב להיות מערך ימים.');
    for (const day of days) {
      if (!isPlainObject(day) || !isNonEmptyString(day.date)) {
        fail(CODE.SHAPE, what + ' מכיל יום בלי תאריך.');
      }
      if (!Array.isArray(day.uids)) {
        fail(CODE.SHAPE, what + ' מכיל יום שהשיבוצים בו אינם מערך.');
      }
      const uids = [];
      for (const uid of day.uids) {
        if (!isNonEmptyString(uid)) fail(CODE.SHAPE, what + ' מכיל שיבוץ בלי מזהה.');
        uids.push(uid);
      }
      // אותו תאריך פעמיים — מאחדים, כדי שספירת הכפילויות תהיה אמיתית.
      const prev = out.get(day.date);
      out.set(day.date, prev ? prev.concat(uids) : uids);
    }
    return out;
  }

  /* בודק שדוח שנמסר הוא אותו דוח שנחתם. */
  function verifyPreflight(report) {
    if (!isPlainObject(report)) fail(CODE.PREFLIGHT_REQUIRED, 'חסר דוח preflight.');
    const body = {
      schema_version: report.schema_version,
      station_id: report.station_id,
      from: report.from === undefined ? null : report.from,
      to: report.to === undefined ? null : report.to,
      candidate_publication_id: report.candidate_publication_id === undefined
        ? null : report.candidate_publication_id,
      policy_digest: report.policy_digest === undefined ? null : report.policy_digest,
      source_digest: report.source_digest === undefined ? null : report.source_digest,
      content_hash: report.content_hash === undefined ? null : report.content_hash,
      counts: report.counts,
      by_reason: report.by_reason,
      findings: report.findings,
      blocked: report.blocked
    };
    return isNonEmptyString(report.signature)
      && report.signature === String(hash(stable(body)));
  }

  /* ------------------------------------------------------------------
   * המעבר עצמו · מה מותר, ומה חייב להיות נכון ברגע ההחלטה
   *
   * ⭐ הפונקציה הזאת אינה כותבת דבר. היא מכריעה בלבד, כדי שההכרעה
   * תהיה ניתנת לבדיקה בלי Firestore — ובאותה מידה, כדי שהרנטיים
   * יוכל לקרוא לה **בתוך** הטרנזקציה על הערכים החיים.
   * ------------------------------------------------------------------ */
  function decidePromotion(input) {
    if (!isPlainObject(input)) fail(CODE.SHAPE, 'decidePromotion מקבל אובייקט.');
    const from = input.from_mode;
    const to = input.to_mode;
    if (!Object.values(MODE).includes(from) || !Object.values(MODE).includes(to)) {
      fail(CODE.MODE_UNKNOWN, 'מצב שאינו מוכר.');
    }
    if (!isNonEmptyString(input.expected_mode)) {
      fail(CODE.EXPECTED_MODE, 'חובה למסור את המצב שהמסך ראה.');
    }
    if (input.expected_mode !== from) {
      fail(CODE.EXPECTED_MODE,
        'המצב השתנה מאז שהמסך נטען: המסך ראה ' + input.expected_mode
        + ' והמצב בפועל הוא ' + from + '.');
    }
    if (from === to) fail(CODE.TRANSITION_FORBIDDEN, 'המצב כבר ' + to + '.');
    if (!TRANSITIONS[from + '->' + to]) {
      fail(CODE.TRANSITION_FORBIDDEN,
        'מעבר מ-' + from + ' ל-' + to + ' אינו מותר.');
    }

    /* מעבר שאינו הפעלה — כיבוי, חזרה ל-shadow — אינו דורש מועמד.
     * ⭐ כיבוי לעולם אינו נחסם: זה שסתום הביטחון. */
    if (to !== MODE.NEW) {
      return Object.freeze({ allowed: true, requires_candidate: false, to, from });
    }

    const candidate = input.candidate;
    if (!isPlainObject(candidate) || !isNonEmptyString(candidate.publication_id)) {
      fail(CODE.CANDIDATE_REQUIRED,
        'מעבר למנוע החדש דורש פרסום מוכן. בלי זה הלוח נפתח ריק.');
    }
    if (candidate.status !== 'prepared') {
      fail(CODE.CANDIDATE_NOT_PREPARED,
        'הפרסום המועמד אינו במצב „מוכן" אלא ' + String(candidate.status) + '.');
    }
    if (candidate.snapshot_complete !== true) {
      fail(CODE.CANDIDATE_NOT_PREPARED, 'תמונת הפרסום המועמד אינה שלמה.');
    }
    if (!isNonEmptyString(input.expected_candidate_id)
        || input.expected_candidate_id !== candidate.publication_id) {
      fail(CODE.CANDIDATE_MISMATCH,
        'הפרסום המועמד אינו זה שהמסך אישר.');
    }
    if (isNonEmptyString(input.active_publication_id)
        && input.active_publication_id === candidate.publication_id) {
      fail(CODE.ALREADY_ACTIVE, 'הפרסום הזה כבר פעיל.');
    }

    const report = input.preflight;
    if (!isPlainObject(report)) {
      fail(CODE.PREFLIGHT_REQUIRED, 'מעבר למנוע החדש דורש דוח preflight.');
    }
    if (!verifyPreflight(report)) {
      fail(CODE.PREFLIGHT_STALE, 'חתימת דוח ה-preflight אינה תואמת לתוכנו.');
    }
    if (report.blocked === true) {
      fail(CODE.PREFLIGHT_FAILED,
        'דוח ה-preflight מצא פערים, ולכן המעבר נחסם.', { by_reason: report.by_reason });
    }
    if (report.candidate_publication_id !== candidate.publication_id) {
      fail(CODE.PREFLIGHT_STALE, 'הדוח נבדק על פרסום אחר.');
    }

    /* ⭐ ה-digests נבדקים שוב **כאן**, בתוך ההכרעה, ולא רק כשהדוח
     * נבנה. מדיניות או מקור שהשתנו מאז הבדיקה הופכים את הדוח לתיאור
     * של משהו שכבר לא קיים. */
    for (const field of ['policy_digest', 'source_digest', 'content_hash']) {
      const expected = input[field];
      if (!isNonEmptyString(expected)) {
        fail(CODE.DIGEST_MISMATCH, 'חסרה חתימה חיה: ' + field + '.');
      }
      if (report[field] !== expected) {
        fail(CODE.DIGEST_MISMATCH,
          'ה-' + field + ' השתנה מאז ה-preflight. יש לבדוק מחדש.');
      }
    }

    return Object.freeze({
      allowed: true,
      requires_candidate: true,
      from, to,
      publication_id: candidate.publication_id,
      preflight_signature: report.signature
    });
  }

  return Object.freeze({
    preflight, verifyPreflight, decidePromotion,
    MODE, TRANSITIONS, CODE, REASON, SCHEMA_VERSION
  });
}

module.exports = {
  createCutover, CutoverError,
  MODE, TRANSITIONS, CODE, REASON, SCHEMA_VERSION
};
