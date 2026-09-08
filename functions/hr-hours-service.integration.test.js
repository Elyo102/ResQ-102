'use strict';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
const projectId = process.env.GCLOUD_PROJECT || '';
if (!/^(localhost|127\.0\.0\.1):\d{1,5}$/.test(host) || !/^demo-[a-z0-9-]+$/.test(projectId)) {
  console.error('NOT RUN: loopback Firestore emulator and demo-* project required.'); process.exit(2);
}
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { createHrHoursService } = require('./hr-hours-service');
const app = admin.initializeApp({ projectId }, 'hr-hours-' + process.pid);
const db = app.firestore();
const suffix = crypto.randomBytes(6).toString('hex'), sid = 'hr_it_' + suffix;
const root = db.collection('stations').doc(sid), globalRefs = new Map();
const actor = 'hr.' + suffix, uid = 'person.' + suffix, emp = 'emp_' + suffix, month = '2026-09';
const profileRef = root.collection('users').doc(uid), actorRef = root.collection('users').doc(actor);
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const AUTH_TIME = 1788220800;
const req = (data, token = { stationId: sid, role: 'hr_coordinator' }) => ({ auth: { uid: actor, token: { auth_time: AUTH_TIME, ...token } }, data });
// Real Firestore and actual domain; Auth is an explicit SDK-shaped in-memory double.
const authRecords = new Map();
let authFailure = null, authCalls = [];
const auth = { async getUser(id) {
  authCalls.push(id);
  if (authFailure) throw Object.assign(new Error('synthetic Auth failure'), { code: authFailure });
  if (!authRecords.has(id)) throw Object.assign(new Error('synthetic absent account'), { code: 'auth/user-not-found' });
  return structuredClone(authRecords.get(id));
} };
function resetAuth() {
  authFailure = null; authCalls = [];
  authRecords.set(actor, { uid: actor, disabled: false, customClaims: { stationId: sid, role: 'hr_coordinator' },
    tokensValidAfterTime: new Date(AUTH_TIME * 1000).toUTCString() });
  authRecords.set('super.' + suffix, { uid: 'super.' + suffix, disabled: false,
    customClaims: { stationId: sid, super: true } });
}
const profile = { stationId: sid, employee_number: emp, full_name: 'עובד בדיקה', crew: 'A', role: 'firefighter', active: true, is_active: true };
const rawReport = { uid, emp_number: emp, month, status: 'approved', days: ['2026-09-01'], total_hours: 24 };
const rawDay = { uid, emp_number: emp, month, date: '2026-09-01', hours: 24, start: '08:00', end: '08:00', end_day: 1 };
const reportRef = root.collection('monthly_reports').doc(emp + '_' + month);
const service = hooks => createHrHoursService({ db, auth, HttpsError, hooks });
let passed = 0;
async function putGlobal(path, value) {
  const ref = db.doc(path); globalRefs.set(path, ref); await ref.set(value); return ref;
}
async function seed() {
  resetAuth();
  await actorRef.set({ stationId: sid, role: 'hr_coordinator', active: true, employee_number: 'hr_' + suffix });
  await profileRef.set(profile);
  await putGlobal('emp_index/' + emp, { uid, stationId: sid, active: true, retired: false, status: 'active' });
  await putGlobal('directory/' + uid, { station: sid, active: true, full_name: 'שם ישן במדריך', crew: 'B' });
  await reportRef.set(rawReport);
  await root.collection('attendance').doc('legacy-noncanonical-id').set(rawDay);
}
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const rejectsCode = (fn, code) => assert.rejects(fn, e => e.code === code);
(async () => {
  try {
    await seed();
    await check('unauthenticated and ordinary roles cannot read HR reports', async () => {
      await rejectsCode(() => service().listMonth({ data: { month } }), 'unauthenticated');
      for (const role of ['firefighter', 'commander', 'deputy', 'station_commander']) {
        await rejectsCode(() => service().listMonth(req({ month }, { stationId: sid, role })), 'permission-denied');
      }
    });
    await check('email or super role string never grants HR authority', async () => {
      await rejectsCode(() => service().listMonth(req({ month }, { stationId: sid, role: 'super_admin', email: 'owner@example.invalid' })), 'permission-denied');
    });
    await check('closed request keys reject station and employee-number injection', async () => {
      await rejectsCode(() => service().listMonth(req({ month, stationId: 'other' })), 'invalid-argument');
      await rejectsCode(() => service().getEmployeeMonth(req({ month, uid, emp_number: emp })), 'invalid-argument');
      await rejectsCode(() => service().getEmployeeMonth(req({ month, uid: '../other' })), 'invalid-argument');
    });
    await check('list reads real approved document without invented exists or signatures', async () => {
      const value = (await service().listMonth(req({ month }))).items.find(p => p.uid === uid);
      assert.equal(value.state, 'approved'); assert.equal(value.stored_total_hours, 24);
      assert.equal(value.full_name, profile.full_name); assert.equal(value.crew, 'A');
      assert.equal(value.reminder_eligible, false); assert.equal(value.rows, undefined);
    });
    await check('detail query includes noncanonical legacy document ID', async () => {
      const value = await service().getEmployeeMonth(req({ month, uid }));
      assert.equal(value.rows.length, 1); assert.equal(value.current_detail_total_hours, 24);
      assert.equal(value.detail_provenance, 'current_attendance_not_historical_snapshot');
      assert.deepEqual(value.warnings, []);
    });
    await check('signed super works without station user profile', async () => {
      const r = req({ month, uid }, { stationId: sid, super: true }); r.auth.uid = 'super.' + suffix;
      assert.equal((await service().getEmployeeMonth(r)).state, 'approved');
    });
    await check('missing report is explicit and does not erase current attendance', async () => {
      await reportRef.delete();
      const value = await service().getEmployeeMonth(req({ month, uid }));
      assert.equal(value.state, 'missing'); assert.equal(value.rows.length, 1);
      await reportRef.set(rawReport);
    });
    await check('malformed report produces visible issue, not missing or whole-page loss', async () => {
      await reportRef.set({ ...rawReport, uid: 'another-user' });
      const value = (await service().listMonth(req({ month }))).items.find(p => p.uid === uid);
      assert.equal(value.state, 'unavailable'); assert.equal(value.issue, 'report-identity-mismatch');
      await rejectsCode(() => service().getEmployeeMonth(req({ month, uid })), 'failed-precondition');
      await reportRef.set(rawReport);
    });
    await check('attendance conflicting uid fails rather than showing another employee', async () => {
      await root.collection('attendance').doc('legacy-noncanonical-id').update({ uid: 'another-user' });
      await rejectsCode(() => service().getEmployeeMonth(req({ month, uid })), 'failed-precondition');
      await root.collection('attendance').doc('legacy-noncanonical-id').set(rawDay);
    });
    await check('transferred employee history retains old local identity and no nudge', async () => {
      await profileRef.update({ active: false, is_active: false });
      await db.doc('directory/' + uid).update({ station: 'new_station', full_name: 'שם בתחנה אחרת' });
      await db.doc('emp_index/' + emp).update({ stationId: 'new_station' });
      await reportRef.update({ status: 'draft' });
      const value = await service().getEmployeeMonth(req({ month, uid }));
      assert.equal(value.full_name, profile.full_name); assert.equal(value.historical, true);
      assert.equal(value.reminder_eligible, false); assert.equal(value.rows.length, 1);
      await seed();
    });
    await check('active target with contradictory global identity is an explicit issue', async () => {
      await db.doc('emp_index/' + emp).update({ uid: 'another-user' });
      const value = (await service().listMonth(req({ month }))).items.find(p => p.uid === uid);
      assert.equal(value.state, 'unavailable'); assert.equal(value.issue, 'person-binding-unavailable');
      await seed();
    });
    await check('actor revoked before final response rejects the whole payload', async () => {
      await rejectsCode(() => service({ beforeFinalize: () => actorRef.update({ active: false }) }).listMonth(req({ month })), 'permission-denied');
      await seed();
    });
    await check('actor role changed during detail loading rejects response', async () => {
      await rejectsCode(() => service({ beforeFinalize: () => actorRef.update({ role: 'firefighter' }) }).getEmployeeMonth(req({ month, uid })), 'permission-denied');
      await seed();
    });
    await check('target changed during loading rejects stale detail', async () => {
      await rejectsCode(() => service({ beforeFinalize: () => profileRef.update({ full_name: 'שם שתוקן' }) }).getEmployeeMonth(req({ month, uid })), 'aborted');
      await seed();
    });
    await check('active index transferred during loading rejects stale detail', async () => {
      await rejectsCode(() => service({ beforeFinalize: () => db.doc('emp_index/' + emp).update({ stationId: 'other_station' }) }).getEmployeeMonth(req({ month, uid })), 'aborted');
      await seed();
    });
    await check('pagination advances by scanned invalid profiles and does not omit next page', async () => {
      const refs = [];
      for (let i = 0; i < 26; i++) {
        const ref = root.collection('users').doc('aa_' + String(i).padStart(2, '0')); refs.push(ref);
        await ref.set({ stationId: sid, active: false, full_name: 'רשומה ללא מספר עובד' });
      }
      const first = await service().listMonth(req({ month }));
      assert.equal(first.items.length, 25); assert.equal(first.next_cursor, 'aa_24');
      assert.ok(first.items.every(p => p.state === 'unavailable'));
      const second = await service().listMonth(req({ month, cursor: first.next_cursor }));
      assert.ok(second.items.some(p => p.uid === uid)); assert.equal(second.next_cursor, null);
      await Promise.all(refs.map(ref => ref.delete()));
    });
    await check('32 records are rejected without silently dropping rows', async () => {
      const refs = [];
      for (let i = 0; i < 31; i++) {
        const ref = root.collection('attendance').doc('extra_' + i); refs.push(ref); await ref.set(rawDay);
      }
      await rejectsCode(() => service().getEmployeeMonth(req({ month, uid })), 'failed-precondition');
      await Promise.all(refs.map(ref => ref.delete()));
    });
    for (const method of ['listMonth', 'getEmployeeMonth']) {
      const data = method === 'listMonth' ? { month } : { month, uid };
      await check(method + ': invalid authentication times fail before Auth reads', async () => {
        for (const value of [undefined, null, -1, 0.5, '1000', Number.MAX_SAFE_INTEGER]) {
          resetAuth();
          await rejectsCode(() => service()[method](req(data, { stationId: sid, role: 'hr_coordinator', auth_time: value })), 'unauthenticated');
          assert.equal(authCalls.length, 0);
        }
      });
      const cases = [
        ['disabled', () => { authRecords.get(actor).disabled = true; }, 'permission-denied'],
        ['missing account', () => authRecords.delete(actor), 'permission-denied'],
        ['wrong record UID', () => { authRecords.get(actor).uid = 'other'; }, 'permission-denied'],
        ['station changed', () => { authRecords.get(actor).customClaims.stationId = 'other_station'; }, 'permission-denied'],
        ['role changed', () => { authRecords.get(actor).customClaims.role = 'firefighter'; }, 'permission-denied'],
        ['fresh super upgrade', () => { authRecords.get(actor).customClaims.super = true; }, 'permission-denied'],
        ['malformed claims', () => { authRecords.get(actor).customClaims = []; }, 'permission-denied'],
        ['revoked sign-in', () => { authRecords.get(actor).tokensValidAfterTime = new Date((AUTH_TIME + 1) * 1000).toUTCString(); }, 'permission-denied'],
        ...[null, 123, 'not-a-date'].map(value => ['invalid validity ' + String(value), () => { authRecords.get(actor).tokensValidAfterTime = value; }, 'unavailable']),
        ['Auth unavailable', () => { authFailure = 'auth/internal-error'; }, 'unavailable']
      ];
      for (const stage of ['initial', 'final']) {
        await check(method + ': ' + stage + ' fresh Auth failures reject whole response', async () => {
          for (const [label, change, code] of cases) {
            resetAuth();
            const hooks = stage === 'final' ? { beforeFinalize: change } : {};
            if (stage === 'initial') change();
            await assert.rejects(() => service(hooks)[method](req(data)), e => e.code === code, label);
            assert.equal(authCalls.length, stage === 'initial' ? 1 : 2, label);
          }
          resetAuth();
        });
      }
      await check(method + ': equality and absent marker permit exactly two actor-only Auth reads', async () => {
        for (const marker of [new Date(AUTH_TIME * 1000).toUTCString(), undefined]) {
          resetAuth(); authRecords.get(actor).tokensValidAfterTime = marker;
          await service()[method](req(data)); assert.deepEqual(authCalls, [actor, actor]);
        }
      });
      await check(method + ': profile-free signed super stays bounded by fresh super and station', async () => {
        const r = req(data, { stationId: sid, super: true }); r.auth.uid = 'super.' + suffix;
        resetAuth(); await service()[method](r);
        assert.deepEqual(authCalls, [r.auth.uid, r.auth.uid]);
        await rejectsCode(() => service({ beforeFinalize() { authRecords.get(r.auth.uid).customClaims.super = false; } })[method](r), 'permission-denied');
        resetAuth();
      });
    }
    console.log(passed + ' HR hours emulator scenarios passed. No production contacted.');
  } finally {
    // Unique test namespace and explicitly tracked global fixture references.
    await db.recursiveDelete(root);
    await Promise.all([...globalRefs.values()].map(ref => ref.delete()));
    await app.delete();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
