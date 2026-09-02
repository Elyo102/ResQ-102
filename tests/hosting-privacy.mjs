import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

function check(ok, label) {
  console.log((ok ? '✓ ' : '✗ ') + label);
  if (!ok) failed += 1;
}

const privateRoster = path.join(root, 'roster-import.js');
const importHtml = fs.readFileSync(path.join(root, 'import.html'), 'utf8');
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
const worker = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');

check(!fs.existsSync(privateRoster), 'the private roster file is absent from the deploy tree');
for (const token of ['roster-import', 'ROSTER', 'pwPaste', 'bulkImport']) {
  check(!importHtml.includes(token), 'import.html no longer contains ' + token);
}
for (const token of ["collection(db, 'stations', STATION_ID, 'users')",
                     'v.employee_number', 'v.is_active === false']) {
  check(importHtml.includes(token), 'history import contains ' + token);
}
for (const id of ['knob', 'master', 'mState', 'ready',
                  'hPaste', 'hDry', 'hRun', 'hMsg', 'hSum']) {
  check(new RegExp('id=["\\\']' + id + '["\\\']').test(importHtml),
        'import.html keeps #' + id);
}
check(firebaseConfig.hosting.ignore.includes('roster-import.js'),
      'Firebase Hosting excludes roster-import.js as defense in depth');
check(worker.includes("const CACHE = 'resq-v42f2-release1'"),
      'the service-worker cache is rotated away from the exposed copy');

const server = http.createServer((req, res) => {
  const requested = decodeURIComponent(String(req.url || '/').split('?')[0]);
  const file = path.join(root, requested.replace(/^\/+/, ''));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200);
  res.end(fs.readFileSync(file));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const response = await fetch('http://127.0.0.1:' + server.address().port +
                               '/roster-import.js');
  check(response.status === 404, 'a local hosting probe returns 404 for roster-import.js');
} finally {
  await new Promise(resolve => server.close(resolve));
}

if (failed) {
  console.error('\n' + failed + ' hosting privacy checks failed.');
  process.exit(1);
}
console.log('\nHosting privacy checks passed.');
