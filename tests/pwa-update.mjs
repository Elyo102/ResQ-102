import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDetectedUpdate,
  applyReadyUpdate,
  createUpdateReadyHandler,
  dismissUpdateReady,
  fetchLatestReleaseVersion,
  refreshInstalledApp,
  registerPwaUpdateGuard
} from '../pwa.js';

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
  let cacheReads = 0;
  const deleted = [];
  const cacheStorage = {
    keys: async () => { cacheReads += 1; return existing.slice(); },
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
  return { result, worker, updates, cacheReads, deleted, replaced };
}

for (const kind of ['waiting', 'installing', 'active']) {
  const got = await scenario(kind);
  assert.equal(got.updates, 1, kind + ': update runs once');
  assert.equal(got.result.workerActivated, true, kind + ': worker is active');
  assert.equal(got.cacheReads, 0,
    kind + ': the page never owns service-worker cache cleanup');
  assert.deepEqual(got.deleted, [],
    kind + ': the page cannot delete the newly activated release cache');
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
  const normalizedVersion = String(release.v).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const loginSource = fs.readFileSync(path.join(root, 'login.html'), 'utf8').replace(/\r\n/g, '\n');
  const assetKey = loginSource.match(/\.\/pwa\.js\?v=([a-z0-9]+)/i)?.[1] || '';
  assert.equal(assetKey, normalizedVersion,
    'the asset build key belongs exactly to the visible release');
  assert.equal(source.includes("const CACHE = 'resq-v" + assetKey + "-release1'"), true,
    'the service-worker cache identity matches the visible release exactly');
  const installBody = source.slice(source.indexOf("self.addEventListener('install'"),
    source.indexOf("self.addEventListener('activate'"));
  assert.equal(installBody.includes('skipWaiting'), false,
    'install never forces an update over a live page');
  assert.equal(source.includes('Promise.all(CORE_SHELL.map(function (u) { return c.add(u); }))'), true,
    'the minimal release shell is cached atomically');
  assert.equal(source.includes("event.data.type === 'RESQ_SKIP_WAITING'"), true,
    'a lifecycle message can activate a waiting update');
  const pageSource = fs.readFileSync(path.join(root, 'pwa.js'), 'utf8');
  assert.equal(pageSource.includes('cacheStorage.keys'), false,
    'page code cannot regress into deleting service-worker caches');
  assert.match(loginSource, /id="preAuthUpdate"[^>]*>↻ עדכן את ResQ<\/button>/,
    'login exposes a physical update button before authentication');
  assert.match(loginSource, /id="preAuthUpdateStatus"[^>]*role="status"[^>]*aria-live="polite"/,
    'pre-auth update status is announced accessibly');
  assert.match(loginSource, /\$\('preAuthUpdate'\)\.onclick = function \(\) \{ return runVisibleUpdate/,
    'pre-auth and profile update buttons share one update flow');
  assert.match(loginSource, /protectedIds = \['loginPass','invitationSecret','invitationPassword','fName','fEmail','fPhone','fPass','fPass2'\]/,
    'update guard protects typed credentials, invitation secrets and registration data');
}

{
  let dismissed = 0;
  let shown = 0;
  const handler = createUpdateReadyHandler({
    document:{ querySelectorAll:() => [], querySelector:() => null },
    apply:async () => ({ updated:false, reason:'version-not-advanced', version:release.v }),
    show:() => { shown += 1; },
    dismiss:() => { dismissed += 1; }
  });
  const result = await handler({ worker:{ state:'activated' } });
  assert.equal(result.reason, 'version-not-advanced',
    'an already-current page identifies a stale lifecycle suggestion');
  assert.equal(dismissed, 1,
    'an already-current page removes the stale update suggestion');
  assert.equal(shown, 0,
    'an already-current page never replaces the stale suggestion with a false network warning');
}

{
  let removed = 0;
  const bar = { remove() { removed += 1; } };
  assert.equal(dismissUpdateReady({
    document:{ getElementById:id => id === 'pwaUpdateBar' ? bar : null }
  }), true, 'the visible stale suggestion can be dismissed');
  assert.equal(removed, 1, 'dismissal removes the visible update bar exactly once');
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
  assert.equal(refreshed[0].version, futureVersion, 'activation receives the verified release version');
}

{
  let refreshes = 0;
  const result = await applyReadyUpdate({
    runningVersion:'42H.18',
    document:{ querySelectorAll:() => [], querySelector:() => null },
    fetch:async () => ({ ok:true, json:async () => ({ v:release.v }) }),
    refresh:async () => { refreshes += 1; return { workerActivated:true }; }
  });
  // 42H.20 · Codex blocker 4 · נגזר מ-version.json (שנחתם מהמניפסט), לא מקובע.
  assert.notEqual(release.v, '42H.18', 'the release has a genuinely advanced visible version');
  assert.equal(release.v, JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8')).version, 'version.json carries exactly the manifest version');
  assert.equal(result.updated, true, 'a client already on 42H.18 applies the hotfix');
  assert.equal(refreshes, 1, 'the 42H.18 client activates the candidate exactly once');
}

{
  const sw = new Events();
  const doc = {
    dirty:false,
    querySelectorAll() { return this.dirty ? [{ files:[{}] }] : []; },
    querySelector:() => null
  };
  const worker = makeWorker('installed', sw, false);
  worker.postMessage = function (message) {
    worker.messages.push(message);
    doc.dirty = true;
    worker.state = 'activated';
    worker.emit('statechange');
    sw.emit('controllerchange');
  };
  const replaced = [];
  const result = await refreshInstalledApp({
    document:doc, candidate:worker, version:release.v, runningVersion:'42H.18',
    serviceWorker:sw, timeoutMs:50,
    location:{ href:'https://station-102.web.app/login.html', replace:url => replaced.push(url) }
  });
  assert.equal(result.workerActivated, true, 'the exact worker may finish activation');
  assert.equal(result.reloadDeferred, true,
    'work started during activation defers the destructive reload');
  assert.equal(replaced.length, 0, 'a late dirty transition cannot lose user input');
}

{
  let safe = false;
  let applies = 0;
  const unregister = registerPwaUpdateGuard(() => safe || 'הכניסה עדיין לא הסתיימה.');
  const candidate = { state:'installed' };
  const handler = createUpdateReadyHandler({
    document:{ querySelectorAll:() => [], querySelector:() => null },
    apply:async () => { applies += 1; return { updated:true }; },
    show:() => {}
  });
  const blocked = await handler({ worker:candidate });
  assert.equal(blocked.reason, 'blocked', 'an unresolved login lifecycle blocks auto activation');
  safe = true;
  const retried = await handler({ worker:candidate });
  unregister();
  assert.equal(retried.updated, true, 'the same candidate can retry after home becomes stable');
  assert.equal(applies, 1, 'the safe retry activates once');
}

{
  const loginSource = fs.readFileSync(path.join(root, 'login.html'), 'utf8').replace(/\r\n/g, '\n');
  const guardAt = loginSource.indexOf('registerPwaUpdateGuard(function ()');
  const initAt = loginSource.indexOf('initPWA({ offer: true })');
  assert.ok(guardAt !== -1 && initAt > guardAt,
    'login installs its lifecycle guard before service-worker discovery');
  assert.ok(loginSource.includes('void retryPendingPwaUpdate();'),
    'the stable home lifecycle retries a previously blocked candidate');
  assert.ok(loginSource.includes("dismissUpdateReady({ document });\n      m.textContent = 'אתה על הגרסה האחרונה.';"),
    'the manual version check removes a stale update suggestion when already current');
}

{
  const candidate = { state:'installed' };
  let refreshes = 0;
  const result = await applyDetectedUpdate({ worker:candidate }, {
    document:{ querySelectorAll:() => [], querySelector:() => null },
    fetch:async () => ({ ok:true, json:async () => ({ v:futureVersion }) }),
    refresh:async (options) => {
      refreshes += 1;
      assert.equal(options.candidate, candidate, 'automatic activation owns the exact detected worker');
      return { workerActivated:true };
    }
  });
  assert.equal(result.updated, true, 'a clean page automatically applies the ready release');
  assert.equal(refreshes, 1, 'automatic activation runs exactly once');
}

{
  let applies = 0;
  const shown = [];
  const handler = createUpdateReadyHandler({
    document:{ querySelectorAll:() => [{ files:[{}] }], querySelector:() => null },
    apply:async () => { applies += 1; return { updated:true }; },
    show:(info, message) => shown.push({ info, message })
  });
  const result = await handler({ worker:{ state:'installed' } });
  assert.equal(result.reason, 'blocked', 'dirty work blocks automatic activation');
  assert.equal(applies, 0, 'a blocked update has no activation side effect');
  assert.equal(shown.length, 1, 'a blocked update remains visible for manual retry');
}

{
  let resolveApply;
  let applies = 0;
  const gate = new Promise((resolve) => { resolveApply = resolve; });
  const candidate = { state:'installed' };
  const handler = createUpdateReadyHandler({
    document:{ querySelectorAll:() => [], querySelector:() => null },
    apply:async () => { applies += 1; await gate; return { updated:true }; },
    show:() => { throw new Error('successful activation must not show fallback'); }
  });
  const first = handler({ worker:candidate });
  const duplicate = handler({ worker:candidate });
  await Promise.resolve();
  assert.equal(first, duplicate, 'duplicate lifecycle events share one activation promise');
  assert.equal(applies, 1, 'duplicate lifecycle events start one activation');
  resolveApply();
  assert.equal((await first).updated, true, 'the shared activation completes successfully');
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

console.log('PWA update lifecycle: 27/27 PASS');
