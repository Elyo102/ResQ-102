import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const fixture = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<style>
:root{--card:#fff;--line:#ddd;--line-hover:#ccc;--txt:#182033;--dim:#556070;
--muted:#788291;--accent:#e8590c;--accent-txt:#b64000;--on-accent:#fff;--chip:#f6f7f9}
:root[data-theme="dark"]{--card:#111827;--line:#334155;--line-hover:#475569;
--txt:#f8fafc;--dim:#cbd5e1;--muted:#94a3b8;--accent:#fb7b32;
--accent-txt:#ffad7a;--on-accent:#111827;--chip:#1f2937}
body{margin:18px;font-family:Segoe UI,Arial,sans-serif;background:var(--card);color:var(--txt)}
</style></head><body><main id="content">תוכן בדיקה</main>
<script type="module">
import { renderNav, applyTheme } from '/nav.js';
const params = new URLSearchParams(location.search);
const claims = JSON.parse(params.get('claims') || '{}');
renderNav(claims, params.get('current') || 'attendance.html', 'בדיקה');
window.__applyTheme = applyTheme;
window.__navReady = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  if (pathname === '/__nav-test.html') {
    res.writeHead(200, { 'Content-Type': mime['.html'] });
    res.end(fixture);
    return;
  }
  const file = path.join(root, pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  res.end(fs.readFileSync(file));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/__nav-test.html';
const browser = await chromium.launch();
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS', name);
  } catch (error) {
    failures.push(name + ': ' + error.message);
    console.error('FAIL', name);
    console.error('  ' + error.message);
  }
}

function same(actual, expected, label) {
  const a = actual.slice().sort();
  const e = expected.slice().sort();
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(label + '\n  expected ' + JSON.stringify(e) + '\n  actual   ' + JSON.stringify(a));
  }
}

const member = [
  'login.html', 'schedule-management.html', 'board.html', 'attendance.html', 'guards.html',
  'faults.html', 'forms.html', 'sign.html', 'swaps.html', 'feedback.html', 'quals.html',
  'alerts.html', 'people.html'
];
const staff = member.concat(['access.html', 'admin.html', 'stats.html']);
const audit = staff.concat(['attendance-shadow.html']);
const all = audit.concat(['import.html', 'check.html']);
const roles = [
  ['firefighter', { role:'firefighter' }, member, 2],
  ['deputy_team_leader', { role:'deputy_team_leader' }, member, 2],
  ['team_leader', { role:'team_leader' }, member, 2],
  ['deputy', { role:'deputy' }, staff, 3],
  ['commander', { role:'commander' }, staff, 3],
  ['station_commander', { role:'station_commander' }, audit, 3],
  ['hr_coordinator', { role:'hr_coordinator' }, audit, 3],
  ['district_commander', { role:'district_commander' }, ['login.html'], 1],
  ['super', { role:'firefighter', super:true }, all, 3]
];

async function open(context, claims, current = 'attendance.html') {
  const page = await context.newPage();
  const query = new URLSearchParams({ claims:JSON.stringify(claims), current });
  await page.goto(base + '?' + query, { waitUntil:'load' });
  await page.waitForFunction(() => window.__navReady === true);
  return page;
}

try {
  const matrixContext = await browser.newContext({ viewport:{ width:1280, height:800 }, locale:'he-IL' });
  for (const [name, claims, expectedLinks, expectedDoors] of roles) {
    await test(name + ' keeps the exact permitted destinations', async () => {
      const page = await open(matrixContext, claims);
      const hrefs = await page.locator('.navPanel a').evaluateAll(nodes =>
        nodes.map(node => new URL(node.href).pathname.split('/').pop()));
      same(hrefs, expectedLinks, name + ' destination set changed');
      const doors = await page.locator('button.door').count();
      if (doors !== expectedDoors) throw new Error('expected ' + expectedDoors + ' doors, got ' + doors);
      await page.close();
    });
  }
  await matrixContext.close();

  const mobile = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  const mobilePage = await open(mobile, { role:'firefighter' });
  await test('mobile starts collapsed and keeps RTL', async () => {
    if (!await mobilePage.locator('#navToggle').isVisible()) throw new Error('menu toggle is hidden');
    if (await mobilePage.locator('#navLinks').isVisible()) throw new Error('menu starts open');
    const direction = await mobilePage.locator('#appNav').evaluate(el => getComputedStyle(el).direction);
    if (direction !== 'rtl') throw new Error('direction is ' + direction);
  });
  await test('mobile opens one group at a time and Escape closes in two stages', async () => {
    await mobilePage.locator('#navToggle').click();
    const doors = mobilePage.locator('button.door');
    await doors.nth(0).click();
    if (!await mobilePage.locator('#panel-mine').isVisible()) throw new Error('first panel did not open');
    await doors.nth(1).click();
    if (await mobilePage.locator('#panel-mine').isVisible()) throw new Error('first panel stayed open');
    if (!await mobilePage.locator('#panel-station').isVisible()) throw new Error('second panel did not open');
    await mobilePage.keyboard.press('Escape');
    if (await mobilePage.locator('#panel-station').isVisible()) throw new Error('Escape did not close panel');
    if (!await doors.nth(1).evaluate(el => document.activeElement === el)) throw new Error('focus did not return to door');
    await mobilePage.keyboard.press('Escape');
    if (await mobilePage.locator('#navLinks').isVisible()) throw new Error('second Escape did not close menu');
    if (!await mobilePage.locator('#navToggle').evaluate(el => document.activeElement === el)) throw new Error('focus did not return to toggle');
  });
  await test('mobile controls meet the 44px touch target', async () => {
    await mobilePage.locator('#navToggle').click();
    await mobilePage.locator('button.door').first().click();
    const heights = await mobilePage.locator('#navToggle,button.door,.navPanel a,#themeBtn')
      .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)
        .filter(height => height > 0));
    if (!heights.length || heights.some(height => height < 43.5)) {
      throw new Error('touch target heights: ' + JSON.stringify(heights));
    }
  });
  await test('mobile has no horizontal overflow', async () => {
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) throw new Error('horizontal overflow ' + overflow + 'px');
  });
  await test('dark and light preferences remain functional', async () => {
    await mobilePage.evaluate(() => window.__applyTheme('dark'));
    if (await mobilePage.locator('html').getAttribute('data-theme') !== 'dark') throw new Error('dark mode failed');
    await mobilePage.evaluate(() => window.__applyTheme('light'));
    if (await mobilePage.locator('html').getAttribute('data-theme') !== 'light') throw new Error('light mode failed');
  });
  if (process.env.NAV_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.NAV_SCREENSHOT_DIR, { recursive:true });
    await mobilePage.screenshot({ path:path.join(process.env.NAV_SCREENSHOT_DIR, 'nav-mobile.png'), fullPage:true });
  }
  await mobile.close();

  const desktop = await browser.newContext({ viewport:{ width:1280, height:800 }, locale:'he-IL' });
  const desktopPage = await open(desktop, { role:'commander' }, 'attendance.html');
  await test('desktop shows three groups and marks the current group', async () => {
    if (await desktopPage.locator('#navToggle').isVisible()) throw new Error('mobile toggle is visible');
    if (await desktopPage.locator('button.door').count() !== 3) throw new Error('expected three doors');
    const here = desktopPage.locator('button.door.here');
    if (await here.count() !== 1 || !/המשמרת שלי/.test(await here.textContent())) throw new Error('current group is not marked');
    await here.click();
    const current = desktopPage.locator('a[aria-current="page"]');
    if (await current.count() !== 1 || await current.textContent() !== 'נוכחות') throw new Error('current page link changed');
  });
  await test('desktop has no horizontal overflow', async () => {
    const overflow = await desktopPage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) throw new Error('horizontal overflow ' + overflow + 'px');
  });
  if (process.env.NAV_SCREENSHOT_DIR) {
    await desktopPage.screenshot({ path:path.join(process.env.NAV_SCREENSHOT_DIR, 'nav-desktop.png'), fullPage:true });
  }
  await desktop.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('');
if (failures.length) {
  console.error(failures.length + ' failed; ' + passed + ' passed');
  failures.forEach(item => console.error('- ' + item));
  process.exitCode = 1;
} else {
  console.log(passed + ' tests passed');
}
