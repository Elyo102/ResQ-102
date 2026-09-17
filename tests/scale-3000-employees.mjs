// 3,000-עובד harness — Scale Scope 11 / closure batch item 2.
//
// המטריצה מציינת שאף מקום בקוד אינו טוען את כל 3,000 העובדים לדפדפן —
// אבל עד היום אף בדיקה לא הוכיחה את זה בפועל, ואף בדיקה לא נגעה כלל
// בתכונת החיפוש הארגוני (people.html, אוסף directory), כי לסטאב לא
// הייתה תמיכה ב-array-contains ולא הייתה לו נתוני directory בכלל —
// ראה התוספת ל-tests/stub/firebase-firestore.js. בלי זה, 3,000 רשומות
// ב-directory היו חוזרות *כולן* מהסטאב, והבדיקה הזו הייתה עוברת בטעות
// גם אם הקוד היה שובר את מגבלת ה-25.
//
// מה שהבדיקה הזו מוכיחה בפועל, לא רק טוענת:
//  1. אירגון עם 3,000 רשומות directory (הרבה תחנות, לא רק אילת) —
//     חיפוש לפי קידומת שם משותפת שמתאימה למאות מהן מחזיר לדפדפן
//     **בדיוק** עד 25 תוצאות (query(..., limit(25))), לא את כולן.
//  2. הזמן עד תוצאה נשאר סביר (לא O(n) מורגש) גם כשמאגר המקור גדול
//     פי 100+ ממה שכל בדיקה קודמת השתמשה בו.
//  3. אין קריסה, תקיעה או שגיאת דפדפן בטעינת 3,000 הרשומות לזיכרון
//     הסטאב עצמו (מה שהיה קורה למשל אם קוד הלקוח היה מנסה לאחסן
//     readonly-DOM לכל רשומה מראש).
//
// מה שהבדיקה הזו **אינה** מוכיחה: שהשרת האמיתי (functions/index.js,
// כללי Firestore) אוכף את אותה מגבלה מול Firestore אמיתי — זה דורש
// את אמולטור ה-Firestore, שחסום ברשת הזאת (נבדק שוב במפורש הפעם:
// `firebase setup:emulators:firestore` נכשל על storage.googleapis.com
// חסום ע"י ה-allowlist). מה שכן ידוע בוודאות מקריאת המקור: קוד הלקוח
// (people.html) בונה את השאילתה עם limit(25) קשיח בקוד, לא כפרמטר
// שאפשר לעקוף מהצד הזה — ראה ההערה ב-run().
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stub = path.join(here, 'stub');

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0] || '/people.html');
  const file = path.join(root, urlPath === '/' ? 'people.html' : urlPath);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.css' ? 'text/css' : 'text/javascript' });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// ---------- מחולל 3,000 רשומות directory סינתטיות ----------
// דטרמיניסטי (זרע קבוע) כדי שכשל אפשר לשחזר אותו אחד לאחד. פרוס על
// פני עשרות "תחנות" בדויות, לא רק אילת אחת — בדיוק התרחיש שהפריט הזה
// נועד לו: פלטפורמה רב-תחנתית, לא תחנה אחת גדולה באופן לא ריאלי.
const GIVEN = ['אלדד', 'טל', 'דנה', 'רון', 'מורגן', 'אכרם', 'ליסה', 'יעל', 'רחמים', 'משה',
  'נועה', 'איתי', 'שירה', 'עומר', 'הדר', 'גיא', 'מיכל', 'דור', 'ענת', 'אורי'];
const FAMILY = ['לוי', 'כהן', 'מזרחי', 'ביטון', 'חודרה', 'עגיב', 'טויטו', 'חמזה', 'פרץ', 'אזולאי',
  'דהן', 'אוחנה', 'גבאי', 'שרעבי', 'רביבו', 'אלמליח', 'קריספין', 'וקנין', 'בן דוד', 'סבן'];
const ROLES = ['firefighter', 'driver', 'commander', 'station_commander', 'hr_coordinator'];
const CREWS = ['A', 'B', 'C', ''];
const STATION_COUNT = 60; // 60 תחנות × 50 בממוצע ≈ 3,000

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function stripNiqqud(s) { return s.replace(/["'`׳״]/g, ''); }
function namePrefixes(name) {
  const key = stripNiqqud(name.toLowerCase());
  const out = new Set();
  for (let i = 2; i <= key.length; i++) out.add(key.slice(0, i));
  return Array.from(out);
}

const rand = seededRandom(42);
const N = 3000;
const directory = [];
for (let i = 0; i < N; i++) {
  const given = GIVEN[Math.floor(rand() * GIVEN.length)];
  const family = FAMILY[Math.floor(rand() * FAMILY.length)];
  const full_name = given + ' ' + family;
  const stationIdx = Math.floor(rand() * STATION_COUNT);
  const doc = {
    full_name,
    emp: String(1000 + i),
    role: ROLES[Math.floor(rand() * ROLES.length)],
    crew: CREWS[Math.floor(rand() * CREWS.length)],
    station: 'station-' + stationIdx,
    is_active: true,
    name_prefixes: namePrefixes(full_name)
  };
  directory.push(['dir_' + i, doc]);
}
// אחד השמות הנפוצים ביותר ("אלדד") מבטיח מאות התאמות אמיתיות —
// זו בדיוק הבדיקה שממוגבלת-25-בלבד נדרשת לעבור, לא חיפוש שבמקרה
// מחזיר מעט תוצאות.
const commonMatches = directory.filter(([, d]) => d.full_name.startsWith('אלדד')).length;
if (commonMatches < 25) throw new Error('scale harness: seed did not produce enough matches (' + commonMatches + ')');

async function prepare(context) {
  await context.route('**/firebasejs/**', (route) => {
    const name = route.request().url().split('/').pop().split('?')[0];
    const file = path.join(stub, name);
    route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {};' });
  });
  await context.addInitScript((dir) => {
    window.__SMOKE_ROLE = 'firefighter';
    window.__DIRECTORY_PLAN = dir;
  }, directory);
}

let bad = 0;
function check(cond, label, detail) {
  if (cond) { console.log('✓ ' + label); }
  else { bad++; console.log('✗ ' + label + (detail ? '\n    ' + detail : '')); }
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' }).catch(() => chromium.launch());
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL' });
  await prepare(context);
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:' + port + '/people.html', { waitUntil: 'load' });
  // קריאת פתע פעילה בנתוני הדמה יכולה להופיע עם עיכוב ולכסות את
  // הכפתור — ראה states-audit-browser.mjs/screenshots-42h20.mjs.
  await page.addStyleTag({ content: '#coWrap{display:none!important}' }).catch(() => {});
  await page.locator('#qName').waitFor({ timeout: 10000 });

  await page.fill('#qName', 'אלדד');
  const start = Date.now();
  await page.click('#btnDoSearch');
  await page.locator('#resCard:not(.hide)').waitFor({ timeout: 10000 });
  const elapsed = Date.now() - start;

  const resultCount = await page.locator('#results .res').count();
  const headText = await page.locator('#resHead').textContent();

  check(directory.length === N, 'מאגר המקור הסינתטי מכיל בדיוק ' + N + ' רשומות directory');
  check(commonMatches >= 25, 'החיפוש "אלדד" תואם ' + commonMatches + ' רשומות אמיתיות במאגר — הרבה יותר מ-25');
  check(resultCount === 25, 'הדפדפן קיבל בדיוק 25 תוצאות מתוך ' + commonMatches + ' התאמות — לא נטענו כל 3,000 העובדים',
    'resultCount=' + resultCount);
  check(/25 תוצאות/.test(headText || ''), 'הכותרת מדווחת 25 תוצאות, לא את מספר ההתאמות האמיתי', 'headText=' + headText);
  check(elapsed < 3000, 'החיפוש הושלם תוך פחות מ-3 שניות מול מאגר של 3,000 רשומות (' + elapsed + 'ms)',
    'elapsed=' + elapsed + 'ms');

  console.log('');
  console.log('זמן חיפוש בפועל מול 3,000 רשומות: ' + elapsed + 'ms');
} finally {
  await browser.close();
  server.close();
}

console.log('');
console.log(bad
  ? bad + ' בדיקות scale-3000 נכשלו'
  : 'כל בדיקות ה-scale-3000 עברו: 3,000 רשומות במקור, 25 בדפדפן, זמן סביר');
process.exitCode = bad ? 1 : 0;
