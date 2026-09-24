'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServerCompletionEvent, CALLABLE_FEATURES } = require('./cost-completion-event');
const { createAttributionHasher } = require('./cost-usage-service');

const hasher = createAttributionHasher('completion-test-key-32bytes-minimum!');
const input = {
  callable: 'getStationScheduleRange',
  actor: { uid: 'private-user-17', stationId: 'eilat_102', verification: 'live' },
  invocationId: 'stable_invocation_0001',
  occurredAt: '2026-09-24T10:00:00.000Z',
  outcome: 'ok', hasher,
  payload: { medical: 'never-copy' }, token: 'never-copy'
};

test('completion event is a minimal deterministic HMAC metadata record', () => {
  const a = createServerCompletionEvent(input);
  const b = createServerCompletionEvent(input);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a), [
    'schema', 'key_version', 'event_id', 'callable', 'feature',
    'occurred_at', 'outcome', 'uid_hash', 'station_id_at_event'
  ]);
  assert.equal(a.uid_hash, hasher.hashScope(input.actor.uid));
  assert.equal(a.key_version, 'v1');
  assert.equal(a.station_id_at_event, 'eilat_102');
  assert.ok(!JSON.stringify(a).includes(input.actor.uid));
  assert.ok(!JSON.stringify(a).includes('never-copy'));
  assert.equal(CALLABLE_FEATURES.getStationScheduleRange, 'schedule_range_read');
});

test('unknown callables, unverified station, invalid invocation and unkeyed events fail closed', () => {
  for (const patch of [
    { callable: 'sendCallout' },
    { actor: { uid: 'private-user-17', stationId: 'eilat_102' } },
    { actor: { uid: 'private-user-17', stationId: 'x/other', verification: 'live' } },
    { invocationId: 'short' },
    { outcome: 'permission-denied: user medical note' },
    { hasher: createAttributionHasher('') },
    { occurredAt: 'not-a-date' }
  ]) {
    assert.throws(() => createServerCompletionEvent({ ...input, ...patch }), TypeError);
  }
});

test('a different invocation produces a different replay id, never a client request id', () => {
  const first = createServerCompletionEvent(input);
  const second = createServerCompletionEvent({ ...input, invocationId: 'stable_invocation_0002' });
  assert.notEqual(first.event_id, second.event_id);
  assert.match(first.event_id, /^[a-f0-9]{64}$/);
});

test('provisioned station IDs with hyphens or leading digits remain measurable', () => {
  for (const stationId of ['station-102', '1_station']) {
    const event = createServerCompletionEvent({ ...input, actor: { ...input.actor, stationId } });
    assert.equal(event.station_id_at_event, stationId);
  }
});
