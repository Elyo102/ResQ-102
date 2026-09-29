import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {assembleGitTasks,isProvenancedTask,taskProvenance} from './git-provenance.mjs';
import {buildTask,isBuiltTask} from './task-contracts.mjs';

function fixture(t,{claude='// synthetic planner',grok='// synthetic swap',gemini='{"scripts":{}}'}={}){
 const root=mkdtempSync(join(tmpdir(),'resq-provenance-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 const put=(file,value)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),value);};
 git('init','--quiet');git('config','user.name','Synthetic Test');git('config','user.email','test@example.invalid');git('config','commit.gpgsign','false');
 put('functions/schedule-runtime.js',Array(1512).fill('// filler').concat(claude).join('\n')+'\n');
 put('firestore.rules',Array(1656).fill('// filler').concat(grok).join('\n')+'\n');
 put('tests/package.json',gemini+'\n');
 git('add','.');git('-c','core.hooksPath=NUL','commit','--quiet','-m','synthetic fixture');
 const sha=git('rev-parse','HEAD');
 const selections={Claude:[{file:'functions/schedule-runtime.js',line_start:1513,line_end:1513}],
  Grok:[{file:'firestore.rules',line_start:1657,line_end:1657}],Gemini:[{file:'tests/package.json',line_start:1,line_end:1}]};
 return {root,git,put,sha,selections,input:{repoPath:root,approvedSha:sha,selections}};
}
test('exact clean Git blobs produce immutable branded tasks and blob/range provenance',t=>{
 const x=fixture(t),tasks=assembleGitTasks(x.input);
 for(const agent of ['Claude','Grok','Gemini']){
  const task=tasks[agent],proof=taskProvenance(task);
  assert.ok(isBuiltTask(task)&&isProvenancedTask(task));assert.ok(Object.isFrozen(task));
  assert.equal(task.sha,x.sha);assert.equal(proof.approvedSha,x.sha);assert.equal(proof.inputDigest,task.inputDigest);
  const s=proof.sources[0];assert.equal(s.blob,x.git('rev-parse',`${x.sha}:${s.file}`));assert.ok(Object.isFrozen(s));
  assert.ok(Buffer.byteLength(task.prompt)<=12000);
 }
 const fake=buildTask('Claude',{sha:x.sha,excerpts:[{...x.selections.Claude[0],text:'// substituted'}]});
 assert.equal(isProvenancedTask(fake),false);assert.equal(isProvenancedTask({...tasks.Claude}),false);
 assert.throws(()=>taskProvenance(fake),/SOURCE_PROVENANCE_REJECTED/);
});
test('dirty tracked, staged or untracked files reject rather than substitute current text',t=>{
 for(const mode of ['tracked','staged','untracked']){
  const x=fixture(t);x.put(mode==='untracked'?'unexpected.txt':'tests/package.json','altered');
  if(mode==='staged')x.git('add','.');assert.throws(()=>assembleGitTasks(x.input),/SOURCE_PROVENANCE_REJECTED/);
 }
});
test('wrong SHA, injected text, paths, ranges, duplicate selections and getters rejected',t=>{
 const x=fixture(t);
 for(const sha of ['HEAD','a'.repeat(40),x.sha+'f','--help'])assert.throws(()=>assembleGitTasks({...x.input,approvedSha:sha}));
 for(const patch of [{text:'substitution'},{file:'.env'},{file:'../functions/schedule-runtime.js'},{line_start:0},{line_start:1514,line_end:1513},{line_end:1664},{line_start:1513.5}]){
  const selections={...x.selections,Claude:[{...x.selections.Claude[0],...patch}]};assert.throws(()=>assembleGitTasks({...x.input,selections}));
 }
 assert.throws(()=>assembleGitTasks({...x.input,selections:{...x.selections,Claude:[...x.selections.Claude,...x.selections.Claude]}}));
 let accessed=false;const range={...x.selections.Claude[0]};Object.defineProperty(range,'file',{get(){accessed=true;return 'functions/schedule-runtime.js';},enumerable:true});
 assert.throws(()=>assembleGitTasks({...x.input,selections:{...x.selections,Claude:[range]}}));assert.equal(accessed,false);
});
test('secret-bearing committed source and excessive prompt reject before branding',t=>{
 for(const claude of ['Bearer synthetic-sensitive-value','const password="not-for-provider"','owner@example.invalid','x'.repeat(11500)]){
  const x=fixture(t,{claude});assert.throws(()=>assembleGitTasks(x.input));
 }
});
test('approved source cannot follow Git replacement objects',t=>{
 const x=fixture(t),original=x.sha;
 x.put('functions/schedule-runtime.js',Array(1512).fill('// filler').concat('// replacement').join('\n')+'\n');
 x.git('add','.');x.git('-c','core.hooksPath=NUL','commit','--quiet','-m','replacement fixture');const other=x.git('rev-parse','HEAD');
 x.git('checkout','--quiet',original);x.git('replace',original,other);
 assert.throws(()=>assembleGitTasks(x.input),/SOURCE_PROVENANCE_REJECTED/);
});
