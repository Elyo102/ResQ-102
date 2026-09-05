'use strict';

// Anonymous technical categories only. No error messages, stacks, URLs,
// arbitrary notes or identity enter incident documents. Feedback is separate.
const contract = require('./ops-telemetry-contract');
const { createOpsMemberIdentity, ACTOR_ROLES } = require('./ops-member-identity');
const access = require('./schedule-access');
const { KINDS, STATUSES, finite } = contract;
const LIMITS = Object.freeze({ screensPerIncident: 12, versionsPerIncident: 12, rolesPerIncident: 12, list: 500 });
// Incident records are retained until explicit manual deletion after treatment.
const DAY_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const DAY_CAP = 500;
const FINGERPRINT_RE = /^[a-f0-9]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const iso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : 0;
function boundedValues(old, value, allowed, cap) {
  return [...new Set([...(Array.isArray(old) ? old : []), value])]
    .filter((item) => allowed.includes(item)).slice(-cap);
}

// Also protects the admin export from pre-existing/untrusted stored fields.
function safeIncident(id, data) {
  if (!FINGERPRINT_RE.test(id)) return null;
  return {
    id, fingerprint: id, schema_version: 2,
    kind: finite(data.kind, KINDS), code: finite(data.code, contract.CODES),
    callable: finite(data.callable, contract.CALLABLES),
    status: STATUSES.includes(data.status) ? data.status : 'open',
    count: count(data.count), first_seen_iso: iso(data.first_seen_iso), last_seen_iso: iso(data.last_seen_iso),
    first_screen: finite(data.first_screen, contract.SCREENS),
    first_version: finite(data.first_version, contract.VERSIONS),
    last_version: finite(data.last_version, contract.VERSIONS),
    screens: boundedValues(data.screens, null, contract.SCREENS, LIMITS.screensPerIncident),
    versions: boundedValues(data.versions, null, contract.VERSIONS, LIMITS.versionsPerIncident),
    roles: boundedValues(data.roles, null, ACTOR_ROLES, LIMITS.rolesPerIncident),
    resolved_at: iso(data.resolved_at),
    resolved_by: contract.OPERATOR_LABELS.includes(data.resolved_by) ? data.resolved_by : null,
    note_code: contract.NOTE_CODES.includes(data.note_code) ? data.note_code : 'none'
  };
}

function createIncidentLog(deps) {
  const { db, FieldValue, HttpsError, hash, clock } = deps || {};
  if (!db || typeof db.runTransaction !== 'function' || !FieldValue
      || typeof FieldValue.serverTimestamp !== 'function' || typeof HttpsError !== 'function'
      || typeof hash !== 'function' || typeof clock !== 'function') {
    throw new TypeError('db, FieldValue, HttpsError, hash and clock are required');
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const stationRef = (sid) => db.collection('stations').doc(sid);
  const incidentRef = (sid, fingerprint) => stationRef(sid).collection('incidents').doc(fingerprint);

  function planIncident(sid, role, data) {
    if (!plain(data) || Object.keys(data).some((key) => !contract.INPUT_FIELDS.includes(key))) {
      throw new HttpsError('invalid-argument', 'הדיווח מקבל קטגוריות טכניות בלבד.');
    }
    if (!KINDS.includes(data.kind)) throw new HttpsError('invalid-argument', 'סוג הדיווח אינו מוכר.');
    const categories = contract.normalizeTelemetry(data);
    const fingerprint = String(hash(JSON.stringify([
      'incident-v2', sid, categories.kind, categories.screen, categories.code, categories.callable
    ]))).slice(0, 40);
    if (!FINGERPRINT_RE.test(fingerprint)) throw new HttpsError('internal', 'טביעת האצבע אינה תקינה.');
    return Object.freeze({ ...categories, fingerprint, role: finite(role, ACTOR_ROLES) });
  }

  async function report(req) {
    const ctx = identity.context(req);
    const plan = planIncident(ctx.sid, ctx.role, req.data);
    const nowIso = iso(clock());
    if (!nowIso) throw new HttpsError('internal', 'השעון אינו תקין.');
    const now = Date.parse(nowIso);
    const day = nowIso.slice(0, 10);
    const ref = incidentRef(ctx.sid, plan.fingerprint);
    const dayRef = stationRef(ctx.sid).collection('incident_days').doc(day);
    return db.runTransaction(async (tx) => {
      const actor = await identity.requireLive(tx, ctx);
      const [daySnap, snap] = await Promise.all([tx.get(dayRef), tx.get(ref)]);
      const dayCount = daySnap.exists ? (daySnap.data() || {}).count : 0;
      if (!Number.isSafeInteger(dayCount) || dayCount < 0) throw new HttpsError('failed-precondition', 'מכסת הדיווח אינה תקינה.');
      if (dayCount >= DAY_CAP) return { accepted: false, reason: 'day-cap', fingerprint: plan.fingerprint };
      const old = safeIncident(plan.fingerprint, snap.exists ? (snap.data() || {}) : {});
      if (old.count >= Number.MAX_SAFE_INTEGER) throw new HttpsError('resource-exhausted', 'מכסת הדיווח הושגה.');
      const reopen = old.status === 'resolved' && old.last_version !== plan.version;
      const base = {
        schema_version: 2, station_id: ctx.sid, fingerprint: plan.fingerprint,
        kind: plan.kind, code: plan.code, callable: plan.callable,
        status: reopen ? 'open' : old.status,
        count: old.count + 1,
        first_seen: new Date(old.first_seen_iso || nowIso), first_seen_iso: old.first_seen_iso || nowIso,
        first_screen: snap.exists ? old.first_screen : plan.screen,
        first_version: snap.exists ? old.first_version : plan.version,
        last_seen: FieldValue.serverTimestamp(), last_seen_iso: nowIso, last_version: plan.version,
        screens: boundedValues(old.screens, plan.screen, contract.SCREENS, LIMITS.screensPerIncident),
        versions: boundedValues(old.versions, plan.version, contract.VERSIONS, LIMITS.versionsPerIncident),
        roles: boundedValues(old.roles, actor.role, ACTOR_ROLES, LIMITS.rolesPerIncident),
        resolved_at: reopen ? null : old.resolved_at,
        resolved_by: reopen ? null : old.resolved_by,
        note_code: reopen ? 'none' : old.note_code
      };
      tx.set(dayRef, { day, count: dayCount + 1, expires_at: new Date(now + DAY_TTL_MS) });
      // Replace with the allowlisted record; merging would retain old raw text.
      tx.set(ref, base);
      return { accepted: true, fingerprint: plan.fingerprint, count: base.count, first: !snap.exists };
    });
  }

  // Admin SDK tooling only; deliberately not callable exports.
  async function list(options) {
    const o = plain(options) ? options : {};
    if (!access.validId(o.sid)) throw new TypeError('sid is required');
    const limit = o.limit === undefined ? LIMITS.list : o.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.list) throw new TypeError('invalid limit');
    if (o.status && !STATUSES.includes(o.status)) throw new TypeError('invalid status');
    const snap = await stationRef(o.sid).collection('incidents').orderBy('last_seen_iso', 'desc').limit(limit).get();
    // Filtering is within the bounded newest page, not a claim of total count.
    return snap.docs.map((doc) => safeIncident(doc.id, doc.data() || {}))
      .filter((row) => row && (!o.status || row.status === o.status));
  }

  async function setStatus(options) {
    const o = plain(options) ? options : {};
    if (Object.keys(o).some((k) => !['sid', 'fingerprint', 'status', 'by', 'note_code'].includes(k))
        || !access.validId(o.sid) || !FINGERPRINT_RE.test(o.fingerprint)
        || !STATUSES.includes(o.status) || !contract.OPERATOR_LABELS.includes(o.by)
        || (o.note_code !== undefined && !contract.NOTE_CODES.includes(o.note_code))) {
      throw new TypeError('invalid incident status categories');
    }
    const now = iso(clock());
    if (!now) throw new TypeError('invalid clock');
    const ref = incidentRef(o.sid, o.fingerprint);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('incident-not-found');
      const current = safeIncident(o.fingerprint, snap.data() || {});
      const patch = { ...current, station_id: o.sid, status: o.status,
        resolved_at: o.status === 'open' ? null : now,
        resolved_by: o.status === 'open' ? null : o.by,
        note_code: o.note_code || 'none' };
      delete patch.id;
      // Full replacement also removes an expiry left by an older writer.
      // Resolved and ignored records are retained too: treatment is not deletion.
      tx.set(ref, patch);
      return { fingerprint: o.fingerprint, status: patch.status,
        resolved_at: patch.resolved_at, resolved_by: patch.resolved_by, note_code: patch.note_code };
    });
  }
  async function removeResolved(options) {
    const o = plain(options) ? options : {};
    if (Object.keys(o).some((key) => !['sid', 'fingerprint', 'by', 'expected_count',
      'expected_last_seen_iso', 'expected_resolved_at'].includes(key))
        || !access.validId(o.sid) || typeof o.fingerprint !== 'string'
        || !FINGERPRINT_RE.test(o.fingerprint) || o.by !== 'operator'
        || !Number.isSafeInteger(o.expected_count) || o.expected_count < 1
        || !iso(o.expected_last_seen_iso) || !iso(o.expected_resolved_at)) {
      throw new TypeError('invalid incident deletion');
    }
    return db.runTransaction(async (tx) => {
      const ref = incidentRef(o.sid, o.fingerprint);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('incident-not-found');
      const data = snap.data() || {};
      if (data.station_id !== o.sid || data.fingerprint !== o.fingerprint) {
        throw new Error('incident-identity-mismatch');
      }
      if (data.status !== 'resolved') throw new Error('incident-not-resolved');
      if (data.count !== o.expected_count || data.last_seen_iso !== o.expected_last_seen_iso
          || data.resolved_at !== o.expected_resolved_at) throw new Error('incident-changed');
      tx.delete(ref);
      return { deleted: true, fingerprint: o.fingerprint };
    });
  }
  return Object.freeze({ report, list, setStatus, removeResolved, planIncident });
}

module.exports = Object.freeze({ createIncidentLog, safeIncident, KINDS, STATUSES, LIMITS, DAY_CAP, DAY_TTL_MS });
