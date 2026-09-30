// Owned demo emulator only. Real transactions/Rules; synthetic Auth, no Storage.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,getDoc,setDoc} from 'firebase/firestore';
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS,'No external credentials');
process.env.METADATA_SERVER_DETECTION='none';
const require=createRequire(import.meta.url);
const {createAttendanceAttachments}=require('../functions/attendance-attachments');
const suffix=randomBytes(6).toString('hex'),sid='order_it_'+suffix,uid='owner_'+suffix,hr='hr_'+suffix,emp='emp_'+suffix;
const app=initializeApp({projectId:'demo-resq'},'order-'+suffix),db=getFirestore(app),root=db.doc('stations/'+sid);
const day='2026-09-10',row=root.collection('attendance').doc(emp+'_'+day),report=root.collection('monthly_reports').doc(emp+'_2026-09');
const records=new Map([[uid,{uid,customClaims:{stationId:sid,role:'firefighter'}}],[hr,{uid:hr,customClaims:{stationId:sid,role:'hr_coordinator'}}]]);
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const service=createAttendanceAttachments({db,auth:{async getUser(id){assert.ok(records.has(id));return structuredClone(records.get(id));}},HttpsError,clock:()=>Date.parse('2026-09-29T09:00Z'),monthAt:()=> '2026-09'});
const req=(actor=uid)=>({auth:{uid:actor,token:{...records.get(actor).customClaims,auth_time:1}},data:{target_uid:uid,date:day}});
const input=(id,actor=uid)=>({ctx:{uid:actor,sid,role:records.get(actor).customClaims.role,super:false},authTime:1,parent_kind:'attendance',parent_id:id});
const seed={uid,emp_number:emp,date:day,month:'2026-09',day_type:'reserve_shift',status:'draft',hours:32.5,reserve_calculation_version:2};
let env,passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS attendance orders: '+name);};
try{
  const port=Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]);
  env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host:'127.0.0.1',port,rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
  await root.collection('users').doc(uid).set({uid,stationId:sid,role:'firefighter',employee_number:emp,active:true});
  await root.collection('users').doc(hr).set({uid:hr,stationId:sid,role:'hr_coordinator',employee_number:'hr_'+emp,active:true});
  await db.doc('emp_index/'+emp).set({uid,stationId:sid,active:true});
  await db.doc('directory/'+uid).set({uid,stationId:sid,role:'firefighter',employee_number:emp,active:true});
  await row.set(seed);await report.set({uid,emp_number:emp,month:'2026-09',status:'draft'});
  let context;
  await check('native creationTime incarnation and idempotent metadata without attendance writes',async()=>{
    const before=await row.get();context=await service.context(req());assert.equal(context.can_upload,true);
    assert.deepEqual(await service.context(req()),context);const after=await row.get();assert.ok(before.updateTime.isEqual(after.updateTime));
    assert.deepEqual(after.data(),seed);
  });
  const publish=(id,letter,actor=uid)=>db.runTransaction(async tx=>{
    const plan=await service.attachmentPorts.prepare(tx,{...input(id,actor),expected_revision:1,attachment_id:letter.repeat(64),event_id:'e'.repeat(64)});
    await service.attachmentPorts.recheck(tx,plan);return service.attachmentPorts.commit(tx,plan,{at:1000});
  });
  await check('concurrent publication has one winner under revision CAS',async()=>{
    const result=await Promise.allSettled([publish(context.parent_id,'a'),publish(context.parent_id,'b')]);
    assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected').reason.code,'aborted');
    const value=await db.runTransaction(tx=>service.attachmentPorts.read(tx,input(context.parent_id)));
    assert.equal(value.revision,2);assert.equal(value.attachment_ids.length,1);
  });
  await check('Rules deny direct sidecar read/write to employee and HR',async()=>{
    for(const actor of [uid,hr]){
      const client=env.authenticatedContext(actor,records.get(actor).customClaims).firestore(),ref=doc(client,root.path+'/attendance_order_parents/'+context.parent_id);
      await assert.rejects(()=>getDoc(ref),e=>e.code==='permission-denied');
      await assert.rejects(()=>setDoc(ref,{revision:999}),e=>e.code==='permission-denied');
    }
  });
  await check('real delete/recreate changes incarnation and denies old attachment membership',async()=>{
    await row.delete();await row.set(seed);const next=await service.context(req());assert.notEqual(next.parent_id,context.parent_id);
    await assert.rejects(()=>db.runTransaction(tx=>service.attachmentPorts.read(tx,input(context.parent_id))),e=>e.code==='failed-precondition');context=next;
  });
  await check('submitted HR publication allowed, self denied, approved requires reopen',async()=>{
    await row.update({status:'submitted'});await report.update({status:'submitted'});
    assert.equal((await service.context(req())).can_upload,false);assert.equal((await service.context(req(hr))).can_upload,true);
    await assert.rejects(()=>publish(context.parent_id,'c'),e=>e.code==='failed-precondition');await publish(context.parent_id,'c',hr);
    await report.update({status:'approved'});assert.equal((await service.context(req(hr))).can_upload,false);
  });
  await check('live Auth revocation stops reads and membership remains bounded',async()=>{
    records.get(uid).disabled=true;
    await assert.rejects(()=>db.runTransaction(tx=>service.attachmentPorts.read(tx,input(context.parent_id))),e=>e.code==='permission-denied');
    const parents=await root.collection('attendance_order_parents').get();assert.equal(parents.size,2);
    assert.equal((await row.get()).data().hours,32.5);
  });
}finally{
  for(const collection of ['attendance_order_parents','attendance','monthly_reports','users']){
    for(const snap of (await root.collection(collection).get()).docs)await snap.ref.delete();
  }
  await root.delete();await db.doc('emp_index/'+emp).delete();await db.doc('directory/'+uid).delete();
  if(env)await env.cleanup();await deleteApp(app);
}
assert.equal(passed,6);console.log('Attendance orders: 6/6 native transaction/Rules checks PASS; synthetic Auth, Storage/transport NOT tested.');
