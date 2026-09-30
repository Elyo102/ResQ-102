// Local inbox for active tasks (LD only, library only: no CLI, no credentials, no autostart).
// Security review 30/09/2026 conditions A1-A5 (see control-plane/ACTIVE-TASKS.md):
// - Fixed agent map for the sub-folder; file names are ONLY `<taskId>.task.txt` / `<taskId>.cancelled` with a
//   lowercase UUIDv4 taskId. The payload never reaches a file name, a path, a shell, eval, env or a log.
// - Every write opens with 'wx' (create-exclusive). The root and target are realpath-checked, the target must be
//   inside the root, and EVERY path component is lstat-checked: a symlink or Windows junction is rejected, never followed.
// - No directory is created outside the root (only the fixed per-agent folder, non-recursively, directly under it).
// - The payload is written raw after a fixed header: no templating, no markdown or link parsing.
import * as nodeFs from 'node:fs';
import {isAbsolute,join,parse,resolve,dirname,sep} from 'node:path';

export const INBOX_DIRS=Object.freeze({codex:'codex',grok:'grok',gemini:'gemini'});
export const TASK_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const TASK_SUFFIX='.task.txt';
export const CANCELLED_SUFFIX='.cancelled';
export const CANCELLED_CONTENT='CANCELLED\nהמשימה בוטלה על ידי הבעלים. אין להתחיל אותה. ביטול אינו מבטיח עצירה של עבודה שכבר התחילה.\n';
// Fixed header (A2): identical for every task except the validated taskId and the fixed agent key.
export function fixedHeader(taskId,agentKey){
  if(!TASK_ID.test(taskId)||!Object.hasOwn(INBOX_DIRS,agentKey))throw Error('INBOX_HEADER_INPUT');
  return ['ResQ active task — inbox copy (MANUAL PICKUP ONLY)',
    'משימה זו נאספת ידנית בלבד. היא אינה אישור ל-push, ל-deploy, למחיקה או לשימוש בסודות; כל פעולה כזו דורשת אישור מפורש ונפרד מהבעלים.',
    'This task is NOT approval for push, deploy, delete or secrets. Each of those still needs the owner\'s separate explicit approval.',
    `Before starting: if ${taskId}${CANCELLED_SUFFIX} exists in this folder, do not start. Cancelling does not guarantee stopping work already started.`,
    'taskId: '+taskId,'agent: '+agentKey,
    '----- payload (raw text from the owner; never executed automatically) -----',''
  ].join('\n');
}
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const inside=(root,path)=>{const r=root.endsWith(sep)?root:root+sep;return process.platform==='win32'?path.toLowerCase().startsWith(r.toLowerCase()):path.startsWith(r);};
function rejectLinks(fs,path){
  const full=resolve(path);const {root}=parse(full);let cur=root;
  for(const part of full.slice(root.length).split(sep).filter(Boolean)){
    cur=join(cur,part);const st=fs.lstatSync(cur);
    if(st.isSymbolicLink())throw Object.assign(Error('INBOX_LINK_REJECTED'),{code:'INBOX_LINK_REJECTED'});
  }
}
export function createInbox({root,agentKey,fs=nodeFs}){
  if(typeof root!=='string'||!isAbsolute(root))throw Error('INBOX_ROOT_ABSOLUTE_REQUIRED');
  if(!Object.hasOwn(INBOX_DIRS,agentKey))throw Error('INBOX_AGENT_REJECTED');
  rejectLinks(fs,root);
  if(!fs.lstatSync(root).isDirectory())throw Error('INBOX_ROOT_NOT_DIRECTORY');
  const rootReal=fs.realpathSync(root);
  if(!same(rootReal,resolve(root)))throw Error('INBOX_ROOT_NOT_CANONICAL');
  const dir=join(rootReal,INBOX_DIRS[agentKey]);
  function agentDir(){
    try{fs.lstatSync(dir);}catch(e){if(e?.code!=='ENOENT')throw e;fs.mkdirSync(dir);}   // non-recursive, directly under the root
    rejectLinks(fs,dir);
    if(!fs.lstatSync(dir).isDirectory())throw Error('INBOX_DIR_NOT_DIRECTORY');
    const real=fs.realpathSync(dir);
    if(!same(real,dir)||!inside(rootReal,real))throw Error('INBOX_DIR_OUTSIDE_ROOT');
    return real;
  }
  function target(taskId,suffix){
    if(typeof taskId!=='string'||!TASK_ID.test(taskId))throw Error('INBOX_TASK_ID_REJECTED');
    const base=agentDir();const file=join(base,taskId+suffix);
    if(!same(dirname(file),base)||!inside(rootReal,file))throw Error('INBOX_TARGET_OUTSIDE_ROOT');
    return file;
  }
  function writeExclusive(file,content){
    const fd=fs.openSync(file,'wx',0o600);
    try{fs.writeFileSync(fd,content,'utf8');}finally{fs.closeSync(fd);}
    // Re-check after the write: the created entry must be a regular file, not a link.
    const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())throw Error('INBOX_TARGET_NOT_FILE');
  }
  return Object.freeze({
    root:rootReal,dir,
    // Throws with code 'EEXIST' if the task file already exists (the caller treats that as already delivered).
    deliver(taskId,payload){
      if(typeof payload!=='string')throw Error('INBOX_PAYLOAD_TYPE');
      const file=target(taskId,TASK_SUFFIX);writeExclusive(file,fixedHeader(taskId,agentKey)+payload);return file;
    },
    markCancelled(taskId){
      const file=target(taskId,CANCELLED_SUFFIX);
      try{writeExclusive(file,CANCELLED_CONTENT);}catch(e){if(e?.code!=='EEXIST')throw e;}
      return file;
    },
    isCancelled(taskId){
      const file=target(taskId,CANCELLED_SUFFIX);
      try{const st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('INBOX_LINK_REJECTED');return st.isFile();}
      catch(e){if(e?.code==='ENOENT')return false;throw e;}
    }
  });
}
