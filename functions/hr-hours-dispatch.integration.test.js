'use strict';
const assert = require('node:assert/strict');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Use the private loopback emulator only');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq', 'Use demo-resq only');
process.env.METADATA_SERVER_DETECTION = 'none';
const { randomBytes, createHash } = require('node:crypto');
const admin = require('firebase-admin');
const { createHrHoursNudges } = require('./hr-hours-nudges');
const { createHrHoursDispatch, LIMITS } = require('./hr-hours-dispatch');
const app = admin.initializeApp({ projectId: 'demo-resq' }, 'hr-dispatch-' + process.pid), db = app.firestore();
const runId = randomBytes(6).toString('hex'), runtime = db.doc('config/runtime');
const authTime = Date.parse('2026-09-01T00:00:00Z') / 1000;
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
let count = 0, passed = 0, priorRuntime;
const selected = process.env.HR_DISPATCH_TEST_FILTER || '';
const owned = [], globals = new Map(), records = new Map();
const auth = { async getUser(uid) { const value = records.get(uid); if (value instanceof Error) throw value;
  if (!value) throw Object.assign(new Error('synthetic missing Auth'), { code: 'auth/user-not-found' }); return structuredClone(value); } };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const track = path => { const ref = db.doc(path); globals.set(path, ref); return ref; };
const accepted = payload => ({ responses: payload.tokens.map((_, i) => ({ success: true, messageId: 'synthetic/' + i })) });
async function fixture(n = 1) {
  const key = runId + '_' + (++count), sid = 'hr_dispatch_it_' + key, actor = 'ha_' + key;
  const root = db.doc('stations/' + sid); owned.push(root);
  const claims = { stationId: sid, role: 'hr_coordinator' };
  records.set(actor, { uid: actor, disabled: false, customClaims: claims });
  await root.collection('users').doc(actor).set({ stationId: sid, role: 'hr_coordinator', active: true });
  const f = { key, sid, actor, root, people: [], at: Date.parse('2026-09-08T09:00:00Z'), calls: [] };
  for (let i = 0; i < n; ++i) {
    const uid = 'hp_' + key + '_' + i, emp = 'he_' + key + '_' + i;
    records.set(uid, { uid, disabled: false, customClaims: { stationId: sid, role: 'firefighter' } });
    await root.collection('users').doc(uid).set({ stationId: sid, role: 'firefighter', active: true, employee_number: emp, full_name: 'PRIVATE_SYNTHETIC_NAME' });
    await track('emp_index/' + emp).set({ uid, stationId: sid, active: true });
    await track('directory/' + uid).set({ station: sid, active: true });
    const token = 'synthetic-token-' + uid;
    await root.collection('push_tokens').doc(uid).set({ tokens: [{ token, label: 'Synthetic', added: 1 }], prefs: { report_mine: false } });
    f.people.push({ uid, emp, token });
  }
  track('hr_nudge_actor_quotas/' + hash(['hr-quota-v1', actor]));
  track('hr_nudge_bulk_locks/' + hash(['hr-bulk-v1', actor, '2026-09']));
  f.nudges = createHrHoursNudges({ db, auth, HttpsError, clock: () => f.at });
  f.request = async (id = 'one', bulk = false) => f.nudges.request({ auth: { uid: actor, token: { ...claims, auth_time: authTime } },
    data: { month: '2026-09', request_id: id, send_now: false, ...(!bulk ? { uid: f.people[0].uid } : {}) } });
  f.seed = async () => { const a = await f.request('bulk', true); let result = a;
    for (let i = 0; i < 30 && !['completed', 'cancelled'].includes(result.status); ++i) result = await f.nudges.processJob({ stationId: sid, action_id: a.action_id });
    assert.equal(result.status, 'completed'); return a; };
  f.intents = () => root.collection('hr_nudge_intents').get();
  f.intent = async () => { const q = await f.intents(); assert.equal(q.size, 1); return q.docs[0]; };
  f.tokens = (i, values) => root.collection('push_tokens').doc(f.people[i].uid).set({ tokens: values.map(token => ({ token })), prefs: { report_mine: false } });
  f.report = (i, status) => root.collection('monthly_reports').doc(f.people[i].emp + '_2026-09').set({ uid: f.people[i].uid,
    emp_number: f.people[i].emp, month: '2026-09', status, days: [], total_hours: 0 });
  f.worker = ({ send = accepted, hooks = {}, database = db, processJob = f.nudges.processJob } = {}) => createHrHoursDispatch({ db: database,
    auth, HttpsError, clock: () => f.at, processJob, hooks, messaging: { async sendEachForMulticast(p) { f.calls.push(p); return send(p); } } });
  return f;
}
async function cleanup() {
  for (const ref of owned.splice(0)) { assert.ok(ref.id.startsWith('hr_dispatch_it_' + runId)); await db.recursiveDelete(ref); }
  for (const ref of globals.values()) await ref.delete(); globals.clear(); records.clear();
}
async function check(name, body) {
  if (selected && !name.includes(selected)) return;
  await runtime.set({ silent: false, silent_allow: [] });
  try { await body(); ++passed; console.log('PASS ' + name); } finally { await cleanup(); }
}
function failedRead(path) {
  return { collectionGroup: db.collectionGroup.bind(db), doc: db.doc.bind(db), collection: db.collection.bind(db),
    runTransaction: fn => db.runTransaction(tx => fn(new Proxy(tx, { get(target, key) {
      if (key === 'get') return ref => ref.path === path ? Promise.reject(new Error('PRIVATE_IO_ERROR')) : target.get(ref);
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }))) };
}
(async () => {
  try {
    priorRuntime = await runtime.get();
    console.log(JSON.stringify({ run: runId, prior_runtime: priorRuntime.exists ? priorRuntime.data() : null }));
    await check('existing token format/category and generic data-only payload accepted without delivery claim', async () => {
      const f = await fixture(); await f.request(); const result = await f.worker().run();
      assert.equal(result.transport_calls, 1); assert.equal(result.device_starts, 1); assert.equal(f.calls.length, 1);
      const p = f.calls[0]; assert.deepEqual(Object.keys(p.data).sort(), ['body', 'important', 'tag', 'title', 'url']);
      assert.equal(p.data.url, './attendance.html'); assert.equal(p.data.important, '0'); assert.equal(p.webpush.headers.Urgency, 'normal');
      assert.equal(JSON.stringify(p).includes('PRIVATE_SYNTHETIC_NAME'), false);
      const i = (await f.intent()).data(); assert.equal(i.status, 'accepted'); assert.equal(i.delivery_status, 'provider_outcome_only');
      assert.equal(JSON.stringify(i).includes(f.people[0].token), false); assert.equal(i.outcome_counts.accepted, 1);
      await f.worker().run(); assert.equal(f.calls.length, 1, 'accepted intent never resent');
    });
    await check('two concurrent workers atomically claim one intent', async () => {
      const f = await fixture(); await f.request(); const w = f.worker();
      await Promise.all([w.run(), w.run()]); assert.equal(f.calls.length, 1); assert.equal((await f.intent()).data().status, 'accepted');
    });
    await check('fresh actor Auth revocation and HR profile removal prevent dispatch', async () => {
      const f = await fixture(); await f.request(); records.get(f.actor).tokensValidAfterTime = new Date((authTime + 1) * 1000).toUTCString();
      await f.worker().run(); assert.equal(f.calls.length, 0); assert.equal((await f.intent()).data().status, 'cancelled');
      delete records.get(f.actor).tokensValidAfterTime; await f.request('again');
      await f.root.collection('users').doc(f.actor).delete(); await f.worker().run(); assert.equal(f.calls.length, 0);
      assert.ok((await f.intents()).docs.every(d => d.data().status === 'cancelled'));
    });
    await check('fresh recipient disabled or station change prevents dispatch', async () => {
      const f = await fixture(2); await f.seed(); records.get(f.people[0].uid).disabled = true;
      records.get(f.people[1].uid).customClaims.stationId = 'different_station';
      await f.worker().run(); assert.equal(f.calls.length, 0); assert.ok((await f.intents()).docs.every(d => d.data().status === 'cancelled'));
    });
    await check('canonical binding and completed report cancel only affected recipients', async () => {
      const f = await fixture(3); await f.seed(); await f.report(0, 'approved');
      await db.doc('emp_index/' + f.people[1].emp).update({ stationId: 'different_station' });
      await f.worker().run(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].tokens, [f.people[2].token]);
    });
    await check('missing to draft derives current title/type but preserves original event/tag', async () => {
      const f = await fixture(); await f.request(); const original = (await f.intent()).data(); await f.report(0, 'draft');
      await f.worker().run(); const current = (await f.intent()).data();
      assert.equal(current.dispatch_type, 'report_confirm'); assert.equal(current.type, original.type);
      assert.equal(current.id, original.id); assert.equal(current.event_id, original.event_id); assert.equal(f.calls[0].data.tag, 'hr-' + original.id);
    });
    await check('fresh silent suppresses and current UID allowance alone exempts', async () => {
      const f = await fixture(2); await f.seed(); await runtime.set({ silent: true, silent_allow: [f.people[1].uid] });
      await f.worker().run(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].tokens, [f.people[1].token]);
      assert.ok((await f.intents()).docs.some(d => d.data().status === 'suppressed'));
    });
    await check('runtime or report read failure blocks with backoff, never false missing/send', async () => {
      const f = await fixture(); await f.request(); const ref = (await f.intent()).ref;
      await runtime.set({ silent: 'false' }); await f.worker().run();
      let blocked = (await ref.get()).data(); assert.equal(blocked.status, 'blocked'); assert.ok(blocked.next_check_ms > f.at); assert.equal(f.calls.length, 0);
      await runtime.set({ silent: false }); f.at = blocked.next_check_ms;
      await f.worker({ database: failedRead(f.root.path + '/monthly_reports/' + f.people[0].emp + '_2026-09') }).run();
      blocked = (await ref.get()).data(); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.dispatch_check_count, 2); assert.equal(f.calls.length, 0);
      f.at = blocked.next_check_ms; await f.worker().run(); assert.equal(f.calls.length, 1);
    });
    await check('quiet crossing at final claim defers and expiry is swept before next morning', async () => {
      const f = await fixture(); f.at = Date.parse('2026-09-08T18:59:59Z'); const a = await f.request();
      await f.worker({ hooks: { beforeClaim() { f.at = Date.parse('2026-09-08T19:00:01Z'); } } }).run();
      assert.equal(f.calls.length, 0); assert.equal((await f.intent()).data().status, 'deferred');
      f.at = a.expires_at_ms; await f.worker().run(); assert.equal((await f.intent()).data().status, 'cancelled'); assert.equal(f.calls.length, 0);
    });
    await check('clock crossing after durable claim but before SDK cancels a known unstarted call', async () => {
      const f = await fixture(); f.at = Date.parse('2026-09-08T18:59:59Z'); await f.request();
      const result = await f.worker({ hooks: { afterClaim() { f.at = Date.parse('2026-09-08T19:00:01Z'); } } }).run();
      assert.equal(f.calls.length, 0); assert.equal(result.transport_calls, 0); assert.equal((await f.intent()).data().status, 'cancelled');
    });
    await check('partial fulfilled batch keeps accepted, rejected and network-unknown device outcomes', async () => {
      const f = await fixture(); await f.tokens(0, ['tok-a', 'tok-b', 'tok-c']); await f.request();
      await f.worker({ send: () => ({ responses: [{ success: true, messageId: 'ok' },
        { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'PRIVATE_TOKEN_ERROR' } },
        { success: false, error: { code: 'app/network-error', message: 'PRIVATE_NETWORK_ERROR' } }] }) }).run();
      const i = (await f.intent()).data(); assert.equal(i.status, 'outcome_unknown');
      assert.deepEqual(i.outcome_counts, { accepted: 1, failed: 1, outcome_unknown: 1 });
      assert.equal(JSON.stringify(i).includes('PRIVATE_'), false); await f.worker().run(); assert.equal(f.calls.length, 1);
    });
    await check('thrown or malformed final batch is unknown and never automatically replayed', async () => {
      const f = await fixture(); await f.request(); await f.worker({ send() { throw new Error('PRIVATE_THROW'); } }).run();
      assert.equal((await f.intent()).data().status, 'outcome_unknown'); await f.worker().run(); assert.equal(f.calls.length, 1);
      await f.request('malformed'); await f.worker({ send: () => ({ responses: [] }) }).run();
      assert.ok((await f.intents()).docs.every(d => d.data().status === 'outcome_unknown'));
    });
    await check('crash before SDK leaves attempting then unknown, never a new send', async () => {
      const f = await fixture(); await f.request(); await f.worker({ hooks: { afterClaim() { throw new Error('synthetic crash'); } } }).run();
      assert.equal(f.calls.length, 0); assert.equal((await f.intent()).data().status, 'attempting');
      f.at += LIMITS.leaseMs; await f.worker().run(); assert.equal((await f.intent()).data().status, 'outcome_unknown'); assert.equal(f.calls.length, 0);
    });
    await check('accepted-before-ack crash and late same-attempt callback cannot replace unknown', async () => {
      const f = await fixture(); await f.request(); let release, entered;
      const atSend = new Promise(resolve => { entered = resolve; });
      const running = f.worker({ send: p => new Promise(resolve => { release = () => resolve(accepted(p)); entered(); }) }).run();
      await atSend; f.at += LIMITS.leaseMs; await f.worker().run(); assert.equal((await f.intent()).data().status, 'outcome_unknown');
      release(); await running; assert.equal((await f.intent()).data().status, 'outcome_unknown'); assert.equal(f.calls.length, 1);
      await f.request('post-ack-crash'); await f.worker({ hooks: { afterSend() { throw new Error('synthetic post-send crash'); } } }).run();
      assert.ok((await f.intents()).docs.some(d => d.data().status === 'attempting'));
    });
    await check('stale finalizer cannot overwrite another attempt token', async () => {
      const f = await fixture(); await f.request();
      await f.worker({ hooks: { async afterSend({ path }) { await db.doc(path).update({ attempt_id: 'newer-attempt', status: 'outcome_unknown' }); } } }).run();
      const i = (await f.intent()).data(); assert.equal(i.attempt_id, 'newer-attempt'); assert.equal(i.status, 'outcome_unknown');
    });
    await check('transport never edits token document, including concurrently registered tokens', async () => {
      const f = await fixture(); await f.request();
      await f.worker({ send: async () => { await f.tokens(0, ['new-token', f.people[0].token]);
        return { responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }] }; } }).run();
      const tokens = (await f.root.collection('push_tokens').doc(f.people[0].uid).get()).data().tokens;
      assert.deepEqual(tokens.map(v => v.token), ['new-token', f.people[0].token]); assert.equal((await f.intent()).data().status, 'failed');
    });
    await check('device budget sums recipient sends, deduplicates within recipient, defers whole overflow', async () => {
      const f = await fixture(2); await f.tokens(0, Array.from({ length: 300 }, (_, i) => 'a-' + i));
      await f.tokens(1, Array.from({ length: 250 }, (_, i) => 'b-' + i)); await f.seed();
      const first = await f.worker().run(); assert.ok([250, 300].includes(first.device_starts)); assert.equal(f.calls.length, 1);
      assert.equal((await f.intents()).docs.filter(d => d.data().status === 'queued').length, 1);
      await f.worker().run(); assert.equal(f.calls.length, 2); assert.equal(f.calls.reduce((n, p) => n + p.tokens.length, 0), 550);
    });
    await check('oversized tokens visible-block without truncation and no-device stays explicit', async () => {
      const f = await fixture(3); await f.tokens(0, Array.from({ length: 501 }, (_, i) => 'oversize-' + i));
      await f.tokens(1, []); await f.tokens(2, ['same', 'same']); await f.seed(); await f.worker().run();
      assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].tokens, ['same']);
      const all = (await f.intents()).docs.map(d => d.data()); assert.ok(all.some(i => i.status === 'blocked' && i.reason === 'token-limit' && i.terminal));
      assert.ok(all.some(i => i.status === 'no_device')); await f.worker().run(); assert.equal(f.calls.length, 1);
    });
    await check('max five recipients in flight and twenty-five intents checked per invocation', async () => {
      const f = await fixture(30); await f.seed(); let active = 0, maximum = 0, entered, release, holding = true;
      const five = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
      const worker = f.worker({ send: async p => { ++active; maximum = Math.max(maximum, active);
        if (active === 5) entered(); if (holding) await barrier; --active; return accepted(p); } });
      const running = worker.run(); await five; assert.equal(f.calls.length, 5); holding = false; release();
      const result = await running; assert.equal(maximum, 5); assert.equal(result.intents_checked, 25); assert.equal(f.calls.length, 25);
      await worker.run(); assert.equal(f.calls.length, 30);
    });
    await check('sixty-second start budget prevents subsequent recipient SDK starts', async () => {
      const f = await fixture(8); await f.seed();
      await f.worker({ send: p => { f.at += LIMITS.startBudgetMs; return accepted(p); } }).run();
      assert.ok(f.calls.length >= 1 && f.calls.length <= 5);
      assert.ok((await f.intents()).docs.some(d => d.data().status === 'queued' || d.data().status === 'cancelled'));
    });
    await check('closed-browser worker advances real discovery/enqueue with per-action page cap', async () => {
      const f = await fixture(70), a = await f.request('auto-progress', true); const result = await f.worker().run();
      assert.ok(result.action_pages <= 5); const saved = (await f.root.collection('hr_nudge_actions').doc(a.action_id).get()).data();
      assert.equal(saved.expires_at_ms, a.expires_at_ms); assert.ok(saved.discovery_scanned > 0);
      await f.worker().run(); assert.equal((await f.root.collection('hr_nudge_actions').doc(a.action_id).get()).data().status, 'completed');
    });
    await check('active action backoff preserves producer replay/lock and rotates a blocked oldest head', async () => {
      const f = await fixture(2), a = await f.request('pending', true), ref = f.root.collection('hr_nudge_actions').doc(a.action_id);
      const before = (await ref.get()).data(); await f.worker({ processJob: async () => { throw new Error('synthetic page dependency'); } }).run();
      const blocked = (await ref.get()).data(); assert.equal(blocked.status, before.status); assert.ok(blocked.dispatch_next_check_ms > f.at);
      for (const key of ['phase', 'cursor', 'discovery_cursor', 'expires_at_ms']) assert.equal(blocked[key], before[key]);
      assert.equal((await f.request('pending', true)).action_id, a.action_id);
      await assert.rejects(() => f.request('second', true), e => e.code === 'already-exists');
      f.at += 1; await f.worker().run(); assert.equal((await ref.get()).data().updated_at_ms, f.at);
      f.at = blocked.dispatch_next_check_ms; await f.worker().run(); assert.ok((await ref.get()).data().discovery_scanned > 0);
    });
    await check('action terminal state racing with backoff cannot be resurrected', async () => {
      const f = await fixture(), a = await f.request('race', true), ref = f.root.collection('hr_nudge_actions').doc(a.action_id);
      await f.worker({ processJob: async () => { await ref.update({ status: 'cancelled' }); throw new Error('synthetic failure after terminal'); } }).run();
      assert.equal((await ref.get()).data().status, 'cancelled'); assert.equal((await ref.get()).data().dispatch_next_check_ms, undefined);
    });
    await check('rotation fairness: 25 failed expired-deferred heads cannot hide healthy 26th cleanup', async () => {
      const fixtures = [];
      for (let i = 0; i < 26; ++i) fixtures.push(await fixture(0));
      // All real deferrals have the same next morning. Choose the lexically
      // last station as healthy so it is also beyond the first fixed due page.
      const healthy = [...fixtures].sort((a, b) => a.root.path < b.root.path ? -1 : 1).at(-1);
      const byStation = new Map(fixtures.map(f => [f.sid, f])), actions = new Map();
      for (let i = 0; i < fixtures.length; ++i) {
        const f = fixtures[i]; f.at = Date.parse('2026-09-08T18:58:00Z') + (f === healthy ? 50000 : i * 1000);
        const a = await f.request('fair-expired', true); actions.set(f.sid, a);
        f.at = Date.parse('2026-09-08T19:01:00Z');
        assert.equal((await f.nudges.processJob({ stationId: f.sid, action_id: a.action_id })).status, 'deferred');
      }
      for (const f of fixtures) { f.at = Date.parse('2026-09-09T05:00:00Z');
        if (f !== healthy) records.set(f.actor, new Error('synthetic unavailable Auth')); }
      const healthyAction = actions.get(healthy.sid), healthyRef = healthy.root.collection('hr_nudge_actions').doc(healthyAction.action_id);
      for (const field of ['expires_at_ms', 'not_before_ms']) {
        const first = await db.collectionGroup('hr_nudge_actions').where('status', '==', 'deferred')
          .where(field, '<=', healthy.at).orderBy(field).limit(25).get();
        assert.equal(first.size, 25); assert.equal(first.docs.some(d => d.ref.path === healthyRef.path), false, 'healthy job starts outside fixed first pages');
      }
      let healthyCalls = 0;
      const worker = fixtures[0].worker({ processJob: input => { const f = byStation.get(input.stationId);
        assert.ok(f); if (f === healthy) ++healthyCalls; return f.nudges.processJob(input); } });
      for (let i = 0; i < 3; ++i) { await worker.run(); for (const f of fixtures) f.at += 1000; }
      assert.ok(healthyCalls > 0, 'healthy 26th expired-deferred action must be reached');
      assert.equal((await healthyRef.get()).data().status, 'expired');
      const lock = db.doc('hr_nudge_bulk_locks/' + hash(['hr-bulk-v1', healthy.actor, '2026-09']));
      assert.equal((await lock.get()).exists, false); assert.equal(fixtures.reduce((n, f) => n + f.calls.length, 0), 0);
    });
    await check('rotation fairness: future deferred heads rotate without processing or extending lifetime', async () => {
      const sleeping = [];
      for (let i = 0; i < 25; ++i) {
        const f = await fixture(0); f.at = Date.parse('2026-09-08T18:59:00Z');
        const a = await f.request('sleeping', true); f.at = Date.parse('2026-09-08T19:01:00Z');
        await f.nudges.processJob({ stationId: f.sid, action_id: a.action_id });
        const ref = f.root.collection('hr_nudge_actions').doc(a.action_id);
        sleeping.push({ f, ref, before: (await ref.get()).data() });
      }
      const healthy = await fixture(0); healthy.at = Date.parse('2026-09-08T19:05:00Z');
      const a = await healthy.nudges.request({ auth: { uid: healthy.actor, token: { stationId: healthy.sid, role: 'hr_coordinator', auth_time: authTime } },
        data: { month: '2026-09', request_id: 'confirmed-live', send_now: true } });
      const all = [...sleeping.map(x => x.f), healthy]; all.forEach(f => { f.at = Date.parse('2026-09-08T19:06:00Z'); });
      let futureCalls = 0;
      const worker = healthy.worker({ processJob: input => {
        if (input.stationId !== healthy.sid) { ++futureCalls; throw new Error('future deferred must not be processed'); }
        return healthy.nudges.processJob(input);
      } });
      await worker.run(); all.forEach(f => { f.at += 1000; }); await worker.run();
      assert.equal(futureCalls, 0);
      assert.equal((await healthy.root.collection('hr_nudge_actions').doc(a.action_id).get()).data().status, 'completed');
      for (const { ref, before } of sleeping) {
        const after = (await ref.get()).data();
        for (const key of ['status', 'phase', 'cursor', 'discovery_cursor', 'created_at_ms', 'expires_at_ms', 'confirmation_expires_at_ms', 'not_before_ms']) assert.equal(after[key], before[key]);
        assert.ok(after.updated_at_ms > before.updated_at_ms, 'future head rotated by actual check time');
      }
      assert.equal(all.reduce((n, f) => n + f.calls.length, 0), 0);
    });
    assert.ok(passed > 0, 'selected filter must execute at least one test');
    console.log('HR hours dispatcher integration: ' + passed + '/' + passed + ' PASS; scope=' + (selected || 'all') + '; synthetic transport only.');
  } finally {
    await cleanup();
    if (priorRuntime) { if (priorRuntime.exists) await runtime.set(priorRuntime.data()); else await runtime.delete(); }
    await app.delete();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
