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
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
  'schedule-runtime-source.mjs',
  'schedule-update-guard-wiring.mjs',
  // חבילת ההקשחה: אותה תקלה בדיוק — בדיקות שקוראות קבצים כטקסט.
  // בדיקות דפדפן אינן כאן: העותק אינו מכיל node_modules, ולכן הן היו
  // נכשלות על playwright חסר ולא על סוף-שורה. הניידות שלהן נאכפת
  // סטטית ב-security-boundaries.mjs §11 (כולן עוברות דרך eol-guard).
  'saas-source.mjs',
  'metrics-source.mjs',
  'mobile-shell.mjs',
  'security-boundaries.mjs',
  'ops-disaster-restore.test.mjs',
  // security-mutations קוראת קבצים ומחפשת בהם עוגנים רב-שורתיים —
  // בדיוק סוג הבדיקה שנשבר על CRLF. היא אטית (כל מוטציה מעתיקה עץ
  // ומריצה תת-תהליך), ולכן אחרונה; שלוש הבדיקות שהיא מריצה הן node
  // טהור ואינן דורשות node_modules.
  'security-mutations.mjs'
];

/* המקורות שה-probes קוראים. ההמרה עצמה היא על כל העץ; הרשימה הזו
 * היא שער כיסוי: כל קובץ בה חייב להימצא בעותק ולהכיל CRLF בפועל. */
const SOURCES = [
  'functions/schedule-runtime.js',
  'functions/schedule-policy-author.js',
  'functions/schedule-mode-authority.js',
  'functions/schedule-source-author.js',
  'functions/schedule-publication.js',
  'functions/index.js',
  'schedule-management.js',
  'schedule-update-guard.js',
  'schedule-management.html',
  'firestore.rules',
  // הקבצים שהבדיקות החדשות קוראות כטקסט — כולל הבדיקות עצמן, כי
  // חלקן קוראות את המקור של עצמן.
  'functions/saas-contract.js',
  'functions/saas-service.js',
  'functions/saas-billing-provider.js',
  'functions/metrics-catalog.js',
  'functions/metrics-service.js',
  'functions/metrics-sink.js',
  'functions/device-readiness-service.js',
  'functions/join-campaign-service.js',
  'ops-disaster-restore.mjs',
  'ops-disaster-restore.ps1',
  'saas-admin.html',
  'saas-admin-ui.js',
  'metrics.html',
  'metrics-ui.js',
  'metrics-client.js',
  'apps/mobile/src/navigation-policy.js',
  'apps/mobile/src/push-bridge.js',
  'apps/mobile/README.md',
  'DISASTER-RECOVERY-RUNBOOK.md',
  'DR-WIRING.md',
  'SAAS-WIRING.md',
  'METRICS-WIRING.md',
  'MOBILE-WIRING.md',
  'STORE-RELEASE-CHECKLIST.md',
  'PRIVACY-DATA-MAP.md',
  'tests/saas-source.mjs',
  'tests/metrics-source.mjs',
  'tests/mobile-shell.mjs',
  'tests/security-boundaries.mjs',
  'tests/security-mutations.mjs',
  'tests/ops-disaster-restore.test.mjs',
  'tests/eol-guard.mjs'
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
    || text.match(/(\d+)\s*\/\s*\d+\s*PASS/)
    || text.match(/(\d+)\s+passed,\s*\d+\s+failed/)
    || text.match(/:\s*(\d+)\s+PASS\b/)
    || text.match(/\b(\d+)\s+PASS,\s*\d+\s+FAIL/)
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

  /* ⭐ ההמרה היא על **כל העץ**, לא על רשימה ידנית. checkout של Windows
   * ממיר כל קובץ טקסט, ורשימה שנשכח לעדכן בה קובץ מייצרת בדיוק את
   * הפער שהתגלה: קובץ שלא הומר → בדיקה שלא נבדקה. קבצים בינאריים
   * מזוהים לפי בית אפס ומדולגים, כפי ש-Git מדלג עליהם. */
  let carriageReturns = 0;
  let converted = 0;
  const convertTree = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/^(\.git|node_modules|\.visual)$/.test(entry.name)) continue;
        convertTree(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const buf = readFileSync(full);
      if (buf.includes(0)) continue;                 // בינארי — Git לא נוגע
      const lf = buf.toString('utf8').replace(/\r\n/g, '\n');
      if (!lf.includes('\n')) continue;               // שורה אחת — אין מה להמיר
      const crlf = lf.replace(/\n/g, '\r\n');
      writeFileSync(full, crlf, 'utf8');
      converted++;
      carriageReturns += (crlf.match(/\r/g) || []).length;
    }
  };
  convertTree(copy);

  /* ⭐ והשער שמונע חזרה של התקלה: כל קובץ ברשימת המקורות הידועה
   * חייב להימצא בעותק **ולהכיל CRLF בפועל**. רשימה שנשארה מאחור
   * נופלת כאן, לא אצל Codex. */
  {
    const missed = SOURCES.filter((rel) => {
      const path = join(copy, rel);
      if (!existsSync(path)) return true;
      return !readFileSync(path, 'utf8').includes('\r\n');
    });
    ok('2.0 כל קובץ מקור ידוע הומר ל-CRLF בפועל', missed.length === 0, missed.join(', '));
  }
  ok('2.0ב הומרו קבצים רבים, לא בודדים', converted > 100, 'הומרו ' + converted);

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
