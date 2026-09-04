'use strict';

const assert = require('node:assert/strict');
const W = require('./schedule-effective-workdays');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }
function day(date, uids) {
  return { date, assignments: uids.map((uid) => ({ uid, display: 'x', source: 'v2', sub_station: 'main', role: 'firefighter' })) };
}
function daysBetween(from, to, fn) {
  const r = W.normalizeRange(from, to);
  return r.dates.map((d) => day(d, fn(d)));
}

test('the range is inclusive: 397 days pass, 398 fail; order is enforced', () => {
  assert.equal(W.normalizeRange('2026-01-01', '2027-02-01').dates.length, 397);
  assert.throws(() => W.normalizeRange('2026-01-01', '2027-02-02'), { code: 'range-too-long' });
  assert.throws(() => W.normalizeRange('2026-01-02', '2026-01-01'), { code: 'range-order' });
  assert.throws(() => W.normalizeRange('2026-02-30', '2026-03-01'), { code: 'range-date' });
});

test('windows never exceed 93 days and only cover the intersection with coverage', () => {
  const w = W.windowsFor({ from: '2026-01-01', to: '2026-12-31' }, null);
  assert.equal(w.length, 4);
  w.forEach((x) => assert.ok(W.normalizeRange(x.from, x.to).dates.length <= 93));
  assert.equal(w[0].from, '2026-01-01');
  assert.equal(w[3].to, '2026-12-31');
  const c = W.windowsFor({ from: '2026-01-01', to: '2026-12-31' }, { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(c, [{ from: '2026-09-01', to: '2026-09-30' }]);
  assert.deepEqual(W.windowsFor({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-09-01', to: '2026-09-30' }), []);
});

test('a publication answers inside its coverage, and says unknown outside it', () => {
  const out = W.assemble({
    source: 'publication',
    range: { from: '2026-08-30', to: '2026-09-03' },
    coverage: { from: '2026-09-01', to: '2026-09-30' },
    windows: [{ from: '2026-09-01', to: '2026-09-03',
      days: daysBetween('2026-09-01', '2026-09-03', (d) => (d === '2026-09-02' ? ['b'] : ['a', 'b'])) }],
    uids: ['a', 'b', 'c'],
    roster: ['a', 'b']
  });
  assert.deepEqual(out.unknown_dates, ['2026-08-30', '2026-08-31']);
  assert.deepEqual(out.by_uid, { a: ['2026-09-01', '2026-09-03'], b: ['2026-09-01', '2026-09-02', '2026-09-03'] });
  // ⭐ c אינו בסגל: לא „בחופש" — לא ידוע, ואין לו רשימה.
  assert.deepEqual(out.unknown_uids, { c: 'not-in-roster' });
  assert.equal(Object.hasOwn(out.by_uid, 'c'), false);
  assert.equal(out.working['2026-09-02'].length, 1);
  assert.equal(Object.hasOwn(out.working, '2026-08-30'), false, 'יום לא ידוע הוצג כריק');
  assert.equal(JSON.stringify(out).includes('hours'), false, 'שעות הומצאו');
});

test('legacy covers the whole range and answers every day', () => {
  const out = W.assemble({
    source: 'legacy', range: { from: '2026-09-01', to: '2026-09-02' }, coverage: { from: '2026-09-01', to: '2026-09-02' },
    windows: [{ from: '2026-09-01', to: '2026-09-02', days: daysBetween('2026-09-01', '2026-09-02', () => ['a']) }],
    uids: ['a', 'zz'], roster: null
  });
  assert.deepEqual(out.unknown_dates, []);
  assert.deepEqual(out.by_uid, { a: ['2026-09-01', '2026-09-02'], zz: [] });
  assert.deepEqual(out.unknown_uids, {});
});

test('invalid uids are reported, not silently dropped; duplicates collapse', () => {
  const out = W.assemble({
    source: 'legacy', range: { from: '2026-09-01', to: '2026-09-01' }, coverage: null,
    windows: [{ from: '2026-09-01', to: '2026-09-01', days: [day('2026-09-01', ['a'])] }],
    uids: ['a', 'a', 'bad/uid', 7], roster: null
  });
  assert.deepEqual(out.unknown_uids, { 'bad/uid': 'invalid', 7: 'invalid' });
  assert.deepEqual(Object.keys(out.by_uid), ['a']);
  assert.throws(() => W.normalizeUids(new Array(501).fill('a')), { code: 'uids-too-many' });
});

test('a window that does not match the expected chunking, or a duplicated day, fails closed', () => {
  const base = { source: 'legacy', range: { from: '2026-09-01', to: '2026-09-02' }, coverage: null, uids: [], roster: null };
  assert.throws(() => W.assemble(Object.assign({}, base, { windows: [] })), { code: 'windows-mismatch' });
  assert.throws(() => W.assemble(Object.assign({}, base, {
    windows: [{ from: '2026-09-01', to: '2026-09-02', days: [day('2026-09-01', ['a']), day('2026-09-01', ['b'])] }]
  })), { code: 'window-day-duplicate' });
  assert.throws(() => W.assemble(Object.assign({}, base, {
    windows: [{ from: '2026-09-01', to: '2026-09-02', days: [{ date: '2026-09-01', assignments: [{ uid: 'a' }, { uid: 'a' }] }] }]
  })), { code: 'assignment-duplicate' });
});

test('a full year against a one-month publication is 30 answered days and 335 unknown', () => {
  const out = W.assemble({
    source: 'publication', range: { from: '2026-01-01', to: '2026-12-31' },
    coverage: { from: '2026-09-01', to: '2026-09-30' },
    windows: [{ from: '2026-09-01', to: '2026-09-30', days: daysBetween('2026-09-01', '2026-09-30', () => ['a']) }],
    uids: ['a'], roster: ['a']
  });
  assert.equal(out.unknown_dates.length, 335);
  assert.equal(out.by_uid.a.length, 30);
});

console.log('\n' + passed + ' effective-workdays checks passed.');
