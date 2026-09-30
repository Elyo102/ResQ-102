/** Isolated, source-reviewed AST mutations. Exit status alone is never a kill. */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createFixtureHarness} from './lib/mutation-fixture.mjs';
import {classifyMutationOutcome} from './lib/mutation-outcome.mjs';
import {EXPECTATION_SPEC} from './lib/calendar-expectation-spec.mjs';
import {buildExpectations} from './lib/calendar-expectations.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const packageData=JSON.parse(fs.readFileSync(new URL('./lib/calendar-mutation-descriptors.json',import.meta.url),'utf8'));
const index=JSON.parse(fs.readFileSync(new URL('./lib/calendar-assertion-sites.json',import.meta.url),'utf8'));
if(packageData.schema!==1 || packageData.excludedPlaceholders!==1 || packageData.mutations.length!==52)throw Error('MUTATION_DESCRIPTOR_INVENTORY');
const sources=Object.fromEntries(Object.keys(index.suites).map(suite=>[suite,fs.readFileSync(new URL('../'+suite,import.meta.url),'utf8')]));
const expectations=buildExpectations(EXPECTATION_SPEC,packageData.mutations,index,sources);
const harness=createFixtureHarness(root);
for(const suite of Object.keys(index.suites)){
 const result=harness.run(suite);
 const outcome=classifyMutationOutcome(result,{suite,allowed:[],required:[]});
 if(outcome.kind!=='SURVIVED')throw Error('MUTATION_BASELINE '+suite+' '+outcome.reason);
}
let caught=0;
for(const mutation of packageData.mutations){
 const expected=expectations[mutation.id];
 let result;
 try{result=harness.run(expected.suite,mutation);}
 catch(error){
  const kind=String(error?.message).startsWith('INVALID_MUTANT_')?'INVALID_MUTANT':'HARNESS_ERROR';
  throw Error(mutation.id+' '+kind);
 }
 const outcome=classifyMutationOutcome(result,expected);
 if(outcome.kind!=='KILLED')throw Error(mutation.id+' '+outcome.kind+' '+outcome.reason);
 caught++;
}
console.log('✓ schedule-calendar-mutations: '+caught+'/'+packageData.mutations.length+' verified assertion kills');
console.log('Non-executable placeholders excluded: '+packageData.excludedPlaceholders);
