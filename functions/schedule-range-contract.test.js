'use strict';
const assert = require('node:assert/strict');
const subject = require('./schedule-range-contract');

assert.equal(subject.normalizeScheduleRange({ from:'2024-01-01', to:'2024-12-31', people:683 }).days, 366);
assert.equal(subject.normalizeScheduleRange({ from:'2024-02-29', to:'2024-02-29', people:1 }).days, 1);
assert.throws(() => subject.normalizeScheduleRange({ from:'2024-01-01', to:'2025-01-01', people:1 }), /366/);
assert.throws(() => subject.normalizeScheduleRange({ from:'2026-02-29', to:'2026-03-01', people:1 }), /אינו תקין/);
assert.throws(() => subject.normalizeScheduleRange({ from:'2026-03-02', to:'2026-03-01', people:1 }), /אינו תקין/);
assert.throws(
  () => subject.normalizeScheduleRange({ from:'2026-01-01', to:'2026-01-31', people:3001 }),
  (error) => error && error.code === 'people-limit'
);
assert.throws(
  () => subject.normalizeScheduleRange({ from:'2024-01-01', to:'2024-12-31', people:684 }),
  (error) => error && error.code === 'range-capacity'
);
console.log('7 schedule-range contract checks passed.');
