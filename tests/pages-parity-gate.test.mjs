import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPublicParity, comparePublicTrees, hostingManifest } from './pages-parity-gate.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-pages-parity-'));
const source = path.join(temp, 'source');
const pages = path.join(temp, 'pages');
const APPROVED = Object.freeze(['app.js', 'index.html', 'vehicle-41/front.jpg'].sort());

function write(root, relative, value) {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive:true });
  fs.writeFileSync(file, value);
}

try {
  write(source, 'index.html', '<!doctype html><title>ResQ</title>');
  write(source, 'app.js', 'export const release = "test";');
  write(source, 'vehicle-41/front.jpg', 'synthetic-image');
  write(source, '.firebase/hosting..cache', [
    'index.html,hash-a', 'app.js,hash-b', 'vehicle-41/front.jpg,hash-c'
  ].join('\n'));
  for (const relative of ['index.html', 'app.js', 'vehicle-41/front.jpg']) {
    write(pages, relative, fs.readFileSync(path.join(source, ...relative.split('/'))));
  }
  write(pages, '.nojekyll', '');

  const baseline = assertPublicParity(source, pages, APPROVED);
  assert.equal(baseline.expected_count, 3);

  fs.rmSync(path.join(pages, 'app.js'));
  assert.deepEqual(comparePublicTrees(source, pages, APPROVED).missing, ['app.js']);
  write(pages, 'app.js', 'stale');
  assert.deepEqual(comparePublicTrees(source, pages, APPROVED).hash_mismatch, ['app.js']);
  write(pages, 'app.js', fs.readFileSync(path.join(source, 'app.js')));

  write(pages, 'unexpected.txt', 'public drift');
  assert.deepEqual(comparePublicTrees(source, pages, APPROVED).extra, ['unexpected.txt']);
  fs.rmSync(path.join(pages, 'unexpected.txt'));

  write(pages, 'functions/index.js', 'private');
  const leaked = comparePublicTrees(source, pages, APPROVED);
  assert.deepEqual(leaked.private_present, ['functions/index.js']);
  assert.ok(leaked.extra.includes('functions/index.js'));
  fs.rmSync(path.join(pages, 'functions'), { recursive:true, force:true });

  fs.rmSync(path.join(pages, '.nojekyll'));
  assert.deepEqual(comparePublicTrees(source, pages, APPROVED).missing, ['.nojekyll']);
  write(pages, '.nojekyll', 'must be empty');
  assert.equal(comparePublicTrees(source, pages, APPROVED).nojekyll_valid, false);
  fs.writeFileSync(path.join(pages, '.nojekyll'), '');

  write(source, 'firebase.emulator.42h13laug.json', '{}');
  fs.appendFileSync(path.join(source, '.firebase', 'hosting..cache'),
    '\nfirebase.emulator.42h13laug.json,private-hash');
  assert.throws(() => hostingManifest(source, APPROVED), /non-public path/);
  fs.rmSync(path.join(source, 'firebase.emulator.42h13laug.json'));
  fs.writeFileSync(path.join(source, '.firebase', 'hosting..cache'), [
    'index.html,hash-a', 'app.js,hash-b', 'vehicle-41/front.jpg,hash-c'
  ].join('\n'));

  write(source, 'roster-import.js', 'looks public but was not approved');
  fs.appendFileSync(path.join(source, '.firebase', 'hosting..cache'), '\nroster-import.js,hash-d');
  assert.throws(() => hostingManifest(source, APPROVED), /approved public asset inventory/);
  fs.rmSync(path.join(source, 'roster-import.js'));
  fs.writeFileSync(path.join(source, '.firebase', 'hosting..cache'), [
    'index.html,hash-a', 'app.js,hash-b', 'vehicle-41/front.jpg,hash-c'
  ].join('\n'));

  write(source, 'secret.json', '{}');
  fs.appendFileSync(path.join(source, '.firebase', 'hosting..cache'), '\nsecret.json,hash-e');
  assert.throws(() => hostingManifest(source, APPROVED), /approved public asset inventory/);
  fs.rmSync(path.join(source, 'secret.json'));
  fs.writeFileSync(path.join(source, '.firebase', 'hosting..cache'), [
    'index.html,hash-a', 'app.js,hash-b', 'vehicle-41/front.jpg,hash-c'
  ].join('\n'));

  fs.appendFileSync(path.join(source, '.firebase', 'hosting..cache'), '\n../index.html,escape');
  assert.throws(() => hostingManifest(source, APPROVED), /non-public path/);
  fs.writeFileSync(path.join(source, '.firebase', 'hosting..cache'), [
    'index.html,hash-a', 'app.js,hash-b', 'vehicle-41/front.jpg,hash-c'
  ].join('\n'));

  for (let index = 0; index < 50; index++) write(pages, 'extra-' + index + '.js', 'extra');
  assert.throws(() => assertPublicParity(source, pages, APPROVED), (error) =>
    error.message.includes('\"extra_count\":50') && error.message.length < 2500);
  for (let index = 0; index < 50; index++) fs.rmSync(path.join(pages, 'extra-' + index + '.js'));

  fs.writeFileSync(path.join(source, '.firebase', 'hosting..cache'), 'malformed-row');
  assert.throws(() => hostingManifest(source, APPROVED), /malformed row/);
  console.log('Public parity gate: exact tree, privacy grammar, bounded diagnostics and nojekyll checks PASS');
} finally {
  fs.rmSync(temp, { recursive:true, force:true });
}
