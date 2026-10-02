import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadAdminApi } from '../ops-disaster-restore.mjs';
import { createBackupRefreshHandler } from '../ops-backup-cli-credential.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../functions/package.json',import.meta.url));
const admin=require('firebase-admin');
const before=admin.apps.length;
const refs=Array.from({length:301},(_,i)=>({path:'stations/s'+String(i).padStart(3,'0')}));
let lists=0, reads=0;
const db={projectId:'demo-resq',
  async listCollections(){return [{path:'stations'}];},
  doc(){return {async listCollections(){return [];}};},
  collection(){return {async listDocuments(){lists++;return refs;}};},
  async getAll(...page){reads++;return page.map((ref,i)=>({ref,exists:i!==0,data:()=>({synthetic:true})}));}
};
const api=await loadAdminApi('demo-resq',{root,firestoreDb:db});
assert.equal(admin.apps.length,before);
assert.deepEqual(await api.listCollectionPaths(),['stations']);
assert.deepEqual(await api.listCollectionPaths('stations/s000'),[]);
const first=await api.listDocuments('stations');
assert.equal(first.documents.length,300);
assert.equal(first.documents[0].data,null);
const last=await api.listDocuments('stations',first.nextPageToken);
assert.equal(last.documents.length,1);
assert.equal(last.nextPageToken,null);
assert.equal(lists,1);
assert.equal(reads,2);
await assert.rejects(loadAdminApi('station-102',{root,firestoreDb:db}),/project mismatch/);
assert.equal(admin.apps.length,before);
const refresh=createBackupRefreshHandler(async()=>({access_token:'synthetic-only',expires_at:2000}),()=>1000);
assert.deepEqual(await refresh(),{access_token:'synthetic-only',expiry_date:2000});
for(const token of [null,{}, {access_token:'',expires_at:2000}, {access_token:'synthetic',expires_at:1000}, {access_token:'synthetic',expires_at:'NaN'}]) {
  await assert.rejects(createBackupRefreshHandler(async()=>token,()=>1000)(),/valid CLI token unavailable/);
}
let attempts=0;
await assert.rejects(createBackupRefreshHandler(async()=>{attempts++;throw Error('synthetic failure');})(),/synthetic failure/);
assert.equal(attempts,1);
console.log(JSON.stringify({syntheticOnly:true,passed:19,failed:0,adminAppsCreated:admin.apps.length-before}));
