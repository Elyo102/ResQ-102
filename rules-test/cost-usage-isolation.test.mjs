import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer,
  limit, query, setDoc, updateDoc, writeBatch } from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):\d+$/, 'loopback emulator only');
assert.ok(!process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT === 'demo-resq');
const [host, portText] = endpoint.split(':');
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const run = randomBytes(6).toString('hex');
const collections = ['cost_usage_config', 'cost_usage_daily', 'cost_usage_station_daily', 'cost_usage_global_daily', 'cost_usage_lifetime',
  'cost_usage_batch_ledger', 'cost_usage_outbox'];
const paths = collections.map(name => name + '/fixture_' + run);
const env = await initializeTestEnvironment({ projectId: 'demo-resq',
  firestore: { host, port: Number(portText), rules } });
const actors = [
  { name: 'firefighter', uid: 'worker_' + run, claims: { role: 'firefighter', stationId: 'eilat_102' } },
  { name: 'hr', uid: 'hr_' + run, claims: { role: 'hr', stationId: 'eilat_102' } },
  { name: 'super', uid: 'super_' + run, claims: { super: true } },
  { name: 'anonymous', uid: null, claims: null }
];
let denials = 0;
async function denied(promise, label) {
  await assert.rejects(promise, error => error?.code === 'permission-denied', label);
  denials++;
}
try {
  await env.withSecurityRulesDisabled(async ctx => {
    const batch = writeBatch(ctx.firestore());
    for (const path of paths) batch.set(doc(ctx.firestore(), path), { marker: run });
    await batch.commit();
  });
  for (const actor of actors) {
    const db = actor.uid
      ? env.authenticatedContext(actor.uid, actor.claims).firestore()
      : env.unauthenticatedContext().firestore();
    for (const path of paths) {
      const name = path.split('/')[0];
      await denied(getDocFromServer(doc(db, path)), actor.name + ' get ' + name);
      await denied(getDocsFromServer(query(collection(db, name), limit(1))), actor.name + ' list ' + name);
      await denied(setDoc(doc(db, name + '/new_' + run), { marker: run }), actor.name + ' create ' + name);
      await denied(updateDoc(doc(db, path), { marker: 'changed' }), actor.name + ' update ' + name);
      await denied(deleteDoc(doc(db, path)), actor.name + ' delete ' + name);
    }
  }
  await env.withSecurityRulesDisabled(async ctx => {
    for (const path of paths) assert.deepEqual((await getDocFromServer(doc(ctx.firestore(), path))).data(), { marker: run });
  });
} finally {
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const batch = writeBatch(ctx.firestore());
      for (const path of paths) batch.delete(doc(ctx.firestore(), path));
      for (const name of collections) batch.delete(doc(ctx.firestore(), name + '/new_' + run));
      await batch.commit();
    });
  } finally { await env.cleanup(); }
}
assert.equal(denials, actors.length * paths.length * 5);
console.log('Cost usage isolation: ' + denials + ' permission denials; demo emulator only.');
