'use strict';

const assert = require('node:assert/strict');
const { createScheduleAccessAdmin } = require('./schedule-access-admin');
const access = require('./schedule-access');

class TestHttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createDb(seed) {
  const store = new Map();
  Object.keys(seed || {}).forEach((path) => store.set(path, clone(seed[path])));

  function doc(path) {
    return {
      path,
      id: path.split('/').pop(),
      async get() { return snapshot(this); },
      collection(name) { return collection(path + '/' + String(name)); }
    };
  }
  function snapshot(ref) {
    const exists = store.has(ref.path);
    return {
      exists,
      ref,
      id: ref.id,
      data: () => exists ? clone(store.get(ref.path)) : undefined
    };
  }
  function collection(path) {
    return {
      path,
      doc(id) { return doc(path + '/' + String(id)); },
      async get() {
        const prefix = path + '/';
        const depth = path.split('/').length + 1;
        const docs = [];
        for (const [key] of store) {
          if (!key.startsWith(prefix) || key.split('/').length !== depth) continue;
          docs.push(snapshot(doc(key)));
        }
        return { docs };
      }
    };
  }
  function applySet(path, value, options) {
    const next = options && options.merge && store.has(path)
      ? Object.assign({}, store.get(path), clone(value)) : clone(value);
    store.set(path, next);
  }
  return {
    collection,
    async runTransaction(work) {
      const writes = [];
      const tx = {
        get: async (ref) => snapshot(ref),
        set: (ref, value, options) => writes.push({ ref, value, options })
      };
      const result = await work(tx);
      writes.forEach((write) => applySet(write.ref.path, write.value, write.options));
      return result;
    },
    read(path) { return store.has(path) ? clone(store.get(path)) : null; },
    write(path, value) { store.set(path, clone(value)); }
  };
}

function claims(stationId, role, extra) {
  return Object.assign({ stationId, role }, extra || {});
}

function member(station, role, extra) {
  return Object.assign({ station, role, active: true }, extra || {});
}

function request(uid, token, data) {
  return { auth: { uid, token }, data: data === undefined ? {} : data };
}

function fixture() {
  const db = createDb({
    'stations/alpha_1/users/hr': member('alpha_1', 'hr_coordinator', { full_name: 'רכזת' }),
    'stations/alpha_1/users/firefighter': member('alpha_1', 'firefighter', { full_name: 'כבאי' }),
    'stations/alpha_1/users/commander': member('alpha_1', 'commander', { full_name: 'מפקד' }),
    'stations/alpha_1/users/deputy': member('alpha_1', 'deputy', { full_name: 'סגן' }),
    'stations/alpha_1/users/disabled': member('alpha_1', 'firefighter', { active: false, full_name: 'מושבת' }),
    'stations/alpha_1/users/conflicted': member('alpha_1', 'firefighter', {
      stationId: 'beta_2', full_name: 'שיוך סותר'
    }),
    'stations/beta_2/users/other': member('beta_2', 'firefighter', { full_name: 'תחנה אחרת' })
  });
  const users = {
    hr: { uid: 'hr', customClaims: claims('alpha_1', 'hr_coordinator') },
    firefighter: { uid: 'firefighter', customClaims: claims('alpha_1', 'firefighter') },
    commander: { uid: 'commander', customClaims: claims('alpha_1', 'commander') },
    deputy: { uid: 'deputy', customClaims: claims('alpha_1', 'deputy') },
    disabled: { uid: 'disabled', customClaims: claims('alpha_1', 'firefighter') },
    conflicted: { uid: 'conflicted', customClaims: claims('alpha_1', 'firefighter') },
    other: { uid: 'other', customClaims: claims('beta_2', 'firefighter') },
    super: { uid: 'super', customClaims: claims('alpha_1', 'firefighter', { super: true }) },
    global_super: { uid: 'global_super', customClaims: { super: true } }
  };
  const audits = [];
  let getUserCalls = 0;
  const service = createScheduleAccessAdmin({
    db,
    getUser: async (uid) => {
      getUserCalls += 1;
      if (!users[uid]) throw new TestHttpsError('not-found', 'missing');
      return clone(users[uid]);
    },
    isSuper: (auth) => auth.token && auth.token.super === true,
    HttpsError: TestHttpsError,
    FieldValue: { serverTimestamp: () => '__server_time__' },
    openAudit: async (auth, action, target, details) => {
      const row = { actor_uid: auth.uid, action, target_uid: target, details: clone(details), outcome: 'started' };
      audits.push(row);
      return row;
    },
    sealAudit: async (ref, extra) => Object.assign(ref, clone(extra))
  });
  return { db, users, audits, service, getUserCalls: () => getUserCalls };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('✓ ' + name);
}

async function rejects(fn, code) {
  await assert.rejects(fn, (error) => error && error.code === code);
}

(async function run() {
  await test('HR can list only active members of the caller station without contact details', async () => {
    const { service } = fixture();
    const result = await service.list(request('hr', claims('alpha_1', 'hr_coordinator')));
    assert.equal(result.station_id, 'alpha_1');
    assert.deepEqual(result.members.map((row) => row.uid), ['firefighter', 'commander', 'deputy', 'hr']);
    assert.equal(Object.prototype.hasOwnProperty.call(result.members[0], 'email'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.members[0], 'phone'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result.members[0], 'revision'), false);
  });

  await test('a global super can look up one active target without a station or client path', async () => {
    const { service } = fixture();
    const result = await service.list(request('global_super', { super: true }, { uid: 'other' }));
    assert.deepEqual(Object.keys(result).sort(), ['members', 'ok', 'station_id']);
    assert.equal(result.station_id, 'beta_2');
    assert.equal(result.members.length, 1);
    assert.deepEqual(Object.keys(result.members[0]).sort(), ['enabled', 'name', 'primary_role', 'uid']);
    assert.deepEqual(result.members[0], {
      uid: 'other', name: 'תחנה אחרת', primary_role: 'firefighter', enabled: false
    });
  });

  await test('target lookup is super-only and rejects probes before Auth lookup', async () => {
    for (const [uid, token] of [
      ['hr', claims('alpha_1', 'hr_coordinator')],
      ['firefighter', claims('alpha_1', 'firefighter')]
    ]) {
      const value = fixture();
      await rejects(() => value.service.list(request(uid, token, { uid: 'other' })), 'permission-denied');
      assert.equal(value.getUserCalls(), 0, uid);
    }
  });

  await test('a global super fails closed for a station-wide list and malformed lookup inputs never probe Auth', async () => {
    const value = fixture();
    await rejects(() => value.service.list(request('global_super', { super: true })), 'failed-precondition');
    for (const data of [{ uid: '' }, { uid: 7 }, { uid: 'other', stationId: 'beta_2' },
      { uid: 'other', email: 'x@example.test' }]) {
      await rejects(() => value.service.list(request('global_super', { super: true }, data)), 'invalid-argument');
    }
    assert.equal(value.getUserCalls(), 0);
  });

  await test('target lookup rejects missing, inactive, and conflicting server identities without returning profile data', async () => {
    const { service } = fixture();
    for (const uid of ['missing', 'disabled', 'conflicted']) {
      await rejects(() => service.list(request('global_super', { super: true }, { uid })), 'failed-precondition');
    }
  });

  await test('HR can grant and revoke another active member without changing the primary role or claims', async () => {
    const { db, users, audits, service } = fixture();
    const beforeClaims = clone(users.firefighter.customClaims);
    const beforeProfile = db.read('stations/alpha_1/users/firefighter');
    const actor = request('hr', claims('alpha_1', 'hr_coordinator'));
    const granted = await service.set(request('hr', actor.auth.token, { uid: 'firefighter', enabled: true }));
    assert.equal(granted.changed, true);
    const grant = db.read('stations/alpha_1/schedule_access/firefighter');
    assert.equal(access.isManagerAccess(grant, 'alpha_1', 'firefighter'), true);
    assert.deepEqual(users.firefighter.customClaims, beforeClaims);
    assert.deepEqual(db.read('stations/alpha_1/users/firefighter'), beforeProfile);
    assert.deepEqual(audits[0].details, { station_id: 'alpha_1', enabled: true });
    assert.equal(audits[0].outcome, 'done');
    const revoked = await service.set(request('hr', actor.auth.token, { uid: 'firefighter', enabled: false }));
    assert.equal(revoked.changed, true);
    assert.equal(access.isManagerAccess(db.read('stations/alpha_1/schedule_access/firefighter'), 'alpha_1', 'firefighter'), false);
    assert.equal(db.read('stations/alpha_1/schedule_access/firefighter').revision, 2);
  });

  await test('a disabled record without a valid revision is repaired instead of treated as a completed revoke', async () => {
    const { db, service } = fixture();
    const path = 'stations/alpha_1/schedule_access/firefighter';
    db.write(path, {
      schema_version: 1, station_id: 'alpha_1', uid: 'firefighter',
      roles: [], active: false
    });
    const actor = request('hr', claims('alpha_1', 'hr_coordinator'));
    const repaired = await service.set(request('hr', actor.auth.token, { uid: 'firefighter', enabled: false }));
    assert.equal(repaired.changed, true);
    assert.equal(repaired.revision, 1);
    const exact = await service.set(request('hr', actor.auth.token, { uid: 'firefighter', enabled: false }));
    assert.equal(exact.changed, false);
    assert.equal(exact.revision, 1);
  });

  await test('HR cannot grant or revoke itself', async () => {
    const { db, audits, service } = fixture();
    await rejects(() => service.set(request('hr', claims('alpha_1', 'hr_coordinator'), {
      uid: 'hr', enabled: true
    })), 'permission-denied');
    assert.equal(db.read('stations/alpha_1/schedule_access/hr'), null);
    assert.equal(audits.length, 0);
  });

  await test('HR cannot mutate a target whose server-derived station differs', async () => {
    const { db, audits, service } = fixture();
    await rejects(() => service.set(request('hr', claims('alpha_1', 'hr_coordinator'), {
      uid: 'other', enabled: true
    })), 'permission-denied');
    assert.equal(db.read('stations/beta_2/schedule_access/other'), null);
    assert.equal(audits.length, 0);
  });

  await test('a disabled or conflicting target cannot receive the appointment', async () => {
    const { db, service } = fixture();
    for (const uid of ['disabled', 'conflicted']) {
      await rejects(() => service.set(request('hr', claims('alpha_1', 'hr_coordinator'), {
        uid, enabled: true
      })), 'failed-precondition');
      assert.equal(db.read('stations/alpha_1/schedule_access/' + uid), null);
    }
  });

  await test('a disabled or stale HR profile cannot manage appointments', async () => {
    const disabled = createDb({
      'stations/alpha_1/users/hr': member('alpha_1', 'hr_coordinator', { active: false }),
      'stations/alpha_1/users/firefighter': member('alpha_1', 'firefighter')
    });
    const isolated = createScheduleAccessAdmin({
      db: disabled,
      getUser: async () => ({ uid: 'firefighter', customClaims: claims('alpha_1', 'firefighter') }),
      isSuper: () => false,
      HttpsError: TestHttpsError,
      FieldValue: { serverTimestamp: () => '__server_time__' },
      openAudit: async () => ({ outcome: 'started' }),
      sealAudit: async () => {}
    });
    await rejects(() => isolated.set(request('hr', claims('alpha_1', 'hr_coordinator'), {
      uid: 'firefighter', enabled: true
    })), 'permission-denied');
    assert.equal(disabled.read('stations/alpha_1/schedule_access/firefighter'), null);
  });

  await test('HR is revalidated inside the transaction before an appointment is written', async () => {
    const { db, service } = fixture();
    const original = db.runTransaction;
    let swapped = false;
    db.runTransaction = async (work) => {
      if (!swapped) {
        swapped = true;
        db.write('stations/alpha_1/users/hr', member('alpha_1', 'firefighter', { full_name: 'תפקיד הוחלף' }));
      }
      return original(work);
    };
    await rejects(() => service.set(request('hr', claims('alpha_1', 'hr_coordinator'), {
      uid: 'firefighter', enabled: true
    })), 'permission-denied');
    assert.equal(db.read('stations/alpha_1/schedule_access/firefighter'), null);
  });

  await test('super can grant a target without a client-provided station', async () => {
    const { db, service } = fixture();
    const result = await service.set(request('super', claims('alpha_1', 'firefighter', { super: true }), {
      uid: 'other', enabled: true
    }));
    assert.equal(result.station_id, 'beta_2');
    assert.equal(access.isManagerAccess(db.read('stations/beta_2/schedule_access/other'), 'beta_2', 'other'), true);
  });

  await test('spoofed station aliases and extra fields are rejected before mutation', async () => {
    const { db, service } = fixture();
    for (const extra of [{ stationId: 'beta_2' }, { station_id: 'beta_2' }, { station: 'beta_2' }]) {
      await rejects(() => service.set(request('hr', claims('alpha_1', 'hr_coordinator'), Object.assign({
        uid: 'firefighter', enabled: true
      }, extra))), 'invalid-argument');
    }
    await rejects(() => service.list(request('hr', claims('alpha_1', 'hr_coordinator'), { stationId: 'beta_2' })),
      'invalid-argument');
    assert.equal(db.read('stations/alpha_1/schedule_access/firefighter'), null);
  });

  await test('commander and deputy do not obtain appointment authority from their primary role', async () => {
    const { audits, service } = fixture();
    for (const [uid, role] of [['commander', 'commander'], ['deputy', 'deputy']]) {
      await rejects(() => service.set(request(uid, claims('alpha_1', role), {
        uid: 'firefighter', enabled: true
      })), 'permission-denied');
    }
    assert.equal(audits.length, 0);
  });

  assert.equal(passed, 15);
  console.log('\n15 schedule access administration unit checks passed.');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
