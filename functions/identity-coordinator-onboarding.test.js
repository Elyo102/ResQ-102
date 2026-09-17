'use strict';
// Coordinator seam tests with an authority adapter double. The real initial
// adapter/engine have separate tests; this suite proves ordering and recovery.
const assert = require('node:assert/strict');
const { createIdentityCoordinator, stableHash, registrationFingerprint } = require('./identity-coordinator');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const FV = { serverTimestamp: () => Date.now(), delete: () => ({ __delete: true }) };
const Timestamp = { fromMillis: value => value };
function setup({ protectedRequest = true, adapterMissing = false, unstamped = false } = {}) {
  const uid = 'member_1', requestId = 'request_20260915_001', opId = 'approve_test_1';
  const registryPath = 'onboarding_assignment_links/' + uid;
  const operationPath = 'identity_operations/' + uid;
  const requestPath = 'registration_requests/' + uid;
  const store = new Map(), writes = [], events = [], hooks = {}, control = {};
  let ids = 0;
  const snap = ref => ({ ref, exists: store.has(ref.path), data: () => clone(store.get(ref.path)) });
  const db = { doc: path => ({ path, get: async () => snap({ path }) }),
    collection: path => ({ doc: id => db.doc(path + '/' + (id || 'id' + ++ids)) }),
    async runTransaction(fn) {
      const pending = [];
      const tx = { get: async ref => { assert.equal(pending.length, 0, 'Firestore reads must precede writes'); return snap(ref); },
        set: (ref, value, opts) => pending.push(['set', ref.path, clone(value), opts]),
        delete: ref => pending.push(['delete', ref.path]) };
      const result = await fn(tx);
      if (control.abortCommit && pending.length) throw new Error('commit aborted');
      for (const [type, path, value, opts] of pending) {
        writes.push(path);
        if (type === 'delete') { store.delete(path); continue; }
        const next = opts?.merge ? { ...store.get(path), ...value } : value;
        for (const key of Object.keys(next)) if (next[key]?.__delete) delete next[key];
        store.set(path, next);
      }
      return result;
    } };
  const live = { uid, email: 'member@example.test', disabled: false, emailVerified: true, customClaims: {} };
  const auth = { setCalls: 0, revokeCalls: 0,
    async getUser() { return clone(live); },
    async setCustomUserClaims(target, claims) { assert.equal(target, uid); this.setCalls++; live.customClaims = clone(claims || {}); },
    async revokeRefreshTokens() { this.revokeCalls++; } };
  const request = { request_id: requestId, full_name: 'Test Member', email: live.email, phone: '0500000000',
    districtId: 'south', stationId: 'station_1', shift: 'A', status: 'pending', created_at: 12345 };
  if (!unstamped) Object.assign(request, { server_generation: 'generation_1', request_fingerprint: registrationFingerprint(uid, request) });
  store.set(requestPath, request);
  if (protectedRequest) store.set(registryPath, { valid: true, stage: 'request_created' });
  const authority = { assignment: { role: 'firefighter', stationId: 'station_1', districtId: 'south', shift: 'A' },
    source: { uid, request_id: requestId, invite_id: 'invite_1' }, fingerprint: stableHash('protected-test-source') };
  const adapter = {
    async classify(tx, { registry, existingOp }) {
      events.push('classify');
      if (!registry?.valid) throw new Error('invalid registry');
      if (existingOp && Object.hasOwn(existingOp, 'onboarding_authority')) return 'protected_existing';
      return registry.stage === 'assignment_completed' ? 'legacy' : 'new_onboarding';
    },
    async readInitial(tx, { request: r, authUser, actor }) {
      events.push('initial');
      assert.equal(actor.uid, 'super_1');
      if (control.invalid || control.actorRevoked || !r || r.request_id !== requestId || r.stationId !== 'station_1' || authUser.disabled) throw new Error('initial invalid');
      return clone(authority);
    },
    async validatePhase(tx, { operation, phase, actor }) {
      events.push(phase);
      if (control.invalid || control.invalidPhase === phase || !operation.onboarding_authority
          || operation.onboarding_authority.fingerprint !== authority.fingerprint) throw new Error('phase invalid');
      if (control.expectedActor) assert.equal(actor.uid, control.expectedActor);
    },
    async commitApproval(tx, { operation, authority: checked, actor }) {
      events.push('commit');
      assert.deepEqual(checked, authority);
      tx.set(db.doc('invitations/invite_1'), { approved_by: actor.uid, approved_at: 1,
        approved_identity_operation_id: operation.op_id, source_hash: checked.fingerprint });
      if (control.failCommit) throw new Error('approval commit invalid');
    },
    async finalize(tx, { operation, actor }) {
      events.push('finalize-write');
      assert.equal(actor.uid, control.expectedActor || 'super_1');
      tx.set(db.doc(registryPath), { valid: true, stage: 'assignment_completed', identity_op_id: operation.op_id });
    }
  };
  const params = { uid, opId, kind: 'approve', actorUid: 'super_1', actorEmail: 'super@example.test',
    previousClaims: {}, requireRequest: true, attachPendingRequest: false,
    requestId, requestGeneration: 'generation_1', blockIfAssigned: true,
    intentFingerprint: stableHash('intent'), employeeMode: 'fixed', wantedEmp: '601', employeeStart: 1,
    auditAction: 'approve_registration', auditDetails: {},
    makePlan(emp, r, checked) {
      events.push('plan');
      const assignment = checked ? checked.assignment : { role: 'firefighter', stationId: r.stationId, districtId: r.districtId, shift: r.shift };
      return { desiredClaims: { ...assignment, emp }, desiredProfile: { ...assignment,
        full_name: r.full_name, email: r.email, phone: r.phone, name_prefixes: [] } };
    } };
  const coordinator = createIdentityCoordinator({ db, auth, FieldValue: FV, Timestamp, HttpsError,
    randomId: () => 'random_' + ++ids, hooks, ...(adapterMissing ? {} : { onboardingAuthority: adapter }) });
  const acquire = () => coordinator.acquireAssignment(params);
  const run = () => coordinator.runAssignment(uid, opId, { ok: true }, false, { uid: control.expectedActor || 'super_1' });
  return { uid, opId, params, coordinator, acquire, run, store, writes, events, control, hooks, auth, live,
    registryPath, operationPath, requestPath, authority };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const denied = fn => assert.rejects(fn, error => error.onboardingAuthority === true);
(async () => {
  await test('prepared decision and identity operation commit together then complete existing engine phases', async () => {
    const f = setup(); const first = await f.acquire();
    assert.equal(first.type, 'acquired'); assert.deepEqual(first.operation.onboarding_authority, f.authority);
    assert.equal(f.store.get('invitations/invite_1').approved_identity_operation_id, f.opId);
    assert(f.events.indexOf('initial') < f.events.indexOf('plan'));
    assert.deepEqual(await f.run(), { ok: true }); assert.equal(f.auth.setCalls, 1);
    assert.equal(f.auth.revokeCalls, 1); assert.equal(f.store.has(f.requestPath), false);
    const done = f.store.get(f.operationPath);
    assert.equal(done.status, 'completed'); assert.deepEqual(done.onboarding_authority, f.authority);
    assert.equal(done.actor_uid, 'super_1'); assert.equal(done.request_id, f.params.requestId);
    assert.equal(f.store.get(f.registryPath).stage, 'assignment_completed');
    assert.equal(f.events.includes('auth-write'), true); assert.equal(f.events.includes('finalize-write'), true);
  });
  await test('completed retry works after request deletion without another Auth write', async () => {
    const f = setup(); await f.acquire(); await f.run();
    assert.equal((await f.acquire()).type, 'completed'); assert.deepEqual(await f.run(), { ok: true });
    assert.equal(f.auth.setCalls, 1);
    const done = f.store.get(f.operationPath);
    assert.equal((await f.coordinator.resumeOperation({ uid: f.uid, opId: f.opId,
      planFingerprint: done.plan_fingerprint, actorUid: 'super_2' })).type, 'completed');
  });
  await test('authority errors cannot be converted to success from completed receipts', async () => {
    const f = setup(); await f.acquire(); await f.run(); f.control.invalid = true;
    await denied(f.acquire); await denied(f.run);
    await denied(() => f.coordinator.resumeOperation({ uid: f.uid, opId: f.opId, planFingerprint: f.store.get(f.operationPath).plan_fingerprint }));
  });
  await test('missing adapter plus protected registry refuses before legacy request stamping', async () => {
    const f = setup({ adapterMissing: true, unstamped: true }); await denied(f.acquire); assert.equal(f.writes.length, 0);
  });
  await test('invalid protected request refuses before stamping writes', async () => {
    const f = setup({ unstamped: true }); f.store.get(f.requestPath).stationId = 'other';
    await denied(f.acquire); assert.equal(f.writes.length, 0);
  });
  await test('valid protected old request is validated then stamped, not approved', async () => {
    const f = setup({ unstamped: true }); assert.equal((await f.acquire()).type, 'request_stamped');
    assert.deepEqual(f.writes, [f.requestPath]); assert.equal(f.store.has('invitations/invite_1'), false);
  });
  await test('fresh initial actor rejection prevents legacy stamping', async () => {
    const f = setup({ unstamped: true }); f.control.actorRevoked = true;
    await denied(f.acquire); assert.equal(f.writes.length, 0);
  });
  await test('pending invite cannot be consumed by alternate role assignment even with deleted request', async () => {
    const f = setup(); f.params.kind = 'set_role'; f.params.requireRequest = false; f.store.delete(f.requestPath);
    await denied(f.acquire); assert.equal(f.writes.length, 0);
  });
  await test('prepared transaction failure leaves neither approval marker nor identity reservation', async () => {
    const f = setup(); f.control.failCommit = true; await denied(f.acquire);
    assert.equal(f.store.has(f.operationPath), false); assert.equal(f.store.has('invitations/invite_1'), false);
    assert.equal(f.writes.length, 0);
  });
  await test('repeated acquire validates protected source before resumed shortcut', async () => {
    const f = setup(); await f.acquire(); f.control.invalid = true; await denied(f.acquire);
  });
  await test('invalidation injected immediately before Auth SDK call cannot grant or be swallowed', async () => {
    const f = setup(); await f.acquire(); f.hooks.beforeAuthSet = async () => { f.control.invalid = true; };
    await denied(f.run); assert.equal(f.auth.setCalls, 0);
    assert.equal(f.store.get(f.operationPath).status, 'needs_recovery');
  });
  await test('finalize invalidation preserves request and does not complete onboarding', async () => {
    const f = setup(); await f.acquire(); f.hooks.beforeFinalize = async () => { f.control.invalid = true; };
    await denied(f.run); assert.equal(f.store.has(f.requestPath), true);
    assert.equal(f.store.get(f.registryPath).stage, 'request_created');
  });
  await test('invalidation after Auth write stops phase advance and token revocation', async () => {
    const f = setup(); await f.acquire(); f.hooks.afterAuthSet = async () => { f.control.invalid = true; };
    await denied(f.run); assert.equal(f.auth.setCalls, 1); assert.equal(f.auth.revokeCalls, 0);
    assert.equal(f.store.get(f.operationPath).phase, 'profile_applied');
    assert.equal(f.store.has(f.requestPath), true);
  });
  await test('ordinary error concurrent with completed receipt still validates authority', async () => {
    const f = setup(); await f.acquire();
    f.hooks.beforeProfile = async () => {
      Object.assign(f.store.get(f.operationPath), { status: 'completed', result: { ok: true } });
      f.control.invalid = true; throw new Error('ordinary concurrent error');
    };
    await denied(f.run); assert.equal(f.auth.setCalls, 0);
  });
  await test('legacy missing operation retains not-found recovery API', async () => {
    const f = setup({ protectedRequest: false, adapterMissing: true });
    await assert.rejects(() => f.coordinator.resumeOperation({ uid: f.uid, opId: f.opId }),
      error => error.code === 'not-found' && !error.onboardingAuthority);
  });
  await test('recovery uses current actor while original approval actor remains durable', async () => {
    const f = setup(); await f.acquire(); f.hooks.beforeAuthSet = async () => { f.control.invalid = true; };
    await denied(f.run); delete f.hooks.beforeAuthSet; f.control.invalid = false; f.control.expectedActor = 'super_2';
    const op = f.store.get(f.operationPath);
    await f.coordinator.resumeOperation({ uid: f.uid, opId: f.opId, planFingerprint: op.plan_fingerprint, actorUid: 'super_2' });
    await f.run(); assert.equal(f.store.get(f.operationPath).actor_uid, 'super_1');
  });
  await test('removed or corrupt durable source does not regain legacy access', async () => {
    const f = setup(); await f.acquire(); f.store.get(f.operationPath).onboarding_authority = null;
    await denied(f.run); assert.equal(f.auth.setCalls, 0);
  });
  await test('operation target corruption cannot redirect registry detection', async () => {
    const f = setup(); await f.acquire(); f.store.get(f.operationPath).target_uid = 'foreign';
    await denied(f.run); assert.equal(f.auth.setCalls, 0);
  });
  await test('legacy no-registry no-adapter assignment still completes', async () => {
    const f = setup({ protectedRequest: false, adapterMissing: true }); await f.acquire(); await f.run();
    assert.equal(f.auth.setCalls, 1); assert.equal(Object.hasOwn(f.store.get(f.operationPath), 'onboarding_authority'), false);
  });
  await test('proven completed registry permits later role assignment without copying old invitation', async () => {
    const f = setup(); await f.acquire(); await f.run();
    f.store.get(f.operationPath).fence_until = 0;
    Object.assign(f.params, { opId: 'role_change_2', kind: 'set_role', requireRequest: false,
      requestId: '', requestGeneration: '', previousClaims: f.live.customClaims,
      previousEmp: '601', previousStation: 'station_1', blockIfAssigned: false, intentFingerprint: stableHash('role-change') });
    f.params.makePlan = (emp, r, authority) => {
      assert.equal(authority, null);
      return { desiredClaims: { ...f.live.customClaims, role: 'commander' }, desiredProfile: {
        full_name: 'Test Member', email: f.live.email, phone: '0500000000', name_prefixes: [],
        role: 'commander', shift: 'A', stationId: 'station_1', districtId: 'south' } };
    };
    const next = await f.acquire(); assert.equal(next.type, 'acquired');
    assert.equal(Object.hasOwn(next.operation, 'onboarding_authority'), false);
  });
  console.log('Identity coordinator onboarding seams: ' + passed + ' PASS (adapter double; no network)');
})().catch(error => { console.error(error); process.exitCode = 1; });
