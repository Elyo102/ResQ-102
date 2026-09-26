'use strict';

const crypto = require('node:crypto');
const contract = require('./operational-vehicle-contract');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HOUR_LIMIT = 40;
const uidKey = uid => crypto.createHash('sha256').update(uid).digest('hex').slice(0, 32);

function createOperationalVehicleService({ db, auth, Timestamp, HttpsError,
  resolveStation, listStations, now = () => new Date() }) {
  if (!db || typeof db.runTransaction !== 'function' || !auth ||
      typeof auth.getUser !== 'function' || !Timestamp || typeof HttpsError !== 'function' ||
      typeof resolveStation !== 'function' || typeof listStations !== 'function') {
    throw new TypeError('db, auth, Timestamp, HttpsError and station resolvers are required');
  }
  const fail = (code, message, reason) => { throw new HttpsError(code, message, { reason }); };
  const station = sid => `stations/${sid}`;
  const boardRef = sid => db.doc(`${station(sid)}/config/board`);
  const userRef = (sid, uid) => db.doc(`${station(sid)}/users/${uid}`);
  const compartmentRoot = (sid, vid, cell) =>
    `${station(sid)}/vehicle_inventory/${vid}/compartments/${cell}`;
  const eventRef = (sid, vid, id) =>
    db.doc(`${station(sid)}/vehicle_inventory/${vid}/equipment_events/${id}`);
  const bodyOf = req => {
    const data = req && req.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    const body = { ...data };
    delete body.target_station_id;
    return body;
  };

  function timestamp() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      return fail('internal', 'שעת השרת אינה תקינה.', 'server_clock_invalid');
    }
    return { date:value, stamp:Timestamp.fromDate(value) };
  }
  async function actor(req, roles) {
    const a = req && req.auth;
    const token = a && a.token || {};
    const uid = a && a.uid;
    const isSuper = token.super === true;
    const requested = req && req.data && req.data.target_station_id;
    if (!isSuper && requested !== undefined) {
      return fail('permission-denied', 'תחנת יעד שמורה למנהל־על.', 'station_injection');
    }
    const sid = isSuper ? requested : token.stationId;
    if (typeof uid !== 'string' || !uid) return fail('unauthenticated', 'נדרשת התחברות.', 'auth_required');
    if (typeof sid !== 'string' || !contract.ID.test(sid)) {
      return fail('permission-denied', 'שיוך התחנה אינו תקין.', 'station_invalid');
    }
    if (!isSuper && !roles.includes(token.role)) {
      return fail('permission-denied', 'אין הרשאה לפעולה.', 'role_forbidden');
    }
    let user;
    try { user = await auth.getUser(uid); }
    catch (error) { return fail('permission-denied', 'לא ניתן לאמת חשבון פעיל.', 'auth_unavailable'); }
    if (!user || user.disabled || user.uid !== uid) {
      return fail('permission-denied', 'החשבון אינו פעיל.', 'auth_inactive');
    }
    const liveClaims = user.customClaims || {};
    if (isSuper !== (liveClaims.super === true) ||
        (!isSuper && liveClaims.stationId !== sid) ||
        (!isSuper && liveClaims.role !== token.role)) {
      return fail('permission-denied', 'הרשאות החשבון השתנו.', 'claims_changed');
    }
    if (isSuper && !(await resolveStation(sid))) {
      return fail('permission-denied', 'תחנת היעד אינה פעילה.', 'station_inactive');
    }
    return Object.freeze({ uid, sid, role:token.role, super:isSuper });
  }
  async function listAvailableStations(req) {
    const token = req && req.auth && req.auth.token || {};
    const uid = req && req.auth && req.auth.uid;
    if (!uid || token.super !== true) {
      return fail('permission-denied', 'רק מנהל־על יכול לבחור תחנה.', 'super_required');
    }
    let user;
    try { user = await auth.getUser(uid); }
    catch (error) { return fail('permission-denied', 'לא ניתן לאמת את החשבון.', 'auth_unavailable'); }
    if (!user || user.disabled || user.uid !== uid || user.customClaims?.super !== true) {
      return fail('permission-denied', 'הרשאת מנהל־על אינה פעילה.', 'super_revoked');
    }
    const stations = await listStations();
    if (!Array.isArray(stations) || stations.length > 250) {
      return fail('failed-precondition', 'רשימת התחנות אינה זמינה.', 'stations_invalid');
    }
    return { stations:stations.filter(row => row && row.active === true &&
      contract.ID.test(row.id)).map(row => ({ id:row.id,
        name:String(row.name || row.id).slice(0, 160) })) };
  }
  async function liveStationUser(tx, ctx) {
    if (ctx.super) return;
    const snap = await tx.get(userRef(ctx.sid, ctx.uid));
    const data = snap.exists ? snap.data() || {} : null;
    if (!data || data.is_active === false || data.active === false ||
        data.role !== ctx.role ||
        (data.station && data.station !== ctx.sid) ||
        (data.stationId && data.stationId !== ctx.sid)) {
      return fail('permission-denied', 'השיוך הפעיל לתחנה השתנה.', 'station_membership_changed');
    }
  }
  async function activeBoardVehicle(tx, ctx, vehicleId, sourceVehicleId = '') {
    const snapshot = await tx.get(boardRef(ctx.sid));
    const vehicles = snapshot.exists && Array.isArray((snapshot.data() || {}).vehicles)
      ? snapshot.data().vehicles : [];
    const active = id => vehicles.some(vehicle => vehicle && vehicle.id === id && vehicle.active !== false);
    if (!active(vehicleId) || (sourceVehicleId && !active(sourceVehicleId))) {
      return fail('invalid-argument', 'בחרו רכב מבצעי פעיל של התחנה.', 'vehicle_invalid');
    }
  }
  function parse(parser, value) {
    try { return parser(value); }
    catch (error) { return fail('invalid-argument', 'הנתונים אינם תקינים.', 'invalid_input'); }
  }

  async function recordEvent(req) {
    const input = parse(contract.parseEvent, bodyOf(req));
    const ctx = await actor(req, contract.EVENT_WRITERS);
    const ref = eventRef(ctx.sid, input.vehicle_id, input.request_id);
    const digest = hash({ input, uid:ctx.uid });
    const time = timestamp();
    const hour = Math.floor(time.date.getTime() / 3600000);
    const quotaRef = db.doc(`${station(ctx.sid)}/vehicle_event_quotas/${uidKey(ctx.uid)}`);
    return db.runTransaction(async tx => {
      const [existing, quota] = await Promise.all([tx.get(ref), tx.get(quotaRef)]);
      await liveStationUser(tx, ctx);
      await activeBoardVehicle(tx, ctx, input.vehicle_id, input.source_vehicle_id);
      if (existing.exists) {
        const old = existing.data() || {};
        if (old.digest === digest && old.by_uid === ctx.uid) {
          return { event_id:input.request_id, created:false };
        }
        return fail('already-exists', 'מזהה הפעולה כבר שימש לדיווח אחר.', 'request_conflict');
      }
      const quotaData = quota.exists ? quota.data() || {} : {};
      const count = Number(quotaData.hour === hour ? quotaData.count || 0 : 0);
      if (!Number.isSafeInteger(count) || count < 0 || count >= HOUR_LIMIT) {
        return fail('resource-exhausted', 'בוצעו יותר מדי רישומים בשעה זו.', 'event_rate_limited');
      }
      tx.create(ref, {
        schema:'vehicle-equipment-event-v1', vehicle_id:input.vehicle_id,
        kind:input.kind, equipment:input.equipment, location:input.location,
        was_replaced:input.was_replaced,
        replacement_equipment:input.replacement_equipment,
        source_vehicle_id:input.source_vehicle_id, status:input.status,
        revision:0, by_uid:ctx.uid, created_at:time.stamp, digest
      });
      // One reusable quota document per actor, not one document per hour.
      tx.set(quotaRef, { hour, count:count + 1,
        expires_at:Timestamp.fromDate(new Date((hour + 2) * 3600000)) });
      return { event_id:input.request_id, created:true };
    });
  }

  async function transitionEvent(req) {
    const input = parse(contract.parseTransition, bodyOf(req));
    const ctx = await actor(req, contract.FLEET_WRITERS);
    const ref = eventRef(ctx.sid, input.vehicle_id, input.event_id);
    const receipt = db.doc(`${ref.path}/transitions/${input.request_id}`);
    const digest = hash({ input, uid:ctx.uid });
    const time = timestamp();
    return db.runTransaction(async tx => {
      const [event, prior] = await Promise.all([tx.get(ref), tx.get(receipt)]);
      await liveStationUser(tx, ctx);
      if (!event.exists || (event.data() || {}).vehicle_id !== input.vehicle_id) {
        return fail('not-found', 'אירוע הציוד לא נמצא ברכב.', 'event_missing');
      }
      const old = event.data() || {};
      if (prior.exists) {
        const saved = prior.data() || {};
        if (saved.digest === digest && saved.by_uid === ctx.uid) {
          return { event_id:input.event_id, revision:saved.revision, written:false };
        }
        return fail('already-exists', 'מזהה הפעולה כבר שימש לעדכון אחר.', 'request_conflict');
      }
      const currentRevision = old.revision === undefined ? 0 : Number(old.revision);
      if (!Number.isSafeInteger(currentRevision) || currentRevision !== input.expected_revision) {
        return fail('aborted', 'מצב הטיפול השתנה. רעננו את היומן.', 'revision_conflict');
      }
      const allowed = (old.status === 'open' && input.status === 'in_progress') ||
        (old.status === 'in_progress' && input.status === 'resolved');
      if (!allowed) return fail('failed-precondition', 'מעבר מצב הטיפול אינו תקין.', 'transition_invalid');
      tx.update(ref, { status:input.status, revision:currentRevision + 1,
        status_by_uid:ctx.uid, status_at:time.stamp });
      tx.create(receipt, { schema:'vehicle-equipment-transition-v1',
        from:old.status, to:input.status, note:input.note,
        revision:currentRevision + 1, by_uid:ctx.uid,
        created_at:time.stamp, digest });
      return { event_id:input.event_id, revision:currentRevision + 1, written:true };
    });
  }

  async function saveItem(req) {
    const input = parse(contract.parseItem, bodyOf(req));
    const ctx = await actor(req, contract.FLEET_WRITERS);
    const ref = db.doc(`${compartmentRoot(ctx.sid, input.vehicle_id, input.compartment_id)}/items/${input.item_id}`);
    const digest = hash({ input, uid:ctx.uid });
    const time = timestamp();
    return db.runTransaction(async tx => {
      const existing = await tx.get(ref);
      await liveStationUser(tx, ctx);
      await activeBoardVehicle(tx, ctx, input.vehicle_id);
      const old = existing.exists ? existing.data() || {} : null;
      if (old && old.last_request_id === input.request_id && old.last_digest === digest) {
        return { item_id:input.item_id, revision:old.revision, written:false };
      }
      const previous = old ? Number(old.revision) : 0;
      if (!Number.isSafeInteger(previous) || previous !== input.expected_revision) {
        return fail('aborted', 'הציוד השתנה בינתיים. רעננו ובדקו לפני שמירה.', 'revision_conflict');
      }
      const body = {
        schema:'vehicle-equipment-item-v1', name:input.name, quantity:input.quantity,
        status:input.status, notes:input.notes,
        revision:previous + 1, by_uid:ctx.uid, updated_at:time.stamp,
        last_request_id:input.request_id, last_digest:digest
      };
      if (old) tx.update(ref, body);
      else tx.create(ref, { ...body, created_at:time.stamp });
      return { item_id:input.item_id, revision:previous + 1, written:true };
    });
  }

  async function savePhoto(req) {
    const input = parse(contract.parsePhoto, bodyOf(req));
    const ctx = await actor(req, contract.FLEET_WRITERS);
    const ref = db.doc(`${compartmentRoot(ctx.sid, input.vehicle_id, input.compartment_id)}/photos/current`);
    const digest = hash({ input, uid:ctx.uid });
    const time = timestamp();
    return db.runTransaction(async tx => {
      const existing = await tx.get(ref);
      await liveStationUser(tx, ctx);
      await activeBoardVehicle(tx, ctx, input.vehicle_id);
      const old = existing.exists ? existing.data() || {} : null;
      if (old && old.last_request_id === input.request_id && old.last_digest === digest) {
        return { revision:old.revision, written:false };
      }
      const previous = old ? Number(old.revision) : 0;
      if (!Number.isSafeInteger(previous) || previous !== input.expected_revision) {
        return fail('aborted', 'תמונת התא השתנתה בינתיים. רעננו לפני שמירה.', 'revision_conflict');
      }
      const body = {
        schema:'vehicle-compartment-photo-v1', data:input.data, w:input.w, h:input.h,
        revision:previous + 1, by_uid:ctx.uid, updated_at:time.stamp,
        last_request_id:input.request_id, last_digest:digest
      };
      if (old) tx.update(ref, body);
      else tx.create(ref, { ...body, created_at:time.stamp });
      return { revision:previous + 1, written:true };
    });
  }

  return Object.freeze({ listAvailableStations, recordEvent, transitionEvent, saveItem, savePhoto });
}

module.exports = Object.freeze({ createOperationalVehicleService, HOUR_LIMIT });
