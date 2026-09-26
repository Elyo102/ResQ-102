'use strict';

const assert = require('node:assert/strict');
const { createOperationalVehicleService, HOUR_LIMIT } = require('./operational-vehicle-service');
const contract = require('./operational-vehicle-contract');

class TestError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
}
function fixture(role = 'firefighter') {
  const data = new Map();
  const sid = 'eilat_102', uid = 'user-1';
  const db = {
    doc(path) { return { path }; },
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        async get(ref) {
          const value = data.get(ref.path);
          return { exists:value !== undefined, data:() => value };
        },
        create(ref, value) { writes.push(['create', ref.path, value]); },
        update(ref, value) { writes.push(['update', ref.path, value]); },
        set(ref, value) { writes.push(['set', ref.path, value]); }
      };
      const result = await callback(tx);
      for (const [kind, path, value] of writes) {
        if (kind === 'create' && data.has(path)) throw new Error('duplicate create');
        data.set(path, kind === 'update' ? { ...data.get(path), ...value } : value);
      }
      return result;
    }
  };
  data.set(`stations/${sid}/config/board`, { vehicles:[
    { id:'v407', name:'רכב 407' }, { id:'v408', active:false },
    { id:'v409', name:'רכב 409' }
  ] });
  data.set(`stations/${sid}/users/${uid}`, { role, stationId:sid, is_active:true });
  const claims = { role, stationId:sid };
  const authUser = { uid, disabled:false, customClaims:claims };
  const auth = { async getUser() { return authUser; } };
  const service = createOperationalVehicleService({
    db, auth, Timestamp:{ fromDate:date => date.toISOString() }, HttpsError:TestError,
    resolveStation:async id => id === sid ? { id, active:true } : null,
    listStations:async () => [{ id:sid, name:'אילת', active:true }],
    now:() => new Date('2026-09-26T10:00:00.000Z')
  });
  const req = body => ({ auth:{ uid, token:{ ...claims } }, data:body });
  return { data, sid, uid, claims, authUser, service, req };
}
const event = (id = 'request1234567890') => ({
  vehicle_id:'v407', request_id:id, kind:'removed', equipment:'זרנוק',
  location:'במחסן התחנה', was_replaced:false,
  replacement_equipment:'', source_vehicle_id:'', status:'open'
});
const transition = (status = 'in_progress', revision = 0,
  id = 'transition1234567890') => ({
  vehicle_id:'v407', event_id:event().request_id,
  request_id:id, expected_revision:revision, status, note:'נבדק במחסן'
});
const item = (revision = 0, id = 'request1234567890') => ({
  vehicle_id:'v407', compartment_id:'bay-1', item_id:'item-1', request_id:id,
  expected_revision:revision, name:'זרנוק', quantity:2, status:'present', notes:''
});
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff,0xd8,0xff,0x00,0x01]).toString('base64');
const photo = (revision = 0, id = 'request1234567890') => ({
  vehicle_id:'v407', compartment_id:'bay-1', request_id:id,
  expected_revision:revision, data:jpeg, w:1, h:1
});

async function test() {
  let passed = 0;
  const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
  await check('fixed compartments and explicit role lists', async () => {
    assert.equal(contract.COMPARTMENTS.length, 10);
    assert.equal(contract.EVENT_WRITERS.includes('hr_coordinator'), false);
    assert.equal(contract.FLEET_WRITERS.includes('hr_coordinator'), false);
  });
  await check('active firefighter appends one immutable event and exact retry is idempotent', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.recordEvent(f.req(event())), {
      event_id:event().request_id, created:true
    });
    assert.equal((await f.service.recordEvent(f.req(event()))).created, false);
    const stored = f.data.get(`stations/${f.sid}/vehicle_inventory/v407/equipment_events/${event().request_id}`);
    assert.equal(stored.by_uid, f.uid);
    assert.equal(stored.created_at, '2026-09-26T10:00:00.000Z');
    assert.equal(stored.equipment, 'זרנוק');
    await assert.rejects(() => f.service.recordEvent(f.req({ ...event(), equipment:'מזויף' })),
      error => error.code === 'already-exists');
  });
  await check('new equipment events cannot claim verified treatment on creation', async () => {
    const f = fixture();
    await assert.rejects(() => f.service.recordEvent(f.req({ ...event(), status:'resolved' })),
      error => error.code === 'invalid-argument');
    await assert.rejects(() => f.service.recordEvent(f.req({ ...event(), status:'in_progress' })),
      error => error.code === 'invalid-argument');
  });
  await check('only a live officer can advance equipment treatment with an audit receipt', async () => {
    const f = fixture('commander');
    await f.service.recordEvent(f.req(event()));
    const first = await f.service.transitionEvent(f.req(transition()));
    assert.deepEqual(first, { event_id:event().request_id, revision:1, written:true });
    assert.equal((await f.service.transitionEvent(f.req(transition()))).written, false);
    const ref = `stations/${f.sid}/vehicle_inventory/v407/equipment_events/${event().request_id}`;
    assert.equal(f.data.get(ref).status, 'in_progress');
    assert.equal(f.data.get(ref + '/transitions/transition1234567890').from, 'open');
    await assert.rejects(() => f.service.transitionEvent(f.req(transition('resolved', 0,
      'transition2234567890'))), error => error.code === 'aborted');
    assert.equal((await f.service.transitionEvent(f.req(transition('resolved', 1,
      'transition2234567890')))).revision, 2);
    await assert.rejects(() => f.service.transitionEvent(f.req(transition('in_progress', 2,
      'transition3234567890'))), error => error.code === 'failed-precondition');
  });
  await check('archived vehicle can finish existing treatment, revoked officer cannot', async () => {
    const f = fixture('commander');
    await f.service.recordEvent(f.req(event()));
    f.data.set(`stations/${f.sid}/config/board`, { vehicles:[{ id:'v407', active:false }] });
    assert.equal((await f.service.transitionEvent(f.req(transition()))).revision, 1);
    f.authUser.customClaims = { stationId:f.sid, role:'firefighter' };
    await assert.rejects(() => f.service.transitionEvent(f.req(transition('resolved', 1,
      'transition2234567890'))), error => error.code === 'permission-denied');
    const ff = fixture('firefighter');
    await ff.service.recordEvent(ff.req(event()));
    await assert.rejects(() => ff.service.transitionEvent(ff.req(transition())),
      error => error.code === 'permission-denied');
  });
  await check('super selects an active station; ordinary roles cannot inject a target', async () => {
    const f = fixture('commander');
    await assert.rejects(() => f.service.recordEvent(f.req({ ...event(),
      target_station_id:f.sid })), error => error.code === 'permission-denied');
    f.claims.super = true;
    f.authUser.customClaims.super = true;
    delete f.claims.stationId;
    delete f.authUser.customClaims.stationId;
    assert.deepEqual(await f.service.listAvailableStations({ auth:{ uid:f.uid,
      token:{ super:true } } }), { stations:[{ id:f.sid, name:'אילת' }] });
    await assert.rejects(() => f.service.recordEvent(f.req({ ...event(),
      target_station_id:'other_station' })), error => error.code === 'permission-denied');
    assert.equal((await f.service.recordEvent(f.req({ ...event(),
      target_station_id:f.sid }))).created, true);
    f.authUser.customClaims.super = false;
    await assert.rejects(() => f.service.listAvailableStations({ auth:{ uid:f.uid,
      token:{ super:true } } }), error => error.code === 'permission-denied');
  });
  await check('HR may not append; firefighter may not edit canonical inventory', async () => {
    const hr = fixture('hr_coordinator');
    await assert.rejects(() => hr.service.recordEvent(hr.req(event())),
      error => error.code === 'permission-denied');
    const ff = fixture();
    await assert.rejects(() => ff.service.saveItem(ff.req(item())),
      error => error.code === 'permission-denied');
  });
  await check('inactive/cross-station vehicles and disabled users fail closed', async () => {
    const f = fixture();
    await assert.rejects(() => f.service.recordEvent(f.req({ ...event(), vehicle_id:'v408' })),
      error => error.code === 'invalid-argument');
    await assert.rejects(() => f.service.recordEvent(f.req({ ...event(), vehicle_id:'other' })),
      error => error.code === 'invalid-argument');
    f.authUser.disabled = true;
    await assert.rejects(() => f.service.recordEvent(f.req(event())),
      error => error.code === 'permission-denied');
  });
  await check('officer item write requires revision and retains retry receipt', async () => {
    const f = fixture('commander');
    assert.equal((await f.service.saveItem(f.req(item()))).revision, 1);
    assert.equal((await f.service.saveItem(f.req(item()))).written, false);
    await assert.rejects(() => f.service.saveItem(f.req(item(0, 'anotherrequest12345'))),
      error => error.code === 'aborted');
    assert.equal((await f.service.saveItem(f.req(item(1, 'anotherrequest12345')))).revision, 2);
    assert.deepEqual(await f.service.saveItem(f.req(item())), {
      item_id:'item-1', revision:1, written:false
    });
    const path = `stations/${f.sid}/vehicle_inventory/v407/compartments/bay-1/items/item-1`;
    const first = f.data.get(path + '/changes/' + item().request_id);
    assert.equal(first.before, null);
    assert.equal(first.after.name, 'זרנוק');
    assert.equal(f.data.get(path + '/changes/anotherrequest12345').from_revision, 1);
    await assert.rejects(() => f.service.saveItem(f.req({ ...item(), name:'שינוי אחר' })),
      error => error.code === 'already-exists');
  });
  await check('officer photo is one bounded versioned document', async () => {
    const f = fixture('commander');
    assert.equal((await f.service.savePhoto(f.req(photo()))).revision, 1);
    assert.equal((await f.service.savePhoto(f.req(photo()))).written, false);
    await assert.rejects(() => f.service.savePhoto(f.req(photo(0, 'anotherrequest12345'))),
      error => error.code === 'aborted');
    const saved = f.data.get(`stations/${f.sid}/vehicle_inventory/v407/compartments/bay-1/photos/current`);
    assert.equal(saved.data, jpeg);
    const root = `stations/${f.sid}/vehicle_inventory/v407/compartments/bay-1/photos/current`;
    assert.equal(f.data.get(root + '/revisions/00000001').revision, 1);
    assert.equal(f.data.get(root + '/blobs/00000001').data, jpeg);
    assert.equal(f.data.get(root + '/revisions/00000001').data, undefined);
    const second = await f.service.savePhoto(f.req(photo(1, 'anotherrequest12345')));
    assert.equal(second.revision, 2);
    assert.equal((await f.service.savePhoto(f.req(photo()))).revision, 1);
    assert.equal(f.data.get(root + '/revisions/00000002').revision, 2);
    const restored = await f.service.restorePhoto(f.req({
      vehicle_id:'v407', compartment_id:'bay-1', request_id:'restorerequest12345',
      expected_revision:2, source_revision:1
    }));
    assert.equal(restored.revision, 3);
    assert.equal(f.data.get(root + '/revisions/00000003').restored_from_revision, 1);
    assert.equal(f.data.get(root + '/blobs/00000003').data, jpeg);
    await assert.rejects(() => f.service.restorePhoto(f.req({
      vehicle_id:'v407', compartment_id:'bay-1', request_id:'anotherrestore12345',
      expected_revision:2, source_revision:1
    })), error => error.code === 'aborted');
  });
  await check('legacy current photo is captured as immutable baseline on first change', async () => {
    const f = fixture('commander');
    const root = `stations/${f.sid}/vehicle_inventory/v407/compartments/bay-1/photos/current`;
    f.data.set(root, { schema:'vehicle-compartment-photo-v1', data:jpeg,
      w:1, h:1, revision:5, by_uid:f.uid, updated_at:'old-time' });
    assert.equal((await f.service.savePhoto(f.req(photo(5)))).revision, 6);
    assert.equal(f.data.get(root + '/revisions/00000005').source, 'legacy_baseline');
    assert.equal(f.data.get(root + '/blobs/00000005').data, jpeg);
    assert.equal(f.data.has(root + '/revisions/00000004'), false);
  });
  await check('corrupt legacy photo is not silently archived as a valid baseline', async () => {
    const f = fixture('commander');
    const root = `stations/${f.sid}/vehicle_inventory/v407/compartments/bay-1/photos/current`;
    f.data.set(root, { schema:'vehicle-compartment-photo-v1', data:'broken',
      w:1, h:1, revision:5, by_uid:f.uid });
    await assert.rejects(() => f.service.savePhoto(f.req(photo(5))),
      error => error.code === 'failed-precondition');
    assert.equal(f.data.has(root + '/revisions/00000006'), false);
    assert.equal(f.data.has(root + '/blobs/00000006'), false);
  });
  await check('near-limit photo fits one blob and malformed history cannot restore', async () => {
    const f = fixture('commander');
    const bytes = Buffer.alloc(contract.IMAGE_MAX, 0);
    bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
    const large = { ...photo(), data:'data:image/jpeg;base64,' + bytes.toString('base64') };
    assert.equal((await f.service.savePhoto(f.req(large))).revision, 1);
    const root = `stations/${f.sid}/vehicle_inventory/v407/compartments/bay-1/photos/current`;
    assert.equal(f.data.get(root + '/blobs/00000001').data, large.data);
    f.data.get(root + '/blobs/00000001').image_sha256 = 'wrong';
    await assert.rejects(() => f.service.restorePhoto(f.req({
      vehicle_id:'v407', compartment_id:'bay-1', request_id:'restorerequest12345',
      expected_revision:1, source_revision:1
    })), error => error.code === 'failed-precondition');
  });
  await check('event rate quota is bounded per actor/hour', async () => {
    const f = fixture();
    for (let i=0; i<HOUR_LIMIT; i++) {
      await f.service.recordEvent(f.req(event('request1234567890_' + i)));
    }
    await assert.rejects(() => f.service.recordEvent(f.req(event('request1234567890_over'))),
      error => error.code === 'resource-exhausted');
  });
  console.log(passed + ' operational vehicle service checks passed');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
