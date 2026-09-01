// ============================================================
//  מזהי משתמש אמיתיים · UID שמכיל נקודה
// ============================================================
//
//      node tests/uid-dot-probe.mjs
//
//  אין רשת, אין Firebase, אין אמולטור, אין תלות חיצונית.
//  הבדיקה אינה משנה שום קוד עסקי.
//
//  ─────────────────────────────────────────────────────────
//  למה נקודה, ולמה דווקא היא
//  ─────────────────────────────────────────────────────────
//
//  ב-Firestore, `update({ 'signups.abc': v })` **אינו** כותב
//  מפתח בשם "signups.abc". הנקודה היא מפריד נתיב, ולכן זה
//  כותב `signups: { abc: v }`.
//
//  כל עוד ה-uid נקי מנקודות שתי הצורות מתלכדות, והקוד עובד.
//  ברגע שה-uid מכיל נקודה — הכותב יוצר קינון, והקורא, שמשתמש
//  בגישת סוגריים שטוחה, מחפש מפתח שאינו קיים.
//
//  Firebase Auth **מרשה נקודה ב-uid**. uid מותאם אישית מוגבל
//  לאורך בלבד, וספקי זהות חיצוניים מייצרים מזהים עם נקודות.
//  לכן זה אינו קלט זדוני תיאורטי — זו זהות חוקית.
//
//  הבדיקה מדמה את סמנטיקת הנתיב של Firestore ומוכיחה שלושה
//  דברים: שהכתיבה מתקננת, שהקריאה מחטיאה, ושלושה uid שונים
//  יכולים להתנגש זה בזה.
// ============================================================

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');
const require_ = createRequire(import.meta.url);

const B = require_(join(__APP, 'functions', 'bulletin.js'));

function src(rel) {
  const p = join(__APP, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
const INDEX_SRC = src('functions/index.js');
const RUNTIME_SRC = src('functions/schedule-runtime.js');
const GUARDS_SRC = src('guards.js');
const CALLOUT_SRC = src('callout.js');

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; bad.push(name);
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}
function head(t) { console.log('\n--- ' + t); }

// ------------------------------------------------------------
//  מודל סמנטיקת הנתיב של Firestore update()
// ------------------------------------------------------------
//  מפתח עם נקודה מפוצל לנתיב מקונן. זו ההתנהגות המתועדת,
//  והיא מה שהופך את הדפוס `patch['x.' + uid]` למלכודת.

function firestoreUpdate(doc, patch) {
  const out = JSON.parse(JSON.stringify(doc || {}));
  for (const key of Object.keys(patch)) {
    const parts = key.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = patch[key];
  }
  return out;
}

// הקורא, כפי שהוא כתוב בקוד: גישת סוגריים שטוחה.
function flatRead(map, uid) {
  return (map || {})[uid];
}

const CLEAN = 'AbC123xyz';
const DOTTED = 'user.name';
const PREFIX = 'user';

// ============================================================
head('1 · המודל עצמו · uid נקי עובד, uid עם נקודה מתקנן');
// ============================================================

const cleanDoc = firestoreUpdate({}, { ['signups.' + CLEAN]: { name: 'נקי' } });
ok('uid נקי · נכתב שטוח', Object.prototype.hasOwnProperty.call(cleanDoc.signups, CLEAN));
ok('uid נקי · הקריאה מוצאת אותו', flatRead(cleanDoc.signups, CLEAN) !== undefined);

const dottedDoc = firestoreUpdate({}, { ['signups.' + DOTTED]: { name: 'מנוקד' } });
ok('uid עם נקודה · לא נכתב מפתח שטוח',
   !Object.prototype.hasOwnProperty.call(dottedDoc.signups, DOTTED));
ok('uid עם נקודה · נוצר קינון במקום',
   !!dottedDoc.signups.user && !!dottedDoc.signups.user.name);
ok('uid עם נקודה · הקריאה מחטיאה',
   flatRead(dottedDoc.signups, DOTTED) === undefined,
   'זהו הבאג: נכתב, ולא נמצא');

// ============================================================
head('2 · התנגשות · שני אנשים על אותו ענף');
// ============================================================

let both = firestoreUpdate({}, { ['signups.' + PREFIX]: { name: 'קודם' } });
both = firestoreUpdate(both, { ['signups.' + DOTTED]: { name: 'מנוקד' } });

ok('כתיבת "user.name" דרסה את הרשומה של "user"',
   typeof both.signups.user === 'object' && both.signups.user.name !== 'קודם',
   'שני uid שונים כתבו לאותו מקום · ' + JSON.stringify(both.signups));

ok('הרשומה של "user" אבדה', flatRead(both.signups, PREFIX) === undefined ||
   both.signups[PREFIX].name !== 'קודם');

// ------------------------------------------------------------
//  ומה קורה כשמונים אנשים — ספירה שמופיעה במסכים
// ------------------------------------------------------------
const enumerated = Object.keys(both.signups || {});
ok('ספירת הנרשמים מחזירה 1 במקום 2', enumerated.length === 1,
   'נמצא: ' + JSON.stringify(enumerated));
ok('והמזהה שמוצג הוא "user" — אדם שלא נרשם', enumerated[0] === 'user');

// ============================================================
head('3 · הסרה · המחיקה פוגעת בנתיב הלא נכון');
// ============================================================

const DELETED = '__DELETE__';
let joined = firestoreUpdate({}, { ['signups.' + PREFIX]: { name: 'נשאר' } });
joined = firestoreUpdate(joined, { ['signups.' + DOTTED]: { name: 'יוצא' } });
const afterLeave = firestoreUpdate(joined, { ['signups.' + DOTTED]: DELETED });

ok('ההסרה נגעה בענף המקונן ולא במפתח המבוקש',
   afterLeave.signups.user && afterLeave.signups.user.name === DELETED);
ok('ולכן הסרה של uid מנוקד אינה מסירה רשומה שטוחה בשמו',
   flatRead(afterLeave.signups, DOTTED) === undefined);

// ============================================================
head('4 · שיבוץ · מפתח אובייקט רגיל דווקא עמיד');
// ============================================================
//
//  ההבחנה חשובה כדי לא להרעיש: `obj[uid] = v` ב-JavaScript
//  רגיל בטוח לחלוטין עם נקודה. הבעיה היא **רק** במקום שבו
//  המפתח נמסר ל-Firestore כנתיב.

const load = {};
load[DOTTED] = 3;
load[PREFIX] = 7;
ok('מפתח JS רגיל · uid מנוקד נשמר כמו שהוא', load[DOTTED] === 3);
ok('מפתח JS רגיל · אין התנגשות עם התחילית', load[PREFIX] === 7);
ok('מפתח JS רגיל · שני מפתחות נפרדים', Object.keys(load).length === 2);

// JSON יציב — מה שמשמש לחתימות ולהשוואות
ok('uid מנוקד שורד סבב JSON',
   JSON.parse(JSON.stringify(load))[DOTTED] === 3);

// מפריד `:` בדדופליקציה — נקודה אינה מסוכנת שם, נקודתיים כן
const dedupe = (pub, person, hash) => pub + ':' + person + ':' + hash;
ok('מפתח דדופליקציה · uid מנוקד ייחודי',
   dedupe('p1', DOTTED, 'h') !== dedupe('p1', PREFIX, 'h'));
ok('מפתח דדופליקציה · uid עם נקודתיים כן מתנגש — מתועד',
   dedupe('p1', 'a:b', 'h') === dedupe('p1', 'a', 'b:h'),
   'זו התנגשות אמיתית, אך נקודתיים אינן חוקיות ב-uid של Firebase');

// ============================================================
head('5 · ההגנה שכן קיימת · bulletin.js');
// ============================================================
//
//  לוח המודעות הוא המקום היחיד בקוד שמסנן את המזהה לפני
//  שהוא נכנס למפתח. זו התנהגות נכונה, והיא נבדקת כאן כדי
//  שלא תוסר בשקט.

function identityError(uid) {
  try {
    B.postingIdentity({ uid, token: { stationId: 'station-102', role: 'firefighter' } }, {});
    return null;
  } catch (e) { return e && (e.code || e.message) ? String(e.code || e.message) : 'THREW'; }
}

ok('bulletin · uid נקי מתקבל', identityError(CLEAN) === null,
   'התקבל: ' + identityError(CLEAN));
ok('bulletin · uid עם נקודה נדחה', identityError(DOTTED) !== null);
ok('bulletin · uid עם לוכסן נדחה', identityError('a/b') !== null);
ok('bulletin · uid ריק נדחה', identityError('') !== null);

const BSRC = readFileSync(join(__APP, 'functions', 'bulletin.js'), 'utf8');
ok('bulletin · הביטוי הרגולרי אינו מרשה נקודה',
   /\^\[A-Za-z0-9\]\[A-Za-z0-9_-\]\*\$/.test(BSRC),
   'אם נוספה נקודה לרשימה — ההגנה הוסרה');

// מזהי הודעות נגזרים מה-uid; אם ה-uid ייכנס גולמי הם ישברו
ok('bulletin · מזהה הודעה דטרמיניסטי ל-uid נקי',
   B.messageId(CLEAN, 'req-1') === B.messageId(CLEAN, 'req-1'));
ok('bulletin · שני uid שונים נותנים מזהים שונים',
   B.messageId(CLEAN, 'req-1') !== B.messageId('Zz9', 'req-1'));

// ============================================================
head('6 · מקור · הכתיבה עוברת ב-FieldPath ולא במחרוזת');
// ============================================================
//
//  הגרסה הראשונה של הסעיף הזה תיעדה את הדפוס השבור כעוגן,
//  כדי שתיקון שקט לא יעבור בלי לעדכן את הבדיקה. **הדפוס
//  תוקן**, והקביעות התהפכו: עכשיו הן שומרות על התיקון.
//
//  הכלל: מפתח שמכיל uid נמסר כ-FieldPath, שמטפל בשם השדה
//  כערך יחיד. חזרה למחרוzת „x." + uid תפיל את הסעיף הזה.

if (INDEX_SRC) {
  ok('functions/index.js · אין יותר מחרוזת signups. + uid',
     !/['"]signups\.['"]\s*\+/.test(INDEX_SRC),
     'מחרוזת עם נקודה היא נתיב, לא מפתח');

  ok('functions/index.js · ההרשמה נכתבת דרך FieldPath',
     /new admin\.firestore\.FieldPath\(\s*['"]signups['"]\s*,/.test(INDEX_SRC));

  ok('functions/index.js · גם ההסרה עוברת באותו נתיב',
     /FieldPath\(\s*['"]signups['"][\s\S]{0,400}?FV\.delete\(\)/.test(INDEX_SRC),
     'אם המחיקה נשארה על מחרוזת — היא תמחק ענף אחר');
} else {
  ok('functions/index.js קיים', false, 'הקובץ לא נמצא');
}

if (GUARDS_SRC) {
  // הקורא נשאר שטוח בכוונה — זה הצד הנכון. אחרי התיקון
  // בכותב, גישה שטוחה היא בדיוק מה שצריך לקרות.
  ok('guards.js · הקורא נשאר בגישה שטוחה, וזה הצד הנכון',
     /signups[^\n]{0,40}\[uid\]/.test(GUARDS_SRC),
     'הכותב שומר מפתח שטוח, ולכן הקורא צריך להישאר שטוח');
} else {
  ok('guards.js נמצא לבדיקה', false, 'הקובץ לא נמצא בשורש');
}

if (CALLOUT_SRC) {
  ok('callout.js · אין יותר מחרוזת acks. + uid',
     !/['"]acks\.['"]\s*\+/.test(CALLOUT_SRC));
  ok('callout.js · התשובה נכתבת דרך FieldPath',
     /new FieldPath\(\s*['"]acks['"]\s*,/.test(CALLOUT_SRC));
  ok('callout.js · FieldPath מיובא מה-SDK',
     /import\s*\{[^}]*FieldPath[^}]*\}/.test(CALLOUT_SRC),
     'בלי הייבוא המסך לא עולה בכלל');
  ok('callout.js · הקורא נשאר שטוח, וזה הצד הנכון',
     /acks\[uid\]/.test(CALLOUT_SRC),
     '„כבר עניתי" נתפס עכשיו גם ל-uid עם נקודה');
} else {
  ok('callout.js נמצא לבדיקה', false, 'הקובץ לא נמצא בשורש');
}

if (RUNTIME_SRC) {
  const FLAT = RUNTIME_SRC.replace(/\s+/g, ' ');
  ok('מתועד · ID_RE נאכף על מזהה התחנה', /ID_RE\.test\(sid\)/.test(FLAT));
  ok('מתועד · ID_RE אינו נאכף על req.auth.uid',
     !/ID_RE\.test\(req\.auth\.uid\)/.test(FLAT),
     'ה-uid נכנס לנתיבי מסמכים בלי סינון — היום זה תלוי כולו ב-Firebase Auth');
  // מסמך המינוי קיים רק בענף codex/resq-schedule-manager-role.
  // ב-main הוא אינו קיים, ולכן הקביעה מותנית ואינה נופלת שם
  // על היעדר קוד שעדיין לא מוזג.
  if (/SCHEDULE_MANAGER_GRANTS/.test(FLAT)) {
    ok('מתועד · ה-uid נכנס לנתיב מסמך המינוי בלי סינון',
       /collection\(SCHEDULE_MANAGER_GRANTS\)\.doc\(uid\)/.test(FLAT));
  }
}

// ============================================================
head('7 · מוטציות · הבדיקה נופלת על מודל שבור');
// ============================================================

function mutationCaught(name, cond) { ok('מוטציה נתפסה · ' + name, cond); }

// מודל שאינו מפצל נקודות — כלומר Firestore שמתנהג כמו JS
function naiveUpdate(doc, patch) {
  return Object.assign({}, doc, patch);
}
const naive = naiveUpdate({}, { ['signups.' + DOTTED]: { name: 'x' } });
mutationCaught('מודל שטוח היה מחמיץ את הבאג',
   Object.prototype.hasOwnProperty.call(naive, 'signups.' + DOTTED) &&
   naive.signups === undefined);

// ביטוי רגולרי שמרשה נקודה
const permissive = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
mutationCaught('רגקס מתירני היה מקבל uid מנוקד', permissive.test(DOTTED) === true);

// הקורא מתוקן לנתיב מקונן
function pathRead(map, uid) {
  return uid.split('.').reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), map);
}
mutationCaught('קורא מודע-נתיב היה מוצא את הרשומה',
   pathRead(dottedDoc.signups, DOTTED) !== undefined);

// ============================================================
console.log('\n============================================');
console.log('  UID עם נקודה · עברו ' + pass + '  ·  נכשלו ' + fail);
if (fail) console.log('  ' + bad.join('\n  '));
console.log('============================================');
process.exit(fail ? 1 : 0);
