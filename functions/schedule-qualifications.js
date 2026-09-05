'use strict';

/* ====================================================================
 *  schedule-qualifications · 42H.2 חבילה ב׳ — קטלוג כשירויות
 *
 *  מודול טהור. כשירות (qualification) היא יכולת מבצעית של אדם — ראש
 *  משמרת, נהג, חומ״ס — ואינה תפקיד הרשאה (role) במערכת. לאדם יכולות
 *  להיות כמה כשירויות. הקטלוג נשמר לכל תחנה; תשע הכשירויות המובנות
 *  מגיעות בסדר קבוע, ושלוש הראשונות קריטיות: פער בהן חוסם פרסום
 *  (חבילה ג׳). אפשר להוסיף כשירויות מותאמות, לשנות תווית, להשבית,
 *  ולמחוק רק כשירות מותאמת שאיש אינו מחזיק בה.
 * ==================================================================== */

const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
/* ⭐ seq457 §4 · מפתחות שמורים של Object.prototype — עוברים את KEY_RE אבל
 * משבשים ספירה ומיזוג באובייקטים רגילים. נדחים בכניסה, מתעלמים בקריאה. */
const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']);
function validKey(key) { return KEY_RE.test(key) && RESERVED_KEYS.indexOf(key) === -1; }
const MAX_LABEL = 40;
const MAX_CUSTOM = 40;
const MAX_PER_PERSON = 20;
const MAX_MINIMUM = 200;

const CANONICAL = Object.freeze([
  { key: 'shift_lead', label: 'ראש משמרת', order: 10, critical: true },
  { key: 'deputy', label: 'סגן', order: 20, critical: true },
  { key: 'officer', label: 'קצין', order: 30, critical: true },
  { key: 'crew_commander', label: 'מפקדי צוותים', order: 40, critical: false },
  { key: 'driver', label: 'נהגים', order: 50, critical: false },
  { key: 'hazmat', label: 'חומ״ס', order: 60, critical: false },
  { key: 'monitoring', label: 'ניטור', order: 70, critical: false },
  { key: 'ylm', label: 'יל״מ', order: 80, critical: false },
  { key: 'firefighter', label: 'לוחמים', order: 90, critical: false }
].map((q) => Object.freeze(Object.assign({ builtin: true, active: true, minimum: 0 }, q))));
const CANONICAL_KEYS = Object.freeze(CANONICAL.map((q) => q.key));
const CRITICAL_KEYS = Object.freeze(CANONICAL.filter((q) => q.critical).map((q) => q.key));

class QualificationError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'QualificationError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }
function fail(code, message, detail) { throw new QualificationError(code, message, detail); }
function cleanLabel(raw, what) {
  if (!nonEmpty(raw)) fail('qualification-label', what + ': חסרה תווית.');
  const label = String(raw).replace(/\s+/g, ' ').trim();
  if (label.length > MAX_LABEL) fail('qualification-label', what + ': תווית ארוכה מדי (עד ' + MAX_LABEL + ').');
  return label;
}

/**
 * ממזג את הקטלוג המובנה עם מה שנשמר בתחנה (תוויות, השבתה, מינימום,
 * כשירויות מותאמות). הפלט ממוין לפי הסדר הקבוע ואז לפי סדר המותאמות.
 * `stored` — מערך מסמכים כפי שנקראו מ-Firestore; שדות לא מוכרים מתעלמים.
 */
function mergeCatalog(stored) {
  const byKey = new Map();
  (Array.isArray(stored) ? stored : []).forEach((doc) => {
    if (plain(doc) && validKey(String(doc.key || ''))) byKey.set(doc.key, doc);
  });
  const out = CANONICAL.map((base) => {
    const doc = byKey.get(base.key) || {};
    return {
      key: base.key,
      label: nonEmpty(doc.label) ? String(doc.label).slice(0, MAX_LABEL) : base.label,
      order: base.order,
      critical: base.critical,               // קריטיות המובנות קבועה
      builtin: true,
      active: doc.active !== false,
      minimum: Number.isInteger(doc.minimum) && doc.minimum >= 0 ? Math.min(doc.minimum, MAX_MINIMUM) : 0,
      revision: Number.isInteger(doc.revision) ? doc.revision : 0
    };
  });
  const custom = [];
  byKey.forEach((doc, key) => {
    if (CANONICAL_KEYS.indexOf(key) !== -1) return;
    custom.push({
      key,
      label: nonEmpty(doc.label) ? String(doc.label).slice(0, MAX_LABEL) : key,
      order: Number.isInteger(doc.order) ? doc.order : 1000,
      critical: doc.critical === true,
      builtin: false,
      active: doc.active !== false,
      minimum: Number.isInteger(doc.minimum) && doc.minimum >= 0 ? Math.min(doc.minimum, MAX_MINIMUM) : 0,
      revision: Number.isInteger(doc.revision) ? doc.revision : 0
    });
  });
  custom.sort((a, b) => (a.order - b.order) || (a.key < b.key ? -1 : 1));
  return out.concat(custom);
}

/**
 * בקשת שמירה של כשירות (יצירה או עדכון). מחזירה את המסמך לכתיבה.
 * `current` — הרשומה הקיימת מהקטלוג הממוזג (או null ליצירה).
 */
function normalizeSave(input, current, catalog) {
  const inp = plain(input) ? input : {};
  const key = String(inp.key || '').trim();
  if (!validKey(key)) fail('qualification-key', 'מפתח הכשירות: אותיות לטיניות קטנות, ספרות וקו תחתון (2–40), לא מילה שמורה.');
  const builtin = CANONICAL_KEYS.indexOf(key) !== -1;
  const base = builtin ? CANONICAL.find((q) => q.key === key) : null;
  if (!current && !builtin) {
    const customCount = (Array.isArray(catalog) ? catalog : []).filter((q) => q.builtin !== true).length;
    if (customCount >= MAX_CUSTOM) fail('qualification-limit', 'יותר מדי כשירויות מותאמות (עד ' + MAX_CUSTOM + ').');
  }
  const label = cleanLabel(inp.label !== undefined ? inp.label : (current ? current.label : (base ? base.label : '')), 'כשירות ' + key);
  const active = inp.active === undefined ? (current ? current.active !== false : true) : inp.active === true;
  let minimum = inp.minimum === undefined ? (current ? current.minimum : 0) : inp.minimum;
  if (!Number.isInteger(minimum) || minimum < 0 || minimum > MAX_MINIMUM) fail('qualification-minimum', 'מינימום לכשירות: מספר שלם 0–' + MAX_MINIMUM + '.');
  let critical = builtin ? base.critical : (inp.critical === undefined ? (current ? current.critical === true : false) : inp.critical === true);
  if (builtin && inp.critical !== undefined && inp.critical !== base.critical) {
    fail('qualification-critical-fixed', 'קריטיות של כשירות מובנית קבועה ואינה ניתנת לשינוי.');
  }
  if (builtin && base.critical && !active && inp.confirm_critical !== true) {
    fail('qualification-critical-disable', 'השבתת כשירות קריטית מבטלת את בקרת הפער שלה. יש לאשר במפורש (confirm_critical).');
  }
  const order = builtin ? base.order : (Number.isInteger(inp.order) && inp.order >= 100 && inp.order <= 9999 ? inp.order : (current ? current.order : 1000));
  // תווית כפולה — שתי כשירויות באותו שם מבלבלות בלוח.
  const duplicate = (Array.isArray(catalog) ? catalog : []).find((q) => q.key !== key && q.label === label);
  if (duplicate) fail('qualification-label-duplicate', 'כבר יש כשירות בשם „' + label + '" (' + duplicate.key + ').');
  return { key, label, order, critical, builtin, active, minimum };
}

/** מחיקה: רק מותאמת, רק כשאיש אינו מחזיק בה. מחזירה את הסיבה לסירוב או null. */
function deleteBlocker(entry, holders) {
  if (!entry) return { code: 'qualification-not-found', message: 'הכשירות אינה קיימת.' };
  if (entry.builtin) return { code: 'qualification-builtin', message: 'כשירות מובנית אינה נמחקת — אפשר להשבית אותה.' };
  const count = Array.isArray(holders) ? holders.length : Number(holders || 0);
  if (count > 0) {
    return { code: 'qualification-in-use', message: 'הכשירות בשימוש אצל ' + count + ' אנשים. יש להסיר אותה מהם לפני המחיקה.', holders: count };
  }
  return null;
}

/** רשימת כשירויות של אדם: מפתחות מוכרים, פעילים, בלי כפילויות, בסדר הקטלוג. */
function normalizeHoldings(raw, catalog) {
  if (!Array.isArray(raw)) fail('holdings-shape', 'רשימת הכשירויות אינה מערך.');
  if (raw.length > MAX_PER_PERSON) fail('holdings-limit', 'יותר מדי כשירויות לאדם אחד (עד ' + MAX_PER_PERSON + ').');
  const known = new Map((Array.isArray(catalog) ? catalog : []).map((q) => [q.key, q]));
  const seen = new Set();
  raw.forEach((key) => {
    const k = String(key || '');
    const entry = validKey(k) ? known.get(k) : null;
    if (!entry) fail('holdings-unknown', 'כשירות לא מוכרת: ' + k);
    if (entry.active === false) fail('holdings-inactive', 'הכשירות „' + entry.label + '" מושבתת ואינה ניתנת להקצאה.');
    seen.add(k);
  });
  return (Array.isArray(catalog) ? catalog : []).filter((q) => seen.has(q.key)).map((q) => q.key);
}

function diffHoldings(before, after) {
  const b = new Set(Array.isArray(before) ? before : []);
  const a = new Set(Array.isArray(after) ? after : []);
  return {
    added: Array.from(a).filter((k) => !b.has(k)),
    removed: Array.from(b).filter((k) => !a.has(k))
  };
}

/** ספירת מחזיקים לכל כשירות מתוך מסמכי האנשים. */
function holdersByKey(personDocs) {
  // Object.create(null): אין ירושה מ-Object.prototype, ולכן `constructor`
  // ברשימת מחזיקים אינו מתחיל מספירה של פונקציה.
  const out = Object.create(null);
  (Array.isArray(personDocs) ? personDocs : []).forEach((doc) => {
    if (!plain(doc) || !Array.isArray(doc.qualifications)) return;
    doc.qualifications.forEach((raw) => {
      const key = String(raw || '');
      if (!key || RESERVED_KEYS.indexOf(key) !== -1) return;
      out[key] = (out[key] || 0) + 1;
    });
  });
  return Object.assign({}, out);
}

module.exports = Object.freeze({
  QualificationError, CANONICAL, CANONICAL_KEYS, CRITICAL_KEYS, KEY_RE, RESERVED_KEYS, validKey,
  MAX_LABEL, MAX_CUSTOM, MAX_PER_PERSON, MAX_MINIMUM,
  mergeCatalog, normalizeSave, deleteBlocker, normalizeHoldings, diffHoldings, holdersByKey
});
