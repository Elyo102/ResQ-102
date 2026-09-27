'use strict';

// One server-owned creation path for faults from the list and vehicle map.
// The browser may choose a report ID for retry, but never the actor, station,
// vehicle name or report time. No image payload is logged.
const crypto = require('crypto');

const KINDS = new Set(['vehicle', 'damage', 'gear', 'building', 'task_st', 'task_eq', 'note']);
const VEHICLE_KINDS = new Set(['vehicle', 'damage', 'gear']);
const SEVERITIES = new Set(['unset', 'minor', 'limiting', 'major', 'blocking', 'critical']);
const MEMBER_ROLES = new Set(['firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander', 'hr_coordinator']);
const GRADING_ROLES = new Set(['deputy', 'commander', 'station_commander', 'hr_coordinator']);
const MAX_TITLE = 240;
const MAX_DESCRIPTION = 600;
const MAX_PHOTOS = 3;
const MAX_PHOTO_DATA_LENGTH = 600 * 1024;
const PHOTO_BATCHES_PER_HOUR = 40;

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{20}$/.test(value);
}

function validVehicleId(value) {
  // Board vehicles include legacy IDs such as v1; anchor documents use
  // Firestore auto IDs. Both are accepted only after same-station lookup.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function israelDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function validPhoto(photo) {
  if (!photo || typeof photo !== 'object' || Array.isArray(photo)) return false;
  if (!Number.isInteger(photo.w) || photo.w < 1 || photo.w > 1280 ||
      !Number.isInteger(photo.h) || photo.h < 1 || photo.h > 1280) return false;
  const data = photo.data;
  if (typeof data !== 'string' || data.length > MAX_PHOTO_DATA_LENGTH ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const bytes = Buffer.from(data.slice('data:image/jpeg;base64,'.length), 'base64');
  return bytes.length > 3 && bytes.length <= MAX_PHOTO_DATA_LENGTH
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function inputOf(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid-input');
  const stationId = data.stationId;
  const expectedUid = data.expectedUid;
  const reportId = data.reportId;
  const kind = data.kind;
  const vehicleId = data.vehicleId || '';
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const desc = typeof data.desc === 'string' ? data.desc.trim() : '';
  const severity = data.severity || (kind === 'note' ? 'minor' : 'unset');
  const photos = data.photos === undefined ? [] : data.photos;
  if (typeof stationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(stationId) ||
      typeof expectedUid !== 'string' || !expectedUid || expectedUid.length > 128 ||
      !validId(reportId) || !KINDS.has(kind) ||
      title.length < 1 || title.length > MAX_TITLE || desc.length > MAX_DESCRIPTION ||
      !SEVERITIES.has(severity) || !Array.isArray(photos) || photos.length > MAX_PHOTOS ||
      !photos.every(validPhoto) ||
      (VEHICLE_KINDS.has(kind) ? !validVehicleId(vehicleId) : vehicleId !== '')) {
    throw new Error('invalid-input');
  }
  let point = null;
  if (data.point !== undefined && data.point !== null) {
    const p = data.point;
    if (!p || typeof p !== 'object' || !['right','left','front','rear','roof'].includes(p.side) ||
        !Number.isFinite(p.x) || p.x < 0 || p.x > 1 ||
        !Number.isFinite(p.y) || p.y < 0 || p.y > 1 ||
        !VEHICLE_KINDS.has(kind)) throw new Error('invalid-input');
    point = { side:p.side, x:p.x, y:p.y };
  }
  return { stationId, expectedUid, reportId, kind, vehicleId, title, desc, severity, photos, point };
}

function digestOf(input, uid) {
  return crypto.createHash('sha256').update(JSON.stringify({ input, uid })).digest('hex');
}

function createFaultReportService({ db, auth, Timestamp, now, fail }) {
  if (!db || !auth || !Timestamp || typeof now !== 'function' || typeof fail !== 'function') {
    throw new Error('fault-report-dependencies-required');
  }
  async function create(req) {
    const uid = req && req.auth && req.auth.uid;
    if (typeof uid !== 'string' || !uid) return fail('unauthenticated', 'נדרשת התחברות.', 'auth_required');
    let input;
    try { input = inputOf(req.data); }
    catch (_) { return fail('invalid-argument', 'פרטי הדיווח אינם תקינים.', 'invalid_input'); }
    if (input.expectedUid !== uid) {
      return fail('permission-denied', 'המשתמש השתנה. יש לפתוח מחדש את הדיווח.', 'identity_changed');
    }
    let authUser;
    try { authUser = await auth.getUser(uid); }
    catch (_) { return fail('permission-denied', 'לא ניתן לאמת את ההרשאה.', 'identity_unavailable'); }
    if (!authUser || authUser.disabled) return fail('permission-denied', 'אין הרשאה לדיווח.', 'identity_inactive');
    const claims = authUser.customClaims || {};
    const superUser = claims.super === true;
    if (!superUser && (!MEMBER_ROLES.has(claims.role) || !claims.emp ||
        claims.stationId !== input.stationId)) {
      return fail('permission-denied', 'אין הרשאה לתחנה.', 'station_forbidden');
    }
    if (!superUser && !GRADING_ROLES.has(claims.role) &&
        input.severity !== (input.kind === 'note' ? 'minor' : 'unset')) {
      return fail('permission-denied', 'דרגת החומרה נקבעת בידי הסגל.', 'severity_forbidden');
    }
    const reportRef = db.doc(`stations/${input.stationId}/faults/${input.reportId}`);
    const userRef = db.doc(`stations/${input.stationId}/users/${uid}`);
    const boardRef = db.doc(`stations/${input.stationId}/config/board`);
    const anchorRef = input.vehicleId
      ? db.doc(`stations/${input.stationId}/vehicles/${input.vehicleId}`) : null;
    const digest = digestOf(input, uid);
    const date = now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      return fail('internal', 'לא ניתן לקבוע את שעת הדיווח.', 'server_clock_invalid');
    }
    return db.runTransaction(async tx => {
      // Every read precedes writes; retrying a successfully committed ID must
      // not overwrite a grade/closure or duplicate image documents.
      const existing = await tx.get(reportRef);
      if (existing.exists) {
        const prior = existing.data() || {};
        if (prior.report_digest === digest && prior.by_uid === uid) {
          return { reportId:input.reportId, created:false, created_key:prior.created_key };
        }
        return fail('already-exists', 'הדיווח הזה כבר קיים.', 'report_id_conflict');
      }
      let profile = {};
      if (!superUser) {
        const snap = await tx.get(userRef);
        if (!snap.exists) return fail('permission-denied', 'אין הרשאה לתחנה.', 'station_membership_missing');
        profile = snap.data() || {};
        if (profile.is_active === false || profile.active === false ||
            profile.role !== claims.role ||
            (profile.station && profile.station !== input.stationId) ||
            (profile.stationId && profile.stationId !== input.stationId)) {
          return fail('permission-denied', 'אין הרשאה לתחנה.', 'station_membership_changed');
        }
      }
      let vehicle = null;
      if (input.vehicleId) {
        const board = await tx.get(boardRef);
        const boardVehicles = board.exists && Array.isArray((board.data() || {}).vehicles)
          ? board.data().vehicles : [];
        vehicle = boardVehicles.find(v => v && v.id === input.vehicleId && v.active !== false) || null;
        if (!vehicle) {
          const anchor = await tx.get(anchorRef);
          const value = anchor.exists ? anchor.data() || {} : {};
          if (anchor.exists && value.active !== false && (!value.kind || value.kind === 'anchor')) {
            vehicle = value;
          }
        }
        if (!vehicle) return fail('invalid-argument', 'בחר רכב פעיל של התחנה.', 'vehicle_invalid');
      }
      const title = input.title;
      const body = {
        kind:input.kind, vehicle_id:input.vehicleId,
        vehicle_name:vehicle ? String(vehicle.name || '').slice(0, 80) : '',
        title, desc:input.desc, severity:input.severity, status:'open',
        photos:input.photos.length, by_uid:uid,
        by_name:String(profile.full_name || authUser.displayName || '').slice(0, 100),
        crew:typeof claims.shift === 'string' ? claims.shift : '',
        date:israelDate(date), created_key:date.toISOString(),
        created_at:Timestamp.fromDate(date), report_digest:digest
      };
      if (input.point) Object.assign(body, input.point);
      tx.create(reportRef, body);
      input.photos.forEach((photo, i) => {
        tx.create(reportRef.collection('photos').doc(`p${i}`), {
          data:photo.data, w:photo.w, h:photo.h, by_uid:uid,
          created_key:date.toISOString()
        });
      });
      return { reportId:input.reportId, created:true, created_key:body.created_key };
    });
  }
  async function appendPhotos(req) {
    const uid = req && req.auth && req.auth.uid;
    const data = req && req.data || {};
    const sid = data.stationId, reportId = data.reportId, requestId = data.requestId;
    const photos = data.photos;
    if (!uid) return fail('unauthenticated', 'נדרשת התחברות.', 'auth_required');
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(sid) ||
        !validId(reportId) || typeof requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{16,120}$/.test(requestId) ||
        data.expectedUid !== uid || !Array.isArray(photos) ||
        photos.length < 1 || photos.length > MAX_PHOTOS || !photos.every(validPhoto)) {
      return fail('invalid-argument', 'אצוות התמונות אינה תקינה.', 'invalid_photo_batch');
    }
    let user;
    try { user = await auth.getUser(uid); }
    catch (_) { return fail('permission-denied', 'לא ניתן לאמת חשבון פעיל.', 'auth_unavailable'); }
    const claims = user && user.customClaims || {};
    const isSuper = claims.super === true;
    if (!user || user.disabled || (!isSuper &&
        (!MEMBER_ROLES.has(claims.role) || claims.stationId !== sid))) {
      return fail('permission-denied', 'אין הרשאה לצרף תמונות.', 'station_forbidden');
    }
    const date = now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      return fail('internal', 'שעת השרת אינה תקינה.', 'server_clock_invalid');
    }
    const parent = db.doc(`stations/${sid}/faults/${reportId}`);
    const batch = parent.collection('photo_batches').doc(requestId);
    const quota = db.doc(`stations/${sid}/fault_photo_quotas/${crypto.createHash('sha256').update(uid).digest('hex').slice(0,32)}`);
    const digest = digestOf({ sid, reportId, requestId, photos }, uid);
    const hour = Math.floor(date.getTime() / 3600000);
    return db.runTransaction(async tx => {
      const [report, existing, quotaSnap] = await Promise.all([
        tx.get(parent), tx.get(batch), tx.get(quota)
      ]);
      if (!report.exists) return fail('not-found', 'הדיווח לא נמצא.', 'report_missing');
      const record = report.data() || {};
      if (record.by_uid !== uid && !isSuper) {
        return fail('permission-denied', 'רק מדווח התקלה יכול לצרף את תמונותיה.', 'report_author_forbidden');
      }
      if (!isSuper) {
        const membership = await tx.get(db.doc(`stations/${sid}/users/${uid}`));
        const profile = membership.exists ? membership.data() || {} : null;
        if (!profile || profile.is_active === false || profile.active === false ||
            profile.role !== claims.role ||
            (profile.station && profile.station !== sid) ||
            (profile.stationId && profile.stationId !== sid)) {
          return fail('permission-denied', 'שיוך התחנה השתנה.', 'station_membership_changed');
        }
      }
      if (existing.exists) {
        const old = existing.data() || {};
        if (old.digest === digest && old.by_uid === uid) {
          return { reportId, appended:0, total:record.photos || 0, replay:true };
        }
        return fail('already-exists', 'מזהה האצווה כבר שימש לתמונות אחרות.', 'batch_conflict');
      }
      const q = quotaSnap.exists ? quotaSnap.data() || {} : {};
      const count = q.hour === hour ? q.count : 0;
      if (!Number.isSafeInteger(count) || count < 0 || count >= PHOTO_BATCHES_PER_HOUR) {
        return fail('resource-exhausted', 'בוצעו יותר מדי העלאות בשעה זו. נסו מאוחר יותר.', 'photo_rate_limited');
      }
      const previous = Number(record.photos || 0);
      if (!Number.isSafeInteger(previous) || previous < 0 || previous > 1000000000) {
        return fail('failed-precondition', 'מונה התמונות אינו תקין.', 'photo_count_invalid');
      }
      tx.create(batch, { digest, by_uid:uid, count:photos.length,
        created_at:Timestamp.fromDate(date) });
      photos.forEach((photo, index) => tx.create(parent.collection('photos')
        .doc(`${requestId}_${index}`), {
          data:photo.data, w:photo.w, h:photo.h, by_uid:uid,
          created_key:date.toISOString()
        }));
      tx.update(parent, { photos:previous + photos.length });
      tx.set(quota, { hour, count:count + 1,
        expires_at:Timestamp.fromDate(new Date((hour + 2) * 3600000)) });
      return { reportId, appended:photos.length, total:previous + photos.length, replay:false };
    });
  }
  return Object.freeze({ create, appendPhotos });
}

module.exports = Object.freeze({ createFaultReportService, inputOf, israelDate,
  MAX_TITLE, MAX_DESCRIPTION, MAX_PHOTOS, MAX_PHOTO_DATA_LENGTH,
  PHOTO_BATCHES_PER_HOUR });
