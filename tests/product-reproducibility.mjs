// Adapted from resq-ci-review-dev 6d826bb tests/reproducibility.mjs and its
// reviewed working-tree ancestor lstat guard. Product scope only; no UI imports.
import {lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
export const ENTRYPOINTS=Object.freeze([
  "functions/hr-shift-change.integration.test.js",
  "tests/hr-requests-browser.mjs",
  "functions/schedule-replicate.test.js",
  "functions/schedule-replication.integration.test.js",
  "functions/schedule-replication-boundary.integration.test.js",
  "functions/schedule-replication-control.test.mjs",
  "tests/schedule-replication-browser.mjs",
  "functions/outbox-operation.integration.test.js",
  "functions/outbox-operation-boundary.integration.test.js",
  "functions/outbox-ack-race.integration.test.js"
]);
export const INPUTS=Object.freeze([
  "tests/product-reproducibility-inputs.json",
  "tests/product-reproducibility.mjs",
  "tests/product-reproducibility.test.mjs",
  "docs/PRODUCT_TEST_REPRODUCIBILITY.md",
  "tests/package.json",
  "tests/package-lock.json",
  "functions/package.json",
  "functions/package-lock.json",
  "rules-test/package.json",
  "rules-test/package-lock.json",
  "tests/lib/contained-playwright.cjs",
  "tests/lib/localize-worker.mjs",
  "tests/lib/network-guard.cjs",
  "tests/lib/loopback-proxy.cjs",
  "tests/stub/firebase-functions.js",
  "tests/stub/firebase-firestore.js",
  "tests/stub/firebase-auth.js",
  "tests/stub/firebase-app.js",
  "tests/stub/firebase-messaging.js",
  "tests/_schedule-fake.mjs",
  "functions/schedule-edit.integration.test.js",
  "functions/index.js",
  "functions/hr-requests.js",
  "functions/hr-domain-dispatch.js",
  "functions/schedule-runtime.js",
  "functions/schedule-replicate.js",
  "functions/schedule-edit.js",
  "functions/schedule-month-control-runtime.js",
  "functions/schedule-outbox-fair-scan.js",
  "schedule-management.js",
  "schedule-management.html",
  "hr-requests-ui.js",
  "hr-requests-client.js",
  "hr-requests.html",
  "hr-requests-ui.css",
  "firebase-messaging-sw.js",
  "firebase.json",
  "firebase.hr48-emulator.json",
  "firestore.rules",
  "firestore.indexes.json"
]);
const fail=message=>{throw Error(message);};
export function validateName(name){
  if(typeof name!=='string'||!name||/[\\:\0]/.test(name)||path.isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))fail('INVALID_PATH');
  if(/^(?:control-plane|public\/status)(?:\/|$)/i.test(name)||/(?:^|\/)(?:outputs?|secrets?|test-results|playwright-report|node_modules|\.git)(?:\/|$)|vault|provision|credential|\.env|\.(?:log|trace|zip|pem)$/i.test(name))fail('PRIVATE_INPUT_DENIED');
}
// Trusted root; existing symlinks are rejected, not TOCTOU races or hardlinks.
export function assertInputPath(root,name,stat=lstatSync){
  validateName(name);let target=root;const parts=name.split('/');
  for(let i=0;i<parts.length;i++){
    target=path.join(target,parts[i]);let value;
    try{value=stat(target);}catch(error){if(error.code==='ENOENT')fail('MISSING_INPUT: '+name);throw error;}
    if(value.isSymbolicLink())fail('SYMLINK_INPUT: '+name);
    if(i<parts.length-1?!value.isDirectory():!value.isFile())fail('NON_REGULAR_INPUT: '+name);
  }
  return target;
}
export function parseCandidateIndex(text){
  const entries=new Map();
  for(const record of String(text).split('\0').filter(Boolean)){
    const match=/^([0-9]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/.exec(record);
    if(!match)fail('INVALID_INDEX_ENTRY');
    const rows=entries.get(match[4])||[];
    rows.push({mode:match[1],oid:match[2],stage:Number(match[3])});entries.set(match[4],rows);
  }
  return entries;
}
export function candidateEntry(entries,name){
  validateName(name);const rows=entries.get(name)||[];
  if(!rows.length)fail('UNTRACKED_INPUT: '+name);
  if(rows.length!==1||rows[0].stage!==0)fail('CONFLICT_INPUT: '+name);
  if(/^0+$/.test(rows[0].oid))fail('INTENT_TO_ADD_INPUT: '+name);
  if(!['100644','100755'].includes(rows[0].mode))fail('NON_REGULAR_INPUT: '+name);
  return rows[0];
}
export function validateManifest(manifest){
  if(manifest?.schema!==1||manifest.scope!=='product-partial-e00'||!Array.isArray(manifest.entrypoints)||!Array.isArray(manifest.inputs))fail('INVALID_MANIFEST');
  const names=[...manifest.entrypoints,...manifest.inputs];names.forEach(validateName);
  if(new Set(names).size!==names.length)fail('DUPLICATE_INPUT');
  const same=(a,b)=>a.slice().sort().join('\n')===b.slice().sort().join('\n');
  if(!same(manifest.entrypoints,ENTRYPOINTS)||!same(manifest.inputs,INPUTS))fail('PRODUCT_INVENTORY_CHANGED');
  return names;
}
export function validateInventory({manifest,entries,workingOid,read}){
  const names=validateManifest(manifest);
  for(const name of names){
    const entry=candidateEntry(entries,name);
    if(workingOid(name)!==entry.oid)fail('DIRTY_INPUT: '+name);
    const bytes=read(name);if(!Buffer.isBuffer(bytes)||!bytes.length)fail('MISSING_INPUT: '+name);
  }
  return {entrypoints:manifest.entrypoints.length,declaredInputs:names.length};
}
export function checkCheckout(root=fileURLToPath(new URL('../',import.meta.url))){
  const git=(args,encoding='utf8')=>execFileSync('git',args,{cwd:root,encoding,maxBuffer:16*1024*1024,windowsHide:true});
  const entries=parseCandidateIndex(git(['ls-files','--stage','-z']));
  const read=name=>{assertInputPath(root,name);return git(['cat-file','blob',candidateEntry(entries,name).oid],null);};
  const workingOid=name=>{assertInputPath(root,name);return git(['hash-object','--path='+name,name]).trim();};
  const manifestName='tests/product-reproducibility-inputs.json';
  // Validate manifest's index identity before interpreting its staged contents.
  if(workingOid(manifestName)!==candidateEntry(entries,manifestName).oid)fail('DIRTY_INPUT: '+manifestName);
  const manifest=JSON.parse(read(manifestName).toString('utf8'));
  return {...validateInventory({manifest,entries,workingOid,read}),baseHead:git(['rev-parse','HEAD']).trim(),
    scope:'E00 partial product index inputs only; E01 clean install/run OPEN; separate control-plane contract retained in donor'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(checkCheckout()));}catch(error){console.error(error.message);process.exitCode=1;}
}
