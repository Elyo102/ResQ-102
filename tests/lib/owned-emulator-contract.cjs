'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { isIP } = require('node:net');

const PIN = Object.freeze({
  cli: '15.28.1', version: '1.22.0', size: 136707194,
  jarHash: '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c',
  javaHash: '82051fdab26319d77d20cc0065045d05ec00b3e3d05f44935d7c06b96b621d55',
  rulesHash: 'f3c89c2262f26ae917a01afbaf5d6186cb3f9f0bc31d9ff9efc740552a2a14d3',
  host: '127.0.0.1', port: 8080, project: 'demo-resq',
});
const RULES = "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }\n";
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function requireCondition(value, reason) { if (!value) throw new Error('OWNED_EMULATOR_' + reason); }
function runnerMode(args) {
  if (Array.isArray(args) && args.length === 0) return 'integration';
  if (Array.isArray(args) && args.length === 1 && args[0] === '--startup-only') return 'startup-only';
  throw new Error('OWNED_EMULATOR_LAUNCH_ARGUMENTS');
}
function listenerEvidence(observation, pid) {
  const listeners = Array.isArray(observation?.listeners) ? observation.listeners : [];
  return { count: listeners.length, truncated: listeners.length > 8, listeners: listeners.slice(0, 8).map(entry => ({
    host: typeof entry?.host === 'string' && entry.host.length <= 45 && isIP(entry.host) ? entry.host : '[invalid]',
    port: Number.isInteger(entry?.port) && entry.port >= 1 && entry.port <= 65535 ? entry.port : null,
    ownerPidMatch: Number.isInteger(pid) && entry?.pid === pid,
  })) };
}
function regular(file) {
  requireCondition(path.isAbsolute(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'REGULAR_FILE');
  requireCondition(fs.realpathSync(file).toLowerCase() === path.resolve(file).toLowerCase(), 'PATH_ALIAS');
  return fs.readFileSync(file);
}
function paths(root) {
  return {
    cli: path.resolve(root, '../firebase-cli-runtime/node_modules/firebase-tools'),
    jar: 'C:\\Users\\User\\.cache\\firebase\\emulators\\cloud-firestore-emulator-v1.22.0.jar',
    java: 'C:\\Users\\User\\AppData\\Local\\Programs\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot\\bin\\java.exe',
    probe: path.join(root, 'tests/lib/owned-emulator-probe.ps1'),
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    taskkill: 'C:\\Windows\\System32\\taskkill.exe',
    integration: path.join(root, 'functions/schedule-runtime.integration.test.js'),
    launcher: path.join(root, 'tests/run-owned-schedule-emulator.mjs'),
  };
}
function argv(p, rules) {
  return ['-Dgoogle.cloud_firestore.debug_log_level=FINE', '-Duser.language=en', '-jar', p.jar,
    '--host', PIN.host, '--port', String(PIN.port), '--project_id', PIN.project,
    '--rules', rules, '--single_project_mode', 'true'];
}
function assertTemporary(directory) {
  const resolved = fs.realpathSync(directory), temp = fs.realpathSync(os.tmpdir());
  const relative = path.relative(temp, resolved);
  requireCondition(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && path.basename(resolved).startsWith('resq-owned-emulator-') && resolved.toLowerCase() === path.resolve(directory).toLowerCase(), 'TEMP_DIRECTORY');
}
function validatePins(root, directory) {
  requireCondition(process.platform === 'win32' && process.versions.node.split('.')[0] === '22', 'PLATFORM_NODE');
  assertTemporary(directory);
  const p = paths(root);
  const cli = JSON.parse(regular(path.join(p.cli, 'package.json')));
  const meta = JSON.parse(regular(path.join(p.cli, 'lib/emulator/downloadableEmulatorInfo.json'))).firestore;
  requireCondition(cli.version === PIN.cli && meta.version === PIN.version && meta.expectedSize === PIN.size
    && meta.expectedChecksumSHA256 === PIN.jarHash, 'CLI_PIN');
  const jar = regular(p.jar);
  requireCondition(jar.length === PIN.size && sha(jar) === PIN.jarHash, 'JAR_PIN');
  requireCondition(sha(regular(p.java)) === PIN.javaHash, 'JAVA_PIN');
  const release = regular(path.resolve(p.java, '../../release')).toString();
  requireCondition(/^JAVA_VERSION="21\.0\.12\.1"\r?$/m.test(release)
    && /^IMPLEMENTOR="Eclipse Adoptium"\r?$/m.test(release), 'JAVA_VERSION');
  const rules = path.join(directory, 'firestore.rules');
  requireCondition(sha(regular(rules)) === PIN.rulesHash, 'RULES_PIN');
  return { ...p, directory, rules, args: argv(p, rules), argsHash: sha(JSON.stringify(argv(p, rules))) };
}
function safeEnv(source, guard, ledger) {
  // Allowlist, not a growing blacklist: credentials, proxies and JVM injection options cannot leak through.
  const result = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATH', 'PATHEXT']) {
    const actual = Object.keys(source).find(k => k.toUpperCase() === key.toUpperCase());
    if (actual) result[key] = source[actual];
  }
  return Object.assign(result, { NODE_OPTIONS: '--require ' + JSON.stringify(guard), RESQ_CONTAINMENT_DIR: ledger,
    GCLOUD_PROJECT: PIN.project, GOOGLE_CLOUD_PROJECT: PIN.project,
    FIREBASE_CONFIG: '{"projectId":"demo-resq"}', METADATA_SERVER_DETECTION: 'none' });
}
function validateCapability(value, expected, alive, now = Date.now()) {
  requireCondition(value && Object.keys(value).sort().join(',') ===
    'argsHash,auxPorts,childPID,createdAt,host,jarHash,javaHash,launcherPID,nonce,port,project,rules,rulesHash,topologyHash', 'CAP_SCHEMA');
  requireCondition(value.host === PIN.host && value.port === PIN.port && value.project === PIN.project
    && value.javaHash === PIN.javaHash && value.jarHash === PIN.jarHash && value.rulesHash === PIN.rulesHash, 'CAP_TARGET');
  requireCondition(/^[a-f0-9]{64}$/.test(value.nonce) && value.nonce === expected.nonce
    && value.launcherPID === expected.parentPID && Number.isInteger(value.childPID) && value.childPID > 0
    && value.childPID !== value.launcherPID, 'CAP_IDENTITY');
  requireCondition(Number.isFinite(value.createdAt) && value.createdAt <= now && now - value.createdAt < 600000, 'CAP_AGE');
  requireCondition(value.argsHash === expected.argsHash && value.rules === expected.rules, 'CAP_ARGS');
  requireCondition(validAuxPorts(value.auxPorts) && value.topologyHash === sha(JSON.stringify([8080, ...value.auxPorts])), 'CAP_TOPOLOGY');
  requireCondition(alive(value.launcherPID) && alive(value.childPID), 'CAP_DEAD_PROCESS');
  return true;
}
function validateOwnedProcess(observation, plan, pid, parentPID, createdAt) {
  requireCondition(observation && observation.process && observation.process.pid === pid
    && pid !== parentPID && observation.process.parentPID === parentPID
    && observation.process.path.toLowerCase() === plan.java.toLowerCase(), 'PROCESS_IDENTITY');
  requireCondition(Number.isFinite(Date.parse(observation.process.createdAt))
    && observation.process.createdAt === createdAt, 'PROCESS_CREATION');
}
function validAuxPorts(ports) {
  return Array.isArray(ports) && ports.length === 3 && new Set(ports).size === 3
    && ports.every((port, i) => Number.isInteger(port) && port >= 49152 && port <= 65535 && (!i || ports[i - 1] < port));
}
function validateObservation(observation, plan, pid, parentPID, createdAt, previous = null) {
  validateOwnedProcess(observation, plan, pid, parentPID, createdAt);
  requireCondition(Array.isArray(observation.descendants) && observation.descendants.length === 0, 'UNEXPECTED_DESCENDANTS');
  const listeners = observation.listeners;
  const ports = Array.isArray(listeners) ? listeners.map(entry => entry.port).sort((a, b) => a - b) : [];
  requireCondition(Array.isArray(listeners) && listeners.length === 4
    && listeners.every(entry => entry.pid === pid && entry.host === PIN.host)
    && ports[0] === 8080 && validAuxPorts(ports.slice(1)), 'LISTENER_IDENTITY ' + JSON.stringify(listenerEvidence(observation, pid)));
  requireCondition(observation.portOwners.every(entry => entry.pid === pid), 'PORT_OWNER');
  requireCondition(previous === null || JSON.stringify(previous) === JSON.stringify(ports), 'LISTENER_CHURN');
  return ports;
}
function validateClosedObservation(observation) {
  requireCondition(observation && observation.process === null
    && Array.isArray(observation.portOwners) && observation.portOwners.length === 0
    && Array.isArray(observation.listeners) && observation.listeners.length === 0
    && Array.isArray(observation.descendants) && observation.descendants.length === 0, 'CLEANUP_NOT_CLOSED');
}
module.exports = { PIN, RULES, sha, paths, argv, regular, requireCondition, runnerMode, listenerEvidence, assertTemporary, validatePins, safeEnv,
  validateCapability, validateOwnedProcess, validAuxPorts, validateObservation, validateClosedObservation };
