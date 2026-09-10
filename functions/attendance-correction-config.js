'use strict';

// Trusted Firestore adapter for attendance correction calculations. It reads
// only bounded station configuration inside the caller's transaction; it never
// accepts station, role or site configuration from the browser.
const access = require('./schedule-access');
const MAX_ROTATIONS = 20;
const MAX_SITES = 31;
const ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader', 'deputy', 'commander',
  'station_commander', 'hr_coordinator', 'district_commander'
]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const compareId = (left, right) => left < right ? -1 : (left > right ? 1 : 0);
const validRotationId = value => typeof value === 'string' && value.length >= 1 && value.length <= 128
  && !/[\/\u0000-\u001f\u007f]/.test(value);

function createAttendanceCorrectionConfigReader({ db, HttpsError }) {
  if (!db || typeof db.collection !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db and HttpsError are required');
  }
  const fail = (code, message) => { throw new HttpsError(code, message); };
  function hours(value, fallback, label) {
    if (value === undefined) return fallback;
    if (!['string', 'number'].includes(typeof value) || value === '') {
      fail('failed-precondition', label + ' is invalid.');
    }
    const out = Number(value);
    if (!Number.isFinite(out) || out <= 0 || out > 48) {
      fail('failed-precondition', label + ' is invalid.');
    }
    return out;
  }
  return async function readAttendanceCorrectionConfig(tx, input) {
    const stationId = input && input.stationId;
    const role = input && input.targetRole;
    const ids = input && input.subStationIds;
    if (!tx || typeof tx.get !== 'function' || !access.validId(stationId)
        || !ROLES.includes(role) || !Array.isArray(ids) || ids.length > MAX_SITES
        || ids.some(id => typeof id !== 'string' || (id !== '' && !access.validId(id)))) {
      fail('failed-precondition', 'Trusted attendance calculation request is invalid.');
    }
    const root = db.collection('stations').doc(stationId);
    const rotations = await tx.get(root.collection('rotations').limit(MAX_ROTATIONS + 1));
    if (!rotations || !Array.isArray(rotations.docs)) {
      fail('failed-precondition', 'Attendance rotation configuration is invalid.');
    }
    if (rotations.docs.length > MAX_ROTATIONS) {
      fail('resource-exhausted', 'Attendance rotation configuration is too large.');
    }
    if (Number.isInteger(rotations.size) && rotations.size !== rotations.docs.length) {
      fail('failed-precondition', 'Attendance rotation configuration is invalid.');
    }
    const rows = rotations.docs.map(doc => ({ id: doc.id, value: doc.data() }))
      .sort((left, right) => compareId(left.id, right.id));
    if (rows.some(row => !validRotationId(row.id) || !plain(row.value)
        || (own(row.value, 'is_active') && typeof row.value.is_active !== 'boolean'))) {
      fail('failed-precondition', 'Attendance rotation configuration is invalid.');
    }
    const active = rows.find(row => row.value.is_active !== false);
    if (!active) fail('failed-precondition', 'Active attendance rotation configuration is missing.');
    const shiftHours = role === 'commander'
      ? hours(active.value.commander_shift_hours, 24.25, 'Commander shift hours')
      : hours(active.value.shift_hours, 24, 'Shift hours');
    const siteIds = [...new Set(ids.filter(Boolean))];
    const siteSnaps = await Promise.all(siteIds.map(id => tx.get(root.collection('sub_stations').doc(id))));
    const siteById = Object.create(null);
    siteSnaps.forEach((snap, index) => {
      const value = snap && snap.exists ? snap.data() : null;
      const state = plain(value) ? String(value.status || '').toLowerCase() : '';
      if (!plain(value) || value.is_active === false || value.active === false
          || value.archived === true || state === 'inactive' || state === 'archived'
          || typeof value.name !== 'string' || value.name.length > 500) {
        fail('failed-precondition', 'Attendance sub-station configuration is unavailable.');
      }
      let fixed = 0;
      if (value.fixed_hours !== undefined && value.fixed_hours !== '') {
        if (!['string', 'number'].includes(typeof value.fixed_hours)) {
          fail('failed-precondition', 'Sub-station hours are invalid.');
        }
        fixed = Number(value.fixed_hours);
        if (!Number.isFinite(fixed) || fixed < 0 || fixed > 48) {
          fail('failed-precondition', 'Sub-station hours are invalid.');
        }
      }
      siteById[siteIds[index]] = Object.freeze({ fixed_hours: fixed, name: value.name });
    });
    return Object.freeze({ siteById: Object.freeze(siteById), shiftHours });
  };
}

module.exports = Object.freeze({
  createAttendanceCorrectionConfigReader, MAX_ROTATIONS, MAX_SITES, ROLES
});
