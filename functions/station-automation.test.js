'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('./station-automation');
const { createStationAutomation, normalizeStationIds, CONFIG_PATH } = mod;
const PILOT = 'eilat_102';

function fakeDb(data, exists) {
  const reads = [];
  return {
    reads: reads,
    doc: function (docPath) {
      reads.push(docPath);
      return {
        get: async function () {
          return {
            exists: exists === undefined ? true : exists,
            data: function () { return data; }
          };
        }
      };
    }
  };
}

function fakeClock(step, start) {
  let time = start === undefined ? 1000 : start;
  return function () {
    const value = time;
    time += step === undefined ? 0 : step;
    return value;
  };
}

function build(data, clock, exists) {
  const db = fakeDb(data, exists);
  return {
    db: db,
    api: createStationAutomation({ db: db, clock: clock || fakeClock(0) })
  };
}

test('mode off falls back only to the injected pilot', async () => {
  const { db, api } = build({ mode: 'off', station_ids: ['a_1', 'b_2'] });
  const out = await api.listStations({ pilotStationId: PILOT });
  assert.equal(out.mode, 'off');
  assert.equal(out.source, 'pilot');
  assert.deepEqual(out.stationIds, [PILOT]);
  assert.deepEqual(db.reads, [CONFIG_PATH]);
});

test('an empty shadow list falls back to the injected pilot', async () => {
  const { api } = build({ mode: 'shadow', station_ids: [] });
  const out = await api.listStations({ pilotStationId: 'other_9' });
  assert.deepEqual(out.stationIds, ['other_9']);
});

test('a missing config document falls back to the injected pilot', async () => {
  const { api } = build(null, null, false);
  const out = await api.listStations({ pilotStationId: PILOT });
  assert.deepEqual(out.stationIds, [PILOT]);
});

test('an invalid or missing pilot is rejected', async () => {
  const { api } = build({ mode: 'off', station_ids: [] });
  await assert.rejects(() => api.listStations({ pilotStationId: 'Eilat_102' }),
    (error) => error.code === 'invalid-station');
  await assert.rejects(() => api.listStations({}),
    (error) => error.code === 'invalid-station');
});

test('dedupe preserves first-seen order', async () => {
  const { api } = build({ mode: 'shadow', station_ids: ['b_2', 'a_1', 'b_2'] });
  const out = await api.listStations({ pilotStationId: PILOT });
  assert.deepEqual(out.stationIds, ['b_2', 'a_1']);
});

test('invalid station identifiers are rejected and reported', async () => {
  const invalid = ['Eilat_102', 'eilat_102 ', ' eilat_102', 'eilat.102', 'e', '', 'x'.repeat(81)];
  const { api } = build({ mode: 'shadow', station_ids: invalid.concat(['good_1']) });
  const out = await api.listStations({ pilotStationId: PILOT });
  assert.deepEqual(out.stationIds, ['good_1']);
  assert.equal(out.rejected.length, invalid.length);
});

test('more than 50 stations are visible as station_cap', async () => {
  const ids = [];
  for (let i = 0; i < 53; i += 1) ids.push('st_' + String(i).padStart(3, '0'));
  const { api } = build({ mode: 'shadow', station_ids: ids });
  const seen = [];
  const report = await api.runAllStations({
    pilotStationId: PILOT,
    runStation: async ({ sid }) => { seen.push(sid); }
  });
  assert.equal(seen.length, 50);
  assert.equal(report.counts.total, 53);
  assert.equal(report.counts.not_run, 3);
  assert.deepEqual(report.not_run.map((row) => row.reason),
    ['station_cap', 'station_cap', 'station_cap']);
  assert.equal(report.ok, false);
});

test('stations run sequentially in stable order', async () => {
  const order = [];
  const { api } = build({ mode: 'shadow', station_ids: ['b_2', 'a_1'] });
  const report = await api.runAllStations({
    pilotStationId: PILOT,
    runStation: async ({ sid }) => {
      order.push('start:' + sid);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push('end:' + sid);
      return { private_value: 'must-not-leak' };
    }
  });
  assert.deepEqual(order, ['start:b_2', 'end:b_2', 'start:a_1', 'end:a_1']);
  assert.deepEqual(report.succeeded, ['b_2', 'a_1']);
  assert.equal(JSON.stringify(report).includes('must-not-leak'), false);
  assert.equal(report.ok, true);
});

test('one station failure does not stop the next station', async () => {
  const { api } = build({ mode: 'shadow', station_ids: ['a_1', 'b_2', 'c_3'] });
  const seen = [];
  const report = await api.runAllStations({
    pilotStationId: PILOT,
    runStation: async ({ sid }) => {
      seen.push(sid);
      if (sid === 'b_2') {
        const error = new Error('private person name');
        error.code = 'lease-held';
        throw error;
      }
    }
  });
  assert.deepEqual(seen, ['a_1', 'b_2', 'c_3']);
  assert.deepEqual(report.succeeded, ['a_1', 'c_3']);
  assert.deepEqual(report.failed, [{ station_id: 'b_2', code: 'lease-held' }]);
  assert.equal(JSON.stringify(report).includes('private person name'), false);
  assert.equal(report.ok, false);
});

test('budget exhaustion marks every remaining station', async () => {
  const { api } = build(
    { mode: 'shadow', station_ids: ['a_1', 'b_2', 'c_3', 'd_4'] },
    fakeClock(40000, 0));
  const seen = [];
  const report = await api.runAllStations({
    pilotStationId: PILOT,
    budgetMs: 100000,
    reserveMs: 10000,
    runStation: async ({ sid }) => { seen.push(sid); }
  });
  assert.ok(seen.length >= 1 && seen.length < 4);
  assert.equal(report.budget_exhausted, true);
  assert.equal(report.counts.succeeded + report.counts.not_run, 4);
  assert.deepEqual(report.not_run.map((row) => row.station_id),
    ['a_1', 'b_2', 'c_3', 'd_4'].slice(seen.length));
});

test('summary reports every station exactly once', async () => {
  const { api } = build({ mode: 'shadow', station_ids: ['a_1', 'b_2', 'c_3'] });
  const report = await api.runAllStations({
    pilotStationId: PILOT,
    runStation: async ({ sid }) => {
      if (sid === 'c_3') throw new Error('nope');
    }
  });
  const all = report.succeeded
    .concat(report.failed.map((row) => row.station_id))
    .concat(report.not_run.map((row) => row.station_id));
  assert.deepEqual(all.slice().sort(), ['a_1', 'b_2', 'c_3']);
  assert.equal(new Set(all).size, all.length);
  assert.equal(report.results.length, 3);
  assert.equal(report.failed[0].code, 'internal');
});

test('module contains no hardcoded station identifier or station path', () => {
  const source = fs.readFileSync(path.join(__dirname, 'station-automation.js'), 'utf8');
  assert.equal(/eilat/i.test(source), false);
  assert.equal(/STATION_ID\s*=/.test(source), false);
  assert.equal(/['"`]stations\//.test(source), false);
  assert.ok(source.includes(CONFIG_PATH));
});

test('normalization stays aligned with the current runner contract', () => {
  const raw = ['a_1', 'a_1', 'BAD', 'b_2'];
  const mine = normalizeStationIds(raw).stationIds;
  const runner = Array.from(new Set(raw.map(String)))
    .filter((sid) => /^[a-z0-9_-]{2,80}$/.test(sid))
    .slice(0, 50);
  assert.deepEqual(mine, runner);
});
