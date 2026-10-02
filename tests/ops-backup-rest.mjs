import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRestBackupApi,convertRestValue,convertRestFields} from '../ops-backup-rest.mjs';
import {runBackup,verifySet} from '../ops-disaster-restore.mjs';
const prefix='projects/demo-resq/databases/(default)/documents';
const date='2026-10-02T00:00:00Z';
const doc=(p,fields={})=>({name:prefix+'/'+p,fields,createTime:date,updateTime:date});
let passed=0;
async function check(fn) { await fn(); passed++; }
function api(responses,extra={}) {
  const calls=[];
  return {calls,client:createRestBackupApi({projectId:'demo-resq',getCredential:async()=>({access_token:'synthetic-only'}),
    fetchImpl:async(url,init)=>{calls.push({url,init}); const value=responses.shift(); if(typeof value==='function') return value(url,init);
      return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});},...extra})};
}
const cv=v=>convertRestValue(v,prefix);
await check(()=>assert.equal(cv({nullValue:null}),null));
await check(()=>assert.equal(cv({booleanValue:false}),false));
await check(()=>assert.equal(cv({stringValue:'עברית 🚒'}),'עברית 🚒'));
await check(()=>assert.equal(cv({integerValue:'9007199254740991'}),Number.MAX_SAFE_INTEGER));
await check(()=>assert.equal(cv({doubleValue:8.5}),8.5));
await check(()=>assert.deepEqual(cv({timestampValue:'1969-12-31T23:59:59.123456789Z'}),{__ts:'1969-12-31T23:59:59.123Z',__nanos:456789}));
await check(()=>assert.deepEqual(cv({bytesValue:'AAH/'}),{__bytes:'AAH/'}));
await check(()=>assert.deepEqual(cv({referenceValue:prefix+'/stations/x'}),{__ref:'stations/x'}));
await check(()=>assert.deepEqual(cv({geoPointValue:{latitude:29,longitude:35}}),{__geo:{lat:29,lng:35}}));
await check(()=>assert.deepEqual(cv({arrayValue:{values:[{mapValue:{}},{arrayValue:{}}]}}),[{},[]]));
for(const invalid of [{integerValue:'9007199254740992'},{doubleValue:'NaN'},{doubleValue:Infinity},{doubleValue:-0},
  {timestampValue:'2026-02-30T00:00:00Z'},{bytesValue:'!bad'},{referenceValue:'projects/other/databases/(default)/documents/a/b'},
  {geoPointValue:{latitude:91,longitude:0}},{nullValue:'NULL_VALUE'},{booleanValue:'true'}, {},{stringValue:'x',integerValue:'1'},
  {mapValue:{fields:{__ref:{stringValue:'a/b'}}}},{mapValue:{fields:JSON.parse('{"__proto__":{"stringValue":"x"}}')}},
  {mapValue:{fields:{latitude:{integerValue:'1'},longitude:{integerValue:'2'}}}},
  {mapValue:{fields:{path:{stringValue:'x'},firestore:{mapValue:{}}}}}]) await check(()=>assert.throws(()=>cv(invalid)));
await check(async()=>{ const {client,calls}=api([{collectionIds:['stations'],nextPageToken:'opaque+/='},{collectionIds:['users']}]);
  assert.deepEqual(await client.listCollectionPaths(),['stations','users']); assert.equal(calls.length,2);
  assert.equal(JSON.parse(calls[1].init.body).pageToken,'opaque+/='); assert.equal(calls[0].init.redirect,'error'); });
await check(async()=>{ const {client,calls}=api([{documents:[doc('stations/a')],nextPageToken:'opaque+/='},{documents:[doc('stations/b')]}]);
  const first=await client.listDocuments('stations'); assert.deepEqual(first.documents[0].data,{});
  await client.listDocuments('stations',first.nextPageToken); assert.equal(new URL(calls[1].url).searchParams.get('pageToken'),'opaque+/=');
  assert.equal(new URL(calls[0].url).searchParams.get('showMissing'),'true'); });
await check(async()=>{ const {client,calls}=api([{}]); await client.listCollectionPaths('stations/a?#%'); assert.ok(calls[0].url.includes('a%3F%23%25')); });
await check(async()=>{ const {client}=api([{documents:[{name:prefix+'/stations/missing'}]}]); assert.equal((await client.listDocuments('stations')).documents[0].data,null); });
for(const envelope of [{documents:'bad'},{unexpected:true},{documents:[doc('users/x')]},
  {documents:[{...doc('stations/x'),name:'projects/other/databases/(default)/documents/stations/x'}]},
  {documents:[{name:prefix+'/stations/x',fields:{}}]}, {documents:[doc('stations/x'),doc('stations/x')]}])
  await check(async()=>{const {client}=api([envelope]); await assert.rejects(client.listDocuments('stations'));});
await check(async()=>{const {client}=api([{collectionIds:['x'],nextPageToken:'a'},{collectionIds:['y'],nextPageToken:'a'}]);await assert.rejects(client.listCollectionPaths());});
await check(async()=>{const {client}=api([{collectionIds:['x','x']}]);await assert.rejects(client.listCollectionPaths());});
await check(async()=>{const {client}=api([{documents:[doc('stations/x')],nextPageToken:'a'},{documents:[doc('stations/x')]}]);await client.listDocuments('stations');await assert.rejects(client.listDocuments('stations','a'));});
await check(async()=>{const {client}=api([{nextPageToken:'a'},{nextPageToken:'a'}]);await client.listDocuments('stations');await assert.rejects(client.listDocuments('stations','a'));});
await check(async()=>{const {client,calls}=api([()=>new Response('not printed',{status:403})]);await assert.rejects(client.listCollectionPaths(),e=>e.code===403);assert.equal(calls.length,1);});
await check(async()=>{const {client,calls}=api([()=>{throw Error('synthetic redirect');}]);await assert.rejects(client.listCollectionPaths());assert.equal(calls.length,1);});
await check(async()=>{const {client,calls}=api([],{getCredential:async()=>{throw Error('synthetic auth failure');}});await assert.rejects(client.listCollectionPaths());assert.equal(calls.length,0);});
await check(async()=>{const {client}=api([()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})],{timeoutMs:15});await assert.rejects(client.listCollectionPaths(),/TIMEOUT/);});
await check(async()=>{const {client}=api([{collectionIds:['stations']}],{maxResponseBytes:8});await assert.rejects(client.listCollectionPaths(),/LIMIT/);});
await check(async()=>{const {client,calls}=api([{nextPageToken:'a'}],{maxRequests:1});await assert.rejects(client.listCollectionPaths());assert.equal(calls.length,1);});
await check(async()=>{const {client,calls}=api([]);await assert.rejects(client.listCollectionPaths(Array(102).fill('x').join('/')));assert.equal(calls.length,0);});
await check(async()=>{const {client}=api([()=>new Response('not-json',{headers:{'content-type':'application/json'}})]);await assert.rejects(client.listCollectionPaths(),/JSON/);});
await check(()=>assert.throws(()=>createRestBackupApi({projectId:'other',getCredential:async()=>({})})));
// Full traversal and real encryption of synthetic fixtures only. Keep evidence locally.
await check(async()=>{
  const fixture=fs.mkdtempSync(fileURLToPath(new URL('../outputs/rest-backup-',import.meta.url)));
  fs.mkdirSync(path.join(fixture,'functions'));
  fs.copyFileSync(fileURLToPath(new URL('../functions/backup-policy.js',import.meta.url)),path.join(fixture,'functions/backup-policy.js'));
  const {client}=api([{collectionIds:['stations']},{documents:[doc('stations/eilat_102',{name:{stringValue:'synthetic'}})]},{}]);
  const options={root:fixture,firestoreApi:client,sealPassphrase:'synthetic-rest-backup-only',inMemoryUnseal:true};
  const result=await runBackup({source:'demo-resq',out:'_גיבוי',dryRun:false},options);
  assert.equal(result.documents,1);assert.equal(result.sealed,true);assert.equal(verifySet(result.destination,options).content_verified,true);
  assert.equal(fs.existsSync(path.join(result.destination,'documents.jsonl')),false);
});
console.log(JSON.stringify({syntheticOnly:true,passed,failed:0}));
