import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyReadClosure } from './mutation-read-closure.mjs';
import { applyAstMutation } from './mutation-ast.mjs';
import { indexSource } from './calendar-assertion-index.mjs';
import reporting from './mutation-reporter.cjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Error('MUTATION_FIXTURE_' + code); };

export const CALENDAR_MANIFEST = Object.freeze([
  ['functions/schedule-calendar-engine.js', 'target'],
  ['functions/schedule-publication.js', 'target'],
  ['functions/schedule-service.js', 'target'],
  ['functions/schedule-runtime.js', 'read-only-source'],
  ['functions/schedule-calendar-engine.test.js', 'suite'],
  ['functions/schedule-publication.test.js', 'suite'],
  ['functions/schedule-service.integration.test.js', 'suite'],
  ['tests/schedule-calendar-source.mjs', 'suite'],
  ['tests/lib/mutation-reporter.cjs', 'support'],
  ['tests/lib/mutation-read-preload.cjs', 'bootstrap'],
  ['tests/lib/calendar-assertion-sites.json', 'parent-data'],
].map(([name, role]) => Object.freeze({ name, role })));

export function validateManifest(manifest) {
  if (!Array.isArray(manifest) || !manifest.length) fail('MANIFEST');
  const seen = new Set();
  for (const entry of manifest) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'name,role'
        || typeof entry.name !== 'string' || !/^[a-zA-Z0-9._/-]+$/.test(entry.name)
        || entry.name.split('/').some(part => !part || part === '.' || part === '..')
        || path.isAbsolute(entry.name) || !['target', 'suite', 'read-only-source', 'support', 'bootstrap', 'parent-data'].includes(entry.role)
        || seen.has(entry.name.toLowerCase())) fail('MANIFEST_PATH');
    seen.add(entry.name.toLowerCase());
  }
}

function canonical(root, name) {
  const base = fs.realpathSync(root);
  let cursor = path.resolve(root);
  if (fs.lstatSync(cursor).isSymbolicLink() || cursor.toLowerCase() !== base.toLowerCase()) fail('ROOT_ALIAS');
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || fs.realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()) fail('PATH_ALIAS');
  }
  if (!fs.lstatSync(cursor).isFile()) fail('NOT_FILE');
  return cursor;
}

export const verifyClosure = records => verifyReadClosure(records.filter(row => row.role !== 'bootstrap'));

export function sanitizeDiagnostic(value, max = 1200) {
  const raw = String(value || '');
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/::[^\r\n]*/g, '[workflow-command]')
    .replace(/(?:Bearer\s+|(?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '[secret]')
    .replace(/(?:sk-ant-|xai-|AIza)[A-Za-z0-9_-]+/g, '[secret]')
    .replace(/[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[path]')
    .replace(/\/(?:[^\s/"'<>]+\/)+[^\s"'<>]*/g, '[path]')
    .replace(/\?[^\s"'<>]*/g, '[query]');
  return text.slice(0, max) + (text.length > max ? '\n[truncated]' : '');
}

export function classify(result) {
  const category = result.error ? (result.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn')
    : result.signal ? 'signal' : result.status === 0 ? 'pass' : Number.isInteger(result.status) ? 'exit' : 'unknown';
  return { category, status: result.status ?? null, signal: result.signal ?? null,
    stdout: sanitizeDiagnostic(result.stdout), stderr: sanitizeDiagnostic(result.stderr) };
}

function childEnv() {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'NODE_OPTIONS', 'RESQ_CONTAINMENT_DIR']) {
    const actual = Object.keys(process.env).find(name => name.toLowerCase() === key.toLowerCase());
    if (actual) env[key] = process.env[actual];
  }
  env.GCLOUD_PROJECT = 'demo-resq'; env.GOOGLE_CLOUD_PROJECT = 'demo-resq';
  env.FIREBASE_CONFIG = '{"projectId":"demo-resq"}'; env.METADATA_SERVER_DETECTION = 'none';
  return env;
}

export function createFixtureHarness(root, manifest = CALENDAR_MANIFEST) {
  validateManifest(manifest);
  const records = manifest.map(entry => {
    const source = canonical(root, entry.name), bytes = fs.readFileSync(source);
    return { ...entry, source, bytes, digest: hash(bytes) };
  });
  verifyClosure(records);
  const indexRecord = records.find(row => row.name === 'tests/lib/calendar-assertion-sites.json');
  let assertionIndex = null;
  if (indexRecord) {
    if (indexRecord.role !== 'parent-data') fail('INDEX_ROLE');
    assertionIndex = JSON.parse(indexRecord.bytes.toString('utf8'));
    const expectedIndex = { schema: 1, suites: Object.fromEntries(records.filter(row => row.role === 'suite')
      .map(row => [row.name, indexSource(row.bytes.toString('utf8'))])) };
    if (JSON.stringify(assertionIndex) !== JSON.stringify(expectedIndex)) fail('ASSERTION_INDEX_MISMATCH');
  }
  function sourceUnchanged() {
    for (const row of records) if (hash(fs.readFileSync(canonical(root, row.name))) !== row.digest) fail('ACTIVE_SOURCE_CHANGED');
  }
  function withFixture(mutation, operation) {
    sourceUnchanged();
    const childRecords = records.filter(row => row.role !== 'parent-data');
    const expected = new Map(childRecords.map(row => [row.name, row.bytes]));
    if (mutation) {
      const row = records.find(item => item.name === mutation.target);
      if (!row || row.role !== 'target' || !mutation.selector) fail('MUTATION_TARGET');
      expected.set(row.name, Buffer.from(applyAstMutation(row.bytes.toString(), mutation)));
      verifyClosure(records.map(entry => ({ ...entry, bytes: entry.role === 'parent-data' ? entry.bytes : expected.get(entry.name) })));
    }
    const temporary = fs.realpathSync(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(temporary, 'resq-calendar-fixture-'));
    const verify = () => {
      const found = [];
      function scan(folder, prefix = '') {
        for (const name of fs.readdirSync(folder)) {
          const relative = prefix + name, target = path.join(folder, name), stat = fs.lstatSync(target);
          if (stat.isSymbolicLink()) fail('DESTINATION_ALIAS');
          if (stat.isDirectory()) scan(target, relative + '/'); else found.push(relative);
        }
      }
      scan(directory);
      if (found.sort().join('|') !== [...expected.keys()].sort().join('|')) fail('DESTINATION_INVENTORY');
      for (const [name, bytes] of expected) if (hash(fs.readFileSync(canonical(directory, name))) !== hash(bytes)) fail('DESTINATION_CHANGED');
    };
    try {
      for (const [name, bytes] of expected) {
        const destination = path.join(directory, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes, { flag: 'wx' });
      }
      verify();
      const metadata = (name, bytes) => {
        if (name !== '.read-capability.json' || expected.has(name) || !Buffer.isBuffer(bytes)) fail('METADATA');
        fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx' });
        expected.set(name, bytes); verify();
      };
      try { return operation(directory, metadata); }
      finally { verify(); sourceUnchanged(); }
    } finally {
      if (path.dirname(directory) !== temporary || !path.basename(directory).startsWith('resq-calendar-fixture-')
          || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('CLEANUP_BOUNDARY');
      fs.rmSync(directory, { recursive: true, force: false, maxRetries: 2 });
    }
  }
  return Object.freeze({
    hashes: Object.freeze(records.map(({ name, role, digest }) => Object.freeze({ name, role, digest }))),
    withFixture,
    run(suite, mutation = null) {
      if (!records.some(row => row.name === suite && row.role === 'suite')) fail('SUITE');
      if (!assertionIndex) fail('ASSERTION_INDEX_REQUIRED');
      const suiteSource = records.find(row => row.name === suite).bytes.toString('utf8');
      return withFixture(mutation, (directory, metadata) => {
        const entry = path.join(directory, suite);
        const capability = Buffer.from(JSON.stringify({ version: 1, root: directory, entry,
          files: records.filter(row => row.role !== 'parent-data').map(row => ({ path: path.join(directory, row.name), sha256: hash(fs.readFileSync(path.join(directory, row.name))) })) }));
        metadata('.read-capability.json', capability);
        const env = childEnv(), nonce = crypto.randomBytes(32).toString('hex');
        env.NODE_OPTIONS = (env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(path.join(directory, 'tests/lib/mutation-read-preload.cjs'));
        env.RESQ_MUTATION_READ_CAPABILITY = path.join(directory, '.read-capability.json');
        env.RESQ_MUTATION_READ_CAPABILITY_SHA = hash(capability);
        env.RESQ_MUTATION_SUITE = suite; env.RESQ_MUTATION_NONCE = nonce;
        const raw = spawnSync(process.execPath, [entry], { cwd: directory, env, shell: false, windowsHide: true,
          encoding: 'utf8', timeout: 30000, maxBuffer: 256 * 1024 });
        const events = []; let adapterError = null;
        for (const line of String(raw.stdout || '').split(/\r?\n/)) {
          if (!line.startsWith('RESQ_MUTATION_EVENT ')) continue;
          try {
            const event = JSON.parse(line.slice(20));
            if (event.nonce !== nonce || event.suite !== suite) throw Error('IDENTITY');
            delete event.nonce;
            // Children supply observations, never authoritative assertion IDs.
            if (event.type === 'assertion-failure') throw Error('CHILD_ASSERTION_ID');
            events.push(event.type === 'assertion-observation'
              ? reporting.mapAssertionObservation(event, { suite, source: suiteSource, index: assertionIndex })
              : event);
          }
          catch { adapterError = 'MALFORMED_MACHINE_EVENT'; }
        }
        return { ...classify(raw), error: raw.error ? { code: raw.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'SPAWN_ERROR' } : null,
          events, adapterError };
      });
    },
  });
}
