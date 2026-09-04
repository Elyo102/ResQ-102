'use strict';

/* ======================================================================
 * חוות דעת של משתמשים.
 *
 * ⭐ בניגוד ליומן התקלות, כאן **יש** זהות — הכרעת אלדד (3.9.2026):
 * כל חוות דעת נשמרת עם ה-uid, התפקיד ומספר העובד של הכותב, כדי שאפשר
 * יהיה לחזור אליו. ולכן גם הכללים: הלקוח כותב דרך הפעולה הזאת בלבד,
 * לעולם לא קורא; הקריאה היא לסקריפט הייצוא עם admin SDK, והקובץ
 * שנוצר ממנה מסומן כמידע אישי ואינו נכנס לגיט.
 *
 * הטקסט הוא טקסט חופשי של אדם. הוא לא עובר הסרת מידע אישי — הסרה
 * הייתה מעוותת מה שהאדם ניסה לומר. גוף ארוך מדי נדחה ואינו נחתך.
 *
 * המודול אינו יודע Firebase Admin. תחנה מהטוקן ולא מהלקוח; החברות
 * והתפקיד נקראים מחדש מתוך כרטיס התחנה החי באותה עסקה, גם בחזרה על בקשה.
 * ====================================================================== */

const CATEGORIES = Object.freeze(['works', 'problem', 'idea', 'other']);
const RATINGS = Object.freeze([1, 2, 3, 4, 5]);
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');

const LIMITS = Object.freeze({
  text: 1000,
  textMin: 3,
  screen: 64,
  version: 24,
  requestId: 120,
  perUserPerDay: 20
});

const QUOTA_TTL_MS = 3 * 24 * 60 * 60 * 1000;
// Eldad's retention decision, 4 September 2026: 30 days from creation.
const FEEDBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCREEN_RE = /^[a-z0-9-]{1,48}\.html$/;
const VERSION_RE = /^[A-Za-z0-9.\-]{1,24}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_INPUT = Object.freeze([
  'request_id', 'screen', 'version', 'category', 'rating', 'text', 'allow_contact'
]);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const out = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return out.length > max ? out.slice(0, max) : out;
}

function createFeedback(deps) {
  const d = plain(deps) ? deps : {};
  const db = d.db;
  const FieldValue = d.FieldValue;
  const HttpsError = d.HttpsError;
  const hash = d.hash;
  const clock = d.clock;

  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('db with collection and runTransaction is required');
  }
  if (!FieldValue || typeof FieldValue.serverTimestamp !== 'function'
      || typeof FieldValue.increment !== 'function') {
    throw new TypeError('FieldValue.serverTimestamp/increment are required');
  }
  if (typeof HttpsError !== 'function') throw new TypeError('HttpsError is required');
  if (typeof hash !== 'function') throw new TypeError('hash is required');
  if (typeof clock !== 'function') throw new TypeError('clock is required');
  const identity = createOpsMemberIdentity({ db, HttpsError });

  function fail(code, message) {
    return new HttpsError(code, message);
  }
  function stationRef(sid) {
    return db.collection('stations').doc(sid);
  }
  function feedbackRef(sid, id) {
    return stationRef(sid).collection('feedback').doc(id);
  }
  function quotaRef(sid, uid, day) {
    return stationRef(sid).collection('feedback_quota').doc(uid + '_' + day);
  }

  function dataOf(req) {
    const data = req && req.data === undefined ? {} : (req && req.data);
    if (!plain(data)) throw fail('invalid-argument', 'נתוני הבקשה אינם תקינים.');
    if (Object.keys(data).some((key) => ALLOWED_INPUT.indexOf(key) === -1)) {
      throw fail('invalid-argument', 'חוות הדעת אינה מקבלת תחנה או שדות נוספים.');
    }
    return data;
  }

  function planFeedback(data) {
    // The stored content and replay fingerprint must describe the same intent;
    // silently truncating an oversized body would discard part of that intent.
    for (const [key, maximum] of [['request_id', LIMITS.requestId], ['screen', LIMITS.screen],
      ['version', LIMITS.version], ['text', LIMITS.text]]) {
      if (typeof data[key] !== 'string' || data[key].trim().length > maximum) {
        throw fail('invalid-argument', 'שדה חוות הדעת אינו תקין או ארוך מדי.');
      }
    }
    const requestId = cleanText(data.request_id, LIMITS.requestId);
    if (requestId === null || !REQUEST_ID_RE.test(requestId)) {
      throw fail('invalid-argument', 'מזהה הבקשה אינו תקין.');
    }
    const screen = cleanText(data.screen, LIMITS.screen);
    if (screen === null || !SCREEN_RE.test(screen)) throw fail('invalid-argument', 'שם המסך אינו תקין.');
    const version = cleanText(data.version, LIMITS.version);
    if (version === null || !VERSION_RE.test(version)) {
      throw fail('invalid-argument', 'גרסת האפליקציה אינה תקינה.');
    }
    const category = String(data.category || '');
    if (CATEGORIES.indexOf(category) === -1) throw fail('invalid-argument', 'הקטגוריה אינה מוכרת.');

    let rating = null;
    if (data.rating !== undefined && data.rating !== null && data.rating !== '') {
      rating = data.rating;
      if (RATINGS.indexOf(rating) === -1) throw fail('invalid-argument', 'הדירוג חייב להיות 1 עד 5.');
    }
    const body = cleanText(data.text, LIMITS.text);
    if (body === null || body.length < LIMITS.textMin) {
      throw fail('invalid-argument', 'חוות הדעת קצרה מדי.');
    }
    if (data.allow_contact !== undefined && typeof data.allow_contact !== 'boolean') {
      throw fail('invalid-argument', '„מותר לפנות אליי" חייב להיות כן או לא.');
    }
    return Object.freeze({
      requestId, screen, version, category, rating, text: body,
      allowContact: data.allow_contact === true
    });
  }

  async function submit(req) {
    const ctx = identity.context(req);
    const { uid, sid } = ctx;
    const plan = planFeedback(dataOf(req));
    const intent = String(hash(JSON.stringify([
      'feedback-v2', sid, uid, plan.screen, plan.version, plan.category,
      plan.rating, plan.text, plan.allowContact
    ])));
    if (!/^[a-f0-9]{64}$/.test(intent)) throw fail('internal', 'טביעת הבקשה אינה תקינה.');

    const nowIso = clock();
    const now = new Date(nowIso).getTime();
    const day = String(nowIso).slice(0, 10);
    if (!Number.isFinite(now) || !DAY_RE.test(day)) throw fail('internal', 'השעון אינו תקין.');

    /* מזהה נגזר: אותה בקשה פעמיים (רשת נפלה אחרי שהשרת כתב) היא
     * חוות דעת אחת. */
    const id = 'f_' + String(hash(JSON.stringify(['feedback-v2', sid, uid, plan.requestId]))).slice(0, 40);
    if (!/^f_[a-f0-9]{40}$/.test(id)) throw fail('internal', 'מזהה הבקשה אינו תקין.');
    const ref = feedbackRef(sid, id);
    const qRef = quotaRef(sid, uid, day);

    return db.runTransaction(async (tx) => {
      const actor = await identity.requireLive(tx, ctx);
      const [snap, qSnap] = await Promise.all([tx.get(ref), tx.get(qRef)]);
      if (snap.exists) {
        const previous = snap.data() || {};
        if (previous.intent_hash !== intent || previous.uid !== uid || previous.station_id !== sid) {
          throw fail('already-exists', 'מזהה הבקשה כבר שימש לתוכן אחר.');
        }
        return { duplicate: true, id };
      }
      const used = qSnap.exists ? (qSnap.data() || {}).count : 0;
      if (!Number.isSafeInteger(used) || used < 0) throw fail('failed-precondition', 'מכסת חוות הדעת אינה תקינה.');
      if (used >= LIMITS.perUserPerDay) {
        throw fail('resource-exhausted', 'הגעת למכסת חוות הדעת להיום. תודה — נקרא את מה שכבר שלחת.');
      }
      tx.set(qRef, {
        uid, day, count: used + 1, expires_at: new Date(now + QUOTA_TTL_MS)
      }, { merge: true });
      tx.set(ref, {
        station_id: sid,
        id,
        uid,
        role: actor.role,
        employee_number: actor.employee_number,
        schema_version: 2,
        intent_hash: intent,
        screen: plan.screen,
        version: plan.version,
        category: plan.category,
        rating: plan.rating,
        text: plan.text,
        allow_contact: plan.allowContact,
        status: 'new',
        created_at: FieldValue.serverTimestamp(),
        created_at_iso: nowIso,
        expires_at: new Date(now + FEEDBACK_TTL_MS),
        read_at: null,
        read_by: null
      });
      return { duplicate: false, id };
    });
  }

  /* --- לצד המנהל (סקריפט הייצוא) --------------------------------- */
  async function list(options) {
    const o = plain(options) ? options : {};
    const sid = String(o.sid || '');
    if (!access.validId(sid)) throw new TypeError('sid is required');
    const limit = o.limit === undefined ? 500 : o.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('invalid limit');
    const since = o.since ? String(o.since) : '';
    if (since && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(since)) throw new TypeError('invalid since');
    let query = stationRef(sid).collection('feedback').orderBy('created_at_iso', 'desc');
    if (since) query = query.where('created_at_iso', '>=', since);
    const snap = await query.limit(limit).get();
    const rows = [];
    for (const docSnap of snap.docs) {
      const data = docSnap.data() || {};
      if (since && String(data.created_at_iso || '') < since) continue;
      rows.push(Object.assign({ id: docSnap.id }, data));
    }
    rows.sort((a, b) => String(b.created_at_iso || '').localeCompare(String(a.created_at_iso || '')));
    return rows.slice(0, limit);
  }

  async function markRead(options) {
    const o = plain(options) ? options : {};
    const sid = String(o.sid || '');
    const ids = Array.isArray(o.ids) ? o.ids.map(String) : [];
    const by = typeof o.by === 'string' ? o.by : '';
    if (!access.validId(sid)) throw new TypeError('sid is required');
    if (ids.length > 500) throw new TypeError('too many ids');
    if (!by || !/^[a-z]{2,40}$/.test(by)) throw new TypeError('by must be a label, not an identity');
    let marked = 0;
    for (const id of ids) {
      if (!/^f_[a-f0-9]{40}$/.test(id)) continue;
      const changed = await db.runTransaction(async (tx) => {
        const ref = feedbackRef(sid, id);
        const snap = await tx.get(ref);
        if (!snap.exists || (snap.data() || {}).read_at) return false;
        tx.set(ref, { status: 'read', read_at: clock(), read_by: by }, { merge: true });
        return true;
      });
      if (changed) marked += 1;
    }
    return { marked };
  }

  // Admin SDK tooling only, never exposed as a callable or client write.
  async function remove(options) {
    const o = plain(options) ? options : {};
    if (Object.keys(o).some((key) => !['sid', 'id', 'by'].includes(key))
        || !access.validId(o.sid) || typeof o.id !== 'string'
        || !/^f_[a-f0-9]{40}$/.test(o.id) || o.by !== 'operator') {
      throw new TypeError('invalid feedback deletion');
    }
    return db.runTransaction(async (tx) => {
      const ref = feedbackRef(o.sid, o.id);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('feedback-not-found');
      const data = snap.data() || {};
      if (data.station_id !== o.sid || data.id !== o.id) throw new Error('feedback-identity-mismatch');
      tx.delete(ref);
      // Do not refund daily quota or remove other users' feedback.
      return { deleted: true, id: o.id };
    });
  }

  return Object.freeze({ submit, list, markRead, remove, planFeedback });
}

module.exports = Object.freeze({ createFeedback, CATEGORIES, RATINGS, LIMITS, QUOTA_TTL_MS, FEEDBACK_TTL_MS });
