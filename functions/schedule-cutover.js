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

const SCHEMA_VERSION = 2;

/* ⭐ דוח preflight הוא צילום של רגע. אחרי שעתיים הוא מתאר תחנה
 * שכבר אינה קיימת — משמרת התחלפה, תקלה נפתחה, מישהו הועבר. */
const PREFLIGHT_TTL_MS = 2 * 60 * 60 * 1000;

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
  CHANGES_UNACKNOWLEDGED: 'cutover-changes-unacknowledged',
  PREFLIGHT_EXPIRED: 'cutover-preflight-expired',
  CANDIDATE_CONFIG: 'cutover-candidate-config',
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

/* ⭐⭐ מה חוסם, ומה רק מדווח.
 *
 * הגרסה הראשונה חסמה על **כל** ממצא, כולל `MISSING`. `MISSING`
 * פירושו „אדם שהיה משובץ ביום הזה בסידור הישן אינו משובץ בו בחדש",
 * והמנוע החדש בונה סידור **אחר** — זו כל מטרתו. כלומר בניתי שער
 * שאי אפשר לעבור בו: לא בקצה, אלא במעבר הראשון של כל תחנה.
 * Codex גילה את זה בהרצת אמולטור (20 ימים חסומים), ואישר את
 * ההכרעה: `MISSING` הוא **מה שהמנוע אמור לעשות**, לא כשל בטיחות.
 *
 * מה שכן חוסם הוא הלוח הריק ומה שאינו חוקי:
 *   · `EMPTY_DAY`    — יום שהיה מאויש ונעשה ריק. **זה** הלוח הריק.
 *   · `FOREIGN`      — שיבוץ למי שאינו במקור המאושר.
 *   · `DUPLICATE`    — אותו אדם פעמיים באותו יום.
 *   · `OUT_OF_RANGE` — יום שכלל לא נבדק.
 *
 * ⭐ ו-`MISSING` אינו „מתעלמים ממנו": הוא נספר, מפורט לפי יום,
 * ודורש **אישור מפורש שקשור לחתימת הדוח שהמפקד ראה**. אישור לדוח
 * אחד אינו אישור לדוח אחר.
 *
 * ⚠ ומה שאינו כאן: חוסר בכוח אדם, תפקיד חובה שאינו מאויש, וקו
 * המינימום. אלה שערים **נפרדים** של המנוע והמדיניות
 * (`blocking_gaps`), והם לא נגעו ולא נחלשו. */
const BLOCKING = Object.freeze([
  REASON.FOREIGN, REASON.DUPLICATE, REASON.EMPTY_DAY, REASON.OUT_OF_RANGE
]);
const ADVISORY = Object.freeze([REASON.MISSING]);

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

function timeOf(value) {
  /* ⭐ ארבע צורות, כי הזמן הזה חוצה גבול אחסון.
   *
   * הגרסה הקודמת עשתה `Date.parse(String(value))` בלבד. על `Date`
   * זה עובד במקרה; על מספר ועל `Timestamp` של Firestore זה מחזיר
   * `NaN` — ו-`Timestamp` הוא **בדיוק** מה שחוזר מהדיסק. */
  if (value instanceof Date) {
    const at = value.getTime();
    if (!Number.isFinite(at)) {
      throw new CutoverError(CODE.SHAPE, 'התקבל תאריך שאינו תקין.');
    }
    return at;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Timestamp של Firestore, בלי לייבא את firebase-admin לתוך מודול טהור.
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') return timeOf(value.toDate());
    if (typeof value.seconds === 'number') {
      return (value.seconds * 1000)
        + Math.floor((typeof value.nanoseconds === 'number' ? value.nanoseconds : 0) / 1e6);
    }
    if (typeof value._seconds === 'number') {
      return (value._seconds * 1000)
        + Math.floor((typeof value._nanoseconds === 'number' ? value._nanoseconds : 0) / 1e6);
    }
  }
  const at = Date.parse(String(value));
  if (!Number.isFinite(at)) {
    throw new CutoverError(CODE.SHAPE, 'השעון החזיר זמן שאינו תאריך.');
  }
  return at;
}

/* ⭐ הצורה הקנונית היחידה של זמן בגוף החתום: ISO של UTC, במילישניות.
 *
 * מקבל מחרוזת, `Date`, מספר או `Timestamp` של Firestore — ומחזיר
 * תמיד את אותה מחרוזת עבור אותו רגע. זה מה שמאפשר לחתימה לשרוד
 * מסע הלוך ושוב דרך Firestore: מה שנחתם כמחרוזת חוזר כמחרוזת. */
function canonicalTime(value) {
  return new Date(timeOf(value)).toISOString();
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

    /* ⭐ fail-closed על מה שחוסם, ודיווח מלא על מה שאינו.
     *
     * שים לב לכיוון: הרשימה `BLOCKING` היא **allow-list הפוכה** —
     * סיבה חדשה שתתווסף ל-`REASON` ולא תיכנס לאחת משתי הרשימות
     * תיתפס ב-2.x של ה-probe ולא תיבלע בשקט. */
    const blocked = findings.some((item) => BLOCKING.indexOf(item.reason) !== -1);

    /* פירוט לפי יום, לצד המספר. מספר לבדו אינו מאפשר למפקד לדעת
     * אם 20 השינויים מרוכזים ביומיים או פרוסים על חודש.
     * ⭐ תאריך וספירה בלבד — אין כאן שם ואין uid. */
    const changeDays = findings
      .filter((item) => ADVISORY.indexOf(item.reason) !== -1 && isNonEmptyString(item.date))
      .map((item) => ({ date: item.date, count: item.count }));
    const changes = {
      count: changeDays.reduce((sum, item) => sum + item.count, 0),
      days: changeDays
    };

    const body = {
      schema_version: SCHEMA_VERSION,
      station_id: stationId,
      from: isNonEmptyString(input.from) ? input.from : null,
      to: isNonEmptyString(input.to) ? input.to : null,
      candidate_publication_id: isNonEmptyString(input.candidate_publication_id)
        ? input.candidate_publication_id : null,
      /* ⭐ המזהים של המועמד עצמו, ולא רק ה-digests הפעילים.
       * בלעדיהם מועמד שנבנה על תצורה A היה עובר תחת תצורה B: הדוח
       * תיאר את מה שפעיל **עכשיו**, לא את מה שהמועמד נבנה עליו. */
      candidate_source_id: isNonEmptyString(input.candidate_source_id)
        ? input.candidate_source_id : null,
      candidate_policy_id: isNonEmptyString(input.candidate_policy_id)
        ? input.candidate_policy_id : null,
      policy_digest: isNonEmptyString(input.policy_digest) ? input.policy_digest : null,
      source_digest: isNonEmptyString(input.source_digest) ? input.source_digest : null,
      content_hash: isNonEmptyString(input.content_hash) ? input.content_hash : null,
      /* ⭐ שני העוגנים שהיו חסרים, ושבלעדיהם TTL לבדו אינו סוגר
       * TOCTOU: הדוח היה תקף וחתום גם אחרי שהעולם שמתחתיו זז.
       *
       * `legacy_revision` — הסידור הישן הוא **הצד שנעלם**. אם מישהו
       * פרסם סידור legacy חדש בין הבדיקה לאישור, „מי שהיה משובץ
       * וייעלם" נמדד מול תמונה שכבר אינה קיימת.
       *
       * `predecessor_publication_id` — הפרסום הפעיל ברגע הבדיקה.
       * אם הוחלף מאז, המועמד כבר אינו היורש של מה שנבדק. */
      legacy_revision: input.legacy_revision === undefined || input.legacy_revision === null
        ? null : String(input.legacy_revision),
      predecessor_publication_id: isNonEmptyString(input.predecessor_publication_id)
        ? input.predecessor_publication_id : null,
      /* ⭐ הזמן **בתוך** הגוף החתום. דוח שאינו נושא את זמנו אי אפשר
       * להחשיב כישן: אפשר לשנות `generated_at` בלי לשבור חתימה,
       * ואז דוח משבוע שעבר נראה טרי.
       *
       * ⭐⭐ ושניהם **מחרוזת ISO קנונית**, לא אובייקט תאריך.
       *
       * `generated_at: clock()` החזיר `Date`. `Date` שנשמר ב-Firestore
       * חוזר כ-`Timestamp`, ואז `stable()` רואה ערך אחר לגמרי מזה
       * שנחתם — **החתימה לא תואמת לעצמה בקריאה חוזרת, וכל מעבר
       * נחסם.** זה נמצא רק בהרצת אמולטור אמיתית; שום בדיקה טהורה
       * לא הייתה יכולה לראות את זה, כי בזיכרון ה-`Date` נשאר `Date`.
       *
       * המסקנה רחבה יותר מהשורה הזאת: **שדה חתום חייב להיות בצורה
       * שעוברת הלוך ושוב דרך האחסון בלי לשנות ייצוג.** מי שצריך
       * `Date` — TTL של Firestore — מקבל שדה **נפרד** משלו
       * (`ttl_expires_at`), שאינו בגוף החתום ולכן אינו יכול לשבור
       * אותו. */
      generated_at: canonicalTime(clock()),
      expires_at: canonicalTime(timeOf(clock()) + PREFLIGHT_TTL_MS),
      counts: {
        days: dates.length,
        legacy_days: legacy.size,
        next_days: next.size,
        allowed: allowed.size
      },
      by_reason: byReason,
      /* ⭐ בגוף החתום, כי האישור נקשר לחתימה: מפקד שאישר „20
       * שינויים" לא אישר דוח אחר שבו יש 200. */
      changes,
      // ⭐ תאריך, סיבה, מספר. אין כאן uid ואין שם.
      findings: findings.map((item) => ({
        date: item.date, reason: item.reason, count: item.count
      })),
      blocked
    };
    const signature = String(hash(stable(body)));
    return Object.freeze(Object.assign({}, body, { signature }));
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
      candidate_source_id: report.candidate_source_id === undefined
        ? null : report.candidate_source_id,
      candidate_policy_id: report.candidate_policy_id === undefined
        ? null : report.candidate_policy_id,
      legacy_revision: report.legacy_revision === undefined
        ? null : report.legacy_revision,
      predecessor_publication_id: report.predecessor_publication_id === undefined
        ? null : report.predecessor_publication_id,
      /* ⭐ מנורמל לפני החישוב, ולא נבדק כפי שהתקבל.
       *
       * החתימה היא על ה**רגע**, לא על ייצוגו. דוח שחזר מ-Firestore
       * נושא `Timestamp` במקום המחרוזת שנחתמה — אותו רגע בדיוק,
       * ייצוג אחר. בלי הנרמול הזה כל דוח שעבר דרך הדיסק נכשל
       * באימות, וזה חסם כל מעבר.
       *
       * וזה אינו מרכך את החתימה: מי שישנה את הרגע עצמו יקבל צורה
       * קנונית אחרת והחתימה תישבר, בדיוק כמקודם. */
      generated_at: report.generated_at === undefined || report.generated_at === null
        ? null : canonicalTime(report.generated_at),
      expires_at: report.expires_at === undefined || report.expires_at === null
        ? null : canonicalTime(report.expires_at),
      counts: report.counts,
      by_reason: report.by_reason,
      changes: report.changes === undefined ? null : report.changes,
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

    /* ⭐⭐ שינויי שיבוץ אינם חוסמים — אבל דורשים אישור מפורש,
     * **והאישור הוא חתימת הדוח**, לא כן/לא.
     *
     * הסיבה לצורה הזאת: `accept_changes: true` היה נשמר במסך ומוחל
     * על כל דוח שהוא. אישור לדוח שאמר „20 שינויים" אינו אישור לדוח
     * שאומר „200". החתימה קושרת את האישור לדוח **אחד**, וכל בדיקה
     * מחדש מייצרת חתימה חדשה שדורשת אישור חדש.
     *
     * ⚠ וזה אינו מרכך את הלוח הריק: `EMPTY_DAY`, `FOREIGN`,
     * `DUPLICATE` ו-`OUT_OF_RANGE` כבר חסמו למעלה. */
    const changes = isPlainObject(report.changes) ? report.changes : null;
    const changeCount = changes && Number.isFinite(Number(changes.count))
      ? Number(changes.count) : 0;
    if (changeCount > 0) {
      if (!isNonEmptyString(input.accept_changes)) {
        fail(CODE.CHANGES_UNACKNOWLEDGED,
          'הסידור החדש משנה ' + changeCount + ' שיבוצים לעומת הסידור הקיים. '
          + 'יש לאשר את השינויים במפורש לפני המעבר.',
          { changes: changeCount, days: changes.days || [] });
      }
      if (input.accept_changes !== report.signature) {
        fail(CODE.CHANGES_UNACKNOWLEDGED,
          'האישור ניתן לדוח אחר מזה שנבדק. יש לבדוק מחדש ולאשר את הדוח החדש.',
          { changes: changeCount });
      }
    }
    if (report.candidate_publication_id !== candidate.publication_id) {
      fail(CODE.PREFLIGHT_STALE, 'הדוח נבדק על פרסום אחר.');
    }

    /* ⭐ טריות. דוח preflight הוא צילום של רגע — משמרת מתחלפת, תקלה
     * נפתחת, מישהו מועבר. אישור מעבר על סמך דוח מלפני יומיים הוא
     * אישור של תחנה שכבר אינה קיימת. הזמן נמצא **בתוך** הגוף החתום,
     * ולכן אי אפשר להאריך אותו בלי לשבור את החתימה. */
    if (report.expires_at === undefined || report.expires_at === null) {
      fail(CODE.PREFLIGHT_EXPIRED, 'לדוח אין תוקף. יש לבדוק מחדש.');
    }
    if (input.now === undefined || input.now === null) {
      fail(CODE.SHAPE, 'decidePromotion דורש את הזמן הנוכחי.');
    }
    if (timeOf(input.now) >= timeOf(report.expires_at)) {
      fail(CODE.PREFLIGHT_EXPIRED,
        'דוח הבדיקה פג. התחנה יכולה להיראות אחרת מאז. יש לבדוק מחדש.');
    }

    /* ⭐ והדוח חייב להיות של **המועמד הזה**, על התצורה שהמועמד נבנה
     * עליה. בלי זה, מועמד שנבנה על מקור A עובר תחת דוח שנבדק על
     * מקור B — שניהם חתומים, שניהם תקינים, ואף אחד מהם אינו מתאר
     * את מה שיופעל. */
    for (const field of ['candidate_source_id', 'candidate_policy_id']) {
      const expected = input[field];
      if (!isNonEmptyString(expected)) {
        fail(CODE.CANDIDATE_CONFIG, 'חסר ' + field + ' של המועמד.');
      }
      if (report[field] !== expected) {
        fail(CODE.CANDIDATE_CONFIG,
          'הדוח נבדק על תצורה אחרת מזו שהמועמד נבנה עליה (' + field + ').');
      }
    }

    /* ⭐ ושני העוגנים ש-TTL לבדו אינו מכסה.
     *
     * דוח יכול להיות טרי, חתום ותקין — ובכל זאת לתאר עולם שכבר זז.
     * שעתיים הן חלון ארוך בתחנה: אפשר לפרסם סידור legacy חדש, ואפשר
     * להחליף את הפרסום הפעיל. שניהם משנים את המשמעות של „מי ייעלם"
     * בלי לגעת באף digest שנבדק למעלה.
     *
     * ⭐ ההשוואה היא **קשיחה**: ערך חי שאינו ידוע אינו „מותר". דוח
     * שאין בו עוגן, מול עולם שיש בו — נדחה. אחרת החוזה הזה נסגר
     * בשקט ברגע שמישהו ישכח להעביר שדה. */
    const anchors = [
      ['legacy_revision', 'הסידור הישן פורסם מחדש מאז הבדיקה.'],
      ['predecessor_publication_id', 'הפרסום הפעיל הוחלף מאז הבדיקה.']
    ];
    for (const [field, why] of anchors) {
      const live = input[field] === undefined || input[field] === null
        ? null : String(input[field]);
      const atCheck = report[field] === undefined || report[field] === null
        ? null : String(report[field]);
      if (live !== atCheck) {
        fail(CODE.PREFLIGHT_STALE, why + ' יש לבדוק מחדש.', { field });
      }
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
