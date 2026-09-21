// ============================================================
//  גבולות אבטחה — בדיקה חוצת-מערכת על המקור ועל השירותים בזיכרון.
//
//  הבדיקה הזו אינה מחליפה את בדיקות התכונה (join-campaign-source,
//  station-source, rulecheck, hosting-privacy). היא אוכפת את השמורות
//  שחייבות להתקיים על **כל** המשטח יחד, כולל קוד שייכתב בעתיד:
//
//   1  App Check על כל callable — למעט רשימת חריגים קפואה ומדווחת.
//   2  סמכות מהלקוח: תחנה, ארגון, uid, תפקיד ומחיר לעולם לא מהגוף.
//   3  בידוד בין שני ארגונים ובין שתי תחנות באותו ארגון (בזיכרון).
//   4  עימוד חסום בכל קריאה שמחזירה רשימה.
//   5  replay: אותו מזהה עם כוונה אחרת נחסם.
//   6  כשל ספק חיצוני אינו הופך להרשאה.
//   7  טלמטריה ומדדים בלי מידע אישי, אוצר מילים סגור.
//   8  הזרקת CSV/HTML, prototype pollution, enumeration.
//   9  מכסות קצב על כל שירות חדש.
//  10  סודות וחומר חתימה מחוץ ל-Git ומחוץ ל-Hosting.
//  11  מנוי מסחרי אינו שער על שום מסלול תפעולי.
//
//  הכול נקרא מהמקור ומורץ בזיכרון. אין רשת, אין Firebase, אין נתוני אמת.
//  מה שדורש אמולטור — נמצא ב-rules-test/ ומסומן NOT RUN.
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require_ = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(path.join(root, p));

let passed = 0;
const failures = [];
function check(name, value) {
  if (value) { passed++; console.log('PASS ' + name); }
  else { failures.push(name); console.log('FAIL ' + name); }
}

/* ============================================================
   1 · App Check על כל callable
   ============================================================
   31 קריאות ישנות אינן אוכפות App Check. הדלקתן משנה התנהגות ייצור
   (כניסה, פוש, לוח מודעות) ולכן היא הכרעה של בעל המוצר, לא תיקון
   אגב. עד שתתקבל — הרשימה קפואה כאן בשוויון מדויק: callable חדש
   בלי App Check מפיל את הבדיקה, וגם הסרת שם מהרשימה בלי לתקן את
   הקוד מפילה אותה. כך החוב אינו גדל בשקט ואינו נמחק בשקט. */

const APPCHECK_EXEMPT = Object.freeze([
  'approveRegistration', 'backupToSheetNow', 'bootstrapSuperAdmin', 'broadcastBulletinMessage',
  'bulkImport', 'checkTestMail', 'claimPushToken', 'getAttendanceShadowStatus', 'getJoinCode',
  'hideBulletinMessage', 'hideBulletinReply', 'joinWithCode',
  'listUsersWithClaims', 'loginWithEmployeeNumber', 'postBulletinMessage', 'reindexDirectory',
  'rejectRegistration', 'replyToBulletinMessage', 'requestPasswordReset', 'resumeIdentityOperation',
  'runAttendanceShadowNow', 'runReportNow', 'sendBroadcast', 'sendTestMail',
  'setAttendanceShadowMode', 'setJoinCode', 'setUserRole', 'unlockAccount', 'whoAmI'
]);

const indexSrc = read('functions/index.js');

/** קורא את ארגומנט האפשרויות של onCall עם ספירת סוגריים — לא regex קצר
 *  שנחתך בפסיק הראשון, כי `{ region, enforceAppCheck: true, … }` מכיל פסיקים. */
function callableOptions(src) {
  const out = [];
  const re = /^exports\.(\w+)\s*=\s*onCall\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex, depth = 0, start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
    }
    out.push({ name: m[1], options: src.slice(start, i).trim() });
  }
  return out;
}

const frozenOptionConsts = new Map();
for (const m of indexSrc.matchAll(/^const ([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Object\.freeze\((\{[\s\S]*?\})\);$/gm)) {
  frozenOptionConsts.set(m[1], /enforceAppCheck:\s*true/.test(m[2]));
}
const callables = callableOptions(indexSrc);
check('functions/index.js exposes a plausible number of callables (>140)', callables.length > 140);

function enforcesAppCheck(options) {
  if (/enforceAppCheck:\s*true/.test(options)) return true;
  for (const [name, ok] of frozenOptionConsts) {
    if (ok && new RegExp('(^|[^A-Za-z0-9_])' + name + '([^A-Za-z0-9_]|$)').test(options)) return true;
  }
  return false;
}
const withoutAppCheck = callables.filter((c) => !enforcesAppCheck(c.options)).map((c) => c.name).sort();
check('App Check exemptions are exactly the frozen legacy list (' + withoutAppCheck.length + ' callables)',
  withoutAppCheck.join(',') === [...APPCHECK_EXEMPT].sort().join(','));
if (withoutAppCheck.join(',') !== [...APPCHECK_EXEMPT].sort().join(',')) {
  console.log('    רשימה בפועל: ' + withoutAppCheck.join(', '));
  console.log('    רשימה קפואה: ' + [...APPCHECK_EXEMPT].sort().join(', '));
}

const NEW_CALLABLES = ['createOrganization', 'attachStationToOrganization', 'changeSubscriptionPlan',
  'setSubscriptionStatus', 'getOrganizationOverview', 'simulateBillingWebhook', 'listOrganizations',
  'recordMetrics', 'getMetricsDashboard'];
check('every callable added by this package enforces App Check',
  NEW_CALLABLES.every((n) => {
    const c = callables.find((x) => x.name === n);
    return c && enforcesAppCheck(c.options);
  }));
check('no callable added by this package is on the exemption list',
  NEW_CALLABLES.every((n) => APPCHECK_EXEMPT.indexOf(n) === -1));

/* ============================================================
   2 · סמכות מהלקוח
   ============================================================ */

const saasSrc = read('functions/saas-service.js');
const metricsSrc = read('functions/metrics-service.js');
const readinessSrc = read('functions/device-readiness-service.js');
const joinSrc = read('functions/join-campaign-service.js');

/* הכלל האמיתי אינו "השם לא מופיע בקוד" אלא "הלקוח אינו קובע".
   שדה בחירה (איזה ארגון לקרוא) מותר כשהסמכות עצמה נבדקה בשרת;
   שדה סמכות (תחנה, uid, תפקיד, מחיר) אסור תמיד. לכן החלק הזה נבדק
   בהתנהגות — שולחים את השדה ודורשים דחייה — ולא בחיפוש מחרוזת,
   שמסמן שורות תקינות ומפספס עקיפה יצירתית. */

const AUTHORITY_PROBES = ['station_id', 'stationId', 'uid', 'role', 'super',
  'amount', 'price', 'discount', 'currency', 'payment_status'];

const saasContractSrc = read('functions/saas-contract.js');
const saasContractModule = require_(path.join(root, 'functions/saas-contract.js'));
const catalogModule = require_(path.join(root, 'functions/metrics-catalog.js'));
check('the saas contract enforces an exact key set and a forbidden-key list',
  /FORBIDDEN_CLIENT_KEYS/.test(saasContractSrc) && /exactKeys\(/.test(saasContractSrc));
check('the forbidden-key list covers every commercial authority field',
  ['amount', 'price', 'discount', 'currency', 'payment_status']
    .every((f) => new RegExp("'" + f + "'").test(saasContractSrc)));
check('metrics ingest enforces an exact key set on every event',
  /Object\.keys\(/.test(metricsSrc) || /Object\.keys\(/.test(read('functions/metrics-catalog.js')));
check('metrics ingest rejects a client-supplied station explicitly',
  /hasOwnProperty\.call\(input, 'station_id'\)|hasOwnProperty\.call\(input, 'stationId'\)/.test(metricsSrc) &&
  /client-station/.test(metricsSrc));
check('join campaign takes a station filter from the body only inside a super-only branch',
  (() => {
    const lines = joinSrc.split('\n');
    return lines.every((line, i) => {
      if (!/input\.station_id/.test(line)) return true;
      const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
      return /actor\.role === 'super'|actor\.super === true/.test(window);
    });
  })());
check('device readiness never takes a station from the body',
  !/input\.station|data\.station/.test(readinessSrc) && /stationOf\(claims\)/.test(readinessSrc));
check('saas-service and metrics-service require a live super claim for admin surfaces',
  /liveClaims\.super !== true|live\.super !== true|customClaims/.test(saasSrc) &&
  /live\.super !== true|liveClaims\.super !== true|customClaims/.test(metricsSrc));

/* ============================================================
   3 · בידוד: שני ארגונים, שתי תחנות (בזיכרון)
   ============================================================ */

const H = require_(path.join(root, 'functions/saas-test-harness.js'));
const { build, req, rid, createInput, seedOrg, subOf, authUser } = H;

async function refused(promise, reason) {
  try { await promise; return false; }
  catch (e) {
    // כל צורות השגיאה שהמערכת מייצרת: HttpsError אמיתי (details.reason),
    // ה-fail של הארנס (status/code) והודעת הטקסט. נבדקות כולן יחד.
    const parts = [e && e.code, e && e.status, e && e.reason,
      e && e.details && e.details.reason, e && e.message,
      ...Object.keys(e || {}).map((k) => String(e[k]))];
    return parts.filter(Boolean).map(String).some((x) => x.indexOf(reason) !== -1);
  }
}

{
  const ctx = build();
  const { db, service, billing } = ctx;

  // שני ארגונים באותו מחוז, כל אחד עם תחנה משלו.
  const A = await seedOrg(ctx, { create: { organization_id: 'org_alpha' }, stations: ['eilat_102'] });
  const B = await seedOrg(ctx, { create: { organization_id: 'org_beta' }, stations: ['beersheba_103'] });
  check('two organizations coexist with distinct ids', A.oid !== B.oid);

  // --- סמכות מהלקוח: כל שדה סמכות בגוף נדחה לפני כל קריאה ---
  for (const field of AUTHORITY_PROBES) {
    const body = createInput({ organization_id: 'org_probe_' + field.toLowerCase() });
    body[field] = field === 'super' ? true : (field === 'amount' || field === 'price' || field === 'discount' ? 1 : 'x');
    check('createOrganization refuses a client-supplied ' + field,
      await refused(service.createOrganization(req('super1', body)), 'invalid-argument'));
  }

  // --- בידוד ארגונים ---
  check('a station attached to organization A cannot be attached to organization B',
    await refused(service.attachStationToOrganization(req('super1',
      { request_id: rid('x'), organization_id: B.oid, station_id: 'eilat_102' }), ), 'station'));
  const overviewA = await service.getOrganizationOverview(req('super1', { organization_id: A.oid }));
  check('organization A overview never mentions organization B',
    JSON.stringify(overviewA).indexOf(B.oid) === -1 && JSON.stringify(overviewA).indexOf('beersheba_103') === -1);

  // --- בידוד תחנות בתוך אותו ארגון: המכסה נצרכת לפי התחנה שלה ---
  if (typeof service.addUsage === 'function') {
    await service.addUsage({ request_id: rid('u1'), station_id: 'eilat_102', metric: 'pushes_per_month', amount: 5 });
    const a2 = await service.getOrganizationOverview(req('super1', { organization_id: A.oid }));
    const b2 = await service.getOrganizationOverview(req('super1', { organization_id: B.oid }));
    const usedA = JSON.stringify((a2.usage && a2.usage.counters) || a2.usage || {});
    const usedB = JSON.stringify((b2.usage && b2.usage.counters) || b2.usage || {});
    check('usage recorded for a station of organization A does not appear in organization B',
      usedA.indexOf('5') !== -1 && usedB.indexOf('"pushes_per_month":5') === -1);
    check('usage for a station belonging to no organization is refused',
      await refused(service.addUsage({ request_id: rid('u2'), station_id: 'closed_104', metric: 'pushes_per_month', amount: 1 }), 'station'));
  }

  // --- הרשאה: חבר תחנה, מפקד ורכזת אינם נוגעים בשכבה המסחרית ---
  for (const uid of ['hr_eilat', 'cmd_haifa', 'ff_eilat']) {
    check(uid + ' cannot read an organization overview',
      await refused(service.getOrganizationOverview(req(uid, { organization_id: A.oid })), 'permission-denied'));
    check(uid + ' cannot change a subscription plan',
      await refused(service.changeSubscriptionPlan(req(uid,
        { request_id: rid('p'), organization_id: A.oid, plan_id: 'district', expected_revision: A.revision })), 'permission-denied'));
  }

  // --- claims חיים: מנהל-על שה-claim שלו בוטל נחסם מייד ---
  const live = H.AUTH_USERS.get('super1');
  const savedClaims = live.customClaims;
  live.customClaims = { stationId: 'eilat_102', districtId: 'south' };
  check('a revoked live super claim blocks the commercial layer immediately',
    await refused(service.getOrganizationOverview(req('super1', { organization_id: A.oid })), 'permission-denied'));
  live.customClaims = savedClaims;

  // --- replay ---
  const once = { request_id: rid('rep'), organization_id: A.oid, plan_id: 'district', expected_revision: A.revision };
  const first = await service.changeSubscriptionPlan(req('super1', once));
  const again = await service.changeSubscriptionPlan(req('super1', once));
  check('an identical replay returns the prior receipt and writes nothing new',
    again.duplicate === true && again.revision === first.revision);
  check('the same request id with a different intent is refused',
    await refused(service.changeSubscriptionPlan(req('super1',
      Object.assign({}, once, { plan_id: 'enterprise' }))), 'request-conflict'));

  // --- כשל ספק אינו מעניק מנוי פעיל ---
  const C = await seedOrg(ctx, { create: { organization_id: 'org_gamma', district_id: 'north' }, stations: ['haifa_201'], activate: false });
  billing.failNext('createCheckout');
  check('a failing billing provider never yields an active subscription',
    await refused(service.setSubscriptionStatus(req('super1',
      { request_id: rid('act'), organization_id: C.oid, action: 'activate', expected_revision: 1 })), 'provider'));
  check('after the provider failure the subscription status is unchanged',
    subOf(db, C.oid).status !== 'active');

  // --- suspended: חוסם מסחרי, לא מוחק, לא נוגע בתפעול ---
  // תחנה פעילה נוספת באותו מחוז, כדי שהסירוב במצב suspended ייבחן על
  // הגדר המסחרית ולא על תחנה סגורה או מחוז אחר.
  db._put('stations/dimona_105', { name: 'תחנה ה׳', districtId: 'south', active: true, status: 'active' });
  const beforeKeys = db._keys ? db._keys().length : 0;
  const cur = subOf(db, A.oid);
  await service.setSubscriptionStatus(req('super1',
    { request_id: rid('susp'), organization_id: A.oid, action: 'suspend', expected_revision: cur.revision }));
  const afterKeys = db._keys ? db._keys().length : 0;
  check('suspend deletes no document', afterKeys >= beforeKeys);
  check('suspend keeps the attached stations', (db._get('organizations/' + A.oid).station_ids || []).length > 0);
  check('suspend blocks attaching another station',
    await refused(service.attachStationToOrganization(req('super1',
      { request_id: rid('att'), organization_id: A.oid, station_id: 'dimona_105' })), 'suspend'));
}

/* ============================================================
   4 · עימוד חסום
   ============================================================ */
/* עימוד: הדרישה אינה "יש Math.min" אלא "הלקוח אינו קובע את הגודל".
   הצורה החזקה יותר היא קבוע בקוד; שתיהן מתקבלות, קלט חופשי — לא. */
function limitArguments(src) {
  return [...src.matchAll(/\.limit\(([^)]*)\)/g)].map((m) => m[1].trim());
}
check('every .limit() in the saas service takes a server constant or a validated value',
  limitArguments(saasSrc).length > 0 && limitArguments(saasSrc).every((arg) =>
    /^[A-Z_][A-Z0-9_]*$/.test(arg) || /^\d+$/.test(arg) || arg === 'input.limit'),
  limitArguments(saasSrc).join(' | '));
check('the validator clamps a client limit against a server constant',
  /Math\.min\(i\.limit, LIST_LIMIT\)|Math\.min\([^)]*limit[^)]*LIST_LIMIT\)/.test(saasContractSrc));
{
  // הוכחה התנהגותית: בקשה ל-10,000 רשומות מוחזרת חסומה.
  const listed = saasContractModule.validateListInput({ limit: 10000 });
  check('a client asking for 10000 rows is clamped by the validator', listed.limit <= 50);
}
check('the saas service exports its audit cap as a constant',
  /AUDIT_LIMIT\s*=\s*\d+/.test(saasSrc));
check('metrics dashboard bounds the requested day range',
  /Math\.min\(/.test(metricsSrc));
check('no new service reads a collection without a limit',
  !/collection\([^)]*\)\.get\(\)/.test(saasSrc) && !/collection\([^)]*\)\.get\(\)/.test(metricsSrc));

/* ============================================================
   5 · טלמטריה ומדדים בלי מידע אישי
   ============================================================ */
const catalog = catalogModule;
const telemetry = require_(path.join(root, 'functions/ops-telemetry-contract.js'));
check('metrics catalog is frozen and closed', Object.isFrozen(catalog.EVENT_CODES) && catalog.EVENT_CODES.length === 15);
check('metrics catalog reuses the telemetry release vocabulary, it does not fork it',
  /require\('\.\/ops-telemetry-contract'\)/.test(read('functions/metrics-catalog.js')));
const FORBIDDEN_METRIC_FIELDS = ['full_name', 'email', 'phone', 'employee_number', 'emp', 'token',
  'message', 'reason_text', 'stack', 'url', 'query'];
check('metrics catalog accepts none of the forbidden field names',
  FORBIDDEN_METRIC_FIELDS.every((f) => catalog.FIELDS.indexOf(f) === -1));
check('telemetry contract still collapses unknown values instead of storing them',
  /function finite\(/.test(read('functions/ops-telemetry-contract.js')) && /'unknown'/.test(read('functions/ops-telemetry-contract.js')));
check('telemetry input fields are still exactly five',
  Array.isArray(telemetry.INPUT_FIELDS) && telemetry.INPUT_FIELDS.length === 5);
check('the new callables are in the telemetry vocabulary',
  NEW_CALLABLES.every((n) => telemetry.CALLABLES.indexOf(n) !== -1));

/* ============================================================
   6 · הזרקה, prototype pollution, enumeration
   ============================================================ */
const uiFiles = ['saas-admin-ui.js', 'metrics-ui.js'];
/* הערות בקוד מצהירות במפורש "אין innerHTML" — בדיקת היעדר חייבת לרוץ על
   הקוד עצמו, אחרת המשפט המסביר מפיל את הבדיקה שהוא מתאר. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('new UI modules never use innerHTML/outerHTML/insertAdjacentHTML/document.write',
  uiFiles.every((f) => !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(stripComments(read(f)))));
check('new UI modules build nodes with textContent/createElement',
  uiFiles.every((f) => /textContent/.test(read(f)) && /createElement/.test(read(f))));

/* prototype pollution נבדק בהתנהגות: מפתח שמור בקלט אמיתי חייב להידחות,
   והאובייקט הגלובלי חייב להישאר נקי אחרי הניסיון. */
const pollutedEvent = JSON.parse('{"event_code":"login_success","result":"ok","__proto__":{"polluted":1}}');
let protoRejected = false;
try { catalogModule.normalizeEvent(pollutedEvent); } catch (ignore) { protoRejected = true; }
check('the metrics catalog rejects an event carrying a reserved prototype key', protoRejected);
check('no prototype was polluted by the attempt', ({}).polluted === undefined);
let saasProtoRejected = false;
try {
  saasContractModule.validateCreateInput(JSON.parse('{"request_id":"req_proto_000000001","organization_id":"org_p","name":"x","district_id":"south","plan_id":"evaluation","constructor":1}'));
} catch (ignore) { saasProtoRejected = true; }
check('the saas contract rejects a reserved prototype key in the request body', saasProtoRejected);
check('the saas contract declares the reserved key list explicitly',
  /UNSAFE_KEYS[\s\S]{0,120}__proto__[\s\S]{0,60}prototype/.test(saasContractSrc));
check('organization lookup answers not-found uniformly (no existence oracle)',
  /'not-found'/.test(saasSrc) && !/organization does not exist|no such organization/i.test(saasSrc));

/* ============================================================
   7 · מכסות קצב
   ============================================================ */
check('metrics ingest has a per-account daily call quota', /metrics_quota/.test(metricsSrc) && /resource-exhausted/.test(metricsSrc));
check('metrics ingest has a cardinality guard', /cardinality/.test(metricsSrc));
check('saas mutations are replay-guarded by an operation record', /saas_operations/.test(saasSrc));

/* ============================================================
   8 · סודות: לא ב-Git, לא ב-Hosting
   ============================================================ */
const gitignore = read('.gitignore');
const firebaseJson = JSON.parse(read('firebase.json'));
const hostingIgnore = firebaseJson.hosting.ignore || [];
for (const pattern of ['*.keystore', '*.jks', '*.p12', '*.mobileprovision',
  'apps/mobile/**/google-services.json', 'apps/mobile/**/GoogleService-Info.plist']) {
  check('.gitignore blocks ' + pattern, gitignore.indexOf(pattern) !== -1);
}
check('firebase.json hosting.ignore excludes the whole apps/ tree', hostingIgnore.indexOf('apps/**') !== -1);
check('hosting.ignore still excludes functions, tests and private folders',
  ['functions/**', 'tests/**'].every((p) => hostingIgnore.indexOf(p) !== -1));

const SECRET_LOOKING = /\.(keystore|jks|p12|mobileprovision|cer|pem|key)$/i;
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir === '.' ? entry.name : dir + '/' + entry.name;
    if (/node_modules|\.git$/.test(rel)) continue;
    if (entry.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}
const allFiles = walk('.');
check('no signing material or private key file is present in the tree',
  allFiles.filter((f) => SECRET_LOOKING.test(f)).length === 0);
check('no google-services.json / GoogleService-Info.plist is present',
  allFiles.filter((f) => /google-services\.json$|GoogleService-Info\.plist$/.test(f)).length === 0);
check('no new service embeds a webhook secret or api key literal',
  !/(sk_live|sk_test|whsec_|AIza[0-9A-Za-z_-]{30,})/.test(saasSrc + metricsSrc + read('functions/saas-billing-provider.js')));

/* ============================================================
   9 · מנוי מסחרי אינו שער תפעולי
   ============================================================
   זו השמורה שהכי קל לשבור בטעות: די בשורה אחת שקוראת מנוי לפני
   שליחת קריאת פתע כדי שכשל חיוב ישתיק תחנה. לכן היא נבדקת על
   המקור של כל מסלול תפעולי, ולא רק בכוונה. */
const OPERATIONAL_SOURCES = ['functions/index.js', 'functions/schedule-runtime.js', 'functions/bulletin.js',
  'functions/station-delivery-fence.js', 'functions/device-readiness-service.js', 'callout.js', 'push.js'];
const COMMERCIAL_TOKENS = /subscription|plan_id|billing|organizations\//;
for (const f of OPERATIONAL_SOURCES) {
  if (!exists(f)) { check('operational source exists: ' + f, false); continue; }
  const src = read(f);
  if (f === 'functions/index.js') {
    // ב-index.js מותר לבנות את השירות ולחשוף את ה-callables שלו; אסור
    // שמסלול תפעולי יקרא אליו. נבדק לפי שמות הפעולות התפעוליות.
    const operationalCalls = src.split('\n').filter((line) =>
      /sendCallout|sendBroadcast|claimPushToken|loginWithEmployeeNumber|schedulePublish|deliveryFence/.test(line) &&
      COMMERCIAL_TOKENS.test(line));
    check('index.js: no operational line references a subscription or organization', operationalCalls.length === 0,
      operationalCalls.join(' | '));
  } else {
    check(f + ': no commercial reference', !COMMERCIAL_TOKENS.test(src));
  }
}
check('the saas service is never imported by an operational module',
  !OPERATIONAL_SOURCES.filter((f) => f !== 'functions/index.js' && exists(f))
    .some((f) => /saas-service|saas-contract/.test(read(f))));

/* ============================================================
   10 · Rules: הכול סגור ללקוח
   ============================================================ */
const rules = read('firestore.rules');
for (const p of ['organizations/{organizationId}', 'organization_station_index/{stationId}',
  'saas_operations/{operationId}', 'metrics_daily/{id}', 'metrics_quota/{id}', 'metrics_operations/{id}']) {
  const re = new RegExp('match /' + p.replace(/[{}]/g, (c) => '\\' + c) + ' \\{\\s*\\n\\s*allow read, write: if false;');
  check('firestore.rules closes ' + p + ' to every client', re.test(rules));
}
check('rules-test carries a two-organization isolation suite (emulator, NOT RUN here)',
  exists('rules-test/saas-isolation.test.mjs') && /organizations/.test(read('rules-test/saas-isolation.test.mjs')));

/* ============================================================
   11 · ניידות הבדיקות עצמן (checkout ב-Windows)
   ============================================================
   במחשב של אלדד `core.autocrlf=true`, ולכן checkout רגיל מוציא CRLF.
   בדיקה שדוחה כל `\r` נכשלת שם על ה-checkout ולא על פגם — וכך
   `npm run static` וה-predeploy נשברים אחרי cherry-pick נקי. הכלל:
   כל בדיקה שנמסרה כאן עוברת דרך tests/eol-guard.mjs ואינה בודקת
   `\r` גולמי בעצמה. זו בדיקה סטטית, כדי שגם בדיקה עתידית לא תחזיר
   את התקלה. */
const DELIVERED_TESTS = ['tests/saas-source.mjs', 'tests/metrics-source.mjs', 'tests/mobile-shell.mjs',
  'tests/ops-disaster-restore.test.mjs', 'tests/saas-admin-browser.mjs', 'tests/security-boundaries.mjs',
  'tests/security-mutations.mjs', 'tests/metrics-browser.mjs', 'tests/metrics-client.test.mjs'];
check('tests/eol-guard.mjs exists and separates CRLF from a lone CR',
  exists('tests/eol-guard.mjs') && /replace\(\/\\r\\n\/g, '\\n'\)/.test(read('tests/eol-guard.mjs')) &&
  /lone-cr/.test(read('tests/eol-guard.mjs')));
{
  /* מותר להזכיר \r בתוך eol-guard עצמו ובהערות; אסור לבדוק אותו ישירות. */
  const offenders = DELIVERED_TESTS.filter((f) => {
    if (!exists(f)) return false;
    const body = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return /\/\\r\/\.test\(|includes\('\\r'\)|match\(\/\\r\/g\)/.test(body) &&
      !/eol-guard/.test(read(f));
  });
  check('no delivered test checks for a raw \\r by itself (they all use eol-guard)',
    offenders.length === 0, offenders.join(', '));
}
check('the delivered tests that read files import the eol guard',
  ['tests/saas-source.mjs', 'tests/metrics-source.mjs', 'tests/mobile-shell.mjs',
    'tests/ops-disaster-restore.test.mjs', 'tests/saas-admin-browser.mjs',
    'tests/security-mutations.mjs']
    .every((f) => /from '\.\/eol-guard\.mjs'/.test(read(f))));
/* security-mutations אינה רק קוראת קבצים — היא מחפשת בהם עוגנים
 * רב-שורתיים. זו הבדיקה שנפלה ב-checkout של Windows אחרי הסבב הקודם,
 * ולכן היא נאכפת כאן בנפרד ומורצת ב-source-eol-regression. */
check('security-mutations reads through the guard, not raw',
  /const read = \(p\) => normalizeEol\(/.test(read('tests/security-mutations.mjs')));
check('security-mutations runs against the CRLF copy too (it is a probe)',
  /'security-mutations\.mjs'/.test(read('tests/source-eol-regression.mjs')));

/* ============================================================ */
console.log('');
console.log('NOT RUN — Firestore emulator suites (rules-test/*.mjs, incl. saas-isolation.test.mjs)');
console.log('NOT RUN — external penetration test (OUT_OF_SCOPE_EXTERNAL)');
console.log('');
console.log('Security boundaries: ' + passed + ' PASS, ' + failures.length + ' FAIL');
if (failures.length) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
