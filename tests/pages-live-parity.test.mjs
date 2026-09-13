import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIREBASE_ORIGIN, PAGES_ORIGIN, PRIVATE_PROBES, inspectLiveOrigin, verifyLiveDualHost } from './pages-live-parity.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-live-parity-'));
const APPROVED = Object.freeze(['index.html']);
function response(status, body = '', headers = {}) {
  const bytes = new TextEncoder().encode(body);
  const lowered = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { status, headers:{ get:(name) => lowered[String(name).toLowerCase()] || null },
    arrayBuffer:async () => bytes.buffer };
}
const HTML_HEADERS = Object.freeze({ 'content-type':'text/html; charset=utf-8', 'cache-control':'no-cache' });
try {
  for (const version of ['42h16', '42h17']) {
    assert.ok(PRIVATE_PROBES.includes('firebase.emulator.' + version + '.json'),
      'private probe retains ' + version);
  }
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
    if (url.startsWith(FIREBASE_ORIGIN)) return response(200, 'release-body', HTML_HEADERS);
    if (url.startsWith(PAGES_ORIGIN)) return response(200,
      pagesRound++ === 0 ? 'stale-body' : 'release-body', HTML_HEADERS);
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
      : response(200, 'release-body', HTML_HEADERS),
    approvedAssets:APPROVED, pagesAttempts:1, waitMs:0, wait:async () => {}
  }), /GitHub Pages live parity failed/);

  let networkAttempts = 0;
  const recovered = await verifyLiveDualHost(temp, {
    approvedAssets:APPROVED, pagesAttempts:2, waitMs:1, wait:async () => {},
    fetchImpl:async (url) => {
      const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
      if (PRIVATE_PROBES.includes(relative)) return response(404);
      if (url.startsWith(FIREBASE_ORIGIN)) return response(200, 'release-body', HTML_HEADERS);
      if (networkAttempts++ === 0) throw new Error('network down');
      return response(200, 'release-body', HTML_HEADERS);
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
        ? response(200, 'release-body', HTML_HEADERS) : response(200, 'stale-body', HTML_HEADERS);
    }
  }), /GitHub Pages live parity failed/);
  assert.equal(clock, 60_000);

  await assert.rejects(() => verifyLiveDualHost(temp, {
    approvedAssets:APPROVED, pagesAttempts:1, waitMs:0, wait:async () => {},
    fetchImpl:async (url) => {
      const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
      if (PRIVATE_PROBES.includes(relative)) return response(404);
      return response(200, 'release-body', { 'content-type':'application/octet-stream',
        'cache-control':'no-cache' });
    }
  }), /Firebase live parity failed/);

  const jsTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-live-js-mime-'));
  try {
    fs.writeFileSync(path.join(jsTemp, 'app.js'), 'release-body');
    fs.mkdirSync(path.join(jsTemp, '.firebase'));
    fs.writeFileSync(path.join(jsTemp, '.firebase', 'hosting..cache'), 'app.js,0,test\n');
    const pagesJavaScript = await inspectLiveOrigin(jsTemp, PAGES_ORIGIN, {
      approvedAssets:['app.js'], firebaseHosted:false,
      fetchImpl:async (url) => {
        const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
        if (PRIVATE_PROBES.includes(relative)) return response(404);
        return response(200, 'release-body', { 'content-type':'application/javascript; charset=utf-8' });
      }
    });
    assert.equal(pagesJavaScript.ok, true, 'GitHub Pages application/javascript is a valid exact MIME');
  } finally {
    fs.rmSync(jsTemp, { recursive:true, force:true });
  }

  const iconTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-live-icon-mime-'));
  try {
    fs.writeFileSync(path.join(iconTemp, 'favicon.ico'), 'icon-bytes');
    fs.mkdirSync(path.join(iconTemp, '.firebase'));
    fs.writeFileSync(path.join(iconTemp, '.firebase', 'hosting..cache'), 'favicon.ico,0,test\n');
    const pagesIcon = await inspectLiveOrigin(iconTemp, PAGES_ORIGIN, {
      approvedAssets:['favicon.ico'], firebaseHosted:false,
      fetchImpl:async (url) => {
        const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
        if (PRIVATE_PROBES.includes(relative)) return response(404);
        return response(200, 'icon-bytes', { 'content-type':'image/vnd.microsoft.icon' });
      }
    });
    assert.equal(pagesIcon.ok, true, 'GitHub Pages image/vnd.microsoft.icon is a valid exact MIME');
  } finally {
    fs.rmSync(iconTemp, { recursive:true, force:true });
  }

  await assert.rejects(() => verifyLiveDualHost(temp, {
    approvedAssets:APPROVED, pagesAttempts:1, waitMs:0, wait:async () => {},
    fetchImpl:async (url) => {
      const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
      if (PRIVATE_PROBES.includes(relative)) return response(404);
      return response(200, 'release-body', { 'content-type':'text/html-malicious',
        'cache-control':'public, x-no-cacheable' });
    }
  }), /Firebase live parity failed/);

  await assert.rejects(() => verifyLiveDualHost(temp, {
    approvedAssets:APPROVED, pagesAttempts:1, waitMs:0, wait:async () => {},
    fetchImpl:async (url) => {
      const relative = new URL(url).pathname.replace(/^\/ResQ-102\//, '').replace(/^\//, '');
      if (PRIVATE_PROBES.includes(relative)) return response(404);
      return response(200, 'release-body', { 'content-type':'text/html; charset=utf-8',
        'cache-control':'public, max-age=3600' });
    }
  }), /Firebase live parity failed/);
  console.log('Dual-host live parity: CDN retry, exact hash and private 404 checks PASS');
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}
