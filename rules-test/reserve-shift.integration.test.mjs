// Native Firestore transactions + current Rules, with strictly synthetic Auth.
// No callable transport, live Firebase project, browser, or production data.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):(8080|8191)$/, 'explicit loopback emulator on 8080 or 8191 required');
assert.equal(process.env.GCLOUD_PROJECT, 'demo-resq', 'demo-resq required');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT === 'demo-resq', 'conflicting project is forbidden');
process.env.METADATA_SERVER_DETECTION = 'none';
const require = createRequire(import.meta.url);
const { createAttendanceSelfService } = require('../functions/attendance-self-service');
const { createAttendanceCorrections } = require('../functions/attendance-corrections');
const { calculateAttendanceDerived } = require('../functions/attendance-hours-calculator');
const run = randomBytes(4).toString('hex'), sid = 'reserve_it_' + run, otherSid = 'reserve_other_' + run;
const app = initializeApp({ projectId: 'demo-resq' }, 'reserve-it-' + run);
const db = getFirestore(app), root = db.doc('stations/' + sid);
const month = '2026-09', now = Date.parse('2026-09-29T09:00:00Z'), authTime = Math.floor(now / 1000) - 100;
const people = [], authRecords = new Map();
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const auth = { async getUser(uid) {
  assert.ok(authRecords.has(uid), 'synthetic Auth must never accept an unregistered UID');
  return structuredClone(authRecords.get(uid));
} };
const ports = { db, auth, HttpsError, serverTimestamp: () => FieldValue.serverTimestamp(),
  clock: () => now, monthAt: () => month,
  readConfig: async () => ({ siteById: { fixed_site: { name: 'Synthetic fixed site', fixed_hours: 25 } }, shiftHours: 24 }),
  calculate: calculateAttendanceDerived };
const self = createAttendanceSelfService(ports), hr = createAttendanceCorrections(ports);
const version = snap => ({ seconds: snap.updateTime.seconds, nanoseconds: snap.updateTime.nanoseconds });
const ref = (person, date) => root.collection('attendance').doc(person.emp + '_' + date);
const patch = changes => ({ day_type: 'reserve_shift', shape: 'regular', start: '07:00', end: '07:00', end_day: 1,
  start2: '', end2: '', end_day2: 0, sub_station: '', overtime_reason: '', notes: '', ...changes });
const request = (person, data) => ({ auth: { uid: person.uid, token: { ...person.claims, auth_time: authTime } }, data });
const saveData = (date, changes = {}, requestId = 'save_' + randomBytes(6).toString('hex')) => ({
  date, operation: 'save', expected_version: 'absent', request_id: requestId, patch: patch(changes) });
const rejectCode = (operation, code) => assert.rejects(operation, error => error.code === code);
let passed = 0, environment;
async function check(label, work) { await work(); passed++; console.log('PASS reserve shift: ' + label); }
async function person(role = 'firefighter', stationId = sid) {
  const n = people.length + 1, uid = 'reserve_' + run + '_' + n, emp = run + '_' + n;
  const claims = { stationId, role, emp, crew: 'A', shift: 'A', districtId: 'synthetic',
    email: uid + '@example.invalid', email_verified: true };
  const value = { uid, emp, claims, stationId }; people.push(value);
  authRecords.set(uid, { uid, disabled: false, displayName: 'Synthetic ' + n,
    customClaims: claims, tokensValidAfterTime: new Date(0).toISOString() });
  await db.doc('stations/' + stationId + '/users/' + uid).set({ uid, stationId, role, employee_number: emp,
    active: true, is_active: true, crew: 'A', full_name: 'Synthetic ' + n });
  await db.doc('emp_index/' + emp).set({ uid, stationId, active: true });
  await db.doc('directory/' + uid).set({ uid, stationId, role, employee_number: emp, active: true, is_active: true });
  // Model an already-consented synthetic user, as required by current Rules.
  await db.doc('registration_terms_active/' + uid).set({ uid, consent_key: '1.3|2026-09-24',
    terms_version: '1.3', privacy_version: '2026-09-24',
    receipt_path: 'registration_consents/' + uid + '/events/synthetic' });
  return value;
}
async function seed(person, date, changes = {}) {
  await ref(person, date).set({ uid: person.uid, emp_number: person.emp, crew: 'A', full_name: 'Synthetic fixture',
    date, month: date.slice(0, 7), status: 'draft', hours: 24, ...patch(), ...changes });
}
async function cleanup() {
  for (const stationId of [sid, otherSid]) {
    const station = db.doc('stations/' + stationId);
    for (const collection of await station.listCollections()) {
      const records = await collection.get();
      for (const item of records.docs) await item.ref.delete();
      assert.equal((await collection.get()).empty, true, 'synthetic collection cleaned');
    }
    await station.delete();
  }
  for (const value of people) {
    await db.doc('emp_index/' + value.emp).delete(); await db.doc('directory/' + value.uid).delete();
    await db.doc('registration_terms_active/' + value.uid).delete();
  }
}

try {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  environment = await initializeTestEnvironment({ projectId: 'demo-resq', firestore: { host, port: Number(port),
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  await root.set({ name: 'Synthetic reserve fixture', districtId: 'synthetic', active: true });
  await db.doc('stations/' + otherSid).set({ name: 'Synthetic other fixture', districtId: 'synthetic', active: true });
  const coordinator = await person('hr_coordinator');
  let owner, saved;

  await check('self create derives 24 hours despite fixed site and commits server timestamp', async () => {
    owner = await person();
    const response = await self.mutateDay(request(owner, saveData('2026-09-10', { sub_station: 'fixed_site' })));
    assert.equal(response.duplicate, false);
    saved = (await ref(owner, '2026-09-10').get()).data();
    assert.equal(saved.hours, 24); assert.equal(saved.day_type_he, 'משמרת בזמן מילואים');
    assert.equal(saved.end_day, 1); assert.equal(saved.uid, owner.uid);
    assert.ok(saved.reported_at instanceof Timestamp);
    assert.ok(saved.updated_at instanceof Timestamp);
    assert.equal(saved.reason_required, false);
  });
  await check('simultaneous overlapping dates have exactly one committed winner', async () => {
    const value = await person();
    const outcomes = await Promise.allSettled([
      self.mutateDay(request(value, saveData('2026-09-10', { start: '08:00', end: '08:00' }))),
      self.mutateDay(request(value, saveData('2026-09-11')))
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'failed-precondition');
    assert.equal((await root.collection('attendance').where('emp_number', '==', value.emp).get()).size, 1);
  });
  await check('HR create/update reject overlap, accept adjacency and retain audit evidence', async () => {
    const value = await person(); await self.mutateDay(request(value, saveData('2026-09-10')));
    const correction = (date, changes, id) => request(coordinator, { target_uid: value.uid, employee_number: value.emp,
      month, date, operation: 'create', expected_version: 'absent', patch: patch(changes),
      reason: 'Synthetic reserve integration correction reason', request_id: id });
    await rejectCode(() => hr.correctOneDay(correction('2026-09-11', { start: '06:00', end: '06:00' }, 'hr_conflict_' + run)), 'failed-precondition');
    assert.equal((await ref(value, '2026-09-11').get()).exists, false);
    const good = await hr.correctOneDay(correction('2026-09-11', {}, 'hr_adjacent_' + run));
    assert.equal(good.duplicate, false);
    assert.equal((await root.collection('attendance_correction_events').doc(good.correction_id).get()).exists, true);
    const edit = correction('2026-09-11', { start: '06:00', end: '06:00' }, 'hr_edit_conflict_' + run);
    edit.data.operation = 'update'; edit.data.expected_version = version(await ref(value, '2026-09-11').get());
    await rejectCode(() => hr.correctOneDay(edit), 'failed-precondition');
    assert.equal((await ref(value, '2026-09-11').get()).data().start, '07:00');
  });
  await check('fill rejects internal overlap atomically and exact successful batch retries', async () => {
    const value = await person(), data = { month, operation: 'fill', request_id: 'fill_conflict_' + run,
      entries: [{ date: '2026-09-10', patch: patch() }, { date: '2026-09-11', patch: patch({ day_type: 'regular', start: '06:00', end: '10:00', end_day: 0 }) }] };
    await rejectCode(() => self.mutateMonth(request(value, data)), 'failed-precondition');
    assert.equal((await root.collection('attendance').where('emp_number', '==', value.emp).get()).size, 0);
    const valid = { ...data, request_id: 'fill_adjacent_' + run,
      entries: [{ date: '2026-09-10', patch: patch() }, { date: '2026-09-11', patch: patch() }] };
    const result = await self.mutateMonth(request(value, valid)); assert.equal(result.changed_count, 2);
    assert.equal((await self.mutateMonth(request(value, valid))).duplicate, true);
  });
  await check('fill respects existing reserve across the month boundary', async () => {
    const value = await person(); await seed(value, '2026-08-31', { start: '08:00', end: '08:00' });
    const data = { month, operation: 'fill', request_id: 'fill_boundary_' + run,
      entries: [{ date: '2026-09-01', patch: patch({ day_type: 'regular', start: '07:00', end: '19:00', end_day: 0 }) },
        { date: '2026-09-20', patch: patch() }] };
    await rejectCode(() => self.mutateMonth(request(value, data)), 'failed-precondition');
    assert.equal((await ref(value, '2026-09-01').get()).exists, false);
    assert.equal((await ref(value, '2026-09-20').get()).exists, false);
  });
  await check('supported offset two detects overlap across two calendar dates', async () => {
    const value = await person(); await seed(value, '2026-09-08', { day_type: 'regular', end: '09:00', end_day: 2, hours: 50 });
    await rejectCode(() => self.mutateDay(request(value, saveData('2026-09-10'))), 'failed-precondition');
    assert.equal((await ref(value, '2026-09-10').get()).exists, false);
  });
  await check('receipt replay remains exact after neighbor change, collision and stale CAS fail', async () => {
    const value = await person(), data = saveData('2026-09-10', {}, 'stable_replay_' + run);
    const first = await self.mutateDay(request(value, data)), snapshot = await ref(value, data.date).get();
    await seed(value, '2026-09-11', { start: '06:00', end: '06:00' });
    const replay = await self.mutateDay(request(value, data)); assert.equal(replay.duplicate, true);
    assert.equal(replay.operation_id, first.operation_id);
    await rejectCode(() => self.mutateDay(request(value, { ...data, patch: patch({ notes: 'different' }) })), 'already-exists');
    await ref(value, data.date).update({ notes: 'synthetic concurrent editor' });
    await rejectCode(() => self.mutateDay(request(value, { ...data, expected_version: version(snapshot),
      request_id: 'stale_version_' + run })), 'aborted');
  });
  await check('reserve absence stays 8.5, explicit legacy 24 is preserved and ambiguous equal clocks cannot write', async () => {
    const value = await person(); await self.mutateDay(request(value, saveData('2026-09-01', { day_type: 'reserve', start: '', end: '', end_day: 0 })));
    assert.equal((await ref(value, '2026-09-01').get()).data().hours, 8.5);
    const invalid = saveData('2026-09-10'); delete invalid.patch.end_day;
    await rejectCode(() => self.mutateDay(request(value, invalid)), 'invalid-argument');
    assert.equal((await ref(value, '2026-09-10').get()).exists, false);
    const ambiguous = saveData('2026-09-12', { day_type: 'regular' }); delete ambiguous.patch.end_day;
    await rejectCode(() => self.mutateDay(request(value, ambiguous)), 'invalid-argument');
    assert.equal((await ref(value, '2026-09-12').get()).exists, false);
    await seed(value, '2026-09-20', { day_type: 'regular', start: '08:00', end: '08:00' });
    const legacy = await ref(value, '2026-09-20').get();
    await self.mutateDay(request(value, { date: '2026-09-20', operation: 'save', expected_version: version(legacy),
      request_id: 'legacy_note_' + run, patch: { day_type: 'regular', notes: 'Preserve historical interval' } }));
    assert.equal((await ref(value, '2026-09-20').get()).data().hours, 24);
    assert.equal((await ref(value, '2026-09-20').get()).data().end_day, 1);
  });
  await check('server rejects forged identity fields, foreign row identity and revoked role', async () => {
    const value = await person(), data = saveData('2026-09-10');
    await rejectCode(() => self.mutateDay(request(value, { ...data, patch: { ...data.patch, uid: owner.uid } })), 'invalid-argument');
    await seed(value, data.date, { uid: owner.uid });
    const foreignVersion = version(await ref(value, data.date).get());
    await rejectCode(() => self.mutateDay(request(value, { ...data, expected_version: foreignVersion })), 'failed-precondition');
    authRecords.get(value.uid).customClaims.role = 'hr_coordinator';
    await rejectCode(() => self.mutateDay(request(value, saveData('2026-09-12'))), 'permission-denied');
  });
  await check('Rules allow owner and local HR reads and deny other employee/station reads', async () => {
    const other = await person(), foreign = await person('hr_coordinator', otherSid);
    const path = ref(owner, '2026-09-10').path;
    assert.equal((await getDoc(doc(environment.authenticatedContext(owner.uid, owner.claims).firestore(), path))).data().hours, 24);
    assert.equal((await getDoc(doc(environment.authenticatedContext(coordinator.uid, coordinator.claims).firestore(), path))).exists(), true);
    for (const value of [other, foreign]) {
      await rejectCode(() => getDoc(doc(environment.authenticatedContext(value.uid, value.claims).firestore(), path)), 'permission-denied');
    }
  });
  await check('Rules deny direct create/update/delete to both owner and HR', async () => {
    for (const value of [owner, coordinator]) {
      const client = environment.authenticatedContext(value.uid, value.claims).firestore();
      await rejectCode(() => setDoc(doc(client, ref(owner, '2026-09-15').path), { ...saved, date: '2026-09-15',
        reported_at: saved.reported_at.toDate(), updated_at: saved.updated_at.toDate() }), 'permission-denied');
      await rejectCode(() => updateDoc(doc(client, ref(owner, '2026-09-10').path), { hours: 99 }), 'permission-denied');
      await rejectCode(() => deleteDoc(doc(client, ref(owner, '2026-09-10').path)), 'permission-denied');
    }
  });
} finally {
  await cleanup();
  if (environment) await environment.cleanup();
  await deleteApp(app);
}
console.log('Reserve shift native integration: ' + passed + '/11 PASS; real Firestore transactions and Rules, synthetic Auth/config only.');
