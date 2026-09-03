'use strict';

// Server-owned finite vocabulary. Unknown client values never become stored
// strings. In particular an error message, stack, URL, UID or free-form code
// cannot be smuggled through a field that merely passes a regular expression.
const KINDS = Object.freeze(['client-error', 'unhandled-rejection', 'callable-failed', 'manual']);
const SCREENS = Object.freeze([
  'unknown', 'index.html', 'import.html', 'guards.html', 'vehicle.html',
  'unlock.html', 'attendance.html', 'schedule-management.html', 'attendance-shadow.html',
  'alerts.html', 'admin.html', 'access.html', 'faults.html', 'check.html', 'board.html',
  'feedback.html', 'forms.html', 'sign.html', 'schedule.html', 'stats.html',
  'swaps.html', 'people.html', 'login.html', 'quals.html'
]);
const VERSIONS = Object.freeze(['unknown', '42G.0']);
const CODES = Object.freeze([
  'unknown', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
  'URIError', 'EvalError', 'AggregateError',
  ...['cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found',
    'already-exists', 'permission-denied', 'resource-exhausted', 'failed-precondition',
    'aborted', 'out-of-range', 'unimplemented', 'internal', 'unavailable',
    'data-loss', 'unauthenticated'].map((code) => 'functions/' + code)
]);
const CALLABLES = Object.freeze(['unknown', 'submitFeedback', 'reportIncident']);
const INPUT_FIELDS = Object.freeze(['kind', 'screen', 'version', 'code', 'callable']);
const STATUSES = Object.freeze(['open', 'resolved', 'ignored']);
const OPERATOR_LABELS = Object.freeze(['operator', 'codex', 'claude']);
const NOTE_CODES = Object.freeze(['none', 'fixed', 'duplicate', 'not-reproducible', 'expected', 'monitoring']);

function finite(value, values) {
  return typeof value === 'string' && values.includes(value) ? value : 'unknown';
}
function normalizeTelemetry(data) {
  return Object.freeze({
    kind: finite(data.kind, KINDS), screen: finite(data.screen, SCREENS),
    version: finite(data.version, VERSIONS), code: finite(data.code, CODES),
    callable: finite(data.callable, CALLABLES)
  });
}

module.exports = Object.freeze({
  KINDS, SCREENS, VERSIONS, CODES, CALLABLES, INPUT_FIELDS,
  STATUSES, OPERATOR_LABELS, NOTE_CODES, finite, normalizeTelemetry
});
