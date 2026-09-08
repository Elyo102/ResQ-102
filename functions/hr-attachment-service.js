'use strict';

// Transport-independent assembly. No SDK initialization, bucket selection or
// cleanup endpoint. Parent services remain the authority for private records.
const { createHrAttachments } = require('./hr-attachments');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function createHrAttachmentService({ db, auth, storage, HttpsError, requests, documents, clock, hooks } = {}) {
  if (!db || !auth || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function') {
    throw new TypeError('db, auth and HttpsError required');
  }
  const families = { request: requests?.attachmentPorts, document: documents?.attachmentPorts };
  for (const ports of Object.values(families)) {
    for (const method of ['read', 'prepare', 'recheck', 'commit']) {
      if (typeof ports?.[method] !== 'function') throw new TypeError('Actual parent attachment ports required');
    }
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  const handles = new WeakMap();
  function family(input) {
    if (input?.parent_kind !== 'request' && input?.parent_kind !== 'document') {
      throw error('invalid-argument', 'Invalid attachment parent.');
    }
    return families[input.parent_kind];
  }
  function held(plan) {
    const ports = plan && typeof plan === 'object' ? handles.get(plan) : null;
    if (!ports) throw error('failed-precondition', 'Invalid attachment plan.');
    return ports;
  }
  const ports = Object.freeze({
    read(tx, input) { return family(input).read(tx, input); },
    async prepare(tx, input) {
      const selected = family(input);
      const plan = await selected.prepare(tx, input);
      if (!plan || typeof plan !== 'object' || !Object.isFrozen(plan)) {
        throw error('failed-precondition', 'Invalid attachment plan.');
      }
      const prior = handles.get(plan);
      if (prior && prior !== selected) throw error('failed-precondition', 'Ambiguous attachment plan.');
      handles.set(plan, selected);
      return plan;
    },
    recheck(tx, plan) { return held(plan).recheck(tx, plan); },
    commit(tx, plan, options) { return held(plan).commit(tx, plan, options); }
  });
  const session = Object.freeze({
    context: identity.context,
    async assertLive(tx, ctx, authTime) {
      if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) {
        throw error('unauthenticated', 'Refresh your sign-in.');
      }
      let record;
      try { record = await auth.getUser(ctx.uid); }
      catch (cause) {
        if (cause?.code === 'auth/user-not-found') throw error('permission-denied', 'The current account is unavailable.');
        throw error('unavailable', 'Current authentication could not be verified.');
      }
      const claims = record?.customClaims;
      if (!record || record.uid !== ctx.uid || record.disabled === true || !plain(claims)
          || claims.stationId !== ctx.sid || (claims.super === true) !== ctx.super
          || (!ctx.super && claims.role !== ctx.role)) {
        throw error('permission-denied', 'Your role or station changed. Refresh your sign-in.');
      }
      if (record.tokensValidAfterTime !== undefined) {
        const validAfter = typeof record.tokensValidAfterTime === 'string' ? Date.parse(record.tokensValidAfterTime) : NaN;
        if (!Number.isFinite(validAfter)) throw error('unavailable', 'Authentication validity is unavailable.');
        if (authTime * 1000 < validAfter) throw error('permission-denied', 'Your sign-in was revoked.');
      }
      return identity.requireLive(tx, ctx);
    }
  });
  const service = createHrAttachments({ db, storage, HttpsError, session, ports, clock, hooks });
  return Object.freeze({ reserve: service.reserve, upload: service.upload, resume: service.resume,
    list: service.list, download: service.download });
}

module.exports = Object.freeze({ createHrAttachmentService });
