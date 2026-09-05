'use strict';

// Two-party station transfers.
//
// A transfer is deliberately not a role edit.  Source HR opens a request and
// the destination station accepts it; only then does the existing crash-safe
// identity coordinator move the live identity.  Names are search input only —
// every mutation is pinned to a Firebase UID and to an immutable snapshot.

const UID_RE = /^[^\u0000-\u001f\u007f/]{1,128}$/u;
const STATION_RE = /^[a-z0-9_-]{2,80}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{16,100}$/;
const ACTIVE_STATES = ['pending_target', 'processing', 'needs_recovery'];
const TARGET_APPROVERS = ['hr_coordinator', 'station_commander'];

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createStationTransferService(deps) {
  const d = plain(deps) ? deps : {};
  const db = d.db;
  const getUser = d.getUser;
  const isSuper = d.isSuper;
  const HttpsError = d.HttpsError;
  const FieldValue = d.FieldValue;
  const identityCoordinator = d.identityCoordinator;
  const stableHash = d.stableHash;
  const namePrefixes = d.namePrefixes;
  const rankOf = d.rankOf;
  const resolveStation = d.resolveStation;
  const listStations = d.listStations;

  if (!db || typeof db.collection !== 'function' ||
      typeof db.runTransaction !== 'function') {
    throw new TypeError('db with collection and runTransaction is required');
  }
  if (typeof getUser !== 'function' || typeof isSuper !== 'function' ||
      typeof HttpsError !== 'function' || typeof stableHash !== 'function' ||
      typeof namePrefixes !== 'function' || typeof rankOf !== 'function' ||
      typeof resolveStation !== 'function' || typeof listStations !== 'function') {
    throw new TypeError('station transfer dependencies are incomplete');
  }
  if (!FieldValue || typeof FieldValue.serverTimestamp !== 'function' ||
      typeof FieldValue.delete !== 'function') {
    throw new TypeError('FieldValue serverTimestamp/delete are required');
  }
  if (!identityCoordinator ||
      typeof identityCoordinator.acquireAssignment !== 'function' ||
      typeof identityCoordinator.runAssignment !== 'function' ||
      typeof identityCoordinator.resumeOperation !== 'function' ||
      typeof identityCoordinator.getOperation !== 'function') {
    throw new TypeError('identityCoordinator is required');
  }

  function fail(code, message, details) {
    return new HttpsError(code, message, details);
  }

  function requireAuth(req) {
    if (!req || !req.auth || !UID_RE.test(String(req.auth.uid || ''))) {
      throw fail('unauthenticated', 'צריך להיות מחובר.');
    }
    return req.auth;
  }

  function exactData(req, allowed) {
    const value = req && req.data === undefined ? {} : req && req.data;
    if (!plain(value)) throw fail('invalid-argument', 'נתוני הבקשה אינם תקינים.');
    if (Object.keys(value).some((key) => allowed.indexOf(key) === -1)) {
      throw fail('invalid-argument', 'הבקשה כוללת שדות שאינם מותרים.');
    }
    return value;
  }

  function stationFromToken(token) {
    const sid = String((token || {}).stationId || '').trim();
    if (!STATION_RE.test(sid)) {
      throw fail('failed-precondition', 'לחשבון אין שיוך תחנה תקין.');
    }
    return sid;
  }

  function profileRef(sid, uid) {
    return db.collection('stations').doc(sid).collection('users').doc(uid);
  }

  function requestRef(requestId) {
    return db.collection('station_transfer_requests').doc(requestId);
  }

  function lockRef(uid) {
    return db.collection('station_transfer_locks').doc(uid);
  }

  function activeRequestsQuery(uid) {
    return db.collection('station_transfer_requests')
      .where('target_uid', '==', uid)
      .where('status', 'in', ACTIVE_STATES)
      .limit(2);
  }

  function lockOwnedBy(lock, requestId, uid) {
    return !!lock && String(lock.request_id || '') === String(requestId || '') &&
      String(lock.target_uid || '') === String(uid || '');
  }

  function canonicalLock(requestId, uid, status, stamp, operationId) {
    const value = {
      request_id: requestId,
      target_uid: uid,
      status,
      updated_at: stamp
    };
    if (operationId) value.operation_id = operationId;
    return value;
  }

  function soleActiveRequest(activeSnap, requestId, uid) {
    const docs = activeSnap && Array.isArray(activeSnap.docs) ? activeSnap.docs : [];
    return docs.length === 1 && String(docs[0].id || '') === String(requestId || '') &&
      String((docs[0].data() || {}).target_uid || '') === String(uid || '');
  }

  function operationRef(uid) {
    return db.collection('identity_operations').doc(uid);
  }

  function scheduleAccessRef(sid, uid) {
    return db.collection('stations').doc(sid).collection('schedule_access').doc(uid);
  }

  function revokeScheduleAccess(tx, ref, current, reason, actorUid, stamp) {
    if (!current || (current.active === false &&
        (!Array.isArray(current.roles) || current.roles.length === 0))) return;
    tx.set(ref, {
      active: false,
      roles: [],
      revision: Math.max(1, Number(current.revision || 0) + 1),
      disabled_reason: reason,
      updated_at: stamp,
      updated_by_uid: actorUid
    }, { merge: true });
  }

  function snapshotData(snap) {
    return snap && snap.exists ? (snap.data() || {}) : null;
  }

  function activeProfile(profile, sid) {
    if (!profile || profile.is_active === false || profile.active === false) return false;
    const embedded = String(profile.stationId || profile.station || '');
    return !embedded || embedded === sid;
  }

  function sameRole(profile, token) {
    return String((profile || {}).role || '') === String((token || {}).role || '');
  }

  function liveOperation(value) {
    return value && (value.status === 'processing' || value.status === 'needs_recovery');
  }

  function normalizeQuery(value) {
    return String(value || '').trim().toLowerCase()
      .replace(/["'`׳״]/g, '').replace(/\s+/g, ' ');
  }

  function safePersonView(uid, profile, sid) {
    return {
      uid,
      full_name: String(profile.full_name || '').slice(0, 160),
      employee_number: String(profile.employee_number || '').slice(0, 12),
      role: String(profile.role || '').slice(0, 80),
      shift: String(profile.shift || profile.crew || '').slice(0, 8),
      station_id: sid
    };
  }

  async function requireSuperActor(auth, requestedStationId) {
    const sid = String(requestedStationId || '').trim();
    if (!STATION_RE.test(sid)) {
      throw fail('invalid-argument',
        'מנהל המערכת חייב לבחור תחנה מפורשת ותקינה לפעולת ההעברה.');
    }
    const station = await resolveStation(sid);
    if (!station || station.active !== true || String(station.id || '') !== sid ||
        !String(station.districtId || '')) {
      throw fail('failed-precondition', 'התחנה שנבחרה אינה פעילה או אינה מוגדרת.');
    }
    return { auth, kind: 'super', stationId: sid, role: 'super_admin' };
  }

  function requireMatchingScope(requestedStationId, stationId) {
    if (requestedStationId === undefined) return;
    const sid = String(requestedStationId || '').trim();
    if (!STATION_RE.test(sid)) {
      throw fail('invalid-argument', 'תחום התחנה לפעולת ההעברה אינו תקין.');
    }
    if (sid !== stationId) {
      throw fail('permission-denied', 'פעולת ההעברה אינה שייכת לתחנה הפעילה שלך.');
    }
  }

  async function requireLiveSourceActor(req, requestedStationId) {
    const auth = requireAuth(req);
    if (isSuper(auth) === true) return requireSuperActor(auth, requestedStationId);
    const token = auth.token || {};
    if (String(token.role || '') !== 'hr_coordinator') {
      throw fail('permission-denied',
        'פתיחת העברה מותרת לרכז/ת משאבי אנוש או למנהל המערכת.');
    }
    const sid = stationFromToken(token);
    requireMatchingScope(requestedStationId, sid);
    const profile = snapshotData(await profileRef(sid, auth.uid).get());
    if (!activeProfile(profile, sid) || !sameRole(profile, token)) {
      throw fail('permission-denied', 'לרכז/ת אין שיוך פעיל לתחנת המקור.');
    }
    return { auth, kind: 'hr', stationId: sid };
  }

  async function requireLiveTargetActor(req, requestedStationId) {
    const auth = requireAuth(req);
    if (isSuper(auth) === true) return requireSuperActor(auth, requestedStationId);
    const token = auth.token || {};
    const role = String(token.role || '');
    if (TARGET_APPROVERS.indexOf(role) === -1) {
      throw fail('permission-denied',
        'אישור העברה מותר לרכז/ת משאבי אנוש או למפקד/ת תחנת היעד.');
    }
    const sid = stationFromToken(token);
    requireMatchingScope(requestedStationId, sid);
    const profile = snapshotData(await profileRef(sid, auth.uid).get());
    if (!activeProfile(profile, sid) || !sameRole(profile, token)) {
      throw fail('permission-denied', 'למאשר אין שיוך פעיל לתחנת היעד.');
    }
    return { auth, kind: 'target', stationId: sid, role };
  }

  async function search(req) {
    const data = exactData(req, ['name', 'query', 'station_id']);
    const actor = await requireLiveSourceActor(req, data.station_id);
    if (Object.prototype.hasOwnProperty.call(data, 'name') &&
        Object.prototype.hasOwnProperty.call(data, 'query')) {
      throw fail('invalid-argument', 'יש למסור שדה שם אחד בלבד.');
    }
    const query = normalizeQuery(
      Object.prototype.hasOwnProperty.call(data, 'name') ? data.name : data.query);
    if (query.length < 2 || query.length > 80) {
      throw fail('invalid-argument', 'יש להזין לפחות שני תווים בשם.');
    }
    const prefix = query.slice(0, 20);
    const snap = await db.collection('directory')
      .where('name_prefixes', 'array-contains', prefix).limit(25).get();
    const rows = [];
    for (const doc of (snap.docs || [])) {
      const directory = doc.data() || {};
      const sid = String(directory.station || '');
      if (!UID_RE.test(doc.id) || !STATION_RE.test(sid) ||
          directory.is_active === false || directory.active === false) continue;
      if (sid !== actor.stationId) continue;
      const profile = snapshotData(await profileRef(sid, doc.id).get());
      if (!activeProfile(profile, sid)) continue;
      rows.push(safePersonView(doc.id, profile, sid));
    }
    rows.sort((a, b) => (a.full_name + '\u0000' + a.uid)
      .localeCompare(b.full_name + '\u0000' + b.uid, 'he'));
    return { ok: true, people: rows, targets: await transferTargets(actor.stationId) };
  }

  async function targetIdentity(uid) {
    let user;
    try {
      user = await getUser(uid);
    } catch (error) {
      throw fail('not-found', 'המשתמש שנבחר אינו קיים עוד.');
    }
    if (user.disabled === true) {
      throw fail('failed-precondition', 'המשתמש מושבת ואינו ניתן להעברה.');
    }
    const claims = plain(user.customClaims) ? user.customClaims : {};
    const sid = String(claims.stationId || '');
    if (!STATION_RE.test(sid) || !String(claims.emp || '') || !String(claims.role || '')) {
      throw fail('failed-precondition', 'למשתמש אין שיוך פעיל שניתן להעביר.');
    }
    return { user, claims, sid };
  }

  function requestFingerprint(value) {
    return stableHash({
      fingerprint_version: 2,
      request_id: value.request_id,
      target_uid: value.target_uid,
      source_station_id: value.source_station_id,
      source_district_id: value.source_district_id,
      target_station_id: value.target_station_id,
      target_district_id: value.target_district_id,
      employee_number: value.employee_number,
      role: value.role,
      shift: value.shift,
      full_name: value.full_name,
      email: value.email,
      phone: value.phone,
      created_by: value.created_by
    });
  }

  function desiredClaimsFor(value) {
    return {
      role: String(value.role || ''),
      stationId: String(value.target_station_id || ''),
      districtId: String(value.target_district_id || ''),
      shift: String(value.shift || ''),
      emp: String(value.employee_number || '')
    };
  }

  function transferIntent(value) {
    return stableHash({
      kind: 'transfer_station',
      request_id: value.request_id,
      fingerprint: value.fingerprint,
      desired_claims: desiredClaimsFor(value)
    });
  }

  function operationMatchesTransfer(operation, value, opId) {
    if (!operation || operation.op_id !== opId ||
        operation.target_uid !== value.target_uid ||
        operation.kind !== 'transfer_station' ||
        operation.intent_fingerprint !== transferIntent(value)) return false;
    const summary = plain(operation.plan_summary) ? operation.plan_summary : {};
    return String(summary.kind || '') === 'transfer_station' &&
      String(summary.emp || '') === String(value.employee_number || '') &&
      String(summary.role || '') === String(value.role || '') &&
      String(summary.shift || '') === String(value.shift || '') &&
      String(summary.stationId || '') === String(value.target_station_id || '') &&
      String(summary.districtId || '') === String(value.target_district_id || '');
  }

  async function transferTargets(sourceStationId) {
    const rows = await listStations();
    if (!Array.isArray(rows)) {
      throw fail('internal', 'קטלוג תחנות היעד אינו זמין.');
    }
    return rows.filter((row) => row && row.active === true &&
      STATION_RE.test(String(row.id || '')) &&
      String(row.id || '') !== String(sourceStationId || '') &&
      String(row.districtId || ''))
      .map((row) => ({
        station_id: String(row.id),
        name: String(row.name || row.id).slice(0, 160),
        district_id: String(row.districtId).slice(0, 80)
      }))
      .sort((a, b) => (a.name + '\u0000' + a.station_id)
        .localeCompare(b.name + '\u0000' + b.station_id, 'he'));
  }

  async function create(req) {
    const data = exactData(req,
      ['target_uid', 'target_station_id', 'request_id', 'station_id']);
    const actor = await requireLiveSourceActor(req, data.station_id);
    const uid = String(data.target_uid || '');
    const targetSid = String(data.target_station_id || '');
    const requestId = String(data.request_id || '');
    if (!UID_RE.test(uid) || !STATION_RE.test(targetSid) || !REQUEST_RE.test(requestId)) {
      throw fail('invalid-argument', 'מזהה משתמש, תחנת יעד או מזהה בקשה אינם תקינים.');
    }

    // Resolve idempotent replays before reading the employee's live identity.
    // A completed transfer has already moved that identity to the destination,
    // so validating it as a new request would incorrectly reject a safe replay.
    const prior = snapshotData(await requestRef(requestId).get());
    if (prior) {
      const replay = await db.runTransaction(async (tx) => {
        const refs = [requestRef(requestId), lockRef(uid)];
        const snaps = await Promise.all([tx.get(refs[0]), tx.get(refs[1]),
          tx.get(activeRequestsQuery(uid))]);
        const current = snapshotData(snaps[0]);
        const lock = snapshotData(snaps[1]);
        const activeSnap = snaps[2];
        if (!current || (actor.kind !== 'super' && current.created_by !== actor.auth.uid) ||
            current.target_uid !== uid || current.target_station_id !== targetSid) {
          throw fail('already-exists', 'מזהה הבקשה כבר נמצא בשימוש.');
        }
        if (current.source_station_id !== actor.stationId) {
          throw fail('permission-denied',
            'אפשר לצפות מחדש רק בבקשה שיצאה מהתחנה הפעילה שלך.');
        }
        if (current.fingerprint !== requestFingerprint(current)) {
          throw fail('failed-precondition', 'תוכן הבקשה השתנה לאחר שנחתם.');
        }
        if (ACTIVE_STATES.indexOf(String(current.status || '')) === -1) {
          return { changed: false, value: current };
        }
        if (!soleActiveRequest(activeSnap, requestId, uid)) {
          throw fail('failed-precondition',
            'נמצאה סתירה בין בקשת ההעברה הפעילה לבין נעילת העובד.');
        }
        if (lock && !lockOwnedBy(lock, requestId, uid)) {
          throw fail('failed-precondition', 'נעילת העובד שייכת לבקשת העברה אחרת.');
        }
        if (!lock) {
          tx.set(refs[1], canonicalLock(requestId, uid, current.status,
            FieldValue.serverTimestamp(), current.operation_id));
          return { changed: true, value: current };
        }
        return { changed: false, value: current };
      });
      return {
        ok: true,
        changed: replay.changed,
        request_id: requestId,
        status: String(replay.value.status || ''),
        target_uid: uid,
        source_station_id: String(replay.value.source_station_id || ''),
        target_station_id: String(replay.value.target_station_id || '')
      };
    }

    const identity = await targetIdentity(uid);
    if (identity.claims.super === true) {
      throw fail('failed-precondition', 'חשבון מנהל מערכת אינו מועבר במסלול התחנתי.');
    }
    if (identity.sid === targetSid) {
      throw fail('failed-precondition', 'תחנת היעד זהה לתחנה הנוכחית.');
    }
    if (actor.stationId !== identity.sid) {
      throw fail('permission-denied', 'אפשר להעביר רק עובד פעיל מתחנת המקור שלך.');
    }
    if (actor.kind === 'hr' && rankOf(identity.claims.role) > 3) {
      throw fail('permission-denied',
        'העברת בעל תפקיד פיקודי מחייבת פתיחה על ידי מנהל המערכת.');
    }

    const target = await resolveStation(targetSid);
    if (!target || target.active === false ||
        !STATION_RE.test(String(target.id || targetSid)) || !String(target.districtId || '')) {
      throw fail('failed-precondition', 'תחנת היעד אינה פעילה או אינה מוגדרת.');
    }

    const sourceProfile = snapshotData(await profileRef(identity.sid, uid).get());
    if (!activeProfile(sourceProfile, identity.sid)) {
      throw fail('failed-precondition', 'העובד אינו פעיל עוד בתחנת המקור.');
    }
    const fullName = String(sourceProfile.full_name || '').trim();
    if (!fullName) throw fail('failed-precondition', 'לכרטיס העובד חסר שם מלא.');

    const value = {
      request_id: requestId,
      target_uid: uid,
      source_station_id: identity.sid,
      source_district_id: String(identity.claims.districtId || ''),
      target_station_id: targetSid,
      target_district_id: String(target.districtId || ''),
      employee_number: String(identity.claims.emp || ''),
      role: String(identity.claims.role || ''),
      shift: String(identity.claims.shift || ''),
      full_name: fullName.slice(0, 160),
      email: String(identity.user.email || sourceProfile.email || '').toLowerCase().slice(0, 320),
      phone: String(sourceProfile.phone || '').slice(0, 80),
      status: 'pending_target',
      revision: 1,
      created_by: actor.auth.uid,
      fingerprint_version: 2
    };
    value.fingerprint = requestFingerprint(value);

    const result = await db.runTransaction(async (tx) => {
      const refs = [requestRef(requestId), lockRef(uid), profileRef(identity.sid, uid),
        operationRef(uid)];
      if (actor.kind === 'hr') refs.push(profileRef(actor.stationId, actor.auth.uid));
      const snaps = await Promise.all(refs.map((ref) => tx.get(ref))
        .concat([tx.get(activeRequestsQuery(uid))]));
      const existing = snapshotData(snaps[0]);
      const lock = snapshotData(snaps[1]);
      const liveSource = snapshotData(snaps[2]);
      const operation = snapshotData(snaps[3]);
      const liveActor = actor.kind === 'hr' ? snapshotData(snaps[4]) : null;
      const activeSnap = snaps[snaps.length - 1];
      if (actor.kind === 'hr' && (!activeProfile(liveActor, actor.stationId) ||
          String((liveActor || {}).role || '') !== 'hr_coordinator')) {
        throw fail('permission-denied', 'לרכז/ת אין עוד שיוך פעיל לתחנת המקור.');
      }
      if (!activeProfile(liveSource, identity.sid) ||
          String(liveSource.employee_number || '') !== value.employee_number ||
          String(liveSource.role || '') !== value.role) {
        throw fail('failed-precondition', 'כרטיס העובד השתנה מאז החיפוש. רענן ונסה שוב.');
      }
      if (liveOperation(operation)) {
        throw fail('aborted', 'מתבצעת כבר פעולת זהות אחרת עבור העובד.');
      }
      if (existing) {
        if (existing.fingerprint !== value.fingerprint ||
            existing.created_by !== actor.auth.uid) {
          throw fail('already-exists', 'מזהה הבקשה כבר נמצא בשימוש.');
        }
        if (ACTIVE_STATES.indexOf(String(existing.status || '')) === -1) {
          return { changed: false, value: existing };
        }
        if (!soleActiveRequest(activeSnap, requestId, uid)) {
          throw fail('failed-precondition',
            'נמצאה סתירה בין בקשת ההעברה הפעילה לבין נעילת העובד.');
        }
        if (lock && !lockOwnedBy(lock, requestId, uid)) {
          throw fail('failed-precondition',
            'נעילת העובד שייכת לבקשת העברה אחרת.');
        }
        if (!lock) {
          const repairStamp = FieldValue.serverTimestamp();
          tx.set(refs[1], canonicalLock(requestId, uid, existing.status,
            repairStamp, existing.operation_id));
          return { changed: true, value: existing };
        }
        return { changed: false, value: existing };
      }
      if (activeSnap && activeSnap.size > 0) {
        throw fail('already-exists', 'כבר קיימת בקשת העברה פעילה עבור העובד.');
      }
      if (lock && ACTIVE_STATES.indexOf(String(lock.status || '')) !== -1) {
        throw fail('already-exists', 'כבר קיימת בקשת העברה פעילה עבור העובד.');
      }
      const stamp = FieldValue.serverTimestamp();
      const stored = Object.assign({}, value, { created_at: stamp, updated_at: stamp });
      tx.create(refs[0], stored);
      tx.set(refs[1], canonicalLock(requestId, uid, 'pending_target', stamp));
      const audit = db.collection('admin_audit').doc();
      tx.set(audit, {
        action: 'create_station_transfer', actor_uid: actor.auth.uid,
        target_uid: uid, request_id: requestId, source_station_id: identity.sid,
        target_station_id: targetSid, outcome: 'pending_target', at: stamp
      });
      return { changed: true, value: stored };
    });

    return {
      ok: true, changed: result.changed, request_id: requestId,
      status: String(result.value.status || 'pending_target'), target_uid: uid,
      source_station_id: String(result.value.source_station_id || ''),
      target_station_id: String(result.value.target_station_id || '')
    };
  }

  function transferView(value) {
    return {
      request_id: String(value.request_id || ''),
      target_uid: String(value.target_uid || ''),
      full_name: String(value.full_name || '').slice(0, 160),
      role: String(value.role || '').slice(0, 80),
      shift: String(value.shift || '').slice(0, 8),
      source_station_id: String(value.source_station_id || ''),
      target_station_id: String(value.target_station_id || ''),
      status: String(value.status || ''),
      revision: Number(value.revision || 0)
    };
  }

  async function list(req) {
    const data = exactData(req, ['direction', 'station_id']);
    const direction = String(data.direction || 'incoming');
    if (direction !== 'incoming' && direction !== 'outgoing') {
      throw fail('invalid-argument', 'כיוון הרשימה אינו תקין.');
    }
    let actor;
    let field;
    if (direction === 'incoming') {
      actor = await requireLiveTargetActor(req, data.station_id);
      field = 'target_station_id';
    } else {
      actor = await requireLiveSourceActor(req, data.station_id);
      field = 'source_station_id';
    }
    const snap = await db.collection('station_transfer_requests')
      .where(field, '==', actor.stationId)
      .where('status', 'in', ACTIVE_STATES)
      .limit(100).get();
    const transfers = (snap.docs || []).map((doc) => transferView(doc.data() || {}))
      .filter((row) => ACTIVE_STATES.indexOf(row.status) !== -1)
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'he'));
    const result = { ok: true, direction, transfers };
    if (direction === 'outgoing') result.targets = await transferTargets(actor.stationId);
    return result;
  }

  async function assertTransferStillMatches(value) {
    const identity = await targetIdentity(value.target_uid);
    if (identity.sid !== value.source_station_id ||
        String(identity.claims.emp || '') !== value.employee_number ||
        String(identity.claims.role || '') !== value.role ||
        String(identity.claims.shift || '') !== value.shift ||
        String(identity.claims.districtId || '') !== value.source_district_id ||
        String(identity.user.email || '').toLowerCase() !== String(value.email || '')) {
      throw fail('failed-precondition',
        'זהות העובד השתנתה מאז פתיחת הבקשה. הבקשה הישנה לא תאושר.');
    }
    const profile = snapshotData(await profileRef(value.source_station_id, value.target_uid).get());
    if (!activeProfile(profile, value.source_station_id) ||
        String(profile.employee_number || '') !== value.employee_number ||
        String(profile.role || '') !== value.role ||
        String(profile.crew || profile.shift || '') !== value.shift ||
        String(profile.district || profile.districtId || '') !== value.source_district_id ||
        String(profile.full_name || '').trim().slice(0, 160) !== value.full_name ||
        String(profile.email || identity.user.email || '').toLowerCase().slice(0, 320) !==
          value.email ||
        String(profile.phone || '').slice(0, 80) !== value.phone) {
      throw fail('failed-precondition', 'כרטיס העובד בתחנת המקור השתנה או הוסר.');
    }
    return { identity, profile };
  }

  async function reject(value, actor, reasonCode) {
    const code = String(reasonCode || 'not_accepted');
    if (!/^[a-z0-9_-]{2,80}$/.test(code)) {
      throw fail('invalid-argument', 'סיבת הדחייה אינה תקינה.');
    }
    return db.runTransaction(async (tx) => {
      const reqRef = requestRef(value.request_id);
      const reqSnap = await tx.get(reqRef);
      const current = snapshotData(reqSnap);
      if (!current) throw fail('not-found', 'בקשת ההעברה אינה קיימת.');
      if (current.status === 'rejected') return { changed: false, current };
      if (current.status !== 'pending_target') {
        throw fail('failed-precondition', 'אי אפשר לדחות בקשה שכבר נמצאת בטיפול.');
      }
      if (current.target_station_id !== actor.stationId) {
        throw fail('permission-denied', 'הבקשה אינה מיועדת לתחנה שלך.');
      }
      const currentLockRef = lockRef(current.target_uid);
      const lock = snapshotData(await tx.get(currentLockRef));
      if (lock && !lockOwnedBy(lock, current.request_id, current.target_uid)) {
        throw fail('failed-precondition',
          'נעילת העובד שייכת לבקשת העברה אחרת.');
      }
      const stamp = FieldValue.serverTimestamp();
      tx.set(reqRef, {
        status: 'rejected', revision: Number(current.revision || 1) + 1,
        rejected_by: actor.auth.uid, rejected_at: stamp,
        reason_code: code, updated_at: stamp
      }, { merge: true });
      if (lock) tx.delete(currentLockRef);
      tx.set(db.collection('admin_audit').doc(), {
        action: 'reject_station_transfer', actor_uid: actor.auth.uid,
        target_uid: current.target_uid, request_id: current.request_id,
        outcome: 'rejected', reason_code: code, at: stamp
      });
      return { changed: true, current };
    });
  }

  async function claimApproval(requestId, actor, opId) {
    return db.runTransaction(async (tx) => {
      const reqRef = requestRef(requestId);
      const refs = [reqRef, lockRef('__placeholder__'), operationRef('__placeholder__'),
        profileRef(actor.stationId, actor.auth.uid)];
      const first = await tx.get(reqRef);
      const current = snapshotData(first);
      if (!current) throw fail('not-found', 'בקשת ההעברה אינה קיימת.');
      refs[1] = lockRef(current.target_uid);
      refs[2] = operationRef(current.target_uid);
      const targetGrantRef = scheduleAccessRef(current.target_station_id, current.target_uid);
      const rest = await Promise.all([tx.get(refs[1]), tx.get(refs[2]), tx.get(refs[3]),
        tx.get(profileRef(current.source_station_id, current.target_uid)),
        tx.get(targetGrantRef), tx.get(activeRequestsQuery(current.target_uid))]);
      const lock = snapshotData(rest[0]);
      const operation = snapshotData(rest[1]);
      const liveActor = snapshotData(rest[2]);
      const sourceProfile = snapshotData(rest[3]);
      const targetGrant = snapshotData(rest[4]);
      const activeSnap = rest[5];
      const exactOperation = operationMatchesTransfer(operation, current, opId) &&
        ['processing', 'needs_recovery', 'completed'].indexOf(operation.status) !== -1;
      if (actor.kind !== 'super' && (!activeProfile(liveActor, actor.stationId) ||
          String((liveActor || {}).role || '') !== actor.role)) {
        throw fail('permission-denied', 'למאשר אין עוד שיוך פעיל לתחנת היעד.');
      }
      if (current.target_station_id !== actor.stationId) {
        throw fail('permission-denied', 'הבקשה אינה מיועדת לתחנה שלך.');
      }
      // Re-read the server-owned station catalogue inside the same Firestore
      // transaction that claims the transfer. A concurrent deactivation or
      // district edit invalidates/retries this transaction before identity
      // side effects can begin.
      const liveTarget = await resolveStation(current.target_station_id, tx);
      if (!liveTarget || liveTarget.active !== true ||
          String(liveTarget.id || '') !== String(current.target_station_id || '') ||
          String(liveTarget.districtId || '') !== String(current.target_district_id || '')) {
        throw fail('failed-precondition',
          'תחנת היעד אינה פעילה עוד או שהשיוך המחוזי שלה השתנה.');
      }
      if (current.created_by === actor.auth.uid || current.target_uid === actor.auth.uid) {
        throw fail('permission-denied', 'יוזם הבקשה או העובד המועבר אינם יכולים לאשר אותה.');
      }
      if (current.fingerprint !== requestFingerprint(current)) {
        throw fail('failed-precondition', 'תוכן הבקשה השתנה לאחר שנחתם.');
      }
      if (!soleActiveRequest(activeSnap, requestId, current.target_uid)) {
        throw fail('failed-precondition',
          'נמצאה סתירה בין בקשת ההעברה הפעילה לבין נעילת העובד.');
      }
      if (lock && !lockOwnedBy(lock, requestId, current.target_uid)) {
        throw fail('failed-precondition', 'נעילת בקשת ההעברה שייכת לבקשה אחרת.');
      }
      if ((!activeProfile(sourceProfile, current.source_station_id) ||
          String(sourceProfile.employee_number || '') !== current.employee_number ||
          String(sourceProfile.role || '') !== current.role) && !exactOperation) {
        throw fail('failed-precondition', 'כרטיס העובד השתנה מאז פתיחת הבקשה.');
      }
      if (current.status === 'processing') {
        if (current.operation_id !== opId || (operation && !exactOperation)) {
          throw fail('aborted', 'בקשת ההעברה משויכת לפעולת זהות אחרת.');
        }
        const processingStamp = FieldValue.serverTimestamp();
        revokeScheduleAccess(tx, targetGrantRef, targetGrant,
          'station_transfer_target_reset', actor.auth.uid, processingStamp);
        tx.set(refs[1], canonicalLock(requestId, current.target_uid,
          'processing', processingStamp, opId));
        return current;
      }
      if (current.status !== 'pending_target' && current.status !== 'needs_recovery') {
        throw fail('failed-precondition', 'בקשת ההעברה אינה ממתינה לאישור.');
      }
      if (current.status === 'needs_recovery' && !exactOperation) {
        throw fail('failed-precondition',
          'פעולת ההתאוששות אינה תואמת לבקשת ההעברה השמורה.');
      }
      if (liveOperation(operation) && !exactOperation) {
        throw fail('aborted', 'פעולת זהות אחרת כבר פעילה עבור העובד.');
      }
      const stamp = FieldValue.serverTimestamp();
      revokeScheduleAccess(tx, targetGrantRef, targetGrant,
        'station_transfer_target_reset', actor.auth.uid, stamp);
      tx.set(reqRef, {
        status: 'processing', revision: Number(current.revision || 1) + 1,
        approved_by: actor.auth.uid, approved_at: stamp,
        operation_id: opId, updated_at: stamp
      }, { merge: true });
      tx.set(refs[1], canonicalLock(requestId, current.target_uid,
        'processing', stamp, opId));
      return Object.assign({}, current, { status: 'processing', operation_id: opId,
        approved_by: actor.auth.uid });
    });
  }

  async function markFailed(requestId, uid, opId, error) {
    await db.runTransaction(async (tx) => {
        const ref = requestRef(requestId);
        const snap = await tx.get(ref);
        const current = snapshotData(snap);
        if (!current || current.operation_id !== opId || current.status !== 'processing') return;
        const currentLockRef = lockRef(current.target_uid);
        const rest = await Promise.all([tx.get(currentLockRef),
          tx.get(activeRequestsQuery(current.target_uid)),
          tx.get(operationRef(current.target_uid))]);
        const lock = snapshotData(rest[0]);
        const activeSnap = rest[1];
        const operation = snapshotData(rest[2]);
        const hasPlan = operationMatchesTransfer(operation, current, opId) &&
          (operation.status === 'processing' || operation.status === 'needs_recovery' ||
           operation.status === 'completed');
        const stamp = FieldValue.serverTimestamp();
        const lockConflict = String(uid || '') !== String(current.target_uid || '') ||
          !soleActiveRequest(activeSnap, requestId, current.target_uid) ||
          (lock && !lockOwnedBy(lock, requestId, current.target_uid));
        if (lockConflict) {
          tx.set(ref, {
            status: 'needs_recovery',
            revision: Number(current.revision || 1) + 1,
            reason_code: 'transfer_lock_conflict',
            lock_anomaly: 'foreign_or_duplicate',
            last_error_code: String((error && error.code) || 'internal').slice(0, 80),
            updated_at: stamp
          }, { merge: true });
          return;
        }
        if (hasPlan) {
          tx.set(ref, {
            status: 'needs_recovery',
            revision: Number(current.revision || 1) + 1,
            reason_code: 'identity_operation_incomplete',
            last_error_code: String((error && error.code) || 'internal').slice(0, 80),
            updated_at: stamp
          }, { merge: true });
          tx.set(currentLockRef, canonicalLock(requestId, current.target_uid,
            'needs_recovery', stamp, opId));
        } else {
          tx.set(ref, {
            status: 'pending_target', revision: Number(current.revision || 1) + 1,
            approved_by: FieldValue.delete(),
            approved_at: FieldValue.delete(), operation_id: FieldValue.delete(),
            last_error_code: String((error && error.code) || 'internal').slice(0, 80),
            updated_at: stamp
          }, { merge: true });
          tx.set(currentLockRef, canonicalLock(requestId, current.target_uid,
            'pending_target', stamp));
        }
      });
  }

  async function completeApproval(value, actor, opId) {
    const desiredClaims = desiredClaimsFor(value);
    const intent = transferIntent(value);
    let operation = await identityCoordinator.getOperation(value.target_uid);
    let acquired = null;

    if (!operationMatchesTransfer(operation, value, opId)) {
      const live = await assertTransferStillMatches(value);
      acquired = await identityCoordinator.acquireAssignment({
        uid: value.target_uid,
        opId,
        kind: 'transfer_station',
        actorUid: actor.auth.uid,
        actorEmail: actor.auth.token && actor.auth.token.email,
        previousClaims: live.identity.claims,
        previousEmp: live.identity.claims.emp,
        previousStation: live.identity.claims.stationId,
        requireRequest: false,
        attachPendingRequest: false,
        requestId: '',
        requestGeneration: '',
        blockIfAssigned: false,
        intentFingerprint: intent,
        employeeMode: 'fixed',
        wantedEmp: value.employee_number,
        auditAction: 'approve_station_transfer',
        auditDetails: {
          request_id: value.request_id,
          source_station_id: value.source_station_id,
          target_station_id: value.target_station_id
        },
        makePlan: function () {
          return {
            desiredClaims,
            desiredProfile: {
              full_name: value.full_name,
              name_prefixes: namePrefixes(value.full_name),
              email: value.email,
              phone: value.phone,
              role: value.role,
              shift: value.shift,
              stationId: value.target_station_id,
              districtId: value.target_district_id
            }
          };
        }
      });
      operation = acquired.operation ||
        await identityCoordinator.getOperation(value.target_uid);
    }
    if (!operationMatchesTransfer(operation, value, opId)) {
      throw fail('failed-precondition',
        'פעולת הזהות אינה תואמת לבקשת ההעברה החתומה.');
    }
    const result = {
      ok: true,
      request_id: value.request_id,
      target_uid: value.target_uid,
      source_station_id: value.source_station_id,
      target_station_id: value.target_station_id,
      status: 'completed',
      message: 'העברת התחנה אושרה. העובד צריך להתחבר מחדש.'
    };
    if (operation.status === 'needs_recovery') {
      const resumed = await identityCoordinator.resumeOperation({
        uid: value.target_uid,
        opId,
        planFingerprint: operation.plan_fingerprint,
        actorUid: actor.auth.uid,
        actorEmail: actor.auth.token && actor.auth.token.email
      });
      operation = resumed.operation || await identityCoordinator.getOperation(value.target_uid);
    }
    if (operation.status !== 'completed' && (!acquired || acquired.type !== 'completed')) {
      await identityCoordinator.runAssignment(value.target_uid, operation.op_id, result, false);
    }

    await db.runTransaction(async (tx) => {
      const reqRef = requestRef(value.request_id);
      const oldGrantRef = scheduleAccessRef(value.source_station_id, value.target_uid);
      const targetGrantRef = scheduleAccessRef(value.target_station_id, value.target_uid);
      const transferLockRef = lockRef(value.target_uid);
      const snaps = await Promise.all([tx.get(reqRef), tx.get(operationRef(value.target_uid)),
        tx.get(oldGrantRef), tx.get(targetGrantRef), tx.get(transferLockRef)]);
      const current = snapshotData(snaps[0]);
      const finished = snapshotData(snaps[1]);
      const oldGrant = snapshotData(snaps[2]);
      const targetGrant = snapshotData(snaps[3]);
      const lock = snapshotData(snaps[4]);
      if (!current || current.operation_id !== opId) {
        throw fail('failed-precondition', 'בקשת ההעברה אינה תואמת לפעולה שהושלמה.');
      }
      // Two workers may finish the same idempotent identity operation.  The
      // request state is the single completion fence, so only the first one
      // writes the final audit row or increments the grant revision.
      if (current.status === 'completed') return false;
      if (!finished || finished.op_id !== opId || finished.status !== 'completed') {
        throw fail('failed-precondition', 'פעולת הזהות עדיין לא הושלמה.');
      }
      const stamp = FieldValue.serverTimestamp();
      tx.set(reqRef, {
        status: 'completed', revision: Number(current.revision || 1) + 1,
        completed_at: stamp, updated_at: stamp, result: result
      }, { merge: true });
      if (lockOwnedBy(lock, value.request_id, value.target_uid)) {
        tx.delete(transferLockRef);
      }
      revokeScheduleAccess(tx, oldGrantRef, oldGrant,
        'station_transfer', actor.auth.uid, stamp);
      revokeScheduleAccess(tx, targetGrantRef, targetGrant,
        'station_transfer_target_reset', actor.auth.uid, stamp);
      tx.set(db.collection('admin_audit').doc(), {
        action: 'complete_station_transfer', actor_uid: actor.auth.uid,
        target_uid: value.target_uid, request_id: value.request_id,
        source_station_id: value.source_station_id,
        target_station_id: value.target_station_id,
        outcome: 'done', at: stamp
      });
      return true;
    });
    return result;
  }

  async function decide(req) {
    const data = exactData(req, ['request_id', 'decision', 'reason_code', 'station_id']);
    const actor = await requireLiveTargetActor(req, data.station_id);
    const requestId = String(data.request_id || '');
    const decision = String(data.decision || '');
    if (!REQUEST_RE.test(requestId) || (decision !== 'approve' && decision !== 'reject')) {
      throw fail('invalid-argument', 'מזהה בקשה או החלטה אינם תקינים.');
    }
    const initial = snapshotData(await requestRef(requestId).get());
    if (!initial) throw fail('not-found', 'בקשת ההעברה אינה קיימת.');
    if (initial.target_station_id !== actor.stationId) {
      throw fail('permission-denied', 'הבקשה אינה מיועדת לתחנה שלך.');
    }
    if (initial.status === 'completed' && decision === 'approve') {
      return plain(initial.result) ? initial.result : {
        ok: true,
        request_id: requestId,
        target_uid: initial.target_uid,
        source_station_id: initial.source_station_id,
        target_station_id: initial.target_station_id,
        status: 'completed',
        message: 'העברת התחנה אושרה. העובד צריך להתחבר מחדש.'
      };
    }
    if (decision === 'reject') {
      const outcome = await reject(initial, actor, data.reason_code);
      return { ok: true, changed: outcome.changed, request_id: requestId, status: 'rejected' };
    }

    const target = await resolveStation(initial.target_station_id);
    if (!target || target.active !== true ||
        String(target.id || '') !== String(initial.target_station_id || '') ||
        String(target.districtId || '') !== String(initial.target_district_id || '')) {
      throw fail('failed-precondition',
        'תחנת היעד אינה פעילה עוד או שהשיוך המחוזי שלה השתנה.');
    }

    const opId = 'transfer-' + stableHash({ request_id: requestId,
      target_uid: initial.target_uid, fingerprint: initial.fingerprint }).slice(0, 40);
    const claimed = await claimApproval(requestId, actor, opId);
    try {
      return await completeApproval(claimed, actor, opId);
    } catch (error) {
      await markFailed(requestId, claimed.target_uid, opId, error);
      throw error;
    }
  }

  async function cancel(req) {
    const data = exactData(req, ['request_id', 'station_id']);
    const actor = await requireLiveSourceActor(req, data.station_id);
    const requestId = String(data.request_id || '');
    if (!REQUEST_RE.test(requestId)) throw fail('invalid-argument', 'מזהה הבקשה אינו תקין.');
    return db.runTransaction(async (tx) => {
      const ref = requestRef(requestId);
      const snap = await tx.get(ref);
      const current = snapshotData(snap);
      if (!current) throw fail('not-found', 'בקשת ההעברה אינה קיימת.');
      if (current.source_station_id !== actor.stationId) {
        throw fail('permission-denied', 'אפשר לבטל רק בקשה שיצאה מתחנת המקור שלך.');
      }
      if (current.status === 'cancelled') {
        return { ok: true, changed: false, request_id: requestId, status: 'cancelled' };
      }
      if (current.status !== 'pending_target') {
        throw fail('failed-precondition', 'אי אפשר לבטל בקשה שכבר נמצאת בטיפול.');
      }
      const currentLockRef = lockRef(current.target_uid);
      const lock = snapshotData(await tx.get(currentLockRef));
      if (lock && !lockOwnedBy(lock, current.request_id, current.target_uid)) {
        throw fail('failed-precondition',
          'נעילת העובד שייכת לבקשת העברה אחרת.');
      }
      const stamp = FieldValue.serverTimestamp();
      tx.set(ref, {
        status: 'cancelled', revision: Number(current.revision || 1) + 1,
        cancelled_by: actor.auth.uid, cancelled_at: stamp, updated_at: stamp
      }, { merge: true });
      if (lock) tx.delete(currentLockRef);
      tx.set(db.collection('admin_audit').doc(), {
        action: 'cancel_station_transfer', actor_uid: actor.auth.uid,
        target_uid: current.target_uid, request_id: requestId,
        outcome: 'cancelled', at: stamp
      });
      return { ok: true, changed: true, request_id: requestId, status: 'cancelled' };
    });
  }

  return Object.freeze({ search, create, list, decide, cancel });
}

module.exports = Object.freeze({
  UID_RE,
  STATION_RE,
  REQUEST_RE,
  createStationTransferService
});
