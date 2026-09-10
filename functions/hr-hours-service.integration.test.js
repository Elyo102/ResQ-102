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
const quotaRef = db.collection('hr_hours_review_actor_quotas').doc(crypto.createHash('sha256').update(JSON.stringify(['hr-review-quota-v1',actor])).digest('hex'));
globalRefs.set(quotaRef.path, quotaRef);
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
      assert.equal(value.snapshot_revision, null); assert.equal(value.revision_unavailable, true);
    });
    await check('canonical native snapshots produce stable and version-sensitive revisions', async () => {
      const legacy = root.collection('attendance').doc('legacy-noncanonical-id');
      const canonical = root.collection('attendance').doc(emp + '_2026-09-01');
      try {
        await legacy.delete(); await canonical.set(rawDay);
        const read = () => service().getEmployeeMonth(req({month,uid}));
        const first = await read(); assert.match(first.snapshot_revision,/^[a-f0-9]{64}$/);
        assert.equal(first.revision_unavailable,false);
        assert.equal((await read()).snapshot_revision,first.snapshot_revision);
        await canonical.update({notes:'edited'});
        const changed = await read(); assert.notEqual(changed.snapshot_revision,first.snapshot_revision);
        await reportRef.update({total_hours:23});
        const reportChanged = await read(); assert.notEqual(reportChanged.snapshot_revision,changed.snapshot_revision);
        await reportRef.delete();
        const missing = await read(); assert.notEqual(missing.snapshot_revision,reportChanged.snapshot_revision);
        assert.equal(missing.revision_unavailable,false);
      } finally { await canonical.delete(); await legacy.set(rawDay); await reportRef.set(rawReport); }
    });
    await check('review receipt is atomic, idempotent and separate from approval', async () => {
      const legacy = root.collection('attendance').doc('legacy-noncanonical-id');
      const canonical = root.collection('attendance').doc(emp + '_2026-09-01');
      const reviewer = createHrHoursService({db,auth,HttpsError,serverTimestamp:()=>admin.firestore.FieldValue.serverTimestamp()});
      try {
        await legacy.delete(); await canonical.set(rawDay);
        for (const status of ['draft','submitted','approved']) {
          await reportRef.set({...rawReport,status});
          const detail = await reviewer.getEmployeeMonth(req({month,uid}));
          const data = {month,uid,expected_revision:detail.snapshot_revision,request_id:'review_'+status};
          const [a,b] = await Promise.all([reviewer.reviewEmployeeMonth(req(data)),reviewer.reviewEmployeeMonth(req(data))]);
          assert.equal(a.review_id,b.review_id);assert.equal(Number(a.duplicate)+Number(b.duplicate),1);
          assert.equal((await reportRef.get()).data().status,status);
          assert.deepEqual((await canonical.get()).data(),rawDay);
          const receipt = await root.collection('hr_hours_review_events').doc(a.review_id).get();
          assert.equal(receipt.data().actor_uid,actor);assert.ok(receipt.data().reviewed_at.toMillis()>0);
          assert.equal(receipt.data().schema,'hr-hours-review-v2');
          const job=(await root.collection('hr_hours_review_notification_jobs').doc(a.review_id).get()).data();
          assert.deepEqual(job,{schema:'hr-review-notification-v1',event_id:a.review_id,station_id:sid,actor_uid:actor,
            actor_auth_time:AUTH_TIME,recipient_uid:uid,employee_number:emp,month,reviewed_revision:data.expected_revision,
            created_at_ms:receipt.data().created_at_ms,audience:'person',type:'report_reviewed',status:'policy_pending',
            delivery_status:'intent_only',send_now:false,consent_expires_at_ms:0,routine_after_quiet:true,exclude_actor:false});
          const beforeJob=await root.collection('hr_hours_review_notification_jobs').doc(a.review_id).get();
          await reviewer.reviewEmployeeMonth(req(data));
          assert.ok((await beforeJob.ref.get()).updateTime.isEqual(beforeJob.updateTime),'replay must not rewrite job');
          const inspected=await reviewer.getEmployeeMonth(req({month,uid}));assert.equal(inspected.review.current,true);
          assert.equal(inspected.review.actor_uid,actor);assert.equal(inspected.review.request_id,undefined);assert.equal(inspected.review.fingerprint,undefined);
          const listed=(await reviewer.listMonth(req({month}))).items.find(x=>x.uid===uid);assert.equal(listed.review.current,null);
        }
        const detail = await reviewer.getEmployeeMonth(req({month,uid}));
        const data = {month,uid,expected_revision:detail.snapshot_revision,request_id:'review_replay'};
        const original = await reviewer.reviewEmployeeMonth(req(data));
        await canonical.update({notes:'changed after review'});
        const replay = await reviewer.reviewEmployeeMonth(req(data));
        assert.equal(replay.review_id,original.review_id);assert.equal(replay.current,false);assert.equal(replay.duplicate,true);
        assert.equal((await reviewer.getEmployeeMonth(req({month,uid}))).review.current,false);
        await rejectsCode(()=>reviewer.reviewEmployeeMonth(req({...data,request_id:'review_stale'})),'aborted');
        await rejectsCode(()=>reviewer.reviewEmployeeMonth(req({...data,expected_revision:'a'.repeat(64)})),'already-exists');
        await reportRef.delete();
        assert.equal((await reviewer.reviewEmployeeMonth(req(data))).current,null);
        assert.equal((await reviewer.getEmployeeMonth(req({month,uid}))).review.current,null);
        await rejectsCode(()=>reviewer.reviewEmployeeMonth(req({...data,request_id:'review_missing'})),'failed-precondition');
        authRecords.get(actor).customClaims.role='firefighter';
        await rejectsCode(()=>reviewer.reviewEmployeeMonth(req(data)),'permission-denied');
        resetAuth();
      } finally { resetAuth();await canonical.delete();await legacy.set(rawDay);await reportRef.set(rawReport); }
    });
    await check('review final authorization, rollback, corruption and historical replay boundaries', async () => {
      const legacy=root.collection('attendance').doc('legacy-noncanonical-id'),canonical=root.collection('attendance').doc(emp+'_2026-09-01');
      const make=(extra={})=>createHrHoursService({db,auth,HttpsError,serverTimestamp:()=>admin.firestore.FieldValue.serverTimestamp(),...extra});
      const eventId=id=>crypto.createHash('sha256').update(JSON.stringify(['hr-review-event-v1',actor,id])).digest('hex');
      const summary=root.collection('hr_hours_reviews').doc(crypto.createHash('sha256').update(JSON.stringify(['hr-review-summary-v1',uid,month])).digest('hex'));
      try {
        await legacy.delete();await canonical.set(rawDay);
        const expected_revision=(await make().getEmployeeMonth(req({month,uid}))).snapshot_revision;
        const data={month,uid,expected_revision,request_id:'boundary_first'};
        const first=await make().reviewEmployeeMonth(req(data));
        await canonical.update({notes:'new snapshot'});
        const newer={...data,request_id:'boundary_newer',expected_revision:(await make().getEmployeeMonth(req({month,uid}))).snapshot_revision};
        const second=await make().reviewEmployeeMonth(req(newer));
        const savedSummary=(await summary.get()).data();assert.equal(savedSummary.review_id,second.review_id);
        try {
          for(const patch of [{station_id:'other_station'},{owner_uid:'other.person'},{employee_number:'other'},{month:'2026-08'},{review_id:'0'.repeat(64)},{fingerprint:'0'.repeat(64)}]){
            await summary.set({...savedSummary,...patch});
            const invalid=await make().getEmployeeMonth(req({month,uid}));assert.equal(invalid.review,null);assert.equal(invalid.review_unavailable,true);assert.equal(invalid.rows.length,1);
          }
          await summary.delete();const absent=await make().getEmployeeMonth(req({month,uid}));assert.equal(absent.review,null);assert.equal(absent.review_unavailable,false);
        } finally {await summary.set(savedSummary);}
        assert.equal((await make().reviewEmployeeMonth(req(data))).current,false);
        assert.deepEqual((await summary.get()).data(),savedSummary);
        await canonical.delete();await legacy.set(rawDay);
        assert.equal((await make().reviewEmployeeMonth(req(data))).current,null);
        await legacy.delete();await canonical.set(rawDay);
        const liveData={...data,request_id:'boundary_final_auth',expected_revision:(await make().getEmployeeMonth(req({month,uid}))).snapshot_revision};
        let calls=0;
        const revoke={getUser:async id=>{if(++calls===2)authRecords.get(actor).customClaims.role='firefighter';return auth.getUser(id);}};
        await rejectsCode(()=>make({auth:revoke}).reviewEmployeeMonth(req(liveData)),'permission-denied');resetAuth();
        assert.equal((await root.collection('hr_hours_review_events').doc(eventId(liveData.request_id)).get()).exists,false);
        let injected=false;
        const failingDb={collection:db.collection.bind(db),runTransaction:fn=>db.runTransaction(tx=>fn(new Proxy(tx,{get(t,k){if(k==='set')return()=>{injected=true;throw new Error('injected summary write failure');};const v=t[k];return typeof v==='function'?v.bind(t):v;}})))};
        const failData={...liveData,request_id:'boundary_atomic'};
        await assert.rejects(make({db:failingDb}).reviewEmployeeMonth(req(failData)),/injected summary write failure/);assert.equal(injected,true);
        assert.equal((await root.collection('hr_hours_review_events').doc(eventId(failData.request_id)).get()).exists,false);
        assert.deepEqual((await summary.get()).data(),savedSummary);
        const firstRef=root.collection('hr_hours_review_events').doc(first.review_id),original=(await firstRef.get()).data();
        try {
          await firstRef.update({extra:'corrupt'});await rejectsCode(()=>make().reviewEmployeeMonth(req(data)),'failed-precondition');
          await firstRef.set({...original,reviewed_at:{seconds:0,nanoseconds:1000000000}});await rejectsCode(()=>make().reviewEmployeeMonth(req(data)),'failed-precondition');
        } finally {await firstRef.set(original);}
      } finally {resetAuth();await canonical.delete();await legacy.set(rawDay);await reportRef.set(rawReport);}
    });
    await check('review quota charges only new commits, limits concurrency and expires at exact boundary', async () => {
      const legacy=root.collection('attendance').doc('legacy-noncanonical-id'), canonical=root.collection('attendance').doc(emp+'_2026-09-01');
      let time=1800000000000;
      const make=(extra={})=>createHrHoursService({db,auth,HttpsError,serverTimestamp:()=>admin.firestore.FieldValue.serverTimestamp(),clock:()=>time,...extra});
      try {
        await quotaRef.delete();await legacy.delete();await canonical.set(rawDay);
        const expected_revision=(await make().getEmployeeMonth(req({month,uid}))).snapshot_revision;
        const data={month,uid,expected_revision,request_id:'quota_first'};
        const pair=await Promise.all([make().reviewEmployeeMonth(req(data)),make().reviewEmployeeMonth(req(data))]);
        assert.equal(pair.filter(x=>x.duplicate).length,1);
        assert.deepEqual((await quotaRef.get()).data(),{requests_at_ms:[time]});
        await quotaRef.set({requests_at_ms:Array(9).fill(time)});
        const competing=await Promise.allSettled(['quota_tenth_a','quota_tenth_b'].map(request_id=>make().reviewEmployeeMonth(req({...data,request_id}))));
        assert.equal(competing.filter(x=>x.status==='fulfilled').length,1);
        assert.equal(competing.find(x=>x.status==='rejected').reason.code,'resource-exhausted');
        assert.equal((await quotaRef.get()).data().requests_at_ms.length,10);
        await rejectsCode(()=>make().reviewEmployeeMonth(req({...data,request_id:'quota_eleventh'})),'resource-exhausted');
        assert.equal((await make({clock:()=>{throw Error('replay must not read clock');}}).reviewEmployeeMonth(req(data))).duplicate,true);
        time+=60000;
        await make().reviewEmployeeMonth(req({...data,request_id:'quota_boundary'}));
        assert.deepEqual((await quotaRef.get()).data(),{requests_at_ms:[time]});
        for(const malformed of [{requests_at_ms:[time+1]},{requests_at_ms:[-1]},{requests_at_ms:['1']},{requests_at_ms:Array(11).fill(time)},{requests_at_ms:[],extra:true}]) {
          await quotaRef.set(malformed);
          await rejectsCode(()=>make().reviewEmployeeMonth(req({...data,request_id:'quota_invalid'})),'failed-precondition');
          assert.equal((await make().reviewEmployeeMonth(req(data))).duplicate,true);
          assert.deepEqual((await quotaRef.get()).data(),malformed);
        }
        await quotaRef.set({requests_at_ms:[]});
        for(const badClock of [NaN,-1,'1800000000000',Infinity,8640000000000001]) {
          await rejectsCode(()=>make({clock:()=>badClock}).reviewEmployeeMonth(req({...data,request_id:'quota_bad_clock'})),'failed-precondition');
          assert.deepEqual((await quotaRef.get()).data(),{requests_at_ms:[]});
        }
        const before=(await root.collection('hr_hours_review_events').get()).size;
        const failedDb={collection:db.collection.bind(db),runTransaction:fn=>db.runTransaction(tx=>fn(new Proxy(tx,{get(t,k){if(k==='set')return(ref,...args)=>{if(ref.path===quotaRef.path)throw Error('injected quota write failure');return t.set(ref,...args);};const v=t[k];return typeof v==='function'?v.bind(t):v;}})))};
        await assert.rejects(make({db:failedDb}).reviewEmployeeMonth(req({...data,request_id:'quota_atomic'})),/injected quota write failure/);
        assert.equal((await root.collection('hr_hours_review_events').get()).size,before);
        assert.deepEqual((await quotaRef.get()).data(),{requests_at_ms:[]});
      } finally {await quotaRef.delete();resetAuth();await canonical.delete();await legacy.set(rawDay);await reportRef.set(rawReport);}
    });
    await check('review v1 compatibility, v2 source validation and notification failure atomicity', async () => {
      const {validReview,reviewHash}=require('./hr-hours-review-contract');
      const legacy=root.collection('attendance').doc('legacy-noncanonical-id'),canonical=root.collection('attendance').doc(emp+'_2026-09-01');
      const make=(extra={})=>createHrHoursService({db,auth,HttpsError,serverTimestamp:()=>admin.firestore.FieldValue.serverTimestamp(),...extra});
      const events=root.collection('hr_hours_review_events'),jobs=root.collection('hr_hours_review_notification_jobs');
      const summary=root.collection('hr_hours_reviews').doc(reviewHash(['hr-review-summary-v1',uid,month]));
      try{
        await legacy.delete();await canonical.set(rawDay);
        const expected_revision=(await make().getEmployeeMonth(req({month,uid}))).snapshot_revision;
        const data={month,uid,expected_revision,request_id:'notification_source'};
        const result=await make().reviewEmployeeMonth(req(data));
        const receipt=(await events.doc(result.review_id).get()).data();assert.equal(validReview(receipt),true);
        const old={...receipt,schema:'hr-hours-review-v1'};delete old.actor_auth_time;delete old.created_at_ms;
        assert.equal(validReview(old),true);
        for(const bad of [{...old,created_at_ms:0},{...receipt,actor_auth_time:'1'},{...receipt,actor_auth_time:-1},
          {...receipt,created_at_ms:NaN},{...receipt,created_at_ms:8640000000000000},{...receipt,schema:'unknown'},{...receipt,extra:true}])assert.equal(validReview(bad),false);
        await events.doc(result.review_id).set(old);await summary.set(old);await jobs.doc(result.review_id).delete();
        const beforeQuota=(await quotaRef.get()).data();
        assert.equal((await make().reviewEmployeeMonth(req(data))).duplicate,true);
        assert.equal((await jobs.doc(result.review_id).get()).exists,false,'legacy replay never backfills');
        assert.deepEqual((await quotaRef.get()).data(),beforeQuota);
        assert.equal((await make().getEmployeeMonth(req({month,uid}))).review.review_id,result.review_id);
        const fail={...data,request_id:'notification_failure'};
        const id=reviewHash(['hr-review-event-v1',actor,fail.request_id]);
        const failedDb={collection:db.collection.bind(db),runTransaction:fn=>db.runTransaction(tx=>fn(new Proxy(tx,{get(t,k){if(k==='create')return(ref,...args)=>{if(ref.parent.id==='hr_hours_review_notification_jobs')throw Error('injected job write failure');return t.create(ref,...args);};const v=t[k];return typeof v==='function'?v.bind(t):v;}})))};
        await assert.rejects(make({db:failedDb}).reviewEmployeeMonth(req(fail)),/injected job write failure/);
        assert.equal((await events.doc(id).get()).exists,false);assert.equal((await jobs.doc(id).get()).exists,false);
        assert.deepEqual((await summary.get()).data(),old);assert.deepEqual((await quotaRef.get()).data(),beforeQuota);
        // Same user is an active HR employee: the personal job still exists.
        await profileRef.update({role:'hr_coordinator'});
        authRecords.set(uid,{uid,disabled:false,customClaims:{stationId:sid,role:'hr_coordinator'}});
        const selfRequest={auth:{uid,token:{stationId:sid,role:'hr_coordinator',auth_time:AUTH_TIME}},data:{...data,request_id:'notification_self'}};
        const selfQuota=db.collection('hr_hours_review_actor_quotas').doc(reviewHash(['hr-review-quota-v1',uid]));globalRefs.set(selfQuota.path,selfQuota);
        const self=await make().reviewEmployeeMonth(selfRequest);
        const selfJob=(await jobs.doc(self.review_id).get()).data();
        assert.equal(selfJob.actor_uid,uid);assert.equal(selfJob.recipient_uid,uid);assert.equal(selfJob.exclude_actor,false);
      }finally{resetAuth();authRecords.delete(uid);await profileRef.set(profile);await quotaRef.delete();await canonical.delete();await legacy.set(rawDay);await reportRef.set(rawReport);}
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
