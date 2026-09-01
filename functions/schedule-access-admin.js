'use strict';

// Server-only administration for the local "schedule manager" capability.
//
// This module deliberately does not know Firebase Admin, Auth claims writes,
// or a UI.  Its dependencies are injected so the authorization boundary can be
// tested without a live project.  The caller's station and the target's station
// always come from server-held identity data; callers can never choose a path.

const scheduleAccess = require('./schedule-access');

const STATION_ID_RE = /^[a-z0-9_-]{2,80}$/;

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createScheduleAccessAdmin(deps) {
  const d = plain(deps) ? deps : {};
  const db = d.db;
  const getUser = d.getUser;
  const isSuper = d.isSuper;
  const HttpsError = d.HttpsError;
  const FieldValue = d.FieldValue;
  const openAudit = d.openAudit;
  const sealAudit = d.sealAudit;

  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new TypeError('db with collection and runTransaction is required');
  }
  if (typeof getUser !== 'function' || typeof isSuper !== 'function') {
    throw new TypeError('getUser and isSuper are required');
  }
  if (typeof HttpsError !== 'function') throw new TypeError('HttpsError is required');
  if (!FieldValue || typeof FieldValue.serverTimestamp !== 'function') {
    throw new TypeError('FieldValue.serverTimestamp is required');
  }
  if (typeof openAudit !== 'function' || typeof sealAudit !== 'function') {
    throw new TypeError('openAudit and sealAudit are required');
  }

  function fail(code, message) {
    return new HttpsError(code, message);
  }

  function dataOf(req, allowed) {
    const data = req && req.data === undefined ? {} : (req && req.data);
    if (!plain(data)) throw fail('invalid-argument', 'נתוני הבקשה אינם תקינים.');
    const keys = Object.keys(data);
    if (keys.some((key) => allowed.indexOf(key) === -1)) {
      throw fail('invalid-argument', 'הפעולה אינה מקבלת תחנה או שדות נוספים.');
    }
    return data;
  }

  function requireAuth(req) {
    if (!req || !req.auth || !scheduleAccess.validId(req.auth.uid)) {
      throw fail('unauthenticated', 'צריך להיות מחובר.');
    }
    return req.auth;
  }

  function stationFromToken(token) {
    const stationId = String((token || {}).stationId || '').trim();
    if (!STATION_ID_RE.test(stationId)) {
      throw fail('failed-precondition', 'לחשבון אין שיוך תחנה תקין.');
    }
    return stationId;
  }

  function userStation(user) {
    const claims = user && plain(user.customClaims) ? user.customClaims : {};
    return stationFromToken(claims);
  }

  function profileRef(stationId, uid) {
    return db.collection('stations').doc(stationId).collection('users').doc(uid);
  }

  function accessRef(stationId, uid) {
    return db.collection('stations').doc(stationId).collection('schedule_access').doc(uid);
  }

  function snapshotData(snap) {
    return snap && snap.exists ? (snap.data() || {}) : null;
  }

  function exactDisabledRecord(record, stationId, uid) {
    return plain(record) &&
      record.schema_version === scheduleAccess.SCHEDULE_ACCESS_SCHEMA_VERSION &&
      record.station_id === stationId && record.uid === uid && record.active === false &&
      Array.isArray(record.roles) && record.roles.length === 0;
  }

  function memberView(stationId, uid, profile, grant) {
    return {
      uid,
      name: String(profile.full_name || profile.name || '').slice(0, 160),
      primary_role: String(profile.role || '').slice(0, 80),
      enabled: scheduleAccess.isManagerAccess(grant, stationId, uid)
    };
  }

  function requireLiveHr(profile, actor) {
    if (actor.kind !== 'hr') return;
    if (!profile || !scheduleAccess.activeMember(profile, actor.stationId)
        || String(profile.role || '') !== 'hr_coordinator') {
      throw fail('permission-denied', 'לרכז/ת אין שיוך פעיל לתחנה.');
    }
  }

  async function authorize(req, requireStationForSuper) {
    const auth = requireAuth(req);
    const token = auth.token || {};
    if (isSuper(auth) === true) {
      return {
        auth,
        kind: 'super',
        stationId: requireStationForSuper ? stationFromToken(token) : ''
      };
    }

    if (String(token.role || '') !== 'hr_coordinator') {
      throw fail('permission-denied', 'מינוי אחראי/ת סידור מותר למנהל מערכת או לרכז/ת כוח אדם.');
    }
    const stationId = stationFromToken(token);
    const snap = await profileRef(stationId, auth.uid).get();
    const profile = snapshotData(snap);
    if (!profile || !scheduleAccess.activeMember(profile, stationId) ||
        String(profile.role || '') !== 'hr_coordinator') {
      throw fail('permission-denied', 'לרכז/ת אין שיוך פעיל לתחנה.');
    }
    return { auth, kind: 'hr', stationId };
  }

  async function safeSeal(auditRef, extra) {
    try {
      await sealAudit(auditRef, extra);
    } catch (error) {
      // The audit was opened before the mutation.  Do not turn a completed
      // access change into an ambiguous client failure if only the final mark
      // could not be written; the existing audit convention treats "started"
      // as a signal to investigate.
    }
  }

  async function list(req) {
    const data = dataOf(req, ['uid']);
    const isTargetLookup = Object.prototype.hasOwnProperty.call(data, 'uid');

    if (isTargetLookup) {
      if (typeof data.uid !== 'string') {
        throw fail('invalid-argument', 'מזהה המשתמש אינו תקין.');
      }
      const uid = data.uid.trim();
      if (!scheduleAccess.validId(uid)) {
        throw fail('invalid-argument', 'מזהה המשתמש אינו תקין.');
      }

      // Authorize before touching Auth.  In particular, HR must not be able
      // to probe arbitrary accounts through the targeted super-only lookup.
      const actor = await authorize(req, false);
      if (actor.kind !== 'super') {
        throw fail('permission-denied', 'חיפוש משתמש בודד מותר למנהל מערכת בלבד.');
      }
      let target;
      try {
        target = await getUser(uid);
      } catch (error) {
        throw fail('failed-precondition', 'המשתמש אינו חבר פעיל בתחנה.');
      }
      let stationId;
      try {
        stationId = userStation(target);
      } catch (error) {
        throw fail('failed-precondition', 'המשתמש אינו חבר פעיל בתחנה.');
      }
      const pair = await Promise.all([
        profileRef(stationId, uid).get(),
        accessRef(stationId, uid).get()
      ]);
      const profile = snapshotData(pair[0]);
      if (!profile || !scheduleAccess.activeMember(profile, stationId)) {
        throw fail('failed-precondition', 'המשתמש אינו חבר פעיל בתחנה.');
      }
      return {
        ok: true,
        station_id: stationId,
        members: [memberView(stationId, uid, profile, snapshotData(pair[1]))]
      };
    }

    const actor = await authorize(req, true);
    const stationId = actor.stationId;
    const [usersSnap, accessSnap] = await Promise.all([
      db.collection('stations').doc(stationId).collection('users').get(),
      db.collection('stations').doc(stationId).collection('schedule_access').get()
    ]);

    const grants = Object.create(null);
    const grantDocs = Array.isArray(accessSnap.docs) ? accessSnap.docs : [];
    for (const doc of grantDocs) grants[doc.id] = doc.data() || {};

    const members = [];
    const userDocs = Array.isArray(usersSnap.docs) ? usersSnap.docs : [];
    for (const doc of userDocs) {
      const uid = String(doc.id || '');
      const profile = doc.data() || {};
      if (!scheduleAccess.validId(uid) || !scheduleAccess.activeMember(profile, stationId)) continue;
      const grant = grants[uid] || null;
      members.push(memberView(stationId, uid, profile, grant));
    }
    members.sort((left, right) => {
      const a = left.name + '\u0000' + left.uid;
      const b = right.name + '\u0000' + right.uid;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return { ok: true, station_id: stationId, members };
  }

  async function set(req) {
    const data = dataOf(req, ['uid', 'enabled']);
    const auth = requireAuth(req);
    const uid = String(data.uid || '').trim();
    if (!scheduleAccess.validId(uid)) {
      throw fail('invalid-argument', 'מזהה המשתמש אינו תקין.');
    }
    if (data.enabled !== true && data.enabled !== false) {
      throw fail('invalid-argument', 'יש לבחור אם להעניק או לבטל את המינוי.');
    }

    const actor = await authorize(req, false);
    if (actor.kind === 'hr') {
      if (uid === auth.uid) {
        throw fail('permission-denied', 'רכז/ת כוח אדם אינו/ה רשאי/ת למנות או להסיר את עצמו/ה.');
      }
    }

    // Authorize the actor before looking up the requested identity.  Otherwise
    // an unprivileged caller could use this endpoint to probe account existence
    // or make Auth do work on its behalf.
    const target = await getUser(uid);
    const stationId = userStation(target);
    if (actor.kind === 'hr') {
      if (stationId !== actor.stationId) {
        throw fail('permission-denied', 'אפשר למנות או להסיר רק משתמשים בתחנה של רכז/ת כוח האדם.');
      }
    }

    const action = data.enabled ? 'grant_schedule_manager' : 'revoke_schedule_manager';
    const auditRef = await openAudit(auth, action, uid, {
      station_id: stationId,
      enabled: data.enabled
    });

    let result;
    try {
      result = await db.runTransaction(async (tx) => {
        const refs = actor.kind === 'hr'
          ? [profileRef(stationId, uid), accessRef(stationId, uid), profileRef(actor.stationId, auth.uid)]
          : [profileRef(stationId, uid), accessRef(stationId, uid)];
        const snaps = await Promise.all(refs.map((ref) => tx.get(ref)));
        const profile = snapshotData(snaps[0]);
        const previous = snapshotData(snaps[1]);
        requireLiveHr(actor.kind === 'hr' ? snapshotData(snaps[2]) : null, actor);
        if (!profile || !scheduleAccess.activeMember(profile, stationId)) {
          throw fail('failed-precondition', 'המשתמש אינו חבר פעיל בתחנה.');
        }

        const alreadyDesired = data.enabled
          ? scheduleAccess.isManagerAccess(previous, stationId, uid)
          : exactDisabledRecord(previous, stationId, uid);
        if (alreadyDesired) {
          return { changed: false, revision: Number(previous.revision || 0) };
        }

        const next = scheduleAccess.nextRecord(previous, stationId, uid, data.enabled);
        tx.set(refs[1], Object.assign({}, next, {
          updated_by_uid: auth.uid,
          updated_at: FieldValue.serverTimestamp()
        }), { merge: true });
        return { changed: true, revision: next.revision };
      });
    } catch (error) {
      await safeSeal(auditRef, {
        outcome: 'blocked',
        code: String((error && error.code) || 'internal').slice(0, 80)
      });
      throw error;
    }

    await safeSeal(auditRef, {
      outcome: 'done',
      changed: result.changed,
      revision: result.revision
    });
    return {
      ok: true,
      uid,
      station_id: stationId,
      enabled: data.enabled,
      changed: result.changed,
      revision: result.revision
    };
  }

  return Object.freeze({ list, set });
}

module.exports = Object.freeze({ createScheduleAccessAdmin });
