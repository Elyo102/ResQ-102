'use strict';

// 41B intentionally keeps the deployed function name while removing every
// provisioning side effect. The full onboarding flow is rebuilt in 42.
function createHandler(deps) {
  const requireSuperAdmin = deps && deps.requireSuperAdmin;
  const HttpsError = deps && deps.HttpsError;

  if (typeof requireSuperAdmin !== 'function' ||
      typeof HttpsError !== 'function') {
    throw new TypeError('bulk import disabled handler dependencies are missing');
  }

  return async function disabledBulkImport(req) {
    requireSuperAdmin(req);
    throw new HttpsError(
      'failed-precondition',
      'קליטת סגל מרוכזת אינה זמינה. השתמש בתהליך ההרשמה המאושר.'
    );
  };
}

module.exports = { createHandler };
