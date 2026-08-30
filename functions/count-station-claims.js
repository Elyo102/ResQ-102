'use strict';

const registrationSafety = require('./registration-safety');

const STATION_ID_PATTERN = /^[a-z0-9_-]{2,80}$/;

function claimsOf(user) {
  const direct = user && user.customClaims;
  if (direct !== undefined) {
    if (!direct || typeof direct !== 'object' || Array.isArray(direct)) {
      return { claims:{}, invalidJson:true };
    }
    return { claims:direct, invalidJson:false };
  }
  const raw = String((user && user.customAttributes) || '').trim();
  if (!raw) return { claims:{}, invalidJson:false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { claims:{}, invalidJson:true };
    }
    return { claims:parsed, invalidJson:false };
  } catch (_) {
    return { claims:{}, invalidJson:true };
  }
}

function summarizeUsers(usersValue) {
  const users = Array.isArray(usersValue) ? usersValue : [];
  const totals = {
    total_accounts: 0,
    disabled_accounts: 0,
    approved_accounts: 0,
    pending_accounts: 0,
    assigned_accounts: 0,
    unassigned_accounts: 0,
    super_accounts: 0,
    super_missing_station_claim: 0,
    valid_station_claim: 0,
    invalid_station_claim: 0,
    approved_missing_station_claim: 0,
    approved_invalid_station_claim: 0,
    assigned_missing_station_claim: 0,
    assigned_invalid_station_claim: 0,
    pending_with_station_claim: 0,
    invalid_custom_claims_json: 0,
    release_gate_42b: 'PASS'
  };

  for (const user of users) {
    totals.total_accounts++;
    if (user && user.disabled === true) totals.disabled_accounts++;

    const parsed = claimsOf(user);
    const claims = parsed.claims;
    if (parsed.invalidJson) totals.invalid_custom_claims_json++;

    const role = typeof claims.role === 'string' ? claims.role.trim() : '';
    const isSuper = claims.super === true;
    const approved = isSuper || role !== '';
    const assigned = registrationSafety.hasIdentityAssignment(claims);
    if (approved) totals.approved_accounts++;
    else totals.pending_accounts++;
    if (assigned) totals.assigned_accounts++;
    else totals.unassigned_accounts++;
    if (isSuper) totals.super_accounts++;

    const stationIsString = typeof claims.stationId === 'string';
    const stationId = stationIsString ? claims.stationId : '';
    const hasStation = stationIsString && stationId.length > 0;
    const validStation = stationIsString && STATION_ID_PATTERN.test(stationId);

    if (validStation) totals.valid_station_claim++;
    else if (hasStation) totals.invalid_station_claim++;

    if (approved && !hasStation) totals.approved_missing_station_claim++;
    if (approved && hasStation && !validStation) {
      totals.approved_invalid_station_claim++;
    }
    if (assigned && !hasStation) totals.assigned_missing_station_claim++;
    if (assigned && hasStation && !validStation) {
      totals.assigned_invalid_station_claim++;
    }
    if (isSuper && !hasStation) totals.super_missing_station_claim++;
    if (!approved && hasStation) totals.pending_with_station_claim++;
  }

  if (totals.assigned_missing_station_claim !== 0 ||
      totals.assigned_invalid_station_claim !== 0 ||
      totals.invalid_custom_claims_json !== 0) {
    totals.release_gate_42b = 'BLOCK';
  }
  return totals;
}

// Makes invisible or ambiguous characters visible without exposing any other
// account field. Space is U+20 and must be escaped too: using < instead of <=
// here would make "station " look identical to "station" in an audit.
function reveal(value) {
  let output = '';
  for (const character of String(value === undefined ? '' : value)) {
    const code = character.codePointAt(0);
    const safe = code > 0x20 && code < 0x7f && code !== 0x5c;
    output += safe ? character : '\\u{' + code.toString(16).toUpperCase() + '}';
  }
  return output;
}

module.exports = {
  STATION_ID_PATTERN,
  claimsOf,
  summarizeUsers,
  reveal
};
