import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const callout = read('callout.js');
const runtime = read('functions/schedule-runtime.js');
const index = read('functions/index.js');
const stubPath = path.join(root, 'tests', 'stub', 'firebase-firestore.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    console.error('FAIL ' + name);
    throw error;
  }
}

function legacyUpdate(target, dottedPath, value) {
  const out = structuredClone(target);
  const parts = dottedPath.split('.');
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor[parts[i]] = cursor[parts[i]] || {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
  return out;
}

check('the old string update nests a dotted uid', () => {
  const doc = legacyUpdate({}, 'acks.user.name', { resp: 'coming' });
  assert.equal(Object.prototype.hasOwnProperty.call(doc.acks, 'user.name'), false);
  assert.equal(doc.acks.user.name.resp, 'coming');
});

check('callout imports FieldPath from the Firestore SDK', () => {
  assert.match(callout, /import\s*\{[^}]*\bFieldPath\b[^}]*\}/);
});

check('callout never constructs an acks dotted string path', () => {
  assert.doesNotMatch(callout, /['"]acks\.['"]\s*\+/);
});

check('callout writes the answer through a literal FieldPath', () => {
  assert.match(callout, /new FieldPath\(\s*['"]acks['"]\s*,\s*uid\s*\)/);
});

check('callout reader remains a flat uid lookup', () => {
  assert.match(callout, /acks\s*\[\s*uid\s*\]/);
});

check('guard signup is delegated by index to the schedule runtime', () => {
  const start = index.indexOf('exports.guardSignup =');
  const end = index.indexOf('exports.assignGuard =', start);
  assert.ok(start >= 0 && end > start);
  const wrapper = index.slice(start, end);
  assert.match(wrapper, /invokeSchedule\(\s*['"]signupGuard['"]\s*,\s*req\s*\)/);
  assert.doesNotMatch(wrapper, /signups\s*\./);
});

check('schedule runtime writes guard signups through a literal FieldPath', () => {
  assert.match(runtime, /new FieldPath\(\s*['"]signups['"]\s*,\s*ctx\.uid\s*\)/);
  assert.doesNotMatch(runtime, /['"]signups\.['"]\s*\+\s*ctx\.uid/);
});

const stub = await import(pathToFileURL(stubPath).href + '?uid-dot=' + Date.now());
check('browser stub exposes an SDK-compatible FieldPath shape', () => {
  const field = new stub.FieldPath('acks', 'user.name');
  assert.deepEqual(field.segments, ['acks', 'user.name']);
  assert.equal(field.isEqual(new stub.FieldPath('acks', 'user.name')), true);
  assert.equal(field.isEqual(new stub.FieldPath('acks', 'user', 'name')), false);
});

console.log('uid-dot probe: ' + passed + '/8 passed');
