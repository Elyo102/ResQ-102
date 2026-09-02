'use strict';

// Run only against the Firestore emulator:
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=demo-resq \
//     node functions/station-transfer.integration.test.js

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to use a real project.');
  process.exit(2);
}

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { createStationTransferService } = require('./station-transfer');

const projectId = process.env.GCLOUD_PROJECT || 'demo-resq';
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const runId = Date.now().toString(36) + '_' + process.pid.toString(36);
const cleanupPaths = new Set();
const cleanupSubjects = new Set();
let passed = 0;

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function namePrefixes(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return normalized ? [normalized] : [];
}

function actorRequest(env, requestId) {
  return {
    auth: {
      uid: env.actorUid,
      token: {
        email:env.actorUid + '@example.com', emp:'9001', role:'hr_coordinator',
        stationId:env.sourceSid, districtId:'south'
      }
    },
    data: {
      target_uid:env.subjectUid,
      target_station_id:env.targetSid,
      request_id:requestId
    }
  };
}

function identityCoordinatorTrap() {
  function unexpected() {
    throw new Error('identity coordinator must not run during transfer creation');
  }
  return {
    acquireAssignment:unexpected,
    runAssignment:unexpected,
    resumeOperation:unexpected,
    getOperation:async function () { return null; }
  };
}

async function scenario(label) {
  const suffix = runId + '_' + label;
  const sourceSid = ('src_' + suffix).slice(0, 79);
  const targetSid = ('dst_' + suffix).slice(0, 79);
  const actorUid = 'hr_' + suffix;
  const subjectUid = 'member_' + suffix;
  const users = new Map([
    [subjectUid, {
      uid:subjectUid,
      email:subjectUid + '@example.com',
      customClaims:{
        emp:'1003', role:'firefighter', stationId:sourceSid,
        districtId:'south', shift:'C'
      }
    }]
  ]);
  const actorRef = db.doc('stations/' + sourceSid + '/users/' + actorUid);
  const subjectRef = db.doc('stations/' + sourceSid + '/users/' + subjectUid);
  await Promise.all([
    actorRef.set({
      station:sourceSid, role:'hr_coordinator', employee_number:'9001', is_active:true
    }),
    subjectRef.set({
      full_name:'עובד אינטגרציה', email:subjectUid + '@example.com', phone:'0500000000',
      station:sourceSid, district:'south', role:'firefighter', crew:'C',
      employee_number:'1003', is_active:true
    })
  ]);
  cleanupPaths.add(actorRef.path);
  cleanupPaths.add(subjectRef.path);
  cleanupPaths.add('station_transfer_locks/' + subjectUid);
  cleanupPaths.add('identity_operations/' + subjectUid);
  cleanupSubjects.add(subjectUid);

  const service = createStationTransferService({
    db,
    getUser:async function (uid) {
      if (!users.has(uid)) throw new HttpsError('not-found', 'user missing');
      return JSON.parse(JSON.stringify(users.get(uid)));
    },
    isSuper:function () { return false; },
    HttpsError,
    FieldValue,
    identityCoordinator:identityCoordinatorTrap(),
    stableHash,
    namePrefixes,
    rankOf:function (role) {
      return role === 'hr_coordinator' ? 5 : (role === 'firefighter' ? 1 : -1);
    },
    resolveStation:async function (sid) {
      if (sid === targetSid) {
        return { id:targetSid, name:'תחנת יעד', districtId:'south', active:true };
      }
      if (sid === sourceSid) {
        return { id:sourceSid, name:'תחנת מקור', districtId:'south', active:true };
      }
      return null;
    },
    listStations:async function () {
      return [{ id:targetSid, name:'תחנת יעד', districtId:'south', active:true }];
    }
  });
  return { service, sourceSid, targetSid, actorUid, subjectUid };
}

function requestId(label) {
  return ('transfer_' + runId + '_' + label + '_000000000000').slice(0, 100);
}

async function test(name, fn) {
  await fn();
  passed++;
  console.log('✓ ' + name);
}

async function activeRequests(uid) {
  return db.collection('station_transfer_requests').where('target_uid', '==', uid).get();
}

async function cleanup() {
  for (const uid of cleanupSubjects) {
    const requests = await activeRequests(uid);
    requests.docs.forEach(function (snap) { cleanupPaths.add(snap.ref.path); });
    const audits = await db.collection('admin_audit').where('target_uid', '==', uid).get();
    audits.docs.forEach(function (snap) { cleanupPaths.add(snap.ref.path); });
  }
  const paths = Array.from(cleanupPaths);
  for (let index = 0; index < paths.length; index += 400) {
    const batch = db.batch();
    paths.slice(index, index + 400).forEach(function (path) { batch.delete(db.doc(path)); });
    await batch.commit();
  }
}

(async function run() {
  try {
    await test('two concurrent creates for one UID leave one request and one owned lock',
      async function () {
        const env = await scenario('race');
        const firstId = requestId('race_a');
        const secondId = requestId('race_b');
        const results = await Promise.allSettled([
          env.service.create(actorRequest(env, firstId)),
          env.service.create(actorRequest(env, secondId))
        ]);
        assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
        assert.equal(results.filter((row) => row.status === 'rejected').length, 1);
        const rejection = results.find((row) => row.status === 'rejected').reason;
        assert.equal(rejection && rejection.code, 'already-exists');

        const requests = await activeRequests(env.subjectUid);
        assert.equal(requests.size, 1);
        const winner = requests.docs[0].data();
        const lock = (await db.doc('station_transfer_locks/' + env.subjectUid).get()).data();
        assert.equal(lock.request_id, winner.request_id);
        assert.equal(lock.target_uid, env.subjectUid);
        assert.equal(lock.status, 'pending_target');
      });

    await test('a different create is blocked when an active request lost its lock',
      async function () {
        const env = await scenario('missing');
        const firstId = requestId('missing_a');
        const secondId = requestId('missing_b');
        await env.service.create(actorRequest(env, firstId));
        await db.doc('station_transfer_locks/' + env.subjectUid).delete();

        await assert.rejects(env.service.create(actorRequest(env, secondId)), function (error) {
          return error && error.code === 'already-exists';
        });
        const requests = await activeRequests(env.subjectUid);
        assert.equal(requests.size, 1);
        assert.equal(requests.docs[0].id, firstId);
        assert.equal((await db.doc('station_transfer_locks/' + env.subjectUid).get()).exists,
          false);
      });

    await test('idempotent replay repairs the sole active request lock', async function () {
      const env = await scenario('repair');
      const id = requestId('repair');
      const first = await env.service.create(actorRequest(env, id));
      assert.equal(first.changed, true);
      await db.doc('station_transfer_locks/' + env.subjectUid).delete();

      const replay = await env.service.create(actorRequest(env, id));
      assert.equal(replay.changed, true);
      assert.equal(replay.status, 'pending_target');
      const lock = (await db.doc('station_transfer_locks/' + env.subjectUid).get()).data();
      assert.equal(lock.request_id, id);
      assert.equal(lock.target_uid, env.subjectUid);
      assert.equal(lock.status, 'pending_target');
      assert.ok(lock.updated_at, 'the repaired lock must have a server timestamp');
      assert.equal((await activeRequests(env.subjectUid)).size, 1);
    });

    assert.equal(passed, 3);
    console.log('\n3 station-transfer Firestore integration checks passed.');
  } finally {
    await cleanup();
  }
  process.exit(0);
})().catch(function (error) {
  console.error(error);
  cleanup().catch(function () {}).finally(function () { process.exit(1); });
});
