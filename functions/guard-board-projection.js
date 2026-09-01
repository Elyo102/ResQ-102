'use strict';

// Guard board read projections.
//
// A guard document is an operational record: it also contains notes,
// interest lists and audit data.  The browser must never receive that record
// as-is.  This module constructs four explicit allow-list projections for
// the server callable boundary:
//   * member board       — upcoming guards plus only the viewer's own state;
//   * manager board      — the details needed to assign and edit;
//   * personal attendance— only guards assigned to the authenticated user;
//   * load rows          — assignment/time data for an authorised aggregate.
//
// There is intentionally no "copy then delete" helper here.  A new field on
// a Firestore document is not a reason for that field to reach a phone.

const ID_RE = /^[A-Za-z0-9_-]{2,120}$/;
const AUTH_UID_RE = /^[^\u0000-\u001F\u007F/]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const STATUSES = Object.freeze(['open', 'staffed', 'done', 'cancelled']);
const KINDS = Object.freeze(['sport', 'show', 'hotwork', 'crowd', 'school', 'other']);
const MAX_ASSIGNED = 20;
const MAX_SIGNUPS = 1000;
const MAX_GUARDS = 1000;

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

function cleanText(value, maximum) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= maximum && !CONTROL_RE.test(result) ? result : null;
}

function optionalText(value, maximum) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result.length <= maximum && !CONTROL_RE.test(result) ? result : '';
}

function activeUids(roster) {
  const result = Object.create(null);
  if (!Array.isArray(roster)) return result;
  roster.forEach((entry) => {
    if (!plain(entry) || typeof entry.uid !== 'string' || !AUTH_UID_RE.test(entry.uid)) return;
    if (entry.active === false || entry.is_active === false) return;
    result[entry.uid] = true;
  });
  return result;
}

function dateSet(dates) {
  const result = Object.create(null);
  if (!Array.isArray(dates) || !dates.length) return null;
  for (const value of dates) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
    result[value] = true;
  }
  return result;
}

function cleanAssigned(value) {
  const source = value === undefined || value === null ? [] : value;
  if (!Array.isArray(source) || source.length > MAX_ASSIGNED) return null;
  const seen = Object.create(null);
  for (const uid of source) {
    if (typeof uid !== 'string' || !AUTH_UID_RE.test(uid)) return null;
    seen[uid] = true;
  }
  return Object.keys(seen).sort(compare);
}

function cleanQualifications(value) {
  const source = value === undefined || value === null ? [] : value;
  if (!Array.isArray(source) || source.length > 12) return [];
  const seen = Object.create(null);
  for (const id of source) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return [];
    seen[id] = true;
  }
  return Object.keys(seen).sort(compare);
}

function cleanSignups(value, liveUids) {
  if (value === undefined || value === null) return [];
  if (!plain(value)) return [];
  const keys = Object.keys(value);
  if (keys.length > MAX_SIGNUPS) return [];
  const result = [];
  keys.sort(compare).forEach((uid) => {
    if (!AUTH_UID_RE.test(uid)) return;
    const entry = plain(value[uid]) ? value[uid] : {};
    // A former station member must not continue to appear in the manager's
    // candidate list.  Their historic interest remains in the server record.
    if (!liveUids[uid]) return;
    result.push(Object.freeze({
      uid,
      name: optionalText(entry.name, 120),
      crew: optionalText(entry.crew, 40)
    }));
  });
  return result;
}

function candidate(id, raw, allowedDates, stationId) {
  if (typeof id !== 'string' || !ID_RE.test(id) || !plain(raw)) return null;
  if (!allowedDates[String(raw.date || '')]) return null;
  if (typeof raw.title !== 'string' || !cleanText(raw.title, 80)
      || typeof raw.start !== 'string' || !TIME_RE.test(raw.start)
      || typeof raw.end !== 'string' || !TIME_RE.test(raw.end)
      || STATUSES.indexOf(raw.status) === -1
      || !Number.isSafeInteger(raw.slots) || raw.slots < 1 || raw.slots > MAX_ASSIGNED) {
    return null;
  }
  for (const key of ['stationId', 'station_id', 'station']) {
    if (own(raw, key) && raw[key] !== null && raw[key] !== '' && raw[key] !== stationId) return null;
  }
  const assigned = cleanAssigned(raw.assigned);
  if (assigned === null || assigned.length > raw.slots) return null;
  const revision = raw.revision === undefined ? 0 : raw.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) return null;
  return Object.freeze({
    id,
    date: raw.date,
    title: cleanText(raw.title, 80),
    kind: KINDS.indexOf(raw.kind) === -1 ? 'other' : raw.kind,
    place: optionalText(raw.place, 120),
    start: raw.start,
    end: raw.end,
    status: raw.status,
    slots: raw.slots,
    need_quals: Object.freeze(cleanQualifications(raw.need_quals)),
    notes: optionalText(raw.notes, 1000),
    revision,
    assigned: Object.freeze(assigned),
    signups: raw.signups
  });
}

function prepared(input) {
  if (!plain(input) || !Array.isArray(input.guards) || input.guards.length > MAX_GUARDS
      || typeof input.station_id !== 'string' || !ID_RE.test(input.station_id)) return null;
  const dates = dateSet(input.dates);
  if (!dates) return null;
  const liveUids = activeUids(input.roster);
  const result = [];
  input.guards.forEach((entry) => {
    const guard = candidate(entry && entry.id, entry && entry.value, dates, input.station_id);
    if (guard) result.push(guard);
  });
  result.sort((left, right) => left.date !== right.date ? compare(left.date, right.date)
    : (left.start !== right.start ? compare(left.start, right.start) : compare(left.id, right.id)));
  return { guards: result, liveUids };
}

function memberBoard(input) {
  const ready = prepared(input);
  const viewer = plain(input) && typeof input.viewer_uid === 'string' ? input.viewer_uid : '';
  if (!ready || !AUTH_UID_RE.test(viewer) || !ready.liveUids[viewer]) return Object.freeze([]);
  return Object.freeze(ready.guards.map((guard) => {
    const activeAssigned = guard.assigned.filter((uid) => ready.liveUids[uid]);
    const signed = cleanSignups(guard.signups, ready.liveUids).some((entry) => entry.uid === viewer);
    return Object.freeze({
      id: guard.id,
      date: guard.date,
      title: guard.title,
      kind: guard.kind,
      start: guard.start,
      end: guard.end,
      status: guard.status,
      slots: guard.slots,
      assigned_count: activeAssigned.length,
      open_slots: Math.max(guard.slots - activeAssigned.length, 0),
      viewer_assigned: activeAssigned.indexOf(viewer) !== -1,
      viewer_signed_up: signed
    });
  }));
}

function managerBoard(input) {
  const ready = prepared(input);
  if (!ready) return Object.freeze([]);
  return Object.freeze(ready.guards.map((guard) => Object.freeze({
    id: guard.id,
    date: guard.date,
    title: guard.title,
    kind: guard.kind,
    place: guard.place,
    start: guard.start,
    end: guard.end,
    status: guard.status,
    slots: guard.slots,
    need_quals: Object.freeze(guard.need_quals.slice()),
    notes: guard.notes,
    revision: guard.revision,
    assigned: Object.freeze(guard.assigned.slice()),
    signups: Object.freeze(cleanSignups(guard.signups, ready.liveUids))
  })));
}

function personalAttendance(input) {
  const ready = prepared(input);
  const viewer = plain(input) && typeof input.viewer_uid === 'string' ? input.viewer_uid : '';
  if (!ready || !AUTH_UID_RE.test(viewer) || !ready.liveUids[viewer]) return Object.freeze([]);
  return Object.freeze(ready.guards.filter((guard) => guard.assigned.indexOf(viewer) !== -1)
    .map((guard) => Object.freeze({
      id: guard.id,
      date: guard.date,
      title: guard.title,
      start: guard.start,
      end: guard.end,
      status: guard.status
    })));
}

function loadRows(input) {
  const ready = prepared(input);
  if (!ready) return Object.freeze([]);
  return Object.freeze(ready.guards.map((guard) => Object.freeze({
    date: guard.date,
    start: guard.start,
    end: guard.end,
    status: guard.status,
    assigned: Object.freeze(guard.assigned.slice())
  })));
}

module.exports = Object.freeze({
  memberBoard,
  managerBoard,
  personalAttendance,
  loadRows,
  STATUSES,
  KINDS
});
