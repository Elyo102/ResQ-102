'use strict';
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const endpoint = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(process.env.FIRESTORE_EMULATOR_HOST || '');
if (!endpoint || Number(endpoint[2]) < 1 || Number(endpoint[2]) > 65535 || process.env.GCLOUD_PROJECT !== 'demo-resq') {
  console.error('NOT RUN: loopback Firestore emulator and GCLOUD_PROJECT=demo-resq required.');
  process.exit(2);
}
process.env.METADATA_SERVER_DETECTION = 'none';
const admin = require('firebase-admin');
const { createAttendanceCorrectionSupport } = require('./attendance-correction-support');
const source = path.join(__dirname, 'attendance-correction-support.js');
const beforeHash = createHash('sha256').update(readFileSync(source)).digest('hex');
const app = admin.initializeApp({ projectId:'demo-resq' }, 'attendance-support-' + process.pid);
const db = app.firestore(), FV = admin.firestore.FieldValue;
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const suffix = randomBytes(6).toString('hex');
const sid = 'attendance_support_' + suffix, actor = 'support_actor_' + suffix;
const target = 'support_target_' + suffix, emp = 'support_emp_' + suffix, month = '2026-09', date = month + '-01';
const root = db.doc('stations/' + sid), now = Date.parse('2026-09-08T09:00:00Z'), authTime = now / 1000 - 100;
const actorRecord = { uid:actor, disabled:false, displayName:'Synthetic Super', tokensValidAfterTime:new Date(0).toISOString(),
  customClaims:{ stationId:sid, super:true } };
const auth = { async getUser(uid) { if (uid !== actor) throw Object.assign(new Error('missing'), { code:'auth/user-not-found' }); return structuredClone(actorRecord); } };
const api = createAttendanceCorrectionSupport({ db, auth, HttpsError, clock:()=>now, monthAt:()=>month,
  serverTimestamp:()=>FV.serverTimestamp() });
const req = data => ({ auth:{ uid:actor, token:{ stationId:sid, super:true, auth_time:authTime } }, data:{ target_uid:target, employee_number:emp, month, ...data } });
const version = snap => ({ seconds:snap.updateTime.seconds, nanoseconds:snap.updateTime.nanoseconds });
async function cleanup() {
  for (const name of ['attendance','monthly_reports','attendance_correction_events','attendance_correction_receipts','attendance_correction_notification_jobs','users']) {
    const qs = await root.collection(name).get();
    for (const doc of qs.docs) await doc.ref.delete();
  }
}
async function assertCleanup() {
  for (const name of ['attendance','monthly_reports','attendance_correction_events','attendance_correction_receipts','attendance_correction_notification_jobs','users']) {
    assert.equal((await root.collection(name).get()).empty, true, 'fixture collection removed: ' + name);
  }
  assert.equal((await db.collection('emp_index').doc(emp).get()).exists, false, 'fixture employee index removed');
  assert.equal((await db.collection('directory').doc(target).get()).exists, false, 'fixture directory record removed');
}
(async () => {
  try {
    await root.collection('users').doc(target).set({ uid:target, stationId:sid, role:'firefighter', employee_number:emp,
      active:true, is_active:true, full_name:'Synthetic Employee', crew:'A' });
    await db.collection('emp_index').doc(emp).set({ uid:target, stationId:sid, active:true });
    await db.collection('directory').doc(target).set({ uid:target, stationId:sid, role:'firefighter', employee_number:emp,
      active:true, is_active:true });
    const reportRef = root.collection('monthly_reports').doc(emp + '_' + month);
    const dayRef = root.collection('attendance').doc(emp + '_' + date);
    await reportRef.set({ uid:target, emp_number:emp, month, status:'approved', approved_at:new Date(now - 5000),
      approved_by:'previous_actor', submitted_at:new Date(now - 10000), total_hours:8, days:[date], declaration:'existing' });
    await dayRef.set({ uid:target, emp_number:emp, month, date, status:'approved', day_type:'regular', shape:'regular',
      start:'08:00', end:'16:00', end_day:0, start2:'', end2:'', end_day2:0, sub_station:'', hours:8,
      day_type_he:'רגיל', site_name:'', reason_required:false, overtime_reason:'', notes:'existing' });
    const context = await api.getContext(req({}));
    assert.equal(context.days.length, 1); assert.equal(context.days[0].can_correct, false);
    assert.equal(context.eligibility.can_reopen, true); assert.deepEqual(context.days[0].expected_version, version(await dayRef.get()));
    const reopenData = { expected_report_version:context.report.expected_version,
      days:context.days.map(row=>({ date:row.date, expected_version:row.expected_version })),
      request_id:'native_reopen_0001', reason:'Native emulator authorized reopening reason' };
    const reopened = await api.reopen(req(reopenData));
    assert.equal(reopened.outcome, 'recorded'); assert.equal(reopened.attendance_changed_count, 1);
    assert.equal((await reportRef.get()).data().status, 'draft'); assert.equal((await dayRef.get()).data().status, 'draft');
    const replay = await api.reopen(req(reopenData)); assert.equal(replay.duplicate, true); assert.equal(replay.reopen_id, reopened.reopen_id);
    const list = await api.listAudit(req({})); assert.equal(list.items.length, 1); assert.equal(list.items[0].event_id, reopened.reopen_id);
    const detail = await api.getAudit(req({ event_id:reopened.reopen_id }));
    assert.equal(detail.reason, reopenData.reason); assert.equal(detail.changes[0].date, date);
    assert.equal((await root.collection('attendance_correction_notification_jobs').get()).size, 0);
    console.log('Attendance correction support native integration: approved-reopen/context/audit happy path PASS; real Firestore transactions/query/updateTime, synthetic Auth only.');
  } finally {
    await db.collection('emp_index').doc(emp).delete();
    await db.collection('directory').doc(target).delete();
    await cleanup();
    await assertCleanup();
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), beforeHash, 'product source stayed frozen');
    await app.delete();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
