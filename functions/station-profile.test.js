'use strict';

const assert = require('node:assert/strict');
const { resolveStationAliases } = require('./station-profile');

const valid = function (value) { return /^[a-z0-9_-]{2,80}$/.test(value); };
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

for (const [name, profile] of [
  ['stationId', { stationId: 'eilat_102' }],
  ['station_id', { station_id: 'eilat_102' }],
  ['station', { station: 'eilat_102' }],
  ['matching aliases', { stationId: 'eilat_102', station_id: 'eilat_102', station: 'eilat_102' }]
]) {
  test(name + ' resolves one exact station', function () {
    assert.deepEqual(resolveStationAliases(profile, valid), { ok: true, stationId: 'eilat_102' });
  });
}

for (const [name, profile, reason] of [
  ['missing station', {}, 'missing'],
  ['blank station', { station: '' }, 'missing'],
  ['malformed station', { station: 'eilat 102' }, 'invalid'],
  ['non-string station', { station: 102 }, 'invalid'],
  ['stationId and station conflict', { stationId: 'eilat_102', station: 'other_99' }, 'conflict'],
  ['station_id and station conflict', { station_id: 'eilat_102', station: 'other_99' }, 'conflict'],
  ['stationId and station_id conflict', { stationId: 'eilat_102', station_id: 'other_99' }, 'conflict']
]) {
  test(name + ' fails closed', function () {
    assert.deepEqual(resolveStationAliases(profile, valid), { ok: false, reason: reason });
  });
}

assert.equal(passed, 11);
console.log('\n11 station profile alias checks passed.');
