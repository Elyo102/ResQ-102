// עלות ושימוש — בדיקות מקור וחיווט ממוקדות.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isCleanText } from './eol-guard.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
function check(name, value) { assert(value, name); passed++; console.log('PASS ' + name); }

const telemetry = require(path.join(root, 'functions/ops-telemetry-contract.js'));
const service = read('functions/cost-usage-service.js');
const index = read('functions/index.js');
const rules = read('firestore.rules');
const indexes = JSON.parse(read('firestore.indexes.json'));
const page = read('cost-usage.html');
const ui = read('cost-usage-ui.js');
const nav = read('nav.js');
const billingReader = read('functions/cost-billing-reader.js');
const completionEvent = read('functions/cost-completion-event.js');
const completionOutbox = read('functions/cost-completion-outbox.js');
const privacyMap = read('PRIVACY-DATA-MAP.md');

check('cost-usage.html is RTL Hebrew with theme.css?v=42h49 and one App Check init',
  /<html lang="he" dir="rtl">/.test(page) && /theme\.css\?v=42h49/.test(page) &&
  (page.match(/await initAppCheck\(app\)/g) || []).length === 1);
check('every local module import on cost-usage.html carries ?v=42h49',
  [...page.matchAll(/from '\.\/([^']+)'/g)].every((m) => /\?v=42h49$/.test(m[1])) &&
  [...page.matchAll(/from '\.\/([^']+)'/g)].length >= 6);
check('page gates on live super claims; deny for non-super; renderNav cost-usage.html',
  /renderNav\(claims,'cost-usage\.html',user\.email\|\|''\)/.test(page) &&
  /claims\.super!==true/.test(page) && /renderStuckNav\(''\)/.test(page));
check('UI never uses innerHTML; user rows omit uid; NO_SOURCE constant present',
  !/innerHTML/.test(ui) && /NO_SOURCE/.test(ui) && !/u\.uid|user\.uid|row\.uid/.test(ui));
check('service is super-only via live claims; saas-admin is not accepted',
  /live\.super !== true/.test(service) && /לוח עלות ושימוש זמין למנהל-על בלבד/.test(service));
check('pane1 billing stub returns null never zero path in source',
  /badge: 'אין מקור'/.test(service) && /value: null/.test(service) && /billing_not_connected/.test(service));
check('no unkeyed hash fallback — HMAC only or disabled_no_hmac_secret',
  /disabled_no_hmac_secret/.test(service) && /refuses unkeyed hashing/.test(service) &&
  !/createHash\('sha256'\)/.test(service));
check('no per-request callout meter writes in service',
  !/callout.*set\(|onCallout|per-request/.test(service) || /אין כתיבות מד מדד/.test(service));
check('measurement_start and coverage always part of API shape',
  /measurement_start_at/.test(service) && /coverage:/.test(service));
check('collections cost_usage_* denied in firestore.rules',
  /match \/cost_usage_config\/\{id\}/.test(rules) &&
  /match \/cost_usage_daily\/\{id\}/.test(rules) &&
  /match \/cost_usage_lifetime\/\{id\}/.test(rules) &&
  (rules.match(/match \/cost_usage_[\s\S]*?allow read, write: if false;/g) || []).length >= 3);
check('nav lists cost-usage.html for super in admin group',
  /href: 'cost-usage\.html'[^}]*who: 'super'[^}]*group: 'admin'/.test(nav));
check('index exports getCostUsageDashboard + setCostUsageMeasurementStart with App Check',
  /exports\.getCostUsageDashboard = onCall\([\s\S]*?enforceAppCheck:\s*true/.test(index) &&
  /exports\.setCostUsageMeasurementStart = onCall\([\s\S]*?enforceAppCheck:\s*true/.test(index));
check('recordAttributedCallsBatch is NOT a public onCall export',
  !/exports\.recordAttributedCallsBatch/.test(index));
check('telemetry SCREENS/CALLABLES include cost-usage board',
  telemetry.SCREENS.includes('cost-usage.html') &&
  telemetry.CALLABLES.includes('getCostUsageDashboard') &&
  telemetry.CALLABLES.includes('setCostUsageMeasurementStart'));
check('incident-client mirrors telemetry screen + callables',
  read('incident-client.js').includes("'cost-usage.html'") &&
  read('incident-client.js').includes("'getCostUsageDashboard'"));
check('public-assets lists cost-usage.html and cost-usage-ui.js',
  ['cost-usage.html', 'cost-usage-ui.js'].every((f) => read('tests/public-assets.json').includes('"' + f + '"')));
check('LF-only source for new cost-usage files',
  [page, ui, service].every((t) => isCleanText(t)));
check('retention 90 days constant',
  /RETENTION_DAYS = 90/.test(service));


check('dedicated HMAC uses defineSecret RESQ_COST_USAGE_HASH_KEY only (no METRICS fallback in index)',
  /define(?:CostUsage)?Secret\(\s*['"]RESQ_COST_USAGE_HASH_KEY['"]\s*\)/.test(index) &&
  /secrets:\s*\[[^\]]*RESQ_COST_USAGE_HASH_KEY/.test(index) &&
  !/RESQ_COST_USAGE_HASH_KEY\s*\|\|\s*process\.env\.RESQ_METRICS_HASH_KEY/.test(index) &&
  !/hashKey:\s*process\.env\.RESQ_COST_USAGE_HASH_KEY\s*\|\|\s*''/.test(index));

check('listAuthUsers is paginated (pageSize + pageToken) not full dump',
  /listAuthUsers:\s*async\s*\(\s*\{\s*pageSize/.test(index) ||
  /listAuthUsers:\s*async\s*\(\s*\{\s*pageSize,\s*pageToken/.test(index));
check('batch ledger collection denied in firestore.rules',
  /match \/cost_usage_batch_ledger\/\{id\}/.test(rules) &&
  (rules.match(/match \/cost_usage_[\s\S]*?allow read, write: if false;/g) || []).length >= 4);
check('service has idempotent event_id batch + pageSize/pageToken + toIsoTimestamp',
  /event_id/.test(service) && /skipped_duplicates/.test(service) &&
  /pageSize/.test(service) && /toIsoTimestamp/.test(service) &&
  /LEDGER_COLLECTION/.test(service));
check('UI formats last_signin with time (dateTimeText) and supports next page',
  /dateTimeText/.test(ui) && /nextPage/.test(ui) && /הבא/.test(page));
check('Secret Manager required note for RESQ_COST_USAGE_HASH_KEY present',
  /RESQ_COST_USAGE_HASH_KEY/.test(service) && /Secret Manager/.test(service));
check('atomic batch uses runTransaction for ledger+daily+lifetime',
  /runTransaction/.test(service) && /atomic: true/.test(service));
check('feeder_status not_wired documented in service and UI',
  /feeder_status:\s*'not_wired'|status:\s*'not_wired'/.test(service) &&
  /not_wired|מזין/.test(ui));
check('measurement start is server-owned and has no reset or wipe path',
  /new Date\(now\(\)\)\.toISOString\(\)/.test(service) &&
  !/wipe_counters|wipeCostUsageAggregates|reset_policy/.test(service) &&
  !/wipeCostUsageAggregates/.test(index));
check('batch enforces event time and measurement start inside its transaction',
  /MAX_EVENT_AGE_DAYS = 30/.test(service) &&
  /tx\.get\(configRef\)/.test(service) &&
  /before-measurement-start/.test(service) && /event-age/.test(service));
check('cost retention stays manual with an indexed expiry field',
  ['cost_usage_daily', 'cost_usage_station_daily', 'cost_usage_global_daily', 'cost_usage_batch_ledger'].every((name) =>
    !indexes.fieldOverrides.some((item) => item.collectionGroup === name && item.fieldPath === 'expires_at')) &&
  /manual_cleanup_not_configured/.test(service) &&
  /retention_enforced:\s*false/.test(service));
check('new photo and vehicle quotas do not enable automatic deletion',
  ['fault_photo_quotas', 'vehicle_event_quotas'].every((name) =>
    indexes.fieldOverrides.some((item) => item.collectionGroup === name && item.fieldPath === 'expires_at' &&
      item.ttl !== true && Array.isArray(item.indexes) && item.indexes.length === 0)));
check('station counts are sharded, private, restorable and rendered only as partial coverage',
  /STATION_SHARDS = 16/.test(service) && /station_aggregate_start_at/.test(service) &&
  /tx\.set\(stationRef/.test(service) && /station_calls: stationCalls/.test(service) &&
  /match \/cost_usage_station_daily\/\{id\}/.test(rules) &&
  /policy\('cost_usage_station_daily\/\{id\}'/.test(read('functions/backup-policy.js')) &&
  /renderStationCalls/.test(ui) && /stationCalls/.test(read('cost-usage.html')));
check('global daily total is separately sharded, private, and the stations are paged',
  /GLOBAL_DAILY_COLLECTION/.test(service) && /global_aggregate_start_at/.test(service) &&
  /STATION_PAGE_SIZE = 25/.test(service) && /next_station_page_token/.test(service) &&
  /match \/cost_usage_global_daily\/\{id\}/.test(rules) &&
  /policy\('cost_usage_global_daily\/\{id\}'/.test(read('functions/backup-policy.js')) &&
  /setStationDay/.test(ui) && /nextStationPage/.test(ui));
check('pruneExpiredCostUsage stub exists and is NOT scheduled/exported for prod',
  /pruneExpiredCostUsage/.test(service) &&
  !/exports\.pruneExpiredCostUsage/.test(index) &&
  !/exports\.costUsagePrune/.test(index) &&
  !/exports\.costUsageFeeder/.test(index));
check('page-scoped profile reads (doc per uid) not station collection scan',
  /stations\/'\s*\+\s*sid\s*\+\s*'\/users\/'\s*\+\s*u\.uid/.test(index) ||
  /stations\/" \+ sid \+ "\/users\/" \+ u\.uid/.test(index) ||
  /'stations\/' \+ sid \+ '\/users\/' \+ /.test(index));
check('UI shows feeder_status on users pane',
  /feeder_status|מזין לא מחובר|not_wired/.test(ui));
check('Billing Export reader is owner-configured and off by default',
  /RESQ_BILLING_READER_ENABLED === 'true'/.test(index) &&
  /billing_configuration_invalid/.test(billingReader) &&
  /dryRun: true/.test(billingReader) &&
  /billing_query_over_budget/.test(billingReader));
check('Billing reader accepts only the station-102 authorized view, not the account-wide export',
  /resq_billing_views/.test(billingReader) &&
  /resq_station102_usage_cost/.test(billingReader) &&
  !/gcp_billing_export_\(\?:resource_\)\?v1_/.test(billingReader));
check('dashboard has a dedicated runtime identity and bounded instances',
  /serviceAccount: COST_USAGE_DASHBOARD_SERVICE_ACCOUNT, maxInstances: 1/.test(index));
check('billing reader is a module-scoped singleton across callable requests',
  /let liveBillingReader = null/.test(index) &&
  /function createLiveBillingReader\(\)\s*\{[\s\S]*?if \(liveBillingReader\) return liveBillingReader;/.test(index) &&
  /liveBillingReader = costBillingReaderModule\.createCostBillingReader/.test(index) &&
  /return liveBillingReader;/.test(index));
check('UI source badge follows the actual availability state',
  /hasActual \? 'עלות שימוש מדווחת' : 'עלות בפועל: אין מקור'/.test(ui));
check('server completion contract has gated durable outbox and scheduled drain',
  /createServerCompletionEvent/.test(completionEvent) &&
  /verification !== 'live'/.test(completionEvent) &&
  /RESQ_COST_USAGE_OUTBOX_ENABLED === 'true'/.test(index) &&
  /exports\.drainCostUsageOutbox = onSchedule/.test(index) &&
  /recordServerCompletionEventsBatch/.test(completionOutbox) &&
  /match \/cost_usage_outbox\/\{id\}/.test(rules) &&
  /status:\s*'not_wired'/.test(service));
check('outbox measures only approved reads and is classified for backup',
  /getStationScheduleRange/.test(completionEvent) &&
  /getMyAttendanceMonth/.test(completionEvent) &&
  /listHrRequestsInbox/.test(completionEvent) &&
  !/sendCallout:/.test(completionEvent) &&
  /policy\('cost_usage_outbox\/\{id\}'/.test(read('functions/backup-policy.js')) &&
  /cost_usage_outbox/.test(privacyMap));
check('privacy map describes cost collections, incomplete coverage, and retention gap',
  /cost_usage_lifetime/.test(privacyMap) &&
  /cost_usage_batch_ledger/.test(privacyMap) &&
  /BigQuery/.test(privacyMap) &&
  /מדיניות מחיקה\/תיקון/.test(privacyMap));
check('new source files use LF-only clean text',
  [billingReader, completionEvent].every((t) => isCleanText(t)));

console.log('\nCost-usage source: ' + passed + ' PASS.');
