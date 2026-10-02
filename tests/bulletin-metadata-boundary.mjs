// Pure display-boundary contract; no browser, Firebase, or persisted writes.
import assert from 'node:assert/strict';
import { bulletinDisplayMetadata } from '../bulletin.js';

const defaults = {
  name: 'חבר צוות', replyName: 'חבר צוות', role: '', replyRole: '', crew: '', replyCount: 0
};
const cases = [];
function add(name, data, expected = {}, labels = {}) {
  cases.push([name, () => assert.deepEqual(bulletinDisplayMetadata(data, labels),
    { ...defaults, ...expected })]);
}

add('empty metadata', {});
add('system author default does not replace reply default', { kind: 'system' }, { name: 'מערכת ResQ' });
add('valid metadata and own role label', {
  by_name: 'דנה', author_name: 'ישן', by_role: 'commander', author_role: 'ישן',
  by_crew: 'C', reply_count: 3
}, { name: 'דנה', replyName: 'דנה', role: 'מפקדת', replyRole: 'מפקדת', crew: 'משמרת C', replyCount: 3 },
{ commander: 'מפקדת' });
add('legacy author fallbacks are message-only', { author_name: 'ישן', author_role: 'תפקיד ישן' },
  { name: 'ישן', role: 'תפקיד ישן' });
add('empty primary fields retain fallback precedence', {
  by_name: '', author_name: 'ישן', by_role: '', author_role: 'תפקיד ישן', by_crew: '', reply_count: ''
}, { name: 'ישן', role: 'תפקיד ישן' });
add('unmapped role preserves legacy precedence', { by_role: 'custom', author_role: 'legacy' },
  { role: 'legacy', replyRole: 'custom' });
add('unmapped role without legacy fallback', { by_role: 'custom' }, { role: 'custom', replyRole: 'custom' });
add('valid strings are not trimmed or rewritten', { by_name: ' דנה ', by_role: ' תפקיד ', by_crew: ' C ' },
  { name: ' דנה ', replyName: ' דנה ', role: ' תפקיד ', replyRole: ' תפקיד ', crew: 'משמרת  C ' });

// These maps (including shadowed conversion names), arrays and nonfinite numbers
// are Firestore-storable values, not executable getter/function fixtures.
const malformed = [null, true, 42, [], ['x'], {}, { toString: 1, valueOf: 1 }, NaN, Infinity, -Infinity];
for (const [index, value] of malformed.entries()) {
  add('malformed author/role fields ' + index,
    { by_name: value, author_name: value, by_role: value, author_role: value });
  add('malformed primary name still uses legacy fallback ' + index,
    { by_name: value, author_name: 'ישן' }, { name: 'ישן' });
}
for (const role of ['constructor', 'toString', '__proto__']) {
  add('inherited Object role label ignored: ' + role, { by_role: role }, { role, replyRole: role });
}
add('custom inherited role label ignored', { by_role: 'commander', author_role: 'legacy' },
  { role: 'legacy', replyRole: 'commander' }, Object.create({ commander: 'inherited' }));
for (const [index, value] of [42, {}, { toString: 1 }, ['label'], null, false, ''].entries()) {
  add('invalid or empty own label retains fallback ' + index, { by_role: 'custom', author_role: 'legacy' },
    { role: 'legacy', replyRole: 'custom' }, { custom: value });
}
add('own reserved-name label is supported', { by_role: 'constructor' },
  { role: 'תפקיד', replyRole: 'תפקיד' }, { constructor: 'תפקיד' });

for (const [value, crew] of [['A', 'משמרת A'], [2, 'משמרת 2'], ['0', 'משמרת 0'],
  [0, ''], [-0, ''], ['', ''], [null, ''], [false, ''], [[], ''], [{ toString: 1, valueOf: 1 }, ''],
  [NaN, ''], [Infinity, ''], [-Infinity, '']]) {
  add('crew boundary ' + cases.length, { by_crew: value }, { crew });
}
for (const [value, replyCount] of [[3, 3], ['3', 3], [3.9, 3], ['3.9', 3], [' 3 ', 3],
  [0, 0], [-0, 0], [-3, 0], ['-3.5', 0], ['', 0], [' ', 0], ['invalid', 0],
  [null, 0], [true, 0], [false, 0], [[], 0], [[3], 0], [{ toString: 1, valueOf: 1 }, 0],
  [NaN, 0], [Infinity, 0], [-Infinity, 0], ['Infinity', 0], [1e20, 0],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  [Number.MAX_SAFE_INTEGER + 1, 0], [String(Number.MAX_SAFE_INTEGER + 1), 0]]) {
  add('reply count boundary ' + cases.length, { reply_count: value }, { replyCount });
}

cases.push(['raw metadata, message text and labels remain unchanged', () => {
  const malformedName = Object.freeze({ toString: 1, valueOf: 1 });
  const text = 'Original <message> & text — אין להחליף';
  const data = Object.freeze({ by_name: malformedName, author_name: 'ישן', by_role: 'commander',
    by_crew: 'C', reply_count: '2.9', text, hidden: false, created_at: Object.freeze({ seconds: 123 }) });
  const labels = Object.freeze({ commander: 'מפקדת' });
  const before = JSON.stringify(data), labelsBefore = JSON.stringify(labels);
  const actual = bulletinDisplayMetadata(data, labels);
  assert.deepEqual(actual, { ...defaults, name: 'ישן', role: 'מפקדת', replyRole: 'מפקדת',
    crew: 'משמרת C', replyCount: 2 });
  assert.equal(JSON.stringify(data), before);
  assert.equal(JSON.stringify(labels), labelsBefore);
  assert.equal(data.by_name, malformedName);
  assert.equal(data.text, text);
}]);

let failed = 0;
for (const [name, check] of cases) {
  try { check(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + (error.code || error.name)); }
}
console.log(`Bulletin metadata boundaries: ${cases.length - failed}/${cases.length} PASS`);
if (failed) process.exitCode = 1;
