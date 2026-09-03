import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = path.join(root, 'tests', 'stub');
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

let passed = 0;
async function test(name, fn) {
  await fn(); passed += 1; console.log('✓ ' + name);
}

const initialMembers = {
  members:[
    // שדות עודפים בודקים שהכרטיס החדש אינו מציג PII שאינו נחוץ.
    { uid:'u_fire', name:'רות <img src=x>', primary_role:'firefighter', enabled:false,
      email:'secret@example.test', phone:'050-1234567', emp:'37', district:'south' },
    { uid:'u_manager', name:'דנה לוי', primary_role:'commander', enabled:true,
      email:'also-secret@example.test', phone:'050-7654321', emp:'38', district:'south' }
  ]
};
const afterGrant = {
  members:initialMembers.members.map((member) =>
    member.uid === 'u_fire' ? { ...member, enabled:true } : member)
};
const afterRevoke = {
  members:afterGrant.members.map((member) =>
    member.uid === 'u_fire' ? { ...member, enabled:false } : member)
};

function jerusalemDay() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Jerusalem', year:'numeric', month:'2-digit', day:'2-digit'
  }).formatToParts(new Date()).reduce((out, part) => {
    out[part.type] = part.value;
    return out;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function shiftDay(iso, amount) {
  const value = new Date(iso + 'T00:00:00.000Z');
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

// אלה צורות התשובה המאושרות מהקורא בצד השרת במצב legacy. הבדיקה
// בכוונה אינה מחקה Firestore או את הסידור הישן בדפדפן.
const legacyToday = jerusalemDay();
function legacyDay(date, isMe) {
  return {
    date,
    sub_stations:[{
      sub_station:'legacy_A', label:'משמרת א', minimum:null, below_minimum:false,
      people:[
        { uid:'stub-uid', person:'אלדד יונה', role_label:'צוות א', hours:null, is_me:isMe },
        { uid:'crew_1', person:'טל חודרה', role_label:'צוות א', hours:null, is_me:false }
      ]
    }],
    events:[]
  };
}
const legacyMine = {
  mode:'off', active:true, source:'legacy',
  days:[{
    date:legacyToday, sub_station:'legacy_A', sub_station_label:'משמרת א',
    role:null, role_label:'צוות א', hours:null, shift:'משמרת א', qualifications:[],
    crew:[{ uid:'crew_1', person:'טל חודרה', role_label:'צוות א' }],
    change:null, answer:null, requires_answer:false
  }],
  events:[], pending_answers:0
};
// רצועת חודש. מסך הסידור קורא טווח בקריאה אחת, גם כשמנוע
// הסידור החדש כבוי — אחרת המסך היה ריק בדיוק במצב הנוכחי.
const legacyRange = (() => {
  const year = Number(legacyToday.slice(0, 4));
  const month = Number(legacyToday.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  const days = [];
  for (let index = 1; index <= last; index++) {
    const date = legacyToday.slice(0, 7) + '-' + pad(index);
    days.push(legacyDay(date, date === legacyToday));
  }
  return {
    mode:'off', active:true, source:'legacy', publication_id:null, revision:null,
    from:legacyToday.slice(0, 7) + '-01', to:legacyToday.slice(0, 7) + '-' + pad(last),
    days
  };
})();

const browser = await chromium.launch();
try {
  const hr = await browser.newContext({ viewport:{ width:1280, height:1000 }, locale:'he-IL' });
  await prepare(hr, 'hr', {
    getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }],
    getScheduleManagerAccess:[{ data:initialMembers }, { data:afterGrant }, { data:afterRevoke }],
    setScheduleManagerAccess:[{ data:{ enabled:true } }, { data:{ enabled:false } }]
  });
  const hrPage = await hr.newPage();
  await hrPage.goto(base, { waitUntil:'load' });
  await hrPage.locator('#scheduleAccessCard:not(.hide)').waitFor();

  await test('HR sees the separate appointment card and a data-free legacy transition', async () => {
    assert.equal(await hrPage.locator('#scheduleAccessCard').isVisible(), true);
    assert.equal(await hrPage.locator('#legacyRotationCard').isVisible(), true);
    assert.equal(await hrPage.locator('#btnRot').count(), 0);
    assert.match(await hrPage.locator('#legacyRotationCard').textContent(), /אינו קורא ואינו מציג/);
    assert.equal(await hrPage.locator('#scheduleManagementLink').isVisible(), false);
    assert.equal(await hrPage.locator('#legacyRotationManageLink').isVisible(), false);
  });

  await test('the appointment card shows only its minimal safe fields with text nodes', async () => {
    const text = await hrPage.locator('#scheduleAccessCard').textContent();
    assert.match(text, /דנה לוי/);
    assert.match(text, /לוחם אש/);
    assert.equal(text.includes('secret@example.test'), false);
    assert.equal(text.includes('050-1234567'), false);
    assert.equal(text.includes('37'), false);
    assert.equal(text.includes('south'), false);
    assert.equal(await hrPage.locator('#scheduleAccessCard img').count(), 0);
    assert.match(await hrPage.locator('#scheduleAccessPick option[value="u_fire"]').textContent(), /רות <img src=x>/);
  });

  await test('HR grants and revokes only through the two server callables without station data', async () => {
    await hrPage.evaluate(() => {
      const select = document.getElementById('scheduleAccessPick');
      select.value = 'u_fire';
      select.dispatchEvent(new Event('change', { bubbles:true }));
    });
    assert.equal(await hrPage.locator('#btnScheduleAccessEnable').isEnabled(), true);
    await hrPage.locator('#btnScheduleAccessEnable').dispatchEvent('click');
    await hrPage.locator('#scheduleAccessMsg.ok').waitFor();
    await hrPage.evaluate(() => {
      const select = document.getElementById('scheduleAccessPick');
      select.value = 'u_fire';
      select.dispatchEvent(new Event('change', { bubbles:true }));
    });
    assert.equal(await hrPage.locator('#btnScheduleAccessDisable').isEnabled(), true);
    await hrPage.locator('#btnScheduleAccessDisable').dispatchEvent('click');
    await hrPage.locator('#scheduleAccessMsg.ok').waitFor();

    const calls = await hrPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const appointmentCalls = calls.filter((entry) =>
      ['getScheduleManagerAccess', 'setScheduleManagerAccess'].includes(entry.name));
    assert.equal(appointmentCalls.length, 5);
    const gets = appointmentCalls.filter((entry) => entry.name === 'getScheduleManagerAccess');
    assert.ok(gets.length >= 3);
    assert.ok(gets.every((entry) => Object.keys(entry.payload || {}).length === 0));
    const writes = appointmentCalls.filter((entry) => entry.name === 'setScheduleManagerAccess');
    assert.deepEqual(writes.map((entry) => entry.payload), [
      { uid:'u_fire', enabled:true }, { uid:'u_fire', enabled:false }
    ]);
    const firestoreWrites = await hrPage.evaluate(() => window.__FIRESTORE_WRITES || []);
    assert.equal(firestoreWrites.some((entry) => String(entry.path).includes('schedule_access')), false);
  });
  await hr.close();

  const commander = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(commander, 'commander', { getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }] });
  const commanderPage = await commander.newPage();
  await commanderPage.goto(base, { waitUntil:'load' });
  await commanderPage.locator('#work:not(.hide)').waitFor();
  await test('a commander sees only the legacy transition and no appointment or edit control', async () => {
    assert.equal(await commanderPage.locator('#scheduleAccessCard').isVisible(), false);
    assert.equal(await commanderPage.locator('#legacyRotationCard').isVisible(), true);
    assert.equal(await commanderPage.locator('#btnRot').count(), 0);
    assert.equal(await commanderPage.locator('#scheduleManagementLink').isVisible(), false);
    const calls = await commanderPage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.some((entry) => entry.name === 'getScheduleManagerAccess'), false);
    assert.equal(calls.some((entry) => entry.name === 'setScheduleManagerAccess'), false);
  });
  await commander.close();

  const superContext = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(superContext, 'super', {
    getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:false } }],
    listUsersWithClaims:[{ data:{ users:[{
      uid:'u_other_station', full_name:'אור כהן', email:'hidden@example.test',
      claims:{ role:'firefighter', stationId:'other_station', districtId:'north' }
    }] } }],
    getScheduleManagerAccess:[
      { data:{ members:[{
        uid:'u_other_station', name:'אור כהן', primary_role:'firefighter', enabled:false
      }] } },
      { data:{ members:[{
        uid:'u_other_station', name:'אור כהן', primary_role:'firefighter', enabled:true
      }] } },
      { data:{ members:[{
        uid:'u_other_station', name:'אור כהן', primary_role:'firefighter', enabled:false
      }] } }
    ],
    setScheduleManagerAccess:[{ data:{ enabled:true } }, { data:{ enabled:false } }]
  });
  const superPage = await superContext.newPage();
  await superPage.goto(base, { waitUntil:'load' });
  await superPage.locator('#scheduleAccessCard:not(.hide)').waitFor();
  await test('a super administrator keeps the selected person in uid-only lookup after grant and revoke', async () => {
    assert.equal(await superPage.locator('#scheduleAccessCard').isVisible(), true);
    assert.match(await superPage.locator('#scheduleAccessState').textContent(), /בחר אדם/);
    await superPage.locator('#btnUsers').dispatchEvent('click');
    await superPage.locator('#rPick option[value="u_other_station"]').waitFor({ state:'attached' });
    await superPage.evaluate(() => {
      const picker = document.getElementById('rPick');
      picker.value = 'u_other_station';
      picker.dispatchEvent(new Event('change', { bubbles:true }));
    });
    await superPage.locator('#scheduleAccessPick option[value="u_other_station"]').waitFor({ state:'attached' });
    const calls = await superPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const lookup = calls.filter((entry) => entry.name === 'getScheduleManagerAccess').at(-1);
    assert.deepEqual(lookup && lookup.payload, { uid:'u_other_station' });
    assert.equal(Object.hasOwn(lookup.payload, 'stationId'), false);

    assert.equal(await superPage.locator('#btnScheduleAccessEnable').isEnabled(), true);
    await superPage.locator('#btnScheduleAccessEnable').dispatchEvent('click');
    await superPage.locator('#scheduleAccessMsg.ok').waitFor();
    assert.equal(await superPage.locator('#btnScheduleAccessDisable').isEnabled(), true);
    await superPage.locator('#btnScheduleAccessDisable').dispatchEvent('click');
    await superPage.locator('#scheduleAccessMsg.ok').waitFor();

    const refreshedCalls = await superPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const gets = refreshedCalls.filter((entry) => entry.name === 'getScheduleManagerAccess');
    assert.deepEqual(gets.map((entry) => entry.payload), [
      { uid:'u_other_station' }, { uid:'u_other_station' }, { uid:'u_other_station' }
    ]);
    const writes = refreshedCalls.filter((entry) => entry.name === 'setScheduleManagerAccess');
    assert.deepEqual(writes.map((entry) => entry.payload), [
      { uid:'u_other_station', enabled:true }, { uid:'u_other_station', enabled:false }
    ]);
    assert.equal(await superPage.locator('#rPick').inputValue(), 'u_other_station');
    assert.equal(await superPage.locator('#scheduleAccessPick').inputValue(), 'u_other_station');
  });
  await superContext.close();

  const appointed = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(appointed, 'firefighter', {
    getScheduleRuntimeStatus:[{ data:{ mode:'off', manager:true } }]
  });
  const appointedPage = await appointed.newPage();
  await appointedPage.goto(base, { waitUntil:'load' });
  await appointedPage.locator('#work:not(.hide)').waitFor();
  await test('a live appointment, not rank, gets only the new-management link', async () => {
    assert.equal(await appointedPage.locator('#legacyRotationCard').isVisible(), true);
    assert.equal(await appointedPage.locator('#scheduleAccessCard').isVisible(), false);
    assert.equal(await appointedPage.locator('#btnRot').count(), 0);
    assert.equal(await appointedPage.locator('#scheduleManagementLink').isVisible(), true);
    assert.equal(await appointedPage.locator('#legacyRotationManageLink').isVisible(), true);
    assert.equal(await appointedPage.locator('#legacyRotationManageLink').getAttribute('href'), './schedule-management.html');
    const calls = await appointedPage.evaluate(() => window.__CALLABLE_CALLS || []);
    const status = calls.find((entry) => entry.name === 'getScheduleRuntimeStatus');
    assert.deepEqual(status && status.payload, {});
    const firestoreWrites = await appointedPage.evaluate(() => window.__FIRESTORE_WRITES || []);
    assert.equal(firestoreWrites.length, 0);
  });
  await appointed.close();

  const legacySchedule = await browser.newContext({ viewport:{ width:1280, height:900 }, locale:'he-IL' });
  await prepare(legacySchedule, 'firefighter', {
    /* ⭐ P1-1 · המינוי חי, והמנוע `off`. ההכרעה כאן התהפכה: הזנת
     * חוקי תחנה ומקור **מותרת** ב-off, אחרת תחנה חדשה לא יכולה
     * להתחיל. מה שנשאר חסום הוא הרצה ופרסום. */
    getScheduleRuntimeStatus:[{ data:{ mode:'off', configured:false, manager:true, active:null } }],
    getScheduleManagerSetup:[{ data:{ mode:'off', configured:false, policy:null, source:null, people:[] } }],
    getMyScheduleV2:[{ data:legacyMine }],
    getStationScheduleRange:[{ data:legacyRange }, { data:legacyRange }]
  });
  const legacySchedulePage = await legacySchedule.newPage();
  await legacySchedulePage.goto(base.replace('/admin.html', '/schedule.html'), { waitUntil:'load' });
  await legacySchedulePage.waitForURL(/schedule-management\.html\?tab=station/);
  await legacySchedulePage.locator('#appMain:not(.hide)').waitFor();
  await legacySchedulePage.locator('#stationBoard .hcell').first().waitFor();
  await test('legacy schedule URL redirects to a server-mediated station schedule in off mode', async () => {
    assert.match(legacySchedulePage.url(), /schedule-management\.html\?tab=station/);
    assert.equal(await legacySchedulePage.locator('#availabilityView').isVisible(), false);
    assert.equal(await legacySchedulePage.locator('#scheduleTabs').isVisible(), true);
    assert.equal(await legacySchedulePage.locator('#stationView').isVisible(), true);
    assert.equal(await legacySchedulePage.locator('#mineTab').isVisible(), true);
    // הלשונית זמינה — אבל היא אינה הלשונית שאליה הכתובת מובילה.
    assert.equal(await legacySchedulePage.locator('#manageTab').isVisible(), true);
    assert.equal(await legacySchedulePage.locator('#manageView').isVisible(), false);
    assert.match(await legacySchedulePage.locator('#stationContent').textContent(), /משמרת א/);

    await legacySchedulePage.locator('[data-tab="mine"]').click();
    assert.equal(await legacySchedulePage.locator('#mineView').isVisible(), true);
    await legacySchedulePage.locator('#mineBoard .hcell').first().waitFor();
    assert.match(await legacySchedulePage.locator('#mineContent').textContent(), /טל חודרה/);

    const calls = await legacySchedulePage.evaluate(() => window.__CALLABLE_CALLS || []);
    assert.equal(calls.filter((entry) => entry.name === 'getScheduleRuntimeStatus').length, 1);
    assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 1);
    // ⭐ שתי הלשוניות חולקות קריאת טווח אחת לחודש.
    assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleRange').length, 1);
    assert.equal(calls.some((entry) => entry.name === 'respondToSchedule'), false);
    const firestoreWrites = await legacySchedulePage.evaluate(() => window.__FIRESTORE_WRITES || []);
    assert.equal(firestoreWrites.length, 0);
  });
  await legacySchedule.close();

  await test('legacy source has no direct schedule reads or writes and PWA points to the new page', async () => {
    const adminSource = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const legacySource = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.doesNotMatch(adminSource, /\b(setDoc|deleteDoc|writeBatch|serverTimestamp)\b/);
    assert.doesNotMatch(adminSource, /['"](?:rotations|shift_overrides)['"]/);
    assert.doesNotMatch(legacySource, /firebase-firestore|getFirestore|getDocs|collection\(|rotations|shift_overrides/);
    const shortcut = manifest.shortcuts.find((item) => item.short_name === 'סידור');
    assert.equal(shortcut && shortcut.url, './schedule-management.html?tab=station');
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

assert.equal(passed, 8);
console.log('\n8 admin schedule-access browser checks passed.');
