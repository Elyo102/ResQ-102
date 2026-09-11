'use strict';

const assert = require('node:assert/strict');
const serviceModule = require('./maintenance-service');

let passed = 0;
async function check(name, run) { await run(); passed += 1; console.log('PASS ' + name); }
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }

function fixture(options = {}) {
  const rows = new Map(Object.entries(options.rows || {}));
  const writes = [];
  const healthDocs = options.healthDocs || [];
  const backupDocs = options.backupDocs || [];
  const ref = (path) => ({
    path,
    async get() { return snap(rows.has(path), rows.get(path)); },
    async set(value, settings) {
      const old = rows.get(path) || {};
      rows.set(path, settings && settings.merge ? { ...old, ...value } : { ...value });
      writes.push({ path, value, settings });
    }
  });
  const db = {
    doc: ref,
    collection(path) {
      const docs = path.endsWith('/health') ? healthDocs : backupDocs;
      return {
        orderBy() { return this; }, limit() { return this; },
        async get() { return { empty:docs.length === 0, docs:docs.map((data, i) => ({ id:String(i), data:() => data })) }; }
      };
    },
    async runTransaction(run) {
      const staged = [];
      const tx = {
        get: (item) => item.get(),
        set(item, value, settings) { staged.push({ item, value, settings }); }
      };
      const result = await run(tx);
      for (const item of staged) await item.item.set(item.value, item.settings);
      return result;
    }
  };
  const incidents = options.incidents || [];
  const live = options.live || { disabled:false, customClaims:{ super:true, stationId:'station_102' } };
  const clock = options.clock || (() => Date.parse('2026-09-10T09:00:00.000Z'));
  const incidentLog = { list:async () => incidents };
  const service = serviceModule.createMaintenanceService({ db, incidentLog, clock,
    auth:{ getUser:async () => live }, HttpsError, serverTimestamp:() => ({ server:true }) });
  const request = (data) => ({ auth:{ uid:'super-user', token:{ super:true, stationId:'station_102' } }, data });
  return { service, request, rows, writes };
}
function snap(exists, data) { return { exists, data:() => data || {} }; }
function timestamp(iso) { return { toDate:() => new Date(iso) }; }

(async () => {
  await check('phase one exposes only OFF and OBSERVE', async () => {
    assert.deepEqual(serviceModule.MODES, ['OFF','OBSERVE']);
  });
  await check('disabled live super is denied', async () => {
    const f = fixture({ live:{ disabled:true, customClaims:{ super:true, stationId:'station_102' } } });
    await assert.rejects(() => f.service.getDashboard(f.request()), (error) => error.code === 'permission-denied');
  });
  await check('day cap is derived from the real count field', async () => {
    const f = fixture({ rows:{ 'stations/station_102/incident_days/2026-09-10':{ count:500 } } });
    assert.equal((await f.service.getDashboard(f.request())).counts.dropped, 1);
  });
  await check('bounded open count is always labelled partial after filtering the newest page', async () => {
    const f = fixture({ incidents:[{ code:'functions/unavailable', kind:'callable-failed', count:2,
      last_seen_iso:'2026-09-10T08:59:00.000Z' }] });
    const dto = await f.service.getDashboard(f.request());
    assert.equal(dto.open_count_is_partial, true);
    assert.equal(dto.open_count_scope, 'open_within_newest_200_incidents');
  });
  await check('old health timestamp becomes stale and is returned as ISO only', async () => {
    const f = fixture({ healthDocs:[{ ran_at:timestamp('2026-09-07T03:00:00.000Z'), findings:[] }] });
    const dto = await f.service.getDashboard(f.request());
    assert.equal(dto.last_health_at, '2026-09-07T03:00:00.000Z');
    assert.ok(dto.items.some((item) => item.id === 'health:HEALTH_CHECK_STALE'));
  });
  await check('fresh coded health finding uses finite code without Hebrew parsing', async () => {
    const f = fixture({ healthDocs:[{ ran_at:timestamp('2026-09-10T03:00:00.000Z'), findings:[{ code:'MAIL_DELIVERY_FAILURES', title:'changed copy' }] }] });
    const dto = await f.service.getDashboard(f.request());
    assert.ok(dto.items.some((item) => item.id === 'health:MAIL_DELIVERY_FAILURES'));
    assert.ok(!dto.items.some((item) => item.id === 'health:HEALTH_CHECK_STALE'));
  });
  await check('runtime silence is an operating state and never a technical finding', async () => {
    const f = fixture({ rows:{ 'config/runtime':{ silent:true } }, healthDocs:[{ ran_at:timestamp('2026-09-10T03:00:00.000Z'), findings:[
      { code:'RUNTIME_SILENT_MODE' }, { code:'SNAPSHOT_DATA_LOSS' }
    ] }] });
    const dto = await f.service.getDashboard(f.request());
    assert.equal(dto.operational_state, 'SILENT');
    assert.equal(dto.health_state, 'CRITICAL');
    assert.equal(dto.health_freshness, 'FRESH');
    assert.equal(dto.items.some((row) => row.id === 'health:RUNTIME_SILENT_MODE'), false);
    assert.equal(dto.items.find((row) => row.id === 'health:SNAPSHOT_DATA_LOSS').severity, 'P0');
  });
  await check('fresh clean health stays healthy while runtime is live', async () => {
    const f = fixture({ rows:{ 'config/runtime':{ silent:false } }, healthDocs:[{
      ran_at:timestamp('2026-09-10T03:00:00.000Z'), findings:[]
    }] });
    const dto = await f.service.getDashboard(f.request());
    assert.equal(dto.operational_state, 'LIVE');
    assert.equal(dto.health_state, 'HEALTHY');
    assert.equal(dto.health_freshness, 'FRESH');
    assert.equal(dto.counts.P0, 0);
  });
  await check('missing health evidence is unknown rather than healthy', async () => {
    const f = fixture({ rows:{ 'config/runtime':{ silent:false } } });
    const dto = await f.service.getDashboard(f.request());
    assert.equal(dto.operational_state, 'LIVE');
    assert.equal(dto.health_state, 'UNKNOWN');
    assert.equal(dto.health_freshness, 'MISSING');
  });
  await check('same incident code sums counts instead of keeping the maximum', async () => {
    const incident = (count) => ({ code:'functions/unavailable', kind:'callable-failed', count,
      last_seen_iso:'2026-09-10T08:59:00.000Z', first_screen:'hr', last_version:'42H.10' });
    const f = fixture({ incidents:[incident(2), incident(3)] });
    const item = (await f.service.getDashboard(f.request())).items.find((row) => row.id === 'CALLABLE_UNAVAILABLE');
    assert.equal(item.count, 5);
  });
  await check('mode update uses CAS and preserves unrelated state', async () => {
    const path = 'stations/station_102/maintenance/config';
    const f = fixture({ rows:{ [path]:{ mode:'OFF', revision:2, future_breaker:'keep' } } });
    const dto = await f.service.setMode(f.request({ mode:'OBSERVE', expected_revision:2 }));
    assert.equal(dto.mode, 'OBSERVE'); assert.equal(dto.config_revision, 3);
    assert.equal(f.rows.get(path).future_breaker, 'keep');
    await assert.rejects(() => f.service.setMode(f.request({ mode:'OFF', expected_revision:2 })), (error) => error.code === 'failed-precondition' || error.code === 'aborted');
  });
  await check('analysis cannot write after OFF wins the transaction', async () => {
    const path = 'stations/station_102/maintenance/config';
    const f = fixture({ rows:{ [path]:{ mode:'OFF', revision:1 } } });
    await assert.rejects(() => f.service.runAnalysis(f.request({})), (error) => error.code === 'failed-precondition');
    assert.equal(f.writes.length, 0);
  });
  await check('observe analysis writes only bounded config state and enforces cooldown', async () => {
    const path = 'stations/station_102/maintenance/config';
    const f = fixture({ rows:{ [path]:{ mode:'OBSERVE', revision:1 } } });
    const dto = await f.service.runAnalysis(f.request({}));
    assert.equal(dto.analysis_kind, 'deterministic');
    assert.deepEqual([...new Set(f.writes.map((row) => row.path))], [path]);
    await assert.rejects(() => f.service.runAnalysis(f.request({})), (error) => error.code === 'resource-exhausted');
  });
  console.log('maintenance service: ' + passed + ' passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
