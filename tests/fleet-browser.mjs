/* ====================================================================
 *  fleet-browser · מצב הצי במסך האמיתי (faults.html), מול Firebase מזויף.
 *
 *  מה נבדק כאן ולא ב-`fleet.mjs` שבזיכרון: מה שהמשתמש באמת רואה
 *  ומה שבאמת נשלח לשרת.
 *
 *   · מי רואה את עריכת הצי — מפקד משמרת כן, רכזת כוח אדם לא, כבאי לא.
 *     זו אותה הכרעה שנאכפת ב-`fleetManager()` שבכללי האבטחה; כאן
 *     נבדק שהמסך אינו מציע פעולה שהשרת יחסום, ולא להפך.
 *   · עריכת רכב לוגיסטי כותבת למסמך שלו; עריכת רכב מבצעי כותבת את
 *     **מסמך הלוח כולו** עם ארבעת המפתחות שהכללים מתירים.
 *   · „הורד מהצי" מסמן `active:false` ו**אינו מוחק**, והרכב יורד גם
 *     מהבחירה בתקלה חדשה — לא רק מהרשימה.
 *   · רכב שנכתב בלי השדה `active` נשאר בצי.
 *
 *  Firebase מזויף (tests/stub), בלי רשת ובלי אמולטור.
 * ==================================================================== */

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
  const file = path.join(root, pathname === '/' ? 'faults.html' : pathname.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'text/plain; charset=utf-8' });
  response.end(fs.readFileSync(file));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + '/faults.html';

async function open(browser, role, board = false, holdProfile = false) {
  const context = await browser.newContext({ viewport:{ width:1280, height:960 }, locale:'he-IL' });
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};';
    if (holdProfile && name === 'firebase-firestore.js') {
      const anchor = 'export function getDoc(ref){';
      assert.ok(body.includes(anchor), 'profile barrier must target the actual stub entry');
      body = body.replace(anchor, anchor + `
        if (ref && ref.path === 'stations/other_station/users/new-user') {
          window.__HELD_PROFILE = true;
          return new Promise(resolve => {
            window.__RELEASE_PROFILE = () => resolve({
              exists:() => true, data:() => ({ full_name:'New commander' }), id:'new-user'
            });
          });
        }
      `);
    }
    route.fulfill({ status:200, contentType:'text/javascript',
      body });
  });
  await context.addInitScript(({ roleName, board }) => {
    window.__SMOKE_ROLE = roleName;
    window.__BOARD_EXTRA_INACTIVE = board;
  }, { roleName:role, board });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(board ? base.replace('faults.html', 'board.html') : base, { waitUntil:'load' });
  await page.locator('#work:not(.hide)').waitFor();
  if (board) {
    await page.locator('#fleet .veh').first().waitFor();
    return { context, page };
  }
  await tap(page.locator('#tabFleet'));
  await page.locator('#fleetList .v').first().waitFor();
  return { context, page };
}

const writes = (page) => page.evaluate(() => window.__FIRESTORE_WRITES || []);
const adds   = (page) => page.evaluate(() => window.__FIRESTORE_ADDS || []);
const clear  = (page) => page.evaluate(() => {
  window.__FIRESTORE_WRITES = []; window.__FIRESTORE_ADDS = [];
});
/* שכבת ההזעקה (`#coWrap`) יושבת מעל המסך ובולעת קליקים פיזיים.
   לחיצה מתוזמנת ומילוי ישיר מודדים את הלוגיקה ולא את סדר הציור. */
const tap = (locator) => locator.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles:true })));
const enter = (locator, text) => locator.evaluate((el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles:true }));
}, text);

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('✓ ' + name); }

const browser = await chromium.launch();
try {
  /* ---------- מפקד משמרת — הקבוצה שמנהלת את הצי ---------- */
  const cmd = await open(browser, 'commander');
  const page = cmd.page;

  await test('הכרטיס אומר „הוסף רכב" ומבקש שם ומספר רישוי', async () => {
    await page.locator('#anchorCard:not(.hide)').waitFor();
    assert.equal(await page.locator('#btnAnchor').textContent(), 'הוסף רכב');
    assert.equal(await page.locator('#anchorCard h2').textContent(), 'רכבים');
    assert.equal(await page.locator('#aName').getAttribute('placeholder'), 'טרנזיט לבן');
    assert.equal(await page.locator('#aPlate').getAttribute('placeholder'), '12-345-67');
  });

  await test('רכב בלי השדה active נשאר בצי; רכב שהורד ממנו אינו מופיע בשום רשימה פעילה', async () => {
    const names = await page.locator('#fleetList .v .nm').allTextContents();
    const joined = names.join(' | ');
    assert.ok(joined.includes('טרנזיט לבן'), 'רכב בלי השדה active — פעיל');
    assert.ok(joined.includes('טנדר לוגיסטי'), 'רכב עם active:true — פעיל');
    assert.equal(joined.includes('רכב שירד מהצי'), false, 'רכב מושבת אינו בצי');
    // וגם לא בבורר הרכב של תקלה חדשה — שם הוא היה חוזר מהדלת האחורית
    const options = await page.locator('#nVeh option').allTextContents();
    assert.equal(options.join(' | ').includes('רכב שירד מהצי'), false);
  });

  await test('לכל רכב בצי יש כפתור עריכה — גם מבצעי וגם לוגיסטי', async () => {
    const rows = await page.locator('#fleetList .v').count();
    assert.ok(rows >= 4, 'הצי מכיל רכבים משני המקורות, נמצאו ' + rows);
    assert.equal(await page.locator('#fleetList [data-veh-edit]').count(), rows);
  });

  await test('רכב שירד מהצי מוצג ברשימת „ירדו מהצי" עם דרך אחת בחזרה', async () => {
    const off = page.locator('#anchorList [data-veh-off]');
    assert.equal(await off.count(), 1);
    assert.ok((await off.first().textContent()).includes('רכב שירד מהצי'));
    assert.equal(await page.locator('#anchorList [data-veh-restore="a3"]').count(), 1);
  });

  await test('עריכת רכב לוגיסטי כותבת למסמך שלו בלבד — שם ומספר רישוי, בלי לגעת ב-active', async () => {
    await clear(page);
    await tap(page.locator('#fleetList [data-veh-edit="a1"]'));
    await page.locator('#veh.on').waitFor();
    assert.equal(await page.locator('#vRoleWrap').getAttribute('class'), 'hide',
      'רכב לוגיסטי אינו מציג שדה ייעוד');
    assert.equal(await page.locator('#vName').inputValue(), 'טרנזיט לבן');
    assert.equal(await page.locator('#vPlate').inputValue(), '12-345-67');
    await enter(page.locator('#vName'), 'טרנזיט כחול');
    await enter(page.locator('#vPlate'), '55-555-55');
    await tap(page.locator('#vehSave'));
    await page.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length > 0);
    const w = (await writes(page)).filter(x => x.path.indexOf('vehicles/') !== -1);
    assert.equal(w.length, 1, JSON.stringify(await writes(page)));
    assert.equal(w[0].path, 'stations/eilat_102/vehicles/a1');
    assert.deepEqual(w[0].value, { name:'טרנזיט כחול', plate:'55-555-55' });
    assert.deepEqual(w[0].options, { merge:true });
  });

  await test('שם ריק נחסם במסך ואינו מגיע לשרת', async () => {
    await clear(page);
    await tap(page.locator('#fleetList [data-veh-edit="a1"]'));
    await page.locator('#veh.on').waitFor();
    await enter(page.locator('#vName'), '   ');
    await tap(page.locator('#vehSave'));
    assert.equal((await writes(page)).length, 0, 'שום כתיבה לא יצאה');
    assert.ok((await page.locator('#vehMsg').textContent()).includes('שם'));
    await tap(page.locator('#vehCancel'));
  });

  await test('עריכת רכב מבצעי כותבת את מסמך הלוח כולו — ארבעה מפתחות, שאר הרכבים כפי שהם', async () => {
    await clear(page);
    const first = await page.locator('#fleetList [data-veh-edit]').first().getAttribute('data-veh-edit');
    await tap(page.locator('#fleetList [data-veh-edit="' + first + '"]'));
    await page.locator('#veh.on').waitFor();
    assert.equal(await page.locator('#vRoleWrap').getAttribute('class'), '',
      'רכב מבצעי כן מציג שדה ייעוד');
    await enter(page.locator('#vName'), 'רכב בשם חדש');
    await tap(page.locator('#vehSave'));
    await page.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length > 0);
    const w = (await writes(page)).filter(x => x.path === 'stations/eilat_102/config/board');
    assert.equal(w.length, 1);
    assert.deepEqual(Object.keys(w[0].value).sort(), ['by', 'command', 'updated_at', 'vehicles']);
    const changed = w[0].value.vehicles.filter(v => v.id === first);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].name, 'רכב בשם חדש');
    assert.ok(Array.isArray(changed[0].slots), 'המשבצות נשמרו בעריכת שם');
    assert.ok(w[0].value.vehicles.length >= 3, 'שאר הרכבים לא נמחקו מהמסמך');
    assert.ok(Array.isArray(w[0].value.command) && w[0].value.command.length > 0,
      'שרשרת הפיקוד נכתבת בחזרה כפי שהיא');
  });

  await test('„הורד מהצי" מסמן active:false ואינו מוחק דבר', async () => {
    await clear(page);
    await tap(page.locator('#fleetList [data-veh-edit="a2"]'));
    await page.locator('#veh.on').waitFor();
    await tap(page.locator('#vehOff'));
    await page.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length > 0);
    const w = (await writes(page)).filter(x => x.path.indexOf('vehicles/') !== -1);
    assert.equal(w.length, 1);
    assert.equal(w[0].path, 'stations/eilat_102/vehicles/a2');
    assert.equal(w[0].value.active, false);
    assert.ok('deactivated_at' in w[0].value && 'deactivated_by' in w[0].value);
    assert.deepEqual(w[0].options, { merge:true });
  });

  await test('הורדת רכב **מבצעי** מהצי — חותמת שרת לעולם לא נכנסת לתוך מערך', async () => {
    // הבאג שנתפס ב-seq477: `serverTimestamp()` בתוך אובייקט שיושב במערך
    // `vehicles[]`. Firebase דוחה: invalid-argument. הבדיקה הקודמת בדקה
    // רק רכב לוגיסטי — מסמך משלו, שם החותמת חוקית — ולכן לא ראתה כלום.
    await clear(page);
    const opId = await page.locator('#fleetList [data-veh-edit]').first().getAttribute('data-veh-edit');
    await tap(page.locator('#fleetList [data-veh-edit="' + opId + '"]'));
    await page.locator('#veh.on').waitFor();
    await tap(page.locator('#vehOff'));
    await page.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length > 0);
    const w = (await writes(page)).filter(x => x.path === 'stations/eilat_102/config/board');
    assert.equal(w.length, 1, 'הכתיבה יצאה ולא נדחתה');
    const off = w[0].value.vehicles.filter(v => v.id === opId)[0];
    assert.equal(off.active, false);
    assert.equal(typeof off.deactivated_at, 'string',
      'בתוך מערך החותמת היא מחרוזת ISO מהלקוח, לא sentinel של השרת');
    assert.match(off.deactivated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok((await page.locator('#vehMsg').textContent() || '') === '' ||
      !(await page.locator('#vehMsg').textContent()).includes('invalid-argument'),
      'לא נדחה על ידי ה-SDK');
    // ובמסמך עצמו — שם החותמת כן צריכה להיות של השרת
    assert.deepEqual(w[0].value.updated_at, { __sentinel: 'serverTimestamp' },
      'updated_at ברמת המסמך — שם חותמת שרת חוקית ועדיפה');
  });

  await test('„החזר לצי" מנקה את סימון ההשבתה', async () => {
    await clear(page);
    await tap(page.locator('#anchorList [data-veh-restore="a3"]'));
    await page.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length > 0);
    const w = (await writes(page)).filter(x => x.path.indexOf('vehicles/') !== -1);
    assert.equal(w.length, 1);
    assert.equal(w[0].path, 'stations/eilat_102/vehicles/a3');
    assert.deepEqual(w[0].value, { active:true, deactivated_at:null, deactivated_by:'' });
  });

  await test('הוספת רכב שולחת שם, מספר רישוי ו-active:true', async () => {
    await clear(page);
    await enter(page.locator('#aName'), '  רכב חדש  ');
    await enter(page.locator('#aPlate'), ' 77-777-77 ');
    await tap(page.locator('#btnAnchor'));
    await page.waitForFunction(() => (window.__FIRESTORE_ADDS || []).length > 0);
    const a = await adds(page);
    assert.equal(a.length, 1);
    assert.equal(a[0].path, 'stations/eilat_102/vehicles');
    assert.equal(a[0].value.name, 'רכב חדש', 'רווחים נגזמים');
    assert.equal(a[0].value.plate, '77-777-77');
    assert.equal(a[0].value.active, true);
    assert.equal(a[0].value.kind, 'anchor');
  });

  await test('הוספה בלי שם אינה יוצרת רכב', async () => {
    await clear(page);
    await enter(page.locator('#aName'), '');
    await enter(page.locator('#aPlate'), '99-999-99');
    await tap(page.locator('#btnAnchor'));
    assert.equal((await adds(page)).length, 0);
    assert.ok((await page.locator('#anchorMsg').textContent()).includes('שם'));
  });
  await cmd.context.close();

  /* ---------- רכזת כוח אדם — staff, אך לא מנהלת צי ---------- */
  const hr = await open(browser, 'hr');
  await test('רכזת כוח אדם רואה את הצי ואינה עורכת אותו — לא כרטיס, לא כפתור', async () => {
    assert.ok((await hr.page.locator('#anchorCard').getAttribute('class')).includes('hide'),
      'כרטיס הוספת הרכב מוסתר');
    assert.equal(await hr.page.locator('#fleetList [data-veh-edit]').count(), 0);
    assert.equal(await hr.page.locator('[data-veh-restore]').count(), 0);
    assert.ok(await hr.page.locator('#fleetList .v').count() > 0, 'אבל היא כן רואה את הצי');
  });
  await hr.context.close();

  /* ---------- כבאי ---------- */
  const ff = await open(browser, 'firefighter');
  await test('כבאי רואה את הצי ואינו עורך אותו', async () => {
    assert.ok((await ff.page.locator('#anchorCard').getAttribute('class')).includes('hide'));
    assert.equal(await ff.page.locator('#fleetList [data-veh-edit]').count(), 0);
    assert.ok(await ff.page.locator('#fleetList .v').count() > 0);
  });
  await ff.context.close();

  /* ---------- סגן מפקד משמרת ---------- */
  const dep = await open(browser, 'deputy');
  await test('סגן מפקד משמרת עורך את הצי', async () => {
    await dep.page.locator('#anchorCard:not(.hide)').waitFor();
    assert.ok(await dep.page.locator('#fleetList [data-veh-edit]').count() > 0);
  });
  await dep.context.close();

  /* ================================================================
   *  seq485 §B · שלושת פערי הזהות שנשארו פתוחים אחרי seq483.
   *
   *  שלושתם באותו נושא: „מי המשתמש עכשיו" נמדד ממצב המסך, ומצב המסך
   *  מתעדכן **אחרי** ש-Firebase כבר החליף. כל בדיקה כאן נכשלת על
   *  הקוד הקודם ועוברת על הנוכחי.
   * ================================================================ */

  /* ---------- B1 · כתיבה בחלון שבין ההחלפה למסירת ה-callback ---------- */
  const race = await open(browser, 'commander');
  await test('seq485 §B1: המשתמש החי התחלף וה-callback עוד לא נמסר — הכתיבה נעצרת', async () => {
    const page = race.page;
    await tap(page.locator('#fleetList [data-veh-edit]').first());
    await page.locator('#veh.on').waitFor();
    await enter(page.locator('#vName'), 'טרנזיט מעודכן');
    await clear(page);

    /* ב׳ מחליף את א׳ ב-Firebase. ה-observer **לא** מודיע — בדיוק כמו
     * במסירה אסינכרונית שעוד לא הגיעה. ME, SID ו-AUTH_GEN של א׳. */
    const swapped = await page.evaluate(() => {
      window.__SMOKE_SWAP_USER('commander', 'uid-bob');
      return window.__SMOKE_ROLE ? true : true;
    });
    assert.equal(swapped, true);

    await tap(page.locator('#vehSave'));
    await page.waitForTimeout(150);
    const w = await writes(page);
    assert.equal(w.length, 0,
      'כתיבה יצאה בזמן שהמשתמש החי כבר אחר — היא הייתה נרשמת על השם הלא נכון');
    assert.equal(await page.locator('#veh.on').count(), 0, 'stale editor must close');
    assert.equal(await page.locator('#mainMsg').isVisible(), true, 'feedback must remain visible outside the closed editor');
    const shown = await page.locator('#mainMsg').textContent();
    assert.ok(/identity-changed/.test(shown), 'והמשתמש רואה שהזהות התחלפה: ' + shown);
  });
  await race.context.close();

  /* ---------- B2 · תשובת claims ישנה שחוזרת אחרי החלפה ---------- */
  const stale = await browser.newContext({ viewport:{ width:1280, height:960 }, locale:'he-IL' });
  await stale.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await stale.addInitScript(() => { window.__SMOKE_ROLE = 'commander'; });
  const stalePage = await stale.newPage();
  await stalePage.clock.install();
  stalePage.on('dialog', (dialog) => dialog.accept());
  await stalePage.goto(base, { waitUntil:'load' });
  await stalePage.locator('#work:not(.hide)').waitFor();

  await test('seq485 §B2: תשובת claims של א׳ שחוזרת אחרי שב׳ נכנס — נזרקת, ואין רענון', async () => {
    let reloaded = 0;
    stalePage.on('framenavigated', () => { reloaded += 1; });

    // הפולינג יוצא, והתשובה נתקעת
    await stalePage.evaluate(() => { window.__SMOKE_DEFER_CLAIMS = true; });
    await stalePage.clock.runFor(60 * 1000);
    await stalePage.waitForTimeout(50);
    const pending = await stalePage.evaluate(() => (window.__SMOKE_CLAIMS_PENDING || []).length);
    assert.equal(pending, 1, 'הפולינג אכן ממתין לתשובה');

    /* ובינתיים ב׳ נכנס. ה-handler שלו רץ עד הסוף — הדור עלה, החתימה
     * היא של ב׳, המסך הוא של ב׳. התשובה של א׳ עדיין תלויה באוויר. */
    await stalePage.evaluate(() => { window.__SMOKE_DEFER_CLAIMS = false; });
    await stalePage.evaluate(() => { window.__SMOKE_EMIT_AUTH('commander', 'uid-bob'); });
    await stalePage.waitForTimeout(120);
    reloaded = 0;

    // ורק עכשיו התשובה של א׳ חוזרת — לזהות שכבר אינה על המסך
    const released = await stalePage.evaluate(() => window.__SMOKE_RELEASE_CLAIMS());
    assert.equal(released, 1, 'התשובה התלויה של א׳ שוחררה');
    await stalePage.waitForTimeout(200);
    assert.equal(reloaded, 0,
      'תשובה ישנה גררה רענון של המסך של ב׳ — repro של seq485 §B2');
  });
  await stale.close();

  /* ---------- B3 · שינוי הרשאה שאינו נוגע בצי ---------- */
  const priv = await browser.newContext({ viewport:{ width:1280, height:960 }, locale:'he-IL' });
  await priv.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status:200, contentType:'text/javascript',
      body:fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await priv.addInitScript(() => { window.__SMOKE_ROLE = 'hr'; });
  const privPage = await priv.newPage();
  await privPage.clock.install();
  privPage.on('dialog', (dialog) => dialog.accept());
  await privPage.goto(base, { waitUntil:'load' });
  await privPage.locator('#work:not(.hide)').waitFor();

  await test('seq485 §B3: רכזת שהפכה לכבאית — אותו uid, אותה תחנה, fleet=false בשניהם — נתפס', async () => {
    let reloaded = 0;
    privPage.on('framenavigated', () => { reloaded += 1; });
    /* שני התפקידים אינם מנהלי צי, ולכן ההשוואה הישנה — תחנה, CAN_FLEET
     * ו-uid — לא ראתה שום הבדל, ו-CAN_MANAGE נשאר true. */
    await privPage.evaluate(() => { window.__SMOKE_SWAP_USER('firefighter', 'stub-uid'); });
    await privPage.clock.runFor(60 * 1000);
    await privPage.waitForTimeout(200);
    assert.equal(reloaded > 0, true,
      'שינוי תפקיד שאינו נוגע בצי לא נתפס — repro של seq485 §B3');
  });
  await priv.close();

  for (const phase of ['held', 'ready']) {
    for (const action of ['restore', 'edit']) {
      const item = await open(browser, 'commander', false, true);
      await test('old ' + action + ' callback cannot cross stations after new profile is ' + phase, async () => {
        const p = item.page;
        const selector = action === 'restore' ? '[data-veh-restore="a3"]' : '[data-veh-edit="a1"]';
        await p.evaluate(selector => {
          window.__OLD_FLEET_ACTION = document.querySelector(selector).onclick;
          window.__FIRESTORE_WRITES = [];
          window.__SMOKE_EMIT_AUTH('commander', 'new-user', { stationId:'other_station' });
        }, selector);
        await p.waitForFunction(() => window.__HELD_PROFILE === true);
        if (phase === 'ready') {
          await p.evaluate(() => window.__RELEASE_PROFILE());
          await p.waitForFunction(() => document.getElementById('whoSub').textContent.includes('New commander'));
          await p.locator('#fleetList .v').first().waitFor();
        }
        await p.evaluate(async () => {
          await window.__OLD_FLEET_ACTION({ stopPropagation(){} });
          if (document.getElementById('veh').classList.contains('on')) {
            document.getElementById('vName').value = 'Old station content';
            await document.getElementById('vehSave').onclick();
          }
        });
        assert.deepEqual(await writes(p), [], 'old rendered record must not mint a new station write fence');
        assert.equal(await p.locator('#veh.on').count(), 0);
        assert.equal(await p.locator('#mainMsg').isVisible(), true);
        assert.match(await p.locator('#mainMsg').textContent(), /identity-changed/);
        if (phase === 'held') {
          assert.equal(await p.locator('#work').isVisible(), false);
          assert.equal(await p.locator('[data-veh-edit], [data-veh-restore]').count(), 0);
        } else if (action === 'restore') {
          // Resetting the UI must not disable a freshly rendered authorized action.
          await p.locator('[data-veh-restore="a3"]').evaluate(async el => el.onclick());
          assert.equal((await writes(p))[0].path, 'stations/other_station/vehicles/a3');
        }
      });
      await item.context.close();
    }
  }

  const boardHr = await open(browser, 'hr', true);
  await test('board HR retains command/assignment controls, not fleet structural controls', async () => {
    assert.equal(await boardHr.page.locator('#btnAddVeh').isVisible(), false);
    assert.equal(await boardHr.page.locator('#fleet .tools, #fleet .srow .x').count(), 0);
    assert.ok(await boardHr.page.locator('#fleet .srow.click').count() > 0);
    assert.ok(await boardHr.page.locator('#chain .click').count() > 0);
  });
  await boardHr.context.close();

  const editBoard = async page => {
    await tap(page.locator('#fleet .tools button[title="שם הרכב"]').first());
    await enter(page.locator('#vn'), 'Pending edit');
    await clear(page);
  };
  for (const retry of [false, true]) {
    const item = await open(browser, 'commander', true);
    await test('board transaction rejects live identity change ' + (retry ? 'on retry' : 'during held read'), async () => {
      const p = item.page;
      await editBoard(p);
      await p.evaluate(retry => {
        if (retry) window.__TX_RETRY_SWAP = { role:'commander', uid:'other-author' };
        else window.__TX_HOLD_READ = true;
      }, retry);
      await tap(p.locator('#vsave'));
      if (!retry) {
        await p.waitForFunction(() => window.__TX_READ_PENDING > 0);
        await p.evaluate(() => {
          window.__SMOKE_SWAP_USER('commander', 'other-author');
          window.__TX_HOLD_READ = false;
          window.__TX_RELEASE_READ();
        });
      }
      await p.waitForFunction(() => document.getElementById('msg').textContent.includes('identity-changed'));
      assert.deepEqual(await writes(p), [], 'neither tx attempt may write for the replacement user');
    });
    await item.context.close();
  }
  const conflict = await open(browser, 'commander', true);
  await test('board CAS refuses a changed server basis without overwriting it', async () => {
    const p = conflict.page;
    await editBoard(p);
    await p.evaluate(() => {
      window.__TX_DOC_OVERRIDE = { 'stations/eilat_102/config/board': { vehicles:[], command:[] } };
    });
    await tap(p.locator('#vsave'));
    await p.waitForFunction(() => document.getElementById('msg').textContent.includes('מישהו אחר'));
    assert.deepEqual(await writes(p), []);
  });
  await conflict.context.close();

  const retained = await open(browser, 'commander', true);
  await test('board deactivation preserves inactive records/slots and does not write assignments', async () => {
    const p = retained.page;
    await editBoard(p);
    await tap(p.locator('#vdel'));
    await p.waitForFunction(() => (window.__FIRESTORE_WRITES || []).length > 0);
    const w = await writes(p);
    assert.equal(w.length, 1);
    assert.equal(w[0].path, 'stations/eilat_102/config/board');
    assert.equal(w[0].value.vehicles.length, 4);
    assert.equal(w[0].value.vehicles.find(v => v.id === 'v1').active, false);
    assert.ok(w[0].value.vehicles.find(v => v.id === 'v1').slots.length > 0);
    assert.deepEqual(w[0].value.vehicles.find(v => v.id === 'already-off').slots,
      [{ id:'off-slot', job:'kept', req:'' }]);
    assert.equal(w[0].value.by, 'stub-uid');
  });
  await retained.context.close();

  const staleBoard = await open(browser, 'commander', true);
  await test('board closes a stale editor on identity-token change', async () => {
    await editBoard(staleBoard.page);
    await staleBoard.page.evaluate(() => window.__SMOKE_EMIT_ID_TOKEN('firefighter', 'new-reader'));
    await staleBoard.page.waitForFunction(() => !document.getElementById('ov').classList.contains('on'));
    assert.equal(await staleBoard.page.locator('#vsave').count(), 0);
    assert.deepEqual(await writes(staleBoard.page), []);
  });
  await staleBoard.context.close();

  console.log('\n' + passed + ' fleet browser checks passed.');
} finally {
  await browser.close();
  server.close();
}
