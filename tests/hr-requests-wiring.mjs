import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['functions/index.js', 'incident-client.js', 'functions/ops-telemetry-contract.js'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const hashes = () => Object.fromEntries(files.map(file => [file,
  createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
const before = hashes();
const mapping = Object.freeze({
  createHrRequest: 'create',
  listMyHrRequests: 'list',
  listHrRequestsInbox: 'listInbox',
  getHrRequest: 'get',
  replyHrRequest: 'reply',
  setHrRequestStatus: 'setStatus',
  nudgeHrRequest: 'nudge'
});
let passed = 0;
async function check(label, run) { await run(); ++passed; console.log('PASS ' + label); }

// Only the actual local require and registration block run here. No Firebase
// SDK, service implementation, credentials, browser or network is initialized.
const index = read('functions/index.js');
const imports = [...index.matchAll(/^const hrRequestsModule = require\((['"])\.\/hr-requests\1\);\s*$/gm)];
const registrations = [...index.matchAll(/const hrRequests = hrRequestsModule\.createHrRequests\([\s\S]*?exports\.nudgeHrRequest = [^\r\n]+;/g)];
assert.equal(imports.length, 1, 'exactly one actual ./hr-requests module require');
assert.equal(registrations.length, 1, 'exactly one bounded actual request registration block');
assert.equal((index.match(/hrRequestsModule\.createHrRequests\(/g) || []).length, 1,
  'request factory is not initialized a second time elsewhere');
for (const name of Object.keys(mapping)) {
  assert.equal((index.match(new RegExp('exports\\.' + name + '\\s*=', 'g')) || []).length, 1,
    name + ' must not be overwritten elsewhere in index');
}

const db = Object.freeze({ synthetic: 'db' });
const auth = Object.freeze({ synthetic: 'auth' });
class HttpsError extends Error {}
const exports = {}, registered = [], calls = [], dependencies = [], required = [];
let authCalls = 0, failure = null;
const result = Object.freeze({ synthetic: 'original-service-result' });
const service = Object.fromEntries(Object.values(mapping).map(method => [method, request => {
  calls.push({ method, request });
  return failure ? Promise.reject(failure) : Promise.resolve(result);
}]));
const moduleStub = { createHrRequests(deps) { dependencies.push(deps); return service; } };
vm.runInNewContext(imports[0][0] + '\n' + registrations[0][0], {
  db, HttpsError, exports,
  require(name) { required.push(name); assert.equal(name, './hr-requests'); return moduleStub; },
  admin: { auth() { ++authCalls; return auth; } },
  onCall(options, handler) { registered.push({ options, handler }); return handler; }
}, { filename: 'actual-hr-requests-registration.js', timeout: 1000 });

await check('actual module require and one factory receive exactly db, live Auth and HttpsError', () => {
  assert.deepEqual(required, ['./hr-requests']);
  assert.equal(authCalls, 1); assert.equal(dependencies.length, 1);
  const deps = dependencies[0];
  assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'auth', 'db']);
  assert.equal(deps.db, db); assert.equal(deps.auth, auth); assert.equal(deps.HttpsError, HttpsError);
});
await check('exactly the seven approved exports are registered with enforced App Check', () => {
  assert.deepEqual(Object.keys(exports).sort(), Object.keys(mapping).sort());
  assert.equal(registered.length, 7);
  for (const { options, handler } of registered) {
    assert.deepEqual(Object.keys(options), ['enforceAppCheck']);
    assert.equal(options.enforceAppCheck, true); assert.equal(typeof handler, 'function');
  }
});

for (const [name, method] of Object.entries(mapping)) {
  await check(name + ' forwards the original request and result to ' + method, async () => {
    const request = Object.freeze({
      auth: Object.freeze({ uid: 'synthetic-owner', token: Object.freeze({
        stationId: 'synthetic_station', role: 'firefighter', auth_time: 1000
      }) }),
      app: Object.freeze({ appId: 'synthetic-app-check' }),
      data: Object.freeze({ request_id: 'synthetic-request', text: 'Synthetic private text' })
    });
    const count = calls.length;
    assert.equal(await exports[name](request), result);
    assert.equal(calls.length, count + 1);
    assert.equal(calls.at(-1).method, method); assert.equal(calls.at(-1).request, request);
  });
}
await check('all seven wrappers preserve the original service rejection', async () => {
  failure = new HttpsError('synthetic service rejection');
  for (const [name, method] of Object.entries(mapping)) {
    const request = Object.freeze({ data: Object.freeze({}) }), count = calls.length;
    await assert.rejects(() => exports[name](request), error => error === failure);
    assert.equal(calls.length, count + 1);
    assert.equal(calls.at(-1).method, method); assert.equal(calls.at(-1).request, request);
  }
  failure = null;
});

const client = await import('data:text/javascript;base64,' + Buffer.from(read('incident-client.js')).toString('base64'));
const server = createRequire(import.meta.url)(path.join(root, 'functions/ops-telemetry-contract.js'));
await check('client and server keep matching duplicate-free finite telemetry vocabularies', () => {
  for (const key of ['KINDS', 'SCREENS', 'VERSIONS', 'CODES', 'CALLABLES']) {
    const left = client['TELEMETRY_' + key], right = server[key];
    for (const values of [left, right]) {
      assert.ok(Array.isArray(values)); assert.ok(Object.isFrozen(values));
      assert.ok(values.every(value => typeof value === 'string'));
      assert.equal(new Set(values).size, values.length);
    }
    assert.deepEqual([...left].sort(), [...right].sort(), key);
  }
  for (const name of Object.keys(mapping)) {
    assert.equal(client.TELEMETRY_CALLABLES.filter(value => value === name).length, 1);
    assert.equal(server.CALLABLES.filter(value => value === name).length, 1);
  }
  assert.ok(client.TELEMETRY_SCREENS.includes('hr-requests.html'));
  assert.ok(server.SCREENS.includes('hr-requests.html'));
});
await check('new callable telemetry remains five technical fields, never private text or IDs', () => {
  const privateMarker = 'synthetic-private-case-and-body';
  for (const callable of Object.keys(mapping)) {
    const report = client.buildReport('callable-failed', { code: 'functions/unavailable', message: privateMarker }, {
      callable, href: '/hr-requests.html?case=' + privateMarker + '#' + privateMarker,
      version: 'unknown', text: privateMarker, uid: privateMarker
    });
    assert.deepEqual(Object.keys(report).sort(), ['callable', 'code', 'kind', 'screen', 'version']);
    assert.equal(report.callable, callable); assert.equal(report.screen, 'hr-requests.html');
    assert.equal(JSON.stringify(report).includes(privateMarker), false);
    assert.deepEqual(server.normalizeTelemetry(report), report);
  }
  const unknown = client.buildReport('callable-failed', { code: privateMarker }, {
    callable: privateMarker, href: '/' + privateMarker, version: privateMarker
  });
  assert.equal(unknown.callable, 'unknown'); assert.equal(unknown.screen, 'unknown');
  assert.equal(unknown.code, 'unknown'); assert.equal(JSON.stringify(unknown).includes(privateMarker), false);
  assert.equal(server.normalizeTelemetry({ callable: privateMarker }).callable, 'unknown');
});
await check('all inspected product sources remain unchanged', () => assert.deepEqual(hashes(), before));
console.log('HR requests wiring: ' + passed + '/' + passed + ' passed; no SDK, emulator or network calls.');
