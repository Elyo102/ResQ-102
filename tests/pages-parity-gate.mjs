import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PRIVATE_PATTERNS = Object.freeze([
  /(?:^|\/)(?:\.git|\.github|\.firebase|functions|tests|rules-test)(?:\/|$)/i,
  /(?:^|\/)(?:_דיונים|_מסירות|_מסירה-[^/]*|_ניטור|_גיבוי)(?:\/|$)/u,
  /(?:^|\/)\.(?!nojekyll$)/i,
  /(?:^|\/)(?:firebase(?:\..+)?|firestore(?:\..+)?)\.json$/i,
  /(?:^|\/)(?:credentials|token)\.json$/i,
  /(?:^|\/).*?(?:adminsdk|service[-_]?account).*$/i,
  /\.(?:mjs|md|txt|bat|ps1|log|rules|key|pem|zip|bundle|mbox|patch)$/i
]);
const PUBLIC_ROOT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html|js|css|json|png|jpe?g|ico|svg|webp)$/i;
const PUBLIC_VEHICLE_ASSET = /^vehicle-[A-Za-z0-9_-]+\/(?:front|rear|left|right)\.jpg$/i;
const DIAGNOSTIC_LIMIT = 20;
const PUBLIC_ASSETS = Object.freeze(JSON.parse(
  fs.readFileSync(new URL('./public-assets.json', import.meta.url), 'utf8')));

function normalizedRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

function safePublicPath(value) {
  const relative = normalizedRelative(value);
  return !!relative && relative.length <= 240 && !/[\u0000-\u001f\u007f\\]/.test(relative)
    && !relative.split('/').some((part) => !part || part === '.' || part === '..')
    && !PRIVATE_PATTERNS.some((pattern) => pattern.test(relative))
    && (PUBLIC_ROOT.test(relative) || PUBLIC_VEHICLE_ASSET.test(relative));
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function approvedInventory(approvedAssets) {
  if (!Array.isArray(approvedAssets) || !approvedAssets.length) {
    throw new Error('Approved public asset inventory is empty or invalid');
  }
  const normalized = approvedAssets.map(normalizedRelative);
  if (new Set(normalized).size !== normalized.length
      || normalized.some((relative) => !safePublicPath(relative))) {
    throw new Error('Approved public asset inventory contains duplicate or non-public paths');
  }
  return normalized.sort();
}

export function hostingManifest(sourceRoot, approvedAssets = PUBLIC_ASSETS) {
  const cachePath = path.join(sourceRoot, '.firebase', 'hosting..cache');
  if (!fs.existsSync(cachePath)) throw new Error('Firebase Hosting manifest is missing: ' + cachePath);
  const rows = fs.readFileSync(cachePath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (rows.some((line) => !line.includes(','))) throw new Error('Firebase Hosting manifest contains a malformed row');
  const entries = rows.map((line) => normalizedRelative(line.split(',', 1)[0]));
  if (!entries.length || new Set(entries).size !== entries.length) {
    throw new Error('Firebase Hosting manifest is empty or contains duplicate paths');
  }
  for (const relative of entries) {
    if (!safePublicPath(relative)) throw new Error('Hosting manifest contains a non-public path: ' + relative);
    const file = path.resolve(sourceRoot, ...relative.split('/'));
    const root = path.resolve(sourceRoot);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      throw new Error('Hosting manifest target is missing: ' + relative);
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Hosting manifest target is not a regular file: ' + relative);
    }
  }
  const sorted = entries.sort();
  const approved = approvedInventory(approvedAssets);
  if (sorted.length !== approved.length || sorted.some((item, index) => item !== approved[index])) {
    const missing = approved.filter((item) => !sorted.includes(item)).slice(0, DIAGNOSTIC_LIMIT);
    const extra = sorted.filter((item) => !approved.includes(item)).slice(0, DIAGNOSTIC_LIMIT);
    throw new Error('Hosting manifest differs from approved public asset inventory: '
      + JSON.stringify({ missing, extra }));
  }
  return sorted;
}

function pagesFiles(pagesRoot) {
  const root = path.resolve(pagesRoot);
  const found = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes:true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(folder, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Pages artifact contains a link: ' + path.relative(root, absolute));
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) found.push(normalizedRelative(path.relative(root, absolute)));
      else throw new Error('Pages artifact contains a non-regular entry: ' + path.relative(root, absolute));
    }
  }
  walk(root);
  return found.sort();
}

export function comparePublicTrees(sourceRoot, pagesRoot, approvedAssets = PUBLIC_ASSETS) {
  const expectedAssets = hostingManifest(sourceRoot, approvedAssets);
  const expected = [...expectedAssets, '.nojekyll'].sort();
  const actual = pagesFiles(pagesRoot);
  const missing = expected.filter((item) => !actual.includes(item));
  const extra = actual.filter((item) => !expected.includes(item));
  const hashMismatch = [];
  for (const relative of expectedAssets.filter((item) => actual.includes(item))) {
    if (digest(path.join(sourceRoot, ...relative.split('/')))
        !== digest(path.join(pagesRoot, ...relative.split('/')))) hashMismatch.push(relative);
  }
  const privatePresent = actual.filter((relative) =>
    relative !== '.nojekyll' && !safePublicPath(relative));
  const noJekyll = path.join(pagesRoot, '.nojekyll');
  const noJekyllValid = fs.existsSync(noJekyll)
    && fs.lstatSync(noJekyll).isFile()
    && !fs.lstatSync(noJekyll).isSymbolicLink()
    && fs.lstatSync(noJekyll).size === 0;
  return Object.freeze({ expected_count:expectedAssets.length, missing, extra, hash_mismatch:hashMismatch,
    private_present:privatePresent, nojekyll_valid:noJekyllValid,
    ok:!missing.length && !extra.length && !hashMismatch.length && !privatePresent.length && noJekyllValid });
}

export function assertPublicParity(sourceRoot, pagesRoot, approvedAssets = PUBLIC_ASSETS) {
  const result = comparePublicTrees(sourceRoot, pagesRoot, approvedAssets);
  if (!result.ok) {
    const bounded = {
      expected_count:result.expected_count,
      missing_count:result.missing.length, missing:result.missing.slice(0, DIAGNOSTIC_LIMIT),
      extra_count:result.extra.length, extra:result.extra.slice(0, DIAGNOSTIC_LIMIT),
      hash_mismatch_count:result.hash_mismatch.length,
      hash_mismatch:result.hash_mismatch.slice(0, DIAGNOSTIC_LIMIT),
      private_present_count:result.private_present.length,
      private_present:result.private_present.slice(0, DIAGNOSTIC_LIMIT),
      nojekyll_valid:result.nojekyll_valid
    };
    throw new Error('public release parity failed: ' + JSON.stringify(bounded));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const sourceRoot = process.argv[2];
  const pagesRoot = process.argv[3];
  if (!sourceRoot || !pagesRoot) {
    throw new Error('usage: node pages-parity-gate.mjs <firebase-release-root> <curated-pages-root>');
  }
  console.log('Public release parity PASS ' + JSON.stringify(assertPublicParity(sourceRoot, pagesRoot)));
}

export { PRIVATE_PATTERNS, PUBLIC_ASSETS, safePublicPath };
