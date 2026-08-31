import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const runtime = read('functions/schedule-runtime.js');
const stationProfile = read('functions/station-profile.js');
const integration = read('functions/schedule-runtime.integration.test.js');
const service = read('functions/schedule-service.js');
const index = read('functions/index.js');
const rules = read('firestore.rules');
const backup = read('functions/backup-policy.js');
const ui = read('schedule-management.js');
const html = read('schedule-management.html');
const nav = read('nav.js');
const legacySchedule = read('schedule.html');
const legacyAdmin = read('admin.html');
const legacyRules = read('firestore_1.rules');
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
check('all historical station aliases are accepted, while ambiguity fails closed', () => {
  assert.ok(runtime.includes('stationProfile.resolveStationAliases(user'));
  assert.ok(index.includes('stationProfile.resolveStationAliases(profile'));
  assert.ok(stationProfile.includes("['stationId', 'station_id', 'station']"));
  assert.ok(stationProfile.includes("reason: 'missing'"));
  assert.ok(stationProfile.includes("reason: 'invalid'"));
  assert.ok(stationProfile.includes("reason: 'conflict'"));
  assert.ok(stationProfile.includes('unique.length !== 1'));
  assert.ok(runtime.includes('!liveStation.ok || liveStation.stationId !== sid'));
});
check('disabled live users are rejected', () => {
  assert.ok(runtime.includes('user.is_active !== false && user.active !== false'));
});
check('token and live role must agree', () => {
  assert.ok(runtime.includes("String(token.role || '') !== role"));
  assert.ok(runtime.includes("'claims-stale'"));
});
check('manager authority requires an exact signed claim and matching live server grant', () => {
  const grantStart = runtime.indexOf('async function hasLiveScheduleManagerGrant');
  const grantEnd = runtime.indexOf('\n\n  async function context', grantStart);
  const grant = runtime.slice(grantStart, grantEnd);
  const contextStart = runtime.indexOf('async function context');
  const contextEnd = runtime.indexOf('\n\n  function actor', contextStart);
  const context = runtime.slice(contextStart, contextEnd);
  assert.ok(grantStart > -1 && grantEnd > grantStart);
  assert.ok(runtime.includes("const SCHEDULE_MANAGER_GRANTS = 'schedule_manager_grants'"));
  assert.ok(grant.includes('token.schedule_manager !== true'));
  assert.ok(grant.includes('token.schedule_manager_version'));
  assert.ok(grant.includes('db.collection(SCHEDULE_MANAGER_GRANTS).doc(uid).get()'));
  assert.ok(grant.includes('grant.active === true'));
  assert.ok(grant.includes("String(grant.stationId || '') === String(sid)"));
  assert.ok(grant.includes("String(grant.version || '') === version"));
  assert.ok(context.includes('const manager = managerEligible &&'));
  assert.ok(context.includes('await hasLiveScheduleManagerGrant(token, req.auth.uid, sid)'));
  assert.ok(context.includes('const managerEligible = MEMBER_ROLES.indexOf(role) !== -1'));
  assert.ok(context.includes("String(token.role || '') === role"));
  assert.equal(grant.includes('isSuper'), false);
  assert.equal(grant.includes('MANAGER_ROLES'), false);
  assert.equal(runtime.includes('user.schedule_manager === true'), false);
  assert.ok(rules.includes('match /schedule_manager_grants/{uid}'));
  assert.ok(rules.includes('match /schedule_manager_grants/{uid} {\n      allow read, write: if false;'));
  assert.ok(rules.includes('affectedKeys()'));
  assert.ok(rules.includes("hasOnly(['full_name', 'phone', 'email', 'photo_url'])"));
  assert.ok(runtime.includes('function requireManager(ctx)'));
});
check('runtime declares only capabilities implemented by the service', () => {
  const start = runtime.indexOf('function capabilities()');
  const end = runtime.indexOf('function serviceFor(ctx', start);
  const declared = Array.from(runtime.slice(start, end).matchAll(/'([a-z_]+)'/g), (match) => match[1]);
  const supported = new Set(Array.from(service.matchAll(/^\s+[A-Z_]+:\s*'([a-z_]+)'/gm), (match) => match[1]));
  assert.ok(declared.length > 0);
  declared.forEach((action) => assert.ok(supported.has(action), action));
});
check('source and policy content are server-digested', () => {
  assert.ok(runtime.includes('const actual = digest(basis)'));
  assert.ok((runtime.match(/content_digest/g) || []).length >= 5);
});
check('digest ordering is deterministic across operating systems', () => {
  assert.ok(runtime.includes('function compareCanonical(left, right)'));
  assert.equal(runtime.includes('.localeCompare('), false);
  assert.ok(integration.includes('assert.notDeepEqual(declaredPeople'));
  assert.ok(integration.includes('.sort(compareCanonical)'));
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
  assert.ok(runtime.includes('runtimeData.mode !== MODE.NEW'));
  assert.ok(runtime.includes("cancel_reason: 'runtime-not-new'"));
  assert.ok(integration.includes('off and shadow cancel queued retry and expired sending'));
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
check('runtime integration covers strict appointment, stale drafts, leases and rollback', () => {
  for (const token of ['profile flag alone never grants', 'policy changed under the same id',
    'exact signed claim and matching live grant', 'commander or super user without the additional appointment',
    'revoking the live grant blocks an already-issued manager token',
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
check('an inactive runtime keeps the station schedule screen open and explains why management is blocked', () => {
  assert.equal(ui.includes("location.replace('./schedule.html')"), false);
  assert.ok(ui.includes("function managementActionsAllowed(status = state.status)"));
  assert.ok(ui.includes("פעולות הניהול חסומות עד שיוגדרו חוקי תחנה"));
  assert.ok(ui.includes("צפייה בסידור התחנה זמינה"));
  assert.ok(ui.includes("chooseTab(requestedTab)"));
  assert.ok(ui.includes("name === 'manage' && (!state.status || !state.status.manager)"));
});
check('the UI refreshes live runtime status before writes and when the page becomes visible', () => {
  assert.ok(ui.includes('async function recheckManagementAction(target, needsNewMode)'));
  assert.ok(ui.includes("await recheckManagementAction('runMessage', false)"));
  assert.ok(ui.includes("await recheckManagementAction('publishMessage', true)"));
  assert.ok(ui.includes("await recheckManagementAction('rollbackMessage', true)"));
  assert.ok(ui.includes('status = await refreshRuntimeStatus();'));
  assert.ok(ui.includes("document.addEventListener('visibilitychange'"));
  assert.ok(ui.includes("document.visibilityState !== 'visible'"));
});
check('management controls are disabled in an off, unconfigured, or nonmanager runtime', () => {
  assert.ok(ui.includes("['startMonth', 'months', 'addOverride', 'runPlanner']"));
  assert.ok(ui.includes("$(id).disabled = state.busy || !allowed"));
  assert.ok(ui.includes("#overrideList input, #overrideList select, #overrideList button"));
  assert.ok(ui.includes("|| !publishingAllowed() || gaps > 0"));
  assert.ok(ui.includes("state.busy || !publishingAllowed() || !active"));
});
check('personal schedule reads only the requested day', () => {
  assert.ok(runtime.includes('const active = await activeSnapshot(ctx, [date])'));
  assert.ok(ui.includes("call.mine({ date: state.mineDate || localDate() })"));
});
check('management visibility is driven by server status', () => {
  assert.ok(ui.includes("$('manageTab').hidden = !state.status.manager"));
  assert.ok(ui.includes("name === 'manage' && (!state.status || !state.status.manager)"));
  assert.ok(ui.includes('function effectiveScheduleManagementClaims()'));
  assert.ok(ui.includes('renderNav(effectiveScheduleManagementClaims()'));
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
check('station schedule is the navigation default and management is an additional appointment', () => {
  assert.ok(nav.includes("href: 'schedule-management.html?tab=station'"));
  assert.ok(nav.includes("href: 'schedule-management.html?tab=manage'"));
  assert.ok(nav.includes("who: 'schedule_manager'"));
  assert.ok(fs.existsSync(path.join(root, 'schedule.html')));
});
check('the legacy schedule cannot bypass the additional appointment', () => {
  // The legacy view uses a signed claim only as a hint; the live server
  // status remains the client-side editor gate after a grant is revoked.
  assert.ok(legacySchedule.includes('async function readLiveScheduleManager(context)'));
  assert.ok(legacySchedule.includes('schedulePageClaims.schedule_manager !== true'));
  assert.ok(legacySchedule.includes('callScheduleStatus({})'));
  assert.ok(legacySchedule.includes('result.data && result.data.manager === true'));
  assert.ok(legacySchedule.includes('const localCanEditOvr = await readLiveScheduleManager(authContext)'));
  assert.equal(legacySchedule.includes('const localCanEditOvr = claims.schedule_manager === true'), false);
  assert.equal(legacySchedule.includes("['deputy', 'commander', 'station_commander', 'hr_coordinator']"), false);
  assert.ok(legacySchedule.includes('if (!canEditOvr)'));
  assert.ok(legacyAdmin.includes('const isScheduleManager = await readLiveScheduleManager(generation, user)'));
  assert.equal(legacyAdmin.includes('const isScheduleManager = claims.schedule_manager === true'), false);
  assert.ok(legacyAdmin.includes('applyScheduleManagerAccess(isScheduleManager)'));
  assert.ok(legacyAdmin.includes('canManageSchedule = live === true'));
  assert.ok(legacyAdmin.includes("const fields = ['anchorDate', 'anchorCrew', 'shiftStart', 'shiftEnd', 'cmdStart', 'specEnd', 'btnRot']"));
  assert.ok(legacyAdmin.includes("if (!canManageSchedule)"));
  assert.ok(legacyAdmin.includes('id="rotationReadOnly"'));
  assert.ok(nav.includes("who: 'schedule_admin'"));
  for (const source of [rules, legacyRules]) {
    const managerStart = source.indexOf('function scheduleManager(sid)');
    const managerEnd = source.indexOf('\n    //', managerStart + 1);
    const manager = source.slice(managerStart, managerEnd);
    const rotations = source.slice(source.indexOf('match /rotations/{rotationId}'), source.indexOf('match /shift_overrides/{overrideId}'));
    const overrides = source.slice(source.indexOf('match /shift_overrides/{overrideId}'), source.indexOf('match /postings/{postingId}'));
    const postings = source.slice(source.indexOf('match /postings/{postingId}'), source.indexOf('// ---------- נוכחות'));
    assert.ok(source.includes('function scheduleEligibleMember(sid)'));
    assert.ok(manager.includes('return scheduleEligibleMember(sid)'));
    assert.ok(source.includes("profile.get('is_active', true) != false"));
    assert.ok(source.includes("profile.get('role', '') == claim('role')"));
    assert.ok(rotations.includes('allow write: if scheduleManager(sid);'));
    assert.ok(overrides.includes('allow write: if scheduleManager(sid);'));
    // postings is a separate, currently unwired operational-message path.
    // It must not silently become a schedule-event write path without a new review.
    assert.ok(postings.includes('הודעות מבצעיות אינן עריכת סידור'));
    assert.ok(postings.includes('allow write: if staff(sid);'));
  }
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

assert.equal(passed, 47);
console.log('\n47 schedule runtime source checks passed.');
