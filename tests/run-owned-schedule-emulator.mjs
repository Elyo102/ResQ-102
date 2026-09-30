import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { runOwnedLifecycle, startupCapture, interruptHandler } from './lib/owned-emulator-lifecycle.mjs';

// Native JVM boundary: the Node preload does not mediate Java outbound sockets.
// This runner attests pinned binaries/argv, sanitized environment, owned listener
// and process lifecycle; it does not claim kernel-level network isolation.

const require = createRequire(import.meta.url);
const guard = require('./lib/network-guard.cjs');
const { PIN, RULES, requireCondition, runnerMode, validateClosedObservation } = require('./lib/owned-emulator-contract.cjs');
guard.assertActive();
const mode = runnerMode(process.argv.slice(2));
requireCondition(process.versions.node.split('.')[0] === '22', 'LAUNCH_ARGUMENTS');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-owned-emulator-'));
fs.writeFileSync(path.join(directory, 'firestore.rules'), RULES, { flag: 'wx' });
fs.writeFileSync(path.join(directory, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' },
  emulators: { firestore: { host: PIN.host, port: PIN.port }, ui: { enabled: false }, singleProjectMode: true } }), { flag: 'wx' });
let launcher;
try { launcher = guard.createOwnedLauncher(directory); }
catch (error) {
  for (const name of ['firestore.rules', 'firebase.json']) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
  throw error;
}
const startup = startupCapture();
let emulatorError = null, emulatorClosed, integrationChild = null;
const abort = new AbortController();
// Synchronous revocation precedes cancellation and the single lifecycle cleanup.
const interrupted = interruptHandler({ revoke: () => launcher.revoke(), abort: () => abort.abort(),
  cancel: () => integrationChild?.kill(), poison: guard.poison });
process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
const nonce = crypto.randomBytes(32).toString('hex');
const checkAlive = child => requireCondition(!abort.signal.aborted && !emulatorError && child.exitCode === null && child.signalCode === null, 'CHILD_DIED_OR_ABORTED');
async function restReady() {
  return launcher.readiness(() => new Promise((resolve, reject) => {
    const request = http.get({ hostname: PIN.host, port: PIN.port,
      path: '/v1/projects/demo-resq/databases/(default)/documents/_owned_emulator_probe?pageSize=1',
      // Synthetic emulator-admin marker, never a real account credential.
      headers: { Authorization: 'Bearer owner' }, agent: false }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 4096) response.destroy(Error('READINESS_TOO_LARGE')); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          requireCondition(response.statusCode === 200, 'REST_STATUS');
          const value = JSON.parse(body);
          requireCondition(value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 0, 'REST_NOT_EMPTY_FIRESTORE');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(3000, () => request.destroy(Error('READINESS_TIMEOUT')));
    request.on('error', reject);
  }));
}
try {
  await runOwnedLifecycle({
    assertFree() {
      requireCondition(launcher.probe().portOwners.length === 0, 'PORT_OCCUPIED');
    },
    spawn() {
      const child = launcher.spawn();
      emulatorClosed = new Promise(resolve => child.once('close', resolve));
      child.once('exit', interrupted);
      child.on('error', error => { emulatorError = error; });
      const capture = chunk => startup.append(chunk);
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      return child;
    },
    async awaitReady(child) {
      const deadline = Date.now() + 45000;
      for (;;) {
        checkAlive(child);
        // Partial listeners while the JVM is starting are not an attested topology.
        // Wait for its startup marker, then verify the complete classified envelope.
        launcher.probe(child.pid, !startup.ready);
        if (startup.ready) {
          await restReady();
          checkAlive(child);
          launcher.probe(child.pid);
          return;
        }
        requireCondition(Date.now() < deadline, 'STARTUP_TIMEOUT');
        await delay(250);
      }
    },
    activate(child) {
      checkAlive(child); launcher.probe(child.pid);
      launcher.activate(nonce, 'STARTUP_AND_EMPTY_FIRESTORE_JSON_VERIFIED');
    },
    runIntegration(child) {
      checkAlive(child);
      return new Promise((resolve, reject) => {
        const integration = integrationChild = spawn(process.execPath, [launcher.plan.integration], { cwd: root,
          env: { ...launcher.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', RESQ_OWNED_EMULATOR_NONCE: nonce },
          shell: false, windowsHide: true, stdio: 'inherit' });
        const timeout = setTimeout(() => { integration.kill(); }, 240000);
        let topologyFailure = null;
        const monitor = setInterval(() => {
          try { checkAlive(child); launcher.probe(child.pid); }
          catch (error) { topologyFailure = error; interrupted(); }
        }, 5000);
        integration.once('error', error => { clearTimeout(timeout); clearInterval(monitor); reject(error); });
        integration.once('close', (code, signal) => {
          clearTimeout(timeout); clearInterval(monitor);
          if (topologyFailure) reject(topologyFailure);
          else if (code !== 0 || signal) reject(Error('OWNED_INTEGRATION_FAILED code=' + code));
          else { try { checkAlive(child); launcher.probe(child.pid); resolve(); } catch (error) { reject(error); } }
        });
      });
    },
    revoke() { launcher.revoke(); },
    async stop(child) {
      if (child.exitCode === null && child.signalCode === null) {
        launcher.probe(child.pid, true);
        launcher.stopTree(false);
        await Promise.race([emulatorClosed, delay(1500)]);
        if (child.exitCode === null && child.signalCode === null) launcher.stopTree(true);
      }
      let timer;
      try { await Promise.race([emulatorClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('OWNED_STOP_TIMEOUT')), 10000); })]); }
      finally { clearTimeout(timer); }
    },
    verifyClosed(child) {
      const observation = launcher.probe(child.pid, true);
      validateClosedObservation(observation);
      console.log('Owned emulator cleanup verified: process absent; all captured listener ports closed; capability revoked.');
    },
    remove() {
      // Only the two exact files created above, never recursive deletion or shared state.
      for (const name of ['firestore.rules', 'firebase.json']) fs.unlinkSync(path.join(directory, name));
      fs.rmdirSync(directory);
    },
    poison: guard.poison,
  }, mode);
  guard.assertClean();
  console.log(mode === 'startup-only' ? 'Owned emulator startup-only diagnostic passed; integration NOT RUN.'
    : 'Owned demo-resq emulator: native integration passed; capability revoked; owned PID and port closed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
}
