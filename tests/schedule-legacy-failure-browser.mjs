// Executable failure-state coverage for the legacy schedule bridge.
// Firebase is fully stubbed; this file cannot reach a real project.

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch();

async function contextWithPlan(plan) {
  const context = await browser.newContext({
    viewport:{ width:390, height:844 }, locale:'he-IL', timezoneId:'Asia/Jerusalem'
  });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(value => {
    window.__SMOKE_ROLE = 'super';
    window.__CALLABLE_PLAN = value;
  }, plan);
  return context;
}

try {
  // A compatibility failure must clear old totals and finish the loading
  // state. Only month navigation remains available as an explicit retry;
  // every action that calculates or writes remains disabled.
  {
    const context = await contextWithPlan({
      getEffectiveWorkdays:[{ reject:true }]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/attendance.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.addStyleTag({ content:'#coWrap{display:none!important}' });
    await page.waitForFunction(() =>
      document.querySelector('#msg')?.textContent.includes('החישוב נעצר'));
    assert.match(await page.locator('#moLabel').textContent(), /נתונים לא זמינים/);
    assert.equal(await page.locator('#tHours').textContent(), '—');
    assert.equal(await page.locator('#tDays').textContent(), '—');
    assert.equal(await page.locator('#tSug').textContent(), '—');
    assert.equal(await page.locator('#work').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#btnFill').isDisabled(), true);
    assert.equal(await page.locator('#btnSync').isDisabled(), true);
    assert.equal(await page.locator('.days button').count(), 0);
    assert.equal(await page.locator('#next').isEnabled(), true);

    // The next bounded request uses the normal stub response and recovers;
    // the original error is not overwritten with a false stale-request note.
    await page.locator('#next').click();
    await page.waitForFunction(() =>
      document.querySelector('#work')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('#tHours')?.textContent !== '—');
    const workdaysCalls = await page.evaluate(() =>
      (window.__CALLABLE_CALLS || []).filter(call =>
        call && call.name === 'getEffectiveWorkdays').length);
    assert.equal(workdaysCalls, 2);
    assert.doesNotMatch(await page.locator('#msg').textContent(), /האדם או החודש השתנו/);
    await context.close();
    console.log('✓ attendance fails closed without stale KPIs and month navigation retries safely');
  }

  // A rejected schedule bridge must keep submission disabled and both date
  // labels honest. Raw legacy collections are never used as a fallback.
  {
    const context = await contextWithPlan({
      getEffectiveWorkdays:[{ reject:true }]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/swaps.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.waitForFunction(() =>
      document.querySelector('#newMsg')?.textContent.includes('לא ניתן לחשב או לשלוח'));
    const min = await page.locator('#myDate').getAttribute('min');
    await page.locator('#myDate').fill(min);
    assert.equal(await page.locator('#btnSend').isDisabled(), true);
    assert.match(await page.locator('#myCrewLine').textContent(), /בסיס הסידור אינו זמין/);
    assert.match(await page.locator('#newMsg').textContent(), /לא ניתן לחשב או לשלוח/);
    await context.close();
    console.log('✓ swaps keeps submission and schedule-derived labels fail-closed after rejection');
  }

  // Defense in depth: every screen parses the workdays answer through the
  // shared allowlist instead of assigning the server response object directly.
  {
    for (const file of ['stats.html', 'guards.html', 'swaps.html', 'attendance.html']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(source, /parseEffectiveWorkdays[\(\)]/, file);
      assert.doesNotMatch(source, /effective\s*=\s*(?:result|res|out)\.data\b/, file);
    }
    const module = fs.readFileSync(path.join(root, 'effective-workdays.js'), 'utf8');
    assert.match(module, /fail\('workdays-by-uid'\)/);
    assert.match(module, /const SHIFT_HOUR_FIELDS = Object\.freeze/);
    console.log('✓ every screen keeps the client-side workdays allowlist');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('\n3/3 effective-schedule failure checks passed.');
