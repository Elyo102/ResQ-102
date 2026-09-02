import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cross-file contract guard for the explicit, station-local schedule-manager
// appointment.  Firestore rules are intentionally not the authority reader:
// clients cannot read this collection at all.  The pure schedule-access module
// defines the record contract, and the server runtime/admin modules must agree
// with it while rules keep the entire collection closed to clients.

const testsDir = dirname(fileURLToPath(import.meta.url));
const root = join(testsDir, '..');
const require = createRequire(import.meta.url);

const DECISION = Object.freeze({
  collection: 'schedule_access',
  path: 'stations/{sid}/schedule_access/{uid}',
  role: 'schedule_manager',
  schemaVersion: 1
});

const access = require(join(root, 'functions', 'schedule-access.js'));

function stripComments(source) {
  let result = '';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      result += char;
      if (char === '\\') {
        result += next || '';
        index += 1;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') result += '\n';
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

const rawSources = Object.freeze({
  access: readFileSync(join(root, 'functions', 'schedule-access.js'), 'utf8'),
  admin: readFileSync(join(root, 'functions', 'schedule-access-admin.js'), 'utf8'),
  runtime: readFileSync(join(root, 'functions', 'schedule-runtime.js'), 'utf8'),
  index: readFileSync(join(root, 'functions', 'index.js'), 'utf8'),
  rules: readFileSync(join(root, 'firestore.rules'), 'utf8'),
  backup: readFileSync(join(root, 'functions', 'backup-policy.js'), 'utf8'),
  rulesIsolation: readFileSync(join(root, 'rules-test', 'schedule-access-isolation.test.mjs'), 'utf8'),
  rulesPackage: readFileSync(join(root, 'rules-test', 'package.json'), 'utf8')
});
const sources = Object.freeze(Object.fromEntries(
  Object.entries(rawSources).map(([name, source]) => [name, stripComments(source)])));

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('✓ ' + name);
  } catch (error) {
    console.error('✗ ' + name);
    throw error;
  }
}

function bodyOfFunction(source, name) {
  const match = new RegExp('function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) return '';
  const open = source.indexOf('{', match.index);
  if (open < 0) return '';
  let depth = 0;
  let quote = '';
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return '';
}

function rulesMatchBody(source, pattern) {
  const marker = 'match ' + pattern;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const open = source.indexOf('{', start + marker.length);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return '';
}

function runtimeRefIsCanonical(source) {
  const stationBody = bodyOfFunction(source, 'stationRef');
  const accessBody = bodyOfFunction(source, 'scheduleAccessRef');
  return /return\s+db\.collection\(\s*['"]stations['"]\s*\)\.doc\(\s*sid\s*\)/.test(stationBody)
    && new RegExp("return\\s+stationRef\\(\\s*sid\\s*\\)\\.collection\\(\\s*['\"]"
      + DECISION.collection + "['\"]\\s*\\)\\.doc\\(\\s*uid\\s*\\)").test(accessBody);
}

function adminRefIsCanonical(source) {
  const accessBody = bodyOfFunction(source, 'accessRef');
  return new RegExp("return\\s+db\\.collection\\(\\s*['\"]stations['\"]\\s*\\)"
    + "\\.doc\\(\\s*stationId\\s*\\)\\.collection\\(\\s*['\"]"
    + DECISION.collection + "['\"]\\s*\\)\\.doc\\(\\s*uid\\s*\\)").test(accessBody);
}

const SID = 'station_102';
const UID = 'firefighter.name';
const canonical = access.nextRecord(null, SID, UID, true);

test('the canonical schema version matches the approved contract', () => {
  assert.equal(access.SCHEDULE_ACCESS_SCHEMA_VERSION, DECISION.schemaVersion);
});

test('the canonical capability name matches the approved contract', () => {
  assert.equal(access.SCHEDULE_MANAGER_ROLE, DECISION.role);
});

test('the canonical writer emits only the closed appointment fields', () => {
  assert.deepEqual(Object.keys(canonical).sort(),
    ['active', 'revision', 'roles', 'schema_version', 'station_id', 'uid']);
  assert.deepEqual(canonical, {
    schema_version: 1,
    station_id: SID,
    uid: UID,
    roles: [DECISION.role],
    active: true,
    revision: 1
  });
});

test('Firebase UIDs containing a dot remain valid document ids', () => {
  assert.equal(access.validUid(UID), true);
  assert.equal(access.validUid('bad/uid'), false);
});

test('only the exact live local appointment grants management', () => {
  assert.equal(access.isManagerAccess(canonical, SID, UID), true);
  for (const corrupt of [
    { active: false },
    { station_id: 'other_102' },
    { uid: 'someone_else' },
    { roles: ['commander'] },
    { roles: [DECISION.role, 'commander'] },
    { revision: 0 },
    { schema_version: 2 }
  ]) {
    assert.equal(access.isManagerAccess({ ...canonical, ...corrupt }, SID, UID), false,
      JSON.stringify(corrupt));
  }
});

test('revocation clears the capability and advances the revision', () => {
  const revoked = access.nextRecord(canonical, SID, UID, false);
  assert.equal(revoked.active, false);
  assert.deepEqual(revoked.roles, []);
  assert.equal(revoked.revision, 2);
  assert.equal(access.isManagerAccess(revoked, SID, UID), false);
});

const managerGateBody = bodyOfFunction(sources.runtime, 'requireLiveManager');

test('runtime imports the canonical appointment module', () => {
  assert.match(sources.runtime, /require\(['"]\.\/schedule-access['"]\)/);
});

test('appointment administration imports the canonical module', () => {
  assert.match(sources.admin, /require\(['"]\.\/schedule-access['"]\)/);
});

test('runtime reads the approved station-scoped collection', () => {
  assert.equal(runtimeRefIsCanonical(sources.runtime), true);
});

test('appointment administration writes the same collection', () => {
  assert.equal(adminRefIsCanonical(sources.admin), true);
});

test('a root-level runtime collection mutation is detected', () => {
  const broken = sources.runtime.replace(
    "return stationRef(sid).collection('schedule_access').doc(uid);",
    "return db.collection('schedule_access').doc(uid);");
  assert.notEqual(broken, sources.runtime);
  assert.equal(runtimeRefIsCanonical(broken), false);
});

test('a root-level writer collection mutation is detected', () => {
  const broken = sources.admin.replace(
    "return db.collection('stations').doc(stationId).collection('schedule_access').doc(uid);",
    "return db.collection('schedule_access').doc(uid);");
  assert.notEqual(broken, sources.admin);
  assert.equal(adminRefIsCanonical(broken), false);
});

test('the runtime management gate requires both live membership and the appointment', () => {
  assert.match(managerGateBody, /scheduleAccess\.activeMember\(user,\s*ctx\.sid\)/);
  assert.match(managerGateBody, /scheduleAccess\.isManagerAccess\(access,\s*ctx\.sid,\s*ctx\.uid\)/);
});

test('runtime context reads station identity from the authenticated token, not request data', () => {
  const contextBody = bodyOfFunction(sources.runtime, 'context');
  assert.match(contextBody, /token\.stationId/);
  assert.doesNotMatch(contextBody, /req\.data\.(?:station|stationId|station_id)/);
});

test('the server writer delegates record construction to the canonical module', () => {
  const setBody = bodyOfFunction(sources.admin, 'set');
  assert.match(setBody,
    /const\s+next\s*=\s*scheduleAccess\.nextRecord\(previous,\s*stationId,\s*uid,\s*data\.enabled\)/);
  assert.match(setBody,
    /tx\.set\(refs\[1\],\s*Object\.assign\(\{\},\s*next,\s*\{/);
  assert.doesNotMatch(setBody, /setCustomUserClaims|schedule_manager_version/);
});

test('primary role fields cannot turn a non-appointment into management authority', () => {
  for (const primary_role of ['commander', 'deputy', 'hr_coordinator', 'superadmin']) {
    assert.equal(access.isManagerAccess({ ...canonical, roles: [], primary_role }, SID, UID), false);
  }
});

test('the client cannot choose a station while granting or revoking access', () => {
  const setBody = bodyOfFunction(sources.admin, 'set');
  assert.match(setBody, /dataOf\(req,\s*\['uid',\s*'enabled'\]\)/);
  assert.doesNotMatch(setBody, /data\.(?:station|stationId|station_id)/);
});

const stationRulesBody = rulesMatchBody(sources.rules, '/stations/{sid}');
const rulesBody = rulesMatchBody(stationRulesBody, '/schedule_access/{uid}');

test('Firestore rules contain an explicit station-scoped appointment block', () => {
  assert.ok(stationRulesBody.length > 0);
  assert.ok(rulesBody.length > 0);
});

test('Firestore rules deny every direct client read and write', () => {
  assert.match(rulesBody.replace(/\s+/g, ' '), /allow read, write: if false\s*;/);
  assert.doesNotMatch(rulesBody, /allow\s+(?:get|list|create|update|delete)\s*:/);
});

test('the emulator gate exercises every direct appointment operation', () => {
  for (const operation of ['getDoc', 'getDocs', 'setDoc', 'updateDoc', 'deleteDoc']) {
    assert.match(sources.rulesIsolation, new RegExp('\\b' + operation + '\\s*\\('));
  }
  assert.match(sources.rulesPackage, /node\s+schedule-access-isolation\.test\.mjs/);
});

test('the public callable boundary enforces App Check for list and mutation', () => {
  assert.match(sources.index,
    /exports\.getScheduleManagerAccess\s*=\s*onCall\(\{\s*enforceAppCheck:\s*true\s*\}/);
  assert.match(sources.index,
    /exports\.setScheduleManagerAccess\s*=\s*onCall\(\{\s*enforceAppCheck:\s*true\s*\}/);
});

test('the public callable boundary delegates to the audited admin service', () => {
  assert.match(sources.index, /scheduleAccessAdmin\.list\(req\)/);
  assert.match(sources.index, /scheduleAccessAdmin\.set\(req\)/);
});

test('the live appointment is included in backup policy', () => {
  assert.ok(sources.backup.includes("policy('" + DECISION.path + "'"));
});

assert.equal(passed, 23);
console.log('\n23 schedule-access cross-file contract checks passed.');
