import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hostingManifest } from './pages-parity-gate.mjs';

const FIREBASE_ORIGIN = 'https://station-102.web.app';
const PAGES_ORIGIN = 'https://elyo102.github.io/ResQ-102';
const PRIVATE_PROBES = Object.freeze([
  'firebase.json', 'firestore.rules', 'firestore.indexes.json',
  'firebase.emulator.42h16.json', 'firebase.emulator.42h18.json',
  '.env.production', 'credentials.json',
  'service-account.json', 'functions/index.js', 'tests/package.json',
  'rules-test/package.json', '.git/HEAD', '.firebase/hosting..cache'
]);
const SAMPLE_LIMIT = 20;
const CONTENT_TYPES = Object.freeze({
  '.css':Object.freeze(['text/css']), '.html':Object.freeze(['text/html']),
  '.ico':Object.freeze(['image/x-icon', 'image/vnd.microsoft.icon']), '.jpg':Object.freeze(['image/jpeg']),
  '.js':Object.freeze(['text/javascript', 'application/javascript']),
  '.json':Object.freeze(['application/json']), '.png':Object.freeze(['image/png']),
  '.mp3':Object.freeze(['audio/mpeg'])
});

function headerValue(response, name) {
  return String(response && response.headers && typeof response.headers.get === 'function'
    ? response.headers.get(name) || '' : '').toLowerCase();
}

function mediaType(response) {
  return headerValue(response, 'content-type').split(';', 1)[0].trim();
}

function cacheDirectives(response) {
  return new Set(headerValue(response, 'cache-control').split(',')
    .map((part) => part.trim().split('=', 1)[0]).filter(Boolean));
}

function validateHeaders(relative, response, firebaseHosted) {
  const failures = [];
  const extension = path.extname(relative).toLowerCase();
  const expectedTypes = CONTENT_TYPES[extension];
  const actualType = mediaType(response);
  if (!expectedTypes || !expectedTypes.includes(actualType)) failures.push('content-type');
  if (!firebaseHosted) return failures;
  const cache = cacheDirectives(response);
  if (relative === 'version.json' || relative === 'firebase-messaging-sw.js') {
    for (const directive of ['no-cache', 'no-store', 'must-revalidate']) {
      if (!cache.has(directive)) failures.push('cache-control-' + directive);
    }
  } else if (['.html', '.js', '.css'].includes(extension) && !cache.has('no-cache')) {
    failures.push('cache-control-no-cache');
  }
  return failures;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchBounded(fetchImpl, url, timeoutMs) {
  return fetchImpl(url, {
    signal:AbortSignal.timeout(Math.max(1, timeoutMs)),
    headers:{ 'Cache-Control':'no-cache' }
  });
}

export async function inspectLiveOrigin(sourceRoot, origin, options = {}) {
  if (typeof options === 'function') options = { fetchImpl:options };
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const deadlineMs = Number.isFinite(options.deadlineMs) ? options.deadlineMs : now() + 10 * 60_000;
  const perRequestMaxMs = Number.isSafeInteger(options.perRequestMaxMs) ? options.perRequestMaxMs : 15_000;
  const assets = hostingManifest(sourceRoot, options.approvedAssets);
  const firebaseHosted = options.firebaseHosted !== undefined
    ? options.firebaseHosted : !origin.startsWith(PAGES_ORIGIN);
  const failures = [];
  const checks = [
    ...assets.map((relative) => ({ relative, privateProbe:false })),
    ...PRIVATE_PROBES.map((relative) => ({ relative, privateProbe:true }))
  ];
  for (let index = 0; index < checks.length; index += 12) {
    const remaining = deadlineMs - now();
    if (remaining <= 0) {
      failures.push('verification:deadline');
      break;
    }
    await Promise.all(checks.slice(index, index + 12).map(async ({ relative, privateProbe }) => {
      try {
        const timeoutMs = Math.min(perRequestMaxMs, Math.max(1, deadlineMs - now()));
        const query = privateProbe ? 'private_verify=' : 'release_verify=';
        const response = await fetchBounded(fetchImpl,
          origin + '/' + relative + '?' + query + now(), timeoutMs);
        const expectedStatus = privateProbe ? 404 : 200;
        if (response.status !== expectedStatus) {
          failures.push(relative + ':' + (privateProbe ? 'private-http-' : 'http-') + response.status);
          return;
        }
        if (!privateProbe) {
          for (const headerFailure of validateHeaders(relative, response, firebaseHosted)) {
            failures.push(relative + ':' + headerFailure);
          }
          const live = new Uint8Array(await response.arrayBuffer());
          const local = fs.readFileSync(path.join(sourceRoot, ...relative.split('/')));
          if (sha(live) !== sha(local)) failures.push(relative + ':hash');
        }
      } catch (error) {
        failures.push(relative + ':' + (now() >= deadlineMs ? 'deadline' : 'network'));
      }
    }));
  }
  return Object.freeze({ origin, asset_count:assets.length, failure_count:failures.length,
    failures:failures.slice(0, SAMPLE_LIMIT), ok:failures.length === 0 });
}

export async function verifyLiveDualHost(sourceRoot, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = Number.isSafeInteger(options.pagesAttempts) ? options.pagesAttempts : 21;
  const waitMs = Number.isSafeInteger(options.waitMs) ? options.waitMs : 30_000;
  const now = options.now || Date.now;
  const maxDurationMs = Number.isSafeInteger(options.maxDurationMs) ? options.maxDurationMs : 10 * 60_000;
  const deadlineMs = now() + maxDurationMs;
  const inspectOptions = {
    fetchImpl, now, deadlineMs,
    perRequestMaxMs:options.perRequestMaxMs,
    approvedAssets:options.approvedAssets
  };
  const firebase = await inspectLiveOrigin(sourceRoot, FIREBASE_ORIGIN,
    { ...inspectOptions, firebaseHosted:true });
  if (!firebase.ok) throw new Error('Firebase live parity failed: ' + JSON.stringify(firebase));
  let pages;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (now() >= deadlineMs) break;
    pages = await inspectLiveOrigin(sourceRoot, PAGES_ORIGIN,
      { ...inspectOptions, firebaseHosted:false });
    if (pages.ok) return Object.freeze({ firebase, pages, pages_attempts:attempt });
    if (attempt < attempts) {
      const remaining = deadlineMs - now();
      if (remaining <= 0) break;
      await wait(Math.min(waitMs, remaining));
    }
  }
  throw new Error('GitHub Pages live parity failed after propagation window: '
    + JSON.stringify(pages || { ok:false, failures:['verification:deadline'] }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sourceRoot = process.argv[2];
  const previewOrigin = process.argv[3];
  if (!sourceRoot) throw new Error('usage: node pages-live-parity.mjs <firebase-release-root> [preview-origin]');
  if (previewOrigin) {
    const preview = await inspectLiveOrigin(sourceRoot, previewOrigin, { firebaseHosted:true });
    if (!preview.ok) throw new Error('Preview parity failed: ' + JSON.stringify(preview));
    console.log('Preview parity PASS ' + JSON.stringify(preview));
  } else {
    console.log('Dual-host live parity PASS ' + JSON.stringify(await verifyLiveDualHost(sourceRoot)));
  }
}

export { FIREBASE_ORIGIN, PAGES_ORIGIN, PRIVATE_PROBES };
