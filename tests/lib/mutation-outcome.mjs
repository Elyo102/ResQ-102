// This consumes events from the trusted suite adapter, not arbitrary child text.
// The adapter must reject unparsed failures; exit status alone is never evidence.
const result = (kind, reason) => Object.freeze({ kind, reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;
export function parseAssertionId(id, suite) {
  if (!text(id, 4096)) return null;
  try {
    const parts = JSON.parse(id);
    if (!Array.isArray(parts) || parts.length !== 4 || JSON.stringify(parts) !== id || parts[0] !== suite
        || typeof parts[1] !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(parts[1])
        || !text(parts[2], 64) || !/^[A-Za-z][A-Za-z0-9]*(?![\s\S])/.test(parts[2])
        || !text(parts[3], 1024)) return null;
    return parts;
  } catch (_) { return null; }
}

/**
 * expected: {suite, allowed:[IDs], required:[IDs]} -- independently approved sets.
 * input: raw process {status,signal,error,stderr}, ordered events, and optionally
 * cleanupError/adapterError. invalidMutant:{code} is pre-execution evidence only.
 * Events: module-loaded, suite-start, assertion-failure*, suite-end.
 * Empty allowed assertions are baseline-only and never yield KILLED.
 */
export function classifyMutationOutcome(input, expected) {
  const bad = reason => result('HARNESS_ERROR', reason);
  if (!keys(expected, ['suite', 'allowed', 'required']) || !text(expected.suite, 1024)) return bad('INVALID_EXPECTATION');
  for (const list of [expected.allowed, expected.required]) {
    if (!Array.isArray(list) || list.length > 256 || new Set(list).size !== list.length
        || !list.every(id => parseAssertionId(id, expected.suite))) return bad('INVALID_EXPECTATION');
  }
  const allowed = new Set(expected.allowed);
  if (!expected.required.every(id => allowed.has(id))) return bad('REQUIRED_NOT_ALLOWED');
  if (!object(input) || !Array.isArray(input.events)) return bad('INVALID_RESULT');
  if (input.error || input.signal || input.cleanupError || input.adapterError) return bad('INFRASTRUCTURE_FAILURE');
  if (input.stderr !== undefined && input.stderr !== null && input.stderr !== '') return bad('UNEXPECTED_STDERR');
  if (input.invalidMutant !== undefined) {
    if (!keys(input.invalidMutant, ['code']) || !text(input.invalidMutant.code, 128)
        || input.status !== null || input.events.length !== 0
        || (input.stdout !== undefined && input.stdout !== '')) return bad('INVALID_PREEXECUTION_EVIDENCE');
    return result('INVALID_MUTANT', 'PREEXECUTION_VALIDATION_FAILED');
  }
  if (![0, 1].includes(input.status)) return bad('UNEXPECTED_EXIT');
  const events = input.events;
  if (events.length < 3 || events.length > 259) return bad('INCOMPLETE_OR_EXCESS_EVENTS');
  const marker = (event, type) => keys(event, ['type', 'suite'])
    && event.type === type && event.suite === expected.suite;
  if (!marker(events[0], 'module-loaded') || !marker(events[1], 'suite-start')) return bad('START_MARKERS');
  const end = events.at(-1);
  if (!keys(end, ['type', 'suite', 'failed']) || end.type !== 'suite-end'
      || end.suite !== expected.suite || !Number.isInteger(end.failed) || end.failed < 0) return bad('END_MARKER');
  const failures = events.slice(2, -1);
  for (const event of failures) {
    const id = parseAssertionId(event?.id, expected.suite);
    if (!keys(event, ['type', 'suite', 'id', 'code', 'detail'])
        || event.type !== 'assertion-failure' || event.suite !== expected.suite
        || event.code !== 'ERR_ASSERTION' || !id || event.detail !== id[2]) return bad('UNEXPECTED_EVENT');
  }
  if (end.failed !== failures.length) return bad('FAILURE_COUNT');
  if (new Set(failures.map(item => item.id)).size !== failures.length) return bad('DUPLICATE_FAILURE');
  if (input.status === 0) return failures.length === 0
    ? result('SURVIVED', 'COMPLETED_WITHOUT_FAILURE') : bad('EXIT_FAILURE_MISMATCH');
  const actual = new Set(failures.map(event => event.id));
  if (!actual.size || !allowed.size || [...actual].some(id => !allowed.has(id))
      || expected.required.some(id => !actual.has(id))) return bad('UNEXPECTED_FAILURE_SET');
  return result('KILLED', 'APPROVED_ASSERTION_SITES');
}
