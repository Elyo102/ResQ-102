// ============================================================
//  שומר חוזה · מינוי „אחראי/ת סידור"
// ============================================================
//
//      node tests/schedule-access-contract.mjs
//
//  אין רשת, אין Firebase, אין אמולטור, אין תלות חיצונית.
//  הבדיקה אינה משנה שום קוד עסקי.
//
//  ─────────────────────────────────────────────────────────
//  למה הקובץ הזה קיים
//  ─────────────────────────────────────────────────────────
//
//  ב-1.9.2026 נכתב חוזה מערכת בטקסט, ונבנתה מולו חבילת בדיקות
//  שלמה. אחר כך התברר שהקוד מממש חוזה **אחר**: אוסף אחר, שמות
//  שדות אחרים, ומנגנון אחר. החבילה בדקה מערכת שלא קיימת, וזה
//  התגלה רק אחרי שנמסרה.
//
//  זה לא קרה כי מישהו טעה. זה קרה כי **אין מקום אחד שאומר מה
//  החוזה**, ולכן טקסט וקוד יכולים להיפרד בלי שאף אחד ישים לב.
//
//  הקובץ הזה הוא המקום הזה.
//
//  ─────────────────────────────────────────────────────────
//  שלוש שכבות, ובמכוון
//  ─────────────────────────────────────────────────────────
//
//  א. **גזירה** — החוזה נקרא מ-firestore.rules, כי שם נקודת
//     האכיפה. מה שכתוב שם הוא מה שבפועל עוצר אנשים; כל השאר
//     הוא נוחות. הגזירה אינה מניחה שם אוסף מראש.
//
//  ב. **הסכמה** — כל שאר המקומות חייבים להסכים עם מה שנגזר:
//     מי שקורא את המינוי, ומי שכותב אותו. אלה הבדיקות שתופסות
//     „תיקנתי בכללים ושכחתי בשרת".
//
//  ג. **ההכרעה** — קבוע אחד למטה נושא את ההכרעה האנושית. אם
//     הקוד מממש משהו אחר, זו אינה תקלת ניסוח — זו הכרעה שלא
//     יושמה, או קוד שסטה ממנה. שני המצבים דורשים אדם.
//
//  שכבה ג' היא היחידה שצריך לערוך ביד, ורק כשההכרעה משתנה.
// ============================================================

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __TESTS = dirname(fileURLToPath(import.meta.url));
const __APP = join(__TESTS, '..');

// ============================================================
//  ג · ההכרעה האנושית · המקום היחיד לערוך ביד
// ============================================================
//
//  מקור: הכרעת Codex בחדר, 1.9.2026 —
//    „הרשאת ניהול סידור נשמרת ב-stations/{sid}/schedule_access/{uid};
//     אין להשתמש ב-schedule_access שורשי. המסמך חייב להיות קשור
//     גם ל-sid וגם ל-uid, והחברות החיה בתחנה היא תנאי נוסף."
//
//  והחלטת המוצר של אלדד, תדריך סעיף 4:
//    „דרגה פיקודית אינה סמכות סידור. עריכה מגיעה אך ורק מרשומת
//     מינוי חיה, מקומית לתחנה."
//
//  **אל תשנה את הקבוע הזה כדי להשתיק בדיקה אדומה.** אם הקוד
//  אומר משהו אחר — או שההכרעה לא יושמה, או שהקוד סטה ממנה.
//  שנה אותו רק כשהתקבלה הכרעה חדשה, וציין אותה כאן.
const DECISION = Object.freeze({
  collection: 'stations/{sid}/schedule_access/{uid}',
  station_scoped: true,      // המסמך יושב תחת התחנה, לא בשורש
  requires_uid_match: true,
  requires_station_match: true,
  requires_active_true: true,
  client_readable: false,
  rank_grants_edit: false
});

// ============================================================

const RULES_PATH = join(__APP, 'firestore.rules');
const RUNTIME_PATH = join(__APP, 'functions', 'schedule-runtime.js');
const INDEX_PATH = join(__APP, 'functions', 'index.js');

for (const p of [RULES_PATH, RUNTIME_PATH, INDEX_PATH]) {
  if (!existsSync(p)) {
    console.error('NOT RUN — קובץ חסר: ' + p);
    process.exit(2);
  }
}

const RULES_RAW = readFileSync(RULES_PATH, 'utf8');
const RUNTIME = readFileSync(RUNTIME_PATH, 'utf8');
const INDEX = readFileSync(INDEX_PATH, 'utf8');

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; bad.push(name);
  console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
}
function head(t) { console.log('\n--- ' + t); }

// ------------------------------------------------------------
//  הסרת הערות · הערה אינה כלל, וכלל שהוסתר בהערה אינו הגנה
// ------------------------------------------------------------
function stripComments(src) {
  let out = '', i = 0, inStr = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += (n === undefined ? '' : n); i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (c === "'" || c === '"') { inStr = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

const RULES = stripComments(RULES_RAW).replace(/\s+/g, ' ');

// ============================================================
//  שער התאמה · האם מנגנון המינוי קיים בכלל
// ============================================================
//
//  ב-main הוא אינו קיים. הרצה שם הייתה מייצרת כשלים על היעדר
//  קוד ולא על הפרת חוזה — וזו בדיוק אזהרה שמפסיקים לקרוא.
//  יציאה 2 · NOT RUN · לא „עבר" ולא „נכשל".

const MANAGER_FN = /function\s+scheduleManager\s*\(/.test(RULES);
const RUNTIME_GRANT = /schedule_access|SCHEDULE_MANAGER_GRANTS|schedule_manager_grants/.test(RUNTIME);

if (!MANAGER_FN && !RUNTIME_GRANT) {
  console.error('NOT RUN — מנגנון „אחראי/ת סידור" אינו קיים בענף הזה.');
  console.error('firestore.rules אינו מגדיר scheduleManager, ו-schedule-runtime.js');
  console.error('אינו מכיר אוסף מינוי. אין חוזה לשמור עליו.');
  process.exit(2);
}

// ============================================================
head('א · גזירה · מה החוזה שכתוב בכללים');
// ============================================================
//
//  נקודת האכיפה היא firestore.rules. מה שכתוב שם הוא מה
//  שבפועל עוצר אנשים, ולכן ממנו נגזר החוזה — ולא מהתיעוד.

ok('firestore.rules מגדיר את פונקציית המינוי', MANAGER_FN,
   'בלי פונקציה ייעודית, ההרשאה מפוזרת ואי אפשר לגזור ממנה חוזה');

// גוף הפונקציה, עד הסוגר המאוזן
function bodyOf(src, startRe) {
  const m = startRe.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index);
  if (i === -1) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j); }
  }
  return '';
}

const MANAGER_BODY = bodyOf(RULES, /function\s+scheduleManager\s*\(/);
ok('גוף הפונקציה נקרא', MANAGER_BODY.length > 0);

// האוסף שממנו נקרא מסמך המינוי
// הנתיב מכיל $(...) — כלומר סוגריים בתוך הנתיב עצמו. ביטוי
// שנעצר בסוגר הראשון מפספס כל נתיב אמיתי, ולכן העצירה היא
// על ").data" ולא על הסוגר הראשון.
const grantPathMatch = /\/databases\/\$\(database\)\/documents\/([\s\S]+?)\)\s*\.data/.exec(MANAGER_BODY);
const GRANT_PATH = grantPathMatch ? grantPathMatch[1].trim() : null;

ok('החוזה קורא מסמך מינוי מנתיב מפורש', !!GRANT_PATH,
   'נמצא: ' + JSON.stringify(GRANT_PATH));

console.log('    נתיב המינוי בכללים: ' + (GRANT_PATH || '—'));

const STATION_SCOPED = !!GRANT_PATH && /stations\/\$\(/.test(GRANT_PATH);
const FIELD_STATION = /stationId/.test(MANAGER_BODY) ? 'stationId'
  : (/station_id/.test(MANAGER_BODY) ? 'station_id' : null);
const FIELD_VERSION = /\bversion\b/.test(MANAGER_BODY) ? 'version'
  : (/\brevision\b/.test(MANAGER_BODY) ? 'revision' : null);
const USES_CLAIM = /claim\(\s*'schedule_manager'/.test(MANAGER_BODY)
  || /token\s*\.\s*schedule_manager/.test(MANAGER_BODY);

console.log('    שדה תחנה: ' + (FIELD_STATION || '—') +
            '  ·  שדה גרסה: ' + (FIELD_VERSION || '—') +
            '  ·  claim: ' + (USES_CLAIM ? 'כן' : 'לא'));

// ============================================================
head('ב · הסכמה · כל השאר חייב להסכים עם הכללים');
// ============================================================
//
//  זו השכבה שתופסת „תיקנתי בכללים ושכחתי בשרת". היא אינה
//  יודעת מה נכון — היא רק דורשת שכולם יאמרו את אותו דבר.

const grantCollection = GRANT_PATH
  ? (GRANT_PATH.match(/([A-Za-z_][A-Za-z0-9_]*)\/\$\{?[^/]*\}?\s*$/) || [])[1]
    || (GRANT_PATH.split('/').filter((s) => !/^\$/.test(s)).pop() || null)
  : null;

console.log('    שם האוסף שנגזר: ' + (grantCollection || '—'));

ok('שם האוסף נגזר מהכללים', !!grantCollection);

if (grantCollection) {
  ok('schedule-runtime.js קורא מאותו אוסף',
     RUNTIME.indexOf(grantCollection) !== -1,
     'הכללים אומרים „' + grantCollection + '" — הריצה חייבת לקרוא משם');

  ok('functions/index.js כותב לאותו אוסף',
     INDEX.indexOf(grantCollection) !== -1,
     'מי שכותב את המינוי חייב לכתוב למקום שממנו קוראים אותו');
}

if (FIELD_STATION) {
  ok('שדה התחנה זהה בכללים ובריצה',
     new RegExp('\\b' + FIELD_STATION + '\\b').test(RUNTIME),
     'הכללים משווים ' + FIELD_STATION);
  ok('שדה התחנה זהה בכללים ובכותב',
     new RegExp('\\b' + FIELD_STATION + '\\b').test(INDEX));
}

if (FIELD_VERSION) {
  ok('שדה הגרסה זהה בכללים ובריצה',
     new RegExp('\\b' + FIELD_VERSION + '\\b').test(RUNTIME));
  ok('שדה הגרסה זהה בכללים ובכותב',
     new RegExp('\\b' + FIELD_VERSION + '\\b').test(INDEX));
}

// בכללים זה נכתב כ-grant.get('active', false) == true, ולכן
// ההשוואה אינה צמודה לשם השדה.
const ACTIVE_REQUIRED = /active[^;]{0,60}==\s*true/.test(MANAGER_BODY);
ok('הכללים דורשים active == true', ACTIVE_REQUIRED,
   'מינוי שאינו פעיל אינו מינוי');

ok('הכללים קושרים את המסמך ל-uid המחובר',
   /request\s*\.\s*auth\s*\.\s*uid/.test(MANAGER_BODY),
   'בלי זה מסמך של אדם אחד פותח עריכה לאדם אחר');

ok('הריצה דורשת active === true גם היא',
   /active\s*===\s*true/.test(RUNTIME));

if (USES_CLAIM) {
  ok('אם ההרשאה נשענת על claim — הוא נבדק גם מול מסמך חי',
     /version/.test(MANAGER_BODY) || /revision/.test(MANAGER_BODY),
     'claim לבדו שורד עד שהטוקן פג. התאמת גרסה מול מסמך היא מה שהופך ביטול למיידי');

  ok('שם ה-claim זהה בכללים ובכותב',
     /schedule_manager/.test(INDEX),
     'הכללים מחפשים claim שהכותב לא כותב = הרשאה שלא תינתן לעולם');
}

// ============================================================
head('ג · אטימות ללקוח · הלקוח אינו קורא ואינו כותב מינוי');
// ============================================================

// בלוקי match מקוננים: הנתיב של בלוק פנימי נכתב בקובץ **יחסית**
// להורה, ולכן `match /{document=**}` נראה זהה בשורש ובעומק
// ארבע. בלי מעקב אחרי ההורים אי אפשר להבחין בין wildcard גורף
// לבין wildcard תחום — ושניהם קיימים בקובץ הזה.
//
// לכן הסריקה רקורסיבית ומחזירה **נתיב מלא**.
function matchBlocks(src, prefix) {
  const out = [];
  const re = /\bmatch\s+((?:\/(?:[^\s/{}]+|\{[^{}]*\}))+)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].lastIndexOf('{');
    let depth = 0, close = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close === -1) continue;
    const body = src.slice(open + 1, close);
    const full = ((prefix || '') + m[1]).replace(/\/+/g, '/');
    // גוף ישיר בלבד: מה שיושב בתוך בלוקי בן שייך לבן ולא להורה.
    const ownBody = body.replace(/\bmatch\s+(?:\/(?:[^\s/{}]+|\{[^{}]*\}))+\s*\{[\s\S]*$/, '');
    out.push({ path: full, body: body, ownBody: ownBody });
    out.push.apply(out, matchBlocks(body, full));
    re.lastIndex = close;
  }
  return out;
}

const MATCHES = matchBlocks(RULES, '');
const grantBlocks = grantCollection
  ? MATCHES.filter((b) => b.path.indexOf(grantCollection) !== -1)
  : [];

ok('קיים בלוק match מפורש לאוסף המינוי', grantBlocks.length > 0,
   'הגנה שנשענת על היעדר כלל אינה כלל — היא מקרה');

const allows = grantBlocks
  .map((b) => (b.body.match(/allow[^;]*;/g) || []).join(' '))
  .join(' ');

ok('הלקוח אינו קורא ואינו כותב את המינוי',
   grantBlocks.length > 0 && /allow\s+read\s*,\s*write\s*:\s*if\s+false/.test(allows.replace(/\s+/g, ' ')),
   'נמצא: ' + JSON.stringify(allows.slice(0, 200)));

// **רק wildcard בשורש.** `match /{document=**}` ברמה העליונה
// גובר על כל סגירה שמתחתיו. לעומת זאת
// `stations/{sid}/shifts/{crew}/{document=**}` הוא wildcard
// **תחום**, והוא דפוס לגיטימי ונפוץ — הוא חל רק על תת-עץ אחד.
//
// הגרסה הראשונה של הבדיקה סימנה את שניהם באדום, וזו בדיוק
// אזהרת שווא שגורמת להפסיק לקרוא אזהרות.
const wildcardAllows = MATCHES
  .filter((b) => /^\/\{document=\*\*\}$/.test(b.path.trim()))
  .flatMap((b) => (b.ownBody || b.body).match(/allow[^;]*;/g) || []);
ok('אין match גורף שמעניק גישה מעל הסגירה',
   wildcardAllows.every((a) => /:\s*if\s+false\s*;/.test(a)),
   'נמצא: ' + JSON.stringify(wildcardAllows.slice(0, 3)));

// ============================================================
head('ד · ההכרעה · מה שהוחלט מול מה שמומש');
// ============================================================
//
//  זו השכבה שהייתה מונעת את מה שקרה ב-1.9: חוזה שנכתב בטקסט
//  והקוד מימש אחר. היא אינה בודקת עקביות פנימית — היא בודקת
//  ציות להכרעה.

const decisionPath = DECISION.collection.replace(/\{sid\}/g, '$(sid)').replace(/\{uid\}/g, '');
const decisionCollection = (DECISION.collection.match(/([A-Za-z_][A-Za-z0-9_]*)\/\{uid\}/) || [])[1] || null;

console.log('    ההכרעה:  ' + DECISION.collection);
console.log('    בקוד:    ' + (GRANT_PATH || '—'));

ok('אוסף המינוי הוא זה שהוכרע',
   !!grantCollection && grantCollection === decisionCollection,
   'ההכרעה: „' + decisionCollection + '"  ·  בקוד: „' + grantCollection + '"\n' +
   '      זו אינה תקלת ניסוח. או שההכרעה לא יושמה, או שהקוד סטה ממנה —\n' +
   '      ושני המצבים דורשים אדם. אל תעדכן את DECISION כדי להשתיק את זה.');

ok('המינוי מקומי לתחנה, כפי שהוכרע',
   STATION_SCOPED === DECISION.station_scoped,
   'ההכרעה: ' + (DECISION.station_scoped ? 'תחת התחנה' : 'בשורש') +
   '  ·  בקוד: ' + (STATION_SCOPED ? 'תחת התחנה' : 'בשורש') + '\n' +
   '      מינוי בשורש פירושו שאדם אחד יכול להחזיק הרשאה שאינה קשורה לתחנה.');

ok('נדרשת התאמת uid, כפי שהוכרע',
   DECISION.requires_uid_match === /request\s*\.\s*auth\s*\.\s*uid/.test(MANAGER_BODY));

ok('נדרשת התאמת תחנה, כפי שהוכרע',
   DECISION.requires_station_match === !!FIELD_STATION);

ok('נדרש active == true, כפי שהוכרע',
   DECISION.requires_active_true === ACTIVE_REQUIRED);

ok('הלקוח אינו קורא את המינוי, כפי שהוכרע',
   DECISION.client_readable === false && grantBlocks.length > 0 &&
   /allow\s+read[^;]*:\s*if\s+false/.test(allows.replace(/\s+/g, ' ')));

// דרגה אינה סמכות — החלטת המוצר של אלדד
const RANKS = ['commander', 'deputy', 'station_commander', 'hr_coordinator',
               'superadmin', 'super_admin', 'admin'];
ok('דרגה פיקודית אינה מעניקה עריכה, כפי שהוכרע',
   DECISION.rank_grants_edit === false &&
   !RANKS.some((r) => new RegExp("['\"]" + r + "['\"]").test(MANAGER_BODY)),
   'דרגה שמופיעה בתנאי המינוי היא בדיוק מה שההחלטה אוסרת');

// ============================================================
head('ה · מוטציות · השומר נופל על חוזה שנפרד');
// ============================================================

function mutation(name, from, to, probe) {
  const mutated = RULES.split(from).join(to);
  ok('מוטציה נתפסה · ' + name,
     mutated !== RULES && !probe(mutated),
     mutated === RULES ? 'המחרוזת לא נמצאה — הבדיקה התיישנה' : '');
}

mutation('active הוסר מהכללים', "get('active', false) == true", 'true',
  (m) => /active[^;]{0,60}==\s*true/.test(bodyOf(m, /function\s+scheduleManager\s*\(/)));

mutation('הקשר ל-uid המחובר הוסר', 'request.auth.uid', 'true',
  (m) => /request\s*\.\s*auth\s*\.\s*uid/.test(bodyOf(m, /function\s+scheduleManager\s*\(/)));

// מוטציה על ההסכמה: הריצה מפסיקה להכיר את האוסף
if (grantCollection) {
  const runtimeBroken = RUNTIME.split(grantCollection).join('some_other_collection');
  ok('מוטציה נתפסה · הריצה עברה לאוסף אחר',
     runtimeBroken.indexOf(grantCollection) === -1,
     'זו בדיוק הפרידה בין הכללים לשרת שהשומר קיים בשבילה');
}

// ============================================================
console.log('\n============================================');
console.log('  שומר חוזה · עברו ' + pass + '  ·  נכשלו ' + fail);
if (fail) {
  console.log('  ' + bad.join('\n  '));
  console.log('');
  console.log('  אם נכשל בסעיף ד\' — הקוד וההכרעה נפרדו.');
  console.log('  ההכרעה רשומה בקבוע DECISION בראש הקובץ, עם מקורה.');
  console.log('  אל תעדכן אותו כדי להשתיק. תחליט, ואז עדכן.');
}
console.log('============================================');
process.exit(fail ? 1 : 0);
