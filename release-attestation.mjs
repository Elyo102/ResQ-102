import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BOUND_FILES = [
  'firebase.json',
  'tests/package.json',
  'tests/package-lock.json',
  'functions/package.json',
  'functions/package-lock.json',
  'rules-test/package.json',
  'rules-test/package-lock.json'
];

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function receiptPath(tree, tmp = os.tmpdir()) {
  return path.join(tmp, 'resq-release-attestations', `${tree}.json`);
}

export function currentEvidence({ root = ROOT, nodeVersion = process.versions.node, allowedUntracked = [] } = {}) {
  const allowed = new Set(allowedUntracked.map((value) => `?? ${String(value).replaceAll('\\', '/')}`));
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], root)
    .split(/\r?\n/).filter(Boolean).filter((line) => !allowed.has(line));
  if (status.length) throw new Error(`release validation requires a clean Git tree: ${status.join(', ')}`);
  const major = Number(String(nodeVersion).split('.')[0]);
  if (major !== 22) throw new Error(`release validation requires Node 22; found ${nodeVersion}`);
  const tree = git(['rev-parse', 'HEAD^{tree}'], root);
  const files = {};
  for (const relative of BOUND_FILES) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) throw new Error(`release-bound file is missing: ${relative}`);
    files[relative] = sha256(absolute);
  }
  return { schema: 1, tree, node_major: major, files };
}

export function writeReceipt(options = {}) {
  const evidence = currentEvidence(options);
  const target = receiptPath(evidence.tree, options.tmp);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const receipt = { ...evidence, gate: 'npm --prefix tests run all', completed_at: new Date().toISOString() };
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, target);
  return { target, receipt };
}

export function verifyReceipt(options = {}) {
  const evidence = currentEvidence(options);
  const target = receiptPath(evidence.tree, options.tmp);
  if (!fs.existsSync(target)) throw new Error(`validated release receipt is missing for tree ${evidence.tree}`);
  const receipt = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (receipt.schema !== 1 || receipt.gate !== 'npm --prefix tests run all') throw new Error('release receipt contract is invalid');
  if (receipt.tree !== evidence.tree || receipt.node_major !== evidence.node_major) throw new Error('release receipt does not match this runtime/tree');
  if (JSON.stringify(receipt.files) !== JSON.stringify(evidence.files)) throw new Error('release-bound files changed after validation');
  const age = Date.now() - Date.parse(receipt.completed_at);
  if (!Number.isFinite(age) || age < 0 || age > (options.maxAgeMs ?? MAX_AGE_MS)) throw new Error('release receipt is stale');
  return { target, receipt, evidence };
}

function main() {
  const command = process.argv[2];
  if (command === 'write') {
    const result = writeReceipt();
    console.log(`Release validation receipt written for tree ${result.receipt.tree}`);
    console.log(result.target);
    return;
  }
  if (command === 'verify') {
    const result = verifyReceipt();
    console.log(`Release validation receipt verified for tree ${result.receipt.tree}`);
    return;
  }
  throw new Error('usage: node release-attestation.mjs <write|verify>');
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
