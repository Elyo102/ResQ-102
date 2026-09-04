// 42A — prove that schedule reads stay inside the station selected by the
// production call site. The implementation is extracted from index.js so the
// test cannot drift into a second, copied implementation.
//
// 42G.29: the loader is loadEffectiveSchedule → the runtime's
// effectiveWorkDaysForStation(sid, …). The boundary is the same — an
// explicit station on every call, no implicit read — and it is now the
// runtime that owns the Firestore paths, so the fake here is the runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(join(testsDir, '..', 'functions', 'index.js'), 'utf8');

function grabFunction(name) {
  const functionStart = source.indexOf('function ' + name + '(');
  assert.notEqual(functionStart, -1, 'production function exists: ' + name);
  const asyncStart = source.lastIndexOf('async ', functionStart);
  const start = asyncStart >= 0 && asyncStart + 6 === functionStart
    ? asyncStart : functionStart;
  let depth = 0;
  const bodyStart = source.indexOf('{', start);
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('unbalanced production function: ' + name);
}
function grabConstant(name) {
  const match = source.match(new RegExp('const ' + name + ' = ([^;]+);'));
  assert.ok(match, 'production constant exists: ' + name);
  return 'const ' + name + ' = ' + match[1] + ';';
}

function loaderFromProduction(stations, failingStation) {
  const fakeRuntime = {
    async effectiveWorkDaysForStation(sid, input) {
      stations.push({ sid, from: input.from, to: input.to, uids: input.uids.length });
      if (sid === failingStation) throw new Error('simulated runtime failure');
      return {
        mode: 'off', source: 'legacy', fallback: null, from: input.from, to: input.to,
        coverage: { from: input.from, to: input.to }, unknown_dates: [], unknown_uids: {},
        by_uid: Object.fromEntries(input.uids.map(u => [u, []])), provenance: { mode: 'off', source: 'legacy' }
      };
    }
  };
  return new Function('scheduleRuntime',
    grabConstant('WORKDAYS_MAX_UIDS') + '\n' + grabFunction('loadEffectiveSchedule') + '\nreturn loadEffectiveSchedule;')(fakeRuntime);
}

const stations = [];
const loadEffectiveSchedule = loaderFromProduction(stations);

await assert.rejects(() => loadEffectiveSchedule(), /explicit station id/);
await assert.rejects(() => loadEffectiveSchedule(''), /explicit station id/);
await assert.rejects(() => loadEffectiveSchedule('   '), /explicit station id/);
assert.deepEqual(stations, [], 'invalid station ids fail before any runtime read');

await loadEffectiveSchedule('eilat_102', '2026-09-01', '2026-09-30', ['a']);
await loadEffectiveSchedule('beer_sheva_101', '2026-09-01', '2026-09-30', ['b']);
assert.deepEqual(stations.map(s => s.sid), ['eilat_102', 'beer_sheva_101'],
  'each schedule read remains inside its explicit station');
assert.ok(stations.every(s => s.from === '2026-09-01' && s.to === '2026-09-30'),
  'the range travels with the station');

const failed = [];
const failing = loaderFromProduction(failed, 'eilat_102');
await assert.rejects(() => failing('eilat_102', '2026-09-01', '2026-09-30', ['a']), /simulated runtime failure/,
  'a runtime failure fails closed instead of returning an empty schedule');

const scanMonth = grabFunction('scanMonth');
assert.match(scanMonth, /loadEffectiveSchedule\(STATION_ID, mk \+ '-01'/,
  'single-station monthly scan keeps its explicit pilot station');

const swapStart = source.indexOf('exports.onSwapChange = onDocumentWritten(');
assert.notEqual(swapStart, -1, 'production onSwapChange trigger exists');
const swapEnd = source.indexOf('\nexports.', swapStart + 1);
const swapSource = source.slice(swapStart, swapEnd === -1 ? source.length : swapEnd);
assert.match(swapSource, /const sid = event\.params\.sid;/,
  'swap trigger derives the station from the event path');
assert.match(swapSource, /loadEffectiveSchedule\(sid, range\.from, range\.to,/,
  'swap trigger passes the event station to the schedule loader');
assert.doesNotMatch(swapSource, /loadEffectiveSchedule\(\s*\)/,
  'swap trigger never performs an implicit schedule read');
assert.match(swapSource, /status:\s*'cmd_to'/,
  'a failed rest check returns the swap to the last approval stage');
assert.match(swapSource, /rest_check_pending:\s*true/,
  'a failed rest check is explicitly marked for retry');
assert.match(swapSource, /האישור לא נכנס לתוקף/,
  'users are told that the approval did not take effect');

const calls = Array.from(source.matchAll(/\bloadEffectiveSchedule\s*\(([^,)]*)/g),
  match => match[1].trim());
assert.deepEqual(calls, ['sid', 'STATION_ID', 'sid'],
  'all production definitions and call sites remain explicit and reviewed');
assert.doesNotMatch(source, /\bloadSchedule\s*\(/, 'the old direct-read loader is gone');

console.log('Station boundary checks passed: 16');
