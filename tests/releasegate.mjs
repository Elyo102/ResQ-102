/* ====================================================================
 *  releasegate · השער שהחזיר הצלחה על כישלון
 *
 *  ----------------------------------------------------------------
 *  1 · `test-rules.bat` יצא 0 גם כשנכשל
 *  ----------------------------------------------------------------
 *
 *  שתי סיבות, ושתיהן שקטות:
 *
 *    א. `RESULT` לא אותחל. יציאה מוקדמת — אין Java, `npm` נכשל —
 *       קפצה ל-`:done` בלי לגעת בו.
 *    ב. הסקריפט הסתיים ב-`pause`. קוד היציאה של קובץ אצווה הוא
 *       הקוד של הפקודה האחרונה, ו-`pause` מחזיר 0. כלומר **גם כשל
 *       אמיתי של כללי האבטחה יצא 0.**
 *
 *  ⭐ המשמעות: שער CI שקורא לקובץ הזה היה מדווח „הכללים עברו" על
 *  ריצה שלא הצליחה אפילו להתחיל.
 *
 *  ----------------------------------------------------------------
 *  2 · `ignore` נקב בשמות, לא בצורה
 *  ----------------------------------------------------------------
 *
 *  הרשימה חסמה `firestore.rules` ו-`firestore_1.rules` **בשמם**.
 *  קובץ כללים שלישי שמישהו יוסיף מחר היה עולה לכתובת ציבורית, ואף
 *  בדיקה לא הייתה אומרת מילה. חוקי אבטחה גלויים אינם דלף סודות —
 *  הם מפה של כל מה שנבדק ושל כל מה שלא.
 *
 *  ----------------------------------------------------------------
 *  ⚠ מה הבדיקה הזאת איננה
 *  ----------------------------------------------------------------
 *
 *  היא **אינה מריצה** את `test-rules.bat`. אין cmd.exe בסביבה שבה
 *  אני רץ, ולא אציג ניתוח סטטי כהרצה. היא בודקת את המבנה שממנו
 *  נגזר קוד היציאה, לא את קוד היציאה עצמו.
 *
 *  יציאה: 0 עבר · 1 נכשל.
 * ==================================================================== */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { matchesAny } from './lib/hosting-glob.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? ' — ' + detail : ''));
}

/* ==================================================================
 * 1 · מנתח קוד היציאה של קובץ האצווה
 *
 * מוחזר כאובייקט כדי שסעיף 4 יוכל להריץ את אותו מנתח על גרסאות
 * שבורות ולדרוש שייפול.
 * ================================================================== */

function analyseBatch(src) {
  const lines = src.split('\n');
  const code = lines.map((l) => {
    const t = l.trim();
    // הערות אצווה: rem, ‎::‎ — ושורות ריקות.
    if (!t || /^rem\b/i.test(t) || t.startsWith('::')) return '';
    return t;
  });

  const idxInit = code.findIndex((l) => /^set\s+RESULT\s*=\s*[^0\s]/i.test(l));
  const gotoDone = [];
  code.forEach((l, i) => { if (/^goto\s+done\b/i.test(l)) gotoDone.push(i); });

  const idxEmu = code.findIndex((l) => /firebase\s+emulators:exec/i.test(l));
  const idxCapture = code.findIndex((l) => /^set\s+RESULT\s*=\s*%errorlevel%/i.test(l));
  const idxLastPause = code.reduce((a, l, i) => (/^pause\b/i.test(l) ? i : a), -1);
  const idxExit = code.findIndex((l) => /^exit\s+\/b\s+%RESULT%/i.test(l));

  const lastCommand = (() => {
    for (let i = code.length - 1; i >= 0; i -= 1) if (code[i]) return code[i];
    return '';
  })();

  return { code, idxInit, gotoDone, idxEmu, idxCapture, idxLastPause, idxExit, lastCommand };
}

/* מדוע כל טענה. אף אחת מהן אינה סגנון. */
function assertBatchIsHonest(a, tag) {
  const out = [];
  const add = (name, cond, detail) => out.push({ name: tag + ' ' + name, cond, detail });

  add('RESULT מאותחל לערך כשל', a.idxInit !== -1,
    'בלי אתחול, יציאה מוקדמת משאירה RESULT ריק ו-%RESULT% מתפרש כמחרוזת ריקה');
  add('והאתחול קודם לכל goto done',
    a.idxInit !== -1 && a.gotoDone.every((g) => g > a.idxInit),
    'יש goto done לפני האתחול — בדיוק המסלול של „אין Java"');
  add('יש לפחות יציאה מוקדמת אחת שנשענת עליו', a.gotoDone.length > 0);
  add('errorlevel של האמולטור נלכד',
    a.idxEmu !== -1 && a.idxCapture > a.idxEmu && a.idxCapture - a.idxEmu <= 2,
    'set RESULT=%errorlevel% חייב לבוא מיד אחרי הפקודה; פקודה מפרידה דורסת אותו');
  add('הסקריפט מסתיים ב-exit /b %RESULT%',
    /^exit\s+\/b\s+%RESULT%/i.test(a.lastCommand),
    'הפקודה האחרונה היא „' + a.lastCommand + '"');
  add('⭐ והיציאה באה אחרי pause',
    a.idxExit !== -1 && a.idxLastPause !== -1 && a.idxExit > a.idxLastPause,
    'pause מחזיר 0; אם הוא אחרון, הוא קוד היציאה של כל הסקריפט');
  return out;
}

const bat = read('test-rules.bat');
const batAnalysis = analyseBatch(bat);
for (const t of assertBatchIsHonest(batAnalysis, '1.1')) ok(t.name, t.cond, t.detail);

/* ⭐ כל הטענות מכאן ואילך נבדקות מול **הקוד**, לא מול הקובץ.
 *
 * למדתי את זה בדרך הקשה בכיוון ההפוך: בדיקת שערים שנפלה על הערה
 * שהכילה `requireManager` — כלומר פונקציה בלי שער עם הערה כזאת
 * הייתה עוברת. כאן זה הכיוון הפחות מסוכן אבל אותו עיקרון: הערה
 * שמסבירה למה `/dev/null` היה באג אינה `/dev/null` בקוד. */
const batCode = batAnalysis.code.join('\n');

/* ==================================================================
 * 2 · האמולטור מדבר עם demo-resq בלבד
 * ================================================================== */

const emuLines = batAnalysis.code.filter((l) => /emulators:exec/i.test(l));
ok('2.0 יש פקודת אמולטור', emuLines.length === 1, emuLines.length + ' שורות');
for (const l of emuLines) {
  ok('2.1 --project demo-resq מפורש', /--project\s+demo-resq\b/.test(l));
  ok('2.2 ⭐ station-102 אינו מופיע בשורת אמולטור', l.indexOf('station-102') === -1,
    'מזהה ייצור בפקודת אמולטור הוא הרגל שנגמר רע');
}

/* הפניה בצורת Unix בקובץ cmd. `>/dev/null` מתפרש כנתיב \dev\null,
 * וכשהתיקייה אינה קיימת ההפניה עצמה נכשלת ומרימה errorlevel — כלומר
 * הבדיקה שלפניה עלולה לדווח כשל על מחשב תקין. */
ok('2.3 אין הפניה בצורת Unix בקוד', batCode.indexOf('/dev/null') === -1);

/* npm ci ולא npm install: פריסה שמתקינה גרסה אחרת ממה שנבדק
 * אינה פריסה של מה שנבדק. */
ok('2.4 התלויות מותקנות עם npm ci',
  /npm\s+ci\b/.test(batCode) && !/npm\s+install\b/.test(batCode));

/* והקובץ אינו מבטיח מה שאינו נכון: ההורדה הראשונה כן יוצאת לרשת. */
ok('2.5 אין הבטחה ש„שום דבר לא יוצא לרשת"',
  !/nothing goes online/i.test(batCode),
  'ההורדה הראשונה של האמולטור היא 137 MB מגוגל');

/* ==================================================================
 * 3 · hosting · שום קובץ כללים אינו עולה לאוויר
 * ================================================================== */

const cfg = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8'));
const ignore = (cfg.hosting && cfg.hosting.ignore) || [];
ok('3.0 יש רשימת ignore', ignore.length > 5);

/* נתיבים יחסיים לשורש, בלי לוכסן מוביל — כך Firebase סורק. */
for (const p of ['firestore.rules', 'firestore_1.rules', 'storage.rules',
                 'firestore_2.rules', 'a/b/custom.rules']) {
  ok('3.1 „' + p + '" נחסם', matchesAny(ignore, p) !== null,
    'לא נתפס באף תבנית — קובץ הכללים היה עולה לכתובת ציבורית');
}

/* ⭐ ובכיוון ההפוך: תבנית רחבה מדי שמפילה את האתר עצמו. */
for (const p of ['index.html', 'schedule-management.html', 'schedule-management.js',
                 'theme.css', 'version.json', 'firebase-messaging-sw.js']) {
  ok('3.2 „' + p + '" אינו נחסם', matchesAny(ignore, p) === null,
    'נתפס על ידי „' + matchesAny(ignore, p) + '" — האתר לא יעלה');
}

/* ==================================================================
 * 4 · ⭐ ומי בודק את הבודק
 *
 * ארבע גרסאות שבורות של אותו קובץ, דרך אותו מנתח. אם הוא לא מפיל
 * אותן — הוא אינו שער.
 * ================================================================== */

const broken = [
  ['בלי exit /b בסוף', bat.replace(/\nexit \/b %RESULT%\s*$/, '\n')],
  ['בלי אתחול RESULT', bat.replace(/^set RESULT=1\s*$/m, '')],
  ['exit לפני pause',
   bat.replace(/\nexit \/b %RESULT%\s*$/, '\n').replace(/^pause$/m, 'exit /b %RESULT%\npause')],
  ['ה-errorlevel נלכד מאוחר מדי',
   bat.replace('set RESULT=%errorlevel%', 'echo done\necho also\nset RESULT=%errorlevel%')],
];

for (const [label, src] of broken) {
  const results = assertBatchIsHonest(analyseBatch(src), '');
  const failed = results.filter((r) => !r.cond).length;
  ok('4.1 המנתח מפיל את הגרסה „' + label + '"', failed > 0,
    'כל הטענות עברו על קובץ שבור — המנתח אינו מבחין');
}

/* ואותו דבר לרשימת ה-ignore. */
const withoutWildcards = ignore.filter((p) => !/\*.*\.rules$/.test(p));
ok('4.2 בלי תבניות ה-wildcard, קובץ כללים חדש מתגלה',
  matchesAny(withoutWildcards, 'storage.rules') === null,
  'גם בלי התבניות הוא נחסם — כלומר סעיף 3.1 עובר מסיבה אחרת ואינו מוכיח דבר');

/* ==================================================================
 * 5 · predeploy · השער המלא, לא חלקו
 * ================================================================== */

const fns = (cfg.functions || [])[0] || {};
const predeploy = (fns.predeploy || []).join(' ; ');
ok('5.1 יש predeploy', predeploy.length > 0);
ok('5.2 ⭐ הוא מריץ את השער המלא ולא רק static',
  /npm\s+--prefix\s+tests\s+run\s+all\b/.test(predeploy),
  'predeploy הוא „' + predeploy + '"; פריסה שעוקפת את שער הדפדפן לא נבדקה');

/* ==================================================================
 * 6 · הוראות הפריסה · שלושת השלבים, ופרויקט מפורש בכל אחד
 * ================================================================== */

const doc = read('README-פריסה.md');

/* כל שורת פריסה במסמך — ולא רק הראשונה — חייבת לנקוב בפרויקט. */
const deployLines = doc.split('\n')
  .map((l) => l.trim())
  .filter((l) => /^firebase\s+deploy\b/.test(l));
ok('6.0 יש הוראות פריסה במסמך', deployLines.length >= 3,
  'נמצאו ' + deployLines.length + ' שורות');
for (const l of deployLines) {
  ok('6.1 „' + l.slice(0, 46) + '…" נוקב בפרויקט',
    /--project\s+station-102\b/.test(l),
    'פריסה בלי --project נשענת על ברירת המחדל של המחשב');
}

/* ארבעת היעדים. אינדקסים היו חסרים בגרסה הקודמת של המסמך — אינדקס
 * חסר אינו שגיאת פריסה אלא שאילתה שנופלת למשתמש בשדה. */
for (const target of ['firestore:rules', 'firestore:indexes', 'functions', 'hosting']) {
  ok('6.2 „' + target + '" נפרס',
    deployLines.some((l) => l.indexOf(target) !== -1));
}

/* וכל שורת אמולטור במסמך — demo-resq בלבד. */
for (const l of doc.split('\n').filter((l) => /emulators:exec/.test(l))) {
  ok('6.3 שורת אמולטור במסמך אינה נוגעת בייצור',
    /--project\s+demo-resq\b/.test(l) && l.indexOf('station-102') === -1);
}

ok('6.4 מתועדת חזרה לאחור', /rollback/i.test(doc) || doc.indexOf('חזרה לאחור') !== -1);
ok('6.5 מתועד אישור אנושי חד-פעמי לייצור',
  doc.indexOf('אישור') !== -1 && doc.indexOf('commit') !== -1);
ok('6.6 מתועדים JDK 21 ו-npm ci',
  /JDK\s*21/i.test(doc) && /npm\s+ci\b/.test(doc));
ok('6.7 ⭐ המסמך אינו טוען ש„שום דבר לא יוצא לרשת"',
  doc.indexOf('שום דבר לא יוצא') === -1 && doc.indexOf('לא יוצא לרשת') === -1);

/* ==================================================================
 * סיכום
 * ================================================================== */

if (fails.length) {
  console.error('releasegate · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('releasegate · ' + pass + '/' + pass + ' עברו');
console.log('  לא נבדק כאן: הרצה בפועל של test-rules.bat. אין cmd.exe בסביבה');
console.log('  שבה אני רץ, וניתוח סטטי אינו הרצה. קוד היציאה האמיתי נמדד');
console.log('  רק על Windows — היכן שהקובץ חי.');
