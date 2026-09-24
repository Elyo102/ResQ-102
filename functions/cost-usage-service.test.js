'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./cost-usage-test-harness');
const mod = require('./cost-usage-service');
const { createServerCompletionEvent } = require('./cost-completion-event');
const { req, build, rejects, NOW } = h;
const START = new Date(NOW).toISOString();
const record = (service, entries) => service.recordAttributedCallsBatch(
  entries.map((entry) => ({ occurred_at: START, ...entry }))
);

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('PASS ' + name); }

(async () => {
  h.setClock(NOW);

  await check('service requires dependencies', async () => {
    assert.throws(() => mod.createCostUsageService({}), TypeError);
  });

  await check('unkeyed hasher refuses hashScope and marks disabled_no_hmac_secret', async () => {
    const hasher = mod.createAttributionHasher('');
    assert.equal(hasher.ready, false);
    assert.equal(hasher.status, 'disabled_no_hmac_secret');
    assert.throws(() => hasher.hashScope('uid-1'), (e) => e && e.code === 'attribution-disabled');
    const short = mod.createAttributionHasher('short');
    assert.equal(short.ready, false);
  });

  await check('keyed hasher is HMAC and differs from sha256', async () => {
    const key = 'cost-usage-test-key-32b!!!!';
    const hasher = mod.createAttributionHasher(key);
    const hmac = crypto.createHmac('sha256', key).update('cost-usage-scope-v1|uid-1', 'utf8').digest('hex');
    const sha = crypto.createHash('sha256').update('cost-usage-scope-v1|uid-1', 'utf8').digest('hex');
    assert.equal(hasher.hashScope('uid-1'), hmac);
    assert.notEqual(hmac, sha);
    assert.equal(hasher.ready, true);
  });

  await check('dashboard denies non-super and stale super; saas-admin claim is not enough', async () => {
    const { service } = build();
    await rejects(service.getCostUsageDashboard(req('w1', {})), 'super', 'permission-denied');
    await rejects(service.getCostUsageDashboard(req('saas_admin', {})), 'super', 'permission-denied');
    await rejects(service.getCostUsageDashboard(req('w1', {}, { super: true })), 'super-stale', 'permission-denied');
    h.authUser('super_stale', { customClaims: { role: 'firefighter', stationId: 'eilat' } });
    await rejects(service.getCostUsageDashboard(req('super_stale', {}, { super: true })), 'super-stale', 'permission-denied');
  });

  await check('pane1 actual_cost is unavailable with badge אין מקור and value null never 0', async () => {
    const { service } = build();
    const dash = await service.getCostUsageDashboard(req('super1', { days: 7 }));
    const p = dash.panes.actual_cost;
    assert.equal(p.available, false);
    assert.equal(p.value, null);
    assert.notEqual(p.value, 0);
    assert.equal(p.badge, 'אין מקור');
    assert.equal(p.reason, 'billing_not_connected');
    assert.equal(p.by_service.length, 0);
    assert.equal(p.source, 'billing');
  });

  await check('actual cost only comes from an injected Billing reader after live-super authorization', async () => {
    let reads = 0;
    const { service } = build({ billingReader: { read: async (days) => {
      reads += 1;
      assert.equal(days, 7);
      return { id: 'actual_cost', available: true, source: 'billing_export',
        badge: 'BILLING REPORTED', value: '0.3', currency: 'ILS',
        by_service: [], by_day: [] };
    } } });
    await rejects(service.getCostUsageDashboard(req('w1', { days: 7 })), 'super', 'permission-denied');
    assert.equal(reads, 0);
    const pane = (await service.getCostUsageDashboard(req('super1', { days: 7 }))).panes.actual_cost;
    assert.equal(pane.value, '0.3');
    assert.equal(pane.source, 'billing_export');
    assert.equal(reads, 1);
  });

  await check('pane2 load_attribution is partial metrics_daily never invoice', async () => {
    const { service, sink } = build();
    sink.write('2026-09-18__login_success__42H.33__' + 'a'.repeat(64), 0, { count: 3, ok: 3, fail: 0 }, {
      isNew: true,
      meta: {
        day: '2026-09-18', event_code: 'login_success', release: '42H.33',
        station_hash: 'a'.repeat(64), organization_hash: 'none', keyed: true,
        expires_at: new Date('2026-12-17T00:00:00.000Z')
      }
    });
    const dash = await service.getCostUsageDashboard(req('super1', { days: 1 }));
    const p = dash.panes.load_attribution;
    assert.equal(p.source, 'metrics_daily');
    assert.equal(p.coverage, 'partial');
    assert.equal(p.badge, 'עומס חלקי/לא נמדד');
    assert.equal(p.catalog_size, 15);
    const login = p.features.find((f) => f.feature === 'login_success');
    assert.equal(login.count, 3);
    assert.equal(login.badge, 'שיוך עלות משוער');
    assert.equal(login.invoice, false);
    const empty = p.features.find((f) => f.feature === 'callout_started');
    assert.equal(empty.count, null);
    assert.equal(empty.available, false);
    assert.equal(empty.badge, 'עומס חלקי/לא נמדד');
    assert.ok(p.partial_note_he.includes('PARTIAL'));
  });

  await check('users pane never returns raw uid; call counts omitted when not measured', async () => {
    const { service } = build();
    const dash = await service.getCostUsageDashboard(req('super1', {}));
    const users = dash.panes.users.users;
    assert.ok(users.length >= 2);
    const dump = JSON.stringify(dash);
    assert.ok(!dump.includes('"uid"'));
    assert.ok(!/"w1"|"w2"|"super1"/.test(dump) || dump.includes('display_name'));
    for (const u of users) {
      assert.ok(!('uid' in u));
      assert.equal(u.call_count, null);
      assert.ok(['not_started', 'not_measured', 'attribution_disabled'].includes(u.call_count_coverage));
    }
    assert.equal(dash.measurement.status, 'not_started');
    assert.equal(dash.panes.users.measurement_start_at, null);
    assert.equal(dash.panes.users.coverage, 'not_started');
    assert.equal(dash.feeder.status, 'not_wired');
    assert.equal(dash.panes.users.feeder_status, 'not_wired');
  });

  await check('measurement_start gates call counts; pre-measurement never fakes 0', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    assert.equal(db._get('cost_usage_config/settings').measurement_start_at, START);
    const before = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(before.measurement.status, 'active');
    for (const u of before.panes.users.users) {
      assert.equal(u.call_count, null);
      assert.equal(u.call_count_coverage, 'not_measured');
    }
    await record(service, [{ event_id: 'evt-callout-1', subject_id: 'w1', feature: 'callout_started', calls: 4 }]);
    const after = await service.getCostUsageDashboard(req('super1', {}));
    const named = after.panes.users.users.find((u) => u.display_name === 'עובד א');
    assert.equal(named.call_count, 4);
    assert.equal(named.call_count_coverage, 'since_measurement_start');
    const other = after.panes.users.users.find((u) => u.display_name === 'עובד ב');
    assert.equal(other.call_count, null);
    assert.equal(other.call_count_coverage, 'not_measured');
    const dump = JSON.stringify(after);
    assert.ok(!dump.includes('w1'));
  });

  await check('batch write refuses when HMAC secret missing', async () => {
    const { service } = build({ hashKey: '' });
    assert.equal(service.attributionStatus, 'disabled_no_hmac_secret');
    await rejects(record(service, [{ event_id: 'evt-x', subject_id: 'w1', feature: 'callout_started', calls: 1 }]), 'attribution-disabled', 'failed-precondition');
    const dash = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(dash.attribution.ready, false);
    assert.equal(dash.attribution.status, 'disabled_no_hmac_secret');
  });

  await check('retention daily TTL is 90 days; lifetime collection separate', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const out = await record(service, [{ event_id: 'evt-push-1', subject_id: 'w1', feature: 'push_queued', calls: 2 }]);
    assert.equal(out.retention_days, 90);
    assert.equal(out.ledger_retention_days, 90);
    assert.equal(mod.RETENTION_DAYS, 90);
    const dailyKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_daily/'));
    const lifeKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_lifetime/'));
    const ledgerKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/'));
    assert.equal(dailyKeys.length, 1);
    assert.equal(lifeKeys.length, 1);
    assert.equal(ledgerKeys.length, 1);
    const daily = db._get(dailyKeys[0]);
    assert.equal(daily.expires_at.toISOString(), '2026-12-17T00:00:00.000Z');
    assert.equal(daily.keyed, true);
    assert.ok(!JSON.stringify(daily).includes('w1'));
    const ledger = db._get(ledgerKeys[0]);
    assert.equal(ledger.expires_at.toISOString(), '2026-12-17T00:00:00.000Z');
  });

  await check('bad days / extra input rejected', async () => {
    const { service } = build();
    await rejects(service.getCostUsageDashboard(req('super1', { days: 31 })), 'days', 'invalid-argument');
    await rejects(service.getCostUsageDashboard(req('super1', { days: 7, station_id: 'x' })), 'input', 'invalid-argument');
  });


  await check('last_signin includes date and time (ISO with time)', async () => {
    const { service } = build();
    const dash = await service.getCostUsageDashboard(req('super1', {}));
    const users = dash.panes.users.users;
    assert.ok(users.length >= 1);
    for (const u of users) {
      if (!u.last_signin) continue;
      assert.match(u.last_signin, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.ok(u.last_signin.includes('T'));
      assert.ok(u.last_signin.includes(':'));
    }
  });

  await check('users pane is paginated; lifetime only for visible page', async () => {
    const { service } = build();
    const page1 = await service.getCostUsageDashboard(req('super1', { pageSize: 2 }));
    assert.equal(page1.panes.users.page_size, 2);
    assert.equal(page1.panes.users.users.length, 2);
    assert.equal(page1.panes.users.has_more, true);
    assert.ok(typeof page1.panes.users.next_page_token === 'string');
    const page2 = await service.getCostUsageDashboard(req('super1', {
      pageSize: 2,
      pageToken: page1.panes.users.next_page_token
    }));
    assert.ok(page2.panes.users.users.length >= 1);
    const names1 = page1.panes.users.users.map((u) => u.display_name).join('|');
    const names2 = page2.panes.users.users.map((u) => u.display_name).join('|');
    assert.notEqual(names1, names2);
  });

  await check('idempotent batch: re-run same event_id does not double-count', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const entry = { event_id: 'evt-idem-1', subject_id: 'w1', feature: 'callout_started', calls: 3, source: 'callable_completion' };
    const first = await record(service, [entry]);
    assert.equal(first.written, 1);
    assert.equal(first.skipped_duplicates, 0);
    assert.equal(first.idempotent, true);
    assert.equal(first.atomic, true);
    const second = await record(service, [entry]);
    assert.equal(second.written, 0);
    assert.equal(second.skipped_duplicates, 1);
    const after = await service.getCostUsageDashboard(req('super1', {}));
    const named = after.panes.users.users.find((u) => u.display_name === 'עובד א');
    assert.equal(named.call_count, 3);
    assert.equal(named.call_count_source, 'cost_usage_lifetime_batch');
    const ledgerKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/'));
    assert.equal(ledgerKeys.length, 1);
    assert.ok(db._get('cost_usage_config/batch_cursor'));
  });

  await check('dedicated HMAC key_name is RESQ_COST_USAGE_HASH_KEY; no silent metrics fallback in service', async () => {
    const { service } = build();
    const dash = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(dash.attribution.key_name, 'RESQ_COST_USAGE_HASH_KEY');
    const key = 'cost-usage-test-key-32b!!!!';
    const hasher = mod.createAttributionHasher(key);
    const evt = hasher.hashEvent('evt-1');
    const hmac = crypto.createHmac('sha256', key).update('cost-usage-event-v1|evt-1', 'utf8').digest('hex');
    assert.equal(evt, hmac);
  });

  await check('atomic crash mid-event: re-run does not double-count and reaches consistent state', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const entries = [
      { event_id: 'evt-crash-a', subject_id: 'w1', feature: 'callout_started', calls: 2 },
      { event_id: 'evt-crash-b', subject_id: 'w1', feature: 'callout_started', calls: 5 }
    ];
    // Fail before commit of first event — nothing persisted for that event.
    db._setFailBeforeCommit(1);
    let crashed = null;
    try {
      await record(service, [entries[0]]);
    } catch (e) {
      crashed = e;
    }
    assert.ok(crashed && crashed.code === 'simulated-crash');
    assert.equal([...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/')).length, 0);
    assert.equal([...db._store.keys()].filter((k) => k.startsWith('cost_usage_lifetime/')).length, 0);
    // Re-run both — exactly-once totals.
    const out = await record(service, entries);
    assert.equal(out.written, 2);
    // Simulate crash after first of a multi-event batch committed: fail on 2nd event commit.
    db._setFailBeforeCommit(1);
    try {
      await record(service, [
        { event_id: 'evt-crash-c', subject_id: 'w1', feature: 'callout_started', calls: 1 },
        { event_id: 'evt-crash-d', subject_id: 'w1', feature: 'callout_started', calls: 7 }
      ]);
      assert.fail('expected crash');
    } catch (e) {
      assert.equal(e.code, 'simulated-crash');
    }
    // First of the second batch may or may not have committed depending on fail timing.
    // Re-run the same two — exactly-once.
    const rerun = await record(service, [
      { event_id: 'evt-crash-c', subject_id: 'w1', feature: 'callout_started', calls: 1 },
      { event_id: 'evt-crash-d', subject_id: 'w1', feature: 'callout_started', calls: 7 }
    ]);
    assert.equal(rerun.written + rerun.skipped_duplicates, 2);
    const after = await service.getCostUsageDashboard(req('super1', {}));
    const named = after.panes.users.users.find((u) => u.display_name === 'עובד א');
    // 2+5 +1+7 = 15 exactly (no double count)
    assert.equal(named.call_count, 15);
    const ledgerKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/'));
    assert.equal(ledgerKeys.length, 4);
    // Consistency: every ledger event reflected in lifetime
    let ledgerCalls = 0;
    for (const k of ledgerKeys) ledgerCalls += db._get(k).calls;
    assert.equal(ledgerCalls, 15);
  });

  await check('parallel overlapping event_ids: exactly-once counts', async () => {
    const db = h.fakeDb({ parallelTransactions: true });
    const { service } = build({ db });
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const shared = [
      { event_id: 'evt-par-1', subject_id: 'w1', feature: 'callout_started', calls: 4 },
      { event_id: 'evt-par-2', subject_id: 'w1', feature: 'callout_started', calls: 6 }
    ];
    const onlyA = [{ event_id: 'evt-par-1', subject_id: 'w1', feature: 'callout_started', calls: 4 }];
    const onlyB = [
      { event_id: 'evt-par-2', subject_id: 'w1', feature: 'callout_started', calls: 6 },
      { event_id: 'evt-par-3', subject_id: 'w1', feature: 'callout_started', calls: 1 }
    ];
    const [r1, r2] = await Promise.all([
      record(service, shared),
      record(service, [...onlyA, ...onlyB])
    ]);
    assert.equal(r1.written + r1.skipped_duplicates, 2);
    assert.equal(r2.written + r2.skipped_duplicates, 3);
    const after = await service.getCostUsageDashboard(req('super1', {}));
    const named = after.panes.users.users.find((u) => u.display_name === 'עובד א');
    assert.equal(named.call_count, 11); // 4+6+1
    const ledgerKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/'));
    assert.equal(ledgerKeys.length, 3);
  });

  await check('3000-user board read count stays O(pageSize) not O(N)', async () => {
    const authList = [];
    const profiles = {};
    for (let i = 0; i < 3000; i++) {
      const uid = 'u' + i;
      authList.push({
        uid,
        disabled: false,
        customClaims: { role: 'firefighter', stationId: 'eilat' },
        email: uid + '@example.test',
        displayName: 'User ' + i,
        metadata: { lastSignInTime: '2026-09-17T12:00:00.000Z' }
      });
      profiles[uid] = { full_name: 'User ' + i };
    }
    authList.unshift({
      uid: 'super1', disabled: false, customClaims: { super: true, stationId: 'eilat' },
      email: 'super@example.test', metadata: { lastSignInTime: '2026-09-17T12:00:00.000Z' }
    });
    profiles.super1 = { full_name: 'מנהל על' };
    const db = h.fakeDb();
    // Seed lifetime for all 3000 — reads must still be page-scoped.
    const hasher = mod.createAttributionHasher('cost-usage-test-key-32b!!!!');
    for (let i = 0; i < 3000; i++) {
      const hash = hasher.hashScope('u' + i);
      db._put('cost_usage_lifetime/' + hash, { subject_hash: hash, calls: 1, since_measurement: true });
    }
    const { service, profileReadCount } = build({ db, authList, profiles });
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const readsBefore = db._stats.reads;
    const pageSize = 25;
    const dash = await service.getCostUsageDashboard(req('super1', { pageSize }));
    const readsAfter = db._stats.reads;
    const readDelta = readsAfter - readsBefore;
    assert.equal(dash.panes.users.users.length, pageSize);
    assert.equal(dash.panes.users.has_more, true);
    // Bound: config + pageSize lifetime + pageSize profile gets (+ small slack). Must NOT be O(3000).
    const upper = pageSize * 2 + 26; // user page + global/day shards, not 3000 users
    assert.ok(readDelta <= upper, 'readDelta=' + readDelta + ' expected <= ' + upper);
    assert.ok(readDelta < 300, 'readDelta=' + readDelta + ' must be far below N=3000');
    assert.ok(profileReadCount.n <= pageSize + 1, 'profile reads=' + profileReadCount.n);
    console.log('  readDelta=' + readDelta + ' pageSize=' + pageSize + ' profileReads=' + profileReadCount.n + ' upper=' + upper);
  });

  await check('measurement start is write-once; reset never deletes even 4001 counters', async () => {
    const { service, db } = build();
    const started = await service.setCostUsageMeasurementStart(req('super1', {}));
    assert.equal(started.measurement_start_at, START);
    assert.equal(started.created, true);
    await record(service, [{ event_id: 'evt-lock-1', subject_id: 'w1', feature: 'callout_started', calls: 3 }]);
    for (let i = 0; i < 4001; i++) db._put('cost_usage_lifetime/extra-' + i, { calls: 1 });
    const before = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_lifetime/')).length;
    assert.equal(db._get('cost_usage_config/settings').aggregates_present, true);
    await rejects(
      service.setCostUsageMeasurementStart(req('super1', { measurement_start_at: '2026-09-10T00:00:00.000Z' })),
      'input', 'invalid-argument'
    );
    await rejects(
      service.setCostUsageMeasurementStart(req('super1', { clear: true })),
      'input', 'invalid-argument'
    );
    await rejects(service.setCostUsageMeasurementStart(req('super1', { reset_policy: 'wipe_counters' })), 'input', 'invalid-argument');
    const repeated = await service.setCostUsageMeasurementStart(req('super1', {}));
    assert.equal(repeated.created, false);
    assert.equal(repeated.measurement_start_at, START);
    assert.equal([...db._store.keys()].filter((k) => k.startsWith('cost_usage_lifetime/')).length, before);
    const after = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(after.measurement.measurement_start_at, START);
    assert.equal(after.measurement.coverage.locked_start, START);
  });

  await check('feeder coverage is partial when fresh and delayed when stale', async () => {
    const { service, db } = build();
    db._put('cost_usage_config/feeder', {
      schema: 'cost-usage-feeder-v1', checked_at: START,
      measured_callables: ['getStationScheduleRange', 'getMyAttendanceMonth', 'listHrRequestsInbox'],
      backlog: false
    });
    const empty = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(empty.feeder.status, 'awaiting_sample');
    assert.equal(empty.feeder.live_counts, false);
    db._put('cost_usage_config/feeder', {
      schema: 'cost-usage-feeder-v1', checked_at: START, last_ingested_at: START,
      measured_callables: ['getStationScheduleRange', 'getMyAttendanceMonth', 'listHrRequestsInbox'],
      backlog: false
    });
    const fresh = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(fresh.feeder.status, 'active_partial');
    assert.equal(fresh.feeder.live_counts, true);
    assert.equal(fresh.feeder.measured_callables.length, 3);
    h.setClock(NOW + 16 * 60 * 1000);
    try {
      const stale = await service.getCostUsageDashboard(req('super1', {}));
      assert.equal(stale.feeder.status, 'delayed');
      assert.equal(stale.feeder.live_counts, false);
    } finally { h.setClock(NOW); }
  });

  await check('server completion uses one HMAC boundary, dedupes, and rejects changed replay', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const hasher = mod.createAttributionHasher('cost-usage-test-key-32b!!!!');
    const make = (invocationId, uid = 'w1') => createServerCompletionEvent({
      callable: 'getStationScheduleRange',
      actor: { uid, stationId: 'eilat_102', verification: 'live' },
      invocationId, occurredAt: START, outcome: 'ok', hasher
    });
    const first = make('stable_invocation_0001');
    const second = make('stable_invocation_0002');
    const beforeWrites = db._stats.writes;
    const result = await service.recordServerCompletionEventsBatch([first, second]);
    assert.equal(result.written, 2);
    assert.equal(db._stats.writes - beforeWrites, 12); // config marker + 5/event (including station/global shards) + cursor
    assert.ok(db._get('cost_usage_batch_ledger/' + first.event_id));
    assert.equal(db._get('cost_usage_lifetime/' + first.uid_hash).calls, 2);
    const stationBeforeReplay = [...db._store.entries()].filter(([path]) => path.startsWith('cost_usage_station_daily/'));
    assert.equal(stationBeforeReplay.reduce((n, [, row]) => n + row.calls, 0), 2);
    assert.equal([...db._store.entries()].filter(([path]) => path.startsWith('cost_usage_global_daily/'))
      .reduce((n, [, row]) => n + row.calls, 0), 2);
    const replay = await service.recordServerCompletionEventsBatch([first]);
    assert.equal(replay.skipped_duplicates, 1);
    assert.equal(db._get('cost_usage_lifetime/' + first.uid_hash).calls, 2);
    assert.equal([...db._store.entries()].filter(([path]) => path.startsWith('cost_usage_station_daily/'))
      .reduce((n, [, row]) => n + row.calls, 0), 2);
    await rejects(service.recordServerCompletionEventsBatch([{ ...first, uid_hash: make('stable_invocation_0001', 'w2').uid_hash }]),
      'event-collision', 'failed-precondition');
    await rejects(service.recordServerCompletionEventsBatch([{ ...first, subject_id: 'w1' }]),
      'completion-schema', 'invalid-argument');
  });

  await check('station/day totals include new stations automatically and sum exactly once for super', async () => {
    const { service, db } = build();
    db._put('stations/eilat_102', { active: true });
    db._put('stations/newtown_102', { active: true });
    db._put('stations/quiet_102', { active: true });
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const hasher = mod.createAttributionHasher('cost-usage-test-key-32b!!!!');
    const event = (id, stationId) => createServerCompletionEvent({
      callable: 'getStationScheduleRange', actor: { uid: 'w1', stationId, verification: 'live' },
      invocationId: id, occurredAt: START, outcome: 'ok', hasher
    });
    const rows = [event('station_evt_0001', 'eilat_102'), event('station_evt_0002', 'eilat_102'),
      event('station_evt_0003', 'newtown_102')];
    await service.recordServerCompletionEventsBatch(rows);
    await service.recordServerCompletionEventsBatch([rows[0]]);
    await rejects(service.getCostUsageDashboard(req('w1', { days: 1 })), 'super', 'permission-denied');
    const pane = (await service.getCostUsageDashboard(req('super1', { days: 1 }))).panes.station_calls;
    assert.equal(pane.status, 'partial');
    assert.equal(pane.days[0].total, 3);
    assert.deepEqual(Object.fromEntries(pane.days[0].stations.map(s => [s.station_id, s.calls])),
      { eilat_102: 2, newtown_102: 1, quiet_102: null });
    assert.equal(pane.station_aggregate_start_at, START);
    assert.equal([...db._store.entries()].filter(([path]) => path.startsWith('cost_usage_station_daily/'))
      .reduce((n, [, row]) => n + row.calls, 0), 3);
    // Global total is independent from the registered-station page.
    db._store.delete('stations/newtown_102');
    const afterRemoval = (await service.getCostUsageDashboard(req('super1', { days: 1 }))).panes.station_calls;
    assert.equal(afterRemoval.days[0].total, 3);
    assert.equal(afterRemoval.days[0].stations.some(s => s.station_id === 'newtown_102'), false);
  });

  await check('station totals use Israel midnight in summer and winter without changing UTC user ledgers', async () => {
    const hasher = mod.createAttributionHasher('cost-usage-test-key-32b!!!!');
    for (const [before, after, expectedDay] of [
      ['2026-09-24T20:59:00.000Z', '2026-09-24T21:01:00.000Z', '2026-09-25'],
      ['2026-12-10T21:59:00.000Z', '2026-12-10T22:01:00.000Z', '2026-12-11'],
      ['2026-03-27T20:59:00.000Z', '2026-03-27T21:01:00.000Z', '2026-03-28'],
      ['2026-10-25T21:59:00.000Z', '2026-10-25T22:01:00.000Z', '2026-10-26']
    ]) {
      h.setClock(Date.parse(before));
      const { service, db } = build();
      db._put('stations/eilat_102', { active: true });
      await service.setCostUsageMeasurementStart(req('super1', {}));
      h.setClock(Date.parse(after));
      const event = createServerCompletionEvent({ callable: 'getMyAttendanceMonth',
        actor: { uid: 'w1', stationId: 'eilat_102', verification: 'live' },
        invocationId: 'israel_day_' + expectedDay, occurredAt: after, outcome: 'ok', hasher });
      await service.recordServerCompletionEventsBatch([event]);
      const pane = (await service.getCostUsageDashboard(req('super1', {}))).panes.station_calls;
      assert.equal(pane.selected_day, expectedDay);
      assert.equal(pane.days[0].total, 1);
      assert.equal(pane.days[0].stations[0].calls, 1);
      assert.equal((await service.getCostUsageDashboard(req('super1', { stationDay: expectedDay })))
        .panes.station_calls.days[0].total, 1);
      assert.equal([...db._store.keys()].filter(path => path.startsWith('cost_usage_station_daily/'))[0]
        .startsWith('cost_usage_station_daily/' + expectedDay + '__'), true);
      assert.equal([...db._store.values()].find(row => row.schema === 'cost-usage-batch-ledger-v1').day,
        after.slice(0, 10));
      const replay = await service.recordServerCompletionEventsBatch([event]);
      assert.equal(replay.skipped_duplicates, 1);
    }
    h.setClock(NOW);
  });

  await check('hyphen and leading-digit station IDs pass ingest and dashboard pagination', async () => {
    const { service, db } = build();
    db._put('stations/station-102', { active: true });
    db._put('stations/1_station', { active: true });
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const hasher = mod.createAttributionHasher('cost-usage-test-key-32b!!!!');
    const rows = ['station-102', '1_station'].map((stationId, index) => createServerCompletionEvent({
      callable: 'getMyAttendanceMonth', actor: { uid: 'w1', stationId, verification: 'live' },
      invocationId: 'valid_station_' + String(index).padStart(8, '0'),
      occurredAt: START, outcome: 'ok', hasher
    }));
    await service.recordServerCompletionEventsBatch(rows);
    const pane = (await service.getCostUsageDashboard(req('super1', {}))).panes.station_calls;
    assert.equal(pane.days[0].total, 2);
    assert.deepEqual(Object.fromEntries(pane.days[0].stations.map(row => [row.station_id, row.calls])),
      { '1_station': 1, 'station-102': 1 });
  });

  await check('legacy events never invent station history; late station activation is separately dated', async () => {
    const { service, db } = build();
    db._put('cost_usage_config/settings', { measurement_start_at: new Date(NOW - 3600000).toISOString(),
      aggregates_present: true, schema: 'cost-usage-config-v1' });
    const before = (await service.getCostUsageDashboard(req('super1', { days: 1 }))).panes.station_calls;
    assert.equal(before.status, 'not_started');
    await service.setCostUsageMeasurementStart(req('super1', {}));
    assert.equal(db._get('cost_usage_config/settings').station_aggregate_start_at, START);
    assert.equal(db._get('cost_usage_config/settings').global_aggregate_start_at,
      '2026-09-18T21:00:00.000Z');
    const hasher = mod.createAttributionHasher('cost-usage-test-key-32b!!!!');
    const old = createServerCompletionEvent({ callable: 'getStationScheduleRange',
      actor: { uid: 'w1', stationId: 'eilat_102', verification: 'live' },
      invocationId: 'older_station_0001', occurredAt: new Date(NOW - 1000).toISOString(), outcome: 'ok', hasher });
    await service.recordServerCompletionEventsBatch([old]);
    assert.equal([...db._store.keys()].filter(path => path.startsWith('cost_usage_station_daily/')).length, 0);
    assert.equal([...db._store.keys()].filter(path => path.startsWith('cost_usage_global_daily/')).length, 0);
    const pane = (await service.getCostUsageDashboard(req('super1', { days: 1 }))).panes.station_calls;
    assert.equal(pane.days[0].total, null);
  });

  await check('station shard and user counters roll back together on crash and replay once', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const hasher = mod.createAttributionHasher('cost-usage-test-key-32b!!!!');
    const event = createServerCompletionEvent({ callable: 'getMyAttendanceMonth',
      actor: { uid: 'w1', stationId: 'eilat_102', verification: 'live' },
      invocationId: 'atomic_station_0001', occurredAt: START, outcome: 'ok', hasher });
    db._setFailBeforeCommit(1);
    await assert.rejects(service.recordServerCompletionEventsBatch([event]), /simulated-crash/);
    assert.equal([...db._store.keys()].filter(path => path.startsWith('cost_usage_station_daily/')).length, 0);
    assert.equal([...db._store.keys()].filter(path => path.startsWith('cost_usage_global_daily/')).length, 0);
    assert.equal([...db._store.keys()].filter(path => path.startsWith('cost_usage_batch_ledger/')).length, 0);
    await service.recordServerCompletionEventsBatch([event]);
    const station = (await service.getCostUsageDashboard(req('super1', { days: 1 }))).panes.station_calls;
    assert.equal(station.days[0].total, 1);
    assert.equal([...db._store.entries()].filter(([path]) => path.startsWith('cost_usage_global_daily/'))
      .reduce((n, [, row]) => n + row.calls, 0), 1);
  });

  await check('station page scales beyond 100 stations without scanning history', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    for (let i = 0; i < 3000; i++) db._put('stations/station_' + String(i).padStart(4, '0'), { active: true });
    const before = db._stats.reads;
    const station = (await service.getCostUsageDashboard(req('super1', { days: 1 }))).panes.station_calls;
    const delta = db._stats.reads - before;
    assert.equal(station.status, 'partial');
    assert.equal(station.days[0].stations.length, 25);
    assert.equal(station.next_station_page_token, 'station_0024');
    assert.ok(delta < 500, 'bounded page read delta=' + delta);
    const next = (await service.getCostUsageDashboard(req('super1', {
      stationPageToken: station.next_station_page_token
    }))).panes.station_calls;
    assert.equal(next.days[0].stations[0].station_id, 'station_0025');
    assert.equal(next.days[0].total, null);
    await rejects(service.getCostUsageDashboard(req('super1', { stationPageToken: '../x' })),
      'station-page-token', 'invalid-argument');
    await rejects(service.getCostUsageDashboard(req('super1', { stationDay: '2026-09-31' })),
      'station-day', 'invalid-argument');
    await rejects(service.getCostUsageDashboard(req('super1', { stationDay: '2026-07-01' })),
      'station-day', 'invalid-argument');
  });

  await check('ingest rejects missing, pre-start, future and older-than-window events', async () => {
    const { service, db } = build();
    await rejects(record(service, [{ event_id: 'before-start', subject_id: 'w1', feature: 'callout_started', calls: 1 }]), 'measurement-not-started', 'failed-precondition');
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const base = { subject_id: 'w1', feature: 'callout_started', calls: 1 };
    await rejects(service.recordAttributedCallsBatch([{ ...base, event_id: 'missing-time' }]), 'occurred-at', 'invalid-argument');
    await rejects(record(service, [{ ...base, event_id: 'before', occurred_at: new Date(NOW - 1000).toISOString() }]), 'before-measurement-start', 'failed-precondition');
    await rejects(record(service, [{ ...base, event_id: 'future', occurred_at: new Date(NOW + 1000).toISOString() }]), 'event-age', 'failed-precondition');
    await rejects(record(service, [{ ...base, event_id: 'too-old', occurred_at: new Date(NOW - 31 * 86400000).toISOString() }]), 'event-age', 'failed-precondition');
    assert.equal([...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/')).length, 0);
  });

  await check('expired ledger cannot make an old event count again', async () => {
    const { service, db } = build();
    await service.setCostUsageMeasurementStart(req('super1', {}));
    const entry = { event_id: 'replay-old', subject_id: 'w1', feature: 'callout_started', calls: 2, occurred_at: START };
    await service.recordAttributedCallsBatch([entry]);
    const ledger = [...db._store.keys()].find((k) => k.startsWith('cost_usage_batch_ledger/'));
    db._store.delete(ledger); // model TTL removal before a late replay
    h.setClock(NOW + 91 * 86400000);
    try {
      await rejects(service.recordAttributedCallsBatch([entry]), 'event-age', 'failed-precondition');
    } finally {
      h.setClock(NOW);
    }
    const after = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(after.panes.users.users.find((u) => u.display_name === 'עובד א').call_count, 2);
  });

  await check('pruneExpiredCostUsage removes eligible daily+ledger; lifetime kept', async () => {
    const { service, db } = build();
    const expired = new Date('2026-04-01T00:00:00.000Z');
    db._put('cost_usage_daily/old', { expires_at: expired, calls: 2 });
    db._put('cost_usage_batch_ledger/old', { expires_at: expired, calls: 2 });
    db._put('cost_usage_lifetime/kept', { calls: 2 });
    const dailyKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_daily/'));
    const ledgerKeys = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/'));
    assert.equal(dailyKeys.length, 1);
    // Expired fixtures are pruned; an old event cannot be ingested afresh.
    assert.equal(service.isPruneEligible(db._get(dailyKeys[0]), NOW), true);
    assert.equal(service.isPruneEligible(db._get(ledgerKeys[0]), NOW), true);
    const lifeBefore = [...db._store.keys()].filter((k) => k.startsWith('cost_usage_lifetime/')).length;
    const pruned = await service.pruneExpiredCostUsage({ now: NOW });
    assert.equal(pruned.scheduled, false);
    assert.ok(pruned.removed >= 2);
    assert.equal([...db._store.keys()].filter((k) => k.startsWith('cost_usage_daily/')).length, 0);
    assert.equal([...db._store.keys()].filter((k) => k.startsWith('cost_usage_batch_ledger/')).length, 0);
    assert.equal([...db._store.keys()].filter((k) => k.startsWith('cost_usage_lifetime/')).length, lifeBefore);
    assert.equal(pruned.lifetime_policy, 'keep_while_account_active_explicit_delete');
  });

  await check('feeder_status not_wired documented on dashboard and pane3', async () => {
    const { service } = build();
    const dash = await service.getCostUsageDashboard(req('super1', {}));
    assert.equal(dash.feeder.status, 'not_wired');
    assert.equal(dash.feeder.live_counts, false);
    assert.ok(dash.feeder.note_he.includes('מזין'));
    assert.ok(dash.self_cost_note_he.includes('שיוך למשתמשים אינו חשבונית'));
    assert.equal(dash.panes.users.feeder_status, 'not_wired');
  });

  console.log('\nCost-usage service: ' + passed + ' PASS.');
})().catch((error) => { console.error('FAIL after ' + passed + ' passed:', error); process.exit(1); });
