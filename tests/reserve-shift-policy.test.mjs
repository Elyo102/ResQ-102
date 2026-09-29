import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { browserPolicy, checkPolicy } from '../reserve-shift-policy-build.mjs';
const require = createRequire(import.meta.url);
checkPolicy();
const policySource = fs.readFileSync(new URL('../functions/reserve-shift-policy.js', import.meta.url), 'utf8');
let checks = 0;
for (const config of [{ creationEnabled: false }, { creationEnabled: true }, null, {}, { creationEnabled: 'true' }, 'MISSING']) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', policySource)(() => {
    if (config === 'MISSING') throw Error('Synthetic missing config'); return config;
  }, module, module.exports);
  const p = module.exports;
  assert.equal(p.creationEnabled, config?.creationEnabled === true);
  const candidate = { day_type: 'reserve_shift' };
  if (!p.creationEnabled) assert.throws(() => p.assertReserveShiftTransition(candidate, null), { code: 'failed-precondition' });
  else p.assertReserveShiftTransition(candidate, null);
  p.assertReserveShiftTransition(candidate, candidate);
  p.assertReserveShiftTransition({ day_type: 'reserve' }, null);
  checks++;
}
for (const creationEnabled of [false, true]) {
  const esm = await import('data:text/javascript;base64,' + Buffer.from(browserPolicy({ creationEnabled })).toString('base64'));
  assert.equal(esm.canSelectReserveShift(undefined), creationEnabled);
  assert.equal(esm.canSelectReserveShift('regular'), creationEnabled);
  assert.equal(esm.canSelectReserveShift('reserve_shift'), true);
  checks++;
}
for (const invalid of [null, {}, { creationEnabled: 'true' }, { creationEnabled: true, extra: 1 }]) {
  assert.throws(() => browserPolicy(invalid)); checks++;
}
const canonical = JSON.parse(fs.readFileSync(new URL('../functions/reserve-shift-policy.json', import.meta.url), 'utf8'));
assert.equal(require('../functions/reserve-shift-policy').creationEnabled, canonical.creationEnabled);
const sw = fs.readFileSync(new URL('../firebase-messaging-sw.js', import.meta.url), 'utf8');
assert.match(sw.match(/const CORE_SHELL = \[([\s\S]*?)\];/)[1], /reserve-shift-policy\.js/);
assert.ok(JSON.parse(fs.readFileSync(new URL('./public-assets.json', import.meta.url))).includes('reserve-shift-policy.js'));
console.log(`Reserve policy: ${checks + 3} checks PASS; actual creationEnabled=${canonical.creationEnabled}`);
