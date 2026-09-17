'use strict';
// Actual callable .run handlers + real local Firestore. Auth is synthetic.
// This does not exercise deployed HTTP, ID-token verification, or App Check.
const assert = require('node:assert/strict');
if (!/^(127\.0\.0\.1|localhost):\d{1,5}$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')
  || process.env.GCLOUD_PROJECT !== 'demo-resq') throw Error('NOT RUN: isolated loopback demo-resq required');
process.env.METADATA_SERVER_DETECTION = 'none';
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'demo-resq' });
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const admin = require('firebase-admin');
const run = crypto.randomBytes(6).toString('hex');
const sid = 'onboard_it_' + run, actorUid = 'onboard_super_' + run, uid = 'onboard_user_' + run;
const emp = String(800000 + crypto.randomInt(190000));
const records = new Map([
  [actorUid, { uid: actorUid, disabled: false, emailVerified: true, email: 'super-' + run + '@example.test', customClaims: { super: true } }],
  [uid, { uid, disabled: false, emailVerified: true, email: 'admin-' + run + '@example.test', customClaims: {} }]
]);
let grants = 0, revocations = 0, providerCalls = 0;
const blocked = () => { providerCalls++; throw Error('External provider forbidden in callable test'); };
const authStub = new Proxy({
  async getUser(id) { if (!records.has(id)) throw Object.assign(Error('synthetic missing user'), { code: 'auth/user-not-found' }); return structuredClone(records.get(id)); },
  async setCustomUserClaims(id, claims) { assert.equal(id, uid); records.get(id).customClaims = structuredClone(claims); grants++; },
  async revokeRefreshTokens(id) { assert.equal(id, uid); revocations++; }
}, { get(target, key) { return key in target ? target[key] : blocked; } });
const facade = new Proxy(admin, { get(target, key) {
  if (key === 'auth') return () => authStub;
  if (key === 'messaging') return () => new Proxy({}, { get: () => blocked });
  if (key === 'storage') return () => ({ bucket: blocked });
  return Reflect.get(target, key);
} });
const sourceFiles = ['index.js','identity-coordinator.js','invitations.js','invitation-onboarding-service.js',
  'onboarding-phase-authority.js','onboarding-approval-authority.js','onboarding-station-gates.js','station-first-admin-invitation-service.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,file))).digest('hex')]));
const before = hashes(), load = Module._load, oldFetch = global.fetch;
let functions;
try {
  Module._load = function(request, parent, main) { return request === 'firebase-admin' ? facade : load.call(this,request,parent,main); };
  global.fetch = blocked;
  functions = require('./index');
} finally { Module._load = load; }
const db = admin.firestore(), root = db.doc('stations/' + sid);
const owned = ['identity_operations/' + uid, 'registration_requests/' + uid, 'onboarding_assignment_links/' + uid,
  'directory/' + uid, 'emp_index/' + emp, 'emp_reservations/' + emp];
let inviteId, fixtureValidated = false;
const request = (who, data) => ({ auth: { uid: who, token: { ...records.get(who).customClaims,
  email: records.get(who).email, email_verified: true, auth_time: Math.floor(Date.now()/1000) } }, data });
const call = (name, who, data) => { assert.equal(typeof functions[name]?.run, 'function', name + ' actual callable hook'); return functions[name].run(request(who,data)); };
(async () => {
  try {
    assert.equal((await root.get()).exists, false);
    for (const p of owned) assert.equal((await db.doc(p).get()).exists, false, 'fixture target must be absent: ' + p);
    fixtureValidated = true;
    const provisionId = 'provision_' + run, issueId = 'issue_request_' + run, redeemId = 'redeem_request_' + run;
    const provision = await call('provisionStation', actorUid, { request_id: provisionId, station_id: sid,
      district_id: 'south', display_name: 'Synthetic Station', timezone: 'Asia/Jerusalem', template_id: 'fire-station-v1' });
    assert.equal(provision.status, 'provisioning');
    const issueData = { station_id: sid, provision_request_id: provisionId, request_id: issueId,
      full_name: 'Synthetic First Admin', email: records.get(uid).email, phone: '', shift: 'A' };
    const issued = await call('issueFirstAdminInvitation', actorUid, issueData); inviteId = issued.invite_id;
    assert.equal(issued.secret_available, true); assert.ok(issued.secret);
    const replayIssue = await call('issueFirstAdminInvitation', actorUid, issueData);
    assert.equal(replayIssue.secret_available, false); assert.equal('secret' in replayIssue, false);
    const redeemed = await call('redeemInvitation', uid, { request_id: redeemId, invite_id: inviteId, secret: issued.secret });
    assert.equal(redeemed.permissions_granted, false); assert.equal(grants, 0);
    const pending = await call('resumeOnboarding', actorUid, { station_id: sid, request_id: redeemId });
    assert.equal(pending.approved, false);
    let r = (await db.doc('registration_requests/' + uid).get()).data();
    const approval = () => ({ uid, request_id: r.request_id, request_generation: r.server_generation || '', emp,
      role: 'station_commander', full_name: 'Client Override Must Be Ignored', stationId: 'foreign_station', districtId: 'north', shift: 'C' });
    if (!r.server_generation) {
      await assert.rejects(call('approveRegistration', actorUid, approval()), e => e.code === 'failed-precondition' && e.details?.request_refreshed === true);
      assert.equal(grants, 0); r = (await db.doc('registration_requests/' + uid).get()).data();
    }
    const input = approval(), result = await call('approveRegistration', actorUid, input);
    assert.equal(result.ok, true); assert.equal(grants, 1);
    assert.deepEqual(records.get(uid).customClaims, { role: 'commander', stationId: sid, districtId: 'south', shift: 'A', emp });
    const profile = (await root.collection('users').doc(uid).get()).data();
    assert.equal(profile.full_name, 'Synthetic First Admin'); assert.equal(profile.role, 'commander');
    const completed = (await db.doc('identity_operations/' + uid).get()).data();
    assert.equal(completed.status, 'completed'); assert.equal(completed.onboarding_authority.source.invite_id, inviteId);
    assert.equal((await db.doc('registration_requests/' + uid).get()).exists, false);
    await call('approveRegistration', actorUid, input); assert.equal(grants, 1);
    const resumed = await call('resumeOnboarding', actorUid, { station_id: sid, request_id: redeemId });
    assert.equal(resumed.approved, true); assert.equal(grants, 1);
    await assert.rejects(call('markStationReady', actorUid, { station_id: sid }), e => e.code === 'failed-precondition');
    const station = (await root.get()).data(); assert.equal(station.active, false); assert.equal(station.silent, true);
    assert.equal(station.status, 'provisioning'); assert.equal(providerCalls, 0);
    assert.deepEqual(hashes(), before, 'actual integrated source remained frozen');
    console.log(JSON.stringify({ pass: true, flow: 'actual callable provision/issue/redeem/approve/resume', grants, revocations,
      provider_calls: providerCalls, station_stays_provisioning: true, source_hashes: before }));
  } finally {
    // Delete only prevalidated unique fixture identities and exact owned audit rows.
    if (inviteId) await db.doc('invitations/' + inviteId).delete();
    if (fixtureValidated) {
      const audits = await db.collection('admin_audit').where('target_uid','==',uid).get();
      for (const doc of audits.docs) { assert.equal(doc.data().target_uid, uid); await doc.ref.delete(); }
      assert.ok(sid.startsWith('onboard_it_' + run)); await db.recursiveDelete(root);
      for (const p of owned) await db.doc(p).delete();
    }
    global.fetch = oldFetch;
    await Promise.all(admin.apps.map(app => app.delete()));
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
