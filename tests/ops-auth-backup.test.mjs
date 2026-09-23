import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA, encryptAuthJson, decryptAuthJson, countUsers,
  assertExternalDestination, backupManifest, plan
} from '../ops-auth-backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const passphrase = 'correct horse battery staple for resq';
const source = Buffer.from(JSON.stringify({ users:[
  { localId:'u1', email:'one@example.test', passwordHash:'secret-hash' },
  { localId:'u2', email:'two@example.test', salt:'secret-salt' }
] }));

const encrypted = encryptAuthJson(source, passphrase);
assert.notEqual(encrypted.includes(Buffer.from('secret-hash')), true, 'ciphertext never exposes password hashes');
assert.deepEqual(decryptAuthJson(encrypted, passphrase), source, 'encrypted export round-trips exactly');
assert.throws(() => decryptAuthJson(encrypted, 'wrong passphrase but long enough'), /authenticate|Unsupported state/i);
assert.equal(countUsers(source), 2);
const manifest = backupManifest('station-102', encrypted, 2, '2026-09-23T00:00:00.000Z');
assert.equal(manifest.schema, SCHEMA);
assert.equal(manifest.users, 2);
assert.equal(manifest.includes_custom_claims, false);
assert.equal(manifest.hash_config_stored_separately, true);
assert.match(manifest.encrypted_sha256, /^[a-f0-9]{64}$/);

assert.throws(() => assertExternalDestination(path.join(root, '_גיבוי')), /מחוץ למאגר/);
const outside = path.join(os.tmpdir(), 'resq-auth-backups');
assert.equal(assertExternalDestination(outside), path.resolve(outside));
assert.deepEqual(plan('export', { project:'station-102', out:outside, execute:false }), {
  command:'export', project:'station-102', destination:path.resolve(outside), execute:false
});
assert.throws(() => plan('import', { file:'x', target:'station-102', confirmTarget:'station-102', execute:true }), /ייצור חסום/);
assert.throws(() => plan('import', { file:'x', target:'resq-dr-test', confirmTarget:'wrong', execute:true }), /זהים/);

const dry = spawnSync(process.execPath, ['ops-auth-backup.mjs', 'export', '--project', 'station-102', '--out', outside], {
  cwd:root, encoding:'utf8', env:{ ...process.env, RESQ_AUTH_BACKUP_PASSPHRASE:'' }
});
assert.equal(dry.status, 0, dry.stderr);
const dryResult = JSON.parse(dry.stdout);
assert.equal(dryResult.dry_run, true);
assert.equal(fs.existsSync(outside), false, 'dry-run performs no filesystem or network action');

console.log('ops auth backup: 15/15 PASS');
