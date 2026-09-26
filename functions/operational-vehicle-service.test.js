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
  });
  await check('officer photo is one bounded versioned document', async () => {
    const f = fixture('commander');
    assert.equal((await f.service.savePhoto(f.req(photo()))).revision, 1);
    assert.equal((await f.service.savePhoto(f.req(photo()))).written, false);
    await assert.rejects(() => f.service.savePhoto(f.req(photo(0, 'anotherrequest12345'))),
      error => error.code === 'aborted');
    const saved = f.data.get(`stations/${f.sid}/vehicle_inventory/v407/compartments/bay-1/photos/current`);
    assert.equal(saved.data, jpeg);
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
