import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildReserveReleasePlan as reserveReleasePlan,NATIVE_OPS_SUITES,assertSplitReleaseWorkflow,SPLIT_WORKFLOW_STEPS} from './reserve-release-plan.mjs';
import {nativeOpsEnvironment,assertNativeOpsResult} from './run-native-ops.mjs';
const fixture=()=>({all:'node run-contained.mjs all','all:inner':'npm run test:reproducibility && npm run test:inventory && npm run pages:source && npm run static && npm run browser',static:'node before.mjs && node ops-backup-test.mjs && node middle.mjs && node ops-restore-drill-test.mjs && node after.mjs'});
test('plan removes only the exact two separately executed suites and retains all ordering',()=>{
 const input=fixture(),original=JSON.stringify(input),plan=reserveReleasePlan(input);
 assert.deepEqual(plan.steps,[{kind:'npm',name:'test:reproducibility'},{kind:'npm',name:'test:inventory'},{kind:'npm',name:'pages:source'},...['before.mjs','middle.mjs','after.mjs'].map(file=>({kind:'node',file})),{kind:'npm',name:'browser'}]);
 assert.deepEqual(plan.counts,{outerSteps:5,staticTotal:5,staticContained:3,native:2,containedSteps:7});assert.equal(JSON.stringify(input),original);assert.ok(Object.isFrozen(plan.steps));
});
const splitScripts=()=>({...fixture(),'native:ops':'node run-native-ops.mjs','reserve:contained':'node run-contained.mjs reserve:contained','reserve:contained:inner':'node run-reserve-contained.mjs','reserve:release':'npm run native:ops && npm run reserve:contained'});
const workflow='jobs:\n  app:\n    steps:\n'+SPLIT_WORKFLOW_STEPS+'\n  rules:\n    steps: []\n';
test('both native and contained CI steps are mandatory and ordered',()=>assert.equal(assertSplitReleaseWorkflow(workflow,splitScripts()),true));
for(const [name,mutate] of [
 ['conditional',value=>value.replace('        run: npm run native:ops','        if: false\n        run: npm run native:ops')],
 ['continue on error',value=>value.replace('        run: npm run native:ops','        continue-on-error: true\n        run: npm run native:ops')],
 ['missing native',value=>value.replace('        run: npm run native:ops','        run: echo skipped')],
 ['reversed',value=>value.replace('run native:ops','run PLACEHOLDER').replace('run reserve:contained','run native:ops').replace('run PLACEHOLDER','run reserve:contained')],
 ['duplicate',value=>value.replace(SPLIT_WORKFLOW_STEPS,SPLIT_WORKFLOW_STEPS+'\n'+SPLIT_WORKFLOW_STEPS)],
])test('split workflow rejects '+name,()=>assert.throws(()=>assertSplitReleaseWorkflow(mutate(workflow),splitScripts()),/RESERVE_SPLIT/));
test('aggregate cannot hide native failure with semicolon',()=>{const scripts=splitScripts();scripts['reserve:release']='npm run native:ops; npm run reserve:contained';assert.throws(()=>assertSplitReleaseWorkflow(workflow,scripts),/RESERVE_SPLIT_SCRIPTS/);});
for(const windows of [false,true])test('native environment is a closed fresh allowlist '+windows,()=>{
 const dirs={tmp:'/owned/tmp',profile:'/owned/profile',hooks:'/owned/hooks',templates:'/owned/templates',config:'/owned/config'},env=nativeOpsEnvironment(dirs,windows);
 for(const key of ['NODE_OPTIONS','RESQ_CONTAINMENT_DIR','GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_TOKEN','OPENAI_API_KEY','HTTP_PROXY','GIT_SSH_COMMAND'])assert.equal(env[key],undefined);
 assert.equal(env.GIT_ALLOW_PROTOCOL,'file');assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(env.GIT_TERMINAL_PROMPT,'0');assert.equal(env.TEMP,dirs.tmp);assert.equal(env.HOME,dirs.profile);
 const config=Object.fromEntries(Array.from({length:Number(env.GIT_CONFIG_COUNT)},(_,i)=>[env['GIT_CONFIG_KEY_'+i],env['GIT_CONFIG_VALUE_'+i]]));
 assert.equal(config['protocol.allow'],'never');assert.equal(config['protocol.file.allow'],'always');assert.equal(config['core.hooksPath'],dirs.hooks);assert.equal(config['commit.gpgSign'],'false');assert.equal(config['core.fsmonitor'],'false');
});
for(const result of [{status:1},{status:0,error:{code:'ETIMEDOUT'}},{status:0,signal:'SIGTERM'},{status:null}])test('native failure cannot become green '+JSON.stringify(result),()=>assert.throws(()=>assertNativeOpsResult(result,'ops-backup-test.mjs'),/NATIVE_OPS_SUITE_FAILED/));
test('native success requires clean exit zero',()=>assert.doesNotThrow(()=>assertNativeOpsResult({status:0},'ops-backup-test.mjs')));
for(const name of NATIVE_OPS_SUITES)for(const mode of ['missing','duplicate'])test(mode+' '+name+' rejects',()=>{
 const scripts=fixture(),command='node '+name;
 scripts.static=mode==='missing'?scripts.static.split(' && ').filter(step=>step!==command).join(' && '):scripts.static+' && '+command;
 assert.throws(()=>reserveReleasePlan(scripts),/RESERVE_PLAN_EXACT_TWO/);
});
for(const suffix of [' | echo pass','; echo pass','\n','\u2028',' && '])test('noncanonical static syntax rejects '+JSON.stringify(suffix),()=>{const scripts=fixture();scripts.static+=suffix;assert.throws(()=>reserveReleasePlan(scripts),/RESERVE_PLAN_GRAMMAR/);});
test('static must be reached once in the full preserved application chain',()=>{const scripts=fixture();scripts['all:inner']=scripts['all:inner'].replace('npm run static','npm run other');assert.throws(()=>reserveReleasePlan(scripts),/RESERVE_PLAN_STATIC_ONCE/);});
test('actual package plan preserves every command except the exact two native suites',()=>{
 const scripts=JSON.parse(fs.readFileSync(new URL('./package.json',import.meta.url),'utf8')).scripts,plan=reserveReleasePlan(scripts);
 assert.equal(plan.counts.staticTotal-plan.counts.staticContained,2);
 assert.deepEqual(plan.steps.filter(step=>step.kind==='npm').map(step=>'npm run '+step.name),scripts['all:inner'].split(' && ').filter(step=>step!=='npm run static'));
 assert.deepEqual(plan.steps.filter(step=>step.kind==='node').map(step=>'node '+step.file+(step.args?' '+step.args.join(' '):'')),scripts.static.split(' && ').filter(step=>!plan.excluded.includes(step)));
});
test('existing read-only stamp argv preserved exactly; writes and extra args rejected',()=>{
 const scripts=fixture();scripts.static+=' && node ../release-stamp.mjs --check';
 assert.deepEqual(reserveReleasePlan(scripts).steps.find(step=>step.file==='../release-stamp.mjs'),{kind:'node',file:'../release-stamp.mjs',args:['--check']});
 for(const suffix of ['--write','--check --write'])assert.throws(()=>reserveReleasePlan({...scripts,static:scripts.static.replace('--check',suffix)}),/RESERVE_PLAN_GRAMMAR/);
});
