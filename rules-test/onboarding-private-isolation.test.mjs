import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initializeTestEnvironment,assertFails} from '@firebase/rules-unit-testing';
import {doc,getDoc,setDoc,deleteDoc,updateDoc,collection,getDocs,query,limit} from 'firebase/firestore';
const endpoint=process.env.FIRESTORE_EMULATOR_HOST||'127.0.0.1:8080';
assert.match(endpoint,/^(127\.0\.0\.1|localhost):\d+$/);assert.ok(!process.env.GCLOUD_PROJECT||process.env.GCLOUD_PROJECT==='demo-resq');
const [host,port]=endpoint.split(':');
const env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host,port:Number(port),rules:readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
const names=['hr_invitation_operations','hr_invitation_recipients','setup_mail_operations','setup_mail_receipts','setup_mail_cooldowns','setup_mail_rates'];
const id='fixture_'+Date.now();let assertions=0;
try{
 await env.withSecurityRulesDisabled(async context=>{for(const name of names)await setDoc(doc(context.firestore(),name,id),{fixture:true});});
 for(const claims of [null,{role:'firefighter',stationId:'eilat_102',emp:17},{role:'hr_coordinator',stationId:'eilat_102',emp:18},{super:true}]){
  const db=claims?env.authenticatedContext('fixture_actor',claims).firestore():env.unauthenticatedContext().firestore();
  for(const name of names){const ref=doc(db,name,id);for(const attempt of [()=>getDoc(ref),()=>getDocs(query(collection(db,name),limit(1))),()=>setDoc(doc(db,name,id+'_new'),{fixture:true}),()=>updateDoc(ref,{fixture:false}),()=>deleteDoc(ref)]){await assertFails(attempt());assertions++;}}
 }
 console.log('Private onboarding/queue metadata isolation: '+assertions+' denials PASS');
}finally{
 await env.withSecurityRulesDisabled(async context=>{for(const name of names){await deleteDoc(doc(context.firestore(),name,id));await deleteDoc(doc(context.firestore(),name,id+'_new'));}});await env.cleanup();
}
