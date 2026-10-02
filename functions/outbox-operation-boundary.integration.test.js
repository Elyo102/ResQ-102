'use strict';
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^127\.0\.0\.1:(8080|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT === 'demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION = 'none';
const admin = require('firebase-admin');
const app = admin.initializeApp({ projectId: 'demo-resq' }, 'operation-boundary-' + randomBytes(8).toString('hex'));
const db = app.firestore(), sid = 'operation_boundary_' + randomBytes(10).toString('hex');
const station = db.doc('stations/' + sid), owned = [];
const NOW = '2026-09-01T06:00:00.000Z';
async function create(ref, data) {
  assert.equal((await ref.get()).exists, false);
  await ref.create(data);
  owned.push(ref);
  return ref;
}
const runtime = hooks => require('./schedule-runtime').createScheduleRuntime({
  db, FieldValue: admin.firestore.FieldValue, FieldPath: admin.firestore.FieldPath,
  monthAuthorityOutcomeTransaction: callback => db.runTransaction(callback),
  clock: () => NOW, hash: value => createHash('sha256').update(String(value)).digest('hex'),
  randomId: () => randomBytes(12).toString('hex'),
  createEngine: require('./schedule-calendar-engine').createCalendarEngine,
  createPublication: require('./schedule-publication').createPublication,
  createService: require('./schedule-service').createScheduleService,
  isSuper: () => false, sendPush: async () => ({ sent: 1 }), ...hooks
});
let passed = 0;
(async () => {
  try {
    // Sweeps use a shared cursor: run only in a fresh, exclusively owned emulator.
    const cursor = db.doc('schedule_runtime_workers/outbox_resume');
    assert.equal((await cursor.get()).exists, false,
      'fresh exclusive emulator required: cursor already exists');
    for (const group of ['guard_outbox', 'guard_notification_jobs']) {
      assert.equal((await db.collectionGroup(group).limit(1).get()).empty, true,
        'fresh exclusive emulator required: ' + group + ' is not empty');
    }
    // Register only after every preflight passes; never delete a preexisting cursor.
    owned.push(cursor);
    await create(station.collection('users').doc('viewer'), {
      role: 'firefighter', stationId: sid, station_id: sid, active: true, is_active: true
    });
    await create(station.collection('schedule_state').doc('runtime'), { mode: 'new' });
    await create(station.collection('schedule_state').doc('active'), { publication_id: 'pub', revision: 1 });
    const pub = await create(station.collection('schedule_publications').doc('pub'), {
      status: 'active', delivery_policy: 'live', delivery_allowed: true
    });
    const guard = await create(station.collection('guards').doc('guard'), {
      status: 'open', revision: 1, place: 'synthetic original place'
    });
    const make = (kind, id) => create(kind === 'schedule'
      ? pub.collection('schedule_outbox').doc(id) : station.collection('guard_outbox').doc(id), {
      station_id: sid, status: 'queued', attempt: 0, dedupe_key: id,
      expires_at: new Date('2026-10-01T00:00:00Z'),
      ...(kind === 'schedule'
        ? { publication_id: 'pub', revision: 1, person: 'viewer', delivery_policy: 'live',
          delivery_allowed: true, push: { title: 'synthetic', body: 'synthetic' } }
        // Personal assignment notices include live place; generic open prompts do not.
        : { guard_id: 'guard', recipient_uid: 'viewer', kind: 'assigned', revision: 1,
          date: '2026-09-02', start: '08:00', end: '12:00' })
    });
    for (const kind of ['schedule', 'guard']) {
      const method = kind === 'schedule' ? 'deliverOutbox' : 'deliverGuardOutbox';
      const ref = await make(kind, kind + '_changed_retry');
      let sends = 0, crash = true;
      const api = runtime({
        sendPush: async () => { sends++; return { sent: 1 }; },
        afterOutboxProvider: async () => { if (crash) throw Error('synthetic post-provider crash'); }
      });
      assert.equal((await api[method](ref)).status, 'retry');
      const before = (await ref.get()).data();
      assert.equal(sends, 1);
      assert.equal(before.delivery_uncertain, true);
      assert.equal(before.provider_state, 'uncertain');
      assert.equal(before.duplicate_risk_count, 1);
      crash = false;
      await ref.update({ status: 'queued', next_attempt_at: null,
        ...(kind === 'schedule' ? { push: { title: 'changed title', body: 'changed body' } } : {}) });
      if (kind === 'guard') await guard.update({ place: 'synthetic changed place' });
      assert.deepEqual(await api[method](ref), { skipped: true });
      const after = (await ref.get()).data();
      assert.equal(sends, 1, 'conflicting retry must not enter the provider');
      assert.equal(after.status, 'failed');
      assert.equal(after.last_error, 'DELIVERY_OPERATION_CONFLICT');
      assert.ok(after.operation_conflict_at);
      for (const key of ['delivery_operation_id', 'delivery_payload_digest', 'delivery_attempt_id',
        'last_uncertain_attempt_id', 'delivery_uncertain', 'duplicate_risk_count', 'provider_state']) {
        assert.deepEqual(after[key], before[key], 'preserve uncertain history: ' + key);
      }
      assert.equal(after.delivery_ack_attempt_id, undefined);
      await guard.update({ place: 'synthetic original place' });
      passed++;
      console.log(`PASS ${kind} changed payload after uncertain send is rejected without losing history`);

      const expired = await make(kind, kind + '_tracked_expired');
      await expired.update({ status: 'sending', lease_token: 'expired-owner', lease_until: new Date(0),
        delivery_operation_id: 'dop_' + createHash('sha256').update('push-operation|' + expired.path).digest('hex').slice(0, 40),
        delivery_attempt_id: 'dat_crashed', delivery_ack_attempt_id: null,
        delivery_semantics: 'at-least-once', provider_state: 'entered', duplicate_risk_count: 0 });
      let recoverySends = 0;
      const recovery = runtime({ sendPush: async () => { recoverySends++; return { sent: 1 }; } });
      const reconcile = () => kind === 'schedule'
        ? recovery.reconcileMonthControlledOutbox(expired, Date.parse(NOW))
        : recovery.resumeGuardOutbox();
      await reconcile();
      const queued = (await expired.get()).data();
      assert.equal(queued.status, 'queued');
      assert.equal(queued.delivery_uncertain, true);
      assert.equal(queued.provider_state, 'uncertain');
      assert.equal(queued.duplicate_risk_count, 1);
      assert.equal(queued.last_uncertain_attempt_id, 'dat_crashed');
      assert.equal(queued.prior_acceptance_unknown, false);
      assert.equal(recoverySends, 0);
      await reconcile();
      const repeated = (await expired.get()).data();
      assert.equal(repeated.duplicate_risk_count, 1, 'same expired attempt must not count twice');
      assert.equal(repeated.last_uncertain_attempt_id, 'dat_crashed');
      assert.equal(repeated.delivery_operation_id, queued.delivery_operation_id);
      if (kind === 'schedule') {
        // Direct reconciliation reports a queued job but does not send it.
        assert.equal(repeated.status, 'queued');
        assert.equal(repeated.delivery_uncertain, true);
        assert.equal(recoverySends, 0);
      } else {
        // The public guard sweep delivers jobs already queued at page capture.
        assert.equal(repeated.status, 'sent');
        assert.equal(repeated.delivery_uncertain, false);
        assert.equal(repeated.delivery_ack_attempt_id, repeated.delivery_attempt_id);
        assert.notEqual(repeated.delivery_attempt_id, 'dat_crashed');
        assert.equal(recoverySends, 1);
      }
      passed++;
      console.log(`PASS ${kind} tracked expired attempt counts risk once across repeated reconciliation`);
    }
    assert.equal(passed, 4);
    console.log('Outbox operation boundaries: 4/4 PASS; synthetic provider, at-least-once only');
  } finally {
    try {
      if (owned.length) {
        const batch = db.batch();
        for (const ref of owned) batch.delete(ref);
        await batch.commit();
      }
    } finally { await app.delete(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
