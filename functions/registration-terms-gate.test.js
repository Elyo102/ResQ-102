'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRegistrationTermsGate, createPreApprovalOnCall, validMarker } = require('./registration-terms-gate');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const uid = 'member1';
const marker = { uid, consent_key: '1.3|2026-09-24', terms_version: '1.3', privacy_version: '2026-09-24',
  receipt_path: 'registration_consents/member1/events/receipt1' };

async function main() {
  const indexSource = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(indexSource, /exports\.whoAmI\s*=\s*preApprovalOnCall\(\{\s*enforceAppCheck:\s*true\s*\},\s*async/);
  assert.match(indexSource, /exports\.inspectJoinCampaign\s*=\s*firebaseOnCall\(\{\s*enforceAppCheck:\s*true\s*\}/);
  assert.match(indexSource, /exports\.redeemJoinCampaign\s*=\s*preApprovalOnCall\(/);
  assert.match(indexSource, /exports\.getMyJoinStatus\s*=\s*preApprovalOnCall\(/);
  let reads = 0;
  let current = null;
  const firebaseOnCall = (...args) => args.at(-1);
  const onCall = createRegistrationTermsGate({ firebaseOnCall, HttpsError,
    readMarker: async () => { reads++; return current; } });
  const handler = onCall({ enforceAppCheck: true }, async () => 'success');
  const authenticated = { auth: { uid } };
  await assert.rejects(handler(authenticated), e => e.code === 'failed-precondition');
  assert.equal(reads, 1);
  current = marker;
  assert.equal(await handler(authenticated), 'success');
  assert.equal(reads, 2);
  assert.equal(await onCall(async () => 'anonymous')({}), 'anonymous');
  assert.equal(reads, 2);
  for (const bad of [{ ...marker, uid: 'other' }, { ...marker, consent_key: '1.2|2026-09-24' }, { ...marker, terms_version: '1.2' },
    { ...marker, receipt_path: 'registration_consents/other/events/x' }]) {
    assert.equal(validMarker(uid, bad), false);
    current = bad;
    await assert.rejects(handler(authenticated), e => e.code === 'failed-precondition');
  }
  assert.equal(validMarker(uid, marker), true);
  let liveClaims = {};
  let failRead = false;
  const preApprovalOnCall = createPreApprovalOnCall({ firebaseOnCall, HttpsError,
    getLiveUser: async () => ({ uid, disabled: false, customClaims: liveClaims }),
    readMarker: async () => { if (failRead) throw new Error('offline'); return current; } });
  const pendingHandler = preApprovalOnCall({}, async () => 'pending-ok');
  current = null;
  assert.equal(await pendingHandler(authenticated), 'pending-ok');
  liveClaims = { super: true };
  await assert.rejects(pendingHandler(authenticated), e => e.code === 'failed-precondition');
  liveClaims = { emp: '101' };
  await assert.rejects(pendingHandler({ auth:{ uid, token:{} } }), e => e.code === 'failed-precondition');
  current = marker;
  assert.equal(await pendingHandler(authenticated), 'pending-ok');
  failRead = true;
  await assert.rejects(pendingHandler(authenticated), e => e.message === 'offline');
  console.log('registration-terms-gate: 15 PASS');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
