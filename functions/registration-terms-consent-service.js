'use strict';

function createRegistrationTermsConsentService({ db, auth, HttpsError, serverTimestamp, randomId }) {
  const fail = (code, message) => { throw new HttpsError(code, message); };
  return async function registrationTermsConsent(req) {
    if (!req || !req.auth || !req.auth.uid) fail('unauthenticated', 'צריך להיות מחובר.');
    const uid = req.auth.uid;
    const input = req.data || {};
    const action = input.action === 'accept' ? 'accept' : input.action === 'status' ? 'status' : '';
    if (!action || Object.keys(input).some(k => !['action', 'marketing_opt_in'].includes(k))) {
      fail('invalid-argument', 'פעולת הסכמה אינה תקינה.');
    }
    if (action === 'accept' && typeof input.marketing_opt_in !== 'boolean') {
      fail('invalid-argument', 'יש לבחור אם לקבל הצעות שיווקיות.');
    }
    const live = await auth.getUser(uid);
    if (!live || live.disabled || live.uid !== uid) {
      fail('permission-denied', 'נדרש חשבון פעיל השייך לבקשה.');
    }
    return db.runTransaction(async tx => {
      const requestRef = db.doc('registration_requests/' + uid);
      const requestSnap = await tx.get(requestRef);
      const opSnap = await tx.get(db.doc('identity_operations/' + uid));
      const op = opSnap.exists ? opSnap.data() || {} : null;
      const request = requestSnap.exists ? requestSnap.data() || {} : null;
      const liveClaims = live.customClaims || {};
      const approvedIdentity = liveClaims.super === true || !!liveClaims.emp;
      const pending = !approvedIdentity && request &&
        ['pending', 'processing', 'needs_recovery'].includes(request.status);
      if (!pending) {
        if (!approvedIdentity) {
          fail('failed-precondition', 'החשבון עדיין אינו מאושר לשימוש בשירות.');
        }
        const markerRef = db.doc('registration_terms_active/' + uid);
        const markerSnap = await tx.get(markerRef);
        const marker = markerSnap.exists ? markerSnap.data() || {} : null;
        const receiptPrefix = 'registration_consents/' + uid + '/events/';
        if (marker && (marker.uid !== uid || marker.terms_version !== '1.3' ||
            marker.privacy_version !== '2026-09-24' ||
            typeof marker.receipt_path !== 'string' ||
            !marker.receipt_path.startsWith(receiptPrefix))) {
          fail('failed-precondition', 'סמן ההסכמה אינו תקין; פנה למנהל המערכת.');
        }
        const markerReceiptRef = marker ? db.doc(marker.receipt_path) : null;
        const markerReceiptSnap = markerReceiptRef ? await tx.get(markerReceiptRef) : null;
        const markerReceipt = markerReceiptSnap && markerReceiptSnap.exists
          ? markerReceiptSnap.data() || {} : null;
        const approvedRef = db.doc('registration_consents/' + uid + '/events/terms-v1.3-approved');
        const approvedSnap = await tx.get(approvedRef);
        const approvedReceipt = approvedSnap.exists ? approvedSnap.data() || {} : null;
        const operationRef = op && op.status === 'completed' && op.request_id
          ? db.doc('registration_consents/' + uid + '/events/' + op.request_id) : null;
        const operationSnap = operationRef ? await tx.get(operationRef) : null;
        const operationReceipt = operationSnap && operationSnap.exists ? operationSnap.data() || {} : null;
        const valid = receipt => receipt && receipt.terms_version === '1.3' &&
          receipt.privacy_version === '2026-09-24' &&
          typeof receipt.marketing_opt_in === 'boolean' && !!receipt.accepted_at &&
          receipt.uid === uid;
        if (approvedSnap.exists && (!valid(approvedReceipt) || approvedReceipt.uid !== uid)) {
          fail('failed-precondition', 'קבלת הסכמה קודמת אינה תקינה; פנה למנהל המערכת.');
        }
        const accepted = !!(valid(markerReceipt) || valid(approvedReceipt) || valid(operationReceipt));
        const previous = valid(markerReceipt) ? markerReceipt :
          valid(approvedReceipt) ? approvedReceipt : operationReceipt;
        const receiptPath = valid(markerReceipt) ? markerReceiptRef.path :
          valid(approvedReceipt) ? approvedRef.path :
          valid(operationReceipt) ? operationRef.path : '';
        if (marker && (!valid(markerReceipt) || marker.receipt_path !== receiptPath)) {
          fail('failed-precondition', 'סמן ההסכמה אינו תואם לקבלה; פנה למנהל המערכת.');
        }
        if (action === 'status') {
          if (accepted && !marker) tx.create(markerRef, { uid, terms_version: '1.3',
            privacy_version: '2026-09-24', receipt_path: receiptPath,
            activated_at: serverTimestamp() });
          return { ok: true, accepted, status: 'approved' };
        }
        if (accepted) {
          if (previous.marketing_opt_in !== input.marketing_opt_in) {
            fail('failed-precondition', 'בחירת ההסכמה הקודמת נשמרה ולא ניתן לשנותה כניסיון חוזר.');
          }
          if (!marker) tx.create(markerRef, { uid, terms_version: '1.3',
            privacy_version: '2026-09-24', receipt_path: receiptPath,
            activated_at: serverTimestamp() });
          return { ok: true, accepted: true, replayed: true };
        }
        tx.create(approvedRef, { uid, terms_version: '1.3', privacy_version: '2026-09-24',
          marketing_opt_in: input.marketing_opt_in, accepted_at: serverTimestamp(),
          source: 'approved_account_reconsent' });
        tx.create(markerRef, { uid, terms_version: '1.3', privacy_version: '2026-09-24',
          receipt_path: approvedRef.path, activated_at: serverTimestamp() });
        return { ok: true, accepted: true, replayed: false };
      }
      if (op && ['processing', 'needs_recovery'].includes(op.status) &&
          (op.kind !== 'approve' || op.request_id !== request.request_id)) {
        fail('failed-precondition', 'פעולת זהות אחרת בטיפול; פנה למנהל המערכת.');
      }
      if (request.status !== 'pending' && (!op || op.kind !== 'approve' ||
          op.request_id !== request.request_id || !['processing', 'needs_recovery'].includes(op.status))) {
        fail('failed-precondition', 'הבקשה בטיפול לא תואם; פנה למנהל המערכת.');
      }
      if (op && op.kind === 'approve' && op.status === 'completed') {
        fail('failed-precondition', 'הבקשה כבר אושרה.');
      }
      if (!request.request_id && request.request_fingerprint) {
        fail('failed-precondition', 'בקשה חתומה ללא מזהה תקין דורשת בדיקת מנהל.');
      }
      const requestId = request.request_id || randomId();
      const consentRef = db.doc('registration_consents/' + uid + '/events/' + requestId);
      const receiptSnap = await tx.get(consentRef);
      const receipt = receiptSnap.exists ? receiptSnap.data() || {} : null;
      const accepted = !!receipt && receipt.uid === uid && receipt.request_id === requestId &&
        receipt.terms_version === '1.3' && receipt.privacy_version === '2026-09-24' &&
        typeof receipt.marketing_opt_in === 'boolean' && !!receipt.accepted_at;
      if (action === 'status') return { ok: true, accepted, request_id: requestId, status: request.status };
      if (accepted) {
        if (receipt.marketing_opt_in !== input.marketing_opt_in) {
          fail('failed-precondition', 'בחירת ההסכמה הקודמת נשמרה ולא ניתן לשנותה כניסיון חוזר.');
        }
        return { ok: true, accepted: true, replayed: true };
      }
      if (request.legal_consent && request.legal_consent.terms_version === '1.3' &&
          (request.legal_consent.privacy_version !== '2026-09-24' ||
           request.legal_consent.marketing_opt_in !== input.marketing_opt_in)) {
        fail('failed-precondition', 'הבקשה כבר כוללת בחירת הסכמה אחרת; פנה למנהל המערכת.');
      }
      if (receiptSnap.exists) fail('failed-precondition', 'קבלת הסכמה קודמת אינה תקינה; פנה למנהל המערכת.');
      if (!request.request_id) tx.set(requestRef, { request_id: requestId }, { merge: true });
      tx.create(consentRef, { uid, request_id: requestId, terms_version: '1.3',
        privacy_version: '2026-09-24', marketing_opt_in: input.marketing_opt_in,
        accepted_at: serverTimestamp(), source: 'existing_request_reconsent' });
      return { ok: true, accepted: true, replayed: false };
    });
  };
}

module.exports = { createRegistrationTermsConsentService };
