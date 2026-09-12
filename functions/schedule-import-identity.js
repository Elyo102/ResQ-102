'use strict';

const crypto = require('node:crypto');
const personContract = require('./schedule-person-contract');

class ScheduleImportIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScheduleImportIdentityError';
    this.code = code;
  }
}

const SOURCE_NAMESPACE = 'station-workbook-v1';
const MAX_ENTRIES = 3000;
const MAX_INVENTORY = 3000;
const MAX_BINDINGS = 6000;
const STATION_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const PERSON_ID = /^sp_[a-z0-9][a-z0-9_-]{7,63}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

function fail(code, message) { throw new ScheduleImportIdentityError(code, message); }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
}
function cleanText(value, max, code) {
  if (typeof value !== 'string') fail(code, 'ערך טקסטואלי חסר או אינו תקין.');
  const out = value.normalize('NFC').trim();
  if (!out || out.length > max || UNSAFE_TEXT.test(out)) fail(code, 'ערך טקסטואלי חסר או אינו בטוח.');
  return out;
}
function cleanOpaqueText(value, max, code) {
  if (typeof value !== 'string') fail(code, 'ערך טקסטואלי חסר או אינו תקין.');
  const out = value.trim();
  if (!out || out.length > max || UNSAFE_TEXT.test(out)) fail(code, 'ערך טקסטואלי חסר או אינו בטוח.');
  return out;
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }

function sourceKey(value) {
  if (!exactKeys(value, ['kind', 'value'])) fail('source-key-shape', 'מפתח המקור חייב לכלול סוג וערך בלבד.');
  if (value.kind !== 'employee' && value.kind !== 'name') fail('source-key-kind', 'סוג מפתח המקור אינו נתמך.');
  // Employee identifiers are strings on purpose: 00123 and 123 are distinct.
  const clean = value.kind === 'employee'
    ? cleanOpaqueText(value.value, 128, 'source-key-value')
    : cleanText(value.value, 128, 'source-key-value');
  return Object.freeze({ kind:value.kind, value:clean });
}
function sourceKeyId(value) { return value.kind + '\u0000' + value.value; }
function sourceRef(stationId, key) {
  return Object.freeze({ station_id:stationId, source_namespace:SOURCE_NAMESPACE, source_key:key });
}
function sameSourceRef(value, expected) {
  if (!exactKeys(value, ['station_id', 'source_namespace', 'source_key'])) return false;
  if (!own(value, 'source_key')) return false;
  let key;
  try { key = sourceKey(value.source_key); } catch (_) { return false; }
  return value.station_id === expected.station_id
    && value.source_namespace === expected.source_namespace
    && sourceKeyId(key) === sourceKeyId(expected.source_key);
}
function generatedPersonId(stationId, value) {
  if (typeof stationId !== 'string' || !STATION_ID.test(stationId)) {
    fail('station-id', 'מזהה התחנה אינו תקין.');
  }
  const key = sourceKey(value);
  return 'sp_' + digest([stationId, SOURCE_NAMESPACE, key.kind, key.value]).slice(0, 48);
}
function requireArray(value, cap, code) {
  if (!Array.isArray(value) || value.length > cap) fail(code, 'רשימת זהויות חסרה או חורגת מהמגבלה.');
  return value;
}
function publicPerson(person) {
  return Object.freeze({
    person_id:person.person_id,
    station_id:person.station_id,
    kind:person.kind,
    display_name:person.display_name,
    active:person.active,
    revision:person.revision
  });
}

function planImportIdentities(input) {
  if (!plain(input)) fail('input-shape', 'קלט תכנון הזהויות אינו תקין.');
  const stationId = typeof input.station_id === 'string' ? input.station_id.trim() : '';
  if (!STATION_ID.test(stationId)) fail('station-id', 'מזהה התחנה אינו תקין.');
  if (input.source_namespace !== SOURCE_NAMESPACE) fail('source-namespace', 'מרחב המקור אינו מאושר.');
  const entries = requireArray(input.entries, MAX_ENTRIES, 'entries-limit');
  const inventoryRaw = requireArray(input.inventory, MAX_INVENTORY, 'inventory-limit');
  const bindingsRaw = requireArray(input.bindings, MAX_BINDINGS, 'bindings-limit');

  const inventory = new Map();
  const inventoryEvidence = [];
  const inventoryProvenance = new Map();
  const duplicateProvenance = new Map();
  for (const raw of inventoryRaw) {
    const person = personContract.normalizeSchedulePerson(raw);
    if (person.station_id !== stationId) fail('inventory-cross-station', 'מלאי האנשים מכיל אדם מתחנה אחרת.');
    cleanText(person.display_name, 120, 'inventory-display-name');
    if (inventory.has(person.person_id)) fail('inventory-duplicate', 'מזהה אדם מופיע פעמיים במלאי.');
    let ref = null;
    if (own(raw, 'source_ref')) {
      if (!exactKeys(raw.source_ref, ['station_id', 'source_namespace', 'source_key'])
          || raw.source_ref.station_id !== stationId
          || raw.source_ref.source_namespace !== SOURCE_NAMESPACE) {
        fail('inventory-source-ref', 'מקור זהות במלאי אינו תקין או שייך להיקף אחר.');
      }
      const refKey = sourceKey(raw.source_ref.source_key);
      ref = sourceRef(stationId, refKey);
      const refId = sourceKeyId(refKey);
      if (inventoryProvenance.has(refId)) duplicateProvenance.set(refId, refKey);
      else inventoryProvenance.set(refId, person.person_id);
    }
    inventory.set(person.person_id, Object.freeze({ person, source_ref:ref }));
    inventoryEvidence.push({ person, source_ref:ref });
  }

  const bindings = new Map();
  const bindingEvidence = [];
  for (const raw of bindingsRaw) {
    if (!exactKeys(raw, ['station_id', 'source_namespace', 'source_key', 'person_id', 'expected_person_revision'])) {
      fail('binding-shape', 'קישור מקור אינו תואם לחוזה הסגור.');
    }
    if (raw.station_id !== stationId || raw.source_namespace !== SOURCE_NAMESPACE) {
      fail('binding-cross-scope', 'קישור מקור שייך להיקף אחר.');
    }
    const key = sourceKey(raw.source_key);
    const keyId = sourceKeyId(key);
    if (bindings.has(keyId)) fail('binding-duplicate', 'מפתח מקור מקושר יותר מפעם אחת.');
    if (typeof raw.person_id !== 'string' || !PERSON_ID.test(raw.person_id)
        || !Number.isInteger(raw.expected_person_revision)
        || raw.expected_person_revision < 1) fail('binding-shape', 'יעד או גרסת קישור המקור אינם תקינים.');
    const binding = Object.freeze({ station_id:stationId, source_namespace:SOURCE_NAMESPACE,
      source_key:key, person_id:raw.person_id, expected_person_revision:raw.expected_person_revision });
    bindings.set(keyId, binding);
    bindingEvidence.push(binding);
  }

  const seenEntries = new Set();
  const normalizedEntries = entries.map((raw) => {
    if (!exactKeys(raw, ['source_key', 'display_name'])) fail('entry-shape', 'זהות מיובאת אינה תואמת לחוזה הסגור.');
    const key = sourceKey(raw.source_key);
    const keyId = sourceKeyId(key);
    if (seenEntries.has(keyId)) fail('entry-duplicate', 'מפתח מקור מופיע פעמיים בקובץ.');
    seenEntries.add(keyId);
    return Object.freeze({ source_key:key, key_id:keyId,
      display_name:cleanText(raw.display_name, 120, 'display-name') });
  }).sort((a, b) => a.key_id < b.key_id ? -1 : a.key_id > b.key_id ? 1 : 0);

  const assignments = [];
  const proposedPeople = [];
  const conflicts = [...duplicateProvenance.values()].map((key) => Object.freeze({
    code:'duplicate-provenance', source_key:key, person_id:null
  }));
  const effectivePeople = new Map();
  function conflict(code, entry, personId) {
    conflicts.push(Object.freeze({ code, source_key:entry.source_key,
      person_id:personId || null }));
  }
  function assign(entry, person) {
    if (effectivePeople.has(person.person_id)) {
      conflict('effective-person-duplicate', entry, person.person_id);
      return;
    }
    effectivePeople.set(person.person_id, entry.key_id);
    assignments.push(Object.freeze({ source_key:entry.source_key, person:publicPerson(person) }));
  }

  for (const entry of normalizedEntries) {
    const binding = bindings.get(entry.key_id);
    if (binding) {
      const found = inventory.get(binding.person_id);
      if (!found || found.person.active !== true
          || found.person.revision !== binding.expected_person_revision) {
        conflict('binding-stale', entry, binding.person_id);
      } else {
        // A binding is the explicit human decision that a workbook alias
        // belongs to this person. The assignment keeps the canonical person
        // name; the workbook alias never rewrites it.
        assign(entry, found.person);
      }
      continue;
    }

    const personId = generatedPersonId(stationId, entry.source_key);
    const found = inventory.get(personId);
    const ref = sourceRef(stationId, entry.source_key);
    if (found) {
      if (found.person.kind !== 'external' || !sameSourceRef(found.source_ref, ref)) {
        conflict('identity-collision', entry, personId);
      } else if (found.person.active !== true) {
        conflict('person-inactive', entry, personId);
      } else if (found.person.display_name !== entry.display_name) {
        conflict('source-name-changed', entry, personId);
      } else {
        assign(entry, found.person);
      }
      continue;
    }
    const proposed = Object.freeze({ schema_version:1, person_id:personId, station_id:stationId,
      kind:'external', linked_uid:null, display_name:entry.display_name, active:true, revision:1,
      source_ref:ref });
    proposedPeople.push(proposed);
    assign(entry, proposed);
  }

  conflicts.sort((a, b) => stable(a).localeCompare(stable(b), 'en'));
  return Object.freeze({
    schema_version:1,
    station_id:stationId,
    source_namespace:SOURCE_NAMESPACE,
    ready:conflicts.length === 0,
    assignments:Object.freeze(assignments),
    proposed_people:Object.freeze(proposedPeople),
    conflicts:Object.freeze(conflicts),
    inventory_digest:digest(inventoryEvidence.sort((a, b) => stable(a).localeCompare(stable(b), 'en'))),
    bindings_digest:digest(bindingEvidence.sort((a, b) => stable(a).localeCompare(stable(b), 'en')))
  });
}

module.exports = Object.freeze({
  ScheduleImportIdentityError,
  SOURCE_NAMESPACE,
  MAX_ENTRIES,
  MAX_INVENTORY,
  MAX_BINDINGS,
  sourceKey,
  generatedPersonId,
  planImportIdentities
});
