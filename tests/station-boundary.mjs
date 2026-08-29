// 42A — prove that schedule reads stay inside the station selected by the
// production call site. The implementation is extracted from index.js so the
// test cannot drift into a second, copied implementation.
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

function emptySnapshot() {
  return { forEach() {} };
}

function loadScheduleFromProduction(paths) {
  const fakeDb = {
    collection(path) {
      paths.push(path);
      return { async get() { return emptySnapshot(); } };
    }
  };
  return new Function('db', grabFunction('loadSchedule') + '\nreturn loadSchedule;')(fakeDb);
}

const paths = [];
const loadSchedule = loadScheduleFromProduction(paths);

await assert.rejects(() => loadSchedule(), /explicit station id/);
await assert.rejects(() => loadSchedule(''), /explicit station id/);
await assert.rejects(() => loadSchedule('   '), /explicit station id/);
assert.deepEqual(paths, [], 'invalid station ids fail before any Firestore read');

await loadSchedule('eilat_102');
await loadSchedule('beer_sheva_101');
assert.deepEqual(paths, [
  'stations/eilat_102/rotations',
  'stations/eilat_102/shift_overrides',
  'stations/beer_sheva_101/rotations',
  'stations/beer_sheva_101/shift_overrides'
], 'each schedule read remains inside its explicit station');

const scanMonth = grabFunction('scanMonth');
assert.match(scanMonth, /loadSchedule\(STATION_ID\)/,
  'single-station monthly scan keeps its explicit pilot station');

const swapStart = source.indexOf('exports.onSwapChange = onDocumentWritten(');
assert.notEqual(swapStart, -1, 'production onSwapChange trigger exists');
const swapEnd = source.indexOf('\nexports.', swapStart + 1);
const swapSource = source.slice(swapStart, swapEnd === -1 ? source.length : swapEnd);
assert.match(swapSource, /const sid = event\.params\.sid;/,
  'swap trigger derives the station from the event path');
assert.match(swapSource, /loadSchedule\(sid\)/,
  'swap trigger passes the event station to the schedule loader');
assert.doesNotMatch(swapSource, /loadSchedule\(\s*\)/,
  'swap trigger never performs an implicit schedule read');

const calls = Array.from(source.matchAll(/\bloadSchedule\s*\(([^)]*)\)/g),
  match => match[1].trim());
assert.deepEqual(calls, ['sid', 'STATION_ID', 'sid'],
  'all production definitions and call sites remain explicit and reviewed');

console.log('Station boundary checks passed: 11');
