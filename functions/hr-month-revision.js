'use strict';
// Snapshot fingerprint only. Trusted callers must read all versions in their
// authorized transaction. This is not authority, consent, or an audit trail:
// absent -> created -> deleted back to absent is not detectable from a snapshot.
const { createHash } = require('node:crypto');
const { validId, validUid } = require('./schedule-access');
const { monthKey } = require('./hr-hours-model');
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Reflect.ownKeys(value).length !== keys.length
      || keys.some(k => !Object.prototype.hasOwnProperty.call(value, k))) throw new TypeError('Invalid revision shape');
}
function version(value) {
  shape(value, ['seconds', 'nanoseconds']);
  if (!Number.isSafeInteger(value.seconds) || value.seconds < -62135596800 || value.seconds > 253402300799
      || !Number.isInteger(value.nanoseconds) || value.nanoseconds < 0 || value.nanoseconds > 999999999) throw new TypeError('Invalid snapshot version');
  return [value.seconds, value.nanoseconds];
}
function createMonthRevision(input) {
  shape(input, ['stationId', 'uid', 'employeeNumber', 'month', 'report', 'attendance']);
  const { stationId, uid, employeeNumber: emp, month, report, attendance } = input;
  if (typeof stationId !== 'string' || !validId(stationId) || !validUid(uid)
      || typeof emp !== 'string' || !emp.length || emp.length > 64 || /[\u0000-\u001f\u007f/]/.test(emp)) throw new TypeError('Invalid revision identity');
  monthKey(month);
  if (!Array.isArray(attendance) || attendance.length > 31) throw new TypeError('Invalid month rows');
  let reportTuple = null;
  if (report !== null) {
    shape(report, ['id', 'version']);
    if (report.id !== emp + '_' + month) throw new TypeError('Invalid report identity');
    reportTuple = [report.id, ...version(report.version)];
  }
  const seen = new Set();
  const rows = Array.from(attendance, row => {
    shape(row, ['id', 'version']);
    if (typeof row.id !== 'string') throw new TypeError('Invalid day identity');
    const day = row.id.slice(-10), date = new Date(day + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.slice(0, 7) !== month
        || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day
        || row.id !== emp + '_' + day || seen.has(row.id)) throw new TypeError('Invalid or duplicate day');
    seen.add(row.id);
    return [row.id, ...version(row.version)];
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(['hr-month-snapshot-v1', stationId, uid, emp, month, reportTuple, rows])).digest('hex');
}
module.exports = Object.freeze({ createMonthRevision });
