'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCostCompletionOutbox, PAGE_SIZE, MAX_PAGES, MAX_DRAIN_MS } = require('./cost-completion-outbox');
const { createAttributionHasher } = require('./cost-usage-service');

const NOW = Date.parse('2026-09-24T10:00:00.000Z');
function fixture(start = true) {
  let currentTime = NOW;
  const docs = new Map();
  const config = { exists: start, data: () => ({ measurement_start_at: new Date(NOW).toISOString() }) };
  const db = {
    doc: () => ({ get: async () => config }),
    collection: () => ({
      doc(id) { return { async create(value) {
        if (docs.has(id)) throw new Error('already exists');
        docs.set(id, value);
      } }; },
      where(field, op, expected) { return { limit(size) { return { async get() {
        assert.equal(field, 'status'); assert.equal(op, '==');
        return { docs: [...docs].filter(([, value]) => value.status === expected).slice(0, size)
          .map(([id, value]) => ({
            id, data: () => value, ref: {
              delete: async () => docs.delete(id),
              set: async patch => docs.set(id, { ...docs.get(id), ...patch })
            }
          })) };
      } }; } }; }
    })
  };
  const outbox = createCostCompletionOutbox({ db, now: () => currentTime,
    hashKey: 'cost-usage-test-key-32b!!!!', hasherFactory: createAttributionHasher,
    getAuthUser: async uid => ({ uid, disabled: false, customClaims: { stationId: 'eilat_102' } }) });
  const req = { auth: { uid: 'secret-user', token: { stationId: 'eilat_102' } } };
  return { docs, outbox, req, advance: ms => { currentTime += ms; } };
}

test('no measurement start means no outbox event', async () => {
  const { docs, outbox, req } = fixture(false);
  assert.equal(await outbox.recordCompleted('getMyAttendanceMonth', req), null);
  assert.equal(docs.size, 0);
});

test('successful read produces only private HMAC metadata, then drains it', async () => {
  const { docs, outbox, req } = fixture();
  const id = await outbox.recordCompleted('getMyAttendanceMonth', req);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(docs.size, 1);
  assert.ok(!JSON.stringify([...docs.values()]).includes('secret-user'));
  assert.ok(!JSON.stringify([...docs.values()]).includes('token'));
  let ingested;
  const result = await outbox.drain({ recordServerCompletionEventsBatch: async events => { ingested = events; } });
  assert.equal(result.processed, 1);
  assert.equal(docs.size, 0);
  assert.deepEqual(Object.keys(ingested[0]), [
    'schema', 'key_version', 'event_id', 'callable', 'feature', 'occurred_at',
    'outcome', 'uid_hash', 'station_id_at_event'
  ]);
});

test('failed ingest keeps event pending for retry; stale identity is denied', async () => {
  const { docs, outbox, req } = fixture();
  await assert.rejects(outbox.recordCompleted('getMyAttendanceMonth', {
    auth: { uid: req.auth.uid, token: { stationId: 'other' } }
  }), /live station/);
  await outbox.recordCompleted('getMyAttendanceMonth', req);
  await assert.rejects(outbox.drain({ recordServerCompletionEventsBatch: async () => {
    throw new Error('ingest failed');
  } }), /ingest failed/);
  assert.equal(docs.size, 1);
  await outbox.drain({ recordServerCompletionEventsBatch: async () => {} });
  assert.equal(docs.size, 0);
});

test('poison event is blocked without starving the remaining queue', async () => {
  const { docs, outbox, req } = fixture();
  const badId = await outbox.recordCompleted('getMyAttendanceMonth', req);
  docs.set(badId, { ...docs.get(badId), occurred_at: '1900-01-01T00:00:00.000Z' });
  await outbox.recordCompleted('getMyAttendanceMonth', req);
  let accepted = 0;
  const result = await outbox.drain({ recordServerCompletionEventsBatch: async ([event]) => {
    if (event.event_id === badId) throw Object.assign(new Error('expired'), {
      code: 'failed-precondition', details: { reason: 'event-age' }
    });
    accepted += 1;
  } });
  assert.equal(result.blocked, 1);
  assert.equal(result.has_blocked, true);
  assert.equal(result.processed, 1);
  assert.equal(accepted, 1);
  assert.equal(docs.get(badId).status, 'blocked');
  assert.equal(docs.size, 1);
});

test('bounded multi-page drain handles 500 events and leaves an explicit backlog', async () => {
  const { docs, outbox } = fixture();
  for (let i = 0; i < PAGE_SIZE * MAX_PAGES + 1; i++) {
    docs.set('evt-' + i, { status: 'pending', schema: 'resq_server_completion_v1', event_id: 'evt-' + i });
  }
  const first = await outbox.drain({ recordServerCompletionEventsBatch: async () => {} });
  assert.equal(first.processed, PAGE_SIZE * MAX_PAGES);
  assert.equal(first.more, true);
  assert.equal(docs.size, 1);
  const second = await outbox.drain({ recordServerCompletionEventsBatch: async () => {} });
  assert.equal(second.processed, 1);
  assert.equal(second.more, false);
});

test('drain stops inside its time budget and reports a real pending backlog', async () => {
  const { docs, outbox, advance } = fixture();
  for (let i = 0; i < 10; i++) docs.set('slow-' + i, { status: 'pending', event_id: 'slow-' + i });
  const result = await outbox.drain({ recordServerCompletionEventsBatch: async () => {
    advance(80000);
  } });
  assert.equal(result.processed, 3);
  assert.equal(result.more, true);
  assert.equal(result.time_budget_reached, true);
  assert.equal(result.elapsed_ms, MAX_DRAIN_MS);
  assert.equal(docs.size, 7);
});

test('500-event throughput model exposes headroom and queue growth at 480ms/event', async () => {
  const { docs, outbox, advance } = fixture();
  for (let i = 0; i < 500; i++) docs.set('load-' + i, { status: 'pending', event_id: 'load-' + i });
  const pass = await outbox.drain({ recordServerCompletionEventsBatch: async () => advance(400) });
  assert.equal(pass.processed, 500);
  assert.equal(pass.elapsed_ms, 200000);
  assert.equal(pass.more, false);
  for (let i = 0; i < 500; i++) docs.set('slow-' + i, { status: 'pending', event_id: 'slow-' + i });
  const growth = await outbox.drain({ recordServerCompletionEventsBatch: async () => advance(600) });
  assert.equal(growth.processed, 400);
  assert.equal(growth.more, true);
  assert.equal(growth.time_budget_reached, true);
  assert.equal(docs.size, 100);
});
