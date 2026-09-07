'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { projectEmployeeHours: project, reportState, employeeReminderTargets: targets,
  monthKey, HrHoursInputError } = require('./hr-hours-model');
const employee = { uid: 'employee.01', employee_number: '1001', full_name: 'עובד בדיקה', crew: 'A' };
const row = (patch = {}) => ({ uid: employee.uid, emp_number: '1001', month: '2026-09',
  date: '2026-09-01', hours: 24, day_type: 'regular', start: '08:00', end: '08:00', end_day: 1, ...patch });
// Shape mirrors attendance.html writeReport; deliberately NO invented exists.
const report = (patch = {}) => ({ uid: employee.uid, emp_number: '1001', month: '2026-09',
  status: 'submitted', days: ['2026-09-01'], total_hours: 24, ...patch });
const input = (patch = {}) => ({ month: '2026-09', employee, report: report(), attendance: [row()], ...patch });
const rejects = (fn, code) => assert.throws(fn, e => e instanceof HrHoursInputError && e.code === code);

for (const status of ['draft', 'submitted', 'approved']) test('real status without exists: ' + status, () => {
  assert.equal(project(input({ report: report({ status }) })).state, status);
});
test('approved without signatures remains approved, no reminder', () => {
  const value = project(input({ report: report({ status: 'approved' }) }));
  assert.equal(value.next_action, 'none'); assert.deepEqual(targets([value]), []);
});
test('signatures never replace report status', () => {
  assert.equal(project(input({ report: report({ signatures: { employee: {}, commander: {} } }) })).state, 'submitted');
});
test('missing status follows existing report reader draft convention', () => {
  const value = report(); delete value.status;
  assert.equal(project(input({ report: value })).state, 'draft');
});
test('only explicit null after successful read means missing', () => {
  const value = project(input({ report: null, attendance: [] }));
  assert.equal(value.state, 'missing'); assert.equal(value.stored_total_hours, null);
  assert.equal(value.current_detail_total_hours, null); assert.equal(value.next_action, 'employee_submit');
});
test('no report but current attendance is not lost', () => {
  const value = project(input({ report: null }));
  assert.equal(value.state, 'missing'); assert.equal(value.rows.length, 1);
  assert.equal(value.current_detail_total_hours, 24); assert.equal(value.stored_total_hours, null);
});
test('undefined report is not missing', () => rejects(() => project(input({ report: undefined })), 'report-not-read'));
test('omitted read and omitted attendance fail closed', () => {
  const value = input(); delete value.report;
  rejects(() => project(value), 'sources-not-read');
  rejects(() => project(input({ attendance: undefined })), 'sources-not-read');
});
test('failed/malformed report is not missing', () => {
  rejects(() => project(input({ report: new Error('read failed') })), 'report-not-read');
  rejects(() => project(input({ report: {} })), 'report-identity-mismatch');
});
test('stored totals retained, current detail discrepancy visible', () => {
  const value = project(input({ report: report({ total_hours: 22 }) }));
  assert.equal(value.stored_total_hours, 22); assert.equal(value.current_detail_total_hours, 24);
  assert.ok(value.warnings.includes('reported-total-differs'));
  assert.equal(value.detail_provenance, 'current_attendance_not_historical_snapshot');
});
test('report days remain keys, missing and extra current days flagged', () => {
  const value = project(input({ attendance: [row({ date: '2026-09-02' })] }));
  assert.deepEqual(value.declared_day_keys, ['2026-09-01']);
  assert.deepEqual(value.warnings, ['reported-day-detail-missing', 'detail-day-not-in-report']);
});
test('split shift preserved without recalculating hours', () => {
  const value = project(input({ attendance: [row({ hours: 8, start2: '18:00', end2: '22:00', end_day2: 0 })] }));
  assert.equal(value.rows[0].start2, '18:00'); assert.equal(value.rows[0].end2, '22:00');
  assert.equal(value.rows[0].hours, 8);
});
test('unknown hours are not converted to zero', () => {
  const value = project(input({ attendance: [row({ hours: null })] }));
  assert.equal(value.current_detail_total_hours, null); assert.ok(value.warnings.includes('detail-hours-missing'));
});
test('documented two-day offsets survive projection for both segments', () => {
  const value = project(input({ attendance: [row({ hours: 48, end_day: 2, end_day2: 2 })] }));
  assert.equal(value.rows[0].end_day, 2); assert.equal(value.rows[0].end_day2, 2);
  assert.equal(value.rows[0].hours, 48);
  for (const offset of ['same', 'next', 3, -1]) {
    rejects(() => project(input({ attendance: [row({ end_day: offset })] })), 'invalid-end-day');
  }
});
test('finite input cannot return infinite rounded or summed hours', () => {
  rejects(() => project(input({ attendance: [row({ hours: 1e307 })] })), 'invalid-hours-aggregate');
  rejects(() => project(input({ attendance: [row({ hours: 1e308 }), row({ date: '2026-09-02', hours: 1e308 })] })), 'invalid-hours-aggregate');
});
test('zero and ordinary fractional detail hours are retained', () => {
  assert.equal(project(input({ attendance: [row({ hours: 0 })] })).current_detail_total_hours, 0);
  assert.equal(project(input({ attendance: [row({ hours: 8.58 })] })).current_detail_total_hours, 8.58);
});
for (const patch of [{ uid: 'other' }, { emp_number: 'other' }, { month: '2026-08' }]) {
  test('report identity mismatch ' + JSON.stringify(patch), () => rejects(() => project(input({ report: report(patch) })), 'report-identity-mismatch'));
  test('attendance identity mismatch ' + JSON.stringify(patch), () => rejects(() => project(input({ attendance: [row(patch)] })), 'attendance-identity-mismatch'));
}
for (const value of ['2026-00', '2026-13', '2026-9', '../2026', null]) test('invalid month ' + value, () => rejects(() => monthKey(value), 'invalid-month'));
test('impossible calendar day rejected', () => rejects(() => project(input({ attendance: [row({ date: '2026-09-31' })] })), 'invalid-day'));
test('duplicate attendance and report dates rejected', () => {
  rejects(() => project(input({ attendance: [row(), row()] })), 'duplicate-attendance-day');
  rejects(() => project(input({ report: report({ days: ['2026-09-01', '2026-09-01'] }) })), 'duplicate-report-day');
});
test('object-valued frozen day invention rejected', () => rejects(() => project(input({ report: report({ days: [row()] }) })), 'invalid-day'));
for (const hours of [-1, NaN, Infinity, '24']) test('invalid hours ' + String(hours), () => rejects(() => project(input({ attendance: [row({ hours })] })), 'invalid-hours'));
test('bulk nudges exclude submitted and approved, deduplicate month+uid', () => {
  const draft = project(input({ report: report({ status: 'draft' }) }));
  const submitted = { ...project(input()), uid: 'employee.02' };
  const approved = { ...project(input({ report: report({ status: 'approved' }) })), uid: 'employee.03' };
  assert.deepEqual(targets([draft, draft, submitted, approved]), [{ uid: employee.uid, month: '2026-09', action: 'employee_confirm' }]);
});
test('stale draft cannot survive a conflicting approved projection', () => {
  const draft = project(input({ report: report({ status: 'draft' }) }));
  const approved = project(input({ report: report({ status: 'approved' }) }));
  rejects(() => targets([draft, approved]), 'conflicting-projections');
  rejects(() => targets([approved, draft]), 'conflicting-projections');
});
test('missing recipient gets submission request, not claimed confirmation', () => {
  assert.equal(targets([project(input({ report: null }))])[0].action, 'employee_submit');
});
test('reserved uid values do not modify object prototype', () => {
  const person = { ...employee, uid: '__proto__' };
  const value = project(input({ employee: person, report: null, attendance: [] }));
  assert.equal(targets([value])[0].uid, '__proto__'); assert.equal(Object.prototype.action, undefined);
});
test('source contract pins date key shape and persisted status names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'attendance.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /const saved = Object\.keys\(records\)\.sort\(\)/);
  assert.match(source, /days: saved/);
  for (const status of ['draft', 'submitted', 'approved']) assert.ok(source.includes("status: '" + status + "'"));
});
