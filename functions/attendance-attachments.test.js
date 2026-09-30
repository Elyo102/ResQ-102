'use strict';
// Actual parent service; isolated transaction/Auth doubles, no SDK or network.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAttendanceAttachments}=require('./attendance-attachments');
class HttpsError extends Error {constructor(code,message){super(message);this.code=code;}}
const aid='a'.repeat(64),event='b'.repeat(64),day='2026-09-10';
function fixture(role='firefighter',actor='owner') {
  const rows=new Map(),created={seconds:100,nanoseconds:7},writes=[];
  const ref=path=>({path,id:path.split('/').at(-1),collection:key=>ref(path+'/'+key),doc:key=>ref(path+'/'+key)});
  const db={collection:key=>ref(key),async runTransaction(fn){return fn(tx);}};
  const tx={async get(r){const data=rows.get(r.path);return {exists:data!==undefined,data:()=>structuredClone(data),createTime:structuredClone(created)};},
    create(r,d){assert.equal(rows.has(r.path),false);writes.push(r.path);rows.set(r.path,structuredClone(d));},
    set(r,d){writes.push(r.path);rows.set(r.path,structuredClone(d));}};
  const prefix='stations/s1',rowPath=prefix+'/attendance/1_'+day,reportPath=prefix+'/monthly_reports/1_2026-09';
  rows.set(prefix+'/users/owner',{uid:'owner',stationId:'s1',role:'firefighter',employee_number:'1',active:true});
  if(actor!=='owner')rows.set(prefix+'/users/'+actor,{uid:actor,stationId:'s1',role,employee_number:'2',active:true});
  rows.set('emp_index/1',{uid:'owner',stationId:'s1',active:true});
  rows.set('directory/owner',{uid:'owner',stationId:'s1',role:'firefighter',employee_number:'1',active:true});
  rows.set(rowPath,{uid:'owner',emp_number:'1',date:day,month:'2026-09',day_type:'reserve_shift',status:'draft'});
  rows.set(reportPath,{uid:'owner',emp_number:'1',month:'2026-09',status:'draft'});
  const claims={stationId:'s1',role,...(role==='super_admin'?{super:true}:{})};
  const user={uid:actor,customClaims:claims};
  const hooks={},state={month:'2026-09'};const api=createAttendanceAttachments({db,auth:{async getUser(){return user;}},HttpsError,clock:()=>1000000,monthAt:()=>state.month,hooks});
  const req={auth:{uid:actor,token:{...claims,auth_time:1}},data:{target_uid:'owner',date:day}};
  const ctx={uid:actor,sid:'s1',role,super:role==='super_admin'};
  const input=id=>({ctx,authTime:1,parent_kind:'attendance',parent_id:id});
  return {api,tx,rows,created,writes,rowPath,reportPath,user,hooks,req,input,state};
}
const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);
async function prepare(f,id){return f.api.attachmentPorts.prepare(f.tx,{...f.input(id),expected_revision:1,attachment_id:aid,event_id:event});}
test('owner context derives incarnation, is idempotent and never changes hours/report',async()=>{
  const f=fixture(),before=structuredClone(f.rows.get(f.rowPath)),report=structuredClone(f.rows.get(f.reportPath));
  const c=await f.api.context(f.req);assert.equal(c.can_upload,true);assert.equal(c.can_remove,false);assert.equal(c.parent_revision,1);
  assert.deepEqual(await f.api.context(f.req),c);assert.equal(f.writes.length,1);
  assert.deepEqual(f.rows.get(f.rowPath),before);assert.deepEqual(f.rows.get(f.reportPath),report);
});
test('publication requires recheck, links exactly once and read membership enforced',async()=>{
  const f=fixture(),c=await f.api.context(f.req),p=await prepare(f,c.parent_id),ports=f.api.attachmentPorts;
  assert.throws(()=>ports.commit(f.tx,p,{at:100}),e=>e.code==='failed-precondition');
  await ports.recheck(f.tx,p);assert.equal(ports.commit(f.tx,p,{at:100}).revision,2);
  assert.throws(()=>ports.commit(f.tx,p,{at:100}),e=>e.code==='failed-precondition');
  assert.deepEqual((await ports.read(f.tx,{...f.input(c.parent_id),attachment_id:aid})).attachment_ids,[aid]);
  await rejects(()=>ports.read(f.tx,{...f.input(c.parent_id),attachment_id:event}),'permission-denied');
  await rejects(()=>prepare(f,c.parent_id),'aborted');
});
test('delete/recreate incarnation cannot reuse old parent or prepared plan',async()=>{
  const f=fixture(),c=await f.api.context(f.req),p=await prepare(f,c.parent_id);
  f.created.nanoseconds++;
  await rejects(()=>f.api.attachmentPorts.read(f.tx,f.input(c.parent_id)),'failed-precondition');
  await rejects(()=>f.api.attachmentPorts.recheck(f.tx,p),'failed-precondition');
  const next=await f.api.context(f.req);assert.notEqual(next.parent_id,c.parent_id);assert.equal(next.parent_revision,1);
});
test('self submitted read remains available but uploads denied',async()=>{
  const f=fixture();f.rows.get(f.reportPath).status='submitted';f.rows.get(f.rowPath).status='submitted';
  const c=await f.api.context(f.req);assert.equal(c.can_upload,false);
  assert.equal((await f.api.attachmentPorts.read(f.tx,f.input(c.parent_id))).revision,1);
  await rejects(()=>prepare(f,c.parent_id),'failed-precondition');
});
test('missing report permits current self draft only, never historical or HR',async()=>{
  const f=fixture();f.rows.delete(f.reportPath);
  const c=await f.api.context(f.req);assert.equal(c.can_upload,true);const p=await prepare(f,c.parent_id);
  f.state.month='2026-10';await rejects(()=>f.api.attachmentPorts.recheck(f.tx,p),'failed-precondition');
  assert.equal((await f.api.context(f.req)).can_upload,false);
  const g=fixture('hr_coordinator','manager');g.rows.delete(g.reportPath);
  const hc=await g.api.context(g.req);assert.equal(hc.can_upload,false);await rejects(()=>prepare(g,hc.parent_id),'failed-precondition');
});
for(const role of ['hr_coordinator','super_admin'])test(role+' accepts submitted but not approved reports',async()=>{
  const f=fixture(role,'manager');f.rows.get(f.reportPath).status='submitted';f.rows.get(f.rowPath).status='submitted';
  const c=await f.api.context(f.req);assert.equal(c.can_upload,true);const p=await prepare(f,c.parent_id);
  f.rows.get(f.reportPath).status='approved';await rejects(()=>f.api.attachmentPorts.recheck(f.tx,p),'failed-precondition');
});
test('commander cannot attach to another employee; caller identity fields rejected',async()=>{
  const f=fixture('commander','manager');await rejects(()=>f.api.context(f.req),'permission-denied');
  const g=fixture();g.req.data.employee_number='2';await rejects(()=>g.api.context(g.req),'invalid-argument');assert.equal(g.writes.length,0);
});
test('inactive/imported historical row needs valid reopening evidence',async()=>{
  const f=fixture('hr_coordinator','manager');f.rows.get('stations/s1/users/owner').active=false;f.rows.get(f.rowPath).status='imported';
  const c=await f.api.context(f.req);assert.equal(c.can_upload,false);await rejects(()=>prepare(f,c.parent_id),'failed-precondition');
  Object.assign(f.rows.get(f.reportPath),{reopened_at:{seconds:200,nanoseconds:0},reopened_by:'manager',approved_at:{seconds:100,nanoseconds:0}});
  assert.equal((await f.api.context(f.req)).can_upload,true);await prepare(f,c.parent_id);
  f.rows.get(f.reportPath).approved_at={seconds:300,nanoseconds:0};await rejects(()=>prepare(f,c.parent_id),'failed-precondition');
});
test('recheck denies revoked auth, changed type, identity drift and changed membership',async()=>{
  for(const mutate of [f=>{f.user.disabled=true;},f=>{f.rows.get(f.rowPath).day_type='sick';},f=>{f.rows.get('emp_index/1').uid='other';},
    (f,c)=>{f.rows.get('stations/s1/attendance_order_parents/'+c.parent_id).revision++;}]) {
    const f=fixture(),c=await f.api.context(f.req),p=await prepare(f,c.parent_id),before=f.writes.length;
    mutate(f,c);await assert.rejects(()=>f.api.attachmentPorts.recheck(f.tx,p));assert.equal(f.writes.length,before);
  }
});
test('invalid dates, missing createTime and malformed stored identity fail closed',async()=>{
  const f=fixture();f.req.data.date='2026-02-30';await rejects(()=>f.api.context(f.req),'invalid-argument');
  f.req.data.date=day;f.created.nanoseconds=-1;await rejects(()=>f.api.context(f.req),'failed-precondition');
});
test('reserve absence remains valid without creating absence request or mutating totals',async()=>{
  const f=fixture();Object.assign(f.rows.get(f.rowPath),{day_type:'reserve',hours:8.5});
  const c=await f.api.context(f.req),p=await prepare(f,c.parent_id);await f.api.attachmentPorts.recheck(f.tx,p);f.api.attachmentPorts.commit(f.tx,p,{at:100});
  assert.equal(f.rows.get(f.rowPath).hours,8.5);assert.ok(f.writes.every(p=>p.includes('/attendance_order_parents/')));
});
