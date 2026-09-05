// ארבעת המסכים + שני המודולים המשותפים על הסידור האפקטיבי — בדיקת מקור.
//
// מה נבדק: כל מסך שואל את השרת (getEffectiveWorkdays) ולא מחשב לבד;
// אף מסך אינו קורא rotations/shift_overrides; ההחלטה „עובד" היא
// `=== true` ו„לא עובד" היא `=== false` — לא-ידוע לעולם אינו נופל
// לאחד מהם; לא-ידוע מוצג במפורש; המחזור נשאר רק לתצוגה (off/shadow).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const src = (f) => read(f).replace(/<!--[^]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const attendance = src('attendance.html');
const guards = src('guards.html');
const stats = src('stats.html');
const swaps = src('swaps.html');
const guardsJs = src('guards.js');
const statsJs = src('stats.js');
const indexJs = src('functions/index.js');
const stub = read('tests/stub/firebase-functions.js');
const check = src('check.html');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('PASS ' + name); }
  catch (e) { console.error('FAIL ' + name); throw e; }
}
function body(source, name) {
  let start = source.indexOf('function ' + name + '(');
  if (start === -1) start = source.indexOf('const ' + name + ' = async function');
  if (start === -1) start = source.indexOf('const ' + name + ' = function');
  assert.notEqual(start, -1, name + ' missing');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(name + ' unbalanced');
}
const noRawScheduleRead = (s) => assert.doesNotMatch(s, /collection\([^)]*['"](?:rotations|shift_overrides)['"]/);

for (const [name, page] of [['attendance', attendance], ['guards', guards], ['stats', stats], ['swaps', swaps]]) {
  test(name + ': asks the server who works (getEffectiveWorkdays), versioned shared module, no raw schedule reads', () => {
    assert.match(page, /httpsCallable\(fns,\s*'getEffectiveWorkdays'\)/);
    assert.match(page, /from '\.\/effective-workdays\.js\?v=42h2'/);
    noRawScheduleRead(page);
    assert.doesNotMatch(page, /\bpersonWorks\s*\(|\bisCrewWorking\s*\(/, 'work-day decisions must not be computed in the browser');
    assert.doesNotMatch(page, /getEffectiveWorkdays[^;]*(?:station|sid|SID)\s*:/, 'no station selector from the client');
  });
}

test('attendance: effective answer is the only source of work days; legacy context only for display and only outside new', () => {
  const load = body(attendance, 'loadLegacyCompatibility');
  assert.ok(load.indexOf('parseEffectiveWorkdays(await callEffectiveWorkdays(') > -1);
  assert.ok(load.indexOf('uids: [snapshot.uid]') > -1, 'a member asks only about themselves');
  assert.ok(load.indexOf("next.effective.mode === 'new'") < load.indexOf('callLegacyScheduleCompatibilityContext(range)'),
    'the legacy context is skipped in new');
  assert.ok(load.indexOf("throw new Error('schedule-mode-changed')") > -1, 'mode disagreement between the two answers fails closed');
  assert.match(body(attendance, 'suggestedDays'), /worksOn\(effective, SUBJ\.uid, key\) !== true\) continue;/);
  assert.match(body(attendance, 'workingOn'), /return worksOn\(effective, SUBJ\.uid, key\);/, 'workingOn must stay tri-state (417 §4)');
  assert.match(attendance, /const dflt = \(g && workingOn\(key\) === false\)/, 'a guard default on an unknown day would call it a day off');
  assert.doesNotMatch(attendance, /!workingOn\(/);
  assert.match(attendance, /const working = worksOn\(effective, SUBJ\.uid, key\);/);
  assert.match(attendance, /if \(working === true && !rec\)/);
  assert.match(attendance, /if \(working === false && rec && rec\.day_type === 'regular'\) extra\.push\(d\);/);
  assert.match(attendance, /shiftRotationShim\(effective\)/, 'shift hours in new come from station config, not from a crew rotation');
  assert.match(attendance, /ימים מחוץ לסידור הידוע — לא מולאו ולא הוצעו/);
  const fail = body(attendance, 'showLegacyCompatibilityFailure');
  assert.match(fail, /effective = null;/);
});

test('guards: two 365-day windows for me + everyone on the roster, merged; unknown is its own duty kind', () => {
  const load = body(guards, 'loadEffectiveWorkdays');
  assert.match(load, /ranges\.history, ranges\.upcoming/);
  assert.match(load, /mergeEffectiveWorkdays\(parts\)/);
  assert.match(load, /WORKDAYS_MAX_UIDS/);
  assert.match(guards, /loadEffectiveWorkdays\(ranges,\s*\[snapshot\.uid\]\.concat\(next\.people\.map\(p => p\.uid\)\)\)/);
  assert.match(guards, /ctx = \{ effective, swaps, guards \};/);
  assert.match(guards, /\.tag\.unknown\{/);
  assert.match(body(guards, 'personalLoad'), /result\.unknown \+= 1;/);
  assert.match(guards, /מחוץ לסידור הידוע \(לא סווגו\)/);
  assert.doesNotMatch(guards, /duty === 'off' \? 'off' : 'shift'/, 'a two-way tag would paint unknown as shift');
});

test('guards.js: onDutyAt returns worksOn (true/false/unknown); load counts unknown separately', () => {
  assert.match(guardsJs, /import \{ worksOn \} from '\.\/effective-workdays\.js\?v=42h2';/);
  assert.match(body(guardsJs, 'onDutyAt'), /return worksOn\(c\.effective, uid, key\);/);
  const kind = body(guardsJs, 'dutyKind');
  assert.match(kind, /if \(v === true\) return 'shift';/);
  assert.match(kind, /if \(v === false\) return 'off';/);
  assert.match(kind, /return 'unknown';/);
  assert.match(guardsJs, /DUTY_HE = \{ shift: '[^']+', off: '[^']+', unknown: '[^']+' \}/);
  const load = body(guardsJs, 'loadByPerson');
  assert.match(load, /else if \(kind === 'shift'\) rec\.shift\+\+;/);
  assert.match(load, /else rec\.unknown\+\+;/);
  assert.doesNotMatch(guardsJs, /personWorks/);
});

test('stats: one annual window for the whole roster; unknown guards never enter the score', () => {
  const load = body(stats, 'loadEffectiveWorkdays');
  assert.match(load, /guardStatisticsRange\('365'\)/);
  assert.match(load, /effective = parseEffectiveWorkdays\(/);
  assert.match(load, /effective = null;/);
  assert.match(stats, /loadEffectiveWorkdays\(people\.map\(p => p\.uid\)\)/);
  assert.match(stats, /ctx = \{ effective, swaps: swaps\.filter\(s => s\.status === 'approved'\), guards \};/);
  const ls = body(statsJs, 'loadStats');
  assert.match(ls, /else if \(kind === 'shift'\) r\.gShift\+\+;/);
  assert.match(ls, /else r\.gUnknown\+\+;/);
  assert.match(ls, /score = out\[u\]\.gOff \* 2 \+ out\[u\]\.gShift \+ out\[u\]\.swapIn;/, 'gUnknown must not be in the score');
  assert.match(stats, /לא סווגו/);
});

test('swaps: 397-day window for me, the roster and every swap party; unknown blocks send/take; rest uses the effective check', () => {
  const load = body(swaps, 'loadEffectiveWorkdays');
  assert.match(load, /swapDateWindow\.schedule\.from, to: swapDateWindow\.schedule\.to, uids: list/);
  assert.match(load, /swaps\.forEach\(sw => \{ if \(sw\.from_uid\) uids\.add\(sw\.from_uid\); if \(sw\.to_uid\) uids\.add\(sw\.to_uid\); \}\);/);
  assert.match(load, /effective = null;/);
  assert.match(swaps, /SWAP_COMPATIBILITY_PAST_DAYS\s*=\s*31/);
  assert.match(swaps, /SWAP_COMPATIBILITY_FUTURE_DAYS\s*=\s*365/);
  assert.match(swaps, /if \(wMe === 'unknown' \|\| wHim === 'unknown'\) \{/);
  assert.match(swaps, /if \(wMe === 'unknown'\) \{/, 'open request on an unknown day is blocked');
  assert.match(swaps, /worksOn\(effective, ME\.uid, d\) === 'unknown' \|\| worksOn\(effective, s\.from_uid, s\.from_date\) === 'unknown'/);
  assert.equal((swaps.match(/swapRestCheckEffective\(effective, swaps,/g) || []).length, 3, 'send, take and approve all run the rest check');
  assert.doesNotMatch(swaps, /swapRestCheck\(|restWhy\(/, 'the rotation-based rest check is gone');
  assert.match(swaps, /effective\.mode !== 'new' && \(!ME\.crew \|\| !peer\.crew\)/, 'crews are required only outside new');
  const line = body(swaps, 'crewLine');
  assert.match(line, /worksOn\(effective, who\.uid, v\)/);
  assert.match(line, /מחוץ לסידור הידוע — לא ניתן להחליף אותו/);
  assert.match(swaps, /crewLine\('hisDate', 'hisCrewLine'\);\s*\/\/ השורה מתארת את הצד השני/);
});

test('server: the same contract feeds the nightly scan, the monthly report and the swap rest rule', () => {
  assert.match(indexJs, /exports\.getEffectiveWorkdays = onCall\(\{ enforceAppCheck: true \}/);
  assert.match(indexJs, /scheduleRuntime\.effectiveWorkDaysForStation\(sid, \{ from, to, uids: chunk \}\)/);
  assert.match(body(indexJs, 'scanMonth'), /loadEffectiveSchedule\(STATION_ID, mk \+ '-01'/);
  assert.match(indexJs, /loadEffectiveSchedule\(sid, range\.from, range\.to,\s*\[after\.from_uid, after\.to_uid\]\)/);
  assert.doesNotMatch(indexJs, /function (?:crewOnKey|isWorking|loadSchedule)\(/);
  noRawScheduleRead(indexJs.replace(/readBoundedCollection\([^)]*\)/g, ''));
});

test('the browser stub answers getEffectiveWorkdays from the same rotation it serves the legacy context from', () => {
  assert.match(stub, /if \(name === 'getEffectiveWorkdays'\) return stubWorkdays\(payload\);/);
  assert.match(stub, /anchor_date:'2026-01-01'/);
  assert.match(stub, /Date\.UTC\(2026, 0, 1\)/);
  assert.match(stub, /STUB_SWAPS/, 'approved stub swaps apply, as the server projection does');
  const answer = stub.slice(stub.indexOf('function stubWorkdays'), stub.indexOf('function defaultCallableStep'));
  assert.doesNotMatch(answer, /rotations:|overrides:|full_name|email/, 'the workdays answer carries no rotation, overrides or PII');
});

test('the diagnostic page still neither probes, seeds nor exports raw schedule collections', () => {
  noRawScheduleRead(check);
  assert.doesNotMatch(check, /put\(\['rotations'\]/);
  assert.match(check, /getScheduleRuntimeStatus/);
  assert.match(check, /getStationScheduleV2/);
});

assert.equal(passed, 12);
console.log('\n12 effective-schedule consumer checks passed.');
