import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CALENDAR_MANIFEST, createFixtureHarness, validateManifest, verifyClosure, sanitizeDiagnostic, classify } from './lib/mutation-fixture.mjs';
import { describeMutation } from './lib/mutation-ast.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const harness = createFixtureHarness(root);
const runtime = 'functions/schedule-runtime.js';
const target = 'functions/schedule-service.js';
const from = "    assertMay(ACTION.RUN_PLANNER, inp.actor);";
const source = fs.readFileSync(path.join(root, target), 'utf8');
const mutation = { target, ...describeMutation(source, source.replace(from, '')) };

test('closed manifest includes immutable runtime source, never a mutation target', () => {
  assert.equal(CALENDAR_MANIFEST.find(row => row.name === runtime).role, 'read-only-source');
  assert.equal(harness.hashes.length, 11);
  assert.throws(() => harness.withFixture({ target: runtime, from: 'a', to: 'b' }, () => {}), /MUTATION_TARGET/);
});
for (const name of ['../escape.js', '/escape.js', 'a/../escape.js', 'a//x.js', 'C:/x.js', 'a\\x.js']) test('manifest rejects path ' + name, () => {
  assert.throws(() => validateManifest([{ name, role: 'target' }]), /MANIFEST_PATH/);
});
test('manifest rejects duplicate and case-colliding files', () => {
  for (const name of ['a.js', 'A.js']) assert.throws(() => validateManifest([{ name: 'a.js', role: 'target' }, { name, role: 'suite' }]), /MANIFEST_PATH/);
});
test('missing read-only runtime dependency fails before child execution', () => {
  assert.throws(() => createFixtureHarness(root, CALENDAR_MANIFEST.filter(row => row.name !== runtime)), /MUTATION_READ_UNRESOLVED/);
});
test('closure refuses dynamic require, missing literal import and support execution', () => {
  for (const source of ['require(variable)', 'import "./missing.js"', 'require("./runtime.js")']) {
    assert.throws(() => verifyClosure([{ name: 'a.js', role: 'suite', bytes: Buffer.from(source) },
      { name: 'runtime.js', role: 'read-only-source', bytes: Buffer.from('') }]), /MUTATION_READ_UNRESOLVED/);
  }
});
test('each fixture is fresh, copies bytes exactly and cleans on success', () => {
  const directories = [];
  for (let i = 0; i < 2; i++) harness.withFixture(null, directory => {
    directories.push(directory);
    for (const row of CALENDAR_MANIFEST) {
      if (row.role === 'parent-data') assert.equal(fs.existsSync(path.join(directory, row.name)), false);
      else assert.deepEqual(fs.readFileSync(path.join(directory, row.name)), fs.readFileSync(path.join(root, row.name)));
    }
  });
  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) assert.equal(fs.existsSync(directory), false);
});
test('only the declared target changes; all support and active source bytes stay identical', () => {
  const before = fs.readFileSync(path.join(root, target));
  harness.withFixture(mutation, directory => {
    const changed = CALENDAR_MANIFEST.filter(row => row.role !== 'parent-data' && !fs.readFileSync(path.join(directory, row.name)).equals(fs.readFileSync(path.join(root, row.name))));
    assert.deepEqual(changed.map(row => row.name), [target]);
    assert.equal(fs.readFileSync(path.join(directory, target), 'utf8').includes(from), false);
  });
  assert.deepEqual(fs.readFileSync(path.join(root, target)), before);
});
test('unknown, missing and no-op mutation requests cannot pass', () => {
  for (const mutation of [{ target: 'missing.js', from, to: '' }, { target, from: 'NO_MATCH', to: '' }, { target, from, to: from }])
    assert.throws(() => harness.withFixture(mutation, () => {}), /MUTATION_/);
});
test('support tamper and unexpected file are detected after child and cleaned', () => {
  for (const attack of [directory => fs.appendFileSync(path.join(directory, runtime), 'tamper'), directory => fs.writeFileSync(path.join(directory, 'extra.js'), '')]) {
    let captured;
    assert.throws(() => harness.withFixture(null, directory => { captured = directory; attack(directory); }), /DESTINATION_/);
    assert.equal(fs.existsSync(captured), false);
  }
});
test('thrown operation still cleans only its own fixture', () => {
  let captured;
  assert.throws(() => harness.withFixture(null, directory => { captured = directory; throw Error('operation'); }), /operation/);
  assert.equal(fs.existsSync(captured), false);
  assert.ok(fs.existsSync(path.join(root, runtime)));
});
test('junction or symlink fixture sources are rejected before reading', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-fixture-proof-'));
  const link = path.join(temporary, 'alias');
  try {
    fs.symlinkSync(path.join(root, 'functions'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createFixtureHarness(temporary, [{ name: 'alias/schedule-runtime.js', role: 'read-only-source' }]), /PATH_ALIAS/);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmdirSync(temporary);
  }
});
test('diagnostics redact secrets, email, paths, URL queries and workflow commands', () => {
  const diagnostic = sanitizeDiagnostic('\x1b[31mBearer sensitive-value\napi_key=other-secret\nhello@example.com\nC:\\private\\vault.txt\n/tmp/private/key\nhttps://example.com/?token=secret\n::error::payload\n?password=hidden');
  for (const hidden of ['sensitive-value', 'other-secret', 'hello@example', 'vault', '/tmp/', 'example.com', 'payload', 'hidden', '\x1b']) assert.ok(!diagnostic.includes(hidden));
  assert.ok(sanitizeDiagnostic('x'.repeat(2000)).endsWith('[truncated]'));
});
test('result classification never counts timeout, signal or spawn error as assertion failure', () => {
  for (const [value, expected] of [[{ status: 0 }, 'pass'], [{ status: 1 }, 'exit'], [{ status: null, signal: 'SIGTERM' }, 'signal'],
    [{ error: { code: 'ETIMEDOUT' } }, 'timeout'], [{ error: { code: 'ENOENT' } }, 'spawn'], [{}, 'unknown']]) assert.equal(classify(value).category, expected);
});
test('actual isolated service baseline succeeds with the exact runtime support copy', () => {
  const result = harness.run('functions/schedule-service.integration.test.js');
  assert.equal(result.category, 'pass', JSON.stringify(result));
});
