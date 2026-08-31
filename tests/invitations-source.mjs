import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'functions', 'invitations.js');
const testPath = path.join(here, '..', 'functions', 'invitations.test.js');
const integrationPath = path.join(here, '..', 'functions', 'invitations.integration.test.js');
const workflowPath = path.join(here, '..', '.github', 'workflows', 'tests.yml');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const tests = fs.readFileSync(testPath, 'utf8');
const integration = fs.readFileSync(integrationPath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log('✓ ' + label);
}

check('module exposes the reviewed pure invitation surface', function () {
  for (const token of [
    'function issue(', 'function inspect(', 'function redeem(',
    'function verifyPlan(', 'function revoke(', 'function assertApprovable(',
    'function approve('
  ]) assert.ok(source.includes(token), token);
});

check('invitation validity is exactly 72 hours', function () {
  assert.ok(source.includes('const INVITE_LIFETIME_MS = 72 * 60 * 60 * 1000'));
});

check('the module contains no Firebase or database I/O', function () {
  for (const token of [
    'firebase-admin', 'firebase-functions', 'getFirestore', '.collection(',
    '.doc(', '.set(', '.update(', '.delete(', 'runTransaction', 'writeBatch'
  ]) assert.equal(source.includes(token), false, token);
});

check('the module contains no logs that can leak invitation PII', function () {
  for (const token of ['console.log', 'console.error', 'console.warn', 'logger.']) {
    assert.equal(source.includes(token), false, token);
  }
});

check('no station or district is hardcoded', function () {
  for (const token of ['eilat_102', 'station-102', "'102'", 'אילת', "'south'"]) {
    assert.equal(source.includes(token), false, token);
  }
});

check('no parallel list of application roles exists', function () {
  for (const token of ['firefighter', 'hr_coordinator', 'station_commander',
                       'district_commander', 'commander', 'deputy']) {
    assert.equal(source.includes(token), false, token);
  }
});

check('authorization is injected from the existing role setter', function () {
  assert.ok(source.includes("'assertMayAssign'"));
  assert.ok(source.includes("'withinRoleSetterScope'"));
  assert.ok((source.match(/d\.assertMayAssign\(/g) || []).length >= 2);
  assert.ok((source.match(/d\.withinRoleSetterScope\(/g) || []).length >= 2);
});

check('super-admin assignment cannot be encoded in an invitation', function () {
  assert.ok(source.includes("role === 'super_admin'"));
  assert.ok(source.includes('super cannot be invited'));
  assert.equal(/doc\s*=\s*\{[\s\S]*?\bsuper\s*:/.test(source), false);
});

check('the secret is hashed and checked with constant-time comparison', function () {
  assert.ok(source.includes('secret_hash: hashSecret(secret)'));
  assert.ok(source.includes('d.timingSafeEqual('));
  assert.ok(source.includes('assertSecretAbsent(doc, secret)'));
});

check('public inspection intentionally collapses every invalid state', function () {
  assert.ok(source.includes("const INVALID_PUBLIC_RESULT = Object.freeze({ ok:false, error:'invalid' })"));
  assert.ok(source.includes('catch (_)'));
});

check('redemption requires verified email ownership', function () {
  assert.ok(source.includes('auth.email_verified !== true'));
  assert.ok(source.includes("'email-not-verified'"));
});

check('client assignment input is never copied into the redemption request', function () {
  const body = source.match(/function redeem\([\s\S]*?\n  }\n\n  function verifyPlan/);
  assert.ok(body, 'redeem body');
  assert.ok(body[0].includes('void clientInput'));
  for (const token of ['clientInput.station', 'clientInput.district',
                       'clientInput.role', 'clientInput.shift']) {
    assert.equal(body[0].includes(token), false, token);
  }
});

check('transaction-time verification rechecks revoke, use and expiry state', function () {
  const body = source.match(/function verifyPlan\([\s\S]*?\n  }\n\n  function revoke/);
  assert.ok(body, 'verifyPlan body');
  assert.ok(body[0].includes('assertRedeemableWithoutSecret(invite, when)'));
  assert.ok(source.includes('invite.revoked_at || invite.redeemed_by'));
});

check('approval is bound to the redeeming uid and locked email', function () {
  const body = source.match(/function assertApprovable\([\s\S]*?\n  }\n\n  function resolveScopedInput/);
  assert.ok(body, 'assertApprovable body');
  assert.ok(body[0].includes("uid !== String(invite.redeemed_by || '')"));
  assert.ok(body[0].includes('request.email'));
});

check('revocation remains open after redemption and closes at approval', function () {
  const body = source.match(/function revoke\([\s\S]*?\n  }\n\n  function assertApprovable/);
  assert.ok(body, 'revoke body');
  assert.equal(body[0].includes('invite.redeemed_by'), false);
  assert.ok(body[0].includes('invite.approved_at'));
  assert.ok(body[0].includes('invite.approved_by'));
});

check('approval records an auditable terminal state', function () {
  const body = source.match(/function approve\([\s\S]*?\n  }\n\n  function resolveScopedInput/);
  assert.ok(body, 'approve body');
  assert.ok(body[0].includes('approved_at: new Date(when)'));
  assert.ok(body[0].includes('approved_by: approvedBy'));
  assert.ok(body[0].includes('withinRoleSetterScope'));
  assert.ok(body[0].includes('assertMayAssign'));
});

check('approval accepts a timely redemption after expiry but rejects late redemption', function () {
  const body = source.match(/function assertApprovable\([\s\S]*?\n  }\n\n  function resolveScopedInput/);
  assert.ok(body);
  assert.ok(body[0].includes('redeemed_at'));
  assert.ok(body[0].includes('expires_at'));
  assert.ok(body[0].includes('redeemedAt >= expiresAt'));
  assert.equal(body[0].includes('<= when'), false);
});

check('the contract has at least 35 executable checks', function () {
  const count = (tests.match(/\btest\('/g) || []).length;
  assert.ok(count >= 35, 'found ' + count);
});

check('the tests cover the transaction race and privacy response', function () {
  assert.ok(tests.includes('two concurrent plans cannot both commit'));
  assert.ok(tests.includes('a redeemed but unapproved invitation can still be revoked'));
  assert.ok(tests.includes('an approved invitation cannot be revoked'));
  assert.ok(tests.includes('all invalid inspect cases return the same public shape'));
  assert.ok(tests.includes('secret is returned once and never stored in the document'));
});

check('the Firestore race test is wired into the existing emulator CI job', function () {
  assert.ok(workflow.includes('node invitations.integration.test.js'));
  assert.ok(workflow.includes('firebase emulators:exec --only firestore'));
});

check('the integration test refuses to run outside the emulator', function () {
  assert.ok(integration.includes('if (!process.env.FIRESTORE_EMULATOR_HOST)'));
  assert.ok(integration.includes('process.exit(2)'));
});

check('every redemption decision is repeated inside a transaction', function () {
  assert.ok(integration.includes('db.runTransaction('));
  assert.ok(integration.includes('const fresh = await tx.get(ref)'));
  assert.ok(integration.includes('api.verifyPlan(fresh.data(), plan)'));
  assert.ok(integration.includes('tx.update(ref, update)'));
});

check('the race test prevalidates contenders before either transaction starts', function () {
  assert.ok(integration.includes("const first = await buildPlan(issued, 'user-a')"));
  assert.ok(integration.includes("const second = await buildPlan(issued, 'user-b')"));
  assert.ok(integration.includes('length:10'));
});

check('redemption and revocation race accepts only the two legal serializations', function () {
  assert.ok(integration.includes("assert.equal(revocation.status, 'fulfilled')"));
  assert.ok(integration.includes('assert.ok(after.revoked_at)'));
  assert.ok(integration.includes('assert.deepEqual(counts, { fulfilled:2, rejected:0 })'));
  assert.ok(integration.includes('assert.deepEqual(counts, { fulfilled:1, rejected:1 })'));
  assert.ok(integration.includes("await assert.rejects(commitApproval(issued.invite_id, 'race-user'))"));
});

assert.equal(checks.length, 24);
console.log('\n24 invitation source checks passed.');
