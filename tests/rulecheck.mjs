// בדיקת כללי אבטחה — סטטית, בלי אמולטור.
//
// הורדת האמולטור של Firestore חסומה בסביבה הזו, ולכן אי אפשר
// להדר את הכללים כאן. מה שכן אפשר, ומה שמהדר ממילא לא היה
// עושה: **להשוות את הכללים לקוד שכותב בפועל.**
//
// זו מחלקת הבאגים שבאמת נושכת ביום הפריסה. כלל שדורש שדה
// בשם by_uid בזמן שהמסך כותב uid עובר הידור מושלם, ואז חוסם
// כל כתיבה עד שמישהו מגלה למה.
//
// חמש בדיקות:
//
//   1. מבנה        סוגריים מאוזנים, כל match עם allow
//   2. אילוץ       claims בלבד, למעט אימות אב יחיד לתגובה
//   3. פונקציות    כל מה שנקרא מוגדר, כל מה שמוגדר בשימוש
//   4. אוספים      לכל אוסף שהקוד כותב אליו יש כלל
//   5. שדות        שדה שכלל דורש — הקוד באמת כותב אותו
//
// הרצה:  node rulecheck.mjs

import fs from 'fs';
import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');



const ROOT = __APP;
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

let bad = 0, warn = 0;
function fail(what, detail) {
  bad++; console.log('✗ ' + what + (detail ? '\n    ' + detail : ''));
}
function caution(what, detail) {
  warn++; console.log('⚠ ' + what + (detail ? '\n    ' + detail : ''));
}
function ok(what) { console.log('✓ ' + what); }
function head(t) { console.log('\n--- ' + t); }

// מסירים הערות לפני כל ניתוח. שם פונקציה בתוך הערה אינו
// קריאה, וספירת סוגריים בהערה אינה מבנה.
const CODE = RULES.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ------------------------------------------------------------------
head('מבנה');
// ------------------------------------------------------------------

{
  const open = (CODE.match(/\{/g) || []).length;
  const close = (CODE.match(/\}/g) || []).length;
  if (open !== close) fail('סוגריים מסולסלים לא מאוזנים',
    open + ' נפתחו, ' + close + ' נסגרו — הפרש ' + (open - close));
  else ok('סוגריים מסולסלים מאוזנים (' + open + ')');

  const p1 = (CODE.match(/\(/g) || []).length;
  const p2 = (CODE.match(/\)/g) || []).length;
  if (p1 !== p2) fail('סוגריים עגולים לא מאוזנים', p1 + ' מול ' + p2);
  else ok('סוגריים עגולים מאוזנים (' + p1 + ')');

  if (!/^rules_version\s*=\s*'2'/m.test(RULES)) {
    fail('חסרה הצהרת rules_version = \'2\'');
  } else ok('rules_version = 2');
}

// כל match שאין תחתיו allow הוא אוסף חסום לחלוטין, בשקט.
{
  const blocks = [...CODE.matchAll(/match\s+(\/[^\s{]+)\s*\{/g)];
  const noAllow = [];
  for (const m of blocks) {
    const from = m.index + m[0].length;
    // חותכים עד ה-match הבא באותה רמה, או עד סוף הקובץ
    const next = CODE.indexOf('match ', from);
    const body = CODE.slice(from, next === -1 ? CODE.length : next);
    if (!/allow\s/.test(body) && !/match\s/.test(m[0] + body)) {
      noAllow.push(m[1]);
    }
  }
  if (noAllow.length) caution('match בלי allow — האוסף חסום לגמרי',
    noAllow.join(' · '));
  else ok('לכל match יש allow');
}

// ------------------------------------------------------------------
head('אילוץ ארכיטקטוני');
// ------------------------------------------------------------------

{
  // get() ו-exists() עלולים לעלות קריאת מסמך לכל בדיקת הרשאה.
  // המערכת בנויה על claims; חריגים חייבים להיות קריאות מדויקות:
  // תגובה בודקת שהודעת-האב לא הוסתרה, דוח Shadow בודק שרק הדור
  // הפעיל קריא, ובקרת Shadow רגישה מאמתת שהמשתמש עדיין פעיל.
  // בנוסף, שער החברות הכללי קורא את אותו מסמך משתמש חי כדי שטוקן
  // ישן לא ימשיך לעבוד אחרי העברה/השבתה. מינוי אחראי הסידור נבדק
  // ב-Functions; אין נתיב כתיבה ישיר מהלקוח ולכן הכללים אינם צריכים
  // לקרוא אותו.
  const gets = [...CODE.matchAll(/(?<![.\w])(get|exists|getAfter)\s*\(/g)];
  const replyParentReads = [...CODE.matchAll(
    /(?<![.\w])get\s*\(\s*\/databases\/\$\(database\)\/documents\/stations\/\$\(sid\)\/sub_stations\/\$\(subId\)\/bulletin_messages\/\$\(messageId\)\s*\)/g
  )];
  const shadowParentReads = [...CODE.matchAll(
    /(?<![.\w])get\s*\(\s*\/databases\/\$\(database\)\/documents\/stations\/\$\(sid\)\/attendance_shadow_reports\/\$\(monthKey\)\s*\)/g
  )];
  const liveUserReads = [...CODE.matchAll(
    /(?<![.\w])get\s*\(\s*\/databases\/\$\(database\)\/documents\/stations\/\$\(sid\)\/users\/\$\(request\.auth\.uid\)\s*\)/g
  )];
  const identityOperationReads = [...CODE.matchAll(
    /(?<![.\w])(get|exists)\s*\(\s*\/databases\/\$\(database\)\/documents\/identity_operations\/\$\(uid\)\s*\)/g
  )];
  if (gets.length === 7 &&
      replyParentReads.length === 1 && shadowParentReads.length === 1 &&
      liveUserReads.length === 2 && identityOperationReads.length === 3) {
    ok('קריאות מוגבלות: תגובה, Shadow, שתי בדיקות חברות חיה ופעולת זהות');
  } else if (gets.length) {
    fail(gets.length + ' קריאות get()/exists() — רק הנתיבים והכמויות המאושרים מותרים',
      'כל קריאה אחרת מגדילה עלות ועלולה לעקוף את מודל ה-claims');
  } else {
    fail('חסרות בדיקות נתיבי-האב המאושרות',
      'תגובה מוסתרת או דור Shadow חלקי עלולים לדלוף בנתיב ישיר');
  }
}

// ------------------------------------------------------------------
head('פונקציות');
// ------------------------------------------------------------------

{
  const defined = new Set(
    [...CODE.matchAll(/function\s+(\w+)\s*\(/g)].map(m => m[1]));
  const called = new Set(
    [...CODE.matchAll(/(?<![.\w])(\w+)\s*\(/g)].map(m => m[1]));

  // מילות מפתח ופונקציות מובנות של Firestore Rules
  const BUILTIN = new Set(['function','if','get','exists','getAfter','debug',
    'hasOnly','hasAll','hasAny','size','diff','affectedKeys','keys','values',
    'lower','upper','trim','split','matches','replace','toUtf8','duration',
    'time','math','path','float','int','string','bool','timestamp','latlng',
    'is','in','set','list','map','number','request','resource','date',
    'value','abs','ceil','floor','round','pow','sqrt','unique','concat',
    'join','removeAll','toBase64','toHexString','year','month','day',
    'hours','minutes','seconds','nanos','dayOfWeek','toMillis','toDuration']);

  const missing = [...called].filter(c => !defined.has(c) && !BUILTIN.has(c));
  if (missing.length) fail('פונקציות שנקראות ולא הוגדרו', missing.join(' · '));
  else ok(defined.size + ' פונקציות — כולן מוגדרות');

  const unused = [...defined].filter(d => {
    const uses = [...CODE.matchAll(new RegExp('(?<![.\\w])' + d + '\\s*\\(', 'g'))];
    return uses.length <= 1;   // ההגדרה עצמה
  });
  if (unused.length) caution('פונקציות שהוגדרו ואינן בשימוש', unused.join(' · '));
  else ok('כל הפונקציות בשימוש');
}

// ------------------------------------------------------------------
head('אוספים — הכללים מול הקוד');
// ------------------------------------------------------------------

// מה שהקוד באמת נוגע בו
const SCREENS = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const touched = new Map();   // שם אוסף → סט מסכים

for (const f of SCREENS) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/collection\(db,\s*'stations',\s*\w+,\s*'([\w_]+)'/g)) {
    if (!touched.has(m[1])) touched.set(m[1], new Set());
    touched.get(m[1]).add(f);
  }
  for (const m of src.matchAll(/doc\(db,\s*'stations',\s*\w+,\s*'([\w_]+)'/g)) {
    if (!touched.has(m[1])) touched.set(m[1], new Set());
    touched.get(m[1]).add(f);
  }
}

const ruled = new Set(
  [...CODE.matchAll(/match\s+\/([\w_]+)\/\{/g)].map(m => m[1]));

{
  const orphan = [...touched.keys()].filter(c => !ruled.has(c));
  if (orphan.length) {
    fail('אוספים שהקוד נוגע בהם ואין להם כלל — כל גישה תיחסם',
      orphan.map(c => c + ' (' + [...touched.get(c)].join(', ') + ')').join('\n    '));
  } else ok([...touched.keys()].length + ' אוספים בשימוש — לכולם יש כלל');

  const unusedRules = [...ruled].filter(r =>
    !touched.has(r) && !['databases','documents'].includes(r));
  if (unusedRules.length) {
    caution('כללים לאוספים שאף מסך לא נוגע בהם',
      unusedRules.join(' · ') + '\n    (ייתכן שנכתבים בשרת בלבד — בדוק)');
  }
}

// ------------------------------------------------------------------
head('שדות — מה שהכלל דורש מול מה שהקוד כותב');
// ------------------------------------------------------------------

{
  // לכל match, אילו שדות הכלל דורש — ומול מה משווים.
  //
  // הגרסה הראשונה ניסתה לקשור כתיבה לאוסף לפי קרבה בטקסט,
  // והתריעה על שדות שכן נכתבים — רק בתוך פונקציית עזר. כלי
  // שמתריע לשווא הוא כלי שמפסיקים לקרוא.
  //
  // לכן: אוספים את **כל** מפתחות האובייקטים בקבצים שנוגעים
  // באוסף, ובשרת. אזהרה יוצאת רק כששם השדה לא מופיע בשום
  // מקום — וזה כבר ממצא אמיתי.
  const problems = [];
  const SERVER = fs.existsSync(path.join(ROOT, 'functions/index.js'))
    ? fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8') : '';

  const keysIn = src => new Set(
    [...src.matchAll(/[{,]\s*['"]?([\w_]+)['"]?\s*:/g)].map(m => m[1])
      .concat([...src.matchAll(/\[['"]([\w_.]+)['"]\s*\]\s*=/g)].map(m => m[1]))
      .concat([...src.matchAll(/['"]([\w_]+)\.['"]?\s*\+/g)].map(m => m[1]))
  );
  const serverKeys = keysIn(SERVER);

  const blocks = [...CODE.matchAll(
    /match\s+\/([\w_]+)\/\{[\w]*\}\s*\{([\s\S]*?)\n      \}/g)];

  for (const [, name, body] of blocks) {
    if (!touched.has(name)) continue;
    const wanted = new Set(
      [...body.matchAll(/request\.resource\.data\.get\('([\w_]+)'/g)].map(m => m[1]));
    if (!wanted.size) continue;

    const written = new Set(serverKeys);
    for (const f of touched.get(name)) {
      for (const k of keysIn(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
        written.add(k);
      }
    }
    const missing = [...wanted].filter(w => !written.has(w));
    if (missing.length) {
      problems.push(name + ': הכלל בודק ' + missing.join(', ') +
        ' — השם הזה לא מופיע כמפתח בשום קובץ שנוגע באוסף');
    }
  }

  if (problems.length) {
    fail('שדות שהכלל דורש ואינם נכתבים בשום מקום', problems.join('\n    '));
  } else ok('כל שדה שהכללים בודקים נכתב בקוד');
}

// ------------------------------------------------------------------
head('אינדקסים — השאילתות מול הקובץ');
// ------------------------------------------------------------------

{
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  const have = new Set(idx.indexes.map(i =>
    i.collectionGroup + ':' + i.fields.map(f => f.fieldPath).sort().join(',')));

  // שאילתה עם יותר מתנאי where אחד, או where + orderBy, דורשת
  // אינדקס מורכב. בלעדיו היא נכשלת רק בזמן ריצה.
  const need = [];
  for (const f of SCREENS.concat(['../fire/functions/index.js'])) {
    const p = f.startsWith('..') ? path.join(ROOT, 'functions/index.js')
                                 : path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/query\(\s*collection\([^)]*'([\w_]+)'\)?,([\s\S]{0,300}?)\)\s*[;,)]/g)) {
      const fields = [...m[2].matchAll(/where\('([\w_.]+)'|orderBy\('([\w_]+)'/g)]
        .map(x => x[1] || x[2]);
      if (fields.length >= 2) {
        need.push({ col: m[1], fields: fields.sort(), where: f });
      }
    }
  }
  const missing = need.filter(n => !have.has(n.col + ':' + n.fields.join(',')));
  if (missing.length) {
    caution('שאילתות מורכבות בלי אינדקס תואם',
      missing.map(n => n.col + ' [' + n.fields.join(', ') + '] ב-' + n.where).join('\n    ') +
      '\n    (בדוק — הזיהוי כאן גס ועלול לטעות)');
  } else {
    ok(idx.indexes.length + ' אינדקסים · ' + need.length + ' שאילתות מורכבות תואמות');
  }
}

// ------------------------------------------------------------------
console.log('\n' + '='.repeat(52));
if (bad) console.log(bad + ' כשלים · ' + warn + ' אזהרות — יש לתקן לפני פריסה');
else if (warn) console.log('בלי כשלים · ' + warn + ' אזהרות לבדיקה');
else console.log('הכללים עוברים את כל הבדיקות הסטטיות');
console.log('='.repeat(52));
console.log('\nמה שהבדיקה הזו **אינה** מכסה: תחביר שהמהדר של');
console.log('Firebase דוחה. היא בודקת התאמה ומבנה, לא דקדוק.');
console.log('הפלט של deploy.bat נשאר האימות היחיד לתחביר.');

process.exit(bad ? 1 : 0);
