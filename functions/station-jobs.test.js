'use strict';
const assert = require('assert');
const { createStationJobs, DEFAULT_FALLBACK_STATION_ID } = require('./station-jobs');
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}
function memDb(init) {
  const docs = new Map(Object.entries(init || {}));
  return {
    doc(path) {
      return {
        async get() { const v = docs.get(path); return { exists: v !== undefined, data: () => v && { ...v } }; },
        async set(data, opts) {
          const prev = docs.get(path) || {};
          docs.set(path, opts && opts.merge ? Object.assign({}, prev, data) : data);
        }
      };
    }
  };
}
console.log('station-jobs');
(async () => {
  await check('empty enrollment uses Eilat fallback (GAP3)', async () => {
    const alerts = [];
    const logs = [];
    const jobs = createStationJobs({
      db: memDb({}), alert: (e) => alerts.push(e), log: (e) => logs.push(e), HttpsError
    });
    const ran = [];
    const r = await jobs.forEachEnabled('hoursReminder', async (sid) => ran.push(sid));
    assert.deepStrictEqual(ran, [DEFAULT_FALLBACK_STATION_ID]);
    assert.strictEqual(r.ran, 1);
    assert.strictEqual(r.usedFallback, true);
    assert.ok(alerts.includes('station_jobs_empty_enrollment'));
    assert.ok(logs.includes('station_jobs_using_eilat_fallback'));
  });
  await check('explicit empty fallbackStationId runs nothing', async () => {
    const jobs = createStationJobs({
      db: memDb({}), fallbackStationId: '', alert: () => {}, log: () => {}, HttpsError
    });
    const r = await jobs.forEachEnabled('hoursReminder', async () => {});
    assert.strictEqual(r.ran, 0);
    assert.strictEqual(r.usedFallback, false);
  });
  await check('runs enrolled stations and isolates failures', async () => {
    const jobs = createStationJobs({
      db: memDb({ 'config/station_jobs': { enabled_station_ids: ['a_1', 'b_2', 'c_3'] } }),
      log: () => {}, alert: () => {}, HttpsError, batchSize: 2
    });
    const ran = [];
    const r = await jobs.forEachEnabled('hoursReminder', async (sid) => {
      if (sid === 'b_2') throw new Error('boom');
      ran.push(sid);
    });
    assert.deepStrictEqual(ran.sort(), ['a_1', 'c_3']);
    assert.strictEqual(r.ran, 2);
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.usedFallback, false);
  });
  await check('setEnrollment rejects bad ids and writes clean list', async () => {
    const db = memDb({});
    const jobs = createStationJobs({ db, HttpsError, log: () => {}, alert: () => {} });
    const set = jobs.createSetEnrollmentHandler({
      requireFreshSuper: async () => ({ uid: 'super1' }),
      audit: async () => {}
    });
    await assert.rejects(() => set({ data: { enabled_station_ids: ['BAD ID'] } }), e => e instanceof HttpsError);
    const out = await set({ data: { enabled_station_ids: ['eilat_102', 'eilat_102', 'north_7'] } });
    assert.strictEqual(out.count, 2);
  });
  console.log(fail ? ('FAIL ' + fail) : ('PASS ' + pass));
  process.exit(fail ? 1 : 0);
})();
