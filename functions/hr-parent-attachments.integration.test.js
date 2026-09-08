'use strict';
const assert = require('node:assert/strict');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Existing loopback emulator only');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq', 'Demo project only');
process.env.METADATA_SERVER_DETECTION = 'none';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const admin = require('firebase-admin');
const { createHrRequests } = require('./hr-requests');
const { createHrDocuments } = require('./hr-documents');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const app = admin.initializeApp({ projectId: 'demo-resq' }, 'hr-parent-attachments-' + process.pid), db = app.firestore();
const run = randomBytes(6).toString('hex'), roots = [], quotas = new Map(), records = new Map();
const AUTH_TIME = Date.parse('2026-09-01T00:00:00Z') / 1000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceFiles = ['hr-requests.js', 'hr-documents.js', 'ops-member-identity.js'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file,
  createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex')]));
const beforeHashes = sourceHashes();
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const auth = { async getUser(uid) {
  const record = records.get(uid);
  if (record instanceof Error) throw record;
  if (!record) throw Object.assign(new Error('synthetic missing account'), { code: 'auth/user-not-found' });
  return structuredClone(record);
} };
const identity = createOpsMemberIdentity({ db, HttpsError });
const fails = (fn, code) => assert.rejects(fn, error => error?.code === code);
const syncFails = (fn, code) => assert.throws(fn, error => error?.code === code);
let sequence = 0, passed = 0, cleanedRoots = 0, cleanedQuotas = 0;
async function fixture() {
  const sid = 'hr_parent_attach_it_' + run + '_' + (++sequence), root = db.doc('stations/' + sid); roots.push(root);
  await root.set({ synthetic: true });
  const f = { sid, root, at: Date.parse('2026-09-08T09:00:00Z'), people: {} };
  for (const [name, role, superUser] of [['owner', 'firefighter'], ['other', 'firefighter'],
    ['hr', 'hr_coordinator'], ['command', 'station_commander'], ['super', null, true]]) {
    const uid = name + '_' + sid, claims = { stationId: sid, ...(superUser ? { super: true } : { role }) };
    f.people[name] = { uid, claims };
    records.set(uid, { uid, disabled: false, customClaims: structuredClone(claims),
      tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() });
    if (!superUser) await root.collection('users').doc(uid).set({ uid, stationId: sid, role, active: true, is_active: true });
    for (const family of ['request', 'document']) {
      const ref = db.doc('hr_' + family + '_actor_quotas/' + hash(['hr-' + family + '-quota-v1', uid])); quotas.set(ref.path, ref);
    }
  }
  f.req = (name, data = {}, token = {}) => ({ auth: { uid: f.people[name].uid,
    token: { ...f.people[name].claims, auth_time: AUTH_TIME, ...token } }, data });
  f.service = (kind, hooks = {}) => (kind === 'request' ? createHrRequests : createHrDocuments)({ db, auth, HttpsError, clock: () => f.at, hooks });
  f.id = (kind, value) => typeof value === 'string' ? value : value[kind === 'request' ? 'case_id' : 'document_id'];
  f.ref = (kind, value) => root.collection(kind === 'request' ? 'hr_requests' : 'hr_documents').doc(f.id(kind, value));
  f.jobs = kind => root.collection('hr_' + kind + '_notification_jobs');
  f.create = async (kind, { owner = 'owner', target = 'owner', procedure = false } = {}) => kind === 'request'
    ? f.service(kind).create(f.req(owner, { request_id: 'create-parent', subject: 'PRIVATE_SUBJECT', text: 'PRIVATE_REQUEST_TEXT', send_now: false }))
    : f.service(kind).publish(f.req('hr', { request_id: 'publish-parent', kind: procedure ? 'procedure' : 'document',
      ...(!procedure ? { target_uid: f.people[target].uid } : {}), title: 'PRIVATE_TITLE', text: 'PRIVATE_DOCUMENT_TEXT', requires_ack: true, send_now: false }));
  f.input = (kind, name, parent, expected, label, extra = {}) => ({
    ctx: identity.context(f.req(name)), authTime: AUTH_TIME, parent_kind: kind, parent_id: f.id(kind, parent),
    expected_revision: expected, attachment_id: hash(['attachment', label]), event_id: hash(['attachment-event', kind, label]), ...extra
  });
  f.readInput = (input, revision) => ({ ctx: input.ctx, authTime: input.authTime, parent_kind: input.parent_kind,
    parent_id: input.parent_id, attachment_id: input.attachment_id,
    ...(input.parent_kind === 'document' && revision !== undefined ? { revision } : {}) });
  f.read = (input, revision) => db.runTransaction(tx => f.service(input.parent_kind).attachmentPorts.read(tx, f.readInput(input, revision)));
  f.marker = input => root.collection('integration_markers').doc(hash([input.parent_kind, input.parent_id, input.attachment_id]));
  // This small caller is deliberately NOT the separate attachment service:
  // no object/intent schema, upload, byte quota or file validation is faked.
  // Its test-owned marker proves real parent ports compose with an atomic
  // caller receipt. Actual parent/domain logic is never copied or stubbed.
  f.attach = (input, options = {}) => {
    const service = options.service || f.service(input.parent_kind), ports = service.attachmentPorts;
    return db.runTransaction(async nativeTx => {
      const tx = options.wrap ? options.wrap(nativeTx) : nativeTx, marker = f.marker(input);
      const prior = await tx.get(marker);
      if (prior.exists) {
        const result = prior.data().result;
        await ports.read(tx, f.readInput(input, result.revision));
        return { ...result, replayed: true };
      }
      const plan = await ports.prepare(tx, input); assert.equal(Object.isFrozen(plan), true);
      if (options.afterPrepare) await options.afterPrepare(plan);
      await ports.recheck(tx, plan);
      // Native Firestore enforces all reads before this point. If commit
      // performs another read, this real transaction must fail the test.
      tx.create(marker, { synthetic_caller: true, result: null });
      const result = ports.commit(tx, plan, { at: f.at });
      assert.ok(result && typeof result.then !== 'function', 'commit is synchronous/write-only');
      assert.equal(result.linked, true); assert.equal(result.event_id, input.event_id);
      tx.set(marker, { synthetic_caller: true, result });
      return { ...result, replayed: false };
    });
  };
  f.snapshot = async (kind, parent) => {
    const ref = f.ref(kind, parent);
    const [p, children, jobs, markers, operations] = await Promise.all([ref.get(), ref.collection(kind === 'request' ? 'events' : 'revisions').get(),
      f.jobs(kind).get(), root.collection('integration_markers').get(), root.collection('hr_' + kind + '_operations').get()]);
    const data = snap => snap.docs.map(d => [d.id, d.data()]);
    const q = [];
    for (const item of quotas.values()) { const snap = await item.get(); if (snap.exists) q.push([item.path, snap.data()]); }
    return { parent: p.data(), children: data(children), jobs: data(jobs), markers: data(markers), operations: data(operations), quotas: q };
  };
  return f;
}
async function cleanup() {
  for (const root of roots.splice(0)) {
    assert.ok(root.path.startsWith('stations/hr_parent_attach_it_' + run + '_'));
    await db.recursiveDelete(root); assert.equal((await root.get()).exists, false);
    assert.equal((await root.listCollections()).length, 0); ++cleanedRoots;
  }
  for (const ref of quotas.values()) { await ref.delete(); assert.equal((await ref.get()).exists, false); ++cleanedQuotas; }
  quotas.clear(); records.clear();
}
async function check(name, fn) {
  try { await fn(); ++passed; console.log('PASS ' + name); } finally { await cleanup(); }
}
function wrapFailure({ readPath, jobGroup } = {}) {
  return native => new Proxy(native, { get(target, key) {
    if (key === 'get' && readPath) return ref => ref.path === readPath
      ? Promise.reject(Object.assign(new Error('synthetic read unavailable'), { code: 'unavailable' })) : target.get(ref);
    if (key === 'create' && jobGroup) return (ref, value) => {
      const result = target.create(ref, value);
      if (ref.parent.id === jobGroup) throw Object.assign(new Error('synthetic failure after queued job write'), { code: 'unavailable' });
      return result;
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
function assertJob(job, input, at, { type, audience, recipient, revision }) {
  assert.deepEqual(Object.keys(job).sort(), ['schema', 'event_id', input.parent_kind === 'request' ? 'case_id' : 'document_id',
    'station_id', 'actor_uid', 'actor_auth_time', 'audience', ...(recipient ? ['recipient_uid'] : []),
    ...(input.parent_kind === 'document' ? ['revision'] : []), 'type', 'status', 'delivery_status', 'created_at_ms',
    'send_now', 'consent_expires_at_ms', 'routine_after_quiet', 'exclude_actor'].sort());
  assert.equal(job.station_id, input.ctx.sid); assert.equal(job.actor_uid, input.ctx.uid);
  assert.equal(job.actor_auth_time, input.authTime); assert.equal(job.event_id, input.event_id);
  assert.equal(job.type, type); assert.equal(job.audience, audience); if (recipient) assert.equal(job.recipient_uid, recipient);
  if (revision !== undefined) assert.equal(job.revision, revision);
  assert.equal(job.created_at_ms, at); assert.equal(job.status, 'policy_pending'); assert.equal(job.delivery_status, 'intent_only');
  assert.equal(job.send_now, false); assert.equal(job.consent_expires_at_ms, 0);
  assert.equal(job.routine_after_quiet, true); assert.equal(job.exclude_actor, true);
  assert.equal(JSON.stringify(job).includes('PRIVATE_'), false);
}
(async () => {
  const runtimeRef = db.doc('config/runtime'); let runtimeBefore;
  try {
    runtimeBefore = await runtimeRef.get();
    console.log(JSON.stringify({ run, source_hashes: beforeHashes, transport: 'none', auth: 'synthetic', caller: 'test-marker-not-attachment-service' }));
    await check('request owner attachment uses common event/time, increments revision and creates generic work without parent quota', async () => {
      const f = await fixture(), c = await f.create('request'), s = f.service('request');
      const prior = await f.snapshot('request', c), input = f.input('request', 'owner', c, 1, 'owner-first');
      f.at += 4321; const out = await f.attach(input);
      assert.equal(out.revision, 2); const p = (await f.ref('request', c).get()).data();
      assert.equal(p.status, 'open'); assert.deepEqual(p.attachment_ids, [input.attachment_id]); assert.equal(p.updated_at_ms, f.at);
      const e = (await f.ref('request', c).collection('events').doc(input.event_id).get()).data();
      assert.deepEqual(e, { schema: 'hr-request-event-v1', event_id: input.event_id, case_id: c.case_id, station_id: f.sid,
        actor_uid: f.people.owner.uid, kind: 'attachment', attachment_id: input.attachment_id, revision: 2, created_at_ms: f.at });
      assertJob((await f.jobs('request').doc(input.event_id).get()).data(), input, f.at, { type: 'hr_request', audience: 'station_hr' });
      const dto = await s.get(f.req('owner', { case_id: c.case_id }));
      assert.deepEqual(dto.events.find(e => e.event_id === input.event_id), { event_id: input.event_id, actor_uid: f.people.owner.uid,
        kind: 'attachment', attachment_id: input.attachment_id, revision: 2, created_at_ms: f.at });
      const after = await f.snapshot('request', c); assert.deepEqual(after.quotas, prior.quotas); assert.deepEqual(after.operations, prior.operations);
    });
    await check('attachment preserves waiting_employee; explicit reply still reopens; closed blocks new attachment but permits existing read/replay', async () => {
      const f = await fixture(), c = await f.create('request'), s = f.service('request');
      const waiting = await s.setStatus(f.req('hr', { request_id: 'waiting-state', case_id: c.case_id, expected_revision: 1, status: 'waiting_employee', send_now: false }));
      const input = f.input('request', 'owner', c, waiting.revision, 'waiting-file'), added = await f.attach(input);
      assert.equal((await f.ref('request', c).get()).data().status, 'waiting_employee');
      const replied = await s.reply(f.req('owner', { request_id: 'real-answer', case_id: c.case_id, expected_revision: added.revision, text: 'Explicit answer', send_now: false }));
      assert.equal(replied.status, 'open');
      const closed = await s.setStatus(f.req('hr', { request_id: 'closed-state', case_id: c.case_id, expected_revision: replied.revision, status: 'closed', send_now: false }));
      const before = await f.snapshot('request', c);
      await fails(() => f.attach(f.input('request', 'owner', c, closed.revision, 'closed-new')), 'failed-precondition');
      assert.deepEqual((await f.read(input)).attachment_ids, [input.attachment_id]);
      assert.equal((await f.attach(input)).replayed, true); assert.deepEqual(await f.snapshot('request', c), before);
    });
    await check('request HR/signed-super route to owner; other member/command/cross-station authority fails closed', async () => {
      const f = await fixture(), c = await f.create('request');
      for (const name of ['other', 'command']) await fails(() => f.attach(f.input('request', name, c, 1, 'denied-' + name)), 'permission-denied');
      const g = await fixture(); await fails(() => g.attach(g.input('request', 'hr', c, 1, 'cross-station')), 'not-found');
      let rev = 1;
      for (const name of ['hr', 'super']) {
        const input = f.input('request', name, c, rev, 'manager-' + name), result = await f.attach(input); rev = result.revision;
        assertJob((await f.jobs('request').doc(input.event_id).get()).data(), input, f.at,
          { type: 'hr_reply', audience: 'person', recipient: f.people.owner.uid });
      }
    });
    await check('document N+1 inherits content/membership; N receipts stay immutable and ordinary revise preserves inherited IDs', async () => {
      const f = await fixture(), d = await f.create('document'), s = f.service('document'), ref = f.ref('document', d);
      await s.markOpened(f.req('owner', { request_id: 'open-old-revision', document_id: d.document_id, revision: 1 }));
      await s.acknowledge(f.req('owner', { request_id: 'ack-old-revision', document_id: d.document_id, revision: 1 }));
      const v1 = (await ref.collection('revisions').doc('1').get()).data(), receiptRef = ref.collection('revisions').doc('1').collection('receipts').doc(f.people.owner.uid);
      const receipt = (await receiptRef.get()).data(), input = f.input('document', 'hr', d, 1, 'doc-file');
      f.at += 3000; const result = await f.attach(input); assert.equal(result.revision, 2);
      const v2 = (await ref.collection('revisions').doc('2').get()).data();
      for (const key of ['title', 'text', 'requires_ack']) assert.equal(v2[key], v1[key]);
      assert.deepEqual(v2.attachment_ids, [input.attachment_id]); assert.equal(v2.created_at_ms, f.at);
      assert.deepEqual((await ref.collection('revisions').doc('1').get()).data(), v1); assert.deepEqual((await receiptRef.get()).data(), receipt);
      assert.equal((await ref.collection('revisions').doc('2').collection('receipts').get()).size, 0);
      assertJob((await f.jobs('document').doc(input.event_id).get()).data(), input, f.at,
        { type: 'hr_document', audience: 'person', recipient: f.people.owner.uid, revision: 2 });
      const revised = await s.revise(f.req('hr', { request_id: 'ordinary-text-revision', document_id: d.document_id, expected_revision: 2,
        title: 'Changed title', text: 'Changed text', requires_ack: false, send_now: false }));
      assert.equal(revised.revision, 3); assert.deepEqual((await s.get(f.req('owner', { document_id: d.document_id }))).attachment_ids, [input.attachment_id]);
      const ownerInput = { ...input, ctx: identity.context(f.req('owner')) };
      await fails(() => f.read(ownerInput, 1), 'permission-denied');
      for (const n of [2, 3]) assert.deepEqual((await f.read(ownerInput, n)).attachment_ids, [input.attachment_id]);
      const before = await f.snapshot('document', d); assert.equal((await f.attach(input)).revision, 2); assert.deepEqual(await f.snapshot('document', d), before);
    });
    await check('document upload is manager-only; procedure and self-target notification behavior remains exact', async () => {
      const f = await fixture(), d = await f.create('document');
      for (const name of ['owner', 'other', 'command']) await fails(() => f.attach(f.input('document', name, d, 1, 'doc-denied-' + name)), 'permission-denied');
      const input = f.input('document', 'super', d, 1, 'super-doc'); await f.attach(input);
      const g = await fixture(), procedure = await g.create('document', { procedure: true }), procInput = g.input('document', 'hr', procedure, 1, 'procedure-file');
      await g.attach(procInput); assertJob((await g.jobs('document').doc(procInput.event_id).get()).data(), procInput, g.at,
        { type: 'hr_procedure', audience: 'station_members', revision: 2 });
      const h = await fixture(), self = await h.create('document', { target: 'hr' }), selfInput = h.input('document', 'hr', self, 1, 'self-file');
      const out = await h.attach(selfInput); assert.equal(out.notification_status, 'no_other_recipient'); assert.equal((await h.jobs('document').get()).size, 0);
    });
    for (const kind of ['request', 'document']) {
      await check(kind + ' same-attachment caller replay is one parent publication/job and remains read-only after sign-in refresh', async () => {
        const f = await fixture(), p = await f.create(kind), name = kind === 'request' ? 'owner' : 'hr', input = f.input(kind, name, p, 1, 'same-file');
        const results = await Promise.all([f.attach(input), f.attach(input), f.attach(input)]);
        assert.equal(results.filter(r => !r.replayed).length, 1); assert.ok(results.every(r => r.revision === 2));
        assert.equal((await f.jobs(kind).get()).size, 2); assert.equal((await f.root.collection('integration_markers').get()).size, 1);
        records.get(input.ctx.uid).tokensValidAfterTime = new Date((AUTH_TIME + 1) * 1000).toUTCString();
        await fails(() => f.attach(input), 'permission-denied');
        const before = await f.snapshot(kind, p), fresh = { ...input, authTime: AUTH_TIME + 1 };
        assert.equal((await f.attach(fresh)).replayed, true); assert.deepEqual(await f.snapshot(kind, p), before);
      });
      await check(kind + ' competing new attachments use parent CAS and cannot partially publish the loser', async () => {
        const f = await fixture(), p = await f.create(kind), name = kind === 'request' ? 'owner' : 'hr';
        const results = await Promise.allSettled(['a', 'b'].map(id => f.attach(f.input(kind, name, p, 1, 'competing-' + id))));
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'aborted');
        assert.equal((await f.jobs(kind).get()).size, 2); assert.equal((await f.root.collection('integration_markers').get()).size, 1);
        assert.equal((await f.ref(kind, p).collection(kind === 'request' ? 'events' : 'revisions').get()).size, 2);
      });
      await check(kind + ' final actor Auth revocation, disabled or moved state aborts before publication', async () => {
        const f = await fixture(), p = await f.create(kind), name = kind === 'request' ? 'owner' : 'hr', uid = f.people[name].uid;
        const original = structuredClone(records.get(uid)), before = await f.snapshot(kind, p);
        for (const change of [{ disabled: true }, { customClaims: { ...original.customClaims, stationId: 'other_station' } },
          { tokensValidAfterTime: new Date((AUTH_TIME + 1) * 1000).toUTCString() }]) {
          records.set(uid, structuredClone(original));
          const service = f.service(kind, { beforeWrites({ stage }) { if (stage === 'attachment') Object.assign(records.get(uid), change); } });
          await fails(() => f.attach(f.input(kind, name, p, 1, 'revoked'), { service }), 'permission-denied');
          assert.deepEqual(await f.snapshot(kind, p), before);
        }
      });
      await check(kind + ' queued generic-job failure rolls back parent and synthetic ready marker together', async () => {
        const f = await fixture(), p = await f.create(kind), input = f.input(kind, kind === 'request' ? 'owner' : 'hr', p, 1, 'rollback'), before = await f.snapshot(kind, p);
        await fails(() => f.attach(input, { wrap: wrapFailure({ jobGroup: 'hr_' + kind + '_notification_jobs' }) }), 'unavailable');
        assert.deepEqual(await f.snapshot(kind, p), before); assert.equal((await f.marker(input).get()).exists, false);
      });
      await check(kind + ' unreadable parent is an error, never missing/success or an advanced caller receipt', async () => {
        const f = await fixture(), p = await f.create(kind), input = f.input(kind, kind === 'request' ? 'owner' : 'hr', p, 1, 'read-failure'), before = await f.snapshot(kind, p);
        await fails(() => f.attach(input, { wrap: wrapFailure({ readPath: f.ref(kind, p).path }) }), 'unavailable');
        assert.deepEqual(await f.snapshot(kind, p), before);
      });
      await check(kind + ' transaction plan requires recheck, same transaction and once-only synchronous commit', async () => {
        const f = await fixture(), p = await f.create(kind), input = f.input(kind, kind === 'request' ? 'owner' : 'hr', p, 1, 'plan'), ports = f.service(kind).attachmentPorts;
        const before = await f.snapshot(kind, p); let held;
        await db.runTransaction(async tx => { held = await ports.prepare(tx, input); syncFails(() => ports.commit(tx, held, { at: f.at }), 'failed-precondition'); });
        await db.runTransaction(async tx => { syncFails(() => ports.commit(tx, held, { at: f.at }), 'failed-precondition'); await fails(() => ports.recheck(tx, held), 'failed-precondition'); });
        await fails(() => db.runTransaction(async tx => { const plan = await ports.prepare(tx, input); await ports.recheck(tx, plan);
          ports.commit(tx, plan, { at: f.at }); ports.commit(tx, plan, { at: f.at }); }), 'failed-precondition');
        assert.deepEqual(await f.snapshot(kind, p), before);
      });
      await check(kind + ' cumulative membership is bounded to10 unique IDs and attachment ports do not double-charge parent quota', async () => {
        const f = await fixture(), p = await f.create(kind), name = kind === 'request' ? 'owner' : 'hr', before = await f.snapshot(kind, p); let last;
        for (let i = 0; i < 10; ++i) { last = f.input(kind, name, p, i + 1, 'capacity-' + i); await f.attach(last); }
        assert.equal((await f.read(last, kind === 'document' ? 11 : undefined)).attachment_ids.length, 10);
        const full = await f.snapshot(kind, p);
        await fails(() => f.attach(f.input(kind, name, p, 11, 'eleventh')), 'resource-exhausted');
        assert.deepEqual(await f.snapshot(kind, p), full); assert.deepEqual(full.quotas, before.quotas); assert.deepEqual(full.operations, before.operations);
      });
    }
    await check('document final target Auth move/disable blocks even when manager remains authorized', async () => {
      const f = await fixture(), d = await f.create('document'), original = structuredClone(records.get(f.people.owner.uid)), before = await f.snapshot('document', d);
      for (const change of [{ disabled: true }, { customClaims: { ...original.customClaims, stationId: 'other_station' } }]) {
        records.set(f.people.owner.uid, structuredClone(original));
        const service = f.service('document', { beforeWrites({ stage }) { if (stage === 'attachment') Object.assign(records.get(f.people.owner.uid), change); } });
        await fails(() => f.attach(f.input('document', 'hr', d, 1, 'target-moved'), { service }), 'permission-denied');
        assert.deepEqual(await f.snapshot('document', d), before);
      }
    });
    await check('legacy absent membership remains empty; malformed membership and attachment history reject rather than disappear', async () => {
      const f = await fixture(), d = await f.create('document'), s = f.service('document'), vref = f.ref('document', d).collection('revisions').doc('1');
      await vref.update({ attachment_ids: admin.firestore.FieldValue.delete() });
      assert.deepEqual((await s.get(f.req('owner', { document_id: d.document_id }))).attachment_ids, []);
      const input = f.input('document', 'hr', d, 1, 'legacy'); await f.attach(input);
      await vref.update({ attachment_ids: [input.attachment_id, input.attachment_id] });
      await fails(() => f.read(input, 1), 'failed-precondition');
      const g = await fixture(), c = await g.create('request'), requestInput = g.input('request', 'owner', c, 1, 'bad-history'); await g.attach(requestInput);
      const event = g.ref('request', c).collection('events').doc(requestInput.event_id);
      await event.update({ text: 'PRIVATE_UNEXPECTED_TEXT' });
      await fails(() => g.service('request').get(g.req('owner', { case_id: c.case_id })), 'failed-precondition');
    });
    await check('attachment routine publication never inherits a night override or private filename fields', async () => {
      const f = await fixture(), p = await f.create('request'); f.at = Date.parse('2026-09-08T20:30:00Z');
      const input = f.input('request', 'owner', p, 1, 'night', { display_name: 'PRIVATE_FILE.pdf', content_sha256: 'PRIVATE_DIGEST', send_now: true });
      await f.attach(input); assertJob((await f.jobs('request').doc(input.event_id).get()).data(), input, f.at, { type: 'hr_request', audience: 'station_hr' });
    });
    console.log('Parent attachment ports: ' + passed + '/' + passed + ' passed; actual parent factories/Firestore, synthetic Auth and caller marker only. No file service, Storage, dispatcher, UI, FCM or quota-integration claim.');
  } finally {
    await cleanup();
    if (runtimeBefore) { const after = await runtimeRef.get(); assert.equal(after.exists, runtimeBefore.exists); if (after.exists) assert.deepEqual(after.data(), runtimeBefore.data(), 'shared runtime untouched'); }
    assert.deepEqual(sourceHashes(), beforeHashes, 'parent sources unchanged during run');
    console.log(JSON.stringify({ run, cleaned_station_roots: cleanedRoots, cleaned_quota_docs: cleanedQuotas,
      exact_cleanup_verified: true, runtime_untouched: true, source_hashes_unchanged: true }));
    await app.delete();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
