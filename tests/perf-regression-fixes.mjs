// Regression: schedule refresh must not double-call getMyScheduleV2 via
// Promise.all([loadMine(), loadMineRange(), ...]). loadMineRange already
// invokes loadMine. Also: faults photo inflight coalesce + monitored-functions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schedule = fs.readFileSync(path.join(root, 'schedule-management.js'), 'utf8');
const faults = fs.readFileSync(path.join(root, 'faults.html'), 'utf8');

const bad = /Promise\.all\(\s*\[\s*loadMine\s*\(\s*\)\s*,\s*loadMineRange\s*\(/g;
const badHits = schedule.match(bad) || [];
assert.equal(badHits.length, 0,
  'schedule must not Promise.all(loadMine, loadMineRange) — duplicate getMyScheduleV2');

const good = /Promise\.all\(\s*\[\s*loadMineRange\s*\(\s*\)\s*,\s*loadStationRange\s*\(/g;
const goodHits = schedule.match(good) || [];
assert.ok(goodHits.length >= 3,
  'expected >=3 refresh sites using [loadMineRange, loadStationRange], found ' + goodHits.length);

// loadMineRange still calls loadMine internally (behavior preserved)
assert.ok(/minePromise\s*\|\|\s*loadMine\s*\(\s*generation\s*\)/.test(schedule) ||
  /if \(await loadMine\s*\(/.test(schedule),
  'loadMineRange must still call loadMine for non-displayOnly');

assert.ok(faults.includes("from './monitored-functions.js?v=42h39'"),
  'faults.html must route httpsCallable through monitored-functions');
assert.ok(!/from "https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+\/firebase-functions\.js"/.test(faults),
  'faults.html must not import raw gstatic firebase-functions');
assert.ok(faults.includes('shotsInflight'),
  'faults.html must coalesce concurrent photo getDocs via shotsInflight');
assert.ok(faults.includes('createPhotoQueue'),
  'photo queue must remain');
assert.ok(/createFaultReport/.test(faults),
  'createFaultReport atomic path must remain');

// watchCallouts must remain on callout + home
const callout = fs.readFileSync(path.join(root, 'callout.html'), 'utf8');
const login = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
assert.ok(callout.includes('watchCallouts'), 'do not remove watchCallouts from callout');
assert.ok(login.includes('watchCallouts'), 'do not remove watchCallouts from home');

console.log('PASS perf-regression-fixes', {
  scheduleRefreshSites: goodHits.length,
  faultsMonitored: true,
  shotsInflight: true
});
const attendance = fs.readFileSync(path.join(root, 'attendance.html'), 'utf8');
assert.ok(attendance.includes('staticStationCache'),
  'attendance must cache station swaps/sites across months');
assert.ok(attendance.includes('staticBoardCache'),
  'attendance must cache board/shift mySite across months');
assert.ok(attendance.includes('clearAttendanceStaticCache'),
  'attendance must clear static cache on auth/pagehide');
assert.ok(/pagehide[\s\S]*clearAttendanceStaticCache/.test(attendance),
  'pagehide must clear static cache (preserve dispose lifecycle)');
assert.ok(attendance.includes('stationHit'),
  'loadStatic must skip swaps/sites on station cache hit');
assert.ok(attendance.includes('getDocFromServer') && attendance.includes('getDocsFromServer'),
  'attendance write path must bypass offline Firestore cache');
assert.ok(attendance.includes('if (!(await ensureFreshAttendanceForWrite())) return;'),
  'automatic fill and edit must stop on failed server refresh');
assert.ok(faults.includes('shotsInflight[key] === request'),
  'an old photo request must not delete a new in-flight request');
assert.ok(schedule.includes("const sourceMayBeImported = state.status && state.status.mode === 'off'"),
  'OFF mode must defer the daily callable until imported-display is known');
// Must still always refresh month-scoped effective workdays
assert.ok(attendance.includes('callEffectiveWorkdays'),
  'month-scoped effective workdays callable must remain');
console.log('PASS hours-static-cache-regression');
