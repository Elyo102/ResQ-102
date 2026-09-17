'use strict';
const assert = require('node:assert/strict');
const { stationDeliveryDecision: decide, createStationDeliveryFence } = require('./station-delivery-fence');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const sid = 'new_station';
const ready = { schema_version: 1, station_id: sid, template_id: 'fire-station-v1',
  provision_request_id: 'request_0001', status: 'ready', active: true, silent: false };
function decision(station, globalSuppressed = false) {
  return decide({ stationId: sid, exists: true, station, globalSuppressed });
}

for (const globalSuppressed of [false, true]) for (const silent of [false, true]) {
  test('global/station OR ' + globalSuppressed + '/' + silent, () => {
    assert.equal(decision({ ...ready, silent }, globalSuppressed).allowed, !globalSuppressed && !silent);
  });
}
test('provisioning remains blocked even if silent falsely cleared', () => {
  assert.equal(decision({ ...ready, status: 'provisioning' }).reason, 'station-not-ready');
});
for (const field of ['template_id', 'provision_request_id', 'schema_version', 'station_id', 'silent']) {
  test('missing provision field ' + field, () => {
    const value = { ...ready }; delete value[field]; assert.equal(decision(value).allowed, false);
  });
}
for (const value of ['false', 'true', 0, 1, {}, null]) {
  test('malformed silence ' + JSON.stringify(value), () => {
    assert.equal(decision({ ...ready, silent: value }).allowed, false);
  });
}
for (const value of [undefined, 'false', 0, null]) {
  test('missing or malformed global verdict ' + String(value), () => {
    assert.equal(decide({ stationId: sid, exists: true, station: ready, globalSuppressed: value }).allowed, false);
  });
}
test('unknown missing station denied', () => {
  assert.equal(decide({ stationId: sid, exists: false, station: null, globalSuppressed: false }).reason, 'station-missing');
});
test('explicit legacy missing station allowed', () => {
  assert.equal(decide({ stationId: 'eilat_102', exists: false, station: null, globalSuppressed: false }).allowed, true);
});
test('legacy active dynamic station preserved', () => {
  assert.equal(decision({ active: true, districtId: 'south' }).allowed, true);
});
test('legacy station explicit mute honored', () => {
  assert.equal(decision({ active: true, silent: true }).reason, 'station-silence');
});
test('inactive station denied', () => assert.equal(decision({ ...ready, active: false }).allowed, false));
test('archived station denied', () => assert.equal(decision({ ...ready, archived: true }).allowed, false));
test('station ID mismatch denied', () => assert.equal(decision({ ...ready, station_id: 'other' }).allowed, false));
test('invalid path denied', () => {
  assert.equal(decide({ stationId: 'evil/path', exists: false, station: null, globalSuppressed: false }).reason, 'station-id-invalid');
});

(async () => {
  let reads = 0, current = { ...ready }, failRead = false;
  const db = { doc(path) {
    assert.equal(path, 'stations/' + sid);
    return { get: async () => { reads++; if (failRead) throw new Error('unavailable'); return { exists: true, data: () => current }; } };
  } };
  const fence = createStationDeliveryFence({ db });
  assert.equal((await fence.check({ stationId: sid, globalSuppressed: false })).allowed, true);
  current = { ...ready, silent: true };
  assert.equal((await fence.check({ stationId: sid, globalSuppressed: false })).reason, 'station-silence');
  assert.equal(reads, 2); passed++; console.log('PASS fresh read observes changed silence');
  failRead = true;
  assert.equal((await fence.check({ stationId: sid, globalSuppressed: false })).reason, 'station-state-unavailable');
  passed++; console.log('PASS failed read fails closed');
  const legacyFailure = createStationDeliveryFence({ db: { doc: () => ({ get: async () => { throw new Error('offline'); } }) } });
  assert.equal((await legacyFailure.check({ stationId: 'eilat_102', globalSuppressed: false })).allowed, false);
  passed++; console.log('PASS legacy read error is not missing');
  assert.equal((await fence.check({ stationId: sid, globalSuppressed: false,
    tx: { get: async () => ({ exists: true, data: () => ready }) } })).allowed, true);
  passed++; console.log('PASS transaction reader supported');
  const before = reads;
  assert.equal((await fence.check({ stationId: 'x/y', globalSuppressed: false })).allowed, false);
  assert.equal((await fence.check({ stationId: sid, globalSuppressed: true })).allowed, false);
  assert.equal(reads, before); passed++; console.log('PASS known denial avoids extra reads');
  console.log('station-delivery-fence: ' + passed + ' tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
