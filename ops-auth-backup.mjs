#!/usr/bin/env node
// Encrypted Firebase Authentication backup for ResQ.
// Default is plan-only. Export/import require explicit flags and never print
// users, password hashes, salts, passphrases or SCRYPT parameters.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = 'resq-auth-backup-v1';
export const HARD_DENY_IMPORT = Object.freeze(['station-102']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function secret(value, label) {
  const clean = String(value || '');
  if (clean.length < 20) throw new Error(label + ' חסר או קצר מדי');
  return clean;
}

export function encryptAuthJson(plain, passphrase) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(secret(passphrase, 'RESQ_AUTH_BACKUP_PASSPHRASE'), salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return Buffer.from(JSON.stringify({
    schema:SCHEMA, kdf:'scrypt', cipher:'aes-256-gcm',
    salt:salt.toString('base64'), iv:iv.toString('base64'),
    tag:cipher.getAuthTag().toString('base64'), data:ciphertext.toString('base64')
  }));
}

export function decryptAuthJson(encrypted, passphrase) {
  const box = JSON.parse(Buffer.from(encrypted).toString('utf8'));
  if (!box || box.schema !== SCHEMA || box.kdf !== 'scrypt' || box.cipher !== 'aes-256-gcm') {
    throw new Error('פורמט גיבוי Auth אינו מוכר');
  }
  const key = scryptSync(secret(passphrase, 'RESQ_AUTH_BACKUP_PASSPHRASE'), Buffer.from(box.salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
}

export function countUsers(json) {
  const value = JSON.parse(Buffer.from(json).toString('utf8'));
  const users = Array.isArray(value) ? value : (Array.isArray(value.users) ? value.users : []);
  return users.length;
}

export function assertExternalDestination(destination) {
  const resolved = path.resolve(destination);
  const relative = path.relative(ROOT, resolved);
  if (!relative.startsWith('..' + path.sep) && relative !== '..') {
    throw new Error('גיבוי Auth חייב להישמר מחוץ למאגר');
  }
  return resolved;
}

export function backupManifest(project, encrypted, userCount, createdAt = new Date().toISOString()) {
  return {
    schema:SCHEMA, project:String(project), created_at:createdAt,
    users:Number(userCount), encrypted_bytes:encrypted.length,
    encrypted_sha256:sha256(encrypted), includes_custom_claims:false,
    hash_config_stored_separately:true
  };
}

function firebaseBinary() {
  return process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
}

function runFirebase(args) {
  const result = spawnSync(firebaseBinary(), args, { encoding:'utf8', windowsHide:true });
  if (result.status !== 0) throw new Error('Firebase CLI נכשל: ' + String(result.stderr || result.stdout || '').trim().slice(0, 300));
}

function argMap(argv) {
  const out = { execute:false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--execute') { out.execute = true; continue; }
    if (!item.startsWith('--') || index + 1 >= argv.length) throw new Error('ארגומנט לא תקין: ' + item);
    out[item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index];
  }
  return out;
}

function writeJsonAtomic(file, value) {
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag:'wx' });
  fs.renameSync(temp, file);
}

export function plan(command, options) {
  if (!['export','verify','import'].includes(command)) throw new Error('פקודה לא מוכרת');
  if (command === 'export') {
    if (!options.project || !options.out) throw new Error('export דורש --project ו---out');
    return { command, project:options.project, destination:assertExternalDestination(options.out), execute:options.execute === true };
  }
  if (!options.file) throw new Error(command + ' דורש --file');
  if (command === 'import') {
    if (!options.target || options.confirmTarget !== options.target) throw new Error('import דורש --target ו---confirm-target זהים');
    if (HARD_DENY_IMPORT.includes(options.target)) throw new Error('יעד ייצור חסום לייבוא Auth');
  }
  return { command, file:path.resolve(options.file), target:options.target || '', execute:options.execute === true };
}

async function main() {
  const command = process.argv[2] || '';
  const options = argMap(process.argv.slice(3));
  const action = plan(command, options);
  if (!action.execute) {
    console.log(JSON.stringify({ ok:true, dry_run:true, action }, null, 2));
    return;
  }
  const passphrase = secret(process.env.RESQ_AUTH_BACKUP_PASSPHRASE, 'RESQ_AUTH_BACKUP_PASSPHRASE');
  if (command === 'export') {
    fs.mkdirSync(action.destination, { recursive:true });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const plain = path.join(os.tmpdir(), 'resq-auth-' + process.pid + '-' + stamp + '.json');
    const encryptedFile = path.join(action.destination, 'resq-auth-' + stamp + '.json.enc');
    try {
      runFirebase(['auth:export', plain, '--format=json', '--project', action.project]);
      const bytes = fs.readFileSync(plain);
      const encrypted = encryptAuthJson(bytes, passphrase);
      fs.writeFileSync(encryptedFile, encrypted, { flag:'wx' });
      writeJsonAtomic(encryptedFile + '.manifest.json', backupManifest(action.project, encrypted, countUsers(bytes)));
      console.log(JSON.stringify({ ok:true, file:encryptedFile, manifest:encryptedFile + '.manifest.json' }));
    } finally {
      try { fs.rmSync(plain, { force:true }); } catch (_) {}
    }
    return;
  }
  const encrypted = fs.readFileSync(action.file);
  const plainBytes = decryptAuthJson(encrypted, passphrase);
  if (command === 'verify') {
    console.log(JSON.stringify({ ok:true, users:countUsers(plainBytes), encrypted_sha256:sha256(encrypted) }));
    return;
  }
  const allow = String(process.env.RESQ_AUTH_IMPORT_TARGET_ALLOWLIST || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!allow.includes(action.target)) throw new Error('יעד הייבוא אינו ב-RESQ_AUTH_IMPORT_TARGET_ALLOWLIST');
  const hashKey = secret(process.env.RESQ_AUTH_HASH_KEY, 'RESQ_AUTH_HASH_KEY');
  const saltSeparator = secret(process.env.RESQ_AUTH_SALT_SEPARATOR, 'RESQ_AUTH_SALT_SEPARATOR');
  const temp = path.join(os.tmpdir(), 'resq-auth-import-' + process.pid + '.json');
  try {
    fs.writeFileSync(temp, plainBytes, { flag:'wx' });
    runFirebase(['auth:import', temp, '--project', action.target, '--hash-algo=SCRYPT',
      '--hash-key=' + hashKey, '--salt-separator=' + saltSeparator,
      '--rounds=' + String(process.env.RESQ_AUTH_ROUNDS || '8'),
      '--mem-cost=' + String(process.env.RESQ_AUTH_MEM_COST || '14')]);
    console.log(JSON.stringify({ ok:true, imported_users:countUsers(plainBytes), target:action.target }));
  } finally {
    try { fs.rmSync(temp, { force:true }); } catch (_) {}
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main().catch(error => { console.error(error.message); process.exitCode = 1; });
