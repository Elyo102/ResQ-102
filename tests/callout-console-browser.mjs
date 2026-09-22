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
const cacheSource = fs.readFileSync(path.join(root, 'callout-roster-cache.js'), 'utf8');

function exported(name) {
  const start = serverSource.indexOf('exports.' + name + ' =');
  assert.notEqual(start, -1, name + ' export exists');
  const next = serverSource.indexOf('\nexports.', start + 1);
  return serverSource.slice(start, next === -1 ? serverSource.length : next);
}

const sendSource = exported('sendCallout');
const closeSource = exported('closeCallout');
const listSource = exported('listCalloutRecipients');
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
assert.match(serverSource, /async function calloutPeopleTarget/);
assert.match(sendSource, /target === 'people'/);
assert.match(sendSource, /calloutPeopleTarget\(sid, d\.uids, crew \|\| '', auth\.uid\)/);
assert.match(serverSource, /uid === selfUid/);
assert.match(serverSource, /בדיקת עצמי/);
assert.match(sendSource, /targetMode = 'people:' \+ uids\.slice\(\)\.sort\(\)\.join/);
assert.doesNotMatch(sendSource, /target === 'people' \|\| target === 'station'/);
assert.match(listSource, /await freshCalloutActor\(req\)/);
assert.match(listSource, /calloutRecipientRows\(actor, \(req\.data \|\| \{\}\)\.crew\)/);
assert.match(serverSource, /async function calloutRecipientRows\(actor, requestedCrew\)/);
assert.match(serverSource, /actor\.isSuper \? String\(requestedCrew \|\| ''\) : actor\.crew/);
assert.match(serverSource, /\.where\('crew', '==', crewFilter\)\.get\(\)/,
  'recipient listing is bounded to the requested crew in Firestore');
assert.match(consoleSource, /listCalloutRecipients/);
assert.match(consoleSource, /withTimeout\(session\.listCalloutRecipients/);
assert.match(cacheSource, /\[scope && scope\.uid, scope && scope\.sid, scope && scope\.crew\]/,
  'roster cache is isolated by signed identity, station and crew');
assert.match(cacheSource, /storage\.setItem\(calloutRosterCacheKey\(scope\)/,
  'short-lived roster cache stays inside the current app session');
assert.doesNotMatch(cacheSource, /localStorage\.(?:getItem|setItem)[\s\S]{0,80}callout_roster/,
  'station roster must not become a long-lived browser cache');
assert.match(sendSource, /runtimeValue\.silent === true/);
assert.match(sendSource, /intent_fingerprint/);
assert.match(sendSource, /rehearsal \? \[\] : uids/,
  'rehearsal recipients never enter the recipient-visible uids field');
assert.match(sendSource, /active: !rehearsal/,
  'rehearsal is never an active recipient callout');
assert.match(sendSource, /delivery_state:rehearsal \? 'rehearsal' : 'reserved'/);
assert.ok(sendSource.indexOf('if (rehearsal) {') < sendSource.indexOf('pushToUsers('),
  'the server terminates rehearsal before the provider delivery path');
assert.match(consoleSource, /לא נשלחה התראה לאף עובד/);
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

async function open(browser, role, extra = {}, setup = {}) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const file = path.join(stub, route.request().url().split('/').pop().split('?')[0]);
    route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(({ role, extra, setup }) => {
    window.__SMOKE_ROLE = role; window.__SMOKE_UID = role + '-callout';
    window.__SMOKE_EXTRA_CLAIMS = extra;
    window.confirm = () => true;
    if (setup && setup.recipientTimeoutMs) window.__CALLOUT_RECIPIENT_TIMEOUT_MS = setup.recipientTimeoutMs;
    if (setup && setup.rosterGetDocsHang) window.__ROSTER_GETDOCS_HANG = true;
    if (setup && setup.rosterPlan) window.__ROSTER_PLAN = setup.rosterPlan;
    if (setup && setup.callablePlan) window.__CALLABLE_PLAN = setup.callablePlan;
    if (setup && setup.rosterCache) {
      const cache = setup.rosterCache;
      const key = 'resq_callout_roster_v1:' + [role + '-callout', cache.sid || 'eilat_102', cache.crew || 'B']
        .map(value => encodeURIComponent(String(value))).join(':');
      sessionStorage.setItem(key, JSON.stringify({
        schema:1,
        saved_at_ms:Date.now() - Number(cache.ageMs || 0),
        rows:cache.rows || []
      }));
    }
  }, { role, extra, setup });
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

  const peopleRun = await open(browser, 'commander');
  await peopleRun.page.locator('#work').waitFor({ state:'visible' });
  await check('commander can choose specific recipients instead of the full crew', async () => {
    assert.match(await peopleRun.page.locator('#composeCard, .card.danger').first().textContent(), /לבחור לוחמים/);
    assert.match(await peopleRun.page.locator('.sound-preview').textContent(), /השמעה מקומית בלבד/);
    assert.match(await peopleRun.page.locator('.sound-preview audio').getAttribute('src'), /callout-siren\.mp3\?v=42h30/);
    await peopleRun.page.locator('.recipient-item').filter({ hasText:'דנה לוי' }).waitFor({ state:'visible' });
    await peopleRun.page.locator('#recipientNone').evaluate(button => button.click());
    assert.equal(await peopleRun.page.locator('#recipientNone').getAttribute('aria-pressed'), 'true');
    assert.match(await peopleRun.page.locator('#recipientSummary').textContent(), /לא נבחרו נמענים/);
    await peopleRun.page.locator('#calloutText').fill('קריאה בלי נמענים');
    await peopleRun.page.locator('#calloutSend').evaluate(button => button.click());
    await peopleRun.page.waitForTimeout(100);
    assert.equal(await peopleRun.page.evaluate(() => (window.__CALLABLE_CALLS || []).filter(row => row.name === 'sendCallout').length), 0);
    assert.match(await peopleRun.page.locator('#calloutMessage').textContent(), /יש לבחור לפחות נמען אחד/);
    await peopleRun.page.locator('.recipient-item').filter({ hasText:'דנה לוי' }).locator('input').check();
    assert.equal(await peopleRun.page.locator('.recipient-item').filter({ hasText:'דנה לוי' }).evaluate(row => row.classList.contains('is-picked')), true);
    assert.equal(await peopleRun.page.locator('.recipient-item').filter({ hasText:'דנה לוי' }).locator('.recipient-check').textContent(), '✓');
    assert.notEqual(await peopleRun.page.locator('.recipient-item').filter({ hasText:'דנה לוי' }).locator('.recipient-check').evaluate(el => getComputedStyle(el).color), 'rgba(0, 0, 0, 0)');
    assert.match(await peopleRun.page.locator('#recipientSummary').textContent(), /בחירה פרטנית פעילה/);
    await peopleRun.page.locator('#calloutText').fill('קריאה רק לדנה');
    await peopleRun.page.locator('#calloutSend').evaluate(button => button.click());
    await peopleRun.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(row => row.name === 'sendCallout'));
    const call = await peopleRun.page.evaluate(() => (window.__CALLABLE_CALLS || []).find(row => row.name === 'sendCallout'));
    assert.equal(call.payload.target, 'people');
    assert.equal(call.payload.crew, 'B');
    assert.deepEqual(call.payload.uids, ['u4']);
    assert.equal(call.payload.text, 'קריאה רק לדנה');
  });
  await peopleRun.context.close();

  const fastFallback = await open(browser, 'commander', {}, {
    callablePlan:{ listCalloutRecipients:[{ delay:60000 }] }
  });
  await fastFallback.page.locator('#work').waitFor({ state:'visible' });
  await check('recipient list is usable immediately when the callable cold-starts', async () => {
    await fastFallback.page.locator('.recipient-item').filter({ hasText:'דנה לוי' })
      .waitFor({ state:'visible', timeout:1500 });
    assert.doesNotMatch(await fastFallback.page.locator('#recipientSummary').textContent(), /טוען/);
    await fastFallback.page.locator('#recipientNone').evaluate(button => button.click());
    await fastFallback.page.locator('.recipient-item').filter({ hasText:'דנה לוי' }).locator('input').check();
    await fastFallback.page.locator('#calloutText').fill('קריאה זמינה מיד');
    await fastFallback.page.locator('#calloutSend').evaluate(button => button.click());
    await fastFallback.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(row => row.name === 'sendCallout'));
    const call = await fastFallback.page.evaluate(() => (window.__CALLABLE_CALLS || []).find(row => row.name === 'sendCallout'));
    assert.equal(call.payload.target, 'people');
    assert.deepEqual(call.payload.uids, ['u4']);
  });
  await fastFallback.context.close();

  const warmCache = await open(browser, 'commander', {}, {
    recipientTimeoutMs:60000,
    rosterGetDocsHang:true,
    rosterCache:{ rows:[{ uid:'u4', name:'דנה מהמטמון', crew:'B' }] },
    callablePlan:{ listCalloutRecipients:[{ delay:60000 }] }
  });
  await check('a warm scoped cache paints recipient checkboxes before the network returns', async () => {
    await warmCache.page.locator('.recipient-item').filter({ hasText:'דנה מהמטמון' })
      .waitFor({ state:'visible', timeout:750 });
    assert.equal(await warmCache.page.locator('#recipientList').getAttribute('aria-busy'), 'false');
    assert.equal(await warmCache.page.locator('#recipientNone').isDisabled(), false);
    assert.match(await warmCache.page.locator('#recipientSummary').textContent(), /רשימה השמורה מתעדכנת/);
  });
  await warmCache.context.close();

  const refreshedCache = await open(browser, 'commander', {}, {
    rosterGetDocsHang:true,
    rosterCache:{ rows:[{ uid:'u4', name:'דנה ישנה במטמון', crew:'B' }] },
    callablePlan:{ listCalloutRecipients:[{ delay:120, data:{ recipients:[
      { uid:'u4', name:'דנה מעודכנת מהשרת', crew:'B' }
    ] } }] }
  });
  await check('authoritative refresh replaces a stale cached display row', async () => {
    await refreshedCache.page.locator('.recipient-item').filter({ hasText:'דנה ישנה במטמון' })
      .waitFor({ state:'visible', timeout:750 });
    await refreshedCache.page.locator('.recipient-item').filter({ hasText:'דנה מעודכנת מהשרת' })
      .waitFor({ state:'visible', timeout:1500 });
    assert.equal(await refreshedCache.page.locator('.recipient-item').filter({ hasText:'דנה ישנה במטמון' }).count(), 0);
  });
  await refreshedCache.context.close();

  const wrongScopeCache = await open(browser, 'commander', {}, {
    recipientTimeoutMs:30,
    rosterGetDocsHang:true,
    rosterCache:{ sid:'other_station', rows:[{ uid:'u4', name:'אסור להציג', crew:'B' }] },
    callablePlan:{ listCalloutRecipients:[{ delay:60000 }] }
  });
  await check('a cache from another station is ignored', async () => {
    await wrongScopeCache.page.waitForFunction(() =>
      !(document.querySelector('#recipientSummary')?.textContent || '').includes('טוען'),
      null, { timeout:1500 });
    assert.equal(await wrongScopeCache.page.getByText('אסור להציג', { exact:true }).count(), 0);
    assert.match(await wrongScopeCache.page.locator('#recipientSummary').textContent(), /לא זמינה כרגע/);
  });
  await wrongScopeCache.context.close();

  const authoritativeFirst = await open(browser, 'commander', {}, {
    callablePlan:{ listCalloutRecipients:[{ data:{ recipients:[
      { uid:'u4', name:'דנה סמכותית', crew:'B' }
    ] } }] },
    rosterPlan:[{ delay:180, data:[
      ['u4', { full_name:'דנה ישנה', crew:'B', is_active:true }]
    ] }]
  });
  await authoritativeFirst.page.locator('#work').waitFor({ state:'visible' });
  await check('a slower Firestore fallback never overwrites the authoritative roster', async () => {
    await authoritativeFirst.page.locator('.recipient-item').filter({ hasText:'דנה סמכותית' })
      .waitFor({ state:'visible' });
    await authoritativeFirst.page.waitForTimeout(260);
    assert.equal(await authoritativeFirst.page.locator('.recipient-item').filter({ hasText:'דנה סמכותית' }).count(), 1);
    assert.equal(await authoritativeFirst.page.locator('.recipient-item').filter({ hasText:'דנה ישנה' }).count(), 0);
    const queries = await authoritativeFirst.page.evaluate(() => window.__FIRESTORE_QUERIES || []);
    const rosterQuery = queries.find(item => String(item.path || '').endsWith('/roster'));
    assert.ok(rosterQuery, 'the fallback records its bounded roster query');
    assert.ok((rosterQuery.constraints || []).some(item =>
      item.kind === 'where' && item.field === 'crew' && item.op === '==' && item.value === 'B'));
  });
  await authoritativeFirst.context.close();

  const fallbackFirst = await open(browser, 'commander', {}, {
    callablePlan:{ listCalloutRecipients:[{ delay:180, data:{ recipients:[
      { uid:'u4', name:'דנה מעודכנת', crew:'B' }
    ] } }] },
    rosterPlan:[{ data:[
      ['u4', { full_name:'דנה זמנית', crew:'B', is_active:true }],
      ['u5', { full_name:'עזב מזמן', crew:'B', is_active:false }],
      ['u2', { full_name:'איש משמרת א', crew:'A', is_active:true }]
    ] }]
  });
  await fallbackFirst.page.locator('#work').waitFor({ state:'visible' });
  await check('fast fallback is usable and later refreshed by the authoritative roster', async () => {
    await fallbackFirst.page.locator('.recipient-item').filter({ hasText:'דנה זמנית' })
      .waitFor({ state:'visible' });
    assert.equal(await fallbackFirst.page.locator('.recipient-item').filter({ hasText:'עזב מזמן' }).count(), 0);
    assert.equal(await fallbackFirst.page.locator('.recipient-item').filter({ hasText:'איש משמרת א' }).count(), 0);
    await fallbackFirst.page.locator('.recipient-item').filter({ hasText:'דנה מעודכנת' })
      .waitFor({ state:'visible' });
    assert.equal(await fallbackFirst.page.locator('.recipient-item').filter({ hasText:'דנה זמנית' }).count(), 0);
  });
  await fallbackFirst.context.close();

  const stuckRoster = await open(browser, 'commander', {}, {
    recipientTimeoutMs:30,
    rosterGetDocsHang:true,
    callablePlan:{ listCalloutRecipients:[{ delay:60000 }] }
  });
  await stuckRoster.page.locator('#work').waitFor({ state:'visible' });
  await check('recipient picker leaves loading state when both roster reads stall', async () => {
    await stuckRoster.page.waitForFunction(() =>
      !(document.querySelector('#recipientSummary')?.textContent || '').includes('טוען'),
      null, { timeout:1500 });
    assert.match(await stuckRoster.page.locator('#recipientSummary').textContent(), /לא זמינה כרגע/);
    assert.doesNotMatch(await stuckRoster.page.locator('#recipientSummary').textContent(), /טוען/);
    assert.match(await stuckRoster.page.locator('#calloutMessage').textContent(), /רשימת השמות לא נטענה/);
    await stuckRoster.page.locator('#calloutText').fill('קריאה לכל המשמרת גם בלי רשימה');
    await stuckRoster.page.locator('#calloutSend').evaluate(button => button.click());
    await stuckRoster.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(row => row.name === 'sendCallout'));
    const call = await stuckRoster.page.evaluate(() => (window.__CALLABLE_CALLS || []).find(row => row.name === 'sendCallout'));
    assert.equal(call.payload.target, 'crew:B');
    assert.equal(Object.hasOwn(call.payload, 'uids'), false);
  });
  await stuckRoster.context.close();

  const backgroundRoster = await open(browser, 'commander', {}, {
    recipientTimeoutMs:60000,
    rosterGetDocsHang:true,
    callablePlan:{ listCalloutRecipients:[{ delay:60000 }] }
  });
  await check('the callout screen opens immediately while recipient names load in the background', async () => {
    await backgroundRoster.page.locator('#work').waitFor({ state:'visible', timeout:750 });
    assert.equal(await backgroundRoster.page.locator('#recipientList').getAttribute('aria-busy'), 'true');
    assert.equal(await backgroundRoster.page.locator('#recipientNone').isDisabled(), true);
    assert.equal(await backgroundRoster.page.locator('#recipientAll').isDisabled(), false);
    assert.equal(await backgroundRoster.page.locator('#recipientSelf').isDisabled(), false);
  });
  await backgroundRoster.context.close();

  const selfRun = await open(browser, 'commander');
  await selfRun.page.locator('#work').waitFor({ state:'visible' });
  await check('self-test targets only the signed user for trial siren checks', async () => {
    await selfRun.page.locator('#recipientSelf').evaluate(button => button.click());
    assert.match(await selfRun.page.locator('#recipientSummary').textContent(), /בדיקת עצמי|נבחרו 1/);
    await selfRun.page.locator('#calloutText').fill('בדיקת צלצול לעצמי');
    await selfRun.page.locator('#calloutSend').evaluate(button => button.click());
    await selfRun.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(row => row.name === 'sendCallout'));
    const call = await selfRun.page.evaluate(() => (window.__CALLABLE_CALLS || []).find(row => row.name === 'sendCallout'));
    assert.equal(call.payload.target, 'people');
    assert.deepEqual(call.payload.uids, ['commander-callout']);
    assert.equal(call.payload.text, 'בדיקת צלצול לעצמי');
  });
  await selfRun.context.close();

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
      { id:'u4', data:{ seen_at:'2026-09-14T10:00:00.000Z' } },
      { id:'rogue', data:{ seen_at:'2026-09-14T10:00:00.000Z', resp:'coming' } }
    ], { oldest:true }));
  assert.equal(responsesDelivered, true);
  await check('console separates unseen, seen-only, accepted and rejected recipients', async () => {
    const value = await statuses.page.locator('#calloutLive').textContent();
    assert.match(value, /טרם הוצג 1/);
    assert.match(value, /הוצג, טרם ענה 1/);
    assert.match(value, /אישרו הגעה:/);
    assert.match(value, /דחו הגעה:/);
    assert.match(value, /מחלה/);
    assert.match(value, /נשלח אל4/);
    assert.match(value, /נצפה3/);
    assert.match(value, /אישרו \/ בדרך1/);
    assert.doesNotMatch(value, /rogue/);
  });

  await check('rehearsal validates the selected people but never requests a broadcast', async () => {
    const rehearsal = await open(browser, 'commander', {}, { callablePlan:{ sendCallout:[{
      data:{ ok:true, id:'rehearsal-callout', rehearsal:true, selected:1, sent:0, people:0, devices:0 }
    }] } });
    await rehearsal.page.locator('#recipientNone').click();
    await rehearsal.page.locator('input[value="u4"]').check();
    await rehearsal.page.locator('#calloutText').fill('תרגול בחירת נמענים');
    await rehearsal.page.locator('#calloutRehearse').click();
    await rehearsal.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(x => x.name === 'sendCallout'));
    const call = await rehearsal.page.evaluate(() => (window.__CALLABLE_CALLS || []).find(x => x.name === 'sendCallout'));
    assert.equal(call.payload.rehearsal, true);
    assert.equal(call.payload.target, 'people');
    assert.deepEqual(call.payload.uids, ['u4']);
    assert.match(await rehearsal.page.locator('#calloutMessage').textContent(), /לא נשלחה התראה לאף עובד/);
    await rehearsal.context.close();
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
