'use strict';
// Actual course/HR factories and projection, atomic in-memory transactions only.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCourseCreditService}=require('./attendance-course-credit');
const {createHrRequests}=require('./hr-requests');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(){
  const data=new Map(),versions=new Map();let seq=1;
  const ref=path=>({path,id:path.split('/').at(-1),collection:k=>ref(path+'/'+k),doc:k=>ref(path+'/'+k),limit:n=>({query:path,limit:n})});
  const snapshot=path=>({id:path.split('/').at(-1),ref:ref(path),exists:data.has(path),data:()=>structuredClone(data.get(path)),updateTime:{seconds:versions.get(path)||1,nanoseconds:0}});
  const seed=(path,value)=>{data.set(path,structuredClone(value));versions.set(path,++seq);};
  const db={collection:k=>ref(k),doc:ref,async runTransaction(fn){
    const writes=[];const tx={async get(r){assert.equal(writes.length,0,'all reads precede writes');
      if(r.query){const docs=[...data.keys()].filter(p=>p.startsWith(r.query+'/')&&!p.slice(r.query.length+1).includes('/')).sort().slice(0,r.limit).map(snapshot);return {docs,size:docs.length};}
      return snapshot(r.path);},create(r,v){assert.equal(data.has(r.path),false);writes.push([r.path,v]);},set(r,v){writes.push([r.path,v]);}};
    const value=await fn(tx);writes.forEach(([p,v])=>seed(p,v));return value;
  }};
  for(const [uid,role,emp]of [['owner','firefighter','emp1'],['hr','hr_coordinator','emp2']]){
    seed('stations/s1/users/'+uid,{uid,stationId:'s1',role,employee_number:emp,crew:'A',active:true});
    seed('directory/'+uid,{uid,stationId:'s1',role,employee_number:emp,active:true});seed('emp_index/'+emp,{uid,stationId:'s1',active:true});
  }
  for(let position=0;position<3;position++)seed('stations/s1/rotations/r'+position,{crew:['A','B','C'][position],anchor_date:'2026-09-01',cycle_days:3,position_in_cycle:position,is_active:true,shift_hours:12,commander_shift_hours:12.25});
  const auth={async getUser(uid){return {uid,customClaims:{stationId:'s1',role:uid==='hr'?'hr_coordinator':'firefighter'}};}};
  const deps={db,auth,HttpsError,clock:()=>Date.parse('2026-09-01T12:00Z')};
  const course=createCourseCreditService(deps),hr=createHrRequests({...deps,courseCredits:course});
  const req=(uid,payload)=>({auth:{uid,token:{stationId:'s1',role:uid==='hr'?'hr_coordinator':'firefighter',auth_time:1}},data:payload});
  const create=(from='2026-09-01',to='2026-09-30',id='create_course_001')=>hr.create(req('owner',{request_id:id,kind:'course',subject:'Course',from_date:from,to_date:to,send_now:false}));
  const decide=(c,decision='approved',id='decide_course_001')=>hr.setDecision(req('hr',{request_id:id,case_id:c.case_id,expected_revision:c.revision,decision,send_now:false}));
  const read=month=>db.runTransaction(tx=>course.readCourseMonth(tx,{sid:'s1',uid:'owner',emp:'emp1',month}));
  return {data,seed,db,course,hr,req,create,decide,read,case:id=>data.get('stations/s1/hr_requests/'+id)};
}
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);
test('actual HR approval snapshots ten original shifts at explicit 12h and never edits schedule',async()=>{
  const f=fixture(),before=[...f.data].filter(([p])=>p.includes('/rotations/'));const c=await f.create();
  assert.equal(f.case(c.case_id).decision,'pending');assert.equal((await f.read('2026-09')).revision,0);
  const approved=await f.decide(c),snapshot=f.case(c.case_id).course_snapshot;
  assert.equal(snapshot.days.length,10);assert.equal(snapshot.total_hours,120);assert.equal(snapshot.approval_revision,approved.revision);
  assert.equal(Object.keys((await f.read('2026-09')).days).length,10);
  assert.deepEqual([...f.data].filter(([p])=>p.includes('/rotations/')),before);
  const replay=await f.decide(c);assert.equal(replay.duplicate,true);assert.equal((await f.read('2026-09')).revision,1);
});
test('role standard explicit commander duration, no 24-hour fallback',async()=>{
  const f=fixture(),c=await f.create();const profile=f.data.get('stations/s1/users/owner');f.seed('stations/s1/users/owner',{...profile,role:'commander'});
  await f.decide(c);assert.equal(f.case(c.case_id).course_snapshot.total_hours,122.5);
  const g=fixture();delete g.data.get('stations/s1/rotations/r0').shift_hours;
  const missing=await g.create();await rejects(()=>g.decide(missing),'failed-precondition');assert.equal(g.case(missing.case_id).decision,'pending');
});
test('cross-month approval has full immutable period and clipped monthly credits',async()=>{
  const f=fixture(),c=await f.create('2026-09-28','2026-10-07');await f.decide(c);
  const sep=await f.read('2026-09'),oct=await f.read('2026-10');assert.equal(Object.keys(sep.days).length,1);assert.equal(Object.keys(oct.days).length,3);
  assert.equal(sep.periods[c.case_id].from_date,'2026-09-28');assert.equal(oct.periods[c.case_id].days.length,4);
});
test('reapproval creates new snapshot; old snapshot retained in HR event history',async()=>{
  const f=fixture(),c=await f.create();const approved=await f.decide(c);const old=structuredClone(f.case(c.case_id).course_snapshot);
  f.data.get('stations/s1/rotations/r0').shift_hours=8;
  assert.equal((await f.read('2026-09')).periods[c.case_id].total_hours,120);
  await f.decide(approved,'approved','reapprove_course_001');assert.equal(f.case(c.case_id).course_snapshot.total_hours,80);
  assert.ok([...f.data].some(([p,v])=>p.includes('/events/')&&v.previous_course_snapshot?.source_digest===old.source_digest));
});
test('rejection removes active credits only; approved snapshot history retained',async()=>{
  const f=fixture(),c=await f.create(),approved=await f.decide(c);await f.decide(approved,'rejected','reject_course_001');
  assert.deepEqual((await f.read('2026-09')).days,{});assert.equal(f.case(c.case_id).course_snapshot,null);
  assert.ok([...f.data].some(([p,v])=>p.includes('/events/')&&v.previous_course_snapshot?.days.length===10));
});
test('HR cannot self-approve and employee cannot choose credits or approve',async()=>{
  const f=fixture(),c=await f.create();await rejects(()=>f.hr.setDecision(f.req('owner',{request_id:'bad_approve_001',case_id:c.case_id,expected_revision:c.revision,decision:'approved',send_now:false})),'permission-denied');
  await rejects(()=>f.hr.create(f.req('owner',{request_id:'bad_create_001',kind:'course',subject:'Course',from_date:'2026-09-01',to_date:'2026-09-30',send_now:false,credit_hours:99})),'invalid-argument');
});
test('overlapping approved courses fail atomically',async()=>{
  const f=fixture(),a=await f.create(),b=await f.create('2026-09-01','2026-09-30','create_course_002');await f.decide(a);
  await rejects(()=>f.decide(b,'approved','decide_course_002'),'failed-precondition');assert.equal(f.case(b.case_id).decision,'pending');
  assert.equal(Object.keys((await f.read('2026-09')).periods).length,1);
});
test('locked reports block approval and revocation until existing reopen',async()=>{
  const f=fixture(),c=await f.create();f.seed('stations/s1/monthly_reports/emp1_2026-09',{uid:'owner',emp_number:'emp1',month:'2026-09',status:'submitted'});
  await rejects(()=>f.decide(c),'failed-precondition');f.data.get('stations/s1/monthly_reports/emp1_2026-09').status='draft';
  const approved=await f.decide(c);f.data.get('stations/s1/monthly_reports/emp1_2026-09').status='approved';await rejects(()=>f.decide(approved,'rejected','reject_locked_001'),'failed-precondition');
});
test('existing regular row preserved; absences/reserve conflict rather than double credit',async()=>{
  for(const type of ['regular','reserve_shift','reserve','sick','vacation']){
    const f=fixture(),row={uid:'owner',emp_number:'emp1',date:'2026-09-01',month:'2026-09',day_type:type,status:'draft',hours:24};f.seed('stations/s1/attendance/emp1_2026-09-01',row);
    const c=await f.create();if(type==='regular')await f.decide(c);else await rejects(()=>f.decide(c),'failed-precondition');assert.deepEqual(f.data.get('stations/s1/attendance/emp1_2026-09-01'),row);
  }
});
test('missing cycle position, unknown crew and invalid date fail closed',async()=>{
  for(const mutate of [f=>f.data.delete('stations/s1/rotations/r2'),f=>{f.data.get('stations/s1/users/owner').crew='unknown';}]){
    const f=fixture();mutate(f);const c=await f.create();await rejects(()=>f.decide(c),'failed-precondition');
  }
});
test('month context has private target authority and same actor epoch contract',async()=>{
  const f=fixture(),c=await f.create();await f.decide(c);
  const out=await f.course.context(f.req('owner',{target_uid:'owner',month:'2026-09'}));assert.equal(out.periods.length,1);assert.equal(out.epoch.uid,'owner');
  await rejects(()=>f.course.context(f.req('owner',{target_uid:'hr',month:'2026-09'})),'permission-denied');
});
test('derived index must still match current approved request; map key order is immaterial',async()=>{
  const f=fixture(),c=await f.create();await f.decide(c);
  const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reverse(v[k])])):v;
  for(const [path,value]of f.data)f.data.set(path,reverse(value));
  assert.equal(Object.keys((await f.read('2026-09')).days).length,10);
  f.case(c.case_id).decision='rejected';await rejects(()=>f.read('2026-09'),'failed-precondition');
});
test('inactive locally bound owner permits HR historical read/rejection, not new approval',async()=>{
  const f=fixture(),c=await f.create(),approved=await f.decide(c);f.data.get('stations/s1/users/owner').active=false;
  f.data.delete('emp_index/emp1');f.data.delete('directory/owner');
  const view=await f.course.context(f.req('hr',{target_uid:'owner',month:'2026-09'}));assert.equal(view.periods.length,1);
  await rejects(()=>f.decide(approved,'approved','inactive_reapprove'),'failed-precondition');
  await f.decide(approved,'rejected','inactive_reject');assert.deepEqual((await f.read('2026-09')).days,{});
});
