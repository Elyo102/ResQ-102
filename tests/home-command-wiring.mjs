import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8').replace(/\r\n/g, '\n');

function one(regex, label) {
  const matches = [...index.matchAll(regex)];
  assert.equal(matches.length, 1, label + ' must occur exactly once');
  return matches[0][0];
}

const moduleImport = one(
  /^const homeCommandCenterModule = require\((['"])\.\/home-command-center\1\);$/gm,
  'home command service require'
);
const factory = one(
  /const homeCommandCenter = homeCommandCenterModule\.createHomeCommandCenter\(\{\s*db,\s*HttpsError,\s*clock:\(\) => Date\.now\(\)\s*\}\);/g,
  'home command service instantiation'
);
const dateStart = index.indexOf('function jerusalemDayKey(');
const exportStart = index.indexOf('exports.getHomeCommandCenter = onCall(', dateStart);
const nextExport = index.indexOf('\nexports.getScheduleRuntimeStatus', exportStart);
assert.ok(dateStart >= 0 && exportStart > dateStart && nextExport > exportStart,
  'home command projection/wrapper boundaries are missing');
const helpers = index.slice(dateStart, exportStart);
const registration = index.slice(exportStart, nextExport).trim();

assert.match(registration, /^exports\.getHomeCommandCenter = onCall\(\{/);
assert.match(registration, /\benforceAppCheck\s*:\s*true\b/);
assert.doesNotMatch(registration, /\benforceAppCheck\s*:\s*false\b/);
assert.match(registration, /await homeCommandCenter\.get\(req\)/,
  'wrapper must pass the original verified request to the service');

class HttpsError extends Error {}
const db = Object.freeze({ fixture:'db' });
const factoryCalls = [];
const serviceResult = Object.freeze({
  revision:'home-command-v1', generated_at:'2026-09-13T05:00:00.000Z',
  identity:Object.freeze({ role:'commander', employee_number:'5' }),
  urgent:null, tasks:Object.freeze([]),
  shift:Object.freeze({ open_faults:3, partial:false })
});
let serviceRequests = [];
const composition = vm.runInNewContext(
  [moduleImport, factory, '({ homeCommandCenterModule, homeCommandCenter })'].join('\n'),
  {
    db, HttpsError, Date,
    require(name) {
      assert.equal(name, './home-command-center');
      return {
        createHomeCommandCenter(deps) {
          factoryCalls.push(deps);
          return { get(req) { serviceRequests.push(req); return Promise.resolve(serviceResult); } };
        }
      };
    }
  },
  { filename:'actual-home-command-composition.js', timeout:1000 }
);

assert.equal(factoryCalls.length, 1, 'factory initialized more than once');
assert.equal(factoryCalls[0].db, db);
assert.equal(factoryCalls[0].HttpsError, HttpsError);
assert.equal(typeof factoryCalls[0].clock, 'function');

const registrations = [];
const scheduleCalls = [];
const exportsObject = {};
const context = {
  exports:exportsObject,
  homeCommandCenter:composition.homeCommandCenter,
  Date,
  console:{ warn() {} },
  onCall(options, handler) {
    registrations.push({ options, handler });
    return handler;
  },
  async invokeSchedule(method, req) {
    scheduleCalls.push({ method, req });
    return {
      days:[{ crew:'C', sub_stations:[
        { minimum:3, people:[{ uid:'u1' }, { uid:'u2' }] },
        { minimum:1, people:[{ uid:'u2' }, { uid:'u3' }] }
      ] }]
    };
  }
};
vm.runInNewContext(helpers + '\n' + registration, context,
  { filename:'actual-home-command-registration.js', timeout:1000 });

assert.equal(registrations.length, 1, 'callable registered more than once');
assert.deepEqual(JSON.parse(JSON.stringify(registrations[0].options)), {
  enforceAppCheck:true, timeoutSeconds:60, memory:'256MiB', maxInstances:10
});
assert.deepEqual(Object.keys(exportsObject), ['getHomeCommandCenter']);
assert.equal(typeof exportsObject.getHomeCommandCenter, 'function');

const auth = Object.freeze({
  uid:'verified-user',
  token:Object.freeze({ stationId:'station-token', role:'commander', shift:'C' })
});
const hostileBody = Object.freeze({
  stationId:'station-body', station_id:'station-body', role:'super_admin', super:true,
  from:'1900-01-01', to:'2999-12-31'
});
const request = Object.freeze({ auth, data:hostileBody });
const response = await exportsObject.getHomeCommandCenter(request);

assert.equal(serviceRequests.length, 1);
assert.equal(serviceRequests[0], request,
  'wrapper reconstructed the request instead of preserving verified callable context');
assert.equal(scheduleCalls.length, 1);
assert.equal(scheduleCalls[0].method, 'getStationRange');
assert.equal(scheduleCalls[0].req.auth, auth,
  'schedule projection did not preserve the verified auth object');
assert.deepEqual(Object.keys(scheduleCalls[0].req.data).sort(), ['from','to']);
assert.equal(scheduleCalls[0].req.data.from, scheduleCalls[0].req.data.to);
assert.match(scheduleCalls[0].req.data.from, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(JSON.stringify(scheduleCalls[0]).includes('station-body'), false,
  'body station reached the schedule projection');
assert.equal(JSON.stringify(scheduleCalls[0]).includes('super_admin'), false,
  'body role reached the schedule projection');
assert.equal(response.shift.open_faults, 3);
assert.equal(response.shift.partial, false);
assert.equal(response.shift.on_duty, 3, 'duplicate uid was counted twice');
assert.equal(response.shift.missing, 1);
assert.equal(response.shift.label, 'משמרת C');

// Focused mutation matrix: each mutation removes one load-bearing wiring guard.
function validateMutated(source) {
  assert.equal((source.match(/require\((['"])\.\/home-command-center\1\)/g) || []).length, 1);
  assert.equal((source.match(/\.createHomeCommandCenter\(/g) || []).length, 1);
  const at = source.indexOf('exports.getHomeCommandCenter = onCall(');
  assert.ok(at >= 0);
  const block = source.slice(at, source.indexOf('\nexports.', at + 1));
  assert.match(block, /\benforceAppCheck\s*:\s*true\b/);
  assert.match(block, /homeCommandCenter\.get\(req\)/);
  assert.doesNotMatch(block, /station(?:Id|_id)\s*:\s*req\.data/);
  assert.doesNotMatch(block, /role\s*:\s*req\.data/);
}

const mutations = [
  ['remove require', "const homeCommandCenterModule = require('./home-command-center');", ''],
  ['duplicate factory', factory, factory + '\n' + factory],
  ['disable App Check', registration, registration.replace('enforceAppCheck:true', 'enforceAppCheck:false')],
  ['bypass service request', 'homeCommandCenter.get(req)', 'homeCommandCenter.get({ auth:req.auth, data:{} })'],
  ['inject body station', 'data:{ from:date, to:date }', 'data:{ from:date, to:date, stationId:req.data.stationId }']
];
for (const [name, before, after] of mutations) {
  const changed = index.replace(before, after);
  assert.notEqual(changed, index, name + ' mutation did not apply');
  assert.throws(() => validateMutated(changed), name + ' mutation survived');
}
validateMutated(index);

console.log('home-command-wiring: PASS; 5/5 focused mutations caught');
