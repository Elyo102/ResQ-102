import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = fs.readFileSync(path.join(root, 'functions', 'index.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
const nav = fs.readFileSync(path.join(root, 'nav.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'maintenance.html'), 'utf8');
const policy = createRequire(import.meta.url)('../functions/backup-policy.js');
let passed = 0;
function check(name, run) { run(); passed += 1; console.log('PASS ' + name); }

check('three maintenance callables use the same bounded App Check options', () => {
  assert.match(index, /const MAINTENANCE_OPTIONS = Object\.freeze\(\{ region:'europe-west1', enforceAppCheck:true,/);
});
check('three maintenance callables are exported through the service only', () => {
  for (const [name, method] of [['getMaintenanceDashboard','getDashboard'],['setMaintenanceMode','setMode'],['runMaintenanceAnalysis','runAnalysis']]) {
    assert.match(index, new RegExp('exports\\.' + name + ' = onCall\\(MAINTENANCE_OPTIONS, req => maintenanceService\\.' + method + '\\(req\\)\\)'));
  }
});
check('maintenance shell and direct dependencies are available offline', () => {
  for (const file of ['maintenance.html','maintenance-client.js','maintenance.css']) {
    assert.ok(worker.includes("'./" + file + "'"), file);
  }
});
check('maintenance navigation is visible only through super policy', () => {
  assert.match(nav, /href: 'maintenance\.html', label: 'תחזוקת מערכת', who: 'super'/);
});
check('maintenance page reacts to token claim changes and clears the protected DOM first', () => {
  assert.match(page, /getAuth, onIdTokenChanged/);
  assert.match(page, /await user\.getIdTokenResult\(\)/);
  assert.doesNotMatch(page, /getIdTokenResult\(true\)/);
  assert.match(page, /onIdTokenChanged\(auth,async user=>\{\s*const mine=\+\+epoch;\s*identity=null;\s*ui\.invalidate\(\);\s*\$\('main'\)\.classList\.add\('maintenance-hidden'\)/);
  assert.doesNotMatch(page, /onAuthStateChanged/);
});
check('maintenance config is explicitly classified for backup and restore', () => {
  const entry = policy.getPolicy('stations/{sid}/maintenance/config');
  assert.equal(entry?.backupPolicy, 'managed_export');
  assert.equal(entry?.restorePolicy, 'restore');
  assert.equal(entry?.humanReadable, 'redacted');
});
check('shallow heartbeat is five-minute, bounded and does not scan user data', () => {
  const block = index.slice(index.indexOf('exports.systemHeartbeat ='), index.indexOf('exports.healthz ='));
  assert.match(block, /schedule: 'every 5 minutes'/);
  assert.match(block, /db\.doc\('system\/heartbeat'\)\.set/);
  assert.doesNotMatch(block, /collection\(|\.get\(|count\(/);
});
check('public health endpoint is stateless, finite and never exposes configuration', () => {
  const block = index.slice(index.indexOf('exports.healthz ='), index.indexOf('// =======================================================================', index.indexOf('exports.healthz =')));
  assert.match(block, /req\.method !== 'GET'/);
  assert.match(block, /Cache-Control', 'no-store'/);
  assert.match(block, /\{ ok:true, service:'resq' \}/);
  assert.doesNotMatch(block, /db\.|admin\.|process\.env|station|email|uid/);
});
console.log('maintenance wiring: ' + passed + ' passed');
