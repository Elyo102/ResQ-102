/* ====================================================================
 *  headercheck · כותרות המטמון של Hosting — לפי הכלל שמנצח בפועל
 *
 *  ----------------------------------------------------------------
 *  למה בדיקת טקסט כאן חסרת ערך
 *  ----------------------------------------------------------------
 *
 *  ב-`firebase.json` ישב כלל שנתן ל-`firebase-messaging-sw.js` את
 *  `no-store`. הוא היה שם, כתוב, נכון — **והוא לא עשה כלום.**
 *
 *  Firebase Hosting מחיל את הכלל התואם **האחרון**. הכלל הכללי
 *  `**​/*.@(html|js|css)` תופס גם קובץ `.js` של Service Worker, והוא
 *  ישב **אחרי** הכלל הספציפי. התוצאה: Production החזיר `no-cache`.
 *
 *  ⭐ בדיקה שמחפשת „האם המחרוזת no-store מופיעה ליד firebase-messaging-sw"
 *  הייתה **עוברת בירוק** כל הזמן שהבאג היה חי. לכן הבדיקה הזאת אינה
 *  מחפשת טקסט: היא **מממשת את סמנטיקת ההתאמה**, מריצה נתיבים אמיתיים
 *  דרך רשימת הכללים, ושואלת מה יוצא בסוף.
 *
 *  ----------------------------------------------------------------
 *  ומי בודק את הבודק
 *  ----------------------------------------------------------------
 *
 *  סעיף 4 מריץ את אותו מנוע על **הסדר השבור המקורי** ודורש שיחזיר
 *  `no-cache` לעובד. אם המנוע שלי לא באמת מבחין בין שני הסדרים —
 *  הבדיקה נופלת שם, ולא מעמידה פנים שהיא שומרת על משהו.
 *
 *  ⚠ מה שהבדיקה הזאת **אינה**: היא אינה מודדת את Production. היא
 *  מודדת את הקובץ. המדידה האמיתית היא `curl -I` מול הכתובת החיה,
 *  והיא שייכת לשער שאחרי הפריסה.
 *
 *  יציאה: 0 עבר · 1 נכשל.
 * ==================================================================== */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}

/* ==================================================================
 * 1 · מנוע ההתאמה
 *
 * ⭐ הכלל החשוב כאן הוא מה קורה כשאני **לא מבין** תבנית. תבנית
 * שהמנוע לא יודע לתרגם חייבת להפיל את הבדיקה, לא להיחשב „לא
 * מתאימה" — אחרת מישהו יוסיף `!(...)` והשער ייפתח בשקט.
 * ================================================================== */

function globToRegExp(pattern) {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    // ‎@(a|b|c) — בדיוק אחד מהם.
    if (ch === '@' && pattern[i + 1] === '(') {
      const close = pattern.indexOf(')', i + 2);
      if (close === -1) throw new Error('סוגר חסר ב-@( בתבנית: ' + pattern);
      const alts = pattern.slice(i + 2, close).split('|');
      out += '(?:' + alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = close + 1;
      continue;
    }

    // extglob שאיני מממש. לא לנחש.
    if ('!*+?'.includes(ch) && pattern[i + 1] === '(') {
      throw new Error('תבנית extglob שאינה נתמכת (' + ch + '(): ' + pattern);
    }

    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 3; }
      else { out += '.*'; i += 2; }
      continue;
    }
    if (ch === '*') { out += '[^/]*'; i += 1; continue; }
    if (ch === '?') { out += '[^/]'; i += 1; continue; }

    if ('[]{}'.includes(ch)) {
      throw new Error('תבנית עם ' + ch + ' שאינה נתמכת: ' + pattern);
    }

    out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp('^' + out + '$');
}

/* כל הכללים התואמים מוחלים לפי הסדר; עבור אותו מפתח, הערך המאוחר
 * דורס את המוקדם. זו הסמנטיקה של Hosting וזה מה שנמדד ב-Production. */
function resolveHeader(rules, path, key) {
  let value = null;
  let winner = null;
  for (const rule of rules) {
    if (!rule || typeof rule.source !== 'string') {
      throw new Error('כלל כותרת ללא source נתמך; regex/glob דורשים תמיכה מפורשת');
    }
    if (!globToRegExp(rule.source).test(path)) continue;
    for (const h of rule.headers || []) {
      if (h.key.toLowerCase() === key.toLowerCase()) { value = h.value; winner = rule.source; }
    }
  }
  return { value, winner };
}

function hasDirective(value, directive) {
  if (typeof value !== 'string') return false;
  const wanted = String(directive).trim().toLowerCase();
  return value.split(',').map((part) => part.trim().toLowerCase()).includes(wanted);
}

/* ==================================================================
 * 2 · שפיות המנוע לפני שסומכים עליו
 * ================================================================== */

const M = (p, s) => globToRegExp(p).test(s);
const GENERAL = '**/*.@(html|js|css)';

ok('2.1 הכלל הכללי תופס html בשורש', M(GENERAL, '/index.html'));
ok('2.2 והוא תופס גם js בתת-תיקייה', M(GENERAL, '/a/b/theme.js'));
ok('2.3 ⭐ והוא תופס גם את ה-Service Worker', M(GENERAL, '/firebase-messaging-sw.js'),
  'אם הוא לא תופס אותו — כל הבדיקה הזאת מיותרת ולא נכונה');
ok('2.4 והוא אינו תופס json', !M(GENERAL, '/version.json'),
  'לו תפס, התוצאה של version.json הייתה מקרית');
ok('2.5 וגם לא png', !M(GENERAL, '/icon.png'));
ok('2.6 כלל ליטרלי אינו תופס נתיב אחר',
  M('/version.json', '/version.json') && !M('/version.json', '/a/version.json'));

let threw = false;
try { globToRegExp('!(x).js'); } catch { threw = true; }
ok('2.7 ⭐ תבנית שאיני מבין מפילה ולא נחשבת „לא מתאימה"', threw);

let unsupportedHeaderRuleThrew = false;
try {
  resolveHeader([{ regex: '.*', headers: [{ key: 'Cache-Control', value: 'no-cache' }] }],
    '/firebase-messaging-sw.js', 'Cache-Control');
} catch { unsupportedHeaderRuleThrew = true; }
ok('2.8 ⭐ כלל כותרת ללא source נתמך מפיל במקום להיעלם', unsupportedHeaderRuleThrew);

ok('2.9 הוראות Cache-Control נבדקות כאסימונים שלמים',
  hasDirective('no-cache, no-store, must-revalidate', 'no-store') &&
  !hasDirective('no-cache, x-no-store, must-revalidate', 'no-store'));

/* ==================================================================
 * 3 · המצב בפועל בקובץ
 * ================================================================== */

const cfg = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'));
const rules = cfg.hosting && cfg.hosting.headers;
ok('3.0 יש רשימת כותרות', Array.isArray(rules) && rules.length >= 3);

const CC = 'Cache-Control';
const eff = (p) => resolveHeader(rules || [], p, CC);

const worker = eff('/firebase-messaging-sw.js');
ok('3.1 ⭐ ה-Service Worker מקבל no-store בפועל',
  hasDirective(worker.value, 'no-store'),
  'הכלל שמנצח הוא „' + worker.winner + '" ונותן „' + worker.value + '"');
ok('3.2 ומקבל גם must-revalidate',
  hasDirective(worker.value, 'must-revalidate'));

const ver = eff('/version.json');
ok('3.3 version.json מקבל no-store בפועל',
  hasDirective(ver.value, 'no-store'),
  'הכלל שמנצח הוא „' + ver.winner + '"');

/* והכלל הכללי לא נהרס תוך כדי: JS רגיל שומר על המדיניות שלו. */
for (const p of ['/index.html', '/schedule-management.html', '/schedule-management.js',
                 '/theme.css', '/roles.js']) {
  const r = eff(p);
  ok('3.4 ' + p + ' נשאר no-cache', r.value === 'no-cache',
    'קיבל „' + r.value + '" מהכלל „' + r.winner + '"');
  ok('3.5 ' + p + ' אינו מקבל no-store',
    !!r.value && !hasDirective(r.value, 'no-store'),
    'קובץ רגיל שאינו נשמר במטמון כלל הוא נטל רשת מיותר');
}

/* ==================================================================
 * 4 · ⭐ ומי בודק את הבודק
 *
 * אותו מנוע, על הסדר השבור. אם הוא לא מבחין — הוא לא שומר על כלום.
 * ================================================================== */

const specific = (rules || []).filter((r) => typeof r.source === 'string' && r.source !== GENERAL);
const general = (rules || []).filter((r) => r.source === GENERAL);
ok('4.0 הכלל הכללי קיים פעם אחת', general.length === 1);

const brokenOrder = [...specific, ...general];          // הסדר שהיה
const brokenWorker = resolveHeader(brokenOrder, '/firebase-messaging-sw.js', CC);
ok('4.1 ⭐ בסדר השבור העובד מקבל no-cache — כלומר הבדיקה מבחינה',
  brokenWorker.value === 'no-cache',
  'המנוע החזיר „' + brokenWorker.value + '" גם על הסדר השבור; הוא אינו מבחין בין השניים');

/* ובסדר הנוכחי הכלל הכללי חייב לשבת לפני שני הספציפיים. */
const idxGeneral = (rules || []).findIndex((r) => r.source === GENERAL);
for (const src of ['/version.json', '/firebase-messaging-sw.js']) {
  const at = (rules || []).findIndex((r) => r.source === src);
  ok('4.2 „' + src + '" יושב אחרי הכלל הכללי', at > idxGeneral,
    'מיקום ' + at + ' מול ' + idxGeneral);
}

/* ==================================================================
 * סיכום
 * ================================================================== */

if (fails.length) {
  console.error('headercheck · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('headercheck · ' + pass + '/' + pass + ' עברו');
console.log('  לא נבדק כאן: הכותרות שמוחזרות בפועל מ-Production.');
console.log('  זו מדידה של הקובץ בלבד; המדידה החיה שייכת לשער שאחרי הפריסה.');
