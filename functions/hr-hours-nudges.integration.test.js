'use strict';
const host = process.env.FIRESTORE_EMULATOR_HOST || '', projectId = process.env.GCLOUD_PROJECT || '';
if (!/^(localhost|127\.0\.0\.1):\d{1,5}$/.test(host) || !/^demo-[a-z0-9-]+$/.test(projectId)) {
  console.error('NOT RUN: loopback Firestore emulator and demo-* project required.'); process.exit(2);
}
// Explicit demo project needs no cloud metadata discovery (Auth is mocked).
process.env.METADATA_SERVER_DETECTION = 'none';
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const admin = require('firebase-admin');
const { BaseAuth } = require(require('node:path').join(require('node:path').dirname(require.resolve('firebase-admin')), 'auth/base-auth.js'));
const { AuthClientErrorCode } = require(require('node:path').join(require('node:path').dirname(require.resolve('firebase-admin')), 'utils/error.js'));
const { createHrHoursNudges, LIFETIME_MS } = require('./hr-hours-nudges');
const app = admin.initializeApp({ projectId }, 'hr-nudges-' + process.pid), db = app.firestore();
const run = randomBytes(6).toString('hex'), roots = [], globals = new Map(), authRecords = new Map();
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const auth = { async getUser(uid) {
  const value = authRecords.get(uid);
  if (value instanceof Error) throw value;
  if (!value) throw Object.assign(new Error('synthetic missing actor'), { code: 'auth/user-not-found' });
  return structuredClone(value);
} };
const runtimeRef = db.doc('config/runtime'), month = '2026-09';
const authenticatedAt = Date.parse('2026-09-01T00:00:00Z') / 1000;
let fixtureCount = 0, passed = 0, priorRuntime;
async function tracked(path, value) { const ref = db.doc(path); globals.set(path, ref); if (value !== undefined) await ref.set(value); return ref; }
async function fixture({ people = 1, superUser = false } = {}) {
  const key = run + '_' + (++fixtureCount), sid = 'hr_nudge_it_' + key, actor = 'zz_actor_' + key;
  const root = db.collection('stations').doc(sid); roots.push(root);
  const claims = superUser ? { stationId: sid, super: true } : { stationId: sid, role: 'hr_coordinator' };
  authRecords.set(actor, { uid: actor, disabled: false, customClaims: claims });
  if (!superUser) await root.collection('users').doc(actor).set({ stationId: sid, role: 'hr_coordinator', active: true });
  const f = { sid, actor, root, claims, authTime: authenticatedAt, people: [], at: Date.parse('2026-09-08T09:00:00.000Z') };
  f.addPerson = async (uid, extra = {}) => {
    const emp = 'emp_' + key + '_' + uid;
    await root.collection('users').doc(uid).set({ stationId: sid, employee_number: emp, full_name: 'Synthetic employee', role: 'firefighter', active: true, ...extra });
    await tracked('emp_index/' + emp, { uid, stationId: sid, active: true, retired: false });
    await tracked('directory/' + uid, { station: sid, active: true });
    const p = { uid, emp }; f.people.push(p); return p;
  };
  for (let i = 0; i < people; ++i) await f.addPerson('p' + String(i).padStart(2, '0') + '_' + key);
  f.report = async (p, status = 'draft', extra = {}) => {
    await root.collection('monthly_reports').doc(p.emp + '_' + month).set({ uid: p.uid, emp_number: p.emp, month, status, days: [], total_hours: 0, ...extra });
  };
  f.req = (id, { bulk = false, send_now = false, ...extra } = {}) => ({ auth: { uid: actor, token: { ...claims, auth_time: f.authTime } },
    data: { month, request_id: id, send_now, ...(!bulk ? { uid: f.people[0]?.uid } : {}), ...extra } });
  f.service = (hooks = {}, database = db) => createHrHoursNudges({ db: database, HttpsError, auth, clock: () => f.at, hooks });
  f.job = action => ({ stationId: sid, action_id: action.action_id });
  f.actions = () => root.collection('hr_nudge_actions').get();
  f.intents = () => root.collection('hr_nudge_intents').get();
  f.lock = await tracked('hr_nudge_bulk_locks/' + hash(['hr-bulk-v1', actor, month]));
  f.quota = await tracked('hr_nudge_actor_quotas/' + hash(['hr-quota-v1', actor]));
  return f;
}
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
async function check(name, test) {
  await runtimeRef.set({ silent: false, silent_allow: [] }); await test();
  ++passed; console.log('PASS ' + name);
}
function failingReadDb(path) {
  return { collection: db.collection.bind(db), doc: db.doc.bind(db), runTransaction: fn => db.runTransaction(tx => fn(new Proxy(tx, {
    get(target, key) {
      if (key === 'get') return ref => { if (typeof path === 'function' ? path(ref) : ref.path === path) return Promise.reject(Object.assign(new Error('synthetic unavailable read'), { code: 'unavailable' })); return target.get(ref); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }
  }))) };
}
async function finishDiscovery(f, service, action) {
  let value = action, pages = 0;
  while (value.phase === 'discovery') {
    assert.ok(++pages < 20, 'fixture discovery finishes within a bounded number of pages');
    value = await service.processJob(f.job(action));
    assert.equal((await f.intents()).size, 0, 'discovery never creates notification intents');
    assert.equal(value.counts.scanned, 0, 'discovery does not pretend recipients were evaluated');
    assert.equal(value.expires_at_ms, action.expires_at_ms, 'discovery does not extend original deadline');
  }
  return value;
}
(async () => {
  try {
    priorRuntime = await runtimeRef.get();
    console.log(JSON.stringify({ run, prior_runtime: priorRuntime.exists ? priorRuntime.data() : null, prior_runtime_exists: priorRuntime.exists }));
    await check('verified auth time and fresh revocation marker match actual Admin SDK strict comparison', async () => {
      const f = await fixture(), s = f.service();
      const sdkCheck = auth_time => BaseAuth.prototype.verifyDecodedJWTNotRevokedOrDisabled.call(auth,
        { sub: f.actor, auth_time }, AuthClientErrorCode.ID_TOKEN_REVOKED);
      for (const value of [undefined, null, '1000', -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        const req = f.req('invalid-time'); req.auth.token.auth_time = value;
        await rejects(() => s.request(req), 'unauthenticated');
      }
      f.authTime = 1000;
      authRecords.get(f.actor).tokensValidAfterTime = new Date(2000 * 1000).toUTCString();
      await rejects(() => sdkCheck(f.authTime), 'auth/id-token-revoked');
      await rejects(() => s.request(f.req('revoked')), 'permission-denied');
      assert.equal((await f.actions()).size, 0); assert.equal((await f.intents()).size, 0); assert.equal((await f.quota.get()).exists, false);
      f.authTime = 2000;
      await sdkCheck(f.authTime); assert.equal((await s.request(f.req('equal-valid'))).counts.queued, 1);
      for (const marker of [null, '', 'not-a-date', 2000]) {
        authRecords.get(f.actor).tokensValidAfterTime = marker;
        await rejects(() => s.request(f.req('bad-marker')), 'permission-denied');
      }
      assert.equal((await f.actions()).size, 1); assert.equal((await f.intents()).size, 1);
    });
    await check('replay and delayed pages preserve original authentication basis after revocation', async () => {
      const f = await fixture(), s = f.service(), req = f.req('before-revoke', { bulk: true });
      const action = await s.request(req), ref = f.root.collection('hr_nudge_actions').doc(action.action_id);
      assert.equal((await ref.get()).data().actor_auth_time, authenticatedAt);
      await s.processJob(f.job(action));
      const before = (await ref.get()).data(), quota = (await f.quota.get()).data();
      authRecords.get(f.actor).tokensValidAfterTime = new Date((authenticatedAt + 1) * 1000).toUTCString();
      await rejects(() => s.request(req), 'permission-denied');
      f.authTime += 2; // Even a fresh login cannot renew the old action's basis.
      await rejects(() => s.request(f.req('before-revoke', { bulk: true })), 'permission-denied');
      assert.deepEqual((await ref.get()).data(), before); assert.deepEqual((await f.quota.get()).data(), quota);
      const cancelled = await s.processJob(f.job(action));
      assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.reason, 'actor-no-longer-authorized');
      assert.equal((await f.lock.get()).exists, false); assert.equal((await f.intents()).size, 0);
      const fresh = await s.request(f.req('new-session', { bulk: true }));
      assert.equal(fresh.status, 'discovering');
      const newRef = f.root.collection('hr_nudge_actions').doc(fresh.action_id);
      await newRef.update({ actor_auth_time: admin.firestore.FieldValue.delete() });
      await rejects(() => s.processJob(f.job(fresh)), 'failed-precondition');
      assert.equal((await f.intents()).size, 0);
    });
    await check('clock crossing quiet hours during Auth lookup cannot create an unconfirmed intent', async () => {
      const f = await fixture(); f.at = Date.parse('2026-09-08T18:59:00Z');
      const result = await f.service({ afterAuth() { f.at = Date.parse('2026-09-08T19:01:00Z'); } }).request(f.req('clock-boundary'));
      assert.equal(result.status, 'confirmation_required'); assert.equal((await f.intents()).size, 0);
    });
    await check('final write barrier rechecks night and job expiry after all target reads', async () => {
      const f = await fixture(); f.at = Date.parse('2026-09-08T18:59:00Z');
      const late = await f.service({ beforeWrites() { f.at = Date.parse('2026-09-08T19:01:00Z'); } }).request(f.req('late-request'));
      assert.equal(late.status, 'confirmation_required'); assert.equal((await f.intents()).size, 0);
      const g = await fixture(); g.at = Date.parse('2026-09-08T18:59:00Z');
      const job = await g.service().request(g.req('late-page', { bulk: true }));
      const deferred = await g.service({ beforeWrites({ stage }) { if (stage === 'page') g.at = Date.parse('2026-09-08T19:01:00Z'); } }).processJob(g.job(job));
      assert.equal(deferred.status, 'deferred'); assert.equal(deferred.counts.scanned, 0); assert.equal((await g.intents()).size, 0);
      const expired = await g.service({ beforeWrites({ stage }) { if (stage === 'page') g.at = job.expires_at_ms; } }).processJob(g.job(job));
      assert.equal(expired.status, 'expired'); assert.equal(expired.counts.scanned, 0); assert.equal((await g.lock.get()).exists, false);
    });
    await check('closed requests and HR/signed-super authority, no email or role shortcut', async () => {
      const f = await fixture(), s = f.service();
      await rejects(() => s.request({ data: f.req('a').data }), 'unauthenticated');
      for (const token of [{ ...f.claims, role: 'firefighter' }, { stationId: f.sid, role: 'super_admin', email: 'synthetic@example.invalid' }, { stationId: f.sid, role: 'firefighter', super: 'true' }]) {
        await rejects(() => s.request({ ...f.req('a'), auth: { uid: f.actor, token } }), 'permission-denied');
      }
      for (const data of [{ ...f.req('a').data, stationId: f.sid }, { ...f.req('a').data, send_now: 'true' }, { ...f.req('a').data, uid: '../elsewhere' }, { ...f.req('a').data, request_id: '' }]) {
        await rejects(() => s.request({ ...f.req('a'), data }), 'invalid-argument');
      }
      assert.equal((await f.actions()).size, 0); assert.equal((await f.intents()).size, 0);
    });
    await check('single missing report atomically creates one generic expiring personal intent', async () => {
      const f = await fixture(), result = await f.service().request(f.req('single'));
      assert.equal(result.status, 'completed'); assert.equal(result.counts.queued, 1); assert.equal(result.delivery_status, 'intent_only');
      const docs = await f.intents(); assert.equal(docs.size, 1); const value = docs.docs[0].data();
      assert.equal(value.type, 'report_submit'); assert.equal(value.transport_type, 'report_mine');
      assert.equal(value.expires_at_ms, f.at + LIFETIME_MS); assert.equal(value.action_id, result.action_id);
      for (const key of ['tokens', 'employee_number', 'full_name', 'total_hours']) assert.equal(Object.hasOwn(value, key), false);
      assert.equal((await f.root.collection('monthly_reports').get()).size, 0);
      assert.equal((await f.root.collection('attendance').get()).size, 0);
    });
    await check('draft confirms; submitted approved inactive moved and malformed are not eligible', async () => {
      const f = await fixture(), s = f.service(), p = f.people[0]; await f.report(p);
      assert.equal((await s.request(f.req('draft'))).counts.queued, 1);
      assert.equal((await f.intents()).docs[0].data().type, 'report_confirm');
      for (const status of ['submitted', 'approved']) { await f.report(p, status); assert.equal((await s.request(f.req(status))).counts.skipped, 1); }
      await f.report(p, 'draft', { uid: 'different_uid' }); assert.equal((await s.request(f.req('wrong-uid'))).counts.invalid, 1);
      await f.report(p); await db.doc('emp_index/' + p.emp).update({ stationId: 'another_station' });
      assert.equal((await s.request(f.req('moved'))).counts.invalid, 1);
      await f.root.collection('users').doc(p.uid).update({ active: false });
      assert.equal((await s.request(f.req('inactive'))).counts.skipped, 1);
      assert.equal((await f.intents()).size, 1);
    });
    await check('concurrent replay creates one receipt/intent and charges quota only once', async () => {
      const f = await fixture(), s = f.service();
      const values = await Promise.all([s.request(f.req('same')), s.request(f.req('same')), s.request(f.req('same'))]);
      assert.equal(new Set(values.map(v => v.action_id)).size, 1);
      assert.equal((await f.actions()).size, 1); assert.equal((await f.intents()).size, 1);
      assert.equal((await f.quota.get()).data().requests_at_ms.length, 1);
      await rejects(() => s.request(f.req('same', { send_now: true })), 'already-exists');
      authRecords.get(f.actor).disabled = true;
      await rejects(() => s.request(f.req('same')), 'permission-denied');
    });
    await check('rolling ten-action quota permits replay and expires exactly at the minute', async () => {
      const f = await fixture(), s = f.service();
      for (let i = 0; i < 10; ++i) await s.request(f.req('q' + i));
      await rejects(() => s.request(f.req('q10')), 'resource-exhausted');
      await s.request(f.req('q0')); assert.equal((await f.actions()).size, 10);
      f.at += 60000; await s.request(f.req('q10'));
      assert.equal((await f.actions()).size, 11); assert.equal((await f.quota.get()).data().requests_at_ms.length, 1);
    });
    await check('night requires a new confirmed request; unconfirmed receipt owns no bulk lock', async () => {
      const f = await fixture(), s = f.service(); f.at = Date.parse('2026-09-08T20:00:00Z');
      const pending = await s.request(f.req('night', { bulk: true }));
      assert.equal(pending.status, 'confirmation_required'); assert.equal((await f.intents()).size, 0); assert.equal((await f.lock.get()).exists, false);
      await rejects(() => s.request(f.req('night', { bulk: true, send_now: true })), 'already-exists');
      const confirmed = await s.request(f.req('confirmed', { bulk: true, send_now: true }));
      assert.equal(confirmed.status, 'discovering'); assert.equal((await f.lock.get()).exists, true);
      await finishDiscovery(f, s, confirmed);
      assert.equal((await s.processJob(f.job(confirmed))).counts.queued, 1);
    });
    await check('manual confirmation never bypasses silent; only trusted recipient allowance exempts', async () => {
      const f = await fixture(), s = f.service(); f.at = Date.parse('2026-09-08T20:00:00Z');
      await runtimeRef.set({ silent: true, silent_allow: [] });
      const suppressed = await s.request(f.req('silent', { send_now: true }));
      assert.equal(suppressed.counts.suppressed, 1); assert.equal(suppressed.counts.queued, 0);
      await runtimeRef.update({ silent_allow: [f.people[0].uid] });
      assert.equal((await s.request(f.req('allowed', { send_now: true }))).counts.queued, 1);
    });
    await check('missing/malformed config and failed report read never create false missing intents', async () => {
      const f = await fixture(); await runtimeRef.delete();
      await rejects(() => f.service().request(f.req('missing-config')), 'failed-precondition');
      await runtimeRef.set({ silent: 'false' }); await rejects(() => f.service().request(f.req('bad-config')), 'failed-precondition');
      await runtimeRef.set({ silent: false });
      const report = f.root.collection('monthly_reports').doc(f.people[0].emp + '_' + month);
      await rejects(() => f.service({}, failingReadDb(report.path)).request(f.req('failed-read')), 'unavailable');
      assert.equal((await f.actions()).size, 0); assert.equal((await f.intents()).size, 0); assert.equal((await f.quota.get()).exists, false);
    });
    await check('bulk pages are capped at 25 and concurrent workers preserve unique child intents', async () => {
      const f = await fixture({ people: 26 }), s = f.service(), action = await s.request(f.req('bulk', { bulk: true }));
      const discovery = await Promise.all([s.processJob(f.job(action)), s.processJob(f.job(action))]);
      assert.ok(discovery.some(v => v.discovery_scanned === 25 && v.phase === 'discovery'));
      assert.ok(discovery.some(v => v.discovery_scanned === 27 && v.phase === 'enqueue'));
      assert.equal((await f.intents()).size, 0);
      const [a, b] = await Promise.all([s.processJob(f.job(action)), s.processJob(f.job(action))]);
      assert.ok([a, b].some(v => v.counts.scanned === 25));
      assert.ok([a, b].some(v => v.status === 'completed' && v.counts.scanned === 27));
      assert.equal((await f.intents()).size, 26); assert.equal((await f.lock.get()).exists, false);
      await s.processJob(f.job(action)); assert.equal((await f.intents()).size, 26);
    });
    await check('discovery includes highest valid station aliases and whitespace without field filters', async () => {
      const f = await fixture(), s = f.service();
      for (const [suffix, field, value] of [['station', 'station', f.sid], ['station_id', 'station_id', f.sid], ['whitespace', 'stationId', ' ' + f.sid + ' ']]) {
        const p = await f.addPerson('zzzz_' + suffix + '_' + run + '_' + fixtureCount);
        await f.root.collection('users').doc(p.uid).update({ stationId: admin.firestore.FieldValue.delete(), [field]: value });
      }
      const action = await s.request(f.req('aliases', { bulk: true }));
      const reportPath = f.root.collection('monthly_reports').doc(f.people[0].emp + '_' + month).path;
      const ready = await finishDiscovery(f, f.service({}, failingReadDb(reportPath)), action);
      assert.equal(ready.phase, 'enqueue'); assert.equal(ready.discovery_scanned, 5);
      assert.ok(ready.audience_semantics.includes('completed_discovery'));
      const stored = (await f.root.collection('hr_nudge_actions').doc(action.action_id).get()).data();
      assert.ok(stored.max_uid.startsWith('zzzz_whitespace'));
      const result = await s.processJob(f.job(action)); assert.equal(result.counts.queued, 4);
    });
    await check('discovery sees later high keys; an observed deleted maximum remains a valid bound', async () => {
      const f = await fixture({ people: 25, superUser: true }), s = f.service(), action = await s.request(f.req('growth', { bulk: true }));
      const first = await s.processJob(f.job(action)); assert.equal(first.discovery_scanned, 25); assert.equal(first.phase, 'discovery');
      const extra = await f.addPerson('zz_growth_' + run + '_' + fixtureCount);
      const ready = await finishDiscovery(f, s, first); assert.equal(ready.discovery_scanned, 26);
      await s.processJob(f.job(action)); await s.processJob(f.job(action));
      assert.ok((await f.intents()).docs.some(d => d.data().recipient_uid === extra.uid));
      const g = await fixture({ people: 25, superUser: true }), gs = g.service(), deleted = await gs.request(g.req('deleted-high', { bulk: true }));
      await gs.processJob(g.job(deleted)); const maximum = g.people[24];
      await g.root.collection('users').doc(maximum.uid).delete();
      const bound = await gs.processJob(g.job(deleted)); assert.equal(bound.phase, 'enqueue');
      assert.equal((await g.root.collection('hr_nudge_actions').doc(deleted.action_id).get()).data().max_uid, maximum.uid);
      assert.equal((await gs.processJob(g.job(deleted))).counts.queued, 24);
    });
    await check('failed discovery read cannot advance cursor/count or create intents', async () => {
      const f = await fixture({ people: 26 }), s = f.service(), action = await s.request(f.req('discovery-read', { bulk: true }));
      await s.processJob(f.job(action)); const ref = f.root.collection('hr_nudge_actions').doc(action.action_id);
      const before = (await ref.get()).data(), quota = (await f.quota.get()).data();
      const usersQuery = q => typeof q.toProto === 'function' && q.toProto().structuredQuery?.from?.[0]?.collectionId === 'users';
      await rejects(() => f.service({}, failingReadDb(usersQuery)).processJob(f.job(action)), 'unavailable');
      assert.deepEqual((await ref.get()).data(), before); assert.deepEqual((await f.quota.get()).data(), quota);
      assert.equal((await f.intents()).size, 0);
      assert.equal((await s.processJob(f.job(action))).phase, 'enqueue');
    });
    await check('partial discovery expires at the original deadline without producing or reviving intents', async () => {
      const f = await fixture({ people: 26 }), s = f.service(), request = f.req('discovery-expiry', { bulk: true });
      const action = await s.request(request), first = await s.processJob(f.job(action));
      assert.equal(first.discovery_scanned, 25); f.at = action.expires_at_ms;
      const result = await s.request(request); assert.equal(result.status, 'expired_partial');
      assert.equal(result.discovery_scanned, 25); assert.equal(result.counts.scanned, 0);
      assert.equal((await f.intents()).size, 0); assert.equal((await f.lock.get()).exists, false);
      assert.equal((await s.processJob(f.job(action))).status, 'expired_partial');
    });
    await check('completed discovery bound is not a snapshot; enqueue pages recheck active bindings', async () => {
      const f = await fixture({ people: 27 }), s = f.service(), action = await s.request(f.req('bulk', { bulk: true }));
      await finishDiscovery(f, s, action);
      await s.processJob(f.job(action));
      await f.root.collection('users').doc(f.people[25].uid).update({ active: false }); await f.report(f.people[26], 'approved');
      await f.addPerson('aa_late_' + run + '_' + fixtureCount); // Already below cursor: not rescanned.
      await f.addPerson('zzzz_late_' + run + '_' + fixtureCount); // Above completed discovery maximum: excluded.
      const newlyVisible = await f.addPerson('p25z_late_' + run + '_' + fixtureCount); // Unscanned, below bound: included.
      const result = await s.processJob(f.job(action)); assert.equal(result.status, 'completed');
      const recipients = (await f.intents()).docs.map(d => d.data().recipient_uid);
      assert.equal(recipients.length, 26); assert.ok(recipients.includes(newlyVisible.uid));
      assert.equal(recipients.some(uid => uid.startsWith('aa_late') || uid.startsWith('zzzz_late')), false);
      assert.equal(result.counts.skipped, 2);
    });
    await check('page failure commits neither child intents nor cursor; retry resumes once', async () => {
      const f = await fixture({ people: 26 }), s = f.service(), action = await s.request(f.req('bulk', { bulk: true }));
      await finishDiscovery(f, s, action);
      await s.processJob(f.job(action));
      const before = (await f.root.collection('hr_nudge_actions').doc(action.action_id).get()).data();
      await assert.rejects(() => f.service({ beforeWrites({ stage }) { if (stage === 'page') throw new Error('synthetic precommit crash'); } }).processJob(f.job(action)), /synthetic precommit crash/);
      assert.deepEqual((await f.root.collection('hr_nudge_actions').doc(action.action_id).get()).data(), before);
      assert.equal((await f.intents()).size, 25);
      assert.equal((await s.processJob(f.job(action))).status, 'completed'); assert.equal((await f.intents()).size, 26);
    });
    await check('empty signed-super station completes discovery atomically and releases bulk lock', async () => {
      const f = await fixture({ people: 0, superUser: true }), s = f.service(), action = await s.request(f.req('empty', { bulk: true }));
      assert.equal(action.status, 'discovering');
      const result = await s.processJob(f.job(action));
      assert.equal(result.status, 'completed'); assert.equal(result.counts.scanned, 0); assert.equal((await f.lock.get()).exists, false);
    });
    await check('expired partial bulk releases its lock and all child intents share the deadline', async () => {
      const f = await fixture({ people: 26 }), s = f.service(), action = await s.request(f.req('bulk', { bulk: true }));
      await finishDiscovery(f, s, action);
      await s.processJob(f.job(action)); f.at += LIFETIME_MS;
      const result = await s.processJob(f.job(action)); assert.equal(result.status, 'expired_partial');
      assert.equal((await f.lock.get()).exists, false); assert.equal((await f.intents()).size, 25);
      for (const d of (await f.intents()).docs) assert.equal(d.data().expires_at_ms, action.expires_at_ms);
      assert.equal((await s.request(f.req('replacement', { bulk: true }))).status, 'discovering');
    });
    await check('expired matching replay retires same action without quota, preserves newer lock ownership', async () => {
      const f = await fixture({ people: 26 }), s = f.service(), request = f.req('replay-expiry', { bulk: true });
      const action = await s.request(request); await finishDiscovery(f, s, action); await s.processJob(f.job(action));
      const quota = (await f.quota.get()).data();
      const expired = await f.service({ beforeWrites({ stage }) { if (stage === 'replay') f.at = action.expires_at_ms; } }).request(request);
      assert.equal(expired.action_id, action.action_id); assert.equal(expired.status, 'expired_partial');
      assert.equal((await f.lock.get()).exists, false); assert.deepEqual((await f.quota.get()).data(), quota);
      assert.equal((await f.intents()).size, 25);
      const second = await s.request(f.req('second-expiry', { bulk: true }));
      const newer = { action_id: 'f'.repeat(64), action_path: f.root.path + '/hr_nudge_actions/' + 'f'.repeat(64), expires_at_ms: second.expires_at_ms + 1000 };
      await f.lock.set(newer); f.at = second.expires_at_ms;
      assert.equal((await s.request(f.req('second-expiry', { bulk: true }))).status, 'expired');
      assert.deepEqual((await f.lock.get()).data(), newer);
    });
    await check('new bulk atomically retires expired predecessor; stale worker cannot release new lock', async () => {
      const f = await fixture(), s = f.service(), old = await s.request(f.req('old', { bulk: true }));
      await rejects(() => s.request(f.req('duplicate', { bulk: true })), 'already-exists');
      f.at += LIFETIME_MS;
      const fresh = await s.request(f.req('fresh', { bulk: true }));
      assert.equal((await s.processJob(f.job(old))).status, 'expired');
      assert.equal((await f.lock.get()).data().action_id, fresh.action_id);
    });
    await check('fresh Auth read failure preserves job; disabled actor cancels without intents', async () => {
      const f = await fixture(), s = f.service(), action = await s.request(f.req('bulk', { bulk: true })), saved = authRecords.get(f.actor);
      authRecords.set(f.actor, new Error('synthetic Auth unavailable'));
      await rejects(() => s.processJob(f.job(action)), 'unavailable'); assert.equal((await f.intents()).size, 0);
      authRecords.set(f.actor, { ...saved, disabled: true });
      assert.equal((await s.processJob(f.job(action))).status, 'cancelled'); assert.equal((await f.lock.get()).exists, false);
    });
    await check('former super cannot retain profile-free authority after fresh HR downgrade', async () => {
      const f = await fixture({ superUser: true }), s = f.service(), action = await s.request(f.req('bulk', { bulk: true }));
      authRecords.get(f.actor).customClaims = { role: 'hr_coordinator', stationId: f.sid };
      assert.equal((await s.processJob(f.job(action))).status, 'cancelled'); assert.equal((await f.intents()).size, 0);
      await f.root.collection('users').doc(f.actor).set({ stationId: f.sid, role: 'hr_coordinator', active: true });
      const next = await s.request(f.req('valid-hr', { bulk: true }));
      await finishDiscovery(f, s, next);
      assert.equal((await s.processJob(f.job(next))).counts.queued, 1);
    });
    await check('silent flip is freshly applied to each page, without rewriting existing children', async () => {
      const f = await fixture({ people: 26 }), s = f.service(), action = await s.request(f.req('bulk', { bulk: true }));
      await finishDiscovery(f, s, action);
      await s.processJob(f.job(action)); await runtimeRef.set({ silent: true });
      const result = await s.processJob(f.job(action)); assert.equal(result.counts.queued, 25); assert.equal(result.counts.suppressed, 1);
      assert.equal((await f.intents()).size, 26);
    });
    await check('daytime job entering quiet hours defers without intents then expires, never auto-confirms', async () => {
      const f = await fixture(), s = f.service(); f.at = Date.parse('2026-09-08T18:59:00Z');
      const action = await s.request(f.req('before-night', { bulk: true })); f.at += 120000;
      assert.equal((await s.processJob(f.job(action))).status, 'deferred'); assert.equal((await f.intents()).size, 0);
      f.at = action.expires_at_ms; assert.equal((await s.processJob(f.job(action))).status, 'expired');
    });
    await check('global quota and pending actor/month lock cannot be reset by changing station', async () => {
      const f = await fixture(), s = f.service(), action = await s.request(f.req('old-station-bulk', { bulk: true }));
      const other = db.collection('stations').doc(f.sid + '_other'); roots.push(other);
      await other.collection('users').doc(f.actor).set({ stationId: other.id, role: 'hr_coordinator', active: true });
      authRecords.get(f.actor).customClaims = { stationId: other.id, role: 'hr_coordinator' };
      const changed = id => ({ auth: { uid: f.actor, token: { stationId: other.id, role: 'hr_coordinator', auth_time: f.authTime } }, data: { month, request_id: id, send_now: false } });
      await rejects(() => s.request(changed('second-bulk')), 'already-exists');
      assert.equal((await f.quota.get()).data().requests_at_ms.length, 1);
      assert.equal((await s.processJob(f.job(action))).status, 'cancelled');
      const next = await s.request(changed('second-bulk')); assert.equal(next.station_id, other.id);
      for (let i = 0; i < 8; ++i) await s.request({ ...changed('second-single-' + i), data: { ...changed('x').data, request_id: 'second-single-' + i, uid: 'missing-person' } });
      await rejects(() => s.request({ ...changed('quota-reset'), data: { ...changed('quota-reset').data, uid: 'missing-person' } }), 'resource-exhausted');
    });
    console.log('HR hours nudge integration: ' + passed + '/' + passed + ' passed; no FCM/export/production calls.');
  } finally {
    for (const root of roots) {
      assert.ok(root.id.startsWith('hr_nudge_it_' + run)); await db.recursiveDelete(root);
    }
    for (const ref of globals.values()) await ref.delete();
    if (priorRuntime) { if (priorRuntime.exists) await runtimeRef.set(priorRuntime.data()); else await runtimeRef.delete(); }
    await app.delete();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
