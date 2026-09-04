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

  // 417 §4: a month the schedule does not cover is 'unknown' on every day —
  // nothing is suggested or auto-filled, a guard on such a day is NOT
  // pre-filled as an off-duty guard, and the month label says so. The same
  // holds when the subject is missing from the roster answer.
  for (const variant of ['unknown-dates', 'missing-uid']) {
    const context = await contextWithPlan({
      getMyGuardAttendance:[{ data:{ guards:[
        { id:'g-unk', date:null, title:'אבטחה בחודש לא ידוע', start:'18:00', end:'22:00', status:'staffed' }
      ] } }]
    });
    await context.addInitScript(({ mode }) => {
      const now = new Date();
      const y = now.getFullYear(), m = now.getMonth();
      const key = d => y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const last = new Date(y, m + 1, 0).getDate();
      const dates = [];
      for (let d = 1; d <= last; d += 1) dates.push(key(d));
      if (mode === 'unknown-dates') window.__STUB_UNKNOWN_DATES = dates;
      else window.__STUB_CREW_OF = { 'stub-uid': undefined, u1:'C', u2:'A', u3:'A', u4:'B', u5:'B' };
      // the guard is TODAY — #btnManual opens today's edit dialog
      window.__ATTENDANCE_TEST_GUARD_DATE = key(now.getDate());
      const plan = window.__CALLABLE_PLAN && window.__CALLABLE_PLAN.getMyGuardAttendance;
      if (plan && plan[0]) plan[0].data.guards[0].date = key(now.getDate());
    }, { mode: variant });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/attendance.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.addStyleTag({ content:'#coWrap{display:none!important}' });
    await page.waitForFunction(() =>
      document.querySelector('#work')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('#tHours')?.textContent !== '—');
    assert.equal(await page.locator('#tSug').textContent(), '0', variant + ': nothing is suggested on unknown days');
    assert.equal(await page.locator('#rows tr.sug').count(), 0, variant + ': no auto-filled row');
    assert.equal(await page.locator('#btnFill').isVisible(), false, variant + ': the fill button has nothing to fill');
    if (variant === 'unknown-dates') {
      assert.match(await page.locator('#moLabel').textContent(), /ימים מחוץ לסידור הידוע/, 'the month label names the unknown days');
    }
    // Open today's edit dialog (there is a guard today): the default must stay
    // 'regular' — unknown ≠ day off — not 'guard'.
    const guardDate = await page.evaluate(() => window.__ATTENDANCE_TEST_GUARD_DATE);
    assert.equal(await page.evaluate((key) => typeof key === 'string' && key.length === 10, guardDate), true);
    await page.evaluate(() => document.querySelector('#btnManual').click());
    await page.locator('#dType').waitFor();
    assert.equal(await page.locator('#dType').inputValue(), 'regular',
      variant + ': an unknown day must not default to an off-duty guard');
    await context.close();
    console.log('✓ attendance treats ' + variant + ' as unknown — no fill, no suggestion, no guard default');
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

console.log('\n5/5 effective-schedule failure checks passed.');
