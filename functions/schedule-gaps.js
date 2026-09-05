'use strict';

/* ====================================================================
 *  schedule-gaps · 42H.2 חבילה ג׳ — בקרת פערים
 *
 *  מודול טהור. לכל יום בתוכנית: כמה משובצים מול מינימום כולל לתחנה,
 *  כמה בכל תחנת קצה מול קו המדיניות שלה, וכמה מחזיקי כל כשירות מול
 *  המינימום שלה בקטלוג. לכל פער — **מועמדים בלבד**: אנשים פעילים
 *  שאינם משובצים באותו יום ואינם בהיעדרות, ושמחזיקים בכשירות. המודול
 *  לעולם אינו משבץ.
 *
 *  פער בכשירות קריטית (ראש משמרת / סגן / קצין) — חוסם פרסום.
 *  פער אחר (מינימום תחנה, קו תחנת קצה, כשירות לא-קריטית) — מותר רק
 *  עם אישור מפורש וחתום של אחראי הסידור על **בדיוק** רשימת הפערים הזו
 *  (digest); שינוי בתוכנית או בקטלוג משנה את החתימה ומבטל את האישור.
 * ==================================================================== */

const MAX_CANDIDATES = 12;
const MAX_DAYS = 400;
/* ⭐ seq457 §3 · המועמדים כאן נבחרים לפי **כשירות ופניות ביום בלבד**:
 * פעיל, לא משובץ באותו יום, לא בהיעדרות, מחזיק בכשירות. הם **אינם**
 * נבדקים מול מנוע הזכאות (זמינות, נעילות, סבב, מנוחה). לכן כל רשימה
 * נושאת את הבסיס שלה במפורש, ואין שום נתיב שמחיל מועמד אוטומטית —
 * אחראי הסידור משבץ ידנית דרך העריכה, והעריכה עוברת את כל הבדיקות. */
const CANDIDATE_BASIS = 'qualification-only';

class ScheduleGapError extends Error {
  constructor(code, message) { super(message); this.name = 'ScheduleGapError'; this.code = code; }
}
function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }
function fail(code, message) { throw new ScheduleGapError(code, message); }
function compareText(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * analyzeGaps({ plan, policy, catalog, holdings, people, station_minimum, hash })
 *
 * plan.rows[{date, sub_station, label, minimum, slots[{person}], coverage}], plan.absences[{date, uid}]
 * policy.sub_stations{key:{label, minimum}}   catalog[{key,label,critical,active,minimum}]
 * holdings: { uid: [keys] } | Map            people[{id, full_name|name, active}]
 * station_minimum: int ≥ 0 (0 = אין בקרה כוללת)  hash(text) → hex (לחתימה)
 */
function analyzeGaps(input) {
  const inp = plain(input) ? input : {};
  const plan = inp.plan;
  if (!plain(plan) || !Array.isArray(plan.rows)) fail('gaps-plan', 'חסרה תוכנית לבדיקת פערים.');
  if (typeof inp.hash !== 'function') fail('gaps-hash', 'חסרה פונקציית חתימה.');
  const stationMinimum = Number.isInteger(inp.station_minimum) && inp.station_minimum > 0 ? inp.station_minimum : 0;
  const policySubs = plain(inp.policy) && plain(inp.policy.sub_stations) ? inp.policy.sub_stations : {};
  const catalog = (Array.isArray(inp.catalog) ? inp.catalog : []).filter((q) => plain(q) && nonEmpty(q.key) && q.active !== false);
  const holdings = new Map();
  if (inp.holdings instanceof Map) inp.holdings.forEach((keys, uid) => holdings.set(uid, new Set(Array.isArray(keys) ? keys : (keys && keys.qualifications) || [])));
  else if (plain(inp.holdings)) Object.keys(inp.holdings).forEach((uid) => holdings.set(uid, new Set(Array.isArray(inp.holdings[uid]) ? inp.holdings[uid] : (inp.holdings[uid] && inp.holdings[uid].qualifications) || [])));
  const people = new Map();
  (Array.isArray(inp.people) ? inp.people : []).forEach((p) => { if (plain(p) && nonEmpty(p.id) && p.active !== false) people.set(p.id, String(p.full_name || p.name || p.id)); });
  const holds = (uid, key) => holdings.has(uid) && holdings.get(uid).has(key);

  const dates = Array.from(new Set(plan.rows.map((r) => r.date))).sort();
  if (dates.length > MAX_DAYS) fail('gaps-too-many-days', 'יותר מדי ימים לבדיקת פערים.');
  const absentBy = new Map();
  (Array.isArray(plan.absences) ? plan.absences : []).forEach((a) => {
    if (!plain(a) || !nonEmpty(a.date) || !nonEmpty(a.uid)) return;
    if (!absentBy.has(a.date)) absentBy.set(a.date, new Set());
    absentBy.get(a.date).add(a.uid);
  });

  const days = [];
  const blocking = [];
  const acknowledgeable = [];
  dates.forEach((date) => {
    const rows = plan.rows.filter((r) => r.date === date);
    const assigned = new Set();
    rows.forEach((r) => (r.slots || []).forEach((s) => { if (s && nonEmpty(s.person)) assigned.add(s.person); }));
    const absent = absentBy.get(date) || new Set();
    const free = Array.from(people.keys()).filter((uid) => !assigned.has(uid) && !absent.has(uid)).sort((a, b) => compareText(people.get(a), people.get(b)));
    const candidateList = (filter) => free.filter(filter).slice(0, MAX_CANDIDATES).map((uid) => ({ uid, name: people.get(uid), basis: CANDIDATE_BASIS }));

    const stationGap = stationMinimum > 0 && assigned.size < stationMinimum ? stationMinimum - assigned.size : 0;
    const subs = rows.map((r) => {
      const spec = policySubs[r.sub_station] || {};
      const minimum = Number.isInteger(r.minimum) ? r.minimum : (Number.isInteger(spec.minimum) ? spec.minimum : 0);
      const count = (r.slots || []).length;
      const known = r.coverage !== 'missing';
      const gap = known && minimum > 0 && count < minimum ? minimum - count : 0;
      return { sub_station: r.sub_station, label: r.label || spec.label || r.sub_station, people: count, minimum, gap, coverage: known ? 'ready' : 'missing' };
    }).sort((a, b) => compareText(a.sub_station, b.sub_station));
    const quals = catalog.map((q) => {
      const minimum = Number.isInteger(q.minimum) && q.minimum > 0 ? q.minimum : 0;
      const present = Array.from(assigned).filter((uid) => holds(uid, q.key)).length;
      const gap = minimum > 0 && present < minimum ? minimum - present : 0;
      return {
        key: q.key, label: q.label, critical: q.critical === true, minimum, present, gap,
        candidates: gap > 0 ? candidateList((uid) => holds(uid, q.key)) : []
      };
    });
    const day = {
      date, total: assigned.size, station_minimum: stationMinimum, station_gap: stationGap,
      station_candidates: stationGap > 0 ? candidateList(() => true) : [],
      sub_stations: subs, qualifications: quals,
      has_gap: stationGap > 0 || subs.some((s) => s.gap > 0) || quals.some((q) => q.gap > 0),
      has_critical_gap: quals.some((q) => q.critical && q.gap > 0)
    };
    days.push(day);
    quals.forEach((q) => {
      if (q.gap <= 0) return;
      const entry = { kind: 'qualification', date, key: q.key, label: q.label, minimum: q.minimum, present: q.present, gap: q.gap };
      (q.critical ? blocking : acknowledgeable).push(entry);
    });
    if (stationGap > 0) acknowledgeable.push({ kind: 'station', date, minimum: stationMinimum, present: assigned.size, gap: stationGap });
    subs.forEach((s) => { if (s.gap > 0) acknowledgeable.push({ kind: 'sub_station', date, key: s.sub_station, label: s.label, minimum: s.minimum, present: s.people, gap: s.gap }); });
  });

  const digest = acknowledgeable.length ? String(inp.hash(stable({ station_id: plan.station_id || null, gaps: acknowledgeable }))) : null;
  return {
    days,
    blocking,
    acknowledgeable,
    digest,
    candidates_basis: CANDIDATE_BASIS,
    candidates_note: 'מועמדים לפי כשירות ופניות ביום בלבד — לא נבדקו זמינות, נעילות, סבב ומנוחה. אין שיבוץ אוטומטי.',
    summary: {
      days: days.length,
      days_with_gaps: days.filter((d) => d.has_gap).length,
      critical_gaps: blocking.length,
      other_gaps: acknowledgeable.length,
      station_minimum: stationMinimum
    }
  };
}

/** האישור תקף רק אם הוא בדיוק חתימת רשימת הפערים הנוכחית. */
function acknowledgementValid(report, acknowledgement) {
  if (!report || !report.acknowledgeable || !report.acknowledgeable.length) return true;
  return nonEmpty(acknowledgement) && acknowledgement === report.digest;
}

module.exports = Object.freeze({ ScheduleGapError, analyzeGaps, acknowledgementValid, MAX_CANDIDATES, MAX_DAYS, CANDIDATE_BASIS, stable });
