import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {classifyPath} from '../ops-disaster-restore.mjs';
const require=createRequire(import.meta.url),policy=require('../functions/backup-policy.js');
const paths=['invitations/{inviteId}','onboarding_assignment_links/{uid}',
  'stations/{sid}/onboarding_operations/{requestId}','hr_invitation_operations/{id}',
  'hr_invitation_recipients/{id}','stations/{sid}/provision_operations/{requestId}'];
let passed=0;
for(const path of paths) {
  const entry=policy.getPolicy(path);
  assert.equal(entry.backupPolicy,'managed_export');passed++;
  assert.equal(entry.restorePolicy,'specialized_restore');passed++;
  assert.equal(entry.sensitivity,'restricted_identity');passed++;
  assert.equal(entry.humanReadable,'forbidden');passed++;
  assert.equal(entry.retention,'policy_required_before_wiring');passed++;
  assert.equal(policy.IDENTITY_POLICY_PATHS.includes(path),false);passed++;
  assert.equal(classifyPath(path.replace(/\{[^}]+\}/g,'fixture'),policy).action,'manual_required');passed++;
}
assert.equal(classifyPath('system/heartbeat',policy).action,'skipped_policy');passed++;
assert.equal(classifyPath('system/unrecognized',policy).action,'unclassified');passed++;
assert.equal(classifyPath('invitations/fixture/unknown/fixture',policy).action,'unclassified');passed++;
assert.deepEqual(policy.validatePolicies(policy.DATA_POLICIES),[]);passed++;
const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8').replace(/\r\n/g,'\n');
for(const path of [...paths,'system/heartbeat']) {assert.ok(rules.includes(`match /${path} {\n      allow read, write: if false;`));passed++;}
console.log(JSON.stringify({syntheticOnly:true,passed,failed:0,automaticRestoreEnabled:false}));
