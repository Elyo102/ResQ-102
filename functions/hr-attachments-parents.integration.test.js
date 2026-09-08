'use strict';
// Actual attachment assembly/session + actual parent factories + native Firestore.
// Storage below is a strict IN-MEMORY contract double, not GCS or emulator
// precondition evidence. The separate Storage invariant remains BLOCKED.
const assert = require('node:assert/strict');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080', 'Existing loopback Firestore only');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq', 'Explicit demo project required');
process.env.METADATA_SERVER_DETECTION = 'none';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const admin = require('firebase-admin');
const { MAX_BYTES } = require('./hr-attachments');
const { createHrAttachmentService } = require('./hr-attachment-service');
const { createHrRequests } = require('./hr-requests');
const { createHrDocuments } = require('./hr-documents');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const app = admin.initializeApp({ projectId: 'demo-resq' }, 'hr-attachments-parents-' + process.pid), db = app.firestore();
const run = randomBytes(6).toString('hex'), roots = [], quotaRefs = new Map(), memories = [], records = new Map();
const AUTH_TIME = Date.parse('2026-09-01T00:00:00Z') / 1000;
const PDF = Buffer.from('%PDF-1.4\nPRIVATE_SYNTHETIC_BYTES\n');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['hr-attachments.js', 'hr-attachment-service.js', 'hr-documents.js', 'hr-requests.js', 'ops-member-identity.js'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha(fs.readFileSync(path.join(__dirname, file)))]));
const frozenSources = sourceHashes();
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const auth = { async getUser(uid) {
  const value = records.get(uid);
  if (value instanceof Error) throw value;
  if (!value) throw Object.assign(new Error('synthetic missing account'), { code: 'auth/user-not-found' });
  return structuredClone(value);
} };
const identity = createOpsMemberIdentity({ db, HttpsError });
const denied = (fn, code) => assert.rejects(fn, error => error?.code === code);
let sequence = 0, passed = 0, cleanedRoots = 0, cleanedQuotas = 0;

function memoryStorage(sid) {
  const objects = new Map(), calls = { saves: 0, created: 0, reads: 0, removes: 0 };
  let generation = 0;
  const m = { objects, calls, beforeReadReturn: null };
  const checkPath = value => assert.ok(value.startsWith('hr-private/' + sid + '/'), 'memory objects stay in exact synthetic station');
  m.storage = {
    async save(input) {
      checkPath(input.path); ++calls.saves;
      assert.equal(input.ifGenerationMatch, 0); assert.equal(input.cacheControl, 'private, no-store');
      assert.equal(input.contentDisposition, 'attachment'); assert.ok(Buffer.isBuffer(input.bytes));
      assert.ok(input.bytes.length <= MAX_BYTES); assert.equal(input.contentType, 'application/pdf');
      if (objects.has(input.path)) throw Object.assign(new Error('synthetic object exists'), { code: 'precondition-failed' });
      const saved = { generation: String(++generation), bytes: Buffer.from(input.bytes), metadata: structuredClone(input.metadata) };
      objects.set(input.path, saved); ++calls.created; return { generation: saved.generation };
    },
    async read(input) {
      checkPath(input.path); ++calls.reads;
      assert.ok(Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0 && input.maxBytes <= MAX_BYTES);
      const saved = objects.get(input.path);
      if (!saved || (input.generation != null && String(input.generation) !== saved.generation)) return null;
      const result = { generation: saved.generation, metadata: structuredClone(saved.metadata),
        ...(saved.bytes.length > input.maxBytes ? { oversize: true, bytes: null } : { bytes: Buffer.from(saved.bytes) }) };
      if (m.beforeReadReturn) { const hook = m.beforeReadReturn; m.beforeReadReturn = null; await hook(); }
      return result;
    },
    async remove(input) {
      checkPath(input.path); ++calls.removes;
      if (input.generation == null) return { removed: false, reason: 'no-generation' };
      const saved = objects.get(input.path);
      if (!saved) return { removed: false, reason: 'not-found' };
      if (String(input.generation) !== saved.generation) return { removed: false, reason: 'generation-mismatch' };
      objects.delete(input.path); return { removed: true };
    }
  };
  memories.push(m); return m;
}

async function fixture() {
  const sid = 'hr_attach_parents_it_' + run + '_' + (++sequence), root = db.doc('stations/' + sid); roots.push(root);
  await root.set({ synthetic: true });
  const f = { sid, root, at: Date.parse('2026-09-08T09:00:00Z'), people: {}, quotaRefs: [], memory: memoryStorage(sid) };
  for (const [name, role, superUser] of [['owner', 'firefighter'], ['other', 'firefighter'], ['hr', 'hr_coordinator'], ['command', 'station_commander'], ['super', null, true]]) {
    const uid = name + '_' + sid, claims = { stationId: sid, ...(superUser ? { super: true } : { role }) };
    f.people[name] = { uid, claims };
    records.set(uid, { uid, disabled: false, customClaims: structuredClone(claims), tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() });
    if (!superUser) await root.collection('users').doc(uid).set({ stationId: sid, role, active: true, is_active: true });
    for (const family of ['request', 'document', 'attachment']) {
      const ref = db.doc('hr_' + family + '_actor_quotas/' + hash(['hr-' + family + '-quota-v1', uid]));
      quotaRefs.set(ref.path, ref); f.quotaRefs.push(ref);
    }
  }
  f.req = (name, data = {}, token = {}) => ({ auth: { uid: f.people[name].uid, token: { ...f.people[name].claims, auth_time: AUTH_TIME, ...token } }, data });
  f.parent = (kind, database = db, hooks = {}) => (kind === 'document' ? createHrDocuments : createHrRequests)({ db: database, auth, HttpsError, clock: () => f.at, hooks });
  f.api = (kind, { database = db, hooks = {}, parentHooks = {} } = {}) => createHrAttachmentService({ db: database, auth, storage: f.memory.storage,
    HttpsError, requests: f.parent('request', database, kind === 'request' ? parentHooks : {}),
    documents: f.parent('document', database, kind === 'document' ? parentHooks : {}), clock: () => f.at, hooks });
  f.id = (kind, p) => p[kind === 'document' ? 'document_id' : 'case_id'];
  f.ref = (kind, p) => root.collection(kind === 'document' ? 'hr_documents' : 'hr_requests').doc(f.id(kind, p));
  f.jobs = kind => root.collection('hr_' + kind + '_notification_jobs');
  f.create = (kind, target = 'owner', procedure = false) => kind === 'document'
    ? f.parent(kind).publish(f.req('hr', { request_id: 'publish-parent', kind: procedure ? 'procedure' : 'document',
      ...(!procedure ? { target_uid: f.people[target].uid } : {}), title: 'PRIVATE_TITLE', text: 'PRIVATE_DOCUMENT_TEXT', requires_ack: true, send_now: false }))
    : f.parent(kind).create(f.req('owner', { request_id: 'create-parent', subject: 'PRIVATE_SUBJECT', text: 'PRIVATE_REQUEST_TEXT', send_now: false }));
  f.intent = (kind, p, revision, label = 'first-file') => ({ request_id: 'file-' + label, parent_kind: kind, parent_id: f.id(kind, p),
    parent_revision: revision, display_name: 'PRIVATE_FILE.pdf', declared_type: 'application/pdf', byte_length: PDF.length, content_sha256: sha(PDF) });
  f.uploadData = data => ({ ...data, content_base64: PDF.toString('base64') });
  f.ready = async (kind, p, name = kind === 'document' ? 'hr' : 'owner', revision = 1) => {
    const api = f.api(kind), data = f.intent(kind, p, revision);
    const reserved = await api.reserve(f.req(name, data));
    const out = await api.upload(f.req(name, f.uploadData(data)));
    assert.equal(out.attachment_id, reserved.attachment_id); assert.equal(out.state, 'ready');
    return { api, data, out, name, ref: root.collection('hr_attachments').doc(out.attachment_id) };
  };
  f.snapshot = async (kind, p) => {
    const ref = f.ref(kind, p), groups = [kind === 'document' ? 'revisions' : 'events'];
    const data = snap => snap.docs.map(d => [d.id, d.data()]);
    const [parent, children, jobs, attachments, ledgers, operations, qs] = await Promise.all([ref.get(), ref.collection(groups[0]).get(), f.jobs(kind).get(),
      root.collection('hr_attachments').get(), root.collection('hr_attachment_ledgers').get(), root.collection('hr_' + kind + '_operations').get(), db.getAll(...f.quotaRefs)]);
    return { parent: parent.data(), children: data(children), jobs: data(jobs), attachments: data(attachments), ledgers: data(ledgers), operations: data(operations),
      quotas: qs.map(q => [q.ref.path, q.exists ? q.data() : null]) };
  };
  return f;
}
async function cleanup() {
  for (const root of roots.splice(0)) {
    assert.ok(root.path.startsWith('stations/hr_attach_parents_it_' + run + '_'));
    await db.recursiveDelete(root); assert.equal((await root.get()).exists, false); assert.equal((await root.listCollections()).length, 0); ++cleanedRoots;
  }
  for (const ref of quotaRefs.values()) { await ref.delete(); assert.equal((await ref.get()).exists, false); ++cleanedQuotas; }
  quotaRefs.clear(); records.clear();
  for (const memory of memories.splice(0)) { memory.objects.clear(); assert.equal(memory.objects.size, 0); }
}
async function check(name, fn) { try { await fn(); ++passed; console.log('PASS ' + name); } finally { await cleanup(); } }
function jobFailureDatabase(kind) {
  return { collection: db.collection.bind(db), doc: db.doc.bind(db), runTransaction: fn => db.runTransaction(native => fn(new Proxy(native, {
    get(target, key) {
      if (key === 'create') return (ref, data) => {
        const out = target.create(ref, data);
        if (ref.parent.id === 'hr_' + kind + '_notification_jobs') throw Object.assign(new Error('synthetic failure after queued real job write'), { code: 'unavailable' });
        return out;
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    }
  }))) };
}
async function assertPublication(f, kind, p, ready, expectedRevision = 2) {
  const saved = (await ready.ref.get()).data(), parent = (await f.ref(kind, p).get()).data();
  assert.equal(saved.state, 'ready'); assert.equal(saved.base_revision, ready.data.parent_revision); assert.equal(saved.published_revision, expectedRevision);
  assert.equal(parent[kind === 'document' ? 'current_revision' : 'revision'], expectedRevision);
  const member = kind === 'document' ? (await f.ref(kind, p).collection('revisions').doc(String(expectedRevision)).get()).data() : parent;
  assert.deepEqual(member.attachment_ids, [saved.attachment_id]);
  const jobs = await f.jobs(kind).get(), matching = jobs.docs.filter(d => d.id === saved.link_event_id); assert.equal(matching.length, 1);
  const job = matching[0].data(), actorUid = f.people[ready.name].uid, personal = kind === 'document' || actorUid !== f.people.owner.uid;
  assert.deepEqual(Object.keys(job).sort(), ['schema', 'event_id', kind === 'document' ? 'document_id' : 'case_id', 'station_id', 'actor_uid', 'actor_auth_time',
    ...(kind === 'document' ? ['revision'] : []), 'audience', ...(personal ? ['recipient_uid'] : []), 'type', 'status', 'delivery_status', 'created_at_ms',
    'send_now', 'consent_expires_at_ms', 'routine_after_quiet', 'exclude_actor'].sort());
  assert.equal(job.event_id, saved.link_event_id); assert.equal(job.station_id, f.sid); assert.equal(job.actor_uid, actorUid); assert.equal(job.actor_auth_time, AUTH_TIME);
  assert.equal(job.audience, personal ? 'person' : 'station_hr'); if (personal) assert.equal(job.recipient_uid, f.people.owner.uid);
  assert.equal(job.type, kind === 'document' ? 'hr_document' : personal ? 'hr_reply' : 'hr_request');
  assert.equal(job.status, 'policy_pending'); assert.equal(job.delivery_status, 'intent_only'); assert.equal(job.created_at_ms, saved.ready_at_ms);
  assert.equal(job.send_now, false); assert.equal(job.consent_expires_at_ms, 0); assert.equal(job.routine_after_quiet, true); assert.equal(job.exclude_actor, true);
  for (const secret of ['PRIVATE_', saved.display_name, saved.content_sha256, saved.object_path, saved.attachment_id]) assert.equal(JSON.stringify(job).includes(secret), false);
  const ledger = await f.root.collection('hr_attachment_ledgers').get(); assert.equal(ledger.size, 1);
  assert.deepEqual(ledger.docs[0].data().entries, { [saved.attachment_id]: PDF.length });
  return saved;
}
function readyCalls(f, kind, p, ready, token = {}) {
  const { api, name, data, out } = ready, id = out.attachment_id;
  return [() => api.reserve(f.req(name, data, token)), () => api.upload(f.req(name, f.uploadData(data), token)),
    () => api.resume(f.req(name, { attachment_id: id }, token)),
    () => api.download(f.req(name, { attachment_id: id, ...(kind === 'document' ? { revision: 2 } : {}) }, token)),
    () => api.list(f.req(name, { parent_kind: kind, parent_id: f.id(kind, p), ...(kind === 'document' ? { revision: 2 } : {}) }, token))];
}

(async () => {
  const runtime = db.doc('config/runtime'); let priorRuntime;
  try {
    priorRuntime = await runtime.get();
    console.log(JSON.stringify({ run, source_hashes: frozenSources, firestore: 'actual-demo', parents: 'actual', attachment_service: 'actual',
      storage: 'strict-memory-double-NOT-GCS', auth: 'synthetic', assembly_session: 'actual', callable_transport: 'NOT_TESTED', storage_emulator_invariant: 'BLOCKED-separate-gate' }));
    await check('document actual reserve/upload publishes N+1; old acknowledgement stays immutable and later revision carries membership', async () => {
      const f = await fixture(), p = await f.create('document'), parent = f.parent('document'), ref = f.ref('document', p);
      const receiptData = { document_id: p.document_id, revision: 1 };
      await parent.markOpened(f.req('owner', { ...receiptData, request_id: 'open-old-revision' }));
      await parent.acknowledge(f.req('owner', { ...receiptData, request_id: 'ack-old-revision' }));
      const v1 = ref.collection('revisions').doc('1'), oldVersion = (await v1.get()).data(), receipt = v1.collection('receipts').doc(f.people.owner.uid), oldAck = (await receipt.get()).data();
      const before = await f.snapshot('document', p), api = f.api('document'), data = f.intent('document', p, 1);
      const reserved = await api.reserve(f.req('hr', data)), middle = await f.snapshot('document', p);
      for (const key of ['parent', 'children', 'jobs', 'operations']) assert.deepEqual(middle[key], before[key], 'reserve does not publish ' + key);
      assert.equal(f.memory.calls.saves, 0); assert.equal(middle.attachments[0][1].state, 'reserved');
      const out = await api.upload(f.req('hr', f.uploadData(data))), ready = { api, data, out, name: 'hr', ref: f.root.collection('hr_attachments').doc(reserved.attachment_id) };
      const saved = await assertPublication(f, 'document', p, ready);
      assert.deepEqual((await v1.get()).data(), oldVersion); assert.deepEqual((await receipt.get()).data(), oldAck);
      const v2 = (await ref.collection('revisions').doc('2').get()).data();
      for (const key of ['title', 'text', 'requires_ack']) assert.equal(v2[key], oldVersion[key]);
      assert.equal((await parent.get(f.req('owner', { document_id: p.document_id }))).receipt, null);
      assert.equal((await api.list(f.req('owner', { parent_kind: 'document', parent_id: p.document_id, revision: 1 }))).items.length, 0);
      await denied(() => api.download(f.req('owner', { attachment_id: saved.attachment_id, revision: 1 })), 'permission-denied');
      const download = await api.download(f.req('owner', { attachment_id: saved.attachment_id, revision: 2 })); assert.equal(download.content_base64, PDF.toString('base64'));
      const jobsBeforeReceipts = (await f.jobs('document').get()).size;
      await denied(() => parent.acknowledge(f.req('owner', { request_id: 'ack-new-before-open', document_id: p.document_id, revision: 2 })), 'failed-precondition');
      await parent.markOpened(f.req('owner', { request_id: 'open-new-revision', document_id: p.document_id, revision: 2 }));
      await parent.acknowledge(f.req('owner', { request_id: 'ack-new-revision', document_id: p.document_id, revision: 2 }));
      assert.equal((await f.jobs('document').get()).size, jobsBeforeReceipts, 'opened/ack do not queue notifications');
      await parent.revise(f.req('hr', { request_id: 'text-revision-three', document_id: p.document_id, expected_revision: 2,
        title: 'PRIVATE_NEW_TITLE', text: 'PRIVATE_NEW_TEXT', requires_ack: true, send_now: false }));
      assert.deepEqual((await ref.collection('revisions').doc('3').get()).data().attachment_ids, [saved.attachment_id]);
      assert.equal((await api.download(f.req('owner', { attachment_id: saved.attachment_id, revision: 3 }))).content_base64, PDF.toString('base64'));
      const historical = await api.list(f.req('owner', { parent_kind: 'document', parent_id: p.document_id, revision: 3 }));
      assert.deepEqual(historical.items.map(i => i.attachment_id), [saved.attachment_id]); assert.equal(historical.next_cursor, null);
      assert.deepEqual((await receipt.get()).data(), oldAck);
    });
    await check('request attachment preserves waiting_employee; closed request permits ready reads/replays but rejects new reservation and upload', async () => {
      const f = await fixture(), p = await f.create('request'), parent = f.parent('request');
      const waiting = await parent.setStatus(f.req('hr', { request_id: 'wait-for-owner', case_id: p.case_id, expected_revision: 1, status: 'waiting_employee', send_now: false }));
      const ready = await f.ready('request', p, 'owner', waiting.revision); await assertPublication(f, 'request', p, ready, 3);
      assert.equal((await f.ref('request', p).get()).data().status, 'waiting_employee');
      const pendingData = f.intent('request', p, 3, 'pending-before-close'); await ready.api.reserve(f.req('owner', pendingData));
      const closed = await parent.setStatus(f.req('hr', { request_id: 'close-with-evidence', case_id: p.case_id, expected_revision: 3, status: 'closed', send_now: false }));
      const before = await f.snapshot('request', p), saveCalls = f.memory.calls.saves;
      for (const invoke of readyCalls(f, 'request', p, ready)) await invoke();
      await denied(() => ready.api.reserve(f.req('owner', f.intent('request', p, closed.revision, 'new-closed-file'))), 'failed-precondition');
      await denied(() => ready.api.upload(f.req('owner', f.uploadData(pendingData))), 'aborted');
      await denied(() => ready.api.download(f.req('owner', { attachment_id: ready.out.attachment_id, revision: 3 })), 'invalid-argument');
      assert.equal(f.memory.calls.saves, saveCalls); assert.deepEqual(await f.snapshot('request', p), before);
    });
    await check('actual owner/HR/signed-super routing is preserved and unrelated actors cannot reserve private parent files', async () => {
      const f = await fixture(), p = await f.create('request'), api = f.api('request');
      for (const name of ['other', 'command']) await denied(() => api.reserve(f.req(name, f.intent('request', p, 1, 'denied-' + name))), 'permission-denied');
      for (const [name, revision] of [['hr', 1], ['super', 2]]) {
        const ready = await f.ready('request', p, name, revision), saved = (await ready.ref.get()).data(), job = (await f.jobs('request').doc(saved.link_event_id).get()).data();
        assert.equal(job.type, 'hr_reply'); assert.equal(job.audience, 'person'); assert.equal(job.recipient_uid, f.people.owner.uid); assert.equal(job.actor_uid, f.people[name].uid);
      }
      assert.equal(f.memory.objects.size, 2);
      const g = await fixture(), d = await g.create('document');
      await denied(() => g.api('document').reserve(g.req('owner', g.intent('document', d, 1))), 'permission-denied');
      assert.equal(g.memory.calls.saves, 0);
    });
    for (const kind of ['request', 'document']) {
      await check(kind + ' lost response after real ready commit replays exact reserve/upload/resume without new writes or save', async () => {
        const f = await fixture(), p = await f.create(kind), name = kind === 'document' ? 'hr' : 'owner', api = f.api(kind), data = f.intent(kind, p, 1);
        const reserved = await api.reserve(f.req(name, data));
        // Loss occurs AFTER the actual product method returns a committed ready
        // result. No domain transaction is replaced by a synthetic receipt.
        await denied(async () => { const out = await api.upload(f.req(name, f.uploadData(data))); assert.equal(out.state, 'ready');
          throw Object.assign(new Error('synthetic lost response after committed result'), { code: 'unavailable' }); }, 'unavailable');
        const ready = { api, data, name, out: reserved, ref: f.root.collection('hr_attachments').doc(reserved.attachment_id) };
        await assertPublication(f, kind, p, ready);
        const before = await f.snapshot(kind, p), calls = f.memory.calls.saves;
        for (const invoke of readyCalls(f, kind, p, ready).slice(0, 3)) { const out = await invoke(); assert.equal(out.state, 'ready'); assert.equal(out.duplicate, true); }
        await denied(() => api.reserve(f.req(name, { ...data, display_name: 'different.pdf' })), 'already-exists');
        await denied(() => api.upload(f.req(name, f.uploadData({ ...data, display_name: 'different.pdf' }))), 'already-exists');
        assert.equal(f.memory.calls.saves, calls); assert.deepEqual(await f.snapshot(kind, p), before);
      });
      await check(kind + ' concurrent identical uploads settle and converge to one durable publication/job/ledger entry', async () => {
        const f = await fixture(), p = await f.create(kind), api = f.api(kind), name = kind === 'document' ? 'hr' : 'owner', data = f.intent(kind, p, 1);
        const before = await f.snapshot(kind, p), reserved = await api.reserve(f.req(name, data));
        const attempts = await Promise.allSettled([api.upload(f.req(name, f.uploadData(data))), api.upload(f.req(name, f.uploadData(data)))]);
        assert.ok(attempts.every(result => result.status === 'fulfilled' || ['aborted', 'failed-precondition'].includes(result.reason?.code)));
        let out = await api.resume(f.req(name, { attachment_id: reserved.attachment_id }));
        if (out.resume === 'upload-required') out = await api.upload(f.req(name, f.uploadData(data)));
        assert.equal(out.state, 'ready');
        const ready = { api, data, name, out, ref: f.root.collection('hr_attachments').doc(out.attachment_id) };
        await assertPublication(f, kind, p, ready);
        const after = await f.snapshot(kind, p);
        assert.equal(after.jobs.length, before.jobs.length + 1); assert.equal(after.children.length, before.children.length + 1);
        assert.equal(after.attachments.length, 1); assert.equal(f.memory.objects.size, 1); assert.equal(f.memory.calls.created, 1);
        assert.deepEqual(after.operations, before.operations, 'attachment does not create a second parent operation receipt');
        const rate = await db.doc('hr_attachment_actor_quotas/' + hash(['hr-attachment-quota-v1', f.people[name].uid])).get();
        assert.equal(rate.data().requests_at_ms.length, 1, 'only one reservation charge');
      });
      await check(kind + ' fresh Auth revocation blocks every ready response; a current authorized login can read without revival', async () => {
        const f = await fixture(), p = await f.create(kind), ready = await f.ready(kind, p), before = await f.snapshot(kind, p), counts = { ...f.memory.calls };
        records.get(f.people[ready.name].uid).tokensValidAfterTime = new Date((AUTH_TIME + 10) * 1000).toUTCString();
        for (const invoke of readyCalls(f, kind, p, ready)) await denied(invoke, 'permission-denied');
        assert.deepEqual(f.memory.calls, counts); assert.deepEqual(await f.snapshot(kind, p), before);
        // Explicit fresh login; original immutable attachment intent remains.
        const refreshed = readyCalls(f, kind, p, ready, { auth_time: AUTH_TIME + 10 });
        for (const invoke of refreshed.slice(0, 3)) assert.equal((await invoke()).state, 'ready');
        assert.deepEqual(await f.snapshot(kind, p), before); assert.equal(f.memory.calls.saves, counts.saves);
      });
      await check(kind + ' former HR with a valid fresh member session cannot replay another employee private ready file', async () => {
        const f = await fixture(), p = await f.create(kind), ready = await f.ready(kind, p, 'hr');
        f.people.hr.claims = { stationId: f.sid, role: 'firefighter' };
        const record = records.get(f.people.hr.uid); record.customClaims = structuredClone(f.people.hr.claims);
        record.tokensValidAfterTime = new Date((AUTH_TIME + 10) * 1000).toUTCString();
        await f.root.collection('users').doc(f.people.hr.uid).update({ role: 'firefighter' });
        // Prove this session passes the actual profile identity gate first;
        // denial must therefore come from actual current parent authorization.
        await db.runTransaction(tx => identity.requireLive(tx, identity.context(f.req('hr', {}, { auth_time: AUTH_TIME + 10 }))));
        const before = await f.snapshot(kind, p), counts = { ...f.memory.calls };
        for (const invoke of readyCalls(f, kind, p, ready, { auth_time: AUTH_TIME + 10 })) await denied(invoke, 'permission-denied');
        assert.deepEqual(await f.snapshot(kind, p), before); assert.deepEqual(f.memory.calls, counts);
      });
      await check(kind + ' queued real job failure rolls back ready and parent; charged stored file resumes once afterward', async () => {
        const f = await fixture(), p = await f.create(kind), normal = f.api(kind), name = kind === 'document' ? 'hr' : 'owner', data = f.intent(kind, p, 1);
        const reserved = await normal.reserve(f.req(name, data)), before = await f.snapshot(kind, p), failing = f.api(kind, { database: jobFailureDatabase(kind) });
        await denied(() => failing.upload(f.req(name, f.uploadData(data))), 'unavailable');
        const pending = await f.snapshot(kind, p);
        for (const key of ['parent', 'children', 'jobs', 'ledgers', 'operations', 'quotas']) assert.deepEqual(pending[key], before[key], 'rollback preserves ' + key);
        assert.equal(pending.attachments[0][1].state, 'stored'); assert.equal(pending.attachments[0][1].published_revision, null);
        assert.equal(f.memory.objects.size, 1, 'a stored object is not falsely claimed to roll back with Firestore');
        const saves = f.memory.calls.saves, out = await normal.resume(f.req(name, { attachment_id: reserved.attachment_id }));
        await assertPublication(f, kind, p, { api: normal, data, name, out, ref: f.root.collection('hr_attachments').doc(out.attachment_id) });
        assert.equal(f.memory.calls.saves, saves, 'resume adopts verified bytes rather than saving again');
      });
    }
    await check('injected immutable-parent ACL fault between byte read and final parent check denies document download', async () => {
      const f = await fixture(), p = await f.create('document'), ready = await f.ready('document', p);
      // Fault injection only: changing target_uid is not a supported document-transfer workflow.
      f.memory.beforeReadReturn = () => f.ref('document', p).update({ target_uid: f.people.other.uid });
      await denied(() => ready.api.download(f.req('owner', { attachment_id: ready.out.attachment_id, revision: 2 })), 'permission-denied');
      assert.equal(f.memory.calls.reads, 1); assert.equal((await ready.ref.get()).data().state, 'ready');
      assert.equal((await f.ref('document', p).get()).data().current_revision, 2);
    });
    await check('final Auth recheck and pre-publication profile revocation block ready publication after storage', async () => {
      for (const mode of ['actor-auth', 'actor-profile', 'target-profile']) {
        const f = await fixture(), p = await f.create('document'), data = f.intent('document', p, 1), normal = f.api('document');
        const reserved = await normal.reserve(f.req('hr', data)), before = await f.snapshot('document', p);
        const api = f.api('document', { hooks: { async beforeWrites({ stage }) {
          // markStored has read only the attachment, not either profile. These
          // profile writes precede the profile-reading publication transaction;
          // only the synchronous Auth mutation proves the final recheck race.
          if (stage !== (mode === 'actor-auth' ? 'finalize' : 'markStored')) return;
          if (mode === 'actor-auth') records.get(f.people.hr.uid).disabled = true;
          else await f.root.collection('users').doc(f.people[mode === 'actor-profile' ? 'hr' : 'owner'].uid).update({ active: false, is_active: false });
        } } });
        await denied(() => api.upload(f.req('hr', f.uploadData(data))), 'permission-denied');
        const after = await f.snapshot('document', p);
        for (const key of ['parent', 'children', 'jobs', 'ledgers', 'operations', 'quotas']) assert.deepEqual(after[key], before[key]);
        assert.equal((await f.root.collection('hr_attachments').doc(reserved.attachment_id).get()).data().state, 'stored');
        assert.equal(f.memory.objects.size, 1);
      }
    });
    console.log('HR attachments + actual parents: ' + passed + '/' + passed + ' PASS; actual Firestore/service/assembly/session/parents, strict memory Storage and synthetic Auth only.');
    console.log('NOT PROVED: GCS/Storage-emulator generation invariants, production Auth/callable/AppCheck, UI, FCM, malware scanning. Storage invariant BLOCK remains separate.');
  } finally {
    await cleanup();
    if (priorRuntime) { const after = await runtime.get(); assert.equal(after.exists, priorRuntime.exists); if (after.exists) assert.deepEqual(after.data(), priorRuntime.data()); }
    assert.deepEqual(sourceHashes(), frozenSources, 'product sources unchanged');
    console.log(JSON.stringify({ run, cleaned_station_roots: cleanedRoots, cleaned_quota_refs: cleanedQuotas, exact_cleanup_verified: true,
      runtime_untouched: true, source_hashes_unchanged: true, storage_emulator_invariant: 'BLOCKED-separate-gate' }));
    await app.delete();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
