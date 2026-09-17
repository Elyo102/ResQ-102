'use strict';

const assert = require('node:assert/strict');
const contract = require('./station-provision-contract');
const { createStationProvisionService } = require('./station-provision-service');

let passed = 0;
const failed = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; })
    .catch((e) => { failed.push(name + ' :: ' + (e && e.message)); });
}

/* ------------------------------------------------ Firestore מזויף */

function fakeDb() {
  const store = new Map();
  const writes = [];
  const db = {
    _store: store,
    _writes: writes,
    _put(path, value) { store.set(path, value); },
    doc(path) { return { path }; },
    async runTransaction(fn) {
      const staged = [];
      const tx = {
        async get(ref) {
          const value = store.get(ref.path);
          return { exists: value !== undefined, data: () => value };
        },
        set(ref, value, options) { staged.push([ref.path, value, options]); }
      };
      const out = await fn(tx);
      for (const [path, value, options] of staged) {
        writes.push(path);
        if (options && options.merge) store.set(path, Object.assign({}, store.get(path) || {}, value));
        else store.set(path, value);
      }
      return out;
    }
  };
  return db;
}

class FakeHttpsError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'FakeHttpsError';
    this.status = status;
    this.code = code || null;
  }
}
const fail = (status, message, code) => { throw new FakeHttpsError(status, message, code); };

function build(over) {
  const db = (over && over.db) || fakeDb();
  let ticks = 0;
  const facts = {};
  let authCalls = 0;
  const service = createStationProvisionService({
    db,
    contract,
    serverTimestamp: () => '__ts_' + (ticks += 1),
    fail,
    verifyReadiness: (over && over.verifyReadiness) || (async ({tx, station_id}) => {
      await tx.get(db.doc('stations/' + station_id + '/config/hr'));
      return { ...facts };
    }),
    requireSuperAdmin: async (req) => {
      authCalls += 1;
      if (over && over.authHook) await over.authHook(authCalls, req);
      if (!req || !req.auth || req.auth.super !== true) fail('permission-denied', 'מנהל-על בלבד.', 'not-super');
      return { uid: req.auth.uid };
    }
  });
  return { db, service, facts };
}

const SUPER = Object.freeze({ uid: 'uid-super-1', super: true });
const DATA = Object.freeze({
  request_id: 'prov_20260915_0001',
  station_id: 'shahmon',
  district_id: 'south',
  display_name: 'תחנת שחמון',
  timezone: 'Asia/Jerusalem',
  template_id: 'fire-station-v1'
});
const reqWith = (over, auth) => ({ auth: auth || SUPER, data: Object.assign({}, DATA, over || {}) });

async function rejectsWith(fn, status, code) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, 'לא נזרקה שגיאה');
  assert.equal(threw.name, 'FakeHttpsError', 'נזרקה שגיאה אחרת: ' + threw);
  assert.equal(threw.status, status, 'status=' + threw.status + ' expected=' + status);
  if (code) assert.equal(threw.code, code, 'code=' + threw.code + ' expected=' + code);
}

/* ------------------------------------------------ הקמה */

const suite = (async () => {

  await test('V1 · התחנה נכתבת provisioning ומושתקת', async () => {
    const { db, service } = build();
    const out = await service.provisionStation(reqWith());
    assert.equal(out.ok, true);
    assert.equal(out.replayed, false);
    const station = db._store.get('stations/shahmon');
    assert.equal(station.status, 'provisioning');
    assert.equal(station.silent, true);
    assert.equal(station.created_by, 'uid-super-1');
  });

  await test('V2 · ארבעה זרעים נכתבים תחת התחנה הזאת בלבד', async () => {
    const { db, service } = build();
    await service.provisionStation(reqWith());
    for (const path of ['stations/shahmon/config/hr',
      'stations/shahmon/schedule_policy/current',
      'stations/shahmon/backup/registration',
      'stations/shahmon/health/inventory']) {
      assert.ok(db._store.has(path), 'זרע חסר: ' + path);
    }
    for (const path of db._writes) {
      assert.equal(path.startsWith('stations/shahmon'), true, 'כתיבה מחוץ לתחנה: ' + path);
    }
  });

  await test('V3 · מסמך מוכנות נוצר ריק — אף בדיקה אינה מסומנת', async () => {
    const { db, service } = build();
    await service.provisionStation(reqWith());
    const readiness = db._store.get('stations/shahmon/provision_readiness/current');
    assert.deepEqual(readiness.checks, {});
    assert.equal(contract.evaluateReadiness(readiness.checks).ready, false);
  });

  await test('V4 · רשומת פעולה נכתבת עם טביעת האצבע', async () => {
    const { db, service } = build();
    const out = await service.provisionStation(reqWith());
    const op = db._store.get('stations/shahmon/provision_operations/prov_20260915_0001');
    assert.equal(op.fingerprint, out.fingerprint);
    assert.equal(op.actor_uid, 'uid-super-1');
    assert.equal(op.result_status, 'provisioning');
  });

  /* ------------------------------------------------ ניסיון חוזר */

  await test('V5 · ניסיון חוזר זהה אינו יוצר תחנה כפולה ואינו כותב שוב', async () => {
    const { db, service } = build();
    const first = await service.provisionStation(reqWith());
    const writesAfterFirst = db._writes.length;
    const second = await service.provisionStation(reqWith());
    assert.equal(second.replayed, true);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(db._writes.length, writesAfterFirst, 'הניסיון החוזר כתב שוב');
  });

  await test('V6 · אותו מזהה בקשה עם תוכן אחר נדחה', async () => {
    const { service } = build();
    await service.provisionStation(reqWith());
    await rejectsWith(() => service.provisionStation(reqWith({ display_name: 'תחנה אחרת' })),
      'failed-precondition', 'provision-intent-changed');
  });

  await test('V7 · תחנה קיימת עם מזהה בקשה חדש — already-exists, בלי דריסה', async () => {
    const { db, service } = build();
    db._put('stations/shahmon', { status: 'ready', display_name: 'קיימת', silent: false });
    await rejectsWith(() => service.provisionStation(reqWith({ request_id: 'prov_20260915_0002' })),
      'already-exists', 'station-exists');
    assert.equal(db._store.get('stations/shahmon').display_name, 'קיימת', 'התחנה הקיימת נדרסה');
  });

  /* ------------------------------------------------ מה הלקוח אינו קובע */

  await test('V8 · actor_uid, status ו-silent מהקורא נדחים', async () => {
    const { service } = build();
    for (const forbidden of [{ actor_uid: 'uid-other' }, { status: 'ready' }, { silent: false }]) {
      await rejectsWith(() => service.provisionStation(reqWith(forbidden)), 'invalid-argument');
    }
  });

  await test('V9 · קלט פסול מוחזר כ-invalid-argument עם קוד החוזה', async () => {
    const { service } = build();
    await rejectsWith(() => service.provisionStation(reqWith({ template_id: 'nope' })),
      'invalid-argument', 'template-unknown');
    await rejectsWith(() => service.provisionStation(reqWith({ station_id: 'Shahmon' })),
      'invalid-argument', 'station-id');
  });

  await test('V10 · מי שאינו מנהל-על נחסם, ולא נכתב דבר', async () => {
    const { db, service } = build();
    await rejectsWith(() => service.provisionStation({ auth: { uid: 'uid-hr', super: false }, data: DATA }),
      'permission-denied', 'not-super');
    assert.equal(db._writes.length, 0);
  });

  /* ------------------------------------------------ מעבר ל-ready */

  async function provisioned() {
    const built = build();
    await built.service.provisionStation(reqWith());
    return built;
  }
  const readyReq = { auth: SUPER, data: { station_id: 'shahmon' } };

  await test('V11 · תחנה שזה עתה הוקמה אינה מוכנה, וכל החסר נקוב בשמו', async () => {
    const { db, service } = await provisioned();
    let threw = null;
    try { await service.markStationReady(readyReq); } catch (e) { threw = e; }
    assert.ok(threw);
    assert.equal(threw.code, 'station-not-ready');
    for (const check of contract.READINESS_CHECKS) {
      assert.ok(threw.message.includes(check), 'החסר ' + check + ' לא נקוב');
    }
    assert.equal(db._store.get('stations/shahmon').status, 'provisioning');
  });

  await test('V12 · כל הבדיקות מסומנות → ready', async () => {
    const { db, service, facts } = await provisioned();
    const checks = facts;
    for (const c of contract.READINESS_CHECKS) checks[c] = true;
    db._put('stations/shahmon/provision_readiness/current', { checks });
    const out = await service.markStationReady(readyReq);
    assert.equal(out.status, 'ready');
    assert.equal(db._store.get('stations/shahmon').status, 'ready');
    assert.equal(db._store.get('stations/shahmon').ready_by, 'uid-super-1');
  });

  await test('V13 · בדיקה אחת חסרה מספיקה כדי לסרב', async () => {
    for (const missing of contract.READINESS_CHECKS) {
      const { db, service, facts } = await provisioned();
      const checks = facts;
      for (const c of contract.READINESS_CHECKS) checks[c] = true;
      delete checks[missing];
      db._put('stations/shahmon/provision_readiness/current', { checks });
      let threw = null;
      try { await service.markStationReady(readyReq); } catch (e) { threw = e; }
      assert.ok(threw, 'הוכרזה מוכנות בלי ' + missing);
      assert.equal(threw.code, 'station-not-ready');
      assert.ok(threw.message.includes(missing));
    }
  });

  await test('V14 · מצב מוכנות מהקורא נדחה', async () => {
    const { service } = await provisioned();
    await rejectsWith(() => service.markStationReady({
      auth: SUPER, data: { station_id: 'shahmon', checks: { silence_wired: true } }
    }), 'invalid-argument', 'checks-from-client');
  });

  await test('V15 · הכרזה חוזרת על תחנה מוכנה מחזירה replayed', async () => {
    const { db, service, facts } = await provisioned();
    const checks = facts;
    for (const c of contract.READINESS_CHECKS) checks[c] = true;
    db._put('stations/shahmon/provision_readiness/current', { checks });
    await service.markStationReady(readyReq);
    const out = await service.markStationReady(readyReq);
    assert.equal(out.replayed, true);
    assert.equal(out.status, 'ready');
  });

  await test('V16 · תחנה שאינה קיימת, ומנהל שאינו על', async () => {
    const { service } = build();
    await rejectsWith(() => service.markStationReady(readyReq), 'not-found', 'station-missing');
    await rejectsWith(() => service.markStationReady({ auth: { uid: 'x', super: false }, data: { station_id: 'shahmon' } }),
      'permission-denied', 'not-super');
  });

  await test('V17 · חותמת הזמן מגיעה מהתלות המוזרקת, לא מהמודול', async () => {
    const { db, service } = build();
    await service.provisionStation(reqWith());
    assert.match(String(db._store.get('stations/shahmon').created_at), /^__ts_\d+$/);
  });

  await test('V18 · תלות חסרה נדחית בהקמת השירות', async () => {
    assert.throws(() => createStationProvisionService({ db: {}, contract }), TypeError);
    assert.throws(() => createStationProvisionService(null), TypeError);
  });

  await test('V19 · actual SDK validates every seeded document path without network', async () => {
    const { createRequire } = require('node:module');
    const path = require('node:path');
    // Staging has no installed dependencies. Integration can set this to its
    // own functions/package.json; this still loads the real installed SDK.
    const realRequire = createRequire(process.env.RESQ_FUNCTIONS_PACKAGE ||
      path.resolve(__dirname, './package.json'));
    const { Firestore } = realRequire('firebase-admin/firestore');
    const sdk = new Firestore({projectId:'demo-resq-provision-paths'});
    const db = fakeDb();
    const doc = db.doc;
    db.doc = path => { assert.equal(sdk.doc(path).path, path); return doc(path); };
    const { service } = build({db});
    await service.provisionStation(reqWith());
    assert.equal(db._store.get('stations/shahmon').active, false);
    assert.equal(db._store.get('stations/shahmon').name, DATA.display_name);
    const hr = db._store.get('stations/shahmon/config/hr');
    assert.equal(hr.email, null); assert.equal(hr.name, null); assert.equal(hr.hour_limit, null);
    assert.equal('hr_email' in hr, false);
  });
  await test('V20 · fresh authorization revocation before provisioning writes aborts atomically', async () => {
    const {db,service}=build({authHook:async n=>{if(n===2)fail('permission-denied','revoked');}});
    await rejectsWith(()=>service.provisionStation(reqWith()),'permission-denied');
    assert.equal(db._writes.length,0);
  });
  await test('V21 · fresh authorization revocation on replay is rejected', async () => {
    const {db,service}=build({authHook:async n=>{if(n===4)fail('permission-denied','revoked');}});
    await service.provisionStation(reqWith()); const count=db._writes.length;
    await rejectsWith(()=>service.provisionStation(reqWith()),'permission-denied');
    assert.equal(db._writes.length,count);
  });
  await test('V22 · stored readiness booleans do not grant readiness', async () => {
    const {db,service}=await provisioned();
    db._put('stations/shahmon/provision_readiness/current',{checks:Object.fromEntries(contract.READINESS_CHECKS.map(k=>[k,true]))});
    await rejectsWith(()=>service.markStationReady(readyReq),'failed-precondition','station-not-ready');
    assert.equal(db._store.get('stations/shahmon').active,false);
  });
  await test('V23 · readiness verifier sees transaction and revocation before activation aborts', async () => {
    const {db,service,facts}=build({authHook:async n=>{if(n===4)fail('permission-denied','revoked');}});
    await service.provisionStation(reqWith());
    for(const key of contract.READINESS_CHECKS)facts[key]=true;
    const count=db._writes.length;
    await rejectsWith(()=>service.markStationReady(readyReq),'permission-denied');
    assert.equal(db._writes.length,count); assert.equal(db._store.get('stations/shahmon').active,false);
  });
  await test('V24 · path injection and unlisted input keys rejected', async () => {
    const {db,service}=build();
    for(const station_id of ['aa/bb/cc','../aa','Aaaa',''])await rejectsWith(()=>service.markStationReady({auth:SUPER,data:{station_id}}),'invalid-argument','station-id');
    await rejectsWith(()=>service.provisionStation(reqWith({extra:true})),'invalid-argument','input-shape');
    assert.equal(db._writes.length,0);
  });
  await test('V25 · ready replay reevaluates actual facts and fresh authorization', async () => {
    const {db,service,facts}=await provisioned();
    for(const key of contract.READINESS_CHECKS)facts[key]=true;
    await service.markStationReady(readyReq); assert.equal(db._store.get('stations/shahmon').active,true);
    assert.equal(db._store.get('stations/shahmon').silent,true);
    facts.first_admin_active=false;
    await rejectsWith(()=>service.markStationReady(readyReq),'failed-precondition','station-not-ready');
  });
  await test('V26 · orphaned seeds and readiness evidence are never overwritten', async () => {
    const paths = contract.planStationProvision({...DATA,actor_uid:SUPER.uid}).seeds.map(s=>s.path)
      .concat('provision_readiness/current');
    for(const relative of paths){
      const {db,service}=build();
      const path='stations/shahmon/'+relative, evidence={keep:'original'};
      db._put(path,evidence);
      await rejectsWith(()=>service.provisionStation(reqWith()),'already-exists','station-seed-exists');
      assert.equal(db._writes.length,0); assert.deepEqual(db._store.get(path),evidence);
      assert.equal(db._store.has('stations/shahmon'),false);
    }
  });
})();

suite.then(() => {
  console.log('station-provision-service: ' + passed + ' tests passed'
    + (failed.length ? ', ' + failed.length + ' FAILED' : ''));
  for (const f of failed) console.log('  FAIL ' + f);
  if (failed.length) process.exit(1);
});
