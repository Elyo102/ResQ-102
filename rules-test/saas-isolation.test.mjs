// שכבת SaaS — בידוד Firestore מול אמולטור אמיתי (demo-resq).
//
// NOT RUN בסביבה הזו: אין אמולטור Firestore ואין @firebase/rules-unit-testing
// זמינים במיכל. הקובץ נכתב בדפוס join-campaign-isolation.test.mjs ומיועד
// להרצה דרך:
//   firebase emulators:exec --only firestore --project demo-resq "cd rules-test && node saas-isolation.test.mjs"
// אחרי הדבקת בלוקי ה-Rules מ-SAAS-WIRING.md אל firestore.rules.
//
// שני ארגונים × שתי תחנות, כל התפקידים הקנוניים, מנהל-על חתום, hr של
// תחנה זרה ומשתמש אנונימי: אף אחד — גם לא מנהל-על — לא קורא/כותב ישירות
// ארגון, מנוי, שימוש, ביקורת, אינדקס תחנה→ארגון או רשומת פעולה. הכול
// עובר רק דרך Callables (App Check + claims חיים בשרת).
// Real client SDK + actual rules. Fixtures are tracked and deleted exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, limit,
  query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):\d+$/, 'loopback emulator only');
assert.ok(!process.env.GCLOUD_PROJECT || process.env.GCLOUD_PROJECT === 'demo-resq', 'demo project only');
const [host, portText] = endpoint.split(':'), port = Number(portText);
const rules = readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8');
assert.ok(/match \/organizations\/\{organizationId\}/.test(rules), 'firestore.rules must contain the SaaS blocks from SAAS-WIRING.md');
const run = randomBytes(6).toString('hex');
const stationA = 'it_saas_a_' + run, stationB = 'it_saas_b_' + run;
const orgA = 'org_a_' + run, orgB = 'org_b_' + run;
const period = '2027-01';
const roleSource = readFileSync(new URL('../roles.js', import.meta.url), 'utf8');
const canonicalRoles = await import('data:text/javascript;base64,' + Buffer.from(roleSource).toString('base64'));
const roles = [...canonicalRoles.VALID_ROLES];
const actors = roles.map((role, i) => ({ label: role + '@A', uid: run + '_u' + i, role, emp: String(9000 + i), stationId: stationA }));
actors.push({ label: 'signed-super', uid: run + '_super', super: true },
  { label: 'other-station-HR@B', uid: run + '_hrb', role: 'hr_coordinator', emp: '9102', stationId: stationB },
  { label: 'unauthenticated', uid: run + '_anon', unauthenticated: true });

/* כל המסמכים הפרטיים של שני הארגונים — בדיוק הנתיבים שה-Rules סוגרים. */
function privatePaths() {
  const out = [];
  for (const [oid, sid] of [[orgA, stationA], [orgB, stationB]]) {
    out.push('organizations/' + oid, 'organizations/' + oid + '/subscriptions/sub_' + run, 'organizations/' + oid + '/usage/' + period,
      'organizations/' + oid + '/audit/ev_' + run, 'organization_station_index/' + sid, 'saas_operations/' + oid + '_req_' + run.padEnd(16, '0'));
  }
  return out;
}
const knownPaths = new Set(), seeded = new Map();
function seed(path, value) { knownPaths.add(path); seeded.set(path, value); }
for (const sid of [stationA, stationB]) seed('stations/' + sid, { name: 'Synthetic station', districtId: 'synthetic', active: true });
for (const [oid, sid] of [[orgA, stationA], [orgB, stationB]]) {
  seed('organizations/' + oid, { schema: 'saas-organization-v1', organization_id: oid, name: 'Synthetic organization', district_id: 'synthetic', station_ids: [sid], current_subscription_id: 'sub_' + run, created_by: run + '_super', revision: 1, created_at_ms: 1, updated_at_ms: 1 });
  seed('organizations/' + oid + '/subscriptions/sub_' + run, { schema: 'saas-subscription-v1', subscription_id: 'sub_' + run, organization_id: oid, plan_id: 'station', status: 'active', provider_customer_id: null, provider_subscription_id: null, revision: 1, created_at_ms: 1, updated_at_ms: 1 });
  seed('organizations/' + oid + '/usage/' + period, { schema: 'saas-usage-v1', organization_id: oid, period, stations: 1, active_users: 1, storage_mb: 1, pushes_per_month: 1, revision: 1, updated_at_ms: 1 });
  seed('organizations/' + oid + '/audit/ev_' + run, { schema: 'saas-audit-v1', event_id: 'ev_' + run, organization_id: oid, action: 'create_organization', actor_uid: run + '_super', request_id: null, details: {}, at_ms: 1 });
  seed('organization_station_index/' + sid, { schema: 'saas-station-index-v1', station_id: sid, organization_id: oid, created_at_ms: 1 });
  seed('saas_operations/' + oid + '_req_' + run.padEnd(16, '0'), { schema: 'saas-operation-v1', organization_id: oid, request_id: 'req_' + run.padEnd(16, '0'), intent_fingerprint: 'f'.repeat(64), action: 'create_organization', receipt: { ok: true }, created_at_ms: 1 });
}
for (const actor of actors) {
  if (actor.stationId) seed('stations/' + actor.stationId + '/users/' + actor.uid, { uid: actor.uid, role: actor.role, stationId: actor.stationId,
    employee_number: actor.emp, crew: 'A', active: true, is_active: true, full_name: 'Synthetic fixture' });
}
for (const target of privatePaths()) knownPaths.add(target + '_new');

const env = await initializeTestEnvironment({ projectId: 'demo-resq', firestore: { host, port, rules } });
let passed = 0, denied = 0;
async function exactDenied(label, operation) {
  await assert.rejects(operation, (error) => error?.code === 'permission-denied', label + ' must fail specifically with permission-denied');
  ++denied;
}
try {
  await env.withSecurityRulesDisabled(async (context) => {
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
    for (const target of privatePaths()) {
      const list = target.slice(0, target.lastIndexOf('/'));
      const checks = [
        ['get', () => getDocFromServer(doc(db, target))],
        ['list', () => getDocsFromServer(query(collection(db, list), limit(1)))],
        ['station-filtered-list', () => getDocsFromServer(query(collection(db, list), where('station_id', '==', actor.stationId || stationA), limit(1)))],
        ['create', () => setDoc(doc(db, target + '_new'), seeded.get(target) || { organization_id: orgA })],
        ['update', () => updateDoc(doc(db, target), { status: 'active', plan_id: 'enterprise', station_ids: [stationA, stationB], marker: 'browser-write' })],
        ['delete', () => deleteDoc(doc(db, target))]
      ];
      const results = await Promise.allSettled(checks.map(([kind, action]) => exactDenied(actor.label + ' ' + kind + ' ' + target, action)));
      const failure = results.find((value) => value.status === 'rejected'); if (failure) throw failure.reason;
    }
    console.log('PASS ' + actor.label + ': organization, subscription, usage, audit, station index and operation record deny get/list/create/update/delete for both organizations');
    ++passed;
  }
  assert.equal(denied, actors.length * privatePaths().length * 6);

  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const [target, value] of seeded) assert.deepEqual((await getDocFromServer(doc(db, target))).data(), value, 'denials preserve data: ' + target);
    for (const target of knownPaths) if (!seeded.has(target)) assert.equal((await getDocFromServer(doc(db, target))).exists(), false, 'denied creates remain absent: ' + target);
  });
  console.log('PASS all seeded organization data preserved and every denied create absent'); ++passed;
} finally {
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore(), targets = [...knownPaths];
      for (let offset = 0; offset < targets.length; offset += 400) {
        const batch = writeBatch(db); for (const target of targets.slice(offset, offset + 400)) batch.delete(doc(db, target));
        await batch.commit();
      }
      for (const target of targets) assert.equal((await getDocFromServer(doc(db, target))).exists(), false, 'exact cleanup: ' + target);
    });
  } finally { await env.cleanup(); }
}
console.log('SaaS isolation: ' + passed + ' PASS, ' + denied + ' exact permission-denied results across ' + actors.length + ' actors, two organizations and two stations.');
