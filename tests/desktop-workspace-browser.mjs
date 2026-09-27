// Actual shared navigation + real home markup/CSS, synthetic data only.
// Compare mobile pixels against the approved pre-change commit; block all cloud traffic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = '679a7bb41995aa7b493e5b65cf3848947616c318';
const before = new Map(['nav.js', 'bulletin.css', 'login.html'].map(file =>
  [file, execFileSync('git', ['show', `${baseline}:${file}`], { cwd:root, encoding:'utf8' })]));
const out = path.resolve(root, '../../outputs/resq-desktop-redesign-2026-09-27');
fs.mkdirSync(out, { recursive:true });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const isBefore = url.pathname.startsWith('/before/');
  const name = decodeURIComponent(url.pathname.replace(/^\/(before|after)\//, ''));
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  let body = isBefore && before.has(name) ? before.get(name) : fs.readFileSync(file, 'utf8');
  if (name === 'mode-controller.js') body = 'export function startModeController(){}';
  if (name.endsWith('.html')) body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' :
    name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
let checks = 0;
const errors = [];
async function open(width, version='after', role='super', height=1000) {
  const context = await browser.newContext({ viewport:{ width, height }, locale:'he-IL',
    serviceWorkers:'block', reducedMotion:'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/${version}/login.html`);
  await page.evaluate(async ({ role, version }) => {
    const nav = await import(`/${version}/nav.js`);
    window.auditNav = nav;
    const claims = role === 'super' ? { role:'firefighter', super:true } : { role };
    nav.renderNav(claims, 'login.html', 'משתמש הדגמה · תחנת הדגמה');
    document.body.classList.remove('art');
    document.body.classList.add('bulletin-mode', 'with-nav');
    for (const id of ['bootView','authView','waitView','pwView']) document.getElementById(id).classList.add('hide');
    nav.applyTheme('light');
    document.querySelector('#homeView').classList.remove('hide');
    if (version === 'after') {
      const layout = await import('/after/home-command.js');
      window.auditLayout = layout;
      layout.initAccountDisclosure(document.querySelector('#accountDetails'));
    }
    document.querySelector('#pageTitle').textContent = 'שלום, משתמש הדגמה';
    document.querySelector('body > .card > .sub').textContent = 'תחנת הדגמה · משמרת ג׳ · נתונים להמחשה בלבד';
    document.querySelector('#homeCommandTitle').textContent = 'תמונת מצב מערכת';
    document.querySelector('#homeTasks').setAttribute('aria-busy', 'false');
    document.querySelector('#homeTaskEmpty').classList.remove('hide');
    document.querySelector('#bulletinEmpty').classList.remove('hide');
    const list = document.querySelector('#homeFaultList');
    for (const text of ['רכב הדגמה · בדיקת ציוד', 'רכב הדגמה · פנס דורש בדיקה', 'תחנת הדגמה · טיפול במזגן']) {
      const link = document.createElement('a');
      link.className = 'home-fault-card'; link.href = './faults.html';
      const title = document.createElement('strong'); title.className = 'home-fault-title'; title.textContent = text;
      const meta = document.createElement('span'); meta.className = 'home-fault-meta'; meta.textContent = 'נתון להמחשה בלבד · ממתין לבדיקה';
      link.append(title, meta); list.append(link);
    }
  }, { role, version });
  await page.evaluate(() => document.fonts.ready);
  return { page, context };
}
async function box(page, selector) {
  return page.locator(selector).evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x:r.x, y:r.y, width:r.width, right:r.right, bottom:r.bottom };
  });
}
try {
  for (const width of [320,360,390,768,1023]) {
    const old = await open(width, 'before'); const current = await open(width);
    assert.deepEqual(await current.page.screenshot({ animations:'disabled' }),
      await old.page.screenshot({ animations:'disabled' }), `mobile/tablet pixels changed at ${width}`);
    checks++; await old.context.close(); await current.context.close();
  }
  for (const width of [1024,1280,1440,1920]) {
    const { page, context } = await open(width);
    const sidebar = await box(page, '#navLinks'); const content = await box(page, 'body > .card');
    assert.equal(sidebar.x, 0); assert.equal(sidebar.width, 216);
    assert(content.x >= sidebar.right + 20); assert(content.right <= width);
    assert(content.width >= width - 280);
    assert.equal(await page.locator('#accountDetails').evaluate(el => el.open), true);
    assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundImage), /linear-gradient/);
    await page.locator('#accountDetails > summary').click();
    await page.evaluate(() => window.auditLayout.initAccountDisclosure(document.querySelector('#accountDetails')));
    assert.equal(await page.locator('#accountDetails').evaluate(el => el.open), false);
    await page.locator('#accountDetails > summary').click();
    await page.waitForFunction(() => document.querySelector('#accountDetails').open);
    await page.evaluate(() => scrollTo(0,0));
    const tasks = await box(page, '#homeTasks'); const faults = await box(page, '#homeFaults');
    const updates = await box(page, '.home-updates');
    assert(faults.x < tasks.x); assert(faults.width > tasks.width);
    assert(Math.abs(tasks.y - faults.y) < 2); assert(updates.y > faults.y);
    assert.equal(await page.locator('#homeUrgent').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('#door-station').click();
    assert(await page.locator('#panel-station').isVisible());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#panel-station').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'door-station');
    if (width === 1440) {
      await page.screenshot({ path:path.join(out, 'desktop-light.png'), fullPage:true });
      await page.evaluate(() => window.auditNav.applyTheme('dark'));
      await page.screenshot({ path:path.join(out, 'desktop-dark.png'), fullPage:true });
    }
    await page.evaluate(() => document.querySelector('#homeUrgent').classList.remove('hide'));
    const urgent = await box(page, '#homeUrgent');
    assert(urgent.width >= content.width - 2 && urgent.x >= sidebar.right);
    assert(urgent.y < (await box(page, '#homeFaults')).y);
    checks++; await context.close();
  }
  for (const [route, selector] of [['faults.html','.wrap'], ['hr.html','.hr-workspace'],
    ['schedule-management.html','.shell'], ['operational-vehicles.html','main']]) {
    const { page, context } = await open(1280);
    await page.goto(`${origin}/after/${route}`);
    await page.evaluate(async selector => {
      const nav = await import('/after/nav.js');
      nav.renderNav({ super:true }, location.pathname.split('/').pop(), 'הדגמה');
      document.querySelector(selector).classList.remove('hide');
    }, selector);
    const workspace = await box(page, selector);
    assert(workspace.x >= 216, `${route} overlaps sidebar`);
    assert(workspace.right <= 1280, `${route} overflows content`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, route);
    checks++; await context.close();
  }
  const { page, context } = await open(1440, 'after', 'super', 560);
  for (const role of ['firefighter','commander','hr_coordinator']) {
    await page.evaluate(role => window.auditNav.renderNav({ role }, 'login.html', 'הדגמה'), role);
    const links = await page.locator('#navLinks a').evaluateAll(items => items.map(a => a.getAttribute('href')));
    assert.equal(links.includes('./admin.html'), false);
    assert.equal(links.includes('./hr.html'), role === 'hr_coordinator');
    assert.equal(links.includes('./callout.html'), role === 'commander');
    checks++;
  }
  await page.evaluate(() => window.auditNav.renderNav({ super:true }, 'login.html', 'הדגמה'));
  await page.locator('#door-admin').click();
  await page.locator('#themeBtn').focus();
  const theme = await box(page, '#themeBtn'); assert(theme.y >= 0 && theme.bottom <= 560);
  await page.evaluate(() => window.auditNav.renderNav({ super:true, role:'firefighter' },
    'attendance.html', 'תצוגה בלבד', { kind:'role_view', role_id:'firefighter', label:'כבאי' }));
  assert.equal(await page.locator('#appNav .bell').getAttribute('aria-disabled'), 'true');
  assert.equal(await page.locator('#appNav .bell').getAttribute('href'), null);
  assert.equal(await page.locator('#navLinks a[aria-disabled="true"][href]').count(), 0);
  await page.setViewportSize({ width:1023, height:900 });
  await page.waitForFunction(() => !document.querySelector('#accountDetails').open);
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
  assert.notEqual(await page.locator('#navLinks').evaluate(el => getComputedStyle(el).position), 'fixed');
  await page.setViewportSize({ width:1024, height:900 });
  await page.waitForFunction(() => document.querySelector('#accountDetails').open);
  await page.locator('#accountDetails > summary').click();
  await page.setViewportSize({ width:1023, height:900 });
  await page.waitForTimeout(50);
  await page.setViewportSize({ width:1024, height:900 });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#accountDetails').evaluate(el => el.open), false);
  await page.evaluate(() => window.auditLayout.destroyAccountDisclosure());
  await page.evaluate(() => window.auditLayout.initAccountDisclosure(document.querySelector('#accountDetails')));
  assert.equal(await page.locator('#accountDetails').evaluate(el => el.open), true);
  assert.equal(await page.locator('#navLinks').evaluate(el => getComputedStyle(el).position), 'fixed');
  await page.evaluate(() => window.auditNav.clearNav());
  assert.equal(await page.locator('#navLinks').count(), 0);
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
  assert(Number.parseFloat(await page.locator('body').evaluate(el => getComputedStyle(el).paddingLeft)) < 100);
  checks++; await context.close();
  const faults = fs.readFileSync(path.join(root, 'faults.html'), 'utf8');
  assert(faults.includes('<label>צילומים (לא חובה)</label>'));
  assert(!faults.includes('צילומים (לא חובה, עד שלוש)')); checks++;
  assert.deepEqual(errors, []);
  console.log(`desktop-workspace-browser: ${checks} scenario groups PASS; mobile pixels unchanged; no cloud access`);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
