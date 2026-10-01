import assert from 'node:assert/strict';
import fs from 'node:fs';

const original=JSON.parse(fs.readFileSync(new URL('./hours46-original-scripts.json',import.meta.url),'utf8'));
export const NATIVE_COMMANDS=Object.freeze(['node ops-backup-test.mjs','node ops-restore-drill-test.mjs','node ops-backup-archive.test.mjs']);
export const WRAPPER='node run-hours46-release.mjs';
export function buildHours46Plan(scripts){
  assert.ok(scripts && typeof scripts==='object' && !Array.isArray(scripts),'GATE_SCRIPTS');
  assert.deepEqual(Object.keys(scripts).sort(),Object.keys(original).sort(),'GATE_KEYS');
  for(const name of Object.keys(original))assert.equal(scripts[name],name==='release:validate'?WRAPPER:original[name],'GATE_CHANGED '+name);
  const outer=scripts.all.split(' && ');
  assert.equal(outer.filter(x=>x==='npm run static').length,1,'STATIC_ONCE');
  assert.equal(outer.filter(x=>x==='npm run dr:test').length,1,'DR_ONCE');
  const staticSteps=scripts.static.split(' && ');
  const drSteps=scripts['dr:test'].split(' && ');
  for(const [i,excluded] of NATIVE_COMMANDS.entries())assert.equal((i<2?staticSteps:drSteps).filter(x=>x===excluded).length,1,'EXACT_NATIVE');
  for(const excluded of NATIVE_COMMANDS)assert.equal([...staticSteps,...drSteps].filter(x=>x===excluded).length,1,'NATIVE_ONCE');
  const steps=[];
  for(const command of outer){
    assert.match(command,/^npm run [a-zA-Z0-9:_-]+(?![\s\S])/,'OUTER_GRAMMAR');
    const name=command.slice(8);assert.ok(Object.hasOwn(scripts,name),'UNKNOWN_GROUP');
    if(name!=='static'&&name!=='dr:test'){steps.push(Object.freeze({kind:'npm',name}));continue;}
    for(const leaf of name==='static'?staticSteps:drSteps){
      if(NATIVE_COMMANDS.includes(leaf))continue;
      if(name==='dr:test'&&leaf==='node --test ../functions/backup-monitoring.test.js'){
        steps.push(Object.freeze({kind:'node',file:'../functions/backup-monitoring.test.js',args:Object.freeze([]),execArgv:Object.freeze(['--test'])}));continue;
      }
      assert.ok(leaf==='node ../release-stamp.mjs --check'||/^node (?:\.\.\/functions\/)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:mjs|js|cjs)(?![\s\S])/.test(leaf),'STATIC_GRAMMAR');
      const [file,...args]=leaf.slice(5).split(' ');
      steps.push(Object.freeze({kind:'node',file,args:Object.freeze(args)}));
    }
  }
  return Object.freeze({steps:Object.freeze(steps),native:NATIVE_COMMANDS,originalAll:scripts.all,staticTotal:staticSteps.length,drTotal:drSteps.length});
}
export function assertSuccessful(result,label){
  assert.ok(result && !result.error && !result.signal && result.status===0,'GATE_BRANCH_FAILED '+label);
}
// Injection is for deterministic failure tests; the executable supplies only local fixed ports.
export async function runHours46Sequence(ports){
  const before=await ports.evidence();
  await ports.contract();
  assertSuccessful(await ports.native(),'native');
  assertSuccessful(await ports.contained(),'contained');
  await ports.ledger();
  assert.deepEqual(await ports.evidence(),before,'GATE_TREE_CHANGED');
  return ports.attest();
}
