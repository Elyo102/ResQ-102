// מודד את הזמן עד שלוח הציוות מציג שיבוץ אמיתי ברשת איטית מדומה.
// כל הנתונים מקומיים וסינתטיים; המטרה היא לזהות חזרה ל-waterfall
// בלי לשנות שאילתה, הרשאה או תוכן שמוצג למשתמש.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const port = 8393;
const lagMs = 180;
const maxInteractiveMs = 1900;
const maxDataSpanMs = 1200;
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'text/javascript', '.png':'image/png', '.jpg':'image/jpeg' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/board.html');
  const file = path.join(root, urlPath === '/' ? 'board.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(port, resolve));

let passed = true;
function check(ok, message) {
  passed = passed && !!ok;
  console.log((ok ? '✓ ' : '✗ ') + message);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await context.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript',
    body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await context.route('**://fonts.googleapis.com/**', route =>
  route.fulfill({ status:200, contentType:'text/css', body:'' }));
await context.addInitScript(({ lag }) => {
  window.__SMOKE_ROLE = 'super';
  window.__SMOKE_LAG = lag;
  window.__PERF_STARTED = Date.now();
}, { lag:lagMs });

const page = await context.newPage();
await page.goto('http://localhost:' + port + '/board.html', { waitUntil:'load' });
await page.locator('#chain .node').first().waitFor({ state:'visible', timeout:12000 });
const result = await page.evaluate(() => ({
  interactiveMs: Date.now() - window.__PERF_STARTED,
  dataRequests: window.__N || 0,
  dataSpanMs: (window.__TN || Date.now()) - (window.__T0 || Date.now()),
  dataPaths: (window.__DATA_PATHS || []).slice(),
  commandNodes: document.querySelectorAll('#chain .node').length,
  vehicleCards: document.querySelectorAll('#fleet .veh').length,
  blockedVehicles: document.querySelectorAll('#fleet .veh.blocked').length,
  firstCommander: (document.querySelector('#chain .who') || {}).textContent || '',
  message: (document.getElementById('msg') || {}).textContent || ''
}));

console.log('Board slow-network benchmark');
console.log('lag per data request:', lagMs + 'ms');
console.log('time to usable board:', result.interactiveMs + 'ms');
console.log('data requests started:', result.dataRequests);
console.log('measured data span:', result.dataSpanMs + 'ms');
console.log('data paths:', JSON.stringify(result.dataPaths));
check(result.interactiveMs <= maxInteractiveMs && result.dataSpanMs <= maxDataSpanMs,
      'board data sources load without a serial request waterfall');
check(result.dataRequests === 11, 'benchmark keeps the expected 11 data requests');

const expectedPaths = ['/users/stub-uid','config/mode','/callouts','/faults','/redline_waivers',
  '/quals','/roster','/member_quals','/sub_stations','/config/board','/shifts/C'];
expectedPaths.forEach(suffix => {
  check(result.dataPaths.filter(p => p.includes(suffix)).length === 1,
        'benchmark reads ' + suffix + ' exactly once');
});
check(result.commandNodes === 4, 'board keeps all four command positions');
check(result.vehicleCards === 3, 'board keeps all three configured vehicles');
check(result.blockedVehicles === 1, 'board keeps the blocking vehicle state');
check(result.firstCommander.includes('אלדד'), 'board keeps the assigned commander');
check(!result.message, 'board loads without an error message');

await context.close();
await browser.close();
server.close();
process.exitCode = passed ? 0 : 1;
