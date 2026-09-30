'use strict';

// Transactional, bounded protection for supported attendance offsets (0..2).
// Calendar coordinates are civil minutes, deliberately independent of DST.
// This does not search arbitrary historical imports with offsets beyond two.
const ABSENCES = new Set(['vacation', 'sick', 'reserve']);
const TIMED = new Set(['regular', 'swap', 'extra', 'meeting', 'guard', 'reserve_shift']);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function fail(message) {
  const error = new Error(message);
  error.code = 'failed-precondition';
  throw error;
}
function dayNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('Invalid attendance date');
  const value = Date.parse(date + 'T00:00:00.000Z');
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) fail('Invalid attendance date');
  return value / 86400000;
}
function shiftedDate(date, offset) {
  return new Date((dayNumber(date) + offset) * 86400000).toISOString().slice(0, 10);
}
function clockMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('Invalid attendance interval');
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}
function segment(row, startKey, endKey, offsetKey, strict) {
  const start = clockMinutes(row[startKey]), end = clockMinutes(row[endKey]);
  let offset = row[offsetKey];
  if (!strict && (offset === undefined || offset === null || offset === '')) offset = end <= start ? 1 : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > (strict ? 1 : 2)) fail('Invalid attendance day offset');
  const duration = end + offset * 1440 - start;
  if (strict && row.reserve_calculation_version !== undefined && ![1, 2].includes(row.reserve_calculation_version)) fail('Invalid reserve calculation version');
  if (duration <= 0 || (strict && (row.reserve_calculation_version === 2 ? duration >= 2880 : duration > 1440))) fail('Invalid attendance interval duration');
  const origin = dayNumber(row.date) * 1440;
  return { start: origin + start, end: origin + end + offset * 1440 };
}
function attendanceIntervals(row) {
  if (!plain(row)) fail('Invalid attendance record');
  dayNumber(row.date);
  if (ABSENCES.has(row.day_type)) return [];
  if (!TIMED.has(row.day_type)) fail('Invalid attendance day type');
  const reserve = row.day_type === 'reserve_shift';
  if (reserve && (row.shape !== 'regular' || (row.start2 !== undefined && row.start2 !== '')
      || (row.end2 !== undefined && row.end2 !== '') || (row.end_day2 !== undefined && row.end_day2 !== 0))) {
    fail('Reserve duty requires one regular interval');
  }
  const out = [segment(row, 'start', 'end', 'end_day', reserve)];
  const secondStart = row.start2 !== undefined && row.start2 !== null && row.start2 !== '';
  const secondEnd = row.end2 !== undefined && row.end2 !== null && row.end2 !== '';
  if (secondStart !== secondEnd) fail('Incomplete attendance interval');
  if (secondStart) out.push(segment(row, 'start2', 'end2', 'end_day2', false));
  return out;
}
function intervalsOverlap(a, b) { return Math.max(a.start, b.start) < Math.min(a.end, b.end); }
function validateIdentity(row, date, employeeNumber, uid) {
  if (!plain(row) || row.date !== date || row.month !== date.slice(0, 7)
      || !['string', 'number'].includes(typeof row.emp_number) || String(row.emp_number) !== employeeNumber
      || (own(row, 'uid') && row.uid !== uid)) fail('Attendance neighbor identity is invalid');
}

// candidates: final row objects being saved (not patches or before-images).
// knownRows: Map<ISO date, row|null>, backed by this transaction's reads.
// Callers may supply the complete month, including confirmed absent dates.
// Exact receipt replays should return BEFORE invoking this guard.
async function assertReserveShiftNoOverlap({ tx, root, employeeNumber, uid, candidates, knownRows = new Map() }) {
  if (!tx || typeof tx.get !== 'function' || !root || typeof root.collection !== 'function'
      || typeof employeeNumber !== 'string' || !employeeNumber || employeeNumber.length > 64
      || /[\u0000-\u001f\u007f/]/.test(employeeNumber) || typeof uid !== 'string' || !uid
      || !Array.isArray(candidates) || candidates.length > 31 || !(knownRows instanceof Map)) fail('Invalid overlap context');
  const final = new Map(), candidateDates = new Set();
  for (const row of candidates) {
    if (!plain(row)) fail('Invalid attendance candidate');
    dayNumber(row.date);
    validateIdentity(row, row.date, employeeNumber, uid);
    if (candidateDates.has(row.date)) fail('Duplicate attendance candidate');
    candidateDates.add(row.date);
    final.set(row.date, { row, intervals: row.day_type === 'reserve_shift' ? attendanceIntervals(row) : null });
  }
  const needed = new Set();
  for (const { row } of final.values()) if (!ABSENCES.has(row.day_type)) {
    for (let offset = -2; offset <= 2; offset++) {
      const date = shiftedDate(row.date, offset);
      if (!candidateDates.has(date)) needed.add(date);
    }
  }
  // All reads finish before validation returns and before callers may write.
  const missing = [...needed].filter(date => !knownRows.has(date)).sort();
  const snapshots = await Promise.all(missing.map(date => tx.get(root.collection('attendance').doc(employeeNumber + '_' + date))));
  const fetched = new Map(missing.map((date, i) => [date, snapshots[i].exists ? snapshots[i].data() : null]));
  for (const date of needed) {
    const row = knownRows.has(date) ? knownRows.get(date) : fetched.get(date);
    if (row === null) continue;
    validateIdentity(row, date, employeeNumber, uid);
    final.set(date, { row, intervals: null });
  }
  const entries = [...final.values()];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (!candidateDates.has(a.row.date) && !candidateDates.has(b.row.date)) continue;
    if (a.row.day_type !== 'reserve_shift' && b.row.day_type !== 'reserve_shift') continue;
    // Unrelated ordinary legacy rows must not acquire new interval validation.
    // Parse them only when they participate in this reserve-specific policy.
    if (a.intervals === null) a.intervals = attendanceIntervals(a.row);
    if (b.intervals === null) b.intervals = attendanceIntervals(b.row);
    if (a.intervals.some(left => b.intervals.some(right => intervalsOverlap(left, right)))) {
      fail('Attendance overlaps a reserve duty shift');
    }
  }
}

module.exports = Object.freeze({ assertReserveShiftNoOverlap, attendanceIntervals, intervalsOverlap, shiftedDate });
