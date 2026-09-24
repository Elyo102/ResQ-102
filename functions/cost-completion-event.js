'use strict';

// Candidate contract only. No callable emits these events yet, and this file
// does not make the dashboard feeder live. The eventual emitter must receive
// a live-verified actor from the business operation, never from request data.
const CALLABLE_FEATURES = Object.freeze({
  getStationScheduleRange: 'schedule_range_read',
  getMyAttendanceMonth: 'attendance_month_read',
  listHrRequestsInbox: 'hr_inbox_read'
});
const STATION_RE = /^[a-z][a-z0-9_]{1,63}$/;
const INVOCATION_RE = /^[A-Za-z0-9_-]{16,128}$/;

function createServerCompletionEvent({ callable, actor, invocationId, occurredAt, outcome, hasher }) {
  if (!Object.hasOwn(CALLABLE_FEATURES, callable)) throw new TypeError('callable is not in the measured allowlist');
  if (!actor || actor.verification !== 'live' || typeof actor.uid !== 'string' || !actor.uid
      || !STATION_RE.test(actor.stationId || '')) {
    throw new TypeError('a live-verified uid and station snapshot are required');
  }
  if (!INVOCATION_RE.test(invocationId || '')) throw new TypeError('a stable invocation id is required');
  if (outcome !== 'ok' && outcome !== 'failed') throw new TypeError('outcome is not allowed');
  const date = new Date(occurredAt);
  if (!Number.isFinite(date.getTime())) throw new TypeError('occurredAt is invalid');
  if (!hasher || hasher.ready !== true
      || typeof hasher.hashScope !== 'function' || typeof hasher.hashEvent !== 'function') {
    throw new TypeError('versioned HMAC is required');
  }
  // Only this exact metadata shape may leave the source. No names, medical
  // details, request payload, tokens or raw UID are copied into the event.
  return Object.freeze({
    schema: 'resq_server_completion_v1',
    key_version: 'v1',
    event_id: hasher.hashEvent(callable + ':' + invocationId),
    callable,
    feature: CALLABLE_FEATURES[callable],
    occurred_at: date.toISOString(),
    outcome,
    uid_hash: hasher.hashScope(actor.uid),
    station_id_at_event: actor.stationId
  });
}

module.exports = Object.freeze({ createServerCompletionEvent, CALLABLE_FEATURES });
