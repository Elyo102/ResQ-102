'use strict';
const assert = require('node:assert/strict');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Private emulator only');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq', 'Demo project only');
process.env.METADATA_SERVER_DETECTION = 'none';
const { randomBytes, createHash } = require('node:crypto');
const admin = require('firebase-admin');
const { createHrHoursNudges } = require('./hr-hours-nudges');
const { createHrHoursNudgeStatus, PAGE_SIZE } = require('./hr-hours-nudge-status');
const app = admin.initializeApp({ projectId: 'demo-resq' }, 'hr-nudge-status-' + process.pid), db = app.firestore();
const run = randomBytes(6).toString('hex'), roots = [], globals = new Map(), records = new Map();
const MONTH = '2026-09', AUTH_TIME = Date.parse('2026-09-01T00:00:00Z') / 1000;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const runtime = db.doc('config/runtime');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const auth = { async getUser(uid) { const value = records.get(uid); if (value instanceof Error) throw value;
  if (!value) throw Object.assign(new Error('synthetic missing account'), { code: 'auth/user-not-found' }); return structuredClone(value); } };
let sequence = 0, passed = 0, priorRuntime;
async function tracked(path, value) { const ref = db.doc(path); globals.set(path, ref); if (value !== undefined) await ref.set(value); return ref; }
async function fixture(people = 1, superUser = false) {
  const key = run + '_' + (++sequence), sid = 'hr_status_it_' + key, uid = 'actor_' + key, root = db.doc('stations/' + sid);
  roots.push(root);
  const claims = superUser ? { stationId: sid, super: true } : { stationId: sid, role: 'hr_coordinator' };
  records.set(uid, { uid, disabled: false, customClaims: { ...claims }, tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() });
  if (!superUser) await root.collection('users').doc(uid).set({ stationId: sid, role: 'hr_coordinator', active: true });
  const f = { sid, uid, root, claims, people: [], at: Date.parse('2026-09-08T09:00:00Z'), authTime: AUTH_TIME };
  for (let i = 0; i < people; ++i) {
    const person = 'person' + String(i).padStart(2, '0') + '_' + key, emp = 'emp_' + person;
    await root.collection('users').doc(person).set({ stationId: sid, role: 'firefighter', active: true, employee_number: emp });
    await tracked('emp_index/' + emp, { uid: person, stationId: sid, active: true });
    await tracked('directory/' + person, { station: sid, active: true }); f.people.push(person);
  }
  f.quota = await tracked('hr_nudge_actor_quotas/' + hash(['hr-quota-v1', uid]));
  f.lock = await tracked('hr_nudge_bulk_locks/' + hash(['hr-bulk-v1', uid, MONTH]));
  f.req = data => ({ auth: { uid, token: { ...claims, auth_time: f.authTime } }, data });
  f.producer = createHrHoursNudges({ db, auth, HttpsError, clock: () => f.at });
  f.make = (request_id = 'action-001', extra = {}) => f.producer.request(f.req({ month: MONTH, request_id, send_now: false, uid: f.people[0], ...extra }));
  f.bulk = (request_id = 'bulk-001') => f.producer.request(f.req({ month: MONTH, request_id, send_now: false }));
  f.ref = action => root.collection('hr_nudge_actions').doc(action.action_id);
  f.intents = () => root.collection('hr_nudge_intents').get();
  f.status = (hooks = {}, database = readOnlyDb()) => createHrHoursNudgeStatus({ db: database, auth, HttpsError, hooks });
  return f;
}
// Only the status factory receives this port. Any accidental direct or
// transactional write is a hard test failure, not silently discarded.
function readOnlyDb(fail = null) {
  const wrapRef = ref => new Proxy(ref, { get(target, key) {
    if (['set', 'update', 'create', 'delete', 'add'].includes(key)) return () => { throw new Error('STATUS_WRITE_FORBIDDEN'); };
    if (['collection', 'doc', 'where', 'orderBy', 'limit', 'startAfter'].includes(key)) return (...args) => wrapRef(target[key](...args));
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { collection: (...args) => wrapRef(db.collection(...args)), doc: (...args) => wrapRef(db.doc(...args)),
    runTransaction: fn => db.runTransaction(tx => fn(new Proxy(tx, { get(target, key) {
      if (['set', 'update', 'create', 'delete'].includes(key)) return () => { throw new Error('STATUS_WRITE_FORBIDDEN'); };
      if (key === 'get') return ref => fail && fail(ref) ? Promise.reject(Object.assign(new Error('synthetic unavailable'), { code: 'unavailable' })) : target.get(ref);
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }))) };
}
async function cleanup() {
  for (const root of roots.splice(0)) { assert.ok(root.id.startsWith('hr_status_it_' + run)); await db.recursiveDelete(root); }
  for (const ref of globals.values()) await ref.delete(); globals.clear(); records.clear();
}
async function check(name, test) {
  await runtime.set({ silent: false, silent_allow: [] });
  try { await test(); ++passed; console.log('PASS ' + name); } finally { await cleanup(); }
}
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
async function snapshot(f) {
  const all = await Promise.all([f.root.collection('hr_nudge_actions').get(), f.intents(), f.quota.get(), f.lock.get(), runtime.get()]);
  return all.map(s => s.docs ? s.docs.map(d => [d.id, d.data()]) : s.exists ? s.data() : null);
}
(async () => {
  try {
    priorRuntime = await runtime.get(); console.log(JSON.stringify({ run, prior_runtime: priorRuntime.exists ? priorRuntime.data() : null }));
    await check('actual producer action/intent read with generation-only labels and zero status writes', async () => {
      const f = await fixture(), action = await f.make(), before = await snapshot(f), s = f.status();
      const list = await s.list(f.req({ month: MONTH })), detail = await s.get(f.req({ action_id: action.action_id }));
      assert.equal(list.items.length, 1); assert.equal(detail.action.status, 'completed');
      assert.equal(detail.action.status_scope, 'generation_only'); assert.equal(detail.action.delivery_status, 'intent_only');
      assert.equal(detail.items[0].status, 'queued'); assert.equal(detail.items[0].outcome_counts, null);
      assert.equal(detail.outcomes_scope, 'this_page_only'); assert.deepEqual(await snapshot(f), before);
    });
    await check('closed inputs and HR or signed-super authority only', async () => {
      const f = await fixture(), s = f.status();
      await rejects(() => s.list({ data: { month: MONTH } }), 'unauthenticated');
      for (const token of [{ role: 'station_commander' }, { role: 'super_admin' }, { role: 'firefighter', super: 'true', email: 'admin@example.invalid' }]) {
        const req = f.req({ month: MONTH }); Object.assign(req.auth.token, token); await rejects(() => s.list(req), 'permission-denied');
      }
      for (const auth_time of [undefined, null, -1, 1.5, '1000']) { const req = f.req({ month: MONTH }); req.auth.token.auth_time = auth_time; await rejects(() => s.list(req), 'unauthenticated'); }
      for (const data of [{ month: '2026-13' }, { month: MONTH, stationId: f.sid }, { month: MONTH, cursor: '../bad' }, { month: MONTH, cursor: null }]) await rejects(() => s.list(f.req(data)), 'invalid-argument');
      for (const data of [{ action_id: '../bad' }, { action_id: 'a'.repeat(64), month: MONTH }, { action_id: 'a'.repeat(64), cursor: '../bad' }]) await rejects(() => s.get(f.req(data)), 'invalid-argument');
    });
    await check('own-actor scope excludes other HR and signed-super actions even in same station', async () => {
      const f = await fixture(), action = await f.make();
      const otherUid = 'other_' + f.sid;
      records.set(otherUid, { uid: otherUid, disabled: false, customClaims: { stationId: f.sid, super: true } });
      const req = data => ({ auth: { uid: otherUid, token: { stationId: f.sid, super: true, auth_time: AUTH_TIME } }, data });
      assert.equal((await f.status().list(req({ month: MONTH }))).items.length, 0);
      await rejects(() => f.status().get(req({ action_id: action.action_id })), 'not-found');
      const g = await fixture(); await rejects(() => g.status().get(g.req({ action_id: action.action_id })), 'not-found');
    });
    await check('current disabled, moved, demoted, revoked and malformed Auth denied', async () => {
      const f = await fixture(), action = await f.make(), s = f.status(), original = structuredClone(records.get(f.uid));
      for (const change of [{ disabled: true }, { customClaims: { stationId: 'foreign', role: 'hr_coordinator' } },
        { customClaims: { stationId: f.sid, role: 'firefighter' } }, { tokensValidAfterTime: new Date((AUTH_TIME + 1) * 1000).toUTCString() }]) {
        records.set(f.uid, { ...original, ...change }); await rejects(() => s.get(f.req({ action_id: action.action_id })), 'permission-denied');
      }
      for (const marker of [null, '', 'bad-marker', 1000]) { records.set(f.uid, { ...original, tokensValidAfterTime: marker }); await rejects(() => s.list(f.req({ month: MONTH })), 'unavailable'); }
      records.set(f.uid, new Error('synthetic Auth outage')); await rejects(() => s.list(f.req({ month: MONTH })), 'unavailable');
      records.set(f.uid, original); await s.get(f.req({ action_id: action.action_id }));
      await f.root.collection('users').doc(f.uid).update({ active: false }); await rejects(() => s.list(f.req({ month: MONTH })), 'permission-denied');
    });
    await check('fresh authorized login reads old revoked action without reviving it or releasing its lock', async () => {
      const f = await fixture(), action = await f.bulk(), ref = f.ref(action); f.at += 3600001;
      records.get(f.uid).tokensValidAfterTime = new Date((AUTH_TIME + 100) * 1000).toUTCString(); f.authTime = AUTH_TIME + 100;
      const before = await snapshot(f), detail = await f.status().get(f.req({ action_id: action.action_id }));
      assert.equal(detail.action.status, 'discovering'); assert.equal((await ref.get()).data().actor_auth_time, AUTH_TIME);
      assert.deepEqual(await snapshot(f), before); assert.equal((await f.lock.get()).exists, true);
      await rejects(() => f.producer.request(f.req({ month: MONTH, request_id: 'bulk-001', send_now: false })), 'permission-denied');
    });
    await check('profile-free signed super reads own history but changed super claim cannot bypass HR profile', async () => {
      const f = await fixture(1, true), action = await f.make(); await f.status().get(f.req({ action_id: action.action_id }));
      records.get(f.uid).customClaims = { stationId: f.sid, role: 'hr_coordinator' };
      await rejects(() => f.status().get(f.req({ action_id: action.action_id })), 'permission-denied');
      const req = f.req({ action_id: action.action_id }); delete req.auth.token.super; req.auth.token.role = 'hr_coordinator';
      await rejects(() => f.status().get(req), 'permission-denied');
    });
    await check('final actor fence clears stale authorization and parent ownership changes reject result', async () => {
      const f = await fixture(), action = await f.make();
      await rejects(() => f.status({ beforeFinalize() { records.get(f.uid).disabled = true; } }).get(f.req({ action_id: action.action_id })), 'permission-denied');
      records.get(f.uid).disabled = false;
      await rejects(() => f.status({ async beforeFinalize() { await f.ref(action).update({ actor_uid: 'other_actor' }); } }).get(f.req({ action_id: action.action_id })), 'not-found');
      await f.ref(action).update({ actor_uid: f.uid });
      await rejects(() => f.status({ async beforeFinalize() { await f.ref(action).delete(); } }).list(f.req({ month: MONTH })), 'not-found');
    });
    await check('final list fence verifies live profile even for empty pages', async () => {
      const f = await fixture();
      await rejects(() => f.status({ async beforeFinalize() { await f.root.collection('users').doc(f.uid).update({ role: 'firefighter' }); } }).list(f.req({ month: MONTH })), 'permission-denied');
    });
    await check('whitelist strips raw payload/device identity and maps unknown free-text reasons generically', async () => {
      const f = await fixture(), action = await f.make(), intent = (await f.intents()).docs[0];
      await f.ref(action).update({ fingerprint: 'PRIVATE_FINGERPRINT', private: 'PRIVATE_ACTION', reason: 'PRIVATE_REASON',
        counts: { scanned: 1, queued: 1, suppressed: 0, skipped: 0, invalid: 0, secret: 'PRIVATE_COUNT' } });
      // Synthetic dispatcher-state fields exercise DTO projection, not FCM.
      await intent.ref.update({ status: 'partial', delivery_status: 'provider_outcome_only', reason: 'PRIVATE_REASON',
        device_outcomes: [{ token_hash: 'PRIVATE_HASH', status: 'accepted' }], token_count: 3, tokens: ['PRIVATE_TOKEN'], attempt_id: 'PRIVATE_ATTEMPT',
        outcome_counts: { accepted: 1, failed: 1, outcome_unknown: 0, private: 'PRIVATE_OUTCOME' }, title: 'PRIVATE_TITLE', body: 'PRIVATE_BODY' });
      const detail = await f.status().get(f.req({ action_id: action.action_id }));
      assert.equal(JSON.stringify(detail).includes('PRIVATE_'), false); assert.equal(detail.action.reason, 'unavailable');
      assert.equal(detail.items[0].reason, 'unavailable'); assert.deepEqual(detail.items[0].outcome_counts, { accepted: 1, failed: 1, outcome_unknown: 0 });
      for (const forbidden of ['actor_auth_time', 'fingerprint', 'device_outcomes', 'token_count', 'tokens', 'attempt_id', 'max_uid', 'cursor', 'lock']) assert.equal(JSON.stringify(detail).includes('"' + forbidden + '"'), false);
    });
    await check('provider accepted/failed/unknown/no-device states stay honest and optional outcomes never become zero', async () => {
      const f = await fixture(), action = await f.make(), intent = (await f.intents()).docs[0];
      for (const status of ['accepted', 'failed', 'outcome_unknown', 'no_device', 'blocked', 'deferred', 'attempting', 'cancelled', 'suppressed']) {
        await intent.ref.update({ status, reason: status === 'outcome_unknown' ? 'attempt-expired' : null });
        const result = await f.status().get(f.req({ action_id: action.action_id })); assert.equal(result.items[0].status, status);
        assert.equal(result.items[0].outcome_counts, null); assert.equal(result.action.status_scope, 'generation_only');
        assert.equal(JSON.stringify(result).includes('"delivered"'), false);
      }
    });
    await check('own-month action pagination25+2 with no repeated rows and no other month', async () => {
      const f = await fixture(); assert.equal(PAGE_SIZE, 25);
      for (let i = 0; i < 27; ++i) { if (i && i % 10 === 0) f.at += 60000; await f.make('page-' + i); }
      const s = f.status(), first = await s.list(f.req({ month: MONTH }));
      const second = await s.list(f.req({ month: MONTH, cursor: first.next_cursor }));
      assert.equal(first.items.length, 25); assert.equal(second.items.length, 2); assert.equal(second.next_cursor, null);
      assert.equal(new Set([...first.items, ...second.items].map(a => a.action_id)).size, 27);
      assert.equal((await s.list(f.req({ month: '2026-08' }))).items.length, 0);
    });
    await check('actual bulk discovery/enqueue produces27 children with page-local outcomes only', async () => {
      const f = await fixture(27), action = await f.bulk(); let result = action, steps = 0;
      while (result.status !== 'completed') { assert.ok(++steps < 10); result = await f.producer.processJob({ stationId: f.sid, action_id: action.action_id }); }
      assert.equal((await f.intents()).size, 27); const s = f.status(), first = await s.get(f.req({ action_id: action.action_id }));
      const second = await s.get(f.req({ action_id: action.action_id, cursor: first.next_cursor }));
      assert.equal(first.items.length, 25); assert.equal(second.items.length, 2); assert.equal(second.next_cursor, null);
      assert.equal(new Set([...first.items, ...second.items].map(v => v.id)).size, 27);
      assert.equal(first.action.counts.queued, 27); assert.equal(first.outcomes_scope, 'this_page_only');
    });
    await check('unavailable parent or child read fails explicitly without inventing missing/empty progress', async () => {
      const f = await fixture(), action = await f.make(), before = await snapshot(f);
      await rejects(() => f.status({}, readOnlyDb(ref => ref.path === f.ref(action).path)).get(f.req({ action_id: action.action_id })), 'unavailable');
      await rejects(() => f.status({}, readOnlyDb(ref => !ref.path)).get(f.req({ action_id: action.action_id })), 'unavailable');
      assert.deepEqual(await snapshot(f), before);
    });
    await check('malformed parent/counts and forged child relationship fail closed', async () => {
      const f = await fixture(), action = await f.make(), ref = f.ref(action), original = (await ref.get()).data();
      await ref.update({ counts: { ...original.counts, queued: -1 } }); await rejects(() => f.status().list(f.req({ month: MONTH })), 'failed-precondition');
      await ref.set(original); const intent = (await f.intents()).docs[0], value = intent.data();
      for (const change of [{ actor_uid: 'foreign_actor' }, { month: '2026-08' }, { id: 'a'.repeat(64) }, { outcome_counts: { accepted: -1, failed: 0, outcome_unknown: 0 } }]) {
        await intent.ref.set({ ...value, ...change }); await rejects(() => f.status().get(f.req({ action_id: action.action_id })), 'failed-precondition');
      }
    });
    console.log('HR hours nudge status: ' + passed + '/' + passed + ' PASS; real Firestore, synthetic Auth, read-only status, no FCM.');
  } finally {
    await cleanup(); if (priorRuntime) { if (priorRuntime.exists) await runtime.set(priorRuntime.data()); else await runtime.delete(); }
    await app.delete();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
