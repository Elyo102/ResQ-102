// Native Rules proof for the bounded historical-import batch; synthetic data only.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {initializeTestEnvironment} from '@firebase/rules-unit-testing';
import {doc,writeBatch,serverTimestamp} from 'firebase/firestore';
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const suffix=randomBytes(6).toString('hex'),sid='import_budget_'+suffix;
const app=initializeApp({projectId:'demo-resq'},'import-budget-'+suffix),db=getFirestore(app),root=db.doc('stations/'+sid);
const source=readFileSync(new URL('../import.html',import.meta.url),'utf8');
assert.equal(Number(source.match(/const HISTORY_WRITE_BATCH = (\d+);/)?.[1]),3);
const rows=Array.from({length:3},(_,i)=>({uid:'owner_'+suffix+'_'+i,emp:'emp_'+suffix+'_'+i,month:'2026-0'+(i+6),date:'2026-0'+(i+6)+'-01'}));
let environment;
try{
  environment=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host:'127.0.0.1',port:Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
  for(const row of rows){
    await root.collection('users').doc(row.uid).set({uid:row.uid,employee_number:row.emp,active:true});
    await root.collection('monthly_reports').doc(row.emp+'_'+row.month).set({status:'draft'});
    // Existing empty maps exercise exists + both get expressions, not just absent short-circuit.
    await root.collection('attendance_course_credits').doc(row.emp+'_'+row.month).set({days:{}});
  }
  const client=environment.authenticatedContext('super_'+suffix,{super:true}).firestore();
  const write=()=>{
    const batch=writeBatch(client);
    for(const row of rows)batch.set(doc(client,root.path+'/attendance/'+row.emp+'_'+row.date),{
      emp_number:row.emp,uid:row.uid,full_name:'Synthetic import',crew:'A',date:row.date,month:row.month,
      day_type:'regular',shape:'regular',start:'08:00',end:'16:00',sub_station:'',hours:8,notes:'',status:'imported',
      imported_from:'shift-eilat',imported_key:'synthetic',source:'import',updated_at:serverTimestamp()
    });
    return batch.commit();
  };
  await assert.rejects(write,e=>e.code==='permission-denied');
  await db.doc('registration_terms_active/super_'+suffix).set({consent_key:'1.3|2026-09-24'});
  await write();assert.equal((await root.collection('attendance').get()).size,3);
  console.log('PASS native import budget: three distinct employee/month paths fit Rules budget');
  for(const row of rows)await root.collection('attendance').doc(row.emp+'_'+row.date).delete();
  const conflict=rows[1];await root.collection('attendance_course_credits').doc(conflict.emp+'_'+conflict.month).set({days:{[conflict.date]:{credit_hours:12}}});
  await assert.rejects(write,e=>e.code==='permission-denied');
  assert.equal((await root.collection('attendance').get()).empty,true);
  console.log('PASS native import budget: one course conflict rejects the complete three-row batch');
}finally{
  await db.recursiveDelete(root);await db.doc('registration_terms_active/super_'+suffix).delete();if(environment)await environment.cleanup();await deleteApp(app);
}
console.log('Attendance import budget: 2/2 native Rules checks PASS; no production writes.');
