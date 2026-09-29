'use strict';

const { createOpsMemberIdentity } = require('./ops-member-identity');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// READS ONLY: a final rejection cannot undo writes. Manual builders/backfills
// need authorization in their own write transactions, not this wrapper.
function createHrMonthlyReadAccess({ db, auth, HttpsError }) {
  if (!db || typeof db.runTransaction !== 'function' || !auth
      || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db, auth and HttpsError required');
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);

  async function check(ctx, authTime) {
    return db.runTransaction(async tx => {
      let record;
      try { record = await auth.getUser(ctx.uid); }
      catch (cause) {
        if (cause && cause.code === 'auth/user-not-found') {
          throw error('permission-denied', 'החשבון אינו זמין.');
        }
        throw error('unavailable', 'לא ניתן לאמת את ההרשאה כעת.');
      }
      const claims = record && record.customClaims;
      if (!record || record.uid !== ctx.uid || record.disabled === true || !plain(claims)
          || claims.stationId !== ctx.sid || (claims.super === true) !== ctx.super
          || (!ctx.super && claims.role !== ctx.role)) {
        throw error('permission-denied', 'הרשאת החשבון או השיוך לתחנה השתנו.');
      }
      if (record.tokensValidAfterTime !== undefined) {
        const validAfter = typeof record.tokensValidAfterTime === 'string'
          ? Date.parse(record.tokensValidAfterTime) : NaN;
        if (!Number.isFinite(validAfter)) throw error('unavailable', 'לא ניתן לאמת את תוקף הכניסה.');
        if (authTime * 1000 < validAfter) throw error('permission-denied', 'יש להתחבר מחדש.');
      }
      await identity.requireLive(tx, ctx);
    });
  }

  async function run(req, read) {
    const ctx = identity.context(req);
    if (!ctx.super && ctx.role !== 'hr_coordinator') {
      throw error('permission-denied', 'נדרשת סמכות משאבי אנוש.');
    }
    const authTime = req.auth.token.auth_time;
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) {
      throw error('unauthenticated', 'יש להתחבר מחדש.');
    }
    if (typeof read !== 'function') throw new TypeError('read callback required');
    await check(ctx, authTime);
    // Never retry the data operation as part of a Firestore transaction retry.
    const result = await read(ctx);
    // Includes empty/not_built responses. This establishes a final checked
    // boundary, not a promise that authority cannot change after the response.
    await check(ctx, authTime);
    return result;
  }
  return Object.freeze({ run });
}

module.exports = { createHrMonthlyReadAccess };
