import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initializeTestEnvironment,assertFails} from '@firebase/rules-unit-testing';
import {doc,collection,getDoc,getDocs,setDoc,updateDoc,deleteDoc} from 'firebase/firestore';
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8199');
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');
const env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host:'127.0.0.1',port:8199,
  rules:fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
const paths=['invitations/fixture','onboarding_assignment_links/fixture','stations/fixture/onboarding_operations/fixture',
  'hr_invitation_operations/fixture','hr_invitation_recipients/fixture','stations/fixture/provision_operations/fixture',
  'system/heartbeat','system/unknown'];
let passed=0;
try {
  await env.withSecurityRulesDisabled(async ctx=>{for(const p of paths) await setDoc(doc(ctx.firestore(),p),{synthetic:true});});
  for(const ctx of [env.unauthenticatedContext(),env.authenticatedContext('fixture-user'),
    env.authenticatedContext('fixture-admin',{role:'super_admin',super_admin:true})]) {
    const db=ctx.firestore();
    for(const p of paths) {
      for(const action of [()=>getDoc(doc(db,p)),()=>getDocs(collection(db,p.slice(0,p.lastIndexOf('/')))),
        ()=>setDoc(doc(db,p+'-new'),{synthetic:true}),()=>updateDoc(doc(db,p),{synthetic:false}),()=>deleteDoc(doc(db,p))]) {
        await assertFails(action());passed++;
      }
    }
  }
  console.log(JSON.stringify({emulatorOnly:true,passed,failed:0,productionContacted:false}));
} finally {await env.cleanup();}
