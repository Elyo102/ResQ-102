import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBackup, verifySet } from '../ops-disaster-restore.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-memory-backup-test-'));
fs.mkdirSync(path.join(root, 'functions'));
fs.copyFileSync(fileURLToPath(new URL('../functions/backup-policy.js', import.meta.url)), path.join(root, 'functions/backup-policy.js'));
const passphrase = 'synthetic-memory-backup-key-only';
const api = {
  async listCollectionPaths(parent) { return parent ? [] : ['stations']; },
  async listDocuments() { return { documents:[{path:'stations/eilat_102',data:{name:'synthetic'}}] }; }
};
const options = {root, firestoreApi:api, sealPassphrase:passphrase, inMemoryUnseal:true};
const oldMkdtemp = fs.mkdtempSync;
let temporaryAttempts = 0;
fs.mkdtempSync = () => { temporaryAttempts++; throw Error('plaintext temporary directory prohibited'); };
let passed = 0;
function check(condition) { assert.ok(condition); passed++; }
try {
  const result = await runBackup({source:'demo-resq',out:'_גיבוי',dryRun:false}, options);
  check(result.sealed === true && result.documents === 1);
  const valid = verifySet(result.destination, options);
  check(valid.ok && valid.content_verified);
  check(temporaryAttempts === 0);
  check(!fs.existsSync(path.join(result.destination, 'documents.jsonl')));
  check(!verifySet(result.destination, {...options,sealPassphrase:passphrase+'wrong'}).ok);
  const manifestFile = path.join(result.destination, 'snapshot-manifest.json');
  const originalManifest = fs.readFileSync(manifestFile,'utf8');
  const manifest = JSON.parse(originalManifest);
  manifest.documents.sha256 = '0'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  check(!verifySet(result.destination,options).ok);
  fs.writeFileSync(manifestFile, originalManifest);
  const encryptedFile = path.join(result.destination, 'documents.jsonl.enc');
  const encrypted = fs.readFileSync(encryptedFile);
  const corrupted = Buffer.from(encrypted); corrupted[corrupted.length-2] ^= 1;
  fs.writeFileSync(encryptedFile, corrupted);
  check(!verifySet(result.destination,options).ok);
  check(temporaryAttempts === 0);
  console.log(JSON.stringify({syntheticOnly:true,passed,failed:0,plaintextTempAttempts:temporaryAttempts}));
} finally { fs.mkdtempSync = oldMkdtemp; }
