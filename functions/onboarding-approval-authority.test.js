'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const sdkRequire = require('node:module').createRequire(path.resolve(__dirname, './package.json'));
const { Firestore, Timestamp } = sdkRequire('firebase-admin/firestore');
const { createInvitations } = require('./invitations');
const contract = require('./invitation-onboarding-contract');
const { createOnboardingApprovalAuthority, OnboardingApprovalAuthorityError } = require('./onboarding-approval-authority');
const sdk = new Firestore({ projectId: 'demo-resq-onboarding-authority' });
const now = 1790000000000, uid = 'member_1', rid = 'request_20260915_001';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const engine = createInvitations({ clock: () => now, randomBytes: crypto.randomBytes,
  createHash: hash, timingSafeEqual: crypto.timingSafeEqual,
  assertMayAssign() {}, withinRoleSetterScope: () => true });
function fixture({ person = true, unboundEmail = false, decomposed = false } = {}) {
  const invite = { invite_id: 'invite_1', secret_hash: hash('test-secret'),
    station_id: 'station_1', district_id: 'south', role: 'firefighter', shift: 'A',
    full_name: decomposed ? '  Jose\u0301  ' : 'Test Member', phone: '0500000000',
    email: unboundEmail ? '' : 'member@example.test', issued_by: 'admin_1',
    issued_at: Timestamp.fromMillis(now - 1000), expires_at: Timestamp.fromMillis(now + 60000),
    max_uses: 1, ...(person ? { person_id: 'sp_person_0001' } : {}) };
  const auth = { uid, email: 'member@example.test', email_verified: true };
  const redeemed = engine.redeem(invite, 'test-secret', auth);
  const split = contract.splitRedemption({ source: 'server_document', invite, redeemed,
    recomputed_fingerprint: redeemed.invite_fingerprint, auth, request_id: rid });
  Object.assign(invite, { redeemed_by: uid, redeemed_request_id: rid, redeemed_at: Timestamp.fromMillis(now) });
  const registry = { schema_version: 1, uid, station_id: 'station_1', request_id: rid,
    invite_id: 'invite_1', operation_fingerprint: split.operation_fingerprint };
  const op = { ...registry, assignment_ref: { ...split.assignment_ref }, stage: 'request_created',
    created_at: Timestamp.fromMillis(now) };
  const request = { ...split.registration_request, created_at: Timestamp.fromMillis(now) };
  const registryPath = 'onboarding_assignment_links/' + uid;
  const opPath = 'stations/station_1/onboarding_operations/' + rid;
  const store = new Map([[registryPath, registry], [opPath, op], ['invitations/invite_1', invite]]);
  const reads = [];
  // Real SDK references validate all generated paths; no SDK network reads.
  const db = { doc: value => sdk.doc(value) };
  const tx = { async get(ref) { reads.push(ref.path); return { exists: store.has(ref.path), data: () => store.get(ref.path) }; },
    set() { throw new Error('reader attempted write'); }, delete() { throw new Error('reader attempted delete'); } };
  class AdminRecord { constructor() { Object.assign(this, { uid, email: auth.email, disabled: false, emailVerified: true }); } }
  const input = { uid, request, authUser: new AdminRecord(), existingOp: null };
  const reader = createOnboardingApprovalAuthority({ db, invitations: engine, contract });
  return { invite, registry, op, request, store, input, reads, registryPath, opPath,
    run: () => reader.readForApproval(tx, input) };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function denied(mutate, reason) {
  const f = fixture(); mutate(f);
  await assert.rejects(f.run, error => error instanceof OnboardingApprovalAuthorityError
    && error.code === 'failed-precondition' && (!reason || error.reason === reason));
}
(async () => {
  await test('actual engine and SDK records produce frozen read-only protected assignment', async () => {
    const f = fixture(), out = await f.run();
    assert.deepEqual(out.assignment, { stationId: 'station_1', districtId: 'south', role: 'firefighter', shift: 'A', person_id: 'sp_person_0001' });
    assert.deepEqual(f.reads.sort(), [f.registryPath, f.opPath, 'invitations/invite_1'].sort());
    assert(Object.isFrozen(out) && Object.isFrozen(out.source) && Object.isFrozen(out.assignment));
    assert.match(out.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(out).includes('secret'), false);
    assert.equal(JSON.stringify(out).includes('member@example.test'), false);
    assert.equal(JSON.stringify(out).includes('Test Member'), false);
    assert.deepEqual(await f.run(), out);
  });
  await test('legacy fallback requires absent protected registry', async () => {
    const f = fixture(); f.store.delete(f.registryPath); f.input.request = null;
    assert.equal(await f.run(), null); assert.deepEqual(f.reads, [f.registryPath]);
  });
  for (const existing of [null, {}, 'corrupt']) {
    await test('any own authority marker forbids initial approval and fallback: ' + JSON.stringify(existing), async () => {
      const f = fixture(); f.input.existingOp = { onboarding_authority: existing };
      await assert.rejects(f.run, /existing-authority/);
      f.store.delete(f.registryPath); await assert.rejects(f.run, /existing-authority/);
    });
  }
  for (const mutate of [f => delete f.input.existingOp, f => f.input.existingOp = [],
    f => f.input.existingOp = 'x', f => f.input.uid = '../other', f => f.input.uid = ' member_1']) {
    await test('invalid explicit input fails before protected lookup', () => denied(mutate, 'input'));
  }
  for (const mutate of [f => f.store.set(f.registryPath, null), f => f.registry.extra = 'x',
    f => delete f.registry.schema_version, f => f.registry.schema_version = 2,
    f => f.registry.uid = 'foreign', f => f.registry.station_id = '../escape',
    f => f.registry.request_id = 'bad/id', f => f.registry.invite_id = '../bad',
    f => f.registry.operation_fingerprint = 'invalid']) {
    await test('malformed registry fails closed', () => denied(mutate, 'registry'));
  }
  for (const mutate of [f => f.store.delete(f.opPath), f => f.store.delete('invitations/invite_1')]) {
    await test('missing protected linked record cannot become legacy', () => denied(mutate, 'linked-record-missing'));
  }
  for (const field of ['uid', 'station_id', 'request_id', 'invite_id', 'operation_fingerprint', 'stage']) {
    await test('operation binding rejects changed ' + field, () => denied(f => f.op[field] = 'changed', 'operation'));
  }
  for (const field of ['uid', 'station_id', 'district_id', 'invite_id', 'registration_request_id', 'invite_fingerprint', 'registration_fingerprint', 'person_id']) {
    await test('protected assignment rejects changed ' + field, () => denied(f => f.op.assignment_ref[field] = '../changed'));
  }
  await test('extra protected link fields denied', () => denied(f => f.op.assignment_ref.secret = 'never-copy', 'assignment-link'));
  for (const field of ['stationId', 'districtId', 'shift', 'request_id', 'full_name', 'email', 'phone', 'status']) {
    await test('request mutation rejected: ' + field, () => denied(f => f.request[field] = 'changed'));
  }
  await test('client role injected into request rejected', () => denied(f => f.request.role = 'commander'));
  await test('two matching fake operation hashes do not bypass recomputation', () => denied(f => {
    f.registry.operation_fingerprint = f.op.operation_fingerprint = 'a'.repeat(64);
  }, 'operation-fingerprint'));
  for (const mutate of [f => f.input.authUser.uid = 'foreign', f => f.input.authUser.disabled = true,
    f => delete f.input.authUser.disabled, f => f.input.authUser.emailVerified = false,
    f => f.input.authUser.email = 'changed@example.test']) {
    await test('fresh target identity invalidation rejected', () => denied(mutate, 'target-auth'));
  }
  await test('canonical verified email accepted', async () => {
    const f = fixture(); f.input.authUser.email = ' MEMBER@EXAMPLE.TEST '; assert(await f.run());
  });
  for (const mutate of [f => f.invite.invite_id = 'foreign', f => f.invite.redeemed_by = 'foreign',
    f => f.invite.redeemed_request_id = 'request_20260915_002']) {
    await test('invitation redemption binding changed', () => denied(mutate, 'invitation-binding'));
  }
  for (const field of ['role', 'station_id', 'district_id', 'shift', 'issued_by', 'secret_hash', 'email']) {
    await test('existing engine source fingerprint rejects changed ' + field, () => denied(f => f.invite[field] = 'changed'));
  }
  for (const field of ['revoked_at', 'approved_at']) {
    await test('existing engine approval policy rejects ' + field, () => denied(f => f.invite[field] = Timestamp.fromMillis(now)));
  }
  for (const mutate of [f => f.invite.full_name = 'Other', f => f.invite.phone = '000',
    f => f.invite.person_id = 'sp_person_0002', f => delete f.invite.person_id]) {
    await test('unhashed invitation profile changes cannot evade source check', () => denied(mutate, 'invitation-profile'));
  }
  await test('person omitted on both sides accepted, new person injection rejected', async () => {
    const f = fixture({ person: false }); assert.equal((await f.run()).assignment.person_id, undefined);
    f.invite.person_id = 'sp_person_0001'; await assert.rejects(f.run, /invitation-profile/);
  });
  await test('contract NFC and whitespace normalization preserved', async () => {
    assert(await fixture({ decomposed: true }).run());
  });
  await test('unbound invitation still requires current email to match original request', async () => {
    const f = fixture({ unboundEmail: true }); assert(await f.run());
    f.input.authUser.email = 'other@example.test'; await assert.rejects(f.run, /target-auth/);
  });
  await test('server stamping metadata does not change original protected request', async () => {
    const f = fixture(); Object.assign(f.request, { server_generation: 'server_generation',
      request_fingerprint: 'a'.repeat(64), updated_at: Timestamp.fromMillis(now + 1) });
    assert(await f.run());
  });
  await test('a fresh read detects authority invalidated since earlier validation', async () => {
    const f = fixture(); assert(await f.run()); f.invite.revoked_at = Timestamp.fromMillis(now);
    await assert.rejects(f.run, /invitation-invalid/);
  });
  console.log('Onboarding initial approval authority: ' + passed + ' PASS (actual engine; SDK paths; no network/writes)');
})().catch(error => { console.error(error); process.exitCode = 1; });
