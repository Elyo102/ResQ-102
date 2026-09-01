'use strict';

// Live, station-scoped schedule-management access.
//
// This is deliberately separate from the person's primary application role.
// A firefighter, commander or HR coordinator can also be a schedule manager,
// while removing this record immediately removes only the schedule capability.

const SCHEDULE_ACCESS_SCHEMA_VERSION = 1;
const SCHEDULE_MANAGER_ROLE = 'schedule_manager';
const ID_RE = /^[A-Za-z0-9_-]{2,120}$/;
// Firebase auth UIDs are document-key segments, not station/request ids.
// They may contain a dot; slash/control are forbidden because they cannot be
// addressed as one Firestore document id in this data model.
const AUTH_UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/;

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validId(value) {
  return ID_RE.test(String(value || ''));
}

function validUid(value) {
  return AUTH_UID_RE.test(typeof value === 'string' ? value : '');
}

function liveStation(user) {
  if (!plain(user)) return { ok: false, stationId: '' };
  const fields = ['stationId', 'station_id', 'station'];
  const values = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(user, field)) continue;
    const value = user[field];
    if (value === '' || value == null) continue;
    if (!nonEmptyString(value) || !validId(value.trim())) return { ok: false, stationId: '' };
    values.push(value.trim());
  }
  if (!values.length) return { ok: false, stationId: '' };
  if (values.some((value) => value !== values[0])) return { ok: false, stationId: '' };
  return { ok: true, stationId: values[0] };
}

function activeMember(user, stationId) {
  const resolved = liveStation(user);
  return resolved.ok && resolved.stationId === stationId &&
    user.is_active !== false && user.active !== false;
}

function isManagerAccess(access, stationId, uid) {
  if (!plain(access) || !validId(stationId) || !validUid(uid)) return false;
  if (access.schema_version !== SCHEDULE_ACCESS_SCHEMA_VERSION || access.active !== true) return false;
  if (access.station_id !== stationId || access.uid !== uid) return false;
  if (!Number.isSafeInteger(access.revision) || access.revision < 1) return false;
  if (!Array.isArray(access.roles) || access.roles.length !== 1) return false;
  return access.roles[0] === SCHEDULE_MANAGER_ROLE;
}

function nextRecord(previous, stationId, uid, enabled) {
  if (!validId(stationId) || !validUid(uid) || typeof enabled !== 'boolean') {
    throw new TypeError('invalid schedule access input');
  }
  const prior = plain(previous) ? previous : {};
  const revision = Number.isSafeInteger(prior.revision) && prior.revision >= 0
    ? prior.revision + 1 : 1;
  return Object.freeze({
    schema_version: SCHEDULE_ACCESS_SCHEMA_VERSION,
    station_id: stationId,
    uid,
    roles: enabled ? [SCHEDULE_MANAGER_ROLE] : [],
    active: enabled,
    revision
  });
}

module.exports = Object.freeze({
  SCHEDULE_ACCESS_SCHEMA_VERSION,
  SCHEDULE_MANAGER_ROLE,
  validId,
  validUid,
  liveStation,
  activeMember,
  isManagerAccess,
  nextRecord
});
