'use strict';

/* ======================================================================
 *  hr-monthly-summary — הדוח החודשי המאוחד, שעות והיעדרויות מאושרות
 *
 *  ----------------------------------------------------------------
 *  למה הוא בנוי מדורג, ולא כמסמך אחד
 *  ----------------------------------------------------------------
 *  תקרת מסמך ב-Firestore היא 1 MiB. שורה אחת לעובד — מספר עובד, שם
 *  עד 160 תווים בעברית, משמרת, ארבעה מוני ימים, סך שעות ודגלים —
 *  שוקלת כ-400–600 בייט. 3,000 עובדים הם כמיליון וחצי בייט, כלומר
 *  **הכתיבה נכשלת**. זו בדיוק הסיבה שהדוח הישן שמר `over.slice(0, 200)`
 *  ולא את כולם: הוא לא בחר לקצר, הוא נאלץ.
 *
 *  לכן המבנה הוא מסמך חודש קטן + שורה לעובד בתת-אוסף של **דור**:
 *
 *      hr_monthly_summaries/{month}                       ← כותרת קטנה
 *        hr_monthly_generations/{generationId}            ← דור אחד
 *          hr_monthly_rows/{uid}                          ← שורה לעובד
 *
 *  ⭐ **הדור הוא מה שהופך את ההפעלה לאטומית.** הבנייה כותבת דור חדש
 *  לגמרי, והוא אינו נקרא על ידי אף אחד כל עוד `active_generation`
 *  במסמך החודש אינו מצביע עליו. ההחלפה היא CAS בעסקה אחת, ורק אחרי
 *  שהדור הושלם ושהטביעה שלו תואמת. חודש חצי-בנוי אינו מוצג לעולם —
 *  לא מפני שמישהו יזכור לבדוק, אלא מפני שאין לו דרך להיות מוצג.
 *
 *  ⭐ **ו-idempotency אינו הבטחה אלא מזהה.** מזהה הדור נגזר מ-
 *  `hash([schema, station, month, intent])`. ריצה חוזרת עם אותה כוונה
 *  פוגעת באותו מסמך בדיוק, ממשיכה מהסמן שלו, ואינה מייצרת דור שני.
 *  כוונה אחרת — ריצה ידנית של מנהל, או הפקה מחדש אחרי שינוי הכרעה —
 *  מייצרת דור חדש לגמרי, שמוחלף רק כשהוא שלם.
 *
 *  ----------------------------------------------------------------
 *  מה נספר, ומה במפורש אינו נספר
 *  ----------------------------------------------------------------
 *  **רק היעדרות שאושרה נספרת כמאושרת.** דיווח שממתין להכרעה נספר
 *  בשדות `pending_*` בנפרד, ואינו מתערבב בסכומים המאושרים לעולם.
 *  דיווח שנדחה אינו נספר כלל.
 *
 *  הספירה היא **ימים בתוך החודש**, לא ימים בדיווח: היעדרות
 *  28.8–3.9 תורמת שלושה ימים לספטמבר. הימים נשמרים כקבוצה ולכן שני
 *  דיווחים שחופפים אינם נספרים פעמיים.
 *
 *  **היעדרות ממושכת פתוחה אינה עוברת דרך `hr_requests`.** לדיווח עם
 *  טווח יש תקרה מוצהרת (400 יום), ומה שמעליה הוא מעקב כוח אדם ב-
 *  `hr_workforce_cases`. הדוח קורא את שני המקורות ומציג אותם כשני
 *  שדות נפרדים, כי הם שני דברים שונים: דיווח של עובד, ומעקב שמשאבי
 *  אנוש פתחו.
 *
 *  **חריגת השעות היא התרעת ניטור ולא יותר.** אין בדוח הזה אישור,
 *  דחייה, חסימת שיבוץ או חסימת פרסום. הסף עצמו נקרא מ-
 *  `stations/{sid}/config/hr`, ולא מקובע בקוד: „hrConfig לכל תחנה"
 *  הוא הכרעה, וסף אחד קשיח היה מפר אותה בשקט.
 *
 *  ----------------------------------------------------------------
 *  כיסוי — ומה קורה כשהוא אינו שלם
 *  ----------------------------------------------------------------
 *  השאילתה על ההיעדרויות היא `months array-contains`, ו-`months` נכתב
 *  מהרגע שהשדה קיים. דיווח שנוצר לפניו **אינו נמצא בשאילתה הזו**, ולכן
 *  כל דוח נושא `coverage`:
 *
 *    · `complete`       — כלי ה-backfill סיים וסימן שסיים.
 *    · `legacy_pending` — יש אולי דיווחים שאינם מסווגים.
 *
 *  ⭐ דוח עם `legacy_pending` **אינו מוצג כשלם**. זה לא באג שמסתירים
 *  עד שיתקנו; זו עובדה על הנתונים, והיא נאמרת במסמך עצמו כדי שמי
 *  שקורא אותו יידע מה הוא קורא.
 *
 *  ----------------------------------------------------------------
 *  מה המודול הזה אינו
 *  ----------------------------------------------------------------
 *  - **אינו שולח מייל.** אין ספק דואר מאומת במסלול הזה, והמנגנון
 *    שפרש לא חוזר. הדוח נשמר ומוצג במערכת.
 *  - **אינו מאתחל SDK** ואינו מייצא callables. `db` ו-`HttpsError`
 *    מוזרקים.
 *  - **אינו חוסם דבר.** לא שיבוץ, לא פרסום, לא התראה.
 *  - **אינו פותח אינדקס מורכב.** כל שאילתה כאן היא שוויון בודד או
 *    `array-contains` בודד, שהאינדקס האוטומטי של שדה בודד מכסה.
 * ====================================================================== */

const { createHash } = require('node:crypto');

const SCHEMA_MONTH = 'hr-monthly-summary-v1';
const SCHEMA_GENERATION = 'hr-monthly-generation-v1';
const SCHEMA_ROW = 'hr-monthly-row-v1';
const SCHEMA_BACKFILL = 'hr-months-backfill-v1';
const BACKFILL_DOC = 'hr-months-backfill-v1';

const USER_PAGE = 100;          // עמוד בנייה. לא בתוך עסקה.
const READ_PAGE = 25;           // עמוד קריאה ל-callable.
const ABSENCE_CAP = 5000;       // תקרה קשיחה. חריגה היא שגיאה, לא קיצור.
const WORKFORCE_CAP = 2000;
const ROW_STRING = 160;
const DEFAULT_HOUR_LIMIT = 265;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATION = /^[a-z0-9_-]{2,80}$/;
const DAY_MS = 86400000;

const ABSENCE_KINDS = Object.freeze(['sick', 'reserve', 'vacation', 'extended_absence']);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text = (value, max = ROW_STRING) => (typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

/** גבולות החודש, ב-UTC, כמפתחות יום. */
function monthBounds(month) {
  const year = Number(month.slice(0, 4)), index = Number(month.slice(5, 7));
  const first = Date.UTC(year, index - 1, 1);
  const next = Date.UTC(index === 12 ? year + 1 : year, index === 12 ? 0 : index, 1);
  return { first, last: next - DAY_MS, days: Math.round((next - first) / DAY_MS) };
}
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * הימים שדיווח תורם לחודש — חיתוך, לא כל הטווח.
 * טווח לא תקין מחזיר רשימה ריקה ואינו נזרק: המודול מדלג על נתון
 * פגום ומדווח עליו, ואינו מפיל דוח שלם בגללו.
 */
function daysInMonth(from, to, month) {
  if (!DAY.test(String(from)) || !DAY.test(String(to))) return [];
  const start = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const bounds = monthBounds(month);
  const lower = Math.max(start, bounds.first), upper = Math.min(end, bounds.last);
  if (upper < lower) return [];
  const out = [];
  for (let at = lower; at <= upper; at += DAY_MS) out.push(dayKey(at));
  return out;
}

function createHrMonthlySummary({ db, HttpsError, clock = Date.now, hooks = {} }) {
  if (!db || typeof db.collection !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db and HttpsError are required');
  }
  const error = (code, message) => new HttpsError(code, message);
  const root = sid => db.collection('stations').doc(sid);
  const monthRef = (sid, month) => root(sid).collection('hr_monthly_summaries').doc(month);
  const generationRef = (sid, month, id) =>
    monthRef(sid, month).collection('hr_monthly_generations').doc(id);
  const rowRef = (sid, month, id, uid) =>
    generationRef(sid, month, id).collection('hr_monthly_rows').doc(uid);
  const backfillRef = sid => root(sid).collection('hr_request_counters').doc(BACKFILL_DOC);

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value)) throw error('internal', 'Invalid clock.');
    return value;
  }
  function scope(stationId, month) {
    if (typeof stationId !== 'string' || !STATION.test(stationId)) throw error('invalid-argument', 'Invalid station.');
    if (typeof month !== 'string' || !MONTH.test(month)) throw error('invalid-argument', 'Invalid month.');
    return { sid: stationId, month };
  }
  const generationId = (sid, month, intent) => hash([SCHEMA_GENERATION, sid, month, intent]);

  /** סף השעות של התחנה. ברירת מחדל של הפלטפורמה, לא של תחנה אחת. */
  async function hourLimit(sid) {
    const snap = await root(sid).collection('config').doc('hr').get();
    const value = snap.exists ? snap.data() : null;
    const limit = plain(value) ? Number(value.hour_limit) : NaN;
    return Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_HOUR_LIMIT;
  }

  /* ⭐ `complete` דורש שתי עובדות יחד, ולא אחת: שהסריקה הסתיימה,
   * ושלא נשאר דיווח שאי אפשר לסווג או שמסווג בסתירה. סריקה
   * שהסתיימה והשאירה שלושים דיווחים ללא סיווג אינה כיסוי שלם,
   * והדוח אינו אומר שהוא שלם. */
  async function coverageOf(sid) {
    const snap = await backfillRef(sid).get();
    const value = snap.exists ? snap.data() : null;
    if (!plain(value) || value.schema !== SCHEMA_BACKFILL) return 'legacy_pending';
    if (!Number.isSafeInteger(value.completed_at_ms) || value.completed_at_ms <= 0) return 'legacy_pending';
    const totals = plain(value.totals) ? value.totals : {};
    const left = (Number.isSafeInteger(totals.unclassifiable) ? totals.unclassifiable : 0)
      + (Number.isSafeInteger(totals.conflicting) ? totals.conflicting : 0);
    return left === 0 ? 'complete' : 'legacy_pending';
  }

  /**
   * מפת ההיעדרויות של החודש, פעם אחת לכל הרצה.
   *
   * שאילתה אחת — `months array-contains` — ואחריה סינון בזיכרון של
   * סוג והכרעה. שוויון שני היה דורש אינדקס מורכב שאינו קיים, ולכן
   * הוא נעשה כאן ולא בשאילתה. הקריאה מעומדת לפי `__name__` ויש לה
   * תקרה קשיחה: חריגה היא שגיאה מדווחת, לא דוח מקוצר בשקט.
   */
  async function absenceIndex(sid, month) {
    const byUid = new Map();
    let cursor = null, seen = 0, malformed = 0;
    for (;;) {
      let query = root(sid).collection('hr_requests')
        .where('months', 'array-contains', month).orderBy('__name__').limit(USER_PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const snap of page.docs) {
        seen += 1;
        if (seen > ABSENCE_CAP) {
          throw error('resource-exhausted',
            'The month holds more absence reports than this report is bounded to read. The report was not published.');
        }
        const value = snap.data();
        if (!plain(value) || value.schema !== 'hr-request-v1' || value.station_id !== sid
          || typeof value.owner_uid !== 'string' || !value.owner_uid
          || !ABSENCE_KINDS.includes(value.kind)) { malformed += 1; continue; }
        const days = daysInMonth(value.from_date, value.to_date, month);
        if (!days.length) { malformed += 1; continue; }
        if (value.decision !== 'approved' && value.decision !== 'pending') continue;
        const bucket = byUid.get(value.owner_uid) || { approved: new Map(), pending: new Map() };
        const side = value.decision === 'approved' ? bucket.approved : bucket.pending;
        const set = side.get(value.kind) || new Set();
        for (const day of days) set.add(day);
        side.set(value.kind, set);
        byUid.set(value.owner_uid, bucket);
      }
      if (page.docs.length < USER_PAGE) break;
      cursor = page.docs[page.docs.length - 1].id;
    }
    return { byUid, seen, malformed };
  }

  /**
   * מעקבי היעדרות ממושכת שחופפים את החודש.
   * מקור נפרד, שדה נפרד בדוח: זה מעקב שמשאבי אנוש פתחו, ולא דיווח
   * של עובד. `end_date` ריק פירושו פתוח, ולכן החפיפה נבדקת בזיכרון
   * ולא בסינון טווח — סינון טווח על שדה היה מוריד בדיוק את אלה.
   */
  async function longAbsenceIndex(sid, month) {
    const bounds = monthBounds(month);
    const byUid = new Map();
    let cursor = null, seen = 0;
    for (;;) {
      let query = root(sid).collection('hr_workforce_cases')
        .where('kind', '==', 'long_absence').orderBy('__name__').limit(USER_PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const snap of page.docs) {
        seen += 1;
        if (seen > WORKFORCE_CAP) {
          throw error('resource-exhausted',
            'The station holds more workforce cases than this report is bounded to read. The report was not published.');
        }
        const value = snap.data();
        if (!plain(value) || typeof value.owner_uid !== 'string' || !value.owner_uid) continue;
        if (!DAY.test(String(value.start_date))) continue;
        const start = Date.parse(value.start_date + 'T00:00:00Z');
        if (!Number.isFinite(start) || start > bounds.last) continue;
        // ריק או חסר = פתוח, ולכן חופף כל חודש שמתחיל אחרי ההתחלה.
        const openEnded = !own(value, 'end_date') || value.end_date === null || value.end_date === '';
        if (!openEnded) {
          if (!DAY.test(String(value.end_date))) continue;
          const end = Date.parse(value.end_date + 'T00:00:00Z');
          if (!Number.isFinite(end) || end < bounds.first) continue;
        }
        byUid.set(value.owner_uid, { open_ended: openEnded, start_date: value.start_date,
          ...(openEnded ? {} : { end_date: value.end_date }) });
      }
      if (page.docs.length < USER_PAGE) break;
      cursor = page.docs[page.docs.length - 1].id;
    }
    return { byUid, seen };
  }

  const countOf = (side, kind) => (side.get(kind) ? side.get(kind).size : 0);

  /* ⭐ טביעת המקור מה שנספר, ולא מכמה מסמכים נקראו.
   *
   * הגרסה הראשונה גיבבה ספירות מסמכים, והבדיקה של שינוי
   * הכרעה הפילה אותה מיד: דיווח שעבר מ‎-`pending` ל-`approved`
   * הוא אותו מסמך בדיוק, ולכן הספירה לא זזה — והטביעה היתה
   * זהה לשני דוחות שאומרים דברים שונים. טביעה שאינה זזה
   * כשהקלט זז גרועה מאין טביעה, כי היא מזמינה להסיק „אותה
   * טביעה, אותו דוח".
   *
   * עכשיו הטביעה נגזרת מהתוכן: לכל עובד, לכל צד ולכל סוג,
   * מספר הימים שנכנסו לחודש — בסדר דטרמיניסטי, כדי ששני קלטים
   * זהים ייתנו אותה טביעה ושני שונים לא. */
  function absenceFingerprint(absences) {
    const lines = [];
    for (const [uid, bucket] of absences.byUid) {
      for (const side of ['approved', 'pending']) {
        for (const kind of ABSENCE_KINDS) {
          const set = bucket[side].get(kind);
          if (set && set.size) lines.push(uid + '|' + side + '|' + kind + '|' + set.size);
        }
      }
    }
    lines.sort();
    return hash(['hr-monthly-absence-fingerprint-v1', lines]);
  }
  function longAbsenceFingerprint(longAbsences) {
    const lines = [];
    for (const [uid, value] of longAbsences.byUid) {
      lines.push(uid + '|' + (value.open_ended ? 'open' : value.end_date) + '|' + value.start_date);
    }
    lines.sort();
    return hash(['hr-monthly-long-absence-fingerprint-v1', lines]);
  }

  /** שורת עובד אחת. אין בה uid של מי שהכריע ואין בה נתיב Storage. */
  function buildRow(context, user, reportValue) {
    const { month, limit, absences, longAbsences } = context;
    const bucket = absences.byUid.get(user.uid) || { approved: new Map(), pending: new Map() };
    const stored = plain(reportValue) ? Number(reportValue.total_hours) : NaN;
    const hours = Number.isFinite(stored) ? Math.round(stored * 100) / 100 : null;
    const state = plain(reportValue) && typeof reportValue.status === 'string' ? reportValue.status : 'missing';
    const long = longAbsences.byUid.get(user.uid) || null;
    return {
      schema: SCHEMA_ROW, month, uid: user.uid,
      employee_number: text(user.employee_number, 64),
      full_name: text(user.full_name, ROW_STRING),
      crew: text(user.crew, 40),
      total_hours: hours,
      hours_state: ['missing', 'draft', 'submitted', 'approved'].includes(state) ? state : 'missing',
      approved_sick_days: countOf(bucket.approved, 'sick'),
      approved_reserve_days: countOf(bucket.approved, 'reserve'),
      approved_vacation_days: countOf(bucket.approved, 'vacation'),
      approved_extended_absence_days: countOf(bucket.approved, 'extended_absence'),
      pending_sick_days: countOf(bucket.pending, 'sick'),
      pending_reserve_days: countOf(bucket.pending, 'reserve'),
      pending_vacation_days: countOf(bucket.pending, 'vacation'),
      pending_extended_absence_days: countOf(bucket.pending, 'extended_absence'),
      long_absence: long,
      // התרעת ניטור בלבד. אינה חוסמת דבר ואינה דורשת הכרעה.
      over_hour_limit: hours !== null && hours > limit,
      hour_limit: limit
    };
  }

  /** קורא עובדים פעילים והיסטוריים כאחד: דוח חודש שהסתיים כולל את מי שעזב בו. */
  function personOf(snap) {
    const value = snap.exists ? snap.data() : null;
    if (!plain(value)) return null;
    const emp = own(value, 'employee_number') ? value.employee_number : '';
    return { uid: snap.id,
      employee_number: typeof emp === 'string' || typeof emp === 'number' ? String(emp) : '',
      full_name: value.full_name, crew: own(value, 'crew') ? value.crew : value.shift };
  }

  /**
   * פותח דור, או מחזיר את הקיים לאותה כוונה בדיוק.
   * זו נקודת ה-idempotency: אותו `intent_id` הוא אותו מזהה דור.
   */
  async function beginGeneration(input) {
    const { sid, month } = scope(input && input.station_id, input && input.month);
    const intent = typeof input.intent_id === 'string' && input.intent_id.trim()
      ? input.intent_id.trim().slice(0, 120) : month;
    const id = generationId(sid, month, intent);
    const at = now();
    const created = await db.runTransaction(async tx => {
      const snap = await tx.get(generationRef(sid, month, id));
      if (snap.exists) {
        const value = snap.data();
        if (!plain(value) || value.schema !== SCHEMA_GENERATION || value.month !== month
          || value.station_id !== sid) throw error('failed-precondition', 'Generation data is invalid.');
        return false;
      }
      if (typeof hooks.beforeBegin === 'function') await hooks.beforeBegin();
      tx.create(generationRef(sid, month, id), { schema: SCHEMA_GENERATION, generation_id: id,
        station_id: sid, month, intent_id: intent, state: 'building', started_at_ms: at,
        cursor: null, rows: 0, completed_at_ms: null });
      return true;
    });
    return { generation_id: id, created, intent_id: intent };
  }

  /** עמוד בנייה אחד. מחזיר `done` כשאין עוד עובדים. */
  async function runSlice(input, context) {
    const { sid, month } = scope(input && input.station_id, input && input.month);
    const id = String(input.generation_id || '');
    const snap = await generationRef(sid, month, id).get();
    const generation = snap.exists ? snap.data() : null;
    if (!plain(generation) || generation.schema !== SCHEMA_GENERATION
      || generation.station_id !== sid || generation.month !== month) throw error('not-found', 'Generation not found.');
    if (generation.state === 'ready') return { done: true, written: 0, rows: generation.rows };
    let query = root(sid).collection('users').orderBy('__name__').limit(USER_PAGE);
    if (typeof generation.cursor === 'string' && generation.cursor) query = query.startAfter(generation.cursor);
    const page = await query.get();
    if (page.empty) {
      await generationRef(sid, month, id).set({ state: 'complete', completed_at_ms: now() }, { merge: true });
      return { done: true, written: 0, rows: generation.rows };
    }
    const people = page.docs.map(personOf).filter(Boolean);
    const reportRefs = people.map(person => root(sid).collection('monthly_reports')
      .doc(String(person.employee_number) + '_' + month));
    // קריאה מקובצת אחת לכל העמוד, ולא אחת לעובד.
    const reports = reportRefs.length && typeof db.getAll === 'function'
      ? await db.getAll(...reportRefs) : [];
    const batch = [];
    for (let index = 0; index < people.length; index += 1) {
      const reportSnap = reports[index];
      const value = reportSnap && reportSnap.exists ? reportSnap.data() : null;
      batch.push([people[index].uid, buildRow(context, people[index], value)]);
    }
    for (const [uid, row] of batch) await rowRef(sid, month, id, uid).set(row);
    const last = page.docs[page.docs.length - 1].id;
    const done = page.docs.length < USER_PAGE;
    await generationRef(sid, month, id).set({
      cursor: done ? last : last,
      rows: (Number.isSafeInteger(generation.rows) ? generation.rows : 0) + batch.length,
      ...(done ? { state: 'complete', completed_at_ms: now() } : {})
    }, { merge: true });
    return { done, written: batch.length, rows: (generation.rows || 0) + batch.length };
  }

  /**
   * מחליף את הדור הפעיל — CAS, בעסקה אחת, ורק על דור שלם.
   * דור חלקי אינו מוחלף ואינו מוצג; זו אותה עובדה משני צדדים.
   */
  async function activate(input, summary) {
    const { sid, month } = scope(input && input.station_id, input && input.month);
    const id = String(input.generation_id || '');
    const at = now();
    return db.runTransaction(async tx => {
      const [generationSnap, monthSnap] = await Promise.all([
        tx.get(generationRef(sid, month, id)), tx.get(monthRef(sid, month))]);
      const generation = generationSnap.exists ? generationSnap.data() : null;
      if (!plain(generation) || generation.schema !== SCHEMA_GENERATION
        || generation.station_id !== sid || generation.month !== month) throw error('not-found', 'Generation not found.');
      if (generation.state !== 'complete' && generation.state !== 'ready') {
        throw error('failed-precondition', 'A partial generation is never published.');
      }
      const current = monthSnap.exists ? monthSnap.data() : null;
      if (current !== null && !plain(current)) throw error('failed-precondition', 'Month data is invalid.');
      if (plain(current) && current.active_generation === id) {
        return { activated: false, generation_id: id, reason: 'already_active' };
      }
      if (typeof hooks.beforeActivate === 'function') await hooks.beforeActivate();
      tx.set(generationRef(sid, month, id), { state: 'ready' }, { merge: true });
      tx.set(monthRef(sid, month), { schema: SCHEMA_MONTH, station_id: sid, month,
        status: 'ready', active_generation: id, generated_at_ms: at,
        rows: Number.isSafeInteger(generation.rows) ? generation.rows : 0,
        ...summary }, { merge: true });
      return { activated: true, generation_id: id };
    });
  }

  /**
   * בונה דור שלם ומפעיל אותו. תקציב זמן: מה שלא הסתיים נשאר דור
   * פתוח עם סמן, וההרצה הבאה עם אותה כוונה ממשיכה ממנו בדיוק.
   */
  async function build(input) {
    const { sid, month } = scope(input && input.station_id, input && input.month);
    const budget = Number.isSafeInteger(input.budget_ms) && input.budget_ms > 0 ? input.budget_ms : 240000;
    const deadline = now() + budget;
    const begun = await beginGeneration({ station_id: sid, month, intent_id: input.intent_id });
    /* ⭐ אם הדור הזה כבר הפעיל — אין מה לבנות ואין מה לקרוא.
     * זו הנקודה שהופכת הרצה חוזרת לזולה באמת, ולא רק
     * לבלתי-מזיקה: בלעדיה כל הרצה היתה קוראת מחדש את כל
     * היעדרויות של החודש כדי לגלות שאין מה לעשות. */
    if (!begun.created) {
      const existing = await monthRef(sid, month).get();
      const current = existing.exists ? existing.data() : null;
      if (plain(current) && current.active_generation === begun.generation_id) {
        return { generation_id: begun.generation_id, complete: true, activated: false,
          slices: 0, written: 0, reason: 'already_active',
          coverage: current.coverage === 'complete' ? 'complete' : 'legacy_pending',
          source_digest: typeof current.source_digest === 'string' ? current.source_digest : null,
          hour_limit: Number.isFinite(current.hour_limit) ? current.hour_limit : null };
      }
    }
    const [limit, coverage, absences, longAbsences] = await Promise.all([
      hourLimit(sid), coverageOf(sid), absenceIndex(sid, month), longAbsenceIndex(sid, month)]);
    const context = { month, limit, absences, longAbsences };
    let slices = 0, written = 0, done = false;
    while (!done) {
      if (now() >= deadline) {
        return { generation_id: begun.generation_id, complete: false, activated: false,
          slices, written, reason: 'budget_exhausted' };
      }
      const slice = await runSlice({ station_id: sid, month, generation_id: begun.generation_id }, context);
      slices += 1; written += slice.written; done = slice.done;
    }
    /* ⭐ הטביעה היא מה שהדוח נבנה ממנו, ולא מה שיצא ממנו: סף השעות,
     * כיסוי הסיווג, ומספר המסמכים בשני המקורות. שינוי הכרעה מייצר
     * טביעה אחרת, ולכן אפשר לראות שהדוח אינו זהה — בלי להשוות שורות. */
    const digest = hash([SCHEMA_MONTH, sid, month, limit, coverage,
      absences.seen, absences.malformed, longAbsences.seen,
      absenceFingerprint(absences), longAbsenceFingerprint(longAbsences)]);
    const activated = await activate({ station_id: sid, month, generation_id: begun.generation_id }, {
      source_digest: digest, hour_limit: limit, coverage,
      sources: { hr_requests: absences.seen, hr_requests_malformed: absences.malformed,
        hr_workforce_cases: longAbsences.seen, monthly_reports: 'per_employee' },
      // אין ספק דואר מאומת במסלול הזה, ולכן הדוח אינו נשלח לאיש.
      delivery: 'in_app_only'
    });
    return { generation_id: begun.generation_id, complete: true, activated: activated.activated,
      slices, written, coverage, source_digest: digest, hour_limit: limit };
  }

  /** קריאה מעומדת מהדור הפעיל בלבד. דור שאינו פעיל אינו נקרא. */
  async function read(input) {
    const { sid, month } = scope(input && input.station_id, input && input.month);
    const cursor = input && own(input, 'cursor') ? String(input.cursor) : null;
    const monthSnap = await monthRef(sid, month).get();
    const value = monthSnap.exists ? monthSnap.data() : null;
    if (!plain(value) || value.schema !== SCHEMA_MONTH || value.station_id !== sid
      || typeof value.active_generation !== 'string' || !value.active_generation) {
      return { month, state: 'not_built', rows: [], next_cursor: null };
    }
    let query = generationRef(sid, month, value.active_generation)
      .collection('hr_monthly_rows').orderBy('__name__').limit(READ_PAGE + 1);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    const docs = page.docs.slice(0, READ_PAGE);
    const rows = docs.map(snap => {
      const row = snap.data();
      if (!plain(row) || row.schema !== SCHEMA_ROW || row.month !== month) {
        throw error('failed-precondition', 'Report row data is invalid.');
      }
      const { schema, ...rest } = row;
      return rest;
    });
    return { month, state: 'ready', generated_at_ms: value.generated_at_ms || null,
      generation_id: value.active_generation,
      hour_limit: Number.isFinite(value.hour_limit) ? value.hour_limit : null,
      coverage: value.coverage === 'complete' ? 'complete' : 'legacy_pending',
      source_digest: typeof value.source_digest === 'string' ? value.source_digest : null,
      sources: plain(value.sources) ? value.sources : null,
      total_rows: Number.isSafeInteger(value.rows) ? value.rows : null,
      delivery: value.delivery === 'in_app_only' ? 'in_app_only' : null,
      rows, next_cursor: page.docs.length > READ_PAGE ? docs[docs.length - 1].id : null };
  }

  /**
   * שלושת המצבים של חריגת השעות.
   *
   * ⭐ „אין דוח" אינו „אין חורגים", והשניים אינם מוחזרים כאותה תשובה
   * לעולם. זו בדיוק התקלה שהייתה קודם: פאנל ריק נקרא כאילו אף אחד
   * אינו חורג, כשבפועל לא היה לו מקור בכלל.
   */
  async function overHours(input) {
    const sid = input && input.station_id;
    if (typeof sid !== 'string' || !STATION.test(sid)) throw error('invalid-argument', 'Invalid station.');
    const month = typeof input.month === 'string' && MONTH.test(input.month) ? input.month : null;
    if (!month) throw error('invalid-argument', 'Invalid month.');
    const monthSnap = await monthRef(sid, month).get();
    const value = monthSnap.exists ? monthSnap.data() : null;
    if (!plain(value) || value.schema !== SCHEMA_MONTH
      || typeof value.active_generation !== 'string' || !value.active_generation) {
      return { state: 'not_built', month, hour_limit: null, coverage: null, over_employees: [] };
    }
    const limit = Number.isFinite(value.hour_limit) ? value.hour_limit : null;
    const over = [];
    let cursor = null;
    for (;;) {
      let query = generationRef(sid, month, value.active_generation)
        .collection('hr_monthly_rows').orderBy('__name__').limit(USER_PAGE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const snap of page.docs) {
        const row = snap.data();
        if (!plain(row) || row.over_hour_limit !== true) continue;
        if (over.length >= 200) break;
        over.push({ employee_number: text(row.employee_number, 64),
          full_name: text(row.full_name, ROW_STRING), crew: text(row.crew, 40),
          total_hours: Number.isFinite(row.total_hours) ? row.total_hours : 0 });
      }
      if (over.length >= 200 || page.docs.length < USER_PAGE) break;
      cursor = page.docs[page.docs.length - 1].id;
    }
    return { state: over.length ? 'over' : 'clear', month, hour_limit: limit,
      coverage: value.coverage === 'complete' ? 'complete' : 'legacy_pending',
      generated_at_ms: value.generated_at_ms || null, over_employees: over };
  }

  return Object.freeze({ beginGeneration, runSlice, activate, build, read, overHours,
    hourLimit, coverageOf, absenceIndex, longAbsenceIndex });
}

module.exports = Object.freeze({ createHrMonthlySummary, daysInMonth, monthBounds,
  SCHEMA_MONTH, SCHEMA_GENERATION, SCHEMA_ROW, SCHEMA_BACKFILL, BACKFILL_DOC,
  USER_PAGE, READ_PAGE, ABSENCE_CAP, WORKFORCE_CAP, DEFAULT_HOUR_LIMIT, ABSENCE_KINDS });
