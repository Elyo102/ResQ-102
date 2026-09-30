'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertReserveShiftNoOverlap: guard, attendanceIntervals, shiftedDate } = require('./attendance-reserve-overlap');
const row = (date, patch = {}) => ({ date, month: date.slice(0, 7), uid: 'person', emp_number: '007',
  day_type: 'reserve_shift', shape: 'regular', start: '07:00', end: '07:00', end_day: 1,
  start2: '', end2: '', end_day2: 0, ...patch });
function harness(rows = []) {
  const records = new Map(rows.map(value => [value.emp_number + '_' + value.date, value])), reads = [];
  return { reads, run(candidates, knownRows = new Map()) {
    return guard({ candidates, knownRows, employeeNumber: '007', uid: 'person',
      root: { collection: name => { assert.equal(name, 'attendance'); return { doc: id => id }; } },
      tx: { get: async id => { reads.push(id); return { exists: records.has(id), data: () => records.get(id) }; } } });
  } };
}
const fails = action => assert.rejects(action, error => error.code === 'failed-precondition');
test('four canonical neighbor reads cross month/year and deduplicate', async () => {
  const h = harness(); await h.run([row('2026-12-31')]);
  assert.deepEqual(h.reads, ['007_2026-12-29', '007_2026-12-30', '007_2027-01-01', '007_2027-01-02']);
  const batch = harness(); await batch.run([row('2026-12-31'), row('2027-01-01')]);
  assert.equal(new Set(batch.reads).size, batch.reads.length); assert.equal(batch.reads.length, 4);
});
test('known absent dates and rows avoid reads, candidates replace before-images', async () => {
  const h = harness(), known = new Map();
  for (let n = -2; n <= 2; n++) known.set(shiftedDate('2026-09-10', n), null);
  known.set('2026-09-10', row('2026-09-10', { start: '00:00' }));
  await h.run([row('2026-09-10')], known); assert.equal(h.reads.length, 0);
});
test('half-open adjacency allowed, previous/next day overlap rejected', async () => {
  await harness([row('2026-09-09'), row('2026-09-11')]).run([row('2026-09-10')]);
  await fails(() => harness([row('2026-09-09', { start: '08:00', end: '08:00' })]).run([row('2026-09-10')]));
  await fails(() => harness([row('2026-09-11', { start: '06:00', end: '06:00' })]).run([row('2026-09-10')]));
});
test('ordinary offset two is checked in both directions', async () => {
  const ordinary = row('2026-09-08', { day_type: 'regular', start: '07:00', end: '09:00', end_day: 2 });
  await fails(() => harness([ordinary]).run([row('2026-09-10')]));
  await fails(() => harness([row('2026-09-10')]).run([ordinary]));
});
test('legacy second interval and implicit overnight offset are included', async () => {
  const split = row('2026-09-09', { day_type: 'regular', shape: 'split', start: '08:00', end: '10:00', end_day: 0,
    start2: '23:00', end2: '08:00', end_day2: 1 });
  await fails(() => harness([split]).run([row('2026-09-10')]));
  const legacy = row('2026-09-09', { day_type: 'regular', start: '08:00', end: '08:00' }); delete legacy.end_day;
  await fails(() => harness([legacy]).run([row('2026-09-10')]));
  assert.equal(own(legacy, 'end_day'), false);
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
test('absences do not conflict and ordinary overlaps stay outside this policy', async () => {
  for (const day_type of ['reserve', 'sick', 'vacation']) {
    await harness([row('2026-09-09', { day_type, start: '', end: '' })]).run([row('2026-09-10')]);
  }
  await harness([row('2026-09-09', { day_type: 'regular', start: '08:00', end: '08:00' })])
    .run([row('2026-09-10', { day_type: 'regular' })]);
  const h = harness(); await h.run([row('2026-09-10', { day_type: 'reserve', start: '', end: '' })]);
  assert.equal(h.reads.length, 0);
});
test('batch candidates are compared with each other and boundaries', async () => {
  await fails(() => harness().run([row('2026-09-30'), row('2026-10-01', { day_type: 'regular', start: '06:00', end: '10:00', end_day: 0 })]));
  await fails(() => harness([row('2026-08-31', { start: '08:00', end: '08:00' })]).run([row('2026-09-01')]));
  await fails(() => harness().run([row('2026-09-01'), row('2026-09-01')]));
});
test('malformed reserve offsets, shapes and durations fail closed', async () => {
  for (const patch of [{ end_day: undefined }, { end_day: null }, { end_day: '1' }, { end_day: -1 },
    { end_day: 2 }, { end_day: 0 }, { end: '08:00' }, { shape: 'split' }, { start2: '01:00' }]) {
    await fails(() => harness().run([row('2026-09-10', patch)]));
  }
});
test('encountered wrong identity and malformed timed neighbors fail closed', async () => {
  for (const patch of [{ uid: 'other' }, { month: '2026-08' }, { start: 'bad' }, { end_day: 3 }, { start2: '01:00', end2: '' }]) {
    await fails(() => harness([row('2026-09-09', { day_type: 'regular', ...patch })]).run([row('2026-09-10')]));
  }
  await fails(() => harness().run([row('2026-09-10')], new Map([['2026-09-09', row('2026-09-09', { emp_number: '008' })]])));
});
test('DST dates use exactly 1440 civil minutes and valid edited durations', () => {
  for (const date of ['2026-03-27', '2026-10-25', '2026-12-31']) {
    const [value] = attendanceIntervals(row(date)); assert.equal(value.end - value.start, 1440);
  }
  const [sameDay] = attendanceIntervals(row('2026-09-10', { end: '15:00', end_day: 0 }));
  assert.equal(sameDay.end - sameDay.start, 480);
});
test('neighbor-to-neighbor historical overlaps do not block an unrelated candidate', async () => {
  await harness([row('2026-09-08', { start: '08:00', end: '08:00' }), row('2026-09-09')]).run([row('2026-09-10')]);
});
test('ordinary-only changes do not acquire new legacy interval validation', async () => {
  for (const patch of [{ start: 'bad' }, { end_day: 7 }, { day_type: 'legacy_unknown' }]) {
    await harness([row('2026-09-09', { day_type: 'regular', ...patch })])
      .run([row('2026-09-10', { day_type: 'regular' })]);
  }
});
