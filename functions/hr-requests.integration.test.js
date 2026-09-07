'use strict';
const host = process.env.FIRESTORE_EMULATOR_HOST || '', projectId = process.env.GCLOUD_PROJECT || '';
if (!/^(localhost|127\.0\.0\.1):\d{1,5}$/.test(host) || !/^demo-[a-z0-9-]+$/.test(projectId)) {
  console.error('NOT RUN: loopback Firestore emulator and demo-* project required.'); process.exit(2);
}
process.env.METADATA_SERVER_DETECTION = 'none';
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const admin = require('firebase-admin');
const { createHrRequests, PAGE_SIZE } = require('./hr-requests');
const app = admin.initializeApp({ projectId }, 'hr-requests-' + process.pid), db = app.firestore();
const run = randomBytes(6).toString('hex'), roots = [], quotas = new Map(), records = new Map();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runtime = db.doc('config/runtime');
const AUTH_TIME = Math.floor(Date.parse('2026-09-08T08:00:00Z') / 1000);
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const auth = { async getUser(uid) {
  const record = records.get(uid);
  if (record instanceof Error) throw record;
  if (!record) throw Object.assign(new Error('synthetic actor missing'), { code: 'auth/user-not-found' });
  return structuredClone(record);
} };
let sequence = 0, passed = 0, priorRuntime;
async function fixture() {
  const sid = 'hr_requests_it_' + run + '_' + (++sequence), root = db.collection('stations').doc(sid);
  roots.push(root);
  const f = { sid, root, at: Date.parse('2026-09-08T09:00:00Z'), people: {} };
  f.add = async (name, role = 'firefighter', superUser = false) => {
    const uid = name + '_' + sid, claims = { stationId: sid, ...(superUser ? { super: true } : { role }) };
    const p = { uid, claims };
    records.set(uid, { uid, disabled: false, customClaims: structuredClone(claims), tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() });
    if (!superUser) await root.collection('users').doc(uid).set({ stationId: sid, role, active: true, employee_number: 'synthetic-' + name });
    const quota = db.collection('hr_request_actor_quotas').doc(hash(['hr-request-quota-v1', uid]));
    quotas.set(quota.path, quota); p.quota = quota; f.people[name] = p; return p;
  };
  await f.add('owner'); await f.add('other'); await f.add('hr', 'hr_coordinator');
  await f.add('command', 'station_commander'); await f.add('super', null, true);
  f.req = (name, data, token = {}) => ({ auth: { uid: f.people[name].uid, token: { ...f.people[name].claims, auth_time: AUTH_TIME, ...token } }, data });
  f.create = (id = 'create-001', extra = {}) => ({ request_id: id, subject: 'Private synthetic subject', text: 'Private synthetic body https://example.invalid/literal', send_now: false, ...extra });
  f.action = (c, id, extra = {}) => ({ request_id: id, case_id: c.case_id, expected_revision: c.revision, send_now: false, ...extra });
  f.service = (hooks = {}, database = db) => createHrRequests({ db: database, auth, HttpsError, clock: () => f.at, hooks });
  f.cases = () => root.collection('hr_requests').get();
  f.jobs = () => root.collection('hr_request_notification_jobs').get();
  f.receipts = () => root.collection('hr_request_operations').get();
  f.events = c => root.collection('hr_requests').doc(c.case_id).collection('events').get();
  return f;
}
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
async function check(name, fn) {
  await runtime.set({ silent: false, silent_allow: [] }); await fn();
  ++passed; console.log('PASS ' + name);
}
function failingDb({ readPath, write = false }) {
  return { collection: db.collection.bind(db), doc: db.doc.bind(db), runTransaction: fn => db.runTransaction(tx => fn(new Proxy(tx, {
    get(target, key) {
      if (key === 'get') return ref => ref.path === readPath
        ? Promise.reject(Object.assign(new Error('synthetic unavailable read'), { code: 'unavailable' })) : target.get(ref);
      if (write && key === 'create') return (...args) => { target.create(...args); throw new Error('synthetic post-write failure'); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }
  }))) };
}
(async () => {
  try {
    priorRuntime = await runtime.get();
    await check('owner privacy; HR and profile-free signed super; command roles remain private', async () => {
      const f = await fixture(), s = f.service(), c = await s.create(f.req('owner', f.create()));
      for (const name of ['owner', 'hr', 'super']) assert.equal((await s.get(f.req(name, { case_id: c.case_id }))).events[0].text, f.create().text);
      for (const name of ['other', 'command']) {
        await rejects(() => s.get(f.req(name, { case_id: c.case_id })), 'permission-denied');
        await rejects(() => s.reply(f.req(name, f.action(c, 'private-reply', { text: 'No' }))), 'permission-denied');
        await rejects(() => s.listInbox(f.req(name, {})), 'permission-denied');
      }
      assert.equal((await s.list(f.req('other', {}))).items.length, 0);
      assert.equal((await s.listInbox(f.req('hr', {}))).items.length, 1);
      const g = await fixture(); await rejects(() => s.get(g.req('hr', { case_id: c.case_id })), 'not-found');
      assert.equal((await f.jobs()).size, 1); assert.equal((await f.receipts()).size, 1);
    });
    await check('closed input, controls, lengths, fake super and malformed session rejected without writes', async () => {
      const f = await fixture(), s = f.service();
      await rejects(() => s.create({ data: f.create() }), 'unauthenticated');
      for (const extra of [{ stationId: f.sid }, { subject: 'x'.repeat(81) }, { text: 'x'.repeat(1001) }, { text: '\u0000' }, { request_id: '../evil' }, { send_now: 'true' }, { attachment_id: 'fake' }]) {
        await rejects(() => s.create(f.req('owner', f.create('invalid-01', extra))), 'invalid-argument');
      }
      await rejects(() => s.create(f.req('owner', f.create(), { auth_time: undefined })), 'unauthenticated');
      await rejects(() => s.create(f.req('owner', f.create(), { role: 'super_admin', super: 'true' })), 'permission-denied');
      await rejects(() => s.list(f.req('owner', { cursor: '../bad' })), 'invalid-argument');
      assert.equal((await f.cases()).size, 0); assert.equal((await f.receipts()).size, 0);
    });
    await check('fresh Auth disabled, missing, moved, changed role and malformed validity fail closed', async () => {
      const f = await fixture(), s = f.service(), uid = f.people.owner.uid, saved = structuredClone(records.get(uid));
      for (const change of [{ disabled: true }, { customClaims: { stationId: 'different', role: 'firefighter' } }, { customClaims: { stationId: f.sid, role: 'hr_coordinator' } }]) {
        records.set(uid, { ...saved, ...change }); await rejects(() => s.create(f.req('owner', f.create())), 'permission-denied');
      }
      records.delete(uid); await rejects(() => s.create(f.req('owner', f.create())), 'permission-denied');
      for (const marker of ['invalid', null]) {
        records.set(uid, { ...saved, tokensValidAfterTime: marker });
        await rejects(() => s.create(f.req('owner', f.create())), 'unavailable');
      }
      records.set(uid, new Error('synthetic backend down')); await rejects(() => s.create(f.req('owner', f.create())), 'unavailable');
      assert.equal((await f.cases()).size, 0);
    });
    await check('token revocation rejects unchanged claims; equal auth-time boundary passes', async () => {
      const f = await fixture(), s = f.service(), r = records.get(f.people.owner.uid);
      const c = await s.create(f.req('owner', f.create())); assert.equal(c.outcome, 'saved');
      r.tokensValidAfterTime = new Date((AUTH_TIME + 1) * 1000).toUTCString();
      await rejects(() => s.get(f.req('owner', { case_id: c.case_id })), 'permission-denied');
      await rejects(() => s.create(f.req('owner', f.create())), 'permission-denied');
      r.tokensValidAfterTime = new Date(AUTH_TIME * 1000).toUTCString();
      assert.equal((await s.create(f.req('owner', f.create()))).duplicate, true);
    });
    await check('live profile inactive or transferred blocks owner while old station HR retains case', async () => {
      const f = await fixture(), s = f.service(), c = await s.create(f.req('owner', f.create()));
      const profile = f.root.collection('users').doc(f.people.owner.uid);
      await profile.update({ active: false });
      await rejects(() => s.get(f.req('owner', { case_id: c.case_id })), 'permission-denied');
      await profile.update({ active: true, stationId: 'moved_station' });
      await rejects(() => s.reply(f.req('owner', f.action(c, 'moved-reply', { text: 'No' }))), 'permission-denied');
      assert.equal((await s.get(f.req('hr', { case_id: c.case_id }))).case_id, c.case_id);
    });
    await check('fresh stronger claims never upgrade an old signed request and former super must refresh', async () => {
      const f = await fixture(), s = f.service(), c = await s.create(f.req('owner', f.create()));
      records.get(f.people.other.uid).customClaims = { stationId: f.sid, super: true };
      await rejects(() => s.get(f.req('other', { case_id: c.case_id })), 'permission-denied');
      records.get(f.people.super.uid).customClaims = { stationId: f.sid, role: 'hr_coordinator' };
      await rejects(() => s.get(f.req('super', { case_id: c.case_id })), 'permission-denied');
    });
    await check('concurrent request replay creates one immutable event, job, receipt and quota charge', async () => {
      const f = await fixture(), s = f.service(), req = f.req('owner', f.create());
      const results = await Promise.all([s.create(req), s.create(req), s.create(req)]), c = results[0];
      assert.equal(results.filter(r => !r.duplicate).length, 1);
      assert.equal((await f.events(c)).size, 1); assert.equal((await f.jobs()).size, 1); assert.equal((await f.receipts()).size, 1);
      assert.equal((await f.people.owner.quota.get()).data().requests_at_ms.length, 1);
      await rejects(() => s.create(f.req('owner', f.create('create-001', { text: 'Changed' }))), 'already-exists');
      // Simulate server-side damage: a receipt alone must never claim that a
      // missing case is still saved, and replay must not recreate business data.
      await f.root.collection('hr_requests').doc(c.case_id).delete();
      await rejects(() => s.create(req), 'failed-precondition');
      assert.equal((await f.cases()).size, 0); assert.equal((await f.jobs()).size, 1);
      assert.equal((await f.receipts()).size, 1);
    });
    await check('reply receipt precedes new CAS, changed payload conflicts, competing revisions allow one writer', async () => {
      const f = await fixture(), s = f.service(), c = await s.create(f.req('owner', f.create()));
      const req = f.req('owner', f.action(c, 'reply-once', { text: 'Immutable reply' }));
      const reply = await s.reply(req); assert.equal(reply.revision, 2); assert.equal((await s.reply(req)).duplicate, true);
      await rejects(() => s.reply(f.req('owner', f.action(c, 'reply-once', { text: 'Edited reply' }))), 'already-exists');
      await rejects(() => s.reply(f.req('owner', f.action(c, 'reply-stale', { text: 'Stale' }))), 'aborted');
      const values = await Promise.allSettled(['a', 'b'].map(id => s.reply(f.req('owner', f.action(reply, 'concurrent-' + id, { text: id })))));
      assert.equal(values.filter(v => v.status === 'fulfilled').length, 1);
      assert.equal(values.find(v => v.status === 'rejected').reason.code, 'aborted');
      const history = await s.get(f.req('owner', { case_id: c.case_id }));
      assert.equal(history.events[1].text, 'Immutable reply'); assert.equal(history.events.length, 3);
    });
    await check('HR status CAS, waiting-employee owner reply, closed denial and explicit reopen', async () => {
      const f = await fixture(), s = f.service(); let c = await s.create(f.req('owner', f.create()));
      await rejects(() => s.setStatus(f.req('owner', f.action(c, 'owner-status', { status: 'closed' }))), 'permission-denied');
      c = await s.setStatus(f.req('hr', f.action(c, 'wait-status', { status: 'waiting_employee' })));
      c = await s.reply(f.req('owner', f.action(c, 'owner-answer', { text: 'Answer' }))); assert.equal(c.status, 'open');
      c = await s.setStatus(f.req('hr', f.action(c, 'close-status', { status: 'closed' })));
      await rejects(() => s.reply(f.req('owner', f.action(c, 'closed-reply', { text: 'No' }))), 'failed-precondition');
      await rejects(() => s.nudge(f.req('hr', f.action(c, 'closed-nudge'))), 'failed-precondition');
      c = await s.setStatus(f.req('hr', f.action(c, 'reopen-status', { status: 'in_progress' })));
      c = await s.reply(f.req('hr', f.action(c, 'manager-reply', { text: 'Working' }))); assert.equal(c.status, 'in_progress');
    });
    await check('no-change status records receipt without event, notification, revision or quota change', async () => {
      const f = await fixture(), s = f.service(), c = await s.create(f.req('owner', f.create()));
      const result = await s.setStatus(f.req('hr', f.action(c, 'unchanged-status', { status: 'open' })));
      assert.equal(result.outcome, 'no_change'); assert.equal(result.revision, 1);
      assert.equal((await f.events(c)).size, 1); assert.equal((await f.jobs()).size, 1);
      assert.equal((await f.people.hr.quota.get()).exists, false); assert.equal((await f.receipts()).size, 2);
    });
    await check('generic durable jobs route owner versus HR without content, and HR owner never self-notifies', async () => {
      const f = await fixture(), s = f.service(); let c = await s.create(f.req('owner', f.create()));
      c = await s.reply(f.req('hr', f.action(c, 'hr-response', { text: 'Sensitive manager text' })));
      const jobs = (await f.jobs()).docs.map(d => d.data());
      assert.equal(jobs.find(j => j.audience === 'station_hr').recipient_uid, undefined);
      assert.equal(jobs.find(j => j.audience === 'person').recipient_uid, f.people.owner.uid);
      for (const job of jobs) {
        for (const key of ['text', 'subject', 'full_name', 'employee_number', 'url', 'tokens']) assert.equal(Object.hasOwn(job, key), false);
        assert.equal(job.delivery_status, 'intent_only'); assert.equal(job.exclude_actor, true);
      }
      let own = await s.create(f.req('hr', f.create('hr-own-case')));
      own = await s.reply(f.req('hr', f.action(own, 'hr-own-reply', { text: 'Owner side' })));
      assert.equal((await f.root.collection('hr_request_notification_jobs').doc(own.event_id).get()).data().audience, 'station_hr');
      const result = await s.setStatus(f.req('hr', f.action(own, 'hr-own-close', { status: 'closed' })));
      assert.equal(result.notification_status, 'no_other_recipient');
      assert.equal((await f.root.collection('hr_request_notification_jobs').doc(result.event_id).get()).exists, false);
    });
    await check('business text/status persist at night under silent or unavailable runtime configuration', async () => {
      const f = await fixture(), s = f.service(); f.at = Date.parse('2026-09-08T20:00:00Z');
      await runtime.set({ silent: true }); let c = await s.create(f.req('owner', f.create()));
      c = await s.reply(f.req('hr', f.action(c, 'silent-reply', { text: 'Saved at night' })));
      await runtime.delete(); c = await s.setStatus(f.req('hr', f.action(c, 'night-status', { status: 'waiting_employee' })));
      assert.equal((await s.get(f.req('owner', { case_id: c.case_id }))).events.length, 3);
      for (const d of (await f.jobs()).docs) { assert.equal(d.data().status, 'policy_pending'); assert.equal(d.data().routine_after_quiet, true); }
    });
    await check('nudge relevance, night confirmation, bounded consent and silent cannot bypass', async () => {
      const f = await fixture(), s = f.service(); let c = await s.create(f.req('owner', f.create()));
      await rejects(() => s.nudge(f.req('hr', f.action(c, 'wrong-side-nudge'))), 'failed-precondition');
      f.at = Date.parse('2026-09-08T20:00:00Z');
      const warning = await s.nudge(f.req('owner', f.action(c, 'night-warning')));
      assert.equal(warning.outcome, 'confirmation_required'); assert.equal((await f.events(c)).size, 1);
      c = await s.nudge(f.req('owner', f.action(c, 'night-consent', { send_now: true })));
      assert.equal(c.status, 'open');
      const job = (await f.root.collection('hr_request_notification_jobs').doc(c.event_id).get()).data();
      assert.equal(job.consent_expires_at_ms, f.at + 3600000); assert.equal(job.routine_after_quiet, false);
      c = await s.setStatus(f.req('hr', f.action(c, 'nudge-waiting', { status: 'waiting_employee' })));
      await rejects(() => s.nudge(f.req('owner', f.action(c, 'waiting-owner'))), 'failed-precondition');
      await runtime.set({ silent: true }); c = await s.nudge(f.req('hr', f.action(c, 'silent-nudge', { send_now: true })));
      assert.equal(c.notification_status, 'suppressed'); assert.equal(c.status, 'waiting_employee');
    });
    await check('rolling mutation quota excludes replay, expires exactly at minute and final clock is fresh', async () => {
      const f = await fixture(), s = f.service();
      for (let i = 0; i < 10; ++i) await s.create(f.req('owner', f.create('quota-create-' + i)));
      await rejects(() => s.create(f.req('owner', f.create('quota-eleven'))), 'resource-exhausted');
      assert.equal((await s.create(f.req('owner', f.create('quota-create-0')))).duplicate, true);
      const at = f.at;
      await f.service({ beforeWrites() { f.at = at + 60000; } }).create(f.req('owner', f.create('quota-eleven')));
      assert.deepEqual((await f.people.owner.quota.get()).data().requests_at_ms, [at + 60000]);
    });
    await check('quiet threshold crossed after async reads yields warning and no new event', async () => {
      const f = await fixture(), c = await f.service().create(f.req('owner', f.create()));
      f.at = Date.parse('2026-09-08T18:59:00Z');
      const s = f.service({ beforeWrites() { f.at = Date.parse('2026-09-08T19:01:00Z'); } });
      assert.equal((await s.nudge(f.req('owner', f.action(c, 'cross-night')))).outcome, 'confirmation_required');
      assert.equal((await f.events(c)).size, 1);
    });
    await check('final mutation Auth check blocks revocation without orphan event, receipt, job or quota', async () => {
      const f = await fixture(), s = f.service({ beforeWrites() { records.get(f.people.owner.uid).disabled = true; } });
      await rejects(() => s.create(f.req('owner', f.create())), 'permission-denied');
      assert.equal((await f.cases()).size, 0); assert.equal((await f.jobs()).size, 0); assert.equal((await f.receipts()).size, 0);
      assert.equal((await f.people.owner.quota.get()).exists, false);
    });
    await check('final read actor fence blocks transfer but newer reply does not invalidate coherent page', async () => {
      const f = await fixture(), s = f.service(), c = await s.create(f.req('owner', f.create()));
      const coherent = await f.service({ async beforeFinalize() { await s.reply(f.req('hr', f.action(c, 'during-read', { text: 'Newer message' }))); } }).get(f.req('owner', { case_id: c.case_id }));
      assert.equal(coherent.revision, 1); assert.equal(coherent.events.length, 1);
      await rejects(() => f.service({ beforeFinalize() { records.get(f.people.owner.uid).customClaims.stationId = 'moved'; } }).get(f.req('owner', { case_id: c.case_id })), 'permission-denied');
    });
    await check('missing reads and exceptions after staged writes roll back whole business transaction', async () => {
      const f = await fixture();
      await rejects(() => f.service({}, failingDb({ readPath: f.people.owner.quota.path })).create(f.req('owner', f.create())), 'unavailable');
      await assert.rejects(() => f.service({}, failingDb({ write: true })).create(f.req('owner', f.create())), /synthetic post-write failure/);
      assert.equal((await f.cases()).size, 0); assert.equal((await f.jobs()).size, 0); assert.equal((await f.receipts()).size, 0);
      assert.equal((await f.people.owner.quota.get()).exists, false);
    });
    await check('case and event pagination has bounded continuous pages without cross-owner results', async () => {
      const f = await fixture(), s = f.service(); let first;
      for (let i = 0; i < PAGE_SIZE + 2; ++i) {
        f.at += 60001; const c = await s.create(f.req('owner', f.create('page-case-' + i))); if (!first) first = c;
      }
      await s.create(f.req('other', f.create('other-page-case')));
      const a = await s.list(f.req('owner', {})), b = await s.list(f.req('owner', { cursor: a.next_cursor }));
      assert.equal(a.items.length, PAGE_SIZE); assert.equal(b.items.length, 2); assert.equal(b.next_cursor, null);
      assert.equal(new Set(a.items.concat(b.items).map(c => c.case_id)).size, PAGE_SIZE + 2);
      let c = first;
      for (let i = 0; i < PAGE_SIZE + 1; ++i) { f.at += 60001; c = await s.reply(f.req('owner', f.action(c, 'page-reply-' + i, { text: 'Message ' + i }))); }
      const one = await s.get(f.req('owner', { case_id: c.case_id }));
      const two = await s.get(f.req('owner', { case_id: c.case_id, cursor: one.next_cursor }));
      assert.equal(one.events.length, PAGE_SIZE); assert.equal(two.events.length, 2); assert.equal(two.next_cursor, null);
      assert.deepEqual(one.events.concat(two.events).map(e => e.revision), Array.from({ length: PAGE_SIZE + 2 }, (_, i) => i + 1));
      await rejects(() => s.get(f.req('owner', { case_id: c.case_id, cursor: -1 })), 'invalid-argument');
    });
    console.log('HR requests integration: ' + passed + ' passed.');
  } finally {
    for (const root of roots) await db.recursiveDelete(root);
    for (const ref of quotas.values()) await ref.delete();
    if (priorRuntime) { if (priorRuntime.exists) await runtime.set(priorRuntime.data()); else await runtime.delete(); }
    await app.delete();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
