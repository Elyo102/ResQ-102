'use strict';

/* ====================================================================
 *  schedule-replicate · 42H.48 — „שכפל ציוות לכל המשמרות החודש"
 *
 *  מודול טהור. בלי Firebase, בלי שעון, בלי אקראיות, בלי כתיבה.
 *
 *  מה הוא עושה: מקבל שורת מקור אחת בסידור הפעיל (יום × תחנת קצה) ומייצר
 *  רשימת עריכות רגילה (`assign` / `unassign`) שמעתיקה את הצוות שלה לכל
 *  הימים **באותה קבוצת רוטציה, באותה תחנת קצה, באותו חודש**, מהיום
 *  והלאה. הוא אינו כותב דבר: הפלט עובר ל-`previewScheduleEdit` /
 *  `applyScheduleEdit` הקיימים, ולכן יורש מהם את כל ההגנות — תצוגה
 *  מקדימה, חתימת digest, CAS על הפרסום הפעיל, מינוי חי בתוך העסקה,
 *  רשומת audit, רוויזיה חדשה ו-outbox להתראות.
 *
 *  הכרעות (אלדד, 1.10.2026):
 *  · „משמרת תואמת" = אותה קבוצת רוטציה, אותה תחנת קצה, החודש שנבחר.
 *  · יום עם שיבוץ ידני קיים — **מדולג** כברירת מחדל; דריסה רק ב-
 *    `mode: 'override'` מפורש, ותמיד עם תצוגת השינויים.
 *  · אדם שנעדר ביום היעד — **אינו משובץ**. מדווח מי דולג ואיזה חוסר נוצר.
 *  · אדם שכבר משובץ באותו יום בתחנת קצה אחרת — אינו מועבר (היה „גונב"
 *    אותו מתחנה אחרת). מדווח.
 *  · אין פיצול שקט: אם מספר השינויים **בפועל** (אחרי הרצת applyEdits
 *    על אותו קלט) עובר את התקרה — נדחה כולו, עם הסבר.
 * ==================================================================== */

const edit = require('./schedule-edit');

const MODES = Object.freeze(['skip_manual', 'override']);
/* זהה ל-MAX_EDIT_REPORT_CHANGES ב-schedule-runtime.js (400; נבדק בטסט).
 * ⭐ שים לב: המנוע **אינו דוחה** מעל 400 — הוא קוטע את דוח העריכה ואת
 * רשומת ה-audit (`changes_truncated`). לכן כאן זה נדחה מראש: שכפול אחד
 * לא יכתוב יומן ביקורת חלקי. */
const MAX_CHANGES = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

class ScheduleReplicateError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ScheduleReplicateError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
function fail(code, message, detail) { throw new ScheduleReplicateError(code, message, detail); }
function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function validIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function dayNumber(date) { return Math.floor(Date.parse(date + 'T00:00:00.000Z') / 86400000); }
function addDays(date, n) { return new Date((dayNumber(date) + n) * 86400000).toISOString().slice(0, 10); }

/* אותו חישוב בדיוק כמו ב-schedule-edit.js (rotationGroup): רוטציה „קשיחה"
 * בלבד. בלי רוטציה מוגדרת אין „משמרת תואמת", והפעולה נדחית. */
function rotationGroup(policy, date) {
  const rotation = plain(policy) && plain(policy.rotation) ? policy.rotation : null;
  if (!rotation || rotation.strict !== true || !Array.isArray(rotation.groups)
      || !rotation.groups.length || !validIsoDate(String(rotation.anchor || ''))
      || !Number.isInteger(rotation.days_per_group) || rotation.days_per_group <= 0) return null;
  const cycle = rotation.groups.length * rotation.days_per_group;
  const delta = dayNumber(date) - dayNumber(rotation.anchor);
  return rotation.groups[Math.floor((((delta % cycle) + cycle) % cycle) / rotation.days_per_group)];
}

function monthDates(month) {
  const out = [];
  let date = month + '-01';
  while (date.slice(0, 7) === month) { out.push(date); date = addDays(date, 1); }
  return out;
}

/**
 * planReplication({ plan, policy, people, station_id, source, month, not_before, mode, max_changes })
 *
 *  plan       — תוכנית הפרסום הפעיל { from, to, rows, absences, … } (לא משתנה)
 *  policy     — המדיניות האפקטיבית (כמו ל-applyEdits)
 *  people     — אנשי המקור הפעילים (כמו ל-applyEdits)
 *  source     — { date, sub_station } — שורת התבנית
 *  month      — 'YYYY-MM' — החודש לשכפול
 *  not_before — 'YYYY-MM-DD' — היום לפי שעון ישראל; השרת מספק, לא הלקוח
 *  mode       — 'skip_manual' (ברירת מחדל) | 'override'
 *
 *  → { edits, target_dates, skipped_dates[], skipped_people[], gaps[],
 *      preview: { changes, warnings_total, people, dates }, summary }
 */
function planReplication(input) {
  const inp = plain(input) ? input : {};
  const plan = inp.plan;
  if (!plain(plan) || !Array.isArray(plan.rows)) fail('plan-required', 'חסרה תוכנית הפרסום הפעיל.');
  if (!validIsoDate(String(plan.from || '')) || !validIsoDate(String(plan.to || ''))) fail('plan-range', 'טווח הפרסום אינו ידוע.');
  const policy = inp.policy;
  if (!plain(policy) || !plain(policy.sub_stations)) fail('policy-required', 'חסרה מדיניות פעילה.');
  const mode = inp.mode === undefined ? 'skip_manual' : inp.mode;
  if (MODES.indexOf(mode) === -1) fail('replicate-mode', 'מצב שכפול לא מוכר.');
  const month = String(inp.month || '');
  if (!MONTH_RE.test(month)) fail('replicate-month', 'חודש לא תקין.');
  const notBefore = String(inp.not_before || '');
  if (!validIsoDate(notBefore)) fail('replicate-today', 'התאריך של היום חסר — השרת חייב לספק אותו.');
  /* ניתן רק להנמיך את התקרה (לבדיקות), לעולם לא להעלות מעל 400. */
  const maxChanges = Number.isInteger(inp.max_changes) && inp.max_changes > 0 ? Math.min(inp.max_changes, MAX_CHANGES) : MAX_CHANGES;

  const src = plain(inp.source) ? inp.source : {};
  const srcDate = String(src.date || ''), sub = String(src.sub_station || '');
  if (!validIsoDate(srcDate)) fail('replicate-source', 'יום המקור אינו תקין.');
  if (srcDate.slice(0, 7) !== month) fail('replicate-source-month', 'יום המקור אינו בחודש שנבחר.');
  if (!Object.prototype.hasOwnProperty.call(policy.sub_stations, sub)) fail('replicate-sub-station', 'תחנת הקצה אינה במדיניות.');
  const sourceRow = plan.rows.find((r) => r && r.date === srcDate && r.sub_station === sub);
  if (!sourceRow || !Array.isArray(sourceRow.slots) || !sourceRow.slots.length) {
    fail('replicate-source-empty', 'אין צוות בשורת המקור — אין מה לשכפל.');
  }
  const group = rotationGroup(policy, srcDate);
  if (!group) fail('replicate-no-rotation', 'למדיניות אין רוטציה קבועה, ולכן אין „משמרות תואמות". שכפול אינו אפשרי.');

  const template = sourceRow.slots.filter((s) => plain(s) && typeof s.person === 'string' && s.person)
    .map((s) => ({ uid: s.person, role: s.role === undefined || s.role === null ? null : s.role }));
  /* ⭐ שורה שכל המשבצות בה ריקות (בלי אדם) אינה תבנית: בלעדי הבדיקה הזו
   * השכפול היה מוחק את כל הצוות בכל ימי היעד ומדווח „אין חוסר". */
  if (!template.length) fail('replicate-source-empty', 'אין אנשים בשורת המקור — אין מה לשכפל.');
  if (new Set(template.map((t) => t.uid)).size !== template.length) fail('replicate-source-invalid', 'שורת המקור פגומה (אדם פעמיים).');
  /* תפקיד שכבר אינו מוגדר במדיניות לתחנת הקצה — האדם מדולג ומדווח, ולא
   * מפיל את כל הפעולה בשגיאה של מודול אחר. */
  const allowed = edit.allowedRoles(policy, sub);
  const active = new Set((Array.isArray(inp.people) ? inp.people : [])
    .filter((p) => plain(p) && p.active !== false && typeof p.id === 'string').map((p) => p.id));

  const skippedDates = [], skippedPeople = [], gaps = [];
  const targets = [];
  monthDates(month).forEach((date) => {
    if (date === srcDate) return;
    if (rotationGroup(policy, date) !== group) return;
    if (date < notBefore) { skippedDates.push({ date, reason: 'past' }); return; }
    if (date < plan.from || date > plan.to) { skippedDates.push({ date, reason: 'outside-publication' }); return; }
    const row = plan.rows.find((r) => r && r.date === date && r.sub_station === sub) || null;
    const slots = row && Array.isArray(row.slots) ? row.slots.filter(plain) : [];
    if (mode === 'skip_manual' && slots.some((s) => s.source === 'manual')) {
      skippedDates.push({ date, reason: 'manual-exists' }); return;
    }
    targets.push({ date, slots });
  });
  if (!targets.length) {
    return result([], [], skippedDates, skippedPeople, gaps, null, template.length, mode);
  }

  /* לכל אדם בתבנית — התאריכים שבהם הוא ישובץ, לפי תפקידו בתבנית. */
  const assignDates = new Map();   // uid → { role, dates[] }
  const unassignDates = new Map(); // uid → dates[]
  targets.forEach(({ date, slots }) => {
    let placed = 0;
    const eligible = new Set();
    template.forEach((t) => {
      let reason = null;
      if (t.role !== null && allowed.indexOf(t.role) === -1) reason = 'role-not-in-policy';
      else if (!active.has(t.uid)) reason = 'not-in-source';
      else if ((plan.absences || []).some((a) => plain(a) && a.uid === t.uid && a.date === date)) reason = 'absent';
      else if (plan.rows.some((r) => r && r.date === date && r.sub_station !== sub
        && (r.slots || []).some((s) => plain(s) && s.person === t.uid))) reason = 'assigned-elsewhere';
      if (reason) { skippedPeople.push({ uid: t.uid, date, reason }); return; }
      eligible.add(t.uid);
      placed += 1;
      /* כבר משובץ כאן באותו תפקיד — אין מה לעשות. בלי זה applyEdits היה
       * כותב מחדש משבצת של המנוע כ„ידנית" בלי שזה נספר כשינוי. */
      if (slots.some((s) => s.person === t.uid && (s.role === undefined ? null : s.role) === t.role)) return;
      if (!assignDates.has(t.uid)) assignDates.set(t.uid, { role: t.role, dates: [] });
      assignDates.get(t.uid).dates.push(date);
    });
    /* מי שמשובץ ביום היעד ואינו בתבנית — יוצא מהשורה (זה „שכפול"). */
    slots.forEach((s) => {
      if (typeof s.person !== 'string' || eligible.has(s.person)) return;
      if (!unassignDates.has(s.person)) unassignDates.set(s.person, []);
      unassignDates.get(s.person).push(date);
    });
    if (placed < template.length) gaps.push({ date, sub_station: sub, expected: template.length, placed });
  });

  const edits = [];
  Array.from(unassignDates.keys()).sort().forEach((uid) => {
    edits.push({ kind: 'unassign', uid, dates: unassignDates.get(uid).slice().sort() });
  });
  Array.from(assignDates.keys()).sort().forEach((uid) => {
    const e = assignDates.get(uid);
    edits.push(Object.assign({ kind: 'assign', uid, dates: e.dates.slice().sort(), sub_station: sub },
      e.role === null ? {} : { role: e.role }));
  });
  if (edits.length > edit.MAX_EDITS) {
    fail('replicate-too-many-edits', 'השכפול דורש ' + edits.length + ' עריכות; המקסימום בבקשה אחת הוא ' + edit.MAX_EDITS + '.');
  }
  if (!edits.length) {
    return result([], targets.map((t) => t.date), skippedDates, skippedPeople, gaps, null, template.length, mode);
  }

  /* ⭐ ספירת השינויים **בפועל**: אותה פונקציה שהשרת מריץ, על אותו קלט.
   * לא „אנשים × ימים" — הסרות נספרות, ושיבוץ שכבר קיים אינו שינוי. */
  const applied = edit.applyEdits({ plan, edits, people: inp.people, policy,
    station_id: inp.station_id || plan.station_id });
  if (applied.changes.length > maxChanges) {
    fail('replicate-too-many-changes', 'השכפול ייצור ' + applied.changes.length + ' שינויים; המקסימום בפרסום אחד הוא ' + maxChanges
      + '. לא בוצע דבר. אפשר לשכפל לתחנת קצה אחת בכל פעם או לחלק את החודש.', { changes: applied.changes.length, max: maxChanges });
  }
  return result(edits, targets.map((t) => t.date), skippedDates, skippedPeople, gaps, applied, template.length, mode);
}

function result(edits, targetDates, skippedDates, skippedPeople, gaps, applied, templateSize, mode) {
  return {
    mode,
    edits,
    target_dates: targetDates,
    skipped_dates: skippedDates,
    skipped_people: skippedPeople,
    gaps,
    preview: applied ? {
      changes: applied.changes.length,
      warnings_total: applied.warnings_total,
      people: applied.people_changed.length,
      dates: applied.counts.dates
    } : { changes: 0, warnings_total: 0, people: 0, dates: 0 },
    summary: {
      template_size: templateSize,
      target_dates: targetDates.length,
      skipped_dates: skippedDates.length,
      skipped_people: skippedPeople.length,
      days_with_gap: gaps.length
    }
  };
}

module.exports = Object.freeze({ planReplication, ScheduleReplicateError, MODES, MAX_CHANGES, rotationGroup });
