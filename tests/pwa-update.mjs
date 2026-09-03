import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshInstalledApp } from '../pwa.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8').replace(/^\uFEFF/, ''));

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x !== fn));
  }
  emit(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn();
  }
}

function makeWorker(state, serviceWorker, activate) {
  const worker = new Events();
  worker.state = state;
  worker.messages = [];
  worker.postMessage = function (message) {
    worker.messages.push(message);
    if (!activate) return;
    worker.state = 'activated';
    worker.emit('statechange');
    serviceWorker.emit('controllerchange');
  };
  return worker;
}

async function scenario(kind, activate = true, updateFails = false) {
  const sw = new Events();
  const worker = kind === 'active' ? null : makeWorker(kind, sw, activate);
  let updates = 0;
  sw.getRegistration = async function () {
    return {
      waiting: kind === 'waiting' ? worker : null,
      installing: kind === 'installing' ? worker : null,
      active: kind === 'active' ? {} : null,
      update: async function () {
        updates += 1;
        if (updateFails) throw new Error('offline');
      }
    };
  };

  const existing = [
    'resq-v41e-release1',
    'resq-v42f1-release1',
    'shared-non-resq-cache'
  ];
  const deleted = [];
  const cacheStorage = {
    keys: async () => existing.slice(),
    delete: async (key) => { deleted.push(key); return true; }
  };
  const replaced = [];
  const location = {
    href: 'https://station-102.web.app/login.html?from=profile',
    replace: (url) => replaced.push(url)
  };

  const result = await refreshInstalledApp({
    version: release.v, serviceWorker: sw, cacheStorage, location,
    timeoutMs: activate ? 50 : 1, now: () => 12345
  });
  return { result, worker, updates, deleted, replaced };
}

for (const kind of ['waiting', 'installing', 'active']) {
  const got = await scenario(kind);
  assert.equal(got.updates, 1, kind + ': update runs once');
  assert.equal(got.result.workerActivated, true, kind + ': worker is active');
  assert.deepEqual(got.deleted, ['resq-v41e-release1', 'resq-v42f1-release1'],
    kind + ': every old ResQ cache is deleted after the new worker activates');
  assert.equal(got.replaced.length, 1, kind + ': reload runs once');
  assert.ok(got.replaced[0].includes('updated=' + encodeURIComponent(release.v + '-12345')),
    kind + ': reload URL is fresh');
  if (got.worker) {
    assert.deepEqual(got.worker.messages, [{ type: 'RESQ_SKIP_WAITING' }],
      kind + ': activation message is sent once');
  }
}

const timedOut = await scenario('installing', false);
assert.equal(timedOut.result.workerActivated, false, 'timeout is reported');
assert.deepEqual(timedOut.deleted, [], 'timeout preserves every cache');
assert.equal(timedOut.replaced.length, 1, 'timeout still performs one online refresh');

const updateFailed = await scenario('active', true, true);
assert.equal(updateFailed.result.workerActivated, false, 'failed update is reported');
assert.deepEqual(updateFailed.deleted, [], 'failed update preserves offline caches');
assert.equal(updateFailed.replaced.length, 1, 'failed update still performs one refresh');

console.log('PWA update lifecycle: 5/5 PASS');
