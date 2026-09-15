import assert from 'node:assert/strict';
import {
  assertNoActiveFunctionRollout, evaluateRequiredIndexes, indexSignature, waitForRequiredIndexes
} from './firebase-release-state.mjs';

const signature = 'callouts|COLLECTION|uids:ARRAY_CONTAINS,active:ASCENDING,created_key:DESCENDING';
const raw = (state = 'READY') => ({
  name:'projects/p/databases/(default)/collectionGroups/callouts/indexes/i1',
  queryScope:'COLLECTION', state,
  fields:[
    { fieldPath:'uids', arrayConfig:'CONTAINS' },
    { fieldPath:'active', order:'ASCENDING' },
    { fieldPath:'created_key', order:'DESCENDING' },
    { fieldPath:'__name__', order:'DESCENDING' }
  ]
});

assert.equal(indexSignature(raw()), signature);
assert.equal(evaluateRequiredIndexes([raw()], [signature]).ready, true);
assert.throws(() => evaluateRequiredIndexes([{ ...raw(), state:undefined }], [signature]), /state is missing/);
assert.throws(() => evaluateRequiredIndexes([raw('ERROR')], [signature]), /required index failed/);

let clock = 0, reads = 0, waits = 0;
const completed = await waitForRequiredIndexes({
  listIndexes:async () => (++reads === 1 ? [raw('CREATING')] : [raw('READY')]),
  requiredSignatures:[signature], timeoutMs:100, pollMs:10,
  now:() => clock, wait:async (ms) => { waits += 1; clock += ms; }
});
assert.equal(completed.ready, true);
assert.equal(reads, 2);
assert.equal(waits, 1);

reads = 0; waits = 0;
await assert.rejects(() => waitForRequiredIndexes({
  listIndexes:async () => { reads += 1; return [{ ...raw(), state:undefined }]; },
  requiredSignatures:[signature], timeoutMs:100, pollMs:10,
  now:() => 0, wait:async () => { waits += 1; }
}), /state is missing/);
assert.equal(reads, 1, 'missing state fails on the first raw response');
assert.equal(waits, 0, 'missing state never enters the poll delay');

assert.deepEqual(assertNoActiveFunctionRollout({
  functions:[{ name:'projects/p/locations/r/functions/f', state:'ACTIVE' }], unreachable:[]
}), { active:1 });
assert.throws(() => assertNoActiveFunctionRollout({
  functions:[{ name:'f', state:'DEPLOYING' }], unreachable:[]
}), /rollout is active/);
assert.throws(() => assertNoActiveFunctionRollout({ functions:[{ name:'f' }], unreachable:[] }),
  /state is missing/);

console.log('Firebase raw release-state checks PASS');
