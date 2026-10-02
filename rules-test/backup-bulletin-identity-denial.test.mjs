import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initializeTestEnvironment,assertFails} from '@firebase/rules-unit-testing';
import {doc,collection,getDoc,getDocs,setDoc,updateDoc,deleteDoc} from 'firebase/firestore';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8199');
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
const env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host:'127.0.0.1',port:8199,rules:fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
const paths=["stations/fixture/bulletin_requests/fixture","stations/fixture/bulletin_rate_limits/fixture","stations/fixture/schedule_people/fixture","stations/fixture/schedule_source_bindings/fixture","stations/fixture/schedule_person_link_index/fixture","stations/fixture/schedule_identity_state/current","stations/fixture/schedule_identity_operations/fixture","stations/fixture/schedule_identity_audit/fixture","schedule_person_link_reservations/fixture","stations/fixture/schedule_identity_state/other"];
let passed=0;
try {
 for(const ctx of [env.unauthenticatedContext(),env.authenticatedContext('fixture-user'),env.authenticatedContext('fixture-admin',{role:'super_admin',super_admin:true})]) {
  const db=ctx.firestore();
  for(const p of paths) {
   await env.withSecurityRulesDisabled(ctx=>deleteDoc(doc(ctx.firestore(),p)));
   await assertFails(setDoc(doc(db,p),{synthetic:true}));passed++;
   await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),p),{synthetic:true}));
   for(const action of [()=>getDoc(doc(db,p)),()=>getDocs(collection(db,p.slice(0,p.lastIndexOf('/')))),()=>updateDoc(doc(db,p),{synthetic:false}),()=>deleteDoc(doc(db,p))]){await assertFails(action());passed++;}
  }
 }
 console.log(JSON.stringify({emulatorOnly:true,passed,failed:0,productionContacted:false,exactSingletonCreateTested:true}));
}finally{await env.cleanup();}
