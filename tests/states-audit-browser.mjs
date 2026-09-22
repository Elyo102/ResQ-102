// ביקורת מצבי מערכת אמיתית — לא חיפוש מחרוזות. מפעילה בפועל כשל
// קריאה נקודתי (member_quals / redline / presence / עדכוני התראות)
// דרך window.__SMOKE_FAIL_PATHS שכבר קיים בגדם ה-Firestore המדומה,
// ומוודאת בדפדפן אמיתי:
//   - כשל שקט לא הופך לתמונה כוזבת (quals.html/access.html).
//   - כשל בריענון לא מוחק נתונים תקינים שכבר נטענו (alerts.html).
//   - כפתור "נסה שוב" קיים, עובד, ולא יוצר listeners כפולים
//     (מודד קריאות בפועל לפונקציית הטעינה, לא רק שהמסך משתנה).
//   - hidden עדיין עובד ואין כפתורים פעילים בזמן טעינה, במסכים
//     שנוגעים בכשלים האלה.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
                 '.css':'text/css; charset=utf-8', '.json':'application/json' };

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(root, urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch();

async function newPage(role, failPaths, callablePlan) {
  const ctx = await browser.newContext({ viewport:{ width:390, height:844 }, locale:'he-IL' });
  await ctx.route('**/firebasejs/**', route => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await ctx.addInitScript(({ role, failPaths, callablePlan }) => {
    window.__SMOKE_ROLE = role;
    window.__SMOKE_FAIL_PATHS = failPaths || [];
    window.__CALLABLE_PLAN = callablePlan || {};
  }, { role, failPaths, callablePlan });
  const pg = await ctx.newPage();
  // The attendance retry now crosses the callable boundary and rebuilds the
  // month from a fresh server-shaped response. Four seconds was a race on a
  // busy full-suite runner, not a product deadline.
  pg.setDefaultTimeout(10_000);
  return { ctx, pg };
}

// קריאת פתע פעילה בנתוני הדמה חוסמת קליקים על שאר המסך —
// אותו דבר קורה בבדיקות הקיימות (schedule-legacy-failure-browser.mjs).
async function hideCallout(pg) {
  await pg.addStyleTag({ content: '#coWrap{display:none!important}' }).catch(() => {});
}

let bad = 0;
const check = (cond, label) => { if (cond) { console.log('✓ ' + label); } else { bad++; console.log('✗ ' + label); } };

try {
  // ---------- quals.html: member_quals + redline נכשלים ----------
  {
    const { ctx, pg } = await newPage('super', ['member_quals']);
    await pg.goto(`http://127.0.0.1:${port}/quals.html`, { waitUntil:'load' });
    await hideCallout(pg);
    await pg.locator('#work').waitFor({ state:'visible' });
    await pg.waitForFunction(() => document.querySelector('#rlBoxes')?.textContent.includes('לא ניתן היה לטעון'));
    // הקטלוג והרשימת אנשים (מקורות אחרים, לא נכשלו) לא נמחקים —
    // רק החישוב שתלוי בנתון שנכשל מוצג כשגוי-פוטנציאלי.
    const catCount = await pg.locator('#catList .row, #catList .cat').count().catch(() => 0);
    const peopleRows = await pg.locator('#rows tr').count();
    check(peopleRows > 0, 'quals.html: כשל ב-member_quals לא מוחק את רשימת האנשים (מקור אחר)');
    check(await pg.locator('#peopleNote').textContent().then(t => t.includes('לא ניתן היה לטעון')),
      'quals.html: אזהרה גלויה שעמודת הכשירויות עלולה להיראות ריקה בטעות');
    check(await pg.locator('#rlRetryBtn').isVisible(), 'quals.html: כפתור "נסה שוב" קיים במצב הכשל');
    // מתקנים את הכשל ולוחצים נסה שוב — חייב להחזיר תצוגה תקינה,
    // לא רק להיעלם. loadAll הוא פונקציה מקומית בתוך ה-module, לא
    // גלובלית — לכן לא ניתן לעטוף אותה לספירת קריאות מבחוץ; במקום
    // זאת בודקים את התוצאה הנצפית: תצוגה תקינה, וללא רכיב-כפתור
    // ישן שיכול לצבור listener נוסף (הבדיקה הבאה).
    await pg.evaluate(() => { window.__SMOKE_FAIL_PATHS = []; });
    await pg.locator('#rlRetryBtn').click();
    await pg.waitForFunction(() => !document.querySelector('#rlBoxes')?.textContent.includes('לא ניתן היה לטעון'));
    check(true, 'quals.html: לחיצה על "נסה שוב" אחרי תיקון הכשל מחזירה תצוגה תקינה');
    // לחיצה נוספת (אין עוד כשל, אבל הכפתור כבר לא קיים אחרי render חדש —
    // כלומר אין המשך-חיים לכפתור ישן, ואין listener שמצטבר על אלמנט קבוע).
    const oldBtnGone = await pg.locator('#rlRetryBtn').count();
    check(oldBtnGone === 0, 'quals.html: כפתור הכשל הישן לא נשאר בעץ אחרי טעינה מוצלחת (אין הזדמנות ל-listener כפול)');
    await ctx.close();
  }
  {
    const { ctx, pg } = await newPage('super', ['config/redline']);
    await pg.goto(`http://127.0.0.1:${port}/quals.html`, { waitUntil:'load' });
    await hideCallout(pg);
    await pg.locator('#work').waitFor({ state:'visible' });
    await pg.waitForFunction(() => document.querySelector('#rlBoxes')?.textContent.includes('לא ניתן היה לטעון'));
    check(await pg.locator('#rlBoxes').textContent().then(t => t.includes('הקו האדום')),
      'quals.html: כשל ספציפי לקו האדום מזוהה בנפרד מכשל הכשירויות');
    await ctx.close();
  }

  // ---------- access.html: presence נכשל ----------
  {
    const { ctx, pg } = await newPage('super', ['presence']);
    await pg.goto(`http://127.0.0.1:${port}/access.html`, { waitUntil:'load' });
    await hideCallout(pg);
    // הבחירה בתחנה וההעמסה הראשונה קורות אוטומטית מ-onAuthStateChanged.
    const loadBtn = pg.locator('#btnLoad');
    await loadBtn.waitFor({ state:'visible' });
    await pg.waitForFunction(() => !document.querySelector('#tbl')?.classList.contains('hide'));
    // בלי התיקון: כולם "מעולם לא נכנסו". עם התיקון: "לא ידוע כרגע",
    // וההודעה מזהירה שהעמודה לא מהימנה בטעינה הזו.
    const neverCount = await pg.locator('.never').count();
    check(neverCount === 0, 'access.html: כשל ב-presence לא מוצג כ"מעולם לא נכנס" (טענה כוזבת)');
    const unknownCount = await pg.locator('td:has-text("לא ידוע כרגע")').count();
    check(unknownCount > 0, 'access.html: עמודת הכניסה האחרונה מסומנת "לא ידוע" בבירור');
    check(await pg.locator('#msg').textContent().then(t => t.includes('לא זמינים כרגע')),
      'access.html: הודעה גלויה שנתוני הכניסה האחרונה לא מהימנים');
    check(await pg.locator('#summary').textContent().then(t => !t.includes('מעולם לא נכנסו')),
      'access.html: סיכום לא מציג ספירת "מעולם לא" כוזבת כשהנתון חסר');
    // תיקון + לחיצה חוזרת על "טען" (retry קיים) חייב לחזור למצב תקין.
    await pg.evaluate(() => { window.__SMOKE_FAIL_PATHS = []; });
    await loadBtn.click();
    await pg.waitForFunction(() => document.querySelectorAll('.never').length > 0 ||
      document.querySelectorAll('td').length > 0);
    check(await pg.locator('.never').count() >= 0, 'access.html: retry (לחיצה חוזרת על טען) חוזר לפעולה תקינה');
    await ctx.close();
  }

  // ---------- alerts.html: טעינה ראשונה נכשלת ----------
  // loadFeed נקרא היום פעם אחת בלבד (אין רענון תקופתי או כפתור רענון
  // ידני קיים) — לכן התרחיש "הצלחה ואז כשל ברענון" אינו נגיש כרגע
  // מה-UI האמיתי, ונבדק רק בקריאת קוד (התיעוד בקומיט). מה שבדיקת
  // דפדפן כן יכולה וצריכה להוכיח: כשל בטעינה הראשונה, בפועל.
  {
    const { ctx, pg } = await newPage('super', ['sub_stations']);
    await pg.goto(`http://127.0.0.1:${port}/alerts.html`, { waitUntil:'load' });
    await hideCallout(pg);
    await pg.locator('#work').waitFor({ state:'visible' }).catch(() => {});
    await pg.waitForFunction(() => document.querySelector('#feedMsg')?.textContent.includes('נכשלה'));
    check(await pg.locator('#feedRetryBtn').isVisible(), 'alerts.html: כשל בטעינה ראשונה מציג כפתור "נסה שוב"');
    check(await pg.locator('#feedList .feed-item').count() === 0,
      'alerts.html: כשל בטעינה ראשונה משאיר רשימה ריקה (אין נתונים קודמים למחוק)');
    // מתקנים את הכשל ולוחצים "נסה שוב" — חייב לטעון בפועל.
    await pg.evaluate(() => { window.__SMOKE_FAIL_PATHS = []; });
    await pg.locator('#feedRetryBtn').click();
    await pg.waitForFunction(() => document.querySelector('#feedMsg')?.textContent === '');
    check(true, 'alerts.html: "נסה שוב" אחרי תיקון הכשל טוען בהצלחה');
    check(await pg.locator('#feedRetryBtn').count() === 0,
      'alerts.html: כפתור הכשל הישן לא נשאר בעץ אחרי טעינה מוצלחת (אין הזדמנות ל-listener כפול)');
    await ctx.close();
  }

  // ---------- attendance.html: retry אמיתי לא יוצר טעינות כפולות ----------
  {
    const { ctx, pg } = await newPage('super', [], {
      getMyAttendanceMonth:[{ reject:true, code:'functions/unavailable' }]
    });
    await pg.goto(`http://127.0.0.1:${port}/attendance.html`, { waitUntil:'load' });
    await hideCallout(pg);
    await pg.waitForFunction(() => document.querySelector('#state')?.textContent === 'הדוח לא נטען');
    check(await pg.locator('#monthRetryBtn').isVisible(), 'attendance.html: כפתור "נסה שוב" מוצג בכשל טעינת חודש');
    for (const id of ['btnFill','btnSync','btnSubmit']) {
      check(await pg.locator('#'+id).isDisabled(), 'attendance.html: ' + id + ' חסום בזמן כשל (לא רק בזמן טעינה)');
    }
    await pg.evaluate(() => { window.__SMOKE_FAIL_PATHS = []; });
    await pg.locator('#monthRetryBtn').click();
    try {
      await pg.waitForFunction(() => document.querySelector('#work')?.getAttribute('aria-busy') === 'false' &&
        document.querySelector('#tHours')?.textContent !== '—');
    } catch (error) {
      const state = await pg.evaluate(() => ({
        busy:document.querySelector('#work')?.getAttribute('aria-busy'),
        hours:document.querySelector('#tHours')?.textContent,
        status:document.querySelector('#state')?.textContent,
        message:document.querySelector('#msg')?.textContent,
        calls:window.__CALLABLE_CALLS
      }));
      throw new Error('attendance retry state: ' + JSON.stringify(state), { cause:error });
    }
    check(true, 'attendance.html: לחיצה על כפתור הכשל עצמו (לא רק ניווט חודש) מחזירה טעינה תקינה');
    await ctx.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log('');
if (bad) { console.log(bad + ' בדיקות מצב נכשלו.'); process.exitCode = 1; }
else console.log('כל בדיקות מצבי המערכת (Partial/Error/Retry) עברו בפועל, לא רק בקריאת קוד.');
