import assert from 'node:assert/strict';
import { previousHrMonth } from '../hr-hours-ui.js';

const cases = [
  ['2026-09-30T20:59:59Z', '2026-08'],
  ['2026-09-30T21:00:00Z', '2026-09'],
  ['2026-10-01T09:00:00Z', '2026-09'],
  ['2026-12-31T21:59:59Z', '2026-11'],
  ['2026-12-31T22:00:00Z', '2026-12'],
  ['2028-02-29T22:00:00Z', '2028-02']
];
for (const deviceZone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
  process.env.TZ = deviceZone;
  for (const [instant, expected] of cases) {
    assert.equal(previousHrMonth(new Date(instant)), expected, `${deviceZone}: ${instant}`);
  }
}
console.log('18 Jerusalem previous-month boundary checks passed. No server or production access.');
