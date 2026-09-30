// Listener credential + config store on LD (library only). Security review 30/09/2026 (provisioning verdict, Q3):
// - Location (ACL hardening, t192u, acl-hardening-verdicts.md): <home>\AppData\Local\resq-listeners\ (home = the
//   Windows user profile, and os.homedir() must equal os.userInfo().homedir, else HOME_MISMATCH). NOT a direct child of
//   the profile: the Codex elevated sandbox grants CodexSandboxUsers read on every direct profile child (the old
//   <home>\.resq-listeners got that ACE twice on 30/09). The legacy folder is only reported (legacyDir), never read.
//   Never under work\, never inside a git worktree, never through a symlink/junction component (AppData and Local
//   included). Files: <key>.credential.json, <key>.config.json.
// - The folder is created non-recursively directly in AppData\Local, locked down (owner = me, only me:F, inheritance
//   off) and VERIFIED before any secret is written. An existing folder is only verified, never repaired.
// - verify(agent): one aclMany spawn over the folder + every present store file (runner: at startup before the first
//   heartbeat and on every status tick; a finding stops the runner with exit 6). No automatic repair, ever.
// - The refresh token is encrypted with DPAPI (CurrentUser scope, fixed entropy) AND the folder/files must pass an
//   ACL check (owner = current user, inheritance removed on the folder, every ACE = current user only).
//   Reading fails CLOSED if either check fails: the runner then refuses to start.
// - The credential file holds {v, agent, uid, projectId, revokedAfter, protected}. No password, no owner token.
// - Residual risk accepted by security: another process running as the same Windows user can decrypt.
// Push trigger (review/push-trigger-verdicts.md, key + general conditions):
// - <key>.llm.json {v, agent, host, model, protected}: the dedicated, spend-capped LLM key, DPAPI-protected, same
//   folder, same ACL check, fail closed. One host per agent: Grok -> api.x.ai, Codex -> api.openai.com (fixed map).
//   The key is entered via hidden stdin by provision-listener.mjs (never argv) and is never returned by status().
// - <key>.acks.json {v:1, ids:[uuid...]}: the ack ledger, UUIDs only (no content), capped, same folder/ACL check.
// - <key>.stream.json {v:1, restartsLastHour, restartsLastDay, at}: stream restart counts only (condition 3 of the
//   25572dc code review), written by the runner on each status tick, read by provision-listener --status.
// - <key>.config.json may carry ack:boolean (default false). Older configs without it stay valid.
import * as nodeFs from 'node:fs';
import {join,dirname,parse,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fail,LISTENER_AGENTS} from './listener-auth.mjs';
import {aclFinding,inboxWriteFinding} from './win-protect.mjs';

export const DIR_NAME='resq-listeners';
export const LEGACY_DIR_NAME='.resq-listeners';
export const storeBase=home=>join(home,'AppData','Local');
const CRED_KEYS=['v','agent','uid','projectId','revokedAfter','protected'];
const CONFIG_KEYS=['inboxRoot','delivery','ack'];
const LLM_KEYS=['v','agent','host','model','protected'];
export const LLM_HOSTS=Object.freeze({Grok:'api.x.ai',Codex:'api.openai.com'});
export const LLM_KEY_PREFIX=Object.freeze({Grok:/^xai-[A-Za-z0-9_-]{20,200}$/,Codex:/^sk-[A-Za-z0-9_-]{20,300}$/});
export const MODEL_PATTERN=/^[a-z0-9][a-z0-9._-]{1,63}$/;
export const LEDGER_MAX=500;
const UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyOf=agent=>{if(!Object.hasOwn(LISTENER_AGENTS,agent))fail('AGENT_REJECTED');return LISTENER_AGENTS[agent];};
export function listenerPaths(home,agent){
  const key=keyOf(agent);const dir=join(storeBase(home),DIR_NAME);
  return Object.freeze({dir,credential:join(dir,key+'.credential.json'),config:join(dir,key+'.config.json'),llm:join(dir,key+'.llm.json'),acks:join(dir,key+'.acks.json'),stream:join(dir,key+'.stream.json')});
}
// Security A: the profile path node reports (os.homedir(), which follows USERPROFILE) must be the account's real profile
// (os.userInfo().homedir, from the OS account database). Case-insensitive on Windows.
export function assertHomeMatch(home,accountHome,platform=process.platform){
  if(typeof home!=='string'||typeof accountHome!=='string'||!home||!accountHome)fail('HOME_MISMATCH');
  const a=resolve(home),b=resolve(accountHome);
  if(platform==='win32'?a.toLowerCase()!==b.toLowerCase():a!==b)fail('HOME_MISMATCH');
}
// protector: {protect(Buffer)->Buffer, unprotect(Buffer)->Buffer, checkAcl(path,{directory})->void|throws, lockDown(dir)->void,
//             aclMany(paths[])->info[]}
export function createCredentialStore({home,accountHome,platform=process.platform,fs=nodeFs,protector}){
  if(typeof home!=='string'||!home||resolve(home)!==home)fail('HOME_REJECTED');
  assertHomeMatch(home,accountHome,platform);
  if(!protector||['protect','unprotect','checkAcl','lockDown','aclMany'].some(f=>typeof protector[f]!=='function'))fail('PROTECTOR_REQUIRED');
  const base=storeBase(home);const dir=join(base,DIR_NAME);const legacy=join(home,LEGACY_DIR_NAME);
  function rejectLinks(path){
    const full=resolve(path);const {root}=parse(full);let cur=root;
    for(const part of full.slice(root.length).split(sep).filter(Boolean)){cur=join(cur,part);if(fs.lstatSync(cur).isSymbolicLink())fail('CREDENTIAL_LINK_REJECTED');}
  }
  function rejectGit(path){
    let cur=path;
    for(;;){
      let found=false;try{fs.lstatSync(join(cur,'.git'));found=true;}catch(e){if(e?.code!=='ENOENT'&&e?.code!=='ENOTDIR')throw e;}
      if(found)fail('CREDENTIAL_IN_GIT_WORKTREE');
      const up=dirname(cur);if(up===cur)return;cur=up;
    }
  }
  function checkDir(){
    if(dir.toLowerCase().split(/[\\/]/).includes('work'))fail('CREDENTIAL_UNDER_WORK');
    rejectLinks(dir);if(!fs.lstatSync(dir).isDirectory())fail('CREDENTIAL_DIR_NOT_DIRECTORY');
    rejectGit(dir);protector.checkAcl(dir,{directory:true});
  }
  function checkFile(file){const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())fail('CREDENTIAL_NOT_FILE');protector.checkAcl(file,{directory:false});}
  // temp ('wx', same folder) -> rename over the final name (replacement is intended: provisioning and rotate).
  function writeFile(file,content){
    const tmp=join(dir,'.'+randomUUID()+'.tmp');const fd=fs.openSync(tmp,'wx',0o600);
    try{try{fs.writeFileSync(fd,content,'utf8');}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
    finally{try{fs.unlinkSync(tmp);}catch{}}
    checkFile(file);
    return createHash('sha256').update(content).digest('hex');
  }
  function readJson(file,max){
    checkDir();checkFile(file);
    const text=fs.readFileSync(file,'utf8');if(text.length>max)fail('CREDENTIAL_TOO_LARGE');
    try{return JSON.parse(text);}catch{fail('CREDENTIAL_JSON');}
  }
  const api=Object.freeze({
    dir,
    paths:agent=>listenerPaths(home,agent),
    legacyPath:legacy,
    // Provisioning only: create the folder (non-recursive, directly in AppData\Local), lock its ACL down and verify it
    // BEFORE any secret is written (security C). An existing folder is only verified: no repair (security F).
    ensureDir(){
      if(!fs.lstatSync(home).isDirectory())fail('HOME_NOT_DIRECTORY');
      let b;try{b=fs.lstatSync(base);}catch(e){if(e?.code==='ENOENT')fail('BASE_NOT_DIRECTORY');throw e;}
      if(!b.isDirectory())fail('BASE_NOT_DIRECTORY');
      rejectLinks(base);
      let created=false;
      try{fs.lstatSync(dir);}catch(e){if(e?.code!=='ENOENT')throw e;fs.mkdirSync(dir,{mode:0o700});created=true;}
      rejectLinks(dir);if(created)protector.lockDown(dir);checkDir();
      const f=api.verify();if(f)fail(f.code);
      return dir;
    },
    // Report-only (security E): whether the pre-migration folder still exists. Never opened, listed or read.
    legacyDirPresent(){try{fs.lstatSync(legacy);return true;}catch(e){if(e?.code==='ENOENT'||e?.code==='ENOTDIR')return false;throw e;}},
    // ONE aclMany spawn over the folder and every present store file of every agent (paths only from store constants),
    // plus, when given, the runner's validated inbox root + agent folder (task-inbox aclPaths()) in the SAME spawn
    // (UI recommendation 2: one capped call per tick). Store findings first, then INBOX_ACL_WRITABLE.
    // Returns null (clean) or {code, path, sid, mask, type}; throws a safe code if the check itself cannot run.
    verify({inboxPaths=[]}={}){
      if(!Array.isArray(inboxPaths)||inboxPaths.length>2||!inboxPaths.every(x=>typeof x==='string'))fail('ACL_MANY_INPUT');
      if(dir.toLowerCase().split(/[\\/]/).includes('work'))fail('CREDENTIAL_UNDER_WORK');
      rejectLinks(dir);if(!fs.lstatSync(dir).isDirectory())fail('CREDENTIAL_DIR_NOT_DIRECTORY');
      const entries=[{path:dir,directory:true}];
      for(const agent of Object.keys(LISTENER_AGENTS)){
        const p=listenerPaths(home,agent);
        for(const file of [p.credential,p.config,p.llm,p.acks,p.stream]){
          let st;try{st=fs.lstatSync(file);}catch(e){if(e?.code==='ENOENT')continue;throw e;}
          if(st.isSymbolicLink()||!st.isFile())fail('CREDENTIAL_NOT_FILE');
          entries.push({path:file,directory:false});
        }
      }
      for(const path of inboxPaths)entries.push({path,inbox:true});
      const infos=protector.aclMany(entries.map(e=>e.path));
      if(!Array.isArray(infos)||infos.length!==entries.length)fail('ACL_SCHEMA');
      for(let i=0;i<entries.length;i++){if(entries[i].inbox)continue;const f=aclFinding(infos[i],{directory:entries[i].directory});if(f)return Object.freeze({...f,path:entries[i].path});}
      for(let i=0;i<entries.length;i++){if(!entries[i].inbox)continue;const f=inboxWriteFinding(infos[i]);if(f)return Object.freeze({...f,path:entries[i].path});}
      return null;
    },
    // Security: inbox write integrity (INBOX_ACL_WRITABLE). paths = the validated inbox root and agent folder.
    inboxFinding(paths){
      const infos=protector.aclMany(paths);
      if(!Array.isArray(infos)||infos.length!==paths.length)fail('ACL_SCHEMA');
      for(let i=0;i<paths.length;i++){const f=inboxWriteFinding(infos[i]);if(f)return Object.freeze({...f,path:paths[i]});}
      return null;
    },
    // Status (security D): the stored credential's uid/revokedAfter (ACL-checked; NO DPAPI unprotect, no token).
    credentialMeta(agent){
      const p=listenerPaths(home,agent);const d=readJson(p.credential,65536);
      if(!d||typeof d!=='object'||typeof d.uid!=='string'||!Number.isSafeInteger(d.revokedAfter))fail('CREDENTIAL_SHAPE');
      return Object.freeze({uid:d.uid,revokedAfter:d.revokedAfter});
    },
    writeCredential(agent,{uid,projectId,revokedAfter,refreshToken}){
      const p=listenerPaths(home,agent);checkDir();
      if(typeof refreshToken!=='string'||refreshToken.length<20||refreshToken.length>8192)fail('CREDENTIAL_FORMAT');
      if(!Number.isSafeInteger(revokedAfter)||revokedAfter<=0)fail('REVOKED_AFTER_FORMAT');
      const blob=protector.protect(Buffer.from(JSON.stringify({refreshToken}),'utf8'));
      const doc={v:1,agent,uid,projectId,revokedAfter,protected:Buffer.from(blob).toString('base64')};
      return {path:p.credential,sha256:writeFile(p.credential,JSON.stringify(doc)+'\n')};
    },
    readCredential(agent){
      const p=listenerPaths(home,agent);const d=readJson(p.credential,65536);
      if(!d||typeof d!=='object'||Object.keys(d).length!==CRED_KEYS.length||!CRED_KEYS.every(k=>Object.hasOwn(d,k)))fail('CREDENTIAL_SHAPE');
      if(d.v!==1||d.agent!==agent||typeof d.uid!=='string'||typeof d.projectId!=='string'||!Number.isSafeInteger(d.revokedAfter)||typeof d.protected!=='string')fail('CREDENTIAL_SHAPE');
      let inner;
      try{inner=JSON.parse(Buffer.from(protector.unprotect(Buffer.from(d.protected,'base64'))).toString('utf8'));}catch{fail('CREDENTIAL_UNPROTECT');}
      if(!inner||typeof inner.refreshToken!=='string'||Object.keys(inner).length!==1)fail('CREDENTIAL_UNPROTECT');
      return Object.freeze({agent,uid:d.uid,projectId:d.projectId,revokedAfter:d.revokedAfter,refreshToken:inner.refreshToken});
    },
    hasCredential(agent){try{fs.lstatSync(listenerPaths(home,agent).credential);return true;}catch(e){if(e?.code==='ENOENT')return false;throw e;}},
    hasConfig(agent){try{fs.lstatSync(listenerPaths(home,agent).config);return true;}catch(e){if(e?.code==='ENOENT')return false;throw e;}},
    writeConfig(agent,{inboxRoot,delivery,ack=false}){
      const p=listenerPaths(home,agent);checkDir();
      if(typeof inboxRoot!=='string'||!inboxRoot||typeof delivery!=='boolean'||typeof ack!=='boolean')fail('CONFIG_FORMAT');
      return {path:p.config,sha256:writeFile(p.config,JSON.stringify({inboxRoot,delivery,ack})+'\n')};
    },
    // LLM key (summarizer S1). Only Grok and Codex; the host is fixed per agent, the model is validated.
    writeLlmKey(agent,{apiKey,model}){
      const p=listenerPaths(home,agent);checkDir();
      if(!Object.hasOwn(LLM_HOSTS,agent))fail('LLM_AGENT_REJECTED');
      if(typeof apiKey!=='string'||!LLM_KEY_PREFIX[agent].test(apiKey))fail('LLM_KEY_FORMAT');
      if(typeof model!=='string'||!MODEL_PATTERN.test(model))fail('LLM_MODEL_FORMAT');
      const blob=protector.protect(Buffer.from(JSON.stringify({apiKey}),'utf8'));
      const doc={v:1,agent,host:LLM_HOSTS[agent],model,protected:Buffer.from(blob).toString('base64')};
      return {path:p.llm,sha256:writeFile(p.llm,JSON.stringify(doc)+'\n')};
    },
    readLlmKey(agent){
      const p=listenerPaths(home,agent);if(!Object.hasOwn(LLM_HOSTS,agent))fail('LLM_AGENT_REJECTED');
      const d=readJson(p.llm,16384);
      if(!d||typeof d!=='object'||Object.keys(d).length!==LLM_KEYS.length||!LLM_KEYS.every(k=>Object.hasOwn(d,k)))fail('LLM_SHAPE');
      if(d.v!==1||d.agent!==agent||d.host!==LLM_HOSTS[agent]||typeof d.model!=='string'||!MODEL_PATTERN.test(d.model)||typeof d.protected!=='string')fail('LLM_SHAPE');
      let inner;
      try{inner=JSON.parse(Buffer.from(protector.unprotect(Buffer.from(d.protected,'base64'))).toString('utf8'));}catch{fail('LLM_UNPROTECT');}
      if(!inner||Object.keys(inner).length!==1||typeof inner.apiKey!=='string'||!LLM_KEY_PREFIX[agent].test(inner.apiKey))fail('LLM_UNPROTECT');
      return Object.freeze({agent,host:d.host,model:d.model,apiKey:inner.apiKey});
    },
    hasLlmKey(agent){try{fs.lstatSync(listenerPaths(home,agent).llm);return true;}catch(e){if(e?.code==='ENOENT')return false;throw e;}},
    // Status for the owner: host/model only, never the key.
    llmKeyStatus(agent){
      const p=listenerPaths(home,agent);try{fs.lstatSync(p.llm);}catch(e){if(e?.code==='ENOENT')return Object.freeze({present:false});throw e;}
      const d=readJson(p.llm,16384);return Object.freeze({present:true,host:typeof d?.host==='string'?d.host:null,model:typeof d?.model==='string'?d.model:null});
    },
    removeLlmKey(agent){const p=listenerPaths(home,agent);checkDir();try{fs.unlinkSync(p.llm);return true;}catch(e){if(e?.code==='ENOENT')return false;throw e;}},
    // Ack ledger: UUIDs only, capped (oldest dropped). A missing file is an empty ledger; a bad one fails closed.
    readLedger(agent){
      const p=listenerPaths(home,agent);
      try{fs.lstatSync(p.acks);}catch(e){if(e?.code==='ENOENT'){checkDir();return [];}throw e;}
      const d=readJson(p.acks,65536);
      if(!d||typeof d!=='object'||Object.keys(d).length!==2||d.v!==1||!Array.isArray(d.ids)||d.ids.length>LEDGER_MAX||!d.ids.every(x=>typeof x==='string'&&UUID_V4.test(x)))fail('LEDGER_SHAPE');
      return d.ids.slice();
    },
    writeLedger(agent,ids){
      const p=listenerPaths(home,agent);checkDir();
      if(!Array.isArray(ids)||!ids.every(x=>typeof x==='string'&&UUID_V4.test(x)))fail('LEDGER_SHAPE');
      const kept=[...new Set(ids)].slice(-LEDGER_MAX);
      return {path:p.acks,sha256:writeFile(p.acks,JSON.stringify({v:1,ids:kept})+'\n')};
    },
    // Stream restart counts (numbers only; no content, no token). Missing file -> null.
    readStreamStats(agent){
      const p=listenerPaths(home,agent);
      try{fs.lstatSync(p.stream);}catch(e){if(e?.code==='ENOENT'){checkDir();return null;}throw e;}
      const d=readJson(p.stream,4096);const n=v=>Number.isSafeInteger(v)&&v>=0;
      if(!d||typeof d!=='object'||Object.keys(d).length!==4||d.v!==1||!n(d.restartsLastHour)||!n(d.restartsLastDay)||!n(d.at))fail('STREAM_STATS_SHAPE');
      return Object.freeze({restartsLastHour:d.restartsLastHour,restartsLastDay:d.restartsLastDay,at:d.at});
    },
    writeStreamStats(agent,{restartsLastHour,restartsLastDay,at}){
      const p=listenerPaths(home,agent);checkDir();const n=v=>Number.isSafeInteger(v)&&v>=0;
      if(!n(restartsLastHour)||!n(restartsLastDay)||!n(at))fail('STREAM_STATS_SHAPE');
      return {path:p.stream,sha256:writeFile(p.stream,JSON.stringify({v:1,restartsLastHour,restartsLastDay,at})+'\n')};
    },
    readConfig(agent){
      const p=listenerPaths(home,agent);const d=readJson(p.config,4096);
      if(!d||typeof d!=='object'||Array.isArray(d))fail('CONFIG_SHAPE');
      for(const k of Object.keys(d))if(!CONFIG_KEYS.includes(k))fail('CONFIG_UNKNOWN_KEY');
      if(typeof d.inboxRoot!=='string'||typeof d.delivery!=='boolean'||(d.ack!==undefined&&typeof d.ack!=='boolean'))fail('CONFIG_SHAPE');
      return Object.freeze({inboxRoot:d.inboxRoot,delivery:d.delivery,ack:d.ack===true});
    }
  });
  return api;
}
