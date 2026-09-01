import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json' };
// המסך עצמו מחשב "היום" לפי שעון ישראל. הבדיקה חייבת להשתמש באותו
// יום, אחרת היא יכולה לעבור או להיכשל רק בגלל חצות ולא בגלל ממשק.
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone:'Asia/Jerusalem', year:'numeric', month:'2-digit', day:'2-digit'
}).format(new Date());
function shiftDay(iso, amount) {
  const date = new Date(iso + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
const yesterday = shiftDay(today, -1);
const tomorrow = shiftDay(today, 1);

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
  }],
  guards_status:'ready',
  guards:[{ id:'g:guard_today', title:'אבטחת אירוע', date:today, hours:'18:00-23:00' }],
  pending_answers:2
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
      people:[{ uid:'stub-uid', person:'אלדד יונה', is_me:me }] }] : [],
    guards_status:'ready', guards:[]
  };
}

const station = {
  mode:'new', active:true, publication_id:'p_live', revision:4,
  previous_day:day(yesterday, '', false),
  day:day(today, 'קורס חילוץ', true),
  next_day:day(tomorrow, '', false)
};
station.day.guards = [
  { id:'g:guard_open', title:'אבטחת כוננות', hours:'18:00-23:00', people:[], includes_me:false },
  { id:'g:guard_staffed', title:'אבטחת צוות', hours:'19:00-22:00',
    people:[{ person:'חבר/ת האבטחה', is_me:false }], includes_me:false }
];
const stationGuardsUnavailable = JSON.parse(JSON.stringify(station));
stationGuardsUnavailable.day.guards_status = 'unavailable';
stationGuardsUnavailable.day.guards = [];
stationGuardsUnavailable.day.sub_stations = [];
stationGuardsUnavailable.day.events = [];
function legacyDay(date, me) {
  return {
    date,
    sub_stations:[{
      sub_station:'legacy_A', label:'משמרת א', minimum:null, below_minimum:false,
      people:[
        { uid:'stub-uid', person:'אלדד יונה', role_label:'צוות א', hours:null, is_me:me },
        { uid:'crew_1', person:'טל חודרה', role_label:'צוות א', hours:null, is_me:false }
      ]
    }],
    events:[]
  };
}
function legacyMine(mode) {
  return {
    mode, active:true, source:'legacy', publication_id:null, revision:null,
    days:[{
      date:today, sub_station:'A', sub_station_label:'משמרת א', role:null,
      role_label:'צוות א', hours:null, shift:'משמרת א', qualifications:[],
      crew:[{ uid:'crew_1', person:'טל חודרה', role_label:'צוות א' }],
      change:null, answer:null, requires_answer:false
    }], events:[], pending_answers:0
  };
}
function legacyStation(mode) {
  return {
    mode, active:true, source:'legacy', publication_id:null, revision:null,
    previous_day:legacyDay(yesterday, false), day:legacyDay(today, true),
    next_day:legacyDay(tomorrow, false)
  };
}
const draftPreview = {
  draft_id:'draft_1', expected_content_digest:'digest_preview_1',
  from:today, to:shiftDay(today, 30), week_start:today,
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
const statusOff = { mode:'off', configured:false, manager:false, active:null };
const statusOffManager = { mode:'off', configured:false, manager:true, active:null };
const statusShadowMember = { mode:'shadow', configured:true, manager:false, active:null };
const statusShadowManager = { mode:'shadow', configured:true, manager:true, active:null };
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
  // המינוי הוא תוספת חיה ונפרדת מהתפקיד הראשי; גם לוחם אש יכול
  // להיות אחראי/ת סידור, ואין הרשאת עריכה אוטומטית למפקד.
  await prepare(manager, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusManager }, { data:statusAfterPublish }, { data:statusAfterRollback }],
    getScheduleManagerSetup:[{ data:setup }],
    getMyScheduleV2:[{ data:mine }, { data:mine }],
    getStationScheduleV2:[{ data:station }],
    runSchedulePlanner:[{ data:{ draft_id:'draft_1', from:today, to:shiftDay(today, 30),
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
    getStationScheduleV2:[{ data:station }, { data:stationGuardsUnavailable }],
    respondToSchedule:[{ data:{ duplicate:false, response_id:'r_1', answer:'confirm' } }]
  });
  const phonePage = await phone.newPage();
  await phonePage.goto(base, { waitUntil:'load' });
  await phonePage.locator('#appMain:not(.hide)').waitFor();

  await test('station schedule is the default mobile view for every member', async () => {
    assert.equal(await phonePage.locator('#stationView').isVisible(), true);
    await phonePage.locator('#stationContent .day').first().waitFor();
    assert.match(await phonePage.locator('#stationContent').textContent(), /אבטחת כוננות/);
    assert.match(await phonePage.locator('#stationContent').textContent(), /טרם אוישה/);
    assert.match(await phonePage.locator('#stationContent').textContent(), /חבר\/ת האבטחה/);
  });

  const direct = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(direct, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusFirefighter }],
    getMyScheduleV2:[{ data:mine }],
    getStationScheduleV2:[{ data:station }]
  });
  const directPage = await direct.newPage();
  await directPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await directPage.locator('#appMain:not(.hide)').waitFor();
  await test('non-manager is sent to the station schedule even through a direct management URL', async () => {
    assert.equal(await directPage.locator('#manageTab').isVisible(), false);
    assert.equal(await directPage.locator('#manageView').isVisible(), false);
    assert.equal(await directPage.locator('#stationView').isVisible(), true);
    await directPage.locator('#stationContent .day').first().waitFor();
  });
  await direct.close();

  await test('personal mobile view remains available after station is the default', async () => {
    await phonePage.locator('[data-tab="mine"]').dispatchEvent('click');
    assert.match(await phonePage.locator('#mineContent').textContent(), /טל חודרה/);
    assert.match(await phonePage.locator('#mineContent').textContent(), /קורס חילוץ/);
    assert.match(await phonePage.locator('#mineContent').textContent(), /אבטחת אירוע/);
    const guard = phonePage.locator('#mineContent .guard-card').filter({ hasText:'אבטחת אירוע' });
    assert.equal(await guard.count(), 1);
    assert.equal(await guard.locator('.confirm,.decline').count(), 0);
    await phonePage.locator('.assignment .confirm').first().dispatchEvent('click');
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
    await phonePage.locator('[data-tab="station"]').dispatchEvent('click');
    await phonePage.locator('#stationContent .day').first().waitFor();
    assert.equal(await phonePage.locator('#stationContent .day').count(), 3);
    assert.match(await phonePage.locator('#stationContent').textContent(), /טל חודרה/);
    assert.match(await phonePage.locator('#stationContent').textContent(), /היום שאחרי/);
    assert.match(await phonePage.locator('#stationContent').textContent(), /לא ניתן לטעון אבטחות כרגע/);
    assert.doesNotMatch(await phonePage.locator('#stationContent').textContent(), /אין סידור ליום הזה/);
  });
  await test('390px and 360px phones have no horizontal overflow and touch controls are large enough', async () => {
    for (const width of [390, 360]) {
      await phonePage.setViewportSize({ width, height:844 });
      const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      const offenders = await phonePage.evaluate(() => Array.from(document.querySelectorAll('body *')).map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag:element.tagName, id:element.id, cls:String(element.className || ''), left:rect.left, right:rect.right, width:rect.width };
      }).filter((item) => item.left < -1 || item.right > innerWidth + 1).slice(0, 8));
      assert.ok(overflow <= 1, width + 'px overflow ' + overflow + ' ' + JSON.stringify(offenders));
      const heights = await phonePage.locator('.tabs button,.nav-day').evaluateAll((nodes) => nodes
        .map((item) => item.getBoundingClientRect().height).filter((height) => height > 0));
      assert.ok(heights.every((height) => height >= 43.5), width + 'px ' + JSON.stringify(heights));
    }
  });
  if (process.env.SCHEDULE_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.SCHEDULE_SCREENSHOT_DIR, { recursive:true });
    await phonePage.screenshot({ path:path.join(process.env.SCHEDULE_SCREENSHOT_DIR, 'schedule-management-mobile.png'), fullPage:true });
  }
  await phone.close();

  const off = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(off, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusOff }],
    getMyScheduleV2:[{ data:legacyMine('off') }],
    getStationScheduleV2:[{ data:legacyStation('off') }]
  });
  const offPage = await off.newPage();
  await offPage.goto(base, { waitUntil:'load' });
  await offPage.locator('#appMain:not(.hide)').waitFor();
  await test('off mode safely shows the legacy station schedule as the default', async () => {
    assert.match(offPage.url(), /schedule-management\.html/);
    assert.equal(await offPage.locator('#availabilityView').isVisible(), false);
    assert.equal(await offPage.locator('#scheduleTabs').isVisible(), true);
    assert.equal(await offPage.locator('#manageTab').isVisible(), false);
    assert.equal(await offPage.locator('#stationView').isVisible(), true);
    await offPage.locator('#stationContent .day').first().waitFor();
    assert.match(await offPage.locator('#stationContent').textContent(), /משמרת א/);
    const calls = await offPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleV2').length, 1);
    assert.equal(calls.some((entry) => entry.name === 'getScheduleManagerSetup'), false);
  });
  await test('off mode keeps the personal legacy view available without an edit response', async () => {
    await offPage.locator('[data-tab="mine"]').click();
    assert.equal(await offPage.locator('#mineView').isVisible(), true);
    assert.match(await offPage.locator('#mineContent').textContent(), /טל חודרה/);
    assert.equal(await offPage.locator('#mineContent .confirm').count(), 0);
    const calls = await offPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.some((entry) => entry.name === 'respondToSchedule'), false);
  });
  await off.close();

  const shadowMember = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(shadowMember, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusShadowMember }],
    getMyScheduleV2:[{ data:legacyMine('shadow') }],
    getStationScheduleV2:[{ data:legacyStation('shadow') }]
  });
  const shadowMemberPage = await shadowMember.newPage();
  await shadowMemberPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await shadowMemberPage.locator('#appMain:not(.hide)').waitFor();
  await test('shadow mode gives a member the station and personal legacy views, never management', async () => {
    assert.equal(await shadowMemberPage.locator('#availabilityView').isVisible(), false);
    assert.equal(await shadowMemberPage.locator('#scheduleTabs').isVisible(), true);
    assert.equal(await shadowMemberPage.locator('#manageTab').isVisible(), false);
    assert.equal(await shadowMemberPage.locator('#manageView').isVisible(), false);
    assert.equal(await shadowMemberPage.locator('#stationView').isVisible(), true);
    await shadowMemberPage.locator('#stationContent .day').first().waitFor();
    await shadowMemberPage.locator('[data-tab="mine"]').click();
    assert.match(await shadowMemberPage.locator('#mineContent').textContent(), /טל חודרה/);
    const calls = await shadowMemberPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleV2').length, 1);
    assert.equal(calls.some((entry) => entry.name === 'getScheduleManagerSetup'), false);
  });
  await shadowMember.close();

  const shadowManager = await browser.newContext({ viewport:{ width:1440, height:1000 }, locale:'he-IL' });
  await prepare(shadowManager, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusShadowManager }],
    getScheduleManagerSetup:[{ data:setup }],
    getMyScheduleV2:[{ data:legacyMine('shadow') }],
    getStationScheduleV2:[{ data:legacyStation('shadow') }]
  });
  const shadowManagerPage = await shadowManager.newPage();
  await shadowManagerPage.goto(base + '?tab=station', { waitUntil:'load' });
  await shadowManagerPage.locator('#appMain:not(.hide)').waitFor();
  await test('an appointed manager retains management in shadow while station remains the default', async () => {
    assert.equal(await shadowManagerPage.locator('#manageTab').isVisible(), true);
    assert.equal(await shadowManagerPage.locator('#mineTab').isVisible(), true);
    assert.equal(await shadowManagerPage.locator('#stationTab').isVisible(), true);
    assert.equal(await shadowManagerPage.locator('#stationView').isVisible(), true);
    await shadowManagerPage.locator('#stationContent .day').first().waitFor();
    await shadowManagerPage.locator('[data-tab="manage"]').click();
    assert.equal(await shadowManagerPage.locator('#manageView').isVisible(), true);
    assert.match(await shadowManagerPage.locator('#sourceSummary').textContent(), /מהדורה 7/);
    const calls = await shadowManagerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleV2').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'getScheduleManagerSetup').length, 1);
  });
  await shadowManager.close();

  const offManager = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(offManager, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusOffManager }],
    getMyScheduleV2:[{ data:legacyMine('off') }],
    getStationScheduleV2:[{ data:legacyStation('off') }]
  });
  const offManagerPage = await offManager.newPage();
  await offManagerPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await offManagerPage.locator('#appMain:not(.hide)').waitFor();
  await test('off mode does not expose management even to an appointed manager', async () => {
    assert.equal(await offManagerPage.locator('#manageTab').isVisible(), false);
    assert.equal(await offManagerPage.locator('#manageView').isVisible(), false);
    assert.equal(await offManagerPage.locator('#stationView').isVisible(), true);
    const calls = await offManagerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.some((entry) => entry.name === 'getScheduleManagerSetup'), false);
  });
  await offManager.close();

  const statusError = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(statusError, 'firefighter', {
    getScheduleRuntimeStatus:[{ reject:true, code:'functions/unavailable', message:'offline' }]
  });
  const statusErrorPage = await statusError.newPage();
  await statusErrorPage.goto(base, { waitUntil:'load' });
  await statusErrorPage.locator('#appMain:not(.hide)').waitFor();
  await test('a status failure remains on a data-free new-page error state', async () => {
    assert.match(statusErrorPage.url(), /schedule-management\.html/);
    assert.equal(await statusErrorPage.locator('#availabilityView').isVisible(), true);
    assert.match(await statusErrorPage.locator('#availabilityText').textContent(), /לא מציגה נתונים ישנים/);
    const calls = await statusErrorPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.some((entry) => entry.name === 'getMyScheduleV2'), false);
    assert.equal(calls.some((entry) => entry.name === 'getStationScheduleV2'), false);
  });
  await statusError.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(passed, 15);
console.log('\n15 schedule management browser checks passed.');
