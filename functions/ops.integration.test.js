'use strict';

// Real Firestore transactions and rules, never a real project. Validate both
// endpoint and namespace before importing any Firebase SDK or reading rules.
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '';
const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-resq';
if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(emulatorHost)
    || !/^demo-[a-z0-9-]+$/.test(projectId)) {
  console.error('NOT RUN: loopback FIRESTORE_EMULATOR_HOST and demo-* project are required.');
  process.exit(2);
}

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
// Resolve through local dependencies or the runner's NODE_PATH; no installation
// and no silent skip when the rules SDK is missing.
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, deleteDoc, collection, getDocs } = require('firebase/firestore');
const { createFeedback } = require('./feedback');
const { createIncidentLog } = require('./incident-log');
const app = admin.initializeApp({ projectId }, 'ops-it-' + process.pid);
const db = app.firestore();
const sid = 'ops_it_' + crypto.randomBytes(6).toString('hex');
const root = db.collection('stations').doc(sid);
const uid = 'ops.user.with.dot';
const superUid = 'ops.super.with.dot';
const profileRef = root.collection('users').doc(uid);
const profile = { stationId: sid, role: 'firefighter', employee_number: 'live_123', is_active: true };
const token = { stationId: sid, role: 'firefighter', emp: 'stale_999' };
const clock = () => '2026-09-03T10:00:00.000Z';
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const deps = (database = db) => ({ db: database, FieldValue: admin.firestore.FieldValue, HttpsError, hash, clock });
const feedback = createFeedback(deps());
const incidents = createIncidentLog(deps());
const request = (data) => ({ auth: { uid, token }, data });
const superRequest = (data) => ({ auth: { uid:superUid, token:{
  stationId:sid, role:'', super:true, email:'ordinary@example.invalid'
} }, data });
const feedbackData = (id, extra = {}) => ({ request_id: id, screen: 'feedback.html', version: '42G.0',
  category: 'problem', rating: 2, text: 'בדיקת אמולטור מקומית', allow_contact: true, ...extra });
const reportData = { kind: 'client-error', screen: 'feedback.html', version: '42G.0', code: 'TypeError', callable: 'unknown' };
let passed = 0;
let env;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}
async function resetQuota() {
  await root.collection('feedback_quota').doc(uid + '_2026-09-03').delete();
}

// Deterministically exercises an SDK transaction retry. The first attempt
// reads the live member and queues writes, then an ABORTED fault is injected.
// Revocation commits on the emulator after the first transaction releases its
// lock; the retry must read the updated profile, not reuse the old actor.
// This is a retry fault injection, not a claim that an SDK mock tests contention.
function revokeAtRetry() {
  let attempts = 0;
  let revoked;
  return {
    collection: db.collection.bind(db),
    runTransaction: (work) => db.runTransaction(async (tx) => {
      attempts++;
      if (revoked) await revoked;
      const result = await work(tx);
      if (attempts === 1) {
        revoked = profileRef.update({ is_active: false });
        // Attach a handler while the SDK rolls back the held read lock.
        revoked.catch(() => {});
        const error = new Error('Injected retry boundary');
        error.code = 10;
        throw error;
      }
      return result;
    }, { maxAttempts: 5 }),
    attempts: () => attempts
  };
}

(async () => {
  const port = Number(emulatorHost.slice(emulatorHost.lastIndexOf(':') + 1));
  const host = emulatorHost.slice(0, emulatorHost.lastIndexOf(':')).replace(/^\[|\]$/g, '');
  env = await initializeTestEnvironment({ projectId, firestore: {
    host, port, rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')
  } });
  await profileRef.set(profile);

  await test('parallel identical feedback creates one document and spends one quota', async () => {
    const data = feedbackData('ops_parallel_0001');
    const replies = await Promise.all(Array.from({ length: 6 }, () => feedback.submit(request(data))));
    assert.equal(replies.filter((row) => !row.duplicate).length, 1);
    assert.equal(new Set(replies.map((row) => row.id)).size, 1);
    const saved = (await root.collection('feedback').doc(replies[0].id).get()).data();
    assert.equal(saved.employee_number, 'live_123');
    assert.equal((await root.collection('feedback_quota').doc(uid + '_2026-09-03').get()).data().count, 1);
  });
  await test('parallel same-id different consent has one winner and one conflict', async () => {
    const data = feedbackData('ops_conflict_0001');
    const settled = await Promise.allSettled([
      feedback.submit(request(data)), feedback.submit(request({ ...data, allow_contact: false }))
    ]);
    assert.equal(settled.filter((row) => row.status === 'fulfilled').length, 1);
    assert.equal(settled.find((row) => row.status === 'rejected').reason.code, 'already-exists');
  });
  await test('parallel near-quota requests cannot exceed the per-user cap', async () => {
    await root.collection('feedback_quota').doc(uid + '_2026-09-03').set({ uid, day: '2026-09-03', count: 19 });
    const settled = await Promise.allSettled([1, 2].map((n) => feedback.submit(request(feedbackData('ops_quota_000' + n)))));
    assert.equal(settled.filter((row) => row.status === 'fulfilled').length, 1);
    assert.equal(settled.find((row) => row.status === 'rejected').reason.code, 'resource-exhausted');
    assert.equal((await root.collection('feedback_quota').doc(uid + '_2026-09-03').get()).data().count, 20);
    await resetQuota();
  });
  await test('parallel incident reports preserve both counters and no PII', async () => {
    const replies = await Promise.all(Array.from({ length: 6 }, () => incidents.report(request(reportData))));
    const saved = (await root.collection('incidents').doc(replies[0].fingerprint).get()).data();
    assert.equal(saved.count, 6);
    assert.equal((await root.collection('incident_days').doc('2026-09-03').get()).data().count, 6);
    for (const forbidden of [uid, 'live_123', 'stale_999', 'message', 'frame']) {
      assert.equal(JSON.stringify(saved).includes(forbidden), false);
    }
  });
  await test('verified super can report and submit without a station user profile', async () => {
    assert.equal((await root.collection('users').doc(superUid).get()).exists, false);
    const incident = await incidents.report(superRequest({ ...reportData, code:'RangeError' }));
    const incidentDoc = (await root.collection('incidents').doc(incident.fingerprint).get()).data();
    assert.deepEqual(incidentDoc.roles, ['super_admin']);
    const out = await feedback.submit(superRequest(feedbackData('ops_super_0001')));
    const saved = (await root.collection('feedback').doc(out.id).get()).data();
    assert.equal(saved.uid, superUid);
    assert.equal(saved.role, 'super_admin');
    assert.equal(saved.employee_number, '');
    assert.equal((await db.collection('stations').doc('other_station').collection('feedback').get()).empty, true);
  });
  await test('inactive, moved and role-changed live users cannot submit or replay', async () => {
    const data = feedbackData('ops_replay_0001');
    await feedback.submit(request(data));
    for (const change of [{ active: false }, { stationId: 'other_station' }, { role: 'commander' }]) {
      await profileRef.set({ ...profile, ...change });
      await assert.rejects(feedback.submit(request(data)), (e) => e.code === 'permission-denied');
      await assert.rejects(incidents.report(request(reportData)), (e) => e.code === 'permission-denied');
    }
    await profileRef.set(profile);
  });
  await test('retry revocation blocks new feedback, saved replay and incident writes', async () => {
    const replayData = feedbackData('ops_retry_replay_0001');
    await feedback.submit(request(replayData));
    const beforeFeedback = (await root.collection('feedback').get()).size;
    const beforeQuota = (await root.collection('feedback_quota').doc(uid + '_2026-09-03').get()).data().count;
    const beforeIncident = (await root.collection('incident_days').doc('2026-09-03').get()).data().count;
    for (const kind of ['new', 'replay', 'incident']) {
      await profileRef.set(profile);
      const retried = revokeAtRetry();
      const promise = kind === 'incident'
        ? createIncidentLog(deps(retried)).report(request(reportData))
        : createFeedback(deps(retried)).submit(request(kind === 'replay' ? replayData : feedbackData('ops_retry_new_0001')));
      await assert.rejects(promise, (e) => e.code === 'permission-denied');
      assert.ok(retried.attempts() >= 2, 'the SDK must have rerun the transaction');
    }
    assert.equal((await root.collection('feedback').get()).size, beforeFeedback);
    assert.equal((await root.collection('feedback_quota').doc(uid + '_2026-09-03').get()).data().count, beforeQuota);
    assert.equal((await root.collection('incident_days').doc('2026-09-03').get()).data().count, beforeIncident);
    await profileRef.set(profile);
  });
  await test('legacy unsafe incident fields are excluded from the bounded admin projection', async () => {
    const id = 'a'.repeat(40);
    await root.collection('incidents').doc(id).set({ last_seen_iso: clock(), message: 'דנה מחלה',
      frame: 'user.with.dot', note: 'private', code: 'private', screens: ['private'] });
    const rows = await incidents.list({ sid, limit: 500 });
    const exported = rows.find((row) => row.id === id);
    assert.ok(exported);
    assert.equal(exported.code, 'unknown');
    for (const forbidden of ['דנה', 'private', 'user.with.dot']) assert.equal(JSON.stringify(exported).includes(forbidden), false);
  });
  await test('four ops collections deny direct reads, writes and list queries even to super', async () => {
    for (const name of ['incidents', 'incident_days', 'feedback', 'feedback_quota']) {
      await root.collection(name).doc('rules_probe').set({ test: true });
      for (const claims of [token, { ...token, super: true, email: 'fire102.shits@gmail.com' }]) {
        const client = env.authenticatedContext(uid, claims).firestore();
        await assertFails(getDoc(doc(client, 'stations', sid, name, 'rules_probe')));
        await assertFails(setDoc(doc(client, 'stations', sid, name, 'rules_probe'), { test: false }));
        await assertFails(deleteDoc(doc(client, 'stations', sid, name, 'rules_probe')));
        await assertFails(getDocs(collection(client, 'stations', sid, name)));
      }
      const anonymous = env.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(anonymous, 'stations', sid, name, 'rules_probe')));
    }
  });
  await test('feedback retention is 30 days from creation, not replay or marking read', async () => {
    await resetQuota();
    const input = feedbackData('ops_retention_0001');
    const first = await feedback.submit(request(input));
    const ref = root.collection('feedback').doc(first.id);
    const expiry = Date.parse(clock()) + 30 * 24 * 60 * 60 * 1000;
    assert.equal((await ref.get()).data().expires_at.toMillis(), expiry);
    const later = createFeedback({ ...deps(), clock: () => '2026-09-10T10:00:00.000Z' });
    assert.equal((await later.submit(request(input))).duplicate, true);
    await later.markRead({ sid, ids: [first.id], by: 'operator' });
    assert.equal((await ref.get()).data().expires_at.toMillis(), expiry);
    const countBefore = (await root.collection('feedback_quota').doc(uid + '_2026-09-03').get()).data().count;
    await feedback.remove({ sid, id: first.id, by: 'operator' });
    assert.equal((await ref.get()).exists, false);
    assert.equal((await root.collection('feedback_quota').doc(uid + '_2026-09-03').get()).data().count, countBefore);
  });
  await test('incidents never retain expiry, and manual deletion rejects open or changed reports', async () => {
    const out = await incidents.report(request(reportData));
    const ref = root.collection('incidents').doc(out.fingerprint);
    await ref.update({ expires_at: admin.firestore.Timestamp.fromMillis(0) });
    await incidents.report(request(reportData));
    assert.equal(Object.hasOwn((await ref.get()).data(), 'expires_at'), false);
    const current = (await ref.get()).data();
    const options = { sid, fingerprint: out.fingerprint, by: 'operator', expected_count: current.count,
      expected_last_seen_iso: current.last_seen_iso, expected_resolved_at: clock() };
    await assert.rejects(incidents.removeResolved(options), /incident-not-resolved/);
    await ref.update({ expires_at: admin.firestore.Timestamp.fromMillis(0) });
    await incidents.setStatus({ sid, fingerprint: out.fingerprint, status: 'resolved', by: 'operator' });
    assert.equal(Object.hasOwn((await ref.get()).data(), 'expires_at'), false);
    await incidents.report(request(reportData));
    await assert.rejects(incidents.removeResolved(options), /incident-changed/);
    await incidents.removeResolved({ ...options, expected_count: current.count + 1 });
    assert.equal((await ref.get()).exists, false);
  });
  await test('manual incident deletion rechecks a recurrence on Firestore transaction retry', async () => {
    const out = await incidents.report(request(reportData));
    await incidents.setStatus({ sid, fingerprint: out.fingerprint, status: 'resolved', by: 'operator' });
    const ref = root.collection('incidents').doc(out.fingerprint);
    const reviewed = (await ref.get()).data();
    let attempts = 0, recurrence;
    const database = { collection: db.collection.bind(db), runTransaction: (work) => db.runTransaction(async (tx) => {
      attempts++;
      if (recurrence) await recurrence;
      const result = await work(tx);
      if (attempts === 1) {
        recurrence = ref.update({ count: reviewed.count + 1 });
        recurrence.catch(() => {});
        const error = new Error('Injected recurrence retry boundary'); error.code = 10; throw error;
      }
      return result;
    }, { maxAttempts: 5 }) };
    await assert.rejects(createIncidentLog(deps(database)).removeResolved({ sid, fingerprint: out.fingerprint,
      by: 'operator', expected_count: reviewed.count, expected_last_seen_iso: reviewed.last_seen_iso,
      expected_resolved_at: reviewed.resolved_at }), /incident-changed/);
    assert.ok(attempts >= 2);
    assert.equal((await ref.get()).data().count, reviewed.count + 1);
  });
  console.log(passed + ' ops emulator scenarios passed. No production resources used.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  // Only this generated fixture namespace in the verified local demo emulator.
  try { await db.recursiveDelete(root); }
  finally { if (env) await env.cleanup(); await app.delete(); }
});
