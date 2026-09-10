'use strict';

// Deterministic parity against the ACTUAL browser module, not a second expected
// implementation. Exhaustive over the declared finite categorical matrix and
// every valid minute against boundary anchors; not every possible JSON input.
// These tests do not establish native database/configuration/callable wiring.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const actual = require('./attendance-hours-calculator');
const browserPath = join(__dirname, '..', 'hours.js');
const hash = value => createHash('sha256').update(value).digest('hex');
let browser, initialSource;
before(async () => {
  initialSource = readFileSync(browserPath, 'utf8');
  browser = await import('data:text/javascript;base64,' + Buffer.from(initialSource).toString('base64'));
});
after(() => assert.equal(hash(readFileSync(browserPath, 'utf8')), hash(initialSource), 'Browser calculation source must remain unchanged during parity test'));
function compare(record, fixed, shift) {
  assert.equal(actual.calcHours(record, fixed), browser.calcHours(record, fixed));
  assert.equal(actual.dayTypeHe(record?.day_type), browser.dayTypeHe(record?.day_type));
  assert.equal(actual.reasonWhy(record, fixed, shift), browser.reasonWhy(record, fixed, shift));
}

test('exact current day-type vocabulary and Hebrew labels, including unknown passthrough', () => {
  assert.deepEqual(browser.DAY_TYPES.map(t => t.id), ['regular','swap','extra','meeting','guard','vacation','sick','reserve']);
  for (const type of browser.DAY_TYPES) assert.equal(actual.dayTypeHe(type.id), type.he);
  for (const unknown of [undefined, null, '', 'unknown', 'constructor']) assert.equal(actual.dayTypeHe(unknown), browser.dayTypeHe(unknown));
});
test('exhaustive declared type/shape/offset/site/threshold/segment categorical parity', t => {
  const records = [
    {}, { start:'07:00', end:'19:00' }, { start:'19:00', end:'07:00' }, { start:'07:00', end:'07:00' },
    { start:'00:00', end:'00:01' }, { start:'23:59', end:'00:00' }, { start:'07:00', end:'09:00' },
    { start:'24:00', end:'07:00' }, { start:'07:00', end:'' },
    { start:'07:00', end:'11:00', start2:'18:00', end2:'22:00' },
    { start:'00:00', end:'00:01', start2:'00:03', end2:'00:04' },
    { start:'07:00', end:'19:00', start2:'20:00', end2:'' },
    { start:'07:00', end:'19:00', start2:'bad', end2:'22:00' },
    { start:'07:00', end:'07:00', start2:'07:00', end2:'07:00' }
  ];
  let checked = 0;
  for (const day_type of [...browser.DAY_TYPES.map(t => t.id), 'unknown'])
    for (const shape of [undefined, 'regular', 'continued', 'split'])
      for (const row of records)
        for (const end_day of [undefined, null, '', 0, 1, 2, '1'])
          for (const end_day2 of [undefined, 0, 1, 2])
            for (const fixed of [undefined, 0, 25, '25'])
              for (const shift of [undefined, 24, 24.25, 25]) {
                compare({ ...row, day_type, shape, end_day, end_day2 }, fixed, shift); checked++;
              }
  assert.equal(checked, 225792); t.diagnostic('Exact scalar outputs and Hebrew reasons compared for ' + checked + ' categorical cases.');
});
test('every valid minute as start and end against boundary anchors, with all explicit day offsets', t => {
  const clock = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
  const anchors = [0, 1, 59, 60, 419, 420, 720, 1439]; let checked = 0;
  for (let minute = 0; minute < 1440; minute++) for (const anchor of anchors) for (const end_day of [undefined, 0, 1, 2]) {
    for (const [s, e] of [[minute, anchor], [anchor, minute]]) {
      compare({ day_type:'regular', start:clock(s), end:clock(e), end_day }, 0, 24.25); checked++;
    }
  }
  assert.equal(checked, 92160); t.diagnostic('Compared ' + checked + ' complete minute/anchor/offset cases.');
});
test('minute rounding, split-rounding order, two-day segments and exact Hebrew reasons', () => {
  const oneMinute = { day_type:'regular', start:'00:00', end:'00:01', end_day:0 };
  assert.equal(actual.calcHours(oneMinute, 0), 0.02);
  assert.equal(actual.calcHours({ ...oneMinute, start2:'00:03', end2:'00:04', end_day2:0 }, 0), 0.04);
  assert.equal(actual.calcHours({ ...oneMinute, end:'00:00', end_day:2, start2:'00:00', end2:'00:00', end_day2:2 }, 0), 96);
  assert.equal(actual.reasonWhy({ day_type:'extra' }, 25, 24), 'שעות ידני · נע״ת');
  assert.equal(actual.reasonWhy({ day_type:'swap' }, 25, 24), 'החלפה צרכי מערכת');
  assert.equal(actual.reasonWhy({ day_type:'meeting' }, 25, 24), 'ישיבות');
  assert.equal(actual.reasonWhy({ day_type:'regular', shape:'continued', start:'07:00', end:'09:00', end_day:1 }, 0, 24), 'המשך משמרת');
  const threshold = { day_type:'regular', shape:'regular', start:'07:00', end:'07:10', end_day:1 };
  assert.equal(actual.reasonWhy(threshold, 0, 24), '0.17 שעות מעל המשמרת');
  assert.equal(actual.reasonWhy(threshold, 0, 24.25), '');
});
test('invalid and legacy times preserve null/NaN behavior in pure parity exports', () => {
  const invalid = [undefined, null, '', '7:00', '24:00', '23:60', '-1:00', 'noon', false, 700, [], {}];
  for (const value of invalid) for (const offset of [undefined, null, '', 0, 1, 2, -1, 'wrong', NaN, Infinity]) {
    compare({ day_type:'regular', start:value, end:'07:00', end_day:offset }, 0, 24);
    compare({ day_type:'guard', start:'07:00', end:value, end_day:offset }, 25, 24);
    compare({ day_type:'regular', start:'07:00', end:'19:00', start2:value, end2:'22:00', end_day2:offset }, 0, 24);
  }
  for (const record of [undefined, null, false, {}]) compare(record, 0, 24);
});
test('fixed25 overrides intervals/split but not vacation/sick/reserve; guard does not invent a reason', () => {
  const r = { day_type:'regular', start:'07:00', end:'08:00', start2:'09:00', end2:'10:00' };
  assert.equal(actual.calcHours(r, 25), 25);
  for (const [day_type, expected] of [['vacation',24],['sick',0],['reserve',8.5]]) assert.equal(actual.calcHours({ ...r, day_type }, 25), expected);
  assert.equal(actual.reasonWhy({ ...r, day_type:'guard' }, 25, 24), '');
});

const record = () => ({ day_type:'regular', shape:'regular', start:'07:00', end:'20:00', end_day:0, sub_station:'site_A' });
const config = () => ({ siteById:{ site_A:{ fixed_hours:0, name:'תחנת בדיקה' } }, shiftHours:24 });
test('derived adapter returns exactly canonical derived fields and no caller metadata', () => {
  const r = { ...record(), hours:999, site_name:'spoof', day_type_he:'spoof', reason_required:true, targetRole:'commander' };
  const c = config(), beforeR = structuredClone(r), beforeC = structuredClone(c);
  assert.deepEqual(actual.calculateAttendanceDerived(r, c), { hours:13, day_type_he:'רגיל', site_name:'תחנת בדיקה', reason_required:false });
  assert.deepEqual(r, beforeR); assert.deepEqual(c, beforeC);
  const withFixed = config(); withFixed.siteById.site_A.fixed_hours = 25;
  assert.equal(actual.calculateAttendanceDerived(r, withFixed).hours, 25);
});
test('adapter threshold follows supplied trusted target configuration, not a row/viewer role', () => {
  const r = { ...record(), end:'07:10', end_day:1, role:'commander' };
  assert.equal(actual.calculateAttendanceDerived(r, config()).reason_required, true);
  assert.equal(actual.calculateAttendanceDerived({ ...r, role:'hr_coordinator' }, { ...config(), shiftHours:24.25 }).reason_required, false);
});
test('empty/absent site is zero; nonempty missing and inherited keys never resolve', () => {
  for (const sub_station of ['', undefined, null]) assert.deepEqual(actual.calculateAttendanceDerived({ ...record(), sub_station }, { siteById:{}, shiftHours:24 }),
    { hours:13, day_type_he:'רגיל', site_name:'', reason_required:false });
  for (const sub_station of ['missing', 'toString', '__proto__', 0, false, ['site_A'], {}]) {
    assert.throws(() => actual.calculateAttendanceDerived({ ...record(), sub_station }, config()), TypeError);
  }
  const sites = Object.create(null); sites.__proto__ = { fixed_hours:25, name:'Explicit valid document id' };
  assert.equal(actual.calculateAttendanceDerived({ ...record(), sub_station:'__proto__' }, { siteById:sites, shiftHours:24 }).hours, 25);
});
test('strict derived adapter rejects malformed configuration and incomplete hours, without coercion', () => {
  for (const shiftHours of [undefined, null, 0, -1, NaN, Infinity, '24', [], {}]) {
    assert.throws(() => actual.calculateAttendanceDerived(record(), { ...config(), shiftHours }), TypeError);
  }
  for (const fixed_hours of [undefined, null, -1, NaN, Infinity, '25', false, [], {}]) {
    assert.throws(() => actual.calculateAttendanceDerived(record(), { siteById:{ site_A:{ fixed_hours, name:'site' } }, shiftHours:24 }), TypeError);
  }
  for (const name of [undefined, null, 42, [], {}, 'x'.repeat(501)]) {
    assert.throws(() => actual.calculateAttendanceDerived(record(), { siteById:{ site_A:{ fixed_hours:0, name } }, shiftHours:24 }), TypeError);
  }
  for (const patch of [{ start:'' }, { end:'invalid' }, { end_day:-1 }, { end_day:NaN }, { day_type:undefined }]) {
    assert.throws(() => actual.calculateAttendanceDerived({ ...record(), ...patch }, config()), TypeError);
  }
});
