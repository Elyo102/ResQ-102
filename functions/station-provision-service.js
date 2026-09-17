'use strict';

/*
 * station-provision-service.js
 *
 * Writes what station-provision-contract.js planned, once, in one transaction.
 *
 * EVERY DEPENDENCY IS INJECTED AND DOCUMENTED.  Nothing here reaches for a
 * global db, a global clock or a global auth.  No mechanism is copied: the
 * plan comes from the contract module, the caller's authority comes from the
 * injected requireSuperAdmin, and the timestamp comes from the injected
 * serverTimestamp.  That is what makes this file testable without Firebase and
 * reviewable without reading Firebase.
 *
 * WHAT THIS FILE STILL DOES NOT DO:
 *   It does not silence anything.  It writes silent:true onto the station
 *   document.  Whether any sending path honours that flag is decided
 *   elsewhere, and until that wiring exists a provisioned station is NOT
 *   protected from notifications.
 *   It does not make a station usable.  A provisioned station is
 *   status:'provisioning'.  markStationReady is the only path to 'ready' and
 *   it refuses while any readiness check is unmet.
 */

const OPERATION_SCHEMA = 1;

function createStationProvisionService(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};
  for (const name of ['db', 'contract', 'serverTimestamp', 'fail', 'requireSuperAdmin', 'verifyReadiness']) {
    if (!d[name] || (['db', 'contract'].includes(name)
      ? typeof d[name] !== 'object' : typeof d[name] !== 'function')) {
      throw new TypeError('station provision dependency is required: ' + name);
    }
  }
  const { db, contract, serverTimestamp, fail, requireSuperAdmin, verifyReadiness } = d;

  // Async validator must read current Auth (disabled/super) and current profile.
  // Recheck after all transaction reads, before writes AND successful replays.
  async function fresh(req, uid) {
    const actor = await requireSuperAdmin(req);
    if (!actor || typeof actor.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.uid)
      || (uid && actor.uid !== uid)) fail('permission-denied', 'זהות המבצע השתנתה.', 'actor-changed');
    return actor;
  }

  const stationRef = (sid) => db.doc('stations/' + sid);
  const operationRef = (sid, requestId) =>
    db.doc('stations/' + sid + '/provision_operations/' + requestId);
  const seedRef = (sid, path) => db.doc('stations/' + sid + '/' + path);
  const readinessRef = (sid) => db.doc('stations/' + sid + '/provision_readiness/current');

  const dataOf = (snap) => (snap && snap.exists ? (snap.data() || null) : null);

  function plain(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /* The caller supplies the description of the station. It never supplies the
   * actor, the status or the silence: actor_uid is taken from the verified
   * token, and status/silent are not input keys at all - the contract's shape
   * check rejects them before anything is written. */
  function planFrom(auth, data) {
    const input = plain(data) ? data : {};
    const allowed = ['request_id', 'station_id', 'district_id', 'display_name', 'timezone', 'template_id'];
    if (Object.keys(input).some(key => !allowed.includes(key))) {
      fail('invalid-argument', 'קלט הקמת התחנה אינו תואם לחוזה הסגור.', 'input-shape');
    }
    for (const forbidden of ['actor_uid', 'status', 'silent']) {
      if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
        fail('invalid-argument', 'השדה ' + forbidden + ' נקבע בשרת ואינו מתקבל מהקורא.');
      }
    }
    try {
      return contract.planStationProvision({
        request_id: input.request_id,
        station_id: input.station_id,
        district_id: input.district_id,
        display_name: input.display_name,
        timezone: input.timezone,
        template_id: input.template_id,
        actor_uid: auth.uid
      });
    } catch (error) {
      if (error && error.name === 'StationProvisionError') {
        fail('invalid-argument', error.message, error.code);
      }
      throw error;
    }
  }

  function storedResult(operation) {
    return Object.freeze({
      ok: true,
      replayed: true,
      station_id: operation.station_id,
      request_id: operation.request_id,
      status: operation.result_status,
      fingerprint: operation.fingerprint
    });
  }

  async function provisionStation(req) {
    const auth = await fresh(req);
    const plan = planFrom(auth, req && req.data);
    const sid = plan.station_id;

    return db.runTransaction(async (tx) => {
      const [stationSnap, operationSnap] = await Promise.all([
        tx.get(stationRef(sid)),
        tx.get(operationRef(sid, plan.request_id))
      ]);

      /* Retry. The operation record is the authority, not the station
       * document: a station may exist because someone else created it, and
       * that must not be mistaken for our own completed attempt. */
      const operation = dataOf(operationSnap);
      if (operation) {
        if (operation.fingerprint !== plan.fingerprint) {
          fail('failed-precondition',
            'אותו מזהה בקשה כבר שימש לכוונה אחרת. יש להנפיק מזהה חדש.',
            'provision-intent-changed');
        }
        if (!stationSnap.exists || operation.station_id !== sid || operation.request_id !== plan.request_id
          || operation.actor_uid !== auth.uid) fail('failed-precondition', 'רשומת ההקמה אינה תקינה.', 'provision-operation-invalid');
        await fresh(req, auth.uid);
        return storedResult(operation);
      }

      if (stationSnap && stationSnap.exists) {
        fail('already-exists', 'התחנה כבר קיימת.', 'station-exists');
      }

      // Firestore can retain children after a parent is removed. Never
      // overwrite orphaned configuration or evidence under a reused ID.
      const preserved = await Promise.all([
        ...plan.seeds.map(seed => tx.get(seedRef(sid, seed.path))),
        tx.get(readinessRef(sid))
      ]);
      if (preserved.some(snap => snap && snap.exists)) {
        fail('already-exists', 'קיימים נתוני תחנה ללא מסמך אב; נדרשת בדיקה.', 'station-seed-exists');
      }
      await fresh(req, auth.uid);
      tx.set(stationRef(sid), Object.assign({}, plan.station_doc, {
        created_at: serverTimestamp()
      }));

      for (const seed of plan.seeds) {
        tx.set(seedRef(sid, seed.path), Object.assign({}, seed.value, {
          seeded_at: serverTimestamp(),
          seeded_by_request: plan.request_id
        }));
      }

      /* Readiness starts empty. This document is evidence output, never
       * authority: markStationReady recomputes actual readiness through its
       * injected server verifier. */
      tx.set(readinessRef(sid), {
        schema_version: OPERATION_SCHEMA,
        station_id: sid,
        checks: {},
        updated_at: serverTimestamp()
      });

      tx.set(operationRef(sid, plan.request_id), {
        schema_version: OPERATION_SCHEMA,
        station_id: sid,
        request_id: plan.request_id,
        fingerprint: plan.fingerprint,
        actor_uid: auth.uid,
        result_status: plan.station_doc.status,
        first_admin_invitation_intent: plan.first_admin_invitation_intent,
        created_at: serverTimestamp()
      });

      return Object.freeze({
        ok: true,
        replayed: false,
        station_id: sid,
        request_id: plan.request_id,
        status: plan.station_doc.status,
        fingerprint: plan.fingerprint,
        first_admin_invitation_intent: plan.first_admin_invitation_intent
      });
    });
  }

  /* The only path from 'provisioning' to 'ready'. It asks the injected server
   * evidence verifier and refuses while any check is unmet, naming it so the caller
   * is told what is missing rather than that "it failed". */
  async function markStationReady(req) {
    const auth = await fresh(req);
    const input = plain(req && req.data) ? req.data : {};
    const sid = typeof input.station_id === 'string' ? input.station_id.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(sid)) fail('invalid-argument', 'מזהה התחנה אינו תקין.', 'station-id');
    if (Object.prototype.hasOwnProperty.call(input, 'checks')) {
      fail('invalid-argument', 'מצב המוכנות נקרא מהשרת ואינו מתקבל מהקורא.', 'checks-from-client');
    }
    if (Object.keys(input).some(key => key !== 'station_id')) fail('invalid-argument', 'קלט לא מוכר.', 'input-shape');

    return db.runTransaction(async (tx) => {
      const stationSnap = await tx.get(stationRef(sid));
      const station = dataOf(stationSnap);
      if (!station) fail('not-found', 'התחנה אינה קיימת.', 'station-missing');
      if (station.status !== 'provisioning' && station.status !== 'ready') {
        fail('failed-precondition', 'מצב התחנה אינו מאפשר הכרזת מוכנות.', 'station-status');
      }

      // Root adapter owns evidence collection: transaction-read actual seeds,
      // first-admin identity, backup/health registration and sender wiring.
      // It MUST NOT return client input or stored readiness booleans as proof.
      // For replay station_document means a valid provisioning OR ready station.
      const checks = await verifyReadiness({ tx, station_id: sid, station, actor_uid: auth.uid });
      const verdict = contract.evaluateReadiness(checks);
      if (!verdict.ready) {
        fail('failed-precondition',
          'התחנה אינה מוכנה. חסר: ' + verdict.unmet.join(', '),
          'station-not-ready');
      }

      await fresh(req, auth.uid);
      if (station.status === 'ready') {
        if (station.active !== true) fail('failed-precondition', 'תחנה מוכנה אינה פעילה.', 'station-state-invalid');
        return Object.freeze({ ok: true, station_id: sid, status: 'ready', replayed: true, unmet: Object.freeze([]) });
      }
      tx.set(readinessRef(sid), { schema_version: OPERATION_SCHEMA, station_id: sid,
        checks: Object.fromEntries(contract.READINESS_CHECKS.map(key => [key, checks[key] === true])),
        updated_at: serverTimestamp() });
      tx.set(stationRef(sid), {
        status: 'ready',
        active: true,
        ready_at: serverTimestamp(),
        ready_by: auth.uid
      }, { merge: true });

      return Object.freeze({
        ok: true, station_id: sid, status: 'ready', replayed: false, unmet: Object.freeze([])
      });
    });
  }

  return Object.freeze({ provisionStation, markStationReady });
}

module.exports = Object.freeze({ OPERATION_SCHEMA, createStationProvisionService });
