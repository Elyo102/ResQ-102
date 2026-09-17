'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sdkRequire = require('node:module').createRequire(require('node:path').resolve(__dirname, './package.json'));
const { Firestore, Timestamp } = sdkRequire('firebase-admin/firestore');
const { createInvitations } = require('./invitations');
const contract = require('./invitation-onboarding-contract');
const { createInvitationOnboardingService } = require('./invitation-onboarding-service');
const sdk = new Firestore({ projectId: 'demo-resq-onboarding-shape' });
const time = 1790000000000;
const secret = 'test-secret-never-stored';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const engine = createInvitations({ clock: () => time, randomBytes: crypto.randomBytes,
  createHash: hash, timingSafeEqual: crypto.timingSafeEqual,
  assertMayAssign() {}, withinRoleSetterScope: () => true });
const uid = 'member_1';
const rid = 'request_20260915_001';
const request = () => ({ auth: { uid, email: 'member@example.test', email_verified: true },
  data: { invite_id: 'invite_1', secret, request_id: rid } });
function setup(authMode) {
  const store = new Map([['invitations/invite_1', { invite_id: 'invite_1', secret_hash: hash(secret),
    station_id: 'station_1', district_id: 'south', role: 'firefighter', shift: 'A',
    full_name: 'Test Member', phone: '0500000000', email: 'member@example.test',
    issued_by: 'admin', issued_at: Timestamp.fromMillis(time - 1000),
    expires_at: Timestamp.fromMillis(time + 60000), max_uses: 1, person_id: 'sp_person_0001' }]]);
  let writes = 0, authReads = 0, denyFresh = !!authMode, abortCommit = false;
  const db = { doc(path) { const ref = sdk.doc(path); return { path: ref.path,
    async get() { return snap(ref.path); } }; },
    async runTransaction(fn) {
      const pending = [];
      const out = await fn({ async get(ref) { return snap(ref.path); },
        set(ref, value, opts) { pending.push([ref.path, value, opts]); } });
      if (abortCommit) { assert.equal(pending.length, 4); throw new Error('simulated-commit-abort'); }
      for (const [path, value, opts] of pending) {
        store.set(path, opts?.merge ? { ...store.get(path), ...value } : value); writes++;
      }
      return out;
    } };
  function snap(path) { return { exists: store.has(path), data: () => store.get(path) }; }
  const service = createInvitationOnboardingService({ db, contract, invitations: engine,
    registration: { async assignmentState() { return { completed: false }; } },
    identityStore: { async linkState() { return { linked: false }; } },
    serverTimestamp: () => Timestamp.fromMillis(time),
    fail(status, message, code) { const e = new Error(message); e.code = code || status; throw e; },
    async requireAuth(req) {
      authReads++;
      if (denyFresh && authReads % 2 === 0) throw new Error('revoked-mid-operation');
      return { ...req.auth };
    }, async requireSuperAdmin(req) { return { ...req.auth }; } });
  return { store, service, writes: () => writes, revokeFresh: () => { denyFresh = true; },
    abortNextCommit: () => { abortCommit = true; } };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
(async () => {
  await test('issued fingerprint uses existing verifier and is not persisted in invitation', async () => {
    const issued = engine.issue({ auth: { uid: 'admin' }, cap: Infinity }, {
      station_id: 'station_1', district_id: 'south', role: 'commander', shift: 'A',
      full_name: 'First Admin', email: 'first@example.test', phone: '0500000000'
    });
    assert.match(issued.invite_fingerprint, /^[a-f0-9]{64}$/);
    engine.verifyStoredFingerprint(issued.doc, issued.invite_fingerprint);
    assert.equal(Object.hasOwn(issued.doc, 'invite_fingerprint'), false);
    assert.equal(JSON.stringify(issued.doc).includes(issued.secret), false);
    assert.throws(() => engine.verifyStoredFingerprint({ ...issued.doc, role: 'firefighter' }, issued.invite_fingerprint));
  });
  await test('real engine and SDK Timestamp: first redeem then exact replay has no writes', async () => {
    const s = setup();
    const first = await s.service.redeemInvitation(request());
    assert.equal(first.replayed, false); assert.equal(s.writes(), 4);
    assert(s.store.get('invitations/invite_1').redeemed_at instanceof Timestamp);
    assert.equal(s.store.get('stations/station_1/onboarding_operations/' + rid).assignment_ref.person_id, 'sp_person_0001');
    assert.equal(s.store.get('registration_requests/' + uid).person_id, undefined);
    const next = await s.service.redeemInvitation(request());
    assert.equal(next.replayed, true); assert.equal(next.permissions_granted, false); assert.equal(s.writes(), 4);
    assert.throws(() => engine.redeem(s.store.get('invitations/invite_1'), secret, request().auth), /invalid/);
  });
  for (const field of ['full_name', 'phone', 'person_id', 'role', 'station_id', 'expires_at']) {
    await test('changed immutable invitation ' + field + ' cannot replay', async () => {
      const s = setup(); await s.service.redeemInvitation(request());
      const invite = s.store.get('invitations/invite_1');
      invite[field] = field === 'expires_at' ? Timestamp.fromMillis(time - 1) : field === 'role' ? 'commander' : 'changed_value';
      await assert.rejects(() => s.service.redeemInvitation(request())); assert.equal(s.writes(), 4);
    });
  }
  for (const change of [r => r.data.secret = 'wrong', r => r.auth.uid = 'other_uid',
    r => r.data.request_id = 'request_20260915_002', r => r.data.person_id = 'forged',
    r => r.data.invite_id = '../escape', r => r.data.request_id = 'a/b']) {
    await test('untrusted changed caller input denied without writes', async () => {
      const s = setup(); await s.service.redeemInvitation(request()); const r = request(); change(r);
      await assert.rejects(() => s.service.redeemInvitation(r)); assert.equal(s.writes(), 4);
    });
  }
  await test('revoked invitation replay denied', async () => {
    const s = setup(); await s.service.redeemInvitation(request());
    s.store.get('invitations/invite_1').revoked_at = Timestamp.fromMillis(time);
    await assert.rejects(() => s.service.redeemInvitation(request())); assert.equal(s.writes(), 4);
  });
  await test('async fresh auth revoked before transaction writes prevents all writes', async () => {
    const s = setup(true); await assert.rejects(() => s.service.redeemInvitation(request()), /revoked-mid/);
    assert.equal(s.writes(), 0);
  });
  await test('async fresh auth revoked before replay return denies replay without writes', async () => {
    const s = setup(); await s.service.redeemInvitation(request()); s.revokeFresh();
    await assert.rejects(() => s.service.redeemInvitation(request()), /revoked-mid/); assert.equal(s.writes(), 4);
  });
  await test('stored assignment link tampering cannot hide behind original operation hash', async () => {
    const s = setup(); await s.service.redeemInvitation(request());
    const op = s.store.get('stations/station_1/onboarding_operations/' + rid);
    op.assignment_ref = { ...op.assignment_ref, person_id: 'other_person' };
    await assert.rejects(() => s.service.redeemInvitation(request())); assert.equal(s.writes(), 4);
  });
  await test('same request ID with altered registration cannot be overwritten', async () => {
    const s = setup(); await s.service.redeemInvitation(request());
    const pending = { ...s.store.get('registration_requests/' + uid), full_name: 'tampered' };
    const fresh = setup(); fresh.store.set('registration_requests/' + uid, pending);
    await assert.rejects(() => fresh.service.redeemInvitation(request())); assert.equal(fresh.writes(), 0);
    assert.equal(fresh.store.get('registration_requests/' + uid).full_name, 'tampered');
  });
  await test('registry is exact six-field server-only linkage', async () => {
    const s = setup(); await s.service.redeemInvitation(request());
    const link = s.store.get('onboarding_assignment_links/' + uid);
    assert.deepEqual(Object.keys(link).sort(), ['schema_version','uid','station_id','request_id','invite_id','operation_fingerprint'].sort());
    assert.equal(link.uid, uid); assert.equal(link.station_id, 'station_1'); assert.equal(link.request_id, rid);
    assert.equal(link.operation_fingerprint, s.store.get('stations/station_1/onboarding_operations/' + rid).operation_fingerprint);
  });
  for (const change of [s => s.store.delete('onboarding_assignment_links/' + uid),
    s => s.store.set('onboarding_assignment_links/' + uid, null),
    s => s.store.set('onboarding_assignment_links/' + uid, { ...s.store.get('onboarding_assignment_links/' + uid), extra: true }),
    ...['uid','station_id','request_id','invite_id','operation_fingerprint','schema_version'].map(key =>
      s => s.store.set('onboarding_assignment_links/' + uid, { ...s.store.get('onboarding_assignment_links/' + uid), [key]: 'changed' }))]) {
    await test('missing/corrupt/changed registry denies replay without backfill', async () => {
      const s = setup(); await s.service.redeemInvitation(request()); change(s);
      const before = s.store.get('onboarding_assignment_links/' + uid);
      await assert.rejects(() => s.service.redeemInvitation(request()), e => e.code === 'onboarding-registry-mismatch');
      assert.equal(s.writes(), 4); assert.equal(s.store.get('onboarding_assignment_links/' + uid), before);
    });
  }
  await test('initial matching orphan registry is preserved, not adopted', async () => {
    const done = setup(); await done.service.redeemInvitation(request());
    const fresh = setup(), orphan = done.store.get('onboarding_assignment_links/' + uid);
    fresh.store.set('onboarding_assignment_links/' + uid, orphan);
    await assert.rejects(() => fresh.service.redeemInvitation(request()), e => e.code === 'onboarding-registry-exists');
    assert.equal(fresh.writes(), 0); assert.equal(fresh.store.get('onboarding_assignment_links/' + uid), orphan);
  });
  await test('second invitation for same UID in another station cannot replace registry', async () => {
    const s = setup(); await s.service.redeemInvitation(request());
    const original = s.store.get('onboarding_assignment_links/' + uid);
    const other = { ...setup().store.get('invitations/invite_1'), invite_id: 'invite_2', station_id: 'station_2' };
    s.store.set('invitations/invite_2', other);
    const r = request(); r.data.invite_id = 'invite_2'; r.data.request_id = 'request_20260915_002';
    await assert.rejects(() => s.service.redeemInvitation(r), e => e.code === 'onboarding-registry-exists');
    assert.equal(s.writes(), 4); assert.equal(s.store.get('onboarding_assignment_links/' + uid), original);
    assert.equal(s.store.get('invitations/invite_2').redeemed_by, undefined);
  });
  await test('simulated abort after all four writes queued leaves no partial redemption', async () => {
    const s = setup(); s.abortNextCommit();
    await assert.rejects(() => s.service.redeemInvitation(request()), /simulated-commit-abort/);
    assert.equal(s.writes(), 0); assert.equal(s.store.size, 1);
    assert.equal(s.store.get('invitations/invite_1').redeemed_by, undefined);
  });
  await test('stored fingerprint matches Date/Timestamp roundtrip and spent source', async () => {
    const s = setup(), invite = s.store.get('invitations/invite_1');
    const expected = engine.redeem(invite, secret, request().auth).invite_fingerprint;
    assert.equal(engine.verifyStoredFingerprint(invite, expected), true);
    assert.equal(engine.verifyStoredFingerprint({ ...invite, issued_at: invite.issued_at.toDate(), expires_at: invite.expires_at.toDate() }, expected), true);
    await s.service.redeemInvitation(request());
    assert.equal(engine.verifyStoredFingerprint(s.store.get('invitations/invite_1'), expected), true);
  });
  for (const key of ['invite_id','secret_hash','station_id','district_id','role','shift','email','issued_by','issued_at','expires_at','max_uses']) {
    await test('stored fingerprint detects covered source change: ' + key, async () => {
      const invite = setup().store.get('invitations/invite_1');
      const expected = engine.redeem(invite, secret, request().auth).invite_fingerprint;
      const value = key.endsWith('_at') ? Timestamp.fromMillis(time + 1234) : key === 'max_uses' ? 2 : 'changed';
      assert.throws(() => engine.verifyStoredFingerprint({ ...invite, [key]: value }, expected), e => e.code === 'invalid-invitation');
    });
  }
  await test('stored fingerprint rejects malformed digest and non-document sources', async () => {
    const invite = setup().store.get('invitations/invite_1');
    const expected = engine.redeem(invite, secret, request().auth).invite_fingerprint;
    for (const bad of [null, undefined, '', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), expected.toUpperCase(), '0'.repeat(64), {}]) {
      assert.throws(() => engine.verifyStoredFingerprint(invite, bad), e => e.code === 'invalid-invitation');
    }
    for (const bad of [null, undefined, [], new Date(), Timestamp.fromMillis(time), 'invite']) {
      assert.throws(() => engine.verifyStoredFingerprint(bad, expected), e => e.code === 'invalid-invitation');
    }
  });
  await test('stored fingerprint is explicitly not a substitute for full onboarding integrity', async () => {
    const invite = setup().store.get('invitations/invite_1');
    const expected = engine.redeem(invite, secret, request().auth).invite_fingerprint;
    assert.equal(engine.verifyStoredFingerprint({ ...invite, full_name: 'Changed', phone: 'changed', person_id: 'sp_changed_0001' }, expected), true);
    // Full onboarding replay tests above independently reject these changes.
  });
  console.log(passed + ' engine integration tests passed (SDK path validation + fake transaction; no network)');
})().catch(e => { console.error(e); process.exitCode = 1; });
