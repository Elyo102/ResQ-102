import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {buildExpectations} from './lib/calendar-expectations.mjs';
import {EXPECTATION_SPEC} from './lib/calendar-expectation-spec.mjs';
import {buildIndex} from './lib/calendar-assertion-index.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const descriptors=JSON.parse(fs.readFileSync(new URL('./lib/calendar-mutation-descriptors.json',import.meta.url),'utf8')).mutations;
const index=buildIndex(root);
const sources=Object.fromEntries(Object.keys(index.suites).map(suite=>[suite,fs.readFileSync(new URL('../'+suite,import.meta.url),'utf8')]));
test('all 52 source-authored expectations resolve to existing reachable assertion sites',()=>{
 const mapped=buildExpectations(EXPECTATION_SPEC,descriptors,index,sources);
 assert.equal(Object.keys(mapped).length,52);
 for(const expectation of Object.values(mapped)){
  assert.ok(expectation.required.length>0);
  assert.ok(expectation.required.every(id=>expectation.allowed.includes(id)));
 }
});
test('missing/extra descriptor mapping is rejected before execution',()=>{
 const missing={...EXPECTATION_SPEC};delete missing['calendar-01'];
 assert.throws(()=>buildExpectations(missing,descriptors,index,sources),/COVERAGE/);
 assert.throws(()=>buildExpectations({...EXPECTATION_SPEC,unexpected:{}},descriptors,index,sources),/COVERAGE/);
});
test('wrong test name, expression or unreachable site cannot become an expected failure',()=>{
 for(const patch of [{testName:'MISSING_TEST'},{expression:'assert.ok(false)'},{required:'yes'}]){
  const changed=structuredClone(EXPECTATION_SPEC);Object.assign(changed['calendar-01'].sites[0],patch);
  assert.throws(()=>buildExpectations(changed,descriptors,index,sources),/CALENDAR_EXPECTATION_/);
 }
});
test('checked-in assertion index matches exact current normalized source',()=>{
 const saved=JSON.parse(fs.readFileSync(new URL('./lib/calendar-assertion-sites.json',import.meta.url),'utf8'));
 assert.deepEqual(saved,index);
});
