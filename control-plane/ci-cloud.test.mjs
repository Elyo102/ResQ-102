import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {connectCloud,verifyIdentity,boundedJson,PROJECT,DATABASE} from './ci-cloud.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const certs={test:publicKey.export({type:'spki',format:'pem'})};
function token(patch={}){const now=Math.floor(Date.now()/1000),head=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url');
 const body=Buffer.from(JSON.stringify({aud:PROJECT,iss:`https://securetoken.google.com/${PROJECT}`,sub:'resq-ci-budget-20260928',iat:now,auth_time:now,exp:now+300,control_plane_budget:true,...patch})).toString('base64url');
 const s=createSign('RSA-SHA256');s.update(head+'.'+body);s.end();return head+'.'+body+'.'+s.sign(privateKey).toString('base64url');}
test('budget identity rejects wrong project, signature, role, expiry and UID',()=>{
 const expected={uid:'resq-ci-budget-20260928',budget:true};verifyIdentity(token(),certs,expected);
 for(const patch of [{aud:'station-102'},{sub:'owner'},{control_plane_agent:'Codex'},{control_plane_budget:false},{exp:1}])assert.throws(()=>verifyIdentity(token(patch),certs,expected));
 assert.throws(()=>verifyIdentity(token(),{},expected));
});
async function fixture(row){const seen=[];const fetcher=async(url,init)=>{seen.push({url,init});
 return new Response(JSON.stringify(url.includes('securetoken.googleapis.com')?{user_id:'resq-ci-budget-20260928',project_id:'802712493259',id_token:token()}:url.includes('robot/v1')?certs:row));};
 const cloud=await connectCloud({uid:'resq-ci-budget-20260928',budget:true,refreshToken:'synthetic-refresh-token',fetcher});return {cloud,seen};}
test('server clock requires exact document and valid timestamp; forbidden paths never dispatch',async()=>{
 const row={found:{name:`${DATABASE}/documents/resq_budget_state/policy`},readTime:new Date().toISOString()};
 const x=await fixture([row]);assert.ok(await x.cloud.serverNow());const count=x.seen.length;
 await assert.rejects(x.cloud.get('private_access/owner'));await assert.rejects(x.cloud.emit('heartbeat','running'));assert.equal(x.seen.length,count);
 for(const bad of [[{...row,found:{name:'wrong'}}],[{...row,readTime:'yesterday'}],[]])await assert.rejects((await fixture(bad)).cloud.serverNow());
});
test('network and streaming errors are sanitized and never retried',async()=>{
 let calls=0;await assert.rejects(boundedJson(async()=>{calls++;throw Error('secret-token');},'https://example.test'),/REMOTE_UNAVAILABLE/);assert.equal(calls,1);
 const response={ok:true,body:{getReader:()=>({read:async()=>{throw Error('secret-token');},cancel:async()=>{throw Error('secret-token');}})}};
 await assert.rejects(boundedJson(async()=>response,'https://example.test'),/RESPONSE_UNAVAILABLE/);
});
