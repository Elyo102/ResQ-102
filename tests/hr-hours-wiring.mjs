import assert from 'node:assert/strict';
import './hr-legacy-mail-retirement.mjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['functions/index.js', 'firestore.indexes.json', 'incident-client.js', 'functions/ops-telemetry-contract.js',
  'functions/hr-hours-nudges.js', 'functions/hr-hours-dispatch.js'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const sha = text => createHash('sha256').update(text).digest('hex');
const hashes = () => Object.fromEntries(files.map(file => [file, sha(read(file))]));
const before = hashes(), index = read('functions/index.js');
const mapping = { requestHrHoursNudge: 'request', getHrHoursNudgeStatus: 'get', listHrHoursNudges: 'list' };
const moduleMap = { hrHoursNudgesModule: './hr-hours-nudges', hrHoursNudgeStatusModule: './hr-hours-nudge-status',
  hrHoursDispatchModule: './hr-hours-dispatch' };
let passed = 0;
async function check(name, run) { await run(); ++passed; console.log('PASS ' + name); }
function unique(regex, label) { const matches = [...index.matchAll(regex)]; assert.equal(matches.length, 1, label); return matches[0][0]; }
const imports = Object.entries(moduleMap).map(([variable, file]) => unique(
  new RegExp('^const ' + variable + ' = require\\(([\'\"])' + file.replaceAll('.', '\\.') + '\\1\\);\\s*$', 'gm'), 'one ' + variable));
const registration = unique(/const hrHoursNudges = hrHoursNudgesModule\.createHrHoursNudges\([\s\S]*?exports\.listHrHoursNudges = [^\n]+;/g, 'one actual three-callable registration block');
const scheduleImport = unique(/^const \{ onSchedule \} = require\((['"])firebase-functions\/v2\/scheduler\1\);\s*$/gm, 'one actual scheduler import');
const scheduled = unique(/const hrHoursDispatch = hrHoursDispatchModule\.createHrHoursDispatch\([\s\S]*?exports\.resumeHrHoursNudges = onSchedule\([\s\S]*?hrHoursDispatch\.run\(\)\);/g, 'one actual dispatcher registration');
assert.ok(index.indexOf(scheduleImport) < index.indexOf(scheduled), 'scheduler registered after actual onSchedule import');
for (const name of [...Object.keys(mapping), 'resumeHrHoursNudges']) assert.equal((index.match(new RegExp('exports\\.' + name + '\\s*=', 'g')) || []).length, 1, name + ' not overwritten');
for (const factory of ['createHrHoursNudges', 'createHrHoursNudgeStatus', 'createHrHoursDispatch']) assert.equal((index.match(new RegExp('\\.' + factory + '\\(', 'g')) || []).length, 1, factory + ' initialized once');

const db = Object.freeze({ fixture: 'db' }), auth = Object.freeze({ fixture: 'auth' }), messaging = Object.freeze({ fixture: 'messaging' });
class HttpsError extends Error {}
const exports = {}, factories = [], calls = [], registrations = [], schedules = [], required = [];
const result = Object.freeze({ fixture: 'original-result' });
let authCalls = 0, messagingCalls = 0, failure = null, workerCalls = 0, worker = () => Promise.resolve(result);
const methods = Object.fromEntries(Object.values(mapping).map(method => [method, req => {
  calls.push({ method, req }); return failure ? Promise.reject(failure) : Promise.resolve(result);
}]));
const processJob = () => { throw new Error('Worker must not execute generation during registration'); };
const modules = {
  './hr-hours-nudges': { createHrHoursNudges(deps) { factories.push({ name: 'nudges', deps }); return { request: methods.request, processJob }; } },
  './hr-hours-nudge-status': { createHrHoursNudgeStatus(deps) { factories.push({ name: 'status', deps }); return { get: methods.get, list: methods.list }; } },
  './hr-hours-dispatch': { createHrHoursDispatch(deps) { factories.push({ name: 'dispatch', deps }); return { run() { ++workerCalls; return worker(); } }; } }
};
const onSchedule = (options, handler) => { schedules.push({ options, handler }); return handler; };
// Only real registration snippets run; imports terminate at synthetic ports.
vm.runInNewContext([...imports, registration, scheduleImport, scheduled].join('\n'), {
  db, HttpsError, exports,
  admin: { auth() { ++authCalls; return auth; }, messaging() { ++messagingCalls; return messaging; } },
  require(name) { required.push(name); if (name === 'firebase-functions/v2/scheduler') return { onSchedule };
    assert.ok(Object.hasOwn(modules, name), 'unexpected require: ' + name); return modules[name]; },
  onCall(options, handler) { registrations.push({ options, handler }); return handler; }
}, { filename: 'actual-hr-hours-registration.js', timeout: 1000 });

await check('one producer/status factory and exact dependency identities with no hooks or injected clock', () => {
  assert.deepEqual(required, [...Object.values(moduleMap), 'firebase-functions/v2/scheduler']);
  assert.equal(authCalls, 3); assert.equal(messagingCalls, 1); assert.equal(factories.length, 3);
  for (const { name, deps } of factories.filter(f => f.name !== 'dispatch')) {
    assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'auth', 'db'], name);
    assert.equal(deps.db, db); assert.equal(deps.auth, auth); assert.equal(deps.HttpsError, HttpsError);
  }
  assert.equal(workerCalls, 0, 'registration does not dispatch notifications');
});
await check('three exact callables enforce App Check', () => {
  assert.deepEqual(Object.keys(exports).sort(), [...Object.keys(mapping), 'resumeHrHoursNudges'].sort());
  assert.equal(registrations.length, 3);
  for (const { options } of registrations) { assert.deepEqual(Object.keys(options), ['enforceAppCheck']); assert.equal(options.enforceAppCheck, true); }
});
for (const [name, method] of Object.entries(mapping)) await check(name + ' preserves original request and service result', async () => {
  const req = Object.freeze({ auth: Object.freeze({ uid: 'synthetic-owner', token: Object.freeze({ stationId: 'synthetic_station', role: 'hr_coordinator', auth_time: 1000 }) }),
    app: Object.freeze({ appId: 'synthetic-app-check' }), data: Object.freeze({ month: '2026-09', action_id: 'a'.repeat(64) }) });
  const n = calls.length; assert.equal(await exports[name](req), result); assert.equal(calls.length, n + 1);
  assert.equal(calls.at(-1).method, method); assert.equal(calls.at(-1).req, req);
});
await check('all three wrappers propagate the exact service rejection', async () => {
  failure = new HttpsError('synthetic rejected operation');
  for (const name of Object.keys(mapping)) await assert.rejects(() => exports[name]({}), e => e === failure);
  failure = null;
});
await check('dispatcher gets actual processJob and exact db/Auth/messaging/error dependencies', () => {
  const deps = factories.find(f => f.name === 'dispatch').deps;
  assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'auth', 'db', 'messaging', 'processJob']);
  assert.equal(deps.db, db); assert.equal(deps.auth, auth); assert.equal(deps.messaging, messaging);
  assert.equal(deps.HttpsError, HttpsError); assert.equal(deps.processJob, processJob);
});
await check('scheduler pins minute cadence, bounded540s and one invocation with no scheduler retry', () => {
  assert.equal(schedules.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(schedules[0].options)), { schedule: '* * * * *', region: 'europe-west1',
    timeoutSeconds: 540, maxInstances: 1, concurrency: 1, retryCount: 0 });
});
await check('scheduled handler awaits one worker completion and returns its original result', async () => {
  let release, settled = false; worker = () => new Promise(resolve => { release = resolve; });
  const n = workerCalls, pending = exports.resumeHrHoursNudges({}).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(workerCalls, n + 1); assert.equal(settled, false);
  release(result); assert.equal(await pending, result);
});
await check('scheduled handler preserves worker rejection instead of swallowing or restarting', async () => {
  const failure = new Error('synthetic dispatch failure'), n = workerCalls; worker = () => Promise.reject(failure);
  await assert.rejects(() => exports.resumeHrHoursNudges({}), e => e === failure); assert.equal(workerCalls, n + 1);
});

const config = JSON.parse(read('firestore.indexes.json'));
const newGroups = ['hr_nudge_actions', 'hr_nudge_intents'];
// The adjacent domain gate independently pins these exact13 indexes. They
// are not part of this gate's immutable pre-HR baseline or its eight shapes.
const domainGroups = ['hr_request_notification_jobs', 'hr_document_notification_jobs', 'hr_domain_notification_intents'];
const expectedIndexes = [['hr_nudge_actions', 'expires_at_ms'], ['hr_nudge_actions', 'not_before_ms'], ['hr_nudge_actions', 'updated_at_ms'],
  ['hr_nudge_intents', 'expires_at_ms'], ['hr_nudge_intents', 'lease_until_ms'], ['hr_nudge_intents', 'not_before_ms'],
  ['hr_nudge_intents', 'next_check_ms'], ['hr_nudge_intents', 'created_at_ms']].map(([collectionGroup, fieldPath]) => ({
  collectionGroup, queryScope: 'COLLECTION_GROUP', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath, order: 'ASCENDING' }]
}));
await check('exact eight required collection-group indexes, without duplicate or extra query shapes', () => {
  assert.deepEqual(config.indexes.filter(i => newGroups.includes(i.collectionGroup)), expectedIndexes);
  assert.equal(config.indexes.length, 34);
});
await check('all13 original indexes and32 field overrides match immutable b1451e9 baseline', () => {
  assert.deepEqual(Object.keys(config).sort(), ['fieldOverrides', 'indexes']);
  const old = config.indexes.filter(i => !newGroups.includes(i.collectionGroup) && !domainGroups.includes(i.collectionGroup));
  assert.equal(old.length, 13); assert.equal(config.fieldOverrides.length, 32);
  // Canonical JSON hashes from read-only git show b1451e9. Runtime test needs
  // no Git installation/history and ignores only insignificant JSON whitespace.
  assert.equal(sha(JSON.stringify(old)), '3b558f2e2ad2530a7496c51d5cfe3a44d88f2fe59372d2bb2b8d860cc8052766');
  assert.equal(sha(JSON.stringify(config.fieldOverrides)), '41571b75f7605882500137b420a1664964d2efd0cee6f3a6ef885c44399c9939');
});
await check('old automatic reminder/report producers and reviewed modules are unchanged', () => {
  const oldExports = index.split(/(?=^exports\.)/m);
  const pins = { hoursReminder: '003f88d5a96aec52264411971761a18fa989da146b4f3a0f8d7bc2f77bc326d4',
    onReportChange: 'cc1236a2d6c884db0069174da4b5af139350b83017842ea0aae031637f4ce811' };
  for (const [name, digest] of Object.entries(pins)) {
    const block = oldExports.find(b => b.startsWith('exports.' + name + ' =')); assert.ok(block, name);
    const boundary = block.lastIndexOf('\n// ----------');
    assert.equal(sha(block.slice(0, boundary >= 0 ? boundary : block.length).trim()), digest, name + ' baseline source changed');
  }
  assert.equal(sha(read('functions/hr-hours-nudges.js')), 'fd572de3dae6563bb8f63dd2e7a7baf8699598ad80dcafc47d244f89029724d7');
  assert.equal(sha(read('functions/hr-hours-dispatch.js')), 'a4050957a89f8718342d27df1b8243d578464d2b838b67d07b5e89d96ddd471d');
});
const client = await import('data:text/javascript;base64,' + Buffer.from(read('incident-client.js')).toString('base64'));
const server = createRequire(import.meta.url)(path.join(root, 'functions/ops-telemetry-contract.js'));
await check('new callable names remain exact finite duplicate-free client/server vocabulary', () => {
  for (const key of ['KINDS', 'SCREENS', 'VERSIONS', 'CODES', 'CALLABLES']) {
    const left = client['TELEMETRY_' + key], right = server[key];
    for (const values of [left, right]) { assert.ok(Object.isFrozen(values)); assert.ok(values.every(v => typeof v === 'string')); assert.equal(new Set(values).size, values.length); }
    assert.deepEqual([...left].sort(), [...right].sort());
  }
  for (const name of Object.keys(mapping)) { assert.equal(client.TELEMETRY_CALLABLES.filter(v => v === name).length, 1); assert.equal(server.CALLABLES.filter(v => v === name).length, 1); }
  assert.equal(client.TELEMETRY_CALLABLES.includes('resumeHrHoursNudges'), false, 'scheduler is not a client callable');
});
await check('new callable telemetry exposes only five technical fields, never action/recipient/device content', () => {
  const marker = 'synthetic-private-action-and-device';
  for (const callable of Object.keys(mapping)) {
    const report = client.buildReport('callable-failed', { code: 'functions/unavailable', message: marker }, {
      callable, href: '/hr.html?action=' + marker, version: 'unknown', action_id: marker, uid: marker, token: marker });
    assert.deepEqual(Object.keys(report).sort(), ['callable', 'code', 'kind', 'screen', 'version']);
    assert.equal(report.callable, callable); assert.equal(report.screen, 'hr.html'); assert.equal(JSON.stringify(report).includes(marker), false);
    const normalized = server.normalizeTelemetry({ ...report, action_id: marker, token: marker, recipient_uid: marker });
    assert.deepEqual(normalized, report);
  }
});
await check('all inspected product sources remain unchanged during gate', () => assert.deepEqual(hashes(), before));
console.log('HR hours wiring: ' + passed + '/' + passed + ' passed; no SDK, network, browser or emulator calls.');
