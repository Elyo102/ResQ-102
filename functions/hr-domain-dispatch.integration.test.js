'use strict';
// Actual domain producers and real Firestore transactions; Auth/FCM are local
// synthetic dependencies. No Google Auth, FCM, browser, scheduler or production.
const assert = require('node:assert/strict');
const localEndpoint=/^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(process.env.FIRESTORE_EMULATOR_HOST || '');
if (!localEndpoint || Number(localEndpoint[2])<1 || Number(localEndpoint[2])>65535 || process.env.GCLOUD_PROJECT !== 'demo-resq') {
  console.error('NOT RUN: loopback Firestore emulator and GCLOUD_PROJECT=demo-resq required.');
  process.exit(2);
}
process.env.METADATA_SERVER_DETECTION = 'none';
const { randomBytes, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const { createHrRequests } = require('./hr-requests');
const { createHrDocuments } = require('./hr-documents');
const { createHrHoursService } = require('./hr-hours-service');
const { createAttendanceCorrections } = require('./attendance-corrections');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { createHrDomainDispatch, LIMITS } = require('./hr-domain-dispatch');
const { notificationIntent } = require('./hr-notification-policy');
const sourceFiles = ['hr-domain-dispatch.js', 'hr-requests.js', 'hr-documents.js', 'hr-hours-dispatch.js', 'hr-notification-policy.js', 'hr-hours-service.js', 'hr-hours-review-contract.js', 'attendance-corrections.js'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(f => [f, createHash('sha256').update(readFileSync(path.join(__dirname, f))).digest('hex')]));
const beforeHashes = sourceHashes();
const app = admin.initializeApp({ projectId: 'demo-resq' }, 'hr-domain-dispatch-' + process.pid), db = app.firestore();
const runId = randomBytes(6).toString('hex'), runtime = db.doc('config/runtime');
const authTime = Date.parse('2026-09-01T00:00:00Z') / 1000;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const records = new Map(), roots = [], quotas = new Map(), tests = [];
const auth = { async getUser(uid) {
  const record = records.get(uid);
  if (record instanceof Error) throw record;
  if (!record) throw Object.assign(new Error('synthetic missing Auth'), { code: 'auth/user-not-found' });
  return structuredClone(record);
} };
const accepted = p => ({ responses: p.tokens.map((_, i) => ({ success: true, messageId: 'synthetic/' + i })) });
const identity = createOpsMemberIdentity({ db, HttpsError });
let sequence = 0, passed = 0, priorRuntime;
const collections = { request: 'hr_request_notification_jobs', document: 'hr_document_notification_jobs', review: 'hr_hours_review_notification_jobs', correction: 'attendance_correction_notification_jobs' };
const active = ['policy_pending', 'discovering', 'queued', 'processing', 'deferred', 'blocked'];
async function fixture() {
  const sid = 'hr_domain_it_' + runId + '_' + (++sequence), root = db.doc('stations/' + sid); roots.push(root);
  const f = { sid, root, people: {}, at: Date.parse('2026-09-08T09:00:00Z'), calls: [] };
  f.add = async (name, role = 'firefighter', superUser = false, profile = true) => {
    const uid = name + '_' + sid, claims = { stationId: sid, ...(superUser ? { super: true } : { role }) };
    records.set(uid, { uid, disabled: false, customClaims: claims, tokensValidAfterTime: new Date(authTime * 1000).toUTCString() });
    if (profile) await root.collection('users').doc(uid).set({ stationId: sid, role, active: true, full_name: 'PRIVATE_SYNTHETIC_NAME' });
    for (const [collection, prefix] of [['hr_request_actor_quotas', 'hr-request-quota-v1'], ['hr_document_actor_quotas', 'hr-document-quota-v1']]) {
      const ref = db.doc(collection + '/' + hash([prefix, uid])); quotas.set(ref.path, ref);
    }
    const token = 'synthetic-token-' + uid;
    await root.collection('push_tokens').doc(uid).set({ tokens: [{ token }], prefs: { report_mine: false, hr_private: false, hr_document: false, hr_request: false } });
    return f.people[name] = { uid, claims, token };
  };
  await f.add('owner'); await f.add('other'); await f.add('hr', 'hr_coordinator'); await f.add('command', 'station_commander');
  f.req = (name, data) => ({ auth: { uid: f.people[name].uid, token: { ...f.people[name].claims, auth_time: authTime } }, data });
  f.requests = createHrRequests({ db, auth, HttpsError, clock: () => f.at });
  f.documents = createHrDocuments({ db, auth, HttpsError, clock: () => f.at });
  f.review = async (self=false) => {
    const name=self?'hr':'owner',uid=f.people[name].uid,emp='full_employee_number_'+uid,month='2026-09';
    for(const [p,value] of [['emp_index/'+emp,{uid,stationId:sid,active:true}],['directory/'+uid,{station:sid,active:true}]]){
      const ref=db.doc(p);quotas.set(ref.path,ref);await ref.set(value);
    }
    await root.collection('users').doc(uid).update({employee_number:emp});
    const q=db.doc('hr_hours_review_actor_quotas/'+hash(['hr-review-quota-v1',f.people.hr.uid]));quotas.set(q.path,q);
    await root.collection('monthly_reports').doc(emp+'_'+month).set({uid,emp_number:emp,month,status:'submitted',total_hours:0,days:[]});
    const hours=createHrHoursService({db,auth,HttpsError,clock:()=>f.at,serverTimestamp:()=>admin.firestore.FieldValue.serverTimestamp()});
    const detail=await hours.getEmployeeMonth(f.req('hr',{month,uid}));
    const data={month,uid,expected_revision:detail.snapshot_revision,request_id:'review-001'};
    const result=await hours.reviewEmployeeMonth(f.req('hr',data));
    return {result,emp,uid,month,replay:()=>hours.reviewEmployeeMonth(f.req('hr',data))};
  };
  f.correct = async ({self=false,role='firefighter',operation='create'}={}) => {
    const name=self?'hr':'owner',uid=f.people[name].uid,emp='correction_employee_'+uid,month='2026-09',date=month+'-01';
    if(!self){records.get(uid).customClaims.role=role;await root.collection('users').doc(uid).update({role});}
    await root.collection('users').doc(uid).update({uid,employee_number:emp,crew:'A'});
    for(const [p,value] of [['emp_index/'+emp,{uid,stationId:sid,active:true}],['directory/'+uid,{uid,stationId:sid,employee_number:emp,active:true}]]){
      const ref=db.doc(p);quotas.set(ref.path,ref);await ref.set(value);
    }
    await root.collection('monthly_reports').doc(emp+'_'+month).set({uid,emp_number:emp,month,status:'draft'});
    const dayRef=root.collection('attendance').doc(emp+'_'+date);
    let expected='absent';
    if(operation!=='create'){
      await dayRef.set({uid,emp_number:emp,date,month,status:'draft',day_type:'regular',start:'07:00',end:'07:00',sub_station:'',hours:24,
        legacy_unknown:{'a.b':{nested:[{items:[null,false,1.25,'עברית']}]}}});
      const at=(await dayRef.get()).updateTime;expected={seconds:at.seconds,nanoseconds:at.nanoseconds};
    }
    // Actual producer and native transactions; configuration/calculation ports
    // are synthetic here and have separate real-adapter tests.
    const service=createAttendanceCorrections({db,auth,HttpsError,serverTimestamp:()=>admin.firestore.FieldValue.serverTimestamp(),clock:()=>f.at,
      monthAt:()=>month,readConfig:async()=>({}),calculate:()=>({hours:24,day_type_he:'רגיל',site_name:'Synthetic site',reason_required:false})});
    const common={target_uid:uid,employee_number:emp,month,reason:'PRIVATE_CORRECTION_REASON detailed justification',request_id:'correction-001'};
    const data=operation==='recalculate'?{...common,days:[{date,expected_version:expected}]}:{...common,operation,date,expected_version:expected,
      ...(operation==='delete'?{}:{patch:{day_type:'regular',notes:'PRIVATE_CORRECTED_NOTES'}})};
    const invoke=()=>service[operation==='recalculate'?'correctMonthRecalc':'correctOneDay'](f.req('hr',data));
    const result=await invoke();return {result,emp,uid,month,date,dayRef,replay:invoke};
  };
  f.create = (id = 'create-001', extra = {}) => f.requests.create(f.req('owner', {
    request_id: id, subject: 'PRIVATE_CASE_SUBJECT', text: 'PRIVATE_CASE_BODY', send_now: false, ...extra }));
  f.action = (c, id, extra = {}) => ({ request_id: id, case_id: c.case_id, expected_revision: c.revision, send_now: false, ...extra });
  // Actual internal parent ports produce the event and durable job. This is
  // not an attachment upload/Storage fixture and does not claim byte delivery.
  f.attach = async (c, actor, label) => {
    const input = { ctx: identity.context(f.req(actor, {})), authTime, parent_kind: 'request', parent_id: c.case_id,
      expected_revision: c.revision, attachment_id: hash(['attachment', f.sid, label]), event_id: hash(['attachment-event', f.sid, label]) };
    const ports = f.requests.attachmentPorts;
    const result = await db.runTransaction(async tx => {
      const plan = await ports.prepare(tx, input);
      await ports.recheck(tx, plan);
      const out = ports.commit(tx, plan, { at: f.at });
      assert.ok(out && typeof out.then !== 'function', 'actual parent commit is synchronous/write-only');
      return out;
    });
    return { input, result, job: f.root.collection(collections.request).doc(input.event_id) };
  };
  f.publish = (id = 'publish-001', extra = {}) => f.documents.publish(f.req('hr', {
    request_id: id, kind: 'document', target_uid: f.people.owner.uid, title: 'PRIVATE_DOCUMENT_TITLE',
    text: 'PRIVATE_DOCUMENT_BODY', requires_ack: true, send_now: false, ...extra }));
  f.procedure = (id = 'procedure-001') => f.documents.publish(f.req('hr', {
    request_id: id, kind: 'procedure', title: 'PRIVATE_PROCEDURE_TITLE', text: 'PRIVATE_PROCEDURE_BODY', requires_ack: true, send_now: false }));
  f.revise = (d, id = 'revision-002') => f.documents.revise(f.req('hr', { request_id: id, document_id: d.document_id,
    expected_revision: d.current_revision, title: 'PRIVATE_NEW_TITLE', text: 'PRIVATE_NEW_BODY', requires_ack: true, send_now: false }));
  f.receipt = (d, id, revision = d.revision) => ({ request_id: id, document_id: d.document_id, revision });
  f.nudge = (d, id = 'nudge-001', actor = 'hr') => f.documents.nudge(f.req(actor, {
    ...f.receipt(d, id), target_uid: f.people.owner.uid, send_now: false }));
  f.jobs = family => root.collection(collections[family]).get();
  f.intents = () => root.collection('hr_domain_notification_intents').get();
  f.intent = async () => { const q = await f.intents(); assert.equal(q.size, 1); return q.docs[0]; };
  f.job = async family => { const q = await f.jobs(family); assert.equal(q.size, 1); return q.docs[0]; };
  f.tokens = (name, values) => root.collection('push_tokens').doc(f.people[name].uid).set({ tokens: values.map(token => ({ token })), prefs: { hr_private: false } });
  f.worker = ({ send = accepted, hooks = {}, database = db } = {}) => createHrDomainDispatch({ db: database, auth, HttpsError,
    clock: () => f.at, hooks, messaging: { async sendEachForMulticast(payload) { f.calls.push(payload); return send(payload); } } });
  f.generate = async (family, worker = f.worker()) => {
    const jobs = await f.jobs(family); assert.ok(jobs.size > 0);
    for (const d of jobs.docs) {
      for (let i = 0; i < 50; ++i) {
        const saved = (await d.ref.get()).data();
        if (!active.includes(saved.status)) break;
        const result = await worker.processJob({ stationId: sid, family, job_id: d.id });
        if (['deferred', 'blocked'].includes(result.status)) break;
        assert.ok(i < 49, 'bounded fixture generation must finish');
      }
    }
    assert.equal(f.calls.length, 0, 'processJob never invokes transport');
  };
  return f;
}
function failedRead(readPath, stagedWrite = false) {
  return { collectionGroup: db.collectionGroup.bind(db), collection: db.collection.bind(db), doc: db.doc.bind(db),
    runTransaction: fn => db.runTransaction(tx => fn(new Proxy(tx, { get(target, key) {
      if (key === 'get') return ref => ref.path === readPath ? Promise.reject(new Error('PRIVATE_IO_ERROR')) : target.get(ref);
      if (key === 'create' && stagedWrite) return (...args) => { target.create(...args); throw new Error('synthetic staged-write failure'); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }))) };
}
async function cleanup() {
  for (const root of roots.splice(0)) { assert.ok(root.id.startsWith('hr_domain_it_' + runId)); await db.recursiveDelete(root); assert.equal((await root.listCollections()).length, 0); }
  const refs = [...quotas.values()]; for (const ref of refs) await ref.delete();
  if (refs.length) assert.ok((await db.getAll(...refs)).every(d => !d.exists));
  quotas.clear(); records.clear();
}
const check = (name, fn) => tests.push({ name, fn });
const isDenied = e => e.terminal === true;
function noDirectArrayChild(value, arrayParent=false){
  if(Array.isArray(value)){assert.equal(arrayParent,false,'no direct nested Firestore array');value.forEach(v=>noDirectArrayChild(v,true));}
  else if(value&&typeof value==='object')Object.values(value).forEach(v=>noDirectArrayChild(v,false));
}
function decodeEvidence(value){
  if(value.type==='map')return Object.fromEntries(value.value.map(entry=>[entry.key,decodeEvidence(entry.value)]));
  if(value.type==='array')return value.value.map(decodeEvidence);
  return value.value;
}
async function bounded(promise, message) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 20000); })]); }
  finally { clearTimeout(timer); }
}

check('correction actual operations send one neutral private-free notification including self and district target',async()=>{
  for(const options of [{},{operation:'update'},{operation:'delete'},{operation:'recalculate'},{self:true},{role:'district_commander'}]){
    const f=await fixture(),r=await f.correct(options);await f.generate('correction');await f.worker().run();
    assert.equal(f.calls.length,1);const sent=f.calls[0];assert.deepEqual(sent.tokens,[f.people[options.self?'hr':'owner'].token]);
    assert.deepEqual(Object.keys(sent.data).sort(),['body','important','tag','title','url']);
    assert.equal(sent.data.title,'דיווח השעות שלך עודכן');assert.equal(sent.data.url,'./attendance.html');assert.equal(sent.data.important,'0');
    for(const secret of ['PRIVATE_',r.uid,r.emp,r.month,r.result.correction_id])assert.equal(JSON.stringify(sent.data).includes(secret),false);
    const job=await f.job('correction'),before=job.updateTime;await r.replay();await f.worker().run();
    assert.equal(f.calls.length,1);assert.equal((await job.ref.get()).updateTime.isEqual(before),true);
    assert.equal((await f.root.collection('attendance_correction_events').get()).size,1);
    assert.equal((await f.root.collection('attendance_correction_receipts').get()).size,1);
    const event=(await f.root.collection('attendance_correction_events').doc(r.result.correction_id).get()).data();
    assert.equal(event.evidence_encoding,'tagged-firestore-v2');noDirectArrayChild(event);
    if(options.operation&&options.operation!=='create'){
      const legacy={'a.b':{nested:[{items:[null,false,1.25,'עברית']}]}};
      assert.deepEqual(decodeEvidence(event.changes[0].before).legacy_unknown,legacy);
      if(options.operation!=='delete')assert.deepEqual(decodeEvidence(event.changes[0].after).legacy_unknown,legacy);
    }
  }
});
check('correction quiet resumes at morning while silent and unknown state never bypass policy',async()=>{
  for(const mode of ['quiet','silent','unknown']){
    const f=await fixture();if(mode==='quiet')f.at=Date.parse('2026-09-08T20:00:00Z');await f.correct();
    if(mode==='unknown')await runtime.delete();else await runtime.set({silent:mode==='silent',silent_allow:['hr_private']});
    if(mode==='unknown')await assert.rejects(f.generate('correction'));else await f.generate('correction');
    assert.equal((await f.job('correction')).data().status,mode==='quiet'?'deferred':mode==='silent'?'suppressed':'blocked');assert.equal(f.calls.length,0);
    if(mode==='quiet'){f.at=Date.parse('2026-09-09T05:00:00Z');await f.worker().run();assert.equal(f.calls.length,1);}
    await runtime.set({silent:false});
  }
});
check('correction source and receipt mutations cannot manufacture a valid historical notification',async()=>{
  for(const part of ['missing-event','missing-receipt','event-target','event-request','event-time','event-action','event-row','receipt-fingerprint','receipt-target','receipt-count','receipt-extra']){
    const f=await fixture(),r=await f.correct(),id=r.result.correction_id;
    const event=f.root.collection('attendance_correction_events').doc(id),receipt=f.root.collection('attendance_correction_receipts').doc(id);
    if(part==='missing-event')await event.delete();else if(part==='missing-receipt')await receipt.delete();
    else if(part==='event-target')await event.update({target_uid:f.people.other.uid});else if(part==='event-request')await event.update({request_id:'another-request'});
    else if(part==='event-time')await event.update({actor_auth_time:0});else if(part==='event-action')await event.update({operation:'approve'});
    else if(part==='event-row'){const e=(await event.get()).data();e.changes[0].record_id='other_'+r.date;await event.update({changes:e.changes});}
    else if(part==='receipt-fingerprint')await receipt.update({fingerprint:'a'.repeat(64)});else if(part==='receipt-target')await receipt.update({target_uid:f.people.other.uid});
    else if(part==='receipt-count')await receipt.update({changed_count:2});else await receipt.update({extra:true});
    await assert.rejects(f.generate('correction'),isDenied);assert.equal((await f.job('correction')).data().status,'cancelled');assert.equal(f.calls.length,0);
  }
});
check('correction job rejects foreign family fields and policy or identity substitution',async()=>{
  for(const patch of [{recipient_uid:'wrong'},{employee_number:'wrong'},{month:'2026-08'},{actor_auth_time:0},{created_at_ms:0},
    {case_id:'a'.repeat(64)},{document_id:'a'.repeat(64)},{reviewed_revision:'a'.repeat(64)},{type:'hr_reply'},{send_now:true},{exclude_actor:true}]){
    const f=await fixture();await f.correct();const j=await f.job('correction');await j.ref.update(patch);
    await assert.rejects(f.generate('correction'),isDenied);assert.equal((await j.ref.get()).data().status,'cancelled');assert.equal(f.calls.length,0);
  }
});
check('correction rechecks demotion revocation transfer and complete canonical bindings before claim',async()=>{
  for(const kind of ['actor-demotion','actor-revoked','local-inactive','local-uid','local-employee','local-alias','index','directory-uid','directory-employee','directory-inactive','target-auth']){
    const f=await fixture(),r=await f.correct();await f.generate('correction');
    if(kind==='actor-demotion')records.get(f.people.hr.uid).customClaims.role='firefighter';
    else if(kind==='actor-revoked')records.get(f.people.hr.uid).tokensValidAfterTime=new Date((authTime+1)*1000).toUTCString();
    else if(kind==='target-auth')records.get(r.uid).customClaims.stationId='other_station';
    else if(kind==='index')await db.doc('emp_index/'+r.emp).update({stationId:'other_station'});
    else if(kind.startsWith('directory'))await db.doc('directory/'+r.uid).update(kind==='directory-uid'?{uid:'other'}:kind==='directory-employee'?{employee_number:'other'}:{active:false});
    else await f.root.collection('users').doc(r.uid).update(kind==='local-inactive'?{active:false}:kind==='local-uid'?{uid:'other'}:kind==='local-employee'?{employee_number:'other'}:{station:'other_station'});
    await f.worker().run();assert.equal(f.calls.length,0);assert.equal((await f.intent()).data().status,'cancelled');
  }
});
check('correction final fences stop held actor or recipient changes without erasing prior evidence',async()=>{
  for(const stage of ['beforeJobWrites','beforeClaim'])for(const who of ['actor','recipient']){
    const f=await fixture(),r=await f.correct();if(stage==='beforeClaim')await f.generate('correction');
    const change=()=>{records.get(who==='actor'?f.people.hr.uid:r.uid).customClaims[who==='actor'?'role':'stationId']=who==='actor'?'firefighter':'other_station';};
    const worker=f.worker({hooks:{[stage]:change}});
    if(stage==='beforeJobWrites'&&who==='actor')await assert.rejects(f.generate('correction',worker),isDenied);
    else if(stage==='beforeJobWrites')await f.generate('correction',worker);else await worker.run();
    assert.equal(f.calls.length,0);assert.equal((await f.root.collection('attendance_correction_events').doc(r.result.correction_id).get()).exists,true);
    assert.equal((await f.root.collection('attendance_correction_receipts').doc(r.result.correction_id).get()).exists,true);
  }
});
check('correction evidence is historical and authorized replay never recreates a retired job',async()=>{
  const f=await fixture(),r=await f.correct();await r.dayRef.update({notes:'later correction'});await f.generate('correction');await f.worker().run();assert.equal(f.calls.length,1);
  await (await f.job('correction')).ref.delete();const result=await r.replay();assert.equal(result.duplicate,true);assert.equal((await f.jobs('correction')).size,0);await f.worker().run();assert.equal(f.calls.length,1);
});
check('original request document and review source digests retain exact pre-correction bytes',async()=>{
  const f=await fixture();await f.create();await f.publish();await f.review();
  for(const family of ['request','document','review']){
    await f.generate(family);const j=(await f.job(family)).data();
    const parts=[family,j.schema,j.event_id,j.station_id,j.actor_uid,j.actor_auth_time,j.case_id??null,j.document_id??null,j.revision??null,
      j.audience,j.recipient_uid??null,j.type,j.created_at_ms,j.send_now,j.consent_expires_at_ms,j.routine_after_quiet,j.exclude_actor];
    if(family==='review')parts.push(j.employee_number,j.month,j.reviewed_revision);
    assert.equal(j.source_digest,hash(parts));
  }
});

check('review actual producer sends neutral personal event once including self', async () => {
  for(const self of [false,true]){
    const f=await fixture(),r=await f.review(self);await f.generate('review');await f.worker().run();
    assert.equal(f.calls.length,1);const sent=f.calls[0];
    assert.deepEqual(sent.tokens,[f.people[self?'hr':'owner'].token]);
    assert.equal(sent.data.url,'./attendance.html');assert.equal(sent.data.title,'דוח השעות שלך נבדק במשאבי אנוש');
    for(const secret of [r.uid,r.emp,r.month,r.result.reviewed_revision])assert.equal(JSON.stringify(sent.data).includes(secret),false);
    await r.replay();await f.worker().run();assert.equal(f.calls.length,1);
  }
});
check('review silent suppresses, quiet defers and unknown runtime blocks without transport',async()=>{
  for(const mode of ['silent','quiet','unknown']){
    const f=await fixture();if(mode==='quiet')f.at=Date.parse('2026-09-08T20:00:00Z');
    await f.review();if(mode==='silent')await runtime.set({silent:true});else if(mode==='unknown')await runtime.delete();else await runtime.set({silent:false});
    if(mode==='unknown')await assert.rejects(f.generate('review'));else await f.generate('review');
    assert.equal(f.calls.length,0);const j=(await f.job('review')).data();
    assert.equal(j.status,mode==='silent'?'suppressed':mode==='quiet'?'deferred':'blocked');
    if(mode==='quiet'){f.at=Date.parse('2026-09-09T05:00:00Z');await f.worker().run();assert.equal(f.calls.length,1);}
    await runtime.set({silent:false});
  }
});
check('review immutable source corruption cancels before any delivery',async()=>{
  for(const patch of [{actor_auth_time:0},{created_at_ms:0},{recipient_uid:'wrong'},{employee_number:'wrong'},{month:'2026-08'},{reviewed_revision:'a'.repeat(64)},{case_id:'a'.repeat(64)},{exclude_actor:true},{send_now:true}]){
    const f=await fixture();await f.review();const job=await f.job('review');await job.ref.update(patch);
    await assert.rejects(f.generate('review'),isDenied);assert.equal((await job.ref.get()).data().status,'cancelled');assert.equal(f.calls.length,0);
  }
});
check('review rechecks actor and canonical recipient after enqueue',async()=>{
  for(const kind of ['actor','local','index','directory']){
    const f=await fixture(),r=await f.review();await f.generate('review');
    if(kind==='actor')records.get(f.people.hr.uid).customClaims.role='firefighter';
    if(kind==='local')await f.root.collection('users').doc(r.uid).update({employee_number:'changed'});
    if(kind==='index')await db.doc('emp_index/'+r.emp).update({stationId:'other'});
    if(kind==='directory')await db.doc('directory/'+r.uid).update({active:false});
    await f.worker().run();assert.equal(f.calls.length,0);assert.equal((await f.intent()).data().status,'cancelled');
  }
});
check('review historical event survives later hours changes but not recipient transfer at final claim',async()=>{
  const f=await fixture(),r=await f.review();await f.root.collection('monthly_reports').doc(r.emp+'_'+r.month).update({total_hours:1});
  await f.generate('review');await f.worker().run();assert.equal(f.calls.length,1);
  const g=await fixture(),s=await g.review();await g.generate('review');
  await g.worker({hooks:{beforeClaim(){records.get(s.uid).customClaims.stationId='other';}}}).run();
  assert.equal(g.calls.length,0);assert.equal((await g.intent()).data().status,'cancelled');
});

check('real request fanout uses current local HR and signed super, not commanders or global Auth discovery', async () => {
  const f = await fixture(); await f.add('localSuper', 'firefighter', true); await f.add('globalSuper', null, true, false);
  const c = await f.create(); const caseRef = f.root.collection('hr_requests').doc(c.case_id);
  const before = (await caseRef.get()).data(), eventsBefore = (await caseRef.collection('events').get()).docs.map(d => d.data());
  await f.generate('request'); const q = await f.intents(); assert.equal(q.size, 2);
  assert.deepEqual(q.docs.map(d => d.data().recipient_uid).sort(), [f.people.hr.uid, f.people.localSuper.uid].sort());
  const result = await f.worker().run(); assert.equal(result.transport_calls, 2); assert.equal(result.device_starts, 2);
  for (const p of f.calls) {
    assert.deepEqual(Object.keys(p.data).sort(), ['body', 'important', 'tag', 'title', 'url']);
    assert.equal(p.data.url, './hr-requests.html'); assert.equal(p.data.important, '0'); assert.equal(p.webpush.headers.Urgency, 'normal');
    assert.equal(JSON.stringify(p.data).includes('PRIVATE_'), false); assert.equal(Object.hasOwn(p, 'notification'), false);
  }
  assert.deepEqual((await caseRef.get()).data(), before); assert.deepEqual((await caseRef.collection('events').get()).docs.map(d => d.data()), eventsBefore);
  await f.worker().run(); assert.equal(f.calls.length, 2);
});
check('real targeted document identity, family-qualified intent and mandatory category preserve privacy', async () => {
  const f = await fixture(); await f.root.collection('users').doc(f.people.owner.uid).set({ station_id: f.sid, role: 'firefighter', is_active: true });
  await f.publish(); await f.generate('document'); const j = (await f.job('document')).data(), i = await f.intent();
  assert.equal(i.id, notificationIntent({ station_id: f.sid, recipient_uid: f.people.owner.uid, type: j.type, event_id: 'document:' + j.event_id }).id);
  assert.notEqual(i.id, notificationIntent({ station_id: f.sid, recipient_uid: f.people.owner.uid, type: j.type, event_id: 'request:' + j.event_id }).id);
  await f.worker().run(); const after = (await i.ref.get()).data();
  assert.equal(after.status, 'accepted'); assert.equal(after.delivery_status, 'provider_outcome_only'); assert.equal(after.transport_type, 'hr_private');
  assert.deepEqual(f.calls[0].tokens, [f.people.owner.token]); assert.equal(f.calls[0].data.url, './hr-documents.html');
  assert.equal(f.calls[0].data.tag, 'hr-domain-' + i.id); assert.equal(JSON.stringify(after).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(after).includes(f.people.owner.token), false);
});
check('attachment owner event preserves waiting_employee and routes a neutral update only to current HR', async () => {
  const f = await fixture(), c = await f.create();
  const waiting = await f.requests.setStatus(f.req('hr', f.action(c, 'attachment-waiting', { status: 'waiting_employee' })));
  await f.generate('request'); await f.worker().run(); f.calls.length = 0;
  const { input, result, job } = await f.attach({ ...c, revision: waiting.revision }, 'owner', 'owner-evidence');
  assert.equal(result.revision, waiting.revision + 1);
  const ref = f.root.collection('hr_requests').doc(c.case_id), parent = (await ref.get()).data();
  const event = (await ref.collection('events').doc(input.event_id).get()).data();
  assert.equal(parent.status, 'waiting_employee'); assert.deepEqual(parent.attachment_ids, [input.attachment_id]);
  assert.equal(event.kind, 'attachment'); assert.equal(event.attachment_id, input.attachment_id);
  const dto = await f.requests.get(f.req('owner', { case_id: c.case_id }));
  assert.equal(dto.status, 'waiting_employee'); assert.equal(dto.events.find(e => e.event_id === input.event_id).attachment_id, input.attachment_id);
  assert.equal((await job.get()).data().audience, 'station_hr');
  await f.generate('request'); await f.worker().run();
  const children = (await f.intents()).docs.filter(d => d.data().event_id === input.event_id);
  assert.equal(children.length, 1); assert.equal(children[0].data().recipient_uid, f.people.hr.uid); assert.equal(children[0].data().status, 'accepted');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].tokens, [f.people.hr.token]);
  assert.deepEqual(Object.keys(f.calls[0].data).sort(), ['body', 'important', 'tag', 'title', 'url']);
  assert.equal(f.calls[0].data.url, './hr-requests.html'); assert.equal(f.calls[0].data.important, '0');
  assert.equal(Object.hasOwn(f.calls[0], 'notification'), false);
  for (const secret of ['PRIVATE_', input.attachment_id, c.case_id, input.event_id]) assert.equal(JSON.stringify(f.calls[0].data).includes(secret), false);
  assert.deepEqual((await ref.get()).data(), parent); assert.deepEqual((await ref.collection('events').doc(input.event_id).get()).data(), event);
  await f.worker().run(); assert.equal(f.calls.length, 1, 'completed attachment job does not resend');
});
check('attachment nonowner HR event routes only to the case owner and retains the generic payload', async () => {
  const f = await fixture(), c = await f.create();
  await f.generate('request'); await f.worker().run(); f.calls.length = 0;
  const { input, job } = await f.attach(c, 'hr', 'hr-evidence');
  const produced = (await job.get()).data(); assert.equal(produced.type, 'hr_reply'); assert.equal(produced.audience, 'person');
  assert.equal(produced.recipient_uid, f.people.owner.uid); assert.equal(produced.actor_auth_time, authTime);
  await f.generate('request'); await f.worker().run();
  const children = (await f.intents()).docs.filter(d => d.data().event_id === input.event_id);
  assert.equal(children.length, 1); assert.equal(children[0].data().recipient_uid, f.people.owner.uid); assert.equal(children[0].data().status, 'accepted');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].tokens, [f.people.owner.token]);
  assert.deepEqual(Object.keys(f.calls[0].data).sort(), ['body', 'important', 'tag', 'title', 'url']);
  assert.equal(f.calls[0].data.url, './hr-requests.html'); assert.equal(f.calls[0].data.important, '0');
  for (const secret of ['PRIVATE_', input.attachment_id, c.case_id, input.event_id]) assert.equal(JSON.stringify(f.calls[0].data).includes(secret), false);
  assert.equal((await f.root.collection('hr_requests').doc(c.case_id).get()).data().status, 'open');
});
check('attachment malformed event identity fails closed before child creation or transport', async () => {
  for (const malformed of ['g'.repeat(64), ['a'.repeat(64)], null]) {
    const f = await fixture(), c = await f.create(), { input, job } = await f.attach(c, 'owner', 'corrupt-evidence');
    const ref = f.root.collection('hr_requests').doc(c.case_id), parent = (await ref.get()).data();
    await ref.collection('events').doc(input.event_id).update({ attachment_id: malformed });
    await assert.rejects(() => f.worker().processJob({ stationId: f.sid, family: 'request', job_id: input.event_id }), isDenied);
    assert.equal((await job.get()).data().status, 'cancelled'); assert.equal((await f.intents()).size, 0); assert.equal(f.calls.length, 0);
    assert.deepEqual((await ref.get()).data(), parent, 'rejecting a corrupt event does not mutate the business case');
  }
});
check('concurrent generation and SDK claim remain one deterministic child and one send', async () => {
  const f = await fixture(); await f.publish(); const j = await f.job('document'), w = f.worker(), input = { stationId: f.sid, family: 'document', job_id: j.id };
  await Promise.all([w.processJob(input), w.processJob(input)]); assert.equal((await f.intents()).size, 1);
  await Promise.all([w.run(), w.run()]); assert.equal(f.calls.length, 1); assert.equal((await f.intent()).data().status, 'accepted');
  assert.equal((await f.jobs('document')).size, 1);
});
check('routine request updates survive close while stale explicit nudge does not', async () => {
  const f = await fixture(), c = await f.create();
  const n = await f.requests.nudge(f.req('owner', f.action(c, 'owner-nudge')));
  await f.requests.setStatus(f.req('hr', f.action({ ...c, revision: n.revision }, 'close-case', { status: 'closed' })));
  await f.worker().run(); await f.worker().run();
  const jobs = (await f.jobs('request')).docs.map(d => d.data()); assert.equal(jobs.length, 3);
  assert.equal(jobs.find(j => j.type === 'hr_nudge').status, 'cancelled');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.flatMap(p => p.tokens).sort(), [f.people.owner.token, f.people.hr.token].sort());
});
check('old document revision stays a neutral event and opened/ack do not create jobs', async () => {
  const f = await fixture(), d = await f.publish(), newer = await f.revise(d);
  await f.documents.markOpened(f.req('owner', f.receipt(newer, 'opened-new')));
  await f.documents.acknowledge(f.req('owner', f.receipt(newer, 'acknowledge-new')));
  assert.equal((await f.jobs('document')).size, 2); await f.generate('document'); await f.worker().run(); assert.equal(f.calls.length, 2);
  assert.equal((await f.intents()).docs.filter(x => x.data().status === 'accepted').length, 2);
});
check('document nudge uses current outstanding receipt and accepts another current HR author', async () => {
  const f = await fixture(), d = await f.publish(); await f.add('hr2', 'hr_coordinator');
  await f.documents.markOpened(f.req('owner', f.receipt(d, 'opened-only'))); await f.nudge(d, 'second-hr-nudge', 'hr2');
  await f.generate('document'); await f.worker().run(); assert.equal(f.calls.length, 2, 'opened alone does not satisfy required ack');
  await f.nudge(d, 'before-ack-nudge'); await f.documents.acknowledge(f.req('owner', f.receipt(d, 'ack-after-nudge')));
  await f.worker().run(); assert.equal(f.calls.length, 2); assert.ok((await f.jobs('document')).docs.some(x => x.data().status === 'no_recipient'));
  const g = await fixture(), plain = await g.publish('without-ack', { requires_ack: false }); await g.nudge(plain);
  await g.documents.markOpened(g.req('owner', g.receipt(plain, 'plain-opened'))); await g.generate('document'); await g.worker().run();
  assert.equal(g.calls.length, 1, 'only ordinary event survives opening when ack is not required');
});
check('source actor/audience/revision tampering fails closed before transport', async () => {
  for (const change of [{ audience: 'station_members' }, { actor_uid: 'arbitrary_uid' }, { revision: 999 }]) {
    const f = await fixture(); await f.publish(); const j = await f.job('document'); await j.ref.update(change);
    await assert.rejects(() => f.worker().processJob({ stationId: f.sid, family: 'document', job_id: j.id }), isDenied);
    assert.equal((await j.ref.get()).data().status, 'cancelled'); assert.equal((await f.intents()).size, 0); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(), c = await f.create(), j = await f.job('request');
  await f.root.collection('hr_requests').doc(c.case_id).collection('events').doc(j.id).update({ actor_uid: f.people.hr.uid });
  await f.worker().run(); assert.equal((await j.ref.get()).data().status, 'cancelled'); assert.equal(f.calls.length, 0);
});
check('fresh original actor revocation/disable/station/role and malformed marker prevent sending', async () => {
  const updates = [{ disabled: true }, { tokensValidAfterTime: new Date((authTime + 1) * 1000).toUTCString() },
    { customClaims: { stationId: 'elsewhere', role: 'hr_coordinator' } }, { customClaims: { role: 'firefighter' } }, { tokensValidAfterTime: null }];
  for (const update of updates) {
    const f = await fixture(); await f.publish(); await f.generate('document');
    const actualUpdate = update.customClaims && !update.customClaims.stationId
      ? { ...update, customClaims: { stationId: f.sid, ...update.customClaims } } : update;
    records.set(f.people.hr.uid, { ...records.get(f.people.hr.uid), ...actualUpdate }); await f.worker().run();
    assert.equal(f.calls.length, 0); assert.ok(['cancelled', 'blocked'].includes((await f.intent()).data().status));
  }
});
check('live recipient disabled/moved/profile and HR audience downgrade are rechecked at claim', async () => {
  for (const mode of ['disabled', 'moved', 'inactive']) {
    const f = await fixture(); await f.publish(); await f.generate('document');
    if (mode === 'disabled') records.get(f.people.owner.uid).disabled = true;
    if (mode === 'moved') records.get(f.people.owner.uid).customClaims.stationId = 'elsewhere';
    if (mode === 'inactive') await f.root.collection('users').doc(f.people.owner.uid).update({ active: false });
    await f.worker().run(); assert.equal(f.calls.length, 0); assert.equal((await f.intent()).data().status, 'cancelled');
  }
  const f = await fixture(); await f.create(); await f.generate('request');
  records.get(f.people.hr.uid).customClaims.role = 'firefighter'; await f.root.collection('users').doc(f.people.hr.uid).update({ role: 'firefighter' });
  await f.worker().run(); assert.equal(f.calls.length, 0); assert.equal((await f.intent()).data().status, 'cancelled');
});
check('successful empty HR scan is no_recipient, not a swallowed Auth or DB failure', async () => {
  const f = await fixture(); await f.root.collection('users').doc(f.people.hr.uid).update({ active: false }); await f.create();
  await f.generate('request'); assert.equal((await f.job('request')).data().status, 'no_recipient'); assert.equal((await f.intents()).size, 0);
  const g = await fixture(); await g.create(); const j = await g.job('request'), w = g.worker();
  await w.processJob({ stationId: g.sid, family: 'request', job_id: j.id });
  const before = (await j.ref.get()).data(), saved = records.get(g.people.hr.uid); records.set(g.people.hr.uid, new Error('PRIVATE_AUTH_OUTAGE'));
  await assert.rejects(() => w.processJob({ stationId: g.sid, family: 'request', job_id: j.id }));
  const after = (await j.ref.get()).data(); assert.equal(after.status, 'blocked'); assert.equal(after.cursor, before.cursor); assert.deepEqual(after.counts, before.counts);
  assert.equal((await g.intents()).size, 0); records.set(g.people.hr.uid, saved); g.at = after.next_check_ms;
  await g.generate('request'); assert.equal((await g.intents()).size, 1);
});
check('final recipient eligibility loss skips only that candidate rather than cancelling a whole fanout', async () => {
  const f = await fixture(); await f.add('hr2', 'hr_coordinator'); await f.create();
  const j = await f.job('request'), input = { stationId: f.sid, family: 'request', job_id: j.id };
  await f.worker().processJob(input);
  const w = f.worker({ hooks: { beforeJobWrites({ phase }) { if (phase === 'enqueue') records.get(f.people.hr.uid).disabled = true; } } });
  const result = await w.processJob(input); assert.equal(result.status, 'completed');
  const q = await f.intents(); assert.equal(q.size, 1); assert.equal(q.docs[0].data().recipient_uid, f.people.hr2.uid);
  assert.equal(result.counts.eligible, 1); assert.equal(result.counts.intents, 1);
});
check('I/O rejection and staged transaction crash do not advance cursor or partly create intents', async () => {
  const f = await fixture(); await f.procedure(); const j = await f.job('document'), input = { stationId: f.sid, family: 'document', job_id: j.id };
  await f.worker().processJob(input); const before = (await j.ref.get()).data();
  const bad = f.worker({ database: failedRead(f.root.path + '/users/' + f.people.owner.uid) });
  await assert.rejects(() => bad.processJob(input)); let after = (await j.ref.get()).data();
  assert.equal(after.status, 'blocked'); assert.equal(after.cursor, before.cursor); assert.deepEqual(after.counts, before.counts); assert.equal((await f.intents()).size, 0);
  f.at = after.next_check_ms; await assert.rejects(() => f.worker({ database: failedRead(null, true) }).processJob(input));
  after = (await j.ref.get()).data(); assert.equal(after.cursor, before.cursor); assert.deepEqual(after.counts, before.counts); assert.equal((await f.intents()).size, 0);
  f.at = after.next_check_ms; await f.worker().processJob(input); assert.equal((await f.intents()).size, 3);
});
check('routine night queue survives until morning; original TTL and expired consent never extend', async () => {
  const f = await fixture(); f.at = Date.parse('2026-09-08T20:00:00Z'); await f.publish(); const created = f.at;
  await f.worker().run(); let j = (await f.job('document')).data(); assert.equal(j.status, 'deferred'); assert.equal(j.expires_at_ms, created + LIMITS.routineMs);
  assert.equal((await f.intents()).size, 0); assert.equal(f.calls.length, 0); f.at = j.not_before_ms;
  await f.worker().run(); assert.equal(f.calls.length, 1);
  const g = await fixture(); g.at = Date.parse('2026-09-08T19:10:00Z'); await g.publish('consented-001', { send_now: true });
  const start = g.at; g.at += LIMITS.consentMs; await g.worker().run(); j = (await g.job('document')).data();
  assert.equal(j.status, 'deferred'); assert.equal(j.expires_at_ms, start + LIMITS.routineMs); assert.equal(g.calls.length, 0);
  g.at = start + LIMITS.routineMs; await g.worker().run(); assert.equal((await g.job('document')).data().status, 'expired');
});
check('uninitialized old job is discovered through created_at and nudge expiry remains one hour', async () => {
  const f = await fixture(), d = await f.publish(); await f.nudge(d); const jobs = (await f.jobs('document')).docs;
  for (const j of jobs) assert.equal(Object.hasOwn(j.data(), 'updated_at_ms'), false);
  f.at += LIMITS.nudgeMs; await f.worker().run();
  const saved = (await f.jobs('document')).docs.map(d => d.data()); assert.equal(saved.find(j => j.type === 'hr_nudge').status, 'expired');
  assert.equal(f.calls.length, 1); assert.equal(saved.find(j => j.type === 'hr_document').expires_at_ms, jobs.find(j => j.data().type === 'hr_document').data().created_at_ms + LIMITS.routineMs);
});
check('fresh global silence has no allowlist or send_now bypass, and existing suppression never replays', async () => {
  const f = await fixture(), d = await f.publish('confirmed-001', { send_now: true }); await f.generate('document');
  await runtime.set({ silent: true, silent_allow: [f.people.owner.uid] }); await f.worker().run();
  assert.equal(f.calls.length, 0); assert.equal((await f.intent()).data().status, 'suppressed');
  await f.documents.nudge(f.req('hr', { ...f.receipt(d, 'producer-suppressed'), target_uid: f.people.owner.uid, send_now: true }));
  assert.ok((await f.jobs('document')).docs.some(j => j.data().type === 'hr_nudge' && j.data().status === 'suppressed'));
  await runtime.set({ silent: false, silent_allow: [] }); await f.worker().run(); assert.equal(f.calls.length, 0);
});
check('final claim time crossing quiet defers; afterClaim known-unstarted routine also defers safely', async () => {
  for (const hookName of ['beforeClaim', 'afterClaim']) {
    const f = await fixture(); f.at = Date.parse('2026-09-08T18:59:59Z'); await f.publish(); await f.generate('document');
    await f.worker({ hooks: { [hookName]() { f.at = Date.parse('2026-09-08T19:00:01Z'); } } }).run();
    let i = (await f.intent()).data(); assert.equal(i.status, 'deferred', hookName + ' must preserve routine update'); assert.equal(f.calls.length, 0);
    assert.ok(i.not_before_ms > f.at); f.at = i.not_before_ms; await f.worker().run(); assert.equal(f.calls.length, 1);
    i = (await f.intent()).data(); assert.equal(i.status, 'accepted');
  }
});
check('final job clock expiry does not create children and afterClaim expiry never starts SDK', async () => {
  const f = await fixture(); await f.publish(); const start = f.at;
  await f.worker({ hooks: { beforeJobWrites() { f.at = start + LIMITS.routineMs; } } }).run();
  assert.equal((await f.job('document')).data().status, 'expired'); assert.equal((await f.intents()).size, 0);
  const g = await fixture(); await g.publish(); await g.generate('document'); const created = g.at;
  await g.worker({ hooks: { afterClaim() { g.at = created + LIMITS.routineMs; } } }).run();
  assert.equal(g.calls.length, 0); assert.equal((await g.intent()).data().status, 'cancelled');
});
check('bounded discovery freezes observed ID maximum, never creates children before enqueue', async () => {
  const f = await fixture(); for (let i = 0; i < 24; ++i) await f.add('member' + String(i).padStart(2, '0'));
  await f.procedure(); const j = await f.job('document'), input = { stationId: f.sid, family: 'document', job_id: j.id }, w = f.worker();
  let result = await w.processJob(input); assert.equal(result.discovery_scanned, 25); assert.equal(result.phase, 'discover'); assert.equal((await f.intents()).size, 0);
  result = await w.processJob(input); assert.equal(result.discovery_scanned, 28); assert.equal(result.phase, 'enqueue'); assert.equal((await f.intents()).size, 0);
  const max = (await j.ref.get()).data().max_uid; await f.add('zzzz-late'); assert.ok(f.people['zzzz-late'].uid > max);
  await f.generate('document'); const q = await f.intents(); assert.equal(q.size, 27); assert.equal(q.docs.some(d => d.data().recipient_uid === f.people['zzzz-late'].uid), false);
  assert.equal((await j.ref.get()).data().max_uid, max); assert.equal((await j.ref.get()).data().counts.scanned, 28);
});
check('failed initial heads back off so the healthy 26th source can progress', async () => {
  const f = await fixture();
  const healthyCase = await f.requests.create(f.req('other', { request_id: 'healthy-case', subject: 'PRIVATE_HEALTHY_CASE', text: 'PRIVATE_HEALTHY_BODY', send_now: false }));
  await f.generate('request'); await f.worker().run(); assert.equal(f.calls.length, 1);
  for (let i = 0; i < 25; ++i) { await f.create('head-' + String(i).padStart(4, '0')); f.at += 60001; }
  await f.requests.reply(f.req('hr', f.action(healthyCase, 'healthy-reply', { text: 'PRIVATE_HEALTHY_REPLY' })));
  const first = await f.root.collection('hr_request_notification_jobs').where('status', '==', 'policy_pending').orderBy('created_at_ms').limit(25).get();
  assert.equal(first.size, 25); assert.ok(first.docs.every(j => j.data().actor_uid === f.people.owner.uid));
  records.set(f.people.owner.uid, new Error('PRIVATE_AUTH_OUTAGE'));
  for (let i = 0; i < 4; ++i) { const r = await f.worker().run(); assert.ok(r.job_pages <= 25); f.at += 1; }
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1].tokens, [f.people.other.token]);
  const failing = (await f.jobs('request')).docs.filter(d => d.data().actor_uid === f.people.owner.uid);
  assert.equal(failing.length, 25); assert.ok(failing.every(d => ['policy_pending', 'blocked'].includes(d.data().status)));
});
check('missing device is terminal and malformed runtime/token I/O blocks without pretending success', async () => {
  const f = await fixture(); await f.tokens('owner', []); await f.publish(); await f.generate('document'); await f.worker().run();
  assert.equal((await f.intent()).data().status, 'no_device'); await f.tokens('owner', ['later-token']); await f.worker().run(); assert.equal(f.calls.length, 0);
  const g = await fixture(); await g.publish(); await g.generate('document'); await runtime.set({ silent: 'false' }); await g.worker().run();
  let i = (await g.intent()).data(); assert.equal(i.status, 'blocked'); assert.equal(g.calls.length, 0); await runtime.set({ silent: false }); g.at = i.next_check_ms;
  await g.worker({ database: failedRead(g.root.path + '/push_tokens/' + g.people.owner.uid) }).run();
  i = (await g.intent()).data(); assert.equal(i.status, 'blocked'); assert.equal(i.dispatch_check_count, 2); g.at = i.next_check_ms;
  await g.root.collection('push_tokens').doc(g.people.owner.uid).set({ tokens: ['not-an-object'] }); await g.worker().run();
  i = (await g.intent()).data(); assert.equal(i.status, 'blocked'); assert.equal(g.calls.length, 0);
});
check('device budget is total, deduplicates per recipient and never slices a recipient', async () => {
  const f = await fixture(); await f.publish('owner-document'); await f.publish('other-document', { target_uid: f.people.other.uid });
  await f.tokens('owner', Array.from({ length: 300 }, (_, i) => 'a-' + i)); await f.tokens('other', Array.from({ length: 250 }, (_, i) => 'b-' + i));
  await f.generate('document'); const first = await f.worker().run(); assert.ok([250, 300].includes(first.device_starts)); assert.equal(f.calls.length, 1);
  assert.equal((await f.intents()).docs.filter(d => d.data().status === 'queued').length, 1); await f.worker().run(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls.reduce((n, p) => n + p.tokens.length, 0), 550);
  const g = await fixture(); await g.publish(); await g.tokens('owner', ['same', 'same']); await g.generate('document'); await g.worker().run(); assert.deepEqual(g.calls[0].tokens, ['same']);
  const h = await fixture(); await h.publish(); await h.tokens('owner', Array.from({ length: 501 }, (_, i) => 'large-' + i)); await h.generate('document'); await h.worker().run();
  const v = (await h.intent()).data(); assert.equal(v.status, 'blocked'); assert.equal(v.reason, 'token-limit'); assert.equal(v.terminal, true); assert.equal(h.calls.length, 0);
});
check('ten concurrent recipients and 250 checked intents are hard invocation caps', async () => {
  const f = await fixture(); for (let i = 0; i < 277; ++i) await f.add('fan' + i); await f.procedure(); await f.generate('document');
   assert.equal((await f.intents()).size, 280); let running = 0, peak = 0, entered, release, hold = true;
  const atTen = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const w = f.worker({ send: async p => { ++running; peak = Math.max(peak, running); if (running === 10) entered(); if (hold) await barrier; --running; return accepted(p); } });
  const execution = w.run();
  try { await bounded(atTen, 'ten synthetic sends were not entered'); assert.equal(f.calls.length, 10); }
  finally { hold = false; release(); }
  const result = await execution; assert.equal(peak, 10); assert.equal(result.intents_checked, 250); assert.equal(f.calls.length, 250);
  await w.run(); assert.equal(f.calls.length, 280);
});
check('60 second start budget stops new work; page checks remain bounded', async () => {
  const f = await fixture(); for (let i = 0; i < 6; ++i) await f.add('budget' + i); await f.procedure(); await f.generate('document');
  const r = await f.worker({ send: p => { f.at += LIMITS.startBudgetMs; return accepted(p); } }).run();
  assert.ok(f.calls.length >= 1 && f.calls.length <= 5); assert.ok(r.job_pages <= 25); assert.ok(r.device_starts <= 500);
  assert.ok((await f.intents()).docs.some(d => ['queued', 'cancelled'].includes(d.data().status)));
});
check('fulfilled mixed batch preserves accepted/definite failure/network unknown without token or error leaks', async () => {
  const f = await fixture(); await f.publish(); await f.tokens('owner', ['tok-a', 'tok-b', 'tok-c']); await f.generate('document');
  await f.worker({ send: () => ({ responses: [{ success: true, messageId: 'ok' },
    { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'PRIVATE_TOKEN_ERROR' } },
    { success: false, error: { code: 'app/network-error', message: 'PRIVATE_NETWORK_ERROR' } }] }) }).run();
  const i = (await f.intent()).data(); assert.equal(i.status, 'outcome_unknown'); assert.deepEqual(i.outcome_counts, { accepted: 1, failed: 1, outcome_unknown: 1 });
  assert.equal(i.device_outcomes.length, 3); assert.equal(JSON.stringify(i).includes('PRIVATE_'), false); assert.equal(JSON.stringify(i).includes('tok-'), false);
  await f.worker().run(); assert.equal(f.calls.length, 1);
});
check('throw and malformed final response are unknown with no application resend', async () => {
  for (const send of [() => { throw new Error('PRIVATE_THROW'); }, () => ({ responses: [] })]) {
    const f = await fixture(); await f.publish(); await f.generate('document'); await f.worker({ send }).run();
    assert.equal((await f.intent()).data().status, 'outcome_unknown'); await f.worker().run(); assert.equal(f.calls.length, 1);
  }
});
check('crash before SDK and after SDK never turn expired attempting into a fresh send', async () => {
  for (const name of ['afterClaim', 'afterSend']) {
    const f = await fixture(); await f.publish(); await f.generate('document'); await f.worker({ hooks: { [name]() { throw new Error('synthetic crash'); } } }).run();
    assert.equal((await f.intent()).data().status, 'attempting'); const calls = name === 'afterClaim' ? 0 : 1; assert.equal(f.calls.length, calls);
    f.at += LIMITS.leaseMs; await f.worker().run(); assert.equal((await f.intent()).data().status, 'outcome_unknown'); assert.equal(f.calls.length, calls);
  }
});
check('late SDK callback cannot overwrite lease unknown or a different attempt token', async () => {
  const f = await fixture(); await f.publish(); await f.generate('document'); let release, entered;
  const atSend = new Promise(resolve => { entered = resolve; });
  const execution = f.worker({ send: p => new Promise(resolve => { release = () => resolve(accepted(p)); entered(); }) }).run();
  try { await bounded(atSend, 'synthetic SDK was not entered'); f.at += LIMITS.leaseMs; await f.worker().run(); assert.equal((await f.intent()).data().status, 'outcome_unknown'); }
  finally { if (release) release(); }
  await execution; assert.equal((await f.intent()).data().status, 'outcome_unknown'); assert.equal(f.calls.length, 1);
  const g = await fixture(); await g.publish(); await g.generate('document');
  await g.worker({ hooks: { async afterSend({ path: p }) { await db.doc(p).update({ status: 'outcome_unknown', attempt_id: 'newer-attempt' }); } } }).run();
  const i = (await g.intent()).data(); assert.equal(i.status, 'outcome_unknown'); assert.equal(i.attempt_id, 'newer-attempt');
});
check('dispatch never deletes or overwrites concurrently registered device tokens', async () => {
  const f = await fixture(); await f.publish(); await f.generate('document');
  await f.worker({ send: async () => { await f.tokens('owner', ['new-token', f.people.owner.token]); return { responses: [
    { success: false, error: { code: 'messaging/registration-token-not-registered' } }] }; } }).run();
  assert.equal((await f.intent()).data().status, 'failed');
  assert.deepEqual((await f.root.collection('push_tokens').doc(f.people.owner.uid).get()).data().tokens.map(t => t.token), ['new-token', f.people.owner.token]);
});

(async () => {
  const filter = process.env.HR_DOMAIN_TEST_FILTER || '', selected = tests.filter(t => !filter || t.name.includes(filter));
  assert.ok(selected.length, 'filter must select a test');
  try {
    priorRuntime = await runtime.get(); console.log(JSON.stringify({ run: runId, source_hashes: beforeHashes, selected: selected.length, prior_runtime: priorRuntime.exists ? priorRuntime.data() : null }));
    for (let n = 0; n < selected.length; ++n) {
      const { name, fn } = selected[n]; await runtime.set({ silent: false, silent_allow: [] });
      try { await fn(); ++passed; console.log('PASS ' + name); }
      catch (e) { console.error('FAIL ' + name); for (const t of selected.slice(n + 1)) console.log('NOT RUN ' + t.name); throw e; }
      finally { await cleanup(); }
    }
    console.log('HR domain dispatcher integration: ' + passed + '/' + selected.length + ' PASS; scope=' + (filter || 'all') + '; actual producers/Firestore, synthetic Auth/FCM only.');
  } finally {
    await cleanup();
    if (priorRuntime) { if (priorRuntime.exists) await runtime.set(priorRuntime.data()); else await runtime.delete(); }
    const restored = await runtime.get();
    console.log(JSON.stringify({ cleanup_complete: true, runtime_restored: priorRuntime ? restored.exists === priorRuntime.exists && JSON.stringify(restored.data()) === JSON.stringify(priorRuntime.data()) : null }));
    const after = sourceHashes(); assert.deepEqual(after, beforeHashes, 'product sources stayed frozen');
    console.log(JSON.stringify({ source_hashes_unchanged: true, source_hashes: after }));
    await app.delete();
  }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
