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
  const executeRequested = !!args.execute && !verifyOnly;

  // Required stages when --execute is requested (emulator drill).
  const requiredOnExecute = [
    'firestore_emulator_restore',
    'auth_fixture_import',
    'storage_fixture_restore',
    'rules_live_emulator'
  ];

  // 1. Hard deny + allowlist posture
  try {
    const guards = hardDenyGuards(args.target, { root, env });
    steps.push(step('hard_deny_station_102', 'PASS', 'refuseTarget + auth + storage denies intact', guards));
  } catch (error) {
    steps.push(step('hard_deny_station_102', 'FAIL', String(error && error.message || error)));
  }

  try {
    refuseTarget('station-102', 'demo-resq', { root });
    steps.push(step('station_102_even_if_allowlisted', 'FAIL', 'refuseTarget did not throw for station-102'));
  } catch (error) {
    steps.push(step('station_102_even_if_allowlisted', 'PASS', String(error && error.message || error)));
  }

  // 2. Signing key required for execute
  if (executeRequested) {
    try {
      requireSigningKey(env);
      steps.push(step('restore_signing_key', 'PASS', 'RESQ_RESTORE_SIGNING_KEY present (>=' + SIGNING_KEY_MIN_LENGTH + ')'));
    } catch (error) {
      steps.push(step('restore_signing_key', 'FAIL', String(error && error.message || error)));
    }
  } else {
    steps.push(step('restore_signing_key', 'PASS', 'verify-only / dry path — signing key not required'));
  }

  // 3. Repo artifacts
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

  // 4. Static rules source gate
  const rulecheckPath = path.join(root, 'tests', 'rulecheck.mjs');
  if (fs.existsSync(rulecheckPath)) {
    steps.push(step('rules_static_gate', 'PASS', 'tests/rulecheck.mjs present (static; not a live Rules engine run)'));
  } else {
    steps.push(step('rules_static_gate', 'FAIL', 'tests/rulecheck.mjs missing'));
  }

  // 5. Emulator / live Rules
  let firestoreApi = options.firestoreApi || null;
  let authApi = options.authApi || null;
  let storageApi = options.storageApi || null;
  let rulesRunner = options.rulesRunner || null;

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
    // Execute against emulator only — never cloud fallback.
    if ((!firestoreApi || !authApi || !storageApi) && typeof options.loadEmulatorAdapters === 'function') {
      try {
        const loaded = await options.loadEmulatorAdapters({
          target: args.target, root, env, host: emulator.host
        });
        firestoreApi = firestoreApi || (loaded && loaded.firestoreApi);
        authApi = authApi || (loaded && loaded.authApi);
        storageApi = storageApi || (loaded && loaded.storageApi);
        rulesRunner = rulesRunner || (loaded && loaded.rulesRunner);
      } catch (error) {
        steps.push(step('emulator_adapter_load', 'FAIL', String(error && error.message || error)));
      }
    }
    if (!firestoreApi || !authApi || !storageApi) {
      steps.push(step('firestore_emulator_restore', 'NOT_RUN',
        'emulator host set but firestoreApi/authApi/storageApi not available — no cloud fallback'));
      steps.push(step('auth_fixture_import', 'NOT_RUN', 'authApi not available'));
      steps.push(step('storage_fixture_restore', 'NOT_RUN', 'storageApi not available'));
      steps.push(step('rules_live_emulator', 'NOT_RUN',
        rulesRunner ? 'deferred' : 'no rulesRunner — not faked PASS'));
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
        const msg = String(error && error.message || error);
        if (error && error.code === 'NOT_RUN') {
          steps.push(step('auth_fixture_import', 'NOT_RUN', msg));
        } else {
          steps.push(step('auth_fixture_import', 'FAIL', msg));
        }
      }
      try {
        const stResult = await storageApi.restoreDemo({ target: args.target, createOnly: true });
        steps.push(step('storage_fixture_restore', 'PASS', 'storage fixture restore', stResult));
      } catch (error) {
        const msg = String(error && error.message || error);
        if (error && error.code === 'NOT_RUN') {
          steps.push(step('storage_fixture_restore', 'NOT_RUN', msg));
        } else {
          steps.push(step('storage_fixture_restore', 'FAIL', msg));
        }
      }
      if (rulesRunner) {
        try {
          const rulesResult = await rulesRunner({ host: emulator.host, root, env });
          if (rulesResult && rulesResult.notRun) {
            steps.push(step('rules_live_emulator', 'NOT_RUN', rulesResult.detail || 'rulesRunner NOT_RUN'));
          } else {
            steps.push(step('rules_live_emulator', rulesResult && rulesResult.ok ? 'PASS' : 'FAIL',
              (rulesResult && rulesResult.detail) || '', rulesResult));
          }
        } catch (error) {
          steps.push(step('rules_live_emulator', 'FAIL', String(error && error.message || error)));
        }
      } else {
        steps.push(step('rules_live_emulator', 'NOT_RUN', 'no rulesRunner — not faked PASS'));
      }
    }
  }

  // 6. Integrity helpers — NOT_RUN without payload (never fake PASS)
  const expected = options.expectedIntegrity || null;
  if (expected) {
    const counts = compareIdentityCounts(expected.count, expected.actualCount);
    steps.push(step('compare_counts', counts.ok ? 'PASS' : 'FAIL', JSON.stringify(counts)));
    const sums = compareChecksums(expected.checksum, expected.actualChecksum);
    steps.push(step('compare_checksums', sums.ok ? 'PASS' : 'FAIL', JSON.stringify(sums)));
  } else {
    steps.push(step('compare_counts', 'NOT_RUN', 'no integrity payload provided'));
    steps.push(step('compare_checksums', 'NOT_RUN', 'no integrity payload provided'));
  }

  // 7. Local bundle restore drill — only PASS if actually run
  try {
    const backupRoot = path.join(root, '_גיבוי');
    const hasSet = fs.existsSync(backupRoot) && fs.readdirSync(backupRoot).some((n) =>
      /^resq-\d{8}T/.test(n) || /^set-/.test(n));
    if (options.runLocalBundleDrill === true && hasSet) {
      const drillMod = await import(pathToFileURL(path.join(root, 'ops-restore-drill.mjs')).href);
      const local = drillMod.runRestoreDrill(drillMod.parseArgs([]), { root });
      steps.push(step('local_bundle_restore_drill', local && local.ok ? 'PASS' : 'FAIL',
        local ? ('set=' + local.set) : 'no result', local));
    } else if (hasSet) {
      steps.push(step('local_bundle_restore_drill', 'NOT_RUN',
        'local _גיבוי present but runLocalBundleDrill not enabled — use node ops-restore-drill.mjs'));
    } else {
      steps.push(step('local_bundle_restore_drill', 'NOT_RUN',
        'no local verified backup set under _גיבוי — use ops-restore-drill.mjs after ops-backup.mjs'));
    }
  } catch (error) {
    steps.push(step('local_bundle_restore_drill', 'FAIL', String(error && error.message || error)));
  }

  // 8. Cleanup / rollback markers
  const workDir = path.join(os.tmpdir(), 'resq-dr-full-drill-' + sha256(String(started)).slice(0, 12));
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'marker.txt'), 'demo-only\n', 'utf8');
    fs.rmSync(workDir, { recursive: true, force: true });
    const cleaned = !fs.existsSync(workDir);
    steps.push(step('cleanup_demo_workdir', cleaned ? 'PASS' : 'FAIL', workDir));
    steps.push(step('rollback_posture', 'PASS',
      'create-only=' + args.createOnly + ' skip-existing=' + args.skipExisting + ' verifyOnly=' + verifyOnly));
  } catch (error) {
    steps.push(step('cleanup_demo_workdir', 'FAIL', String(error && error.message || error)));
  }

  const elapsedMs = Date.now() - started;
  const failed = steps.filter((s) => s.status === 'FAIL');
  const notRun = steps.filter((s) => s.status === 'NOT_RUN');
  const requiredNotRun = executeRequested
    ? requiredOnExecute.filter((name) => {
        const s = steps.find((x) => x.name === name);
        return !s || s.status === 'NOT_RUN';
      })
    : [];
  const incomplete = requiredNotRun.length > 0;
  const ok = failed.length === 0 && !incomplete;

  const report = {
    ok,
    status: !ok ? (failed.length ? 'FAIL' : 'INCOMPLETE') : 'PASS',
    schema: 'resq-dr-full-drill-v1',
    target: args.target,
    verifyOnly,
    execute: !!args.execute,
    executeRequested,
    demoProjectOnly: args.target !== 'station-102',
    rtoMeasuredMs: elapsedMs,
    rtoProven: false,
    rpoProven: false,
    note: 'RPO/RTO targets remain unproven until OWNER accepts a full execute drill report',
    emulator,
    requiredNotRun,
    steps,
    summary: {
      pass: steps.filter((s) => s.status === 'PASS').length,
      fail: failed.length,
      not_run: notRun.length,
      incomplete: incomplete
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

/**
 * Emulator-only drill adapters. No cloud fallback. Refuses station-102.
 * Dynamic-imports firebase-admin only when called.
 */
export async function createEmulatorDrillAdapters({ target, root = HERE, env = process.env } = {}) {
  if (!String(env.FIRESTORE_EMULATOR_HOST || '').trim()) {
    throw new Error('createEmulatorDrillAdapters requires FIRESTORE_EMULATOR_HOST');
  }
  refuseTarget(target, 'fixture-source-not-equal', { root });
  if (target === 'station-102' || denyTargets({ root }).has(target)) {
    throw new Error('station-102 / production targets forbidden for emulator drill adapters');
  }

  const require = createRequire(pathToFileURL(path.join(root, 'functions', 'package.json')).href);
  const resolved = require.resolve('firebase-admin');
  const imported = await import(pathToFileURL(resolved).href);
  const admin = imported.default || imported;
  if (!admin.apps.length) {
    admin.initializeApp({ projectId: target });
  }
  const db = admin.firestore();

  const firestoreApi = {
    async restoreDemo({ createOnly }) {
      const ref = db.collection('_resq_dr_drill').doc('canary');
      const payload = {
        drilled_at: new Date().toISOString(),
        target,
        demo: true
      };
      try {
        await ref.create(payload);
        return { ok: true, path: ref.path, created: true };
      } catch (error) {
        if (createOnly && error && (error.code === 6 || /ALREADY_EXISTS/i.test(String(error.message)))) {
          return { ok: true, path: ref.path, skippedExisting: true };
        }
        throw error;
      }
    }
  };

  const authApi = {
    async importDemo() {
      if (!String(env.FIREBASE_AUTH_EMULATOR_HOST || '').trim()) {
        const err = new Error('FIREBASE_AUTH_EMULATOR_HOST unset — auth fixture import NOT_RUN');
        err.code = 'NOT_RUN';
        throw err;
      }
      const auth = admin.auth();
      const email = 'dr-drill-' + Date.now() + '@example.invalid';
      let user;
      try {
        user = await auth.createUser({ email, password: 'DrillTest!' + Date.now(), emailVerified: false });
      } catch (error) {
        throw error;
      }
      await auth.setCustomUserClaims(user.uid, { role: 'firefighter', stationId: 'drill_demo', drill: true });
      return { ok: true, uid: user.uid, claimsRestored: 1 };
    }
  };

  const storageApi = {
    async restoreDemo() {
      if (!String(env.FIREBASE_STORAGE_EMULATOR_HOST || env.STORAGE_EMULATOR_HOST || '').trim()) {
        const err = new Error('STORAGE emulator host unset — storage fixture restore NOT_RUN');
        err.code = 'NOT_RUN';
        throw err;
      }
      const bucketName = target + '.appspot.com';
      const bucket = admin.storage().bucket(bucketName);
      const name = 'hr-private/drill_demo/fixture/drill/canary.txt';
      const bytes = Buffer.from('resq-dr-drill-fixture\n', 'utf8');
      try {
        await bucket.file(name).save(bytes, {
          resumable: false,
          contentType: 'text/plain',
          preconditionOpts: { ifGenerationMatch: 0 }
        });
      } catch (error) {
        if (/condition|precondition|412/i.test(String(error && error.message))) {
          return { ok: true, name, skippedExisting: true };
        }
        throw error;
      }
      return { ok: true, name, created: true };
    }
  };

  const rulesRunner = async ({ host }) => {
    // Prefer @firebase/rules-unit-testing from rules-test if installed; else NOT_RUN.
    let rulesTestingPath;
    try {
      const rtRequire = createRequire(pathToFileURL(path.join(root, 'rules-test', 'package.json')).href);
      rulesTestingPath = rtRequire.resolve('@firebase/rules-unit-testing');
    } catch {
      return {
        notRun: true,
        detail: '@firebase/rules-unit-testing not installed under rules-test — live Rules NOT_RUN (not faked PASS)'
      };
    }
    const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
    const mod = await import(pathToFileURL(rulesTestingPath).href);
    const hostPort = String(host).split(':');
    const firestoreHost = hostPort[0] || '127.0.0.1';
    const firestorePort = Number(hostPort[1] || 8080);
    const testEnv = await mod.initializeTestEnvironment({
      projectId: target,
      firestore: { rules, host: firestoreHost, port: firestorePort }
    });
    try {
      const unauth = testEnv.unauthenticatedContext();
      await mod.assertFails(unauth.firestore().collection('_resq_dr_drill').doc('canary').get());
      return { ok: true, detail: 'unauthenticated read denied against emulator rules' };
    } finally {
      await testEnv.cleanup();
    }
  };

  return { firestoreApi, authApi, storageApi, rulesRunner };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const options = { writeReport: true, root: HERE, env: process.env };
  if (args.execute && !args.verifyOnly) {
    const emu = detectEmulator(process.env);
    if (emu.available) {
      options.loadEmulatorAdapters = createEmulatorDrillAdapters;
    }
  }
  runFullDrill(args, options)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      if (report.status === 'INCOMPLETE') {
        console.error('DRILL INCOMPLETE / NOT_RUN required stages:');
        for (const name of report.requiredNotRun || []) {
          const s = report.steps.find((x) => x.name === name);
          console.error(' - ' + name + ': ' + (s && s.detail || 'missing'));
        }
      }
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
