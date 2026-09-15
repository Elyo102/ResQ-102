'use strict';

const assert = require('node:assert/strict');
const subject = require('./schedule-import-layout');

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

const first = subject.buildImportLayout({
  station_id: 'station-102',
  labels: ['אילת', ' שחמון ', 'תמנע', 'אילת', 'יטבתה']
});
assert.equal(first.schema_version, 2);
assert.equal(first.source, 'workbook');
assert.deepEqual(first.stations.map((item) => item.label), ['אילת', 'שחמון', 'תמנע', 'יטבתה']);
assert.deepEqual(first.stations.map((item) => item.order), [0, 1, 2, 3]);
assert.ok(first.stations.every((item) => item.station_key.startsWith('is_') && item.minimum === null));
assert.ok(Object.isFrozen(first.stations));
assert.ok(Object.isFrozen(first.warnings));
assert.deepEqual(first.warnings, [
  { code: 'duplicate-station-label', input_index: 3, label: 'אילת', kept_order: 0 }
]);
assert.throws(() => first.stations.push({}));

const repeat = subject.buildImportLayout({
  station_id: 'station-102',
  labels: ['אילת', 'שחמון', 'תמנע', 'יטבתה']
});
assert.notEqual(repeat.digest, first.digest);
assert.deepEqual(repeat.stations, first.stations);

const otherStation = subject.buildImportLayout({ station_id: 'station-103', labels: ['אילת'] });
assert.notEqual(otherStation.stations[0].station_key, first.stations[0].station_key);

const canonicalUnicode = subject.buildImportLayout({
  station_id: 'station-102',
  labels: ['Jose\u0301', 'José']
});
assert.equal(canonicalUnicode.stations.length, 1);

throwsCode(() => subject.buildImportLayout({ station_id: 'Station 102', labels: ['אילת'] }), 'station-id');
throwsCode(() => subject.buildImportLayout({ station_id: 'station-102', labels: [] }), 'station-labels');
throwsCode(() => subject.buildImportLayout({ station_id: 'station-102', labels: ['\u202eאילת'] }), 'station-label');
throwsCode(() => subject.buildImportLayout({ station_id: 'station-102', labels: ['א'.repeat(81)] }), 'station-label');
throwsCode(() => subject.stationKey('BAD ID', 'A'), 'station-id');

const repeated = subject.buildImportLayout({ station_id: 'station-102', labels: Array(65).fill('A') });
assert.equal(repeated.stations.length, 1);
assert.equal(repeated.warnings.length, 64);

const tooManyUnique = Array.from({ length: subject.MAX_STATIONS + 1 }, (_, index) => `S${index}`);
throwsCode(() => subject.buildImportLayout({ station_id: 'station-102', labels: tooManyUnique }), 'station-labels');

const parsed = { blocks: [
  { kind: 'station', label: 'A' },
  { kind: 'absence', label: 'leave' },
  { kind: 'ignored', label: 'notes' },
  { kind: 'station', label: ' B ' },
  { kind: 'station', label: 'A' }
] };
assert.deepEqual(subject.labelsFromParsed(parsed), ['A', ' B ', 'A']);
const parsedLayout = subject.buildLayoutForParsed({ station_id: 'station-102', parsed });
assert.deepEqual(parsedLayout.stations.map((item) => item.label), ['A', 'B']);
assert.equal(parsedLayout.digest, subject.buildLayoutForParsed({ station_id: 'station-102', parsed }).digest);
assert.deepEqual(subject.verifyLayoutForParsed({ station_id: 'station-102', parsed, layout: parsedLayout }), parsedLayout);
const forgedLayout = JSON.parse(JSON.stringify(parsedLayout));
forgedLayout.stations[0].label = 'FORGED';
throwsCode(() => subject.verifyLayoutForParsed({ station_id: 'station-102', parsed, layout: forgedLayout }), 'layout-stale');
for (const nonFinite of [NaN, Infinity, -Infinity]) {
  const forgedMinimum = JSON.parse(JSON.stringify(parsedLayout));
  forgedMinimum.stations[0].minimum = nonFinite;
  throwsCode(() => subject.verifyLayoutForParsed({ station_id: 'station-102', parsed, layout: forgedMinimum }), 'layout-stale');
}
throwsCode(() => subject.verifyLayoutForParsed({ station_id: 'station-103', parsed, layout: parsedLayout }), 'layout-stale');
throwsCode(() => subject.verifyLayoutForParsed({ station_id: 'station-102', parsed }), 'layout-required');
throwsCode(() => subject.labelsFromParsed(null), 'parsed-shape');
throwsCode(() => subject.labelsFromParsed({ blocks: [{ kind: 'absence', label: 'leave' }] }), 'station-labels');

console.log('schedule-import-layout: 32 checks passed');
