// מסך הסידור הישן הוחלף בשער מעבר. בדיקה זו שומרת על תכונת
// הביצועים והאבטחה הרלוונטית: URL/PWA ישן מעביר במהירות למנוע החדש
// ואינו מעיר קריאות Firestore של מחזורים או חריגות.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = {
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.json':'application/json'
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'schedule.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', (route) => {
    const moduleName = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, moduleName);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(() => {
    window.__SMOKE_ROLE = 'firefighter';
    window.__CALLABLE_PLAN = {
      getScheduleRuntimeStatus:[{ data:{ mode:'off', configured:false, manager:false, active:null } }]
    };
  });

  const page = await context.newPage();
  const started = Date.now();
  await page.goto(base + '/schedule.html', { waitUntil:'load' });
  await page.waitForURL(/schedule-management\.html\?tab=station/, { timeout:5000 });
  await page.locator('#availabilityView').waitFor({ state:'visible', timeout:5000 });
  const elapsed = Date.now() - started;
  const calls = await page.evaluate(() => window.__CALLABLE_CALLS || []);

  assert.ok(elapsed < 5000, 'legacy redirect took ' + elapsed + 'ms');
  assert.equal(calls.filter((entry) => entry.name === 'getScheduleRuntimeStatus').length, 1);
  assert.equal(calls.some((entry) => entry.name === 'getMyScheduleV2'), false);
  assert.equal(calls.some((entry) => entry.name === 'getStationScheduleV2'), false);
  assert.equal(await page.locator('#scheduleTabs').isVisible(), false);
  assert.match(await page.locator('#availabilityText').textContent(), /לא מוצג סידור ישן/);

  const legacySource = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
  assert.doesNotMatch(legacySource, /firebase-firestore|getFirestore|getDocs|collection\(|rotations|shift_overrides/);
  console.log('✓ legacy schedule redirect reached the fail-closed new page in ' + elapsed + 'ms');
  console.log('✓ legacy schedule shell performs no legacy Firestore reads');
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
