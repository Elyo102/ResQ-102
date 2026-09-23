#!/usr/bin/env node
/* ======================================================================
 * ops-auth-backup — encrypted Firebase Auth backup/restore for ResQ.
 *
 * Default is dry-run / plan-only. Real export/import requires --execute.
 * Never print users, password hashes, salts, passphrases, hash keys or
 * SCRYPT parameters to stdout/stderr/exceptions.
 *
 * ARGV RISK (documented): `firebase auth:import` requires --hash-key and
 * --salt-separator on the CLI argv. Those values are taken from the
 * *decrypted* backup blob (not re-read from env at import). Spawn failures
 * are redacted so argv secrets never appear in errors/logs. Prefer env-only
 * secrets for everything else; do not add new secret-bearing argv flags.
 * ====================================================================== */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = 'resq-auth-backup-v2';
export const PAYLOAD_SCHEMA = 'resq-auth-payload-v1';
export const CLAIMS_SCHEMA = 'resq-auth-claims-v1';
export const HARD_DENY_IMPORT = Object.freeze(['station-102']);
export const PASSPHRASE_ENV = 'RESQ_AUTH_BACKUP_PASSPHRASE';
export const HASH_KEY_ENV = 'RESQ_AUTH_HASH_KEY';
export const SALT_SEP_ENV = 'RESQ_AUTH_SALT_SEPARATOR';
export const ROUNDS_ENV = 'RESQ_AUTH_ROUNDS';
export const MEM_COST_ENV = 'RESQ_AUTH_MEM_COST';

const SECRET_LABELS = [
  PASSPHRASE_ENV, HASH_KEY_ENV, SALT_SEP_ENV,
  'hash_key', 'salt_separator', 'passwordHash', 'salt', 'passphrase'
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprint(value) {
  return sha256(String(value || ''));
}

export function secret(value, label) {
  const clean = String(value || '');
  if (clean.length < 20) throw new Error(label + ' חסר או קצר מדי');
  return clean;
}

/** Strip known secret material from any thrown/logged string. */
export function redactSecrets(text, extras = []) {
  let out = String(text || '');
  const needles = [...SECRET_LABELS, ...extras].filter(Boolean);
  for (const needle of needles) {
    if (!needle || needle.length < 4) continue;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
  }
  // Redact --hash-key=... and --salt-separator=... argv shapes.
  out = out.replace(/--hash-key=\S+/gi, '--hash-key=[REDACTED]');
  out = out.replace(/--salt-separator=\S+/gi, '--salt-separator=[REDACTED]');
  return out;
}

export function safeError(error, extras = []) {
  const message = redactSecrets(error && error.message ? error.message : String(error || ''), extras);
  const err = new Error(message);
  err.code = error && error.code;
  return err;
}

export function denyImportTargets(options = {}) {
  const deny = new Set(HARD_DENY_IMPORT);
  try {
    const root = options.root || ROOT;
    const rc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8'));
    const projects = rc && rc.projects ? rc.projects : {};
    if (typeof projects.default === 'string' && projects.default) deny.add(projects.default);
  } catch { /* hard list still applies */ }
  return deny;
}

export function refuseImportTarget(target, options = {}) {
  if (!target || typeof target !== 'string') throw new Error('יעד ייבוא Auth חסר');
  if (denyImportTargets(options).has(target)) {
    throw new Error('יעד ייצור חסום לייבוא Auth: ' + target);
  }
}

/**
 * Collect SCRYPT restore params. Never hardcode rounds/mem-cost.
 * Missing any field → unrestorable → refuse.
 */
export function collectHashConfig(env = process.env) {
  const algo = String(env.RESQ_AUTH_HASH_ALGO || 'SCRYPT');
  if (algo !== 'SCRYPT') throw new Error('אלגוריתם גיבוב אינו נתמך לייצוא הניתן לשחזור');
  const hash_key = secret(env[HASH_KEY_ENV], HASH_KEY_ENV);
  const salt_separator = secret(env[SALT_SEP_ENV], SALT_SEP_ENV);
  const roundsRaw = env[ROUNDS_ENV];
  const memRaw = env[MEM_COST_ENV];
  if (roundsRaw === undefined || roundsRaw === null || String(roundsRaw).trim() === '') {
    throw new Error(ROUNDS_ENV + ' חסר — מסרבים ליצור גיבוי שאינו ניתן לשחזור');
  }
  if (memRaw === undefined || memRaw === null || String(memRaw).trim() === '') {
    throw new Error(MEM_COST_ENV + ' חסר — מסרבים ליצור גיבוי שאינו ניתן לשחזור');
  }
  const rounds = Number(roundsRaw);
  const mem_cost = Number(memRaw);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) {
    throw new Error(ROUNDS_ENV + ' אינו תקין');
  }
  if (!Number.isInteger(mem_cost) || mem_cost < 1 || mem_cost > 30) {
    throw new Error(MEM_COST_ENV + ' אינו תקין');
  }
  return { algo, hash_key, salt_separator, rounds, mem_cost };
}

export function hashConfigFingerprints(hashConfig) {
  return {
    hash_key_fingerprint: fingerprint(hashConfig.hash_key),
    salt_separator_fingerprint: fingerprint(hashConfig.salt_separator),
    rounds_fingerprint: fingerprint(String(hashConfig.rounds)),
    mem_cost_fingerprint: fingerprint(String(hashConfig.mem_cost)),
    algo: hashConfig.algo
  };
}

/** Fixture / adapter contract: decide which custom claims are stored. */
export function selectClaimsForBackup(users, claimsByUid, policy = {}) {
  const include = policy.includeUids ? new Set(policy.includeUids) : null;
  const excludeFields = new Set(policy.excludeFields || []);
  const out = {};
  const list = Array.isArray(users) ? users : [];
  for (const user of list) {
    const uid = user && user.localId;
    if (!uid || typeof uid !== 'string') continue;
    if (include && !include.has(uid)) continue;
    const claims = claimsByUid && claimsByUid[uid];
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) continue;
    const cleaned = {};
    for (const [key, value] of Object.entries(claims)) {
      if (excludeFields.has(key)) continue;
      cleaned[key] = value;
    }
    if (Object.keys(cleaned).length) out[uid] = cleaned;
  }
  return out;
}

export function buildAuthPayload({ authExportJson, hashConfig, customClaims, claimsSource }) {
  if (!hashConfig || !hashConfig.hash_key || !hashConfig.salt_separator) {
    throw new Error('גיבוי Auth ללא hash_config אינו ניתן לשחזור — נדחה');
  }
  const users = (() => {
    const value = typeof authExportJson === 'string' || Buffer.isBuffer(authExportJson)
      ? JSON.parse(Buffer.from(authExportJson).toString('utf8'))
      : authExportJson;
    return Array.isArray(value) ? value : (Array.isArray(value.users) ? value.users : []);
  })();
  return {
    schema: PAYLOAD_SCHEMA,
    auth_export: { users },
    hash_config: {
      algo: hashConfig.algo,
      hash_key: hashConfig.hash_key,
      salt_separator: hashConfig.salt_separator,
      rounds: hashConfig.rounds,
      mem_cost: hashConfig.mem_cost
    },
    custom_claims: customClaims && typeof customClaims === 'object' ? customClaims : {},
    claims_source: claimsSource || 'none',
    includes_custom_claims: !!(customClaims && Object.keys(customClaims).length)
  };
}

export function encryptAuthJson(plain, passphrase) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(secret(passphrase, PASSPHRASE_ENV), salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return Buffer.from(JSON.stringify({
    schema: SCHEMA, kdf: 'scrypt', cipher: 'aes-256-gcm',
    salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64')
  }));
}

export function decryptAuthJson(encrypted, passphrase) {
  let box;
  try {
    box = JSON.parse(Buffer.from(encrypted).toString('utf8'));
  } catch (error) {
    throw safeError(new Error('פורמט גיבוי Auth אינו JSON תקין'));
  }
  if (!box || (box.schema !== SCHEMA && box.schema !== 'resq-auth-backup-v1') ||
      box.kdf !== 'scrypt' || box.cipher !== 'aes-256-gcm') {
    throw new Error('פורמט גיבוי Auth אינו מוכר');
  }
  try {
    const key = scryptSync(secret(passphrase, PASSPHRASE_ENV), Buffer.from(box.salt, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  } catch (error) {
    throw safeError(error);
  }
}

export function parsePayload(plainBytes) {
  const text = Buffer.from(plainBytes).toString('utf8');
  let value;
  try { value = JSON.parse(text); } catch {
    // Legacy v1: raw auth export only — unrestorable without embedded hash config.
    throw new Error('גיבוי Auth ישן ללא hash_config מוטמע — אינו ניתן לשחזור בבטחה');
  }
  if (value && value.schema === PAYLOAD_SCHEMA) {
    if (!value.hash_config || !value.hash_config.hash_key || !value.hash_config.salt_separator ||
        !Number.isInteger(value.hash_config.rounds) || !Number.isInteger(value.hash_config.mem_cost)) {
      throw new Error('גיבוי Auth חסר hash_config מלא — נדחה');
    }
    return value;
  }
  throw new Error('גיבוי Auth ללא מטען v1 מוכר — נדחה');
}

export function countUsers(jsonOrPayload) {
  if (Buffer.isBuffer(jsonOrPayload) || typeof jsonOrPayload === 'string') {
    const value = JSON.parse(Buffer.from(jsonOrPayload).toString('utf8'));
    if (value && value.schema === PAYLOAD_SCHEMA) {
      return Array.isArray(value.auth_export && value.auth_export.users) ? value.auth_export.users.length : 0;
    }
    const users = Array.isArray(value) ? value : (Array.isArray(value.users) ? value.users : []);
    return users.length;
  }
  if (jsonOrPayload && jsonOrPayload.schema === PAYLOAD_SCHEMA) {
    return Array.isArray(jsonOrPayload.auth_export && jsonOrPayload.auth_export.users)
      ? jsonOrPayload.auth_export.users.length : 0;
  }
  return 0;
}

export function assertExternalDestination(destination) {
  const resolved = path.resolve(destination);
  const relative = path.relative(ROOT, resolved);
  if (!relative.startsWith('..' + path.sep) && relative !== '..') {
    throw new Error('גיבוי Auth חייב להישמר מחוץ למאגר');
  }
  return resolved;
}

export function backupManifest(project, encrypted, payload, createdAt = new Date().toISOString()) {
  const fps = hashConfigFingerprints(payload.hash_config);
  return {
    schema: SCHEMA,
    project: String(project),
    created_at: createdAt,
    users: countUsers(payload),
    encrypted_bytes: encrypted.length,
    encrypted_sha256: sha256(encrypted),
    includes_custom_claims: !!payload.includes_custom_claims,
    claims_source: payload.claims_source || 'none',
    hash_config_embedded: true,
    hash_config_stored_separately: false,
    ...fps
  };
}

/** Optional separate claims-only encrypted artifact (when policy wants split files). */
export function buildClaimsExport(customClaims) {
  return {
    schema: CLAIMS_SCHEMA,
    claims: customClaims && typeof customClaims === 'object' ? customClaims : {},
    count: customClaims ? Object.keys(customClaims).length : 0
  };
}

function firebaseBinary() {
  return process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
}

function runFirebase(args, extras = []) {
  const result = spawnSync(firebaseBinary(), args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    const raw = String(result.stderr || result.stdout || '').trim().slice(0, 300);
    throw safeError(new Error('Firebase CLI נכשל: ' + raw), extras);
  }
  return result;
}

function argMap(argv) {
  const out = { execute: false };
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
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temp, file);
}

export function plan(command, options) {
  if (!['export', 'verify', 'import'].includes(command)) throw new Error('פקודה לא מוכרת');
  if (command === 'export') {
    if (!options.project || !options.out) throw new Error('export דורש --project ו---out');
    return { command, project: options.project, destination: assertExternalDestination(options.out), execute: options.execute === true };
  }
  if (!options.file) throw new Error(command + ' דורש --file');
  if (command === 'import') {
    if (!options.target || options.confirmTarget !== options.target) {
      throw new Error('import דורש --target ו---confirm-target זהים');
    }
    refuseImportTarget(options.target, options);
  }
  return { command, file: path.resolve(options.file), target: options.target || '', execute: options.execute === true };
}

/**
 * Export path with injectable adapters (tests never hit network).
 * deps.authExportFn() -> Buffer|string JSON auth export
 * deps.claimsProvider(users) -> { [uid]: claims }
 */
export async function runExport(action, options = {}, deps = {}) {
  const env = options.env || process.env;
  const passphrase = secret(env[PASSPHRASE_ENV], PASSPHRASE_ENV);
  const hashConfig = collectHashConfig(env);
  if (!action.execute) {
    return { ok: true, dry_run: true, action, network: 'not contacted', sdk: 'not loaded' };
  }
  if (typeof deps.claimsProvider !== 'function') {
    throw new Error(
      'export --execute מסורב: חסר claimsProvider — אין לדווח על גיבוי Auth מלא בלי custom claims. ' +
      'הזרק claimsProvider או השתמש ב-CLI שמחובר ל-Admin.'
    );
  }
  const authExportFn = deps.authExportFn;
  if (typeof authExportFn !== 'function' && !deps.allowFirebaseCli) {
    throw new Error('export אמיתי דורש authExportFn מוזרק או allowFirebaseCli מפורש');
  }
  fs.mkdirSync(action.destination, { recursive: true });
  const stamp = (options.now ? options.now() : new Date()).toISOString().replace(/[-:.]/g, '');
  const encryptedFile = path.join(action.destination, 'resq-auth-' + stamp + '.json.enc');
  const claimsFile = path.join(action.destination, 'resq-auth-claims-' + stamp + '.json.enc');
  let plainTmp = null;
  try {
    let authBytes;
    if (typeof authExportFn === 'function') {
      authBytes = Buffer.from(await authExportFn({ project: action.project }));
    } else {
      plainTmp = path.join(os.tmpdir(), 'resq-auth-' + process.pid + '-' + stamp + '.json');
      runFirebase(['auth:export', plainTmp, '--format=json', '--project', action.project], [hashConfig.hash_key, hashConfig.salt_separator, passphrase]);
      authBytes = fs.readFileSync(plainTmp);
    }
    const parsed = JSON.parse(authBytes.toString('utf8'));
    const users = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.users) ? parsed.users : []);
    const claimsByUid = deps.claimsProvider
      ? await deps.claimsProvider(users, { project: action.project })
      : {};
    const claimsPolicy = deps.claimsPolicy || {};
    const customClaims = selectClaimsForBackup(users, claimsByUid || {}, claimsPolicy);
    const claimsSource = deps.claimsSource || 'provider';
    const payload = buildAuthPayload({
      authExportJson: { users },
      hashConfig,
      customClaims,
      claimsSource
    });
    if (users.length > 0 && claimsSource === 'none') {
      throw new Error('export --execute מסורב: claims_source=none עם משתמשים — גיבוי Auth חלקי אסור');
    }
    const encrypted = encryptAuthJson(JSON.stringify(payload), passphrase);
    fs.writeFileSync(encryptedFile, encrypted, { flag: 'wx' });
    const manifest = backupManifest(action.project, encrypted, payload, (options.now ? options.now() : new Date()).toISOString());
    writeJsonAtomic(encryptedFile + '.manifest.json', manifest);
    let claimsOut = null;
    if (payload.includes_custom_claims && deps.splitClaimsFile) {
      const claimsPayload = buildClaimsExport(customClaims);
      const claimsEnc = encryptAuthJson(JSON.stringify(claimsPayload), passphrase);
      fs.writeFileSync(claimsFile, claimsEnc, { flag: 'wx' });
      writeJsonAtomic(claimsFile + '.manifest.json', {
        schema: CLAIMS_SCHEMA,
        project: action.project,
        created_at: manifest.created_at,
        claims: claimsPayload.count,
        encrypted_sha256: sha256(claimsEnc),
        encrypted_bytes: claimsEnc.length
      });
      claimsOut = claimsFile;
    }
    return {
      ok: true,
      file: encryptedFile,
      manifest: encryptedFile + '.manifest.json',
      claims_file: claimsOut,
      users: manifest.users,
      includes_custom_claims: manifest.includes_custom_claims
    };
  } catch (error) {
    throw safeError(error, [hashConfig.hash_key, hashConfig.salt_separator, passphrase]);
  } finally {
    if (plainTmp) try { fs.rmSync(plainTmp, { force: true }); } catch { /* ignore */ }
  }
}

export async function runVerify(action, options = {}) {
  const env = options.env || process.env;
  const passphrase = secret(env[PASSPHRASE_ENV], PASSPHRASE_ENV);
  const encrypted = fs.readFileSync(action.file);
  const plainBytes = decryptAuthJson(encrypted, passphrase);
  const payload = parsePayload(plainBytes);
  return {
    ok: true,
    users: countUsers(payload),
    encrypted_sha256: sha256(encrypted),
    includes_custom_claims: !!payload.includes_custom_claims,
    hash_config_embedded: true,
    fingerprints: hashConfigFingerprints(payload.hash_config)
  };
}

/**
 * Import to allowlisted demo target only. Hash params come from the blob.
 * deps.setCustomUserClaims(uid, claims) optional for permissions restore.
 */
export async function runImport(action, options = {}, deps = {}) {
  const env = options.env || process.env;
  refuseImportTarget(action.target, options);
  if (!action.execute) {
    return { ok: true, dry_run: true, action, network: 'not contacted' };
  }
  const allow = String(env.RESQ_AUTH_IMPORT_TARGET_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!allow.includes(action.target)) {
    throw new Error('יעד הייבוא אינו ב-RESQ_AUTH_IMPORT_TARGET_ALLOWLIST');
  }
  const passphrase = secret(env[PASSPHRASE_ENV], PASSPHRASE_ENV);
  const encrypted = fs.readFileSync(action.file);
  const payload = parsePayload(decryptAuthJson(encrypted, passphrase));
  const hashConfig = payload.hash_config;
  const usersJson = JSON.stringify({ users: payload.auth_export.users });
  const temp = path.join(os.tmpdir(), 'resq-auth-import-' + process.pid + '.json');
  const extras = [hashConfig.hash_key, hashConfig.salt_separator, passphrase];
  try {
    fs.writeFileSync(temp, usersJson, { flag: 'wx' });
    if (typeof deps.authImportFn === 'function') {
      await deps.authImportFn({
        target: action.target,
        usersFile: temp,
        hashConfig
      });
    } else if (deps.allowFirebaseCli) {
      // ARGV RISK: hash key/separator must appear on CLI flags — redacted on failure.
      runFirebase([
        'auth:import', temp, '--project', action.target, '--hash-algo=SCRYPT',
        '--hash-key=' + hashConfig.hash_key,
        '--salt-separator=' + hashConfig.salt_separator,
        '--rounds=' + String(hashConfig.rounds),
        '--mem-cost=' + String(hashConfig.mem_cost)
      ], extras);
    } else {
      throw new Error('import אמיתי דורש authImportFn מוזרק או allowFirebaseCli מפורש');
    }
    let claimsRestored = 0;
    if (payload.includes_custom_claims && typeof deps.setCustomUserClaims === 'function') {
      for (const [uid, claims] of Object.entries(payload.custom_claims || {})) {
        await deps.setCustomUserClaims(uid, claims, { target: action.target });
        claimsRestored += 1;
      }
    }
    return {
      ok: true,
      imported_users: countUsers(payload),
      claims_restored: claimsRestored,
      target: action.target
    };
  } catch (error) {
    throw safeError(error, extras);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
  }
}


/**
 * Admin SDK claims reader — dynamic import only. Safe for execute path.
 * Reads customClaims per uid via auth.getUser (never logs claim bodies).
 */
export async function createAdminClaimsProvider(projectId, options = {}) {
  const root = options.root || ROOT;
  const require = createRequire(pathToFileURL(path.join(root, 'functions', 'package.json')).href);
  const resolved = require.resolve('firebase-admin');
  const imported = await import(pathToFileURL(resolved).href);
  const admin = imported.default || imported;
  if (!admin.apps.length) admin.initializeApp(projectId ? { projectId } : undefined);
  const auth = admin.auth();
  return async function claimsProvider(users) {
    const out = {};
    const list = Array.isArray(users) ? users : [];
    for (const user of list) {
      const uid = user && (user.localId || user.uid);
      if (!uid) continue;
      try {
        const record = await auth.getUser(uid);
        out[uid] = record.customClaims && typeof record.customClaims === 'object'
          ? record.customClaims
          : {};
      } catch (error) {
        const code = error && error.code;
        if (code === 'auth/user-not-found') {
          out[uid] = {};
          continue;
        }
        throw error;
      }
    }
    return out;
  };
}

async function main() {
  const command = process.argv[2] || '';
  const options = argMap(process.argv.slice(3));
  const action = plan(command, options);
  if (!action.execute) {
    console.log(JSON.stringify({ ok: true, dry_run: true, action }, null, 2));
    return;
  }
  if (command === 'export') {
    const claimsProvider = await createAdminClaimsProvider(action.project);
    console.log(JSON.stringify(await runExport(action, { env: process.env }, {
      allowFirebaseCli: true,
      claimsProvider,
      claimsSource: 'admin.getUser',
      splitClaimsFile: true
    })));
    return;
  }
  if (command === 'verify') {
    console.log(JSON.stringify(await runVerify(action, { env: process.env })));
    return;
  }
  console.log(JSON.stringify(await runImport(action, { env: process.env }, { allowFirebaseCli: true })));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(redactSecrets(error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
}
