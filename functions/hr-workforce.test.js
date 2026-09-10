'use strict';
const assert = require('node:assert/strict');
const { createFakeFirestore } = require('./fixtures/fake-firestore');
const { createHrWorkforce } = require('./hr-workforce');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const at = Date.parse('2026-09-10T10:00:00Z'), sid = 'station_test';
const users = new Map();
const auth = { async getUser(uid) { const v = users.get(uid); if (!v) throw Object.assign(Error('missing'), { code: 'auth/user-not-found' }); return structuredClone(v); } };
const claims = (role, superUser = false) => ({ stationId: sid, ...(superUser ? { super: true } : { role }) });
function fixture(clockAt = at) {
  users.clear(); const seed = {};
  for (const [uid, role] of [['hr','hr_coordinator'],['ff','firefighter'],['cmd','station_commander']]) {
    users.set(uid, { uid, disabled: false, customClaims: claims(role), tokensValidAfterTime: new Date(at - 1000).toUTCString() });
    seed[`stations/${sid}/users/${uid}`] = { stationId: sid, role, active: true,
      employee_number: uid + '-1', full_name: 'עובד ' + uid };
  }
  users.set('super', { uid:'super', disabled:false, customClaims:claims(null,true), tokensValidAfterTime:new Date(at-1000).toUTCString() });
  const db = createFakeFirestore(seed), service = createHrWorkforce({ db, auth, HttpsError, clock: () => clockAt });
  const req = (uid, data) => ({ auth:{ uid, token:{ ...users.get(uid).customClaims, auth_time:at/1000 } }, data });
  const body = (id='request-001') => ({ request_id:id, subject_uid:'ff', kind:'long_absence', start_date:'2026-09-01',
    end_date:null, followup_date:'2026-09-10', reason:'מעקב פרטי', status:'active' });
  return { db, service, req, body };
}
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code);
(async () => {
  let passed = 0; const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
  await check('only live HR and signed super can create', async () => {
    const f=fixture(); for(const uid of ['ff','cmd']) await rejects(()=>f.service.create(f.req(uid,f.body())), 'permission-denied');
    assert.equal((await f.service.create(f.req('hr',f.body()))).revision,1);
    assert.equal((await fixture().service.create(fixture().req('super',fixture().body()))).revision,1);
  });
  await check('canonical active station subject is mandatory', async () => {
    const f=fixture(); users.get('ff').disabled=true; await rejects(()=>f.service.create(f.req('hr',f.body())), 'permission-denied');
    users.get('ff').disabled=false; f.db.write(`stations/${sid}/users/ff`,{stationId:'other',role:'firefighter',active:true});
    await rejects(()=>f.service.create(f.req('hr',f.body('request-002'))), 'permission-denied');
  });
  await check('dates, type, status and reason are closed and validated', async () => {
    const f=fixture();
    for(const patch of [{start_date:'bad'},{kind:'sick'},{status:'draft'},{reason:''},{kind:'abroad_leave',end_date:null},{status:'closed',end_date:null},{end_date:'2026-08-31'}])
      await rejects(()=>f.service.create(f.req('hr',{...f.body(),...patch})), 'invalid-argument');
  });
  await check('exact replay is idempotent and changed payload collides', async () => {
    const f=fixture(), req=f.req('hr',f.body()), a=await f.service.create(req), b=await f.service.create(req);
    assert.equal(a.record_id,b.record_id); assert.equal(b.duplicate,true);
    await rejects(()=>f.service.create(f.req('hr',{...f.body(),reason:'אחר'})), 'already-exists');
    assert.equal(f.db.keys().filter(k=>k.includes('/events/')).length,1);
  });
  await check('update is CAS and immutable audit contains full before/after actor evidence', async () => {
    const f=fixture(), made=await f.service.create(f.req('hr',f.body()));
    const update={...f.body('request-002'),record_id:made.record_id,expected_revision:1,end_date:'2026-09-20',status:'closed'};
    const out=await f.service.update(f.req('hr',update)); assert.equal(out.revision,2);
    await rejects(()=>f.service.update(f.req('hr',{...update,request_id:'request-003'})), 'aborted');
    const events=f.db.keys().filter(k=>k.includes('/events/')).map(k=>f.db.read(k)); assert.equal(events.length,2);
    const e=events.find(x=>x.kind==='update'); assert.equal(e.actor_uid,'hr'); assert.equal(e.actor_role,'hr_coordinator');
    assert.equal(e.before.revision,1); assert.equal(e.after.revision,2); assert.equal(e.reason,'מעקב פרטי');
  });
  await check('due reminder is intent-only and contains no sensitive fields', async () => {
    const f=fixture(), made=await f.service.create(f.req('hr',f.body()));
    const data={request_id:'reminder-001',record_id:made.record_id,expected_revision:1};
    const a=await f.service.queueReminder(f.req('hr',data)), b=await f.service.queueReminder(f.req('hr',data)); assert.equal(b.duplicate,true);
    const job=f.db.keys().map(k=>f.db.read(k)).find(v=>v?.schema==='hr-workforce-notification-v1');
    assert.deepEqual(Object.keys(job).sort(),['actor_auth_time','actor_uid','audience','consent_expires_at_ms','created_at_ms',
      'delivery_status','event_id','exclude_actor','neutral','record_id','routine_after_quiet','schema','send_now','station_id','status','type'].sort());
    assert.equal(JSON.stringify(job).includes('מעקב'),false); assert.equal(a.notification_status,'intent_only');
    const other=await f.service.queueReminder(f.req('hr',{...data,request_id:'reminder-002'})); assert.equal(other.duplicate,true);
    assert.equal(f.db.keys().filter(k=>k.includes('hr_workforce_notification_jobs')).length,1);
  });
  await check('future, closed and stale reminders fail without job', async () => {
    for(const patch of [{followup_date:'2026-09-11'},{end_date:'2026-09-10',status:'closed'}]){
      const f=fixture(); let made=await f.service.create(f.req('hr',patch.status?f.body():{...f.body(),...patch}));
      if(patch.status) made=await f.service.update(f.req('hr',{...f.body('request-002'),...patch,record_id:made.record_id,expected_revision:1}));
      await rejects(()=>f.service.queueReminder(f.req('hr',{request_id:'reminder-001',record_id:made.record_id,expected_revision:made.revision})), patch.status?'aborted':'failed-precondition');
      assert.equal(f.db.keys().some(k=>k.includes('hr_workforce_notification_jobs')),false);
    }
  });
  await check('reminder due day follows Jerusalem across summer and winter UTC boundaries', async () => {
    for (const [clockAt, followup] of [
      [Date.parse('2026-09-10T21:30:00Z'), '2026-09-11'],
      [Date.parse('2026-12-10T22:30:00Z'), '2026-12-11']
    ]) {
      const f=fixture(clockAt), made=await f.service.create(f.req('hr',{...f.body(),followup_date:followup}));
      const out=await f.service.queueReminder(f.req('hr',{request_id:'reminder-001',record_id:made.record_id,expected_revision:1}));
      assert.equal(out.notification_status,'intent_only');
    }
  });
  await check('canonical employee number is preserved through 64 characters and never truncated', async () => {
    const f=fixture(), exact='e'.repeat(64);
    f.db.write(`stations/${sid}/users/ff`,{stationId:sid,role:'firefighter',active:true,employee_number:exact,full_name:'עובד ff'});
    const made=await f.service.create(f.req('hr',f.body()));
    assert.equal(f.db.read(`stations/${sid}/hr_workforce_cases/${made.record_id}`).subject_employee_number,exact);
    const g=fixture();g.db.write(`stations/${sid}/users/ff`,{stationId:sid,role:'firefighter',active:true,employee_number:'e'.repeat(65),full_name:'עובד ff'});
    await rejects(()=>g.service.create(g.req('hr',g.body())),'failed-precondition');
  });
  await check('revoked actor fails before mutation', async () => {
    const f=fixture(); users.get('hr').tokensValidAfterTime=new Date(at+1000).toUTCString();
    await rejects(()=>f.service.create(f.req('hr',f.body())), 'permission-denied'); assert.equal(f.db.keys().some(k=>k.includes('hr_workforce_cases')),false);
  });
  await check('role change at the pre-write fence commits nothing', async () => {
    const f=fixture(), service=createHrWorkforce({db:f.db,auth,HttpsError,clock:()=>at,hooks:{beforeWrites(){users.get('hr').customClaims.role='firefighter';}}});
    await rejects(()=>service.create(f.req('hr',f.body())),'permission-denied');
    assert.equal(f.db.keys().some(k=>k.includes('hr_workforce_cases')),false);
  });
  await check('actor quota bounds new case mutations while exact replay stays free', async () => {
    const f=fixture();for(let i=0;i<10;i++)await f.service.create(f.req('hr',f.body('request-'+String(i).padStart(3,'0'))));
    await f.service.create(f.req('hr',f.body('request-000')));
    await rejects(()=>f.service.create(f.req('hr',f.body('request-999'))),'resource-exhausted');
  });
  await check('paged list is bounded and reauthorizes immediately before return', async () => {
    users.clear(); users.set('hr',{uid:'hr',disabled:false,customClaims:claims('hr_coordinator'),tokensValidAfterTime:new Date(at-1000).toUTCString()});
    const records=Array.from({length:26},(_,i)=>{const id=String(i).padStart(64,'0');return {id,data:{schema:'hr-workforce-case-v1',record_id:id,station_id:sid,subject_uid:'ff',subject_employee_number:'ff-1',subject_full_name:'עובד ff',kind:'long_absence',start_date:'2026-09-01',end_date:null,followup_date:'2026-09-10',reason:'פרטי',status:'active',revision:1,created_at_ms:at,updated_at_ms:at}};});
    const snap=(ref,data)=>({exists:!!data,id:ref.id,ref,data:()=>structuredClone(data)});
    const docRef=path=>({path,id:path.split('/').at(-1),collection:name=>collectionRef(path+'/'+name)});
    const collectionRef=path=>({path,doc:id=>docRef(path+'/'+id),orderBy(){const q={query:true,cursor:null,maximum:null,startAfter(v){this.cursor=v;return this;},limit(v){this.maximum=v;return this;}};return q;}});
    const db={collection:name=>collectionRef(name),runTransaction:async fn=>fn({get:async ref=>{
      if(ref.query){let rows=records.filter(x=>!ref.cursor||x.id>ref.cursor).slice(0,ref.maximum);return {docs:rows.map(x=>snap({id:x.id},x.data)),size:rows.length};}
      if(ref.path===`stations/${sid}/users/hr`)return snap(ref,{stationId:sid,role:'hr_coordinator',active:true,employee_number:'hr-1',full_name:'עובד hr'});
      return snap(ref,null);
    }})};
    const req={auth:{uid:'hr',token:{...claims('hr_coordinator'),auth_time:at/1000}},data:{}};
    const service=createHrWorkforce({db,auth,HttpsError,clock:()=>at});const page=await service.list(req);
    assert.equal(page.items.length,25);assert.equal(page.next_cursor,records[24].id);
    const guarded=createHrWorkforce({db,auth,HttpsError,clock:()=>at,hooks:{beforeFinalize(){users.get('hr').disabled=true;}}});
    await rejects(()=>guarded.list(req),'permission-denied');
  });
  console.log(`${passed}/13 HR workforce unit groups passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
