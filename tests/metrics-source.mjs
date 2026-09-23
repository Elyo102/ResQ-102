// מדדים תפעוליים — בדיקות מקור ומוטציות.
// חלק א': הצהרות סטטיות על הקוד כפי שהוא (קטלוג קפוא של 15 קודים, ללא שדות
//          זהות בשירות, VERSIONS משותף ולא משוכפל, ללא innerHTML, ללא CRLF,
//          מוסכמות הדף, מדיניות גיבוי תקפה מול המודול האמיתי).
// חלק ב': חיווט — נבדק רק כשהוא קיים; בלי RESQ_METRICS_REQUIRE_WIRING=1 חיווט
//          חסר מודפס כ-NOT WIRED ואינו מכשיל (השכבה נמסרת ללא נגיעה בקבצים משותפים).
// חלק ג': מוטציות — עותק זמני עם פגם אחד, והוכחה שהבדיקות נופלות.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isCleanText, eolProblems } from './eol-guard.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = process.env.RESQ_REPO_ROOT ? path.resolve(process.env.RESQ_REPO_ROOT) : root;
const exists = (p) => fs.existsSync(path.join(root, p));
const locate = (p) => (exists(p) ? path.join(root, p) : path.join(repoRoot, p));
const readRaw = (p) => fs.readFileSync(locate(p), 'utf8');
const read = (p) => readRaw(p).replace(/\r\n/g, '\n');
let passed = 0, notWired = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }
function wiring(name, value) {
  if (value) { passed++; console.log('PASS ' + name); return; }
  if (process.env.RESQ_METRICS_REQUIRE_WIRING === '1') assert(value, name);
  notWired++; console.log('NOT WIRED ' + name);
}

const DELIVERED = ['functions/metrics-catalog.js', 'functions/metrics-sink.js', 'functions/metrics-service.js', 'functions/metrics-test-harness.js',
  'functions/metrics-backup-policies.js', 'functions/metrics-catalog.test.js', 'functions/metrics-service.test.js',
  'metrics-client.js', 'metrics-ui.js', 'metrics.html', 'tests/metrics-source.mjs', 'tests/metrics-browser.mjs', 'tests/metrics-client.test.mjs'];
const catalog = require(locate('functions/metrics-catalog.js'));
const telemetry = require(locate('functions/ops-telemetry-contract.js'));
const backupPolicy = require(locate('functions/backup-policy.js'));
const { METRICS_POLICIES } = require(locate('functions/metrics-backup-policies.js'));

/* ---------- חלק א' ---------- */
check('catalog is frozen with exactly 15 event codes', Object.isFrozen(catalog.EVENT_CODES) && catalog.EVENT_CODES.length === 15 && new Set(catalog.EVENT_CODES).size === 15);
check('catalog reuses ops-telemetry-contract VERSIONS and SCREENS (same objects, no fork)', catalog.VERSIONS === telemetry.VERSIONS && catalog.SCREENS === telemetry.SCREENS
  && /require\('\.\/ops-telemetry-contract'\)/.test(read('functions/metrics-catalog.js')) && !/VERSIONS\s*=\s*Object\.freeze\(\[/.test(read('functions/metrics-catalog.js') + read('functions/metrics-service.js')));
const service = read('functions/metrics-service.js'), sink = read('functions/metrics-sink.js');
check('service and sink never carry identity or free-text fields, and stored documents hold hashes only', !/\b(?:email|phone|full_name|employee_number|push_token|display_name|message_text|stack|url|name)\s*:/.test(service + sink)
  && !/req\.data\.station|input\.station|data\.stationId|token\.stationId/.test(service)
  && !/station_hash: sid|station_hash: actor\.station_id|organization_hash: organizationId\b/.test(service));
check('service takes the station from live claims via getAuthUser and rejects client station keys', /const sid = typeof live\.stationId === 'string' \? live\.stationId : '';/.test(service) && /rejectStationKeys\(req && req\.data\);/.test(service));
check('scope hashing is HMAC when keyed and sha256 otherwise, with keyed:false recorded', /createHmac\('sha256', key\)/.test(service) && /createHash\('sha256'\)/.test(service) && (service.match(/keyed: hasher\.keyed/g) || []).length >= 4);
check('no analytics vendor or network client in the metrics layer', !/analytics|googleapis|fetch\(|XMLHttpRequest|require\('https?'\)/i.test(service + sink + read('functions/metrics-catalog.js')));
check('client vocabulary equals the server catalog (codes, results, buckets)', (() => {
  const client = read('metrics-client.js');
  const codes = JSON.parse(client.match(/METRICS_EVENT_CODES = Object\.freeze\((\[[\s\S]*?\])\);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  const buckets = JSON.parse(client.match(/METRICS_DURATION_BUCKETS_MS = Object\.freeze\((\[[^\]]*\])\)/)[1]);
  return JSON.stringify(codes) === JSON.stringify([...catalog.EVENT_CODES]) && JSON.stringify(buckets) === JSON.stringify([...catalog.DURATION_BUCKETS_MS]) && /METRICS_MAX_BATCH = 20/.test(client) && /METRICS_FLUSH_MS = 10000/.test(client);
})());
check('client never reads names, tokens, errors or URLs and sends only request_id + events', (() => {
  const client = read('metrics-client.js');
  return /callable\(\{ request_id: newRequestId\(o\.random\), events \}\)/.test(client) && !/location\.|navigator\.|localStorage|\.email|\.displayName|\.uid|getIdToken|\.stack|\.message/.test(client);
})());
for (const file of ['metrics-ui.js', 'metrics.html', 'metrics-client.js']) {
  check(file + ' never assigns innerHTML/outerHTML or uses insertAdjacentHTML/document.write', !/\.(?:innerHTML|outerHTML)\s*[=+]|insertAdjacentHTML\(|document\.write\(/.test(read(file)));
}
check('ui renders "לא זמין" for unavailable metrics and never coerces null to 0', /const UNAVAILABLE = 'לא זמין';/.test(read('metrics-ui.js')) && /metric\.available !== true \|\| metric\.value === null/.test(read('metrics-ui.js')) && !/\|\|\s*0\b/.test(read('metrics-ui.js')));
check('ui labels the unkeyed hash mode as pseudonymous and reversible, never anonymous', /unkeyed: 'ללא מפתח — פסאודונים, הפיך במנייה'/.test(read('metrics-ui.js')) && !/אנונימי/.test(read('metrics-ui.js').replace(/^\s*\/\/.*$/gm, '')));
const page = read('metrics.html');
check('metrics.html follows admin.html head conventions (rtl, viewport, theme.css?v=42h32, one App Check init)', /<html lang="he" dir="rtl">/.test(page) && /<meta name="viewport"/.test(page)
  && /href="\.\/theme\.css\?v=42h32"/.test(page) && (page.match(/await initAppCheck\(app\);/g) || []).length === 1);
check('every local module import on metrics.html carries ?v=42h32', [...page.matchAll(/from '\.\/([^']+)'/g)].every((m) => /\?v=42h32$/.test(m[1])) && [...page.matchAll(/from '\.\/([^']+)'/g)].length >= 6);
check('metrics.html gates on live claims: renderNav for metrics.html, deny for non-super, renderStuckNav first', /renderNav\(claims,'metrics\.html',user\.email\|\|''\)/.test(page) && /renderStuckNav\(''\)/.test(page)
  && /if\(claims\.super!==true\)\{\$\('deny'\)\.classList\.remove\('metrics-hidden'\);return;\}/.test(page) && /onIdTokenChanged\(auth,async user=>\{\s*const mine=\+\+epoch;\s*identity=null;\s*ui\.invalidate\(\);/.test(page));
check('page calls only getMetricsDashboard through monitored-functions', /from '\.\/monitored-functions\.js\?v=42h32'/.test(page) && /call\('getMetricsDashboard', \{ days \}\)/.test(read('metrics-ui.js')) && !/recordMetrics/.test(page));
/* CRLF הוא סוף-שורה לגיטימי אחרי checkout עם core.autocrlf=true;
   CR בודד ותווי בקרה עדיין נדחים. ראו tests/eol-guard.mjs. */
check('no lone CR or control characters in any delivered file (CRLF tolerated)',
  DELIVERED.every((f) => isCleanText(readRaw(f))),
  DELIVERED.filter((f) => !isCleanText(readRaw(f))).map((f) => f + ': ' + eolProblems(readRaw(f)).join('/')).join(' | '));
check('no real employee data in fixtures (placeholder names only)', !/יונה|אלדד/.test(DELIVERED.filter((f) => f !== 'tests/metrics-source.mjs').map(read).join('\n')));
check('metrics backup policies validate together with the real DATA_POLICIES', (() => {
  const missing = METRICS_POLICIES.filter((p) => !backupPolicy.getPolicy(p.path));
  const errors = backupPolicy.validatePolicies(backupPolicy.DATA_POLICIES.concat(missing));
  if (errors.length) console.log('  policy errors: ' + errors.join('; '));
  const byPath = new Map(METRICS_POLICIES.map((p) => [p.path, p]));
  return errors.length === 0 && METRICS_POLICIES.length === 4
    && byPath.get('metrics_daily/{id}').classification === 'derived' && byPath.get('metrics_daily/{id}').backupPolicy === 'rebuild'
    && byPath.get('metrics_daily/{id}').restorePolicy === 'rebuild' && byPath.get('metrics_daily/{id}').humanReadable === 'allowed'
    && byPath.get('metrics_daily/{id}/shards/{shard}').backupPolicy === 'rebuild'
    && ['metrics_quota/{id}', 'metrics_operations/{id}'].every((p) => byPath.get(p).classification === 'temporary' && byPath.get(p).backupPolicy === 'exclude' && byPath.get(p).restorePolicy === 'do_not_restore');
})());
check('retention and caps are the mandated constants', /const RETENTION_DAYS = 90;/.test(service) && /const MAX_CALLS_PER_UID_PER_DAY = 60;/.test(service)
  && /const MAX_AGGREGATES_PER_DAY_PER_STATION = 15 \* 4;/.test(service) && /const PRUNE_BATCH = 200;/.test(service) && /const SHARD_COUNT = 8;/.test(sink) && /const MAX_EVENTS_PER_CALL = 20;/.test(service));
check('prune is exported for a future scheduled job and not wired to any schedule here', /pruneExpired/.test(service) && !/onSchedule|pubsub\.schedule/.test(service + sink));
check('METRICS-WIRING.md documents the paste snippets, cost model and TTL caveat', (() => {
  const doc = read('METRICS-WIRING.md');
  return /exports\.recordMetrics = onCall\(\{ enforceAppCheck: true \}/.test(doc) && /exports\.getMetricsDashboard = onCall\(\{ enforceAppCheck: true \}/.test(doc)
    && /RESQ_METRICS_HASH_KEY/.test(doc) && /match \/metrics_daily\/\{id\}/.test(doc) && /match \/shards\/\{shard\}/.test(doc) && /match \/metrics_quota\/\{id\}/.test(doc)
    && /match \/metrics_operations\/\{id\}/.test(doc) && /TTL/.test(doc) && /who: 'super'/.test(doc) && /metrics:test/.test(doc);
})());

/* ---------- חלק ב' — חיווט (לא נדרש למסירה) ---------- */
const index = read('functions/index.js');
for (const name of ['recordMetrics', 'getMetricsDashboard']) {
  const line = index.split('\n').find((l) => l.startsWith('exports.' + name + ' ='));
  wiring(name + ' is exported from index.js with App Check enforced', !!line && /enforceAppCheck: true/.test(line));
}
const rules = read('firestore.rules');
const closed = (name) => { const i = rules.indexOf('match /' + name); return i >= 0 && /allow read, write: if false;/.test(rules.slice(i, i + 200)); };
for (const name of ['metrics_daily/{id}', 'metrics_quota/{id}', 'metrics_operations/{id}']) wiring('firestore.rules closes ' + name + ' to clients', closed(name));
wiring('firestore.rules closes metrics_daily shards to clients', /match \/metrics_daily\/\{id\} \{[\s\S]{0,120}match \/shards\/\{shard\} \{\s*allow read, write: if false;/.test(rules));
wiring('nav.js lists metrics.html for super in the admin group', /href: 'metrics\.html'[^}]*who: 'super'[^}]*group: 'admin'/.test(read('nav.js')));
wiring('tests/package.json has a metrics:test script running all metrics tests', /"metrics:test": "[^"]*metrics-catalog\.test\.js[^"]*metrics-service\.test\.js[^"]*metrics-client\.test\.mjs[^"]*metrics-source\.mjs[^"]*metrics-browser\.mjs/.test(read('tests/package.json')));
wiring('public-assets lists metrics.html, metrics-ui.js and metrics-client.js', ['metrics.html', 'metrics-ui.js', 'metrics-client.js'].every((f) => read('tests/public-assets.json').includes('"' + f + '"')));
wiring('telemetry CALLABLES list recordMetrics and getMetricsDashboard on server and client; SCREENS list metrics.html', ['recordMetrics', 'getMetricsDashboard'].every((n) => telemetry.CALLABLES.includes(n) && read('incident-client.js').includes("'" + n + "'"))
  && telemetry.SCREENS.includes('metrics.html') && read('incident-client.js').includes("'metrics.html'"));
wiring('backup-policy.js DATA_POLICIES classify the four metrics paths', METRICS_POLICIES.every((p) => !!backupPolicy.getPolicy(p.path)));

/* ---------- חלק ג' — מוטציות ---------- */
function mutant(file, before, after) {
  const src = read(file);
  assert.equal(src.split(before).length, 2, 'mutation anchor must match exactly once: ' + before.slice(0, 60));
  return { file, src: src.replace(before, after) };
}
function runWithMutation(m, testFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-metrics-mut-'));
  fs.mkdirSync(path.join(dir, 'functions'));
  for (const base of [repoRoot, root]) {
    const fdir = path.join(base, 'functions');
    if (!fs.existsSync(fdir)) continue;
    for (const f of fs.readdirSync(fdir)) if (/\.js$/.test(f)) fs.writeFileSync(path.join(dir, 'functions', f), fs.readFileSync(path.join(fdir, f), 'utf8').replace(/\r\n/g, '\n'));
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
mustFail('quota check removed (61st call accepted)',
  mutant('functions/metrics-service.js', 'if (calls >= MAX_CALLS_PER_UID_PER_DAY) fail(', 'if (false) fail('), 'functions/metrics-service.test.js');
mustFail('event-code check removed (unknown code accepted)',
  mutant('functions/metrics-catalog.js', "if (typeof event.event_code !== 'string' || EVENT_CODES.indexOf(event.event_code) === -1) {", 'if (false) {'), 'functions/metrics-catalog.test.js');
mustFail('event-code check removed is also caught at the service level',
  mutant('functions/metrics-catalog.js', "if (typeof event.event_code !== 'string' || EVENT_CODES.indexOf(event.event_code) === -1) {", 'if (false) {'), 'functions/metrics-service.test.js');
mustFail('PII guard removed (assertNoPii not called)',
  mutant('functions/metrics-catalog.js', '  assertNoPii(event);\n  if (typeof event.event_code', '  if (typeof event.event_code'), 'functions/metrics-catalog.test.js');
mustFail('PII pattern list emptied',
  mutant('functions/metrics-catalog.js', 'if (PII_PATTERNS.some((re) => re.test(value)))', 'if (false)'), 'functions/metrics-service.test.js');
mustFail('replay detection removed (same request id counted twice)',
  mutant('functions/metrics-service.js', 'if (operation) {', 'if (false) {'), 'functions/metrics-service.test.js');
mustFail('conflict check removed (same id, different body treated as duplicate)',
  mutant('functions/metrics-service.js', "if (operation.fingerprint !== fingerprint) fail('already-exists', 'אותו מזהה בקשה כבר שימש לגוף אחר.', 'request-conflict');", ''), 'functions/metrics-service.test.js');
mustFail('scope hashing bypassed (raw id stored)',
  mutant('functions/metrics-service.js', '  function hashScope(id) {\n    const input = SCOPE_PREFIX + String(id);', '  function hashScope(id) {\n    return String(id);\n    const input = SCOPE_PREFIX + String(id);'), 'functions/metrics-service.test.js');
mustFail('keyed flag forced true without a key',
  mutant('functions/metrics-service.js', 'const keyed = key.length >= 16;', 'const keyed = true;'), 'functions/metrics-service.test.js');
mustFail('dashboard opened to non-super signed tokens',
  mutant('functions/metrics-service.js', "if (!signed.token || signed.token.super !== true) fail('permission-denied', 'לוח המדדים זמין למנהל-על בלבד.', 'super');", ''), 'functions/metrics-service.test.js');
mustFail('dashboard trusts the signed super claim without re-reading live claims',
  mutant('functions/metrics-service.js', "if (!current || current.uid !== signed.uid || current.disabled !== false || live.super !== true) {\n      fail('permission-denied', 'הרשאת מנהל-על אינה עדכנית.', 'super-stale');", "if (false) {\n      fail('permission-denied', 'הרשאת מנהל-על אינה עדכנית.', 'super-stale');"), 'functions/metrics-service.test.js');
mustFail('client station key accepted',
  mutant('functions/metrics-service.js', '    rejectStationKeys(req && req.data);\n    const current = await getAuthUser(signed.uid);\n    const live = current && plain(current.customClaims) ? current.customClaims : {};\n    if (!current || current.uid !== signed.uid || current.disabled !== false) fail', '    const current = await getAuthUser(signed.uid);\n    const live = current && plain(current.customClaims) ? current.customClaims : {};\n    if (!current || current.uid !== signed.uid || current.disabled !== false) fail'), 'functions/metrics-service.test.js');
mustFail('cardinality guard removed',
  mutant('functions/metrics-service.js', 'if (created + newKeys.length > MAX_AGGREGATES_PER_DAY_PER_STATION) {', 'if (false) {'), 'functions/metrics-service.test.js');
mustFail('duration stored raw instead of rounded up',
  mutant('functions/metrics-catalog.js', 'for (const bucket of DURATION_BUCKETS_MS) if (ms <= bucket) return bucket;', 'return Math.round(ms);'), 'functions/metrics-catalog.test.js');
mustFail('zero-denominator push rate reported as 0 instead of unavailable',
  mutant('functions/metrics-service.js', "push_success_rate: denominator === 0\n        ? metric(null, Object.assign({ reason: 'zero-denominator' }, flags(pushAsOf)))", 'push_success_rate: denominator === 0\n        ? metric(0, flags(pushAsOf))'), 'functions/metrics-service.test.js');
mustFail('active users reported as 0 instead of no-source',
  mutant('functions/metrics-service.js', "active_users_rate: metric(null, { reason: 'no-source', partial: false, stale: false, as_of_day: null })", 'active_users_rate: metric(0, { partial: false, stale: false, as_of_day: null })'), 'functions/metrics-service.test.js');
mustFail('prune batch unbounded',
  mutant('functions/metrics-service.js', 'const limit = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, PRUNE_BATCH) : PRUNE_BATCH;', 'const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : 100000;'), 'functions/metrics-service.test.js');

console.log('\nMetrics source: ' + passed + ' PASS, ' + notWired + ' NOT WIRED (static contracts + 17 mutations caught).');
