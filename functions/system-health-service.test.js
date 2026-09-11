'use strict';

const assert = require('node:assert/strict');
const { createSystemHealthService } = require('./system-health-service');

const baseStations = [
  { station_id: 'alpha', silent: false },
  { station_id: 'beta', silent: false }
];
const validFinding = (code = 'CHECK_FAILED') => ({ level: 'warn', code, title: 'כותרת', detail: 'פרט' });

function harness(overrides = {}) {
  let now = 1_000_000;
  const reports = new Map();
  const state = {
    stations: baseStations.map((row) => ({ ...row })),
    cycles: new Map(),
    globalSaves: 0,
    stationScans: [],
    checkpoints: [],
    finished: [],
    published: [],
    released: [],
    writes: []
  };
  const ports = {
    clock: () => now,
    listStations: async () => ({ complete: true, stations: state.stations.map((row) => ({ ...row })) }),
    readGlobalSilent: async () => false,
    readStationSilent: async ({ station_id: stationId }) => {
      const row = state.stations.find((item) => item.station_id === stationId);
      return row ? row.silent === true : false;
    },
    claimCycle: async ({ cycle }) => {
      const prior = state.cycles.get(cycle.cycle_id);
      if (prior && prior.completed) return { acquired: false, completed: true,
        summary: prior.summary, published: prior.published === true };
      if (prior && prior.locked) return { acquired: false };
      const lease = prior || { cursor: null, global_complete: false };
      lease.locked = true;
      lease.lease_token = 'lease_' + cycle.cycle_id;
      state.cycles.set(cycle.cycle_id, lease);
      return { acquired: true, cursor: lease.cursor, global_complete: lease.global_complete,
        global_findings: lease.global_findings || [],
        lease_token: lease.lease_token };
    },
    scanGlobal: async () => [],
    saveGlobal: async ({ cycle_id, findings }) => {
      state.globalSaves += 1;
      state.cycles.get(cycle_id).global_complete = true;
      state.cycles.get(cycle_id).global_findings = findings;
    },
    scanStation: async ({ station }) => { state.stationScans.push(station); now += 10; return []; },
    saveReport: async ({ cycle_id, report }) => {
      const key = cycle_id + '/' + report.station_id;
      if (!reports.has(key) || reports.get(key).ok !== true) reports.set(key, Object.freeze({ ...report }));
      state.writes.push(key);
    },
    checkpoint: async ({ cycle_id, cursor }) => {
      state.cycles.get(cycle_id).cursor = cursor;
      state.checkpoints.push(cursor);
    },
    readReports: async ({ cycle_id }) => [...reports.entries()]
      .filter(([key]) => key.startsWith(cycle_id + '/')).map(([, value]) => value),
    finishCycle: async (input) => {
      state.finished.push(input.summary);
      const cycle = state.cycles.get(input.cycle.cycle_id);
      cycle.completed = ['all_clear', 'findings'].includes(input.summary.verdict);
      cycle.summary = input.summary;
    },
    publishComplete: async (input) => {
      state.published.push(input);
      state.cycles.get(input.cycle.cycle_id).published = true;
    },
    releaseCycle: async ({ cycle_id }) => { state.cycles.get(cycle_id).locked = false; state.released.push(cycle_id); },
    reserve_ms: 100,
    per_station_ms: 20,
    ...overrides
  };
  return { state, reports, ports, service: createSystemHealthService(ports), tick(ms) { now += ms; } };
}

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('ok - ' + name); }

(async () => {
  await test('complete cycle publishes once', async () => {
    const h = harness();
    const result = await h.service.run({ run_id: 'run_20260911_complete', deadline_ms: 1_010_000 });
    assert.equal(result.verdict, 'all_clear');
    assert.equal(result.published, true);
    assert.equal(h.state.stationScans.length, 2);
    assert.equal(h.state.published.length, 1);
  });

  await test('same scheduler run is idempotent after completed reports', async () => {
    const h = harness();
    await h.service.run({ run_id: 'run_20260911_retry', deadline_ms: 1_010_000 });
    const result = await h.service.run({ run_id: 'run_20260911_retry', deadline_ms: 1_010_000 });
    assert.equal(result.verdict, 'all_clear');
    assert.equal(result.resumed, true);
    assert.equal(new Set(h.state.writes).size, 2);
  });

  await test('concurrent duplicate is refused', async () => {
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const h = harness({ scanStation: async ({ station }) => { h.state.stationScans.push(station); await gate; return []; } });
    const first = h.service.run({ run_id: 'run_20260911_overlap', deadline_ms: 1_010_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await h.service.run({ run_id: 'run_20260911_overlap', deadline_ms: 1_010_000 });
    assert.equal(second.verdict, 'already-running');
    unblock();
    await first;
  });

  await test('inventory drift restarts and never publishes', async () => {
    const h = harness({ scanStation: async ({ station }) => {
      h.state.stationScans.push(station);
      if (!h.state.stations.some((row) => row.station_id === 'gamma')) {
        h.state.stations.push({ station_id: 'gamma', silent: false });
      }
      return [];
    } });
    const result = await h.service.run({ run_id: 'run_20260911_drift', deadline_ms: 1_010_000 });
    assert.equal(result.verdict, 'restart_required');
    assert.equal(result.published, false);
    assert.equal(h.state.published.length, 0);
  });

  await test('failed station remains partial', async () => {
    const h = harness({ scanStation: async ({ station }) => {
      if (station.station_id === 'beta') { const error = new Error('timeout'); error.code = 'deadline'; throw error; }
      return [];
    } });
    await assert.rejects(h.service.run({ run_id: 'run_20260911_failure', deadline_ms: 1_010_000 }),
      { code: 'health-cycle-partial' });
    assert.equal(h.state.finished.at(-1).verdict, 'partial');
    assert.deepEqual(h.state.finished.at(-1).missing, ['beta']);
  });

  await test('retry revisits and replaces a transient failed station report', async () => {
    let betaAttempts = 0;
    const h = harness({ scanStation: async ({ station }) => {
      h.state.stationScans.push(station);
      if (station.station_id === 'beta' && ++betaAttempts === 1) {
        const error = new Error('temporary'); error.code = 'unavailable'; throw error;
      }
      return [];
    } });
    await assert.rejects(h.service.run({ run_id: 'run_20260911_repair', deadline_ms: 1_010_000 }),
      { code: 'health-cycle-partial' });
    const result = await h.service.run({ run_id: 'run_20260911_repair', deadline_ms: 1_010_000 });
    assert.equal(result.verdict, 'all_clear');
    assert.equal(betaAttempts, 2);
    assert.equal(h.reports.get('run_20260911_repair/beta').ok, true);
  });

  await test('expired budget performs no station scan and is partial', async () => {
    const h = harness({ per_station_ms: 1_000 });
    await assert.rejects(h.service.run({ run_id: 'run_20260911_budget', deadline_ms: 1_000_500 }),
      { code: 'health-cycle-partial' });
    assert.equal(h.state.stationScans.length, 0);
  });

  await test('incomplete inventory fails before claiming', async () => {
    let claimed = false;
    const h = harness({ listStations: async () => ({ complete: false, stations: [] }),
      claimCycle: async () => { claimed = true; return { acquired: true }; } });
    await assert.rejects(h.service.run({ run_id: 'run_20260911_inventory', deadline_ms: 1_010_000 }),
      { code: 'health-inventory-incomplete' });
    assert.equal(claimed, false);
  });

  await test('global findings must have bounded schema', async () => {
    const h = harness({ scanGlobal: async () => [{ level: 'warn', code: 'BAD', title: '<script>', detail: 'x'.repeat(3000) }] });
    await assert.rejects(h.service.run({ run_id: 'run_20260911_globalbad', deadline_ms: 1_010_000 }), /global findings/);
    assert.equal(h.state.released.length, 1);
  });

  await test('valid global finding changes all-clear to findings', async () => {
    const h = harness({ scanGlobal: async () => [validFinding('RUNTIME_SILENT_MODE')] });
    const result = await h.service.run({ run_id: 'run_20260911_globalfinding', deadline_ms: 1_010_000 });
    assert.equal(result.verdict, 'findings');
    assert.equal(result.findings, 1);
    assert.equal(result.global_findings, 1);
  });

  await test('current station silence is passed to scan', async () => {
    const h = harness({ readGlobalSilent: async () => true });
    await h.service.run({ run_id: 'run_20260911_silent', deadline_ms: 1_010_000 });
    assert.ok(h.state.stationScans.every((row) => row.silent && row.silence_reason === 'global'));
  });

  await test('findings produce conclusive publish', async () => {
    const h = harness({ scanStation: async ({ station }) => station.station_id === 'alpha' ? [validFinding()] : [] });
    const result = await h.service.run({ run_id: 'run_20260911_findings', deadline_ms: 1_010_000 });
    assert.equal(result.verdict, 'findings');
    assert.equal(result.findings, 1);
    assert.equal(result.published, true);
  });

  console.log('system-health-service: ' + passed + ' tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
