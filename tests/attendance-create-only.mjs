// Actual source-extracted client helper. Server atomicity, locking and derived
// values are covered by attendance-correction-support.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeEol } from './eol-guard.mjs';

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
