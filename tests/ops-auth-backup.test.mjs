import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA, PAYLOAD_SCHEMA, encryptAuthJson, decryptAuthJson, countUsers,
  assertExternalDestination, backupManifest, plan, collectHashConfig,
  buildAuthPayload, selectClaimsForBackup, parsePayload, runExport, runImport,
  runVerify, refuseImportTarget, denyImportTargets, redactSecrets, fingerprint,
  hashConfigFingerprints
} from '../ops-auth-backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const passphrase = 'correct horse battery staple for resq';
const hashEnv = {
  RESQ_AUTH_BACKUP_PASSPHRASE: passphrase,
  RESQ_AUTH_HASH_KEY: 'hash-key-value-for-tests-xx',
  RESQ_AUTH_SALT_SEPARATOR: 'salt-separator-value-xx',
  RESQ_AUTH_ROUNDS: '8',
  RESQ_AUTH_MEM_COST: '14'
};

let passed = 0;
function check(name, fn) { fn(); console.log('PASS ' + name); passed++; }
async function checkAsync(name, fn) { await fn(); console.log('PASS ' + name); passed++; }

check('collectHashConfig refuses missing rounds/mem-cost (no hardcoding)', () => {
  assert.throws(() => collectHashConfig({ ...hashEnv, RESQ_AUTH_ROUNDS: '' }), /RESQ_AUTH_ROUNDS/);
  assert.throws(() => collectHashConfig({ ...hashEnv, RESQ_AUTH_MEM_COST: undefined }), /RESQ_AUTH_MEM_COST/);
  const cfg = collectHashConfig(hashEnv);
  assert.equal(cfg.rounds, 8);
  assert.equal(cfg.mem_cost, 14);
  assert.equal(cfg.algo, 'SCRYPT');
});

check('payload embeds hash config; manifest has fingerprints only', () => {
  const users = [
    { localId: 'u1', email: 'one@example.test', passwordHash: 'secret-hash' },
    { localId: 'u2', email: 'two@example.test', salt: 'secret-salt' }
  ];
  const hashConfig = collectHashConfig(hashEnv);
  const claims = selectClaimsForBackup(users, {
    u1: { role: 'admin', stationId: 'eilat_102' },
    u2: { role: 'firefighter' }
  }, { excludeFields: [] });
  assert.deepEqual(claims.u1.role, 'admin');
  const payload = buildAuthPayload({
    authExportJson: { users },
    hashConfig,
    customClaims: claims,
    claimsSource: 'fixture'
  });
  assert.equal(payload.schema, PAYLOAD_SCHEMA);
  assert.equal(payload.hash_config.hash_key, hashConfig.hash_key);
  assert.equal(payload.includes_custom_claims, true);
  const encrypted = encryptAuthJson(JSON.stringify(payload), passphrase);
  assert.equal(Buffer.from(encrypted).includes(Buffer.from('secret-hash')), false);
  assert.equal(Buffer.from(encrypted).includes(Buffer.from(hashConfig.hash_key)), false);
  const round = parsePayload(decryptAuthJson(encrypted, passphrase));
  assert.equal(round.hash_config.rounds, 8);
  assert.equal(countUsers(round), 2);
  const manifest = backupManifest('station-102', encrypted, round, '2026-09-23T00:00:00.000Z');
  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.hash_config_embedded, true);
  assert.equal(manifest.hash_config_stored_separately, false);
  assert.equal(manifest.includes_custom_claims, true);
  assert.equal(manifest.hash_key_fingerprint, fingerprint(hashConfig.hash_key));
  assert.equal(JSON.stringify(manifest).includes(hashConfig.hash_key), false);
  assert.equal(JSON.stringify(manifest).includes(hashConfig.salt_separator), false);
  assert.deepEqual(hashConfigFingerprints(hashConfig).algo, 'SCRYPT');
});

check('claims fixture can exclude fields and filter uids', () => {
  const users = [{ localId: 'u1' }, { localId: 'u2' }];
  const selected = selectClaimsForBackup(users, {
    u1: { role: 'admin', internalNote: 'x' },
    u2: { role: 'user' }
  }, { includeUids: ['u1'], excludeFields: ['internalNote'] });
  assert.deepEqual(selected, { u1: { role: 'admin' } });
});

check('external destination + plan + production deny from HARD_DENY and .firebaserc', () => {
  assert.throws(() => assertExternalDestination(path.join(root, '_גיבוי')), /מחוץ למאגר/);
  const outside = path.join(os.tmpdir(), 'resq-auth-backups-pkg4');
  assert.equal(assertExternalDestination(outside), path.resolve(outside));
  assert.deepEqual(plan('export', { project: 'station-102', out: outside, execute: false }), {
    command: 'export', project: 'station-102', destination: path.resolve(outside), execute: false
  });
  assert.throws(() => plan('import', { file: 'x', target: 'station-102', confirmTarget: 'station-102', execute: true, root }), /ייצור חסום/);
  const deny = denyImportTargets({ root });
  assert.equal(deny.has('station-102'), true);
  assert.throws(() => refuseImportTarget('station-102', { root }), /ייצור חסום/);
  assert.throws(() => plan('import', { file: 'x', target: 'resq-dr-test', confirmTarget: 'wrong', execute: true, root }), /זהים/);
});

check('redactSecrets strips hash-key argv shapes and labels', () => {
  const raw = 'Firebase failed --hash-key=hash-key-value-for-tests-xx --salt-separator=salt-separator-value-xx';
  const cleaned = redactSecrets(raw, [hashEnv.RESQ_AUTH_HASH_KEY]);
  assert.equal(cleaned.includes('hash-key-value-for-tests-xx'), false);
  assert.match(cleaned, /\[REDACTED\]/);
});

await checkAsync('dry-run export touches nothing', async () => {
  const outside = path.join(os.tmpdir(), 'resq-auth-dry-' + process.pid);
  const result = await runExport(
    plan('export', { project: 'station-102', out: outside, execute: false }),
    { env: hashEnv }
  );
  assert.equal(result.dry_run, true);
  assert.equal(fs.existsSync(outside), false);
});

await checkAsync('execute export via injected adapter embeds claims and leaves no plaintext', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-auth-out-'));
  try {
    const result = await runExport(
      plan('export', { project: 'demo-resq', out: outside, execute: true }),
      { env: hashEnv, now: () => new Date('2026-09-23T12:00:00.000Z') },
      {
        authExportFn: async () => JSON.stringify({
          users: [
            { localId: 'u1', email: 'a@test', passwordHash: 'HH' },
            { localId: 'u2', email: 'b@test', passwordHash: 'II' }
          ]
        }),
        claimsProvider: async () => ({ u1: { role: 'manager', stationId: 'eilat_102' } }),
        claimsSource: 'fixture',
        splitClaimsFile: true
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.users, 2);
    assert.equal(result.includes_custom_claims, true);
    assert.equal(fs.existsSync(result.file), true);
    assert.equal(fs.existsSync(result.claims_file), true);
    const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
    assert.equal(manifest.hash_config_embedded, true);
    assert.equal(JSON.stringify(manifest).includes(hashEnv.RESQ_AUTH_HASH_KEY), false);
    const verified = await runVerify(plan('verify', { file: result.file }), { env: hashEnv });
    assert.equal(verified.users, 2);
    assert.equal(verified.includes_custom_claims, true);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

await checkAsync('export refuses unrestorable backup when rounds missing', async () => {
  const outside = path.join(os.tmpdir(), 'resq-auth-bad-' + process.pid);
  await assert.rejects(
    runExport(
      plan('export', { project: 'demo-resq', out: outside, execute: true }),
      { env: { ...hashEnv, RESQ_AUTH_ROUNDS: '' } },
      { authExportFn: async () => '{"users":[]}' }
    ),
    /RESQ_AUTH_ROUNDS|אינו ניתן לשחזור/
  );
});

await checkAsync('import restores users+claims on demo via adapters; station-102 blocked', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-auth-imp-'));
  try {
    const exported = await runExport(
      plan('export', { project: 'station-102', out: outside, execute: true }),
      { env: hashEnv },
      {
        authExportFn: async () => JSON.stringify({ users: [{ localId: 'u9', email: 'x@test', passwordHash: 'Z' }] }),
        claimsProvider: async () => ({ u9: { role: 'firefighter', stationId: 'eilat_102' } }),
        claimsSource: 'fixture'
      }
    );
    const calls = { import: 0, claims: [] };
    const imported = await runImport(
      plan('import', { file: exported.file, target: 'resq-dr-demo', confirmTarget: 'resq-dr-demo', execute: true, root }),
      { env: { ...hashEnv, RESQ_AUTH_IMPORT_TARGET_ALLOWLIST: 'resq-dr-demo' } },
      {
        authImportFn: async ({ target, hashConfig }) => {
          calls.import += 1;
          assert.equal(target, 'resq-dr-demo');
          assert.equal(hashConfig.rounds, 8);
          assert.equal(hashConfig.hash_key, hashEnv.RESQ_AUTH_HASH_KEY);
        },
        setCustomUserClaims: async (uid, claims) => { calls.claims.push({ uid, claims }); }
      }
    );
    assert.equal(imported.imported_users, 1);
    assert.equal(imported.claims_restored, 1);
    assert.equal(calls.import, 1);
    assert.deepEqual(calls.claims[0].claims.role, 'firefighter');
    assert.throws(
      () => plan('import', { file: exported.file, target: 'station-102', confirmTarget: 'station-102', execute: true, root }),
      /ייצור חסום/
    );
    await assert.rejects(
      runImport(
        { command: 'import', file: exported.file, target: 'station-102', execute: true },
        { env: { ...hashEnv, RESQ_AUTH_IMPORT_TARGET_ALLOWLIST: 'station-102' }, root },
        { authImportFn: async () => { throw new Error('should not run'); } }
      ),
      /ייצור חסום/
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

const dry = spawnSync(process.execPath, ['ops-auth-backup.mjs', 'export', '--project', 'station-102', '--out', path.join(os.tmpdir(), 'resq-auth-cli-dry')], {
  cwd: root, encoding: 'utf8', env: { ...process.env, RESQ_AUTH_BACKUP_PASSPHRASE: '' }
});
assert.equal(dry.status, 0, dry.stderr);
assert.equal(JSON.parse(dry.stdout).dry_run, true);
check('CLI dry-run export works without passphrase', () => {});

console.log('ops auth backup: ' + passed + '/' + passed + ' PASS');
