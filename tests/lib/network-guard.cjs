'use strict';

// Test containment, not an OS sandbox against deliberately hostile test code.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');
const cp = require('node:child_process');
const os = require('node:os');
const owned = require('./owned-emulator-contract.cjs');
const { syncBuiltinESMExports } = require('node:module');
const STATE = Symbol.for('resq.test.networkContainment');
function optionTokens(value) {
  if (typeof value !== 'string') return [];
  const tokens = [];
  let token = '', quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"') { quoted = !quoted; continue; }
    if (char === '\\' && quoted && ['\\', '"'].includes(value[i + 1])) { token += value[++i]; continue; }
    if (/\s/.test(char) && !quoted) { if (token) tokens.push(token); token = ''; }
    else token += char;
  }
  if (quoted) return [];
  if (token) tokens.push(token);
  return tokens;
}
function exactPreload(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  try {
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    return normalize(fs.realpathSync(candidate)) === normalize(fs.realpathSync(__filename));
  } catch (_) { return false; }
}
function hasGuardPreload(value) {
  const tokens = Array.isArray(value) ? value : optionTokens(value);
  return tokens.some((token, index) => ((token === '--require' || token === '-r') && exactPreload(tokens[index + 1]))
    || (token.startsWith('--require=') && exactPreload(token.slice('--require='.length))));
}
function isRegisteredShellCommand(value, registry) {
  let command = String(value || '').trim();
  if (command.startsWith('"') && command.endsWith('"')) command = command.slice(1, -1);
  if (!command || !registry || /[\r\n|<>`$;]/.test(command) || command.replaceAll('&&', '').includes('&')) return false;
  const directScript = Object.values(registry).includes(command);
  const npmRun = command.match(/^(?:"[^"\r\n]*[\\/]npm\.cmd"|npm(?:\.cmd)?)\s+(?:run\s+([a-zA-Z0-9:_-]+)|(test))$/);
  return directScript || !!(npmRun && Object.hasOwn(registry, npmRun[1] || 'test'));
}
const preloadRequested = hasGuardPreload(process.env.NODE_OPTIONS) || hasGuardPreload(process.execArgv);

if (preloadRequested) {
if (!globalThis[STATE]) {
  const directory = process.env.RESQ_CONTAINMENT_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error('Containment requires an absolute RESQ_CONTAINMENT_DIR');
  fs.mkdirSync(directory, { recursive: true });
  const resolvedDirectory = fs.realpathSync(directory);
  const violationFile = path.join(resolvedDirectory, 'violations.log');
  let dirty = false;
  let ownedPermit = null, ownedReadiness = false, ownedLauncherCreated = false, ownedMode = null;
  const ownedAuxPorts = new Set();
  let ownedTopologyHash = null;
  const ownedMarker = path.join(resolvedDirectory, 'owned-emulator-capability.json');
  function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
  function ownedCapability() {
    try {
      const value = JSON.parse(owned.regular(ownedMarker));
      const root = path.resolve(__dirname, '../..');
      owned.assertTemporary(path.dirname(value.rules));
      if (owned.sha(owned.regular(value.rules)) !== owned.PIN.rulesHash) return false;
      owned.validateCapability(value, { nonce: process.env.RESQ_OWNED_EMULATOR_NONCE,
        parentPID: process.ppid, rules: value.rules,
        argsHash: owned.sha(JSON.stringify(owned.argv(owned.paths(root), value.rules))) }, alive);
      if (ownedTopologyHash !== null && ownedTopologyHash !== value.topologyHash) return false;
      ownedTopologyHash = value.topologyHash;
      value.auxPorts.forEach(port => ownedAuxPorts.add(port));
      return true;
    } catch (_) { return false; }
  }
  function poison(reason) {
    dirty = true;
    process.exitCode = 1;
    // Callers supply categories, never full URLs, headers, credentials or bodies.
    fs.appendFileSync(violationFile, JSON.stringify({ pid: process.pid, reason: String(reason).slice(0, 160) }) + '\n');
  }
  function deny(reason) {
    poison(reason);
    const error = new Error('RESQ containment denied: ' + reason);
    error.code = 'RESQ_EGRESS_DENIED';
    throw error;
  }
  function assertClean() {
    if (dirty || (fs.existsSync(violationFile) && fs.statSync(violationFile).size > 0)) {
      process.exitCode = 1;
      const error = new Error('RESQ containment recorded a network/process violation');
      error.code = 'RESQ_CONTAINMENT_DIRTY';
      throw error;
    }
  }
  function canonicalHost(host) {
    return typeof host === 'string' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
  }
  function portNumber(port) {
    if (typeof port === 'string' && !/^[1-9]\d{0,4}$/.test(port)) return null;
    const value = Number(port);
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
  }
  function registerLoopbackPort(port) {
    const value = portNumber(port);
    if (value === null || value === 8080 || ownedAuxPorts.has(value)) deny('invalid-loopback-registration');
    fs.writeFileSync(path.join(resolvedDirectory, 'port-' + value + '-' + process.pid), 'loopback\n');
    return value;
  }
  function isAllowedEndpoint(host, port) {
    const value = portNumber(port);
    return value !== 8080 && !ownedAuxPorts.has(value) && canonicalHost(host) && value !== null && fs.readdirSync(resolvedDirectory)
      .some(name => name.startsWith('port-' + value + '-') && /^port-\d+-\d+$/.test(name));
  }
  function checkEndpoint(host, port) {
    // This authority is deliberately excluded from isAllowedEndpoint, so HTTP/CONNECT
    // browser proxies cannot turn the integration-only capability into browser access.
    if (host === '127.0.0.1' && portNumber(port) === 8080 && (ownedReadiness || ownedCapability())) return;
    if (!isAllowedEndpoint(host, port)) deny('unregistered-or-nonloopback-socket');
  }
  function socketOptions(args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') return first;
    if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
      return { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    }
    return { path: first };
  }
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = socketOptions(args);
    if (options.path) deny('socket-path-not-authorized');
    checkEndpoint(options.host || 'localhost', options.port);
    return originalConnect.apply(this, args);
  };
  const originalTls = tls.connect;
  tls.connect = function (...args) {
    const options = socketOptions(args);
    if (options.socket) {
      const socket = options.socket;
      checkEndpoint(socket.remoteAddress, socket.remotePort);
    } else checkEndpoint(options.host || 'localhost', options.port);
    return originalTls.apply(this, args);
  };
  function localLookup(host, options, callback) {
    if (!canonicalHost(host)) deny('external-dns');
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = typeof options === 'number' ? options : options?.family;
    const address = family === 6 || host === '::1' || host === '[::1]' ? '::1' : '127.0.0.1';
    const result = { address, family: address === '::1' ? 6 : 4 };
    process.nextTick(() => options?.all ? callback(null, [result]) : callback(null, result.address, result.family));
  }
  dns.lookup = localLookup;
  dns.promises.lookup = (host, options) => new Promise((resolve, reject) => localLookup(host, options,
    (error, address, family) => error ? reject(error) : resolve(Array.isArray(address) ? address : { address, family })));
  for (const name of ['lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname',
    'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    if (typeof dns[name] === 'function') {
      dns[name] = () => deny('external-dns-query');
    }
    if (typeof dns.promises[name] === 'function') {
      dns.promises[name] = async () => deny('external-dns-query');
    }
    for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
      if (Resolver?.prototype && typeof Resolver.prototype[name] === 'function') {
        Resolver.prototype[name] = () => deny('external-resolver-query');
      }
    }
  }
  dgram.Socket.prototype.send = () => deny('udp-send');
  dgram.Socket.prototype.connect = () => deny('udp-connect');
  // Server fixtures become reachable only after their loopback listener exists.
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (args[0] && typeof args[0] === 'object') {
      if (args[0].path || args[0].fd !== undefined) deny('non-tcp-listener');
      args[0] = { ...args[0], host: args[0].host || '127.0.0.1' };
      if (!canonicalHost(args[0].host)) deny('nonloopback-listener');
    } else if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
      if (typeof args[1] === 'string') {
        if (!canonicalHost(args[1])) deny('nonloopback-listener');
      } else args.splice(1, 0, '127.0.0.1');
    } else deny('non-tcp-listener');
    this.prependOnceListener('listening', () => {
      const address = this.address();
      if (!address || typeof address === 'string' || !canonicalHost(address.address)) deny('nonloopback-listener-address');
      registerLoopbackPort(address.port);
    });
    return originalListen.apply(this, args);
  };
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    if (process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8080') {
      if (process.env.GCLOUD_PROJECT !== 'demo-resq' || process.env.GOOGLE_CLOUD_PROJECT !== 'demo-resq'
        || process.env.FIREBASE_CONFIG !== '{"projectId":"demo-resq"}' || !ownedCapability()) deny('unsafe-owned-emulator-environment');
    } else {
      if (!['127.0.0.1:8191', 'localhost:8191', '127.0.0.1:8199'].includes(process.env.FIRESTORE_EMULATOR_HOST)
      || process.env.GCLOUD_PROJECT !== 'demo-resq'
      || (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== 'demo-resq')) deny('unsafe-emulator-environment');
      registerLoopbackPort(Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]));
    }
  }
  function assertChildEnvironment(options, file) {
    const env = options?.env || process.env;
    const dirMatch = env.RESQ_CONTAINMENT_DIR === directory;
    const hasGuard = hasGuardPreload(env.NODE_OPTIONS);
    if (!dirMatch || !hasGuard) {
      const executable = path.basename(String(file || '')).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48);
      deny('child-stripped-containment executable=' + executable + ' dirMatch=' + dirMatch + ' hasGuard=' + hasGuard);
    }
    if (options?.shell) deny('implicit-child-shell');
  }
  const readonlyGit = new Set(['status', 'diff', 'show', 'log', 'rev-parse', 'rev-list', 'ls-tree', 'ls-files',
    'cat-file', 'hash-object', 'check-attr', 'check-ignore', 'config', 'version']);
  const repository = path.resolve(__dirname, '../..');
  const scriptRegistries = new Map(['tests', 'rules-test', 'functions'].map(name => {
    const cwd = path.join(repository, name);
    const value = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return [cwd.toLowerCase(), value.scripts || {}];
  }));
  function isWithin(candidate, parent) {
    const relative = path.relative(parent, candidate);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  }
  function localBundleClone(args) {
    if (args.length !== 3 || args[0] !== 'clone' || args.slice(1).some(value => /^-|:\/\/|^[a-z]+::/i.test(value))) return false;
    const [source, target] = args.slice(1).map(value => path.resolve(value));
    if (path.basename(source) !== 'repository.bundle' || !fs.existsSync(source) || !fs.statSync(source).isFile()
      || fs.existsSync(target) || !fs.existsSync(path.dirname(target))) return false;
    const temporary = fs.realpathSync(os.tmpdir());
    return isWithin(fs.realpathSync(source), temporary) && isWithin(fs.realpathSync(path.dirname(target)), temporary);
  }
  function checkCommand(file, args = [], options = {}) {
    if (ownedMode === 'startup-only' && args.some(arg => path.resolve(String(arg)) === owned.paths(repository).integration)) deny('owned-diagnostic-integration');
    if (ownedPermit && file === ownedPermit.file && JSON.stringify(args) === JSON.stringify(ownedPermit.args)
      && options.cwd === ownedPermit.cwd && !options.shell
      && JSON.stringify(options.env) === JSON.stringify(ownedPermit.env)) {
      ownedPermit = null;
      return;
    }
    const name = path.basename(String(file)).toLowerCase();
    if (path.resolve(String(file)) === path.resolve(process.execPath) || name === 'node' || name === 'node.exe') return;
    if (name === 'git' || name === 'git.exe') {
      let words = args;
      if (words[0] === '-c' && words[1] === 'core.autocrlf=false') words = words.slice(2);
      if (localBundleClone(words)) return;
      if (!readonlyGit.has(words[0]) || words.includes('-w') || words.includes('--ext-diff')
        || (words[0] === 'config' && !words.includes('--get')
        && !words.includes('--get-regexp') && !words.includes('--list'))) deny('git-command-not-readonly');
      return;
    }
    if (/[/\\]ms-playwright[/\\]/i.test(String(file)) && /^(chrome|chromium|chrome-headless-shell)(\.exe)?$/.test(name)) {
      if (!args.some(x => String(x).startsWith('--proxy-server=http://127.0.0.1:'))
        || !args.includes('--disable-quic')) deny('browser-without-containment-proxy');
      return;
    }
    if (name === 'cmd.exe' || name === 'cmd') {
      const at = args.findIndex(x => /^\/c$/i.test(x));
      const command = at >= 0 ? args.slice(at + 1).join(' ') : '';
      const registry = scriptRegistries.get(path.resolve(options.cwd || process.cwd()).toLowerCase());
      if (!isRegisteredShellCommand(command, registry)) deny('unapproved-shell-command');
      return;
    }
    if (process.platform !== 'win32' && file === '/bin/sh') {
      const registry = scriptRegistries.get(path.resolve(options.cwd || process.cwd()).toLowerCase());
      if (args.length !== 2 || args[0] !== '-c' || !isRegisteredShellCommand(args[1], registry)) {
        deny('unapproved-posix-shell-command');
      }
      return;
    }
    deny('unapproved-child-executable');
  }
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[method];
    cp[method] = function (file, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const options = rest.find(value => value && typeof value === 'object' && !Array.isArray(value));
      assertChildEnvironment(options, file);
      checkCommand(file, args, options);
      return original.call(this, file, ...rest);
    };
  }
  const originalFork = cp.fork;
  cp.fork = function (file, ...rest) {
    const options = rest.find(value => value && typeof value === 'object' && !Array.isArray(value));
    assertChildEnvironment(options, options?.execPath || process.execPath);
    if (options?.execPath && path.resolve(options.execPath) !== path.resolve(process.execPath)) deny('fork-executable-override');
    return originalFork.call(this, file, ...rest);
  };
  for (const method of ['exec', 'execSync']) cp[method] = () => deny('unapproved-shell-exec');
  const originalExit = process.exit;
  process.exit = function (code) {
    try { assertClean(); } catch (_) { code = 1; }
    return originalExit.call(this, code);
  };
  process.on('exit', () => { try { assertClean(); } catch (_) { process.exitCode = 1; } });
  function createOwnedLauncher(directory) {
    const root = path.resolve(__dirname, '../..'), p = owned.paths(root);
    if (ownedLauncherCreated || path.resolve(process.argv[1] || '') !== p.launcher) deny('owned-launcher-entry');
    ownedMode = owned.runnerMode(process.argv.slice(2));
    ownedLauncherCreated = true;
    const plan = owned.validatePins(root, directory);
    if (owned.sha(owned.regular(plan.probe).toString().replace(/\r\n/g, '\n')) !== '0e07fefcd32742c9be539f56f559b5038165c67d43f816474d955f62857379dd') deny('owned-probe-pin');
    if (fs.existsSync(ownedMarker)) deny('owned-stale-capability');
    const env = owned.safeEnv(process.env, __filename, resolvedDirectory);
    let child = null, attempted = false, verifiedAt = 0, ready = false, spawnedAt = 0, createdAt = null, forceAttempted = false, topology = null;
    function permit(file, args, callback) {
      if (ownedPermit) deny('owned-nested-permit');
      ownedPermit = { file, args, cwd: plan.directory, env };
      try { return callback({ cwd: plan.directory, env, shell: false, windowsHide: true }); }
      finally { ownedPermit = null; }
    }
    function probe(pid = 0, cleanup = false) {
        if (pid !== 0 && (!child || pid !== child.pid)) deny('owned-probe-target');
        const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', plan.probe, '-TargetProcessId', String(pid),
          '-CapturedPorts', (topology || [8080]).join(',')];
        const result = permit(plan.powershell, args, options => cp.spawnSync(plan.powershell, args,
          { ...options, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }));
        if (result.error || result.status !== 0) deny('owned-probe-failed');
        const observation = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
        if (pid && child.exitCode === null && child.signalCode === null && observation.process) {
          if (createdAt === null) {
            const birth = Date.parse(observation.process.createdAt);
            if (!Number.isFinite(birth) || birth < spawnedAt - 1000 || birth > Date.now()) deny('owned-creation-outside-spawn');
            owned.validateOwnedProcess(observation, plan, pid, process.pid, observation.process.createdAt);
            createdAt = observation.process.createdAt;
          }
          owned.validateOwnedProcess(observation, plan, pid, process.pid, createdAt);
        }
        if (pid && !cleanup) {
          if (child.exitCode !== null || child.signalCode !== null) deny('owned-probe-child-exited');
          topology = owned.validateObservation(observation, plan, pid, process.pid, createdAt, topology);
          topology.slice(1).forEach(port => ownedAuxPorts.add(port));
          ownedTopologyHash = owned.sha(JSON.stringify(topology));
          verifiedAt = Date.now();
        }
        return observation;
    }
    return Object.freeze({
      plan, env, probe,
      get topology() { return topology && [...topology]; },
      spawn() {
        if (attempted) deny('owned-spawn-repeated');
        attempted = true;
        // Recheck immutable artifacts at the mutation boundary.
        owned.validatePins(root, directory);
        spawnedAt = Date.now();
        child = permit(plan.java, plan.args, options => cp.spawn(plan.java, plan.args,
          { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }));
        return child;
      },
      stopTree(force = false) {
        if (!child || !createdAt || child.exitCode !== null || child.signalCode !== null) deny('owned-stop-no-live-identity');
        const observation = probe(child.pid, true);
        owned.validateOwnedProcess(observation, plan, child.pid, process.pid, createdAt);
        if (force && forceAttempted) deny('owned-force-repeated');
        if (force) forceAttempted = true;
        const args = ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])];
        const result = permit(plan.taskkill, args, options => cp.spawnSync(plan.taskkill, args,
          { ...options, encoding: 'utf8', timeout: 5000, maxBuffer: 8192 }));
        // A graceful Windows close request may be unsupported by a headless JVM.
        // The caller must wait boundedly and re-prove identity before the one force attempt.
        if (force && (result.error || result.status !== 0)) deny('owned-force-failed');
      },
      async readiness(callback) {
        if (!child || child.exitCode !== null || child.signalCode !== null || Date.now() - verifiedAt > 2000) deny('owned-readiness-without-owner');
        ownedReadiness = true;
        try { return await callback(); } finally { ownedReadiness = false; }
      },
      activate(nonce, evidence) {
        if (ownedMode === 'startup-only' || ready || !child || child.exitCode !== null || child.signalCode !== null || Date.now() - verifiedAt > 2000
          || !/^[a-f0-9]{64}$/.test(nonce) || evidence !== 'STARTUP_AND_EMPTY_FIRESTORE_JSON_VERIFIED') deny('owned-activation-precondition');
        ready = true;
        const value = { host: owned.PIN.host, port: owned.PIN.port, project: owned.PIN.project,
          launcherPID: process.pid, childPID: child.pid, nonce, createdAt: Date.now(),
          javaHash: owned.PIN.javaHash, jarHash: owned.PIN.jarHash, rulesHash: owned.PIN.rulesHash,
          rules: plan.rules, argsHash: plan.argsHash, auxPorts: topology.slice(1), topologyHash: ownedTopologyHash };
        fs.writeFileSync(ownedMarker, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      },
      revoke() { ownedReadiness = false; if (fs.existsSync(ownedMarker)) fs.unlinkSync(ownedMarker); },
    });
  }
  globalThis[STATE] = Object.freeze({ assertActive: () => true, registerLoopbackPort, poison, assertClean, createOwnedLauncher,
    isAllowedEndpoint, getDirectory: () => resolvedDirectory, hasGuardPreload, isRegisteredShellCommand });
  syncBuiltinESMExports();
}
module.exports = globalThis[STATE];
} else {
  const inactive = () => { throw new Error('Containment requires the Node preload before fixture imports'); };
  module.exports = Object.freeze({ assertActive: inactive, registerLoopbackPort: inactive, poison: inactive,
    assertClean: inactive, isAllowedEndpoint: inactive, getDirectory: inactive, hasGuardPreload, isRegisteredShellCommand });
}
