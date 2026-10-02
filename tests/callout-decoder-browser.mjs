// Captured snapshots exercise decoding, not Firestore query inclusion/order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './lib/contained-playwright.cjs';
import { createContainedServer } from './lib/localize-worker.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const uid = 'callout-decoder-only';
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json' };
const server = createContainedServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/login.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    return route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(identity => {
    window.__SMOKE_ROLE = 'firefighter';
    window.__SMOKE_UID = identity;
    window.__SMOKE_MODE = 'trial';
    window.__SMOKE_PROFILE_BY_UID = { [identity]:{ full_name:'בודק פענוח', station:'station-102' } };
    window.__CALLOUT_TEST_ALARMS = { audio:0, vibration:0 };
    Object.defineProperty(navigator, 'userActivation', {
      configurable:true, value:{ hasBeenActive:true, isActive:true }
    });
    Object.defineProperty(navigator, 'vibrate', { configurable:true, value:() => {
      window.__CALLOUT_TEST_ALARMS.vibration++; return true;
    } });
    window.Audio = class {
      play() { window.__CALLOUT_TEST_ALARMS.audio++; return Promise.resolve(); }
    };
  }, uid);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/login.html', { waitUntil:'load' });
  await page.locator('#homeView').waitFor({ state:'visible', timeout:10000 });
  await page.waitForFunction(() => Object.entries(window.__FIRESTORE_ACTIVE_PATHS || {})
    .some(([key, count]) => key.endsWith('/callouts') && count === 1));

  const bad = { toString:1, valueOf:1 };
  const row = (id, text, extra = {}) => ({ id, data:{ active:true, uids:[uid], text,
    by_name:'מפקד בדיקה', created_key:new Date().toISOString(), acks:{}, ...extra } });
  async function deliver(rows) {
    assert.equal(await page.evaluate(value =>
      window.__FIRESTORE_DELIVER_CAPTURED('/callouts', value), rows), true);
    assert.deepEqual(errors, [], 'Captured callbacks must not throw browser errors');
  }
  const writes = () => page.evaluate(() => (window.__FIRESTORE_WRITES || [])
    .filter(write => write.path.includes('/callouts/')));
  const alarms = () => page.evaluate(() => window.__CALLOUT_TEST_ALARMS);
  async function shown(text) {
    await page.locator('#coWrap.on').waitFor({ state:'visible' });
    assert.equal(await page.locator('#coText').textContent(), text);
  }
  async function warningOnly() {
    await page.locator('#coWrap.on').waitFor({ state:'visible' });
    const warning = await page.locator('#coText').textContent();
    assert.ok(warning.trim(), 'Malformed body gets a visible warning, not a blank alert');
    assert.ok(!/\[object Object\]|undefined|NaN/.test(warning));
    assert.equal(await page.locator('#coBtns').isHidden(), true, 'Warning is not answerable');
    assert.equal(await page.locator('#coReasonWrap').isHidden(), true);
    assert.equal(await page.locator('#coDone').isHidden(), true);
  }
  await deliver([]);
  assert.deepEqual(await writes(), [], 'Isolated identity must not receive fixture co1');
  const initialAlarms = await alarms();
  const malformed = row('decoder-malformed', bad, {
    by_name:bad, by_role_he:bad, when_he:bad, created_key:bad
  });
  await deliver([malformed]);
  await warningOnly();
  assert.deepEqual(await writes(), [], 'Malformed body must not write a seen or answer receipt');
  assert.deepEqual(await alarms(), initialAlarms, 'Malformed body must not sound an alarm');

  const corrected = row('decoder-malformed', 'תוכן מתוקן באותה קריאה', {
    by_name:bad, by_role_he:bad, when_he:bad, created_key:bad
  });
  await deliver([corrected]);
  await shown(corrected.data.text);
  await page.waitForFunction(() => (window.__FIRESTORE_WRITES || [])
    .filter(write => write.path.includes('/callouts/')).length === 1);
  const seen = (await writes())[0];
  assert.equal(seen.path, 'stations/eilat_102/callouts/decoder-malformed/responses/' + uid);
  assert.deepEqual(Object.keys(seen.value), ['seen_at']);
  assert.equal(typeof seen.value.seen_at, 'string');
  assert.equal(seen.options?.merge, true);
  assert.ok(!/\[object Object\]|undefined/.test(await page.locator('#coFrom').textContent()));
  assert.ok((await alarms()).audio > initialAlarms.audio, 'Valid alert exercises the alarm probe');

  await page.locator('#coNo').click();
  await page.locator('#coReasons button[data-reason="other"]').click();
  const draft = 'טיוטת נימוק שלא נשלחה';
  await page.locator('#coReason').fill(draft);
  const secondMalformed = row('decoder-second-malformed', bad);
  const beforeSiblingAlarms = await alarms();
  await deliver([secondMalformed, corrected]);
  await shown(corrected.data.text);
  assert.equal(await page.locator('#coReason').inputValue(), draft);
  assert.equal(await page.locator('#coReasonWrap').isVisible(), true);
  assert.equal(await page.locator('#coReasons button[data-reason="other"]').getAttribute('aria-pressed'), 'true');
  assert.ok((await page.locator('#coMore').textContent()).trim(), 'Valid sibling retains malformed-row warning');
  assert.equal((await writes()).length, 1, 'Malformed sibling does not add receipts');
  assert.deepEqual(await alarms(), beforeSiblingAlarms, 'Malformed sibling does not re-alarm valid call');

  // Missing timestamps are eligible only at the decoder seam: this does not
  // claim an orderBy(created_key) query returns documents lacking that field.
  const legacy = row('decoder-legacy', 'קריאה ותיקה ללא חותמת');
  delete legacy.data.created_key;
  await deliver([legacy]);
  await shown(legacy.data.text);
  assert.equal((await writes()).length, 2);
  assert.ok((await writes()).every(write => Object.keys(write.value).join(',') === 'seen_at'),
    'No answer was submitted anywhere in this scenario');
  const beforeWarningWrites = await writes();
  const beforeWarningAlarms = await alarms();
  await deliver([secondMalformed]);
  await warningOnly();
  assert.deepEqual(await writes(), beforeWarningWrites);
  assert.deepEqual(await alarms(), beforeWarningAlarms);
  const beforeCloseWrites = await writes();
  const beforeCloseAlarms = await alarms();
  await deliver([{ ...secondMalformed, data:{ ...secondMalformed.data, active:false } }]);
  await page.locator('#coWrap.on').waitFor({ state:'hidden' });
  assert.deepEqual(await writes(), beforeCloseWrites);
  assert.deepEqual(await alarms(), beforeCloseAlarms);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS callout decoder recovery and receipt boundaries');
} finally {
  try { if (browser) await browser.close(); }
  finally {
    if (server.listening) await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}
