// Service Worker אמיתי — Scope 12 item 11 (closure batch item 4):
// old-cache activation, cold load, refresh/update, offline→online.
//
// עד היום tests/pwa-update.mjs בדק רק את לוגיקת התיאום בצד הדפדפן
// (pwa.js) מול מחלקת Events() מדומה — לא רשם אף פעם Service Worker
// אמיתי, לא פתח caches אמיתי, ולא הפעיל מצב offline אמיתי. הבדיקה הזו
// עושה את כל השלוש: רושמת את firebase-messaging-sw.js **האמיתי**
// (אותו קובץ שמופעל בייצור, לא עותק מקוצר) דרך registerSW() האמיתי
// מ-pwa.js, מול שרת HTTP אמיתי שמגיש את קבצי הריפו בפועל.
//
// שני ה-importScripts ל-gstatic.com (compat SDK) מוחלפים בכתובת מקומית
// עם תחליף מינימלי, ע"י שכפול ממשי של הקובץ האמיתי מהדיסק ושינוי מחרוזת
// שתי הכתובות בלבד לפני ההגשה. ניסיתי קודם לייצג את זה עם context.route
// (כמו בכל שאר בדיקות הדפדפן בפרויקט) — זה לא עובד: routing ברמת ה-
// context אינו מיירט importScripts שמקורו ב-Service Worker בקומבינציית
// Playwright 1.48.2 + Chromium שקיימת כאן (אומת ישירות: handler שהותקן
// דרך context.route('https://www.gstatic.com/firebasejs/**', …) פשוט
// לא נקרא כשה-SW מבצע importScripts לאותה כתובת — 0 קריאות, למרות
// שהוא נקרא כרגיל עבור בקשות מהעמוד עצמו). מעבר לכך, gstatic חוסם
// גם ככה בקשות לא-דפדפניות (403 אומת בנפרד מול הכתובת עצמה), כך
// שגם אילו ה-routing עבד לא היה אפשר להגיע לרשת האמיתית. שינוי
// הכתובת הוא הדרך היחידה שנמצאה בזמן הזמין; שאר הקובץ — כל לוגיקת
// המטמון, activate, fetch ו-offline — נשאר בדיוק כפי שהוא בייצור.
// לוגיקת ה-messaging עצמה אינה הנושא של הבדיקה הזו.
import { chromium } from './lib/contained-playwright.cjs';
import { MANIFEST } from './version-release.mjs';
// 42H.20 · ביקורת Codex, חוסם 4 · מפתח המטמון נגזר מהמניפסט, לא מקובע.
const CURRENT_CACHE = MANIFEST.sw_cache_key;
const NEXT_CACHE = CURRENT_CACHE + '-next';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');

let swSourceOverride = null; // מאפשר לבדיקת refresh/update להגיש גרסה שנייה
const unavailablePaths = new Set();
const stalledPaths = new Set();

const GSTATIC_APP = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js';
const GSTATIC_MESSAGING = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js';
const GSTATIC_STUB_BODY = 'self.firebase = { initializeApp: function(){}, messaging: function(){ return { onBackgroundMessage: function(){} }; } };';

// מחליף רק את שתי כתובות ה-gstatic בכתובת מקומית — שאר הקובץ (מטמון,
// activate, fetch, offline) נשאר מילה במילה כמו בייצור. ראה הערת הראש.
function localizeGstatic(source) {
  const localized = source
    .replace(GSTATIC_APP, '/__stub_gstatic_app.js')
    .replace(GSTATIC_MESSAGING, '/__stub_gstatic_messaging.js');
  if (localized === source) {
    throw new Error('localizeGstatic: לא נמצאה אף אחת משתי כתובות ה-gstatic במקור — ייתכן שהקובץ השתנה');
  }
  return localized;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/__sw_test__.html');
  if (unavailablePaths.has(urlPath)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('synthetic required asset failure');
    return;
  }
  if (stalledPaths.has(urlPath)) {
    // Deliberately accept the connection without sending headers. The worker
    // must abort this request at its bounded network-first deadline.
    return;
  }
  if (urlPath === '/__stub_gstatic_app.js' || urlPath === '/__stub_gstatic_messaging.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(GSTATIC_STUB_BODY);
    return;
  }
  if (urlPath === '/firebase-messaging-sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(localizeGstatic(swSourceOverride || realSwSource));
    return;
  }
  if (urlPath === '/__sw_test__.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html lang="he"><meta charset="utf-8">' +
      '<body>בדיקת Service Worker' +
      '<script type="module">' +
      '  import { registerSW } from "./pwa.js?v=' + MANIFEST.asset_query + '";' +
      '  window.__swRegistration = null;' +
      '  window.__swRegisterError = null;' +
      '  registerSW().then(function (r) { window.__swRegistration = r; })' +
      '    .catch(function (e) { window.__swRegisterError = String(e); });' +
      '</script></body></html>'
    );
    return;
  }
  const file = path.join(root, urlPath === '/' ? 'login.html' : urlPath);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css' : ext === '.json' ? 'application/json' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = 'http://127.0.0.1:' + port;

const realSwSource = fs.readFileSync(path.join(root, 'firebase-messaging-sw.js'), 'utf8');
const coreSource = realSwSource.match(/const CORE_SHELL = \[([\s\S]*?)\];/);
if (!coreSource) throw new Error('CORE_SHELL declaration not found');
const REQUIRED_CORE = [...coreSource[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
if (!REQUIRED_CORE.length) throw new Error('CORE_SHELL must not be empty');

function loginBootClosure() {
  const found = new Set(['./login.html']);
  const queue = ['./login.html'];
  const add = value => {
    const clean = String(value || '').split(/[?#]/, 1)[0];
    if (!clean.startsWith('./') || found.has(clean)) return;
    found.add(clean);
    queue.push(clean);
  };
  while (queue.length) {
    const relative = queue.shift();
    const source = fs.readFileSync(path.join(root, relative.slice(2)), 'utf8');
    if (relative.endsWith('.html')) {
      for (const match of source.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["'](\.\/[^"']+)["'][^>]*>/gi)) add(match[1]);
    }
    if (relative.endsWith('.html') || relative.endsWith('.js')) {
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.\/[^"']+)["']/g)) add(match[1]);
    }
  }
  return [...found].sort();
}

async function prepareContext(context) {
  // רק בקשות רגילות של הדף (לא של ה-SW — ראה localizeGstatic למעלה
  // וההערה בראש הקובץ, ל-context.route אין השפעה על importScripts
  // שמקורו ב-Service Worker בקומבינציה הזו).
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
}

let bad = 0;
function check(cond, label, detail) {
  if (cond) { console.log('✓ ' + label); }
  else { bad++; console.log('✗ ' + label + (detail ? '\n    ' + detail : '')); }
}

const browser = await chromium.launch();

try {
  // ---------- 0a) required core is atomic; optional shell remains best-effort ----------
  const derivedLoginCore = [...new Set([...loginBootClosure(), './reserve-shift-policy.js'])].sort();
  check(JSON.stringify(REQUIRED_CORE.slice().sort()) === JSON.stringify(derivedLoginCore),
    'CORE_SHELL שווה לסגירת login ולמדיניות המילואים הנדרשת',
    'declared=' + JSON.stringify(REQUIRED_CORE.slice().sort()) + ' derived=' + JSON.stringify(derivedLoginCore));
  {
    swSourceOverride = null;
    unavailablePaths.add('/mode-bar.js');
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__swRegistration || window.__swRegisterError, null, { timeout: 15000 });
    await page.waitForFunction(() => {
      const r = window.__swRegistration;
      return !r || (!r.installing && !r.waiting && !r.active);
    }, null, { timeout: 15000 });
    const failedCore = await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      return {
        controlled:navigator.serviceWorker.controller !== null,
        keys:(await cache.keys()).map(key => new URL(key.url).pathname).sort()
      };
    }, CURRENT_CACHE);
    check(!failedCore.controlled, 'קובץ ליבה חסר מונע הפעלה ושליטה של Service Worker חדש');
    check(failedCore.keys.length === 0,
      'Cache.addAll אינו משאיר מטמון ליבה חלקי כשקובץ חובה חסר',
      'keys=' + JSON.stringify(failedCore.keys));
    await context.close();
    unavailablePaths.delete('/mode-bar.js');
  }

  {
    swSourceOverride = null;
    unavailablePaths.add('/vehicle.html');
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    const optionalFailure = await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      return (await cache.keys()).map(key => new URL(key.url).pathname).sort();
    }, CURRENT_CACHE);
    const requiredPaths = REQUIRED_CORE.map(value => '/' + value.replace(/^\.\//, '')).sort();
    check(requiredPaths.every(value => optionalFailure.includes(value)),
      'כשל בנכס אופציונלי אינו מבטל התקנה שכל קבצי הליבה שלה שלמים');
    check(!optionalFailure.includes('/vehicle.html'),
      'נכס אופציונלי שנכשל אינו מוצג כאילו נשמר במטמון');
    await context.close();
    unavailablePaths.delete('/vehicle.html');
  }

  // ---------- 0b) bounded network-first fallback and network-only exclusions ----------
  {
    swSourceOverride = realSwSource.replace(
      'const NETWORK_FIRST_TIMEOUT_MS = 5000;',
      'const NETWORK_FIRST_TIMEOUT_MS = 100;'
    );
    check(swSourceOverride !== realSwSource,
      'בדיקת timeout משתמשת באותו worker עם תקציב זמן קצר ומפורש');
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    await page.evaluate(async (cacheName) => {
      const cache = await caches.open(cacheName);
      await cache.put('/__stalled_asset__.js', new Response('cached-after-timeout', {
        status:200, headers:{ 'Content-Type':'text/javascript' }
      }));
      await cache.put('/firestore-probe.js', new Response('must-not-be-used', { status:200 }));
      await cache.put('/version.json', new Response('{"v":"stale"}', { status:200 }));
      await cache.put('/__/auth/handler', new Response('stale-auth-handler', { status:200 }));
    }, CURRENT_CACHE);

    stalledPaths.add('/__stalled_asset__.js');
    const stalledHit = await page.evaluate(async () => {
      const started = performance.now();
      const response = await Promise.race([
        fetch('/__stalled_asset__.js').then(async r => ({ status:r.status, body:await r.text() })),
        new Promise(resolve => setTimeout(() => resolve({ pageTimeout:true }), 2000))
      ]);
      return { ...response, elapsed:performance.now() - started };
    });
    stalledPaths.delete('/__stalled_asset__.js');
    check(stalledHit.body === 'cached-after-timeout' && stalledHit.status === 200 && stalledHit.elapsed < 2000,
      'בקשת מעטפת תקועה נקטעת וחוזרת למטמון בתוך התקציב', JSON.stringify(stalledHit));

    await page.evaluate(async () => {
      const unrelated = await caches.open('resq-test-unrelated-release');
      await unrelated.put('/__old_only__.js', new Response('foreign-release-must-not-return'));
    });
    stalledPaths.add('/__old_only__.js');
    const isolatedMiss = await page.evaluate(async () => {
      const response = await fetch('/__old_only__.js');
      return { status:response.status, body:await response.text() };
    });
    stalledPaths.delete('/__old_only__.js');
    check(isolatedMiss.status === 504 && isolatedMiss.body !== 'foreign-release-must-not-return',
      'cache miss never falls back to another release cache', JSON.stringify(isolatedMiss));

    stalledPaths.add('/__/auth/handler');
    const reservedRoute = await page.evaluate(async () => Promise.race([
      fetch('/__/auth/handler').then(async response => ({ status:response.status, body:await response.text() })),
      new Promise(resolve => setTimeout(() => resolve({ pageTimeout:true }), 300))
    ]));
    stalledPaths.delete('/__/auth/handler');
    check(reservedRoute.pageTimeout === true && reservedRoute.body !== 'stale-auth-handler',
      'נתיב Firebase שמור ותקוע נשאר מחוץ ל-respondWith ואינו מקבל fallback ישן',
      JSON.stringify(reservedRoute));

    const exclusions = await page.evaluate(async () => {
      const firestore = await fetch('/firestore-probe.js');
      const version = await fetch('/version.json');
      return { firestore:firestore.status, version:version.status, versionBody:await version.text() };
    });
    check(exclusions.firestore === 404,
      'נתיב Firestore מוחרג נשאר network-only ואינו משתמש בעותק מטמון', JSON.stringify(exclusions));
    check(exclusions.version === 200 && exclusions.versionBody !== '{"v":"stale"}',
      'version.json נשאר network-only ואינו משתמש בעותק מטמון', JSON.stringify(exclusions));

    stalledPaths.add('/__stalled_navigation__.html');
    let stalledMiss = false;
    try {
      await page.goto(base + '/__stalled_navigation__.html', { waitUntil: 'load', timeout: 3000 });
      stalledMiss = /אין חיבור לרשת/.test(await page.locator('body').textContent() || '');
    } catch (_) {
      stalledMiss = false;
    }
    stalledPaths.delete('/__stalled_navigation__.html');
    check(stalledMiss, 'ניווט תקוע ללא cache מקבל fallback מפורש במקום להמתין ללא גבול');
    await context.close();
    swSourceOverride = null;
  }

  // ---------- 1) cold load: התקנה ראשונה, מטמון נבנה, אתחול מוצלח ----------
  {
    swSourceOverride = null;
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__swRegistration || window.__swRegisterError, null, { timeout: 15000 });
    const regError = await page.evaluate(() => window.__swRegisterError);
    check(!regError, 'ה-Service Worker האמיתי נרשם בלי שגיאה בטעינה קרה', 'error=' + regError);

    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(() => {});
    const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    check(controlled, 'הדף נשלט ע"י ה-Service Worker אחרי טעינה קרה (activate + clients.claim הצליחו)');

    const cacheNames = await page.evaluate(() => caches.keys());
    check(cacheNames.includes(CURRENT_CACHE), 'המטמון הפעיל נוצר עם המפתח האמיתי מ-release-manifest.json',
      'cacheNames=' + JSON.stringify(cacheNames));

    const cachedShell = await page.evaluate(async (cacheName) => {
      const c = await caches.open(cacheName);
      const keys = await c.keys();
      return keys.map(key => new URL(key.url).pathname).sort();
    }, CURRENT_CACHE);
    const requiredPaths = REQUIRED_CORE.map(value => '/' + value.replace(/^\.\//, '')).sort();
    const cachedRequired = cachedShell.filter(value => requiredPaths.includes(value)).sort();
    check(JSON.stringify(cachedRequired) === JSON.stringify(requiredPaths),
      'כל קבצי CORE_SHELL, ורק רשימת הליבה המדויקת, קיימים במטמון הפעיל',
      'required=' + JSON.stringify(requiredPaths) + ' cachedRequired=' + JSON.stringify(cachedRequired));
    check(cachedShell.length > REQUIRED_CORE.length,
      'נכסי המעטפת האופציונליים נשמרו בנוסף לליבה האטומית', 'cachedShell=' + JSON.stringify(cachedShell));

    await context.close();
  }

  // ---------- 1b) failed update preserves the active worker and cache ----------
  {
    swSourceOverride = null;
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });

    const brokenCache = CURRENT_CACHE + '-broken';
    swSourceOverride = realSwSource.replace(
      "const CACHE = '" + CURRENT_CACHE + "';",
      "const CACHE = '" + brokenCache + "';"
    );
    unavailablePaths.add('/mode-bar.js');
    const failedState = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.update();
      const candidate = registration.installing;
      if (!candidate) return 'missing';
      if (candidate.state === 'redundant') return candidate.state;
      return new Promise(resolve => {
        const done = () => {
          if (candidate.state === 'redundant' || candidate.state === 'installed' || candidate.state === 'activated') {
            candidate.removeEventListener('statechange', done);
            resolve(candidate.state);
          }
        };
        candidate.addEventListener('statechange', done);
        done();
      });
    });
    unavailablePaths.delete('/mode-bar.js');
    const afterFailedUpdate = await page.evaluate(async (brokenCache) => {
      const names = await caches.keys();
      const broken = await caches.open(brokenCache);
      return {
        controlled:navigator.serviceWorker.controller !== null,
        names,
        brokenKeys:(await broken.keys()).map(key => new URL(key.url).pathname)
      };
    }, brokenCache);
    check(failedState === 'redundant',
      'עדכון שחסר בו קובץ ליבה נכשל במצב redundant', 'state=' + failedState);
    check(afterFailedUpdate.controlled && afterFailedUpdate.names.includes(CURRENT_CACHE),
      'כשל התקנת עדכון אינו מחליף את ה-worker הפעיל ואינו מוחק את המטמון התקין',
      JSON.stringify(afterFailedUpdate));
    check(afterFailedUpdate.brokenKeys.length === 0,
      'עדכון שנכשל אינו משאיר קבצי ליבה חלקיים במטמון המועמד',
      JSON.stringify(afterFailedUpdate.brokenKeys));
    await context.close();
    swSourceOverride = null;
  }

  // ---------- 2) old-cache activation: מטמון ישן נמחק, הנוכחי נשאר ----------
  {
    swSourceOverride = null;
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    // זורעים מטמון "ישן" *לפני* שהעמוד בכלל טוען — כדי לוודא ש-activate
    // באמת סורק ומנקה, לא רק "העמוד היחיד שהוא יצר בעצמו".
    await page.goto('about:blank');
    await page.evaluate(async (u) => {
      // נדרש הקשר של המקור (origin) האמיתי כדי ש-caches ישותפו עם ה-SW.
      await fetch(u).catch(() => {});
    }, base + '/__sw_test__.html');
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.evaluate(async () => {
      const c = await caches.open('resq-vSTALE-release0');
      await c.put('/stale', new Response('stale content'));
    });
    await page.waitForFunction(() => window.__swRegistration || window.__swRegisterError, null, { timeout: 15000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 }).catch(() => {});
    // activate מתבצע פעם אחת סביב ההתקנה; לוקחים עוד רגע ליתר ביטחון.
    await page.waitForTimeout(500);
    const namesAfter = await page.evaluate(() => caches.keys());
    check(!namesAfter.includes('resq-vSTALE-release0'), 'מטמון ישן (resq-*) שאינו המפתח הנוכחי נמחק ב-activate',
      'namesAfter=' + JSON.stringify(namesAfter));
    check(namesAfter.includes(CURRENT_CACHE), 'המטמון הנוכחי נשאר קיים אחרי הניקוי');
    await context.close();
  }

  // ---------- 3) refresh/update: גרסה חדשה, skipWaiting, controllerchange ----------
  {
    swSourceOverride = null;
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    const hadController = await page.evaluate(() => {
      window.__controllerBefore = navigator.serviceWorker.controller;
      window.__controllerChanges = 0;
      navigator.serviceWorker.addEventListener('controllerchange', () => { window.__controllerChanges += 1; });
      return window.__controllerBefore !== null;
    });
    check(hadController, 'לבדיקת העדכון נשמר אובייקט ה-controller הפעיל המקורי');

    // "שחרור חדש": אותו קובץ אמיתי, עם מפתח מטמון אחר — בדיוק מה
    // ש-release-stamp.mjs עצמו היה מייצר בקידום גרסה אמיתי.
    swSourceOverride = realSwSource.replace(
      "const CACHE = '" + CURRENT_CACHE + "';",
      "const CACHE = '" + NEXT_CACHE + "';"
    );
    check(swSourceOverride !== realSwSource, 'גרסת ה-SW השנייה לבדיקה שונה בפועל מהמקור (ה-replace תפס)');

    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      await r.update();
      return true;
    });
    check(reg === true, 'registration.update() בוצע בלי שגיאה');

    await page.waitForFunction(() => {
      const r = window.__swRegistration;
      return r && (r.waiting || r.installing);
    }, null, { timeout: 15000 });
    const hasWaiting = await page.evaluate(() => Boolean(window.__swRegistration && window.__swRegistration.waiting)
      || Boolean(window.__swRegistration && window.__swRegistration.installing));
    check(hasWaiting, 'גרסה חדשה נכנסת ל-installing/waiting ולא מחליפה מיד את הקיימת');

    // שולחים בדיוק את ההודעה ש-pwa.js שולח בפועל (RESQ_SKIP_WAITING).
    /* ⭐ כאן היה `setTimeout(300)` ואחריו `if (r.waiting)`.
     *
     * מה שנמצא: זו הייתה תחרות שקטה. `install` מביא את כל קבצי
     * המעטפת, וכשהמעטפת גדלה — מסך HR שקיבל דוח חודשי, מסך הפניות
     * שקיבל מוני תיבות — ההתקנה חצתה 300 מילישניות, העובד עדיין היה
     * ב-`installing`, `r.waiting` היה null, וההודעה **לא נשלחה
     * בכלל**. העובד החדש נשאר ממתין לנצח, ה-`activate` שלו לא רץ,
     * והמטמון הישן לא נוקה. הבדיקה נכשלה על תזמון והאשימה את המוצר.
     *
     * ההמתנה עצמה אינה התיקון — `check(posted)` הוא. בלעדיו הבדיקה
     * יכולה לדלג בשקט על הצעד היחיד שהיא קיימת בשבילו ולהיכשל
     * מאוחר יותר, על משהו אחר. */
    const posted = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      for (let i = 0; i < 150 && !r.waiting; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!r.waiting) return false;
      r.waiting.postMessage({ type: 'RESQ_SKIP_WAITING' });
      return true;
    });
    check(posted, 'הגרסה החדשה באמת הגיעה ל-waiting וקיבלה את RESQ_SKIP_WAITING',
      'העובד החדש לא הגיע ל-waiting בזמן, ולכן ההודעה לא נשלחה — הבדיקה שמתחתיה חסרת משמעות');
    await page.waitForFunction(() => navigator.serviceWorker.controller
      && navigator.serviceWorker.controller !== window.__controllerBefore, null, { timeout: 15000 });
    const controllerChanged = await page.evaluate(() => ({
      changed:navigator.serviceWorker.controller !== window.__controllerBefore,
      events:window.__controllerChanges
    }));
    check(controllerChanged.changed && controllerChanged.events >= 1,
      'controllerchange החליף בפועל את אובייקט ה-controller ולא רק שמר URL זהה',
      JSON.stringify(controllerChanged));
    // ה-activate של הגרסה החדשה (שמנקה את המטמון הישן) מתרחש אחרי
    // ה-controllerchange, לא באותו טיק — נמדד ישירות: עד כ-1.2 שניות
    // אחרי ה-controllerchange, בהרצה מקומית. ל-caches.delete() בפועל
    // אין אירוע להאזין לו, אז פוללים במקום לנחש מספר קבוע.
    let cachesAfterUpdate = await page.evaluate(() => caches.keys());
    for (let i = 0; i < 20 && cachesAfterUpdate.includes(CURRENT_CACHE); i++) {
      await page.waitForTimeout(200);
      cachesAfterUpdate = await page.evaluate(() => caches.keys());
    }
    check(cachesAfterUpdate.includes(NEXT_CACHE), 'הגרסה החדשה יצרה מטמון עם המפתח החדש',
      'cachesAfterUpdate=' + JSON.stringify(cachesAfterUpdate));
    check(!cachesAfterUpdate.includes(CURRENT_CACHE), 'הגרסה הישנה נוקתה אחרי שהחדשה השתלטה (activate)',
      'cachesAfterUpdate=' + JSON.stringify(cachesAfterUpdate));
    await context.close();
  }

  // ---------- 4) offline→online: המטמון משרת בהיעדר רשת, והרשת חוזרת לשרת אחרי ----------
  //
  // context.setOffline() אינו משמש כאן. נבדק ישירות: גם setOffline וגם
  // context.route() אינם משפיעים על הבקשה שה-Service Worker עצמו יוזם
  // בתוך ה-'fetch' handler שלו (fetch(req) בקובץ המקור) — אומת בנפרד
  // עם דף בדיקה מבודד: הבקשה המשיכה להגיע לשרת המקומי גם אחרי
  // setOffline(true), ו-route() עם abort('internetdisconnected') לא
  // נקרא כלל. זו אותה מגבלה שגרמה לכך ש-context.route על gstatic לא
  // עבד ל-importScripts (ראה הערת הראש) — בקשות שמקורן ב-Service
  // Worker עצמו, לא בדף, אינן עוברות דרך שכבת ה-network interception
  // של Playwright בקומבינציה הזו. לכן "אין רשת" מדומה כאן באמת: סוגרים
  // את שרת ה-HTTP המקומי (חיבור מסורב אמיתי, לא סימולציה), ופותחים
  // אותו מחדש לבדיקת "חזרה לרשת".
  {
    swSourceOverride = null;
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    await prepareContext(context);
    const page = await context.newPage();
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
    // מוודאים שהמעטפת האמיתית (login.html) כבר במטמון לפני שמנתקים רשת.
    await page.evaluate((asset) => fetch('./login.html?v=' + asset).catch(() => {}), MANIFEST.asset_query);
    await page.waitForTimeout(300);

    await new Promise((resolve) => server.close(resolve));

    const offlineResponse = await page.evaluate(async (asset) => {
      try {
        const r = await fetch('./login.html?v=' + asset);
        return { ok: true, status: r.status, bodyLen: (await r.text()).length };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, MANIFEST.asset_query);
    check(offlineResponse.ok && offlineResponse.status === 200 && offlineResponse.bodyLen > 500,
      'דף אמיתי מהמעטפת נטען בהצלחה כשהשרת נותק לגמרי (חיבור מסורב אמיתי), מתוך המטמון',
      'offlineResponse=' + JSON.stringify(offlineResponse));

    let navFailedGracefully = false;
    try {
      await page.goto(base + '/__page_never_cached__.html', { waitUntil: 'load', timeout: 5000 });
      const bodyText = await page.locator('body').textContent();
      navFailedGracefully = /אין חיבור לרשת/.test(bodyText || '');
    } catch (e) {
      navFailedGracefully = false;
    }
    check(navFailedGracefully, 'ניווט לדף שמעולם לא נשמר, כשהשרת נותק, מציג את מסך "אין חיבור לרשת" העברי — לא שגיאת דפדפן');

    // "חזרה לרשת": פותחים שרת חדש על אותו פורט בדיוק.
    await new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    await page.goto(base + '/__sw_test__.html', { waitUntil: 'load' });
    const backOnline = await page.evaluate(async (asset) => {
      const r = await fetch('./login.html?v=' + asset);
      return r.status;
    }, MANIFEST.asset_query);
    check(backOnline === 200, 'אחרי חזרת השרת, בקשות רגילות חוזרות לעבוד דרך הרשת (לא נשארות תקועות על שגיאה)');

    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log('');
console.log(bad
  ? bad + ' בדיקות service-worker נכשלו'
  : 'כל בדיקות ה-Service Worker האמיתי עברו: cold load, ניקוי מטמון ישן, refresh/update, offline→online');
process.exitCode = bad ? 1 : 0;
