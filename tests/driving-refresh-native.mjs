import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),admin=require('../functions/node_modules/firebase-admin');
assert.equal(process.env.GCLOUD_PROJECT,'demo-resq');assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8191');
const {createDrivingRefresh}=require('../functions/driving-refresh');
const rr=createRequire(new URL('../rules-test/package.json',import.meta.url));const {initializeTestEnvironment,assertFails}=rr('@firebase/rules-unit-testing');const {doc,getDoc,setDoc}=rr('firebase/firestore');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const app=admin.initializeApp({projectId:'demo-resq'},'driving-native');const db=app.firestore();const sid='driving_native_'+Date.now(),root=db.collection('stations').doc(sid);
const people={driver:['נהג','firefighter','B'],deputy:['סגן','deputy','B'],commander:['מפקד','commander','B'],other:['משמרת אחרת','firefighter','A']};
for(const [uid,[name,role,crew]]of Object.entries(people))await root.collection('users').doc(uid).set({station:sid,full_name:name,role,crew,is_active:true});
const service=createDrivingRefresh({db,HttpsError,clock:()=>Date.parse('2026-10-02T09:30:00.000Z')});const request=(uid,data)=>({auth:{uid,token:{stationId:sid,role:people[uid][1]}},data});let checks=0;
const data={request_id:'native_request_123',vehicle:'משאית 12',hours:3};const saved=await service.save(request('driver',data));assert.equal((await service.save(request('driver',data))).replayed,true);checks++;
const before=(await root.collection('driving_refresh_reports').doc(saved.id).get()).data();await service.save(request('driver',{...data,request_id:'native_edit_123',report_id:saved.id,revision:1,hours:5}));const after=(await root.collection('driving_refresh_reports').doc(saved.id).get()).data();assert.equal(after.created_at,before.created_at);assert.equal(after.hours,5);assert.equal((await root.collection('driving_refresh_reports').doc(saved.id).collection('edits').get()).size,2);checks+=3;
await assert.rejects(service.save(request('driver',{...data,request_id:'native_edit_124',report_id:saved.id,revision:1})),{code:'aborted'});checks++;
assert.equal((await service.list(request('deputy',{uid:'driver'}))).rows.length,1);checks++;await assert.rejects(service.list(request('deputy',{uid:'other'})),{code:'permission-denied'});checks++;
assert.equal((await service.summary(request('deputy',{month:'2026-10'}))).hours,5);assert.equal((await service.context(request('driver',{}))).annual,true);checks+=2;
const env=await initializeTestEnvironment({projectId:'demo-resq',firestore:{host:'127.0.0.1',port:8191,rules:fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8')}});
try{for(const role of ['firefighter','deputy','commander','station_commander']){const client=env.authenticatedContext('fixture_'+role,{role,stationId:sid}).firestore();await assertFails(getDoc(doc(client,'stations',sid,'driving_refresh_reports',saved.id)));await assertFails(setDoc(doc(client,'stations',sid,'driving_refresh_reports','forged_report'),{uid:'driver',hours:12}));await assertFails(setDoc(doc(client,'stations',sid,'driving_refresh_reports',saved.id,'edits','forged_event'),{uid:'driver'}));checks+=3;}}finally{await env.cleanup();await app.delete();}
console.log('DRIVING_REFRESH_NATIVE_PASS',checks,'assertions; real local Firestore transactions/Rules, synthetic callable identity; no production access');
