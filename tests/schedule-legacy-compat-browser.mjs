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
    // These scenarios exercise schedule compatibility, not callout audio.
    // Model a cold page before any user gesture so a synthetic active callout
    // cannot consume the deliberately delayed compatibility window by opening
    // the host audio device in headless Chromium.
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: Object.freeze({ hasBeenActive:false, isActive:false })
    });
    window.__SMOKE_ROLE = 'super';
    window.__CALLABLE_PLAN = value;
  }, plan);
  return context;
}

function dateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function shiftedDay(days) {
  const today = new Date();
  return dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, 12));
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
    // תשובת ימי-עבודה מושהית: הבדל מחשב אותה מהסבב (A/B/C), רק באיחור.
    const context = await contextWithPlan({
      getEffectiveWorkdays:[{ delay:900 }]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/swaps.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(call =>
      call && call.name === 'getEffectiveWorkdays'));
    const dates = await page.evaluate(() => {
      const key = date => date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
      const offset = (value, days) => {
        const date = new Date(value + 'T12:00:00');
        date.setDate(date.getDate() + days);
        return key(date);
      };
      const input = document.querySelector('#myDate');
      return { mine:offset(input.min, 2), his:offset(input.min, 3),
        expected:{ from:offset(input.min, -1), to:offset(input.max, 1) } };
    });
    await page.locator('#myDate').fill(dates.mine);
    await page.locator('#hisDate').fill(dates.his);
    assert.equal(await page.evaluate(() => document.querySelector('#btnSend').disabled), true,
      'sending is locked while the workdays answer is still pending');
    assert.match(await page.locator('#myCrewLine').textContent(), /בסיס הסידור אינו זמין/);
    await page.waitForFunction(() => !document.querySelector('#btnSend')?.disabled);
    // ⭐ השורה שלי מתארת אותי (stub-uid, משמרת ג׳): עובד או לא — לפי הסידור, לא „משמרת X".
    assert.match(await page.locator('#myCrewLine').textContent(), /(עובד|לא עובד) ביום זה לפי הסידור הקיים/);
    assert.match(await page.locator('#hisCrewLine').textContent(), /בחר עם מי מחליפים/);
    const calls = await page.evaluate(() => (window.__CALLABLE_CALLS || [])
      .filter(call => call && call.name === 'getEffectiveWorkdays')
      .map(call => call.payload));
    assert.equal(calls.length, 1);
    assert.deepEqual({ from:calls[0].from, to:calls[0].to }, dates.expected);
    assert.ok(Array.isArray(calls[0].uids) && calls[0].uids.includes('stub-uid') && calls[0].uids.includes('u2'),
      'the request names me and the roster');
    assert.equal(Object.hasOwn(calls[0], 'sid'), false);
    assert.equal(Object.hasOwn(calls[0], 'station'), false);
    await context.close();
    console.log('✓ delayed workdays success unlocks sending and describes my selected day');
  }

  // Statistics reuses one annual compatibility snapshot for all shorter
  // workload tabs. The request is 365 days back plus today: 366 inclusive.
  {
    const context = await contextWithPlan({
      getGuardLoadStatistics:[{ data:{ guards:[] } }]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/stats.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.waitForFunction(() => (window.__CALLABLE_CALLS || []).some(call =>
      call && call.name === 'getEffectiveWorkdays'));
    const value = await page.evaluate(() => {
      const key = date => date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
      const today = new Date();
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 365, 12);
      const call = (window.__CALLABLE_CALLS || []).find(item =>
        item && item.name === 'getEffectiveWorkdays');
      return { payload:call && call.payload, expected:{ from:key(from), to:key(today) } };
    });
    assert.deepEqual({ from:value.payload.from, to:value.payload.to }, value.expected);
    assert.ok(value.payload.uids.length >= 4, 'the whole roster is asked about');
    assert.equal(Object.hasOwn(value.payload, 'sid'), false);
    await context.close();
    console.log('✓ statistics requests exactly 366 inclusive days without a station selector');
  }

  // Guard viewing uses two independently bounded annual windows. A single
  // 731-day compatibility request would exceed the server cap.
  {
    const context = await contextWithPlan({});
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/guards.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.waitForFunction(() => (window.__CALLABLE_CALLS || []).filter(call =>
      call && call.name === 'getEffectiveWorkdays').length === 2);
    const value = await page.evaluate(() => {
      const key = date => date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' +
        String(date.getDate()).padStart(2, '0');
      const today = new Date();
      const shift = days => new Date(today.getFullYear(), today.getMonth(),
        today.getDate() + days, 12);
      const compatibility = (window.__CALLABLE_CALLS || []).filter(item =>
        item && item.name === 'getEffectiveWorkdays').map(item => ({ from:item.payload.from, to:item.payload.to }));
      const boards = (window.__CALLABLE_CALLS || []).filter(item =>
        item && item.name === 'getScheduleGuardBoard').map(item => item.payload);
      return { compatibility, boards, expected:{
        history:{ from:key(shift(-365)), to:key(shift(-1)) },
        upcoming:{ from:key(shift(0)), to:key(shift(365)) }
      } };
    });
    assert.deepEqual(value.compatibility, [value.expected.history, value.expected.upcoming]);
    assert.deepEqual(value.boards, [value.expected.upcoming, value.expected.history]);
    for (const payload of value.compatibility.concat(value.boards)) {
      const days = Math.round((new Date(payload.to + 'T12:00:00') -
        new Date(payload.from + 'T12:00:00')) / 86400000) + 1;
      assert.ok(days <= 366, 'each request remains below both server caps');
      assert.equal(Object.hasOwn(payload, 'station'), false);
    }
    await context.close();
    console.log('✓ guards requests separate 365-day history and 366-day future windows');
  }

  // A guard from seven months ago must affect the annual fairness history,
  // while a future assignment must not. This is the user-visible regression
  // that a request-shape assertion alone cannot catch.
  {
    const historic = { id:'old-guard', title:'אבטחה היסטורית', kind:'sport',
      place:'', date:shiftedDay(-210), start:'10:00', end:'12:00', status:'staffed',
      slots:1, need_quals:[], notes:'', revision:0, assigned:['u2'], signups:[] };
    const future = { ...historic, id:'future-guard', title:'אבטחה עתידית',
      date:shiftedDay(120) };
    const context = await contextWithPlan({
      getGuardManagementStatus:[{ data:{ guard_manager:true } }],
      getScheduleGuardBoard:[{ data:{ guards:[] } }, { data:{ guards:[] } }],
      getScheduleGuardManagerBoard:[
        { data:{ guards:[future] } }, { data:{ guards:[historic] } }
      ]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/guards.html`, { waitUntil:'load' });
    await page.locator('#work').waitFor({ state:'visible' });
    await page.waitForFunction(() => document.querySelector('#mineNote')?.textContent
      .includes('ב-12 החודשים האחרונים'));
    const total = await page.evaluate(() => {
      const person = Array.from(document.querySelectorAll('#balList .nm'))
        .find(node => node.textContent.includes('טל חודרה'));
      if (!person || !person.nextElementSibling || !person.nextElementSibling.nextElementSibling) {
        return null;
      }
      const values = person.nextElementSibling.nextElementSibling.textContent.match(/\d+/g) || [];
      return values.map(Number).reduce((sum, value) => sum + value, 0);
    });
    assert.equal(total, 1,
      'the 210-day-old guard is counted exactly once and the future guard is excluded');
    await context.close();
    console.log('✓ annual guard load counts 2–12 month history and excludes future assignments');
  }

  // One successful half is not an annual snapshot. The board remains usable,
  // but the workload claim and automatic ranking must fail closed.
  {
    const context = await contextWithPlan({
      getEffectiveWorkdays:[
        {},
        { reject:true, code:'functions/unavailable', message:'future half failed' }
      ],
      getScheduleGuardBoard:[
        { data:{ guards:[{ id:'future-visible', title:'אבטחה פתוחה', kind:'sport',
          date:shiftedDay(10), start:'10:00', end:'12:00', status:'open', slots:1,
          assigned_count:0, open_slots:1, viewer_assigned:false, viewer_signed_up:false }] } },
        { data:{ guards:[] } }
      ]
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/guards.html`, { waitUntil:'load' });
    await page.locator('#openList .g').first().waitFor();
    assert.doesNotMatch(await page.locator('#mineNote').textContent(), /12 החודשים האחרונים/);
    assert.match(await page.locator('#mineNote').textContent(), /אינו זמין/);
    assert.equal(await page.locator('#rankList .rec').count(), 0);
    assert.match(await page.locator('#openList').textContent(), /אבטחה פתוחה/,
      'the independent guard board stays available');
    await context.close();
    console.log('✓ a partial compatibility snapshot never publishes an annual ranking');
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('\n6/6 effective-schedule browser checks passed (swaps, stats, guards).');
