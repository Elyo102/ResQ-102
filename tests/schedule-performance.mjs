// מסך הסידור הישן הוחלף בשער מעבר. בדיקה זו שומרת על תכונת
// הביצועים והאבטחה הרלוונטית: URL/PWA ישן מעביר במהירות למנוע החדש,
// שמציג את הסידור הישן רק דרך שני קוראי השרת המאובטחים.
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
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.json':'application/json'
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  const file = path.join(root, pathname === '/' ? 'schedule.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  response.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

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

const today = jerusalemDay();
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
    date:today, sub_station:'legacy_A', sub_station_label:'משמרת א',
    role:null, role_label:'צוות א', hours:null, shift:'משמרת א', qualifications:[],
    crew:[{ uid:'crew_1', person:'טל חודרה', role_label:'צוות א' }],
    change:null, answer:null, requires_answer:false
  }],
  events:[], pending_answers:0
};
// רצועת חודש שלם. זו הצורה שהמסך מבקש היום, וגם במצב off — כדי
// שהלוח לא יהיה ריק בדיוק במצב שהתחנה נמצאת בו.
const legacyRange = (() => {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value) => String(value).padStart(2, '0');
  const days = [];
  for (let index = 1; index <= last; index++) {
    const date = today.slice(0, 7) + '-' + pad(index);
    days.push(legacyDay(date, date === today));
  }
  return {
    mode:'off', active:true, source:'legacy', publication_id:null, revision:null,
    from:today.slice(0, 7) + '-01', to:today.slice(0, 7) + '-' + pad(last), days
  };
})();

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', (route) => {
    const moduleName = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, moduleName);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ mine, range }) => {
    window.__SMOKE_ROLE = 'firefighter';
    window.__CALLABLE_PLAN = {
      getScheduleRuntimeStatus:[{ data:{ mode:'off', configured:false, manager:false, active:null } }],
      getMyScheduleV2:[{ data:mine }],
      getStationScheduleRange:[{ data:range }, { data:range }]
    };
  }, { mine:legacyMine, range:legacyRange });

  const page = await context.newPage();
  const started = Date.now();
  await page.goto(base + '/schedule.html', { waitUntil:'load' });
  await page.waitForURL(/schedule-management\.html\?tab=station/, { timeout:5000 });
  await page.locator('#stationBoard .hcell').first().waitFor({ state:'visible', timeout:5000 });
  const elapsed = Date.now() - started;
  const calls = await page.evaluate(() => window.__CALLABLE_CALLS || []);

  assert.ok(elapsed < 5000, 'legacy redirect took ' + elapsed + 'ms');
  assert.equal(calls.filter((entry) => entry.name === 'getScheduleRuntimeStatus').length, 1);
  // הפאנל האישי נטען רק בלשונית שלו; רצועת החודש נקראת פעם אחת.
  assert.equal(calls.filter((entry) => entry.name === 'getMyScheduleV2').length, 0);
  assert.equal(calls.filter((entry) => entry.name === 'getStationScheduleRange').length, 1);
  assert.equal(calls.some((entry) => entry.name === 'getScheduleManagerSetup'), false);
  assert.equal(calls.some((entry) => entry.name === 'respondToSchedule'), false);
  assert.equal(await page.locator('#availabilityView').isVisible(), false);
  assert.equal(await page.locator('#scheduleTabs').isVisible(), true);
  assert.equal(await page.locator('#stationView').isVisible(), true);
  assert.equal(await page.locator('#mineTab').isVisible(), true);
  assert.equal(await page.locator('#manageTab').isVisible(), false);
  assert.match(await page.locator('#stationContent').textContent(), /משמרת א/);
  await page.locator('[data-tab="mine"]').click();
  assert.equal(await page.locator('#mineView').isVisible(), true);
  await page.locator('#mineBoard .hcell').first().waitFor({ state:'visible', timeout:5000 });
  assert.match(await page.locator('#mineContent').textContent(), /טל חודרה/);
  // ⭐ המעבר ללשונית האישית אינו קורא את הטווח שוב.
  const afterMine = await page.evaluate(() => window.__CALLABLE_CALLS || []);
  assert.equal(afterMine.filter((entry) => entry.name === 'getStationScheduleRange').length, 1);
  const firestoreWrites = await page.evaluate(() => window.__FIRESTORE_WRITES || []);
  assert.equal(firestoreWrites.length, 0);

  const legacySource = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
  assert.doesNotMatch(legacySource, /firebase-firestore|getFirestore|getDocs|collection\(|rotations|shift_overrides/);
  console.log('✓ legacy schedule redirect reached the server-mediated station view in ' + elapsed + 'ms');
  console.log('✓ legacy schedule shell performs no direct legacy Firestore reads or writes');
  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
