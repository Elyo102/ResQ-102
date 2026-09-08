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
  publishHrDocument: 'publish',
  reviseHrDocument: 'revise',
  listMyHrDocuments: 'listMine',
  listHrProcedures: 'listProcedures',
  listManagedHrDocuments: 'listManaged',
  getHrDocument: 'get',
  markHrDocumentOpened: 'markOpened',
  acknowledgeHrDocument: 'acknowledge',
  listHrDocumentReceipts: 'listReceipts',
  nudgeHrDocument: 'nudge'
});
let passed = 0;
async function check(label, run) { await run(); ++passed; console.log('PASS ' + label); }

// Evaluate only the actual local module require and bounded registration
// block. No Firebase SDK, domain, credentials, browser or network is started.
const index = read('functions/index.js');
const imports = [...index.matchAll(/^const hrDocumentsModule = require\((['"])\.\/hr-documents\1\);\s*$/gm)];
const registrations = [...index.matchAll(/const hrDocuments = hrDocumentsModule\.createHrDocuments\([\s\S]*?exports\.nudgeHrDocument = [^\r\n]+;/g)];
assert.equal(imports.length, 1, 'exactly one actual ./hr-documents module require');
assert.equal(registrations.length, 1, 'exactly one bounded actual documents registration block');
assert.equal((index.match(/hrDocumentsModule\.createHrDocuments\(/g) || []).length, 1,
  'documents factory is not initialized a second time elsewhere');
for (const name of Object.keys(mapping)) {
  assert.equal((index.match(new RegExp('exports\\.' + name + '\\s*=', 'g')) || []).length, 1,
    name + ' must not be overwritten elsewhere in index');
}

const db = Object.freeze({ synthetic: 'db' }), auth = Object.freeze({ synthetic: 'auth' });
class HttpsError extends Error {}
const exports = {}, registered = [], calls = [], dependencies = [], required = [];
let authCalls = 0, failure = null;
const result = Object.freeze({ synthetic: 'original-service-result' });
const service = Object.fromEntries(Object.values(mapping).map(method => [method, request => {
  calls.push({ method, request });
  return failure ? Promise.reject(failure) : Promise.resolve(result);
}]));
const moduleStub = { createHrDocuments(deps) { dependencies.push(deps); return service; } };
vm.runInNewContext(imports[0][0] + '\n' + registrations[0][0], {
  db, HttpsError, exports,
  require(name) { required.push(name); assert.equal(name, './hr-documents'); return moduleStub; },
  admin: { auth() { ++authCalls; return auth; } },
  onCall(options, handler) { registered.push({ options, handler }); return handler; }
}, { filename: 'actual-hr-documents-registration.js', timeout: 1000 });

await check('actual module require and one factory receive only db, live Auth and HttpsError', () => {
  assert.deepEqual(required, ['./hr-documents']);
  assert.equal(authCalls, 1); assert.equal(dependencies.length, 1);
  const deps = dependencies[0];
  assert.deepEqual(Object.keys(deps).sort(), ['HttpsError', 'auth', 'db']);
  assert.equal(deps.db, db); assert.equal(deps.auth, auth); assert.equal(deps.HttpsError, HttpsError);
});
await check('exactly the ten approved exports enforce App Check', () => {
  assert.deepEqual(Object.keys(exports).sort(), Object.keys(mapping).sort());
  assert.equal(registered.length, 10);
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
      data: Object.freeze({ request_id: 'synthetic-request', document_id: 'a'.repeat(64), revision: 1,
        text: 'Synthetic private document text' })
    });
    const count = calls.length;
    assert.equal(await exports[name](request), result);
    assert.equal(calls.length, count + 1);
    assert.equal(calls.at(-1).method, method); assert.equal(calls.at(-1).request, request);
  });
}
await check('all ten wrappers preserve the original service rejection', async () => {
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
await check('matching duplicate-free finite telemetry vocabularies include exactly each new name', () => {
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
  assert.ok(client.TELEMETRY_SCREENS.includes('hr-documents.html'));
  assert.ok(server.SCREENS.includes('hr-documents.html'));
  assert.deepEqual([...server.INPUT_FIELDS].sort(), ['callable', 'code', 'kind', 'screen', 'version']);
});
await check('document callable telemetry remains five technical fields without private content or IDs', () => {
  const marker = 'synthetic-private-document-recipient-and-text';
  for (const callable of Object.keys(mapping)) {
    const report = client.buildReport('callable-failed', { code: 'functions/unavailable', message: marker, stack: marker }, {
      callable, href: '/hr-documents.html?document=' + marker + '#' + marker,
      version: 'unknown', text: marker, title: marker, document_id: marker, target_uid: marker, receipt: marker
    });
    assert.deepEqual(Object.keys(report).sort(), ['callable', 'code', 'kind', 'screen', 'version']);
    assert.equal(report.callable, callable); assert.equal(report.screen, 'hr-documents.html');
    assert.equal(JSON.stringify(report).includes(marker), false);
    assert.deepEqual(server.normalizeTelemetry(report), report);
  }
  const unknown = client.buildReport('callable-failed', { code: marker }, { callable: marker, href: '/' + marker, version: marker });
  assert.equal(unknown.callable, 'unknown'); assert.equal(unknown.screen, 'unknown'); assert.equal(unknown.code, 'unknown');
  assert.equal(JSON.stringify(unknown).includes(marker), false);
  const serverUnknown = server.normalizeTelemetry({ callable: marker, document_id: marker,
    title: marker, text: marker, target_uid: marker, receipt: marker });
  assert.deepEqual(Object.keys(serverUnknown).sort(), ['callable', 'code', 'kind', 'screen', 'version']);
  assert.equal(serverUnknown.callable, 'unknown');
  assert.equal(JSON.stringify(serverUnknown).includes(marker), false);
});
await check('all inspected product sources remain unchanged', () => assert.deepEqual(hashes(), before));
console.log('HR documents wiring: ' + passed + '/' + passed + ' passed; no SDK, browser, emulator or network calls.');
