'use strict';

/*
 * invitation-onboarding-service.js
 *
 * Wires the EXISTING invitation engine to the EXISTING identity mechanisms.
 * It creates neither.  Both arrive as injected, documented dependencies:
 *
 *   invitations     the object returned by createInvitations(...) in
 *                   functions/invitations.js.  Used for redeem() and
 *                   verifyPlan().  NOT reimplemented here.
 *   registration    the approval mechanism's own state reader.  Used ONLY to
 *                   ask whether an assignment was actually completed.  This
 *                   service never approves and never sets a claim.
 *   identityStore   the object returned by createScheduleIdentityStore(...).
 *                   Used only to read whether a person is already linked.
 *   db, serverTimestamp, fail, requireAuth, requireSuperAdmin
 *
 * FOUR RULINGS THIS FILE IS RESPONSIBLE FOR:
 *
 *   The invitation is marked redeemed in the SAME transaction that writes the
 *   onboarding operation record.  There is no state in which an invitation is
 *   spent and no operation exists.
 *
 *   REDEEMING IS NOT APPROVING.  Nothing here grants a permission, sets a
 *   claim or approves a registration.  Approval stays an explicit super-admin
 *   action in the existing mechanism.
 *
 *   A registration request belonging to a different operation is never
 *   overwritten.
 *
 *   The redemption plan is derived from the invitation document this service
 *   read from Firestore and verified with the invitation engine's own
 *   verifyPlan().  A `redeemed` object presented by a caller is not accepted.
 */

const OPERATION_SCHEMA = 1;
const STAGE_REQUEST_CREATED = 'request_created';

function createInvitationOnboardingService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  for (const name of ['db', 'contract', 'invitations', 'registration', 'identityStore',
    'serverTimestamp', 'fail', 'requireAuth', 'requireSuperAdmin']) {
    if (d[name] === undefined || d[name] === null) {
      throw new TypeError('onboarding dependency is required: ' + name);
    }
  }
  const { db, contract, invitations, registration, identityStore,
    serverTimestamp, fail, requireAuth, requireSuperAdmin } = d;

  const inviteRef = (inviteId) => db.doc('invitations/' + inviteId);
  const registrationRef = (uid) => db.doc('registration_requests/' + uid);
  const assignmentRegistryRef = (uid) => db.doc('onboarding_assignment_links/' + uid);
  const operationRef = (sid, requestId) =>
    db.doc('stations/' + sid + '/onboarding_operations/' + requestId);

  const dataOf = (snap) => (snap && snap.exists ? (snap.data() || null) : null);
  const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const safeId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  const safeRequest = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(v);
  const sameLink = (a, b) => plain(a) && plain(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(b).every(key => a[key] === b[key]);
  async function recheck(req, original, guard) {
    const current = await guard(req);
    if (!current || current.uid !== original.uid || current.email !== original.email ||
        current.email_verified !== original.email_verified) {
      fail('permission-denied', 'זהות החשבון השתנתה במהלך הפעולה.', 'auth-changed');
    }
  }

  function contractFail(error) {
    if (error && error.name === 'OnboardingContractError') {
      fail('failed-precondition', error.message, error.code);
    }
    throw error;
  }
  function inviteFail(error) {
    if (error && error.name === 'InvitationError') {
      fail('failed-precondition', error.message, error.code);
    }
    throw error;
  }

  /* Reads the invitation from Firestore by id and lets the INVITATION ENGINE
   * produce and validate the plan. The secret never leaves this function and
   * is never written anywhere. */
  async function derivePlan(tx, auth, input) {
    const inviteId = typeof input.invite_id === 'string' ? input.invite_id.trim() : '';
    if (!safeId(input.invite_id) || inviteId !== input.invite_id) fail('invalid-argument', 'מזהה ההזמנה חסר.', 'invite-id');
    /* A caller can forge source:'server_document', a fingerprint, an invitation
     * document and a redemption plan - all four are just JSON. So none of them
     * is accepted as input at all. The service reads the stored invitation
     * itself and sets the marker from inside; the marker's meaning comes from
     * the fact that only this function can set it, never from the caller's
     * word. */
    for (const forbidden of ['redeemed', 'plan', 'invite', 'source',
      'recomputed_fingerprint', 'invite_fingerprint', 'role', 'station_id',
      'district_id', 'assignment_ref']) {
      if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
        fail('invalid-argument',
          'השדה ' + forbidden + ' נגזר ממסמך ההזמנה בשרת ואינו מתקבל מהקורא.',
          'client-supplied-plan');
      }
    }
    const secret = typeof input.secret === 'string' ? input.secret : '';
    if (!secret) fail('invalid-argument', 'סוד ההזמנה חסר.', 'secret-missing');

    const inviteSnap = await tx.get(inviteRef(inviteId));
    const invite = dataOf(inviteSnap);
    if (!invite) fail('not-found', 'ההזמנה אינה קיימת.', 'invite-missing');
    if (invite.invite_id !== inviteId || typeof invite.station_id !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(invite.station_id)) {
      fail('failed-precondition', 'מסמך ההזמנה אינו תקין.', 'invite-shape');
    }
    const operation = dataOf(await tx.get(operationRef(invite.station_id, input.request_id)));

    let plan;
    try { plan = operation
      ? invitations.verifyRedemptionReplay(invite, secret, auth, input.request_id)
      : invitations.redeem(invite, secret, auth, null); }
    catch (error) { inviteFail(error); }

    /* The engine's own staleness check, re-derived from the stored document.
     * Only after this passes may the plan's fingerprint be treated as having
     * been recomputed from the server document. */
    try { if (!operation) invitations.verifyPlan(invite, plan); }
    catch (error) { inviteFail(error); }

    return { invite, plan, inviteId, operation };
  }

  async function redeemInvitation(req) {
    const auth = await requireAuth(req);
    const input = plain(req && req.data) ? req.data : {};
    const requestId = typeof input.request_id === 'string' ? input.request_id.trim() : '';
    if (Object.keys(input).length !== 3 || Object.keys(input).some(k => !['request_id', 'invite_id', 'secret'].includes(k))) {
      fail('invalid-argument', 'מתקבלים מזהי פעולה והזמנה וסוד בלבד.', 'client-supplied-plan');
    }
    if (!safeRequest(input.request_id) || requestId !== input.request_id || !auth || !safeId(auth.uid)) {
      fail('invalid-argument', 'מזהה פעולה או חשבון אינו תקין.', 'request-id');
    }

    return db.runTransaction(async (tx) => {
      const { invite, plan, inviteId, operation } = await derivePlan(tx, auth, input);

      let split;
      try {
        split = contract.splitRedemption({
          source: 'server_document',
          invite: invite,
          redeemed: plan,
          recomputed_fingerprint: plan.invite_fingerprint,
          auth: auth,
          request_id: requestId
        });
      } catch (error) { contractFail(error); }

      const sid = split.station_id;
      const [existingRequestSnap, registrySnap] = await Promise.all([
        tx.get(registrationRef(split.uid)), tx.get(assignmentRegistryRef(split.uid))
      ]);
      const expectedRegistry = Object.freeze({ schema_version: OPERATION_SCHEMA,
        uid: split.uid, station_id: sid, request_id: requestId, invite_id: inviteId,
        operation_fingerprint: split.operation_fingerprint });
      const registry = dataOf(registrySnap);

      /* Retry of our own operation. */
      if (operation) {
        if (!sameLink(registry, expectedRegistry)) {
          fail('failed-precondition', 'הקישור המוגן למימוש חסר או השתנה.', 'onboarding-registry-mismatch');
        }
        if (operation.operation_fingerprint !== split.operation_fingerprint ||
            operation.uid !== split.uid || operation.invite_id !== inviteId ||
            operation.station_id !== sid || operation.request_id !== requestId ||
            operation.schema_version !== OPERATION_SCHEMA ||
            !sameLink(operation.assignment_ref, split.assignment_ref) ||
            !contract.ONBOARDING_STAGES.includes(operation.stage)) {
          fail('failed-precondition',
            'אותו מזהה פעולה כבר שימש לכוונה אחרת.', 'onboarding-intent-changed');
        }
        await recheck(req, auth, requireAuth);
        return Object.freeze({
          ok: true, replayed: true, stage: operation.stage,
          approved: false, permissions_granted: false,
          station_id: sid, uid: split.uid, request_id: requestId
        });
      }
      // Any orphan/foreign registry is preserved, even if its fields happen
      // to match. Only a committed operation may authenticate a replay.
      if (registrySnap.exists) {
        fail('failed-precondition', 'קיים קישור קליטה לחשבון ואין לדרוס אותו.', 'onboarding-registry-exists');
      }

      /* The invitation must not already be spent by someone else. A spent
       * invitation with no operation of ours is not ours to complete. */
      if (invite.redeemed_by && invite.redeemed_by !== split.uid) {
        fail('failed-precondition', 'ההזמנה כבר מומשה בחשבון אחר.', 'invite-spent');
      }

      const existingRequest = dataOf(existingRequestSnap);
      let permission;
      try { permission = contract.mayWriteRegistration(existingRequest, split); }
      catch (error) { contractFail(error); }
      if (!permission.allowed) {
        fail('failed-precondition',
          'קיימת בקשת הרשמה של פעולה אחרת ואין לדרוס אותה.', 'registration-foreign');
      }
      if (existingRequest) {
        try { contract.assertRequestMatchesLink(existingRequest, split.assignment_ref); }
        catch (error) { contractFail(error); }
      }
      await recheck(req, auth, requireAuth);

      /* One transaction: invitation, request, operation and protected UID
       * registry commit together, or none of the four happen. */
      tx.set(inviteRef(inviteId), {
        redeemed_by: split.uid,
        redeemed_at: serverTimestamp(),
        redeemed_request_id: requestId
      }, { merge: true });

      tx.set(registrationRef(split.uid),
        Object.assign({}, split.registration_request, { created_at: serverTimestamp() }));

      tx.set(operationRef(sid, requestId), {
        schema_version: OPERATION_SCHEMA,
        station_id: sid,
        request_id: requestId,
        uid: split.uid,
        invite_id: inviteId,
        assignment_ref: split.assignment_ref,
        operation_fingerprint: split.operation_fingerprint,
        stage: STAGE_REQUEST_CREATED,
        created_at: serverTimestamp()
      });
      tx.set(assignmentRegistryRef(split.uid), expectedRegistry);

      /* Said out loud in the return value so no caller can read this as
       * onboarding being finished: a redemption grants nothing. */
      return Object.freeze({
        ok: true,
        replayed: false,
        stage: STAGE_REQUEST_CREATED,
        approved: false,
        permissions_granted: false,
        station_id: sid,
        uid: split.uid,
        request_id: requestId
      });
    });
  }

  /* Resume. Reads the three states from the mechanisms that own them and asks
   * the contract what comes next. It never infers approval from the existence
   * of a request, and it never approves. */
  async function resumeOnboarding(req) {
    const auth = await requireSuperAdmin(req);
    const input = plain(req && req.data) ? req.data : {};
    const sid = typeof input.station_id === 'string' ? input.station_id.trim() : '';
    const requestId = typeof input.request_id === 'string' ? input.request_id.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sid) || sid !== input.station_id ||
        !safeRequest(requestId) || requestId !== input.request_id) fail('invalid-argument', 'חסרים מזהה תחנה או מזהה פעולה.', 'resume-input');
    for (const forbidden of ['assignment_completed', 'person_linked', 'stage']) {
      if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
        fail('invalid-argument',
          'מצב הקליטה נקרא מהמנגנונים ואינו מתקבל מהקורא.', 'state-from-client');
      }
    }
    if (Object.keys(input).length !== 2 || Object.keys(input).some(key => !['station_id', 'request_id'].includes(key))) {
      fail('invalid-argument', 'מצב הקליטה נקרא מהשרת בלבד.', 'state-from-client');
    }

    const operationSnap = await db.doc('stations/' + sid + '/onboarding_operations/' + requestId).get();
    const operation = dataOf(operationSnap);
    if (!operation) fail('not-found', 'פעולת הקליטה אינה קיימת.', 'operation-missing');
    const ref = operation.assignment_ref;
    if (operation.schema_version !== OPERATION_SCHEMA || operation.station_id !== sid ||
        operation.request_id !== requestId || !safeId(operation.uid) || !safeId(operation.invite_id) ||
        !contract.ONBOARDING_STAGES.includes(operation.stage) ||
        !/^[a-f0-9]{64}$/.test(operation.operation_fingerprint || '') ||
        !plain(ref) || ref.schema_version !== OPERATION_SCHEMA || ref.station_id !== sid ||
        ref.uid !== operation.uid || ref.invite_id !== operation.invite_id ||
        ref.registration_request_id !== requestId ||
        !/^[a-f0-9]{64}$/.test(ref.registration_fingerprint || '') ||
        !/^[a-f0-9]{64}$/.test(ref.invite_fingerprint || '') ||
        (Object.prototype.hasOwnProperty.call(ref, 'person_id') &&
          (typeof ref.person_id !== 'string' || !/^sp_[a-z0-9][a-z0-9_-]{7,63}$/.test(ref.person_id)))) {
      fail('failed-precondition', 'רשומת הקליטה אינה תואמת לזהות ולפעולה.', 'operation-shape');
    }

    const assignment = await registration.assignmentState({
      uid: operation.uid, station_id: sid, request_id: requestId
    });
    if (assignment === null || assignment === undefined
        || typeof assignment.completed !== 'boolean') {
      fail('failed-precondition',
        'מנגנון ההרשמה לא החזיר מצב אישור מפורש. קיום בקשה אינו אישור.',
        'assignment-state-unavailable');
    }

    let personLinked;
    const personRequired = operation.assignment_ref
      && typeof operation.assignment_ref.person_id === 'string'
      && operation.assignment_ref.person_id.length > 0;
    if (personRequired) {
      const link = await identityStore.linkState({
        station_id: sid, person_id: operation.assignment_ref.person_id, uid: operation.uid
      });
      if (!link || typeof link.linked !== 'boolean') {
        fail('failed-precondition', 'מנגנון הזהויות לא החזיר מצב קישור מפורש.', 'link-state-unavailable');
      }
      personLinked = link.linked;
    }

    let next;
    try {
      next = contract.nextOnboardingStep({
        request_created: true,
        assignment_completed: assignment.completed,
        person_required: !!personRequired,
        person_linked: personLinked
      });
    } catch (error) { contractFail(error); }

    await recheck(req, auth, requireSuperAdmin);
    return Object.freeze({
      ok: true,
      station_id: sid,
      request_id: requestId,
      uid: operation.uid,
      step: next.step,
      stage: next.stage,
      blocked: next.blocked,
      approved: assignment.completed,
      inspected_by: auth.uid
    });
  }

  return Object.freeze({ redeemInvitation, resumeOnboarding });
}

module.exports = Object.freeze({
  OPERATION_SCHEMA,
  STAGE_REQUEST_CREATED,
  createInvitationOnboardingService
});
