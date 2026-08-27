'use strict';

const crypto = require('crypto');

// Durable identity changes for ResQ.
//
// Firebase Auth and Firestore cannot participate in one transaction.  This
// coordinator therefore stores one immutable plan per uid, applies each step
// idempotently, and removes a registration request only after both systems
// have been read back and verified.  A different operation can never take
// over an unfinished plan, even after its lease expires.

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_FENCE_MS = 3 * 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).sort().forEach(function (key) {
    if (value[key] !== undefined) out[key] = canonical(value[key]);
  });
  return out;
}

function sameValue(a, b) {
  return JSON.stringify(canonical(a == null ? {} : a)) ===
         JSON.stringify(canonical(b == null ? {} : b));
}

function stableHash(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical(value == null ? null : value)))
    .digest('hex');
}

function timestampIdentity(value) {
  if (!value) return '';
  const seconds = value.seconds != null ? value.seconds : value._seconds;
  const nanos = value.nanoseconds != null ? value.nanoseconds : value._nanoseconds;
  if (seconds != null) return String(seconds) + ':' + String(nanos || 0);
  if (typeof value.toMillis === 'function') return String(value.toMillis()) + ':ms';
  return String(value);
}

function registrationFingerprint(uid, data) {
  const r = data || {};
  return stableHash({
    version: 1,
    uid: String(uid || ''),
    request_id: String(r.request_id || ''),
    full_name: String(r.full_name || ''),
    email: String(r.email || '').toLowerCase(),
    phone: String(r.phone || ''),
    districtId: String(r.districtId || ''),
    stationId: String(r.stationId || ''),
    shift: String(r.shift || ''),
    created_at: timestampIdentity(r.created_at)
  });
}

function activeIndex(data) {
  const value = data && typeof data === 'object' ? data : {};
  return value.retired !== true && value.active !== false && value.status !== 'retired';
}

function retiredIndex(data, uid) {
  const value = data && typeof data === 'object' ? data : {};
  return String(value.uid || '') === String(uid || '') &&
    (value.retired === true || value.active === false || value.status === 'retired');
}

function lockedPlan(kind, emp, profile) {
  const p = profile || {};
  return canonical({
    kind: String(kind || ''),
    emp: String(emp || ''),
    role: String(p.role || ''),
    shift: String(p.shift || ''),
    stationId: String(p.stationId || ''),
    districtId: String(p.districtId || '')
  });
}

function profileMatches(op, docs) {
  const p = op.desired_profile || {};
  const user = docs.user || {};
  const roster = docs.roster || {};
  const directory = docs.directory || {};
  const index = docs.index || {};
  return String(user.employee_number || '') === String(op.desired_emp || '') &&
    String(user.full_name || '') === String(p.full_name || '') &&
    String(user.email || '').toLowerCase() === String(p.email || '').toLowerCase() &&
    String(user.phone || '') === String(p.phone || '') &&
    String(user.role || '') === String(p.role || '') &&
    String(user.crew || '') === String(p.shift || '') &&
    String(user.station || '') === String(p.stationId || '') &&
    String(user.district || '') === String(p.districtId || '') && user.is_active === true &&
    String(roster.full_name || '') === String(p.full_name || '') &&
    String(roster.role || '') === String(p.role || '') &&
    String(roster.crew || '') === String(p.shift || '') && roster.is_active === true &&
    String(directory.full_name || '') === String(p.full_name || '') &&
    sameValue(directory.name_prefixes || [], p.name_prefixes || []) &&
    String(directory.role || '') === String(p.role || '') &&
    String(directory.crew || '') === String(p.shift || '') &&
    String(directory.station || '') === String(p.stationId || '') &&
    String(directory.district || '') === String(p.districtId || '') &&
    directory.is_active === true && String(index.uid || '') === String(op.uid || '') &&
    String(index.email || '').toLowerCase() === String(p.email || '').toLowerCase() &&
    String(index.stationId || '') === String(p.stationId || '') && activeIndex(index);
}

function assignmentFields(claims) {
  const value = claims && typeof claims === 'object' ? claims : {};
  return ['emp', 'role', 'stationId', 'districtId', 'shift', 'super']
    .filter(function (key) {
      return key === 'super' ? value[key] === true : String(value[key] || '') !== '';
    });
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return Number(value) || 0;
}

function safeError(error) {
  return String((error && (error.message || error.code)) || error || 'unknown')
    .slice(0, 500);
}

function createIdentityCoordinator(deps) {
  if (!deps || !deps.db || !deps.auth || !deps.FieldValue ||
      !deps.Timestamp || !deps.HttpsError || typeof deps.randomId !== 'function') {
    throw new TypeError('identity coordinator dependencies are required');
  }

  const db = deps.db;
  const auth = deps.auth;
  const FV = deps.FieldValue;
  const Timestamp = deps.Timestamp;
  const HttpsError = deps.HttpsError;
  const randomId = deps.randomId;
  const hooks = deps.hooks || {};
  const leaseMs = Number(deps.leaseMs || DEFAULT_LEASE_MS);
  const fenceMs = Number(deps.fenceMs || DEFAULT_FENCE_MS);

  function httpsError(code, message, details) {
    return new HttpsError(code, message, details);
  }

  function recoveryError(message) {
    const error = httpsError('failed-precondition', message, {
      needs_recovery: true
    });
    error.identityRecovery = true;
    return error;
  }

  function controlRef(uid) {
    return db.doc('identity_operations/' + uid);
  }

  function requestRef(uid) {
    return db.doc('registration_requests/' + uid);
  }

  function reservationRef(emp) {
    return db.doc('emp_reservations/' + emp);
  }

  function leaseUntil(now) {
    return Timestamp.fromMillis(now + leaseMs);
  }

  function fenceUntil(now) {
    return Timestamp.fromMillis(now + fenceMs);
  }

  function activeOperation(data) {
    return data && (data.status === 'processing' || data.status === 'needs_recovery');
  }

  function auditDocument(params, action, details) {
    return {
      action: action,
      actor_uid: params.actorUid,
      actor_email: String(params.actorEmail || '').toLowerCase(),
      target_uid: params.uid,
      details: canonical(details || {}),
      at: FV.serverTimestamp(),
      outcome: 'started'
    };
  }

  function assertRequestMatches(data, requestId, requestGeneration, opId, allowPending) {
    if (!data) throw recoveryError('בקשת ההרשמה נעלמה בזמן הטיפול. היא לא נוקתה אוטומטית.');
    if (String(data.request_id || '') !== String(requestId || '')) {
      throw recoveryError('בקשת ההרשמה השתנתה בזמן הטיפול. הבקשה החדשה נשמרה.');
    }
    if (String(data.server_generation || '') !== String(requestGeneration || '')) {
      throw recoveryError('דור בקשת ההרשמה השתנה בזמן הטיפול. הבקשה החדשה נשמרה.');
    }
    if ((data.status === 'processing' || data.status === 'needs_recovery') &&
        String(data.operation_id || '') === opId) return;
    if (allowPending && data.status === 'pending') return;
    throw recoveryError('מצב בקשת ההרשמה אינו תואם לפעולה הפעילה.');
  }

  function operationConflict(existing) {
    return {
      operation_in_progress: true,
      needs_recovery: existing.status === 'needs_recovery',
      target_uid: String(existing.target_uid || ''),
      operation_id: String(existing.op_id || ''),
      plan_fingerprint: String(existing.plan_fingerprint || ''),
      plan_summary: canonical(existing.plan_summary || {})
    };
  }

  function sameIntent(existing, params) {
    return existing.op_id === params.opId && existing.kind === params.kind &&
      String(existing.intent_fingerprint || '') === String(params.intentFingerprint || '');
  }

  async function getOperation(uid) {
    const snap = await controlRef(uid).get();
    return snap.exists ? (snap.data() || {}) : null;
  }

  async function acquireAssignment(params) {
    if (!/^[a-f0-9]{64}$/.test(String(params.intentFingerprint || ''))) {
      throw httpsError('invalid-argument', 'טביעת כוונת פעולת הזהות חסרה או אינה תקינה.');
    }
    const now = Date.now();
    const opRef = controlRef(params.uid);
    const reqRef = requestRef(params.uid);
    const auditRef = db.collection('admin_audit').doc();

    return db.runTransaction(async function (tx) {
      const opSnap = await tx.get(opRef);
      const existing = opSnap.exists ? (opSnap.data() || {}) : null;

      if (existing) {
        if (existing.status === 'completed' && existing.op_id === params.opId) {
          if (sameIntent(existing, params)) return { type: 'completed', operation: existing };
          throw httpsError('aborted',
            'מזהה הפעולה כבר שייך לתוכנית אחרת.', operationConflict(existing));
        }
        if (activeOperation(existing)) {
          if (existing.status === 'processing' && sameIntent(existing, params)) {
            return { type: 'resumed', operation: existing };
          }
          throw httpsError('aborted',
            'מתבצעת כבר פעולת שיוך אחרת לאותו משתמש. הפעולה הקיימת נשמרה.',
            operationConflict(existing));
        }
        if (existing.status === 'completed' &&
            timestampMillis(existing.fence_until) > now) {
          throw httpsError('resource-exhausted',
            'השינוי הקודם הושלם זה עתה. המתן מספר דקות לפני שינוי זהות נוסף.', {
              retry_after_ms: timestampMillis(existing.fence_until) - now
            });
        }
      }

      let reqSnap = null;
      let reqData = null;
      let exactRequestId = '';
      let exactGeneration = '';
      let exactRequestFingerprint = '';

      if (params.requireRequest || params.attachPendingRequest) {
        reqSnap = await tx.get(reqRef);
        reqData = reqSnap.exists ? (reqSnap.data() || {}) : null;
      }

      if (params.requireRequest) {
        if (!reqData) {
          throw httpsError('not-found', 'בקשת ההרשמה לא נמצאה. רענן את הרשימה.');
        }
        if (reqData.status !== 'pending') {
          throw httpsError('failed-precondition',
            'בקשת ההרשמה כבר בטיפול או דורשת בדיקה. רענן את הרשימה.');
        }
        exactRequestId = String(reqData.request_id || '') || randomId();
        exactGeneration = String(reqData.server_generation || '') || randomId();
        const stampedRequest = Object.assign({}, reqData, { request_id: exactRequestId });
        exactRequestFingerprint = registrationFingerprint(params.uid, stampedRequest);
        if (!reqData.request_id || !reqData.server_generation || !reqData.request_fingerprint) {
          tx.set(reqRef, {
            request_id: exactRequestId,
            server_generation: exactGeneration,
            request_fingerprint: exactRequestFingerprint,
            fingerprint_version: 1,
            updated_at: FV.serverTimestamp()
          }, { merge: true });
          return {
            type: 'request_stamped', requestId: exactRequestId,
            requestGeneration: exactGeneration
          };
        }
        if (String(reqData.request_fingerprint || '') !== exactRequestFingerprint) {
          throw httpsError('failed-precondition',
            'תוכן בקשת ההרשמה השתנה לאחר שנחתם בשרת. הבקשה נשמרה לבדיקה.', {
              request_changed: true
            });
        }
        if (!params.requestGeneration ||
            exactGeneration !== String(params.requestGeneration)) {
          throw httpsError('failed-precondition',
            'הבקשה השתנתה מאז שהמסך נטען. רענן ואשר את הבקשה העדכנית.', {
              request_changed: true
            });
        }
        if (params.requestId && exactRequestId !== String(params.requestId)) {
          throw httpsError('failed-precondition',
            'מזהה ניסיון ההרשמה השתנה. רענן ואשר את הבקשה העדכנית.', {
              request_changed: true
            });
        }
      } else if (reqData) {
        if (reqData.status === 'processing') {
          tx.set(reqRef, {
            status: 'needs_recovery',
            resumable: false,
            operation_id: FV.delete(),
            plan_fingerprint: FV.delete(),
            locked_plan: FV.delete(),
            recovery_reason: 'orphan_processing_request',
            updated_at: FV.serverTimestamp()
          }, { merge: true });
          return { type: 'orphan_request' };
        }
        if (reqData.status === 'pending') {
          exactRequestId = String(reqData.request_id || '') || randomId();
          exactGeneration = String(reqData.server_generation || '') || randomId();
          const attachedRequest = Object.assign({}, reqData, { request_id: exactRequestId });
          exactRequestFingerprint = registrationFingerprint(params.uid, attachedRequest);
          if (reqData.request_fingerprint &&
              String(reqData.request_fingerprint) !== exactRequestFingerprint) {
            throw httpsError('failed-precondition',
              'בקשת ההרשמה השתנתה לאחר חתימת השרת. היא לא צורפה לפעולה.');
          }
        }
      }

      if (params.blockIfAssigned && assignmentFields(params.previousClaims).length) {
        tx.set(reqRef, {
          request_id: exactRequestId,
          // No immutable identity plan exists in this branch, so this must
          // remain a reviewable pending request rather than pretending to be
          // a resumable recovery operation. A super may reject it explicitly.
          status: 'pending',
          resumable: false,
          operation_id: FV.delete(),
          plan_fingerprint: FV.delete(),
          locked_plan: FV.delete(),
          recovery_reason: 'live_identity_already_assigned',
          recovery_at: FV.serverTimestamp(),
          updated_at: FV.serverTimestamp()
        }, { merge: true });
        tx.set(auditRef, auditDocument(params, params.auditAction, {
          assignment_fields: assignmentFields(params.previousClaims),
          request_id: exactRequestId
        }));
        tx.set(auditRef, { outcome: 'blocked', request_preserved: true }, { merge: true });
        return { type: 'assigned_request_preserved' };
      }

      let emp = '';
      let counterRef = null;
      let counterNext = null;
      let idxRef = null;
      let idxSnap = null;
      let resRef = null;
      let resSnap = null;

      if (params.employeeMode === 'fixed') {
        emp = String(params.wantedEmp || '');
        idxRef = db.doc('emp_index/' + emp);
        resRef = reservationRef(emp);
        idxSnap = await tx.get(idxRef);
        resSnap = await tx.get(resRef);
      } else if (params.employeeMode === 'auto') {
        counterRef = db.doc('meta/emp_counter');
        const counterSnap = await tx.get(counterRef);
        let candidate = counterSnap.exists ?
          Number((counterSnap.data() || {}).next || params.employeeStart || 1) :
          Number(params.employeeStart || 1);
        if (!Number.isSafeInteger(candidate) || candidate < Number(params.employeeStart || 1) ||
            candidate > 999999) {
          throw httpsError('failed-precondition',
            'מונה מספרי העובדים אינו תקין. לא הוקצה מספר חדש.');
        }
        let found = false;

        // המונה אמור להצביע תמיד למספר הבא. אם הוא נשאר מאחור
        // בגלל נתוני legacy, סורקים חלון קטן בלבד: עד 50 קריאות
        // למסמכי index/reservation, ולא עסקה יקרה של מאות קריאות.
        for (let attempt = 0; attempt < 25 && candidate <= 999999; attempt++, candidate++) {
          const candidateIdxRef = db.doc('emp_index/' + candidate);
          const candidateResRef = reservationRef(String(candidate));
          const candidateIdx = await tx.get(candidateIdxRef);
          const candidateRes = await tx.get(candidateResRef);
          if (!candidateIdx.exists && !candidateRes.exists) {
            emp = String(candidate);
            idxRef = candidateIdxRef;
            resRef = candidateResRef;
            idxSnap = candidateIdx;
            resSnap = candidateRes;
            counterNext = candidate + 1;
            found = true;
            break;
          }
        }
        if (!found) {
          throw httpsError('resource-exhausted',
            'לא נמצא מספר עובד פנוי. פנה למנהל המערכת.');
        }
      }

      if (idxSnap && idxSnap.exists) {
        const indexData = idxSnap.data() || {};
        const sameCurrent = String(indexData.uid || '') === params.uid &&
          activeIndex(indexData) && String(params.previousEmp || '') === emp;
        if (!sameCurrent) {
          throw httpsError('already-exists',
            'מספר העובד ' + emp + ' כבר הוקצה בעבר ואינו ניתן למחזור.');
        }
      }
      if (resSnap && resSnap.exists) {
        const held = resSnap.data() || {};
        if (String(held.uid || '') !== params.uid ||
            String(held.operation_id || '') !== params.opId) {
          throw httpsError('already-exists',
            'מספר העובד ' + emp + ' שמור כרגע לפעולה אחרת.');
        }
      }

      const plan = params.makePlan(emp, reqData || {});
      const summary = lockedPlan(params.kind, emp, plan.desiredProfile);
      const planFingerprint = stableHash({
        fingerprint_version: 1,
        uid: params.uid,
        kind: params.kind,
        request_generation: exactGeneration,
        previous_claims: canonical(params.previousClaims || {}),
        desired_claims: plan.desiredClaims == null ? null : canonical(plan.desiredClaims),
        previous_emp: String(params.previousEmp || ''),
        previous_station: String(params.previousStation || ''),
        desired_emp: emp,
        desired_profile: plan.desiredProfile == null ? null : canonical(plan.desiredProfile)
      });
      const op = {
        op_id: params.opId,
        target_uid: params.uid,
        kind: params.kind,
        status: 'processing',
        phase: 'prepared',
        actor_uid: params.actorUid,
        request_id: exactRequestId,
        request_generation: exactGeneration,
        request_fingerprint: exactRequestFingerprint,
        intent_fingerprint: params.intentFingerprint,
        plan_fingerprint: planFingerprint,
        fingerprint_version: 1,
        plan_summary: summary,
        previous_claims: canonical(params.previousClaims || {}),
        desired_claims: plan.desiredClaims == null ? null : canonical(plan.desiredClaims),
        desired_profile: plan.desiredProfile == null ? null : canonical(plan.desiredProfile),
        previous_emp: String(params.previousEmp || ''),
        previous_station: String(params.previousStation || ''),
        desired_emp: emp,
        audit_path: auditRef.path,
        started_at: FV.serverTimestamp(),
        updated_at: FV.serverTimestamp(),
        lease_until: leaseUntil(now),
        assigned: assignmentFields(params.previousClaims).length > 0
      };

      tx.set(opRef, op);
      tx.set(auditRef, auditDocument(params, params.auditAction,
        Object.assign({}, params.auditDetails || {}, {
          operation_id: params.opId,
          request_id: exactRequestId || null,
          emp: emp || null
        })));

      if (resRef) {
        tx.set(resRef, {
          uid: params.uid,
          operation_id: params.opId,
          created_at: FV.serverTimestamp()
        });
      }
      if (counterRef && counterNext != null) {
        tx.set(counterRef, {
          next: counterNext,
          updated_at: FV.serverTimestamp()
        }, { merge: true });
      }
      if (reqData && reqData.status === 'pending') {
        tx.set(reqRef, {
          request_id: exactRequestId,
          server_generation: exactGeneration,
          request_fingerprint: exactRequestFingerprint,
          fingerprint_version: 1,
          status: 'processing',
          resumable: true,
          operation_id: params.opId,
          plan_fingerprint: planFingerprint,
          locked_plan: summary,
          processing_at: FV.serverTimestamp(),
          updated_at: FV.serverTimestamp()
        }, { merge: true });
      }

      return { type: 'acquired', operation: op };
    });
  }

  async function acquireBootstrap(params) {
    if (!/^[a-f0-9]{64}$/.test(String(params.intentFingerprint || ''))) {
      throw httpsError('invalid-argument', 'טביעת כוונת האתחול חסרה או אינה תקינה.');
    }
    const now = Date.now();
    const opRef = controlRef(params.uid);
    const auditRef = db.collection('admin_audit').doc();

    return db.runTransaction(async function (tx) {
      const snap = await tx.get(opRef);
      const existing = snap.exists ? (snap.data() || {}) : null;
      if (existing) {
        if (existing.status === 'completed' && existing.op_id === params.opId) {
          if (sameIntent(existing, params)) return { type: 'completed', operation: existing };
          throw httpsError('aborted', 'מזהה האתחול כבר שייך לתוכנית אחרת.',
            operationConflict(existing));
        }
        if (activeOperation(existing)) {
          if (existing.status === 'processing' && sameIntent(existing, params)) {
            return { type: 'resumed', operation: existing };
          }
          throw httpsError('aborted', 'מתבצעת כבר פעולת זהות אחרת לאותו משתמש.',
            operationConflict(existing));
        }
        if (existing.status === 'completed' &&
            timestampMillis(existing.fence_until) > now) {
          throw httpsError('resource-exhausted',
            'השינוי הקודם הושלם זה עתה. המתן מספר דקות ונסה שוב.');
        }
      }

      const desiredClaims = canonical(params.desiredClaims || {});
      const previousClaims = canonical(params.previousClaims || {});
      const planFingerprint = stableHash({
        fingerprint_version: 1, uid: params.uid, kind: 'bootstrap',
        previous_claims: previousClaims, desired_claims: desiredClaims
      });
      const op = {
        op_id: params.opId,
        target_uid: params.uid,
        kind: 'bootstrap',
        status: 'processing',
        phase: 'prepared',
        actor_uid: params.actorUid,
        request_id: '',
        request_generation: '',
        intent_fingerprint: params.intentFingerprint,
        plan_fingerprint: planFingerprint,
        fingerprint_version: 1,
        plan_summary: canonical({ kind: 'bootstrap', role: 'super_admin' }),
        previous_claims: previousClaims,
        desired_claims: desiredClaims,
        desired_profile: null,
        previous_emp: String((params.previousClaims || {}).emp || ''),
        previous_station: String((params.previousClaims || {}).stationId || ''),
        desired_emp: String((params.desiredClaims || {}).emp || ''),
        audit_path: auditRef.path,
        started_at: FV.serverTimestamp(),
        updated_at: FV.serverTimestamp(),
        lease_until: leaseUntil(now),
        assigned: assignmentFields(params.previousClaims).length > 0
      };
      tx.set(opRef, op);
      tx.set(auditRef, auditDocument(params, params.auditAction,
        Object.assign({}, params.auditDetails || {}, { operation_id: params.opId })));
      return { type: 'acquired', operation: op };
    });
  }

  async function advancePhase(uid, opId, fromPhases, nextPhase) {
    const now = Date.now();
    return db.runTransaction(async function (tx) {
      const ref = controlRef(uid);
      const snap = await tx.get(ref);
      if (!snap.exists) throw recoveryError('מסמך פעולת הזהות חסר.');
      const op = snap.data() || {};
      if (op.op_id === opId && op.status === 'completed') return;
      if (op.op_id !== opId || op.status !== 'processing') {
        throw recoveryError('פעולת הזהות הוחלפה בזמן העבודה.');
      }
      if (op.phase === nextPhase || op.phase === 'completed') return;
      if (fromPhases.indexOf(op.phase) === -1) {
        throw recoveryError('שלב פעולת הזהות אינו תואם להמשך בטוח.');
      }
      tx.set(ref, {
        phase: nextPhase,
        updated_at: FV.serverTimestamp(),
        lease_until: leaseUntil(now)
      }, { merge: true });
    });
  }

  async function markNeedsRecovery(uid, opId, error) {
    const reason = safeError(error);
    await db.runTransaction(async function (tx) {
      const opRef = controlRef(uid);
      const opSnap = await tx.get(opRef);
      if (!opSnap.exists) return;
      const op = opSnap.data() || {};
      if (op.op_id !== opId || op.status === 'completed') return;

      let reqSnap = null;
      if (op.request_id) reqSnap = await tx.get(requestRef(uid));

      tx.set(opRef, {
        status: 'needs_recovery',
        recovery_phase: String(op.phase || ''),
        last_error: reason,
        updated_at: FV.serverTimestamp()
      }, { merge: true });

      if (reqSnap && reqSnap.exists) {
        const request = reqSnap.data() || {};
        if (String(request.request_id || '') === String(op.request_id) &&
            String(request.operation_id || '') === opId) {
          tx.set(reqSnap.ref, {
            status: 'needs_recovery',
            resumable: true,
            recovery_reason: reason,
            recovery_phase: String(op.phase || ''),
            updated_at: FV.serverTimestamp()
          }, { merge: true });
        }
      }

      if (op.audit_path) {
        tx.set(db.doc(op.audit_path), {
          outcome: 'needs_recovery',
          error: reason
        }, { merge: true });
      }
    });
  }

  async function applyAssignmentProfile(uid, opId) {
    if (typeof hooks.beforeProfile === 'function') await hooks.beforeProfile(uid, opId);
    const now = Date.now();
    return db.runTransaction(async function (tx) {
      const opRef = controlRef(uid);
      const opSnap = await tx.get(opRef);
      if (!opSnap.exists) throw recoveryError('מסמך פעולת הזהות חסר.');
      const op = opSnap.data() || {};
      if (op.op_id === opId && op.status === 'completed') return op;
      if (op.op_id !== opId || op.status !== 'processing') {
        throw recoveryError('פעולת הזהות אינה פעילה עוד.');
      }
      if (['profile_applied', 'auth_applied', 'tokens_revoked'].indexOf(op.phase) !== -1) {
        return op;
      }
      if (op.phase !== 'prepared' || !op.desired_profile || !op.desired_emp) {
        throw recoveryError('תוכנית הפרופיל חסרה או נמצאת בשלב לא תקין.');
      }

      const p = op.desired_profile;
      const resRef = reservationRef(op.desired_emp);
      const idxRef = db.doc('emp_index/' + op.desired_emp);
      const oldIdxRef = op.previous_emp && op.previous_emp !== op.desired_emp ?
        db.doc('emp_index/' + op.previous_emp) : null;
      const reqRef = op.request_id ? requestRef(uid) : null;

      const resSnap = await tx.get(resRef);
      const idxSnap = await tx.get(idxRef);
      const oldIdxSnap = oldIdxRef ? await tx.get(oldIdxRef) : null;
      const reqSnap = reqRef ? await tx.get(reqRef) : null;

      if (!resSnap.exists || String((resSnap.data() || {}).uid || '') !== uid ||
          String((resSnap.data() || {}).operation_id || '') !== opId) {
        throw recoveryError('שריון מספר העובד חסר או שייך לפעולה אחרת.');
      }
      if (idxSnap.exists) {
        const currentIndex = idxSnap.data() || {};
        const sameCurrent = String(currentIndex.uid || '') === uid &&
          activeIndex(currentIndex) && String(op.previous_emp || '') === String(op.desired_emp || '');
        if (!sameCurrent) {
          throw recoveryError('מספר העובד הוקצה בעבר ואינו ניתן למחזור.');
        }
      }
      if (oldIdxSnap && oldIdxSnap.exists &&
          String((oldIdxSnap.data() || {}).uid || '') !== uid) {
        throw recoveryError('מפתח מספר העובד הקודם מצביע למשתמש אחר.');
      }
      if (reqRef) assertRequestMatches(reqSnap && reqSnap.data(), op.request_id,
        op.request_generation, opId, false);

      tx.set(db.doc('stations/' + p.stationId + '/users/' + uid), {
        employee_number: op.desired_emp,
        full_name: p.full_name || '',
        email: p.email || '',
        phone: p.phone || '',
        role: p.role,
        crew: p.shift || '',
        station: p.stationId,
        district: p.districtId || '',
        is_active: true,
        updated_at: FV.serverTimestamp()
      }, { merge: true });
      tx.set(db.doc('stations/' + p.stationId + '/roster/' + uid), {
        full_name: p.full_name || '',
        role: p.role,
        crew: p.shift || '',
        is_active: true,
        updated_at: FV.serverTimestamp()
      }, { merge: true });
      tx.set(db.doc('directory/' + uid), {
        full_name: p.full_name || '',
        name_prefixes: Array.isArray(p.name_prefixes) ? p.name_prefixes : [],
        role: p.role,
        crew: p.shift || '',
        station: p.stationId,
        district: p.districtId || '',
        is_active: true,
        updated_at: FV.serverTimestamp()
      }, { merge: true });
      tx.set(idxRef, {
        uid: uid,
        email: p.email || '',
        stationId: p.stationId,
        status: 'active',
        active: true,
        retired: false,
        updated_at: FV.serverTimestamp()
      });

      if (oldIdxRef) {
        tx.set(oldIdxRef, {
          uid: uid,
          status: 'retired',
          active: false,
          retired: true,
          retired_at: FV.serverTimestamp()
        });
      }
      if (op.previous_station && op.previous_station !== p.stationId) {
        const off = { is_active: false, updated_at: FV.serverTimestamp() };
        tx.set(db.doc('stations/' + op.previous_station + '/users/' + uid), off, { merge: true });
        tx.set(db.doc('stations/' + op.previous_station + '/roster/' + uid), off, { merge: true });
      }

      tx.set(opRef, {
        phase: 'profile_applied',
        updated_at: FV.serverTimestamp(),
        lease_until: leaseUntil(now)
      }, { merge: true });
      return op;
    });
  }

  async function applyDeactivation(uid, opId) {
    if (typeof hooks.beforeDeactivation === 'function') {
      await hooks.beforeDeactivation(uid, opId);
    }
    const now = Date.now();
    return db.runTransaction(async function (tx) {
      const opRef = controlRef(uid);
      const opSnap = await tx.get(opRef);
      if (!opSnap.exists) throw recoveryError('מסמך פעולת הזהות חסר.');
      const op = opSnap.data() || {};
      if (op.op_id === opId && op.status === 'completed') return op;
      if (op.op_id !== opId || op.status !== 'processing') {
        throw recoveryError('פעולת הסרת ההרשאות אינה פעילה עוד.');
      }
      if (op.phase === 'profile_applied') return op;
      if (op.phase !== 'tokens_revoked') {
        throw recoveryError('אי אפשר לכבות פרופיל לפני הסרת ההרשאות וביטול הטוקנים.');
      }

      const idxRef = op.previous_emp ? db.doc('emp_index/' + op.previous_emp) : null;
      const idxSnap = idxRef ? await tx.get(idxRef) : null;
      const reqRef = op.request_id ? requestRef(uid) : null;
      const reqSnap = reqRef ? await tx.get(reqRef) : null;

      if (idxSnap && idxSnap.exists && String((idxSnap.data() || {}).uid || '') !== uid) {
        throw recoveryError('מפתח מספר העובד מצביע למשתמש אחר; הוא לא נמחק.');
      }
      if (reqRef) assertRequestMatches(reqSnap && reqSnap.data(), op.request_id,
        op.request_generation, opId, false);

      const off = { is_active: false, updated_at: FV.serverTimestamp() };
      tx.set(db.doc('directory/' + uid), off, { merge: true });
      if (op.previous_station) {
        tx.set(db.doc('stations/' + op.previous_station + '/users/' + uid), off, { merge: true });
        tx.set(db.doc('stations/' + op.previous_station + '/roster/' + uid), off, { merge: true });
      }
      if (idxRef) {
        tx.set(idxRef, {
          uid: uid,
          status: 'retired',
          active: false,
          retired: true,
          retired_at: FV.serverTimestamp()
        });
      }
      tx.set(opRef, {
        phase: 'profile_applied',
        updated_at: FV.serverTimestamp(),
        lease_until: leaseUntil(now)
      }, { merge: true });
      return op;
    });
  }

  async function applyAuth(uid, opId, allowedStartPhases) {
    let op = await getOperation(uid);
    if (!op) throw recoveryError('מסמך פעולת הזהות חסר.');
    if (op.status === 'completed' && op.op_id === opId) return op;
    if (op.op_id !== opId || op.status !== 'processing') {
      throw recoveryError('פעולת הזהות אינה פעילה עוד.');
    }
    if (['auth_applied', 'tokens_revoked', 'profile_applied'].indexOf(op.phase) !== -1 &&
        op.kind !== 'set_role' && op.kind !== 'approve') {
      return op;
    }
    if (['auth_applied', 'tokens_revoked'].indexOf(op.phase) !== -1) return op;
    if (allowedStartPhases.indexOf(op.phase) === -1) {
      throw recoveryError('שלב הפעולה אינו מאפשר שינוי הרשאות.');
    }

    let live = await auth.getUser(uid);
    let liveClaims = (live && live.customClaims) || {};
    const desired = op.desired_claims == null ? {} : op.desired_claims;
    const previous = op.previous_claims || {};

    if (!sameValue(liveClaims, desired)) {
      if (!sameValue(liveClaims, previous)) {
        throw recoveryError('ההרשאות החיות שונות גם מהמצב הקודם וגם מהמצב המתוכנן.');
      }
      try {
        if (typeof hooks.beforeAuthSet === 'function') await hooks.beforeAuthSet(uid, opId);
        await auth.setCustomUserClaims(uid, op.desired_claims == null ? null : op.desired_claims);
        if (typeof hooks.afterAuthSet === 'function') await hooks.afterAuthSet(uid, opId);
      } catch (error) {
        live = await auth.getUser(uid);
        liveClaims = (live && live.customClaims) || {};
        if (!sameValue(liveClaims, desired)) {
          if (!sameValue(liveClaims, previous)) {
            throw recoveryError('שינוי ההרשאות החזיר תוצאה לא ודאית ומצב Auth אינו צפוי.');
          }
          throw httpsError('unavailable',
            'שירות ההזדהות לא השלים את הפעולה. התוכנית נשמרה וניתן לנסות שוב.', {
              retry_safe: true
            });
        }
      }
    }

    live = await auth.getUser(uid);
    if (!sameValue((live && live.customClaims) || {}, desired)) {
      throw recoveryError('אימות ההרשאות לאחר הכתיבה נכשל.');
    }
    await advancePhase(uid, opId, allowedStartPhases, 'auth_applied');
    return getOperation(uid);
  }

  async function revokeTokens(uid, opId, skip) {
    const op = await getOperation(uid);
    if (!op) throw recoveryError('מסמך פעולת הזהות חסר.');
    if (op.status === 'completed' && op.op_id === opId) return op;
    if (op.op_id !== opId || op.status !== 'processing') {
      throw recoveryError('פעולת הזהות אינה פעילה עוד.');
    }
    if (op.phase === 'tokens_revoked' || op.phase === 'profile_applied') return op;
    if (op.phase !== 'auth_applied') {
      throw recoveryError('אי אפשר לבטל טוקנים לפני אימות ההרשאות.');
    }
    if (!skip) {
      try {
        await auth.revokeRefreshTokens(uid);
      } catch (error) {
        throw httpsError('unavailable',
          'ההרשאות השתנו, אך ביטול הטוקנים טרם הושלם. ניתן לנסות שוב בבטחה.', {
            retry_safe: true
          });
      }
    }
    await advancePhase(uid, opId, ['auth_applied'], 'tokens_revoked');
    return getOperation(uid);
  }

  function completedDocument(op, result, assigned, now) {
    return {
      op_id: op.op_id,
      target_uid: op.target_uid,
      kind: op.kind,
      status: 'completed',
      phase: 'completed',
      intent_fingerprint: op.intent_fingerprint,
      plan_fingerprint: op.plan_fingerprint,
      fingerprint_version: 1,
      plan_summary: canonical(op.plan_summary || {}),
      assigned: assigned === true,
      result: canonical(result),
      completed_at: FV.serverTimestamp(),
      updated_at: FV.serverTimestamp(),
      fence_until: fenceUntil(now)
    };
  }

  async function finalizeAssignment(uid, opId, result) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize(uid, opId);
    const live = await auth.getUser(uid);
    let op = await getOperation(uid);
    if (!op) throw recoveryError('מסמך פעולת הזהות חסר.');
    if (op.status === 'completed' && op.op_id === opId) return op.result;
    if (!sameValue((live && live.customClaims) || {}, op.desired_claims || {})) {
      throw recoveryError('ההרשאות השתנו לפני סיום הפעולה. הבקשה נשמרה.');
    }
    if (String((live && live.email) || '').toLowerCase() !==
        String((op.desired_profile || {}).email || '').toLowerCase()) {
      throw recoveryError('כתובת המייל ב-Auth אינה תואמת לתוכנית הזהות.');
    }

    const now = Date.now();
    return db.runTransaction(async function (tx) {
      const opRef = controlRef(uid);
      const opSnap = await tx.get(opRef);
      if (!opSnap.exists) throw recoveryError('מסמך פעולת הזהות חסר.');
      op = opSnap.data() || {};
      if (op.status === 'completed' && op.op_id === opId) return op.result;
      if (op.op_id !== opId || op.status !== 'processing' || op.phase !== 'tokens_revoked') {
        throw recoveryError('פעולת הזהות אינה מוכנה לסיום בטוח.');
      }

      const p = op.desired_profile || {};
      const userSnap = await tx.get(db.doc('stations/' + p.stationId + '/users/' + uid));
      const rosterSnap = await tx.get(db.doc('stations/' + p.stationId + '/roster/' + uid));
      const directorySnap = await tx.get(db.doc('directory/' + uid));
      const indexSnap = await tx.get(db.doc('emp_index/' + op.desired_emp));
      const reservationSnap = await tx.get(reservationRef(op.desired_emp));
      const reqSnap = op.request_id ? await tx.get(requestRef(uid)) : null;
      const oldIndexSnap = op.previous_emp && op.previous_emp !== op.desired_emp ?
        await tx.get(db.doc('emp_index/' + op.previous_emp)) : null;
      const oldUserSnap = op.previous_station && op.previous_station !== p.stationId ?
        await tx.get(db.doc('stations/' + op.previous_station + '/users/' + uid)) : null;
      const oldRosterSnap = op.previous_station && op.previous_station !== p.stationId ?
        await tx.get(db.doc('stations/' + op.previous_station + '/roster/' + uid)) : null;

      const docs = {
        user: userSnap.exists ? userSnap.data() : null,
        roster: rosterSnap.exists ? rosterSnap.data() : null,
        directory: directorySnap.exists ? directorySnap.data() : null,
        index: indexSnap.exists ? indexSnap.data() : null
      };
      op.uid = uid;
      if (!profileMatches(op, docs)) {
        throw recoveryError('הפרופיל או מפתח מספר העובד אינם תואמים לתוכנית.');
      }
      if (oldIndexSnap && (!oldIndexSnap.exists ||
          !retiredIndex(oldIndexSnap.data() || {}, uid))) {
        throw recoveryError('מספר העובד הקודם אינו נעול כ-retired.');
      }
      if ((oldUserSnap && oldUserSnap.exists &&
           (oldUserSnap.data() || {}).is_active !== false) ||
          (oldRosterSnap && oldRosterSnap.exists &&
           (oldRosterSnap.data() || {}).is_active !== false)) {
        throw recoveryError('הרשומה בתחנה הקודמת עדיין פעילה.');
      }
      if (!reservationSnap.exists ||
          String((reservationSnap.data() || {}).uid || '') !== uid ||
          String((reservationSnap.data() || {}).operation_id || '') !== opId) {
        throw recoveryError('שריון מספר העובד אינו תואם לפעולה.');
      }
      if (op.request_id) assertRequestMatches(reqSnap && reqSnap.data(), op.request_id,
        op.request_generation, opId, false);

      if (op.request_id) tx.delete(requestRef(uid));
      tx.delete(reservationRef(op.desired_emp));
      tx.set(opRef, completedDocument(op, result, true, now));
      if (op.audit_path) {
        tx.set(db.doc(op.audit_path), {
          outcome: 'done',
          completed_at: FV.serverTimestamp()
        }, { merge: true });
      }
      return canonical(result);
    });
  }

  async function finalizeClear(uid, opId, result) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize(uid, opId);
    const live = await auth.getUser(uid);
    let op = await getOperation(uid);
    if (!op) throw recoveryError('מסמך פעולת הזהות חסר.');
    if (op.status === 'completed' && op.op_id === opId) return op.result;
    if (!sameValue((live && live.customClaims) || {}, {})) {
      throw recoveryError('ההרשאות אינן ריקות לפני סיום הסרת השיוך.');
    }

    const now = Date.now();
    return db.runTransaction(async function (tx) {
      const opRef = controlRef(uid);
      const opSnap = await tx.get(opRef);
      if (!opSnap.exists) throw recoveryError('מסמך פעולת הזהות חסר.');
      op = opSnap.data() || {};
      if (op.status === 'completed' && op.op_id === opId) return op.result;
      if (op.op_id !== opId || op.status !== 'processing' || op.phase !== 'profile_applied') {
        throw recoveryError('הסרת השיוך אינה מוכנה לסיום בטוח.');
      }

      const directorySnap = await tx.get(db.doc('directory/' + uid));
      const indexSnap = op.previous_emp ? await tx.get(db.doc('emp_index/' + op.previous_emp)) : null;
      const reqSnap = op.request_id ? await tx.get(requestRef(uid)) : null;
      const oldUserSnap = op.previous_station ?
        await tx.get(db.doc('stations/' + op.previous_station + '/users/' + uid)) : null;
      const oldRosterSnap = op.previous_station ?
        await tx.get(db.doc('stations/' + op.previous_station + '/roster/' + uid)) : null;

      if (directorySnap.exists && (directorySnap.data() || {}).is_active !== false) {
        throw recoveryError('הפרופיל עדיין פעיל לאחר הסרת ההרשאות.');
      }
      if (indexSnap && (!indexSnap.exists || !retiredIndex(indexSnap.data() || {}, uid))) {
        throw recoveryError('מספר העובד לא ננעל כ-retired לאחר הסרת ההרשאות.');
      }
      if ((oldUserSnap && oldUserSnap.exists &&
           (oldUserSnap.data() || {}).is_active !== false) ||
          (oldRosterSnap && oldRosterSnap.exists &&
           (oldRosterSnap.data() || {}).is_active !== false)) {
        throw recoveryError('רשומת התחנה עדיין פעילה לאחר הסרת ההרשאות.');
      }
      if (op.request_id) assertRequestMatches(reqSnap && reqSnap.data(), op.request_id,
        op.request_generation, opId, false);

      if (op.request_id) tx.delete(requestRef(uid));
      tx.set(opRef, completedDocument(op, result, false, now));
      if (op.audit_path) {
        tx.set(db.doc(op.audit_path), {
          outcome: 'done',
          completed_at: FV.serverTimestamp()
        }, { merge: true });
      }
      return canonical(result);
    });
  }

  async function finalizeBootstrap(uid, opId, result) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize(uid, opId);
    const live = await auth.getUser(uid);
    let op = await getOperation(uid);
    if (!op) throw recoveryError('מסמך פעולת הזהות חסר.');
    if (op.status === 'completed' && op.op_id === opId) return op.result;
    if (!sameValue((live && live.customClaims) || {}, op.desired_claims || {})) {
      throw recoveryError('הרשאת מנהל המערכת לא אומתה לאחר הכתיבה.');
    }
    const now = Date.now();
    return db.runTransaction(async function (tx) {
      const ref = controlRef(uid);
      const snap = await tx.get(ref);
      if (!snap.exists) throw recoveryError('מסמך פעולת הזהות חסר.');
      op = snap.data() || {};
      if (op.status === 'completed' && op.op_id === opId) return op.result;
      if (op.op_id !== opId || op.status !== 'processing' || op.phase !== 'auth_applied') {
        throw recoveryError('אתחול מנהל המערכת אינו מוכן לסיום.');
      }
      tx.set(ref, completedDocument(op, result, true, now));
      if (op.audit_path) {
        tx.set(db.doc(op.audit_path), {
          outcome: 'done', completed_at: FV.serverTimestamp()
        }, { merge: true });
      }
      return canonical(result);
    });
  }

  async function runAssignment(uid, opId, result, skipRevoke) {
    try {
      let op = await getOperation(uid);
      if (op && op.status === 'completed' && op.op_id === opId) return op.result;
      await applyAssignmentProfile(uid, opId);
      await applyAuth(uid, opId, ['profile_applied']);
      await revokeTokens(uid, opId, skipRevoke === true);
      return await finalizeAssignment(uid, opId, result);
    } catch (error) {
      let completed = await getOperation(uid).catch(function () { return null; });
      if (completed && completed.status === 'completed' && completed.op_id === opId) {
        return completed.result;
      }
      if (error && error.identityRecovery) await markNeedsRecovery(uid, opId, error);
      completed = await getOperation(uid).catch(function () { return null; });
      if (completed && completed.status === 'completed' && completed.op_id === opId) {
        return completed.result;
      }
      throw error;
    }
  }

  async function runClear(uid, opId, result) {
    try {
      let op = await getOperation(uid);
      if (op && op.status === 'completed' && op.op_id === opId) return op.result;
      await applyAuth(uid, opId, ['prepared']);
      await revokeTokens(uid, opId, false);
      await applyDeactivation(uid, opId);
      return await finalizeClear(uid, opId, result);
    } catch (error) {
      let completed = await getOperation(uid).catch(function () { return null; });
      if (completed && completed.status === 'completed' && completed.op_id === opId) {
        return completed.result;
      }
      if (error && error.identityRecovery) await markNeedsRecovery(uid, opId, error);
      completed = await getOperation(uid).catch(function () { return null; });
      if (completed && completed.status === 'completed' && completed.op_id === opId) {
        return completed.result;
      }
      throw error;
    }
  }

  async function runBootstrap(uid, opId, result) {
    try {
      let op = await getOperation(uid);
      if (op && op.status === 'completed' && op.op_id === opId) return op.result;
      await applyAuth(uid, opId, ['prepared']);
      return await finalizeBootstrap(uid, opId, result);
    } catch (error) {
      let completed = await getOperation(uid).catch(function () { return null; });
      if (completed && completed.status === 'completed' && completed.op_id === opId) {
        return completed.result;
      }
      if (error && error.identityRecovery) await markNeedsRecovery(uid, opId, error);
      completed = await getOperation(uid).catch(function () { return null; });
      if (completed && completed.status === 'completed' && completed.op_id === opId) {
        return completed.result;
      }
      throw error;
    }
  }

  async function resumeOperation(params) {
    const op = await getOperation(params.uid);
    if (!op) throw httpsError('not-found', 'פעולת הזהות לא נמצאה.');
    if (String(op.op_id || '') !== String(params.opId || '') ||
        String(op.plan_fingerprint || '') !== String(params.planFingerprint || '')) {
      throw httpsError('failed-precondition',
        'פרטי פעולת ההתאוששות אינם תואמים לתוכנית השמורה.', operationConflict(op));
    }
    if (op.status === 'completed') {
      return { type: 'completed', operation: op, wasRecovery: false };
    }
    if (!activeOperation(op)) {
      throw httpsError('failed-precondition', 'פעולת הזהות אינה ניתנת להמשך.');
    }

    const live = await auth.getUser(params.uid);
    const liveClaims = (live && live.customClaims) || {};
    const previous = op.previous_claims || {};
    const desired = op.desired_claims == null ? {} : op.desired_claims;
    if (!sameValue(liveClaims, previous) && !sameValue(liveClaims, desired)) {
      throw httpsError('failed-precondition',
        'ההרשאות החיות אינן תואמות למצב הקודם או לתוכנית. לא בוצעה דריסה.', {
          recovery_blocked: true,
          operation_id: op.op_id,
          plan_fingerprint: op.plan_fingerprint,
          plan_summary: canonical(op.plan_summary || {}),
          live_assignment_fields: assignmentFields(liveClaims),
          previous_assignment_fields: assignmentFields(previous),
          desired_assignment_fields: assignmentFields(desired)
        });
    }

    const wasRecovery = op.status === 'needs_recovery';
    const auditRef = db.collection('admin_audit').doc();
    const resumed = await db.runTransaction(async function (tx) {
      const ref = controlRef(params.uid);
      const snap = await tx.get(ref);
      if (!snap.exists) throw recoveryError('מסמך פעולת הזהות חסר.');
      const current = snap.data() || {};
      if (current.status === 'completed' && current.op_id === params.opId) return current;
      if (!activeOperation(current) || current.op_id !== params.opId ||
          current.plan_fingerprint !== params.planFingerprint) {
        throw httpsError('aborted', 'פעולת הזהות השתנתה בזמן בקשת ההתאוששות.',
          operationConflict(current));
      }

      let requestSnap = null;
      if (current.request_id) requestSnap = await tx.get(requestRef(params.uid));
      if (current.request_id) {
        assertRequestMatches(requestSnap && requestSnap.data(), current.request_id,
          current.request_generation, current.op_id, false);
      }

      tx.set(ref, {
        status: 'processing',
        recovery_resumed_at: FV.serverTimestamp(),
        updated_at: FV.serverTimestamp(),
        lease_until: leaseUntil(Date.now())
      }, { merge: true });
      if (requestSnap && requestSnap.exists) {
        tx.set(requestSnap.ref, {
          status: 'processing',
          resumable: true,
          recovery_reason: '',
          updated_at: FV.serverTimestamp()
        }, { merge: true });
      }
      tx.set(auditRef, auditDocument(params, 'resume_identity_operation', {
        operation_id: current.op_id,
        plan_fingerprint: current.plan_fingerprint,
        previous_status: current.status
      }));
      tx.set(auditRef, { outcome: 'resumed' }, { merge: true });
      return Object.assign({}, current, { status: 'processing' });
    });
    return { type: resumed.status === 'completed' ? 'completed' : 'resumed',
      operation: resumed, wasRecovery: wasRecovery };
  }

  async function rejectRequest(params) {
    const reqRef = requestRef(params.uid);
    const auditRef = db.collection('admin_audit').doc();
    return db.runTransaction(async function (tx) {
      const reqSnap = await tx.get(reqRef);
      const opSnap = await tx.get(controlRef(params.uid));
      if (!reqSnap.exists) throw httpsError('not-found', 'בקשת ההרשמה לא נמצאה.');
      const request = reqSnap.data() || {};
      const op = opSnap.exists ? (opSnap.data() || {}) : null;
      const orphanedReview =
        (request.status === 'processing' || request.status === 'needs_recovery') &&
        !activeOperation(op);
      if (request.status !== 'pending' && !orphanedReview) {
        throw httpsError('failed-precondition', 'אי אפשר לדחות בקשה שכבר נמצאת בטיפול.');
      }
      const requestId = String(request.request_id || '') || randomId();
      const generation = String(request.server_generation || '') || randomId();
      const stamped = Object.assign({}, request, { request_id: requestId });
      const fingerprint = registrationFingerprint(params.uid, stamped);
      if (!request.request_id || !request.server_generation || !request.request_fingerprint) {
        tx.set(reqRef, {
          request_id: requestId,
          server_generation: generation,
          request_fingerprint: fingerprint,
          fingerprint_version: 1,
          updated_at: FV.serverTimestamp()
        }, { merge: true });
        return { requestStamped: true, requestId: requestId,
          requestGeneration: generation };
      }
      if (String(request.request_fingerprint || '') !== fingerprint) {
        throw httpsError('failed-precondition',
          'תוכן הבקשה השתנה לאחר חתימת השרת. היא לא נמחקה.', {
            request_changed: true
          });
      }
      if (!params.requestGeneration || generation !== String(params.requestGeneration)) {
        throw httpsError('failed-precondition',
          'הבקשה השתנתה מאז שהמסך נטען. רענן לפני הדחייה.', {
            request_changed: true
          });
      }
      if (params.requestId && requestId !== String(params.requestId)) {
        throw httpsError('failed-precondition', 'מזהה ניסיון ההרשמה השתנה. רענן לפני הדחייה.', {
          request_changed: true
        });
      }
      if (activeOperation(op)) {
        throw httpsError('aborted', 'קיימת פעולת זהות פעילה; הבקשה לא נמחקה.');
      }
      tx.delete(reqRef);
      tx.set(auditRef, auditDocument(params,
        orphanedReview ? 'dismiss_orphan_registration' : 'reject_registration', {
        request_id: requestId,
        request_generation: generation,
        request_fingerprint: fingerprint,
        previous_status: request.status,
        recovery_reason: String(request.recovery_reason || '')
      }));
      tx.set(auditRef, { outcome: 'done' }, { merge: true });
      return { requestStamped: false, requestId: requestId,
        requestGeneration: generation, orphanedReview: orphanedReview };
    });
  }

  return {
    acquireAssignment,
    acquireBootstrap,
    getOperation,
    markNeedsRecovery,
    resumeOperation,
    runAssignment,
    runClear,
    runBootstrap,
    rejectRequest
  };
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_FENCE_MS,
  assignmentFields,
  sameValue,
  stableHash,
  activeIndex,
  registrationFingerprint,
  profileMatches,
  createIdentityCoordinator
};
