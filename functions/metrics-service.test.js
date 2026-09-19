'use strict';
/* שירות המדדים — בדיקות יחידה על Firestore מזויף ו-sink בזיכרון. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./metrics-test-harness');
const serviceModule = require('./metrics-service');
const { createFirestoreMetricsSink, createFakeMetricsSink, SHARD_COUNT } = require('./metrics-sink');
const { req, build, rid, event, rejects, NOW } = h;

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('PASS ' + name); }
const body = (n, events) => ({ request_id: rid(n), events });
const opsOf = (db) => [...db._store.keys()].filter((p) => p.startsWith('metrics_operations/'));

(async () => {
  h.setClock(NOW);

  await check('unknown event code rejects the whole call with reason event-code', async () => {
    const { service, sink, db } = build();
    await rejects(service.recordMetrics(req('w1', body(1, [event(), { event_code: 'signup' }]))), 'event-code', 'invalid-argument');
    assert.equal(sink.stats.writes, 0); assert.equal(opsOf(db).length, 0);
  });
  await check('extra field in an event rejects the whole call with reason input', async () => {
    const { service, sink } = build();
    await rejects(service.recordMetrics(req('w1', body(1, [event({ note: 'x' })]))), 'input', 'invalid-argument');
    await rejects(service.recordMetrics(req('w1', { request_id: rid(1), events: [event()], extra: 1 })), 'input', 'invalid-argument');
    assert.equal(sink.stats.writes, 0);
  });
  await check('PII-like values are rejected (email, digits, http, ?, Hebrew, long)', async () => {
    const { service } = build();
    for (const bad of [{ screen: 'me@x' }, { release: '0501234567' }, { screen: 'http://x' }, { screen: 'a?b=c' }, { release: 'עברית' }, { screen: 'z'.repeat(33) }]) {
      await rejects(service.recordMetrics(req('w1', body(1, [event(bad)]))), 'input', 'invalid-argument');
    }
  });
  await check('durations are rounded UP to the bucket; raw ms never stored', async () => {
    const { service, sink } = build();
    await service.recordMetrics(req('w1', body(1, [event({ duration_bucket_ms: 101 }), event({ duration_bucket_ms: 250 }), event({ duration_bucket_ms: 70000 })])));
    const rows = await sink.readDaily('2026-09-18', { event_code: 'login_success' });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].shards[0], { count: 3, ok: 3, fail: 0, bucket_250: 2, bucket_30000: 1 });
    assert.ok(!Object.keys(rows[0].shards[0]).includes('bucket_101'));
  });
  await check('station comes from live claims; station_id in the body is rejected', async () => {
    const { service } = build();
    await rejects(service.recordMetrics(req('w1', { request_id: rid(1), events: [event()], station_id: 'haifa' })), 'client-station', 'invalid-argument');
    await rejects(service.recordMetrics(req('w1', { request_id: rid(1), events: [event()], stationId: 'haifa' })), 'client-station', 'invalid-argument');
    await rejects(service.recordMetrics(req('w1', body(1, [event({ station_id: 'haifa' })]))), 'input', 'invalid-argument');
  });
  await check('live claims decide the station even when the signed token says otherwise', async () => {
    const { service, sink } = build();
    await service.recordMetrics(req('w1', body(1, [event()]), { stationId: 'haifa' }));
    const rows = await sink.readDaily('2026-09-18', {});
    assert.equal(rows[0].meta.station_hash, service.hashScope('eilat'));
    assert.notEqual(rows[0].meta.station_hash, service.hashScope('haifa'));
  });
  await check('unauthenticated, disabled and station-less accounts are refused', async () => {
    const { service } = build();
    await rejects(service.recordMetrics(req(null, body(1, [event()]))), 'auth', 'unauthenticated');
    await rejects(service.recordMetrics(req('w_disabled', body(1, [event()]))), 'actor-inactive', 'permission-denied');
    await rejects(service.recordMetrics(req('w_nostation', body(1, [event()]))), 'actor-station', 'permission-denied');
  });
  await check('keyed hashing is HMAC and differs from unkeyed sha256; keyed flag recorded everywhere', async () => {
    const keyed = build({ hashKey: 'k'.repeat(32) });
    const unkeyed = build({ hashKey: '' });
    const hmac = crypto.createHmac('sha256', 'k'.repeat(32)).update('metrics-scope-v1|eilat').digest('hex');
    const sha = crypto.createHash('sha256').update('metrics-scope-v1|eilat').digest('hex');
    assert.equal(keyed.service.hashScope('eilat'), hmac);
    assert.equal(unkeyed.service.hashScope('eilat'), sha);
    assert.notEqual(hmac, sha);
    const a = await keyed.service.recordMetrics(req('w1', body(1, [event()])));
    const b = await unkeyed.service.recordMetrics(req('w1', body(1, [event()])));
    assert.equal(a.keyed, true); assert.equal(b.keyed, false);
    assert.equal((await unkeyed.sink.readDaily('2026-09-18', {}))[0].meta.keyed, false);
    assert.equal((await keyed.sink.readDaily('2026-09-18', {}))[0].meta.keyed, true);
    const quota = [...unkeyed.db._store.entries()].find(([p]) => p.startsWith('metrics_quota/'))[1];
    assert.equal(quota.keyed, false);
    assert.equal(opsOf(unkeyed.db).map((p) => unkeyed.db._get(p).keyed)[0], false);
  });
  await check('raw station, organization and uid never appear in any stored document', async () => {
    const { service, db, sink } = build();
    db._put('organization_station_index/eilat', { organization_id: 'south-org' });
    await service.recordMetrics(req('w1', body(1, [event()])));
    const written = [...db._store.entries()].filter(([p]) => !p.startsWith('organization_station_index/'));
    assert.ok(written.length >= 3);
    const dump = JSON.stringify(written) + JSON.stringify(await sink.readDaily('2026-09-18', {}));
    for (const raw of ['eilat', 'south-org', '"w1"']) assert.ok(!dump.includes(raw), 'raw ' + raw + ' leaked');
    assert.equal((await sink.readDaily('2026-09-18', {}))[0].meta.organization_hash, service.hashScope('south-org'));
  });
  await check('organization falls back to none when no server index exists', async () => {
    const { service, sink } = build();
    await service.recordMetrics(req('w1', body(1, [event()])));
    assert.equal((await sink.readDaily('2026-09-18', {}))[0].meta.organization_hash, 'none');
  });
  await check('quota: 60 calls per uid per day, the 61st is resource-exhausted metrics-quota', async () => {
    const { service, sink } = build();
    for (let i = 1; i <= 60; i++) await service.recordMetrics(req('w1', body(i, [event()])));
    const before = sink.stats.writes;
    await rejects(service.recordMetrics(req('w1', body(61, [event()]))), 'metrics-quota', 'resource-exhausted');
    assert.equal(sink.stats.writes, before);
    await service.recordMetrics(req('w2', body(61, [event()])));
    h.setClock(NOW + 24 * 3600 * 1000);
    const next = await service.recordMetrics(req('w1', body(62, [event()])));
    assert.equal(next.duplicate, false);
    h.setClock(NOW);
  });
  await check('cardinality guard: at most 60 new aggregates per station per day', async () => {
    const { service } = build();
    let n = 0;
    const releases = ['42H.2', '42H.3', '42H.4', '42H.5'];
    const codes = serviceModule.MAX_AGGREGATES_PER_DAY_PER_STATION;
    assert.equal(codes, 60);
    const evs = [];
    for (const r of releases) for (const c of require('./metrics-catalog').EVENT_CODES) evs.push(event({ release: r, event_code: c }));
    for (let i = 0; i < evs.length; i += 20) await service.recordMetrics(req('w1', body(++n, evs.slice(i, i + 20))));
    await rejects(service.recordMetrics(req('w2', body(++n, [event({ release: '42H.6' })]))), 'metrics-cardinality', 'resource-exhausted');
    const again = await service.recordMetrics(req('w2', body(++n, [event({ release: '42H.2' })])));
    assert.equal(again.duplicate, false);
  });
  await check('cardinality is counted per station: another station is unaffected', async () => {
    const { service, db } = build();
    db._put('metrics_quota/st_' + service.hashScope('eilat') + '_2026-09-18', { aggregates_created: 60, aggregate_keys: {} });
    await rejects(service.recordMetrics(req('w1', body(1, [event()]))), 'metrics-cardinality', 'resource-exhausted');
    const ok = await service.recordMetrics(req('w_haifa', body(1, [event()])));
    assert.equal(ok.duplicate, false);
  });
  await check('identical replay returns duplicate:true with no counter writes', async () => {
    const { service, sink, db } = build();
    const first = await service.recordMetrics(req('w1', body(1, [event(), event({ result: 'fail' })])));
    const writes = sink.stats.writes, dbWrites = db._stats.writes;
    const second = await service.recordMetrics(req('w1', body(1, [event(), event({ result: 'fail' })])));
    assert.deepEqual(Object.assign({}, second), { ok: true, duplicate: true, accepted: 2, keyed: true });
    assert.equal(first.duplicate, false);
    assert.equal(sink.stats.writes, writes); assert.equal(db._stats.writes, dbWrites);
    assert.deepEqual((await sink.readDaily('2026-09-18', {}))[0].shards[0], { count: 2, ok: 1, fail: 1, bucket_250: 2 });
  });
  await check('same request id with a different body is already-exists / request-conflict', async () => {
    const { service, sink } = build();
    await service.recordMetrics(req('w1', body(1, [event()])));
    const writes = sink.stats.writes;
    await rejects(service.recordMetrics(req('w1', body(1, [event({ result: 'fail' })]))), 'request-conflict', 'already-exists');
    assert.equal(sink.stats.writes, writes);
  });
  await check('replay is scoped per uid: another account may reuse the id', async () => {
    const { service } = build();
    await service.recordMetrics(req('w1', body(1, [event()])));
    assert.equal((await service.recordMetrics(req('w2', body(1, [event()])))).duplicate, false);
  });
  await check('bad request id and empty or oversized batches are rejected', async () => {
    const { service } = build();
    await rejects(service.recordMetrics(req('w1', { request_id: 'abc', events: [event()] })), 'request-id', 'invalid-argument');
    await rejects(service.recordMetrics(req('w1', body(1, []))), 'input', 'invalid-argument');
    await rejects(service.recordMetrics(req('w1', body(1, Array.from({ length: 21 }, () => event())))), 'input', 'invalid-argument');
    await rejects(service.recordMetrics(req('w1', null)), 'input', 'invalid-argument');
  });
  await check('sharded increments sum correctly across shards and across calls', async () => {
    const { service, sink } = build({ shards: [0, 7, 3, 3] });
    await service.recordMetrics(req('w1', body(1, [event({ duration_bucket_ms: 10 })])));
    await service.recordMetrics(req('w1', body(2, [event({ duration_bucket_ms: 10 })])));
    await service.recordMetrics(req('w2', body(3, [event({ result: 'fail' })])));
    await service.recordMetrics(req('w2', body(4, [event({ result: 'fail', duration_bucket_ms: 0 })])));
    const rows = await sink.readDaily('2026-09-18', {});
    assert.equal(rows.length, 1); assert.equal(rows[0].shards.length, 3);
    const dash = await service.getMetricsDashboard(req('super1', { days: 1 }));
    assert.equal(dash.events.login_success.value, 4);
    assert.equal(dash.events.login_success.ok, 2); assert.equal(dash.events.login_success.fail, 2);
    assert.deepEqual(dash.derived.load_time_buckets.value, { bucket_100: 2, bucket_250: 1, bucket_0: 1 });
  });
  await check('write cost: one shard write per distinct aggregate plus first-touch parent, two quota docs, one operation', async () => {
    const { service, sink, db } = build();
    await service.recordMetrics(req('w1', body(1, [event(), event({ event_code: 'login_failure', result: 'fail' }), event()])));
    assert.equal(sink.stats.writes, 4);   // 2 aggregates x (parent + shard) on first touch
    assert.equal(db._stats.writes, 3);    // uid quota + station quota + operation
    await service.recordMetrics(req('w1', body(2, [event()])));
    assert.equal(sink.stats.writes, 5);   // existing aggregate: shard only
    assert.equal(db._stats.writes, 6);
  });
  await check('dashboard is super-only and re-reads live claims', async () => {
    const { service } = build();
    await rejects(service.getMetricsDashboard(req('w1', {})), 'super', 'permission-denied');
    await rejects(service.getMetricsDashboard(req('w1', {}, { super: true })), 'super-stale', 'permission-denied');
    h.authUser('super_stale', { customClaims: { role: 'firefighter', stationId: 'eilat' } });
    await rejects(service.getMetricsDashboard(req('super_stale', {}, { super: true })), 'super-stale', 'permission-denied');
    await rejects(service.getMetricsDashboard(req('super1', { days: 31 })), 'days', 'invalid-argument');
    await rejects(service.getMetricsDashboard(req('super1', { days: 7, station_id: 'x' })), 'input', 'invalid-argument');
    const dash = await service.getMetricsDashboard(req('super1', {}));
    assert.equal(dash.days, 7); assert.equal(dash.hash_mode, 'none');
  });
  await check('dashboard math: registrations, devices ready, push rate, publish failures, callouts', async () => {
    const { service } = build();
    const evs = [
      event({ event_code: 'onboarding_started' }), event({ event_code: 'onboarding_started' }), event({ event_code: 'onboarding_completed' }),
      event({ event_code: 'device_readiness_completed' }),
      event({ event_code: 'push_delivered' }), event({ event_code: 'push_delivered' }), event({ event_code: 'push_delivered' }), event({ event_code: 'push_failed', result: 'fail' }),
      event({ event_code: 'schedule_publish_completed' }), event({ event_code: 'schedule_publish_completed', result: 'fail' }),
      event({ event_code: 'callout_started' }), event({ event_code: 'callout_started' }), event({ event_code: 'callout_closed' })
    ];
    await service.recordMetrics(req('w1', body(1, evs)));
    const dash = await service.getMetricsDashboard(req('super1', { days: 3 }));
    const d = dash.derived;
    assert.equal(d.registrations_started.value, 2); assert.equal(d.registrations_completed.value, 1);
    assert.equal(d.devices_ready.value, 1);
    assert.equal(d.push_success_rate.value, 0.75); assert.equal(d.push_success_rate.available, true);
    assert.equal(d.schedule_publish_failures.value, 1); assert.equal(d.schedule_publish_failures.total, 2);
    assert.equal(d.callouts_opened.value, 2); assert.equal(d.callouts_closed.value, 1);
    assert.equal(dash.hash_mode, 'keyed'); assert.equal(dash.as_of_day, '2026-09-18');
    for (const m of Object.values(d)) for (const k of ['value', 'available', 'partial', 'stale', 'as_of_day']) assert.ok(k in m, k);
  });
  await check('zero denominator push rate is available:false with null value, never 0', async () => {
    const { service } = build();
    await service.recordMetrics(req('w1', body(1, [event({ event_code: 'push_queued' })])));
    const d = (await service.getMetricsDashboard(req('super1', { days: 1 }))).derived;
    assert.equal(d.push_success_rate.value, null); assert.equal(d.push_success_rate.available, false);
    assert.equal(d.push_success_rate.reason, 'zero-denominator');
    assert.equal(d.registrations_started.value, null); assert.equal(d.registrations_started.available, false);
  });
  await check('active users has no source in this layer: available:false reason no-source', async () => {
    const { service } = build();
    await service.recordMetrics(req('w1', body(1, [event()])));
    const d = (await service.getMetricsDashboard(req('super1', { days: 1 }))).derived;
    assert.deepEqual(Object.assign({}, d.active_users_rate), { value: null, available: false, partial: false, stale: false, as_of_day: null, reason: 'no-source' });
  });
  await check('partial flag when a day read fails; stale flag when the latest day is older than one day', async () => {
    const { service, sink } = build();
    await service.recordMetrics(req('w1', body(1, [event()])));
    h.setClock(NOW + 3 * 24 * 3600 * 1000);
    let dash = await service.getMetricsDashboard(req('super1', { days: 7 }));
    assert.equal(dash.stale, true); assert.equal(dash.events.login_success.stale, true);
    assert.equal(dash.events.login_success.as_of_day, '2026-09-18'); assert.equal(dash.partial, false);
    h.setClock(NOW + 24 * 3600 * 1000);
    dash = await service.getMetricsDashboard(req('super1', { days: 7 }));
    assert.equal(dash.stale, false, 'yesterday is not stale');
    sink._setFailReads(true);
    dash = await service.getMetricsDashboard(req('super1', { days: 2 }));
    assert.equal(dash.partial, true); assert.equal(dash.failed_days.length, 2);
    assert.equal(dash.events.login_success.partial, true); assert.equal(dash.derived.active_users_rate.partial, false);
    sink._setFailReads(false);
    h.setClock(NOW);
  });
  await check('unkeyed aggregates make the dashboard say unkeyed (pseudonymous), never anonymous', async () => {
    const { service } = build({ hashKey: '' });
    await service.recordMetrics(req('w1', body(1, [event()])));
    const dash = await service.getMetricsDashboard(req('super1', { days: 1 }));
    assert.equal(dash.hash_mode, 'unkeyed'); assert.equal(dash.unkeyed_seen, true);
  });
  await check('aggregates carry expires_at = day + 90 days; prune is bounded to 200 per run', async () => {
    const { service, sink } = build();
    await service.recordMetrics(req('w1', body(1, [event()])));
    const row = (await sink.readDaily('2026-09-18', {}))[0];
    assert.equal(row.meta.expires_at.toISOString(), '2026-12-17T00:00:00.000Z');
    assert.equal(serviceModule.RETENTION_DAYS, 90);
    for (let i = 0; i < 250; i++) sink.write('2026-01-01__login_success__42H.20__' + 'a'.repeat(62) + String(i % 100).padStart(2, '0'), 0, { count: 1 }, { isNew: true,
      meta: { day: '2026-01-01', event_code: 'login_success', release: '42H.20', station_hash: 'a'.repeat(64), organization_hash: 'none', keyed: true, expires_at: new Date('2026-04-01T00:00:00.000Z') } });
    const size = sink._size();
    let out = await service.pruneExpired({ now: NOW });
    assert.equal(out.removed, Math.min(200, size - 1)); assert.equal(out.limit, 200);
    out = await service.pruneExpired({ now: NOW, limit: 500 });
    assert.equal(out.limit, 200);
    assert.equal(sink._size(), 1, 'the live aggregate survives');
    assert.equal((await service.pruneExpired({ now: NOW })).removed, 0);
  });
  await check('firestore sink writes parent once and increments shards with merge, inside the transaction', async () => {
    const db = h.fakeDb();
    const sink = createFirestoreMetricsSink({ db, fieldIncrement: h.FieldValue.increment, serverTimestamp: () => 'TS' });
    const { service } = build({ db, sink, shards: [2, 2, 5] });
    await service.recordMetrics(req('w1', body(1, [event(), event({ result: 'fail' })])));
    await service.recordMetrics(req('w1', body(2, [event()])));
    await service.recordMetrics(req('w1', body(3, [event()])));
    const keys = [...db._store.keys()].filter((p) => p.startsWith('metrics_daily/'));
    assert.equal(keys.filter((p) => p.split('/').length === 2).length, 1);
    const parent = db._get(keys.find((p) => p.split('/').length === 2));
    assert.equal(parent.keyed, true); assert.equal(parent.day, '2026-09-18'); assert.ok(parent.expires_at instanceof Date);
    const shard2 = db._get(keys.find((p) => p.endsWith('/shards/2')));
    assert.deepEqual([shard2.count, shard2.ok, shard2.fail, shard2.bucket_250], [3, 2, 1, 3]);
    assert.deepEqual(db._get(keys.find((p) => p.endsWith('/shards/5'))).count, 1);
    const rows = await sink.readDaily('2026-09-18', {});
    assert.equal(rows.length, 1); assert.equal(rows[0].shards.length, 2);
    const dash = await service.getMetricsDashboard(req('super1', { days: 1 }));
    assert.equal(dash.events.login_success.value, 4);
    assert.deepEqual(await sink.listExpired(NOW, 10), []);
    assert.equal((await sink.listExpired(Date.parse('2027-01-01T00:00:00Z'), 10)).length, 1);
    await sink.remove(rows[0].key);
    assert.equal([...db._store.keys()].filter((p) => p.startsWith('metrics_daily/')).length, 0);
  });
  await check('sink refuses malformed keys, shards and increments', async () => {
    const sink = createFakeMetricsSink();
    assert.throws(() => sink.write('bad', 0, { count: 1 }), TypeError);
    assert.throws(() => sink.write('2026-09-18__login_success__42H.20__' + 'a'.repeat(64), SHARD_COUNT, { count: 1 }), TypeError);
    assert.throws(() => sink.write('2026-09-18__login_success__42H.20__' + 'a'.repeat(64), 0, { email: 1 }), TypeError);
    assert.throws(() => sink.write('2026-09-18__login_success__42H.20__' + 'a'.repeat(64), 0, { count: -1 }), TypeError);
  });
  await check('service requires its dependencies and exposes the planning helpers', async () => {
    assert.throws(() => serviceModule.createMetricsService({}), TypeError);
    const groups = serviceModule.planIncrements([
      { event_code: 'login_success', result: 'ok', duration_bucket_ms: 100, release: '42H.20', screen: 'unknown' },
      { event_code: 'login_success', result: 'fail', duration_bucket_ms: null, release: '42H.20', screen: 'unknown' },
      { event_code: 'login_success', result: 'ok', duration_bucket_ms: 100, release: '42H.19', screen: 'unknown' }
    ], '2026-09-18', 'a'.repeat(64));
    assert.equal(groups.size, 2);
    assert.deepEqual(groups.get('2026-09-18__login_success__42H.20__' + 'a'.repeat(64)), { count: 2, ok: 1, fail: 1, bucket_100: 1 });
    const fp = serviceModule.eventsFingerprint([{ event_code: 'login_success', result: 'ok', duration_bucket_ms: 100, release: '42H.20', screen: 'unknown' }]);
    assert.match(fp, /^[a-f0-9]{64}$/);
  });

  console.log('\nMetrics service: ' + passed + ' PASS.');
})().catch((error) => { console.error('FAIL after ' + passed + ' passed:', error); process.exit(1); });
