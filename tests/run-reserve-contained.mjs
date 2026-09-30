import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {buildReserveReleasePlan} from './reserve-release-plan.mjs';

// Explicit split release gate: native backup/restore are separate mandatory
// checks. Every other command is derived from the unchanged application chain.
const here=fileURLToPath(new URL('.',import.meta.url));
const guard=createRequire(import.meta.url)('./lib/network-guard.cjs');
guard.assertActive();
if(Number(process.versions.node.split('.')[0])!==22)throw Error('Node22 required');
const npm=process.env.npm_execpath;
if(!npm||!path.isAbsolute(npm)||!fs.statSync(npm).isFile())throw Error('Registered npm entry required');
const {scripts}=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8'));
const plan=buildReserveReleasePlan(scripts);
console.log('Split release contained plan:',JSON.stringify({counts:plan.counts,separateNative:plan.excluded}));
let completed=0;
for(const step of plan.steps){
  const args=step.kind==='npm'?[npm,'run',step.name]:step.kind==='node'?[path.resolve(here,step.file),...(step.args||[])]:null;
  if(!args)throw Error('Unknown release step');
  console.log('Split contained step:',step.kind,step.name||step.file);
  const result=spawnSync(process.execPath,args,{cwd:here,env:process.env,stdio:'inherit',windowsHide:true,timeout:3600000});
  if(result.error||result.signal||result.status!==0){
    console.error('Split contained step failed:',JSON.stringify({kind:step.kind,target:step.name||step.file,code:result.error?.code||null,status:result.status,signal:result.signal}));
    process.exitCode=result.status>0?result.status:1;
    break;
  }
  completed++;
}
guard.assertClean();
console.log('Split contained result:',JSON.stringify({completed,total:plan.steps.length,separateNative:2,passed:completed===plan.steps.length}));
