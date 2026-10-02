import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {planSecretAccessor,samePolicySemantics,assertIamEnvironment,boundedIamRequest} from './ops-hmac-secret-iam.mjs';
import {createBackupRefreshHandler} from './ops-backup-cli-credential.mjs';
import {sealDocumentsBuffer,unsealBuffer,SEALED_FILE_NAME} from './ops-backup-seal.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
let stage='preflight',writeAttempted=false,writeAcknowledged=false,verified=false,destination;
try {
  if(process.argv.length!==3 || process.argv[2]!=='--authorized-secret-only-default-runtime')throw Error('flag');
  assertIamEnvironment(process.env);
  const out=path.join(root,'_גיבוי','unified-20261002'),key=process.env.RESQ_BACKUP_SEAL_PASSPHRASE;
  if(process.env.RESQ_PRIVATE_BACKUP_DIRECTORY_VERIFIED!==out || !/^[a-f0-9]{64}$/.test(key||''))throw Error('private');
  for(let p=out;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('linked');if(p===root)break;if(path.dirname(p)===p)throw Error('escape');}
  const cli=createRequire(new URL('../firebase-cli-runtime/node_modules/firebase-tools/lib/auth.js',import.meta.url));cli('./logger.js').logger.silent=true;
  const auth=cli('./auth.js'),options={project:'station-102',nonInteractive:true};auth.setActiveAccount(options,auth.getGlobalDefaultAccount());await cli('./requireAuth.js').requireAuth(options,true);
  const getCredential=createBackupRefreshHandler(()=>auth.getAccessToken(options.tokens.refresh_token,options.authScopes));
  const request=(url,body)=>boundedIamRequest(url,body,{getCredential});
  stage='verify-runtime';
  const project=await request('https://cloudresourcemanager.googleapis.com/v1/projects/station-102');
  if(project.projectId!=='station-102' || !/^\d+$/.test(String(project.projectNumber)))throw Error('project');
  const number=String(project.projectNumber),runtime=number+'-compute@developer.gserviceaccount.com';
  const fn=await request('https://cloudfunctions.googleapis.com/v2/projects/station-102/locations/europe-west1/functions/recordMetrics');
  if(fn.state!=='ACTIVE' || fn.serviceConfig?.serviceAccountEmail!==runtime)throw Error('runtime_mismatch');
  const resource='projects/'+number+'/secrets/RESQ_METRICS_HASH_KEY';
  const base='https://secretmanager.googleapis.com/v1/'+resource;
  const secret=await request(base),version=await request(base+'/versions/1');
  if(secret.name!==resource || version.name!==resource+'/versions/1' || version.state!=='ENABLED')throw Error('secret');
  const getPolicy=()=>request(base+':getIamPolicy?options.requestedPolicyVersion=3');
  const before=await getPolicy(),plan=planSecretAccessor(before,'serviceAccount:'+runtime);
  destination=path.join(out,'hmac-iam-'+randomUUID());fs.mkdirSync(destination,{mode:0o700});
  function seal(name,value){const dir=path.join(destination,name);fs.mkdirSync(dir,{mode:0o700});const plain=JSON.stringify(value);sealDocumentsBuffer(dir,plain,key);const b=unsealBuffer(JSON.parse(fs.readFileSync(path.join(dir,SEALED_FILE_NAME),'utf8')),key);const ok=b.toString('utf8')===plain;b.fill(0);if(!ok)throw Error('readback');}
  stage='seal-before';seal('before',{resource,runtime,version,policy:before,plannedPolicy:plan.policy,rollback:'Remove only this addition after fresh etag/concurrency review; never overwrite whole historical policy.'});
  if(plan.changed){stage='set-policy';writeAttempted=true;
    try{await request(base+':setIamPolicy',{policy:plan.policy,updateMask:'bindings,etag'});writeAcknowledged=true;}
    catch{stage='reconcile-uncertain';}
  }
  stage='verify-policy';const after=await getPolicy();verified=samePolicySemantics(plan.policy,after);
  stage='seal-after';seal('after',{resource,runtime,policy:after,writeAttempted,writeAcknowledged,verified,effectiveRuntimeAccessProven:false});
  if(!verified)throw Error('policy_mismatch');
  console.log(JSON.stringify({succeeded:true,writeAttempted,writeAcknowledged,bindingVerified:true,unrelatedPolicyPreserved:true,encryptedReadback:true,resource,runtime,destination,secretPayloadRead:false,effectiveRuntimeAccessProven:false,functionDeployed:false}));
}catch{console.log(JSON.stringify({succeeded:false,stage,writeAttempted,writeAcknowledged,bindingVerified:verified,details:'REDACTED',...(destination?{destination}:{})}));process.exitCode=1;}
