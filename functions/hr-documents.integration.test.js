'use strict';
const assert = require('node:assert/strict');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Private loopback emulator only');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq', 'Demo project only');
process.env.METADATA_SERVER_DETECTION = 'none';
const { randomBytes, createHash } = require('node:crypto');
const admin = require('firebase-admin');
const { createHrDocuments, PAGE_SIZE, QUOTA_MAX } = require('./hr-documents');
const app = admin.initializeApp({ projectId: 'demo-resq' }, 'hr-documents-' + process.pid), db = app.firestore();
const run = randomBytes(6).toString('hex'), roots = [], quotas = new Map(), records = new Map();
const AUTH_TIME = Date.parse('2026-09-01T00:00:00Z') / 1000;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const runtime = db.doc('config/runtime');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const auth = { async getUser(uid) { const value = records.get(uid); if (value instanceof Error) throw value;
  if (!value) throw Object.assign(new Error('synthetic missing Auth'), { code: 'auth/user-not-found' }); return structuredClone(value); } };
let sequence = 0, passed = 0, priorRuntime;
async function fixture() {
  const sid = 'hr_documents_it_' + run + '_' + (++sequence), root = db.doc('stations/' + sid); roots.push(root);
  const f = { sid, root, people: {}, at: Date.parse('2026-09-08T09:00:00Z') };
  f.add = async (name, role = 'firefighter', superUser = false, profile = true) => {
    const uid = name + '_' + sid, claims = { stationId: sid, ...(superUser ? { super: true } : { role }) };
    records.set(uid, { uid, disabled: false, customClaims: claims, tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() });
    if (profile) await root.collection('users').doc(uid).set({ stationId: sid, role, active: true, employee_number: 'synthetic-' + name });
    const quota = db.doc('hr_document_actor_quotas/' + hash(['hr-document-quota-v1', uid])); quotas.set(quota.path, quota);
    return f.people[name] = { uid, claims, quota };
  };
  await f.add('target'); await f.add('other'); await f.add('hr', 'hr_coordinator');
  await f.add('command', 'station_commander'); await f.add('super', null, true, false);
  f.req = (name, data, extra = {}) => ({ auth: { uid: f.people[name].uid, token: { ...f.people[name].claims, auth_time: AUTH_TIME, ...extra } }, data });
  f.pub = (id = 'publish-001', extra = {}) => ({ request_id: id, kind: 'document', target_uid: f.people.target.uid,
    title: 'PRIVATE_DOCUMENT_TITLE', text: 'PRIVATE_BODY https://example.invalid/literal\nSecond line', requires_ack: true, send_now: false, ...extra });
  f.procedure = (id = 'procedure-001', extra = {}) => { const p = f.pub(id, { kind: 'procedure', ...extra }); delete p.target_uid; return p; };
  f.revise = (d, id = 'revise-001', extra = {}) => ({ request_id: id, document_id: d.document_id, expected_revision: d.current_revision,
    title: 'PRIVATE_REVISED_TITLE', text: 'PRIVATE_REVISED_BODY', requires_ack: true, send_now: false, ...extra });
  f.receipt = (d, id = 'receipt-001', extra = {}) => ({ request_id: id, document_id: d.document_id, revision: d.revision, ...extra });
  f.nudge = (d, id = 'nudge-001', extra = {}) => ({ ...f.receipt(d, id), target_uid: f.people.target.uid, send_now: false, ...extra });
  f.service = (hooks = {}, database = db) => createHrDocuments({ db: database, auth, HttpsError, clock: () => f.at, hooks });
  f.ref = d => root.collection('hr_documents').doc(d.document_id);
  f.version = (d, revision = d.revision) => f.ref(d).collection('revisions').doc(String(revision));
  f.jobs = () => root.collection('hr_document_notification_jobs').get();
  f.ops = () => root.collection('hr_document_operations').get();
  return f;
}
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
async function cleanup() {
  for (const root of roots.splice(0)) { assert.ok(root.id.startsWith('hr_documents_it_' + run)); await db.recursiveDelete(root); }
  for (const ref of quotas.values()) await ref.delete(); quotas.clear(); records.clear();
}
async function check(name, fn) {
  await runtime.set({ silent: false, silent_allow: [] });
  try { await fn(); ++passed; console.log('PASS ' + name); } finally { await cleanup(); }
}
function failingDb(path, write = false) {
  return { collection: db.collection.bind(db), doc: db.doc.bind(db), runTransaction: fn => db.runTransaction(tx => fn(new Proxy(tx, {
    get(target, key) {
      if (key === 'get') return ref => ref.path === path ? Promise.reject(Object.assign(new Error('synthetic unavailable'), { code: 'unavailable' })) : target.get(ref);
      if (key === 'create' && write) return (...args) => { target.create(...args); throw new Error('synthetic queued-write crash'); };
      const v = target[key]; return typeof v === 'function' ? v.bind(target) : v;
    }
  }))) };
}
(async () => {
  try {
    priorRuntime = await runtime.get(); console.log(JSON.stringify({ run, prior_runtime: priorRuntime.exists ? priorRuntime.data() : null }));
    await check('HR/signed-super publish; private target reads; command and other-member authority stays closed', async () => {
      const f = await fixture(), s = f.service();
      for (const name of ['target', 'other', 'command']) await rejects(() => s.publish(f.req(name, f.pub())), 'permission-denied');
      const d = await s.publish(f.req('hr', f.pub()));
      for (const name of ['target', 'hr', 'super']) assert.equal((await s.get(f.req(name, { document_id: d.document_id }))).text, f.pub().text);
      for (const name of ['other', 'command']) {
        await rejects(() => s.get(f.req(name, { document_id: d.document_id })), 'permission-denied');
        await rejects(() => s.listManaged(f.req(name, { kind: 'document' })), 'permission-denied');
      }
      assert.equal((await s.listMine(f.req('target', {}))).items.length, 1); assert.equal((await s.listMine(f.req('other', {}))).items.length, 0);
      await s.publish(f.req('super', f.pub('super-publish'))); assert.equal((await f.jobs()).size, 2);
      const g = await fixture(); await rejects(() => s.get(g.req('hr', { document_id: d.document_id })), 'not-found');
    });
    await check('closed inputs, fake super, malformed session and unsupported files rejected without writes', async () => {
      const f = await fixture(), s = f.service(); await rejects(() => s.publish({ data: f.pub() }), 'unauthenticated');
      await rejects(() => s.publish(f.req('hr', f.pub(), { auth_time: undefined })), 'unauthenticated');
      await rejects(() => s.publish(f.req('other', f.pub(), { role: 'super_admin', super: 'true' })), 'permission-denied');
      for (const change of [{ stationId: f.sid }, { attachment_id: 'fake' }, { download_url: 'https://example.invalid/private' },
        { title: 'x'.repeat(81) }, { text: 'x'.repeat(20001) }, { text: '\u0000' }, { requires_ack: 'true' }, { send_now: 'true' },
        { request_id: '../invalid' }, { target_uid: '../invalid' }, { kind: 'file' }]) {
        await rejects(() => s.publish(f.req('hr', f.pub('invalid-01', change))), 'invalid-argument');
      }
      await rejects(() => s.publish(f.req('hr', { ...f.procedure(), target_uid: f.people.target.uid })), 'invalid-argument');
      assert.equal((await f.root.collection('hr_documents').get()).size, 0); assert.equal((await f.jobs()).size, 0); assert.equal((await f.ops()).size, 0);
    });
    await check('fresh Auth disabled, role/station changes, revocation and malformed validity fail closed', async () => {
      const f = await fixture(), s = f.service(), p = f.people.hr, saved = structuredClone(records.get(p.uid));
      for (const update of [{ disabled: true }, { customClaims: { stationId: 'elsewhere', role: 'hr_coordinator' } },
        { customClaims: { stationId: f.sid, role: 'firefighter' } }, { tokensValidAfterTime: new Date((AUTH_TIME + 1) * 1000).toUTCString() }]) {
        records.set(p.uid, { ...saved, ...update }); await rejects(() => s.publish(f.req('hr', f.pub())), 'permission-denied');
      }
      records.set(p.uid, { ...saved, tokensValidAfterTime: 'invalid' }); await rejects(() => s.publish(f.req('hr', f.pub())), 'unavailable');
      records.set(p.uid, new Error('synthetic Auth outage')); await rejects(() => s.publish(f.req('hr', f.pub())), 'unavailable');
      records.set(p.uid, saved); assert.equal((await s.publish(f.req('hr', f.pub()))).revision, 1, 'equal auth_time validity remains valid');
    });
    await check('management never manufactures a target; live local recipient checked twice before writes', async () => {
      const f = await fixture(), s = f.service();
      await rejects(() => s.publish(f.req('hr', f.pub('profile-free-target', { target_uid: f.people.super.uid }))), 'permission-denied');
      records.get(f.people.target.uid).disabled = true; await rejects(() => s.publish(f.req('hr', f.pub())), 'permission-denied');
      records.get(f.people.target.uid).disabled = false;
      await rejects(() => f.service({ beforeWrites() { records.get(f.people.target.uid).customClaims.stationId = 'other_station'; } })
        .publish(f.req('hr', f.pub())), 'permission-denied');
      assert.equal((await f.jobs()).size, 0); assert.equal((await f.ops()).size, 0);
    });
    await check('current procedures include later members and exclude transferred/inactive readers', async () => {
      const f = await fixture(), s = f.service(), p = await s.publish(f.req('hr', f.procedure()));
      await f.add('joined'); assert.equal((await s.listProcedures(f.req('joined', {}))).items.length, 1);
      assert.equal((await s.get(f.req('joined', { document_id: p.document_id }))).recipient_eligible, true);
      await f.root.collection('users').doc(f.people.joined.uid).update({ active: false });
      await rejects(() => s.get(f.req('joined', { document_id: p.document_id })), 'permission-denied');
      assert.equal((await s.get(f.req('super', { document_id: p.document_id }))).recipient_eligible, false);
      await rejects(() => s.markOpened(f.req('super', f.receipt(p))), 'permission-denied');
    });
    await check('read/list has no implicit opened receipt, acknowledgment or notification job', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub()));
      const jobs = (await f.jobs()).size, ops = (await f.ops()).size;
      const result = await s.get(f.req('target', { document_id: d.document_id })); assert.equal(result.receipt, null);
      await s.listMine(f.req('target', {})); await s.listManaged(f.req('hr', { kind: 'document' }));
      assert.equal((await f.version(d).collection('receipts').get()).size, 0); assert.equal((await f.jobs()).size, jobs); assert.equal((await f.ops()).size, ops);
    });
    await check('opened is not acknowledgment; target-only explicit receipt writes create no push work', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub()));
      await rejects(() => s.acknowledge(f.req('target', f.receipt(d, 'ack-before-open'))), 'failed-precondition');
      for (const name of ['hr', 'super', 'other']) await rejects(() => s.markOpened(f.req(name, f.receipt(d))), 'permission-denied');
      const opened = await s.markOpened(f.req('target', f.receipt(d, 'opened-001')));
      assert.equal(opened.receipt.opened_at_ms, f.at); assert.equal(opened.receipt.acknowledged_at_ms, null);
      assert.equal(opened.notification_status, 'not_queued'); f.at += 1000;
      const ack = await s.acknowledge(f.req('target', f.receipt(d, 'acknowledge-001')));
      assert.equal(ack.receipt.acknowledged_at_ms, f.at); assert.equal(ack.notification_status, 'not_queued');
      assert.equal((await f.jobs()).size, 1);
      assert.equal((await s.markOpened(f.req('target', f.receipt(d, 'opened-again')))).outcome, 'no_change');
      assert.equal((await f.jobs()).size, 1);
    });
    await check('immutable revisions and concurrent CAS retain old text and reject stale mutations', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub())), old = (await f.version(d).get()).data();
      const results = await Promise.allSettled([s.revise(f.req('hr', f.revise(d, 'revision-a'))), s.revise(f.req('hr', f.revise(d, 'revision-b')))]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'rejected').reason.code, 'aborted');
      assert.deepEqual((await f.version(d).get()).data(), old);
      assert.equal((await f.ref(d).collection('revisions').get()).size, 2); assert.equal((await f.jobs()).size, 2);
      assert.equal((await s.get(f.req('target', { document_id: d.document_id, revision: 1 }))).is_current, false);
      await rejects(() => s.acknowledge(f.req('target', f.receipt(d, 'old-ack-001'))), 'aborted');
      await rejects(() => s.nudge(f.req('hr', f.nudge(d))), 'aborted');
    });
    await check('historical opened and old successful ack replay never acknowledge a new revision', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub()));
      await s.markOpened(f.req('target', f.receipt(d, 'open-old')));
      const request = f.req('target', f.receipt(d, 'ack-old-001')); await s.acknowledge(request);
      const second = await s.revise(f.req('hr', f.revise(d)));
      const replay = await s.acknowledge(request); assert.equal(replay.duplicate, true); assert.equal(replay.revision, 1); assert.equal(replay.current_revision, 2);
      const historical = await s.markOpened(f.req('target', f.receipt(d, 'open-historical'))); assert.equal(historical.revision, 1);
      assert.equal((await f.version(second).collection('receipts').get()).size, 0);
      assert.equal((await s.get(f.req('target', { document_id: d.document_id }))).receipt, null);
      await rejects(() => s.acknowledge(f.req('target', f.receipt(second, 'ack-new-before-open'))), 'failed-precondition');
    });
    await check('non-required acknowledgment rejected and its reminder completes on opened only', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub('no-ack-001', { requires_ack: false })));
      await s.nudge(f.req('hr', f.nudge(d))); await s.markOpened(f.req('target', f.receipt(d)));
      await rejects(() => s.acknowledge(f.req('target', f.receipt(d, 'unneeded-ack'))), 'failed-precondition');
      await rejects(() => s.nudge(f.req('hr', f.nudge(d, 'no-work-001'))), 'failed-precondition');
      assert.equal((await f.jobs()).size, 2);
    });
    await check('concurrent exact replay writes one immutable publication/job and charges quota once', async () => {
      const f = await fixture(), s = f.service(), req = f.req('hr', f.pub());
      const results = await Promise.all([s.publish(req), s.publish(req), s.publish(req)]);
      assert.equal(new Set(results.map(r => r.document_id)).size, 1); assert.equal((await f.jobs()).size, 1); assert.equal((await f.ops()).size, 1);
      assert.equal((await f.people.hr.quota.get()).data().requests_at_ms.length, 1);
      await rejects(() => s.publish(f.req('hr', f.pub('publish-001', { text: 'Changed' }))), 'already-exists');
      records.get(f.people.hr.uid).disabled = true; await rejects(() => s.publish(req), 'permission-denied');
    });
    await check('quota is ten new operations; exact replay free and next minute permits progress', async () => {
      const f = await fixture(), s = f.service(); assert.equal(QUOTA_MAX, 10);
      for (let i = 0; i < QUOTA_MAX; ++i) await s.publish(f.req('hr', f.pub('quota-publish-' + i)));
      await rejects(() => s.publish(f.req('hr', f.pub('quota-overflow'))), 'resource-exhausted');
      await s.publish(f.req('hr', f.pub('quota-publish-0'))); assert.equal((await f.people.hr.quota.get()).data().requests_at_ms.length, 10);
      f.at += 60000; await s.publish(f.req('hr', f.pub('quota-overflow'))); assert.equal((await f.people.hr.quota.get()).data().requests_at_ms.length, 1);
    });
    await check('publish/revise preserve business data at night/silent/config absence with generic durable jobs', async () => {
      const f = await fixture(), s = f.service(); f.at = Date.parse('2026-09-08T20:00:00Z'); await runtime.delete();
      const d = await s.publish(f.req('hr', f.pub())); assert.equal(d.outcome, 'saved'); assert.equal(d.notification_status, 'policy_pending');
      await runtime.set({ silent: true }); const revised = await s.revise(f.req('hr', f.revise(d))); assert.equal(revised.outcome, 'saved');
      for (const snap of (await f.jobs()).docs) { const job = snap.data(); assert.equal(job.routine_after_quiet, true); assert.equal(job.delivery_status, 'intent_only');
        assert.equal(job.actor_auth_time, AUTH_TIME); assert.equal(JSON.stringify(job).includes('PRIVATE_'), false); }
      assert.equal((await f.ref(d).collection('revisions').get()).size, 2);
    });
    await check('single-HR nudge only for actual outstanding recipient; receipt updates never notify HR', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub()));
      for (const name of ['target', 'command']) await rejects(() => s.nudge(f.req(name, f.nudge(d))), 'permission-denied');
      await rejects(() => s.nudge(f.req('hr', f.nudge(d, 'wrong-target', { target_uid: f.people.other.uid }))), 'failed-precondition');
      await s.nudge(f.req('hr', f.nudge(d))); await s.markOpened(f.req('target', f.receipt(d, 'open-for-nudge')));
      await s.nudge(f.req('hr', f.nudge(d, 'still-unacknowledged'))); assert.equal((await f.jobs()).size, 3);
      await s.acknowledge(f.req('target', f.receipt(d, 'ack-for-nudge')));
      await rejects(() => s.nudge(f.req('hr', f.nudge(d, 'already-done'))), 'failed-precondition'); assert.equal((await f.jobs()).size, 3);
    });
    await check('nudge quiet warning needs new confirmed ID and send_now never bypasses global silent', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub())); f.at = Date.parse('2026-09-08T20:00:00Z');
      const p = await s.nudge(f.req('hr', f.nudge(d))); assert.equal(p.outcome, 'confirmation_required'); assert.equal((await f.jobs()).size, 1);
      await rejects(() => s.nudge(f.req('hr', f.nudge(d, 'nudge-001', { send_now: true }))), 'already-exists');
      const confirmed = await s.nudge(f.req('hr', f.nudge(d, 'confirmed-night', { send_now: true }))); assert.equal(confirmed.notification_status, 'policy_pending');
      await runtime.set({ silent: true }); const silent = await s.nudge(f.req('hr', f.nudge(d, 'silent-night', { send_now: true }))); assert.equal(silent.notification_status, 'suppressed');
      const jobs = (await f.jobs()).docs.map(d => d.data()); assert.ok(jobs.some(j => j.type === 'hr_nudge' && j.status === 'suppressed'));
      for (const job of jobs.filter(j => j.type === 'hr_nudge')) { assert.equal(job.audience, 'person'); assert.equal(job.recipient_uid, f.people.target.uid); assert.equal(job.routine_after_quiet, false); }
    });
    await check('nudge runtime/read failure leaves no operation, quota change or new job', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub())), quota = (await f.people.hr.quota.get()).data();
      await runtime.delete(); await rejects(() => s.nudge(f.req('hr', f.nudge(d))), 'failed-precondition');
      await runtime.set({ silent: false });
      await rejects(() => f.service({}, failingDb(f.version(d).path)).nudge(f.req('hr', f.nudge(d))), 'unavailable');
      assert.equal((await f.jobs()).size, 1); assert.equal((await f.ops()).size, 1); assert.deepEqual((await f.people.hr.quota.get()).data(), quota);
    });
    await check('before-write fresh actor fence and queued-write failure commit nothing', async () => {
      const f = await fixture();
      await rejects(() => f.service({ beforeWrites() { records.get(f.people.hr.uid).disabled = true; } }).publish(f.req('hr', f.pub())), 'permission-denied');
      records.get(f.people.hr.uid).disabled = false;
      await assert.rejects(() => f.service({}, failingDb(null, true)).publish(f.req('hr', f.pub())), /synthetic queued-write crash/);
      assert.equal((await f.root.collection('hr_documents').get()).size, 0); assert.equal((await f.jobs()).size, 0); assert.equal((await f.ops()).size, 0);
      assert.equal((await f.people.hr.quota.get()).exists, false);
    });
    await check('final read rechecks Auth and membership; revoked request cannot return private content', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub()));
      await rejects(() => f.service({ beforeFinalize() { records.get(f.people.target.uid).disabled = true; } })
        .get(f.req('target', { document_id: d.document_id })), 'permission-denied');
      records.get(f.people.target.uid).disabled = false;
      await rejects(() => f.service({ async beforeFinalize() { await f.root.collection('users').doc(f.people.target.uid).update({ active: false }); } })
        .listMine(f.req('target', {})), 'permission-denied');
    });
    await check('manager-only revision receipt pagination does not expose unrelated private receipts', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.procedure()));
      for (let i = 0; i < PAGE_SIZE + 2; ++i) { const name = 'reader' + String(i).padStart(2, '0'); await f.add(name);
        await s.markOpened(f.req(name, f.receipt(d, 'opened-' + name))); }
      for (const name of ['target', 'command']) await rejects(() => s.listReceipts(f.req(name, { document_id: d.document_id, revision: 1 })), 'permission-denied');
      const first = await s.listReceipts(f.req('hr', { document_id: d.document_id, revision: 1 })); assert.equal(first.items.length, 25); assert.ok(first.next_cursor);
      const second = await s.listReceipts(f.req('super', { document_id: d.document_id, revision: 1, cursor: first.next_cursor })); assert.equal(second.items.length, 2); assert.equal(second.next_cursor, null);
      assert.equal(new Set([...first.items, ...second.items].map(r => r.recipient_uid)).size, 27); assert.equal((await f.jobs()).size, 1);
      await rejects(() => s.listReceipts(f.req('hr', { document_id: d.document_id, revision: 1, cursor: '../bad' })), 'invalid-argument');
    });
    await check('bounded publication lists use stable document-ID cursor without duplicating rows', async () => {
      const f = await fixture(), s = f.service();
      for (let i = 0; i < PAGE_SIZE + 2; ++i) { if (i && i % 10 === 0) f.at += 60000; await s.publish(f.req('hr', f.pub('page-publication-' + i))); }
      const first = await s.listMine(f.req('target', {})), next = await s.listMine(f.req('target', { cursor: first.next_cursor }));
      assert.equal(first.items.length, 25); assert.equal(next.items.length, 2); assert.equal(next.next_cursor, null);
      assert.equal(new Set([...first.items, ...next.items].map(d => d.document_id)).size, 27);
      assert.equal((await s.listManaged(f.req('hr', { kind: 'document' }))).items.length, 25);
      assert.equal((await s.listProcedures(f.req('target', {}))).items.length, 0);
    });
    await check('corrupt receipt/revision fails closed rather than inventing an acknowledgment', async () => {
      const f = await fixture(), s = f.service(), d = await s.publish(f.req('hr', f.pub())); await s.markOpened(f.req('target', f.receipt(d)));
      const ref = f.version(d).collection('receipts').doc(f.people.target.uid); await ref.update({ acknowledged_at_ms: f.at - 1000 });
      await rejects(() => s.get(f.req('target', { document_id: d.document_id })), 'failed-precondition');
      await rejects(() => s.listReceipts(f.req('hr', { document_id: d.document_id, revision: 1 })), 'failed-precondition');
      await f.version(d).update({ revision: 999 }); await rejects(() => s.get(f.req('hr', { document_id: d.document_id })), 'failed-precondition');
      assert.equal((await f.jobs()).size, 1);
    });
    console.log('HR documents integration: ' + passed + '/' + passed + ' PASS; actual Firestore, synthetic Auth, no transport.');
  } finally {
    await cleanup(); if (priorRuntime) { if (priorRuntime.exists) await runtime.set(priorRuntime.data()); else await runtime.delete(); }
    await app.delete();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
