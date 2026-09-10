import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:42117';
const html = `<!doctype html><html lang="he" dir="rtl"><body><main id="root">
  <button data-w="refresh"></button>
  <button data-w="tab-absence"></button><strong data-w="absence-count"></strong>
  <button data-w="tab-abroad"></button><strong data-w="abroad-count"></strong>
  <button data-w="tab-due"></button><strong data-w="due-count"></strong>
  <p data-w="message"></p><div data-w="list"></div><button data-w="more"></button>
  <form data-w="editor"><input data-w="search"><button data-w="search-button" type="button"></button>
    <div data-w="candidates"></div><p data-w="chosen"></p>
    <select data-w="kind"><option value="long_absence">absence</option><option value="abroad_leave">abroad</option></select>
    <input data-w="start"><input data-w="end"><textarea data-w="reason"></textarea><input data-w="followup">
    <button data-w="save" type="submit">save</button>
  </form>
</main></body></html>`;

const baseRecord = {
  record_id: 'a'.repeat(64), subject_uid: 'employee-1', subject_employee_number: '101',
  subject_full_name: 'עובד בדיקה', kind: 'long_absence', status: 'active',
  start_date: '2026-09-01', end_date: null, followup_date: '2026-09-01',
  reason: 'מעקב בדיקה', revision: 1, updated_at_ms: 1800000000000
};

async function fixture({ record = null } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/hr-workforce-ui.js') return route.fulfill({
      contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(root, 'hr-workforce-ui.js'))
    });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  await context.addInitScript(({ initial }) => {
    window.__session = { uid: 'hr-a', stationId: 'eilat_102', role: 'hr_coordinator', super: false, epoch: 1 };
    window.__listeners = []; window.__calls = []; window.__fail = Object.create(null);
    window.__rows = initial ? [initial] : [];
    const operation = async (name, data) => {
      window.__calls.push({ name, data: structuredClone(data) });
      if (window.__fail[name]) {
        window.__fail[name] = false;
        throw Object.assign(new Error('response lost after commit'), { code: 'functions/unavailable' });
      }
      return name === 'reminder'
        ? { record_id: data.record_id, revision: data.expected_revision,
            event_id: 'b'.repeat(64), notification_status: 'intent_only', duplicate: false }
        : { record_id: data.record_id || 'c'.repeat(64), revision: (data.expected_revision || 0) + 1,
            status: data.status, event_id: 'd'.repeat(64), duplicate: false };
    };
    window.__adapter = {
      currentSession: () => window.__session,
      subscribeIdentity: listener => { window.__listeners.push(listener); return () => {}; },
      listCases: async () => ({ items: structuredClone(window.__rows), next_cursor: null }),
      searchPeople: async () => ({ items: [{ uid: 'employee-1', name: 'עובד בדיקה', employee_number: '101', crew: 'A' }] }),
      createCase: data => operation('create', data), updateCase: data => operation(data.status === 'closed' ? 'close' : 'update', data),
      queueReminder: data => operation('reminder', data)
    };
    window.__emitIdentity = () => window.__listeners.forEach(listener => listener());
  }, { initial: record });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin + '/');
  await page.evaluate(async () => {
    const { createHrWorkforceUI } = await import('/hr-workforce-ui.js');
    window.__ui = createHrWorkforceUI(document.querySelector('#root'), window.__adapter);
  });
  await page.waitForFunction(() => document.querySelector('[data-w="message"]').textContent.includes('מעודכנים'));
  return { browser, page, pageErrors };
}

async function fillCreate(page) {
  await page.locator('[data-w="search"]').fill('עובד');
  await page.locator('[data-w="search-button"]').click();
  await page.locator('[data-w="candidates"] button').click();
  await page.locator('[data-w="start"]').fill('2026-09-01');
  await page.locator('[data-w="reason"]').fill('מעקב בדיקה');
  await page.locator('[data-w="followup"]').fill('2026-09-10');
}

const calls = (page, name) => page.evaluate(n => window.__calls.filter(call => call.name === n), name);
async function loseThenRepeat(page, name, action) {
  await page.evaluate(n => { window.__fail[n] = true; }, name);
  await action();
  await page.waitForFunction(n => window.__calls.filter(call => call.name === n).length === 1, name);
  assert.match(await page.locator('[data-w="message"]').textContent(), /נכשל|לא אושרה|לא ניתן|תוצאה.*ידועה|ניסיון חוזר/u,
    `${name}: a lost response must remain visible as an uncertain attempt`);
  await action(); await page.waitForFunction(n => window.__calls.filter(call => call.name === n).length === 2, name);
  const made = await calls(page, name);
  assert.equal(made.length, 2, `${name}: two transports expected`);
  assert.equal(made[1].data.request_id, made[0].data.request_id, `${name}: retry must reuse request_id`);
  assert.deepEqual(made[1].data, made[0].data, `${name}: retry must reuse exact payload`);
}

let passed = 0;
async function check(name, body) { await body(); ++passed; console.log('PASS ' + name); }

await check('actual module parses and imports in Chromium', async () => {
  const f = await fixture();
  try { assert.deepEqual(f.pageErrors, []); }
  finally { await f.browser.close(); }
});

await check('create reuses the exact request after response loss and success clears it', async () => {
  const f = await fixture();
  try {
    await fillCreate(f.page);
    await loseThenRepeat(f.page, 'create', () => f.page.locator('[data-w="save"]').click());
    await fillCreate(f.page);
    await f.page.locator('[data-w="save"]').click();
    await f.page.waitForFunction(() => window.__calls.filter(call => call.name === 'create').length === 3);
    const made = await calls(f.page, 'create');
    assert.equal(made.length, 3);
    assert.notEqual(made[2].data.request_id, made[1].data.request_id, 'new logical create must receive a new request_id');
  } finally { await f.browser.close(); }
});

await check('update reuses the exact request after response loss', async () => {
  const f = await fixture({ record: baseRecord });
  try {
    await f.page.locator('.hr-case-actions button').first().click();
    await f.page.locator('[data-w="reason"]').fill('נימוק מעודכן');
    await loseThenRepeat(f.page, 'update', () => f.page.locator('[data-w="save"]').click());
  } finally { await f.browser.close(); }
});

await check('close reuses the exact request after response loss', async () => {
  const f = await fixture({ record: baseRecord });
  try { await loseThenRepeat(f.page, 'close', () => f.page.locator('.hr-case-actions button').nth(1).click()); }
  finally { await f.browser.close(); }
});

await check('reminder reuses the exact request after response loss', async () => {
  const f = await fixture({ record: baseRecord });
  try { await loseThenRepeat(f.page, 'reminder', () => f.page.locator('.hr-case-actions button').nth(2).click()); }
  finally { await f.browser.close(); }
});

await check('identity change clears an uncertain create attempt', async () => {
  const f = await fixture();
  try {
    await fillCreate(f.page); await f.page.evaluate(() => { window.__fail.create = true; });
    await f.page.locator('[data-w="save"]').click();
    await f.page.waitForFunction(() => window.__calls.filter(call => call.name === 'create').length === 1);
    const old = (await calls(f.page, 'create'))[0].data.request_id;
    await f.page.evaluate(() => { window.__session = { ...window.__session, uid: 'hr-b', epoch: 2 }; window.__emitIdentity(); });
    await fillCreate(f.page); await f.page.locator('[data-w="save"]').click();
    const made = await calls(f.page, 'create');
    assert.equal(made.length, 2); assert.notEqual(made[1].data.request_id, old);
  } finally { await f.browser.close(); }
});

await check('malformed or stale mutation replies keep retry identity and never announce success', async () => {
  for (const bad of [
    { record_id:'c'.repeat(64), revision:1, status:'active', event_id:'d'.repeat(64), duplicate:false, extra:true },
    { record_id:'c'.repeat(64), revision:2, status:'active', event_id:'d'.repeat(64), duplicate:false },
    { record_id:'c'.repeat(64), revision:1, status:'closed', event_id:'d'.repeat(64), duplicate:false },
    { record_id:'c'.repeat(64), revision:1, status:'active', event_id:'d'.repeat(64), duplicate:'false' }
  ]) {
    const f=await fixture();
    try {
      await fillCreate(f.page);
      await f.page.evaluate(value => { window.__adapter.createCase = async data => {
        window.__calls.push({name:'create',data:structuredClone(data)}); return value;
      }; }, bad);
      await f.page.locator('[data-w="save"]').click();
      await f.page.waitForFunction(() => window.__calls.filter(call=>call.name==='create').length===1);
      assert.doesNotMatch(await f.page.locator('[data-w="message"]').textContent(), /נשמר עם חתימת/u);
      const first=(await calls(f.page,'create'))[0].data.request_id;
      await f.page.locator('[data-w="save"]').click();
      await f.page.waitForFunction(() => window.__calls.filter(call=>call.name==='create').length===2);
      assert.equal((await calls(f.page,'create'))[1].data.request_id,first);
    } finally { await f.browser.close(); }
  }
});

await check('malformed reminder reply keeps the same retry identity', async () => {
  const f=await fixture({record:baseRecord});
  try {
    await f.page.evaluate(() => { window.__adapter.queueReminder = async data => {
      window.__calls.push({name:'reminder',data:structuredClone(data)});
      return {record_id:data.record_id,revision:data.expected_revision,event_id:'b'.repeat(64),notification_status:'intent_only',duplicate:false,extra:true};
    }; });
    const action=()=>f.page.locator('.hr-case-actions button').nth(2).click();
    await action(); await f.page.waitForFunction(()=>window.__calls.filter(x=>x.name==='reminder').length===1);
    const first=(await calls(f.page,'reminder'))[0].data.request_id;
    await action(); await f.page.waitForFunction(()=>window.__calls.filter(x=>x.name==='reminder').length===2);
    assert.equal((await calls(f.page,'reminder'))[1].data.request_id,first);
  } finally { await f.browser.close(); }
});

console.log(`hr-workforce retry browser: ${passed}/${passed} PASS`);
