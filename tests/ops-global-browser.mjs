// Actual page/App Check/bootstrap/facade modules; only Firebase SDK and I/O
// are fixtures. Every request is intercepted: no emulator or production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:41998';
const browser = await chromium.launch();
let passed = 0;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const functionsSource = fs.readFileSync(path.join(root, 'tests/stub/firebase-functions.js'), 'utf8')
  .replace('export function httpsCallable(', 'function underlyingCallable(')
  .replace('export function getFunctions(', 'function underlyingGetFunctions(') + `
export function getFunctions(...args) {
  window.__FUNCTIONS_ARGS = args;
  return underlyingGetFunctions(...args);
}
export function httpsCallable(...factoryArgs) {
  const name = factoryArgs[1];
  const base = underlyingCallable(...factoryArgs);
  const factoryThis = this;
  function call(...args) {
    if (window.__SDK_PROBE && name !== 'reportIncident') {
      window.__SDK_SEEN = { args, receiver:this, factoryArgs, factoryThis };
      if (window.__SDK_MODE === 'sync') throw window.__SDK_ERROR;
      if (window.__SDK_MODE === 'pending') return new Promise((resolve,reject) => {
        window.__SDK_REJECT = () => reject(window.__SDK_ERROR);
      });
      if (window.__SDK_MODE === 'reject') return Promise.reject(window.__SDK_ERROR);
      return Promise.resolve(window.__SDK_VALUE);
    }
    return Reflect.apply(base, this, args);
  }
  call.probeProperty = 'preserved';
  return call;
}
`;

async function fixture(file = 'forms.html', role = 'firefighter', blockBootstrap = false, mutation = '') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/firebasejs/')) {
      const name = path.basename(url.pathname);
      let body;
      if (name === 'firebase-app-check.js') body = 'export class ReCaptchaEnterpriseProvider {} export function initializeAppCheck(){ window.__AC_INIT=(window.__AC_INIT||0)+1; return {}; }';
      else if (name === 'firebase-functions.js') body = functionsSource;
      else {
        const file = path.join(root, 'tests/stub', name);
        body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};';
      }
      return route.fulfill({ status: 200, contentType: 'text/javascript', body });
    }
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (blockBootstrap && url.pathname === '/monitoring-bootstrap.js') return route.abort('failed');
    const local = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!local.startsWith(root + path.sep) || !fs.existsSync(local) || !fs.statSync(local).isFile()) return route.fulfill({ status: 404, body: '' });
    let body = fs.readFileSync(local);
    if (mutation && path.basename(local) === 'monitoring-bootstrap.js') {
      const guard = mutation === 'role' ? ' || claims.role !== permit.role' : 'claims.stationId !== permit.stationId || ';
      body = body.toString('utf8');
      assert.ok(body.includes(guard), 'mutation must alter the actual guard');
      body = body.replace(guard, '');
    }
    return route.fulfill({ status: 200, contentType: mime[path.extname(local)] || 'application/octet-stream', body });
  });
  await context.addInitScript(role => {
    window.__SMOKE_ROLE = role;
    window.__MONITOR_LISTENERS = {};
    const add = window.addEventListener;
    window.addEventListener = function (name, ...args) {
      if (['error','unhandledrejection','resq:callable-start'].includes(name)) window.__MONITOR_LISTENERS[name] = (window.__MONITOR_LISTENERS[name] || 0) + 1;
      return Reflect.apply(add, this, [name, ...args]);
    };
  }, role);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/' + file, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__AC_INIT === 1);
  await page.locator('#appNav').waitFor();
  if (!blockBootstrap) await page.waitForFunction(() => window.__MONITOR_LISTENERS['resq:callable-start'] === 1);
  return { context, page };
}

async function reports(page) {
  return page.evaluate(() => (window.__CALLABLE_CALLS || []).filter(c => c.name === 'reportIncident'));
}
async function reportCount(page, count) {
  await page.waitForFunction(count => (window.__CALLABLE_CALLS || []).filter(c => c.name === 'reportIncident').length === count, count);
}
async function settle(page) { await page.waitForTimeout(100); }
async function errorEvent(page, name = 'TypeError') {
  await page.evaluate(name => {
    const error = new Error('private user text must not leave the browser'); error.name = name;
    window.dispatchEvent(new ErrorEvent('error', { error }));
  }, name);
}
async function probe(page, mode = 'pending') {
  return page.evaluate(async mode => {
    const sdk = await import('./monitored-functions.js?v=42g1');
    window.__SDK_PROBE = true; window.__SDK_MODE = mode;
    window.__SDK_ERROR = new TypeError('private business text');
    const fn = sdk.httpsCallable({}, 'whoAmI');
    window.__BUSINESS_DONE = fn({ private: 'unchanged payload' }).catch(error => { window.__BUSINESS_ERROR_SAME = error === window.__SDK_ERROR; });
  }, mode);
}
async function test(name, fn) { await fn(); passed++; console.log('✓ ' + name); }

try {
  for (const file of ['forms.html', 'attendance.html']) {
    await test(file + ': real App Check starts one monitor; finite global errors are deduplicated', async () => {
      const f = await fixture(file);
      try {
        await errorEvent(f.page); await reportCount(f.page, 1);
        await errorEvent(f.page); await settle(f.page);
        const calls = await reports(f.page);
        assert.equal(calls.length, 1);
        // The deployed finite telemetry catalog predates this Hosting-only patch.
        assert.deepEqual(calls[0].payload, { kind:'client-error', screen:file, version:'unknown', code:'TypeError', callable:'unknown' });
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        // These pages already have one local error-banner listener per kind.
        const expectedListeners = { error:2, unhandledrejection:2, 'resq:callable-start':1 };
        assert.deepEqual(await f.page.evaluate(() => window.__MONITOR_LISTENERS), expectedListeners);
        await f.page.evaluate(async () => {
          const { startMonitoring } = await import('./monitoring-bootstrap.js?v=42g1');
          startMonitoring({}); startMonitoring({});
        });
        assert.deepEqual(await f.page.evaluate(() => window.__MONITOR_LISTENERS), expectedListeners);
      } finally { await f.context.close(); }
    });
  }

  await test('facade preserves factory options/this, invocation args/this, properties, result and original errors', async () => {
    const f = await fixture();
    try {
      const result = await f.page.evaluate(async () => {
        const sdk = await import('./monitored-functions.js?v=42g1');
        const receiver = {}, factoryThis = {}, fns = {}, options = { timeout:12345 }, payload = {}, extra = {};
        window.__SDK_PROBE = true; window.__SDK_MODE = 'resolve'; window.__SDK_VALUE = { data:{ marker:'same' } };
        const fn = sdk.httpsCallable.call(factoryThis, fns, 'whoAmI', options);
        const value = await fn.call(receiver, payload, extra);
        const seen = window.__SDK_SEEN;
        const out = { value: value === window.__SDK_VALUE, options: seen.factoryArgs[2] === options, factoryThis: seen.factoryThis === factoryThis, fns: seen.factoryArgs[0] === fns, receiver: seen.receiver === receiver, args: seen.args[0] === payload && seen.args[1] === extra, property: fn.probeProperty };
        window.__SDK_ERROR = new Error('sensitive text'); window.__SDK_MODE = 'sync';
        try { fn({}); } catch(error) { out.sync = error === window.__SDK_ERROR; }
        window.__SDK_MODE = 'reject';
        try { await fn({}); } catch(error) { out.reject = error === window.__SDK_ERROR; }
        return out;
      });
      assert.deepEqual(result, { value:true, options:true, factoryThis:true, fns:true, receiver:true, args:true, property:'preserved', sync:true, reject:true });
      await reportCount(f.page, 1);
    } finally { await f.context.close(); }
  });

  await test('pending role is not reported or deduped into a later authorized session', async () => {
    const f = await fixture('feedback.html', 'pending');
    try {
      await errorEvent(f.page); await settle(f.page); assert.equal((await reports(f.page)).length, 0);
      await f.page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'next-user'));
      await f.page.locator('#work').waitFor({ state:'visible' });
      await errorEvent(f.page); await reportCount(f.page, 1);
    } finally { await f.context.close(); }
  });

  await test('call begun by A is never reported as B when its promise later rejects', async () => {
    const f = await fixture();
    try {
      await probe(f.page);
      await f.page.evaluate(() => { window.__SMOKE_EMIT_AUTH('firefighter', 'other-user'); window.__SDK_REJECT(); });
      await f.page.evaluate(() => window.__BUSINESS_DONE); await settle(f.page);
      assert.equal((await reports(f.page)).length, 0);
      assert.equal(await f.page.evaluate(() => window.__BUSINESS_ERROR_SAME), true);
    } finally { await f.context.close(); }
  });

  await test('anonymous invocation is not queued for login and missing station claims do not report', async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(async () => {
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
        window.__SAVED_USER = getAuth().currentUser; getAuth().currentUser = null;
      });
      await probe(f.page);
      await f.page.evaluate(async () => {
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
        getAuth().currentUser = window.__SAVED_USER;
        window.__SDK_REJECT(); await window.__BUSINESS_DONE;
      });
      await settle(f.page); assert.equal((await reports(f.page)).length, 0);
      assert.equal(await f.page.evaluate(() => window.__BUSINESS_ERROR_SAME), true);
      await f.page.evaluate(async () => {
        const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
        getAuth().currentUser.getIdTokenResult = async () => ({ claims:{ role:'firefighter' } });
      });
      await errorEvent(f.page); await settle(f.page);
      assert.equal((await reports(f.page)).length, 0);
    } finally { await f.context.close(); }
  });

  // Each variant owns a fresh reporter: dedupe from a preceding failure must
  // never hide a missing authorization check in the following case.
  for (const variant of ['station','role','claims-reject']) {
    await test(variant + ': same User ownership is revalidated independently', async () => {
      const f = await fixture();
      const errors = [];
      f.page.on('pageerror', error => errors.push(error.message));
      try {
        if (variant === 'claims-reject') await f.page.evaluate(async () => {
          const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
          getAuth().currentUser.getIdTokenResult = () => Promise.reject(new Error('claims unavailable'));
        });
        await probe(f.page);
        await f.page.evaluate(async variant => {
          const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
          if (variant !== 'claims-reject') getAuth().currentUser.getIdTokenResult = async () => ({ claims:{ role:variant === 'role' ? 'commander' : 'firefighter', stationId:variant === 'station' ? 'other_station' : 'eilat_102' } });
          window.__SDK_REJECT(); await window.__BUSINESS_DONE;
        }, variant);
        await settle(f.page); assert.equal((await reports(f.page)).length, 0);
        assert.equal(await f.page.evaluate(() => window.__BUSINESS_ERROR_SAME), true);
        assert.deepEqual(errors, []);
      } finally { await f.context.close(); }
    });
  }

  for (const variant of ['station','role']) {
    await test(variant + ': removing the real final ownership guard is detected', async () => {
      const f = await fixture('forms.html', 'firefighter', false, variant);
      try {
        await probe(f.page);
        await f.page.evaluate(async variant => {
          const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
          getAuth().currentUser.getIdTokenResult = async () => ({ claims:{ role:variant === 'role' ? 'commander' : 'firefighter', stationId:variant === 'station' ? 'other_station' : 'eilat_102' } });
          window.__SDK_REJECT(); await window.__BUSINESS_DONE;
        }, variant);
        await reportCount(f.page, 1);
        assert.equal((await reports(f.page)).length, 1, 'the same scenario must expose the broken guard');
      } finally { await f.context.close(); }
    });
  }

  await test('global and callable failures share the ten-attempt cap; failed reports cannot loop', async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => { window.__CALLABLE_PLAN = { reportIncident: Array.from({ length:20 }, () => ({ reject:true, code:'functions/unavailable' })) }; });
      await errorEvent(f.page); await reportCount(f.page, 1);
      await f.page.evaluate(async () => {
        const sdk = await import('./monitored-functions.js?v=42g1');
        const { TELEMETRY_CALLABLES } = await import('./incident-client.js?v=42g1');
        window.__SDK_PROBE = true; window.__SDK_MODE = 'reject'; window.__SDK_ERROR = new Error('private');
        await Promise.all(TELEMETRY_CALLABLES.filter(n => !['unknown','reportIncident'].includes(n)).slice(0,15).map(name => sdk.httpsCallable({}, name)({}).catch(() => {})));
      });
      await reportCount(f.page, 10); await settle(f.page);
      assert.equal((await reports(f.page)).length, 10);
      const calls = await reports(f.page);
      assert.ok(calls.every(c => Object.keys(c.payload).sort().join(',') === 'callable,code,kind,screen,version'));
    } finally { await f.context.close(); }
  });

  await test('missing bootstrap does not break actual attendance calls or alter their rejection', async () => {
    const f = await fixture('attendance.html', 'firefighter', true);
    try {
      assert.equal(await f.page.evaluate(() => (window.__CALLABLE_CALLS || []).some(c => c.name === 'getLegacyScheduleCompatibilityContext')), true);
      await probe(f.page); await f.page.evaluate(async () => { window.__SDK_REJECT(); await window.__BUSINESS_DONE; });
      assert.equal(await f.page.evaluate(() => window.__BUSINESS_ERROR_SAME), true);
      assert.equal((await reports(f.page)).length, 0);
    } finally { await f.context.close(); }
  });

  await test('malformed internal capture events do not throw or submit telemetry', async () => {
    const f = await fixture();
    try {
      const errors = [];
      f.page.on('pageerror', error => errors.push(error.message));
      await f.page.evaluate(() => {
        for (const detail of [null, {}, { name:3 }, { get name() { throw new Error('bad getter'); } }, Object.freeze({ name:'whoAmI' })]) {
          window.dispatchEvent(new CustomEvent('resq:callable-start', { detail }));
        }
      });
      await settle(f.page);
      assert.deepEqual(errors, []); assert.equal((await reports(f.page)).length, 0);
    } finally { await f.context.close(); }
  });

  await test('all 21 Firebase screens bootstrap monitoring and all 14 factories use the facade', async () => {
    const screens = fs.readdirSync(root).filter(n => n.endsWith('.html') && !['index.html','schedule.html'].includes(n));
    assert.equal(screens.length, 21);
    for (const screen of screens) {
      let source = fs.readFileSync(path.join(root, screen), 'utf8');
      if (screen === 'schedule-management.html') source += fs.readFileSync(path.join(root, 'schedule-management.js'), 'utf8');
      assert.equal((source.match(/await initAppCheck\(app\);/g) || []).length, 1, screen);
    }
    const consumers = ['access.html','admin.html','alerts.html','attendance-shadow.html','attendance.html','check.html','feedback.html','guards.html','import.html','login.html','schedule-management.js','stats.html','swaps.html','unlock.html'];
    assert.equal(consumers.length, 14);
    for (const file of consumers) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(source.includes("from './monitored-functions.js?v=42g1'"), file);
      assert.ok(!source.includes('/firebase-functions.js'), file + ' bypasses the facade');
    }
    const worker = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
    for (const file of ['incident-client.js','monitoring-bootstrap.js','monitored-functions.js']) assert.ok(worker.includes("'./" + file + "'"), file + ' not precached');
    assert.ok(!fs.readFileSync(path.join(root, 'feedback.html'), 'utf8').includes('installIncidentReporter'));
    const facade = fs.readFileSync(path.join(root, 'monitored-functions.js'), 'utf8');
    assert.ok(!facade.includes("from './"), 'business facade must not statically depend on telemetry assets');
  });
  console.log('\n' + passed + ' global monitoring browser checks passed.');
} finally { await browser.close(); }
