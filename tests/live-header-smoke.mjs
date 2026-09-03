import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const base = 'https://station-102.web.app';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(readFileSync(resolve(root, 'version.json'), 'utf8'));

function directives(value) {
  return new Set(String(value || '').split(',').map((part) => part.trim().toLowerCase()).filter(Boolean));
}

function hasExactDirectives(actual, expected) {
  return actual.size === expected.length && expected.every((item) => actual.has(item));
}

async function request(path, method = 'HEAD') {
  const url = `${base}${path}?release_probe=${Date.now()}`;
  const response = await fetch(url, {
    method,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response;
}

const workerResponse = await request('/firebase-messaging-sw.js');
const versionResponse = await request('/version.json', 'GET');
const ordinaryJsResponse = await request('/schedule-management.js');
const worker = directives(workerResponse.headers.get('cache-control'));
const version = directives(versionResponse.headers.get('cache-control'));
const ordinaryJs = directives(ordinaryJsResponse.headers.get('cache-control'));

for (const [name, values] of [['service worker', worker], ['version.json', version]]) {
  if (!hasExactDirectives(values, ['no-cache', 'no-store', 'must-revalidate'])) {
    throw new Error(`${name}: expected exactly no-cache, no-store, must-revalidate; got ${[...values].join(', ')}`);
  }
}
if (!hasExactDirectives(ordinaryJs, ['no-cache'])) {
  throw new Error(`ordinary JS: expected exactly no-cache; got ${[...ordinaryJs].join(', ')}`);
}

const liveVersion = await versionResponse.json();
if (liveVersion.v !== expectedVersion.v || liveVersion.d !== expectedVersion.d) {
  throw new Error(`version.json: live ${JSON.stringify(liveVersion)} does not match candidate ${JSON.stringify(expectedVersion)}`);
}

console.log(`live header smoke PASS · ${base} · ${expectedVersion.v}`);
