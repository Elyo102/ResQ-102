'use strict';
const assert = require('assert');
const gateMod = require('./app-check-gate');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}
function memDb(init) {
  const docs = new Map(Object.entries(init || {}));
  const writes = [];
  return {
    doc(path) {
      return {
        async get() {
          const v = docs.get(path);
          return { exists: v !== undefined, data: () => (v && { ...v }) };
        },
        async create(data) {
          if (docs.has(path)) { const e = new Error('exists'); e.code = 6; throw e; }
          docs.set(path, data); writes.push({ path, op: 'create' });
        },
        async set(data, opts) {
          const prev = docs.get(path) || {};
          const next = opts && opts.merge ? Object.assign({}, prev, data) : data;
          docs.set(path, next); writes.push({ path, op: 'set' });
        }
      };
    },
    _docs: docs, _writes: writes
  };
}
console.log('app-check-gate');
check('classify missing/invalid/valid/consumed', () => {
  assert.strictEqual(gateMod.classify({}), 'missing');
  assert.strictEqual(gateMod.classify({ rawRequest: { headers: { 'x-firebase-appcheck': 't' } } }), 'invalid');
  assert.strictEqual(gateMod.classify({ app: { appId: '1' } }), 'valid');
  assert.strictEqual(gateMod.classify({ app: { appId: '1', alreadyConsumed: true } }), 'consumed');
});
check('evaluateExit ready only after 14d + ratio', () => {
  const now = 1_700_000_000_000;
  const short = Array.from({ length: 10 }, () => ({ valid: 1000, missing: 1 }));
  assert.strictEqual(gateMod.evaluateExit(short, now, now - 10 * 86400000).ready, false);
  const ok = Array.from({ length: 14 }, () => ({ valid: 1000, missing: 1 }));
  assert.strictEqual(gateMod.evaluateExit(ok, now, now - 14 * 86400000).ready, true);
});
(async () => {
  await checkAsync('monitor never rejects; no per-attempt Firestore stats write (GAP2)', async () => {
    const db = memDb({});
    const logs = [];
    const g = gateMod.createAppCheckGate({
      db, FV: { increment: (n) => ({ _inc: n }) }, HttpsError,
      log: (e, f) => logs.push(e), now: () => 1_700_000_000_000
    });
    const handler = g.gated('loginWithEmployeeNumber', async () => 'ok');
    const out = await handler({ rawRequest: { headers: {} } });
    assert.strictEqual(out, 'ok');
    // Mode create may write once; stats must NOT be written on hot path before flush interval.
    const statsWrites = db._writes.filter(w => w.path.indexOf('app_check_gate_stats/') === 0);
    assert.strictEqual(statsWrites.length, 0, 'no stats write on attempt');
    assert.ok(logs.includes('app_check_gate'));
    const snap = g._bufferSnapshot();
    assert.strictEqual(snap.totals.missing, 1);
  });
  await checkAsync('partial monitoring never enables enforcement from config alone', async () => {
    const db = memDb({ 'config/app_check_gate': { mode: 'enforce', monitor_since_ms: 1 } });
    const logs = [];
    const g = gateMod.createAppCheckGate({
      db, FV: { increment: (n) => ({ _inc: n }) }, HttpsError, log: (event) => logs.push(event), now: () => 1_700_000_000_000
    });
    const handler = g.gated('loginWithEmployeeNumber', async () => 'ok');
    assert.strictEqual(await handler({}), 'ok');
    assert.ok(logs.includes('app_check_gate_enforce_unavailable'));
    const status = await g.status();
    assert.strictEqual(status.coverage, 'partial_in_memory');
    assert.strictEqual(status.exit.ready, false);
  });
  await checkAsync('day rollover flushes captured previous day, not new buffer', async () => {
    let clock = Date.UTC(2026, 8, 24, 23, 59, 59);
    const db = memDb({});
    const g = gateMod.createAppCheckGate({
      db, FV: { increment: (n) => ({ _inc: n }) }, HttpsError,
      now: () => clock, log: () => {}
    });
    const handler = g.gated('loginWithEmployeeNumber', async () => 'ok');
    await handler({});
    clock += 2000;
    await handler({});
    await g._flush();
    assert.ok(db._docs.has('app_check_gate_stats/2026-09-24'));
    assert.ok(db._docs.has('app_check_gate_stats/2026-09-25'));
  });
  console.log(fail ? ('FAIL ' + fail) : ('PASS ' + pass));
  process.exit(fail ? 1 : 0);
})();
