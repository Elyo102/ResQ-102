'use strict';

const COMPARTMENTS = Object.freeze([
  'cabin', 'crew', 'bay-1', 'bay-2', 'bay-3', 'bay-4',
  'bay-5', 'bay-6', 'bay-7', 'roof'
]);
const MEMBER_ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader', 'deputy',
  'commander', 'station_commander', 'hr_coordinator'
]);
const EVENT_WRITERS = Object.freeze(MEMBER_ROLES.filter(role => role !== 'hr_coordinator'));
const FLEET_WRITERS = Object.freeze(['deputy', 'commander', 'station_commander']);
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,120}$/;
const IMAGE_MAX = 600 * 1024;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function inputError(message) {
  const error = new Error(message);
  error.code = 'invalid-argument';
  return error;
}
function exactObject(value, keys) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw inputError('Invalid request fields.');
  }
  return value;
}
function id(value, label = 'id') {
  if (typeof value !== 'string' || !ID.test(value)) throw inputError('Invalid ' + label + '.');
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw inputError('Invalid request id.');
  return value;
}
function compartment(value) {
  if (!COMPARTMENTS.includes(value)) throw inputError('Invalid compartment.');
  return value;
}
function text(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw inputError('Invalid text.');
  }
  const cleaned = value.replace(/\r\n?/g, '\n').trim();
  if (required && !cleaned) throw inputError('Required text is missing.');
  return cleaned;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) {
    throw inputError('Invalid revision.');
  }
  return value;
}
function parseEvent(value) {
  const data = exactObject(value, [
    'vehicle_id', 'request_id', 'kind', 'equipment', 'location',
    'was_replaced', 'replacement_equipment', 'source_vehicle_id', 'status'
  ]);
  const kind = data.kind;
  if (!['removed', 'replaced'].includes(kind) || typeof data.was_replaced !== 'boolean' ||
      data.status !== 'open') {
    throw inputError('Invalid equipment event.');
  }
  const replacement = text(data.replacement_equipment || '', 180, false);
  const source = data.source_vehicle_id ? id(data.source_vehicle_id, 'source vehicle') : '';
  if (data.was_replaced && !replacement) throw inputError('Replacement details are required.');
  if (!data.was_replaced && (replacement || source || kind === 'replaced')) {
    throw inputError('Replacement fields conflict.');
  }
  return Object.freeze({
    vehicle_id:id(data.vehicle_id, 'vehicle'), request_id:requestId(data.request_id),
    kind, equipment:text(data.equipment, 180), location:text(data.location, 240),
    was_replaced:data.was_replaced, replacement_equipment:replacement,
    source_vehicle_id:source, status:data.status
  });
}
function parseItem(value) {
  const data = exactObject(value, [
    'vehicle_id', 'compartment_id', 'item_id', 'request_id', 'expected_revision',
    'name', 'quantity', 'status', 'notes'
  ]);
  if (!Number.isSafeInteger(data.quantity) || data.quantity < 0 || data.quantity > 9999 ||
      !['present', 'missing', 'service'].includes(data.status)) {
    throw inputError('Invalid equipment item.');
  }
  return Object.freeze({
    vehicle_id:id(data.vehicle_id, 'vehicle'),
    compartment_id:compartment(data.compartment_id),
    item_id:id(data.item_id, 'item'), request_id:requestId(data.request_id),
    expected_revision:revision(data.expected_revision),
    name:text(data.name, 160), quantity:data.quantity, status:data.status,
    notes:text(data.notes || '', 400, false)
  });
}
function parsePhoto(value) {
  const data = exactObject(value, [
    'vehicle_id', 'compartment_id', 'request_id', 'expected_revision',
    'data', 'w', 'h'
  ]);
  const jpeg = data.data;
  if (!Number.isInteger(data.w) || data.w < 1 || data.w > 1280 ||
      !Number.isInteger(data.h) || data.h < 1 || data.h > 1280 ||
      typeof jpeg !== 'string' || jpeg.length > IMAGE_MAX * 1.4 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(jpeg)) {
    throw inputError('Invalid compartment image.');
  }
  const bytes = Buffer.from(jpeg.slice('data:image/jpeg;base64,'.length), 'base64');
  if (bytes.length < 4 || bytes.length > IMAGE_MAX ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw inputError('Invalid compartment image.');
  }
  return Object.freeze({
    vehicle_id:id(data.vehicle_id, 'vehicle'),
    compartment_id:compartment(data.compartment_id),
    request_id:requestId(data.request_id),
    expected_revision:revision(data.expected_revision),
    data:jpeg, w:data.w, h:data.h
  });
}

module.exports = Object.freeze({
  COMPARTMENTS, MEMBER_ROLES, EVENT_WRITERS, FLEET_WRITERS,
  parseEvent, parseItem, parsePhoto, ID, REQUEST_ID, IMAGE_MAX
});
