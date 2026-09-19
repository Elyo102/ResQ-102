'use strict';
/* קטלוג המדדים — בדיקות יחידה. */
const assert = require('node:assert/strict');
const catalog = require('./metrics-catalog');
const telemetry = require('./ops-telemetry-contract');

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }
function throwsReason(fn, reason) {
  let caught = null; try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, 'expected throw ' + reason);
  assert.equal(caught.name, 'MetricsCatalogError');
  assert.equal(caught.reason, reason, 'reason ' + caught.reason + ' expected ' + reason + ' (' + caught.message + ')');
}

check('exactly fifteen frozen event codes in the mandated order', () => {
  assert.ok(Object.isFrozen(catalog.EVENT_CODES));
  assert.deepEqual([...catalog.EVENT_CODES], ['login_success', 'login_failure', 'onboarding_started', 'onboarding_completed',
    'device_readiness_started', 'device_readiness_completed', 'push_queued', 'push_delivered', 'push_failed',
    'schedule_import_started', 'schedule_import_completed', 'schedule_publish_completed', 'callout_started', 'callout_closed', 'client_error']);
  assert.equal(catalog.EVENT_CODES.length, 15);
});
check('results and fields are the closed sets', () => {
  assert.deepEqual([...catalog.RESULTS], ['ok', 'fail']);
  assert.deepEqual([...catalog.FIELDS], ['event_code', 'result', 'duration_bucket_ms', 'release', 'screen']);
  assert.deepEqual([...catalog.DURATION_BUCKETS_MS], [0, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]);
});
check('versions and screens are the telemetry contract objects, not copies', () => {
  assert.equal(catalog.VERSIONS, telemetry.VERSIONS);
  assert.equal(catalog.SCREENS, telemetry.SCREENS);
});
check('buckets round up, never raw', () => {
  assert.equal(catalog.bucketOf(0), 0);
  assert.equal(catalog.bucketOf(1), 100);
  assert.equal(catalog.bucketOf(100), 100);
  assert.equal(catalog.bucketOf(101), 250);
  assert.equal(catalog.bucketOf(2501), 5000);
  assert.equal(catalog.bucketOf(29999.5), 30000);
  assert.equal(catalog.bucketOf(999999), 30000);
  assert.equal(catalog.bucketOf(-1), null);
  assert.equal(catalog.bucketOf('12'), null);
  assert.equal(catalog.bucketOf(NaN), null);
});
check('normalizeEvent produces the five closed fields with unknown fallbacks', () => {
  const e = catalog.normalizeEvent({ event_code: 'push_delivered', result: 'ok', duration_bucket_ms: 130, release: '42H.20', screen: 'alerts.html' });
  assert.deepEqual(Object.assign({}, e), { event_code: 'push_delivered', result: 'ok', duration_bucket_ms: 250, release: '42H.20', screen: 'alerts.html' });
  const f = catalog.normalizeEvent({ event_code: 'client_error', release: '99.9', screen: 'evil.html' });
  assert.deepEqual(Object.assign({}, f), { event_code: 'client_error', result: 'ok', duration_bucket_ms: null, release: 'unknown', screen: 'unknown' });
});
check('unknown event code is rejected with reason event-code', () => {
  throwsReason(() => catalog.normalizeEvent({ event_code: 'user_signed_in' }), 'event-code');
  throwsReason(() => catalog.normalizeEvent({ event_code: '' }), 'event-code');
});
check('extra field rejects the event with reason input', () => {
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', note: 'x' }), 'input');
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', email: 'a' }), 'input');
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', station_id: 'eilat' }), 'input');
});
check('bad result, bad duration, non-object are input errors', () => {
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', result: 'maybe' }), 'input');
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', duration_bucket_ms: '100' }), 'input');
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', duration_bucket_ms: -5 }), 'input');
  throwsReason(() => catalog.normalizeEvent(null), 'input');
  throwsReason(() => catalog.normalizeEvent(['login_success']), 'input');
});
check('assertNoPii rejects long strings, @, six digits, http, ?, Hebrew in any field', () => {
  throwsReason(() => catalog.assertNoPii({ release: 'x'.repeat(33) }), 'pii');
  throwsReason(() => catalog.assertNoPii({ release: 'a@b' }), 'pii');
  throwsReason(() => catalog.assertNoPii({ screen: '0501234' }), 'pii');
  throwsReason(() => catalog.assertNoPii({ screen: 'http-x' }), 'pii');
  throwsReason(() => catalog.assertNoPii({ screen: 'a?b' }), 'pii');
  throwsReason(() => catalog.assertNoPii({ release: 'שלום' }), 'pii');
  throwsReason(() => catalog.assertNoPii({ event_code: { nested: true } }), 'input');
  throwsReason(() => catalog.assertNoPii({ name: 'x' }), 'input');
  assert.equal(catalog.assertNoPii({ event_code: 'login_success', release: '42H.20', duration_bucket_ms: 12 }), true);
});
check('PII-like value in an enum field is rejected before the enum fallback can hide it', () => {
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', screen: 'user@example.test' }), 'pii');
  throwsReason(() => catalog.normalizeEvent({ event_code: 'login_success', release: 'https://x' }), 'pii');
});
check('forbidden field names cover identity, secrets, free text and navigation', () => {
  for (const k of ['name', 'email', 'phone', 'employee_number', 'uid', 'push_token', 'message', 'medical', 'form', 'stack', 'url', 'query']) {
    assert.ok(catalog.FORBIDDEN_FIELD_NAMES.includes(k), k);
  }
  assert.ok(Object.isFrozen(catalog));
});
console.log('\nMetrics catalog: ' + passed + ' PASS.');
