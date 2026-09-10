import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIREBASE_ORIGIN, PAGES_ORIGIN, PRIVATE_PROBES, verifyLiveDualHost } from './pages-live-parity.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-live-parity-'));
const APPROVED = Object.freeze(['index.html']);
function response(status, body = '') {
  const bytes = new TextEncoder().encode(body);
  return { status, arrayBuffer:async () => bytes.buffer };
}
try {
  fs.mkdirSync(path.join(temp, '.firebase'), { recursive:true });
  fs.writeFileSync(path.join(temp, 'index.html'), 'release-body');
  fs.writeFileSync(path.join(temp, '.firebase', 'hosting..cache'), 'index.html,hash');
  let pagesRound = 0;
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    const relative = parsed.pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
    if (PRIVATE_PROBES.includes(relative)) return response(404);
    if (url.startsWith(FIREBASE_ORIGIN)) return response(200, 'release-body');
    if (url.startsWith(PAGES_ORIGIN)) return response(200, pagesRound++ === 0 ? 'stale-body' : 'release-body');
    return response(500);
  };
  let waits = 0;
  const result = await verifyLiveDualHost(temp, {
    fetchImpl:fakeFetch, approvedAssets:APPROVED,
    pagesAttempts:3, waitMs:1, wait:async () => { waits += 1; }
  });
  assert.equal(result.firebase.ok, true);
  assert.equal(result.pages.ok, true);
  assert.equal(result.pages_attempts, 2);
  assert.equal(waits, 1);
  assert.ok(calls.some((url) => url.startsWith(FIREBASE_ORIGIN + '/index.html')));
  assert.ok(calls.some((url) => url.startsWith(PAGES_ORIGIN + '/index.html')));

  await assert.rejects(() => verifyLiveDualHost(temp, {
    fetchImpl:async (url) => PRIVATE_PROBES.some((item) => url.includes('/' + item + '?'))
      ? response(url.startsWith(PAGES_ORIGIN) ? 200 : 404)
      : response(200, 'release-body'),
    approvedAssets:APPROVED, pagesAttempts:1, waitMs:0, wait:async () => {}
  }), /GitHub Pages live parity failed/);

  let networkAttempts = 0;
  const recovered = await verifyLiveDualHost(temp, {
    approvedAssets:APPROVED, pagesAttempts:2, waitMs:1, wait:async () => {},
    fetchImpl:async (url) => {
      const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
      if (PRIVATE_PROBES.includes(relative)) return response(404);
      if (url.startsWith(FIREBASE_ORIGIN)) return response(200, 'release-body');
      if (networkAttempts++ === 0) throw new Error('network down');
      return response(200, 'release-body');
    }
  });
  assert.equal(recovered.pages_attempts, 2);

  let clock = 0;
  await assert.rejects(() => verifyLiveDualHost(temp, {
    approvedAssets:APPROVED, pagesAttempts:21, waitMs:30_000, maxDurationMs:60_000,
    now:() => clock,
    wait:async (ms) => { clock += ms; },
    fetchImpl:async (url) => {
      const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
      if (PRIVATE_PROBES.includes(relative)) return response(404);
      return url.startsWith(FIREBASE_ORIGIN)
        ? response(200, 'release-body') : response(200, 'stale-body');
    }
  }), /GitHub Pages live parity failed/);
  assert.equal(clock, 60_000);
  console.log('Dual-host live parity: CDN retry, exact hash and private 404 checks PASS');
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}
