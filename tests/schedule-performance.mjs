// מודד רק את מקורות הכשירות במסך הסידור ברשת איטית מדומה.
// הנתונים סינתטיים. הבדיקה שומרת גם על גבולות ההרשאה וגם על
// התנהגות המסך כאשר מקור אחד נכשל.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const port = 8394;
const lagMs = 180;
const maxFitnessSpanMs = 700;
const measureOnly = process.argv.includes('--measure-only');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'text/javascript', '.png':'image/png', '.jpg':'image/jpeg' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/schedule.html');
  const file = path.join(root, urlPath === '/' ? 'schedule.html' : urlPath);
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

async function runScenario(name, role, crews, failPaths = [], enforceSpeed = false) {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const moduleName = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, moduleName);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(({ selectedRole, lag, failures }) => {
    window.__SMOKE_ROLE = selectedRole;
    window.__SMOKE_LAG = lag;
    window.__SMOKE_FAIL_PATHS = failures;
    window.__PERF_STARTED = Date.now();
  }, { selectedRole:role, lag:lagMs, failures:failPaths });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('http://localhost:' + port + '/schedule.html', { waitUntil:'load' });
  await page.locator('#fitBoxes .p').first().waitFor({ state:'visible', timeout:15000 });

  const result = await page.evaluate(() => {
    const fitness = /\/(quals|roster|member_quals)$|\/config\/(redline|board)$|\/shifts\//;
    const events = (window.__DATA_EVENTS || []).filter(e => fitness.test(e.path || ''));
    const starts = events.map(e => e.started).filter(Boolean);
    const finishes = events.map(e => e.finished).filter(Boolean);
    return {
      interactiveMs: Date.now() - window.__PERF_STARTED,
      fitnessSpanMs: starts.length && finishes.length
        ? Math.max(...finishes) - Math.min(...starts) : 0,
      fitnessPaths: events.map(e => e.path),
      boxes: Array.from(document.querySelectorAll('#fitBoxes .p')).map(e => e.textContent.trim()),
      calendarDays: document.querySelectorAll('#grid .day:not(.pad)').length,
      unfitDays: document.querySelectorAll('#grid .day.unfit').length,
      mainVisible: !document.getElementById('mainView').classList.contains('hide'),
      blockedVisible: !document.getElementById('blocked').classList.contains('hide')
    };
  });

  console.log('\nSchedule fitness benchmark · ' + name);
  console.log('lag per data request:', lagMs + 'ms');
  console.log('time to rendered fitness:', result.interactiveMs + 'ms');
  console.log('fitness data span:', result.fitnessSpanMs + 'ms');
  console.log('fitness data paths:', JSON.stringify(result.fitnessPaths));

  const suffixes = ['/quals','/roster','/member_quals','/config/redline','/config/board']
    .concat(crews.map(crew => '/shifts/' + crew));
  suffixes.forEach(suffix => {
    check(result.fitnessPaths.filter(p => p.endsWith(suffix)).length === 1,
          name + ' reads ' + suffix + ' exactly once');
  });
  check(result.fitnessPaths.length === suffixes.length,
        name + ' reads only the expected fitness sources');
  const actualCrews = result.fitnessPaths.filter(p => p.includes('/shifts/'))
    .map(p => p.split('/').pop());
  check(JSON.stringify(actualCrews) === JSON.stringify(crews),
        name + ' reads only the visible crews');
  check(result.boxes.length === crews.length, name + ' keeps one fitness box per visible crew');
  check(result.boxes.every(text => text.includes('לא כשירה')),
        name + ' keeps the known readiness verdict');
  check(result.calendarDays >= 28 && result.unfitDays > 0,
        name + ' keeps the rendered calendar readiness markers');
  check(result.mainVisible && !result.blockedVisible && pageErrors.length === 0,
        name + ' completes without blocking or a page error');
  if (enforceSpeed && !measureOnly) {
    check(result.fitnessSpanMs <= maxFitnessSpanMs,
          name + ' loads fitness without a serial request waterfall');
  }

  await context.close();
  return result;
}

try {
  await runScenario('firefighter', 'firefighter', ['A'], [], true);
  await runScenario('super', 'super', ['A','B','C'], [], true);
  await runScenario('board failure', 'super', ['A','B','C'], ['/config/board']);
  await runScenario('shift failure', 'super', ['A','B','C'], ['/shifts/B']);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

process.exitCode = passed ? 0 : 1;
