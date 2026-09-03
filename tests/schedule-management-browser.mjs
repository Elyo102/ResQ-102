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
// רצועת חודש. אותו מבנה יום בדיוק כמו בתצוגת היום, רק בטווח —
// כי `getStationScheduleRange` בונה את הימים מאותו `dayBlock` בשרת.
function monthRange(anchor) {
  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { from: anchor.slice(0, 7) + '-01', to: anchor.slice(0, 7) + '-' + pad(last), last };
}
function rangeDays(anchor, decorate) {
  const bounds = monthRange(anchor);
  const out = [];
  for (let index = 1; index <= bounds.last; index++) {
    out.push(decorate(anchor.slice(0, 7) + '-' + String(index).padStart(2, '0')));
  }
  return out;
}
const stationRange = {
  mode:'new', active:true, source:'v2', publication_id:'p_live', revision:4,
  from:monthRange(today).from, to:monthRange(today).to,
  days:rangeDays(today, (date) => day(date, date === today ? 'קורס חילוץ' : '', date === today))
};
stationRange.days.find((item) => item.date === today).guards = [
  { id:'g:guard_open', title:'אבטחת כוננות', hours:'18:00-23:00', people:[], includes_me:false },
  { id:'g:guard_staffed', title:'אבטחת צוות', hours:'19:00-22:00',
    people:[{ person:'חבר/ת האבטחה', is_me:false }], includes_me:false }
];
const stationRangeGuardsUnavailable = JSON.parse(JSON.stringify(stationRange));
stationRangeGuardsUnavailable.days.forEach((item) => {
  item.guards_status = 'unavailable'; item.guards = [];
});
function legacyRange(mode) {
  return {
    mode, active:true, source:'legacy', publication_id:null, revision:null,
    from:monthRange(today).from, to:monthRange(today).to,
    days:rangeDays(today, (date) => legacyDay(date, date === today))
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
// תוצאות נתיב הכתיבה של חוקי התחנה. הצורה היא בדיוק זו שהשרת
// מחזיר: הפרשים, החלשות ואזהרות — ולעולם לא מסמך המדיניות עצמו,
// שהוא הדבר שעליו חותמים.
const policyWeakening = {
  kind:'updated', policy_id:'policy_2', version:'v2', digest:'d2', content_key:'k2',
  mode:'new', active_policy_id:'policy_1',
  changes:[{ kind:'minimum', sub_station:'main', from:2, to:1, weakens:true }],
  weakening:[{ kind:'minimum', sub_station:'main', from:2, to:1, weakens:true }],
  warnings:[]
};
const policySaved = Object.assign({}, policyWeakening, {
  duplicate:false, written:true, activated:true
});
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
  policy:{ id:'policy_1', active_policy_id:'policy_1', version:'v1', digest:'abc',
    rest:{ min_gap_days:2 }, rotation:null, max_shifts_per_month:12,
    sub_stations:[{
      id:'main', label:'אילת', minimum:2,
      requirements:[{ role:'driver', label:'נהג', count:1, required:true }, { role:'firefighter', label:'לוחם', count:1, required:true }]
    }] },
  source:{ id:'source_1', version:'1', revision:'7' },
  people:[
    { id:'stub-uid', name:'אלדד יונה', sub_station:'main', roles:['firefighter'] },
    { id:'crew_1', name:'טל חודרה', sub_station:'main', roles:['driver','firefighter'] }
  ]
};

const setupAfterSave = JSON.parse(JSON.stringify(setup));
setupAfterSave.policy.active_policy_id = 'policy_2';
setupAfterSave.policy.id = 'policy_2';
setupAfterSave.policy.version = 'v2';
setupAfterSave.policy.sub_stations[0].minimum = 1;

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
    getScheduleManagerSetup:[{ data:setup }, { data:setupAfterSave }],
    previewSchedulePolicy:[{ data:policyWeakening }, { data:policyWeakening }],
    saveSchedulePolicy:[{ data:policySaved }],
    getMyScheduleV2:[{ data:mine }, { data:mine }],
    getStationScheduleRange:[{ data:stationRange }, { data:stationRange }, { data:stationRange }, { data:stationRange }],
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
    // שני תפקידים + קו מינימום + ימי מנוחה. כל אחד מהם ערך שהתחנה
    // קובעת, ולכן כל אחד מהם צעד נפרד ולא טקסט לקריאה.
    assert.equal(await managerPage.locator('#policySteps .step').count(), 4);
    // ⭐ אחראי/ת סידור אינו/ה מקבל/ת את מתג המנוע. השרת אומר
    // may_change:false, והמסך מציית — הוא אינו מחליט בעצמו.
    assert.equal(await managerPage.locator('#modeCard').isVisible(), false);
    assert.equal(await managerPage.locator('#policySteps .step.min').count(), 1);
    // בלי שינוי אין מה לשמור.
    assert.equal(await managerPage.locator('#savePolicy').isEnabled(), false);
  });
  await test('a value that was never set blocks saving instead of becoming zero', async () => {
    const duty = managerPage.locator('#policySteps .step .duty').first();
    assert.equal(await duty.textContent(), 'חובה');
    await duty.click();
    assert.equal(await duty.textContent(), 'רשות');
    // שינוי אמיתי — יש מה לשמור.
    assert.equal(await managerPage.locator('#savePolicy').isEnabled(), true);
    await duty.click();
    // ⭐ „לא סימנו" אינו „רשות", ולכן הוא מצב שלישי שחוסם שמירה.
    assert.equal(await duty.textContent(), '—');
    assert.equal(await managerPage.locator('#savePolicy').isEnabled(), false);
    assert.match(await managerPage.locator('#policyMessage').textContent(), /ערך חסר אינו אפס/);
    await duty.click();
    assert.equal(await duty.textContent(), 'חובה');
  });

  await test('lowering the minimum line is refused until a person confirms it', async () => {
    const minStep = managerPage.locator('#policySteps .step.min');
    assert.equal(await minStep.locator('.n').textContent(), '2');
    await minStep.locator('button').first().click();
    assert.equal(await minStep.locator('.n').textContent(), '1');

    await managerPage.locator('#savePolicy').click();
    await managerPage.locator('#policyMessage .warn').waitFor();
    assert.match(await managerPage.locator('#policyMessage').textContent(), /מקל על התקן/);
    assert.equal(await managerPage.locator('#policyChanges .change.weak').count(), 1);
    let calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS);
    assert.equal(calls.some((entry) => entry.name === 'saveSchedulePolicy'), false);

    await managerPage.locator('#confirmWeakening').check();
    await managerPage.locator('#savePolicy').click();
    await managerPage.locator('#policyMessage .ok').waitFor();
    assert.match(await managerPage.locator('#policyMessage').textContent(), /נשמרו כגרסה v2/);
    // שמירת חוקים אינה נוגעת בסידור שכבר פורסם.
    assert.match(await managerPage.locator('#policyMessage').textContent(), /אינה משנה סידור שכבר פורסם/);

    calls = await managerPage.evaluate(() => window.__CALLABLE_CALLS);
    const save = calls.find((entry) => entry.name === 'saveSchedulePolicy');
    assert.ok(save);
    assert.equal(save.payload.activate, true);
    assert.equal(save.payload.confirm_weakening, true);
    // ⭐ המסך שולח את מה שהוא ראה. בלי זה שתי לשוניות דורסות זו את זו.
    assert.equal(save.payload.expected_policy_id, 'policy_1');
    assert.equal(Object.hasOwn(save.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(save.payload, 'station_id'), false);
    assert.equal(save.payload.draft.sub_stations.main.minimum, 1);
    assert.equal(save.payload.draft.rest.min_gap_days, 2);
    // ⭐ הצהרות שחייבות להישלח גם כשהן ריקות.
    assert.equal(Object.hasOwn(save.payload.draft, 'rotation'), true);
    assert.equal(Object.hasOwn(save.payload.draft, 'max_shifts_per_month'), true);
    // סימון ההקלה מתאפס אחרי שמירה, כדי שלא יישאר מסומן לשינוי הבא.
    assert.equal(await managerPage.locator('#confirmWeakening').isChecked(), false);
  });

  await test('planner creates a draft without publishing it', async () => {
    await managerPage.locator('#runPlanner').click();
    await managerPage.locator('#runMessage .ok').waitFor();
    assert.match(await managerPage.locator('#runMessage').textContent(), /עדיין לא פורסמה/);
    assert.equal(await managerPage.locator('#draftSummary .metric').count(), 4);
    await managerPage.locator('#previewMessage .ok').waitFor();
    assert.equal(await managerPage.locator('#draftBoard .hcell').count(), 7);
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
    const publishCalls = calls.filter((entry) => entry.name === 'publishSchedule');
    assert.equal(publishCalls.length, 1, 'happy path שלח publish יותר מפעם אחת');
    const publish = publishCalls[0];
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

  /* ------------------------------------------------------------------
   * Retry idempotency: a lost response is not permission to invent a
   * second publication request. The id belongs to the reviewed
   * draft+digest pair and survives transport failure.
   * ------------------------------------------------------------------ */
  const retryManager = await browser.newContext({ viewport:{ width:1440, height:1000 }, locale:'he-IL' });
  const retryPreviewOne = Object.assign({}, draftPreview, {
    draft_id:'draft_retry_1', expected_content_digest:'digest_retry_1'
  });
  const retryPreviewTwo = Object.assign({}, draftPreview, {
    draft_id:'draft_retry_2', expected_content_digest:'digest_retry_2'
  });
  await prepare(retryManager, 'firefighter', {
    getScheduleRuntimeStatus:[
      { data:statusShadowManager }, { data:statusShadowManager }, { data:statusShadowManager }
    ],
    getScheduleManagerSetup:[{ data:setup }],
    getMyScheduleV2:[
      { data:legacyMine('shadow') }, { data:legacyMine('shadow') },
      { data:legacyMine('shadow') }, { data:legacyMine('shadow') }
    ],
    getStationScheduleRange:[
      { data:legacyRange('shadow') }, { data:legacyRange('shadow') },
      { data:legacyRange('shadow') }, { data:legacyRange('shadow') },
      { data:legacyRange('shadow') }, { data:legacyRange('shadow') },
      { data:legacyRange('shadow') }, { data:legacyRange('shadow') }
    ],
    runSchedulePlanner:[
      { data:{ draft_id:'draft_retry_1', from:today, to:shiftDay(today, 30),
        summary:{ filled:60, blocking_gaps:0, days_below_minimum:0, rejected_manual:0 } } },
      { data:{ draft_id:'draft_retry_2', from:today, to:shiftDay(today, 30),
        summary:{ filled:60, blocking_gaps:0, days_below_minimum:0, rejected_manual:0 } } }
    ],
    getScheduleDraftPreview:[{ data:retryPreviewOne }, { data:retryPreviewTwo }],
    publishSchedule:[
      { reject:true, code:'functions/unavailable', message:'response lost' },
      { data:{ prepared:true, publication_id:'p_retry_1', revision:1,
        notified_people:0, blocked_notifications:2 } },
      { data:{ prepared:true, publication_id:'p_retry_2', revision:2,
        notified_people:0, blocked_notifications:1 } }
    ]
  });
  const retryManagerPage = await retryManager.newPage();
  retryManagerPage.on('dialog', (dialog) => dialog.accept());
  await retryManagerPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await retryManagerPage.locator('#appMain:not(.hide)').waitFor();

  await test('a lost publish response retries the exact same request id', async () => {
    await retryManagerPage.locator('#runPlanner').click();
    await retryManagerPage.locator('#previewMessage .ok').waitFor();
    await retryManagerPage.locator('#reviewDraft').check();
    await retryManagerPage.locator('#publish').click();
    await retryManagerPage.locator('#publishMessage .err').waitFor();
    let publishCalls = (await retryManagerPage.evaluate(() => window.__CALLABLE_CALLS || []))
      .filter((entry) => entry.name === 'publishSchedule');
    assert.equal(publishCalls.length, 1);
    assert.match(String(publishCalls[0].payload.request_id || ''), /^publish_/);
    const firstRequestId = publishCalls[0].payload.request_id;
    assert.equal(await retryManagerPage.locator('#publish').isEnabled(), true,
      'כשל תעבורה מחק את הטיוטה או חסם retry');

    await retryManagerPage.locator('#publish').click();
    await retryManagerPage.locator('#publishMessage .ok').waitFor();
    assert.match(await retryManagerPage.locator('#publishMessage').textContent(), /הוכן לבדיקה בלבד/);
    publishCalls = (await retryManagerPage.evaluate(() => window.__CALLABLE_CALLS || []))
      .filter((entry) => entry.name === 'publishSchedule');
    assert.equal(publishCalls.length, 2);
    assert.equal(publishCalls[1].payload.request_id, firstRequestId,
      'retry המציא request_id חדש לאותה טיוטה חתומה');
    assert.equal(publishCalls[1].payload.draft_id, 'draft_retry_1');
    assert.equal(publishCalls[1].payload.expected_content_digest, 'digest_retry_1');
    const allCalls = await retryManagerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(allCalls.some((entry) => entry.name === 'setScheduleRuntimeMode'
      && entry.payload && entry.payload.target === 'new'), false);
    assert.equal(allCalls.some((entry) => entry.name === 'promoteScheduleToNew'), false);
  });

  await test('success clears the retry and a new draft receives a new request id', async () => {
    assert.equal(await retryManagerPage.locator('#draftPreviewCard').isVisible(), false);
    assert.equal(await retryManagerPage.locator('#publish').isDisabled(), true);
    const beforeIgnoredClick = (await retryManagerPage.evaluate(() => window.__CALLABLE_CALLS || []))
      .filter((entry) => entry.name === 'publishSchedule').length;
    await retryManagerPage.evaluate(() => document.getElementById('publish')
      .dispatchEvent(new MouseEvent('click', { bubbles:true })));
    assert.equal((await retryManagerPage.evaluate(() => window.__CALLABLE_CALLS || []))
      .filter((entry) => entry.name === 'publishSchedule').length, beforeIgnoredClick,
    'הצלחה השאירה ניסיון פרסום פעיל');

    await retryManagerPage.locator('#runPlanner').click();
    await retryManagerPage.locator('#previewMessage .ok').waitFor();
    await retryManagerPage.locator('#reviewDraft').check();
    await retryManagerPage.locator('#publish').click();
    await retryManagerPage.locator('#publishMessage .ok').waitFor();
    assert.match(await retryManagerPage.locator('#publishMessage').textContent(), /הוכן לבדיקה בלבד/);
    const publishCalls = (await retryManagerPage.evaluate(() => window.__CALLABLE_CALLS || []))
      .filter((entry) => entry.name === 'publishSchedule');
    assert.equal(publishCalls.length, 3);
    assert.notEqual(publishCalls[2].payload.request_id, publishCalls[1].payload.request_id,
      'טיוטה חדשה ירשה request_id מטיוטה שכבר פורסמה');
    assert.equal(publishCalls[2].payload.draft_id, 'draft_retry_2');
    assert.equal(publishCalls[2].payload.expected_content_digest, 'digest_retry_2');
  });
  await test('successful publish clears the retained request before any refresh', async () => {
    // A different draft/digest changes the request key by itself, so the
    // behavioural assertion above would stay green if the explicit reset
    // disappeared. Lock the ordering in the real publish path as well: once
    // the server has confirmed success, retained retry state is cleared before
    // the draft is discarded and before any fallible refresh begins.
    const source = fs.readFileSync(path.join(root, 'schedule-management.js'), 'utf8');
    const start = source.indexOf('async function publishDraft()');
    const end = source.indexOf('\nfunction setRollbackAvailability()', start);
    const body = source.slice(start, end);
    const success = body.indexOf('const successText =');
    const reset = body.indexOf('resetPublishRequest();', success);
    const discard = body.indexOf('state.draft = null;', success);
    const refresh = body.indexOf('state.status = (await call.status({})).data;', success);
    assert.ok(start > -1 && end > start, 'publishDraft source boundary was not found');
    assert.ok(success > -1 && reset > success,
      'successful publish no longer clears its retained request id');
    assert.ok(discard > reset,
      'retry state is not cleared before the successful draft is discarded');
    assert.ok(refresh > discard,
      'fallible refresh moved ahead of successful publish cleanup');
  });
  await retryManager.close();

  const refreshFailureManager = await browser.newContext({
    viewport:{ width:1440, height:1000 }, locale:'he-IL'
  });
  await prepare(refreshFailureManager, 'firefighter', {
    getScheduleRuntimeStatus:[
      { data:statusShadowManager },
      { reject:true, code:'functions/unavailable', message:'refresh failed' }
    ],
    getScheduleManagerSetup:[{ data:setup }],
    runSchedulePlanner:[{ data:{ draft_id:'draft_refresh_failure', from:today,
      to:shiftDay(today, 30),
      summary:{ filled:60, blocking_gaps:0, days_below_minimum:0, rejected_manual:0 } } }],
    getScheduleDraftPreview:[{ data:Object.assign({}, draftPreview, {
      draft_id:'draft_refresh_failure', expected_content_digest:'digest_refresh_failure'
    }) }],
    publishSchedule:[{ data:{ prepared:true, publication_id:'p_refresh_failure', revision:1,
      notified_people:0, blocked_notifications:2 } }]
  });
  const refreshFailurePage = await refreshFailureManager.newPage();
  refreshFailurePage.on('dialog', (dialog) => dialog.accept());
  await refreshFailurePage.goto(base + '?tab=manage', { waitUntil:'load' });
  await refreshFailurePage.locator('#appMain:not(.hide)').waitFor();
  await test('a refresh failure after success never sends publish twice', async () => {
    await refreshFailurePage.locator('#runPlanner').click();
    await refreshFailurePage.locator('#previewMessage .ok').waitFor();
    await refreshFailurePage.locator('#reviewDraft').check();
    await refreshFailurePage.locator('#publish').click();
    await refreshFailurePage.locator('#publishMessage .warn').waitFor();
    assert.match(await refreshFailurePage.locator('#publishMessage').textContent(), /לא התרענן/);
    assert.match(await refreshFailurePage.locator('#publishMessage').textContent(), /הוכן לבדיקה בלבד/);
    let publishCalls = (await refreshFailurePage.evaluate(() => window.__CALLABLE_CALLS || []))
      .filter((entry) => entry.name === 'publishSchedule');
    assert.equal(publishCalls.length, 1, 'כשל הרענון שלח publish פעם נוספת');
    assert.equal(await refreshFailurePage.locator('#draftPreviewCard').isVisible(), false,
      'כשל רענון החזיר טיוטה שכבר פורסמה');
    await refreshFailurePage.evaluate(() => document.getElementById('publish')
      .dispatchEvent(new MouseEvent('click', { bubbles:true })));
    publishCalls = (await refreshFailurePage.evaluate(() => window.__CALLABLE_CALLS || []))
      .filter((entry) => entry.name === 'publishSchedule');
    assert.equal(publishCalls.length, 1, 'לחיצה אחרי הצלחה וכשל רענון פרסמה שוב');
    const allCalls = await refreshFailurePage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(allCalls.some((entry) => entry.name === 'setScheduleRuntimeMode'
      && entry.payload && entry.payload.target === 'new'), false);
    assert.equal(allCalls.some((entry) => entry.name === 'promoteScheduleToNew'), false);
  });
  await refreshFailureManager.close();

  const phone = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(phone, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusFirefighter }],
    getMyScheduleV2:[{ data:mine }, { data:mineAnswered }, { data:mineAnswered }, { data:mineAnswered }],
    getStationScheduleRange:[{ data:stationRange }, { data:stationRangeGuardsUnavailable }, { data:stationRangeGuardsUnavailable }],
    respondToSchedule:[{ data:{ duplicate:false, response_id:'r_1', answer:'confirm' } }]
  });
  const phonePage = await phone.newPage();
  await phonePage.goto(base, { waitUntil:'load' });
  await phonePage.locator('#appMain:not(.hide)').waitFor();

  await test('station schedule is the default mobile view for every member', async () => {
    assert.equal(await phonePage.locator('#stationView').isVisible(), true);
    await phonePage.locator('#stationBoard .hcell').first().waitFor();
    assert.match(await phonePage.locator('#stationContent').textContent(), /אבטחת כוננות/);
    assert.match(await phonePage.locator('#stationContent').textContent(), /טרם אוישה/);
    assert.match(await phonePage.locator('#stationContent').textContent(), /חבר\/ת האבטחה/);
    // הרצועה היא חודש שלם בקריאה אחת, ולא שלושה ימים.
    const range = (await phonePage.evaluate(() => window.__CALLABLE_CALLS))
      .find((entry) => entry.name === 'getStationScheduleRange');
    assert.equal(range.payload.from.slice(8), '01');
    assert.equal(Object.hasOwn(range.payload, 'stationId'), false);
  });

  const direct = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(direct, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusFirefighter }],
    getMyScheduleV2:[{ data:mine }],
    getStationScheduleRange:[{ data:stationRange }, { data:stationRange }, { data:stationRange }, { data:stationRange }]
  });
  const directPage = await direct.newPage();
  await directPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await directPage.locator('#appMain:not(.hide)').waitFor();
  await test('non-manager is sent to the station schedule even through a direct management URL', async () => {
    assert.equal(await directPage.locator('#manageTab').isVisible(), false);
    assert.equal(await directPage.locator('#manageView').isVisible(), false);
    assert.equal(await directPage.locator('#stationView').isVisible(), true);
    await directPage.locator('#stationBoard .hcell').first().waitFor();
  });
  await direct.close();

  /* ------------------------------------------------------------------
   * ג5 · הרשאת עריכה סמויה בנייד
   *
   * ⭐ מודל האיום כאן אינו „המשתמש רואה כפתור". הוא „למשתמש יש
   * דפדפן". `hidden`, `disabled` ו-`display:none` הם תכונות DOM
   * שאפשר להסיר בשורה אחת בקונסולה. לכן הבדיקה מסירה אותן בעצמה,
   * ואז לוחצת בכוח על **כל** פקד ניהול.
   *
   * מה שנטען: אף קריאה משנה אינה יוצאת מהמסך. השרת ממילא עוצר —
   * זה נבדק ב-schedule-hidden-authority-probe — אבל מסך שמנסה
   * לשלוח פעולה שהוא יודע שאינה מותרת הוא מסך שמשקר לאדם.
   * ------------------------------------------------------------------ */

  const forced = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(forced, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusFirefighter }],
    getMyScheduleV2:[{ data:mine }],
    getStationScheduleRange:[{ data:stationRange }, { data:stationRange }, { data:stationRange }, { data:stationRange }]
  });
  const forcedPage = await forced.newPage();
  forcedPage.on('dialog', (dialog) => dialog.accept());
  await forcedPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await forcedPage.locator('#appMain:not(.hide)').waitFor();

  const MUTATING = ['saveSchedulePolicy', 'previewSchedulePolicy', 'saveScheduleSource',
    'previewScheduleSource', 'runSchedulePlanner', 'publishSchedule', 'rollbackSchedule',
    'setScheduleRuntimeMode', 'manageScheduleGuard', 'assignGuard',
    // ⭐ שתי אלה מזיזות את כל התחנה לסידור אחר.
    'previewScheduleCutover', 'promoteScheduleToNew',
    'getScheduleManagerSetup', 'getScheduleDraftPreview', 'setScheduleManagerAccess'];

  await test('a member with no appointment fires no managing call even with hidden and disabled stripped', async () => {
    const before = await forcedPage.evaluate(() => window.__CALLABLE_CALLS.length);

    // הסרת כל שכבת התצוגה, בדיוק כפי שאפשר לעשות מקונסולה.
    const clicked = await forcedPage.evaluate(() => {
      const ids = ['manageTab', 'manageView', 'modeCard', 'modeApply', 'savePolicy',
        'sourceCheck', 'sourceSave', 'runPlanner', 'publish', 'rollback'];
      const hit = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.hidden = false;
        el.removeAttribute('hidden');
        el.disabled = false;
        el.removeAttribute('disabled');
        el.classList.remove('hide');
        el.style.display = '';
        el.style.visibility = 'visible';
        el.style.pointerEvents = 'auto';
        hit.push(id);
      }
      // הלחיצה עצמה — אחרי שכל מה שחסם אותה הוסר.
      for (const id of hit) {
        const el = document.getElementById(id);
        el.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
      }
      return hit;
    });

    // ⭐ אם הפקדים לא היו בעמוד בכלל, הבדיקה לא בדקה כלום.
    assert.ok(clicked.length >= 8, 'ציפיתי למצוא את פקדי הניהול ב-DOM, מצאתי ' + clicked.length);

    await forcedPage.waitForTimeout(250);

    const calls = await forcedPage.evaluate(() => window.__CALLABLE_CALLS);
    const fired = calls.slice(before).map((entry) => entry.name)
      .filter((name) => MUTATING.includes(name));
    assert.deepEqual(fired, [], 'יצאו קריאות ניהול: ' + fired.join(', '));

    // והמסך גם לא נפתח „חלקית": הלשונית עדיין אינה הלשונית הפעילה.
    assert.equal(await forcedPage.locator('#stationView').isVisible(), true);
  });
  await forced.close();

  await test('personal mobile view remains available after station is the default', async () => {
    await phonePage.locator('[data-tab="mine"]').dispatchEvent('click');
    await phonePage.locator('#mineToday .assignment').first().waitFor();
    assert.match(await phonePage.locator('#mineToday').textContent(), /טל חודרה/);
    assert.match(await phonePage.locator('#mineToday').textContent(), /קורס חילוץ/);
    assert.match(await phonePage.locator('#mineToday').textContent(), /אבטחת אירוע/);
    const guard = phonePage.locator('#mineToday .guard-card').filter({ hasText:'אבטחת אירוע' });
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
  await test('station mobile view is a full month strip, in one call', async () => {
    await phonePage.locator('[data-tab="station"]').dispatchEvent('click');
    await phonePage.locator('#stationBoard .hcell').first().waitFor();
    const columns = await phonePage.locator('#stationBoard .hcell').count();
    assert.ok(columns >= 28 && columns <= 31, 'חודש שלם, לא שלושה ימים: ' + columns);
    assert.match(await phonePage.locator('#stationContent').textContent(), /טל חודרה/);
    // ⭐ שתי הלשוניות חולקות קריאה אחת לחודש. הקריאה הזאת קוראת
    // את התמונה החתומה בשלמותה, ולכן כפילות שלה אינה ניואנס.
    const before = (await phonePage.evaluate(() => window.__CALLABLE_CALLS))
      .filter((entry) => entry.name === 'getStationScheduleRange').length;
    assert.equal(before, 1);

    // מעבר חודש הוא קריאה חדשה — וכאן הוא מחזיר כשל בקריאת אבטחות.
    const current = Number((await phonePage.locator('.months button[aria-pressed="true"]')
      .first().getAttribute('data-index')) || 0);
    await phonePage.locator('#stationHead .months button').nth(current === 0 ? 1 : current - 1).click();
    await phonePage.locator('#stationBoard .hcell').first().waitFor();
    const after = (await phonePage.evaluate(() => window.__CALLABLE_CALLS))
      .filter((entry) => entry.name === 'getStationScheduleRange').length;
    assert.equal(after, 2);
    // כשל בקריאת אבטחות נאמר, ואינו הופך את הלוח לריק.
    assert.match(await phonePage.locator('#stationNote').textContent(), /לא ניתן לטעון אבטחות כרגע/);
    assert.doesNotMatch(await phonePage.locator('#stationContent').textContent(), /אין סידור להצגה/);
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
      const heights = await phonePage.locator('.tabs button,.wkjump button,.pill').evaluateAll((nodes) => nodes
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
    getMyScheduleV2:[{ data:legacyMine('off') }, { data:legacyMine('off') }],
    getStationScheduleRange:[{ data:legacyRange('off') }, { data:legacyRange('off') }, { data:legacyRange('off') }]
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
    await offPage.locator('#stationBoard .hcell').first().waitFor();
    assert.match(await offPage.locator('#stationContent').textContent(), /משמרת א/);
    // ⭐ הרצועה עובדת גם לפני שהמנוע הופעל. אחרת המסך היה ריק
    // בדיוק במצב שהתחנה נמצאת בו היום.
    assert.match(await offPage.locator('#stationNote').textContent(), /מנוע הסידור החדש עדיין אינו פעיל/);
    const calls = await offPage.evaluate(() => window.__CALLABLE_CALLS || []);
    // הפאנל האישי נטען רק בלשונית „הסידור שלי", ולכן אינו נקרא כאן.
    assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 0);
    assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleRange').length, 1);
    assert.equal(calls.some((entry) => entry.name === 'getScheduleManagerSetup'), false);
  });
  await test('off mode keeps the personal legacy view available without an edit response', async () => {
    await offPage.locator('[data-tab="mine"]').click();
    assert.equal(await offPage.locator('#mineView').isVisible(), true);
    await offPage.locator('#mineBoard .hcell').first().waitFor();
    assert.match(await offPage.locator('#mineContent').textContent(), /טל חודרה/);
    assert.equal(await offPage.locator('#mineToday .confirm').count(), 0);
    const calls = await offPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.some((entry) => entry.name === 'respondToSchedule'), false);
  });
  await off.close();

  const shadowMember = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(shadowMember, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusShadowMember }],
    getMyScheduleV2:[{ data:legacyMine('shadow') }, { data:legacyMine('shadow') }],
    getStationScheduleRange:[{ data:legacyRange('shadow') }, { data:legacyRange('shadow') }, { data:legacyRange('shadow') }]
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
    await shadowMemberPage.locator('#stationBoard .hcell').first().waitFor();
    await shadowMemberPage.locator('[data-tab="mine"]').click();
    await shadowMemberPage.locator('#mineBoard .hcell').first().waitFor();
    assert.match(await shadowMemberPage.locator('#mineContent').textContent(), /טל חודרה/);
    const calls = await shadowMemberPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleRange').length, 1);
    assert.equal(calls.some((entry) => entry.name === 'getScheduleManagerSetup'), false);
  });
  await shadowMember.close();

  const shadowManager = await browser.newContext({ viewport:{ width:1440, height:1000 }, locale:'he-IL' });
  await prepare(shadowManager, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusShadowManager }, { data:statusShadowManager }],
    getScheduleManagerSetup:[{ data:setup }],
    getMyScheduleV2:[{ data:legacyMine('shadow') }, { data:legacyMine('shadow') }],
    getStationScheduleRange:[{ data:legacyRange('shadow') }, { data:legacyRange('shadow') }, { data:legacyRange('shadow') }],
    runSchedulePlanner:[{ data:{ draft_id:'draft_shadow', from:today, to:shiftDay(today, 30),
      summary:{ filled:60, blocking_gaps:0, days_below_minimum:0, rejected_manual:0 } } }],
    getScheduleDraftPreview:[{ data:Object.assign({}, draftPreview, { draft_id:'draft_shadow' }) }],
    publishSchedule:[{ data:{ prepared:true, publication_id:'p_prepared', revision:1,
      notified_people:0, blocked_notifications:2 } }]
  });
  const shadowManagerPage = await shadowManager.newPage();
  shadowManagerPage.on('dialog', (dialog) => dialog.accept());
  await shadowManagerPage.goto(base + '?tab=station', { waitUntil:'load' });
  await shadowManagerPage.locator('#appMain:not(.hide)').waitFor();
  await test('an appointed manager retains management in shadow while station remains the default', async () => {
    assert.equal(await shadowManagerPage.locator('#manageTab').isVisible(), true);
    assert.equal(await shadowManagerPage.locator('#mineTab').isVisible(), true);
    assert.equal(await shadowManagerPage.locator('#stationTab').isVisible(), true);
    assert.equal(await shadowManagerPage.locator('#stationView').isVisible(), true);
    await shadowManagerPage.locator('#stationBoard .hcell').first().waitFor();
    await shadowManagerPage.locator('[data-tab="manage"]').click();
    assert.equal(await shadowManagerPage.locator('#manageView').isVisible(), true);
    assert.match(await shadowManagerPage.locator('#sourceSummary').textContent(), /מהדורה 7/);
    const calls = await shadowManagerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 0);
    assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleRange').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'getScheduleManagerSetup').length, 1);
  });

  await test('shadow manager prepares a reviewed draft without activating it or notifying anyone', async () => {
    await shadowManagerPage.locator('#runPlanner').click();
    await shadowManagerPage.locator('#previewMessage .ok').waitFor();
    await shadowManagerPage.locator('#reviewDraft').check();
    assert.equal(await shadowManagerPage.locator('#publish').textContent(), 'הכן את הסידור');
    assert.equal(await shadowManagerPage.locator('#publish').isEnabled(), true);
    await shadowManagerPage.locator('#publish').click();
    await shadowManagerPage.locator('#publishMessage .ok').waitFor();
    const text = await shadowManagerPage.locator('#publishMessage').textContent();
    assert.match(text, /הוכן לבדיקה בלבד/);
    assert.match(text, /לא הופעל/);
    assert.match(text, /הסידור הקיים נשאר פעיל/);
    assert.match(text, /לא נשלחו הודעות/);

    const calls = await shadowManagerPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const publishCalls = calls.filter((entry) => entry.name === 'publishSchedule');
    assert.equal(publishCalls.length, 1, 'happy path ב-shadow שלח publish יותר מפעם אחת');
    const publish = publishCalls[0];
    assert.ok(publish, 'הכנה ב-shadow לא קראה publishSchedule');
    assert.equal(publish.payload.draft_id, 'draft_shadow');
    assert.equal(publish.payload.expected_content_digest, 'digest_preview_1');
    assert.equal(Object.hasOwn(publish.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(publish.payload, 'station_id'), false);
    assert.equal(calls.some((entry) => entry.name === 'setScheduleRuntimeMode'
      && entry.payload && entry.payload.target === 'new'), false);
    assert.equal(calls.some((entry) => entry.name === 'promoteScheduleToNew'), false);
    assert.equal(await shadowManagerPage.locator('#draftPreviewCard').isVisible(), false);

    await shadowManagerPage.locator('[data-tab="station"]').click();
    assert.match(await shadowManagerPage.locator('#stationNote').textContent(), /הסידור הקיים/);
    assert.match(await shadowManagerPage.locator('#stationContent').textContent(), /אלדד יונה/);
  });
  await shadowManager.close();

  /* ------------------------------------------------------------------
   * ⭐ P1-1 · הכרעה שהתהפכה, ובכוונה.
   *
   * הבדיקה כאן דרשה קודם שמצב `off` יסתיר ניהול לגמרי. זה יצר לולאה
   * סגורה: `modeReadiness` טוען מדיניות ומקור בפועל לפני שהוא מרשה
   * מעבר ל-shadow, ואי אפשר היה להזין אותם בלי שהמנוע כבר יהיה
   * ב-shadow. תחנה חדשה לא יכלה להתחיל לעבוד.
   *
   * מה שנדרש עכשיו: **הזנה** מותרת ב-`off`; **הרצה ופרסום** חסומות.
   * ------------------------------------------------------------------ */
  const offManager = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await prepare(offManager, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusOffManager }],
    getScheduleManagerSetup:[{ data:setup }],
    getMyScheduleV2:[{ data:legacyMine('off') }, { data:legacyMine('off') }],
    getStationScheduleRange:[{ data:legacyRange('off') }, { data:legacyRange('off') }, { data:legacyRange('off') }]
  });
  const offManagerPage = await offManager.newPage();
  await offManagerPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await offManagerPage.locator('#appMain:not(.hide)').waitFor();
  await test('off mode lets an appointed manager enter rules, but never run or publish', async () => {
    // ההזנה פתוחה — אחרת אי אפשר להתחיל תחנה חדשה.
    assert.equal(await offManagerPage.locator('#manageTab').isVisible(), true);
    assert.equal(await offManagerPage.locator('#manageView').isVisible(), true);
    // ⭐ אבל ההרצה חסומה, ולא רק מוסתרת.
    assert.equal(await offManagerPage.locator('#runPlanner').isDisabled(), true);
    assert.equal(await offManagerPage.locator('#publish').isDisabled(), true);
    // ומתג המנוע אינו שלו — הוא של הפיקוד.
    assert.equal(await offManagerPage.locator('#modeCard').isVisible(), false);
  });

  await test('force-clicking run in off mode fires no engine call', async () => {
    const before = await offManagerPage.evaluate(() => window.__CALLABLE_CALLS.length);
    await offManagerPage.evaluate(() => {
      for (const id of ['runPlanner', 'publish', 'rollback']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.disabled = false;
        el.removeAttribute('disabled');
        el.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true }));
      }
    });
    await offManagerPage.waitForTimeout(200);
    const calls = await offManagerPage.evaluate(() => window.__CALLABLE_CALLS);
    const fired = calls.slice(before).map((entry) => entry.name)
      .filter((name) => ['runSchedulePlanner', 'publishSchedule', 'rollbackSchedule']
        .includes(name));
    assert.deepEqual(fired, [], 'יצאה קריאת הרצה במצב off: ' + fired.join(', '));
  });
  await offManager.close();

  const importer = await browser.newContext({ viewport:{ width:1280, height:1000 }, locale:'he-IL' });
  await prepare(importer, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:statusManager }, { data:statusManager }],
    getScheduleManagerSetup:[{ data:setup }, { data:setup }],
    previewScheduleSource:[{ data:{
      kind:'created', blocked:false, source_id:'source_1_aaa', version:'v1', revision:'1',
      digest:'d1', content_key:'k1', counts:{ people:2, availability:0, locked:0, events:0 },
      mode:'new', active_source_id:'source_1',
      report:{ total:4, accepted:2, rejected:2,
        by_code:{ 'row-no-employee-number':1, 'row-active-missing':1 },
        rows:[
          { row:4, code:'row-no-employee-number', text:'אין מספר עובד. זיהוי לפי שם אינו מתבצע.' },
          { row:5, code:'row-active-missing', text:'אין סימון פעיל/לא פעיל מפורש.' }
        ] } } }],
    saveScheduleSource:[{ data:{ duplicate:false, written:true, activated:true,
      kind:'created', source_id:'source_1_aaa', version:'v1', revision:'1',
      counts:{ people:2, availability:0, locked:0, events:0 },
      report:{ total:4, accepted:2, rejected:2, by_code:{}, rows:[] } } }],
    getStationScheduleRange:[{ data:stationRange }, { data:stationRange }]
  });
  const importPage = await importer.newPage();
  importPage.on('dialog', (dialog) => dialog.accept());
  await importPage.goto(base + '?tab=manage', { waitUntil:'load' });
  await importPage.locator('#appMain:not(.hide)').waitFor();

  await test('the import shows the real values in the sheet instead of guessing them', async () => {
    // ⭐ ההדבקה היא מה שהמסך מקבל. הוא אינו ניגש לגיליון.
    await importPage.locator('#sourcePaste').fill(
      ['מספר עובד\tשם\tתחנה\tתפקידים\tסטטוס',
        '1001\tבדיקה אלף\tאילת\tנהג\tמשבץ',
        '1002\tבדיקה בית\tאילת\tלוחם, נהג\tמשבץ',
        '\tבדיקה גימל\tאילת\tלוחם\tמשבץ',
        '1004\tבדיקה דלת\tאילת\tלוחם\tחל"ת'].join('\n'));
    await importPage.locator('#sourceParse').click();
    await importPage.locator('#sourceMap:not([hidden])').waitFor();
    assert.equal(await importPage.locator('#sourceMap select').count(), 5);
    // בלי מיפוי מלא אי אפשר לבדוק.
    assert.equal(await importPage.locator('#sourceCheck').isEnabled(), false);

    const fields = ['employee_number', 'full_name', 'sub_station', 'roles', 'active'];
    for (let index = 0; index < fields.length; index++) {
      await importPage.locator('#sourceMap select[data-field="' + fields[index] + '"]')
        .selectOption(String(index));
    }
    await importPage.locator('#sourceActive:not([hidden])').waitFor();
    // ⭐ הערכים הם מה שבאמת יש בעמודה — לא רשימה שהמצאתי.
    const values = await importPage.locator('#sourceActiveValues code').allTextContents();
    assert.deepEqual(values.slice().sort(), ['חל"ת', 'משבץ'].sort(),
      'הוצגו ערכים שאינם מההדבקה: ' + JSON.stringify(values));
    // ⭐ עדיין לא סומן ערך אחד כפעיל. מקור שכולו לא פעיל אינו מקור,
    // ולכן אין מה לשלוח.
    assert.equal(await importPage.locator('#sourceCheck').isEnabled(), false);
    assert.match(await importPage.locator('#sourceActiveValues').textContent(),
      /0 פעילים · 4 לא פעילים/);
  });

  await test('rows leave the browser with an explicit boolean and mapped role ids', async () => {
    await importPage.locator('#sourceActiveValues label').filter({ hasText:'משבץ' })
      .locator('input').check();
    // הפילוח נאמר במספרים לפני השליחה.
    assert.match(await importPage.locator('#sourceActiveValues').textContent(),
      /3 פעילים · 1 לא פעילים/);
    assert.equal(await importPage.locator('#sourceCheck').isEnabled(), true);
    await importPage.locator('#sourceCheck').click();
    await importPage.locator('#sourceMessage .ok, #sourceMessage .warn').first().waitFor();

    const sent = (await importPage.evaluate(() => window.__CALLABLE_CALLS))
      .find((entry) => entry.name === 'previewScheduleSource');
    assert.ok(sent);
    assert.equal(sent.payload.rows.length, 4);
    // מספר השורה הוא מספר השורה בגיליון, כולל הכותרת.
    assert.equal(sent.payload.rows[0].row, 2);
    // ⭐ „פעיל" הוא בוליאני שאדם סיווג, לא מחרוזת שהשרת ינחש.
    assert.equal(sent.payload.rows[0].active, true);
    assert.equal(sent.payload.rows[3].active, false);
    // תוויות עבריות מחוקי התחנה הומרו למזהי התפקידים, בהתאמה מדויקת.
    assert.deepEqual(sent.payload.rows[0].roles, ['driver']);
    assert.deepEqual(sent.payload.rows[1].roles, ['firefighter', 'driver']);
    assert.deepEqual(sent.payload.rows[2].roles, ['firefighter']);
    // המיפוי בין מספר עובד ל-uid נקרא בשרת, ואינו נשלח מהדפדפן.
    assert.equal(Object.hasOwn(sent.payload, 'known'), false);
    assert.equal(Object.hasOwn(sent.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(sent.payload, 'station_id'), false);
  });

  await test('nobody is dropped from the roster without someone seeing the number', async () => {
    // הדוח מדבר בשורות: מספר שורה, מה חסר, קוד.
    assert.equal(await importPage.locator('#sourceReport tr').count(), 2);
    const text = await importPage.locator('#sourceReport').textContent();
    assert.match(text, /אין מספר עובד/);
    assert.match(text, /row-no-employee-number/);
    // ⭐ ובלי שמות — אף שם מההדבקה אינו מגיע לדוח.
    assert.doesNotMatch(text, /בדיקה גימל/);
    assert.doesNotMatch(text, /בדיקה דלת/);

    assert.match(await importPage.locator('#sourceCounts').textContent(), /2/);
    // ⭐ שמירה חסומה עד שמישהו מאשר את המספר המדויק.
    assert.equal(await importPage.locator('#sourceSave').isEnabled(), false);
    assert.match(await importPage.locator('#sourceAcceptText').textContent(),
      /ראיתי ש-2 שורות/);

    await importPage.locator('#sourceAccept').check();
    assert.equal(await importPage.locator('#sourceSave').isEnabled(), true);
    await importPage.locator('#sourceSave').click();
    await importPage.locator('#sourceMessage .ok').waitFor();

    const saved = (await importPage.evaluate(() => window.__CALLABLE_CALLS))
      .find((entry) => entry.name === 'saveScheduleSource');
    assert.ok(saved);
    // המספר המדויק נשלח לשרת, שמשווה אותו למספר האמיתי.
    assert.equal(saved.payload.accept_rejected, 2);
    assert.equal(saved.payload.activate, true);
    assert.equal(saved.payload.expected_source_id, 'source_1');
    assert.ok(String(saved.payload.request_id || '').startsWith('source_'));
  });
  await importer.close();

  const commander = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(commander, 'commander', {
    // מפקד בלי מינוי אחראי סידור: אין לו לשונית ניהול, ויש לו המתג.
    getScheduleRuntimeStatus:[{ data:{ mode:'off', configured:false, manager:false, active:null } },
      { data:{ mode:'shadow', configured:true, manager:false, active:null } }],
    getScheduleModeOptions:[
      { data:{ may_change:true, current:'off', ready:true,
        targets:[{ to:'shadow', kind:'enable_shadow', label:'בדיקה', available:true, blocked_by:null }],
        readiness:{ policy:true, source:true, people:44, problems:[] } } },
      { data:{ may_change:true, current:'shadow', ready:true,
        targets:[{ to:'new', kind:'promote', label:'פעיל', available:true, blocked_by:null },
          { to:'off', kind:'disable', label:'כבוי', available:true, blocked_by:null }],
        readiness:{ policy:true, source:true, people:44, problems:[] } } }],
    setScheduleRuntimeMode:[{ data:{ duplicate:false, changed:true, mode:'shadow',
      from:'off', to:'shadow', transition:'enable_shadow', reason_code:'initial_activation' } }],
    getStationScheduleRange:[{ data:legacyRange('off') }, { data:legacyRange('off') },
      { data:legacyRange('shadow') }, { data:legacyRange('shadow') }]
  });
  const commanderPage = await commander.newPage();
  commanderPage.on('dialog', (dialog) => dialog.accept());
  await commanderPage.goto(base, { waitUntil:'load' });
  await commanderPage.locator('#appMain:not(.hide)').waitFor();

  await test('command sees the engine switch, and it will not move on a click alone', async () => {
    await commanderPage.locator('#modeCard:not([hidden])').waitFor();
    // המתג קיים, לשונית הניהול לא — שתי הרשאות שונות.
    assert.equal(await commanderPage.locator('#manageTab').isVisible(), false);
    assert.equal(await commanderPage.locator('#modeNow').textContent(), 'כבוי');
    assert.equal(await commanderPage.locator('#modeTargets .pill').count(), 1);

    await commanderPage.locator('#modeTargets .pill').first().click();
    await commanderPage.locator('#modeForm:not([hidden])').waitFor();
    // ⭐ בחירת יעד אינה מספיקה: בלי סיבה ובלי הקלדה הכפתור נעול.
    assert.equal(await commanderPage.locator('#modeApply').isEnabled(), false);

    await commanderPage.locator('#modeReason').selectOption('initial_activation');
    assert.equal(await commanderPage.locator('#modeApply').isEnabled(), false);

    await commanderPage.locator('#modeConfirm').fill('shadowx');
    assert.equal(await commanderPage.locator('#modeApply').isEnabled(), false);

    await commanderPage.locator('#modeConfirm').fill('shadow');
    assert.equal(await commanderPage.locator('#modeApply').isEnabled(), true);
    const before = await commanderPage.evaluate(() => window.__CALLABLE_CALLS);
    assert.equal(before.some((entry) => entry.name === 'setScheduleRuntimeMode'), false);
  });

  await test('the mode change carries the state the screen saw, and never a station', async () => {
    await commanderPage.locator('#modeApply').click();
    await commanderPage.locator('#modeMessage .ok').waitFor();
    assert.match(await commanderPage.locator('#modeMessage').textContent(), /„כבוי" ל„בדיקה"/);
    const calls = await commanderPage.evaluate(() => window.__CALLABLE_CALLS);
    const sent = calls.find((entry) => entry.name === 'setScheduleRuntimeMode');
    assert.ok(sent);
    assert.equal(sent.payload.target, 'shadow');
    assert.equal(sent.payload.confirmation, 'shadow');
    assert.equal(sent.payload.reason_code, 'initial_activation');
    // ⭐ הגנה מדריסה: מה שהמסך ראה נשלח לשרת.
    assert.equal(sent.payload.expected_mode, 'off');
    assert.equal(Object.hasOwn(sent.payload, 'stationId'), false);
    assert.equal(Object.hasOwn(sent.payload, 'station_id'), false);
    assert.ok(String(sent.payload.request_id || '').startsWith('mode_'));
    // אחרי השינוי המסך נטען מחדש מהשרת ולא מניח מה קרה.
    assert.equal(await commanderPage.locator('#modeNow').textContent(), 'בדיקה');
    assert.equal(await commanderPage.locator('#modeForm').isVisible(), false);
    // גם תשובת שרת ישנה שמפרסמת `new` אינה יוצרת מסלול הפעלה ב-42G.0.
    assert.equal(await commanderPage.locator('#modeTargets .pill').count(), 1);
    assert.match(await commanderPage.locator('#modeTargets .pill').first().textContent(), /כבוי/);
    assert.equal(calls.some((entry) => entry.name === 'setScheduleRuntimeMode'
      && entry.payload && entry.payload.target === 'new'), false);
    const factories = await commanderPage.evaluate(() => window.__CALLABLE_FACTORIES || []);
    assert.equal(factories.includes('previewScheduleCutover'), false);
    assert.equal(factories.includes('promoteScheduleToNew'), false);
  });
  await commander.close();

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
    assert.equal(calls.some((entry) => entry.name === 'getStationScheduleRange'), false);
  });
  await statusError.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(passed, 29);
console.log('\n29 schedule management browser checks passed.');
