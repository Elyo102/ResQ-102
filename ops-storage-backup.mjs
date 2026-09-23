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
 * Partial runs are marked FAILED/PARTIAL — never success.
 * Restore targets refuse station-102 and .firebaserc default.
 *
 * storage.rules: not present in repo; adding invented rules is blocked
 * (OWNER_DECISION) — see BACKUP-MAP.md. Admin SDK bypasses rules anyway.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = 'resq-storage-backup-v1';
export const MANIFEST_NAME = 'storage-manifest.json';
export const STATE_NAME = 'storage-backup-state.json';
export const DEFAULT_BUCKET = 'station-102-hr-private-europe-west1';
export const DEFAULT_PREFIX = 'hr-private/';
export const HARD_DENY_TARGETS = Object.freeze(['station-102']);
export const OBJECT_PATH_RE = /^hr-private\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/;

const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');
export { sha256Hex };

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

function durableObjectFile(dir, name, generation, bytes) {
  const safe = Buffer.from(objectKey(name, generation)).toString('base64url');
  const objectsDir = path.join(dir, 'objects');
  fs.mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
  const dest = path.join(objectsDir, safe + '.bin');
  if (fs.existsSync(dest)) throw new Error('אובייקט גיבוי כבר קיים (אין דריסה שקטה): ' + name + '#' + generation);
  const fd = fs.openSync(dest, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { relative: path.join('objects', safe + '.bin'), sha256: sha256Hex(bytes), bytes: bytes.length };
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
  const dest = path.resolve(args.out);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const state = readState(dest);
  const completed = new Set(Array.isArray(state.completed) ? state.completed : []);
  const entries = Array.isArray(state.entries) ? state.entries.slice() : [];
  const nowIso = (options.now ? options.now() : new Date()).toISOString();
  let pageToken = state.cursor || null;
  let listed = 0;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  do {
    const page = await api.listObjects({ prefix: args.prefix, pageToken });
    const objects = Array.isArray(page.objects) ? page.objects : [];
    for (const obj of objects) {
      listed += 1;
      if (!isValidObjectName(obj.name, args.prefix)) {
        failed += 1;
        errors.push('נתיב לא תואם לתבנית hr-private: ' + String(obj.name));
        continue;
      }
      const key = objectKey(obj.name, obj.generation);
      if (completed.has(key)) { skipped += 1; continue; }
      try {
        // Content opened only on execute path with adapter; tests may stub download.
        const bytes = await api.downloadObject({ name: obj.name, generation: obj.generation });
        if (!Buffer.isBuffer(bytes)) throw new Error('downloadObject חייב להחזיר Buffer');
        if (Number.isFinite(Number(obj.size)) && bytes.length !== Number(obj.size)) {
          throw new Error('גודל הבייטים אינו תואם למטא-דאטה');
        }
        const stored = durableObjectFile(dest, obj.name, obj.generation, bytes);
        const entry = {
          name: obj.name,
          generation: String(obj.generation),
          size: bytes.length,
          contentType: obj.contentType || null,
          md5Hash: obj.md5Hash || null,
          crc32c: obj.crc32c || null,
          backup_time: nowIso,
          backup_destination: stored.relative,
          content_sha256: stored.sha256,
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
        writeState(dest, {
          schema: SCHEMA,
          status: 'IN_PROGRESS',
          bucket: args.bucket,
          prefix: args.prefix,
          cursor: page.nextPageToken || null,
          completed: [...completed],
          entries,
          updated_at: nowIso
        });
      } catch (error) {
        failed += 1;
        errors.push(obj.name + '#' + obj.generation + ': ' + error.message);
      }
    }
    pageToken = page.nextPageToken || null;
  } while (pageToken);

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
  for (const obj of manifest.objects || []) {
    const file = path.join(dir, obj.backup_destination);
    if (!fs.existsSync(file)) {
      errors.push('קובץ גיבוי חסר: ' + obj.name);
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== obj.size) errors.push('גודל מקומי לא תואם: ' + obj.name);
    if (sha256Hex(bytes) !== obj.content_sha256) errors.push('sha256 מקומי לא תואם: ' + obj.name);
    // Optional compare to live/adapter metadata (verify --compare-remote). Restore uses local-only.
    if (options.compareRemote && api && typeof api.getMetadata === 'function') {
      const meta = await api.getMetadata({ name: obj.name, generation: obj.generation });
      if (!meta) errors.push('מטא-דאטה חסרה במקור: ' + obj.name);
      else {
        if (String(meta.generation) !== String(obj.generation)) errors.push('generation לא תואם: ' + obj.name);
        if (meta.md5Hash && obj.md5Hash && meta.md5Hash !== obj.md5Hash) errors.push('md5Hash לא תואם: ' + obj.name);
        if (meta.crc32c && obj.crc32c && meta.crc32c !== obj.crc32c) errors.push('crc32c לא תואם: ' + obj.name);
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
  const verification = await runVerify({ set: dir, command: 'verify' }, options);
  if (!verification.ok) throw new Error('הסט נכשל באימות לפני שחזור: ' + verification.errors.join('; '));
  const manifest = readManifest(dir);
  const written = [];
  const skipped_exists = [];
  const errors = [];
  for (const obj of manifest.objects || []) {
    const bytes = fs.readFileSync(path.join(dir, obj.backup_destination));
    try {
      await api.uploadObject({
        name: obj.name,
        generation: obj.generation,
        bytes,
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
        errors.push(obj.name + ': ' + error.message);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'backup':
      console.log(JSON.stringify(await runBackup(args)));
      return;
    case 'verify': {
      const result = await runVerify(args);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'restore': {
      const result = await runRestore(args);
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'plan':
      console.log(JSON.stringify(await runPlan(args)));
      return;
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
