'use strict';

const crypto = require('crypto');

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function revisionOf(value) {
  const revision = Number(value && value.mode_revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function modeOf(value) {
  return value && value.silent === true ? 'trial' : 'live';
}

function intentFingerprint(actor, input) {
  return crypto.createHash('sha256').update(JSON.stringify({
    actor_uid: actor.uid,
    silent: input.silent,
    expected_revision: input.expected_revision
  })).digest('hex');
}

function createRuntimeModeService(deps) {
  const db = deps.db;
  const timestamp = deps.serverTimestamp;
  const fail = deps.fail;
  const freshActor = deps.freshActor;
  if (!db || typeof db.runTransaction !== 'function' || typeof freshActor !== 'function'
      || typeof timestamp !== 'function' || typeof fail !== 'function') {
    throw new Error('runtime-mode-dependencies');
  }

  async function read() {
    const snap = await db.doc('config/runtime').get();
    if (!snap.exists) fail('failed-precondition', 'מצב המערכת אינו זמין כרגע.');
    const value = snap.data() || {};
    if (typeof value.silent !== 'boolean') fail('failed-precondition', 'מצב המערכת אינו תקין.');
    return Object.freeze({
      silent: value.silent,
      mode: modeOf(value),
      revision: revisionOf(value),
      allow: Array.isArray(value.silent_allow) ? value.silent_allow.slice() : []
    });
  }

  async function set(req) {
    const input = req && req.data;
    if (!exact(input, ['silent', 'expected_revision', 'request_id'])
        || typeof input.silent !== 'boolean'
        || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0
        || typeof input.request_id !== 'string'
        || !/^[A-Za-z0-9_-]{16,100}$/.test(input.request_id)) {
      fail('invalid-argument', 'בקשת שינוי מצב המערכת אינה תקינה.');
    }

    // The actor is re-read from Auth for every attempt, including a replay.
    // A revoked or disabled super must not receive a stored success receipt.
    const actor = await freshActor(req);
    const fingerprint = intentFingerprint(actor, input);
    const allow = input.silent ? [actor.uid, actor.email].filter(Boolean) : [];

    return db.runTransaction(async tx => {
      const runtimeRef = db.doc('config/runtime');
      const publicRef = db.doc('config/mode');
      const runtimeSnap = await tx.get(runtimeRef);
      if (!runtimeSnap.exists) fail('failed-precondition', 'מצב המערכת אינו זמין כרגע.');
      const before = runtimeSnap.data() || {};
      if (typeof before.silent !== 'boolean') fail('failed-precondition', 'מצב המערכת אינו תקין.');
      const revision = revisionOf(before);
      const previous = plain(before.last_mode_request) ? before.last_mode_request : null;

      if (previous && previous.request_id === input.request_id) {
        if (previous.intent_fingerprint !== fingerprint) {
          fail('already-exists', 'מזהה הפעולה כבר שימש לשינוי אחר.');
        }
        return Object.freeze({
          ok: true,
          silent: before.silent,
          mode: modeOf(before),
          revision,
          allow: Array.isArray(before.silent_allow) ? before.silent_allow.slice() : [],
          duplicate: true,
          changed: previous.changed === true
        });
      }

      if (revision !== input.expected_revision) {
        fail('aborted', 'מצב המערכת השתנה. יש לרענן ולנסות שוב.', {
          current_revision: revision,
          current_mode: modeOf(before)
        });
      }

      const changed = before.silent !== input.silent;
      const nextRevision = changed ? revision + 1 : revision;
      const receipt = {
        request_id: input.request_id,
        intent_fingerprint: fingerprint,
        changed,
        actor_uid: actor.uid,
        at: timestamp()
      };
      const runtimePatch = {
        silent: input.silent,
        silent_allow: allow,
        mode_revision: nextRevision,
        updated_by: actor.uid,
        updated_at: timestamp(),
        last_mode_request: receipt
      };
      const publicPatch = {
        mode: input.silent ? 'trial' : 'live',
        revision: nextRevision,
        since: timestamp()
      };

      // Both documents are committed by the same Firestore transaction. It is
      // impossible for delivery to become live while the public chip remains
      // in training mode (or the inverse).
      tx.set(runtimeRef, runtimePatch, { merge: true });
      tx.set(publicRef, publicPatch, { merge: true });
      return Object.freeze({
        ok: true,
        silent: input.silent,
        mode: publicPatch.mode,
        revision: nextRevision,
        allow: allow.slice(),
        duplicate: false,
        changed
      });
    });
  }

  return Object.freeze({ read, set });
}

module.exports = Object.freeze({
  createRuntimeModeService,
  revisionOf,
  modeOf,
  intentFingerprint
});
