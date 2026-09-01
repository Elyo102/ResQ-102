// Legacy schedule compatibility: executable browser failure/race coverage.
// Firebase is replaced with local stubs; this test cannot reach production.

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
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(value => {
    window.__SMOKE_ROLE = 'super';
    window.__CALLABLE_PLAN = value;
  }, plan);
  return context;
}

try {
  // A malformed server response must stop workload calculation. It must never
  // be reinterpreted as a valid empty guard board.
  {
    const context = await contextWithPlan({
      getGuardLoadStatistics:[{ data:{ ok:true } }]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/stats.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.waitForFunction(() =>
      document.querySelector('#lList')?.textContent.includes('החישוב נעצר'));
    assert.match(await page.locator('#lLead').textContent(), /לא הצלחנו לטעון את נתוני האבטחות/);
    assert.equal(await page.locator('#lList .nm').count(), 0);
    await context.close();
    console.log('✓ malformed guard board stops statistics instead of publishing zero guards');
  }

  // setupMode is intentionally earlier than the network result. Select both
  // dates during the delay and prove that success refreshes both stale labels.
  {
    const compatibility = {
      mode:'shadow',
      rotations:[
        { crew:'A', position_in_cycle:0, cycle_days:3, anchor_date:'2026-01-01', is_active:true,
          shift_start:'07:00', shift_end:'07:00', shift_hours:24 },
        { crew:'B', position_in_cycle:1, cycle_days:3, anchor_date:'2026-01-01', is_active:true },
        { crew:'C', position_in_cycle:2, cycle_days:3, anchor_date:'2026-01-01', is_active:true }
      ],
      overrides:{}
    };
    const context = await contextWithPlan({
      getLegacyScheduleCompatibilityContext:[{ delay:900, data:compatibility }]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/swaps.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.locator('#myDate').fill('2026-09-02');
    await page.locator('#hisDate').fill('2026-09-03');
    assert.match(await page.locator('#myCrewLine').textContent(), /בסיס הסידור אינו זמין/);
    assert.match(await page.locator('#hisCrewLine').textContent(), /בסיס הסידור אינו זמין/);
    await page.waitForFunction(() => !document.querySelector('#btnSend')?.disabled);
    assert.match(await page.locator('#myCrewLine').textContent(), /עובדת ביום זה/);
    assert.match(await page.locator('#hisCrewLine').textContent(), /עובדת ביום זה/);
    await context.close();
    console.log('✓ delayed compatibility success refreshes both selected swap dates');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('\n2/2 legacy compatibility browser checks passed.');
