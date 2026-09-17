'use strict';

// Issuance only: no claims, station activation, delivery, or secret persistence.
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const exact = (v, keys) => plain(v) && keys.every(k => own(v, k)) && Object.keys(v).every(k => keys.includes(k));
const sid = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(v);
const requestId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const normalize = v => typeof v === 'string' ? v.normalize('NFC').trim() : null;

function createStationFirstAdminInvitationService({ db, invitations, provisionContract, requireSuperAdmin, fail } = {}) {
  if (!db || typeof invitations?.issue !== 'function' || typeof invitations?.verifyStoredFingerprint !== 'function'
    || typeof provisionContract?.planStationProvision !== 'function' || typeof requireSuperAdmin !== 'function'
    || typeof fail !== 'function') throw new TypeError('First-admin issuance dependencies required');
  function reject(reason) { fail('failed-precondition', 'First-admin invitation: ' + reason, reason); throw new Error(reason); }
  async function fresh(req, expected) {
    // The injected guard checks signed caller/session AND fresh enabled Admin super.
    const actor = await requireSuperAdmin(req);
    if (!actor || typeof actor.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.uid)
      || (expected && actor.uid !== expected)) reject('actor-changed');
    return actor;
  }
  function validate(station, operation, input, actorUid) {
    if (!plain(station) || !plain(operation) || station.status !== 'provisioning' || station.active !== false
      || station.silent !== true || station.archived === true || station.station_id !== input.station_id
      || station.provision_request_id !== input.provision_request_id || station.created_by !== actorUid
      || operation.actor_uid !== actorUid || operation.schema_version !== 1 || operation.result_status !== 'provisioning') reject('provision-state');
    let plan;
    try {
      plan = provisionContract.planStationProvision({ request_id: input.provision_request_id, station_id: input.station_id,
        district_id: station.districtId, display_name: station.display_name, timezone: station.timezone,
        template_id: station.template_id, actor_uid: actorUid });
    } catch (_) { reject('provision-plan'); }
    if (operation.station_id !== plan.station_id || operation.request_id !== plan.request_id || operation.fingerprint !== plan.fingerprint
      || Object.keys(plan.station_doc).some(k => station[k] !== plan.station_doc[k])
      || !exact(operation.first_admin_invitation_intent, Object.keys(plan.first_admin_invitation_intent))
      || Object.keys(plan.first_admin_invitation_intent).some(k => operation.first_admin_invitation_intent[k] !== plan.first_admin_invitation_intent[k])) reject('provision-intent');
    return plan;
  }
  async function issueFirstAdminInvitation(req) {
    const actor = await fresh(req), input = req?.data;
    const keys = ['station_id', 'provision_request_id', 'request_id', 'full_name', 'email', 'phone', 'shift'];
    if (!exact(input, keys) || !sid(input.station_id) || !requestId(input.request_id)
      || typeof input.provision_request_id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.provision_request_id)
      || ['full_name','email','phone','shift'].some(k => typeof input[k] !== 'string') || !normalize(input.email)) reject('input');
    const stationRef = db.doc('stations/' + input.station_id);
    const operationRef = db.doc(stationRef.path + '/provision_operations/' + input.provision_request_id);
    const [stationSnap, operationSnap] = await Promise.all([stationRef.get(), operationRef.get()]);
    const plan = validate(stationSnap.exists ? stationSnap.data() : null, operationSnap.exists ? operationSnap.data() : null, input, actor.uid);
    const intent = plan.first_admin_invitation_intent;
    // Generated once per invocation, never inside the retrying transaction.
    const candidate = invitations.issue({ auth: { uid: actor.uid }, cap: Infinity, sid: '', did: '' }, {
      station_id: intent.station_id, district_id: intent.district_id, role: intent.role,
      full_name: normalize(input.full_name), email: normalize(input.email), phone: normalize(input.phone), shift: normalize(input.shift)
    });
    if (!candidate.doc.email || !hash(candidate.invite_fingerprint)) reject('engine-result');
    invitations.verifyStoredFingerprint(candidate.doc, candidate.invite_fingerprint);
    return db.runTransaction(async tx => {
      const [s, o] = await Promise.all([tx.get(stationRef), tx.get(operationRef)]);
      const operation = o.exists ? o.data() : null;
      const current = validate(s.exists ? s.data() : null, operation, input, actor.uid);
      if (current.fingerprint !== plan.fingerprint) reject('provision-changed');
      if (own(operation, 'first_admin_invitation') || own(operation, 'first_admin_invitation_request_id')) {
        const a = operation.first_admin_invitation;
        if (!exact(a, ['schema_version','station_id','provision_request_id','invite_id','invite_fingerprint'])
          || a.schema_version !== 1 || a.station_id !== input.station_id || a.provision_request_id !== input.provision_request_id
          || typeof a.invite_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(a.invite_id) || !hash(a.invite_fingerprint)
          || operation.first_admin_invitation_request_id !== input.request_id) reject('issuance-conflict');
        const stored = await tx.get(db.doc('invitations/' + a.invite_id));
        const invite = stored.exists ? stored.data() : null;
        if (!plain(invite) || invite.invite_id !== a.invite_id) reject('invitation-missing');
        invitations.verifyStoredFingerprint(invite, a.invite_fingerprint);
        if (['station_id','district_id','role','shift','full_name','email','phone','issued_by'].some(k => invite[k] !== candidate.doc[k])) reject('issuance-conflict');
        await fresh(req, actor.uid);
        return Object.freeze({ ok: true, replayed: true, invite_id: a.invite_id, secret_available: false });
      }
      await fresh(req, actor.uid);
      tx.create(db.doc('invitations/' + candidate.invite_id), candidate.doc);
      tx.set(operationRef, { first_admin_invitation_request_id: input.request_id,
        first_admin_invitation: { schema_version: 1, station_id: input.station_id, provision_request_id: input.provision_request_id,
          invite_id: candidate.invite_id, invite_fingerprint: candidate.invite_fingerprint } }, { merge: true });
      return Object.freeze({ ok: true, replayed: false, invite_id: candidate.invite_id, secret_available: true, secret: candidate.secret });
    });
  }
  return Object.freeze({ issueFirstAdminInvitation });
}
module.exports = { createStationFirstAdminInvitationService };
