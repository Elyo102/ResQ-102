// מדידת זמן עד שמסך הנוכחות נהיה שימושי בחיבור איטי מדומה.
// הנתונים מקומיים וסינתטיים; כל קריאת Firestore מקבלת השהיה
// קבועה כדי לחשוף waterfall של בקשות סדרתיות.
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
const maxDataSpanMs = 1500;
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/attendance.html');
  const file = path.join(root, urlPath === '/' ? 'attendance.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(port, resolve));

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
await page.goto('http://localhost:' + port + '/attendance.html', { waitUntil:'load' });
await page.locator('.days .btn').first().waitFor({ state:'visible', timeout:12000 });
const result = await page.evaluate(() => ({
  interactiveMs: Date.now() - window.__PERF_STARTED,
  dataRequests: window.__N || 0,
  dataSpanMs: (window.__TN || Date.now()) - (window.__T0 || Date.now()),
  dataPaths: (window.__DATA_PATHS || []).slice()
}));

console.log('Attendance slow-network benchmark');
console.log('lag per data request:', lagMs + 'ms');
console.log('time to usable report:', result.interactiveMs + 'ms');
console.log('data requests started:', result.dataRequests);
console.log('measured data span:', result.dataSpanMs + 'ms');
let passed = result.interactiveMs <= maxInteractiveMs &&
             result.dataSpanMs <= maxDataSpanMs;
console.log(passed
  ? '✓ attendance data sources load without a serial request waterfall'
  : '✗ attendance loading regressed to a serial request waterfall');

function check(ok, message) {
  passed = passed && !!ok;
  console.log((ok ? '✓ ' : '✗ ') + message);
}

const criticalPaths = ['/rotations','/guards','/shift_overrides','/config/board',
  '/shifts/C','/swaps','/sub_stations','/attendance','/monthly_reports/1_'];
check(result.dataRequests === 14, 'benchmark keeps the expected 14 data requests');
criticalPaths.forEach(suffix => {
  check(result.dataPaths.some(p => p.includes(suffix)),
        'benchmark exercised ' + suffix);
});

// שתי טעינות חודש בכוונה יוצאות יחד: הראשונה איטית והשנייה
// מהירה. אחרי שהאיטית חוזרת, הכותרת חייבת להישאר של האחרונה.
await page.waitForTimeout(lagMs + 120);
const monthStart = await page.locator('#moLabel').textContent();
await page.evaluate(() => {
  window.__SMOKE_LAG_PLAN = [700, 700, 40, 40];
  const next = document.getElementById('next');
  next.disabled = false; next.click();
  next.disabled = false; next.click();
});
await page.waitForTimeout(160);
const winningMonth = await page.locator('#moLabel').textContent();
await page.waitForTimeout(700);
const finalMonth = await page.locator('#moLabel').textContent();
check(winningMonth !== monthStart && finalMonth === winningMonth,
      'a slow older month cannot overwrite the latest month');
check(await page.locator('#work').getAttribute('aria-busy') === 'false',
      'month loading releases the busy state');

// תחנת ברירת המחדל והאבטחות תלויות באדם שנבחר. קודם עוברים
// לאדם אחר וחוזרים בצורה רגילה, כדי לוודא שמידע של אדם קודם
// אינו משמש fallback גם כאשר שתי הטעינות הצליחו.
await page.locator('#pickWho option[value="17"]').waitFor({ state:'attached' });
await page.selectOption('#pickWho', '17');
await page.evaluate(() => document.getElementById('pickGo').click());
await page.waitForFunction(() =>
  document.getElementById('work').getAttribute('aria-busy') === 'false' &&
  !document.getElementById('otherBar').classList.contains('hide'));
const otherSiteRow = (await page.locator('#rows tr.sug').first().textContent()) || '';
check(otherSiteRow.includes('שחמון') && !otherSiteRow.includes('ראשית'),
      'switching subject publishes that subject\'s default site');

await page.evaluate(() => document.getElementById('pickBack').click());
await page.waitForFunction(() =>
  document.getElementById('work').getAttribute('aria-busy') === 'false' &&
  document.getElementById('otherBar').classList.contains('hide'));
const selfSiteRow = (await page.locator('#rows tr.sug').first().textContent()) || '';
check(selfSiteRow.includes('ראשית') && !selfSiteRow.includes('שחמון'),
      'returning to self clears the previous subject\'s default site');

// אותו תרחיש על אדם: מעבר לאדם אחר מתחיל לאט, וחזרה לעצמי
// מתחילה מהר. ההרצה הישנה אינה רשאית לפרסם או לפתוח loadMonth.
const beforeSubjectRace = await page.evaluate(() => window.__N || 0);
await page.evaluate(() => {
  window.__SMOKE_LAG_PLAN = [
    700,700,700,700,700,700,700,
    40,40,40,40,40,40,40,40,40
  ];
  const pick = document.getElementById('pickWho');
  pick.value = '17';
  const go = document.getElementById('pickGo');
  go.disabled = false; go.click();
  const back = document.getElementById('pickBack');
  back.disabled = false; back.click();
});
await page.waitForTimeout(950);
const subjectRace = await page.evaluate(before => {
  const paths = (window.__DATA_PATHS || []).slice(before);
  return {
    delta: (window.__N || 0) - before,
    monthReads: paths.filter(p => /\/attendance$|\/monthly_reports\//.test(p)).length,
    otherHidden: document.getElementById('otherBar').classList.contains('hide'),
    backHidden: document.getElementById('pickBack').classList.contains('hide'),
    busy: document.getElementById('work').getAttribute('aria-busy'),
    siteText: (document.querySelector('#rows tr.sug') || {}).textContent || ''
  };
}, beforeSubjectRace);
check(subjectRace.delta === 16 && subjectRace.monthReads === 2,
      'a stale subject load is discarded before starting a month load');
check(subjectRace.otherHidden && subjectRace.backHidden && subjectRace.busy === 'false',
      'the latest subject remains active after the stale load returns');
check(subjectRace.siteText.includes('ראשית') && !subjectRace.siteText.includes('שחמון'),
      'a stale subject cannot publish its default site');

// סנכרון מתחיל, אחריו המשתמש עובר חודש. הסנכרון הישן חוזר
// לפני טעינת החודש החדש ואסור לו להפעיל את עצמו או את שעון
// המשמרת בזמן שהמסך עדיין מחזיק נתונים מהחודש הקודם.
await page.evaluate(() => {
  window.__SMOKE_LAG_PLAN = new Array(7).fill(300).concat([700, 700]);
  const sync = document.getElementById('btnSync');
  sync.disabled = false; sync.click();
  const next = document.getElementById('next');
  next.disabled = false; next.click();
});
await page.waitForTimeout(420);
const duringMonthLoad = await page.evaluate(() => ({
  busy: document.getElementById('work').getAttribute('aria-busy'),
  syncDisabled: document.getElementById('btnSync').disabled,
  startDisabled: document.getElementById('btnStart').disabled,
  stopDisabled: document.getElementById('btnStop').disabled
}));
check(duringMonthLoad.busy === 'true' && duringMonthLoad.syncDisabled,
      'a stale sync cannot bypass the month busy state');
check(duringMonthLoad.startDisabled && duringMonthLoad.stopDisabled,
      'shift timer actions stay locked while a month is loading');
await page.waitForFunction(() =>
  document.getElementById('work').getAttribute('aria-busy') === 'false',
  null, { timeout:2500 });
check(await page.locator('#btnSync').isEnabled(),
      'the latest month load releases actions after publishing data');

await context.close();
await browser.close();
server.close();
process.exitCode = passed ? 0 : 1;
