#!/usr/bin/env node
// Staging-only probe: proves the raw Identity Toolkit REST signInWithPassword
// endpoint still accepts email+password WITHOUT App Check. Never run against
// production. Refuses known production project IDs and requires an explicit
// STAGING_PROJECT_ID that starts with "resq-staging" / "demo-" / "resq-dev".
import assert from 'node:assert/strict';

const PRODUCTION_PROJECT_IDS = new Set([
  'resq-102', 'resq-prod', 'station-102', 'resq-eilat-102'
]);
const projectId = String(process.env.STAGING_PROJECT_ID || '');
const apiKey = String(process.env.STAGING_WEB_API_KEY || '');
const email = String(process.env.STAGING_PROBE_EMAIL || '');
const password = String(process.env.STAGING_PROBE_PASSWORD || '');

if (!projectId || PRODUCTION_PROJECT_IDS.has(projectId) ||
    !/^(resq-staging|demo-|resq-dev)/.test(projectId)) {
  console.error('REFUSED: set STAGING_PROJECT_ID to a staging/demo project (not production).');
  process.exit(2);
}
if (!apiKey || !email || !password) {
  console.error('REFUSED: need STAGING_WEB_API_KEY, STAGING_PROBE_EMAIL, STAGING_PROBE_PASSWORD.');
  process.exit(2);
}

const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey);
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, returnSecureToken: true })
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.log('PROBE_RESULT', JSON.stringify({ ok: false, status: res.status, code: body?.error?.message || 'unknown' }));
  process.exit(1);
}
assert.ok(body.idToken || body.localId, 'expected a token or localId from REST bypass');
console.log('PROBE_RESULT', JSON.stringify({
  ok: true,
  status: res.status,
  bypass_without_app_check: true,
  note: 'REST signInWithPassword succeeded with no App Check header — H2 remains OPEN until console enforce.'
}));
