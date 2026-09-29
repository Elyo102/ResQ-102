import { randomUUID, createVerify } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'resq-agent-control-20260928';
const KEY = 'AIzaSyCe0_Wad4-4MS3OHWB0fPxGsiSJe2M2Hzk'; // Public Firebase client key.
const CERTS = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const DB = `projects/${PROJECT}/databases/(default)`;
const fail = code => { throw new Error(code); };

async function json(fetcher, url, options = {}) {
  try {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail('TELEMETRY_HTTP_FAILURE');
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) fail('TELEMETRY_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { fail('TELEMETRY_REQUEST_FAILED'); }
}

// Crypto verification is additional defense; Firestore Rules still authorize
// every create and check the private publisher allowlist/revocation state.
export function verifyPublisher(token, certificates, uid, now = Date.now()) {
  try {
    if (!Number.isSafeInteger(now) || now < 0 || now > 8e15) fail('CLOCK');
    if (typeof token !== 'string' || token.length > 20000) fail('TOKEN');
    const parts = token.split('.');
    if (parts.length !== 3) fail('TOKEN');
    const head = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const body = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (head.alg !== 'RS256' || typeof head.kid !== 'string'
      || !Object.hasOwn(certificates, head.kid)) fail('TOKEN');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(parts[0] + '.' + parts[1]); verifier.end();
    if (!verifier.verify(certificates[head.kid], Buffer.from(parts[2], 'base64url'))) fail('TOKEN');
    const seconds = Math.floor(now / 1000);
    if (body.aud !== PROJECT || body.iss !== `https://securetoken.google.com/${PROJECT}`
      || body.sub !== uid || body.control_plane_agent !== 'Codex'
      || !Number.isSafeInteger(body.exp) || body.exp <= seconds
      || !Number.isSafeInteger(body.iat) || body.iat < 0 || body.iat > seconds
      || !Number.isSafeInteger(body.auth_time) || body.auth_time < 0 || body.auth_time > seconds) fail('TOKEN');
  } catch { fail('TELEMETRY_PUBLISHER_INVALID'); }
}

export async function publishResult(env, fetcher = fetch) {
  if (env.GITHUB_REPOSITORY !== 'Elyo102/ResQ-102'
    || env.GITHUB_REF !== 'refs/heads/dev'
    || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    || env.TELEMETRY_APPROVED_SHA !== env.GITHUB_SHA) fail('TELEMETRY_UNAPPROVED_RUN');
  if (['cancelled', 'skipped'].includes(env.TEST_RESULT)) return {status:'not_emitted', reason:env.TEST_RESULT};
  const uid = env.FIREBASE_TELEMETRY_UID;
  const refresh = env.FIREBASE_TELEMETRY_REFRESH_TOKEN;
  if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(uid)
    || typeof refresh !== 'string' || refresh.length < 20 || refresh.length > 8192) fail('TELEMETRY_CREDENTIAL_MISSING');
  if (!['success', 'failure'].includes(env.TEST_RESULT)) fail('TELEMETRY_RESULT_INVALID');
  const auth = await json(fetcher, `https://securetoken.googleapis.com/v1/token?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }).toString()
  });
  if (auth.user_id !== uid || auth.project_id !== '802712493259') fail('TELEMETRY_IDENTITY_MISMATCH');
  const certificates = await json(fetcher, CERTS);
  verifyPublisher(auth.id_token, certificates, uid);
  const success = env.TEST_RESULT === 'success';
  // A short receipt run is genuinely alive; this is NOT a provider heartbeat.
  const events = [
    { kind: 'heartbeat', step: 'running' },
    { kind: success ? 'test_passed' : 'test_failed', step: success ? 'passed' : 'failed' },
    { kind: success ? 'task_completed' : 'task_failed', step: success ? 'completed' : 'failed' }
  ];
  const ids = events.map(() => randomUUID());
  const writes = events.map((event, i) => ({
    update: { name: `${DB}/documents/events/${ids[i]}`, fields: Object.fromEntries(
      Object.entries({ agent: 'Codex', task: 'local_tests', ...event }).map(([k,v]) => [k, { stringValue: v }])) },
    currentDocument: { exists: false },
    updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]
  }));
  // Single bounded atomic commit. Lost response => unknown, NEVER retry/upsert.
  let result;
  try {
    result = await json(fetcher, `https://firestore.googleapis.com/v1/${DB}/documents:commit`, {
      method: 'POST', headers: { Authorization: `Bearer ${auth.id_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes })
    });
  } catch { fail('TELEMETRY_DELIVERY_UNKNOWN'); }
  if (!Array.isArray(result.writeResults) || result.writeResults.length !== 3
    || !Number.isFinite(Date.parse(result.commitTime))) fail('TELEMETRY_DELIVERY_UNKNOWN');
  return { status: 'accepted', count: 3 }; // Never output tokens or server bodies.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await publishResult(process.env))); }
  catch (error) {
    const code = /^TELEMETRY_[A-Z_]+$/.test(error.message) ? error.message : 'TELEMETRY_FAILED';
    console.error(code); process.exitCode = 1;
  }
}
