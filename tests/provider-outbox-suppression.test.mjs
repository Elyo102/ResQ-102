import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb, buildRuntime } from './_schedule-fake.mjs';

const reasons = ['global-silence', 'station-silence', 'station-not-ready', 'station-inactive'];
function fixture(kind, result, mutate) {
  const db = createFakeDb();
  const station = 'stations/station_test';
  const path = station + '/' + (kind === 'schedule' ? 'schedule_outbox' : 'guard_outbox') + '/notice';
  db._put(station + '/users/recipient', { station_id: 'station_test', station: 'station_test', active: true, is_active: true, role: 'firefighter' });
  db._put(station + '/schedule_state/runtime', { mode: 'new' });
  db._put(station + '/schedule_state/active', { publication_id: 'publication', revision: 1 });
  db._put(station + '/schedule_publications/publication', { status: 'active', delivery_policy: 'live', delivery_allowed: true });
  db._put(station + '/guards/guard', { status: 'open', revision: 1 });
  db._put(path, { status: 'queued', station_id: 'station_test', attempt: 0, dedupe_key: 'notice', expires_at: '2026-08-26T06:00:00.000Z',
    publication_id: 'publication', revision: 1, person: 'recipient', delivery_policy: 'live', delivery_allowed: true,
    guard_id: 'guard', recipient_uid: 'recipient', kind: 'open', date: '2026-08-25', start: '10:00', end: '12:00' });
  let calls = 0;
  const runtime = buildRuntime(db, { sendPush: async () => {
    calls++;
    if (mutate) mutate(db, path);
    if (result instanceof Error) throw result;
    return result;
  } });
  return { db, path, calls: () => calls, run: () => runtime[kind === 'schedule' ? 'deliverOutbox' : 'deliverGuardOutbox'](db.doc(path)) };
}
for (const kind of ['schedule', 'guard']) {
  for (const reason of reasons) for (const optional of [{}, { failed: false }]) {
    test(`${kind}: terminal ${reason} ${JSON.stringify(optional)}`, async () => {
      const f = fixture(kind, { sent: 0, suppressed: true, reason, ...optional });
      assert.deepEqual(await f.run(), { skipped: true, suppressed: true });
      const saved = f.db._get(f.path);
      assert.equal(f.calls(), 1);
      assert.equal(saved.status, 'cancelled');
      assert.equal(saved.cancel_reason, 'station-policy');
      assert.equal(saved.policy_reason, reason);
      assert.equal(saved.attempt, 0);
      assert.equal(saved.lease_token, null);
      assert.equal(saved.lease_until, null);
      assert.ok(saved.cancelled_at);
      assert.equal('sent_at' in saved, false);
      assert.equal('delivered_devices' in saved, false);
      await f.run();
      assert.equal(f.calls(), 1);
    });
  }
  const valid = { sent: 0, suppressed: true, reason: reasons[0] };
  const invalid = [undefined, { sent: 0 }, new Error('read unavailable'),
    { ...valid, reason: 'station-read-unavailable' }, { ...valid, reason: 'unknown' },
    { sent: 0, suppressed: true }, { ...valid, sent: 1 }, { ...valid, sent: '0' },
    { ...valid, failed: true }, { ...valid, failed: undefined }, { ...valid, error_code: 'READ_FAILED' },
    { ...valid, suppressed: false }, Object.assign(Object.create({ suppressed: true }), { sent: 1, reason: reasons[0] })];
  invalid.forEach((result, i) => test(`${kind}: malformed/unavailable ${i} retries`, async () => {
    const f = fixture(kind, result);
    assert.deepEqual(await f.run(), { sent: false, status: 'retry' });
    const saved = f.db._get(f.path);
    assert.equal(f.calls(), 1);
    assert.equal(saved.status, 'retry');
    assert.equal(saved.attempt, 1);
    assert.equal('sent_at' in saved, false);
    assert.equal('cancel_reason' in saved, false);
    assert.equal('policy_reason' in saved, false);
  }));
  for (const change of [{ lease_token: 'replacement' }, { status: 'cancelled' }]) {
    test(`${kind}: changed ownership ${JSON.stringify(change)} is untouched`, async () => {
      let replacement;
      const f = fixture(kind, valid, (db, path) => {
        replacement = { ...db._get(path), ...change };
        db._put(path, replacement);
      });
      assert.deepEqual(await f.run(), { skipped: true });
      assert.deepEqual(f.db._get(f.path), replacement);
    });
  }
  test(`${kind}: normal success retained`, async () => {
    const f = fixture(kind, { sent: 1 });
    assert.deepEqual(await f.run(), { sent: true });
    assert.equal(f.db._get(f.path).status, 'sent');
    assert.equal(f.db._get(f.path).delivered_devices, 1);
  });
}
