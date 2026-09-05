'use strict';

/*
 * Contract tests for the station-transfer service.
 *
 * Public API:
 *   createStationTransferService(deps) -> {
 *     search(callableRequest),
 *     create(callableRequest),
 *     list(callableRequest),
 *     decide(callableRequest),
 *     cancel(callableRequest)
 *   }
 *
 * A callableRequest has the Firebase shape { auth, data }.  The service must
 * derive authority from the live identity returned by deps.getUser(uid), not
 * from data supplied by the browser and not solely from stale token claims.
 * Names are a search aid only; every mutation is locked to an immutable uid
 * and an expected subject snapshot/version.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

let createStationTransferService;
try {
  ({ createStationTransferService } = require('./station-transfer'));
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND' &&
      String(error.message || '').includes('station-transfer')) {
    console.error('NOT IMPLEMENTED: functions/station-transfer.js must export ' +
      'createStationTransferService(deps).');
    process.exit(2);
  }
  throw error;
}

assert.equal(typeof createStationTransferService, 'function',
  'station-transfer.js must export createStationTransferService');

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class TestHttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const DELETE = Object.freeze({ __delete: true });
const FieldValue = {
  serverTimestamp: function () { return { __server_timestamp: true }; },
  delete: function () { return DELETE; }
};

function mergeObject(before, patch) {
  const out = Object.assign({}, copy(before || {}));
  Object.keys(patch || {}).forEach(function (key) {
    if (patch[key] === DELETE || (patch[key] && patch[key].__delete === true)) {
      delete out[key];
    } else {
      out[key] = copy(patch[key]);
    }
  });
  return out;
}

class FakeSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== undefined;
    this._value = copy(value);
  }
  data() { return copy(this._value); }
}

class FakeDocRef {
  constructor(db, path) {
    this.db = db;
    this.path = String(path).replace(/^\/+|\/+$/g, '');
    this.id = this.path.split('/').pop();
  }
  async get() { return new FakeSnapshot(this, this.db._docs.get(this.path)); }
  async set(value, options) {
    const before = this.db._docs.get(this.path);
    this.db._docs.set(this.path, options && options.merge ?
      mergeObject(before, value) : copy(value));
  }
  async update(value) {
    if (!this.db._docs.has(this.path)) throw new Error('not-found: ' + this.path);
    this.db._docs.set(this.path, mergeObject(this.db._docs.get(this.path), value));
  }
  async delete() { this.db._docs.delete(this.path); }
  collection(name) { return new FakeCollection(this.db, this.path + '/' + name, []); }
}

class FakeQuery {
  constructor(db, path, filters, limitCount) {
    this.db = db;
    this.path = path;
    this.filters = filters || [];
    this.limitCount = Number.isInteger(limitCount) && limitCount >= 0 ? limitCount : null;
  }
  where(field, op, value) {
    return new FakeQuery(this.db, this.path,
      this.filters.concat([{ field:field, op:op, value:copy(value) }]), this.limitCount);
  }
  orderBy() { return this; }
  limit(count) { return new FakeQuery(this.db, this.path, this.filters, Number(count)); }
  async get() {
    const prefix = this.path.replace(/^\/+|\/+$/g, '') + '/';
    const docs = [];
    for (const [path, value] of this.db._docs.entries()) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      const matches = this.filters.every(function (f) {
        const actual = value && value[f.field];
        if (f.op === '==') return actual === f.value;
        if (f.op === 'in') return Array.isArray(f.value) && f.value.includes(actual);
        if (f.op === 'array-contains') return Array.isArray(actual) && actual.includes(f.value);
        throw new Error('unsupported fake query operator ' + f.op);
      });
      if (matches) docs.push(new FakeSnapshot(new FakeDocRef(this.db, path), value));
    }
    const limited = this.limitCount === null ? docs : docs.slice(0, this.limitCount);
    return { empty: limited.length === 0, size: limited.length, docs: limited };
  }
}

class FakeCollection extends FakeQuery {
  doc(id) {
    if (id === undefined) {
      this.db._ids = (this.db._ids || 0) + 1;
      id = 'auto-' + String(this.db._ids).padStart(8, '0');
    }
    return new FakeDocRef(this.db, this.path + '/' + id);
  }
}

class FakeTransaction {
  constructor(db) { this.db = db; }
  async get(refOrQuery) { return refOrQuery.get(); }
  set(ref, value, options) {
    const before = this.db._docs.get(ref.path);
    this.db._docs.set(ref.path, options && options.merge ?
      mergeObject(before, value) : copy(value));
    return this;
  }
  create(ref, value) {
    if (this.db._docs.has(ref.path)) throw new TestHttpsError('already-exists', 'document exists');
    this.db._docs.set(ref.path, copy(value));
    return this;
  }
  update(ref, value) {
    if (!this.db._docs.has(ref.path)) throw new TestHttpsError('not-found', 'document missing');
    this.db._docs.set(ref.path, mergeObject(this.db._docs.get(ref.path), value));
    return this;
  }
  delete(ref) { this.db._docs.delete(ref.path); return this; }
}

class FakeFirestore {
  constructor() {
    this._docs = new Map();
    this._tail = Promise.resolve();
  }
  doc(path) { return new FakeDocRef(this, path); }
  collection(path) { return new FakeCollection(this, path, []); }
  seed(path, value) { this._docs.set(path, copy(value)); }
  read(path) { return copy(this._docs.get(path)); }
  runTransaction(fn) {
    const run = this._tail.then(() => fn(new FakeTransaction(this)));
    this._tail = run.catch(function () {});
    return run;
  }
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function namePrefixes(value) {
  const normalized = normalizedName(value);
  return normalized ? [normalized] : [];
}

const ROLE_RANK = {
  firefighter: 1,
  commander: 4,
  station_commander: 5,
  hr_coordinator: 5
};

function rankOf(role) { return ROLE_RANK[String(role || '')] || -1; }

function callable(uid, data, tokenPatch) {
  const tokens = {
    source_hr:{ emp:'9001', role:'hr_coordinator', stationId:'source_102', districtId:'south' },
    target_hr:{ emp:'9002', role:'hr_coordinator', stationId:'target_202', districtId:'south' },
    target_commander:{ emp:'9003', role:'station_commander', stationId:'target_202', districtId:'south' },
    target_firefighter:{ emp:'9004', role:'firefighter', stationId:'target_202', districtId:'south' },
    foreign_hr:{ emp:'9005', role:'hr_coordinator', stationId:'foreign_303', districtId:'north' },
    inactive_target_hr:{ emp:'9006', role:'hr_coordinator', stationId:'target_202', districtId:'south' },
    source_firefighter:{ emp:'9007', role:'firefighter', stationId:'source_102', districtId:'south' },
    super_user:{ super:true, role:'super_admin' },
    unique_subject:{ emp:'1003', role:'firefighter', stationId:'source_102', districtId:'south', shift:'C' }
  };
  return {
    auth: {
      uid: uid,
      token: Object.assign({ email: uid + '@example.com' }, tokens[uid] || {}, tokenPatch || {})
    },
    data: copy(data || {})
  };
}

function subjectVersion(person) {
  return stableHash({
    uid: person.uid,
    full_name: person.full_name,
    station: person.station,
    role: person.role,
    is_active: person.is_active
  });
}

function makeEnvironment() {
  const db = new FakeFirestore();
  const stations = new Map([
    ['source_102', { id:'source_102', name:'תחנת מקור', districtId:'south', active:true }],
    ['target_202', { id:'target_202', name:'תחנת יעד', districtId:'south', active:true }],
    ['foreign_303', { id:'foreign_303', name:'תחנה זרה', districtId:'north', active:true }],
    ['archived_404', { id:'archived_404', name:'תחנה סגורה', districtId:'south', active:false }]
  ]);
  const authUsers = new Map();
  function seedAuth(uid, claims, email) {
    authUsers.set(uid, {
      uid:uid, email:email || uid + '@example.com',
      customClaims:copy(claims || {})
    });
  }

  seedAuth('source_hr', { emp:'9001', role:'hr_coordinator', stationId:'source_102', districtId:'south' });
  seedAuth('target_hr', { emp:'9002', role:'hr_coordinator', stationId:'target_202', districtId:'south' });
  seedAuth('target_commander', { emp:'9003', role:'station_commander', stationId:'target_202', districtId:'south' });
  seedAuth('target_firefighter', { emp:'9004', role:'firefighter', stationId:'target_202', districtId:'south' });
  seedAuth('foreign_hr', { emp:'9005', role:'hr_coordinator', stationId:'foreign_303', districtId:'north' });
  seedAuth('inactive_target_hr', { emp:'9006', role:'hr_coordinator', stationId:'target_202', districtId:'south' });
  seedAuth('source_firefighter', { emp:'9007', role:'firefighter', stationId:'source_102', districtId:'south' });
  seedAuth('super_user', { super:true, role:'super_admin' });

  const people = [
    {
      uid:'subject_one', full_name:'נועם כהן', normalized_name:'נועם כהן',
      name_prefixes:['נועם כהן'], role:'firefighter', station:'source_102',
      district:'south', crew:'A', employee_number:'1001', email:'private-one@example.com',
      phone:'0500000001', is_active:true
    },
    {
      uid:'subject_two', full_name:'נועם כהן', normalized_name:'נועם כהן',
      name_prefixes:['נועם כהן'], role:'firefighter', station:'source_102',
      district:'south', crew:'B', employee_number:'1002', email:'private-two@example.com',
      phone:'0500000002', is_active:true
    },
    {
      uid:'unique_subject', full_name:'יעל לוי', normalized_name:'יעל לוי',
      name_prefixes:['יעל לוי'], role:'firefighter', station:'source_102',
      district:'south', crew:'C', employee_number:'1003', email:'private-three@example.com',
      phone:'0500000003', is_active:true
    }
  ];
  people.forEach(function (person) {
    const value = Object.assign({}, person, { subject_version:subjectVersion(person) });
    db.seed('directory/' + person.uid, value);
    db.seed('stations/source_102/users/' + person.uid, {
      full_name:person.full_name, role:person.role, station:'source_102', district:'south',
      crew:person.crew, employee_number:person.employee_number, is_active:true
    });
    db.seed('stations/source_102/roster/' + person.uid, {
      full_name:person.full_name, role:person.role, crew:person.crew, is_active:true
    });
    seedAuth(person.uid, {
      emp:person.employee_number, role:person.role, stationId:'source_102',
      districtId:'south', shift:person.crew
    }, person.email);
  });

  const liveProfiles = [
    ['source_hr', 'source_102', 'hr_coordinator', true],
    ['target_hr', 'target_202', 'hr_coordinator', true],
    ['target_commander', 'target_202', 'station_commander', true],
    ['target_firefighter', 'target_202', 'firefighter', true],
    ['foreign_hr', 'foreign_303', 'hr_coordinator', true],
    ['inactive_target_hr', 'target_202', 'hr_coordinator', false],
    ['source_firefighter', 'source_102', 'firefighter', true]
  ];
  liveProfiles.forEach(function (row) {
    db.seed('stations/' + row[1] + '/users/' + row[0], {
      station:row[1], role:row[2], is_active:row[3], employee_number:'9'
    });
  });

  let randomCounter = 0;
  const identityCalls = { acquire:[], run:[], resume:[], get:[], effects:0 };
  const identityOps = new Map();
  let identityGetHook = null;
  let identityRunHook = null;
  let resolveStationHook = null;
  const identityCoordinator = {
    async acquireAssignment(params) {
      identityCalls.acquire.push(copy({
        uid:params.uid, kind:params.kind, actorUid:params.actorUid,
        previousClaims:params.previousClaims, previousEmp:params.previousEmp,
        previousStation:params.previousStation, intentFingerprint:params.intentFingerprint,
        employeeMode:params.employeeMode, wantedEmp:params.wantedEmp,
        auditAction:params.auditAction, auditDetails:params.auditDetails
      }));
      if (identityOps.has(params.uid)) {
        const existing = identityOps.get(params.uid);
        if (existing.op_id !== params.opId || existing.kind !== params.kind ||
            existing.intent_fingerprint !== params.intentFingerprint) {
          throw new TestHttpsError('aborted',
            'another identity operation is active for this user');
        }
        return existing.status === 'completed' ?
          { type:'completed', operation:copy(existing) } :
          { type:'resumed', operation:copy(existing) };
      }
      const plan = params.makePlan(String(params.wantedEmp || params.previousEmp || ''), {});
      const operation = {
        op_id:params.opId,
        target_uid:params.uid,
        kind:params.kind,
        status:'processing',
        intent_fingerprint:params.intentFingerprint,
        plan_fingerprint:stableHash({ uid:params.uid, op_id:params.opId }),
        plan_summary:{
          kind:params.kind,
          emp:String(params.wantedEmp || params.previousEmp || ''),
          role:String(plan.desiredProfile.role || ''),
          shift:String(plan.desiredProfile.shift || ''),
          stationId:String(plan.desiredProfile.stationId || ''),
          districtId:String(plan.desiredProfile.districtId || '')
        },
        desired_emp:String(params.wantedEmp || params.previousEmp || ''),
        desired_claims:copy(plan.desiredClaims),
        desired_profile:copy(plan.desiredProfile),
        previous_claims:copy(params.previousClaims || {}),
        previous_station:String(params.previousStation || '')
      };
      identityOps.set(params.uid, operation);
      db.seed('identity_operations/' + params.uid, operation);
      return { type:'acquired', operation:copy(operation) };
    },
    async getOperation(uid) {
      identityCalls.get.push(uid);
      if (identityGetHook) {
        const hook = identityGetHook;
        identityGetHook = null;
        await hook(uid);
      }
      return copy(identityOps.get(uid));
    },
    async resumeOperation(params) {
      identityCalls.resume.push(copy(params));
      const operation = identityOps.get(params.uid);
      if (!operation || operation.op_id !== params.opId ||
          operation.plan_fingerprint !== params.planFingerprint) {
        throw new Error('identity recovery mismatch');
      }
      if (operation.status !== 'completed') operation.status = 'processing';
      identityOps.set(params.uid, operation);
      db.seed('identity_operations/' + params.uid, operation);
      return { type:operation.status === 'completed' ? 'completed' : 'resumed',
        operation:copy(operation) };
    },
    async runAssignment(uid, opId, result) {
      identityCalls.run.push({ uid:uid, opId:opId, result:copy(result) });
      await new Promise(function (resolve) { setImmediate(resolve); });
      if (identityRunHook) {
        const hook = identityRunHook;
        identityRunHook = null;
        await hook(uid, opId, copy(result));
      }
      const operation = identityOps.get(uid);
      if (!operation || operation.op_id !== opId) throw new Error('identity operation mismatch');
      if (operation.status === 'completed') return copy(operation.result);
      identityCalls.effects++;
      operation.status = 'completed';
      operation.result = copy(result);
      identityOps.set(uid, operation);
      db.seed('identity_operations/' + uid, operation);
      return copy(result);
    }
  };

  const service = createStationTransferService({
    db:db,
    getUser:async function (uid) {
      if (!authUsers.has(uid)) throw new TestHttpsError('not-found', 'user missing');
      return copy(authUsers.get(uid));
    },
    isSuper:function (auth) { return !!(auth && auth.token && auth.token.super === true); },
    HttpsError:TestHttpsError,
    FieldValue:FieldValue,
    identityCoordinator:identityCoordinator,
    stableHash:stableHash,
    namePrefixes:namePrefixes,
    rankOf:rankOf,
    resolveStation:async function (stationId, tx) {
      const current = copy(stations.get(stationId));
      if (resolveStationHook) {
        const override = await resolveStationHook({
          stationId:stationId, transaction:tx, current:copy(current)
        });
        if (override !== undefined) return copy(override);
      }
      return current;
    },
    listStations:async function () { return Array.from(stations.values()).map(copy); },
    randomId:function () {
      randomCounter++;
      return 'transfer-request-' + String(randomCounter).padStart(8, '0');
    },
    now:function () { return 1788230400000; }
  });

  return {
    service:service, db:db, authUsers:authUsers, stations:stations,
    identityCalls:identityCalls, identityOps:identityOps,
    setIdentityGetHook:function (hook) { identityGetHook = hook; },
    setIdentityRunHook:function (hook) { identityRunHook = hook; },
    setResolveStationHook:function (hook) { resolveStationHook = hook; }
  };
}

function createData(env, overrides) {
  return Object.assign({
    target_uid:'unique_subject',
    target_station_id:'target_202',
    request_id:'create-transfer-operation-0001'
  }, overrides || {});
}

async function openPending(env, overrides) {
  return env.service.create(callable('source_hr', createData(env, overrides)));
}

function transferOperationFor(request, status) {
  const desiredClaims = {
    role:request.role,
    stationId:request.target_station_id,
    districtId:request.target_district_id,
    shift:request.shift,
    emp:request.employee_number
  };
  const opId = 'transfer-' + stableHash({
    request_id:request.request_id,
    target_uid:request.target_uid,
    fingerprint:request.fingerprint
  }).slice(0, 40);
  return {
    op_id:opId,
    target_uid:request.target_uid,
    kind:'transfer_station',
    status:status,
    intent_fingerprint:stableHash({
      kind:'transfer_station',
      request_id:request.request_id,
      fingerprint:request.fingerprint,
      desired_claims:desiredClaims
    }),
    plan_fingerprint:stableHash({ uid:request.target_uid, op_id:opId }),
    plan_summary:{
      kind:'transfer_station', emp:request.employee_number, role:request.role,
      shift:request.shift, stationId:request.target_station_id,
      districtId:request.target_district_id
    },
    desired_claims:desiredClaims
  };
}

function requestFrom(result) {
  return result && result.request ? result.request : result;
}

function assertPublicCandidate(candidate) {
  assert.deepEqual(Object.keys(candidate).sort(),
    ['employee_number','full_name','role','shift','station_id','uid'].sort());
  for (const forbidden of ['email','phone','district']) {
    assert.equal(Object.prototype.hasOwnProperty.call(candidate, forbidden), false, forbidden);
  }
}

async function rejectsCode(code, work) {
  try {
    await work;
    assert.fail('expected error ' + code);
  } catch (error) {
    if (error && error.code === 'ERR_ASSERTION') throw error;
    assert.equal(error && error.code, code,
      'expected ' + code + ', got ' + String(error && error.code) + ': ' +
      String(error && error.message));
    return error;
  }
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('✓ ' + name);
}

(async function () {
  await test('firefighter cannot search or create transfer requests', async function () {
    const env = makeEnvironment();
    await rejectsCode('permission-denied', env.service.search(callable('source_firefighter', {
      query:'יעל לוי'
    })));
    await rejectsCode('permission-denied', env.service.create(callable('source_firefighter',
      createData(env))));
  });

  await test('source HR search returns only a privacy-safe candidate shape', async function () {
    const env = makeEnvironment();
    const result = await env.service.search(callable('source_hr', { query:'  יעל   לוי  ' }));
    assert.equal(Array.isArray(result.people), true);
    assert.equal(result.people.length, 1);
    assert.equal(result.people[0].uid, 'unique_subject');
    assertPublicCandidate(result.people[0]);
    assert.deepEqual(result.targets.map(function (row) { return row.station_id; }).sort(),
      ['foreign_303', 'target_202']);
    assert.equal(result.targets.some(function (row) {
      return Object.keys(row).some(function (key) {
        return ['email','phone','employee_number'].indexOf(key) !== -1;
      });
    }), false);
  });

  await test('verified super alone gets a canonical explicit station scope', async function () {
    const env = makeEnvironment();
    await rejectsCode('invalid-argument', env.service.search(callable('super_user', {
      query:'יעל לוי'
    })));
    await rejectsCode('failed-precondition', env.service.search(callable('super_user', {
      query:'יעל לוי', station_id:'archived_404'
    })));
    await rejectsCode('permission-denied', env.service.search(callable('source_firefighter', {
      query:'יעל לוי', station_id:'source_102'
    }, { role:'super_admin', super:false, email:'fire102.shits@gmail.com' })));

    const source = await env.service.search(callable('super_user', {
      query:'יעל לוי', station_id:'source_102'
    }));
    const foreign = await env.service.search(callable('super_user', {
      query:'יעל לוי', station_id:'foreign_303'
    }));
    assert.deepEqual(source.people.map(function (person) { return person.uid; }),
      ['unique_subject']);
    assert.equal(foreign.people.length, 0, 'super station scope leaked a source employee');
  });

  await test('verified super can create list and cancel only in the selected source scope',
    async function () {
      const env = makeEnvironment();
      const pending = await env.service.create(callable('super_user', createData(env, {
        request_id:'super-create-cancel-operation-0001', station_id:'source_102'
      }), { runtime_mode:'off' }));
      assert.equal(pending.status, 'pending_target');

      const outgoing = await env.service.list(callable('super_user', {
        direction:'outgoing', station_id:'source_102'
      }, { runtime_mode:'shadow' }));
      const incoming = await env.service.list(callable('super_user', {
        direction:'incoming', station_id:'target_202'
      }, { runtime_mode:'new' }));
      assert.deepEqual(outgoing.transfers.map(function (row) { return row.request_id; }),
        [pending.request_id]);
      assert.deepEqual(incoming.transfers.map(function (row) { return row.request_id; }),
        [pending.request_id]);
      await rejectsCode('permission-denied', env.service.cancel(callable('super_user', {
        request_id:pending.request_id, station_id:'foreign_303'
      })));
      const cancelled = await env.service.cancel(callable('super_user', {
        request_id:pending.request_id, station_id:'source_102'
      }));
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(env.identityCalls.effects, 0);
    });

  await test('verified super can approve reject and recover in every runtime mode',
    async function () {
      for (const mode of ['off', 'shadow', 'new']) {
        const approveEnv = makeEnvironment();
        const approvePending = await openPending(approveEnv, {
          request_id:'super-approve-' + mode + '-operation-0001'
        });
        const approved = await approveEnv.service.decide(callable('super_user', {
          request_id:approvePending.request_id, decision:'approve', station_id:'target_202'
        }, { runtime_mode:mode }));
        assert.equal(approved.status, 'completed', mode);

        const rejectEnv = makeEnvironment();
        const rejectPending = await openPending(rejectEnv, {
          request_id:'super-reject-' + mode + '-operation-0001'
        });
        const rejected = await rejectEnv.service.decide(callable('super_user', {
          request_id:rejectPending.request_id, decision:'reject', reason_code:'not_accepted',
          station_id:'target_202'
        }, { runtime_mode:mode }));
        assert.equal(rejected.status, 'rejected', mode);
      }

      const recoveryEnv = makeEnvironment();
      const pending = await openPending(recoveryEnv, {
        request_id:'super-recovery-operation-0001'
      });
      const path = 'station_transfer_requests/' + pending.request_id;
      const request = recoveryEnv.db.read(path);
      const operation = transferOperationFor(request, 'needs_recovery');
      recoveryEnv.identityOps.set(request.target_uid, copy(operation));
      recoveryEnv.db.seed('identity_operations/' + request.target_uid, operation);
      recoveryEnv.db.seed(path, Object.assign({}, request, {
        status:'needs_recovery', operation_id:operation.op_id
      }));
      recoveryEnv.db.seed('station_transfer_locks/' + request.target_uid, {
        request_id:request.request_id, target_uid:request.target_uid,
        status:'needs_recovery', operation_id:operation.op_id
      });
      const source = recoveryEnv.db.read('stations/source_102/users/' + request.target_uid);
      source.is_active = false;
      recoveryEnv.db.seed('stations/source_102/users/' + request.target_uid, source);
      await rejectsCode('permission-denied', recoveryEnv.service.decide(callable('super_user', {
        request_id:request.request_id, decision:'approve', station_id:'foreign_303'
      })));
      const recovered = await recoveryEnv.service.decide(callable('super_user', {
        request_id:request.request_id, decision:'approve', station_id:'target_202'
      }));
      assert.equal(recovered.status, 'completed');
      assert.equal(recoveryEnv.identityCalls.resume.length, 1);
      assert.equal(recoveryEnv.identityCalls.effects, 1);
    });

  await test('a duplicate full name is ambiguous until an immutable uid is selected', async function () {
    const env = makeEnvironment();
    const search = await env.service.search(callable('source_hr', { query:'נועם כהן' }));
    assert.equal(search.people.length, 2);
    search.people.forEach(assertPublicCandidate);
    await rejectsCode('invalid-argument', env.service.create(callable('source_hr', {
      name:'נועם כהן', target_station_id:'target_202',
      request_id:'ambiguous-name-operation-0001'
    })));
    const created = await env.service.create(callable('source_hr', {
      target_uid:'subject_one', target_station_id:'target_202',
      request_id:'selected-uid-operation-0001'
    }));
    assert.equal(created.target_uid, 'subject_one');
    assert.equal(created.status, 'pending_target');
  });

  await test('create revalidates the selected uid against the live source profile', async function () {
    const env = makeEnvironment();
    const profile = env.db.read('stations/source_102/users/unique_subject');
    profile.role = 'commander';
    env.db.seed('stations/source_102/users/unique_subject', profile);
    await rejectsCode('failed-precondition', openPending(env));
    assert.equal((await env.db.collection('station_transfer_requests').get()).size, 0);
  });

  await test('same-station, missing, archived and inactive subjects are rejected', async function () {
    const env = makeEnvironment();
    await rejectsCode('failed-precondition', env.service.create(callable('source_hr',
      createData(env, { target_station_id:'source_102' }))));
    await rejectsCode('failed-precondition', env.service.create(callable('source_hr',
      createData(env, { target_station_id:'archived_404' }))));
    await rejectsCode('failed-precondition', env.service.create(callable('source_hr',
      createData(env, { target_station_id:'missing_999' }))));
    const profile = env.db.read('stations/source_102/users/unique_subject');
    profile.is_active = false;
    env.db.seed('stations/source_102/users/unique_subject', profile);
    await rejectsCode('failed-precondition', openPending(env));
  });

  await test('a disabled Auth account cannot be used to create a transfer request', async function () {
    const env = makeEnvironment();
    env.authUsers.get('unique_subject').disabled = true;
    await rejectsCode('failed-precondition', openPending(env, {
      request_id:'disabled-create-operation-0001'
    }));
    assert.equal((await env.db.collection('station_transfer_requests').get()).size, 0);
    assert.equal(env.identityCalls.acquire.length, 0);
  });

  await test('pending request makes no identity or membership change', async function () {
    const env = makeEnvironment();
    const beforeAuth = copy(env.authUsers.get('unique_subject'));
    const beforeDirectory = env.db.read('directory/unique_subject');
    const beforeSource = env.db.read('stations/source_102/users/unique_subject');
    const beforeTarget = env.db.read('stations/target_202/users/unique_subject');
    const opened = await openPending(env);
    assert.equal(opened.status, 'pending_target');
    assert.deepEqual(env.authUsers.get('unique_subject'), beforeAuth);
    assert.deepEqual(env.db.read('directory/unique_subject'), beforeDirectory);
    assert.deepEqual(env.db.read('stations/source_102/users/unique_subject'), beforeSource);
    assert.deepEqual(env.db.read('stations/target_202/users/unique_subject'), beforeTarget);
    assert.equal(env.identityCalls.acquire.length, 0);
    assert.equal(env.identityCalls.run.length, 0);
  });

  await test('same create idempotency key returns the same request and one active lock', async function () {
    const env = makeEnvironment();
    const results = await Promise.all([
      openPending(env),
      openPending(env)
    ]);
    const requests = results.map(requestFrom);
    assert.equal(requests[0].request_id, requests[1].request_id);
    assert.equal(requests[0].changed, true);
    assert.equal(requests[1].changed, false);
    const all = await env.db.collection('station_transfer_requests').get();
    assert.equal(all.size, 1);
  });

  await test('two different creates racing for one subject yield one active request', async function () {
    const env = makeEnvironment();
    const settled = await Promise.allSettled([
      openPending(env, { request_id:'race-create-operation-0001' }),
      openPending(env, { request_id:'race-create-operation-0002' })
    ]);
    assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(x => x.status === 'rejected').length, 1);
    assert.equal(settled.find(x => x.status === 'rejected').reason.code, 'already-exists');
    assert.equal((await env.db.collection('station_transfer_requests').get()).size, 1);
  });

  await test('same pending create repairs its sole missing active lock', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env, {
      request_id:'repair-missing-lock-operation-0001'
    });
    await env.db.doc('station_transfer_locks/' + pending.target_uid).delete();

    const replay = await openPending(env, {
      request_id:'repair-missing-lock-operation-0001'
    });
    assert.equal(replay.changed, true,
      'recreating the missing lock is an observable repair');
    assert.equal(replay.status, 'pending_target');
    const lock = env.db.read('station_transfer_locks/' + pending.target_uid);
    assert.equal(lock.request_id, pending.request_id);
    assert.equal(lock.target_uid, pending.target_uid);
    assert.equal(lock.status, 'pending_target');
  });

  await test('a second request is blocked when the first active request lost its lock',
    async function () {
      const env = makeEnvironment();
      const first = await openPending(env, {
        request_id:'first-missing-lock-operation-0001'
      });
      await env.db.doc('station_transfer_locks/' + first.target_uid).delete();

      await rejectsCode('already-exists', openPending(env, {
        request_id:'second-missing-lock-operation-0001'
      }));
      const requests = await env.db.collection('station_transfer_requests').get();
      assert.equal(requests.size, 1);
      assert.equal(requests.docs[0].id, first.request_id);
    });

  await test('terminal create replay returns the stored status and does not restore a lock',
    async function () {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'terminal-replay-operation-0001'
      });
      await env.service.cancel(callable('source_hr', { request_id:pending.request_id }));

      const replay = await openPending(env, {
        request_id:'terminal-replay-operation-0001'
      });
      assert.equal(replay.changed, false);
      assert.equal(replay.status, 'cancelled');
      assert.equal(env.db.read('station_transfer_locks/' + pending.target_uid), undefined);
    });

  await test('completed create replay remains idempotent after the identity operation',
    async function () {
      const env = makeEnvironment();
      const requestId = 'completed-create-replay-operation-0001';
      const pending = await openPending(env, { request_id:requestId });
      const completed = await env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      }));
      assert.equal(completed.status, 'completed');

      // The fake identity coordinator records the effect but intentionally
      // does not mutate Auth or station membership. Simulate the durable move
      // so this replay proves it is resolved before live-source validation.
      env.authUsers.get('unique_subject').customClaims.stationId = 'target_202';
      const source = env.db.read('stations/source_102/users/unique_subject');
      source.is_active = false;
      env.db.seed('stations/source_102/users/unique_subject', source);
      env.db.seed('stations/target_202/users/unique_subject', {
        full_name:'יעל לוי', role:'firefighter', station:'target_202', district:'south',
        crew:'C', employee_number:'1003', is_active:true
      });

      const replay = await openPending(env, { request_id:requestId });
      assert.equal(replay.changed, false);
      assert.equal(replay.status, 'completed');
      assert.equal(env.db.read('station_transfer_locks/' + pending.target_uid), undefined);
      assert.equal(env.identityCalls.effects, 1);
    });

  await test('a creator who moved stations cannot replay an old request, but super can',
    async function () {
      const env = makeEnvironment();
      const requestId = 'moved-creator-replay-operation-0001';
      const pending = await openPending(env, { request_id:requestId });
      env.db.seed('stations/foreign_303/users/source_hr', {
        station:'foreign_303', role:'hr_coordinator', is_active:true, employee_number:'9001'
      });

      await rejectsCode('permission-denied', env.service.create(callable('source_hr',
        createData(env, { request_id:requestId }), {
          stationId:'foreign_303', districtId:'north'
      })));
      const replay = await env.service.create(callable('super_user',
        createData(env, { request_id:requestId, station_id:'source_102' })));
      assert.equal(replay.changed, false);
      assert.equal(replay.request_id, pending.request_id);
      assert.equal(replay.status, 'pending_target');
      assert.equal(replay.source_station_id, 'source_102');
    });

  await test('only live target HR or target station commander can approve', async function () {
    for (const actor of ['source_hr','foreign_hr','target_firefighter','inactive_target_hr']) {
      const env = makeEnvironment();
      const pending = await openPending(env);
      await rejectsCode('permission-denied', env.service.decide(callable(actor, {
        request_id:pending.request_id, decision:'approve'
      }, actor === 'inactive_target_hr' ? { role:'hr_coordinator', stationId:'target_202' } : {})));
      assert.equal(env.identityCalls.acquire.length, 0, actor);
    }
    for (const actor of ['target_hr','target_commander']) {
      const env = makeEnvironment();
      const pending = await openPending(env);
      const result = await env.service.decide(callable(actor, {
        request_id:pending.request_id, decision:'approve'
      }));
      assert.equal(result.status, 'completed', actor);
      assert.equal(env.identityCalls.acquire.length, 1, actor);
      assert.equal(env.identityCalls.run.length, 1, actor);
    }
  });

  await test('approval repairs a sole active missing lock before identity work', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env, {
      request_id:'approval-lock-repair-operation-0001'
    });
    await env.db.doc('station_transfer_locks/' + pending.target_uid).delete();
    let claimedLock;
    env.setIdentityGetHook(async function (uid) {
      claimedLock = env.db.read('station_transfer_locks/' + uid);
    });

    const result = await env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'approve'
    }));
    assert.equal(result.status, 'completed');
    assert.equal(claimedLock.request_id, pending.request_id);
    assert.equal(claimedLock.target_uid, pending.target_uid);
    assert.equal(claimedLock.status, 'processing');
    assert.match(String(claimedLock.operation_id || ''), /^transfer-/);
    assert.equal(env.identityCalls.effects, 1);
  });

  await test('self approval and creator approval are blocked before identity work', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    env.authUsers.get('unique_subject').customClaims = {
      emp:'1003', role:'hr_coordinator', stationId:'target_202', districtId:'south', shift:'C'
    };
    env.db.seed('stations/target_202/users/unique_subject', {
      station:'target_202', role:'hr_coordinator', is_active:true, employee_number:'1003'
    });
    await rejectsCode('permission-denied', env.service.decide(callable('unique_subject', {
      request_id:pending.request_id, decision:'approve'
    }, { role:'hr_coordinator', stationId:'target_202' })));
    env.db.seed('stations/target_202/users/source_hr', {
      station:'target_202', role:'hr_coordinator', is_active:true, employee_number:'9001'
    });
    await rejectsCode('permission-denied', env.service.decide(callable('source_hr', {
      request_id:pending.request_id, decision:'approve'
    }, { role:'hr_coordinator', stationId:'target_202' })));
    assert.equal(env.identityCalls.acquire.length, 0);
  });

  await test('unknown request id is rejected without applying identity', async function () {
    const env = makeEnvironment();
    await rejectsCode('not-found', env.service.decide(callable('target_hr', {
      request_id:'missing-transfer-request-0001', decision:'approve'
    })));
    assert.equal(env.identityCalls.acquire.length, 0);
  });

  await test('subject changes after request make the approval snapshot stale', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    env.authUsers.get('unique_subject').customClaims.role = 'station_commander';
    await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'approve'
    })));
    assert.equal(env.identityCalls.acquire.length, 0);
    assert.equal(env.identityCalls.run.length, 0);
  });

  await test('a disabled Auth account cannot be approved after request creation', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env, {
      request_id:'disabled-approve-operation-0001'
    });
    env.authUsers.get('unique_subject').disabled = true;
    await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'approve'
    })));
    const stored = env.db.read('station_transfer_requests/' + pending.request_id);
    assert.equal(stored.status, 'pending_target');
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'operation_id'), false);
    assert.equal(env.identityCalls.acquire.length, 0);
    assert.equal(env.identityCalls.effects, 0);
  });

  await test('email, full name or phone changes make the signed subject snapshot stale',
    async function () {
      for (const field of ['email', 'full_name', 'phone']) {
        const env = makeEnvironment();
        const pending = await openPending(env, {
          request_id:'changed-' + field.replace('_', '-') + '-operation-0001'
        });
        if (field === 'email') {
          env.authUsers.get('unique_subject').email = 'changed@example.com';
        } else {
          const profilePath = 'stations/source_102/users/unique_subject';
          const profile = env.db.read(profilePath);
          profile[field] = field === 'full_name' ? 'שם חדש' : '0509999999';
          env.db.seed(profilePath, profile);
        }
        await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
          request_id:pending.request_id, decision:'approve'
        })));
        const stored = env.db.read('station_transfer_requests/' + pending.request_id);
        assert.equal(stored.status, 'pending_target', field);
        assert.equal(env.identityCalls.acquire.length, 0, field);
        assert.equal(env.identityCalls.effects, 0, field);
      }
    });

  await test('tampering with signed contact or creator data blocks approval', async function () {
    for (const field of ['email', 'phone', 'created_by']) {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'tamper-' + field.replace('_', '-') + '-operation-0001'
      });
      const path = 'station_transfer_requests/' + pending.request_id;
      const request = env.db.read(path);
      request[field] = 'tampered-' + field;
      env.db.seed(path, request);
      await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      })));
      assert.equal(env.identityCalls.acquire.length, 0, field);
    }
  });

  await test('destination is revalidated and an inactive station cannot approve', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    env.stations.set('target_202', {
      id:'target_202', name:'תחנת יעד', districtId:'south', active:false
    });
    await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'approve'
    })));
    assert.equal(env.identityCalls.acquire.length, 0);
    assert.equal(env.identityCalls.run.length, 0);
  });

  await test('approver stale token cannot override their live station or role', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    env.db.seed('stations/target_202/users/target_hr', {
      station:'target_202', role:'firefighter', is_active:true, employee_number:'9002'
    });
    await rejectsCode('permission-denied', env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'approve'
    }, { role:'hr_coordinator', stationId:'target_202' })));
    assert.equal(env.identityCalls.acquire.length, 0);
  });

  await test('concurrent approvals converge and execute one identity operation', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    const payload = {
      request_id:pending.request_id, decision:'approve'
    };
    const results = await Promise.all([
      env.service.decide(callable('target_hr', payload)),
      env.service.decide(callable('target_hr', payload))
    ]);
    assert.deepEqual(results.map(x => requestFrom(x).status), ['completed','completed']);
    assert.equal(env.identityCalls.effects, 1, 'the durable identity plan has one effect');
    const audits = await env.db.collection('admin_audit').get();
    assert.equal(audits.docs.filter(x => (x.data() || {}).action ===
      'complete_station_transfer').length, 1, 'completion is audited once');
  });

  await test('an unrelated identity operation race restores pending instead of recovery',
    async function () {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'foreign-identity-race-operation-0001'
      });
      env.setIdentityGetHook(async function (uid) {
        const operation = {
          op_id:'foreign-role-operation-0001', target_uid:uid, kind:'set_role',
          status:'processing', intent_fingerprint:'f'.repeat(64),
          plan_fingerprint:'e'.repeat(64),
          plan_summary:{ kind:'set_role', role:'commander' }
        };
        env.identityOps.set(uid, copy(operation));
        env.db.seed('identity_operations/' + uid, operation);
      });
      await rejectsCode('aborted', env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      })));
      const stored = env.db.read('station_transfer_requests/' + pending.request_id);
      const lock = env.db.read('station_transfer_locks/unique_subject');
      assert.equal(stored.status, 'pending_target');
      assert.equal(Object.prototype.hasOwnProperty.call(stored, 'operation_id'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(stored, 'approved_by'), false);
      assert.equal(lock.status, 'pending_target');
      assert.equal(Object.prototype.hasOwnProperty.call(lock, 'operation_id'), false);
      assert.equal(env.identityCalls.acquire.length, 1);
      assert.equal(env.identityCalls.effects, 0);
    });

  await test('retry resumes an exact transfer after the source profile was retired', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    const path = 'station_transfer_requests/' + pending.request_id;
    const request = env.db.read(path);
    const operation = transferOperationFor(request, 'needs_recovery');
    env.identityOps.set(request.target_uid, copy(operation));
    env.db.seed('identity_operations/' + request.target_uid, operation);
    env.db.seed(path, Object.assign({}, request, {
      status:'needs_recovery', operation_id:operation.op_id
    }));
    env.db.seed('station_transfer_locks/' + request.target_uid, {
      request_id:request.request_id, target_uid:request.target_uid,
      status:'needs_recovery', operation_id:operation.op_id
    });
    const source = env.db.read('stations/source_102/users/' + request.target_uid);
    source.is_active = false;
    env.db.seed('stations/source_102/users/' + request.target_uid, source);

    const result = await env.service.decide(callable('target_hr', {
      request_id:request.request_id, decision:'approve'
    }));
    assert.equal(result.status, 'completed');
    assert.equal(env.identityCalls.resume.length, 1);
    assert.equal(env.identityCalls.effects, 1);
    assert.equal(env.db.read(path).status, 'completed');
  });

  await test('completed identity side effects are finalized without reopening the source', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    const path = 'station_transfer_requests/' + pending.request_id;
    const request = env.db.read(path);
    const operation = transferOperationFor(request, 'completed');
    operation.result = { ok:true, status:'completed' };
    env.identityOps.set(request.target_uid, copy(operation));
    env.db.seed('identity_operations/' + request.target_uid, operation);
    env.db.seed(path, Object.assign({}, request, {
      status:'needs_recovery', operation_id:operation.op_id
    }));
    env.db.seed('station_transfer_locks/' + request.target_uid, {
      request_id:request.request_id, target_uid:request.target_uid,
      status:'needs_recovery', operation_id:operation.op_id
    });
    env.db.seed('stations/source_102/schedule_access/' + request.target_uid, {
      active:true, roles:['schedule_manager'], revision:4
    });
    const source = env.db.read('stations/source_102/users/' + request.target_uid);
    source.is_active = false;
    env.db.seed('stations/source_102/users/' + request.target_uid, source);

    const result = await env.service.decide(callable('target_hr', {
      request_id:request.request_id, decision:'approve'
    }));
    assert.equal(result.status, 'completed');
    assert.equal(env.identityCalls.resume.length, 0);
    assert.equal(env.identityCalls.run.length, 0);
    assert.equal(env.db.read(path).status, 'completed');
    assert.equal(env.db.read('station_transfer_locks/' + request.target_uid), undefined);
    assert.deepEqual(env.db.read('stations/source_102/schedule_access/' + request.target_uid).roles,
      []);
  });

  await test('completion preserves a foreign lock installed after the transfer was claimed',
    async function () {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'complete-foreign-lock-operation-0001'
      });
      const foreignLock = {
        request_id:'foreign-lock-owner-operation-0001',
        target_uid:pending.target_uid,
        status:'pending_target',
        operation_id:'foreign-identity-operation-0001',
        marker:'must-survive'
      };
      env.setIdentityGetHook(async function (uid) {
        env.db.seed('station_transfer_locks/' + uid, foreignLock);
      });

      const result = await env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      }));
      assert.equal(result.status, 'completed');
      assert.equal(env.db.read('station_transfer_requests/' + pending.request_id).status,
        'completed');
      assert.deepEqual(env.db.read('station_transfer_locks/' + pending.target_uid), foreignLock);
      assert.equal(env.identityCalls.effects, 1);
    });

  await test('markFailed recreates a missing lock with canonical ownership', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env, {
      request_id:'mark-failed-lock-operation-0001'
    });
    env.setIdentityGetHook(async function (uid) {
      await env.db.doc('station_transfer_locks/' + uid).delete();
      const foreignOperation = {
        op_id:'foreign-role-operation-0002', target_uid:uid, kind:'set_role',
        status:'processing', intent_fingerprint:'f'.repeat(64),
        plan_fingerprint:'e'.repeat(64),
        plan_summary:{ kind:'set_role', role:'commander' }
      };
      env.identityOps.set(uid, copy(foreignOperation));
      env.db.seed('identity_operations/' + uid, foreignOperation);
    });

    await rejectsCode('aborted', env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'approve'
    })));
    const stored = env.db.read('station_transfer_requests/' + pending.request_id);
    const lock = env.db.read('station_transfer_locks/' + pending.target_uid);
    assert.equal(stored.status, 'pending_target');
    assert.equal(stored.revision, 3,
      'claim and markFailed must each advance the request revision');
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'operation_id'), false);
    assert.equal(lock.request_id, pending.request_id);
    assert.equal(lock.target_uid, pending.target_uid);
    assert.equal(lock.status, 'pending_target');
    assert.equal(Object.prototype.hasOwnProperty.call(lock, 'operation_id'), false);
    assert.equal(env.identityCalls.effects, 0);
  });

  await test('markFailed advances revision when a durable identity plan needs recovery',
    async function () {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'mark-failed-plan-operation-0001'
      });
      env.setIdentityRunHook(async function () {
        throw new TestHttpsError('unavailable', 'injected identity execution failure');
      });

      await rejectsCode('unavailable', env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      })));
      const stored = env.db.read('station_transfer_requests/' + pending.request_id);
      const lock = env.db.read('station_transfer_locks/' + pending.target_uid);
      assert.equal(stored.status, 'needs_recovery');
      assert.equal(stored.reason_code, 'identity_operation_incomplete');
      assert.equal(stored.revision, 3,
        'claim and markFailed must each advance the request revision');
      assert.equal(lock.request_id, pending.request_id);
      assert.equal(lock.target_uid, pending.target_uid);
      assert.equal(lock.status, 'needs_recovery');
      assert.match(String(lock.operation_id || ''), /^transfer-/);
      assert.equal(env.identityCalls.effects, 0);
    });

  await test('markFailed preserves a foreign lock and records a recovery anomaly',
    async function () {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'mark-failed-foreign-lock-operation-0001'
      });
      const foreignLock = {
        request_id:'foreign-lock-owner-operation-0003',
        target_uid:pending.target_uid,
        status:'pending_target',
        operation_id:'foreign-role-operation-0003',
        marker:'must-survive'
      };
      env.setIdentityGetHook(async function (uid) {
        env.db.seed('station_transfer_locks/' + uid, foreignLock);
        const foreignOperation = {
          op_id:'foreign-role-operation-0003', target_uid:uid, kind:'set_role',
          status:'processing', intent_fingerprint:'a'.repeat(64),
          plan_fingerprint:'b'.repeat(64),
          plan_summary:{ kind:'set_role', role:'commander' }
        };
        env.identityOps.set(uid, copy(foreignOperation));
        env.db.seed('identity_operations/' + uid, foreignOperation);
      });

      await rejectsCode('aborted', env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      })));
      const stored = env.db.read('station_transfer_requests/' + pending.request_id);
      assert.equal(stored.status, 'needs_recovery');
      assert.equal(stored.reason_code, 'transfer_lock_conflict');
      assert.equal(stored.lock_anomaly, 'foreign_or_duplicate');
      assert.equal(stored.revision, 3,
        'claim and markFailed must each advance the request revision');
      assert.deepEqual(env.db.read('station_transfer_locks/' + pending.target_uid), foreignLock);
      assert.equal(env.identityCalls.effects, 0);
    });

  await test('approval clears a historical active schedule grant at the target station',
    async function () {
      const env = makeEnvironment();
      env.db.seed('stations/target_202/schedule_access/unique_subject', {
        schema_version:1, station_id:'target_202', uid:'unique_subject',
        roles:['schedule_manager'], active:true, revision:7
      });
      const pending = await openPending(env, {
        request_id:'target-grant-reset-operation-0001'
      });
      const result = await env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      }));
      assert.equal(result.status, 'completed');
      const grant = env.db.read('stations/target_202/schedule_access/unique_subject');
      assert.equal(grant.active, false);
      assert.deepEqual(grant.roles, []);
      assert.equal(grant.revision, 8);
      assert.equal(grant.disabled_reason, 'station_transfer_target_reset');
      assert.equal(env.identityCalls.effects, 1);
    });

  await test('replaying a completed decision is idempotent and does not rerun identity', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    const payload = {
      request_id:pending.request_id, decision:'approve'
    };
    const first = requestFrom(await env.service.decide(callable('target_hr', payload)));
    const second = requestFrom(await env.service.decide(callable('target_hr', payload)));
    assert.equal(first.status, 'completed');
    assert.deepEqual(second, first);
    assert.equal(env.identityCalls.effects, 1);
  });

  await test('source HR can cancel only a pending request; cancellation applies no identity', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env);
    await rejectsCode('permission-denied', env.service.cancel(callable('foreign_hr', {
      request_id:pending.request_id
    })));
    const cancelled = await env.service.cancel(callable('source_hr', {
      request_id:pending.request_id
    }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(env.identityCalls.acquire.length, 0);
    assert.equal(env.identityCalls.run.length, 0);
    await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'approve'
    })));
  });

  await test('reject and cancel fail closed without deleting a foreign lock', async function () {
    const env = makeEnvironment();
    const pending = await openPending(env, {
      request_id:'foreign-lock-close-operation-0001'
    });
    const foreignLock = {
      request_id:'foreign-lock-owner-operation-0002',
      target_uid:pending.target_uid,
      status:'pending_target',
      marker:'must-survive'
    };
    env.db.seed('station_transfer_locks/' + pending.target_uid, foreignLock);

    await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
      request_id:pending.request_id, decision:'reject', reason_code:'not_accepted'
    })));
    await rejectsCode('failed-precondition', env.service.cancel(callable('source_hr', {
      request_id:pending.request_id
    })));
    assert.equal(env.db.read('station_transfer_requests/' + pending.request_id).status,
      'pending_target');
    assert.deepEqual(env.db.read('station_transfer_locks/' + pending.target_uid), foreignLock);
    assert.equal(env.identityCalls.effects, 0);
  });

  await test('a foreign station cannot use cancelled replay as an authorization bypass',
    async function () {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'foreign-cancel-replay-operation-0001'
      });
      const cancelled = await env.service.cancel(callable('source_hr', {
        request_id:pending.request_id
      }));
      assert.equal(cancelled.status, 'cancelled');
      await rejectsCode('permission-denied', env.service.cancel(callable('foreign_hr', {
        request_id:pending.request_id
      })));
      const stored = env.db.read('station_transfer_requests/' + pending.request_id);
      assert.equal(stored.status, 'cancelled');
      assert.equal(stored.cancelled_by, 'source_hr');
      assert.equal(env.identityCalls.acquire.length, 0);
    });

  await test('list exposes only outgoing to source HR and incoming to target reviewers', async function () {
    const env = makeEnvironment();
    await openPending(env);
    const source = await env.service.list(callable('source_hr', { direction:'outgoing' }));
    const target = await env.service.list(callable('target_commander', { direction:'incoming' }));
    await rejectsCode('permission-denied',
      env.service.list(callable('target_firefighter', { direction:'incoming' })));
    assert.equal(source.transfers.length, 1);
    assert.equal(target.transfers.length, 1);
    assert.deepEqual(source.targets.map(function (row) { return row.station_id; }).sort(),
      ['foreign_303', 'target_202']);
    for (const request of source.transfers.concat(target.transfers)) {
      for (const forbidden of ['email','phone','employee_number','emp']) {
        assert.equal(Object.prototype.hasOwnProperty.call(request, forbidden), false, forbidden);
      }
    }
  });

  await test('list still returns an active request after 101 terminal rows in one direction',
    async function () {
      const env = makeEnvironment();
      for (let index = 0; index < 101; index++) {
        const id = 'terminal-list-row-' + String(index).padStart(4, '0');
        env.db.seed('station_transfer_requests/' + id, {
          request_id:id,
          target_uid:'terminal-user-' + index,
          full_name:'רשומה סופית ' + index,
          role:'firefighter', shift:'A',
          source_station_id:'source_102', target_station_id:'target_202',
          status:index % 2 === 0 ? 'cancelled' : 'rejected', revision:2
        });
      }
      const pending = await openPending(env, {
        request_id:'active-after-terminal-list-operation-0001'
      });

      const result = await env.service.list(callable('source_hr', { direction:'outgoing' }));
      assert.equal(result.transfers.length, 1);
      assert.equal(result.transfers[0].request_id, pending.request_id);
      assert.equal(result.transfers[0].status, 'pending_target');
    });

  await test('a station catalogue change between preflight and transactional claim is rejected',
    async function () {
      const env = makeEnvironment();
      const pending = await openPending(env, {
        request_id:'catalog-race-operation-0001'
      });
      let resolveCalls = 0;
      env.setResolveStationHook(async function (call) {
        if (call.stationId === 'target_202') {
          resolveCalls++;
        }
        if (call.stationId === 'target_202' && resolveCalls === 1) {
          env.stations.set('target_202', Object.assign({}, call.current, { active:false }));
          return call.current;
        }
        return undefined;
      });
      await rejectsCode('failed-precondition', env.service.decide(callable('target_hr', {
        request_id:pending.request_id, decision:'approve'
      })));
      assert.equal(resolveCalls, 2,
        'the station catalogue must be checked again inside the claim transaction');
      assert.equal(env.db.read('station_transfer_requests/' + pending.request_id).status,
        'pending_target');
      assert.equal(env.identityCalls.acquire.length, 0);
      assert.equal(env.identityCalls.effects, 0);
    });

  console.log('\n' + passed + ' station-transfer contract tests passed.');
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
