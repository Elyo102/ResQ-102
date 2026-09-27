// Responsive layout regression: local HTML/CSS only, no Firebase or production.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8' };
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); response.end(); return;
  }
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch();
let checks = 0;
function assert(ok, message) {
  if (!ok) throw new Error(message);
  checks++;
}
async function pageAt(width, route) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, locale:'he-IL' });
  await page.route(/\.js(?:\?|$)/, route => route.fulfill({ status:200, contentType:'text/javascript', body:'' }));
  await page.goto(`http://127.0.0.1:${port}/${route}`, { waitUntil:'load' });
  return page;
}
async function widthOf(page, selector) {
  return page.locator(selector).evaluate(element => element.getBoundingClientRect().width);
}
try {
  for (const width of [320, 360, 390, 768, 1024, 1440, 1920]) {
    const home = await pageAt(width, 'login.html');
    const loginWidth = await widthOf(home, 'body > .card');
    assert(loginWidth <= 440, `login card widened at ${width}: ${loginWidth}`);
    await home.evaluate(() => {
      document.body.classList.add('bulletin-mode');
      document.querySelector('#homeView').classList.remove('hide');
    });
    const homeWidth = await widthOf(home, 'body > .card');
    const boardLayout = await home.locator('#bulletinBoard').evaluate(element => getComputedStyle(element).display);
    if (width < 1024) {
      assert(homeWidth <= 820, `mobile/tablet home width changed at ${width}: ${homeWidth}`);
      assert(boardLayout === 'flex', `mobile/tablet home grid at ${width}`);
    } else {
      // Body padding and the scrollbar scale with the viewport; the home
      // workspace must still occupy at least 93% of desktop width.
      assert(homeWidth >= width * 0.93, `desktop home remains narrow at ${width}: ${homeWidth}`);
      assert(boardLayout === 'grid', `desktop home not a grid at ${width}`);
      const urgentSpan = await home.locator('#homeUrgent').evaluate(element => getComputedStyle(element).gridColumnEnd);
      assert(urgentSpan === '-1', `urgent notice is not full width at ${width}`);
      const panels = await home.evaluate(() => ['#homeTasks', '.home-updates', '#homeFaults']
        .map(selector => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { top:rect.top, width:rect.width };
        }));
      assert(panels.every(panel => panel.width > 250), `desktop panel too narrow at ${width}`);
      assert(Math.abs(panels[2].top - panels[0].top) < 2,
        `faults and tasks do not share the desktop top row at ${width}`);
      assert(panels[1].top > panels[2].top,
        `updates must follow faults in the main column at ${width}`);
      assert(panels[2].width > panels[0].width,
        `faults main column must be wider than tasks at ${width}`);
    }
    await home.close();

    const hr = await pageAt(width, 'hr.html');
    const hrWidth = await widthOf(hr, '#hr-workspace');
    assert(width < 1024 || hrWidth >= width - 4, `HR workspace remains narrow at ${width}: ${hrWidth}`);
    await hr.close();
  }
  const workspaces = [
    ['access.html','.wrap'], ['admin.html','.wrap'], ['alerts.html','.wrap'],
    ['attendance.html','.wrap'], ['attendance-shadow.html','#main'],
    ['board.html','.wrap'], ['callout.html','.wrap'], ['check.html','.wrap'],
    ['cost-usage.html','.cu-shell'], ['faults.html','.wrap'],
    ['forms.html','.wrap'], ['guards.html','.wrap'], ['hr.html','.hr-workspace'],
    ['hr-documents.html','.documents'], ['hr-requests.html','.requests'],
    ['import.html','.wrap'], ['maintenance.html','.maintenance-shell'],
    ['metrics.html','.metrics-shell'], ['people.html','.wrap'],
    ['quals.html','.wrap'], ['saas-admin.html','.wrap'],
    ['schedule-management.html','.shell'], ['sign.html','.wrap'],
    ['stats.html','.wrap'], ['swaps.html','.wrap'], ['vehicle.html','.wrap']
  ];
  for (const [route, selector] of workspaces) {
    const page = await pageAt(1440, route);
    await page.locator(selector).evaluate(element => element.classList.remove(
      'hide', 'cu-hidden', 'metrics-hidden', 'maintenance-hidden'));
    const measured = await widthOf(page, selector);
    assert(measured >= 1300, `${route} still uses a narrow desktop wrapper: ${measured}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 1, `${route} overflows desktop viewport by ${overflow}px`);
    await page.close();
  }
  console.log(`desktop-layout-browser: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
