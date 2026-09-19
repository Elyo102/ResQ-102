// משדר המדדים בצד הלקוח — בדיקות יחידה בלי דפדפן: טיימרים מדומים, callable מדומה.
import assert from 'node:assert/strict';
import { createMetricsRecorder, buildEvent, bucketOf, newRequestId, METRICS_EVENT_CODES, METRICS_MAX_BATCH } from '../metrics-client.js';

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('PASS ' + name); }

function fakeTimers() {
  const timers = new Map(); let id = 0;
  return {
    setTimeout: (fn, ms) => { id += 1; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (t) => { timers.delete(t); },
    fire: async () => { const list = [...timers.entries()]; timers.clear(); for (const [, t] of list) await t.fn(); },
    pending: () => timers.size
  };
}
function harness(over) {
  const o = over || {};
  const calls = []; let signedIn = o.signedIn !== false; let fail = false;
  const timers = fakeTimers();
  const recorder = createMetricsRecorder({
    callable: async (payload) => { calls.push(JSON.parse(JSON.stringify(payload))); if (fail) throw new Error('offline'); return { ok: true }; },
    release: o.release === undefined ? '42H.20' : o.release, screen: o.screen === undefined ? 'login.html' : o.screen,
    isSignedIn: () => signedIn, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    random: o.random
  });
  return { recorder, calls, timers, setSignedIn: (v) => { signedIn = v; }, setFail: (v) => { fail = v; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

await check('buildEvent emits only the five closed fields, buckets rounded up, unknown code dropped', async () => {
  const e = buildEvent('login_success', { result: 'ok', duration_ms: 101, extra: 'x' }, { release: '42H.20', screen: 'login.html' });
  assert.deepEqual(Object.assign({}, e), { event_code: 'login_success', result: 'ok', duration_bucket_ms: 250, release: '42H.20', screen: 'login.html' });
  assert.equal(buildEvent('user_named_x', {}, {}), null);
  assert.equal(buildEvent('push_failed', { result: 'maybe' }, {}).result, 'ok');
  assert.equal('duration_bucket_ms' in buildEvent('push_failed', { duration_ms: -1 }, {}), false);
  assert.equal('release' in buildEvent('push_failed', {}, { release: 'me@x' }), false);
  assert.equal('screen' in buildEvent('push_failed', {}, { screen: 'http://x' }), false);
  assert.equal(bucketOf(30001), 30000); assert.equal(bucketOf(0), 0);
  assert.equal(METRICS_EVENT_CODES.length, 15);
});
await check('request ids are rd_ + 40 hex, one per flush', async () => {
  assert.match(newRequestId(), /^rd_[a-f0-9]{40}$/);
  assert.notEqual(newRequestId(), newRequestId());
  assert.equal(newRequestId(() => 'z'.repeat(40)).slice(3).length, 40);
});
await check('nothing is sent when signed out; buffered events are dropped, not held', async () => {
  const h = harness({ signedIn: false });
  assert.equal(h.recorder.record('login_success', { duration_ms: 10 }), false);
  assert.equal(h.recorder.pending(), 0);
  await h.recorder.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.recorder.stats().dropped, 1);
});
await check('buffer flushes after the 10 second timer with a single request id', async () => {
  const h = harness();
  h.recorder.record('login_success', { duration_ms: 10 });
  h.recorder.record('push_delivered', {});
  assert.equal(h.recorder.pending(), 2); assert.equal(h.timers.pending(), 1);
  await h.timers.fire(); await tick();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].request_id, /^rd_[a-f0-9]{40}$/);
  assert.equal(h.calls[0].events.length, 2);
  assert.deepEqual(Object.keys(h.calls[0]), ['request_id', 'events']);
  assert.equal(h.recorder.pending(), 0);
});
await check('a full buffer (20) flushes immediately and the 21st starts a new batch', async () => {
  const h = harness();
  for (let i = 0; i < METRICS_MAX_BATCH + 1; i++) h.recorder.record('client_error', { result: 'fail' });
  await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].events.length, 20);
  assert.equal(h.recorder.pending(), 1);
});
await check('visibilitychange hidden and pagehide flush; distinct flushes get distinct ids', async () => {
  const h = harness();
  const listeners = {}; const docListeners = {};
  const doc = { visibilityState: 'visible', addEventListener: (n, fn) => { docListeners[n] = fn; } };
  const win = { document: doc, addEventListener: (n, fn) => { listeners[n] = fn; } };
  assert.equal(h.recorder.install(win), true);
  assert.equal(h.recorder.install(win), false);
  h.recorder.record('login_failure', { result: 'fail' });
  doc.visibilityState = 'hidden'; docListeners.visibilitychange(); await tick();
  h.recorder.record('callout_started', {});
  listeners.pagehide(); await tick();
  assert.equal(h.calls.length, 2);
  assert.notEqual(h.calls[0].request_id, h.calls[1].request_id);
  assert.equal(h.timers.pending(), 0, 'timer cleared after event flush');
});
await check('callable failure drops the batch quietly and never throws', async () => {
  const h = harness();
  h.setFail(true);
  h.recorder.record('login_success', {});
  await h.recorder.flush();
  assert.equal(h.recorder.stats().failed, 1); assert.equal(h.recorder.stats().dropped, 1);
  assert.equal(h.recorder.pending(), 0);
});
await check('payload never carries anything beyond the catalog fields', async () => {
  const h = harness({ release: 'bad release with spaces', screen: 'x' });
  h.recorder.record('onboarding_completed', { result: 'ok', duration_ms: 5, name: 'x', email: 'a@b', uid: 'u' });
  await h.recorder.flush();
  const e = h.calls[0].events[0];
  assert.deepEqual(Object.keys(e).sort(), ['duration_bucket_ms', 'event_code', 'result']);
  assert.ok(!JSON.stringify(h.calls[0]).includes('a@b'));
});
console.log('\nMetrics client: ' + passed + ' PASS.');
