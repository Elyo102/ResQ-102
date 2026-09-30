/**
 * בדיקות דפדפן · schedule-planner.
 *
 * נבנה אחרי שהתברר שבדיקות לוגיות עוברות בזמן שהמסך שבור לגמרי:
 * התנגשות שם מחלקה ב-CSS דחסה רשימת שמות אנכית לשורה אחת,
 * וכל הבדיקות היו ירוקות. מסך שלא נפתח הוא מסך שלא נבדק.
 *
 * רץ על Chromium דרך Playwright. רוחבי חובה: 1440, 390, 360.
 */

import { chromium } from './lib/contained-playwright.cjs';
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// מסכי החבילה הם אב-טיפוס לבדיקות בלבד. הם נשמרים מתחת tests
// כדי שלא ייכנסו בטעות ל-Firebase Hosting שמפרסם את שורש הריפו.
const fixtureRoot = join(here, 'fixtures', 'schedule-planner');
let fixtureHtml = fs.readFileSync(join(fixtureRoot, 'schedule-planner.html'), 'utf8');
for (const [from, to] of [
  ['<link rel="preconnect" href="https://fonts.googleapis.com">', ''],
  ['<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', ''],
  ['https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800&display=swap', '/fixture-font.css']
]) {
  if (fixtureHtml.split(from).length !== 2) throw Error('Planner fixture dependency changed');
  fixtureHtml = fixtureHtml.replace(from, to);
}
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/schedule-planner.html') {
    res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' }); res.end(fixtureHtml);
  } else if (pathname === '/schedule-planner.js') {
    res.writeHead(200, { 'Content-Type':'text/javascript; charset=utf-8' });
    res.end(fs.readFileSync(join(fixtureRoot, 'schedule-planner.js')));
  } else if (pathname === '/fixture-font.css') {
    res.writeHead(200, { 'Content-Type':'text/css' }); res.end('');
  } else if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); }
  else { res.writeHead(404); res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PAGE = 'http://127.0.0.1:' + server.address().port + '/schedule-planner.html';

let pass = 0;
const fails = [];
async function t(name, fn) {
  try { await fn(); pass += 1; }
  catch (e) { fails.push(name + ' → ' + (e && e.message)); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

let browser;
try {
browser = await chromium.launch();

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  const fontOnly = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('requestfailed', (r) => {
    errors.push('request failed: ' + r.url());
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    errors.push('console: ' + m.text());
  });
  await page.goto(PAGE);
  await page.waitForSelector('#grid .cell, #mine .card, .viewtabs button');
  return { page, errors, fontOnly };
}

/* ================= שולחן עבודה ================= */

const desk = await open(1440, 1000);

await t('אין שגיאות עמוד', () => ok(desk.errors.length === 0, desk.errors.join(' | ')));

await t('הכותרת והנתיב הם ניהול סידור עבודה', async () => {
  ok((await desk.page.textContent('#title')).trim() === 'ניהול סידור עבודה', 'כותרת שגויה');
  ok((await desk.page.textContent('#crumb')).indexOf('ניהול') === 0, 'הנתיב אינו מתחיל בניהול');
});

await t('שמות מוצגים אחד מתחת לשני ולא בשורה אחת', async () => {
  const r = await desk.page.evaluate(() => {
    const cells = [...document.querySelectorAll('#grid .cell')];
    const cell = cells.find((c) => c.querySelectorAll('.n').length >= 4);
    if (!cell) return { found: false };
    const ns = [...cell.querySelectorAll('.n')];
    const tops = ns.map((n) => Math.round(n.getBoundingClientRect().top));
    return {
      found: true,
      count: ns.length,
      distinctTops: new Set(tops).size,
      display: getComputedStyle(cell).display,
      minWidth: Math.min(...ns.map((n) => n.getBoundingClientRect().width))
    };
  });
  ok(r.found, 'לא נמצאה משבצת עם ארבעה שמות');
  ok(r.distinctTops === r.count, 'השמות אינם בשורות נפרדות: ' + r.distinctTops + '/' + r.count);
  ok(r.display !== 'flex', 'המשבצת היא flex — זו בדיוק ההתנגשות שנתפסה');
  ok(r.minWidth > 20, 'שם נדחס לרוחב ' + r.minWidth);
});

await t('קו המינימום מופיע בלוח', async () => {
  const n = await desk.page.evaluate(() => document.querySelectorAll('#grid .rule').length);
  ok(n > 0, 'אין קו מינימום');
});

await t('סדר השורות תואם למפרט', async () => {
  const labels = await desk.page.evaluate(() =>
    [...document.querySelectorAll('#grid .rowlab')].map((x) => x.textContent.trim()));
  const expected = ['אילת', 'שחמון', 'תמנע', 'יטבתה', 'משימות', 'לא זמין'];
  ok(JSON.stringify(labels) === JSON.stringify(expected), 'סדר שורות: ' + labels.join(','));
});

await t('הימים הם עמודות עם תאריך ושם יום', async () => {
  const heads = await desk.page.evaluate(() =>
    [...document.querySelectorAll('#grid .hd')].slice(1).map((x) => x.textContent.trim()));
  ok(heads.length === 8, 'מספר עמודות: ' + heads.length);
  ok(heads.every((h) => /\d+\/\d+/.test(h)), 'עמודה בלי תאריך');
});

await t('שיבוץ ידני מופיע ראשון במשבצת', async () => {
  const first = await desk.page.evaluate(() => {
    const c = document.querySelector('#grid .cell');
    const n = c && c.querySelector('.n');
    return n ? n.textContent.trim() : null;
  });
  ok(first === 'כבאי 002', 'ראשון במשבצת: ' + first);
});

await t('אין תווית תפקיד בתוך המשבצת', async () => {
  const bad = await desk.page.evaluate(() => {
    const txt = [...document.querySelectorAll('#grid .cell .n')].map((n) => n.textContent).join(' ');
    return ['ראש משמרת', 'מפקד צוות', 'נהג', 'לוחם', 'סגן'].filter((w) => txt.indexOf(w) > -1);
  });
  ok(bad.length === 0, 'תוויות תפקיד במשבצת: ' + bad.join(','));
});

await t('סימן שאלה מופיע למי שטרם אישר', async () => {
  const n = await desk.page.evaluate(() => document.querySelectorAll('#grid .n .q').length);
  ok(n > 0, 'אין סימני שאלה');
});

await t('טווחי שעות אינם מתהפכים', async () => {
  const times = await desk.page.evaluate(() =>
    [...document.querySelectorAll('#grid .blk time')].map((x) => x.textContent.trim()));
  const ranges = times.filter((x) => x.indexOf('–') > -1);
  ok(ranges.length > 0, 'אין טווחי שעות לבדיקה');
  ranges.forEach((r) => {
    const m = r.match(/^(\d{2}):(\d{2})–(\d{2}):(\d{2})$/);
    ok(!!m, 'טווח בפורמט לא צפוי: ' + r);
  });
  ok(ranges.indexOf('15:00–08:00') === -1, 'טווח מתהפך');
});

await t('הפרדת התצוגות: כבאי אינו רואה את לשונית הניהול', async () => {
  await desk.page.selectOption('#roleSel', 'firefighter');
  await desk.page.waitForTimeout(120);
  const hidden = await desk.page.evaluate(() => document.getElementById('manageTab').hidden);
  ok(hidden === true, 'לשונית הניהול גלויה לכבאי');
  const manageVisible = await desk.page.evaluate(() => !document.getElementById('manageWrap').hidden);
  ok(manageVisible === false, 'מסך הניהול נשאר פתוח לכבאי');
  await desk.page.selectOption('#roleSel', 'scheduler');
  await desk.page.waitForTimeout(120);
});

await t('סידור התחנה מציג אתמול, היום ומחר', async () => {
  await desk.page.click('.viewtabs [data-view="station"]');
  await desk.page.waitForSelector('#station .dayCol');
  const heads = await desk.page.evaluate(() =>
    [...document.querySelectorAll('#station .dayHead')].map((x) => x.firstChild.textContent.trim()));
  ok(JSON.stringify(heads) === JSON.stringify(['אתמול', 'היום', 'מחר']), 'עמודות: ' + heads.join(','));
});

await t('המשתמש המחובר מודגש בסידור התחנה', async () => {
  const n = await desk.page.evaluate(() => document.querySelectorAll('#station .n.me').length);
  ok(n > 0, 'אין הדגשה למשתמש המחובר');
});

/** מדלג קדימה עד ליום שבו המשתמש באמת משובץ. בלי זה הבדיקה עוברת ריק. */
async function gotoAssignedDay(page) {
  await page.click('.viewtabs [data-view="mine"]');
  await page.waitForSelector('#mine .cards');
  for (let i = 0; i < 8; i += 1) {
    const has = await page.evaluate(() => document.querySelectorAll('#mine .who').length > 0);
    if (has) return true;
    const btn = await page.$('#nextDay');
    if (!btn) return false;
    await btn.click();
    await page.waitForTimeout(60);
  }
  return false;
}

await t('הסידור שלי מציג צוות וכשירויות ביום שבו הוא משובץ', async () => {
  const found = await gotoAssignedDay(desk.page);
  ok(found, 'לא נמצא יום שבו המשתמש משובץ');
  const r = await desk.page.evaluate(() => ({
    who: document.querySelectorAll('#mine .who').length,
    chips: document.querySelectorAll('#mine .chip').length,
    crew: document.querySelectorAll('#mine .crew').length,
    empty: document.querySelectorAll('#mine .card.empty').length
  }));
  ok(r.who > 0, 'אין כרטיס אישי');
  ok(r.empty === 0, 'מוצג מצב ריק למרות שיבוץ');
  ok(r.chips > 0, 'אין תגיות כשירות');
  ok(r.crew > 0, 'אין רשימת צוות');
});

await t('הסידור שלי אינו מציג אנשים אחרים ככרטיס', async () => {
  const names = await desk.page.evaluate(() =>
    [...document.querySelectorAll('#mine .who .nm')].map((x) => x.childNodes[0].textContent.trim()));
  ok(names.length > 0, 'אין כרטיסים לבדיקה — הבדיקה הייתה עוברת ריק');
  ok(names.every((n) => n === 'כבאי 001'), 'כרטיס של אדם אחר: ' + names.join(','));
});

await desk.page.close();

/* ================= נייד · 390 ו-360 ================= */

for (const width of [390, 360]) {
  const m = await open(width, 780);

  await t(width + ' · אין שגיאות עמוד', () => ok(m.errors.length === 0, m.errors.join(' | ')));

  await t(width + ' · אין גלילה אופקית של הדף', async () => {
    const r = await m.page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth
    }));
    ok(r.doc <= r.win + 1, 'הדף רחב מהמסך: ' + r.doc + ' > ' + r.win);
  });

  await t(width + ' · מתג התצוגות גלוי ובלחיצה אחת', async () => {
    const r = await m.page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.viewtabs button')].filter((b) => !b.hidden);
      return tabs.map((b) => {
        const rc = b.getBoundingClientRect();
        return { text: b.textContent.trim(), h: Math.round(rc.height), visible: rc.width > 0 && rc.top >= 0 };
      });
    });
    ok(r.length === 3, 'מספר לשוניות: ' + r.length);
    ok(r.every((x) => x.visible), 'לשונית מוסתרת');
    ok(r.every((x) => x.h >= 40), 'שטח מגע קטן מדי: ' + JSON.stringify(r));
    const texts = r.map((x) => x.text);
    ok(texts.indexOf('הסידור שלי') > -1 && texts.indexOf('סידור התחנה') > -1, 'חסרה תצוגה');
  });

  await t(width + ' · מעבר בלחיצה בין שלי לתחנה', async () => {
    await m.page.click('.viewtabs [data-view="mine"]');
    await m.page.waitForSelector('#mine .cards');
    ok(await m.page.evaluate(() => !document.getElementById('mine').hidden), 'שלי אינו נפתח');
    await m.page.click('.viewtabs [data-view="station"]');
    await m.page.waitForSelector('#station .dayCol');
    ok(await m.page.evaluate(() => !document.getElementById('station').hidden), 'התחנה אינה נפתחת');
    ok(await m.page.evaluate(() => document.getElementById('mine').hidden), 'שלי נשאר פתוח');
  });

  await t(width + ' · שמות בסידור התחנה אינם נחתכים', async () => {
    const r = await m.page.evaluate(() => {
      const ns = [...document.querySelectorAll('#station .n')];
      return {
        count: ns.length,
        clipped: ns.filter((n) => n.scrollWidth > n.clientWidth + 2).length
      };
    });
    ok(r.count > 0, 'אין שמות');
    ok(r.clipped === 0, r.clipped + ' שמות נחתכו');
  });

  await t(width + ' · כפתורי אישור בגודל מגע תקין', async () => {
    await m.page.click('.viewtabs [data-view="mine"]');
    await m.page.waitForSelector('#mine .cards');
    const r = await m.page.evaluate(() => {
      const b = [...document.querySelectorAll('#mine .acts button')];
      return b.map((x) => Math.round(x.getBoundingClientRect().height));
    });
    ok(r.length > 0, 'אין כפתורי אישור לבדיקה — הבדיקה הייתה עוברת ריק');
    ok(r.every((h) => h >= 40), 'כפתור נמוך מ-40 פיקסל: ' + r.join(','));
  });

  await t(width + ' · חצי הניווט אינם מתהפכים', async () => {
    const r = await m.page.evaluate(() => {
      const prev = document.getElementById('prevDay') || document.getElementById('prevDay2');
      const next = document.getElementById('nextDay') || document.getElementById('nextDay2');
      if (!prev || !next) return null;
      return { prevLeft: prev.getBoundingClientRect().left, nextLeft: next.getBoundingClientRect().left };
    });
    ok(!!r, 'לא נמצאו חצים');
    ok(r.prevLeft > r.nextLeft, 'ב-RTL „יום קודם" חייב להיות מימין');
  });

  await t(width + ' · שעות בכרטיס אינן מתהפכות', async () => {
    const times = await m.page.evaluate(() =>
      [...document.querySelectorAll('#mine .hours')].map((x) => x.textContent.trim()));
    times.forEach((x) => {
      const mm = x.match(/^(\d{2}):(\d{2})–(\d{2}):(\d{2})$/);
      ok(!!mm || x === 'כל היום', 'שעות בפורמט לא צפוי: ' + x);
    });
  });

  await m.page.close();
}

await t('מחסנית גופן חלופי נשמרת עם CSS גופן מקומי ריק', async () => {
  const p = await open(1280, 900);
  const font = await p.page.evaluate(() => getComputedStyle(document.body).fontFamily);
  ok(/Heebo/.test(font), 'מחסנית הגופנים אינה כוללת Heebo');
  ok(/system-ui|sans-serif/.test(font), 'אין גופן חלופי אם ה-CDN אינו זמין');
  await p.page.close();
});

} finally {
  try { if (browser) await browser.close(); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

console.log((fails.length ? '✗' : '✓') + ' schedule-planner-browser: ' + pass + '/' + (pass + fails.length));
if (fails.length) { fails.forEach((f) => console.log('   ✗ ' + f)); process.exit(1); }
