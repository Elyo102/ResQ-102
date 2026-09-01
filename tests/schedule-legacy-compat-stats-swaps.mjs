import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const stats = read('stats.html');
const swaps = read('swaps.html');
const checkPage = read('check.html');
const stub = read('tests/stub/firebase-functions.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('✓ ' + name);
}

function functionBody(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error('unterminated function ' + name);
}

function noRawScheduleRead(source) {
  assert.doesNotMatch(source,
    /getDocs\s*\(\s*collection\([^)]*['"](?:rotations|shift_overrides)['"]/);
}

test('statistics reads the allowlisted compatibility callable, never raw schedule documents', () => {
  assert.match(stats, /httpsCallable\(fns,\s*'getLegacyScheduleCompatibilityContext'\)/);
  assert.match(stats, /legacyScheduleCall\(\{\}\)/);
  noRawScheduleRead(stats);
});

test('statistics stops load calculations when schedule or guard context is unavailable', () => {
  const body = functionBody(stats, 'renderLoad');
  assert.ok(body.indexOf('scheduleLoadError || guardLoadError') >= 0);
  assert.ok(body.indexOf('return;') < body.indexOf('loadStats('));
  assert.match(body, /החישוב נעצר/);
});

test('statistics publishes only the newest captured load window', () => {
  assert.match(stats, /let guardLoadGeneration = 0/);
  const body = functionBody(stats, 'loadGuardStatistics');
  assert.ok(body.indexOf('++guardLoadGeneration') < body.indexOf('guardStatsCall('));
  assert.ok(body.indexOf('generation !== guardLoadGeneration') < body.indexOf('guards = nextGuards'));
  assert.ok(body.indexOf('WIN !== selectedWindow') < body.indexOf('guards = nextGuards'));
  assert.match(stats, /if \(!await loadGuardStatistics\(w\.id\)\) return;/);
});

test('statistics rejects a missing or non-array guard board instead of publishing zero guards', () => {
  const body = functionBody(stats, 'loadGuardStatistics');
  assert.match(body, /if \(!Array\.isArray\(rows\)\) throw new Error\('guard-statistics-contract'\)/);
  assert.ok(body.indexOf("throw new Error('guard-statistics-contract')") <
            body.indexOf('nextGuards = rows.filter'));
  assert.doesNotMatch(body, /Array\.isArray\(rows\)\s*\?[^:]+:\s*\[\]/);
  assert.ok(body.indexOf('nextError =') < body.indexOf('guards = nextGuards'));
});

test('swaps reads the allowlisted compatibility callable with no station argument', () => {
  assert.match(swaps, /httpsCallable\(fns,\s*'getLegacyScheduleCompatibilityContext'\)/);
  assert.match(swaps, /legacyScheduleCall\(\{\}\)/);
  noRawScheduleRead(swaps);
});

test('every swap path that derives duty or rest fails closed without schedule context', () => {
  assert.match(swaps, /btnSend'\)\.onclick[\s\S]{0,180}requireSchedule\('newMsg'\)/);
  const take = functionBody(swaps, 'takeOpen');
  assert.ok(take.indexOf("requireSchedule('openMsg')") < take.indexOf('swapRestCheck('));
  const review = functionBody(swaps, 'reviewDialog');
  assert.ok(review.indexOf("requireSchedule('apprMsg')") < review.indexOf('swapRestCheck('));
  const crew = functionBody(swaps, 'crewLine');
  assert.ok(crew.indexOf('!scheduleReady') < crew.indexOf('crewOnDate('));
});

test('a successful compatibility load refreshes both date labels selected while loading', () => {
  const body = functionBody(swaps, 'loadLegacyScheduleCompatibility');
  const ready = body.indexOf('scheduleReady = true');
  const mine = body.indexOf("crewLine('myDate', 'myCrewLine')");
  const his = body.indexOf("crewLine('hisDate', 'hisCrewLine')");
  assert.ok(ready >= 0 && mine > ready && his > ready);
  assert.ok(mine < body.indexOf('return true;') && his < body.indexOf('return true;'));
});

test('the diagnostic page neither probes, seeds nor exports raw schedule collections', () => {
  noRawScheduleRead(checkPage);
  assert.doesNotMatch(checkPage, /put\(\['rotations'\]/);
  assert.doesNotMatch(checkPage, /SEED\.rotations\(\)/);
  assert.match(checkPage, /getLegacyScheduleCompatibilityContext/);
  assert.match(checkPage, /getScheduleRuntimeStatus/);
  assert.match(checkPage, /mode === 'new'/);
  assert.match(checkPage, /getStationScheduleV2/);
  assert.match(checkPage, /shift_overrides:\s*'חריגות סידור הן מידע מוגבל/);
});

test('the browser stub supplies only the projected compatibility shape', () => {
  const start = stub.indexOf("name === 'getLegacyScheduleCompatibilityContext'");
  assert.ok(start >= 0);
  const projection = stub.slice(start, stub.indexOf("return { data:{ ok:true", start));
  assert.match(projection, /mode:'shadow'/);
  assert.match(projection, /rotations:/);
  assert.match(projection, /overrides:/);
  assert.doesNotMatch(projection, /note:|email|medical|by_uid|created_at|updated_at/);
});

assert.equal(passed, 9);
console.log('\n9 legacy compatibility page checks passed.');
