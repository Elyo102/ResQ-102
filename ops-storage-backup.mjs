#!/usr/bin/env node
/* ======================================================================
 * ops-storage-backup — incremental Cloud Storage backup for ResQ HR private
 * objects (generation-aware). Default is dry-run (no SDK, no network).
 *
 * Known production bucket (from functions/index.js):
 *   station-102-hr-private-europe-west1
 * Path template (from functions/hr-attachments.js):
 *   hr-private/{station_id}/{parent_kind}/{parent_id}/{attachment_id}
 *
 * Real medical/PII bytes never appear in tests; adapters are injectable.
 * Object bytes are AES-256-GCM sealed via ops-backup-seal (passphrase env only).
 * Partial runs are marked FAILED/PARTIAL — never success.
 * Restore targets refuse station-102 and .firebaserc default.
 *
 * storage.rules: not present in repo; adding invented rules is blocked
 * (OWNER_DECISION) — see BACKUP-MAP.md. Admin SDK bypasses rules anyway.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import os from 'node:os';
import {
  sealBuffer, unsealBuffer, requireSealPassphrase, sealedFileStats,
  SEAL_PASSPHRASE_ENV, SEAL_SCHEMA
} from './ops-backup-seal.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = 'resq-storage-backup-v2';
export const MANIFEST_NAME = 'storage-manifest.json';
export const STATE_NAME = 'storage-backup-state.json';
export const DEFAULT_BUCKET = 'station-102-hr-private-europe-west1';
export const DEFAULT_PREFIX = 'hr-private/';
export const HARD_DENY_TARGETS = Object.freeze(['station-102']);
export const OBJECT_PATH_RE = /^hr-private\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/;

const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');
export { sha256Hex, SEAL_PASSPHRASE_ENV, SEAL_SCHEMA };

export function denyTargets(options = {}) {
  const deny = new Set(HARD_DENY_TARGETS);
  try {
    const root = options.root || HERE;
    const rc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8'));
    const projects = rc && rc.projects ? rc.projects : {};
    if (typeof projects.default === 'string' && projects.default) deny.add(projects.default);
  } catch { /* hard list remains */ }
  return deny;
}

export function refuseRestoreTarget(target, options = {}) {
  if (!target || typeof target !== 'string') throw new Error('יעד שחזור Storage חסר');
  if (denyTargets(options).has(target)) {
    throw new Error('סירוב קשיח: ' + target + ' אינו יעד שחזור Storage');
  }
}

export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv.slice() : [];
  const command = list.shift();
  if (!command || !['backup', 'verify', 'restore', 'plan'].includes(command)) {
    throw new Error('פקודה לא מוכרת. אפשרויות: backup | verify | restore | plan');
  }
  const out = {
    command,
    bucket: DEFAULT_BUCKET,
    prefix: DEFAULT_PREFIX,
    out: '',
    set: '',
    target: '',
    confirmTarget: '',
    project: '',
    dryRun: true,
    execute: false
  };
  const seen = new Set();
  while (list.length) {
    const key = list.shift();
    if (seen.has(key)) throw new Error('ארגומנט כפול: ' + key);
    seen.add(key);
    const next = () => {
      const v = list.shift();
      if (v === undefined || v.startsWith('--')) throw new Error('חסר ערך אחרי ' + key);
      return v;
    };
    switch (key) {
      case '--bucket': out.bucket = next(); break;
      case '--prefix': out.prefix = next(); break;
      case '--out': out.out = next(); break;
      case '--set': out.set = next(); break;
      case '--target': out.target = next(); break;
      case '--confirm-target': out.confirmTarget = next(); break;
      case '--project': out.project = next(); break;
      case '--dry-run': out.dryRun = true; break;
      case '--execute': out.execute = true; break;
      default: throw new Error('פרמטר לא מוכר: ' + key);
    }
  }
  if (seen.has('--dry-run') && seen.has('--execute')) {
    throw new Error('--dry-run ו---execute סותרים זה את זה');
  }
  if (out.execute) out.dryRun = false;
  else out.dryRun = true;
  if (command === 'backup' || command === 'plan') {
    if (!out.out && !out.dryRun) throw new Error(command + ' דורש --out');
    if (!out.out) out.out = path.join(HERE, '_גיבוי-storage', 'planned');
  }
  if (command === 'verify' || command === 'restore') {
    if (!out.set) throw new Error(command + ' דורש --set');
  }
  if (command === 'restore') {
    if (!out.target) throw new Error('restore דורש --target');
    if (out.execute) {
      if (!seen.has('--confirm-target')) throw new Error('--execute דורש --confirm-target זהה ל---target');
      if (out.confirmTarget !== out.target) throw new Error('--confirm-target אינו זהה ל---target');
    }
  }
  return out;
}

export function objectKey(name, generation) {
  return String(name) + '#' + String(generation);
}

export function isValidObjectName(name, prefix = DEFAULT_PREFIX) {
  if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
  return OBJECT_PATH_RE.test(name);
}

export function readState(dir) {
  const file = path.join(dir, STATE_NAME);
  if (!fs.existsSync(file)) return { schema: SCHEMA, completed: [], cursor: null, status: 'new' };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeState(dir, state) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, STATE_NAME);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file);
}

export function readManifest(dir) {
  const file = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(file)) throw new Error(MANIFEST_NAME + ' חסר');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, MANIFEST_NAME);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file);
}

/**
 * Write sealed object bytes only. Never leaves plaintext on disk.
 * On any failure: remove temp/partial files.
 */
function durableObjectFile(dir, name, generation, plainBytes, passphrase) {
  const safe = Buffer.from(objectKey(name, generation)).toString('base64url');
  const objectsDir = path.join(dir, 'objects');
  fs.mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
  const dest = path.join(objectsDir, safe + '.bin.enc');
  if (fs.existsSync(dest)) throw new Error('אובייקט גיבוי כבר קיים (אין דריסה שקטה): ' + name + '#' + generation);
  const tmp = dest + '.tmp-' + process.pid + '-' + Date.now();
  try {
    const box = sealBuffer(plainBytes, passphrase);
    const encBytes = Buffer.from(JSON.stringify(box));
    const stats = sealedFileStats(encBytes);
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, encBytes);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dest);
    return {
      relative: path.join('objects', safe + '.bin.enc'),
      enc_sha256: stats.enc_sha256,
      enc_bytes: stats.enc_bytes,
      plain_sha256: box.plain_sha256,
      plain_bytes: box.plain_bytes,
      encrypted: true,
      seal_schema: SEAL_SCHEMA
    };
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort */ }
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* best-effort */ }
    throw error;
  }
}

/** Required list metadata fields — fetch getMetadata only when missing. */
export function listMetaMissingRequired(meta) {
  if (!meta || typeof meta !== 'object') return true;
  if (meta.generation === undefined || meta.generation === null || meta.generation === '') return true;
  if (meta.size === undefined || meta.size === null || meta.size === '') return true;
  return false;
}

/**
 * Map GCS list File-like entries to backup object metadata.
 * Calls fetchMetadata only when list metadata lacks required fields (kills N+1).
 */
export async function mapListedFilesToObjects(files, options = {}) {
  const fetchMetadata = options.fetchMetadata;
  let fetchCalls = 0;
  const objects = [];
  for (const file of files || []) {
    const name = file && (file.name || (file.metadata && file.metadata.name));
    let meta = { ...(file && file.metadata ? file.metadata : {}) };
    if (listMetaMissingRequired(meta)) {
      if (typeof fetchMetadata !== 'function') {
        throw new Error('מטא-דאטה חסרה מ-list ואין fetchMetadata');
      }
      fetchCalls += 1;
      const fresh = await fetchMetadata(file);
      meta = { ...meta, ...(fresh || {}) };
    }
    objects.push({
      name: name,
      generation: String(meta.generation || ''),
      size: Number(meta.size || 0),
      contentType: meta.contentType || 'application/octet-stream',
      md5Hash: meta.md5Hash || '',
      crc32c: meta.crc32c || '',
      updated: meta.updated || '',
      metadata: meta.metadata || {}
    });
  }
  return { objects, fetchCalls };
}

/**
 * Adapter contract (injectable):
 *   listObjects({ prefix, pageToken }) -> { objects:[{name,generation,size,contentType,md5Hash,crc32c,updated,metadata?}], nextPageToken }
 *   downloadObject({ name, generation }) -> Buffer   (execute backup only)
 *   getMetadata({ name, generation }) -> same shape as list item
 *   uploadObject({ name, generation, bytes, contentType, metadata, ifGenerationMatch })
 *     — must refuse overwrite when ifGenerationMatch===0 and object exists
 */
export async function runBackup(args, options = {}) {
  if (args.dryRun) {
    return {
      dryRun: true,
      bucket: args.bucket,
      prefix: args.prefix,
      destination: path.resolve(args.out),
      network: 'not contacted',
      sdk: 'not loaded',
      opens_content: false
    };
  }
  const api = options.storageApi;
  if (!api || typeof api.listObjects !== 'function') {
    throw new Error('backup אמיתי דורש storageApi מוזרק (אין הורדת production בבדיקות)');
  }
  const env = options.env || process.env;
  const passphrase = requireSealPassphrase(env[SEAL_PASSPHRASE_ENV]);
  const dest = path.resolve(args.out);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const state = readState(dest);
  const completed = new Set(Array.isArray(state.completed) ? state.completed : []);
  const entries = Array.isArray(state.entries) ? state.entries.slice() : [];
  const nowIso = (options.now ? options.now() : new Date()).toISOString();
  // cursor is the pageToken used to FETCH the page currently being processed
  // (page-start token). It advances to nextPageToken only after the whole page
  // has been attempted — so a mid-page crash resumes the same page and skips
  // via the completed Set, instead of silently dropping remaining siblings.
  let pageToken = state.cursor || null;
  let pageStartToken = pageToken;
  let listed = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  const persistProgress = (status, cursor) => {
    writeState(dest, {
      schema: SCHEMA,
      status,
      bucket: args.bucket,
      prefix: args.prefix,
      cursor,
      completed: [...completed],
      entries,
      updated_at: nowIso
    });
  };

  try {
    do {
      pageStartToken = pageToken;
      const page = await api.listObjects({ prefix: args.prefix, pageToken });
      const objects = Array.isArray(page.objects) ? page.objects : [];
      for (const obj of objects) {
        listed += 1;
        if (!isValidObjectName(obj.name, args.prefix)) {
          failed += 1;
          errors.push('נתיב לא תואם לתבנית hr-private: ' + String(obj.name));
          persistProgress('IN_PROGRESS', pageStartToken);
          if (typeof options.afterObjectHook === 'function') {
            options.afterObjectHook({ obj, key: null, pageStartToken, failed: true });
          }
          continue;
        }
        const key = objectKey(obj.name, obj.generation);
        if (completed.has(key)) {
          skipped += 1;
          if (typeof options.afterObjectHook === 'function') {
            options.afterObjectHook({ obj, key, pageStartToken, skipped: true });
          }
          continue;
        }
        try {
          // Content opened only on execute path with adapter; tests may stub download.
          const bytes = await api.downloadObject({ name: obj.name, generation: obj.generation });
          if (!Buffer.isBuffer(bytes)) throw new Error('downloadObject חייב להחזיר Buffer');
          if (Number.isFinite(Number(obj.size)) && bytes.length !== Number(obj.size)) {
            throw new Error('גודל הבייטים אינו תואם למטא-דאטה');
          }
          const stored = durableObjectFile(dest, obj.name, obj.generation, bytes, passphrase);
          const entry = {
            name: obj.name,
            generation: String(obj.generation),
            size: stored.plain_bytes,
            contentType: obj.contentType || null,
            md5Hash: obj.md5Hash || null,
            crc32c: obj.crc32c || null,
            backup_time: nowIso,
            backup_destination: stored.relative,
            encrypted: true,
            seal_schema: stored.seal_schema,
            content_sha256: stored.enc_sha256,
            enc_bytes: stored.enc_bytes,
            plain_sha256: stored.plain_sha256,
            firestore_link: {
              // Preserve link between Firestore attachment metadata and object generation.
              object_path: obj.name,
              object_generation: String(obj.generation),
              station_id: obj.name.split('/')[1] || null,
              parent_kind: obj.name.split('/')[2] || null,
              parent_id: obj.name.split('/')[3] || null,
              attachment_id: obj.name.split('/')[4] || null
            }
          };
          entries.push(entry);
          completed.add(key);
          copied += 1;
          // Keep page-start token until every object on this page is attempted.
          persistProgress('IN_PROGRESS', pageStartToken);
        } catch (error) {
          failed += 1;
          errors.push(obj.name + '#' + obj.generation + ': ' + error.message);
          persistProgress('IN_PROGRESS', pageStartToken);
        }
        if (typeof options.afterObjectHook === 'function') {
          options.afterObjectHook({ obj, key, pageStartToken });
        }
      }
      // Advance cursor only after the entire page has been attempted.
      pageToken = page.nextPageToken || null;
      persistProgress('IN_PROGRESS', pageToken);
    } while (pageToken);
  } catch (error) {
    // Interrupted before finishing the listing loop: leave IN_PROGRESS (not COMPLETE).
    persistProgress('IN_PROGRESS', pageStartToken);
    throw error;
  }

  const status = failed > 0 ? (copied > 0 || skipped > 0 ? 'PARTIAL' : 'FAILED') : 'COMPLETE';
  if (status !== 'COMPLETE') {
    // Explicit: partial/failed is never reported as success.
  }
  const manifest = {
    schema: SCHEMA,
    status,
    bucket: args.bucket,
    prefix: args.prefix,
    source_project: args.project || null,
    created_at: nowIso,
    sealed: true,
    seal_schema: SEAL_SCHEMA,
    seal_passphrase_env: SEAL_PASSPHRASE_ENV,
    counts: { listed, copied, skipped, failed, entries: entries.length },
    errors,
    objects: entries
  };
  writeManifest(dest, manifest);
  writeState(dest, {
    schema: SCHEMA,
    status,
    bucket: args.bucket,
    prefix: args.prefix,
    cursor: null,
    completed: [...completed],
    entries,
    updated_at: nowIso
  });
  return {
    ok: status === 'COMPLETE',
    status,
    destination: dest,
    counts: manifest.counts,
    errors
  };
}

export async function runVerify(args, options = {}) {
  const dir = path.resolve(args.set);
  const manifest = readManifest(dir);
  const errors = [];
  if (manifest.schema !== SCHEMA) errors.push('סכימה לא נתמכת');
  if (!['COMPLETE', 'PARTIAL', 'FAILED'].includes(manifest.status)) errors.push('status לא תקין');
  if (manifest.status === 'COMPLETE' && manifest.counts && manifest.counts.failed > 0) {
    errors.push('status=COMPLETE אך יש כשלונות');
  }
  const api = options.storageApi;
  const env = options.env || process.env;
  const passphrase = env[SEAL_PASSPHRASE_ENV] ? requireSealPassphrase(env[SEAL_PASSPHRASE_ENV]) : null;
  for (const obj of manifest.objects || []) {
    const file = path.join(dir, obj.backup_destination);
    if (!fs.existsSync(file)) {
      errors.push('קובץ גיבוי חסר: ' + obj.name);
      continue;
    }
    if (obj.encrypted !== true) {
      errors.push('אובייקט גיבוי אינו מוצפן: ' + obj.name);
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (Number.isInteger(obj.enc_bytes) && bytes.length !== obj.enc_bytes) {
      errors.push('enc_bytes מקומי לא תואם: ' + obj.name);
    }
    if (obj.content_sha256 && sha256Hex(bytes) !== obj.content_sha256) {
      errors.push('enc_sha256 מקומי לא תואם: ' + obj.name);
    }
    let box = null;
    try {
      box = JSON.parse(bytes.toString('utf8'));
      if (!box || box.schema !== SEAL_SCHEMA) errors.push('seal schema לא נתמך: ' + obj.name);
      if (obj.plain_sha256 && box.plain_sha256 && obj.plain_sha256 !== box.plain_sha256) {
        errors.push('plain_sha256 בחותם אינו תואם למניפסט: ' + obj.name);
      }
    } catch {
      errors.push('קובץ חתום אינו JSON תקין: ' + obj.name);
    }
    // Authenticated integrity check without restore when passphrase present.
    if (passphrase && box) {
      try {
        unsealBuffer(box, passphrase);
      } catch {
        errors.push('integrity/פענוח נכשל: ' + obj.name);
      }
    }
    // Optional compare to live/adapter metadata (verify --compare-remote). Restore uses local-only.
    if (options.compareRemote && api && typeof api.getMetadata === 'function') {
      const meta = await api.getMetadata({ name: obj.name, generation: obj.generation });
      if (!meta) errors.push('מטא-דאטה חסרה במקור: ' + obj.name);
      else {
        if (String(meta.generation) !== String(obj.generation)) errors.push('generation לא תואם: ' + obj.name);
        if (meta.md5Hash && obj.md5Hash && meta.md5Hash !== obj.md5Hash) errors.push('md5Hash לא תואם: ' + obj.name);
        if (meta.crc32c && obj.crc32c && meta.crc32c !== obj.crc32c) errors.push('crc32c לא תואם: ' + obj.name);
        if (Number.isFinite(Number(meta.size)) && Number.isInteger(obj.size) && Number(meta.size) !== obj.size) {
          errors.push('גודל מקור לא תואם ל-plain_bytes: ' + obj.name);
        }
      }
    }
    if (!obj.firestore_link || obj.firestore_link.object_generation !== String(obj.generation)) {
      errors.push('קישור Firestore/generation חסר או שבור: ' + obj.name);
    }
  }
  if (manifest.status === 'PARTIAL' || manifest.status === 'FAILED') {
    // Verification may still inspect what exists, but overall ok is false.
    return { ok: false, status: manifest.status, errors: errors.length ? errors : ['גיבוי אינו COMPLETE'] };
  }
  return { ok: !errors.length, status: manifest.status, errors, objects: (manifest.objects || []).length };
}


/** Compare GCS generation ids numerically when possible (BigInt), else lexicographically. */
export function compareGeneration(a, b) {
  try {
    const ba = BigInt(a);
    const bb = BigInt(b);
    if (ba === bb) return 0;
    return ba > bb ? 1 : -1;
  } catch {
    return String(a).localeCompare(String(b));
  }
}

/**
 * Restore must write the newest generation per object name only.
 * Multiple generations may exist in the archive; ifGenerationMatch:0 would
 * skip newer ones if an older generation was uploaded first.
 */
export function selectNewestGenerationPerName(objects) {
  const list = Array.isArray(objects) ? objects.slice() : [];
  list.sort((a, b) => {
    const byName = String(a.name).localeCompare(String(b.name));
    if (byName !== 0) return byName;
    return -compareGeneration(a.generation, b.generation); // generation desc
  });
  const seen = new Set();
  const out = [];
  for (const obj of list) {
    if (seen.has(obj.name)) continue;
    seen.add(obj.name);
    out.push(obj);
  }
  return out;
}

export async function runRestore(args, options = {}) {
  refuseRestoreTarget(args.target, options);
  if (args.dryRun) {
    const manifest = readManifest(path.resolve(args.set));
    return {
      dryRun: true,
      target: args.target,
      objects: (manifest.objects || []).length,
      network: 'not contacted',
      writes: 'none'
    };
  }
  const env = options.env || process.env;
  const allow = String(env.RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allow.includes(args.target)) {
    throw new Error('יעד השחזור אינו ב-RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST');
  }
  const api = options.storageApi;
  if (!api || typeof api.uploadObject !== 'function') {
    throw new Error('restore אמיתי דורש storageApi.uploadObject');
  }
  const dir = path.resolve(args.set);
  const passphrase = requireSealPassphrase(env[SEAL_PASSPHRASE_ENV]);
  const verification = await runVerify({ set: dir, command: 'verify' }, { ...options, env });
  if (!verification.ok) throw new Error('הסט נכשל באימות לפני שחזור: ' + verification.errors.join('; '));
  const manifest = readManifest(dir);
  const written = [];
  const skipped_exists = [];
  const errors = [];
  // Newest generation per name only — older gens stay in archive but are not restored first.
  const restoreObjects = selectNewestGenerationPerName(manifest.objects || []);
  for (const obj of restoreObjects) {
    const encPath = path.join(dir, obj.backup_destination);
    let plain = null;
    let tempFile = null;
    try {
      const encBytes = fs.readFileSync(encPath);
      const box = JSON.parse(encBytes.toString('utf8'));
      plain = unsealBuffer(box, passphrase);
      await api.uploadObject({
        name: obj.name,
        generation: obj.generation,
        bytes: plain,
        contentType: obj.contentType,
        metadata: {
          resq_firestore_link: JSON.stringify(obj.firestore_link || {}),
          resq_source_generation: String(obj.generation)
        },
        ifGenerationMatch: 0 // prevent silent overwrite
      });
      written.push(obj.name);
    } catch (error) {
      if (error && (error.code === 'precondition-failed' || /exists|precondition/i.test(String(error.message)))) {
        skipped_exists.push(obj.name);
      } else {
        errors.push(obj.name + ': ' + (error && error.message ? error.message : String(error)));
      }
    } finally {
      plain = null;
      if (tempFile) {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* best-effort */ }
      }
    }
  }
  return {
    ok: !errors.length,
    target: args.target,
    written: written.length,
    skipped_exists: skipped_exists.length,
    errors
  };
}

export async function runPlan(args, options = {}) {
  if (args.dryRun || !options.storageApi) {
    return {
      dryRun: true,
      bucket: args.bucket,
      prefix: args.prefix,
      note: 'plan dry-run אינו פונה לרשת'
    };
  }
  const api = options.storageApi;
  let pageToken = null;
  let count = 0;
  const sample = [];
  do {
    const page = await api.listObjects({ prefix: args.prefix, pageToken });
    for (const obj of page.objects || []) {
      count += 1;
      if (sample.length < 5) sample.push({ name: obj.name, generation: obj.generation, size: obj.size });
    }
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return { dryRun: false, bucket: args.bucket, prefix: args.prefix, objects: count, sample };
}


/** Refuse the known production HR private bucket unless explicitly allowed. */
export function refuseProdStorageBucket(bucket, options = {}) {
  const env = options.env || process.env;
  if (bucket !== DEFAULT_BUCKET) return;
  if (String(env.RESQ_STORAGE_ALLOW_PROD_BUCKET || '') === '1') return;
  throw new Error(
    'סירוב: דלי הייצור ' + DEFAULT_BUCKET +
    ' אסור בגיבוי/שחזור execute. השתמש בדלי demo או הגדר RESQ_STORAGE_ALLOW_PROD_BUCKET=1 במודע (לא מומלץ).'
  );
}

/**
 * Lazy Admin Storage adapter — dynamic import only. Call only on --execute.
 * Contract matches injectable storageApi used by tests.
 */
export async function loadStorageApi(bucketName, options = {}) {
  const root = options.root || HERE;
  const require = createRequire(pathToFileURL(path.join(root, 'functions', 'package.json')).href);
  let resolved;
  try {
    resolved = require.resolve('firebase-admin');
  } catch {
    throw new Error('firebase-admin אינו מותקן תחת functions/ — הרץ npm install ב-functions');
  }
  const imported = await import(pathToFileURL(resolved).href);
  const admin = imported.default || imported;
  const projectId = options.projectId || undefined;
  if (!admin.apps.length) {
    admin.initializeApp(projectId ? { projectId, storageBucket: bucketName } : { storageBucket: bucketName });
  }
  const bucket = admin.storage().bucket(bucketName);
  const PAGE = 200;
  return {
    async listObjects({ prefix, pageToken }) {
      const query = { prefix: prefix || '', autoPaginate: false, maxResults: PAGE };
      if (pageToken) query.pageToken = pageToken;
      const [files, , apiResponse] = await bucket.getFiles(query);
      const mapped = await mapListedFilesToObjects(files, {
        fetchMetadata: async (file) => {
          const [meta] = await file.getMetadata();
          return meta;
        }
      });
      const nextPageToken = (apiResponse && apiResponse.nextPageToken) || null;
      return { objects: mapped.objects, nextPageToken, fetchMetadataCalls: mapped.fetchCalls };
    },
    async downloadObject({ name, generation }) {
      const file = bucket.file(name, generation ? { generation } : undefined);
      const [buf] = await file.download();
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    },
    async getMetadata({ name, generation }) {
      const file = bucket.file(name, generation ? { generation } : undefined);
      const [meta] = await file.getMetadata();
      return {
        name,
        generation: String(meta.generation || ''),
        size: Number(meta.size || 0),
        contentType: meta.contentType || 'application/octet-stream',
        md5Hash: meta.md5Hash || '',
        crc32c: meta.crc32c || '',
        updated: meta.updated || '',
        metadata: meta.metadata || {}
      };
    },
    async uploadObject({ name, generation, bytes, contentType, metadata, ifGenerationMatch }) {
      const file = bucket.file(name);
      const opts = {
        contentType: contentType || 'application/octet-stream',
        metadata: metadata || {},
        resumable: false,
        validation: 'md5'
      };
      if (ifGenerationMatch === 0 || ifGenerationMatch === '0') {
        opts.preconditionOpts = { ifGenerationMatch: 0 };
      } else if (ifGenerationMatch != null) {
        opts.preconditionOpts = { ifGenerationMatch: Number(ifGenerationMatch) };
      }
      await file.save(bytes, opts);
      return { name, generation: generation || null };
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'backup': {
      if (args.dryRun) {
        console.log(JSON.stringify(await runBackup(args)));
        return;
      }
      refuseProdStorageBucket(args.bucket);
      if (args.project && denyTargets().has(args.project)) {
        throw new Error('סירוב: פרויקט ייצור אסור כמקור גיבוי Storage: ' + args.project);
      }
      const storageApi = await loadStorageApi(args.bucket, { projectId: args.project || undefined });
      console.log(JSON.stringify(await runBackup(args, { storageApi })));
      return;
    }
    case 'verify': {
      const result = await runVerify(args);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'restore': {
      if (args.dryRun) {
        const result = await runRestore(args);
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
        return;
      }
      refuseRestoreTarget(args.target);
      refuseProdStorageBucket(args.bucket);
      const allow = String(process.env.RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (!allow.includes(args.target)) {
        throw new Error('יעד השחזור אינו ב-RESQ_STORAGE_RESTORE_TARGET_ALLOWLIST');
      }
      const storageApi = await loadStorageApi(args.bucket, { projectId: args.target });
      const result = await runRestore(args, { storageApi });
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'plan': {
      if (args.dryRun) {
        console.log(JSON.stringify(await runPlan(args)));
        return;
      }
      refuseProdStorageBucket(args.bucket);
      const storageApi = await loadStorageApi(args.bucket, { projectId: args.project || undefined });
      console.log(JSON.stringify(await runPlan(args, { storageApi })));
      return;
    }
    default:
      throw new Error('פקודה לא מוכרת');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('ops-storage-backup נכשל: ' + error.message);
    process.exitCode = 1;
  });
}
