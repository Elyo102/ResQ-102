'use strict';

// Run only through:
// firebase emulators:exec --only firestore --project demo-resq
//   "cd functions && node callout-delivery.integration.test.js"
//
// This executes the real sendCallout callable through its .run() hook. Firestore
// transactions and Timestamp values are provided by the emulator; only the FCM
// transport is replaced so the test cannot contact or notify a real device.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to run against a real project.');
  process.exit(2);
}

const scenarios = [
  'no-token-document',
  'empty-token-list',
  'all-tokens-dead',
  'partial-retry',
  'live-retry-after-trial-cutover',
  'trial-retry-after-live-cutover',
  'closed-before-retry',
  'trial-missing-control',
  'trial-not-allowlisted',
  'trial-email-allowlisted',
  'trial-isolated',
  'runtime-missing-fails-closed',
  'runtime-invalid-fails-closed',
  'runtime-read-failure-after-lease',
  'auth-disabled-initial',
  'auth-demoted-initial',
  'profile-inactive-initial',
  'auth-demoted-after-lease',
  'profile-inactive-after-lease',
  'personal-control-revoked-after-lease',
  'trial-allow-revoked-after-actor',
  'close-demoted'
];

if (!process.argv.includes('--scenario')) {
  const source = fs.readFileSync(require.resolve('./index'), 'utf8');
  assert.match(source, /const CALLOUT_OPTIONS = Object\.freeze\(\{[\s\S]*?enforceAppCheck:true[\s\S]*?\}\);/,
    'callout callable options enforce App Check');
  assert.match(source, /exports\.sendCallout = onCall\(\s*CALLOUT_OPTIONS,/,
    'sendCallout uses the enforced options');
  assert.match(source, /exports\.closeCallout = onCall\(CALLOUT_OPTIONS,/,
    'closeCallout uses the enforced options');
  const runId = crypto.randomBytes(6).toString('hex');
  for (const scenario of scenarios) {
    const child = spawnSync(process.execPath, [__filename, '--scenario', scenario], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { RESQ_CALLOUT_TEST_RUN_ID:runId }),
      encoding: 'utf8'
    });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.equal(child.status, 0, 'scenario failed: ' + scenario);
  }
  console.log('Callout delivery integration PASS ' + scenarios.length + '/' + scenarios.length);
  process.exit(0);
}

const scenario = process.argv[process.argv.indexOf('--scenario') + 1];
assert.ok(scenarios.includes(scenario), 'unknown scenario');

const functions = require('./index');
const admin = require('firebase-admin');
const db = admin.firestore();
const SID = 'callout_delivery_' + String(process.env.RESQ_CALLOUT_TEST_RUN_ID || 'single')
  + '_' + scenario.replace(/[^a-z0-9]+/g, '_');
const sender = 'sender_' + scenario.replace(/[^a-z0-9]+/g, '_');
const sentTokenGroups = [];
const sentPayloads = [];
let authReads = 0;

admin.auth().getUser = async uid => {
  authReads += 1;
  if (scenario === 'trial-allow-revoked-after-actor' && authReads === 2) {
    await db.doc('config/runtime').set({ silent:true, silent_allow:[] });
  }
  const disabled = scenario === 'auth-disabled-initial';
  const demoted = scenario === 'auth-demoted-initial'
    || (scenario === 'auth-demoted-after-lease' && authReads >= 2)
    || (scenario === 'close-demoted' && authReads >= 3);
  if (scenario === 'profile-inactive-after-lease' && authReads === 2) {
    await db.doc(`stations/${SID}/users/${sender}`).set({ is_active:false }, { merge:true });
  }
  return {
    uid, email:uid + '@example.com', disabled,
    customClaims:{ stationId:SID, role:demoted ? 'firefighter' : 'commander', shift:'A',
      personal_lab_control:scenario !== 'trial-missing-control' &&
        !(scenario === 'personal-control-revoked-after-lease' && authReads >= 2) }
  };
};

admin.messaging().sendEachForMulticast = async payload => {
  sentPayloads.push(JSON.parse(JSON.stringify(payload)));
  sentTokenGroups.push(payload.tokens.slice());
  return {
    responses: payload.tokens.map(token => {
      if (token.includes('dead')) {
        return { success: false, error: { code: 'messaging/registration-token-not-registered' } };
      }
      if (token.includes('transient') && sentTokenGroups.filter(x => x.includes(token)).length === 1) {
        return { success: false, error: { code: 'messaging/internal-error' } };
      }
      return { success: true };
    })
  };
};

function auth(options = {}) {
  return {
    uid: sender,
    token: {
      email: sender + '@example.com',
      role: 'commander',
      stationId: SID,
      shift: 'A',
      personal_lab_control: options.personal === true
    }
  };
}

function request(label, options = {}) {
  return {
    auth: auth(options),
    data: {
      text: 'בדיקת מסירה ' + label,
      target: 'crew:A',
      request_id: ('request-' + scenario + '-' + label + '-000000000000').slice(0, 70)
    }
  };
}

async function seed(runtime, recipients) {
  await db.doc('config/runtime').set(runtime);
  const batch = db.batch();
  batch.set(db.doc(`stations/${SID}/users/${sender}`), {
    station_id:SID, full_name: 'מפקד בדיקה', role: 'commander', crew: 'A', is_active: true
  });
  for (const item of recipients) {
    batch.set(db.doc(`stations/${SID}/roster/${item.uid}`), {
      full_name: item.uid, role: item.uid === sender ? 'commander' : 'firefighter',
      crew: 'A', is_active: true
    });
    if (item.tokens !== undefined) {
      batch.set(db.doc(`stations/${SID}/push_tokens/${item.uid}`), {
        tokens: item.tokens.map(token => ({ token }))
      });
    }
  }
  await batch.commit();
}

async function stored(result) {
  const snap = await db.doc(`stations/${SID}/callouts/${result.id}`).get();
  assert.equal(snap.exists, true);
  return snap.data();
}

async function expectRejected(promise) {
  await assert.rejects(promise, error => {
    const code = String(error && error.code || '');
    return /(?:permission-denied|failed-precondition|unavailable)$/.test(code);
  });
}

async function main() {
  if (scenario === 'auth-disabled-initial' || scenario === 'auth-demoted-initial') {
    await seed({ silent:false, silent_allow:[] }, [
      { uid:sender }, { uid:'crew_member', tokens:['must-not-send-token'] }
    ]);
    await expectRejected(functions.sendCallout.run(request('initial-auth-revoked')));
    assert.equal(sentTokenGroups.length, 0);
    assert.equal((await db.collection(`stations/${SID}/callouts`).get()).empty, true);
  }

  if (scenario === 'profile-inactive-initial') {
    await seed({ silent:false, silent_allow:[] }, [
      { uid:sender }, { uid:'crew_member', tokens:['must-not-send-token'] }
    ]);
    await db.doc(`stations/${SID}/users/${sender}`).set({ is_active:false }, { merge:true });
    await expectRejected(functions.sendCallout.run(request('initial-profile-revoked')));
    assert.equal(sentTokenGroups.length, 0);
    assert.equal((await db.collection(`stations/${SID}/callouts`).get()).empty, true);
  }

  if (scenario === 'auth-demoted-after-lease' || scenario === 'profile-inactive-after-lease') {
    await seed({ silent:false, silent_allow:[] }, [
      { uid:sender }, { uid:'crew_member', tokens:['must-not-send-token'] }
    ]);
    await expectRejected(functions.sendCallout.run(request('revoked-after-lease')));
    assert.equal(sentTokenGroups.length, 0, 'revocation after lease must precede FCM');
    const docs = await db.collection(`stations/${SID}/callouts`).get();
    assert.equal(docs.size, 1);
    assert.equal(docs.docs[0].data().delivery_state, 'partial');
    assert.equal(docs.docs[0].data().delivery_lease_until, null);
    assert.deepEqual(docs.docs[0].data().delivery_failed_uids, ['crew_member']);
  }

  if (scenario === 'personal-control-revoked-after-lease' ||
      scenario === 'trial-allow-revoked-after-actor') {
    await seed({ silent:true, silent_allow:[sender] }, [
      { uid:sender, tokens:['must-not-send-token'] }
    ]);
    await expectRejected(functions.sendCallout.run(request('trial-policy-revoked', { personal:true })));
    assert.equal(sentTokenGroups.length, 0,
      'fresh personal-lab claims and silent_allow must be checked after the delivery lease');
    const docs = await db.collection(`stations/${SID}/callouts`).get();
    assert.equal(docs.size, 1);
    assert.equal(docs.docs[0].data().delivery_state, 'partial');
  }

  if (scenario === 'close-demoted') {
    await seed({ silent:false, silent_allow:[] }, [
      { uid:sender }, { uid:'crew_member', tokens:['good-token'] }
    ]);
    const result = await functions.sendCallout.run(request('close-demoted'));
    assert.equal(result.ok, true);
    await expectRejected(functions.closeCallout.run({ auth:auth(), data:{ id:result.id } }));
    assert.equal((await stored(result)).active, true, 'demoted creator must not close the callout');
  }

  if (scenario === 'runtime-missing-fails-closed') {
    await seed({ silent:false, silent_allow:[] }, [
      { uid:sender }, { uid:'crew_member', tokens:['must-not-send-token'] }
    ]);
    await db.doc('config/runtime').delete();
    await expectRejected(functions.sendCallout.run(request('runtime-missing')));
    assert.equal(sentTokenGroups.length, 0);
    assert.equal((await db.collection(`stations/${SID}/callouts`).get()).empty, true);
  }

  if (scenario === 'runtime-invalid-fails-closed') {
    await seed({ silent:'false', silent_allow:[] }, [
      { uid:sender }, { uid:'crew_member', tokens:['must-not-send-token'] }
    ]);
    await expectRejected(functions.sendCallout.run(request('runtime-invalid')));
    assert.equal(sentTokenGroups.length, 0);
    assert.equal((await db.collection(`stations/${SID}/callouts`).get()).empty, true);
  }

  if (scenario === 'runtime-read-failure-after-lease') {
    await seed({ silent:false, silent_allow:[] }, [
      { uid:sender }, { uid:'retry_user', tokens:['good-token'] }
    ]);
    const proto = admin.firestore.DocumentReference.prototype;
    const originalGet = proto.get;
    let runtimeReads = 0;
    proto.get = function () {
      if (this.path === 'config/runtime' && ++runtimeReads === 2) {
        return Promise.reject(new Error('injected-runtime-read-failure'));
      }
      return originalGet.call(this);
    };
    const req = request('runtime-read-failure');
    await expectRejected(functions.sendCallout.run(req));
    proto.get = originalGet;
    assert.equal(sentTokenGroups.length, 0);
    const docs = await db.collection(`stations/${SID}/callouts`).get();
    assert.equal(docs.size, 1);
    const failedValue = docs.docs[0].data();
    assert.equal(failedValue.delivery_state, 'partial');
    assert.equal(failedValue.delivery_lease_until, null);
    assert.deepEqual(failedValue.delivery_failed_uids, ['retry_user']);
    const retry = await functions.sendCallout.run(req);
    assert.equal(retry.ok, true);
    assert.deepEqual(sentTokenGroups, [['good-token']]);
  }

  if (scenario === 'no-token-document') {
    await seed({ silent: false, silent_allow: [] }, [{ uid: sender }, { uid: 'no_doc' }]);
    const result = await functions.sendCallout.run(request('no-doc'));
    const value = await stored(result);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(value.delivery_state, 'partial');
    assert.deepEqual(value.delivery_failed_uids, ['no_doc']);
  }

  if (scenario === 'empty-token-list') {
    await seed({ silent: false, silent_allow: [] }, [
      { uid: sender }, { uid: 'empty_tokens', tokens: [] }
    ]);
    const result = await functions.sendCallout.run(request('empty'));
    const value = await stored(result);
    assert.equal(result.ok, false);
    assert.equal(value.delivery_state, 'partial');
    assert.deepEqual(value.delivery_failed_uids, ['empty_tokens']);
  }

  if (scenario === 'all-tokens-dead') {
    await seed({ silent: false, silent_allow: [] }, [
      { uid: sender }, { uid: 'dead_user', tokens: ['dead-token'] }
    ]);
    const result = await functions.sendCallout.run(request('dead'));
    const value = await stored(result);
    assert.equal(result.ok, false, 'all-dead delivery must not report success');
    assert.equal(value.delivery_state, 'partial');
    assert.deepEqual(value.delivery_failed_uids, ['dead_user']);
  }

  if (scenario === 'partial-retry') {
    await seed({ silent: false, silent_allow: [] }, [
      { uid: sender },
      { uid: 'good_user', tokens: ['good-token'] },
      { uid: 'retry_user', tokens: ['transient-token'] }
    ]);
    const req = request('partial');
    const first = await functions.sendCallout.run(req);
    assert.equal(first.ok, false);
    assert.deepEqual((await stored(first)).delivery_failed_uids, ['retry_user']);
    const firstTags = sentPayloads.map(payload => payload.data && payload.data.tag);
    assert.deepEqual(Array.from(new Set(firstTags)), ['callout-' + first.id],
      'all provider attempts use the stable callout tag');
    const before = sentTokenGroups.length;
    const payloadBefore = sentPayloads.length;
    const retry = await functions.sendCallout.run(req);
    assert.equal(retry.ok, true);
    assert.deepEqual(sentTokenGroups.slice(before), [['transient-token']],
      'retry must target only delivery_failed_uids');
    assert.deepEqual(sentPayloads.slice(payloadBefore).map(payload => payload.data && payload.data.tag),
      ['callout-' + first.id], 'retry keeps the exact provider collapse/tag identifier');
    assert.equal((await stored(retry)).delivery_state, 'completed');
  }

  if (scenario === 'live-retry-after-trial-cutover') {
    await seed({ silent:false, silent_allow:[] }, [
      { uid:sender }, { uid:'retry_user', tokens:['transient-token'] }
    ]);
    const req = request('live-to-trial', { personal:true });
    const first = await functions.sendCallout.run(req);
    assert.equal(first.ok, false);
    const before = sentTokenGroups.length;
    await db.doc('config/runtime').set({ silent:true, silent_allow:[sender] });
    const retry = await functions.sendCallout.run(req);
    assert.equal(retry.ok, false);
    assert.equal(retry.mode_changed, true);
    assert.equal(retry.retryable, false);
    assert.equal(sentTokenGroups.length, before,
      'a live audience must never be reused after switching to trial');
    assert.equal((await stored(retry)).delivery_state, 'cancelled_mode_change');
  }

  if (scenario === 'trial-retry-after-live-cutover') {
    await seed({ silent:true, silent_allow:[sender] }, [
      { uid:sender, tokens:['transient-token'] },
      { uid:'crew_member', tokens:['must-not-expand-token'] }
    ]);
    const req = request('trial-to-live', { personal:true });
    const first = await functions.sendCallout.run(req);
    assert.equal(first.ok, false);
    const before = sentTokenGroups.length;
    await db.doc('config/runtime').set({ silent:false, silent_allow:[] });
    const retry = await functions.sendCallout.run(req);
    assert.equal(retry.ok, false);
    assert.equal(retry.mode_changed, true);
    assert.equal(sentTokenGroups.length, before,
      'a trial audience must never expand after switching to live');
    assert.equal((await stored(retry)).delivery_state, 'cancelled_mode_change');
  }

  if (scenario === 'closed-before-retry') {
    await seed({ silent: false, silent_allow: [] }, [
      { uid: sender }, { uid:'retry_user', tokens:['transient-token'] }
    ]);
    const req = request('closed-partial');
    const first = await functions.sendCallout.run(req);
    assert.equal(first.ok, false);
    await functions.closeCallout.run({ auth:req.auth, data:{ id:first.id } });
    const before = sentTokenGroups.length;
    const retry = await functions.sendCallout.run(req);
    assert.equal(retry.ok, false);
    assert.equal(retry.closed, true);
    assert.equal(sentTokenGroups.length, before, 'a closed callout must never send another push');
    assert.equal((await stored(retry)).delivery_state, 'cancelled');
  }

  if (scenario === 'trial-missing-control') {
    await seed({ silent: true, silent_allow: [sender] }, [{ uid: sender, tokens: ['self-token'] }]);
    await expectRejected(functions.sendCallout.run(request('missing-control')));
    assert.equal((await db.collection(`stations/${SID}/callouts`).get()).empty, true);
  }

  if (scenario === 'trial-not-allowlisted') {
    await seed({ silent: true, silent_allow: ['different_uid'] }, [
      { uid: sender, tokens: ['self-token'] }
    ]);
    await expectRejected(functions.sendCallout.run(request('not-allowed', { personal: true })));
    assert.equal((await db.collection(`stations/${SID}/callouts`).get()).empty, true);
  }

  if (scenario === 'trial-isolated') {
    await seed({ silent: true, silent_allow: [sender] }, [
      { uid: sender, tokens: ['self-token'] },
      { uid: 'other_crew_member', tokens: ['must-not-send-token'] }
    ]);
    const result = await functions.sendCallout.run(request('isolated', { personal: true }));
    const value = await stored(result);
    assert.equal(result.ok, true);
    assert.equal(value.trial, true);
    assert.deepEqual(value.uids, [sender]);
    assert.deepEqual(sentTokenGroups, [['self-token']]);
  }

  if (scenario === 'trial-email-allowlisted') {
    await seed({ silent: true, silent_allow: [sender + '@example.com'] }, [
      { uid: sender, tokens: ['self-token'] },
      { uid: 'other_crew_member', tokens: ['must-not-send-token'] }
    ]);
    const result = await functions.sendCallout.run(request('email-allowed', { personal: true }));
    const value = await stored(result);
    assert.equal(result.ok, true);
    assert.deepEqual(value.uids, [sender]);
    assert.deepEqual(sentTokenGroups, [['self-token']]);
  }

  console.log('✓ ' + scenario);
}

main().catch(error => {
  console.error('✗ ' + scenario);
  console.error(error && error.stack || error);
  process.exit(1);
});
