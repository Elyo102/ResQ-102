import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {buildHours46Plan,WRAPPER,NATIVE_COMMANDS,runHours46Sequence} from './lib/hours46-gate-contract.mjs';
import {nativeOpsEnvironment,assertNativeOpsResult,NATIVE_OPS_SUITES} from './lib/hours46-native-ops.mjs';
const frozen=JSON.parse(fs.readFileSync(new URL('./lib/hours46-original-scripts.json',import.meta.url),'utf8'));
const current=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8')).scripts;
test('actual original graph retained except explicit release supervisor',()=>{
 const plan=buildHours46Plan(current);
 assert.equal(current.all,frozen.all);assert.equal(current.static,frozen.static);
 assert.equal(current['release:validate'],WRAPPER);
 const actual=plan.steps.map(s=>s.kind==='npm'?'npm run '+s.name:'node '+(s.execArgv?.length?s.execArgv.join(' ')+' ':'')+s.file+(s.args.length?' '+s.args.join(' '):''));
 const expected=frozen.all.split(' && ').flatMap(c=>['npm run static','npm run dr:test'].includes(c)?frozen[c.slice(8)].split(' && ').filter(x=>!NATIVE_COMMANDS.includes(x)):[c]);
 assert.deepEqual(actual,expected);assert.equal(plan.native.length,3);assert.deepEqual(NATIVE_OPS_SUITES.map(s=>'node '+s),plan.native);
 assert.deepEqual(plan.steps.filter(s=>s.execArgv),[{kind:'node',file:'../functions/backup-monitoring.test.js',args:[],execArgv:['--test']}]);
 assert.equal(actual.filter(s=>s==='node --test ../functions/backup-monitoring.test.js').length,1);
 assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.steps)&&plan.steps.every(Object.isFrozen));
});
test('every script alteration, omission and addition is rejected',()=>{
 for(const key of Object.keys(frozen)){
  const altered={...current,[key]:current[key]+' && node omitted.mjs'};assert.throws(()=>buildHours46Plan(altered));
  const missing={...current};delete missing[key];assert.throws(()=>buildHours46Plan(missing));
 }
 assert.throws(()=>buildHours46Plan({...current,unknown:'node fake.mjs'}));
});
test('native omission duplication and unknown syntax cannot change denominator',()=>{
 for(const command of NATIVE_COMMANDS){
  const group=command.endsWith('ops-backup-archive.test.mjs')?'dr:test':'static';
  assert.throws(()=>buildHours46Plan({...current,[group]:current[group].replace(command,'node missing.mjs')}));
  assert.throws(()=>buildHours46Plan({...current,[group]:current[group]+' && '+command}));
 }
 for(const replacement of ['node ../functions/backup-monitoring.test.js','node --inspect ../functions/backup-monitoring.test.js','node --test ../functions/other.test.js'])assert.throws(()=>buildHours46Plan({...current,'dr:test':current['dr:test'].replace('node --test ../functions/backup-monitoring.test.js',replacement)}));
 for(const all of ['npm run unknown',current.all+'; exit 0',current.all+'\n',current.all+'\u2028'])assert.throws(()=>buildHours46Plan({...current,all}));
});
function ports(){
 const events=[];const ok=()=>({status:0,signal:null});const evidence={tree:'frozen',files:{a:'hash'}};
 return {events,evidence:async()=>{events.push('evidence');return structuredClone(evidence);},contract:async()=>events.push('contract'),native:async()=>{events.push('native');return ok();},contained:async()=>{events.push('contained');return ok();},ledger:async()=>events.push('ledger'),attest:async()=>{events.push('attest');return 'receipt';}};
}
test('both mandatory branches and clean frozen evidence precede attestation',async()=>{
 const p=ports();assert.equal(await runHours46Sequence(p),'receipt');
 assert.deepEqual(p.events,['evidence','contract','native','contained','ledger','evidence','attest']);
});
for(const branch of ['native','contained'])for(const result of [{status:1},{status:null,signal:'SIGTERM'},{status:0,error:{code:'ETIMEDOUT'}}]){
 test(branch+' failure never writes attestation '+JSON.stringify(result),async()=>{
  const p=ports();p[branch]=async()=>result;await assert.rejects(runHours46Sequence(p));assert.ok(!p.events.includes('attest'));
  if(branch==='native')assert.ok(!p.events.includes('contained'));
 });
}
for(const stage of ['contract','ledger'])test(stage+' failure prevents attestation',async()=>{
 const p=ports();p[stage]=async()=>{throw Error('expected');};await assert.rejects(runHours46Sequence(p));assert.ok(!p.events.includes('attest'));
});
test('changed final tree prevents attestation',async()=>{
 const p=ports();let n=0;p.evidence=async()=>({tree:String(n++)});await assert.rejects(runHours46Sequence(p));assert.ok(!p.events.includes('attest'));
});
test('native environment contains no inherited credentials or preload',()=>{
 const env=nativeOpsEnvironment({config:'/fixed/config',tmp:'/fixed/tmp',profile:'/fixed/home',hooks:'/fixed/hooks',templates:'/fixed/templates'},false);
 for(const key of ['NODE_OPTIONS','FIREBASE_TOKEN','GOOGLE_APPLICATION_CREDENTIALS','RESQ_CONTAINMENT_DIR'])assert.equal(Object.hasOwn(env,key),false);
 assert.equal(env.GIT_ALLOW_PROTOCOL,'file');assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(env.GIT_ATTR_NOSYSTEM,'1');
 assert.throws(()=>assertNativeOpsResult({status:0,signal:'SIGTERM'},'fixed'));
});
