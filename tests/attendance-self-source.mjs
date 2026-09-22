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
assert.match(client, /httpsCallable\(fns, 'mutateMyAttendanceDay'\)/);
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

console.log('Attendance self-write source: day save/delete use the trusted idempotent server boundary.');
