#!/usr/bin/env node
/* ======================================================================
 * ops-backup-seal — AES-256-GCM sealing for Firestore snapshot documents.
 *
 * Seals documents.jsonl into documents.jsonl.enc with a passphrase-derived
 * key. Never stores the passphrase. Integrity can be checked via checksum
 * and size without decrypting content.
 * ====================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

export const SEAL_SCHEMA = 'resq-firestore-seal-v1';
export const SEAL_PASSPHRASE_ENV = 'RESQ_BACKUP_SEAL_PASSPHRASE';
export const SEAL_PASSPHRASE_MIN_LENGTH = 20;
export const SEALED_FILE_NAME = 'documents.jsonl.enc';
export const PLAIN_FILE_NAME = 'documents.jsonl';

const sha256Hex = (input) => createHash('sha256').update(input).digest('hex');

export function requireSealPassphrase(passphrase, label = SEAL_PASSPHRASE_ENV) {
  const clean = String(passphrase || '');
  if (clean.length < SEAL_PASSPHRASE_MIN_LENGTH) {
    throw new Error(label + ' חסר או קצר מדי (לפחות ' + SEAL_PASSPHRASE_MIN_LENGTH + ' תווים) — לא נשמר ולא נרשם בלוג');
  }
  return clean;
}

export function deriveSealKey(passphrase, salt) {
  return scryptSync(requireSealPassphrase(passphrase), salt, 32);
}

/** Encrypt plaintext Buffer → sealed box object (JSON-serializable). */
export function sealBuffer(plain, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveSealKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    schema: SEAL_SCHEMA,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
    plain_sha256: sha256Hex(plain),
    plain_bytes: Buffer.byteLength(plain)
  };
}

/** Decrypt sealed box → plaintext Buffer. Throws on auth failure. */
export function unsealBuffer(box, passphrase) {
  if (!box || box.schema !== SEAL_SCHEMA || box.kdf !== 'scrypt' || box.cipher !== 'aes-256-gcm') {
    throw new Error('פורמט חותם גיבוי אינו מוכר');
  }
  if (typeof box.salt !== 'string' || typeof box.iv !== 'string' ||
      typeof box.tag !== 'string' || typeof box.data !== 'string') {
    throw new Error('חותם גיבוי חסר שדות חובה');
  }
  const key = deriveSealKey(passphrase, Buffer.from(box.salt, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(box.data, 'base64')),
    decipher.final()
  ]);
  if (box.plain_sha256 && sha256Hex(plain) !== box.plain_sha256) {
    throw new Error('טביעת plaintext אחרי פענוח אינה תואמת');
  }
  if (Number.isInteger(box.plain_bytes) && box.plain_bytes !== plain.length) {
    throw new Error('גודל plaintext אחרי פענוח אינו תואם');
  }
  return plain;
}

export function sealedFileStats(encBytes) {
  return {
    enc_bytes: Buffer.byteLength(encBytes),
    enc_sha256: sha256Hex(encBytes)
  };
}

/**
 * Seal documents.jsonl in place: write documents.jsonl.enc, remove plaintext.
 * Returns seal metadata for the snapshot manifest (no passphrase).
 */

/**
 * Seal documents from an in-memory buffer: write ONLY documents.jsonl.enc
 * via temp+rename. Never writes plaintext into the snapshot directory.
 */
export function sealDocumentsBuffer(dir, plainUtf8OrBuffer, passphrase) {
  const encPath = path.join(dir, SEALED_FILE_NAME);
  const plainPath = path.join(dir, PLAIN_FILE_NAME);
  if (fs.existsSync(encPath)) throw new Error(SEALED_FILE_NAME + ' כבר קיים');
  if (fs.existsSync(plainPath)) {
    throw new Error(PLAIN_FILE_NAME + ' לא אמור להתקיים לפני sealDocumentsBuffer');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const plain = Buffer.isBuffer(plainUtf8OrBuffer)
    ? plainUtf8OrBuffer
    : Buffer.from(String(plainUtf8OrBuffer), 'utf8');
  const box = sealBuffer(plain, passphrase);
  const encBytes = Buffer.from(JSON.stringify(box));
  const stats = sealedFileStats(encBytes);
  const tmp = encPath + '.tmp-' + process.pid + '-' + Date.now();
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, encBytes);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, encPath);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort */ }
    try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath); } catch { /* best-effort */ }
    throw error;
  }
  return {
    sealed: true,
    sealed_file: SEALED_FILE_NAME,
    seal_schema: SEAL_SCHEMA,
    enc_bytes: stats.enc_bytes,
    enc_sha256: stats.enc_sha256,
    plain_bytes: box.plain_bytes,
    plain_sha256: box.plain_sha256
  };
}

export function sealDocumentsFile(dir, passphrase) {
  const plainPath = path.join(dir, PLAIN_FILE_NAME);
  const encPath = path.join(dir, SEALED_FILE_NAME);
  if (!fs.existsSync(plainPath)) throw new Error(PLAIN_FILE_NAME + ' חסר לפני חתימה');
  if (fs.existsSync(encPath)) throw new Error(SEALED_FILE_NAME + ' כבר קיים');
  const plain = fs.readFileSync(plainPath);
  let box;
  let encBytes;
  let stats;
  try {
    box = sealBuffer(plain, passphrase);
    encBytes = Buffer.from(JSON.stringify(box));
    stats = sealedFileStats(encBytes);
    const fd = fs.openSync(encPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, encBytes);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    // Fail-closed: never leave plaintext in the snapshot dir after we have read it.
    try { if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath); } catch { /* best-effort */ }
  }
  if (fs.existsSync(plainPath)) throw new Error('מחיקת plaintext נכשלה אחרי חתימה');
  return {
    sealed: true,
    sealed_file: SEALED_FILE_NAME,
    seal_schema: SEAL_SCHEMA,
    enc_bytes: stats.enc_bytes,
    enc_sha256: stats.enc_sha256,
    plain_bytes: box.plain_bytes,
    plain_sha256: box.plain_sha256
  };
}

/**
 * Verify sealed artifact without decrypting (checksum + size only).
 */
export function verifySealedFile(dir, manifestDocuments) {
  const encPath = path.join(dir, SEALED_FILE_NAME);
  if (!fs.existsSync(encPath)) return { ok: false, errors: [SEALED_FILE_NAME + ' חסר'] };
  if (fs.existsSync(path.join(dir, PLAIN_FILE_NAME))) {
    return { ok: false, errors: [PLAIN_FILE_NAME + ' לא אמור להתקיים לצד קובץ חתום'] };
  }
  const encBytes = fs.readFileSync(encPath);
  const errors = [];
  if (!manifestDocuments || typeof manifestDocuments !== 'object') {
    errors.push('manifest.documents חסר לאימות חותם');
    return { ok: false, errors };
  }
  if (manifestDocuments.enc_bytes !== encBytes.length) {
    errors.push('enc_bytes אינו תואם');
  }
  if (manifestDocuments.enc_sha256 !== sha256Hex(encBytes)) {
    errors.push('enc_sha256 אינו תואם');
  }
  try {
    const box = JSON.parse(encBytes.toString('utf8'));
    if (box.schema !== SEAL_SCHEMA) errors.push('seal schema לא נתמך');
    if (manifestDocuments.sha256 && box.plain_sha256 &&
        manifestDocuments.sha256 !== box.plain_sha256) {
      errors.push('plain_sha256 בחותם אינו תואם למניפסט');
    }
  } catch {
    errors.push('קובץ חתום אינו JSON תקין');
  }
  return { ok: !errors.length, errors, enc_bytes: encBytes.length, enc_sha256: sha256Hex(encBytes) };
}

/**
 * Decrypt to a temp file. On any failure: no plaintext leftover.
 */
export function unsealDocumentsToTemp(dir, passphrase) {
  const encPath = path.join(dir, SEALED_FILE_NAME);
  const encBytes = fs.readFileSync(encPath);
  let tempDir = null;
  let tempFile = null;
  try {
    let box;
    try { box = JSON.parse(encBytes.toString('utf8')); }
    catch (error) { throw new Error('קובץ חותם פגום (JSON): ' + error.message); }
    const plain = unsealBuffer(box, passphrase);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-seal-'));
    tempFile = path.join(tempDir, PLAIN_FILE_NAME);
    const fd = fs.openSync(tempFile, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, plain);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { tempDir, tempFile, plain_bytes: plain.length, plain_sha256: sha256Hex(plain) };
  } catch (error) {
    cleanupUnsealTemp(tempDir, tempFile);
    throw error;
  }
}

export function cleanupUnsealTemp(tempDir, tempFile) {
  try {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  } catch { /* best-effort */ }
  try {
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

export { sha256Hex };
