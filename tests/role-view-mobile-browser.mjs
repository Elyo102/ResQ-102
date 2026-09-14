import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json', '.png':'image/png',
  '.jpg':'image/jpeg', '.svg':'image/svg+xml' };
const server = http.createServer((req, res) => {
  let name = decodeURIComponent((req.url || '/').split('?')[0]);
  if (name === '/') name = '/login.html';
  const file = path.join(root, name);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/login.html';

const tasks = [
  { id:'fire', title:'נוהל לכבאי', target_roles:['firefighter'], priority:'normal', action:{ type:'open_document', id:'d' } },
  { id:'command', title:'טיוטה למפקד', target_roles:['commander','deputy'], priority:'high', action:{ type:'open_schedule_review', id:'s' } },
  { id:'hr', title:'דוח למשאבי אנוש', target_roles:['hr_coordinator'], priority:'high', action:{ type:'open_hr_reports', id:'h' } },
  { id:'admin', title:'בריאות מערכת', target_roles:['super_admin'], priority:'normal', action:{ type:'open_maintenance', id:'m' } }
];
const snapshot = { tasks, shift:{ label:'משמרת ג׳', on_duty:8, open_faults:1, missing:0 } };

async function open(role, width = 390, uid = 'owner') {
  const context = await browser.newContext({ viewport:{ width, height:844 }, locale:'he-IL', isMobile:true, hasTouch:true });
  await context.route('**/firebasejs/**', route => {
    const file = path.join(stub, route.request().url().split('/').pop().split('?')[0]);
    route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript(({ role, uid, snapshot }) => {
    window.__SMOKE_ROLE = role; window.__SMOKE_UID = uid;
    window.__SMOKE_EXTRA_CLAIMS = { auth_time:100 };
    window.__CALLABLE_PLAN = { getHomeCommandCenter:Array.from({ length:12 }, () => ({ data:snapshot })) };
  }, { role, uid, snapshot });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil:'load' });
  await page.locator('#homeView').waitFor({ state:'visible', timeout:10000 });
  return { context, page, errors };
}

async function taskIds(page) {
  return page.locator('#homeTaskList [data-home-task-id]:visible').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-home-task-id')).sort());
}
let passed = 0;
async function check(name, body) { await body(); passed += 1; console.log('PASS ' + name); }
const browser = await chromium.launch();
try {
  const home = await open('super');
  await check('super sees the five approved display choices', async () => {
    assert.equal(await home.page.locator('#roleViewControl:visible').count(), 1);
    assert.deepEqual(await home.page.locator('#roleViewSelect option').evaluateAll(nodes => nodes.map(node => node.value)),
      ['actual','firefighter','deputy','commander','hr_coordinator']);
  });
  await check('commander preview is labelled, filters tasks, and blocks bulletin composition', async () => {
    await home.page.selectOption('#roleViewSelect', 'commander');
    await home.page.waitForFunction(() => document.querySelectorAll('#homeTaskList [data-home-task-id]').length === 1);
    assert.deepEqual(await taskIds(home.page), ['command']);
    assert.equal(await home.page.locator('[data-home-task-id="command"]').getAttribute('href'), null);
    assert.match(await home.page.locator('#roleViewBanner').textContent(), /תצוגה בלבד/);
    assert.equal(await home.page.locator('#bulletinCompose:visible').count(), 0);
    const stored = JSON.parse(await home.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')));
    assert.equal(stored.owner_uid, 'owner');
    assert.equal(stored.auth_time, 100);
    assert.equal(stored.selected, 'commander');
  });
  await check('commander preview blocks programmatic bulletin writes and super mobile links', async () => {
    await home.page.evaluate(() => {
      document.getElementById('bulletinCompose').click();
      const form = document.getElementById('bulletinForm');
      document.getElementById('bulletinText').value = 'אסור לפרסם';
      form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    });
    assert.equal(await home.page.locator('#bulletinForm:visible').count(), 0);
    const writeCalls = await home.page.evaluate(() => (window.__CALLABLE_CALLS || [])
      .filter(row => /Bulletin/.test(row.name) && row.name !== 'getHomeCommandCenter'));
    assert.deepEqual(writeCalls, []);
    await home.page.locator('#resqDock button', { hasText:'עוד' }).evaluate(node => node.click());
    const hrefs = await home.page.locator('#resqDockSheet a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    const forbidden = ['maintenance.html','import.html','check.html','hr.html','attendance-shadow.html'];
    assert.equal(hrefs.some(href => forbidden.some(name => String(href || '').endsWith(name))), false, JSON.stringify(hrefs));
    assert.equal(await home.page.locator('#resqDockSheet a').evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-disabled') === 'true')), true);
  });
  await check('same authenticated owner restores preview after reload', async () => {
    await home.page.reload({ waitUntil:'load' });
    await home.page.locator('#homeView').waitFor({ state:'visible', timeout:10000 });
    assert.equal(await home.page.locator('#roleViewSelect').inputValue(), 'commander');
    assert.deepEqual(await taskIds(home.page), ['command']);
  });
  await check('preview never enters callable payloads or auth operations', async () => {
    const state = await home.page.evaluate(() => ({
      calls:(window.__CALLABLE_CALLS || []).filter(row => row.name === 'getHomeCommandCenter'),
      auth:window.__AUTH_CALLS || []
    }));
    assert.ok(state.calls.length >= 1);
    state.calls.forEach(row => assert.deepEqual(row.payload, {}));
    assert.equal(state.auth.some(row => row.name === 'signOut'), false);
  });
  await check('actual restores all super tasks and write control', async () => {
    await home.page.selectOption('#roleViewSelect', 'actual');
    await home.page.waitForFunction(() => document.querySelectorAll('#homeTaskList [data-home-task-id]').length === 4);
    assert.deepEqual(await taskIds(home.page), ['admin','command','fire','hr']);
    assert.equal(await home.page.locator('#roleViewBanner:visible').count(), 0);
    assert.equal(await home.page.locator('#bulletinCompose:visible').count(), 1);
    assert.equal(await home.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  await check('loss of exact super clears preview immediately', async () => {
    await home.page.selectOption('#roleViewSelect', 'hr_coordinator');
    await home.page.evaluate(() => window.__SMOKE_EMIT_ID_TOKEN('firefighter', 'owner', { auth_time:100, super:false }));
    await home.page.waitForFunction(() => document.getElementById('roleViewControl').classList.contains('hide'));
    assert.equal(await home.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  await check('session expiry clears stored preview without a logout click', async () => {
    await home.page.evaluate(() => {
      sessionStorage.setItem('resq_role_view_v1', JSON.stringify({ owner_uid:'owner', auth_time:100, claims_epoch:'x', selected:'commander' }));
      window.__SMOKE_EMIT_AUTH(null);
    });
    await home.page.locator('#authView').waitFor({ state:'visible' });
    assert.equal(await home.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  assert.deepEqual(home.errors, []);
  await home.context.close();

  const ordinary = await open('firefighter');
  await check('ordinary users never receive the selector', async () => {
    assert.equal(await ordinary.page.locator('#roleViewControl:visible').count(), 0);
    assert.equal(await ordinary.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  await ordinary.context.close();

  const replacement = await open('super', 390, 'first-owner');
  await replacement.page.selectOption('#roleViewSelect', 'hr_coordinator');
  await check('non-default UID is stored and restored for that exact owner', async () => {
    let stored = JSON.parse(await replacement.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')));
    assert.equal(stored.owner_uid, 'first-owner');
    assert.equal(stored.selected, 'hr_coordinator');
    await replacement.page.reload({ waitUntil:'load' });
    await replacement.page.locator('#homeView').waitFor({ state:'visible', timeout:10000 });
    assert.equal(await replacement.page.locator('#roleViewSelect').inputValue(), 'hr_coordinator');
  });
  await check('UID replacement cannot inherit the previous owner preview', async () => {
    await replacement.page.evaluate(() => window.__SMOKE_EMIT_ID_TOKEN('super', 'second-owner', { auth_time:100 }));
    await replacement.page.waitForFunction(() => document.getElementById('roleViewSelect').value === 'actual');
    assert.equal(await replacement.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  await replacement.page.selectOption('#roleViewSelect', 'commander');
  await check('token refresh changing only auth time invalidates preview', async () => {
    await replacement.page.evaluate(() => window.__SMOKE_EMIT_ID_TOKEN('super', 'second-owner', { auth_time:101 }));
    await replacement.page.waitForFunction(() => document.getElementById('roleViewSelect').value === 'actual');
    assert.equal(await replacement.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  await replacement.page.selectOption('#roleViewSelect', 'commander');
  await check('token refresh changing only an authority claim invalidates preview', async () => {
    await replacement.page.evaluate(() => window.__SMOKE_EMIT_ID_TOKEN('super', 'second-owner', { auth_time:101, permissions:{ schedule:true } }));
    await replacement.page.waitForFunction(() => document.getElementById('roleViewSelect').value === 'actual');
    assert.equal(await replacement.page.evaluate(() => sessionStorage.getItem('resq_role_view_v1')), null);
  });
  await replacement.context.close();

  for (const width of [320, 360, 390]) {
    const mobile = await open('super', width);
    await check('mobile ' + width + ' selector fits and keeps a touch target', async () => {
      const metrics = await mobile.page.locator('#roleViewSelect').evaluate(node => ({
        height:node.getBoundingClientRect().height,
        fits:document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
      }));
      assert.ok(metrics.height >= 44); assert.equal(metrics.fits, true);
    });
    await mobile.context.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
console.log('role view mobile browser: ' + passed + '/16 PASS');
