import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertOnlyFunctionsPredeployRemoved, makeFunctionsDeployConfig, parseArgs } from '../release-functions-once.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));

test('temporary deploy config removes only the already-validated Functions hook', () => {
  const projected = makeFunctionsDeployConfig(source);
  assert.equal('predeploy' in projected.functions[0], false);
  assertOnlyFunctionsPredeployRemoved(source, projected);
  const restored = structuredClone(projected);
  restored.functions[0].predeploy = source.functions[0].predeploy;
  assert.deepEqual(restored, source);
});

test('projection fails closed if the canonical full gate changes', () => {
  const changed = structuredClone(source);
  changed.functions[0].predeploy = ['npm --prefix tests run static'];
  assert.throws(() => makeFunctionsDeployConfig(changed), /unexpected Functions predeploy/);
});

test('projection detects any unrelated config mutation', () => {
  const projected = makeFunctionsDeployConfig(source);
  projected.hosting.public = 'other';
  assert.throws(() => assertOnlyFunctionsPredeployRemoved(source, projected), /changed more/);
});

test('production arguments require an exact project and full candidate SHA', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parseArgs(['--candidate', sha, '--project', 'station-102', '--execute']), { execute: true, project: 'station-102', candidate: sha });
  assert.throws(() => parseArgs(['--candidate', 'abc', '--project', 'station-102']), /40-character/);
  assert.throws(() => parseArgs(['--candidate', sha, '--project', 'demo-resq']), /station-102/);
});

test('firebase-functions is pinned and the v2 barrel import is absent', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'functions/package.json'), 'utf8'));
  const index = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8');
  assert.equal(pkg.dependencies['firebase-functions'], '7.4.0');
  assert.match(index, /firebase-functions\/v2\/options/);
  assert.doesNotMatch(index, /require\(['"]firebase-functions\/v2['"]\)/);
});

