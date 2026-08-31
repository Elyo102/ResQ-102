'use strict';

const INVITE_LIFETIME_MS = 72 * 60 * 60 * 1000;
const INVITE_SECRET_BYTES = 32;
const INVITE_ID_BYTES = 16;
const INVALID_PUBLIC_RESULT = Object.freeze({ ok:false, error:'invalid' });
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/;
const ID_PATTERN = /^[a-z0-9_-]{2,80}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const SHIFT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class InvitationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'InvitationError';
    this.code = code;
  }
}

function createInvitations(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  for (const name of [
    'clock', 'randomBytes', 'createHash', 'timingSafeEqual',
    'assertMayAssign', 'withinRoleSetterScope'
  ]) {
    if (typeof d[name] !== 'function') {
      throw new TypeError('invitation dependency is required: ' + name);
    }
  }

  function nowMillis(at) {
    const raw = at === undefined ? d.clock() : at;
    const value = toMillis(raw);
    if (!Number.isFinite(value)) {
      throw new InvitationError('invalid-argument', 'invalid clock value');
    }
    return value;
  }

  function issue(gateValue, inputValue) {
    const gate = gateValue && typeof gateValue === 'object' ? gateValue : {};
    const input = inputValue && typeof inputValue === 'object' ? inputValue : {};
    const issuerUid = cleanRequired(inputFrom(gate, ['auth', 'uid']), 'issued_by', 128);
    const isSuper = gate.cap === Infinity;

    let stationId;
    let districtId;
    if (isSuper) {
      stationId = cleanId(input.station_id, 'station_id');
      districtId = cleanId(input.district_id, 'district_id');
    } else {
      const scopedStation = cleanOptionalId(gate.sid, 'gate.station_id');
      const scopedDistrict = cleanOptionalId(gate.did, 'gate.district_id');
      if (!scopedStation || !scopedDistrict) {
        throw new InvitationError('out-of-scope', 'issuer scope is incomplete');
      }
      stationId = resolveScopedInput(input, 'station_id', scopedStation);
      districtId = resolveScopedInput(input, 'district_id', scopedDistrict);
    }

    const role = cleanRole(input.role);
    if (role === 'super_admin') {
      throw new InvitationError('invalid-argument', 'super cannot be invited');
    }
    const shift = cleanShift(input.shift);
    const desired = {
      stationId: stationId,
      districtId: districtId,
      role: role,
      shift: shift
    };

    if (!d.withinRoleSetterScope(gate, {}, desired)) {
      throw new InvitationError('out-of-scope', 'invitation is outside issuer scope');
    }
    d.assertMayAssign(gate, role, {}, '', false, desired);

    const fullName = cleanRequired(input.full_name, 'full_name', 160);
    const email = cleanEmail(input.email, false);
    const phone = cleanOptional(input.phone, 'phone', 40);
    const issuedAt = nowMillis();
    const inviteId = encodeRandom(d.randomBytes(INVITE_ID_BYTES));
    const secret = encodeRandom(d.randomBytes(INVITE_SECRET_BYTES));
    if (inviteId.length < 16 || secret.length < 32) {
      throw new InvitationError('internal', 'secure random output is too short');
    }

    const doc = {
      invite_id: inviteId,
      secret_hash: hashSecret(secret),
      station_id: stationId,
      district_id: districtId,
      role: role,
      shift: shift,
      full_name: fullName,
      email: email,
      phone: phone,
      issued_by: issuerUid,
      issued_at: new Date(issuedAt),
      expires_at: new Date(issuedAt + INVITE_LIFETIME_MS),
      revoked_at: null,
      revoked_by: null,
      redeemed_by: null,
      redeemed_at: null,
      approved_by: null,
      approved_at: null,
      max_uses: 1
    };
    assertSecretAbsent(doc, secret);
    return { invite_id:inviteId, secret:secret, doc:doc };
  }

  function inspect(invite, secret, at) {
    try {
      assertRedeemable(invite, secret, nowMillis(at));
      return {
        ok: true,
        meta: {
          station_id: String(invite.station_id || ''),
          district_id: String(invite.district_id || ''),
          role: String(invite.role || ''),
          shift: String(invite.shift || ''),
          email_locked: String(invite.email || '') !== '',
          expires_at: new Date(toMillis(invite.expires_at))
        }
      };
    } catch (_) {
      return { ok:INVALID_PUBLIC_RESULT.ok, error:INVALID_PUBLIC_RESULT.error };
    }
  }

  function redeem(invite, secret, authValue, clientInput, at) {
    const when = nowMillis(at);
    assertRedeemable(invite, secret, when);
    const auth = authValue && typeof authValue === 'object' ? authValue : {};
    const uid = cleanRequired(auth.uid, 'uid', 128);
    if (auth.email_verified !== true) {
      throw new InvitationError('email-not-verified', 'verified email is required');
    }
    const accountEmail = cleanEmail(auth.email, true);
    const lockedEmail = cleanEmail(invite.email, false);
    if (lockedEmail && accountEmail !== lockedEmail) {
      throw new InvitationError('invalid-invitation', 'invitation is invalid');
    }

    const plan = {
      invite_id: cleanRequired(invite.invite_id, 'invite_id', 128),
      invite_fingerprint: inviteFingerprint(invite),
      redeemed_by: uid,
      update: {
        redeemed_by: uid,
        redeemed_at: new Date(when)
      },
      request: {
        full_name: cleanRequired(invite.full_name, 'full_name', 160),
        email: lockedEmail || accountEmail,
        phone: cleanOptional(invite.phone, 'phone', 40),
        stationId: cleanId(invite.station_id, 'station_id'),
        districtId: cleanId(invite.district_id, 'district_id'),
        role: cleanRole(invite.role),
        shift: cleanShift(invite.shift)
      }
    };

    // Client-supplied assignment fields are deliberately ignored. The
    // invitation is the server-owned source of truth.
    void clientInput;
    return plan;
  }

  function verifyPlan(invite, planValue, at) {
    const when = nowMillis(at);
    assertRedeemableWithoutSecret(invite, when);
    const plan = planValue && typeof planValue === 'object' ? planValue : {};
    const uid = cleanRequired(plan.redeemed_by, 'redeemed_by', 128);
    if (cleanRequired(plan.invite_id, 'invite_id', 128) !==
        cleanRequired(invite.invite_id, 'invite_id', 128) ||
        !constantTimeEquals(String(plan.invite_fingerprint || ''), inviteFingerprint(invite))) {
      throw new InvitationError('invalid-invitation', 'invitation plan is stale');
    }
    const update = plan.update && typeof plan.update === 'object' ? plan.update : {};
    if (String(update.redeemed_by || '') !== uid ||
        !Number.isFinite(toMillis(update.redeemed_at))) {
      throw new InvitationError('invalid-invitation', 'invitation plan is malformed');
    }
    return {
      redeemed_by: uid,
      redeemed_at: new Date(toMillis(update.redeemed_at))
    };
  }

  function revoke(gateValue, invite, at) {
    const gate = gateValue && typeof gateValue === 'object' ? gateValue : {};
    if (!invite || typeof invite !== 'object' || invite.revoked_at ||
        invite.approved_at || invite.approved_by) {
      throw new InvitationError('invalid-invitation', 'invitation cannot be revoked');
    }
    const issuerUid = cleanRequired(inputFrom(gate, ['auth', 'uid']), 'revoked_by', 128);
    const desired = {
      stationId: cleanId(invite.station_id, 'station_id'),
      districtId: cleanId(invite.district_id, 'district_id'),
      role: cleanRole(invite.role),
      shift: cleanShift(invite.shift)
    };
    if (!d.withinRoleSetterScope(gate, {}, desired)) {
      throw new InvitationError('out-of-scope', 'invitation is outside issuer scope');
    }
    d.assertMayAssign(gate, desired.role, {}, '', false, desired);
    return { revoked_at:new Date(nowMillis(at)), revoked_by:issuerUid };
  }

  function assertApprovable(invite, requestValue, at) {
    const request = requestValue && typeof requestValue === 'object' ? requestValue : {};
    void at;
    const redeemedAt = invite && typeof invite === 'object' ? toMillis(invite.redeemed_at) : NaN;
    const expiresAt = invite && typeof invite === 'object' ? toMillis(invite.expires_at) : NaN;
    if (!invite || typeof invite !== 'object' || invite.max_uses !== 1 ||
        invite.revoked_at || invite.approved_at || invite.approved_by ||
        !invite.redeemed_by ||
        !Number.isFinite(redeemedAt) || !Number.isFinite(expiresAt) || redeemedAt >= expiresAt) {
      throw new InvitationError('invalid-invitation', 'invitation is not approvable');
    }
    const uid = cleanRequired(request.uid, 'uid', 128);
    if (uid !== String(invite.redeemed_by || '')) {
      throw new InvitationError('invalid-invitation', 'invitation belongs to another account');
    }
    const lockedEmail = cleanEmail(invite.email, false);
    if (lockedEmail && cleanEmail(request.email, true) !== lockedEmail) {
      throw new InvitationError('invalid-invitation', 'invitation email does not match');
    }
    return {
      stationId: cleanId(invite.station_id, 'station_id'),
      districtId: cleanId(invite.district_id, 'district_id'),
      role: cleanRole(invite.role),
      shift: cleanShift(invite.shift)
    };
  }

  function approve(gateValue, invite, requestValue, at) {
    const gate = gateValue && typeof gateValue === 'object' ? gateValue : {};
    const when = nowMillis(at);
    const approvedBy = cleanRequired(inputFrom(gate, ['auth', 'uid']), 'approved_by', 128);
    const assignment = assertApprovable(invite, requestValue, when);
    const request = requestValue && typeof requestValue === 'object' ? requestValue : {};
    const targetUid = cleanRequired(request.uid, 'uid', 128);

    if (!d.withinRoleSetterScope(gate, {}, assignment)) {
      throw new InvitationError('out-of-scope', 'invitation is outside approver scope');
    }
    d.assertMayAssign(gate, assignment.role, {}, targetUid, false, assignment);

    return {
      assignment: assignment,
      update: {
        approved_by: approvedBy,
        approved_at: new Date(when)
      }
    };
  }

  function resolveScopedInput(input, key, scopedValue) {
    if (!Object.hasOwn(input, key) || input[key] === undefined || input[key] === null ||
        String(input[key]).trim() === '') {
      return scopedValue;
    }
    const supplied = cleanId(input[key], key);
    if (supplied !== scopedValue) {
      throw new InvitationError('out-of-scope', key + ' differs from issuer scope');
    }
    return supplied;
  }

  function hashSecret(secret) {
    const hashed = d.createHash(String(secret));
    if (typeof hashed !== 'string' || !/^[a-f0-9]{64}$/i.test(hashed)) {
      throw new InvitationError('internal', 'hash dependency returned an invalid digest');
    }
    return hashed.toLowerCase();
  }

  function constantTimeEquals(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    if (a.length !== b.length) {
      const dummy = Buffer.alloc(a.length || 1);
      const probe = a.length ? a : Buffer.alloc(1);
      d.timingSafeEqual(probe, dummy);
      return false;
    }
    return a.length > 0 && d.timingSafeEqual(a, b);
  }

  function assertRedeemable(invite, secret, when) {
    assertRedeemableWithoutSecret(invite, when);
    if (!constantTimeEquals(hashSecret(String(secret || '')), String(invite.secret_hash || ''))) {
      throw new InvitationError('invalid-invitation', 'invitation is invalid');
    }
  }

  function assertRedeemableWithoutSecret(invite, when) {
    if (!invite || typeof invite !== 'object' || invite.max_uses !== 1 ||
        invite.revoked_at || invite.redeemed_by ||
        !Number.isFinite(toMillis(invite.expires_at)) || toMillis(invite.expires_at) <= when) {
      throw new InvitationError('invalid-invitation', 'invitation is invalid');
    }
    cleanRequired(invite.invite_id, 'invite_id', 128);
    cleanId(invite.station_id, 'station_id');
    cleanId(invite.district_id, 'district_id');
    cleanRole(invite.role);
    cleanShift(invite.shift);
  }

  function inviteFingerprint(invite) {
    return d.createHash(JSON.stringify({
      invite_id: String(invite.invite_id || ''),
      secret_hash: String(invite.secret_hash || ''),
      station_id: String(invite.station_id || ''),
      district_id: String(invite.district_id || ''),
      role: String(invite.role || ''),
      shift: String(invite.shift || ''),
      email: String(invite.email || ''),
      issued_by: String(invite.issued_by || ''),
      issued_at: toMillis(invite.issued_at),
      expires_at: toMillis(invite.expires_at),
      max_uses: invite.max_uses
    }));
  }

  return Object.freeze({ issue, inspect, redeem, verifyPlan, revoke, assertApprovable, approve });
}

function inputFrom(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return '';
    current = current[key];
  }
  return current;
}

function cleanString(value, field, maxLength, required) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if ((required && !text) || text.length > maxLength || INVISIBLE_OR_CONTROL.test(text)) {
    throw new InvitationError('invalid-argument', 'invalid ' + field);
  }
  return text;
}

function cleanRequired(value, field, maxLength) {
  return cleanString(value, field, maxLength, true);
}

function cleanOptional(value, field, maxLength) {
  return cleanString(value, field, maxLength, false);
}

function cleanId(value, field) {
  const text = cleanRequired(value, field, 80).toLowerCase();
  if (!ID_PATTERN.test(text)) {
    throw new InvitationError('invalid-argument', 'invalid ' + field);
  }
  return text;
}

function cleanOptionalId(value, field) {
  const text = cleanOptional(value, field, 80);
  return text ? cleanId(text, field) : '';
}

function cleanRole(value) {
  const text = cleanRequired(value, 'role', 40).toLowerCase();
  if (!ROLE_PATTERN.test(text)) {
    throw new InvitationError('invalid-argument', 'invalid role');
  }
  return text;
}

function cleanShift(value) {
  const text = cleanOptional(value, 'shift', 30);
  if (text && !SHIFT_PATTERN.test(text)) {
    throw new InvitationError('invalid-argument', 'invalid shift');
  }
  return text;
}

function cleanEmail(value, required) {
  const text = cleanString(value, 'email', 254, required).toLowerCase();
  if (text && (!EMAIL_PATTERN.test(text) || /[^\x21-\x7e]/.test(text))) {
    throw new InvitationError('invalid-argument', 'invalid email');
  }
  return text;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (value && typeof value.toMillis === 'function') return Number(value.toMillis());
  if (typeof value === 'string' && value) return Date.parse(value);
  return NaN;
}

function encodeRandom(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  return buffer.toString('base64url');
}

function assertSecretAbsent(doc, secret) {
  if (JSON.stringify(doc).includes(String(secret))) {
    throw new InvitationError('internal', 'invitation secret leaked into document');
  }
}

module.exports = {
  INVITE_LIFETIME_MS,
  InvitationError,
  createInvitations
};
