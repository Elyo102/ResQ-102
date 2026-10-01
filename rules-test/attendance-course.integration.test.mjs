// Real Firestore transactions and Rules; synthetic Auth, no provider/network calls.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getFirestore,FieldValue} from 'firebase-admin/firestore';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,getDoc,setDoc,serverTimestamp} from 'firebase/firestore';
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const require=createRequire(import.meta.url);
const {createCourseCreditService}=require('../functions/attendance-course-credit');
const {createHrRequests}=require('../functions/hr-requests');
const {createAttendanceSelfService}=require('../functions/attendance-self-service');
const {createAttendanceCorrectionSupport}=require('../functions/attendance-correction-support');
const {calculateAttendanceDerived}=require('../functions/attendance-hours-calculator');
const suffix=randomBytes(6).toString('hex'),sid='course_it_'+suffix,uid='owner_'+suffix,hr='hr_'+suffix,emp='emp_'+suffix;
const app=initializeApp({projectId:'demo-resq'},'course-'+suffix),db=getFirestore(app),root=db.doc('stations/'+sid);
const month='2026-09',day=month+'-01',report=root.collection('monthly_reports').doc(emp+'_'+month);
const records=new Map([[uid,{uid,customClaims:{stationId:sid,role:'firefighter'}}],[hr,{uid:hr,customClaims:{stationId:sid,role:'hr_coordinator'}}]]);
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const deps={db,auth:{async getUser(id){assert.ok(records.has(id));return structuredClone(records.get(id));}},HttpsError,clock:()=>Date.parse('2026-09-29T09:00Z')};
const course=createCourseCreditService(deps),requests=createHrRequests({...deps,courseCredits:course});
const self=createAttendanceSelfService({...deps,monthAt:()=>month,serverTimestamp:()=>FieldValue.serverTimestamp(),
  readConfig:async()=>({siteById:{},shiftHours:24}),calculate:calculateAttendanceDerived,readCourseMonth:course.readCourseMonth});
const support=createAttendanceCorrectionSupport({...deps,monthAt:()=>month,serverTimestamp:()=>FieldValue.serverTimestamp(),readCourseMonth:course.readCourseMonth});
const req=(actor,data)=>({auth:{uid:actor,token:{...records.get(actor).customClaims,auth_time:1}},data});
const version=s=>({seconds:s.updateTime.seconds,nanoseconds:s.updateTime.nanoseconds});
const decide=(c,decision,id)=>requests.setDecision(req(hr,{request_id:id,case_id:c.case_id,expected_revision:c.revision,decision,send_now:false}));
let environment,passed=0;
const check=async(name,fn)=>{await fn();passed++;console.log('PASS native course: '+name);};
try{
  environment=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host:'127.0.0.1',port:Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
  for(const actor of [uid,hr,'super_'+suffix])await db.doc('registration_terms_active/'+actor).set({consent_key:'1.3|2026-09-24'});
  for(const [actor,role,number]of [[uid,'firefighter',emp],[hr,'hr_coordinator','hr_'+emp]]){
    await root.collection('users').doc(actor).set({uid:actor,stationId:sid,role,employee_number:number,crew:'A',active:true});
    await root.collection('roster').doc(actor).set({station_id:sid,full_name:'Synthetic '+role,crew:'A',active:true});
    await db.doc('emp_index/'+number).set({uid:actor,stationId:sid,active:true});
    await db.doc('directory/'+actor).set({uid:actor,stationId:sid,role,employee_number:number,active:true});
  }
  // Optional commander hours deliberately absent: native serialization must succeed.
  for(let p=0;p<3;p++)await root.collection('rotations').doc('r'+p).set({crew:['A','B','C'][p],anchor_date:day,cycle_days:3,position_in_cycle:p,is_active:true,shift_hours:12});
  const rotations=await root.collection('rotations').get();
  const created=await requests.create(req(uid,{request_id:'create_course_native',kind:'course',subject:'Synthetic course',from_date:day,to_date:month+'-04',send_now:false}));
  let approved;
  await check('approval persists explicit snapshot without optional undefined fields',async()=>{
    approved=await decide(created,'approved','approve_course_native');
    const value=(await root.collection('hr_requests').doc(created.case_id).get()).data().course_snapshot;
    assert.equal(value.total_hours,24);assert.deepEqual(value.days.map(x=>x.date),[day,month+'-04']);
    assert.equal(value.source_label,'assigned-schedule-at-hr-approval-v2');
    assert.equal(value.source.assignment_basis.schema,'course-assignment-basis-v2');
    assert.ok(value.source.assignment_basis.documents.some(x=>x.path===root.path+'/roster/'+uid&&x.version&&x.digest));
    assert.ok(value.source.assignment_basis.documents.some(x=>x.path===root.path+'/rotations/r0'&&x.version&&x.digest));
    assert.doesNotThrow(()=>JSON.stringify(value));
    for(const original of rotations.docs)assert.ok(original.updateTime.isEqual((await original.ref.get()).updateTime));
  });
  await check('both legacy create routes deny credited days and retain unaffected days',async()=>{
    const client=environment.authenticatedContext('super_'+suffix,{super:true}).firestore();
    const target=date=>doc(client,root.path+'/attendance/'+emp+'_'+date);
    const imported=date=>({emp_number:emp,uid,full_name:'',crew:'A',date,month,day_type:'regular',shape:'regular',start:'08:00',end:'16:00',sub_station:'',hours:8,notes:'',status:'imported',imported_from:'shift-eilat',imported_key:'synthetic',source:'import',updated_at:serverTimestamp()});
    await assert.rejects(()=>setDoc(target(day),imported(day)),e=>e.code==='permission-denied');
    await setDoc(target(month+'-02'),imported(month+'-02'));
    await root.collection('attendance').doc(emp+'_'+month+'-02').delete();
    await root.collection('submissions').doc('course_leave').set({form_id:'leave',status:'approved',by_uid:uid,by_emp:emp,by_name:'',crew:'A',values:{from:day,to:month+'-04'}});
    const leave=date=>({emp_number:emp,uid,full_name:'',crew:'A',date,month,day_type:'vacation',day_type_he:'חופש',hours:24,status:'draft',source:'approved_leave_form',from_form:'course_leave',notes:'',updated_at:serverTimestamp()});
    await assert.rejects(()=>setDoc(target(day),leave(day)),e=>e.code==='permission-denied');
    await setDoc(target(month+'-03'),leave(month+'-03'));
    await root.collection('attendance').doc(emp+'_'+month+'-03').delete();
    assert.equal((await root.collection('attendance').get()).empty,true);
  });
  await check('virtual course-only submission uses revision CAS and credits once',async()=>{
    await assert.rejects(()=>self.mutateMonth(req(uid,{request_id:'stale_course_submit',operation:'submit',month,days:[],expected_report_version:'absent',expected_course_revision:9})),e=>e.code==='aborted');
    await self.mutateMonth(req(uid,{request_id:'course_submit_native',operation:'submit',month,days:[],expected_report_version:'absent',expected_course_revision:1}));
    const value=(await report.get()).data();assert.equal(value.total_hours,24);assert.deepEqual(value.base_days,[]);assert.equal(value.course_revision,1);assert.deepEqual(value.days,[day,month+'-04']);
    assert.equal((await root.collection('attendance').get()).empty,true);
  });
  await check('submitted report blocks revocation; reopen permits history-preserving rejection',async()=>{
    await assert.rejects(()=>decide(approved,'rejected','locked_course_reject'),e=>e.code==='failed-precondition');
    await self.mutateMonth(req(uid,{request_id:'course_reopen_native',operation:'unsubmit',month,expected_report_version:version(await report.get())}));
    await decide(approved,'rejected','course_reject_native');
    const value=await db.runTransaction(tx=>course.readCourseMonth(tx,{sid,uid,emp,month}));assert.deepEqual(value.days,{});assert.equal(value.revision,2);
    const events=await root.collection('hr_requests').doc(created.case_id).collection('events').get();assert.ok(events.docs.some(s=>s.data().previous_course_snapshot?.total_hours===24));
  });
  await check('private derived course index denies direct employee and HR access',async()=>{
    for(const actor of [uid,hr]){
      const client=environment.authenticatedContext(actor,records.get(actor).customClaims).firestore(),ref=doc(client,root.path+'/attendance_course_credits/'+emp+'_'+month);
      await assert.rejects(()=>getDoc(ref),e=>e.code==='permission-denied');await assert.rejects(()=>setDoc(ref,{revision:999}),e=>e.code==='permission-denied');
    }
  });
  await check('reapproved snapshot submits and HR approves real course-only payroll',async()=>{
    const current=(await root.collection('hr_requests').doc(created.case_id).get()).data();
    await decide(current,'approved','course_reapprove_native');
    await self.mutateMonth(req(uid,{request_id:'course_resubmit_native',operation:'submit',month,days:[],expected_report_version:version(await report.get()),expected_course_revision:3}));
    await support.approve(req(hr,{target_uid:uid,employee_number:emp,month,request_id:'course_hr_approve_native'}));
    const result=(await report.get()).data();assert.equal(result.status,'approved');assert.equal(result.total_hours,24);assert.equal(result.course_revision,3);
    assert.equal((await root.collection('attendance').get()).empty,true);
  });
}finally{
  for(const actor of [uid,hr,'super_'+suffix])await db.doc('registration_terms_active/'+actor).delete();
  await db.recursiveDelete(root);
  for(const [actor,number]of [[uid,emp],[hr,'hr_'+emp]]){await db.doc('emp_index/'+number).delete();await db.doc('directory/'+actor).delete();}
  for(const actor of [uid,hr])await db.collection('hr_request_actor_quotas').doc(createHash('sha256').update(JSON.stringify(['hr-request-quota-v1',actor])).digest('hex')).delete();
  if(environment)await environment.cleanup();await deleteApp(app);
}
assert.equal(passed,6);console.log('Course: 6/6 native transaction/Rules checks PASS; synthetic Auth, no production validation.');
