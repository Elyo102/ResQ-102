import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInventory } from './containment-inventory.mjs';
import { resolveContainedGate } from './lib/gate-contract.mjs';

if (Number(process.versions.node.split('.')[0]) !== 22) throw Error('Node22 required');
const gate = process.argv[2];
const innerGate = resolveContainedGate(gate);
if ([process.env.GCLOUD_PROJECT, process.env.GOOGLE_CLOUD_PROJECT].some(value => value && value !== 'demo-resq')) throw Error('Non-demo project refused');
if (process.env.FIRESTORE_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8191') throw Error('Non-loopback or unexpected emulator refused');
if (process.env.FIREBASE_CONFIG && JSON.parse(process.env.FIREBASE_CONFIG).projectId !== 'demo-resq') throw Error('Non-demo Firebase configuration refused');
if (gate === 'test:all' && (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8191' || process.env.GCLOUD_PROJECT !== 'demo-resq')) throw Error('Explicit demo-resq loopback emulator required');
if (!process.env.npm_execpath || !fs.existsSync(process.env.npm_execpath)) throw Error('Invoke through the registered npm script');
console.log('Containment inventory:', JSON.stringify(checkInventory()));
const here = fileURLToPath(new URL('.', import.meta.url));
const guard = path.join(here, 'lib/network-guard.cjs');
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-contained-'));
const env = { ...process.env, RESQ_CONTAINMENT_DIR: evidence,
  NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
  GCLOUD_PROJECT: 'demo-resq', GOOGLE_CLOUD_PROJECT: 'demo-resq', FIREBASE_CONFIG: '{"projectId":"demo-resq"}', METADATA_SERVER_DETECTION: 'none' };
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY']) delete env[key];
if (process.platform === 'linux') env.npm_config_script_shell = '/bin/sh';
console.log('Local containment evidence:', evidence);
const child = spawn(process.execPath, [process.env.npm_execpath, 'run', innerGate], { cwd: here, env, stdio: 'inherit', windowsHide: true });
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ code: 1, error: error.code }));
  child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
});
// The guard uses a sticky shared ledger. A caught network error or a child that
// exits zero must not turn an escaped-network attempt into a passing suite.
const poison = path.join(evidence, 'violations.log');
const violations = fs.existsSync(poison) && fs.statSync(poison).size > 0;
if (violations) {
  // Bounded categories only: never broadcast ledger metadata, paths or argv.
  const known = new Set(['implicit-child-shell', 'unapproved-child-executable',
    'unapproved-posix-shell-command', 'unapproved-shell-command', 'child-stripped-containment',
    'external-dns', 'external-dns-query', 'external-resolver-query', 'socket-path-not-authorized',
    'git-command-not-readonly', 'browser-without-containment-proxy', 'unapproved-shell-exec',
    'unregistered-or-nonloopback-socket', 'unsafe-emulator-environment', 'unsafe-owned-emulator-environment',
    'invalid-loopback-registration', 'udp-send', 'udp-connect', 'nonloopback-listener', 'non-tcp-listener',
    'fork-executable-override']);
  let fd;
  try {
    fd = fs.openSync(poison, 'r');
    const buffer = Buffer.alloc(16384);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, size).toString('utf8').split('\n');
    lines.pop(); // Ignore an incomplete final line, including a truncated record.
    const categories = new Set();
    for (const line of lines.slice(0, 32)) {
      try {
        const reason = JSON.parse(line).reason;
        const token = typeof reason === 'string' ? reason.split(' ')[0] : '';
        categories.add(known.has(token) ? token : 'unknown');
      } catch { categories.add('unknown'); }
    }
    console.log('Containment violation categories:', JSON.stringify([...categories]));
    if (size === buffer.length || lines.length > 32) console.log('Containment diagnostics truncated');
  } catch { console.log('Containment diagnostics unavailable'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
console.log('Contained gate result:', JSON.stringify({ gate, ...result, violations }));
process.exitCode = result.code || (violations ? 1 : 0);
