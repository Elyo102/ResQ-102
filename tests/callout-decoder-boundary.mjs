// Extract only the pure decoder: do not load browser/Firebase imports or listeners.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'acorn';

const source = fs.readFileSync(new URL('../callout.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const declarations = ast.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
  .filter(node => node?.type === 'FunctionDeclaration' && node.id?.name === 'calloutDisplay');
assert.equal(declarations.length, 1, 'Exactly one top-level calloutDisplay decoder must exist');
const decoder = declarations[0];
const TTL = 8 * 60 * 60 * 1000;
const calloutDisplay = new Function('CALLOUT_TTL_MS',
  source.slice(decoder.start, decoder.end) + '; return calloutDisplay;')(TTL);
const now = Date.parse('2026-10-02T12:00:00.000Z');
const body = 'התייצבות <בתחנה> & פרטים\nשורה שנייה';
const cases = [];
function add(name, value, expected = {}) {
  cases.push([name, () => {
    const actual = calloutDisplay(value, now);
    assert.deepEqual(Object.keys(actual).sort(), ['ageUnverified', 'fresh', 'from', 'text', 'validText']);
    assert.equal(typeof actual.text, 'string');
    assert.equal(actual.validText, true);
    assert.equal(actual.text, body);
    assert.equal(actual.from, expected.from ?? 'מפקד');
    assert.equal(actual.fresh, expected.fresh ?? true);
    assert.equal(actual.ageUnverified, expected.ageUnverified ?? false);
  }]);
}
add('valid text retained without escaping or rewriting', { text: body });
add('string sender fields retained', { text: body, by_name: ' דנה ', by_role_he: 'מפקדת', when_he: 'כעת' },
  { from: ' דנה  · מפקדת · כעת' });
add('empty sender uses current fallback', { text: body, by_name: '', by_role_he: '', when_he: '' });

const malformed = [null, false, true, 0, 42, [], ['sender'], {},
  { toString: 1, valueOf: 1 }, NaN, Infinity, -Infinity];
for (const [index, value] of malformed.entries()) {
  add('malformed sender components ' + index,
    { text: body, by_name: value, by_role_he: value, when_he: value });
}
for (const [index, text] of [undefined, null, '', '   ', '\n\t', false, true, 0, 42, [],
  ['message'], {}, { toString: 1, valueOf: 1 }, NaN, Infinity].entries()) {
  cases.push(['invalid body is explicitly nonactionable ' + index, () => {
    const actual = calloutDisplay({ text }, now);
    assert.equal(actual.validText, false);
    assert.equal(typeof actual.text, 'string');
    assert.equal(actual.from, 'מפקד');
    assert.equal(actual.fresh, true);
    assert.equal(actual.ageUnverified, false);
    // The UI owns the visible warning. The decoder must not expose an object
    // coercion as though it were a legitimate operational instruction.
    assert.notEqual(actual.text, '[object Object]');
  }]);
}
cases.push(['nonblank body whitespace remains intact', () => {
  const text = '  הודעה\n ';
  const actual = calloutDisplay({ text }, now);
  assert.equal(actual.validText, true);
  assert.equal(actual.text, text);
}]);

for (const [name, created_key] of [['absent value', undefined], ['null legacy value', null], ['empty legacy value', '']]) {
  add(name, { text: body, created_key });
}
for (const [index, created_key] of ['not-a-date', '   ', 123, false, [], ['2026-10-02'], {},
  { toString: 1, valueOf: 1 }, NaN, Infinity].entries()) {
  add('provided malformed timestamp remains visible with warning ' + index,
    { text: body, created_key }, { ageUnverified: true });
}
for (const [name, ms, fresh] of [
  ['current', now, true], ['one millisecond inside TTL', now - TTL + 1, true],
  ['exact TTL expired', now - TTL, false], ['older than TTL', now - TTL - 1, false],
  ['future retains existing eligibility', now + TTL, true]
]) {
  add(name, { text: body, created_key: new Date(ms).toISOString() }, { fresh });
}
cases.push(['raw input and nested malformed values are preserved', () => {
  const bad = Object.freeze({ toString: 1, valueOf: 1 });
  const value = Object.freeze({ text: body, by_name: bad, by_role_he: 'מפקדת', created_key: bad,
    active: true, uids: Object.freeze(['recipient']), acks: Object.freeze({}) });
  const before = JSON.stringify(value);
  const actual = calloutDisplay(value, now);
  assert.equal(actual.validText, true);
  assert.equal(actual.text, body);
  assert.equal(actual.from, 'מפקד · מפקדת');
  assert.equal(actual.fresh, true);
  assert.equal(actual.ageUnverified, true);
  assert.equal(JSON.stringify(value), before);
  assert.equal(value.by_name, bad);
  assert.equal(value.created_key, bad);
}]);

let failed = 0;
for (const [name, check] of cases) {
  try { check(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error.code || error.name)); }
}
console.log(`Callout decoder boundaries: ${cases.length - failed}/${cases.length} PASS`);
if (failed) process.exitCode = 1;
