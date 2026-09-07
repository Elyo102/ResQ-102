'use strict';

// Inert projection only: callers must authorize and successfully read each
// station-scoped source before invoking this module. It does not grant access,
// perform reads, calculate attendance entitlement, or approve anybody's report.
// attendance.html writeReport stores date KEYS, not immutable detail rows.
const STATES = Object.freeze({
  missing: 'לא הוגש דוח', draft: 'ממתין לאישור העובד',
  submitted: 'ממתין לאישור פיקודי', approved: 'מאושר'
});
class HrHoursInputError extends Error {
  constructor(code) { super(code); this.name = 'HrHoursInputError'; this.code = code; }
}
const fail = code => { throw new HrHoursInputError(code); };
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, key) => Object.prototype.hasOwnProperty.call(v, key);
function monthKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)
      || Number(value.slice(0, 4)) < 1900) fail('invalid-month');
  return value;
}
function dayKey(value, month) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !value.startsWith(month + '-')) fail('invalid-day');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('invalid-day');
  return value;
}
function employeeNumber(value) {
  if (!['string', 'number'].includes(typeof value)) fail('invalid-employee-number');
  const out = String(value);
  if (!out || out.length > 64 || /[\u0000-\u001f\u007f/]/.test(out)) fail('invalid-employee-number');
  return out;
}
function safeText(value) {
  if (value == null) return '';
  if (typeof value !== 'string') fail('invalid-text');
  return value; // No silent trimming of names, reasons, or dates.
}
function hoursValue(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('invalid-hours');
  return value;
}
function reportState(report) {
  if (report === null) return 'missing';
  if (!plain(report)) fail('report-not-read');
  const status = own(report, 'status') ? report.status : 'draft';
  if (!['draft', 'submitted', 'approved'].includes(status)) fail('invalid-report-status');
  return status;
}
function projectEmployeeHours(input) {
  if (!plain(input) || !own(input, 'report') || !Array.isArray(input.attendance)) fail('sources-not-read');
  const month = monthKey(input.month), person = input.employee;
  if (!plain(person) || typeof person.uid !== 'string' || !person.uid
      || person.uid.length > 128 || /[\u0000-\u001f\u007f/]/.test(person.uid)) fail('invalid-employee');
  const emp = employeeNumber(person.employee_number), report = input.report, state = reportState(report);
  // Identity comes from the authenticated directory adapter, never report.uid.
  // A conflicting report is not a safe basis for a reminder or hours projection.
  if (report !== null && (report.month !== month || employeeNumber(report.emp_number) !== emp
      || (own(report, 'uid') && report.uid !== person.uid))) fail('report-identity-mismatch');
  let declaredDays = null, storedTotal = null;
  if (report !== null) {
    if (!Array.isArray(report.days)) fail('invalid-report-days');
    declaredDays = report.days.map(day => dayKey(day, month));
    if (new Set(declaredDays).size !== declaredDays.length) fail('duplicate-report-day');
    declaredDays.sort();
    storedTotal = hoursValue(report.total_hours);
  }
  const seen = new Set();
  const rows = input.attendance.map(record => {
    if (!plain(record) || record.month !== month || employeeNumber(record.emp_number) !== emp
        || (own(record, 'uid') && record.uid !== person.uid)) fail('attendance-identity-mismatch');
    const date = dayKey(record.date, month);
    if (seen.has(date)) fail('duplicate-attendance-day');
    seen.add(date);
    const out = { date, hours: hoursValue(record.hours) };
    for (const field of ['day_type', 'day_type_he', 'start', 'end', 'start2', 'end2',
      'site_name', 'sub_station', 'notes', 'overtime_reason', 'reason', 'status']) out[field] = safeText(record[field]);
    for (const field of ['end_day', 'end_day2']) {
      if (record[field] != null && ![0, 1, 2].includes(record[field])) fail('invalid-end-day');
      out[field] = record[field] == null ? null : record[field];
    }
    return Object.freeze(out);
  }).sort((a, b) => a.date.localeCompare(b.date));
  const warnings = [];
  const detailTotal = rows.some(row => row.hours === null) ? null
    : Math.round(rows.reduce((sum, row) => sum + row.hours, 0) * 100) / 100;
  if (detailTotal !== null && !Number.isFinite(detailTotal)) fail('invalid-hours-aggregate');
  if (rows.some(row => row.hours === null)) warnings.push('detail-hours-missing');
  if (declaredDays !== null) {
    const declared = new Set(declaredDays);
    if (declaredDays.some(day => !seen.has(day))) warnings.push('reported-day-detail-missing');
    if (rows.some(row => !declared.has(row.date))) warnings.push('detail-day-not-in-report');
    if (storedTotal === null) warnings.push('reported-total-missing');
    if (storedTotal !== null && detailTotal !== null && Math.abs(storedTotal - detailTotal) > 0.005) warnings.push('reported-total-differs');
  }
  return Object.freeze({
    month, uid: person.uid, employee_number: emp, full_name: safeText(person.full_name),
    crew: safeText(person.crew), state, label: STATES[state],
    // These are different facts; do not replace one with the other in UI.
    stored_total_hours: storedTotal,
    current_detail_total_hours: rows.length ? detailTotal : null,
    declared_day_keys: declaredDays === null ? null : Object.freeze(declaredDays),
    detail_provenance: 'current_attendance_not_historical_snapshot',
    rows: Object.freeze(rows), warnings: Object.freeze(warnings),
    next_action: state === 'approved' ? 'none' : state === 'submitted' ? 'command_approval'
      : state === 'missing' ? 'employee_submit' : 'employee_confirm'
  });
}
function employeeReminderTargets(projections) {
  if (!Array.isArray(projections)) fail('invalid-projections');
  const targets = new Map(), states = new Map();
  for (const item of projections) {
    if (!plain(item) || !own(STATES, item.state) || typeof item.uid !== 'string') fail('invalid-projection');
    const key = JSON.stringify([item.uid, monthKey(item.month)]);
    if (states.has(key) && states.get(key) !== item.state) fail('conflicting-projections');
    states.set(key, item.state);
    if (!['missing', 'draft'].includes(item.state)) continue;
    const target = Object.freeze({ uid: item.uid, month: monthKey(item.month),
      action: item.state === 'missing' ? 'employee_submit' : 'employee_confirm' });
    targets.set(key, target);
  }
  // Intent only. Adapter MUST re-read canonical member/report state at dispatch.
  return Object.freeze([...targets.values()]);
}
module.exports = Object.freeze({ HrHoursInputError, STATES, monthKey, reportState,
  projectEmployeeHours, employeeReminderTargets });
