'use strict';

/* ====================================================================
 *  push-token-handoff — העברת מכשירי ההתראות של עובד בין תחנות,
 *  כחלק מאותה עסקה שמשלימה את ההעברה.
 *
 *  מודול טהור. אין Firebase, אין רשת, אין תאריך מערכת.
 *  **מתכנן ואינו כותב.**
 *
 *  --------------------------------------------------------------
 *  למה זה קיים · חסם 1 של Codex
 *  --------------------------------------------------------------
 *
 *  pushToOne קורא `stations/{sid}/push_tokens/{uid}` (index.js:3163).
 *  מסלול ההעברה אינו מעביר את המסמך הזה, ולכן:
 *
 *    התראת השלמה תחת תחנת **היעד**  → אפס טוקנים, אפס שליחה
 *    התראת השלמה תחת תחנת **המקור** → נחסמת בצדק, העובד כבר עזב
 *
 *  כלומר: העובד אינו מקבל את ההודעה שההעברה שלו הושלמה, בשני
 *  הכיוונים. delivery_station_id פתר את השאלה **לאן** לשלוח;
 *  זה פותר את השאלה **למי יש בכלל מכשיר שם**.
 *
 *  --------------------------------------------------------------
 *  ⭐ המלכודת שאינה נראית בשם „העתק את המסמך"
 *  --------------------------------------------------------------
 *
 *  מסמך הטוקנים אינו רק טוקנים. alerts.html:385 כותב:
 *
 *    { uid, emp, crew, role, full_name, tokens, prefs, updated_at }
 *
 *  **`full_name` ו-`emp` הם מידע אישי, ו-`crew` ו-`role` הם
 *  תחנתיים.** העתקה של המסמך כמות שהוא מעבירה שם מלא ומספר עובד
 *  לתחנה שהאדם עדיין לא שייך אליה, ומשתילה שם משמרת ותפקיד
 *  מהתחנה הישנה — ערכים שיהיו שגויים ביעד מהרגע הראשון.
 *
 *  לכן **שני שדות בלבד חוצים**: `tokens` ו-`prefs`. זו רשימה
 *  סגורה ולא סינון — שדה חדש שייכתב למסמך בעתיד לא יחצה,
 *  כי הרשימה אינה מכירה אותו מלכתחילה. `assertNoPii` סורק
 *  את התוצאה לפי **ערכים** ולא רק לפי שמות מפתחות.
 *
 *  --------------------------------------------------------------
 *  אטומיות · לא מובטחת כאן, ונאמר במפורש
 *  --------------------------------------------------------------
 *
 *  המודול מחזיר `ops` ומסמן `requires_single_transaction: true`.
 *  **מחיקת מסמך המקור חייבת לשבת באותה עסקה שכותבת את מסמך
 *  היעד, את מסמך האירוע ואת שורות ה-outbox.** אם המחיקה תרוץ
 *  בנפרד ותצליח בזמן שהשאר נכשל — לאדם אין מכשיר באף תחנה,
 *  והוא שקט לחלוטין עד שירשם מחדש ידנית.
 *
 *  כישלון עסקה = אפס שינוי. זה בידי מי שמחווט, ואיני יכול
 *  להוכיח אותו מכאן.
 * ==================================================================== */

const SCHEMA_VERSION = 1;

/* שני השדות היחידים שחוצים תחנה. רשימה סגורה. */
const CARRIED_FIELDS = Object.freeze(['tokens', 'prefs']);

/* שדות שקיימים במסמך ו**אסור** להם לחצות. מפורטים בשמם כדי
 * שהכוונה תהיה קריאה, אף שהרשימה הסגורה כבר מונעת אותם. */
const NEVER_CARRIED = Object.freeze([
  'full_name', 'emp', 'crew', 'role', 'updated_at', 'station_id'
]);

const LIMITS = Object.freeze({
  MAX_TOKENS: 20,          // מכשירים לאדם
  MAX_TOKEN_LENGTH: 4096,
  MAX_PREF_KEYS: 40
});

const CODE = Object.freeze({
  SHAPE: 'handoff-shape',
  FOREIGN_UID: 'handoff-foreign-uid',
  FOREIGN_STATION: 'handoff-foreign-station',
  SAME_STATION: 'handoff-same-station',
  TOO_MANY_TOKENS: 'handoff-too-many-tokens',
  PII: 'handoff-pii'
});

const KIND = Object.freeze({
  MOVED: 'moved',
  NO_TOKEN: 'no-token',
  NOOP: 'noop'
});

const WARN = Object.freeze({
  NO_SOURCE_TOKENS: 'source-has-no-tokens',
  PREFS_CONFLICT: 'prefs-differ-source-wins',
  TOKEN_ALREADY_AT_TARGET: 'token-already-registered-at-target',
  DROPPED_INVALID_TOKEN: 'dropped-invalid-token-entry'
});

class HandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
  }
}

/* ------------------------------ עזר ------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(?:^|\D)(?:0\d{1,2}[- ]?\d{7}|\+972\d{8,9})(?:\D|$)/;
const HEB_NAME_RE = /[֐-׿]{2,}\s+[֐-׿]{2,}/;

/**
 * סורק ערכים ולא רק מפתחות. טוקן FCM הוא מחרוזת אטומה ארוכה
 * ואינו נראה כמייל או כטלפון, ולכן הסריקה בטוחה עליו.
 */
function assertNoPii(value, path) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) throw new HandoffError(CODE.PII, 'מייל ב-' + path);
    if (PHONE_RE.test(value)) throw new HandoffError(CODE.PII, 'טלפון ב-' + path);
    if (HEB_NAME_RE.test(value)) throw new HandoffError(CODE.PII, 'שם ב-' + path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPii(v, path + '[' + i + ']'));
    return;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (NEVER_CARRIED.indexOf(k) !== -1) {
        throw new HandoffError(CODE.PII, 'שדה שאסור לו לחצות: ' + k + ' ב-' + path);
      }
      assertNoPii(value[k], path + '.' + k);
    }
  }
}

/**
 * רשומת טוקן אחת. שומרת את השדות הנלווים של הרשומה עצמה
 * (platform, added_at וכדומה) כי הם תיאור של המכשיר ולא של
 * האדם — אבל עוברת דרך אותה סריקה, ולכן רשומה שמישהו יתחיל
 * לדחוף לתוכה שם או טלפון תיחסם.
 */
function normalizeTokenEntry(raw, warnings) {
  if (isNonEmptyString(raw)) return { token: raw };
  if (!isPlainObject(raw) || !isNonEmptyString(raw.token)) {
    warnings.push({ code: WARN.DROPPED_INVALID_TOKEN });
    return null;
  }
  if (raw.token.length > LIMITS.MAX_TOKEN_LENGTH) {
    warnings.push({ code: WARN.DROPPED_INVALID_TOKEN });
    return null;
  }
  const out = {};
  for (const key of Object.keys(raw)) {
    if (NEVER_CARRIED.indexOf(key) !== -1) continue;
    out[key] = raw[key];
  }
  return out;
}

function tokenList(doc, warnings) {
  if (!doc || doc.exists !== true || !isPlainObject(doc.data)) return [];
  const raw = doc.data.tokens;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const norm = normalizeTokenEntry(entry, warnings);
    if (norm) out.push(norm);
  }
  return out;
}

function prefsOf(doc) {
  if (!doc || doc.exists !== true || !isPlainObject(doc.data)) return null;
  return isPlainObject(doc.data.prefs) ? doc.data.prefs : null;
}

/* ============================ המודול ============================ */

function createTokenHandoff(deps) {
  const d = deps || {};
  if (typeof d.clock !== 'function') {
    throw new HandoffError(CODE.SHAPE, 'חובה להזריק clock');
  }
  const clock = d.clock;

  /**
   * @param {object} input
   *   subject_uid         מי עובר
   *   source_station_id   מאיפה
   *   target_station_id   לאן
   *   source_doc          {exists, data}  צילום push_tokens במקור
   *   target_doc          {exists, data}  צילום push_tokens ביעד
   *   transfer            {request_id, revision}
   *
   * @returns {{kind, ops, warnings, requires_single_transaction, transfer_still_valid, audit}}
   */
  function planHandoff(input) {
    if (!isPlainObject(input)) throw new HandoffError(CODE.SHAPE, 'קלט לא תקין');
    const uid = input.subject_uid;
    const from = input.source_station_id;
    const to = input.target_station_id;
    if (!isNonEmptyString(uid) || !isNonEmptyString(from) || !isNonEmptyString(to)) {
      throw new HandoffError(CODE.SHAPE, 'חסרים מזהה אדם או תחנות');
    }
    if (from === to) {
      throw new HandoffError(CODE.SAME_STATION,
        'תחנת המקור והיעד זהות. אין מה להעביר.');
    }

    const warnings = [];
    const src = input.source_doc;
    const tgt = input.target_doc;

    /* --- זהות · שני הכיוונים --- *
     * מסמך שנושא uid אחר אינו של האדם הזה. העתקה שלו הייתה
     * שותלת את המכשירים של מישהו אחר תחת השם שלו. */
    for (const [doc, label] of [[src, 'source'], [tgt, 'target']]) {
      if (doc && doc.exists === true && isPlainObject(doc.data)
          && doc.data.uid !== undefined && doc.data.uid !== null
          && String(doc.data.uid) !== String(uid)) {
        throw new HandoffError(CODE.FOREIGN_UID,
          'מסמך הטוקנים ב-' + label + ' שייך למשתמש אחר.');
      }
      if (doc && doc.exists === true && isPlainObject(doc.data)
          && isNonEmptyString(doc.data.station_id)) {
        const expected = label === 'source' ? from : to;
        if (doc.data.station_id !== expected) {
          throw new HandoffError(CODE.FOREIGN_STATION,
            'מסמך הטוקנים ב-' + label + ' שייך לתחנה אחרת.');
        }
      }
    }

    const sourceTokens = tokenList(src, warnings);
    const targetTokens = tokenList(tgt, warnings);

    /* --- אין טוקן במקור --- *
     * ⭐ זה **אינו** מבטל את ההעברה. אדם בלי מכשיר רשום הוא מצב
     * רגיל לגמרי — הוא פשוט לא התקין את ההתראות. ההעברה קרתה;
     * מה שלא יקרה הוא ההודעה עליה. */
    if (!sourceTokens.length) {
      warnings.push({ code: WARN.NO_SOURCE_TOKENS });
      return frozen({
        kind: targetTokens.length ? KIND.NOOP : KIND.NO_TOKEN,
        ops: [],
        warnings,
        requires_single_transaction: false,
        transfer_still_valid: true,
        audit: auditOf(uid, from, to, input.transfer, 0)
      });
    }

    /* --- איחוד וניכוי כפילויות לפי מחרוזת הטוקן --- *
     * טוקן שכבר רשום ביעד נשאר ברשומת היעד: היא נרשמה שם,
     * ואם היא נושאת מידע על המכשיר הוא הנכון לתחנה הזו. */
    const byToken = new Map();
    for (const entry of targetTokens) byToken.set(entry.token, entry);
    for (const entry of sourceTokens) {
      if (byToken.has(entry.token)) {
        warnings.push({ code: WARN.TOKEN_ALREADY_AT_TARGET });
        continue;
      }
      byToken.set(entry.token, entry);
    }

    // מיון לפי מחרוזת הטוקן — יציב בין הרצות, ולכן החלה חוזרת
    // מייצרת מסמך זהה בייט-בבייט ולא מסמך שקול-אך-שונה.
    const merged = Array.from(byToken.values())
      .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));

    if (merged.length > LIMITS.MAX_TOKENS) {
      throw new HandoffError(CODE.TOO_MANY_TOKENS,
        'יותר מ-' + LIMITS.MAX_TOKENS + ' מכשירים לאדם אחד.');
    }

    /* --- העדפות --- *
     * העדפות המקור מנצחות: הן אלה שהאדם תחזק בפועל עד היום.
     * העדפות יעד שנותרו מביקור קודם ממלאות מפתחות חסרים בלבד,
     * ואי-הסכמה מדווחת ואינה נבלעת. */
    const srcPrefs = prefsOf(src);
    const tgtPrefs = prefsOf(tgt);
    let prefs = null;
    if (srcPrefs || tgtPrefs) {
      prefs = Object.assign({}, tgtPrefs || {}, srcPrefs || {});
      if (Object.keys(prefs).length > LIMITS.MAX_PREF_KEYS) {
        throw new HandoffError(CODE.SHAPE, 'יותר מדי מפתחות העדפה.');
      }
      if (srcPrefs && tgtPrefs) {
        for (const key of Object.keys(srcPrefs)) {
          if (Object.prototype.hasOwnProperty.call(tgtPrefs, key)
              && tgtPrefs[key] !== srcPrefs[key]) {
            warnings.push({ code: WARN.PREFS_CONFLICT, pref: key });
          }
        }
      }
    }

    /* --- החלה חוזרת --- *
     * אותם טוקנים בדיוק כבר ביעד, והמקור ריק מבחינה אפקטיבית.
     * זה קורה כשהעסקה נכתבה והריצה חזרה. אפס פעולות. */
    const sameAsTarget = merged.length === targetTokens.length
      && merged.every((entry, i) => {
        const sorted = targetTokens.slice()
          .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
        return sorted[i] && sorted[i].token === entry.token;
      });
    if (sameAsTarget && !srcHasContent(src)) {
      return frozen({
        kind: KIND.NOOP, ops: [], warnings,
        requires_single_transaction: false,
        transfer_still_valid: true,
        audit: auditOf(uid, from, to, input.transfer, merged.length)
      });
    }

    /* --- הפעולות --- *
     * ⭐ שתיהן, יחד, באותה עסקה. אין כאן „קודם כתוב ואחר כך מחק".
     * מחיקה שתצליח לבדה משאירה אדם בלי מכשיר באף תחנה. */
    const payload = { uid, tokens: merged };
    if (prefs) payload.prefs = prefs;

    const ops = [
      { op: 'set', collection: 'push_tokens', station_id: to, doc: uid,
        merge: true, data: payload },
      { op: 'delete', collection: 'push_tokens', station_id: from, doc: uid }
    ];

    // הרשימה הסגורה כבר מנעה, והסריקה מוודאת. כפילות מכוונת:
    // שדה חדש במסמך המקור לא יחצה, וגם אם יחצה — ייחסם כאן.
    assertNoPii(payload, 'handoff');
    for (const field of NEVER_CARRIED) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) {
        throw new HandoffError(CODE.PII, 'השדה ' + field + ' חצה תחנה.');
      }
    }

    return frozen({
      kind: KIND.MOVED,
      ops,
      warnings,
      requires_single_transaction: true,
      transfer_still_valid: true,
      audit: auditOf(uid, from, to, input.transfer, merged.length)
    });
  }

  function srcHasContent(src) {
    return !!(src && src.exists === true && isPlainObject(src.data)
      && Array.isArray(src.data.tokens) && src.data.tokens.length);
  }

  function auditOf(uid, from, to, transfer, count) {
    const t = isPlainObject(transfer) ? transfer : {};
    return {
      at: new Date(clock()).toISOString(),
      schema_version: SCHEMA_VERSION,
      subject: uid,
      from_station_id: from,
      to_station_id: to,
      request_id: isNonEmptyString(t.request_id) ? t.request_id : null,
      revision: t.revision === undefined ? null : t.revision,
      token_count: count
    };
  }

  function frozen(v) {
    return Object.freeze(Object.assign({ schema_version: SCHEMA_VERSION }, v));
  }

  return Object.freeze({
    planHandoff, assertNoPii,
    SCHEMA_VERSION, CARRIED_FIELDS, NEVER_CARRIED, LIMITS, CODE, KIND, WARN
  });
}

module.exports = {
  createTokenHandoff, HandoffError, assertNoPii,
  SCHEMA_VERSION, CARRIED_FIELDS, NEVER_CARRIED, LIMITS, CODE, KIND, WARN
};
