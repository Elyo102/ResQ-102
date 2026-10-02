// Full original application graph, with exactly three native Git/ZIP/archive suites run in
// a sanitized native process. This is not an OS-level native egress sandbox.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {currentEvidence,writeReceipt} from '../release-attestation.mjs';
import {buildHours46Plan,assertSuccessful,runHours46Sequence} from './lib/hours46-gate-contract.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));
const self=fileURLToPath(import.meta.url);
// NODE_OPTIONS is parsed again by child processes: Windows backslashes inside
// quoted arguments can be consumed. Forward slashes preserve the exact preload.
const guardFile=path.join(here,'lib/network-guard.cjs').replaceAll('\\','/');
const scripts=JSON.parse(fs.readFileSync(path.join(here,'package.json'),'utf8')).scripts;
const plan=buildHours46Plan(scripts);
assert.equal(Number(process.versions.node.split('.')[0]),22,'NODE22_REQUIRED');
const npm=process.env.npm_execpath;
assert.ok(npm&&path.isAbsolute(npm)&&fs.statSync(npm).isFile(),'NPM_ENTRY_REQUIRED');
const launch=(args,env)=>spawnSync(process.execPath,args,{cwd:here,env,stdio:'inherit',windowsHide:true,timeout:7200000});

if(process.argv.length===3&&process.argv[2]==='--contained'){
  const guard=createRequire(import.meta.url)(guardFile);guard.assertActive();
  console.log('HOURS46_CONTAINED_PLAN',JSON.stringify({steps:plan.steps.length,separateNative:plan.native}));
  for(const step of plan.steps){
    console.log('HOURS46_STEP',step.kind,step.name||step.file);
    assertSuccessful(launch(step.kind==='npm'?[npm,'run',step.name]:[...(step.execArgv||[]),path.resolve(here,step.file),...step.args],process.env),step.name||step.file);
    guard.assertClean();
  }
  guard.assertClean();
}else{
  assert.equal(process.argv.length,2,'UNKNOWN_GATE_ARGUMENT');
  assert.ok(!process.env.RESQ_CONTAINMENT_DIR&&!process.env.NODE_OPTIONS&&!globalThis[Symbol.for('resq.test.networkContainment')],'NESTED_OR_AMBIENT_PRELOAD_FORBIDDEN');
  for(const key of ['GCLOUD_PROJECT','GOOGLE_CLOUD_PROJECT'])assert.ok(!process.env[key]||process.env[key]==='demo-resq','DEMO_PROJECT_REQUIRED');
  assert.ok(!process.env.FIRESTORE_EMULATOR_HOST||/^127\.0\.0\.1:(8191|8199)$/.test(process.env.FIRESTORE_EMULATOR_HOST),'LOCAL_EMULATOR_REQUIRED');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'resq-hours46-gate-'));
  const env={...process.env,RESQ_CONTAINMENT_DIR:directory,NODE_OPTIONS:'--require '+JSON.stringify(guardFile),GCLOUD_PROJECT:'demo-resq',GOOGLE_CLOUD_PROJECT:'demo-resq',FIREBASE_CONFIG:JSON.stringify({projectId:'demo-resq'})};
  delete env.FIREBASE_TOKEN;delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.RESQ_CHROMIUM;delete env.FIREBASE_EMULATOR_HUB;
  env.METADATA_SERVER_DETECTION='none';
  if(process.platform!=='win32')env.npm_config_script_shell='/bin/sh';
  console.log('HOURS46_GATE_EVIDENCE',directory);
  await runHours46Sequence({
    evidence:()=>currentEvidence(),
    contract:()=>assertSuccessful(launch([path.join(here,'hours46-gate.test.mjs')],env),'gate-contract'),
    native:()=>launch([path.join(here,'lib/hours46-native-ops.mjs')],process.env),
    contained:()=>launch([self,'--contained'],env),
    ledger:()=>{const file=path.join(directory,'violations.log');assert.ok(!fs.existsSync(file)||fs.statSync(file).size===0,'CONTAINMENT_LEDGER_DIRTY');},
    attest:()=>{const result=writeReceipt();console.log('HOURS46_LOCAL_VALIDATION_RECEIPT',result.receipt.tree);return result;}
  });
}
