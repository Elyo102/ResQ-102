import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sealPath = path.resolve(here, '..', 'ops-backup-seal.mjs');
const seal = await import(pathToFileURL(sealPath).href);

let passed = 0;
async function check(name, fn) { await fn(); console.log('PASS ' + name); passed++; }

const PASS = 'unit-test-seal-passphrase!!';

await check('refuse short or missing passphrase', async () => {
  assert.throws(() => seal.requireSealPassphrase(''), /חסר או קצר/);
  assert.throws(() => seal.requireSealPassphrase('short'), /חסר או קצר/);
  assert.equal(seal.requireSealPassphrase(PASS), PASS);
});

await check('sealBuffer round-trip with random salt+IV; integrity tag', async () => {
  const plain = Buffer.from('line1\nline2\n', 'utf8');
  const box1 = seal.sealBuffer(plain, PASS);
  const box2 = seal.sealBuffer(plain, PASS);
  assert.equal(box1.schema, seal.SEAL_SCHEMA);
  assert.equal(box1.cipher, 'aes-256-gcm');
  assert.notEqual(box1.salt, box2.salt);
  assert.notEqual(box1.iv, box2.iv);
  assert.deepEqual(seal.unsealBuffer(box1, PASS), plain);
  assert.throws(() => seal.unsealBuffer(box1, PASS + 'x'), /./);
});

await check('sealDocumentsFile removes plaintext and verifySealedFile checks checksum without decrypt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-seal-ut-'));
  try {
    fs.writeFileSync(path.join(dir, 'documents.jsonl'), '{"a":1}\n');
    const meta = seal.sealDocumentsFile(dir, PASS);
    assert.equal(meta.sealed, true);
    assert.equal(fs.existsSync(path.join(dir, 'documents.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, 'documents.jsonl.enc')), true);
    const enc = fs.readFileSync(path.join(dir, 'documents.jsonl.enc'));
    assert.equal(meta.enc_bytes, enc.length);
    assert.equal(meta.enc_sha256, seal.sha256Hex(enc));
    const v = seal.verifySealedFile(dir, { enc_bytes: meta.enc_bytes, enc_sha256: meta.enc_sha256, sha256: meta.plain_sha256 });
    assert.equal(v.ok, true);
    // tamper
    fs.writeFileSync(path.join(dir, 'documents.jsonl.enc'), Buffer.concat([enc, Buffer.from('x')]));
    assert.equal(seal.verifySealedFile(dir, { enc_bytes: meta.enc_bytes, enc_sha256: meta.enc_sha256 }).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('decrypt failure cleans temp and leaves no plaintext beside the sealed file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-seal-ut-'));
  try {
    fs.writeFileSync(path.join(dir, 'documents.jsonl'), 'secret-doc\n');
    seal.sealDocumentsFile(dir, PASS);
    assert.throws(() => seal.unsealDocumentsToTemp(dir, 'totally-wrong-passphrase!!'), /./);
    assert.equal(fs.existsSync(path.join(dir, 'documents.jsonl')), false);
    const opened = seal.unsealDocumentsToTemp(dir, PASS);
    assert.equal(fs.readFileSync(opened.tempFile, 'utf8'), 'secret-doc\n');
    seal.cleanupUnsealTemp(opened.tempDir, opened.tempFile);
    assert.equal(fs.existsSync(opened.tempFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('ops-backup-seal: ' + passed + '/' + passed + ' PASS');
