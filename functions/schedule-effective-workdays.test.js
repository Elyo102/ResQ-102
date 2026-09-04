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

test('invalid uids are reported, not silently dropped; duplicates collapse; non-strings are refused', () => {
  const out = W.assemble({
    source: 'legacy', range: { from: '2026-09-01', to: '2026-09-01' }, coverage: null,
    windows: [{ from: '2026-09-01', to: '2026-09-01', days: [day('2026-09-01', ['a'])] }],
    uids: ['a', 'a', 'bad/uid', 'bad/uid'], roster: null
  });
  assert.deepEqual(out.unknown_uids, { 'bad/uid': 'invalid' });
  assert.deepEqual(Object.keys(out.by_uid), ['a']);
  assert.throws(() => W.normalizeUids(new Array(501).fill('a')), { code: 'uids-too-many' });
  // 417 §5: המספר 7 היה הופך ל-'7' ב-invalid ומעלים את המחרוזת '7' שלצדו.
  assert.throws(() => W.normalizeUids([7, '7']), { code: 'uids-type' });
  assert.throws(() => W.normalizeUids([null]), { code: 'uids-type' });
  assert.deepEqual(W.normalizeUids(['7']), { uids: ['7'], invalid: [] });
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
  // 417 §5: יום מחוץ לחלון שלו (או מחוץ לכיסוי) — סירוב, לא קליטה שקטה.
  assert.throws(() => W.assemble(Object.assign({}, base, {
    windows: [{ from: '2026-09-01', to: '2026-09-02', days: [day('2026-09-01', ['a']), day('2026-09-03', ['a'])] }]
  })), { code: 'window-day-outside' });
  assert.throws(() => W.assemble({
    source: 'publication', range: { from: '2026-09-01', to: '2026-09-05' }, coverage: { from: '2026-09-01', to: '2026-09-02' },
    windows: [{ from: '2026-09-01', to: '2026-09-02', days: [day('2026-09-01', ['a']), day('2026-09-04', ['a'])] }],
    uids: ['a'], roster: ['a']
  }), { code: 'window-day-outside' });
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

test('a uid named __proto__ or constructor is an own key in by_uid and unknown_uids — never inheritance', () => {
  const out = W.assemble({
    source: 'publication', range: { from: '2026-09-01', to: '2026-09-01' }, coverage: { from: '2026-09-01', to: '2026-09-01' },
    windows: [{ from: '2026-09-01', to: '2026-09-01', days: [day('2026-09-01', ['__proto__', 'toString'])] }],
    uids: ['__proto__', 'toString', 'constructor'], roster: ['__proto__', 'toString']
  });
  assert.equal(Object.hasOwn(out.by_uid, '__proto__'), true);
  assert.deepEqual(out.by_uid.__proto__, ['2026-09-01']);
  assert.deepEqual(out.by_uid.toString, ['2026-09-01']);
  assert.equal(Object.hasOwn(out.unknown_uids, 'constructor'), true);
  assert.equal(out.unknown_uids.constructor, 'not-in-roster');
  assert.equal(Object.getPrototypeOf(out.by_uid), Object.prototype, 'הפלט הוא אובייקט רגיל');
  assert.equal(JSON.parse(JSON.stringify(out.by_uid)).__proto__.length, 1, 'roundtrip JSON שומר את המפתח');
  assert.equal(({}).toString === Object.prototype.toString, true);
});

test('419: a source with no schedule at all answers unknown for every day — never a day off, never a crew', () => {
  const out = W.assembleUnknown({
    source: 'legacy', range: { from: '2026-09-01', to: '2026-09-03' },
    uids: ['a', 'stranger', 'bad/uid'], roster: ['a']
  });
  assert.equal(out.coverage, null);
  assert.deepEqual(out.unknown_dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  assert.deepEqual(out.by_uid, { a: [] });
  assert.deepEqual(out.unknown_uids, { stranger: 'not-in-roster', 'bad/uid': 'invalid' });
  assert.deepEqual(out.working, {});
  // תחנה בלי סגל בכלל: כל מי שנשאל עליו — לא בסגל.
  const empty = W.assembleUnknown({ source: 'legacy', range: { from: '2026-09-01', to: '2026-09-01' }, uids: ['a'], roster: [] });
  assert.deepEqual(empty.unknown_uids, { a: 'not-in-roster' });
  assert.deepEqual(empty.by_uid, {});
  assert.throws(() => W.assembleUnknown({ source: 'legacy', range: { from: '2026-01-01', to: '2027-02-02' }, uids: [], roster: [] }), { code: 'range-too-long' });
  assert.throws(() => W.assembleUnknown({ source: 'legacy', range: { from: '2026-01-01', to: '2026-01-02' }, uids: [7], roster: [] }), { code: 'uids-type' });
});

console.log('\n' + passed + ' effective-workdays checks passed.');
