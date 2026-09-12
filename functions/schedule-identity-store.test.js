'use strict';

const assert = require('node:assert/strict');
const access = require('./schedule-access');
const contract = require('./schedule-identity-store-contract');
const subject = require(process.env.SCHEDULE_IDENTITY_STORE_SUBJECT || './schedule-identity-store');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

function fakeDb(seed = {}) {
  const state = new Map(Object.entries(seed).map(([key, value]) => [key, clone(value)]));
  const writes = [];
  let failCommit = false;

  function snap(ref) {
    const exists = state.has(ref.path);
    return { exists, id:ref.id, ref, data:() => exists ? clone(state.get(ref.path)) : undefined };
  }
  function doc(path) {
    return { path, id:path.split('/').pop(), collection:(name) => collection(path + '/' + name) };
  }
  function collection(path, order = null, after = null, cap = null) {
    return {
      path,
      doc:(id) => doc(path + '/' + id),
      orderBy:(field) => collection(path, field, after, cap),
      startAfter:(value) => collection(path, order, value, cap),
      limit:(value) => collection(path, order, after, value),
      _query:true, _order:order, _after:after, _cap:cap
    };
  }
  function querySnap(query) {
    const depth = query.path.split('/').length + 1;
    let docs = [...state.keys()].filter((key) => key.startsWith(query.path + '/') && key.split('/').length === depth)
      .map((key) => snap(doc(key)));
    if (query._order) docs.sort((a, b) => String(a.data()[query._order]).localeCompare(String(b.data()[query._order]), 'en'));
    if (query._after !== null) docs = docs.filter((item) => String(item.data()[query._order]) > String(query._after));
    if (query._cap !== null) docs = docs.slice(0, query._cap);
    return { docs, size:docs.length };
  }

  return {
    collection,
    failNextCommit() { failCommit = true; },
    read(path) { return state.has(path) ? clone(state.get(path)) : null; },
    write(path, value) { state.set(path, clone(value)); },
    keys() { return [...state.keys()].sort(); },
    writes,
    async runTransaction(work) {
      const pending = [];
      let wrote = false;
      const tx = {
        async get(ref) {
          if (wrote) throw new Error('read-after-write');
          return ref._query ? querySnap(ref) : snap(ref);
        },
        set(ref, value) { wrote = true; pending.push({ op:'set', path:ref.path, value:clone(value) }); },
        create(ref, value) {
          wrote = true;
          if (state.has(ref.path) || pending.some((item) => item.path === ref.path)) throw new HttpsError('already-exists', 'collision');
          pending.push({ op:'create', path:ref.path, value:clone(value) });
        },
        delete(ref) { wrote = true; pending.push({ op:'delete', path:ref.path }); }
      };
      const result = await work(tx);
      if (failCommit) { failCommit = false; throw new HttpsError('unavailable', 'synthetic commit failure'); }
      for (const item of pending) {
        if (item.op === 'delete') state.delete(item.path); else state.set(item.path, item.value);
        writes.push(item);
      }
      return result;
    }
  };
}

const SID = 'eilat_102';
const ACTOR = 'manager_1';
const UID = 'Employee.MixedCase';
const PID = 'sp_person_001';
const root = 'stations/' + SID;
const personPath = root + '/schedule_people/' + PID;
const statePath = root + '/schedule_identity_state/current';
const accessPath = root + '/schedule_access/' + ACTOR;
const actorPath = root + '/users/' + ACTOR;
const userPath = root + '/users/' + UID;

function person(extra = {}) {
  return { schema_version:1, person_id:PID, station_id:SID, kind:'external', linked_uid:null,
    display_name:'אלדד יונה', active:true, revision:4, ...extra };
}
function state(extra = {}) { return { schema_version:1, generation:'gen_001', revision:3, ...extra }; }
function manager() {
  return { schema_version:1, station_id:SID, uid:ACTOR, roles:['schedule_manager'], active:true, revision:1 };
}
function member(uid) { return { uid, station_id:SID, role:'firefighter', active:true }; }
function identity(db) {
  return {
    context(req) {
      if (!req || !req.auth || !access.validUid(req.auth.uid)) throw new HttpsError('unauthenticated', 'login');
      const token = req.auth.token || {};
      if (token.stationId !== SID) throw new HttpsError('failed-precondition', 'station');
      return Object.freeze({ uid:req.auth.uid, sid:token.stationId, role:token.role, super:token.super === true });
    },
    async requireLive(tx, ctx) {
      if (ctx.super) return ctx;
      const snap = await tx.get(db.collection('stations').doc(ctx.sid).collection('users').doc(ctx.uid));
      const value = snap.exists ? snap.data() : null;
      if (!access.activeMember(value, ctx.sid) || value.role !== ctx.role) throw new HttpsError('permission-denied', 'revoked');
      return ctx;
    }
  };
}
function fixture(extra = {}) {
  const db = fakeDb({
    [personPath]:person(), [statePath]:state(), [accessPath]:manager(),
    [actorPath]:member(ACTOR), [userPath]:member(UID), ...extra
  });
  const api = subject.createScheduleIdentityStore({ db, identity:identity(db), HttpsError,
    serverTimestamp:() => 'SERVER_TIME' });
  const auth = { uid:ACTOR, token:{ stationId:SID, role:'firefighter' } };
  return { db, api, auth };
}
function linkReq(auth, extra = {}) {
  return { auth, data:{ request_id:'link_req_001', person_id:PID, uid:UID,
    expected_person_revision:4, expected_state_revision:3, ...extra } };
}

(async function run() {
  assert.throws(() => subject.createScheduleIdentityStore({}), TypeError);

  {
    const f = fixture();
    const result = await f.api.link(linkReq(f.auth));
    assert.deepEqual(Object.keys(result.person).sort(), ['active','display_name','person_id','station_id'].sort());
    assert.equal(result.person.person_id, PID);
    assert.equal(result.state_revision, 4);
    assert.equal(result.bindings_invalidated, true);
    const linkId = contract.linkIndexDocumentId(UID);
    const globalPath = subject.GLOBAL_LINK_COLLECTION + '/' + linkId;
    assert.deepEqual(f.db.read(globalPath), { schema_version:1, station_id:SID, person_id:PID, revision:1 });
    assert.equal(globalPath.includes(UID), false);
    assert.equal(JSON.stringify(f.db.read(globalPath)).includes(UID), false);
    const auditPath = f.db.keys().find((key) => key.includes('/schedule_identity_audit/'));
    assert.equal(JSON.stringify(f.db.read(auditPath)).includes(UID), false);
    assert.equal(f.db.read(personPath).linked_uid, UID);

    const count = f.db.writes.length;
    const replay = await f.api.link(linkReq(f.auth));
    assert.equal(replay.replayed, true);
    assert.equal(f.db.writes.length, count);
    await assert.rejects(() => f.api.link(linkReq(f.auth, { uid:'OtherUser' })), (error) => error.code === 'already-exists');

    const operationPath = f.db.keys().find((key) => key.includes('/schedule_identity_operations/'));
    const corrupt = f.db.read(operationPath);
    corrupt.result.person.linked_uid = UID;
    f.db.write(operationPath, corrupt);
    await assert.rejects(() => f.api.link(linkReq(f.auth)), (error) => error.code === 'data-loss');
  }

  {
    const linkId = contract.linkIndexDocumentId(UID);
    const f = fixture({ [subject.GLOBAL_LINK_COLLECTION + '/' + linkId]:{
      schema_version:1, station_id:'other_102', person_id:'sp_other_001', revision:7
    } });
    const before = f.db.keys();
    await assert.rejects(() => f.api.link(linkReq(f.auth)), (error) => error.code === 'already-exists');
    assert.deepEqual(f.db.keys(), before);
    assert.equal(f.db.writes.length, 0);
  }

  {
    const f = fixture();
    await f.api.link(linkReq(f.auth, { station_id:'forged_999' }));
    assert.equal(f.db.read(personPath).station_id, SID);
    const denied = fixture({ [accessPath]:{ ...manager(), active:false, roles:[] } });
    await assert.rejects(() => denied.api.link(linkReq(denied.auth, { actor:{ authorized:true, station_id:SID } })),
      (error) => error.code === 'permission-denied');
    const revoked = fixture({ [actorPath]:{ ...member(ACTOR), active:false } });
    await assert.rejects(() => revoked.api.link(linkReq(revoked.auth)),
      (error) => error.code === 'permission-denied');
  }

  {
    const f = fixture();
    f.db.failNextCommit();
    const before = f.db.keys();
    await assert.rejects(() => f.api.link(linkReq(f.auth)), (error) => error.code === 'unavailable');
    assert.deepEqual(f.db.keys(), before);
    assert.equal(f.db.read(personPath).kind, 'external');
  }

  {
    const f = fixture();
    await f.api.link(linkReq(f.auth));
    const unlink = { auth:f.auth, data:{ request_id:'unlink_req_001', person_id:PID,
      expected_person_revision:5, expected_state_revision:4, expected_link_revision:1 } };
    const result = await f.api.unlink(unlink);
    assert.equal(result.person.person_id, PID);
    assert.equal(f.db.read(personPath).kind, 'external');
    assert.equal(f.db.read(personPath).linked_uid, null);
    assert.equal(f.db.read(subject.GLOBAL_LINK_COLLECTION + '/' + contract.linkIndexDocumentId(UID)), null);
    const count = f.db.writes.length;
    assert.equal((await f.api.unlink(unlink)).replayed, true);
    assert.equal(f.db.writes.length, count);
  }

  {
    const f = fixture({ [statePath]:state({ revision:Number.MAX_SAFE_INTEGER }) });
    await assert.rejects(() => f.api.link(linkReq(f.auth, { expected_state_revision:Number.MAX_SAFE_INTEGER })),
      (error) => error.code === 'failed-precondition');
  }

  {
    const stalePerson = fixture();
    await assert.rejects(() => stalePerson.api.link(linkReq(stalePerson.auth, { expected_person_revision:3 })),
      (error) => error.code === 'aborted');
    const staleState = fixture();
    await assert.rejects(() => staleState.api.link(linkReq(staleState.auth, { expected_state_revision:2 })),
      (error) => error.code === 'aborted');
  }

  {
    const f = fixture();
    await f.api.link(linkReq(f.auth));
    const globalPath = subject.GLOBAL_LINK_COLLECTION + '/' + contract.linkIndexDocumentId(UID);
    f.db.read(globalPath);
    const broken = { ...f.db.read(globalPath), person_id:'sp_other_001' };
    const replacement = fixture({
      [personPath]:f.db.read(personPath), [statePath]:f.db.read(statePath),
      [root + '/schedule_person_link_index/' + contract.linkIndexDocumentId(UID)]:f.db.read(root + '/schedule_person_link_index/' + contract.linkIndexDocumentId(UID)),
      [globalPath]:broken
    });
    await assert.rejects(() => replacement.api.unlink({ auth:replacement.auth, data:{ request_id:'unlink_bad_001',
      person_id:PID, expected_person_revision:5, expected_state_revision:4, expected_link_revision:1 } }),
      (error) => error.code === 'aborted');
    assert.deepEqual(replacement.db.read(globalPath), broken);
  }

  assert.equal(contract.linkIndexDocumentId('  ' + UID + '  '), contract.linkIndexDocumentId(UID));
  assert.notEqual(contract.linkIndexDocumentId(UID.toLowerCase()), contract.linkIndexDocumentId(UID));

  {
    const f = fixture();
    const sourceKey = { kind:'employee', value:'00123' };
    const request = { auth:f.auth, data:{ request_id:'binding_req_001', source_namespace:'station-workbook-v1',
      source_key:sourceKey, person_id:PID, expected_person_revision:4,
      expected_state_revision:3, expected_binding_revision:null } };
    const saved = await f.api.setSourceBinding(request);
    assert.equal(saved.binding.person_id, PID);
    assert.equal(saved.binding.expected_person_revision, 4);
    assert.equal(saved.binding.revision, 1);
    assert.equal(saved.state_revision, 4);
    const count = f.db.writes.length;
    assert.equal((await f.api.setSourceBinding(request)).replayed, true);
    assert.equal(f.db.writes.length, count);
    await assert.rejects(() => f.api.setSourceBinding({ auth:f.auth, data:{ ...request.data,
      request_id:'binding_req_002', expected_state_revision:4, expected_binding_revision:null } }),
      (error) => error.code === 'aborted');
    await assert.rejects(() => f.api.setSourceBinding({ auth:f.auth, data:{ ...request.data,
      request_id:'binding_req_003', source_namespace:'foreign-v1', expected_state_revision:4,
      expected_binding_revision:1 } }), (error) => error.code === 'invalid-argument');

    const updated = await f.api.setSourceBinding({ auth:f.auth, data:{ ...request.data,
      request_id:'binding_req_004', expected_state_revision:4, expected_binding_revision:1 } });
    assert.equal(updated.binding.revision, 2);
    assert.equal(updated.state_revision, 5);
    await assert.rejects(() => f.api.setSourceBinding({ auth:f.auth, data:{ ...request.data,
      request_id:'binding_req_005', expected_state_revision:5, expected_binding_revision:1 } }),
      (error) => error.code === 'aborted');
    const listed = await f.api.listBindings({ auth:f.auth, data:{ limit:1 } });
    assert.equal(listed.bindings.length, 1);
    assert.equal(listed.bindings[0].source_key.value, '00123');
    assert.equal(Object.prototype.hasOwnProperty.call(listed.bindings[0], 'station_id'), false);

    const cursor = Buffer.from(JSON.stringify({ v:1, sid:'other_102', binding_id:saved.binding.binding_id }))
      .toString('base64url');
    await assert.rejects(() => f.api.listBindings({ auth:f.auth, data:{ cursor } }),
      (error) => error.code === 'invalid-argument');

    const operationPath = f.db.keys().find((key) => key.includes('/schedule_identity_operations/'));
    const corruptReplay = f.db.read(operationPath);
    corruptReplay.result.binding.person_id = 'bad';
    f.db.write(operationPath, corruptReplay);
    await assert.rejects(() => f.api.setSourceBinding(request), (error) => error.code === 'data-loss');

    const stalePerson = fixture();
    await assert.rejects(() => stalePerson.api.setSourceBinding({ auth:stalePerson.auth, data:{ ...request.data,
      request_id:'binding_stale_person', expected_person_revision:3 } }), (error) => error.code === 'aborted');
    const staleState = fixture();
    await assert.rejects(() => staleState.api.setSourceBinding({ auth:staleState.auth, data:{ ...request.data,
      request_id:'binding_stale_state', expected_state_revision:2 } }), (error) => error.code === 'aborted');
  }


  {
    const sourceKey = { kind:'employee', value:'00123' };
    const bindingId = contract.bindingDocumentId('station-workbook-v1', sourceKey);
    const bindingPath = root + '/schedule_source_bindings/' + bindingId;
    const corrupt = fixture({ [bindingPath]:{ schema_version:1, station_id:SID, binding_id:bindingId,
      source_namespace:'station-workbook-v1', source_key:{ kind:'employee', value:'DIFFERENT' },
      person_id:'bad', expected_person_revision:999, revision:1 } });
    await assert.rejects(() => corrupt.api.setSourceBinding({ auth:corrupt.auth, data:{ request_id:'binding_corrupt_001',
      source_namespace:'station-workbook-v1', source_key:sourceKey, person_id:PID,
      expected_person_revision:4, expected_state_revision:3, expected_binding_revision:1 } }),
      (error) => error.code === 'data-loss');
    assert.equal(corrupt.db.read(bindingPath).source_key.value, 'DIFFERENT');

    const exhausted = fixture({ [bindingPath]:{ schema_version:1, station_id:SID, binding_id:bindingId,
      source_namespace:'station-workbook-v1', source_key:sourceKey, person_id:PID,
      expected_person_revision:4, revision:Number.MAX_SAFE_INTEGER } });
    await assert.rejects(() => exhausted.api.setSourceBinding({ auth:exhausted.auth, data:{ request_id:'binding_max_001',
      source_namespace:'station-workbook-v1', source_key:sourceKey, person_id:PID,
      expected_person_revision:4, expected_state_revision:3,
      expected_binding_revision:Number.MAX_SAFE_INTEGER } }), (error) => error.code === 'data-loss');
  }

  {
    const second = 'sp_person_002';
    const f = fixture({ [root + '/schedule_people/' + second]:person({ person_id:second, display_name:'שרה כהן' }) });
    const first = await f.api.listPeople({ auth:f.auth, data:{ limit:1 } });
    assert.equal(first.people.length, 1);
    assert.ok(first.next_cursor);
    const next = await f.api.listPeople({ auth:f.auth, data:{ limit:1, cursor:first.next_cursor } });
    assert.equal(next.people.length, 1);
    assert.notEqual(next.people[0].person_id, first.people[0].person_id);
    const raw = JSON.parse(Buffer.from(first.next_cursor, 'base64url').toString('utf8'));
    raw.sid = 'other_102';
    const forged = Buffer.from(JSON.stringify(raw)).toString('base64url');
    await assert.rejects(() => f.api.listPeople({ auth:f.auth, data:{ cursor:forged } }),
      (error) => error.code === 'invalid-argument');
    await assert.rejects(() => f.api.listPeople({ auth:f.auth, data:{ limit:101 } }),
      (error) => error.code === 'invalid-argument');
  }

  console.log('68 schedule identity store checks passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
