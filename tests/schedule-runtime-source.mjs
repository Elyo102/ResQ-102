import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const runtime = read('functions/schedule-runtime.js');
const integration = read('functions/schedule-runtime.integration.test.js');
const publication = read('functions/schedule-publication.js');
const service = read('functions/schedule-service.js');
const access = read('functions/schedule-access.js');
const accessAdmin = read('functions/schedule-access-admin.js');
const legacyCompat = read('functions/schedule-legacy-compat.js');
const index = read('functions/index.js');
const rules = read('firestore.rules');
const backup = read('functions/backup-policy.js');
const author = read('functions/schedule-policy-author.js');
const modeAuthority = read('functions/schedule-mode-authority.js');
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
/* קוד בלי הערות — כדי שטענה על קוד לא תסופק על ידי הערה. */
function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

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
check('snapshot integrity includes people, absences and finite absence coverage and is rechecked on full reads', () => {
  // 4.9: החתימה מחושבת במקום אחד — stageSnapshot ו-readSnapshot משתמשים בו.
  assert.ok(runtime.includes('const contentDigest = snapshotDigest(plan, rows, orderedEvents, orderedPeople, absences, absenceCoverage);'));
  assert.ok(runtime.includes('const actualDigest = snapshotDigest(plan, rows, events, orderedPeople, absences, absenceCoverage);'));
  const at = runtime.indexOf('function snapshotDigest(plan, rows, events, people, absences, absenceCoverage)');
  const fn = runtime.slice(at, runtime.indexOf('\n  }\n', at));
  assert.ok(fn.includes('}, rows, events, people'), 'the people projection must stay inside the digest');
  assert.ok(fn.includes('if (absences.length) basis.absences = absences;'), 'absences enter the digest only when present — older publications keep their digest');
  assert.ok(fn.includes('if (absenceCoverage) basis.absence_coverage = absenceCoverage;'), 'coverage is signed only when present — older publications remain valid');
  assert.ok(runtime.includes("const ABSENCE_COVERAGE_KINDS = Object.freeze(['sick', 'reserve', 'course', 'leave'])"));
  assert.ok(runtime.includes('if (absenceCoverage) snapshotMeta.absence_coverage = absenceCoverage;'));
  assert.ok(runtime.includes("'snapshot-digest-mismatch'"));
  assert.ok(runtime.includes("absences.length !== Number(meta.absence_count || 0)"), 'absence count is verified on full reads');
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
  assert.ok(ui.includes('const expectedContentDigest = state.draftPreview.expected_content_digest'));
  assert.ok(ui.includes('expected_content_digest: expectedContentDigest'));
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
  assert.ok(runtime.includes('existingData.request_fingerprint !== fingerprintForExisting'));
  assert.ok(runtime.includes('await releaseOutbox(pubRef)'));
});
check('prepared replay is bound to intent and starts only after the fingerprint matches', () => {
  const publishStart = runtime.indexOf('async function publish(req)');
  const publishEnd = runtime.indexOf('\n  async function rollback(req)', publishStart);
  const body = runtime.slice(publishStart, publishEnd);
  const fingerprint = body.indexOf("intent: preparing ? 'prepare' : 'activate'");
  const mismatch = body.indexOf('existingData.request_fingerprint !== fingerprintForExisting');
  const activeReplay = body.indexOf('if (pointsToExisting)');
  const replay = body.indexOf("existingData.status === 'prepared'");
  assert.ok(fingerprint > -1 && mismatch > fingerprint && activeReplay > mismatch
    && replay > activeReplay,
  'publication replay is not ordered behind its intent-bound fingerprint check');
  assert.ok(body.slice(activeReplay, replay).includes('if (preparing || config.mode !== MODE.NEW'),
    'active replay can release an outbox from shadow');
  assert.ok(body.includes('return replayPreparedPublication(ctx'));
});
check('prepared replay verifies snapshot, live authority, runtime and predecessor without writes', () => {
  const start = runtime.indexOf('async function replayPreparedPublication(ctx, input)');
  const end = runtime.indexOf('\n  async function publish(req)', start);
  const body = runtime.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.ok(body.includes('await readSnapshot(value.pubRef, value.existingData)'));
  assert.ok(body.includes('await requireLiveManagerNow(ctx)'));
  assert.ok(body.includes("kind: 'prepared-replay'"));
  assert.ok(body.includes('return db.runTransaction(async (tx) => {'));
  assert.ok(body.includes('requireLiveManager(snaps[6], snaps[7], ctx)'));
  assert.ok(body.includes('liveRuntime.mode !== MODE.SHADOW'));
  assert.ok(body.includes('actualPrevious !== value.expectedPrevious'));
  assert.ok(body.includes("livePub.status !== 'prepared'"));
  assert.equal(/\btx\.(?:set|create|update|delete)\s*\(/.test(body), false,
    'prepared replay performs a transaction write');
});
check('prepared replay requires the exact unexpired blocked outbox and returns its full contract', () => {
  const start = runtime.indexOf('async function replayPreparedPublication(ctx, input)');
  const end = runtime.indexOf('\n  async function publish(req)', start);
  const body = runtime.slice(start, end);
  assert.ok(body.includes("tx.get(value.pubRef.collection('schedule_outbox'))"));
  assert.ok(body.includes('outboxSnap.size !== expectedOutbox.size'));
  assert.ok(body.includes("row.status !== 'blocked'"));
  assert.ok(body.includes('outboxExpired(row, Date.parse(clock()))'));
  for (const field of ['duplicate: true', 'prepared: true', 'publication_id: value.pubId',
    'revision: value.revision', 'notified_people: 0',
    'blocked_notifications: expectedOutbox.size', 'summary: value.summary']) {
    assert.ok(body.includes(field), field);
  }
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
  assert.ok(runtime.includes('function activeOperationalMember(user, sid)'));
  assert.ok(runtime.includes("MEMBER_ROLES.indexOf(String(user && user.role || '')) !== -1"));
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
    'getLegacyScheduleCompatibilityContext', 'getScheduleManagerAccess', 'setScheduleManagerAccess']) {
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
  // הפאנל האישי נשאר יומי גם אחרי שהלוח הפך חודשי: האישור נשלח
  // עם publication_id ו-item_id של יום, ואין קריאה שמחזירה את כל
  // מה שממתין לתשובה לאורך חודש.
  assert.ok(ui.includes("call.mine({ date: localDate() })"));
});

/* ------------------------------------------------------------------ *
 * חוקי התחנה · נתיב הכתיבה שהיה חסר
 * ------------------------------------------------------------------ */

check('the station policy has a server write path and the browser never picks the station', () => {
  assert.ok(runtime.includes('async function savePolicy(req)'));
  assert.ok(runtime.includes('async function previewPolicy(req)'));
  assert.ok(index.includes("exports.saveSchedulePolicy = onCall({ enforceAppCheck: true }"));
  assert.ok(index.includes("exports.previewSchedulePolicy = onCall({ enforceAppCheck: true }"));
  const start = runtime.indexOf('async function savePolicy(req)');
  const end = runtime.indexOf('function modeOperationRef(sid, requestId)', start);
  const save = runtime.slice(start, end);
  assert.ok(start > -1 && end > start);
  // התחנה והזהות מגיעות מ-context, ולעולם לא מגוף הבקשה.
  assert.ok(save.includes('const ctx = await context(req)'));
  assert.ok(save.includes('requireManager(ctx)'));
  assert.equal(/data\.(station_id|stationId)/.test(save), false);
});

check('saving a policy never turns the engine on by itself', () => {
  const start = runtime.indexOf('async function savePolicy(req)');
  const end = runtime.indexOf('function modeOperationRef(sid, requestId)', start);
  const save = runtime.slice(start, end);
  // המצביע למדיניות הפעילה מתעדכן; `mode` אינו נכתב כאן בשום מקרה.
  // ⭐ הכתיבה היחידה למסמך הרנטיים היא המצביע. אין כאן כתיבת mode
  // בשום צורה — הפעלת מנוע נשארת פעולה אנושית נפרדת.
  assert.equal(save.split('tx.set(runtimeRef').length, 2);
  assert.ok(save.includes("tx.set(runtimeRef(ctx.sid), { active_policy_id: plan.policy_id }, { merge: true })"));
  // הפעלה היא הצהרה מפורשת ולא ברירת מחדל.
  assert.ok(save.includes("typeof data.activate !== 'boolean'"));
  assert.ok(save.includes("'policy-activate-required'"));
});

check('a concurrent policy edit is refused instead of silently overwritten', () => {
  const start = runtime.indexOf('async function savePolicy(req)');
  const end = runtime.indexOf('function modeOperationRef(sid, requestId)', start);
  const save = runtime.slice(start, end);
  assert.ok(save.includes("if (expected !== activeId)"));
  assert.ok(save.includes("'policy-conflict'"));
  assert.ok(save.includes("'policy-request-reused'"));
  // הקלה בתקן דורשת אמירה מפורשת של אדם.
  assert.ok(save.includes("data.confirm_weakening !== true"));
  assert.ok(save.includes("'policy-weakening-unconfirmed'"));
  assert.ok(ui.includes('expected_policy_id: state.policy.active_policy_id'));
});

check('the policy author invents no business value and mirrors the runtime digest', () => {
  assert.ok(author.includes('אין ברירות מחדל עסקיות'));
  // ⭐ מראה מכוונת של stable() ברנטיים. אם אחד הצדדים ישתנה,
  // `loadPolicy` יסרב למסמך שנכתב — והתקלה תתגלה מאוחר, אצל מישהו
  // אחר. הבדיקה הזאת נועלת את שני הצדדים זה לזה.
  const mirror = author.slice(author.indexOf('function stable(value) {'));
  const source = runtime.slice(runtime.indexOf('function stable(value) {'));
  const cut = (text) => text.slice(0, text.indexOf('\n}\n') + 2);
  assert.equal(cut(mirror).split('isPlainObject').join('plain'), cut(source));
  assert.ok(author.includes("fail(code, what + ' — ערך חסר. אין ברירת מחדל.')"));
  assert.ok(author.includes('complete: true'));
  assert.equal(/require\(['"]firebase/.test(author), false);
});

/* ------------------------------------------------------------------ *
 * ההתראה אומרת מתי ואיפה
 * ------------------------------------------------------------------ */

check('a guard notice names the date, the hours and the place', () => {
  // „יש עדכון לאבטחה בסידור שלך" הוא נכון וחסר תועלת: הוא מחייב
  // לפתוח את האפליקציה רק כדי לדעת אם זה נוגע למחר.
  assert.ok(runtime.includes('function guardPlaceText(value)'));
  assert.ok(runtime.includes('function shortDate(iso)'));
  const start = runtime.indexOf('function guardOutboxText(value)');
  const end = runtime.indexOf('function guardOutboxDelivery(value)', start);
  const text = runtime.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.ok(text.includes('shortDate(value.date)'), 'התאריך אינו בהתראה');
  assert.ok(text.includes('guardPlaceText(value)'), 'המקום אינו בהתראה');
  // ⭐ המקום נלקח ממסמך האבטחה החי שכבר נקרא, ולא מעותק ישן בתור.
  assert.ok(runtime.includes('lease_token: leaseToken, place: live.place'));
  // והוא מנוקה לפני שהוא מגיע למסך נעול.
  const clean = runtime.slice(runtime.indexOf('function guardPlaceText(value)'),
    runtime.indexOf('function guardOutboxText(value)'));
  assert.ok(clean.includes('replace(CONTROL_RE'), 'תווי בקרה אינם מוסרים');
  assert.ok(clean.includes('.slice(0, 40)'), 'האורך אינו נחתך');
});

check('a schedule change notice names the date and the sub-station', () => {
  assert.ok(publication.includes('function pushBody(items, changeCount, firstPublication)'));
  assert.ok(publication.includes("sub_station_changed: 'הוזזת'"));
  // ⭐ העברה ליום אחר היא שינוי אחד, לא ביטול ותוספת.
  assert.ok(publication.includes('function pairMoves(items)'));
  assert.ok(publication.includes("ASSIGNMENT_MOVED: 'assignment_moved'"));
  // ואין „ביטול שיבוץ": שיבוץ משתנה, הוא אינו מבוטל.
  assert.equal(publication.includes("'בוטל שיבוץ'"), false);
  // רשימת ההיתר מונה רק שדות על האדם עצמו — לאן, מאיפה, ומתי.
  assert.ok(publication.includes("const PUSH_FIELDS = Object.freeze(['kind', 'date', 'from_date',"));
  // ⭐ מטען גדול מדי מצטמצם ואינו מפיל פרסום שלם.
  assert.ok(publication.includes('while (items.length > 1 && utf8Bytes(stable(push))'));
  // ⭐ ועדיין: שום שם של אדם אחר אינו נכנס למטען.
  const build = publication.slice(publication.indexOf('function buildPush'),
    publication.indexOf('function utf8Bytes'));
  // `person` הוא שם הפרמטר — הנמען עצמו. מה שאסור הוא ש**ערך**
  // שמזהה אדם ייכנס למטען.
  assert.equal(/crew|full_name|\.person\b|names/.test(build), false, build.slice(0, 400));
});

check('the month strip reads the whole verified snapshot and is bounded', () => {
  assert.ok(runtime.includes('async function getStationRange(req)'));
  assert.ok(runtime.includes('const MAX_STATION_RANGE_DAYS = 31'));
  assert.ok(index.includes("exports.getStationScheduleRange = onCall({ enforceAppCheck: true }"));
  const start = runtime.indexOf('async function getStationRange(req)');
  const end = runtime.indexOf('async function getStation(req)', start);
  const range = runtime.slice(start, end);
  assert.ok(start > -1 && end > start);
  // ⭐ dates=null במכוון: קריאת חלון מדלגת על אימות חתימת התמונה.
  assert.ok(range.includes('await checkedActiveSnapshot(ctx, config, null)'));
  assert.ok(range.includes('await activeSnapshotStillCurrent(ctx, config, active)'));
  assert.ok(range.includes('checkedLegacyWindow(ctx, config, range.from, range.to)'));
  assert.equal(/data\.(station_id|stationId)/.test(range), false);
  // הלוח התחנתי רשאי לבקש תצוגת ייבוא; הלוח האישי נשאר תמיד על
  // מקור הסידור התפעולי ואינו יורש בחירת תצוגה של מנהל.
  assert.ok(ui.includes('function fetchRange(ym, displayImported)'));
  assert.ok(ui.includes('fetchRange(state.month, true)'));
  assert.ok(ui.includes('fetchRange(state.month, false)'));
  assert.ok(ui.includes('function invalidateRange()'));
});
check('management visibility is driven by server status', () => {
  assert.ok(ui.includes("$('manageTab').hidden = !canManageSchedule()"));
  assert.ok(ui.includes("name === 'manage' && !canManageSchedule()"));
  assert.ok(ui.includes("['shadow', 'new'].indexOf(state.status.mode) !== -1"));
});
check('off and shadow schedule views use only the server-side compatibility reader', () => {
  assert.ok(runtime.includes("const effectiveReaderModule = require('./schedule-effective-reader')"));
  assert.ok(runtime.includes('async function legacyProjectionInput(ctx, range, readerArg, pinnedBasis)'));
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
  const start = runtime.indexOf('async function legacyProjectionInput(ctx, range, readerArg, pinnedBasis)');
  const end = runtime.indexOf('function effectiveReaderFor(ctx, scoped)', start);
  const legacy = runtime.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.ok(legacy.includes("const overrideRefs = dates.map((date) => root.collection('shift_overrides').doc(date))"));
  // הקריאה עוברת דרך reader: מחוץ לעסקה זה db.getAll, בתוכה tx.getAll.
  assert.ok(legacy.includes('reader.getAll(overrideRefs)'));
  const readers = runtime.slice(runtime.indexOf('function dbReader()'), start);
  assert.ok(readers.includes('db.getAll.apply(db, refs)') && readers.includes('tx.getAll.apply(tx, refs)'),
    'שני ה-readers אינם מגדירים getAll');
  assert.ok(legacy.includes('overrideDocs.set(doc.id, doc)'));
  assert.ok(legacy.includes('compareCanonical(left.id, right.id)'));
  const beforeGuardQuery = legacy.slice(0, legacy.indexOf("root.collection('guards')"));
  assert.equal(beforeGuardQuery.includes(".where('date', 'in', chunk)"), false);
});
check('legacy guard events use a bounded trusted-station bridge before the final mode recheck', () => {
  const start = runtime.indexOf('async function legacyProjectionInput(ctx, range, readerArg, pinnedBasis)');
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
  assert.ok(runtime.includes('function legacyDayBlock(day, viewer, events, primaryCrew)'));
  assert.ok(runtime.includes("hours: event.start + '–' + event.end"));
  assert.ok(runtime.includes("&& (event.people || []).some((person) => person.uid === ctx.uid)"));
  assert.ok(runtime.includes('people: Object.freeze(event.people.map((uid) => knownPeople.get(uid)).filter(Boolean))'));
  assert.ok(runtime.includes('AUTH_UID_RE.test(uid)'));
  const stationGuardStart = runtime.indexOf('function stationGuardsForDate(events, date, viewer)');
  const stationGuardEnd = runtime.indexOf('function myGuardsForDate', stationGuardStart);
  const stationGuard = runtime.slice(stationGuardStart, stationGuardEnd);
  const legacyDayStart = runtime.indexOf('function legacyDayBlock(day, viewer, events, primaryCrew)');
  const legacyDayEnd = runtime.indexOf('function legacyStationView', legacyDayStart);
  const legacyDay = runtime.slice(legacyDayStart, legacyDayEnd);
  assert.ok(legacyDay.includes('crew: primaryCrew'));
  assert.equal(legacyDay.includes('crews.size === 1'), false);
  assert.ok(stationGuard.includes('person: person.display'));
  assert.ok(legacyDay.includes('person: person.display'));
  assert.equal(stationGuard.includes('uid: person.uid'), false);
  assert.equal(legacyDay.includes('uid: person.uid'), false);
});
check('legacy compatibility uses an explicit allowlist and never a raw-document copy', () => {
  assert.ok(runtime.includes("require('./schedule-legacy-compat')"));
  for (const field of ['crew', 'position_in_cycle', 'cycle_days', 'anchor_date', 'is_active',
    'shift_start', 'shift_end', 'shift_hours', 'commander_start',
    'commander_shift_hours', 'special_end', 'special_shift_hours']) {
    assert.ok(legacyCompat.includes("'" + field + "'"), field);
  }
  assert.ok(legacyCompat.includes("const OVERRIDE_FIELDS = Object.freeze(['date', 'kind', 'crew', 'extra_crews'])"));
  for (const forbidden of ['note', 'email', 'medical', 'by_uid', 'created_at', 'updated_at']) {
    assert.equal(legacyCompat.includes(forbidden), false, forbidden);
  }
  assert.equal(legacyCompat.includes('Object.assign({}, value)'), false);
  assert.equal(/\.\.\.\s*value/.test(legacyCompat), false);
  assert.ok(legacyCompat.includes('const OVERRIDE_WARNING_BY_ERROR = Object.freeze({'));
  assert.ok(legacyCompat.includes('warnings: Object.freeze(warnings)'));
  assert.ok(legacyCompat.includes("Object.freeze({ code, count: warningCounts[code] })"));
});
check('legacy compatibility validates and normalizes a complete operational cycle', () => {
  for (const token of [
    "const CREWS = Object.freeze(['A', 'B', 'C'])",
    "const OVERRIDE_KINDS = Object.freeze(['swap', 'holiday', 'training', 'standby'])",
    'function projectRotations(entries)',
    "row.value.is_active !== false",
    'function strictNumber(value)',
    "else if (field === 'is_active') out[field] = true",
    'strictNumber(left.value.position_in_cycle) - strictNumber(right.value.position_in_cycle)',
    'ROTATION_TIMING_DEFAULTS',
    "'legacy-rotation-active-cycle'", "'legacy-rotation-crew'",
    "'legacy-rotation-anchor'", "'legacy-rotation-cycle'",
    "'legacy-rotation-position'", "'legacy-rotation-time'",
    "'legacy-rotation-hours'", "'legacy-rotation-field-consistency'",
    "'legacy-override-kind'", "'legacy-override-assignment'"
  ]) assert.ok(legacyCompat.includes(token), token);
  assert.equal(legacyCompat.includes('const hours = Number(value)'), false,
    'boolean/array/object coercion must never validate an hour field');
  assert.ok(integration.includes(
    'corrupt legacy cycles fail closed while one bad override is isolated with a stable warning'));
  assert.ok(integration.includes("{ shift_hours: true }, 'legacy-rotation-hours'"));
  assert.ok(integration.includes("date: null, kind: 'standby', crew: '', extra_crews: ['B']"));
});
check('legacy compatibility accepts only an exact bounded client date range and is App Check protected', () => {
  assert.ok(runtime.includes('legacyCompatibility.parseLegacyCompatibilityRange(req && req.data)'));
  assert.ok(legacyCompat.includes("'legacy-compatibility-request'"));
  assert.ok(legacyCompat.includes("'legacy-compatibility-range'"));
  assert.ok(legacyCompat.includes('function parseLegacyCompatibilityRange(input)'));
  assert.ok(legacyCompat.includes('const MAX_OVERRIDES = 397'));
  const start = index.indexOf('exports.getLegacyScheduleCompatibilityContext');
  assert.ok(start > -1);
  const body = index.slice(start, start + 280);
  assert.ok(body.includes('enforceAppCheck: true'));
  assert.ok(body.includes("invokeSchedule('getLegacyCompatibility', req)"));
});
check('legacy compatibility is bounded and rechecks mode and live membership after reads', () => {
  const start = runtime.indexOf('async function getLegacyCompatibility(req)');
  const end = runtime.indexOf('function effectiveReaderFor(ctx, scoped)', start);
  const body = runtime.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.ok(body.indexOf('const ctx = await context(req);')
    < body.indexOf('const range = requestedLegacyCompatibilityRange(req);'),
  'authentication and live membership must precede range parsing');
  assert.ok(body.includes("root.collection('rotations').limit(legacyCompatibility.MAX_ROTATIONS + 1)"));
  assert.ok(body.includes("root.collection('shift_overrides')"));
  assert.ok(body.includes('.orderBy(FieldPath.documentId()).startAt(range.from).endAt(range.to)'));
  assert.ok(body.includes('.limit(legacyCompatibility.MAX_OVERRIDES + 1).get()'));
  assert.ok(body.includes("before.mode === MODE.NEW"));
  assert.ok(body.includes("kind: 'legacy-compatibility'"));
  assert.ok(body.includes('configuration(ctx.sid)'));
  assert.ok(body.includes('liveUserRef(ctx.sid, ctx.uid).get()'));
  assert.ok(body.includes('requireLiveCompatibilityViewer(finalReads[1], ctx)'));
  assert.ok(body.includes("reportRuntimeError('legacy-compatibility-unexpected')"));
  assert.ok(runtime.includes("reportError(code)"));
  assert.ok(integration.includes(
    'unexpected compatibility failures emit only one stable non-PII code'));
});
check('emulator coverage includes compatibility privacy, identity, mode, ranges and caps', () => {
  for (const token of ['active members receive only allow-listed legacy compatibility fields',
    'foreign, inactive and unapproved identities cannot read compatibility data',
    'verified super compatibility access survives missing or legacy station membership',
    'new mode explicitly refuses the legacy compatibility endpoint',
    'a mode switch during compatibility reads fails closed',
    'a station membership change during compatibility reads fails closed',
    'rotation reads accept the cap and reject one extra row',
    'accepts 397 inclusive days and rejects a 398-day request',
    'override query includes both boundaries and isolates malformed rows only inside the range',
    'all malformed overrides return valid rotations, no rows and exact non-PII warning counts']) {
    assert.ok(integration.includes(token), token);
  }
});
check('new schedule keeps guards live, private, and outside signed events and responses', () => {
  const myStart = runtime.indexOf('async function getMy(req)');
  const stationStart = runtime.indexOf('async function getStation(req)');
  const respondStart = runtime.indexOf('async function respond(req)');
  const mine = runtime.slice(myStart, stationStart);
  const station = runtime.slice(stationStart, respondStart);
  const guardCardStart = ui.indexOf('function guardCard(item)');
  const guardCardEnd = ui.indexOf('function renderMineToday()', guardCardStart);
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
check('guard operations are server-only and use a separate live guard-management gateway', () => {
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
  assert.ok(runtime.includes('requireLiveGuardManager(snaps[0], snaps[1], ctx)'));
  assert.ok(runtime.includes("const GUARD_STAFF_ROLES = ANALYTICS_ROLES"));
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
  assert.ok(guardedScreens['guards.html'].includes("'getGuardManagementStatus'"));
  assert.ok(guardedScreens['attendance.html'].includes("'getMyGuardAttendance'"));
  assert.ok(guardedScreens['stats.html'].includes("'getGuardLoadStatistics'"));

  const calls = [
    ['getGuardManagementStatus', 'getGuardManagementStatus'],
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
  assert.ok(manager.includes('requireGuardManager(ctx)'));
  assert.ok(manager.indexOf('readGuardBoardInput(ctx, range)') < manager.indexOf('await requireLiveGuardManagerNow(ctx)'));
  assert.ok(manager.includes('guardBoardProjection.managerBoard(input)'));
});

check('a verified super claim receives every schedule capability without a legacy station profile', () => {
  assert.ok(index.includes("return !!(auth && auth.token && auth.token.super === true)"));
  assert.ok(runtime.includes('manager: superUser || scheduleAccess.isManagerAccess(access, sid, uid)'));
  assert.ok(runtime.includes('if (!userSnap.exists && !superUser)'));
  assert.ok(runtime.includes('function requireLiveManager(userSnap, accessSnap, ctx)'));
  assert.ok(runtime.includes('if (ctx.super) return;'));
  assert.ok(runtime.includes('if (ctx.super) return { uid: ctx.uid, role: ctx.role, super: true };'));
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

check('guard reminders skip completed work and recheck every recipient against live station membership', () => {
  const start = index.indexOf('exports.guardReminder =');
  const end = index.indexOf('// ---------- תקלה משביתה', start);
  const reminder = index.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.ok(reminder.includes("v.status === 'cancelled' || v.status === 'done'"));
  assert.ok(reminder.includes("db.doc('stations/' + sid + '/users/' + uid)"));
  assert.ok(reminder.includes('scheduleAccessModule.activeMember(profile, sid)'));
  assert.ok(reminder.includes("scheduleRuntimeModule.MEMBER_ROLES.indexOf(String(profile.role || '')) !== -1"));
  assert.equal(runtime.match(/const MEMBER_ROLES = Object\.freeze\(\[[\s\S]*?\]\);/)?.[0]
    .includes("'district_commander'"), false);
  assert.ok(reminder.includes("pushToUsers(sid, liveUids, 'guard_mine'"));
  assert.equal(reminder.includes("pushToUsers(sid, uids, 'guard_mine'"), false);
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
  const end = runtime.indexOf('function legacyDayBlock(day, viewer, events, primaryCrew)', start);
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
  // סידור התחנה נקרא כרצועת חודש, ולא יום-יום. `getStationScheduleV2`
  // נשאר בשרת לצרכנים אחרים, אך המסך הזה אינו קורא לו עוד.
  assert.ok(ui.includes("getStationScheduleRange"));
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

// ⭐ נוסף אחרי תקלה אמיתית: `CONTROL_RE` נכתב עם תו NUL אמיתי במקום
// עם רצף הבריחה. הקוד עבד, כל הבדיקות עברו — אבל גיט סיווג את
// הקובץ כבינארי, ולכן הוא לא הציג diff בשום ביקורת קוד. קובץ
// שאי אפשר לסקור הוא קובץ שאי אפשר למזג בבטחה.
check('schedule source files carry no raw control bytes', () => {
  const files = ['functions/schedule-runtime.js', 'functions/schedule-policy-author.js',
    'functions/schedule-mode-authority.js', 'functions/schedule-source-author.js',
    'functions/schedule-publication.js', 'schedule-management.js'];
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(root, name));
    for (const byte of bytes) {
      // מותרים: \t (9), \n (10), \r (13). כל שאר תווי הבקרה אסורים.
      if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) {
        assert.fail(name + ' מכיל תו בקרה גולמי 0x' + byte.toString(16)
          + ' — יש לכתוב אותו כרצף בריחה');
      }
      if (byte === 0x7f) assert.fail(name + ' מכיל DEL גולמי');
    }
  }
});

/* ⭐ P0-1. שלוש טענות שנועדו למנוע חזרה של המחיקה השקטה: המקור
 * הפעיל נקרא עם התוכן שעובר, וכל ארבעת התת-אוספים נכתבים. מקור
 * שנכתב עם `people` בלבד נראה תקין ונקרא כריק. */
check('the active source is read through the verified loader, not a lookalike', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function readActiveSource(');
  assert.ok(at > -1, 'readActiveSource לא נמצא');
  const body = src.slice(at, src.indexOf('\n  }', at));
  assert.ok(/await loadSource\(/.test(body),
    'readActiveSource אינו עובר דרך loadSource');
  assert.ok(!/collection\('(people|availability|locked|events)'\)/.test(body),
    'readActiveSource משכפל את קריאת תת-האוספים במקום להשתמש ב-loader המאומת');
  assert.ok(body.indexOf('carried:') > -1, 'readActiveSource אינו מחזיר carried');
  assert.ok(body.indexOf('content_key') > -1,
    'content_key אינו מועבר לזיהוי יבוא שלא השתנה');

  const loadAt = src.indexOf('async function loadSource(');
  assert.ok(loadAt > -1, 'loadSource לא נמצא');
  const loadBody = src.slice(loadAt, loadAt + 5000);
  for (const group of ['people', 'availability', 'locked', 'events']) {
    assert.ok(loadBody.indexOf("collection('" + group + "')") > -1,
      'loadSource אינו קורא את ' + group);
  }
  assert.ok(loadBody.indexOf('source-count-mismatch') > -1,
    'loadSource אינו משווה ספירות למסמכים בפועל');
  assert.ok(loadBody.indexOf('source-digest-mismatch') > -1,
    'loadSource אינו מאמת מחדש את החתימה');
});

check('source content keys are recomputed from the verified people projection', () => {
  const src = read('functions/schedule-runtime.js');
  const loadAt = src.indexOf('async function loadSource(');
  assert.ok(loadAt > -1, 'loadSource לא נמצא');
  const loadBody = src.slice(loadAt, loadAt + 6000);
  assert.ok(/const actualContentKey = String\(hash\(stable\(\{\s*station_id: meta\.station_id,\s*people: peopleRaw\s*\}\)\)\)/s.test(loadBody),
    'content_key אינו מחושב מחדש מהתחנה ומהסגל המאומת');
  assert.ok(loadBody.indexOf('meta.content_key !== actualContentKey') > -1,
    'content_key השמור אינו מושווה לערך המחושב');
  assert.ok(loadBody.indexOf("'source-content-key-mismatch'") > -1,
    'אי-התאמת content_key אינה נכשלת סגור');
  assert.ok(loadBody.indexOf('contentKey: actualContentKey') > -1,
    'ה-loader עדיין מחזיר content_key לא מאומת מהמטא-דאטה');
  assert.equal(loadBody.indexOf('contentKey: meta.content_key'), -1,
    'ה-loader סומך ישירות על content_key לא חתום');
});

check('source staging is request-specific and closing verifies ownership', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function saveSource(');
  const body = src.slice(at, src.indexOf('\n  /* מוחק מקור מדורג', at));
  assert.ok(/source-stage\|/.test(body),
    'מזהה staging אינו קשור לבקשה');
  assert.ok(!/sourceRef\(ctx\.sid, plan\.source_id\)/.test(body),
    'המקור המדורג עדיין משתמש במזהה התוכן המשותף');
  for (const guard of ['staged_by_request', 'staged_request_hash', 'staged_owner_token',
    'staged_content_digest']) {
    assert.ok(body.indexOf(guard) > -1, 'חסרה הגנת staging: ' + guard);
  }
  assert.ok(body.indexOf('requirePendingSourceOperation(') > -1,
    'הסגירה אינה מאמתת בעלות על operation');
  assert.ok(body.indexOf('requireOwnedStagedSource(') > -1,
    'הסגירה אינה מאמתת בעלות על staging');
  for (const guard of ['source-staging-lost', 'source-staging-changed']) {
    assert.ok(src.indexOf(guard) > -1, 'חסר קוד כשל סגור: ' + guard);
  }
});

check('every source child chunk is fenced by the current operation and staging owners', () => {
  const src = read('functions/schedule-runtime.js');
  const helperAt = src.indexOf('async function commitOwnedSourceWrites(');
  const helperEnd = src.indexOf('\n  // ⭐ הדוח', helperAt);
  assert.ok(helperAt > -1 && helperEnd > helperAt,
    'כותב ה-chunks המגודר לא נמצא');
  const helper = src.slice(helperAt, helperEnd);
  assert.ok(helper.indexOf('db.runTransaction') > -1,
    'כתיבת source child chunks אינה טרנזקציונית');
  assert.ok(helper.indexOf('tx.get(control.opRef)') > -1,
    'כל chunk אינו קורא מחדש את operation');
  assert.ok(helper.indexOf('tx.get(control.ref)') > -1,
    'כל chunk אינו קורא מחדש את staging');
  assert.ok(helper.indexOf('requirePendingSourceOperation(') > -1,
    'כל chunk אינו מאמת את owner token של operation');
  assert.ok(helper.indexOf('requireOwnedStagedSource(') > -1,
    'כל chunk אינו מאמת את owner token של staging');
  assert.ok(helper.indexOf('lease_until: new Date(') > -1,
    'כותב פעיל אינו מחדש lease בכל chunk');
  assert.ok(src.indexOf('MAX_SOURCE_TRANSACTION_BYTES = 7 * 1024 * 1024') > -1,
    'החלוקה אינה שומרת מרווח ממגבלת 10MiB של Firestore');

  const saveAt = src.indexOf('async function saveSource(');
  const cleanupAt = src.indexOf('async function cleanupStagedSource(', saveAt);
  const saveBody = src.slice(saveAt, cleanupAt);
  assert.ok(saveBody.indexOf('commitOwnedSourceWrites(') > -1,
    'saveSource אינו משתמש בכותב המגודר');
  assert.equal(saveBody.indexOf('await commitWrites([].concat('), -1,
    'saveSource עדיין כותב children בבאצ׳ לא מגודר');
});

check('staged cleanup claims ownership and deletes the parent last', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function cleanupStagedSource(');
  assert.ok(at > -1, 'cleanupStagedSource לא נמצא');
  const body = src.slice(at, src.indexOf('\n  function policyOperationRef(', at));
  const claim = body.indexOf('cleanup_claimed_by: cleanupToken');
  const children = body.indexOf("collection('people').doc(");
  const parent = body.lastIndexOf('tx.delete(ref)');
  assert.ok(claim > -1 && children > claim, 'הניקוי מוחק ילדים לפני תפיסת בעלות');
  assert.ok(parent > children, 'הניקוי מוחק את האב לפני הילדים');
  assert.ok(body.indexOf('sourceWriteChunks(deletes)') > -1,
    'הניקוי המיידי אינו שומר על מגבלת נפח הטרנזקציה');
  assert.ok(body.indexOf('ownsCleanup(') > -1
    && body.indexOf('cleanup_lease_until') > -1,
  'מחיקת children אינה מגודרת ב-token וב-lease');
});

check('saveSource writes all four sub-collections, not people alone', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function saveSource(');
  assert.ok(at > -1, 'saveSource לא נמצא');
  const body = src.slice(at, src.indexOf('\n  async function ', at + 10));
  for (const group of ['people', 'availability', 'locked', 'events']) {
    assert.ok(body.indexOf("collection('" + group + "').doc(") > -1,
      'saveSource אינו כותב את ' + group);
  }
});

check('the author never hard-codes an empty carry basis again', () => {
  const src = read('functions/schedule-source-author.js');
  // הצורה שהייתה הבאג: ארבעה ליטרלים ריקים בתוך הבסיס החתום.
  assert.ok(!/carry: \{\},\s*counts,\s*people,\s*availability: \{\}/.test(src),
    'הבסיס החתום חזר לליטרלים ריקים — זו בדיוק המחיקה של P0-1');
  assert.ok(src.indexOf('function carriedFrom(') > -1,
    'carriedFrom נעלם; אין מי שיקרא את התוכן שעובר');
});

/* ⭐ P0-2 · שלוש תצוגות החזירו לוח ריק כשהמצב `new` ואין פרסום פעיל.
 * על המסך זה אינו „אין מידע" אלא כבאי שרואה שאין לו משמרות. */
check('no schedule view can answer with an empty board', () => {
  const src = read('functions/schedule-runtime.js');
  const code = src.split('\n')
    .filter((line) => line.trim().indexOf('*') !== 0 && line.indexOf('//') !== 0)
    .join('\n');
  // הצורה שהייתה הבאג. היא לא חוזרת בלי שהבדיקה תיפול.
  assert.ok(!/active: false, days: \[\]/.test(code),
    'תצוגה מחזירה לוח ריק — זה בדיוק חלון ה-cutover הריק');
  assert.ok(!/if \(!active\) return \{ mode: config\.mode, active: false \}/.test(code),
    'תצוגת יום מחזירה active:false בלי נפילה ל-legacy');
  assert.ok(src.indexOf('async function legacyFallbackWindow(') > -1,
    'אין נפילה מסודרת ל-legacy');
});

check('every view without an active snapshot falls back to legacy', () => {
  const src = read('functions/schedule-runtime.js');
  for (const fn of ['async function getMy(', 'async function getStation(',
    'async function getStationRange(']) {
    const at = src.indexOf(fn);
    assert.ok(at > -1, fn + ' לא נמצא');
    const body = src.slice(at, at + 4000);
    const guard = body.indexOf('if (!active)');
    assert.ok(guard > -1, fn + ' אינו בודק היעדר תמונה פעילה');
    // ⭐ בתוך אותו בלוק חייבת להיות נפילה ל-legacy, ולא החזרת ריק.
    assert.ok(body.slice(guard, guard + 400).indexOf('legacyFallbackWindow') > -1,
      fn + ' אינו נופל ל-legacy כשאין תמונה פעילה');
  }
});

/* ⭐ P0-2 · חוזה המעבר. אלה הטענות שמונעות מהמעבר לחזור להיות
 * „החלף מצב ותקווה". */
check('preparing in shadow never activates, notifies or moves the pointer', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function publish(req)');
  assert.ok(at > -1);
  const body = src.slice(at, src.indexOf('\n  async function ', at + 10));
  assert.ok(body.indexOf('const preparing = config.mode === MODE.SHADOW;') > -1,
    'הכוונה אינה נגזרת מהמצב');
  assert.ok(/requireMode\(config, \[MODE\.NEW, MODE\.SHADOW\]\)/.test(body),
    'publish אינו מותר ב-shadow, ולכן חלון הלוח הריק נשאר פתוח');
  assert.ok(/tx\.update\(pubRef, \{\s*status: 'prepared'/.test(body),
    'הכנה אינה מסמנת prepared');
  // ⭐ B (seq379) · המניפסט של התור נכתב באותה עסקה עם הסימון.
  assert.ok(/status: 'prepared',[\s\S]{0,200}outbox_manifest: outboxManifestFor\(planned\.notifications\)/.test(body),
    'הכנה אינה כותבת מניפסט תור באותה עסקה');
  // ⭐ הליבה: ההודעות משתחררות רק כשהפרסום באמת פעיל.
  assert.ok(body.indexOf('if (!preparing) await releaseOutbox(pubRef);') > -1,
    'הכנה משחררת הודעות על סידור שאיש אינו רואה');
});

check('the only road into new mode is the signed cutover, and it ships', () => {
  /* ⭐ שונה עם הכרעת אלדד (3.9.2026): המעבר נשלח בנוי ואינרטי.
   * הבדיקה הקודמת דרשה שלא יהיה callable ושלא יהיה מעבר; עכשיו היא
   * דורשת שיהיו — ושהמתג הכללי יישאר חסום, לפני ה-replay. */
  assert.equal(index.includes("exports.promoteScheduleToNew = onCall({ enforceAppCheck: true }"), true,
    'promoteScheduleToNew אינו מיוצא, או מיוצא בלי App Check');
  assert.equal(modeAuthority.includes("from: MODE.SHADOW, to: MODE.NEW, kind: 'promote'"), true,
    'המעבר shadow→new אינו ברשימת המעברים');
  const at = runtime.indexOf('async function setRuntimeMode(req)');
  const end = runtime.indexOf('\n  async function runPlanner(req)', at);
  const body = runtime.slice(at, end);
  const guard = body.indexOf("if (data.target === MODE.NEW)");
  const replay = body.indexOf('const opRef = modeOperationRef(');
  assert.ok(guard > -1, 'setRuntimeMode אינו דוחה new במפורש');
  assert.ok(replay > guard, 'הדחייה אחרי ה-replay — בקשה ישנה יכולה להחזיר הצלחת הפעלה');
  assert.ok(body.slice(guard, guard + 400).includes("'cutover-required'"),
    'הדחייה ללא קוד יציב אחד');
  assert.ok(!body.includes("'mode-cutover-disabled'"), 'נשאר קוד שני לאותה דחייה');
});

check('cutover preview reads the verified publication rows', () => {
  const at = runtime.indexOf('async function previewCutover(req)');
  const end = runtime.indexOf('\n  async function promoteToNew(req)', at);
  const body = runtime.slice(at, end);
  assert.ok(body.includes('next_days: cutoverDaysFromRows(snapshot.plan.rows)'),
    'preflight is not built from snapshot.plan.rows');
  assert.equal(body.includes('snapshot.plan.days || snapshot.rows'), false,
    'the empty-candidate fallback that made preflight false-green returned');
});

check('the cutover is one transaction, decided on live values', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function promoteToNew(req)');
  assert.ok(at > -1, 'promoteToNew לא נמצא');
  const body = src.slice(at, src.indexOf('\n  async function ', at + 10));
  assert.ok(body.indexOf('cutover.decidePromotion(') > -1,
    'ההכרעה אינה נעשית במודול הטהור');
  // ההכרעה חייבת להיות בתוך הטרנזקציה, לא לפניה.
  const tx = body.indexOf('db.runTransaction');
  assert.ok(tx > -1 && body.indexOf('cutover.decidePromotion(') > tx,
    'ההכרעה מתקבלת מחוץ לטרנזקציה — הערכים יכולים להשתנות אחריה');
  for (const write of ["tx.update(pubRef, { status: 'active'", 'tx.set(activeRef(ctx.sid)',
    'tx.set(runtimeRef(ctx.sid), { mode: MODE.NEW }']) {
    assert.ok(body.indexOf(write) > -1, 'המעבר אינו כותב ' + write);
    assert.ok(body.indexOf(write) > tx, write + ' נכתב מחוץ לטרנזקציה');
  }
  // ⭐ ההודעות אחרי ה-commit, לעולם לא בתוכו.
  const release = body.indexOf('await releaseOutbox(pubRef);');
  assert.ok(release > body.lastIndexOf('});'),
    'ה-outbox משתחרר בתוך הטרנזקציה');
  // ושער הפיקוד, לא שער המנהל.
  assert.ok(body.indexOf('mayChangeMode') > -1, 'המעבר אינו עובר בשער הפיקוד');
  assert.ok(body.replace(/\/\*[\s\S]*?\*\//g, ' ').indexOf('requireManager') === -1,
    'מינוי אחראי סידור פותח את שער המעבר');
});

check('a prepared publication keeps its notifications while it waits', () => {
  const src = read('functions/schedule-runtime.js');
  // ⭐ בלי שני אלה, תור ההודעות של הפרסום המוכן נמחק בזמן ההמתנה
  // ב-shadow, והמעבר היה קורה בלי שאיש יקבל הודעה.
  assert.ok(/runtime\.mode === MODE\.SHADOW && status === 'blocked'/.test(src),
    'שורת המתנה ב-shadow מבוטלת');
  assert.ok(/publication\.status === 'prepared'/.test(src),
    'פרסום מוכן אינו מוכר למתזמן ההודעות');
});

/* ⭐ P1-7 · מקור מדורג שננטש מחזיק שמות מלאים. */
check('an abandoned staged source is cleaned explicitly without a parent-only TTL', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function saveSource(');
  const body = src.slice(at, src.indexOf('\n  async function cleanupStagedSource', at));
  assert.ok(body.indexOf('expires_at: sourceOperationExpiry()') > -1,
    'המסמך המדורג נכתב בלי תאריך תפוגה');
  assert.ok(/cleanupStagedSource\(ctx\.sid, ref, staged, requestId, requestHash,\s*operationOwner\)/
    .test(body),
    'אין ניקוי מפורש כשהסגירה נכשלת');
  assert.ok(body.indexOf('expires_at: FV.delete()') > -1,
    'תאריך התפוגה אינו מנוקה בסגירה — מקור שלם ימחק מעצמו');
  // ⭐ TTL של Firestore אינו יורד לתת-אוספים, ולכן הניקוי חייב
  // למחוק אותם בעצמו.
  const cleanup = src.slice(src.indexOf('async function cleanupStagedSource'));
  for (const group of ['people', 'availability', 'locked', 'events']) {
    assert.ok(cleanup.indexOf("collection('" + group + "')") > -1,
      'הניקוי אינו מוחק את ' + group);
  }
  const indexes = JSON.parse(read('firestore.indexes.json'));
  assert.equal(indexes.fieldOverrides.some((item) =>
    item.collectionGroup === 'schedule_sources' && item.fieldPath === 'expires_at'
    && item.ttl === true), false,
  'TTL על האב schedule_sources מוחק עוגן איתור ומשאיר ילדים יתומים');
  assert.ok(indexes.fieldOverrides.some((item) =>
    item.collectionGroup === 'schedule_sources' && item.fieldPath === 'expires_at'
    && item.ttl !== true && Array.isArray(item.indexes)
    && item.indexes.some((index) => index.order === 'ASCENDING'
      && index.queryScope === 'COLLECTION_GROUP')),
  'חסר אינדקס collection-group למנקה המקורות המדורגים');
  assert.ok(src.indexOf("collectionGroup('schedule_sources')") > -1
    && src.indexOf(".where('expires_at', '<=', new Date(startedAt))") > -1
    && src.indexOf('.limit(sourceSweepCandidateLimit)') > -1,
  'המנקה אינו מאתר מועמדים שפגו בשאילתה מוגבלת');
  assert.ok(src.indexOf('bytes + documentBytes > MAX_SOURCE_TRANSACTION_BYTES') > -1,
    'מנקה הילדים מוגבל לפי כמות בלבד ולא לפי נפח Firestore');
  const indexSource = read('functions/index.js');
  assert.ok(indexSource.indexOf('exports.sweepExpiredScheduleSources = onSchedule({') > -1
    && indexSource.indexOf('scheduleRuntime.sweepExpiredSources()') > -1,
  'מנקה המקורות אינו מחובר לריצה שרתית מתוזמנת');
  for (const group of [
    'schedule_policy_operations', 'schedule_mode_operations', 'schedule_source_operations'
  ]) {
    assert.ok(indexes.fieldOverrides.some((item) =>
      item.collectionGroup === group && item.fieldPath === 'expires_at'
      && item.ttl === true), 'חסר TTL ליומן פעולות זמני: ' + group);
  }
});

check('the closing transaction re-reads the operation and the live policy', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function saveSource(');
  const tx = src.indexOf('await db.runTransaction', at);
  const body = src.slice(tx, src.indexOf('\n    } catch (error) {', tx));
  assert.ok(body.indexOf('tx.get(opRef)') > -1,
    'מזהה הפעולה אינו נבדק שוב בתוך הטרנזקציה');
  assert.ok(body.indexOf("'source-policy-changed'") > -1,
    'חוקי התחנה אינם נבדקים שוב בתוך הטרנזקציה');
});

check('unchanged source saves claim idempotency inside a live CAS transaction', () => {
  const src = read('functions/schedule-runtime.js');
  const saveAt = src.indexOf('async function saveSource(');
  const branchAt = src.indexOf("if (plan.kind === 'unchanged')", saveAt);
  const branchEnd = src.indexOf('const sourceId =', branchAt);
  assert.ok(saveAt > -1 && branchAt > saveAt && branchEnd > branchAt,
    'ענף unchanged של saveSource לא נמצא');
  const body = src.slice(branchAt, branchEnd);
  assert.ok(body.indexOf('db.runTransaction') > -1,
    'unchanged כותב מחוץ לטרנזקציה');
  assert.ok(body.indexOf('tx.get(opRef)') > -1,
    'unchanged אינו קורא את operation בתוך הטרנזקציה');
  assert.ok(body.indexOf('requireLiveManager(') > -1,
    'unchanged אינו קורא מחדש הרשאה חיה');
  assert.ok(body.indexOf("'source-conflict'") > -1,
    'unchanged אינו מבצע CAS על המצביע הפעיל');
  assert.ok(body.indexOf("'source-policy-changed'") > -1,
    'unchanged אינו מאמת מחדש את המדיניות הפעילה');
  assert.ok(body.indexOf("'source-request-reused'") > -1,
    'unchanged אינו דוחה שימוש חוזר ב-request_id עם hash אחר');
  assert.ok(body.indexOf('tx.set(opRef') > -1,
    'unchanged אינו רושם את הפעולה באותה טרנזקציה');
  assert.equal(body.indexOf('opRef.set('), -1,
    'unchanged עדיין מבצע כתיבה עיוורת מחוץ לטרנזקציה');
});

/* ⭐ P1-2 · הרשאה נקראת חיה ברגע הכתיבה, לא מהטוקן בתחילת הבקשה. */
check('savePolicy and setRuntimeMode re-read live identity inside the transaction', () => {
  const src = read('functions/schedule-runtime.js');
  const policyAt = src.indexOf('async function savePolicy(');
  const policyTx = src.indexOf('db.runTransaction', policyAt);
  const policyBody = src.slice(policyTx, policyTx + 2500);
  assert.ok(policyBody.indexOf('requireLiveManager(') > -1,
    'savePolicy אינו קורא את המינוי החי בתוך הטרנזקציה');
  assert.ok(policyBody.indexOf('tx.get(liveUserRef(') > -1,
    'savePolicy אינו קורא את המשתמש החי בתוך הטרנזקציה');

  const modeAt = src.indexOf('async function setRuntimeMode(');
  const modeTx = src.indexOf('db.runTransaction', modeAt);
  const modeBody = src.slice(modeTx, modeTx + 2500);
  assert.ok(modeBody.indexOf('tx.get(liveUserRef(') > -1,
    'setRuntimeMode אינו קורא את המשתמש החי בתוך הטרנזקציה');
  assert.ok(modeBody.indexOf("'mode-actor-inactive'") > -1,
    'setRuntimeMode אינו חוסם משתמש שאינו פעיל');
});

check('expected_mode is mandatory, not merely honoured when present', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function setRuntimeMode(');
  const body = src.slice(at, at + 4000);
  assert.ok(body.indexOf("'mode-expected-required'") > -1,
    'אפשר להשמיט expected_mode ולקבל דריסה עיוורת');
  // ⭐ והצורה שהייתה הבאג: בדיקה רק אם השדה נמסר.
  assert.ok(!/if \(nonEmpty\(data\.expected_mode\) && data\.expected_mode !== before\.mode\)/
    .test(body), 'expected_mode נבדק רק כשהוא נמסר');
});

/* ⭐ החוזה בין `readSnapshot` לבין ה-preflight. הוא נשבר פעם אחת
 * בשקט: קריאה מנתיב שאינו קיים החזירה ריק, ו-`||` הסתיר את זה. */
check('the cutover preflight reads the snapshot rows from the real path', () => {
  const src = read('functions/schedule-runtime.js');
  assert.ok(src.indexOf('next_days: cutoverDaysFromRows(snapshot.plan.rows)') > -1,
    'ה-preflight אינו קורא את plan.rows');
  // הצורה שהייתה הבאג — ושני הנתיבים שבה אינם קיימים.
  assert.ok(!/snapshot\.plan\.days/.test(src),
    'חזרה קריאה מ-plan.days, שאינו קיים');
  // ו-`readSnapshot` באמת מחזיר `rows` בתוך `plan`.
  const at = src.indexOf('const plan = {');
  const planLiteral = src.slice(at, src.indexOf('};', at));
  assert.ok(/\brows,/.test(planLiteral),
    'readSnapshot אינו מחזיר rows בתוך plan — החוזה השתנה');
});

/* ⭐ החיבור שנשבר בשקט: המעבר האטומי נבנה, יוצא ב-index.js — ולא
 * היה על המסלול של המסך בכלל. */
check('the cutover is the only road into new mode', () => {
  const runtime = read('functions/schedule-runtime.js');
  const at = runtime.indexOf('async function setRuntimeMode(');
  const body = runtime.slice(at, runtime.indexOf('\n  async function ', at + 10));
  assert.ok(body.indexOf("'cutover-required'") > -1,
    'setRuntimeMode עדיין מרשה כניסה ישירה ל-new');
  // ⭐ ולפני ה-replay (Codex, 93e74be): בקשה ישנה אינה מחזירה הצלחה.
  const forbid = body.indexOf("'cutover-required'");
  const replay = body.indexOf('const opRef = modeOperationRef(');
  assert.ok(replay > -1 && forbid > -1 && forbid < replay,
    'הסירוב אחרי ה-replay — ניסיון חוזר ישן יכול להחזיר הצלחת הפעלה');
});

check('the screen actually calls the cutover it was given', () => {
  const ui = read('schedule-management.js');
  for (const name of ['previewScheduleCutover', 'promoteScheduleToNew']) {
    assert.ok(ui.indexOf("httpsCallable(functions, '" + name + "')") > -1,
      'המסך אינו יוצר callable עבור ' + name);
  }
  // ומעבר ל-new עובר דרכו, ולא דרך החלפת מצב.
  assert.ok(/if \(target === 'new'\) \{ await promoteToNew\(\); return; \}/.test(ui),
    'המסך עדיין שולח מעבר ל-new דרך setScheduleRuntimeMode');
  assert.ok(ui.indexOf('call.cutoverPreview(') > -1
    && ui.indexOf('call.cutoverPromote(') > -1,
    'זרימת prepare→preflight→promote אינה במסך');
  // ⭐ ההכנה ב-shadow אינה no-op שקט.
  const pub = ui.slice(ui.indexOf('async function publishDraft('));
  assert.ok(!/state\.status\.mode !== 'new'/.test(pub.slice(0, 400)),
    'publishDraft עדיין חוזר מיד כשהמצב אינו new — כפתור ההכנה שקט');
  assert.ok(pub.indexOf('const preparing = state.status.mode === ') > -1,
    'publishDraft אינו מבחין בין הכנה לפרסום');
  // ומזהה הבקשה נשמר לניסיון חוזר.
  assert.ok(ui.indexOf('state.cutoverRequestId') > -1,
    'אין request_id שנשמר לניסיון חוזר אחרי כשל רשת');
});

check('command can discover a prepared candidate without the manager', () => {
  const runtime = read('functions/schedule-runtime.js');
  assert.ok(runtime.indexOf('async function preparedCandidate(') > -1,
    'אין מצביע שרתי למועמד המוכן');
  const at = runtime.indexOf('async function getModeOptions(');
  const body = runtime.slice(at, runtime.indexOf('\n  async function ', at + 10));
  assert.ok(body.indexOf('preparedCandidate(ctx)') > -1,
    'getModeOptions אינו חושף את המועמד');
  // ⭐ ובלי שמות: מזהה, מהדורה, טווח וחתימה בלבד.
  const fn = runtime.slice(runtime.indexOf('async function preparedCandidate('));
  const decl = fn.slice(0, fn.indexOf('\n  }'));
  assert.ok(!/person|full_name|roster|uid:/.test(decl),
    'המצביע למועמד נושא מידע אישי');
});

check('the preflight report expires, and its expiry is signed', () => {
  const cutover = read('functions/schedule-cutover.js');
  assert.ok(cutover.indexOf('PREFLIGHT_TTL_MS') > -1, 'אין תוקף לדוח');
  // הזמן בתוך הגוף החתום — אחרת אפשר להאריך תוקף בלי לשבור חתימה.
  const body = cutover.slice(cutover.indexOf('const body = {'),
    cutover.indexOf('const signature = String(hash(stable(body)));'));
  assert.ok(body.indexOf('generated_at:') > -1 && body.indexOf('expires_at:') > -1,
    'הזמן והתפוגה אינם בגוף החתום');
  assert.ok(cutover.indexOf("fail(CODE.PREFLIGHT_EXPIRED") > -1,
    'דוח שפג אינו נחסם');
  // והדוח קשור לתצורה שהמועמד נבנה עליה.
  assert.ok(cutover.indexOf('candidate_source_id') > -1
    && cutover.indexOf('CODE.CANDIDATE_CONFIG') > -1,
    'הדוח אינו קשור לתצורת המועמד');

  /* ⭐⭐ שתי הטענות האלה **הסכימו עם באג**, וזו הפעם השלישית בסדרה
   * הזאת. שתיהן דרשו בדיוק את הצורה שהייתה שבורה:
   * `expires_at: new Date(report.expires_at)` דרס שדה שנמצא בתוך
   * הגוף החתום; Firestore החזיר אותו כ-`Timestamp`; `stable()` ראה
   * ערך אחר מזה שנחתם — והחתימה לא תאמה לעצמה. **כל מעבר נחסם.**
   *
   * שום בדיקה טהורה לא יכלה לראות את זה, כי בזיכרון `Date` נשאר
   * `Date`. Codex מצא את זה באמולטור.
   *
   * החוזה עכשיו: שדה חתום אינו משמש גם כשדה תשתית. */
  const runtime = read('functions/schedule-runtime.js');
  /* ⭐ מהקוד, לא מהקובץ. ההערה שמעל התיקון **מצטטת** את הצורה
   * השבורה כדי להסביר אותה — וטענה שקוראת את הקובץ הגולמי הייתה
   * נופלת על ההסבר של התיקון עצמו. */
  const runtimeCode = runtime.split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.indexOf('*') !== 0 && t.indexOf('//') !== 0 && t.indexOf('/*') !== 0;
    }).join('\n');
  const preflightWrite = runtimeCode.slice(
    runtimeCode.indexOf("collection('schedule_preflight')"),
    runtimeCode.indexOf('async function promoteToNew('));
  assert.ok(!/[^_]expires_at: new Date\(report\.expires_at\)/.test(preflightWrite),
    'ה-expires_at החתום נדרס ב-Date — החתימה לא תשרוד את הדיסק');
  assert.ok(/ttl_expires_at: new Date\(report\.expires_at\)/.test(preflightWrite),
    'אין שדה TTL נפרד; TTL ושדה חתום אינם יכולים להיות אותו שדה');

  const indexes = JSON.parse(read('firestore.indexes.json'));
  assert.ok(indexes.fieldOverrides.some((item) =>
    item.collectionGroup === 'schedule_preflight' && item.fieldPath === 'ttl_expires_at'
    && item.ttl === true), 'אין TTL על schedule_preflight');
  assert.ok(!indexes.fieldOverrides.some((item) =>
    item.collectionGroup === 'schedule_preflight' && item.fieldPath === 'expires_at'),
    'ה-TTL עדיין מצביע על השדה החתום');

  /* והזמן נחתם בצורה שעוברת הלוך ושוב דרך האחסון בלי לשנות ייצוג. */
  assert.ok(cutover.indexOf('function canonicalTime(') > -1,
    'אין נרמול זמן קנוני');
  assert.ok(/generated_at: canonicalTime\(/.test(cutover)
    && /expires_at: canonicalTime\(/.test(cutover),
    'הזמן נחתם בצורה שאינה קנונית');
  assert.ok(/typeof value\.toDate === 'function'/.test(cutover),
    'timeOf אינו יודע לקרוא Timestamp — וזה מה שחוזר מהדיסק');

  /* ⭐ ושני העוגנים ש-TTL לבדו אינו סוגר: מי שהיה legacy, ומי היה
   * הפרסום הפעיל. דוח יכול להיות טרי ובכל זאת לתאר עולם שזז. */
  for (const anchor of ['legacy_revision', 'predecessor_publication_id']) {
    assert.ok(body.indexOf(anchor + ':') > -1,
      'העוגן ' + anchor + ' אינו בגוף החתום');
  }
  assert.ok(cutover.indexOf('const anchors = [') > -1,
    'העוגנים אינם נבדקים בהכרעה');
});

check('the promotion re-reads identity the canonical way, role included', () => {
  const runtime = read('functions/schedule-runtime.js');
  const at = runtime.indexOf('async function promoteToNew(');
  const body = runtime.slice(at, runtime.indexOf('\n  async function ', at + 10));
  /* ⭐ הבודק היחיד. הגרסה הקודמת שכפלה את הבדיקה בתוך promoteToNew;
   * הבסיס עכשיו מרכז אותה ב-`requireLiveModeAuthority`, והדרישה
   * כאן היא שהמעבר קורא לה **בתוך** העסקה ועל המסמך החי. */
  const txAt = body.indexOf('await db.runTransaction(');
  const call = body.indexOf("requireLiveModeAuthority(snaps[4], ctx, 'cutover-actor-inactive')");
  assert.ok(txAt > -1 && call > txAt, 'הזהות אינה נקראת חיה בתוך העסקה');
  assert.ok(!/liveUser\.station_id !== ctx\.sid/.test(body),
    'חזרה בדיקת station_id בלבד');
  // ⭐ והבודק עצמו: חברות קנונית, ותפקיד חי — לא מהטוקן.
  const helperAt = runtime.indexOf('function requireLiveModeAuthority(');
  const helper = runtime.slice(helperAt, runtime.indexOf('\n  }\n', helperAt));
  assert.ok(helper.indexOf('scheduleAccess.activeMember(user, ctx.sid)') > -1,
    'בדיקת החברות אינה קנונית');
  assert.ok(/role: String\(user\.role/.test(helper)
    && helper.indexOf('modeAuthority.mayChangeMode(liveActor)') > -1,
    'התפקיד אינו נקרא חי');
  assert.ok(helper.indexOf('super: ctx.super === true') > -1,
    'סמכות-על נלקחת מפרופיל ניתן לכתיבה ולא מה-claim');
});

/* ⭐ הטענה שונתה במפורש יחד עם הקוד. היא דרשה שהשומרים יופיעו
 * בגוף `readActiveSource` — וזה בדיוק מה שהנציח את המראה השנייה:
 * שומרים שנראים כמו של `loadSource` ואינם. עכשיו היא דורשת את
 * הדבר החזק יותר — שהשומרים חיים ב-`loadSource`, ושהמסלול היחיד
 * למקור הפעיל עובר דרכו. */
check('the active source is validated before anything carries from it', () => {
  const runtime = read('functions/schedule-runtime.js');
  const loadAt = runtime.indexOf('async function loadSource(');
  const loadBody = runtime.slice(loadAt, loadAt + 4000);
  for (const guard of ['meta.complete !== true', "'source-count-required'",
    "'source-count-mismatch'", "'source-digest-mismatch'"]) {
    assert.ok(loadBody.indexOf(guard) > -1,
      'loadSource אינו נופל סגור על ' + guard);
  }
  const at = runtime.indexOf('async function readActiveSource(');
  const body = runtime.slice(at, runtime.indexOf('\n  // ⭐ הדוח יוצא לדפדפן', at));
  assert.ok(/loadSource\(\{ sid \}, activeId\)/.test(body),
    'המקור הפעיל אינו נקרא דרך הבודק המאומת');
  /* ⭐ שונה במפורש עם הבסיס: מצביע פעיל למסמך חסר **חוסם**, ואינו
   * הופך ל-null. שום כשל אינו נבלע — אין `catch` בגוף הזה בכלל. */
  assert.ok(!/catch\s*\(/.test(body),
    'שגיאות אימות נבלעות ומוחזר null — זו שוב מחיקה שקטה');
});

/* ==================================================================
 * seq357 · ארבעה שערים שהיו קיימים־למראית־עין
 * ================================================================== */

/* (א) הכתיבות המדורגות היו **מחוץ** ל-try, ולכן batch שנפל לא הגיע
 * לניקוי כלל והשאיר תת-אוסף `people` עם שמות מלאים. TTL על מסמך
 * האב אינו יורד לתת-אוספים. */
check('every staged write is inside the crash-safe path', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function saveSource(');
  const body = src.slice(at, src.indexOf('\n  /* מוחק מקור מדורג', at));

  const tryAt = body.indexOf('\n    try {');
  const stageAt = body.indexOf('tx.set(ref, Object.assign({}, plan.meta');
  const childrenAt = body.indexOf('await commitOwnedSourceWrites([].concat(');
  const cleanupAt = body.indexOf('cleanupStagedSource(');

  assert.ok(tryAt > -1, 'אין try בכלל');
  assert.ok(stageAt > tryAt, 'כתיבת המדורג מחוץ ל-try — כשל שלה לא ינוקה');
  assert.ok(childrenAt > tryAt, 'כתיבת הילדים מחוץ ל-try — PII יישאר על הדיסק');
  assert.ok(cleanupAt > childrenAt, 'הניקוי אינו אחרי הכתיבות');
  // ⭐ והניקוי רץ רק על מדורג שהבקשה הזאת באמת תפסה.
  assert.ok(/if \(stageOwned\) \{\s*await cleanupStagedSource\(/.test(body),
    'הניקוי רץ גם על מדורג שלא נתפס — ומוחק של מישהו אחר');
});

/* (ב) `limit` לפני `sort`, ובהכנת shadow כל הפרסומים נושאים אותה
 * `revision` — כלומר „המועמד הגבוה" נבחר מתוך קבוצה מקרית, מבין
 * שווים. וזה המסך שהמפקד מאשר לפיו. */
check('a prepared candidate is single and deterministic, or none at all', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function preparedCandidate(');
  const body = src.slice(at, src.indexOf('\n  async function ', at + 10));

  assert.ok(!/\.limit\(5\)/.test(body), 'חזר limit(5) שרירותי');
  assert.ok(/limit\(CAP \+ 1\)/.test(body),
    'אין גילוי גלישה — קבוצה חסומה בלי +1 אינה יודעת שהיא חסרה');
  assert.ok(!/Number\(b\.revision \|\| 0\) - Number\(a\.revision \|\| 0\)/.test(body),
    'המיון עדיין לפי revision — ב-shadow כולן שוות');
  assert.ok(body.indexOf('ambiguous: true') > -1,
    'ריבוי מועמדים אינו מדווח; המסך יציג אחד שרירותי');
  assert.ok(body.indexOf("reason: 'prepared-ambiguous'") > -1
    && body.indexOf("reason: 'prepared-overflow'") > -1,
    'שני מצבי הריבוי אינם מובחנים');
});

/* (ג) המפקד אישר דוח שהוצג לו. בלי החתימה הזאת, preview נוסף בין
 * ההצגה לאישור היה גורם לו לאשר מסמך שלא ראה. */
check('the commander approves the exact report he was shown', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function promoteToNew(');
  const body = src.slice(at, src.indexOf('\n  async function ', at + 10));

  assert.ok(body.indexOf('cutover-signature-required') > -1,
    'החתימה אינה חובה — לקוח שישמיט אותה מדלג על הבדיקה');
  assert.ok(body.indexOf('cutover-signature-mismatch') > -1,
    'החתימה אינה מושווית');
  // ⭐ ובתוך העסקה. מחוצה לה זה עוד TOCTOU.
  const txAt = body.indexOf('db.runTransaction');
  assert.ok(body.indexOf('cutover-signature-mismatch') > txAt,
    'ההשוואה מחוץ לטרנזקציה');
  assert.ok(/livePreflight\.signature \|\| ''\) !== expectedSignature/.test(body),
    'ההשוואה אינה מול הדוח החי שנקרא בעסקה');

  // והלקוח שולח את החתימה של הדוח שהוא **הציג**, לא מ-state ישן.
  const ui = read('schedule-management.js');
  assert.ok(/expected_preflight_signature: report\.signature/.test(ui),
    'המסך אינו שולח את חתימת הדוח שהציג');
});

/* (ד) `setRuntimeMode` קרא חברות חיה אך לא סמכות חיה. טוקן חי עד
 * שעה — חלון של שעה שבו הרשאה שנשללה עדיין מזיזה את מצב המנוע. */
check('mode change re-reads authority live, not only membership', () => {
  const src = read('functions/schedule-runtime.js');
  const at = src.indexOf('async function setRuntimeMode(');
  const body = src.slice(at, src.indexOf('\n  async function ', at + 10));
  const txAt = body.indexOf('db.runTransaction');
  assert.ok(txAt > -1, 'אין טרנזקציה');

  const inTx = body.slice(txAt);
  /* הבודק המרכזי של הבסיס, בתוך העסקה ועל המסמך החי — לא על הטוקן.
   * מה שהוא בודק (חברות קנונית + תפקיד חי) מוכח בבדיקת ה-promote. */
  assert.ok(/tx\.get\(liveUserRef\(ctx\.sid, ctx\.uid\)\)/.test(inTx),
    'החברות אינה נקראת חיה');
  assert.ok(inTx.indexOf("requireLiveModeAuthority(liveUserSnap, ctx, 'mode-actor-inactive')") > -1,
    'הסמכות אינה נבדקת מחדש על התפקיד החי בתוך הטרנזקציה');
  assert.ok(!/mayChangeMode\(modeActor\(ctx\)\)[\s\S]*db\.runTransaction[\s\S]*$/.test(body)
    || inTx.indexOf('requireLiveModeAuthority(') > -1,
    'הסמכות נבדקת פעם אחת בלבד, על הטוקן');
});

/* ==================================================================
 * ⭐ ההיפוך של MISSING · מה נשאר חוסם
 *
 * הפיכת „אדם שינוי משמרת" ללא-חוסם היא ההחלשה היחידה בסדרה הזאת,
 * והיא הכרעת מוצר מאושרת. הבדיקות כאן קיימות כדי שהיא **תישאר
 * ההחלשה היחידה** — כלומר שאף שער אחר לא נסחף איתה.
 * ================================================================== */

check('the inversion did not take any other gate with it', () => {
  const cut = read('functions/schedule-cutover.js');

  // ארבעת החוסמים, מפורשים ברשימה אחת.
  const at = cut.indexOf('const BLOCKING = Object.freeze([');
  assert.ok(at > -1, 'אין רשימת חוסמים מפורשת');
  const list = cut.slice(at, cut.indexOf(']);', at));
  for (const reason of ['FOREIGN', 'DUPLICATE', 'EMPTY_DAY', 'OUT_OF_RANGE']) {
    assert.ok(list.indexOf('REASON.' + reason) > -1,
      reason + ' יצא מרשימת החוסמים — זו החלשה שלא אושרה');
  }
  assert.ok(list.indexOf('REASON.MISSING') === -1,
    'MISSING חזר לרשימת החוסמים; המעבר ייחסם תמיד');

  /* ⭐ וכל סיבה ב-REASON חייבת להיות באחת משתי הרשימות. סיבה חדשה
   * שתיפול בין הכיסאות תהיה „לא חוסמת" בשקט. */
  const reasonBlock = cut.slice(cut.indexOf('const REASON = Object.freeze({'),
    cut.indexOf('});', cut.indexOf('const REASON = Object.freeze({')));
  const names = (reasonBlock.match(/^\s{2}([A-Z_]+):/gm) || [])
    .map((line) => line.trim().replace(':', ''));
  assert.ok(names.length >= 5, 'לא זוהו הסיבות');
  const advisory = cut.slice(cut.indexOf('const ADVISORY = Object.freeze(['),
    cut.indexOf(']);', cut.indexOf('const ADVISORY = Object.freeze([')));
  for (const name of names) {
    assert.ok(list.indexOf('REASON.' + name) > -1 || advisory.indexOf('REASON.' + name) > -1,
      'הסיבה ' + name + ' אינה חוסמת ואינה מדווחת — היא נעלמת בשקט');
  }
});

/* התנאי שאסור היה לגעת בו: חוסר כוח אדם הוא שער נפרד של המדיניות
 * והמנוע, ולא חלק מהשוואת ה-preflight. */
check('a staffing shortfall is still its own separate blocker', () => {
  const ui = read('schedule-management.js');
  assert.ok(/blocking_gaps \|\| 0\);\s*\n\s*if \(gaps > 0\)/.test(ui),
    'שער החוסרים בפרסום נעלם');
  assert.ok(ui.indexOf('אי אפשר לפרסם: בטיוטה יש חוסרים חוסמים') > -1,
    'הודעת החוסרים נעלמה — השער אולי נשאר, אבל המשתמש לא יידע למה');
  /* והוא חי בשכבה אחרת לגמרי מה-preflight — נבדק על **הקוד**, כי
   * ההערה במודול מסבירה בדיוק למה `blocking_gaps` אינו שם. זו
   * הפעם השלישית בסדרה הזאת שהערה מספקת גלאי; המסקנה קבועה: כל
   * טענה על קוד נקראת מהמקור חסר-ההערות. */
  const cutCode = read('functions/schedule-cutover.js').split('\n')
    .filter((line) => {
      const t = line.trim();
      return t.indexOf('*') !== 0 && t.indexOf('//') !== 0 && t.indexOf('/*') !== 0;
    }).join('\n');
  assert.ok(cutCode.indexOf('blocking_gaps') === -1,
    'שער החוסרים נבלע לתוך ה-preflight; שני שערים נפרדים הפכו לאחד');
});

/* האישור נקשר לחתימת הדוח, לא לדגל. */
check('acknowledging changes is bound to the exact report', () => {
  const cut = read('functions/schedule-cutover.js');
  assert.ok(cut.indexOf('CHANGES_UNACKNOWLEDGED') > -1, 'אין קוד לאישור חסר');
  assert.ok(/input\.accept_changes !== report\.signature/.test(cut),
    'האישור אינו קשור לחתימה — אישור לדוח אחד יחול על אחר');
  assert.ok(!/accept_changes === true/.test(cut),
    'האישור חזר להיות דגל בוליאני');
  const ui = read('schedule-management.js');
  assert.ok(/accept = report\.signature/.test(ui),
    'המסך אינו שולח את חתימת הדוח שהציג כאישור');
  assert.ok(ui.indexOf('משנה ') > -1 && ui.indexOf('שיבוצים') > -1,
    'המפקד אינו רואה כמה שיבוצים משתנים');
});

/* ⭐ seq379 A/B/C · שלושת החורים שנסגרו בעסקת המעבר. כל טענה כאן נבדקת
 * על קוד בלי הערות, כדי שהערה לא תספק אותה. */
check('the promotion transaction owns legacy, outbox and the operation record', () => {
  const src = stripComments(read('functions/schedule-runtime.js'));
  const at = src.indexOf('async function promoteToNew(req)');
  const body = src.slice(at, src.indexOf('\n  async function ', at + 10));
  const txAt = body.indexOf('await db.runTransaction(');
  assert.ok(txAt > -1, 'אין עסקה');
  const before = body.slice(0, txAt);
  const inTx = body.slice(txAt);

  // A · ה-legacy נקרא בתוך העסקה, ולא לפניה.
  assert.ok(!/legacyComparisonDigest\(ctx/.test(before), 'ה-legacy עדיין נקרא לפני העסקה');
  assert.ok(inTx.indexOf('await legacyComparisonDigestInTx(tx, ctx, from, to)') > -1,
    'ה-legacy אינו נקרא בתוך העסקה');
  const txAtDef = src.indexOf('async function legacyComparisonDigestInTx(tx, ctx, from, to)');
  const txDef = src.slice(txAtDef, src.indexOf('\n  }\n', txAtDef));
  assert.ok(txDef.indexOf('effectiveReaderFor(ctx, { tx })') > -1,
    'הקריאה בתוך העסקה אינה עוברת דרך המתאם עם tx');
  const readers = src.slice(src.indexOf('function txReader(tx)'), src.indexOf('async function legacyProjectionInput('));
  assert.ok(readers.indexOf('tx.get(target)') > -1 && readers.indexOf('tx.getAll.apply(tx, refs)') > -1,
    'txReader אינו קורא דרך העסקה');
  // וכל ששת מסלולי הקריאה של legacyProjectionInput עוברים דרך reader.
  const lpAt = src.indexOf('async function legacyProjectionInput(');
  const lp = src.slice(lpAt, src.indexOf('\n  }\n', lpAt));
  assert.equal((lp.match(/reader\.get\(/g) || []).length, 5, 'לא כל הקריאות עוברות דרך reader.get');
  assert.ok(lp.indexOf('reader.getAll(overrideRefs)') > -1, 'ה-overrides אינם נקראים דרך reader');
  assert.ok(!/\.get\(\)/.test(lp), 'נשארה קריאה ישירה שעוקפת את ה-reader');

  // B · התור נקרא בעסקה ומאומת מול המניפסט.
  assert.ok(inTx.indexOf("await tx.get(pubRef.collection('schedule_outbox'))") > -1,
    'התור אינו נקרא בתוך העסקה');
  assert.ok(inTx.indexOf('requireBlockedOutbox(outboxSnap, {') > -1, 'התור אינו מאומת');
  assert.ok(inTx.indexOf('manifest: livePub.outbox_manifest') > -1, 'האימות אינו מול המניפסט');
  const validator = src.slice(src.indexOf('function requireBlockedOutbox(snap, expect, fail)'),
    src.indexOf('function preparedReplayInvalid()'));
  for (const why of ['outbox-manifest-missing', 'outbox-manifest-mismatch', 'outbox-row-invalid', 'outbox-expired']) {
    assert.ok(validator.indexOf("fail('" + why + "')") > -1, 'האימות חסר ' + why);
  }
  assert.ok(validator.indexOf("row.status !== 'blocked'") > -1 && validator.indexOf('outboxExpired(row, expect.now)') > -1,
    'האימות אינו בודק חסימה ותפוגה');
  // ואותו validator משמש גם את ה-replay של הכנה.
  const replayAt = src.indexOf('async function replayPreparedPublication(');
  const replay = src.slice(replayAt, src.indexOf('\n  async function publish(req)', replayAt));
  assert.ok(replay.indexOf('requireBlockedOutbox(outboxSnap, {') > -1, 'ה-replay אינו משתמש באותו validator');

  // C · רשומת הפעולה נקראת בעסקה, לפני בדיקות המעבר; הטביעה קושרת את מלוא הכוונה.
  const fp = body.slice(body.indexOf('const fingerprint = digest({'), body.indexOf('});', body.indexOf('const fingerprint = digest({')));
  assert.ok(fp.indexOf('expected_preflight_signature: expectedSignature') > -1
    && fp.indexOf('accept_changes: acceptChanges') > -1,
    'טביעת האצבע אינה כוללת חתימה ואישור');
  const refsAt = inTx.indexOf('liveUserRef(ctx.sid, ctx.uid), opRef]');
  const replayAtTx = inTx.indexOf('const replayed = replayOf(snaps[5])');
  const decideAt = inTx.indexOf('cutover.decidePromotion({');
  assert.ok(refsAt > -1 && replayAtTx > refsAt && decideAt > replayAtTx,
    'רשומת הפעולה אינה נקראת בעסקה לפני ההכרעה');
  assert.ok(inTx.indexOf('tx.create(opRef, {') > -1, 'רשומת הפעולה נכתבת ב-set — שני promoters יכולים לדרוס');
});

check('reserved map keys: overrides, locked source and stored policy are own-property checked, never inherited', () => {
  const src = runtime;
  assert.ok(src.indexOf("const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype'])") > -1,
    'אין רשימת מפתחות שמורים');
  const overridesAt = src.indexOf('function normalizeOverrides(value, policy)');
  const overrides = src.slice(overridesAt, src.indexOf('function effectiveSource(', overridesAt));
  assert.ok(overrides.indexOf('!safeSubKey(entry.sub_station) || !hasOwn(policy.sub_stations, entry.sub_station)') > -1,
    'שינוי ידני בודק תחנת קצה דרך truthiness — "__proto__" עובר');
  assert.equal(overrides.indexOf('isReservedKey(entry.person)'), -1, 'UID אינו נפסל — משתמש קיים חייב להמשיך לעבוד (410)');
  assert.ok(overrides.indexOf('isReservedKey(entry.role)') > -1, 'תפקיד בשינוי ידני יכול להיות מפתח שמור');
  assert.equal(overrides.indexOf('policy.sub_stations[entry.sub_station]) {'), -1, 'נשארה בדיקת truthiness');
  const effAt = src.indexOf('function effectiveSource(ctx, source, policy, overrides)');
  const eff = src.slice(effAt, src.indexOf('const effectiveDigest', effAt));
  assert.ok(eff.indexOf("hasOwn(locked, entry.sub_station)") > -1 && eff.indexOf("hasOwn(days, entry.date)") > -1,
    'effectiveSource בונה locked[sub][date] דרך || — כותב ל-Object.prototype');
  assert.equal(eff.indexOf('locked[entry.sub_station] || {}'), -1, 'נשאר || {} על מפתח חיצוני');
  const lockedAt = src.indexOf('function validateLockedSource(locked, peopleRaw, policyValue)');
  const lockedFn = src.slice(lockedAt, src.indexOf('async function loadPolicy(', lockedAt));
  assert.ok(lockedFn.indexOf('!safeSubKey(sub)') > -1 && lockedFn.indexOf('!hasOwn(policySubs, sub)') > -1,
    'נעילות במקור אינן נבדקות כ-own-property');
  const policyAt = src.indexOf('async function loadPolicy(ctx, id)');
  const policyFn = src.slice(policyAt, src.indexOf('async function loadSource(', policyAt));
  assert.ok(policyFn.indexOf('Object.keys(raw.sub_stations).some((key) => !safeSubKey(key))') > -1,
    'מדיניות שמורה עם מפתח שמור נטענת');
  // המודולים הטהורים שמקבלים את אותם מפתחות דוחים אותם בעצמם.
  const engine = read('functions/schedule-calendar-engine.js');
  assert.ok(engine.indexOf("'sub-station-key-reserved'") > -1, 'מנוע היומן חסר sub-station-key-reserved');
  assert.equal(engine.indexOf("'roster-id-reserved'"), -1, 'מנוע היומן פוסל UID — אסור (410)');
  assert.ok(engine.indexOf('Object.defineProperty(out, key, { value: map[key]') > -1, 'פלט המנוע נבנה ב-Object.assign — "__proto__" היה setter');
  assert.ok(author.indexOf('function validSubKey(v)') > -1 && author.indexOf('!isReservedKey(v)') > -1,
    'policy-author מקבל מפתח שמור');
});

check('400(3): new-without-active falls back to legacy explicitly, rechecks mode AND pointer, and labels the provenance', () => {
  const src = runtime;
  const at = src.indexOf('async function legacyFallbackWindow(ctx, config, from, to, scoped)');
  const fn = src.slice(at, src.indexOf('\n  async function getMy(req)', at));
  assert.ok(fn.indexOf("effectiveStationWindow(ctx, from, to, Object.assign({}, scoped || {}, { legacyOnly: true }))") > -1,
    'the fallback still goes through the reader\'s hard boundary and would throw active-publication-missing');
  assert.ok(fn.indexOf('nonEmpty(pointerNow.publication_id)') > -1, 'a publication arriving mid-read is not rechecked');
  assert.ok(fn.indexOf("after.mode !== config.mode || window.source !== 'legacy'") > -1);
  assert.ok(fn.indexOf("{ mode: config.mode, fallback: 'legacy' }") > -1, 'provenance does not say it is a fallback');
  const readerAt = src.indexOf('function effectiveReaderFor(ctx, scoped)');
  const reader = src.slice(readerAt, src.indexOf('async function effectiveStationWindow', readerAt));
  assert.ok(reader.indexOf('if (legacyOnly) return { mode: MODE.SHADOW };') > -1);
  assert.ok(reader.indexOf('const active = pinned || await activeSnapshot(ctx);') > -1, 'windows of one call must share one verified snapshot');
  assert.ok(integration.includes("new without an active publication falls back to the full legacy schedule"), 'no emulator scenario for the fallback');
});

check('42G.28: getEffectiveWorkdays is a member VIEW callable with a closed envelope, and the server entry has no auth', () => {
  const src = runtime;
  const at = src.indexOf('async function getEffectiveWorkdays(req)');
  const fn = src.slice(at, src.indexOf('\n  async function effectiveWorkDaysForStation', at));
  assert.ok(fn.indexOf('const ctx = await context(req);') > -1, 'live membership gate missing');
  assert.ok(fn.indexOf("['from', 'to', 'uids'].indexOf(key) === -1") > -1, 'envelope is not closed');
  assert.ok(fn.indexOf("throw new ScheduleRuntimeError('workdays-uids-shape'") > -1);
  assert.equal(fn.indexOf('display'), -1, 'the callable must not return names');
  assert.equal(fn.indexOf('working'), -1, 'the callable must not return per-date people lists');
  const core = src.slice(src.indexOf('async function effectiveWorkDaysFor(ctx, config, input)'), at);
  assert.ok(core.indexOf('const active = await checkedActiveSnapshot(ctx, config, null);') > -1);
  assert.ok(core.indexOf('await activeSnapshotStillCurrent(ctx, config, active);') > -1, 'the snapshot is not rechecked at the end');
  assert.ok(core.indexOf("? await legacyFallbackWindow(ctx, config, w.from, w.to, scoped)") > -1, 'new-without-active must use the explicit fallback');
  const serverAt = src.indexOf('async function effectiveWorkDaysForStation(sid, input)');
  const server = src.slice(serverAt, src.indexOf('\n  async function getStationRange', serverAt));
  assert.ok(server.indexOf("const ctx = { sid: station, uid: null, role: 'system', system: true };") > -1);
  assert.equal(server.indexOf('context(req)'), -1);
  // 417: הקשר שרת מפורש למתאם הטהור — לא משתמש מומצא.
  const readerAt2 = src.indexOf('function effectiveReaderFor(ctx, scoped)');
  const reader2 = src.slice(readerAt2, src.indexOf('async function effectiveStationWindow', readerAt2));
  assert.ok(reader2.indexOf("? { station_id: ctx.sid, system: true, active: true }") > -1, 'system context is not explicit');
  const pure = read('functions/schedule-effective-reader.js');
  assert.ok(pure.indexOf("if (raw.system === true) {") > -1 && pure.indexOf("fail('context-system-uid')") > -1);
  assert.ok(pure.indexOf("if (resolved.ctx.system === true || !resolved.ctx.uid) fail('context-uid');") > -1, 'getMy must refuse a system context');
  // 417 §1 · 419: זהות חיה **והמקור** נבדקים שוב בסוף getEffectiveWorkdays —
  // אחרי שעות המשמרת, שנקראות בתוך effectiveWorkDaysFor ומכוסות ב-verify.
  assert.ok(fn.indexOf("beforeEffectiveViewRecheck({ kind: 'workdays', ctx, mode: config.mode })") > -1);
  // 421 §2: אימות המקור (verify — קורא בעצמו עד 397 ימים) לפני בדיקת הזהות,
  // והזהות החיה היא **הקריאה האחרונה** לפני התשובה.
  assert.ok(fn.indexOf("beforeEffectiveViewRecheck({ kind: 'workdays'") < fn.indexOf('await pending.verify();'));
  assert.ok(fn.indexOf('await pending.verify();') < fn.indexOf('const finalReads = await Promise.all([configuration(ctx.sid), liveUserRef(ctx.sid, ctx.uid).get()]);'),
    'the live identity must be read after the bulk verification, not before it');
  assert.ok(fn.indexOf('requireLiveWorkdaysViewer(finalReads[1], ctx);') < fn.indexOf('return workdaysResponse(pending.result);'));
  assert.ok(fn.indexOf('requireLiveWorkdaysViewer(finalReads[1], ctx);') > fn.indexOf('await pending.verify();'));
  assert.equal((core.match(/kind: 'workdays-verify'/g) || []).length, 2, 'both verify closures must expose the verify seam');
  assert.equal(fn.indexOf('stationShiftHours('), -1, 'shift hours must not be a second read outside the verified source');
  assert.ok(core.indexOf("shift_hours: await stationShiftHours(ctx, basis.rotationDocs)") > -1, 'legacy shift hours must come from the pinned basis');
  assert.ok(core.indexOf('const shiftHours = await stationShiftHours(ctx);') > -1 && core.indexOf('digest(await stationShiftHours(ctx)) !== digest(shiftHours)') > -1,
    'in new, the shift-hours read must be rechecked in verify');
  // 417 §2 · 419: בסיס legacy אחד לכל החלונות — סגל, מחזורים, חריגים, החלפות —
  // חתימה ב-provenance, ובדיקה חוזרת בסוף (verify), אחרי השעות.
  assert.ok(core.indexOf('const basis = await legacyWorkdaysBasis(ctx, range);') > -1);
  assert.ok(core.indexOf('const scoped = { legacyBasis: basis };') > -1);
  assert.ok(core.indexOf('await requireSameLegacyBasis(ctx, basis, range);') > -1);
  assert.ok(core.indexOf('legacy_digest: basis.legacyDigest') > -1);
  // 421 §1: זהות מקור בלתי תלויה בטווח לצד חתימת תוכן הטווח; הלקוח מחבר לפי הזהות.
  assert.equal((core.match(/legacy_basis_digest: basis\.legacyBasisDigest, legacy_digest: basis\.legacyDigest/g) || []).length, 2);
  const clientModule = read('effective-workdays.js');
  assert.ok(clientModule.indexOf('export function workdaysSourceIdentity(p)') > -1);
  assert.ok(clientModule.indexOf("if (key === 'legacy_digest') return;") > -1, 'the range content signature must not block a merge');
  assert.ok(clientModule.indexOf('const sig = workdaysSourceIdentity;') > -1);
  assert.equal(clientModule.indexOf('JSON.stringify([p.mode, p.source, p.fallback, p.provenance])'), -1, 'the old whole-provenance signature is gone');
  assert.ok(integration.includes('421 §1: two ranges of one stable legacy source') && integration.includes('421 §2: a viewer deactivated or transferred during the final source verification'));
  const basisAt = src.indexOf('async function legacyWorkdaysBasis(ctx, range)');
  const basisFn = src.slice(basisAt, src.indexOf('async function requireSameLegacyBasis', basisAt));
  for (const needle of ["root.collection('roster')", "root.collection('rotations')", "root.collection('shift_overrides').doc(date)",
    ".where('from_date', 'in', chunk)", ".where('to_date', 'in', chunk)", 'overrides: pairs(overrideDocs)', 'swaps: pairs(swapDocs)',
    'range: { from: range.from, to: range.to }', 'const legacyBasisDigest = digest({ roster: rosterPairs, rotations: rotationPairs });',
    'basis: legacyBasisDigest']) {
    assert.ok(basisFn.indexOf(needle) > -1, 'the legacy basis must pin and sign: ' + needle);
  }
  assert.ok(core.indexOf("await activeSnapshotStillCurrent(ctx, config, active);") > core.indexOf('verify: async function'),
    'in new, the snapshot recheck belongs to verify (the end of the call)');
  const verifyLegacy = core.slice(core.lastIndexOf('verify: async function'));
  assert.ok(verifyLegacy.indexOf('await requireModeUnchanged(ctx, config);') > -1);
  assert.ok(verifyLegacy.indexOf('if (config.mode === MODE.NEW) await requireNoActivePublication(ctx);') > -1, 'a publication arriving after the hours is not rechecked');
  // 419: תחנה בלי אף מחזור — לא ידוע במפורש, בלי להקרין סבב ריק; כבויים נשארים סירוב.
  assert.ok(core.indexOf('if (!basis.rotationDocs.length) {') > -1);
  assert.ok(core.indexOf('effectiveWorkdays.assembleUnknown({') > -1);
  assert.ok(core.indexOf('legacy_rotations: 0') > -1);
  const serverFn = server;
  assert.ok(serverFn.indexOf("beforeEffectiveViewRecheck({ kind: 'workdays', ctx, mode: config.mode })") > -1
    && serverFn.indexOf('await pending.verify();') > -1, 'the server entry must confirm the source at the end too');
  assert.ok(integration.includes('419: overrides and swaps that change between windows are refused')
    && integration.includes('419: the source is confirmed at the very end')
    && integration.includes('419: a station with no rotation record at all'), 'no emulator scenarios for 419');
  // 417 §3: הסגל הקיים הוא גבול הידיעה — לא roster:null.
  assert.ok(core.indexOf('roster: basis.rosterIds') > -1 && core.indexOf('roster: null') === -1);
  const legacyInput = src.slice(src.indexOf('async function legacyProjectionInput(ctx, range, readerArg, pinnedBasis)'), src.indexOf('function legacyRosterProjection') > 0 ? src.length : src.length);
  assert.ok(legacyInput.indexOf("pinned ? { size: pinned.rosterDocs.length, docs: pinned.rosterDocs }") > -1, 'windows must share the pinned roster');
  assert.ok(legacyInput.indexOf("pinned ? dates.map((date) => pinned.overrideDocs.get(date) || null)") > -1, 'windows must share the pinned overrides');
  assert.ok(legacyInput.indexOf("pinned ? pinnedSwapsBy('from_date')") > -1 && legacyInput.indexOf("pinned ? pinnedSwapsBy('to_date')") > -1, 'windows must share the pinned swaps');
  assert.ok(legacyInput.indexOf("dates[0] < pinned.range.from || dates[dates.length - 1] > pinned.range.to") > -1, 'a window outside the pinned range must be refused');
  assert.ok(index.indexOf("exports.getEffectiveWorkdays = onCall({ enforceAppCheck: true }") > -1);
  assert.equal(index.indexOf('effectiveWorkDaysForStation = onCall'), -1, 'the server entry must never be exported as a callable');
  const shift = src.slice(src.indexOf('async function stationShiftHours(ctx, pinnedRotationDocs)'), src.indexOf('async function effectiveWindows'));
  assert.ok(shift.indexOf("hours_source: 'legacy-rotation-config'") > -1, 'shift hours must name their source');
  assert.equal(/crew|position_in_cycle|anchor_date/.test(shift.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'shift hours must not carry the cycle');
});

assert.equal(passed, 119);
console.log('\n119 schedule runtime source checks passed.');
