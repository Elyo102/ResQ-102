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
 *  היא **אינה מריצה** את `test-rules.bat`. היא בודקת את המבנה שממנו
 *  נגזר קוד היציאה, לא את קוד היציאה עצמו. הרצת Windows נשארת שער
 *  חובה נפרד, מפני שניתוח טקסט אינו יכול להוכיח התנהגות של cmd.exe.
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

const EXACT_EMULATOR_COMMAND = /^call\s+npx\s+--yes\s+firebase-tools@15\.28\.1\s+emulators:exec\s+--only\s+firestore\s+--project\s+demo-resq\s+"cd rules-test && npm test"$/i;

function analyseBatch(src) {
  const lines = src.split('\n');
  const code = lines.map((l) => {
    const t = l.trim();
    // הערות אצווה: rem, ‎::‎ — ושורות ריקות.
    if (!t || /^rem\b/i.test(t) || t.startsWith('::')) return '';
    return t;
  });

  const idxInit = code.findIndex((l) => /^set\s+RESULT\s*=\s*1$/i.test(l));
  const gotoDone = [];
  code.forEach((l, i) => { if (/^goto\s+done\b/i.test(l)) gotoDone.push(i); });

  const emuIndexes = [];
  code.forEach((l, i) => { if (EXACT_EMULATOR_COMMAND.test(l)) emuIndexes.push(i); });
  const idxEmu = emuIndexes.length === 1 ? emuIndexes[0] : -1;
  const captureIndexes = [];
  const resultAssignments = [];
  code.forEach((l, i) => {
    if (/^set\s+RESULT\s*=/i.test(l)) resultAssignments.push(i);
    if (/^set\s+RESULT\s*=\s*%errorlevel%$/i.test(l)) captureIndexes.push(i);
  });
  const idxCapture = captureIndexes.length === 1 ? captureIndexes[0] : -1;
  const idxLastPause = code.reduce((a, l, i) => (/^pause\b/i.test(l) ? i : a), -1);
  const idxExit = code.findIndex((l) => /^exit\s+\/b\s+%RESULT%/i.test(l));
  const npmCiLines = code.filter((l) => /^call\s+npm\s+ci\s+--no-audit\s+--no-fund$/i.test(l));
  const skipsLockedInstall = code.some((l) => /^if\s+not\s+exist\s+node_modules\b/i.test(l));
  const checksJava21 = code.some((l) => /^if\s+not\s+"%JAVA_MAJOR%"=="21"\s*\($/i.test(l));

  const lastCommand = (() => {
    for (let i = code.length - 1; i >= 0; i -= 1) if (code[i]) return code[i];
    return '';
  })();

  return { code, idxInit, gotoDone, emuIndexes, idxEmu, captureIndexes,
    resultAssignments, idxCapture, idxLastPause, idxExit, npmCiLines,
    skipsLockedInstall, checksJava21, lastCommand };
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
  add('יש פקודת אמולטור אחת, מלאה ומוצמדת לגרסה',
    a.emuIndexes.length === 1 && a.idxEmu !== -1,
    'נדרשת שורת call npx firebase-tools@15.28.1 עם גוף הבדיקה המדויק');
  add('errorlevel של האמולטור נלכד',
    a.idxEmu !== -1 && a.idxCapture === a.idxEmu + 1,
    'set RESULT=%errorlevel% חייב להיות הפקודה הבאה; כל פקודה מפרידה יכולה לדרוס אותו');
  add('לכידת errorlevel היא ההשמה האחרונה ל-RESULT',
    a.idxCapture !== -1 && a.resultAssignments.at(-1) === a.idxCapture,
    'אסור לאפס RESULT אחרי שהאמולטור נכשל');
  add('npm ci רץ תמיד ומול קובץ הנעילה',
    a.npmCiLines.length === 1 && !a.skipsLockedInstall,
    'node_modules קיים אינו הוכחה שהוא תואם ל-package-lock');
  add('נבדקת במפורש גרסת Java 21', a.checksJava21,
    'קיום java בלבד אינו מקיים את חוזה JDK 21');
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

const emuLines = batAnalysis.emuIndexes.map((i) => batAnalysis.code[i]);
const exactEmuLine = emuLines[0] || '__missing_emulator_command__';
ok('2.0 יש פקודת אמולטור מלאה ומדויקת', emuLines.length === 1, emuLines.length + ' שורות');
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
ok('2.4 התלויות מותקנות תמיד עם npm ci',
  batAnalysis.npmCiLines.length === 1 && !batAnalysis.skipsLockedInstall &&
  !/npm\s+install\b/.test(batCode));
ok('2.5 גרסת Firebase CLI מוצמדת לזו של CI',
  emuLines.length === 1 && /firebase-tools@15\.28\.1\b/.test(emuLines[0]));
ok('2.6 Java 21 נאכף ולא רק מוזכר', batAnalysis.checksJava21);

/* והקובץ אינו מבטיח מה שאינו נכון: ההורדה הראשונה כן יוצאת לרשת. */
ok('2.7 אין הבטחה ש„שום דבר לא יוצא לרשת"',
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

/* Hosting סורק את ה-filesystem ואינו מתחשב ב-.gitignore. לכן כל
 * sentinel נבדק גם בשורש וגם בתיקייה מקוננת. */
const sensitiveHostingPaths = [
  'secret.txt', 'nested/secret.txt',
  'firebase-adminsdk-sentinel.json', 'nested/firebase-adminsdk-sentinel.json',
  'my-service-account-key.json', 'nested/my-service-account-key.json',
  'myserviceaccount.json', 'nested/myserviceaccount.json',
  'credentials.json', 'nested/credentials.json',
  'token.json', 'nested/token.json',
  '.env', 'nested/.env', '.env.production', 'nested/.env.production',
  'private.key', 'nested/private.key', 'private.pem', 'nested/private.pem',
  '_מסירות/review.zip', 'nested/_מסירות/review.zip',
  '_מסירה-claude-42g/fix.mbox', 'nested/_מסירה-temp/fix.patch',
  'delivery.zip', 'nested/delivery.zip',
  'history.bundle', 'nested/history.bundle',
  'fix.mbox', 'nested/fix.mbox', 'fix.patch', 'nested/fix.patch',
];
for (const p of sensitiveHostingPaths) {
  ok('3.2 סוד/מסירה „' + p + '" נחסם', matchesAny(ignore, p) !== null,
    'Hosting מפרסם מה-filesystem; .gitignore אינו הגנה לפריסה');
}

/* ⭐ ובכיוון ההפוך: תבנית רחבה מדי שמפילה את האתר עצמו. */
for (const p of ['index.html', 'schedule-management.html', 'schedule-management.js',
                 'theme.css', 'version.json', 'firebase-messaging-sw.js']) {
  ok('3.3 „' + p + '" אינו נחסם', matchesAny(ignore, p) === null,
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
  ['פקודת האמולטור הוחלפה ב-echo',
   bat.replace(exactEmuLine, 'echo ' + exactEmuLine.replace(/^call\s+/i, ''))],
  ['גוף בדיקת האמולטור הוחלף',
   bat.replace('"cd rules-test && npm test"', '"echo skipped"')],
  ['RESULT אופס אחרי הכשל',
   bat.replace('set RESULT=%errorlevel%', 'set RESULT=%errorlevel%\nset RESULT=0')],
  ['פקודה מפרידה דורסת errorlevel',
   bat.replace('set RESULT=%errorlevel%', 'cd .\nset RESULT=%errorlevel%')],
  ['npm ci שוב הותנה בהיעדר node_modules',
   bat.replace('call npm ci --no-audit --no-fund',
     'if not exist node_modules call npm ci --no-audit --no-fund')],
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

const withoutSensitivePatterns = ignore.filter((p) =>
  !/(?:\.txt|adminsdk|service-account|serviceaccount|credentials\.json|token\.json|\.env|\.key|\.pem|מסיר|מסירה|\.zip|\.bundle|\.mbox|\.patch)/i.test(String(p)));
ok('4.3 בלי גדרות הסוד, sentinel אמיתי נחשף',
  matchesAny(withoutSensitivePatterns, 'credentials.json') === null &&
  matchesAny(withoutSensitivePatterns, 'nested/private.pem') === null &&
  matchesAny(withoutSensitivePatterns, '_מסירה-temp/fix.mbox') === null,
  'הבדיקה נשארה ירוקה גם אחרי הסרת גדרות הסוד/מסירה');

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

function between(src, start, end) {
  const from = src.indexOf(start);
  if (from === -1) return '';
  const to = src.indexOf(end, from + start.length);
  return src.slice(from, to === -1 ? src.length : to);
}

const expectedDeployLines = [
  'npx --yes firebase-tools@15.28.1 deploy --only firestore:rules,firestore:indexes --project station-102',
  'npx --yes firebase-tools@15.28.1 deploy --only functions --project station-102',
  'npx --yes firebase-tools@15.28.1 deploy --only hosting --project station-102',
];
const expectedEmulatorLines = [
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd rules-test && npm test"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node bulletin.integration.test.js"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && npm run test:identity"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node station-transfer.integration.test.js"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node attendance-shadow.integration.test.js"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node invitations.integration.test.js"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-runtime.integration.test.js"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-authoring.integration.test.js"',
  'npx --yes firebase-tools@15.28.1 emulators:exec --only firestore --project demo-resq "cd functions && node schedule-sheet-import.integration.test.js"',
];
const expectedInstallLines = [
  'npm ci --prefix functions',
  'npm ci --prefix tests',
  'npm ci --prefix rules-test',
  'npm --prefix tests exec -- playwright install chromium',
];
const expectedRollbackLines = [
  'npx --yes firebase-tools@15.28.1 hosting:clone ("station-102@" + $resqPrevHostingVersionId) station-102:live --project station-102',
  'npx --yes firebase-tools@15.28.1 deploy --only functions --project station-102',
  'npx --yes firebase-tools@15.28.1 deploy --only firestore:rules --project station-102',
];
const expectedApprovalLabels = [
  'הפעולה והפקודות המדויקות',
  'יעד ושירותים',
  'ה-commit או ה-diff המדויק',
  'אימות וסיכונים',
  'תוכנית חזרה לאחור',
];

const commandLines = (src, pattern) => src.split('\n')
  .map((l) => l.trim().replace(/\s+/g, ' '))
  .filter((l) => pattern.test(l));

function analyseReleaseDoc(src) {
  const setupSection = between(src, "## 0 ·", "## 1 ·");
  const gateSection = between(src, "## 1 ·", "## 2 ·");
  const deploySection = between(src, "## 2 ·", "## 3 ·");
  const rollbackSection = between(src, "## 3 ·", "## 4 ·");
  const approvalSection = between(src, "## 4 ·", "## 5 ·");
  const versionSection = between(src, "## 6 ·", "\n---");
  const deploys = commandLines(deploySection,
    /^npx\s+--yes\s+firebase-tools@15\.28\.1\s+deploy\b/);
  const emulators = commandLines(gateSection,
    /^npx\s+--yes\s+firebase-tools@15\.28\.1\s+emulators:exec\b/);
  const installs = commandLines(setupSection, /^(?:npm\s+ci\s+--prefix|npm\s+--prefix\s+tests\s+exec\b)/);
  const rollbacks = commandLines(rollbackSection,
    /^npx\s+--yes\s+firebase-tools@15\.28\.1\s+(?:hosting:clone|deploy\b)/);
  const approvalLabels = [...approvalSection.matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gm)]
    .map((m) => m[1]);
  return {
    deploys,
    emulators,
    installs,
    rollbacks,
    exactDeployOrder: JSON.stringify(deploys) === JSON.stringify(expectedDeployLines),
    exactEmulators: JSON.stringify(emulators) === JSON.stringify(expectedEmulatorLines),
    cleanWorktree: /git\s+worktree\s+add\s+--detach\b/.test(src) &&
      /git\s+status\s+--porcelain=v1\s+--untracked-files=all\b/.test(src) &&
      /git\s+rev-parse\s+HEAD\b/.test(src) &&
      /git\s+rev-parse\s+'HEAD\^\{tree\}'/.test(src) &&
      /candidate SHA is not the remote branch head/.test(src) &&
      /candidate changed during validation/.test(src),
    liveHeaderGate: /npm\s+--prefix\s+tests\s+run\s+live:headers\b/.test(deploySection),
    rootAppGate: /npm\s+--prefix\s+tests\s+run\s+all\b/.test(gateSection) &&
      !/^\s*cd\s+tests\s*$/im.test(gateSection),
    installsInsideReleaseTree: JSON.stringify(installs) === JSON.stringify(expectedInstallLines) &&
      setupSection.indexOf('Set-Location -LiteralPath $resqReleaseDir') !== -1 &&
      expectedInstallLines.every((line) => setupSection.indexOf(line) >
        setupSection.indexOf('Set-Location -LiteralPath $resqReleaseDir')),
    failClosedPowerShell: /\$ErrorActionPreference\s*=\s*'Stop'/.test(setupSection) &&
      /\$PSNativeCommandUseErrorActionPreference\s*=\s*\$true/i.test(setupSection) &&
      /function\s+Assert-ResQNative/.test(setupSection) &&
      /\[guid\]::NewGuid\(\)/i.test(setupSection),
    mergeAndPostMergeBinding: /gh\s+pr\s+merge\s+\$resqPrNumber\s+--merge\s+--match-head-commit\s+\$resqCandidateSha/.test(deploySection) &&
      /git\s+rev-parse\s+origin\/main/.test(deploySection) &&
      /\$resqMergeTree\s+-ne\s+\$resqValidatedTree/.test(deploySection) &&
      /git\s+worktree\s+add\s+--detach\s+\$resqDeployDir\s+\$resqMergeSha/.test(deploySection) &&
      /deploy HEAD is not merged origin\/main/.test(deploySection) &&
      /deploy tree is not the approved tree/.test(deploySection),
    githubCliPreflight: /\| GitHub CLI \|/.test(setupSection) &&
      /gh\s+--version[\s\S]*Assert-ResQNative\s+'GitHub CLI availability'/.test(setupSection) &&
      /gh\s+auth\s+status[\s\S]*Assert-ResQNative\s+'GitHub CLI authentication'/.test(setupSection),
    rollbackCapturedBeforeValidation:
      setupSection.indexOf('$resqRollbackSha = (git rev-parse origin/main).Trim()') !== -1 &&
      setupSection.indexOf("$resqRollbackTree = (git rev-parse ($resqRollbackSha + '^{tree}')).Trim()") !== -1 &&
      setupSection.indexOf('$resqRollbackSha =') < setupSection.indexOf('$resqRemoteCandidate =') &&
      /hosting:channel:list\s+--site\s+station-102\s+--project\s+station-102\s+--json/.test(setupSection) &&
      /\$resqPrevHostingReleaseName\s*=\s*\[string\]\$resqLiveBefore\.release\.name/.test(setupSection) &&
      /\$resqPrevHostingVersionName\s*=\s*\[string\]\$resqLiveBefore\.release\.version\.name/.test(setupSection) &&
      /release\.version\.status\s+-ne\s+'FINALIZED'/.test(setupSection),
    rollbackSetCoherent:
      /live Hosting version does not match origin\/main; rollback set is not coherent/.test(setupSection) &&
      /rollback_version\s*=\s*\$resqRollbackVersion/.test(setupSection) &&
      /hosting_release_name\s*=\s*\$resqPrevHostingReleaseName/.test(setupSection) &&
      /hosting_version_name\s*=\s*\$resqPrevHostingVersionName/.test(setupSection),
    rollbackPreparedBeforeProduction:
      /git\s+worktree\s+add\s+--detach\s+\$resqRollbackDir\s+\$resqRollbackSha/.test(gateSection) &&
      /npm\s+ci\s+--prefix\s+\(Join-Path\s+\$resqRollbackDir\s+'functions'\)/.test(gateSection) &&
      /candidate removes or mutates an existing Firestore index/.test(gateSection),
    rollbackRecheckedBeforeMerge:
      deploySection.indexOf("if ((git rev-parse origin/main).Trim() -ne $resqRollbackSha) { throw 'origin/main changed after approval; approval is void' }") !== -1 &&
      deploySection.indexOf('$resqLiveNow[0].release.name -ne $resqPrevHostingReleaseName') !== -1 &&
      deploySection.indexOf('$resqLiveNow[0].release.version.name -ne $resqPrevHostingVersionName') !== -1 &&
      deploySection.indexOf('gh pr merge $resqPrNumber') >
        deploySection.indexOf('$resqLiveNow[0].release.version.name -ne $resqPrevHostingVersionName'),
    exactRollbackOrder: JSON.stringify(rollbacks) === JSON.stringify(expectedRollbackLines),
    rollbackAttemptsAllLayers:
      /if\s*\(\$resqHostingAttempted\)[\s\S]*if\s*\(\$resqFunctionsAttempted\)[\s\S]*if\s*\(\$resqRulesAttempted\)/.test(rollbackSection) &&
      (rollbackSection.match(/\$resqRollbackFailures\.Add\(/g) || []).length >= 4,
    rollbackVerifiesLive:
      /release\.version\.name\s+-ne\s+\$resqPrevHostingVersionName/.test(rollbackSection) &&
      /Invoke-RestMethod[\s\S]*version\.json\?rollback_verify/.test(rollbackSection) &&
      /\$resqLiveRollbackVersion\.v\s+-ne\s+\$resqRollbackVersion\.v/.test(rollbackSection) &&
      /\$resqLiveRollbackVersion\.d\s+-ne\s+\$resqRollbackVersion\.d/.test(rollbackSection),
    rollbackDoesNotDeployIndexes:
      !/deploy\s+--only\s+[^\n]*firestore:indexes/.test(rollbackSection) &&
      /אין לפרוס אוטומטית/.test(rollbackSection),
    attemptsMarkedBeforeDeploy:
      deploySection.indexOf('$resqRulesAttempted = $true') < deploySection.indexOf(expectedDeployLines[0]) &&
      deploySection.indexOf('$resqFunctionsAttempted = $true') < deploySection.indexOf(expectedDeployLines[1]) &&
      deploySection.indexOf('$resqHostingAttempted = $true') < deploySection.indexOf(expectedDeployLines[2]),
    exactApprovalContract: JSON.stringify(approvalLabels.slice(0, 5)) ===
      JSON.stringify(expectedApprovalLabels),
    approvalNamesMergeAndDeploy: /מיזוג[^\n]*main/.test(approvalSection) &&
      /פריסה/.test(approvalSection),
    candidateVersionRequired: /בליטת גרסה[\s\S]*חייבת להיות בקומיט המועמד[\s\S]*לפני[\s\S]*השערים[\s\S]*האישור/.test(versionSection),
  };
}

const releaseDoc = analyseReleaseDoc(doc);

/* כל שורת פריסה במסמך — ולא רק הראשונה — חייבת לנקוב בפרויקט. */
const deployLines = releaseDoc.deploys;
ok('6.0 יש בדיוק שלוש פקודות פריסה ובסדר הבטוח', releaseDoc.exactDeployOrder,
  'נמצאו: ' + JSON.stringify(deployLines));
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

/* כל פקודות האמולטור של CI חייבות להופיע במלואן. לולאה ריקה אינה PASS. */
ok('6.3 יש בדיוק תשע פקודות אמולטור מלאות', releaseDoc.exactEmulators,
  'נמצאו: ' + JSON.stringify(releaseDoc.emulators));
for (const l of releaseDoc.emulators) {
  ok('6.3 שורת אמולטור במסמך אינה נוגעת בייצור',
    /--project\s+demo-resq\b/.test(l) && l.indexOf('station-102') === -1);
}

ok('6.4 חזרה לאחור נלכדת לפני האימות עם SHA, עץ ומזהי Hosting',
  releaseDoc.rollbackCapturedBeforeValidation);
ok('6.4א נקודת החזרה קוהרנטית ונשמרת ב-ledger מחוץ לעץ',
  releaseDoc.rollbackSetCoherent);
ok('6.4ב עץ חזרה מוכן מראש ואינדקסים קדימה אינם מוחקים קיים',
  releaseDoc.rollbackPreparedBeforeProduction);
ok('6.4ג נקודת החזרה נבדקת מחדש לפני המיזוג',
  releaseDoc.rollbackRecheckedBeforeMerge);
ok('6.4ד סדר החזרה המדויק הוא Hosting, Functions, rules',
  releaseDoc.exactRollbackOrder,
  'נמצאו: ' + JSON.stringify(releaseDoc.rollbacks));
ok('6.4ה כשל בשכבת rollback אינו מונע ניסיון בשכבות הבאות',
  releaseDoc.rollbackAttemptsAllLayers);
ok('6.4ו rollback מאמת Hosting version ואת version.json החי',
  releaseDoc.rollbackVerifiesLive);
ok('6.4ז rollback אינו מוחק או פורס מחדש אינדקסים בזמן אירוע',
  releaseDoc.rollbackDoesNotDeployIndexes);
ok('6.4ח כל שכבת Production מסומנת attempted לפני הפקודה',
  releaseDoc.attemptsMarkedBeforeDeploy);
ok('6.5 חוזה האישור כולל את חמשת שדות החובה ובסדר',
  releaseDoc.exactApprovalContract,
  'נמצאו: ' + JSON.stringify(expectedApprovalLabels));
ok('6.5א האישור נוקב גם במיזוג ל-main וגם בפריסה',
  releaseDoc.approvalNamesMergeAndDeploy);
ok('6.6 מתועדים JDK 21 ו-npm ci',
  /JDK\s*21/i.test(doc) && /npm\s+ci\b/.test(doc));
ok('6.7 ⭐ המסמך אינו טוען ש„שום דבר לא יוצא לרשת"',
  doc.indexOf('שום דבר לא יוצא') === -1 && doc.indexOf('לא יוצא לרשת') === -1);
ok('6.8 הפריסה קשורה ל-worktree נקי ול-SHA/עץ מדודים', releaseDoc.cleanWorktree);
ok('6.9 יש בדיקת כותרות חיה מיד אחרי Hosting', releaseDoc.liveHeaderGate);
ok('6.10 בליטת גרסה נדרשת בתוך המועמד ולפני השערים והאישור',
  releaseDoc.candidateVersionRequired);

const scripts = JSON.parse(readFileSync(join(ROOT, 'tests', 'package.json'), 'utf8')).scripts || {};
ok('6.11 live:headers מחווט לסקריפט החי המדויק',
  scripts['live:headers'] === 'node live-header-smoke.mjs');
const liveHeaderSmoke = read('tests/live-header-smoke.mjs');
ok('6.11א בדיקת ה-live מקובעת ל-Production ואינה ניתנת להסטה ב-env',
  /const\s+base\s*=\s*'https:\/\/station-102\.web\.app'/.test(liveHeaderSmoke) &&
  !/RESQ_LIVE_BASE|process\.env/.test(liveHeaderSmoke));
ok('6.11ב בדיקת ה-live מוגבלת בזמן',
  /AbortSignal\.timeout\(15_000\)/.test(liveHeaderSmoke));
ok('6.11ג בדיקת ה-live משווה את גוף version.json למועמד המקומי',
  /expectedVersion/.test(liveHeaderSmoke) && /liveVersion\.v\s*!==\s*expectedVersion\.v/.test(liveHeaderSmoke) &&
  /liveVersion\.d\s*!==\s*expectedVersion\.d/.test(liveHeaderSmoke));
ok('6.11א שער האפליקציה רץ משורש ה-worktree בלי לשבור cwd',
  releaseDoc.rootAppGate);
ok('6.11ב התלויות מותקנות רק אחרי הכניסה ל-worktree המבודד',
  releaseDoc.installsInsideReleaseTree);
ok('6.11ג בלוק PowerShell נכשל-סגור ומשתמש בנתיב זמני ייחודי',
  releaseDoc.failClosedPowerShell);
ok('6.11ד המיזוג קשור ל-head המאושר והפריסה לעץ origin/main הזהה',
  releaseDoc.mergeAndPostMergeBinding);
ok('6.11ה GitHub CLI נדרש ונבדק כמחובר לפני האימות',
  releaseDoc.githubCliPreflight);

/* בדיקות מוטציה למסמך: השער חייב להבחין בהשמטה ובהחלפת סדר. */
const swappedDeployDoc = doc
  .replace(expectedDeployLines[0], '__FIRST_DEPLOY__')
  .replace(expectedDeployLines[1], expectedDeployLines[0])
  .replace('__FIRST_DEPLOY__', expectedDeployLines[1]);
ok('6.12 השער מפיל סדר פריסה שהוחלף',
  !analyseReleaseDoc(swappedDeployDoc).exactDeployOrder);
ok('6.13 השער מפיל פקודת אמולטור חסרה',
  !analyseReleaseDoc(doc.replace(expectedEmulatorLines[1], '')).exactEmulators);
ok('6.14 השער מפיל בדיקת כותרות חיה חסרה',
  !analyseReleaseDoc(doc.replace('npm --prefix tests run live:headers', '')).liveHeaderGate);
ok('6.15 השער מפיל שדה חסר בחוזה האישור',
  !analyseReleaseDoc(doc.replace('**תוכנית חזרה לאחור**', '**חזרה**')).exactApprovalContract);
ok('6.16 השער מפיל cd tests ששובר את פקודות ההמשך',
  !analyseReleaseDoc(doc.replace('npm --prefix tests run all', 'cd tests\nnpm run all')).rootAppGate);
const installBeforeWorktree = doc
  .replace('npm ci --prefix functions', '__INSTALL_FUNCTIONS__')
  .replace('Set-Location -LiteralPath $resqReleaseDir',
    'npm ci --prefix functions\nSet-Location -LiteralPath $resqReleaseDir')
  .replace('__INSTALL_FUNCTIONS__', '');
ok('6.17 השער מפיל התקנת תלויות לפני הכניסה לעץ השחרור',
  !analyseReleaseDoc(installBeforeWorktree).installsInsideReleaseTree);
ok('6.18 השער מפיל ענף שאינו מאומת מול origin',
  !analyseReleaseDoc(doc.replace("if ($resqRemoteCandidate -ne $resqCandidateSha) { throw 'candidate SHA is not the remote branch head' }", '')).cleanWorktree);
ok('6.19 השער מפיל מיזוג שאינו קשור ל-head המועמד',
  !analyseReleaseDoc(doc.replace('--match-head-commit $resqCandidateSha', '')).mergeAndPostMergeBinding);
ok('6.20 השער מפיל פריסה שאינה קשורה לעץ origin/main',
  !analyseReleaseDoc(doc.replace("if ($resqMergeTree -ne $resqValidatedTree) { throw 'origin/main tree differs from the approved candidate' }", '')).mergeAndPostMergeBinding);
ok('6.21 השער מפיל capture חסר של rollback SHA',
  !analyseReleaseDoc(doc.replace('$resqRollbackSha = (git rev-parse origin/main).Trim()', '')).rollbackCapturedBeforeValidation);
ok('6.22 השער מפיל capture חסר של Hosting version',
  !analyseReleaseDoc(doc.replace('$resqPrevHostingVersionName = [string]$resqLiveBefore.release.version.name', '')).rollbackCapturedBeforeValidation);
ok('6.23 השער מפיל שינוי סדר rollback',
  !analyseReleaseDoc(doc.replace(expectedRollbackLines[0], '__ROLLBACK_HOSTING__')
    .replace(expectedRollbackLines[1], expectedRollbackLines[0])
    .replace('__ROLLBACK_HOSTING__', expectedRollbackLines[1])).exactRollbackOrder);
ok('6.24 השער מפיל clone שאינו משתמש ב-version ID',
  !analyseReleaseDoc(doc.replace('(\"station-102@\" + $resqPrevHostingVersionId)', '(\"station-102@\" + $resqPrevHostingReleaseName)')).exactRollbackOrder);
ok('6.25 השער מפיל אימות version.json חי חסר אחרי rollback',
  !analyseReleaseDoc(doc.replace('$resqLiveRollbackVersion.v -ne $resqRollbackVersion.v', '$false')).rollbackVerifiesLive);
ok('6.26 השער מפיל recheck חסר של origin/main לפני merge',
  !analyseReleaseDoc(doc.replace("if ((git rev-parse origin/main).Trim() -ne $resqRollbackSha) { throw 'origin/main changed after approval; approval is void' }", '')).rollbackRecheckedBeforeMerge);
ok('6.27 השער מפיל rollback שעוצר אחרי הכשל הראשון',
  !analyseReleaseDoc(doc.replace("} catch { $resqRollbackFailures.Add('Functions: ' + $_.Exception.Message) }", "} catch { throw }")).rollbackAttemptsAllLayers);

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
console.log('  לא נבדק כאן: הרצה בפועל של test-rules.bat. ניתוח סטטי אינו');
console.log('  הרצת Windows; קוד היציאה האמיתי נמדד בשער נפרד עם cmd.exe.');
