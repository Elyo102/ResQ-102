import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json' };
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'text/plain' });
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
let passed = 0;
try {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};';
    if (name === 'firebase-firestore.js') {
      const old = "if (/\\/faults$/.test(p))          return delayed(listSnap(FAULTS));";
      assert.ok(body.includes(old), 'fault fixture must preserve scoped query check');
      body = body.replace(old,
        "if (/\\/faults$/.test(p)) return delayed(listSnap(constrainedRows(FAULTS, (q && q.constraints) || [])));"
      );
    }
    route.fulfill({ status:200, contentType:'text/javascript', body });
  });
  await context.addInitScript(() => { window.__SMOKE_ROLE = 'firefighter'; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/operational-vehicles.html');
  await page.locator('#layout:not([hidden])').waitFor();
  assert.deepEqual(await page.locator('#vehicles button').allTextContents(),
    ['רכב אלמוג', 'רכב געש', 'רכב סער']);
  assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth), true);
  passed++;

  await page.locator('#vehicles button').first().dispatchEvent('click');
  await page.locator('#faultList .fault').first().waitFor();
  assert.equal(await page.locator('#faultList .fault').count(), 1);
  assert.match(await page.locator('#faultList').textContent(), /נזילת שמן/);
  assert.equal(await page.locator('#faultLink').getAttribute('href'), './vehicle.html?v=v1');
  await page.locator('#sectors button').first().dispatchEvent('click');
  assert.equal(await page.locator('#sectorTitle').textContent(), 'קבינה');
  assert.match(await page.locator('#sectorPhoto').textContent(), /טרם הוגדרה תמונה/);
  assert.match(await page.locator('#equipmentStatus').textContent(), /טרם הוגדרה/);
  passed++;

  await page.evaluate(() => { window.__SMOKE_LAG_PLAN = [150]; });
  await page.locator('#vehicles button').nth(1).dispatchEvent('click');
  await page.evaluate(() => window.__SMOKE_SWAP_USER('firefighter', 'new-user',
    { stationId:'other_station' }));
  await page.waitForTimeout(190);
  assert.equal(await page.locator('#faultList .fault').count(), 0,
    'a delayed response from the previous account must not render');
  passed++;

  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log(passed + ' operational vehicle browser checks passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
