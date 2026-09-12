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

function requireLinkIndex(value, uid, personId) {
  const index = value && value.link_index;
  const expected = value && value.expected_link_revision;
  if (!index || text(index.uid) !== uid || !Number.isInteger(index.revision) || index.revision < 0
      || !Number.isInteger(expected) || expected < 0 || index.revision !== expected) {
    throw new SchedulePersonServiceError('link-index-stale', 'אינדקס הקישור חסר או השתנה.');
  }
  const linkedPerson = index.person_id === null ? null : text(index.person_id);
  if (linkedPerson !== personId) {
    throw new SchedulePersonServiceError('uid-already-linked', 'החשבון כבר מקושר לאדם אחר.');
  }
  return Object.freeze({ uid, person_id: linkedPerson, revision:index.revision });
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
  const index = requireLinkIndex(value, uid, null);
  if (user.exists !== true || user.active !== true || text(user.station_id) !== person.station_id || text(user.uid) !== uid) {
    throw new SchedulePersonServiceError('link-user-ineligible', 'החשבון אינו פעיל באותה תחנה.');
  }
  const next = contract.normalizeSchedulePerson(Object.assign({}, person, {
    kind: 'registered', linked_uid: uid, revision: person.revision + 1
  }));
  return Object.freeze({ expected_revision: expected, expected_link_revision:index.revision,
    before: person, after: next,
    link_index_after:Object.freeze({ uid, person_id:person.person_id, revision:index.revision + 1 }),
    audit: Object.freeze({ action: 'schedule-person-link', actor_uid: actorUid,
      person_id: person.person_id, station_id: person.station_id, linked_uid: uid }) });
}

function planUnlink(input) {
  const value = input || {};
  const person = contract.normalizeSchedulePerson(value.person);
  const expected = requireExpectedRevision(value.expected_revision);
  const actorUid = text(value.actor_uid);
  if (!actorUid) throw new SchedulePersonServiceError('uid-required', 'חובה למסור מבצע.');
  requireActor(value, person.station_id);
  if (person.revision !== expected) throw new SchedulePersonServiceError('unlink-stale', 'האדם השתנה מאז פתיחת המסך.');
  if (person.kind !== 'registered' || !person.linked_uid) {
    throw new SchedulePersonServiceError('unlink-state', 'האדם אינו מקושר.');
  }
  const index = requireLinkIndex(value, person.linked_uid, person.person_id);
  const oldUid = person.linked_uid;
  const next = contract.normalizeSchedulePerson(Object.assign({}, person, {
    kind: 'external', linked_uid: null, revision: person.revision + 1
  }));
  return Object.freeze({ expected_revision: expected, expected_link_revision:index.revision,
    before: person, after: next,
    link_index_after:Object.freeze({ uid:oldUid, person_id:null, revision:index.revision + 1 }),
    audit: Object.freeze({ action: 'schedule-person-unlink', actor_uid: actorUid,
      person_id: person.person_id, station_id: person.station_id, linked_uid: oldUid }) });
}

module.exports = Object.freeze({ SchedulePersonServiceError, planLink, planUnlink });
