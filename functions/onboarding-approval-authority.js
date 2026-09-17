'use strict';

// Server-internal, read-only INITIAL approval adapter. The caller supplies a
// freshly authorized actor, a fresh Admin Auth target record and the request
// and existing identity operation read in this same transaction. This reader
// neither approves nor resumes identity operations or changes station state.
const { createHash } = require('node:crypto');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => !!value && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const uidValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const scopeValid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value);
const requestValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
const hashValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' ? value.normalize('NFC').trim() : '';
const email = value => text(value).toLowerCase();
const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']'
  : plain(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
    : JSON.stringify(value);
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const exactKeys = (value, required, optional = []) => plain(value)
  && required.every(key => own(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

class OnboardingApprovalAuthorityError extends Error {
  constructor(reason) {
    super('Protected onboarding approval authority is invalid: ' + reason);
    this.name = 'OnboardingApprovalAuthorityError';
    this.code = 'failed-precondition';
    this.reason = reason;
  }
}
function fail(reason) { throw new OnboardingApprovalAuthorityError(reason); }

function createOnboardingApprovalAuthority({ db, invitations, contract } = {}) {
  if (!db || typeof db.doc !== 'function' || !invitations
      || typeof invitations.assertApprovable !== 'function'
      || typeof invitations.verifyStoredFingerprint !== 'function'
      || !contract || typeof contract.assertRequestMatchesLink !== 'function'
      || !Array.isArray(contract.REGISTRATION_ALLOWED)) {
    throw new TypeError('Actual onboarding contract, invitation validators and db are required');
  }
  async function readForApproval(tx, input) {
    if (!tx || typeof tx.get !== 'function' || !plain(input)
        || !uidValid(input.uid) || !own(input, 'existingOp')
        || (input.existingOp !== null && !plain(input.existingOp))) fail('input');
    const { uid, request, authUser, existingOp } = input;
    // Presence, including null or malformed data, forbids a legacy fallback.
    if (existingOp !== null && own(existingOp, 'onboarding_authority')) fail('existing-authority');
    const registryPath = 'onboarding_assignment_links/' + uid;
    const registrySnap = await tx.get(db.doc(registryPath));
    if (!registrySnap.exists) return null;
    const registry = registrySnap.data();
    if (!exactKeys(registry, ['schema_version', 'uid', 'station_id', 'request_id', 'invite_id', 'operation_fingerprint'])
        || registry.schema_version !== 1 || registry.uid !== uid || !scopeValid(registry.station_id)
        || !requestValid(registry.request_id) || !uidValid(registry.invite_id)
        || !hashValid(registry.operation_fingerprint)) fail('registry');
    const operationPath = 'stations/' + registry.station_id + '/onboarding_operations/' + registry.request_id;
    const invitationPath = 'invitations/' + registry.invite_id;
    const [opSnap, inviteSnap] = await Promise.all([
      tx.get(db.doc(operationPath)), tx.get(db.doc(invitationPath))
    ]);
    if (!opSnap.exists || !inviteSnap.exists) fail('linked-record-missing');
    const op = opSnap.data(), invite = inviteSnap.data();
    if (!plain(op) || !plain(invite) || op.schema_version !== 1 || op.uid !== uid
        || op.station_id !== registry.station_id || op.request_id !== registry.request_id
        || op.invite_id !== registry.invite_id || op.operation_fingerprint !== registry.operation_fingerprint
        || op.stage !== 'request_created') fail('operation');
    const link = op.assignment_ref;
    if (!exactKeys(link, ['schema_version', 'invite_id', 'invite_fingerprint', 'uid', 'station_id',
      'district_id', 'role', 'shift', 'registration_request_id', 'registration_fingerprint'], ['person_id'])
        || link.schema_version !== 1 || link.uid !== uid || link.invite_id !== registry.invite_id
        || link.station_id !== registry.station_id || !scopeValid(link.district_id)
        || link.registration_request_id !== registry.request_id || !hashValid(link.invite_fingerprint)
        || !hashValid(link.registration_fingerprint) || typeof link.role !== 'string'
        || typeof link.shift !== 'string'
        || (own(link, 'person_id') && (typeof link.person_id !== 'string'
          || !/^sp_[a-z0-9][a-z0-9_-]{7,63}$/.test(link.person_id)))) fail('assignment-link');
    if (!plain(request) || request.status !== 'pending' || request.request_id !== registry.request_id) fail('request');
    try { contract.assertRequestMatchesLink(request, link); }
    catch (error) { if (error.name === 'OnboardingContractError') fail('request-divergence'); throw error; }
    const original = {};
    for (const key of contract.REGISTRATION_ALLOWED) {
      if (key !== 'created_at') original[key] = key === 'status' ? 'pending' : request[key];
    }
    const computed = digest({ v: 1, request_id: registry.request_id, uid,
      invite_id: registry.invite_id, registration: original, assignment: link });
    if (computed !== registry.operation_fingerprint) fail('operation-fingerprint');
    // Admin UserRecord is a class instance; deliberately do not require plain().
    if (!authUser || authUser.uid !== uid || authUser.disabled !== false || authUser.emailVerified !== true
        || !email(authUser.email) || email(authUser.email) !== email(request.email)) fail('target-auth');
    if (invite.invite_id !== registry.invite_id || invite.redeemed_by !== uid
        || invite.redeemed_request_id !== registry.request_id) fail('invitation-binding');
    let assignment;
    try {
      invitations.verifyStoredFingerprint(invite, link.invite_fingerprint);
      assignment = invitations.assertApprovable(invite, { uid, email: email(authUser.email) });
    } catch (error) { if (error.name === 'InvitationError') fail('invitation-invalid'); throw error; }
    if (!assignment || assignment.stationId !== link.station_id || assignment.districtId !== link.district_id
        || assignment.role !== link.role || assignment.shift !== link.shift) fail('assignment-divergence');
    if (text(invite.full_name) !== request.full_name || text(invite.phone) !== request.phone
        || own(invite, 'person_id') !== own(link, 'person_id')
        || (own(link, 'person_id') && invite.person_id !== link.person_id)) fail('invitation-profile');
    const protectedAssignment = Object.freeze({ stationId: link.station_id, districtId: link.district_id,
      role: link.role, shift: link.shift, ...(own(link, 'person_id') ? { person_id: link.person_id } : {}) });
    const source = Object.freeze({ schema_version: 1, uid, registry_path: registryPath,
      operation_path: operationPath, invite_id: registry.invite_id, request_id: registry.request_id,
      operation_fingerprint: computed, invite_fingerprint: link.invite_fingerprint,
      registration_fingerprint: link.registration_fingerprint });
    return Object.freeze({ assignment: protectedAssignment, source,
      fingerprint: digest({ assignment: protectedAssignment, source }) });
  }
  return Object.freeze({ readForApproval });
}

module.exports = Object.freeze({ createOnboardingApprovalAuthority, OnboardingApprovalAuthorityError });
