import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publishResult, verifyPublisher, PROJECT } from './telemetry-ci.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificates = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
const uid = 'isolated-ci-publisher';
const env = { GITHUB_REPOSITORY: 'Elyo102/ResQ-102', GITHUB_REF: 'refs/heads/dev',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
  TELEMETRY_APPROVED_SHA: 'a'.repeat(40), FIREBASE_TELEMETRY_UID: uid,
  FIREBASE_TELEMETRY_REFRESH_TOKEN: 'synthetic-refresh-not-a-real-secret', TEST_RESULT: 'success' };
function token(patch = {}) {
  const now = Math.floor(Date.now()/1000);
  const body = { aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: uid,
    control_plane_agent: 'Codex', exp: now+600, iat: now-10, auth_time: now-20, ...patch };
  const data = [ {alg:'RS256',kid:'test'}, body ].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  const signer = createSign('RSA-SHA256'); signer.update(data); signer.end();
  return data + '.' + signer.sign(keys.privateKey).toString('base64url');
}
function harness({ authPatch = {}, commitFailure = false, malformedCommit = false, certFailure = false } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({url, options}); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    if (url.startsWith('https://securetoken.googleapis.com/')) return Response.json({
      id_token: token(), user_id: uid, project_id: '802712493259', ...authPatch });
    if (url.startsWith('https://www.googleapis.com/robot/')) return certFailure
      ? new Response('sensitive body', {status:403}) : Response.json(certificates);
    assert.equal(url, `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:commit`);
    if (commitFailure) throw new Error('private bearer/token error must not escape');
    return Response.json(malformedCommit ? {} : { writeResults:[{},{},{}], commitTime:new Date().toISOString() });
  };
  return {fetcher,calls};
}
test('accepts signed scoped publisher; rejects forged, expired, wrong agent and project tokens', () => {
  verifyPublisher(token(), certificates, uid);
  for (const now of [NaN, Infinity, -1, 8e15+1])
    assert.throws(()=>verifyPublisher(token(),certificates,uid,now),/PUBLISHER_INVALID/);
  for (const patch of [{aud:'station-102'}, {control_plane_agent:'Claude'}, {sub:'other'}, {exp:1}, {iat:-1}, {auth_time:-1}, {iat:9999999999}, {auth_time:9999999999}])
    assert.throws(()=>verifyPublisher(token(patch),certificates,uid), /PUBLISHER_INVALID/);
  const forged = token().split('.'); forged[1] = Buffer.from(JSON.stringify({sub:uid})).toString('base64url');
  assert.throws(()=>verifyPublisher(forged.join('.'),certificates,uid), /PUBLISHER_INVALID/);
});
test('rejects missing credentials and unapproved/ref-selected runs before any network call', async () => {
  for (const patch of [{FIREBASE_TELEMETRY_REFRESH_TOKEN:''}, {GITHUB_REF:'refs/heads/main'},
    {GITHUB_EVENT_NAME:'pull_request_target'}, {TELEMETRY_APPROVED_SHA:'b'.repeat(40)}, {GITHUB_REPOSITORY:'fork/ResQ-102'}]) {
    const h = harness(); await assert.rejects(publishResult({...env,...patch},h.fetcher),/TELEMETRY_/);
    assert.equal(h.calls.length,0);
  }
});
test('only creates bounded Codex events with server time and no provider secrets', async () => {
  const h = harness(); const result = await publishResult({...env,ANTHROPIC_API_KEY:'not-for-telemetry'},h.fetcher);
  assert.deepEqual(result,{status:'accepted',count:3});
  const writes = JSON.parse(h.calls[2].options.body).writes;
  assert.equal(writes.length,3);
  for (const w of writes) {
    assert.deepEqual(w.currentDocument,{exists:false});
    assert.deepEqual(w.updateTransforms,[{fieldPath:'createdAt',setToServerValue:'REQUEST_TIME'}]);
    assert.equal(w.update.fields.agent.stringValue,'Codex');
    assert.match(w.update.name,/\/events\/[a-f0-9-]{36}$/);
  }
  assert.ok(!JSON.stringify(h.calls).includes('not-for-telemetry'));
});
test('failure emits failure; skipped and cancelled never pretend tests executed', async () => {
  for (const TEST_RESULT of ['failure']) {
    const h=harness(); await publishResult({...env,TEST_RESULT},h.fetcher);
    const payload=h.calls[2].options.body;
    assert.ok(payload.includes('task_failed')); assert.ok(!payload.includes('test_passed'));
  }
  for (const TEST_RESULT of ['cancelled','skipped']) {
    const h=harness(); assert.deepEqual(await publishResult({...env,TEST_RESULT},h.fetcher),{status:'not_emitted',reason:TEST_RESULT});
    assert.equal(h.calls.length,0);
  }
});
test('wrong project/UID, certificate failure and bad token stop before Firestore', async () => {
  for (const options of [{authPatch:{project_id:'wrong'}},{authPatch:{user_id:'wrong'}},
    {authPatch:{id_token:'broken'}},{certFailure:true}]) {
    const h=harness(options); await assert.rejects(publishResult(env,h.fetcher),/TELEMETRY_/);
    assert.ok(!h.calls.some(c=>c.url.startsWith('https://firestore.googleapis.com')));
  }
});
test('ambiguous/malformed commit is unknown, without retries or raw error leakage', async () => {
  for (const options of [{commitFailure:true},{malformedCommit:true}]) {
    const h=harness(options); await assert.rejects(publishResult(env,h.fetcher),/^Error: TELEMETRY_DELIVERY_UNKNOWN$/);
    assert.equal(h.calls.length,3);
  }
});
test('oversized response and redirect failure are bounded and sanitized', async () => {
  for (const fetcher of [async()=>new Response('x'.repeat(65537)),async()=>{throw Error('secret redirect');}])
    await assert.rejects(publishResult(env,fetcher),/^Error: TELEMETRY_REQUEST_FAILED$/);
});
test('workflow isolates secrets behind protected receipt job and exact reviewed SHA', () => {
  const yaml=readFileSync(new URL('../workflows/telemetry.yml',import.meta.url),'utf8');
  assert.match(yaml,/workflow_dispatch:/); assert.match(yaml,/branches: \[dev\]/);
  assert.match(yaml,/environment: resq-telemetry/); assert.match(yaml,/TELEMETRY_APPROVED_SHA/);
  assert.match(yaml,/needs: tests/); assert.match(yaml,/needs.tests.result/);
  assert.ok(!/pull_request_target|id-token: write/.test(yaml));
  const split=yaml.indexOf('  agents:');assert.ok(split>0);
  assert.ok(!/ANTHROPIC_API_KEY|XAI_API_KEY|GEMINI_API_KEY/.test(yaml.slice(0,split)));
  const agents=yaml.slice(split);
  for(const key of ['ANTHROPIC_API_KEY','XAI_API_KEY','GEMINI_API_KEY','FIREBASE_BUDGET_REFRESH_TOKEN'])assert.ok(agents.includes(`secrets.${key}`));
  assert.match(agents,/environment: resq-telemetry/);assert.match(agents,/needs.tests.result == 'success'/);
  assert.match(agents,/test "\$APPROVED" = "\$GITHUB_SHA"/);assert.match(agents,/ref: \$\{\{ github.sha \}\}/);
  assert.ok(!yaml.slice(0,yaml.indexOf('  receipt:')).includes('secrets.'));
});
