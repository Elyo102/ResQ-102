import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const client = read('attendance.html');
const service = read('functions/attendance-correction-support.js');
const rules = read('firestore.rules');

function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, 'missing source section: ' + start);
  return source.slice(from, to);
}

const approveClient = section(client, 'async function approveMonth(', 'async function reopenMonth(');
assert.match(client, /httpsCallable\(fns, 'approveAttendanceMonth'\)/);
assert.match(approveClient, /callApproveAttendanceMonth\(\{/);
assert.doesNotMatch(approveClient, /\b(?:setDoc|writeBatch|batch\.set|serverTimestamp)\b/,
  'month approval must not be split into browser writes');
assert.match(approveClient, /pendingMonthApprovals/);
assert.match(service, /approvedRows\.forEach\([^\n]+tx\.set\(row\.snap\.ref, value\)\);\n\s+tx\.set\(m\.report\.ref, approvedReport\);/,
  'rows and report must be queued in the same transaction callback');
assert.match(service, /report\.status !== 'submitted'/);
assert.match(service, /approvalScope\(r, finalActor, finalPerson\)/);

const attendanceRules = section(rules, 'match /attendance/{docId}', '// ---------- מזהי מכשיר להתראות');
const reportRules = section(rules, 'match /monthly_reports/{docId}', '// Durable multi-station watchdog');
assert.doesNotMatch(attendanceRules, /request\.resource\.data\.get\('status', ''\) == 'approved'/,
  'browser Rules must not approve attendance rows');
assert.doesNotMatch(reportRules, /request\.resource\.data\.get\('status', ''\) == 'approved'/,
  'browser Rules must not approve the monthly report');

console.log('Attendance approval source: atomic callable only; direct browser approval is closed.');
