'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const safety = require('./registration-safety');

class TestHttpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function rejectsWith(label, promise, code) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.equal(caught && caught.code, code, label);
  console.log('✓ ' + label);
}

(async function run() {
  assert.equal(safety.hasIdentityAssignment({}), false);
  console.log('✓ empty live claims remain eligible for manual approval');

  for (const [field, value] of [
    ['emp', '17'], ['role', 'firefighter'], ['stationId', 'eilat_102'],
    ['districtId', 'south'], ['shift', 'A'], ['super', true]
  ]) {
    assert.equal(safety.hasIdentityAssignment({ [field]:value }), true,
      field + ' must block stale registration approval');
    console.log('✓ live ' + field + ' blocks stale registration approval');
  }

  const localGate = { cap:3, sid:'eilat_102', did:'south' };
  assert.equal(safety.withinRoleSetterScope(localGate,
    { stationId:'eilat_102', districtId:'south' },
    { stationId:'eilat_102', districtId:'south' }), true);
  assert.equal(safety.withinRoleSetterScope(localGate, {},
    { stationId:'other_99', districtId:'south' }), false);
  assert.equal(safety.withinRoleSetterScope(localGate,
    { stationId:'eilat_102', districtId:'south' },
    { stationId:'other_99', districtId:'south' }), false);
  assert.equal(safety.withinRoleSetterScope(localGate,
    { stationId:'eilat_102', districtId:'south' },
    { stationId:'eilat_102', districtId:'north' }), false);
  assert.equal(safety.withinRoleSetterScope(
    { cap:3, sid:'', did:'south' }, {},
    { stationId:'eilat_102', districtId:'south' }), false);
  assert.equal(safety.withinRoleSetterScope(
    { cap:3, sid:'eilat_102', did:'' }, {},
    { stationId:'eilat_102', districtId:'south' }), false);
  assert.equal(safety.withinRoleSetterScope({ cap:Infinity }, {},
    { stationId:'other_99', districtId:'north' }), true);
  console.log('✓ non-super role setters are locked to their exact station and district');

  const unauthenticated = safety.createDisabledJoinHandler({
    requireAuth: function () {
      throw new TestHttpsError('unauthenticated', 'login required');
    },
    HttpsError: TestHttpsError
  });
  await rejectsWith('joinWithCode still requires authentication',
    unauthenticated({}), 'unauthenticated');

  const request = new Proxy({ auth:{ uid:'u_pending' } }, {
    get: function (target, key) {
      if (key === 'data') throw new Error('disabled join read request payload');
      return target[key];
    }
  });
  let authorized = 0;
  const disabled = safety.createDisabledJoinHandler({
    requireAuth: function (value) {
      assert.equal(value, request);
      authorized++;
      return value.auth;
    },
    HttpsError: TestHttpsError
  });
  await rejectsWith('authenticated legacy joinWithCode fails closed',
    disabled(request), 'failed-precondition');
  assert.equal(authorized, 1);
  console.log('✓ disabled join authorizes before returning the safe failure');

  const moduleSource = fs.readFileSync(
    path.join(__dirname, 'registration-safety.js'), 'utf8');
  const disabledBody = moduleSource.match(
    /return async function disabledJoinWithCode[\s\S]*?\n  };/
  );
  assert.ok(disabledBody, 'disabled join handler body exists');
  for (const token of ['req.data', 'openAudit', 'db.', 'admin.auth',
                       'allocateEmployeeNumber', 'setCustomUserClaims',
                       'writeProfile', 'console.']) {
    assert.equal(disabledBody[0].includes(token), false,
      'disabled join must not contain side effect token ' + token);
  }
  console.log('✓ disabled join has no payload, data or identity side effects');

  const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const approve = indexSource.match(
    /exports\.approveRegistration[\s\S]*?\/\/ ---------------------------------------------------------------------\r?\n\/\/  3\. שינוי תפקיד/
  );
  assert.ok(approve, 'approveRegistration section exists');
  for (const token of ['request_id', 'request_generation', 'requireRequest: true',
                       'blockIfAssigned: true',
                       'intentFingerprint',
                       "employeeMode: wanted ? 'fixed' : 'auto'",
                       'identityCoordinator.acquireAssignment',
                       'identityCoordinator.runAssignment']) {
    assert.ok(approve[0].includes(token), 'durable approval must contain ' + token);
  }
  for (const token of ['setCustomUserClaims(', 'reqRef.delete()',
                       'allocateEmployeeNumber()', 'writeProfile(']) {
    assert.equal(approve[0].includes(token), false,
      'approval export must not perform direct side effect ' + token);
  }
  console.log('✓ approval delegates exact-request, reservation and recovery to coordinator');

  const setRole = indexSource.match(
    /exports\.setUserRole[\s\S]*?\/\/ ---------------------------------------------------------------------\r?\n\/\/  4\. כניסה/
  );
  assert.ok(setRole, 'setUserRole section exists');
  for (const token of ["kind: 'clear_role'", "kind: 'set_role'",
                       'attachPendingRequest: true',
                       'identityCoordinator.runClear',
                       'identityCoordinator.runAssignment']) {
    assert.ok(setRole[0].includes(token), 'durable role change must contain ' + token);
  }
  assert.equal(setRole[0].includes('setCustomUserClaims('), false,
    'setUserRole must not write Auth directly');
  assert.equal(setRole[0].includes('clearRegistrationRequest('), false,
    'setUserRole must not delete recovery requests directly');
  assert.ok((setRole[0].match(/assertMayAssign\(/g) || []).length >= 2,
    'setUserRole must enforce scope before acquisition and against the stored plan');
  assert.ok(setRole[0].includes('d.super === true, desiredScope'),
    'the initial role check must include the desired station scope');
  assert.ok(setRole[0].includes('planned.super === true, planned'),
    'the post-acquisition check must revalidate the immutable plan scope');
  assert.ok(setRole[0].includes('SCHEDULE_MANAGER_ELIGIBLE_ROLES.indexOf(role) !== -1'),
    'an active schedule-manager appointment must be revoked before a role downgrade');
  assert.ok(setRole[0].includes('!remainingScheduleManagerEligible'),
    'the role-change guard must reject every role that cannot hold a schedule-manager appointment');
  assert.ok(indexSource.includes('if (!sid || !did || KNOWN_DISTRICTS.indexOf(did) === -1)'),
    'a non-super role setter with partial scope claims must fail closed');
  console.log('✓ role assignment and removal use the same durable per-uid coordinator and cannot retain an invalid schedule-manager appointment');

  const scheduleManager = indexSource.match(
    /exports\.setScheduleManager[\s\S]*?\/\/ ממשיך רק תוכנית זהות/
  );
  assert.ok(scheduleManager, 'setScheduleManager section exists');
  for (const token of ['requireSuperAdmin(req)', 'enforceAppCheck: true',
                       "kind: 'set_schedule_manager'", 'resolveUser(d)',
                       'identityCoordinator.acquireClaimsChange',
                       'identityCoordinator.runClaimsChange', 'desiredState:',
                       'schedule_manager_version']) {
    assert.ok(scheduleManager[0].includes(token),
      'schedule-manager change must contain ' + token);
  }
  for (const token of ['setCustomUserClaims(', 'db.runTransaction(',
                       'scheduleManagerGrantRef(', 'd.role', 'd.stationId',
                       'd.emp']) {
    assert.equal(scheduleManager[0].includes(token), false,
      'schedule-manager export must not directly trust or write ' + token);
  }
  assert.equal(/\bd\.schedule_manager\b/.test(scheduleManager[0]), false,
    'schedule-manager export must not trust a client-provided capability flag');
  assert.ok(scheduleManager[0].includes('profileSnap'),
    'schedule-manager assignment must verify the live station profile');
  assert.ok(scheduleManager[0].includes('stationProfile.resolveStationAliases(profile'),
    'schedule-manager assignment must resolve every historical station alias strictly');
  assert.ok(scheduleManager[0].includes('!profileStation.ok'),
    'schedule-manager assignment must fail closed for missing, malformed, or conflicting station aliases');
  assert.ok(scheduleManager[0].includes('if (enabled === false)'),
    'revoking a schedule-manager appointment must begin before profile eligibility checks');
  assert.ok(scheduleManager[0].includes('const grantSnap = await db.collection(SCHEDULE_MANAGER_GRANTS).doc(user.uid).get()'),
    'revocation may use only the server-private grant to retain its station state');
  assert.ok(scheduleManager[0].includes('if (enabled) {'),
    'active-profile and eligible-role checks must apply only when granting the appointment');
  const grantOnlyStart = scheduleManager[0].indexOf('if (enabled) {');
  const grantOnlyEnd = scheduleManager[0].indexOf('\n\n  const suppliedOpId', grantOnlyStart);
  assert.ok(grantOnlyStart > -1 && grantOnlyEnd > grantOnlyStart,
    'the grant-only eligibility branch must be delimited before the identity plan');
  const grantOnly = scheduleManager[0].slice(grantOnlyStart, grantOnlyEnd);
  const beforeGrantOnly = scheduleManager[0].slice(0, grantOnlyStart);
  assert.equal(beforeGrantOnly.includes('profileSnap'), false,
    'revocation must not read or reject an inactive, missing, or malformed live profile');
  for (const token of ["profile.is_active === false", "profile.active === false",
                       '!profileStation.ok', 'profileStation.stationId !== stationId',
                       "String(profile.role || '') !== role"]) {
    assert.ok(grantOnly.includes(token),
      'only an enabled grant must reject an ineligible live profile: ' + token);
  }
  const revokeOnlyStart = scheduleManager[0].indexOf('if (enabled === false)');
  assert.ok(revokeOnlyStart > -1 && revokeOnlyStart < grantOnlyStart,
    'revocation must be selected before the grant-only eligibility branch');
  const revokeOnly = scheduleManager[0].slice(revokeOnlyStart, grantOnlyStart);
  assert.ok(revokeOnly.includes('grantSnap'),
    'revocation must recover station state from the private live grant');
  assert.equal(revokeOnly.includes('profileSnap'), false,
    'revocation must remain possible after the station profile is inactive or invalid');

  const grantState = indexSource.match(
    /async function applyScheduleManagerGrantState[\s\S]*?\n}\n\nconst identityCoordinator/
  );
  assert.ok(grantState, 'server-private schedule-manager state hook exists');
  assert.ok(grantState[0].includes('(enabled && !STATION_ID_RE.test(stationId))'),
    'only enabled grants may require a valid station id; revocation must fail closed only on malformed operation data');
  assert.ok(grantState[0].includes('active: enabled'),
    'the server-private grant must be disabled by the same revocation operation');
  const scheduleManagerIntent = scheduleManager[0].match(
    /const intentFingerprint = identityCoordinatorModule\.stableHash\([\s\S]*?\n  \}\);/
  );
  assert.ok(scheduleManagerIntent, 'schedule-manager operation has an intent fingerprint');
  const scheduleManagerIntentCode = scheduleManagerIntent[0].replace(/\/\/.*$/gm, '');
  for (const token of ["kind: 'set_schedule_manager'", 'uid: user.uid',
                       'enabled: enabled', 'stationId: stationId', 'version: version']) {
    assert.ok(scheduleManagerIntentCode.includes(token),
      'schedule-manager retry fingerprint must include immutable ' + token);
  }
  for (const mutableField of ['before', 'desired', 'previous_claims', 'desired_claims']) {
    assert.equal(new RegExp('\\b' + mutableField + '\\s*:').test(scheduleManagerIntentCode), false,
      'schedule-manager retry fingerprint must not include mutable ' + mutableField);
  }
  console.log('✓ additional schedule authority uses a durable server-only claim operation');

  const boot = indexSource.match(
    /exports\.bootstrapSuperAdmin[\s\S]*?\/\/ ---------------------------------------------------------------------\r?\n\/\/  2\. אישור/
  );
  assert.ok(boot && boot[0].includes('identityCoordinator.acquireBootstrap'));
  assert.ok(boot[0].includes('identityCoordinator.runBootstrap'));
  assert.equal(boot[0].includes('setCustomUserClaims('), false);
  console.log('✓ bootstrap uses the same identity writer fence');

  const reject = indexSource.match(
    /exports\.rejectRegistration[\s\S]*?\/\/ ---------------------------------------------------------------------\r?\n\/\/  3\. שינוי תפקיד/
  );
  assert.ok(reject && reject[0].includes('identityCoordinator.rejectRequest'));
  assert.ok(reject[0].includes('request_id'));
  assert.ok(reject[0].includes('request_generation'));
  console.log('✓ registration rejection is generation-aware and server-side');

  const coordinatorSource = fs.readFileSync(
    path.join(__dirname, 'identity-coordinator.js'), 'utf8');
  for (const token of ['identity_operations/', 'emp_reservations/',
                       "status: 'processing'", "status: 'needs_recovery'",
                       "phase: 'profile_applied'", "'auth_applied'",
                       'fence_until', 'request_id', 'server_generation',
                       'request_fingerprint', 'plan_fingerprint', 'operation_id',
                       "status: 'retired'", 'retired: true']) {
    assert.ok(coordinatorSource.includes(token), 'coordinator must contain ' + token);
  }
  assert.ok(coordinatorSource.indexOf('applyAssignmentProfile(uid, opId)') <
            coordinatorSource.indexOf("applyAuth(uid, opId, ['profile_applied'])"));
  const clearFlow = coordinatorSource.match(
    /async function runClear[\s\S]*?\r?\n  }\r?\n\r?\n  async function runBootstrap/
  );
  assert.ok(clearFlow && clearFlow[0].indexOf("applyAuth(uid, opId, ['prepared'])") <
            clearFlow[0].indexOf('applyDeactivation(uid, opId)'));
  const claimsFlow = coordinatorSource.match(
    /async function runClaimsChange[\s\S]*?\r?\n  }\r?\n\r?\n  async function resumeOperation/
  );
  assert.ok(claimsFlow, 'claim-only coordinator flow exists');
  assert.ok(claimsFlow[0].indexOf('applyClaimsState(uid, opId)') <
            claimsFlow[0].indexOf("applyAuth(uid, opId, ['state_applied'])"),
    'server grant state must commit before Auth claims');
  assert.ok(claimsFlow[0].indexOf("applyAuth(uid, opId, ['state_applied'])") <
            claimsFlow[0].indexOf('revokeTokens(uid, opId, false)'),
    'claim-only changes must revoke refresh tokens after Auth');
  console.log('✓ assignment grants after profile; removal revokes before deactivation; additional claims are durable');

  const resume = indexSource.match(
    /exports\.resumeIdentityOperation[\s\S]*?\/\/ ---------------------------------------------------------------------\r?\n\/\/  4\. כניסה/
  );
  assert.ok(resume && resume[0].includes('requireSuperAdmin(req)'));
  assert.ok(resume[0].includes('identityCoordinator.resumeOperation'));
  assert.ok(resume[0].includes("'set_schedule_manager'"));
  assert.equal(resume[0].includes('d.role'), false);
  assert.equal(resume[0].includes('d.emp'), false);
  console.log('✓ recovery is super-only and accepts no replacement identity plan');

  const loginByEmp = indexSource.match(
    /exports\.loginWithEmployeeNumber[\s\S]*?exports\.whoAmI/
  );
  const passwordReset = indexSource.match(
    /exports\.requestPasswordReset[\s\S]*?\/\/ ---------------------------------------------------------------------\r?\n\/\/  6\./
  );
  assert.ok(loginByEmp && loginByEmp[0].includes('identityCoordinatorModule.activeIndex'));
  assert.ok(passwordReset && passwordReset[0].includes('identityCoordinatorModule.activeIndex'));
  console.log('✓ login and password reset reject retired employee numbers');

  const joinSection = indexSource.match(
    /exports\.joinWithCode[\s\S]*?\/\/ קביעת הקוד/
  );
  assert.ok(joinSection, 'joinWithCode export section exists');
  for (const token of ['req.data', 'allocateEmployeeNumber',
                       'setCustomUserClaims', 'writeProfile', 'openAudit']) {
    assert.equal(joinSection[0].includes(token), false,
      'deployed join export must not contain ' + token);
  }
  console.log('✓ deployed joinWithCode export is fail-closed');

  const loginSource = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  assert.equal(loginSource.includes('id="fCode"'), false);
  assert.equal(loginSource.includes("httpsCallable(fns, 'joinWithCode')"), false);
  assert.ok(loginSource.includes('request_id: newRequestId()'));
  assert.ok(loginSource.includes("status === 'processing'"));
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.ok(adminSource.includes("httpsCallable(fns, 'rejectRegistration')"));
  assert.ok(adminSource.includes("['pending', 'processing', 'needs_recovery']"));
  assert.ok(adminSource.includes("request_id: String(r.request_id || '')"));
  assert.ok(adminSource.includes("request_generation: String(r.server_generation || '')"));
  assert.ok(adminSource.includes("httpsCallable(fns, 'resumeIdentityOperation')"));
  assert.ok(adminSource.includes("data-act=\"dismiss\""));
  assert.ok(adminSource.includes('const isOrphanedReview = !isPending && !isLocked'));
  assert.ok(adminSource.includes('const lockedPlan = isLocked'));
  assert.equal(adminSource.includes("deleteDoc(doc(db, 'registration_requests'"), false);
  console.log('✓ clients preserve request identity and expose processing/recovery states');

  console.log('\n24 registration safety checks passed.');
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
