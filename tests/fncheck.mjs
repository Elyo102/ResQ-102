// בדיקת קוד השרת.
//
// **הפער שהכלי הזה סוגר.** כל הבדיקות עד היום רצו בדפדפן מול
// Firebase מדומה. functions/index.js לא נטען שם אף פעם, ולכן
// אלפיים שורות של קוד שרת מעולם לא נבדקו בשום צורה.
//
// אלדד גילה את התוצאה: קראתי לפונקציה בשם closeAudit שלא קיימת
// — שמה sealAudit. `node --check` עובר, כי התחביר תקין; שגיאת
// ReferenceError קופצת רק בזמן ריצה.
//
// **וזה הסוג הגרוע ביותר של תקלה כאן**, כי היא בשורה האחרונה
// של הפונקציה: setSilentMode כתבה את הדגל בהצלחה ואז קרסה,
// והמסך הציג "נכשל" על פעולה שהצליחה. bulkImport היה יוצר את
// כל 28 החשבונות ומדווח כישלון.
//
// ארבע בדיקות:
//
//   1. כל פונקציה שנקראת — מוגדרת, מיובאת, או מובנית
//   2. כל exports.X הוא onCall / onSchedule / on...
//   3. אין await על פונקציה שאינה async
//   4. כל HttpsError משתמש בקוד שגיאה חוקי
//
// הרצה:  node fncheck.mjs
import fs from 'fs';
import path from 'path';

// נתיבים יחסיים למיקום הקובץ. קודם הם היו מוחלטים
// (תיקיית העבודה/...), ולכן הבדיקות רצו רק במחשב אחד.
import { fileURLToPath as __f } from 'url';
import { dirname as __d, join as __j } from 'path';
const __TESTS = __d(__f(import.meta.url));
const __APP   = __j(__TESTS, '..');



// **גם המסכים, לא רק השרת.**
//
// הבדיקה הראשונה כיסתה את functions/index.js בלבד. תוך כדי
// תיקון הבאגים שהסוכן מצא הכנסתי שני שמות שאינם קיימים —
// IS_SUPER ב-forms.html ו-MY_ROLE ב-guards.html — בדיוק אותה
// מחלקה של תקלה, בקובץ אחר. מודול בתוך <script> אינו נטען
// בשום בדיקה עד שמישהו פותח את המסך.
const ROOT = __APP;
// v41.js הוא נתונים ולא קוד — מגה של base64 שהמנתח קורא כשמות.
const DATA_ONLY = ['v41.js'];
const TARGETS = [path.join(ROOT, 'functions/index.js')]
  .concat(fs.readdirSync(ROOT)
            .filter(f => /\.(html|js)$/.test(f) && DATA_ONLY.indexOf(f) === -1)
            .map(f => path.join(ROOT, f)));

const FILE = path.join(ROOT, 'functions/index.js');
const src = fs.readFileSync(FILE, 'utf8');

let bad = 0, warn = 0;
const fail = (w, d) => { bad++; console.log('✗ ' + w + (d ? '\n    ' + d : '')); };
const caution = (w, d) => { warn++; console.log('⚠ ' + w + (d ? '\n    ' + d : '')); };
const ok = w => console.log('✓ ' + w);
const head = t => console.log('\n--- ' + t);

// הערות ומחרוזות מוסרות לפני הניתוח: שם פונקציה בתוך מחרוזת
// אינו קריאה, והתעלמות מזה מייצרת אזהרות שווא.
const code = src
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');

// ------------------------------------------------------------------
head('פונקציות');
// ------------------------------------------------------------------
{
  const defined = new Set();
  for (const m of code.matchAll(/function\s+(\w+)\s*\(/g)) defined.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) defined.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/g)) defined.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*\w+\s*=>/g)) defined.add(m[1]);
  // ייבוא: const { a, b } = require(...)
  for (const m of code.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*require/g)) {
    m[1].split(',').forEach(x => {
      const n = x.split(':').pop().trim();
      if (n) defined.add(n);
    });
  }
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*require/g)) defined.add(m[1]);
  // כל const אחר — אובייקטים, קבועים, מה שיכול להיות נקרא
  for (const m of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)) defined.add(m[1]);

  // **פרמטרים של פונקציות.**
  //
  // פרמטר שמקבל callback נקרא כמו פונקציה — matches(v) — והכלי
  // התריע עליו כאילו הוא חסר. אזהרת שווא אחת מלמדת לדלג על
  // הפלט, ואז גם האמיתית עוברת בלי שאיש שם לב.
  //
  // נאסף הכל: הצהרות רגילות, פונקציות אנונימיות, וחצים.
  for (const m of code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
    m[1].split(',').forEach(p => {
      const n = p.split('=')[0].replace(/[{}\[\].]/g, '').trim();
      if (n && /^[a-zA-Z_$][\w$]*$/.test(n)) defined.add(n);
    });
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    m[1].split(',').forEach(p => {
      const n = p.split('=')[0].replace(/[{}\[\].]/g, '').trim();
      if (n && /^[a-zA-Z_$][\w$]*$/.test(n)) defined.add(n);
    });
  }
  for (const m of code.matchAll(/(?:^|[^\w$])([a-zA-Z_$][\w$]*)\s*=>/g)) {
    defined.add(m[1]);
  }

  const BUILTIN = new Set([
    'if','for','while','switch','catch','return','typeof','function','await',
    'Array','Object','String','Number','Boolean','Date','Math','JSON','Promise',
    'Set','Map','Error','RegExp','parseInt','parseFloat','isNaN','isFinite',
    'encodeURIComponent','decodeURIComponent','require','console','setTimeout',
    'String','Symbol','BigInt','structuredClone','fetch','Buffer','process',
    // `onCall(async (req) => …)` נראה לביטוי הרגולרי כמו קריאה
    // ל-async(). מילות מפתח שיכולות להופיע לפני סוגר פותח חייבות
    // להיות ברשימה, אחרת הכלי מתריע על עצמו — וכלי שמתריע
    // לשווא הוא כלי שמפסיקים לקרוא.
    'async','await','new','delete','void','in','of','do','else','try',
    'yield','case','throw'
  ]);

  const missing = new Map();
  // קריאה: שם( שאינו אחרי נקודה, אינו מילת מפתח
  for (const m of code.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (defined.has(n) || BUILTIN.has(n)) continue;
    if (!missing.has(n)) {
      // מספר השורה בקובץ המקורי, כדי שאפשר יהיה לקפוץ לשם
      const upto = code.slice(0, m.index).split('\n').length;
      missing.set(n, upto);
    }
  }

  if (missing.size) {
    fail(missing.size + ' פונקציות נקראות ואינן מוגדרות',
      [...missing].map(([n, l]) => n + '()  — סביב שורה ' + l).join('\n    '));
  } else {
    ok(defined.size + ' שמות מוגדרים — כל קריאה מוצאת יעד');
  }
}

// ------------------------------------------------------------------
head('קבועים במסכים');
// ------------------------------------------------------------------
//
// בודק שמות ב-SCREAMING_CASE — IS_SUPER, MY_SHIFT, CAN_APPROVE.
// בקוד הזה הם תמיד משתנים מקומיים או גלובליים של המסך, ולכן
// שם כזה שאינו מוצהר בקובץ הוא **תמיד** באג ולא אף פעם ספרייה
// חיצונית. דיוק גבוה, אפס אזהרות שווא.
//
// זו בדיוק המחלקה שהכשילה אותי פעמיים בשעה האחרונה.
{
  const strip = t => t
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  const GLOBAL_OK = new Set(['JSON','Math','Date','Object','Array','String',
    'Number','Boolean','Promise','Set','Map','RegExp','Error','NaN','Infinity',
    'DOM','URL','FormData','Image','File','FileReader','Blob','Notification',
    'MAX_EDGE','MAX_BYTES','UNSET','SIDES','ROSTER','SOURCE','SKIPPED',
    'MARK','QUALS','REDLINE','SITES','ANCHORS','WIPE','KEEPS','SHOOT_ORDER',
    'APP_VERSION','APP_DATE','DEFAULT_VAPID','STATION_ID','DISTRICTS',
    'CREWS','CREW_HE','CREW_SHORT','DOWS','SEVERITIES','FAULT_KINDS',
    'FAULT_STATES','VEHICLE_KINDS','AWAY_LEVELS','BUILTIN_FORMS',
    'DAMAGE_DELETE_WHY','MIN_REST_DAYS','PW','SET','VEHICLE']);

  const problems = [];
  for (const f of TARGETS) {
    const raw = fs.readFileSync(f, 'utf8');
    // רק תוכן <script type="module"> בקבצי HTML
    let body = raw;
    if (f.endsWith('.html')) {
      const parts = [...raw.matchAll(/<script[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)];
      if (!parts.length) continue;
      body = parts.map(m => m[1]).join('\n');
    }
    const t = strip(body);

    const declared = new Set();
    for (const m of t.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/g)) declared.add(m[1]);
    // הצהרה מרובה בשורה אחת: let A = '', B = false
    for (const m of t.matchAll(/(?:const|let|var)\s+([^;\n]+)/g)) {
      for (const n of m[1].matchAll(/([A-Z][A-Z0-9_]{2,})\s*=/g)) declared.add(n[1]);
    }
    for (const m of t.matchAll(/import\s*\{([^}]+)\}/g)) {
      m[1].split(',').forEach(x => {
        const n = x.split(/\s+as\s+/).pop().trim();
        if (/^[A-Z][A-Z0-9_]{2,}$/.test(n)) declared.add(n);
      });
    }
    // import * as MSG from './x.js' — צורה שנייה, ובלעדיה
    // הכלי מתריע על מודול שלם שיובא כראוי.
    for (const m of t.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      declared.add(m[1]);
    }

    const seen = new Set();
    for (const m of t.matchAll(/(?<![.\w$'"])([A-Z][A-Z0-9_]{2,})\b/g)) {
      const n = m[1];
      if (declared.has(n) || GLOBAL_OK.has(n) || seen.has(n)) continue;
      seen.add(n);
      const line = t.slice(0, m.index).split('\n').length;
      problems.push(path.basename(f) + ' — ' + n + ' (סביב שורה ' + line + ' בסקריפט)');
    }
  }

  if (problems.length) {
    fail(problems.length + ' קבועים בשימוש ואינם מוצהרים', problems.join('\n    '));
  } else {
    ok(TARGETS.length + ' קבצים — כל קבוע בשימוש מוצהר');
  }
}

// ------------------------------------------------------------------
head('נקודות כניסה');
// ------------------------------------------------------------------
{
  const exps = [...code.matchAll(/exports\.(\w+)\s*=\s*(\w+)/g)];
  const VALID = ['onCall', 'onSchedule', 'onRequest', 'onDocumentWritten',
                 'onDocumentCreated', 'onDocumentUpdated', 'onDocumentDeleted'];
  const wrong = exps.filter(m => VALID.indexOf(m[2]) === -1);
  if (wrong.length) {
    fail('exports שאינם עטופים במעטפת פונקציה מוכרת',
         wrong.map(m => m[1] + ' = ' + m[2]).join(' · '));
  } else {
    ok(exps.length + ' פונקציות מיוצאות — כולן עטופות כראוי');
  }

  const names = exps.map(m => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) fail('שם מיוצא פעמיים — השני דורס את הראשון', dup.join(' · '));
  else ok('אין שמות כפולים');
}

// ------------------------------------------------------------------
head('await על פונקציות שאינן async');
// ------------------------------------------------------------------
{
  // await על פונקציה רגילה אינו שגיאה בג׳אווהסקריפט, אבל הוא
  // כמעט תמיד מסמן שמישהו חשב שהיא אסינכרונית — והתוצאה היא
  // ערך שנקרא לפני שנכתב.
  const asyncFns = new Set();
  for (const m of code.matchAll(/async\s+function\s+(\w+)/g)) asyncFns.add(m[1]);
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*async/g)) asyncFns.add(m[1]);

  const plain = new Set();
  for (const m of code.matchAll(/(?<!async\s)function\s+(\w+)\s*\(/g)) {
    if (!asyncFns.has(m[1])) plain.add(m[1]);
  }

  const suspect = new Set();
  for (const m of code.matchAll(/await\s+([a-zA-Z_$][\w$]*)\s*\(/g)) {
    if (plain.has(m[1])) suspect.add(m[1]);
  }
  if (suspect.size) {
    caution('await על פונקציה שאינה async', [...suspect].join(' · '));
  } else ok('כל await מופנה לפונקציה אסינכרונית');
}

// ------------------------------------------------------------------
head('קודי שגיאה');
// ------------------------------------------------------------------
{
  // קוד לא חוקי ב-HttpsError גורם לשגיאה אחרת מזו שהתכוונו
  // אליה, והמסך מציג הודעה שאינה קשורה לבעיה.
  const CODES = ['ok','cancelled','unknown','invalid-argument','deadline-exceeded',
    'not-found','already-exists','permission-denied','resource-exhausted',
    'failed-precondition','aborted','out-of-range','unimplemented','internal',
    'unavailable','data-loss','unauthenticated'];
  const used = [...src.matchAll(/new HttpsError\(\s*'([^']+)'/g)].map(m => m[1]);
  const bad2 = [...new Set(used)].filter(c => CODES.indexOf(c) === -1);
  if (bad2.length) fail('קודי שגיאה לא חוקיים', bad2.join(' · '));
  else ok(used.length + ' זריקות HttpsError — כל הקודים חוקיים');
}

console.log('\n' + '='.repeat(52));
if (bad) console.log(bad + ' כשלים · ' + warn + ' אזהרות — יש לתקן לפני פריסה');
else if (warn) console.log('בלי כשלים · ' + warn + ' אזהרות לבדיקה');
else console.log('קוד השרת עובר את כל הבדיקות הסטטיות');
console.log('='.repeat(52));
process.exit(bad ? 1 : 0);
