import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {connectCloud,verifyIdentity,boundedJson,validateBudgetWrites,PROJECT,DATABASE} from './ci-cloud.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const certs={test:publicKey.export({type:'spki',format:'pem'})};
const scope={authorizationId:'synthetic-grant-001',principal:'resq-ci-budget-20260928',approvedSha:'a'.repeat(40)};
function token(patch={}){const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url');
 const body=Buffer.from(JSON.stringify({aud:PROJECT,iss:`https://securetoken.google.com/${PROJECT}`,sub:'resq-ci-budget-20260928',iat:now,auth_time:now,exp:now+300,control_plane_budget:true,control_plane_authorization:scope.authorizationId,...patch})).toString('base64url');
 const s=createSign('RSA-SHA256');s.update(head+'.'+body);s.end();return head+'.'+body+'.'+s.sign(privateKey).toString('base64url');}
test('budget identity rejects wrong project, signature, role, expiry and UID',()=>{
 const expected={uid:'resq-ci-budget-20260928',budget:true,...scope};verifyIdentity(token(),certs,expected);
 for(const patch of [{aud:'station-102'},{sub:'owner'},{control_plane_agent:'Codex'},{control_plane_budget:false},{exp:1}])assert.throws(()=>verifyIdentity(token(patch),certs,expected));
 assert.throws(()=>verifyIdentity(token(),{},expected));
 assert.throws(()=>verifyIdentity(token({control_plane_authorization:'other-grant'}),certs,expected));
 assert.throws(()=>verifyIdentity(token(),certs,{...expected,principal:'other'}));
});
async function fixture(row){const seen=[];const fetcher=async(url,init)=>{seen.push({url,init});
 return new Response(JSON.stringify(url.includes('securetoken.googleapis.com')?{user_id:'resq-ci-budget-20260928',project_id:'802712493259',id_token:token()}:url.includes('robot/v1')?certs:row));};
 const cloud=await connectCloud({uid:'resq-ci-budget-20260928',budget:true,...scope,refreshToken:'synthetic-refresh-token',fetcher});return {cloud,seen};}
test('server clock requires exact document and valid timestamp; forbidden paths never dispatch',async()=>{
 const row={found:{name:`${DATABASE}/documents/resq_budget_state/policy`},readTime:new Date().toISOString()};
 const x=await fixture([row]);assert.ok(await x.cloud.serverNow());const count=x.seen.length;
 await assert.rejects(x.cloud.get('private_access/owner'));await assert.rejects(x.cloud.emit('heartbeat','running'));assert.equal(x.seen.length,count);
 await assert.rejects(x.cloud.get('resq_budget_authorizations/other-grant'));await assert.rejects(x.cloud.get('resq_budget_state/policy/operations/'+'a'.repeat(64)));assert.equal(x.seen.length,count);
 for(const bad of [[{...row,found:{name:'wrong'}}],[{...row,readTime:'yesterday'}],[]])await assert.rejects((await fixture(bad)).cloud.serverNow());
});
test('network and streaming errors are sanitized and never retried',async()=>{
 let calls=0;await assert.rejects(boundedJson(async()=>{calls++;throw Error('secret-token');},'https://example.test'),/REMOTE_UNAVAILABLE/);assert.equal(calls,1);
 const response={ok:true,body:{getReader:()=>({read:async()=>{throw Error('secret-token');},cancel:async()=>{throw Error('secret-token');}})}};
 await assert.rejects(boundedJson(async()=>response,'https://example.test'),/RESPONSE_UNAVAILABLE/);
});

test('deadline bounds uncooperative fetch and body reads without retry',async()=>{
 let calls=0;
 await assert.rejects(boundedJson(()=>{calls++;return new Promise(()=>{});},'https://example.test',{},5),/REMOTE_UNAVAILABLE/);
 assert.equal(calls,1);
 await assert.rejects(boundedJson(async()=>({ok:true,body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})})}}),'https://example.test',{},5),/REMOTE_UNAVAILABLE/);
});

const str=stringValue=>({stringValue}),int=n=>({integerValue:String(n)});
function writes(){
 const provider='Claude',id=scope.authorizationId+'_'+provider,time='2026-09-29T09:00:00.000Z';
 const operation={mapValue:{fields:{id:str(id),provider:str(provider),task:str('planner_draft_recovery'),chargedMicroUsd:int(250000),requestDigest:str('a'.repeat(64))}}};
 return [
  {update:{name:DATABASE+'/documents/resq_budget_state/month_2026-09',fields:{chargedMicroUsd:int(250000),lastOperationId:str(id),lastAuthorizationId:str(scope.authorizationId)}},updateMask:{fieldPaths:['chargedMicroUsd','lastOperationId','lastAuthorizationId']},currentDocument:{updateTime:time}},
  {update:{name:DATABASE+'/documents/resq_budget_authorizations/'+scope.authorizationId,fields:{chargedMicroUsd:int(250000),reservationCount:int(1),reservedProviders:{arrayValue:{values:[str(provider)]}},lastOperationId:str(id),operations:{mapValue:{fields:{Claude:operation}}}}},updateMask:{fieldPaths:['chargedMicroUsd','reservationCount','reservedProviders','lastOperationId','operations.Claude']},currentDocument:{updateTime:time},updateTransforms:[{fieldPath:'operations.Claude.createdAt',setToServerValue:'REQUEST_TIME'}]}
 ];
}
test('transport validates two linked masked CAS writes and refuses unrelated mutations',async()=>{
 assert.equal(validateBudgetWrites(writes(),{budget:true,...scope}),true);
 for(const change of [
  w=>w.pop(),w=>w.push(w[0]),w=>w.reverse(),w=>w[0].update.name=DATABASE+'/documents/private_access/owner',
  w=>w[1].currentDocument={exists:false},w=>w[0].currentDocument.updateTime='bad',
  w=>w[1].update.name+='-other',w=>w[0].update.fields.lastAuthorizationId=str('other-grant'),
  w=>w[1].updateMask.fieldPaths[4]='operations',w=>w[1].updateTransforms[0].fieldPath='operations.Grok.createdAt',
  w=>w[1].update.fields.operations.mapValue.fields.Claude.mapValue.fields.task=str('swap_race_review'),
  w=>w[1].update.fields.operations.mapValue.fields.Claude.mapValue.fields.chargedMicroUsd=int(1),
  w=>w[1].update.fields.operations.mapValue.fields.Grok=w[1].update.fields.operations.mapValue.fields.Claude
 ]){const w=writes();change(w);assert.throws(()=>validateBudgetWrites(w,{budget:true,...scope}),/CLOUD_PATH_DENIED/);}
 const x=await fixture({});const before=x.seen.length;
 await assert.rejects(x.cloud.commit([writes()[0]]));assert.equal(x.seen.length,before);
});

test('event transport preserves bounded new task label and rejects arbitrary text',async()=>{
 const seen=[],uid='resq-ci-codex-20260928';
 const fetcher=async(url,init)=>{seen.push({url,init});return new Response(JSON.stringify(url.includes('securetoken.googleapis.com')?{user_id:uid,project_id:'802712493259',id_token:token({sub:uid,control_plane_budget:undefined,control_plane_agent:'Codex'})}:url.includes('robot/v1')?certs:{writeResults:[{}]}));};
 const cloud=await connectCloud({uid,agent:'Codex',refreshToken:'synthetic-refresh-token',fetcher});
 await cloud.emit('task_started','started','agent_review_cycle');
 assert.equal(JSON.parse(seen.at(-1).init.body).writes[0].update.fields.task.stringValue,'agent_review_cycle');
 const n=seen.length;await assert.rejects(cloud.emit('heartbeat','running','secret raw log'));assert.equal(seen.length,n);
});
