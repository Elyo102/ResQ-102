import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
const index = fs.readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(new URL('../check.html', import.meta.url), 'utf8');
function load(source) {
  const scheduled = source.match(/exports\.monthlyHrReport = onSchedule\([\s\S]*?\n\}\);/);
  const manual = source.match(/exports\.runReportNow = onCall\([\s\S]*?\n\}\);/);
  assert.ok(scheduled && manual);
  let writes = 0, scans = 0, sends = 0;
  class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const exports = {};
  vm.runInNewContext(scheduled[0] + '\n' + manual[0], { exports, HttpsError,
    onSchedule: (_, fn) => fn, onCall: (_, fn) => fn,
    isSuperAdmin: a => a.token?.super === true, prevMonthKey: () => '2026-08', STATION_ID: 'synthetic',
    buildAndSendMonthly: async () => { sends++; },
    scanMonth: async () => { scans++; return { results: [], cfg: { limit: 200 } }; },
    db: { doc: () => ({ set: async () => { writes++; } }) }, FV: { serverTimestamp: () => 0 }
  });
  return { exports, counts: () => ({ writes, scans, sends }) };
}
async function retired(source) {
  const h = load(source);
  const out = await h.exports.monthlyHrReport();
  assert.equal(out.retired, true); assert.equal(out.replacement, 'hr.html');
  for (const what of [undefined, 'report', 'unknown']) {
    await assert.rejects(() => h.exports.runReportNow({ auth: { token: { super: true } }, data: { what, month: '2026-09' } }),
      e => e.code === 'failed-precondition' && e.message.includes('hr.html'));
  }
  await assert.rejects(() => h.exports.runReportNow({}), e => e.code === 'unauthenticated');
  await assert.rejects(() => h.exports.runReportNow({ auth: { token: {} } }), e => e.code === 'permission-denied');
  assert.deepEqual(h.counts(), { writes: 0, scans: 0, sends: 0 });
}
await retired(index);
const a = index.indexOf("  if (what === 'scan') {", index.indexOf('exports.runReportNow'));
const b = index.indexOf("  throw new HttpsError('failed-precondition', 'דוחות", a);
assert.ok(a > 0 && b > a);
assert.equal(createHash('sha256').update(index.slice(a, b)).digest('hex'), 'f519df7d9cc7be78b80c9fe93506235a0298a2be5bc114d9cf8e2f0f2062200a');
const h = load(index);
const scan = await h.exports.runReportNow({ auth: { token: { super: true } }, data: { what: 'scan', month: '2026-09' } });
assert.equal(scan.ok, true); assert.deepEqual(h.counts(), { writes: 1, scans: 1, sends: 0 });
const click = page.match(/\$\('btnReport'\)\.onclick = \(\) => \{[^\n]+\};/);
assert.ok(click); let destination;
const button = {}; vm.runInNewContext(click[0], { $: () => button, window: { location: { assign: p => { destination = p; } } } });
button.onclick(); assert.equal(destination, 'hr.html');
assert.ok(page.includes('דוחות שעות באפליקציה'));
assert.ok(!page.includes("what: 'report'"));
await assert.rejects(() => retired(index.replace("return { retired: true, replacement: 'hr.html' };", 'await buildAndSendMonthly(prevMonthKey(new Date()));')));
console.log('HR legacy mail retirement: actual scheduler/manual/auth/navigation/scan checks PASS; restored-send mutation caught. No cloud calls.');
