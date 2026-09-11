import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'home-faults.js'), 'utf8')
  .replace(/export function /g, 'function ')
  .replace(/export const HOME_FAULT_GROUPS[^;]+;/, '')
  .replace(/export const HOME_FAULT_LIMIT[^;]+;/, '') +
  '\nwindow.initHomeFaults=initHomeFaults;window.destroyHomeFaults=destroyHomeFaults;';
let passed = 0;
async function check(name, run) { await run(); passed += 1; console.log('PASS ' + name); }

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(`<button data-fault-group="operational"></button><button data-fault-group="building"></button><b id="oc"></b><b id="bc"></b><div id="status"></div><div id="list"></div><div id="empty" class="hide"></div>`);
  await page.addScriptTag({ content:source });
  await page.evaluate(() => {
    const el = (id) => document.getElementById(id);
    window.snapshots = [];
    window.unsubscribed = 0;
    const sdk = {
      collection:(...args) => ['collection', ...args.slice(1)],
      where:(...args) => ['where', ...args], orderBy:(...args) => ['orderBy', ...args], limit:(...args) => ['limit', ...args],
      query:(...args) => args,
      onSnapshot:(_q, ok, fail) => { window.snapshots.push({ ok, fail }); return () => { window.unsubscribed += 1; }; }
    };
    const elements = { tabs:Array.from(document.querySelectorAll('[data-fault-group]')),
      operationalCount:el('oc'), buildingCount:el('bc'), status:el('status'), list:el('list'), empty:el('empty') };
    window.start = (uid='u1') => window.initHomeFaults({ db:{}, user:{ uid }, stationId:'station-102', sdk, elements });
  });
  await check('renders finite open fields and separates building from operational faults', async () => {
    await page.evaluate(() => {
      window.start();
      window.snapshots.at(-1).ok({ docs:[
        { id:'a', data:() => ({ status:'open', kind:'vehicle', title:'נזילת שמן', vehicle_name:'רכב 7', date:'2026-09-11', severity:'critical' }) },
        { id:'b', data:() => ({ status:'open', kind:'building', title:'נזילה במטבח', date:'2026-09-10', severity:'major' }) },
        { id:'closed', data:() => ({ status:'fixed', kind:'vehicle', title:'סגור' }) }
      ] });
    });
    assert.equal(await page.locator('#oc').textContent(), '1');
    assert.equal(await page.locator('#bc').textContent(), '1');
    assert.equal(await page.locator('.home-fault-title').textContent(), 'נזילת שמן');
    assert.equal(await page.locator('.home-fault-card').getAttribute('data-severity'), 'critical');
    await page.locator('[data-fault-group="building"]').click();
    assert.equal(await page.locator('.home-fault-title').textContent(), 'נזילה במטבח');
  });
  await check('malformed and HTML-looking data never becomes markup', async () => {
    await page.locator('[data-fault-group="operational"]').click();
    await page.evaluate(() => window.snapshots.at(-1).ok({ docs:[
      { id:'x', data:() => ({ status:'open', kind:'vehicle', title:'<img src=x onerror=alert(1)>', vehicle_name:'<b>רכב</b>' }) },
      { id:'blank', data:() => ({ status:'open', title:'   ' }) }
    ] }));
    assert.equal(await page.locator('.home-fault-card img').count(), 0);
    assert.equal(await page.locator('.home-fault-card b').count(), 0);
    assert.match(await page.locator('.home-fault-title').textContent(), /<img/);
  });
  await check('destroy invalidates late snapshots and removes protected content', async () => {
    const prior = await page.evaluate(() => window.snapshots.length - 1);
    await page.evaluate(() => window.destroyHomeFaults());
    assert.equal(await page.locator('.home-fault-card').count(), 0);
    await page.evaluate((i) => window.snapshots[i].ok({ docs:[{ id:'late', data:() => ({ status:'open', title:'אסור להופיע' }) }] }), prior);
    assert.equal(await page.locator('.home-fault-card').count(), 0);
    assert.ok(await page.evaluate(() => window.unsubscribed) >= 1);
  });
  await check('starting a new identity invalidates the old listener', async () => {
    await page.evaluate(() => { window.start('u1'); window.start('u2'); });
    const indexes = await page.evaluate(() => [window.snapshots.length - 2, window.snapshots.length - 1]);
    await page.evaluate(([oldIndex, newIndex]) => {
      window.snapshots[oldIndex].ok({ docs:[{ id:'old', data:() => ({ status:'open', title:'ישן' }) }] });
      window.snapshots[newIndex].ok({ docs:[{ id:'new', data:() => ({ status:'open', title:'חדש' }) }] });
    }, indexes);
    assert.equal(await page.locator('.home-fault-title').textContent(), 'חדש');
  });
  console.log('home faults browser: ' + passed + ' passed');
} finally { await browser.close(); }
