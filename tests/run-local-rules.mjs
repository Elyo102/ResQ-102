import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// An explicit local emulator must already be running. Never start cloud tools
// or reuse an arbitrary ambient host/project when this gate is invoked.
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Node22 required');
if (!['127.0.0.1:8191', '127.0.0.1:8199'].includes(process.env.FIRESTORE_EMULATOR_HOST) ||
    process.env.GCLOUD_PROJECT !== 'demo-resq') {
  throw new Error('Owned loopback emulator on 8191 or 8199, GCLOUD_PROJECT=demo-resq required');
}
const cwd = fileURLToPath(new URL('../rules-test/', import.meta.url));
const scripts = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).scripts;
if (scripts.pretest || scripts.posttest) throw new Error('Rules lifecycle changed; inspect before execution');
const script = scripts.test;
const entries = script.split(' && ').map(command => {
  const match = /^node ((?:\.\.\/functions\/)?[a-z0-9.-]+\.(?:mjs|cjs|js))$/.exec(command);
  if (!match) throw new Error('Rules suite command changed; inspect before execution');
  return match[1];
});
const env = { ...process.env, GOOGLE_CLOUD_PROJECT: 'demo-resq',
  FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-resq' }),
  METADATA_SERVER_DETECTION: 'none' };
delete env.GOOGLE_APPLICATION_CREDENTIALS;
delete env.FIREBASE_TOKEN;
// firebase emulators:exec exports FIREBASE_EMULATOR_HUB (localhost:4400 or the next free port).
// Every rules suite passes explicit Firestore host/port, so hub discovery is unnecessary and the
// hub stays an unregistered, fail-closed endpoint under tests/lib/network-guard.cjs.
delete env.FIREBASE_EMULATOR_HUB;
for (const entry of entries) {
  const result = spawnSync(process.execPath, [entry], { cwd, env, stdio: 'inherit', windowsHide: true, timeout: 180000 });
  if (result.error || result.status !== 0) {
    console.error('Rules suite failed:', entry, result.error?.code || result.status);
    process.exit(1);
  }
}
console.log(`Rules suite entries passed: ${entries.length}/${entries.length}`);
