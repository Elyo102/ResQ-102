// scans: הכרעת אבטחה מחייבת (42H.20 closure batch item 1 / Security Scope
// 11) — סטטית, בלי אמולטור. הורדת אמולטור Firestore חסומה בסביבה הזו
// (נבדק שוב במפורש: storage.googleapis.com חסום ברשת) ולכן rules-test/
// (סעיף 18ג שם) לא רץ. זו הבדיקה שכן רצה: לא מהדרת כללים, אלא משווה בין
// שלושה מקורות אמת בקוד עצמו.
//
// ההכרעה המחייבת (CLAUDE-TASK.md): מפקד תחנה יכול לשמר גישה לתצוגת
// scans "המצומצמת" הקיימת *רק אם* מוכח שהמטען ממוזער, בלי פרט
// רפואי/HR פרטי ובלי נתוני התראת 265 שעות. אחרת — לא להכליל.
//
// בדיקה 1: הקוד שכותב בפועל את stations/{sid}/scans/{month} (nightlyScan,
//          functions/index.js) כותב full_name, מספר עובד וסך שעות מדויק
//          לכל אדם, וממצא kind:'over_limit' ברגע חציית סף השעות — בדיוק
//          הנתונים שהמדיניות אוסרת. זה מוכיח שהמטען *אינו* ממוזער.
// בדיקה 2: מכיוון שהמטען אינו ממוזער, firestore.rules על scans מותר
//          לקרוא רק hr(sid) — לא stationCommander(sid) — ואינו מתיר כתיבה
//          בכלל (כתיבה רק דרך Admin SDK בפונקציה המתוזמנת).
// בדיקה 3: אף מסך לקוח לא תלוי בגישת מפקד ל-scans היום: הקובץ היחיד
//          שקורא את האוסף (check.html) חוסם את כל העמוד למי שאינו super
//          לפני שהוא נוגע ב-scans בכלל.
//
// הרצה:  node scans-access-source.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP = __j(__TESTS, '..');
const ROOT = __APP;

let bad = 0;
function check(cond, label, detail) {
  if (cond) { console.log('✓ ' + label); }
  else { bad++; console.log('✗ ' + label + (detail ? '\n    ' + detail : '')); }
}

const indexSrc = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

// --- בדיקה 1: המטען שנכתב בפועל אינו ממוזער ---
const nightlyMatch = indexSrc.match(/exports\.nightlyScan[\s\S]{0,2200}?\}\);/);
check(!!nightlyMatch, 'nightlyScan נמצא ב-functions/index.js');
const nightlyBody = nightlyMatch ? nightlyMatch[0] : '';

check(/full_name:\s*r\.person\.full_name/.test(nightlyBody),
  'nightlyScan כותב full_name לכל אדם מדוגל — לא ממוזער',
  'אם זה נכשל, ייתכן שהמטען כבר מוזער ואפשר לשקול להחזיר את הגישה');
check(/emp:\s*r\.person\.emp/.test(nightlyBody),
  'nightlyScan כותב מספר עובד (emp) לכל אדם מדוגל');
check(/total_hours:\s*r\.total/.test(nightlyBody),
  'nightlyScan כותב total_hours מדויק — אותה קטגוריית מידע כמו hr_reports/getHrOverHoursAlert');
check(/findings:\s*r\.findings/.test(nightlyBody),
  'nightlyScan כותב את מערך הממצאים המלא (findings) לכל אדם מדוגל');

const scanPersonMatch = indexSrc.match(/function scanPerson\([\s\S]*?\n\}/);
check(!!scanPersonMatch, 'scanPerson נמצא ב-functions/index.js');
check(!!scanPersonMatch && /kind:\s*'over_limit'/.test(scanPersonMatch[0]),
  'scanPerson מייצר ממצא kind:\'over_limit\' בחציית סף השעות — נתוני התראת שעות, לא רק "יש/אין דיווח"');

// --- בדיקה 2: הכללים לא מרחיבים גישה למידע שאינו ממוזער ---
const scansRuleMatch = rules.match(/match \/scans\/\{[^}]+\}\s*\{[\s\S]*?\n {6}\}/);
check(!!scansRuleMatch, 'בלוק match /scans/{...} נמצא ב-firestore.rules');
const scansRule = scansRuleMatch ? scansRuleMatch[0] : '';
check(/allow read:\s*if hr\(sid\);/.test(scansRule),
  'scans: allow read מוגבל ל-hr(sid) בלבד — לא stationCommander',
  'נמצא: ' + scansRule.replace(/\s+/g, ' ').trim());
check(!/stationCommander/.test(scansRule),
  'scans: אין שום איזכור של stationCommander בבלוק הכללים');
check(/allow write:\s*if false;/.test(scansRule),
  'scans: אין כתיבת לקוח בכלל — רק Admin SDK מהפונקציה המתוזמנת');

// --- בדיקה 3: אין מסך לקוח שתלוי בגישת מפקד ל-scans ---
const clientFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') || f.endsWith('.js'));
const readersOfScans = [];
for (const file of clientFiles) {
  const full = path.join(ROOT, file);
  if (fs.statSync(full).isDirectory()) continue;
  const src = fs.readFileSync(full, 'utf8');
  if (/collection\(db,\s*[`'"][^`'"]*scans/.test(src) || /\/scans\/\{/.test(src) || /\bscans\b/.test(src)) {
    if (/\bscans\b/.test(src)) readersOfScans.push(file);
  }
}
check(readersOfScans.length === 1 && readersOfScans[0] === 'check.html',
  'הקובץ היחיד שמזכיר scans בצד הלקוח הוא check.html',
  'נמצאו: ' + JSON.stringify(readersOfScans));

const checkHtml = fs.readFileSync(path.join(ROOT, 'check.html'), 'utf8');
const runAllMatch = checkHtml.match(/async function runAll\(user\)\{[\s\S]*?\n\}/);
check(!!runAllMatch, 'runAll(user) נמצא ב-check.html');
check(!!runAllMatch && /isSuper\s*=\s*c\s*&&\s*c\.super\s*===\s*true/.test(runAllMatch[0])
  && /if\s*\(!isSuper\)/.test(runAllMatch[0]),
  'check.html חוסם את כל העמוד למי שאינו super, לפני שהוא נוגע ב-scans');

console.log('');
console.log(bad
  ? bad + ' בדיקות scans-access נכשלו'
  : 'כל בדיקות ה-scans-access עברו: המטען אינו ממוזער, הכללים מוגבלים ל-hr(sid) בהתאם, ואין תלות לקוח בגישת מפקד');
process.exitCode = bad ? 1 : 0;
