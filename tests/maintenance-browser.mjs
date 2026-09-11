import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let source = fs.readFileSync(path.join(root, 'maintenance-client.js'), 'utf8')
  .replace(/export function createMaintenanceUi/, 'function createMaintenanceUi')
  .replace(/export const MAINTENANCE_MODES[^;]+;/, '')
  .replace(/export const MAINTENANCE_RUNBOOK_LABELS[^;]+;/, '')
  + '\nwindow.createMaintenanceUi=createMaintenanceUi;window.RUNBOOK_HE=RUNBOOK_HE;';
let passed = 0;
async function check(name, run) { await run(); passed += 1; console.log('PASS ' + name); }

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(`<div id="modeBadge"></div><button id="mode"></button><button id="refresh"></button><button id="analyze"></button><div id="message"></div><div id="operationalCard"><b id="operationalState"></b></div><div id="healthCard"><b id="healthState"></b></div><div id="freshnessCard"><b id="freshnessState"></b></div><div id="platformCard"><b id="platformState"></b></div><b id="p0"></b><b id="p1"></b><b id="p2"></b><b id="open"></b><b id="dropped"></b><b id="heartbeat"></b><div id="list"></div>`);
  await page.addScriptTag({ content:source });
  await page.evaluate(() => {
    const byId = (id) => document.getElementById(id);
    window.fixture = { calls:[], identity:{ uid:'super-a', epoch:1, super:true }, lost:0 };
    const elements = { modeBadge:byId('modeBadge'), mode:byId('mode'), refresh:byId('refresh'), analyze:byId('analyze'),
      message:byId('message'), p0:byId('p0'), p1:byId('p1'), p2:byId('p2'), open:byId('open'),
      dropped:byId('dropped'), heartbeat:byId('heartbeat'), list:byId('list'),
      operationalState:byId('operationalState'), healthState:byId('healthState'), freshnessState:byId('freshnessState'),
      platformState:byId('platformState'), operationalCard:byId('operationalCard'), healthCard:byId('healthCard'),
      freshnessCard:byId('freshnessCard'), platformCard:byId('platformCard') };
    window.ui = window.createMaintenanceUi({ elements,
      currentIdentity:() => window.fixture.identity,
      onIdentityLost:() => { window.fixture.lost += 1; },
      call:async (name, data) => {
        window.fixture.calls.push({ name, data });
        if (window.fixture.hold) return new Promise((resolve) => { window.fixture.release=resolve; });
        return window.fixture.next || {};
      }
    });
  });
  await check('all finite diagnosis runbooks have a Hebrew label', async () => {
    const labels = await page.evaluate(() => Object.keys(window.RUNBOOK_HE));
    assert.deepEqual(labels.sort(), [
      'CHECK_SERVICE_AVAILABILITY','ESCALATE_DATA_INTEGRITY_MANUAL','MONITOR_CLIENT_ERRORS',
      'REBUILD_EMPLOYEE_INDEX_DRY_RUN','REVIEW_AUTH_CONFIGURATION','REVIEW_BACKUP_QUARANTINE',
      'REVIEW_RUNTIME_MODE',
      'REVIEW_CAPACITY','REVIEW_COLLECTION_GROWTH','REVIEW_DOCUMENT_SIZES','REVIEW_MAIL_QUEUE',
      'REVIEW_SCHEDULER_EXECUTION','WAIT_AND_RECHECK'
    ].sort());
  });
  await check('unknown runbook fails closed to an explicit manual-review label', async () => {
    await page.evaluate(() => window.ui.render({ mode:'OFF', counts:{}, items:[{
      severity:'P2', title_code:'תקלה', runbook_code:'FUTURE_CODE', count:1
    }] }));
    assert.equal(await page.locator('.maintenance-runbook').textContent(), 'קוד טיפול לא מוכר — נדרשת בדיקה ידנית');
  });
  await check('phase one renders only OFF or OBSERVE and sends CAS revision', async () => {
    await page.evaluate(() => {
      window.ui.render({ mode:'OFF', config_revision:7, counts:{}, items:[] });
      return window.ui.setMode('OBSERVE');
    });
    assert.deepEqual(await page.evaluate(() => window.fixture.calls.at(-1)), {
      name:'setMaintenanceMode', data:{ mode:'OBSERVE', expected_revision:7 }
    });
    assert.equal(await page.locator('#mode').textContent(), 'הפעל תצפית');
  });
  await check('unknown mode fails closed to OFF', async () => {
    await page.evaluate(() => window.ui.render({ mode:'SUGGEST', counts:{}, items:[] }));
    assert.equal(await page.locator('#modeBadge').textContent(), 'כבוי');
  });
  await check('operating mode, technical health and freshness render independently', async () => {
    await page.evaluate(() => window.ui.render({ mode:'OBSERVE', operational_state:'SILENT',
      health_state:'HEALTHY', health_freshness:'FRESH', platform_state:'AVAILABLE', counts:{}, items:[] }));
    assert.equal(await page.locator('#operationalState').textContent(), 'ניסוי / שקט');
    assert.equal(await page.locator('#healthState').textContent(), 'תקינה');
    assert.equal(await page.locator('#freshnessState').textContent(), 'עדכנית');
    assert.equal(await page.locator('#platformState').textContent(), 'זמינה');
    assert.equal(await page.locator('#operationalCard').getAttribute('data-state'), 'silent');
    assert.equal(await page.locator('#healthCard').getAttribute('data-state'), 'healthy');
    assert.equal(await page.locator('#platformCard').getAttribute('data-state'), 'available');
  });
  await check('unknown status values fail closed instead of appearing healthy', async () => {
    await page.evaluate(() => window.ui.render({ mode:'OFF', operational_state:'FUTURE',
      health_state:'FUTURE', health_freshness:'FUTURE', platform_state:'FUTURE', counts:{}, items:[] }));
    assert.equal(await page.locator('#operationalState').textContent(), 'לא ידוע');
    assert.equal(await page.locator('#healthState').textContent(), 'לא ידוע');
    assert.equal(await page.locator('#freshnessState').textContent(), 'חסרה');
    assert.equal(await page.locator('#platformState').textContent(), 'אין עדיין ראיה');
  });
  await check('identity change fences an in-flight response', async () => {
    await page.evaluate(() => {
      window.fixture.calls.length=0;
      window.fixture.next={ mode:'OBSERVE', config_revision:2, counts:{}, items:[] };
      window.fixture.hold=true;
      window.pending=window.ui.refresh();
    });
    const prior = await page.locator('#modeBadge').textContent();
    await page.evaluate(() => {
      window.fixture.identity={ uid:'super-b', epoch:2, super:true };
      window.fixture.hold=false; window.fixture.release(window.fixture.next);
    });
    await page.evaluate(() => window.pending);
    assert.equal(await page.locator('#modeBadge').textContent(), prior);
    assert.equal(await page.evaluate(() => window.fixture.lost), 1);
  });
  await check('token invalidation clears rendered data and cancels an old response without redirect', async () => {
    await page.evaluate(() => {
      window.fixture.lost=0; window.fixture.hold=true;
      window.ui.render({ mode:'OBSERVE', counts:{P0:3,open:7,dropped:1}, last_health_at:'2026-09-10T03:00:00.000Z', items:[{severity:'P0',title_code:'ישן',runbook_code:'WAIT_AND_RECHECK',count:1}] });
      window.pending=window.ui.refresh();
    });
    await page.evaluate(() => window.ui.invalidate());
    assert.deepEqual(await page.locator('#p0,#open,#dropped').allTextContents(), ['0','0','0']);
    assert.equal(await page.locator('#list').textContent(), '');
    await page.evaluate(() => { window.fixture.hold=false; window.fixture.release({mode:'OBSERVE',counts:{P0:9},items:[]}); });
    await page.evaluate(() => window.pending);
    assert.equal(await page.locator('#p0').textContent(), '0');
    assert.equal(await page.evaluate(() => window.fixture.lost), 0);
  });
} finally { await browser.close(); }
console.log('maintenance browser: ' + passed + ' passed');
