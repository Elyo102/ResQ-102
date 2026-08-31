import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const runtime = read('functions/schedule-runtime.js');
const integration = read('functions/schedule-runtime.integration.test.js');
const index = read('functions/index.js');
const rules = read('firestore.rules');
const backup = read('functions/backup-policy.js');
const ui = read('schedule-management.js');
const html = read('schedule-management.html');
const nav = read('nav.js');
const worker = read('firebase-messaging-sw.js');
const workflow = read('.github/workflows/tests.yml');
const indexes = JSON.parse(read('firestore.indexes.json'));

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('✓ ' + name); }

check('missing runtime configuration is fail-closed off', () => {
  assert.ok(runtime.includes("const mode = MODES.indexOf(data.mode) !== -1 ? data.mode : MODE.OFF"));
});
check('the only runtime modes are off, shadow and new', () => {
  assert.ok(runtime.includes("const MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', NEW: 'new' })"));
});
check('client station fields are rejected', () => {
  assert.ok(runtime.includes("hasOwnProperty.call(data, 'stationId')"));
  assert.ok(runtime.includes("hasOwnProperty.call(data, 'station_id')"));
  assert.ok(runtime.includes("'client-station-forbidden'"));
});
check('station comes from the authenticated token', () => {
  assert.ok(runtime.includes("const sid = String(token.stationId || '').trim()"));
});
check('live ResQ stationId is checked and conflicting aliases fail closed', () => {
  assert.ok(runtime.includes("String(user.stationId || user.station_id || '')"));
  assert.ok(runtime.includes('conflictingStationFields'));
  assert.ok(runtime.includes('liveStation !== sid'));
});
check('disabled live users are rejected', () => {
  assert.ok(runtime.includes('user.is_active !== false && user.active !== false'));
});
check('token and live role must agree', () => {
  assert.ok(runtime.includes("String(token.role || '') !== role"));
  assert.ok(runtime.includes("'claims-stale'"));
});
check('manager authority is decided on the server', () => {
  assert.ok(runtime.includes('token.schedule_manager === true'));
  assert.equal(runtime.includes('user.schedule_manager === true'), false);
  assert.ok(rules.includes('affectedKeys()'));
  assert.ok(rules.includes("hasOnly(['full_name', 'phone', 'email', 'photo_url'])"));
  assert.ok(runtime.includes('MANAGER_ROLES.indexOf(role) !== -1'));
  assert.ok(runtime.includes('function requireManager(ctx)'));
});
check('source and policy content are server-digested', () => {
  assert.ok(runtime.includes('const actual = digest(basis)'));
  assert.ok((runtime.match(/content_digest/g) || []).length >= 5);
});
check('source subcollection counts are verified', () => {
  for (const field of ['person_count', 'availability_count', 'locked_count', 'event_count']) {
    assert.ok(runtime.includes(field), field);
  }
  assert.ok(runtime.includes("'source-count-mismatch'"));
});
check('oversized source declarations fail before any bulk read', () => {
  assert.ok(runtime.indexOf("'source-count-limit'") < runtime.indexOf('const groups = await Promise.all'));
});
check('drafts and publications are complete snapshots with people', () => {
  for (const token of ["collection('rows')", "collection('events')", "collection('people')", "status: 'complete'"]) {
    assert.ok(runtime.includes(token), token);
  }
});
check('snapshot integrity includes the people projection and is rechecked on full reads', () => {
  assert.ok(runtime.includes('events: orderedEvents, people: orderedPeople'));
  assert.ok(runtime.includes('}, rows, events, people: orderedPeople'));
  assert.ok(runtime.includes("'snapshot-digest-mismatch'"));
});
check('publish blocks policy or source changes made after draft creation', () => {
  assert.ok(runtime.includes('base_source_digest: source.digest'));
  assert.ok(runtime.includes('base_policy_digest: policy.digest'));
  assert.ok(runtime.includes("'draft-source-changed'"));
  assert.ok(runtime.includes("'publish-source-changed'"));
});
check('publishing requires the exact digest returned by draft preview', () => {
  assert.ok(runtime.includes('async function getDraftPreview'));
  assert.ok(runtime.includes("'draft-preview-required'"));
  assert.ok(runtime.includes('liveDraft.content_digest !== expectedContentDigest'));
  assert.ok(ui.includes("httpsCallable(functions, 'getScheduleDraftPreview')"));
  assert.ok(ui.includes('expected_content_digest: state.draftPreview.expected_content_digest'));
  assert.ok(html.includes('תצוגה מקדימה של הטיוטה'));
  assert.ok(html.includes('id="reviewDraft"'));
});
check('publication activation and audit share one transaction', () => {
  const publishBody = runtime.slice(runtime.indexOf('async function publish'), runtime.indexOf('async function getMy'));
  const body = publishBody.slice(publishBody.lastIndexOf('await db.runTransaction(async (tx) => {'));
  assert.ok(body.includes('tx.set(activeRef(ctx.sid)'));
  assert.ok(body.includes("collection('schedule_audit')"));
  assert.ok(body.includes("status: 'active'"));
});
check('notifications are blocked until activation commits', () => {
  const publishBody = runtime.slice(runtime.indexOf('async function publish'), runtime.indexOf('async function getMy'));
  const blocked = publishBody.indexOf("status: 'blocked'");
  const transaction = publishBody.lastIndexOf('await db.runTransaction(async (tx) => {');
  const queue = publishBody.lastIndexOf('await queueOutbox(pubRef)');
  assert.ok(blocked > -1 && blocked < transaction && transaction < queue);
});
check('publication retry resumes the same request rather than duplicating it', () => {
  assert.ok(runtime.includes('request_fingerprint: requestFingerprint'));
  assert.ok(runtime.includes('existingData.request_fingerprint !== requestFingerprint'));
  assert.ok(runtime.includes('await queueOutbox(pubRef)'));
});
check('outbox delivery rechecks the active publication', () => {
  assert.ok(runtime.includes("publication_id !== data.publication_id"));
  assert.ok(runtime.includes("status: 'cancelled'"));
});
check('push retries end in a dead-letter state', () => {
  assert.ok(runtime.includes('publication.planRetry('));
  assert.ok(runtime.includes('next_attempt_at'));
  assert.ok(runtime.includes('Number(delivery.sent || 0) < 1'));
  assert.ok(index.includes("'NO_ACTIVE_PUSH_TOKEN'"));
});
check('outbox uses expiring leases and recovers every unfinished state', () => {
  assert.ok(runtime.includes('lease_until'));
  assert.ok(runtime.includes('lease_token'));
  assert.ok(runtime.includes("['blocked', 'retry', 'sending', 'queued']"));
  assert.ok(runtime.includes('expires_at: new Date'));
});
check('personal changes are loaded only for the authenticated uid', () => {
  assert.ok(runtime.includes("where('person', '==', ctx.uid)"));
  assert.ok(runtime.includes('changes_by_date: changes'));
});
check('answers are filtered by live authenticated uid', () => {
  assert.ok(runtime.includes('value.person === ctx.uid'));
});
check('responses support owned dates and owned event ids', () => {
  assert.ok(runtime.includes("collection('rows').where('date', '==', itemId)"));
  assert.ok(runtime.includes("collection('events').where('id', '==', itemId)"));
  assert.ok(runtime.includes("(event.people || []).forEach"));
});
check('all schedule callables enforce App Check', () => {
  for (const name of ['getScheduleRuntimeStatus', 'getScheduleManagerSetup', 'runSchedulePlanner',
    'getScheduleDraftPreview',
    'publishSchedule', 'rollbackSchedule', 'getMyScheduleV2', 'getStationScheduleV2', 'respondToSchedule']) {
    const start = index.indexOf('exports.' + name);
    assert.ok(start > -1, name);
    assert.ok(index.slice(start, start + 220).includes('enforceAppCheck: true'), name);
  }
});
check('rollback creates a new audited revision and never repoints an old document', () => {
  const body = runtime.slice(runtime.indexOf('async function rollback'), runtime.indexOf('async function getMy'));
  assert.ok(body.includes("const pubId = 'p_rb_'"));
  assert.ok(body.includes("action: 'rollback'"));
  assert.ok(body.includes('rollback_target_publication_id'));
  assert.ok(body.includes("status: 'active'"));
  assert.ok(ui.includes("httpsCallable(functions, 'rollbackSchedule')"));
  assert.ok(html.includes('חזור לגרסה הקודמת'));
});
check('clients cannot directly read or write schedule storage', () => {
  for (const pathName of ['schedule_state', 'schedule_policies', 'schedule_sources', 'schedule_drafts',
    'schedule_publications', 'schedule_responses', 'schedule_audit']) {
    const start = rules.indexOf('match /' + pathName + '/');
    assert.ok(start > -1, pathName);
    assert.ok(rules.slice(start, start + 120).includes('allow read, write: if false'), pathName);
  }
});
check('every new schedule collection has an explicit backup policy', () => {
  for (const pathName of ['schedule_state', 'schedule_policies', 'schedule_sources', 'schedule_drafts',
    'schedule_publications', 'schedule_outbox', 'schedule_responses', 'schedule_audit']) {
    assert.ok(backup.includes(pathName), pathName);
  }
});
check('runtime integration refuses a real Firestore project', () => {
  assert.ok(integration.includes('if (!process.env.FIRESTORE_EMULATOR_HOST)'));
  assert.ok(integration.includes('process.exit(2)'));
});
check('runtime integration covers spoofing, events, idempotency and stale pushes', () => {
  for (const token of ['station spoofing is rejected', 'answer only an event assigned',
    'publication request is idempotent', 'publication is no longer active']) assert.ok(integration.includes(token), token);
});
check('runtime integration covers privilege escalation, stale drafts, leases and rollback', () => {
  for (const token of ['profile flag alone never grants', 'policy changed under the same id',
    'expired sending lease', 'rolled back only by creating a new revision']) {
    assert.ok(integration.includes(token), token);
  }
});
check('runtime integration is wired into emulator CI', () => {
  assert.ok(workflow.includes('node schedule-runtime.integration.test.js'));
});
check('the production UI initializes App Check before callable use', () => {
  assert.ok(ui.includes('await initAppCheck(app)'));
  assert.ok(ui.indexOf('await initAppCheck(app)') < ui.indexOf('getFunctions(app'));
});
check('the production UI has no direct Firestore access or fixture path', () => {
  assert.equal(/firebase-firestore|getFirestore|\bfixture\b|__demo/i.test(ui), false);
});
check('an off runtime keeps the existing live schedule in service', () => {
  assert.ok(ui.includes("state.status.mode === 'off' || (state.status.mode === 'shadow' && !state.status.manager)"));
  assert.ok(ui.includes("location.replace('./schedule.html')"));
});
check('personal schedule reads only the requested day', () => {
  assert.ok(runtime.includes('const active = await activeSnapshot(ctx, [date])'));
  assert.ok(ui.includes("call.mine({ date: state.mineDate || localDate() })"));
});
check('management visibility is driven by server status', () => {
  assert.ok(ui.includes("$('manageTab').hidden = !state.status.manager"));
  assert.ok(ui.includes("name === 'manage' && (!state.status || !state.status.manager)"));
});
check('the UI exposes both personal and station views', () => {
  assert.ok(html.includes('הסידור שלי'));
  assert.ok(html.includes('סידור התחנה'));
  assert.ok(ui.includes("getMyScheduleV2"));
  assert.ok(ui.includes("getStationScheduleV2"));
});
check('dynamic schedule data is inserted as text, not HTML', () => {
  assert.equal(/\.innerHTML\s*=/.test(ui), false);
  assert.ok(ui.includes('.textContent ='));
});
check('the new schedule replaces the navigation target but keeps old page for rollback', () => {
  assert.ok(nav.includes("href: 'schedule-management.html'"));
  assert.ok(fs.existsSync(path.join(root, 'schedule.html')));
});
check('the offline shell contains both new schedule assets', () => {
  assert.ok(worker.includes("'./schedule-management.html'"));
  assert.ok(worker.includes("'./schedule-management.js'"));
});

check('queries and transient schedule delivery have indexes and TTL', () => {
  assert.ok(indexes.indexes.some((item) => item.collectionGroup === 'schedule_responses'
    && item.fields.some((field) => field.fieldPath === 'publication_id')
    && item.fields.some((field) => field.fieldPath === 'person')));
  assert.ok(indexes.fieldOverrides.some((item) => item.collectionGroup === 'schedule_outbox'
    && item.fieldPath === 'status'));
  assert.ok(indexes.fieldOverrides.some((item) => item.collectionGroup === 'schedule_outbox'
    && item.fieldPath === 'expires_at' && item.ttl === true));
});

assert.equal(passed, 42);
console.log('\n42 schedule runtime source checks passed.');
