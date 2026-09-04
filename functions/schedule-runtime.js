'use strict';

const scheduleAccess = require('./schedule-access');
const effectiveReaderModule = require('./schedule-effective-reader');
const operationalProjection = require('./schedule-operational-projection');
const guardEvents = require('./guard-events');
const guardManagement = require('./schedule-guard-management');
const guardBoardProjection = require('./guard-board-projection');
const legacyCompatibility = require('./schedule-legacy-compat');
const effectiveWorkdays = require('./schedule-effective-workdays');
const policyAuthorModule = require('./schedule-policy-author');
const modeAuthorityModule = require('./schedule-mode-authority');
const cutoverModule = require('./schedule-cutover');
const sourceAuthorModule = require('./schedule-source-author');

/**
 * Firestore wiring for the monthly ResQ schedule engine.
 *
 * The runtime is deliberately fail-closed:
 * - station and identity come only from authenticated server state;
 * - missing configuration means mode="off";
 * - source and policy documents are accepted only when their server-computed
 *   digests and declared document counts match;
 * - drafts/publications are immutable snapshots;
 * - notifications remain blocked until the active pointer is committed.
 */

class ScheduleRuntimeError extends Error {
  constructor(code, message, httpCode) {
    super(message);
    this.name = 'ScheduleRuntimeError';
    this.code = code;
    this.httpCode = httpCode || 'failed-precondition';
  }
}

const MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', NEW: 'new' });
const MODES = Object.freeze(Object.keys(MODE).map((key) => MODE[key]));
const MEMBER_ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander', 'hr_coordinator'
]);
const ID_RE = /^[A-Za-z0-9_-]{2,120}$/;
// Must stay identical to schedule-policy-author.js.  Sub-station keys are
// business identifiers with their own (shorter) contract; reusing ID_RE here
// incorrectly rejected the valid one-character keys accepted by the policy.
const SUB_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* מפתחות שאסור שיגיעו ממשתמש למפה רגילה: "__proto__" עובר את SUB_KEY_RE
 * (קו תחתון מותר), ו-`policy.sub_stations["__proto__"]` אמיתי (truthy)
 * דרך ירושה — ואז effectiveSource היה כותב locked[sub][date] ישירות
 * ל-Object.prototype של התהליך החם. כל בדיקת קיום במפה כאן היא
 * own-property, לא truthiness. */
const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
function isReservedKey(value) {
  return RESERVED_KEYS.indexOf(value) !== -1;
}
function hasOwn(target, key) {
  return !!target && Object.prototype.hasOwnProperty.call(target, key);
}
function safeSubKey(value) {
  return typeof value === 'string' && SUB_KEY_RE.test(value) && !isReservedKey(value);
}
const AUTH_UID_RE = guardManagement.AUTH_UID_RE;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BATCH_WRITES = 350;
// Leave headroom below Firestore's 10 MiB transaction request limit for
// document paths, protocol overhead and index transforms.
const MAX_SOURCE_TRANSACTION_BYTES = 7 * 1024 * 1024;
const MAX_ROW_BYTES = 850000;
const MAX_OVERRIDES = 5000;
const MAX_SOURCE_PEOPLE = 20000;
const MAX_SOURCE_GROUP = 20000;
const MAX_SOURCE_TOTAL = 50000;
// A scheduled run must never turn one old import into an unbounded recursive
// delete.  Sources above the per-run child budget keep their parent anchor and
// are resumed by a later invocation.
const MAX_SOURCE_SWEEP_CANDIDATES = 10;
const MAX_SOURCE_SWEEP_CHILDREN = 1000;
const MAX_SOURCE_SWEEP_CHUNK = 200;
const SOURCE_CHILD_GROUPS = Object.freeze(['people', 'availability', 'locked', 'events']);
// Compatibility reads power the existing station schedule while V2 is off or
// in Shadow.  They must not turn one screen load into an unbounded Firestore
// scan.  These limits are an I/O safety boundary, not a claim about every
// historical record.
const MAX_LEGACY_ROSTER = 500;
const MAX_LEGACY_ROTATIONS = 20;
const MAX_LEGACY_OVERRIDES = 500;
const MAX_LEGACY_SWAPS_PER_QUERY = 250;
const MAX_LEGACY_SWAPS = 1000;
const MAX_LEGACY_GUARDS_PER_QUERY = 250;
const MAX_LEGACY_GUARDS = 1000;
const MAX_LEGACY_GUARD_ASSIGNED = 20;
const LEGACY_IN_QUERY_SIZE = 30;
const MAX_GUARD_BOARD_DAYS = 366;
// רצועת סידור התחנה מוגבלת לחודש בקריאה אחת. גלילה לחודש הבא
// היא קריאה חדשה, ולא טווח שגדל בלי גבול.
const MAX_STATION_RANGE_DAYS = 31;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const OUTBOX_LEASE_MS = 10 * 60 * 1000;
const OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GUARD_OUTBOX_MAX_ATTEMPTS = 3;
const GUARD_OUTBOX_BACKOFF_MS = Object.freeze([60000, 300000]);
const GUARD_NOTIFICATION_FANOUT_CHUNK = 300;
// Interest remains a convenience list, not an unbounded recipient database.
// This protects the guard document itself while leaving an unstaffed guard
// perfectly valid.  Existing historical documents above the limit are still
// actionable: their notifications are split into small server jobs below.
const MAX_GUARD_SIGNUPS = 1000;
// Removed-member epochs exist only to supersede a delayed removal push.  A
// single guard never needs an unbounded membership history.
const MAX_GUARD_ASSIGNMENT_EPOCHS = 1000;
const MAX_GUARD_NOTIFICATION_JOB_WRITES = 400;
const MAX_GUARD_NOTIFICATION_RECIPIENTS =
  GUARD_NOTIFICATION_FANOUT_CHUNK * MAX_GUARD_NOTIFICATION_JOB_WRITES;
// The first "open guard" notice is station-wide.  Bound the live audience
// read independently from the job/write limit, so a malformed large station
// cannot turn an asynchronous trigger into an unbounded Firestore scan.
const MAX_GUARD_OPEN_AUDIENCE = 5000;
const GUARD_MUTABLE_FIELDS = Object.freeze([
  'title', 'kind', 'place', 'date', 'start', 'end', 'slots', 'need_quals',
  'notes', 'assigned', 'status'
]);
const ANALYTICS_ROLES = Object.freeze([
  'deputy', 'commander', 'station_commander', 'hr_coordinator'
]);
const DRAFT_PREVIEW_DAYS = 7;
const ROLLBACK_REASONS = Object.freeze([
  'configuration_error', 'wrong_roster', 'wrong_assignment', 'operational_safety', 'other'
]);

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function integer(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Digests must be identical on every OS and Node/ICU build. localeCompare()
// is locale-sensitive, so every order that feeds a digest uses code-unit order.
function compareCanonical(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

function isoDayOffset(iso, offset) {
  if (!DATE_RE.test(String(iso || ''))) {
    throw new ScheduleRuntimeError('date-invalid', 'התאריך חייב להיות בצורת YYYY-MM-DD', 'invalid-argument');
  }
  const value = new Date(iso + 'T00:00:00.000Z');
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== iso) {
    throw new ScheduleRuntimeError('date-invalid', 'התאריך אינו אפשרי', 'invalid-argument');
  }
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function createScheduleRuntime(deps) {
  const d = plain(deps) ? deps : {};
  const db = d.db;
  const FV = d.FieldValue;
  const FieldPath = d.FieldPath;
  const clock = d.clock;
  const hash = d.hash;
  const randomId = d.randomId;
  const createEngine = d.createEngine;
  const createPublication = d.createPublication;
  const createService = d.createService;
  const isSuper = typeof d.isSuper === 'function' ? d.isSuper : function () { return false; };
  const sendPush = d.sendPush;
  // Operational telemetry is intentionally code-only.  Never pass the raw
  // exception or request context here: either can contain personal data.
  const reportError = typeof d.reportError === 'function'
    ? d.reportError : function (code) { console.error(code); };
  // Lifecycle hooks are dependency-injected test seams only.  The production
  // wiring does not provide them; they let the emulator prove race boundaries.
  const beforeSnapshotFinalize = typeof d.beforeSnapshotFinalize === 'function'
    ? d.beforeSnapshotFinalize : async function () {};
  const beforeOutboxSend = typeof d.beforeOutboxSend === 'function'
    ? d.beforeOutboxSend : async function () {};
  const beforeEffectiveViewRecheck = typeof d.beforeEffectiveViewRecheck === 'function'
    ? d.beforeEffectiveViewRecheck : async function () {};
  // This seam exists only to prove that the final active-pointer read really
  // happens *after* the live guards sidecar.  Production never supplies it.
  const beforeLiveGuardViewRecheck = typeof d.beforeLiveGuardViewRecheck === 'function'
    ? d.beforeLiveGuardViewRecheck : async function () {};
  const afterSourceWriteChunk = typeof d.afterSourceWriteChunk === 'function'
    ? d.afterSourceWriteChunk : async function () {};
  const afterSourceSweepClaim = typeof d.afterSourceSweepClaim === 'function'
    ? d.afterSourceSweepClaim : async function () {};
  const afterSourceSweepChunk = typeof d.afterSourceSweepChunk === 'function'
    ? d.afterSourceSweepChunk : async function () {};
  // Test-only seam: production wiring omits it and therefore always uses the
  // audited 350-write ceiling. It lets the emulator force a between-chunk race
  // without creating hundreds of employee records.
  const sourceWriteChunkSize = integer(d.sourceWriteChunkSize)
      && d.sourceWriteChunkSize >= 1 && d.sourceWriteChunkSize <= MAX_BATCH_WRITES
    ? d.sourceWriteChunkSize : MAX_BATCH_WRITES;
  const sourceSweepCandidateLimit = integer(d.sourceSweepCandidateLimit)
      && d.sourceSweepCandidateLimit >= 1
      && d.sourceSweepCandidateLimit <= MAX_SOURCE_SWEEP_CANDIDATES
    ? d.sourceSweepCandidateLimit : MAX_SOURCE_SWEEP_CANDIDATES;
  const sourceSweepChildLimit = integer(d.sourceSweepChildLimit)
      && d.sourceSweepChildLimit >= 1 && d.sourceSweepChildLimit <= MAX_SOURCE_SWEEP_CHILDREN
    ? d.sourceSweepChildLimit : MAX_SOURCE_SWEEP_CHILDREN;
  const sourceSweepChunkSize = integer(d.sourceSweepChunkSize)
      && d.sourceSweepChunkSize >= 1 && d.sourceSweepChunkSize <= MAX_SOURCE_SWEEP_CHUNK
    ? d.sourceSweepChunkSize : MAX_SOURCE_SWEEP_CHUNK;

  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new ScheduleRuntimeError('db-required', 'חובה להזריק Firestore');
  }
  if (!FV || typeof FV.serverTimestamp !== 'function') {
    throw new ScheduleRuntimeError('field-value-required', 'חובה להזריק FieldValue');
  }
  if (typeof FieldPath !== 'function') {
    throw new ScheduleRuntimeError('field-path-required', 'חובה להזריק FieldPath');
  }
  if (typeof clock !== 'function' || typeof hash !== 'function' || typeof randomId !== 'function') {
    throw new ScheduleRuntimeError('runtime-dependencies', 'חסרות תלויות זמן, גיבוב או מזהים');
  }
  if (typeof createEngine !== 'function' || typeof createPublication !== 'function'
      || typeof createService !== 'function') {
    throw new ScheduleRuntimeError('schedule-modules-required', 'חסרים מודולי הסידור');
  }
  if (typeof sendPush !== 'function') {
    throw new ScheduleRuntimeError('push-required', 'חובה להזריק שולח התראות');
  }

  function digest(value) {
    return hash(stable(value));
  }

  // המודול שמייצר את מסמך המדיניות. טהור, ומקבל את אותם clock
  // ו-hash של הרנטיים — כדי שהחתימה שהוא יוצר תהיה בדיוק זו
  // ש-`loadPolicy` יחשב מחדש.
  const policyAuthor = policyAuthorModule.createPolicyAuthor({ clock, hash });
  // ⭐ טהור ובלי תלויות. מי רשאי להזיז מצב, ולאן מותר להזיז —
  // החלטה שאפשר לבדוק בלי Firestore ובלי דפדפן.
  const modeAuthority = modeAuthorityModule.createModeAuthority();
  const cutover = cutoverModule.createCutover({ hash, clock });
  const sourceAuthor = sourceAuthorModule.createSourceAuthor({ clock, hash });

  function stationRef(sid) {
    return db.collection('stations').doc(sid);
  }

  function runtimeRef(sid) {
    return stationRef(sid).collection('schedule_state').doc('runtime');
  }

  function activeRef(sid) {
    return stationRef(sid).collection('schedule_state').doc('active');
  }

  function scheduleAccessRef(sid, uid) {
    return stationRef(sid).collection('schedule_access').doc(uid);
  }

  function liveUserRef(sid, uid) {
    return stationRef(sid).collection('users').doc(uid);
  }

  function reportRuntimeError(code) {
    try {
      const pending = reportError(code);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (ignore) {}
  }

  function recipientIsActive(snap, sid) {
    return !!snap && snap.exists && scheduleAccess.activeMember(snap.data() || {}, sid);
  }

  function requireLiveManager(userSnap, accessSnap, ctx) {
    const user = userSnap && userSnap.exists ? (userSnap.data() || {}) : null;
    const access = accessSnap && accessSnap.exists ? (accessSnap.data() || {}) : null;
    if (!scheduleAccess.activeMember(user, ctx.sid)
        || !scheduleAccess.isManagerAccess(access, ctx.sid, ctx.uid)) {
      throw new ScheduleRuntimeError('manager-revoked',
        'מינוי אחראי/ת הסידור אינו פעיל עוד.', 'permission-denied');
    }
  }

  function requireId(value, code, label) {
    const out = String(value || '').trim();
    if (!ID_RE.test(out)) {
      throw new ScheduleRuntimeError(code, label + ' אינו תקין', 'invalid-argument');
    }
    return out;
  }

  async function context(req) {
    if (!req || !req.auth || !req.auth.uid) {
      throw new ScheduleRuntimeError('unauthenticated', 'צריך להיות מחובר.', 'unauthenticated');
    }
    const uid = String(req.auth.uid);
    if (!AUTH_UID_RE.test(uid)) {
      throw new ScheduleRuntimeError('auth-uid-invalid', 'מזהה החשבון אינו תקין.', 'unauthenticated');
    }
    const data = plain(req.data) ? req.data : {};
    if (Object.prototype.hasOwnProperty.call(data, 'stationId')
        || Object.prototype.hasOwnProperty.call(data, 'station_id')) {
      throw new ScheduleRuntimeError('client-station-forbidden',
        'התחנה נקבעת מהחשבון ואינה מתקבלת מהלקוח.', 'invalid-argument');
    }
    const token = req.auth.token || {};
    const sid = String(token.stationId || '').trim();
    if (!ID_RE.test(sid)) {
      throw new ScheduleRuntimeError('station-required',
        'לחשבון אין שיוך תחנה תקין.', 'failed-precondition');
    }
    const userSnap = await liveUserRef(sid, uid).get();
    if (!userSnap.exists) {
      throw new ScheduleRuntimeError('live-user-required',
        'החשבון אינו קיים ברשימת המשתמשים הפעילה של התחנה.', 'permission-denied');
    }
    const user = userSnap.data() || {};
    if (!scheduleAccess.activeMember(user, sid)) {
      throw new ScheduleRuntimeError('live-user-inactive',
        'החשבון אינו פעיל או שאינו משויך לתחנה.', 'permission-denied');
    }
    const role = String(user.role || '');
    if (!isSuper(req.auth) && MEMBER_ROLES.indexOf(role) === -1) {
      throw new ScheduleRuntimeError('role-forbidden', 'לתפקיד אין גישה לסידור.', 'permission-denied');
    }
    if (!isSuper(req.auth) && String(token.role || '') !== role) {
      throw new ScheduleRuntimeError('claims-stale',
        'הרשאות החשבון אינן מסונכרנות. יש לצאת ולהיכנס מחדש.', 'permission-denied');
    }
    // Never use a token claim or the profile itself for this capability:
    // an access record is read live for every call so a removal takes effect
    // immediately, without waiting for a token refresh.
    const accessSnap = await scheduleAccessRef(sid, uid).get();
    const access = accessSnap.exists ? (accessSnap.data() || {}) : null;
    return Object.freeze({
      uid,
      sid,
      role,
      super: isSuper(req.auth),
      name: String(user.full_name || user.name || token.name || uid).slice(0, 120),
      // The primary role remains unrelated to schedule editing.  A commander,
      // deputy or HR coordinator is view-only until explicitly appointed.
      manager: scheduleAccess.isManagerAccess(access, sid, uid),
      user
    });
  }

  function actor(ctx) {
    return {
      id: ctx.uid,
      role: ctx.manager ? 'scheduler' : 'firefighter',
      station_id: ctx.sid,
      active: true
    };
  }

  function capabilities() {
    const view = ['view_my', 'view_station', 'respond_own'];
    return {
      firefighter: view,
      scheduler: view.concat(['edit_draft', 'run_planner', 'publish'])
    };
  }

  function serviceFor(ctx, engine, publication) {
    const safeEngine = engine || { planPeriod: function () {}, policy: { station_id: ctx.sid } };
    const safePublication = publication || { planPublication: function () {} };
    return createService({
      clock,
      engine: safeEngine,
      publication: safePublication,
      rules: { station_id: ctx.sid, capabilities: capabilities() }
    });
  }

  async function configuration(sid) {
    const snap = await runtimeRef(sid).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const mode = MODES.indexOf(data.mode) !== -1 ? data.mode : MODE.OFF;
    return Object.freeze({
      mode,
      active_policy_id: nonEmpty(data.active_policy_id) ? data.active_policy_id : null,
      active_source_id: nonEmpty(data.active_source_id) ? data.active_source_id : null
    });
  }

  function requireManager(ctx) {
    if (!ctx.manager) {
      throw new ScheduleRuntimeError('manager-required',
        'עריכה ופרסום מותרים לאחראי/ת סידור שמונה/תה במפורש.', 'permission-denied');
    }
  }

  function requireAnalytics(ctx) {
    // A live schedule manager needs the same assignment-load view while
    // staffing a guard, even when their primary station role is firefighter.
    // That appointment is deliberately separate from every base role.
    if (!ctx.manager && !ctx.super && ANALYTICS_ROLES.indexOf(ctx.role) === -1) {
      throw new ScheduleRuntimeError('guard-statistics-forbidden',
        'נתוני עומס זמינים רק לתפקידי ניהול מורשים.', 'permission-denied');
    }
  }

  // Guards are deliberately independent from a published monthly plan.  A
  // station can open, postpone, staff, unstaff or cancel one at any time; the
  // only authority boundary is a *live* schedule-manager appointment.
  function guardRef(sid, guardId) {
    return stationRef(sid).collection('guards').doc(guardId);
  }

  function guardOperationRef(sid, requestId) {
    return stationRef(sid).collection('guard_operations').doc(requestId);
  }

  function guardAuditRef(sid, requestId) {
    return stationRef(sid).collection('guard_audit')
      .doc('a_' + hash('guard-audit|' + sid + '|' + requestId).slice(0, 48));
  }

  function guardOutboxRef(sid, requestId, uid) {
    return stationRef(sid).collection('guard_outbox')
      .doc('go_' + hash('guard-outbox|' + sid + '|' + requestId + '|' + uid).slice(0, 48));
  }

  function guardNotificationJobRef(sid, requestId, part) {
    return stationRef(sid).collection('guard_notification_jobs')
      .doc('gj_' + hash('guard-notification-job|' + sid + '|' + requestId + '|' + part).slice(0, 48));
  }

  function guardCreateId(ctx, requestId) {
    return 'g_' + hash('guard|' + ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 48);
  }

  function guardCommandError(error) {
    if (!(error instanceof guardManagement.GuardManagementError)) throw error;
    const code = error.code;
    const httpCode = code === 'guard-not-found' ? 'not-found'
      : (code === 'guard-revision-conflict' ? 'aborted'
        : (code === 'guard-already-exists' ? 'already-exists'
          : (code === 'guard-command-invalid' || code === 'guard-details-invalid'
            || code === 'guard-id-invalid' || code === 'guard-existing-invalid'
            ? 'invalid-argument' : 'failed-precondition')));
    throw new ScheduleRuntimeError(code, error.message, httpCode);
  }

  function changedGuardFields(before, after) {
    if (!before) return GUARD_MUTABLE_FIELDS.slice();
    return GUARD_MUTABLE_FIELDS.filter((field) => stable(before[field]) !== stable(after[field]));
  }

  function guardResult(plan, duplicate) {
    return {
      ok: true,
      duplicate: duplicate === true,
      changed: plan.changed === true,
      guard_id: plan.guard_id,
      status: plan.after.status,
      revision: Number(plan.after.revision),
      assigned: Array.isArray(plan.after.assigned) ? plan.after.assigned.length : 0,
      added: Array.isArray(plan.added) ? plan.added.length : 0,
      removed: Array.isArray(plan.removed) ? plan.removed.length : 0,
      notified_people: Array.isArray(plan.notifications) ? plan.notifications.length : 0
    };
  }

  function guardRequestFingerprint(ctx, command) {
    return digest({
      station_id: ctx.sid,
      actor_uid: ctx.uid,
      action: command.action,
      request_id: command.request_id,
      guard_id: command.guard_id || null,
      expected_revision: command.expected_revision === undefined ? null : command.expected_revision,
      details: command.details || null,
      uids: command.uids || null
    });
  }

  function putOwnMapValue(target, key, value) {
    Object.defineProperty(target, key, {
      value, enumerable: true, configurable: true, writable: true
    });
  }

  function previousAssignmentEpochs(raw) {
    const source = raw && raw.assignment_epochs;
    if (source === undefined) return {};
    if (!plain(source)) {
      throw new ScheduleRuntimeError('guard-assignment-epochs-invalid',
        'היסטוריית השיבוץ באבטחה אינה תקינה.', 'failed-precondition');
    }
    const result = {};
    const uids = Object.keys(source);
    if (uids.length > MAX_GUARD_ASSIGNMENT_EPOCHS) {
      throw new ScheduleRuntimeError('guard-assignment-history-limit',
        'היסטוריית השיבוץ באבטחה גדולה מדי לעדכון בטוח.', 'failed-precondition');
    }
    for (const uid of uids) {
      const value = source[uid];
      if (!AUTH_UID_RE.test(uid) || !Number.isSafeInteger(value) || value < 1) {
        throw new ScheduleRuntimeError('guard-assignment-epochs-invalid',
          'היסטוריית השיבוץ באבטחה אינה תקינה.', 'failed-precondition');
      }
      putOwnMapValue(result, uid, value);
    }
    return result;
  }

  function nextAssignmentEpochs(raw, action, plan) {
    if (action !== 'set_assignees' || !plan.changed) return null;
    const result = previousAssignmentEpochs(raw);
    for (const uid of plan.added.concat(plan.removed)) {
      putOwnMapValue(result, uid, Number(plan.after.revision));
    }
    if (Object.keys(result).length > MAX_GUARD_ASSIGNMENT_EPOCHS) {
      throw new ScheduleRuntimeError('guard-assignment-history-limit',
        'היסטוריית השיבוץ באבטחה גדולה מדי לעדכון בטוח.', 'failed-precondition');
    }
    return result;
  }

  function notificationChunks(plan, assignmentEpochs) {
    const notices = plan.notifications.map((notice) => {
      const item = { uid: notice.uid, kind: notice.kind };
      if ((notice.kind === 'assigned' || notice.kind === 'removed') && assignmentEpochs) {
        item.membership_epoch = Number(assignmentEpochs[notice.uid]);
      }
      return item;
    });
    const chunks = [];
    for (let offset = 0; offset < notices.length; offset += GUARD_NOTIFICATION_FANOUT_CHUNK) {
      chunks.push(notices.slice(offset, offset + GUARD_NOTIFICATION_FANOUT_CHUNK));
    }
    if (notices.length > MAX_GUARD_NOTIFICATION_RECIPIENTS
        || chunks.length > MAX_GUARD_NOTIFICATION_JOB_WRITES) {
      throw new ScheduleRuntimeError('guard-notification-limit',
        'מספר האנשים לעדכון גבוה מדי לפעולה אחת. יש לפצל את השינוי.', 'resource-exhausted');
    }
    return chunks;
  }

  // A newly opened guard is an operationally flexible opportunity, not an
  // immutable appointment.  Its audience comes from the same live `users`
  // authority used by every other schedule call — never from a stale roster
  // or client-supplied uid list.
  function openGuardRecipientIds(users, sid, creatorUid) {
    const docs = users && Array.isArray(users.docs) ? users.docs : [];
    if (docs.length > MAX_GUARD_OPEN_AUDIENCE) {
      // This is a permanent capacity condition, not a transient Firestore
      // failure.  The caller records a terminal manifest below so Eventarc
      // does not retry the same 5,001-document read forever.
      return Object.freeze({ recipients: Object.freeze([]), over_limit: true });
    }
    const unique = new Set();
    for (const doc of docs) {
      const uid = String(doc && doc.id || '');
      const profile = doc && typeof doc.data === 'function' ? (doc.data() || {}) : {};
      if (!AUTH_UID_RE.test(uid) || uid === creatorUid
          || !scheduleAccess.activeMember(profile, sid)) continue;
      unique.add(uid);
    }
    return Object.freeze({
      recipients: Object.freeze(Array.from(unique).sort(compareCanonical)),
      over_limit: false
    });
  }

  function openGuardRequestId(sid, guardId, revision) {
    return 'open_' + hash('guard-open|' + sid + '|' + guardId + '|' + revision).slice(0, 48);
  }

  async function enqueueGuardOpenNotifications(input) {
    const raw = plain(input) ? input : {};
    const sid = requireId(raw.sid, 'guard-station-invalid', 'תחנת האבטחה');
    const guardId = requireId(raw.guard_id, 'guard-id-invalid', 'מזהה האבטחה');
    // This is the creation event's revision, not the revision observed by a
    // delayed/retried trigger.  It is the stable idempotency key: later edits
    // may leave the guard open, but must never mint another "new guard" push.
    const eventRevision = Number(raw.revision);
    if (!Number.isSafeInteger(eventRevision) || eventRevision < 1) {
      return { skipped: true, reason: 'event-revision-invalid' };
    }
    const now = Date.parse(clock());
    if (!Number.isFinite(now)) {
      throw new ScheduleRuntimeError('clock-invalid', 'שעון השרת אינו תקין.');
    }
    const targetRef = guardRef(sid, guardId);
    return db.runTransaction(async (tx) => {
      const manifestRef = guardNotificationJobRef(sid, openGuardRequestId(sid, guardId, eventRevision), 0);
      const initial = await Promise.all([tx.get(targetRef), tx.get(manifestRef)]);
      const snap = initial[0];
      if (!snap.exists) return { skipped: true, reason: 'guard-not-found' };
      // The manifest is the immutable audience boundary.  A Firestore event
      // is at-least-once: never recompute recipients or append a new part on
      // a later retry after the station roster has changed.
      if (initial[1].exists) return { duplicate: true, jobs: 0 };
      const guard = snap.data() || {};
      const currentRevision = Number(guard.revision || 0);
      // A rapid assignment, postponement, cancellation or completion wins
      // over an eventual creation trigger.  Leaving an unstaffed guard open
      // remains normal and continues to qualify for its generic invitation.
      if (guard.status !== 'open'
          || !Number.isSafeInteger(currentRevision) || currentRevision < eventRevision
          || !DATE_RE.test(String(guard.date || ''))
          || !/^\d{2}:\d{2}$/.test(String(guard.start || ''))
          || !/^\d{2}:\d{2}$/.test(String(guard.end || ''))) {
        return { skipped: true, reason: 'guard-not-open' };
      }
      const users = await tx.get(stationRef(sid).collection('users')
        .limit(MAX_GUARD_OPEN_AUDIENCE + 1));
      const audience = openGuardRecipientIds(users, sid, String(guard.by_uid || ''));
      const recipients = audience.recipients;
      const requestId = openGuardRequestId(sid, guardId, eventRevision);
      const chunks = audience.over_limit ? [] : notificationChunks({
        notifications: recipients.map((uid) => ({ uid, kind: 'open' }))
      }, null);
      // Part zero is a completed server-only manifest, even for an empty
      // audience.  Recipient chunks start at one so the manifest is both a
      // retry sentinel and an immutable audit of the event revision.
      tx.create(manifestRef, {
        station_id: sid,
        guard_id: guardId,
        revision: eventRevision,
        date: String(guard.date),
        start: String(guard.start),
        end: String(guard.end),
        request_id: requestId,
        part: 0,
        notifications: [],
        audience_manifest: true,
        audience_size: audience.over_limit ? null : recipients.length,
        audience_limit: audience.over_limit ? MAX_GUARD_OPEN_AUDIENCE : null,
        cursor: 0,
        status: audience.over_limit ? 'failed' : 'complete',
        expires_at: new Date(now + OUTBOX_TTL_MS),
        created_at: FV.serverTimestamp(),
        completed_at: audience.over_limit ? null : FV.serverTimestamp(),
        failed_at: audience.over_limit ? FV.serverTimestamp() : null,
        lease_token: null,
        lease_until: null,
        last_error: audience.over_limit ? 'AUDIENCE_LIMIT' : null
      });
      chunks.forEach((notifications, offset) => {
        tx.create(guardNotificationJobRef(sid, requestId, offset + 1), {
          station_id: sid,
          guard_id: guardId,
          revision: eventRevision,
          date: String(guard.date),
          start: String(guard.start),
          end: String(guard.end),
          request_id: requestId,
          part: offset + 1,
          notifications,
          cursor: 0,
          status: 'queued',
          expires_at: new Date(now + OUTBOX_TTL_MS),
          created_at: FV.serverTimestamp(),
          lease_token: null,
          lease_until: null,
          last_error: null
        });
      });
      return audience.over_limit
        ? { skipped: true, reason: 'recipient-limit', jobs: 0 }
        : { queued: recipients.length, jobs: chunks.length, duplicate: false };
    });
  }

  function guardWriteData(ctx, plan, assignmentEpochs) {
    const value = {};
    GUARD_MUTABLE_FIELDS.forEach((field) => { value[field] = plan.after[field]; });
    // Revision is a server-owned concurrency token, not an editable guard
    // field.  It must still be persisted with every real mutation.
    value.revision = Number(plan.after.revision);
    value.updated_by = ctx.uid;
    value.updated_at = FV.serverTimestamp();
    if (plan.before === null) {
      value.by_uid = ctx.uid;
      value.created_by = ctx.uid;
      value.created_at = FV.serverTimestamp();
      value.signups = {};
    }
    if (plan.added && plan.added.length || plan.removed && plan.removed.length) {
      value.assigned_by = ctx.uid;
      value.assigned_at = FV.serverTimestamp();
    }
    if (plan.after.status === 'cancelled') {
      value.cancelled_by = ctx.uid;
      value.cancelled_at = FV.serverTimestamp();
    }
    if (plan.after.status === 'done') {
      value.completed_by = ctx.uid;
      value.completed_at = FV.serverTimestamp();
    }
    if (assignmentEpochs) value.assignment_epochs = assignmentEpochs;
    return value;
  }

  async function manageGuard(req) {
    const ctx = await context(req);
    requireManager(ctx);
    let command;
    try {
      command = guardManagement.parseCommand(plain(req.data) ? req.data : {});
    } catch (error) {
      guardCommandError(error);
    }
    const requestFingerprint = guardRequestFingerprint(ctx, command);
    const deterministicGuardId = command.action === 'create'
      ? guardCreateId(ctx, command.request_id) : command.guard_id;
    const targetRef = guardRef(ctx.sid, deterministicGuardId);
    const operationRef = guardOperationRef(ctx.sid, command.request_id);
    const requestedUids = command.action === 'set_assignees' ? command.uids : [];
    const uniqueUids = Array.from(new Set(requestedUids)).sort(compareCanonical);
    const now = Date.parse(clock());
    if (!Number.isFinite(now)) {
      throw new ScheduleRuntimeError('clock-invalid', 'שעון השרת אינו תקין.');
    }

    return db.runTransaction(async (tx) => {
      // Every read precedes every write.  In particular, the appointment is
      // reread inside the transaction so revoking it wins a concurrent click.
      const actorUserRef = liveUserRef(ctx.sid, ctx.uid);
      const accessRef = scheduleAccessRef(ctx.sid, ctx.uid);
      const personRefs = uniqueUids.map((uid) => liveUserRef(ctx.sid, uid));
      const refs = [actorUserRef, accessRef, operationRef, targetRef].concat(personRefs);
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      requireLiveManager(snaps[0], snaps[1], ctx);

      const existingOperation = snaps[2].exists ? (snaps[2].data() || {}) : null;
      if (existingOperation) {
        if (existingOperation.actor_uid !== ctx.uid
            || existingOperation.request_fingerprint !== requestFingerprint
            || !plain(existingOperation.result)) {
          throw new ScheduleRuntimeError('guard-request-conflict',
            'מזהה הפעולה כבר שייך לבקשה אחרת.', 'already-exists');
        }
        return Object.assign({}, existingOperation.result, { duplicate: true });
      }

      const activeUids = [];
      for (let i = 0; i < uniqueUids.length; i += 1) {
        const person = snaps[4 + i];
        if (person && person.exists && scheduleAccess.activeMember(person.data() || {}, ctx.sid)) {
          activeUids.push(uniqueUids[i]);
        }
      }

      const existingGuard = snaps[3].exists ? (snaps[3].data() || {}) : null;
      let plan;
      try {
        plan = guardManagement.operation(
          existingGuard,
          command,
          activeUids,
          deterministicGuardId
        );
      } catch (error) {
        guardCommandError(error);
      }

      const assignmentEpochs = nextAssignmentEpochs(existingGuard, command.action, plan);
      const notificationJobs = notificationChunks(plan, assignmentEpochs);

      const result = guardResult(plan, false);
      const operationData = {
        station_id: ctx.sid,
        request_id: command.request_id,
        actor_uid: ctx.uid,
        request_fingerprint: requestFingerprint,
        action: command.action,
        guard_id: plan.guard_id,
        result,
        expires_at: new Date(now + OUTBOX_TTL_MS),
        created_at: FV.serverTimestamp()
      };
      tx.create(operationRef, operationData);

      if (!plan.changed) return result;

      const write = guardWriteData(ctx, plan, assignmentEpochs);
      if (plan.before === null) tx.create(targetRef, write);
      else tx.update(targetRef, write);

      tx.create(guardAuditRef(ctx.sid, command.request_id), {
        station_id: ctx.sid,
        guard_id: plan.guard_id,
        action: command.action,
        actor_uid: ctx.uid,
        before_revision: plan.before ? Number(plan.before.revision) : 0,
        after_revision: Number(plan.after.revision),
        before_status: plan.before ? plan.before.status : null,
        after_status: plan.after.status,
        changed_fields: changedGuardFields(plan.before, plan.after),
        created_at: FV.serverTimestamp()
      });

      // This is an allow-list on purpose.  Event text, location, notes,
      // sign-ups and the names of other people never enter a push payload or
      // its durable retry record.
      notificationJobs.forEach((notifications, part) => {
        tx.create(guardNotificationJobRef(ctx.sid, command.request_id, part), {
          station_id: ctx.sid,
          guard_id: plan.guard_id,
          revision: Number(plan.after.revision),
          date: plan.after.date,
          start: plan.after.start,
          end: plan.after.end,
          request_id: command.request_id,
          part,
          notifications,
          cursor: 0,
          status: 'queued',
          expires_at: new Date(now + OUTBOX_TTL_MS),
          created_at: FV.serverTimestamp(),
          lease_token: null,
          lease_until: null,
          last_error: null
        });
      });
      return result;
    });
  }

  // Registering interest is deliberately not an operational-notification
  // revision: it does not change the time, status or team.  The transaction is the
  // important part: a cancellation/complete operation and a late signup
  // serialize on the same guard document, so a signup can never land after a
  // terminal state.  Keeping the revision unchanged also means an ordinary
  // manager notification is not made stale by someone merely pressing
  // "interested".
  async function signupGuard(req) {
    const ctx = await context(req);
    const raw = plain(req.data) ? req.data : {};
    const allowed = ['id', 'join'];
    if (Object.keys(raw).some((key) => allowed.indexOf(key) === -1)) {
      throw new ScheduleRuntimeError('guard-signup-invalid',
        'בקשת ההרשמה כוללת שדה שאינו מורשה.', 'invalid-argument');
    }
    const guardId = requireId(raw.id, 'guard-id-invalid', 'מזהה האבטחה');
    const join = Object.prototype.hasOwnProperty.call(raw, 'join') ? raw.join : true;
    if (typeof join !== 'boolean') {
      throw new ScheduleRuntimeError('guard-signup-invalid',
        'מצב ההרשמה אינו תקין.', 'invalid-argument');
    }
    const targetRef = guardRef(ctx.sid, guardId);
    return db.runTransaction(async (tx) => {
      // Re-read the live member inside the transaction.  A station removal
      // that races the click therefore wins before the guard is touched.
      const snaps = await Promise.all([
        tx.get(liveUserRef(ctx.sid, ctx.uid)),
        tx.get(targetRef)
      ]);
      const user = snaps[0].exists ? (snaps[0].data() || {}) : null;
      if (!scheduleAccess.activeMember(user, ctx.sid)
          || (!isSuper(req.auth) && MEMBER_ROLES.indexOf(String(user && user.role || '')) === -1)
          || (!isSuper(req.auth) && String(user && user.role || '') !== ctx.role)) {
        throw new ScheduleRuntimeError('live-user-inactive',
          'החשבון אינו פעיל או שאינו משויך לתחנה.', 'permission-denied');
      }
      if (!snaps[1].exists) {
        throw new ScheduleRuntimeError('guard-not-found', 'האבטחה לא נמצאה.', 'not-found');
      }
      const guard = snaps[1].data() || {};
      if (guard.status === 'cancelled' || guard.status === 'done') {
        throw new ScheduleRuntimeError('guard-terminal',
          'אבטחה שבוטלה או הסתיימה אינה פתוחה להרשמה.', 'failed-precondition');
      }
      if (guard.status !== 'open' && guard.status !== 'staffed') {
        throw new ScheduleRuntimeError('guard-status-invalid',
          'מצב האבטחה אינו מאפשר הרשמה.', 'failed-precondition');
      }
      const assigned = Array.isArray(guard.assigned) ? guard.assigned : [];
      if (assigned.indexOf(ctx.uid) !== -1) {
        throw new ScheduleRuntimeError('guard-already-assigned',
          'אתה כבר משובץ. ביטול עובר דרך אחראי/ת הסידור.', 'failed-precondition');
      }
      if (guard.signups !== undefined && !plain(guard.signups)) {
        throw new ScheduleRuntimeError('guard-signups-invalid',
          'רשימת ההרשמה באבטחה אינה תקינה.', 'failed-precondition');
      }
      const signups = plain(guard.signups) ? guard.signups : {};
      const joined = Object.prototype.hasOwnProperty.call(signups, ctx.uid);
      if (joined === join) return { ok: true, joined: join, changed: false };
      // Leaving is always allowed.  Only a new interest is bounded, so a
      // large old list can never make a cancellation or an opt-out impossible.
      if (join) {
        const interested = new Set(assigned.concat(Object.keys(signups)));
        if (interested.size >= MAX_GUARD_SIGNUPS) {
          throw new ScheduleRuntimeError('guard-signup-limit',
            'רשימת המתעניינים באבטחה מלאה. אפשר לנסות שוב אם יתפנה מקום.',
            'resource-exhausted');
        }
      }

      const displayName = String(user.full_name || user.name || ctx.uid).trim();
      const crew = String(user.crew || user.shift || '').trim();
      const safeName = CONTROL_RE.test(displayName) ? ctx.uid : displayName.slice(0, 120);
      const safeCrew = CONTROL_RE.test(crew) ? '' : crew.slice(0, 40);
      // Firebase Auth UIDs may legally contain a dot.  FieldPath keeps that
      // UID one literal map key rather than treating it as a dotted update
      // path (which could otherwise write below an unintended signup key).
      tx.update(targetRef,
        new FieldPath('signups', ctx.uid),
        join ? { name: safeName, crew: safeCrew, at: clock() } : FV.delete(),
        'updated_at', FV.serverTimestamp());
      return { ok: true, joined: join, changed: true };
    });
  }

  function requireMode(config, allowed) {
    if (allowed.indexOf(config.mode) === -1) {
      throw new ScheduleRuntimeError('schedule-mode-blocked',
        'מנוע הסידור אינו מופעל לפעולה הזאת. מצב נוכחי: ' + config.mode);
    }
    if (!config.active_policy_id || !config.active_source_id) {
      throw new ScheduleRuntimeError('schedule-config-incomplete',
        'לא הוגדרו מדיניות ומקור נתונים פעילים.');
    }
  }

  async function readSorted(collection) {
    const snap = await collection.get();
    return snap.docs.slice().sort((a, b) => compareCanonical(a.id, b.id));
  }

  function validateLockedSource(locked, peopleRaw, policyValue) {
    const people = new Set((Array.isArray(peopleRaw) ? peopleRaw : [])
      .map((person) => person && person.id).filter((id) => typeof id === 'string'));
    const policySubs = policyValue && plain(policyValue.sub_stations)
      ? policyValue.sub_stations : null;
    for (const sub of Object.keys(locked).sort(compareCanonical)) {
      if (!safeSubKey(sub)) {
        throw new ScheduleRuntimeError('source-locked-sub-station-invalid',
          'מקור הסידור כולל מזהה תחנת קצה לא תקין בנעילות.');
      }
      if (policySubs && (!hasOwn(policySubs, sub) || !plain(policySubs[sub]))) {
        throw new ScheduleRuntimeError('source-locked-sub-station-unknown',
          'מקור הסידור כולל נעילה לתחנת קצה שאינה קיימת במדיניות.');
      }
      const days = locked[sub];
      if (!plain(days)) {
        throw new ScheduleRuntimeError('source-locked-shape',
          'מבנה השיבוצים הידניים במקור אינו תקין.');
      }
      const allowedRoles = policySubs
        ? new Set((Array.isArray(policySubs[sub].requirements)
          ? policySubs[sub].requirements : [])
          .map((item) => item && item.role).filter(nonEmpty))
        : null;
      for (const date of Object.keys(days).sort(compareCanonical)) {
        try { isoDayOffset(date, 0); } catch (_) {
          throw new ScheduleRuntimeError('source-locked-date-invalid',
            'מקור הסידור כולל תאריך נעילה לא תקין.');
        }
        const entries = days[date];
        if (!Array.isArray(entries)) {
          throw new ScheduleRuntimeError('source-locked-shape',
            'כל יום נעול חייב להכיל מערך שיבוצים ידניים.');
        }
        for (const raw of entries) {
          if (plain(raw) && Object.keys(raw)
            .some((key) => ['person', 'role'].indexOf(key) === -1)) {
            throw new ScheduleRuntimeError('source-locked-shape',
              'רשומת שיבוץ ידני כוללת שדה שאינו מורשה.');
          }
          const person = plain(raw) ? raw.person : raw;
          const role = plain(raw) ? raw.role : null;
          if (typeof person !== 'string' || !AUTH_UID_RE.test(person) || !people.has(person)) {
            throw new ScheduleRuntimeError('source-locked-person-unknown',
              'מקור הסידור כולל נעילה לאדם שאינו נמצא בסגל.');
          }
          if (role !== null && role !== undefined
              && (typeof role !== 'string' || !nonEmpty(role)
                || (allowedRoles && !allowedRoles.has(role)))) {
            throw new ScheduleRuntimeError('source-locked-role-unknown',
              'מקור הסידור כולל נעילה לתפקיד שאינו קיים בתחנת הקצה.');
          }
        }
      }
    }
  }

  async function loadPolicy(ctx, id) {
    const policyId = requireId(id, 'policy-id', 'מזהה המדיניות');
    const snap = await stationRef(ctx.sid).collection('schedule_policies').doc(policyId).get();
    if (!snap.exists) throw new ScheduleRuntimeError('policy-not-found', 'מדיניות הסידור לא נמצאה.');
    const raw = snap.data() || {};
    if (raw.station_id !== ctx.sid || raw.complete !== true || !nonEmpty(raw.version)) {
      throw new ScheduleRuntimeError('policy-incomplete', 'מדיניות הסידור אינה מלאה או שייכת לתחנה אחרת.');
    }
    if (!plain(raw.sub_stations) || Object.keys(raw.sub_stations).some((key) => !safeSubKey(key))) {
      throw new ScheduleRuntimeError('policy-incomplete', 'מדיניות הסידור כוללת מזהה תחנת קצה לא חוקי.');
    }
    const basis = {
      station_id: raw.station_id,
      version: raw.version,
      sub_stations: raw.sub_stations,
      rest: raw.rest,
      rotation: Object.prototype.hasOwnProperty.call(raw, 'rotation') ? raw.rotation : undefined,
      max_shifts_per_month: Object.prototype.hasOwnProperty.call(raw, 'max_shifts_per_month')
        ? raw.max_shifts_per_month : undefined
    };
    const actual = digest(basis);
    if (!nonEmpty(raw.content_digest) || raw.content_digest !== actual) {
      throw new ScheduleRuntimeError('policy-digest-mismatch',
        'חתימת מדיניות הסידור אינה תואמת לתוכן.');
    }
    return Object.freeze({
      id: policyId,
      digest: actual,
      value: Object.assign({}, basis, { digest: actual })
    });
  }

  async function loadSource(ctx, id) {
    const sourceId = requireId(id, 'source-id', 'מזהה המקור');
    const ref = stationRef(ctx.sid).collection('schedule_sources').doc(sourceId);
    const snap = await ref.get();
    if (!snap.exists) throw new ScheduleRuntimeError('source-not-found', 'מקור הסידור לא נמצא.');
    const meta = snap.data() || {};
    if (meta.station_id !== ctx.sid || meta.complete !== true
        || !nonEmpty(meta.version) || !nonEmpty(meta.revision)) {
      throw new ScheduleRuntimeError('source-incomplete', 'מקור הסידור אינו מלא או שייך לתחנה אחרת.');
    }
    for (const field of ['person_count', 'availability_count', 'locked_count', 'event_count']) {
      if (!integer(meta[field]) || meta[field] < 0) {
        throw new ScheduleRuntimeError('source-count-required', 'למקור חסרה ספירה חתומה: ' + field);
      }
    }
    if (meta.person_count > MAX_SOURCE_PEOPLE
        || meta.availability_count > MAX_SOURCE_GROUP
        || meta.locked_count > MAX_SOURCE_GROUP
        || meta.event_count > MAX_SOURCE_GROUP
        || meta.person_count + meta.availability_count + meta.locked_count + meta.event_count
           > MAX_SOURCE_TOTAL) {
      throw new ScheduleRuntimeError('source-count-limit',
        'מקור הסידור גדול מהתקרה המאושרת ולכן לא ייקרא.', 'resource-exhausted');
    }
    const groups = await Promise.all([
      readSorted(ref.collection('people')),
      readSorted(ref.collection('availability')),
      readSorted(ref.collection('locked')),
      readSorted(ref.collection('events'))
    ]);
    if (groups[0].length !== meta.person_count || groups[1].length !== meta.availability_count
        || groups[2].length !== meta.locked_count || groups[3].length !== meta.event_count) {
      throw new ScheduleRuntimeError('source-count-mismatch',
        'מקור הסידור אינו שלם: מספר הרשומות אינו תואם לחוזה.');
    }
    const peopleRaw = groups[0].map((doc) => Object.assign({ id: doc.id }, doc.data() || {}));
    const availability = {};
    groups[1].forEach((doc) => { availability[doc.id] = (doc.data() || {}).days || {}; });
    const locked = {};
    groups[2].forEach((doc) => { locked[doc.id] = (doc.data() || {}).days || {}; });
    const eventsRaw = groups[3].map((doc) => Object.assign({ id: doc.id }, doc.data() || {}));
    validateLockedSource(locked, peopleRaw, null);
    const basis = {
      station_id: meta.station_id,
      version: meta.version,
      revision: meta.revision,
      carry: plain(meta.carry) ? meta.carry : {},
      counts: {
        people: meta.person_count,
        availability: meta.availability_count,
        locked: meta.locked_count,
        events: meta.event_count
      },
      people: peopleRaw,
      availability,
      locked,
      events: eventsRaw
    };
    const actual = digest(basis);
    if (!nonEmpty(meta.content_digest) || meta.content_digest !== actual) {
      throw new ScheduleRuntimeError('source-digest-mismatch',
        'חתימת מקור הסידור אינה תואמת לתוכן.');
    }
    /* `content_key` is an optimization, but it decides whether an import is
     * skipped. It must therefore be derived from the already verified roster,
     * never trusted as unsigned metadata. */
    const actualContentKey = String(hash(stable({
      station_id: meta.station_id,
      people: peopleRaw
    })));
    if (!nonEmpty(meta.content_key) || meta.content_key !== actualContentKey) {
      throw new ScheduleRuntimeError('source-content-key-mismatch',
        'מפתח תוכן הסגל אינו תואם למקור החתום.');
    }
    return {
      id: sourceId,
      version: meta.version,
      revision: meta.revision,
      digest: actual,
      contentKey: actualContentKey,
      carry: plain(meta.carry) ? meta.carry : {},
      peopleRaw,
      availability,
      locked,
      eventsRaw
    };
  }

  function normalizeOverrides(value, policy) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_OVERRIDES) {
      throw new ScheduleRuntimeError('overrides-invalid',
        'רשימת השינויים הידניים אינה תקינה.', 'invalid-argument');
    }
    return value.map((entry) => {
      if (!plain(entry) || !DATE_RE.test(String(entry.date || ''))
          || !nonEmpty(entry.sub_station) || !nonEmpty(entry.person)
          || (entry.role !== null && entry.role !== undefined && !nonEmpty(entry.role))) {
        throw new ScheduleRuntimeError('override-invalid',
          'שינוי ידני חייב לכלול תאריך, תחנת קצה ואדם.', 'invalid-argument');
      }
      if (!safeSubKey(entry.sub_station) || !hasOwn(policy.sub_stations, entry.sub_station)
          || !plain(policy.sub_stations[entry.sub_station])) {
        throw new ScheduleRuntimeError('override-sub-station',
          'תחנת הקצה בשינוי הידני אינה קיימת.', 'invalid-argument');
      }
      if (entry.role && isReservedKey(entry.role)) {
        throw new ScheduleRuntimeError('override-invalid',
          'שינוי ידני חייב לכלול תאריך, תחנת קצה ואדם.', 'invalid-argument');
      }
      return {
        date: entry.date,
        sub_station: entry.sub_station,
        person: entry.person,
        role: entry.role || null
      };
    }).sort((a, b) => compareCanonical(stable(a), stable(b)));
  }

  function effectiveSource(ctx, source, policy, overrides) {
    const locked = JSON.parse(JSON.stringify(source.locked));
    validateLockedSource(locked, source.peopleRaw, policy.value);
    overrides.forEach((entry) => {
      if (!hasOwn(locked, entry.sub_station) || !plain(locked[entry.sub_station])) locked[entry.sub_station] = {};
      const days = locked[entry.sub_station];
      if (!hasOwn(days, entry.date) || !Array.isArray(days[entry.date])) days[entry.date] = [];
      days[entry.date].push({ person: entry.person, role: entry.role });
    });
    const effectiveDigest = digest({ source_digest: source.digest, overrides });
    const revision = source.revision + '-' + effectiveDigest.slice(0, 12);
    const snapshot = source.id + '-' + effectiveDigest.slice(0, 16);
    const roster = source.peopleRaw.map((person) => Object.assign({}, person, {
      station_id: ctx.sid,
      source_snapshot: snapshot,
      source_version: source.version,
      contract_station_id: ctx.sid,
      source_revision: revision,
      source_digest: effectiveDigest,
      source_complete: true
    }));
    const events = source.eventsRaw.map((event) => Object.assign({}, event, {
      station_id: ctx.sid,
      source_snapshot: snapshot,
      source_version: source.version
    }));
    return { snapshot, version: source.version, revision, digest: effectiveDigest,
      roster, availability: source.availability, locked, carry: source.carry, events,
      policy_digest: policy.digest };
  }

  function flattenPlanSet(set) {
    if (!set || !Array.isArray(set.periods) || !set.periods.length) {
      throw new ScheduleRuntimeError('plan-empty', 'המנוע לא החזיר תקופות לסידור.');
    }
    const first = set.periods[0];
    const last = set.periods[set.periods.length - 1];
    const rows = [];
    const summary = {
      filled: 0, blocking_gaps: 0, days_below_minimum: 0,
      rejected_manual: 0, open_rows: 0
    };
    set.periods.forEach((period) => {
      period.rows.forEach((row) => rows.push(row));
      Object.keys(summary).forEach((key) => { summary[key] += Number(period.summary[key] || 0); });
    });
    summary.load = last.summary.load;
    summary.fairness = last.summary.fairness;
    return {
      kind: 'schedule-plan',
      station_id: first.station_id,
      source_snapshot: first.source_snapshot,
      source_version: first.source_version,
      contract_station_id: first.contract_station_id,
      source_revision: first.source_revision,
      source_digest: first.source_digest,
      policy_version: first.policy_version,
      policy_digest: first.policy_digest,
      source_complete: true,
      generated_at: first.generated_at,
      from: first.from,
      to: last.to,
      rows,
      summary,
      carry: set.carry
    };
  }

  async function commitWrites(ops) {
    for (let i = 0; i < ops.length; i += MAX_BATCH_WRITES) {
      const batch = db.batch();
      ops.slice(i, i + MAX_BATCH_WRITES).forEach((op) => {
        if (op.kind === 'update') batch.update(op.ref, op.data);
        else if (op.kind === 'create') batch.create(op.ref, op.data);
        else batch.set(op.ref, op.data, op.options || undefined);
      });
      await batch.commit();
    }
  }

  function rowDocument(row) {
    const value = { date: row.date, sub_station: row.sub_station, row };
    if (Buffer.byteLength(stable(value), 'utf8') > MAX_ROW_BYTES) {
      throw new ScheduleRuntimeError('schedule-row-too-large',
        'שורת סידור גדולה מכדי להישמר בבטחה.');
    }
    return value;
  }

  function timeMillis(value) {
    if (value && typeof value.toMillis === 'function') return Number(value.toMillis());
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    return Date.parse(String(value || ''));
  }

  function outboxExpired(value, now) {
    const expiresAt = timeMillis(value && value.expires_at);
    // Notifications without a valid, future expiry are fail-closed.  Firestore
    // TTL cleanup is asynchronous and therefore cannot be a delivery guard.
    return !Number.isFinite(expiresAt) || expiresAt <= now;
  }

  function isManagerRevoked(error) {
    return error instanceof ScheduleRuntimeError && error.code === 'manager-revoked';
  }

  async function cancelStagedSnapshot(ref, reason) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const value = snap.data() || {};
      if (value.status !== 'staging') return;
      tx.update(ref, {
        status: 'cancelled', cancel_reason: reason,
        cancelled_at: FV.serverTimestamp()
      });
    });
  }

  async function stageSnapshot(ref, meta, plan, events, people) {
    const rows = plan.rows.slice().sort((a, b) => {
      const ak = a.date + '|' + a.sub_station;
      const bk = b.date + '|' + b.sub_station;
      return compareCanonical(ak, bk);
    });
    const orderedEvents = (events || []).slice().sort((a, b) => compareCanonical(a.id, b.id));
    const peopleById = new Map();
    (people || []).forEach((person) => {
      if (!person || !nonEmpty(person.id) || peopleById.has(person.id)) return;
      peopleById.set(person.id, {
        id: person.id,
        name: String(person.full_name || person.name || person.id).slice(0, 120),
        sub_station: person.sub_station || null,
        roles: Array.isArray(person.roles) ? person.roles.slice() : [],
        qualifications: Array.isArray(person.qualifications) ? person.qualifications.slice() : []
      });
    });
    const orderedPeople = Array.from(peopleById.keys()).sort().map((id) => peopleById.get(id));
    const contentDigest = digest({
      contract: {
        station_id: plan.station_id, source_snapshot: plan.source_snapshot,
        source_version: plan.source_version, source_revision: plan.source_revision,
        source_digest: plan.source_digest, policy_version: plan.policy_version,
        policy_digest: plan.policy_digest, source_complete: plan.source_complete
      }, rows, events: orderedEvents, people: orderedPeople
    });
    const ops = [];
    rows.forEach((row) => {
      ops.push({
        ref: ref.collection('rows').doc('r_' + digest(row.date + '|' + row.sub_station).slice(0, 40)),
        data: rowDocument(row), kind: 'set'
      });
    });
    orderedEvents.forEach((event) => {
      ops.push({
        ref: ref.collection('events').doc('e_' + digest(String(event.id)).slice(0, 40)),
        data: event, kind: 'set'
      });
    });
    orderedPeople.forEach((person) => {
      ops.push({
        ref: ref.collection('people').doc(person.id),
        data: person, kind: 'set'
      });
    });
    await commitWrites(ops);
    // Child documents may take several batches.  The snapshot remains staging
    // until a final transaction rechecks the live appointment and publishes
    // its completion atomically.  Never make staged data usable by itself.
    await ref.set(Object.assign({}, meta, {
      snapshot_complete: true, row_count: rows.length, event_count: orderedEvents.length,
      person_count: peopleById.size,
      content_digest: contentDigest, snapshot_completed_at: FV.serverTimestamp()
    }), { merge: true });
    return contentDigest;
  }

  async function finalizeDraft(ctx, ref, expectedDigest) {
    try {
      await beforeSnapshotFinalize({ kind: 'draft', ref, ctx });
      await db.runTransaction(async (tx) => {
        const refs = [liveUserRef(ctx.sid, ctx.uid), scheduleAccessRef(ctx.sid, ctx.uid), ref];
        const snaps = await Promise.all(refs.map((item) => tx.get(item)));
        requireLiveManager(snaps[0], snaps[1], ctx);
        const draft = snaps[2].exists ? (snaps[2].data() || {}) : {};
        if (draft.status !== 'staging' || draft.snapshot_complete !== true
            || draft.station_id !== ctx.sid || draft.content_digest !== expectedDigest) {
          throw new ScheduleRuntimeError('draft-snapshot-changed',
            'הטיוטה השתנתה או אינה שלמה ולכן נעצרה.', 'aborted');
        }
        tx.update(ref, { status: 'complete', completed_at: FV.serverTimestamp() });
      });
    } catch (error) {
      if (isManagerRevoked(error)) await cancelStagedSnapshot(ref, 'manager-revoked');
      throw error;
    }
  }

  async function requireLiveManagerNow(ctx) {
    await db.runTransaction(async (tx) => {
      const refs = [liveUserRef(ctx.sid, ctx.uid), scheduleAccessRef(ctx.sid, ctx.uid)];
      const snaps = await Promise.all(refs.map((item) => tx.get(item)));
      requireLiveManager(snaps[0], snaps[1], ctx);
    });
  }

  async function readSnapshot(ref, meta, dates) {
    let rowsQuery = ref.collection('rows');
    let eventsQuery = ref.collection('events');
    if (Array.isArray(dates) && dates.length) {
      rowsQuery = rowsQuery.where('date', 'in', dates);
      eventsQuery = eventsQuery.where('date', 'in', dates);
    }
    const pair = await Promise.all([rowsQuery.get(), eventsQuery.get()]);
    const rows = pair[0].docs.map((doc) => (doc.data() || {}).row)
      .sort((a, b) => compareCanonical(a.date + '|' + a.sub_station, b.date + '|' + b.sub_station));
    const events = pair[1].docs.map((doc) => doc.data() || {})
      .sort((a, b) => compareCanonical(a.id, b.id));
    let peopleDocs;
    if (Array.isArray(dates) && dates.length) {
      const ids = new Set();
      rows.forEach((row) => (row.slots || []).forEach((slot) => ids.add(slot.person)));
      events.forEach((event) => (event.people || []).forEach((id) => ids.add(id)));
      const refs = Array.from(ids).sort().map((id) => ref.collection('people').doc(id));
      peopleDocs = refs.length ? await db.getAll.apply(db, refs) : [];
    } else {
      peopleDocs = (await ref.collection('people').get()).docs;
    }
    const roster = peopleDocs.filter((doc) => doc.exists).map((doc) => doc.data() || {});
    if (!dates && (rows.length !== meta.row_count || events.length !== meta.event_count)) {
      throw new ScheduleRuntimeError('snapshot-count-mismatch',
        'תמונת הסידור אינה שלמה ולכן נעצרה.');
    }
    if (!dates && roster.length !== Number(meta.person_count || 0)) {
      throw new ScheduleRuntimeError('snapshot-people-mismatch',
        'מילון השמות של תמונת הסידור אינו שלם.');
    }
    const plan = {
      kind: 'schedule-plan', station_id: meta.station_id,
      source_snapshot: meta.source_snapshot, source_version: meta.source_version,
      contract_station_id: meta.contract_station_id,
      source_revision: meta.source_revision, source_digest: meta.source_digest,
      policy_version: meta.policy_version, policy_digest: meta.policy_digest,
      source_complete: meta.source_complete === true,
      generated_at: meta.generated_at || null, from: meta.from, to: meta.to,
      rows, summary: meta.summary || { blocking_gaps: 0, days_below_minimum: 0, rejected_manual: 0 }
    };
    if (!dates) {
      const orderedPeople = roster.slice().sort((a, b) => compareCanonical(a.id, b.id));
      const actualDigest = digest({
        contract: {
          station_id: plan.station_id, source_snapshot: plan.source_snapshot,
          source_version: plan.source_version, source_revision: plan.source_revision,
          source_digest: plan.source_digest, policy_version: plan.policy_version,
          policy_digest: plan.policy_digest, source_complete: plan.source_complete
        }, rows, events, people: orderedPeople
      });
      if (!nonEmpty(meta.content_digest) || meta.content_digest !== actualDigest) {
        throw new ScheduleRuntimeError('snapshot-digest-mismatch',
          'תמונת הסידור השתנתה או אינה שלמה ולכן נעצרה.');
      }
    }
    return { plan, events, roster };
  }

  // A caller may request a small visual window, but the immutable snapshot is
  // always read and hashed as a whole first.  Reading only matching rows would
  // make the content digest a promise rather than an actual integrity check.
  function sliceVerifiedSnapshot(snapshot, dates) {
    if (!Array.isArray(dates) || !dates.length) return snapshot;
    const wanted = new Set(dates);
    const rows = snapshot.plan.rows.filter((row) => wanted.has(row.date));
    const events = snapshot.events.filter((event) => wanted.has(event.date));
    const people = new Set();
    rows.forEach((row) => (row.slots || []).forEach((slot) => people.add(slot.person)));
    events.forEach((event) => (event.people || []).forEach((id) => people.add(id)));
    return {
      plan: Object.assign({}, snapshot.plan, { rows }),
      events,
      roster: snapshot.roster.filter((person) => people.has(person.id))
    };
  }

  async function getStatus(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const active = await activeRef(ctx.sid).get();
    const activeData = active.exists ? (active.data() || {}) : null;
    const activeView = activeData ? {
      publication_id: activeData.publication_id || null,
      revision: activeData.revision || 0
    } : null;
    if (activeView && ctx.manager) {
      activeView.previous_publication_id = activeData.previous_publication_id || null;
      activeView.can_rollback = nonEmpty(activeData.previous_publication_id);
      if (nonEmpty(activeView.publication_id)) {
        const delivery = await stationRef(ctx.sid).collection('schedule_publications')
          .doc(activeView.publication_id).collection('schedule_outbox')
          .where('status', 'in', ['retry', 'dead_letter']).limit(101).get();
        activeView.delivery_alerts = delivery.size;
        activeView.delivery_alerts_capped = delivery.size > 100;
      }
    }
    return {
      mode: config.mode,
      configured: Boolean(config.active_policy_id && config.active_source_id),
      manager: ctx.manager,
      active: activeView
    };
  }

  async function getManagerSetup(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);

    // ⭐ מקור בלי מדיניות אינו „לא מוגדר" — הוא המצב שממנו מתחילים.
    //
    // עד כאן התשובה במצב הזה הייתה רשימות ריקות, ולכן המסך לא יכול
    // היה להציע דבר: לא תחנות קצה ולא תפקידים. אבל שניהם **קיימים
    // במקור** — הם התחנות והתפקידים שיש בפועל לאנשים. מחזירים אותם
    // כתצפית, לא כברירת מחדל: בלי כמויות, בלי קו מינימום, ובלי שום
    // מספר שאיש לא בחר.
    if (!config.active_policy_id && config.active_source_id) {
      const source = await loadSource(ctx, config.active_source_id);
      const people = source.peopleRaw.filter((person) => person.active === true);
      const subs = new Map();
      const roles = new Set();
      people.forEach((person) => {
        if (nonEmpty(person.sub_station) && !subs.has(person.sub_station)) {
          subs.set(person.sub_station, {
            id: person.sub_station,
            label: nonEmpty(person.sub_station_label) ? person.sub_station_label : person.sub_station,
            people: 0
          });
        }
        if (nonEmpty(person.sub_station)) subs.get(person.sub_station).people += 1;
        (Array.isArray(person.roles) ? person.roles : []).forEach((role) => {
          if (nonEmpty(role)) roles.add(role);
        });
      });
      return {
        mode: config.mode,
        configured: false,
        policy: null,
        missing: ['policy'],
        source: { id: source.id, version: source.version, revision: source.revision },
        observed: {
          sub_stations: Array.from(subs.values()).sort((a, b) => compareCanonical(a.id, b.id)),
          roles: Array.from(roles).sort(compareCanonical)
        },
        sub_stations: [],
        people: people.map((person) => ({
          id: person.id,
          name: String(person.full_name || person.name || person.id).slice(0, 120),
          sub_station: person.sub_station,
          roles: Array.isArray(person.roles) ? person.roles.slice() : []
        }))
      };
    }

    if (!config.active_policy_id || !config.active_source_id) {
      return {
        mode: config.mode, configured: false, policy: null,
        missing: [config.active_policy_id ? null : 'policy',
          config.active_source_id ? null : 'source'].filter(Boolean),
        sub_stations: [], people: []
      };
    }
    const policy = await loadPolicy(ctx, config.active_policy_id);
    const source = await loadSource(ctx, config.active_source_id);
    return {
      mode: config.mode,
      configured: true,
      policy: {
        id: policy.id,
        version: policy.value.version,
        digest: policy.digest,
        // ⭐ המסך שולח את המזהה הזה בשמירה. בלעדיו אין דרך לזהות
        // ששני אנשים ערכו את אותם חוקים בשתי לשוניות.
        active_policy_id: config.active_policy_id,
        rest: policy.value.rest,
        rotation: policy.value.rotation === undefined ? null : policy.value.rotation,
        max_shifts_per_month: policy.value.max_shifts_per_month === undefined
          ? null : policy.value.max_shifts_per_month,
        sub_stations: Object.keys(policy.value.sub_stations).sort().map((id) => ({
          id,
          label: policy.value.sub_stations[id].label,
          minimum: policy.value.sub_stations[id].minimum,
          requirements: policy.value.sub_stations[id].requirements
        }))
      },
      source: { id: source.id, version: source.version, revision: source.revision },
      people: source.peopleRaw.filter((person) => person.active === true).map((person) => ({
        id: person.id,
        name: String(person.full_name || person.name || person.id).slice(0, 120),
        sub_station: person.sub_station,
        roles: Array.isArray(person.roles) ? person.roles.slice() : []
      }))
    };
  }

  /* ==================================================================
   *  כתיבת חוקי התחנה · הדבר שהיה חסר
   * ------------------------------------------------------------------
   *  עד כאן שום קוד בריפו לא כתב `schedule_policies`. `loadPolicy`
   *  קורא, `getManagerSetup` מציג, `runPlanner` דורש — ואיש אינו
   *  יוצר. זו הסיבה היחידה שהמנוע כבוי: לא דגל ולא באג, פשוט לא
   *  נבנה הדבר שמאכיל אותו.
   *
   *  שתי הפעולות כאן סוגרות בדיוק את הפער הזה, ולא יותר ממנו:
   *  הן **אינן** משנות `mode`, אינן נוגעות בסידור שפורסם, ואינן
   *  שולחות הודעה לאיש. הפעלת מנוע נשארת פעולה אנושית נפרדת.
   * ================================================================== */

  function policyRef(sid, policyId) {
    return stationRef(sid).collection('schedule_policies').doc(policyId);
  }

  /* ==================================================================
   *  מקור כוח האדם · הכתיבה
   * ------------------------------------------------------------------
   *  אותו פער בדיוק כמו במדיניות: `loadSource` קורא, `runPlanner`
   *  דורש, ואיש אינו כותב.
   *
   *  ⭐ הכתיבה מדורגת ולא טרנזקציונית, כי 300 אנשים הם 300 מסמכים
   *  ותקרת הטרנזקציה נמוכה מזה. זה בטוח **בזכות** `loadSource`:
   *  הוא דורש `complete === true` וגם התאמה מדויקת של הספירות, ולכן
   *  מקור שנכתב חלקית אינו „מקור עם פחות אנשים" — הוא מקור שאי אפשר
   *  לטעון בכלל. הדגל נכתב אחרון, בטרנזקציה, אחרי בדיקה חוזרת של
   *  המינוי החי.
   * ================================================================== */

  function sourceRef(sid, sourceId) {
    return stationRef(sid).collection('schedule_sources').doc(sourceId);
  }

  function sourceOperationRef(sid, requestId) {
    return stationRef(sid).collection('schedule_source_operations').doc(requestId);
  }

  function sourceAuditRef(sid, requestId) {
    return stationRef(sid).collection('schedule_source_audit')
      .doc('sa_' + hash('source-audit|' + sid + '|' + requestId).slice(0, 48));
  }

  function sourceOperationExpiry() {
    const now = timeMillis(clock());
    return new Date((Number.isFinite(now) ? now : Date.parse(clock())) + OUTBOX_TTL_MS);
  }

  // רשימת המשתמשים החיה של התחנה, כמיפוי מספר עובד → uid.
  // ⭐ נקראת **בשרת בלבד**. הדפדפן שולח שורות, ולעולם לא את המיפוי
  // הזה: מי שיכול לספק מיפוי משלו יכול לשבץ אדם אחר במקום עצמו.
  async function stationDirectory(ctx) {
    const snap = await stationRef(ctx.sid).collection('users')
      .limit(MAX_SOURCE_PEOPLE + 1).get();
    if (snap.size > MAX_SOURCE_PEOPLE) {
      throw new ScheduleRuntimeError('station-directory-too-large',
        'רשימת המשתמשים של התחנה גדולה מהתקרה הבטוחה.', 'resource-exhausted');
    }
    const out = [];
    snap.docs.forEach((doc) => {
      const user = doc.data() || {};
      if (!scheduleAccess.activeMember(user, ctx.sid)) return;
      const employee = user.employee_number === undefined || user.employee_number === null
        ? '' : String(user.employee_number).trim();
      if (!employee) return;
      /* ⭐ P1-4. השם נמסר מהפרופיל החי ולא מהגיליון המודבק. שם
       * שמגיע מהדבקה מופיע על הלוח של כל התחנה, ולכן הוא לא ייקבע
       * בעמודה בגיליון. */
      out.push({
        uid: doc.id, employee_number: employee,
        full_name: nonEmpty(user.full_name) ? String(user.full_name).trim() : null
      });
    });
    return out;
  }

  // המדיניות הפעילה, בצורה שהמודול מצפה לה. בלי מדיניות אין לפי מה
  // לדעת אילו תחנות קצה ואילו תפקידים קיימים.
  async function sourcePolicyContext(ctx, config) {
    if (!config.active_policy_id) {
      throw new ScheduleRuntimeError('source-policy-required',
        'אי אפשר לייבא מקור לפני שהוגדרו חוקי תחנה.', 'failed-precondition');
    }
    const policy = await loadPolicy(ctx, config.active_policy_id);
    return { station_id: ctx.sid, sub_stations: policy.value.sub_stations };
  }

  function sourceRows(data) {
    const rows = Array.isArray(data.rows) ? data.rows : null;
    if (!rows || !rows.length) {
      throw new ScheduleRuntimeError('source-rows-required',
        'לא נמסרו שורות לייבוא.', 'invalid-argument');
    }
    if (rows.length > MAX_SOURCE_PEOPLE) {
      throw new ScheduleRuntimeError('source-rows-too-many',
        'יותר מדי שורות בייבוא אחד.', 'invalid-argument');
    }
    return rows;
  }

  function authorSource(ctx, data, policy, directory, previous) {
    try {
      return sourceAuthor.planSource({
        station_id: ctx.sid,
        rows: sourceRows(data),
        known: directory,
        policy,
        previous,
        actor_uid: ctx.uid,
        accept_rejected: data.accept_rejected,
        accept_carry_dropped: data.accept_carry_dropped,
        accept_missing: data.accept_missing,
        // ⭐ החסימה על סגל חסר חלה על הפעלה בלבד; תצוגה מקדימה מדווחת.
        activate: data.activate === true
      });
    } catch (error) {
      if (error && error.name === 'SourceAuthorError') {
        const wrapped = new ScheduleRuntimeError(error.code, error.message, 'invalid-argument');
        // הדוח מוחזר גם בכישלון: בלעדיו אי אפשר לדעת מה לתקן.
        if (error.detail) wrapped.detail = error.detail;
        throw wrapped;
      }
      throw error;
    }
  }

  /* מקור פעיל אינו "רמז" לייבוא הבא. הוא מקור חתום, ולכן עוברים דרך
   * אותו loader יחיד שמאמת complete, ספירות, ילדים ו-digest. אם יש
   * מצביע למסמך חסר או פגום אנחנו עוצרים; רק היעדר מצביע הוא "אין
   * מקור קודם". כך אי אפשר להכשיר אובדן נתונים בחתימה חדשה. */
  async function readActiveSource(sid, activeId) {
    if (!nonEmpty(activeId)) return null;
    const loaded = await loadSource({ sid }, activeId);
    const events = Array.isArray(loaded.eventsRaw) ? loaded.eventsRaw : [];
    return {
      id: loaded.id,
      station_id: sid,
      version: loaded.version,
      revision: loaded.revision,
      content_digest: loaded.digest,
      content_key: loaded.contentKey,
      person_count: loaded.peopleRaw.length,
      availability_count: Object.keys(loaded.availability).length,
      locked_count: Object.keys(loaded.locked).length,
      event_count: events.length,
      people: loaded.peopleRaw,
      carry: loaded.carry,
      carried: {
        carry: loaded.carry,
        availability: loaded.availability,
        locked: loaded.locked,
        events
      }
    };
  }

  function requirePendingSourceOperation(opSnap, requestHash, operationOwner) {
    if (!opSnap || !opSnap.exists) {
      throw new ScheduleRuntimeError('source-operation-lost',
        'הבעלות על פעולת שמירת המקור אבדה.', 'aborted');
    }
    const op = opSnap.data() || {};
    if (op.request_hash !== requestHash) {
      throw new ScheduleRuntimeError('source-request-reused',
        'מזהה הפעולה שימש לבקשה אחרת בזמן הכתיבה.', 'aborted');
    }
    if (op.status !== 'pending' || op.owner_token !== operationOwner || plain(op.result)) {
      throw new ScheduleRuntimeError('source-operation-lost',
        'הבעלות על פעולת שמירת המקור השתנתה.', 'aborted');
    }
    return op;
  }

  function requireOwnedStagedSource(stagedSnap, plan, requestId, requestHash,
      operationOwner) {
    if (!stagedSnap || !stagedSnap.exists) {
      throw new ScheduleRuntimeError('source-staging-lost',
        'מסמך הביניים נעלם לפני הסגירה.', 'aborted');
    }
    const meta = stagedSnap.data() || {};
    if (meta.complete === true
        || meta.staged_by_request !== requestId
        || meta.staged_request_hash !== requestHash
        || meta.staged_owner_token !== operationOwner
        || meta.staged_content_digest !== plan.digest
        || meta.content_digest !== null
        || nonEmpty(meta.cleanup_claimed_by)) {
      throw new ScheduleRuntimeError('source-staging-changed',
        'מסמך הביניים השתנה בזמן הכתיבה.', 'aborted');
    }
    for (const field of ['station_id', 'version', 'revision', 'content_key',
      'person_count', 'availability_count', 'locked_count', 'event_count']) {
      if (meta[field] !== plan.meta[field]) {
        throw new ScheduleRuntimeError('source-staging-changed',
          'מטא-נתוני המקור השתנו בזמן הכתיבה: ' + field, 'aborted');
      }
    }
    return meta;
  }

  function sourceWriteChunks(ops) {
    const chunks = [];
    let current = [];
    let bytes = 0;
    for (const op of ops) {
      const pathBytes = Buffer.byteLength(String(op && op.ref && op.ref.path || ''), 'utf8');
      const dataBytes = Buffer.byteLength(stable(op && op.data), 'utf8');
      // A conservative per-document allowance covers Firestore framing and
      // field/index bookkeeping that is not visible in JSON size.
      const operationBytes = pathBytes + dataBytes + 2048;
      if (operationBytes > MAX_SOURCE_TRANSACTION_BYTES) {
        throw new ScheduleRuntimeError('source-child-too-large',
          'רשומת מקור גדולה מכדי להישמר בבטחה.', 'resource-exhausted');
      }
      if (current.length && (current.length >= sourceWriteChunkSize
          || bytes + operationBytes > MAX_SOURCE_TRANSACTION_BYTES)) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
      current.push(op);
      bytes += operationBytes;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  async function commitOwnedSourceWrites(ops, control) {
    const chunks = sourceWriteChunks(ops);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await db.runTransaction(async (tx) => {
        const [opSnap, stagedSnap] = await Promise.all([
          tx.get(control.opRef), tx.get(control.ref)
        ]);
        requirePendingSourceOperation(opSnap, control.requestHash, control.operationOwner);
        requireOwnedStagedSource(stagedSnap, control.plan, control.requestId,
          control.requestHash, control.operationOwner);
        chunk.forEach((op) => {
          if (op.kind === 'update') tx.update(op.ref, op.data);
          else if (op.kind === 'create') tx.create(op.ref, op.data);
          else tx.set(op.ref, op.data, op.options || undefined);
        });
        // A live writer renews its lease atomically with every chunk. A writer
        // that lost ownership cannot renew or write on a transaction retry.
        tx.set(control.opRef, {
          lease_until: new Date(timeMillis(clock()) + OUTBOX_LEASE_MS)
        }, { merge: true });
      });
      await afterSourceWriteChunk({
        kind: 'source', ref: control.ref, ctx: control.ctx,
        chunk_index: index, chunk_count: chunks.length
      });
    }
  }

  // ⭐ הדוח יוצא לדפדפן; היומן לא. שניהם נגזרים מאותו מקור, וההבדל
  // הוא שהיומן מחזיק ספירות בלבד ואף לא מספר שורה — שורה מזהה אדם
  // בגיליון.
  function sourcePlanView(plan, config) {
    return {
      kind: plan.kind,
      source_id: plan.source_id,
      version: plan.version,
      revision: plan.revision,
      digest: plan.digest,
      content_key: plan.content_key,
      counts: plan.counts,
      report: plan.report,
      // ⭐ מה שיוצא מהמקור חוזר למסך. רכזת חייבת לראות מספר לפני
      // שהיא מאשרת, ולא לגלות אחרי השמירה.
      carried_dropped: plan.carried_dropped || { availability: 0, locked: 0 },
      // ⭐ כמה אנשים פעילים בתחנה אינם בגיליון. מספר, לא רשימה.
      missing_staff: Number(plan.missing_staff || 0),
      mode: config.mode,
      active_source_id: config.active_source_id || null
    };
  }

  async function previewSource(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const data = plain(req.data) ? req.data : {};
    const config = await configuration(ctx.sid);
    const policy = await sourcePolicyContext(ctx, config);
    const directory = await stationDirectory(ctx);
    const previous = await readActiveSource(ctx.sid, config.active_source_id);
    // התצוגה המקדימה מריצה את אותו קוד בדיוק, ובלי `accept_rejected`
    // היא נופלת על הדחיות — וזה הדוח שמוחזר.
    try {
      const plan = authorSource(ctx, Object.assign({}, data,
        { accept_rejected: undefined }), policy, directory, previous);
      return Object.assign(sourcePlanView(plan, config), { blocked: false });
    } catch (error) {
      if (error instanceof ScheduleRuntimeError && error.detail && error.detail.report) {
        return {
          kind: 'blocked', blocked: true, code: error.code, message: error.message,
          report: error.detail.report, mode: config.mode,
          active_source_id: config.active_source_id || null
        };
      }
      throw error;
    }
  }

  async function saveSource(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    if (typeof data.activate !== 'boolean') {
      throw new ScheduleRuntimeError('source-activate-required',
        'יש להצהיר במפורש אם המקור נכנס לתוקף.', 'invalid-argument');
    }
    const expected = data.expected_source_id === undefined || data.expected_source_id === null
      ? null : requireId(data.expected_source_id, 'source-id', 'מזהה המקור הקודם');
    const requestHash = hash(stable({
      station_id: ctx.sid, actor_uid: ctx.uid, request_id: requestId,
      rows: data.rows, expected, activate: data.activate,
      accept_rejected: data.accept_rejected === undefined ? null : data.accept_rejected,
      accept_carry_dropped: data.accept_carry_dropped === undefined
        ? null : data.accept_carry_dropped,
      accept_missing: data.accept_missing === undefined ? null : data.accept_missing
    }));
    const operationOwner = 'src_' + randomId();

    const opRef = sourceOperationRef(ctx.sid, requestId);
    const existing = await opRef.get();
    if (existing.exists) {
      const op = existing.data() || {};
      if (op.request_hash !== requestHash) {
        throw new ScheduleRuntimeError('source-request-reused',
          'מזהה הפעולה כבר שימש לבקשה אחרת.', 'already-exists');
      }
      if (plain(op.result)) return Object.assign({ duplicate: true }, op.result);
      const leaseUntil = timeMillis(op.lease_until);
      if (op.status === 'pending' && Number.isFinite(leaseUntil)
          && leaseUntil > timeMillis(clock())) {
        throw new ScheduleRuntimeError('source-request-in-flight',
          'שמירת המקור כבר מתבצעת. יש להמתין ולנסות שוב.', 'aborted');
      }
    }

    const config = await configuration(ctx.sid);
    if (expected !== (config.active_source_id || null)) {
      throw new ScheduleRuntimeError('source-conflict',
        'מקור כוח האדם השתנה מאז שהמסך נטען. יש לרענן ולבדוק מה השתנה.', 'aborted');
    }
    const policy = await sourcePolicyContext(ctx, config);
    const directory = await stationDirectory(ctx);
    const previous = await readActiveSource(ctx.sid, config.active_source_id);
    const plan = authorSource(ctx, data, policy, directory, previous);

    if (plan.kind === 'unchanged') {
      const view = Object.assign(sourcePlanView(plan, config),
        { written: false, activated: false });
      const outcome = await db.runTransaction(async (tx) => {
        const [liveUserSnap, accessSnap, runtimeSnap, opSnap] = await Promise.all([
          tx.get(liveUserRef(ctx.sid, ctx.uid)),
          tx.get(scheduleAccessRef(ctx.sid, ctx.uid)),
          tx.get(runtimeRef(ctx.sid)),
          tx.get(opRef)
        ]);
        requireLiveManager(liveUserSnap, accessSnap, ctx);
        const runtimeData = runtimeSnap.exists ? (runtimeSnap.data() || {}) : {};
        const liveSource = nonEmpty(runtimeData.active_source_id)
          ? runtimeData.active_source_id : null;
        if (liveSource !== expected) {
          throw new ScheduleRuntimeError('source-conflict',
            'מקור כוח האדם השתנה בזמן בדיקת הייבוא.', 'aborted');
        }
        const livePolicyId = nonEmpty(runtimeData.active_policy_id)
          ? runtimeData.active_policy_id : null;
        if (livePolicyId !== (config.active_policy_id || null)) {
          throw new ScheduleRuntimeError('source-policy-changed',
            'חוקי התחנה הוחלפו בזמן בדיקת הייבוא.', 'aborted');
        }
        if (opSnap.exists) {
          const op = opSnap.data() || {};
          if (op.request_hash !== requestHash) {
            throw new ScheduleRuntimeError('source-request-reused',
              'מזהה הפעולה כבר שימש לבקשה אחרת.', 'already-exists');
          }
          if (plain(op.result)) return { duplicate: true, result: op.result };
          const leaseUntil = timeMillis(op.lease_until);
          if (op.status === 'pending' && Number.isFinite(leaseUntil)
              && leaseUntil > timeMillis(clock())) {
            throw new ScheduleRuntimeError('source-request-in-flight',
              'שמירת המקור כבר מתבצעת. יש להמתין ולנסות שוב.', 'aborted');
          }
        }
        tx.set(opRef, {
          status: 'complete',
          station_id: ctx.sid, actor_uid: ctx.uid, request_hash: requestHash,
          created_at: clock(), expires_at: sourceOperationExpiry(), result: view
        });
        return { duplicate: false, result: view };
      });
      return Object.assign({ duplicate: outcome.duplicate }, outcome.result);
    }

    /* `plan.source_id` is content-derived. Different requests importing the
     * same roster therefore used to share one staging document. Give every
     * logical request its own deterministic namespace; retries converge, but
     * competing requests can no longer overwrite or clean up one another. */
    const sourceId = plan.source_id + '_'
      + hash('source-stage|' + ctx.sid + '|' + requestId + '|' + requestHash).slice(0, 10);
    const staged = Object.assign({}, plan, { source_id: sourceId });
    const ref = sourceRef(ctx.sid, sourceId);
    /* שלב א' — המסמך נכתב **בלי** `complete` ובלי חתימה. במצב הזה
     * `loadSource` דוחה אותו, ולכן מקור חצי-כתוב אינו ניתן להרצה.
     *
     * ⭐ P1-7. `expires_at` נחתם כאן ומנוקה בסגירה. הוא משמש סמן
     * לאיתור מקור מדורג שננטש. לא מופעל על `schedule_sources` TTL של
     * Firestore: מחיקת האב אינה מוחקת את תתי-האוספים ועלולה להשאיר
     * שמות ונתוני סידור יתומים. הניקוי ב-`catch` מוחק ילדים תחילה
     * ואת האב אחרון. */
    /* שלב ב' — הסגירה. טרנזקציה קצרה שבודקת שוב את המינוי החי,
     * שהמצביע לא זז, ורק אז מסמנת שלם ומצביעה. */
    const view = Object.assign(sourcePlanView(staged, config),
      { written: true, activated: data.activate === true });
    let stageOwned = false;
    try {
      /* Claim the staging document atomically. A concurrent retry that raced
       * past the first idempotency read must not reopen a completed source or
       * join an in-flight writer and later clean up its children. */
      const claim = await db.runTransaction(async (tx) => {
        const [liveOp, stagedSnap] = await Promise.all([tx.get(opRef), tx.get(ref)]);
        if (liveOp.exists) {
          const op = liveOp.data() || {};
          if (op.request_hash !== requestHash) {
            throw new ScheduleRuntimeError('source-request-reused',
              'מזהה הפעולה כבר שימש לבקשה אחרת.', 'already-exists');
          }
          if (plain(op.result)) return { duplicate: true, result: op.result };
          const leaseUntil = timeMillis(op.lease_until);
          if (op.status === 'pending' && Number.isFinite(leaseUntil)
              && leaseUntil > timeMillis(clock())) {
            throw new ScheduleRuntimeError('source-request-in-flight',
              'שמירת המקור כבר מתבצעת. יש להמתין ולנסות שוב.', 'aborted');
          }
        }
        if (stagedSnap.exists) {
          const meta = stagedSnap.data() || {};
          const sameAbandonedStage = meta.complete !== true
            && meta.staged_by_request === requestId
            && meta.staged_request_hash === requestHash
            && meta.staged_content_digest === plan.digest
            && !nonEmpty(meta.cleanup_claimed_by);
          if (!sameAbandonedStage) {
            throw new ScheduleRuntimeError('source-staging-taken',
              'מסמך הביניים שייך לפעולה אחרת.', 'aborted');
          }
        }
        tx.set(opRef, {
          status: 'pending', owner_token: operationOwner,
          station_id: ctx.sid, actor_uid: ctx.uid, request_hash: requestHash,
          created_at: clock(), lease_until: new Date(timeMillis(clock()) + OUTBOX_LEASE_MS),
          expires_at: sourceOperationExpiry()
        });
        tx.set(ref, Object.assign({}, plan.meta, {
          complete: false,
          content_digest: null,
          staged_content_digest: plan.digest,
          staged_by_request: requestId,
          staged_request_hash: requestHash,
          staged_owner_token: operationOwner,
          staged_at: FV.serverTimestamp(),
          expires_at: sourceOperationExpiry()
        }));
        return { duplicate: false };
      });
      if (claim.duplicate) return Object.assign({ duplicate: true }, claim.result);
      stageOwned = true;

      /* All four subcollections are one signed source. Any failure from the
       * first child write onward is inside this crash-safe path. */
      await commitOwnedSourceWrites([].concat(
        plan.people.map((person) => ({
          ref: ref.collection('people').doc(person.id), data: person.data
        })),
        plan.availability.map((item) => ({
          ref: ref.collection('availability').doc(item.id), data: item.data
        })),
        plan.locked.map((item) => ({
          ref: ref.collection('locked').doc(item.id), data: item.data
        })),
        plan.events.map((item) => ({
          ref: ref.collection('events').doc(item.id), data: item.data
        }))
      ), {
        opRef, ref, plan: staged, requestId, requestHash, operationOwner, ctx
      });

      await beforeSnapshotFinalize({ kind: 'source', ref, ctx });
      await db.runTransaction(async (tx) => {
        const refs = [liveUserRef(ctx.sid, ctx.uid), scheduleAccessRef(ctx.sid, ctx.uid),
          runtimeRef(ctx.sid), ref, opRef];
        const snaps = await Promise.all(refs.map((item) => tx.get(item)));
        requireLiveManager(snaps[0], snaps[1], ctx);
        const runtimeData = snaps[2].exists ? (snaps[2].data() || {}) : {};
        const stagedSnap = snaps[3];
        const liveOp = snaps[4];

        requirePendingSourceOperation(liveOp, requestHash, operationOwner);
        requireOwnedStagedSource(stagedSnap, staged, requestId, requestHash,
          operationOwner);

        const liveSource = nonEmpty(runtimeData.active_source_id)
          ? runtimeData.active_source_id : null;
        if (liveSource !== expected) {
          throw new ScheduleRuntimeError('source-conflict',
            'מקור כוח האדם השתנה בזמן הכתיבה.', 'aborted');
        }
        const livePolicyId = nonEmpty(runtimeData.active_policy_id)
          ? runtimeData.active_policy_id : null;
        if (livePolicyId !== (config.active_policy_id || null)) {
          throw new ScheduleRuntimeError('source-policy-changed',
            'חוקי התחנה הוחלפו בזמן כתיבת המקור. יש לבדוק מחדש.', 'aborted');
        }
        tx.set(ref, {
          complete: true,
          content_digest: plan.digest,
          completed_at: FV.serverTimestamp(),
          expires_at: FV.delete(),
          staged_content_digest: FV.delete(),
          staged_by_request: FV.delete(),
          staged_request_hash: FV.delete(),
          staged_owner_token: FV.delete(),
          cleanup_claimed_by: FV.delete(),
          cleanup_claimed_at: FV.delete(),
          cleanup_lease_until: FV.delete()
        }, { merge: true });
        if (data.activate === true) {
          tx.set(runtimeRef(ctx.sid), { active_source_id: sourceId }, { merge: true });
        }
        tx.set(sourceAuditRef(ctx.sid, requestId), Object.assign({
          station_id: ctx.sid, request_id: requestId, source_id: sourceId,
          version: plan.version, revision: plan.revision,
          supersedes: previous ? previous.id : null,
          activated: data.activate === true,
          actor_uid: ctx.uid
        }, plan.audit));
        tx.set(opRef, {
          status: 'complete',
          station_id: ctx.sid, actor_uid: ctx.uid, request_hash: requestHash,
          created_at: clock(), expires_at: sourceOperationExpiry(), result: view
        });
      });
    } catch (error) {
      /* ⭐ P1-7. הסגירה נכשלה, והמסמך המדורג כבר על הדיסק עם שמות
       * מלאים בתת-האוסף `people`. הניקוי כאן מפורש ומוחק את הילדים
       * לפני האב, לפי מזהי הבעלות שבידינו. הוא best-effort; אם הוא נכשל,
       * מסמך האב ו-`expires_at` נשארים כעוגן איתור לניקוי רקורסיבי עתידי.
       * השגיאה המקורית היא שחוזרת לקורא — לא שגיאת הניקוי. */
      if (stageOwned) {
        await cleanupStagedSource(ctx.sid, ref, staged, requestId, requestHash,
          operationOwner).catch(() => {});
        await releaseSourceOperationClaim(opRef, requestHash, operationOwner).catch(() => {});
      }
      throw error;
    }
    return Object.assign({ duplicate: false }, view);
  }

  /* מוחק מקור מדורג שננטש, כולל תת-האוספים שנכתבו. */
  async function cleanupStagedSource(sid, ref, plan, requestId, requestHash, operationOwner) {
    /* The immediate cleanup uses its own fenced lease.  A blind batch here
     * creates an ABA race: a delayed worker could delete children recreated by
     * a later retry after the source id was reclaimed. */
    const cleanupToken = 'cleanup_' + randomId();
    const opRef = sourceOperationRef(sid, requestId);
    function ownsCleanup(sourceSnap, runtimeSnap, operationSnap, now) {
      if (!sourceSnap.exists || !operationSnap.exists) return false;
      const meta = sourceSnap.data() || {};
      const runtime = runtimeSnap.exists ? (runtimeSnap.data() || {}) : {};
      const op = operationSnap.data() || {};
      return meta.complete !== true
        && meta.staged_by_request === requestId
        && meta.staged_request_hash === requestHash
        && meta.staged_owner_token === operationOwner
        && meta.staged_content_digest === plan.digest
        && meta.cleanup_claimed_by === cleanupToken
        && timeMillis(meta.cleanup_lease_until) > now
        && runtime.active_source_id !== ref.id
        && op.status === 'pending'
        && op.request_hash === requestHash
        && op.owner_token === operationOwner
        && !plain(op.result);
    }
    const owned = await db.runTransaction(async (tx) => {
      const [snap, runtimeSnap, operationSnap] = await Promise.all([
        tx.get(ref), tx.get(runtimeRef(sid)), tx.get(opRef)
      ]);
      if (!snap.exists || !operationSnap.exists) return false;
      const meta = snap.data() || {};
      const runtime = runtimeSnap.exists ? (runtimeSnap.data() || {}) : {};
      const op = operationSnap.data() || {};
      const now = timeMillis(clock());
      const claimLease = timeMillis(meta.cleanup_lease_until);
      if (meta.complete === true
          || meta.staged_by_request !== requestId
          || meta.staged_request_hash !== requestHash
          || meta.staged_owner_token !== operationOwner
          || meta.staged_content_digest !== plan.digest
          || (nonEmpty(meta.cleanup_claimed_by)
            && Number.isFinite(claimLease) && claimLease > now)
          || runtime.active_source_id === ref.id
          || op.status !== 'pending'
          || op.request_hash !== requestHash
          || op.owner_token !== operationOwner
          || plain(op.result)) return false;
      tx.set(ref, {
        cleanup_claimed_by: cleanupToken,
        cleanup_claimed_at: FV.serverTimestamp(),
        cleanup_lease_until: new Date(now + OUTBOX_LEASE_MS)
      }, { merge: true });
      return true;
    });
    if (!owned) return;

    const deletes = [].concat(
      plan.people.map((item) => ({ ref: ref.collection('people').doc(item.id), data: item })),
      plan.availability.map((item) => ({
        ref: ref.collection('availability').doc(item.id), data: item
      })),
      plan.locked.map((item) => ({ ref: ref.collection('locked').doc(item.id), data: item })),
      plan.events.map((item) => ({ ref: ref.collection('events').doc(item.id), data: item }))
    );
    // Reuse the write-side byte budget.  Count-only chunks can exceed
    // Firestore's 10 MiB transaction limit when a few source rows are large.
    for (const chunk of sourceWriteChunks(deletes)) {
      await db.runTransaction(async (tx) => {
        const refs = [ref, runtimeRef(sid), opRef].concat(chunk.map((item) => item.ref));
        const snaps = await Promise.all(refs.map((item) => tx.get(item)));
        const now = timeMillis(clock());
        if (!ownsCleanup(snaps[0], snaps[1], snaps[2], now)) return;
        snaps.slice(3).forEach((snap) => {
          if (snap.exists) tx.delete(snap.ref);
        });
        tx.set(ref, {
          cleanup_lease_until: new Date(now + OUTBOX_LEASE_MS)
        }, { merge: true });
      });
    }
    await db.runTransaction(async (tx) => {
      const [snap, runtimeSnap, operationSnap] = await Promise.all([
        tx.get(ref), tx.get(runtimeRef(sid)), tx.get(opRef)
      ]);
      const children = [];
      for (const group of SOURCE_CHILD_GROUPS) {
        children.push(await tx.get(ref.collection(group).limit(1)));
      }
      if (!ownsCleanup(snap, runtimeSnap, operationSnap, timeMillis(clock()))) return;
      if (children.some((snapshot) => !snapshot.empty)) return;
      tx.delete(ref);
    });
  }

  /* Scheduled crash recovery for staged sources.  Firestore TTL is
   * intentionally not enabled on the parent: TTL would remove the only
   * discoverable anchor while leaving PII-bearing subcollections behind. */
  function sourceSweepCandidate(doc) {
    const parts = String(doc && doc.ref && doc.ref.path || '').split('/');
    if (parts.length !== 4 || parts[0] !== 'stations'
        || parts[2] !== 'schedule_sources' || !ID_RE.test(parts[1])
        || !ID_RE.test(parts[3])) return null;
    const meta = doc.data() || {};
    const requestId = String(meta.staged_by_request || '').trim();
    if (!ID_RE.test(requestId)) return null;
    return {
      sid: parts[1], sourceId: parts[3], requestId,
      ref: doc.ref, runtimeRef: runtimeRef(parts[1]),
      operationRef: sourceOperationRef(parts[1], requestId)
    };
  }

  function liveSourceOperation(opSnap, now) {
    if (!opSnap || !opSnap.exists) return false;
    const op = opSnap.data() || {};
    const leaseUntil = timeMillis(op.lease_until);
    return op.status === 'pending' && Number.isFinite(leaseUntil) && leaseUntil > now;
  }

  function sourceSweepBlock(meta, runtime, opSnap, candidate, token, now, requireOwner) {
    const expiresAt = timeMillis(meta && meta.expires_at);
    if (!meta || meta.complete === true) return 'complete';
    if (!Number.isFinite(expiresAt) || expiresAt > now) return 'not-expired';
    if (meta.staged_by_request !== candidate.requestId) return 'staging-changed';
    if (runtime && runtime.active_source_id === candidate.sourceId) return 'active';
    if (liveSourceOperation(opSnap, now)) return 'live-operation';
    const claimedBy = String(meta.cleanup_claimed_by || '');
    const claimLease = timeMillis(meta.cleanup_lease_until);
    if (requireOwner) {
      if (claimedBy !== token || !Number.isFinite(claimLease) || claimLease <= now) {
        return 'claim-lost';
      }
    } else if (claimedBy && Number.isFinite(claimLease) && claimLease > now) {
      return 'claimed';
    }
    return null;
  }

  async function claimExpiredSource(doc, token) {
    const candidate = sourceSweepCandidate(doc);
    if (!candidate) return { claimed: false, reason: 'candidate-invalid' };
    const result = await db.runTransaction(async (tx) => {
      const [sourceSnap, runtimeSnap, operationSnap] = await Promise.all([
        tx.get(candidate.ref), tx.get(candidate.runtimeRef), tx.get(candidate.operationRef)
      ]);
      if (!sourceSnap.exists) return { claimed: false, reason: 'missing' };
      const now = timeMillis(clock());
      const reason = sourceSweepBlock(sourceSnap.data() || {},
        runtimeSnap.exists ? (runtimeSnap.data() || {}) : {}, operationSnap,
        candidate, token, now, false);
      if (reason) return { claimed: false, reason };
      tx.set(candidate.ref, {
        cleanup_claimed_by: token,
        cleanup_claimed_at: FV.serverTimestamp(),
        cleanup_lease_until: new Date(now + OUTBOX_LEASE_MS)
      }, { merge: true });
      return { claimed: true };
    });
    return Object.assign({}, result, { candidate });
  }

  async function deleteExpiredSourceChunk(candidate, token, group, limit) {
    const query = candidate.ref.collection(group)
      .orderBy(FieldPath.documentId()).limit(limit);
    const queued = await query.get();
    if (queued.empty) return { owned: true, deleted: 0 };
    let bytes = 0;
    const selected = [];
    for (const doc of queued.docs) {
      const documentBytes = Buffer.byteLength(String(doc.ref.path || ''), 'utf8')
        + Buffer.byteLength(stable(doc.data() || {}), 'utf8') + 2048;
      if (documentBytes > MAX_SOURCE_TRANSACTION_BYTES) {
        throw new ScheduleRuntimeError('source-sweep-child-too-large',
          'רשומת מקור גדולה מכדי להימחק בבטחה.', 'resource-exhausted');
      }
      if (selected.length && bytes + documentBytes > MAX_SOURCE_TRANSACTION_BYTES) break;
      selected.push(doc);
      bytes += documentBytes;
    }
    return db.runTransaction(async (tx) => {
      const refs = [candidate.ref, candidate.runtimeRef, candidate.operationRef]
        .concat(selected.map((doc) => doc.ref));
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      if (!snaps[0].exists) return { owned: false, deleted: 0, reason: 'missing' };
      const now = timeMillis(clock());
      const reason = sourceSweepBlock(snaps[0].data() || {},
        snaps[1].exists ? (snaps[1].data() || {}) : {}, snaps[2],
        candidate, token, now, true);
      if (reason) return { owned: false, deleted: 0, reason };
      let deleted = 0;
      snaps.slice(3).forEach((snap) => {
        if (!snap.exists) return;
        tx.delete(snap.ref);
        deleted += 1;
      });
      tx.set(candidate.ref, {
        cleanup_lease_until: new Date(now + OUTBOX_LEASE_MS)
      }, { merge: true });
      return { owned: true, deleted };
    });
  }

  async function deleteExpiredSourceParent(candidate, token) {
    return db.runTransaction(async (tx) => {
      const base = await Promise.all([
        tx.get(candidate.ref), tx.get(candidate.runtimeRef), tx.get(candidate.operationRef)
      ]);
      if (!base[0].exists) return { deleted: false, reason: 'missing' };
      const children = [];
      for (const group of SOURCE_CHILD_GROUPS) {
        children.push(await tx.get(candidate.ref.collection(group).limit(1)));
      }
      const now = timeMillis(clock());
      const reason = sourceSweepBlock(base[0].data() || {},
        base[1].exists ? (base[1].data() || {}) : {}, base[2],
        candidate, token, now, true);
      if (reason) return { deleted: false, reason };
      if (children.some((snapshot) => !snapshot.empty)) {
        return { deleted: false, reason: 'children-remain' };
      }
      tx.delete(candidate.ref);
      return { deleted: true };
    });
  }

  async function releaseSourceSweepClaim(candidate, token) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(candidate.ref);
      if (!snap.exists) return;
      const meta = snap.data() || {};
      if (meta.cleanup_claimed_by !== token) return;
      tx.set(candidate.ref, {
        cleanup_claimed_by: FV.delete(),
        cleanup_claimed_at: FV.delete(),
        cleanup_lease_until: FV.delete()
      }, { merge: true });
    });
  }

  async function sweepExpiredSources() {
    const startedAt = timeMillis(clock());
    if (!Number.isFinite(startedAt)) {
      throw new ScheduleRuntimeError('source-sweep-clock-invalid',
        'שעון ניקוי מקורות הסידור אינו תקין.');
    }
    const snapshot = await db.collectionGroup('schedule_sources')
      .where('expires_at', '<=', new Date(startedAt))
      .orderBy('expires_at', 'asc').limit(sourceSweepCandidateLimit).get();
    const result = {
      scanned: snapshot.size, claimed: 0, deleted_children: 0,
      deleted_sources: 0, pending: 0, skipped: 0, failures: 0
    };
    let remainingChildren = sourceSweepChildLimit;
    for (const doc of snapshot.docs) {
      if (remainingChildren <= 0) {
        result.pending += 1;
        continue;
      }
      const token = 'sweep_' + randomId();
      let claim = null;
      try {
        claim = await claimExpiredSource(doc, token);
        if (!claim.claimed) {
          result.skipped += 1;
          continue;
        }
        result.claimed += 1;
        await afterSourceSweepClaim({ kind: 'source-sweep', ref: claim.candidate.ref });
        let owned = true;
        for (const group of SOURCE_CHILD_GROUPS) {
          while (owned && remainingChildren > 0) {
            const chunk = await deleteExpiredSourceChunk(claim.candidate, token, group,
              Math.min(sourceSweepChunkSize, remainingChildren));
            owned = chunk.owned;
            if (!owned || chunk.deleted === 0) break;
            remainingChildren -= chunk.deleted;
            result.deleted_children += chunk.deleted;
            await afterSourceSweepChunk({
              kind: 'source-sweep', ref: claim.candidate.ref,
              deleted: chunk.deleted, deleted_total: result.deleted_children
            });
          }
          if (!owned || remainingChildren <= 0) break;
        }
        if (!owned) {
          result.skipped += 1;
          await releaseSourceSweepClaim(claim.candidate, token);
          continue;
        }
        const parent = await deleteExpiredSourceParent(claim.candidate, token);
        if (parent.deleted) {
          result.deleted_sources += 1;
        } else {
          result.pending += 1;
          await releaseSourceSweepClaim(claim.candidate, token);
        }
      } catch (ignore) {
        // Never report the document path, request id or source content.  The
        // scheduled error is a counter-only operational signal; the retained
        // parent and lease make the work safely retryable.
        result.failures += 1;
        reportRuntimeError('schedule-source-sweep-failed');
      }
    }
    if (result.failures) {
      const error = new ScheduleRuntimeError('source-sweep-partial-failure',
        'ניקוי מקורות סידור שפגו לא הושלם.');
      error.result = Object.freeze(result);
      throw error;
    }
    return Object.freeze(result);
  }

  async function releaseSourceOperationClaim(opRef, requestHash, operationOwner) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(opRef);
      if (!snap.exists) return;
      const op = snap.data() || {};
      if (op.status !== 'pending' || op.request_hash !== requestHash
          || op.owner_token !== operationOwner || plain(op.result)) return;
      tx.delete(opRef);
    });
  }

  function policyOperationRef(sid, requestId) {
    return stationRef(sid).collection('schedule_policy_operations').doc(requestId);
  }

  // רשומת הפעולה קיימת רק כדי למנוע כתיבה כפולה של אותה בקשה.
  // היא אינה היסטוריה — ההיסטוריה היא היומן — ולכן היא פגה מעצמה.
  function policyOperationExpiry() {
    const now = timeMillis(clock());
    return new Date((Number.isFinite(now) ? now : Date.parse(clock())) + OUTBOX_TTL_MS);
  }

  function policyAuditRef(sid, requestId) {
    return stationRef(sid).collection('schedule_policy_audit')
      .doc('pa_' + hash('policy-audit|' + sid + '|' + requestId).slice(0, 48));
  }

  // המדיניות הפעילה כפי שהיא **בשרת**, לא כפי שהדפדפן זוכר אותה.
  // ההפרשים והגרסה נגזרים ממנה בלבד.
  async function readActivePolicy(sid, activeId, tx) {
    if (!nonEmpty(activeId)) return null;
    const ref = policyRef(sid, activeId);
    const snap = tx ? await tx.get(ref) : await ref.get();
    if (!snap.exists) return null;
    return Object.assign({ id: activeId }, snap.data() || {});
  }

  function authorPlan(ctx, data, previous) {
    if (!plain(data.draft)) {
      throw new ScheduleRuntimeError('policy-draft-required',
        'חסרה טיוטת חוקי תחנה.', 'invalid-argument');
    }
    try {
      return policyAuthor.planPolicy({
        station_id: ctx.sid,
        draft: data.draft,
        previous,
        actor_uid: ctx.uid
      });
    } catch (error) {
      // קודי המודול סגורים ומנוסחים בעברית מובנת. הם מועברים כמות
      // שהם — המסך צריך לומר לאחראי/ת הסידור מה חסר, לא „נכשל".
      if (error && error.name === 'PolicyAuthorError') {
        throw new ScheduleRuntimeError(error.code, error.message, 'invalid-argument');
      }
      throw error;
    }
  }

  // התשובה למסך לעולם אינה כוללת את המסמך עצמו: הוא הדבר שעליו
  // אנחנו חותמים, והדפדפן אינו צד בחתימה.
  function policyPlanView(plan, config) {
    return {
      kind: plan.kind,
      policy_id: plan.policy_id,
      version: plan.version,
      digest: plan.digest,
      content_key: plan.content_key,
      changes: plan.changes,
      warnings: plan.warnings,
      weakening: plan.weakening,
      mode: config.mode,
      active_policy_id: config.active_policy_id || null
    };
  }

  async function previewPolicy(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    const previous = await readActivePolicy(ctx.sid, config.active_policy_id, null);
    const plan = authorPlan(ctx, plain(req.data) ? req.data : {}, previous);
    return policyPlanView(plan, config);
  }

  async function savePolicy(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');

    // ⭐ הפעלה היא הצהרה, לא ברירת מחדל. „שמרתי ולא ידעתי שזה
    // נכנס לתוקף" הוא בדיוק מה שאסור שיקרה כאן.
    if (typeof data.activate !== 'boolean') {
      throw new ScheduleRuntimeError('policy-activate-required',
        'יש להצהיר במפורש אם המדיניות נכנסת לתוקף.', 'invalid-argument');
    }
    // המסך שולח את מה שהוא ראה. אם בינתיים מישהו אחר שמר — שתי
    // לשוניות פתוחות, שני אנשים — הפעולה נעצרת ואינה דורסת.
    const expected = data.expected_policy_id === undefined || data.expected_policy_id === null
      ? null : requireId(data.expected_policy_id, 'policy-id', 'מזהה המדיניות הקודמת');

    const opRef = policyOperationRef(ctx.sid, requestId);
    return await db.runTransaction(async (tx) => {
      // כל הקריאות לפני כל הכתיבות. זו אינה קפדנות סגנונית —
      // Firestore פשוט לא ירשה אחרת.
      const opSnap = await tx.get(opRef);
      const runtimeSnap = await tx.get(runtimeRef(ctx.sid));
      /* ⭐ P1-2. המינוי נקרא **חי, כאן**, ולא רק מהטוקן בתחילת
       * הבקשה. `requireManager(ctx)` בודק את מה שהיה נכון כשהטוקן
       * הונפק; מי שהמינוי שלו הוסר בין הלחיצה לבין ה-commit היה
       * ממשיך לכתוב. `saveSource` כבר עשה את זה — כאן זה היה חסר. */
      const liveUserSnap = await tx.get(liveUserRef(ctx.sid, ctx.uid));
      const liveAccessSnap = await tx.get(scheduleAccessRef(ctx.sid, ctx.uid));
      requireLiveManager(liveUserSnap, liveAccessSnap, ctx);
      const runtimeData = runtimeSnap.exists ? (runtimeSnap.data() || {}) : {};
      const activeId = nonEmpty(runtimeData.active_policy_id)
        ? runtimeData.active_policy_id : null;
      const previous = await readActivePolicy(ctx.sid, activeId, tx);
      const config = Object.freeze({
        mode: MODES.indexOf(runtimeData.mode) !== -1 ? runtimeData.mode : MODE.OFF,
        active_policy_id: activeId
      });

      const plan = authorPlan(ctx, data, previous);
      const fingerprint = digest({
        station_id: ctx.sid, actor_uid: ctx.uid, request_id: requestId,
        content_key: plan.content_key, expected, activate: data.activate
      });

      if (opSnap.exists) {
        const op = opSnap.data() || {};
        if (op.fingerprint !== fingerprint) {
          throw new ScheduleRuntimeError('policy-request-reused',
            'מזהה הפעולה כבר שימש לבקשה אחרת.', 'already-exists');
        }
        return Object.assign({ duplicate: true }, op.result || {});
      }

      if (expected !== activeId) {
        throw new ScheduleRuntimeError('policy-conflict',
          'חוקי התחנה השתנו מאז שהמסך נטען. יש לרענן ולראות מה השתנה '
          + 'לפני שמירה חוזרת.', 'aborted');
      }

      // ⭐ החלשה אינה נחסמת — היא לפעמים הכוונה. היא דורשת אמירה
      // מפורשת, כדי שאיש לא יוריד קו מינימום בלי לדעת שהוריד.
      if (plan.weakening && plan.weakening.length && data.confirm_weakening !== true) {
        throw new ScheduleRuntimeError('policy-weakening-unconfirmed',
          'השינוי מקל על התקן ב-' + plan.weakening.length + ' מקומות. '
          + 'יש לאשר זאת במפורש.', 'failed-precondition');
      }

      if (plan.kind === 'unchanged') {
        const view = Object.assign(policyPlanView(plan, config),
          { written: false, activated: false });
        tx.set(opRef, {
          station_id: ctx.sid, actor_uid: ctx.uid, fingerprint,
          created_at: clock(), expires_at: policyOperationExpiry(), result: view
        });
        return Object.assign({ duplicate: false }, view);
      }

      const view = Object.assign(policyPlanView(plan, config), {
        written: true,
        activated: data.activate === true
      });

      tx.set(policyRef(ctx.sid, plan.policy_id), plan.document);
      if (data.activate === true) {
        tx.set(runtimeRef(ctx.sid), { active_policy_id: plan.policy_id }, { merge: true });
      }
      tx.set(policyAuditRef(ctx.sid, requestId), {
        station_id: ctx.sid,
        actor_uid: ctx.uid,
        at: clock(),
        policy_id: plan.policy_id,
        version: plan.version,
        content_digest: plan.digest,
        supersedes: previous ? previous.id : null,
        activated: data.activate === true,
        change_count: plan.changes.length,
        weakening_count: plan.weakening.length,
        // ⭐ קודי אזהרה בלבד. שום טקסט חופשי ושום שם — יומן אינו
        // מקום שצריך לבדוק מה מותר להיכנס אליו.
        warning_codes: plan.warnings.map((w) => w.code)
      });
      tx.set(opRef, {
        station_id: ctx.sid, actor_uid: ctx.uid, fingerprint,
        created_at: clock(), expires_at: policyOperationExpiry(), result: view
      });
      return Object.assign({ duplicate: false }, view);
    });
  }

  /* ==================================================================
   *  מצב מנוע הסידור · המתג
   * ------------------------------------------------------------------
   *  ⭐ **הרשאת עריכה אינה הרשאת הפעלה.**
   *
   *  `schedule_manager` הוא מינוי תפעולי — לערוך, לשבץ, להריץ
   *  ולפרסם. הזזת מצב המנוע משנה את מה שכל התחנה רואה, והיא
   *  שייכת לפיקוד. `requireManager` **אינו** נקרא כאן, ובמכוון.
   *
   *  הבדיקה המקדימה אינה „האם יש מצביעים" אלא **האם המסמכים
   *  נטענים בפועל**: מצביע למדיניות פגומה אינו מוכנות, והמקום
   *  לגלות את זה הוא לפני ההפעלה ולא בהרצה הראשונה.
   * ================================================================== */

  function modeOperationRef(sid, requestId) {
    return stationRef(sid).collection('schedule_mode_operations').doc(requestId);
  }

  function modeAuditRef(sid, requestId) {
    return stationRef(sid).collection('schedule_mode_audit')
      .doc('ma_' + hash('mode-audit|' + sid + '|' + requestId).slice(0, 48));
  }

  function modeOperationExpiry() {
    const now = timeMillis(clock());
    return new Date((Number.isFinite(now) ? now : Date.parse(clock())) + OUTBOX_TTL_MS);
  }

  // המסמכים נטענים באמת, על כל בדיקות החתימה והספירה שלהם. כשל
  // אינו מתפרש כ„עדיין לא הוגדר" — הוא נאמר בקוד שלו.
  async function modeReadiness(ctx, config) {
    const out = { policy: false, source: false, people: 0, problems: [] };
    if (config.active_policy_id) {
      try {
        await loadPolicy(ctx, config.active_policy_id);
        out.policy = true;
      } catch (error) {
        out.problems.push(error instanceof ScheduleRuntimeError ? error.code : 'policy-unreadable');
      }
    }
    if (config.active_source_id) {
      try {
        const source = await loadSource(ctx, config.active_source_id);
        out.source = true;
        out.people = source.peopleRaw.filter((person) => person.active === true).length;
      } catch (error) {
        out.problems.push(error instanceof ScheduleRuntimeError ? error.code : 'source-unreadable');
      }
    }
    return out;
  }

  function modeActor(ctx) {
    // ⭐ `manager` אינו נמסר. לא כדי לחסוך שדה — כדי שלא תהיה דרך
    // שבה מינוי אחראי סידור ישפיע על ההחלטה הזאת, גם לא בטעות.
    return { uid: ctx.uid, role: ctx.role, super: ctx.super === true };
  }

  function requireLiveModeAuthority(userSnap, ctx, inactiveCode) {
    const user = userSnap && userSnap.exists ? (userSnap.data() || {}) : null;
    if (!scheduleAccess.activeMember(user, ctx.sid)) {
      throw new ScheduleRuntimeError(inactiveCode,
        'המשתמש אינו פעיל בתחנה הזאת.', 'permission-denied');
    }
    const liveActor = {
      uid: ctx.uid,
      role: String(user.role || ''),
      // Super-admin authority comes only from the verified auth claim.  A
      // writable profile field must never be able to grant this authority.
      super: ctx.super === true
    };
    if (!modeAuthority.mayChangeMode(liveActor)) {
      throw new ScheduleRuntimeError(modeAuthority.CODE.FORBIDDEN,
        'סמכות הפיקוד אינה פעילה עוד.', 'permission-denied');
    }
    return liveActor;
  }

  function modeError(error) {
    if (error && error.name === 'ModeAuthorityError') {
      const http = error.code === modeAuthority.CODE.FORBIDDEN ? 'permission-denied'
        : (error.code === modeAuthority.CODE.NOT_READY ? 'failed-precondition' : 'invalid-argument');
      throw new ScheduleRuntimeError(error.code, error.message, http);
    }
    throw error;
  }

  async function getModeOptions(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const actor = modeActor(ctx);
    if (!modeAuthority.mayChangeMode(actor)) {
      // מי שאינו רשאי מקבל תשובה קצרה ואמיתית, בלי מפת מצבים
      // ובלי מה חסר כדי להפעיל.
      return { may_change: false, current: config.mode, ready: false, targets: [] };
    }
    const readiness = await modeReadiness(ctx, config);
    const view = modeAuthority.options({ current: config.mode, actor, readiness });
    /* ⭐ המועמד המוכן נחשף לפיקוד.
     *
     * את הפרסום מכין אחראי/ת הסידור; את המעבר מאשר הפיקוד. בלי
     * המצביע הזה, מפקד שאינו אחראי סידור לא היה יכול **לגלות**
     * שיש מועמד — הוא היה תלוי במצב מקומי במסך של מישהו אחר.
     *
     * מה שנמסר: מזהה, מהדורה, טווח וחתימה. אין כאן שמות ואין
     * שיבוצים — מי שרוצה לראות מה בפנים פותח את הדוח. */
    const candidate = await preparedCandidate(ctx);
    return Object.assign({}, view, {
      readiness: {
        policy: readiness.policy, source: readiness.source,
        people: readiness.people, problems: readiness.problems
      },
      candidate
    });
  }

  /* ⭐⭐ מועמד אחד, או שום מועמד — ולא „הראשון מבין חמישה".
   *
   * הגרסה הקודמת עשתה `limit(5)` **לפני** המיון, ואז מיינה לפי
   * `revision`. שני כשלים בשורה אחת:
   *
   *   · `limit` לפני מיון — עם יותר מחמש הכנות, החמש שחוזרות הן
   *     שרירותיות, ו„הגבוה ביותר" נבחר מתוך קבוצה מקרית.
   *   · בהכנה ב-shadow המצביע הפעיל אינו זז, ולכן **כל ההכנות
   *     נושאות את אותה `revision`**. המיון הוא בין שווים, והתוצאה
   *     תלויה בסדר שהמסד החזיר.
   *
   * ⭐ והמסך הזה הוא מה שהמפקד רואה לפני שהוא מאשר מעבר. „מועמד
   * שרירותי" כאן פירושו שהוא מאשר משהו אחר ממה שהוצג לו.
   *
   * לכן: קבוצה חסומה, ואם יש יותר ממועמד כשיר אחד — **לא מחזירים
   * אף אחד**, ומדווחים כמה יש ואילו. המסך אומר „בטלו את הישנים",
   * והמעבר ממתין. פחות נוח, ועדיף על אישור עיוור. */
  async function preparedCandidate(ctx) {
    const CAP = 20;
    const snap = await stationRef(ctx.sid).collection('schedule_publications')
      .where('status', '==', 'prepared').limit(CAP + 1).get();
    if (snap.empty) return null;
    if (snap.size > CAP) {
      return { ambiguous: true, prepared_count: snap.size, reason: 'prepared-overflow' };
    }
    const docs = snap.docs
      .map((doc) => Object.assign({ id: doc.id }, doc.data() || {}))
      .filter((item) => item.station_id === ctx.sid && item.snapshot_complete === true)
      // מיון קנוני ויציב, ולא לפי revision — כולן שוות ב-shadow.
      .sort((a, b) => compareCanonical(a.id, b.id));
    if (!docs.length) return null;
    if (docs.length > 1) {
      return {
        ambiguous: true, prepared_count: docs.length, reason: 'prepared-ambiguous',
        // מזהים בלבד — כדי שהמסך יראה *מה* לבטל, בלי לבחור במקום המפקד.
        publication_ids: docs.map((item) => item.id)
      };
    }
    const best = docs[0];
    const preflight = await stationRef(ctx.sid).collection('schedule_preflight')
      .doc(best.id).get();
    const report = preflight.exists ? (preflight.data() || {}) : null;
    return {
      publication_id: best.id,
      revision: Number(best.revision || 0),
      from: best.from || null, to: best.to || null,
      content_hash: best.content_hash || null,
      prepared_count: docs.length,
      preflight: report ? {
        signature: report.signature || null,
        blocked: report.blocked === true,
        by_reason: report.by_reason || null,
        generated_at: report.generated_at || null,
        expires_at: report.expires_at || null
      } : null
    };
  }

  async function setRuntimeMode(req) {
    const ctx = await context(req);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const actor = modeActor(ctx);

    // ההרשאה נבדקת לפני כל קריאה נוספת: מי שאינו רשאי אינו אמור
    // לגרום לשרת לקרוא את המקור כולו.
    if (!modeAuthority.mayChangeMode(actor)) {
      throw new ScheduleRuntimeError(modeAuthority.CODE.FORBIDDEN,
        'שינוי מצב מנוע הסידור מותר לפיקוד התחנה בלבד. '
        + 'מינוי אחראי/ת סידור אינו כולל את ההרשאה הזאת.', 'permission-denied');
    }

    /* ⭐ המתג הכללי לעולם אינו מדליק את `new` — גם לא לפיקוד ולא
     * למנהל-על: מסלול כזה עוקף מועמד מוכן, דוח preflight חתום ואישור
     * שינויים. המסלול היחיד הוא `promoteToNew`. הבדיקה קודמת ל-replay
     * ולקריאות המוכנות (Codex, 93e74be) כדי שגם בקשה ישנה לא תוכל
     * להחזיר הצלחת הפעלה. הקוד אחד: `cutover-required` — גם המסך
     * וגם `schedule-mode-authority` מפנים אליו. */
    if (data.target === MODE.NEW) {
      throw new ScheduleRuntimeError('cutover-required',
        'מעבר למנוע החדש נעשה דרך אישור המעבר בלבד: מכינים סידור, '
        + 'בודקים אותו מול הסידור הקיים, ורק אז מעבירים. '
        + 'החלפת מצב ישירה תשאיר את התחנה בלי לוח.', 'failed-precondition');
    }

    /* ⭐ טביעת האצבע נגזרת מה**בקשה**, לא מהתוצאה.
     *
     * זה מה שמאפשר לענות נכון על ניסיון חוזר. אילו הייתה נגזרת
     * מ-`from → to`, ניסיון חוזר אחרי שהפעולה כבר הצליחה היה נראה
     * כבקשה אחרת לגמרי — כי המצב כבר זז — ומי שרשת התנתקה לו באמצע
     * לא היה יכול לדעת אם המנוע נכבה או לא. */
    const opRef = modeOperationRef(ctx.sid, requestId);
    const fingerprint = digest({
      station_id: ctx.sid, actor_uid: ctx.uid, request_id: requestId,
      target: String(data.target || ''), reason_code: data.reason_code || null,
      expected_mode: nonEmpty(data.expected_mode) ? data.expected_mode : null
    });

    function replay(snap) {
      if (!snap.exists) return null;
      const op = snap.data() || {};
      if (op.fingerprint !== fingerprint) {
        throw new ScheduleRuntimeError('mode-request-reused',
          'מזהה הפעולה כבר שימש לבקשה אחרת.', 'already-exists');
      }
      return Object.assign({ duplicate: true }, op.result || {});
    }

    // מסלול מהיר לניסיון חוזר: אין טעם לקרוא את המקור כולו כדי
    // לענות תשובה שכבר נשמרה. הטרנזקציה בודקת שוב, והיא הקובעת.
    const early = replay(await opRef.get());
    if (early) return early;

    const before = await configuration(ctx.sid);

    /* הגנה מדריסה נבדקת לפני הכול: המצב שנמסר הוא מה שהאדם ראה
     * במסך, וגם „כבר במצב שביקשת" הוא תשובה שונה כשהמסך היה ישן.
     *
     * ⭐ P1-2. השדה **חובה**. קודם הוא נבדק רק אם נמסר, כלומר
     * לקוח שהשמיט אותו קיבל דריסה עיוורת של מצב המנוע — בדיוק
     * ההגנה שהשדה קיים בשבילה, מנוטרלת בהשמטה. */
    if (!nonEmpty(data.expected_mode)) {
      throw new ScheduleRuntimeError('mode-expected-required',
        'יש למסור את מצב המנוע שהמסך ראה.', 'invalid-argument');
    }
    if (data.expected_mode !== before.mode) {
      throw new ScheduleRuntimeError('mode-conflict',
        'מצב המנוע השתנה מאז שהמסך נטען. הוא כעת „' + before.mode + '". '
        + 'יש לרענן ולבדוק מה השתנה.', 'aborted');
    }

    // ⭐ הבדיקה המקדימה יקרה, ובכוונה מחוץ לטרנזקציה: היא קוראת את
    // המקור כולו. נקודת ההכרעה היא הקריאה החוזרת בתוך הטרנזקציה.
    const readiness = data.target === MODE.OFF
      ? { policy: true, source: true, people: 1, problems: [] }
      : await modeReadiness(ctx, before);

    let plan;
    try {
      plan = modeAuthority.planModeChange({
        current: before.mode,
        target: data.target,
        actor,
        confirmation: data.confirmation,
        reason_code: data.reason_code,
        readiness
      });
    } catch (error) { modeError(error); }

    /* המתג הכללי כבר דחה `new` למעלה, לפני ה-replay; כאן `plan.to`
     * לעולם אינו NEW. */

    if (plan.kind === 'unchanged') {
      return { duplicate: false, changed: false, mode: before.mode, from: before.mode,
        to: before.mode, transition: null };
    }

    await beforeSnapshotFinalize({ kind: 'mode', ref: runtimeRef(ctx.sid), ctx });
    return await db.runTransaction(async (tx) => {
      const opSnap = await tx.get(opRef);
      const runtimeSnap = await tx.get(runtimeRef(ctx.sid));
      /* ⭐ P1-2. הזהות נקראת חיה כאן. מפקד שהוסר מהתחנה בין טעינת
       * המסך לבין הלחיצה אינו מזיז את מצב המנוע של התחנה. */
      const liveUserSnap = await tx.get(liveUserRef(ctx.sid, ctx.uid));
      requireLiveModeAuthority(liveUserSnap, ctx, 'mode-actor-inactive');
      const runtimeData = runtimeSnap.exists ? (runtimeSnap.data() || {}) : {};
      const liveMode = MODES.indexOf(runtimeData.mode) !== -1 ? runtimeData.mode : MODE.OFF;

      const replayed = replay(opSnap);
      if (replayed) return replayed;

      if (liveMode !== plan.from) {
        throw new ScheduleRuntimeError('mode-conflict',
          'מצב המנוע השתנה בזמן הפעולה. הוא כעת „' + liveMode + '".', 'aborted');
      }

      const result = {
        changed: true, mode: plan.to, from: plan.from, to: plan.to,
        transition: plan.transition, reason_code: plan.audit.reason_code
      };
      tx.set(runtimeRef(ctx.sid), { mode: plan.to }, { merge: true });
      tx.set(modeAuditRef(ctx.sid, requestId), Object.assign({
        station_id: ctx.sid, at: clock(), request_id: requestId
      }, plan.audit));
      tx.set(opRef, {
        station_id: ctx.sid, actor_uid: ctx.uid, fingerprint,
        created_at: clock(), expires_at: modeOperationExpiry(), result
      });
      return Object.assign({ duplicate: false }, result);
    });
  }

  async function runPlanner(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.SHADOW, MODE.NEW]);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const start = String(data.start || '');
    isoDayOffset(start, 0);
    if (start.slice(8, 10) !== '01') {
      throw new ScheduleRuntimeError('month-start-required',
        'תכנון חודשי חייב להתחיל ביום הראשון בחודש.', 'invalid-argument');
    }
    const months = Number(data.months);
    if (!integer(months) || months < 1 || months > 3) {
      throw new ScheduleRuntimeError('months-invalid', 'אפשר לתכנן חודש עד שלושה.', 'invalid-argument');
    }
    const policy = await loadPolicy(ctx, config.active_policy_id);
    const source = await loadSource(ctx, config.active_source_id);
    const overrides = normalizeOverrides(data.overrides, policy.value);
    const effective = effectiveSource(ctx, source, policy, overrides);
    const fingerprint = digest({ ctx: ctx.sid, uid: ctx.uid, requestId, start, months,
      source: effective.digest, policy: policy.digest, overrides });
    const draftId = 'd_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const ref = stationRef(ctx.sid).collection('schedule_drafts').doc(draftId);
    const existing = await ref.get();
    if (existing.exists) {
      const before = existing.data() || {};
      if (before.request_fingerprint !== fingerprint) {
        throw new ScheduleRuntimeError('request-conflict',
          'אותו מזהה פעולה כבר שימש לקלט אחר.', 'already-exists');
      }
      if (before.status === 'cancelled') {
        throw new ScheduleRuntimeError('draft-cancelled',
          'הטיוטה בוטלה ולכן יש להתחיל פעולה חדשה.', 'aborted');
      }
      if (before.status !== 'complete') {
        throw new ScheduleRuntimeError('draft-staging', 'הטיוטה עדיין נבנית. נסה שוב בעוד רגע.', 'aborted');
      }
      return { duplicate: true, draft_id: draftId, summary: before.summary, from: before.from, to: before.to };
    }
    const engine = createEngine({ clock, policy: policy.value });
    const planSet = engine.planMonths({
      station_id: ctx.sid,
      source_snapshot: effective.snapshot,
      source_version: effective.version,
      contract_station_id: ctx.sid,
      source_revision: effective.revision,
      source_digest: effective.digest,
      policy_digest: policy.digest,
      source_complete: true,
      availability: effective.availability,
      locked: effective.locked,
      carry: effective.carry,
      roster: effective.roster,
      start,
      months
    });
    const plan = flattenPlanSet(planSet);
    // A draft may deliberately contain staffing gaps for a manager to review,
    // but it must never contain a manual placement the engine has rejected.
    // Unlike source setup, this gate sees the exact requested start/months and
    // therefore also catches a preceding automatic assignment that violates
    // the rest rule on a later manual lock.  Fail before any draft is staged.
    if (Number(plan.summary.rejected_manual || 0) > 0) {
      throw new ScheduleRuntimeError('manual-assignment-rejected',
        'אחד השיבוצים הידניים סותר את כללי הסידור בטווח שנבחר.', 'failed-precondition');
    }
    // Planning can take time.  Re-read the live access record at the write
    // boundary so a manager removed while the plan was calculated cannot
    // create a usable draft after revocation.
    await db.runTransaction(async (tx) => {
      const refs = [liveUserRef(ctx.sid, ctx.uid), scheduleAccessRef(ctx.sid, ctx.uid), ref];
      const snaps = await Promise.all(refs.map((item) => tx.get(item)));
      requireLiveManager(snaps[0], snaps[1], ctx);
      if (snaps[2].exists) {
        throw new ScheduleRuntimeError('draft-race',
          'טיוטה עם אותו מזהה נוצרה במקביל. רענן ונסה שוב.', 'aborted');
      }
      tx.create(ref, {
      station_id: ctx.sid, status: 'staging', request_id: requestId,
      request_fingerprint: fingerprint, source_id: source.id, policy_id: policy.id,
      base_source_digest: source.digest, base_policy_digest: policy.digest,
      created_by: ctx.uid, created_by_name: ctx.name, created_at: FV.serverTimestamp(),
      source_snapshot: plan.source_snapshot, source_version: plan.source_version,
      contract_station_id: plan.contract_station_id, source_revision: plan.source_revision,
      source_digest: plan.source_digest, source_complete: true,
      policy_version: plan.policy_version, policy_digest: plan.policy_digest,
      generated_at: plan.generated_at, from: plan.from, to: plan.to,
      summary: plan.summary, months
      });
    });
    const contentDigest = await stageSnapshot(ref, {}, plan, effective.events, effective.roster);
    await finalizeDraft(ctx, ref, contentDigest);
    return { duplicate: false, draft_id: draftId, summary: plan.summary, from: plan.from, to: plan.to };
  }

  async function getDraftPreview(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.SHADOW, MODE.NEW]);
    const data = plain(req.data) ? req.data : {};
    const draftId = requireId(data.draft_id, 'draft-id', 'מזהה הטיוטה');
    const start = String(data.start || '');
    isoDayOffset(start, 0);
    const ref = stationRef(ctx.sid).collection('schedule_drafts').doc(draftId);
    const snap = await ref.get();
    const meta = snap.exists ? (snap.data() || {}) : {};
    if (!snap.exists || meta.status !== 'complete' || meta.station_id !== ctx.sid) {
      throw new ScheduleRuntimeError('draft-not-ready', 'הטיוטה אינה קיימת או טרם הושלמה.');
    }
    if (meta.source_id !== config.active_source_id || meta.policy_id !== config.active_policy_id) {
      throw new ScheduleRuntimeError('draft-stale', 'הטיוטה אינה מבוססת על המקור והמדיניות הפעילים.');
    }
    const current = await Promise.all([
      stationRef(ctx.sid).collection('schedule_policies').doc(meta.policy_id).get(),
      stationRef(ctx.sid).collection('schedule_sources').doc(meta.source_id).get()
    ]);
    const livePolicy = current[0].exists ? (current[0].data() || {}) : {};
    const liveSource = current[1].exists ? (current[1].data() || {}) : {};
    if (livePolicy.complete !== true || liveSource.complete !== true
        || livePolicy.content_digest !== meta.base_policy_digest
        || liveSource.content_digest !== meta.base_source_digest) {
      throw new ScheduleRuntimeError('draft-source-changed',
        'המדיניות או מקור הנתונים השתנו מאז בניית הטיוטה. יש לבנות טיוטה חדשה.', 'aborted');
    }
    if (start < meta.from || start > meta.to) {
      throw new ScheduleRuntimeError('preview-date-outside-draft',
        'תאריך התצוגה המקדימה נמצא מחוץ לטווח הטיוטה.', 'invalid-argument');
    }
    const dates = [];
    for (let index = 0; index < DRAFT_PREVIEW_DAYS; index += 1) {
      const date = isoDayOffset(start, index);
      if (date > meta.to) break;
      dates.push(date);
    }
    const snapshot = sliceVerifiedSnapshot(await readSnapshot(ref, meta), dates);
    const service = serviceFor(ctx);
    const days = dates.map((date) => service.buildStationSchedule({
      actor: actor(ctx), plan: snapshot.plan, events: snapshot.events,
      roster: snapshot.roster, date
    }).day);
    return {
      draft_id: draftId,
      expected_content_digest: meta.content_digest,
      from: meta.from,
      to: meta.to,
      week_start: start,
      days
    };
  }

  async function activeSnapshot(ctx, dates) {
    const pointer = await activeRef(ctx.sid).get();
    if (!pointer.exists || !nonEmpty((pointer.data() || {}).publication_id)) return null;
    const p = pointer.data() || {};
    if (!integer(p.revision) || p.revision < 1 || !nonEmpty(p.content_digest)) {
      throw new ScheduleRuntimeError('active-pointer-invalid',
        'מצביע הסידור הפעיל אינו שלם ולכן התצוגה נעצרה.');
    }
    const ref = stationRef(ctx.sid).collection('schedule_publications').doc(p.publication_id);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new ScheduleRuntimeError('active-publication-missing', 'הפרסום הפעיל אינו שלם.');
    }
    const meta = snap.data() || {};
    if (meta.station_id !== ctx.sid || meta.status !== 'active'
        || meta.snapshot_complete !== true || !integer(meta.revision)
        || !nonEmpty(meta.content_digest)) {
      throw new ScheduleRuntimeError('active-publication-invalid',
        'הפרסום הפעיל אינו שלם או אינו שייך לתחנה.');
    }
    if (meta.revision !== p.revision || meta.content_digest !== p.content_digest) {
      throw new ScheduleRuntimeError('active-publication-pointer-mismatch',
        'מצביע הסידור אינו תואם לגרסה החתומה ולכן התצוגה נעצרה.');
    }
    const value = sliceVerifiedSnapshot(await readSnapshot(ref, meta), dates);
    return { pointer: p, ref, meta, plan: value.plan, events: value.events, roster: value.roster };
  }

  async function publishedSnapshot(ctx, publicationId) {
    const id = requireId(publicationId, 'publication-id', 'מזהה הפרסום');
    const ref = stationRef(ctx.sid).collection('schedule_publications').doc(id);
    const snap = await ref.get();
    const meta = snap.exists ? (snap.data() || {}) : {};
    if (!snap.exists || meta.status !== 'active' || meta.station_id !== ctx.sid
        || meta.snapshot_complete !== true || !nonEmpty(meta.content_digest)) {
      throw new ScheduleRuntimeError('rollback-target-missing',
        'גרסת היעד לחזרה אינה קיימת או אינה שלמה.');
    }
    const value = await readSnapshot(ref, meta);
    return { ref, meta, plan: value.plan, events: value.events, roster: value.roster };
  }

  async function activePublicationGate(ref) {
    let active = false;
    await db.runTransaction(async (tx) => {
      const publicationSnap = await tx.get(ref);
      if (!publicationSnap.exists) return;
      const publication = publicationSnap.data() || {};
      const stationId = String(publication.station_id || '');
      const publicationId = String(ref.id || '');
      if (!ID_RE.test(stationId) || !ID_RE.test(publicationId)) return;
      const refs = [runtimeRef(stationId), activeRef(stationId)];
      const snaps = await Promise.all(refs.map((item) => tx.get(item)));
      const runtime = snaps[0].exists ? (snaps[0].data() || {}) : {};
      const pointer = snaps[1].exists ? (snaps[1].data() || {}) : {};
      active = runtime.mode === MODE.NEW && publication.status === 'active'
        && pointer.publication_id === publicationId
        && Number(pointer.revision || 0) === Number(publication.revision || 0);
    });
    return active;
  }

  async function releaseOutbox(ref) {
    // The active-pointer transaction is the release authority.  It deliberately
    // does not depend on the original actor: a schedule validly activated just
    // before that actor was revoked must still notify its affected people.
    if (!await activePublicationGate(ref)) return { released: 0 };
    const snap = await ref.collection('schedule_outbox').where('status', '==', 'blocked').get();
    let released = 0;
    const now = Date.parse(clock());
    for (let index = 0; index < snap.docs.length; index += 100) {
      const refs = snap.docs.slice(index, index + 100).map((doc) => doc.ref);
      await db.runTransaction(async (tx) => {
        const current = await Promise.all(refs.map((item) => tx.get(item)));
        current.forEach((item) => {
          if (!item.exists) return;
          const value = item.data() || {};
          // A transaction reads the current status so a delayed releaser can
          // never resurrect a sent/cancelled notification from a stale query.
          if (value.status !== 'blocked') return;
          if (outboxExpired(value, now)) {
            cancelOutbox(tx, item.ref, 'outbox-expired');
            return;
          }
          tx.update(item.ref, { status: 'queued', queued_at: FV.serverTimestamp() });
          released += 1;
        });
      });
    }
    return { released };
  }

  function cancelOutbox(tx, ref, reason) {
    tx.update(ref, {
      status: 'cancelled', cancel_reason: reason,
      cancelled_at: FV.serverTimestamp(), lease_token: null, lease_until: null
    });
  }

  async function reconcileOutbox(ref, now) {
    let deliver = false;
    let queued = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const value = snap.data() || {};
      const stationId = String(value.station_id || '');
      const publicationId = String(value.publication_id || '');
      const person = String(value.person || '');
      const status = String(value.status || '');
      if (!ID_RE.test(stationId) || !ID_RE.test(publicationId) || !AUTH_UID_RE.test(person)
          || ['blocked', 'retry', 'sending', 'queued'].indexOf(status) === -1) {
        if (status !== 'sent' && status !== 'cancelled') cancelOutbox(tx, ref, 'outbox-invalid');
        return;
      }
      if (outboxExpired(value, now)) {
        cancelOutbox(tx, ref, 'outbox-expired');
        return;
      }
      const publicationRef = stationRef(stationId).collection('schedule_publications').doc(publicationId);
      const refs = [runtimeRef(stationId), activeRef(stationId), publicationRef,
        liveUserRef(stationId, person)];
      const checks = await Promise.all(refs.map((item) => tx.get(item)));
      const runtime = checks[0].exists ? (checks[0].data() || {}) : {};
      const pointer = checks[1].exists ? (checks[1].data() || {}) : {};
      const publication = checks[2].exists ? (checks[2].data() || {}) : {};
      /* ⭐ P0-2. הודעה שממתינה לפרסום מוכן חיה דווקא ב-shadow — זה
       * כל הרעיון: להכין הכול לפני המעבר. הגרסה הקודמת ביטלה כאן כל
       * הודעה שאינה ב-`new`, כלומר הייתה מוחקת את תור ההודעות של
       * הפרסום המוכן בזמן שהוא ממתין, והמעבר היה קורה בלי שאיש
       * יקבל הודעה. שורה `blocked` ב-shadow היא המתנה תקינה. */
      if (runtime.mode !== MODE.NEW
          && !(runtime.mode === MODE.SHADOW && status === 'blocked')) {
        cancelOutbox(tx, ref, 'runtime-not-new');
        return;
      }
      if (!recipientIsActive(checks[3], stationId)) {
        cancelOutbox(tx, ref, 'recipient-inactive');
        return;
      }
      if (publication.status === 'staging' || publication.status === 'complete'
          || publication.status === 'prepared') {
        // blocked is the intentional pre-activation state.  A scheduler must
        // never cancel it just because the pointer has not committed yet.
        // `prepared` is that same state held deliberately across the cutover.
        if (status !== 'blocked') cancelOutbox(tx, ref, 'publication-not-active');
        return;
      }
      if (publication.status !== 'active'
          || pointer.publication_id !== publicationId
          || Number(pointer.revision || 0) !== Number(value.revision || 0)) {
        cancelOutbox(tx, ref, 'publication-not-active');
        return;
      }
      if (status === 'queued') {
        deliver = true;
        return;
      }
      if (status === 'retry') {
        const nextAttempt = timeMillis(value.next_attempt_at);
        if (Number.isFinite(nextAttempt) && nextAttempt > now) return;
      }
      if (status === 'sending') {
        const leaseUntil = timeMillis(value.lease_until);
        if (Number.isFinite(leaseUntil) && leaseUntil > now) return;
      }
      tx.update(ref, {
        status: 'queued', queued_at: FV.serverTimestamp(), lease_token: null, lease_until: null
      });
      queued = true;
    });
    return { queued, deliver };
  }

  /* ==================================================================
   *  P0-2 · המעבר לחי · preflight ו-cutover אטומי
   *
   *  ⭐ שתי הפונקציות האלה קיימות כדי שהמעבר למנוע החדש לא יהיה
   *  „החלף מצב ותקווה". `previewCutover` משווה את הפרסום המוכן מול
   *  מה שהתחנה רואה **היום**, ו-`promoteToNew` מבצע את ההחלפה
   *  בטרנזקציה אחת.
   *
   *  ההכרעה עצמה חיה במודול טהור (`schedule-cutover.js`) ונקראת
   *  **בתוך** הטרנזקציה, על הערכים החיים. כך אין פער בין מה שנבדק
   *  לבין מה שנכתב.
   * ================================================================== */

  /* מוציא `{date, uids[]}` מתוך שורות תמונת פרסום. */
  function cutoverDaysFromRows(rows) {
    const byDate = new Map();
    (rows || []).forEach((row) => {
      if (!row || !nonEmpty(row.date)) return;
      const list = byDate.get(row.date) || [];
      (row.slots || []).forEach((slot) => {
        if (slot && nonEmpty(slot.person)) list.push(slot.person);
      });
      byDate.set(row.date, list);
    });
    return Array.from(byDate.keys()).sort(compareCanonical)
      .map((date) => ({ date, uids: byDate.get(date) }));
  }

  /* ואותו דבר מתוך חלון ה-legacy. */
  function cutoverDaysFromLegacy(days) {
    return (days || []).filter((day) => day && nonEmpty(day.date))
      .map((day) => ({
        date: day.date,
        uids: (day.assignments || []).map((item) => item && item.uid)
          .filter((uid) => nonEmpty(uid))
      }))
      .sort((a, b) => compareCanonical(a.date, b.date));
  }

  async function preparedPublication(ctx, publicationId) {
    const ref = stationRef(ctx.sid).collection('schedule_publications').doc(publicationId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new ScheduleRuntimeError('cutover-candidate-missing',
        'הפרסום המוכן לא נמצא.', 'failed-precondition');
    }
    const meta = snap.data() || {};
    if (meta.station_id !== ctx.sid) {
      throw new ScheduleRuntimeError('cutover-candidate-missing',
        'הפרסום המוכן שייך לתחנה אחרת.', 'failed-precondition');
    }
    return { ref, meta };
  }

  /* ⭐ טביעת האצבע של הסידור הישן שהושווה מולו.
   *
   * לא מונה גרסה — **תוכן**. סידור legacy שפורסם מחדש עם אותו תוכן
   * בדיוק אינו הופך את הדוח לישן; סידור שהשתנה — כן. מונה היה עונה
   * הפוך בשני המקרים. */
  async function legacyComparisonDigest(ctx, config, from, to) {
    const legacy = await legacyFallbackWindow(ctx, config, from, to);
    const days = cutoverDaysFromLegacy(legacy.days);
    return { legacy, days, digest: String(hash(stable(days))) };
  }

  /* ⭐ A (seq379) · אותו digest, **בתוך** העסקה של המעבר. כל קלט legacy
   * שהדוח נחתם עליו (roster, rotations, overrides, swaps, guards בחלון)
   * נקרא דרך `tx`, ולכן כתיבה לאחד מהם בין ה-preflight ל-commit מפילה
   * את העסקה (Firestore מזהה קריאה שהתיישנה) — או משנה את ה-digest
   * ונדחית ב-`cutover-legacy-changed`. אין כאן חלון. */
  async function legacyComparisonDigestInTx(tx, ctx, from, to) {
    const window = await effectiveReaderFor(ctx, { tx }).getStation({ data: { from, to } });
    if (window.source !== 'legacy') {
      throw new ScheduleRuntimeError('schedule-mode-changed',
        'מצב הסידור השתנה בזמן המעבר. יש לרענן.', 'aborted');
    }
    const days = cutoverDaysFromLegacy(window.days);
    return { days, digest: String(hash(stable(days))) };
  }

  async function previewCutover(req) {
    const ctx = await context(req);
    /* ⭐ שער הפיקוד, ולא שער המנהל — אותו שער בדיוק כמו ב-`promoteToNew`.
     *
     * `requireManager` כאן שבר את הפרדת הסמכויות מקצה לקצה: המפקד
     * הוא שמאשר את המעבר, אבל המסך קורא קודם ל-preview — ולכן
     * **המפקד נחסם בשלב הראשון** ולא יכול היה להגיע לאישור כלל.
     * שני שערים שונים על שני צדדים של אותה פעולה אינם הפרדת
     * סמכויות, הם באג.
     *
     * ואין כאן הרחבה בכיוון השני: `schedule_manager` אינו מקבל
     * סמכות cutover. הוא מכין את המועמד; הפיקוד בודק ומאשר. */
    const previewActor = modeActor(ctx);
    if (!modeAuthority.mayChangeMode(previewActor)) {
      throw new ScheduleRuntimeError(modeAuthority.CODE.FORBIDDEN,
        'בדיקת המעבר למנוע החדש שמורה לפיקוד התחנה.', 'permission-denied');
    }
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.SHADOW]);
    const data = plain(req.data) ? req.data : {};
    const candidateId = requireId(data.candidate_publication_id,
      'publication-id', 'מזהה הפרסום המוכן');

    const candidate = await preparedPublication(ctx, candidateId);
    if (candidate.meta.status !== 'prepared' || candidate.meta.snapshot_complete !== true) {
      throw new ScheduleRuntimeError('cutover-candidate-not-prepared',
        'הפרסום אינו במצב „מוכן" ולכן אין מה לבדוק מולו.', 'failed-precondition');
    }
    const from = String(candidate.meta.from || '');
    const to = String(candidate.meta.to || '');
    if (!nonEmpty(from) || !nonEmpty(to)) {
      throw new ScheduleRuntimeError('cutover-candidate-range',
        'לפרסום המוכן אין טווח תאריכים.', 'failed-precondition');
    }

    /* ⭐ התמונה נקראת **במלואה** (dates=null) כדי שחתימת התוכן תיבדק.
     * קריאת חלון מדלגת על האימות הזה, ודוח שמבוסס על תמונה שלא
     * אומתה אינו שווה את החתימה שנשים עליו. */
    /* ⭐ מועמד שנבנה על מקור או מדיניות אחרים מאלה שפעילים עכשיו
     * אינו בר-בדיקה: הדוח היה מתאר השוואה מול תצורה שהמועמד כלל
     * לא נבנה עליה. עוצרים כאן, ולא מייצרים דוח חתום שמטעה. */
    if (candidate.meta.source_id !== config.active_source_id
        || candidate.meta.policy_id !== config.active_policy_id) {
      throw new ScheduleRuntimeError('cutover-candidate-config',
        'הפרסום המוכן נבנה על מקור או חוקי תחנה אחרים מאלה הפעילים. '
        + 'יש לבנות טיוטה חדשה.', 'failed-precondition');
    }

    const snapshot = await readSnapshot(candidate.ref, candidate.meta, null);
    const legacy = await legacyComparisonDigest(ctx, config, from, to);
    const source = await loadSource(ctx, config.active_source_id);
    const policy = await loadPolicy(ctx, config.active_policy_id);
    const predecessor = await activeRef(ctx.sid).get();
    const predecessorId = predecessor.exists
      ? ((predecessor.data() || {}).publication_id || null) : null;

    const report = cutover.preflight({
      station_id: ctx.sid,
      allowed_uids: source.peopleRaw.filter((person) => person.active === true)
        .map((person) => person.id),
      from, to,
      legacy_days: legacy.days,
      /* ⭐ שני העוגנים שקושרים את הדוח לעולם שבו הוא נבדק — ולא רק
       * לזמן. TTL אומר „הדוח צעיר"; אלה אומרים „הדוח מתאר את מה
       * שקיים". */
      legacy_revision: legacy.digest,
      predecessor_publication_id: predecessorId,
      /* ⭐ `readSnapshot` מחזיר את השורות ב-`plan.rows`. הגרסה
       * הקודמת קראה `plan.days || snapshot.rows` — שני נתיבים
       * שאינם קיימים — ולכן `next_days` היה **תמיד ריק**,
       * ה-preflight ראה שכל יום התרוקן וחסם כל מעבר מתחנה מאוישת.
       *
       * אין כאן fallback בכוונה: fallback מסתיר חוזה שבור במקום
       * להפיל אותו, וזה בדיוק מה שקרה כאן. */
      next_days: cutoverDaysFromRows(snapshot.plan.rows),
      candidate_publication_id: candidateId,
      candidate_source_id: candidate.meta.source_id || null,
      candidate_policy_id: candidate.meta.policy_id || null,
      policy_digest: policy.digest,
      source_digest: source.digest,
      content_hash: candidate.meta.content_hash || null
    });

    /* הדוח נשמר כדי שהמעבר יוכל לאמת שהוא אותו דוח. הוא ספירות
     * וקודים בלבד — אין בו שם ואין uid. */
    await stationRef(ctx.sid).collection('schedule_preflight')
      .doc(candidateId).set(Object.assign({}, report, {
        actor_uid: ctx.uid, stored_at: FV.serverTimestamp(),
        /* ⭐⭐ שדה TTL **נפרד**, ו-`expires_at` החתום נשאר כפי שנחתם.
         *
         * הגרסה הקודמת עשתה `expires_at: new Date(report.expires_at)`
         * — כלומר דרסה שדה שנמצא **בתוך הגוף החתום** באובייקט תאריך.
         * Firestore מחזיר אותו כ-`Timestamp`, `stable()` רואה ערך
         * אחר מזה שנחתם, והחתימה אינה תואמת לעצמה. התוצאה:
         * **כל מעבר נחסם**, תמיד, על דוח תקין לחלוטין.
         *
         * זה נמצא רק בהרצת אמולטור אמיתית. בזיכרון `Date` נשאר
         * `Date`, ולכן שום בדיקה טהורה לא יכלה לראות את זה — וזו
         * בדיוק הסיבה שהאמולטור אינו „עוד שכבה", אלא השכבה שבודקת
         * את הגבול הזה.
         *
         * הכלל שנשאר: **שדה חתום אינו משמש גם כשדה תשתית.** TTL
         * מקבל `ttl_expires_at` משלו, שאינו בגוף החתום ולכן אינו
         * יכול לשבור אותו. `firestore.indexes.json` מצביע עליו. */
        ttl_expires_at: new Date(report.expires_at)
      }));
    return report;
  }

  async function promoteToNew(req) {
    const ctx = await context(req);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const candidateId = requireId(data.candidate_publication_id,
      'publication-id', 'מזהה הפרסום המוכן');
    const expectedMode = String(data.expected_mode || '');

    /* ⭐⭐ החתימה שהוצגה למפקד, והיא **חובה**.
     *
     * בלעדיה המסך היה מציג דוח אחד, ומאשר את מה שהשרת קורא מהדיסק
     * ברגע האישור. בין שתי הנקודות האלה יכול היה לרוץ preview נוסף
     * ולדרוס את הדוח — והמפקד היה מאשר, בלחיצה אחת, מסמך שלא ראה
     * מעולם.
     *
     * הזמן והעוגנים אומרים „הדוח לא התיישן". זה אומר משהו אחר
     * לגמרי: **זה אותו דוח.** */
    const expectedSignature = String(data.expected_preflight_signature || '');
    /* אישור השינויים, אם יש. הצורה שלו היא **חתימת הדוח** ולא
     * דגל: אישור לדוח אחד אינו אישור לדוח אחר. */
    const acceptChanges = nonEmpty(data.accept_changes)
      ? String(data.accept_changes) : null;
    if (!nonEmpty(expectedSignature)) {
      throw new ScheduleRuntimeError('cutover-signature-required',
        'יש למסור את חתימת דוח הבדיקה שהוצגה במסך.', 'invalid-argument');
    }

    /* ⭐ שער הפיקוד, ולא שער המנהל. הזזת המצב שייכת לפיקוד — בדיוק
     * כמו ב-`setRuntimeMode`, ומאותה סיבה. `requireManager` אינו
     * נקרא כאן. */
    const actor = modeActor(ctx);
    if (!modeAuthority.mayChangeMode(actor)) {
      throw new ScheduleRuntimeError(modeAuthority.CODE.FORBIDDEN,
        'הזזת מצב מנוע הסידור שמורה לפיקוד התחנה.', 'permission-denied');
    }

    const opRef = modeOperationRef(ctx.sid, requestId);
    /* ⭐ C (seq379) · טביעת האצבע קושרת את **מלוא הכוונה**: גם חתימת
     * הדוח וגם אישור השינויים. ניסיון חוזר זהה מחזיר את התוצאה; אותו
     * מזהה עם דוח אחר או אישור אחר — נדחה. */
    const fingerprint = digest({
      station_id: ctx.sid, actor_uid: ctx.uid, request_id: requestId,
      candidate: candidateId, expected_mode: expectedMode,
      expected_preflight_signature: expectedSignature,
      accept_changes: acceptChanges
    });
    function replayOf(opSnap) {
      if (!opSnap.exists) return null;
      const op = opSnap.data() || {};
      if (op.fingerprint !== fingerprint) {
        throw new ScheduleRuntimeError('cutover-request-reused',
          'מזהה הפעולה כבר שימש לבקשה אחרת.', 'already-exists');
      }
      return Object.assign({ duplicate: true }, op.result || {});
    }
    // מסלול מהיר לניסיון חוזר; הקובעת היא הקריאה בתוך העסקה.
    const early = replayOf(await opRef.get());
    if (early) return early;

    const candidate = await preparedPublication(ctx, candidateId);
    const pubRef = candidate.ref;
    const preflightRef = stationRef(ctx.sid).collection('schedule_preflight').doc(candidateId);
    const from = String(candidate.meta.from || '');
    const to = String(candidate.meta.to || '');

    await beforeSnapshotFinalize({ kind: 'cutover', ref: pubRef, ctx });
    /* ⭐ טביעת האצבע של הסידור הישן, נמדדת מחדש **עכשיו** ומושווית
     * בתוך העסקה לזו שנחתמה בבדיקה.
     *
     * ואני אומר במפורש מה זה כן ומה זה לא: הקריאה הזאת היא **לפני**
     * העסקה, כי היא סורקת חלון תאריכים ואי אפשר לעשות זאת בתוך
     * טרנזקציה של Firestore. כלומר החלון צומצם מ**שעתיים** —
     * תוקף ה-preflight — ל**שברירי שנייה**, אבל לא נסגר.
     *
     * העוגן השני, `predecessor_publication_id`, כן נבדק אטומית:
     * המצביע הפעיל נקרא בתוך העסקה עצמה. */
    let result = null;
    const outcome = await db.runTransaction(async (tx) => {
      const refs = [runtimeRef(ctx.sid), activeRef(ctx.sid), pubRef, preflightRef,
        liveUserRef(ctx.sid, ctx.uid), opRef];
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      /* ⭐ C · רשומת הפעולה נקראת **בתוך** העסקה, לפני כל בדיקת מעבר:
       * שני promoters עם אותו מזהה — השני רואה את התוצאה, לא מבצע שוב. */
      const replayed = replayOf(snaps[5]);
      if (replayed) return { replayed };
      const liveRuntime = snaps[0].exists ? (snaps[0].data() || {}) : {};
      const liveActive = snaps[1].exists ? (snaps[1].data() || {}) : {};
      const livePub = snaps[2].exists ? (snaps[2].data() || {}) : {};
      const livePreflight = snaps[3].exists ? (snaps[3].data() || {}) : null;

      /* ⭐ ההשוואה **בתוך** העסקה, ועל הדוח החי כפי שהוא ברגע
       * ה-commit. מחוץ לעסקה זה היה עוד TOCTOU. */
      if (!livePreflight || String(livePreflight.signature || '') !== expectedSignature) {
        throw new ScheduleRuntimeError('cutover-signature-mismatch',
          'דוח הבדיקה השתנה מאז שהוצג במסך. יש לבדוק מחדש ולאשר את הדוח החדש.',
          'aborted');
      }

      /* ⭐ הזהות נקראת מחדש **כאן**. מי שהוסר מהתחנה בין טעינת המסך
       * לבין הלחיצה אינו מעביר תחנה למנוע חדש. */
      requireLiveModeAuthority(snaps[4], ctx, 'cutover-actor-inactive');

      const liveMode = MODES.indexOf(liveRuntime.mode) !== -1 ? liveRuntime.mode : MODE.OFF;
      const livePolicy = await tx.get(stationRef(ctx.sid).collection('schedule_policies')
        .doc(String(liveRuntime.active_policy_id || '_none')));
      const liveSource = await tx.get(stationRef(ctx.sid).collection('schedule_sources')
        .doc(String(liveRuntime.active_source_id || '_none')));

      /* ⭐ A · טביעת האצבע של הסידור הישן — **בתוך** העסקה, מאותם
       * מסמכים שהדוח נחתם עליהם. כתיבה ל-legacy בין ה-preview ל-commit
       * מפילה את העסקה או משנה את ה-digest; שניהם אינם עוברים. */
      const legacyNow = liveMode === MODE.SHADOW
        ? await legacyComparisonDigestInTx(tx, ctx, from, to) : null;

      /* ⭐ B · תור ההודעות של המועמד, כפי שהוא ברגע ה-commit: שלם,
       * חסום, לא פג, ותואם למניפסט שנכתב בהכנה. תור ישן מפנה להכנה
       * מחדש; אין חידוש פושים בשקט. */
      const outboxSnap = await tx.get(pubRef.collection('schedule_outbox'));
      requireBlockedOutbox(outboxSnap, {
        manifest: livePub.outbox_manifest, sid: ctx.sid, pubId: candidateId,
        revision: Number(livePub.revision || 0), now: Date.parse(clock())
      }, (why) => {
        throw new ScheduleRuntimeError('cutover-outbox-' + why.replace(/^outbox-/, ''),
          'תור ההודעות של הסידור המוכן אינו תקין (' + why + '). '
          + 'יש להכין את הסידור מחדש לפני המעבר.', 'failed-precondition');
      });

      /* ההכרעה עצמה — המודול הטהור, על הערכים החיים. */
      let decision;
      try {
        decision = cutover.decidePromotion({
          from_mode: liveMode,
          to_mode: MODE.NEW,
          expected_mode: expectedMode,
          candidate: {
            publication_id: candidateId,
            status: livePub.status,
            snapshot_complete: livePub.snapshot_complete
          },
          expected_candidate_id: candidateId,
          active_publication_id: nonEmpty(liveActive.publication_id)
            ? liveActive.publication_id : null,
          /* התצורה שהמועמד **נבנה עליה**, מהפרסום עצמו — ולא זו
           * שפעילה עכשיו. הדוח נקשר אליה, ושתיהן נבדקות. */
          candidate_source_id: livePub.source_id || null,
          candidate_policy_id: livePub.policy_id || null,
          /* שני העוגנים. `predecessor` נקרא **בתוך** העסקה הזאת
           * (`liveActive`), ולכן נבדק אטומית מול מה שנחתם. */
          accept_changes: acceptChanges,
          legacy_revision: legacyNow ? legacyNow.digest : null,
          predecessor_publication_id: nonEmpty(liveActive.publication_id)
            ? liveActive.publication_id : null,
          now: clock(),
          preflight: livePreflight,
          policy_digest: livePolicy.exists ? (livePolicy.data() || {}).content_digest : null,
          source_digest: liveSource.exists ? (liveSource.data() || {}).content_digest : null,
          content_hash: livePub.content_hash || null
        });
      } catch (error) {
        if (error && error.name === 'CutoverError') {
          const http = error.code === cutoverModule.CODE.PREFLIGHT_FAILED
            ? 'failed-precondition' : 'aborted';
          const wrapped = new ScheduleRuntimeError(error.code, error.message, http);
          if (error.detail) wrapped.detail = error.detail;
          throw wrapped;
        }
        throw error;
      }

      const revision = Number(livePub.revision || 0);
      /* ⭐ הכול יחד: הפרסום נעשה פעיל, המצביע זז, והמצב נעשה `new`.
       * טרנזקציה אחת — ולכן אין רגע שבו המצב `new` והמצביע ריק. */
      tx.update(pubRef, { status: 'active', activated_at: FV.serverTimestamp() });
      tx.set(activeRef(ctx.sid), {
        publication_id: candidateId, revision,
        previous_publication_id: nonEmpty(liveActive.publication_id)
          ? liveActive.publication_id : null,
        content_digest: livePub.content_digest || null,
        activated_at: FV.serverTimestamp(), activated_by: ctx.uid
      });
      tx.set(runtimeRef(ctx.sid), { mode: MODE.NEW }, { merge: true });
      tx.set(modeAuditRef(ctx.sid, requestId), {
        station_id: ctx.sid, request_id: requestId,
        action: 'cutover', from: decision.from, to: decision.to,
        publication_id: candidateId, revision,
        preflight_signature: decision.preflight_signature,
        actor_uid: ctx.uid, at: FV.serverTimestamp()
      });
      result = {
        mode: MODE.NEW, publication_id: candidateId, revision,
        preflight_signature: decision.preflight_signature
      };
      tx.create(opRef, {
        station_id: ctx.sid, actor_uid: ctx.uid, fingerprint,
        created_at: clock(), expires_at: modeOperationExpiry(), result
      });
      return { replayed: null };
    });
    if (outcome && outcome.replayed) return outcome.replayed;

    /* ⭐ ההודעות משתחררות **רק אחרי** ש-commit הצליח. שחרור שנכשל
     * כאן אינו מאבד דבר: השורות נשארות `blocked`, הפרסום כבר פעיל,
     * ו-`resumeOutbox` משחרר אותן בריצה הבאה בלי כפילות. */
    await releaseOutbox(pubRef);
    return Object.assign({ duplicate: false }, result);
  }

  /* ==================================================================
   * ⭐ P0-2 · פרסום ב-shadow הוא **הכנה**, לא הפעלה
   *
   * `publish` דרש `mode === new`, ולכן אי אפשר היה להכין סידור לפני
   * המעבר — והמעבר עצמו הכריח חלון שבו המצב כבר `new` ואין פרסום.
   * זה בדיוק חלון הלוח הריק.
   *
   * הכוונה נגזרת מהמצב ואינה מתקבלת מהלקוח:
   *   `new`    → פרסום. מופעל מיד ומודיע.
   *   `shadow` → הכנה. נכתב במלואו, נחתם, ה-outbox נשאר `blocked`,
   *              המצביע **אינו** זז ואיש אינו מקבל הודעה.
   *
   * ההפעלה של פרסום מוכן קורית רק ב-`promoteToNew`, יחד עם המצב,
   * בטרנזקציה אחת.
   * ================================================================== */
  /* ⭐ B (seq379) · מניפסט תור ההודעות של פרסום מוכן.
   *
   * נכתב על הפרסום באותה עסקה שמסמנת אותו `prepared`, ונבדק בשני
   * המקומות שמסתמכים על התור: replay של הכנה, וההפעלה עצמה. פרסום
   * מוכן שהתור שלו פג (30 יום), חסר, זר, שונה או כבר שוחרר — אינו
   * מופעל; מכינים מחדש. אפס נמענים מותר כשזה מה שהוכן. */
  function outboxManifestFor(notifications) {
    const ids = (Array.isArray(notifications) ? notifications : []).map((notification) =>
      'n_' + hash(notification.dedupe_key).slice(0, 40) + '|' + String(notification.person || ''));
    ids.sort(compareCanonical);
    return { count: ids.length, digest: String(hash(stable(ids))) };
  }

  function outboxManifestOfRows(rows) {
    const ids = rows.map((row) => row.id + '|' + String(row.person || ''));
    ids.sort(compareCanonical);
    return { count: ids.length, digest: String(hash(stable(ids))) };
  }

  /* מאמת תור חסום מול המניפסט. `fail` — מה לזרוק; שני הקוראים
   * זורקים קודים שונים לאותה מסקנה. */
  function requireBlockedOutbox(snap, expect, fail) {
    const rows = snap.docs.map((doc) => Object.assign({ id: doc.id }, doc.data() || {}));
    const manifest = expect.manifest;
    if (!plain(manifest) || !integer(manifest.count) || manifest.count < 0
        || !nonEmpty(manifest.digest)) {
      fail('outbox-manifest-missing');
    }
    const actual = outboxManifestOfRows(rows);
    if (actual.count !== manifest.count || actual.digest !== manifest.digest) {
      fail('outbox-manifest-mismatch');
    }
    for (const row of rows) {
      if (row.station_id !== expect.sid || row.publication_id !== expect.pubId
          || Number(row.revision) !== expect.revision
          || row.status !== 'blocked' || row.attempt !== 0) {
        fail('outbox-row-invalid');
      }
      if (outboxExpired(row, expect.now)) fail('outbox-expired');
    }
    return rows;
  }

  function preparedReplayInvalid() {
    throw new ScheduleRuntimeError('publication-prepared-replay-invalid',
      'הפרסום המוכן אינו תואם לבקשה או שאינו שלם. יש לרענן ולהכין מחדש.',
      'aborted');
  }

  /**
   * A lost response after a shadow publication commits must be retryable
   * without creating another publication.  Prepared data is deliberately
   * stricter than an active-publication replay: nothing is released and no
   * write or audit is repeated.  A read-only transaction binds the response
   * to one live snapshot of authority, runtime configuration, predecessor,
   * draft/publication signatures and the complete blocked outbox manifest.
   */
  async function replayPreparedPublication(ctx, input) {
    const value = plain(input) ? input : {};
    const notifications = Array.isArray(value.notifications) ? value.notifications : [];
    const expectedOutbox = new Map();
    notifications.forEach((notification) => {
      const id = 'n_' + hash(notification.dedupe_key).slice(0, 40);
      if (expectedOutbox.has(id)) preparedReplayInvalid();
      expectedOutbox.set(id, notification);
    });

    // Validate the immutable child snapshot, not merely the parent's promise
    // that it is complete.  The final transaction below rechecks the parent
    // digest/count metadata so a concurrent metadata swap cannot bless this
    // read.  Snapshot children are server-only once status is `prepared`.
    try {
      await readSnapshot(value.pubRef, value.existingData);
    } catch (error) {
      preparedReplayInvalid();
    }

    // Preserve the named live-authority boundary and then prove it again in
    // the final transaction, after the race hook used by emulator tests.
    await requireLiveManagerNow(ctx);
    await beforeSnapshotFinalize({ kind: 'prepared-replay', ref: value.pubRef, ctx });

    return db.runTransaction(async (tx) => {
      const policyRef = stationRef(ctx.sid).collection('schedule_policies')
        .doc(value.draftMeta.policy_id);
      const sourceRef = stationRef(ctx.sid).collection('schedule_sources')
        .doc(value.draftMeta.source_id);
      const refs = [runtimeRef(ctx.sid), activeRef(ctx.sid), value.draftRef, value.pubRef,
        policyRef, sourceRef, liveUserRef(ctx.sid, ctx.uid), scheduleAccessRef(ctx.sid, ctx.uid)];
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const outboxSnap = await tx.get(value.pubRef.collection('schedule_outbox'));
      const liveRuntime = snaps[0].exists ? (snaps[0].data() || {}) : {};
      const liveActive = snaps[1].exists ? (snaps[1].data() || {}) : {};
      const liveDraft = snaps[2].exists ? (snaps[2].data() || {}) : {};
      const livePub = snaps[3].exists ? (snaps[3].data() || {}) : {};
      const livePolicy = snaps[4].exists ? (snaps[4].data() || {}) : {};
      const liveSource = snaps[5].exists ? (snaps[5].data() || {}) : {};
      requireLiveManager(snaps[6], snaps[7], ctx);

      const actualPrevious = nonEmpty(liveActive.publication_id)
        ? liveActive.publication_id : null;
      const publicationPrevious = nonEmpty(livePub.previous_publication_id)
        ? livePub.previous_publication_id : null;
      const countsValid = integer(livePub.row_count) && livePub.row_count >= 0
        && integer(livePub.event_count) && livePub.event_count >= 0
        && integer(livePub.person_count) && livePub.person_count >= 0;
      const effectiveFields = [
        'source_snapshot', 'source_version', 'contract_station_id',
        'source_revision', 'source_digest', 'source_complete',
        'policy_version', 'policy_digest'
      ];
      const effectiveContractValid = effectiveFields.every((field) =>
        liveDraft[field] === value.draftMeta[field]
        && livePub[field] === liveDraft[field]);
      if (liveRuntime.mode !== MODE.SHADOW
          || liveRuntime.active_source_id !== value.draftMeta.source_id
          || liveRuntime.active_policy_id !== value.draftMeta.policy_id
          || actualPrevious !== value.expectedPrevious
          || Number(liveActive.revision || 0) !== value.revision - 1
          || (value.expectedPrevious !== null
            && liveActive.content_digest !== value.expectedPreviousDigest)
          || liveDraft.station_id !== ctx.sid || liveDraft.status !== 'complete'
          || liveDraft.content_digest !== value.expectedContentDigest
          || liveDraft.source_id !== value.draftMeta.source_id
          || liveDraft.policy_id !== value.draftMeta.policy_id
          || livePub.station_id !== ctx.sid || livePub.status !== 'prepared'
          || livePub.snapshot_complete !== true || !countsValid
          || livePub.request_id !== value.requestId
          || livePub.request_fingerprint !== value.requestFingerprint
          || livePub.source_draft_id !== value.draftId
          || livePub.published_by !== ctx.uid
          || Number(livePub.revision) !== value.revision
          || publicationPrevious !== value.expectedPrevious
          || livePub.content_digest !== value.expectedContentDigest
          || livePub.content_hash !== value.contentHash
          || livePub.source_id !== value.draftMeta.source_id
          || livePub.policy_id !== value.draftMeta.policy_id
          || !effectiveContractValid || livePub.contract_station_id !== ctx.sid
          || liveDraft.base_source_digest !== value.draftMeta.base_source_digest
          || liveDraft.base_policy_digest !== value.draftMeta.base_policy_digest
          || livePolicy.complete !== true || liveSource.complete !== true
          || livePolicy.content_digest !== value.draftMeta.base_policy_digest
          || liveSource.content_digest !== value.draftMeta.base_source_digest) {
        preparedReplayInvalid();
      }

      if (outboxSnap.size !== expectedOutbox.size) preparedReplayInvalid();
      requireBlockedOutbox(outboxSnap, {
        manifest: livePub.outbox_manifest, sid: ctx.sid, pubId: value.pubId,
        revision: value.revision, now: Date.parse(clock())
      }, () => preparedReplayInvalid());
      for (const doc of outboxSnap.docs) {
        const expected = expectedOutbox.get(doc.id);
        const row = doc.data() || {};
        if (!expected || row.station_id !== ctx.sid || row.publication_id !== value.pubId
            || Number(row.revision) !== value.revision || row.person !== expected.person
            || row.dedupe_key !== expected.dedupe_key || row.changed_by !== ctx.uid
            || row.attempt !== 0 || row.status !== 'blocked'
            || outboxExpired(row, Date.parse(clock()))
            || stable(row.push) !== stable(expected.push)
            || stable(row.detail) !== stable(expected.detail)) {
          preparedReplayInvalid();
        }
      }

      return {
        duplicate: true,
        prepared: true,
        publication_id: value.pubId,
        revision: value.revision,
        notified_people: 0,
        blocked_notifications: expectedOutbox.size,
        summary: value.summary
      };
    });
  }

  async function publish(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.NEW, MODE.SHADOW]);
    const preparing = config.mode === MODE.SHADOW;
    const data = plain(req.data) ? req.data : {};
    const draftId = requireId(data.draft_id, 'draft-id', 'מזהה הטיוטה');
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const expectedContentDigest = String(data.expected_content_digest || '');
    const draftRef = stationRef(ctx.sid).collection('schedule_drafts').doc(draftId);
    const draftSnap = await draftRef.get();
    if (!draftSnap.exists || (draftSnap.data() || {}).status !== 'complete') {
      throw new ScheduleRuntimeError('draft-not-ready', 'הטיוטה אינה קיימת או טרם הושלמה.');
    }
    const draftMeta = draftSnap.data() || {};
    if (!nonEmpty(expectedContentDigest) || expectedContentDigest !== draftMeta.content_digest) {
      throw new ScheduleRuntimeError('draft-preview-required',
        'יש לפתוח ולבדוק את התצוגה המקדימה העדכנית לפני הפרסום.', 'failed-precondition');
    }
    if (draftMeta.station_id !== ctx.sid || draftMeta.source_id !== config.active_source_id
        || draftMeta.policy_id !== config.active_policy_id) {
      throw new ScheduleRuntimeError('draft-stale', 'הטיוטה אינה מבוססת על המקור והמדיניות הפעילים.');
    }
    const currentPolicy = await loadPolicy(ctx, config.active_policy_id);
    const currentSource = await loadSource(ctx, config.active_source_id);
    if (draftMeta.base_policy_digest !== currentPolicy.digest
        || draftMeta.base_source_digest !== currentSource.digest) {
      throw new ScheduleRuntimeError('draft-source-changed',
        'המדיניות או מקור הנתונים השתנו מאז בניית הטיוטה. יש לבנות טיוטה חדשה.', 'aborted');
    }
    const next = await readSnapshot(draftRef, draftMeta);
    const before = await activeSnapshot(ctx);
    const previous = before ? before.plan : null;
    const previousEvents = before ? before.events : [];
    const revision = before ? Number(before.pointer.revision || 0) + 1 : 1;
    const pubId = 'p_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const pubRef = stationRef(ctx.sid).collection('schedule_publications').doc(pubId);
    const publication = createPublication({
      clock, hash,
      rules: { max_attempts: 3, retry_backoff_ms: [60000, 300000] }
    });
    const service = serviceFor(ctx, null, publication);
    const planned = service.publish({
      actor: actor(ctx),
      request: {
        next: next.plan,
        previous,
        next_events: next.events,
        previous_events: previousEvents,
        publication_id: pubId,
        publication_revision: revision,
        source_draft_id: draftId,
        previous_publication_id: before ? before.pointer.publication_id : null
      }
    });
    const expectedPrevious = before ? before.pointer.publication_id : null;
    const requestFingerprint = digest({
      station_id: ctx.sid, uid: ctx.uid, request_id: requestId,
      intent: preparing ? 'prepare' : 'activate',
      draft_id: draftId, revision,
      previous_publication_id: expectedPrevious,
      content_hash: planned.publication.content_hash
    });
    const existing = await pubRef.get();
    if (existing.exists) {
      const existingData = existing.data() || {};
      const active = await activeRef(ctx.sid).get();
      const activeData = active.exists ? (active.data() || {}) : {};
      const pointsToExisting = activeData.publication_id === pubId;
      /* Active replay must reconstruct the fingerprint of the original
       * activation.  The current active publication is no longer its own
       * predecessor and must not be used to derive that original request. */
      const fingerprintForExisting = pointsToExisting ? digest({
        station_id: ctx.sid, uid: ctx.uid, request_id: requestId,
        intent: 'activate', draft_id: draftId,
        revision: Number(existingData.revision),
        previous_publication_id: nonEmpty(existingData.previous_publication_id)
          ? existingData.previous_publication_id : null,
        content_hash: planned.publication.content_hash
      }) : requestFingerprint;
      if (existingData.request_fingerprint !== fingerprintForExisting) {
        throw new ScheduleRuntimeError('publication-conflict',
          'מזהה הפרסום כבר קיים עם תוכן אחר.', 'already-exists');
      }
      if (pointsToExisting) {
        if (preparing || config.mode !== MODE.NEW || existingData.status !== 'active'
            || existingData.station_id !== ctx.sid || existingData.snapshot_complete !== true
            || existingData.request_id !== requestId || existingData.source_draft_id !== draftId
            || existingData.published_by !== ctx.uid
            || existingData.content_digest !== expectedContentDigest
            || existingData.content_hash !== planned.publication.content_hash
            || Number(existingData.revision) !== Number(activeData.revision)
            || existingData.content_digest !== activeData.content_digest) {
          preparedReplayInvalid();
        }
        await requireLiveManagerNow(ctx);
        await releaseOutbox(pubRef);
        return { duplicate: true, publication_id: pubId, revision: activeData.revision };
      }
      if (existingData.status === 'prepared') {
        return replayPreparedPublication(ctx, {
          pubId, pubRef, draftId, draftRef, draftMeta, requestId,
          requestFingerprint, expectedContentDigest, expectedPrevious,
          expectedPreviousDigest: before ? before.pointer.content_digest : null,
          revision, contentHash: planned.publication.content_hash,
          notifications: planned.notifications, existingData,
          summary: next.plan.summary
        });
      }
      if (existingData.status === 'cancelled') {
        throw new ScheduleRuntimeError('publication-cancelled',
          'הפרסום בוטל ולכן יש להתחיל פעולה חדשה.', 'aborted');
      }
      if (existingData.status !== 'staging') preparedReplayInvalid();
    } else await pubRef.create({
      station_id: ctx.sid, status: 'staging', request_id: requestId,
      request_fingerprint: requestFingerprint,
      revision, source_id: draftMeta.source_id, policy_id: draftMeta.policy_id,
      source_draft_id: draftId,
      previous_publication_id: before ? before.pointer.publication_id : null,
      created_at: FV.serverTimestamp(),
      source_snapshot: next.plan.source_snapshot, source_version: next.plan.source_version,
      contract_station_id: next.plan.contract_station_id,
      source_revision: next.plan.source_revision, source_digest: next.plan.source_digest,
      source_complete: true, policy_version: next.plan.policy_version,
      policy_digest: next.plan.policy_digest, generated_at: next.plan.generated_at,
      from: next.plan.from, to: next.plan.to, summary: next.plan.summary,
      content_hash: planned.publication.content_hash,
      published_by: ctx.uid, published_by_name: ctx.name
    });
    await stageSnapshot(pubRef, {}, next.plan, next.events, next.roster);
    const outboxOps = planned.notifications.map((notification) => ({
      ref: pubRef.collection('schedule_outbox').doc('n_' + hash(notification.dedupe_key).slice(0, 40)),
      kind: 'set',
      data: {
        station_id: ctx.sid, publication_id: pubId, revision,
        person: notification.person, dedupe_key: notification.dedupe_key,
        push: notification.push, detail: notification.detail,
        changed_by: ctx.uid, attempt: 0, status: 'blocked',
        expires_at: new Date(Date.parse(clock()) + OUTBOX_TTL_MS),
        created_at: FV.serverTimestamp()
      }
    }));
    await commitWrites(outboxOps);
    await beforeSnapshotFinalize({ kind: 'publication', ref: pubRef, ctx });
    try {
      await db.runTransaction(async (tx) => {
      const policyRef = stationRef(ctx.sid).collection('schedule_policies').doc(draftMeta.policy_id);
      const sourceRef = stationRef(ctx.sid).collection('schedule_sources').doc(draftMeta.source_id);
      const refs = [runtimeRef(ctx.sid), activeRef(ctx.sid), draftRef, pubRef, policyRef, sourceRef,
        liveUserRef(ctx.sid, ctx.uid), scheduleAccessRef(ctx.sid, ctx.uid)];
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const liveConfig = snaps[0].exists ? (snaps[0].data() || {}) : {};
      const liveActive = snaps[1].exists ? (snaps[1].data() || {}) : {};
      const liveDraft = snaps[2].exists ? (snaps[2].data() || {}) : {};
      const livePub = snaps[3].exists ? (snaps[3].data() || {}) : {};
      const livePolicy = snaps[4].exists ? (snaps[4].data() || {}) : {};
      const liveSource = snaps[5].exists ? (snaps[5].data() || {}) : {};
      requireLiveManager(snaps[6], snaps[7], ctx);
      /* ⭐ המצב נבדק מול מה שתוכנן, ולא מול „אחד משניים". תחנה
       * שעברה ל-new באמצע הכנה תקבל פרסום מוכן שנכתב עבור shadow —
       * ולהפך. שניהם שגויים, ושניהם נחסמים כאן. */
      if (liveConfig.mode !== config.mode || liveConfig.active_source_id !== draftMeta.source_id
          || liveConfig.active_policy_id !== draftMeta.policy_id) {
        throw new ScheduleRuntimeError('publish-config-changed', 'הגדרות הסידור השתנו בזמן הפרסום.', 'aborted');
      }
      const actualPrevious = nonEmpty(liveActive.publication_id) ? liveActive.publication_id : null;
      if (actualPrevious !== expectedPrevious || Number(liveActive.revision || 0) !== revision - 1) {
        throw new ScheduleRuntimeError('publish-race', 'פורסם סידור אחר במקביל. יש לרענן.', 'aborted');
      }
      if (liveConfig.mode !== config.mode) {
        throw new ScheduleRuntimeError('publish-config-changed',
          'מצב המנוע השתנה בזמן הפרסום.', 'aborted');
      }
      if (liveDraft.status !== 'complete' || livePub.status !== 'staging'
          || livePub.snapshot_complete !== true
          || liveDraft.content_digest !== expectedContentDigest
          || livePub.content_digest !== expectedContentDigest
          || livePub.content_digest !== draftMeta.content_digest) {
        throw new ScheduleRuntimeError('publish-snapshot-changed', 'הטיוטה או הפרסום אינם שלמים.', 'aborted');
      }
      if (livePolicy.complete !== true || liveSource.complete !== true
          || livePolicy.content_digest !== draftMeta.base_policy_digest
          || liveSource.content_digest !== draftMeta.base_source_digest) {
        throw new ScheduleRuntimeError('publish-source-changed',
          'המדיניות או מקור הנתונים השתנו בזמן הפרסום.', 'aborted');
      }
      if (preparing) {
        /* ⭐ מוכן, ולא פעיל. המצביע אינו זז, ה-outbox נשאר `blocked`,
         * ואיש אינו מקבל הודעה. כל אלה קורים יחד ב-`promoteToNew`. */
        tx.update(pubRef, {
          status: 'prepared', prepared_at: FV.serverTimestamp(),
          // ⭐ B · המניפסט של התור, באותה עסקה עם הסימון „מוכן".
          outbox_manifest: outboxManifestFor(planned.notifications)
        });
        tx.create(stationRef(ctx.sid).collection('schedule_audit').doc('a_' + randomId()), {
          action: 'prepare', publication_id: pubId, revision,
          previous_publication_id: expectedPrevious, by: ctx.uid,
          at: FV.serverTimestamp()
        });
        return;
      }
      tx.update(pubRef, { status: 'active', activated_at: FV.serverTimestamp() });
      tx.set(activeRef(ctx.sid), {
        publication_id: pubId, revision, previous_publication_id: expectedPrevious,
        content_digest: livePub.content_digest, activated_at: FV.serverTimestamp(),
        activated_by: ctx.uid
      });
      tx.create(stationRef(ctx.sid).collection('schedule_audit').doc('a_' + randomId()), {
        action: 'publish', publication_id: pubId, revision,
        previous_publication_id: expectedPrevious, by: ctx.uid,
        at: FV.serverTimestamp()
      });
      });
    } catch (error) {
      if (isManagerRevoked(error)) await cancelStagedSnapshot(pubRef, 'manager-revoked');
      throw error;
    }
    /* ⭐ ה-outbox משתחרר רק כשהפרסום באמת פעיל. הכנה שמודיעה היא
     * הודעה על סידור שאיש עדיין אינו רואה. */
    if (!preparing) await releaseOutbox(pubRef);
    return {
      duplicate: false,
      prepared: preparing,
      publication_id: pubId,
      revision,
      notified_people: preparing ? 0 : planned.notifications.length,
      blocked_notifications: preparing ? planned.notifications.length : 0,
      summary: next.plan.summary
    };
  }

  async function rollback(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const config = await configuration(ctx.sid);
    requireMode(config, [MODE.NEW]);
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const expectedActive = requireId(data.expected_active_publication_id,
      'active-publication-id', 'מזהה הפרסום הפעיל');
    const targetId = requireId(data.target_publication_id,
      'target-publication-id', 'מזהה גרסת היעד');
    const reasonCode = String(data.reason_code || '');
    if (ROLLBACK_REASONS.indexOf(reasonCode) === -1) {
      throw new ScheduleRuntimeError('rollback-reason-invalid',
        'יש לבחור סיבה תקינה לחזרה.', 'invalid-argument');
    }

    const pubId = 'p_rb_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const pubRef = stationRef(ctx.sid).collection('schedule_publications').doc(pubId);
    const firstPair = await Promise.all([pubRef.get(), activeRef(ctx.sid).get()]);
    const firstPub = firstPair[0].exists ? (firstPair[0].data() || {}) : {};
    const firstActive = firstPair[1].exists ? (firstPair[1].data() || {}) : {};
    if (firstPair[0].exists && firstActive.publication_id === pubId
        && firstPub.request_id === requestId && firstPub.published_by === ctx.uid
        && firstPub.rollback_from_publication_id === expectedActive
        && firstPub.rollback_target_publication_id === targetId
        && firstPub.rollback_reason_code === reasonCode) {
      await requireLiveManagerNow(ctx);
      await releaseOutbox(pubRef);
      return { duplicate: true, publication_id: pubId, revision: firstActive.revision };
    }

    const current = await activeSnapshot(ctx);
    if (!current || current.pointer.publication_id !== expectedActive) {
      throw new ScheduleRuntimeError('rollback-race',
        'הסידור הפעיל השתנה. יש לרענן לפני החזרה.', 'aborted');
    }
    if (current.pointer.previous_publication_id !== targetId) {
      throw new ScheduleRuntimeError('rollback-target-forbidden',
        'אפשר לחזור רק לגרסה הקודמת המיידית.', 'failed-precondition');
    }
    const target = await publishedSnapshot(ctx, targetId);
    const revision = Number(current.pointer.revision || 0) + 1;
    const publication = createPublication({
      clock, hash, rules: { max_attempts: 3, retry_backoff_ms: [60000, 300000] }
    });
    const service = serviceFor(ctx, null, publication);
    const planned = service.publish({
      actor: actor(ctx),
      request: {
        next: target.plan,
        previous: current.plan,
        next_events: target.events,
        previous_events: current.events,
        publication_id: pubId,
        publication_revision: revision,
        source_draft_id: 'rollback_' + targetId,
        previous_publication_id: expectedActive
      }
    });
    const requestFingerprint = digest({
      station_id: ctx.sid, uid: ctx.uid, request_id: requestId,
      expected_active_publication_id: expectedActive,
      target_publication_id: targetId,
      target_content_digest: target.meta.content_digest,
      next_revision: revision, reason_code: reasonCode
    });
    const existing = await pubRef.get();
    if (existing.exists) {
      const existingData = existing.data() || {};
      const active = await activeRef(ctx.sid).get();
      if (active.exists && (active.data() || {}).publication_id === pubId
          && existingData.request_fingerprint === requestFingerprint) {
        await requireLiveManagerNow(ctx);
        await releaseOutbox(pubRef);
        return { duplicate: true, publication_id: pubId, revision: (active.data() || {}).revision };
      }
      if (existingData.request_fingerprint !== requestFingerprint) {
        throw new ScheduleRuntimeError('rollback-conflict',
          'מזהה החזרה כבר שימש לפעולה אחרת.', 'already-exists');
      }
      if (existingData.status === 'cancelled') {
        throw new ScheduleRuntimeError('rollback-cancelled',
          'החזרה זו בוטלה ולכן יש להתחיל פעולה חדשה.', 'aborted');
      }
    } else {
      await pubRef.create({
        station_id: ctx.sid, status: 'staging', operation: 'rollback',
        request_id: requestId, request_fingerprint: requestFingerprint,
        revision, source_id: target.meta.source_id || null,
        policy_id: target.meta.policy_id || null,
        source_draft_id: 'rollback_' + targetId,
        previous_publication_id: expectedActive,
        rollback_from_publication_id: expectedActive,
        rollback_target_publication_id: targetId,
        rollback_reason_code: reasonCode,
        created_at: FV.serverTimestamp(),
        source_snapshot: target.plan.source_snapshot,
        source_version: target.plan.source_version,
        contract_station_id: target.plan.contract_station_id,
        source_revision: target.plan.source_revision,
        source_digest: target.plan.source_digest,
        source_complete: true,
        policy_version: target.plan.policy_version,
        policy_digest: target.plan.policy_digest,
        generated_at: target.plan.generated_at,
        from: target.plan.from, to: target.plan.to,
        summary: target.plan.summary,
        content_hash: planned.publication.content_hash,
        published_by: ctx.uid, published_by_name: ctx.name
      });
    }
    await stageSnapshot(pubRef, {}, target.plan, target.events, target.roster);
    const outboxOps = planned.notifications.map((notification) => ({
      ref: pubRef.collection('schedule_outbox').doc('n_' + hash(notification.dedupe_key).slice(0, 40)),
      kind: 'set',
      data: {
        station_id: ctx.sid, publication_id: pubId, revision,
        person: notification.person, dedupe_key: notification.dedupe_key,
        push: notification.push, detail: notification.detail,
        changed_by: ctx.uid, attempt: 0, status: 'blocked',
        expires_at: new Date(Date.parse(clock()) + OUTBOX_TTL_MS),
        created_at: FV.serverTimestamp()
      }
    }));
    await commitWrites(outboxOps);
    await beforeSnapshotFinalize({ kind: 'rollback', ref: pubRef, ctx });
    try {
      await db.runTransaction(async (tx) => {
      const refs = [runtimeRef(ctx.sid), activeRef(ctx.sid),
        current.ref, target.ref, pubRef, liveUserRef(ctx.sid, ctx.uid),
        scheduleAccessRef(ctx.sid, ctx.uid)];
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
      const liveConfig = snaps[0].exists ? (snaps[0].data() || {}) : {};
      const liveActive = snaps[1].exists ? (snaps[1].data() || {}) : {};
      const liveCurrent = snaps[2].exists ? (snaps[2].data() || {}) : {};
      const liveTarget = snaps[3].exists ? (snaps[3].data() || {}) : {};
      const livePub = snaps[4].exists ? (snaps[4].data() || {}) : {};
      requireLiveManager(snaps[5], snaps[6], ctx);
      if (liveConfig.mode !== MODE.NEW) {
        throw new ScheduleRuntimeError('rollback-mode-changed',
          'מצב המנוע השתנה בזמן החזרה.', 'aborted');
      }
      if (liveActive.publication_id !== expectedActive
          || Number(liveActive.revision || 0) !== revision - 1
          || liveActive.previous_publication_id !== targetId) {
        throw new ScheduleRuntimeError('rollback-race',
          'הסידור הפעיל השתנה בזמן החזרה.', 'aborted');
      }
      if (liveCurrent.status !== 'active' || liveTarget.status !== 'active'
          || liveTarget.content_digest !== target.meta.content_digest
          || livePub.status !== 'staging' || livePub.snapshot_complete !== true) {
        throw new ScheduleRuntimeError('rollback-snapshot-changed',
          'אחת מתמונות הסידור השתנתה בזמן החזרה.', 'aborted');
      }
      tx.update(pubRef, { status: 'active', activated_at: FV.serverTimestamp() });
      tx.set(activeRef(ctx.sid), {
        publication_id: pubId, revision,
        previous_publication_id: expectedActive,
        rollback_target_publication_id: targetId,
        content_digest: livePub.content_digest,
        activated_at: FV.serverTimestamp(), activated_by: ctx.uid
      });
      tx.create(stationRef(ctx.sid).collection('schedule_audit').doc('a_' + randomId()), {
        action: 'rollback', publication_id: pubId, revision,
        from_publication_id: expectedActive,
        target_publication_id: targetId,
        reason_code: reasonCode, by: ctx.uid, at: FV.serverTimestamp()
      });
      });
    } catch (error) {
      if (isManagerRevoked(error)) await cancelStagedSnapshot(pubRef, 'manager-revoked');
      throw error;
    }
    await releaseOutbox(pubRef);
    return {
      duplicate: false, publication_id: pubId, revision,
      rolled_back_to: targetId, notified_people: planned.notifications.length
    };
  }

  function requestedViewDate(req, fallback) {
    const data = req && req.data === undefined ? {} : (req && req.data);
    if (!plain(data) || Object.keys(data).some((key) => key !== 'date')) {
      throw new ScheduleRuntimeError('schedule-view-input',
        'תצוגת הסידור מקבלת תאריך בלבד.', 'invalid-argument');
    }
    const value = Object.prototype.hasOwnProperty.call(data, 'date') ? String(data.date || '') : fallback;
    return isoDayOffset(value, 0);
  }

  // The legacy guard screens used to read the entire raw collection.  The
  // replacement callables accept one explicit, bounded calendar range.  They
  // never derive a default range from the server clock: an omitted boundary
  // must be an error rather than an accidental full-history read.
  function requestedGuardBoardRange(req) {
    const data = req && req.data === undefined ? {} : (req && req.data);
    if (!plain(data) || Object.keys(data).some((key) => key !== 'from' && key !== 'to')) {
      throw new ScheduleRuntimeError('guard-board-input',
        'תצוגת האבטחות מקבלת התחלה וסיום בלבד.', 'invalid-argument');
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'from')
        || !Object.prototype.hasOwnProperty.call(data, 'to')) {
      throw new ScheduleRuntimeError('guard-board-input',
        'חובה לבחור התחלה וסיום לתצוגת האבטחות.', 'invalid-argument');
    }
    const from = isoDayOffset(String(data.from || ''), 0);
    const to = isoDayOffset(String(data.to || ''), 0);
    if (from > to) {
      throw new ScheduleRuntimeError('guard-board-range',
        'תאריך ההתחלה של האבטחות חייב להיות לפני תאריך הסיום.', 'invalid-argument');
    }
    const dates = [];
    let cursor = from;
    while (cursor <= to) {
      dates.push(cursor);
      if (dates.length > MAX_GUARD_BOARD_DAYS) {
        throw new ScheduleRuntimeError('guard-board-range',
          'טווח האבטחות גדול מהתקרה הבטוחה לתצוגה.', 'invalid-argument');
      }
      cursor = isoDayOffset(cursor, 1);
    }
    return Object.freeze({ from, to, dates: Object.freeze(dates) });
  }

  function dateChunks(dates) {
    const chunks = [];
    for (let index = 0; index < dates.length; index += LEGACY_IN_QUERY_SIZE) {
      chunks.push(dates.slice(index, index + LEGACY_IN_QUERY_SIZE));
    }
    return chunks;
  }

  // Copy only the fields that a projection is permitted to inspect.  The raw
  // Firestore document also carries audit data, assignment epochs and future
  // operational fields; none of those should even enter the projection
  // boundary by accident.
  function guardBoardSignups(value) {
    if (!plain(value)) return value;
    const result = {};
    Object.keys(value).sort(compareCanonical).forEach((uid) => {
      const item = plain(value[uid]) ? value[uid] : {};
      result[uid] = { name: item.name, crew: item.crew };
    });
    return result;
  }

  function guardBoardCandidate(doc, sid) {
    if (!doc || !doc.exists || typeof doc.id !== 'string' || !ID_RE.test(doc.id)) return null;
    const value = doc.data() || {};
    if (!plain(value)) return null;
    return Object.freeze({
      id: doc.id,
      // `guard-board-projection` deliberately receives the same `{id,value}`
      // envelope as a Firestore document, but `value` itself is an explicit
      // allow-list copy rather than `doc.data()`.
      value: Object.freeze({
        stationId: value.stationId,
        station_id: value.station_id,
        station: value.station,
        title: value.title,
        kind: value.kind,
        place: value.place,
        date: value.date,
        start: value.start,
        end: value.end,
        // Historical guard documents predate the explicit state field.  The
        // writer has always treated that omission as an open guard, so preserve
        // it here instead of making old valid work silently disappear.
        status: value.status === undefined ? 'open' : value.status,
        slots: value.slots,
        need_quals: value.need_quals,
        notes: value.notes,
        revision: value.revision,
        assigned: Array.isArray(value.assigned) ? value.assigned.slice() : value.assigned,
        signups: guardBoardSignups(value.signups)
      })
    });
  }

  function guardBoardMembers(docs, ctx) {
    // Assignment writes are validated against the live `users` collection,
    // not the older planning `roster`.  The same authority must drive the
    // reader, otherwise a legitimate assignee can disappear from an open
    // guard solely because a roster sync is late.
    const members = (Array.isArray(docs) ? docs : []).map((doc) => {
      const user = doc && typeof doc.data === 'function' ? (doc.data() || {}) : {};
      return {
        uid: doc && doc.id,
        active: scheduleAccess.activeMember(user, ctx.sid),
        is_active: scheduleAccess.activeMember(user, ctx.sid)
      };
    });
    // `context` already verified this account against its live user document.
    // Preserve that fact even if a just-created document is absent from a
    // collection query's eventual local cache.
    if (!members.some((person) => person.uid === ctx.uid && person.active === true)) {
      members.push({ uid: ctx.uid, active: true, is_active: true });
    }
    return members;
  }

  async function readGuardBoardInput(ctx, range) {
    const root = stationRef(ctx.sid);
    try {
      // A single bounded range query avoids issuing thirteen parallel `in`
      // queries for a year-long board and stops at the global guard cap
      // before Firestore can read thousands of documents that the caller will
      // not be permitted to receive anyway.
      const reads = await Promise.all([
        root.collection('users').limit(MAX_LEGACY_ROSTER + 1).get(),
        root.collection('guards')
          .where('date', '>=', range.from)
          .where('date', '<=', range.to)
          .orderBy('date')
          .limit(MAX_LEGACY_GUARDS + 1).get()
      ]);
      if (reads[0].size > MAX_LEGACY_ROSTER) {
        throw new ScheduleRuntimeError('guard-board-users-too-large',
          'רשימת המשתמשים הפעילים גדולה מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      const guardDocs = boundedGuardDocuments([reads[1]]);
      const guards = Array.from(guardDocs.values()).sort((left, right) =>
        compareCanonical(left.id, right.id)).map((doc) => guardBoardCandidate(doc, ctx.sid)).filter(Boolean);
      return Object.freeze({
        station_id: ctx.sid,
        dates: range.dates,
        roster: Object.freeze(guardBoardMembers(reads[0].docs, ctx)),
        guards: Object.freeze(guards),
        viewer_uid: ctx.uid
      });
    } catch (error) {
      if (error instanceof ScheduleRuntimeError) throw error;
      throw new ScheduleRuntimeError('guard-board-unavailable',
        'לא הצלחנו לקרוא את האבטחות כרגע. אפשר לנסות שוב.', 'unavailable');
    }
  }

  // A guard document contains operational notes and audit data that have no
  // place in the schedule.  This bridge reads only the fields required to
  // validate a safe projection; it always creates a new object before the
  // pure guard module sees it.
  function legacyGuardCandidate(doc, sid) {
    if (!doc || !doc.exists || typeof doc.id !== 'string' || !ID_RE.test(doc.id)) return null;
    const value = doc.data() || {};
    if (!plain(value)) return null;
    for (const key of ['stationId', 'station_id', 'station']) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== ''
          && value[key] !== sid) return null;
    }
    const assignedRaw = value.assigned === undefined || value.assigned === null ? [] : value.assigned;
    if (!Array.isArray(assignedRaw) || assignedRaw.length > MAX_LEGACY_GUARD_ASSIGNED
        || !Number.isSafeInteger(value.slots) || value.slots < 1
        || value.slots > MAX_LEGACY_GUARD_ASSIGNED) return null;
    const assigned = new Set();
    for (const uid of assignedRaw) {
      if (typeof uid !== 'string' || !AUTH_UID_RE.test(uid)) return null;
      assigned.add(uid);
    }
    // The server assignment path writes a unique set.  Historical duplicates
    // are collapsed before this check so a harmless repeated value never
    // makes a still-open guard disappear, while over-capacity data does.
    if (assigned.size > value.slots) return null;
    return Object.freeze({
      id: doc.id,
      date: value.date,
      title: value.title,
      start: value.start,
      end: value.end,
      status: value.status,
      assigned: Object.freeze(Array.from(assigned).sort(compareCanonical))
    });
  }

  function legacyGuardRoster(roster) {
    return (Array.isArray(roster) ? roster : []).map((person) => ({
      uid: person && person.id,
      active: person && person.active,
      is_active: person && person.is_active
    }));
  }

  function legacyGuardPeople(roster) {
    const people = new Map();
    (Array.isArray(roster) ? roster : []).forEach((person) => {
      if (!plain(person) || typeof person.id !== 'string' || !AUTH_UID_RE.test(person.id)) return;
      if (person.active === false || person.is_active === false) return;
      let display = person.id;
      for (const key of ['full_name', 'name']) {
        const value = person[key];
        if (typeof value !== 'string') continue;
        const normalized = value.trim();
        if (normalized && normalized.length <= 120 && !CONTROL_RE.test(normalized)) {
          display = normalized;
          break;
        }
      }
      people.set(person.id, Object.freeze({ uid: person.id, display }));
    });
    return people;
  }

  function legacyGuardEvents(guardDocs, range, roster, sid) {
    const guards = Array.from(guardDocs.values())
      .sort((left, right) => compareCanonical(left.id, right.id))
      .map((doc) => legacyGuardCandidate(doc, sid))
      .filter(Boolean);
    const projected = guardEvents.stationGuardEvents({
      guards,
      dates: range.dates,
      roster: legacyGuardRoster(roster),
      station_id: sid
    }).events;
    const knownPeople = legacyGuardPeople(roster);
    return projected.map((event) => Object.freeze({
      id: event.id,
      date: event.date,
      title: event.title,
      start: event.start,
      end: event.end,
      status: event.status,
      people: Object.freeze(event.people.map((uid) => knownPeople.get(uid)).filter(Boolean))
    }));
  }

  function legacyRosterProjection(docs, sid) {
    return (Array.isArray(docs) ? docs : []).map((doc) => {
      const value = doc && typeof doc.data === 'function' ? (doc.data() || {}) : {};
      // The collection path is the authority for station scope.  A conflicting
      // embedded station is corrupted data, never permission to reinterpret
      // this person as a member of another station.
      for (const key of ['stationId', 'station_id', 'station']) {
        if (value[key] !== undefined && value[key] !== null && value[key] !== ''
            && value[key] !== sid) {
          throw new ScheduleRuntimeError('legacy-roster-station',
            'נתוני הסידור מכילים שיוך תחנה סותר.', 'failed-precondition');
        }
      }
      return {
        id: doc && doc.id,
        station_id: sid,
        full_name: value.full_name,
        name: value.name,
        crew: value.crew,
        active: value.active,
        is_active: value.is_active
      };
    });
  }

  function boundedGuardDocuments(snapshots) {
    const guardDocs = new Map();
    (Array.isArray(snapshots) ? snapshots : []).forEach((snap) => {
      if (!snap || snap.size > MAX_LEGACY_GUARDS_PER_QUERY) {
        throw new ScheduleRuntimeError('legacy-guards-too-large',
          'אבטחות הסידור בטווח גדולות מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      (snap.docs || []).forEach((doc) => guardDocs.set(doc.id, doc));
    });
    if (guardDocs.size > MAX_LEGACY_GUARDS) {
      throw new ScheduleRuntimeError('legacy-guards-too-large',
        'אבטחות הסידור בטווח גדולות מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
    }
    return guardDocs;
  }

  async function readLiveGuardProjection(ctx, dates) {
    const requestedDates = Array.isArray(dates) ? dates.slice() : [];
    if (!requestedDates.length || requestedDates.some((value) => !DATE_RE.test(value))) {
      return Object.freeze({ status: 'unavailable', events: Object.freeze([]) });
    }
    const root = stationRef(ctx.sid);
    try {
      const chunks = dateChunks(requestedDates);
      const reads = await Promise.all([
        root.collection('roster').limit(MAX_LEGACY_ROSTER + 1).get(),
        Promise.all(chunks.map((chunk) => root.collection('guards')
          .where('date', 'in', chunk).limit(MAX_LEGACY_GUARDS_PER_QUERY + 1).get()))
      ]);
      if (reads[0].size > MAX_LEGACY_ROSTER) {
        throw new ScheduleRuntimeError('legacy-roster-too-large',
          'רשימת הסגל הקיימת גדולה מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      const guardDocs = boundedGuardDocuments(reads[1]);
      const roster = legacyRosterProjection(reads[0].docs, ctx.sid);
      return Object.freeze({
        status: 'ready',
        events: Object.freeze(legacyGuardEvents(guardDocs, { dates: requestedDates }, roster, ctx.sid))
      });
    } catch (error) {
      // Guards are live, operational sidecar data.  A read or cap failure must
      // never turn a verified published schedule into a blank schedule, and
      // must never be rendered as if there were simply no guards.
      return Object.freeze({ status: 'unavailable', events: Object.freeze([]) });
    }
  }

  /* ⭐ A (seq379). כל הקריאות עוברות דרך `reader`, כדי שאותה
   * השלכה בדיוק תרוץ גם **בתוך** טרנזקציה: `dbReader` מחוץ לעסקה,
   * `txReader(tx)` בתוכה. הקריאות תחומות (roster/rotations בתקרה,
   * overrides לפי מזהה יום, swaps/guards ב-`in` על ≤31 ימים) — לא סריקה. */
  function dbReader() {
    return {
      get: (target) => target.get(),
      getAll: (refs) => (refs.length ? db.getAll.apply(db, refs) : Promise.resolve([]))
    };
  }
  function txReader(tx) {
    return {
      get: (target) => tx.get(target),
      getAll: (refs) => (refs.length ? tx.getAll.apply(tx, refs) : Promise.resolve([]))
    };
  }

  async function legacyProjectionInput(ctx, range, readerArg, pinnedBasis) {
    const reader = readerArg || dbReader();
    /* ⭐ `pinnedBasis` (417 §2): קריאה אחת של סגל+מחזורים משמשת את כל
     * החלונות של אותה קריאה, ובסופה נבדק שהבסיס לא השתנה. בלי זה שני
     * חלונות יכלו להיות מוקרנים משני עוגנים שונים — תשובה מעורבת. */
    const pinned = pinnedBasis && Array.isArray(pinnedBasis.rosterDocs) && Array.isArray(pinnedBasis.rotationDocs)
      ? pinnedBasis : null;
    const dates = range && Array.isArray(range.dates) ? range.dates.slice() : [];
    if (!dates.length || dates.some((value) => !DATE_RE.test(value))) {
      throw new ScheduleRuntimeError('legacy-range-invalid',
        'טווח הסידור הקיים אינו תקין.', 'invalid-argument');
    }
    const root = stationRef(ctx.sid);
    try {
      const chunks = dateChunks(dates);
      const overrideRefs = dates.map((date) => root.collection('shift_overrides').doc(date));
      const reads = await Promise.all([
        pinned ? { size: pinned.rosterDocs.length, docs: pinned.rosterDocs }
          : reader.get(root.collection('roster').limit(MAX_LEGACY_ROSTER + 1)),
        pinned ? { size: pinned.rotationDocs.length, docs: pinned.rotationDocs }
          : reader.get(root.collection('rotations').limit(MAX_LEGACY_ROTATIONS + 1)),
        reader.getAll(overrideRefs),
        Promise.all(chunks.map((chunk) => reader.get(root.collection('swaps')
          .where('from_date', 'in', chunk).limit(MAX_LEGACY_SWAPS_PER_QUERY + 1)))),
        Promise.all(chunks.map((chunk) => reader.get(root.collection('swaps')
          .where('to_date', 'in', chunk).limit(MAX_LEGACY_SWAPS_PER_QUERY + 1)))),
        Promise.all(chunks.map((chunk) => reader.get(root.collection('guards')
          .where('date', 'in', chunk).limit(MAX_LEGACY_GUARDS_PER_QUERY + 1))))
      ]);
      if (reads[0].size > MAX_LEGACY_ROSTER) {
        throw new ScheduleRuntimeError('legacy-roster-too-large',
          'רשימת הסגל הקיימת גדולה מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      if (reads[1].size > MAX_LEGACY_ROTATIONS) {
        throw new ScheduleRuntimeError('legacy-rotations-too-large',
          'מחזורי הסידור הקיימים גדולים מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      const overrideDocs = new Map();
      reads[2].filter((doc) => doc && doc.exists).forEach((doc) => overrideDocs.set(doc.id, doc));
      if (overrideDocs.size > MAX_LEGACY_OVERRIDES) {
        throw new ScheduleRuntimeError('legacy-overrides-too-large',
          'חריגי הסידור בטווח גדולים מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      const swapDocs = new Map();
      reads[3].concat(reads[4]).forEach((snap) => {
        if (snap.size > MAX_LEGACY_SWAPS_PER_QUERY) {
          throw new ScheduleRuntimeError('legacy-swaps-too-large',
            'החלפות הסידור בטווח גדולות מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
        }
        snap.docs.forEach((doc) => swapDocs.set(doc.id, doc));
      });
      if (swapDocs.size > MAX_LEGACY_SWAPS) {
        throw new ScheduleRuntimeError('legacy-swaps-too-large',
          'החלפות הסידור בטווח גדולות מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      const guardDocs = boundedGuardDocuments(reads[5]);
      const roster = legacyRosterProjection(reads[0].docs, ctx.sid);
      const overrides = {};
      Array.from(overrideDocs.values()).sort((left, right) => compareCanonical(left.id, right.id))
        .forEach((doc) => {
          const value = doc.data() || {};
          if (value.date !== undefined && value.date !== null && value.date !== ''
              && value.date !== doc.id) {
            throw new ScheduleRuntimeError('legacy-override-date',
              'חריג סידור מכיל תאריך סותר ולכן אינו מוצג.', 'failed-precondition');
          }
          // The historic schedule uses the document id as its only effective
          // date.  Normalize it explicitly so a stale payload field cannot
          // move an override into another day inside the projection.
          overrides[doc.id] = Object.assign({}, value, { date: doc.id });
        });
      return {
        station_id: ctx.sid,
        roster,
        events: legacyGuardEvents(guardDocs, range, roster, ctx.sid),
        legacy: {
          rotations: reads[1].docs.map((doc) => doc.data() || {}),
          overrides,
          // A bounded equality query can return the same swap through either
          // endpoint.  Deduplicate by canonical document id and restore the
          // legacy collection's document-id order before projection, because
          // personWorks applies the first matching approved swap.
          swaps: Array.from(swapDocs.values()).sort((left, right) =>
            compareCanonical(left.id, right.id)).map((doc) => doc.data() || {})
        }
      };
    } catch (error) {
      if (error instanceof ScheduleRuntimeError) throw error;
      throw new ScheduleRuntimeError('legacy-schedule-unavailable',
        'לא ניתן לקרוא את הסידור הקיים בבטחה.', 'unavailable');
    }
  }

  function requestedLegacyCompatibilityRange(req) {
    try {
      return legacyCompatibility.parseLegacyCompatibilityRange(req && req.data);
    } catch (error) {
      if (error instanceof legacyCompatibility.LegacyScheduleCompatibilityError) {
        throw new ScheduleRuntimeError(error.code,
          'קריאת התאימות מקבלת טווח תאריכים תקין בלבד.', 'invalid-argument');
      }
      throw error;
    }
  }

  function requireLiveCompatibilityViewer(userSnap, ctx) {
    const user = userSnap && userSnap.exists ? (userSnap.data() || {}) : null;
    const role = String(user && user.role || '');
    if (!scheduleAccess.activeMember(user, ctx.sid)
        || (!ctx.super && (MEMBER_ROLES.indexOf(role) === -1 || role !== ctx.role))) {
      throw new ScheduleRuntimeError('legacy-compatibility-viewer-changed',
        'השיוך החי לתחנה השתנה בזמן הקריאה.', 'permission-denied');
    }
  }

  async function getLegacyCompatibility(req) {
    const ctx = await context(req);
    const range = requestedLegacyCompatibilityRange(req);
    const before = await configuration(ctx.sid);
    if (before.mode === MODE.NEW) {
      throw new ScheduleRuntimeError('legacy-compatibility-mode',
        'תצוגת התאימות אינה זמינה לאחר הפעלת המנוע החדש.', 'failed-precondition');
    }
    const root = stationRef(ctx.sid);
    try {
      const reads = await Promise.all([
        root.collection('rotations').limit(legacyCompatibility.MAX_ROTATIONS + 1).get(),
        root.collection('shift_overrides')
          .orderBy(FieldPath.documentId()).startAt(range.from).endAt(range.to)
          .limit(legacyCompatibility.MAX_OVERRIDES + 1).get()
      ]);
      if (reads[0].size > legacyCompatibility.MAX_ROTATIONS) {
        throw new ScheduleRuntimeError('legacy-rotations-too-large',
          'מחזורי הסידור הקיימים גדולים מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      if (reads[1].size > legacyCompatibility.MAX_OVERRIDES) {
        throw new ScheduleRuntimeError('legacy-overrides-too-large',
          'חריגי הסידור הקיימים גדולים מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
      }
      const projected = legacyCompatibility.projectLegacyScheduleCompatibility({
        mode: before.mode,
        rotations: reads[0].docs.map((doc) => ({ id: doc.id, value: doc.data() || {} })),
        overrides: reads[1].docs.map((doc) => ({ id: doc.id, value: doc.data() || {} }))
      });

      // Close both races independently: a station transfer/revocation and a
      // switch to the new engine can happen while the bounded reads are in
      // flight.  Neither may return a stale legacy snapshot.
      await beforeEffectiveViewRecheck({ kind: 'legacy-compatibility', ctx, mode: before.mode });
      const finalReads = await Promise.all([
        configuration(ctx.sid),
        liveUserRef(ctx.sid, ctx.uid).get()
      ]);
      if (finalReads[0].mode !== before.mode || finalReads[0].mode === MODE.NEW) {
        throw new ScheduleRuntimeError('schedule-mode-changed',
          'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
      }
      requireLiveCompatibilityViewer(finalReads[1], ctx);
      return projected;
    } catch (error) {
      if (error instanceof ScheduleRuntimeError) throw error;
      if (error instanceof legacyCompatibility.LegacyScheduleCompatibilityError) {
        throw new ScheduleRuntimeError(error.code, 'נתוני הסידור הקיים אינם תקינים.',
          error.code.endsWith('-too-large') ? 'resource-exhausted' : 'failed-precondition');
      }
      reportRuntimeError('legacy-compatibility-unexpected');
      throw new ScheduleRuntimeError('legacy-compatibility-unavailable',
        'לא ניתן לקרוא את נתוני הסידור הקיים בבטחה.', 'unavailable');
    }
  }

  function effectiveReaderFor(ctx, scoped) {
    const inTx = scoped && scoped.tx ? scoped.tx : null;
    /* ⭐ `snapshot`: תמונת פרסום אחת שכבר נקראה ואומתה, שכל החלונות של
     * קריאה אחת מוקרנים ממנה — ולא קריאה חדשה לכל חלון. זהות התמונה
     * נבדקת שוב בסוף ב-`activeSnapshotStillCurrent`.
     *
     * ⭐ `legacyOnly` (400(3)): המתאם הטהור הוא גבול קשיח — במצב `new`
     * הוא דורש פרסום פעיל ונופל על `active-publication-missing`. לכן
     * ה-fallback המפורש ל-legacy (המקרה „new בלי פרסום פעיל" שההערה
     * ליד legacyFallbackWindow מבטיחה) לא יכול לעבור דרכו כמות שהוא:
     * כאן המתאם מקבל mode של legacy, והקורא שביקש את זה אחראי לבדוק
     * שוב, אחרי הקריאה, שאין פרסום פעיל ושהמצב לא השתנה. */
    const pinned = scoped && scoped.snapshot ? scoped.snapshot : null;
    const legacyOnly = !!(scoped && scoped.legacyOnly);
    const legacyBasis = scoped && scoped.legacyBasis ? scoped.legacyBasis : null;
    const system = ctx.system === true;
    return effectiveReaderModule.createScheduleEffectiveReader({
      resolveLiveContext: async function () {
        // הקשר שרת מפורש (ללא uid) — לחישובים שאין מאחוריהם אדם. המתאם
        // הטהור מקבל אותו רק ל-getStation, לעולם לא ל-getMy.
        return system
          ? { station_id: ctx.sid, system: true, active: true }
          : { station_id: ctx.sid, uid: ctx.uid, active: true };
      },
      readRuntime: async function () {
        if (legacyOnly) return { mode: MODE.SHADOW };
        if (inTx) {
          const snap = await inTx.get(runtimeRef(ctx.sid));
          const data = snap.exists ? (snap.data() || {}) : {};
          return { mode: MODES.indexOf(data.mode) !== -1 ? data.mode : MODE.OFF };
        }
        return { mode: (await configuration(ctx.sid)).mode };
      },
      readLegacy: async function (liveCtx, range) {
        if (!liveCtx || liveCtx.station_id !== ctx.sid || liveCtx.uid !== ctx.uid) {
          throw new ScheduleRuntimeError('effective-context-mismatch',
            'הקשר הסידור השתנה ולכן הקריאה נעצרה.', 'aborted');
        }
        return legacyProjectionInput(ctx, range, inTx ? txReader(inTx) : null, legacyBasis);
      },
      readActivePublication: async function (liveCtx) {
        if (inTx) {
          /* בתוך עסקה המתאם משרת רק את ה-legacy (shadow). קריאת
           * הפרסום הפעיל בתוך עסקה אינה חוזה כאן — נופלים סגור. */
          throw new ScheduleRuntimeError('effective-context-mismatch',
            'קריאת פרסום פעיל בתוך עסקה אינה נתמכת.', 'aborted');
        }
        if (!liveCtx || liveCtx.station_id !== ctx.sid || liveCtx.uid !== ctx.uid) {
          throw new ScheduleRuntimeError('effective-context-mismatch',
            'הקשר הסידור השתנה ולכן הקריאה נעצרה.', 'aborted');
        }
        // activeSnapshot always reads and hashes the entire immutable snapshot
        // before this adapter exposes a range to the pure reader.
        const active = pinned || await activeSnapshot(ctx);
        if (!active) return null;
        return {
          pointer: {
            station_id: ctx.sid,
            publication_id: active.ref.id,
            revision: Number(active.pointer.revision),
            content_digest: active.meta.content_digest
          },
          publication: {
            id: active.ref.id,
            publication_id: active.ref.id,
            station_id: active.meta.station_id,
            status: active.meta.status,
            snapshot_complete: active.meta.snapshot_complete === true,
            revision: Number(active.meta.revision),
            content_digest: active.meta.content_digest
          },
          snapshot: {
            publication_id: active.ref.id,
            content_digest: active.meta.content_digest,
            plan: active.plan,
            roster: active.roster
          }
        };
      },
      createOperationalProjection: operationalProjection.createOperationalProjection
    });
  }

  async function effectiveStationWindow(ctx, from, to, scoped) {
    try {
      return await effectiveReaderFor(ctx, scoped).getStation({ data: { from, to } });
    } catch (error) {
      if (error instanceof ScheduleRuntimeError) throw error;
      throw new ScheduleRuntimeError('effective-schedule-invalid',
        'לא ניתן לאמת את הסידור להצגה ולכן הוא לא מוצג.', 'failed-precondition');
    }
  }

  async function checkedLegacyWindow(ctx, config, from, to, scoped) {
    const window = await effectiveStationWindow(ctx, from, to, scoped);
    await beforeEffectiveViewRecheck({ kind: 'legacy', ctx, mode: config.mode });
    const after = await configuration(ctx.sid);
    if (after.mode !== config.mode || window.provenance.mode !== config.mode) {
      throw new ScheduleRuntimeError('schedule-mode-changed',
        'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
    }
    return window;
  }

  async function activeSnapshotStillCurrent(ctx, config, active) {
    const after = await configuration(ctx.sid);
    if (after.mode !== config.mode) {
      throw new ScheduleRuntimeError('schedule-mode-changed',
        'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
    }
    // Publication and rollback update the active pointer without changing the
    // runtime mode.  The response has one linearization point: a final read
    // must still name the exact signed publication read above.
    const pointer = await activeRef(ctx.sid).get();
    const value = pointer.exists ? (pointer.data() || {}) : {};
    const unchanged = active
      ? pointer.exists
        && value.publication_id === active.pointer.publication_id
        && value.revision === active.pointer.revision
        && value.content_digest === active.pointer.content_digest
      : !nonEmpty(value.publication_id);
    if (!unchanged) {
      throw new ScheduleRuntimeError('schedule-active-changed',
        'הסידור הפעיל השתנה בזמן הקריאה. יש לרענן.', 'aborted');
    }
  }

  async function checkedActiveSnapshot(ctx, config, dates) {
    const active = await activeSnapshot(ctx, dates);
    await beforeEffectiveViewRecheck({ kind: 'v2', ctx, mode: config.mode });
    await activeSnapshotStillCurrent(ctx, config, active);
    return active;
  }

  function guardPresentationId(event) {
    // `:` is deliberately outside the immutable source-event id alphabet.
    // This is presentation-only: it can never be mistaken for a published
    // event id by the response endpoint or by publication/outbox logic.
    return 'g:' + event.id;
  }

  function stationGuardsForDate(events, date, viewer) {
    return Object.freeze((Array.isArray(events) ? events : []).filter((event) => event.date === date)
      .map((event) => {
        const people = Object.freeze((event.people || []).map((person) => Object.freeze({
          person: person.display,
          is_me: person.uid === viewer
        })));
        return Object.freeze({
          id: guardPresentationId(event),
          title: event.title,
          hours: event.start + '–' + event.end,
          people,
          includes_me: people.some((person) => person.is_me)
        });
      }));
  }

  function myGuardsForDate(events, date, viewer) {
    return Object.freeze((Array.isArray(events) ? events : []).filter((event) => event.date === date
      && (event.people || []).some((person) => person.uid === viewer)).map((event) => Object.freeze({
      id: guardPresentationId(event),
      title: event.title,
      date: event.date,
      hours: event.start + '–' + event.end
    })));
  }

  function stationViewWithGuards(view, sidecar, date, viewer) {
    const source = sidecar || { status: 'unavailable', events: [] };
    function decorate(block) {
      return Object.freeze(Object.assign({}, block, {
        guards_status: source.status,
        guards: stationGuardsForDate(source.events, block.date, viewer)
      }));
    }
    return Object.freeze(Object.assign({}, view, {
      previous_day: decorate(view.previous_day),
      day: decorate(view.day),
      next_day: decorate(view.next_day)
    }));
  }

  function myViewWithGuards(view, sidecar, date, viewer) {
    const source = sidecar || { status: 'unavailable', events: [] };
    return Object.freeze(Object.assign({}, view, {
      guards_status: source.status,
      guards: myGuardsForDate(source.events, date, viewer)
    }));
  }

  function legacyDayBlock(day, viewer, events) {
    const grouped = new Map();
    (day.assignments || []).forEach((assignment) => {
      const crew = assignment.crew || 'station';
      if (!grouped.has(crew)) grouped.set(crew, []);
      grouped.get(crew).push({
        uid: assignment.uid,
        person: assignment.display,
        role_label: assignment.crew ? 'צוות ' + assignment.crew : null,
        hours: null,
        is_me: assignment.uid === viewer
      });
    });
    return {
      date: day.date,
      sub_stations: Array.from(grouped.keys()).sort().map((crew) => ({
        sub_station: 'legacy_' + crew,
        label: crew === 'station' ? 'תחנה' : 'משמרת ' + crew,
        minimum: null,
        below_minimum: false,
        people: grouped.get(crew).slice().sort((left, right) =>
          compareCanonical(left.uid, right.uid))
      })),
      events: (events || []).filter((event) => event.date === day.date).map((event) => ({
        id: event.id,
        title: event.title,
        hours: event.start + '–' + event.end,
        cancelled: false,
        people: (event.people || []).map((person) => ({
          person: person.display,
          is_me: person.uid === viewer
        })),
        includes_me: (event.people || []).some((person) => person.uid === viewer)
      }))
    };
  }

  function legacyStationView(ctx, window, date) {
    const byDate = new Map((window.days || []).map((day) => [day.date, day]));
    return {
      mode: window.provenance.mode,
      active: true,
      source: 'legacy',
      provenance: window.provenance,
      previous_day: legacyDayBlock(byDate.get(isoDayOffset(date, -1)) || {
        date: isoDayOffset(date, -1), assignments: []
      }, ctx.uid, window.events),
      day: legacyDayBlock(byDate.get(date) || { date, assignments: [] }, ctx.uid, window.events),
      next_day: legacyDayBlock(byDate.get(isoDayOffset(date, 1)) || {
        date: isoDayOffset(date, 1), assignments: []
      }, ctx.uid, window.events)
    };
  }

  function legacyMyView(ctx, window, date) {
    const day = (window.days || []).filter((item) => item.date === date)[0]
      || { date, assignments: [] };
    const mine = (day.assignments || []).filter((assignment) => assignment.uid === ctx.uid);
    return {
      mode: window.provenance.mode,
      active: true,
      source: 'legacy',
      provenance: window.provenance,
      days: mine.map((assignment) => ({
        date,
        sub_station: assignment.crew || 'station',
        sub_station_label: assignment.crew ? 'משמרת ' + assignment.crew : 'תחנה',
        role: null,
        role_label: assignment.crew ? 'צוות ' + assignment.crew : null,
        hours: null,
        shift: assignment.crew ? 'משמרת ' + assignment.crew : null,
        qualifications: [],
        crew: (day.assignments || []).filter((person) => person.uid !== ctx.uid
          && person.crew === assignment.crew).map((person) => ({
          uid: person.uid, person: person.display, role_label: person.crew ? 'צוות ' + person.crew : null
        })),
        change: null,
        answer: null,
        requires_answer: false
      })),
      events: (window.events || []).filter((event) => event.date === date
        && (event.people || []).some((person) => person.uid === ctx.uid)).map((event) => ({
        id: event.id,
        title: event.title,
        date: event.date,
        hours: event.start + '–' + event.end,
        cancelled: false,
        change: null,
        answer: null,
        requires_answer: false
      })),
      pending_answers: 0
    };
  }

  /* ==================================================================
   * ⭐ P0-2 · אין חלון שבו הלוח ריק
   *
   * שלוש תצוגות החזירו `{ active: false, days: [] }` כשהמצב הוא
   * `new` ואין עדיין פרסום פעיל. המשמעות על המסך אינה „אין מידע"
   * אלא **לוח ריק לכל התחנה** — כבאי פותח את הסידור ורואה שאין לו
   * משמרות. במעבר shadow→new שקדם לפרסום, זה בדיוק מה שקרה.
   *
   * המעבר עצמו הוא אטומי (`promoteToNew`), ולכן החלון הזה לא אמור
   * להיפתח. אבל „לא אמור" אינו הגנה: אם המצב הוא `new` ואין תמונה
   * פעילה — מכל סיבה שהיא, כולל rollback או תקלה — הקורא מקבל את
   * ה-legacy **המלא**, ולא ריק.
   *
   * הכלל: legacy מלא או new מלא. לעולם לא ביניים.
   * ================================================================== */
  async function legacyFallbackWindow(ctx, config, from, to, scoped) {
    /* 400(3): עד כאן הפונקציה קראה דרך checkedLegacyWindow, שבמצב `new`
     * מגיע למתאם הטהור ונופל על `active-publication-missing` — כלומר
     * ה-fallback שההערה למעלה מבטיחה מעולם לא עבד: הקורא קיבל שגיאה
     * במקום legacy מלא. עכשיו: legacy נקרא במפורש (`legacyOnly`), ואחרי
     * הקריאה נבדק שוב (א) שהמצב לא השתנה, (ב) שעדיין אין פרסום פעיל —
     * אחרת פרסום שנכנס באמצע היה מוסתר מאחורי תשובת legacy. */
    if (config.mode !== MODE.NEW) return checkedLegacyWindow(ctx, config, from, to, scoped);
    const window = await effectiveStationWindow(ctx, from, to, Object.assign({}, scoped || {}, { legacyOnly: true }));
    await beforeEffectiveViewRecheck({ kind: 'legacy', ctx, mode: config.mode });
    const after = await configuration(ctx.sid);
    const pointer = await activeRef(ctx.sid).get();
    const pointerNow = pointer.exists ? (pointer.data() || {}) : {};
    if (after.mode !== config.mode || window.source !== 'legacy' || nonEmpty(pointerNow.publication_id)) {
      throw new ScheduleRuntimeError('schedule-mode-changed',
        'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
    }
    return Object.freeze(Object.assign({}, window, {
      provenance: Object.freeze(Object.assign({}, window.provenance, { mode: config.mode, fallback: 'legacy' }))
    }));
  }

  async function getMy(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const date = requestedViewDate(req, clock().slice(0, 10));
    if (config.mode !== MODE.NEW) {
      const window = await checkedLegacyWindow(ctx, config, date, date);
      if (window.source !== 'legacy') {
        throw new ScheduleRuntimeError('schedule-mode-changed',
          'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
      }
      return legacyMyView(ctx, window, date);
    }
    const active = await checkedActiveSnapshot(ctx, config, [date]);
    if (!active) {
      const window = await legacyFallbackWindow(ctx, config, date, date);
      return Object.assign(legacyMyView(ctx, window, date),
        { mode: config.mode, fallback: 'legacy' });
    }
    const reads = await Promise.all([
      stationRef(ctx.sid).collection('schedule_responses')
        .where('publication_id', '==', active.pointer.publication_id)
        .where('person', '==', ctx.uid).get(),
      active.ref.collection('schedule_outbox').where('person', '==', ctx.uid).get(),
      readLiveGuardProjection(ctx, [date])
    ]);
    // The guards sidecar is live and intentionally outside the signed
    // publication.  Recheck the signed pointer after it was read so a
    // publication change can never combine an old plan with a new response.
    await beforeLiveGuardViewRecheck({ kind: 'v2-guards', ctx, mode: config.mode });
    await activeSnapshotStillCurrent(ctx, config, active);
    const responseSnap = reads[0];
    const answers = {};
    responseSnap.docs.forEach((doc) => {
      const value = doc.data() || {};
      if (value.person === ctx.uid && nonEmpty(value.item_id)) {
        answers[value.item_id] = { status: value.answer === 'confirm' ? 'confirmed' : 'declined' };
      }
    });
    const changeSnap = reads[1];
    const changes = {};
    changeSnap.docs.forEach((doc) => {
      const value = doc.data() || {};
      (Array.isArray(value.detail) ? value.detail : []).forEach((change) => {
        if (!plain(change)) return;
        const itemId = nonEmpty(change.item_id) ? change.item_id : change.date;
        if (nonEmpty(itemId)) changes[itemId] = change;
      });
    });
    const view = myViewWithGuards(serviceFor(ctx).buildMySchedule({
      actor: actor(ctx), plan: active.plan, events: active.events, roster: active.roster,
      changes_by_date: changes,
      answers_by_date: answers
    }), reads[2], date, ctx.uid);
    return Object.assign({ mode: config.mode, active: true,
      publication_id: active.pointer.publication_id, revision: active.pointer.revision }, view);
  }

  /* ==================================================================
   *  סידור התחנה כרצועת חודש
   * ------------------------------------------------------------------
   *  `getStation` מחזיר שלושה ימים, כי המסך הישן הציג יום אחד עם
   *  חיצים. הלוח שאלדד ביקש הוא חודש שלם בגלילה אחת — ולכן צריך
   *  קריאה אחת לטווח, ולא שלושים קריאות יום.
   *
   *  שני מסלולים, מכוונים:
   *  · `new` — התמונה החתומה נקראת **בשלמותה** (ולא בחלון), כך
   *    שבדיקת החתימה של `readSnapshot` באמת רצה. חלון מדלג עליה.
   *  · `off`/`shadow` — אותו חלון תאימות שכבר משמש את `getStation`,
   *    בקריאה אחת לכל הטווח. הרצועה עובדת גם לפני שהמנוע הופעל,
   *    כדי שהמסך לא יהיה ריק בדיוק במצב שהתחנה נמצאת בו היום.
   * ================================================================== */

  function requestedStationRange(req) {
    const data = req && req.data === undefined ? {} : (req && req.data);
    if (!plain(data) || Object.keys(data).some((key) => key !== 'from' && key !== 'to')) {
      throw new ScheduleRuntimeError('station-range-input',
        'תצוגת הטווח מקבלת התחלה וסיום בלבד.', 'invalid-argument');
    }
    const from = isoDayOffset(String(data.from || ''), 0);
    const to = isoDayOffset(String(data.to || ''), 0);
    if (from > to) {
      throw new ScheduleRuntimeError('station-range-input',
        'תאריך ההתחלה חייב להיות לפני תאריך הסיום.', 'invalid-argument');
    }
    const dates = [];
    let cursor = from;
    while (cursor <= to) {
      dates.push(cursor);
      if (dates.length > MAX_STATION_RANGE_DAYS) {
        throw new ScheduleRuntimeError('station-range-input',
          'טווח התצוגה גדול מחודש אחד.', 'invalid-argument');
      }
      cursor = isoDayOffset(cursor, 1);
    }
    return Object.freeze({ from, to, dates: Object.freeze(dates) });
  }


  /* ==================================================================
   * ⭐ „מי עובד בתאריך?" — לשרת וללקוח (seq377/385 D · 400)
   *
   * `effectiveWorkDaysFor(ctx, config, {uids, from, to})` — פנימי: טווח
   * של עד 397 יום כולל הקצוות, מוקרא בחלונות של ≤93 יום דרך המתאם
   * הקיים — מתמונת פרסום **אחת** במצב new, או ממחזור ה-legacy
   * ב-off/shadow — ומורכב במודול הטהור `schedule-effective-workdays`:
   * `by_uid`, `unknown_dates`, `unknown_uids`. יום מחוץ לכיסוי הפרסום
   * הוא „לא ידוע", לא „לא עובד". אדם שאינו בסגל הפרסום — „לא ידוע",
   * לא „בחופש". new בלי פרסום פעיל → ה-fallback המפורש ל-legacy.
   *
   * `getEffectiveWorkdays(req)` — callable לחבר תחנה: `{from, to, uids}`
   * בלבד. מחזיר תאריכים לכל uid מבוקש (עד 500), בלי שמות ובלי צוותים —
   * פחות ממה ש-getLegacyScheduleCompatibilityContext חשף עד היום
   * (מחזור מלא + חריגים לכל התחנה). `shift_hours`: תצורת שעות המשמרת
   * של התחנה מתוך רשומת המחזור הפעילה — **תצורה, לא סידור** — כדי
   * שמסך הנוכחות ימשיך למלא שעות גם במצב new, עד שתתקבל הכרעה על שעות
   * במנוע החדש (פתוח מ-seq385). המקור מסומן במפורש.
   *
   * `effectiveWorkDaysForStation(sid, input)` — לשרת בלבד (סריקת לילה,
   * דוח חודשי, בדיקת מנוחה בהחלפה): אין req, אין auth; התחנה נמסרת
   * מהקוד הקורא ומאומתת. אינו מיוצא כ-callable.
   * ================================================================== */
  const ROTATION_HOUR_FIELDS = Object.freeze([
    'shift_start', 'shift_end', 'shift_hours', 'commander_start',
    'commander_shift_hours', 'special_end', 'special_shift_hours'
  ]);

  async function stationShiftHours(ctx) {
    const snap = await stationRef(ctx.sid).collection('rotations').limit(MAX_LEGACY_ROTATIONS + 1).get();
    if (snap.size > MAX_LEGACY_ROTATIONS) {
      throw new ScheduleRuntimeError('legacy-rotations-too-large',
        'מחזורי הסידור הקיימים גדולים מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
    }
    const rows = snap.docs.map((doc) => ({ id: doc.id, value: doc.data() || {} }))
      .sort((a, b) => compareCanonical(a.id, b.id));
    const active = rows.filter((row) => row.value.is_active !== false)[0] || rows[0] || null;
    if (!active) return null;
    const out = {};
    ROTATION_HOUR_FIELDS.forEach((field) => {
      const value = active.value[field];
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[field] = value;
    });
    return Object.keys(out).length ? Object.freeze(Object.assign(out, { hours_source: 'legacy-rotation-config' })) : null;
  }

  async function effectiveWindows(ctx, config, windows, pinned) {
    const reader = effectiveReaderFor(ctx, pinned ? { snapshot: pinned } : undefined);
    const out = [];
    for (const w of windows) {
      let window;
      try {
        window = await reader.getStation({ data: { from: w.from, to: w.to } });
      } catch (error) {
        if (error instanceof ScheduleRuntimeError) throw error;
        throw new ScheduleRuntimeError('effective-schedule-invalid',
          'לא ניתן לאמת את הסידור להצגה ולכן הוא לא מוצג.', 'failed-precondition');
      }
      if ((config.mode === MODE.NEW && window.source !== 'v2')
          || (config.mode !== MODE.NEW && window.source !== 'legacy')) {
        throw new ScheduleRuntimeError('schedule-mode-changed',
          'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
      }
      out.push({ from: w.from, to: w.to, days: window.days, provenance: window.provenance });
    }
    return out;
  }

  /* הבסיס של ה-legacy לקריאה אחת: סגל + מחזורים, קריאה אחת, חתימה אחת.
   * החתימה נכנסת ל-provenance (כך שני חלקים של 500 מזהים אינם יכולים
   * להיענות משני בסיסים שונים בלי שמישהו ישים לב), ונבדקת שוב בסוף. */
  async function legacyWorkdaysBasis(ctx) {
    const root = stationRef(ctx.sid);
    const reads = await Promise.all([
      root.collection('roster').limit(MAX_LEGACY_ROSTER + 1).get(),
      root.collection('rotations').limit(MAX_LEGACY_ROTATIONS + 1).get()
    ]);
    if (reads[0].size > MAX_LEGACY_ROSTER) {
      throw new ScheduleRuntimeError('legacy-roster-too-large',
        'רשימת הסגל הקיימת גדולה מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
    }
    if (reads[1].size > MAX_LEGACY_ROTATIONS) {
      throw new ScheduleRuntimeError('legacy-rotations-too-large',
        'מחזורי הסידור הקיימים גדולים מהתקרה הבטוחה לתצוגה.', 'resource-exhausted');
    }
    const rosterDocs = reads[0].docs.slice().sort((a, b) => compareCanonical(a.id, b.id));
    const rotationDocs = reads[1].docs.slice().sort((a, b) => compareCanonical(a.id, b.id));
    const legacyDigest = digest({
      roster: rosterDocs.map((doc) => [doc.id, doc.data() || {}]),
      rotations: rotationDocs.map((doc) => [doc.id, doc.data() || {}])
    });
    return { rosterDocs, rotationDocs, legacyDigest, rosterIds: rosterDocs.map((doc) => doc.id) };
  }

  async function requireSameLegacyBasis(ctx, basis) {
    const now = await legacyWorkdaysBasis(ctx);
    if (now.legacyDigest !== basis.legacyDigest) {
      throw new ScheduleRuntimeError('legacy-schedule-changed',
        'הסידור הקיים השתנה בזמן הקריאה. יש לרענן.', 'aborted');
    }
  }

  function requireLiveWorkdaysViewer(userSnap, ctx) {
    const user = userSnap && userSnap.exists ? (userSnap.data() || {}) : null;
    const role = String(user && user.role || '');
    if (!scheduleAccess.activeMember(user, ctx.sid)
        || (!ctx.super && (MEMBER_ROLES.indexOf(role) === -1 || role !== ctx.role))) {
      throw new ScheduleRuntimeError('workdays-viewer-changed',
        'השיוך החי לתחנה השתנה בזמן הקריאה.', 'permission-denied');
    }
  }

  function workdaysError(error) {
    if (error && error.name === 'EffectiveWorkdaysError') {
      throw new ScheduleRuntimeError('workdays-' + error.code, error.message, 'invalid-argument');
    }
    throw error;
  }

  async function effectiveWorkDaysFor(ctx, config, input) {
    const value = plain(input) ? input : {};
    let range;
    try {
      range = effectiveWorkdays.normalizeRange(String(value.from || ''), String(value.to || ''));
      effectiveWorkdays.normalizeUids(Array.isArray(value.uids) ? value.uids : []);
    } catch (error) { workdaysError(error); }
    const uids = Array.isArray(value.uids) ? value.uids : [];

    if (config.mode === MODE.NEW) {
      const active = await checkedActiveSnapshot(ctx, config, null);
      if (active) {
        const coverage = { from: String(active.plan.from || ''), to: String(active.plan.to || '') };
        let windows;
        try { windows = effectiveWorkdays.windowsFor(range, coverage); } catch (error) { workdaysError(error); }
        const produced = await effectiveWindows(ctx, config, windows, active);
        // אותה תמונה מתחילת הקריאה ועד סופה — אחרת התשובה מעורבבת.
        await activeSnapshotStillCurrent(ctx, config, active);
        let assembled;
        try {
          assembled = effectiveWorkdays.assemble({
            source: 'publication', range: { from: range.from, to: range.to }, coverage,
            windows: produced, uids,
            roster: (active.roster || []).map((person) => person.id)
          });
        } catch (error) { workdaysError(error); }
        return Object.assign({ mode: config.mode, fallback: null, provenance: {
          mode: config.mode, source: 'v2', publication_id: active.ref.id,
          revision: Number(active.pointer.revision), content_digest: active.meta.content_digest
        } }, assembled);
      }
      // אין פרסום פעיל ב-new — אותו fallback מפורש כמו בשאר הקוראים.
    }

    const coverage = { from: range.from, to: range.to };
    const windows = effectiveWorkdays.windowsFor(range, coverage);
    // בסיס אחד לכל החלונות (417 §2): סגל + מחזורים נקראים פעם אחת,
    // מוזרמים לכל חלון, ונבדקים שוב בסוף.
    const basis = await legacyWorkdaysBasis(ctx);
    const scoped = { legacyBasis: basis };
    const produced = [];
    for (const w of windows) {
      const window = config.mode === MODE.NEW
        ? await legacyFallbackWindow(ctx, config, w.from, w.to, scoped)
        : await checkedLegacyWindow(ctx, config, w.from, w.to, scoped);
      if (window.source !== 'legacy') {
        throw new ScheduleRuntimeError('schedule-mode-changed',
          'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
      }
      produced.push({ from: w.from, to: w.to, days: window.days, provenance: window.provenance });
    }
    await beforeEffectiveViewRecheck({ kind: 'workdays-legacy', ctx, mode: config.mode });
    await requireSameLegacyBasis(ctx, basis);
    let assembled;
    try {
      assembled = effectiveWorkdays.assemble({
        source: 'legacy', range: { from: range.from, to: range.to }, coverage,
        windows: produced, uids,
        // מי שאינו בסגל הקיים — „לא ידוע", לא „בחופש" (417 §3).
        roster: basis.rosterIds
      });
    } catch (error) { workdaysError(error); }
    const head = produced.length ? produced[0].provenance : { mode: config.mode, source: 'legacy' };
    return Object.assign({
      mode: config.mode, fallback: config.mode === MODE.NEW ? 'legacy' : null,
      provenance: Object.assign({}, head, { legacy_digest: basis.legacyDigest })
    }, assembled);
  }

  function workdaysResponse(result, shiftHours) {
    return {
      mode: result.mode,
      source: result.source,
      fallback: result.fallback,
      from: result.range.from,
      to: result.range.to,
      coverage: result.coverage,
      unknown_dates: result.unknown_dates,
      unknown_uids: result.unknown_uids,
      by_uid: result.by_uid,
      shift_hours: shiftHours,
      provenance: result.provenance,
      generated_at: clock()
    };
  }

  async function getEffectiveWorkdays(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const data = req && req.data === undefined ? {} : (req && req.data);
    if (!plain(data) || Object.keys(data).some((key) => ['from', 'to', 'uids'].indexOf(key) === -1)) {
      throw new ScheduleRuntimeError('workdays-input',
        'ימי העבודה מתקבלים לפי התחלה, סיום ורשימת מזהים בלבד.', 'invalid-argument');
    }
    if (!Array.isArray(data.uids)) {
      throw new ScheduleRuntimeError('workdays-uids-shape', 'חובה למסור רשימת מזהים (גם ריקה).', 'invalid-argument');
    }
    const result = await effectiveWorkDaysFor(ctx, config, {
      from: String(data.from || ''), to: String(data.to || ''), uids: data.uids
    });
    const shiftHours = await stationShiftHours(ctx);
    // ⭐ 417 §1: הזהות החיה נבדקת שוב **בסוף** — אחרי כל הקריאות, כולל שעות
    // המשמרת. מי שהושבת או הועבר תחנה באמצע לא מקבל את התשובה.
    await beforeEffectiveViewRecheck({ kind: 'workdays', ctx, mode: config.mode });
    const finalReads = await Promise.all([configuration(ctx.sid), liveUserRef(ctx.sid, ctx.uid).get()]);
    if (finalReads[0].mode !== config.mode) {
      throw new ScheduleRuntimeError('schedule-mode-changed',
        'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
    }
    requireLiveWorkdaysViewer(finalReads[1], ctx);
    return workdaysResponse(result, shiftHours);
  }

  async function effectiveWorkDaysForStation(sid, input) {
    const station = String(sid || '').trim();
    if (!ID_RE.test(station)) {
      throw new ScheduleRuntimeError('station-required', 'חסר מזהה תחנה תקין.', 'failed-precondition');
    }
    const ctx = { sid: station, uid: null, role: 'system', system: true };
    const config = await configuration(station);
    const result = await effectiveWorkDaysFor(ctx, config, input);
    return workdaysResponse(result, await stationShiftHours(ctx));
  }

  async function getStationRange(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const range = requestedStationRange(req);

    if (config.mode !== MODE.NEW) {
      const window = await checkedLegacyWindow(ctx, config, range.from, range.to);
      if (window.source !== 'legacy') {
        throw new ScheduleRuntimeError('schedule-mode-changed',
          'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
      }
      const byDate = new Map((window.days || []).map((day) => [day.date, day]));
      return {
        mode: window.provenance.mode, active: true, source: 'legacy',
        provenance: window.provenance, from: range.from, to: range.to,
        days: range.dates.map((date) => legacyDayBlock(
          byDate.get(date) || { date, assignments: [] }, ctx.uid, window.events))
      };
    }

    // ⭐ dates=null במכוון: כך `readSnapshot` קורא את התמונה כולה
    // ומאמת את חתימת התוכן. קריאת חלון מדלגת על האימות הזה.
    const active = await checkedActiveSnapshot(ctx, config, null);
    if (!active) {
      const window = await legacyFallbackWindow(ctx, config, range.from, range.to);
      const byDate = new Map((window.days || []).map((day) => [day.date, day]));
      return {
        mode: config.mode, active: true, source: 'legacy', fallback: 'legacy',
        provenance: window.provenance, from: range.from, to: range.to,
        days: range.dates.map((date) => legacyDayBlock(
          byDate.get(date) || { date, assignments: [] }, ctx.uid, window.events))
      };
    }
    const sidecar = await readLiveGuardProjection(ctx, range.dates);
    await beforeLiveGuardViewRecheck({ kind: 'v2-guards', ctx, mode: config.mode });
    await activeSnapshotStillCurrent(ctx, config, active);
    const service = serviceFor(ctx);
    const days = range.dates.map((date) => stationViewWithGuards(service.buildStationSchedule({
      actor: actor(ctx), plan: active.plan, events: active.events, roster: active.roster, date
    }), sidecar, date, ctx.uid).day);
    return {
      mode: config.mode, active: true, source: 'v2',
      publication_id: active.pointer.publication_id, revision: active.pointer.revision,
      from: range.from, to: range.to, days
    };
  }

  async function getStation(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    const date = requestedViewDate(req, clock().slice(0, 10));
    const dates = [isoDayOffset(date, -1), date, isoDayOffset(date, 1)];
    if (config.mode !== MODE.NEW) {
      const window = await checkedLegacyWindow(ctx, config, dates[0], dates[2]);
      if (window.source !== 'legacy') {
        throw new ScheduleRuntimeError('schedule-mode-changed',
          'מצב הסידור השתנה בזמן הקריאה. יש לרענן.', 'aborted');
      }
      return legacyStationView(ctx, window, date);
    }
    const active = await checkedActiveSnapshot(ctx, config, dates);
    if (!active) {
      const window = await legacyFallbackWindow(ctx, config, dates[0], dates[2]);
      return Object.assign(legacyStationView(ctx, window, date),
        { mode: config.mode, fallback: 'legacy' });
    }
    const sidecar = await readLiveGuardProjection(ctx, dates);
    await beforeLiveGuardViewRecheck({ kind: 'v2-guards', ctx, mode: config.mode });
    await activeSnapshotStillCurrent(ctx, config, active);
    const view = stationViewWithGuards(serviceFor(ctx).buildStationSchedule({
      actor: actor(ctx), plan: active.plan, events: active.events, roster: active.roster, date
    }), sidecar, date, ctx.uid);
    return Object.assign({ mode: config.mode, active: true,
      publication_id: active.pointer.publication_id, revision: active.pointer.revision }, view);
  }

  // The four legacy guard readers deliberately bypass the monthly-engine mode:
  // guards remain live operational work whether the new planner is off,
  // shadowing, or active.  They all use the same station derived from the
  // authenticated, live account and the same bounded server-side input.
  async function getGuardBoard(req) {
    const ctx = await context(req);
    const range = requestedGuardBoardRange(req);
    const input = await readGuardBoardInput(ctx, range);
    return Object.freeze({
      from: range.from,
      to: range.to,
      guards: guardBoardProjection.memberBoard(input)
    });
  }

  async function getGuardManagerBoard(req) {
    const ctx = await context(req);
    requireManager(ctx);
    const range = requestedGuardBoardRange(req);
    const input = await readGuardBoardInput(ctx, range);
    // The transaction makes a concurrent appointment revocation win after
    // the raw read and before detailed guard records leave the server.
    await requireLiveManagerNow(ctx);
    return Object.freeze({
      from: range.from,
      to: range.to,
      guards: guardBoardProjection.managerBoard(input)
    });
  }

  async function getMyGuardAttendance(req) {
    const ctx = await context(req);
    const range = requestedGuardBoardRange(req);
    const input = await readGuardBoardInput(ctx, range);
    // There is deliberately no subject/uid field.  HR can open another
    // employee's attendance report, but that must never expand into a second
    // person's guard history through this callable.
    return Object.freeze({
      from: range.from,
      to: range.to,
      guards: guardBoardProjection.personalAttendance(input)
    });
  }

  async function getGuardLoadStatistics(req) {
    const ctx = await context(req);
    requireAnalytics(ctx);
    const range = requestedGuardBoardRange(req);
    const input = await readGuardBoardInput(ctx, range);
    // A firefighter can reach this endpoint only through the live schedule
    // manager appointment.  Recheck that short-lived authority before return.
    if (ctx.manager) await requireLiveManagerNow(ctx);
    return Object.freeze({
      from: range.from,
      to: range.to,
      guards: guardBoardProjection.loadRows(input)
    });
  }

  async function respond(req) {
    const ctx = await context(req);
    const config = await configuration(ctx.sid);
    if (config.mode === MODE.OFF) {
      throw new ScheduleRuntimeError('schedule-mode-blocked', 'הסידור החדש כבוי.');
    }
    const data = plain(req.data) ? req.data : {};
    const requestId = requireId(data.request_id, 'request-id', 'מזהה הפעולה');
    const publicationId = requireId(data.publication_id, 'publication-id', 'מזהה הפרסום');
    const itemId = String(data.item_id || '');
    const isDateItem = DATE_RE.test(itemId);
    if (isDateItem) isoDayOffset(itemId, 0);
    else requireId(itemId, 'item-id', 'מזהה השיבוץ');
    const answer = String(data.answer || '');
    const responseId = 'r_' + hash(ctx.sid + '|' + ctx.uid + '|' + requestId).slice(0, 40);
    const ref = stationRef(ctx.sid).collection('schedule_responses').doc(responseId);
    return db.runTransaction(async (tx) => {
      const pointerSnap = await tx.get(activeRef(ctx.sid));
      const pointer = pointerSnap.exists ? (pointerSnap.data() || {}) : {};
      if (pointer.publication_id !== publicationId) {
        throw new ScheduleRuntimeError('publication-not-active', 'התגובה אינה לפרסום הפעיל.', 'aborted');
      }
      const pubRef = stationRef(ctx.sid).collection('schedule_publications').doc(publicationId);
      const assigned = [];
      if (isDateItem) {
        const rowSnap = await tx.get(pubRef.collection('rows').where('date', '==', itemId));
        rowSnap.docs.forEach((doc) => {
          const row = (doc.data() || {}).row || {};
          (row.slots || []).forEach((slot) => assigned.push({ id: itemId, person: slot.person }));
        });
      } else {
        const eventSnap = await tx.get(pubRef.collection('events').where('id', '==', itemId));
        eventSnap.docs.forEach((doc) => {
          const event = doc.data() || {};
          (event.people || []).forEach((person) => assigned.push({ id: itemId, person }));
        });
      }
      const existing = await tx.get(ref);
      const fingerprint = digest({ publicationId, itemId, answer, reason: data.reason_code || null });
      if (existing.exists) {
        const before = existing.data() || {};
        if (before.request_fingerprint !== fingerprint) {
          throw new ScheduleRuntimeError('response-conflict', 'אותו מזהה תגובה כבר שימש לתוכן אחר.', 'already-exists');
        }
        return { duplicate: true, response_id: responseId, answer: before.answer };
      }
      const result = serviceFor(ctx).respond({
        actor: actor(ctx), answer, reason_code: data.reason_code,
        request: {
          person: ctx.uid, request_id: requestId, publication_id: publicationId,
          publication_revision: Number(pointer.revision), item_id: itemId
        },
        active_publication: {
          id: publicationId, revision: Number(pointer.revision), station_id: ctx.sid,
          assigned_items: assigned
        }
      });
      tx.create(ref, {
        station_id: ctx.sid, publication_id: publicationId,
        publication_revision: Number(pointer.revision), person: ctx.uid,
        item_id: itemId, answer: result.answer, reason_code: result.reason_code || null,
        request_id: requestId, request_fingerprint: fingerprint,
        created_at: FV.serverTimestamp()
      });
      return { duplicate: false, response_id: responseId, answer: result.answer };
    });
  }

  function publicationMatches(value, pointer, publication) {
    return publication.status === 'active'
      && pointer.publication_id === value.publication_id
      && Number(pointer.revision || 0) === Number(value.revision || 0);
  }

  async function validateOutboxForSend(ref, leaseToken) {
    let sendable = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const value = snap.data() || {};
      if (value.status !== 'sending' || value.lease_token !== leaseToken) return;
      const stationId = String(value.station_id || '');
      const publicationId = String(value.publication_id || '');
      const person = String(value.person || '');
      const now = Date.parse(clock());
      if (!ID_RE.test(stationId) || !ID_RE.test(publicationId) || !AUTH_UID_RE.test(person)) {
        cancelOutbox(tx, ref, 'outbox-invalid');
        return;
      }
      if (outboxExpired(value, now)) {
        cancelOutbox(tx, ref, 'outbox-expired');
        return;
      }
      const publicationRef = stationRef(stationId).collection('schedule_publications').doc(publicationId);
      const refs = [runtimeRef(stationId), activeRef(stationId), publicationRef,
        liveUserRef(stationId, person)];
      const checks = await Promise.all(refs.map((item) => tx.get(item)));
      const runtime = checks[0].exists ? (checks[0].data() || {}) : {};
      const pointer = checks[1].exists ? (checks[1].data() || {}) : {};
      const publication = checks[2].exists ? (checks[2].data() || {}) : {};
      if (runtime.mode !== MODE.NEW) {
        cancelOutbox(tx, ref, 'runtime-not-new');
        return;
      }
      if (!publicationMatches(value, pointer, publication)) {
        cancelOutbox(tx, ref, 'publication-not-active');
        return;
      }
      if (!recipientIsActive(checks[3], stationId)) {
        cancelOutbox(tx, ref, 'recipient-inactive');
        return;
      }
      sendable = true;
    });
    return sendable;
  }

  async function deliverOutbox(ref) {
    if (!ref || typeof ref.get !== 'function') return { skipped: true };
    let claimed = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() || {};
      if (data.status !== 'queued') return;
      const stationId = String(data.station_id || '');
      const publicationId = String(data.publication_id || '');
      const person = String(data.person || '');
      const now = Date.parse(clock());
      if (!ID_RE.test(stationId) || !ID_RE.test(publicationId) || !AUTH_UID_RE.test(person)) {
        cancelOutbox(tx, ref, 'outbox-invalid');
        return;
      }
      if (outboxExpired(data, now)) {
        cancelOutbox(tx, ref, 'outbox-expired');
        return;
      }
      const publicationRef = stationRef(stationId).collection('schedule_publications').doc(publicationId);
      const refs = [runtimeRef(stationId), activeRef(stationId), publicationRef,
        liveUserRef(stationId, person)];
      const checks = await Promise.all(refs.map((item) => tx.get(item)));
      const runtime = checks[0].exists ? (checks[0].data() || {}) : {};
      const pointer = checks[1].exists ? (checks[1].data() || {}) : {};
      const publication = checks[2].exists ? (checks[2].data() || {}) : {};
      if (runtime.mode !== MODE.NEW) {
        cancelOutbox(tx, ref, 'runtime-not-new');
        return;
      }
      if (!publicationMatches(data, pointer, publication)) {
        cancelOutbox(tx, ref, 'publication-not-active');
        return;
      }
      if (!recipientIsActive(checks[3], stationId)) {
        cancelOutbox(tx, ref, 'recipient-inactive');
        return;
      }
      const leaseToken = 'l_' + randomId();
      tx.update(ref, {
        status: 'sending', claimed_at: FV.serverTimestamp(), lease_token: leaseToken,
        lease_until: new Date(now + OUTBOX_LEASE_MS)
      });
      claimed = Object.assign({}, data, { lease_token: leaseToken });
    });
    if (!claimed) return { skipped: true };
    try {
      await beforeOutboxSend(claimed);
      // The second transaction is as close as possible to the external call.
      // It closes pointer/mode/expiry changes that happened after the claim.
      if (!await validateOutboxForSend(ref, claimed.lease_token)) return { skipped: true };
      const push = claimed.push || {};
      const delivery = await sendPush(claimed.station_id, claimed.person, 'schedule_mine',
        push.title || 'ResQ · הסידור שלך', push.body || 'הסידור שלך עודכן',
        './schedule-management.html?tab=mine', true);
      if (!delivery || Number(delivery.sent || 0) < 1) {
        const error = new Error('NO_ACTIVE_PUSH_TOKEN');
        error.code = 'NO_ACTIVE_PUSH_TOKEN';
        throw error;
      }
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const live = snap.exists ? (snap.data() || {}) : {};
        if (live.status === 'sending' && live.lease_token === claimed.lease_token) {
          tx.update(ref, {
            status: 'sent', sent_at: FV.serverTimestamp(), last_error: null,
            delivered_devices: Number(delivery.sent),
            lease_token: null, lease_until: null
          });
        }
      });
      return { sent: true };
    } catch (error) {
      const publication = createPublication({
        clock, hash, rules: { max_attempts: 3, retry_backoff_ms: [60000, 300000] }
      });
      const retry = publication.planRetry({
        notification: Object.assign({}, claimed, { attempt: Number(claimed.attempt || 0) }),
        error_code: String((error && error.code) || 'SEND_FAILED')
      });
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const live = snap.exists ? (snap.data() || {}) : {};
        if (live.status !== 'sending' || live.lease_token !== claimed.lease_token) return;
        tx.update(ref, {
          status: retry.status,
          attempt: retry.attempt,
          next_attempt_at: retry.next_attempt_at || null,
          last_error: retry.last_error,
          lease_token: null, lease_until: null,
          updated_at: FV.serverTimestamp()
        });
      });
      return { sent: false, status: retry.status };
    }
  }

  async function resumeOutbox() {
    // Query each lifecycle state independently: a large staging backlog must
    // not starve an active retry or a previously queued delivery.
    const collected = new Map();
    for (const status of ['retry', 'sending', 'queued', 'blocked']) {
      const snap = await db.collectionGroup('schedule_outbox')
        .where('status', '==', status).limit(100).get();
      snap.docs.forEach((doc) => collected.set(doc.ref.path, doc));
    }
    let queued = 0;
    const now = Date.parse(clock());
    for (const doc of collected.values()) {
      const result = await reconcileOutbox(doc.ref, now);
      if (result.queued) queued += 1;
      if (result.deliver) await deliverOutbox(doc.ref);
    }
    return { scanned: collected.size, queued };
  }

  function cancelGuardNotificationJob(tx, ref, reason) {
    tx.update(ref, {
      status: 'cancelled',
      cancel_reason: reason,
      cancelled_at: FV.serverTimestamp(),
      lease_token: null,
      lease_until: null
    });
  }

  function guardNotificationJobValue(value) {
    const stationId = String(value && value.station_id || '');
    const guardId = String(value && value.guard_id || '');
    const revision = Number(value && value.revision);
    const requestId = String(value && value.request_id || '');
    const part = Number(value && value.part);
    const cursor = Number(value && value.cursor);
    const notifications = value && value.notifications;
    if (!ID_RE.test(stationId) || !ID_RE.test(guardId) || !ID_RE.test(requestId)
        || !Number.isSafeInteger(revision) || revision < 1
        || !Number.isSafeInteger(part) || part < 0
        || !Number.isSafeInteger(cursor) || cursor < 0
        || !DATE_RE.test(String(value && value.date || ''))
        || !/^\d{2}:\d{2}$/.test(String(value && value.start || ''))
        || !/^\d{2}:\d{2}$/.test(String(value && value.end || ''))
        || !Array.isArray(notifications) || notifications.length > GUARD_NOTIFICATION_FANOUT_CHUNK
        || cursor > notifications.length) return null;
    const seen = new Set();
    const parsed = [];
    for (const item of notifications) {
      const uid = String(item && item.uid || '');
      const kind = String(item && item.kind || '');
      const hasEpoch = !!item && Object.prototype.hasOwnProperty.call(item, 'membership_epoch');
      const membershipEpoch = hasEpoch ? Number(item.membership_epoch) : null;
      if (!AUTH_UID_RE.test(uid)
          || ['open', 'assigned', 'removed', 'updated', 'rescheduled', 'cancelled', 'completed'].indexOf(kind) === -1
          || ((kind === 'assigned' || kind === 'removed')
            && (!hasEpoch || !Number.isSafeInteger(membershipEpoch) || membershipEpoch < 1))
          || (hasEpoch && (kind !== 'assigned' && kind !== 'removed'
            || !Number.isSafeInteger(membershipEpoch) || membershipEpoch < 1))
          || seen.has(uid)) return null;
      seen.add(uid);
      parsed.push(Object.freeze({ uid, kind, membership_epoch: membershipEpoch }));
    }
    return Object.freeze({
      station_id: stationId,
      guard_id: guardId,
      revision,
      request_id: requestId,
      part,
      date: String(value.date),
      start: String(value.start),
      end: String(value.end),
      expires_at: value.expires_at,
      cursor,
      notifications: Object.freeze(parsed)
    });
  }

  async function fanoutGuardOutbox(ref) {
    if (!ref || typeof ref.get !== 'function') return { skipped: true };
    // The children and the cursor advance in the *same* transaction.  A
    // worker that loses a retry race neither creates duplicate child notices
    // nor leaves a completed chunk stuck behind an expired lease.
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { skipped: true };
      const value = snap.data() || {};
      if (value.status !== 'queued') return { skipped: true };
      const now = Date.parse(clock());
      if (outboxExpired(value, now)) {
        cancelGuardNotificationJob(tx, ref, 'outbox-expired');
        return { skipped: true };
      }
      const job = guardNotificationJobValue(value);
      if (!job) {
        cancelGuardNotificationJob(tx, ref, 'outbox-invalid');
        return { skipped: true };
      }
      const guard = await tx.get(guardRef(job.station_id, job.guard_id));
      if (!guard.exists) {
        cancelGuardNotificationJob(tx, ref, 'guard-not-found');
        return { skipped: true };
      }
      if (job.cursor >= job.notifications.length) {
        tx.update(ref, { status: 'complete', completed_at: FV.serverTimestamp() });
        return { delivered: 0, remaining: 0 };
      }
      const nextCursor = Math.min(job.cursor + GUARD_NOTIFICATION_FANOUT_CHUNK, job.notifications.length);
      const notices = job.notifications.slice(job.cursor, nextCursor)
        .filter((notice) => guardNoticeCurrent(
          notice.kind, notice.uid, job.revision, guard, notice.membership_epoch
        ));
      const childRefs = notices.map((notice) => guardOutboxRef(
        job.station_id, job.request_id, notice.uid
      ));
      // All reads precede writes, including the deterministic children left by
      // an older interrupted version of this worker.
      const existing = await Promise.all(childRefs.map((childRef) => tx.get(childRef)));
      for (let index = 0; index < childRefs.length; index += 1) {
        if (existing[index].exists) continue;
        const notice = notices[index];
        const child = {
          station_id: job.station_id,
          guard_id: job.guard_id,
          revision: job.revision,
          recipient_uid: notice.uid,
          kind: notice.kind,
          date: job.date,
          start: job.start,
          end: job.end,
          request_id: job.request_id,
          status: 'queued',
          attempt: 0,
          expires_at: job.expires_at,
          created_at: FV.serverTimestamp(),
          lease_token: null,
          lease_until: null,
          last_error: null
        };
        if (Number.isSafeInteger(notice.membership_epoch)) {
          child.membership_epoch = notice.membership_epoch;
        }
        tx.create(childRefs[index], child);
      }
      tx.update(ref, {
        cursor: nextCursor,
        status: nextCursor >= job.notifications.length ? 'complete' : 'queued',
        completed_at: nextCursor >= job.notifications.length ? FV.serverTimestamp() : null,
        lease_token: null,
        lease_until: null,
        updated_at: FV.serverTimestamp()
      });
      return { delivered: notices.length, remaining: job.notifications.length - nextCursor };
    });
  }

  async function reconcileGuardNotificationJob(ref, now) {
    let fanout = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const value = snap.data() || {};
      if (value.status !== 'queued' && value.status !== 'sending') return;
      if (outboxExpired(value, now)) {
        cancelGuardNotificationJob(tx, ref, 'outbox-expired');
        return;
      }
      if (!guardNotificationJobValue(value)) {
        cancelGuardNotificationJob(tx, ref, 'outbox-invalid');
        return;
      }
      if (value.status === 'sending') {
        const leaseUntil = timeMillis(value.lease_until);
        if (Number.isFinite(leaseUntil) && leaseUntil > now) return;
        tx.update(ref, {
          status: 'queued', queued_at: FV.serverTimestamp(), lease_token: null, lease_until: null
        });
      }
      fanout = true;
    });
    return { fanout };
  }

  async function resumeGuardNotificationJobs() {
    const collected = new Map();
    for (const status of ['queued', 'sending']) {
      const snap = await db.collectionGroup('guard_notification_jobs')
        .where('status', '==', status).orderBy('created_at', 'asc').limit(100).get();
      snap.docs.forEach((doc) => collected.set(doc.ref.path, doc));
    }
    const now = Date.parse(clock());
    let fanned = 0;
    for (const doc of collected.values()) {
      const result = await reconcileGuardNotificationJob(doc.ref, now);
      if (!result.fanout) continue;
      await fanoutGuardOutbox(doc.ref);
      fanned += 1;
    }
    return { scanned: collected.size, fanned };
  }

  function cancelGuardOutbox(tx, ref, reason) {
    tx.update(ref, {
      status: 'cancelled',
      cancel_reason: reason,
      cancelled_at: FV.serverTimestamp(),
      lease_token: null,
      lease_until: null
    });
  }

  function guardNoticeCurrent(kind, recipient, revision, guard, membershipEpoch) {
    if (['open', 'assigned', 'removed', 'updated', 'rescheduled', 'cancelled', 'completed'].indexOf(kind) === -1
        || !AUTH_UID_RE.test(recipient) || !Number.isSafeInteger(revision) || revision < 1
        || !guard || !guard.exists) return false;
    const current = guard.data() || {};
    const currentRevision = Number(current.revision || 0);
    // Unlike a personal assignment, an open guard is an opportunity for the
    // station.  A harmless later edit must not suppress its generic prompt;
    // being staffed, cancelled or completed must.  Its message intentionally
    // has no title, place or time, so this relaxed revision comparison cannot
    // send stale operational details.
    if (kind === 'open') {
      return Number.isSafeInteger(currentRevision) && currentRevision >= revision
        && current.status === 'open';
    }
    // A removal is different from a snapshot update: it remains meaningful
    // after an unrelated edit or cancellation.  It must not, however, revive
    // after the person was added and removed again.  The server-owned epoch
    // records the last membership transition for that UID.
    if (kind === 'removed') {
      const assigned = Array.isArray(current.assigned) ? current.assigned : [];
      const epochs = plain(current.assignment_epochs) ? current.assignment_epochs : null;
      return Number.isSafeInteger(currentRevision) && currentRevision >= revision
        && assigned.indexOf(recipient) === -1
        && Number.isSafeInteger(membershipEpoch) && membershipEpoch >= 1
        && epochs && Number(epochs[recipient]) === membershipEpoch;
    }
    return currentRevision === revision;
  }

  function guardOutboxCurrent(value, guard) {
    const status = String(value && value.status || '');
    const guardId = String(value && value.guard_id || '');
    if (['queued', 'retry', 'sending'].indexOf(status) === -1
        || !ID_RE.test(guardId)
        || !DATE_RE.test(String(value && value.date || ''))
        || !/^\d{2}:\d{2}$/.test(String(value && value.start || ''))
        || !/^\d{2}:\d{2}$/.test(String(value && value.end || ''))) return false;
    return guardNoticeCurrent(
      String(value.kind || ''),
      String(value.recipient_uid || ''),
      Number(value.revision),
      guard,
      value.membership_epoch
    );
  }

  /**
   * `2026-09-04` → `4/9`. ידנית ולא דרך `Intl`, כדי שאותה התראה
   * תיראה זהה בכל סביבה שבה הפונקציה רצה.
   */
  function shortDate(iso) {
    const value = String(iso || '');
    if (!DATE_RE.test(value)) return value;
    return String(Number(value.slice(8, 10))) + '/' + String(Number(value.slice(5, 7)));
  }

  /**
   * ⭐ המקום נכתב על מסך נעול, ולכן הוא מנוקה כאן ולא נסמך על מי
   * שהקליד אותו: תווי בקרה מוסרים, והאורך נחתך.
   */
  function guardPlaceText(value) {
    const place = String(value && value.place || '').replace(CONTROL_RE, ' ').trim();
    return place ? place.slice(0, 40) : '';
  }

  /* ⭐ „יש עדכון לאבטחה בסידור שלך" הוא נכון וחסר תועלת. מתי ואיפה
   * הם המידע שבגללו ההתראה נשלחה — בלעדיהם צריך לפתוח את
   * האפליקציה רק כדי לדעת אם זה נוגע למחר. */
  function guardOutboxText(value) {
    const place = guardPlaceText(value);
    const when = shortDate(value.date) + ' · ' + String(value.start) + '–' + String(value.end)
      + (place ? ' · ' + place : '');
    switch (value.kind) {
      case 'open': return {
        title: 'נפתחה אבטחה בתחנה',
        body: 'נפתחה אבטחה חדשה. בדוק/י את הסידור המעודכן להרשמה או לשיבוץ.'
      };
      case 'assigned': return { title: 'שובצת לאבטחה', body: 'אבטחה נוספה לסידור שלך: ' + when };
      case 'removed': return { title: 'הוסרת משיבוץ אבטחה', body: 'האבטחה אינה משובצת לך עוד: ' + when };
      case 'rescheduled': return { title: 'מועד האבטחה השתנה', body: 'בדוק/י את המועד החדש בסידור שלך: ' + when };
      case 'cancelled': return { title: 'אבטחה בוטלה', body: 'האבטחה בוטלה: ' + when };
      case 'completed': return { title: 'אבטחה נסגרה', body: 'האבטחה הסתיימה: ' + when };
      default: return { title: 'אבטחה עודכנה', body: 'יש עדכון לאבטחה בסידור שלך: ' + when };
    }
  }

  function guardOutboxDelivery(value) {
    if (value.kind === 'open') {
      return { type: 'guard_open', url: './guards.html', important: false };
    }
    return {
      type: 'guard_mine',
      url: './schedule-management.html?tab=mine&date=' + encodeURIComponent(value.date),
      important: true
    };
  }

  async function validateGuardOutboxForSend(ref, leaseToken) {
    let sendable = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const value = snap.data() || {};
      if (value.status !== 'sending' || value.lease_token !== leaseToken) return;
      const now = Date.parse(clock());
      if (outboxExpired(value, now)) {
        cancelGuardOutbox(tx, ref, 'outbox-expired');
        return;
      }
      const sid = String(value.station_id || '');
      const guardId = String(value.guard_id || '');
      const recipient = String(value.recipient_uid || '');
      if (!ID_RE.test(sid) || !ID_RE.test(guardId) || !AUTH_UID_RE.test(recipient)) {
        cancelGuardOutbox(tx, ref, 'outbox-invalid');
        return;
      }
      const related = await Promise.all([
        tx.get(guardRef(sid, guardId)),
        tx.get(liveUserRef(sid, recipient))
      ]);
      const guard = related[0];
      if (!guardOutboxCurrent(value, guard)) {
        cancelGuardOutbox(tx, ref, 'guard-revision-stale');
        return;
      }
      if (!recipientIsActive(related[1], sid)) {
        cancelGuardOutbox(tx, ref, 'recipient-inactive');
        return;
      }
      sendable = true;
    });
    return sendable;
  }

  async function deliverGuardOutbox(ref) {
    if (!ref || typeof ref.get !== 'function') return { skipped: true };
    let claimed = null;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const value = snap.data() || {};
      if (value.status !== 'queued') return;
      const now = Date.parse(clock());
      if (outboxExpired(value, now)) {
        cancelGuardOutbox(tx, ref, 'outbox-expired');
        return;
      }
      const sid = String(value.station_id || '');
      const guardId = String(value.guard_id || '');
      const recipient = String(value.recipient_uid || '');
      if (!ID_RE.test(sid) || !ID_RE.test(guardId) || !AUTH_UID_RE.test(recipient)) {
        cancelGuardOutbox(tx, ref, 'outbox-invalid');
        return;
      }
      const related = await Promise.all([
        tx.get(guardRef(sid, guardId)),
        tx.get(liveUserRef(sid, recipient))
      ]);
      const guard = related[0];
      if (!guardOutboxCurrent(value, guard)) {
        cancelGuardOutbox(tx, ref, 'guard-revision-stale');
        return;
      }
      if (!recipientIsActive(related[1], sid)) {
        cancelGuardOutbox(tx, ref, 'recipient-inactive');
        return;
      }
      const leaseToken = 'l_' + randomId();
      tx.update(ref, {
        status: 'sending',
        claimed_at: FV.serverTimestamp(),
        lease_token: leaseToken,
        lease_until: new Date(now + OUTBOX_LEASE_MS)
      });
      // ⭐ המקום נלקח ממסמך האבטחה **החי** שכבר נקרא כאן, ולא
      // מעותק ששמור בשורת התור. כך אין קריאה נוספת, והכתובת
      // שנשלחת היא זו שתקפה עכשיו ולא זו שהייתה כשהתור נוצר.
      const live = guard && guard.exists ? (guard.data() || {}) : {};
      claimed = Object.assign({}, value, {
        lease_token: leaseToken, place: live.place
      });
    });
    if (!claimed) return { skipped: true };
    try {
      if (!await validateGuardOutboxForSend(ref, claimed.lease_token)) return { skipped: true };
      const message = guardOutboxText(claimed);
      const deliveryTarget = guardOutboxDelivery(claimed);
      const delivery = await sendPush(
        claimed.station_id,
        claimed.recipient_uid,
        deliveryTarget.type,
        message.title,
        message.body,
        deliveryTarget.url,
        deliveryTarget.important
      );
      if (!delivery || Number(delivery.sent || 0) < 1) {
        const error = new Error('NO_ACTIVE_PUSH_TOKEN');
        error.code = 'NO_ACTIVE_PUSH_TOKEN';
        throw error;
      }
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const value = snap.exists ? (snap.data() || {}) : {};
        if (value.status !== 'sending' || value.lease_token !== claimed.lease_token) return;
        tx.update(ref, {
          status: 'sent',
          sent_at: FV.serverTimestamp(),
          delivered_devices: Number(delivery.sent),
          last_error: null,
          lease_token: null,
          lease_until: null
        });
      });
      return { sent: true };
    } catch (error) {
      const nextAttempt = Number(claimed.attempt || 0) + 1;
      const retrying = nextAttempt < GUARD_OUTBOX_MAX_ATTEMPTS;
      const wait = GUARD_OUTBOX_BACKOFF_MS[Math.min(nextAttempt - 1, GUARD_OUTBOX_BACKOFF_MS.length - 1)];
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const value = snap.exists ? (snap.data() || {}) : {};
        if (value.status !== 'sending' || value.lease_token !== claimed.lease_token) return;
        tx.update(ref, {
          status: retrying ? 'retry' : 'failed',
          attempt: nextAttempt,
          next_attempt_at: retrying ? new Date(Date.parse(clock()) + wait) : null,
          last_error: String(error && error.code || 'SEND_FAILED').slice(0, 80),
          lease_token: null,
          lease_until: null,
          updated_at: FV.serverTimestamp()
        });
      });
      return { sent: false, status: retrying ? 'retry' : 'failed' };
    }
  }

  async function reconcileGuardOutbox(ref, now) {
    let queued = false;
    let deliver = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const value = snap.data() || {};
      const status = String(value.status || '');
      if (['queued', 'retry', 'sending'].indexOf(status) === -1) return;
      if (outboxExpired(value, now)) {
        cancelGuardOutbox(tx, ref, 'outbox-expired');
        return;
      }
      const sid = String(value.station_id || '');
      const guardId = String(value.guard_id || '');
      const recipient = String(value.recipient_uid || '');
      if (!ID_RE.test(sid) || !ID_RE.test(guardId) || !AUTH_UID_RE.test(recipient)) {
        cancelGuardOutbox(tx, ref, 'outbox-invalid');
        return;
      }
      const related = await Promise.all([
        tx.get(guardRef(sid, guardId)),
        tx.get(liveUserRef(sid, recipient))
      ]);
      const guard = related[0];
      if (!guardOutboxCurrent(value, guard)) {
        cancelGuardOutbox(tx, ref, 'guard-revision-stale');
        return;
      }
      if (!recipientIsActive(related[1], sid)) {
        cancelGuardOutbox(tx, ref, 'recipient-inactive');
        return;
      }
      if (status === 'queued') {
        deliver = true;
        return;
      }
      if (status === 'retry') {
        const nextAttemptAt = timeMillis(value.next_attempt_at);
        if (Number.isFinite(nextAttemptAt) && nextAttemptAt > now) return;
      }
      if (status === 'sending') {
        const leaseUntil = timeMillis(value.lease_until);
        if (Number.isFinite(leaseUntil) && leaseUntil > now) return;
      }
      tx.update(ref, {
        status: 'queued',
        queued_at: FV.serverTimestamp(),
        lease_token: null,
        lease_until: null
      });
      queued = true;
    });
    return { queued, deliver };
  }

  async function resumeGuardOutbox() {
    const jobs = await resumeGuardNotificationJobs();
    const collected = new Map();
    for (const status of ['retry', 'sending', 'queued']) {
      const snap = await db.collectionGroup('guard_outbox')
        .where('status', '==', status).orderBy('created_at', 'asc').limit(100).get();
      snap.docs.forEach((doc) => collected.set(doc.ref.path, doc));
    }
    const now = Date.parse(clock());
    let queued = 0;
    for (const doc of collected.values()) {
      const result = await reconcileGuardOutbox(doc.ref, now);
      if (result.queued) queued += 1;
      if (result.deliver) await deliverGuardOutbox(doc.ref);
    }
    return { scanned: collected.size, queued, jobs };
  }

  return Object.freeze({
    getStatus,
    getManagerSetup,
    previewPolicy,
    savePolicy,
    previewSource,
    saveSource,
    sweepExpiredSources,
    getModeOptions,
    setRuntimeMode,
    previewCutover,
    promoteToNew,
    runPlanner,
    getDraftPreview,
    publish,
    rollback,
    getMy,
    getEffectiveWorkdays,
    effectiveWorkDaysForStation,
    getStation,
    getStationRange,
    getLegacyCompatibility,
    getGuardBoard,
    getGuardManagerBoard,
    getMyGuardAttendance,
    getGuardLoadStatistics,
    respond,
    manageGuard,
    signupGuard,
    enqueueGuardOpenNotifications,
    deliverOutbox,
    resumeOutbox,
    fanoutGuardOutbox,
    resumeGuardNotificationJobs,
    deliverGuardOutbox,
    resumeGuardOutbox,
    MODE
  });
}

module.exports = {
  createScheduleRuntime,
  ScheduleRuntimeError,
  MODE,
  MEMBER_ROLES
};
