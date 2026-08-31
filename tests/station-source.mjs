import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'functions', 'index.js'), 'utf8');

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
  'sendCallout',
  'closeCallout',
  'guardSignup',
  'assignGuard',
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

assert.equal((source.match(/stationId\s*\|\|\s*PUSH_STATION/g) || []).length, 0,
  'no user-triggered function may silently fall back to PUSH_STATION');

console.log('Station source checks passed');
