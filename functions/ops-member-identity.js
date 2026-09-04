'use strict';

const access = require('./schedule-access');
const MEMBER_ROLES = Object.freeze([
  'firefighter', 'deputy_team_leader', 'team_leader', 'deputy', 'commander',
  'station_commander', 'hr_coordinator'
]);

function createOpsMemberIdentity({ db, HttpsError }) {
  if (!db || typeof db.collection !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db and HttpsError are required');
  }
  function context(req) {
    const auth = req && req.auth;
    if (!auth || !access.validUid(auth.uid)) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');
    const token = auth.token || {};
    const sid = token.stationId;
    if (typeof sid !== 'string' || !access.validId(sid)) throw new HttpsError('failed-precondition', 'לחשבון אין שיוך תקין לתחנה.');
    if (!MEMBER_ROLES.includes(token.role)) throw new HttpsError('permission-denied', 'נדרש משתמש תחנה פעיל.');
    return Object.freeze({ uid: auth.uid, sid, role: token.role });
  }
  async function requireLive(tx, ctx) {
    // Must be called in the SAME transaction, before either writes or replay.
    // A profile update conflicts with the read and forces re-authorization.
    const ref = db.collection('stations').doc(ctx.sid).collection('users').doc(ctx.uid);
    const snap = await tx.get(ref);
    const user = snap.exists ? snap.data() : null;
    if (!access.activeMember(user, ctx.sid) || user.role !== ctx.role
        || !MEMBER_ROLES.includes(user.role)) {
      throw new HttpsError('permission-denied', 'השיוך או התפקיד הפעיל בתחנה השתנו.');
    }
    const emp = user.employee_number;
    return Object.freeze({
      uid: ctx.uid, sid: ctx.sid, role: user.role,
      employee_number: typeof emp === 'string' || typeof emp === 'number' ? String(emp).slice(0, 20) : ''
    });
  }
  return Object.freeze({ context, requireLive });
}

module.exports = Object.freeze({ createOpsMemberIdentity, MEMBER_ROLES });
