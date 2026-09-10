'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAttendanceCorrectionConfigReader, MAX_ROTATIONS } = require('./attendance-correction-config');
const { calculateAttendanceDerived } = require('./attendance-hours-calculator');

class E extends Error { constructor(code, message) { super(message); this.code = code; } }
function ref(path) {
  return { path, collection(name) { return ref(path + '/' + name); },
    doc(id) { return ref(path + '/' + id); }, limit(n) { return { path, limit: n }; } };
}
function fixture({ rotations, sites = {} } = {}) {
  const calls = [];
  const db = { collection: name => ref(name) };
  const tx = { async get(target) {
    calls.push(target);
    if (target.path.endsWith('/rotations')) {
      const docs = (rotations || []).map(row => ({ id: row.id, data: () => row.value }));
      return { size: docs.length, docs };
    }
    const id = target.path.split('/').pop();
    return own(sites, id) ? { exists: true, data: () => sites[id] } : { exists: false };
  } };
  return { read: createAttendanceCorrectionConfigReader({ db, HttpsError: E }), tx, calls };
}
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const base = { stationId: 'eilat_102', targetRole: 'firefighter', subStationIds: [] };

test('canonical first active rotation and exact target commander role determine shift hours', async () => {
  const f = fixture({ rotations: [
    { id: 'C', value: { shift_hours: 10, commander_shift_hours: 10 } },
    { id: 'A', value: { shift_hours: 24, commander_shift_hours: 24.25 } },
    { id: 'B', value: { shift_hours: 20, commander_shift_hours: 20 } }
  ] });
  assert.equal((await f.read(f.tx, base)).shiftHours, 24);
  assert.equal((await f.read(f.tx, { ...base, targetRole: 'commander' })).shiftHours, 24.25);
  assert.equal((await f.read(f.tx, { ...base, targetRole: 'hr_coordinator' })).shiftHours, 24);
  assert.equal(f.calls[0].limit, MAX_ROTATIONS + 1);
});

test('inactive rotations are skipped and absent hour fields use role-specific defaults', async () => {
  const f = fixture({ rotations: [
    { id: 'aa', value: { is_active: false, shift_hours: 1 } },
    { id: 'bb', value: {} }
  ] });
  assert.equal((await f.read(f.tx, base)).shiftHours, 24);
  assert.equal((await f.read(f.tx, { ...base, targetRole: 'commander' })).shiftHours, 24.25);
});

test('deduplicated requested sites are read once and returned with validated names/hours', async () => {
  const f = fixture({ rotations: [{ id: 'A', value: { shift_hours: '24' } }], sites: {
    yotvata: { name: 'יטבתה', fixed_hours: '25', is_active: true }
  } });
  const result = await f.read(f.tx, { ...base, subStationIds: ['', 'yotvata', 'yotvata'] });
  assert.equal(Object.getPrototypeOf(result.siteById), null);
  assert.deepEqual({ ...result.siteById }, { yotvata: { fixed_hours: 25, name: 'יטבתה' } });
  assert.equal(result.shiftHours, 24);
  assert.equal(f.calls.filter(call => call.path.endsWith('/yotvata')).length, 1);
});

test('missing disabled malformed site and malformed rotation fail closed', async () => {
  for (const setup of [
    { rotations: [{ id: 'aa', value: {} }], ids: ['missing'] },
    { rotations: [{ id: 'aa', value: {} }], sites: { xx: { name: 'x', active: false } }, ids: ['xx'] },
    { rotations: [{ id: 'aa', value: { shift_hours: true } }] },
    { rotations: [{ id: 'aa', value: { is_active: 'yes' } }] },
    { rotations: [{ id: 'aa', value: { shift_hours: 49 } }] }
  ]) {
    const f = fixture(setup);
    await assert.rejects(f.read(f.tx, { ...base, subStationIds: setup.ids || [] }), error => error.code === 'failed-precondition');
  }
});

test('prototype-shaped station id remains an own entry and reaches the strict calculator', async () => {
  const sites = Object.create(null);
  sites.__proto__ = { name: 'תחנה מיוחדת', fixed_hours: 25, is_active: true };
  const f = fixture({ rotations: [{ id: 'A', value: {} }], sites });
  const config = await f.read(f.tx, { ...base, subStationIds: ['__proto__'] });
  assert.equal(Object.getPrototypeOf(config.siteById), null);
  assert.equal(own(config.siteById, '__proto__'), true);
  assert.deepEqual(calculateAttendanceDerived({
    day_type: 'regular', sub_station: '__proto__', start: '08:00', end: '09:00'
  }, config), { hours: 25, day_type_he: 'רגיל', site_name: 'תחנה מיוחדת', reason_required: false });
});

test('existing product limit accepts exactly 48 hours and rejects 49 for rotations and sites', async () => {
  const sites = { edge: { name: 'קצה', fixed_hours: 48, is_active: true } };
  const accepted = fixture({ rotations: [{ id: 'A', value: { shift_hours: 48 } }], sites });
  const config = await accepted.read(accepted.tx, { ...base, subStationIds: ['edge'] });
  assert.equal(config.shiftHours, 48);
  assert.equal(config.siteById.edge.fixed_hours, 48);

  const badRotation = fixture({ rotations: [{ id: 'A', value: { shift_hours: 49 } }] });
  await assert.rejects(badRotation.read(badRotation.tx, base), error => error.code === 'failed-precondition');

  const badSite = fixture({ rotations: [{ id: 'A', value: {} }], sites: {
    edge: { name: 'קצה', fixed_hours: 49, is_active: true }
  } });
  await assert.rejects(badSite.read(badSite.tx, { ...base, subStationIds: ['edge'] }),
    error => error.code === 'failed-precondition');
});

test('no active rotation, rotation overflow and invalid bounded request are rejected', async () => {
  const inactive = fixture({ rotations: [{ id: 'aa', value: { is_active: false } }] });
  await assert.rejects(inactive.read(inactive.tx, base), error => error.code === 'failed-precondition');
  const overflow = fixture({ rotations: Array.from({ length: MAX_ROTATIONS + 1 }, (_, i) => ({ id: 'r' + i, value: {} })) });
  await assert.rejects(overflow.read(overflow.tx, base), error => error.code === 'resource-exhausted');
  const f = fixture({ rotations: [{ id: 'aa', value: {} }] });
  for (const bad of [
    { ...base, stationId: '../x' }, { ...base, targetRole: 'viewer' },
    { ...base, subStationIds: Array.from({ length: 32 }, (_, i) => 's' + i) }
  ]) await assert.rejects(f.read(f.tx, bad), error => error.code === 'failed-precondition');
});

test('Firestore read failures propagate and are not converted to missing configuration', async () => {
  const read = createAttendanceCorrectionConfigReader({ db: { collection: name => ref(name) }, HttpsError: E });
  const failure = new Error('transport-failed');
  await assert.rejects(read({ get: async () => { throw failure; } }, base), error => error === failure);
});
