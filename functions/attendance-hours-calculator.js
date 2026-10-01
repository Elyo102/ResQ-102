'use strict';

// Minimal CommonJS equivalent of the pure hours.js attendance calculation.
// Parity tests read that actual browser module, including its Hebrew strings.
// No Firestore, SDK, global cache, viewer identity or entitlement policy here.
// Configuration MUST come from the calling server transaction. This module
// neither selects a rotation nor infers a person's role from the edited row.
const TYPES = Object.freeze([
  ['regular', 'רגיל', true], ['swap', 'החלפה צרכי מערכת', true],
  ['extra', 'שעות ידני · נע״ת', true], ['meeting', 'ישיבות', true],
  ['guard', 'אבטחה', true], ['vacation', 'חופש', false],
  ['sick', 'מחלה', false], ['reserve', 'מילואים', false],
  ['reserve_shift', 'משמרת בזמן מילואים', true]
]);
const REASONS = ['swap', 'extra', 'meeting'];
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function dayTypeHe(id) { const t = TYPES.find(t => t[0] === id); return t ? t[1] : id; }
function needsTimes(id) { const t = TYPES.find(t => t[0] === id); return !!(t && t[2]); }
function validTime(v) { return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(String(v || '')); }
function segmentHours(start, end, dayOffset) {
  if (!validTime(start) || !validTime(end)) return null;
  const s = String(start).split(':').map(Number), e = String(end).split(':').map(Number);
  let diff = e[0] * 60 + e[1] - (s[0] * 60 + s[1]);
  if (dayOffset == null || dayOffset === '') { if (diff <= 0) diff += 24 * 60; }
  else { diff += Number(dayOffset) * 24 * 60; if (diff <= 0) return null; }
  return Math.round((diff / 60) * 100) / 100;
}
function isSplit(r) { return !!(r.start2 && r.end2); }
function shapeOf(r) {
  if (r.shape) return r.shape;
  if (isSplit(r)) return 'split';
  if (Number(r.end_day || 0) >= 1 && segmentHours(r.start, r.end, r.end_day) > 24) return 'continued';
  return 'regular';
}
function calcHours(record, siteHours) {
  const r = record || {};
  if (r.day_type === 'vacation') return 24;
  if (r.day_type === 'sick') return 0;
  if (r.day_type === 'reserve') return 8.5;
  if (r.day_type === 'reserve_shift') {
    if (r.shape !== 'regular' || !Number.isInteger(r.end_day) || ![0, 1].includes(r.end_day)
        || r.start2 || r.end2 || (r.end_day2 != null && r.end_day2 !== 0)) return null;
    const hours = segmentHours(r.start, r.end, r.end_day);
    if (r.reserve_calculation_version !== undefined && ![1, 2].includes(r.reserve_calculation_version)) return null;
    const v2 = r.reserve_calculation_version === 2;
    if (!Number.isFinite(hours) || hours <= 0 || (v2 ? hours >= 48 : hours > 24)) return null;
    return v2 ? Math.round((hours + 8.5) * 100) / 100 : hours;
  }
  const fixed = Number(siteHours || 0);
  if (fixed > 0) return fixed;
  const first = segmentHours(r.start, r.end, r.end_day);
  if (first == null) return null;
  if (!isSplit(r)) return first;
  const second = segmentHours(r.start2, r.end2, r.end_day2);
  if (second == null) return null;
  return Math.round((first + second) * 100) / 100;
}
function overtimeHours(r, siteHours, shiftHours) {
  if (!needsTimes(r.day_type)) return 0;
  if (r.day_type === 'reserve_shift') return 0;
  const fixed = Number(siteHours || 0), expected = fixed > 0 ? fixed : Number(shiftHours || 24);
  const actual = calcHours(r, siteHours);
  if (actual == null) return 0;
  const extra = Math.round((actual - expected) * 100) / 100;
  return extra > 0 ? extra : 0;
}
function reasonWhy(record, siteHours, shiftHours) {
  const r = record || {};
  if (REASONS.indexOf(r.day_type) !== -1) return dayTypeHe(r.day_type);
  if (!needsTimes(r.day_type)) return '';
  if (calcHours(r, siteHours) == null) return '';
  if (shapeOf(r) === 'continued') return 'המשך משמרת';
  const extra = overtimeHours(r, siteHours, shiftHours);
  return extra > 0 ? extra + ' שעות מעל המשמרת' : '';
}

// config = { siteById: { [id]: { fixed_hours:number, name:string } },
//            shiftHours:number, ...serverAuditProvenance }
// Pure parity exports preserve legacy calculation semantics. This production
// adapter separately rejects malformed server configuration and incomplete
// calculations; it never silently converts null/NaN into payable zero hours.
function calculateAttendanceDerived(record, config) {
  if (!plain(record) || !plain(config) || !plain(config.siteById)
    || typeof config.shiftHours !== 'number' || !Number.isFinite(config.shiftHours) || config.shiftHours <= 0) {
    throw new TypeError('Invalid trusted attendance calculation configuration');
  }
  let fixed = 0, name = '';
  const id = record.sub_station;
  if (id !== undefined && id !== null && id !== '') {
    if (typeof id !== 'string' || !own(config.siteById, id)) throw new TypeError('Requested attendance site is unavailable');
    const site = config.siteById[id];
    if (!plain(site) || !own(site, 'fixed_hours') || !own(site, 'name')
      || typeof site.fixed_hours !== 'number' || !Number.isFinite(site.fixed_hours) || site.fixed_hours < 0
      || typeof site.name !== 'string' || site.name.length > 500) throw new TypeError('Invalid trusted attendance site');
    fixed = site.fixed_hours; name = site.name;
  }
  const hours = calcHours(record, fixed), day_type_he = dayTypeHe(record.day_type);
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0
    || typeof day_type_he !== 'string' || day_type_he.length > 500) throw new TypeError('Attendance calculation is incomplete');
  return { hours, day_type_he, site_name: name, reason_required: reasonWhy(record, fixed, config.shiftHours) !== '' };
}

// New/changed equal clock values require an explicit next-day fact. Historical
// note-only edits and pure legacy calculations retain their previous semantics.
function validateAttendanceEdit(record, before) {
  if (!needsTimes(record.day_type)) return;
  const changed = !before || ['day_type','shape','start','end','end_day','start2','end2','end_day2']
    .some(key => record[key] !== before[key]);
  if (!changed) return;
  for (const [start,end,offset] of [['start','end','end_day'],['start2','end2','end_day2']]) {
    if (record[start] && record[start] === record[end]
      && (!Number.isInteger(record[offset]) || record[offset] <= 0)) {
      throw new TypeError('Equal attendance clocks require an explicit later day');
    }
  }
}
// A correction audit reason does not replace the employee's business reason.
// Only new/material writes enforce this; historical reads and note-only repairs
// retain their original calculation contract.
function validateAttendanceWriteReason(record, before) {
  if (record.day_type !== 'swap') return;
  const fields = ['day_type','shape','start','end','end_day','start2','end2','end_day2','sub_station','overtime_reason'];
  const equivalent = (value, key) => value[key] === undefined
    ? (key === 'shape' ? 'regular' : key === 'end_day2' ? 0
      : ['start2','end2','sub_station','overtime_reason'].includes(key) ? '' : undefined)
    : value[key];
  if (before && !fields.some(key => equivalent(record,key) !== equivalent(before,key))) return;
  if (typeof record.overtime_reason !== 'string' || !record.overtime_reason.trim()) {
    throw new TypeError('החלפה לצורכי מערכת מחייבת נימוק בדיווח.');
  }
}
// Called only by trusted write paths, never on read, submit or month recalculate.
function stampReserveCalculationVersion(record, before) {
  if (record.day_type !== 'reserve_shift') { delete record.reserve_calculation_version; return record; }
  const comparable = (row, key) => row[key] === undefined
    ? (key === 'end_day2' ? 0 : ['start2','end2'].includes(key) ? '' : undefined)
    : row[key];
  const changed = !before || before.day_type !== 'reserve_shift' ||
    ['shape','start','end','end_day','start2','end2','end_day2'].some(k => comparable(record,k) !== comparable(before,k));
  if (changed) record.reserve_calculation_version = 2;
  else if (before.reserve_calculation_version !== undefined) record.reserve_calculation_version = before.reserve_calculation_version;
  else delete record.reserve_calculation_version;
  return record;
}
// An approved course is a payroll overlay, never a mutation of attendance or
// schedule. Only the trusted course reader may supply this argument.
function projectCourseHours(records, course) {
  if (!Array.isArray(records)) throw new TypeError('Invalid attendance rows');
  const credits = course == null ? {} : course.days;
  if (!credits || typeof credits !== 'object' || Array.isArray(credits)
      || (course && (!Number.isSafeInteger(course.revision) || course.revision < 0
      || !/^\d{4}-\d{2}$/.test(course.month)))) throw new TypeError('Invalid trusted course month');
  const rows = new Map();
  for (const row of records) {
    if (!row || typeof row.date !== 'string' || rows.has(row.date)) throw new TypeError('Invalid attendance date set');
    rows.set(row.date, { ...row });
  }
  for (const [date, credit] of Object.entries(credits)) {
    const parsed = new Date(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime())
        || parsed.toISOString().slice(0, 10) !== date || date.slice(0, 7) !== course.month
        || !credit || typeof credit.credit_hours !== 'number' || !Number.isFinite(credit.credit_hours)
        || credit.credit_hours <= 0 || credit.credit_hours > 48 || !credit.case_id
        || !Number.isSafeInteger(credit.approval_revision) || credit.approval_revision < 1) throw new TypeError('Invalid trusted course credit');
    const base = rows.get(date);
    if (base && base.day_type !== 'regular') throw new TypeError('Course conflicts with an attendance absence or special shift');
    rows.set(date, { ...(base || { start: '', end: '', start2: '', end2: '', end_day: null, end_day2: null,
      site_name: '', sub_station: '', notes: '', overtime_reason: '', reason: '', status: '' }),
      date, hours: credit.credit_hours, day_type: 'course', day_type_he: 'קורס',
      course_overlay: true, base_day_type: base ? base.day_type : null,
      course_case_id: credit.case_id, course_approval_revision: credit.approval_revision });
  }
  const days = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
  const total = days.some(row => typeof row.hours !== 'number' || !Number.isFinite(row.hours) || row.hours < 0)
    ? null : Math.round(days.reduce((sum, row) => sum + row.hours, 0) * 100) / 100;
  return { days, total_hours: total };
}
function assertCourseDayCompatible(course, date, candidate) {
  if (course && course.days && Object.prototype.hasOwnProperty.call(course.days, date)
      && candidate && candidate.day_type !== 'regular') throw new TypeError('Approved course must be revised by HR before changing this absence');
}
module.exports = Object.freeze({ calcHours, dayTypeHe, reasonWhy, calculateAttendanceDerived, validateAttendanceEdit, validateAttendanceWriteReason,
  stampReserveCalculationVersion, projectCourseHours, assertCourseDayCompatible });
