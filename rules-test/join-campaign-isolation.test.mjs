// קליטה בקישור קבוצתי — בידוד Firestore מול אמולטור אמיתי (demo-resq).
// שני דיירים (תחנות), כל התפקידים הקנוניים, מנהל-על חתום, hr של תחנה
// אחרת ומשתמש אנונימי: אף אחד לא קורא/כותב ישירות קמפיין, נרשם, אינדקס
// נרשם, מונה בדיקות או מוכנות מכשיר — גם לא הבעלים של הרשומה. בנוסף:
// בעלים אינו יכול לזייף provenance (onboarding_operations / assignment
// links סגורים) או להעלות את עצמו בתפקיד דרך registration_requests.
// Real client SDK + actual rules. Fixtures are tracked and deleted exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, limit,
  query, setDoc, updateDoc, where, writeBatch, serverTimestamp } from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):\d+$/, 'loopback emulator only');
assert.ok(!process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT === 'demo-resq', 'demo project only');
const [host, portText] = endpoint.split(':'), port = Number(portText);
const rules = readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const run = randomBytes(6).toString('hex');
const sid = 'it_join_' + run, otherSid = sid + '_other';
const campaignId = 'C' + run.slice(0, 15).padEnd(15, 'x');
const roleSource = readFileSync(new URL('../roles.js', import.meta.url), 'utf8');
const canonicalRoles = await import('data:text/javascript;base64,' + Buffer.from(roleSource).toString('base64'));
const roles = [...canonicalRoles.VALID_ROLES];
const actors = roles.map((role, i) => ({ label: role, uid: run + '_u' + i, role, emp: String(9000 + i), stationId: sid,
  member: canonicalRoles.MEMBER_ROLES.includes(role) }));
actors.push({ label: 'signed-super', uid: run + '_super', super: true, member: true },
  { label: 'other-station-HR', uid: run + '_hrother', role: 'hr_coordinator', emp: '9102', stationId: otherSid, member: true },
  { label: 'pending-registrant-owner', uid: run + '_pend' },
  { label: 'unauthenticated', uid: run + '_anon', unauthenticated: true });

function privatePaths(uid) {
  return ['join_campaigns/' + campaignId, 'join_campaigns/' + campaignId + '/registrants/' + uid,
    'join_registrant_index/' + uid, 'join_campaign_inspect_quota/' + campaignId + '_1',
    'stations/' + sid + '/device_readiness/' + uid, 'stations/' + sid + '/onboarding_operations/req_' + hash(uid).slice(0, 20),
    'onboarding_assignment_links/' + uid, 'invitations/inv_' + hash(uid).slice(0, 20)];
}
const knownPaths = new Set(), seeded = new Map();
function seed(path, value) { knownPaths.add(path); seeded.set(path, value); }
for (const stationId of [sid, otherSid]) seed('stations/' + stationId, { name: 'Synthetic station', districtId: 'synthetic', active: true });
seed('join_campaigns/' + campaignId, { schema: 'join-campaign-v1', campaign_id: campaignId, token_hash: hash('synthetic'), station_id: sid,
  district_id: 'synthetic', created_by: run + '_super', created_by_role: 'super', default_role: 'firefighter', allowed_shifts: ['A'],
  max_registrations: 5, accepted_count: 1, status: 'active', expires_at_ms: Date.now() + 86400000, label: 'synthetic', revision: 1 });
seed('join_campaign_inspect_quota/' + campaignId + '_1', { count: 1 });
for (const actor of actors) {
  if (actor.stationId) seed('stations/' + actor.stationId + '/users/' + actor.uid, { uid: actor.uid, role: actor.role, stationId: actor.stationId,
    employee_number: actor.emp, crew: 'A', active: true, is_active: true, full_name: 'Synthetic fixture' });
  for (const target of privatePaths(actor.uid)) {
    if (seeded.has(target)) continue;
    seed(target, { uid: actor.uid, campaign_id: campaignId, station_id: sid, status: 'pending', revision: 1, schema: 'join-registrant-v1',
      schema_version: 1, request_id: 'req_' + hash(actor.uid).slice(0, 20), invite_id: 'inv_' + hash(actor.uid).slice(0, 20),
      provenance: { kind: 'join_campaign', campaign_id: campaignId }, marker: run });
    knownPaths.add(target + '_new');
  }
}
const pendingUid = run + '_pend';
knownPaths.add('registration_requests/' + pendingUid);

const env = await initializeTestEnvironment({ projectId: 'demo-resq', firestore: { host, port, rules } });
let passed = 0, denied = 0;
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
  });
  for (const actor of actors) {
    const claims = { email: actor.uid + '@example.invalid', email_verified: true };
    for (const key of ['role', 'emp', 'stationId', 'super']) if (Object.hasOwn(actor, key)) claims[key] = actor[key];
    if (actor.stationId) Object.assign(claims, { shift: 'A', districtId: 'synthetic' });
    const db = actor.unauthenticated ? env.unauthenticatedContext().firestore() : env.authenticatedContext(actor.uid, claims).firestore();
    for (const target of privatePaths(actor.uid)) {
      const list = target.slice(0, target.lastIndexOf('/'));
      const checks = [
        ['get', () => getDocFromServer(doc(db, target))],
        ['list', () => getDocsFromServer(query(collection(db, list), limit(1)))],
        ['own-filtered-list', () => getDocsFromServer(query(collection(db, list), where('uid', '==', actor.uid), limit(1)))],
        ['create', () => setDoc(doc(db, target + '_new'), seeded.get(target) || { uid: actor.uid })],
        ['update', () => updateDoc(doc(db, target), { status: 'revoked', accepted_count: 0, marker: 'browser-write' })],
        ['delete', () => deleteDoc(doc(db, target))]
      ];
      const results = await Promise.allSettled(checks.map(([kind, action]) => exactDenied(actor.label + ' ' + kind + ' ' + target, action)));
      const failure = results.find(value => value.status === 'rejected'); if (failure) throw failure.reason;
    }
    console.log('PASS ' + actor.label + ': campaign, registrant, index, quota, readiness, operation, registry and invitation deny get/list/create/update/delete');
    ++passed;
  }
  assert.equal(denied, actors.length * 8 * 6);

  // בעלים ממתין: יכול ליצור בקשת רישום legacy תקינה — אבל לא עם role,
  // לא עם provenance/campaign_id, ולא עם status אחר מ-pending.
  const pending = env.authenticatedContext(pendingUid, { email: pendingUid + '@example.invalid', email_verified: true }).firestore();
  const base = { request_id: 'req_' + hash(pendingUid).slice(0, 20), full_name: 'Synthetic fixture', email: pendingUid + '@example.invalid',
    phone: '0500000000', districtId: 'synthetic', stationId: sid, shift: 'A', status: 'pending', created_at: serverTimestamp() };
  await exactDenied('self-promotion via role', setDoc(doc(pending, 'registration_requests/' + pendingUid), { ...base, role: 'commander' }));
  await exactDenied('forged campaign provenance on the request', setDoc(doc(pending, 'registration_requests/' + pendingUid), { ...base, campaign_id: campaignId }));
  await exactDenied('forged provenance object on the request', setDoc(doc(pending, 'registration_requests/' + pendingUid), { ...base, provenance: { kind: 'join_campaign' } }));
  await exactDenied('pre-approved status', setDoc(doc(pending, 'registration_requests/' + pendingUid), { ...base, status: 'approved' }));
  await setDoc(doc(pending, 'registration_requests/' + pendingUid), base);
  console.log('PASS pending owner: legacy request allowed only with the exact key set; role/provenance/status forgeries denied'); ++passed;

  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [target, value] of seeded) assert.deepEqual((await getDocFromServer(doc(db, target))).data(), value, 'denials preserve data: ' + target);
    for (const target of knownPaths) if (!seeded.has(target) && target !== 'registration_requests/' + pendingUid) {
      assert.equal((await getDocFromServer(doc(db, target))).exists(), false, 'denied creates remain absent: ' + target);
    }
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
    });
  } finally { await env.cleanup(); }
}
console.log('Join campaign isolation: ' + passed + ' PASS, ' + denied + ' exact permission-denied results across ' + actors.length + ' actors and two tenants.');
