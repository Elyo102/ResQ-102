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
await context.close();

const appContext = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await appContext.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await appContext.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
await appContext.addInitScript('window.__SMOKE_ROLE = "super";');
const attendance = await appContext.newPage();
await attendance.goto('http://localhost:8392/attendance.html', { waitUntil:'load' });
await attendance.locator('.days .btn').first().waitFor({ state:'visible', timeout:8000 });
await attendance.addStyleTag({ content:'#coWrap{display:none!important}' });
const source = attendance.locator('.days .btn').first();
await source.focus();
await attendance.keyboard.press('Enter');
await check(await attendance.locator('#ov').getAttribute('aria-hidden') === 'false', 'attendance dialog opens semantically');
await attendance.waitForFunction(() => document.activeElement?.id === 'dType');
await check(await attendance.evaluate(() => document.activeElement?.id === 'dType'), 'attendance dialog focuses its first control');
await attendance.keyboard.press('Shift+Tab');
await check(await attendance.evaluate(() => document.activeElement?.id === 'dCancel'), 'Shift+Tab wraps to the last dialog control');
await attendance.keyboard.press('Tab');
await check(await attendance.evaluate(() => document.activeElement?.id === 'dType'), 'Tab remains trapped inside the dialog');
await attendance.keyboard.press('Escape');
await check(await attendance.locator('#ov').getAttribute('aria-hidden') === 'true', 'Escape closes the attendance dialog');
await check(await source.evaluate(el => document.activeElement === el), 'attendance dialog restores focus to its source');
const sourceDate = await source.getAttribute('data-date');
await attendance.keyboard.press('Enter');
await attendance.waitForFunction(() => document.activeElement?.id === 'dType');
await attendance.locator('#dSave').focus();
await attendance.keyboard.press('Enter');
await attendance.locator('#ov').waitFor({ state:'hidden', timeout:5000 });
await attendance.waitForFunction(date => document.activeElement?.dataset?.date === date, sourceDate);
await check(await attendance.evaluate(date => document.activeElement?.dataset?.date === date, sourceDate),
            'attendance save restores focus after the row is rebuilt');

const swaps = await appContext.newPage();
await swaps.goto('http://localhost:8392/swaps.html', { waitUntil:'load' });
await swaps.addStyleTag({ content:'#coWrap{display:none!important}' });
const take = swaps.getByRole('button', { name:'אני מעוניין להחליף' }).first();
await take.waitFor({ state:'visible', timeout:8000 });
await take.focus();
await take.click();
await swaps.locator('#tkDate').waitFor({ state:'visible', timeout:3000 });
await check(await swaps.locator('#ov').getAttribute('aria-hidden') === 'false',
            'open swap dialog opens semantically');
await swaps.waitForFunction(() => document.activeElement?.id === 'tkDate');
await check(await swaps.evaluate(() => document.activeElement?.id === 'tkDate'),
            'open swap dialog focuses the date');
await swaps.keyboard.press('Shift+Tab');
await check(await swaps.evaluate(() => document.activeElement?.id === 'tkX'),
            'open swap dialog wraps focus backward');
await swaps.keyboard.press('Escape');
await check(await swaps.locator('#ov').getAttribute('aria-hidden') === 'true',
            'Escape closes the open swap dialog');
await check(await take.evaluate(el => document.activeElement === el),
            'open swap dialog restores focus to its source');

const pick = swaps.locator('#btnPick');
await pick.focus();
await pick.click();
await swaps.locator('#pq').waitFor({ state:'visible', timeout:3000 });
await check(await swaps.locator('#ov').getAttribute('aria-hidden') === 'false',
            'picker opens after a previous swap dialog closed');
await swaps.waitForFunction(() => document.activeElement?.id === 'pq');
await check(await swaps.evaluate(() => document.activeElement?.id === 'pq'),
            'picker focuses its search field');
await swaps.keyboard.press('Escape');
await check(await pick.evaluate(el => document.activeElement === el),
            'picker restores focus to the picker button');

await take.focus();
await take.click();
await swaps.locator('#tkDate').fill('2026-09-03');
await swaps.locator('#tkGo').click();
await swaps.locator('#ov').waitFor({ state:'hidden', timeout:5000 });
await swaps.waitForFunction(() => document.activeElement?.id === 'openMsg');
await check(await swaps.evaluate(() => document.activeElement?.id === 'openMsg'),
            'successful open swap keeps focus after the list is rebuilt');
await appContext.close();

await browser.close();
server.close();
