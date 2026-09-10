import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'functions/index.js'), 'utf8').replace(/\r\n/g, '\n');
function one(regex, label) {
  const matches = [...source.matchAll(regex)];
  assert.equal(matches.length, 1, label);
  return matches[0][0];
}
const imports = [
  ['attendanceCorrectionsModule', './attendance-corrections'],
  ['attendanceHoursCalculator', './attendance-hours-calculator'],
  ['attendanceCorrectionConfigModule', './attendance-correction-config'],
  ['attendanceCorrectionSupportModule', './attendance-correction-support']
].map(([variable, request]) => one(new RegExp('^const ' + variable + ' = require\\(([\'\"])'
  + request.replaceAll('.', '\\.') + '\\1\\);$', 'gm'), 'one real ' + variable + ' import'));
const options = one(/const ATTENDANCE_CORRECTION_OPTIONS = Object\.freeze\([\s\S]*?^\}\);/gm,
  'one bounded options declaration');
const month = one(/function jerusalemMonth\(milliseconds\) \{[\s\S]*?^\}/gm,
  'one server month function');
const registration = one(/let attendanceCorrections;[\s\S]*?exports\.correctAttendanceMonth = onCall\([\s\S]*?correctMonthRecalc\(req\)\);/g,
  'one correction registration block');
const supportRegistration = one(/function getAttendanceCorrectionSupport\(\) \{[\s\S]*?exports\.getAttendanceCorrectionAudit = onCall\([\s\S]*?getAudit\(req\)\);/g,
  'one correction support registration block');

class HttpsError extends Error {}
const db = Object.freeze({ id: 'db' });
const auth = Object.freeze({ id: 'auth' });
const configReader = Object.freeze({ id: 'tested-reader' });
const calculate = () => ({ hours: 24, day_type_he: 'רגיל', site_name: '', reason_required: false });
const result = Object.freeze({ id: 'result' });
const factories = [], registrations = [], calls = [];
const modules = {
  './attendance-correction-config': { createAttendanceCorrectionConfigReader(deps) {
    factories.push(['config', deps]); return configReader;
  } },
  './attendance-hours-calculator': { calculateAttendanceDerived: calculate },
  './attendance-corrections': { createAttendanceCorrections(deps) {
    factories.push(['service', deps]);
    return {
      correctOneDay(req) { calls.push(['day', req]); return Promise.resolve(result); },
      correctMonthRecalc(req) { calls.push(['month', req]); return Promise.resolve(result); }
    };
  } },
  './attendance-correction-support': { createAttendanceCorrectionSupport(deps) {
    factories.push(['support', deps]);
    return {
      getContext(req) { calls.push(['context', req]); return Promise.resolve(result); },
      reopen(req) { calls.push(['reopen', req]); return Promise.resolve(result); },
      listAudit(req) { calls.push(['list-audit', req]); return Promise.resolve(result); },
      getAudit(req) { calls.push(['get-audit', req]); return Promise.resolve(result); }
    };
  } }
};
const exported = {};
vm.runInNewContext([...imports, options, month, registration, supportRegistration].join('\n'), {
  db, HttpsError, admin: { auth: () => auth },
  FV: { serverTimestamp: () => Object.freeze({ id: 'timestamp' }) },
  exports: exported, Intl, Date, Object,
  require(name) { assert.ok(Object.hasOwn(modules, name), 'unexpected module ' + name); return modules[name]; },
  onCall(callOptions, handler) { registrations.push(callOptions); return handler; }
}, { filename: 'actual-attendance-correction-wiring.js', timeout: 1000 });

assert.equal(factories.filter(([name]) => name === 'config').length, 1);
assert.equal(factories.filter(([name]) => name === 'service').length, 0, 'service is lazy');
assert.deepEqual(Object.keys(factories[0][1]).sort(), ['HttpsError', 'db']);
const request = Object.freeze({ id: 'request' });
assert.equal(await exported.correctAttendanceDay(request), result);
assert.equal(await exported.correctAttendanceMonth(request), result);
assert.equal(await exported.getAttendanceCorrectionContext(request), result);
assert.equal(await exported.reopenAttendanceMonthForCorrection(request), result);
assert.equal(await exported.listAttendanceCorrectionAudit(request), result);
assert.equal(await exported.getAttendanceCorrectionAudit(request), result);
assert.deepEqual(calls, [['day', request], ['month', request], ['context', request], ['reopen', request],
  ['list-audit', request], ['get-audit', request]]);
assert.equal(factories.filter(([name]) => name === 'service').length, 1);
assert.equal(factories.filter(([name]) => name === 'support').length, 1);
const deps = factories.find(([name]) => name === 'service')[1];
assert.equal(deps.db, db); assert.equal(deps.auth, auth); assert.equal(deps.HttpsError, HttpsError);
assert.equal(deps.readConfig, configReader); assert.equal(deps.calculate, calculate);
assert.equal(typeof deps.monthAt, 'function'); assert.equal(typeof deps.serverTimestamp, 'function');
const supportDeps = factories.find(([name]) => name === 'support')[1];
assert.equal(supportDeps.db, db); assert.equal(supportDeps.auth, auth); assert.equal(supportDeps.HttpsError, HttpsError);
assert.equal(typeof supportDeps.monthAt, 'function'); assert.equal(typeof supportDeps.serverTimestamp, 'function');
assert.deepEqual(Object.keys(exported).sort(), ['correctAttendanceDay', 'correctAttendanceMonth',
  'getAttendanceCorrectionAudit', 'getAttendanceCorrectionContext', 'listAttendanceCorrectionAudit',
  'reopenAttendanceMonthForCorrection'].sort());
assert.equal(registrations.length, 6);
for (const callOptions of registrations) assert.deepEqual(JSON.parse(JSON.stringify(callOptions)), {
  region: 'europe-west1', enforceAppCheck: true, timeoutSeconds: 60,
  memory: '256MiB', maxInstances: 3, concurrency: 1
});

console.log('Attendance correction wiring: 12/12 passed; core and support services use bounded callables.');
