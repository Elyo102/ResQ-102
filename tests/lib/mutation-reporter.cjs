'use strict';
const assert = require('node:assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const PREFIX = 'RESQ_MUTATION_EVENT ';
const SUITES = new Set(['functions/schedule-calendar-engine.test.js', 'functions/schedule-publication.test.js',
  'functions/schedule-service.integration.test.js', 'tests/schedule-calendar-source.mjs']);
const OPERATORS = Object.freeze({ assert: '==', ok: '==', equal: '==', notEqual: '!=', fail: 'fail',
  strictEqual: 'strictEqual', deepEqual: 'deepEqual', deepStrictEqual: 'deepStrictEqual',
  match: 'match', doesNotThrow: 'doesNotThrow' });
const hash = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const exactKeys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(value);
const failure = code => ({ type: 'harness-error', code });
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
// This child-side operation does not read files or emit raw paths/messages.
function observeAssertion(error, suite, filename, testName) {
  if (!(error instanceof assert.AssertionError) || error.code !== 'ERR_ASSERTION') return failure('NON_ASSERTION_FAILURE');
  if (!SUITES.has(suite) || typeof filename !== 'string' || !validName(testName)) return failure('INVALID_TEST_ID');
  if (!Object.values(OPERATORS).includes(error.operator)) return failure('UNSUPPORTED_ASSERTION_OPERATOR');
  if (typeof error.stack !== 'string' || error.stack.length > 65536) return failure('MALFORMED_STACK');
  let frame = null;
  for (const raw of error.stack.split('\n').slice(1)) {
    let location = raw.trim();
    if (!location.startsWith('at ')) continue;
    location = location.slice(3);
    if (location.endsWith(')')) location = location.slice(location.lastIndexOf('(') + 1, -1);
    const match = /^(.*):([0-9]+):([0-9]+)(?![\s\S])/.exec(location);
    if (!match) continue;
    let file = match[1];
    if (file.startsWith('file:')) { try { file = fileURLToPath(file); } catch (_) { return failure('MALFORMED_STACK'); } }
    if (file !== filename) continue;
    frame = { line: Number(match[2]), column: Number(match[3]) - 1 }; break;
  }
  if (!frame || !Number.isSafeInteger(frame.line) || !Number.isSafeInteger(frame.column)
      || frame.line < 1 || frame.column < 0) return failure('MISSING_SUITE_FRAME');
  return { type: 'assertion-observation', suite, testName, code: 'ERR_ASSERTION',
    operator: error.operator, line: frame.line, column: frame.column };
}
// Parent-only mapping: context bytes/index come from the frozen manifest.
// Call only after the parent validates the observation's nonce envelope.
function mapAssertionObservation(observation, context) {
  const { suite, source, index } = context;
  if (!exactKeys(observation, ['type', 'suite', 'testName', 'code', 'operator', 'line', 'column'])
      || observation.type !== 'assertion-observation' || observation.suite !== suite
      || observation.code !== 'ERR_ASSERTION' || !validName(observation.testName)
      || !Number.isSafeInteger(observation.line) || !Number.isSafeInteger(observation.column)
      || observation.line < 1 || observation.column < 0) return failure('INVALID_OBSERVATION');
  if (!SUITES.has(suite) || typeof source !== 'string'
      || !exactKeys(index, ['schema', 'suites']) || index.schema !== 1 || !index.suites
      || !Object.hasOwn(index.suites, suite)) return failure('INVALID_SITE_INDEX');
  const entry = index.suites[suite];
  if (!exactKeys(entry, ['sourceHash', 'sites']) || !digest(entry.sourceHash)
      || entry.sourceHash !== hash(source) || !Array.isArray(entry.sites) || entry.sites.length > 10000) return failure('SITE_SOURCE_MISMATCH');
  for (const site of entry.sites) {
    if (!exactKeys(site, ['hash', 'operator', 'line', 'column', 'endLine', 'endColumn'])
        || !digest(site.hash) || !Object.hasOwn(OPERATORS, site.operator)
        || ![site.line, site.column, site.endLine, site.endColumn].every(Number.isSafeInteger)
        || site.line < 1 || site.column < 0 || site.endLine < site.line || site.endColumn < 0
        || (site.line === site.endLine && site.endColumn <= site.column)) return failure('INVALID_SITE_INDEX');
  }
  const matches = entry.sites.filter(site =>
    (observation.line > site.line || (observation.line === site.line && observation.column >= site.column))
    && (observation.line < site.endLine || (observation.line === site.endLine && observation.column < site.endColumn)));
  if (matches.length !== 1) return failure('AMBIGUOUS_OR_WRONG_SITE');
  const site = matches[0];
  if (observation.operator !== OPERATORS[site.operator]) return failure('ASSERTION_OPERATOR_MISMATCH');
  return { type: 'assertion-failure', suite,
    id: JSON.stringify([suite, site.hash, site.operator, observation.testName]), code: 'ERR_ASSERTION', detail: site.operator };
}
function bindAssertionSite(error, context, name) {
  const observation = observeAssertion(error, context.suite, context.filename, name);
  return observation.type === 'harness-error' ? observation : mapAssertionObservation(observation, context);
}
function createMutationReporter(suite) {
  const expected = process.env.RESQ_MUTATION_SUITE, nonce = process.env.RESQ_MUTATION_NONCE;
  if (expected === undefined && nonce === undefined) return Object.freeze({ failure() {}, end() {} });
  if (!SUITES.has(suite) || expected !== suite || typeof nonce !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(nonce))
    throw Error('MUTATION_REPORTER_CONFIGURATION');
  const filename = path.resolve(__dirname, '../..', suite);
  let ended = false, failures = 0;
  const emit = event => process.stdout.write(PREFIX + JSON.stringify({ nonce, suite, ...event }) + '\n');
  emit({ type: 'module-loaded' }); emit({ type: 'suite-start' });
  return Object.freeze({
    failure(name, error) {
      if (ended) throw Error('MUTATION_REPORTER_AFTER_END');
      failures++;
      emit(observeAssertion(error, suite, filename, name));
    },
    end(failed) {
      if (ended || !Number.isInteger(failed) || failed !== failures) throw Error('MUTATION_REPORTER_END_COUNT');
      ended = true; emit({ type: 'suite-end', failed });
    },
  });
}
module.exports = { createMutationReporter, observeAssertion, mapAssertionObservation, bindAssertionSite, PREFIX };
