import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createRestBackupApi} from '../ops-backup-rest.mjs';
import {scanSource,scanRepository} from '../ops-path-schema-scan.mjs';
import {diagnoseMetadata} from '../ops-nested-policy-diagnostic.mjs';
const require=createRequire(import.meta.url), policy=require('../functions/backup-policy.js');
let passed=0; async function check(fn){await fn();passed++;}
const prefix='projects/demo-resq/databases/(default)/documents/', date='2026-10-02T00:00:00Z';
const calls=[];
function api(pages,options={}) {return createRestBackupApi({projectId:'demo-resq',metadataOnly:true,
  getCredential:async()=>({access_token:'fake'}),fetchImpl:async(url)=>{calls.push(url);return new Response(JSON.stringify(pages.shift()),{headers:{'content-type':'application/json'}});},...options});}
const a=api([{documents:[{name:prefix+'a/secret-id',createTime:date,updateTime:date}],nextPageToken:'page2'},
  {documents:[{name:prefix+'a/missing'}]}]);
await check(()=>assert.equal(a.listDocuments,undefined));
await check(async()=>assert.deepEqual(await a.listDocumentMetadata('a'),{documents:[{path:'a/secret-id',exists:true}],nextPageToken:'page2'}));
await check(async()=>assert.deepEqual(await a.listDocumentMetadata('a','page2'),{documents:[{path:'a/missing',exists:false}],nextPageToken:undefined}));
await check(()=>assert.ok(calls.every(u=>new URL(u).searchParams.get('mask.fieldPaths')==='__name__' && new URL(u).searchParams.get('fields')==='documents(name,createTime,updateTime),nextPageToken')));
for(const fields of [{}, {sensitive:{stringValue:'never output'}}]) await check(()=>assert.rejects(api([{documents:[{name:prefix+'a/b',createTime:date,updateTime:date,fields}]}]).listDocumentMetadata('a'),/INVALID/));
await check(()=>assert.equal(typeof api([],{metadataOnly:false}).listDocuments,'function'));
await check(()=>assert.throws(()=>api([],{metadataOnly:'true'}),/INVALID/));
const nested={listCollectionPaths:async p=>p===undefined?['stations']:p==='stations/private-id'?['stations/private-id/new_unknown']:[],
  listDocumentMetadata:async p=>({documents:[{path:p+'/private-id',exists:p!=='stations'}]})};
let result;
await check(async()=>{result=await diagnoseMetadata(nested,policy,new Set(['stations']));assert.equal(result.missingParents,1);assert.equal(result.documents,1);assert.equal(result.policyCoverageVerified,false);});
await check(()=>assert.ok(!JSON.stringify(result).includes('private-id') && !JSON.stringify(result).includes('new_unknown')));
await check(()=>assert.rejects(diagnoseMetadata({...nested,listDocuments:()=>{}},policy,new Set()),/INTERFACE/));
await check(()=>assert.rejects(diagnoseMetadata(nested,policy,new Set(),{maxCollections:1}),/BOUND/));
await check(()=>{const r=scanSource("const base=db.collection('stations').doc(sid);base.collection('faults').doc(fid);");assert.ok(r.findings.some(f=>f.pattern==='stations/{?}/faults/{?}'));assert.ok(r.unresolved.length>0);});
await check(()=>{const r=scanSource("import {doc as d} from 'firebase/firestore';d(db,`stations/${sid}/hours/${id}`)");assert.equal(r.findings.length,1);assert.equal(r.findings[0].pattern,'stations/{?}/hours/{?}');});
await check(()=>assert.equal(scanSource('const = invalid').unresolved[0].kind,'parse_failure'));
await check(()=>assert.ok(scanSource("getRef(x); db[unknown](x)").unresolved.length===2));
console.log(JSON.stringify({passed,synthetic:true,liveReads:0}));
