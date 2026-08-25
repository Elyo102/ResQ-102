import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = x => console.log('✓ ' + x);
const fail = x => { bad++; console.error('✗ ' + x); };

const envs = JSON.parse(fs.readFileSync(path.join(root, 'config/environments.json'), 'utf8'));
if (envs.production.firebase.projectId === 'station-102') ok('production project is pinned');
else fail('production project must be station-102');
if (envs.staging.firebase.projectId !== 'station-102') ok('staging cannot target production');
else fail('staging points to production');

const runtime = fs.readFileSync(path.join(root, 'functions/runtime-config.js'), 'utf8');
for (const token of ['outboundMode', "'sink'", 'schedulersEnabled', "'false'"]) {
  if (runtime.includes(token)) ok('runtime guard contains ' + token);
  else fail('missing runtime guard ' + token);
}
if (runtime.includes('webApiKey')) ok('server login key is environment-specific');
else fail('server login key is not environment-specific');

const index = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
for (const name of ['nightlySnapshot','nightlyScan','monthlyHrReport','hoursReminder','guardReminder','nightlySheetBackup','signReminder','systemHealth']) {
  const start = index.indexOf('exports.' + name);
  const next = index.indexOf('exports.', start + 8);
  const block = index.slice(start, next < 0 ? index.length : next);
  if (start >= 0 && block.includes('schedulersEnabled')) ok(name + ' is gated');
  else fail(name + ' is not gated');
}

const trackedConfig = ['firebase-config.js', 'firebase-sw-config.js'];
const before = trackedConfig.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
const check = spawnSync(process.execPath, ['scripts/generate-client-config.mjs', 'staging', '--check'], { cwd: root, encoding: 'utf8' });
const incomplete = /REPLACE_WITH/.test(JSON.stringify(envs.staging));
if ((incomplete && check.status !== 0) || (!incomplete && check.status === 0)) ok('staging config validation is fail-closed');
else fail('staging config validation returned an unexpected result');
const after = trackedConfig.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
if (before.every((value, i) => value === after[i])) ok('staging validation never rewrites tracked config');
else fail('staging validation rewrote tracked config');

if (bad) process.exit(1);
