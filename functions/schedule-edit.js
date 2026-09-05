'use strict';

/* ====================================================================
 *  schedule-edit · 42H.2 חבילה א׳ — עריכת סידור שכבר פורסם
 *
 *  מודול טהור. בלי Firebase, בלי זמן, בלי מספרים אקראיים.
 *
 *  הקלט: התוכנית של הפרסום הפעיל (rows + absences), רשימת העריכות,
 *  אנשי המקור הפעילים והמדיניות. הפלט: תוכנית **חדשה** (הקלט אינו
 *  משתנה), רשימת השינויים לאדם/יום, אזהרות ושגיאות.
 *
 *  עקרונות:
 *  · אף snapshot קיים אינו משתנה — תמיד עותק חדש. המנוע (runtime) מייצר
 *    ממנו טיוטה ופרסום חדש עם revision חדש.
 *  · אדם מופיע לכל היותר פעם אחת ביום (חוזה הפרסום). שיבוץ לתחנה אחרת
 *    באותו יום = העברה, לא כפילות.
 *  · הקו האדום מוצג, אינו חוסם — כמו בגיליון. עריכה היא הכרעת אדם.
 *  · שגיאה (אדם לא מוכר, תאריך מחוץ לפרסום, תחנה שאינה במדיניות,
 *    שינוי תפקיד למי שאינו משובץ) חוסמת את כל העריכה — לא חלקית.
 * ==================================================================== */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/* מפתחות תחנה ומדיניות — מזהים פנימיים שהשרת יוצר. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/* ⭐ מזהה אדם = Firebase UID כפי שהוא. UID של ספק חיצוני יכול להיות
 * כתובת דוא״ל (`user+shift@example.com`) — אין לסנן לפי אלפאנומרי.
 * נאסר רק מה שאינו יכול להיות מזהה מסמך: ריק, רווח, `/`, תווי בקרה. */
const UID_RE = /^[^\s/\u0000-\u001f\u007f]{1,128}$/;
const MAX_EDITS = 200;
const MAX_DATES_PER_EDIT = 62;
const MAX_ROLE_CHARS = 40;
/* ⭐ תקרה קשיחה לאזהרות: 200 עריכות × 62 תאריכים = 12,400 אזהרות אפשריות,
 * ורשומת הטיוטה חייבת להישאר הרחק ממגבלת 1 MiB של Firestore. */
const MAX_WARNINGS = 200;
const KINDS = Object.freeze(['assign', 'unassign', 'role', 'absence']);
const ABSENCE_KINDS = Object.freeze(['sick', 'reserve', 'course', 'leave']);
const LOCATIONS = Object.freeze(['abroad', 'north', 'eilat']);
const SLOT_SOURCE = 'edited';

class ScheduleEditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScheduleEditError';
    this.code = code;
  }
}

function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0; }
function fail(code, message) { throw new ScheduleEditError(code, message); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function compareText(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/* ---------- ולידציה של בקשת העריכה ---------- */

function normalizeDates(raw, from, to, index) {
  if (!Array.isArray(raw) || !raw.length) fail('edit-dates', 'עריכה ' + index + ': חסרה רשימת תאריכים.');
  if (raw.length > MAX_DATES_PER_EDIT) fail('edit-dates', 'עריכה ' + index + ': יותר מדי תאריכים (' + raw.length + ').');
  const out = [];
  const seen = new Set();
  raw.forEach((value) => {
    const date = String(value || '');
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
      fail('edit-dates', 'עריכה ' + index + ': תאריך לא תקין.');
    }
    if (date < from || date > to) {
      fail('edit-date-outside', 'עריכה ' + index + ': התאריך ' + date + ' מחוץ לטווח הפרסום (' + from + ' — ' + to + ').');
    }
    if (seen.has(date)) return;
    seen.add(date); out.push(date);
  });
  out.sort();
  return out;
}

function normalizeRole(raw, index) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') fail('edit-role', 'עריכה ' + index + ': תפקיד לא תקין.');
  const role = raw.trim();
  if (!role.length || role.length > MAX_ROLE_CHARS) fail('edit-role', 'עריכה ' + index + ': תפקיד לא תקין.');
  return role;
}

function normalizeAbsence(raw, index) {
  if (raw === null) return null;
  if (!plain(raw) || ABSENCE_KINDS.indexOf(raw.kind) === -1) {
    fail('edit-absence', 'עריכה ' + index + ': סוג היעדרות לא מוכר.');
  }
  const out = { kind: raw.kind };
  if (raw.location !== undefined && raw.location !== null && raw.location !== '') {
    if (raw.kind !== 'leave') fail('edit-absence', 'עריכה ' + index + ': מיקום מותר רק לחופש.');
    if (LOCATIONS.indexOf(raw.location) === -1) fail('edit-absence', 'עריכה ' + index + ': מיקום לא מוכר.');
    out.location = raw.location;
  }
  return out;
}

/**
 * מנרמל את רשימת העריכות לצורה קנונית (ממוינת, בלי כפילויות בתאריכים),
 * בלי לדעת עדיין מי האנשים ומה במדיניות. הצורה הקנונית היא מה שנחתם.
 */
function normalizeEdits(raw, range) {
  if (!Array.isArray(raw) || !raw.length) fail('edits-required', 'לא נמסרה אף עריכה.');
  if (raw.length > MAX_EDITS) fail('edits-limit', 'יותר מדי עריכות בבקשה אחת (' + raw.length + ' > ' + MAX_EDITS + ').');
  if (!plain(range) || !DATE_RE.test(String(range.from || '')) || !DATE_RE.test(String(range.to || ''))) {
    fail('edit-range', 'טווח הפרסום אינו ידוע.');
  }
  return raw.map((item, i) => {
    const index = i + 1;
    if (!plain(item)) fail('edit-shape', 'עריכה ' + index + ' אינה אובייקט.');
    if (KINDS.indexOf(item.kind) === -1) fail('edit-kind', 'עריכה ' + index + ': סוג עריכה לא מוכר.');
    const uid = typeof item.uid === 'string' ? item.uid : '';
    if (!UID_RE.test(uid)) fail('edit-uid', 'עריכה ' + index + ': מזהה אדם לא תקין.');
    const out = { kind: item.kind, uid, dates: normalizeDates(item.dates, range.from, range.to, index) };
    if (item.kind === 'assign') {
      const sub = String(item.sub_station || '');
      if (!ID_RE.test(sub)) fail('edit-sub-station', 'עריכה ' + index + ': תחנת קצה לא תקינה.');
      out.sub_station = sub;
      out.role = normalizeRole(item.role, index);
    } else if (item.kind === 'role') {
      out.role = normalizeRole(item.role, index);
    } else if (item.kind === 'absence') {
      if (!hasOwn(item, 'absence')) fail('edit-absence', 'עריכה ' + index + ': חסר שדה absence (null = ביטול).');
      out.absence = normalizeAbsence(item.absence, index);
    }
    return out;
  });
}

/* ---------- החלת העריכות ---------- */

function subStationSpec(policy, sub) {
  if (!policy || !plain(policy.sub_stations) || !hasOwn(policy.sub_stations, sub)) return null;
  const spec = policy.sub_stations[sub];
  return plain(spec) ? spec : null;
}

/** התפקידים המותרים בתחנת קצה = מה שהמדיניות האפקטיבית מגדירה לה. */
function allowedRoles(policy, sub) {
  const spec = subStationSpec(policy, sub);
  const reqs = spec && Array.isArray(spec.requirements) ? spec.requirements : [];
  return reqs.filter((r) => plain(r) && nonEmpty(r.role)).map((r) => r.role);
}

function roleLabelFor(policy, sub, role) {
  if (role === null) return null;
  const spec = subStationSpec(policy, sub);
  const reqs = spec && Array.isArray(spec.requirements) ? spec.requirements : [];
  const hit = reqs.find((r) => plain(r) && r.role === role);
  return hit && nonEmpty(hit.label) ? hit.label : role;
}

/* ⭐ תפקיד אינו מחרוזת חופשית: רק תפקיד שהמדיניות מגדירה לתחנת הקצה הזו. */
function requireKnownRole(policy, sub, role, index) {
  if (role === null) return;
  if (allowedRoles(policy, sub).indexOf(role) === -1) {
    fail('edit-role-unknown', 'עריכה ' + index + ': התפקיד „' + role + '" אינו מוגדר במדיניות לתחנת הקצה ' + sub + '.');
  }
}

function findSlot(rows, uid, date) {
  for (const row of rows) {
    if (row.date !== date) continue;
    const idx = (row.slots || []).findIndex((s) => s && s.person === uid);
    if (idx !== -1) return { row, idx };
  }
  return null;
}

function stateOf(rows, absences, uid, date) {
  const slot = findSlot(rows, uid, date);
  const absence = absences.find((a) => a.uid === uid && a.date === date) || null;
  return {
    sub_station: slot ? slot.row.sub_station : null,
    role: slot ? (slot.row.slots[slot.idx].role === undefined ? null : slot.row.slots[slot.idx].role) : null,
    absence: absence ? Object.assign({ kind: absence.kind }, absence.location ? { location: absence.location } : {}) : null
  };
}

function sameState(a, b) {
  return a.sub_station === b.sub_station && a.role === b.role
    && JSON.stringify(a.absence) === JSON.stringify(b.absence);
}

/**
 * applyEdits({ plan, edits, people, policy, station_id })
 *   → { plan, changes, warnings, counts }
 *
 * `plan`    — תוכנית הפרסום הפעיל (rows, absences, absence_coverage, from, to …). לא משתנה.
 * `edits`   — רשימה קנונית מ-normalizeEdits (או גולמית; מנורמלת כאן).
 * `people`  — אנשי המקור הפעילים [{id, full_name|name, sub_station, roles}].
 * `policy`  — ערך המדיניות הפעילה { sub_stations: { key: { label, minimum, requirements[] } } }.
 */
function applyEdits(input) {
  const inp = plain(input) ? input : {};
  const plan = inp.plan;
  if (!plain(plan) || !Array.isArray(plan.rows)) fail('plan-required', 'חסרה תוכנית הפרסום הפעיל.');
  const stationId = String(inp.station_id || plan.station_id || '');
  if (!ID_RE.test(stationId)) fail('station-required', 'חסרה תחנה.');
  const policy = plain(inp.policy) && plain(inp.policy.sub_stations) ? inp.policy : null;
  if (!policy) fail('policy-required', 'חסרה מדיניות פעילה.');
  const people = new Map();
  (Array.isArray(inp.people) ? inp.people : []).forEach((person) => {
    if (plain(person) && nonEmpty(person.id) && person.active !== false) people.set(person.id, person);
  });
  const edits = normalizeEdits(inp.edits, { from: plan.from, to: plan.to });

  const rows = clone(plan.rows);
  /* ⭐ עריכה ידנית תמיד אפשרית (הכרעת אלדד, 5.9). כשחוקי התחנה השתנו מאז
   * הפרסום, כל השורות הקיימות מיושרות למדיניות **האפקטיבית** (קו מינימום,
   * תווית, תוויות תפקיד) — כך שהתוצאה כולה עומדת על מדיניות אחת, לא על
   * ערבוב של ישנה וחדשה. שורה בתחנת קצה שכבר אינה במדיניות נשארת כפי שהיא
   * ומקבלת אזהרה; אי אפשר לשבץ אליה. */
  let rowsRebased = 0;
  const rebaseWarnings = [];
  if (inp.rebase_policy === true) {
    const seenUnknown = new Set();
    rows.forEach((row) => {
      const spec = subStationSpec(policy, row.sub_station);
      if (!spec) {
        if (!seenUnknown.has(row.sub_station)) {
          seenUnknown.add(row.sub_station);
          rebaseWarnings.push({ code: 'sub-station-not-in-policy', sub_station: row.sub_station });
        }
        return;
      }
      const minimum = Number.isInteger(spec.minimum) ? spec.minimum : 0;
      const label = nonEmpty(spec.label) ? spec.label : row.sub_station;
      let changed = row.minimum !== minimum || row.label !== label;
      row.minimum = minimum;
      row.label = label;
      (row.slots || []).forEach((slot) => {
        if (!slot || slot.role === undefined || slot.role === null) return;
        const nextLabel = roleLabelFor(policy, row.sub_station, slot.role);
        if (slot.label !== nextLabel) { slot.label = nextLabel; changed = true; }
      });
      if (changed) rowsRebased += 1;
    });
  }
  const absences = clone(Array.isArray(plan.absences) ? plan.absences : []);
  const coverage = plain(plan.absence_coverage) ? clone(plan.absence_coverage) : null;
  const touched = new Map();   // uid|date → before
  const warnings = rebaseWarnings.slice();
  let warningsTotal = warnings.length;
  const warn = (entry) => {
    warningsTotal += 1;
    if (warnings.length < MAX_WARNINGS) warnings.push(entry);
  };

  const remember = (uid, date) => {
    const key = uid + '|' + date;
    if (!touched.has(key)) touched.set(key, stateOf(rows, absences, uid, date));
  };

  function rowFor(date, sub) {
    let row = rows.find((r) => r.date === date && r.sub_station === sub);
    if (row) return row;
    const spec = subStationSpec(policy, sub) || {};
    row = {
      date, station_id: stationId, sub_station: sub, label: nonEmpty(spec.label) ? spec.label : sub,
      rotation_group: null, minimum: Number.isInteger(spec.minimum) ? spec.minimum : 0,
      slots: [], gaps: [], rejected_manual: [], coverage: 'ready', below_minimum: false, complete: true
    };
    rows.push(row);
    return row;
  }

  function removeFromDay(uid, date) {
    const hit = findSlot(rows, uid, date);
    if (!hit) return false;
    hit.row.slots.splice(hit.idx, 1);
    return true;
  }

  edits.forEach((edit, i) => {
    const index = i + 1;
    // הסרה (ביטול שיבוץ / ביטול היעדרות) מותרת גם למי שכבר אינו במקור —
    // כדי שאפשר יהיה להוציא מהסידור אדם שעזב. הוספה — רק לאדם פעיל במקור.
    const removal = edit.kind === 'unassign' || (edit.kind === 'absence' && edit.absence === null);
    const inPlan = plan.rows.some((r) => (r.slots || []).some((s) => s && s.person === edit.uid))
      || (Array.isArray(plan.absences) && plan.absences.some((a) => a && a.uid === edit.uid));
    if (!people.has(edit.uid) && !(removal && inPlan)) {
      fail('edit-person-unknown', 'עריכה ' + index + ': האדם אינו במקור כוח האדם הפעיל.');
    }
    /* ⭐ תחנת קצה — רק מפתח שהוא own-property של המדיניות **האפקטיבית**
     * (לא `constructor`, לא `main` היסטורי שאינו בתוכנית הקנונית). */
    if (edit.kind === 'assign' && !subStationSpec(policy, edit.sub_station)) {
      fail('edit-sub-station-unknown', 'עריכה ' + index + ': תחנת הקצה אינה במדיניות.');
    }
    if (edit.kind === 'assign') requireKnownRole(policy, edit.sub_station, edit.role, index);
    edit.dates.forEach((date) => {
      remember(edit.uid, date);
      if (edit.kind === 'assign') {
        removeFromDay(edit.uid, date);          // העברה: פעם אחת ביום
        const row = rowFor(date, edit.sub_station);
        row.slots.push({ person: edit.uid, role: edit.role, label: roleLabelFor(policy, edit.sub_station, edit.role), source: SLOT_SOURCE });
        if (row.coverage === 'missing') row.coverage = 'ready';   // אדם הזין — הנתון ידוע
        if (absences.some((a) => a.uid === edit.uid && a.date === date)) {
          warn({ code: 'assigned-while-absent', uid: edit.uid, date });
        }
      } else if (edit.kind === 'unassign') {
        if (!removeFromDay(edit.uid, date)) warn({ code: 'not-assigned', uid: edit.uid, date });
      } else if (edit.kind === 'role') {
        const hit = findSlot(rows, edit.uid, date);
        if (!hit) fail('edit-role-not-assigned', 'עריכה ' + index + ': אי אפשר לשנות תפקיד למי שאינו משובץ ב-' + date + '.');
        requireKnownRole(policy, hit.row.sub_station, edit.role, index);
        hit.row.slots[hit.idx].role = edit.role;
        hit.row.slots[hit.idx].label = roleLabelFor(policy, hit.row.sub_station, edit.role);
        hit.row.slots[hit.idx].source = SLOT_SOURCE;
      } else if (edit.kind === 'absence') {
        for (let k = absences.length - 1; k >= 0; k -= 1) {
          if (absences[k].uid === edit.uid && absences[k].date === date) absences.splice(k, 1);
        }
        if (edit.absence) {
          absences.push(Object.assign({ date, uid: edit.uid, kind: edit.absence.kind },
            edit.absence.location ? { location: edit.absence.location } : {}));
          if (coverage && coverage[edit.absence.kind] === 'missing') coverage[edit.absence.kind] = 'ready';
          if (findSlot(rows, edit.uid, date)) warn({ code: 'absent-while-assigned', uid: edit.uid, date });
        }
      }
    });
  });

  // קו אדום: מוצג, אינו חוסם. שורות ריקות שנוצרו ונשארו ריקות — נמחקות
  // (שורה שלא הייתה בפרסום ולא קיבלה איש אינה נתון חדש).
  const originalKeys = new Set(plan.rows.map((r) => r.date + '|' + r.sub_station));
  const kept = rows.filter((row) => row.slots.length > 0 || originalKeys.has(row.date + '|' + row.sub_station));
  kept.forEach((row) => {
    const minimum = Number.isInteger(row.minimum) ? row.minimum : 0;
    row.below_minimum = row.coverage !== 'missing' && minimum > 0 && row.slots.length < minimum;
  });
  kept.sort((a, b) => compareText(a.date + '|' + a.sub_station, b.date + '|' + b.sub_station));
  absences.sort((a, b) => compareText(a.date + '|' + a.uid, b.date + '|' + b.uid));

  const changes = [];
  Array.from(touched.keys()).sort().forEach((key) => {
    const [uid, date] = key.split('|');
    const before = touched.get(key);
    const after = stateOf(kept, absences, uid, date);
    if (sameState(before, after)) return;
    changes.push({ uid, date, before, after });
  });

  const nextPlan = Object.assign({}, plan, {
    rows: kept, absences,
    summary: Object.assign({}, plain(plan.summary) ? plan.summary : {}, {
      filled: kept.reduce((n, row) => n + row.slots.length, 0),
      blocking_gaps: 0, days_below_minimum: 0, rejected_manual: 0, open_rows: 0,
      edited_below_minimum: kept.filter((row) => row.below_minimum === true).length,
      edited_absences: absences.length
    }),
    edited: true
  });
  if (coverage) nextPlan.absence_coverage = coverage;
  const people_changed = Array.from(new Set(changes.map((c) => c.uid))).sort();
  return {
    plan: nextPlan,
    changes,
    warnings,
    warnings_total: warningsTotal,
    warnings_truncated: warningsTotal - warnings.length,
    policy_rebased: inp.rebase_policy === true,
    rows_rebased: rowsRebased,
    counts: {
      edits: edits.length, changes: changes.length, people: people_changed.length,
      dates: Array.from(new Set(changes.map((c) => c.date))).length,
      no_ops: edits.reduce((n, e) => n + e.dates.length, 0) - changes.length,
      below_minimum: nextPlan.summary.edited_below_minimum,
      warnings: warningsTotal
    },
    people_changed
  };
}

/* ---------- חיפוש עובד (טהור, לשימוש המסך והשרת) ---------- */

function normSearch(s) {
  return String(s || '').replace(/[֑-ׇ]/g, '').replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** מחזיר אנשים שהשם/מספר העובד/תחנת הקצה שלהם מתחילים או מכילים את הטקסט. */
function searchPeople(people, query, limit) {
  const q = normSearch(query);
  const max = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const list = (Array.isArray(people) ? people : []).filter((p) => plain(p) && nonEmpty(p.id));
  if (!q) return list.slice(0, max);
  const scored = [];
  list.forEach((p) => {
    const name = normSearch(p.full_name || p.name || '');
    const emp = normSearch(p.employee_number || '');
    const sub = normSearch(p.sub_station_label || p.sub_station || '');
    let score = 0;
    if (name.indexOf(q) === 0) score = 3;
    else if (name.split(' ').some((part) => part.indexOf(q) === 0)) score = 2;
    else if (name.indexOf(q) !== -1 || emp.indexOf(q) === 0) score = 1;
    else if (sub === q) score = 1;
    if (score) scored.push({ score, name, p });
  });
  scored.sort((a, b) => (b.score - a.score) || compareText(a.name, b.name));
  return scored.slice(0, max).map((s) => s.p);
}

module.exports = Object.freeze({
  ScheduleEditError, normalizeEdits, applyEdits, searchPeople, roleLabelFor, allowedRoles,
  KINDS, ABSENCE_KINDS, LOCATIONS, MAX_EDITS, MAX_DATES_PER_EDIT, MAX_WARNINGS, SLOT_SOURCE, UID_RE
});
