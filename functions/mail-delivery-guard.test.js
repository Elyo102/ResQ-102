'use strict';
const assert = require('node:assert/strict');
const { createMailDeliveryGuard } = require('./mail-delivery-guard');
const { stationDeliveryDecision } = require('./station-delivery-fence');
const list = v => (!v ? [] : (Array.isArray(v) ? v : [v]))
  .map(x => String(x || '').trim()).filter(x => x.includes('@'));
const base = { station_id: 'eilat_102', to: ['owner@example.test'],
  message: { subject: 'test', html: '<p>fixture</p>' } };
const clone = v => JSON.parse(JSON.stringify(v));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
function fixture(options = {}) {
  let reads = 0, checks = 0;
  const guard = createMailDeliveryGuard({
    normalizeRecipients: list,
    runtimeFresh: async () => { reads++; if (options.readError) throw Error('offline');
      return options.runtime || { silent: false }; },
    stationFence: { check: async input => { checks++;
      if (options.fenceError) throw Error('offline');
      if (options.verdict) return options.verdict;
      return stationDeliveryDecision({ ...input, exists: true,
        station: options.station || { active: true, silent: false } }); } }
  });
  return { guard, counters: () => ({ reads, checks }) };
}
(async () => {
  await test('dependency contract rejects missing readers', () => {
    assert.throws(() => createMailDeliveryGuard({}), TypeError);
  });
  await test('live scoped job permitted', async () => {
    const { guard } = fixture();
    assert.equal((await guard.check({ original: guard.capture(base), current: base })).allowed, true);
  });
  for (const field of ['to', 'cc', 'bcc', 'message', 'station_id']) {
    await test('pins ' + field, async () => {
      const { guard, counters } = fixture(); const changed = clone(base);
      changed[field] = field === 'message' ? { subject: 'changed' } : field === 'station_id' ? 'foreign_102' : ['other@example.test'];
      const r = await guard.check({ original: guard.capture(base), current: changed });
      assert.equal(r.reason, 'mail-envelope-changed'); assert.equal(r.allowed, false);
      assert.deepEqual(counters(), { reads: 0, checks: 0 });
    });
  }
  await test('cannot remove station scope', async () => {
    const { guard } = fixture(); const changed = clone(base); delete changed.station_id;
    assert.equal((await guard.check({ original: guard.capture(base), current: changed })).reason, 'mail-envelope-changed');
  });
  for (const scope of [null, '', false, 102, '../station']) {
    await test('malformed declared scope ' + JSON.stringify(scope), async () => {
      const { guard, counters } = fixture(); const job = { ...base, station_id: scope };
      assert.equal((await guard.check({ original: guard.capture(job), current: job })).reason, 'mail-station-invalid');
      assert.equal(counters().reads, 0);
    });
  }
  for (const state of ['SUCCESS', 'SUPPRESSED', 'ERROR']) {
    await test('preserves another invocation terminal ' + state, async () => {
      const { guard, counters } = fixture(); const job = { ...base, delivery: { state } };
      const r = await guard.check({ original: guard.capture(base), current: job });
      assert.equal(r.terminal, true); assert.equal(r.allowed, false); assert.equal(counters().reads, 0);
    });
  }
  await test('deleted job never sent', async () => {
    const { guard } = fixture(); const r = await guard.check({ original: guard.capture(base), current: null });
    assert.equal(r.terminal, true); assert.equal(r.allowed, false);
  });
  for (const field of ['to', 'cc', 'bcc']) {
    await test('global policy covers ' + field, async () => {
      const { guard } = fixture({ runtime: { silent: true, silent_allow: ['owner@example.test'] } });
      const job = { ...base, [field]: ['outsider@example.test'] };
      const r = await guard.check({ original: guard.capture(job), current: job });
      assert.equal(r.reason, 'mail-policy-suppressed'); assert.equal(r.allowed, false);
    });
  }
  await test('allowed owner still subject to station silence', async () => {
    const { guard } = fixture({ runtime: { silent: true, silent_allow: ['owner@example.test'] },
      station: { active: true, silent: true } });
    assert.equal((await guard.check({ original: guard.capture(base), current: base })).reason, 'mail-policy-suppressed');
  });
  for (const reason of ['global-silence', 'station-silence', 'station-inactive', 'station-not-ready']) {
    await test('known suppression ' + reason, async () => {
      const { guard } = fixture({ verdict: { allowed: false, reason } });
      const r = await guard.check({ original: guard.capture(base), current: base });
      assert.equal(r.reason, 'mail-policy-suppressed'); assert.equal(r.retryable, false);
    });
  }
  for (const options of [{ readError: true }, { fenceError: true },
    { verdict: { allowed: false, reason: 'station-state-unavailable' } }, { runtime: { silent: 'false' } }]) {
    await test('unavailable policy retry does not grant sending', async () => {
      const { guard } = fixture(options); const r = await guard.check({ original: guard.capture(base), current: base });
      assert.equal(r.allowed, false); assert.equal(r.retryable, true);
    });
  }
  await test('historical unscoped platform job retains policy behavior', async () => {
    const { guard, counters } = fixture({ readError: true }); const job = clone(base); delete job.station_id;
    assert.equal((await guard.check({ original: guard.capture(job), current: job })).allowed, true);
    assert.deepEqual(counters(), { reads: 0, checks: 0 });
  });
  await test('capture has no message plaintext and immutable recipients', () => {
    const { guard } = fixture(); const pin = guard.capture(base);
    assert.equal(Object.isFrozen(pin), true); assert.equal(Object.isFrozen(pin.recipients), true);
    assert.equal(JSON.stringify(pin).includes('fixture'), false);
  });
  console.log('mail-delivery-guard: ' + passed + ' tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
