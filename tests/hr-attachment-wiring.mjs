import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// This is a registration/policy gate, not an Auth, App Check, Firestore,
// Storage or deployed-callable integration test. The actual bounded index
// source runs with explicit SDK/service doubles; only the pure policy is loaded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['functions/index.js', 'firestore.rules', 'firestore.indexes.json',
  'functions/backup-policy.js', 'functions/hr-attachment-service.js',
  'functions/hr-attachments.js', 'functions/hr-attachments-storage.js',
  'functions/hr-requests.js', 'functions/hr-documents.js', 'functions/ops-member-identity.js'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const hashes = () => Object.fromEntries(files.map(file => [file,
  createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const before = hashes();
console.log('SOURCE_BEFORE ' + JSON.stringify(before));
const mapping = Object.freeze({ reserveHrAttachment: 'reserve', uploadHrAttachment: 'upload',
  resumeHrAttachment: 'resume', listHrAttachments: 'list', downloadHrAttachment: 'download' });
const expectedOptions = Object.freeze({ enforceAppCheck: true, region: 'europe-west1',
  timeoutSeconds: 120, memory: '512MiB', concurrency: 1, maxInstances: 3,
  serviceAccount: 'resq-hr-attachments@station-102.iam.gserviceaccount.com' });
const expectedBucket = 'station-102-hr-private-europe-west1';
const index = read('functions/index.js');
const imports = [
  ...index.matchAll(/^const hrAttachmentServiceModule = require\((['"])\.\/hr-attachment-service\1\);\s*$/gm),
  ...index.matchAll(/^const hrAttachmentsStorageModule = require\((['"])\.\/hr-attachments-storage\1\);\s*$/gm)
];
assert.equal(imports.length, 2, 'exactly the two actual attachment imports');
const start = index.indexOf('const HR_PRIVATE_BUCKET = ');
const end = index.indexOf('\nconst hrHoursNudges = ', start);
assert.ok(start >= 0 && end > start, 'bounded attachment registration anchors exist');
const source = imports.map(match => match[0]).join('\n') + '\n' + index.slice(start, end);
let passed = 0;
async function check(label, run) { await run(); ++passed; console.log('PASS ' + label); }

function harness({ failAt = null } = {}) {
  const counts = { storage: 0, bucket: 0, adapter: 0, auth: 0, service: 0 };
  const required = [], registered = [], calls = [], adapterDeps = [], serviceDeps = [], buckets = [];
  const exports = {};
  const db = Object.freeze({ synthetic: 'db' }), auth = Object.freeze({ synthetic: 'live-auth-provider' });
  const requests = Object.freeze({ synthetic: 'actual-existing-requests-service-reference' });
  const documents = Object.freeze({ synthetic: 'actual-existing-documents-service-reference' });
  const bucket = Object.freeze({ file() { throw new Error('registration must not start object I/O'); } });
  const adapter = Object.freeze({ synthetic: 'private-storage-adapter-reference' });
  const result = Object.freeze({ synthetic: 'unchanged-service-result' });
  class HttpsError extends Error {}
  const initializationError = new Error('synthetic initialization failure');
  let failure = null, failed = false;
  const hit = stage => {
    ++counts[stage];
    if (!failed && failAt === stage) { failed = true; throw initializationError; }
  };
  const service = Object.freeze(Object.fromEntries([
    ...Object.values(mapping).map(method => [method, request => {
      calls.push({ method, request });
      return failure ? Promise.reject(failure) : Promise.resolve(result);
    }]),
    ['reconcile', () => { throw new Error('reconcile must never become a public handler'); }]
  ]));
  vm.runInNewContext(source, {
    exports, db, HttpsError, hrRequests: requests, hrDocuments: documents,
    require(name) {
      required.push(name);
      if (name === './hr-attachment-service') return { createHrAttachmentService(deps) {
        hit('service'); serviceDeps.push(deps); return service;
      } };
      if (name === './hr-attachments-storage') return { createHrAttachmentsStorage(deps) {
        hit('adapter'); adapterDeps.push(deps); return adapter;
      } };
      throw new Error('unexpected module require: ' + name);
    },
    admin: {
      auth() { hit('auth'); return auth; },
      storage(...args) {
        hit('storage'); assert.equal(args.length, 0);
        return { bucket(...names) { hit('bucket'); buckets.push(names); return bucket; } };
      }
    },
    onCall(options, handler) { registered.push({ options, handler }); return handler; }
  }, { filename: 'actual-hr-attachment-registration.js', timeout: 1000 });
  return { counts, required, registered, calls, adapterDeps, serviceDeps, buckets, exports,
    db, auth, requests, documents, bucket, adapter, result, HttpsError, initializationError,
    setFailure(value) { failure = value; } };
}

await check('whole index has exactly five attachment exports and one lazy construction site', () => {
  const actual = [...index.matchAll(/exports\.([A-Za-z0-9_]*Attachment[A-Za-z0-9_]*)\s*=/g)].map(match => match[1]);
  assert.deepEqual(actual.sort(), Object.keys(mapping).sort());
  for (const name of Object.keys(mapping)) {
    assert.equal((index.match(new RegExp('exports\\.' + name + '\\s*=', 'g')) || []).length, 1);
  }
  for (const token of ['hrAttachmentServiceModule.createHrAttachmentService(',
    'hrAttachmentsStorageModule.createHrAttachmentsStorage(', 'const HR_PRIVATE_BUCKET = ',
    'function getHrAttachmentService()']) assert.equal(index.split(token).length - 1, 1, token);
  assert.equal((index.match(/getHrAttachmentService\(\)/g) || []).length, 6,
    'one declaration plus exactly five handler calls, no eager invocation');
  assert.doesNotMatch(source, /\breconcile\b|onSchedule|setInterval|setTimeout/);
});

const fixture = harness();
await check('module discovery registers handlers without attachment Auth, Storage or service construction', () => {
  assert.deepEqual(fixture.required, ['./hr-attachment-service', './hr-attachments-storage']);
  assert.deepEqual(fixture.counts, { storage: 0, bucket: 0, adapter: 0, auth: 0, service: 0 });
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(Object.keys(fixture.exports).sort(), Object.keys(mapping).sort());
});
await check('all five callables retain the exact reviewed App Check and per-function resource options', () => {
  assert.equal(fixture.registered.length, 5);
  for (const { options, handler } of fixture.registered) {
    assert.deepEqual({ ...options }, expectedOptions);
    assert.equal(typeof handler, 'function');
  }
  assert.equal(new Set(fixture.registered.map(entry => entry.options)).size, 5);
});
await check('simultaneous first calls share one lazily assembled service and server-only bucket', async () => {
  const requests = Object.keys(mapping).map((name, i) => Object.freeze({
    auth: Object.freeze({ uid: 'synthetic-' + i, token: Object.freeze({ stationId: 'test-' + i }) }),
    app: Object.freeze({ appId: 'synthetic-app' }),
    data: Object.freeze({ request_id: 'synthetic-' + name, bucket: 'must-not-select-this-bucket',
      path: 'must-not-select-this-object', base64: 'synthetic-private-bytes' })
  }));
  const values = await Promise.all(Object.keys(mapping).map((name, i) => fixture.exports[name](requests[i])));
  assert.ok(values.every(value => value === fixture.result));
  assert.deepEqual(fixture.counts, { storage: 1, bucket: 1, adapter: 1, auth: 1, service: 1 });
  assert.deepEqual(fixture.buckets, [[expectedBucket]]);
  assert.equal(fixture.adapterDeps.length, 1);
  assert.deepEqual(Object.keys(fixture.adapterDeps[0]), ['bucket']);
  assert.equal(fixture.adapterDeps[0].bucket, fixture.bucket);
  assert.equal(fixture.serviceDeps.length, 1);
  const deps = fixture.serviceDeps[0];
  assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'auth', 'db', 'documents', 'requests', 'storage']);
  for (const key of ['db', 'auth', 'requests', 'documents', 'HttpsError']) assert.equal(deps[key], fixture[key], key);
  assert.equal(deps.storage, fixture.adapter);
  for (let i = 0; i < requests.length; ++i) {
    assert.equal(fixture.calls[i].request, requests[i]);
    assert.equal(fixture.calls[i].method, Object.values(mapping)[i]);
  }
});
for (const [name, method] of Object.entries(mapping)) {
  await check(name + ' forwards each new original request to ' + method + ' without identity caching', async () => {
    const request = Object.freeze({ auth: Object.freeze({ uid: 'different-live-owner-' + method }),
      data: Object.freeze({ request_id: 'different-request-' + method }) });
    const count = fixture.calls.length;
    assert.equal(await fixture.exports[name](request), fixture.result);
    assert.equal(fixture.calls.length, count + 1);
    assert.equal(fixture.calls.at(-1).method, method);
    assert.equal(fixture.calls.at(-1).request, request);
    assert.equal(fixture.counts.service, 1);
  });
}
await check('all five handlers preserve service rejections without retrying a business operation', async () => {
  const failure = new fixture.HttpsError('synthetic private service error');
  fixture.setFailure(failure);
  for (const [name, method] of Object.entries(mapping)) {
    const request = Object.freeze({ data: Object.freeze({ request_id: 'uncertain-' + method }) });
    const count = fixture.calls.length;
    await assert.rejects(() => fixture.exports[name](request), error => error === failure);
    assert.equal(fixture.calls.length, count + 1);
    assert.equal(fixture.calls.at(-1).request, request);
    assert.equal(fixture.calls.at(-1).method, method);
  }
  assert.equal(fixture.counts.service, 1);
  fixture.setFailure(null);
});
for (const stage of ['storage', 'bucket', 'adapter', 'auth', 'service']) {
  await check(stage + ' initialization failure does not poison the lazy cache or invoke a service operation', async () => {
    const f = harness({ failAt: stage });
    const request = Object.freeze({ data: Object.freeze({ request_id: 'retry-initialization-' + stage }) });
    await assert.rejects(() => f.exports.reserveHrAttachment(request), error => error === f.initializationError);
    assert.equal(f.calls.length, 0);
    assert.equal(await f.exports.resumeHrAttachment(request), f.result);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'resume');
    assert.equal(f.calls[0].request, request); assert.equal(f.counts[stage], 2);
    const counts = { ...f.counts };
    assert.equal(await f.exports.listHrAttachments(request), f.result);
    assert.deepEqual(f.counts, counts, 'successful construction remains cached');
    assert.ok(f.buckets.every(names => names.length === 1 && names[0] === expectedBucket));
  });
}

const policy = createRequire(import.meta.url)(path.join(root, 'functions/backup-policy.js'));
const policyPaths = ['stations/{sid}/hr_attachments/{attachmentId}',
  'stations/{sid}/hr_attachment_ledgers/{ledgerId}', 'hr_attachment_actor_quotas/{quotaId}'];
await check('exact three attachment paths remain private metadata with no automatic retention permission', () => {
  const actual = policy.DATA_POLICIES.filter(item => item.path.split('/').some(segment =>
    ['hr_attachments', 'hr_attachment_ledgers', 'hr_attachment_actor_quotas'].includes(segment)));
  assert.deepEqual(actual.map(item => item.path).sort(), [...policyPaths].sort());
  assert.deepEqual(policy.validatePolicies(actual), []);
  const indexes = JSON.parse(read('firestore.indexes.json'));
  for (const item of actual) {
    assert.equal(item.scope, item.path.startsWith('stations/') ? 'station' : 'root');
    assert.equal(item.sensitivity, 'restricted_identity');
    assert.equal(item.humanReadable, 'forbidden');
    assert.equal(item.retention, 'policy_required_before_wiring');
    assert.equal(indexes.fieldOverrides.some(entry => entry.collectionGroup === item.path.split('/').at(-2)
      && entry.ttl === true), false, item.path + ' cannot acquire a TTL');
  }
});
await check('attachment and uncertainty ledgers are durable, with specialized restore explicitly unresolved', () => {
  for (const key of policyPaths.slice(0, 2)) {
    const item = policy.getPolicy(key);
    assert.deepEqual([item.classification, item.monitorPolicy, item.backupPolicy, item.restorePolicy],
      ['source_of_truth', 'count_drop', 'managed_export', 'specialized_restore']);
    assert.match(item.reason, /parent\/revision\/object-generation\/ledger restore.*unresolved/i);
    assert.match(item.reason, /no export, restore or deletion activated/i);
  }
  const ledger = policy.getPolicy(policyPaths[1]);
  assert.match(ledger.reason, /uncertain writes/i);
  assert.match(ledger.reason, /not rebuildable from ready files or disposable on expiry/i);
  const quota = policy.getPolicy(policyPaths[2]);
  assert.deepEqual([quota.classification, quota.monitorPolicy, quota.backupPolicy, quota.restorePolicy],
    ['temporary', 'none', 'exclude', 'do_not_restore']);
  assert.match(quota.reason, /exclusion activates no deletion/i);
});
await check('all three policy entries reject both readable and redacted identity-export mutations', () => {
  for (const key of policyPaths) for (const humanReadable of ['allowed', 'redacted']) {
    assert.ok(policy.validatePolicies([{ ...policy.getPolicy(key), humanReadable }]).some(error =>
      error.includes('identity data must be forbidden')), key + '/' + humanReadable);
  }
});
await check('source contains explicit deny-all matches for all three paths (not a rules-emulator proof)', () => {
  const rules = read('firestore.rules');
  for (const [collection, parameter] of [['hr_attachments', 'attachmentId'],
    ['hr_attachment_ledgers', 'ledgerId'], ['hr_attachment_actor_quotas', 'quotaId']]) {
    const matches = [...rules.matchAll(new RegExp('match /' + collection + '/\\{' + parameter +
      '\\}\\s*\\{\\s*allow read, write: if false;\\s*\\}', 'g'))];
    assert.equal(matches.length, 1, collection);
  }
});
await check('all inspected whole product files remain unchanged', () => assert.deepEqual(hashes(), before));
console.log('SOURCE_AFTER ' + JSON.stringify(hashes()));
console.log('HR attachment wiring: ' + passed + '/' + passed + ' passed; actual registration source with explicit doubles.');
console.log('NOT RUN: actual SDK/Auth/App Check/Firestore/Storage, infrastructure/IAM, deployment, browser or provider generation guarantees.');
