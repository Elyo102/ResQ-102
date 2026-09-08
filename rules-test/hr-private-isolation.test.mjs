// Real client SDK + actual Firestore rules. Only a loopback demo emulator is
// allowed. Synthetic fixtures are tracked and deleted exactly; never clear
// the shared emulator, runtime, another station or an entire collection.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, limit,
  query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):\d+$/, 'loopback emulator only');
assert.ok(!process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT === 'demo-resq', 'demo project only');
const [host, portText] = endpoint.split(':'), port = Number(portText);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
const rulesPath = fileURLToPath(new URL('../firestore.rules', import.meta.url));
const rules = readFileSync(rulesPath, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const before = hash(rules), run = randomBytes(6).toString('hex');
const sid = 'it_hr_private_' + run, otherSid = sid + '_other';
const roles = ['firefighter', 'deputy_team_leader', 'team_leader', 'deputy', 'commander', 'station_commander', 'hr_coordinator', 'district_commander'];
const roleSource = readFileSync(new URL('../roles.js', import.meta.url), 'utf8');
const canonicalRoles = await import('data:text/javascript;base64,' + Buffer.from(roleSource).toString('base64'));
assert.deepEqual([...roles].sort(), [...canonicalRoles.VALID_ROLES].sort(), 'every canonical role participates in the denial matrix');
const actors = roles.map((role, i) => ({ label: role, uid: run + '_u' + i, role, emp: String(8000 + i), stationId: sid,
  member: canonicalRoles.MEMBER_ROLES.includes(role) }));
actors.push({ label: 'signed-super-without-local-profile', uid: run + '_super', super: true, member: true },
  { label: 'role-only-super', uid: run + '_role', role: 'super_admin', emp: '8100', stationId: sid },
  { label: 'string-super', uid: run + '_string', role: 'firefighter', emp: '8101', stationId: sid, super: 'true', member: true },
  { label: 'other-station-HR', uid: run + '_other', role: 'hr_coordinator', emp: '8102', stationId: otherSid, member: true },
  { label: 'unauthenticated', uid: run + '_anon', unauthenticated: true });

function paths(uid) {
  const id = hash(uid), base = 'stations/' + sid;
  return [base + '/hr_requests/' + id, base + '/hr_requests/' + id + '/events/' + id,
    base + '/hr_request_operations/' + id, base + '/hr_documents/' + id,
    base + '/hr_documents/' + id + '/revisions/1', base + '/hr_documents/' + id + '/revisions/1/receipts/' + uid,
    base + '/hr_document_operations/' + id, base + '/hr_nudge_actions/' + id,
    base + '/hr_nudge_intents/' + id, base + '/hr_request_notification_jobs/' + id,
    base + '/hr_document_notification_jobs/' + id, base + '/hr_domain_notification_intents/' + id,
    'hr_nudge_bulk_locks/' + id, 'hr_nudge_actor_quotas/' + id,
    'hr_request_actor_quotas/' + id, 'hr_document_actor_quotas/' + id];
}
const knownPaths = new Set(), seeded = new Map();
function seed(path, value) { knownPaths.add(path); seeded.set(path, value); }
for (const stationId of [sid, otherSid]) {
  seed('stations/' + stationId, { name: 'Synthetic station', districtId: 'synthetic', active: true });
  seed('stations/' + stationId + '/vehicles/control', { name: 'Synthetic operational control', active: true });
}
for (const actor of actors) {
  if (actor.stationId) seed('stations/' + actor.stationId + '/users/' + actor.uid, {
    uid: actor.uid, role: actor.role, stationId: actor.stationId, employee_number: actor.emp,
    crew: 'A', active: true, is_active: true, full_name: 'Synthetic fixture' });
  assert.equal(paths(actor.uid).length, 16);
  for (const target of paths(actor.uid)) {
    seed(target, { uid: actor.uid, owner_uid: actor.uid, recipient_uid: actor.uid, target_uid: actor.uid,
      actor_uid: actor.uid, by_uid: actor.uid, station_id: sid, stationId: sid, status: 'open',
      revision: 1, current_revision: 1, text: 'Synthetic private fixture', marker: run });
    knownPaths.add(target + '_new'); // The distinct create target is absent at start.
  }
}
const env = await initializeTestEnvironment({ projectId: 'demo-resq', firestore: { host, port, rules } });
let passed = 0, denied = 0, cleanupComplete = false;
async function exactDenied(label, operation) {
  await assert.rejects(operation, error => error?.code === 'permission-denied', label + ' must fail specifically with permission-denied');
  ++denied;
}
try {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore(), entries = [...seeded];
    for (let offset = 0; offset < entries.length; offset += 400) {
      const batch = writeBatch(db);
      for (const [target, value] of entries.slice(offset, offset + 400)) batch.set(doc(db, target), value);
      await batch.commit();
    }
    for (const [target] of entries) assert.equal((await getDocFromServer(doc(db, target))).exists(), true, 'fixture exists: ' + target);
  });
  for (const actor of actors) {
    const claims = { email: 'fixture@example.invalid' };
    for (const key of ['role', 'emp', 'stationId', 'super']) if (Object.hasOwn(actor, key)) claims[key] = actor[key];
    if (actor.stationId) Object.assign(claims, { shift: 'A', districtId: 'synthetic' });
    const db = actor.unauthenticated ? env.unauthenticatedContext().firestore() : env.authenticatedContext(actor.uid, claims).firestore();
    if (actor.member) {
      const control = await getDocFromServer(doc(db, 'stations/' + (actor.stationId || sid) + '/vehicles/control'));
      assert.equal(control.exists(), true, actor.label + ' is a genuinely authorized operational reader'); ++passed;
    } else if (actor.role === 'district_commander') {
      const control = await getDocFromServer(doc(db, 'stations/' + sid));
      assert.equal(control.exists(), true, 'district actor has legitimate district station visibility'); ++passed;
    }
    for (const target of paths(actor.uid)) {
      const list = target.slice(0, target.lastIndexOf('/'));
      // Complete every started operation before propagating failure, so exact
      // cleanup cannot race an unexpected successful mutation.
      const checks = [
        ['get', () => getDocFromServer(doc(db, target))],
        ['list', () => getDocsFromServer(query(collection(db, list), limit(1)))],
        ['own-filtered-list', () => getDocsFromServer(query(collection(db, list), where('uid', '==', actor.uid), limit(1)))],
        ['create', () => setDoc(doc(db, target + '_new'), seeded.get(target))],
        ['update', () => updateDoc(doc(db, target), { marker: 'unexpected-browser-write' })],
        ['delete', () => deleteDoc(doc(db, target))]
      ];
      const results = await Promise.allSettled(checks.map(([kind, action]) => exactDenied(actor.label + ' ' + kind + ' ' + target, action)));
      const failure = results.find(value => value.status === 'rejected'); if (failure) throw failure.reason;
    }
    console.log('PASS ' + actor.label + ': all16 private paths deny get, list, own-filtered list, create, update and delete');
  }
  assert.equal(denied, actors.length * 16 * 6);
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [target, value] of seeded) assert.deepEqual((await getDocFromServer(doc(db, target))).data(), value, 'denials preserve data');
    for (const target of knownPaths) if (!seeded.has(target)) assert.equal((await getDocFromServer(doc(db, target))).exists(), false, 'denied creates remain absent');
  });
  console.log('PASS all seeded private data preserved and every denied create absent'); ++passed;
} finally {
  try {
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore(), targets = [...knownPaths];
      for (let offset = 0; offset < targets.length; offset += 400) {
        const batch = writeBatch(db); for (const target of targets.slice(offset, offset + 400)) batch.delete(doc(db, target));
        await batch.commit();
      }
      for (const target of targets) assert.equal((await getDocFromServer(doc(db, target))).exists(), false, 'exact cleanup: ' + target);
      cleanupComplete = true;
    });
  } finally { await env.cleanup(); }
  assert.equal(hash(readFileSync(rulesPath, 'utf8')), before, 'rules unchanged during run');
  console.log(JSON.stringify({ run, project: 'demo-resq', endpoint, rules_sha256: before,
    exact_fixture_paths: knownPaths.size, cleanup_complete: cleanupComplete, unrelated_data_untouched: true }));
}
console.log('HR private isolation: ' + denied + ' exact permission denials, ' + passed + ' positive/integrity controls passed; real emulator/client SDK, synthetic identities only.');
