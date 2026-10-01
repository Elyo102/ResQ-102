// Separate trusted-native integration, NOT an OS network sandbox. Three original
// suites remain unchanged: Git/ZIP restore and the PowerShell archive fixture.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export const NATIVE_OPS_SUITES=Object.freeze(['ops-backup-test.mjs','ops-restore-drill-test.mjs','ops-backup-archive.test.mjs']);

export function assertNativeOpsResult(result,suite){
 if(result.error||result.signal||result.status!==0)throw Error('NATIVE_OPS_SUITE_FAILED '+suite);
}
export function nativeOpsEnvironment(dirs,windows){
 const empty=path.join(dirs.config,'empty');
 const env={PATH:windows?'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0':'/usr/bin:/bin',
 TMP:dirs.tmp,TEMP:dirs.tmp,TMPDIR:dirs.tmp,HOME:dirs.profile,USERPROFILE:dirs.profile,
 GIT_CONFIG_NOSYSTEM:'1',GIT_ATTR_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:empty,GIT_CONFIG_GLOBAL:empty,GIT_TERMINAL_PROMPT:'0',
 GIT_ALLOW_PROTOCOL:'file',GIT_PROTOCOL_FROM_USER:'0',GIT_TEMPLATE_DIR:dirs.templates,
 LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
 if(windows)Object.assign(env,{SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',SystemDrive:'C:',COMSPEC:'C:\\Windows\\System32\\cmd.exe',
 APPDATA:dirs.profile,LOCALAPPDATA:dirs.profile,PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'});
 const config={'core.hooksPath':dirs.hooks,'init.templateDir':dirs.templates,'core.attributesFile':empty,'core.fsmonitor':'false',
 'commit.gpgSign':'false','tag.gpgSign':'false','credential.helper':'','protocol.allow':'never','protocol.file.allow':'always'};
 env.GIT_CONFIG_COUNT=String(Object.keys(config).length);
 Object.entries(config).forEach(([key,value],index)=>{env['GIT_CONFIG_KEY_'+index]=key;env['GIT_CONFIG_VALUE_'+index]=value;});
 return env;
}
export function runNativeOps(){
if(process.argv.length!==2||Number(process.versions.node.split('.')[0])!==22)throw Error('NATIVE_OPS_ENTRY');
if(process.env.RESQ_CONTAINMENT_DIR||globalThis[Symbol.for('resq.test.networkContainment')])throw Error('NATIVE_OPS_NESTED_GUARD');
if(!['win32','linux'].includes(process.platform))throw Error('NATIVE_OPS_PLATFORM');
const here=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
const windows=process.platform==='win32';
const programs=windows?['C:/Program Files/Git/cmd/git.exe','C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']:['/usr/bin/git','/usr/bin/zip','/usr/bin/unzip'];
for(const name of programs){const full=path.resolve(name),real=fs.realpathSync(full);if(!fs.statSync(full).isFile()||fs.lstatSync(full).isSymbolicLink()||real.toLowerCase()!==full.toLowerCase())throw Error('NATIVE_OPS_EXECUTABLE');}
const base=fs.realpathSync(os.tmpdir());
const owned=fs.mkdtempSync(path.join(base,'resq-native-ops-'));
if(/[\r\n\0"'`$]/.test(owned))throw Error('NATIVE_OPS_UNSAFE_LITERAL_PATH');
const dirs=Object.fromEntries(['tmp','profile','hooks','templates','config'].map(name=>[name,path.join(owned,name)]));
for(const directory of Object.values(dirs))fs.mkdirSync(directory,{mode:0o700});
const empty=path.join(dirs.config,'empty');fs.writeFileSync(empty,'',{mode:0o600,flag:'wx'});
const env=nativeOpsEnvironment(dirs,windows);
let passed=0;
try{
 for(const suite of NATIVE_OPS_SUITES){
  const file=path.join(here,suite);if(fs.realpathSync(file)!==file||!fs.statSync(file).isFile())throw Error('NATIVE_OPS_SUITE');
  const result=spawnSync(process.execPath,[file],{cwd:here,env,stdio:'inherit',windowsHide:true,timeout:300000});
  assertNativeOpsResult(result,suite);
  passed++;
 }
}finally{
 // Preserve evidence on failure: a timed-out child can still have native
 // descendants. Never race recursive cleanup against uncertain child state.
 if(passed===NATIVE_OPS_SUITES.length){
  if(path.dirname(owned)!==base||fs.realpathSync(owned)!==owned||fs.lstatSync(owned).isSymbolicLink())throw Error('NATIVE_OPS_CLEANUP');
  fs.rmSync(owned,{recursive:true});
  if(fs.existsSync(owned))throw Error('NATIVE_OPS_CLEANUP_INCOMPLETE');
 }else console.error('Native ops did not complete; owned temporary evidence retained: '+owned);
}
console.log('Native ops separate gate: '+passed+'/'+NATIVE_OPS_SUITES.length+' suites PASS; cleanup verified; archive live PowerShell coverage is reported by that suite; sanitized environment, NOT OS-egress-isolated.');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runNativeOps();
