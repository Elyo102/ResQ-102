// Explicitly authorized, read-only Firestore export. Not a deployment/restore command.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runBackup, verifySet } from './ops-disaster-restore.mjs';
import { createBackupRefreshHandler } from './ops-backup-cli-credential.mjs';
import { createRestBackupApi } from './ops-backup-rest.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const project = 'station-102';
let output;
let stage = 'preflight';
try {
  const diagnosticOnly = process.argv[2] === '--diagnose-read-access';
  if (process.argv.length !== 3 || (!diagnosticOnly && process.argv[2] !== '--execute-authorized-backup')) throw Error('authorization flag required');
  if (Object.entries(process.env).some(([k,v]) => v && /EMULATOR|FIRESTORE_HOST|FIREBASE_HOST/.test(k))) throw Error('endpoint override');
  if (Object.entries(process.env).some(([k,v]) => v &&
      (/^FIREBASE_.*(?:URL|ORIGIN|HOST)$/i.test(k) || /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FIREBASE_TOKEN|AUTHPROXY_URL)$/i.test(k)))) throw Error('auth transport override');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw Error('TLS validation disabled');
  if (process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN && process.env.GOOGLE_CLOUD_UNIVERSE_DOMAIN !== 'googleapis.com') throw Error('universe override');
  if (!/^[a-f0-9]{64}$/.test(process.env.RESQ_BACKUP_SEAL_PASSPHRASE || '')) throw Error('random key required');
  const out = path.join(root, '_גיבוי', 'unified-20261002');
  if (!fs.statSync(out).isDirectory()) throw Error('protected destination must already exist');
  for (let p=out; ; p=path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw Error('linked destination');
    if (p===root) break;
    if (path.dirname(p)===p) throw Error('destination escaped');
  }
  // The calling PowerShell verifies a protected current-user-only inheritable DACL.
  if (process.env.RESQ_PRIVATE_BACKUP_DIRECTORY_VERIFIED !== out) throw Error('private destination not verified');
  const cli = createRequire(new URL('../firebase-cli-runtime/node_modules/firebase-tools/lib/auth.js',import.meta.url));
  cli('./logger.js').logger.silent = true;
  const auth = cli('./auth.js');
  const options = {project,nonInteractive:true};
  stage = 'cli-auth';
  auth.setActiveAccount(options,auth.getGlobalDefaultAccount());
  await cli('./requireAuth.js').requireAuth(options,true);
  if (!options.tokens) throw Error('existing CLI session required');
  const refreshCredential = createBackupRefreshHandler(() => auth.getAccessToken(options.tokens.refresh_token,options.authScopes));
  stage = 'adapter-init';
  const readOnly = createRestBackupApi({projectId:project,getCredential:refreshCredential});
  const backupOptions = {root,firestoreApi:readOnly,allowProdSource:true,inMemoryUnseal:true};
  stage = 'capture';
  if (diagnosticOnly) {
    await readOnly.listCollectionPaths();
    output = {operationSucceeded:true,metadataReadVerified:true,backupCreated:false};
  } else {
  const result = await runBackup({source:project,out,dryRun:false},backupOptions);
  stage = 'decrypted-readback';
  const verified = verifySet(result.destination,backupOptions);
  if (!verified.ok || verified.content_verified !== true) throw Error('readback failed');
  output = {operationSucceeded:true,backupCreated:true,sealed:true,contentVerified:true,documents:result.documents,
    destination:result.destination,pointInTimeConsistent:false,fullDeploymentRollback:false};
  }
} catch (error) {
  const category = String(error?.message || '').includes('ללא סיווג') ? 'POLICY_UNCLASSIFIED' : 'BACKUP_FAILED';
  const knownCodes = new Set(['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','app/invalid-credential','app/invalid-app-options','app/duplicate-app']);
  output = {operationSucceeded:false,backupCreated:false,stage,category,
    diagnosticCode:knownCodes.has(error?.code) || (Number.isInteger(error?.code) && (error.code>=0 && error.code<=16 || error.code>=400 && error.code<=599)) ? error.code : 'REDACTED',
    errorKind:['Error','TypeError','FirebaseError'].includes(error?.name) ? error.name : 'OTHER',
    defaultCredentialFailure:/default credentials/i.test(String(error?.message)),
    requestMetadataFailure:/metadata/i.test(String(error?.message)),
    transportFailure:/grpc|transport|universe/i.test(String(error?.message))};
  process.exitCode = 1;
}
console.log(JSON.stringify(output));
