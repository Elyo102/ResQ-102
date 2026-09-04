/**
 * Adversarial browser-boundary tests for the current schedule-access model.
 *
 * The only schedule-management authority is server-side:
 *   stations/{sid}/schedule_access/{uid}
 * and even its holder must use Callable functions.  These tests deliberately
 * use a real active appointment together with HR and super identities to
 * prove that no browser SDK route bypasses the callable boundary.
 */

import {
  initializeTestEnvironment,
  assertFails
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection
} from 'firebase/firestore';

const SID = 'eilat_102';
let passed = 0;

async function blocked(label, action) {
  try {
    await assertFails(action);
    passed += 1;
    console.log('✓ ' + label);
  } catch (error) {
    throw new Error('Browser bypass opened: ' + label + '\n' + (error && error.message || error));
  }
}

const env = await initializeTestEnvironment({
  projectId: 'resq-schedule-access-isolation',
  firestore: {
    rules: readFileSync('../firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080
  }
});

const client = (uid, email, claims) =>
  env.authenticatedContext(uid, Object.assign({ email }, claims)).firestore();

const manager = client('manager_1', 'manager@example.test', {
  emp: '9001', role: 'firefighter', stationId: SID, shift: 'א'
});
const hr = client('hr_1', 'hr@example.test', {
  emp: '9002', role: 'hr_coordinator', stationId: SID, shift: ''
});
const superUser = client('super_1', 'super@example.test', { super: true });

await env.withSecurityRulesDisabled(async (context) => {
  const db = context.firestore();
  await setDoc(doc(db, `stations/${SID}/schedule_access/manager_1`), {
    schema_version: 1,
    station_id: SID,
    uid: 'manager_1',
    roles: ['schedule_manager'],
    active: true,
    revision: 1
  });
  await setDoc(doc(db, `stations/${SID}/schedule_state/runtime`), { mode: 'shadow' });
  await setDoc(doc(db, `stations/${SID}/schedule_policies/policy_1`), { station_id: SID });
  await setDoc(doc(db, `stations/${SID}/schedule_sources/source_1/people/manager_1`), { uid: 'manager_1' });
  await setDoc(doc(db, `stations/${SID}/schedule_drafts/draft_1/rows/row_1`), { date: '2026-09-01' });
  await setDoc(doc(db, `stations/${SID}/schedule_publications/publication_1/rows/row_1`), { date: '2026-09-01' });
  await setDoc(doc(db, `stations/${SID}/schedule_publications/publication_1/events/event_1`), { date: '2026-09-01' });
  await setDoc(doc(db, `stations/${SID}/schedule_publications/publication_1/people/manager_1`), { id: 'manager_1' });
  await setDoc(doc(db, `stations/${SID}/schedule_publications/publication_1/schedule_outbox/outbox_1`), { person: 'manager_1' });
  // 42H · הדבקת הגיליון: מיפוי הכינויים והיעדרויות בטיוטה ובפרסום — שרת בלבד.
  await setDoc(doc(db, `stations/${SID}/schedule_state/sheet_aliases`), { station_id: SID, aliases: { 'כינוי': 'manager_1' } });
  await setDoc(doc(db, `stations/${SID}/schedule_drafts/draft_1/absences/a_1`), { date: '2026-09-01', entries: [{ uid: 'manager_1', kind: 'sick' }] });
  await setDoc(doc(db, `stations/${SID}/schedule_publications/publication_1/absences/a_1`), { date: '2026-09-01', entries: [{ uid: 'manager_1', kind: 'sick' }] });
  await setDoc(doc(db, `stations/${SID}/schedule_responses/response_1`), { person: 'manager_1' });
  await setDoc(doc(db, `stations/${SID}/schedule_audit/audit_1`), { action: 'seed' });
});

const protectedPaths = [
  ['runtime state', `stations/${SID}/schedule_state/runtime`],
  ['appointment', `stations/${SID}/schedule_access/manager_1`],
  ['policy', `stations/${SID}/schedule_policies/policy_1`],
  ['source child', `stations/${SID}/schedule_sources/source_1/people/manager_1`],
  ['draft child', `stations/${SID}/schedule_drafts/draft_1/rows/row_1`],
  ['publication row', `stations/${SID}/schedule_publications/publication_1/rows/row_1`],
  ['publication event', `stations/${SID}/schedule_publications/publication_1/events/event_1`],
  ['publication person', `stations/${SID}/schedule_publications/publication_1/people/manager_1`],
  ['publication outbox', `stations/${SID}/schedule_publications/publication_1/schedule_outbox/outbox_1`],
  ['sheet aliases', `stations/${SID}/schedule_state/sheet_aliases`],
  ['draft absences', `stations/${SID}/schedule_drafts/draft_1/absences/a_1`],
  ['publication absences', `stations/${SID}/schedule_publications/publication_1/absences/a_1`],
  ['response', `stations/${SID}/schedule_responses/response_1`],
  ['audit', `stations/${SID}/schedule_audit/audit_1`]
];

for (const [name, actor] of [
  ['appointed schedule manager', manager],
  ['HR coordinator', hr],
  ['super administrator', superUser]
]) {
  for (const [kind, path] of protectedPaths) {
    await blocked(name + ' cannot read ' + kind + ' directly', getDoc(doc(actor, path)));
    await blocked(name + ' cannot write ' + kind + ' directly', setDoc(doc(actor, path), { tampered: true }));
  }
}

for (const [name, actor] of [
  ['appointed schedule manager', manager],
  ['HR coordinator', hr],
  ['super administrator', superUser]
]) {
  await blocked(name + ' cannot list appointment records',
    getDocs(collection(actor, `stations/${SID}/schedule_access`)));
  await blocked(name + ' cannot list draft absences',
    getDocs(collection(actor, `stations/${SID}/schedule_drafts/draft_1/absences`)));
  await blocked(name + ' cannot list publication absences',
    getDocs(collection(actor, `stations/${SID}/schedule_publications/publication_1/absences`)));
  await blocked(name + ' cannot create an appointment directly',
    setDoc(doc(actor, `stations/${SID}/schedule_access/new_manager`), { active: true }));
  await blocked(name + ' cannot update an appointment directly',
    updateDoc(doc(actor, `stations/${SID}/schedule_access/manager_1`), { active: false }));
  await blocked(name + ' cannot delete an appointment directly',
    deleteDoc(doc(actor, `stations/${SID}/schedule_access/manager_1`)));
}

await env.cleanup();
console.log('\n' + passed + ' schedule-access browser-isolation checks passed.');
