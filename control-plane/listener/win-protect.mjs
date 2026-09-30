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
    +"Set-Acl -LiteralPath $p -AclObject $a;[Console]::Out.Write('ok')",
  // ACL hardening (acl-hardening-verdicts.md, security aclMany): ONE process for many paths. The paths arrive as a JSON
  // array over stdin (never argv), come only from credential-store constants (+ the validated inbox root), and the
  // output is one object per path in the same order, with the numeric rights mask per rule (for INBOX_ACL_WRITABLE).
  aclMany:PRE+ME+"$ps=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[Security.Principal.SecurityIdentifier];"
    +"$o=@(foreach($p in $ps){$a=Get-Acl -LiteralPath ([string]$p);"
    +"@{me=$me.Value;owner=$a.GetOwner($sid).Value;protected=$a.AreAccessRulesProtected;"
    +"rules=@($a.GetAccessRules($true,$true,$sid)|ForEach-Object{@{sid=$_.IdentityReference.Value;type=[string]$_.AccessControlType;inherited=$_.IsInherited;mask=([int64]$_.FileSystemRights.value__ -band 4294967295)}})}});"
    +"[Console]::Out.Write((ConvertTo-Json -InputObject $o -Compress -Depth 5))"
});
export const ACL_MANY_MAX=16;
// Rights bits that let a principal change a folder's content or its security (W/M/F/D/WD/AD and generic write/all).
export const WRITE_MASK=0x2|0x4|0x10|0x40|0x100|0x10000|0x40000|0x80000|0x10000000|0x40000000;
export const TRUSTED_SYSTEM_SIDS=Object.freeze(['S-1-5-18','S-1-5-32-544']);   // LocalSystem, BUILTIN\Administrators
// Readable name for the owner's Hebrew log line: the usual icacls letters, else the hex mask.
export function rightsName(mask){
  if(!Number.isSafeInteger(mask))return '?';
  const names={0x1F01FF:'F',0x1301BF:'M',0x1200A9:'RX',0x120089:'R',0x116:'W',0x100116:'W'};
  return names[mask]??('0x'+mask.toString(16).toUpperCase());
}
const rulesOf=info=>Array.isArray(info.rules)?info.rules:info.rules?[info.rules]:[];
// Pure policy (unit-tested on any OS): owner = me; every ACE belongs to me; a folder must not inherit.
// aclFinding also names the offending SID and rights mask (for the local Hebrew log line only; never stdout/Firestore).
export function aclFinding(info,{directory}){
  if(!info||typeof info.me!=='string'||!/^S-1-5-21-[0-9-]+$/.test(info.me))return {code:'ACL_UNKNOWN_USER',sid:null,mask:null};
  if(info.owner!==info.me)return {code:'ACL_OWNER',sid:typeof info.owner==='string'?info.owner:null,mask:null};
  const rules=rulesOf(info);
  if(rules.length===0)return {code:'ACL_EMPTY',sid:null,mask:null};
  const other=rules.find(r=>!r||r.sid!==info.me);
  if(other)return {code:'ACL_OTHER_PRINCIPAL',sid:typeof other?.sid==='string'?other.sid:null,mask:Number.isSafeInteger(other?.mask)?other.mask:null};
  if(!rules.some(r=>r.type==='Allow'))return {code:'ACL_NO_ALLOW',sid:null,mask:null};
  if(directory&&info.protected!==true)return {code:'ACL_INHERITANCE',sid:null,mask:null};
  return null;
}
export function aclVerdict(info,opts){return aclFinding(info,opts)?.code??null;}
// Inbox write integrity (security: INBOX_ACL_WRITABLE). RX for other principals is accepted (the Codex sandbox reads
// the inbox); any Allow rule with a write/delete/security bit for a principal other than me, SYSTEM or Administrators
// fails closed. Owner must be me, SYSTEM or Administrators.
export function inboxWriteFinding(info){
  if(!info||typeof info.me!=='string'||!/^S-1-5-21-[0-9-]+$/.test(info.me))return {code:'ACL_UNKNOWN_USER',sid:null,mask:null};
  const ok=sid=>sid===info.me||TRUSTED_SYSTEM_SIDS.includes(sid);
  if(!ok(info.owner))return {code:'INBOX_ACL_WRITABLE',sid:typeof info.owner==='string'?info.owner:null,mask:null};
  for(const r of rulesOf(info)){
    if(!r||typeof r.sid!=='string'||!Number.isSafeInteger(r.mask))return {code:'ACL_SCHEMA',sid:null,mask:null};
    if(r.type==='Allow'&&!ok(r.sid)&&(r.mask&WRITE_MASK)!==0)return {code:'INBOX_ACL_WRITABLE',sid:r.sid,mask:r.mask};
  }
  return null;
}
// Strict schema for one aclMany entry (security: output schema validated).
export function validAclInfo(x){
  if(!x||typeof x!=='object'||Array.isArray(x))return false;
  if(typeof x.me!=='string'||typeof x.owner!=='string'||typeof x.protected!=='boolean')return false;
  const rules=rulesOf(x);if(!Array.isArray(x.rules)&&x.rules!==undefined&&(typeof x.rules!=='object'||x.rules===null))return false;
  return rules.every(r=>r&&typeof r==='object'&&typeof r.sid==='string'&&(r.type==='Allow'||r.type==='Deny')&&typeof r.inherited==='boolean'&&Number.isSafeInteger(r.mask));
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
    lockDown(dir){if(run('lockdown',dir)!=='ok')fail('ACL_LOCKDOWN_FAILED');},
    // One spawn for many paths. Returns the parsed infos (same order, exact count) or throws a safe code.
    aclMany(paths){
      if(!Array.isArray(paths)||paths.length<1||paths.length>ACL_MANY_MAX||!paths.every(p=>typeof p==='string'&&/^[A-Za-z]:\\/.test(p)&&!p.includes('\n')))fail('ACL_MANY_INPUT');
      let out;try{out=JSON.parse(run('aclMany',JSON.stringify(paths)));}catch(e){fail(e?.code?.startsWith?.('PROTECTOR_')?e.code:'ACL_READ_FAILED');}
      const list=Array.isArray(out)?out:[out];
      if(list.length!==paths.length||!list.every(validAclInfo))fail('ACL_SCHEMA');
      return list;
    }
  });
}
