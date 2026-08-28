// מודד את הזמן עד שלוח הציוות מציג שיבוץ אמיתי ברשת איטית
// מדומה, ומוודא שמקביליות הקריאות לא משנה תוכן או טיפול בכשל.
// כל הנתונים מקומיים וסינתטיים.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

let passed = true;
function check(ok, message) {
  passed = passed && !!ok;
  console.log((ok ? '✓ ' : '✗ ') + message);
}

const expectedPaths = ['/users/stub-uid','config/mode','/callouts','/faults',
  '/redline_waivers','/quals','/roster','/member_quals','/sub_stations',
  '/config/board','/shifts/C'];

const browser = await chromium.launch();

async function scenario(options = {}) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(({ lag, failPaths, role }) => {
    window.__SMOKE_ROLE = role;
    window.__SMOKE_LAG = lag;
    window.__SMOKE_FAIL_PATHS = failPaths;
    window.__PERF_STARTED = Date.now();
  }, {
    lag:Number(options.lag || 0),
    failPaths:options.failPaths || [],
    role:options.role || 'super'
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
  await page.goto('http://127.0.0.1:' + port + '/board.html', { waitUntil:'load' });
  if (options.waitForError) {
    await page.waitForFunction(text =>
      ((document.getElementById('msg') || {}).textContent || '').includes(text),
    options.waitForError, { timeout:12000 });
    // config/board הוא המבנה עצמו, ולכן בכשל מכוון אין צמתי
    // פיקוד להמתין להם. תווית התחנות מתעדכנת רק ב-render().
    await page.waitForFunction(() =>
      ((document.getElementById('sitesLbl') || {}).textContent || '').length > 0,
    null, { timeout:12000 });
  } else {
    await page.locator('#chain .node').first().waitFor({ state:'visible', timeout:12000 });
  }

  const result = await page.evaluate(() => ({
    interactiveMs: Date.now() - window.__PERF_STARTED,
    dataRequests: window.__N || 0,
    dataSpanMs: (window.__TN || Date.now()) - (window.__T0 || Date.now()),
    dataPaths: (window.__DATA_PATHS || []).slice(),
    commandNodes: document.querySelectorAll('#chain .node').length,
    vehicleCards: document.querySelectorAll('#fleet .veh').length,
    blockedVehicles: document.querySelectorAll('#fleet .veh.blocked').length,
    firstCommander: (document.querySelector('#chain .who') || {}).textContent || '',
    message: (document.getElementById('msg') || {}).textContent || '',
    sitesText: (document.getElementById('sitesLbl') || {}).textContent || ''
  }));
  result.pageErrors = pageErrors;
  await context.close();
  return result;
}

try {
  const result = await scenario({ lag:lagMs });
  console.log('Board slow-network benchmark');
  console.log('lag per data request:', lagMs + 'ms');
  console.log('time to usable board:', result.interactiveMs + 'ms');
  console.log('data requests started:', result.dataRequests);
  console.log('measured data span:', result.dataSpanMs + 'ms');
  console.log('data paths:', JSON.stringify(result.dataPaths));
  check(result.interactiveMs <= maxInteractiveMs && result.dataSpanMs <= maxDataSpanMs,
        'board data sources load without a serial request waterfall');
  check(result.dataRequests === 11, 'benchmark keeps the expected 11 data requests');
  expectedPaths.forEach(suffix => {
    check(result.dataPaths.filter(p => p.includes(suffix)).length === 1,
          'benchmark reads ' + suffix + ' exactly once');
  });
  check(result.commandNodes === 4, 'board keeps all four command positions');
  check(result.vehicleCards === 3, 'board keeps all three configured vehicles');
  check(result.blockedVehicles === 1, 'board keeps the blocking vehicle state');
  check(result.firstCommander.includes('אלדד'), 'board keeps the assigned commander');
  check(!result.sitesText.includes('ישנה בארכיון'), 'archived sub-station stays hidden');
  check(!result.message && result.pageErrors.length === 0,
        'board loads without an error message or page exception');

  for (const failedPath of ['/faults', '/redline_waivers', '/quals',
                            '/member_quals', '/sub_stations']) {
    const optionalFailure = await scenario({ lag:20, failPaths:[failedPath] });
    check(optionalFailure.commandNodes === 4 && optionalFailure.vehicleCards === 3,
          failedPath + ' failure does not block the independent board structure');
    check(optionalFailure.dataRequests === 11 && optionalFailure.pageErrors.length === 0,
          failedPath + ' failure keeps every independent read and does not throw');
  }

  const rosterFailure = await scenario({ lag:20, failPaths:['/roster'] });
  check(rosterFailure.message.includes('רשימת אנשי התחנה'),
        'a roster read failure keeps the existing visible error');
  check(rosterFailure.commandNodes === 4 && rosterFailure.vehicleCards === 3,
        'a roster failure still publishes the independent board structure');

  const boardFailure = await scenario({
    lag:20,
    failPaths:['/config/board'],
    waitForError:'מבנה הציוות'
  });
  check(boardFailure.message.includes('מבנה הציוות'),
        'a board-config read failure keeps the existing visible error');
  check(boardFailure.sitesText && !boardFailure.sitesText.includes('ישנה בארכיון'),
        'a board-config failure still processes active sub-stations only');
  check(boardFailure.dataRequests === 11 && boardFailure.pageErrors.length === 0,
        'a board-config failure does not cancel independent reads or throw');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

process.exitCode = passed ? 0 : 1;
