// Windows-only protector for credential-store.mjs: DPAPI (CurrentUser) + ACL read/lock-down.
// The ONLY module of the listener that starts a process: the fixed Windows PowerShell binary with -NoProfile and a
// CONSTANT script chosen from SCRIPTS below. Data (a path or base64 bytes) goes over stdin, never into the command
// line; no shell; bounded time and output. Scripts use single quotes only. Not usable on other platforms (fail closed).
// Push-trigger security condition (key): the child gets a MINIMAL env (SystemRoot, windir, TEMP, USERPROFILE, PATH),
// never the parent env, so a key that was ever in the environment can never reach PowerShell.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fail} from './listener-auth.mjs';

export const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const ENTROPY='resq-listener-v1';
const PRE="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';";
const ME='$me=[Security.Principal.WindowsIdentity]::GetCurrent().User;';
export const SCRIPTS=Object.freeze({
  protect:PRE+"Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());"
    +"$o=[Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('"+ENTROPY+"'),'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($o))",
  unprotect:PRE+"Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());"
    +"$o=[Security.Cryptography.ProtectedData]::Unprotect($b,[Text.Encoding]::UTF8.GetBytes('"+ENTROPY+"'),'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($o))",
  acl:PRE+ME+"$p=[Console]::In.ReadToEnd().Trim();$a=Get-Acl -LiteralPath $p;$sid=[Security.Principal.SecurityIdentifier];"
    +"$r=@($a.GetAccessRules($true,$true,$sid)|ForEach-Object{@{sid=$_.IdentityReference.Value;type=[string]$_.AccessControlType;inherited=$_.IsInherited}});"
    +"[Console]::Out.Write((@{me=$me.Value;owner=$a.GetOwner($sid).Value;protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Compress -Depth 4))",
  lockdown:PRE+ME+"$p=[Console]::In.ReadToEnd().Trim();$a=New-Object System.Security.AccessControl.DirectorySecurity;"
    +"$a.SetAccessRuleProtection($true,$false);$a.SetOwner($me);"
    +"$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));"
    +"Set-Acl -LiteralPath $p -AclObject $a;[Console]::Out.Write('ok')"
});
// Pure policy (unit-tested on any OS): owner = me; every ACE belongs to me; a folder must not inherit.
export function aclVerdict(info,{directory}){
  if(!info||typeof info.me!=='string'||!/^S-1-5-21-[0-9-]+$/.test(info.me))return 'ACL_UNKNOWN_USER';
  if(info.owner!==info.me)return 'ACL_OWNER';
  const rules=Array.isArray(info.rules)?info.rules:info.rules?[info.rules]:[];
  if(rules.length===0)return 'ACL_EMPTY';
  if(rules.some(r=>!r||r.sid!==info.me))return 'ACL_OTHER_PRINCIPAL';
  if(!rules.some(r=>r.type==='Allow'))return 'ACL_NO_ALLOW';
  if(directory&&info.protected!==true)return 'ACL_INHERITANCE';
  return null;
}
export const CHILD_ENV_KEYS=Object.freeze(['SystemRoot','windir','TEMP','USERPROFILE','PATH']);
// Builds the child env from an explicit snapshot (the runner's scrubbed copy); unknown keys are dropped.
export function minimalChildEnv(source){
  const out={};const src=source&&typeof source==='object'?source:{};
  for(const k of CHILD_ENV_KEYS){const hit=Object.keys(src).find(x=>x.toLowerCase()===k.toLowerCase());if(hit&&typeof src[hit]==='string')out[k]=src[hit];}
  return out;
}
export function createWindowsProtector({platform=process.platform,spawn=spawnSync,exists=existsSync,baseEnv={}}={}){
  const childEnv=Object.freeze(minimalChildEnv(baseEnv));
  const run=(name,input)=>{
    if(platform!=='win32')fail('DPAPI_WINDOWS_ONLY');
    if(!exists(POWERSHELL))fail('POWERSHELL_MISSING');
    const r=spawn(POWERSHELL,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',SCRIPTS[name]],
      {input,encoding:'utf8',windowsHide:true,shell:false,timeout:30000,maxBuffer:1<<20,env:{...childEnv}});
    if(r.error||r.status!==0||typeof r.stdout!=='string')fail('PROTECTOR_'+name.toUpperCase()+'_FAILED');   // stderr never surfaced
    return r.stdout;
  };
  const b64=buf=>Buffer.from(buf).toString('base64');
  return Object.freeze({
    protect:buf=>Buffer.from(run('protect',b64(buf)),'base64'),
    unprotect:buf=>Buffer.from(run('unprotect',b64(buf)),'base64'),
    checkAcl(path,{directory}){
      let info;try{info=JSON.parse(run('acl',path));}catch(e){fail(e?.code?.startsWith?.('PROTECTOR_')?e.code:'ACL_READ_FAILED');}
      const v=aclVerdict(info,{directory});if(v)fail(v);
    },
    lockDown(dir){if(run('lockdown',dir)!=='ok')fail('ACL_LOCKDOWN_FAILED');}
  });
}
