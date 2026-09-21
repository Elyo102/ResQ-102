// שכבת SaaS — בדיקות מקור ומוטציות.
// חלק א': הצהרות סטטיות על הקוד כפי שהוא (מנהל-על חי, replay, גרסה צפויה,
// שער מושהה, כשל ספק, שדות מחיר, Object.create(null), ללא הפניות לזרימות
// תפעוליות, Rules סגורים במסמך החיווט, ללא CRLF/תווי בקרה/שמות אמיתיים).
// חלק ב': מוטציות — עותק זמני של הקוד עם פגם אחד, והוכחה שהבדיקות נופלות.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isCleanText, eolProblems, normalizeEol } from './eol-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* read() מנרמל סוף-שורה: כל התאמות התוכן כאן מניחות `\n`, וב-checkout
   עם core.autocrlf=true הקבצים על הדיסק הם CRLF. raw() נשאר גולמי —
   הוא משמש רק את בדיקת הבתים, שמבחינה בין CRLF ל-CR בודד. */
const raw = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const read = (p) => normalizeEol(raw(p));
let passed = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }

const FILES = ['functions/saas-contract.js', 'functions/saas-billing-provider.js', 'functions/saas-service.js', 'functions/saas-test-harness.js',
  'functions/saas-contract.test.js', 'functions/saas-service.test.js', 'saas-admin.html', 'saas-admin-ui.js', 'tests/saas-admin-browser.mjs',
  'tests/saas-source.mjs', 'rules-test/saas-isolation.test.mjs', 'SAAS-WIRING.md'];
const CALLABLES = ['createOrganization', 'attachStationToOrganization', 'changeSubscriptionPlan', 'setSubscriptionStatus', 'getOrganizationOverview', 'simulateBillingWebhook', 'listOrganizations'];
const CLOSED_PATHS = ['organizations/{organizationId}', 'subscriptions/{subscriptionId}', 'usage/{period}', 'audit/{eventId}', 'organization_station_index/{stationId}', 'saas_operations/{operationId}'];

/* ---------- חלק א' ---------- */
for (const f of FILES) {
  const src = raw(f);
  // CRLF מותר; CR בודד ותו בקרה — לא. ראו tests/eol-guard.mjs.
  check(f + ': no lone CR and no control characters (CRLF tolerated)', isCleanText(src));
}
check('no real employee names in any file (placeholders only)', FILES.filter((f) => f !== 'tests/saas-source.mjs').every((f) => !/יונה|אלדד/.test(raw(f))));
const contract = read('functions/saas-contract.js'), service = read('functions/saas-service.js'), provider = read('functions/saas-billing-provider.js');
check('contract: PLANS frozen with placeholder_not_agreed and no trial status', /placeholder_not_agreed: true/.test(contract) && /const PLANS = Object\.freeze\(/.test(contract) && /STATUSES = Object\.freeze\(\['evaluation', 'active', 'suspended', 'cancelled'\]\)/.test(contract));
check('contract: client price/amount/discount/currency/payment keys are rejected by name', /FORBIDDEN_CLIENT_KEYS = Object\.freeze\(\['amount', 'price', 'discount', 'currency', 'payment_status'/.test(contract) && /assertNoCommercialKeys\(input\);\n  if \(!exactKeys/.test(contract));
check('contract: unsafe keys rejected and Object.create(null) used for maps', /UNSAFE_KEYS = Object\.freeze\(\['__proto__', 'constructor', 'prototype'\]\)/.test(contract) && /Object\.create\(null\)/.test(contract) && /Object\.create\(null\)/.test(provider));
check('contract: webhook mapping never revives a cancelled subscription', !/'payment\.recovered': Object\.freeze\(\{ from: Object\.freeze\(\[[^\]]*'cancelled'/.test(contract) && !/'checkout\.completed': Object\.freeze\(\{ from: Object\.freeze\(\[[^\]]*'cancelled'/.test(contract));
check('contract: request id pattern is the shared 16-100 vocabulary', /REQUEST_ID_RE = \/\^\[A-Za-z0-9_-\]\{16,100\}\$\//.test(contract));
check('service: super only from the signed claim AND live claims (getAuthUser)', /token\.super !== true\) fail\('permission-denied'/.test(service) && /live\.super !== true\) \{\n      fail\('permission-denied'/.test(service) && /const current = await getAuthUser\(signed\.uid\);/.test(service));
check('service: every callable starts with superActor; addUsage does not (server-internal)', ['createOrganization', 'attachStationToOrganization', 'changeSubscriptionPlan', 'setSubscriptionStatus', 'simulateBillingWebhook', 'getOrganizationOverview', 'listOrganizations'].every((n) => new RegExp('async function ' + n + '\\(req\\) \\{\\n    (?:const actor = )?await superActor\\(req\\);').test(service)) && /async function addUsage\(params\) \{\n    \/\/[^\n]*\n    requireEnabled\(\);\n    const usage = guard/.test(service));
check('service: replay via request_id + intent_fingerprint in saas_operations; conflict on other intent', /saas_operations\/' \+ oid \+ '_' \+ rid/.test(service) && /op\.intent_fingerprint !== fingerprint\) \{\n      fail\('already-exists'/.test(service) && (service.match(/priorOperation\(tx, /g) || []).length >= 8);
check('service: revision and status transitions go through the contract inside the transaction', (service.match(/contract\.applyStatusAction\(sub, change\.action, change\.expected_revision/g) || []).length === 2 && /contract\.applyPlanChange\(sub, change\.plan_id, change\.expected_revision/.test(service));
check('service: provider failure records the code only and keeps status (unavailable/provider)', /provider_error: code, status: pre\.sub\.status \}, nowMs\);\n        await seal\(auditRow, \{ provider_error: code, status: pre\.sub\.status \}\);\n        fail\('unavailable'/.test(service) && !/provider_error: error\.message|message: error\.message/.test(service));
check('service: suspended/cancelled gate on attach and no delete anywhere', /guard\(\(\) => contract\.assertCanCreateCommercialResource\(sub\)\);/.test(service) && !/tx\.delete\(|\.delete\(\)/.test(service));
check('service: org resolved from the server index for usage; station id never picks an organization', /const index = dataOf\(await tx\.get\(indexRef\(usage\.station_id\)\)\);/.test(service) && /index\.organization_id !== oid\) fail\('failed-precondition'[^\n]*'station-owned-elsewhere'/.test(service));
check('service: bounded reads (audit 50, list 50 + cursor)', /const AUDIT_LIMIT = 50;/.test(service) && /\.limit\(AUDIT_LIMIT\)/.test(service) && /const LIST_LIMIT = 50;/.test(contract) && /startAfter\(input\.cursor\)/.test(service));
check('service: never references callout/push/schedule/login/messaging code', !/callout|messaging\(|schedule|login|push_tokens|sendToToken|claims\.role|stationId/.test(service));
check('service: webhook status from server mapping only; payload plan/limits never written', /contract\.webhookStatusFor\(event\.type, sub\.status\)/.test(service) && !/event\.plan_id|event\.limits|payload\.plan|payload\.limits/.test(service));
check('provider: only a fake implementation, constant-time signature check, failNext supported', /createFakeBillingProvider/.test(provider) && /timingSafeEqual/.test(provider) && /failNext/.test(provider) && !/https?:\/\/|fetch\(|require\('https'\)/.test(provider));
const html = read('saas-admin.html'), ui = read('saas-admin-ui.js');
check('saas-admin.html: super gate, single App Check init, release query, nav', /claims\.super !== true/.test(html) && (html.match(/await initAppCheck\(app\);/g) || []).length === 1 && /renderNav\(claims, 'saas-admin\.html'/.test(html) && html.includes("from './saas-admin-ui.js?v=42h29'"));
check('saas-admin-ui.js: no innerHTML/outerHTML/insertAdjacentHTML/document.write and no "שלם"', !/\.(?:innerHTML|outerHTML)\s*[=+]|insertAdjacentHTML\(|document\.write\(/.test(ui) && !/שלם/.test(ui) && !/שלם/.test(html));
check('saas-admin-ui.js: simulation label and no price fields sent', /SIMULATION_LABEL = 'סימולציה מקומית — לא חיוב'/.test(ui) && !/price|amount|currency|discount/.test(ui));
const wiring = read('SAAS-WIRING.md');
for (const name of CALLABLES) check('wiring: ' + name + ' exported with App Check enforced', new RegExp('exports\\.' + name + ' = onCall\\(\\{ enforceAppCheck: true').test(wiring));
for (const p of CLOSED_PATHS) check('wiring rules: ' + p + ' is closed to clients', new RegExp('match /' + p.replace(/[{}]/g, (c) => '\\' + c) + ' \\{\\s*(?://[^\\n]*\\n\\s*)*allow read, write: if false;').test(wiring));
const ALLOWED = { scope: ['root', 'station'], classification: ['source_of_truth', 'derived', 'temporary', 'secret_token', 'audit_log', 'large_media', 'monitor_state'],
  monitorPolicy: ['expected_ids_and_shape', 'required_document_shape', 'count_any_loss', 'count_drop', 'activity', 'integrity_group', 'none'],
  backupPolicy: ['managed_export', 'identity_consistency_export', 'rebuild', 'exclude', 'specialized_media_export'],
  restorePolicy: ['restore', 'restore_with_identity_reconciliation', 'rebuild', 'do_not_restore', 'restore_after_parent', 'specialized_restore'],
  sensitivity: ['operational', 'confidential', 'restricted_identity', 'secret', 'sensitive_media'], humanReadable: ['allowed', 'redacted', 'forbidden'] };
const EXPECTED_POLICIES = { 'organizations/{organizationId}': ['source_of_truth', 'managed_export', 'restore'], 'organizations/{organizationId}/subscriptions/{subscriptionId}': ['source_of_truth', 'managed_export', 'restore_after_parent'],
  'organizations/{organizationId}/usage/{period}': ['derived', 'rebuild', 'rebuild'], 'organizations/{organizationId}/audit/{eventId}': ['audit_log', 'managed_export', 'restore'],
  'organization_station_index/{stationId}': ['derived', 'rebuild', 'rebuild'], 'saas_operations/{operationId}': ['temporary', 'exclude', 'do_not_restore'] };
const policyRe = /policy\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'[^']*',\s*\{ humanReadable:'([^']+)' \}\)/g;
const found = Object.fromEntries([...wiring.matchAll(policyRe)].map((m) => [m[1], { scope: m[2], classification: m[3], monitorPolicy: m[4], backupPolicy: m[5], restorePolicy: m[6], sensitivity: m[7], humanReadable: m[9] }]));
check('wiring: backup-policy entries parse and use only the backup-policy.js vocabulary', Object.keys(EXPECTED_POLICIES).every((p) => found[p] && Object.keys(ALLOWED).every((k) => ALLOWED[k].includes(found[p][k]))));
check('wiring: backup-policy classification/backup/restore match the agreed mapping', Object.keys(EXPECTED_POLICIES).every((p) => found[p] && found[p].classification === EXPECTED_POLICIES[p][0] && found[p].backupPolicy === EXPECTED_POLICIES[p][1] && found[p].restorePolicy === EXPECTED_POLICIES[p][2]));
check('wiring: nav entry is super-only, telemetry vocabulary and package.json script listed', /who: 'super'/.test(wiring) && /saas:test/.test(wiring) && CALLABLES.every((n) => wiring.includes("'" + n + "'")));
check('rules-test: marked NOT RUN and covers two organizations, index and operations', /NOT RUN/.test(read('rules-test/saas-isolation.test.mjs')) && /organization_station_index/.test(read('rules-test/saas-isolation.test.mjs')) && /saas_operations/.test(read('rules-test/saas-isolation.test.mjs')));

/* ---------- שער fail-closed ---------- */
const serviceSrc = read('functions/saas-service.js');
check('the service is off unless enabled === true, checked strictly', /const enabled = d\.enabled === true;/.test(serviceSrc));
check('every entry point passes through requireEnabled before auth and before Firestore',
  /function requireEnabled\(\)/.test(serviceSrc) && /'saas-disabled'/.test(serviceSrc) &&
  serviceSrc.indexOf('requireEnabled();') < serviceSrc.indexOf('const signed = requireAuth(req);'));
check('the internal addUsage is gated too', (serviceSrc.match(/requireEnabled\(\);/g) || []).length >= 2);
check('the service exposes its state so the wiring can be audited', /listOrganizations, addUsage, enabled/.test(serviceSrc));
check('the admin page decides from the server answer, never from a client flag',
  /reason === 'saas-disabled'/.test(read('saas-admin.html')) && !/SAAS_ENABLED|saasEnabled/.test(read('saas-admin.html')));
check('SAAS-WIRING documents the env gate as fail-closed',
  /RESQ_SAAS_ENABLED/.test(wiring) && /fail-closed|כבוי/.test(wiring));

/* ---------- חלק ב' — מוטציות ---------- */
function mutant(file, before, after) {
  const src = read(file);
  assert.equal(src.split(before).length, 2, 'mutation anchor must match exactly once: ' + before.slice(0, 60));
  return { file, src: src.replace(before, after) };
}
function runWithMutation(m, testFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-saas-mut-'));
  fs.mkdirSync(path.join(dir, 'functions'));
  for (const f of fs.readdirSync(path.join(root, 'functions'))) {
    if (!/^saas-.*\.js$/.test(f)) continue;
    fs.writeFileSync(path.join(dir, 'functions', f), read('functions/' + f));
  }
  fs.writeFileSync(path.join(dir, m.file), m.src);
  const r = spawnSync(process.execPath, [path.join(dir, testFile)], { encoding: 'utf8', timeout: 120000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}
function mustFail(name, m, testFile) {
  const r = runWithMutation(m, testFile);
  check('mutation caught: ' + name, r.status !== 0);
}
const SERVICE_TEST = 'functions/saas-service.test.js', CONTRACT_TEST = 'functions/saas-contract.test.js';
mustFail('replay check removed (same request id executed twice)',
  mutant('functions/saas-service.js', "    if (!op) return null;\n    if (op.schema !== contract.OPERATION_SCHEMA || op.intent_fingerprint !== fingerprint) {", "    return null;\n    if (op.schema !== contract.OPERATION_SCHEMA || op.intent_fingerprint !== fingerprint) {"), SERVICE_TEST);
mustFail('different intent accepted as a replay (conflict check removed)',
  mutant('functions/saas-service.js', "if (op.schema !== contract.OPERATION_SCHEMA || op.intent_fingerprint !== fingerprint) {", "if (false) {"), SERVICE_TEST);
mustFail('expected_revision check removed',
  mutant('functions/saas-contract.js', "  if (!plain(doc) || !Number.isInteger(doc.revision) || doc.revision !== expected) {", "  if (false) {"), SERVICE_TEST);
mustFail('provider failure ignored (checkout failure still activates)',
  mutant('functions/saas-service.js', "        fail('unavailable', 'ספק החיוב אינו זמין כרגע. סטטוס המנוי לא השתנה.', 'provider');", "        providerSubscriptionId = null;"), SERVICE_TEST);
mustFail('suspended gate removed (attach allowed while suspended)',
  mutant('functions/saas-contract.js', "  if (subscription.status === 'suspended') fail('subscription-suspended', 'המנוי מושהה; אין להוסיף משאבים חדשים.');", ""), SERVICE_TEST);
mustFail('client price accepted (commercial key filter emptied)',
  mutant('functions/saas-contract.js', "    if (FORBIDDEN_CLIENT_KEYS.indexOf(k) !== -1) fail('input',", "    if (false) fail('input',"), CONTRACT_TEST);
mustFail('non-super allowed (signed super claim not required)',
  mutant('functions/saas-service.js', "    if (token.super !== true) fail('permission-denied', 'ניהול ארגונים ומנויים מותר למנהל-על בלבד.', 'saas-actor');", ""), SERVICE_TEST);
mustFail('live claims ignored (stale super accepted)',
  mutant('functions/saas-service.js', "    if (!current || current.uid !== signed.uid || current.disabled !== false || live.super !== true) {", "    if (false) {"), SERVICE_TEST);
mustFail('station index ignored (station attached to a second organization)',
  mutant('functions/saas-service.js', "      if (index && index.organization_id !== oid) fail('failed-precondition', 'התחנה כבר משויכת לארגון אחר.', 'station-owned-elsewhere');", ""), SERVICE_TEST);
mustFail('usage resolves the wrong organization (index bypassed)',
  mutant('functions/saas-service.js', "      const oid = index.organization_id;", "      const oid = 'org_a';"), SERVICE_TEST);
mustFail('webhook signature verification result ignored',
  mutant('functions/saas-service.js', "    if (!verified || verified.verified !== true || !plain(verified.event)) {", "    if (false) {"), SERVICE_TEST);
mustFail('cancelled subscription revived by webhook',
  mutant('functions/saas-contract.js', "  'payment.recovered': Object.freeze({ from: Object.freeze(['suspended']), to: 'active' }),", "  'payment.recovered': Object.freeze({ from: Object.freeze(['suspended', 'cancelled']), to: 'active' }),"), CONTRACT_TEST);
mustFail('station quota not counted on attach',
  mutant('functions/saas-service.js', "      if (!q.ok) fail('resource-exhausted', 'מכסת התחנות של התוכנית מלאה.', 'quota-exceeded');", ""), SERVICE_TEST);
mustFail('unsafe __proto__ key accepted',
  mutant('functions/saas-contract.js', "      if (UNSAFE_KEYS.indexOf(k) !== -1) fail('input',", "      if (false) fail('input',"), CONTRACT_TEST);

mustFail('the layer is enabled by a loose truthy check instead of exactly true',
  mutant('functions/saas-service.js', "const enabled = d.enabled === true;", "const enabled = d.enabled !== false;"), SERVICE_TEST);
mustFail('the disabled gate is removed from the actor path',
  mutant('functions/saas-service.js', "    requireEnabled();\n    const signed = requireAuth(req);", "    const signed = requireAuth(req);"), SERVICE_TEST);

console.log('\nSaaS source: ' + passed + ' PASS (static contracts + 16 mutations caught).');
