'use strict';

// Pure synthetic fixtures; no Admin SDK, credentials, network or disk writes.
const assert = require('node:assert/strict');
const { fakeDb, FakeHttpsError } = require('./hr-pilot-test-harness');
const { createHrMonthlySummary, SCHEMA_MONTH } = require('./hr-monthly-summary');
const MONTH = '2026-09';
const GENERATION = 'synthetic_generation';
const header = { schema: SCHEMA_MONTH, active_generation: GENERATION,
  hour_limit: 265, coverage: 'complete', generated_at_ms: 123456 };

function row(index, flag) {
  return { id: 'u' + String(index).padStart(5, '0'), employee_number: 'E' + index,
    full_name: 'Synthetic ' + index, crew: 'A', total_hours: 280,
    ...(flag === undefined ? {} : { over_hour_limit: flag }) };
}
function scenarios() {
  return [
    { name: 'empty', rows: [], queries: 1, reads: 0 },
    { name: '3000 below limit', rows: Array.from({ length: 3000 }, (_, i) => row(i, false)), queries: 1, reads: 0 },
    { name: 'sparse matches', rows: Array.from({ length: 3000 }, (_, i) => row(i, i === 1999 || i === 2999)), queries: 1, reads: 2 },
    { name: '201 matches preserve first 200', rows: Array.from({ length: 201 }, (_, i) => row(i, true)), queries: 2, reads: 200 },
    { name: 'missing null string and numeric flags', rows: [undefined, null, 'true', 1, false, true].map((flag, i) => row(i, flag)), queries: 1, reads: 1 },
    { name: 'two station isolation', rows: [row(0, false), row(1, true)], otherRows: [row(0, true), row(1, true)], queries: 1, reads: 1 }
  ];
}

// Independent legacy-output oracle: full ID-ordered scan, strict boolean filter.
function legacyExpected(rows) {
  const employees = [...rows].sort((a, b) => a.id.localeCompare(b.id))
    .filter(value => value.over_hour_limit === true).slice(0, 200)
    .map(({ employee_number, full_name, crew, total_hours }) =>
      ({ employee_number, full_name, crew, total_hours }));
  return { state: employees.length ? 'over' : 'clear', month: MONTH,
    hour_limit: header.hour_limit, coverage: header.coverage,
    generated_at_ms: header.generated_at_ms, over_employees: employees };
}
function fixtures(sid, rows) {
  const base = 'stations/' + sid + '/hr_monthly_summaries/' + MONTH;
  return [[base, { ...header, station_id: sid }], ...rows.map(({ id, ...value }) =>
    [base + '/hr_monthly_generations/' + GENERATION + '/hr_monthly_rows/' + id, value])];
}

// Count actual returned snapshots, not just output size or query syntax.
function measuredDb(db) {
  const counts = { queries: 0, rowReads: 0, documentReads: 0 };
  const chain = new Set(['collection', 'doc', 'where', 'orderBy', 'limit', 'startAfter']);
  function wrap(target) {
    return new Proxy(target, { get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      if (chain.has(key)) return (...args) => wrap(value.apply(object, args));
      if (key === 'get') return async (...args) => {
        const snapshot = await value.apply(object, args);
        if (Array.isArray(snapshot.docs)) { counts.queries++; counts.rowReads += snapshot.docs.length; }
        else counts.documentReads++;
        return snapshot;
      };
      return value.bind(object);
    } });
  }
  return { db: wrap(db), counts };
}
async function verify(db, scenario, sid) {
  const measured = measuredDb(db);
  const service = createHrMonthlySummary({ db: measured.db, HttpsError: FakeHttpsError });
  const result = await service.overHours({ station_id: sid, month: MONTH });
  assert.deepEqual(result, legacyExpected(scenario.rows), scenario.name + ': legacy output parity');
  assert.deepEqual(measured.counts, { queries: scenario.queries, rowReads: scenario.reads, documentReads: 1 },
    scenario.name + ': query and returned-document budget');
  return measured.counts;
}
async function main() {
  for (const scenario of scenarios()) {
    const db = fakeDb(), sid = 'demo_overhours';
    for (const [path, value] of fixtures(sid, scenario.rows)) db._put(path, value);
    for (const [path, value] of fixtures(sid + '_other', scenario.otherRows || [row(9999, true)])) db._put(path, value);
    const counts = await verify(db, scenario, sid);
    console.log('PASS ' + scenario.name + ' ' + JSON.stringify(counts));
  }
  console.log('hr-overhours-read-budget: 6/6 PASS');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { scenarios, fixtures, verify };
