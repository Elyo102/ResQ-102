#!/usr/bin/env node
// Firestore rules predeploy gate — static only, never deploys.
// Mirrors the hosting predeploy idea: refuse deploy packaging when
// firestore.rules / indexes are missing or the static rulecheck fails.
// Invoked from firebase.json firestore.predeploy.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let passed = 0;

function check(ok, label) {
  console.log((ok ? '✓ ' : '✗ ') + label);
  if (ok) passed += 1;
  else failed += 1;
}

const rulesPath = path.join(ROOT, 'firestore.rules');
const indexesPath = path.join(ROOT, 'firestore.indexes.json');
const firebasePath = path.join(ROOT, 'firebase.json');

check(fs.existsSync(rulesPath), 'firestore.rules exists');
check(fs.existsSync(indexesPath), 'firestore.indexes.json exists');

const firebase = JSON.parse(fs.readFileSync(firebasePath, 'utf8'));
check(!!firebase.firestore, 'firebase.json has firestore block');
check(firebase.firestore && firebase.firestore.rules === 'firestore.rules', 'firestore.rules path wired');
check(firebase.firestore && firebase.firestore.indexes === 'firestore.indexes.json', 'indexes path wired');

const pre = (firebase.firestore && firebase.firestore.predeploy) || [];
check(Array.isArray(pre) && pre.some((c) => String(c).includes('firestore-predeploy-gate')),
  'firestore.predeploy includes this gate (no deploy performed here)');

check(!(firebase.storage && firebase.storage.rules),
  'storage.rules is not wired in firebase.json (remains BLOCKED)');

const rules = fs.readFileSync(rulesPath, 'utf8');
check(rules.includes('rules_version'), 'rules_version present');
check(rules.length > 100, 'rules file is non-trivial');

const indexes = JSON.parse(fs.readFileSync(indexesPath, 'utf8'));
check(indexes && Array.isArray(indexes.indexes), 'indexes.indexes is an array');

// Reuse static rulecheck — still not a live Rules engine / emulator run.
const rulecheck = path.join(ROOT, 'tests', 'rulecheck.mjs');
check(fs.existsSync(rulecheck), 'tests/rulecheck.mjs present for static analysis');
if (fs.existsSync(rulecheck)) {
  const run = spawnSync(process.execPath, [rulecheck], { cwd: ROOT, encoding: 'utf8' });
  check(run.status === 0, 'static rulecheck.mjs exits 0 (not an emulator Rules PASS)');
  if (run.status !== 0) {
    console.log(run.stdout || '');
    console.error(run.stderr || '');
  }
}

console.log('firestore-predeploy-gate: ' + passed + ' PASS, ' + failed + ' FAIL (no deploy)');
if (failed) process.exit(1);
