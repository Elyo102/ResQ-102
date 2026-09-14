import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReadyUpdate, fetchLatestReleaseVersion, refreshInstalledApp } from '../pwa.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8').replace(/^\uFEFF/, ''));
const futureVersion = String(release.v || '').replace(/(\d+)$/, value => String(Number(value) + 1));
assert.notEqual(futureVersion, release.v, 'release version must end with a numeric revision');

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
    version: release.v, runningVersion: release.v,
    serviceWorker: sw, cacheStorage, location,
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
assert.equal(timedOut.replaced.length, 0, 'timeout never refreshes away an unsaved operation');

const updateFailed = await scenario('active', true, true);
assert.equal(updateFailed.result.workerActivated, false, 'failed update is reported');
assert.deepEqual(updateFailed.deleted, [], 'failed update preserves offline caches');
assert.equal(updateFailed.replaced.length, 0, 'failed update never refreshes away an unsaved operation');

{
  const sw = new Events();
  const worker = makeWorker('installing', sw, false);
  const activation = (await import('../pwa.js')).activateAvailableWorker(worker, sw, 1);
  sw.emit('controllerchange');
  assert.equal(await activation, false,
    'controllerchange from another tab does not activate the wrong candidate');
}

{
  const source = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
  const installBody = source.slice(source.indexOf("self.addEventListener('install'"),
    source.indexOf("self.addEventListener('activate'"));
  assert.equal(installBody.includes('skipWaiting'), false,
    'install never forces an update over a live page');
  assert.equal(source.includes('Promise.all(CORE_SHELL.map(function (u) { return c.add(u); }))'), true,
    'the minimal release shell is cached atomically');
  assert.equal(source.includes("event.data.type === 'RESQ_SKIP_WAITING'"), true,
    'only an explicit user-approved message activates a waiting update');
}

{
  const calls = [];
  const version = await fetchLatestReleaseVersion({
    now: () => 777,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ v: futureVersion }) };
    }
  });
  assert.equal(version, futureVersion, 'the update flow reads the newly deployed release version');
  assert.deepEqual(calls, [{
    url: './version.json?update_check=777',
    options: { cache: 'no-store' }
  }], 'the release manifest is fetched without a stale browser cache');
}

{
  const refreshed = [];
  const result = await applyReadyUpdate({
    document: { querySelector: () => null },
    fetch: async () => ({ ok: true, json: async () => ({ v: futureVersion }) }),
    refresh: async (options) => { refreshed.push(options); return { workerActivated: true }; }
  });
  assert.equal(result.updated, true, 'a verified release can be applied');
  assert.equal(refreshed[0].version, futureVersion, 'cache cleanup keeps the new release cache');
}

{
  let refreshes = 0;
  const result = await applyReadyUpdate({
    document: { querySelector: () => null },
    fetch: async () => { throw new Error('offline'); },
    refresh: async () => { refreshes += 1; }
  });
  assert.equal(result.updated, false, 'manifest failure is reported');
  assert.equal(refreshes, 0, 'manifest failure cannot activate, delete caches, or reload');
}

{
  let fetches = 0;
  const result = await applyReadyUpdate({
    document: { querySelectorAll: () => [{ files: [{}] }], querySelector: () => null },
    fetch: async () => { fetches += 1; }
  });
  assert.equal(result.updated, false, 'a selected file blocks the update');
  assert.equal(result.reason, 'blocked', 'the caller receives a stable block reason');
  assert.equal(fetches, 0, 'a blocked update performs no network or lifecycle side effect');
}

{
  const doc = {
    dirty: false,
    querySelectorAll() { return this.dirty ? [{ files: [{}] }] : []; },
    querySelector: () => null
  };
  let refreshes = 0;
  const result = await applyReadyUpdate({
    document: doc,
    fetch: async () => {
      doc.dirty = true;
      return { ok: true, json: async () => ({ v: futureVersion }) };
    },
    refresh: async () => { refreshes += 1; }
  });
  assert.equal(result.reason, 'blocked',
    'a form that becomes dirty during the version fetch blocks activation');
  assert.equal(refreshes, 0, 'the guard is checked again immediately before activation');
}

{
  const result = await applyReadyUpdate({
    document: { querySelectorAll: () => [], querySelector: () => null },
    fetch: async () => ({ ok: true, json: async () => ({ v: futureVersion }) }),
    refresh: async () => { throw new Error('boom'); }
  });
  assert.equal(result.reason, 'activation-failed', 'an unexpected refresh failure is contained');
  assert.equal(result.updated, false, 'a thrown refresh is never reported as updated');
}

{
  const sw = new Events();
  sw.getRegistration = async () => ({
    waiting: null,
    installing: null,
    active: {},
    update: async () => {}
  });
  const deleted = [];
  const replaced = [];
  const result = await refreshInstalledApp({
    version: futureVersion, runningVersion: release.v, requireCandidate: true,
    serviceWorker: sw,
    cacheStorage: {
      keys: async () => ['resq-v42h18-release1'],
      delete: async (key) => { deleted.push(key); return true; }
    },
    location: {
      href: 'https://station-102.web.app/login.html',
      replace: (url) => replaced.push(url)
    }
  });
  assert.equal(result.workerActivated, false,
    'a newer manifest without an exact worker candidate is not activation proof');
  assert.deepEqual(deleted, [], 'an unproven update cannot delete the current offline cache');
  assert.deepEqual(replaced, [], 'an unproven update cannot reload the page');
}

console.log('PWA update lifecycle: 15/15 PASS');
