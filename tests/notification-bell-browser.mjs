// 42H.20 §3 · פעמון התראות ליד השם, לכל תפקיד פעיל בכל מסך.
//
// לא בדיקת עיצוב חדשה — בדיקה חוזרת על אותה תשתית fixture/server
// כמו nav-groups.mjs, כי renderNav הוא מקור אמת יחיד לניווט ולפעמון
// כאחד. מוודאת: הפעמון קיים לכל תפקיד פעיל, מקושר ל-alerts.html
// הקיים בלבד (לא בונה מנגנון התראות חדש), 44x44 בכל אחד משלושת
// הרוחבים 320/360/390, אין מונה שלא נבדק שהוא אמיתי, נגיש במקלדת,
// ונחסם נכון בזמן תצוגת-תפקיד בדיוק כמו קישורי ניווט אחרים.

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
body{margin:18px;font-family:Segoe UI,Arial,sans-serif;background:var(--card);color:var(--txt)}
</style></head><body><main id="content">תוכן בדיקה</main>
<script type="module">
import { renderNav } from '/nav.js';
const params = new URLSearchParams(location.search);
const claims = JSON.parse(params.get('claims') || '{}');
const presentation = params.get('presentation') ? JSON.parse(params.get('presentation')) : null;
renderNav(claims, params.get('current') || 'attendance.html', 'בדיקה', presentation);
window.__navReady = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  if (pathname === '/__bell-test.html') {
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
const base = 'http://127.0.0.1:' + server.address().port + '/__bell-test.html';
const browser = await chromium.launch();
let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS', name); }
  catch (error) { failures.push(name + ': ' + error.message); console.error('FAIL', name); console.error('  ' + error.message); }
}

async function open(context, claims, current = 'login.html', presentation = null) {
  const page = await context.newPage();
  const query = new URLSearchParams({ claims: JSON.stringify(claims), current });
  if (presentation) query.set('presentation', JSON.stringify(presentation));
  await page.goto(base + '?' + query, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__navReady === true);
  return page;
}

const roles = [
  ['firefighter', { role: 'firefighter' }],
  ['team_leader', { role: 'team_leader' }],
  ['deputy', { role: 'deputy' }],
  ['commander', { role: 'commander' }],
  ['station_commander', { role: 'station_commander' }],
  ['hr_coordinator', { role: 'hr_coordinator' }],
  ['super_admin', { role: 'firefighter', super: true }]
];

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'he-IL' });
  for (const [name, claims] of roles) {
    await test('bell is present, linked to alerts.html and 44x44 for role: ' + name, async () => {
      const page = await open(ctx, claims);
      const bell = page.locator('#appNav a.bell');
      if (!await bell.count()) throw new Error('bell missing for ' + name);
      const href = await bell.evaluate(el => new URL(el.href).pathname.split('/').pop());
      if (href !== 'alerts.html') throw new Error('bell points to ' + href + ' instead of alerts.html');
      const label = await bell.getAttribute('aria-label');
      if (label !== 'התראות') throw new Error('bell aria-label missing/wrong: ' + label);
      const box = await bell.boundingBox();
      if (!box || box.width < 44 || box.height < 44) throw new Error('bell target too small: ' + JSON.stringify(box));
      const badge = await page.locator('#appNav a.bell [class*="badge"],#appNav a.bell [class*="count"]').count();
      if (badge) throw new Error('bell shows an unread badge with no wired trusted source');
      await page.close();
    });
  }
  await ctx.close();

  for (const width of [320, 360, 390]) {
    const mctx = await browser.newContext({ viewport: { width, height: 844 }, locale: 'he-IL' });
    const page = await open(mctx, { role: 'firefighter' });
    await test(width + 'px: bell stays a 44x44 target with no overflow', async () => {
      const bell = page.locator('#appNav a.bell');
      const box = await bell.boundingBox();
      if (!box || box.width < 44 || box.height < 44) throw new Error(width + 'px bell target: ' + JSON.stringify(box));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 1) throw new Error(width + 'px horizontal overflow ' + overflow + 'px');
    });
    await test(width + 'px: bell respects safe-area inset and stays reachable by keyboard', async () => {
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--resq-safe-right-override', '30px');
        document.documentElement.style.setProperty('--resq-safe-left-override', '30px');
      });
      const bell = page.locator('#appNav a.bell');
      await bell.focus();
      if (!await bell.evaluate(el => document.activeElement === el)) throw new Error(width + 'px bell is not focusable');
      const box = await bell.boundingBox();
      if (box.x < 0 || box.x + box.width > await page.evaluate(() => innerWidth)) {
        throw new Error(width + 'px bell escapes viewport: ' + JSON.stringify(box));
      }
    });
    await page.close();
    await mctx.close();
  }

  const previewCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'he-IL' });
  await test('bell is disabled during role-preview on a non-preview-safe current page', async () => {
    const presentation = { kind: 'role_view', role_id: 'firefighter', label: 'כבאי' };
    const page = await open(previewCtx, { role: 'firefighter', super: true }, 'attendance.html', presentation);
    const bell = page.locator('#appNav a.bell');
    if (await bell.getAttribute('aria-disabled') !== 'true') throw new Error('bell is not marked disabled in preview');
    if (await bell.getAttribute('href')) throw new Error('bell still carries an href while blocked');
    let navigated = false;
    page.once('framenavigated', () => { navigated = true; });
    await bell.click({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
    if (navigated) throw new Error('clicking a blocked bell navigated anyway');
    await page.close();
  });
  await previewCtx.close();
} finally {
  await browser.close();
  server.close();
}

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);
