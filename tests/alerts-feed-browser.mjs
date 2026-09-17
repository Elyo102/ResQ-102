// ============================================================
//  מסך ההתראות — פילטרים (הכל / לא נצפו / קריאות פתע) בדפדפן אמיתי
//  42H.20 closure batch item 2: קריאות פתע סגורות בפיד + בדיקת
//  דפדפן אמיתית ללשוניות/רשימה, לא רק לוגיקה טהורה
//  (alerts-feed.test.mjs).
// ============================================================
//  Firebase מוחלף ב-stubs מקומיים (tests/stub). הבדיקה אינה דורשת
//  רשת, אינה קוראת נתוני אמת ואינה יכולה לכתוב ל-production.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/alerts.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
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
  if (ok) pass++; else { fail++; failures.push(message); }
}
function head(text) { console.log('\n\x1b[1m--- ' + text + '\x1b[0m'); }

async function makeContext(init) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL' });
  await context.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};'
    });
  });
  await context.route('**://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.addInitScript('window.__SMOKE_ROLE = "super";');
  await context.addInitScript('window.__SMOKE_UID = "stub-uid";');
  if (init) await context.addInitScript(init);
  return context;
}

async function openAlerts(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/alerts.html', { waitUntil: 'load' });
  // watchCallouts is active on this page too — close the popup like every
  // other test that loads a real station screen (dismissStubCallout).
  await page.locator('#coNo').click({ timeout: 1200 }).catch(() => {});
  await page.addStyleTag({ content: '#coWrap{display:none!important}' });
  await page.waitForSelector('#feedTabs button', { timeout: 5000 });
  return { page, errors };
}

function tabCounts(page) {
  return page.locator('#feedTabs button').allTextContents();
}

try {
  // הפיקסצ'ה האמיתית (bulletin_messages) עשירה בהרבה מהודעות דמו בודדות —
  // כוללת גם היסטוריה ישנה לבדיקת pagination. rashit לבדו נותן יותר מ-10
  // הודעות גלויות, ולכן ה-BOARD_MESSAGE_LIMIT(10) הוא זה שקוצץ אותו,
  // לא ספירה ידנית. shahmon=2, yotvata=1, timna=0, קריאה פעילה אחת.
  const TOTAL_ALL = 14; // 10 (rashit, מוגבל) + 2 + 1 + 0 + 1 קריאה

  head('פילטרים ומונים — מצב ברירת מחדל');
  {
    const ctx = await makeContext();
    const { page, errors } = await openAlerts(ctx);
    const tabs = await tabCounts(page);
    check(tabs.some(t => t.includes('הכל') && t.includes('(' + TOTAL_ALL + ')')),
      'לשונית "הכל" מציגה ' + TOTAL_ALL + ' פריטים (לוח מודעות גלויות, rashit מוגבל ל-10 + קריאה פעילה אחת)', tabs.join(' | '));
    check(tabs.some(t => t.includes('לא נצפו') && t.includes('(' + TOTAL_ALL + ')')),
      'לשונית "לא נצפו" שווה ל"הכל" — שום דבר לא נצפה עדיין (אין קבלות)', tabs.join(' | '));
    check(tabs.some(t => t.includes('קריאות פתע') && t.includes('(1)')), 'לשונית "קריאות פתע" מציגה קריאה פעילה אחת', tabs.join(' | '));
    const items = page.locator('#feedList .feed-item');
    check(await items.count() === TOTAL_ALL, 'הרשימה בפועל (הכל) מציגה ' + TOTAL_ALL + ' שורות');
    check(errors.length === 0, 'אין שגיאת JS בעמוד', errors.join(' | '));
    await page.close(); await ctx.close();
  }

  head('לחיצה על לשונית מסננת בפועל את הרשימה (DOM אמיתי, לא רק ספירה)');
  {
    const ctx = await makeContext();
    const { page } = await openAlerts(ctx);
    await page.getByRole('button', { name: /קריאות פתע/ }).click();
    const items = page.locator('#feedList .feed-item');
    check(await items.count() === 1, 'לחיצה על "קריאות פתע" משאירה שורה אחת בלבד');
    check((await items.first().locator('.fi-kind').textContent()).includes('קריאת פתע'), 'השורה שנשארה מסומנת כקריאת פתע');
    await page.getByRole('button', { name: /^הכל/ }).click();
    check(await items.count() === TOTAL_ALL, 'חזרה ל"הכל" מציגה שוב את כל ' + TOTAL_ALL + ' השורות');
    await page.close(); await ctx.close();
  }

  head('42H.20 closure batch item 2 · קריאת פתע סגורה (active:false) מופיעה גם היא');
  {
    // הפורמט חייב להיות [id, data] בדיוק כמו CALLOUTS עצמו — לא אובייקט שטוח.
    const closedCalloutRow = ['co-closed', {
      by_uid: 'u1', by_name: 'אלדד יונה',
      target: 'crew:C', target_he: "משמרת ג'", crew: 'C', text: 'קריאה שנסגרה',
      uids: ['stub-uid', 'u2'], active: false, when_he: '09:00', acks: {},
      created_key: '2026-08-01T06:00:00.000Z'
    }];
    const ctx = await makeContext('window.__CALLOUTS_EXTRA = ' + JSON.stringify([closedCalloutRow]) + ';');
    const { page } = await openAlerts(ctx);
    const tabs = await tabCounts(page);
    check(tabs.some(t => t.includes('הכל') && t.includes('(' + (TOTAL_ALL + 1) + ')')),
      '"הכל" עולה ב-1 עם הקריאה הסגורה החדשה — היא נכנסת לפיד', tabs.join(' | '));
    check(tabs.some(t => t.includes('קריאות פתע') && t.includes('(2)')),
      'עם קריאה סגורה נוספת בנתונים — הלשונית עולה ל-2, לא נשארת על 1 (הפילטר הקודם היה מוגבל ל-active בלבד)', tabs.join(' | '));
    await page.getByRole('button', { name: /קריאות פתע/ }).click();
    const items = page.locator('#feedList .feed-item');
    check(await items.count() === 2, 'שתי הקריאות (הפעילה והסגורה) מוצגות יחד בלשונית');
    const texts = await items.allTextContents();
    check(texts.some(t => t.includes('קריאה שנסגרה')), 'הקריאה הסגורה מופיעה בטקסט בפועל, לא רק במונה');
    await page.close(); await ctx.close();
  }

  head('42H.20 §5.5/closure item 2 · מצב "נצפה" אמיתי (קבלה מסוימת) משפיע על "לא נצפו" בלבד');
  {
    const ctx = await makeContext(
      'window.__BULLETIN_RECEIPTS_SEEN = new Set(["br1/stub-uid"]);' +
      'window.__CALLOUT_SEEN_EXTRA = new Set(["co1"]);'
    );
    const { page } = await openAlerts(ctx);
    const tabs = await tabCounts(page);
    check(tabs.some(t => t.includes('הכל') && t.includes('(' + TOTAL_ALL + ')')),
      '"הכל" עדיין מציגה את כל ' + TOTAL_ALL + ' — צפייה אינה מוחקת פריטים', tabs.join(' | '));
    check(tabs.some(t => t.includes('לא נצפו') && t.includes('(' + (TOTAL_ALL - 2) + ')')),
      '"לא נצפו" ירדה ב-2 בדיוק — הודעת br1 והקריאה co1 סומנו כנצפו דרך קבלה אמיתית', tabs.join(' | '));
    await page.getByRole('button', { name: /לא נצפו/ }).click();
    const items = page.locator('#feedList .feed-item');
    check(await items.count() === TOTAL_ALL - 2, 'לחיצה על "לא נצפו" מציגה בפועל ' + (TOTAL_ALL - 2) + ' שורות בלבד');
    const stillThere = await items.allTextContents();
    check(!stillThere.some(t => t.includes('רכב געש יוצא')), 'ההודעה שסומנה כנצפתה (br1) לא מופיעה בלשונית "לא נצפו"');
    await page.close(); await ctx.close();
  }

  head('הפעמון בניווט מציג את אותו המספר בדיוק שהלשונית "לא נצפו" מציגה — לא חישוב שני');
  {
    const ctx = await makeContext();
    const { page } = await openAlerts(ctx);
    const badgeText = await page.locator('#appNav a.bell .badge').textContent().catch(() => null);
    const tabs = await tabCounts(page);
    const unreadTabCount = (tabs.find(t => t.includes('לא נצפו')) || '').match(/\((\d+)\)/);
    check(badgeText !== null, 'הפעמון מציג תג מספר כלשהו כשיש לא-נצפו');
    check(unreadTabCount && badgeText === unreadTabCount[1],
      'התג על הפעמון שווה בדיוק למספר בלשונית "לא נצפו": ' + badgeText + ' === ' + (unreadTabCount && unreadTabCount[1]));
    await page.close(); await ctx.close();
  }
  head('42H.20 · ביקורת Codex, חוסם 3 · קריאה שרתית אחת, בלי קריאת קבלות מהדפדפן; מונה הפעמון מהשרת');
  {
    const ctx = await makeContext();
    const { page } = await openAlerts(ctx);
    const calls = await page.evaluate(() => (window.__CALLABLE_CALLS || []).map(c => c.name));
    check(calls.filter(n => n === 'getAlertsFeed').length === 1, 'טעינת המסך = קריאת getAlertsFeed אחת בדיוק', calls.join(','));
    check(!calls.includes('markBulletinMessageViewed'), 'רינדור הרשימה לבדו לא שולח שום קבלת צפייה', calls.join(','));
    const receiptReads = await page.evaluate(() => (window.__FIRESTORE_GETDOC_PATHS || []).filter(p => p.includes('bulletin_view_receipts')).length);
    check(receiptReads === 0, 'הדפדפן לא קרא אף מסמך קבלה ישירות (הנתיב חסום ב-Rules)');
    await page.close(); await ctx.close();
  }

  head('42H.20 · ביקורת Codex, חוסם 3.4 · לא מוצג → לא מסומן; מוצג → מסומן פעם אחת; רענון אינו מכפיל');
  {
    const ctx = await makeContext();
    const { page } = await openAlerts(ctx);
    const items = page.locator('#feedList .feed-item');
    const count = await items.count();
    const ids = await items.evaluateAll(nodes => nodes.map(n => n.dataset.feedId));
    const bulletinFull = ids.filter(id => id.includes('/'));
    const bulletinIds = bulletinFull.map(id => id.split('/')[1]);
    const lastBulletin = bulletinIds[bulletinIds.length - 1];
    const firstBulletin = bulletinIds[0];
    const firstBulletinIndex = ids.indexOf(bulletinFull[0]);
    const marksNow = () => page.evaluate(() => (window.__CALLABLE_CALLS || []).filter(c => c.name === 'markBulletinMessageViewed').map(c => c.payload.message_id));
    await page.waitForTimeout(1500);
    let marks = await marksNow();
    check(!marks.includes(lastBulletin), 'הודעה מחוץ למסך (האחרונה ברשימה) לא סומנה כנצפתה גם אחרי 1.5 שניות', marks.join(','));
    check(marks.includes(firstBulletin), 'ההודעה הראשונה, שנראתה במלואה ≥1 שנייה, סומנה', marks.join(','));
    check(marks.every((m, i) => marks.indexOf(m) === i), 'כל הודעה שהוצגה סומנה בדיוק פעם אחת', marks.join(','));
    check((await items.nth(firstBulletinIndex).getAttribute('data-viewed')) === 'true', 'ההודעה שסומנה עברה ל-data-viewed=true בלי רענון');
    // רענון הרשימה בתוך המסך (רינדור מחדש דרך הלשוניות) אינו שולח שוב
    const before = (await marksNow()).length;
    await page.getByRole('button', { name: /קריאות פתע/ }).click();
    await page.getByRole('button', { name: /^הכל/ }).click();
    await page.waitForTimeout(1500);
    check((await marksNow()).length === before, 'רינדור מחדש של אותה רשימה אינו מכפיל קבלה');
    // גלילה: ההודעה האחרונה נכנסת למסך → מסומנת פעם אחת
    await items.nth(count - 1).scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    marks = await marksNow();
    check(marks.filter(m => m === lastBulletin).length === 1, 'אחרי גלילה ההודעה האחרונה סומנה — פעם אחת', marks.join(','));
    await page.close(); await ctx.close();

    // טעינה מחדש כשהשרת כבר מחזיק קבלות להודעות שסומנו: אף אחת מהן לא נשלחת שוב
    const seenKeys = marks.map(m => m + '/stub-uid');
    const ctx2 = await makeContext('window.__BULLETIN_RECEIPTS_SEEN = new Set(' + JSON.stringify(seenKeys) + ');');
    const { page: page2 } = await openAlerts(ctx2);
    await page2.waitForTimeout(1500);
    const again = await page2.evaluate(() => (window.__CALLABLE_CALLS || []).filter(c => c.name === 'markBulletinMessageViewed').map(c => c.payload.message_id));
    check(again.every(m => !marks.includes(m)), 'אחרי טעינה מחדש, הודעה שהשרת כבר מחזיק לה קבלה אינה נשלחת שוב', again.join(','));
    await page2.close(); await ctx2.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
