#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  detectEmulator,
  hardDenyGuards,
  compareIdentityCounts,
  compareChecksums,
  inventoryRepoArtifacts,
  runFullDrill
} from '../ops-dr-full-drill.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0;
function check(name, fn) {
  const ret = fn();
  if (ret && typeof ret.then === 'function') {
    return ret.then(() => { console.log('PASS ' + name); passed++; });
  }
  console.log('PASS ' + name);
  passed++;
}

await check('parseArgs defaults to verify-friendly demo target', () => {
  const args = parseArgs([]);
  assert.equal(args.target, 'resq-dr-demo');
  assert.equal(args.verifyOnly, false);
  assert.equal(args.execute, false);
  assert.equal(args.createOnly, true);
  assert.throws(() => parseArgs(['--execute']), /confirm-target/);
  assert.throws(() => parseArgs(['--execute', '--confirm-target', 'x', '--target', 'resq-dr-demo']), /exactly match/);
  const ok = parseArgs(['--target', 'resq-dr-demo', '--execute', '--confirm-target', 'resq-dr-demo']);
  assert.equal(ok.execute, true);
});

await check('detectEmulator reports NOT available reason when unset', () => {
  const d = detectEmulator({});
  assert.equal(d.available, false);
  assert.match(d.reason, /FIRESTORE_EMULATOR_HOST/);
  const e = detectEmulator({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  assert.equal(e.available, true);
  assert.equal(e.host, '127.0.0.1:8080');
});

await check('hardDenyGuards keeps station-102 refused', () => {
  assert.throws(() => hardDenyGuards('station-102', { root: ROOT, env: {} }), /station-102|ייצור|סירוב|סורב|production/i);
  const g = hardDenyGuards('resq-dr-demo', { root: ROOT, env: { RESQ_RESTORE_TARGET_ALLOWLIST: 'station-102,resq-dr-demo' } });
  assert.ok(g.deny.includes('station-102'));
});

await check('compare helpers', () => {
  assert.equal(compareIdentityCounts(3, 3).ok, true);
  assert.equal(compareIdentityCounts(3, 2).ok, false);
  assert.equal(compareChecksums('abc', 'abc').ok, true);
  assert.equal(compareChecksums('abc', 'xyz').ok, false);
});

await check('inventory finds rules and blocked storage.rules', () => {
  const inv = inventoryRepoArtifacts(ROOT);
  assert.ok(inv.present.includes('firestore.rules'));
  assert.equal(inv.hasStorageRulesInFirebase, false);
  assert.equal(inv.storageRulesBlocked, true);
});

await check('verify-only drill marks emulator Rules NOT RUN without faking PASS', async () => {
  const report = await runFullDrill(parseArgs(['--verify-only', '--target', 'resq-dr-demo']), {
    root: ROOT,
    env: {},
    writeReport: false
  });
  assert.equal(report.rtoProven, false);
  assert.equal(report.rpoProven, false);
  const rules = report.steps.find((s) => s.name === 'rules_live_emulator');
  assert.ok(rules);
  assert.equal(rules.status, 'NOT_RUN');
  assert.match(rules.detail, /FIRESTORE_EMULATOR_HOST|not faked PASS/i);
  const fsStep = report.steps.find((s) => s.name === 'firestore_emulator_restore');
  assert.equal(fsStep.status, 'NOT_RUN');
  assert.ok(report.ok, 'offline verify-only should not FAIL hard-deny/artifact steps');
  assert.ok(report.rtoMeasuredMs >= 0);
});

await check('execute without signing key fails signing step', async () => {
  const report = await runFullDrill(
    parseArgs(['--target', 'resq-dr-demo', '--execute', '--confirm-target', 'resq-dr-demo']),
    { root: ROOT, env: { RESQ_RESTORE_TARGET_ALLOWLIST: 'resq-dr-demo' }, writeReport: false }
  );
  const sign = report.steps.find((s) => s.name === 'restore_signing_key');
  assert.equal(sign.status, 'FAIL');
  assert.equal(report.ok, false);
});

console.log('ops-dr-full-drill tests: ' + passed + ' PASS');
