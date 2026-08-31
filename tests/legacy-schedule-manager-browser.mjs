import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const mime = {
  '.css':'text/css; charset=utf-8',
  '.html':'text/html; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8'
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'schedule.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  response.end(fs.readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/';

async function prepare(context, role) {
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({
      status:200,
      contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};'
    });
  });
  await context.addInitScript((roleName) => { window.__SMOKE_ROLE = roleName; }, role);
}

async function schedulePage(browser, role) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(context, role);
  const page = await context.newPage();
  await page.goto(base + 'schedule.html', { waitUntil:'load' });
  await page.locator('#mainView:not(.hide)').waitFor();
  return { context, page };
}

async function adminPage(browser, role) {
  const context = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(context, role);
  const page = await context.newPage();
  await page.goto(base + 'admin.html', { waitUntil:'load' });
  await page.locator('#work:not(.hide)').waitFor();
  return { context, page };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('✓ ' + name);
}

const browser = await chromium.launch();
try {
  await test('commander without schedule-manager capability cannot see the legacy override editor', async () => {
    const { context, page } = await schedulePage(browser, 'commander');
    try {
      assert.equal(await page.locator('#ovrCard').isVisible(), false);
      assert.equal(await page.locator('#ovAdd').isVisible(), false);
    } finally {
      await context.close();
    }
  });

  await test('appointed schedule manager can see and use the legacy override editor', async () => {
    const { context, page } = await schedulePage(browser, 'schedule_manager');
    try {
      assert.equal(await page.locator('#ovrCard').isVisible(), true);
      assert.equal(await page.locator('#ovAdd').isVisible(), true);
      assert.equal(await page.locator('#ovAdd').isEnabled(), true);
    } finally {
      await context.close();
    }
  });

  await test('super administrator without schedule-manager capability sees the old rotation editor as read-only', async () => {
    const { context, page } = await adminPage(browser, 'super');
    try {
      assert.equal(await page.locator('#rotationReadOnly').isVisible(), true);
      for (const selector of ['#anchorDate', '#anchorCrew', '#shiftStart', '#shiftEnd', '#cmdStart', '#specEnd', '#btnRot']) {
        assert.equal(await page.locator(selector).isDisabled(), true, selector + ' must be disabled');
      }
    } finally {
      await context.close();
    }
  });

  await test('appointed schedule manager can edit the legacy rotation while super-only administration remains hidden', async () => {
    const { context, page } = await adminPage(browser, 'schedule_manager');
    try {
      assert.equal(await page.locator('#rotationReadOnly').isVisible(), false);
      for (const selector of ['#anchorDate', '#anchorCrew', '#shiftStart', '#shiftEnd', '#cmdStart', '#specEnd', '#btnRot']) {
        assert.equal(await page.locator(selector).isDisabled(), false, selector + ' must be enabled');
      }
      assert.equal(await page.locator('#reqCard').isVisible(), false);
      assert.equal(await page.locator('#usersCard').isVisible(), false);
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(passed, 4);
console.log('\n4 legacy schedule-manager browser checks passed.');
