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
  ['sick', 'מחלה', false], ['reserve', 'מילואים', false]
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

module.exports = Object.freeze({ calcHours, dayTypeHe, reasonWhy, calculateAttendanceDerived });
