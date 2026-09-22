import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyReceipt } from './release-attestation.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function run(file, args) {
  return execFileSync(file, args, { cwd: ROOT, stdio: 'inherit' });
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function makeFunctionsDeployConfig(source) {
  const clone = structuredClone(source);
  if (!Array.isArray(clone.functions) || clone.functions.length !== 1) throw new Error('expected exactly one Functions codebase');
  const hooks = clone.functions[0].predeploy;
  if (!Array.isArray(hooks) || hooks.length !== 1 || hooks[0] !== 'npm --prefix tests run all') {
    throw new Error('refusing to project an unexpected Functions predeploy contract');
  }
  delete clone.functions[0].predeploy;
  return clone;
}

export function assertOnlyFunctionsPredeployRemoved(source, projected) {
  const expected = makeFunctionsDeployConfig(source);
  if (JSON.stringify(projected) !== JSON.stringify(expected)) throw new Error('temporary Firebase config changed more than Functions predeploy');
  return true;
}

export function parseArgs(argv) {
  const result = { execute: false, project: '', candidate: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--execute') result.execute = true;
    else if (argv[i] === '--project') result.project = argv[++i] || '';
    else if (argv[i] === '--candidate') result.candidate = argv[++i] || '';
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!/^[0-9a-f]{40}$/.test(result.candidate)) throw new Error('--candidate must be a full 40-character commit SHA');
  if (result.project !== 'station-102') throw new Error('--project must explicitly be station-102');
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute) throw new Error('dry stop: add --execute only after exact production approval');
  if (git(['rev-parse', 'HEAD']) !== args.candidate) throw new Error('HEAD differs from the approved candidate');
  const first = verifyReceipt();
  const lockPath = path.join(os.tmpdir(), `resq-functions-release-${args.project}.lock`);
  const lock = fs.openSync(lockPath, 'wx');
  const tempConfig = path.join(ROOT, `.firebase.release-once-${process.pid}.json`);
  try {
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const projected = makeFunctionsDeployConfig(source);
    assertOnlyFunctionsPredeployRemoved(source, projected);
    fs.writeFileSync(tempConfig, `${JSON.stringify(projected, null, 2)}\n`, { flag: 'wx' });
    const receiptOptions = { allowedUntracked: [path.basename(tempConfig)] };
    const second = verifyReceipt(receiptOptions);
    if (second.evidence.tree !== first.evidence.tree) throw new Error('release tree changed while preparing deployment');
    run('npx', ['--yes', 'firebase-tools@15.28.1', 'deploy', '--config', tempConfig, '--only', 'functions', '--project', args.project, '--non-interactive']);
    verifyReceipt(receiptOptions);
  } finally {
    try { fs.closeSync(lock); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
    try { fs.unlinkSync(tempConfig); } catch {}
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
