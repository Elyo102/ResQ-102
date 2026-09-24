'use strict';

function validMarker(uid, marker) {
  return !!marker && marker.uid === uid && marker.terms_version === '1.3' &&
    marker.privacy_version === '2026-09-24' &&
    typeof marker.receipt_path === 'string' && marker.receipt_path.startsWith(
      'registration_consents/' + uid + '/events/');
}

function createRegistrationTermsGate({ firebaseOnCall, readMarker, HttpsError }) {
  const assertAccepted = async uid => {
    const marker = await readMarker(uid);
    if (!validMarker(uid, marker)) {
      throw new HttpsError('failed-precondition',
        'לפני השימוש ברסקיו יש לאשר את תקנון 1.3 במסך הכניסה.');
    }
  };
  const wrap = businessHandler => async req => {
    if (req && req.auth && req.auth.uid) await assertAccepted(req.auth.uid);
    return businessHandler(req);
  };
  return function onCall(options, handler) {
    const opts = typeof options === 'function' ? undefined : options;
    const businessHandler = typeof options === 'function' ? options : handler;
    if (typeof businessHandler !== 'function') throw new TypeError('callable handler required');
    const guarded = wrap(businessHandler);
    return opts ? firebaseOnCall(opts, guarded) : firebaseOnCall(guarded);
  };
}

async function assertRegistrationTerms(uid, readMarker, HttpsError) {
  const marker = await readMarker(uid);
  if (!validMarker(uid, marker)) {
    throw new HttpsError('failed-precondition',
      'לפני השימוש ברסקיו יש לאשר את תקנון 1.3 במסך הכניסה.');
  }
}

function createPreApprovalOnCall({ firebaseOnCall, getLiveUser, readMarker, HttpsError }) {
  return function preApprovalOnCall(options, handler) {
    if (typeof handler !== 'function') throw new TypeError('callable handler required');
    const guarded = async req => {
      if (req && req.auth && req.auth.uid) {
        const live = await getLiveUser(req.auth.uid);
        const claims = live && live.customClaims || {};
        if (!live || live.disabled) {
          throw new HttpsError('permission-denied', 'נדרש חשבון פעיל.');
        }
        if (claims.super === true || claims.emp || claims.role || claims.stationId ||
            claims.districtId || claims.shift) {
          await assertRegistrationTerms(req.auth.uid, readMarker, HttpsError);
        }
      }
      return handler(req);
    };
    return firebaseOnCall(options, guarded);
  };
}

module.exports = { createRegistrationTermsGate, createPreApprovalOnCall,
  assertRegistrationTerms, validMarker };
