import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from './lib/contained-playwright.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'cost-usage-ui.js'), 'utf8')
  .replace(/^export function /gm, 'function ')
  .replace(/^export const /gm, 'const ');
const browser = await chromium.launch(process.env.RESQ_CHROMIUM
  ? { headless: true, executablePath: process.env.RESQ_CHROMIUM }
  : { headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.route('**/*', (route) => route.abort());
  await page.setContent('<!doctype html><html lang="he" dir="rtl"><body>'
    + '<div id="flags"></div><div id="actual"></div><div id="load"></div>'
    + '<div id="users"></div><div id="stationCalls"></div><div id="measurement"></div><div id="attribution"></div>'
    + '<div id="rangeLabel"></div><div id="message"></div><div id="selfCost"></div>'
    + '<input id="stationDay" type="date"><button id="nextStationPage" class="cu-hidden">עוד תחנות</button>'
    + '<button id="startMeasurement" class="cu-hidden">התחל מדידה</button>'
    + '</body></html>');
  await page.addScriptTag({ type: 'module', content: source + '\nwindow.createCostUsageUi = createCostUsageUi;' });
  await page.waitForFunction(() => typeof window.createCostUsageUi === 'function', null, { timeout: 5000 })
    .catch(error => { throw new Error('cost-usage module did not initialize: ' + pageErrors.join(' | '), { cause: error }); });
  const render = async (available) => page.evaluate((isAvailable) => {
    const ids = ['flags', 'actual', 'load', 'users', 'stationCalls', 'stationDay', 'nextStationPage',
      'startMeasurement', 'measurement', 'attribution', 'rangeLabel', 'message', 'selfCost'];
    const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const ui = window.createCostUsageUi({ elements, call: async () => ({}),
      currentIdentity: () => ({ uid: 'super', epoch: 1, super: true }),
      onIdentityLost: () => {} });
    ui.render({ days: 7, attribution: { ready: false }, measurement: { status: 'not_started' },
      feeder: { status: 'not_wired' }, panes: { actual_cost: isAvailable
        ? { available: true, badge: 'BILLING REPORTED', value: '1.25', currency: 'ILS',
          as_of: '2026-09-24T10:00:00Z', by_service: [] }
        : { available: false, badge: 'אין מקור', value: null },
      load_attribution: { features: [] }, users: { users: [] }, station_calls: {
        status: 'partial', station_aggregate_start_at: '2026-09-24T00:00:00Z',
        global_aggregate_start_at: '2026-09-24T10:00:00Z', next_station_page_token: 'newtown_102',
        days: [{ day: '2026-09-24', total: 3, coverage: 'partial_start_day', stations: [
          { station_id: 'eilat_102', calls: 2 }, { station_id: 'newtown_102', calls: 1 }
        ] }] } } });
    return { flags: elements.flags.textContent, actual: elements.actual.textContent,
      stationCalls: elements.stationCalls.textContent,
      nextStationPageVisible: !elements.nextStationPage.classList.contains('cu-hidden'),
      startHiddenWithoutKey: elements.startMeasurement.classList.contains('cu-hidden') };
  }, available);
  const active = await render(true);
  assert.match(active.flags, /עלות שימוש מדווחת/);
  assert.doesNotMatch(active.flags, /עלות בפועל: אין מקור/);
  assert.match(active.actual, /1\.25 ILS/);
  assert.match(active.stationCalls, /3 קריאות מאז תחילת המדידה ביום זה \(חלקי\)/);
  assert.equal(active.nextStationPageVisible, true);
  assert.match(active.stationCalls, /eilat_102/);
  assert.match(active.stationCalls, /newtown_102/);
  assert.equal(active.startHiddenWithoutKey, true);
  const missing = await render(false);
  assert.match(missing.flags, /עלות בפועל: אין מקור/);
  assert.doesNotMatch(missing.actual, /1\.25 ILS/);
  const activation = await page.evaluate(async () => {
    const ids = ['flags', 'actual', 'load', 'users', 'stationCalls', 'stationDay', 'nextStationPage',
      'startMeasurement', 'measurement', 'attribution', 'rangeLabel', 'message', 'selfCost'];
    const elements = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
    const calls = [];
    let allow = false;
    const ui = window.createCostUsageUi({ elements,
      currentIdentity: () => ({ uid: 'super', epoch: 1, super: true }), onIdentityLost: () => {},
      confirmAction: () => allow,
      call: async (name, data) => {
        calls.push({ name, data });
        return name === 'getCostUsageDashboard'
          ? { measurement: { status: 'active', measurement_start_at: '2026-09-24T10:00:00Z' },
              attribution: { ready: true }, panes: { station_calls: { selected_day: '2026-09-24', days: [] } } }
          : { ok: true };
      } });
    ui.render({ measurement: { status: 'not_started' }, attribution: { ready: true }, panes: {} });
    const visibleBefore = !elements.startMeasurement.classList.contains('cu-hidden');
    const refused = await ui.activateMeasurement();
    allow = true;
    const accepted = await ui.activateMeasurement();
    return { visibleBefore, refused, accepted, calls,
      hiddenAfter: elements.startMeasurement.classList.contains('cu-hidden'),
      stationDay: elements.stationDay.value };
  });
  assert.equal(activation.visibleBefore, true);
  assert.equal(activation.refused, false);
  assert.equal(activation.accepted, true);
  assert.deepEqual(activation.calls.map(row => row.name),
    ['setCostUsageMeasurementStart', 'getCostUsageDashboard']);
  assert.deepEqual(activation.calls[0].data, {});
  assert.equal(activation.hiddenAfter, true);
  assert.equal(activation.stationDay, '2026-09-24');
  console.log('PASS cost-usage actual/no-source browser states');
} finally {
  await browser.close();
}
