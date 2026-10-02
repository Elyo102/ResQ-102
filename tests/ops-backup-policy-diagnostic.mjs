import assert from 'node:assert/strict';
import {summarizeRootPolicyGaps} from '../ops-backup-policy-diagnostic.mjs';
const result=summarizeRootPolicyGaps(['stations','quota','private-person@example.test','_resq_restore_canary'],
  {DATA_POLICIES:[{path:'stations/{sid}'}]},["db.collection('quota')"]);
assert.equal(result.unknownRootCount,2);
assert.deepEqual(result.sourceBackedUnknownRoots,['quota']);
assert.equal(result.undisclosedUnknownRootCount,1);
assert.equal(result.nestedCoverageVerified,false);
assert.equal(JSON.stringify(result).includes('private-person'),false);
console.log(JSON.stringify({syntheticOnly:true,passed:5,failed:0}));
const expanded=summarizeRootPolicyGaps(['quota','budget'],{DATA_POLICIES:[]},["db.collection(`quota`);collection(db, 'budget')"]);
assert.deepEqual(expanded.sourceBackedUnknownRoots,['budget','quota']);
console.log(JSON.stringify({syntheticOnly:true,expandedSourceSyntax:1,failed:0}));
for (const source of ["db.doc('quota/' + id)",'db.doc(`quota/${id}`)',"doc(db, 'quota', id)","db.collection('quota/nested')"]) {
  assert.deepEqual(summarizeRootPolicyGaps(['quota'],{DATA_POLICIES:[]},[source]).sourceBackedUnknownRoots,['quota']);
}
console.log(JSON.stringify({syntheticOnly:true,documentSyntax:4,failed:0}));
