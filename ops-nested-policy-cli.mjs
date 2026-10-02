// Explicit metadata-only diagnostic. Never use its encrypted evidence as a backup.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRestBackupApi} from './ops-backup-rest.mjs';
import {createBackupRefreshHandler} from './ops-backup-cli-credential.mjs';
import {diagnoseMetadata} from './ops-nested-policy-diagnostic.mjs';
import {scanRepository} from './ops-path-schema-scan.mjs';
import {sealDocumentsBuffer,unsealBuffer,SEALED_FILE_NAME} from './ops-backup-seal.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
try {
  if(process.argv.length!==3 || process.argv[2]!=='--authorized-metadata-diagnosis') throw Error('flag');
  if(Object.entries(process.env).some(([k,v])=>v && (/EMULATOR|FIRESTORE_HOST|FIREBASE_HOST/.test(k) || /^FIREBASE_.*(?:URL|ORIGIN|HOST)$/i.test(k) || /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FIREBASE_TOKEN|AUTHPROXY_URL)$/i.test(k)))) throw Error('override');
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0') throw Error('tls');
  const out=path.join(root,'_גיבוי','unified-20261002');
  if(process.env.RESQ_PRIVATE_BACKUP_DIRECTORY_VERIFIED!==out || !fs.statSync(out).isDirectory()) throw Error('private destination');
  for(let p=out;;p=path.dirname(p)) { if(fs.lstatSync(p).isSymbolicLink()) throw Error('linked');if(p===root)break;if(path.dirname(p)===p)throw Error('escape'); }
  const key=process.env.RESQ_BACKUP_SEAL_PASSPHRASE;
  if(!/^[a-f0-9]{64}$/.test(key||'')) throw Error('key');
  const require=createRequire(import.meta.url),policy=require('./functions/backup-policy.js');
  const source=scanRepository(root);
  const labels=new Set(policy.DATA_POLICIES.flatMap(p=>p.path.split('/').filter((s,i)=>i%2===0 && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(s))));
  const cli=createRequire(new URL('../firebase-cli-runtime/node_modules/firebase-tools/lib/auth.js',import.meta.url));
  cli('./logger.js').logger.silent=true;
  const auth=cli('./auth.js'),options={project:'station-102',nonInteractive:true};
  auth.setActiveAccount(options,auth.getGlobalDefaultAccount());
  await cli('./requireAuth.js').requireAuth(options,true);
  if(!options.tokens) throw Error('auth');
  const getCredential=createBackupRefreshHandler(()=>auth.getAccessToken(options.tokens.refresh_token,options.authScopes));
  // One bounded request proves the mask is accepted, before traversing any subtree.
  const probe=createRestBackupApi({projectId:'station-102',getCredential,metadataOnly:true,maxRequests:1});
  await probe.listDocumentMetadata('system');
  const api=createRestBackupApi({projectId:'station-102',getCredential,metadataOnly:true});
  const unknownPaths=[];
  const result=await diagnoseMetadata(api,policy,labels,{onUnknown:p=>unknownPaths.push(p)});
  const destination=path.join(out,'metadata-diagnostic-'+randomUUID());fs.mkdirSync(destination,{mode:0o700});
  const plain=JSON.stringify({diagnosticOnly:true,notBackup:true,source,unknownPaths,result});
  sealDocumentsBuffer(destination,plain,key);
  const box=JSON.parse(fs.readFileSync(path.join(destination,SEALED_FILE_NAME),'utf8'));
  const verified=unsealBuffer(box,key).toString('utf8')===plain;
  if(!verified) throw Error('readback');
  console.log(JSON.stringify({succeeded:true,diagnosticOnly:true,notBackup:true,encryptedReadbackVerified:true,
    destination,sourceFiles:source.filesScanned,unresolvedSourceExpressions:source.unresolved.length,...result}));
} catch(error) {
  console.log(JSON.stringify({succeeded:false,diagnosticOnly:true,notBackup:true,errorCode:Number.isInteger(error?.code)?error.code:'REDACTED'}));process.exitCode=1;
}
