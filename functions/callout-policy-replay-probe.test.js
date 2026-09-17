'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'functions/index.js'),'utf8');
const body=source.slice(source.indexOf('exports.sendCallout ='),source.indexOf('exports.closeCallout ='));
assert.match(body,/delivery_state === 'policy_blocked'/,'terminal replay patch must be present');
const sid='station_1',uid='commander_1',requestId='replay_policy_20260915',text='Mock callout',target='crew:A';
const calloutId='co_'+crypto.createHash('sha256').update(sid+'\0'+uid+'\0'+requestId).digest('hex').slice(0,40);
const intent=crypto.createHash('sha256').update(JSON.stringify({sid,uid,crew:'A',target,text})).digest('hex');
let record={by_uid:uid,request_id:requestId,intent_fingerprint:intent,uids:['recipient_1','recipient_2'],active:true,delivery_state:'policy_blocked',delivery_attempts:2,delivery_attempt_id:'prior_attempt',delivery_lease_until:null,people:1,devices:2,delivery_suppressed:1,delivery_suppressed_uids:['recipient_2'],trial:false};
let writes=0,providers=0,reads=0;
const snapshot=ref=>({exists:true,data:()=>structuredClone(record),ref});
const db={doc(p){assert.equal(p,'stations/'+sid+'/callouts/'+calloutId);return{path:p,id:calloutId};},collection(){return{where(){return this;},async get(){return{forEach(){}};}};},async runTransaction(fn){return fn({async get(ref){reads++;return snapshot(ref);},set(){writes++;throw Error('Terminal replay attempted a write');}});}};
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const context={exports:{},onCall:(_opts,fn)=>fn,CALLOUT_OPTIONS:{},db,crypto,HttpsError,console,Date,Array,Number,String,JSON,
 freshCalloutActor:async()=>({sid,role:'commander',crew:'A',name:'Mock Commander',claims:{},email:'mock@example.test',isSuper:false}),
 uidsInCrew:async()=>['recipient_1','recipient_2'],runtimeFresh:async()=>({silent:false}),CREW_HE_S:{A:'א׳'},CALLOUT_ROLE_HE:{commander:'מפקד'},hhmmIL:()=>'',FV:{serverTimestamp:()=>1},
 pushToUsers:async()=>{providers++;throw Error('Terminal replay reached provider');},logSilenced:async()=>{}};
vm.createContext(context);vm.runInContext(body,context);
(async()=>{
 const before=structuredClone(record);
 for(let i=0;i<2;i++){
  const result=await context.exports.sendCallout({auth:{uid},data:{text,target,request_id:requestId}});
  assert.equal(result.policy_blocked,true);assert.equal(result.retryable,false);assert.equal(result.duplicate,true);assert.equal(result.ok,false);
  assert.equal(result.people,1);assert.equal(result.devices,2);assert.equal(result.sent,1);
 }
 assert.equal(writes,0);assert.equal(providers,0);assert.deepEqual(record,before);assert.equal(record.active,true);assert.equal(reads,4);
 console.log('PASS actual sendCallout repeated blocked replay: zero writes, zero provider, exact counts, active event preserved (mock actor/DB)');
})().catch(e=>{console.error(e);process.exitCode=1;});
