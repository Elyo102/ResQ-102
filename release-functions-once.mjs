import path from 'node:path';
import { pathToFileURL } from 'node:url';


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
  // 42H.42 has 22 approved targets, not a whole-codebase Functions release.
  // Keep this legacy helper inert even when a valid local test receipt exists.
  throw new Error('retired broad Functions release route: use a reviewed scoped 42H.42 runner');
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
