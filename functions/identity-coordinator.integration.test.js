'use strict';

// Run only through the Firestore emulator:
// firebase emulators:exec --only firestore --project demo-resq
//   "cd functions && node identity-coordinator.integration.test.js"

const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  createIdentityCoordinator, stableHash, registrationFingerprint, profileMatches
} = require('./identity-coordinator');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to run against a real project.');
  process.exit(2);
}

if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-resq' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;
let ids = 0;
let passed = 0;

class FakeAuth {
  constructor() {
    this.users = new Map();
    this.setCalls = 0;
    this.revokeCalls = 0;
    this.failSetBefore = 0;
    this.failRevoke = 0;
  }

  seed(uid, claims, email) {
    this.users.set(uid, {
      uid: uid,
      email: email || uid + '@example.com',
      customClaims: JSON.parse(JSON.stringify(claims || {}))
    });
  }

  async getUser(uid) {
    if (!this.users.has(uid)) this.seed(uid, {});
    return JSON.parse(JSON.stringify(this.users.get(uid)));
  }

  async setCustomUserClaims(uid, claims) {
    this.setCalls++;
    if (this.failSetBefore > 0) {
      this.failSetBefore--;
      throw new Error('injected Auth failure before write');
    }
    const user = await this.getUser(uid);
    user.customClaims = claims == null ? {} : JSON.parse(JSON.stringify(claims));
    this.users.set(uid, user);
  }

  async revokeRefreshTokens() {
    this.revokeCalls++;
    if (this.failRevoke > 0) {
      this.failRevoke--;
      throw new Error('injected revoke failure');
    }
  }
}

function coordinator(fakeAuth, hooks, options) {
  return createIdentityCoordinator({
    db: db,
    auth: fakeAuth,
    FieldValue: FV,
    Timestamp: Timestamp,
    HttpsError: HttpsError,
    randomId: function () { ids++; return 'generated-request-' + String(ids).padStart(8, '0'); },
    leaseMs: 300000,
    fenceMs: (options && options.fenceMs) || 180000,
    hooks: hooks || {}
  });
}

function requestData(uid, requestId) {
  return {
    request_id: requestId,
    full_name: 'כבאי ' + uid,
    email: uid + '@example.com',
    phone: '0500000000',
    districtId: 'south',
    stationId: 'eilat_102',
    shift: 'A',
    status: 'pending',
    created_at: FV.serverTimestamp()
  };
}

async function seedRequest(uid, requestId) {
  const data = requestData(uid, requestId);
  if (!requestId) delete data.request_id;
  const ref = db.doc('registration_requests/' + uid);
  await ref.set(data);
  if (requestId) {
    const saved = (await ref.get()).data();
    await ref.set({
      server_generation: generationFor(requestId),
      request_fingerprint: registrationFingerprint(uid, saved),
      fingerprint_version: 1
    }, { merge: true });
  }
}

function generationFor(requestId) {
  return 'server-' + stableHash(String(requestId || '')).slice(0, 32);
}

function approvalParams(uid, requestId, opId, previousClaims, wantedEmp) {
  const requestGeneration = generationFor(requestId);
  return {
    uid: uid,
    opId: opId,
    kind: 'approve',
    actorUid: 'u_super',
    actorEmail: 'super@example.com',
    previousClaims: previousClaims || {},
    previousEmp: (previousClaims || {}).emp || '',
    previousStation: (previousClaims || {}).stationId || '',
    requireRequest: true,
    attachPendingRequest: false,
    requestId: requestId,
    requestGeneration: requestGeneration,
    blockIfAssigned: true,
    intentFingerprint: stableHash({
      kind: 'approve', uid: uid, request_generation: requestGeneration,
      wanted_emp: wantedEmp || '', employee_mode: wantedEmp ? 'fixed' : 'auto'
    }),
    employeeMode: wantedEmp ? 'fixed' : 'auto',
    wantedEmp: wantedEmp || '',
    employeeStart: 1,
    auditAction: 'approve_registration',
    auditDetails: { test: true },
    makePlan: function (emp, request) {
      const claims = {
        role: 'firefighter', stationId: 'eilat_102', districtId: 'south',
        shift: 'A', emp: emp
      };
      return {
        desiredClaims: claims,
        desiredProfile: {
          full_name: request.full_name || 'כבאי בדיקה',
          name_prefixes: ['כב', 'כבא'],
          email: uid + '@example.com', phone: request.phone || '',
          role: claims.role, shift: claims.shift,
          stationId: claims.stationId, districtId: claims.districtId
        }
      };
    }
  };
}

function roleParams(uid, opId, previousClaims, wantedEmp) {
  return {
    uid: uid,
    opId: opId,
    kind: 'set_role',
    actorUid: 'u_super',
    actorEmail: 'super@example.com',
    previousClaims: previousClaims || {},
    previousEmp: (previousClaims || {}).emp || '',
    previousStation: (previousClaims || {}).stationId || '',
    requireRequest: false,
    attachPendingRequest: true,
    requestId: '',
    requestGeneration: '',
    blockIfAssigned: false,
    intentFingerprint: stableHash({
      kind: 'set_role', uid: uid, wanted_emp: wantedEmp
    }),
    employeeMode: 'fixed',
    wantedEmp: wantedEmp,
    auditAction: 'set_role',
    auditDetails: { test: true },
    makePlan: function (emp) {
      const claims = {
        role: 'commander', stationId: 'eilat_102', districtId: 'south',
        shift: 'B', emp: emp
      };
      return {
        desiredClaims: claims,
        desiredProfile: {
          full_name: 'מפקד ' + uid, name_prefixes: ['מפ', 'מפק'],
          email: uid + '@example.com', phone: '', role: claims.role,
          shift: claims.shift, stationId: claims.stationId,
          districtId: claims.districtId
        }
      };
    }
  };
}

async function test(name, fn) {
  await fn();
  passed++;
  console.log('✓ ' + name);
}

async function rejectsCode(code, promise) {
  try {
    await promise;
    assert.fail('expected error ' + code);
  } catch (error) {
    if (error && error.code === 'ERR_ASSERTION') throw error;
    assert.match(String((error && error.code) || ''), new RegExp(code + '$'));
  }
}

(async function run() {
  await test('every planned profile and index field participates in final verification', async function () {
    const op = {
      uid:'profile-check', desired_emp:'6001',
      desired_profile:{ full_name:'כבאי בדיקה', name_prefixes:['כב','כבא'],
        email:'profile@example.com', phone:'0500000000', role:'firefighter',
        shift:'A', stationId:'eilat_102', districtId:'south' }
    };
    const docs = {
      user:{ employee_number:'6001', full_name:'כבאי בדיקה', email:'profile@example.com',
        phone:'0500000000', role:'firefighter', crew:'A', station:'eilat_102',
        district:'south', is_active:true },
      roster:{ full_name:'כבאי בדיקה', role:'firefighter', crew:'A', is_active:true },
      directory:{ full_name:'כבאי בדיקה', name_prefixes:['כב','כבא'], role:'firefighter',
        crew:'A', station:'eilat_102', district:'south', is_active:true },
      index:{ uid:'profile-check', email:'profile@example.com', stationId:'eilat_102',
        status:'active', active:true, retired:false }
    };
    assert.equal(profileMatches(op, docs), true);
    const mutations = [
      ['user','employee_number','x'], ['user','full_name','x'], ['user','email','x@x.com'],
      ['user','phone','x'], ['user','role','commander'], ['user','crew','B'],
      ['user','station','other'], ['user','district','north'], ['user','is_active',false],
      ['roster','full_name','x'], ['roster','role','commander'], ['roster','crew','B'],
      ['roster','is_active',false], ['directory','full_name','x'],
      ['directory','name_prefixes',['bad']], ['directory','role','commander'],
      ['directory','crew','B'], ['directory','station','other'],
      ['directory','district','north'], ['directory','is_active',false],
      ['index','uid','other'], ['index','email','x@x.com'], ['index','stationId','other'],
      ['index','active',false], ['index','retired',true]
    ];
    for (const [group, field, value] of mutations) {
      const changed = JSON.parse(JSON.stringify(docs));
      changed[group][field] = value;
      assert.equal(profileMatches(op, changed), false, group + '.' + field);
    }
    const withLegacyExtras = JSON.parse(JSON.stringify(docs));
    withLegacyExtras.user.legacy_note = 'kept';
    assert.equal(profileMatches(op, withLegacyExtras), true);
  });

  await test('every registration request field participates in the server fingerprint', async function () {
    const uid = 'fingerprint-user';
    const request = {
      request_id: 'request-fingerprint-0001',
      full_name: 'כבאי בדיקה',
      email: 'firefighter@example.com',
      phone: '0500000000',
      districtId: 'south',
      stationId: 'eilat_102',
      shift: 'A',
      created_at: { seconds: 1777777000, nanoseconds: 123456789 }
    };
    const original = registrationFingerprint(uid, request);
    const mutations = [
      ['request_id', 'request-fingerprint-0002'],
      ['full_name', 'כבאי אחר'],
      ['email', 'other@example.com'],
      ['phone', '0520000000'],
      ['districtId', 'north'],
      ['stationId', 'other_station'],
      ['shift', 'B'],
      ['created_at', { seconds: 1777777001, nanoseconds: 123456789 }]
    ];
    for (const [field, value] of mutations) {
      const changed = Object.assign({}, request, { [field]: value });
      assert.notEqual(registrationFingerprint(uid, changed), original, field);
    }
    assert.notEqual(registrationFingerprint('different-uid', request), original, 'uid');
  });

  await test('two different approval operations cannot acquire the same uid', async function () {
    const uid = 'race_same_uid';
    const requestId = 'request-race-same-uid-0001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const results = await Promise.allSettled([
      service.acquireAssignment(approvalParams(uid, requestId, 'approve-race-operation-a', {}, '6101')),
      service.acquireAssignment(approvalParams(uid, requestId, 'approve-race-operation-b', {}, '6102'))
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
    const op = (await db.doc('identity_operations/' + uid).get()).data();
    assert.equal(op.status, 'processing');
    assert.ok(['6101', '6102'].includes(op.desired_emp));
  });

  await test('the same operation id cannot resume a different intent', async function () {
    const uid = 'intent_mismatch';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    const first = roleParams(uid, 'same-operation-different-intent', {}, '6151');
    await service.acquireAssignment(first);
    const changed = roleParams(uid, 'same-operation-different-intent', {}, '6152');
    await rejectsCode('aborted', service.acquireAssignment(changed));
    const op = (await db.doc('identity_operations/' + uid).get()).data();
    assert.equal(op.desired_emp, '6151');
  });

  await test('approve and set-role cannot both own one uid', async function () {
    const uid = 'race_two_kinds';
    const requestId = 'request-race-two-kinds-001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const results = await Promise.allSettled([
      service.acquireAssignment(approvalParams(uid, requestId, 'approve-kind-operation', {}, '6201')),
      service.acquireAssignment(roleParams(uid, 'set-role-kind-operation', {}, '6202'))
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  });

  await test('one manual employee number can be reserved by only one uid', async function () {
    const fake = new FakeAuth();
    const service = coordinator(fake);
    const a = 'manual_emp_a'; const b = 'manual_emp_b';
    const ra = 'request-manual-a-00000001'; const rb = 'request-manual-b-00000001';
    fake.seed(a, {}); fake.seed(b, {});
    await Promise.all([seedRequest(a, ra), seedRequest(b, rb)]);
    const results = await Promise.allSettled([
      service.acquireAssignment(approvalParams(a, ra, 'manual-reservation-op-a', {}, '6301')),
      service.acquireAssignment(approvalParams(b, rb, 'manual-reservation-op-b', {}, '6301'))
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    const reservation = (await db.doc('emp_reservations/6301').get()).data();
    assert.ok([a, b].includes(reservation.uid));
  });

  await test('parallel automatic allocations remain unique', async function () {
    const fake = new FakeAuth();
    const service = coordinator(fake);
    const a = 'auto_emp_a'; const b = 'auto_emp_b';
    const ra = 'request-auto-a-0000000001'; const rb = 'request-auto-b-0000000001';
    fake.seed(a, {}); fake.seed(b, {});
    await db.doc('meta/emp_counter').set({ next: 6400 });
    await Promise.all([seedRequest(a, ra), seedRequest(b, rb)]);
    const acquired = await Promise.all([
      service.acquireAssignment(approvalParams(a, ra, 'auto-reservation-op-a', {}, '')),
      service.acquireAssignment(approvalParams(b, rb, 'auto-reservation-op-b', {}, ''))
    ]);
    const values = acquired.map(x => x.operation.desired_emp).sort();
    assert.deepEqual(values, ['6400', '6401']);
  });

  await test('manual and automatic allocation cannot produce the same employee number', async function () {
    const fake = new FakeAuth();
    const service = coordinator(fake);
    const manualUid = 'manual_vs_auto_manual';
    const autoUid = 'manual_vs_auto_auto';
    const manualRequest = 'request-manual-vs-auto-m-01';
    const autoRequest = 'request-manual-vs-auto-a-01';
    fake.seed(manualUid, {}); fake.seed(autoUid, {});
    await db.doc('meta/emp_counter').set({ next: 6450 });
    await Promise.all([
      seedRequest(manualUid, manualRequest), seedRequest(autoUid, autoRequest)
    ]);
    const results = await Promise.allSettled([
      service.acquireAssignment(approvalParams(
        manualUid, manualRequest, 'manual-vs-auto-operation-m', {}, '6450')),
      service.acquireAssignment(approvalParams(
        autoUid, autoRequest, 'manual-vs-auto-operation-a', {}, ''))
    ]);
    const fulfilled = results.filter(x => x.status === 'fulfilled').map(x => x.value);
    const emps = fulfilled.map(x => x.operation.desired_emp);
    assert.equal(new Set(emps).size, emps.length);
    assert.ok(fulfilled.length >= 1);
  });

  await test('an R1 card cannot approve a replacement R2 request', async function () {
    const uid = 'request_replaced';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, 'request-generation-r2-0001');
    await rejectsCode('failed-precondition', service.acquireAssignment(
      approvalParams(uid, 'request-generation-r1-0001', 'stale-card-operation', {}, '6501')));
    const current = (await db.doc('registration_requests/' + uid).get()).data();
    assert.equal(current.request_id, 'request-generation-r2-0001');
    assert.equal(current.status, 'pending');
  });

  await test('reusing a client request id cannot reuse the server generation', async function () {
    const uid = 'request_id_reused';
    const requestId = 'same-client-request-id-0001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const stale = approvalParams(uid, requestId, 'stale-generation-operation', {}, '6505');
    await db.doc('registration_requests/' + uid).delete();
    const replacement = requestData(uid, requestId);
    replacement.full_name = 'בקשה חדשה שלא נצפתה';
    await db.doc('registration_requests/' + uid).set(replacement);
    const outcome = await service.acquireAssignment(stale);
    assert.equal(outcome.type, 'request_stamped');
    const current = (await db.doc('registration_requests/' + uid).get()).data();
    assert.notEqual(current.server_generation, stale.requestGeneration);
    assert.equal(current.full_name, 'בקשה חדשה שלא נצפתה');
    assert.equal((await db.doc('identity_operations/' + uid).get()).exists, false);
  });

  await test('a legacy request is stamped but never approved in the same call', async function () {
    const uid = 'legacy_request';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, '');
    const acquired = await service.acquireAssignment(
      approvalParams(uid, '', 'legacy-stamp-operation', {}, '6502'));
    assert.equal(acquired.type, 'request_stamped');
    const request = (await db.doc('registration_requests/' + uid).get()).data();
    assert.match(request.request_id, /^generated-request-/);
    assert.match(request.server_generation, /^generated-request-/);
    assert.match(request.request_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(request.status, 'pending');
    assert.equal((await db.doc('identity_operations/' + uid).get()).exists, false);
  });

  await test('a stale request with live identity stays pending and can be rejected', async function () {
    const uid = 'live_identity_stale_request';
    const requestId = 'request-live-identity-0001';
    const previous = {
      emp:'6510', role:'firefighter', stationId:'eilat_102',
      districtId:'south', shift:'A'
    };
    const fake = new FakeAuth(); fake.seed(uid, previous);
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const outcome = await service.acquireAssignment(
      approvalParams(uid, requestId, 'live-identity-stale-operation', previous, '6511'));
    assert.equal(outcome.type, 'assigned_request_preserved');
    const request = (await db.doc('registration_requests/' + uid).get()).data();
    assert.equal(request.status, 'pending');
    assert.equal(request.recovery_reason, 'live_identity_already_assigned');
    assert.equal(request.operation_id, undefined);
    assert.equal(request.plan_fingerprint, undefined);
    assert.equal((await db.doc('identity_operations/' + uid).get()).exists, false);
    const rejected = await service.rejectRequest({
      uid:uid, requestId:requestId, requestGeneration:generationFor(requestId),
      actorUid:'u_super', actorEmail:'super@example.com'
    });
    assert.equal(rejected.orphanedReview, false);
    assert.equal((await db.doc('registration_requests/' + uid).get()).exists, false);
  });

  await test('orphan processing and recovery requests can be dismissed only without an active operation', async function () {
    const fake = new FakeAuth(); const service = coordinator(fake);
    for (const status of ['processing', 'needs_recovery']) {
      const uid = 'orphan_request_' + status;
      const requestId = 'request-orphan-' + status + '-0001';
      await seedRequest(uid, requestId);
      await db.doc('registration_requests/' + uid).set({
        status:status, operation_id:'missing-operation-for-review',
        plan_fingerprint:'a'.repeat(64),
        locked_plan:{ kind:'approve', role:'commander', shift:'C',
          stationId:'other_99', districtId:'north', emp:'9999' },
        recovery_reason:'orphan_processing_request'
      }, { merge:true });
      if (status === 'processing') {
        const detected = await service.acquireAssignment(
          roleParams(uid, 'detect-orphan-processing-plan', {}, '6513'));
        assert.equal(detected.type, 'orphan_request');
        const cleaned = (await db.doc('registration_requests/' + uid).get()).data();
        assert.equal(cleaned.status, 'needs_recovery');
        assert.equal(cleaned.resumable, false);
        assert.equal(cleaned.operation_id, undefined);
        assert.equal(cleaned.plan_fingerprint, undefined);
        assert.equal(cleaned.locked_plan, undefined);
      }
      const dismissed = await service.rejectRequest({
        uid:uid, requestId:requestId, requestGeneration:generationFor(requestId),
        actorUid:'u_super', actorEmail:'super@example.com'
      });
      assert.equal(dismissed.orphanedReview, true, status);
      assert.equal((await db.doc('registration_requests/' + uid).get()).exists, false, status);
    }

    const activeUid = 'active_request_not_dismissed';
    const activeRequest = 'request-active-not-dismissed-0001';
    fake.seed(activeUid, {}); await seedRequest(activeUid, activeRequest);
    await service.acquireAssignment(approvalParams(
      activeUid, activeRequest, 'active-operation-not-dismissed', {}, '6512'));
    assert.equal((await db.doc('registration_requests/' + activeUid).get()).data().resumable,
      true);
    await rejectsCode('failed-precondition', service.rejectRequest({
      uid:activeUid, requestId:activeRequest,
      requestGeneration:generationFor(activeRequest),
      actorUid:'u_super', actorEmail:'super@example.com'
    }));
    assert.equal((await db.doc('registration_requests/' + activeUid).get()).exists, true);
  });

  await test('a failure before profile leaves Auth untouched and retry completes', async function () {
    const uid = 'profile_retry'; const requestId = 'request-profile-retry-0001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    let fail = true;
    const service = coordinator(fake, {
      beforeProfile: async function () {
        if (fail) { fail = false; throw new Error('injected profile outage'); }
      }
    });
    await seedRequest(uid, requestId);
    const acquired = await service.acquireAssignment(
      approvalParams(uid, requestId, 'profile-retry-operation', {}, '6601'));
    await assert.rejects(service.runAssignment(uid, acquired.operation.op_id,
      { ok:true, emp:'6601' }, false), /profile outage/);
    assert.deepEqual((await fake.getUser(uid)).customClaims, {});
    assert.equal((await db.doc('registration_requests/' + uid).get()).data().status, 'processing');
    const result = await service.runAssignment(uid, acquired.operation.op_id,
      { ok:true, emp:'6601' }, false);
    assert.equal(result.emp, '6601');
  });

  await test('Auth failure after profile preserves the plan and retries from previous claims', async function () {
    const uid = 'auth_retry'; const requestId = 'request-auth-retry-0000001';
    const fake = new FakeAuth(); fake.seed(uid, {}); fake.failSetBefore = 1;
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const acquired = await service.acquireAssignment(
      approvalParams(uid, requestId, 'auth-retry-operation', {}, '6651'));
    await rejectsCode('unavailable', service.runAssignment(uid,
      acquired.operation.op_id, { ok:true, emp:'6651' }, false));
    assert.deepEqual((await fake.getUser(uid)).customClaims, {});
    assert.equal((await db.doc('identity_operations/' + uid).get()).data().phase,
      'profile_applied');
    assert.equal((await db.doc('registration_requests/' + uid).get()).data().status,
      'processing');
    const result = await service.runAssignment(uid, acquired.operation.op_id,
      { ok:true, emp:'6651' }, false);
    assert.equal(result.emp, '6651');
  });

  await test('lost Auth response is reconciled forward without duplicate identity', async function () {
    const uid = 'lost_auth_response'; const requestId = 'request-lost-auth-000001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    let lose = true;
    const service = coordinator(fake, {
      afterAuthSet: async function () {
        if (lose) { lose = false; throw new Error('injected lost Auth response'); }
      }
    });
    await seedRequest(uid, requestId);
    const acquired = await service.acquireAssignment(
      approvalParams(uid, requestId, 'lost-auth-response-operation', {}, '6701'));
    const result = await service.runAssignment(uid, acquired.operation.op_id,
      { ok:true, emp:'6701' }, false);
    assert.equal(result.emp, '6701');
    assert.equal((await fake.getUser(uid)).customClaims.emp, '6701');
    assert.equal((await db.doc('registration_requests/' + uid).get()).exists, false);
    assert.equal((await db.doc('emp_reservations/6701').get()).exists, false);
    assert.equal((await db.doc('identity_operations/' + uid).get()).data().status, 'completed');
  });

  await test('two retries of the same operation converge on one completed result', async function () {
    const uid = 'same_operation_retry'; const requestId = 'request-same-operation-001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const acquired = await service.acquireAssignment(
      approvalParams(uid, requestId, 'same-operation-retry-id', {}, '6751'));
    const results = await Promise.all([
      service.runAssignment(uid, acquired.operation.op_id, { ok:true, emp:'6751' }, false),
      service.runAssignment(uid, acquired.operation.op_id, { ok:true, emp:'6751' }, false)
    ]);
    assert.deepEqual(results.map(x => x.emp), ['6751', '6751']);
    assert.equal((await db.doc('registration_requests/' + uid).get()).exists, false);
    assert.equal((await db.doc('emp_index/6751').get()).data().uid, uid);
    const completed = (await db.doc('identity_operations/' + uid).get()).data();
    assert.equal(completed.status, 'completed');
    for (const piiField of ['desired_profile','previous_claims','desired_claims',
                            'request_fingerprint','actor_uid']) {
      assert.equal(Object.prototype.hasOwnProperty.call(completed, piiField), false, piiField);
    }
  });

  await test('finalize failure preserves processing state and retry returns one result', async function () {
    const uid = 'finalize_retry'; const requestId = 'request-finalize-retry-001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    let fail = true;
    const service = coordinator(fake, {
      beforeFinalize: async function () {
        if (fail) { fail = false; throw new Error('injected finalize outage'); }
      }
    });
    await seedRequest(uid, requestId);
    const acquired = await service.acquireAssignment(
      approvalParams(uid, requestId, 'finalize-retry-operation', {}, '6801'));
    await assert.rejects(service.runAssignment(uid, acquired.operation.op_id,
      { ok:true, emp:'6801' }, false), /finalize outage/);
    assert.equal((await db.doc('registration_requests/' + uid).get()).data().status, 'processing');
    assert.equal((await fake.getUser(uid)).customClaims.emp, '6801');
    const result = await service.runAssignment(uid, acquired.operation.op_id,
      { ok:true, emp:'6801' }, false);
    assert.equal(result.emp, '6801');
    const setCalls = fake.setCalls;
    const replay = await service.runAssignment(uid, acquired.operation.op_id,
      { ok:true, emp:'wrong' }, false);
    assert.equal(replay.emp, '6801');
    assert.equal(fake.setCalls, setCalls);
  });

  await test('unexpected third-party claims stop in recovery without deleting request', async function () {
    const uid = 'third_claims'; const requestId = 'request-third-claims-00001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const acquired = await service.acquireAssignment(
      approvalParams(uid, requestId, 'third-claims-operation', {}, '6901'));
    fake.seed(uid, { role:'district_commander', stationId:'other' });
    await rejectsCode('failed-precondition', service.runAssignment(uid,
      acquired.operation.op_id, { ok:true, emp:'6901' }, false));
    assert.equal((await db.doc('registration_requests/' + uid).get()).data().status,
      'needs_recovery');
    assert.equal((await db.doc('identity_operations/' + uid).get()).data().status,
      'needs_recovery');
    assert.equal((await db.doc('emp_reservations/6901').get()).exists, true);
    const stuck = (await db.doc('identity_operations/' + uid).get()).data();
    await rejectsCode('failed-precondition', service.resumeOperation({
      uid:uid, opId:stuck.op_id, planFingerprint:stuck.plan_fingerprint,
      actorUid:'u_super', actorEmail:'super@example.com'
    }));
    assert.deepEqual((await fake.getUser(uid)).customClaims,
      { role:'district_commander', stationId:'other' });
  });

  await test('needs-recovery keeps its phase and resumes only the stored plan', async function () {
    const uid = 'safe_recovery_resume'; const requestId = 'request-safe-recovery-001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake);
    await seedRequest(uid, requestId);
    const acquired = await service.acquireAssignment(
      approvalParams(uid, requestId, 'safe-recovery-operation', {}, '6951'));
    await service.markNeedsRecovery(uid, acquired.operation.op_id,
      new Error('injected operator review'));
    const waiting = (await db.doc('identity_operations/' + uid).get()).data();
    assert.equal(waiting.status, 'needs_recovery');
    assert.equal(waiting.phase, 'prepared');
    const resumed = await service.resumeOperation({
      uid:uid, opId:waiting.op_id, planFingerprint:waiting.plan_fingerprint,
      actorUid:'u_super', actorEmail:'super@example.com'
    });
    assert.equal(resumed.operation.status, 'processing');
    assert.equal(resumed.operation.phase, 'prepared');
    const result = await service.runAssignment(uid, waiting.op_id,
      { ok:true, emp:'6951' }, false);
    assert.equal(result.emp, '6951');
  });

  await test('clear-role revokes first, preserves request on failure, then resumes', async function () {
    const uid = 'clear_retry'; const requestId = 'request-clear-retry-00001';
    const before = {
      role:'firefighter', stationId:'eilat_102', districtId:'south', shift:'A', emp:'7001'
    };
    const fake = new FakeAuth(); fake.seed(uid, before); fake.failRevoke = 1;
    let failDeactivation = true;
    const service = coordinator(fake, {
      beforeDeactivation: async function () {
        if (failDeactivation) {
          failDeactivation = false;
          throw new Error('injected deactivation outage');
        }
      }
    });
    await seedRequest(uid, requestId);
    await db.doc('directory/' + uid).set({ is_active:true });
    await db.doc('stations/eilat_102/users/' + uid).set({ is_active:true });
    await db.doc('stations/eilat_102/roster/' + uid).set({ is_active:true });
    await db.doc('emp_index/7001').set({ uid:uid, email:uid + '@example.com' });
    const acquired = await service.acquireAssignment({
      uid:uid, opId:'clear-retry-operation', kind:'clear_role',
      actorUid:'u_super', actorEmail:'super@example.com',
      previousClaims:before, previousEmp:'7001', previousStation:'eilat_102',
      requireRequest:false, attachPendingRequest:true, requestId:'', requestGeneration:'',
      blockIfAssigned:false,
      intentFingerprint:stableHash({ kind:'clear_role', uid:uid, desired_claims:null }),
      employeeMode:'none', wantedEmp:'',
      auditAction:'clear_role', auditDetails:{ test:true },
      makePlan:function () { return { desiredClaims:null, desiredProfile:null }; }
    });
    await rejectsCode('unavailable', service.runClear(uid, acquired.operation.op_id,
      { ok:true }));
    assert.deepEqual((await fake.getUser(uid)).customClaims, {});
    assert.equal((await db.doc('directory/' + uid).get()).data().is_active, true);
    assert.equal((await db.doc('registration_requests/' + uid).get()).data().status, 'processing');
    await assert.rejects(service.runClear(uid, acquired.operation.op_id, { ok:true }),
      /deactivation outage/);
    assert.equal((await db.doc('directory/' + uid).get()).data().is_active, true);
    assert.equal((await db.doc('registration_requests/' + uid).get()).data().status, 'processing');
    await service.runClear(uid, acquired.operation.op_id, { ok:true });
    assert.equal((await db.doc('directory/' + uid).get()).data().is_active, false);
    const retired = (await db.doc('emp_index/7001').get()).data();
    assert.equal(retired.uid, uid);
    assert.equal(retired.retired, true);
    assert.equal(retired.active, false);
    assert.equal((await db.doc('registration_requests/' + uid).get()).exists, false);

    await db.doc('identity_operations/' + uid).set({
      fence_until: Timestamp.fromMillis(Date.now() - 1000)
    }, { merge:true });
    await rejectsCode('already-exists', service.acquireAssignment(
      roleParams(uid, 'same-uid-retired-reuse', {}, '7001')));

    const other = 'retired_emp_other_uid';
    const otherRequest = 'request-retired-other-001';
    fake.seed(other, {}); await seedRequest(other, otherRequest);
    await rejectsCode('already-exists', service.acquireAssignment(
      approvalParams(other, otherRequest, 'other-uid-retired-reuse', {}, '7001')));

    const automatic = 'retired_emp_auto_uid';
    const autoRequest = 'request-retired-auto-0001';
    fake.seed(automatic, {}); await seedRequest(automatic, autoRequest);
    await db.doc('meta/emp_counter').set({ next:7001 });
    const auto = await service.acquireAssignment(
      approvalParams(automatic, autoRequest, 'auto-skips-retired-operation', {}, ''));
    assert.notEqual(auto.operation.desired_emp, '7001');
  });

  await test('a stale worker cannot continue after a fenced successor starts', async function () {
    const uid = 'stale_worker'; const requestId = 'request-stale-worker-0001';
    const fake = new FakeAuth(); fake.seed(uid, {});
    const service = coordinator(fake, {}, { fenceMs:180000 });
    await seedRequest(uid, requestId);
    const first = await service.acquireAssignment(
      approvalParams(uid, requestId, 'stale-worker-operation-one', {}, '7101'));
    await service.runAssignment(uid, first.operation.op_id, { ok:true, emp:'7101' }, false);
    const firstClaims = (await fake.getUser(uid)).customClaims;
    await db.doc('identity_operations/' + uid).set({
      fence_until: Timestamp.fromMillis(Date.now() - 1000)
    }, { merge:true });
    const second = await service.acquireAssignment(
      roleParams(uid, 'stale-worker-operation-two', firstClaims, '7102'));
    await rejectsCode('failed-precondition', service.runAssignment(uid,
      first.operation.op_id, { ok:true, emp:'7101' }, false));
    assert.equal((await fake.getUser(uid)).customClaims.emp, '7101');
    assert.equal((await db.doc('identity_operations/' + uid).get()).data().op_id,
      second.operation.op_id);
    await service.runAssignment(uid, second.operation.op_id, { ok:true, emp:'7102' }, false);
    assert.equal((await fake.getUser(uid)).customClaims.emp, '7102');
  });

  await test('reject uses exact request generation and never deletes R2 from an R1 card', async function () {
    const uid = 'reject_replaced';
    const fake = new FakeAuth(); const service = coordinator(fake);
    await seedRequest(uid, 'request-reject-r2-0000001');
    await rejectsCode('failed-precondition', service.rejectRequest({
      uid:uid, requestId:'request-reject-r1-0000001',
      requestGeneration:generationFor('request-reject-r1-0000001'),
      actorUid:'u_super', actorEmail:'super@example.com'
    }));
    assert.equal((await db.doc('registration_requests/' + uid).get()).data().request_id,
      'request-reject-r2-0000001');
  });

  console.log('\n' + passed + ' identity coordinator integration checks passed.');
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
