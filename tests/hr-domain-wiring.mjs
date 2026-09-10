import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const pins = {
  'functions/hr-domain-dispatch.js': '0a23ea04eb41398ba3a45c7e6ff9559b8e0054c4e2373f0fdb7eef1ecf45f89f',
  'functions/hr-requests.js': '16abae222216908cc8090ec1cfe8904920e8bdc75c5bf11b103d11dabccdfe2d',
  'functions/hr-documents.js': '14640985ff4de88377fbdbd8b12af5325fd78ba699cd8a1eb0f2a9679af84a0e',
  'functions/hr-notification-policy.js': 'd2b161037aa3045f29f0cd70bba02eb08bdb3b578c90d75c2ec91b3345312222',
  'functions/hr-hours-dispatch.js': 'e071a6fce6e398522198f5c0aa75afd61000a138ebaeb416c02b2e21e27bd462',
  'functions/hr-hours-nudges.js': 'fd572de3dae6563bb8f63dd2e7a7baf8699598ad80dcafc47d244f89029724d7'
};
const files = ['functions/index.js', 'firestore.indexes.json', 'firestore.rules', 'functions/backup-policy.js',
  'incident-client.js', 'functions/ops-telemetry-contract.js', ...Object.keys(pins)];
const hashes = () => Object.fromEntries(files.map(file => [file, sha(read(file))]));
const before = hashes(), index = read('functions/index.js');
let passed = 0;
async function check(label, run) { await run(); ++passed; console.log('PASS ' + label); }
function unique(regex, label) {
  const matches = [...index.matchAll(regex)]; assert.equal(matches.length, 1, label); return matches[0][0];
}
const moduleImport = unique(/^const hrDomainDispatchModule = require\((['"])\.\/hr-domain-dispatch\1\);\s*$/gm, 'one domain module import');
const schedulerImport = unique(/^const \{ onSchedule \} = require\((['"])firebase-functions\/v2\/scheduler\1\);\s*$/gm, 'one existing scheduler import');
const registration = unique(/const hrDomainDispatch = hrDomainDispatchModule\.createHrDomainDispatch\([\s\S]*?exports\.resumeHrDomainNotifications = onSchedule\([\s\S]*?hrDomainDispatch\.run\(\)\);/g, 'one bounded actual domain registration');
assert.ok(index.indexOf(schedulerImport) < index.indexOf(registration), 'register after the actual scheduler import');
assert.equal((index.match(/\.createHrDomainDispatch\(/g) || []).length, 1, 'factory initialized only once');
assert.equal((index.match(/exports\.resumeHrDomainNotifications\s*=/g) || []).length, 1, 'scheduled export never overwritten');

const db = Object.freeze({ fixture: 'db' }), auth = Object.freeze({ fixture: 'auth' }), messaging = Object.freeze({ fixture: 'messaging' });
class HttpsError extends Error {}
const exports = {}, factories = [], schedules = [], required = [];
let authCalls = 0, messagingCalls = 0, workerCalls = 0;
const result = Object.freeze({ fixture: 'unchanged-worker-result' });
let worker = () => Promise.resolve(result);
const ports = {
  './hr-domain-dispatch': { createHrDomainDispatch(deps) {
    factories.push(deps); return { run() { ++workerCalls; return worker(); },
      processJob() { throw new Error('Registration must not progress any job directly'); } };
  } },
  'firebase-functions/v2/scheduler': { onSchedule(options, handler) { schedules.push({ options, handler }); return handler; } }
};
// The actual source snippets execute, but require/Auth/messaging end at
// synthetic ports. This is composition evidence, not SDK or delivery proof.
vm.runInNewContext([moduleImport, schedulerImport, registration].join('\n'), {
  exports, db, HttpsError,
  require(name) { required.push(name); assert.ok(Object.hasOwn(ports, name), name); return ports[name]; },
  admin: { auth() { ++authCalls; return auth; }, messaging() { ++messagingCalls; return messaging; } }
}, { filename: 'actual-hr-domain-registration.js', timeout: 1000 });

await check('one factory gets exact db, live Auth, messaging and HttpsError with no hooks or clock', () => {
  assert.deepEqual(required, ['./hr-domain-dispatch', 'firebase-functions/v2/scheduler']);
  assert.equal(authCalls, 1); assert.equal(messagingCalls, 1); assert.equal(factories.length, 1);
  const deps = factories[0]; assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'auth', 'db', 'messaging']);
  assert.equal(deps.db, db); assert.equal(deps.auth, auth); assert.equal(deps.messaging, messaging); assert.equal(deps.HttpsError, HttpsError);
  assert.equal(workerCalls, 0, 'registration sends nothing');
});
await check('only the one scheduled export is registered, with all approved resource and retry limits', () => {
  assert.deepEqual(Object.keys(exports), ['resumeHrDomainNotifications']); assert.equal(schedules.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(schedules[0].options)), { schedule: '* * * * *', region: 'europe-west1',
    timeoutSeconds: 540, maxInstances: 1, concurrency: 1, retryCount: 0 });
});
await check('scheduled handler awaits one run and returns its original completion', async () => {
  let release, settled = false; worker = () => new Promise(resolve => { release = resolve; });
  const n = workerCalls, pending = exports.resumeHrDomainNotifications({}).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(workerCalls, n + 1); assert.equal(settled, false);
  release(result); assert.equal(await pending, result);
});
await check('scheduled rejection is not swallowed, retried or converted to success', async () => {
  const failure = new Error('synthetic worker failure'), n = workerCalls; worker = () => Promise.reject(failure);
  await assert.rejects(() => exports.resumeHrDomainNotifications({}), error => error === failure); assert.equal(workerCalls, n + 1);
});

const config = JSON.parse(read('firestore.indexes.json'));
const jobGroups = ['hr_request_notification_jobs', 'hr_document_notification_jobs', 'hr_hours_review_notification_jobs', 'attendance_correction_notification_jobs'];
const intentGroup = 'hr_domain_notification_intents';
const domainGroups = [...jobGroups,intentGroup];
const pairs = jobGroups.flatMap(group => ['created_at_ms', 'expires_at_ms', 'not_before_ms', 'updated_at_ms'].map(field => [group, field]))
  .concat(['expires_at_ms', 'lease_until_ms', 'not_before_ms', 'next_check_ms', 'created_at_ms'].map(field => [intentGroup, field]));
const expectedIndexes = pairs.map(([collectionGroup, fieldPath]) => ({ collectionGroup, queryScope: 'COLLECTION_GROUP',
  fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath, order: 'ASCENDING' }] }));
const ordered = indexes => indexes.map(value => JSON.stringify(value)).sort();
function validateIndexes(value) {
  assert.deepEqual(Object.keys(value).sort(), ['fieldOverrides', 'indexes']); assert.equal(value.indexes.length, 42);
  assert.deepEqual(ordered(value.indexes.filter(i => domainGroups.includes(i.collectionGroup))), ordered(expectedIndexes));
  const old = value.indexes.filter(i => !domainGroups.includes(i.collectionGroup));
  assert.equal(old.length, 21); assert.equal(value.fieldOverrides.length, 32);
  // Canonical full pre-domain aee9832 snapshot: all eight hours +13 legacy,
  // and all field overrides. No Git dependency or arbitrary-group exclusion.
  assert.equal(sha(JSON.stringify(old)), 'b09f65a0d72538129360363c51dbc79ef702289c22b310753d9175171dbe713c');
  assert.equal(sha(JSON.stringify(value.fieldOverrides)), '41571b75f7605882500137b420a1664964d2efd0cee6f3a6ef885c44399c9939');
}
await check('exact21 domain query indexes append without changing21 existing indexes or32 overrides', () => validateIndexes(config));
await check('in-memory omitted, changed-scope and additional indexes fail the closed gate', () => {
  for (const mutate of [value => value.indexes.splice(value.indexes.findIndex(i => domainGroups.includes(i.collectionGroup)), 1),
    value => { value.indexes.find(i => domainGroups.includes(i.collectionGroup)).queryScope = 'COLLECTION'; },
    value => value.indexes.push({ collectionGroup: 'unapproved', queryScope: 'COLLECTION_GROUP', fields: [] })]) {
    const bad = structuredClone(config); mutate(bad); assert.throws(() => validateIndexes(bad));
  }
});
await check('reviewed dispatcher, both producers, policy and existing hours modules remain exact', () => {
  for (const [file, digest] of Object.entries(pins)) assert.equal(sha(read(file)), digest, file);
});
await check('existing automatic hours/report/mail producers retain their baseline bodies', () => {
  const blocks = index.split(/(?=^exports\.)/m);
  const old = { hoursReminder: '003f88d5a96aec52264411971761a18fa989da146b4f3a0f8d7bc2f77bc326d4',
    onReportChange: 'cc1236a2d6c884db0069174da4b5af139350b83017842ea0aae031637f4ce811' };
  for (const [name, digest] of Object.entries(old)) {
    const block = blocks.find(value => value.startsWith('exports.' + name + ' =')); assert.ok(block, name);
    const boundary = block.lastIndexOf('\n// ----------');
    assert.equal(sha(block.slice(0, boundary >= 0 ? boundary : block.length).trim()), digest, name);
  }
});
const client = await import('data:text/javascript;base64,' + Buffer.from(read('incident-client.js')).toString('base64'));
const server = createRequire(import.meta.url)(path.join(root, 'functions/ops-telemetry-contract.js'));
await check('scheduler is not a new client callable or private telemetry vocabulary route', () => {
  assert.equal(client.TELEMETRY_CALLABLES.includes('resumeHrDomainNotifications'), false);
  assert.equal(server.CALLABLES.includes('resumeHrDomainNotifications'), false);
  assert.deepEqual([...client.TELEMETRY_CALLABLES].sort(), [...server.CALLABLES].sort());
  const marker = 'synthetic-private-domain-content';
  const report = client.buildReport('callable-failed', { code: 'functions/unavailable', message: marker }, {
    callable: 'resumeHrDomainNotifications', href: '/hr.html?job=' + marker, version: 'unknown', text: marker, token: marker });
  assert.deepEqual(Object.keys(report).sort(), ['callable', 'code', 'kind', 'screen', 'version']);
  assert.equal(report.callable, 'unknown'); assert.equal(JSON.stringify(report).includes(marker), false);
  assert.deepEqual(server.normalizeTelemetry({ ...report, text: marker, token: marker, recipient_uid: marker }), report);
});
await check('all inspected sources are unchanged during the source gate', () => assert.deepEqual(hashes(), before));
console.log('HR domain wiring: ' + passed + '/' + passed + ' passed; actual source with synthetic ports, no SDK, network or emulator calls.');
