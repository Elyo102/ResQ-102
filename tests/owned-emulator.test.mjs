import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runOwnedLifecycle, startupCapture, interruptHandler } from './lib/owned-emulator-lifecycle.mjs';
const require = createRequire(import.meta.url);
const contract = require('./lib/owned-emulator-contract.cjs');
const { PIN, RULES, sha, argv, safeEnv, validateCapability, validateObservation, validateOwnedProcess } = contract;
const root = fileURLToPath(new URL('../', import.meta.url));
const guard = path.join(root, 'tests/lib/network-guard.cjs');
const now = Date.now();
const nonce = 'a'.repeat(64);
const auxPorts = [55001, 55002, 55003];
const value = { host: PIN.host, port: PIN.port, project: PIN.project, launcherPID: 111, childPID: 222,
  nonce, createdAt: now, javaHash: PIN.javaHash, jarHash: PIN.jarHash, rulesHash: PIN.rulesHash,
  rules: 'fixed-rules', argsHash: 'args', auxPorts, topologyHash: sha(JSON.stringify([8080, ...auxPorts])) };
const expected = { nonce, parentPID: 111, rules: 'fixed-rules', argsHash: 'args' };
const alive = pid => [111, 222].includes(pid);
test('literal deny-all fixture hash, fixed invocation excludes import/export/hub/download', () => {
  assert.equal(sha(RULES), PIN.rulesHash);
  assert.deepEqual(argv({ jar: 'PINNED_JAR' }, 'RULES'), [
    '-Dgoogle.cloud_firestore.debug_log_level=FINE', '-Duser.language=en', '-jar', 'PINNED_JAR',
    '--host', '127.0.0.1', '--port', '8080', '--project_id', 'demo-resq', '--rules', 'RULES', '--single_project_mode', 'true',
  ]);
});
test('only empty args and exact startup-only flag are accepted', () => {
  assert.equal(contract.runnerMode([]), 'integration');
  assert.equal(contract.runnerMode(['--startup-only']), 'startup-only');
  for (const args of [['--other'], ['--startup-only', 'extra'], ['--startup-only=true'], ['--startup-only', '--startup-only'], null, '']) {
    assert.throws(() => contract.runnerMode(args), /LAUNCH_ARGUMENTS/);
  }
});
test('listener diagnostics are bounded and redact all non-allowlisted fields', () => {
  const input = { commandLine: 'SECRET', path: 'SECRET', pid: 987654321,
    listeners: Array.from({ length: 100 }, (_, i) => ({ host: i ? '::1' : 'SECRET\n/path', port: i ? 9150 : 'SECRET',
      pid: 987654321, commandLine: 'SECRET', payload: 'SECRET', bearer: 'SECRET' })) };
  const output = contract.listenerEvidence(input, 987654321), serialized = JSON.stringify(output);
  assert.equal(output.count, 100); assert.equal(output.truncated, true); assert.equal(output.listeners.length, 8);
  assert.ok(serialized.length < 1024); assert.ok(!serialized.includes('SECRET')); assert.ok(!serialized.includes('987654321'));
  assert.deepEqual(output.listeners[0], { host: '[invalid]', port: null, ownerPidMatch: true });
  assert.deepEqual(Object.keys(output).sort(), ['count', 'listeners', 'truncated']);
  for (const invalid of [null, {}, { listeners: 'SECRET' }]) assert.deepEqual(contract.listenerEvidence(invalid, 222), { count: 0, truncated: false, listeners: [] });
});
test('startup-only lifecycle cannot activate capability or spawn integration and still cleans', async () => {
  const h = lifecycle();
  await runOwnedLifecycle(h.io, 'startup-only');
  assert.deepEqual(h.events, ['assertFree', 'spawn', 'awaitReady', 'revoke', 'stop', 'verifyClosed', 'remove']);
  const invalid = lifecycle(); await assert.rejects(runOwnedLifecycle(invalid.io, 'unknown'), /OWNED_EMULATOR_MODE/);
  assert.deepEqual(invalid.events, []);
});
test('startup-only topology rejection remains fatal and always executes cleanup', async () => {
  const h = lifecycle(['awaitReady']);
  await assert.rejects(runOwnedLifecycle(h.io, 'startup-only'), /awaitReady/);
  assert.deepEqual(h.events, ['assertFree', 'spawn', 'awaitReady', 'revoke', 'stop', 'verifyClosed', 'remove']);
});
test('sanitized native/Node environment excludes credentials, provider keys, proxies and JVM injection', () => {
  const env = safeEnv({ Path: 'BIN', TEMP: 'TEMP', HTTP_PROXY: 'bad', https_proxy: 'bad', ALL_PROXY: 'bad',
    GOOGLE_APPLICATION_CREDENTIALS: 'bad', FIREBASE_TOKEN: 'bad', ANTHROPIC_API_KEY: 'bad', XAI_API_KEY: 'bad',
    GEMINI_API_KEY: 'bad', OPENAI_API_KEY: 'bad', JAVA_TOOL_OPTIONS: 'bad', _JAVA_OPTIONS: 'bad',
    JDK_JAVA_OPTIONS: 'bad', FIRESTORE_EMULATOR_HOST: 'bad', RESQ_OWNED_EMULATOR_NONCE: 'bad', NODE_OPTIONS: 'bad' }, guard, 'LEDGER');
  assert.equal(env.PATH, 'BIN'); assert.equal(env.GCLOUD_PROJECT, 'demo-resq');
  assert.ok(!Object.values(env).includes('bad')); assert.ok(!('FIRESTORE_EMULATOR_HOST' in env));
  assert.equal(env.NODE_OPTIONS, '--require ' + JSON.stringify(guard));
});
test('valid capability requires every identity/pin and live processes', () => {
  assert.equal(validateCapability(value, expected, alive, now), true);
});
for (const [name, patch] of Object.entries({
  localhost: { host: 'localhost' }, ipv6: { host: '::1' }, remote: { host: 'example.com' },
  alternatePort: { port: 8191 }, portString: { port: '8080' }, nonDemo: { project: 'station-102' },
  wrongNonce: { nonce: 'b'.repeat(64) }, malformedNonce: { nonce: 'x' }, parent: { launcherPID: 333 },
  reusedPid: { childPID: 111 }, noChild: { childPID: 0 }, fractionalPID: { childPID: 2.5 },
  javaHash: { javaHash: 'bad' }, jarHash: { jarHash: 'bad' }, rulesHash: { rulesHash: 'bad' },
  rulesPath: { rules: 'other' }, argv: { argsHash: 'other' }, expired: { createdAt: now - 600000 },
  future: { createdAt: now + 1 }, extraField: { extra: true },
  wrongTopologyHash: { topologyHash: 'bad' }, auxTooFew: { auxPorts: [55001, 55002] },
  auxDuplicate: { auxPorts: [55001, 55001, 55003] }, auxLow: { auxPorts: [49151, 55002, 55003] },
  auxHigh: { auxPorts: [55001, 55002, 65536] }, auxUnsorted: { auxPorts: [55003, 55002, 55001] },
})) test('capability mutation rejected: ' + name, () => {
  assert.throws(() => validateCapability({ ...value, ...patch }, expected, alive, now), /OWNED_EMULATOR_/);
});
for (const pid of [111, 222]) test('dead capability process rejected: ' + pid, () => {
  assert.throws(() => validateCapability(value, expected, candidate => candidate !== pid, now), /CAP_DEAD_PROCESS/);
});
const birth = '2026-09-30T00:00:00.000Z';
const observation = { process: { pid: 222, parentPID: 111, path: 'JAVA', createdAt: birth }, descendants: [],
  listeners: [8080, ...auxPorts].map(port => ({ pid: 222, host: '127.0.0.1', port })), portOwners: [{ pid: 222 }] };
// Execute the actual production probe closure, replacing only its OS I/O.
// This catches conditional wiring that pure validateObservation tests cannot.
function wiredProbe(input, cleanup = false, exited = false, mutate = source => source) {
  const source = fs.readFileSync(guard, 'utf8');
  const ast = require('acorn').parse(source, { ecmaVersion: 'latest' });
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'probe') matches.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast); assert.equal(matches.length, 1);
  const body = mutate(source.slice(matches[0].start, matches[0].end));
  return new Function('owned', 'input', 'cleanup', 'exited', `
    const plan={java:'JAVA',probe:'PROBE',powershell:'PS'}, process={pid:111};
    const child={pid:222,exitCode:exited?1:null,signalCode:null};
    let createdAt=${JSON.stringify(birth)}, spawnedAt=0, topology=[8080,55001,55002,55003], verifiedAt=0, ownedTopologyHash=null;
    const ownedAuxPorts=new Set(), deny=message=>{throw Error(message)};
    let calls=0;
    const permit=(file,args,callback)=>callback({});
    const cp={spawnSync(){calls++;return {status:0,stdout:JSON.stringify(input)}}};
    ${body}
    const result=probe(222,cleanup);
    return {result,calls,verifiedAt,topology};
  `)(contract, input, cleanup, exited);
}
test('actual probe wiring attests a complete snapshot and advances verification', () => {
  const result = wiredProbe(observation);
  assert.equal(result.calls, 1); assert.ok(result.verifiedAt > 0);
  assert.deepEqual(result.topology, [8080, ...auxPorts]);
});
for (const [name, input] of Object.entries({ missingProcess: { ...observation, process: null },
  noListeners: { ...observation, listeners: [] },
  changedListeners: { ...observation, listeners: observation.listeners.map((entry, index) => index === 3 ? { ...entry, port: 55004 } : entry) } })) {
  test('actual post-startup probe wiring rejects ' + name, () => {
    assert.throws(() => wiredProbe(input), /OWNED_EMULATOR_/);
  });
}
test('actual probe wiring rejects exited retained child but cleanup permits absent process', () => {
  assert.throws(() => wiredProbe(observation, false, true), /child-exited/);
  const result = wiredProbe({ process: null, listeners: [], descendants: [], portOwners: [] }, true);
  assert.equal(result.verifiedAt, 0); assert.equal(result.result.process, null);
});
test('probe-wiring oracle catches a bypassed validator mutation', () => {
  const bypass = source => source.replace('topology = owned.validateObservation(observation, plan, pid, process.pid, createdAt, topology);', 'topology = topology;');
  for (const input of [{ ...observation, process: null }, { ...observation, listeners: [] }]) {
    // The mutated code falsely returns success; the rejection oracle must fail.
    assert.throws(() => assert.throws(() => wiredProbe(input, false, false, bypass), /OWNED_EMULATOR_/), /Missing expected exception/);
  }
});
test('exact classified four-listener topology accepted and stable', () => {
  const ports = validateObservation(observation, { java: 'JAVA' }, 222, 111, birth);
  assert.deepEqual(ports, [8080, ...auxPorts]);
  assert.deepEqual(validateObservation(observation, { java: 'JAVA' }, 222, 111, birth, ports), ports);
});
for (const [name, patch] of Object.entries({
  wrongProcess: { process: { ...observation.process, pid: 333 } },
  wrongParent: { process: { ...observation.process, parentPID: 333 } },
  wrongExe: { process: { ...observation.process, path: 'OTHER' } },
  reusedCreation: { process: { ...observation.process, createdAt: '2026-09-30T00:00:01.000Z' } },
  descendants: { descendants: [333] }, noListener: { listeners: [] },
  extra9150: { listeners: [...observation.listeners, { pid: 222, host: '127.0.0.1', port: 9150 }] },
  ipv6: { listeners: [{ pid: 222, host: '::1', port: 8080 }] },
  wildcard: { listeners: [{ pid: 222, host: '0.0.0.0', port: 8080 }] },
  wrongOwner: { portOwners: [{ pid: 333 }] },
  missingAux: { listeners: observation.listeners.slice(0, 3) },
  duplicateAux: { listeners: [observation.listeners[0], observation.listeners[1], observation.listeners[1], observation.listeners[3]] },
  aux9150: { listeners: observation.listeners.map((x, i) => i === 1 ? { ...x, port: 9150 } : x) },
  aux8191: { listeners: observation.listeners.map((x, i) => i === 1 ? { ...x, port: 8191 } : x) },
  auxLow: { listeners: observation.listeners.map((x, i) => i === 1 ? { ...x, port: 49151 } : x) },
  auxHigh: { listeners: observation.listeners.map((x, i) => i === 3 ? { ...x, port: 65536 } : x) },
  auxIPv6: { listeners: observation.listeners.map((x, i) => i === 1 ? { ...x, host: '::1' } : x) },
  auxWildcard: { listeners: observation.listeners.map((x, i) => i === 1 ? { ...x, host: '0.0.0.0' } : x) },
  auxPublic: { listeners: observation.listeners.map((x, i) => i === 1 ? { ...x, host: '203.0.113.1' } : x) },
  auxForeignPID: { listeners: observation.listeners.map((x, i) => i === 1 ? { ...x, pid: 333 } : x) },
})) test('OS ownership mutation rejected: ' + name, () => {
  assert.throws(() => validateObservation({ ...observation, ...patch }, { java: 'JAVA' }, 222, 111, birth), /OWNED_EMULATOR_/);
});
test('auxiliary port churn during integration is rejected', () => {
  const changed = { ...observation, listeners: observation.listeners.map((entry, i) => i === 3 ? { ...entry, port: 55004 } : entry) };
  assert.throws(() => validateObservation(changed, { java: 'JAVA' }, 222, 111, birth, [8080, ...auxPorts]), /LISTENER_CHURN/);
});
test('cleanup proof requires owned PID, every captured port and descendants absent', () => {
  const closed = { process: null, listeners: [], portOwners: [], descendants: [] };
  assert.doesNotThrow(() => contract.validateClosedObservation(closed));
  for (const port of [8080, ...auxPorts]) assert.throws(() => contract.validateClosedObservation({ ...closed,
    portOwners: [{ pid: 333, host: '127.0.0.1', port }] }), /CLEANUP_NOT_CLOSED/);
  for (const patch of [{ process: observation.process }, { listeners: [observation.listeners[1]] }, { descendants: [333] },
    { portOwners: null }, { listeners: null }, { descendants: null }]) {
    assert.throws(() => contract.validateClosedObservation({ ...closed, ...patch }), /CLEANUP_NOT_CLOSED/);
  }
});
function lifecycle(failures = []) {
  const events = [], io = {};
  for (const step of ['assertFree', 'spawn', 'awaitReady', 'activate', 'runIntegration', 'revoke', 'stop', 'verifyClosed', 'remove']) {
    io[step] = async () => { events.push(step); if (failures.includes(step)) throw Error(step); return { pid: 222 }; };
  }
  io.poison = reason => events.push(reason);
  return { io, events };
}
test('lifecycle orders readiness before activation, revokes before stop and proves cleanup', async () => {
  const h = lifecycle(); await runOwnedLifecycle(h.io);
  assert.deepEqual(h.events, ['assertFree', 'spawn', 'awaitReady', 'activate', 'runIntegration', 'revoke', 'stop', 'verifyClosed', 'remove']);
});
for (const step of ['assertFree', 'spawn', 'awaitReady', 'activate', 'runIntegration']) test('failure lifecycle: ' + step, async () => {
  const h = lifecycle([step]); await assert.rejects(runOwnedLifecycle(h.io), new RegExp(step));
  assert.equal(h.events.at(-1), 'remove');
  assert.ok(h.events.includes('revoke'));
  if (['assertFree', 'spawn'].includes(step)) { assert.ok(!h.events.includes('stop')); assert.ok(!h.events.includes('verifyClosed')); }
  else assert.ok(h.events.indexOf('revoke') < h.events.indexOf('stop'));
  if (step !== 'runIntegration') assert.ok(!h.events.includes('runIntegration'));
});
for (const step of ['revoke', 'stop', 'verifyClosed', 'remove']) test('cleanup failure poisons and does not skip later cleanup: ' + step, async () => {
  const h = lifecycle(['runIntegration', step]);
  await assert.rejects(runOwnedLifecycle(h.io), error => error instanceof AggregateError && error.errors.length === 2);
  assert.ok(h.events.includes('owned-cleanup-' + step));
  assert.equal(h.events.includes('remove'), step === 'remove', 'preserve owned artifacts on earlier cleanup failures');
});
for (const [name, bad] of Object.entries({
  extraListener: { ...observation, listeners: [...observation.listeners, { pid: 222, host: '127.0.0.1', port: 9150 }] },
  wildcard: { ...observation, listeners: [{ pid: 222, host: '0.0.0.0', port: 8080 }] },
  descendant: { ...observation, descendants: [333] },
})) test('rejected readiness still permits identity-proven owned-tree cleanup: ' + name, async () => {
  const h = lifecycle();
  h.io.awaitReady = () => validateObservation(bad, { java: 'JAVA' }, 222, 111, birth);
  h.io.stop = () => { validateOwnedProcess(bad, { java: 'JAVA' }, 222, 111, birth); h.events.push('OWNED_TREE_STOP'); };
  await assert.rejects(runOwnedLifecycle(h.io), /OWNED_EMULATOR_/);
  assert.ok(h.events.indexOf('revoke') < h.events.indexOf('OWNED_TREE_STOP'));
  assert.ok(h.events.indexOf('OWNED_TREE_STOP') < h.events.indexOf('verifyClosed'));
  assert.equal(h.events.at(-1), 'remove');
});
test('reused PID never authorizes cleanup and preserves artifacts', async () => {
  const h = lifecycle(['awaitReady']);
  h.io.stop = () => {
    validateOwnedProcess({ ...observation, process: { ...observation.process, createdAt: '2026-09-30T00:00:01Z' } }, { java: 'JAVA' }, 222, 111, birth);
    h.events.push('FORBIDDEN_KILL');
  };
  await assert.rejects(runOwnedLifecycle(h.io), /CLEANUP_FAILED/);
  assert.ok(!h.events.includes('FORBIDDEN_KILL')); assert.ok(!h.events.includes('remove'));
});
for (const phase of ['awaitReady', 'runIntegration']) test('interrupt during ' + phase + ' revokes first, cleans once', async () => {
  const h = lifecycle(); let cancelled = false;
  const signal = interruptHandler({ revoke: () => h.events.push('SIGNAL_REVOKE'), abort: () => { cancelled = true; },
    cancel: () => h.events.push('CANCEL_INTEGRATION'), poison: h.io.poison });
  h.io[phase] = () => { signal(); signal(); assert.equal(cancelled, true); throw Error('INTERRUPTED'); };
  await assert.rejects(runOwnedLifecycle(h.io), /INTERRUPTED/);
  assert.equal(h.events.filter(x => x === 'SIGNAL_REVOKE').length, 1);
  assert.equal(h.events.filter(x => x === 'stop').length, 1);
  assert.ok(h.events.indexOf('SIGNAL_REVOKE') < h.events.indexOf('CANCEL_INTEGRATION'));
});
test('startup capture is bounded in bytes and retains readiness flags after a log flood', () => {
  const capture = startupCapture(256);
  capture.append('http://127.0.0.1:8080\nDev App Server is now running.');
  for (let i = 0; i < 20; i++) capture.append('עברית'.repeat(1000));
  assert.equal(capture.ready, true); assert.ok(capture.retainedBytes <= 256);
});
test('revocation failure in event handler still aborts/cancels and preserves cleanup failure evidence', async () => {
  const h = lifecycle(['revoke']);
  const signal = interruptHandler({ revoke: () => { throw Error('UNLINK_FAILED'); },
    abort: () => h.events.push('ABORTED'), cancel: () => h.events.push('CANCELLED'), poison: h.io.poison });
  h.io.runIntegration = () => { assert.doesNotThrow(signal); throw Error('ABORTED'); };
  await assert.rejects(runOwnedLifecycle(h.io), /CLEANUP_FAILED/);
  assert.ok(h.events.indexOf('owned-interrupt-revoke') < h.events.indexOf('ABORTED'));
  assert.ok(h.events.indexOf('ABORTED') < h.events.indexOf('CANCELLED'));
  assert.ok(h.events.includes('stop')); assert.ok(h.events.includes('verifyClosed'));
  assert.ok(!h.events.includes('remove'));
});
test('event-handler cancellation exceptions are sticky rather than uncaught', () => {
  const events = [];
  const signal = interruptHandler({ revoke: () => events.push('revoke'), abort: () => events.push('abort'),
    cancel: () => { throw Error('KILL_FAILED'); }, poison: reason => events.push(reason) });
  assert.doesNotThrow(signal);
  assert.deepEqual(events, ['revoke', 'abort', 'owned-interrupt-cancel']);
});
function probe(body, overrides = {}, prepare = () => {}) {
  const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-owned-negative-'));
  const env = { ...safeEnv(process.env, guard, ledger), ...overrides };
  prepare(ledger, env);
  const result = spawnSync(process.execPath, ['-e', body], { env, cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
  const violations = path.join(ledger, 'violations.log');
  return { ...result, dirty: fs.existsSync(violations) && fs.statSync(violations).size > 0 };
}
for (const host of ['127.0.0.1:8080', 'localhost:8080', '[::1]:8080', '127.0.0.1:8081', 'example.com:8080']) {
  test('bare emulator environment never grants authority: ' + host, () => {
    const result = probe('console.log("NOT_REACHED")', { FIRESTORE_EMULATOR_HOST: host });
    assert.notEqual(result.status, 0); assert.equal(result.dirty, true); assert.ok(!result.stdout.includes('NOT_REACHED'));
  });
}
test('port8080 cannot be admitted by ordinary loopback registration', () => {
  const result = probe(`try{require(${JSON.stringify(guard)}).registerLoopbackPort(8080)}catch{};`);
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
test('launcher API unavailable from arbitrary Node main; caught denial stays fatal', () => {
  const result = probe(`try{require(${JSON.stringify(guard)}).createOwnedLauncher('anything')}catch{};`);
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
test('unregistered8080 excludes direct socket and proxy authority', () => {
  const result = probe(`const g=require(${JSON.stringify(guard)});if(g.isAllowedEndpoint('127.0.0.1',8080))throw Error('allowed');try{require('net').connect(8080,'127.0.0.1')}catch{};`);
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
test('guard retains shared8191 environment compatibility without granting8080', () => {
  const result = probe(`const g=require(${JSON.stringify(guard)});if(!g.isAllowedEndpoint('127.0.0.1',8191)||g.isAllowedEndpoint('127.0.0.1',8080))throw Error('contract');`,
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8191' });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.dirty, false);
});
function capabilityFixture(patch = {}, alter = () => {}) {
  return (ledger, env) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resq-owned-emulator-'));
    const rules = path.join(directory, 'firestore.rules');
    fs.writeFileSync(rules, RULES);
    const p = contract.paths(root);
    const capability = { ...value, launcherPID: process.pid, childPID: process.ppid, createdAt: Date.now(),
      rules, argsHash: sha(JSON.stringify(argv(p, rules))), ...patch };
    fs.writeFileSync(path.join(ledger, 'owned-emulator-capability.json'), JSON.stringify(capability));
    env.RESQ_OWNED_EMULATOR_NONCE = nonce;
    env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    alter(ledger, rules, env);
  };
}
test('actual preload accepts synthetic valid bound capability but never proxy authority', () => {
  const result = probe(`const g=require(${JSON.stringify(guard)});for(const host of ['127.0.0.1','localhost','::1'])if(g.isAllowedEndpoint(host,8080))throw Error('proxy escape');console.log('CAPABILITY_ACCEPTED');`, {}, capabilityFixture());
  assert.equal(result.status, 0, result.stderr); assert.equal(result.dirty, false);
  assert.match(result.stdout, /CAPABILITY_ACCEPTED/);
});
for (const [name, patch] of Object.entries({ expired: { createdAt: 0 }, replacedParent: { launcherPID: 2147483646 },
  deadChild: { childPID: 2147483646 }, changedArgs: { argsHash: 'wrong' }, changedNonce: { nonce: 'b'.repeat(64) } })) {
  test('actual preload rejects capability fixture: ' + name, () => {
    const result = probe('console.log("SHOULD_NOT_RUN")', {}, capabilityFixture(patch));
    assert.notEqual(result.status, 0); assert.equal(result.dirty, true); assert.ok(!result.stdout.includes('SHOULD_NOT_RUN'));
  });
}
test('actual preload rejects altered deny-all rules', () => {
  const result = probe('console.log("SHOULD_NOT_RUN")', {}, capabilityFixture({}, (_, rules) => fs.writeFileSync(rules, RULES.replace('false', 'true'))));
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
test('revocation immediately rejects later socket admission even with forged port registration', () => {
  const result = probe(`const fs=require('fs'),p=require('path'),g=require(${JSON.stringify(guard)});fs.unlinkSync(p.join(process.env.RESQ_CONTAINMENT_DIR,'owned-emulator-capability.json'));fs.writeFileSync(p.join(process.env.RESQ_CONTAINMENT_DIR,'port-8080-999'),'loopback');if(g.isAllowedEndpoint('127.0.0.1',8080))throw Error('proxy escape');try{require('net').connect(8080,'127.0.0.1')}catch{};`, {}, capabilityFixture());
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
for (const host of ['localhost', '::1', '[::1]', '127.0.0.2']) test('valid capability never aliases authority: ' + host, () => {
  const result = probe(`try{require('net').connect(8080,${JSON.stringify(host)})}catch{};`, {}, capabilityFixture());
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
for (const kind of ['direct', 'proxy-http', 'proxy-connect', 'browser']) test('captured auxiliary port receives zero sockets: ' + kind, async () => {
  let connections = 0, requests = 0;
  const sentinel = http.createServer((request, response) => { requests++; response.end('UNREACHABLE'); });
  sentinel.on('connection', () => { connections++; });
  await new Promise(resolve => sentinel.listen(0, '127.0.0.1', resolve));
  const target = sentinel.address().port;
  assert.ok(target >= 49152 && target <= 65535, 'fixture must use the reviewed Windows ephemeral range');
  const dynamicAux = [target, ...[65533, 65534, 65535].filter(port => port !== target).slice(0, 2)].sort((a, b) => a - b);
  const prelude = `const g=require(${JSON.stringify(guard)});if(g.isAllowedEndpoint('127.0.0.1',${target}))throw Error('aux exposed');console.log('AUX_ACTION_REACHED');`;
  let body;
  if (kind === 'direct') body = `${prelude}try{require('net').connect(${target},'127.0.0.1')}catch{};`;
  else if (kind === 'browser') body = `${prelude}(async()=>{const {chromium}=require(${JSON.stringify(path.join(root, 'tests/lib/contained-playwright.cjs'))});const browser=await chromium.launch();try{const page=await browser.newPage();await page.goto('http://127.0.0.1:${target}/').catch(()=>{});}finally{await browser.close().catch(()=>{});}})().catch(e=>{console.error(e.message);process.exitCode=1});`;
  else body = `${prelude}(async()=>{const {startProxy}=require(${JSON.stringify(path.join(root, 'tests/lib/loopback-proxy.cjs'))});const proxy=await startProxy();try{await new Promise(resolve=>{const request=require('http').request(proxy.url,{method:${JSON.stringify(kind === 'proxy-connect' ? 'CONNECT' : 'GET')},path:${JSON.stringify(kind === 'proxy-connect' ? '127.0.0.1:' + target : 'http://127.0.0.1:' + target + '/')}},response=>{response.resume();response.on('end',resolve)});request.on('error',resolve);request.on('connect',(_,socket)=>{socket.destroy();resolve()});request.end();});}finally{await proxy.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});`;
  try {
    const result = probe(body, {}, capabilityFixture({ auxPorts: dynamicAux, topologyHash: sha(JSON.stringify([8080, ...dynamicAux])) }));
    assert.equal(result.error, undefined); assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
    assert.match(result.stdout, /AUX_ACTION_REACHED/);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(connections, 0); assert.equal(requests, 0);
  } finally { sentinel.closeAllConnections(); await new Promise(resolve => sentinel.close(resolve)); }
});
test('captured auxiliary port cannot be ordinary-registered, including after revocation', () => {
  const result = probe(`const g=require(${JSON.stringify(guard)}),fs=require('fs'),p=require('path');fs.unlinkSync(p.join(process.env.RESQ_CONTAINMENT_DIR,'owned-emulator-capability.json'));try{g.registerLoopbackPort(55001)}catch{};if(g.isAllowedEndpoint('127.0.0.1',55001))throw Error('aux exposed');`, {}, capabilityFixture());
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
test('changed capability topology cannot replace admitted authority', () => {
  const result = probe(`const fs=require('fs'),p=require('path'),crypto=require('crypto');const file=p.join(process.env.RESQ_CONTAINMENT_DIR,'owned-emulator-capability.json'),value=JSON.parse(fs.readFileSync(file));value.auxPorts=[55001,55002,55004];value.topologyHash=crypto.createHash('sha256').update(JSON.stringify([8080,...value.auxPorts])).digest('hex');fs.writeFileSync(file,JSON.stringify(value));try{require('net').connect(8080,'127.0.0.1')}catch{};`, {}, capabilityFixture());
  assert.notEqual(result.status, 0); assert.equal(result.dirty, true);
});
