import assert from 'node:assert/strict';
import {buildPlan} from '../ops-disaster-restore.mjs';
const paths=['invitations/fixture','onboarding_assignment_links/fixture',
  'stations/fixture/onboarding_operations/fixture','hr_invitation_operations/fixture',
  'hr_invitation_recipients/fixture','stations/fixture/provision_operations/fixture'];
const plan=buildPlan({manifest:{id:'synthetic',created_at:'2026-10-02T00:00:00Z',source_project:'demo-resq',policy_digest:'synthetic'},
  documents:paths.map(path=>({path,sha256:'synthetic'}))},'demo-restore');
assert.equal(plan.counts.manual_required,6);
assert.equal(plan.counts.unclassified,0);
assert.deepEqual(plan.write_order,[]);
assert.deepEqual(plan.identity_group.documents,[]);
assert.deepEqual(plan.manual_required.map(x=>x.path).sort(),paths.sort());
console.log(JSON.stringify({syntheticOnly:true,passed:5,failed:0,restoreWrites:0}));
