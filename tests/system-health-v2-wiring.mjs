import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const index = read('functions/index.js');
const adapter = read('functions/system-health-firestore.js');
const rules = read('firestore.rules');
const policy = read('functions/backup-policy.js');
const indexes = read('firestore.indexes.json');

assert.match(index, /require\('\.\/system-health-service'\)/);
assert.match(index, /require\('\.\/system-health-firestore'\)/);
assert.match(index, /exports\.systemHealthV2\s*=\s*onSchedule/);
assert.match(index, /config\/system_health_v2/);
assert.match(index, /mode\s*!==\s*'OBSERVE'/);
assert.match(index, /schedule:\s*'15 6 \* \* \*'/);
assert.match(index, /maxInstances:\s*1/);
assert.match(adapter, /system_health_cycles\//);
assert.match(adapter, /health_shadow\//);
assert.match(adapter, /MAX_STATIONS\s*=\s*200/);
assert.match(adapter, /MAX_EMP_INDEX\s*=\s*5000/);
assert.match(adapter, /system_health_reports/);
assert.match(adapter, /expires_at/);
assert.doesNotMatch(adapter, /mail\.docs|\.to\b|\.subject\b/);
assert.match(rules, /match \/health_shadow\/\{dateId\}[\s\S]{0,100}allow read, write: if false/);
assert.match(rules, /match \/system_health_cycles\/\{cycleId\}[\s\S]{0,180}allow read, write: if false/);
assert.match(policy, /system_health_cycles\/\{cycleId\}/);
assert.match(policy, /health_shadow\/\{dateId\}/);
assert.match(policy, /system_health_reports\/\{stationId\}/);
for (const group of ['system_health_cycles', 'system_health_reports', 'health_shadow']) {
  assert.match(indexes, new RegExp('"collectionGroup"\\s*:\\s*"' + group
    + '"[\\s\\S]{0,120}"fieldPath"\\s*:\\s*"expires_at"[\\s\\S]{0,80}"ttl"\\s*:\\s*true'));
}

console.log('system-health-v2-wiring: PASS');
