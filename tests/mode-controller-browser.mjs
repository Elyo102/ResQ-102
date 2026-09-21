import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const fixture = `<!doctype html><html lang="he" dir="rtl"><head>
<meta charset="utf-8"><link rel="stylesheet" href="/theme.css">
</head><body><nav id="appNav"></nav><script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { startModeController, stopModeController } from '/mode-controller.js';
initializeApp({});
window.__startMode = startModeController;
window.__stopMode = stopModeController;
startModeController(window.__CLAIMS || {});
window.__MODE_READY = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  if (pathname === '/fixture.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fixture);
    return;
  }
  const file = path.join(root, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('missing'); return;
  }
  res.writeHead(200, { 'Content-Type': path.extname(file) === '.css'
    ? 'text/css' : 'text/javascript; charset=utf-8' });
  res.end(fs.readFileSync(file));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/fixture.html';
const browser = await chromium.launch();
let passed = 0;
async function test(name, body) {
  await body(); passed++; console.log('✓ ' + name);
}

async function context(role, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL' });
  await ctx.route('https://www.gstatic.com/firebasejs/10.12.2/**', route => {
    const name = path.basename(new URL(route.request().url()).pathname);
    route.fulfill({ status: 200, contentType: 'text/javascript',
      body: fs.readFileSync(path.join(stub, name), 'utf8') });
  });
  await ctx.addInitScript(({ role, options }) => {
    window.__SMOKE_ROLE = role;
    window.__SMOKE_MODE = options.mode || 'trial';
    window.__CLAIMS = role === 'super' ? { role: 'firefighter', super: true }
      : { role: 'firefighter' };
    window.__CALLABLE_PLAN = options.plan || {};
    window.confirm = () => options.confirm !== false;
  }, { role, options });
  return ctx;
}

try {
  await test('a firefighter sees truthful status but no mode-changing action', async () => {
    const ctx = await context('firefighter'); const page = await ctx.newPage();
    await page.goto(base); await page.waitForFunction(() => window.__MODE_READY && document.querySelector('#modeChip'));
    assert.equal(await page.locator('#modeChip').getAttribute('aria-label'), 'מצב אימון פעיל');
    await page.locator('#modeChip').click();
    assert.equal(await page.locator('#modeChipAction').count(), 0);
    assert.equal(await page.evaluate(() => (__FIRESTORE_ACTIVE_PATHS || {})['config/mode']), 1);
    await page.evaluate(() => __startMode({ role: 'firefighter' }));
    assert.equal(await page.evaluate(() => (__FIRESTORE_ACTIVE_PATHS || {})['config/mode']), 1,
      'rerender must retain one listener');
    await ctx.close();
  });

  await test('only a super gets the action and one click sends an exact CAS intent', async () => {
    const plan = { setSilentMode: [{ delay: 80, data: {
      ok: true, silent: false, mode: 'live', revision: 1,
      allow: [], duplicate: false, changed: true
    } }] };
    const ctx = await context('super', { plan }); const page = await ctx.newPage();
    await page.goto(base); await page.waitForFunction(() => document.querySelector('#modeChip'));
    await page.locator('#modeChip').click();
    assert.equal(await page.locator('#modeChipAction').innerText(), 'מעבר למצב חי');
    await page.locator('#modeChipAction').evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => (__CALLABLE_CALLS || []).length === 1);
    assert.equal(await page.locator('#modeChipAction').getAttribute('aria-busy'), 'true');
    await page.waitForFunction(() => document.querySelector('#modeChip')?.dataset.mode === 'live');
    const calls = await page.evaluate(() => __CALLABLE_CALLS);
    assert.equal(calls.length, 1, 'busy state must prevent a double submission');
    assert.equal(calls[0].name, 'setSilentMode');
    assert.deepEqual(Object.keys(calls[0].payload).sort(),
      ['expected_revision', 'request_id', 'silent']);
    assert.equal(calls[0].payload.expected_revision, 0);
    assert.equal(calls[0].payload.silent, false);
    assert.match(calls[0].payload.request_id, /^runtime_[a-f0-9]{32}$/);
    assert.equal('allow' in calls[0].payload, false);
    await ctx.close();
  });

  await test('cancel and server failure never repaint the requested mode', async () => {
    const cancelCtx = await context('super', { confirm: false });
    const cancel = await cancelCtx.newPage(); await cancel.goto(base);
    await cancel.waitForFunction(() => document.querySelector('#modeChip'));
    await cancel.locator('#modeChip').click(); await cancel.locator('#modeChipAction').click();
    assert.equal(await cancel.evaluate(() => (window.__CALLABLE_CALLS || []).length), 0);
    assert.equal(await cancel.locator('#modeChip').getAttribute('data-mode'), 'trial');
    await cancelCtx.close();

    const failCtx = await context('super', { plan: { setSilentMode: [{ reject: true,
      code: 'functions/unavailable' }] } });
    const fail = await failCtx.newPage(); await fail.goto(base);
    await fail.waitForFunction(() => document.querySelector('#modeChip'));
    await fail.locator('#modeChip').click(); await fail.locator('#modeChipAction').click();
    await fail.waitForFunction(() => /לא שונה/.test(document.querySelector('#modeChipStatus')?.textContent || ''));
    assert.equal(await fail.locator('#modeChip').getAttribute('data-mode'), 'trial');
    assert.doesNotMatch(await fail.locator('#modeChipStatus').innerText(), /functions\/|Firebase|unavailable/i);
    await failCtx.close();
  });

  await test('listener failure removes the chip instead of guessing live', async () => {
    const ctx = await context('super');
    await ctx.addInitScript(() => { window.__FIRESTORE_FAIL_PATHS = ['config/mode']; });
    const page = await ctx.newPage(); await page.goto(base);
    await page.waitForFunction(() => window.__MODE_READY === true);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#modeChip').count(), 0);
    await ctx.close();
  });

  console.log('Mode controller browser: ' + passed + ' PASS');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
