import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const adminSource = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const requiredHooks = [
  'transferSearch', 'transferResults', 'transferTarget',
  'transferCreate', 'transferIncoming', 'transferOutgoing',
  'transferOutgoingRefresh'
];
const missingHooks = requiredHooks.filter((id) =>
  !new RegExp('id=["\\\']' + id + '["\\\']').test(adminSource));

// The contract is written before the UI on purpose.  An absent UI is not a
// passing empty-page test: it is an explicit NOT RUN until the implementation
// exposes the agreed hooks above.
if (missingHooks.length) {
  console.error('NOT RUN: admin transfer UI hooks are missing: ' + missingHooks.join(', '));
  process.exit(2);
}

const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json'
};
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'admin.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  response.end(fs.readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/admin.html';

async function prepare(context, role, plans) {
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ roleName, callablePlans }) => {
    window.__SMOKE_ROLE = roleName;
    window.__CALLABLE_PLAN = callablePlans;
  }, { roleName:role, callablePlans:plans });
}

async function waitForCall(page, name, count = 1) {
  await page.waitForFunction(({ callable, wanted }) =>
    (window.__CALLABLE_CALLS || []).filter((entry) => entry.name === callable).length >= wanted,
  { callable:name, wanted:count });
  return (await page.evaluate(() => window.__CALLABLE_CALLS || []))
    .filter((entry) => entry.name === name);
}

async function selectCandidate(page, uid) {
  const byData = page.locator('#transferResults [data-transfer-uid="' + uid + '"]');
  if (await byData.count()) {
    await byData.first().dispatchEvent('click');
    return;
  }
  const radio = page.locator('#transferResults input[value="' + uid + '"]');
  if (await radio.count()) {
    await radio.first().check();
    return;
  }
  const picker = page.locator('#transferResults select').first();
  if (await picker.count()) {
    await picker.selectOption(uid);
    return;
  }
  assert.fail('candidate ' + uid + ' has no UID-bound selection control');
}

function decisionButton(page, requestId, decision) {
  const attribute = decision === 'approve' ? 'data-transfer-approve' : 'data-transfer-reject';
  return page.locator('#transferIncoming [' + attribute + '="' + requestId + '"]').first();
}

const candidates = [
  { uid:'uid-dana-a', full_name:'דנה לוי', role:'firefighter',
    employee_number:'71', shift:'A', station_id:'eilat_102' },
  { uid:'uid-dana-b', full_name:'דנה לוי', role:'team_leader',
    employee_number:'83', shift:'B', station_id:'eilat_102' }
];
// These two targets intentionally do not exist in the static stations.js
// fixture. Their appearance in the select therefore proves that the browser
// consumes the server-authorised catalog rather than a bundled client list.
const targets = [
  { station_id:'beer_sheva_101', name:'תחנת באר שבע — יעד שרת' },
  { station_id:'ashkelon_104', name:'תחנת אשקלון — יעד שרת' }
];
const outgoingPending = {
  request_id:'transfer-out-1', status:'pending_target', target_uid:'uid-dana-b',
  full_name:'דנה לוי', role:'team_leader', shift:'B',
  source_station_id:'eilat_102', target_station_id:'beer_sheva_101',
  revision:1
};
const outgoingProcessing = {
  request_id:'transfer-out-processing', status:'processing', target_uid:'uid-other',
  full_name:'יובל כהן', role:'firefighter', shift:'A',
  source_station_id:'eilat_102', target_station_id:'ashkelon_104',
  revision:2
};
const outgoingRecovery = {
  request_id:'transfer-out-recovery', status:'needs_recovery', target_uid:'uid-recovery',
  full_name:'רוני לוי', role:'firefighter', shift:'C',
  source_station_id:'eilat_102', target_station_id:'ashkelon_104',
  revision:3
};
const incomingApprove = {
  request_id:'transfer-in-approve', status:'pending_target', target_uid:'uid-noa',
  full_name:'נועה כהן', role:'firefighter', shift:'A',
  source_station_id:'beer_sheva_101', target_station_id:'eilat_102',
  revision:1
};
const incomingReject = {
  request_id:'transfer-in-reject', status:'pending_target', target_uid:'uid-ron',
  full_name:'רון לוי', role:'team_leader', shift:'B',
  source_station_id:'ashkelon_104', target_station_id:'eilat_102',
  revision:1
};
const incomingProcessing = {
  request_id:'transfer-in-processing', status:'processing', target_uid:'uid-processing',
  full_name:'עובד בתהליך', role:'firefighter', shift:'C',
  source_station_id:'beer_sheva_101', target_station_id:'eilat_102',
  revision:2
};
const incomingRecovery = {
  request_id:'transfer-in-recovery', status:'needs_recovery', target_uid:'uid-recovery',
  full_name:'עובד להשלמה', role:'firefighter', shift:'B',
  source_station_id:'beer_sheva_101', target_station_id:'eilat_102',
  revision:3
};
const incomingTerminal = ['cancelled', 'rejected', 'completed'].map((status, index) => ({
  request_id:'transfer-in-' + status, status, target_uid:'uid-' + status,
  full_name:'עובד ' + status, role:'firefighter', shift:'A',
  source_station_id:'ashkelon_104', target_station_id:'eilat_102',
  revision:4 + index
}));

let passed = 0;
async function test(name, fn) {
  await fn(); passed += 1; console.log('✓ ' + name);
}

const browser = await chromium.launch();
try {
  const hr = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(hr, 'hr', {
    getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }],
    getScheduleManagerAccess:[{ data:{ members:[] } }],
    listStationTransfers:[
      { data:{ ok:true, direction:'incoming', transfers:[], targets } },
      { data:{ ok:true, direction:'outgoing', transfers:[], targets } },
      { data:{ ok:true, direction:'outgoing',
        transfers:[outgoingPending, outgoingProcessing, outgoingRecovery], targets } },
      { data:{ ok:true, direction:'outgoing', transfers:[], targets } }
    ],
    searchStationTransferCandidates:[{ data:{ ok:true, people:candidates, targets } }],
    createStationTransfer:[{ data:{
      ok:true, changed:true, request_id:'transfer-out-1', status:'pending_target',
      target_uid:'uid-dana-b', source_station_id:'eilat_102',
      target_station_id:'beer_sheva_101'
    } }],
    cancelStationTransfer:[{ data:{
      ok:true, changed:true, request_id:'transfer-out-1', status:'cancelled'
    } }]
  });
  const hrPage = await hr.newPage();
  hrPage.on('dialog', (dialog) => dialog.accept());
  await hrPage.goto(base, { waitUntil:'load' });
  await hrPage.locator('#work:not(.hide)').waitFor();
  const initialLists = await waitForCall(hrPage, 'listStationTransfers', 2);
  assert.deepEqual(initialLists.map((entry) => entry.payload), [
    { direction:'incoming' }, { direction:'outgoing' }
  ]);
  await hrPage.locator('#transferTarget option[value="beer_sheva_101"]')
    .waitFor({ state:'attached' });

  await test('server targets and duplicate names remain separate UID-bound choices', async () => {
    assert.equal(await hrPage.locator('#transferTarget option[value="beer_sheva_101"]')
      .textContent(), 'תחנת באר שבע — יעד שרת');
    await hrPage.locator('#transferSearch').fill('דנה לוי');
    await hrPage.locator('#transferSearch').press('Enter');
    const searches = await waitForCall(hrPage, 'searchStationTransferCandidates');
    assert.deepEqual(searches.at(-1).payload, { name:'דנה לוי' });
    await hrPage.waitForFunction(() =>
      (document.getElementById('transferResults')?.textContent.match(/דנה לוי/g) || []).length === 2);
    const text = await hrPage.locator('#transferResults').textContent();
    assert.equal((text.match(/דנה לוי/g) || []).length, 2);
    assert.doesNotMatch(text, /@|050-/);
    await selectCandidate(hrPage, 'uid-dana-b');
  });

  await test('create stays pending, appears in outgoing, and cancel refreshes without direct writes', async () => {
    await hrPage.locator('#transferTarget').selectOption('beer_sheva_101');
    await hrPage.locator('#transferCreate').dispatchEvent('click');
    const creates = await waitForCall(hrPage, 'createStationTransfer');
    const payload = creates.at(-1).payload || {};
    assert.equal(payload.target_uid, 'uid-dana-b');
    assert.equal(payload.target_station_id, 'beer_sheva_101');
    assert.match(String(payload.request_id || ''), /^transfer-[A-Za-z0-9_-]{16,100}$/);
    assert.deepEqual(Object.keys(payload).sort(), [
      'request_id', 'target_station_id', 'target_uid'
    ]);
    await hrPage.waitForFunction(() => /ממתינ/.test(document.body.textContent || ''));
    await waitForCall(hrPage, 'listStationTransfers', 3);
    const cancel = hrPage.locator(
      '#transferOutgoing [data-transfer-cancel="transfer-out-1"]');
    await cancel.waitFor();
    assert.equal(await hrPage.locator('#transferOutgoing [data-transfer-cancel]').count(), 1,
      'only pending_target may expose cancel');
    for (const requestId of ['transfer-out-processing', 'transfer-out-recovery']) {
      assert.equal(await hrPage.locator(
        '#transferOutgoing [data-transfer-request="' + requestId + '"] button').count(), 0,
      requestId + ' exposed an action');
    }
    assert.match(await hrPage.locator('#transferOutgoing').textContent(),
      /דנה לוי.*תחנת באר שבע — יעד שרת.*ממתינה/s);
    await cancel.dispatchEvent('click');
    const cancellations = await waitForCall(hrPage, 'cancelStationTransfer');
    assert.deepEqual(cancellations.at(-1).payload, { request_id:'transfer-out-1' });
    await waitForCall(hrPage, 'listStationTransfers', 4);
    await hrPage.waitForFunction(() =>
      /אין בקשות העברה פעילות/.test(
        document.getElementById('transferOutgoing')?.textContent || ''));
    const calls = await hrPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.some((entry) => entry.name === 'decideStationTransfer'), false);
    assert.equal(calls.some((entry) => entry.name === 'setUserRole'), false);
    const writes = await hrPage.evaluate(() => window.__FIRESTORE_WRITES || []);
    assert.equal(writes.length, 0, 'creating a request must not write identity data in the browser');
  });

  await test('the transfer controls fit a 390px phone without horizontal overflow', async () => {
    const overflow = await hrPage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    const offenders = await hrPage.evaluate(() => Array.from(document.querySelectorAll('body *'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag:element.tagName, id:element.id, left:rect.left, right:rect.right, width:rect.width };
      }).filter((item) => item.left < -1 || item.right > innerWidth + 1).slice(0, 8));
    assert.ok(overflow <= 1, '390px overflow ' + overflow + ' ' + JSON.stringify(offenders));
    const heights = await hrPage.locator(
      '#transferSearch,#transferTarget,#transferCreate,#transferOutgoingRefresh')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height)
        .filter((height) => height > 0));
    assert.equal(heights.length, 4);
    assert.ok(heights.every((height) => height >= 43.5), JSON.stringify(heights));
  });
  await hr.close();

  async function runDecision(role, request, decision, status) {
    const context = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
    await prepare(context, role, {
      getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }],
      listStationTransfers:[
        { data:{ ok:true, direction:'incoming',
          transfers:[request, incomingProcessing], targets } },
        { data:{ ok:true, direction:'incoming', transfers:[incomingProcessing], targets } }
      ],
      decideStationTransfer:[{ data:{
        ok:true, changed:true, request_id:request.request_id, status
      } }]
    });
    const page = await context.newPage();
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(base, { waitUntil:'load' });
    await page.locator('#work:not(.hide)').waitFor();
    await waitForCall(page, 'listStationTransfers');
    assert.equal(await page.locator('#transferSourcePanel').isVisible(), false);
    assert.equal(await page.locator('#transferOutgoingPanel').isVisible(), false);
    await page.waitForFunction((id) =>
      (document.getElementById('transferIncoming')?.textContent || '').includes(id), request.full_name);
    assert.equal(await page.locator(
      '#transferIncoming [data-transfer-request="transfer-in-processing"] button').count(), 0,
    'processing incoming request exposed approve/reject');
    const button = decisionButton(page, request.request_id, decision);
    assert.equal(await button.count(), 1);
    await button.dispatchEvent('click');
    const decisions = await waitForCall(page, 'decideStationTransfer');
    const payload = decisions.at(-1).payload || {};
    assert.equal(payload.request_id, request.request_id);
    assert.equal(payload.decision, decision);
    if (decision === 'reject') {
      assert.equal(payload.reason_code, 'not_accepted');
      assert.deepEqual(Object.keys(payload).sort(), ['decision', 'reason_code', 'request_id']);
    } else {
      assert.deepEqual(Object.keys(payload).sort(), ['decision', 'request_id']);
    }
    await waitForCall(page, 'listStationTransfers', 2);
    await page.waitForFunction((requestId) =>
      !document.querySelector(
        '#transferIncoming [data-transfer-request="' + requestId + '"]'), request.request_id);
    assert.equal(await page.locator(
      '#transferIncoming [data-transfer-request="transfer-in-processing"] button').count(), 0);
    await context.close();
  }

  await test('a live target-station commander can approve an incoming pending request only', async () => {
    await runDecision('stcmd', incomingApprove, 'approve', 'approved');
  });
  await test('a live target-station commander can reject an incoming pending request', async () => {
    await runDecision('stcmd', incomingReject, 'reject', 'rejected');
  });

  await test('target recovery retries once, refreshes, and terminal states expose no actions', async () => {
    const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
    await prepare(context, 'stcmd', {
      getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }],
      listStationTransfers:[
        { data:{ ok:true, direction:'incoming',
          transfers:[incomingRecovery, incomingProcessing, ...incomingTerminal], targets } },
        { data:{ ok:true, direction:'incoming',
          transfers:[incomingProcessing, ...incomingTerminal], targets } }
      ],
      decideStationTransfer:[{ delay:60, data:{
        ok:true, changed:true, request_id:incomingRecovery.request_id, status:'completed'
      } }]
    });
    const page = await context.newPage();
    await page.goto(base, { waitUntil:'load' });
    await page.locator('#work:not(.hide)').waitFor();
    await waitForCall(page, 'listStationTransfers');
    const retry = page.locator(
      '#transferIncoming [data-transfer-retry="transfer-in-recovery"]');
    await retry.waitFor();
    assert.match(await retry.textContent(), /השלם העברה.*נסה שוב/);
    for (const requestId of [
      'transfer-in-processing', 'transfer-in-cancelled',
      'transfer-in-rejected', 'transfer-in-completed'
    ]) {
      assert.equal(await page.locator(
        '#transferIncoming [data-transfer-request="' + requestId + '"] button').count(), 0,
      requestId + ' exposed an action');
    }
    await page.evaluate(() => {
      const button = document.querySelector(
        '#transferIncoming [data-transfer-retry="transfer-in-recovery"]');
      button.onclick(); button.onclick();
    });
    await waitForCall(page, 'decideStationTransfer');
    await waitForCall(page, 'listStationTransfers', 2);
    const decisions = await page.evaluate(() => (window.__CALLABLE_CALLS || [])
      .filter((entry) => entry.name === 'decideStationTransfer'));
    assert.equal(decisions.length, 1, 'double retry sent more than one decision');
    assert.deepEqual(decisions[0].payload, {
      request_id:'transfer-in-recovery', decision:'approve'
    });
    await page.waitForFunction(() =>
      !document.querySelector(
        '#transferIncoming [data-transfer-request="transfer-in-recovery"]'));
    await context.close();
  });

  await test('a stale recovery response cannot update or refresh after identity changes', async () => {
    const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
    await prepare(context, 'stcmd', {
      getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }],
      listStationTransfers:[{ data:{ ok:true, direction:'incoming',
        transfers:[incomingRecovery], targets } }],
      decideStationTransfer:[{ delay:160, data:{
        ok:true, changed:true, request_id:incomingRecovery.request_id, status:'completed'
      } }]
    });
    const page = await context.newPage();
    await page.goto(base, { waitUntil:'load' });
    await page.locator('#work:not(.hide)').waitFor();
    await waitForCall(page, 'listStationTransfers');
    const retry = page.locator(
      '#transferIncoming [data-transfer-retry="transfer-in-recovery"]');
    await retry.waitFor();
    await retry.dispatchEvent('click');
    await waitForCall(page, 'decideStationTransfer');
    await page.evaluate(() => window.__SMOKE_EMIT_AUTH('firefighter', 'new-firefighter'));
    await page.waitForFunction(() =>
      document.getElementById('stationTransferCard')?.classList.contains('hide'));
    await page.waitForTimeout(220);
    const calls = await page.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.filter((entry) => entry.name === 'decideStationTransfer').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'listStationTransfers').length, 1,
      'stale response refreshed data for the new identity');
    assert.equal(await page.locator('#transferIncomingMsg').textContent(), '');
    assert.equal(await page.locator(
      '#transferIncoming [data-transfer-request="transfer-in-recovery"]').count(), 0);
    await context.close();
  });

  await test('firefighter and shift commander have no transfer controls or calls', async () => {
    for (const role of ['firefighter', 'commander']) {
      const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
      await prepare(context, role, {
        getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }]
      });
      const page = await context.newPage();
      await page.goto(base, { waitUntil:'load' });
      await page.waitForFunction(() =>
        !!document.querySelector('#work:not(.hide), #denyCard:not(.hide)'));
      for (const id of ['transferSearch', 'transferResults', 'transferTarget', 'transferCreate', 'transferIncoming']) {
        assert.equal(await page.locator('#' + id).isVisible(), false, id + ' visible to ' + role);
      }
      assert.equal(await page.locator('#transferOutgoingPanel').isVisible(), false,
        'outgoing visible to ' + role);
      const calls = await page.evaluate(() => window.__CALLABLE_CALLS || []);
      for (const name of ['searchStationTransferCandidates', 'createStationTransfer',
        'listStationTransfers', 'decideStationTransfer', 'cancelStationTransfer']) {
        assert.equal(calls.some((entry) => entry.name === name), false,
          role + ' called ' + name);
      }
      await context.close();
    }
  });

  await test('an explicit empty server target catalog fails closed without a static fallback', async () => {
    const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
    await prepare(context, 'hr', {
      getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }],
      getScheduleManagerAccess:[{ data:{ members:[] } }],
      listStationTransfers:[
        { data:{ ok:true, direction:'incoming', transfers:[], targets:[] } },
        { data:{ ok:true, direction:'outgoing', transfers:[], targets:[] } }
      ],
      searchStationTransferCandidates:[{ data:{ ok:true, people:candidates, targets:[] } }]
    });
    const page = await context.newPage();
    await page.goto(base, { waitUntil:'load' });
    await page.locator('#work:not(.hide)').waitFor();
    await waitForCall(page, 'listStationTransfers', 2);
    await page.locator('#transferSearch').fill('דנה לוי');
    await page.locator('#transferSearch').press('Enter');
    await waitForCall(page, 'searchStationTransferCandidates');
    await page.locator('#transferResults [data-transfer-uid="uid-dana-b"]')
      .waitFor({ state:'attached' });
    await selectCandidate(page, 'uid-dana-b');
    const options = await page.locator('#transferTarget option').evaluateAll((nodes) =>
      nodes.map((node) => ({ value:node.value, text:node.textContent })));
    assert.deepEqual(options, [{
      value:'', text:'אין כרגע תחנת יעד פעילה שהשרת אישר'
    }]);
    assert.equal(await page.locator('#transferCreate').isDisabled(), true);
    const calls = await page.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.some((entry) => entry.name === 'createStationTransfer'), false);
    await context.close();
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(passed, 9);
console.log('\n9 station-transfer browser checks passed.');
