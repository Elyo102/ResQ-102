#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

await check('inventory finds storage.rules but keeps deployment unconfigured', () => {
  const inv = inventoryRepoArtifacts(ROOT);
  assert.ok(inv.present.includes('firestore.rules'));
  assert.equal(inv.hasStorageRulesInFirebase, false);
  assert.equal(inv.storageRulesBlocked, false);
  assert.match(fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8'), /allow read, write: if false/);
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
  const counts = report.steps.find((s) => s.name === 'compare_counts');
  assert.equal(counts.status, 'NOT_RUN');
  const sums = report.steps.find((s) => s.name === 'compare_checksums');
  assert.equal(sums.status, 'NOT_RUN');
  const local = report.steps.find((s) => s.name === 'local_bundle_restore_drill');
  assert.equal(local.status, 'NOT_RUN');
  assert.ok(report.ok, 'offline verify-only should not FAIL hard-deny/artifact steps');
  assert.equal(report.status, 'PASS');
});

await check('execute without emulator is INCOMPLETE and not ok', async () => {
  const report = await runFullDrill(
    parseArgs(['--target', 'resq-dr-demo', '--execute', '--confirm-target', 'resq-dr-demo']),
    {
      root: ROOT,
      env: { RESQ_RESTORE_TARGET_ALLOWLIST: 'resq-dr-demo', RESQ_RESTORE_SIGNING_KEY: 'x'.repeat(32) },
      writeReport: false
    }
  );
  assert.equal(report.ok, false);
  assert.equal(report.status, 'INCOMPLETE');
  assert.ok(report.requiredNotRun.includes('firestore_emulator_restore'));
  assert.ok(report.requiredNotRun.includes('rules_live_emulator'));
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

await check('execute with emulator adapters can PASS required stages', async () => {
  const report = await runFullDrill(
    parseArgs(['--target', 'resq-dr-demo', '--execute', '--confirm-target', 'resq-dr-demo']),
    {
      root: ROOT,
      env: {
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        RESQ_RESTORE_TARGET_ALLOWLIST: 'resq-dr-demo',
        RESQ_RESTORE_SIGNING_KEY: 'x'.repeat(32)
      },
      writeReport: false,
      expectedIntegrity: { count: 1, actualCount: 1, checksum: 'ab', actualChecksum: 'ab' },
      firestoreApi: { restoreDemo: async () => ({ ok: true }) },
      authApi: { importDemo: async () => ({ ok: true, claimsRestored: 0 }) },
      storageApi: { restoreDemo: async () => ({ ok: true }) },
      rulesRunner: async () => ({ ok: true, detail: 'fixture' })
    }
  );
  assert.equal(report.ok, true);
  assert.equal(report.status, 'PASS');
  assert.equal(report.steps.find((s) => s.name === 'firestore_emulator_restore').status, 'PASS');
  assert.equal(report.steps.find((s) => s.name === 'rules_live_emulator').status, 'PASS');
  assert.equal(report.steps.find((s) => s.name === 'compare_counts').status, 'PASS');
});

console.log('ops-dr-full-drill tests: ' + passed + ' PASS');
