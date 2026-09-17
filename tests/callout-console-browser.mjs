import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(testsDir, '..'), stub = path.join(testsDir, 'stub');
const serverSource = fs.readFileSync(path.join(root, 'functions', 'index.js'), 'utf8');
const navSource = fs.readFileSync(path.join(root, 'nav.js'), 'utf8');
const alertsSource = fs.readFileSync(path.join(root, 'alerts.html'), 'utf8');
const consoleSource = fs.readFileSync(path.join(root, 'callout-console.js'), 'utf8');

function exported(name) {
  const start = serverSource.indexOf('exports.' + name + ' =');
  assert.notEqual(start, -1, name + ' export exists');
  const next = serverSource.indexOf('\nexports.', start + 1);
  return serverSource.slice(start, next === -1 ? serverSource.length : next);
}

const sendSource = exported('sendCallout');
const closeSource = exported('closeCallout');
assert.match(navSource, /href:\s*'callout\.html',\s*label:\s*'קריאת פתע',\s*who:\s*'shift_command',[^\n]*group:\s*'mine'/);
assert.match(navSource, /who === 'shift_command'[\s\S]*?display\.role === 'commander'\s*\|\|\s*display\.role === 'deputy'/);
assert.doesNotMatch(alertsSource,
  /id=["']coCard["']|id=["']coLiveCard["']|\bsetupCallout\s*\(|\bwatchMyCallouts\s*\(|\bfunction\s+sendCallout\s*\(/);
for (const body of [sendSource, closeSource]) {
  assert.match(body, /await freshCalloutActor\(req\)/,
    'callout handlers must delegate fresh Auth, role, crew and profile verification');
  assert.doesNotMatch(body, /isSuperAdmin\(auth\)/);
}
assert.ok((sendSource.match(/await freshCalloutActor\(req\)/g) || []).length >= 2,
  'send re-verifies the delegated fresh actor after acquiring the delivery lease');
assert.match(sendSource, /crew !== myCrew/);
assert.match(sendSource, /target === 'people' \|\| target === 'station'/);
assert.match(sendSource, /runtimeValue\.silent === true/);
assert.match(sendSource, /intent_fingerprint/);
assert.match(consoleSource, /where\('by_uid', '==', session\.uid\)/);
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon' };
const server = http.createServer((request, response) => {
  let pathname = decodeURIComponent(request.url.split('?')[0]);
  const file = path.join(root, pathname === '/' ? 'callout.html' : pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); response.end('missing'); return; }
  response.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/callout.html';

async function open(browser, role, extra = {}) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const file = path.join(stub, route.request().url().split('/').pop().split('?')[0]);
    route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(({ role, extra }) => {
    window.__SMOKE_ROLE = role; window.__SMOKE_UID = role + '-callout';
    window.__SMOKE_EXTRA_CLAIMS = extra;
    window.confirm = () => true;
  }, { role, extra });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil:'load' });
  return { context, page, errors };
}

const browser = await chromium.launch();
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('✓ ' + name); }
try {
  for (const role of ['firefighter','hr','stcmd']) {
    const run = await open(browser, role);
    await run.page.locator('#denyCard').waitFor({ state:'visible' });
    await check(role + ' fails closed without roster access', async () => {
      assert.equal(await run.page.locator('#work').isVisible(), false);
      const queries = await run.page.evaluate(() => window.__FIRESTORE_QUERIES || []);
      assert.equal(queries.some(item => String(item.path || item.base?.path || '').endsWith('/roster')), false);
      assert.equal((await run.page.evaluate(() => window.__CALLABLE_FACTORIES || [])).includes('sendCallout'), false);
      assert.deepEqual(run.errors, []);
    });
    await run.context.close();
  }

  for (const role of ['commander','deputy']) {
    const run = await open(browser, role);
    await run.page.locator('#work').waitFor({ state:'visible' });
    await check(role + ' sends only the crew from signed claims', async () => {
      await run.page.locator('#calloutText').fill('התייצבות מיידית בתחנה');
      // The shared Firestore stub returns its synthetic incoming callout even
      // when the array-contains constraint would exclude this test UID in
      // production. Invoke the real button handler without letting that
      // unrelated receiver overlay intercept the pointer.
      await run.page.locator('#calloutSend').evaluate(button => button.click());
      await run.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(row => row.name === 'sendCallout'));
      const call = await run.page.evaluate(() => (window.__CALLABLE_CALLS || []).find(row => row.name === 'sendCallout'));
      assert.equal(call.payload.target, 'crew:B');
      assert.equal(call.payload.text, 'התייצבות מיידית בתחנה');
      assert.match(call.payload.request_id, /^[A-Za-z0-9_-]{16,80}$/);
      assert.equal(Object.hasOwn(call.payload, 'uids'), false);
      assert.deepEqual(run.errors, []);
    });
    await run.context.close();
  }

  const retry = await open(browser, 'commander');
  await retry.page.locator('#work').waitFor({ state:'visible' });
  await retry.page.evaluate(() => {
    window.__CALLABLE_PLAN = { sendCallout:[
      { reject:true, code:'functions/unavailable' },
      { data:{ ok:true, id:'same-callout', sent:1 } }
    ] };
  });
  await check('retry keeps the exact request id and creates no second intent', async () => {
    await retry.page.locator('#calloutText').fill('בדיקת שליחה חוזרת');
    await retry.page.locator('#calloutSend').evaluate(button => button.click());
    await retry.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').length === 1);
    await retry.page.locator('#calloutSend').evaluate(button => button.click());
    await retry.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').length === 2);
    const calls = await retry.page.evaluate(() => (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout'));
    assert.equal(calls[0].payload.request_id, calls[1].payload.request_id);
    assert.equal(calls[0].payload.text, calls[1].payload.text);
  });
  await retry.context.close();

  const leased = await open(browser, 'commander');
  await leased.page.locator('#work').waitFor({ state:'visible' });
  await leased.page.evaluate(() => {
    window.__CALLABLE_PLAN = { sendCallout:[
      { data:{ ok:false, retryable:true, in_progress:true, retry_after_ms:500 } },
      { data:{ ok:true, id:'same-callout', sent:1 } }
    ] };
  });
  await check('an active delivery lease auto-retries with the same request id', async () => {
    await leased.page.locator('#calloutText').fill('בדיקת lease פעיל');
    await leased.page.locator('#calloutSend').evaluate(button => button.click());
    await leased.page.locator('#calloutText').evaluate(input => { input.value = 'טקסט אחר שאסור לשלוח'; });
    await leased.page.waitForFunction(() =>
      (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').length === 2,
      null, { timeout:3000 });
    const calls = await leased.page.evaluate(() =>
      (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout'));
    assert.equal(calls[0].payload.request_id, calls[1].payload.request_id);
    assert.equal(calls[0].payload.text, calls[1].payload.text);
    assert.equal(calls[1].payload.text, 'בדיקת lease פעיל');
    assert.equal(await leased.page.locator('#calloutText').inputValue(), 'טקסט אחר שאסור לשלוח');
    assert.equal(await leased.page.locator('#calloutText').isEditable(), true);
  });
  await leased.context.close();

  const closed = await open(browser, 'commander');
  await closed.page.locator('#work').waitFor({ state:'visible' });
  await closed.page.evaluate(() => {
    window.__CALLABLE_PLAN = { sendCallout:[
      { data:{ ok:false, retryable:true, in_progress:true, retry_after_ms:500 } },
      { data:{ ok:false, retryable:false, closed:true } }
    ] };
  });
  await check('a callout closed before retry stops without false success', async () => {
    await closed.page.locator('#calloutText').fill('קריאה שנסגרה בזמן מסירה');
    await closed.page.locator('#calloutSend').evaluate(button => button.click());
    await closed.page.waitForFunction(() =>
      (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').length === 2,
      null, { timeout:3000 });
    await closed.page.waitForFunction(() =>
      document.querySelector('#calloutMessage')?.textContent.includes('הקריאה כבר נסגרה'));
    const calls = await closed.page.evaluate(() =>
      (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].payload.request_id, calls[1].payload.request_id);
    assert.equal(await closed.page.locator('#calloutText').isEditable(), true);
    assert.equal(await closed.page.locator('#calloutText').inputValue(), 'קריאה שנסגרה בזמן מסירה');
    const status = await closed.page.locator('#calloutMessage').textContent();
    assert.match(status, /הקריאה כבר נסגרה ולא נשלחה שוב/);
    assert.doesNotMatch(status, /הקריאה נשלחה ל/);
    await closed.page.waitForTimeout(650);
    assert.equal(await closed.page.evaluate(() =>
      (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').length), 2);
  });
  await closed.context.close();

  const recovered = await open(browser, 'commander');
  await recovered.page.locator('#work').waitFor({ state:'visible' });
  const delivered = await recovered.page.evaluate(() => {
    window.__CALLABLE_PLAN = { sendCallout:[{ data:{ ok:true, id:'recovered-callout', sent:1 } }] };
    const rows = [{ id:'recovered-callout', data:{
      by_uid:'commander-callout', target:'crew:B', target_he:'משמרת ב', crew:'B',
      text:'קריאה ששוחזרה לאחר רענון', uids:['u4'], active:true,
      request_id:'resume_request_id_123456', delivery_state:'partial',
      delivery_failed_uids:['u4'], created_key:new Date().toISOString()
    } }];
    const first = window.__FIRESTORE_DELIVER_CAPTURED('/callouts', rows, { oldest:true });
    const last = window.__FIRESTORE_DELIVER_CAPTURED('/callouts', rows);
    return first && last;
  });
  assert.equal(delivered, true);
  await check('an owned partial callout is resumed after page-state loss', async () => {
    await recovered.page.waitForFunction(() =>
      (window.__CALLABLE_CALLS || []).some(x => x.name === 'sendCallout'),
      null, { timeout:3000 });
    const call = await recovered.page.evaluate(() =>
      (window.__CALLABLE_CALLS || []).find(x => x.name === 'sendCallout'));
    assert.equal(call.payload.request_id, 'resume_request_id_123456');
    assert.equal(call.payload.text, 'קריאה ששוחזרה לאחר רענון');
  });
  await recovered.context.close();

  const statuses = await open(browser, 'commander');
  await statuses.page.locator('#work').waitFor({ state:'visible' });
  const statusDelivered = await statuses.page.evaluate(() => {
    const rows = [{ id:'status-callout', data:{
      by_uid:'commander-callout', target_he:'משמרת ב', crew:'B',
      text:'בדיקת ארבעה מצבי תגובה', uids:['u2','u3','u4','u5'], active:true,
      request_id:'status_request_id_123456', delivery_state:'completed',
      created_key:new Date().toISOString()
    } }];
    return window.__FIRESTORE_DELIVER_CAPTURED('/callouts', rows, { oldest:true });
  });
  assert.equal(statusDelivered, true);
  const responsesDelivered = await statuses.page.evaluate(() =>
    window.__FIRESTORE_DELIVER_CAPTURED('/callouts/status-callout/responses', [
      { id:'u2', data:{ seen_at:'2026-09-14T10:00:00.000Z', resp:'coming' } },
      { id:'u3', data:{ seen_at:'2026-09-14T10:00:00.000Z', resp:'no', reason:'מחלה' } },
      { id:'u4', data:{ seen_at:'2026-09-14T10:00:00.000Z' } }
    ], { oldest:true }));
  assert.equal(responsesDelivered, true);
  await check('console separates unseen, seen-only, accepted and rejected recipients', async () => {
    const value = await statuses.page.locator('#calloutLive').textContent();
    assert.match(value, /טרם הוצג 1/);
    assert.match(value, /הוצג, טרם ענה 1/);
    assert.match(value, /אישר הגעה 1/);
    assert.match(value, /דחה 1/);
    assert.match(value, /מחלה/);
  });
  await statuses.context.close();

  const superRun = await open(browser, 'super');
  await superRun.page.locator('#work').waitFor({ state:'visible' });
  await superRun.page.evaluate(() => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [], { oldest:true }));
  await check('super chooses explicit target and sees the callout action', async () => {
    assert.equal(await superRun.page.locator('#targetCard').isVisible(), true);
    assert.equal(await superRun.page.locator('#calloutSend').isDisabled(), true);
    await superRun.page.locator('#targetStation').fill('other_station');
    await superRun.page.locator('#targetCrew').selectOption('C');
    await superRun.page.locator('#targetApply').evaluate(button => button.click());
    await superRun.page.waitForFunction(() => !document.querySelector('#calloutSend').disabled);
    await superRun.page.evaluate(() => window.__FIRESTORE_DELIVER_CAPTURED('/callouts', [{ id:'other_call', data:{
      by_uid:'another_commander', target:'crew:C', crew:'C', text:'Do not resend', active:true,
      request_id:'other_request_123456789', delivery_state:'partial', uids:[]
    }}]));
    assert.match(await superRun.page.locator('#calloutLive').textContent(), /Do not resend/);
    assert.equal(await superRun.page.evaluate(() => (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').length), 0);
    await superRun.page.locator('#calloutText').fill('בדיקת מנהל־על');
    await superRun.page.locator('#calloutSend').evaluate(button => button.click());
    await superRun.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(x => x.name === 'sendCallout'));
    const sent = await superRun.page.evaluate(() => (window.__CALLABLE_CALLS || []).find(x => x.name === 'sendCallout'));
    assert.equal(sent.payload.target_station_id, 'other_station');
    assert.equal(sent.payload.target, 'crew:C');
    await superRun.page.waitForFunction(() => !document.querySelector('#calloutText').readOnly);
    if (process.env.CALLOUT_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.CALLOUT_SCREENSHOT_DIR, { recursive:true });
      await superRun.page.locator('#targetCard').screenshot({ path:path.join(process.env.CALLOUT_SCREENSHOT_DIR, 'callout-super-target-mobile.png') });
    }
    await superRun.page.evaluate(() => { window.__CALLABLE_PLAN = { sendCallout:[{ reject:true, code:'functions/unavailable' }] }; });
    await superRun.page.locator('#calloutText').fill('קריאה ממתינה');
    await superRun.page.locator('#calloutSend').evaluate(button => button.click());
    await superRun.page.waitForFunction(() => document.querySelector('#calloutMessage').textContent.includes('נכשלה'));
    await superRun.page.locator('#targetStation').fill('changed_station');
    assert.deepEqual(await superRun.page.locator('#targetCrew').evaluate(select => Array.from(select.options, option => option.value)), ['', 'A', 'B', 'C']);
    await superRun.page.locator('#targetCrew').selectOption('A');
    await superRun.page.locator('#targetApply').evaluate(button => button.click());
    assert.match(await superRun.page.locator('#targetMessage').textContent(), /שליחה קודמת ממתינה/);
    await superRun.page.locator('#calloutSend').evaluate(button => button.click());
    await superRun.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').length === 3);
    const retries = await superRun.page.evaluate(() => (window.__CALLABLE_CALLS || []).filter(x => x.name === 'sendCallout').slice(1));
    assert.deepEqual(retries[0].payload, retries[1].payload, 'target and request identity stay frozen during pending send');
    assert.equal(retries[1].payload.target_station_id, 'other_station');
    assert.deepEqual(superRun.errors, []);
  });
  await superRun.context.close();

  const forged = await open(browser, 'firefighter', { super:'true' });
  await forged.page.locator('#denyCard').waitFor({ state:'visible' });
  await check('truthy string super does not grant UI access', async () => {
    assert.equal(await forged.page.locator('#work').isVisible(), false);
  });
  await forged.context.close();

  const preview = await open(browser, 'commander');
  await preview.page.evaluate(() => sessionStorage.setItem('resq_role_view_v1', '{"selected":"commander"}'));
  await preview.page.reload({ waitUntil:'load' });
  await preview.page.locator('#denyCard').waitFor({ state:'visible' });
  await check('role preview grants no write surface or roster read', async () => {
    assert.equal(await preview.page.locator('#work').isVisible(), false);
    const calls = await preview.page.evaluate(() => window.__CALLABLE_FACTORIES || []);
    assert.equal(calls.includes('sendCallout'), false);
  });
  await preview.context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log('callout console browser: ' + passed + '/' + passed + ' PASS');
