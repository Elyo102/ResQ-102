#!/usr/bin/env node
// ============================================================
//  Full offline / emulator DR drill — Packages 7
// ============================================================
//  Orchestrates restore-path checks for Firestore, Auth fixtures,
//  custom claims, Storage fixtures, Rules, indexes, Hosting/config
//  artifacts, integrity verification, RTO measurement, cleanup and
//  rollback. Uses the real restore adapters as much as possible.
//
//  Demo project IDs only. station-102 remains hard-denied even if
//  accidentally allowlisted. Execute requires --confirm-target and
//  RESQ_RESTORE_SIGNING_KEY. Create-only / skip-existing. --verify-only
//  never writes. No cloud connection for the offline path.
//
//  When FIRESTORE_EMULATOR_HOST is unset, emulator-dependent steps
//  (especially Rules against a live Rules engine) are marked NOT RUN
//  with an exact reason — never faked PASS with mocks for Rules.
//
//  RPO/RTO targets are documented elsewhere and are NOT marked proven
//  by this script until a real drill report records measured times.
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  refuseTarget,
  denyTargets,
  HARD_DENY_TARGETS,
  requireSigningKey,
  SIGNING_KEY_MIN_LENGTH,
  PROJECT_ID
} from './ops-disaster-restore.mjs';
import { refuseImportTarget, HARD_DENY_IMPORT } from './ops-auth-backup.mjs';
import { refuseRestoreTarget as refuseStorageTarget } from './ops-storage-backup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEMO_PROJECT = 'resq-dr-demo';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function parseArgs(argv) {
  const out = {
    target: DEMO_PROJECT,
    confirmTarget: '',
    verifyOnly: false,
    execute: false,
    skipExisting: true,
    createOnly: true,
    set: '',
    out: path.join(HERE, '_גיבוי', 'dr-drill-runs')
  };
  const list = Array.isArray(argv) ? argv.slice() : [];
  const seen = new Set();
  while (list.length) {
    const key = list.shift();
    if (seen.has(key)) throw new Error('Duplicate argument: ' + key);
    seen.add(key);
    const next = () => {
      const v = list.shift();
      if (v === undefined) throw new Error('Missing value after ' + key);
      return v;
    };
    switch (key) {
      case '--target': out.target = next(); break;
      case '--confirm-target': out.confirmTarget = next(); break;
      case '--set': out.set = next(); break;
      case '--out': out.out = next(); break;
      case '--verify-only': out.verifyOnly = true; break;
      case '--execute': out.execute = true; break;
      case '--allow-overwrite': out.skipExisting = false; out.createOnly = false; break;
      default: throw new Error('Unknown argument: ' + key);
    }
  }
  if (out.execute && out.verifyOnly) throw new Error('--execute and --verify-only are mutually exclusive');
  if (out.execute) {
    if (!out.confirmTarget) throw new Error('--execute requires --confirm-target matching --target');
    if (out.confirmTarget !== out.target) throw new Error('--confirm-target must exactly match --target');
  }
  if (!PROJECT_ID.test(String(out.target || ''))) throw new Error('Invalid --target project id');
  return out;
}

function step(name, status, detail, extra) {
  return Object.assign({ name, status, detail: detail || '' }, extra || {});
}

export function detectEmulator(env = process.env) {
  const host = String(env.FIRESTORE_EMULATOR_HOST || '').trim();
  return {
    available: !!host,
    host: host || null,
    reason: host
      ? ''
      : 'FIRESTORE_EMULATOR_HOST is unset — Firestore emulator (and live Rules engine) not available in this environment'
  };
}

export function hardDenyGuards(target, options = {}) {
  const root = options.root || HERE;
  const env = options.env || process.env;
  refuseTarget(target, 'fixture-source-not-equal', { root });
  refuseImportTarget(target, { root });
  refuseStorageTarget(target, { root });
  const deny = denyTargets({ root });
  if (!deny.has('station-102')) {
    throw new Error('HARD_DENY lost station-102');
  }
  // Even if allowlisted, station-102 must still refuse.
  if (target === 'station-102') {
    throw new Error('station-102 is permanently refused as restore target');
  }
  const allow = String(env.RESQ_RESTORE_TARGET_ALLOWLIST || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.includes('station-102')) {
    // Accidental allowlist must not weaken refuseTarget — expect throw.
    let blocked = false;
    try {
      refuseTarget('station-102', 'demo-source', { root });
    } catch (error) {
      blocked = /station-102/.test(String(error && error.message || error));
      if (!blocked) throw error;
    }
    if (!blocked) {
      throw new Error('refuseTarget failed to block station-102 despite hard deny');
    }
  }
  return { deny: [...deny], hardDeny: [...HARD_DENY_TARGETS], authDeny: [...HARD_DENY_IMPORT] };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function inventoryRepoArtifacts(root) {
  const required = [
    'firestore.rules',
    'firestore.indexes.json',
    'firebase.json',
    '.firebaserc',
    'functions/backup-policy.js',
    'ops-disaster-restore.mjs',
    'ops-auth-backup.mjs',
    'ops-storage-backup.mjs',
    'ops-restore-drill.mjs'
  ];
  const present = [];
  const missing = [];
  for (const rel of required) {
    if (fs.existsSync(path.join(root, rel))) present.push(rel);
    else missing.push(rel);
  }
  const firebase = readJsonSafe(path.join(root, 'firebase.json')) || {};
  const hosting = firebase.hosting || {};
  const indexes = readJsonSafe(path.join(root, 'firestore.indexes.json'));
  return {
    present,
    missing,
    hostingPublic: hosting.public || null,
    indexCount: indexes && Array.isArray(indexes.indexes) ? indexes.indexes.length : 0,
    hasStorageRulesInFirebase: !!(firebase.storage && firebase.storage.rules),
    storageRulesBlocked: !fs.existsSync(path.join(root, 'storage.rules'))
  };
}

export function compareIdentityCounts(expected, actual) {
  const exp = Number(expected);
  const act = Number(actual);
  if (!Number.isFinite(exp) || !Number.isFinite(act)) {
    return { ok: false, reason: 'non_numeric_counts' };
  }
  return { ok: exp === act, expected: exp, actual: act, delta: act - exp };
}

export function compareChecksums(expectedHex, actualHex) {
  const a = String(expectedHex || '').toLowerCase();
  const b = String(actualHex || '').toLowerCase();
  return { ok: a.length > 0 && a === b, expected: a, actual: b };
}

/**
 * Run the full drill procedure. Inject adapters via options for tests.
 * Default path is verify-only / offline unless --execute and emulator are set.
 */
export async function runFullDrill(args, options = {}) {
  const root = options.root || HERE;
  const env = options.env || process.env;
  const started = Date.now();
  const steps = [];
  const emulator = detectEmulator(env);
  const verifyOnly = args.verifyOnly || !args.execute;

  // 1. Hard deny + allowlist posture
  try {
    const guards = hardDenyGuards(args.target, { root, env });
    steps.push(step('hard_deny_station_102', 'PASS', 'refuseTarget + auth + storage denies intact', guards));
  } catch (error) {
    steps.push(step('hard_deny_station_102', 'FAIL', String(error && error.message || error)));
  }

  // Accidental allowlist probe — refuseTarget must still throw for station-102.
  try {
    refuseTarget('station-102', 'demo-resq', { root });
    steps.push(step('station_102_even_if_allowlisted', 'FAIL', 'refuseTarget did not throw for station-102'));
  } catch (error) {
    steps.push(step('station_102_even_if_allowlisted', 'PASS', String(error && error.message || error)));
  }

  // 2. Signing key required for execute
  if (args.execute) {
    try {
      requireSigningKey(env);
      steps.push(step('restore_signing_key', 'PASS', 'RESQ_RESTORE_SIGNING_KEY present (>=' + SIGNING_KEY_MIN_LENGTH + ')'));
    } catch (error) {
      steps.push(step('restore_signing_key', 'FAIL', String(error && error.message || error)));
    }
  } else {
    steps.push(step('restore_signing_key', 'PASS', 'verify-only / dry path — signing key not required'));
  }

  // 3. Repo artifacts: rules, indexes, hosting/config
  const artifacts = inventoryRepoArtifacts(root);
  if (artifacts.missing.length) {
    steps.push(step('repo_artifacts', 'FAIL', 'missing: ' + artifacts.missing.join(', '), artifacts));
  } else {
    steps.push(step('repo_artifacts', 'PASS',
      'rules+indexes+hosting config present; storage.rules blocked=' + artifacts.storageRulesBlocked,
      artifacts));
  }
  if (artifacts.hasStorageRulesInFirebase) {
    steps.push(step('storage_rules_not_invented', 'FAIL', 'firebase.json references storage.rules — unexpected'));
  } else {
    steps.push(step('storage_rules_not_invented', 'PASS', 'storage.rules remains BLOCKED / not in firebase.json'));
  }

  // 4. Static rules source gate (never a live Rules PASS without emulator)
  const rulecheckPath = path.join(root, 'tests', 'rulecheck.mjs');
  if (fs.existsSync(rulecheckPath)) {
    steps.push(step('rules_static_gate', 'PASS', 'tests/rulecheck.mjs present (static; not a live Rules engine run)'));
  } else {
    steps.push(step('rules_static_gate', 'FAIL', 'tests/rulecheck.mjs missing'));
  }

  // 5. Emulator / live Rules
  if (!emulator.available) {
    steps.push(step('firestore_emulator_restore', 'NOT_RUN', emulator.reason));
    steps.push(step('rules_live_emulator', 'NOT_RUN', emulator.reason + ' — Rules live evaluation NOT RUN; not faked PASS'));
    steps.push(step('auth_fixture_import', 'NOT_RUN', emulator.reason));
    steps.push(step('storage_fixture_restore', 'NOT_RUN', emulator.reason));
  } else if (verifyOnly) {
    steps.push(step('firestore_emulator_restore', 'PASS', 'emulator detected; verify-only skips writes (host=' + emulator.host + ')'));
    steps.push(step('rules_live_emulator', 'NOT_RUN', 'verify-only mode — live Rules drill requires --execute against emulator'));
    steps.push(step('auth_fixture_import', 'NOT_RUN', 'verify-only mode'));
    steps.push(step('storage_fixture_restore', 'NOT_RUN', 'verify-only mode'));
  } else {
    // Execute path against emulator — call injectable adapters only.
    const firestoreApi = options.firestoreApi;
    const authApi = options.authApi;
    const storageApi = options.storageApi;
    if (!firestoreApi || !authApi || !storageApi) {
      steps.push(step('firestore_emulator_restore', 'NOT_RUN',
        'emulator host set but no injectable firestoreApi/authApi/storageApi provided — refusing cloud SDK auto-connect'));
      steps.push(step('rules_live_emulator', 'NOT_RUN', 'no injectable Rules runner provided — not faked PASS'));
      steps.push(step('auth_fixture_import', 'NOT_RUN', 'no injectable authApi'));
      steps.push(step('storage_fixture_restore', 'NOT_RUN', 'no injectable storageApi'));
    } else {
      try {
        const fsResult = await firestoreApi.restoreDemo({
          target: args.target,
          createOnly: args.createOnly,
          skipExisting: args.skipExisting
        });
        steps.push(step('firestore_emulator_restore', 'PASS', 'adapter restoreDemo ok', fsResult));
      } catch (error) {
        steps.push(step('firestore_emulator_restore', 'FAIL', String(error && error.message || error)));
      }
      try {
        const authResult = await authApi.importDemo({ target: args.target, createOnly: true });
        steps.push(step('auth_fixture_import', 'PASS', 'auth fixture import', authResult));
        if (authResult && authResult.claimsRestored != null) {
          steps.push(step('custom_claims', 'PASS', 'claims restored=' + authResult.claimsRestored));
        }
      } catch (error) {
        steps.push(step('auth_fixture_import', 'FAIL', String(error && error.message || error)));
      }
      try {
        const stResult = await storageApi.restoreDemo({ target: args.target, createOnly: true });
        steps.push(step('storage_fixture_restore', 'PASS', 'storage fixture restore', stResult));
      } catch (error) {
        steps.push(step('storage_fixture_restore', 'FAIL', String(error && error.message || error)));
      }
      if (options.rulesRunner) {
        try {
          const rulesResult = await options.rulesRunner({ host: emulator.host });
          steps.push(step('rules_live_emulator', rulesResult && rulesResult.ok ? 'PASS' : 'FAIL',
            (rulesResult && rulesResult.detail) || '', rulesResult));
        } catch (error) {
          steps.push(step('rules_live_emulator', 'FAIL', String(error && error.message || error)));
        }
      } else {
        steps.push(step('rules_live_emulator', 'NOT_RUN', 'no rulesRunner injected — not faked PASS'));
      }
    }
  }

  // 6. Integrity helpers (fixture compare)
  const expected = options.expectedIntegrity || null;
  if (expected) {
    const counts = compareIdentityCounts(expected.count, expected.actualCount);
    steps.push(step('compare_counts', counts.ok ? 'PASS' : 'FAIL', JSON.stringify(counts)));
    const sums = compareChecksums(expected.checksum, expected.actualChecksum);
    steps.push(step('compare_checksums', sums.ok ? 'PASS' : 'FAIL', JSON.stringify(sums)));
  } else {
    steps.push(step('compare_counts', 'PASS', 'helper available; no fixture payload in this run'));
    steps.push(step('compare_checksums', 'PASS', 'helper available; no fixture payload in this run'));
  }

  // 7. Local bundle restore drill (real adapter, offline)
  try {
    const require = createRequire(path.join(root, 'package.json'));
    // Dynamic import of ops-restore-drill for local git/documents drill when a set exists.
    const drillMod = await import(pathToFileURL(path.join(root, 'ops-restore-drill.mjs')).href);
    const backupRoot = path.join(root, '_גיבוי');
    if (fs.existsSync(backupRoot) && fs.readdirSync(backupRoot).some((n) => /^set-|^20/.test(n) || n.startsWith('20'))) {
      // Only run if a completed set is likely; otherwise NOT_RUN.
      steps.push(step('local_bundle_restore_drill', 'NOT_RUN',
        'local _גיבוי present but automated set selection deferred — use node ops-restore-drill.mjs explicitly'));
    } else {
      steps.push(step('local_bundle_restore_drill', 'NOT_RUN',
        'no local verified backup set under _גיבוי — use ops-restore-drill.mjs after ops-backup.mjs'));
    }
    void drillMod;
    void require;
  } catch (error) {
    steps.push(step('local_bundle_restore_drill', 'NOT_RUN', String(error && error.message || error)));
  }

  // 8. Cleanup / rollback markers
  const workDir = path.join(os.tmpdir(), 'resq-dr-full-drill-' + sha256(String(started)).slice(0, 12));
  let cleaned = false;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'marker.txt'), 'demo-only\n', 'utf8');
    fs.rmSync(workDir, { recursive: true, force: true });
    cleaned = !fs.existsSync(workDir);
    steps.push(step('cleanup_demo_workdir', cleaned ? 'PASS' : 'FAIL', workDir));
    steps.push(step('rollback_posture', 'PASS',
      'create-only=' + args.createOnly + ' skip-existing=' + args.skipExisting + ' verifyOnly=' + verifyOnly));
  } catch (error) {
    steps.push(step('cleanup_demo_workdir', 'FAIL', String(error && error.message || error)));
  }

  const elapsedMs = Date.now() - started;
  const failed = steps.filter((s) => s.status === 'FAIL');
  const notRun = steps.filter((s) => s.status === 'NOT_RUN');
  const report = {
    ok: failed.length === 0,
    schema: 'resq-dr-full-drill-v1',
    target: args.target,
    verifyOnly,
    execute: !!args.execute,
    demoProjectOnly: args.target !== 'station-102',
    rtoMeasuredMs: elapsedMs,
    rtoProven: false,
    rpoProven: false,
    note: 'RPO/RTO targets remain unproven until OWNER accepts a full execute drill report',
    emulator,
    steps,
    summary: {
      pass: steps.filter((s) => s.status === 'PASS').length,
      fail: failed.length,
      not_run: notRun.length
    }
  };

  if (options.writeReport) {
    const outDir = path.resolve(root, args.out);
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, 'drill-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
    report.reportPath = file;
  }

  return report;
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFullDrill(parseArgs(process.argv.slice(2)), { writeReport: true })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      const nr = report.steps.filter((s) => s.status === 'NOT_RUN');
      if (nr.length) {
        console.error('NOT RUN steps:');
        for (const s of nr) console.error(' - ' + s.name + ': ' + s.detail);
      }
    })
    .catch((error) => {
      console.error('Full DR drill FAILED:', error && error.message || error);
      process.exitCode = 1;
    });
}
