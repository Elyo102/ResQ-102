'use strict';
// Synthetic, in-process rollback contract. No database or network access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, assertAdmission, policy } = require('./hours-rollout-policy');
const { stampReserveCalculationVersion, calcHours } = require('./attendance-hours-calculator');
const off = Object.freeze({ reserveV2Admission: false, courseApprovalAdmission: false, attendanceOrderAdmission: false });
const on = Object.freeze({ reserveV2Admission: true, courseApprovalAdmission: true, attendanceOrderAdmission: true });
const row = () => ({ day_type: 'reserve_shift', date: '2026-09-30', shape: 'regular', start: '07:00', end: '07:00', end_day: 1, start2: '', end2: '', end_day2: 0 });
const denied = fn => assert.throws(fn, e => e.code === 'failed-precondition');

test('policy rejects malformed schemas and freezes the normalized result', () => {
  for (const input of [undefined, null, [], {}, true, { ...on, extra: true }, { ...on, reserveV2Admission: 'true' }]) {
    assert.deepEqual(normalize(input), off);
    assert.equal(Object.isFrozen(normalize(input)), true);
  }
  assert.deepEqual(normalize(on), on);
  assert.deepEqual(policy, require('./hours-rollout-policy.json'));
  for (const key of Object.keys(on)) { denied(() => assertAdmission(key, off)); assert.doesNotThrow(() => assertAdmission(key, on)); }
  denied(() => assertAdmission('unknown', on));
});

test('rollback blocks new and legacy-upgraded reserve credit without mutating input', () => {
  for (const before of [null, row()]) {
    const next = { ...row(), end: '09:00' }, original = structuredClone(next);
    denied(() => stampReserveCalculationVersion(next, before, off));
    assert.deepEqual(next, original);
  }
});

test('rollback preserves legacy reads and genuine existing v2 edits', () => {
  const legacy = row();
  assert.equal(calcHours(legacy), 24);
  assert.equal(stampReserveCalculationVersion({ ...legacy, notes: 'synthetic' }, legacy, off).reserve_calculation_version, undefined);
  const before = { ...row(), reserve_calculation_version: 2 };
  const next = stampReserveCalculationVersion({ ...before, end: '09:00' }, before, off);
  assert.equal(calcHours(next), 34.5);
});

test('rollback denies regular-to-reserve transition even with a stale stored v2 marker', () => {
  const before = { ...row(), day_type: 'regular', reserve_calculation_version: 2 };
  const next = row();
  denied(() => stampReserveCalculationVersion(next, before, off));
  assert.equal(next.reserve_calculation_version, undefined);
});
