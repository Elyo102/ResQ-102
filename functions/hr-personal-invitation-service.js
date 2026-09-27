'use strict';

const crypto = require('node:crypto');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
const sid = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));

// This issuer creates an invitation, never an Auth account or a role assignment.
function createHrPersonalInvitationService({ db, invitations, requireSuperAdmin, knownDistricts, fail, clock = Date.now }) {
  if (!Array.isArray(knownDistricts) || !knownDistricts.length) throw new TypeError('Known districts required');
  const reject = (reason, code = 'failed-precondition') => { fail(code, 'הזמנת HR לא אושרה: ' + reason); throw Error(reason); };
  async function fresh(req, uid) {
    const actor = await requireSuperAdmin(req);
    if (!actor?.uid || (uid && actor.uid !== uid)) reject('actor-changed', 'permission-denied');
    return actor;
  }
  function station(data, stationId) {
    if (!data || data.active !== true || data.archived === true
      || (Object.hasOwn(data, 'archived') && typeof data.archived !== 'boolean')
      || (Object.hasOwn(data, 'station_id') && data.station_id !== stationId)
      || (Object.hasOwn(data, 'status') && !['ready','active'].includes(data.status))
      || (Object.hasOwn(data, 'silent') && typeof data.silent !== 'boolean')
      || !knownDistricts.includes(data.districtId)) reject('station-not-active');
    if ((Object.hasOwn(data,'template_id') || Object.hasOwn(data,'provision_request_id')) &&
      (data.template_id!=='fire-station-v1'||data.schema_version!==1||data.station_id!==stationId||data.status!=='ready'
       || typeof data.silent!=='boolean'||typeof data.provision_request_id!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(data.provision_request_id))) reject('station-not-ready');
    return data.districtId;
  }
  async function issueHrInvitation(req) {
    const actor = await fresh(req), input = req.data;
    if (!exact(input, ['request_id','station_id','full_name','email']) || !id(input.request_id)
      || !sid(input.station_id) || typeof input.full_name !== 'string' || typeof input.email !== 'string') reject('input', 'invalid-argument');
    const name = input.full_name.normalize('NFC').trim(), email = input.email.normalize('NFC').trim().toLowerCase();
    if (!name || name.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) reject('input', 'invalid-argument');
    const stationRef = db.doc('stations/' + input.station_id);
    const before = await stationRef.get(), district = station(before.exists ? before.data() : null, input.station_id);
    const intent = digest([actor.uid, input.station_id, district, name, email]);
    const operationRef = db.doc('hr_invitation_operations/' + digest([actor.uid, input.request_id]));
    const recipientRef = db.doc('hr_invitation_recipients/' + digest([input.station_id, email]));
    const candidate = invitations.issue({ auth:{ uid:actor.uid }, cap:Infinity, sid:'', did:'' }, {
      station_id:input.station_id, district_id:district, role:'hr_coordinator', shift:'', full_name:name, email, phone:''
    });
    return db.runTransaction(async tx => {
      const [s, operation, recipient] = await Promise.all([tx.get(stationRef), tx.get(operationRef), tx.get(recipientRef)]);
      if (station(s.exists ? s.data() : null, input.station_id) !== district) reject('station-changed');
      if (operation.exists) {
        const saved = operation.data();
        if (saved.intent !== intent || saved.actor_uid !== actor.uid) reject('request-conflict');
        const stored = await tx.get(db.doc('invitations/' + saved.invite_id));
        if (!stored.exists) reject('invitation-missing');
        invitations.verifyStoredFingerprint(stored.data(), saved.fingerprint);
        await fresh(req, actor.uid);
        const prior=stored.data();
        return { ok:true, replayed:true, invite_id:saved.invite_id, secret_available:false,
          state:prior.redeemed_by?'REDEEMED':prior.revoked_at?'REVOKED':'PENDING' };
      }
      if (recipient.exists) {
        const previous = recipient.data();
        const existing = await tx.get(db.doc('invitations/' + previous.invite_id));
        const invite = existing.exists ? existing.data() : null;
        const expiry = invite?.expires_at?.toMillis ? invite.expires_at.toMillis() : Number(new Date(invite?.expires_at));
        if (invite && !invite.revoked_at && (invite.redeemed_by || expiry > clock())) {
          if (invite.email !== email || invite.station_id !== input.station_id || invite.role !== 'hr_coordinator') reject('recipient-mismatch');
          await fresh(req, actor.uid);
          return { ok:true, existing:true, invite_id:previous.invite_id, secret_available:false,
            state:invite.redeemed_by ? 'REDEEMED' : 'PENDING' };
        }
        if (Number(previous.issued_at_ms) + 60000 > clock()) reject('cooldown', 'resource-exhausted');
      }
      await fresh(req, actor.uid);
      tx.create(db.doc('invitations/' + candidate.invite_id), candidate.doc);
      tx.create(operationRef, { actor_uid:actor.uid, intent, invite_id:candidate.invite_id, fingerprint:candidate.invite_fingerprint, created_at:new Date(clock()) });
      tx.set(recipientRef, { invite_id:candidate.invite_id, issued_at_ms:clock() });
      return { ok:true, replayed:false, invite_id:candidate.invite_id, secret_available:true, secret:candidate.secret,
        expires_at_ms:candidate.doc.expires_at.getTime() };
    });
  }
  async function revokeHrInvitation(req) {
    const actor = await fresh(req), input = req.data;
    if (!exact(input, ['invite_id']) || !id(input.invite_id)) reject('input', 'invalid-argument');
    const ref = db.doc('invitations/' + input.invite_id);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref), invite = snap.exists ? snap.data() : null;
      if (!invite || invite.role !== 'hr_coordinator' || !invite.email) reject('not-hr-invitation');
      if (invite.approved_at || invite.redeemed_by) reject('already-redeemed');
      await fresh(req, actor.uid);
      if (!invite.revoked_at) tx.set(ref, invitations.revoke({ auth:{ uid:actor.uid }, cap:Infinity, sid:'', did:'' }, invite), { merge:true });
      return { ok:true, state:'REVOKED', invite_id:input.invite_id };
    });
  }
  return { issueHrInvitation, revokeHrInvitation };
}
module.exports = { createHrPersonalInvitationService };
