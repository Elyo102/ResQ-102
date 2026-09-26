'use strict';

const crypto = require('node:crypto');
const contract = require('./operational-vehicle-contract');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HOUR_LIMIT = 40;
const uidKey = uid => crypto.createHash('sha256').update(uid).digest('hex').slice(0, 32);

function createOperationalVehicleService({ db, auth, Timestamp, HttpsError, now = () => new Date() }) {
  if (!db || typeof db.runTransaction !== 'function' || !auth ||
      typeof auth.getUser !== 'function' || !Timestamp || typeof HttpsError !== 'function') {
    throw new TypeError('db, auth, Timestamp and HttpsError are required');
  }
  const fail = (code, message, reason) => { throw new HttpsError(code, message, { reason }); };
  const station = sid => `stations/${sid}`;
  const boardRef = sid => db.doc(`${station(sid)}/config/board`);
  const userRef = (sid, uid) => db.doc(`${station(sid)}/users/${uid}`);
  const compartmentRoot = (sid, vid, cell) =>
    `${station(sid)}/vehicle_inventory/${vid}/compartments/${cell}`;
  const eventRef = (sid, vid, id) =>
    db.doc(`${station(sid)}/vehicle_inventory/${vid}/equipment_events/${id}`);

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
    const sid = token.stationId;
    if (typeof uid !== 'string' || !uid) return fail('unauthenticated', 'נדרשת התחברות.', 'auth_required');
    if (typeof sid !== 'string' || !contract.ID.test(sid)) {
      return fail('permission-denied', 'שיוך התחנה אינו תקין.', 'station_invalid');
    }
    const isSuper = token.super === true;
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
        liveClaims.stationId !== sid ||
        (!isSuper && liveClaims.role !== token.role)) {
      return fail('permission-denied', 'הרשאות החשבון השתנו.', 'claims_changed');
    }
    return Object.freeze({ uid, sid, role:token.role, super:isSuper });
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
    const input = parse(contract.parseEvent, req && req.data);
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
        by_uid:ctx.uid, created_at:time.stamp, digest
      });
      // One reusable quota document per actor, not one document per hour.
      tx.set(quotaRef, { hour, count:count + 1,
        expires_at:Timestamp.fromDate(new Date((hour + 2) * 3600000)) });
      return { event_id:input.request_id, created:true };
    });
  }

  async function saveItem(req) {
    const input = parse(contract.parseItem, req && req.data);
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
    const input = parse(contract.parsePhoto, req && req.data);
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

  return Object.freeze({ recordEvent, saveItem, savePhoto });
}

module.exports = Object.freeze({ createOperationalVehicleService, HOUR_LIMIT });
