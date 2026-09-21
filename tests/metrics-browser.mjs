// לוח מדדים — בדיקות דפדפן על metrics.html ועל metrics-ui.js האמיתיים.
// Firebase ו-callables מדומים; שום קצה מרוחק לא נגיש (כל בקשת רשת נחסמת).
// RESQ_CHROMIUM בוחר קובץ הרצה של Chromium; RESQ_REPO_ROOT משלים קבצי מאגר
// (theme.css) כשהבדיקה רצה מחוץ לעותק המלא.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = process.env.RESQ_REPO_ROOT ? path.resolve(process.env.RESQ_REPO_ROOT) : root;
const locate = (p) => (fs.existsSync(path.join(root, p)) ? path.join(root, p) : path.join(repoRoot, p));
const read = (p) => fs.readFileSync(locate(p), 'utf8');
const launch = process.env.RESQ_CHROMIUM ? { headless: true, executablePath: process.env.RESQ_CHROMIUM } : { headless: true };
const browser = await chromium.launch(launch);
let passed = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }
async function noOverflow(page) { return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1); }
async function minTouch(page, selector) {
  return page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).filter((b) => b.offsetParent !== null).every((b) => b.offsetHeight >= 44 && b.offsetWidth >= 44), selector);
}
function moduleTag(file, globalName) {
  const src = read(file).replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ');
  const names = [...read(file).matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  return { type: 'module', content: src + '\nwindow.' + globalName + ' = { ' + names.join(', ') + ' };' };
}
async function pageFor(name) {
  const html = read(name);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(8000);
  await page.route('**/*', (route) => route.abort());
  const localHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1] || '';
    if (!/\.css(?:\?|$)/i.test(href) || /^(?:https?:|\/\/)/i.test(href)) return '';
    const file = locate(href.split('?')[0].replace(/^\.\//, ''));
    return fs.existsSync(file) ? '<style>' + fs.readFileSync(file, 'utf8') + '</style>' : '';
  });
  await page.setContent(localHtml);
  return { page, html };
}
const metric = (value, over) => Object.assign({ value, available: value !== null, partial: false, stale: false, as_of_day: value === null ? null : '2026-09-18' }, over || {});
const FIXTURE = {
  ok: true, days: 7, from_day: '2026-09-12', to_day: '2026-09-18', as_of_day: '2026-09-18', partial: true, failed_days: ['2026-09-14'], stale: false,
  hash_mode: 'unkeyed', unkeyed_seen: true,
  events: {
    login_success: metric(1234, { ok: 1200, fail: 34, partial: true }), login_failure: metric(34, { ok: 0, fail: 34 }),
    onboarding_started: metric(9, { ok: 9, fail: 0 }), onboarding_completed: metric(null, { reason: 'no-data' }),
    device_readiness_started: metric(3, { ok: 3, fail: 0 }), device_readiness_completed: metric(2, { ok: 2, fail: 0, stale: true, as_of_day: '2026-09-13' }),
    push_queued: metric(0 + 5, { ok: 5, fail: 0 }), push_delivered: metric(null, { reason: 'no-data' }), push_failed: metric(null, { reason: 'no-data' }),
    schedule_import_started: metric(null, { reason: 'no-data' }), schedule_import_completed: metric(null, { reason: 'no-data' }), schedule_publish_completed: metric(4, { ok: 3, fail: 1 }),
    callout_started: metric(2, { ok: 2, fail: 0 }), callout_closed: metric(1, { ok: 1, fail: 0 }), client_error: metric('<b>7</b>', { available: true })
  },
  derived: {
    registrations_started: metric(9, { ok: 9, fail: 0 }), registrations_completed: metric(null, { reason: 'no-data' }),
    devices_ready: metric(2, { stale: true, as_of_day: '2026-09-13' }),
    push_success_rate: metric(null, { reason: 'zero-denominator' }),
    load_time_buckets: metric({ bucket_250: 3, bucket_100: 10, bucket_5000: 1 }, { total: 14 }),
    schedule_publish_failures: metric(1, { total: 4 }),
    callouts_opened: metric(2), callouts_closed: metric(1),
    active_users_rate: metric(null, { reason: 'no-source' })
  }
};
try {
  const { page, html } = await pageFor('metrics.html');
  check('metrics.html is RTL Hebrew with theme.css, viewport and exactly one App Check init', /<html lang="he" dir="rtl">/.test(html) && /name="viewport"/.test(html)
    && /theme\.css\?v=42h29/.test(html) && (html.match(/await initAppCheck\(app\);/g) || []).length === 1);
  check('page gate: main and deny both start hidden, non-super reveals deny and returns before any call', /if\(claims\.super!==true\)\{\$\('deny'\)\.classList\.remove\('metrics-hidden'\);return;\}/.test(html)
    && await page.locator('#main').isHidden() && await page.locator('#deny').isHidden());
  await page.evaluate(() => document.getElementById('deny').classList.remove('metrics-hidden'));
  check('deny screen is visible for a non-super account and main stays hidden', await page.locator('#deny').isVisible() && await page.locator('#main').isHidden()
    && (await page.locator('#deny h1').textContent()) === 'אין הרשאה למסך');
  await page.evaluate(() => { document.getElementById('deny').classList.add('metrics-hidden'); document.getElementById('main').classList.remove('metrics-hidden'); });
  await page.addScriptTag(moduleTag('metrics-ui.js', 'MetricsUI'));
  await page.waitForFunction(() => !!window.MetricsUI);
  await page.evaluate((fixture) => {
    const $ = (id) => document.getElementById(id);
    window.fx = { calls: [], identity: { uid: 'super-a', epoch: 1, super: true }, lost: 0, next: fixture, fail: null };
    const elements = { refresh: $('btnRefresh'), range: $('range'), rangeLabel: $('rangeLabel'), asOf: $('asOf'), hashMode: $('hashMode'), flags: $('flags'), message: $('message'), derived: $('derived'), events: $('events') };
    window.ui = MetricsUI.createMetricsUi({ elements, currentIdentity: () => window.fx.identity, onIdentityLost: () => { window.fx.lost += 1; },
      call: async (name, data) => { window.fx.calls.push({ name, data }); if (window.fx.fail) { const e = new Error('x'); e.code = window.fx.fail; throw e; } return window.fx.next; } });
    $('btnRefresh').addEventListener('click', ui.refresh);
    $('range').addEventListener('change', () => { ui.setDays($('range').value); ui.refresh(); });
  }, FIXTURE);
  await page.locator('#btnRefresh').click();
  await page.waitForFunction(() => document.querySelectorAll('#derived .metrics-row').length === 9);
  check('refresh calls getMetricsDashboard with the selected day range only', await page.evaluate(() => JSON.stringify(window.fx.calls[0]) === JSON.stringify({ name: 'getMetricsDashboard', data: { days: 7 } })));
  check('all nine derived metrics and fifteen event counters are rendered', await page.locator('#derived .metrics-row').count() === 9 && await page.locator('#events .metrics-row').count() === 15);
  const rowText = async (key) => page.locator('.metrics-row[data-metric="' + key + '"] .metrics-value').textContent();
  check('unavailable metric shows "לא זמין", never 0', (await rowText('push_success_rate')) === 'לא זמין' && (await rowText('active_users_rate')) === 'לא זמין'
    && (await rowText('registrations_completed')) === 'לא זמין' && (await rowText('onboarding_completed')) === 'לא זמין');
  check('unavailable reasons are labelled (no-source, zero-denominator)', (await page.locator('.metrics-row[data-metric="active_users_rate"] .metrics-badge.reason').textContent()) === 'אין מקור למדד בשכבה זו'
    && (await page.locator('.metrics-row[data-metric="push_success_rate"] .metrics-badge.reason').textContent()) === 'אין מכנה (לא נמסר ולא נכשל)');
  check('numbers, buckets and totals render from the fixture', (await rowText('registrations_started')) === '9' && (await rowText('login_success')) === '1,234'
    && (await rowText('load_time_buckets')) === 'עד 100 מ״ש: 10 · עד 250 מ״ש: 3 · עד 5000 מ״ש: 1'
    && /תקין: 1200 · נכשל: 34/.test(await page.locator('.metrics-row[data-metric="login_success"] .metrics-meta').textContent()));
  check('partial and stale badges appear per metric and at page level', await page.locator('.metrics-row[data-metric="login_success"] .metrics-badge.partial').count() === 1
    && await page.locator('.metrics-row[data-metric="devices_ready"] .metrics-badge.stale').count() === 1
    && await page.locator('.metrics-row[data-metric="callouts_opened"] .metrics-badge').count() === 0
    && await page.locator('#flags .metrics-badge.partial').count() === 1 && await page.locator('#flags .metrics-badge.stale').count() === 0);
  check('hash mode label is honest: unkeyed = pseudonymous, reversible by enumeration; never "anonymous"', (await page.locator('#hashMode').textContent()) === 'ללא מפתח — פסאודונים, הפיך במנייה'
    && await page.locator('#flags .metrics-badge.unkeyed').count() === 1
    && !/אנונימי/.test((await page.locator('#hashMode').textContent()) + (await page.locator('#flags').textContent()) + (await page.locator('#message').textContent()))
    && /אינו מכריז על אנונימיות/.test(await page.locator('#main').textContent()));
  check('non-numeric value is rendered as text and never as markup', (await rowText('client_error')) === 'לא זמין' && await page.locator('#events b').count() === 0);
  check('date range and as-of day are shown in Hebrew day order', (await page.locator('#rangeLabel').textContent()) === '12.09.2026 – 18.09.2026' && (await page.locator('#asOf').textContent()) === '18.09.2026');
  for (const w of [320, 360, 390]) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(30);
    check('no horizontal overflow at ' + w, await noOverflow(page));
  }
  check('toolbar controls are at least 44px', await minTouch(page, '#btnRefresh, #range'));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  check('dark theme keeps the layout without overflow', await noOverflow(page));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  // טווח
  await page.selectOption('#range', '30');
  await page.waitForFunction(() => window.fx.calls.length === 2);
  check('changing the range re-queries with the new day count', await page.evaluate(() => window.fx.calls[1].data.days === 30));
  // הרשאה שנשללה בזמן הקריאה
  await page.evaluate(() => { window.fx.identity = { uid: 'super-a', epoch: 2, super: false }; });
  await page.locator('#btnRefresh').click();
  await page.waitForFunction(() => window.fx.lost === 1);
  check('identity change during a call triggers onIdentityLost instead of rendering', await page.evaluate(() => window.fx.lost === 1));
  await page.evaluate(() => { window.fx.identity = { uid: 'super-a', epoch: 2, super: true }; window.fx.fail = 'functions/permission-denied'; });
  await page.locator('#btnRefresh').click();
  await page.waitForFunction(() => document.getElementById('message').classList.contains('warn'));
  check('server permission-denied is explained as a live super requirement', /נדרשת הרשאת מנהל־על חיה/.test(await page.locator('#message').textContent()));
  await page.evaluate(() => window.ui.invalidate());
  check('invalidate clears every rendered row and label', await page.locator('.metrics-row').count() === 0 && (await page.locator('#hashMode').textContent()) === '—');
  await page.evaluate(() => window.ui.render({}));
  check('empty payload renders every metric as unavailable with unknown hash mode', await page.locator('.metrics-row[data-available="false"]').count() === 24 && (await page.locator('#hashMode').textContent()) === 'אין נתונים — מצב הגיבוב לא ידוע');
  await page.close();
} finally {
  await browser.close();
}
console.log('\nMetrics browser: ' + passed + ' PASS.');
