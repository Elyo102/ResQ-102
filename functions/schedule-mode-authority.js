'use strict';

/* ====================================================================
 *  schedule-mode-authority — מי מורשה להזיז את מצב מנוע הסידור,
 *  ולאן מותר להזיז אותו.
 *
 *  מודול טהור. אין Firebase, אין רשת, אין תאריך מערכת.
 *
 *  --------------------------------------------------------------
 *  ההכרעה שהמודול הזה מיישם
 *  --------------------------------------------------------------
 *
 *  ⭐ **הרשאת עריכה אינה הרשאת הפעלה.**
 *
 *  `schedule_manager` הוא מינוי תפעולי: לערוך, לשבץ, להריץ מנוע
 *  ולפרסם סידור. הוא **אינו** מאפשר להזיז את מצב המנוע. הזזת מצב
 *  משנה את מה שכל התחנה רואה — היא שייכת לפיקוד.
 *
 *  לכן `manager: true` בקלט אינו משתתף בהחלטה כאן בכלל, ויש בדיקה
 *  שמוודאת שהוא לא ישתחל אליה בעתיד.
 *
 *  --------------------------------------------------------------
 *  למה יש מסלול מעברים ולא סתם „קבע מצב"
 *  --------------------------------------------------------------
 *
 *  `off → new` **אסור**. זה לא קפדנות: מצב `shadow` הוא המקום
 *  היחיד שבו אפשר לראות מה המנוע החדש היה מייצר בלי שאיש יקבל
 *  הודעה ובלי שסידור פעיל ישתנה. קפיצה ישירה ל-`new` פירושה
 *  שהפעם הראשונה שמישהו רואה את התוצאה של המנוע היא הפעם
 *  הראשונה שהיא גם הסידור שלו.
 *
 *  ⭐ `shadow → new` **קיים** — אבל לא דרך מתג המצב. `setRuntimeMode`
 *  דוחה אותו ב-`cutover-required`; המסלול היחיד הוא `promoteToNew`,
 *  שמפעיל פרסום מוכן, מאמת דוח preflight חתום, ומזיז את המצב באותה
 *  עסקה. המעבר נשלח בשחרור הזה **בנוי ואינרטי** — הכרעת אלדד
 *  (3.9.2026): „אתם תבנו את הכול, שכל מה שיישאר לי זה להרים את המתג".
 *
 *  --------------------------------------------------------------
 *  כיבוי תמיד מותר
 *  --------------------------------------------------------------
 *
 *  ⭐ מעבר ל-`off` **אינו** דורש מוכנות ואינו דורש שדבר יהיה תקין.
 *  מתג חירום שדורש שהמערכת תהיה במצב טוב כדי לפעול אינו מתג
 *  חירום. הוא נדרש לאישור מפורש ולתיעוד, ותו לא.
 * ==================================================================== */

const MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', NEW: 'new' });
const MODES = Object.freeze([MODE.OFF, MODE.SHADOW, MODE.NEW]);

/**
 * התפקידים שרשאים להזיז את מצב המנוע.
 *
 * ⭐ `station_commander` **אינו** ברשימה, וזו הכרעה מפורשת שהתקבלה
 * ולא השמטה. מי שמפקד על התחנה אינו בהכרח מי שמחליט מתי מנוע
 * הסידור מחליף את הסידור של כולם.
 *
 * ⭐ ומנהל-על נקבע מ-`super: true` בלבד — הדגל שהשרת מחשב מזהות
 * מאומתת. **מחרוזת תפקיד `super_admin` אינה מספיקה**, כי תפקיד הוא
 * שדה בפרופיל, ופרופיל אינו הוכחת זהות.
 */
const AUTHORITY_ROLES = Object.freeze(['commander', 'deputy']);

// מעבר שאינו כאן — אסור. הרשימה סגורה, לא מסננת.
const TRANSITIONS = Object.freeze([
  Object.freeze({ from: MODE.OFF, to: MODE.SHADOW, kind: 'enable_shadow' }),
  Object.freeze({ from: MODE.SHADOW, to: MODE.NEW, kind: 'promote' }),
  Object.freeze({ from: MODE.NEW, to: MODE.SHADOW, kind: 'demote' }),
  Object.freeze({ from: MODE.SHADOW, to: MODE.OFF, kind: 'disable' }),
  Object.freeze({ from: MODE.NEW, to: MODE.OFF, kind: 'disable' })
]);

const REASONS = Object.freeze([
  'initial_activation', 'validation_complete', 'validation_failed',
  'operational_safety', 'configuration_error', 'other'
]);

const CODE = Object.freeze({
  SHAPE: 'mode-input',
  MODE_INVALID: 'mode-invalid',
  FORBIDDEN: 'mode-authority-forbidden',
  TRANSITION_FORBIDDEN: 'mode-transition-forbidden',
  CONFIRMATION: 'mode-confirmation-required',
  REASON: 'mode-reason-required',
  NOT_READY: 'mode-not-ready'
});

class ModeAuthorityError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ModeAuthorityError';
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
  throw new ModeAuthorityError(code, message, detail);
}

const MODE_LABEL = Object.freeze({
  off: 'כבוי',
  shadow: 'בדיקה',
  new: 'פעיל'
});

/**
 * ⭐ מי רשאי. שלושה מקורות, ולא ארבעה.
 *
 * מנהל-על, `commander`, `deputy`. מינוי אחראי סידור אינו נחשב כאן
 * ואינו נקרא — הוא אפילו לא נגזר מהקלט.
 */
function mayChangeMode(actor) {
  if (!isPlainObject(actor)) return false;
  if (actor.super === true) return true;
  return AUTHORITY_ROLES.indexOf(String(actor.role || '')) !== -1;
}

function transitionFor(from, to) {
  for (const item of TRANSITIONS) {
    if (item.from === from && item.to === to) return item;
  }
  return null;
}

function createModeAuthority() {
  /**
   * @param {object} input
   *   current       המצב כפי שהוא בשרת עכשיו
   *   target        המצב המבוקש
   *   actor         { uid, role, super, manager }
   *   confirmation  מחרוזת המצב המבוקש, כפי שאדם הקליד
   *   reason_code   מתוך REASONS
   *   readiness     { policy:boolean, source:boolean, people:number }
   *
   * @returns {{kind, from, to, transition, audit}}
   */
  function planModeChange(input) {
    if (!isPlainObject(input)) fail(CODE.SHAPE, 'קלט לא תקין');

    const current = String(input.current || '');
    const target = String(input.target || '');
    if (MODES.indexOf(current) === -1) {
      fail(CODE.MODE_INVALID, 'המצב הנוכחי אינו מוכר: ' + JSON.stringify(input.current));
    }
    if (MODES.indexOf(target) === -1) {
      fail(CODE.MODE_INVALID, 'המצב המבוקש אינו מוכר. המצבים הם: ' + MODES.join(', ') + '.');
    }

    // ⭐ ההרשאה נבדקת ראשונה, לפני כל דבר אחר. מי שאינו רשאי אינו
    // אמור ללמוד מהודעת השגיאה מה חסר או מה מותר.
    const actor = isPlainObject(input.actor) ? input.actor : {};
    if (!mayChangeMode(actor)) {
      fail(CODE.FORBIDDEN,
        'שינוי מצב מנוע הסידור מותר לפיקוד התחנה בלבד. '
        + 'מינוי אחראי/ת סידור אינו כולל את ההרשאה הזאת.');
    }

    if (current === target) {
      return Object.freeze({
        kind: 'unchanged',
        from: current, to: target, transition: null,
        audit: Object.freeze({
          actor_uid: isNonEmptyString(actor.uid) ? actor.uid : null,
          actor_role: isNonEmptyString(actor.role) ? actor.role : null,
          by_super: actor.super === true,
          from: current, to: target, reason_code: null, transition: null
        })
      });
    }

    const transition = transitionFor(current, target);
    if (!transition) {
      const hint = current === MODE.OFF && target === MODE.NEW
        ? ' אי אפשר לעבור מכבוי ישירות לפעיל: מצב הבדיקה הוא המקום היחיד שבו '
          + 'אפשר לראות מה המנוע היה מייצר בלי שאיש יקבל הודעה.'
        : '';
      fail(CODE.TRANSITION_FORBIDDEN,
        'מעבר מ„' + (MODE_LABEL[current] || current) + '" ל„'
        + (MODE_LABEL[target] || target) + '" אינו מותר.' + hint,
        { from: current, to: target });
    }

    // ⭐ אישור בהקלדה, ולא סימון. סימון הוא לחיצה אחת מיותרת;
    // הקלדת המצב המבוקש היא פעולה שאי אפשר לעשות בטעות, והיא
    // גם מה שהופך את התיעוד למשמעותי.
    if (input.confirmation !== target) {
      fail(CODE.CONFIRMATION,
        'כדי לשנות את מצב המנוע יש להקליד את שם המצב המבוקש: ' + target + '.');
    }

    if (!isNonEmptyString(input.reason_code) || REASONS.indexOf(input.reason_code) === -1) {
      fail(CODE.REASON,
        'חובה לציין סיבה מתוך הרשימה: ' + REASONS.join(', ') + '.');
    }

    // ⭐ כיבוי אינו דורש מוכנות. מתג חירום שדורש שהמערכת תהיה
    // תקינה כדי לפעול אינו מתג חירום.
    if (target !== MODE.OFF) {
      const readiness = isPlainObject(input.readiness) ? input.readiness : {};
      const missing = [];
      if (readiness.policy !== true) missing.push('policy');
      if (readiness.source !== true) missing.push('source');
      if (!(typeof readiness.people === 'number' && readiness.people > 0)) missing.push('people');
      if (missing.length) {
        fail(CODE.NOT_READY,
          'אי אפשר להפעיל את המנוע לפני שהוגדרו: '
          + missing.map((item) => ({
            policy: 'חוקי תחנה', source: 'מקור כוח-אדם חתום', people: 'אנשים במקור'
          }[item])).join(', ') + '.',
          { missing });
      }
    }

    return Object.freeze({
      kind: 'change',
      from: current,
      to: target,
      transition: transition.kind,
      audit: Object.freeze({
        actor_uid: isNonEmptyString(actor.uid) ? actor.uid : null,
        actor_role: isNonEmptyString(actor.role) ? actor.role : null,
        by_super: actor.super === true,
        from: current,
        to: target,
        transition: transition.kind,
        reason_code: input.reason_code
      })
    });
  }

  /**
   * מה המסך רשאי להציע. הוא אינו מחליט — הוא רק לא מציע דלת
   * שתיטרק, וגם לא מסתיר שהיא קיימת.
   */
  function options(input) {
    const inp = isPlainObject(input) ? input : {};
    const current = MODES.indexOf(String(inp.current || '')) !== -1
      ? String(inp.current) : null;
    const actor = isPlainObject(inp.actor) ? inp.actor : {};
    const allowed = mayChangeMode(actor);
    const readiness = isPlainObject(inp.readiness) ? inp.readiness : {};
    const ready = readiness.policy === true && readiness.source === true
      && typeof readiness.people === 'number' && readiness.people > 0;
    return Object.freeze({
      may_change: allowed,
      current,
      ready,
      targets: Object.freeze(current === null ? [] : TRANSITIONS
        .filter((item) => item.from === current)
        .map((item) => Object.freeze({
          to: item.to,
          kind: item.kind,
          label: MODE_LABEL[item.to] || item.to,
          // כיבוי זמין תמיד; הפעלה זמינה רק כשיש מה להריץ.
          available: allowed && (item.to === MODE.OFF || ready),
          blocked_by: allowed
            ? (item.to === MODE.OFF || ready ? null : 'not_ready')
            : 'forbidden'
        })))
    });
  }

  return Object.freeze({
    planModeChange, options, mayChangeMode,
    MODE, MODES, TRANSITIONS, REASONS, AUTHORITY_ROLES, CODE
  });
}

module.exports = {
  createModeAuthority, ModeAuthorityError,
  MODE, MODES, TRANSITIONS, REASONS, AUTHORITY_ROLES, CODE
};
