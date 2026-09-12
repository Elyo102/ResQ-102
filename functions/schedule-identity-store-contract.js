'use strict';

const crypto = require('node:crypto');
const people = require('./schedule-person-contract');
const imports = require('./schedule-import-identity');

class ScheduleIdentityStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScheduleIdentityStoreError';
    this.code = code;
  }
}

const COLLECTIONS = Object.freeze({
  people: 'schedule_people',
  bindings: 'schedule_source_bindings',
  link_index: 'schedule_person_link_index',
  state: 'schedule_identity_state',
  operations: 'schedule_identity_operations',
  audit: 'schedule_identity_audit'
});

const STATE_DOCUMENT = 'current';
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{1,127}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(code, message) {
  throw new ScheduleIdentityStoreError(code, message);
}

function text(value, code) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > 128 || CONTROL.test(out)) fail(code, 'מזהה אחסון אינו תקין.');
  return out;
}

function hash(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function bindingDocumentId(sourceNamespace, sourceKey) {
  const namespace = text(sourceNamespace, 'source-namespace');
  if (namespace !== imports.SOURCE_NAMESPACE) fail('source-namespace', 'מרחב המקור אינו מאושר.');
  const key = imports.sourceKey(sourceKey);
  return 'sb_' + hash([namespace, key.kind, key.value]).slice(0, 48);
}

function linkIndexDocumentId(uid) {
  const clean = text(uid, 'linked-uid');
  if (!people.validUid(clean)) fail('linked-uid', 'מזהה החשבון אינו תקין.');
  return 'sl_' + hash(['schedule-person-link-v1', clean]).slice(0, 48);
}

function operationDocumentId(requestId) {
  const clean = text(requestId, 'request-id');
  if (!SAFE_ID.test(clean)) fail('request-id', 'מזהה הפעולה אינו תקין.');
  return 'so_' + hash(['schedule-identity-operation-v1', clean]).slice(0, 48);
}

function publicPerson(value) {
  const person = people.normalizeSchedulePerson(value);
  return Object.freeze({
    person_id: person.person_id,
    station_id: person.station_id,
    display_name: person.display_name,
    active: person.active
  });
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('state-shape', 'מצב הזהויות אינו תקין.');
  }
  const keys = Object.keys(value).sort();
  const allowed = ['generation', 'revision', 'schema_version'].sort();
  if (keys.join('|') !== allowed.join('|') || value.schema_version !== 1
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || value.revision >= Number.MAX_SAFE_INTEGER) {
    fail('state-shape', 'מצב הזהויות אינו תקין.');
  }
  const generation = text(value.generation, 'state-generation');
  if (!SAFE_ID.test(generation)) fail('state-generation', 'דור הזהויות אינו תקין.');
  return Object.freeze({ schema_version:1, generation, revision:value.revision });
}

module.exports = Object.freeze({
  ScheduleIdentityStoreError,
  COLLECTIONS,
  STATE_DOCUMENT,
  bindingDocumentId,
  linkIndexDocumentId,
  operationDocumentId,
  publicPerson,
  normalizeState
});
