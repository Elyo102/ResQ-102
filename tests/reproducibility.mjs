import {existsSync,readdirSync,lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {assertApplicationGate} from './lib/gate-contract.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const publicWeb=new Set(['index.html','bootstrap.mjs','firebase-adapter.mjs','firebase-config.mjs','private-controller.mjs','private-view.mjs','private.css','dispatch-model.mjs','dispatch-view.mjs','active-tasks-model.mjs','active-tasks-view.mjs'].map(p=>'control-plane/web/'+p));
const fail=code=>{throw Error(code);};
export function parseCandidateIndex(value){
  const entries=new Map();
  for(const record of String(value||'').split('\0').filter(Boolean)){
    const match=record.match(/^([0-9]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/);
    if(!match)fail('INVALID_INDEX_ENTRY');
    const row={mode:match[1],oid:match[2],stage:Number(match[3]),path:match[4]};
    const rows=entries.get(row.path)||[];rows.push(row);entries.set(row.path,rows);
  }
  return entries;
}
function candidateEntry(entries,name){
  const rows=entries?.get(name)||[];
  if(!rows.length)fail('UNTRACKED_INPUT: '+name);
  if(rows.length!==1||rows[0].stage!==0)fail('CONFLICT_INPUT: '+name);
  const entry=rows[0];
  if(/^0+$/.test(entry.oid))fail('INTENT_TO_ADD_INPUT: '+name);
  if(!['100644','100755'].includes(entry.mode))fail('NON_REGULAR_INPUT: '+name);
  return entry;
}
export function validateInventory({manifest,specs,tracked,entries,read,workingOid}){
  if(manifest?.schema!==1||!Array.isArray(manifest.specs)||!Array.isArray(manifest.inputs))fail('INVALID_MANIFEST');
  const required=[...manifest.specs,...manifest.inputs];
  if(new Set(required).size!==required.length)fail('DUPLICATE_INPUT');
  for(const name of required){
    if(typeof name!=='string'||!name||name.includes('\\')||name.split('/').some(s=>!s||s==='.'||s==='..')||path.isAbsolute(name))fail('INVALID_PATH');
    if(/(?:^|\/)(?:outputs?|secrets?|test-results|playwright-report|node_modules|\.git)(?:\/|$)|(?:vault|provision|credential|\.env)/i.test(name)
      ||(name.startsWith('control-plane/')&&!publicWeb.has(name)))fail('PRIVATE_INPUT_DENIED');
    const entry=entries?candidateEntry(entries,name):null;
    if(!entries&&!tracked.has(name))fail('UNTRACKED_INPUT: '+name);
    if(entry&&workingOid&&workingOid(name)!==entry.oid)fail('DIRTY_INPUT: '+name);
    const bytes=read(name);
    if(!Buffer.isBuffer(bytes)||!bytes.length)fail('MISSING_INPUT: '+name);
    if(publicWeb.has(name)){
      const text=bytes.toString('utf8');
      if(/-----BEGIN .*PRIVATE KEY|(?:sk-ant-|xai-)[A-Za-z0-9_-]{12,}|(?:refreshToken|refresh_token|client_secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/.test(text))fail('SENSITIVE_PUBLIC_INPUT');
    }
  }
  if(specs.slice().sort().join('\n')!==manifest.specs.slice().sort().join('\n'))fail('SPEC_INVENTORY_CHANGED');
  return {specFiles:manifest.specs.length,requiredInputs:required.length};
}
export function describeGates(scripts,rules){
  if(scripts['test:all']!=='node run-contained.mjs test:all'||scripts['test:all:inner']!=='npm run test:reproducibility && npm run test:rules && npm run test:e2e')fail('FOCUSED_GATE_CHANGED');
  assertApplicationGate(scripts);
  const entries=rules.test.split(' && ');
  if(entries.some(s=>!/^node (?:\.\.\/functions\/)?[a-z0-9.-]+\.(?:mjs|cjs|js)$/.test(s)))fail('RULES_REGISTRY_CHANGED');
  return {focusedGate:'test:all (Rules registry + Playwright)',applicationGate:'all (separate application chain)',rulesEntries:entries.length};
}
export function checkCheckout(){
  const indexText=execFileSync('git',['ls-files','--stage','-z'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true});
  const entries=parseCandidateIndex(indexText);
  const readCandidate=name=>{
    const entry=candidateEntry(entries,name);
    return execFileSync('git',['cat-file','blob',entry.oid],{cwd:root,encoding:null,maxBuffer:16*1024*1024,windowsHide:true});
  };
  const manifest=JSON.parse(readCandidate('tests/reproducibility-inputs.json').toString('utf8'));
  function discover(dir){
    return readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(entry=>{
      if(entry.isSymbolicLink())fail('SYMLINK_TEST_INPUT');
      const name=dir+'/'+entry.name;
      return entry.isDirectory()?discover(name):entry.name.endsWith('.spec.mjs')?[name]:[];
    });
  }
  const specs=discover('tests/e2e');
  const result=validateInventory({manifest,specs,entries,read:readCandidate,workingOid(name){
    const target=path.join(root,name);
    if(!existsSync(target))fail('MISSING_INPUT: '+name);
    const stat=lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink())fail('NON_REGULAR_INPUT: '+name);
    return execFileSync('git',['hash-object','--path='+name,name],{
      cwd:root,encoding:'utf8',maxBuffer:1024*1024,windowsHide:true
    }).trim();
  }});
  const scripts=JSON.parse(readCandidate('tests/package.json').toString('utf8')).scripts;
  const rules=JSON.parse(readCandidate('rules-test/package.json').toString('utf8')).scripts;
  const candidateHead=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
  return {...result,...describeGates(scripts,rules),candidateHead,
    scope:'declared candidate-index browser dependencies; not full transitive or secret-proof certification'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(checkCheckout()));}catch(e){console.error(e.message);process.exitCode=1;}
}
