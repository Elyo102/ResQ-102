import {assertApplicationGate} from './lib/gate-contract.mjs';

export const NATIVE_OPS_SUITES=Object.freeze(['ops-backup-test.mjs','ops-restore-drill-test.mjs']);
export const SPLIT_WORKFLOW_STEPS='      - name: Native temporary backup and restore — isolated Git environment\n        working-directory: tests\n        run: npm run native:ops\n\n      - name: Contained release remainder — every application check except the two native tests above\n        working-directory: tests\n        run: npm run reserve:contained';
export function assertSplitReleaseWorkflow(workflow,scripts){
  assertApplicationGate(scripts);
  if(scripts['native:ops']!=='node run-native-ops.mjs'||scripts['reserve:contained']!=='node run-contained.mjs reserve:contained'
    ||scripts['reserve:contained:inner']!=='node run-reserve-contained.mjs'||scripts['reserve:release']!=='npm run native:ops && npm run reserve:contained')throw Error('RESERVE_SPLIT_SCRIPTS');
  const text=String(workflow).replace(/\r\n/g,'\n');
  if((text.match(/^  app:$/gm)||[]).length!==1||(text.match(/^  rules:$/gm)||[]).length!==1)throw Error('RESERVE_SPLIT_JOBS');
  const start=text.indexOf('\n  app:\n'),end=text.indexOf('\n  rules:\n',start);
  if(start<0||end<start)throw Error('RESERVE_SPLIT_JOBS');
  const app=text.slice(start,end);
  if(app.split(SPLIT_WORKFLOW_STEPS).length!==2||/^\s*(?:if|continue-on-error):/m.test(app)
    ||(app.match(/^    steps:$/gm)||[]).length!==1)throw Error('RESERVE_SPLIT_STEPS');
  const after=app.slice(app.indexOf(SPLIT_WORKFLOW_STEPS)+SPLIT_WORKFLOW_STEPS.length);
  if(after.split('\n').some(line=>line.trim()&&!line.trim().startsWith('#')))throw Error('RESERVE_SPLIT_TRAILING');
  return true;
}
export function buildReserveReleasePlan(scripts){
  assertApplicationGate(scripts);
  if(typeof scripts.static!=='string')throw Error('RESERVE_PLAN_STATIC');
  const steps=scripts.static.split(' && ');
  if(!steps.every(step=>step==='node ../release-stamp.mjs --check'||/^node (?:\.\.\/functions\/)?[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(?:mjs|js|cjs)(?![\s\S])/.test(step)))throw Error('RESERVE_PLAN_GRAMMAR');
  const excluded=NATIVE_OPS_SUITES.map(name=>'node '+name);
  for(const command of excluded)if(steps.filter(step=>step===command).length!==1)throw Error('RESERVE_PLAN_EXACT_TWO');
  const allSteps=scripts['all:inner'].split(' && ');
  if(allSteps.filter(step=>step==='npm run static').length!==1)throw Error('RESERVE_PLAN_STATIC_ONCE');
  const kept=steps.filter(step=>!excluded.includes(step));
  const flattened=allSteps.flatMap(step=>step==='npm run static'?kept.map(value=>value==='node ../release-stamp.mjs --check'
    ?{kind:'node',file:'../release-stamp.mjs',args:Object.freeze(['--check'])}:{kind:'node',file:value.slice(5)}):[{kind:'npm',name:step.slice(8)}]);
  return Object.freeze({steps:Object.freeze(flattened.map(Object.freeze)),excluded:Object.freeze(excluded),
    counts:Object.freeze({outerSteps:allSteps.length,staticTotal:steps.length,staticContained:kept.length,native:2,containedSteps:flattened.length})});
}
