'use strict';

// M9 (security review): one shared fresh-admin helper for every admin callable.
//
// An ID token is valid for up to an hour after the underlying account changes.
// A super admin who was disabled or had the `super` claim removed could keep
// calling admin callables with the old token. Every admin gate therefore reads
// the LIVE Auth record: the account must exist, must not be disabled, and the
// live custom claims (not the token copy) must still grant the authority.

function createFreshAdmin(deps) {
  const d = deps || {};
  if (!d.auth || typeof d.auth.getUser !== 'function' || !d.HttpsError) {
    throw new TypeError('fresh admin dependencies are required');
  }
  const deny = (msg) => { throw new d.HttpsError('permission-denied', msg); };

  function requireSigned(req) {
    if (!req || !req.auth || !req.auth.uid) {
      throw new d.HttpsError('unauthenticated', 'צריך להיות מחובר.');
    }
    return req.auth;
  }

  async function liveUser(uid) {
    let user;
    try { user = await d.auth.getUser(uid); } catch (e) { user = null; }
    if (!user || user.uid !== uid || user.disabled === true) {
      deny('החשבון אינו פעיל. התחבר מחדש או פנה למנהל המערכת.');
    }
    return user;
  }

  async function requireFreshSuper(req) {
    const signed = requireSigned(req);
    if (!signed.token || signed.token.super !== true) deny('הפעולה מותרת למנהל המערכת בלבד.');
    const user = await liveUser(signed.uid);
    const claims = user.customClaims || {};
    if (claims.super !== true) deny('הרשאת מנהל המערכת אינה פעילה.');
    return Object.freeze({
      uid: signed.uid,
      token: Object.freeze(Object.assign({}, signed.token, claims, { email: user.email || '' }))
    });
  }

  // Role setter gate with the live claims. The token copy must agree with the
  // live record (role, station, district); a mismatch means the token is stale
  // and the caller must sign in again.
  async function requireFreshRoleSetter(req, policy) {
    const p = policy || {};
    const signed = requireSigned(req);
    const user = await liveUser(signed.uid);
    const live = user.customClaims || {};
    const token = signed.token || {};
    if (live.super === true && token.super === true) {
      return { auth: Object.assign({}, signed, { token: Object.assign({}, token, live) }),
        cap: Infinity, sid: '', did: '' };
    }
    const role = String(live.role || '');
    const cap = (p.ASSIGN_MAX_RANK || {})[role] || 0;
    if (!cap || String(token.role || '') !== role) {
      deny('שיבוץ תפקידים מותר למנהל המערכת ולרכז/ת כוח אדם בלבד.');
    }
    const sid = String(live.stationId || '');
    const did = String(live.districtId || '');
    if (!sid || !did || String(token.stationId || '') !== sid || String(token.districtId || '') !== did
        || (Array.isArray(p.KNOWN_DISTRICTS) && p.KNOWN_DISTRICTS.indexOf(did) === -1)) {
      deny('לחשבון המשבץ חסר שיוך תחנה או מחוז תקין. פנה למנהל המערכת.');
    }
    return { auth: Object.assign({}, signed, { token: Object.assign({}, token, live) }), cap, sid, did };
  }

  return Object.freeze({ requireFreshSuper, requireFreshRoleSetter, liveUser });
}

module.exports = { createFreshAdmin };
