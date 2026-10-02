// Bounded root metadata only; arbitrary live identifiers never leave this module.
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRestBackupApi} from './ops-backup-rest.mjs';
import {createBackupRefreshHandler} from './ops-backup-cli-credential.mjs';
export function summarizeRootPolicyGaps(roots, policy, sourceTexts) {
  const declared=new Set(policy.DATA_POLICIES.map(p=>p.path.split('/')[0]));
  declared.add('_resq_restore_canary');
  const sourceKnown=new Set();
  for(const source of sourceTexts) {
    for(const m of source.matchAll(/\.(?:collection|doc)\(\s*['"`]([a-zA-Z_][a-zA-Z_0-9]*)(?=\/|['"`])/g)) sourceKnown.add(m[1]);
    for(const m of source.matchAll(/\b(?:collection|doc)\(\s*db\s*,\s*['"`]([a-zA-Z_][a-zA-Z_0-9]*)(?=\/|['"`])/g)) sourceKnown.add(m[1]);
  }
  const unknown=roots.filter(p=>!declared.has(p));
  return {rootMetadataOnly:true,unknownRootCount:unknown.length,
    sourceBackedUnknownRoots:unknown.filter(p=>sourceKnown.has(p)).sort(),
    undisclosedUnknownRootCount:unknown.filter(p=>!sourceKnown.has(p)).length,
    nestedCoverageVerified:false};
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.argv.length!==3 || process.argv[2]!=='--authorized-root-metadata') throw Error('flag');
    if(Object.entries(process.env).some(([k,v])=>v && (/EMULATOR|FIRESTORE_HOST|FIREBASE_HOST/.test(k) || /^FIREBASE_.*(?:URL|ORIGIN|HOST)$/i.test(k) || /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FIREBASE_TOKEN|AUTHPROXY_URL)$/i.test(k)))) throw Error('override');
    if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0') throw Error('tls');
    const require=createRequire(import.meta.url), policy=require('./functions/backup-policy.js');
    const root=path.dirname(fileURLToPath(import.meta.url));
    const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0')
      .filter(p=> /\.(?:js|mjs|cjs|html)$/.test(p) && (p.startsWith('functions/') || !p.includes('/')) && !p.includes('node_modules/') && !/\.test\./.test(p));
    const texts=files.map(p=>fs.readFileSync(path.join(root,p),'utf8'));
    // Schema hints are lexical, not an authorization or automatic classification.
    texts.push(...policy.DATA_POLICIES.map(p=>`db.collection('${p.path.split('/')[0]}')`));
    const cli=createRequire(new URL('../firebase-cli-runtime/node_modules/firebase-tools/lib/auth.js',import.meta.url));
    cli('./logger.js').logger.silent=true;
    const auth=cli('./auth.js'), options={project:'station-102',nonInteractive:true};
    auth.setActiveAccount(options,auth.getGlobalDefaultAccount());
    await cli('./requireAuth.js').requireAuth(options,true);
    if(!options.tokens) throw Error('auth');
    const getCredential=createBackupRefreshHandler(()=>auth.getAccessToken(options.tokens.refresh_token,options.authScopes));
    const api=createRestBackupApi({projectId:'station-102',getCredential,maxRequests:10,maxTotalBytes:1024*1024});
    console.log(JSON.stringify(summarizeRootPolicyGaps(await api.listCollectionPaths(),policy,texts)));
  } catch { console.log(JSON.stringify({rootMetadataOnly:true,succeeded:false,details:'REDACTED'}));process.exitCode=1; }
}
