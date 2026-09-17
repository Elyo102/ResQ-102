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

async function open(browser, width, overrides = {}) {
  const context = await browser.newContext({ viewport:{ width, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ runtime, managerSetup, plan }) => {
    window.__SMOKE_ROLE = 'firefighter';
    window.__CALLABLE_PLAN = {
      getScheduleRuntimeStatus:[{ data:runtime }],
      getScheduleManagerSetup:[{ data:managerSetup }],
      ...plan
    };
  }, { runtime:status, managerSetup:overrides.setup || setup, plan:overrides.plan || {} });
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
  for (const [label, managerSetup] of [
    ['no policy or source', { mode:'shadow', configured:false, policy:null, missing:['policy','source'], people:[] }],
    ['no source', { mode:'shadow', configured:false, policy:null, missing:['source'], people:[] }],
    ['generated workbook configuration', { ...setup, policy:{ ...setup.policy, id:'ip_test', active_policy_id:'ip_test' }, source:{ id:'si_test' } }]
  ]) {
    await test(`file selection reaches server preview without optional station setup: ${label}`, async () => {
      const session = await open(browser, 390, { setup:managerSetup, plan:{
        previewScheduleImport:[{ data:{ month:'2026-09', from:'2026-09-01', to:'2026-09-30',
          counts:{ days:30, assignments:1 }, blocks:[], unresolved:[], people:[],
          report_digest:'workbook-preview', blocked:false } }],
        importScheduleSheet:[{ data:{ draft_id:'workbook_draft', content_digest:'workbook_content',
          from:'2026-09-01', to:'2026-09-30', summary:{ filled:1, imported_below_minimum:1, imported_absences:0 } } }],
        getScheduleDraftPreview:[{ data:{ draft_id:'workbook_draft', expected_content_digest:'workbook_content',
          import_conflicts:[{ name:'עובד ללא חשבון', date:'2026-09-01' }],
          imported:true, from:'2026-09-01', to:'2026-09-30', week_start:'2026-09-01', days:[{
            date:'2026-09-01', crew:'A', sub_stations:[{ sub_station:'eilat', label:'אילת', minimum:2,
              coverage:'ready', below_minimum:true, people:[{ person:'עובד ללא חשבון', uid:null,
                role_label:'לוחם', hours:'07:00-07:00', is_me:false }] }], guards:[], guards_status:'ready', events:[]
          }] } }]
      } });
      try {
        await session.page.locator('#importMonth').fill('2026-09');
        await session.page.locator('#importFile').setInputFiles({ name:'schedule.csv', mimeType:'text/csv',
          buffer:Buffer.from('תחנה,2026-09-01\nאילת,עובד ללא חשבון\n', 'utf8') });
        await session.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(c => c.name === 'previewScheduleImport'), null, { timeout:5000 });
        assert.equal(await session.page.locator('#importStationMap').isVisible(), false);
        await session.page.locator('#importRun').click();
        await session.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(c => c.name === 'importScheduleSheet'), null, { timeout:5000 });
        const calls = await session.page.evaluate(() => window.__CALLABLE_CALLS.filter(c => ['previewScheduleImport','importScheduleSheet'].includes(c.name)));
        assert.equal(calls.length, 2);
        for (const call of calls) {
          assert.ok(Array.isArray(call.payload.matrix));
          assert.equal(Object.hasOwn(call.payload, 'station_map'), false);
        }
        assert.equal(calls[1].payload.expected_report_digest, 'workbook-preview');
        assert.ok(calls[1].payload.request_id);
        await session.page.locator('#draftPreviewCard').waitFor({ state:'visible' });
        await session.page.waitForFunction(() => !document.querySelector('#reviewDraft').disabled, null, { timeout:5000 });
        assert.match(await session.page.locator('#draftPreview').textContent(), /עובד ללא חשבון/);
        assert.equal(await session.page.locator('#draftManualWarnings').isVisible(), true);
        assert.match(await session.page.locator('#draftManualWarningsList').textContent(), /עובד ללא חשבון.*גם בשיבוץ וגם בהיעדרות/);
        assert.equal(await session.page.locator('#publish').isDisabled(), true, 'review must precede publication');
        await session.page.locator('#reviewDraft').check();
        assert.equal(await session.page.locator('#publish').isEnabled(), true, 'optional setup cannot block reviewed imported draft');
        assert.equal(await session.page.evaluate(() => window.__CALLABLE_CALLS.some(c => c.name === 'publishSchedule')), false);
        if (process.env.SCHEDULE_SCREENSHOT_DIR && label === 'no policy or source') {
          fs.mkdirSync(process.env.SCHEDULE_SCREENSHOT_DIR, { recursive:true });
          await session.page.evaluate(() => window.scrollTo(0, 0));
          await session.page.screenshot({ path:path.join(process.env.SCHEDULE_SCREENSHOT_DIR, 'schedule-workbook-reviewed-390.png'), fullPage:true });
        }
      } finally { await session.context.close(); }
    });
  }
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
    assert.match((await summary.textContent()).trim(), /הגדרות אופציונליות.*טיוטה אוטומטית/);
    await summary.click();
    assert.equal(await advanced.getAttribute('open'), '');
    assert.equal(await advanced.locator('#policyCard').count(), 1);
    assert.equal(await advanced.locator('#sourceCard').count(), 1);
    assert.match(await advanced.locator('#policyCard h2').textContent(), /תקינה ותפקידים לטיוטה אוטומטית/);
    assert.match(await advanced.locator('#sourceCard h2').textContent(), /רשימת עובדים לטיוטה אוטומטית/);
    await summary.click();
    assert.equal(await advanced.getAttribute('open'), null);
  });

  await test('import is one draft workflow and legacy display-only controls stay hidden', async () => {
    assert.equal(await desktop.page.locator('#importShow').isVisible(), false);
    assert.equal(await desktop.page.locator('#importClear').isVisible(), false);
    assert.equal(await desktop.page.locator('#importDisplayStatus').isVisible(), false);
    assert.match(await desktop.page.locator('#importRun').textContent(), /צור טיוטה מהקובץ/);
    const annual = desktop.page.locator('#months option[value="12"]');
    assert.equal(await annual.count(), 1);
    assert.equal(await annual.isEnabled(), true);
    assert.equal((await annual.textContent()).trim(), 'שנה');
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

  await test('close button and Escape restore focus to the pencil', async () => {
    const opener = desktop.page.locator('#editDrawerOpen');
    const drawer = desktop.page.locator('#editDrawer');
    for (const closeWith of ['button', 'escape']) {
      await opener.click();
      await drawer.waitFor({ state:'visible' });
      if (closeWith === 'button') await desktop.page.locator('#editDrawerClose').click();
      else await desktop.page.keyboard.press('Escape');
      await drawer.waitFor({ state:'hidden' });
      assert.equal(await opener.evaluate((node) => document.activeElement === node), true,
        `${closeWith} did not restore focus to the pencil`);
    }
  });
  await desktop.context.close();

  const html = fs.readFileSync(path.join(root, 'schedule-management.html'), 'utf8');
  await test('the shell declares all four safe-area edges', () => {
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      assert.match(html, new RegExp(`env\\(safe-area-inset-${edge}`),
        `safe-area-inset-${edge} is not represented in the manager shell`);
    }
  });

  for (const width of [320, 360, 390, 600, 1280]) {
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
    await test(`${width}px optional paste opens by keyboard without losing its input`, async () => {
      const option = mobile.page.locator('#importPasteOption');
      const summary = option.locator('summary');
      assert.equal(await option.getAttribute('open'), null);
      assert.equal(await mobile.page.locator('#importPaste').isVisible(), false);
      await summary.focus();
      await mobile.page.keyboard.press('Enter');
      await mobile.page.locator('#importPaste').fill('בדיקת טקסט שנשמר');
      await summary.focus();
      await mobile.page.keyboard.press('Space');
      assert.equal(await mobile.page.locator('#importPaste').isVisible(), false);
      await mobile.page.keyboard.press('Enter');
      assert.equal(await mobile.page.locator('#importPaste').inputValue(), 'בדיקת טקסט שנשמר');
      assert.ok(await summary.evaluate(node => node.getBoundingClientRect().height >= 44));
      assert.ok(await mobile.page.locator('#importPaste').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
      await summary.focus();
      await mobile.page.keyboard.press('Enter');
      if (process.env.SCHEDULE_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCHEDULE_SCREENSHOT_DIR, { recursive:true });
        await mobile.page.evaluate(() => window.scrollTo(0, 0));
        await mobile.page.screenshot({ path:path.join(process.env.SCHEDULE_SCREENSHOT_DIR, `schedule-import-${width}.png`), fullPage:true });
      }
    });
    await mobile.context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`schedule manager shell browser: ${passed} passed`);
