import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json' };
const today = '2026-08-31';

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'schedule-management.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  response.end(fs.readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/schedule-management.html';

const mine = {
  mode:'new', active:true, publication_id:'p_live', revision:4,
  days:[{
    date:today, sub_station:'main', sub_station_label:'אילת', role:'firefighter',
    role_label:'לוחם', hours:'07:00-07:00', shift:'משמרת א', qualifications:['חובש'],
    crew:[{ uid:'crew_1', person:'טל חודרה', role_label:'נהג' }],
    change:{ kind:'assignment_added', item_id:today }, answer:null, requires_answer:true
  }],
  events:[{
    id:'course_today', title:'קורס חילוץ', date:today, hours:'10:00-12:00',
    change:{ kind:'event_assigned', item_id:'course_today' }, answer:null, requires_answer:true
  }], pending_answers:2
};
const mineAnswered = JSON.parse(JSON.stringify(mine));
mineAnswered.days[0].answer = { status:'confirmed' };
mineAnswered.days[0].requires_answer = false;
mineAnswered.pending_answers = 1;

function day(date, label, me) {
  return {
    date,
    sub_stations:[{
      sub_station:'main', label:'אילת', minimum:2, below_minimum:false,
      people:[
        { uid:'stub-uid', person:'אלדד יונה', role_label:'לוחם', hours:'07:00-07:00', is_me:me },
        { uid:'crew_1', person:'טל חודרה', role_label:'נהג', hours:'07:00-07:00', is_me:false }
      ]
    }],
    events: label ? [{ id:'event_' + date, title:label, hours:'10:00-12:00', includes_me:me,
      people:[{ uid:'stub-uid', person:'אלדד יונה', is_me:me }] }] : []
  };
}

const station = {
  mode:'new', active:true, publication_id:'p_live', revision:4,
  previous_day:day('2026-08-30', '', false),
  day:day(today, 'קורס חילוץ', true),
  next_day:day('2026-09-01', '', false)
};
const draftPreview = {
  draft_id:'draft_1', expected_content_digest:'digest_preview_1',
  from:today, to:'2026-09-30', week_start:today,
  days:Array.from({ length:7 }, (_, index) => {
    const value = new Date(today + 'T00:00:00.000Z');
    value.setUTCDate(value.getUTCDate() + index);
    return day(value.toISOString().slice(0, 10), index === 2 ? 'תרגיל תחנתי' : '', index === 0);
  })
};
const statusManager = { mode:'new', configured:true, manager:true,
  active:{ publication_id:'p_live', revision:4, previous_publication_id:null, can_rollback:false } };
const statusAfterPublish = { mode:'new', configured:true, manager:true,
  active:{ publication_id:'p_new', revision:5, previous_publication_id:'p_live', can_rollback:true } };
const statusAfterRollback = { mode:'new', configured:true, manager:true,
  active:{ publication_id:'p_rollback', revision:6, previous_publication_id:'p_new', can_rollback:true } };
const statusFirefighter = { mode:'new', configured:true, manager:false, active:{ publication_id:'p_live', revision:4 } };
const setup = {
  mode:'new', configured:true,
  policy:{ id:'policy_1', version:'1', digest:'abc', sub_stations:[{
    id:'main', label:'אילת', minimum:2,
    requirements:[{ role:'driver', label:'נהג', count:1, required:true }, { role:'firefighter', label:'לוחם', count:1, required:true }]
  }] },
  source:{ id:'source_1', version:'1', revision:'7' },
  people:[
    { id:'stub-uid', name:'אלדד יונה', sub_station:'main', roles:['firefighter'] },
    { id:'crew_1', name:'טל חודרה', sub_station:'main', roles:['driver','firefighter'] }
  ]
};

async function prepare(context, role, plans) {
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript', body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ roleName, callablePlans }) => {
    window.__SMOKE_ROLE = roleName;
    window.__CALLABLE_PLAN = callablePlans;
  }, { roleName:role, callablePlans:plans });
}

let passed = 0;
async function test(name, fn) {
  await fn(); passed += 1; console.log('✓ ' + name);
}

const browser = await chromium.launch();
try {
  const manager = await browser.newContext({ viewport:{ width:1440, height:1000 }, locale:'he-IL' });
  await prepare(manager, 'commander', {
    getScheduleRuntimeStatus:[{ data:statusManager }, { data:statusAfterPublish }, { data:statusAfterRollback }],
    getScheduleManagerSetup:[{ data:setup }],
    getMyScheduleV2:[{ data:mine }, { data:mine }],
    getStationScheduleV2:[{ data:station }],
    runSchedulePlanner:[{ data:{ draft_id:'draft_1', from:today, to:'2026-09-30',
      summary:{ filled:60, blocking_gaps:0, days_below_minimum:0, rejected_manual:0 } } }],
    getScheduleDraftPreview:[{ data:draftPreview }],
    publishSchedule:[{ data:{ publication_id:'p_new', revision:5, notified_people:2 } }],
    rollbackSchedule:[{ data:{ publication_id:'p_rollback', revision:6, rolled_back_to:'p_live', notified_people:2 } }]
  });
  const managerPage = await manager.newPage();
  managerPage.on('dialog', (dialog) => dialog.accept());
  await managerPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await managerPage.locator('#appMain:not(.hide)').waitFor();

  await test('manager sees the management panel and signed policy', async () => {
    assert.equal(await managerPage.locator('#manageTab').isVisible(), true);
    assert.equal(await managerPage.locator('#manageView').isVisible(), true);
    assert.match(await managerPage.locator('#sourceSummary').textContent(), /מהדורה 7/);
    assert.equal(await managerPage.locator('#policy .policy-row').count(), 3);
  });
  await test('planner creates a draft without publishing it', async () => {
    await managerPage.locator('#runPlanner').click();
    await managerPage.locator('#runMessage .ok').waitFor();
    assert.match(await managerPage.locator('#runMessage').textContent(), /עדיין לא פורסמה/);
    assert.equal(await managerPage.locator('#draftSummary .metric').count(), 4);
    await managerPage.locator('#previewMessage .ok').waitFor();
    assert.equal(await managerPage.locator('#draftPreview .day').count(), 7);
    assert.match(await managerPage.locator('#draftPreview').textContent(), /טל חודרה/);
    assert.equal(await managerPage.locator('#publish').isEnabled(), false);
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS);
    const run = calls.find((entry) => entry.name === 'runSchedulePlanner');
    assert.ok(run);
    assert.equal(Object.hasOwn(run.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(run.payload, 'station_id'), false);
  });
  await test('separate confirmed publish refreshes the live views', async () => {
    await managerPage.locator('#reviewDraft').check();
    assert.equal(await managerPage.locator('#publish').isEnabled(), true);
    await managerPage.locator('#publish').click();
    await managerPage.locator('#publishMessage .ok').waitFor();
    assert.match(await managerPage.locator('#publishMessage').textContent(), /2 עדכונים לשליחה/);
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS);
    const publish = calls.find((entry) => entry.name === 'publishSchedule');
    assert.ok(publish);
    assert.equal(publish.payload.expected_content_digest, 'digest_preview_1');
  });
  await test('rollback is separate, explicit and targets only the immediate previous publication', async () => {
    assert.equal(await managerPage.locator('#rollback').isEnabled(), true);
    await managerPage.locator('#rollback').click();
    await managerPage.locator('#rollbackMessage .ok').waitFor();
    const calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS);
    const rollback = calls.find((entry) => entry.name === 'rollbackSchedule');
    assert.ok(rollback);
    assert.equal(rollback.payload.expected_active_publication_id, 'p_new');
    assert.equal(rollback.payload.target_publication_id, 'p_live');
    assert.equal(rollback.payload.stationId, undefined);
  });
  await manager.close();

  const phone = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(phone, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusFirefighter }],
    getMyScheduleV2:[{ data:mine }, { data:mineAnswered }],
    getStationScheduleV2:[{ data:station }],
    respondToSchedule:[{ data:{ duplicate:false, response_id:'r_1', answer:'confirm' } }]
  });
  const phonePage = await phone.newPage();
  await phonePage.goto(base + '?tab=manage', { waitUntil:'load' });
  await phonePage.locator('#appMain:not(.hide)').waitFor();

  await test('firefighter cannot see management even through a direct URL', async () => {
    assert.equal(await phonePage.locator('#manageTab').isVisible(), false);
    assert.equal(await phonePage.locator('#manageView').isVisible(), false);
    assert.equal(await phonePage.locator('#mineView').isVisible(), true);
  });
  await test('personal mobile view shows crew, event and answer action', async () => {
    assert.match(await phonePage.locator('#mineContent').textContent(), /טל חודרה/);
    assert.match(await phonePage.locator('#mineContent').textContent(), /קורס חילוץ/);
    await phonePage.locator('.assignment .confirm').first().click();
    await phonePage.getByText('אישרתי', { exact:true }).waitFor();
    const response = (await phonePage.evaluate(() => window.__CALLABLE_CALLS))
      .find((entry) => entry.name === 'respondToSchedule');
    assert.equal(response.payload.person, undefined);
    assert.equal(response.payload.stationId, undefined);
    const mineCall = (await phonePage.evaluate(() => window.__CALLABLE_CALLS))
      .find((entry) => entry.name === 'getMyScheduleV2');
    assert.equal(mineCall.payload.date, today);
  });
  await test('station mobile view shows yesterday, today and tomorrow with names', async () => {
    await phonePage.locator('[data-tab="station"]').click();
    await phonePage.locator('#stationContent .day').first().waitFor();
    assert.equal(await phonePage.locator('#stationContent .day').count(), 3);
    assert.match(await phonePage.locator('#stationContent').textContent(), /טל חודרה/);
    assert.match(await phonePage.locator('#stationContent').textContent(), /היום שאחרי/);
  });
  await test('390px phone has no horizontal overflow and touch controls are large enough', async () => {
    const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    const offenders = await phonePage.evaluate(() => Array.from(document.querySelectorAll('body *')).map((element) => {
      const rect = element.getBoundingClientRect();
      return { tag:element.tagName, id:element.id, cls:String(element.className || ''), left:rect.left, right:rect.right, width:rect.width };
    }).filter((item) => item.left < -1 || item.right > innerWidth + 1).slice(0, 8));
    assert.ok(overflow <= 1, 'overflow ' + overflow + ' ' + JSON.stringify(offenders));
    const heights = await phonePage.locator('.tabs button,.nav-day').evaluateAll((nodes) => nodes
      .map((item) => item.getBoundingClientRect().height).filter((height) => height > 0));
    assert.ok(heights.every((height) => height >= 43.5), JSON.stringify(heights));
  });
  if (process.env.SCHEDULE_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.SCHEDULE_SCREENSHOT_DIR, { recursive:true });
    await phonePage.screenshot({ path:path.join(process.env.SCHEDULE_SCREENSHOT_DIR, 'schedule-management-mobile.png'), fullPage:true });
  }
  await phone.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(passed, 8);
console.log('\n8 schedule management browser checks passed.');
