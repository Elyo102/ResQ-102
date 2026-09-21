'use strict';

/* ======================================================================
 *  hr-months-backfill — סיווג דיווחי היעדרות שנפתחו לפני שהשדה קיים
 *
 *  ----------------------------------------------------------------
 *  למה הכלי הזה קיים בכלל
 *  ----------------------------------------------------------------
 *  הדוח החודשי מוצא היעדרויות דרך `months array-contains`. דיווח
 *  שנפתח לפני שהשדה קיים **אינו נמצא בשאילתה הזו** — לא כי הוא לא
 *  רלוונטי, אלא כי אין לו את המפתח. בלי הסיווג הזה הדוח מדויק על מה
 *  שהוא רואה ועיוור למה שהוא לא, וזו בדיוק הצורה של דוח שקרן.
 *
 *  לכן הדוח נושא `coverage`, וה-`coverage` הופך ל-`complete` רק אחרי
 *  שהכלי הזה סיים **ולא נשאר דיווח שאי אפשר לסווג**. אין כאן מסלול
 *  שבו „נראה מלא" קודם ל„הוא מלא".
 *
 *  ----------------------------------------------------------------
 *  ⭐ dry-run הוא ברירת המחדל, ולא דגל שאפשר לשכוח
 *  ----------------------------------------------------------------
 *  `dry_run` אינו פרמטר שאם לא נשלח אז כותבים. הוא ברירת המחדל:
 *  קריאה בלי `dry_run: false` **סופרת ואינה כותבת דבר**. מיגרציה
 *  שרצה בטעות על ייצור היא נזק שאין לו „בטל", וברירת מחדל שכותבת
 *  היא בדיוק איך זה קורה.
 *
 *  ⭐ **הכלי הזה לא הורץ על ייצור, ולא על שום פרויקט Firebase.**
 *  הוא נמסר עם בדיקות שרצות מול כפיל בזיכרון. מי שמריץ אותו על
 *  `station-102` עושה פעולת ייצור שדורשת אישור נפרד ומפורש, עם
 *  הפקודה, המטרה, תוצאות האימות, הסיכון ותוכנית החזרה — בדיוק כפי
 *  ש-`AGENTS.md` דורש.
 *
 *  ----------------------------------------------------------------
 *  מה מסווג, ומה במפורש לא
 *  ----------------------------------------------------------------
 *  - דיווח עם סוג מתוארך וטווח תקין → `months` נגזר מהטווח באותה
 *    פונקציה בדיוק שהשירות משתמש בה. לא גזירה שנייה, לא „דומה".
 *  - דיווח שהטווח שלו חורג מהתקרה המוצהרת → **אינו מסווג**, נספר
 *    כ-`unclassifiable`, ונשאר כפי שהוא. היעדרות כזו שייכת ל-
 *    `hr_workforce_cases`, וזו הכרעת מוצר ולא באג להסתיר.
 *  - פנייה כללית → אין לה חודשים, ואינה נגועה.
 *  - דיווח שכבר מסווג נכון → מדלגים. הרצה חוזרת אינה משנה דבר.
 *  - דיווח שמסווג **לא** נכון → נספר כ-`conflicting` ולא נדרס.
 *    `caseData` כבר דוחה אותו בקריאה; לדרוס אותו כאן היה להסתיר
 *    נתון פגום במקום להראות אותו.
 *
 *  ----------------------------------------------------------------
 *  מה זה אינו
 *  ----------------------------------------------------------------
 *  - אינו מוסיף ואינו משנה `revision` או `updated_at_ms`. הסיווג
 *    אינו פעולה על הפנייה: הוא מפתח נגזר לאותו נתון בדיוק, ופנייה
 *    שגרסתה זזה בגללו הייתה מפילה כל CAS פתוח במסך.
 *  - אינו כותב שורת יומן בתת-אוסף `events`. המסך אוכף אוצר סגור של
 *    סוגי אירוע, ושורה מסוג חדש הייתה פוסלת את כל הפנייה בקריאה.
 *    הביקורת יושבת בקבלה, עם מי הריץ, מתי, ומה נספר.
 *  - אינו מוחק ואינו מאחד דיווחים.
 * ====================================================================== */

const requests = require('./hr-requests');

const SCHEMA = 'hr-months-backfill-v1';
const RECEIPT_DOC = 'hr-months-backfill-v1';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const AUDIT_RUNS = 20;
const STATION = /^[a-z0-9_-]{2,80}$/;

const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const sameMonths = (value, from, to) => {
  const expected = requests.absenceMonths(from, to);
  return !!expected && Array.isArray(value) && value.length === expected.length
    && value.every((v, i) => v === expected[i]);
};

function createHrMonthsBackfill({ db, HttpsError, clock = Date.now }) {
  if (!db || typeof db.collection !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db and HttpsError are required');
  }
  const error = (code, message) => new HttpsError(code, message);
  const root = sid => db.collection('stations').doc(sid);
  const receiptRef = sid => root(sid).collection('hr_request_counters').doc(RECEIPT_DOC);

  /**
   * עמוד אחד של סיווג.
   *
   * `dry_run` ברירת מחדל `true`. `cursor` הוא מזהה המסמך האחרון
   * שנבדק, כדי שהריצה תהיה מעומדת ולא סריקה אחת ענקית.
   */
  async function run(input) {
    const sid = input && input.station_id;
    if (typeof sid !== 'string' || !STATION.test(sid)) throw error('invalid-argument', 'Invalid station.');
    const dryRun = !(input && input.dry_run === false);
    const actor = typeof input.actor_uid === 'string' && input.actor_uid ? input.actor_uid.slice(0, 128) : null;
    if (!actor) throw error('invalid-argument', 'An actor is required for the audit receipt.');
    const limit = Number.isSafeInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const cursor = typeof input.cursor === 'string' && input.cursor ? input.cursor : null;

    let query = root(sid).collection('hr_requests').orderBy('__name__').limit(limit);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    const docs = page.docs;
    const counts = { scanned: docs.length, already: 0, classified: 0, unclassifiable: 0,
      conflicting: 0, untouched: 0, malformed: 0 };
    const writes = [];
    for (const snap of docs) {
      const value = snap.data();
      if (!plain(value) || value.schema !== 'hr-request-v1' || value.station_id !== sid) { counts.malformed += 1; continue; }
      const kind = own(value, 'kind') ? value.kind : 'general';
      if (!requests.DATED_KINDS.includes(kind)) { counts.untouched += 1; continue; }
      const months = requests.absenceMonths(value.from_date, value.to_date);
      if (own(value, 'months')) {
        if (sameMonths(value.months, value.from_date, value.to_date)) counts.already += 1;
        else counts.conflicting += 1;
        continue;
      }
      if (!months) { counts.unclassifiable += 1; continue; }
      writes.push([snap.id, months]);
    }
    if (!dryRun) {
      for (const [id, months] of writes) {
        /* עסקה לכל מסמך, שקוראת מחדש ובודקת שהשדה עדיין חסר ושהטווח
         * לא זז. הרצה חוזרת על אותו מסמך אינה כותבת שוב, וזו
         * ה-idempotency — לא הבטחה עליה. */
        await db.runTransaction(async tx => {
          const ref = root(sid).collection('hr_requests').doc(id);
          const fresh = await tx.get(ref);
          if (!fresh.exists) return;
          const value = fresh.data();
          if (!plain(value) || value.station_id !== sid || own(value, 'months')) return;
          if (!sameMonths(months, value.from_date, value.to_date)) return;
          // רק השדה. לא `revision`, לא `updated_at_ms`, לא שורת יומן.
          tx.set(ref, { months }, { merge: true });
        });
      }
      counts.classified = writes.length;
    } else {
      counts.classified = 0;
      counts.would_classify = writes.length;
    }

    const done = docs.length < limit;
    const next = done ? null : docs[docs.length - 1].id;
    const at = clock();
    /* הקבלה היא הביקורת וגם השער: `coverage` בדוח החודשי הופך
     * ל-`complete` רק כשהיא אומרת שהסריקה הסתיימה ושלא נשאר דיווח
     * שאי אפשר לסווג. */
    await db.runTransaction(async tx => {
      const snap = await tx.get(receiptRef(sid));
      const prior = snap.exists ? snap.data() : null;
      const base = plain(prior) && prior.schema === SCHEMA ? prior : null;
      const totals = base && plain(base.totals) ? { ...base.totals } : {};
      for (const key of Object.keys(counts)) {
        if (dryRun) continue; // ריצת יובש אינה מזיזה סכומים.
        totals[key] = (Number.isSafeInteger(totals[key]) ? totals[key] : 0) + counts[key];
      }
      const runs = (base && Array.isArray(base.runs) ? base.runs : [])
        .concat([{ at_ms: at, actor_uid: actor, dry_run: dryRun, cursor: cursor || null,
          next_cursor: next, ...counts }]).slice(-AUDIT_RUNS);
      const completed = !dryRun && done
        && (totals.unclassifiable || 0) === 0 && (totals.conflicting || 0) === 0;
      tx.set(receiptRef(sid), { schema: SCHEMA, station_id: sid, updated_at_ms: at,
        runs, totals,
        ...(completed ? { completed_at_ms: at } : {}),
        ...(base && Number.isSafeInteger(base.completed_at_ms) && !completed
          ? { completed_at_ms: base.completed_at_ms } : {}) }, { merge: false });
    });
    return { station_id: sid, dry_run: dryRun, done, next_cursor: next, ...counts };
  }

  async function status(input) {
    const sid = input && input.station_id;
    if (typeof sid !== 'string' || !STATION.test(sid)) throw error('invalid-argument', 'Invalid station.');
    const snap = await receiptRef(sid).get();
    const value = snap.exists ? snap.data() : null;
    if (!plain(value) || value.schema !== SCHEMA) {
      return { station_id: sid, state: 'never_run', totals: null, runs: [], completed_at_ms: null };
    }
    return { station_id: sid,
      state: Number.isSafeInteger(value.completed_at_ms) && value.completed_at_ms > 0 ? 'complete' : 'in_progress',
      totals: plain(value.totals) ? value.totals : null,
      runs: Array.isArray(value.runs) ? value.runs.slice(-AUDIT_RUNS) : [],
      completed_at_ms: Number.isSafeInteger(value.completed_at_ms) ? value.completed_at_ms : null };
  }

  return Object.freeze({ run, status });
}

module.exports = Object.freeze({ createHrMonthsBackfill, SCHEMA, RECEIPT_DOC,
  DEFAULT_LIMIT, MAX_LIMIT, AUDIT_RUNS });
