// ============================================================
//  בקרת שעות Shadow — תצוגת מוכנות בדפדפן אמיתי
// ============================================================
//  Firebase מוחלף ב-stubs מקומיים. הבדיקה אינה דורשת רשת,
//  אינה קוראת נתוני אמת ואינה יכולה לכתוב ל-production.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/attendance-shadow.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch();
let pass = 0, fail = 0;
const failures = [];

function check(value, message, detail = '') {
  const ok = Boolean(value);
  console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + message +
              (ok || !detail ? '' : '   \x1b[2m' + detail + '\x1b[0m'));
  if (ok) pass++;
  else { fail++; failures.push(message); }
}
function head(text) { console.log('\n\x1b[1m--- ' + text + '\x1b[0m'); }

function localMonth(){
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Jerusalem', year:'numeric', month:'2-digit'
  }).formatToParts(new Date()).reduce((out, part) => {
    out[part.type] = part.value; return out;
  }, {});
  return parts.year + '-' + parts.month;
}
function day(month, value) { return month + '-' + String(value).padStart(2, '0'); }
function shiftMonth(month, delta){
  const [year, value] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, value - 1 + delta, 1));
  return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
}

const month = localMonth();
const through = day(month, 3);
const baseStatus = {
  mode:'shadow', station_id:'eilat_102', generator_version:'v41a-1',
  last_run:{
    target_date:through, status:'complete', entry_count:31,
    completed_at:new Date().toISOString(),
    result_counts:{ ready_working:4, ready_off:17, conflict:10, warning:3 },
    conflict_counts:{
      missing_emp:2, missing_roster:2, missing_or_invalid_crew:1,
      missing_rotations:1, missing_standby_crews:1,
      swap_missing_swap_id:1, swap_missing_swap_party:1,
      missing_shift_assignment:8, missing_assignment:9,
      missing_station:3, missing_commander_start:1,
      '<img src=x onerror="window.__SHADOW_XSS=1">':4
    }
  }
};
const allGateReasons = [
  'future_period', 'no_snapshot_runs', 'no_snapshot_rows',
  'missing_snapshot_days', 'source_conflicts', 'identity_conflicts',
  'data_warnings', 'mismatches', 'uncomparable', 'pending',
  'exceptions_require_review'
];
const baseReport = {
  status:'complete', build_status:'complete', active_generation_id:'generation-safe',
  generator_version:'v41a-1', compared_through:through,
  snapshot_run_ids:['opaque-1','opaque-2'], missing_snapshot_days:[day(month, 1)],
  gate_pass:false, gate_reasons:allGateReasons,
  generated_at:new Date().toISOString(),
  totals:{
    planned_work_rows:22, exact_matches:0, pending:0, explained_exceptions:0,
    missing_attendance:0, mismatches:0, source_conflicts:26, identity_conflict:4
  }
};

async function makeContext({ role='super', status=baseStatus, report=baseReport,
                             viewport={ width:390, height:844 } } = {}) {
  const context = await browser.newContext({ viewport, locale:'he-IL', colorScheme:'light' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript(({ selectedRole, statusValue, reportValue }) => {
    window.__SMOKE_ROLE = selectedRole;
    window.__SHADOW_XSS = 0;
    window.__CALLABLE_PLAN = {
      getAttendanceShadowStatus:[{ data:statusValue }]
    };
    window.__SHADOW_REPORT = reportValue;
  }, { selectedRole:role, statusValue:status, reportValue:report });
  return context;
}

async function openPage(options){
  const context = await makeContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:' + port + '/attendance-shadow.html', { waitUntil:'load' });
  await page.locator('#main').waitFor({ state:'visible', timeout:10000 });
  await page.waitForFunction(() => document.querySelector('#modeState')?.textContent !== 'בודק…');
  await page.waitForFunction(() => !document.querySelector('#stats')?.textContent.includes('טוען דוח'));
  return { context, page, errors };
}

try {
  head('1 · צילום יומי, פעולות מתקנות והגנת XSS');
  const first = await openPage();
  const metricValues = await first.page.locator('#runMetrics .n').allTextContents();
  check(JSON.stringify(metricValues) === JSON.stringify(['4','17','10','3']),
        'ארבע תוצאות הצילום מוצגות בלי לסכום אזהרות', JSON.stringify(metricValues));
  const runMessage = await first.page.locator('#runMessage').textContent();
  check(runMessage.includes('31 עובדים') && runMessage.includes('עשויות לחפוף'),
        'המסך מסביר את בסיס העובדים ואת החפיפה');
  const conflictText = await first.page.locator('#runConflicts').textContent();
  for (const text of [
    'חסר מספר עובד', 'חסר ברשימת התחנה', 'שיוך משמרת חסר או לא תקין',
    'מחזור המשמרות לא הוגדר', 'בכוננות לא נבחרה משמרת',
    'להחלפה המאושרת חסר מזהה', 'בהחלפה המאושרת חסר אחד הצדדים',
    'לוח הציוות למשמרת לא נשמר', 'אין שיבוץ במשבצת ובתחנת קצה',
    'לא ניתן לקבוע תחנת קצה מהציוות', 'שעת תחילת מפקד המשמרת לא הוגדרה',
    'בעיות נוספות שדורשות בדיקה טכנית'
  ]) check(conflictText.includes(text), 'תורגם חוסר: ' + text);
  check(!conflictText.includes('<img') && !conflictText.includes('missing_emp'),
        'קוד פנימי או זדוני אינו מוצג למשתמש');
  const actions = await first.page.locator('#runActions li').allTextContents();
  check(actions.length === 8, 'פעולות התיקון מאוחדות ללא כפילות ציוות והחלפה', JSON.stringify(actions));
  check(actions.some(text => text.includes('מספר העובד')) &&
        actions.some(text => text.includes('רשימת התחנה')) &&
        actions.some(text => text.includes('משמרת תקינה')) &&
        actions.some(text => text.includes('מחזור המשמרות')) &&
        actions.some(text => text.includes('אירוע הכוננות')) &&
        actions.some(text => text.includes('רשומת ההחלפה')) &&
        actions.some(text => text.includes('מסך הציוות')) &&
        actions.some(text => text.includes('שעת תחילת')),
        'כל 11 החוסרים המוכרים מקבלים פעולה מעשית');
  check(await first.page.evaluate(() => window.__SHADOW_XSS) === 0,
        'מחרוזת XSS לא בוצעה');

  head('2 · כיסוי חודשי וכל סיבות החסימה');
  const coverageText = await first.page.locator('#coverage').textContent();
  check(coverageText.includes('2 מתוך 3 ימים') && coverageText.includes('חסרים 1'),
        'הכיסוי מחושב לפי ימים ולא לפי שורות אדם', coverageText);
  const expectedReasons = [
    'התקופה שנבחרה עדיין לא התחילה.', 'אין צילומי Shadow לתקופה שנבחרה.',
    'הצילומים אינם כוללים רשומות עובדים.', 'חסרים ימי צילום בתקופה שנבדקה.',
    'קיימות סתירות בסידור או בציוות.', 'קיימות בעיות זיהוי או קליטת עובדים.',
    'קיימות אזהרות נתונים שחוסמות אימות.',
    'נמצאו פערים בין הסידור לבין הדיווח בפועל.',
    'יש רשומות שלא ניתן להשוות בבטחה.', 'יש ימים שממתינים לדיווח.',
    'יש חריגים מוסברים שעדיין דורשים בדיקה.'
  ];
  const reasonItems = await first.page.locator('#gateReasons li').allTextContents();
  check(reasonItems.length === 11 && expectedReasons.every(text => reasonItems.includes(text)),
        'כל 11 סיבות השער מתורגמות', JSON.stringify(reasonItems));
  const readinessNote = await first.page.locator('#readinessNote').textContent();
  check(readinessNote.includes('יום עבר') && !readinessNote.includes('הרץ עכשיו'),
        'אין הבטחת backfill ליום צילום חסר');
  const factories = await first.page.evaluate(() => window.__CALLABLE_FACTORIES || []);
  const paths = await first.page.evaluate(() => window.__DATA_PATHS || []);
  check(JSON.stringify(factories) === JSON.stringify(['getAttendanceShadowStatus']),
        'לא נוסף callable חדש', JSON.stringify(factories));
  check(paths.length === 2 && paths.every(value => String(value).includes('attendance_shadow_')),
        'לא נוספה קריאת Firestore', JSON.stringify(paths));
  check((await first.page.evaluate(() => window.__FIRESTORE_WRITES || [])).length === 0,
        'המסך לא ביצע כתיבת Firestore');
  check(first.errors.length === 0, 'התרחיש הראשי לא יצר שגיאת דפדפן', first.errors.join(' · '));

  head('3 · מובייל ונגישות');
  const layout = await first.page.evaluate(() => {
    const panel = document.getElementById('runPanel');
    const readiness = document.getElementById('readiness');
    return {
      panel:panel.getBoundingClientRect().toJSON(),
      columns:getComputedStyle(document.getElementById('runMetrics')).gridTemplateColumns
        .split(' ').filter(Boolean).length,
      runLabel:panel.getAttribute('aria-labelledby'),
      live:panel.getAttribute('aria-live'),
      readinessLabel:readiness.getAttribute('aria-labelledby'),
      direction:getComputedStyle(document.documentElement).direction
    };
  });
  check(layout.panel.left >= 0 && layout.panel.right <= 390, 'הכרטיס נשאר בתוך מסך 390px');
  check(layout.columns === 2, 'במובייל תוצאות הריצה מוצגות בשתי עמודות');
  check(layout.runLabel === 'runTitle' && layout.live === 'polite' &&
        layout.readinessLabel === 'readinessTitle' && layout.direction === 'rtl',
        'כותרות ARIA, עדכון חי ו-RTL נשמרו');
  const screenshotPath = process.argv[2] || process.env.RESQ_SHADOW_SCREENSHOT;
  if (screenshotPath) {
    await first.page.screenshot({ path:screenshotPath, fullPage:true });
  }
  await first.context.close();

  head('4 · אין הצגת תוצאות חלקיות או פגומות');
  for (const state of ['building','failed','cancelled','future_state']) {
    const value = structuredClone(baseStatus);
    value.last_run.status = state;
    const opened = await openPage({ status:value, report:null });
    const hidden = await opened.page.locator('#runMetrics').evaluate(node => node.classList.contains('hide'));
    const body = await opened.page.locator('#runPanel').textContent();
    check(hidden && !body.includes('future_state'), 'סטטוס ' + state + ' אינו מציג תוצאה חלקית או קוד גולמי');
    check(opened.errors.length === 0, 'סטטוס ' + state + ' לא יצר שגיאת דפדפן', opened.errors.join(' · '));
    await opened.context.close();
  }
  const noRunStatus = structuredClone(baseStatus);
  noRunStatus.last_run = null;
  const noRun = await openPage({ status:noRunStatus, report:null });
  check(await noRun.page.locator('#runPanel').evaluate(node => node.classList.contains('hide')),
        'ללא צילום אחרון הכרטיס אינו מציג נתונים מומצאים');
  await noRun.context.close();
  const legacy = structuredClone(baseStatus);
  legacy.last_run.result_counts = { ready_working:-1, ready_off:17,
    conflict:1000001, warning:3 };
  const legacyOpen = await openPage({ status:legacy, report:{
    status:'complete', active_generation_id:'legacy', gate_pass:false,
    gate_reasons:['<img src=x onerror="window.__SHADOW_XSS=1">'], totals:{}
  }});
  check(await legacyOpen.page.locator('#runMetrics').evaluate(node => node.classList.contains('hide')) &&
        (await legacyOpen.page.locator('#runMessage').textContent()).includes('אינו זמין'),
        'ספירות legacy פגומות נכשלות בבטחה');
  check((await legacyOpen.page.locator('#coverage').textContent()).includes('אינו זמין'),
        'כיסוי legacy חסר אינו מוצג כאפס או כמאה אחוז');
  const legacyReasons = await legacyOpen.page.locator('#gateReasons').textContent();
  check(legacyReasons.includes('סיבה נוספת') && !legacyReasons.includes('<img'),
        'סיבת שער לא מוכרת מקבלת fallback עברי בטוח');
  check(await legacyOpen.page.evaluate(() => window.__SHADOW_XSS) === 0,
        'XSS לא בוצע גם בסיבת שער');
  check((await legacyOpen.page.locator('#stats').textContent()).includes('—'),
        'שדות ספירה חסרים מוצגים כלא זמינים ולא כאפס');
  await legacyOpen.context.close();
  const inconsistentReport = structuredClone(baseReport);
  inconsistentReport.snapshot_run_ids = ['only-one'];
  inconsistentReport.missing_snapshot_days = [];
  const inconsistent = await openPage({ report:inconsistentReport });
  check((await inconsistent.page.locator('#coverage').textContent()).includes('אינו זמין'),
        'כיסוי שאינו תואם לתאריך נכשל בבטחה');
  inconsistentReport.gate_pass = true;
  inconsistentReport.gate_reasons = [];
  await inconsistent.page.evaluate(report => {
    window.__SHADOW_REPORT_PLAN = [{ data:report, delay:0 }];
    document.getElementById('btnLoad').click();
  }, inconsistentReport);
  await inconsistent.page.waitForFunction(() =>
    !document.querySelector('#stats')?.textContent.includes('טוען דוח'));
  check((await inconsistent.page.locator('#readinessTitle').textContent()).includes('חוסם'),
        'כיסוי לא תקין אינו יכול להציג שער ירוק גם אם gate_pass סומן');
  await inconsistent.context.close();

  const missingCoverageReport = structuredClone(baseReport);
  missingCoverageReport.gate_pass = true;
  missingCoverageReport.gate_reasons = [];
  const missingCoverage = await openPage({ report:missingCoverageReport });
  check((await missingCoverage.page.locator('#readinessTitle').textContent()).includes('חוסם'),
        'שער עם יום צילום חסר נשאר אדום גם מול gate_pass סותר');
  await missingCoverage.context.close();

  const contradictoryStatus = structuredClone(baseStatus);
  contradictoryStatus.last_run.result_counts = {
    ready_working:14, ready_off:17, conflict:0, warning:3
  };
  const contradictory = await openPage({ status:contradictoryStatus });
  check(await contradictory.page.locator('#runConflicts').evaluate(node =>
          node.classList.contains('hide')) &&
        await contradictory.page.locator('#runActions').evaluate(node =>
          node.classList.contains('hide')),
        'פירוט תקלה חיובי נבלם כאשר מספר העובדים בתקלה הוא אפס');
  await contradictory.context.close();

  const undercountStatus = structuredClone(baseStatus);
  undercountStatus.last_run.conflict_counts = { missing_emp:2 };
  const undercount = await openPage({ status:undercountStatus });
  const undercountText = await undercount.page.locator('#runConflicts').textContent();
  check(undercountText.includes('פירוט הבעיות אינו זמין') &&
        !undercountText.includes('חסר מספר עובד') &&
        await undercount.page.locator('#runActions').evaluate(node =>
          node.classList.contains('hide')),
        'פירוט שמכסה רק 2 מתוך 10 עובדים נכשל סגור ללא פעולה מטעה');
  await undercount.context.close();

  const overlapStatus = structuredClone(baseStatus);
  overlapStatus.last_run.result_counts = {
    ready_working:12, ready_off:17, conflict:2, warning:3
  };
  overlapStatus.last_run.conflict_counts = { missing_emp:2, missing_roster:2 };
  const overlap = await openPage({ status:overlapStatus });
  const overlapText = await overlap.page.locator('#runConflicts').textContent();
  check(overlapText.includes('חסר מספר עובד: 2') &&
        overlapText.includes('חסר ברשימת התחנה: 2') &&
        await overlap.page.locator('#runActions li').count() === 2,
        'פירוט חופף שסכומו גדול ממספר העובדים נשאר תקין');
  await overlap.context.close();

  head('5 · שער שעבר אינו מפעיל אוטומציה');
  const passedReport = structuredClone(baseReport);
  passedReport.gate_pass = true;
  passedReport.gate_reasons = [];
  passedReport.snapshot_run_ids = ['one','two','three'];
  passedReport.missing_snapshot_days = [];
  const passedOpen = await openPage({ report:passedReport });
  check((await passedOpen.page.locator('#readinessTitle').textContent()).includes('עברה'),
        'שער תקין מוצג כהצלחה');
  const passedNote = await passedOpen.page.locator('#readinessNote').textContent();
  check(passedNote.includes('אינו מפעיל שעות אוטומטיות') && passedNote.includes('אינו מאשר שכר'),
        'הצלחה אינה מוצגת כאישור הפעלה או שכר');
  await passedOpen.context.close();

  head('6 · מעבר חודש אינו מאפשר לתשובה ישנה לדרוס חדשה');
  const race = await openPage();
  const oldMonth = shiftMonth(month, -2), newMonth = shiftMonth(month, -1);
  const raceReport = (mk, exact) => ({
    status:'complete', active_generation_id:'g-' + exact, build_status:'complete',
    generator_version:'v41a-1', compared_through:day(mk, 1),
    snapshot_run_ids:['r-' + exact], missing_snapshot_days:[],
    gate_pass:true, gate_reasons:[], generated_at:new Date().toISOString(),
    totals:{ planned_work_rows:exact, exact_matches:exact, pending:0,
      explained_exceptions:0, missing_attendance:0, mismatches:0,
      source_conflicts:0, identity_conflict:0 }
  });
  await race.page.evaluate(({ firstMonth, secondMonth, firstReport, secondReport }) => {
    window.__SHADOW_REPORT_PLAN = [
      { data:firstReport, delay:220 }, { data:secondReport, delay:0 }
    ];
    const input = document.getElementById('month');
    input.value = firstMonth; document.getElementById('btnLoad').click();
    input.value = secondMonth; document.getElementById('btnLoad').click();
  }, { firstMonth:oldMonth, secondMonth:newMonth,
       firstReport:raceReport(oldMonth, 111), secondReport:raceReport(newMonth, 222) });
  await race.page.waitForTimeout(350);
  check((await race.page.locator('#stats .stat').nth(1).locator('.n').textContent()) === '222',
        'החודש החדש נשאר מוצג אחרי תשובה ישנה ואיטית');
  check((await race.page.locator('#coverage').textContent()).includes('1 מתוך 1 ימים'),
        'כיסוי החודש החדש נשאר עקבי');

  const rejectedOldMonth = shiftMonth(month, -4), acceptedNewMonth = shiftMonth(month, -3);
  await race.page.evaluate(({ firstMonth, secondMonth, secondReport }) => {
    window.__SHADOW_REPORT_PLAN = [
      { reject:true, code:'firestore/unavailable', delay:220 },
      { data:secondReport, delay:0 }
    ];
    const input = document.getElementById('month');
    input.value = firstMonth; document.getElementById('btnLoad').click();
    input.value = secondMonth; document.getElementById('btnLoad').click();
  }, { firstMonth:rejectedOldMonth, secondMonth:acceptedNewMonth,
       secondReport:raceReport(acceptedNewMonth, 333) });
  await race.page.waitForTimeout(350);
  check((await race.page.locator('#stats .stat').nth(1).locator('.n').textContent()) === '333' &&
        (await race.page.locator('#coverage').textContent()).includes('1 מתוך 1 ימים'),
        'כשל ישן ואיטי אינו מוחק דוח חדש שכבר הוצג');
  check(race.errors.length === 0, 'מרוץ מעבר חודש לא יצר שגיאת דפדפן', race.errors.join(' · '));
  await race.context.close();

  head('7 · כשל ישן בחריגי אנשים אינו דורס חודש חדש');
  const peopleRace = await openPage();
  const peopleOldMonth = shiftMonth(month, -6), peopleNewMonth = shiftMonth(month, -5);
  const latestIssue = [{ date:day(peopleNewMonth, 1), state:'mismatch',
    codes:['hours_mismatch'], planned_hours:333, actual_hours:3 }];
  await peopleRace.page.evaluate(({ firstMonth, firstReport, secondReport, issues }) => {
    window.__SHADOW_REPORT_PLAN = [
      { data:firstReport, delay:0 }, { data:secondReport, delay:0 }
    ];
    window.__SHADOW_PEOPLE_PLAN = [
      { reject:true, code:'firestore/unavailable', delay:220 },
      { data:[['u2', { home_crew:'B', issue_count:1,
        issues:issues }]], delay:0 }
    ];
    window.__SHADOW_PEOPLE_STARTED = [];
    const input = document.getElementById('month');
    input.value = firstMonth;
    document.getElementById('btnLoad').click();
  }, { firstMonth:peopleOldMonth, firstReport:raceReport(peopleOldMonth, 444),
       secondReport:raceReport(peopleNewMonth, 555), issues:latestIssue });
  await peopleRace.page.waitForFunction(() =>
    (window.__SHADOW_PEOPLE_STARTED || []).length === 1);
  await peopleRace.page.evaluate(secondMonth => {
    const input = document.getElementById('month');
    input.value = secondMonth;
    document.getElementById('btnLoad').click();
  }, peopleNewMonth);
  await peopleRace.page.waitForFunction(() =>
    document.getElementById('people')?.textContent.includes('333'));
  await peopleRace.page.waitForTimeout(300);
  const peopleAfterStaleFailure = await peopleRace.page.locator('#people').textContent();
  check(peopleAfterStaleFailure.includes('333') &&
        !peopleAfterStaleFailure.includes('טעינת החריגים נכשלה') &&
        !(await peopleRace.page.locator('#btnMore').isDisabled()),
        'כשל שאילתת אנשים ישן אינו מוחק את נתוני החודש החדש');

  const currentFailMonth = shiftMonth(month, -7);
  await peopleRace.page.evaluate(({ selectedMonth, selectedReport }) => {
    window.__SHADOW_REPORT_PLAN = [{ data:selectedReport, delay:0 }];
    window.__SHADOW_PEOPLE_PLAN = [
      { reject:true, code:'permission-denied', delay:0 }
    ];
    const input = document.getElementById('month');
    input.value = selectedMonth;
    document.getElementById('btnLoad').click();
  }, { selectedMonth:currentFailMonth,
       selectedReport:raceReport(currentFailMonth, 666) });
  await peopleRace.page.waitForFunction(() =>
    document.getElementById('people')?.textContent.includes('טעינת החריגים נכשלה'));
  check((await peopleRace.page.locator('#people').textContent()).includes('permission-denied'),
        'כשל בשאילתת האנשים העדכנית עדיין מוצג למפעיל');
  check(peopleRace.errors.length === 0,
        'מרוץ חריגי האנשים לא יצר שגיאת דפדפן', peopleRace.errors.join(' · '));
  await peopleRace.context.close();

  head('8 · משתמש חסום אינו קורא נתוני Shadow');
  const deniedContext = await makeContext({ role:'firefighter' });
  const deniedPage = await deniedContext.newPage();
  await deniedPage.goto('http://127.0.0.1:' + port + '/attendance-shadow.html', { waitUntil:'load' });
  await deniedPage.locator('#deny').waitFor({ state:'visible', timeout:10000 });
  check((await deniedPage.evaluate(() => window.__CALLABLE_FACTORIES || [])).length === 0,
        'כבאי חסום אינו יוצר callable');
  check((await deniedPage.evaluate(() => window.__DATA_PATHS || [])).length === 0,
        'כבאי חסום אינו קורא דוח Firestore');
  await deniedContext.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('\n' + (fail ? '✗ ' + fail + ' נכשלו' : '✓ כל ' + pass +
  ' בדיקות תצוגת Shadow עברו') + '\n');
if (failures.length) console.log('כשלים: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
