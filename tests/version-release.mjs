import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const EXPECTED_VERSION = '42G.1';
const EXPECTED_DATE = '4.9.2026';
const EXPECTED_VERSIONED_REFERENCES = 204; // +5 effective workdays: 4 screen imports + guards.js; effective-workdays.js → rotation.js (+1) replaces the guards.js → rotation.js import (−1).
const STATIC_URL = /(['"`])(\.\/[^'"`\s<>?]+\.(?:js|css)(?:\?[^'"`\s<>]*)?)\1/g;
const LEGITIMATE_UNVERSIONED = new Set([
  'pwa.js\0./firebase-messaging-sw.js',
  'push.js\0./firebase-messaging-sw.js',
  'signature.js\0./signflow.js'
]);

function clean(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function loadSnapshot() {
  const files = new Map();
  for (const name of fs.readdirSync(root)) {
    if (!/\.(?:html|js|json)$/.test(name)) continue;
    files.set(name, clean(fs.readFileSync(path.join(root, name), 'utf8')));
  }
  return files;
}

function releaseKey(version) {
  return String(version || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function audit(files) {
  const errors = [];
  let release;
  try {
    release = JSON.parse(files.get('version.json') || '');
  } catch (error) {
    return { errors: ['version.json is valid JSON: ' + error.message], count: 0 };
  }
  const keys = Object.keys(release).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['d', 'v'])) errors.push('version.json contains only v and d');
  if (release.v !== EXPECTED_VERSION) errors.push('version.json version is ' + EXPECTED_VERSION);
  if (release.d !== EXPECTED_DATE) errors.push('version.json date is ' + EXPECTED_DATE);

  const key = releaseKey(release.v);
  const versionSource = files.get('version.js') || '';
  const versionMatches = [...versionSource.matchAll(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]\s*;/g)];
  const dateMatches = [...versionSource.matchAll(/export\s+const\s+APP_DATE\s*=\s*['"]([^'"]+)['"]\s*;/g)];
  if (versionMatches.length !== 1 || versionMatches[0]?.[1] !== release.v) errors.push('version.js matches version.json exactly');
  if (dateMatches.length !== 1 || dateMatches[0]?.[1] !== release.d) errors.push('version.js date matches version.json exactly');

  const worker = files.get('firebase-messaging-sw.js') || '';
  const expectedCache = 'resq-v' + key + '-release1';
  const cacheMatches = [...worker.matchAll(/const\s+CACHE\s*=\s*['"]([^'"]+)['"]\s*;/g)];
  if (cacheMatches.length !== 1 || cacheMatches[0]?.[1] !== expectedCache) {
    errors.push('service-worker cache is exactly ' + expectedCache);
  }

  let count = 0;
  for (const [name, source] of files) {
    if (!/\.(?:html|js)$/.test(name) || name === 'firebase-messaging-sw.js') continue;
    STATIC_URL.lastIndex = 0;
    let match;
    while ((match = STATIC_URL.exec(source))) {
      const url = match[2];
      if (LEGITIMATE_UNVERSIONED.has(name + '\0' + url)) continue;
      const parsed = url.match(/^(\.\/[^?]+\.(?:js|css))\?v=([a-z0-9]+)$/i);
      if (!parsed) {
        errors.push(name + ': local static URL lacks the exact release query: ' + url);
        continue;
      }
      count += 1;
      if (parsed[2] !== key) errors.push(name + ': stale cache key in ' + url);
      const target = path.resolve(root, parsed[1].slice(2));
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        errors.push(name + ': static target does not exist: ' + parsed[1]);
      }
    }
  }
  if (count !== EXPECTED_VERSIONED_REFERENCES) {
    errors.push('versioned static reference count is ' + EXPECTED_VERSIONED_REFERENCES + ', got ' + count);
  }

  const faults = files.get('faults.html') || '';
  const vehicleBusinessUrl = "location.href = './vehicle.html?v=' + encodeURIComponent(v.id);";
  if (!faults.includes(vehicleBusinessUrl)) errors.push('vehicle business query remains an encoded vehicle id');
  return { errors, count };
}

function replaceExactlyOne(files, name, before, after) {
  const source = files.get(name);
  assert.equal(typeof source, 'string', 'mutation source exists: ' + name);
  assert.equal(source.split(before).length - 1, 1, 'mutation changes exactly one occurrence: ' + before);
  const clone = new Map(files);
  clone.set(name, source.replace(before, after));
  return clone;
}

function mustFail(label, files) {
  assert.ok(audit(files).errors.length > 0, label + ' is rejected');
}

const files = loadSnapshot();
const baseline = audit(files);
if (baseline.errors.length) {
  for (const error of baseline.errors) console.error('✗ ' + error);
  process.exit(1);
}

const key = releaseKey(EXPECTED_VERSION);
mustFail('version.json mutation', replaceExactlyOne(files, 'version.json', EXPECTED_VERSION, '42G.invalid'));
mustFail('release date mutation', replaceExactlyOne(files, 'version.json', EXPECTED_DATE, '1.1.2000'));
mustFail('version.js mutation', replaceExactlyOne(files, 'version.js', EXPECTED_VERSION, '42G.invalid'));
mustFail('service-worker cache mutation', replaceExactlyOne(files, 'firebase-messaging-sw.js',
  'resq-v' + key + '-release1', 'resq-vstale-release1'));
mustFail('stale JavaScript query', replaceExactlyOne(files, 'schedule-management.js',
  './firebase-config.js?v=' + key, './firebase-config.js?v=stale'));
mustFail('stale CSS query', replaceExactlyOne(files, 'schedule-management.html',
  './theme.css?v=' + key, './theme.css?v=stale'));
mustFail('missing query', replaceExactlyOne(files, 'schedule-management.html',
  './schedule-management.js?v=' + key, './schedule-management.js'));
mustFail('missing target', replaceExactlyOne(files, 'schedule-management.html',
  './schedule-management.js?v=' + key, './__missing-version-release__.js?v=' + key));
mustFail('vehicle business query mutation', replaceExactlyOne(files, 'faults.html',
  "location.href = './vehicle.html?v=' + encodeURIComponent(v.id);",
  "location.href = './vehicle.html?v=" + key + "';"));

console.log('Release version contract: ' + baseline.count + ' references; 9/9 mutations caught.');
