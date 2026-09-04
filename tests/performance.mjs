// מדידת זמן עד שמסך הנוכחות נהיה שימושי בחיבור איטי מדומה.
// הנתונים מקומיים וסינתטיים; כל קריאת Firestore מקבלת השהיה
// קבועה כדי לחשוף waterfall של בקשות סדרתיות.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const lagMs = 180;
const maxInteractiveMs = 1900;
const maxDataSpanMs = 1500;
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/attendance.html');
  const file = path.join(root, urlPath === '/' ? 'attendance.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('performance-server-address');
const port = address.port;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
await context.route('**/firebasejs/**', route => {
  const name = route.request().url().split('/').pop().split('?')[0];
  const file = path.join(stub, name);
  route.fulfill({ status:200, contentType:'text/javascript',
    body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
});
await context.route('**://fonts.googleapis.com/**', route =>
  route.fulfill({ status:200, contentType:'text/css', body:'' }));
await context.addInitScript(({ lag }) => {
  // A cold page has not received a user gesture, so callout.js must not try
  // to open an audio device while this benchmark measures attendance data.
  // Headless Chromium on Windows otherwise reports a synthetic activation;
  // new AudioContext() can then block its main thread for several seconds.
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: Object.freeze({ hasBeenActive:false, isActive:false })
  });
  window.__SMOKE_ROLE = 'super';
  window.__SMOKE_LAG = lag;
  window.__PERF_STARTED = Date.now();
}, { lag:lagMs });

const page = await context.newPage();
await page.goto('http://localhost:' + port + '/attendance.html', { waitUntil:'load' });
await page.locator('.days .btn').first().waitFor({ state:'visible', timeout:12000 });
const result = await page.evaluate(() => ({
  interactiveMs: Date.now() - window.__PERF_STARTED,
  dataRequests: window.__N || 0,
  dataSpanMs: (window.__TN || Date.now()) - (window.__T0 || Date.now()),
  dataEvents: (window.__DATA_EVENTS || []).map(event => ({
    path: event.path, started: event.started, finished: event.finished
  })),
  dataPaths: (window.__DATA_PATHS || []).slice(),
  compatibilityCalls: (window.__CALLABLE_CALLS || [])
    .filter(call => call && call.name === 'getEffectiveWorkdays')
    .map(call => call.payload),
  guardCalls: (window.__CALLABLE_CALLS || [])
    .filter(call => call && call.name === 'getMyGuardAttendance')
    .map(call => call.payload)
}));

console.log('Attendance slow-network benchmark');
console.log('lag per data request:', lagMs + 'ms');
console.log('time to usable report:', result.interactiveMs + 'ms');
console.log('data requests started:', result.dataRequests);
console.log('all data work span:', result.dataSpanMs + 'ms');

const criticalPaths = ['/users/stub-uid', '/config/board',
  '/shifts/C','/swaps','/sub_stations','/attendance','/monthly_reports/1_'];
const criticalEvents = result.dataEvents.filter(event =>
  criticalPaths.some(suffix => event.path.includes(suffix)));
const criticalStart = Math.min(...criticalEvents.map(event => event.started));
const criticalFinish = Math.max(...criticalEvents.map(event => event.finished));
const criticalDataSpanMs = criticalFinish - criticalStart;
const staticEvents = criticalEvents.filter(event =>
  ['/config/board','/shifts/C','/swaps','/sub_stations']
    .some(suffix => event.path.includes(suffix)));
const monthEvents = criticalEvents.filter(event =>
  ['/attendance','/monthly_reports/1_']
    .some(suffix => event.path.includes(suffix)));
const startSpread = events => Math.max(...events.map(event => event.started)) -
  Math.min(...events.map(event => event.started));
console.log('critical data span:', criticalDataSpanMs + 'ms');
let passed = result.interactiveMs <= maxInteractiveMs &&
             result.dataSpanMs <= maxDataSpanMs &&
             criticalDataSpanMs <= maxDataSpanMs;
console.log(passed
  ? '✓ attendance data sources load without a serial request waterfall'
  : '✗ attendance loading regressed to a serial request waterfall');

function check(ok, message) {
  passed = passed && !!ok;
  console.log((ok ? '✓ ' : '✗ ') + message);
}

check(!result.dataPaths.some(path => /\/guards$/.test(path)),
      'attendance does not read raw guard documents in the browser');
check(!result.dataPaths.some(path => /\/(?:rotations|shift_overrides)$/.test(path)),
      'attendance does not read raw legacy schedule documents in the browser');
criticalPaths.forEach(suffix => {
  check(result.dataPaths.some(p => p.includes(suffix)),
        'benchmark exercised ' + suffix);
});
check(staticEvents.length === 4 && startSpread(staticEvents) <= 50,
      'board, shift, swaps and sub-stations start in parallel');
check(monthEvents.length === 2 && startSpread(monthEvents) <= 50,
      'attendance and its monthly report start in parallel');
const initialRange = await page.evaluate(() => {
  const now = new Date();
  const year = now.getFullYear(), month = now.getMonth();
  const pad = value => String(value).padStart(2, '0');
  return {
    from: year + '-' + pad(month + 1) + '-01',
    to: year + '-' + pad(month + 1) + '-' + pad(new Date(year, month + 1, 0).getDate())
  };
});
check(result.compatibilityCalls.length === 1 &&
      JSON.stringify({ from:result.compatibilityCalls[0].from, to:result.compatibilityCalls[0].to }) === JSON.stringify(initialRange) &&
      JSON.stringify(result.compatibilityCalls[0].uids) === JSON.stringify(['stub-uid']) &&
      !Object.hasOwn(result.compatibilityCalls[0], 'sid') &&
      !Object.hasOwn(result.compatibilityCalls[0], 'station'),
      'attendance loads exactly the displayed month through one station-free callable');
check(result.guardCalls.length === 1 &&
      JSON.stringify(result.guardCalls[0]) === JSON.stringify(initialRange),
      'attendance asks the server for exactly the displayed month');

// שתי טעינות חודש בכוונה יוצאות יחד: הראשונה איטית והשנייה
// מהירה. אחרי שהאיטית חוזרת, הכותרת חייבת להישאר של האחרונה.
await page.waitForTimeout(lagMs + 120);
const monthStart = await page.locator('#moLabel').textContent();
const compatibilityBeforeMonthRace = await page.evaluate(() =>
  (window.__CALLABLE_CALLS || []).filter(call =>
    call && call.name === 'getEffectiveWorkdays').length);
await page.evaluate(() => {
  window.__SMOKE_LAG_PLAN = [
    700,700,700,700,
    40,40,40,40,40,40
  ];
  const next = document.getElementById('next');
  next.disabled = false; next.click();
  next.disabled = false; next.click();
});
await page.waitForTimeout(160);
const winningMonth = await page.locator('#moLabel').textContent();
await page.waitForTimeout(700);
const finalMonth = await page.locator('#moLabel').textContent();
check(winningMonth !== monthStart && finalMonth === winningMonth,
      'a slow older month cannot overwrite the latest month');
check(await page.locator('#work').getAttribute('aria-busy') === 'false',
      'month loading releases the busy state');
const compatibilityMonthRace = await page.evaluate(before =>
  (window.__CALLABLE_CALLS || []).filter(call =>
    call && call.name === 'getEffectiveWorkdays')
    .slice(before).map(call => call.payload), compatibilityBeforeMonthRace);
check(compatibilityMonthRace.length === 2 && compatibilityMonthRace.every(payload =>
  payload && /^\d{4}-\d{2}-01$/.test(payload.from) &&
  /^\d{4}-\d{2}-(?:28|29|30|31)$/.test(payload.to) &&
  !Object.hasOwn(payload, 'sid') && !Object.hasOwn(payload, 'station')),
      'each month navigation requests only that month and never a station selector');

// תחנת ברירת המחדל והאבטחות תלויות באדם שנבחר. קודם עוברים
// לאדם אחר וחוזרים בצורה רגילה, כדי לוודא שמידע של אדם קודם
// אינו משמש fallback גם כאשר שתי הטעינות הצליחו.
await page.locator('#pickWho option[value="17"]').waitFor({ state:'attached' });
const guardCallsBeforeOther = await page.evaluate(() =>
  (window.__CALLABLE_CALLS || []).filter(call => call && call.name === 'getMyGuardAttendance')
    .map(call => call.payload));
await page.selectOption('#pickWho', '17');
await page.evaluate(() => document.getElementById('pickGo').click());
await page.waitForFunction(() =>
  document.getElementById('work').getAttribute('aria-busy') === 'false' &&
  !document.getElementById('otherBar').classList.contains('hide'));
const otherSiteRow = (await page.locator('#rows tr.sug').first().textContent()) || '';
check(otherSiteRow.includes('שחמון') && !otherSiteRow.includes('ראשית'),
      'switching subject publishes that subject\'s default site');
const guardCallsAfterOther = await page.evaluate(() =>
  (window.__CALLABLE_CALLS || []).filter(call => call && call.name === 'getMyGuardAttendance')
    .map(call => call.payload));
check(guardCallsAfterOther.length === guardCallsBeforeOther.length,
      'opening another employee never fetches the viewer\'s guards into that report');

await page.evaluate(() => document.getElementById('pickBack').click());
await page.waitForFunction(() =>
  document.getElementById('work').getAttribute('aria-busy') === 'false' &&
  document.getElementById('otherBar').classList.contains('hide'));
const selfSiteRow = (await page.locator('#rows tr.sug').first().textContent()) || '';
check(selfSiteRow.includes('ראשית') && !selfSiteRow.includes('שחמון'),
      'returning to self clears the previous subject\'s default site');
const guardCallsAfterSelf = await page.evaluate(() =>
  (window.__CALLABLE_CALLS || []).filter(call => call && call.name === 'getMyGuardAttendance').map(call => call.payload));
check(guardCallsAfterSelf.length === guardCallsBeforeOther.length + 1 &&
      JSON.stringify(guardCallsAfterSelf[guardCallsAfterSelf.length - 1]) ===
        JSON.stringify(guardCallsBeforeOther[guardCallsBeforeOther.length - 1]),
      'returning to self restores only the current month of personal guards');

// שתי קריאות לאותו אדם ולאותו חודש: הראשונה מחזירה מידע ישן
// לאט, והשנייה מידע חדש מהר. רק החדשה רשאית להישאר במסך. כל יום
// מקבל גם ביטול לפני השורה הפעילה, כדי לבדוק שביטול ומיקום פרטי
// אינם מגיעים למילוי האוטומטי.
const guardRace = await page.evaluate(range => {
  const dates = [];
  const cursor = new Date(range.from + 'T00:00:00');
  const end = new Date(range.to + 'T00:00:00');
  const key = date => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') +
    '-' + String(date.getDate()).padStart(2, '0');
  while (cursor <= end) {
    dates.push(key(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  const rows = (title, place, includeCancelled) => dates.flatMap((date, index) => {
    const active = { id:'active_' + index, date, title, start:'10:00', end:'12:00',
      status:'open', place, future_secret:'never-render-me' };
    if (!includeCancelled) return [active];
    return [{ id:'cancelled_' + index, date, title:'CANCELLED MUST NOT WIN',
      start:'08:00', end:'09:00', status:'cancelled', place:'CANCELLED SECRET' }, active];
  });
  const manualDates = dates.filter(date => {
    const at = new Date(date + 'T12:00:00Z');
    const anchor = new Date('2026-01-01T12:00:00Z');
    const diff = Math.round((at - anchor) / 86400000);
    // Stub rotation: crew C works index 2 of a three-day cycle.
    return ((diff % 3) + 3) % 3 !== 2;
  });
  const before = (window.__CALLABLE_CALLS || []).filter(call =>
    call && call.name === 'getMyGuardAttendance').length;
  window.__CALLABLE_PLAN = {
    getMyGuardAttendance: [
      { delay:650, data:{ guards:rows('OLD GUARD MUST NOT WIN', 'OLD SECRET PLACE', false) } },
      { delay:20, data:{ guards:rows('NEW GUARD WINS', 'NEW SECRET PLACE', true) } }
    ]
  };
  const sync = document.getElementById('btnSync');
  sync.disabled = false; sync.click();
  sync.disabled = false; sync.click();
  return { before, range, manualDates };
}, guardCallsAfterSelf[guardCallsAfterSelf.length - 1]);
await page.waitForFunction(before => (window.__CALLABLE_CALLS || []).filter(call =>
  call && call.name === 'getMyGuardAttendance').length >= before + 2, guardRace.before);
await page.waitForTimeout(900);
const guardRacePayloads = await page.evaluate(before => (window.__CALLABLE_CALLS || []).filter(call =>
  call && call.name === 'getMyGuardAttendance').slice(before).map(call => call.payload), guardRace.before);
check(guardRacePayloads.length === 2 && guardRacePayloads.every(payload =>
  JSON.stringify(payload) === JSON.stringify(guardRace.range)),
      'same-month guard retries keep the exact requested range');
// קריאת פתע מדומה יכולה להישאר פתוחה מעל החלונית. היא נבדקת
// במסך ייעודי; כאן היא רק מסתירה את כפתור הסגירה של בדיקת המילוי.
await page.addStyleTag({ content:'#coWrap{display:none!important}' });
let guardAutoFill = null;
for (const date of guardRace.manualDates.slice(0, 4)) {
  await page.evaluate(chosenDate => {
    const NativeDate = window.Date;
    const fixed = new NativeDate(chosenDate + 'T12:00:00');
    class ManualDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixed.getTime()])); }
      static now() { return fixed.getTime(); }
    }
    window.Date = ManualDate;
    try {
      const button = document.getElementById('btnManual');
      button.disabled = false;
      button.click();
    } finally {
      window.Date = NativeDate;
    }
  }, date);
  await page.locator('#ov').waitFor({ state:'visible', timeout:3000 });
  const type = await page.locator('#dType').inputValue();
  const notes = await page.locator('#dNotes').inputValue();
  await page.locator('#dCancel').click({ force:true });
  await page.locator('#ov').waitFor({ state:'hidden', timeout:3000 });
  if (type === 'guard') { guardAutoFill = notes; break; }
}
check(guardAutoFill === 'NEW GUARD WINS',
      'the newest personal guards win; cancelled and stale guards do not autofill');
check(guardAutoFill !== null && !guardAutoFill.includes('SECRET PLACE'),
      'guard autofill does not expose a place or an extra response field');

// אותו תרחיש על אדם: מעבר לאדם אחר מתחיל לאט, וחזרה לעצמי
// מתחילה מהר. ההרצה הישנה אינה רשאית לפרסם או לפתוח loadMonth.
const beforeSubjectRace = await page.evaluate(() => window.__N || 0);
await page.evaluate(() => {
  window.__SMOKE_LAG_PLAN = [
    700,700,700,700,
    40,40,40,40,40,40
  ];
  const pick = document.getElementById('pickWho');
  pick.value = '17';
  const go = document.getElementById('pickGo');
  go.disabled = false; go.click();
  const back = document.getElementById('pickBack');
  back.disabled = false; back.click();
});
await page.waitForTimeout(950);
const subjectRace = await page.evaluate(before => {
  const paths = (window.__DATA_PATHS || []).slice(before);
  return {
    delta: (window.__N || 0) - before,
    monthReads: paths.filter(p => /\/attendance$|\/monthly_reports\//.test(p)).length,
    otherHidden: document.getElementById('otherBar').classList.contains('hide'),
    backHidden: document.getElementById('pickBack').classList.contains('hide'),
    busy: document.getElementById('work').getAttribute('aria-busy'),
    siteText: (document.querySelector('#rows tr.sug') || {}).textContent || ''
  };
}, beforeSubjectRace);
check(subjectRace.delta === 10 && subjectRace.monthReads === 2,
      'a stale subject load is discarded before starting a month load');
check(subjectRace.otherHidden && subjectRace.backHidden && subjectRace.busy === 'false',
      'the latest subject remains active after the stale load returns');
check(subjectRace.siteText.includes('ראשית') && !subjectRace.siteText.includes('שחמון'),
      'a stale subject cannot publish its default site');

// סנכרון מתחיל, אחריו המשתמש עובר חודש. הסנכרון הישן חוזר
// לפני טעינת החודש החדש ואסור לו להפעיל את עצמו או את שעון
// המשמרת בזמן שהמסך עדיין מחזיק נתונים מהחודש הקודם.
await page.evaluate(() => {
  window.__SMOKE_LAG_PLAN = new Array(4).fill(300).concat([700, 700]);
  const sync = document.getElementById('btnSync');
  sync.disabled = false; sync.click();
  const next = document.getElementById('next');
  next.disabled = false; next.click();
});
await page.waitForTimeout(420);
const duringMonthLoad = await page.evaluate(() => ({
  busy: document.getElementById('work').getAttribute('aria-busy'),
  syncDisabled: document.getElementById('btnSync').disabled,
  startDisabled: document.getElementById('btnStart').disabled,
  stopDisabled: document.getElementById('btnStop').disabled
}));
check(duringMonthLoad.busy === 'true' && duringMonthLoad.syncDisabled,
      'a stale sync cannot bypass the month busy state');
check(duringMonthLoad.startDisabled && duringMonthLoad.stopDisabled,
      'shift timer actions stay locked while a month is loading');
await page.waitForFunction(() =>
  document.getElementById('work').getAttribute('aria-busy') === 'false',
  null, { timeout:2500 });
check(await page.locator('#btnSync').isEnabled(),
      'the latest month load releases actions after publishing data');

await context.close();
await browser.close();
server.close();
process.exitCode = passed ? 0 : 1;
