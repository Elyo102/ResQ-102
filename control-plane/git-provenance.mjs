import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {TASKS,buildTask} from './task-contracts.mjs';

// Local immutable Git objects only. This module has no HTTP/provider adapters.
const verified=new WeakSet();
export const isProvenancedTask=task=>verified.has(task);
const fail=()=>{throw Error('SOURCE_PROVENANCE_REJECTED');};
function exact(value,keys){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail();
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(k=>!Object.hasOwn(descriptors,k))
  ||Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')))fail();
}
export function assembleGitTasks(input){
 exact(input,['repoPath','approvedSha','selections']);
 const {repoPath,approvedSha,selections}=input;
 if(typeof repoPath!=='string'||!isAbsolute(repoPath)||!/^([a-f0-9]{40})$/.test(approvedSha||''))fail();
 exact(selections,['Claude','Grok','Gemini']);
 let root;try{root=realpathSync(repoPath);}catch{fail();}
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_')));
 env.GIT_CONFIG_NOSYSTEM='1';env.GIT_CONFIG_GLOBAL=process.platform==='win32'?'NUL':'/dev/null';
 env.GIT_OPTIONAL_LOCKS='0';env.GIT_NO_LAZY_FETCH='1';env.GIT_TERMINAL_PROMPT='0';
 const git=(...args)=>{
  try{return execFileSync('git',['--no-replace-objects','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',root,...args],
   {env,encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024,windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch{fail();}
 };
 const verify=()=>{
  let top;try{top=realpathSync(git('rev-parse','--show-toplevel').trim());}catch{fail();}
  if(top!==root||git('rev-parse','--verify','HEAD').trim()!==approvedSha
   ||git('for-each-ref','--format=%(refname)','refs/replace/').trim()
   ||git('cat-file','-t',approvedSha).trim()!=='commit'
   ||git('status','--porcelain=v1','--untracked-files=all').trim())fail();
 };
 verify();
 const tasks={},cache=new Map();let total=0;
 for(const agent of ['Claude','Grok','Gemini']){
  const ranges=selections[agent];
  if(!Array.isArray(ranges)||!ranges.length||ranges.length>12)fail();
  const seen=new Set(),sources=[];
  const excerpts=ranges.map(range=>{
   exact(range,['file','line_start','line_end']);
   const {file,line_start:start,line_end:end}=range;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end
    ||!TASKS[agent].files.some(([path,lo,hi])=>file===path&&start>=lo&&end<=hi))fail();
   const key=`${file}:${start}:${end}`;if(seen.has(key))fail();seen.add(key);
   if(!cache.has(file)){
    const tree=git('ls-tree',approvedSha,'--',file).trim();
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(tree);
    if(!match||match[3]!==file)fail();
    const text=git('cat-file','blob',match[2]);
    if(text.includes('\u0000')||text.includes('\ufffd'))fail();
    const lines=text.replace(/\r\n/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
    cache.set(file,{blob:match[2],lines});
   }
   const source=cache.get(file);if(end>source.lines.length)fail();
   sources.push(Object.freeze({file,line_start:start,line_end:end,blob:source.blob}));
   return {file,line_start:start,line_end:end,text:source.lines.slice(start-1,end).join('\n')};
  });
  const built=buildTask(agent,{sha:approvedSha,excerpts});
  const bytes=Buffer.byteLength(built.prompt);total+=bytes;
  if(bytes>12000||total>60000)fail();
  // Keep original buildTask brand and immutable source metadata separately.
  tasks[agent]=built;sourcesByTask.set(built,Object.freeze(sources));
 }
 verify(); // Do not bless a changed checkout observed during assembly.
 for(const task of Object.values(tasks))verified.add(task);
 return Object.freeze(tasks);
}
const sourcesByTask=new WeakMap();
export function taskProvenance(task){
 if(!isProvenancedTask(task))fail();
 return Object.freeze({approvedSha:task.sha,inputDigest:task.inputDigest,sources:sourcesByTask.get(task)});
}
