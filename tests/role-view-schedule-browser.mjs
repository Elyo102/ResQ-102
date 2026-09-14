import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveRoleView } from '../role-view.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml' };
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const relative = pathname === '/' ? 'schedule-management.html' : pathname.replace(/^\/+/, '');
  const file = path.join(root, relative);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
const claims = {
  email:'eldad50@gmail.com', email_verified:true, role:'firefighter', super:true,
  emp:'1', stationId:'eilat_102', districtId:'south', shift:'C', auth_time:100
};
const status = { mode:'new', configured:true, manager:true,
  active:{ publication_id:'p_live', revision:4, can_rollback:false } };
const setup = { mode:'new', configured:true,
  policy:{ id:'policy_1', active_policy_id:'policy_1', version:'v1', digest:'abc',
    rest:{ min_gap_days:2 }, rotation:null, max_shifts_per_month:12,
    sub_stations:[{ id:'main', label:'Eilat', minimum:2, requirements:[] }] },
  source:{ id:'source_1', version:'1', revision:'7' },
  people:[{ id:'stub-uid', name:'Eldad', sub_station:'main', roles:['firefighter'] }] };
const month = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Jerusalem', year:'numeric', month:'2-digit' }).format(new Date());
const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const range = { mode:'new', active:true, source:'v2', publication_id:'p_live', revision:4,
  from:month + '-01', to:month + '-' + String(lastDay).padStart(2, '0'),
  days:Array.from({ length:lastDay }, (_, index) => ({
    date:month + '-' + String(index + 1).padStart(2, '0'),
    sub_stations:[], events:[], guards_status:'ready', guards:[]
  })) };
const mutationNames = new Set([
  'setScheduleRuntimeMode','promoteScheduleToNew','saveScheduleSource','saveSchedulePolicy',
  'runSchedulePlanner','importScheduleSheet','setScheduleDisplay','applyScheduleEdit',
  'saveQualification','deleteQualification','setPersonQualifications','saveScheduleGapPolicy',
  'publishSchedule','rollbackSchedule','respondToSchedule'
]);
function plan() {
  return {
    getScheduleRuntimeStatus:Array.from({ length:8 }, () => ({ data:status })),
    getScheduleManagerSetup:Array.from({ length:8 }, () => ({ data:setup })),
    getScheduleModeOptions:Array.from({ length:8 }, () => ({ data:{ mode:'new', may_change:true, allowed:[] } })),
    getScheduleDisplayStatus:Array.from({ length:8 }, () => ({ data:{ month, enabled:false } })),
    getStationScheduleRange:Array.from({ length:8 }, () => ({ data:range }))
  };
}
function previewRecord(selected) {
  return resolveRoleView({ uid:'stub-uid', claims, requested:selected }).storageRecord;
}
async function openSchedule(browser, options = {}) {
  const selected = options.selected || null;
  const width = options.width || 390;
  const query = options.query || '?tab=manage';
  const context = await browser.newContext({ viewport:{ width, height:844 }, locale:'he-IL', isMobile:true, hasTouch:true });
  await context.route('**/firebasejs/**', route => {
    const file = path.join(stub, route.request().url().split('/').pop().split('?')[0]);
    route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(({ record, callablePlan, watchPaint }) => {
    window.__SMOKE_ROLE = 'super';
    window.__SMOKE_UID = 'stub-uid';
    window.__SMOKE_EXTRA_CLAIMS = { auth_time:100 };
    window.__CALLABLE_PLAN = callablePlan;
    if (record) sessionStorage.setItem('resq_role_view_v1', JSON.stringify(record));
    if (watchPaint) {
      window.__ROLE_VIEW_PAINTS = [];
      const inspect = () => {
        const banner = document.getElementById('scheduleRoleViewBanner');
        if (banner && !banner.hidden) window.__ROLE_VIEW_PAINTS.push(banner.textContent || 'preview');
      };
      new MutationObserver(inspect).observe(document, { subtree:true, childList:true, attributes:true });
    }
  }, { record:selected ? previewRecord(selected) : null, callablePlan:plan(), watchPaint:options.watchPaint === true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto(base + query, { waitUntil:'load' });
  await page.locator('#appMain').waitFor({ state:'visible', timeout:10000 });
  return { context, page, errors };
}
async function mutatingCalls(page) {
  return page.evaluate(names => (window.__CALLABLE_CALLS || []).filter(row => names.includes(row.name)), [...mutationNames]);
}
async function forceScheduleControls(page) {
  await page.evaluate(() => {
    const roots = [document.getElementById('manageView'), document.getElementById('qualsView')].filter(Boolean);
    roots.forEach(root => {
      root.inert = false;
      root.hidden = false;
      root.querySelectorAll('button').forEach(button => {
        button.disabled = false;
        button.hidden = false;
        button.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
      });
      root.querySelectorAll('form').forEach(form =>
        form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true })));
      root.querySelectorAll('input,select,textarea').forEach(field =>
        field.dispatchEvent(new Event('change', { bubbles:true, cancelable:true })));
    });
  });
  await page.waitForTimeout(100);
}
let passed = 0;
async function check(name, body) {
  await body();
  passed += 1;
  console.log('PASS ' + name);
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/schedule-management.html';
const browser = await chromium.launch();
try {
  for (const selected of ['commander','deputy']) {
    const view = await openSchedule(browser, { selected });
    await check(selected + ' preview restores management view and persistent banner', async () => {
      assert.equal(await view.page.locator('#manageView').isVisible(), true);
      assert.equal(await view.page.locator('#scheduleRoleViewBanner').isVisible(), true);
      assert.match(await view.page.locator('#scheduleRoleViewBanner').textContent(), /קריאה בלבד/);
      assert.equal(new URL(view.page.url()).searchParams.get('tab'), 'manage');
    });
    await check(selected + ' preview navigation is restricted to preview-safe destinations', async () => {
      const links = await view.page.locator('#appNav a').evaluateAll(nodes => nodes.map(node => ({
        href:node.getAttribute('href'), disabled:node.getAttribute('aria-disabled')
      })));
      assert.equal(links.some(item => item.disabled === 'true' && item.href === null), true, JSON.stringify(links));
      const enabled = links.filter(item => item.disabled !== 'true');
      assert.ok(enabled.length > 0);
      assert.equal(enabled.every(item => /(?:login|schedule-management)\.html/.test(String(item.href))), true, JSON.stringify(links));
    });
    await check(selected + ' preview blocks forced writes before and after token refresh', async () => {
      const factories = await view.page.evaluate(() => window.__CALLABLE_FACTORIES || []);
      assert.deepEqual([...mutationNames].filter(name => !factories.includes(name)), []);
      await forceScheduleControls(view.page);
      assert.deepEqual(await mutatingCalls(view.page), []);
      await view.page.evaluate(() => window.__SMOKE_EMIT_ID_TOKEN('super', 'stub-uid', { auth_time:100 }));
      await view.page.waitForFunction(() => document.getElementById('appMain') && !document.getElementById('appMain').classList.contains('hide'));
      assert.equal(await view.page.locator('#scheduleRoleViewBanner').isVisible(), true);
      await forceScheduleControls(view.page);
      assert.deepEqual(await mutatingCalls(view.page), []);
    });
    assert.deepEqual(view.errors, []);
    await view.context.close();
  }
  const firefighter = await openSchedule(browser, { selected:'firefighter' });
  await check('firefighter preview clamps a manage deep link to station view', async () => {
    assert.equal(await firefighter.page.locator('#manageTab').isVisible(), false);
    assert.equal(await firefighter.page.locator('#stationView').isVisible(), true);
    assert.equal(new URL(firefighter.page.url()).searchParams.get('tab'), 'station');
    assert.match(await firefighter.page.locator('#scheduleRoleViewBanner').textContent(), /כבאי/);
    await forceScheduleControls(firefighter.page);
    assert.deepEqual(await mutatingCalls(firefighter.page), []);
  });
  assert.deepEqual(firefighter.errors, []);
  await firefighter.context.close();

  const actual = await openSchedule(browser);
  await check('actual super mode remains writable in presentation and keeps normal navigation', async () => {
    assert.equal(await actual.page.locator('#scheduleRoleViewBanner').isVisible(), false);
    assert.equal(await actual.page.locator('#manageView').isVisible(), true);
    assert.equal(await actual.page.locator('#manageView').getAttribute('inert'), null);
    const enabledNav = await actual.page.locator('#appNav a').evaluateAll(nodes =>
      nodes.filter(node => node.getAttribute('href')).some(node => node.getAttribute('aria-disabled') !== 'true'));
    assert.equal(enabledNav, true);
    assert.equal(await actual.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  await check('actual super blocks writes synchronously while refreshed claims are unresolved', async () => {
    await actual.page.evaluate(() => {
      window.__SMOKE_DEFER_CLAIMS = true;
      window.__SMOKE_EMIT_ID_TOKEN('super', 'stub-uid', { auth_time:100 });
    });
    await actual.page.waitForFunction(() => (window.__SMOKE_CLAIMS_PENDING || []).length === 1);
    await forceScheduleControls(actual.page);
    assert.deepEqual(await mutatingCalls(actual.page), []);
    await actual.page.evaluate(() => {
      window.__SMOKE_DEFER_CLAIMS = false;
      window.__SMOKE_RELEASE_CLAIMS();
    });
    await actual.page.waitForFunction(() => {
      const main = document.getElementById('appMain');
      const manage = document.getElementById('manageView');
      return main && !main.classList.contains('hide') && manage && !manage.hidden;
    });
    assert.equal(await actual.page.locator('#scheduleRoleViewBanner').isVisible(), false);
    assert.equal(await actual.page.locator('#manageView').getAttribute('inert'), null);
  });
  assert.deepEqual(actual.errors, []);
  await actual.context.close();

  const notification = await openSchedule(browser, {
    selected:'commander', query:'?tab=manage&resq_actual=notification', watchPaint:true
  });
  await check('notification navigation clears preview storage and marker before render', async () => {
    assert.equal(await notification.page.locator('#scheduleRoleViewBanner').isVisible(), false);
    assert.equal(await notification.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
    assert.equal(new URL(notification.page.url()).searchParams.has('resq_actual'), false);
    assert.deepEqual(await notification.page.evaluate(() => window.__ROLE_VIEW_PAINTS || []), []);
    assert.equal(await notification.page.locator('#manageView').isVisible(), true);
  });
  assert.deepEqual(notification.errors, []);
  await notification.context.close();

  for (const width of [320, 360, 390]) {
    const mobile = await openSchedule(browser, { selected:'commander', width });
    await check('schedule preview has no horizontal overflow at ' + width + 'px', async () => {
      const dimensions = await mobile.page.evaluate(() => ({
        scroll:document.documentElement.scrollWidth, client:document.documentElement.clientWidth
      }));
      assert.ok(dimensions.scroll <= dimensions.client + 1, JSON.stringify(dimensions));
    });
    assert.deepEqual(mobile.errors, []);
    await mobile.context.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
assert.equal(passed, 13);
console.log('role view schedule browser: ' + passed + '/13 PASS');
