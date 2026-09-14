'use strict';

// Server evidence that a bulletin was displayed. This deliberately does not
// claim that the recipient read or understood the message.
const MEMBER_ROLES = Object.freeze(['firefighter', 'deputy_team_leader', 'team_leader',
  'deputy', 'commander', 'station_commander', 'hr_coordinator']);
const VIEWER_ROLES = Object.freeze(['deputy', 'commander']);
const PAGE_SIZE = 25;
const RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

function createBulletinReceipts({ db, auth, HttpsError, clock } = {}) {
  if (!db || !auth || typeof HttpsError !== 'function' || typeof clock !== 'function') {
    throw new TypeError('bulletin receipt ports are required');
  }
  const fail = (code, message) => { throw new HttpsError(code, message); };
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exact = (data, allowed) => {
    if (!plain(data) || Object.keys(data).some(key => !allowed.includes(key))) {
      fail('invalid-argument', 'הבקשה אינה תקינה.');
    }
  };
  function safeId(value, label, max = 128) {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean || clean.length > max || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(clean)) {
      fail('invalid-argument', label + ' אינו תקין.');
    }
    return clean;
  }
  function safeName(value) {
    const clean = String(value || '').normalize('NFC').trim();
    if (!clean || clean.length > 120 || /[\x00-\x1F\x7F]/.test(clean)) {
      fail('failed-precondition', 'חסר שם מלא תקין בכרטיס המשתמש.');
    }
    return clean;
  }
  function context(req) {
    if (!req || !req.auth || !req.auth.uid) fail('unauthenticated', 'צריך להיות מחובר.');
    const token = plain(req.auth.token) ? req.auth.token : {};
    const authTime = Number(token.auth_time);
    if (!Number.isSafeInteger(authTime) || authTime < 0) fail('unauthenticated', 'צריך להתחבר מחדש.');
    const superUser = token.super === true;
    const role = String(token.role || '').trim();
    if (!superUser && !MEMBER_ROLES.includes(role)) {
      fail('permission-denied', 'רק חבר תחנה מאושר יכול לצפות בלוח.');
    }
    return { uid: safeId(String(req.auth.uid), 'מזהה המשתמש'),
      sid: safeId(String(token.stationId || ''), 'מזהה התחנה', 64),
      role, crew: String(token.shift || '').trim(), superUser, authTime };
  }
  function input(data, listing) {
    exact(data, listing ? ['sub_station_id', 'message_id', 'cursor'] : ['sub_station_id', 'message_id']);
    return { subId: safeId(data && data.sub_station_id, 'מזהה תחנת המשנה', 64),
      messageId: safeId(data && data.message_id, 'מזהה ההודעה'),
      cursor: listing && data.cursor != null ? safeId(data.cursor, 'סמן העמוד') : '' };
  }
  async function verifyAuth(ctx) {
    let record;
    try { record = await auth.getUser(ctx.uid); }
    catch (ignore) { fail('permission-denied', 'החשבון אינו פעיל.'); }
    if (!record || record.disabled === true) fail('permission-denied', 'החשבון אינו פעיל.');
    const validAfter = Date.parse(String(record.tokensValidAfterTime || ''));
    if (!Number.isFinite(validAfter)) fail('unavailable', 'לא ניתן לאמת את תוקף ההתחברות.');
    if (ctx.authTime * 1000 < validAfter) fail('permission-denied', 'צריך להתחבר מחדש.');
    const claims = plain(record.customClaims) ? record.customClaims : {};
    if (String(claims.stationId || '') !== ctx.sid ||
        (ctx.superUser ? claims.super !== true : String(claims.role || '') !== ctx.role)) {
      fail('permission-denied', 'הרשאות החשבון השתנו. צריך להתחבר מחדש.');
    }
  }
  const station = ctx => db.collection('stations').doc(ctx.sid);
  const profileRef = ctx => station(ctx).collection('users').doc(ctx.uid);
  const subRef = (ctx, parsed) => station(ctx).collection('sub_stations').doc(parsed.subId);
  const messageRef = (ctx, parsed) => subRef(ctx, parsed).collection('bulletin_messages').doc(parsed.messageId);
  const messageRefAt = (ctx, subId, messageId) => station(ctx).collection('sub_stations').doc(subId)
    .collection('bulletin_messages').doc(messageId);
  const receiptRef = (ctx, parsed) => station(ctx).collection('bulletin_view_receipts')
    .doc(parsed.messageId).collection('bulletin_view_recipients').doc(ctx.uid);
  function active(value) {
    const state = String((value && value.status) || '').toLowerCase();
    return plain(value) && value.active !== false && value.is_active !== false &&
      value.archived !== true && state !== 'inactive' && state !== 'archived';
  }
  function timeMs(value) {
    if (value && typeof value.toMillis === 'function') return Number(value.toMillis());
    if (value && typeof value.toDate === 'function') {
      const date = value.toDate();
      return date instanceof Date ? date.getTime() : NaN;
    }
    return value instanceof Date ? value.getTime() : NaN;
  }
  function validReceipt(value, sid, messageId, uid) {
    return plain(value) && value.schema === 'bulletin-view-receipt-v1' &&
      value.station_id === sid && value.message_id === messageId &&
      value.recipient_uid === uid && Number.isSafeInteger(value.viewed_at_ms) &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(value.sub_station_id || '')) &&
      typeof value.broadcast_id === 'string' && value.broadcast_id.length <= 128 &&
      Number.isFinite(timeMs(value.expires_at)) && timeMs(value.expires_at) > value.viewed_at_ms;
  }
  function broadcastIdOf(message) {
    if (!plain(message) || message.audience !== 'all_sub_stations') return '';
    const value = String(message.broadcast_id || '').trim();
    if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
      fail('failed-precondition', 'נתוני ההפצה הרחבה אינם תקינים.');
    }
    return value;
  }
  function verifyProfile(ctx, snap) {
    if (!snap.exists && !ctx.superUser) fail('permission-denied', 'כרטיס המשתמש בתחנה לא נמצא.');
    const profile = snap.exists ? (snap.data() || {}) : {};
    if (!ctx.superUser && (profile.active === false || profile.is_active === false ||
        String(profile.role || '') !== ctx.role || String(profile.crew || '') !== ctx.crew)) {
      fail('permission-denied', 'פרטי התפקיד השתנו. צריך להתחבר מחדש.');
    }
    return profile;
  }

  async function markViewed(req) {
    const ctx = context(req), parsed = input(req.data, false);
    await verifyAuth(ctx);
    const now = Number(clock());
    if (!Number.isSafeInteger(now) || now < 0) fail('unavailable', 'זמן השרת אינו זמין.');
    return db.runTransaction(async tx => {
      const [subSnap, profileSnap, oldSnap, messageSnap] = await Promise.all([
        tx.get(subRef(ctx, parsed)), tx.get(profileRef(ctx)), tx.get(receiptRef(ctx, parsed)),
        tx.get(messageRef(ctx, parsed))
      ]);
      const profile = verifyProfile(ctx, profileSnap);
      if (!subSnap.exists) fail('not-found', 'תחנת המשנה לא נמצאה.');
      if (!active(subSnap.data())) fail('failed-precondition', 'תחנת המשנה אינה פעילה.');
      if (!messageSnap.exists || (messageSnap.data() || {}).hidden === true) fail('not-found', 'ההודעה לא נמצאה.');
      const message = messageSnap.data() || {};
      const currentBroadcastId = broadcastIdOf(message);
      if (oldSnap.exists) {
        const old = oldSnap.data();
        if (!validReceipt(old, ctx.sid, parsed.messageId, ctx.uid)) {
          fail('failed-precondition', 'קבלת הצפייה הקיימת אינה תקינה.');
        }
        if (old.sub_station_id !== parsed.subId) {
          if (!currentBroadcastId || old.broadcast_id !== currentBroadcastId) {
            fail('failed-precondition', 'הקבלה אינה שייכת להודעה בלוח הזה.');
          }
          const originalSnap = await tx.get(messageRefAt(ctx, old.sub_station_id, parsed.messageId));
          const original = originalSnap.exists ? (originalSnap.data() || {}) : null;
          if (!original || original.hidden === true || broadcastIdOf(original) !== currentBroadcastId) {
            fail('failed-precondition', 'מקור ההפצה הרחבה אינו תקין.');
          }
        } else if (old.broadcast_id !== currentBroadcastId) {
          fail('failed-precondition', 'מקור ההודעה השתנה מאז הצפייה.');
        }
        if (timeMs(old.expires_at) > now) {
          await verifyAuth(ctx);
          return { outcome: 'no_change', viewed_at_ms: old.viewed_at_ms };
        }
      }
      // Firebase Auth and Firestore do not share one transaction. Re-read the
      // live Auth record at the last possible boundary before the receipt write.
      await verifyAuth(ctx);
      const value = { schema: 'bulletin-view-receipt-v1', station_id: ctx.sid,
        sub_station_id: parsed.subId, message_id: parsed.messageId,
        broadcast_id: currentBroadcastId,
        recipient_uid: ctx.uid, recipient_name_snapshot: safeName(profile.full_name ||
          (ctx.superUser ? 'מנהל המערכת' : '')), viewed_at_ms: now, viewed_at: new Date(now),
        message_created_key: String(message.created_key || '').slice(0, 64),
        expires_at: new Date(now + RETENTION_MS) };
      if (oldSnap.exists) tx.set(receiptRef(ctx, parsed), value);
      else tx.create(receiptRef(ctx, parsed), value);
      return { outcome: oldSnap.exists ? 'refreshed' : 'created', viewed_at_ms: now };
    });
  }

  async function listViewers(req) {
    const ctx = context(req), parsed = input(req.data, true);
    await verifyAuth(ctx);
    if (!ctx.superUser && !VIEWER_ROLES.includes(ctx.role)) {
      fail('permission-denied', 'רק מפקד משמרת או סגנו רשאים לראות את רשימת הצופים.');
    }
    const [profileSnap, messageSnap] = await Promise.all([profileRef(ctx).get(), messageRef(ctx, parsed).get()]);
    verifyProfile(ctx, profileSnap);
    if (!messageSnap.exists || (messageSnap.data() || {}).hidden === true) fail('not-found', 'ההודעה לא נמצאה.');
    let query = station(ctx).collection('bulletin_view_receipts').doc(parsed.messageId)
      .collection('bulletin_view_recipients').orderBy('__name__').limit(PAGE_SIZE + 1);
    if (parsed.cursor) query = query.startAfter(parsed.cursor);
    const snap = await query.get(), docs = snap.docs || [], now = Number(clock());
    if (!Number.isSafeInteger(now) || now < 0) fail('unavailable', 'זמן השרת אינו זמין.');
    const pageDocs = docs.slice(0, PAGE_SIZE);
    const rows = pageDocs.map(doc => ({ doc, value: doc.data() || {} }));
    rows.forEach(({ doc, value }) => {
      if (!validReceipt(value, ctx.sid, parsed.messageId, doc.id)) {
        fail('failed-precondition', 'נמצאה קבלת צפייה לא תקינה.');
      }
    });
    const originIds = [...new Set(rows.map(({ value }) => value.sub_station_id)
      .filter(subId => subId !== parsed.subId))];
    const originSnaps = await Promise.all(originIds.map(subId =>
      messageRefAt(ctx, subId, parsed.messageId).get()));
    const origins = new Map(originIds.map((subId, index) => [subId, originSnaps[index]]));
    const [freshProfileSnap, freshMessageSnap] = await Promise.all([
      profileRef(ctx).get(), messageRef(ctx, parsed).get()
    ]);
    verifyProfile(ctx, freshProfileSnap);
    if (!freshMessageSnap.exists || (freshMessageSnap.data() || {}).hidden === true) {
      fail('not-found', 'ההודעה לא נמצאה.');
    }
    // Revalidate live Auth last, after every private/source read and immediately
    // before returning the private viewer page.
    await verifyAuth(ctx);
    const currentBroadcastId = broadcastIdOf(freshMessageSnap.data() || {});
    const items = rows.map(({ doc, value }) => {
      if (value.sub_station_id !== parsed.subId) {
        const originalSnap = origins.get(value.sub_station_id);
        const original = originalSnap && originalSnap.exists ? (originalSnap.data() || {}) : null;
        if (!currentBroadcastId || value.broadcast_id !== currentBroadcastId || !original ||
            original.hidden === true || broadcastIdOf(original) !== currentBroadcastId) {
          fail('failed-precondition', 'נמצאה קבלה שאינה שייכת להפצה גלויה בלוח הזה.');
        }
      } else if (value.broadcast_id !== currentBroadcastId) {
        fail('failed-precondition', 'מקור ההודעה השתנה מאז הצפייה.');
      }
      if (timeMs(value.expires_at) <= now) return null;
      return { recipient_uid: doc.id, recipient_name_snapshot: safeName(value.recipient_name_snapshot),
        viewed_at_ms: value.viewed_at_ms };
    }).filter(Boolean);
    return { items, next_cursor: docs.length > PAGE_SIZE ? pageDocs[pageDocs.length - 1].id : null };
  }

  return { markViewed, listViewers };
}

module.exports = { createBulletinReceipts, MEMBER_ROLES, VIEWER_ROLES, PAGE_SIZE, RETENTION_MS };
