// Native Admin SDK query behavior only; this does not test callable authorization
// or prove production index readiness. Never clear the shared emulator.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):8191$/,
  'explicit loopback Firestore emulator on 8191 required');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq', 'explicit demo-resq project required');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT === 'demo-resq');
// The SDK otherwise probes Google metadata even with an emulator endpoint.
process.env.METADATA_SERVER_DETECTION = 'none';

// Import the SDK only after fail-closed target validation.
const { initializeApp, deleteApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const require = createRequire(import.meta.url);
const { scenarios, fixtures, verify } = require('../functions/hr-overhours-read-budget.test.js');
const run = randomBytes(8).toString('hex');
const app = initializeApp({ projectId: 'demo-resq' }, 'hr-overhours-query-' + run);
const db = getFirestore(app);
const owned = new Set();
let passed = 0;
async function batches(entries, remove = false) {
  for (let index = 0; index < entries.length; index += 400) {
    const batch = db.batch();
    for (const [path, value] of entries.slice(index, index + 400)) {
      assert.ok(path.startsWith('stations/it_hr_overhours_' + run + '_'), 'only this run owns this fixture');
      if (remove) batch.delete(db.doc(path));
      else { owned.add(path); batch.set(db.doc(path), value); }
    }
    await batch.commit();
  }
}
try {
  for (const [index, scenario] of scenarios().entries()) {
    const sid = 'it_hr_overhours_' + run + '_' + index;
    const otherRows = scenario.otherRows || [{ id: 'foreign', over_hour_limit: true,
      employee_number: 'foreign', full_name: 'Foreign fixture', crew: 'B', total_hours: 999 }];
    await batches([...fixtures(sid, scenario.rows), ...fixtures(sid + '_other', otherRows)]);
    const counts = await verify(db, scenario, sid);
    console.log('PASS native ' + scenario.name + ' ' + JSON.stringify(counts));
    passed++;
  }
  console.log('hr-overhours-query: ' + passed + '/6 PASS');
} finally {
  try {
    await batches([...owned].map(path => [path]), true);
    console.log('Cleaned exactly ' + owned.size + ' owned synthetic documents');
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
}
