import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'functions', 'index.js'), 'utf8');
const runtime = fs.readFileSync(path.join(here, '..', 'functions', 'schedule-runtime.js'), 'utf8');

const reMatch = source.match(/const STATION_ID_RE = (\/.*\/);/);
const fnMatch = source.match(/function callerStation\(req, auth\) \{[\s\S]*?\n\}/);
assert.ok(reMatch, 'STATION_ID_RE must exist in production source');
assert.ok(fnMatch, 'callerStation must exist in production source');

class TestHttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const context = {
  HttpsError: TestHttpsError,
  STATION_ID_RE: new RegExp(reMatch[1].slice(1, -1))
};
vm.runInNewContext(`${fnMatch[0]}; this.callerStation = callerStation;`, context);
const callerStation = context.callerStation;

function expectCode(req, auth, expected) {
  assert.throws(() => callerStation(req, auth), (err) => err.code === expected);
}

assert.equal(callerStation({ data: {} }, { token: { stationId: 'eilat_102' } }), 'eilat_102');
assert.equal(callerStation({}, { token: { stationId: 'beer_sheva-1' } }), 'beer_sheva-1');

for (const stationId of ['', ' ', 'A', 'ab.cd', 'AB', 'a'.repeat(81)]) {
  expectCode({ data: {} }, { token: { stationId } }, 'failed-precondition');
}
expectCode({ data: {} }, { token: { super: true } }, 'failed-precondition');
expectCode({ data: {} }, {}, 'failed-precondition');
expectCode({ data: {} }, null, 'failed-precondition');

for (const stationId of ['', 'eilat_102', 'other_station']) {
  expectCode({ data: { stationId } }, { token: { stationId: 'eilat_102' } }, 'invalid-argument');
}

const exportsToCheck = [
  'sendBroadcast',
  'claimPushToken'
];

for (let i = 0; i < exportsToCheck.length; i += 1) {
  const name = exportsToCheck[i];
  const start = source.indexOf(`exports.${name} =`);
  assert.notEqual(start, -1, `${name} export must exist`);
  const next = i + 1 < exportsToCheck.length
    ? source.indexOf(`exports.${exportsToCheck[i + 1]} =`, start + 1)
    : source.length;
  const block = source.slice(start, next === -1 ? source.length : next);
  assert.match(block, /const sid\s*=\s*callerStation\(req, auth\);/,
    `${name} must source station from callerStation`);
  assert.doesNotMatch(block, /stationId\s*\|\|\s*PUSH_STATION/,
    `${name} must not fall back to the pilot station`);
}

function calloutStationErrors(candidate) {
  const errors = [];
  const actorStart = candidate.indexOf('async function freshCalloutActor(req) {');
  const actorEnd = candidate.indexOf('\n}', actorStart);
  const actorBlock = actorStart === -1 || actorEnd === -1 ? '' : candidate.slice(actorStart, actorEnd + 2);
  if (!/const homeSid\s*=\s*callerStation\(req, signed\);/.test(actorBlock)) {
    errors.push('fresh actor derives station from the verified token boundary');
  }
  if (!/admin\.auth\(\)\.getUser\(signed\.uid\)/.test(actorBlock)
      || !/String\(claims\.stationId \|\| ''\) !== homeSid/.test(actorBlock)
      || !/String\(signedClaims\.stationId \|\| ''\) !== homeSid/.test(actorBlock)) {
    errors.push('fresh Auth claims must match the signed station');
  }
  if (!/const isSuper = claims\.super === true;/.test(actorBlock)
      || !/\(signedClaims\.super === true\) !== isSuper/.test(actorBlock)) {
    errors.push('super targeting requires strict matching signed and fresh privilege');
  }
  if (!/const targetSid = \(req\.data \|\| \{\}\)\.target_station_id;/.test(actorBlock)
      || !/if \(!isSuper && targetSid !== undefined\) \{\s*throw new HttpsError\('permission-denied'/.test(actorBlock)
      || !/const sid = isSuper \? String\(targetSid \|\| ''\) : homeSid;/.test(actorBlock)
      || !/if \(!STATION_ID_RE\.test\(sid\)\) \{\s*throw new HttpsError\('invalid-argument'/.test(actorBlock)) {
    errors.push('ordinary callers stay token-bound and super must explicitly select a valid target');
  }
  if (!/if \(isSuper && sid !== homeSid && !\(await db\.doc\('stations\/' \+ sid\)\.get\(\)\)\.exists\)/.test(actorBlock)
      || !/db\.doc\('stations\/' \+ homeSid \+ '\/users\/' \+ signed\.uid\)\.get\(\)/.test(actorBlock)) {
    errors.push('target station must exist while actor profile stays bound to home station');
  }
  for (const name of ['sendCallout', 'closeCallout']) {
    const start = candidate.indexOf(`exports.${name} =`);
    const next = candidate.indexOf('\nexports.', start + 1);
    const block = start === -1 ? '' : candidate.slice(start, next === -1 ? candidate.length : next);
    if (!/const actor\s*=\s*await freshCalloutActor\(req\);/.test(block)
        || !/const sid\s*=\s*actor\.sid;/.test(block)) {
      errors.push(name + ' uses only the freshly verified actor station');
    }
  }
  return errors;
}

assert.deepEqual(calloutStationErrors(source), [],
  'callout station authority is derived from live Auth claims, not client data or stale claims');
for (const [label, mutant] of [
  ['request-data home station', source.replace('const homeSid = callerStation(req, signed);',
    "const homeSid = String((req.data || {}).stationId || '');")],
  ['fresh-claim comparison removed', source.replace("String(claims.stationId || '') !== homeSid ||", 'false ||')],
  ['truthy super', source.replace('const isSuper = claims.super === true;', 'const isSuper = Boolean(claims.super);')],
  ['signed super comparison removed', source.replace('(signedClaims.super === true) !== isSuper ||', 'false ||')],
  ['ordinary target allowed', source.replace('!isSuper && targetSid !== undefined', 'false && targetSid !== undefined')],
  ['super target defaults to home', source.replace("isSuper ? String(targetSid || '') : homeSid", 'isSuper ? String(targetSid || homeSid) : homeSid')],
  ['target existence skipped', source.replace('isSuper && sid !== homeSid && !(await', 'false && sid !== homeSid && !(await')],
  ['actor profile read from target', source.replace("db.doc('stations/' + homeSid + '/users/' + signed.uid)", "db.doc('stations/' + sid + '/users/' + signed.uid)")],
  ['send reverts to stale claims', source.replace('const sid = actor.sid;', 'const sid = callerStation(req, auth);')]
]) {
  assert.notEqual(mutant, source, label + ' mutation must actually alter source');
  assert.ok(calloutStationErrors(mutant).length > 0, label + ' mutation is rejected');
}

assert.equal((source.match(/stationId\s*\|\|\s*PUSH_STATION/g) || []).length, 0,
  'no user-triggered function may silently fall back to PUSH_STATION');

// Guard operations intentionally use the schedule-runtime gateway rather
// than the legacy callerStation helper.  The gateway is stricter: it rejects
// both station spellings supplied by a client, derives sid from the token,
// and verifies the live member before opening a station document.
const signupStart = source.indexOf('exports.guardSignup =');
const assignStart = source.indexOf('exports.assignGuard =', signupStart);
const guardOpenStart = source.indexOf('exports.onGuardOpen =', assignStart);
assert.ok(signupStart !== -1 && assignStart > signupStart && guardOpenStart > assignStart,
  'guard callable wrappers must remain ordered and present');
const signupWrapper = source.slice(signupStart, assignStart);
const assignWrapper = source.slice(assignStart, guardOpenStart);
assert.match(signupWrapper, /onCall\(\{\s*enforceAppCheck:\s*true\s*\}/,
  'guard signup must enforce App Check');
assert.match(signupWrapper, /invokeSchedule\('signupGuard',\s*req\)/,
  'guard signup must delegate the original request to the server gateway');
assert.doesNotMatch(signupWrapper, /\b(callerStation|db|sid|stationId|station_id)\b/,
  'guard signup wrapper must not derive or accept a station itself');

assert.match(assignWrapper, /onCall\(\{\s*enforceAppCheck:\s*true\s*\}/,
  'legacy guard assignment must enforce App Check');
assert.match(assignWrapper, /invokeSchedule\('manageGuard',\s*Object\.assign\(\{\},\s*req/,
  'legacy guard assignment must use the server manager gateway');
assert.match(assignWrapper, /data:\s*\{[\s\S]*action:\s*'set_assignees'[\s\S]*request_id:[\s\S]*guard_id:[\s\S]*expected_revision:[\s\S]*uids:/,
  'legacy guard assignment must build an explicit allowlisted payload');
assert.doesNotMatch(assignWrapper, /\b(callerStation|db|sid|stationId|station_id)\b/,
  'legacy guard assignment must not accept a station payload');

const contextStart = runtime.indexOf('async function context(req) {');
const actorStart = runtime.indexOf('function actor(ctx) {', contextStart);
const runtimeSignupStart = runtime.indexOf('async function signupGuard(req) {');
const modeStart = runtime.indexOf('function requireMode(config, allowed) {', runtimeSignupStart);
assert.ok(contextStart !== -1 && actorStart > contextStart
  && runtimeSignupStart !== -1 && modeStart > runtimeSignupStart,
  'schedule runtime context and signup gate must exist');
const runtimeContext = runtime.slice(contextStart, actorStart);
const runtimeSignup = runtime.slice(runtimeSignupStart, modeStart);
assert.match(runtimeContext, /hasOwnProperty\.call\(data, 'stationId'\)/,
  'runtime must reject camel-case station spoofing');
assert.match(runtimeContext, /hasOwnProperty\.call\(data, 'station_id'\)/,
  'runtime must reject snake-case station spoofing');
assert.match(runtimeContext, /const sid\s*=\s*String\(token\.stationId\s*\|\|\s*''\)\.trim\(\);/,
  'runtime must derive station only from the authenticated token');
assert.match(runtimeContext, /liveUserRef\(sid, uid\)\.get\(\)/,
  'runtime must verify the live station member');
assert.match(runtimeContext, /scheduleAccess\.activeMember\(user, sid\)/,
  'runtime must require an active station member');
assert.match(runtime, /function activeOperationalMember\(user, sid\)[\s\S]*MEMBER_ROLES\.indexOf/,
  'operational recipients and assignees must also hold a known member role');
assert.match(runtimeSignup, /const ctx\s*=\s*await context\(req\);/,
  'guard signup must enter the context gate before work');
assert.match(runtimeSignup, /guardRef\(ctx\.sid, guardId\)/,
  'guard signup must use only the server-derived station');
assert.match(runtimeSignup, /const allowed\s*=\s*\['id', 'join'\];/,
  'guard signup payload must be allowlisted after the context gate');

console.log('Station source checks passed');
