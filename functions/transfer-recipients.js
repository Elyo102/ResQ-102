'use strict';

/* ====================================================================
 *  transfer-recipients — הפיכת „מבקרי היעד" מ**תפקיד** לרשימת
 *  נמענים אמיתית, מתוך צילומי סגל חיים.
 *
 *  מודול טהור. אין Firebase, אין רשת, אין תאריך מערכת.
 *  **מכריע ואינו שולח.**
 *
 *  --------------------------------------------------------------
 *  למה זה קיים · חסם 2 של Codex
 *  --------------------------------------------------------------
 *
 *  station-transfer-notify מחזיר `recipient_kind: 'role'` עם
 *  `recipient_roles: ['hr_coordinator','station_commander']`,
 *  כי מודול טהור אינו שואל שאילתות. ההחרגה של המבצע שם חלה על
 *  **נושא ההעברה בלבד**. שתי תוצאות:
 *
 *    רכזת שפתחה בקשה בעצמה מקבלת עליה התראה
 *    אדם שהוא גם רכזת וגם מפקד תחנה מקבל אותה פעמיים
 *
 *  שתיהן מלמדות להתעלם מהתראות, וזו התקלה שקשה הכי הרבה לתקן
 *  אחר כך: אי אפשר לבטל את ההרגל.
 *
 *  --------------------------------------------------------------
 *  ⭐ שלושה כללים שקובעים את התכן
 *  --------------------------------------------------------------
 *
 *  **1 · צילומים חיים בלבד.** התפקיד נלקח ממסמך הסגל החי ולא
 *  מ-claims של טוקן. טוקן נחתם בעבר; אדם שהוסר מתפקידו לפני
 *  חמש דקות עדיין נושא אותו. ההתראה הולכת לפי מה שנכון עכשיו.
 *
 *  **2 · אפס נמענים אינו מפיל את ההעברה.** תחנה בלי רכזת ובלי
 *  מפקד פעיל היא מצב אפשרי — במיוחד בתחנה קטנה, ובמיוחד בלילה.
 *  ההעברה קרתה; מה שלא קרה הוא היידוע. מחזיר רשימה ריקה עם
 *  אזהרה, לא שגיאה.
 *
 *  **3 · המבצע והנושא מוחרגים מכל קבוצת תפקיד.** לא רק הנושא.
 *  רכזת יודעת מה היא עשתה לפני שנייה.
 *
 *  --------------------------------------------------------------
 *  פרטיות
 *  --------------------------------------------------------------
 *
 *  התוצאה היא **רשימת UID בלבד**. לא שם, לא מייל, לא טלפון,
 *  לא מספר עובד, ולא התפקיד שבזכותו האדם נבחר — „למה קיבלתי
 *  את זה" אינו מידע שההתראה צריכה לשאת, והוא מסגיר את מבנה
 *  הפיקוד של תחנה זרה למי שיקרא את התור.
 * ==================================================================== */

const SCHEMA_VERSION = 1;

/* התפקידים שרשאים לבקר בקשת העברה ביעד.
 * זהה ל-TARGET_APPROVERS, ובמכוון קפוא: הרחבת קהל התראות
 * לאנשים נוספים אינה משתמעת משום שינוי אחר, והיא דורשת
 * הכרעה אנושית מפורשת. */
const REVIEWER_ROLES = Object.freeze(['hr_coordinator', 'station_commander']);

const LIMITS = Object.freeze({
  MAX_ROSTER: 5000,
  MAX_RECIPIENTS: 50
});

const CODE = Object.freeze({
  SHAPE: 'recipients-shape',
  ROLE_UNKNOWN: 'recipients-role-unknown',
  TOO_MANY: 'recipients-too-many',
  LEAK: 'recipients-leak'
});

const REASON = Object.freeze({
  NOT_MEMBER: 'not-a-member-of-the-station',
  INACTIVE: 'inactive',
  ROLE_NOT_REVIEWER: 'role-is-not-a-reviewer',
  IS_ACTOR: 'is-the-actor',
  IS_SUBJECT: 'is-the-subject',
  DUPLICATE: 'already-included'
});

const WARN = Object.freeze({
  NO_RECIPIENTS: 'no-live-reviewer-at-the-target-station',
  ONLY_ACTOR: 'the-only-reviewer-is-the-actor'
});

class RecipientsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecipientsError';
    this.code = code;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

const FORBIDDEN_KEYS = Object.freeze([
  'full_name', 'name', 'display_name', 'email', 'mail',
  'phone', 'mobile', 'tel', 'emp', 'emp_number', 'role', 'roles'
]);
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(?:^|\D)(?:0\d{1,2}[- ]?\d{7}|\+972\d{8,9})(?:\D|$)/;
const HEB_NAME_RE = /[֐-׿]{2,}\s+[֐-׿]{2,}/;

function assertNoLeak(value, path) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) throw new RecipientsError(CODE.LEAK, 'מייל ב-' + path);
    if (PHONE_RE.test(value)) throw new RecipientsError(CODE.LEAK, 'טלפון ב-' + path);
    if (HEB_NAME_RE.test(value)) throw new RecipientsError(CODE.LEAK, 'שם ב-' + path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoLeak(v, path + '[' + i + ']'));
    return;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.indexOf(k) !== -1) {
        throw new RecipientsError(CODE.LEAK, 'שדה אסור ' + k + ' ב-' + path);
      }
      assertNoLeak(value[k], path + '.' + k);
    }
  }
}

/**
 * התפקידים שאדם מחזיק בפועל. תומך גם ב-`role` יחיד וגם
 * ב-`roles[]`, כי שני הצורות קיימות בסגל, ואדם שנושא את
 * שתיהן נספר **פעם אחת** — זו בדיוק הכפילות מחסם 2.
 */
function rolesOf(user) {
  const out = new Set();
  if (isNonEmptyString(user.role)) out.add(user.role);
  if (Array.isArray(user.roles)) {
    for (const r of user.roles) if (isNonEmptyString(r)) out.add(r);
  }
  return out;
}

function createRecipientResolver(deps) {
  const d = deps || {};
  if (typeof d.clock !== 'function') {
    throw new RecipientsError(CODE.SHAPE, 'חובה להזריק clock');
  }
  const clock = d.clock;

  /**
   * @param {object} input
   *   station_id   תחנת היעד
   *   roster       [{uid, station_id, active, role|roles[]}] — צילומים חיים
   *   actor_uid    מי ביצע את הפעולה
   *   subject_uid  מי מועבר
   *   roles        רשות; ברירת מחדל REVIEWER_ROLES
   *
   * @returns {{recipients:string[], excluded:[{uid,reason}], warnings, audit}}
   */
  function resolveReviewers(input) {
    if (!isPlainObject(input)) throw new RecipientsError(CODE.SHAPE, 'קלט לא תקין');
    const sid = input.station_id;
    if (!isNonEmptyString(sid)) {
      throw new RecipientsError(CODE.SHAPE, 'חסרה תחנת יעד');
    }
    const roster = Array.isArray(input.roster) ? input.roster : null;
    if (!roster) throw new RecipientsError(CODE.SHAPE, 'חובה למסור צילום סגל, גם ריק');
    if (roster.length > LIMITS.MAX_ROSTER) {
      throw new RecipientsError(CODE.TOO_MANY, 'הסגל גדול מהמותר');
    }

    let wanted = REVIEWER_ROLES;
    if (input.roles !== undefined && input.roles !== null) {
      if (!Array.isArray(input.roles) || !input.roles.length) {
        throw new RecipientsError(CODE.SHAPE, 'רשימת תפקידים לא תקינה');
      }
      for (const r of input.roles) {
        // ⭐ הרחבת קהל אינה משתמעת. תפקיד שאינו ברשימה הקפואה
        // נדחה, גם אם המחווט ביקש אותו במפורש.
        if (REVIEWER_ROLES.indexOf(r) === -1) {
          throw new RecipientsError(CODE.ROLE_UNKNOWN,
            'התפקיד ' + String(r) + ' אינו מבקר מוכר. הרחבת קהל '
            + 'התראות דורשת הכרעה אנושית ואינה משתמעת.');
        }
      }
      wanted = Object.freeze(input.roles.slice());
    }

    const actor = isNonEmptyString(input.actor_uid) ? input.actor_uid : null;
    const subject = isNonEmptyString(input.subject_uid) ? input.subject_uid : null;

    const recipients = [];
    const excluded = [];
    const seen = new Set();
    let reviewerSeenAtAll = false;

    for (const raw of roster) {
      if (!isPlainObject(raw) || !isNonEmptyString(raw.uid)) {
        throw new RecipientsError(CODE.SHAPE, 'רשומת סגל אינה תקינה');
      }
      const uid = raw.uid;

      // סדר הבדיקות הוא סדר הדיווח, ולכן קבוע: שיוך, פעילות,
      // תפקיד, ורק אז זהות. „הוחרג כי הוא המבצע" על אדם שאינו
      // בכלל בתחנה הוא דיווח מטעה.
      if (raw.station_id !== sid) { excluded.push({ uid, reason: REASON.NOT_MEMBER }); continue; }
      if (raw.active !== true) { excluded.push({ uid, reason: REASON.INACTIVE }); continue; }

      const held = rolesOf(raw);
      const isReviewer = wanted.some((r) => held.has(r));
      if (!isReviewer) { excluded.push({ uid, reason: REASON.ROLE_NOT_REVIEWER }); continue; }
      reviewerSeenAtAll = true;

      if (actor && uid === actor) { excluded.push({ uid, reason: REASON.IS_ACTOR }); continue; }
      if (subject && uid === subject) { excluded.push({ uid, reason: REASON.IS_SUBJECT }); continue; }

      // ⭐ ניכוי כפילויות לפי UID. אדם שהוא גם רכזת וגם מפקד
      // תחנה מופיע פעם אחת. וגם סגל שנמסר עם שורה כפולה.
      if (seen.has(uid)) { excluded.push({ uid, reason: REASON.DUPLICATE }); continue; }
      seen.add(uid);
      recipients.push(uid);
    }

    recipients.sort();
    excluded.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

    if (recipients.length > LIMITS.MAX_RECIPIENTS) {
      throw new RecipientsError(CODE.TOO_MANY, 'יותר מדי נמענים לתחנה אחת');
    }

    const warnings = [];
    if (!recipients.length) {
      // ⭐ אינו שגיאה. ראה כלל 2 בראש הקובץ.
      warnings.push({ code: WARN.NO_RECIPIENTS });
      if (reviewerSeenAtAll && actor) warnings.push({ code: WARN.ONLY_ACTOR });
    }

    const out = {
      schema_version: SCHEMA_VERSION,
      station_id: sid,
      recipients,          // UID בלבד
      excluded,            // UID + קוד סיבה ניטרלי בלבד
      warnings,
      transfer_still_valid: true,
      audit: {
        at: new Date(clock()).toISOString(),
        roster_size: roster.length,
        matched: recipients.length,
        // התפקידים שנשאלו — לא התפקיד שבזכותו כל אדם נבחר.
        // השם אינו `roles` במכוון: assertNoLeak חוסם את המפתח
        // הזה, וזה נכון — הוא נועד לתפוס תפקיד **של אדם**.
        // חריג בסורק היה פותח פרצה; שם מדויק יותר סוגר אותה.
        roles_queried: wanted.slice()
      }
    };

    assertNoLeak(out, 'recipients');
    return Object.freeze(out);
  }

  /**
   * האם נמען עדיין ראוי לקבל, ברגע השליחה עצמה.
   *
   * ⭐ נדרש כי בין ההכרעה לשליחה יכולות לעבור דקות: אדם מסיים
   * תפקיד, עוזב תחנה או מושבת. שליחה לפי הכרעה ישנה היא בדיוק
   * אותה תקלה שבדיקת החברות ב-deliverOutbox נועדה לסגור.
   */
  function stillEligible(input) {
    if (!isPlainObject(input)) throw new RecipientsError(CODE.SHAPE, 'קלט לא תקין');
    const sid = input.station_id;
    const uid = input.uid;
    if (!isNonEmptyString(sid) || !isNonEmptyString(uid)) {
      throw new RecipientsError(CODE.SHAPE, 'חסרים תחנה או מזהה');
    }
    const live = input.live_user;
    if (!isPlainObject(live) || live.exists !== true || !isPlainObject(live.data)) {
      return { eligible: false, reason: REASON.NOT_MEMBER };
    }
    const user = live.data;
    if (user.station_id !== sid) return { eligible: false, reason: REASON.NOT_MEMBER };
    if (user.active !== true) return { eligible: false, reason: REASON.INACTIVE };
    const held = rolesOf(user);
    if (!REVIEWER_ROLES.some((r) => held.has(r))) {
      return { eligible: false, reason: REASON.ROLE_NOT_REVIEWER };
    }
    if (isNonEmptyString(input.actor_uid) && uid === input.actor_uid) {
      return { eligible: false, reason: REASON.IS_ACTOR };
    }
    if (isNonEmptyString(input.subject_uid) && uid === input.subject_uid) {
      return { eligible: false, reason: REASON.IS_SUBJECT };
    }
    return { eligible: true, reason: null };
  }

  return Object.freeze({
    resolveReviewers, stillEligible, assertNoLeak,
    SCHEMA_VERSION, REVIEWER_ROLES, LIMITS, CODE, REASON, WARN
  });
}

module.exports = {
  createRecipientResolver, RecipientsError, assertNoLeak,
  SCHEMA_VERSION, REVIEWER_ROLES, LIMITS, CODE, REASON, WARN
};
