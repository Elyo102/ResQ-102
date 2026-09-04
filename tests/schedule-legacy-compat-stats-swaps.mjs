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

test('swap inputs leave one schedule day on each side for the rest rule', () => {
  const windowBody = functionBody(swaps, 'swapCompatibilityWindow');
  assert.match(windowBody,
    /from:\s*swapDayOffset\(today,\s*-SWAP_COMPATIBILITY_PAST_DAYS\)/);
  assert.match(windowBody,
    /to:\s*swapDayOffset\(today,\s*SWAP_COMPATIBILITY_FUTURE_DAYS\)/);
  assert.match(windowBody,
    /min:\s*swapDayOffset\(today,\s*-\(SWAP_COMPATIBILITY_PAST_DAYS\s*-\s*1\)\)/);
  assert.match(windowBody,
    /max:\s*swapDayOffset\(today,\s*SWAP_COMPATIBILITY_FUTURE_DAYS\s*-\s*1\)/);
  assert.match(swaps, /applySwapDateBounds\(\$\('myDate'\)\)/);
  assert.match(swaps, /applySwapDateBounds\(\$\('hisDate'\)\)/);
  assert.match(swaps, /id="tkDate" min="['"]?\s*\+\s*esc\(bounds\.min\)/);
  assert.match(swaps, /if \(!swapDateAllowed\(my\)\)/);
  assert.match(swaps, /if \(!swapDateAllowed\(his\)\)/);
  assert.match(swaps, /if \(!swapDateAllowed\(d\)\)/);
});

test('the diagnostic page neither probes, seeds nor exports raw schedule collections', () => {
  noRawScheduleRead(checkPage);
  assert.doesNotMatch(checkPage, /put\(\['rotations'\]/);
  assert.doesNotMatch(checkPage, /SEED\.rotations\(\)/);
  assert.match(checkPage, /getLegacyScheduleCompatibilityContext/);
  assert.match(checkPage, /scheduleProbeRange\(\)/);
  assert.doesNotMatch(checkPage,
    /getLegacyScheduleCompatibilityContext['"]\)\(\s*\{\s*\}\s*\)/);
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

assert.equal(passed, 6);
console.log('\n6 legacy compatibility page checks passed (screen consumption moved to schedule-effective-consumers.mjs).');
