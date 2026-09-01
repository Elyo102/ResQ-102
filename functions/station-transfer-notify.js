'use strict';

/**
 * station-transfer-notify — תור ההתראות של העברת עובד בין תחנות.
 *
 * מודול טהור. אין Firebase, אין רשת, אין שעון פנימי ואין גיבוב
 * פנימי — הכל מוזרק. הוא **מתכנן** התראות ואינו שולח אף אחת.
 * החיווט, הכתיבה למסד והשליחה בפועל הם באחריות station-transfer.js.
 *
 * ─────────────────────────────────────────────────────────────
 * למה זה מודול נפרד ולא קוד בתוך station-transfer.js
 * ─────────────────────────────────────────────────────────────
 *
 * העברת עובד היא הפעולה היחידה במערכת שבה **הנמען מחליף תחנה
 * באמצע**. ההתראה נבנית כשהתחנה הישנה עדיין שלו, ונשלחת כשהיא
 * כבר לא. כל דבר שמניח „הנמען חבר בתחנה שממנה יצאה ההתראה"
 * נשבר כאן, ולכן ההיגיון הזה נכתב במקום אחד, נבדק בלי מסד,
 * ואפשר להוכיח עליו דברים.
 *
 * ─────────────────────────────────────────────────────────────
 * שלושת הדברים שהמודול הזה נועד למנוע
 * ─────────────────────────────────────────────────────────────
 *
 * 1. **התראה כפולה.** אישור שנלחץ פעמיים, ניסיון חוזר אחרי
 *    שגיאת רשת, או ריצת התאוששות — כולם מייצרים את אותו מעבר.
 *    dedupe_key יציב לכל שילוב של אירוע ונמען הופך כתיבה חוזרת
 *    לדריסה במקום להוספה.
 *
 * 2. **דליפת מידע בין שתי תחנות.** בקשת ההעברה נושאת שם מלא,
 *    מייל, טלפון ומספר עובד. אף אחד מהם אינו יוצא בהתראה, ולא
 *    ב-detail. תחנת היעד מקבלת „יש בקשה שממתינה לך" ולא כרטיס
 *    עובד — את הכרטיס היא מקבלת דרך הקריאה המורשית, אחרי
 *    שנבדקה הרשאתה.
 *
 * 3. **התראה שנשלחת לתחנה הלא נכונה.** לכל התראה יש
 *    delivery_station_id מפורש, ולא „התחנה של הבקשה". אחרי
 *    השלמה, ההתראה לעובד נמסרת תחת **תחנת היעד** — כי בתחנת
 *    המקור הוא כבר לא חבר, ובדיקת החברות החיה בשליחה תבטל
 *    אותה בצדק.
 */

class TransferNotifyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransferNotifyError';
    this.code = code;
  }
}

/** סוגי האירועים. אלה גם ערכי kind שיוצאים בהתראה. */
const EVENT = Object.freeze({
  OPENED: 'transfer_opened',
  APPROVED: 'transfer_approved',
  REJECTED: 'transfer_rejected',
  CANCELLED: 'transfer_cancelled',
  COMPLETED: 'transfer_completed',
  NEEDS_RECOVERY: 'transfer_needs_recovery'
});
const ALL_EVENTS = Object.freeze(Object.keys(EVENT).map((k) => EVENT[k]));

/** מיפוי מסטטוס הבקשה לאירוע. אין ברירת מחדל ואין ניחוש. */
const STATUS_EVENT = Object.freeze({
  pending_target: EVENT.OPENED,
  processing: EVENT.APPROVED,
  rejected: EVENT.REJECTED,
  cancelled: EVENT.CANCELLED,
  completed: EVENT.COMPLETED,
  needs_recovery: EVENT.NEEDS_RECOVERY
});

/**
 * שלושת הקהלים. „הנמען" אינו תמיד אדם: מבקרי תחנת היעד הם
 * תפקיד, כי רשימת האנשים דורשת שאילתה — ומודול טהור אינו שואל.
 */
const AUDIENCE = Object.freeze({
  SUBJECT: 'subject',                 // העובד עצמו
  SOURCE_HR: 'source_hr',             // רכז/ת תחנת המקור
  TARGET_REVIEWERS: 'target_reviewers'// רכז/ת ומפקד תחנת היעד
});

/** התפקידים שמאשרים בתחנת היעד. זהה ל-TARGET_APPROVERS בשירות. */
const TARGET_ROLES = Object.freeze(['hr_coordinator', 'station_commander']);

/**
 * מה מותר בהתראה שנוחתת על מסך נעילה.
 *
 * **request_id בלבד, ואפילו לא סוג האירוע.** העברת תחנה היא
 * מידע אישי לפני שהיא רשמית: „ההעברה שלך אושרה" על מסך נעילה
 * של טלפון שמונח על שולחן בחדר צוות מספר לכל מי שעובר שם.
 * הכותרת והגוף קבועים וזהים לכל האירועים, וסוג האירוע נקרא
 * רק אחרי פתיחת המסך.
 */
const PUSH_FIELDS = Object.freeze(['request_id']);

/** מפתחות שאסור שיופיעו בשום מקום בתוכנית — לא ב-push ולא ב-detail. */
const FORBIDDEN_KEYS = Object.freeze([
  'full_name', 'name', 'email', 'phone', 'employee_number', 'emp',
  'fingerprint', 'id_number', 'address', 'salary', 'created_by',
  'actorEmail', 'actor_email', 'token', 'claims'
]);

const LIMITS = Object.freeze({
  MAX_ATTEMPTS: 5,
  MAX_NOTIFICATIONS: 64,
  ID_MAX: 128
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return typeof v === 'string' ? v : ''; }
function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }

/**
 * יציבות מוחלטת של סדר המפתחות — הגיבוב חייב להיות זהה בין
 * הרצות, אחרת dedupe_key משתנה וכל ניסיון חוזר שולח מחדש.
 */
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * סורק רקורסיבית ומוודא שאין מפתח אסור ואין ערך שנראה כמו
 * מייל או טלפון. הבדיקה על **ערכים** ולא רק על שמות, כי מפתח
 * תמים יכול לשאת ערך שאינו תמים.
 */
function assertNoLeak(what, value) {
  const seen = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (plain(node)) {
      Object.keys(node).forEach((k) => {
        if (FORBIDDEN_KEYS.indexOf(k) !== -1) seen.push(k);
        walk(node[k]);
      });
      return;
    }
    if (typeof node === 'string') {
      if (/@/.test(node) && /\.[A-Za-z]{2,}/.test(node)) seen.push('ערך שנראה כמייל');
      if (/\d{2,3}-?\d{7}/.test(node)) seen.push('ערך שנראה כטלפון');
    }
  }(value));
  if (seen.length) {
    throw new TransferNotifyError('privacy-leak',
      what + ' מכיל מידע אסור: ' + seen.join(' · '));
  }
  return value;
}

function createTransferNotifier(deps) {
  const d = plain(deps) ? deps : {};

  const clock = d.clock;
  if (typeof clock !== 'function') {
    throw new TransferNotifyError('clock-required', 'חובה להזריק clock');
  }
  const hash = d.hash;
  if (typeof hash !== 'function') {
    throw new TransferNotifyError('hash-required', 'חובה להזריק hash');
  }
  const rules = plain(d.rules) ? d.rules : null;
  if (!rules) throw new TransferNotifyError('rules-required', 'חובה להזריק rules');

  const maxAttempts = rules.max_attempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > LIMITS.MAX_ATTEMPTS) {
    throw new TransferNotifyError('rules-attempts',
      'max_attempts חייב להיות מספר שלם בין 1 ל-' + LIMITS.MAX_ATTEMPTS);
  }
  const backoff = rules.retry_backoff_ms;
  if (!Array.isArray(backoff) || backoff.length < maxAttempts - 1
      || !backoff.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new TransferNotifyError('rules-backoff',
      'חובה להגדיר השהיה לכל ניסיון חוזר');
  }

  function digest(value) { return hash(stable(value)); }

  // ----------------------------------------------------------
  //  אימות הבקשה
  // ----------------------------------------------------------
  function assertRequest(request) {
    if (!plain(request)) {
      throw new TransferNotifyError('request-required', 'חובה למסור בקשת העברה');
    }
    const need = ['request_id', 'target_uid', 'source_station_id', 'target_station_id'];
    for (const key of need) {
      if (!nonEmpty(request[key])) {
        throw new TransferNotifyError('request-shape', 'לבקשה חסר ' + key);
      }
    }
    if (!ID_RE.test(request.request_id)) {
      throw new TransferNotifyError('request-id', 'מזהה בקשה אינו תקין');
    }
    // מזהה תחנה זהה בשני הצדדים אינו העברה — הוא תקלה שקטה
    // שהייתה מייצרת התראה על מעבר שלא קורה.
    if (str(request.source_station_id) === str(request.target_station_id)) {
      throw new TransferNotifyError('same-station',
        'תחנת המקור והיעד זהות — אין העברה');
    }
    return request;
  }

  /**
   * התחנה שתחתיה ההתראה נמסרת.
   *
   * זו הנקודה שבה מנגנון ההעברה שונה מכל השאר. בדיקת החברות
   * החיה בזמן השליחה שואלת „האם הנמען חבר פעיל בתחנה X" —
   * ולכן X חייבת להיות התחנה שבה הוא **יהיה** ברגע השליחה,
   * ולא זו שממנה יצאה הבקשה.
   *
   * אחרי השלמה, העובד כבר בתחנת היעד. התראה שתימסר תחת תחנת
   * המקור תבוטל בצדק על „recipient-not-member", והוא לא יידע
   * שההעברה הושלמה.
   */
  function deliveryStation(audience, event, request) {
    if (audience === AUDIENCE.TARGET_REVIEWERS) return request.target_station_id;
    if (audience === AUDIENCE.SOURCE_HR) return request.source_station_id;
    // הנבדק
    return event === EVENT.COMPLETED
      ? request.target_station_id
      : request.source_station_id;
  }

  /**
   * מי מקבל מה, לכל אירוע.
   *
   * הכלל: **מי שביצע את הפעולה אינו מקבל עליה התראה.** רכזת
   * שפתחה בקשה יודעת שפתחה אותה; התראה אליה היא רעש שמלמד
   * להתעלם מהתראות.
   */
  function audiencesFor(event) {
    switch (event) {
      case EVENT.OPENED:
        return [AUDIENCE.SUBJECT, AUDIENCE.TARGET_REVIEWERS];
      case EVENT.APPROVED:
        return [AUDIENCE.SUBJECT, AUDIENCE.SOURCE_HR];
      case EVENT.REJECTED:
        return [AUDIENCE.SUBJECT, AUDIENCE.SOURCE_HR];
      case EVENT.CANCELLED:
        return [AUDIENCE.TARGET_REVIEWERS];
      case EVENT.COMPLETED:
        return [AUDIENCE.SUBJECT, AUDIENCE.SOURCE_HR, AUDIENCE.TARGET_REVIEWERS];
      case EVENT.NEEDS_RECOVERY:
        // לא לעובד. „ההעברה שלך תקועה" אינו מידע שהוא יכול
        // לפעול לפיו, והוא מייצר פנייה לרכזת על משהו שכבר
        // מטופל. שתי הרכזות מקבלות, כי אחת מהן תצטרך להריץ
        // התאוששות.
        return [AUDIENCE.SOURCE_HR, AUDIENCE.TARGET_REVIEWERS];
      default:
        throw new TransferNotifyError('event-unknown', 'אירוע לא מוכר: ' + event);
    }
  }

  /**
   * ה-detail הוא **רשימה סגורה לכל קהל**, ולא סינון של הבקשה.
   *
   * ההבדל מהותי: סינון שוכח שדה חדש שנוסף לבקשה, רשימה סגורה
   * לא מכירה אותו מלכתחילה. `station-transfer.js` יכול להוסיף
   * שדות למסמך הבקשה בלי שאיש יזכור לעדכן כאן, ושום דבר לא
   * ידלוף.
   */
  function detailFor(audience, event, request) {
    const base = {
      kind: event,
      request_id: request.request_id,
      revision: Number(request.revision || 1)
    };
    if (audience === AUDIENCE.SUBJECT) {
      // העובד רשאי לדעת לאן הוא עובר. זה המידע שלו.
      return Object.assign(base, {
        from_station_id: request.source_station_id,
        to_station_id: request.target_station_id
      });
    }
    if (audience === AUDIENCE.SOURCE_HR) {
      // כרטיס העובד כבר אצלה. מספיק המזהה כדי לפתוח אותו.
      return Object.assign(base, {
        target_uid: request.target_uid,
        to_station_id: request.target_station_id
      });
    }
    // מבקרי היעד — **בלי מזהה העובד ובלי שמו.** הם מקבלים „יש
    // בקשה שממתינה", ואת הכרטיס דרך הקריאה המורשית שבודקת את
    // הרשאתם. התראה אינה מקום להעביר בו זהות של אדם שעדיין
    // אינו שייך לתחנה.
    return Object.assign(base, {
      from_station_id: request.source_station_id
    });
  }

  /**
   * גוף ההתראה — **קבוע וזהה לכל האירועים ולכל הקהלים.**
   * ראה את ההערה על PUSH_FIELDS.
   */
  function pushFor(request) {
    return Object.freeze({
      title: 'ResQ',
      body: 'יש עדכון שממתין לך',
      route: 'transfers',
      request_id: request.request_id
    });
  }

  function recipientRef(audience, request) {
    if (audience === AUDIENCE.SUBJECT) return 'uid:' + request.target_uid;
    if (audience === AUDIENCE.SOURCE_HR) return 'role:' + request.source_station_id + ':hr_coordinator';
    return 'role:' + request.target_station_id + ':' + TARGET_ROLES.join('+');
  }

  /**
   * מתכנן את כל ההתראות של מעבר מצב אחד.
   *
   * אטומיות: התוכנית כולה נבנית לפני שנכתב דבר, ומזהה האירוע
   * יחד עם גיבוב התוכן קובע אם זו חזרה. הכותב אמור לכתוב את
   * כל ההתראות ואת מסמך האירוע **בעסקה אחת**.
   */
  function planTransition(input) {
    const inp = plain(input) ? input : {};
    const request = assertRequest(inp.request);

    const status = str(inp.to_status || request.status);
    if (!Object.prototype.hasOwnProperty.call(STATUS_EVENT, status)) {
      throw new TransferNotifyError('status-unknown', 'סטטוס לא מוכר: ' + status);
    }
    const event = STATUS_EVENT[status];

    const eventId = str(inp.event_id);
    if (!ID_RE.test(eventId)) {
      throw new TransferNotifyError('event-id', 'חובה למסור מזהה אירוע תקין');
    }
    const actorUid = str(inp.actor_uid);
    const at = clock();

    const contentHash = digest({
      v: 1,
      event: event,
      request_id: request.request_id,
      revision: Number(request.revision || 1),
      target_uid: request.target_uid,
      source: request.source_station_id,
      target: request.target_station_id
    });

    // ------- כפילות -------
    // אותו מזהה אירוע ואותו תוכן: חזרה. אפס התראות, בלי שגיאה.
    // אותו מזהה ותוכן אחר: התנגשות רועשת. שני מעברים שונים
    // שקיבלו אותו מזהה הם באג, ובליעה שקטה שלו תסתיר אותו.
    const existing = plain(inp.existing_event) ? inp.existing_event : null;
    if (existing) {
      if (str(existing.event_id) !== eventId) {
        throw new TransferNotifyError('event-mismatch',
          'מסמך האירוע שנמסר אינו של המזהה הזה');
      }
      if (str(existing.content_hash) === contentHash) {
        return Object.freeze({
          kind: 'transfer-notification-plan',
          duplicate: true,
          event: existing,
          notifications: Object.freeze([]),
          audit: Object.freeze({ kind: 'transfer-notify-duplicate', event_id: eventId, at: at })
        });
      }
      throw new TransferNotifyError('transfer-event-conflict',
        'מזהה האירוע כבר קיים עם תוכן אחר');
    }

    // ------- בנייה -------
    const audiences = audiencesFor(event)
      // מי שביצע — אינו מקבל. רלוונטי כשהעובד עצמו הוא המבצע,
      // וכשרכזת מבטלת בקשה שהיא פתחה.
      .filter((a) => !(a === AUDIENCE.SUBJECT && actorUid &&
                       actorUid === str(request.target_uid)));

    const notifications = audiences.map((audience) => {
      const detail = assertNoLeak('detail', detailFor(audience, event, request));
      const push = assertNoLeak('push', pushFor(request));
      const ref = recipientRef(audience, request);
      return Object.freeze({
        kind: 'transfer-notification-plan',
        dedupe_key: eventId + ':' + ref + ':' + contentHash,
        event_id: eventId,
        event: event,
        request_id: request.request_id,
        revision: Number(request.revision || 1),
        audience: audience,
        recipient_kind: audience === AUDIENCE.SUBJECT ? 'uid' : 'role',
        recipient_uid: audience === AUDIENCE.SUBJECT ? request.target_uid : null,
        recipient_roles: audience === AUDIENCE.SUBJECT ? null
          : (audience === AUDIENCE.SOURCE_HR ? Object.freeze(['hr_coordinator']) : TARGET_ROLES),
        /** התחנה שתחתיה נבדקת החברות בזמן השליחה. ראה deliveryStation. */
        delivery_station_id: deliveryStation(audience, event, request),
        push: push,
        detail: Object.freeze(detail),
        attempt: 0,
        status: 'queued',
        created_at: at,
        created_by: actorUid || null
      });
    });

    if (notifications.length > LIMITS.MAX_NOTIFICATIONS) {
      throw new TransferNotifyError('too-many', 'יותר מדי התראות למעבר אחד');
    }

    // מפתחות דדופליקציה ייחודיים — שני נמענים שמקבלים אותו
    // מפתח פירושו שאחד מהם ידרוס את השני ולא יקבל כלום.
    const keys = notifications.map((n) => n.dedupe_key);
    if (new Set(keys).size !== keys.length) {
      throw new TransferNotifyError('dedupe-collision',
        'שתי התראות קיבלו אותו מפתח דדופליקציה');
    }

    return Object.freeze({
      kind: 'transfer-notification-plan',
      duplicate: false,
      event: Object.freeze({
        event_id: eventId,
        kind: event,
        request_id: request.request_id,
        revision: Number(request.revision || 1),
        content_hash: contentHash,
        created_at: at,
        created_by: actorUid || null,
        notification_count: notifications.length
      }),
      notifications: Object.freeze(notifications),
      audit: Object.freeze({
        kind: 'transfer-notify',
        event_id: eventId,
        event: event,
        request_id: request.request_id,
        at: at,
        by: actorUid || null,
        recipients: Object.freeze(notifications.map((n) => n.audience))
      })
    });
  }

  /**
   * ניסיון חוזר.
   *
   * כישלון בשליחה **אינו מבטל את ההעברה**. ההעברה קרתה; מה
   * שנכשל הוא הידיעה עליה. לכן transfer_still_valid תמיד true,
   * ואחרי מיצוי הניסיונות ההתראה עוברת ל-dead_letter ולא
   * ללולאה אינסופית.
   */
  function planRetry(input) {
    const inp = plain(input) ? input : {};
    const n = plain(inp.notification) ? inp.notification : null;
    if (!n) throw new TransferNotifyError('notification-required', 'חובה למסור התראה');
    const attempt = Number(n.attempt || 0) + 1;
    const code = str(inp.error_code) || 'SEND_FAILED';
    const at = clock();
    const dead = attempt >= maxAttempts;
    const waitMs = dead ? null : backoff[Math.min(attempt - 1, backoff.length - 1)];
    return Object.freeze({
      kind: 'transfer-notification-retry',
      dedupe_key: n.dedupe_key,
      status: dead ? 'dead_letter' : 'retry',
      attempt: attempt,
      max_attempts: maxAttempts,
      next_attempt_at: dead ? null : new Date(Date.parse(at) + waitMs).toISOString(),
      last_error: code,
      transfer_still_valid: true,
      at: at
    });
  }

  function summarize(list) {
    const rows = Array.isArray(list) ? list : [];
    const byStatus = {};
    rows.forEach((n) => {
      const s = str(n && n.status) || 'unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
    });
    const keys = rows.map((n) => str(n && n.dedupe_key));
    return Object.freeze({
      total: rows.length,
      unique_keys: new Set(keys).size,
      duplicates_ignored: rows.length - new Set(keys).size,
      by_status: Object.freeze(byStatus),
      dead_letters: byStatus.dead_letter || 0
    });
  }

  return Object.freeze({
    planTransition,
    planRetry,
    summarize,
    EVENT, AUDIENCE, STATUS_EVENT, PUSH_FIELDS, TARGET_ROLES, LIMITS
  });
}

module.exports = Object.freeze({
  createTransferNotifier,
  TransferNotifyError,
  EVENT,
  ALL_EVENTS,
  STATUS_EVENT,
  AUDIENCE,
  TARGET_ROLES,
  PUSH_FIELDS,
  FORBIDDEN_KEYS,
  LIMITS
});
