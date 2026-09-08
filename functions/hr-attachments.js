'use strict';

/* ====================================================================
 *  hr-attachments · קבצים פרטיים ל-HR — העלאה, התאוששות והורדה.
 *
 *  **מודול טהור.** אינו מאתחל SDK, אינו מייצא callables, אינו מייבא
 *  את `hr-requests` או `hr-documents`, ואינו יודע מה זה FCM. כל מה
 *  שנוגע בעולם מגיע מוזרק: `db`, `storage`, `session`, `ports`.
 *
 *  ------------------------------------------------------------------
 *  הכלל שמארגן את כל הקובץ (seq542 §3)
 *  ------------------------------------------------------------------
 *  **בעסקת Firestore כל הקריאות קודמות לכל הכתיבות.** לא „רצוי" —
 *  חוק. הגרסה הקודמת חייבה מכסה (`tx.set`) ואז קראה פרופיל חי
 *  (`tx.get`), והכפיל שלי הרשה את זה. מול Firestore אמיתי זה נזרק.
 *
 *  לכן לכל עסקה כאן יש **שני שלבים מופרדים במפורש**:
 *    שלב א׳ · קריאה  — זהות, הורה, רשומה, ספרים, `prepare`, `recheck`
 *    שלב ב׳ · כתיבה  — `commit` (סינכרוני), הרשומה, הספרים
 *  אין `await` על קריאה אחרי הכתיבה הראשונה, והשעון נלקח **אחרי**
 *  כל ה-`await`-ים כדי שכל הכתיבות יישאו את אותו רגע. וה-hooks —
 *  כמו כל קריאה — **לפני** ה-`recheck` הסופי (seq545 §C).
 *
 *  ------------------------------------------------------------------
 *  חוזה ה-ports (seq547) — כפי שנמסר, לא כפי שניחשתי
 *  ------------------------------------------------------------------
 *  `read` מחזיר **בדיוק** `{parent_kind, parent_id, revision,
 *  attachment_ids}`, זורק `not-found` על הורה חסר, ו**הצלחתו היא
 *  הרשאת הקריאה**. אין `exists`/`can_upload`/`can_read` — אלה שדות
 *  שהמצאתי בגרסה קודמת, וזו הייתה טעות: ניחוש שנראה כמו חוזה.
 *
 *  **הרשאת ההעלאה מגיעה מ-`prepare`/`recheck` בלבד**, והם אינם
 *  כותבים כל עוד לא נקרא `commit` — ולכן משמשים גם כשער בשלב שאינו
 *  מפרסם. `revision` נשלח ל-`document` בלבד; ל-`request` השדה אסור.
 *  **חברות של שיוך שטרם פורסם לא נשאלת לעולם**, ושידור חוזר של
 *  שיוך שפורסם נבדק ב-`read` — לא ב-`prepare` עם בסיס ישן.
 *
 *  ------------------------------------------------------------------
 *  שלוש הנעיצות (seq538), כפי שהן נאכפות
 *  ------------------------------------------------------------------
 *  **1 · אימוץ נבחן על התוכן.** אובייקט מאומץ רק אחרי שהבייטים
 *  נקראו תחת תקרה, נספרו, גובבו והותאמו לחתימת הסוג. המטא-דאטה
 *  שכתבנו היא טענה **שלנו**; היא מצטרפת לראיה ואינה מחליפה אותה.
 *
 *  **2 · הניקוי תופס ראשון, והמכסה כמעט אף פעם אינה משתחררת.** כל
 *  מעבר מצב הוא CAS על `{state, attempt_id, cleaning_operation_id}`.
 *  ושחרור מכסה דורש **שתי עובדות יחד** (seq550 §1): שהאובייקט נעלם,
 *  **וגם** שמעולם לא נשלחו בייטים עבור הרשומה. מחיקת דור מוכיחה
 *  שאותו דור נעלם — היא **אינה** מוכיחה ששמירה מוחזקת לא תיצור אחד
 *  חדש באותו נתיב מיד אחריה. ספירת תצפיות, שעון וסימון זמני —
 *  כולם חלון זמן בתחפושת, וכולם ירדו.
 *
 *  **3 · קובץ יוצר רביזיה.** `commit` מחזיר בדיוק `N+1`; כל ערך
 *  אחר נדחה. `base_revision` ו-`published_revision` נשמרים בנפרד.
 *
 *  ⚠ **הנחה שאני מסמן, כי לא אומתה:** seq542 §5 ניסח „doc N+1
 *  מדויק". אני אוכף `base + 1` **גם ל-`request`**, כי כלל מחמיר
 *  שגוי נופל ברעש וכלל רופף שגוי עובר בשקט. אם פנייה מתקדמת אחרת —
 *  זה ייפול מיד, וזו בדיוק המטרה. דורש אישור.
 *
 *  ------------------------------------------------------------------
 *  ומה שהמודול הזה **אינו** עושה
 *  ------------------------------------------------------------------
 *  - **אינו סורק נוזקות.** בדיקת חתימה אומרת „הבייטים הפותחים
 *    תואמים לסוג המוצהר" — היא אינה אנטי-וירוס.
 *  - **אינו מייצר URL** מכל סוג. הרשאה נשאית סותרת „שיוך תחנה
 *    מהשרת בלבד".
 *  - **אינו מבטל את חלון השלילה.** הגדר מצמצמת; בייטים שיצאו אינם
 *    חוזרים.
 * ==================================================================== */

const { createHash, randomUUID } = require('node:crypto');

const SCHEMA = 'hr-attachment-v1';
const OBJECT_SCHEMA = 'hr-attachment-object-v1';
const LEDGER_SCHEMA = 'hr-attachment-ledger-v1';
/* **25 — קבוע מוצר, ולא נגזרת של נוחות בדיקה.** שיניתי אותו קודם
 * ל-5 כדי שהעמוד השני יהיה מסלול חי; זה היה הפוך. הסמן נבדק
 * בפיקסצ׳ר פנימי שאינו עובר דרך מכסת לקוח. */
const PAGE_SIZE = 25;

/* אותם ערכים שכבר ב-`hr-requests` וב-`hr-documents`. */
const QUOTA_MAX = 10;
const QUOTA_WINDOW_MS = 60000;

/* מחוזה v2, ועכשיו **נאכפים** ולא רק מוצהרים (seq542 §6). */
const PARENT_MAX_FILES = 10;
const PARENT_MAX_BYTES = 20 * 1024 * 1024;

const MAX_BYTES = 2 * 1024 * 1024;
/* הגבול נאכף על **אורך המחרוזת** לפני הפענוח: תקרה שנבדקת רק אחרי
 * הפענוח מחייבת להקצות את הזיכרון קודם. */
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_NAME = 120;
const RESERVE_TTL_MS = 15 * 60 * 1000;

const STATES = Object.freeze(['reserved', 'stored_pending', 'stored', 'cleaning', 'ready', 'failed']);
const TERMINAL = Object.freeze(['ready', 'failed']);
const PARENT_KINDS = Object.freeze(['request', 'document']);

const FAILURE_CODES = Object.freeze([
  'quota-exceeded', 'parent-forbidden', 'parent-closed', 'parent-revision-changed',
  'payload-invalid', 'signature-mismatch', 'foreign-object', 'link-failed',
  'cleaning-in-progress', 'abandoned'
]);

const TYPES = Object.freeze({
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
});

const REQUEST_ID = /^[A-Za-z0-9_-]{8,120}$/;
const KEY = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/* בקרה, RTL/LTR override ו-BOM — **כ-escapes ולא כתווים ממשיים**,
 * כדי שהקובץ יישאר טקסט שאפשר לבקר. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
/* סמן עמוד: `<revision>|<attachment_id>` — הזוג שהסדר בנוי עליו. */
const CURSOR = /^([1-9][0-9]{0,14})\|([a-f0-9]{64})$/;

const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const validRevision = v => Number.isSafeInteger(v) && v > 0;

function signatureMatches(bytes, declaredType) {
  const magic = TYPES[declaredType];
  if (!magic || !Buffer.isBuffer(bytes) || bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (bytes[i] !== magic[i]) return false;
  return true;
}

/**
 * `Buffer.from(s,'base64')` סלחני — בולע תווים זרים וריפוד שגוי.
 * לכן הבדיקה היא **הלוך-חזור**, ולא „הצליח לפענח".
 */
function decodeCanonical(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_BASE64) return null;
  if (!BASE64.test(value) || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) return null;
  return bytes;
}

function createHrAttachments(deps) {
  const { db, storage, HttpsError, session, ports, clock = Date.now, hooks = {} } = deps || {};
  if (!db || !storage || typeof HttpsError !== 'function') throw new TypeError('db, storage and HttpsError required');
  if (!session || typeof session.context !== 'function' || typeof session.assertLive !== 'function') {
    throw new TypeError('session.context and session.assertLive required');
  }
  /* חוזה seq543: `read` · `prepare` · `recheck` · `commit`.
   * `commit` **סינכרוני** — הוא רץ בשלב הכתיבה. */
  for (const name of ['read', 'prepare', 'recheck', 'commit']) {
    if (!ports || typeof ports[name] !== 'function') throw new TypeError('ports.' + name + ' required');
  }
  for (const name of ['save', 'read', 'remove']) {
    if (typeof storage[name] !== 'function') throw new TypeError('storage.' + name + ' required');
  }

  const error = (code, message) => new HttpsError(code, message);
  const root = sid => db.collection('stations').doc(sid);
  const attachmentRef = (sid, id) => root(sid).collection('hr_attachments').doc(id);
  const ledgerRef = (sid, kind, id) => root(sid).collection('hr_attachment_ledgers')
    .doc(hash([LEDGER_SCHEMA, kind, id]));
  const rateRef = uid => db.collection('hr_attachment_actor_quotas')
    .doc(hash(['hr-attachment-quota-v1', uid]));

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
      throw error('internal', 'Invalid clock.');
    }
    return value;
  }

  async function beforeWrites(stage) {
    if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ stage });
  }

  /* ---------- זהות ---------- */

  function epochOf(ctx, authTime) {
    return Object.freeze({
      uid: ctx.uid, station_id: ctx.sid, auth_time: authTime,
      claims_digest: hash([ctx.uid, ctx.sid, ctx.role || '', ctx.super === true])
    });
  }

  function request(req, keys) {
    const ctx = session.context(req);
    const data = req && req.data;
    if (!plain(data) || Object.keys(data).some(k => !keys.includes(k))) {
      throw error('invalid-argument', 'Invalid request fields.');
    }
    const authTime = req.auth && req.auth.token && req.auth.token.auth_time;
    if (!Number.isSafeInteger(authTime) || authTime < 0) throw error('unauthenticated', 'Refresh your sign-in.');
    return { ctx, data, authTime };
  }

  /* ---------- קלט ---------- */

  function displayName(value) {
    if (typeof value !== 'string') throw error('invalid-argument', 'Invalid file name.');
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_NAME || UNSAFE_NAME.test(trimmed)) {
      throw error('invalid-argument', 'Invalid file name.');
    }
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
      throw error('invalid-argument', 'Invalid file name.');
    }
    if (WINDOWS_RESERVED.test(trimmed)) throw error('invalid-argument', 'Invalid file name.');
    return trimmed;
  }

  function intent(ctx, data) {
    if (typeof data.request_id !== 'string' || !REQUEST_ID.test(data.request_id)) {
      throw error('invalid-argument', 'Invalid request identity.');
    }
    if (!PARENT_KINDS.includes(data.parent_kind)) throw error('invalid-argument', 'Invalid parent kind.');
    if (typeof data.parent_id !== 'string' || !KEY.test(data.parent_id)) {
      throw error('invalid-argument', 'Invalid parent identity.');
    }
    if (!validRevision(data.parent_revision)) throw error('invalid-argument', 'Invalid parent revision.');
    if (!own(TYPES, data.declared_type)) throw error('invalid-argument', 'Unsupported file type.');
    /* מספר שלם ממש, לא מחרוזת שניתן להמיר — הלקח מ-seq517. */
    if (typeof data.byte_length !== 'number' || !Number.isInteger(data.byte_length)
      || data.byte_length <= 0 || data.byte_length > MAX_BYTES) {
      throw error('invalid-argument', 'Invalid file size.');
    }
    if (typeof data.content_sha256 !== 'string' || !KEY.test(data.content_sha256)) {
      throw error('invalid-argument', 'Invalid content digest.');
    }
    return Object.freeze({
      station_id: ctx.sid, actor_uid: ctx.uid, request_id: data.request_id,
      parent_kind: data.parent_kind, parent_id: data.parent_id,
      base_revision: data.parent_revision,
      display_name: displayName(data.display_name), declared_type: data.declared_type,
      byte_length: data.byte_length, content_sha256: data.content_sha256
    });
  }

  /** כל שדות הכוונה — לא ה-hash לבדו (seq535 §3). */
  const fingerprintOf = i => hash(['hr-attachment-intent-v1', i.station_id, i.actor_uid, i.request_id,
    i.parent_kind, i.parent_id, i.base_revision, i.display_name, i.declared_type,
    i.byte_length, i.content_sha256]);

  const idOf = i => hash(['hr-attachment-v1', i.station_id, i.actor_uid, i.request_id]);

  /** נבנה בשרת, דטרמיניסטי — הפיוס מחשב ואינו סורק. */
  const pathOf = i => 'hr-private/' + i.station_id + '/' + i.parent_kind + '/' + i.parent_id + '/' + idOf(i);

  /* ---------- הרשומה ---------- */

  function record(snap, expect) {
    if (!snap.exists) return null;
    const d = snap.data();
    if (!plain(d) || d.schema !== SCHEMA || !STATES.includes(d.state)
      || d.station_id !== expect.station_id || d.attachment_id !== expect.attachment_id) {
      throw error('failed-precondition', 'Attachment data is invalid.');
    }
    return d;
  }

  /**
   * **CAS על כל מעבר** (seq542 §1). אין כתיבה שאינה יודעת את מי היא
   * דורסת: המצב, הניסיון והבעלות על הניקוי — שלושתם.
   */
  function assertOwnership(current, expect) {
    if (!current) throw error('not-found', 'Attachment not found.');
    if (Array.isArray(expect.state) ? !expect.state.includes(current.state) : current.state !== expect.state) {
      throw error('aborted', 'The attachment changed while this operation was running.');
    }
    if (own(expect, 'attempt_id') && current.attempt_id !== expect.attempt_id) {
      throw error('aborted', 'The upload attempt was superseded.');
    }
    if (own(expect, 'cleaning_operation_id')
      && (current.cleaning_operation_id || null) !== expect.cleaning_operation_id) {
      throw error('aborted', 'The cleanup claim was superseded.');
    }
    return current;
  }

  /* ---------- ספרי המכסה ---------- */

  function ledgerOf(snap) {
    if (!snap.exists) return { entries: {} };
    const d = snap.data();
    if (!plain(d) || d.schema !== LEDGER_SCHEMA || !plain(d.entries)) {
      throw error('failed-precondition', 'Attachment ledger is invalid.');
    }
    for (const v of Object.values(d.entries)) {
      if (!Number.isSafeInteger(v) || v < 0 || v > MAX_BYTES) {
        throw error('failed-precondition', 'Attachment ledger is invalid.');
      }
    }
    return d;
  }

  /**
   * **הספר הוא הרשומה, לא מונה.** חברות מפורשת לפי `attachment_id`
   * הופכת גם את החיוב וגם את השחרור לאידמפוטנטיים: להוסיף פעמיים
   * זה אותו ערך, ולשחרר פעמיים זה אותו היעדר. כך „פעם אחת בדיוק"
   * אינו מסתמך על תזמון.
   *
   * **וההזמנה נספרת.** `reserved` ו-`stored_pending` תופסים מקום —
   * ניסיון שאיננו יודעים את גורלו אינו „לא קיים".
   */
  function ledgerAdd(ledger, id, bytes) {
    const entries = { ...ledger.entries };
    if (own(entries, id)) return { entries, changed: false };
    const count = Object.keys(entries).length + 1;
    const total = Object.values(entries).reduce((a, b) => a + b, 0) + bytes;
    if (count > PARENT_MAX_FILES) throw error('resource-exhausted', 'This item already has the maximum number of files.');
    if (total > PARENT_MAX_BYTES) throw error('resource-exhausted', 'This item has reached its total file size limit.');
    entries[id] = bytes;
    return { entries, changed: true };
  }

  function ledgerRemove(ledger, id) {
    if (!own(ledger.entries, id)) return { entries: ledger.entries, changed: false };
    const entries = { ...ledger.entries };
    delete entries[id];
    return { entries, changed: true };
  }

  function rateOf(snap, at) {
    const prior = snap.exists ? snap.data().requests_at_ms : [];
    if (!Array.isArray(prior) || prior.some(t => !Number.isSafeInteger(t) || t < 0)) {
      throw error('failed-precondition', 'Quota data is invalid.');
    }
    return prior.filter(t => t > at - QUOTA_WINDOW_MS && t <= at);
  }

  /* ---------- ההורה ---------- */

  /**
   * **חוזה `read` כפי שנמסר ב-seq547, ולא כפי שניחשתי.**
   *
   * מחזיר **בדיוק** `{parent_kind, parent_id, revision, attachment_ids}`.
   * הורה חסר **זורק** `not-found`; נתון פגום זורק `failed-precondition`.
   * **אין `exists`, אין `can_upload`, אין `can_read`** — אלה שדות
   * שהמצאתי, וזו הייתה טעות.
   *
   * **הצלחת `read` היא הרשאת הקריאה.** ולכן: אין `try` סביבה, ואין
   * המרה של כשל לבוליאני. כשל מתפשט כפי שהוא.
   *
   * `revision` נשלח **רק ל-`document`, ורק כשהוא ידוע**. ל-`request`
   * השדה אסור לחלוטין, ו-`undefined` אינו „לא נשלח" — לכן שדות
   * אופציונליים לא מוגדרים **אינם נכנסים לאובייקט מלכתחילה**.
   */
  async function readParent(tx, r, args) {
    const input = {
      ctx: r.ctx, authTime: r.authTime,
      parent_kind: args.parent_kind, parent_id: args.parent_id
    };
    if (args.parent_kind === 'document' && args.revision != null) input.revision = args.revision;
    if (args.attachment_id != null) input.attachment_id = args.attachment_id;

    const parent = await ports.read(tx, input);

    if (!plain(parent) || parent.parent_kind !== args.parent_kind
      || parent.parent_id !== args.parent_id || !validRevision(parent.revision)
      || !Array.isArray(parent.attachment_ids)
      || parent.attachment_ids.some(v => typeof v !== 'string' || !KEY.test(v))) {
      throw error('failed-precondition', 'The parent record is unavailable.');
    }
    /* ה-port מאמת חברות בעצמו; זו בדיקה שנייה על מה שהוא **החזיר**,
     * ולא דגל שהמצאתי. מתאם שאינו אוכף — נתפס כאן. */
    if (args.attachment_id != null && !parent.attachment_ids.includes(args.attachment_id)) {
      throw error('permission-denied', 'This file is not part of that item.');
    }
    return parent;
  }

  /**
   * **הרשאת העלאה אינה מגיעה מ-`read`** (seq547). `prepare` זורק על
   * חוסר הרשאה, בסיס שזז, תיק סגור וקיבולת, ו**אינו כותב** כל עוד
   * לא נקרא `commit`. לכן מותר להשתמש בו כשער בשלב שאינו מפרסם.
   */
  async function prepareUpload(tx, r, d, eventId) {
    const plan = await ports.prepare(tx, {
      ctx: r.ctx, authTime: r.authTime,
      parent_kind: d.parent_kind, parent_id: d.parent_id,
      expected_revision: d.base_revision, attachment_id: d.attachment_id,
      event_id: eventId
    });
    if (plan == null) throw error('failed-precondition', 'The attachment could not be prepared.');
    return plan;
  }

  /**
   * **קבלה אחידה לכל מסלולי `ready`** (seq550 §2).
   *
   * כל מסלול שמחזיר „כבר מוכן" עובר דרך כאן, ו-`read` נקרא עם
   * **הרביזיה שפורסמה ועם ה-`attachment_id`** — כלומר גם הרשאת
   * קריאה חיה וגם חברות בפועל.
   *
   * **זהות חיה לבדה אינה מספיקה.** מי שהיה HR, יצא, ונכנס מחדש עם
   * claims נמוכים — הסשן שלו תקין לחלוטין, ובכל זאת אסור שיקבל
   * קבלה על קובץ של אדם אחר. ההרשאה נקבעת בהורה, לא בטוקן.
   */
  async function readyReceipt(tx, r, d) {
    await readParent(tx, r, {
      parent_kind: d.parent_kind, parent_id: d.parent_id,
      revision: d.published_revision, attachment_id: d.attachment_id
    });
    return {
      attachment_id: d.attachment_id, state: 'ready',
      revision: d.published_revision, duplicate: true, notification_status: 'already'
    };
  }

  /** קבלה מאושרת בעסקה משלה, למסלולים שאינם כבר בתוך אחת. */
  async function authorizedReceipt(r, attachment_id) {
    const sid = r.ctx.sid;
    return db.runTransaction(async tx => {
      await session.assertLive(tx, r.ctx, r.authTime);
      const d = record(await tx.get(attachmentRef(sid, attachment_id)), { station_id: sid, attachment_id });
      if (!d || d.state !== 'ready') throw error('failed-precondition', 'This attachment is not available.');
      return readyReceipt(tx, r, d);
    });
  }

  /** `event_id` דטרמיניסטי — אותו ניסיון, אותו אירוע. */
  const eventIdOf = (sid, attachment_id, attemptId) =>
    hash(['hr-attachment-event-v1', sid, attachment_id, attemptId]);

  /** רביזיה מוצגת מותרת ל-`document` בלבד. */
  function shownRevisionOf(kind, data) {
    if (!own(data, 'revision') || data.revision === null) return null;
    if (kind !== 'document') throw error('invalid-argument', 'A revision cannot be given for this item.');
    if (!validRevision(data.revision)) throw error('invalid-argument', 'Invalid revision.');
    return data.revision;
  }

  /* ---------- הפעולות ---------- */

  /**
   * הזמנה. **בייטים אינם עוברים כאן** — מכסה שנחסמת נחסמת לפני
   * שכ-2.8 מיליון תווים עוברים ברשת.
   */
  async function reserve(req) {
    const r = request(req, ['request_id', 'parent_kind', 'parent_id', 'parent_revision',
      'display_name', 'declared_type', 'byte_length', 'content_sha256']);
    const i = intent(r.ctx, r.data);
    const attachment_id = idOf(i);
    const fingerprint = fingerprintOf(i);
    const ref = attachmentRef(i.station_id, attachment_id);
    const lRef = ledgerRef(i.station_id, i.parent_kind, i.parent_id);
    const qRef = rateRef(i.actor_uid);

    return db.runTransaction(async tx => {
      /* ---- שלב א׳ · קריאה בלבד ---- */
      await session.assertLive(tx, r.ctx, r.authTime);
      const existing = record(await tx.get(ref), { station_id: i.station_id, attachment_id });
      if (existing && existing.fingerprint !== fingerprint) {
        throw error('already-exists', 'Request identity already used for another file.');
      }
      /* **שידור חוזר של הזמנה שהצליחה נבדק ראשון** (seq550 §2).
       * אחרי `N+1` ההורה כבר זז, ולכן בדיקת בסיס לפני זיהוי
       * ה-replay הפילה **חזרה מדויקת של בקשה שהצליחה** — וזו בדיוק
       * הבקשה שחייבת להיות אידמפוטנטית. */
      if (existing && existing.state === 'ready') {
        const receipt = await readyReceipt(tx, r, existing);
        return { ...receipt, reserve_expires_ms: existing.reserve_expires_ms,
          epoch: epochOf(r.ctx, r.authTime) };
      }
      /* **בלי `attachment_id`** — הקובץ טרם פורסם, ואין לו חברות
       * לשאול עליה (seq547 §3). */
      const parent = await readParent(tx, r, {
        parent_kind: i.parent_kind, parent_id: i.parent_id
      });
      if (parent.revision !== i.base_revision) throw error('aborted', 'Parent changed. Review and retry.');
      if (existing) {
        return { attachment_id, state: existing.state, duplicate: true,
          reserve_expires_ms: existing.reserve_expires_ms, epoch: epochOf(r.ctx, r.authTime) };
      }
      /* **הרשאת ההעלאה מגיעה מ-`prepare`, לא מ-`read`.** אין
       * `commit`, ולכן אין כתיבה בהורה. */
      const gate = await prepareUpload(tx, r, {
        parent_kind: i.parent_kind, parent_id: i.parent_id,
        base_revision: i.base_revision, attachment_id
      }, eventIdOf(i.station_id, attachment_id, 'reserve'));
      const ledger = ledgerOf(await tx.get(lRef));
      const rateSnap = await tx.get(qRef);
      await beforeWrites('reserve');
      await ports.recheck(tx, gate);

      /* ---- שלב ב׳ · כתיבה בלבד. השעון נלקח כאן, אחרי כל ה-await. ---- */
      const at = now();
      const recent = rateOf(rateSnap, at);
      if (recent.length >= QUOTA_MAX) throw error('resource-exhausted', 'Too many uploads. Try again shortly.');
      const next = ledgerAdd(ledger, attachment_id, i.byte_length);

      tx.create(ref, {
        schema: SCHEMA, attachment_id, state: 'reserved',
        station_id: i.station_id, actor_uid: i.actor_uid, request_id: i.request_id,
        parent_kind: i.parent_kind, parent_id: i.parent_id,
        base_revision: i.base_revision, published_revision: null,
        display_name: i.display_name, declared_type: i.declared_type,
        byte_length: i.byte_length, content_sha256: i.content_sha256,
        fingerprint, object_path: pathOf(i), object_generation: null,
        attempt_id: null, cleaning_operation_id: null, prior_state: null, link_event_id: null,
        reserved_at_ms: at, reserve_expires_ms: at + RESERVE_TTL_MS,
        stored_at_ms: null, ready_at_ms: null, failed_at_ms: null, failure_code: null
      });
      tx.set(lRef, {
        schema: LEDGER_SCHEMA, station_id: i.station_id,
        parent_kind: i.parent_kind, parent_id: i.parent_id, entries: next.entries
      });
      tx.set(qRef, { requests_at_ms: [...recent, at] }, { merge: true });

      return { attachment_id, state: 'reserved', duplicate: false,
        reserve_expires_ms: at + RESERVE_TTL_MS, epoch: epochOf(r.ctx, r.authTime) };
    });
  }

  function envelope(d, expected) {
    const bytes = decodeCanonical(d.content_base64);
    if (!bytes) throw error('invalid-argument', 'Invalid file payload.');
    if (bytes.length !== expected.byte_length) throw error('invalid-argument', 'File size does not match.');
    if (sha256(bytes) !== expected.content_sha256) throw error('invalid-argument', 'File digest does not match.');
    if (!signatureMatches(bytes, expected.declared_type)) {
      throw error('invalid-argument', 'File content does not match its declared type.');
    }
    return bytes;
  }

  const objectMetadata = (d, attemptId) => Object.freeze({
    'resq-schema': OBJECT_SCHEMA, 'resq-station': d.station_id,
    'resq-attachment': d.attachment_id, 'resq-fingerprint': d.fingerprint,
    'resq-content-sha': d.content_sha256, 'resq-attempt': attemptId
  });

  /**
   * **אימוץ נבחן על התוכן** (seq538 §1). מחזיר גם `present` וגם `ok`
   * בנפרד: „לא נמצא" ו„נמצא ואינו שלנו" הן שתי מסקנות שונות לגמרי.
   */
  async function verifyObject(d, generation) {
    const found = await storage.read({
      path: d.object_path,
      generation: generation === undefined ? null : generation,
      maxBytes: MAX_BYTES
    });
    if (!found) return { present: false, ok: false };
    if (found.oversize === true || !Buffer.isBuffer(found.bytes)) {
      return { present: true, ok: false, generation: found.generation };
    }
    const meta = plain(found.metadata) ? found.metadata : {};
    const ok = found.bytes.length === d.byte_length
      && sha256(found.bytes) === d.content_sha256
      && signatureMatches(found.bytes, d.declared_type)
      && meta['resq-schema'] === OBJECT_SCHEMA
      && meta['resq-station'] === d.station_id
      && meta['resq-attachment'] === d.attachment_id
      && meta['resq-fingerprint'] === d.fingerprint
      && meta['resq-content-sha'] === d.content_sha256;
    return { present: true, ok, generation: found.generation, bytes: found.bytes };
  }

  /**
   * הסיום. שלב קריאה מלא, ואז `commit` **סינכרוני** בשלב הכתיבה.
   *
   * **`commit` חייב להחזיר בדיוק `base + 1`** (seq542 §5). רביזיה
   * אחרת פירושה שההורה זז מתחתינו, ואנחנו לא מפרסמים לתוך משהו
   * שלא אישרנו. **כשל התראה מפיל את העסקה כולה** — הכוונה כאן
   * עמידה, ולא „נשמר אבל אולי לא יידעו".
   */
  async function finalize(r, attachment_id, expect) {
    const sid = r.ctx.sid;
    const ref = attachmentRef(sid, attachment_id);
    return db.runTransaction(async tx => {
      /* ---- שלב א׳ · קריאה ---- */
      await session.assertLive(tx, r.ctx, r.authTime);
      const d = record(await tx.get(ref), { station_id: sid, attachment_id });
      if (!d) throw error('not-found', 'Attachment not found.');
      /* **שידור חוזר נבדק ב-`read` של השיוך שכבר פורסם** — לא
       * ב-`prepare` עם `expected_revision` ישן (seq547 §4). */
      if (d.state === 'ready') return readyReceipt(tx, r, d);
      assertOwnership(d, expect);

      /* טרם פורסם ⇒ **בלי `attachment_id`**. */
      const parent = await readParent(tx, r, {
        parent_kind: d.parent_kind, parent_id: d.parent_id
      });
      if (parent.revision !== d.base_revision) {
        throw error('aborted', 'Parent changed while the file was uploading.');
      }
      const eventId = eventIdOf(sid, attachment_id, d.attempt_id);
      const plan = await prepareUpload(tx, r, d, eventId);
      /* **ההשתלטות נבדקת לפני הבדיקה האחרונה** (seq545 §C). hook
       * שרץ אחרי `recheck` בודק מצב שכבר עבר. */
      await beforeWrites('finalize');
      await ports.recheck(tx, plan);

      /* ---- שלב ב׳ · כתיבה. `commit` סינכרוני. ---- */
      const at = now();
      const link = ports.commit(tx, plan, { at });
      if (!plain(link) || link.linked !== true) {
        throw error('failed-precondition', 'The attachment could not be linked to its parent.');
      }
      if (link.revision !== d.base_revision + 1) {
        throw error('failed-precondition', 'The parent did not publish the expected revision.');
      }
      if (link.event_id !== eventId) {
        throw error('failed-precondition', 'The parent recorded a different event.');
      }
      tx.set(ref, {
        state: 'ready', object_generation: String(expect.generation),
        published_revision: link.revision, link_event_id: link.event_id,
        stored_at_ms: d.stored_at_ms == null ? at : d.stored_at_ms, ready_at_ms: at,
        cleaning_operation_id: null
      }, { merge: true });

      return { attachment_id, state: 'ready', revision: link.revision,
        notification_status: link.notification_status || 'queued', duplicate: false };
    });
  }

  /** נקודת ביקורת: הכוונה נרשמת **לפני** תופעת הלוואי. */
  async function checkpoint(r, attachment_id, fingerprint, attemptId) {
    const sid = r.ctx.sid;
    const ref = attachmentRef(sid, attachment_id);
    return db.runTransaction(async tx => {
      await session.assertLive(tx, r.ctx, r.authTime);
      const d = record(await tx.get(ref), { station_id: sid, attachment_id });
      if (!d) throw error('not-found', 'Reserve the attachment first.');
      if (fingerprint && d.fingerprint !== fingerprint) {
        throw error('already-exists', 'Request identity already used for another file.');
      }
      /* **גם „כבר מוכן" עובר הרשאת הורה** (seq550 §2) — לא רק
       * זהות חיה. */
      if (d.state === 'ready') return { d, skip: true, receipt: await readyReceipt(tx, r, d) };
      if (d.state === 'cleaning') throw error('aborted', 'Cleanup is in progress for this attachment.');
      if (d.state === 'failed') throw error('failed-precondition', 'This attachment already failed.');
      const parent = await readParent(tx, r, {
        parent_kind: d.parent_kind, parent_id: d.parent_id
      });
      if (parent.revision !== d.base_revision) {
        throw error('aborted', 'Parent changed. Review and retry.');
      }
      /* שער ההעלאה **לפני** שהבייטים יוצאים לאחסון. */
      const gate = await prepareUpload(tx, r, d, eventIdOf(sid, attachment_id, attemptId));
      await beforeWrites('checkpoint');
      await ports.recheck(tx, gate);
      /* **הדור של הניסיון הקודם נמחק** (seq545 §A). בלי זה ניסיון
       * חדש יורש דור שאינו שלו, והפיוס מוחק לפי דור זר. מה שקיים
       * בפועל בנתיב ייקרא ויאומת מחדש במסלול האימוץ. */
      tx.set(ref, { state: 'stored_pending', attempt_id: attemptId, object_generation: null },
        { merge: true });
      return { d: { ...d, state: 'stored_pending', attempt_id: attemptId }, skip: false };
    });
  }

  /** מסמן `stored` תחת CAS — לעולם לא דורס `ready`, `failed` או `cleaning`. */
  async function markStored(r, attachment_id, attemptId, generation) {
    const sid = r.ctx.sid;
    const ref = attachmentRef(sid, attachment_id);
    return db.runTransaction(async tx => {
      const d = record(await tx.get(ref), { station_id: sid, attachment_id });
      if (d && d.state === 'ready') return { already: true };
      await beforeWrites('markStored');
      assertOwnership(d, { state: ['stored_pending', 'stored'], attempt_id: attemptId,
        cleaning_operation_id: null });
      tx.set(ref, { state: 'stored', object_generation: String(generation), stored_at_ms: now() },
        { merge: true });
      return { already: false };
    });
  }

  async function markForeign(r, attachment_id, attemptId) {
    const sid = r.ctx.sid;
    const ref = attachmentRef(sid, attachment_id);
    await db.runTransaction(async tx => {
      const d = record(await tx.get(ref), { station_id: sid, attachment_id });
      /* **בלי CAS זה היה יכול לדרוס `ready`.** אם המצב זז — לא נוגעים. */
      if (!d || TERMINAL.includes(d.state) || d.state === 'cleaning') return;
      if (attemptId && d.attempt_id !== attemptId) return;
      tx.set(ref, { state: 'failed', failure_code: 'foreign-object', failed_at_ms: now() }, { merge: true });
    });
  }

  /** מאמץ אובייקט קיים — רק אחרי אימות תוכן מלא. */
  async function adopt(r, attachment_id, d) {
    const found = await verifyObject(d);
    if (!found.present) return null;
    if (!found.ok) {
      await markForeign(r, attachment_id, d.attempt_id);
      throw error('failed-precondition', 'A conflicting object exists for this attachment.');
    }
    const marked = await markStored(r, attachment_id, d.attempt_id, found.generation);
    /* **גם כאן ההורה נקרא** — אימוץ אינו דלת אחורית לקבלה. */
    if (marked.already) return authorizedReceipt(r, attachment_id);
    return finalize(r, attachment_id, {
      state: ['stored'], attempt_id: d.attempt_id, cleaning_operation_id: null,
      generation: found.generation
    });
  }

  async function put(r, i, attachment_id, bytes) {
    /**
     * **מזהה הניסיון אינו נגזר מהשעון.** הגרסה הקודמת גיבבה את
     * `now()`, ולכן שני ניסיונות באותה מילישנייה קיבלו **אותו
     * מזהה** — וה-CAS על `attempt_id` לא הבחין ביניהם. זה התגלה
     * כשכתבתי את התרחיש של seq550 §1 עם שעון קפוא: מה שאמור היה
     * להיות שני ניסיונות היה ניסיון אחד. **ייחודיות היא הדרישה,
     * לא דטרמיניזם.**
     */
    const attemptId = hash(['hr-attachment-attempt-v1', attachment_id, randomUUID()]);
    const { d, skip, receipt } = await checkpoint(r, attachment_id, fingerprintOf(i), attemptId);
    if (skip) return receipt;

    let generation = null;
    try {
      const saved = await storage.save({
        path: d.object_path, bytes, contentType: d.declared_type,
        cacheControl: 'private, no-store', contentDisposition: 'attachment',
        metadata: objectMetadata(d, attemptId), ifGenerationMatch: 0
      });
      generation = saved && saved.generation;
      if (generation == null) throw error('unavailable', 'The file could not be stored.');
    } catch (e) {
      /* **412 אינו שגיאה** — האובייקט קיים, והבדיקה מכריעה אם הוא
       * שלנו. תשובה שאבדה עוברת באותו מסלול: אין צורך לדעת אם היא
       * אבדה, צריך לדעת מה קיים. */
      const adopted = await adopt(r, attachment_id, d);
      if (adopted) return adopted;
      throw e && e.code ? e : error('unavailable', 'The file could not be stored.');
    }

    await markStored(r, attachment_id, attemptId, generation);
    return finalize(r, attachment_id, {
      state: ['stored'], attempt_id: attemptId, cleaning_operation_id: null, generation
    });
  }

  async function upload(req) {
    const r = request(req, ['request_id', 'parent_kind', 'parent_id', 'parent_revision',
      'display_name', 'declared_type', 'byte_length', 'content_sha256', 'content_base64']);
    const i = intent(r.ctx, r.data);
    const bytes = envelope(r.data, i);
    const out = await put(r, i, idOf(i), bytes);
    return { ...out, epoch: epochOf(r.ctx, r.authTime) };
  }

  /**
   * התאוששות מהעלאה שנקטעה. **הגדר קודמת לכל תשובה** (seq542 §4):
   * גם „כבר מוכן" עובר זהות חיה והרשאת הורה, ושם הקובץ אינו נחשף
   * למי שהרשאתו נשללה.
   */
  async function resume(req) {
    const r = request(req, ['attachment_id']);
    const attachment_id = r.data.attachment_id;
    if (typeof attachment_id !== 'string' || !KEY.test(attachment_id)) {
      throw error('invalid-argument', 'Invalid attachment identity.');
    }
    const sid = r.ctx.sid;
    const epoch = epochOf(r.ctx, r.authTime);

    const gate = await db.runTransaction(async tx => {
      await session.assertLive(tx, r.ctx, r.authTime);
      const cur = record(await tx.get(attachmentRef(sid, attachment_id)), { station_id: sid, attachment_id });
      if (!cur) throw error('not-found', 'Attachment not found.');
      if (cur.actor_uid !== r.ctx.uid) throw error('permission-denied', 'Only the uploader can resume this upload.');
      /* פורסם ⇒ **חברות** ברביזיה שבה פורסם, דרך אותה קבלה. */
      if (cur.state === 'ready') return { cur, receipt: await readyReceipt(tx, r, cur) };
      /* טרם פורסם ⇒ קיום והרשאת קריאה מ-`read`, והרשאת העלאה
       * מ-`prepare`/`recheck` — בלי `commit`, ולכן בלי כתיבה. */
      await readParent(tx, r, { parent_kind: cur.parent_kind, parent_id: cur.parent_id });
      if (!TERMINAL.includes(cur.state) && cur.state !== 'cleaning') {
        const gate = await prepareUpload(tx, r, cur, eventIdOf(sid, attachment_id, cur.attempt_id || 'resume'));
        await ports.recheck(tx, gate);
      }
      return { cur };
    });

    const d = gate.cur;
    if (gate.receipt) return { ...gate.receipt, epoch };
    if (d.state === 'cleaning') throw error('aborted', 'Cleanup is in progress for this attachment.');
    if (d.state === 'failed') throw error('failed-precondition', 'This attachment already failed.');
    if (d.state === 'reserved') return { attachment_id, state: 'reserved', resume: 'upload-required', epoch };

    const adopted = await adopt(r, attachment_id, d);
    if (adopted) return { ...adopted, epoch };
    return { attachment_id, state: d.state, resume: 'upload-required', epoch };
  }

  /**
   * הורדה. **הרביזיה המוצגת מגיעה מהקורא** (seq545 §C): הבדיקה היא
   * „האם הקובץ הזה חבר ברביזיה שהמשתמש רואה", ולא „באיזו רביזיה הוא
   * נולד" — האחרונה נכונה תמיד מעצם הבנייה, ולכן אינה בדיקה.
   * ל-`request` אין רביזיה מוצגת, והשדה נדחה.
   */
  async function download(req) {
    const r = request(req, ['attachment_id', 'revision']);
    const attachment_id = r.data.attachment_id;
    if (typeof attachment_id !== 'string' || !KEY.test(attachment_id)) {
      throw error('invalid-argument', 'Invalid attachment identity.');
    }
    const sid = r.ctx.sid;
    const ref = attachmentRef(sid, attachment_id);

    const gate = async () => db.runTransaction(async tx => {
      await session.assertLive(tx, r.ctx, r.authTime);
      const d = record(await tx.get(ref), { station_id: sid, attachment_id });
      if (!d) throw error('not-found', 'Attachment not found.');
      if (d.state !== 'ready') throw error('failed-precondition', 'This file is not available.');
      const shown = shownRevisionOf(d.parent_kind, r.data);
      await readParent(tx, r, {
        parent_kind: d.parent_kind, parent_id: d.parent_id,
        revision: shown == null ? d.published_revision : shown,
        attachment_id
      });
      return d;
    });

    const authorized = await gate();
    const found = await verifyObject(authorized, authorized.object_generation);
    if (!found.present || !found.ok) throw error('unavailable', 'This file is not available.');

    /* **גדר סופית** — זהות והורה נקראים מחדש מיד לפני שהבייטים
     * יוצאים, והדור חייב להיות אותו דור. היא **מצמצמת** את חלון
     * השלילה ואינה מבטלת אותו: בייטים שיצאו לא חוזרים. */
    const again = await gate();
    if (again.object_generation !== authorized.object_generation) {
      throw error('failed-precondition', 'This file is not available.');
    }

    return {
      attachment_id, display_name: authorized.display_name,
      declared_type: authorized.declared_type, byte_length: authorized.byte_length,
      content_base64: found.bytes.toString('base64'),
      epoch: epochOf(r.ctx, r.authTime)
    };
  }

  /**
   * רשימה מעומדת. הסדר והסמן הם **אותו זוג** — `(published_revision,
   * attachment_id)` — ולכן עמוד שני אינו מדלג ואינו חוזר גם כששתי
   * רשומות חולקות רביזיה (seq542 §7).
   *
   * ולמסמך: **רק קבצים ששייכים לרביזיה המוצגת או קודמת לה.** קובץ
   * שיתווסף בעתיד אינו חלק במסמך שהמשתמש רואה עכשיו.
   */
  async function list(req) {
    const r = request(req, ['parent_kind', 'parent_id', 'revision', 'cursor']);
    const d = r.data;
    if (!PARENT_KINDS.includes(d.parent_kind)) throw error('invalid-argument', 'Invalid parent kind.');
    if (typeof d.parent_id !== 'string' || !KEY.test(d.parent_id)) {
      throw error('invalid-argument', 'Invalid parent identity.');
    }
    const shown = shownRevisionOf(d.parent_kind, d);

    let after = null;
    if (own(d, 'cursor') && d.cursor !== null) {
      if (typeof d.cursor !== 'string') throw error('invalid-argument', 'Invalid cursor.');
      const m = CURSOR.exec(d.cursor);
      if (!m) throw error('invalid-argument', 'Invalid cursor.');
      after = [Number(m[1]), m[2]];
    }

    /* **`attachment_ids` הוא מקור האמת לחברות** (seq545 §C). סינון
     * לפי `published_revision <=` הוא קירוב שלי, ולא מה שההורה
     * מצהיר. `attachment_id` מושמט — זו קריאת רשימה. */
    const readMembers = async () => db.runTransaction(async tx => {
      await session.assertLive(tx, r.ctx, r.authTime);
      const p = await readParent(tx, r, {
        parent_kind: d.parent_kind, parent_id: d.parent_id, revision: shown
      });
      return p;
    });

    const parent = await readMembers();
    const members = [...new Set(parent.attachment_ids)];

    /* הקריאות תחומות בקיבולת שההורה עצמו אוכף; אין כאן סריקה. */
    const snaps = await Promise.all(members.map(id => attachmentRef(r.ctx.sid, id).get()));
    const rows = [];
    for (let n = 0; n < members.length; n += 1) {
      const snap = snaps[n];
      const v = snap.exists ? snap.data() : null;
      /* ההורה והרשומה נכתבים **באותה עסקה**, ולכן חוסר התאמה כאן
       * הוא באג ולא מצב מעבר. **לא נבלע בשקט.** */
      if (!plain(v) || v.schema !== SCHEMA || v.state !== 'ready'
        || v.station_id !== r.ctx.sid || v.attachment_id !== members[n]
        || v.parent_kind !== d.parent_kind || v.parent_id !== d.parent_id
        || !validRevision(v.published_revision)) {
        throw error('failed-precondition', 'The attachment list is inconsistent.');
      }
      rows.push(v);
    }

    rows.sort((a, b) => (a.published_revision - b.published_revision)
      || (a.attachment_id < b.attachment_id ? -1 : a.attachment_id > b.attachment_id ? 1 : 0));

    const startAt = after
      ? rows.findIndex(v => v.published_revision > after[0]
        || (v.published_revision === after[0] && v.attachment_id > after[1]))
      : 0;
    const page = startAt < 0 ? [] : rows.slice(startAt, startAt + PAGE_SIZE);
    const more = startAt >= 0 && rows.length > startAt + PAGE_SIZE;
    const last = page[page.length - 1];

    /* **גדר סופית** — הזהות וההורה נקראים מחדש מיד לפני שהתשובה
     * יוצאת, כי `read` הוא גם הרשאת הקריאה. שמות קבצים אינם נחשפים
     * למי שהרשאתו נשללה בזמן הקריאה. */
    await readMembers();

    return {
      items: page.map(v => ({
        attachment_id: v.attachment_id, display_name: v.display_name,
        declared_type: v.declared_type, byte_length: v.byte_length,
        revision: v.published_revision, created_at_ms: v.ready_at_ms
      })),
      next_cursor: more && last ? last.published_revision + '|' + last.attachment_id : null,
      revision: parent.revision,
      epoch: epochOf(r.ctx, r.authTime)
    };
  }

  /* ---------- הפיוס ---------- */

  /**
   * **פנימי. לא callable.**
   *
   * שלושה שלבים, וכל אחד מהם CAS: תפיסה ⇒ הוכחה ⇒ שחרור.
   *
   * **שחרור מכסה קורה רק על הוכחה** (seq542 §1, §6): היעדר שנצפה
   * בפועל, או מחיקה של הדור המדויק שאישרה הסרה. `generation` חסר
   * **אינו** רשות לשחרר — הוא בדיוק המצב שבו כתיבה עוד עשויה לנחות.
   * תפוגה לבדה אינה ראיה לכלום.
   */
  async function reconcile(input) {
    const { sid, attachment_id, operation_id } = input || {};
    if (typeof sid !== 'string' || !sid) throw error('invalid-argument', 'Station is required.');
    if (typeof attachment_id !== 'string' || !KEY.test(attachment_id)) {
      throw error('invalid-argument', 'Invalid attachment identity.');
    }
    if (typeof operation_id !== 'string' || !REQUEST_ID.test(operation_id)) {
      throw error('invalid-argument', 'Invalid operation identity.');
    }
    const ref = attachmentRef(sid, attachment_id);

    /* ---- 1 · תפיסה ---- */
    const claim = await db.runTransaction(async tx => {
      const d = record(await tx.get(ref), { station_id: sid, attachment_id });
      if (!d) return { claimed: false, reason: 'not-found' };
      if (d.state === 'ready') return { claimed: false, reason: 'ready' };
      if (d.state === 'failed') return { claimed: false, reason: 'already-failed' };
      if (d.state === 'cleaning') {
        return { claimed: d.cleaning_operation_id === operation_id, reason: 'cleaning', d };
      }
      if (!Number.isSafeInteger(d.reserve_expires_ms) || now() < d.reserve_expires_ms) {
        return { claimed: false, reason: 'not-expired' };
      }
      /* **המצב הקודם נרשם.** בלעדיו לא נדע, בשלב ההוכחה, אם מדובר
       * בהזמנה שמעולם לא שלחה בייטים או בשמירה שתוצאתה אבדה — ואלה
       * שני מקרים עם שתי מסקנות הפוכות. */
      tx.set(ref, { state: 'cleaning', cleaning_operation_id: operation_id, prior_state: d.state },
        { merge: true });
      return { claimed: true, reason: 'claimed', d: { ...d, state: 'cleaning', prior_state: d.state } };
    });
    if (!claim.claimed) return { cleaned: false, reason: claim.reason, quota_released: false };

    /* ---- 2 · הוכחה, מחוץ לעסקה ---- */
    const d = claim.d;
    const prior = STATES.includes(d.prior_state) ? d.prior_state : 'stored_pending';
    const seen = await verifyObject(d, d.object_generation == null ? undefined : d.object_generation);

    if (seen.present && !seen.ok) {
      await db.runTransaction(async tx => {
        const cur = record(await tx.get(ref), { station_id: sid, attachment_id });
        if (cur && cur.state === 'cleaning' && cur.cleaning_operation_id === operation_id) {
          tx.set(ref, { state: 'failed', failure_code: 'foreign-object', failed_at_ms: now(),
            cleaning_operation_id: null, prior_state: null }, { merge: true });
        }
      });
      /* אובייקט זר **מדווח ואינו נמחק**, והמכסה אינה משתחררת:
       * איננו יודעים של מי הוא. */
      return { cleaned: false, reason: 'foreign-object', quota_released: false };
    }

    /**
     * **מה נחשב הוכחה — והפעם הרבה פחות** (seq550 §1).
     *
     * מחיקת הדור `G` מוכיחה ש-`G` נעלם. **היא אינה מוכיחה ששום
     * שמירה אינה עדיין בדרך.** התרחיש שנמסר לי:
     *
     *   ניסיון A נרשם ושמירתו מוחזקת ⇒ ניסיון B מחליף אותו, שומר
     *   `G`, והפרסום שלו נכשל ⇒ הניקוי מוחק את `G` ומשחרר מכסה ⇒
     *   **ועכשיו A מגיע לאחסון, מוצא נתיב פנוי, ויוצר `G2`.**
     *   ה-CAS ב-`markStored` דוחה את A — וזה נכון — אבל `G2` נשאר
     *   בעולם **בלי חיוב**.
     *
     * ולכן שחרור דורש **שתי עובדות יחד**:
     *   1. האובייקט נעלם — היעדר שנצפה, או מחיקה שאישרה הסרה.
     *   2. **מעולם לא נשלחו בייטים עבור הרשומה הזאת** — כלומר אין
     *      ואף פעם לא היה `attempt_id`, והמצב שממנו נתפס הוא
     *      `reserved`.
     *
     * כל השאר: **הניקוי מתבצע, והמכסה נשארת מחויבת.** לא שעון, לא
     * סימון זמני, ולא הסקה מדור שנמחק.
     *
     * **המחיר, ואני אומר אותו בקול:** רשומה ששלחה בייטים ולא הגיעה
     * ל-`ready` **תופסת סלוט לצמיתות**. זו התוצאה של הכלל, לא תופעת
     * לוואי שלו. **התאוששות דורשת חוזה נוסף** — הצעה בהמשך, ולא
     * מימוש חד-צדדי.
     */
    const noWriterEver = prior === 'reserved' && d.attempt_id == null;
    let removed = false;
    if (seen.present) {
      const gone = await storage.remove({ path: d.object_path, generation: seen.generation });
      removed = !!(gone && gone.removed);
    }
    const gonePath = seen.present ? removed : true;
    const proven = gonePath && noWriterEver;

    /* ---- 3 · שחרור, תחת CAS ---- */
    return db.runTransaction(async tx => {
      const cur = record(await tx.get(ref), { station_id: sid, attachment_id });
      if (!cur || cur.state !== 'cleaning' || cur.cleaning_operation_id !== operation_id) {
        return { cleaned: false, reason: 'claim-lost', quota_released: false };
      }
      if (!proven) {
        /* **האובייקט אולי הוסר, והמכסה בכל זאת נשארת מחויבת.**
         * כשהוסר — הדור נמחק מהרשומה, כדי שסבב הבא יקרא ללא נעיצה
         * ויגלה `G2` אם נוצר בינתיים. כשלא הוסר — חוזרים בדיוק למצב
         * שממנו נתפס, ורשומה עם דור ידוע אינה מאבדת אותו. */
        tx.set(ref, gonePath
          ? { state: 'stored_pending', object_generation: null,
            cleaning_operation_id: null, prior_state: null }
          : { state: prior, cleaning_operation_id: null, prior_state: null },
        { merge: true });
        return { cleaned: gonePath, reason: gonePath ? 'gone-still-charged' : 'uncertain',
          quota_released: false };
      }
      const lRef = ledgerRef(sid, cur.parent_kind, cur.parent_id);
      const ledger = ledgerOf(await tx.get(lRef));
      await beforeWrites('reconcile');
      const at = now();
      const next = ledgerRemove(ledger, attachment_id);
      tx.set(ref, {
        state: 'failed', failure_code: 'abandoned', failed_at_ms: at,
        cleaning_operation_id: null, prior_state: null, object_generation: null
      }, { merge: true });
      tx.set(lRef, {
        schema: LEDGER_SCHEMA, station_id: sid,
        parent_kind: cur.parent_kind, parent_id: cur.parent_id, entries: next.entries
      });
      return { cleaned: true, reason: 'abandoned', quota_released: next.changed };
    });
  }

  return Object.freeze({ reserve, upload, resume, download, list, reconcile });
}

module.exports = Object.freeze({
  createHrAttachments,
  decodeCanonical, signatureMatches,
  SCHEMA, OBJECT_SCHEMA, LEDGER_SCHEMA, STATES, PARENT_KINDS, FAILURE_CODES, TYPES,
  PAGE_SIZE, QUOTA_MAX, QUOTA_WINDOW_MS, PARENT_MAX_FILES, PARENT_MAX_BYTES,
  MAX_BYTES, MAX_BASE64, MAX_NAME, RESERVE_TTL_MS
});
