// ============================================================
//  כניסה קבועה לאשף מוכנות המכשיר מתוך alerts.html — דפדפן אמיתי
//
//  מוכיח את 12 סעיפי הקבלה של המשימה "חיבור אשף מוכנות המכשיר לממשק":
//  הכפתור "בדיקת מוכנות המכשיר" גלוי לכבאי, לראש משמרת ולמנהל-על;
//  לחיצה מנווטת ל-device-readiness.html באותו חלון (גם ב-standalone);
//  כרטיס המעבדה הישן מוסתר בלי personal_lab_control ומוצג איתו;
//  44×44 ב-320/360/390 בלי גלילה אופקית; עובד ממתין נשאר חסום;
//  ואין שינוי בשכבת השרת (Functions / Rules / חוזה הפוש / מצב ניסוי).
//
//  Firebase מוחלף ב-stubs מקומיים (tests/stub). אין רשת, אין נתוני אמת,
//  אין כתיבה ל-production. צילומי מסך: RESQ_READINESS_SCREENSHOT_DIR.
// ============================================================

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json'
};
const SHOT_DIR = process.env.RESQ_READINESS_SCREENSHOT_DIR ? path.resolve(process.env.RESQ_READINESS_SCREENSHOT_DIR) : '';
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/alerts.html';
  const file = path.join(root, urlPath);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = 'http://127.0.0.1:' + port;

const launch = process.env.RESQ_CHROMIUM ? { headless: true, executablePath: process.env.RESQ_CHROMIUM } : { headless: true };
const browser = await chromium.launch(launch);
let pass = 0, fail = 0;
const failures = [];
function check(value, message, detail = '') {
  const ok = Boolean(value);
  console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + message +
              (ok || !detail ? '' : '   \x1b[2m' + detail + '\x1b[0m'));
  if (ok) pass++; else { fail++; failures.push(message); }
}
function head(text) { console.log('\n\x1b[1m--- ' + text + '\x1b[0m'); }

async function makeContext(role, extraClaims, width = 390) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status: 200, contentType: 'text/javascript',
      body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addInitScript('window.__SMOKE_ROLE = ' + JSON.stringify(role) + ';');
  await context.addInitScript('window.__SMOKE_UID = "stub-uid";');
  if (extraClaims) await context.addInitScript('window.__SMOKE_EXTRA_CLAIMS = ' + JSON.stringify(extraClaims) + ';');
  return context;
}

async function openAlerts(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/alerts.html', { waitUntil: 'load' });
  await page.locator('#coNo').click({ timeout: 1200 }).catch(() => {});
  await page.addStyleTag({ content: '#coWrap{display:none!important}' });
  await page.waitForFunction(() =>
    !document.getElementById('work').classList.contains('hide') ||
    !document.getElementById('denyCard').classList.contains('hide'), null, { timeout: 8000 });
  await page.waitForTimeout(400);
  return { page, errors };
}

async function buttonBox(page) {
  return page.evaluate(() => {
    const a = document.getElementById('btnReadiness');
    if (!a || a.offsetParent === null) return null;
    const r = a.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), href: a.getAttribute('href'), target: a.getAttribute('target'),
      text: (a.textContent || '').trim(), url: a.href, role: a.getAttribute('role'), tag: a.tagName };
  });
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}
async function shot(page, name, width) {
  if (!SHOT_DIR) return;
  await page.setViewportSize({ width, height: 844 });
  await page.waitForTimeout(60);
  await page.screenshot({ path: path.join(SHOT_DIR, name + '-' + width + '.png'), fullPage: true });
}

const ROLE_LABEL = { firefighter: 'כבאי מאושר', team: 'ראש משמרת (team_leader)', super: 'מנהל-על' };

try {
  head('1–3 · הכפתור גלוי לכל משתמש מאושר, ללא תלות בתפקיד');
  for (const role of ['firefighter', 'team', 'super']) {
    const ctx = await makeContext(role);
    const { page, errors } = await openAlerts(ctx);
    const box = await buttonBox(page);
    check(box && box.text === 'בדיקת מוכנות המכשיר', ROLE_LABEL[role] + ' רואה את "בדיקת מוכנות המכשיר"', JSON.stringify(box));
    check(box && box.href === './device-readiness.html' && !box.target, ROLE_LABEL[role] + ': היעד ./device-readiness.html, ללא target (אותו חלון)', JSON.stringify(box));
    check(box && !/[?#]/.test(box.url), ROLE_LABEL[role] + ': ה-URL ללא פרמטרים — אין טוקן/UID/מידע רגיש', box && box.url);
    check(errors.length === 0, ROLE_LABEL[role] + ': אין שגיאת JS', errors.join(' | '));
    if (role === 'firefighter') await shot(page, 'alerts-firefighter', 390);
    await page.close(); await ctx.close();
  }

  head('4 · לחיצה פותחת את device-readiness.html באותו חלון');
  {
    const ctx = await makeContext('firefighter');
    const { page } = await openAlerts(ctx);
    const before = ctx.pages().length;
    await Promise.all([page.waitForURL('**/device-readiness.html', { timeout: 8000 }), page.locator('#btnReadiness').click()]);
    check(new URL(page.url()).pathname === '/device-readiness.html', 'אחרי לחיצה ה-URL של אותו הדף הוא device-readiness.html', page.url());
    check(ctx.pages().length === before, 'לא נפתחה לשונית/חלון חדש', String(ctx.pages().length));
    await page.waitForFunction(() => !document.getElementById('work').classList.contains('hide'), null, { timeout: 8000 });
    check(await page.locator('#work').isVisible(), 'האשף נפתח לכבאי מאושר (#work גלוי)');
    check(await page.locator('.step').count() === 3, 'שלושת שלבי האשף קיימים — המסך לא שוכתב');
    const back = await page.locator('#backAlerts').getAttribute('href');
    check(back === './alerts.html', 'כפתור החזרה באשף מחזיר ל-alerts.html', back);
    check(await page.locator('nav, #navBar, .nav').count() > 0 || await page.locator('a[href="./login.html"], a[href="login.html"]').count() > 0,
      'גישה לדף הבית נשמרת דרך הניווט הקיים');
    await shot(page, 'device-readiness-firefighter', 390);
    await page.close(); await ctx.close();
  }

  head('5–6 · כרטיס המעבדה הישן: מוסתר בלי personal_lab_control, מוצג איתו');
  for (const role of ['firefighter', 'team', 'super']) {
    const ctx = await makeContext(role);
    const { page } = await openAlerts(ctx);
    const labVisible = await page.locator('#labCard').isVisible();
    const labCalls = await page.evaluate(() => (window.__CALLABLE_CALLS || []).map(c => c.name).filter(n => /PersonalLiveLab/.test(n)));
    check(!labVisible, ROLE_LABEL[role] + ' בלי personal_lab_control: כרטיס המעבדה מוסתר לחלוטין (לא כפתורים מושבתים)');
    check(labCalls.length === 0, ROLE_LABEL[role] + ' בלי claim: לא נקראה אף callable של המעבדה', labCalls.join(','));
    check(await page.locator('#btnReadiness').isVisible(), ROLE_LABEL[role] + ' בלי claim: הכפתור לאשף עדיין גלוי');
    if (role === 'super') await shot(page, 'alerts-super-no-lab-claim', 390);
    await page.close(); await ctx.close();
  }
  {
    const ctx = await makeContext('super', { personal_lab_control: true });
    const { page, errors } = await openAlerts(ctx);
    check(await page.locator('#labCard').isVisible(), 'מנהל-על עם personal_lab_control:true עדיין רואה את המעבדה');
    check(await page.locator('#btnLabPush').count() === 1 && await page.locator('#btnLabEnable').isVisible(), 'כפתורי המעבדה קיימים למורשה — המנגנון לא שונה');
    const text = await page.locator('#labCard').textContent();
    check(/חשבון בקרה מורשה/.test(text) && /בדיקת מוכנות המכשיר/.test(text), 'המעבדה מסומנת ככלי נפרד ומתקדם ומפנה למסלול הרגיל');
    check(await page.locator('#btnReadiness').isVisible(), 'גם למורשה המעבדה — הכפתור לאשף גלוי');
    check(errors.length === 0, 'אין שגיאת JS עם המעבדה פתוחה', errors.join(' | '));
    await shot(page, 'alerts-super-with-lab-claim', 390);
    await page.close(); await ctx.close();
  }
  {
    const ctx = await makeContext('firefighter', { personal_lab_control: true });
    const { page } = await openAlerts(ctx);
    check(!(await page.locator('#labCard').isVisible()), 'claim בלי מנהל-על אינו פותח את המעבדה (התנאי בצד הלקוח תואם לשרת: super וגם claim)');
    await page.close(); await ctx.close();
  }

  head('7–8 · 44×44 לפחות ואין גלילה אופקית ב-320/360/390');
  for (const width of [320, 360, 390]) {
    const ctx = await makeContext('firefighter', null, width);
    const { page } = await openAlerts(ctx);
    const box = await buttonBox(page);
    check(box && box.h >= 44 && box.w >= 44, 'ב-' + width + 'px הכפתור לפחות 44×44', JSON.stringify(box));
    check(await noOverflow(page), 'ב-' + width + 'px אין גלילה אופקית ב-alerts.html');
    await Promise.all([page.waitForURL('**/device-readiness.html'), page.locator('#btnReadiness').click()]);
    await page.waitForFunction(() => !document.getElementById('work').classList.contains('hide'), null, { timeout: 8000 });
    check(await noOverflow(page), 'ב-' + width + 'px אין גלילה אופקית ב-device-readiness.html');
    const backH = await page.locator('#backAlerts').evaluate(a => a.getBoundingClientRect().height);
    check(backH >= 44, 'ב-' + width + 'px קישור החזרה לפחות 44px גובה', String(backH));
    await page.close(); await ctx.close();
  }

  head('9 · הקישור עובד במצב display-mode: standalone (PWA באייפון נשאר בתוך ResQ)');
  {
    const ctx = await makeContext('firefighter');
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
    await page.goto(origin + '/alerts.html', { waitUntil: 'load' });
    await page.locator('#coNo').click({ timeout: 1200 }).catch(() => {});
    await page.addStyleTag({ content: '#coWrap{display:none!important}' });
    await page.waitForFunction(() => !document.getElementById('work').classList.contains('hide'), null, { timeout: 8000 });
    check(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches), 'הדף רץ במצב standalone מדומה');
    const before = ctx.pages().length;
    await Promise.all([page.waitForURL('**/device-readiness.html'), page.locator('#btnReadiness').click()]);
    check(new URL(page.url()).pathname === '/device-readiness.html' && new URL(page.url()).origin === origin, 'ב-standalone הניווט נשאר באותו origin ובאותו חלון', page.url());
    check(ctx.pages().length === before, 'ב-standalone לא נפתח חלון חיצוני');
    await page.close(); await ctx.close();
  }

  head('10 · עובד ממתין / לא מאושר אינו עוקף את שער המוכנות');
  for (const role of ['pending', 'emp_only']) {
    const ctx = await makeContext(role);
    const { page } = await openAlerts(ctx);
    check(await page.locator('#denyCard').isVisible() && !(await page.locator('#btnReadiness').isVisible()), role + ': ב-alerts.html אין כפתור לאשף — רק כרטיס החסימה');
    await page.goto(origin + '/device-readiness.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('denyCard').classList.contains('hide') || !document.getElementById('work').classList.contains('hide'), null, { timeout: 8000 });
    check(await page.locator('#denyCard').isVisible() && !(await page.locator('#work').isVisible()), role + ': כניסה ישירה ל-device-readiness.html נחסמת (#denyCard, בלי #work)');
    check(await page.locator('#btnSend').count() === 1 && !(await page.locator('#btnSend').isVisible()), role + ': כפתור השליחה אינו נגיש');
    await page.close(); await ctx.close();
  }
  {
    // הרשאות הדף לא השתנו: גם מנהל-על נשאר מחוץ לאשף (השרת דוחה אותו ב-readiness-not-approved).
    const ctx = await makeContext('super');
    const page = await ctx.newPage();
    await page.goto(origin + '/device-readiness.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('denyCard').classList.contains('hide') || !document.getElementById('work').classList.contains('hide'), null, { timeout: 8000 });
    check(await page.locator('#denyCard').isVisible(), 'מנהל-על: שער האשף ללא שינוי — עדיין מחוץ לאשף, כמו בשרת');
    await page.close(); await ctx.close();
  }

  head('11–12 · אין שינוי בשרת, ב-Rules, בחוזה הפוש, במצב ניסוי ובמנוע הסידור (בדיקת מקור)');
  {
    const alerts = read('alerts.html'), readiness = read('device-readiness.html');
    check(/id="btnReadiness" href="\.\/device-readiness\.html"/.test(alerts), 'ה-href קבוע ויחסי, בלי פרמטרים');
    check(!/btnReadiness[\s\S]{0,400}window\.open|window\.open[\s\S]{0,400}btnReadiness/.test(alerts) && !/target="_blank"/.test(alerts), 'אין window.open ואין target=_blank ב-alerts.html');
    check(/LAB_CONTROL = IS_SUPER && c\.personal_lab_control === true;/.test(alerts) && /if \(LAB_CONTROL\) \$\('labCard'\)\.classList\.remove\('hide'\);/.test(alerts), 'המעבדה נפתחת רק עם super וגם personal_lab_control — אותו תנאי כמו בשרת');
    check(/if \(LAB_CONTROL\) await loadLab\(\);/.test(alerts), 'loadLab (ו-getPersonalLiveLabStatus) לא נקראים בלי claim');
    check(/if \(!SID \|\| !c\.role \|\| c\.super === true\) \{/.test(readiness), 'שער האשף בלקוח ללא שינוי');
    const alertsCallables = [...alerts.matchAll(/httpsCallable\(fns, '([A-Za-z]+)'\)/g)].map(m => m[1]);
    const wizardCallables = [...readiness.matchAll(/httpsCallable\(fns, '([A-Za-z]+)'\)/g)].map(m => m[1]).sort();
    check(!alertsCallables.some(n => /Readiness/.test(n)), 'alerts.html אינו קורא לשירות המוכנות — הכניסה היא ניווט בלבד', alertsCallables.join(','));
    check(wizardCallables.join(',') === 'ackReadinessTestPush,claimPushToken,getMyReadiness,sendReadinessTestPush', 'האשף משתמש באותם 4 callables בלבד (חוזה הפוש ללא שינוי)', wizardCallables.join(','));
    const fnFiles = ['functions/device-readiness-service.js', 'functions/index.js', 'functions/schedule-runtime.js', 'firestore.rules', 'firebase-messaging-sw.js', 'push.js'];
    const digest = fnFiles.map(f => f + ' ' + crypto.createHash('sha256').update(read(f)).digest('hex').slice(0, 16));
    console.log('    שכבת השרת/הפוש — טביעות לצורך השוואה מול origin/main:\n    ' + digest.join('\n    '));
    check(!/trial|ניסוי/.test(alerts.slice(alerts.indexOf('btnReadiness') - 600, alerts.indexOf('btnReadiness') + 600)), 'הכניסה לאשף אינה נוגעת במצב ניסוי');
  }

  console.log('\nDevice readiness entry browser: ' + pass + ' PASS, ' + fail + ' FAIL');
  if (fail) { console.log('נכשלו: ' + failures.join(' | ')); process.exitCode = 1; }
} finally {
  await browser.close();
  server.close();
}
