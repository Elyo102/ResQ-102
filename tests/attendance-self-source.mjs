import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEol } from './eol-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => normalizeEol(fs.readFileSync(path.join(root, file), 'utf8'));
const client = read('attendance.html');
const service = read('functions/attendance-self-service.js');
const index = read('functions/index.js');

function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'missing source section: ' + start);
  return source.slice(from, to);
}

assert.match(index, /exports\.mutateMyAttendanceDay = onCall\(ATTENDANCE_CORRECTION_OPTIONS/);
assert.match(index, /exports\.getMyAttendanceMonth = onCall\(ATTENDANCE_CORRECTION_OPTIONS/);
assert.match(index, /exports\.mutateMyAttendanceMonth = onCall\(ATTENDANCE_CORRECTION_OPTIONS/);
assert.match(client, /httpsCallable\(fns, 'mutateMyAttendanceDay'\)/);
assert.match(client, /httpsCallable\(fns, 'getMyAttendanceMonth'\)/);
assert.match(client, /httpsCallable\(fns, 'mutateMyAttendanceMonth'\)/);
const save = section(client, 'async function saveRecord(', 'async function createMissingDays(');
assert.match(save, /callMutateMyAttendanceDay/);
assert.doesNotMatch(save, /\b(?:setDoc|deleteDoc|serverTimestamp)\b/,
  'ordinary save/delete must not write attendance directly from the browser');
assert.match(service, /identity\.requireLive\(tx, r\.ctx\)/);
assert.match(service, /readConfig\(tx, \{ stationId: r\.ctx\.sid, targetRole: person\.role/);
assert.match(service, /calculate\(structuredClone\(record\), structuredClone\(config\)\)/);
assert.match(service, /expected_version/);
assert.match(service, /attendance-self-receipt-v1/);
assert.doesNotMatch(service, /req\.data\.(?:station|station_id|uid|employee_number|hours|full_name|crew)/,
  'identity and derived values must never come from the browser request');
assert.match(service, /async function readMonth\(req\)/);
assert.match(service, /where\('emp_number', '==', person\.employee_number\)[\s\S]*where\('month', '==', month\)\.limit\(32\)/);
assert.match(service, /expected_version: snapVersion\(s\)/);
const ownLoad = section(client, "\]) : await Promise.all([", '  ]);');
assert.match(ownLoad, /callGetMyAttendanceMonth/);
assert.doesNotMatch(ownLoad, /getDocs\(|getDoc\(/,
  'the employee month must receive server-issued optimistic versions');
const fill = section(client, 'async function createMissingDays(', 'async function refreshAfterCreation(');
const recalc = section(client, "$ ('btnRecalc').onclick".replace(' ', ''), '// ---------- חלונית עריכה ----------');
const report = section(client, 'async function writeReport(', '// לפני שליחה');
assert.match(fill, /operation: 'fill'/); assert.doesNotMatch(fill, /runTransaction|\bsetDoc\b|\bwriteBatch\b/);
assert.match(recalc, /operation: 'recalculate'/); assert.doesNotMatch(recalc, /\bsetDoc\b|\bwriteBatch\b/);
assert.match(report, /callMutateMyAttendanceMonth/); assert.doesNotMatch(report, /\bsetDoc\b|serverTimestamp/);
assert.match(service, /async function mutateMonth\(req\)/);
assert.match(service, /\['fill', 'recalculate', 'submit', 'unsubmit'\]/);

console.log('Attendance self-write source: every employee month/day read and write uses the trusted server boundary.');
