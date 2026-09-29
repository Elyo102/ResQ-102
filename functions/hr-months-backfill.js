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
 *  קריאה בלי `dry_run: false` סופרת בלי לשנות דיווחים; היא כן שומרת קבלת ביקורת. מיגרציה
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
const { randomUUID } = require('node:crypto');

const SCHEMA = 'hr-months-backfill-v1';
const RECEIPT_DOC = 'hr-months-backfill-v1';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const AUDIT_RUNS = 20;
const STATION = /^[a-z0-9_-]{2,80}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COUNT_KEYS = ['scanned', 'already', 'classified', 'unclassifiable', 'conflicting', 'untouched', 'malformed', 'deleted'];

const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const sameMonths = (value, from, to) => {
  const expected = requests.absenceMonths(from, to);
  return !!expected && Array.isArray(value) && value.length === expected.length
    && value.every((v, i) => v === expected[i]);
};
function validTotals(value) {
  return plain(value) && Object.keys(value).length === COUNT_KEYS.length
    && COUNT_KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && COUNT_KEYS.slice(1).reduce((sum, key) => sum + value[key], 0) === value.scanned;
}
function completedReceipt(value, sid) {
  // Evidence for the finite observed scan only, not a global concurrent-write barrier.
  // Deleted rows were observed absent in their transaction and are not unresolved.
  return plain(value) && value.schema === SCHEMA && value.station_id === sid
    && value.scan_phase === 'complete' && value.next_cursor === null
    && typeof value.scan_id === 'string' && UUID.test(value.scan_id)
    && typeof value.page_token === 'string' && UUID.test(value.page_token)
    && Number.isSafeInteger(value.scan_revision) && value.scan_revision > 0
    && Number.isSafeInteger(value.completed_at_ms) && value.completed_at_ms > 0
    && validTotals(value.totals) && value.totals.unclassifiable === 0
    && value.totals.conflicting === 0 && value.totals.malformed === 0;
}

function createHrMonthsBackfill({ db, HttpsError, clock = Date.now, authorize, trustedMaintenance = false }) {
  if (!db || typeof db.collection !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db and HttpsError are required');
  }
  const error = (code, message) => new HttpsError(code, message);
  async function authority(tx, sid) {
    if (typeof authorize === 'function') return authorize(tx, sid);
    if (trustedMaintenance !== true) throw error('permission-denied', 'Explicit backfill authority required.');
  }
  const root = sid => db.collection('stations').doc(sid);
  const receiptRef = sid => root(sid).collection('hr_request_counters').doc(RECEIPT_DOC);
  const version = snap => !snap.exists ? 'absent' : snap.updateTime
    ? `${snap.updateTime.seconds}:${snap.updateTime.nanoseconds}` : JSON.stringify(snap.data());
  function receiptData(snap) {
    if (!snap.exists) return null;
    const value = snap.data();
    if (!plain(value) || value.schema !== SCHEMA || (own(value, 'scan_revision')
      && (!Number.isSafeInteger(value.scan_revision) || value.scan_revision < 0))) {
      throw error('failed-precondition', 'Invalid backfill receipt.');
    }
    return value;
  }
  function revision(value) {
    const next = (value && value.scan_revision || 0) + 1;
    if (!Number.isSafeInteger(next)) throw error('failed-precondition', 'Receipt revision exhausted.');
    return next;
  }
  function outcome(value, sid) {
    if (!plain(value) || value.schema !== 'hr-request-v1' || value.station_id !== sid) return { kind: 'malformed' };
    const kind = own(value, 'kind') ? value.kind : 'general';
    if (!requests.DATED_KINDS.includes(kind)) return { kind: kind === 'general' ? 'untouched' : 'malformed' };
    const months = requests.absenceMonths(value.from_date, value.to_date);
    if (own(value, 'months')) return { kind: sameMonths(value.months, value.from_date, value.to_date) ? 'already' : 'conflicting' };
    return months ? { kind: 'classified', months } : { kind: 'unclassifiable' };
  }

  /**
   * עמוד אחד של סיווג.
   *
   * `dry_run` ברירת מחדל `true`. `cursor` הוא מזהה המסמך האחרון
   * שנבדק, כדי שהריצה תהיה מעומדת ולא סריקה אחת ענקית.
   */
  async function run(input) {
    const sid = input && input.station_id;
    if (typeof sid !== 'string' || !STATION.test(sid)) throw error('invalid-argument', 'Invalid station.');
    await db.runTransaction(tx => authority(tx, sid));
    const dryRun = !(input && input.dry_run === false);
    const actor = typeof input.actor_uid === 'string' && input.actor_uid ? input.actor_uid.slice(0, 128) : null;
    if (!actor) throw error('invalid-argument', 'An actor is required for the audit receipt.');
    const limit = Number.isSafeInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MAX_LIMIT) : DEFAULT_LIMIT;
    const cursor = typeof input.cursor === 'string' && input.cursor ? input.cursor : null;

    const ref = receiptRef(sid);
    // Capture before query; begin CAS cannot silently adopt another page's state.
    const observed = await ref.get();
    const pageToken = randomUUID(); // Stable across Firestore transaction retries.
    if (!dryRun) await db.runTransaction(async tx => {
      await authority(tx, sid);
      const fresh = await tx.get(ref), prior = receiptData(fresh);
      if (version(fresh) !== version(observed)) throw error('aborted', 'Backfill scan changed.');
      if (cursor && (!prior || prior.scan_phase !== 'ready' || prior.next_cursor !== cursor
          || typeof prior.scan_id !== 'string' || !UUID.test(prior.scan_id) || !validTotals(prior.totals))) {
        throw error('failed-precondition', 'Restart the scan from the beginning.');
      }
      if (prior && prior.station_id !== sid) throw error('failed-precondition', 'Receipt station mismatch.');
      const next = { ...(prior || {}), schema: SCHEMA, station_id: sid,
        scan_revision: revision(prior), scan_id: cursor ? prior.scan_id : pageToken,
        page_token: pageToken, scan_phase: 'processing', next_cursor: cursor,
        totals: cursor ? prior.totals : {}, runs: prior && Array.isArray(prior.runs) ? prior.runs.slice(-AUDIT_RUNS) : [], updated_at_ms: clock() };
      delete next.completed_at_ms;
      tx.set(ref, next);
    });
    function requirePage(value) {
      if (!value || value.schema !== SCHEMA || value.station_id !== sid
          || value.page_token !== pageToken || value.scan_phase !== 'processing') {
        throw error('aborted', 'Backfill page was superseded.');
      }
    }
    let query = root(sid).collection('hr_requests').orderBy('__name__').limit(limit);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    const docs = page.docs;
    const counts = { scanned: docs.length, already: 0, classified: 0, unclassifiable: 0,
      conflicting: 0, untouched: 0, malformed: 0, deleted: 0 };
    if (dryRun) counts.would_classify = 0;
    for (const snap of docs) {
      if (dryRun) {
        const result = outcome(snap.data(), sid);
        counts[result.kind === 'classified' ? 'would_classify' : result.kind]++;
      } else {
        const result = await db.runTransaction(async tx => {
          await authority(tx, sid);
          const currentReceipt = await tx.get(ref); requirePage(receiptData(currentReceipt));
          const sourceRef = root(sid).collection('hr_requests').doc(snap.id);
          const fresh = await tx.get(sourceRef);
          if (!fresh.exists) return { kind: 'deleted' };
          const current = outcome(fresh.data(), sid);
          if (current.kind === 'classified') tx.set(sourceRef, { months: current.months }, { merge: true });
          return current;
        });
        counts[result.kind]++;
      }
    }

    const done = docs.length < limit;
    const next = done ? null : docs[docs.length - 1].id;
    const at = clock();
    /* הקבלה היא הביקורת וגם השער: `coverage` בדוח החודשי הופך
     * ל-`complete` רק כשהיא אומרת שהסריקה הסתיימה ושלא נשאר דיווח
     * שאי אפשר לסווג. */
    await db.runTransaction(async tx => {
      await authority(tx, sid);
      const snap = await tx.get(ref);
      const base = receiptData(snap);
      if (base && base.station_id !== sid) throw error('failed-precondition', 'Receipt station mismatch.');
      if (!dryRun) requirePage(base);
      const totals = base && plain(base.totals) ? { ...base.totals } : {};
      for (const key of Object.keys(counts)) {
        if (dryRun) continue; // ריצת יובש אינה מזיזה סכומים.
        totals[key] = (Number.isSafeInteger(totals[key]) ? totals[key] : 0) + counts[key];
      }
      if (!dryRun && !validTotals(totals)) throw error('failed-precondition', 'Invalid scan totals.');
      const runs = (base && Array.isArray(base.runs) ? base.runs : [])
        .concat([{ at_ms: at, actor_uid: actor, dry_run: dryRun, cursor: cursor || null,
          next_cursor: next, ...counts }]).slice(-AUDIT_RUNS);
      const completed = !dryRun && done
        && (totals.unclassifiable || 0) === 0 && (totals.conflicting || 0) === 0
        && (totals.malformed || 0) === 0;
      const nextReceipt = { ...(base || {}), schema: SCHEMA, station_id: sid, updated_at_ms: at,
        scan_revision: revision(base),
        runs, totals,
        ...(!dryRun ? { scan_phase: done ? 'complete' : 'ready', next_cursor: next } : {}) };
      if (!dryRun) {
        delete nextReceipt.completed_at_ms;
        if (completed) nextReceipt.completed_at_ms = at;
      }
      tx.set(ref, nextReceipt, { merge: false });
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
      state: completedReceipt(value, sid) ? 'complete' : 'in_progress',
      totals: plain(value.totals) ? value.totals : null,
      runs: Array.isArray(value.runs) ? value.runs.slice(-AUDIT_RUNS) : [],
      completed_at_ms: completedReceipt(value, sid) ? value.completed_at_ms : null };
  }

  return Object.freeze({ run, status });
}

module.exports = Object.freeze({ createHrMonthsBackfill, completedReceipt, SCHEMA, RECEIPT_DOC,
  DEFAULT_LIMIT, MAX_LIMIT, AUDIT_RUNS });
