'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to use a real project.');
  process.exit(2);
}

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId:process.env.GCLOUD_PROJECT || 'demo-resq' });
}
const db = admin.firestore();
const invitations = require('./invitations');

const COLLECTION = 'invitation_integration';
const EMAIL = 'new.user@example.com';
const gate = { auth:{ uid:'issuer-super' }, cap:Infinity, sid:'', did:'' };
const api = invitations.createInvitations({
  clock: function () { return Date.now(); },
  randomBytes: function (size) { return crypto.randomBytes(size); },
  createHash: function (value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
  },
  timingSafeEqual: crypto.timingSafeEqual,
  assertMayAssign: function () { return true; },
  withinRoleSetterScope: function () { return true; }
});

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('✓ ' + name);
}

function verified(uid) {
  return { uid:uid, email:EMAIL, email_verified:true };
}

async function seedInvite(overrides) {
  const issued = api.issue(gate, Object.assign({
    station_id:'test_station',
    district_id:'test_district',
    role:'firefighter',
    shift:'A',
    full_name:'Integration Test User',
    email:EMAIL,
    phone:''
  }, overrides || {}));
  await db.collection(COLLECTION).doc(issued.invite_id).set(issued.doc);
  return issued;
}

async function buildPlan(issued, uid, secret) {
  const ref = db.collection(COLLECTION).doc(issued.invite_id);
  const before = await ref.get();
  assert.equal(before.exists, true);
  return api.redeem(before.data(), secret === undefined ? issued.secret : secret,
    verified(uid), {});
}

async function commitPlan(inviteId, plan) {
  const ref = db.collection(COLLECTION).doc(inviteId);
  return db.runTransaction(async function (tx) {
    const fresh = await tx.get(ref);
    if (!fresh.exists) throw new Error('invitation missing');
    const update = api.verifyPlan(fresh.data(), plan);
    tx.update(ref, update);
    return plan.request;
  });
}

async function commitRevocation(inviteId) {
  const ref = db.collection(COLLECTION).doc(inviteId);
  return db.runTransaction(async function (tx) {
    const fresh = await tx.get(ref);
    if (!fresh.exists) throw new Error('invitation missing');
    const update = api.revoke(gate, fresh.data());
    tx.update(ref, update);
  });
}

async function commitApproval(inviteId, uid) {
  const ref = db.collection(COLLECTION).doc(inviteId);
  return db.runTransaction(async function (tx) {
    const fresh = await tx.get(ref);
    if (!fresh.exists) throw new Error('invitation missing');
    const approval = api.approve(gate, fresh.data(), {
      uid:uid, email:EMAIL
    });
    tx.update(ref, approval.update);
    return approval.assignment;
  });
}

function resultCounts(results) {
  return {
    fulfilled: results.filter(function (r) { return r.status === 'fulfilled'; }).length,
    rejected: results.filter(function (r) { return r.status === 'rejected'; }).length
  };
}

(async function run() {
  await test('two prevalidated redemptions race and exactly one commits', async function () {
    const issued = await seedInvite();
    const first = await buildPlan(issued, 'user-a');
    const second = await buildPlan(issued, 'user-b');
    const counts = resultCounts(await Promise.allSettled([
      commitPlan(issued.invite_id, first),
      commitPlan(issued.invite_id, second)
    ]));
    assert.deepEqual(counts, { fulfilled:1, rejected:1 });
    const after = (await db.collection(COLLECTION).doc(issued.invite_id).get()).data();
    assert.ok(after.redeemed_by === 'user-a' || after.redeemed_by === 'user-b');
    assert.equal(after.revoked_at, null);
  });

  await test('ten prevalidated redemptions still produce one winner', async function () {
    const issued = await seedInvite();
    const plans = await Promise.all(Array.from({ length:10 }, function (_, index) {
      return buildPlan(issued, 'user-' + index);
    }));
    const counts = resultCounts(await Promise.allSettled(plans.map(function (plan) {
      return commitPlan(issued.invite_id, plan);
    })));
    assert.deepEqual(counts, { fulfilled:1, rejected:9 });
  });

  await test('redemption and revocation race accepts both legal serializations', async function () {
    const issued = await seedInvite();
    const plan = await buildPlan(issued, 'race-user');
    const results = await Promise.allSettled([
      commitPlan(issued.invite_id, plan),
      commitRevocation(issued.invite_id)
    ]);
    const redemption = results[0];
    const revocation = results[1];
    const counts = resultCounts(results);
    assert.equal(revocation.status, 'fulfilled');
    const after = (await db.collection(COLLECTION).doc(issued.invite_id).get()).data();
    assert.ok(after.revoked_at);
    assert.equal(after.approved_at, null);
    assert.equal(after.approved_by, null);
    if (redemption.status === 'fulfilled') {
      assert.deepEqual(counts, { fulfilled:2, rejected:0 });
      assert.equal(after.redeemed_by, 'race-user');
      assert.ok(after.redeemed_at);
    } else {
      assert.deepEqual(counts, { fulfilled:1, rejected:1 });
      assert.equal(after.redeemed_by, null);
      assert.equal(after.redeemed_at, null);
    }
    await assert.rejects(commitApproval(issued.invite_id, 'race-user'));
  });

  await test('a redeemed invitation can be revoked and then cannot be approved', async function () {
    const issued = await seedInvite();
    const plan = await buildPlan(issued, 'revoked-user');
    await commitPlan(issued.invite_id, plan);
    await commitRevocation(issued.invite_id);
    await assert.rejects(commitApproval(issued.invite_id, 'revoked-user'));
    const after = (await db.collection(COLLECTION).doc(issued.invite_id).get()).data();
    assert.ok(after.revoked_at);
    assert.equal(after.approved_at, null);
  });

  await test('an approved invitation cannot be revoked', async function () {
    const issued = await seedInvite();
    const plan = await buildPlan(issued, 'approved-user');
    await commitPlan(issued.invite_id, plan);
    await commitApproval(issued.invite_id, 'approved-user');
    await assert.rejects(commitRevocation(issued.invite_id));
    const after = (await db.collection(COLLECTION).doc(issued.invite_id).get()).data();
    assert.ok(after.approved_at);
    assert.equal(after.revoked_at, null);
  });

  await test('approval and revocation race and exactly one commits', async function () {
    const issued = await seedInvite();
    const plan = await buildPlan(issued, 'approval-race-user');
    await commitPlan(issued.invite_id, plan);
    const counts = resultCounts(await Promise.allSettled([
      commitApproval(issued.invite_id, 'approval-race-user'),
      commitRevocation(issued.invite_id)
    ]));
    assert.deepEqual(counts, { fulfilled:1, rejected:1 });
    const after = (await db.collection(COLLECTION).doc(issued.invite_id).get()).data();
    assert.equal(Boolean(after.approved_at) === Boolean(after.revoked_at), false,
      'an invitation must be approved or revoked, never both');
  });

  await test('expiry after prevalidation is rechecked inside the transaction', async function () {
    const issued = await seedInvite();
    const plan = await buildPlan(issued, 'slow-user');
    const ref = db.collection(COLLECTION).doc(issued.invite_id);
    await ref.update({ expires_at:new Date(Date.now() - 1000) });
    await assert.rejects(commitPlan(issued.invite_id, plan));
    const after = (await ref.get()).data();
    assert.equal(after.redeemed_by, null);
  });

  await test('the plaintext secret never reaches Firestore', async function () {
    const issued = await seedInvite();
    const stored = (await db.collection(COLLECTION).doc(issued.invite_id).get()).data();
    assert.equal(JSON.stringify(stored).includes(issued.secret), false);
    assert.match(String(stored.secret_hash), /^[a-f0-9]{64}$/);
  });

  await test('a wrong secret cannot produce a redemption plan', async function () {
    const issued = await seedInvite();
    await assert.rejects(buildPlan(issued, 'wrong-secret-user', 'wrong-secret'));
    const stored = (await db.collection(COLLECTION).doc(issued.invite_id).get()).data();
    assert.equal(stored.redeemed_by, null);
  });

  await test('a missing invitation is rejected and never created', async function () {
    const ghost = db.collection(COLLECTION).doc('missing-invitation');
    const snap = await ghost.get();
    assert.equal(snap.exists, false);
    await assert.rejects(db.runTransaction(async function (tx) {
      const fresh = await tx.get(ghost);
      if (!fresh.exists) throw new Error('invitation missing');
      tx.update(ghost, { redeemed_by:'ghost' });
    }));
    assert.equal((await ghost.get()).exists, false);
  });

  assert.equal(passed, 10);
  console.log('\n10 invitation Firestore integration checks passed.');
  process.exit(0);
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
