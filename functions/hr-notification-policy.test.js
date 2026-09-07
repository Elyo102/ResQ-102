'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideNotification: decide, notificationIntent: intent, HrPolicyInputError } = require('./hr-notification-policy');
const at = value => Date.parse(value);
const input = (patch = {}) => ({ now_ms: at('2026-09-07T12:00:00Z'), mode: 'manual', silent: 'off', ...patch });
const event = (patch = {}) => ({ station_id: 'test-station', recipient_uid: 'employee.01', event_id: 'request-abc', type: 'hr_document', ...patch });
const rejects = (fn, code) => assert.throws(fn, e => e instanceof HrPolicyInputError && e.code === code);

test('daytime manual action queues intent, never delivered claim', () => {
  assert.deepEqual(decide(input()), { decision: 'queue', reason: 'routine', not_before_ms: null, delivery_status: 'intent_only' });
});
for (const mode of ['manual', 'automatic', 'operational']) {
  test(mode + ' cannot override system silent', () => assert.equal(decide(input({ mode, silent: 'on', send_now: true })).decision, 'suppressed'));
  test(mode + ' cannot override unknown silent state', () => assert.equal(decide(input({ mode, silent: 'unknown', silent_allow: true, send_now: true })).decision, 'blocked'));
}
test('verified per-recipient allow remains usable in silent mode', () => assert.equal(decide(input({ silent: 'on', silent_allow: true })).decision, 'queue'));
test('22:00 inclusive automatic deferred to local07:00', () => {
  const value = decide(input({ mode: 'automatic', now_ms: at('2026-09-07T19:00:00Z') }));
  assert.equal(value.decision, 'defer'); assert.equal(value.not_before_ms, at('2026-09-08T04:00:00Z'));
});
test('21:59 remains available', () => assert.equal(decide(input({ mode: 'automatic', now_ms: at('2026-09-07T18:59:59Z') })).decision, 'queue'));
test('06:59 quiet but07:00 not quiet', () => {
  assert.equal(decide(input({ mode: 'automatic', now_ms: at('2026-09-07T03:59:59Z') })).decision, 'defer');
  assert.equal(decide(input({ mode: 'automatic', now_ms: at('2026-09-07T04:00:00Z') })).decision, 'queue');
});
test('manual nighttime requires warning confirmation', () => {
  const now_ms = at('2026-09-07T20:00:00Z');
  assert.equal(decide(input({ now_ms })).decision, 'confirmation_required');
  assert.equal(decide(input({ now_ms, send_now: true })).decision, 'queue');
});
test('operational urgency immediate only after silent check', () => {
  assert.equal(decide(input({ mode: 'operational', now_ms: at('2026-09-07T20:00:00Z') })).decision, 'queue');
});
test('Israel spring DST morning is04:00UTC, not old offset', () => {
  const value = decide(input({ mode: 'automatic', now_ms: at('2026-03-26T23:30:00Z') }));
  assert.equal(value.not_before_ms, at('2026-03-27T04:00:00Z'));
});
test('Israel autumn DST morning is05:00UTC, not old offset', () => {
  const value = decide(input({ mode: 'automatic', now_ms: at('2026-10-24T22:30:00Z') }));
  assert.equal(value.not_before_ms, at('2026-10-25T05:00:00Z'));
});
test('one automatic reminder per Jerusalem day, not UTC date', () => {
  assert.equal(decide(input({ mode: 'automatic', now_ms: at('2026-09-08T04:00:00Z'),
    last_reminder_at_ms: at('2026-09-07T21:30:00Z') })).reason, 'already-reminded-today');
});
test('previous local day does not block today', () => {
  assert.equal(decide(input({ mode: 'automatic', now_ms: at('2026-09-08T04:00:00Z'),
    last_reminder_at_ms: at('2026-09-07T20:30:00Z') })).decision, 'queue');
});
test('manual nudges not silently throttled by auto reminder policy', () => {
  assert.equal(decide(input({ last_reminder_at_ms: at('2026-09-07T11:00:00Z') })).decision, 'queue');
});
test('bad clock and future reminder fail closed', () => {
  rejects(() => decide(input({ now_ms: NaN })), 'invalid-instant');
  rejects(() => decide(input({ mode: 'automatic', last_reminder_at_ms: at('2026-09-08T11:00:00Z') })), 'future-reminder');
});
test('unknown policy values not truthy authority', () => {
  rejects(() => decide(input({ silent: false })), 'invalid-silent-state');
  rejects(() => decide(input({ silent_allow: 'true' })), 'invalid-silent-allow');
  rejects(() => decide(input({ mode: 'super_admin' })), 'invalid-mode');
});
test('identical retry yields same intent; changes and channels remain distinct', () => {
  assert.equal(intent(event()).id, intent(event()).id);
  for (const patch of [{ recipient_uid: 'employee.02' }, { station_id: 'other' },
    { type: 'hr_message' }, { event_id: 'next-action' }]) assert.notEqual(intent(event(patch)).id, intent(event()).id);
});
test('no arbitrary HR sensitive text in push content', () => {
  const value = intent(event({ full_name: 'PERSONAL', body: 'MEDICAL', title: 'PAYROLL' }));
  assert.ok(!JSON.stringify(value).includes('PERSONAL')); assert.ok(!JSON.stringify(value).includes('MEDICAL'));
  assert.ok(!JSON.stringify(value).includes('PAYROLL')); assert.equal(value.delivery_status, 'intent_only');
});
test('reserved type is not a notification type', () => rejects(() => intent(event({ type: '__proto__' })), 'invalid-notification-type'));
test('coercible notification types cannot carry hidden data', () => {
  rejects(() => intent(event({ type: ['hr_document'] })), 'invalid-notification-type');
  rejects(() => intent(event({ type: { private: 'MEDICAL', toString: () => 'hr_document' } })), 'invalid-notification-type');
});
test('delimiter characters cannot cross station paths', () => rejects(() => intent(event({ recipient_uid: '../other' })), 'invalid-intent-identity'));
