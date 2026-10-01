'use strict';
const assert=require('node:assert/strict');
const {randomBytes,createHash}=require('node:crypto');
assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^127\.0\.0\.1:(8080|8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
process.env.METADATA_SERVER_DETECTION='none';
const admin=require('firebase-admin');
const {createHrMonthlySummary}=require('./hr-monthly-summary');
const app=admin.initializeApp({projectId:'demo-resq'},'hr-consistency-'+randomBytes(8).toString('hex'));
const db=app.firestore(),sid='it_hr_'+randomBytes(12).toString('hex'),month='2026-09';
const root='stations/'+sid,head=db.doc(root+'/hr_monthly_summaries/'+month),owned=new Map();
let clock=0,advance=true;
class TestError extends Error{constructor(code,message){super(message);this.code=code;}}
const summary=createHrMonthlySummary({db,HttpsError:TestError,clock:()=>advance?(clock+=1000):clock});
const generation=intent=>createHash('sha256').update(JSON.stringify(['hr-monthly-generation-v1',sid,month,intent])).digest('hex');
const generationRef=intent=>head.collection('hr_monthly_generations').doc(generation(intent));
async function reserve(ref){assert.equal((await ref.get()).exists,false);owned.set(ref.path,ref);}
(async()=>{
  try{
    await reserve(head);const config=db.doc(root+'/config/hr');await reserve(config);
    for(const intent of ['first','changed','new']){
      await reserve(generationRef(intent));
      for(let i=0;i<107;i++)await reserve(generationRef(intent).collection('hr_monthly_rows').doc('u'+String(i).padStart(3,'0')));
    }
    const batch=db.batch();
    for(let i=0;i<107;i++){
      const uid='u'+String(i).padStart(3,'0'),ref=db.doc(root+'/users/'+uid);
      await reserve(ref);batch.create(ref,{employee_number:uid,full_name:'Synthetic '+i,crew:'A'});
    }
    await batch.commit();
    const paused=await summary.build({station_id:sid,month,intent_id:'first',budget_ms:1});
    assert.equal(paused.complete,false);advance=false;
    const pinned=(await generationRef('first').get()).data();
    const context={month,limit:await summary.hourLimit(sid),absences:await summary.absenceIndex(sid,month),
      longAbsences:await summary.longAbsenceIndex(sid,month),digest:pinned.source_digest};
    const input={station_id:sid,month,generation_id:paused.generation_id};
    await Promise.all([summary.runSlice(input,context),summary.runSlice(input,context)]);
    const state=(await generationRef('first').get()).data(),rows=await generationRef('first').collection('hr_monthly_rows').get();
    assert.equal(state.rows,107);assert.equal(state.state,'complete');assert.equal(rows.size,107);
    assert.equal(new Set(rows.docs.map(doc=>doc.id)).size,107);
    assert.deepEqual(await summary.runSlice(input,context),{done:true,written:0,rows:107});
    console.log('PASS concurrent native pages commit exactly 107 rows and terminal replay writes zero');
    await summary.build({station_id:sid,month,intent_id:'first'});
    const first=await summary.read({station_id:sid,month});assert.equal(first.rows.length,25);
    advance=true;
    await summary.build({station_id:sid,month,intent_id:'changed',budget_ms:1});
    advance=false;await config.create({hour_limit:300});
    await assert.rejects(()=>summary.build({station_id:sid,month,intent_id:'changed'}),e=>e.code==='failed-precondition');
    assert.equal((await head.get()).data().active_generation,first.generation_id);
    console.log('PASS native changed-context resume rejected without replacing active report');
    await summary.build({station_id:sid,month,intent_id:'new'});
    await assert.rejects(()=>summary.read({station_id:sid,month,cursor:first.next_cursor}),e=>e.code==='failed-precondition');
    console.log('PASS native old generation cursor rejected after new report activation');
    console.log('3 native HR consistency checks passed; synthetic data, not a global source snapshot.');
  }finally{
    try{
      const refs=[...owned.values()];
      for(let i=0;i<refs.length;i+=400){const batch=db.batch();refs.slice(i,i+400).forEach(ref=>batch.delete(ref));await batch.commit();}
    }finally{await app.delete();}
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
