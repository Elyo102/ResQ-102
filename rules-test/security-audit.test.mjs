// Synthetic emulator-only proof. This does not test Admin SDK immutability.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '';
assert.match(endpoint, /^127\.0\.0\.1:(8080|8191|8199)$/, 'explicit owned loopback emulator required');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT === 'demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION = 'none';
const { initializeTestEnvironment } = await import('@firebase/rules-unit-testing');
const { doc, collection, getDocFromServer, getDocs, setDoc, updateDoc, deleteDoc } = await import('firebase/firestore');
const suffix = randomBytes(8).toString('hex');
const sid = 'audit_fixture_' + suffix;
const roles = ['member', 'hr', 'super'];
const uids = Object.fromEntries(roles.map(role => [role, 'audit_' + role + '_' + suffix]));
const existingPath = 'security_audit_events/existing_' + suffix;
const controlPath = 'admin_audit/control_' + suffix;
const creates = ['anonymous', ...roles].map(role => 'security_audit_events/new_' + role + '_' + suffix);
const original = { schema: 1, operation_id: 'synthetic_' + suffix, target_uid: uids.member, actor_uid: uids.super };
const owned = [existingPath, controlPath, ...creates,
  ...roles.map(role => 'registration_terms_active/' + uids[role]),
  ...['member', 'hr'].map(role => 'stations/' + sid + '/users/' + uids[role])];
const environment = await initializeTestEnvironment({ projectId: 'demo-resq', firestore: {
  host: '127.0.0.1', port: Number(endpoint.split(':')[1]),
  rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
} });
let fixtureOwned = false;
try {
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const path of owned) assert.equal((await getDocFromServer(doc(db, path))).exists(), false, path);
    fixtureOwned = true;
    await setDoc(doc(db, existingPath), original);
    await setDoc(doc(db, controlPath), { fixture: suffix });
    for (const role of roles) {
      const uid = uids[role];
      await setDoc(doc(db, 'registration_terms_active/' + uid), { uid,
        consent_key: '1.3|2026-09-24', terms_version: '1.3', privacy_version: '2026-09-24',
        receipt_path: 'registration_consents/' + uid + '/events/fixture' });
    }
    for (const role of ['member', 'hr']) await setDoc(doc(db, 'stations/' + sid + '/users/' + uids[role]), {
      role: role === 'hr' ? 'hr_coordinator' : 'firefighter', stationId: sid, active: true, is_active: true
    });
  });
  const clients = [environment.unauthenticatedContext().firestore(),
    environment.authenticatedContext(uids.member, { role: 'firefighter', stationId: sid, emp: '1001' }).firestore(),
    environment.authenticatedContext(uids.hr, { role: 'hr_coordinator', stationId: sid, emp: '1002' }).firestore(),
    environment.authenticatedContext(uids.super, { super: true }).firestore()];
  assert.equal((await getDocFromServer(doc(clients[3], controlPath))).data().fixture, suffix,
    'positive control proves the super context satisfies current Terms');
  let denied = 0;
  for (const [index, db] of clients.entries()) {
    for (const operation of [
      () => getDocFromServer(doc(db, existingPath)),
      () => getDocs(collection(db, 'security_audit_events')),
      () => setDoc(doc(db, creates[index]), original),
      () => updateDoc(doc(db, existingPath), { actor_uid: 'forged' }),
      () => deleteDoc(doc(db, existingPath))
    ]) {
      await assert.rejects(operation(), error => error?.code === 'permission-denied');
      denied++;
    }
  }
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    assert.deepEqual((await getDocFromServer(doc(db, existingPath))).data(), original);
    for (const path of creates) assert.equal((await getDocFromServer(doc(db, path))).exists(), false);
  });
  assert.equal(denied, 20);
  console.log('security audit: 20 client denials PASS; valid-super control and unchanged server evidence PASS');
} finally {
  try {
    if (fixtureOwned) await environment.withSecurityRulesDisabled(async context => {
      for (const path of owned) await deleteDoc(doc(context.firestore(), path));
    });
  } finally { await environment.cleanup(); }
}
