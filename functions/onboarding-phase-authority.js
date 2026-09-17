'use strict';

// Server-only coordinator adapter. No callable authorization or delivery policy.
const { createHash } = require('node:crypto');
const own = (v, k) => !!v && Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v, keys, optional = []) => plain(v) && keys.every(k => own(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : plain(v) ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
const hash = v => createHash('sha256').update(stable(v)).digest('hex');
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const scope = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(v);
const rid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = v => typeof v === 'string' ? v.normalize('NFC').trim() : '';
const email = v => text(v).toLowerCase();
const time = v => v instanceof Date ? v.getTime() : v && typeof v.toMillis === 'function' ? v.toMillis() : NaN;
function fail(reason) { const e = new Error('Onboarding phase authority: ' + reason); e.code = 'failed-precondition'; e.reason = reason; throw e; }

function createOnboardingPhaseAuthority({ db, auth, initialReader, contract, invitations, serverTimestamp, requireStationPerson } = {}) {
  if (!db || !auth || typeof auth.getUser !== 'function' || !initialReader || typeof initialReader.readForApproval !== 'function'
      || !contract || !invitations || typeof invitations.verifyStoredFingerprint !== 'function'
      || typeof serverTimestamp !== 'function' || typeof requireStationPerson !== 'function') throw new TypeError('Complete server authority dependencies required');
  const get = async (tx, path) => { const s = await tx.get(db.doc(path)); return s.exists ? s.data() : null; };
  async function freshActor(actor) {
    if (!actor || !id(actor.uid)) fail('actor');
    const a = await auth.getUser(actor.uid);
    if (!a || a.uid !== actor.uid || a.disabled !== false || a.customClaims?.super !== true) fail('actor');
    return a;
  }
  async function bundle(tx, uid) {
    if (!id(uid)) fail('uid');
    const registry = await get(tx, 'onboarding_assignment_links/' + uid);
    if (!exact(registry, ['schema_version', 'uid', 'station_id', 'request_id', 'invite_id', 'operation_fingerprint'])
        || registry.schema_version !== 1 || registry.uid !== uid || !scope(registry.station_id) || !rid(registry.request_id)
        || !id(registry.invite_id) || !digest(registry.operation_fingerprint)) fail('registry');
    const path = 'stations/' + registry.station_id + '/onboarding_operations/' + registry.request_id;
    const op = await get(tx, path), invite = await get(tx, 'invitations/' + registry.invite_id);
    if (!plain(op) || !plain(invite) || op.schema_version !== 1 || ['uid','station_id','request_id','invite_id','operation_fingerprint'].some(k => op[k] !== registry[k])) fail('operation');
    const link = op.assignment_ref;
    if (!exact(link, ['schema_version','invite_id','invite_fingerprint','uid','station_id','district_id','role','shift','registration_request_id','registration_fingerprint'], ['person_id'])
        || link.schema_version !== 1 || link.uid !== uid || link.station_id !== registry.station_id || link.invite_id !== registry.invite_id
        || link.registration_request_id !== registry.request_id || !scope(link.district_id) || !digest(link.invite_fingerprint)
        || !digest(link.registration_fingerprint) || (own(link,'person_id') && !/^sp_[a-z0-9][a-z0-9_-]{7,63}$/.test(link.person_id))) fail('link');
    const target = await auth.getUser(uid);
    if (!target || target.uid !== uid || target.disabled !== false || target.emailVerified !== true || !email(target.email)) fail('target');
    if (invite.invite_id !== registry.invite_id || invite.redeemed_by !== uid || invite.redeemed_request_id !== registry.request_id
        || invite.revoked_at || !Number.isFinite(time(invite.redeemed_at)) || !Number.isFinite(time(invite.expires_at))
        || time(invite.redeemed_at) >= time(invite.expires_at) || invite.max_uses !== 1) fail('invite-binding');
    invitations.verifyStoredFingerprint(invite, link.invite_fingerprint);
    if (invite.station_id !== link.station_id || invite.district_id !== link.district_id || invite.role !== link.role || invite.shift !== link.shift
        || (email(invite.email) && email(invite.email) !== email(target.email)) || own(invite,'person_id') !== own(link,'person_id')
        || (own(link,'person_id') && invite.person_id !== link.person_id)) fail('assignment');
    const original = { request_id: registry.request_id, full_name: text(invite.full_name), email: email(target.email), phone: text(invite.phone),
      districtId: link.district_id, stationId: link.station_id, shift: link.shift, status: 'pending' };
    contract.assertRequestMatchesLink(original, link);
    if (hash({ v:1, request_id:registry.request_id, uid, invite_id:registry.invite_id, registration:original, assignment:link }) !== registry.operation_fingerprint) fail('full-intent');
    const assignment = { stationId:link.station_id, districtId:link.district_id, role:link.role, shift:link.shift, ...(own(link,'person_id') ? { person_id:link.person_id } : {}) };
    const source = { schema_version:1, uid, registry_path:'onboarding_assignment_links/' + uid, operation_path:path,
      invite_id:registry.invite_id, request_id:registry.request_id, operation_fingerprint:registry.operation_fingerprint,
      invite_fingerprint:link.invite_fingerprint, registration_fingerprint:link.registration_fingerprint };
    return { registry, op, invite, link, target, original, authority:{ assignment, source, fingerprint:hash({ assignment, source }) }, path };
  }
  function receipt(b, operation) {
    if (!plain(operation) || !id(operation.op_id) || operation.target_uid !== b.registry.uid || !id(operation.actor_uid)
        || !exact(operation.onboarding_authority, ['assignment','source','fingerprint'])
        || stable(operation.onboarding_authority) !== stable(b.authority) || operation.request_id !== b.registry.request_id
        || b.invite.approved_identity_operation_id !== operation.op_id || b.invite.approved_by !== operation.actor_uid
        || b.invite.approved_source_fingerprint !== b.authority.fingerprint || !Number.isFinite(time(b.invite.approved_at))) fail('approval-receipt');
  }
  function assignmentPlan(operation, authority, original) {
    for (const value of [operation.desired_claims, operation.desired_profile]) {
      if (!plain(value) || ['stationId','districtId','role','shift'].some(k => value[k] !== authority.assignment[k])) fail('assignment-plan');
    }
    if (operation.desired_claims.super === true || operation.desired_profile.super === true) fail('assignment-plan');
    if (!original || ['full_name','email','phone'].some(k => operation.desired_profile[k] !== original[k])) fail('profile-plan');
  }
  async function classify(tx, { uid, existingOp }) {
    const b = await bundle(tx, uid);
    if (own(existingOp,'onboarding_authority')) return 'protected_existing';
    if (b.op.stage === 'request_created') {
      if (b.invite.approved_identity_operation_id || b.invite.approved_at || b.invite.approved_by) fail('stripped-authority');
      return 'new_onboarding';
    }
    if (b.op.stage !== 'assignment_completed' || !id(b.op.identity_operation_id) || b.invite.approved_identity_operation_id !== b.op.identity_operation_id
        || b.invite.approved_source_fingerprint !== b.authority.fingerprint || !id(b.invite.approved_by) || !Number.isFinite(time(b.invite.approved_at))) fail('completion');
    if (!existingOp || existingOp.op_id === b.op.identity_operation_id) fail('stripped-authority');
    return 'legacy';
  }
  async function readInitial(tx, input) {
    await freshActor(input.actor);
    const target = await auth.getUser(input.uid);
    const authority = await initialReader.readForApproval(tx, { ...input, authUser:target });
    if (!authority) fail('initial-source');
    await requireStationPerson({ tx, uid:input.uid, assignment:authority.assignment, actor:input.actor, phase:'initial' });
    await freshActor(input.actor);
    return authority;
  }
  async function commitApproval(tx, { operation, authority, actor }) {
    const uid = operation.target_uid;
    if (!id(uid)) fail('uid');
    const existingOp = await get(tx, 'identity_operations/' + uid);
    const request = await get(tx, 'registration_requests/' + uid);
    const checked = await readInitial(tx, { uid, existingOp, request, actor });
    if (stable(checked) !== stable(authority) || stable(operation.onboarding_authority) !== stable(checked)
        || operation.actor_uid !== actor.uid || operation.kind !== 'approve' || operation.status !== 'processing' || operation.phase !== 'prepared'
        || operation.request_id !== checked.source.request_id || !id(operation.op_id)) fail('prepared-plan');
    assignmentPlan(operation, checked, request);
    tx.set(db.doc('invitations/' + checked.source.invite_id), { approved_by:actor.uid, approved_at:serverTimestamp(),
      approved_identity_operation_id:operation.op_id, approved_source_fingerprint:checked.fingerprint }, { merge:true });
  }
  async function validatePhase(tx, { operation, request, phase, actor }) {
    await freshActor(actor);
    const b = await bundle(tx, operation?.target_uid);
    receipt(b, operation);
    if (operation.status === 'completed') {
      if (b.op.stage !== 'assignment_completed' || b.op.identity_operation_id !== operation.op_id || request !== null) fail('completed-state');
    } else {
      if (!['processing','needs_recovery'].includes(operation.status) || b.op.stage !== 'request_created' || !request
          || !['pending','processing'].includes(request.status)) fail('active-state');
      contract.assertRequestMatchesLink(request, b.link);
      assignmentPlan(operation, b.authority, b.original);
    }
    await requireStationPerson({ tx, uid:operation.target_uid, assignment:b.authority.assignment, actor, phase });
    await freshActor(actor);
    return b;
  }
  async function finalize(tx, { operation, actor }) {
    await freshActor(actor);
    const b = await bundle(tx, operation.target_uid);
    receipt(b, operation);
    if (b.op.stage !== 'request_created') fail('finalize-state');
    assignmentPlan(operation, b.authority, b.original);
    await requireStationPerson({ tx, uid:operation.target_uid, assignment:b.authority.assignment, actor, phase:'finalize-write' });
    await freshActor(actor);
    tx.set(db.doc(b.path), { stage:'assignment_completed', identity_operation_id:operation.op_id,
      assignment_completed_at:serverTimestamp() }, { merge:true });
  }
  return Object.freeze({ classify, readInitial, validatePhase, commitApproval, finalize });
}
module.exports = { createOnboardingPhaseAuthority };
