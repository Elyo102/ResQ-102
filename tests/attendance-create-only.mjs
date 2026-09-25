// Actual source-extracted client helper. Server atomicity, locking and derived
// values are covered by attendance-correction-support.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeEol } from './eol-guard.mjs';
import { configuredDayOffset } from '../hours.js';
import { shiftTimes } from '../rotation.js';

const path = new URL('../attendance.html', import.meta.url);
const source = normalizeEol(fs.readFileSync(path, 'utf8'));
const start = 'async function createMissingDays(';
const end = 'async function refreshAfterCreation(';
assert.equal(source.split(start).length, 2);
assert.equal(source.split(end).length, 2);
const actual = source.slice(source.indexOf(start), source.indexOf(end));
const target = { sid:'test-station', emp:'101', uid:'worker', month:'2026-09' };
const entries = [
  { date:'2026-09-02', day_type:'regular', start:'08:00', end:'16:00', hours:999, uid:'spoof' },
  { date:'2026-09-01', day_type:'reserve', notes:'approved reserve' }
];

let calls = 0, fences = 0, captured;
const context = vm.createContext({
  onOther: () => false,
  requireMonthWrite: value => { assert.equal(value, target); fences++; },
  callMutateMyAttendanceMonth: Symbol('month-callable'),
  correctionPatch: value => Object.fromEntries(['day_type','start','end','notes']
    .filter(key => Object.prototype.hasOwnProperty.call(value, key)).map(key => [key, value[key]])),
  callCorrection: async (callable, intent, kind) => {
    calls++; assert.equal(kind, 'self-month'); captured = intent;
    return { changed_count: 1 };
  }
});
const createMissingDays = vm.runInContext(actual + ';createMissingDays', context);
const result = await createMissingDays(target, entries);
assert.deepEqual(structuredClone(result), { created:1, skipped:1 });
assert.equal(calls, 1); assert.equal(fences, 2);
assert.deepEqual(structuredClone(captured), {
  month:'2026-09', operation:'fill', entries:[
    { date:'2026-09-01', patch:{ day_type:'reserve', notes:'approved reserve' } },
    { date:'2026-09-02', patch:{ day_type:'regular', start:'08:00', end:'16:00' } }
  ]
});
assert.equal(JSON.stringify(captured).includes('999'), false);
assert.equal(JSON.stringify(captured).includes('spoof'), false);

await assert.rejects(createMissingDays(target, [entries[0], entries[0]]));
await assert.rejects(createMissingDays(target, Array(32).fill(entries[0])));
assert.equal(calls, 1, 'invalid batches never reach the server');

console.log('Attendance create-only client boundary: sorted closed patches, one trusted server call.');

const baseStart = source.indexOf('function baseTimes(){');
const baseEnd = source.indexOf('// האם אני עובד בתאריך הזה', baseStart);
assert.ok(baseStart >= 0 && baseEnd > baseStart, 'extract actual station-hour helper');
const baseContext = vm.createContext({
  rotations:[], SUBJ:{ role:'firefighter' }, ME:{ role:'firefighter' },
  configuredDayOffset, shiftTimes
});
const baseTimes = vm.runInContext(source.slice(baseStart, baseEnd) + ';baseTimes', baseContext);
function shiftConfig(rotation, role = 'firefighter') {
  baseContext.rotations = rotation ? [rotation] : [];
  baseContext.SUBJ = { role };
  return structuredClone(baseTimes());
}
assert.deepEqual(shiftConfig({ shift_start:'07:00', shift_end:'07:00', shift_hours:24 }),
  { start:'07:00', end:'07:00', end_day:1 });
assert.deepEqual(shiftConfig({ shift_start:'07:00', shift_end:'07:00', shift_hours:24,
  commander_start:'06:45', commander_shift_hours:24.25 }, 'commander'),
{ start:'06:45', end:'07:00', end_day:1 });
assert.deepEqual(shiftConfig({ shift_start:'07:00', shift_end:'19:00', shift_hours:12 }),
  { start:'07:00', end:'19:00', end_day:0 });
for (const invalid of [null, {}, { shift_start:'07:00', shift_end:'07:00' },
  { shift_start:'07:00', shift_end:'07:00', shift_hours:24.25 }]) {
  assert.deepEqual(shiftConfig(invalid), { start:'', end:'', end_day:null });
}
assert.deepEqual(shiftConfig({ shift_start:'07:00', shift_end:'07:00', shift_hours:24 }, 'commander'),
  { start:'', end:'', end_day:null }, 'a commander must not use an invented start');
assert.equal((source.match(/end: bt\.end, end_day:bt\.end_day/g) || []).length, 3,
  'fill, reconcile and suggestions use the same explicit roster day');
assert.match(source, /start: bt\.start, end: bt\.end, end_day:bt\.end_day/,
  'suggested rows display the same calculated roster interval');
console.log('Attendance configured day offsets: regular, commander, custom and fail-closed cases PASS.');
