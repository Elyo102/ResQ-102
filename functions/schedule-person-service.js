'use strict';

const contract = require('./schedule-person-contract');

class SchedulePersonServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedulePersonServiceError';
    this.code = code;
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireExpectedRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new SchedulePersonServiceError('expected-revision', 'חובה למסור גרסה צפויה תקינה.');
  }
  return value;
}

function requireActor(value, stationId) {
  const actor = value && value.actor;
  if (!actor || actor.authorized !== true || text(actor.uid) !== text(value.actor_uid)
      || text(actor.station_id) !== stationId) {
    throw new SchedulePersonServiceError('actor-forbidden', 'אין הרשאה לנהל קישורי סידור בתחנה הזאת.');
  }
}

function planLink(input) {
  const value = input || {};
  const person = contract.normalizeSchedulePerson(value.person);
  const expected = requireExpectedRevision(value.expected_revision);
  const actorUid = text(value.actor_uid);
  const uid = text(value.uid);
  const user = value.user || {};
  if (!actorUid || !uid) throw new SchedulePersonServiceError('uid-required', 'חובה למסור מבצע וחשבון יעד.');
  requireActor(value, person.station_id);
  if (person.revision !== expected) throw new SchedulePersonServiceError('link-stale', 'האדם השתנה מאז פתיחת המסך.');
  if (person.kind !== 'external' || person.linked_uid !== null) {
    throw new SchedulePersonServiceError('link-state', 'רק אדם חיצוני שאינו מקושר ניתן לקישור.');
  }
  if (person.active !== true) {
    throw new SchedulePersonServiceError('link-inactive', 'אדם לא פעיל אינו ניתן לקישור.');
  }
  if (value.station_link !== null || value.global_link !== null) {
    throw new SchedulePersonServiceError('uid-already-linked', 'החשבון כבר קושר בעבר לאדם בסידור.');
  }
  if (user.exists !== true || user.active !== true || text(user.station_id) !== person.station_id || text(user.uid) !== uid) {
    throw new SchedulePersonServiceError('link-user-ineligible', 'החשבון אינו פעיל באותה תחנה.');
  }
  const next = contract.normalizeSchedulePerson(Object.assign({}, person, {
    kind: 'registered', linked_uid: uid, revision: person.revision + 1
  }));
  const reservation = Object.freeze({ schema_version:1, station_id:person.station_id,
    person_id:person.person_id, revision:1, status:'bound' });
  return Object.freeze({ expected_revision: expected,
    before: person, after: next,
    reservation,
    audit: Object.freeze({ action: 'schedule-person-link', actor_uid: actorUid,
      person_id: person.person_id, station_id: person.station_id }) });
}

module.exports = Object.freeze({ SchedulePersonServiceError, planLink });
