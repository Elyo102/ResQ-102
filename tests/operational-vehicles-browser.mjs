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
  await page.waitForFunction(() => document.querySelector('#equipmentStatus')?.textContent
    .includes('לא נרשם עדיין'));
  assert.match(await page.locator('#equipmentStatus').textContent(), /לא נרשם עדיין/);
  assert.equal(await page.locator('#eventForm').isVisible(), true);
  assert.equal(await page.locator('#addItem').isVisible(), false);
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
  const hr = await context.newPage();
  await hr.addInitScript(() => { window.__SMOKE_ROLE = 'hr'; });
  await hr.goto('http://127.0.0.1:' + server.address().port + '/operational-vehicles.html');
  await hr.locator('#layout:not([hidden])').waitFor();
  await hr.locator('#vehicles button').first().click();
  assert.equal(await hr.locator('#eventForm').isVisible(), false, 'HR is read-only');
  assert.equal(await hr.locator('#createVehicleWrap').isVisible(), false);
  passed++;
  const officer = await context.newPage();
  await officer.addInitScript(() => { window.__SMOKE_ROLE = 'commander'; });
  await officer.goto('http://127.0.0.1:' + server.address().port + '/operational-vehicles.html');
  await officer.locator('#layout:not([hidden])').waitFor();
  assert.equal(await officer.locator('#createVehicleWrap').isVisible(), true);
  await officer.locator('#vehicles button').first().click();
  await officer.locator('#sectors button').first().click();
  await officer.locator('#addItem').click();
  await officer.locator('#itemName').fill('זרנוק לחץ');
  await officer.locator('#itemQuantity').fill('2');
  await officer.locator('#saveItem').click();
  await officer.waitForFunction(() => (window.__CALLABLE_CALLS || [])
    .some(call => call.name === 'saveVehicleCompartmentItem'));
  const itemRequest = await officer.evaluate(() => (window.__CALLABLE_CALLS || [])
    .find(call => call.name === 'saveVehicleCompartmentItem').payload);
  assert.equal(itemRequest.vehicle_id, 'v1');
  assert.equal(itemRequest.compartment_id, 'cabin');
  assert.equal(itemRequest.name, 'זרנוק לחץ');
  await officer.locator('#eventEquipment').fill('מטף');
  await officer.locator('#eventLocation').fill('מחסן תחנה');
  await officer.locator('#saveEvent').click();
  await officer.waitForFunction(() => (window.__CALLABLE_CALLS || [])
    .some(call => call.name === 'recordVehicleEquipmentEvent'));
  const eventRequest = await officer.evaluate(() => (window.__CALLABLE_CALLS || [])
    .find(call => call.name === 'recordVehicleEquipmentEvent').payload);
  assert.equal(eventRequest.equipment, 'מטף');
  assert.equal(eventRequest.location, 'מחסן תחנה');
  passed++;
  await officer.evaluate(() => { window.__CALLABLE_PLAN = {
    saveVehicleCompartmentPhoto:[{ data:{ revision:1, written:true } }]
  }; });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await officer.locator('#sectorPhotoFile').setInputFiles({
    name:'compartment.png', mimeType:'image/png', buffer:png
  });
  await officer.locator('#saveSectorPhoto').click();
  await officer.waitForFunction(() => document.querySelector('#photoMessage')?.textContent
    .includes('נשמרה'));
  const photoRequest = await officer.evaluate(() => (window.__CALLABLE_CALLS || [])
    .find(call => call.name === 'saveVehicleCompartmentPhoto').payload);
  assert.equal(photoRequest.compartment_id, 'cabin');
  assert.match(photoRequest.data, /^data:image\/jpeg;base64,/);
  passed++;
  await officer.locator('#addItem').click();
  await officer.locator('#itemName').fill('טיוטה שאסור למחוק');
  await officer.evaluate(() => window.__SMOKE_SWAP_USER('commander', 'stub-uid',
    { stationId:'eilat_102' }));
  await officer.waitForTimeout(100);
  assert.equal(await officer.locator('#itemName').inputValue(), 'טיוטה שאסור למחוק',
    'same-user token refresh must preserve an unsent inventory draft');
  passed++;
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height:844 });
    const overflow = await page.locator('body').evaluate(el => ({
      fits:el.scrollWidth <= window.innerWidth,
      scroll:el.scrollWidth,
      nav:document.querySelector('#appNav')?.getBoundingClientRect().toJSON(),
      main:document.querySelector('main')?.getBoundingClientRect().toJSON(),
      offenders:[...document.querySelectorAll('*')].filter(node =>
        node.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5)
        .map(node => node.tagName + '#' + node.id)
    }));
    assert.equal(overflow.fits, true, `horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`);
    passed++;
  }
  console.log(passed + ' operational vehicle browser checks passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
