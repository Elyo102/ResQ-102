import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const policy = require(path.join(root, 'functions', 'backup-policy.js'));
const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
const policySource = fs.readFileSync(
  path.join(root, 'functions', 'backup-policy.js'), 'utf8');

function stripStringsAndComments(line) {
  let out = '';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (!quote && ch === '/' && next === '/') break;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      out += ' ';
      continue;
    }
    if (ch === '\'' || ch === '"') {
      quote = ch;
      out += ' ';
    } else out += ch;
  }
  return out;
}

function joinPath(parent, child) {
  const clean = String(child).replace(/^\/+|\/+$/g, '');
  if (!parent || parent === 'databases/{database}/documents') return clean;
  return parent + '/' + clean;
}

function explicitRulePaths(source) {
  let depth = 0;
  const stack = [];
  const found = [];
  for (const originalLine of source.split(/\r?\n/)) {
    const line = stripStringsAndComments(originalLine);
    const match = line.match(/\bmatch\s+\/(.*?)\s*\{\s*$/);
    if (match) {
      const parent = stack.length ? stack[stack.length - 1].path : '';
      const full = joinPath(parent, match[1]);
      stack.push({ path:full, baseDepth:depth });
      if (full !== 'databases/{database}/documents' && full !== '{document=**}') {
        found.push(full);
      }
    }
    // Remove path placeholders before counting structural rule braces.
    const structural = line.replace(/\{[^{}\r\n]*\}/g, '');
    depth += (structural.match(/\{/g) || []).length;
    depth -= (structural.match(/\}/g) || []).length;
    while (stack.length && depth <= stack[stack.length - 1].baseDepth) stack.pop();
  }
  return found;
}

const rulePaths = explicitRulePaths(rules);
const manifestPaths = policy.DATA_POLICIES.map((item) => item.path);

assert.deepEqual(policy.validatePolicies(policy.DATA_POLICIES), [],
  'backup policy must be internally valid');
assert.equal(new Set(rulePaths).size, rulePaths.length,
  'each explicit Firestore match must resolve to one full path');
assert.deepEqual([...new Set(rulePaths)].sort(), [...new Set(manifestPaths)].sort(),
  'every explicit Firestore path must be classified exactly once');
assert.throws(() => assert.deepEqual(
  [...new Set(rulePaths)].sort(),
  [...new Set(manifestPaths.slice(1))].sort()
), 'the coverage gate must fail if one classified path is removed');

for (const forbiddenSource of [
  'firebase-admin', 'googleapis', 'fetch(', '.collection(', '.doc(',
  'STATION_ID', 'eilat_102'
]) {
  assert.equal(policySource.includes(forbiddenSource), false,
    `pure policy must not contain ${forbiddenSource}`);
}

const rootConfig = policy.getPolicy('config/{docId}');
const stationConfig = policy.getPolicy('stations/{sid}/config/{docId}');
assert.ok(rootConfig && stationConfig);
assert.notEqual(rootConfig.scope, stationConfig.scope,
  'root and station config must never collapse into one short collection name');

for (const forbidden of [
  'unlock_tokens/{token}', 'stations/{sid}/push_tokens/{uid}',
  'stations/{sid}/signatures/{uid}',
  'stations/{sid}/faults/{faultId}/photos/{photoId}',
  'stations/{sid}/documents/{docId}'
]) {
  assert.equal(policy.getPolicy(forbidden).humanReadable, 'forbidden', forbidden);
}

console.log(`✓ backup coverage: ${rulePaths.length} Firestore paths classified`);
