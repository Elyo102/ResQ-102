import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function load(extra = {}) {
  const env = { ...process.env, GCLOUD_PROJECT: '', GOOGLE_CLOUD_PROJECT: '', FIREBASE_CONFIG: '', RESQ_WEB_API_KEY: '', ...extra };
  const run = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./functions/runtime-config')))"], { cwd: root, env, encoding: 'utf8' });
  return { ...run, value: run.status === 0 ? JSON.parse(run.stdout) : null };
}

let run = load({ GCLOUD_PROJECT: 'station-102' });
assert.equal(run.value?.isProduction, true);
assert.equal(run.value?.schedulersEnabled, true);
run = load({ FIREBASE_CONFIG: JSON.stringify({ projectId: 'station-102' }) });
assert.equal(run.value?.isProduction, true);
run = load({ GCLOUD_PROJECT: 'resq-staging', RESQ_WEB_API_KEY: 'synthetic-public-key' });
assert.equal(run.value?.environment, 'staging');
assert.equal(run.value?.outboundMode, 'sink');
assert.equal(run.value?.schedulersEnabled, false);
run = load({ GCLOUD_PROJECT: 'resq-staging' });
assert.notEqual(run.status, 0);
assert.match(run.stderr, /RESQ_WEB_API_KEY/);
run = load();
assert.equal(run.value?.environment, 'staging');
assert.equal(run.value?.outboundMode, 'sink');
console.log('✓ runtime environment detection is fail-closed');
