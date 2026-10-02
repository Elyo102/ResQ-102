import assert from 'node:assert/strict';
import {assertIamEnvironment,boundedIamRequest} from '../ops-hmac-secret-iam.mjs';
import {createBackupRefreshHandler} from '../ops-backup-cli-credential.mjs';
let passed=0;
for(const key of ['FIREBASE_TOKEN_URL','FIREBASE_GOOGLE_URL','FIREBASE_AUTH_URL','firebase_custom_origin','https_proxy','ALL_PROXY','FIREBASE_TOKEN','FIRESTORE_EMULATOR_HOST']){assert.throws(()=>assertIamEnvironment({[key]:'synthetic'}));passed++;}
assert.doesNotThrow(()=>assertIamEnvironment({}));passed++;
let calls=0;
await assert.rejects(boundedIamRequest('https://example.invalid',null,{getCredential:()=>new Promise(()=>{}),fetchImpl:()=>{calls++;},timeoutMs:10}),/TIMEOUT/);passed++;
assert.equal(calls,0);passed++;
await assert.rejects(boundedIamRequest('https://example.invalid',null,{getCredential:createBackupRefreshHandler(async()=>({access_token:'fake',expires_at:0})),fetchImpl:()=>{calls++;}}),/valid CLI token/);passed++;
assert.equal(calls,0);passed++;
console.log(JSON.stringify({synthetic:true,passed,cloudCalls:0}));
