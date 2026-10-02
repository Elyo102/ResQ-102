import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRestBackupApi,convertRestValue} from '../ops-backup-rest.mjs';
import {runBackup,verifySet,readSet,documentHash} from '../ops-disaster-restore.mjs';
const prefix='projects/demo-resq/databases/(default)/documents', date='2026-10-02T00:00:00Z';
let passed=0;
async function check(fn) { await fn(); passed++; }
const doc=(p,fields={})=>({name:prefix+'/'+p,fields,createTime:date,updateTime:date});
function api(responses,extra={}) { const calls=[]; return {calls,client:createRestBackupApi({projectId:'demo-resq',
  getCredential:async()=>({access_token:'synthetic-only'}),fetchImpl:async(url,init)=>{
    calls.push({url,init});return new Response(JSON.stringify(responses.shift()),{headers:{'content-type':'application/json'}});},...extra})}; }
await check(()=>assert.throws(()=>convertRestValue({mapValue:{fields:null}},prefix)));
await check(()=>assert.throws(()=>convertRestValue({geoPointValue:{latitude:0,longitude:0,extra:1}},prefix)));
for(const d of [{...doc('stations/x'),fields:null},{name:prefix+'/stations/x',unsupported:{}}])
  await check(async()=>{await assert.rejects(api([{documents:[d]}]).client.listDocuments('stations'));});
await check(async()=>{await assert.rejects(api([],{getCredential:()=>new Promise(()=>{}),timeoutMs:10}).client.listCollectionPaths(),/TIMEOUT/);});
await check(async()=>{await assert.rejects(api([],{fetchImpl:()=>new Promise(()=>{}),timeoutMs:10}).client.listCollectionPaths(),/TIMEOUT/);});
await check(async()=>{const {client}=api([{nextPageToken:'a'},{}],{maxTotalBytes:22});await assert.rejects(client.listCollectionPaths(),/LIMIT/);});
await check(async()=>{const {client}=api([{documents:[{name:prefix+'/stations/a'},{name:prefix+'/stations/b'}]}],{maxDocuments:1});await assert.rejects(client.listDocuments('stations'));});
await check(async()=>{
  const root=fs.mkdtempSync(fileURLToPath(new URL('../outputs/rest-nested-',import.meta.url)));
  fs.mkdirSync(path.join(root,'functions'));
  fs.copyFileSync(fileURLToPath(new URL('../functions/backup-policy.js',import.meta.url)),path.join(root,'functions/backup-policy.js'));
  const fields={v:{timestampValue:'2026-10-02T00:00:00.123456789Z'},label:{stringValue:'synthetic'}};
  const {client,calls}=api([{collectionIds:['stations']},{documents:[{name:prefix+'/stations/eilat_102'},doc('stations/empty')]},
    {collectionIds:['feedback']},{documents:[doc('stations/eilat_102/feedback/test',fields)]},{},{}]);
  const options={root,firestoreApi:client,sealPassphrase:'synthetic-nested-only',inMemoryUnseal:true};
  const result=await runBackup({source:'demo-resq',out:'_גיבוי',dryRun:false},options);
  assert.equal(result.documents,2);assert.equal(verifySet(result.destination,options).content_verified,true);
  const set=readSet(result.destination,options);
  const serialized=JSON.stringify(set);
  assert.ok(serialized.includes('stations/eilat_102/feedback/test'));
  assert.ok(serialized.includes('stations/empty'));
  assert.ok(serialized.includes(documentHash({v:{__ts:'2026-10-02T00:00:00.123Z',__nanos:456789},label:'synthetic'})));
  assert.equal(calls.length,6);assert.ok(calls[2].url.endsWith('/stations/eilat_102:listCollectionIds'));
  assert.equal(fs.existsSync(path.join(result.destination,'documents.jsonl')),false);
});
console.log(JSON.stringify({syntheticOnly:true,passed,failed:0}));
