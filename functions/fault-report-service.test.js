'use strict';

const assert = require('node:assert/strict');
const { createFaultReportService, inputOf, israelDate } = require('./fault-report-service');

const SID = 'eilat_102';
const UID = 'firefighter-1';
const ID = 'ABCDEFGHIJKLMNOPQRST';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');

function harness(options = {}) {
  const docs = new Map();
  docs.set(`stations/${SID}/users/${UID}`, { full_name:'ישראל', role:'firefighter', stationId:SID });
  docs.set(`stations/${SID}/config/board`, {
    vehicles:[{ id:'v1', name:'כבאית 1', active:true }]
  });
  const reads = [];
  const db = {
    doc(path) {
      return {
        path,
        collection(name) { return { doc(id) { return db.doc(path + '/' + name + '/' + id); } }; }
      };
    },
    async runTransaction(callback) {
      const pending = [];
      const tx = {
        async get(ref) {
          reads.push(ref.path);
          const value = docs.get(ref.path);
          return { exists: value !== undefined, data: () => value };
        },
        create(ref, value) {
          if (options.failPhoto && ref.path.endsWith('/photos/p1')) throw new Error('photo-write-failed');
          pending.push([ref.path, value]);
        },
        update(ref, value) { pending.push([ref.path, { ...docs.get(ref.path), ...value }]); },
        set(ref, value) { pending.push([ref.path, value]); }
      };
      const result = await callback(tx);
      for (const [key, value] of pending) docs.set(key, value);
      return result;
    }
  };
  const auth = { async getUser() { return options.authUser || {
    customClaims:{ role:'firefighter', emp:'42', stationId:SID, shift:'A' }
  }; } };
  const Timestamp = { fromDate: date => ({ toDate: () => date }) };
  const service = createFaultReportService({ db, auth, Timestamp,
    now:() => new Date('2026-09-24T22:30:00.000Z'),
    fail:(status, message, reason) => { const err = new Error(reason); err.status=status; throw err; }
  });
  const data = { stationId:SID, expectedUid:UID, reportId:ID,
    kind:'gear', vehicleId:'v1', title:'תקלה בציוד הרכב',
    desc:'פנס לא עובד', severity:'unset', photos:[] };
  return { docs, reads, service, data, req: data => ({ auth:{ uid:UID }, data }) };
}

async function main() {
  const t = harness();
  const pictures = Array.from({ length:3 }, () => ({ data:JPEG, w:4, h:4 }));
  const request = { ...t.data, photos:pictures };
  const created = await t.service.create(t.req(request));
  assert.equal(created.created, true);
  const path = `stations/${SID}/faults/${ID}`;
  const fault = t.docs.get(path);
  assert.equal(fault.photos, 3);
  assert.equal(fault.vehicle_name, 'כבאית 1');
  assert.equal(fault.vehicle_id, 'v1');
  assert.equal(fault.by_uid, UID);
  assert.equal(fault.date, '2026-09-25');
  assert.equal(fault.created_key, '2026-09-24T22:30:00.000Z');
  assert.equal(fault.created_at.toDate().toISOString(), fault.created_key);
  for (let i=0; i<3; i++) assert.equal(t.docs.get(path + '/photos/p' + i).data, JPEG);
  const replay = await t.service.create(t.req(request));
  assert.equal(replay.created, false);
  assert.equal(t.docs.size, 6);
  await assert.rejects(t.service.create(t.req({ ...request, title:'changed' })), /report_id_conflict/);
  await assert.rejects(t.service.create(t.req({ ...request, expectedUid:'someone-else' })), /identity_changed/);
  const batch = { stationId:SID, expectedUid:UID, reportId:ID,
    requestId:'batch_000000000000001', photos:[pictures[0]] };
  const appended = await t.service.appendPhotos(t.req(batch));
  assert.equal(appended.appended, 1);
  assert.equal(t.docs.get(path).photos, 4);
  assert.equal(t.docs.get(path + '/photos/' + batch.requestId + '_0').data, JPEG);
  assert.equal((await t.service.appendPhotos(t.req(batch))).replay, true);
  assert.equal(t.docs.get(path).photos, 4);
  await assert.rejects(t.service.appendPhotos(t.req({ ...batch, photos:pictures.slice(0,2) })),
    /batch_conflict/);
  await assert.rejects(t.service.appendPhotos(t.req({ ...batch, requestId:'batch_000000000000002',
    photos:pictures.concat(pictures[0]) })), /invalid_photo_batch/);
  const old = t.docs.get(path);
  t.docs.set(path, { ...old, by_uid:'other-user' });
  await assert.rejects(t.service.appendPhotos(t.req({ ...batch, requestId:'batch_000000000000003' })),
    /report_author_forbidden/);
  t.docs.set(path, old);

  const missing = harness();
  missing.docs.set(`stations/${SID}/vehicles/abcdefghijklmnopqrst`, {
    name:'רכב לוגיסטי', kind:'anchor', active:true
  });
  const anchor = await missing.service.create(missing.req({ ...missing.data,
    reportId:'ZYXWVUTSRQPONMLKJIHG', vehicleId:'abcdefghijklmnopqrst' }));
  assert.equal(anchor.created, true);
  assert.equal(missing.docs.get(`stations/${SID}/faults/ZYXWVUTSRQPONMLKJIHG`).vehicle_name, 'רכב לוגיסטי');
  assert.throws(() => inputOf({ ...missing.data, vehicleId:'../other' }), /invalid-input/);
  assert.equal(inputOf({ ...missing.data, point:{ side:'rear', x:0.5, y:0.5 } }).point.side, 'rear');
  assert.equal(inputOf({ ...missing.data, point:{ side:'roof', x:0.5, y:0.5 } }).point.side, 'roof');
  assert.throws(() => inputOf({ ...missing.data, point:{ side:'roof', x:1.1, y:0.5 } }), /invalid-input/);
  assert.throws(() => inputOf({ ...missing.data, point:{ side:'back', x:0.5, y:0.5 } }), /invalid-input/);
  await assert.rejects(missing.service.create(missing.req({ ...missing.data,
    vehicleId:'ZZZZZZZZZZZZZZZZZZZZ' })), /vehicle_invalid/);
  assert.equal([...missing.docs.keys()].filter(x => x.endsWith(`/faults/${ID}`)).length, 0);
  const changedRole = harness({ authUser:{ customClaims:{ role:'firefighter', emp:'42', stationId:'other' } } });
  await assert.rejects(changedRole.service.create(changedRole.req(changedRole.data)), /station_forbidden/);
  const dead = harness();
  dead.docs.set(`stations/${SID}/users/${UID}`, { role:'firefighter', active:false });
  await assert.rejects(dead.service.create(dead.req(dead.data)), /station_membership_changed/);
  const atomic = harness({ failPhoto:true });
  await assert.rejects(atomic.service.create(atomic.req({ ...atomic.data, photos:pictures })), /photo-write-failed/);
  assert.equal([...atomic.docs.keys()].filter(x => x.includes('/faults/')).length, 0);
  assert.equal(inputOf({ ...t.data, title:'א'.repeat(240) }).title.length, 240);
  assert.throws(() => inputOf({ ...t.data, title:'א'.repeat(241) }), /invalid-input/);
  assert.throws(() => inputOf({ ...t.data, photos:[{ data:'data:image/png;base64,AA==', w:1, h:1 }] }), /invalid-input/);
  assert.throws(() => inputOf({ ...t.data, photos:pictures.concat(pictures[0]) }), /invalid-input/);
  assert.equal(israelDate(new Date('2026-12-24T22:30:00.000Z')), '2026-12-25');
  assert.equal(israelDate(new Date('2026-09-24T22:30:00.000Z')), '2026-09-25');
  console.log('PASS fault report service: atomic photos, idempotency, live identity, same-station vehicle, server clock, limits');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
