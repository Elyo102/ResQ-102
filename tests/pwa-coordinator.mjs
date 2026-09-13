import assert from 'node:assert/strict';

const { createPwaUpdateCoordinator } = await import('../pwa.js');

assert.equal(typeof createPwaUpdateCoordinator, 'function',
  'pwa.js exports createPwaUpdateCoordinator(options)');

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    if (!listeners.includes(listener)) listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type,
      (this.listeners.get(type) || []).filter((item) => item !== listener));
  }
  async emit(type, event = {}) {
    const listeners = [...(this.listeners.get(type) || [])];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
  listenerCount(type) { return (this.listeners.get(type) || []).length; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function fixture(options = {}) {
  let time = options.time ?? 1_000;
  const serviceWorker = new Events();
  serviceWorker.controller = options.controller === undefined
    ? { id:'old-controller' }
    : options.controller;

  const registration = new Events();
  registration.waiting = options.waiting || null;
  registration.installing = options.installing || null;
  registration.active = serviceWorker.controller;
  registration.updateCalls = 0;
  registration.update = options.update || (async () => {
    registration.updateCalls += 1;
  });
  serviceWorker.getRegistration = async () => registration;

  const windowLike = new Events();
  const replacements = [];
  windowLike.location = {
    href:'https://station-102.web.app/login.html',
    replace(url) { replacements.push(url); }
  };

  const documentLike = new Events();
  documentLike.visibilityState = options.visibilityState || 'visible';

  const ready = [];
  const coordinator = createPwaUpdateCoordinator({
    serviceWorker,
    window:windowLike,
    document:documentLike,
    now:() => time,
    intervalMs:options.updateIntervalMs ?? 1_000,
    retryMs:options.failedUpdateBackoffMs ?? 1_000,
    onReady:(detail) => ready.push(detail)
  });

  return {
    coordinator, serviceWorker, registration, windowLike, documentLike,
    ready, replacements,
    advance(ms) { time += ms; }
  };
}

function worker(state = 'installed') {
  const item = new Events();
  item.state = state;
  return item;
}

async function check(name, run) {
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name);
    throw error;
  }
}

await check('waiting worker present before start is reported once', async () => {
  const waiting = worker();
  const f = fixture({ waiting });
  f.coordinator.start(f.registration);
  await settle();
  assert.equal(f.ready.length, 1);
  assert.equal(f.ready[0]?.registration, f.registration);
  assert.equal(f.ready[0]?.reason, 'waiting');
  assert.equal(f.replacements.length, 0, 'detection never reloads the page');
  f.coordinator.stop();
});

await check('updatefound reports the installing worker only after installed', async () => {
  const f = fixture();
  f.coordinator.start(f.registration);
  const installing = worker('installing');
  f.registration.installing = installing;
  await f.registration.emit('updatefound');
  assert.equal(f.ready.length, 0, 'installing is not ready');
  installing.state = 'installed';
  await installing.emit('statechange');
  assert.equal(f.ready.length, 1);
  assert.equal(f.ready[0]?.registration, f.registration);
  assert.equal(f.ready[0]?.reason, 'installed');
  await installing.emit('statechange');
  assert.equal(f.ready.length, 1, 'duplicate statechange is idempotent');
  f.coordinator.stop();
});

await check('controllerchange with an existing controller marks ready without reload', async () => {
  const f = fixture();
  f.coordinator.start(f.registration);
  f.serviceWorker.controller = { id:'new-controller' };
  await f.serviceWorker.emit('controllerchange');
  assert.equal(f.ready.length, 1);
  assert.equal(f.ready[0]?.reason, 'controllerchange');
  assert.equal(f.replacements.length, 0,
    'controller change must not destroy unsaved user work');
  f.coordinator.stop();
});

await check('first service-worker installation is not announced as an update', async () => {
  const f = fixture({ controller:null });
  f.coordinator.start(f.registration);
  f.serviceWorker.controller = { id:'first-controller' };
  await f.serviceWorker.emit('controllerchange');
  assert.equal(f.ready.length, 0);
  assert.equal(f.replacements.length, 0);
  f.coordinator.stop();
});

await check('start is idempotent for one coordinator instance', async () => {
  const f = fixture();
  f.coordinator.start(f.registration);
  f.coordinator.start(f.registration);
  assert.equal(f.serviceWorker.listenerCount('controllerchange'), 1);
  assert.equal(f.registration.listenerCount('updatefound'), 1);
  assert.equal(f.windowLike.listenerCount('pageshow'), 1);
  assert.equal(f.documentLike.listenerCount('visibilitychange'), 1);
  f.coordinator.stop();
});

await check('pageshow and visible return share one throttled in-flight update', async () => {
  const gate = deferred();
  const f = fixture({
    updateIntervalMs:300,
    update:async () => {
      f.registration.updateCalls += 1;
      await gate.promise;
    }
  });
  f.coordinator.start(f.registration);
  f.advance(301);
  const pageShow = f.windowLike.emit('pageshow', { persisted:true });
  const visible = f.documentLike.emit('visibilitychange');
  await settle();
  assert.equal(f.registration.updateCalls, 1, 'only one update is in flight');
  gate.resolve();
  await Promise.all([pageShow, visible]);

  await f.windowLike.emit('pageshow', { persisted:true });
  await f.documentLike.emit('visibilitychange');
  assert.equal(f.registration.updateCalls, 1, 'events inside interval are throttled');
  f.coordinator.stop();
});

await check('failed update is retried only after the longer failure backoff', async () => {
  const f = fixture({
    updateIntervalMs:100,
    failedUpdateBackoffMs:1_000,
    update:async () => {
      f.registration.updateCalls += 1;
      throw new Error('offline');
    }
  });
  f.coordinator.start(f.registration);
  await settle();
  assert.equal(f.registration.updateCalls, 1);

  f.advance(500);
  await f.windowLike.emit('pageshow', { persisted:true });
  assert.equal(f.registration.updateCalls, 1, 'failure backoff blocks retry storms');

  f.advance(501);
  await f.windowLike.emit('pageshow', { persisted:true });
  assert.equal(f.registration.updateCalls, 2, 'retry resumes after failure backoff');
  assert.equal(f.ready.length, 0);
  assert.equal(f.replacements.length, 0);
  f.coordinator.stop();
});

await check('hidden visibility event does not check and stop removes every listener', async () => {
  const f = fixture();
  f.coordinator.start(f.registration);
  await settle();
  const installing = worker('installing');
  f.registration.installing = installing;
  await f.registration.emit('updatefound');
  assert.equal(installing.listenerCount('statechange'), 1);
  f.advance(301);
  f.documentLike.visibilityState = 'hidden';
  await f.documentLike.emit('visibilitychange');
  assert.equal(f.registration.updateCalls, 1,
    'hidden visibility does not add a check after the initial check');

  f.coordinator.stop();
  assert.equal(f.serviceWorker.listenerCount('controllerchange'), 0);
  assert.equal(f.registration.listenerCount('updatefound'), 0);
  assert.equal(installing.listenerCount('statechange'), 0);
  assert.equal(f.windowLike.listenerCount('pageshow'), 0);
  assert.equal(f.documentLike.listenerCount('visibilitychange'), 0);

  f.documentLike.visibilityState = 'visible';
  await f.windowLike.emit('pageshow', { persisted:true });
  await f.documentLike.emit('visibilitychange');
  await f.serviceWorker.emit('controllerchange');
  assert.equal(f.registration.updateCalls, 1);
  assert.equal(f.ready.length, 0);
});

console.log('PWA update coordinator: 8/8 PASS');
