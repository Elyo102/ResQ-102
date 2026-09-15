'use strict';

const crypto = require('node:crypto');

class ScheduleImportLayoutError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScheduleImportLayoutError';
    this.code = code;
  }
}

const STATION_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;
const MAX_STATIONS = 64;
const MAX_BLOCKS = 4096;
const MAX_LABEL = 80;

function fail(code, message) { throw new ScheduleImportLayoutError(code, message); }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  if (!plain(left) || !plain(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function cleanLabel(value) {
  if (typeof value !== 'string') fail('station-label', 'שם התחנה בקובץ אינו תקין.');
  const label = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!label || label.length > MAX_LABEL || UNSAFE_TEXT.test(label)) {
    fail('station-label', 'שם התחנה בקובץ חסר, ארוך מדי או אינו בטוח.');
  }
  return label;
}
function identityLabel(value) { return cleanLabel(value).toLocaleLowerCase('he-IL'); }
function stationKey(stationId, label) {
  const scopedStationId = typeof stationId === 'string' ? stationId.trim() : '';
  if (!STATION_ID.test(scopedStationId)) fail('station-id', 'Invalid station scope.');
  return 'is_' + digest([scopedStationId, identityLabel(label)]).slice(0, 40);
}

function labelsFromParsed(parsed) {
  if (!plain(parsed) || !Array.isArray(parsed.blocks)) {
    fail('parsed-shape', 'פלט קליטת הסידור אינו תקין.');
  }
  const labels = parsed.blocks
    .filter((block) => plain(block) && block.kind === 'station')
    .map((block) => block.label);
  if (!labels.length) fail('station-labels', 'לא נמצאו תחנות בקובץ הסידור.');
  return Object.freeze(labels.slice());
}

function buildLayoutForParsed(input) {
  if (!plain(input)) fail('input-shape', 'קלט פריסת הייבוא אינו תקין.');
  return buildImportLayout({
    station_id: input.station_id,
    labels: labelsFromParsed(input.parsed)
  });
}

function verifyLayoutForParsed(input) {
  if (!plain(input) || !plain(input.layout)) {
    fail('layout-required', 'חסרה פריסת תחנות מאומתת.');
  }
  const expected = buildLayoutForParsed(input);
  if (!sameValue(input.layout, expected)) {
    fail('layout-stale', 'פריסת התחנות אינה תואמת לקובץ הסידור.');
  }
  return expected;
}

function buildImportLayout(input) {
  if (!plain(input)) fail('input-shape', 'קלט פריסת הייבוא אינו תקין.');
  const stationId = typeof input.station_id === 'string' ? input.station_id.trim() : '';
  if (!STATION_ID.test(stationId)) fail('station-id', 'מזהה התחנה אינו תקין.');
  if (!Array.isArray(input.labels) || input.labels.length < 1 || input.labels.length > MAX_BLOCKS) {
    fail('station-labels', 'רשימת התחנות בקובץ חסרה או חורגת מהמגבלה.');
  }

  const seen = new Map();
  const stations = [];
  const warnings = [];
  for (let inputIndex = 0; inputIndex < input.labels.length; inputIndex += 1) {
    const raw = input.labels[inputIndex];
    const label = cleanLabel(raw);
    const identity = identityLabel(label);
    if (seen.has(identity)) {
      warnings.push(Object.freeze({ code: 'duplicate-station-label', input_index: inputIndex, label, kept_order: seen.get(identity) }));
      continue;
    }
    if (stations.length >= MAX_STATIONS) fail('station-labels', 'Too many unique stations.');
    seen.set(identity, stations.length);
    stations.push(Object.freeze({
      station_key: stationKey(stationId, label),
      label,
      order: stations.length,
      minimum: null
    }));
  }
  if (!stations.length) fail('station-labels', 'לא נמצאה תחנה תקינה בקובץ.');

  const basis = {
    schema_version: 2,
    source: 'workbook',
    station_id: stationId,
    stations: Object.freeze(stations.slice()),
    warnings: Object.freeze(warnings.slice())
  };
  return Object.freeze(Object.assign({}, basis, { digest: digest(basis) }));
}

module.exports = Object.freeze({
  ScheduleImportLayoutError,
  MAX_STATIONS,
  MAX_BLOCKS,
  MAX_LABEL,
  stationKey,
  labelsFromParsed,
  buildImportLayout,
  buildLayoutForParsed,
  verifyLayoutForParsed
});
