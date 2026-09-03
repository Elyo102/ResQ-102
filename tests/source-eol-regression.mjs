/* ====================================================================
 *  source-eol-regression · בדיקות המקור אינן תלויות בסוף-שורה
 *
 *  ----------------------------------------------------------------
 *  מה הבדיקה הזאת מוכיחה, ולמה היא לא מסתפקת בפחות
 *  ----------------------------------------------------------------
 *
 *  ארבע מבדיקות המקור נכשלו אצל Codex ב-Windows ועברו אצלי בלינוקס.
 *  אותו קוד, אותו commit, תוצאה אחרת — כי בעץ העבודה שלו הקבצים
 *  נכתבים עם `\r\n`, ובדיקה שמחפשת `'\n}\n'` פשוט לא מוצאת דבר.
 *
 *  ⭐ קל היה „לתקן" את זה בכך שאני קורא ל-`normalizeSource` ומכריז
 *  שהבעיה נפתרה. זו הייתה טענה, לא הוכחה. בדיקה שמאמתת את פונקציית
 *  הנרמול בלבד מוכיחה שהנרמול עובד — ולא שהבדיקות עצמן עמידות.
 *
 *  לכן הבדיקה הזאת לא בודקת את `normalizeSource`. היא בונה עותק מלא
 *  של המאגר שבו **כל** קובץ מקור הומר ל-CRLF אמיתי על הדיסק, ומריצה
 *  שם את שש בדיקות המקור בתהליך נפרד. הן חייבות לצאת 0.
 *
 *  זה בדיוק המצב אצל Codex, ולא הדמיה שלו.
 *
 *  ובנוסף — שני שערים שמונעים ממנה להצליח בזול:
 *
 *   1. **הקבצים באמת CRLF.** נספרים בתי `\r` בעותק, והמספר חייב
 *      להיות גדול מאפס. עותק שנשאר LF היה גורם לבדיקה לעבור בלי
 *      לבדוק כלום.
 *   2. **הבדיקות באמת רצו.** נדרש מספר הטענות שכל probe מדווח,
 *      והוא חייב להיות זהה בשתי הריצות. probe שיצא 0 כי לא מצא
 *      דבר לבדוק אינו הצלחה.
 *
 *  יציאה: 0 עבר · 1 נכשל · 2 לא רץ.
 * ==================================================================== */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/* בדיקות המקור שחייבות להיות עמידות לסוף-שורה. */
const PROBES = [
  'schedule-policy-author-probe.mjs',
  'schedule-mode-authority-probe.mjs',
  'schedule-source-author-probe.mjs',
  'schedule-notice-text-probe.mjs',
  'schedule-hidden-authority-probe.mjs',
  'schedule-runtime-source.mjs'
];

/* המקורות שה-probes קוראים. אלה הקבצים שיומרו ל-CRLF. */
const SOURCES = [
  'functions/schedule-runtime.js',
  'functions/schedule-policy-author.js',
  'functions/schedule-mode-authority.js',
  'functions/schedule-source-author.js',
  'functions/schedule-publication.js',
  'functions/index.js',
  'schedule-management.js',
  'schedule-management.html',
  'firestore.rules'
];

/* מריץ probe ומחזיר { code, out }. אינו זורק על כשל — הכשל הוא הנתון. */
function runProbe(cwd, name) {
  try {
    const out = execFileSync(process.execPath, [join(cwd, 'tests', name)],
      { cwd: join(cwd, 'tests'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : -1,
      out: (e.stdout || '') + (e.stderr || '')
    };
  }
}

/* מחלץ את מספר הטענות מתוך פלט ה-probe. */
function assertionCount(text) {
  const m = text.match(/(\d+)\s*\/\s*\d+\s*עברו/)
    || text.match(/(\d+)\s+עברו/)
    || text.match(/^(\d+)\s+\w[\w\s-]*checks passed/m)
    || text.match(/(\d+)\s+schedule[\w\s-]*checks passed/);
  return m ? Number(m[1]) : null;
}

let work = null;
try {
  for (const name of PROBES) {
    if (!existsSync(resolve(HERE, name))) {
      console.error('NOT RUN — חסר ' + name);
      process.exit(2);
    }
  }

  /* ---------- 1 · הריצה הבסיסית, על המאגר כפי שהוא ---------- */

  const baseline = new Map();
  for (const name of PROBES) {
    const r = runProbe(ROOT, name);
    ok('1 ' + name + ' עובר על המאגר כפי שהוא', r.code === 0,
      'יצא ' + r.code);
    baseline.set(name, assertionCount(r.out));
  }

  /* ---------- 2 · עותק שבו המקור הוא CRLF אמיתי ---------- */

  work = mkdtempSync(join(tmpdir(), 'resq-eol-'));
  const copy = join(work, 'repo');
  cpSync(ROOT, copy, {
    recursive: true,
    filter: (src) => !/[\\/](\.git|node_modules|\.visual)$/.test(src)
  });

  let carriageReturns = 0;
  for (const rel of SOURCES) {
    const path = join(copy, rel);
    if (!existsSync(path)) continue;
    const lf = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    writeFileSync(path, crlf, 'utf8');
    carriageReturns += (crlf.match(/\r/g) || []).length;
  }

  // ⭐ בלי זה, עותק שנשאר LF היה גורם לכל הבדיקה לעבור בלי לבדוק דבר.
  ok('2.1 העותק באמת מכיל CRLF', carriageReturns > 10000,
    'נספרו ' + carriageReturns + ' תווי \\r');

  const sample = readFileSync(join(copy, 'functions/schedule-runtime.js'), 'utf8');
  ok('2.2 ואין בו אף \\n בודד', !/[^\r]\n/.test(sample),
    'נמצא \\n שאינו חלק מ-CRLF');

  /* ---------- 3 · אותן בדיקות, על המקור ה-CRLF ---------- */

  for (const name of PROBES) {
    const r = runProbe(copy, name);
    ok('3 ' + name + ' עובר גם על מקור CRLF', r.code === 0,
      'יצא ' + r.code + ' · ' + r.out.split('\n').filter(Boolean).slice(-3).join(' | '));

    // ⭐ והשער השני: אותו מספר טענות. probe שיצא 0 כי הפסיק לבדוק
    // אינו probe שעבר.
    const before = baseline.get(name);
    const after = assertionCount(r.out);
    ok('3.n ' + name + ' בדק אותו מספר טענות',
      before !== null && after !== null && before === after,
      'לפני ' + before + ' · אחרי ' + after);
  }
} catch (e) {
  console.error('NOT RUN — ' + e.message);
  if (work) { try { rmSync(work, { recursive: true, force: true }); } catch (_) {} }
  process.exit(2);
} finally {
  if (work) { try { rmSync(work, { recursive: true, force: true }); } catch (_) {} }
}

if (fails.length) {
  console.error('source-eol-regression · נכשל');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error('  ' + pass + ' עברו · ' + fails.length + ' נכשלו');
  process.exit(1);
}
console.log('source-eol-regression · ' + pass + '/' + pass + ' עברו');
console.log('  ' + PROBES.length + ' בדיקות מקור הורצו פעמיים: LF וגם CRLF אמיתי על הדיסק.');
console.log('  לא נבדק כאן: CR בודד בסגנון Mac היסטורי — normalizeSource מטפל בו,');
console.log('  אבל אין קובץ כזה במאגר ולא הייתי בודק מצב שאינו קיים.');
