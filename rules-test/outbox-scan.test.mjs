import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
const endpoint=process.env.FIRESTORE_EMULATOR_HOST||'';
assert.match(endpoint,/^127\.0\.0\.1:(8080|8191|8199)$/);
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
assert.ok(!process.env.GOOGLE_CLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT==='demo-resq');
assert.ok(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
const {initializeTestEnvironment}=await import('@firebase/rules-unit-testing');
const {doc,collection,getDocFromServer,getDocs,setDoc,updateDoc,deleteDoc}=await import('firebase/firestore');
const suffix=randomBytes(12).toString('hex'),sid='scan_'+suffix;
const roles=['member','hr','super'],uids=roles.map(role=>role+'_'+suffix);
const existing='schedule_runtime_workers/test_'+suffix,control='admin_audit/test_'+suffix;
const creates=['anonymous',...roles].map(role=>'schedule_runtime_workers/'+role+'_'+suffix);
const owned=[existing,control,...creates,...uids.map(uid=>'registration_terms_active/'+uid),
  ...uids.slice(0,2).map(uid=>'stations/'+sid+'/users/'+uid)];
const env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host:'127.0.0.1',port:Number(endpoint.split(':')[1]),
  rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
let claimed=false;
try{
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    for(const path of owned)assert.equal((await getDocFromServer(doc(db,path))).exists(),false);
    claimed=true;
    await setDoc(doc(db,existing),{fixture:suffix,cursors:{}});
    await setDoc(doc(db,control),{fixture:suffix});
    for(const uid of uids)await setDoc(doc(db,'registration_terms_active/'+uid),{uid,consent_key:'1.3|2026-09-24',terms_version:'1.3',privacy_version:'2026-09-24',receipt_path:'registration_consents/'+uid+'/events/fixture'});
    for(const [i,uid] of uids.slice(0,2).entries())await setDoc(doc(db,'stations/'+sid+'/users/'+uid),{role:i?'hr_coordinator':'firefighter',stationId:sid,active:true,is_active:true});
  });
  const clients=[env.unauthenticatedContext().firestore(),
    env.authenticatedContext(uids[0],{role:'firefighter',stationId:sid,emp:'1001'}).firestore(),
    env.authenticatedContext(uids[1],{role:'hr_coordinator',stationId:sid,emp:'1002'}).firestore(),
    env.authenticatedContext(uids[2],{super:true}).firestore()];
  assert.equal((await getDocFromServer(doc(clients[3],control))).data().fixture,suffix);
  let denied=0;
  for(const [i,db] of clients.entries())for(const operation of [
    ()=>getDocFromServer(doc(db,existing)),()=>getDocs(collection(db,'schedule_runtime_workers')),
    ()=>setDoc(doc(db,creates[i]),{cursors:{}}),()=>setDoc(doc(db,existing),{cursors:{forged:'path'}}),
    ()=>updateDoc(doc(db,existing),{cursors:{forged:'path'}}),()=>deleteDoc(doc(db,existing))]){
    await assert.rejects(operation(),error=>error?.code==='permission-denied');denied++;
  }
  await env.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    assert.deepEqual((await getDocFromServer(doc(db,existing))).data(),{fixture:suffix,cursors:{}});
    for(const path of creates)assert.equal((await getDocFromServer(doc(db,path))).exists(),false);
  });
  assert.equal(denied,24);
  console.log('PASS outbox cursor: 24 client denials, authorized-super positive control, unchanged cursor');
}finally{
  try{if(claimed)await env.withSecurityRulesDisabled(async context=>{
    for(const path of owned)await deleteDoc(doc(context.firestore(),path));
  });}finally{await env.cleanup();}
}
