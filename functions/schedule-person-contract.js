'use strict';

class SchedulePersonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedulePersonError';
    this.code = code;
  }
}

const PERSON_ID = /^sp_[a-z0-9][a-z0-9_-]{7,63}$/;
const STATION_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const KINDS = Object.freeze(['registered', 'external']);
const SOURCE_NAMESPACE = 'station-workbook-v1';
const STORED_FIELDS = Object.freeze([
  'schema_version', 'person_id', 'station_id', 'kind', 'linked_uid',
  'display_name', 'active', 'revision', 'source_ref'
]);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validUid(value) {
  const uid = text(value);
  return uid.length >= 1 && uid.length <= 128 && !uid.startsWith('sp_')
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(uid);
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}

function normalizeSourceRef(value, stationId) {
  if (value === null) return null;
  if (!exactKeys(value, ['station_id', 'source_namespace', 'source_key'])
      || value.station_id !== stationId || value.source_namespace !== SOURCE_NAMESPACE
      || !exactKeys(value.source_key, ['kind', 'value'])
      || (value.source_key.kind !== 'employee' && value.source_key.kind !== 'name')) {
    throw new SchedulePersonError('source-ref', 'מקור זהות האדם אינו תקין או שייך לתחנה אחרת.');
  }
  const sourceValueRaw = text(value.source_key.value);
  const sourceValue = value.source_key.kind === 'name'
    ? sourceValueRaw.normalize('NFC')
    : sourceValueRaw;
  if (!sourceValue || sourceValue.length > 128
      || /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(sourceValue)) {
    throw new SchedulePersonError('source-ref', 'מפתח מקור זהות האדם אינו תקין.');
  }
  return Object.freeze({ station_id: stationId, source_namespace: SOURCE_NAMESPACE,
    source_key: Object.freeze({ kind: value.source_key.kind, value: sourceValue }) });
}

function normalizeSchedulePerson(value) {
  if (!plain(value)) throw new SchedulePersonError('person-shape', 'אדם בסידור חייב להיות עצם.');
  if (!exactKeys(value, STORED_FIELDS) || value.schema_version !== 1) {
    throw new SchedulePersonError('person-shape', 'רשומת אדם שמורה אינה תואמת לחוזה הסגור.');
  }
  const personId = text(value.person_id);
  const stationId = text(value.station_id);
  const kind = text(value.kind);
  const displayName = text(value.display_name);
  const linkedUid = value.linked_uid === null ? null : text(value.linked_uid);
  const revision = value.revision;
  const active = value.active;

  if (!PERSON_ID.test(personId)) throw new SchedulePersonError('person-id', 'מזהה אדם בסידור אינו תקין.');
  if (!STATION_ID.test(stationId)) throw new SchedulePersonError('station-id', 'מזהה תחנה אינו תקין.');
  if (!KINDS.includes(kind)) throw new SchedulePersonError('person-kind', 'סוג אדם בסידור אינו תקין.');
  if (!displayName || displayName.length > 120) throw new SchedulePersonError('display-name', 'שם תצוגה אינו תקין.');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new SchedulePersonError('person-revision', 'גרסת אדם אינה תקינה.');
  }
  if (typeof active !== 'boolean') throw new SchedulePersonError('person-active', 'מצב אדם אינו תקין.');
  if (kind === 'registered' && !linkedUid) throw new SchedulePersonError('registered-link-required', 'אדם רשום חייב להיות מקושר לחשבון.');
  if (kind === 'external' && linkedUid !== null) throw new SchedulePersonError('external-link-forbidden', 'אדם חיצוני אינו יכול לשאת UID.');
  if (linkedUid !== null && !validUid(linkedUid)) throw new SchedulePersonError('linked-uid', 'מזהה החשבון אינו תקין או מתנגש במרחב מזהי הסידור.');
  const sourceRef = normalizeSourceRef(value.source_ref, stationId);
  if (kind === 'external' && sourceRef === null) {
    throw new SchedulePersonError('external-source-required', 'אדם חיצוני חייב לשמור מקור זהות קבוע.');
  }

  return Object.freeze({
    schema_version: 1,
    person_id: personId,
    station_id: stationId,
    kind,
    linked_uid: linkedUid,
    display_name: displayName,
    active,
    revision,
    source_ref: sourceRef
  });
}

function publicSchedulePerson(value) {
  const person = normalizeSchedulePerson(value);
  return Object.freeze({
    person_id: person.person_id,
    station_id: person.station_id,
    display_name: person.display_name,
    active: person.active
  });
}

function managementSchedulePerson(value) {
  const person = normalizeSchedulePerson(value);
  return Object.freeze({
    person_id: person.person_id,
    station_id: person.station_id,
    display_name: person.display_name,
    active: person.active,
    kind: person.kind,
    linked: person.linked_uid !== null,
    revision: person.revision
  });
}

module.exports = Object.freeze({
  SchedulePersonError,
  KINDS,
  validUid,
  normalizeSchedulePerson,
  publicSchedulePerson,
  managementSchedulePerson
});
