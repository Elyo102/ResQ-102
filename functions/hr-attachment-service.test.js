'use strict';

// WHITEBOX UNIT evidence: evaluate the actual assembly source, capture its
// attachment dependency, and use the actual pure identity helper. Parent ports,
// transaction reads, Auth, and Storage are doubles. This is NOT native Firestore,
// actual-parent integration, production transport, or GCS precondition evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const actualIdentity = require('./ops-member-identity');
const filename = path.join(__dirname, 'hr-attachment-service.js');
const source = fs.readFileSync(filename, 'utf8');
const sourceFiles = ['hr-attachment-service.js', 'hr-attachments.js', 'ops-member-identity.js', 'schedule-access.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file,
  createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex')]));
const beforeHashes = hashes();
const METHODS = ['reserve', 'upload', 'resume', 'list', 'download'];
const SID = 'synthetic_hr_station', UID = 'synthetic.hr.actor';
const AUTH_TIME = Date.parse('2026-09-01T00:00:00Z') / 1000;
const PRIVATE_MARKER = 'PRIVATE_AUTH_DIAGNOSTIC';
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const rejectCode = (fn, code) => assert.rejects(async () => fn(), error => error.code === code);

function loadAssembly() {
  const required = [], captures = [], delegated = [];
  const lowerService = Object.freeze(Object.fromEntries([...METHODS, 'reconcile'].map(method => [method,
    (...args) => { delegated.push({ method, args }); return { method, synthetic: true }; }])));
  const module = { exports: {} };
  const interceptedRequire = id => {
    required.push(id);
    if (id === './hr-attachments') return { createHrAttachments(deps) { captures.push(deps); return lowerService; } };
    if (id === './ops-member-identity') return actualIdentity;
    throw new Error('Unexpected assembly dependency: ' + id);
  };
  // The ordinary CommonJS lexical wrapper shares the host realm: plain-object
  // validation must not accidentally test VM cross-realm prototypes instead.
  const execute = new vm.Script('(function(exports,require,module,__filename,__dirname){\n' + source + '\n})', { filename }).runInThisContext();
  execute(module.exports, interceptedRequire, module, filename, __dirname);
  return { create: module.exports.createHrAttachmentService, exports: module.exports, required, captures, lowerService, delegated };
}

function parentDouble(family) {
  const calls = [], plans = [], returns = { read: { family, synthetic: 'read' }, commit: { family, synthetic: 'commit' } };
  const ports = {
    read(tx, input) { calls.push({ method: 'read', tx, input }); return returns.read; },
    async prepare(tx, input) {
      calls.push({ method: 'prepare', tx, input });
      const plan = Object.freeze({ synthetic_family: family, number: plans.length }); plans.push(plan); return plan;
    },
    recheck(tx, plan) { calls.push({ method: 'recheck', tx, plan }); return Promise.resolve(undefined); },
    commit(tx, plan, options) { calls.push({ method: 'commit', tx, plan, options }); return returns.commit; }
  };
  return { ports, calls, plans, returns, service: { attachmentPorts: ports } };
}

function fixture({ claims = { stationId: SID, role: 'hr_coordinator' }, profile = { stationId: SID, role: 'hr_coordinator', active: true, is_active: true } } = {}) {
  const loader = loadAssembly(), events = [], storageCalls = [];
  const state = { record: { uid: UID, disabled: false, customClaims: { ...claims }, tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() }, profile };
  const reference = refPath => ({ path: refPath,
    doc(id) { return reference(refPath + '/' + id); }, collection(id) { return reference(refPath + '/' + id); } });
  const db = { collection(id) { return reference(id); } };
  const tx = { async get(ref) {
    events.push(['profile', ref.path]); assert.equal(ref.path, 'stations/' + SID + '/users/' + UID);
    return { exists: state.profile != null, data: () => state.profile };
  } };
  const auth = { async getUser(uid) {
    events.push(['auth', uid]); assert.equal(uid, UID);
    if (state.record instanceof Error) throw state.record;
    return state.record;
  } };
  const storage = Object.fromEntries(['read', 'save', 'remove'].map(method => [method, () => { storageCalls.push(method); throw new Error('Unit session must not touch Storage'); }]));
  const request = parentDouble('request'), document = parentDouble('document'), clock = () => 1234567, hooks = Object.freeze({ synthetic: true });
  const dependencies = { db, auth, storage, HttpsError, requests: request.service, documents: document.service, clock, hooks };
  const service = loader.create(dependencies), captured = loader.captures[0];
  const req = token => ({ auth: { uid: UID, token: { ...claims, auth_time: AUTH_TIME, ...token } }, data: {} });
  const ctx = captured.session.context(req());
  const live = (authTime = AUTH_TIME, context = ctx) => captured.session.assertLive(tx, context, authTime);
  return { loader, dependencies, service, captured, request, document, state, tx, events, storageCalls, req, ctx, live };
}

test('VM unit: exact actual source dependencies, export, and side-effect-free construction', () => {
  const f = fixture();
  assert.deepEqual(f.loader.required, ['./hr-attachments', './ops-member-identity']);
  assert.deepEqual(Object.keys(f.loader.exports), ['createHrAttachmentService']);
  assert.equal(Object.isFrozen(f.loader.exports), true);
  assert.equal(f.loader.captures.length, 1);
  assert.deepEqual(f.events, []); assert.deepEqual(f.storageCalls, []);
  assert.deepEqual(f.request.calls, []); assert.deepEqual(f.document.calls, []);
  assert.deepEqual(Object.keys(f.captured).sort(), ['db', 'storage', 'HttpsError', 'session', 'ports', 'clock', 'hooks'].sort());
  for (const key of ['db', 'storage', 'HttpsError', 'clock', 'hooks']) assert.equal(f.captured[key], f.dependencies[key]);
  assert.equal(Object.isFrozen(f.captured.ports), true); assert.equal(Object.isFrozen(f.captured.session), true);
});

test('VM unit: expose exactly five unchanged delegates; never expose reconcile, session, or ports', () => {
  const f = fixture(); assert.deepEqual(Object.keys(f.service).sort(), [...METHODS].sort()); assert.equal(Object.isFrozen(f.service), true);
  const req = f.req(), second = { sentinel: true };
  for (const method of METHODS) {
    assert.equal(f.service[method], f.loader.lowerService[method]);
    assert.deepEqual(f.service[method](req, second), { method, synthetic: true });
    const call = f.loader.delegated.at(-1); assert.equal(call.args[0], req); assert.equal(call.args[1], second);
  }
  for (const name of ['reconcile', 'ports', 'session', 'auth', 'storage']) assert.equal(Object.hasOwn(f.service, name), false);
});

test('VM unit: reject missing dependencies and each missing actual-parent port before assembly', () => {
  const f = fixture();
  for (const patch of [{ db: null }, { auth: null }, { auth: {} }, { HttpsError: null }, { requests: null }, { documents: null }]) {
    assert.throws(() => f.loader.create({ ...f.dependencies, ...patch }), TypeError);
  }
  for (const family of ['requests', 'documents']) for (const method of ['read', 'prepare', 'recheck', 'commit']) {
    const ports = { ...f.dependencies[family].attachmentPorts, [method]: undefined };
    assert.throws(() => f.loader.create({ ...f.dependencies, [family]: { attachmentPorts: ports } }), TypeError);
  }
  assert.equal(f.loader.captures.length, 1); assert.deepEqual(f.events, []);
});

test('VM unit: mixed concurrent families retain exact original handles, input, transaction and commit options', async () => {
  const f = fixture(), txRequest = {}, txDocument = {}, requestInput = { parent_kind: 'request', parent_id: 'same-id' }, documentInput = { parent_kind: 'document', parent_id: 'same-id', revision: 2 };
  assert.equal(f.captured.ports.read(txRequest, requestInput), f.request.returns.read);
  assert.equal(f.captured.ports.read(txDocument, documentInput), f.document.returns.read);
  const [rp, dp] = await Promise.all([f.captured.ports.prepare(txRequest, requestInput), f.captured.ports.prepare(txDocument, documentInput)]);
  assert.equal(rp, f.request.plans[0]); assert.equal(dp, f.document.plans[0]); assert.notEqual(rp, dp);
  await Promise.all([f.captured.ports.recheck(txDocument, dp), f.captured.ports.recheck(txRequest, rp)]);
  const options = { at: 1234567 };
  assert.equal(f.captured.ports.commit(txDocument, dp, options), f.document.returns.commit);
  assert.equal(f.captured.ports.commit(txRequest, rp, options), f.request.returns.commit);
  for (const [parent, tx, input, plan] of [[f.request, txRequest, requestInput, rp], [f.document, txDocument, documentInput, dp]]) {
    assert.deepEqual(parent.calls.map(c => c.method), ['read', 'prepare', 'recheck', 'commit']);
    for (const call of parent.calls) assert.equal(call.tx, tx);
    assert.equal(parent.calls[0].input, input); assert.equal(parent.calls[1].input, input);
    assert.equal(parent.calls[2].plan, plan); assert.equal(parent.calls[3].plan, plan); assert.equal(parent.calls[3].options, options);
    assert.equal(parent.calls[3].options.at, 1234567);
  }
});

test('VM unit: closed family routing rejects missing/coercible/prototype-key names', async () => {
  const f = fixture();
  for (const input of [undefined, null, {}, { parent_kind: 'procedure' }, { parent_kind: '__proto__' }, { parent_kind: ['request'] }]) {
    assert.throws(() => f.captured.ports.read(f.tx, input), e => e.code === 'invalid-argument');
    await rejectCode(() => f.captured.ports.prepare(f.tx, input), 'invalid-argument');
  }
  assert.deepEqual(f.request.calls, []); assert.deepEqual(f.document.calls, []);
});

test('VM unit: unknown, cloned and other-instance plans are rejected before parent dispatch', async () => {
  const f = fixture(), g = fixture(), plan = await f.captured.ports.prepare(f.tx, { parent_kind: 'request' });
  const foreign = await g.captured.ports.prepare(g.tx, { parent_kind: 'request' });
  for (const value of [null, undefined, false, 'request', {}, Object.freeze({ ...plan }), foreign]) {
    await rejectCode(() => f.captured.ports.recheck(f.tx, value), 'failed-precondition');
    assert.throws(() => f.captured.ports.commit(f.tx, value, { at: 1 }), e => e.code === 'failed-precondition');
  }
  assert.deepEqual(f.request.calls.map(c => c.method), ['prepare']);
});

test('VM unit: reject non-opaque prepare results and a handle returned ambiguously by both families', async () => {
  for (const value of [null, undefined, false, 1, 'handle', {}, () => {}]) {
    const f = fixture(); f.request.ports.prepare = async () => value;
    await rejectCode(() => f.captured.ports.prepare(f.tx, { parent_kind: 'request' }), 'failed-precondition');
  }
  const f = fixture(), shared = Object.freeze({ synthetic: 'ambiguous' });
  f.request.ports.prepare = f.document.ports.prepare = async () => shared;
  assert.equal(await f.captured.ports.prepare(f.tx, { parent_kind: 'request' }), shared);
  await rejectCode(() => f.captured.ports.prepare(f.tx, { parent_kind: 'document' }), 'failed-precondition');
  assert.equal(f.captured.ports.commit(f.tx, shared, { at: 1 }), f.request.returns.commit);
});

test('VM unit: delegation preserves parent rejection identity and synchronous commit', async () => {
  const f = fixture(), failure = new HttpsError('aborted', 'synthetic parent rejection');
  f.request.ports.read = () => { throw failure; };
  assert.throws(() => f.captured.ports.read(f.tx, { parent_kind: 'request' }), e => e === failure);
  f.request.ports.prepare = async () => { throw failure; };
  await assert.rejects(() => f.captured.ports.prepare(f.tx, { parent_kind: 'request' }), e => e === failure);
  const plan = await f.captured.ports.prepare(f.tx, { parent_kind: 'document' });
  f.document.ports.recheck = async () => { throw failure; };
  await assert.rejects(() => f.captured.ports.recheck(f.tx, plan), e => e === failure);
  f.document.ports.commit = () => { throw failure; };
  assert.throws(() => f.captured.ports.commit(f.tx, plan, { at: 1 }), e => e === failure);
});

test('Actual pure identity: signed station/member context and profile-free boolean super are preserved', async () => {
  const f = fixture();
  for (const role of actualIdentity.MEMBER_ROLES) assert.equal(f.captured.session.context(f.req({ role })).role, role);
  for (const token of [{ role: 'super_admin' }, { role: 'district_commander' }, { role: 'unknown', super: 'true' }]) {
    assert.throws(() => f.captured.session.context(f.req(token)), e => e.code === 'permission-denied');
  }
  assert.throws(() => f.captured.session.context({}), e => e.code === 'unauthenticated');
  assert.throws(() => f.captured.session.context(f.req({ stationId: undefined })), e => e.code === 'failed-precondition');
  const g = fixture({ claims: { stationId: SID, super: true, role: 'non_authoritative_raw_role' }, profile: null });
  assert.deepEqual(g.ctx, { uid: UID, sid: SID, role: 'super_admin', super: true });
  const live = await g.live(); assert.equal(live.role, 'super_admin');
  assert.deepEqual(g.events, [['auth', UID]], 'signed super still needs fresh Auth but no local profile');
});

test('Session: Auth is fresh per invocation and profile read uses the exact supplied transaction', async () => {
  const f = fixture();
  const result = await f.live(); assert.equal(result.uid, UID); assert.equal(result.role, 'hr_coordinator');
  assert.deepEqual(f.events, [['auth', UID], ['profile', 'stations/' + SID + '/users/' + UID]]);
  f.state.record.disabled = true;
  await rejectCode(() => f.live(), 'permission-denied');
  assert.deepEqual(f.events.slice(2), [['auth', UID]], 'second/replay-like gate does not reuse authorization');
  assert.deepEqual(f.storageCalls, []);
});

test('Session: invalid or overflowing auth_time rejects before Auth and profile access', async () => {
  for (const authTime of [undefined, null, '1700000000', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(); await rejectCode(() => f.captured.session.assertLive(f.tx, f.ctx, authTime), 'unauthenticated');
    assert.deepEqual(f.events, []); assert.deepEqual(f.storageCalls, []);
  }
});

test('Session: missing account is denied; network failures are unavailable and private diagnostics do not escape', async () => {
  for (const [code, expected] of [['auth/user-not-found', 'permission-denied'], ['auth/internal-error', 'unavailable'], ['ECONNRESET', 'unavailable']]) {
    const f = fixture(); f.state.record = Object.assign(new Error(PRIVATE_MARKER), { code });
    await assert.rejects(() => f.live(), error => error.code === expected && !String(error).includes(PRIVATE_MARKER));
    assert.deepEqual(f.events, [['auth', UID]]); assert.deepEqual(f.storageCalls, []);
  }
});

test('Session: account UID, disabled, claims type, station, role and super changes all fail closed', async () => {
  const mutations = [f => { f.state.record = null; }, f => { f.state.record.uid = 'someone_else'; }, f => { f.state.record.disabled = true; },
    f => { delete f.state.record.customClaims; }, f => { f.state.record.customClaims = null; }, f => { f.state.record.customClaims = []; },
    f => { f.state.record.customClaims = new Date(); }, f => { f.state.record.customClaims.stationId = 'another_station'; },
    f => { f.state.record.customClaims.role = 'firefighter'; }, f => { f.state.record.customClaims.super = true; }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); await rejectCode(() => f.live(), 'permission-denied');
    assert.deepEqual(f.events, [['auth', UID]]); assert.deepEqual(f.storageCalls, []);
  }
  for (const replacement of [false, undefined, 'true']) {
    const f = fixture({ claims: { stationId: SID, super: true }, profile: null }); f.state.record.customClaims.super = replacement;
    await rejectCode(() => f.live(), 'permission-denied'); assert.deepEqual(f.events, [['auth', UID]]);
  }
});

test('Session: only absent validity marker is optional; explicit malformed markers fail unavailable', async () => {
  for (const value of [null, '', 'not-a-date', 0, {}, []]) {
    const f = fixture(); f.state.record.tokensValidAfterTime = value;
    await rejectCode(() => f.live(), 'unavailable'); assert.deepEqual(f.events, [['auth', UID]]);
  }
  const f = fixture(); delete f.state.record.tokensValidAfterTime;
  assert.equal((await f.live()).uid, UID); assert.equal(f.events.length, 2);
});

test('Session: revocation uses strict earlier-than comparison; equality and a later login remain valid', async () => {
  const f = fixture(); f.state.record.tokensValidAfterTime = new Date((AUTH_TIME + 10) * 1000).toUTCString();
  await rejectCode(() => f.live(AUTH_TIME + 9), 'permission-denied');
  assert.equal((await f.live(AUTH_TIME + 10)).uid, UID);
  assert.equal((await f.live(AUTH_TIME + 11)).uid, UID);
  assert.equal(f.events.filter(e => e[0] === 'auth').length, 3);
  assert.equal(f.events.filter(e => e[0] === 'profile').length, 2);
});

test('Session: actual local-profile gate rejects missing, inactive, moved, contradictory and mismatched-role records', async () => {
  for (const profile of [null, { stationId: SID, role: 'hr_coordinator', active: false }, { stationId: SID, role: 'hr_coordinator', is_active: false },
    { stationId: 'elsewhere', role: 'hr_coordinator' }, { stationId: SID, station_id: 'elsewhere', role: 'hr_coordinator' }, { stationId: SID, role: 'firefighter' }]) {
    const f = fixture({ profile }); await rejectCode(() => f.live(), 'permission-denied');
    assert.equal(f.events.filter(e => e[0] === 'profile').length, 1); assert.deepEqual(f.storageCalls, []);
  }
  const f = fixture(); await f.live(); f.state.profile.active = false;
  await rejectCode(() => f.live(), 'permission-denied'); assert.equal(f.events.filter(e => e[0] === 'profile').length, 2);
});

test('Session: profile I/O failure propagates rather than becoming an authorized or missing profile', async () => {
  const f = fixture(), failure = Object.assign(new Error('synthetic profile I/O'), { code: 'unavailable' });
  await assert.rejects(() => f.captured.session.assertLive({ get: async () => { throw failure; } }, f.ctx, AUTH_TIME), e => e === failure);
  assert.deepEqual(f.events, [['auth', UID]]); assert.deepEqual(f.storageCalls, []);
});

test.after(() => {
  assert.deepEqual(hashes(), beforeHashes, 'actual assembly, attachment and identity sources are unchanged');
  console.log(JSON.stringify({ suite: 'hr-attachment-service-whitebox-unit', source_hashes: beforeHashes,
    assembly_source: 'actual VM', identity: 'actual pure helper', parents_auth_firestore_storage: 'doubles',
    production_transport_and_storage_invariants: 'NOT_TESTED', sources_unchanged: true }));
});
