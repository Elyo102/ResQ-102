import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const runtime = read('functions/schedule-runtime.js');
const integration = read('functions/schedule-runtime.integration.test.js');
const service = read('functions/schedule-service.js');
const access = read('functions/schedule-access.js');
const accessAdmin = read('functions/schedule-access-admin.js');
const index = read('functions/index.js');
const rules = read('firestore.rules');
const backup = read('functions/backup-policy.js');
const ui = read('schedule-management.js');
const html = read('schedule-management.html');
const legacySchedule = read('schedule.html');
const nav = read('nav.js');
const worker = read('firebase-messaging-sw.js');
const workflow = read('.github/workflows/tests.yml');
const indexes = JSON.parse(read('firestore.indexes.json'));
const manifest = JSON.parse(read('manifest.json'));

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
check('live ResQ station aliases, including identity-coordinator station, fail closed on conflict', () => {
  assert.ok(access.includes("['stationId', 'station_id', 'station']"));
  assert.ok(runtime.includes('scheduleAccess.activeMember(user, sid)'));
});
check('disabled live users are rejected', () => {
  assert.ok(access.includes('user.is_active !== false && user.active !== false'));
  assert.ok(runtime.includes('scheduleAccess.activeMember(user, sid)'));
});
check('token and live role must agree', () => {
  assert.ok(runtime.includes("String(token.role || '') !== role"));
  assert.ok(runtime.includes("'claims-stale'"));
});
check('manager authority is live, local and separate from the primary role', () => {
  assert.equal(runtime.includes('token.schedule_manager === true'), false);
  assert.equal(runtime.includes('MANAGER_ROLES'), false);
  assert.ok(runtime.includes("collection('schedule_access').doc(uid)"));
  assert.ok(runtime.includes('scheduleAccess.isManagerAccess(access, sid, req.auth.uid)'));
  assert.ok(access.includes("const SCHEDULE_MANAGER_ROLE = 'schedule_manager'"));
  assert.ok(access.includes('access.roles.length !== 1'));
  assert.ok(access.includes('function activeMember'));
  assert.ok(runtime.includes('function requireManager(ctx)'));
});
check('revocation is rechecked at every schedule write boundary', () => {
  assert.ok(runtime.includes('function requireLiveManager(userSnap, accessSnap, ctx)'));
  assert.ok((runtime.match(/requireLiveManager\(/g) || []).length >= 4);
  assert.ok(runtime.includes("'manager-revoked'"));
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
  const start = runtime.indexOf('async function publish');
  const publishBody = runtime.slice(start, runtime.indexOf('async function rollback', start));
  const body = publishBody.slice(publishBody.lastIndexOf('await db.runTransaction(async (tx) => {'));
  assert.ok(body.includes('tx.set(activeRef(ctx.sid)'));
  assert.ok(body.includes("collection('schedule_audit')"));
  assert.ok(body.includes("status: 'active'"));
});
check('notifications are blocked until activation commits', () => {
  const start = runtime.indexOf('async function publish');
  const publishBody = runtime.slice(start, runtime.indexOf('async function rollback', start));
  const blocked = publishBody.indexOf("status: 'blocked'");
  const transaction = publishBody.lastIndexOf('await db.runTransaction(async (tx) => {');
  const release = publishBody.lastIndexOf('await releaseOutbox(pubRef)');
  assert.ok(blocked > -1 && blocked < transaction && transaction < release);
});
check('publication retry resumes the same request rather than duplicating it', () => {
  assert.ok(runtime.includes('request_fingerprint: requestFingerprint'));
  assert.ok(runtime.includes('existingData.request_fingerprint !== requestFingerprint'));
  assert.ok(runtime.includes('await releaseOutbox(pubRef)'));
});
check('outbox delivery rechecks the active publication', () => {
  assert.ok(runtime.includes('publicationMatches(value, pointer, publication)'));
  assert.ok(runtime.includes("status: 'cancelled'"));
  assert.ok(runtime.includes('runtime.mode !== MODE.NEW'));
  assert.ok(runtime.includes("cancelOutbox(tx, ref, 'runtime-not-new')"));
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
check('outbox release never blindly overwrites a blocked row', () => {
  const start = runtime.indexOf('async function releaseOutbox');
  const end = runtime.indexOf('function cancelOutbox', start);
  const body = runtime.slice(start, end);
  const reconcileStart = runtime.indexOf('async function reconcileOutbox');
  const reconcileEnd = runtime.indexOf('async function publish', reconcileStart);
  const reconcile = runtime.slice(reconcileStart, reconcileEnd);
  const resumeStart = runtime.indexOf('async function resumeOutbox');
  const resume = runtime.slice(resumeStart);
  assert.ok(start > -1 && end > start);
  assert.ok(body.includes('await db.runTransaction(async (tx) => {'));
  assert.ok(body.includes("value.status !== 'blocked'"));
  assert.ok(body.includes('tx.update(item.ref'));
  assert.equal(body.includes('await commitWrites(ops)'), false);
  assert.ok(reconcile.includes('await db.runTransaction(async (tx) => {'));
  assert.ok(resume.includes('await reconcileOutbox(doc.ref, now)'));
  assert.equal(resume.includes('await doc.ref.update('), false);
});
check('outbox expiry and active-pointer are rechecked immediately before send', () => {
  const validateStart = runtime.indexOf('async function validateOutboxForSend');
  const start = runtime.indexOf('async function deliverOutbox');
  const end = runtime.indexOf('async function resumeOutbox', start);
  const body = runtime.slice(start, end);
  const validation = runtime.slice(validateStart, start);
  const send = body.indexOf('await sendPush');
  const hook = body.lastIndexOf('await beforeOutboxSend', send);
  const guard = body.lastIndexOf('await validateOutboxForSend(ref, claimed.lease_token)', send);
  assert.ok(validateStart > -1 && start > validateStart && end > start && send > -1);
  assert.ok(hook > -1 && hook < guard && guard < send);
  assert.ok(validation.includes('await db.runTransaction(async (tx) => {'));
  assert.ok(validation.includes('outboxExpired(value, now)'));
  assert.ok(validation.includes('publicationMatches(value, pointer, publication)'));
  assert.ok(validation.includes("'publication-not-active'"));
});
check('snapshot completion rechecks live manager access after rows are staged', () => {
  const start = runtime.indexOf('async function stageSnapshot');
  const end = runtime.indexOf('async function finalizeDraft', start);
  const body = runtime.slice(start, end);
  const finalizerStart = runtime.indexOf('async function finalizeDraft');
  const finalizerEnd = runtime.indexOf('async function requireLiveManagerNow', finalizerStart);
  const finalizer = runtime.slice(finalizerStart, finalizerEnd);
  assert.ok(start > -1 && end > start);
  assert.ok(body.includes('await commitWrites(ops)'));
  assert.ok(body.includes('snapshot_complete: true'));
  assert.equal(body.includes("status: 'complete'"), false);
  assert.ok(finalizer.includes('await beforeSnapshotFinalize({ kind: \'draft\''));
  assert.ok(finalizer.includes('await db.runTransaction(async (tx) => {'));
  assert.ok(finalizer.includes('requireLiveManager('));
  assert.ok(finalizer.includes("status: 'complete'"));
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
    'publishSchedule', 'rollbackSchedule', 'getMyScheduleV2', 'getStationScheduleV2', 'respondToSchedule',
    'getScheduleManagerAccess', 'setScheduleManagerAccess']) {
    const start = index.indexOf('exports.' + name);
    assert.ok(start > -1, name);
    assert.ok(index.slice(start, start + 220).includes('enforceAppCheck: true'), name);
  }
});
check('schedule manager appointments use a server-only, strict station boundary', () => {
  assert.ok(index.includes("require('./schedule-access-admin')"));
  assert.ok(index.includes('scheduleAccessAdmin.list(req)'));
  assert.ok(index.includes('scheduleAccessAdmin.set(req)'));
  assert.ok(accessAdmin.includes("dataOf(req, ['uid', 'enabled'])"));
  assert.ok(accessAdmin.includes('const target = await getUser(uid)'));
  assert.ok(accessAdmin.includes('scheduleAccess.activeMember(profile, stationId)'));
  assert.equal(accessAdmin.includes('setCustomUserClaims'), false);
  assert.equal(accessAdmin.includes('schedule_manager === true'), false);
});
check('the legacy schedule URL is a no-data transition to the new station schedule', () => {
  assert.ok(legacySchedule.includes("location.replace('./schedule-management.html?tab=station')"));
  assert.equal(/firebase-firestore|getFirestore|collection\(|getDoc\(|onSnapshot|setDoc|updateDoc|deleteDoc|writeBatch/.test(legacySchedule), false);
});
check('legacy schedule storage is fully closed and schedule access remains private', () => {
  for (const pathName of ['rotations', 'shift_overrides']) {
    const start = rules.indexOf('match /' + pathName + '/');
    assert.ok(start > -1, pathName);
    assert.ok(rules.slice(start, start + 360).includes('allow read, write: if false'), pathName);
  }
  const start = rules.indexOf('match /schedule_access/{uid}');
  assert.ok(start > -1);
  assert.ok(rules.slice(start, start + 160).includes('allow read, write: if false'));
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
  for (const pathName of ['rotations', 'shift_overrides', 'schedule_state', 'schedule_access', 'schedule_policies', 'schedule_sources', 'schedule_drafts',
    'schedule_publications', 'schedule_responses', 'schedule_audit']) {
    const start = rules.indexOf('match /' + pathName + '/');
    assert.ok(start > -1, pathName);
    assert.ok(rules.slice(start, start + 360).includes('allow read, write: if false'), pathName);
  }
});
check('every new schedule collection has an explicit backup policy', () => {
  for (const pathName of ['schedule_state', 'schedule_access', 'schedule_policies', 'schedule_sources', 'schedule_drafts',
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
    'expired sending lease', 'rolled back only by creating a new revision',
    'blocked notification for a staging publication', 'expired notification is cancelled before delivery',
    'pointer change after claim and before send', 'concurrent outbox resumes claim',
    'revocation during snapshot finalization']) {
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
check('an unavailable runtime fails closed without reopening the legacy schedule', () => {
  assert.ok(ui.includes('showUnavailable('));
  assert.equal(ui.includes("location.replace('./schedule.html')"), false);
});
check('station schedule is the default view and denied management falls back to it', () => {
  assert.ok(ui.includes("if (name === 'manage' && (!state.status || !state.status.manager)) name = 'station'"));
  assert.ok(ui.includes("['manage', 'mine', 'station'].indexOf(name) === -1) name = 'station'"));
  assert.ok(ui.includes("|| 'station'"));
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
check('the new station schedule is the only navigation and PWA shortcut target', () => {
  assert.ok(nav.includes("href: 'schedule-management.html'"));
  assert.ok(fs.existsSync(path.join(root, 'schedule.html')));
  const shortcut = manifest.shortcuts.find((item) => item && item.short_name === 'סידור');
  assert.ok(shortcut);
  assert.equal(shortcut.url, './schedule-management.html?tab=station');
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

assert.equal(passed, 52);
console.log('\n52 schedule runtime source checks passed.');
