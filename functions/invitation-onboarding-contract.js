'use strict';

/*
 * invitation-onboarding-contract.js
 *
 * Pure translation and resume contract between the EXISTING invitation engine
 * (functions/invitations.js) and the EXISTING identity mechanisms
 * (registration approval, and functions/schedule-identity-store.js).
 *
 * NO NEW INVITATION ENGINE AND NO NEW IDENTITY ENGINE LIVE HERE.  This module
 * splits a redemption plan into the part a client may write and the part that
 * must stay on the server, and it decides which stage of onboarding runs next.
 * Nothing else.
 *
 * THREE RULINGS ARE ENCODED STRUCTURALLY, not documented and hoped for:
 *
 *   ROLE never enters the client-writable registration request, because the
 *   Firestore rules do not permit it there and it is an assignment field.
 *   Station, district and shift ARE permitted there - the rules require them -
 *   but the request is not their authority: the protected link is, and
 *   splitRedemption asserts the two agree so a tampered request is detected
 *   rather than silently preferred.
 *
 *   A fingerprint is a CONSISTENCY check, never proof of authenticity.  The
 *   redemption must be accompanied by the invitation document the caller read
 *   from the server, marked as such; a plan presented on its own is refused no
 *   matter how well-formed.
 *
 *   Redeeming is not approving.  The existence of a registration request is
 *   never a reason to skip approval: nextOnboardingStep() refuses to guess the
 *   approval state and demands it from the mechanism that owns it.
 *
 * No Firebase, no db, no clock, no randomness.  node:crypto only.
 */

const crypto = require('node:crypto');

class OnboardingContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OnboardingContractError';
    this.code = code;
  }
}

const SCHEMA_VERSION = 1;

/* Exactly the keys firestore.rules permits on registration_requests/{uid}.
 * created_at is listed because the rules require it, and is supplied by the
 * server - this module has no clock. */
const REGISTRATION_ALLOWED = Object.freeze([
  'request_id', 'full_name', 'email', 'phone', 'districtId', 'stationId',
  'shift', 'status', 'created_at'
]);
const REGISTRATION_SERVER_SUPPLIED = Object.freeze(['created_at']);

/* Two DIFFERENT lists, because conflating them is how a contract stops
 * matching the rules it claims to obey.
 *
 * REQUEST_FORBIDDEN is what the Firestore rules do not permit on the
 * client-written registration request. That is role, and role alone.
 *
 * ASSIGNMENT_AUTHORITY is wider: station, district and shift ARE permitted on
 * the request - the rules in fact REQUIRE them - but the request is not their
 * authority. The protected link is. Approval derives the assignment from the
 * link, never from the document the client wrote, and splitRedemption asserts
 * the two agree so a tampered request is detectable rather than silently
 * preferred. */
const REQUEST_FORBIDDEN = Object.freeze(['role']);
const ASSIGNMENT_AUTHORITY = Object.freeze(['role', 'station_id', 'district_id', 'shift']);

const ONBOARDING_STAGES = Object.freeze(['request_created', 'assignment_completed', 'person_linked']);

const SECRET_HINTS = Object.freeze(['secret', 'token', 'password', 'secret_hash', 'otp']);

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,100}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const ROLE_RE = /^[a-z][a-z0-9_]{1,39}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

function fail(code, message) { throw new OnboardingContractError(code, message); }
function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function has(v, k) { return Object.prototype.hasOwnProperty.call(v, k); }

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }

function text(value, max, code, label) {
  if (typeof value !== 'string') fail(code, label + ' חסר או אינו מחרוזת.');
  const out = value.normalize('NFC').trim();
  if (!out || out.length > max || UNSAFE_TEXT.test(out)) fail(code, label + ' חסר או אינו בטוח.');
  return out;
}

/* Deep scan for anything that looks like a credential. Runs on the outputs,
 * so a future change that starts carrying a secret fails here rather than in
 * production. */
function assertNoSecret(value, where) {
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase();
      for (const hint of SECRET_HINTS) {
        if (lower === hint || lower.endsWith('_' + hint)) {
          fail('secret-leak', 'סוד דלף אל ' + where + ' דרך השדה ' + key + '.');
        }
      }
      walk(node[key]);
    }
  })(value);
  return true;
}

/* A fingerprint proves the two halves agree with each other. It proves NOTHING
 * about where they came from. Authenticity comes from `source`: the caller
 * must state that the invitation was read from a server document, and must
 * pass that document. A browser-supplied plan cannot satisfy this. */
function assertTrustedRedemption(input) {
  if (!plain(input)) fail('redemption-shape', 'קלט המימוש אינו תקין.');
  if (input.source !== 'server_document') {
    fail('untrusted-source',
      'מימוש מתקבל רק מקריאה של מסמך ההזמנה בשרת. אובייקט מהלקוח אינו מקור.');
  }
  const invite = input.invite;
  const redeemed = input.redeemed;
  if (!plain(invite) || !plain(redeemed)) fail('redemption-shape', 'חסרים מסמך ההזמנה או תוכנית המימוש.');
  if (typeof input.recomputed_fingerprint !== 'string' || !input.recomputed_fingerprint) {
    fail('fingerprint-missing', 'טביעת האצבע לא חושבה מחדש מתוך מסמך ההזמנה.');
  }
  if (typeof redeemed.invite_fingerprint !== 'string'
      || redeemed.invite_fingerprint !== input.recomputed_fingerprint) {
    fail('fingerprint-mismatch', 'תוכנית המימוש אינה תואמת למסמך ההזמנה שנקרא בשרת.');
  }
  if (typeof redeemed.invite_id !== 'string' || redeemed.invite_id !== invite.invite_id) {
    fail('invite-id-mismatch', 'מזהה ההזמנה בתוכנית אינו תואם למסמך.');
  }
  return true;
}

/* Splits one redemption into: what the client may write, and what stays on
 * the server. The two never overlap. */
function splitRedemption(input) {
  assertTrustedRedemption(input);
  const invite = input.invite;
  const redeemed = input.redeemed;
  const auth = plain(input.auth) ? input.auth : fail('auth-shape', 'פרטי החשבון חסרים.');
  const request = plain(redeemed.request) ? redeemed.request : fail('redemption-shape', 'תוכנית המימוש חסרה בקשה.');

  const uid = typeof auth.uid === 'string' ? auth.uid.trim() : '';
  if (!UID_RE.test(uid)) fail('uid', 'מזהה החשבון אינו תקין.');
  if (auth.email_verified !== true) fail('email-unverified', 'נדרש חשבון עם אימייל מאומת.');
  if (redeemed.redeemed_by !== uid) fail('redeemer-mismatch', 'המימוש נרשם על חשבון אחר.');

  const requestId = typeof input.request_id === 'string' ? input.request_id.trim() : '';
  if (!REQUEST_ID_RE.test(requestId)) fail('request-id', 'מזהה הפעולה אינו תקין.');

  const stationId = typeof request.stationId === 'string' ? request.stationId.trim() : '';
  const districtId = typeof request.districtId === 'string' ? request.districtId.trim() : '';
  if (!ID_RE.test(stationId)) fail('station-id', 'מזהה התחנה אינו תקין.');
  if (!ID_RE.test(districtId)) fail('district-id', 'מזהה המחוז אינו תקין.');

  const role = typeof request.role === 'string' ? request.role.trim() : '';
  if (!ROLE_RE.test(role)) fail('role', 'התפקיד בהזמנה אינו תקין.');
  const shift = typeof request.shift === 'string' ? request.shift.trim() : '';

  /* The station on the invitation document is the authority. A redemption
   * plan that names a different station than the invitation it came from is a
   * tampered plan, and the fingerprint alone would not catch a mismatch that
   * predates the plan. */
  if (typeof invite.station_id === 'string' && invite.station_id.trim() !== stationId) {
    fail('invite-station-mismatch', 'תחנת ההזמנה אינה תואמת לתחנה שבתוכנית.');
  }

  /* Built from a closed allow-list. There is no path by which an unlisted key
   * reaches this object, because nothing is copied wholesale. */
  const registrationRequest = Object.freeze({
    request_id: requestId,
    full_name: text(request.full_name, 160, 'full-name', 'שם מלא'),
    email: text(request.email, 254, 'email', 'אימייל'),
    phone: typeof request.phone === 'string' && request.phone.trim()
      ? text(request.phone, 40, 'phone', 'טלפון') : '',
    districtId: districtId,
    stationId: stationId,
    shift: shift,
    status: 'pending'
  });

  /* The ruling, asserted rather than assumed: role never reaches the document
   * the client writes. */
  for (const field of REQUEST_FORBIDDEN) {
    if (has(registrationRequest, field)) {
      fail('assignment-leak', 'שדה שיוך הגיע למסמך שהלקוח כותב: ' + field);
    }
  }
  for (const key of Object.keys(registrationRequest)) {
    if (!REGISTRATION_ALLOWED.includes(key)) {
      fail('registration-key', 'מפתח שאינו מותר בבקשת ההרשמה: ' + key);
    }
  }
  assertNoSecret(registrationRequest, 'בקשת ההרשמה');

  /* The protected link. Server-side only. This is what the approval path reads
   * to derive the assignment, so a browser cannot substitute a role or a
   * station. */
  let personBinding = {};
  if (has(invite, 'person_id')) {
    if (typeof invite.person_id !== 'string' || !/^sp_[a-z0-9][a-z0-9_-]{7,63}$/.test(invite.person_id)) {
      fail('person-id', 'מזהה האדם בהזמנה אינו תקין.');
    }
    personBinding = { person_id: invite.person_id };
  }
  const assignmentRef = Object.freeze({
    ...personBinding,
    schema_version: SCHEMA_VERSION,
    invite_id: redeemed.invite_id,
    invite_fingerprint: redeemed.invite_fingerprint,
    uid: uid,
    station_id: stationId,
    district_id: districtId,
    role: role,
    shift: shift,
    registration_request_id: requestId,
    registration_fingerprint: digest(registrationRequest)
  });
  assertNoSecret(assignmentRef, 'הקישור המוגן');

  /* Self-check on the freshly built pair. The real work of this guard happens
   * in the service, which reads a STORED request back and calls the exported
   * assertRequestMatchesLink on it - that is where the two can actually
   * diverge. */
  assertRequestMatchesLink(registrationRequest, assignmentRef);

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    uid: uid,
    station_id: stationId,
    registration_request: registrationRequest,
    registration_server_supplied: REGISTRATION_SERVER_SUPPLIED,
    assignment_ref: assignmentRef,
    operation_fingerprint: digest({
      v: SCHEMA_VERSION, request_id: requestId, uid: uid,
      invite_id: redeemed.invite_id, registration: registrationRequest,
      assignment: assignmentRef
    })
  });
}

/* The permitted copies of station, district and shift on a registration
 * request are a convenience for the Firestore rules, never a second source of
 * truth. Before the approval path may act on a STORED request, it must agree
 * with the protected link - otherwise a request edited between redemption and
 * approval would silently decide the assignment. */
function assertRequestMatchesLink(storedRequest, assignmentRef) {
  if (!plain(storedRequest) || !plain(assignmentRef)) {
    fail('existing-shape', 'בקשת ההרשמה או הקישור המוגן אינם קריאים.');
  }
  if (has(storedRequest, 'role')) {
    fail('assignment-leak', 'בקשת הרשמה שמורה נושאת role.');
  }
  if (storedRequest.stationId !== assignmentRef.station_id
      || storedRequest.districtId !== assignmentRef.district_id
      || storedRequest.shift !== assignmentRef.shift) {
    fail('assignment-divergence', 'בקשת ההרשמה אינה תואמת לקישור המוגן.');
  }
  const original = {};
  for (const key of REGISTRATION_ALLOWED) {
    if (key !== 'created_at') original[key] = key === 'status' ? 'pending' : storedRequest[key];
  }
  if (digest(original) !== assignmentRef.registration_fingerprint) {
    fail('registration-divergence', 'תוכן הבקשה אינו תואם למימוש המקורי.');
  }
  return true;
}

/* An existing registration request owned by a DIFFERENT operation must never
 * be overwritten. Same operation, same fingerprint: this is our own retry. */
function mayWriteRegistration(existing, plan) {
  if (existing === null || existing === undefined) return Object.freeze({ allowed: true, reason: 'absent' });
  if (!plain(existing)) fail('existing-shape', 'בקשת ההרשמה הקיימת אינה קריאה.');
  if (existing.request_id !== plan.registration_request.request_id) {
    return Object.freeze({ allowed: false, reason: 'foreign-operation' });
  }
  if (digest(Object.assign({}, plan.registration_request)) !== plan.assignment_ref.registration_fingerprint) {
    fail('plan-inconsistent', 'התוכנית אינה עקבית עם טביעת האצבע שלה.');
  }
  assertRequestMatchesLink(existing, plan.assignment_ref);
  if (existing.status !== 'pending') return Object.freeze({ allowed: false, reason: 'request-progressed' });
  return Object.freeze({ allowed: true, reason: 'same-operation' });
}

/* Resume. The three stages are distinct and the second is NEVER inferred from
 * the first: a registration request existing says nothing about whether a
 * super-admin approved it. If the approval state is unknown, this refuses
 * rather than assuming - assuming is how a redemption silently becomes an
 * approval. */
function nextOnboardingStep(state) {
  if (!plain(state)) fail('state-shape', 'מצב הקליטה אינו תקין.');
  if (state.request_created !== true && state.request_created !== false) {
    fail('stage-unknown', 'מצב יצירת הבקשה אינו ידוע.');
  }
  if (!state.request_created) {
    return Object.freeze({ step: 'create_request', stage: null, blocked: false });
  }
  if (state.assignment_completed !== true && state.assignment_completed !== false) {
    fail('assignment-state-unknown',
      'מצב אישור ההרשמה חייב להגיע מהמנגנון שמחזיק אותו. קיום בקשה אינו אישור.');
  }
  if (!state.assignment_completed) {
    return Object.freeze({ step: 'await_approval', stage: 'request_created', blocked: true });
  }
  if (state.person_required === true) {
    if (state.person_linked !== true && state.person_linked !== false) {
      fail('link-state-unknown', 'מצב קישור האדם אינו ידוע.');
    }
    if (!state.person_linked) {
      return Object.freeze({ step: 'link_person', stage: 'assignment_completed', blocked: false });
    }
    return Object.freeze({ step: 'complete', stage: 'person_linked', blocked: false });
  }
  return Object.freeze({ step: 'complete', stage: 'assignment_completed', blocked: false });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  OnboardingContractError,
  REGISTRATION_ALLOWED,
  REGISTRATION_SERVER_SUPPLIED,
  REQUEST_FORBIDDEN,
  ASSIGNMENT_AUTHORITY,
  ONBOARDING_STAGES,
  assertNoSecret,
  assertTrustedRedemption,
  assertRequestMatchesLink,
  splitRedemption,
  mayWriteRegistration,
  nextOnboardingStep
});
