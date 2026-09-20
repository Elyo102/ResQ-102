// קליטה בקישור קבוצתי — בדיקות מקור ומוטציות.
// חלק א': הצהרות סטטיות על הקוד כפי שהוא (rules סגורים, App Check, אוצר
// הטלמטריה, SHELL, ללא innerHTML עם נתוני משתמש, ללא סוד גולמי במסמכים).
// חלק ב': מוטציות — עותק זמני של הקוד עם פגם אחד, והוכחה שהבדיקות נופלות.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows checkout עם core.autocrlf=true מייצר CRLF; העוגנים כאן משווים LF בלבד.
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }

const NEW_CALLABLES = ['createJoinCampaign', 'setJoinCampaignStatus', 'listJoinCampaigns', 'getJoinCampaignRegistrants',
  'reviewJoinRegistrant', 'inspectJoinCampaign', 'redeemJoinCampaign', 'getMyJoinStatus', 'verifyQualificationDeclaration',
  'sendReadinessTestPush', 'ackReadinessTestPush', 'getMyReadiness'];

/* ---------- חלק א' ---------- */
const index = read('functions/index.js');
for (const name of NEW_CALLABLES) {
  const line = index.split('\n').find((l) => l.startsWith('exports.' + name + ' ='));
  check(name + ' is exported with App Check enforced', !!line && /enforceAppCheck: true/.test(line));
}
const rules = read('firestore.rules');
const closed = (block) => /allow read, write: if false;/.test(block);
const section = (name) => { const i = rules.indexOf('match /' + name); assert(i >= 0, 'rules block ' + name); return rules.slice(i, i + 400); };
for (const name of ['join_campaigns/{campaignId}', 'join_registrant_index/{uid}', 'join_campaign_inspect_quota/{quotaId}', 'device_readiness/{uid}']) {
  check('rules: ' + name + ' is closed to clients', closed(section(name)));
}
check('rules: registrants subcollection is closed', /match \/registrants\/\{uid\} \{\s*allow read, write: if false;/.test(rules));
check('rules: registration_requests create still forbids role and requires pending', /match \/registration_requests\/\{uid\}[\s\S]{0,1200}status == 'pending'/.test(rules) && !/hasOnly\([^)]*'role'/.test(section('registration_requests/{uid}')));

const telemetryServer = read('functions/ops-telemetry-contract.js'), telemetryClient = read('incident-client.js');
for (const name of NEW_CALLABLES) check('telemetry vocabulary lists ' + name + ' on server and client', telemetryServer.includes("'" + name + "'") && telemetryClient.includes("'" + name + "'"));

const sw = read('firebase-messaging-sw.js');
check('service worker SHELL carries join-ui.js for the login page', /'\.\/join-ui\.js'/.test(sw));
const login = read('login.html'), admin = read('admin.html'), readinessPage = read('device-readiness.html');
check('login.html imports join-ui with the release query', login.includes("from './join-ui.js?v=42h26'"));
check('admin.html imports join-admin-ui with the release query', admin.includes("from './join-admin-ui.js?v=42h26'"));
check('device-readiness.html initializes App Check once and is RTL Hebrew', (readinessPage.match(/await initAppCheck\(app\);/g) || []).length === 1 && /<html lang="he" dir="rtl">/.test(readinessPage));
for (const file of ['join-ui.js', 'join-admin-ui.js']) {
  const src = read(file);
  check(file + ' never assigns innerHTML/outerHTML or uses insertAdjacentHTML', !/\.(?:innerHTML|outerHTML)\s*[=+]|insertAdjacentHTML\(|document\.write\(/.test(src));
}
const service = read('functions/join-campaign-service.js'), contract = read('functions/join-campaign.js');
check('campaign document stores token_hash only (no raw secret field written)', /token_hash/.test(contract) && !/\bsecret:\s*token\.secret|secret:\s*secret\b/.test(service));
check('redeem writes the invitation exactly as issued plus redemption fields', /tx\.create\(inviteRef\(candidate\.invite_id\), Object\.assign\(\{\}, candidate\.doc,\s*\{ redeemed_by: uid, redeemed_at: serverTimestamp\(\), redeemed_request_id: requestId \}\)\)/.test(service));
check('registry document keeps the exact six-key shape', /schema_version: OPERATION_SCHEMA, uid, station_id: sid, request_id: requestId,\s*invite_id: candidate\.invite_id, operation_fingerprint: split\.operation_fingerprint \}/.test(service));
check('replay is checked before campaign state', service.indexOf("if (operation) {") < service.indexOf("contract.deriveState(campaign, nowMs)"));
check('shifts are the uppercase engine vocabulary', /VALID_SHIFTS = Object\.freeze\(\['A', 'B', 'C'\]\)/.test(contract));
check('authority wrapper returns the original authority object untouched', /const authority = await onboardingInitialReader\.readForApproval\(tx, input\);[\s\S]{0,1200}return authority;\s*\}\s*\}\);/.test(index) && /initialReader: onboardingInitialReaderWithCampaignGate/.test(index));
check('authority wrapper blocks revoked campaigns inside the transaction', /campaign\.status === 'revoked'/.test(index.slice(index.indexOf('onboardingInitialReaderWithCampaignGate'), index.indexOf('onboardingInitialReaderWithCampaignGate') + 2000)));
check('readiness push bypasses only global silence, keeps the station fence', /deliveryFence\.check\(\{ stationId: actor\.sid, globalSuppressed: false \}\)/.test(read('functions/device-readiness-service.js')));
check('readiness push is data-only, type readiness_test, not important, not a callout tag', /type: TYPE,[\s\S]{0,300}important: '0'/.test(read('functions/device-readiness-service.js')) && /const TAG = 'readiness-test'/.test(read('functions/device-readiness-service.js')));
const verifyBody = service.slice(service.indexOf('async function verifyQualificationDeclaration'), service.indexOf('return Object.freeze({ createJoinCampaign,'));
check('verification writes holdings and the declaration in exactly one transaction, without the engine callable', verifyBody.split('db.runTransaction(').length === 2 && !verifyBody.includes('setPersonQualifications') && verifyBody.indexOf('tx.set(holdingsRef(') < verifyBody.indexOf('tx.update(registrantRef(campaign.campaign_id, verify.uid), patch);\n      return Object.freeze({ ok: true, uid: verify.uid, key: change.key, action: \'verify\''));
check('verification derives the station from the campaign, not from the super claim', /const sid = campaign\.station_id;/.test(verifyBody) && !/token\.stationId/.test(verifyBody));
const runtime = read('functions/schedule-runtime.js');
check('every holdings read path in the schedule engine filters expired qualifications', (runtime.match(/heldNow\(value\)/g) || []).length >= 4 && /function heldNow\(value\) \{ return qualifications\.effectiveHoldings\(value, Date\.parse\(clock\(\)\)\); \}/.test(runtime));
check('engine holdings write preserves valid_until for retained keys and reads it in the field mask', /valid_until: qualifications\.retainValidUntil\(live, next\)/.test(runtime) && runtime.includes("['qualifications', 'revision', 'valid_until']"));
const readiness = read('functions/device-readiness-service.js');
check('readiness send is idempotent: replay decision inside the transaction, nothing sent on replay', /readinessSendDecision\(device, input\.request_id/.test(readiness) && readiness.indexOf('if (decision.replay) {') < readiness.indexOf('await sendToToken('));
check('replay of a verification or a device test is bound to its intent (fingerprint / token hash), same id with other intent conflicts', /priorAudit\.intent_fingerprint !== intent/.test(verifyBody) && (verifyBody.match(/intent_fingerprint: intent/g) || []).length === 2 && /d\.token_hash !== tokenHash\) fail\('request-conflict'/.test(contract));
check('readiness actor: approved worker OR super, station only from the signed claim, live super claim required', /if \(!sid \|\| \(!isSuper && !claims\.role\)\) \{/.test(readiness) && /const sid = stationOf\(claims\);/.test(readiness) && /if \(liveClaims\.super !== true\) fail\(/.test(readiness) && !/req\.data\.station|input\.station|data\.stationId/.test(readiness));
check('readiness service never consults personal_lab_control (no lab expansion) and keeps the exact two-field input', !/personal_lab_control/.test(readiness) && /\['request_id', 'token'\]\.indexOf\(k\) === -1/.test(readiness) && /\['nonce', 'token'\]\.indexOf\(k\) === -1/.test(readiness));
check('super readiness has no qualification blockers and is approved only from live claims', /declarations: \[\], now_ms: nowMs \}\);\n    \}\n    const index/.test(readiness) && /liveClaims\.super === true && liveClaims\.stationId === sid/.test(readiness));
check('device-readiness.html admits super and still blocks users without a station or role', /if \(!SID \|\| \(!c\.role && c\.super !== true\)\) \{/.test(readinessPage));
check('no real employee data in fixtures (Hebrew placeholder names only)', !/יונה|אלדד/.test(read('functions/join-campaign-service.test.js') + read('functions/join-campaign.test.js') + read('tests/join-campaign-load.mjs')));
check('tests/package.json static script runs the new unit, service and load tests', /join-campaign\.test\.js/.test(read('tests/package.json')) && /join-campaign-service\.test\.js/.test(read('tests/package.json')) && /join-campaign-load\.mjs/.test(read('tests/package.json')) && /join-campaign-source\.mjs/.test(read('tests/package.json')));
check('tests/package.json browser script runs the new browser test', /join-campaign-browser\.mjs/.test(read('tests/package.json')));

/* ---------- חלק ב' — מוטציות ---------- */
function mutant(file, before, after) {
  const src = read(file);
  assert.equal(src.split(before).length, 2, 'mutation anchor must match exactly once: ' + before.slice(0, 60));
  return { file, src: src.replace(before, after) };
}
function runWithMutation(m, testFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-join-mut-'));
  fs.mkdirSync(path.join(dir, 'functions'));
  for (const f of fs.readdirSync(path.join(root, 'functions'))) {
    if (!/\.js$/.test(f)) continue;
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
mustFail('campaign state gate removed (paused/revoked/expired/full accepted)',
  mutant('functions/join-campaign-service.js', "if (state !== 'active') {", "if (false) {"), 'functions/join-campaign-service.test.js');
mustFail('quota counter no longer incremented',
  mutant('functions/join-campaign-service.js', 'const nextCount = campaign.accepted_count + 1;', 'const nextCount = campaign.accepted_count;'), 'functions/join-campaign-service.test.js');
mustFail('token hash comparison bypassed',
  mutant('functions/join-campaign.js', 'return a.length === b.length && deps.timingSafeEqual(a, b);', 'return true;'), 'functions/join-campaign-service.test.js');
mustFail('client-supplied assignment fields accepted',
  mutant('functions/join-campaign.js', "for (const k of REDEEM_FORBIDDEN) {", "for (const k of []) {"), 'functions/join-campaign.test.js');
mustFail('hr coordinator may create for another station',
  mutant('functions/join-campaign-service.js', "if (actor.role !== 'super' && campaign.station_id !== actor.station_id)", "if (false)"), 'functions/join-campaign-service.test.js');
mustFail('replay accepted without provenance match',
  mutant('functions/join-campaign.js', "|| !plain(prov) || prov.kind !== 'join_campaign' || prov.campaign_id !== campaign.campaign_id) return false;", ") return false;"), 'functions/join-campaign-service.test.js');
mustFail('declaration verified without the holdings write (holdings set removed from the transaction)',
  mutant('functions/join-campaign-service.js', "      tx.set(holdingsRef(sid, verify.uid), {", "      if (false) tx.set(holdingsRef(sid, verify.uid), {"), 'functions/join-campaign-service.test.js');
mustFail('holdings written but declaration left pending (registrant update removed)',
  mutant('functions/join-campaign-service.js', "      tx.update(registrantRef(campaign.campaign_id, verify.uid), patch);\n      return Object.freeze({ ok: true, uid: verify.uid, key: change.key, action: 'verify'", "      return Object.freeze({ ok: true, uid: verify.uid, key: change.key, action: 'verify'"), 'functions/join-campaign-service.test.js');
mustFail('expired holdings still counted by the engine filter',
  mutant('functions/schedule-qualifications.js', "(until[key] === undefined || until[key] > now)", "true"), 'functions/join-campaign.test.js');
mustFail('readiness replay resends a new challenge',
  mutant('functions/device-readiness-service.js', "      if (gate.replay) return gate;", "      if (false) return gate;"), 'functions/join-campaign-service.test.js');
mustFail('same request id with a different verification intent accepted as a duplicate',
  mutant('functions/join-campaign-service.js', "if (priorAudit.intent_fingerprint !== intent) fail('already-exists', 'אותו מזהה פעולה כבר שימש לכוונה אחרת.', 'request-conflict');", ""), 'functions/join-campaign-service.test.js');
mustFail('same request id with another device token accepted as a replay',
  mutant('functions/join-campaign.js', "if (d.token_hash !== tokenHash) fail('request-conflict', 'אותו מזהה פעולה כבר שימש לבדיקה במכשיר אחר.', 'already-exists');", ""), 'functions/join-campaign-service.test.js');
mustFail('rejection replay not recorded (same request id rejects a second qualification)',
  mutant('functions/join-campaign-service.js', "        tx.create(holdingsAuditRef(sid, verify.request_id), {\n          action: 'declaration_reject'", "        if (false) tx.create(holdingsAuditRef(sid, verify.request_id), {\n          action: 'declaration_reject'"), 'functions/join-campaign-service.test.js');
mustFail('unverified qualification no longer blocks readiness',
  mutant('functions/join-campaign.js', "  if (quals.pending + quals.declared > 0) blockers.push('qualifications_unverified');", ""), 'functions/join-campaign.test.js');
mustFail('readiness ack accepts a stale nonce',
  mutant('functions/join-campaign.js', "if (d.challenge_hash !== nonceHash) fail('readiness-nonce', 'קוד האישור אינו תואם לבדיקה האחרונה.');", ''), 'functions/join-campaign-service.test.js');
mustFail('super readiness ignores a revoked live super claim',
  mutant('functions/device-readiness-service.js', "      if (liveClaims.super !== true) fail(", "      if (false) fail("), 'functions/join-campaign-service.test.js');
mustFail('readiness station taken from the request token even when the live claim differs',
  mutant('functions/device-readiness-service.js', "    if (liveClaims.stationId !== sid) fail(", "    if (false) fail("), 'functions/join-campaign-service.test.js');
mustFail('readiness marks ready on provider failure',
  mutant('functions/device-readiness-service.js', "fail('unavailable', 'ספק ההתראות לא קיבל את ההודעה. נסה שוב מאוחר יותר.', 'readiness-provider');", "return Object.freeze({ ok: true, status: 'test_sent' });"), 'functions/join-campaign-service.test.js');
mustFail('lowercase shifts accepted',
  mutant('functions/join-campaign.js', "const VALID_SHIFTS = Object.freeze(['A', 'B', 'C']);", "const VALID_SHIFTS = Object.freeze(['A', 'B', 'C', 'a', 'b', 'c']);"), 'functions/join-campaign.test.js');

console.log('\nJoin campaign source: ' + passed + ' PASS (static contracts + 19 mutations caught).');
