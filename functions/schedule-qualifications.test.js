'use strict';

/* schedule-qualifications.test · 42H.2 חבילה ב׳ — המודול הטהור. */

const assert = require('node:assert/strict');
const q = require('./schedule-qualifications');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }
function throwsCode(fn, code) {
  let error = null;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, 'expected ' + code);
  assert.equal(error.code, code, error.message);
}

test('the built-in catalog is fixed: nine entries in the mandated order, first three critical', () => {
  const cat = q.mergeCatalog([]);
  assert.deepEqual(cat.map((x) => x.label), ['ראש משמרת', 'סגן', 'קצין', 'מפקדי צוותים', 'נהגים', 'חומ״ס', 'ניטור', 'יל״מ', 'לוחמים']);
  assert.deepEqual(cat.filter((x) => x.critical).map((x) => x.key), ['shift_lead', 'deputy', 'officer']);
  assert.ok(cat.every((x) => x.builtin && x.active && x.minimum === 0 && x.revision === 0));
  assert.deepEqual(q.CRITICAL_KEYS, ['shift_lead', 'deputy', 'officer']);
});

test('stored overrides apply: label, active, minimum, revision; critical of built-ins cannot be overridden; custom entries follow', () => {
  const cat = q.mergeCatalog([
    { key: 'driver', label: 'נהג כבד', active: false, minimum: 2, revision: 3, critical: true },
    { key: 'diver', label: 'צוללן', order: 200, active: true, minimum: 1, revision: 1, critical: true },
    { key: 'BAD KEY', label: 'x' },
    { key: 'shift_lead', minimum: -4 }
  ]);
  const driver = cat.find((x) => x.key === 'driver');
  assert.deepEqual([driver.label, driver.active, driver.minimum, driver.revision, driver.critical, driver.builtin], ['נהג כבד', false, 2, 3, false, true]);
  assert.equal(cat[cat.length - 1].key, 'diver');
  assert.deepEqual([cat[cat.length - 1].critical, cat[cat.length - 1].builtin, cat[cat.length - 1].order], [true, false, 200]);
  assert.equal(cat.find((x) => x.key === 'shift_lead').minimum, 0, 'negative minimum ignored');
  assert.equal(cat.length, 10);
});

test('save: create a custom entry, relabel a built-in, refuse duplicates, bad keys and bad minimums', () => {
  const cat = q.mergeCatalog([]);
  const created = q.normalizeSave({ key: 'diver', label: ' צוללן  ים ', minimum: 1, critical: true, order: 150 }, null, cat);
  assert.deepEqual(created, { key: 'diver', label: 'צוללן ים', order: 150, critical: true, builtin: false, active: true, minimum: 1 });
  const relabel = q.normalizeSave({ key: 'driver', label: 'נהגי כבאיות' }, cat.find((x) => x.key === 'driver'), cat);
  assert.deepEqual([relabel.label, relabel.order, relabel.critical, relabel.builtin, relabel.active], ['נהגי כבאיות', 50, false, true, true]);
  throwsCode(() => q.normalizeSave({ key: 'Diver', label: 'x' }, null, cat), 'qualification-key');
  throwsCode(() => q.normalizeSave({ key: 'diver', label: 'נהגים' }, null, cat), 'qualification-label-duplicate');
  throwsCode(() => q.normalizeSave({ key: 'diver', label: '' }, null, cat), 'qualification-label');
  throwsCode(() => q.normalizeSave({ key: 'diver', label: 'צוללן', minimum: 500 }, null, cat), 'qualification-minimum');
  throwsCode(() => q.normalizeSave({ key: 'driver', critical: true }, cat.find((x) => x.key === 'driver'), cat), 'qualification-critical-fixed');
});

test('disabling a critical built-in needs an explicit confirmation', () => {
  const cat = q.mergeCatalog([]);
  const lead = cat.find((x) => x.key === 'shift_lead');
  throwsCode(() => q.normalizeSave({ key: 'shift_lead', active: false }, lead, cat), 'qualification-critical-disable');
  const off = q.normalizeSave({ key: 'shift_lead', active: false, confirm_critical: true }, lead, cat);
  assert.deepEqual([off.active, off.critical], [false, true]);
  const driverOff = q.normalizeSave({ key: 'driver', active: false }, cat.find((x) => x.key === 'driver'), cat);
  assert.equal(driverOff.active, false);
});

test('custom limit', () => {
  const many = Array.from({ length: q.MAX_CUSTOM }, (_, i) => ({ key: 'c' + i, label: 'מותאמת ' + i, order: 100 + i }));
  const cat = q.mergeCatalog(many);
  throwsCode(() => q.normalizeSave({ key: 'extra', label: 'עוד אחת' }, null, cat), 'qualification-limit');
});

test('delete: never a built-in, never one in use, otherwise allowed', () => {
  const cat = q.mergeCatalog([{ key: 'diver', label: 'צוללן' }]);
  assert.equal(q.deleteBlocker(cat.find((x) => x.key === 'driver'), 0).code, 'qualification-builtin');
  assert.equal(q.deleteBlocker(cat.find((x) => x.key === 'diver'), ['u1', 'u2']).code, 'qualification-in-use');
  assert.equal(q.deleteBlocker(cat.find((x) => x.key === 'diver'), 2).holders, 2);
  assert.equal(q.deleteBlocker(cat.find((x) => x.key === 'diver'), 0), null);
  assert.equal(q.deleteBlocker(null, 0).code, 'qualification-not-found');
});

test('holdings: several per person, catalog order, unknown or inactive refused, limits', () => {
  const cat = q.mergeCatalog([{ key: 'driver', active: false }, { key: 'diver', label: 'צוללן' }]);
  assert.deepEqual(q.normalizeHoldings(['diver', 'firefighter', 'shift_lead', 'firefighter'], cat), ['shift_lead', 'firefighter', 'diver']);
  throwsCode(() => q.normalizeHoldings(['driver'], cat), 'holdings-inactive');
  throwsCode(() => q.normalizeHoldings(['pilot'], cat), 'holdings-unknown');
  throwsCode(() => q.normalizeHoldings('driver', cat), 'holdings-shape');
  throwsCode(() => q.normalizeHoldings(Array.from({ length: q.MAX_PER_PERSON + 1 }, () => 'firefighter'), cat), 'holdings-limit');
  assert.deepEqual(q.normalizeHoldings([], cat), []);
});

test('diff and holder counts', () => {
  assert.deepEqual(q.diffHoldings(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
  assert.deepEqual(q.holdersByKey([{ qualifications: ['a', 'b'] }, { qualifications: ['b'] }, { nope: true }]), { a: 1, b: 2 });
});

console.log('\n' + passed + ' schedule-qualifications unit checks passed.');
