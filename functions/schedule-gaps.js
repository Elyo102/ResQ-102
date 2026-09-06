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
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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

function dayMillis(value) {
  if (!DATE_RE.test(String(value || ''))) return null;
  const date = new Date(String(value) + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date.getTime();
}

function planDates(plan) {
  const rowDates = Array.from(new Set(plan.rows.map((row) => String(row && row.date || '')))).sort();
  if (rowDates.some((date) => dayMillis(date) === null)) {
    fail('gaps-row-date', 'התוכנית כוללת תאריך לא תקין.');
  }
  const hasRange = plan.from !== undefined || plan.to !== undefined;
  if (!hasRange) return rowDates;
  const from = String(plan.from || '');
  const to = String(plan.to || '');
  const first = dayMillis(from);
  const last = dayMillis(to);
  if (first === null || last === null || first > last) {
    fail('gaps-range', 'טווח התוכנית אינו תקין.');
  }
  const count = Math.floor((last - first) / DAY_MS) + 1;
  if (count > MAX_DAYS) fail('gaps-too-many-days', 'יותר מדי ימים לבדיקת פערים.');
  if (rowDates.some((date) => date < from || date > to)) {
    fail('gaps-row-outside-range', 'התוכנית כוללת שורה מחוץ לטווח החתום.');
  }
  return Array.from({ length: count }, (_, index) =>
    new Date(first + index * DAY_MS).toISOString().slice(0, 10));
}

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
  const knownPeople = new Map();
  (Array.isArray(inp.people) ? inp.people : []).forEach((p) => {
    if (!plain(p) || !nonEmpty(p.id)) return;
    const name = String(p.full_name || p.name || p.id);
    knownPeople.set(p.id, name);
    if (p.active !== false) people.set(p.id, name);
  });
  const holds = (uid, key) => holdings.has(uid) && holdings.get(uid).has(key);

  const dates = planDates(plan);
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
    if (!rows.length) {
      const missing = {
        kind: 'coverage', reason: 'missing_schedule_day', date,
        key: date, label: 'יום חסר בסידור', minimum: 1, present: 0, gap: 1
      };
      const subStations = Object.keys(policySubs).sort(compareText).map((key) => {
        const spec = plain(policySubs[key]) ? policySubs[key] : {};
        return {
          sub_station: key, label: spec.label || key, people: 0,
          minimum: Number.isInteger(spec.minimum) ? spec.minimum : 0,
          gap: 0, coverage: 'missing'
        };
      });
      days.push({
        date, total: 0, station_minimum: stationMinimum,
        station_gap: stationMinimum, station_candidates: [],
        sub_stations: subStations, qualifications: [], invalid_assignments: [],
        coverage: 'missing', missing_day: true,
        has_gap: true, has_critical_gap: true
      });
      blocking.push(missing);
      return;
    }
    const assigned = new Set();
    rows.forEach((r) => (r.slots || []).forEach((s) => { if (s && nonEmpty(s.person)) assigned.add(s.person); }));
    const absent = absentBy.get(date) || new Set();
    // A name in a slot is not operational staffing unless that person still
    // belongs to the active roster and is not absent on this date.  Keep the
    // raw set for candidate suppression and for reporting stale assignments,
    // but use this effective set for every staffing/qualification count.
    const effectiveAssigned = new Set(Array.from(assigned).filter((uid) => people.has(uid) && !absent.has(uid)));
    const invalidAssignments = [];
    const seenInvalid = new Set();
    rows.forEach((r) => (r.slots || []).forEach((s) => {
      const uid = s && s.person;
      if (!nonEmpty(uid) || people.has(uid)) return;
      const key = String(r.sub_station || '') + '\u0000' + uid;
      if (seenInvalid.has(key)) return;
      seenInvalid.add(key);
      invalidAssignments.push({
        kind: 'assignment', reason: 'inactive_or_missing_person', date,
        key: uid, uid, label: knownPeople.get(uid) || uid,
        sub_station: r.sub_station || null, minimum: 1, present: 0, gap: 1
      });
    }));
    invalidAssignments.sort((a, b) => compareText(String(a.sub_station || '') + '\u0000' + a.uid, String(b.sub_station || '') + '\u0000' + b.uid));
    const free = Array.from(people.keys()).filter((uid) => !assigned.has(uid) && !absent.has(uid)).sort((a, b) => compareText(people.get(a), people.get(b)));
    const candidateList = (filter) => free.filter(filter).slice(0, MAX_CANDIDATES).map((uid) => ({ uid, name: people.get(uid), basis: CANDIDATE_BASIS }));

    const stationGap = stationMinimum > 0 && effectiveAssigned.size < stationMinimum ? stationMinimum - effectiveAssigned.size : 0;
    const subs = rows.map((r) => {
      const spec = policySubs[r.sub_station] || {};
      const minimum = Number.isInteger(r.minimum) ? r.minimum : (Number.isInteger(spec.minimum) ? spec.minimum : 0);
      const count = new Set((r.slots || []).map((s) => s && s.person).filter((uid) => nonEmpty(uid) && effectiveAssigned.has(uid))).size;
      const known = r.coverage !== 'missing';
      const gap = known && minimum > 0 && count < minimum ? minimum - count : 0;
      return { sub_station: r.sub_station, label: r.label || spec.label || r.sub_station, people: count, minimum, gap, coverage: known ? 'ready' : 'missing' };
    }).sort((a, b) => compareText(a.sub_station, b.sub_station));
    const quals = catalog.map((q) => {
      const minimum = Number.isInteger(q.minimum) && q.minimum > 0 ? q.minimum : 0;
      const present = Array.from(effectiveAssigned).filter((uid) => holds(uid, q.key)).length;
      const gap = minimum > 0 && present < minimum ? minimum - present : 0;
      return {
        key: q.key, label: q.label, critical: q.critical === true, minimum, present, gap,
        candidates: gap > 0 ? candidateList((uid) => holds(uid, q.key)) : []
      };
    });
    const day = {
      date, total: effectiveAssigned.size, station_minimum: stationMinimum, station_gap: stationGap,
      station_candidates: stationGap > 0 ? candidateList(() => true) : [],
      sub_stations: subs, qualifications: quals, invalid_assignments: invalidAssignments,
      has_gap: invalidAssignments.length > 0 || stationGap > 0 || subs.some((s) => s.gap > 0) || quals.some((q) => q.gap > 0),
      has_critical_gap: invalidAssignments.length > 0 || quals.some((q) => q.critical && q.gap > 0)
    };
    days.push(day);
    invalidAssignments.forEach((entry) => blocking.push(entry));
    quals.forEach((q) => {
      if (q.gap <= 0) return;
      const entry = { kind: 'qualification', date, key: q.key, label: q.label, minimum: q.minimum, present: q.present, gap: q.gap };
      (q.critical ? blocking : acknowledgeable).push(entry);
    });
    if (stationGap > 0) acknowledgeable.push({ kind: 'station', date, minimum: stationMinimum, present: effectiveAssigned.size, gap: stationGap });
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
