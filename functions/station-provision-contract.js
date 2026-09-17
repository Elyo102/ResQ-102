'use strict';

/*
 * station-provision-contract.js
 *
 * Pure planning contract for provisioning a new station from a fixed template.
 * No Firebase, no db handle, no clock, no randomness.  The only dependency is
 * node:crypto for the intent digest.
 *
 * WHAT THIS MODULE DOES NOT DO, stated here so nobody reads it as protection:
 *
 *   It does not silence anything.  It produces a station-scoped `silent` flag
 *   and effectiveStationSilence().  Connecting that flag to the sending paths
 *   is a separate, server-side job.  Until that wiring exists, a station whose
 *   document says silent:true still receives notifications.
 *
 *   It does not create a station.  It returns a plan.  Writing it, and the
 *   idempotency that goes with it, belong to the service.
 *
 * No staff, message or personal data of any station can reach the output:
 * the function receives no db handle and no collection, so it has no path to
 * another station's data at all.  That is structural, not a promise.
 */

const crypto = require('node:crypto');

class StationProvisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StationProvisionError';
    this.code = code;
  }
}

const SCHEMA_VERSION = 1;
const STATION_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const DISTRICT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+){1,2}$/;
const UNSAFE_TEXT = /[\u0000--؜​-‏‪-‮⁦-⁩﻿]/u;

const INPUT_KEYS = Object.freeze([
  'request_id', 'station_id', 'district_id', 'display_name', 'timezone',
  'template_id', 'actor_uid'
]);

/* The template is a frozen constant in code.  It is selected by id and never
 * supplied by a caller, so a browser cannot smuggle a policy in.
 *
 * schedule_policy is EMPTY ON PURPOSE - a new station has no agreed policy yet
 * and must not pretend to.  Every key is nonetheless DECLARED, because the
 * calendar engine rejects a policy whose max_shifts_per_month key is absent
 * ('policy-limit-missing') while accepting an explicit null.  An empty policy
 * must not become a new import blocker; declaring the keys is what keeps it
 * from becoming one. */
const TEMPLATES = Object.freeze({
  'fire-station-v1': Object.freeze({
    template_id: 'fire-station-v1',
    hr_config: Object.freeze({
      schema_version: 1,
      hour_limit: null,          // null = inherit the platform default, never a copy
      email: null,
      name: null
    }),
    schedule_policy: Object.freeze({
      schema_version: 1,
      sub_stations: Object.freeze({}),
      rest: Object.freeze({ min_gap_days: null }),
      rotation: null,
      max_shifts_per_month: null,
      qualifications: Object.freeze([])
    }),
    first_admin_role: 'commander'
  })
});
const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES).sort());

/* Every condition that must hold before a station may serve traffic.  The
 * provisioning call cannot satisfy any of them by itself - that is the point.
 * A created document is not a ready station. */
const READINESS_CHECKS = Object.freeze([
  'station_document',        // written, and still status 'provisioning'
  'hr_config_seeded',
  'backup_registered',
  'health_inventory_registered',
  'first_admin_active',      // invitation redeemed AND the account carries station claims
  'silence_wired'            // the sending paths honour the station flag - owned by the server side
]);

function fail(code, message) { throw new StationProvisionError(code, message); }
function plain(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function exactKeys(v, keys) {
  return plain(v) && Object.keys(v).sort().join('|') === keys.slice().sort().join('|');
}

function cleanText(value, max, code, label) {
  if (typeof value !== 'string') fail(code, label + ' חסר או אינו מחרוזת.');
  const out = value.normalize('NFC').trim();
  if (!out || out.length > max || UNSAFE_TEXT.test(out)) fail(code, label + ' חסר או אינו בטוח.');
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }

/* Organisation-wide silence wins, always.  A station that declares itself not
 * silent cannot escape it.  Only a real boolean true silences - not 'true',
 * not 1, not a truthy object. */
function effectiveStationSilence(globalSilent, stationSilent) {
  const g = globalSilent === true;
  const s = stationSilent === true;
  return Object.freeze({
    silent: g || s,
    reason: g && s ? 'global+station' : g ? 'global' : s ? 'station' : null
  });
}

function templateFor(templateId) {
  if (typeof templateId !== 'string' || !Object.prototype.hasOwnProperty.call(TEMPLATES, templateId)) {
    fail('template-unknown', 'תבנית התחנה אינה מוכרת.');
  }
  return TEMPLATES[templateId];
}

function planStationProvision(input) {
  if (!exactKeys(input, INPUT_KEYS)) {
    fail('input-shape', 'קלט הקמת התחנה אינו תואם לחוזה הסגור.');
  }

  const requestId = typeof input.request_id === 'string' ? input.request_id.trim() : '';
  if (!REQUEST_ID_RE.test(requestId)) fail('request-id', 'מזהה הבקשה אינו תקין.');

  const stationId = typeof input.station_id === 'string' ? input.station_id.trim() : '';
  if (!STATION_ID_RE.test(stationId)) fail('station-id', 'מזהה התחנה אינו תקין.');

  const districtId = typeof input.district_id === 'string' ? input.district_id.trim() : '';
  if (!DISTRICT_ID_RE.test(districtId)) fail('district-id', 'מזהה המחוז אינו תקין.');

  const actorUid = typeof input.actor_uid === 'string' ? input.actor_uid.trim() : '';
  if (!UID_RE.test(actorUid)) fail('actor-uid', 'מזהה המבצע אינו תקין.');

  const displayName = cleanText(input.display_name, 120, 'display-name', 'שם התחנה');

  const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : '';
  if (!TIMEZONE_RE.test(timezone) || timezone.length > 64) {
    fail('timezone', 'אזור הזמן אינו תקין.');
  }

  const template = templateFor(input.template_id);

  /* status and silent are decided here and are not reachable from the input.
   * A caller cannot provision a station that is already ready, or already
   * un-silenced: those keys are not in INPUT_KEYS at all, so an attempt to
   * pass them fails the shape check above before reaching this line. */
  const stationDoc = Object.freeze({
    schema_version: SCHEMA_VERSION,
    station_id: stationId,
    districtId: districtId,
    display_name: displayName,
    name: displayName,
    active: false,
    timezone: timezone,
    template_id: template.template_id,
    status: 'provisioning',
    silent: true,
    created_by: actorUid,
    provision_request_id: requestId
  });

  const seeds = Object.freeze([
    Object.freeze({ kind: 'hr_config', path: 'config/hr', value: template.hr_config }),
    Object.freeze({ kind: 'schedule_policy', path: 'schedule_policy/current', value: template.schedule_policy }),
    Object.freeze({ kind: 'backup_registration', path: 'backup/registration',
      value: Object.freeze({ schema_version: 1, station_id: stationId, enabled: true }) }),
    Object.freeze({ kind: 'health_inventory', path: 'health/inventory',
      value: Object.freeze({ schema_version: 1, station_id: stationId, included: true }) })
  ]);

  /* An intent, not an invitation.  No secret is generated here and none may
   * ever appear in this output - issuing is invitations.js's job. */
  const firstAdminInvitationIntent = Object.freeze({
    station_id: stationId,
    district_id: districtId,
    role: template.first_admin_role,
    issued_by: actorUid,
    provision_request_id: requestId
  });

  const fingerprint = digest({
    v: SCHEMA_VERSION,
    request_id: requestId,
    station_id: stationId,
    district_id: districtId,
    display_name: displayName,
    timezone: timezone,
    template_id: template.template_id,
    actor_uid: actorUid
  });

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    request_id: requestId,
    station_id: stationId,
    station_doc: stationDoc,
    seeds: seeds,
    first_admin_invitation_intent: firstAdminInvitationIntent,
    readiness_required: READINESS_CHECKS,
    fingerprint: fingerprint
  });
}

/* Two provisioning attempts are the same intent only when their fingerprints
 * match.  A retry with the same request_id but different content is a
 * different intent and must be refused, not silently resolved to either one. */
function sameProvisionIntent(left, right) {
  if (!plain(left) || !plain(right)) return false;
  if (typeof left.fingerprint !== 'string' || typeof right.fingerprint !== 'string') return false;
  if (left.fingerprint.length !== 64 || right.fingerprint.length !== 64) return false;
  return left.request_id === right.request_id && left.fingerprint === right.fingerprint;
}

/* A station is ready only when every check is satisfied.  Anything missing,
 * malformed or merely truthy leaves it unready and is named. */
function evaluateReadiness(state) {
  if (!plain(state)) fail('readiness-shape', 'מצב המוכנות אינו תקין.');
  const unmet = [];
  for (const check of READINESS_CHECKS) {
    if (state[check] !== true) unmet.push(check);
  }
  return Object.freeze({
    ready: unmet.length === 0,
    unmet: Object.freeze(unmet),
    next_status: unmet.length === 0 ? 'ready' : 'provisioning'
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  StationProvisionError,
  TEMPLATE_IDS,
  READINESS_CHECKS,
  templateFor,
  effectiveStationSilence,
  planStationProvision,
  sameProvisionIntent,
  evaluateReadiness
});
