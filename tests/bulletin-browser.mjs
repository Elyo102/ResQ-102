// ============================================================
//  לוח מודעות — מסלול משתמש בדפדפן אמיתי
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
let port = 0;
const types = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json',
  '.jpg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/login.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type':types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
port = server.address().port;

const browser = await chromium.launch();
let pass = 0;
let fail = 0;
const failures = [];

function check(value, message, detail = '') {
  const ok = Boolean(value);
  console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + message +
              (ok || !detail ? '' : '   \x1b[2m' + detail + '\x1b[0m'));
  if (ok) pass++;
  else { fail++; failures.push(message); }
}
function head(text) { console.log('\n\x1b[1m--- ' + text + '\x1b[0m'); }

async function makeContext(options = {}) {
  const contextOptions = {
    viewport:options.viewport || { width:390, height:844 },
    locale:'he-IL',
    colorScheme:options.colorScheme || 'light',
    reducedMotion:options.reducedMotion || 'no-preference'
  };
  if (options.storageState) contextOptions.storageState = options.storageState;
  const context = await browser.newContext(contextOptions);
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({
      status:200,
      contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};'
    });
  });
  await context.route('**://fonts.googleapis.com/**', route =>
    route.fulfill({ status:200, contentType:'text/css', body:'' }));
  await context.addInitScript('window.__SMOKE_ROLE = ' + JSON.stringify(options.role || 'super') + ';');
  await context.addInitScript('window.__SMOKE_UID = ' + JSON.stringify(options.uid || 'stub-uid') + ';');
  if (options.init) await context.addInitScript(options.init);
  return context;
}

async function dismissStubCallout(page) {
  await page.locator('#coNo').click({ timeout:1200 }).catch(() => {});
  // הגנה מפני stub ישן שבו הכפתור אינו סוגר את הכיסוי.
  await page.addStyleTag({ content:'#coWrap{display:none!important}' });
}

async function openBoard(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:' + port + '/login.html', { waitUntil:'load' });
  // קריאת הפתע המדומה נבדקת במסלול ייעודי אחר. כאן סוגרים אותה
  // כמשתמש ואז בוחנים את פעולות הלוח עצמו.
  await dismissStubCallout(page);
  await page.locator('#bulletinBoard').waitFor({ state:'visible', timeout:10000 });
  await page.locator('#boardTabs [data-board-id="rashit"]').waitFor({ state:'visible', timeout:10000 });
  return { page, errors };
}

async function bulletinActiveListeners(page) {
  return page.evaluate(() => Object.entries(window.__FIRESTORE_ACTIVE_PATHS || {})
    .filter(([p]) => p.endsWith('/bulletin_messages'))
    .reduce((sum, [,n]) => sum + Number(n || 0), 0));
}

async function bulletinReplyActiveListeners(page) {
  return page.evaluate(() => Object.entries(window.__FIRESTORE_ACTIVE_PATHS || {})
    .filter(([p]) => p.endsWith('/bulletin_replies'))
    .reduce((sum, [,n]) => sum + Number(n || 0), 0));
}

function browserDraftKey(uid, stationId, boardId) {
  return 'resq_bulletin_draft:v2:' + [uid, stationId, boardId]
    .map(value => encodeURIComponent(String(value || ''))).join(':');
}

try {
  // ----------------------------------------------------------
  head('1 · כניסה, fade ועליית הלוח');
  // ----------------------------------------------------------
  const loginContext = await makeContext({ role:'none' });
  const loginPage = await loginContext.newPage();
  const loginErrors = [];
  loginPage.on('pageerror', e => loginErrors.push(e.message));
  await loginPage.goto('http://localhost:' + port + '/login.html', { waitUntil:'load' });
  await loginPage.locator('#authView').waitFor({ state:'visible', timeout:8000 });
  await loginPage.evaluate(() => {
    window.__LOGIN_MOTION = [];
    const auth = document.getElementById('authView');
    const home = document.getElementById('homeView');
    const record = () => {
      const a = getComputedStyle(auth);
      const h = getComputedStyle(home);
      window.__LOGIN_MOTION.push({
        authClass:auth.className, homeClass:home.className,
        authTransition:a.transitionDuration, authAnimation:a.animationDuration,
        homeTransition:h.transitionDuration, homeAnimation:h.animationDuration
      });
    };
    new MutationObserver(record).observe(auth, { attributes:true, attributeFilter:['class','style'] });
    new MutationObserver(record).observe(home, { attributes:true, attributeFilter:['class','style'] });
    record();
  });
  await loginPage.locator('#loginEmp').fill('1');
  await loginPage.locator('#loginPass').fill('123456');
  await loginPage.locator('#btnLogin').click();
  await loginPage.locator('#bulletinBoard').waitFor({ state:'visible', timeout:10000 });
  const motion = await loginPage.evaluate(() => window.__LOGIN_MOTION || []);
  const seconds = value => String(value || '').split(',').some(part => parseFloat(part) > 0);
  check(motion.length >= 2, 'המעבר החליף מצבים בין הכניסה ללוח');
  check(motion.some(s => seconds(s.authTransition) || seconds(s.authAnimation) ||
                         seconds(s.homeTransition) || seconds(s.homeAnimation)),
        'המעבר כולל fade/animation שאפשר למדוד');
  check(loginErrors.length === 0, 'הכניסה והמעבר לא יצרו שגיאת קוד', loginErrors.join(' · '));
  await loginContext.close();

  // ----------------------------------------------------------
  head('2 · הרשאה ברורה למי שאינו חבר תחנה');
  // ----------------------------------------------------------
  const districtContext = await makeContext({ role:'district' });
  const districtPage = await districtContext.newPage();
  const districtErrors = [];
  districtPage.on('pageerror', e => districtErrors.push(e.message));
  await districtPage.goto('http://localhost:' + port + '/login.html', { waitUntil:'load' });
  await dismissStubCallout(districtPage);
  await districtPage.locator('#bulletinBoard').waitFor({ state:'visible', timeout:10000 });
  await districtPage.getByText('לוח המודעות זמין לחברי התחנה בלבד.', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  check(!await districtPage.locator('#bulletinCompose').isVisible(),
        'מפקד מחוז אינו מקבל כפתור פרסום מטעה');
  check(await districtPage.locator('#boardTabs [data-board-id]').count() === 0,
        'מפקד מחוז אינו מקבל ארבעה לוחות fallback');
  check(!await districtPage.locator('#bulletinFeed').isVisible(),
        'מפקד מחוז אינו מקבל פיד חסום');
  const districtQueries = await districtPage.evaluate(() => window.__FIRESTORE_QUERIES || []);
  check(!districtQueries.some(q => String(q.path || '').endsWith('/sub_stations')),
        'מפקד מחוז אינו קורא תחנות משנה');
  check(await bulletinActiveListeners(districtPage) === 0,
        'מפקד מחוז אינו פותח listener ללוח');
  const districtFactories = await districtPage.evaluate(() => window.__CALLABLE_FACTORIES || []);
  check(!districtFactories.includes('postBulletinMessage') &&
        !districtFactories.includes('hideBulletinMessage'),
        'מפקד מחוז אינו יוצר callable של לוח המודעות');
  check(districtErrors.length === 0, 'מצב מפקד מחוז לא יצר שגיאת קוד', districtErrors.join(' · '));
  await districtContext.close();

  // ----------------------------------------------------------
  head('3 · קריאת תגובות לחבר תחנה והרשאות תפקיד מדויקות');
  // ----------------------------------------------------------
  const memberContext = await makeContext({ role:'firefighter' });
  const memberBoard = await openBoard(memberContext);
  const memberPage = memberBoard.page;
  await memberPage.locator('#bulletinFeed [data-message-id="br2"]')
    .waitFor({ state:'visible', timeout:8000 });
  await memberPage.locator('#bulletinCompose').click();
  check(!await memberPage.locator('#bulletinAudience').isVisible(),
        'כבאי רגיל אינו רואה אפשרות הפצה לכל התחנות');
  check(await memberPage.locator('[data-testid="bulletin-reply-action"]').count() === 0,
        'כבאי רגיל אינו רואה פעולת כתיבת תגובה');
  const memberFactories = await memberPage.evaluate(() => window.__CALLABLE_FACTORIES || []);
  check(memberFactories.includes('postBulletinMessage') &&
        !memberFactories.includes('broadcastBulletinMessage') &&
        !memberFactories.includes('replyToBulletinMessage') &&
        !memberFactories.includes('hideBulletinMessage') &&
        !memberFactories.includes('hideBulletinReply'),
        'הדפדפן של כבאי יוצר רק את פעולת הפרסום הרגילה');
  check(await bulletinReplyActiveListeners(memberPage) === 0,
        'תגובות אינן נטענות לפני פתיחת הדיון');

  const memberThreadMessage = memberPage.locator('[data-message-id="br2"]');
  await memberThreadMessage.locator('[data-testid="bulletin-replies-toggle"]').click();
  await memberPage.waitForFunction(() =>
    document.querySelectorAll('[data-message-id="br2"] [data-testid="bulletin-reply"]').length === 2);
  const memberToggleControls = await memberThreadMessage
    .locator('[data-testid="bulletin-replies-toggle"]').getAttribute('aria-controls');
  check(Boolean(memberToggleControls) &&
        await memberPage.locator('#' + memberToggleControls).count() === 1,
        'כפתור הצגת התגובות מחובר לדיון הנכון עבור קורא מסך');
  check(await bulletinReplyActiveListeners(memberPage) === 1,
        'פתיחת דיון מפעילה מאזין תגובות יחיד');
  const memberReplies = await memberThreadMessage
    .locator('[data-testid="bulletin-reply"]').allTextContents();
  check(memberReplies[0]?.includes('קיבלתי, אטפל') &&
        memberReplies[1]?.includes('<svg onload='),
        'התגובות מוצגות מהישנה לחדשה לכל חבר תחנה');
  check(!memberReplies.some(text => text.includes('תגובה מוסתרת')),
        'תגובה מוסתרת אינה מוצגת');
  check(await memberThreadMessage.locator('svg').count() === 0 &&
        await memberPage.evaluate(() => window.__BULLETIN_REPLY_XSS !== 1),
        'HTML זדוני בתגובה נשאר טקסט ואינו מורץ');
  await memberPage.evaluate(async () => {
    await window.__FIRESTORE_PUSH_BULLETIN_REPLY({
      boardId:'rashit', messageId:'br2', id:'brr-live',
      text:'עדכון תגובה חי', iso:'2099-01-01T12:02:00.000Z'
    });
  });
  await memberPage.getByText('עדכון תגובה חי', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  check(await memberThreadMessage.locator('[data-testid="bulletin-reply"]').count() === 3,
        'תגובה חדשה מגיעה בזמן אמת בלי רענון המסך');
  await memberThreadMessage.locator('[data-testid="bulletin-replies-toggle"]').click();
  await memberPage.waitForFunction(() => Object.entries(window.__FIRESTORE_ACTIVE_PATHS || {})
    .filter(([p]) => p.endsWith('/bulletin_replies'))
    .every(([,n]) => Number(n || 0) === 0));
  check(await bulletinReplyActiveListeners(memberPage) === 0,
        'סגירת הדיון מבטלת את מאזין התגובות');
  check(await memberPage.evaluate(() => {
    const active = document.activeElement;
    return active?.matches('[data-message-id="br2"] [data-testid="bulletin-replies-toggle"]') &&
      active.getAttribute('aria-expanded') === 'false';
  }), 'סגירת הדיון מחזירה את המיקוד לכפתור שפתח אותו');

  const pagedMessage = memberPage.locator('[data-message-id="br1"]');
  await pagedMessage.locator('[data-testid="bulletin-replies-toggle"]').click();
  await memberPage.waitForFunction(() =>
    document.querySelectorAll('[data-message-id="br1"] [data-testid="bulletin-reply"]').length === 20);
  await pagedMessage.locator('.bulletin-reply-more').waitFor({ state:'visible', timeout:5000 });
  await memberPage.evaluate(() => { window.__SMOKE_LAG_PLAN = [300]; });
  await pagedMessage.locator('.bulletin-reply-more').click();
  await memberPage.waitForTimeout(30);
  await memberPage.evaluate(async () => {
    await window.__FIRESTORE_PUSH_BULLETIN_REPLY({
      boardId:'rashit', messageId:'br1', id:'br1-reply-live',
      text:'תגובה חדשה בזמן טעינת עבר', iso:'2099-01-01T12:03:00.000Z'
    });
  });
  await memberPage.getByText('תגובה חדשה בזמן טעינת עבר', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  await memberPage.waitForTimeout(350);
  check(await pagedMessage.locator('[data-testid="bulletin-reply"]').count() === 20,
        'עדכון חי מבטל עמוד תגובות ישן שעדיין היה בדרך');
  await pagedMessage.locator('.bulletin-reply-more').click();
  await memberPage.waitForFunction(() =>
    document.querySelectorAll('[data-message-id="br1"] [data-testid="bulletin-reply"]').length === 26);
  check(await pagedMessage.locator('[data-testid="bulletin-reply"]').count() === 26,
        'טעינה חוזרת מוסיפה את כל תגובות העבר פעם אחת בלבד');
  await pagedMessage.locator('[data-testid="bulletin-replies-toggle"]').click();
  await pagedMessage.locator('[data-testid="bulletin-replies-toggle"]').click();
  await memberPage.waitForFunction(() =>
    document.querySelectorAll('[data-message-id="br1"] [data-testid="bulletin-reply"]').length === 20);
  await memberPage.evaluate(() => { window.__SMOKE_LAG_PLAN = [300]; });
  await pagedMessage.locator('.bulletin-reply-more').click();
  await memberPage.waitForTimeout(30);
  await memberPage.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await memberPage.waitForFunction(() => {
    const button = document.querySelector(
      '[data-message-id="br1"] .bulletin-reply-more'
    );
    return button && !button.disabled && button.textContent.includes('טען תגובות קודמות');
  });
  await memberPage.waitForTimeout(350);
  check(await pagedMessage.locator('[data-testid="bulletin-reply"]').count() === 20 &&
        !await pagedMessage.locator('.bulletin-reply-more').isDisabled(),
        'חזרה מרקע מבטלת טעינה ישנה ומשחררת את כפתור התגובות');
  check(memberBoard.errors.length === 0, 'קריאת תגובות לא יצרה שגיאת קוד',
        memberBoard.errors.join(' · '));
  await memberContext.close();

  for (const deniedRole of [
    { id:'team', name:'מפקד צוות' },
    { id:'hr', name:'רכז כוח אדם' },
    { id:'stcmd', name:'מפקד תחנה' }
  ]) {
    const deniedContext = await makeContext({ role:deniedRole.id });
    const deniedBoard = await openBoard(deniedContext);
    await deniedBoard.page.locator('#bulletinCompose').click();
    check(!await deniedBoard.page.locator('#bulletinAudience').isVisible() &&
          await deniedBoard.page.locator('[data-testid="bulletin-reply-action"]').count() === 0,
          deniedRole.name + ' אינו מקבל בטעות הרשאת ראש/סגן משמרת');
    const factories = await deniedBoard.page.evaluate(() => window.__CALLABLE_FACTORIES || []);
    check(!factories.includes('broadcastBulletinMessage') &&
          !factories.includes('replyToBulletinMessage'),
          deniedRole.name + ' אינו יוצר פעולות שרת להפצה או תגובה');
    await deniedContext.close();
  }

  // ----------------------------------------------------------
  head('4 · ראש משמרת: הפצה לכל התחנות ותגובה');
  // ----------------------------------------------------------
  const commanderContext = await makeContext({ role:'commander' });
  const commanderBoard = await openBoard(commanderContext);
  const commanderPage = commanderBoard.page;
  await commanderPage.locator('#bulletinFeed [data-message-id="br2"]')
    .waitFor({ state:'visible', timeout:8000 });
  check(await commanderPage.locator('[data-message-id="br1"] .bulletin-broadcast-chip').isVisible(),
        'הודעה רחבה מסומנת בבירור בכל לוח');
  await commanderPage.locator('#bulletinCompose').click();
  check(await commanderPage.locator('#bulletinAudience').isVisible(),
        'ראש משמרת רואה את בחירת קהל היעד');
  await commanderPage.locator('input[name="bulletinAudience"][value="station"]').check();
  check(await commanderPage.locator('#bulletinBroadcastConfirm').isVisible(),
        'בחירת כל התחנות מציגה אישור נוסף');
  const targetsText = await commanderPage.locator('#bulletinBroadcastTargets').innerText();
  check(['ראשית','שחמון','תמנע','יטבתה'].every(name => targetsText.includes(name)) &&
        !targetsText.includes('ישנה'),
        'האישור מפרט רק את ארבע תחנות המשנה הפעילות');
  await commanderPage.locator('#bulletinText').fill('עדכון פיקודי לכל התחנות');
  await commanderPage.evaluate(() => { window.__CALLABLE_CALLS = []; });
  await commanderPage.locator('#bulletinSubmit').click();
  check((await commanderPage.evaluate(() => window.__CALLABLE_CALLS || [])).length === 0,
        'לא מתבצעת הפצה רחבה בלי סימון אישור מפורש');
  await commanderPage.getByText('לפני הפצה רחבה צריך לאשר את רשימת התחנות.', { exact:true })
    .waitFor({ state:'visible', timeout:3000 });

  await commanderPage.locator('#bulletinBroadcastApproved').check();
  await commanderPage.evaluate(() => {
    window.__CALLABLE_PLAN = {
      broadcastBulletinMessage:[{ delay:250, data:{ ok:true, id:'wide-1', targetCount:4 } }]
    };
    window.__CALLABLE_CALLS = [];
    window.__CALLABLE_MAX_INFLIGHT = 0;
    const form = document.getElementById('bulletinForm');
    form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
  });
  await commanderPage.waitForFunction(() => (window.__CALLABLE_CALLS || []).length === 1 &&
    (window.__CALLABLE_INFLIGHT || 0) === 0);
  const broadcastCalls = await commanderPage.evaluate(() => window.__CALLABLE_CALLS || []);
  const broadcastPayload = broadcastCalls[0]?.payload || {};
  check(broadcastCalls[0]?.name === 'broadcastBulletinMessage' &&
        Object.keys(broadcastPayload).sort().join(',') === 'category,requestId,text' &&
        broadcastPayload.category === 'general' &&
        broadcastPayload.text === 'עדכון פיקודי לכל התחנות' &&
        typeof broadcastPayload.requestId === 'string' && broadcastPayload.requestId.length >= 8,
        'הפצה נשלחת פעם אחת וללא מזהי תחנות שניתן לזייף');
  check((await commanderPage.evaluate(() => window.__CALLABLE_MAX_INFLIGHT)) === 1,
        'לחיצה כפולה אינה יוצרת שתי הפצות במקביל');
  await commanderPage.getByText('ההודעה פורסמה ב־4 תחנות.', { exact:true })
    .waitFor({ state:'visible', timeout:3000 });

  await commanderPage.locator('[data-message-id="br2"] [data-testid="bulletin-reply-action"]').click();
  const commanderReplyForm = commanderPage.locator(
    '[data-message-id="br2"] [data-testid="bulletin-reply-form"]'
  );
  await commanderReplyForm.waitFor({ state:'visible', timeout:5000 });
  const commanderReplyField = commanderReplyForm.locator('textarea');
  check(await commanderReplyField.evaluate(field => document.activeElement === field),
        'פתיחת תגובה מעבירה את המיקוד לשדה הכתיבה');
  const replyControls = await commanderPage
    .locator('[data-message-id="br2"] [data-testid="bulletin-reply-action"]')
    .getAttribute('aria-controls');
  check(Boolean(replyControls) && await commanderPage.locator('#' + replyControls).count() === 1,
        'פעולת התגובה מחוברת לטופס הנכון עבור קורא מסך');
  await commanderReplyField.fill('טיוטה בזמן עדכון חי');
  await commanderReplyField.evaluate(field => field.setSelectionRange(5, 10));
  await commanderPage.evaluate(async () => {
    await window.__FIRESTORE_PUSH_BULLETIN_REPLY({
      boardId:'rashit', messageId:'br2', id:'brr-focus-live',
      text:'תגובה חיה בזמן כתיבה', iso:'2099-01-01T12:04:00.000Z'
    });
  });
  check(await commanderReplyForm.locator('textarea').evaluate(field =>
    document.activeElement === field && field.value === 'טיוטה בזמן עדכון חי' &&
    field.selectionStart === 5 && field.selectionEnd === 10),
    'תגובה חדשה אינה סוגרת את המקלדת ואינה מוחקת את הטיוטה');
  await commanderReplyForm.locator('.bulletin-reply-cancel').click();
  check(await commanderPage.evaluate(() =>
    document.activeElement?.matches(
      '[data-message-id="br2"] [data-testid="bulletin-reply-action"]'
    )), 'ביטול תגובה מחזיר את המיקוד לפעולת התגובה');
  await commanderPage.locator(
    '[data-message-id="br2"] [data-testid="bulletin-reply-action"]'
  ).click();
  await commanderPage.locator(
    '[data-message-id="br2"] [data-testid="bulletin-reply-form"]'
  ).waitFor({ state:'visible', timeout:5000 });
  await commanderReplyForm.locator('textarea').fill('מאשר, הנושא בטיפול.');
  await commanderPage.evaluate(() => {
    window.__CALLABLE_PLAN = {
      replyToBulletinMessage:[{ delay:250, data:{ ok:true, id:'reply-1' } }]
    };
    window.__CALLABLE_CALLS = [];
    window.__CALLABLE_MAX_INFLIGHT = 0;
    const form = document.querySelector(
      '[data-message-id="br2"] [data-testid="bulletin-reply-form"]'
    );
    form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
    form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }));
  });
  await commanderPage.waitForFunction(() => (window.__CALLABLE_CALLS || []).length === 1 &&
    (window.__CALLABLE_INFLIGHT || 0) === 0);
  const replyCalls = await commanderPage.evaluate(() => window.__CALLABLE_CALLS || []);
  const replyPayload = replyCalls[0]?.payload || {};
  check(replyCalls[0]?.name === 'replyToBulletinMessage' &&
        Object.keys(replyPayload).sort().join(',') === 'messageId,requestId,subStationId,text' &&
        replyPayload.subStationId === 'rashit' && replyPayload.messageId === 'br2' &&
        replyPayload.text === 'מאשר, הנושא בטיפול.' &&
        typeof replyPayload.requestId === 'string' && replyPayload.requestId.length >= 8,
        'תגובת ראש משמרת נשלחת פעם אחת עם יעד מדויק');
  check((await commanderPage.evaluate(() => window.__CALLABLE_MAX_INFLIGHT)) === 1,
        'לחיצה כפולה אינה יוצרת שתי תגובות במקביל');
  check(commanderBoard.errors.length === 0, 'מסלול ראש משמרת לא יצר שגיאת קוד',
        commanderBoard.errors.join(' · '));
  await commanderContext.close();

  const deputyContext = await makeContext({ role:'deputy' });
  const deputyBoard = await openBoard(deputyContext);
  await deputyBoard.page.locator('#bulletinFeed [data-testid="bulletin-message"]').first()
    .waitFor({ state:'visible', timeout:8000 });
  await deputyBoard.page.locator('#bulletinCompose').click();
  check(await deputyBoard.page.locator('#bulletinAudience').isVisible() &&
        await deputyBoard.page.locator('[data-testid="bulletin-reply-action"]').count() > 0,
        'סגן ראש משמרת מקבל גם הפצה לכל התחנות וגם תגובה');
  const deputyFactories = await deputyBoard.page.evaluate(() => window.__CALLABLE_FACTORIES || []);
  check(deputyFactories.includes('broadcastBulletinMessage') &&
        deputyFactories.includes('replyToBulletinMessage'),
        'לדפדפן של הסגן נוצרות שתי פעולות השרת המורשות');
  check(deputyBoard.errors.length === 0, 'מסלול סגן ראש משמרת לא יצר שגיאת קוד',
        deputyBoard.errors.join(' · '));
  await deputyContext.close();

  // ----------------------------------------------------------
  head('5 · טיוטות מבודדות בין משתמשים במכשיר משותף');
  // ----------------------------------------------------------
  const keyA = browserDraftKey('uid-a', 'eilat_102', 'rashit');
  const keyB = browserDraftKey('uid-b', 'eilat_102', 'rashit');
  const legacyKey = 'resq_bulletin_draft:eilat_102:rashit';
  const sharedDraftState = {
    cookies:[],
    origins:[{
      origin:'http://localhost:' + port,
      localStorage:[
        { name:keyA, value:JSON.stringify({
          text:'טיוטה פרטית של משתמש א', category:'general',
          requestId:'11111111-1111-4111-8111-111111111111', attemptedFingerprint:''
        }) },
        { name:legacyKey, value:JSON.stringify({
          text:'טיוטה ישנה בלי בעלים', category:'general',
          requestId:'22222222-2222-4222-8222-222222222222', attemptedFingerprint:''
        }) }
      ]
    }]
  };

  const userAContext = await makeContext({
    role:'firefighter', uid:'uid-a', storageState:sharedDraftState
  });
  const userABoard = await openBoard(userAContext);
  check(await userABoard.page.locator('#bulletinText').inputValue() ===
        'טיוטה פרטית של משתמש א',
        'משתמש א משחזר את טיוטת v2 שלו');
  check(!await userABoard.page.evaluate(key => localStorage.getItem(key), legacyKey),
        'טיוטת legacy נמחקת בלי להיות מוצגת');
  await userAContext.close();

  const userBContext = await makeContext({
    role:'firefighter', uid:'uid-b', storageState:sharedDraftState
  });
  const userBBoard = await openBoard(userBContext);
  const userBPage = userBBoard.page;
  check(await userBPage.locator('#bulletinText').inputValue() === '',
        'משתמש ב אינו רואה טיוטה של משתמש א');
  check(await userBPage.evaluate(key => localStorage.getItem(key) !== null, keyA),
        'כניסת משתמש ב אינה מוחקת טיוטת v2 של משתמש א');
  check(!await userBPage.evaluate(key => localStorage.getItem(key), legacyKey),
        'גם אצל משתמש ב אין fallback לטיוטה הישנה');
  await userBPage.locator('#bulletinCompose').click();
  await userBPage.locator('#bulletinText').fill('טיוטה חדשה של משתמש ב');
  check(await userBPage.evaluate(key => localStorage.getItem(key) !== null, keyB),
        'משתמש ב שומר טיוטה במפתח משלו');
  await userBPage.evaluate(() => {
    window.__CALLABLE_PLAN = { postBulletinMessage:[{ data:{ ok:true, id:'user-b-post' } }] };
    window.__CALLABLE_CALLS = [];
  });
  await userBPage.locator('#bulletinSubmit').click();
  await userBPage.waitForFunction(() => (window.__CALLABLE_CALLS || []).length === 1 &&
    (window.__CALLABLE_INFLIGHT || 0) === 0);
  const userBPayload = await userBPage.evaluate(() => window.__CALLABLE_CALLS[0]?.payload);
  check(userBPayload?.text === 'טיוטה חדשה של משתמש ב',
        'משתמש ב מפרסם רק את הטקסט שלו');
  check(!await userBPage.evaluate(key => localStorage.getItem(key), keyB),
        'פרסום של משתמש ב מנקה רק את הטיוטה שלו');
  check(await userBPage.evaluate(key => localStorage.getItem(key) !== null, keyA),
        'ניקוי טיוטת משתמש ב אינו מוחק את טיוטת משתמש א');
  check(userBBoard.errors.length === 0, 'בידוד הטיוטות לא יצר שגיאת קוד',
        userBBoard.errors.join(' · '));
  await userBContext.close();

  // ----------------------------------------------------------
  head('4 · הפרדת תחנות, סדר, בטיחות וטעינה מדורגת');
  // ----------------------------------------------------------
  const context = await makeContext({ role:'super' });
  const { page, errors } = await openBoard(context);
  const tabs = page.locator('#boardTabs [data-board-id]');
  check(await tabs.count() === 4, 'מוצגות ארבע תחנות המשנה');
  const tabIds = await tabs.evaluateAll(nodes => nodes.map(n => n.dataset.boardId));
  check(JSON.stringify(tabIds) === JSON.stringify(['rashit','shahmon','timna','yotvata']),
        'מזהי התחנות הקנוניים נשמרים ובסדר הנכון', JSON.stringify(tabIds));

  await page.locator('#bulletinFeed [data-testid="bulletin-message"]').first()
    .waitFor({ state:'visible', timeout:8000 });
  const initialQuery = await page.evaluate(() => (window.__FIRESTORE_QUERIES || [])
    .find(q => q.path.endsWith('/rashit/bulletin_messages')));
  check(initialQuery?.constraints?.some(c => c.kind === 'where' && c.field === 'hidden' &&
        c.op === '==' && c.value === false), 'השאילתה דורשת hidden == false');
  check(initialQuery?.constraints?.some(c => c.kind === 'orderBy' &&
        c.field === 'created_at' && c.direction === 'desc'),
        'השאילתה ממיינת created_at מהחדש לישן');
  check(initialQuery?.constraints?.some(c => c.kind === 'limit' && c.count === 30),
        'השאילתה מוגבלת ל-30 קריאות');
  const initialCards = page.locator('#bulletinFeed [data-testid="bulletin-message"]');
  check(await initialCards.count() === 30, 'הקריאה הראשונה מוגבלת ל-30 הודעות');
  const initialText = await initialCards.allTextContents();
  const atMalicious = initialText.findIndex(t => t.includes('<img src=x'));
  const atSupplies = initialText.findIndex(t => t.includes('חסר חלב וביצים'));
  const atVehicle = initialText.findIndex(t => t.includes('רכב געש יוצא'));
  check(atMalicious !== -1 && atSupplies > atMalicious && atVehicle > atSupplies,
        'ההודעות מוצגות מהחדשה לישנה');
  check(!initialText.some(t => t.includes('הודעה מוסתרת')), 'הודעה מוסתרת אינה מוצגת');
  check(initialText.some(t => t.includes('לוחם אש')), 'תפקיד הכותב מוצג בעברית');
  check(await page.locator('#bulletinFeed [data-testid="bulletin-message"] img').count() === 0,
        'HTML מתוך הודעה אינו הופך לאלמנט בדף');
  check(await page.evaluate(() => window.__BULLETIN_XSS !== 1), 'טקסט זדוני לא הורץ');

  const beforeMore = await initialCards.count();
  await page.locator('#bulletinLoadMore').waitFor({ state:'visible', timeout:5000 });
  await page.locator('#bulletinLoadMore').click();
  await page.waitForFunction(n =>
    document.querySelectorAll('#bulletinFeed [data-testid="bulletin-message"]').length > n,
    beforeMore);
  check(await initialCards.count() === 34, 'טעינת הודעות קודמות מוסיפה רק את העמוד הבא');
  check((await initialCards.allTextContents()).some(t => t.includes('הודעה קודמת 1')),
        'העמוד הישן ביותר נטען בפועל');

  // הודעה חדשה משנה את גבול חלון ה-realtime. עמוד ישן שנבנה
  // על cursor קודם חייב להתאפס, אחרת הודעת הגבול נעלמת בשקט.
  await page.evaluate(async () => {
    await window.__FIRESTORE_PUSH_BULLETIN({
      boardId:'rashit', id:'br-live-1', text:'עדכון חי ראשון',
      iso:'2099-01-01T12:00:00.000Z'
    });
  });
  await page.getByText('עדכון חי ראשון', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  check(await initialCards.count() === 30,
        'עדכון realtime מאפס עמוד ישן במקום להשאיר חור סמוי');
  check(await bulletinActiveListeners(page) === 1,
        'איפוס pagination אינו פותח listener נוסף');
  await page.locator('#bulletinLoadMore').click();
  await page.waitForFunction(() =>
    document.querySelectorAll('#bulletinFeed [data-testid="bulletin-message"]').length === 35);
  const afterRealtimeIds = await initialCards.evaluateAll(nodes =>
    nodes.map(node => node.dataset.messageId));
  check(new Set(afterRealtimeIds).size === 35,
        'טעינה מחדש אחרי realtime מחזירה 35 הודעות ייחודיות');
  check((await initialCards.allTextContents()).filter(t => t.includes('הודעה קודמת')).length === 31,
        'לאחר טעינה מחדש כל 31 ההודעות הקודמות חוזרות ללא חור');

  // גם בקשה שכבר יצאה עם cursor ישן אינה רשאית לחזור אחרי
  // snapshot חדש ולהדביק עמוד לא נכון למסך.
  await page.locator('#boardTabs [data-board-id="shahmon"]').click();
  await page.getByText('תקלה במזגן בחדר התדריכים', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  await page.locator('#boardTabs [data-board-id="rashit"]').click();
  await page.getByText('עדכון חי ראשון', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  await page.evaluate(() => { window.__SMOKE_LAG_PLAN = [300]; });
  await page.locator('#bulletinLoadMore').click();
  await page.waitForTimeout(30);
  await page.evaluate(async () => {
    await window.__FIRESTORE_PUSH_BULLETIN({
      boardId:'rashit', id:'br-live-2', text:'עדכון חי בזמן טעינה',
      iso:'2099-01-01T12:01:00.000Z'
    });
  });
  await page.getByText('עדכון חי בזמן טעינה', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  await page.waitForFunction(() => !document.getElementById('bulletinLoadMore').disabled);
  check(await initialCards.count() === 30,
        'תוצאת load-more עם cursor מיושן נזרקת ואינה יוצרת ערבוב');
  await page.locator('#bulletinLoadMore').click();
  await page.waitForFunction(() =>
    document.querySelectorAll('#bulletinFeed [data-testid="bulletin-message"]').length === 36);
  const afterRaceIds = await initialCards.evaluateAll(nodes =>
    nodes.map(node => node.dataset.messageId));
  check(new Set(afterRaceIds).size === 36,
        'טעינה חדשה אחרי race מחזירה את כל ההודעות ללא כפילות');

  await page.locator('#boardTabs [data-board-id="shahmon"]').click();
  await page.getByText('תקלה במזגן בחדר התדריכים', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  const shahmonText = await page.locator('#bulletinFeed').innerText();
  check(!shahmonText.includes('חסר חלב וביצים'), 'מעבר לשחמון אינו משאיר הודעות של ראשית');
  check(await bulletinActiveListeners(page) === 1, 'בכל רגע פעיל מאזין realtime אחד בלבד');
  check(await page.evaluate(() => (window.__FIRESTORE_UNSUBSCRIBES || 0) >= 1),
        'המאזין של הלוח הקודם בוטל');

  await page.locator('#boardTabs [data-board-id="timna"]').click();
  await page.locator('#bulletinEmpty').waitFor({ state:'visible', timeout:5000 });
  check(await page.locator('#bulletinFeed [data-testid="bulletin-message"]').count() === 0,
        'לתחנה בלי הודעות מוצג מצב ריק אמיתי');
  check(await bulletinActiveListeners(page) === 1, 'גם במצב ריק נשאר מאזין יחיד');

  await page.locator('#boardTabs [data-board-id="rashit"]').click();
  await page.getByText('חסר חלב וביצים במטבח', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });

  // ----------------------------------------------------------
  head('3 · פרסום, כשל, retry ומניעת כפילות');
  // ----------------------------------------------------------
  await page.locator('#bulletinCompose').click();
  await page.locator('#bulletinForm').waitFor({ state:'visible', timeout:3000 });
  await page.locator('#bulletinCategory').selectOption('supplies');
  await page.locator('#bulletinText').fill('בדיקת פרסום יחידה');
  await page.evaluate(() => {
    window.__CALLABLE_PLAN = { postBulletinMessage:[{ delay:250, data:{ ok:true, id:'p1' } }] };
    window.__CALLABLE_CALLS = [];
    window.__CALLABLE_MAX_INFLIGHT = 0;
  });
  await page.locator('#bulletinSubmit').click();
  await page.locator('#bulletinSubmit').evaluate(el => el.click());
  await page.waitForFunction(() => (window.__CALLABLE_CALLS || []).length === 1);
  await page.waitForFunction(() => (window.__CALLABLE_INFLIGHT || 0) === 0);
  const publishCalls = await page.evaluate(() => window.__CALLABLE_CALLS);
  check(publishCalls.length === 1, 'לחיצה כפולה שולחת בקשת שרת אחת בלבד');
  check((await page.evaluate(() => window.__CALLABLE_MAX_INFLIGHT)) === 1,
        'לא היו שתי בקשות פרסום מקבילות');
  const firstPayload = publishCalls[0] && publishCalls[0].payload;
  check(publishCalls[0]?.name === 'postBulletinMessage', 'הפרסום עובר דרך פונקציית השרת המוגנת');
  check(firstPayload?.subStationId === 'rashit' && firstPayload?.category === 'supplies' &&
        firstPayload?.text === 'בדיקת פרסום יחידה' && typeof firstPayload?.requestId === 'string' &&
        firstPayload.requestId.length >= 8,
        'נשלח payload מדויק עם מזהה בקשה');
  await page.waitForFunction(() => document.getElementById('bulletinText')?.value === '');
  check(true, 'בהצלחה הטיוטה מתנקה');

  await page.locator('#bulletinCompose').click();
  await page.locator('#bulletinForm').waitFor({ state:'visible', timeout:3000 });
  await page.locator('#bulletinCategory').selectOption('vehicle');
  await page.locator('#bulletinText').fill('הטיוטה חייבת להישאר');
  await page.evaluate(() => {
    window.__CALLABLE_PLAN = { postBulletinMessage:[
      { reject:true, code:'functions/unavailable', message:'offline' },
      { data:{ ok:true, id:'p2' } }
    ] };
    window.__CALLABLE_CALLS = [];
  });
  await page.locator('#bulletinSubmit').click();
  await page.waitForFunction(() => (window.__CALLABLE_CALLS || [])
    .filter(call => call.name === 'postBulletinMessage').length === 1 &&
    (window.__CALLABLE_INFLIGHT || 0) === 0);
  check(await page.locator('#bulletinText').inputValue() === 'הטיוטה חייבת להישאר',
        'כשל בפרסום משאיר את הטיוטה על המסך');
  check(await page.evaluate(() => Array.from({ length:localStorage.length }, (_, i) =>
    localStorage.getItem(localStorage.key(i))).some(value =>
      String(value).includes('הטיוטה חייבת להישאר'))),
    'כשל בפרסום משאיר את הטיוטה גם באחסון המקומי');
  const failedRequestId = await page.evaluate(() => window.__CALLABLE_CALLS
    .find(call => call.name === 'postBulletinMessage').payload.requestId);
  await page.waitForFunction(() => (window.__CALLABLE_CALLS || [])
    .filter(call => call.name === 'reportIncident').length === 1 &&
    (window.__CALLABLE_INFLIGHT || 0) === 0);
  const failureReports = await page.evaluate(() => window.__CALLABLE_CALLS
    .filter(call => call.name !== 'postBulletinMessage'));
  check(failureReports.length === 1 && failureReports[0].name === 'reportIncident',
        'כשל בפרסום מוסיף דיווח תקלה אחד בלבד, לא פרסום נוסף');
  const failureReport = failureReports[0]?.payload;
  check(JSON.stringify(Object.keys(failureReport || {}).sort()) ===
        JSON.stringify(['callable', 'code', 'kind', 'screen', 'version']) &&
        failureReport.kind === 'callable-failed' &&
        failureReport.callable === 'postBulletinMessage' &&
        failureReport.code === 'functions/unavailable' &&
        failureReport.screen === 'login.html' && failureReport.version === '42G.0',
        'הניטור שולח רק חמש קטגוריות טכניות, ללא תוכן ההודעה או מזהה הבקשה');
  await page.locator('#boardTabs [data-board-id="shahmon"]').click();
  await page.getByText('תקלה במזגן בחדר התדריכים', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  check(await page.locator('#bulletinText').inputValue() === '',
        'טיוטת ראשית אינה זולגת ללוח שחמון');
  await page.locator('#boardTabs [data-board-id="rashit"]').click();
  await page.getByText('חסר חלב וביצים במטבח', { exact:true })
    .waitFor({ state:'visible', timeout:5000 });
  check(await page.locator('#bulletinText').inputValue() === 'הטיוטה חייבת להישאר',
        'חזרה לראשית משחזרת את הטיוטה של אותו לוח בלבד');
  await page.locator('#bulletinSubmit').click();
  await page.waitForFunction(() => (window.__CALLABLE_CALLS || [])
    .filter(call => call.name === 'postBulletinMessage').length === 2 &&
    (window.__CALLABLE_INFLIGHT || 0) === 0);
  const retryCalls = await page.evaluate(() => window.__CALLABLE_CALLS);
  const retried = retryCalls.filter(call => call.name === 'postBulletinMessage');
  check(retried[1].payload.requestId === failedRequestId,
        'retry משתמש באותו requestId ולכן השרת יכול למנוע כפילות');
  check(retryCalls.length === 3 && retryCalls.filter(call => call.name === 'reportIncident').length === 1,
        'retry מוצלח אינו מוסיף דיווח תקלה או פעולה מיותרת');
  await page.waitForFunction(() => document.getElementById('bulletinText')?.value === '');
  check(true, 'אחרי retry מוצלח הטיוטה מתנקה');
  check(errors.length === 0, 'המסלול המלא לא יצר שגיאת קוד', errors.join(' · '));
  await context.close();

  // ----------------------------------------------------------
  head('4 · טעינה, offline ו-retry');
  // ----------------------------------------------------------
  const slowContext = await makeContext({
    role:'super',
    init:'window.__SMOKE_LAG = 350;'
  });
  const slowPage = await slowContext.newPage();
  await slowPage.goto('http://localhost:' + port + '/login.html', { waitUntil:'load' });
  await slowPage.addStyleTag({ content:'#coWrap{display:none!important}' });
  await slowPage.locator('#bulletinBoard').waitFor({ state:'visible', timeout:10000 });
  await slowPage.locator('#bulletinStatus').waitFor({ state:'visible', timeout:5000 });
  check((await slowPage.locator('#bulletinStatus').innerText()).trim().length > 0,
        'בזמן המתנה מוצג מצב טעינה ברור');
  await slowPage.locator('#bulletinFeed [data-testid="bulletin-message"]').first()
    .waitFor({ state:'visible', timeout:10000 });
  await slowContext.close();

  const offlineContext = await makeContext({
    role:'super',
    init:'window.__FIRESTORE_FAIL_PATHS = ["bulletin_messages"];'
  });
  const offlinePage = await offlineContext.newPage();
  await offlinePage.goto('http://localhost:' + port + '/login.html', { waitUntil:'load' });
  await dismissStubCallout(offlinePage);
  await offlinePage.locator('#bulletinRetry').waitFor({ state:'visible', timeout:10000 });
  check((await offlinePage.locator('#bulletinStatus').innerText()).trim().length > 0,
        'בכשל חיבור מוצגת הודעת מצב');
  await offlinePage.evaluate(() => { window.__FIRESTORE_FAIL_PATHS = []; });
  await offlinePage.locator('#bulletinRetry').click();
  await offlinePage.locator('#bulletinFeed [data-testid="bulletin-message"]').first()
    .waitFor({ state:'visible', timeout:8000 });
  check(await bulletinActiveListeners(offlinePage) === 1,
        'retry מחליף את המאזין שנכשל ואינו משאיר כפילות');
  await offlineContext.close();

  // ----------------------------------------------------------
  head('5 · 360/390/desktop, בהיר/כהה והפחתת תנועה');
  // ----------------------------------------------------------
  const matrix = [
    { name:'360 בהיר', viewport:{width:360,height:800}, colorScheme:'light' },
    { name:'390 כהה', viewport:{width:390,height:844}, colorScheme:'dark' },
    { name:'desktop בהיר', viewport:{width:1280,height:900}, colorScheme:'light' },
    { name:'desktop כהה', viewport:{width:1280,height:900}, colorScheme:'dark' },
    { name:'390 הפחתת תנועה', viewport:{width:390,height:844}, colorScheme:'light', reducedMotion:'reduce' }
  ];
  for (const spec of matrix) {
    const responsiveContext = await makeContext({ role:'super', ...spec });
    const responsivePage = await responsiveContext.newPage();
    await responsivePage.goto('http://localhost:' + port + '/login.html', { waitUntil:'load' });
    await responsivePage.addStyleTag({ content:'#coWrap{display:none!important}' });
    await responsivePage.locator('#bulletinBoard').waitFor({ state:'visible', timeout:10000 });
    await responsivePage.locator('#bulletinFeed [data-testid="bulletin-message"]').first()
      .waitFor({ state:'visible', timeout:8000 });
    const layout = await responsivePage.evaluate(() => ({
      doc:document.documentElement.scrollWidth,
      body:document.body.scrollWidth,
      viewport:window.innerWidth,
      reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
      animation:getComputedStyle(document.getElementById('bulletinBoard')).animationDuration,
      transition:getComputedStyle(document.getElementById('bulletinBoard')).transitionDuration,
      overflow:[...document.querySelectorAll('body *')].map(node => {
        const rect = node.getBoundingClientRect();
        return { node:node.id ? ('#' + node.id) : node.className,
                 left:Math.round(rect.left), right:Math.round(rect.right),
                 width:Math.round(rect.width) };
      }).filter(item => item.left < -1 || item.right > window.innerWidth + 1).slice(0, 8)
    }));
    check(Math.max(layout.doc, layout.body) <= layout.viewport + 1,
          spec.name + ' ללא גלישה אופקית', JSON.stringify(layout));
    check(await responsivePage.locator('#bulletinCompose').isVisible(),
          spec.name + ' משאיר את פעולת הכתיבה נגישה');
    if (spec.viewport.width <= 390) {
      await responsivePage.locator('#bulletinCompose').click();
      await responsivePage.locator(
        'input[name="bulletinAudience"][value="station"]'
      ).check();
      const confirmationHeight = await responsivePage
        .locator('#bulletinBroadcastConfirm label')
        .evaluate(node => node.getBoundingClientRect().height);
      check(confirmationHeight >= 44,
            spec.name + ' משאיר את אישור ההפצה בגודל מגע בטוח',
            'height=' + confirmationHeight);
      await responsivePage.locator('[data-message-id="br2"] [data-testid="bulletin-replies-toggle"]')
        .click();
      await responsivePage.waitForFunction(() =>
        document.querySelectorAll('[data-message-id="br2"] [data-testid="bulletin-reply"]').length === 2);
      const hideReplyHeight = await responsivePage
        .locator('[data-message-id="br2"] .bulletin-hide-reply').first()
        .evaluate(node => node.getBoundingClientRect().height);
      check(hideReplyHeight >= 44,
            spec.name + ' משאיר את הסתרת התגובה בגודל מגע בטוח',
            'height=' + hideReplyHeight);
    }
    if (spec.reducedMotion === 'reduce') {
      check(layout.reduced, 'הדפדפן מדווח prefers-reduced-motion');
      const duration = Math.max(
        ...String(layout.animation + ',' + layout.transition).split(',').map(v => parseFloat(v) || 0)
      );
      check(duration <= 0.01, 'הלוח מכבד הפחתת תנועה');
    }
    await responsiveContext.close();
  }
} catch (error) {
  fail++;
  failures.push('הבדיקה נעצרה: ' + error.message);
  console.error('\n\x1b[31m✗ הבדיקה נעצרה:\x1b[0m', error);
} finally {
  await browser.close();
  server.close();
}

console.log('\n\x1b[1m════════════════════════════════════\x1b[0m');
if (fail === 0) {
  console.log('\x1b[32m\x1b[1m  ✓ כל ' + pass + ' בדיקות הדפדפן ללוח עברו\x1b[0m');
} else {
  console.log('\x1b[31m\x1b[1m  ✗ ' + fail + ' נכשלו · ' + pass + ' עברו\x1b[0m');
  failures.forEach(name => console.log('    ' + name));
}
console.log('\x1b[1m════════════════════════════════════\x1b[0m\n');
process.exit(fail ? 1 : 0);
