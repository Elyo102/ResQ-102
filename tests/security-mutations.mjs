// ============================================================
//  מוטציות אבטחה — האם ההגנות באמת תופסות?
//
//  בדיקה ירוקה על קוד תקין אינה מוכיחה דבר: גם בדיקה ריקה ירוקה.
//  כאן שוברים את ההגנה במקור, מריצים את חבילת הבדיקות המתאימה
//  בעותק זמני, ודורשים שהיא **תיפול**. מוטציה שלא נתפסה היא הודעה
//  שהבדיקה שמירה עליה אינה קיימת בפועל.
//
//  אין כתיבה למאגר: כל מוטציה חיה בתיקייה זמנית שנמחקת מיד.
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeEol } from './eol-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
/* מנורמל: עוגני המוטציה כתובים ב-LF, ובcheckout עם core.autocrlf=true
 * הקובץ על הדיסק הוא CRLF. בלי הנרמול כל עוגן רב-שורתי אינו נמצא,
 * והבדיקה נופלת על ה-checkout ולא על פגם. הכתיבה לעותק הזמני היא
 * ממילא של הטקסט המנורמל, וזה בסדר: הבדיקה שרצה עליו קוראת דרך
 * eol-guard גם היא. */
const read = (p) => normalizeEol(fs.readFileSync(path.join(root, p), 'utf8'));

let passed = 0;
const failures = [];
function check(name, value, detail) {
  if (value) { passed++; console.log('PASS ' + name); }
  else { failures.push(name); console.log('FAIL ' + name + (detail ? '   ' + detail : '')); }
}

/** בונה עותק זמני של העץ הדרוש להרצה, עם קובץ אחד מוחלף. */
function mutate(file, before, after) {
  const src = read(file);
  const count = src.split(before).length - 1;
  if (count !== 1) throw new Error('mutation anchor must match exactly once (' + count + '): ' + before.slice(0, 70));
  return { file, src: src.replace(before, after) };
}

const COPY_DIRS = ['functions', 'tests', 'rules-test'];
const COPY_ROOT_FILES = ['firestore.rules', 'firebase.json', '.gitignore', 'nav.js',
  'saas-admin-ui.js', 'metrics-ui.js', 'metrics-client.js', 'incident-client.js',
  'saas-admin.html', 'metrics.html', 'apps'];

function copyInto(dir) {
  for (const d of COPY_DIRS) {
    const from = path.join(root, d);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, d), { recursive: true, dereference: false,
      filter: (src) => !/node_modules/.test(src) });
  }
  for (const f of COPY_ROOT_FILES) {
    const from = path.join(root, f);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, f), { recursive: true });
  }
  // playwright ושאר התלויות נשארות במקורן; רק קישור.
  const tnm = path.join(root, 'tests', 'node_modules');
  if (fs.existsSync(tnm)) {
    try { fs.symlinkSync(fs.realpathSync(tnm), path.join(dir, 'tests', 'node_modules'), 'dir'); } catch (ignore) {}
  }
  const fnm = path.join(root, 'functions', 'node_modules');
  if (fs.existsSync(fnm)) {
    try { fs.symlinkSync(fs.realpathSync(fnm), path.join(dir, 'functions', 'node_modules'), 'dir'); } catch (ignore) {}
  }
}

function runWithMutation(m, testFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-sec-mut-'));
  try {
    copyInto(dir);
    fs.writeFileSync(path.join(dir, m.file), m.src);
    return spawnSync(process.execPath, [path.join(dir, testFile)],
      { encoding: 'utf8', timeout: 180000, cwd: path.join(dir, 'tests') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mustFail(name, m, testFile) {
  let r;
  try { r = runWithMutation(m, testFile); }
  catch (e) { check('mutation caught: ' + name, false, String(e.message)); return; }
  check('mutation caught: ' + name, r.status !== 0,
    r.status === 0 ? 'the suite stayed green — that guard is unproven' : '');
}

const SEC = 'tests/security-boundaries.mjs';

/* ---------- 1 · App Check ---------- */
mustFail('a new callable without App Check slips in',
  mutate('functions/index.js',
    "exports.listOrganizations = onCall({ enforceAppCheck: true }, req => saasService.listOrganizations(req));",
    "exports.listOrganizations = onCall({}, req => saasService.listOrganizations(req));"),
  SEC);

mustFail('an exempt legacy callable is quietly dropped from the frozen list',
  mutate('tests/security-boundaries.mjs', "  'listUsersWithClaims', 'loginWithEmployeeNumber',", "  'listUsersWithClaims',"),
  SEC);

/* ---------- 2 · סמכות מהלקוח ---------- */
mustFail('the commercial forbidden-key list stops rejecting a client price',
  mutate('functions/saas-contract.js',
    "    if (FORBIDDEN_CLIENT_KEYS.indexOf(k) !== -1) fail('input', 'השדה ' + k + ' נקבע בשרת ואינו מתקבל מהלקוח.', 'invalid-argument');",
    "    if (false) fail('input', 'השדה ' + k + ' נקבע בשרת ואינו מתקבל מהלקוח.', 'invalid-argument');"),
  SEC);

mustFail('metrics ingest starts accepting a client-supplied station',
  mutate('functions/metrics-service.js',
    "      fail('invalid-argument', 'התחנה נקבעת לפי ההרשאות של החשבון ואינה נשלחת מהלקוח.', 'client-station');",
    "      void 0;"),
  SEC);

/* ---------- 3 · הרשאות והרשאה חיה ---------- */
mustFail('a non-super reaches the commercial layer (signed claim check removed)',
  mutate('functions/saas-service.js',
    "    if (token.super !== true) fail('permission-denied', 'ניהול ארגונים ומנויים מותר למנהל-על בלבד.', 'saas-actor');",
    "    if (false) fail('permission-denied', 'ניהול ארגונים ומנויים מותר למנהל-על בלבד.', 'saas-actor');"),
  SEC);

mustFail('a revoked live super claim still passes (live re-read removed)',
  mutate('functions/saas-service.js',
    "if (!current || current.uid !== signed.uid || current.disabled !== false || live.super !== true) {",
    "if (false) {"),
  SEC);

/* ---------- 4 · בידוד ארגונים ---------- */
mustFail('a station can be attached to a second organization',
  mutate('functions/saas-service.js',
    "      if (index && index.organization_id !== oid) fail('failed-precondition', 'התחנה כבר משויכת לארגון אחר.', 'station-owned-elsewhere');",
    "      if (false) fail('failed-precondition', 'התחנה כבר משויכת לארגון אחר.', 'station-owned-elsewhere');"),
  'functions/saas-service.test.js');

/* ---------- 5 · replay ---------- */
mustFail('replay stops being intent-bound',
  mutate('functions/saas-service.js',
    "      fail('already-exists', 'אותו מזהה פעולה כבר שימש לכוונה אחרת.', 'request-conflict');",
    "      void 0;"),
  'functions/saas-service.test.js');

/* ---------- 6 · ספק חיוב ---------- */
mustFail('a provider failure is treated as success',
  mutate('functions/saas-billing-provider.js',
    "    if (n > 0) { failures[method] = n - 1; throw new BillingProviderError('provider_' + method + '_failed'); }",
    "    if (n > 0) { failures[method] = n - 1; }"),
  'functions/saas-service.test.js');

/* ---------- 7 · מכסות ---------- */
mustFail('the metrics per-account quota is removed',
  mutate('functions/metrics-service.js',
    "      if (calls >= MAX_CALLS_PER_UID_PER_DAY) fail('resource-exhausted', 'מכסת הדיווח היומית של החשבון הושגה.', 'metrics-quota');",
    "      void 0;"),
  'functions/metrics-service.test.js');

mustFail('the metrics cardinality guard is removed',
  mutate('functions/metrics-service.js',
    "        fail('resource-exhausted', 'מספר הצבירות היומי לתחנה חרג מהמותר.', 'metrics-cardinality');",
    "        void 0;"),
  'functions/metrics-service.test.js');

/* ---------- 8 · קטלוג סגור ומידע אישי ---------- */
mustFail('the metrics catalog accepts a field outside the catalog',
  mutate('functions/metrics-catalog.js',
    "  if (keys.some((k) => FIELDS.indexOf(k) === -1)) throw new MetricsCatalogError('input', 'מאורע מכיל שדה שאינו בקטלוג.');",
    "  if (false) throw new MetricsCatalogError('input', 'מאורע מכיל שדה שאינו בקטלוג.');"),
  SEC);

/* ---------- 9 · Rules ---------- */
mustFail('an organization document becomes readable by the browser',
  mutate('firestore.rules',
    "    match /organizations/{organizationId} {\n      allow read, write: if false;",
    "    match /organizations/{organizationId} {\n      allow read: if isSuper();\n      allow write: if false;"),
  SEC);

mustFail('the metrics aggregates become readable by the browser',
  mutate('firestore.rules',
    "    match /metrics_daily/{id} {\n      allow read, write: if false;",
    "    match /metrics_daily/{id} {\n      allow read: if signedIn();\n      allow write: if false;"),
  SEC);

/* ---------- 10 · סודות ---------- */
mustFail('the store shell stops being excluded from Hosting',
  mutate('firebase.json', '"apps/**",', '"apps/_never_matches/**",'),
  SEC);

mustFail('signing material stops being git-ignored',
  mutate('.gitignore', '*.keystore', '*.keystore-disabled'),
  SEC);

/* ---------- 11 · מנוי אינו שער תפעולי ---------- */
mustFail('an operational path starts consulting the subscription',
  mutate('functions/station-delivery-fence.js',
    'function createStationDeliveryFence({ db, legacyStationIds = DEFAULT_LEGACY_IDS } = {}) {',
    'function createStationDeliveryFence({ db, legacyStationIds = DEFAULT_LEGACY_IDS } = {}) {\n  const subscription = db.doc(\'organizations/x\'); // gate added by mutation'),
  SEC);

/* ---------- 12 · ממשק ---------- */
mustFail('the admin screen starts writing raw HTML',
  mutate('saas-admin-ui.js',
    "export const PLAN_HE = Object.freeze({ evaluation: 'הערכה', station: 'תחנה', district: 'מחוז', enterprise: 'ארגוני' });",
    "export const PLAN_HE = Object.freeze({ evaluation: 'הערכה', station: 'תחנה', district: 'מחוז', enterprise: 'ארגוני' });\nfunction __rawHtml(el, s) { el.innerHTML = s; }"),
  SEC);

console.log('');
console.log('Security mutations: ' + passed + ' PASS, ' + failures.length + ' FAIL');
if (failures.length) { failures.forEach((f) => console.log('  UNPROVEN: ' + f)); process.exit(1); }
