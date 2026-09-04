// Real client modules and DOM; Firebase is stubbed and every browser request
// is intercepted. No production, emulator, or external network is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const contract = createRequire(import.meta.url)('../functions/ops-telemetry-contract.js');
const origin = 'http://127.0.0.1:41999';
const ok = { id: 'f_' + 'a'.repeat(40), duplicate: false };
const duplicate = { id: ok.id, duplicate: true };
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json' };
const browser = await chromium.launch();
let passed = 0;

async function fixture(plan = [], role = 'firefighter', width = 390) {
  const context = await browser.newContext({
    viewport: { width, height: 844 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem',
    serviceWorkers: 'block'
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/firebasejs/')) {
      if (url.pathname.endsWith('/firebase-app-check.js')) return route.fulfill({ status: 200,
        contentType: 'text/javascript', body: 'export class ReCaptchaEnterpriseProvider {} export function initializeAppCheck(){ return {}; }' });
      const file = path.join(stub, path.basename(url.pathname));
      return route.fulfill({ status: 200, contentType: 'text/javascript',
        body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
    }
    if (url.origin !== origin) return route.abort('blockedbyclient');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream',
      body: fs.readFileSync(file) });
  });
  await context.addInitScript(({ role, plan }) => {
    window.__SMOKE_ROLE = role;
    window.__CALLABLE_PLAN = { submitFeedback: plan, reportIncident: [{ data: { accepted: true } }] };
  }, { role, plan });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/feedback.html?from=swaps.html', { waitUntil: 'load' });
  await page.locator(role === 'pending' || role === 'district' ? '#denyCard' : '#work')
    .waitFor({ state: 'visible' });
  return { context, page, errors };
}

async function draft(page, text = 'בדיקת משוב ללא מידע אמיתי') {
  await page.locator('.chip[data-id="problem"]').click();
  await page.locator('#text').fill(text);
}
async function calls(page, name = 'submitFeedback') {
  return page.evaluate(name => (window.__CALLABLE_CALLS || []).filter(call => call.name === name), name);
}
async function submitted(page, count, success = false) {
  await page.waitForFunction(({ count, success }) =>
    (window.__CALLABLE_CALLS || []).filter(call => call.name === 'submitFeedback').length === count
    && document.querySelector('#msg').classList.contains(success ? 'ok' : 'err'), { count, success });
}
async function test(name, fn) {
  await fn(); passed += 1; console.log('✓ ' + name);
}

try {
  await test('mobile member submits exact consent payload, clears only valid success, no overflow', async () => {
    const f = await fixture([{ data: ok }]);
    try {
      await draft(f.page);
      await f.page.locator('#contact').uncheck();
      await f.page.locator('#send').click();
      await submitted(f.page, 1, true);
      const [call] = await calls(f.page);
      assert.match(call.payload.request_id, /^fb_[a-f0-9]{40}$/);
      assert.equal(call.payload.allow_contact, false);
      assert.equal(call.payload.screen, 'swaps.html');
      assert.equal(call.payload.version, '42H.0');
      assert.equal(await f.page.locator('#text').inputValue(), '');
      assert.equal(await f.page.locator('#send').isDisabled(), true);
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await test('lost response and midnight retry resend byte-identical payload', async () => {
    const f = await fixture([{ reject: true }, { data: duplicate }]);
    try {
      await draft(f.page);
      await f.page.locator('#send').click();
      await submitted(f.page, 1);
      assert.notEqual(await f.page.locator('#text').inputValue(), '');
      await f.page.evaluate(() => {
        const OriginalDate = Date;
        globalThis.Date = class extends OriginalDate {
          constructor(...args) { super(...(args.length ? args : ['2030-01-01T00:01:00Z'])); }
          static now() { return OriginalDate.parse('2030-01-01T00:01:00Z'); }
        };
      });
      await f.page.locator('#send').click();
      await submitted(f.page, 2, true);
      const entries = await calls(f.page);
      assert.deepEqual(entries[0].payload, entries[1].payload);
      assert.match(await f.page.locator('#msg').textContent(), /כבר התקבלה/);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await test('malformed success preserves form and request; consent changes are a distinct intent', async () => {
    const f = await fixture([{ data: {} }, { data: { id: ok.id } }, { data: duplicate }]);
    try {
      await draft(f.page);
      await f.page.locator('#send').click(); await submitted(f.page, 1);
      assert.match(await f.page.locator('#msg').textContent(), /לא התקבל אישור שמירה תקין/);
      const text = await f.page.locator('#text').inputValue();
      await f.page.locator('#contact').uncheck();
      await f.page.locator('#send').click(); await submitted(f.page, 2);
      assert.equal(await f.page.locator('#text').inputValue(), text);
      await f.page.locator('#contact').check();
      await f.page.locator('#send').click(); await submitted(f.page, 3, true);
      const entries = await calls(f.page);
      assert.notEqual(entries[0].payload.request_id, entries[1].payload.request_id);
      assert.equal(entries[1].payload.allow_contact, false);
      assert.deepEqual(entries[0].payload, entries[2].payload);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await test('in-flight double-submit is ignored and a new successful submission gets a fresh id', async () => {
    const f = await fixture([{ delay: 150, data: ok }, { data: ok }]);
    try {
      await draft(f.page);
      await f.page.evaluate(() => {
        const form = document.querySelector('#work');
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await submitted(f.page, 1, true);
      await draft(f.page);
      await f.page.locator('#send').click(); await submitted(f.page, 2, true);
      const entries = await calls(f.page);
      assert.notEqual(entries[0].payload.request_id, entries[1].payload.request_id);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  for (const role of ['pending', 'district']) {
    await test(role + ' cannot submit by unhiding the form or using a fixed admin email', async () => {
      const f = await fixture([], role);
      try {
        await f.page.evaluate(() => window.__SMOKE_EMIT_AUTH('pending', 'blocked-user',
          { email: 'fire102.shits@gmail.com', super: false, stationId: 'eilat_102' }));
        await f.page.locator('#denyCard').waitFor({ state: 'visible' });
        await f.page.evaluate(() => {
          document.querySelector('#work').classList.remove('hide');
          document.querySelector('#text').value = 'בדיקת ניסיון לא מורשה';
          document.querySelector('#work').dispatchEvent(new Event('submit', { cancelable: true }));
        });
        assert.equal((await calls(f.page)).length, 0);
        assert.equal(await f.page.locator('#send').isDisabled(), true);
      } finally { await f.context.close(); }
    });
  }

  await test('live server membership denial preserves draft and never shows untrusted error HTML', async () => {
    const f = await fixture([{ reject: true, code: 'functions/permission-denied',
      message: '<img src=x onerror="window.__OPS_XSS=true">secret name' }]);
    try {
      await draft(f.page, '<img src=x onerror="window.__OPS_XSS=true"> טקסט משתמש');
      await f.page.locator('#send').click(); await submitted(f.page, 1);
      assert.match(await f.page.locator('#msg').textContent(), /אין הרשאה/);
      assert.equal(await f.page.locator('#msg img').count(), 0);
      assert.equal(await f.page.evaluate(() => window.__OPS_XSS === true), false);
      assert.match(await f.page.locator('#text').inputValue(), /טקסט משתמש/);
      const reports = await calls(f.page, 'reportIncident');
      assert.equal(reports.length, 1);
      assert.deepEqual(Object.keys(reports[0].payload).sort(), contract.INPUT_FIELDS.slice().sort());
      assert.doesNotMatch(JSON.stringify(reports), /secret name|<img|message|frame|stack/);
    } finally { await f.context.close(); }
  });

  await test('identity changes discard old identity draft and ignore its late successful response', async () => {
    const f = await fixture([{ delay: 200, data: ok }, { data: ok }]);
    try {
      await draft(f.page, 'טיוטת משתמש קודם');
      await f.page.locator('#send').click();
      await f.page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(c => c.name === 'submitFeedback'));
      await f.page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'next-user'));
      await f.page.waitForFunction(() => document.querySelector('#text').value === '');
      await draft(f.page, 'טיוטת משתמש חדש');
      await f.page.waitForFunction(() => window.__CALLABLE_INFLIGHT === 0);
      assert.equal(await f.page.locator('#text').inputValue(), 'טיוטת משתמש חדש');
      assert.equal(await f.page.locator('#msg').textContent(), '');
      await f.page.locator('#send').click(); await submitted(f.page, 2, true);
    } finally { await f.context.close(); }
  });

  await test('browser finite vocabulary matches server and never reads raw error getters', async () => {
    const f = await fixture();
    try {
      const result = await f.page.evaluate(async () => {
        const m = await import('./incident-client.js?v=42h0');
        const err = { code: 'secret-user-id', name: 'TypeError' };
        for (const field of ['message', 'stack', 'frame']) Object.defineProperty(err, field,
          { get() { throw new Error('private field was read'); } });
        return {
          report: m.buildReport('manual', err, { href: 'https://host/feedback.html?secret=1',
            version: '42G.0', callable: 'submitFeedback', frame: 'private' }),
          unknown: m.buildReport('manual', { code: 'secret' }, { href: '/person-name.html',
            version: 'secret', callable: 'private-callable' }),
          kinds: m.TELEMETRY_KINDS, screens: m.TELEMETRY_SCREENS, versions: m.TELEMETRY_VERSIONS,
          codes: m.TELEMETRY_CODES, callables: m.TELEMETRY_CALLABLES
        };
      });
      for (const [field, serverField] of [['kinds','KINDS'], ['screens','SCREENS'], ['versions','VERSIONS'],
        ['codes','CODES'], ['callables','CALLABLES']]) {
        assert.deepEqual(result[field].slice().sort(), contract[serverField].slice().sort());
      }
      assert.deepEqual(result.report, { kind: 'manual', screen: 'feedback.html',
        version: '42G.0', code: 'TypeError', callable: 'submitFeedback' });
      assert.deepEqual(result.unknown, { kind: 'manual', screen: 'unknown',
        version: 'unknown', code: 'unknown', callable: 'unknown' });
    } finally { await f.context.close(); }
  });

  await test('desktop form is usable without horizontal overflow', async () => {
    const f = await fixture([{ data: ok }], 'firefighter', 1280);
    try {
      await draft(f.page);
      assert.equal(await f.page.locator('#send').isEnabled(), true);
      assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  assert.equal(passed, 10);
  console.log('\n10 ops browser checks passed (stubbed Firebase; no production/emulator access).');
} finally {
  await browser.close();
}
