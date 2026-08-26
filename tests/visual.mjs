// צילומי QA מקומיים למסכים מרכזיים. אינם נשלחים לענן ואינם
// משתמשים בנתוני עובדים; Firebase מוחלף באותם stubs של smoke.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const out = path.join(here, '.visual');
fs.mkdirSync(out, { recursive: true });

const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.png':'image/png' };
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/login.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(8391, resolve));

const browser = await chromium.launch();
for (const size of [{ name:'mobile', width:390, height:844 }, { name:'desktop', width:1280, height:900 }]) {
  const context = await browser.newContext({ viewport: size, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript('window.__SMOKE_ROLE = "none";');
  const page = await context.newPage();
  await page.goto('http://localhost:8391/login.html', { waitUntil:'load' });
  await page.waitForTimeout(6800);
  await page.screenshot({ path:path.join(out, 'login-' + size.name + '.png'), fullPage:true });
  await context.close();

  const appContext = await browser.newContext({ viewport: size, locale:'he-IL' });
  await appContext.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await appContext.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await appContext.addInitScript('window.__SMOKE_ROLE = "super";');
  const appPage = await appContext.newPage();
  for (const screen of ['schedule', 'attendance', 'swaps', 'forms']) {
    await appPage.goto('http://localhost:8391/' + screen + '.html', { waitUntil:'load' });
    await appPage.waitForTimeout(2600);
    await appPage.addStyleTag({ content:'#coWrap{display:none!important}' });
    await appPage.screenshot({ path:path.join(out, screen + '-' + size.name + '.png'), fullPage:true });
  }
  await appContext.close();
}
await browser.close();
server.close();
console.log('Visual QA screenshots written to tests/.visual (local only).');
