// Home command dashboard — release acceptance for the approved mobile shell.
//
// This test uses only local Firebase stubs. It never contacts Firebase or a
// deployed origin. It deliberately stays red until the approved urgent,
// role-task and shift-status regions are part of the real login/home screen.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json',
  '.jpg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/login.html';
  const file = path.join(root, urlPath);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/login.html';

const mixedTasks = [
  { id:'task-fire', kind:'document', title:'נוהל חדש ממתין לקריאה',
    summary:'נדרש אישור קריאה', target_roles:['firefighter'], priority:'normal',
    action:{ type:'open_document', id:'doc-1' } },
  { id:'task-command', kind:'schedule', title:'טיוטת סידור ממתינה לאישור',
    summary:'סקירה לפני פרסום', target_roles:['commander', 'deputy'], priority:'high',
    action:{ type:'open_schedule_review', id:'draft-1' } },
  { id:'task-hr', kind:'hr_report', title:'דוחות החודש הקודם ממתינים',
    summary:'נדרש עיון משאבי אנוש', target_roles:['hr_coordinator'], priority:'high',
    action:{ type:'open_hr_reports', id:'2026-08' } },
  { id:'task-admin', kind:'maintenance', title:'בדיקת בריאות דורשת סקירה',
    summary:'מנהל מערכת בלבד', target_roles:['super_admin'], priority:'normal',
    // Focused mutation: a free URL must never become navigation authority.
    action:{ type:'open_maintenance', id:'health-1', url:'https://evil.invalid/steal' } }
];

function snapshot() {
  return {
    revision:'home-r7', generated_at:'2026-09-13T05:00:00.000Z',
    identity:{ display_name:'אלדד יונה', role:'firefighter', role_label:'כבאי',
      crew_label:'משמרת ג׳', station_label:'תחנת אילת' },
    urgent:{ id:'fault-urgent', title:'<img src=x onerror=alert(1)> תקלה ממתינה להערכה',
      summary:'רכב מבצעי דורש בדיקה', severity:'critical',
      action:{ type:'open_fault', id:'fault-urgent', url:'https://evil.invalid/urgent' } },
    tasks:mixedTasks,
    shift:{ label:'משמרת ג׳', on_duty:8, open_faults:1, missing:0,
      updated_at:'2026-09-13T04:59:00.000Z' }
  };
}

const browser = await chromium.launch();
let passed = 0;
let failed = 0;
const failures = [];

async function check(name, run) {
  try {
    await run();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    failed += 1;
    failures.push(name + ': ' + (error && error.message ? error.message : String(error)));
    console.error('FAIL ' + name + '\n  ' + (error && error.message ? error.message : String(error)));
  }
}

async function contextFor(role, width = 390) {
  const context = await browser.newContext({
    viewport:{ width, height:844 }, locale:'he-IL', isMobile:true, hasTouch:true
  });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(({ role, data }) => {
    window.__SMOKE_ROLE = role;
    window.__SMOKE_UID = 'home-command-' + role;
    window.__CALLABLE_PLAN = { getHomeCommandCenter:[{ data }] };
  }, { role, data:snapshot() });
  return context;
}

async function openHome(role, width = 390) {
  const context = await contextFor(role, width);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base, { waitUntil:'load' });
  await page.locator('#homeView').waitFor({ state:'visible', timeout:10000 });
  await page.locator('#coNo').click({ timeout:1000 }).catch(() => {});
  await page.addStyleTag({ content:'#coWrap{display:none!important}' });
  await page.locator('#bulletinBoard').waitFor({ state:'visible', timeout:10000 });
  return { context, page, errors };
}

function activeCount(page, suffix) {
  return page.evaluate(suffix => Object.entries(window.__FIRESTORE_ACTIVE_PATHS || {})
    .filter(([key]) => key.endsWith(suffix))
    .reduce((sum, [, value]) => sum + Number(value || 0), 0), suffix);
}

function visibleTaskIds(page) {
  return page.locator('#homeTaskList [data-home-task-id]:visible').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-home-task-id')).sort());
}

try {
  const release = await openHome('firefighter');

  await check('release · the live bulletin and home faults remain single visible regions', async () => {
    assert.equal(await release.page.locator('#bulletinBoard:visible').count(), 1);
    assert.equal(await release.page.locator('#homeFaults:visible').count(), 1);
    assert.equal(await activeCount(release.page, '/bulletin_messages'), 1);
    assert.equal(await activeCount(release.page, '/faults'), 1);
  });

  await check('release · approved urgent, role-task and shift-status regions exist once', async () => {
    assert.equal(await release.page.locator('#homeUrgent').count(), 1, '#homeUrgent missing or duplicated');
    assert.equal(await release.page.locator('#homeTasks').count(), 1, '#homeTasks missing or duplicated');
    assert.equal(await release.page.locator('#homeTaskList').count(), 1, '#homeTaskList missing or duplicated');
    assert.equal(await release.page.locator('#homeShiftStatus').count(), 1, '#homeShiftStatus missing or duplicated');
  });

  await check('mutation · HTML-looking urgent data is text and free URLs have no authority', async () => {
    const urgent = release.page.locator('#homeUrgent');
    await urgent.waitFor({ state:'visible', timeout:3000 });
    assert.equal(await urgent.locator('img,script,iframe,object').count(), 0);
    assert.match(await urgent.textContent(), /<img src=x onerror=alert\(1\)>/);
    assert.equal(await urgent.locator('[href^="http:"],[href^="https:"],form[action]').count(), 0);
    assert.equal(await urgent.locator('[onclick]').count(), 0);
  });

  await check('release · shift status exposes the three approved finite metrics', async () => {
    const shift = release.page.locator('#homeShiftStatus');
    await shift.waitFor({ state:'visible', timeout:3000 });
    for (const [metric, expected] of [['on_duty','8'], ['open_faults','1'], ['missing','0']]) {
      const node = shift.locator('[data-shift-metric="' + metric + '"]');
      assert.equal(await node.count(), 1, 'missing metric ' + metric);
      assert.match((await node.textContent()).trim(), new RegExp('(?:^|\\D)' + expected + '(?:\\D|$)'));
    }
  });

  await check('mutation · same-UID claims refresh cannot duplicate bulletin or fault listeners', async () => {
    await release.page.evaluate(() => window.__SMOKE_EMIT_ID_TOKEN('firefighter', 'home-command-firefighter'));
    await release.page.waitForTimeout(150);
    assert.equal(await activeCount(release.page, '/bulletin_messages'), 1);
    assert.equal(await activeCount(release.page, '/faults'), 1);
  });

  await release.context.close();

  const roleCases = [
    ['firefighter', ['task-fire']],
    ['commander', ['task-command']],
    ['deputy', ['task-command']],
    ['hr', ['task-hr']],
    ['super', ['task-admin', 'task-command', 'task-fire', 'task-hr']]
  ];
  for (const [role, expected] of roleCases) {
    const home = await openHome(role);
    await check('mutation · role filtering prevents cross-role task leakage for ' + role, async () => {
      await home.page.locator('#homeTasks').waitFor({ state:'visible', timeout:3000 });
      assert.deepEqual(await visibleTaskIds(home.page), expected);
      assert.equal(await home.page.locator('#homeTaskList [href^="http:"],#homeTaskList [href^="https:"],#homeTaskList [onclick]').count(), 0);
    });
    await check('release · ' + role + ' home creates one dashboard adapter call', async () => {
      const calls = await home.page.evaluate(() => (window.__CALLABLE_CALLS || [])
        .filter(entry => entry.name === 'getHomeCommandCenter'));
      assert.equal(calls.length, 1);
    });
    assert.deepEqual(home.errors, [], role + ' page errors');
    await home.context.close();
  }

  for (const width of [320, 360, 390]) {
    const home = await openHome('firefighter', width);
    await check('mobile ' + width + ' · approved regions keep order and never overflow', async () => {
      const metrics = await home.page.evaluate(() => {
        const ids = ['homeUrgent', 'homeTasks', 'homeUpdatesTitle', 'homeFaults', 'homeShiftStatus'];
        const tops = ids.map(id => {
          const node = document.getElementById(id);
          return node && node.getBoundingClientRect().top;
        });
        return {
          tops,
          pageFits:document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          panelsFit:Array.from(document.querySelectorAll('#homeView section')).every(node =>
            node.scrollWidth <= node.clientWidth + 1)
        };
      });
      assert.ok(metrics.tops.every(Number.isFinite), 'one or more approved regions are missing');
      assert.deepEqual(metrics.tops, metrics.tops.slice().sort((a, b) => a - b), 'mobile region order changed');
      assert.equal(metrics.pageFits, true, 'document overflows horizontally');
      assert.equal(metrics.panelsFit, true, 'a home panel overflows horizontally');
    });
    if (process.env.HOME_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.HOME_SCREENSHOT_DIR, { recursive:true });
      await home.page.waitForFunction(() => {
        for (let node = document.querySelector('#homeView'); node; node = node.parentElement) {
          if (getComputedStyle(node).opacity !== '1') return false;
        }
        return true;
      });
      await home.page.screenshot({ path:path.join(process.env.HOME_SCREENSHOT_DIR, 'home-' + width + '.png'), fullPage:true });
    }
    await home.context.close();
  }

  if (process.env.HOME_SCREENSHOT_DIR) {
    const desktopHome = await openHome('firefighter', 1280);
    await desktopHome.page.waitForFunction(() => {
      for (let node = document.querySelector('#homeView'); node; node = node.parentElement) {
        if (getComputedStyle(node).opacity !== '1') return false;
      }
      return true;
    });
    await desktopHome.page.screenshot({ path:path.join(process.env.HOME_SCREENSHOT_DIR, 'home-1280.png'), fullPage:true });
    await desktopHome.context.close();
  }

  await check('source · all four safe-area edges are declared for the home shell', async () => {
    const source = fs.readFileSync(path.join(root, 'login.html'), 'utf8') + '\n' +
      fs.readFileSync(path.join(root, 'bulletin.css'), 'utf8') + '\n' +
      fs.readFileSync(path.join(root, 'nav.js'), 'utf8');
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      assert.match(source, new RegExp('safe-area-inset-' + edge), 'missing safe-area ' + edge);
    }
  });
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('\nhome command dashboard: ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
  console.error(failures.map(item => ' - ' + item).join('\n'));
  process.exitCode = 1;
}
