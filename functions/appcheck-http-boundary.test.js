'use strict';
// Real installed onCall HTTP wrapper; only external verifiers are simulated.
// No sockets, real credentials, provider tokens or production initialization.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
assert.notEqual(process.env.FIREBASE_DEBUG_MODE, 'true', 'debug bypass forbidden');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS, 'credentials forbidden');
const { initializeApp, deleteApp, getApps } = require('firebase-admin/app');
assert.equal(getApps().length, 0, 'dedicated test process required');
const app = initializeApp({ projectId:'demo-resq' });
const auth = require('firebase-admin/auth').getAuth(app);
const appCheck = require('firebase-admin/app-check').getAppCheck(app);
let verifications = 0;
appCheck.verifyToken = async (...args) => {
  verifications++;
  assert.equal(args.length, 1, 'must not enable token consumption');
  if (args[0] !== 'synthetic-valid-app') throw new Error('synthetic invalid app token');
  return { appId:'synthetic-app', token:{ sub:'synthetic-app' } };
};
auth.verifyIdToken = async token => {
  if (token !== 'synthetic-valid-auth') throw new Error('synthetic invalid auth token');
  return { uid:'synthetic-member' };
};
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { createRegistrationTermsGate, createPreApprovalOnCall } = require('./registration-terms-gate');
let reads = 0, liveReads = 0, calls = 0, marker = null, disabled = false;
const validMarker = { uid:'synthetic-member', consent_key:'1.3|2026-09-24',
  terms_version:'1.3', privacy_version:'2026-09-24',
  receipt_path:'registration_consents/synthetic-member/events/synthetic' };
const deps = { firebaseOnCall:onCall, HttpsError,
  readMarker:async () => { reads++; return marker; },
  getLiveUser:async () => { liveReads++; return { disabled, customClaims:{ role:'hr' } }; } };
const options = { enforceAppCheck:true, secrets:['SYNTHETIC_TEST_SECRET'] };
const business = async req => { calls++; return { app:req.app.appId, uid:req.auth?.uid || null }; };
const wrappers = [onCall, createRegistrationTermsGate(deps), createPreApprovalOnCall(deps)];
async function invoke(fn, appToken, authToken) {
  const headers = { 'content-type':'application/json' };
  if (appToken) headers['x-firebase-appcheck'] = appToken;
  if (authToken) headers.authorization = 'Bearer '+authToken;
  const req = { method:'POST', headers, body:{ data:{} },
    header:name => headers[name.toLowerCase()] };
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (key,value) => { res.headers[key.toLowerCase()] = value; };
  res.getHeader = key => res.headers[key.toLowerCase()];
  res.status = code => { res.statusCode=code; return res; };
  res.send = body => { res.body=body; res.emit('finish'); return res; };
  res.end = () => { res.emit('finish'); };
  await fn(req,res);
  return res;
}
async function main() {
  let checks=0;
  for (const wrap of wrappers) {
    const fn=wrap(options,business);
    assert.deepEqual(fn.__endpoint.secretEnvironmentVariables,[{key:'SYNTHETIC_TEST_SECRET'}]);
    for (const token of [undefined,'synthetic-invalid-app']) {
      const before=[calls,reads,liveReads], verified=verifications;
      const result=await invoke(fn,token,'synthetic-valid-auth');
      assert.equal(result.statusCode,401);
      assert.equal(result.body.error.status,'UNAUTHENTICATED');
      assert.deepEqual([calls,reads,liveReads],before,'no business/Terms/identity reads before app validation');
      assert.equal(verifications-verified,token?1:0);
      checks++;
    }
    marker=validMarker; disabled=false;
    const ok=await invoke(fn,'synthetic-valid-app','synthetic-valid-auth');
    assert.equal(ok.statusCode,200);
    assert.deepEqual(ok.body.result,{app:'synthetic-app',uid:'synthetic-member'});
    checks++;
  }
  for (const wrap of wrappers.slice(1)) {
    marker=null;
    const before=calls;
    const result=await invoke(wrap(options,business),'synthetic-valid-app','synthetic-valid-auth');
    assert.equal(result.statusCode,400);
    assert.equal(result.body.error.status,'FAILED_PRECONDITION');
    assert.equal(calls,before); checks++;
  }
  disabled=true; marker=validMarker;
  const before=calls;
  const inactive=await invoke(wrappers[2](options,business),'synthetic-valid-app','synthetic-valid-auth');
  assert.equal(inactive.statusCode,403); assert.equal(calls,before); checks++;
  const badAuth=await invoke(onCall(options,business),'synthetic-valid-app','synthetic-invalid-auth');
  assert.equal(badAuth.statusCode,401); assert.equal(calls,before); checks++;
  const anonymous=await invoke(onCall(options,business),'synthetic-valid-app');
  assert.equal(anonymous.statusCode,200);
  assert.deepEqual(anonymous.body.result,{app:'synthetic-app',uid:null}); checks++;
  console.log('appcheck HTTP boundary: '+checks+' PASS (simulated verifiers; expected SDK denial warnings; no provider-readiness claim)');
}
main().finally(() => deleteApp(app)).catch(error => { console.error(error); process.exitCode=1; });
