'use strict';

/* ====================================================================
 *  schedule-source-author — הפיכת רשימת כוח האדם למסמך
 *  `schedule_sources` שהמנוע קורא.
 *
 *  מודול טהור. אין Firebase, אין רשת, ואין קריאה לשום גיליון.
 *  הוא מקבל שורות שכבר נקראו, ומחזיר מסמך ודוח.
 *
 *  --------------------------------------------------------------
 *  ⭐ שני הכללים שקובעים את כל המודול
 *  --------------------------------------------------------------
 *
 *  **1. זהות היא מספר עובד. לא שם.**
 *
 *  התאמה לפי שם היא ניחוש. שני „כהן" בתחנה אינם באג נדיר — הם
 *  המצב הרגיל, וההבדל בין השניים הוא מי עובד בשבת. שורה בלי מספר
 *  עובד אינה מותאמת „לפי הדמיון הגבוה ביותר"; היא מדווחת, ואדם
 *  משלים את המספר בגיליון.
 *
 *  **2. הדוח מדבר בשורות, לא בערכים.**
 *
 *  „שורה 47 — חסר מספר עובד" ולא „דני כהן — חסר מספר עובד".
 *  הדוח הזה נכתב ליומן, נשלח במסך, ומודבק בהודעות. שם ומספר
 *  עובד לא צריכים להיות בשום אחד מהמקומות האלה כדי שהוא יהיה
 *  שימושי — מספר שורה מספיק לחלוטין כדי למצוא את השורה בגיליון.
 *
 *  --------------------------------------------------------------
 *  אדם שנפל מהרשימה
 *  --------------------------------------------------------------
 *
 *  ⭐ שורה שנדחתה אינה „דילגנו עליה". היא אדם שהמנוע לא ישבץ,
 *  ואיש לא ישים לב. לכן יבוא עם דחיות **אינו מייצר מסמך** אלא אם
 *  נמסר `accept_rejected` עם המספר המדויק של הדחיות — כדי שאי
 *  אפשר יהיה לאשר „בערך", אלא רק אחרי שראית כמה.
 * ==================================================================== */

const SCHEMA_VERSION = 1;

const LIMITS = Object.freeze({
  MAX_ROWS: 20000,
  MAX_ROLES_PER_PERSON: 32,
  MAX_NAME: 120,
  MAX_ID: 120
});

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
/* ⭐ P1-5. UID של Firebase אינו מוגבל לאותיות, ספרות, קו תחתון ומקף,
 * והוא יכול להגיע ל-128 תווים. `ID_RE` דחה נקודה ודחה 121–128 —
 * ומכיוון שהדחייה כאן היא `return` שקט, אדם עם UID כזה היה **נושר
 * מהמיפוי בלי שאיש יידע**, ואז נדחה כ„לא נמצא במערכת" למרות שהוא
 * קיים. זו הצורה הקנונית, זהה ל-`schedule-access.js`. */
const AUTH_UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/;
const EMPLOYEE_RE = /^[0-9]{1,20}$/;
// ⭐ רצף הברחה, לא התו עצמו. בגרסה קודמת היו כאן תווי בקרה
// ממשיים — ובהם NUL. גיט סיווג את הקובץ כבינארי, ולכן
// הוא לא הציג diff בשום ביקורת קוד.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** קודי דחייה. סגורים, ובעברית — הם מוצגים לאדם. */
const ROW = Object.freeze({
  NO_IDENTITY: 'row-no-employee-number',
  IDENTITY_INVALID: 'row-employee-number-invalid',
  UNKNOWN_PERSON: 'row-employee-number-unknown',
  DUPLICATE: 'row-duplicate-employee-number',
  AMBIGUOUS: 'row-employee-number-ambiguous',
  NO_SUB_STATION: 'row-sub-station-missing',
  SUB_STATION_UNKNOWN: 'row-sub-station-unknown',
  NO_ACTIVE: 'row-active-missing',
  NO_ROLES: 'row-roles-missing',
  ROLE_UNKNOWN: 'row-role-unknown',
  ROLE_DUPLICATE: 'row-role-duplicate',
  TOO_MANY_ROLES: 'row-too-many-roles',
  NAME_MISSING: 'row-name-missing',
  NAME_INVALID: 'row-name-invalid'
});

const ROW_TEXT = Object.freeze({
  'row-no-employee-number': 'אין מספר עובד. זיהוי לפי שם אינו מתבצע.',
  'row-employee-number-invalid': 'מספר העובד אינו מספר.',
  'row-employee-number-unknown': 'מספר העובד אינו קיים ברשימת המשתמשים של התחנה.',
  'row-duplicate-employee-number': 'מספר העובד מופיע ביותר משורה אחת.',
  'row-employee-number-ambiguous': 'מספר העובד משויך ליותר מחשבון אחד.',
  'row-sub-station-missing': 'אין תחנת קצה.',
  'row-sub-station-unknown': 'תחנת הקצה אינה מוגדרת בחוקי התחנה.',
  'row-active-missing': 'אין סימון פעיל/לא פעיל מפורש.',
  'row-roles-missing': 'אין ולו תפקיד סידור אחד.',
  'row-role-unknown': 'תפקיד שאינו מופיע בחוקי התחנה.',
  'row-role-duplicate': 'אותו תפקיד מופיע פעמיים.',
  'row-too-many-roles': 'יותר מדי תפקידים.',
  'row-name-missing': 'אין שם להצגה.',
  'row-name-invalid': 'השם מכיל תווי בקרה.'
});

const CODE = Object.freeze({
  SHAPE: 'source-author-shape',
  STATION: 'source-author-station',
  NO_POLICY: 'source-author-policy-required',
  NO_ROWS: 'source-author-no-rows',
  TOO_MANY: 'source-author-too-many-rows',
  REJECTED: 'source-author-rejected-rows',
  ACCEPT_MISMATCH: 'source-author-accept-mismatch',
  EMPTY_RESULT: 'source-author-empty-result',
  // ⭐ שלושת אלה נוספו אחרי ממצא P0-1 של Codex: יבוא סגל אִפֵּס
  // זמינות, נעילות ואירועים בלי לומר מילה.
  CARRY_SHAPE: 'source-author-carry-shape',
  CARRY_ORPHANED: 'source-author-carry-orphaned',
  CARRY_ACK_MISMATCH: 'source-author-carry-accept-mismatch'
});

class SourceAuthorError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'SourceAuthorError';
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
function fail(code, message, detail) {
  throw new SourceAuthorError(code, message, detail);
}

/**
 * ⭐ מראה מכוונת של `stable()` ב-`schedule-runtime.js:106`, בדיוק
 * כמו ב-`schedule-policy-author`.
 *
 * `loadSource` מחשב מחדש את חתימת התוכן ומסרב לאי-התאמה. סטייה
 * כאן נכתבת בהצלחה ונשברת מאוחר, אצל מישהו אחר. הבדיקה נועלת את
 * שני הצדדים זה לזה.
 */
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

// אותו סדר קוד-יחידה שבו הרנטיים ממיין מסמכים לפני החתימה.
function compareCanonical(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

function cleanName(value) {
  if (!isNonEmptyString(value)) return { ok: false, code: ROW.NAME_MISSING };
  if (CONTROL_RE.test(value)) return { ok: false, code: ROW.NAME_INVALID };
  return { ok: true, value: value.trim().slice(0, LIMITS.MAX_NAME) };
}

/* ------------------------ שורה אחת ------------------------ */

/**
 * ⭐ מחזיר דחייה, לא זורק.
 *
 * שורה פגומה אחת אינה אמורה להפיל יבוא של 300 שורות ולהשאיר את
 * מי שמתקן בלי לדעת כמה עוד שורות פגומות מחכות לו. כל השורות
 * נבדקות, והדוח מלא.
 */
function readRow(raw, index, policy, directory, seenEmployee) {
  const line = { row: Number.isInteger(raw && raw.row) ? raw.row : index + 1 };
  if (!isPlainObject(raw)) return { rejected: Object.assign({ code: ROW.NO_IDENTITY }, line) };

  const employee = raw.employee_number === undefined || raw.employee_number === null
    ? '' : String(raw.employee_number).trim();
  if (!employee) return { rejected: Object.assign({ code: ROW.NO_IDENTITY }, line) };
  if (!EMPLOYEE_RE.test(employee)) {
    return { rejected: Object.assign({ code: ROW.IDENTITY_INVALID }, line) };
  }
  if (seenEmployee.has(employee)) {
    return { rejected: Object.assign({ code: ROW.DUPLICATE }, line) };
  }

  const matches = directory.get(employee);
  if (!matches || !matches.length) {
    return { rejected: Object.assign({ code: ROW.UNKNOWN_PERSON }, line) };
  }
  if (matches.length > 1) {
    // ⭐ שני חשבונות על אותו מספר עובד היא תקלה בזהות, לא בשורה.
    // המודול אינו בוחר אחד מהם.
    return { rejected: Object.assign({ code: ROW.AMBIGUOUS, matches: matches.length }, line) };
  }
  const uid = matches[0].uid;

  const sub = isNonEmptyString(raw.sub_station) ? raw.sub_station.trim() : '';
  if (!sub) return { rejected: Object.assign({ code: ROW.NO_SUB_STATION }, line) };
  if (!policy.sub_stations[sub]) {
    return { rejected: Object.assign({ code: ROW.SUB_STATION_UNKNOWN }, line) };
  }

  // ⭐ „לא כתוב" אינו „לא פעיל". אדם שנשמט בטעות מהעמודה הזאת
  // היה נעלם מהסידור בשקט.
  if (typeof raw.active !== 'boolean') {
    return { rejected: Object.assign({ code: ROW.NO_ACTIVE }, line) };
  }

  const roles = Array.isArray(raw.roles) ? raw.roles : null;
  if (!roles || !roles.length) return { rejected: Object.assign({ code: ROW.NO_ROLES }, line) };
  if (roles.length > LIMITS.MAX_ROLES_PER_PERSON) {
    return { rejected: Object.assign({ code: ROW.TOO_MANY_ROLES }, line) };
  }
  const seenRole = new Set();
  const clean = [];
  for (const role of roles) {
    if (!isNonEmptyString(role) || !policy.roles.has(role.trim())) {
      return { rejected: Object.assign({ code: ROW.ROLE_UNKNOWN }, line) };
    }
    const value = role.trim();
    if (seenRole.has(value)) {
      return { rejected: Object.assign({ code: ROW.ROLE_DUPLICATE }, line) };
    }
    seenRole.add(value);
    clean.push(value);
  }
  clean.sort(compareCanonical);

  const name = cleanName(raw.full_name !== undefined ? raw.full_name : raw.name);
  if (!name.ok) return { rejected: Object.assign({ code: name.code }, line) };

  return {
    accepted: {
      uid,
      employee_number: employee,
      person: {
        // `id` נכתב במפורש וזהה למזהה המסמך: `loadSource` בונה
        // `Object.assign({ id: doc.id }, doc.data())`, ושדה `id`
        // סותר בגוף המסמך היה גובר על מזהה המסמך בשקט.
        id: uid,
        station_id: policy.station_id,
        sub_station: sub,
        active: raw.active,
        roles: clean,
        full_name: name.value,
        employee_number: employee,
        group: isNonEmptyString(raw.group) ? raw.group.trim().slice(0, LIMITS.MAX_ID) : null
      }
    }
  };
}

/* ============================ המודול ============================ */

function createSourceAuthor(deps) {
  const d = deps || {};
  if (typeof d.clock !== 'function') fail(CODE.SHAPE, 'חובה להזריק clock');
  if (typeof d.hash !== 'function') fail(CODE.SHAPE, 'חובה להזריק hash');
  const clock = d.clock, hash = d.hash;

  function normalizePolicy(raw) {
    if (!isPlainObject(raw) || !isPlainObject(raw.sub_stations)
        || !Object.keys(raw.sub_stations).length) {
      fail(CODE.NO_POLICY,
        'אי אפשר לייבא מקור לפני שהוגדרו חוקי תחנה: בלעדיהם אין לפי מה '
        + 'לדעת אילו תחנות קצה ואילו תפקידים קיימים.');
    }
    const roles = new Set();
    Object.keys(raw.sub_stations).forEach((key) => {
      const sub = raw.sub_stations[key];
      (sub && Array.isArray(sub.requirements) ? sub.requirements : []).forEach((item) => {
        if (item && isNonEmptyString(item.role)) roles.add(item.role);
      });
    });
    return { station_id: raw.station_id, sub_stations: raw.sub_stations, roles };
  }

  /**
   * מיפוי מספר עובד → חשבונות. מערך ולא ערך יחיד, כדי שכפילות
   * תהיה מצב שאפשר לדווח עליו ולא ערך אחרון ששרד.
   */
  function buildDirectory(known) {
    const map = new Map();
    (Array.isArray(known) ? known : []).forEach((person) => {
      if (!isPlainObject(person)) return;
      const employee = person.employee_number === undefined || person.employee_number === null
        ? '' : String(person.employee_number).trim();
      if (!employee || !isNonEmptyString(person.uid) || !AUTH_UID_RE.test(person.uid)) return;
      if (!map.has(employee)) map.set(employee, []);
      map.get(employee).push({ uid: person.uid });
    });
    return map;
  }

  /**
   * @param {object} input
   *   station_id, rows[], known[], policy, previous|null, actor_uid,
   *   accept_rejected  מספר הדחיות שאדם ראה ואישר, או undefined
   */
  function planSource(input) {
    if (!isPlainObject(input)) fail(CODE.SHAPE, 'קלט לא תקין');
    const stationId = input.station_id;
    if (!isNonEmptyString(stationId) || !ID_RE.test(stationId)) {
      fail(CODE.STATION, 'חסרה תחנה, או שהמזהה אינו תקין.');
    }
    const policy = normalizePolicy(input.policy);
    if (policy.station_id !== stationId) {
      fail(CODE.STATION, 'חוקי התחנה שייכים לתחנה אחרת.');
    }
    if (!policy.roles.size) {
      fail(CODE.NO_POLICY, 'בחוקי התחנה אין ולו תפקיד אחד, ולכן אין לפי מה לייבא.');
    }

    const rows = Array.isArray(input.rows) ? input.rows : null;
    if (!rows || !rows.length) fail(CODE.NO_ROWS, 'אין שורות לייבוא.');
    if (rows.length > LIMITS.MAX_ROWS) {
      fail(CODE.TOO_MANY, 'יותר מ-' + LIMITS.MAX_ROWS + ' שורות.');
    }

    const directory = buildDirectory(input.known);
    const seenEmployee = new Set();
    const accepted = [];
    const rejected = [];
    rows.forEach((raw, index) => {
      const result = readRow(raw, index, policy, directory, seenEmployee);
      if (result.rejected) { rejected.push(result.rejected); return; }
      seenEmployee.add(result.accepted.employee_number);
      accepted.push(result.accepted);
    });

    // ⭐ ספירה לפי קוד. זה מה שאפשר לכתוב ליומן בלי לחשוב פעמיים.
    const byCode = {};
    rejected.forEach((item) => { byCode[item.code] = (byCode[item.code] || 0) + 1; });

    const report = Object.freeze({
      total: rows.length,
      accepted: accepted.length,
      rejected: rejected.length,
      by_code: byCode,
      // שורות בלבד. שום שם, שום מספר עובד.
      rows: Object.freeze(rejected.map((item) => Object.freeze({
        row: item.row, code: item.code, text: ROW_TEXT[item.code] || item.code,
        matches: item.matches === undefined ? undefined : item.matches
      })).sort((a, b) => a.row - b.row))
    });

    if (!accepted.length) {
      fail(CODE.EMPTY_RESULT,
        'אף שורה לא עברה. מקור ריק אינו מקור.', { report });
    }

    /* ⭐ שורה שנדחתה היא אדם שהמנוע לא ישבץ, ואיש לא ישים לב.
     * אישור „בערך" אינו אישור: צריך למסור את המספר המדויק. */
    if (rejected.length) {
      if (input.accept_rejected === undefined || input.accept_rejected === null) {
        fail(CODE.REJECTED,
          rejected.length + ' שורות לא ייכנסו למקור. כל אחת מהן היא אדם '
          + 'שהמנוע לא ישבץ. יש לאשר את המספר הזה במפורש.', { report });
      }
      if (input.accept_rejected !== rejected.length) {
        fail(CODE.ACCEPT_MISMATCH,
          'אושרו ' + input.accept_rejected + ' דחיות, ובפועל יש '
          + rejected.length + '. הרשימה השתנתה מאז שנבדקה.', { report });
      }
    }

    accepted.sort((a, b) => compareCanonical(a.uid, b.uid));

    /* ==================================================================
     * העברת זמינות · נעילות · אירועים · carry
     *
     * ⭐ P0-1. הגרסה הקודמת של הפונקציה הזאת כתבה כאן `carry: {}`,
     * `availability: {}`, `locked: {}` ו-`events: []` — ארבעה ליטרלים
     * ריקים. המשמעות בפועל: **כל יבוא של רשימת סגל מחק את זמינות
     * התחנה, את הנעילות ואת האירועים.** רכזת שהוסיפה אדם אחד לגיליון
     * ולחצה „שמור" איבדה את כל מה שהוזן קודם, בלי אזהרה ובלי שורה
     * ביומן. הבדיקות שלי עברו כי הן בדקו מה שנכתב — לא מה שנמחק.
     *
     * יבוא סגל הוא יבוא **סגל**. הוא אינו נוגע בשלושת האחרים, והם
     * עוברים מהמקור הפעיל כפי שהם — בית-בית, באותם מזהי מסמך ובאותו
     * תוכן, כדי שהחתימה שהרנטיים מחשב מחדש תתאים.
     * ================================================================== */

    const people = accepted.map((item) => item.person);
    const known = new Set(people.map((person) => person.id));
    const carried = carriedFrom(input.previous);

    /* אדם שיצא מהרשימה — הזמינות והנעילות שלו כבר אינן שייכות למקור.
     * ⭐ אבל להשמיט אותן בשקט זה בדיוק הבאג שאני מתקן. הן נספרות,
     * מדווחות, ודורשות אישור מספרי מדויק בדיוק כמו שורה שנדחתה. */
    const availability = {};
    const locked = {};
    const orphaned = { availability: 0, locked: 0 };
    for (const uid of Object.keys(carried.availability).sort(compareCanonical)) {
      if (known.has(uid)) availability[uid] = carried.availability[uid];
      else orphaned.availability += 1;
    }
    for (const uid of Object.keys(carried.locked).sort(compareCanonical)) {
      if (known.has(uid)) locked[uid] = carried.locked[uid];
      else orphaned.locked += 1;
    }
    /* אירועים אינם מפתוחים לפי אדם — הם של התחנה — ולכן עוברים כולם. */
    const events = carried.events;

    const orphanTotal = orphaned.availability + orphaned.locked;
    if (orphanTotal) {
      if (input.accept_carry_dropped === undefined || input.accept_carry_dropped === null) {
        fail(CODE.CARRY_ORPHANED,
          orphanTotal + ' רשומות של זמינות או נעילה שייכות לאנשים שאינם '
          + 'ברשימה החדשה, ולכן ייצאו מהמקור. יש לאשר את המספר הזה במפורש.',
          { orphaned });
      }
      if (input.accept_carry_dropped !== orphanTotal) {
        fail(CODE.CARRY_ACK_MISMATCH,
          'אושרו ' + input.accept_carry_dropped + ' רשומות שיוצאות, ובפועל יש '
          + orphanTotal + '. הרשימה השתנתה מאז שנבדקה.', { orphaned });
      }
    }

    /* --- הבסיס שהרנטיים חותם עליו --- *
     * `schedule-runtime.js` (`loadSource`) בונה בדיוק את השדות
     * האלה ומחשב עליהם `digest(basis)`. הצורה אינה שלנו. */
    const counts = {
      people: people.length,
      availability: Object.keys(availability).length,
      locked: Object.keys(locked).length,
      events: events.length
    };
    /* ⭐ `content_key` נגזר מהסגל בלבד, ובכוונה: הוא עונה על השאלה
     * „האם רשימת הסגל השתנתה". התוכן שעבר אינו חלק ממנה. */
    const contentKey = String(hash(stable({ station_id: stationId, people })));

    const prev = isPlainObject(input.previous) ? input.previous : null;
    if (prev && isNonEmptyString(prev.content_key) && prev.content_key === contentKey) {
      return Object.freeze({
        kind: 'unchanged',
        source_id: prev.id || null,
        version: prev.version || null,
        revision: prev.revision || null,
        digest: isNonEmptyString(prev.content_digest) ? prev.content_digest : null,
        content_key: contentKey,
        meta: null, people: [], counts, report,
        audit: auditOf(stationId, input.actor_uid, report, null)
      });
    }

    const prevRevision = prev && /^[0-9]+$/.test(String(prev.revision || ''))
      ? Number(prev.revision) : 0;
    const revision = String(prevRevision + 1);
    const version = 'v' + SCHEMA_VERSION;

    const basis = {
      station_id: stationId,
      version,
      revision,
      carry: carried.carry,
      counts,
      people,
      availability,
      locked,
      events
    };
    const digest = String(hash(stable(basis)));

    const sourceId = 'source_' + revision + '_' + contentKey.slice(0, 12);
    const meta = {
      schema_version: SCHEMA_VERSION,
      station_id: stationId,
      // `loadSource` דורש `complete === true`. מקור חלקי אינו מקור.
      complete: true,
      version,
      revision,
      carry: carried.carry,
      person_count: counts.people,
      availability_count: counts.availability,
      locked_count: counts.locked,
      event_count: counts.events,
      content_digest: digest,
      content_key: contentKey,
      created_at: new Date(clock()).toISOString(),
      created_by: isNonEmptyString(input.actor_uid) ? input.actor_uid : null,
      supersedes: prev && prev.id ? prev.id : null,
      // ⭐ ספירות בלבד. הדוח המלא חוזר לקורא ואינו נכתב למסמך.
      import_total_rows: report.total,
      import_rejected_rows: report.rejected
    };

    return Object.freeze({
      kind: prev ? 'updated' : 'created',
      source_id: sourceId,
      version, revision, digest,
      content_key: contentKey,
      meta,
      // מסמכי תת-האוסף, במזהה שלהם. הכותב אינו ממציא מזהים.
      people: Object.freeze(people.map((person) => Object.freeze({
        id: person.id, data: person
      }))),
      /* ⭐ שלושת אלה חייבים להיכתב יחד עם `people`. מקור שנכתב בלי
       * תת-האוסף שלהם ייקרא כריק — והחתימה תיפול, כי `loadSource`
       * סופר את המסמכים בפועל מול הספירה שבמסמך. */
      availability: Object.freeze(Object.keys(availability).map((uid) => Object.freeze({
        id: uid, data: { days: availability[uid] }
      }))),
      locked: Object.freeze(Object.keys(locked).map((uid) => Object.freeze({
        id: uid, data: { days: locked[uid] }
      }))),
      events: Object.freeze(events.map((event) => Object.freeze({
        id: event.id, data: event
      }))),
      carried_dropped: Object.freeze(Object.assign({}, orphaned)),
      counts, report,
      audit: auditOf(stationId, input.actor_uid, report, digest, orphaned)
    });
  }

  function auditOf(stationId, actor, report, digest, orphaned) {
    return {
      at: new Date(clock()).toISOString(),
      station_id: stationId,
      actor: isNonEmptyString(actor) ? actor : null,
      content_digest: digest,
      // ⭐ מספרים וקודים. אין כאן שם, אין מספר עובד ואין מספר שורה —
      // שורה מזהה אדם בגיליון, ויומן אינו המקום לזה.
      total_rows: report.total,
      accepted_rows: report.accepted,
      rejected_rows: report.rejected,
      rejected_by_code: report.by_code,
      // ספירות בלבד — מי יצא מהמקור הוא אדם, ואין לו מקום ביומן.
      carry_dropped_availability: orphaned ? orphaned.availability : 0,
      carry_dropped_locked: orphaned ? orphaned.locked : 0
    };
  }

  /* קורא את מה שעובר מהמקור הפעיל, בצורה ש-`loadSource` מייצר.
   * ⭐ צורה שאינה מוכרת אינה „ריק" — היא כשל. מקור פעיל שאיננו
   * יודעים לקרוא הוא בדיוק המצב שבו מחיקה שקטה קורית. */
  function carriedFrom(previous) {
    if (!isPlainObject(previous)) {
      return { carry: {}, availability: {}, locked: {}, events: [] };
    }
    const carried = isPlainObject(previous.carried) ? previous.carried : null;
    if (!carried) {
      fail(CODE.CARRY_SHAPE,
        'למקור הפעיל לא צורף התוכן שעובר. יבוא במצב הזה היה מוחק '
        + 'זמינות, נעילות ואירועים.');
    }
    for (const field of ['carry', 'availability', 'locked']) {
      if (!isPlainObject(carried[field])) {
        fail(CODE.CARRY_SHAPE, 'התוכן שעובר פגום: ' + field + ' אינו אובייקט.');
      }
    }
    if (!Array.isArray(carried.events)) {
      fail(CODE.CARRY_SHAPE, 'התוכן שעובר פגום: events אינו מערך.');
    }
    for (const event of carried.events) {
      if (!isPlainObject(event) || !isNonEmptyString(event.id)) {
        fail(CODE.CARRY_SHAPE, 'התוכן שעובר פגום: לאירוע אין מזהה.');
      }
    }
    return {
      carry: carried.carry,
      availability: carried.availability,
      locked: carried.locked,
      events: carried.events
    };
  }

  return Object.freeze({
    planSource, SCHEMA_VERSION, LIMITS, CODE, ROW, ROW_TEXT
  });
}

module.exports = {
  createSourceAuthor, SourceAuthorError,
  SCHEMA_VERSION, LIMITS, CODE, ROW, ROW_TEXT
};
