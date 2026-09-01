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
  // The runtime normalizes the authenticated UID before every document read.
  // Pin the authority check itself rather than an older parameter spelling.
  assert.ok(runtime.includes('scheduleAccess.isManagerAccess(access, ctx.sid, ctx.uid)'));
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
check('schedule outbox cancels recipients who left the station at every retry boundary', () => {
  const reconcileStart = runtime.indexOf('async function reconcileOutbox');
  const reconcileEnd = runtime.indexOf('async function publish', reconcileStart);
  const validateStart = runtime.indexOf('async function validateOutboxForSend');
  const deliverStart = runtime.indexOf('async function deliverOutbox');
  const resumeStart = runtime.indexOf('async function resumeOutbox', deliverStart);
  const reconcile = runtime.slice(reconcileStart, reconcileEnd);
  const validation = runtime.slice(validateStart, deliverStart);
  const delivery = runtime.slice(deliverStart, resumeStart);
  assert.ok(runtime.includes('function recipientIsActive(snap, sid)'));
  assert.ok(reconcile.includes('liveUserRef(stationId, person)'));
  assert.ok(validation.includes('liveUserRef(stationId, person)'));
  assert.ok(delivery.includes('liveUserRef(stationId, person)'));
  assert.ok(reconcile.includes("cancelOutbox(tx, ref, 'recipient-inactive')"));
  assert.ok(validation.includes("cancelOutbox(tx, ref, 'recipient-inactive')"));
  assert.ok(delivery.includes("cancelOutbox(tx, ref, 'recipient-inactive')"));
  assert.ok(integration.includes('station departure after claim is rechecked immediately before schedule push'));
  assert.ok(integration.includes('resume cancels inactive retry and expired sending rows'));
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
  assert.ok(ui.includes("if (name === 'manage' && !canManageSchedule()) name = 'station'"));
  assert.ok(ui.includes("['manage', 'mine', 'station'].indexOf(name) === -1) name = 'station'"));
  assert.ok(ui.includes("|| 'station'"));
});
check('personal schedule reads only the requested day', () => {
  assert.ok(runtime.includes('const active = await checkedActiveSnapshot(ctx, config, [date])'));
  assert.ok(ui.includes("call.mine({ date: state.mineDate || localDate() })"));
});
check('management visibility is driven by server status', () => {
  assert.ok(ui.includes("$('manageTab').hidden = !canManageSchedule()"));
  assert.ok(ui.includes("name === 'manage' && !canManageSchedule()"));
  assert.ok(ui.includes("['shadow', 'new'].indexOf(state.status.mode) !== -1"));
});
check('off and shadow schedule views use only the server-side compatibility reader', () => {
  assert.ok(runtime.includes("const effectiveReaderModule = require('./schedule-effective-reader')"));
  assert.ok(runtime.includes('async function legacyProjectionInput(ctx, range)'));
  assert.ok(runtime.includes("if (config.mode !== MODE.NEW)"));
  assert.ok(ui.includes("['off', 'shadow', 'new'].indexOf(state.status.mode) !== -1"));
  assert.ok(integration.includes('off and shadow safely expose the current station and personal legacy schedules'));
});
check('legacy compatibility reads are bounded by source-specific caps and date windows', () => {
  for (const token of ['MAX_LEGACY_ROSTER = 500', 'MAX_LEGACY_ROTATIONS = 20',
    'MAX_LEGACY_SWAPS_PER_QUERY = 250', 'MAX_LEGACY_SWAPS = 1000',
    'MAX_LEGACY_GUARDS_PER_QUERY = 250', 'MAX_LEGACY_GUARDS = 1000',
    '.limit(MAX_LEGACY_ROSTER + 1)', ".where('from_date', 'in', chunk)",
    ".where('to_date', 'in', chunk)", ".where('date', 'in', chunk)",
    '.limit(MAX_LEGACY_GUARDS_PER_QUERY + 1)', "'legacy-roster-too-large'",
    "'legacy-guards-too-large'"]) assert.ok(runtime.includes(token), token);
  assert.ok(integration.includes('legacy roster reads accept the exact cap and reject one extra record'));
  assert.ok(integration.includes('legacy guard reads reject one record above the bounded per-date cap'));
});
check('legacy overrides use canonical document ids, never an untrusted payload date query', () => {
  const start = runtime.indexOf('async function legacyProjectionInput(ctx, range)');
  const end = runtime.indexOf('function effectiveReaderFor(ctx)', start);
  const legacy = runtime.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.ok(legacy.includes("const overrideRefs = dates.map((date) => root.collection('shift_overrides').doc(date))"));
  assert.ok(legacy.includes('db.getAll.apply(db, overrideRefs)'));
  assert.ok(legacy.includes('overrideDocs.set(doc.id, doc)'));
  assert.ok(legacy.includes('compareCanonical(left.id, right.id)'));
  const beforeGuardQuery = legacy.slice(0, legacy.indexOf("root.collection('guards')"));
  assert.equal(beforeGuardQuery.includes(".where('date', 'in', chunk)"), false);
});
check('legacy guard events use a bounded trusted-station bridge before the final mode recheck', () => {
  const start = runtime.indexOf('async function legacyProjectionInput(ctx, range)');
  const end = runtime.indexOf('async function checkedLegacyWindow', start);
  const body = runtime.slice(start, end);
  const guardRead = body.indexOf("root.collection('guards')");
  const bridge = body.indexOf('events: legacyGuardEvents(guardDocs, range, roster, ctx.sid)');
  const recheck = runtime.indexOf('await beforeEffectiveViewRecheck', end);
  const boundedStart = runtime.indexOf('function boundedGuardDocuments(snapshots)');
  const boundedEnd = runtime.indexOf('async function readLiveGuardProjection', boundedStart);
  const bounded = runtime.slice(boundedStart, boundedEnd);
  assert.ok(runtime.includes("const guardEvents = require('./guard-events')"));
  assert.ok(guardRead > -1 && bridge > guardRead && recheck > bridge);
  assert.ok(body.includes('const guardDocs = boundedGuardDocuments(reads[5])'));
  assert.ok(bounded.includes('guardDocs.set(doc.id, doc)'));
  assert.ok(runtime.includes('station_id: sid'));
  assert.ok(runtime.includes('value.slots > MAX_LEGACY_GUARD_ASSIGNED'));
  assert.ok(integration.includes('legacy guards remain flexible while their schedule projection stays private'));
});
check('legacy guard rendering uses a safe station form and personal responses omit colleagues', () => {
  assert.ok(runtime.includes('function legacyDayBlock(day, viewer, events)'));
  assert.ok(runtime.includes("hours: event.start + '–' + event.end"));
  assert.ok(runtime.includes("&& (event.people || []).some((person) => person.uid === ctx.uid)"));
  assert.ok(runtime.includes('people: Object.freeze(event.people.map((uid) => knownPeople.get(uid)).filter(Boolean))'));
  assert.ok(runtime.includes('AUTH_UID_RE.test(uid)'));
  const stationGuardStart = runtime.indexOf('function stationGuardsForDate(events, date, viewer)');
  const stationGuardEnd = runtime.indexOf('function myGuardsForDate', stationGuardStart);
  const stationGuard = runtime.slice(stationGuardStart, stationGuardEnd);
  const legacyDayStart = runtime.indexOf('function legacyDayBlock(day, viewer, events)');
  const legacyDayEnd = runtime.indexOf('function legacyStationView', legacyDayStart);
  const legacyDay = runtime.slice(legacyDayStart, legacyDayEnd);
  assert.ok(stationGuard.includes('person: person.display'));
  assert.ok(legacyDay.includes('person: person.display'));
  assert.equal(stationGuard.includes('uid: person.uid'), false);
  assert.equal(legacyDay.includes('uid: person.uid'), false);
});
check('new schedule keeps guards live, private, and outside signed events and responses', () => {
  const myStart = runtime.indexOf('async function getMy(req)');
  const stationStart = runtime.indexOf('async function getStation(req)');
  const respondStart = runtime.indexOf('async function respond(req)');
  const mine = runtime.slice(myStart, stationStart);
  const station = runtime.slice(stationStart, respondStart);
  const guardCardStart = ui.indexOf('function guardCard(item)');
  const guardCardEnd = ui.indexOf('function renderMine()', guardCardStart);
  const guardCard = ui.slice(guardCardStart, guardCardEnd);
  assert.ok(runtime.includes('async function readLiveGuardProjection(ctx, dates)'));
  assert.ok(runtime.includes('function stationViewWithGuards(view, sidecar, date, viewer)'));
  assert.ok(runtime.includes('function myViewWithGuards(view, sidecar, date, viewer)'));
  assert.ok(mine.includes('readLiveGuardProjection(ctx, [date])'));
  assert.ok(station.includes('readLiveGuardProjection(ctx, dates)'));
  assert.ok(mine.indexOf('readLiveGuardProjection(ctx, [date])')
    < mine.lastIndexOf('await activeSnapshotStillCurrent(ctx, config, active)'));
  assert.ok(station.indexOf('readLiveGuardProjection(ctx, dates)')
    < station.lastIndexOf('await activeSnapshotStillCurrent(ctx, config, active)'));
  assert.ok(mine.includes('myViewWithGuards(serviceFor(ctx).buildMySchedule('));
  assert.ok(station.includes('stationViewWithGuards(serviceFor(ctx).buildStationSchedule('));
  assert.ok(runtime.includes("return 'g:' + event.id"));
  assert.ok(runtime.includes("guards_status: source.status"));
  assert.equal(guardCard.includes('answerButtons'), false);
  assert.equal(guardCard.includes('respond('), false);
  assert.ok(ui.includes("'טרם אוישה'"));
  assert.ok(ui.includes("guards_status === 'unavailable'"));
  assert.ok(integration.includes('new schedule keeps live guards flexible, private and separate from responses'));
  assert.ok(integration.includes('new schedule preserves the published view when live guard reads exceed their cap'));
  assert.ok(integration.includes('V2 pointer change after the live guard sidecar fails closed'));
  assert.ok(integration.includes('V2 mode change after the live guard sidecar fails closed'));
});
check('guard operations are server-only and use the live schedule-manager gateway', () => {
  const start = rules.indexOf('match /guards/{gId}');
  const guardRules = rules.slice(start, rules.indexOf('match /callouts/{coId}', start));
  assert.ok(start > -1);
  assert.ok(guardRules.includes('allow read, create, update, delete: if false'));
  for (const collection of ['guard_operations', 'guard_audit', 'guard_notification_jobs', 'guard_outbox']) {
    assert.ok(guardRules.includes('match /' + collection + '/'));
    assert.ok(guardRules.includes('match /' + collection));
  }
  assert.ok(runtime.includes("const guardManagement = require('./schedule-guard-management')"));
  assert.ok(runtime.includes('async function manageGuard(req)'));
  assert.ok(runtime.includes('requireLiveManager(snaps[0], snaps[1], ctx)'));
  assert.ok(runtime.includes("collection('guard_operations').doc(requestId)"));
  assert.ok(runtime.includes("'guard-revision-conflict'"));
  assert.ok(runtime.includes('async function signupGuard(req)'));
  assert.ok(runtime.includes("new FieldPath('signups', ctx.uid)"));
  assert.ok(runtime.includes('MAX_GUARD_SIGNUPS = 1000'));
  assert.ok(runtime.includes('function previousAssignmentEpochs(raw)'));
  assert.ok(runtime.includes('function nextAssignmentEpochs(raw, action, plan)'));
  assert.ok(index.includes("exports.manageScheduleGuard = onCall({ enforceAppCheck: true }"));
  assert.ok(index.includes("invokeSchedule('manageGuard', req)"));
  assert.ok(index.includes("exports.guardSignup = onCall({ enforceAppCheck: true }"));
  assert.ok(index.includes("exports.assignGuard = onCall({ enforceAppCheck: true }"));
  const signupStart = index.indexOf('exports.guardSignup =');
  const assignStart = index.indexOf('exports.assignGuard =');
  const assignEnd = index.indexOf('exports.onGuardOpen =', assignStart);
  const assignWrapper = index.slice(assignStart, assignEnd);
  const signupWrapper = index.slice(signupStart, assignStart);
  assert.ok(signupStart > -1 && assignStart > signupStart);
  assert.ok(signupWrapper.includes("invokeSchedule('signupGuard', req)"));
  assert.equal(signupWrapper.includes('callerStation('), false);
  assert.equal(signupWrapper.includes('.update('), false);
  assert.ok(assignStart > -1 && assignEnd > assignStart);
  assert.equal(assignWrapper.includes("['commander','deputy','station_commander'"), false);
  assert.ok(integration.includes('a live schedule manager can keep guards flexible without reopening a direct-write path'));
});

check('raw guard documents are closed to every browser and each legacy screen uses a scoped callable', () => {
  const guardRulesStart = rules.indexOf('match /guards/{gId}');
  const guardRules = rules.slice(guardRulesStart, rules.indexOf('match /callouts/{coId}', guardRulesStart));
  assert.ok(guardRulesStart > -1);
  assert.ok(guardRules.includes('allow read, create, update, delete: if false'));

  const directGuardRead = /collection\s*\(\s*db\s*,\s*['\"]stations['\"]\s*,[^\n;]*['\"]guards['\"]/;
  const guardedScreens = {
    'guards.html': read('guards.html'),
    'attendance.html': read('attendance.html'),
    'stats.html': read('stats.html'),
    'check.html': read('check.html'),
    'seed.js': read('seed.js')
  };
  Object.entries(guardedScreens).forEach(([name, source]) => {
    assert.equal(directGuardRead.test(source), false, name + ' must not read raw guards');
  });
  assert.equal(guardedScreens['guards.html'].includes("grab('guards'"), false);
  assert.equal(guardedScreens['stats.html'].includes("grab('guards'"), false);
  assert.equal(guardedScreens['attendance.html'].includes('guardHasMe'), false);
  assert.equal(guardedScreens['seed.js'].includes('SEED.guards'), false);
  assert.ok(guardedScreens['guards.html'].includes("'getScheduleGuardBoard'"));
  assert.ok(guardedScreens['guards.html'].includes("'getScheduleGuardManagerBoard'"));
  assert.ok(guardedScreens['attendance.html'].includes("'getMyGuardAttendance'"));
  assert.ok(guardedScreens['stats.html'].includes("'getGuardLoadStatistics'"));

  const calls = [
    ['getScheduleGuardBoard', 'getGuardBoard'],
    ['getScheduleGuardManagerBoard', 'getGuardManagerBoard'],
    ['getMyGuardAttendance', 'getMyGuardAttendance'],
    ['getGuardLoadStatistics', 'getGuardLoadStatistics']
  ];
  calls.forEach(([exportName, runtimeName]) => {
    const entry = index.indexOf('exports.' + exportName + ' =');
    const body = index.slice(entry, entry + 260);
    assert.ok(entry > -1, exportName);
    assert.ok(body.includes('enforceAppCheck: true'), exportName);
    assert.ok(body.includes("invokeSchedule('" + runtimeName + "', req)"), exportName);
  });
  const managerStart = runtime.indexOf('async function getGuardManagerBoard(req)');
  const managerEnd = runtime.indexOf('async function getMyGuardAttendance(req)', managerStart);
  const manager = runtime.slice(managerStart, managerEnd);
  assert.ok(manager.includes('requireManager(ctx)'));
  assert.ok(manager.indexOf('readGuardBoardInput(ctx, range)') < manager.indexOf('await requireLiveManagerNow(ctx)'));
  assert.ok(manager.includes('guardBoardProjection.managerBoard(input)'));
});
check('guard notification outbox is independent from the monthly publication outbox', () => {
  assert.ok(runtime.includes("collectionGroup('guard_outbox')"));
  assert.ok(runtime.includes("collectionGroup('guard_notification_jobs')"));
  assert.ok(runtime.includes('async function fanoutGuardOutbox(ref)'));
  assert.ok(runtime.includes('async function deliverGuardOutbox(ref)'));
  assert.ok(runtime.includes('async function resumeGuardOutbox()'));
  assert.ok(runtime.includes("'guard-revision-stale'"));
  assert.ok(index.includes("document: 'stations/{sid}/guard_outbox/{outboxId}'"));
  assert.ok(index.includes("document: 'stations/{sid}/guard_notification_jobs/{jobId}'"));
  assert.ok(index.includes('resumeScheduleGuardOutbox'));
  const openStart = index.indexOf('exports.onGuardOpen =');
  const openEnd = index.indexOf('exports.guardReminder =', openStart);
  const openTrigger = index.slice(openStart, openEnd);
  assert.ok(openStart > -1 && openEnd > openStart);
  assert.ok(openTrigger.includes('onDocumentCreated({'));
  assert.ok(openTrigger.includes('retry: true'));
  assert.ok(openTrigger.includes('scheduleRuntime.enqueueGuardOpenNotifications'));
  assert.equal(openTrigger.includes('pushToUsers('), false);
  assert.equal(openTrigger.includes('after.title'), false);
  assert.equal(openTrigger.includes('after.place'), false);
  assert.equal(openTrigger.includes('uidsInCrew'), false);
  assert.equal(openTrigger.includes('guardWhen('), false);
  const guardOutboxStart = runtime.indexOf('function cancelGuardOutbox');
  const guardOutbox = runtime.slice(guardOutboxStart, runtime.indexOf('return Object.freeze({', guardOutboxStart));
  const guardFanoutStart = runtime.indexOf('async function fanoutGuardOutbox(ref)');
  const guardFanoutEnd = runtime.indexOf('async function reconcileGuardNotificationJob', guardFanoutStart);
  const guardFanout = runtime.slice(guardFanoutStart, guardFanoutEnd);
  assert.ok(guardOutboxStart > -1);
  assert.ok(guardFanoutStart > -1 && guardFanoutEnd > guardFanoutStart);
  assert.ok(guardFanout.includes('tx.create(childRefs[index], child)'));
  assert.equal(guardFanout.includes('await batch.commit()'), false);
  assert.ok(runtime.includes("orderBy('created_at', 'asc')"));
  assert.ok(runtime.includes('async function enqueueGuardOpenNotifications(input)'));
  assert.ok(runtime.includes('MAX_GUARD_OPEN_AUDIENCE = 5000'));
  assert.ok(runtime.includes("collection('users')\n        .limit(MAX_GUARD_OPEN_AUDIENCE + 1)"));
  assert.ok(runtime.includes('audience_manifest: true'));
  assert.ok(runtime.includes("last_error: audience.over_limit ? 'AUDIENCE_LIMIT' : null"));
  assert.ok(runtime.includes("kind: 'open'"));
  assert.ok(runtime.includes("current.status === 'open'"));
  assert.ok(runtime.includes("type: 'guard_open', url: './guards.html', important: false"));
  assert.ok(runtime.includes("case 'open': return {"));
  assert.ok(runtime.includes('function recipientIsActive(snap, sid)'));
  assert.ok(runtime.includes("cancelGuardOutbox(tx, ref, 'recipient-inactive')"));
  assert.equal(runtime.includes('guardRecipientIsActive'), false);
  const reconcileGuardStart = runtime.indexOf('async function reconcileGuardOutbox');
  const reconcileGuardEnd = runtime.indexOf('async function resumeGuardOutbox', reconcileGuardStart);
  const reconcileGuard = runtime.slice(reconcileGuardStart, reconcileGuardEnd);
  assert.ok(reconcileGuard.includes('recipientIsActive(related[1], sid)'));
  assert.ok(integration.includes('await guardApi.resumeGuardOutbox()'));
  assert.equal(guardOutbox.includes('MODE.NEW'), false);
  const guardStatus = indexes.fieldOverrides.find((item) =>
    item.collectionGroup === 'guard_outbox' && item.fieldPath === 'status');
  const guardTtl = indexes.fieldOverrides.find((item) =>
    item.collectionGroup === 'guard_outbox' && item.fieldPath === 'expires_at');
  const operationTtl = indexes.fieldOverrides.find((item) =>
    item.collectionGroup === 'guard_operations' && item.fieldPath === 'expires_at');
  const jobStatus = indexes.fieldOverrides.find((item) =>
    item.collectionGroup === 'guard_notification_jobs' && item.fieldPath === 'status');
  const jobTtl = indexes.fieldOverrides.find((item) =>
    item.collectionGroup === 'guard_notification_jobs' && item.fieldPath === 'expires_at');
  const jobNotifications = indexes.fieldOverrides.find((item) =>
    item.collectionGroup === 'guard_notification_jobs' && item.fieldPath === 'notifications');
  const guardEpochs = indexes.fieldOverrides.find((item) =>
    item.collectionGroup === 'guards' && item.fieldPath === 'assignment_epochs');
  assert.ok(guardStatus && guardStatus.indexes.some((item) => item.queryScope === 'COLLECTION_GROUP'));
  assert.ok(guardTtl && guardTtl.ttl === true);
  assert.ok(operationTtl && operationTtl.ttl === true);
  assert.ok(jobStatus && jobStatus.indexes.some((item) => item.queryScope === 'COLLECTION_GROUP'));
  assert.ok(jobTtl && jobTtl.ttl === true);
  assert.ok(jobNotifications && Array.isArray(jobNotifications.indexes) && jobNotifications.indexes.length === 0);
  assert.ok(guardEpochs && Array.isArray(guardEpochs.indexes) && guardEpochs.indexes.length === 0);
  for (const group of ['guard_notification_jobs', 'guard_outbox']) {
    assert.ok(indexes.indexes.some((item) => item.collectionGroup === group
      && item.queryScope === 'COLLECTION_GROUP'
      && item.fields.some((field) => field.fieldPath === 'status')
      && item.fields.some((field) => field.fieldPath === 'created_at')), group);
  }
  for (const path of [
    'stations/{sid}/guard_operations/{operationId}',
    'stations/{sid}/guard_audit/{auditId}',
    'stations/{sid}/guard_notification_jobs/{jobId}',
    'stations/{sid}/guard_outbox/{outboxId}'
  ]) assert.ok(backup.includes("policy('" + path + "'"), path);
});
check('effective views recheck runtime mode and active pointers are fully bound before rendering', () => {
  for (const token of ['async function checkedLegacyWindow', 'async function checkedActiveSnapshot',
    'await beforeEffectiveViewRecheck', "'schedule-mode-changed'", "'active-publication-pointer-mismatch'",
    'meta.snapshot_complete !== true', 'meta.content_digest !== p.content_digest',
    'sliceVerifiedSnapshot(await readSnapshot(ref, meta), dates)']) assert.ok(runtime.includes(token), token);
  assert.ok(integration.includes('mode change during a legacy schedule read fails'));
  assert.ok(integration.includes('new schedule reads bind the active pointer'));
  assert.ok(integration.includes('full publication digest is verified before a one-day view is sliced'));
});
check('a V2 view fails closed when the active pointer changes during its read', () => {
  const currentStart = runtime.indexOf('async function activeSnapshotStillCurrent(ctx, config, active)');
  const start = runtime.indexOf('async function checkedActiveSnapshot(ctx, config, dates)');
  const end = runtime.indexOf('function legacyDayBlock(day, viewer, events)', start);
  const guard = runtime.slice(start, end);
  const current = runtime.slice(currentStart, start);
  const hook = guard.indexOf('await beforeEffectiveViewRecheck');
  const reread = current.indexOf('await activeRef(ctx.sid).get()');
  const failure = current.indexOf("'schedule-active-changed'");
  assert.ok(currentStart > -1 && start > currentStart && end > start);
  assert.ok(hook > -1 && reread > -1 && failure > reread);
  assert.ok(guard.includes('await activeSnapshotStillCurrent(ctx, config, active)'));
  for (const token of ['active.pointer.publication_id', 'active.pointer.revision',
    'active.pointer.content_digest']) assert.ok(current.includes(token), token);
  assert.equal(/Number\([^)]*revision/.test(current), false,
    'the final revision comparison must not coerce malformed pointer values');
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

assert.equal(passed, 64);
console.log('\n64 schedule runtime source checks passed.');
