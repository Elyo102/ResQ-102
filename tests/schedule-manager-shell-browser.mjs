import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json'
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'schedule-management.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  response.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/schedule-management.html?tab=manage`;

const status = {
  mode:'shadow', configured:true, manager:true,
  active:{ publication_id:'trial_active_1', revision:4, previous_publication_id:'trial_active_0',
    can_rollback:true, content_digest:'trial_digest_1', from:'2026-09-01', to:'2026-11-30' }
};
const setup = {
  mode:'shadow', configured:true,
  policy:{ id:'policy_1', active_policy_id:'policy_1', version:'v1', digest:'digest_policy_1',
    rest:{ min_gap_days:2 }, rotation:null, max_shifts_per_month:12,
    sub_stations:[{ id:'main', label:'אילת', minimum:2,
      requirements:[{ role:'driver', label:'נהג', count:1, required:true },
        { role:'firefighter', label:'לוחם', count:1, required:true }] }] },
  source:{ id:'source_1', version:'1', revision:'7' },
  people:[{ id:'stub-uid', name:'אלדד יונה', sub_station:'main', roles:['firefighter'] },
    { id:'crew_1', name:'טל חודרה', sub_station:'main', roles:['driver','firefighter'] }]
};

async function open(browser, width) {
  const context = await browser.newContext({ viewport:{ width, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ runtime, managerSetup }) => {
    window.__SMOKE_ROLE = 'firefighter';
    window.__CALLABLE_PLAN = {
      getScheduleRuntimeStatus:[{ data:runtime }],
      getScheduleManagerSetup:[{ data:managerSetup }]
    };
  }, { runtime:status, managerSetup:setup });
  const page = await context.newPage();
  await page.goto(base, { waitUntil:'load' });
  await page.locator('#appMain:not(.hide)').waitFor();
  return { context, page };
}

let passed = 0;
async function test(name, fn) {
  await fn(); passed += 1; console.log(`PASS ${name}`);
}

const browser = await chromium.launch();
try {
  const desktop = await open(browser, 1200);
  await test('unified manager workflow exposes the five actions in operational order', async () => {
    const workflow = desktop.page.locator('#managerWorkflow');
    await workflow.waitFor();
    const actions = workflow.locator('[data-workflow-action]');
    assert.deepEqual(await actions.evaluateAll((nodes) => nodes.map((node) => node.dataset.workflowAction)),
      ['import', 'draft', 'review', 'publish', 'rollback']);
    for (const action of ['import', 'draft', 'review', 'publish', 'rollback']) {
      const control = workflow.locator(`[data-workflow-action="${action}"]`);
      assert.equal(await control.count(), 1, `missing or duplicate ${action} workflow action`);
      assert.ok((await control.getAttribute('aria-label')) || (await control.textContent()).trim(),
        `${action} workflow action has no accessible name`);
    }
  });

  await test('advanced station setup is collapsed by default and remains user controlled', async () => {
    const advanced = desktop.page.locator('#managerAdvanced');
    assert.equal(await advanced.evaluate((node) => node.tagName), 'DETAILS');
    assert.equal(await advanced.getAttribute('open'), null);
    const summary = advanced.locator(':scope > summary');
    assert.ok((await summary.textContent()).trim());
    await summary.click();
    assert.equal(await advanced.getAttribute('open'), '');
    assert.equal(await advanced.locator('#policyCard').count(), 1);
    assert.equal(await advanced.locator('#sourceCard').count(), 1);
    await summary.click();
    assert.equal(await advanced.getAttribute('open'), null);
  });

  await test('pencil opens one accessible edit drawer and browser back closes only the drawer', async () => {
    const opener = desktop.page.locator('#editDrawerOpen');
    assert.equal(await opener.getAttribute('aria-controls'), 'editDrawer');
    await opener.click();
    const drawer = desktop.page.locator('#editDrawer');
    await drawer.waitFor({ state:'visible' });
    assert.equal(await drawer.getAttribute('role'), 'dialog');
    assert.equal(await drawer.getAttribute('aria-modal'), 'true');
    assert.ok(await drawer.getAttribute('aria-labelledby') || await drawer.getAttribute('aria-label'));
    assert.equal(await drawer.locator('#editCard').count(), 1,
      'pencil drawer bypasses or duplicates the existing preview/apply edit card');
    assert.equal(await drawer.locator('#editApply').isDisabled(), true,
      'opening the pencil exposed apply before a preview');
    const before = desktop.page.url();
    await desktop.page.evaluate(() => history.back());
    await drawer.waitFor({ state:'hidden' });
    assert.equal(desktop.page.url(), before, 'browser Back navigated away instead of closing the drawer');
    assert.equal(await opener.evaluate((node) => document.activeElement === node), true,
      'closing the drawer did not restore focus to the pencil');
  });
  await desktop.context.close();

  const html = fs.readFileSync(path.join(root, 'schedule-management.html'), 'utf8');
  await test('the shell declares all four safe-area edges', () => {
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      assert.match(html, new RegExp(`env\\(safe-area-inset-${edge}`),
        `safe-area-inset-${edge} is not represented in the manager shell`);
    }
  });

  for (const width of [320, 360, 390]) {
    const mobile = await open(browser, width);
    await test(`${width}px manager shell stays inside the document and keeps actions reachable`, async () => {
      const metrics = await mobile.page.evaluate(() => {
        const workflow = document.getElementById('managerWorkflow');
        const rect = workflow.getBoundingClientRect();
        const controls = Array.from(workflow.querySelectorAll('[data-workflow-action]'));
        return {
          documentFits:document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          bodyFits:document.body.scrollWidth <= document.documentElement.clientWidth + 1,
          workflowFits:workflow.scrollWidth <= workflow.clientWidth + 1,
          visible:rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= 0,
          actionCount:controls.length,
          touch:controls.every((node) => {
            const box = node.getBoundingClientRect();
            return box.width >= 44 && box.height >= 44;
          })
        };
      });
      assert.deepEqual(metrics, {
        documentFits:true, bodyFits:true, workflowFits:true, visible:true,
        actionCount:5, touch:true
      });

      await mobile.page.locator('#editDrawerOpen').click();
      const drawer = mobile.page.locator('#editDrawer');
      await drawer.waitFor({ state:'visible' });
      const drawerMetrics = await drawer.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return {
          pageFits:document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          drawerFits:node.scrollWidth <= node.clientWidth + 1,
          inViewport:box.left >= -1 && box.right <= innerWidth + 1
        };
      });
      assert.deepEqual(drawerMetrics, { pageFits:true, drawerFits:true, inViewport:true });
      await mobile.page.locator('#editDrawerClose').click();
      await drawer.waitFor({ state:'hidden' });
    });
    await mobile.context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`schedule manager shell browser: ${passed}/7 passed`);
