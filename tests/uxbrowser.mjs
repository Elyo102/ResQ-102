import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/login.html');
  const file = path.join(root, urlPath === '/' ? 'login.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('no'); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(8392, resolve));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await context.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
await context.addInitScript('window.__SMOKE_ROLE = "none";');
const page = await context.newPage();
await page.goto('http://localhost:8392/login.html', { waitUntil:'load' });
await page.waitForTimeout(6800);

async function check(value, message) {
  if (!value) throw new Error(message);
  console.log('✓ ' + message);
}
await page.locator('#tabLogin').focus();
await page.keyboard.press('ArrowRight');
await check(await page.locator('#tabFirst').getAttribute('aria-selected') === 'true', 'ArrowRight activates registration');
await check(await page.evaluate(() => document.activeElement?.id === 'tabFirst'), 'registration tab receives focus');
await check(await page.locator('#paneFirst').isVisible(), 'registration panel is visible');
await page.keyboard.press('Home');
await check(await page.locator('#tabLogin').getAttribute('aria-selected') === 'true', 'Home returns to login');
await check(await page.locator('#paneLogin').isVisible(), 'login panel is visible');

await browser.close();
server.close();
