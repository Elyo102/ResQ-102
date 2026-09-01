'use strict';

/* ====================================================================
 *  schedule-coverage — „באילו ימים תחנת קצה אינה מחזיקה את כל
 *  הכשירויות שהוגדרו חובה".
 *
 *  מודול טהור. אין Firebase, אין רשת, אין תאריך מערכת.
 *
 *  --------------------------------------------------------------
 *  מה זה לא
 *  --------------------------------------------------------------
 *
 *  זה **אינו מנוע חדש**. schedule-calendar-engine כבר מחשב את
 *  החוסר: כל שורה שנשמרת נושאת `gaps[]` עם `required`, `minimum`,
 *  `below_minimum` ו-`rejected_manual`. המודול הזה קורא את מה
 *  שכבר חושב והופך אותו לדוח שאפשר להסתכל עליו.
 *
 *  שני דברים הוא כן מוסיף, ושניהם חסרים היום:
 *
 *  1. **גלגול חודשי לפי תפקיד.** „חסר נהג" ביום אחד הוא תקלה.
 *     „חסר נהג ב-11 מתוך 15" הוא בעיית תקן, וזו החלטת גיוס ולא
 *     החלטת סידור. שורה-שורה אי אפשר לראות את ההבדל.
 *
 *  2. **rejected_manual נחשף.** המנוע דוחה שיבוץ ידני לא חוקי
 *     לתוך השדה הזה, ואף מסך אינו מציג אותו. אחראי הסידור משבץ,
 *     מסתכל, ולא מבין למה האדם לא שם.
 *
 *  --------------------------------------------------------------
 *  הנתק שחייבים לתקן לפני שהדוח הזה אומר משהו
 *  --------------------------------------------------------------
 *
 *  המנוע מתאים אנשים לתפקידים לפי `person.roles[]` —
 *  schedule-calendar-engine.js:383 — ורשימת התפקידים המוכרים
 *  נבנית מ-`policy.sub_stations[*].requirements[*].role` (:280).
 *
 *  הכשירויות שאלדד מנהל בפועל יושבות במקום אחר לגמרי:
 *  `stations/{sid}/member_quals/{uid}.quals` — מזהי כשירות מתוך
 *  `stations/{sid}/quals`.
 *
 *  **אין בריפו שום קוד שמחבר בין השניים.** מי שיגדיר „חומ״ס
 *  חובה בשחמון" ב-quals.html — המנוע לא יראה את זה לעולם.
 *
 *  `mapQualifications` כאן הוא הגשר, והוא מחזיר גם את מה
 *  שלא הצליח להיקשר בשני הכיוונים. תרגום שמבליע צד אחד הוא
 *  בדיוק איך שתקן נראה מלא ורכב יוצא בלי נהג.
 * ==================================================================== */

const SEVERITY = Object.freeze({
  BLOCKING: 'blocking',   // חסרה כשירות שהוגדרה חובה
  BELOW: 'below_minimum', // מתחת לקו המינימום
  SOFT: 'soft',           // חסרה כשירות שהוגדרה רצויה
  REJECTED: 'rejected',   // שיבוץ ידני נדחה
  OK: 'ok'
});

const LIMITS = Object.freeze({
  MAX_ROWS: 2000,
  MAX_NOTE: 200
});

// שדות שאסור שיצאו מהדוח. הדוח נועד לאחראי סידור, ולכן מזהה
// אדם מותר בו — אבל שם, מייל, טלפון ומספר עובד אינם נחוצים
// לשום שורה כאן, ולכן הם נחסמים.
const FORBIDDEN_KEYS = Object.freeze([
  'name', 'full_name', 'display_name', 'first_name', 'last_name',
  'email', 'mail', 'phone', 'mobile', 'tel', 'emp', 'employee_number',
  'id_number', 'personal_id'
]);

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /(?:^|\D)(?:0\d{1,2}[- ]?\d{7}|\+972\d{8,9})(?:\D|$)/;

class CoverageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoverageError';
    this.code = code;
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/* ---------------------- גשר הכשירויות ---------------------- */

/**
 * הופך את מה שאלדד מנהל ב-quals.html לתפקידי הסידור של המנוע.
 *
 * @param {object} input
 *   quals        [{id, name, active}]        — stations/{sid}/quals
 *   member_quals {uid: {quals:[qualId]}}     — stations/{sid}/member_quals
 *   role_map     {qualId: engineRole}        — המיפוי המפורש
 *   policy_roles [engineRole]                — כל התפקידים בתקן
 *
 * מחזיר גם `unmapped_quals` וגם `roles_without_qual`. השני הוא
 * החשוב: תפקיד שנדרש בתקן ואין שום כשירות שמובילה אליו — אף
 * אדם לא יוכל למלא אותו, לעולם, והתקן ייראה חסר כל יום בחודש
 * בלי סיבה נראית לעין.
 */
function mapQualifications(input) {
  if (!isPlainObject(input)) throw new CoverageError('shape', 'קלט לא תקין');
  const quals = Array.isArray(input.quals) ? input.quals : [];
  const memberQuals = isPlainObject(input.member_quals) ? input.member_quals : {};
  const roleMap = isPlainObject(input.role_map) ? input.role_map : {};
  const policyRoles = Array.isArray(input.policy_roles) ? input.policy_roles : [];

  if (!policyRoles.length) {
    throw new CoverageError('policy-roles-required',
      'חובה למסור את תפקידי התקן. בלעדיהם אי אפשר לדעת מה לא נקשר.');
  }

  const knownQual = new Map();
  for (const q of quals) {
    if (!isPlainObject(q) || !isNonEmptyString(q.id)) continue;
    knownQual.set(q.id, {
      id: q.id,
      label: isNonEmptyString(q.name) ? q.name : q.id,
      active: q.active !== false
    });
  }

  const roleSet = new Set(policyRoles);
  const unmappedQuals = [];
  const mappedRoles = new Set();
  const badTargets = [];

  for (const qid of Object.keys(roleMap)) {
    const role = roleMap[qid];
    if (!isNonEmptyString(role) || !roleSet.has(role)) {
      badTargets.push({ qual: qid, role: role === undefined ? null : role });
      continue;
    }
    if (!knownQual.has(qid)) {
      // מיפוי לכשירות שנמחקה. לא שגיאה, אבל לא בולעים אותה.
      badTargets.push({ qual: qid, role, reason: 'qual-unknown' });
      continue;
    }
    mappedRoles.add(role);
  }

  for (const qid of knownQual.keys()) {
    if (!Object.prototype.hasOwnProperty.call(roleMap, qid)) unmappedQuals.push(qid);
  }

  const rolesWithoutQual = policyRoles.filter((r) => !mappedRoles.has(r)).sort();

  // התוצאה בפועל: לכל אדם, רשימת תפקידי מנוע.
  const people = {};
  for (const uid of Object.keys(memberQuals)) {
    const doc = memberQuals[uid];
    const held = isPlainObject(doc) && Array.isArray(doc.quals) ? doc.quals : [];
    const roles = [];
    for (const qid of held) {
      const q = knownQual.get(qid);
      if (!q || !q.active) continue;
      const role = roleMap[qid];
      if (!isNonEmptyString(role) || !roleSet.has(role)) continue;
      if (roles.indexOf(role) === -1) roles.push(role);
    }
    people[uid] = roles.sort();
  }

  return {
    people,
    unmapped_quals: unmappedQuals.sort(),
    roles_without_qual: rolesWithoutQual,
    invalid_map_entries: badTargets.sort((a, b) => (a.qual < b.qual ? -1 : 1))
  };
}

/* ------------------------- דוח החוסרים ------------------------- */

function assertNoLeak(value, path) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) {
      throw new CoverageError('leak', 'ערך שנראה כמייל ב-' + path);
    }
    if (PHONE_RE.test(value)) {
      throw new CoverageError('leak', 'ערך שנראה כטלפון ב-' + path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoLeak(v, path + '[' + i + ']'));
    return;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      if (FORBIDDEN_KEYS.indexOf(k) !== -1) {
        throw new CoverageError('leak', 'שדה אסור ' + k + ' ב-' + path);
      }
      assertNoLeak(value[k], path + '.' + k);
    }
  }
}

/**
 * @param {object} input
 *   rows   שורות שנשמרו מהמנוע: {date, sub_station, label, minimum,
 *          slots[], gaps[], rejected_manual[], below_minimum, complete}
 *   only_required  אם true, מדווחים רק על דרישות חובה. ברירת מחדל false.
 *
 * מחזיר {days[], by_role[], totals, generated_at}
 */
function reviewCoverage(input, clock) {
  if (typeof clock !== 'function') {
    throw new CoverageError('clock-required', 'חובה להזריק clock');
  }
  if (!isPlainObject(input) || !Array.isArray(input.rows)) {
    throw new CoverageError('rows-required', 'חובה למסור שורות סידור');
  }
  if (input.rows.length > LIMITS.MAX_ROWS) {
    throw new CoverageError('rows-too-many', 'יותר מדי שורות');
  }
  const onlyRequired = input.only_required === true;

  const days = [];
  const roleTally = new Map();
  let blockingDays = 0, belowDays = 0, rejectedDays = 0, cleanDays = 0;

  for (const raw of input.rows) {
    if (!isPlainObject(raw) || !isNonEmptyString(raw.date)
        || !isNonEmptyString(raw.sub_station)) {
      throw new CoverageError('row-shape', 'שורת סידור אינה תקינה');
    }
    const gaps = Array.isArray(raw.gaps) ? raw.gaps : [];
    const rejected = Array.isArray(raw.rejected_manual) ? raw.rejected_manual : [];
    const filled = Array.isArray(raw.slots) ? raw.slots.length : 0;
    const minimum = isInt(raw.minimum) ? raw.minimum : 0;

    const missing = [];
    for (const g of gaps) {
      if (!isPlainObject(g) || !isNonEmptyString(g.role)) {
        throw new CoverageError('gap-shape', 'רשומת חוסר אינה תקינה');
      }
      // `required` חייב להיות בוליאני מפורש — אותה קפדנות של המנוע.
      // ברירת מחדל כאן הייתה הופכת דרישת חובה לרצויה בשקט.
      if (typeof g.required !== 'boolean') {
        throw new CoverageError('gap-required',
          'לחוסר ' + g.role + ' בתאריך ' + raw.date + ' חסר סימון חובה/רשות');
      }
      if (onlyRequired && !g.required) continue;
      missing.push({
        role: g.role,
        label: isNonEmptyString(g.label) ? g.label : g.role,
        required: g.required,
        reasons: Array.isArray(g.reasons) ? g.reasons.map((r) => ({
          code: r && r.code ? String(r.code) : 'unknown',
          count: isInt(r && r.count) ? r.count : 0
        })) : []
      });

      const key = g.role;
      const t = roleTally.get(key) || {
        role: g.role,
        label: isNonEmptyString(g.label) ? g.label : g.role,
        required_days: 0,
        optional_days: 0,
        sub_stations: new Set(),
        dates: []
      };
      if (g.required) t.required_days += 1; else t.optional_days += 1;
      t.sub_stations.add(raw.sub_station);
      t.dates.push(raw.date);
      roleTally.set(key, t);
    }

    const blocking = missing.filter((m) => m.required).length > 0;
    const below = raw.below_minimum === true || filled < minimum;

    let severity = SEVERITY.OK;
    if (blocking) severity = SEVERITY.BLOCKING;
    else if (below) severity = SEVERITY.BELOW;
    else if (rejected.length) severity = SEVERITY.REJECTED;
    else if (missing.length) severity = SEVERITY.SOFT;

    if (blocking) blockingDays += 1;
    else if (below) belowDays += 1;
    else if (rejected.length) rejectedDays += 1;
    else cleanDays += 1;

    days.push({
      date: raw.date,
      sub_station: raw.sub_station,
      label: isNonEmptyString(raw.label) ? raw.label : raw.sub_station,
      severity,
      filled,
      minimum,
      below_minimum: below,
      missing,
      // נחשף במפורש. היום הוא נשמר ואיש אינו רואה אותו.
      rejected_manual: rejected.map((r) => ({
        person: r && isNonEmptyString(r.person) ? r.person : null,
        code: r && isNonEmptyString(r.code) ? r.code : 'unknown'
      }))
    });
  }

  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : (a.sub_station < b.sub_station ? -1 : a.sub_station > b.sub_station ? 1 : 0)));

  const byRole = Array.from(roleTally.values()).map((t) => ({
    role: t.role,
    label: t.label,
    required_days: t.required_days,
    optional_days: t.optional_days,
    sub_stations: Array.from(t.sub_stations).sort(),
    dates: t.dates.slice().sort()
  })).sort((a, b) => (b.required_days - a.required_days)
    || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));

  const out = {
    generated_at: new Date(clock()).toISOString(),
    days,
    by_role: byRole,
    totals: {
      rows: input.rows.length,
      blocking_days: blockingDays,
      below_minimum_days: belowDays,
      rejected_only_days: rejectedDays,
      clean_days: cleanDays
    }
  };

  assertNoLeak(out, 'coverage');
  return out;
}

/**
 * שורה אחת לקריאה אנושית, בלי שמות ובלי מספרי עובד.
 * מיועדת למסך הלוג, ולכן היא מסכמת ואינה מפרטת.
 */
function summarize(report) {
  if (!isPlainObject(report) || !isPlainObject(report.totals)) {
    throw new CoverageError('shape', 'דוח לא תקין');
  }
  const t = report.totals;
  if (t.blocking_days === 0 && t.below_minimum_days === 0 && t.rejected_only_days === 0) {
    return 'כל הימים עומדים בתקן.';
  }
  const parts = [];
  if (t.blocking_days) parts.push(t.blocking_days + ' ימים בלי כשירות חובה');
  if (t.below_minimum_days) parts.push(t.below_minimum_days + ' ימים מתחת לקו המינימום');
  if (t.rejected_only_days) parts.push(t.rejected_only_days + ' ימים עם שיבוץ ידני שנדחה');
  const worst = report.by_role.filter((r) => r.required_days > 0)[0];
  const tail = worst
    ? ' החוסר הגדול ביותר: ' + worst.label + ' ב-' + worst.required_days + ' ימים.'
    : '';
  return parts.join(' · ') + '.' + tail;
}

module.exports = {
  mapQualifications,
  reviewCoverage,
  summarize,
  assertNoLeak,
  CoverageError,
  SEVERITY,
  LIMITS,
  FORBIDDEN_KEYS
};
