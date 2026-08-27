'use strict';

const IDENTITY_FIELDS = Object.freeze([
  'emp', 'role', 'stationId', 'districtId', 'shift', 'super'
]);

function assignmentFields(claims) {
  const value = claims && typeof claims === 'object' ? claims : {};
  return IDENTITY_FIELDS.filter(function (key) {
    return key === 'super' ? value[key] === true : String(value[key] || '') !== '';
  });
}

function hasIdentityAssignment(claims) {
  return assignmentFields(claims).length > 0;
}

function withinRoleSetterScope(gate, before, desired) {
  const scope = gate && typeof gate === 'object' ? gate : {};
  if (scope.cap === Infinity) return true;

  const sid = String(scope.sid || '');
  const did = String(scope.did || '');
  const previous = before && typeof before === 'object' ? before : {};
  const next = desired && typeof desired === 'object' ? desired : {};
  const previousSid = String(previous.stationId || '');
  const previousDid = String(previous.districtId || '');
  const desiredSid = String(next.stationId || '');
  const desiredDid = String(next.districtId || '');

  // A non-super role setter is always station-scoped. Missing scope claims
  // fail closed, as do moves into another station or district.
  return sid !== '' && did !== '' &&
    (!previousSid || previousSid === sid) &&
    (!previousDid || previousDid === did) &&
    desiredSid === sid && desiredDid === did;
}

function createDisabledJoinHandler(deps) {
  if (!deps || typeof deps.requireAuth !== 'function' || !deps.HttpsError) {
    throw new TypeError('registration safety dependencies are required');
  }

  return async function disabledJoinWithCode(req) {
    deps.requireAuth(req);
    throw new deps.HttpsError(
      'failed-precondition',
      'הצטרפות מיידית עם קוד תחנה אינה זמינה כרגע. ' +
      'בקשת הרשמה שנשלחה תמתין לאישור מנהל המערכת.'
    );
  };
}

module.exports = {
  IDENTITY_FIELDS,
  assignmentFields,
  hasIdentityAssignment,
  withinRoleSetterScope,
  createDisabledJoinHandler
};
