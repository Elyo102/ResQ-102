import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {classifyPath,buildPlan} from '../ops-disaster-restore.mjs';
const policy=createRequire(import.meta.url)('../functions/backup-policy.js');
export const paths=["stations/{sid}/bulletin_requests/{id}","stations/{sid}/bulletin_rate_limits/{id}","stations/{sid}/schedule_people/{id}","stations/{sid}/schedule_source_bindings/{id}","stations/{sid}/schedule_person_link_index/{id}","stations/{sid}/schedule_identity_state/current","stations/{sid}/schedule_identity_operations/{id}","stations/{sid}/schedule_identity_audit/{id}","schedule_person_link_reservations/{id}"];
let passed=0;
for(const path of paths) {
 const p=policy.getPolicy(path);
 for(const [k,v] of Object.entries({backupPolicy:'managed_export',restorePolicy:'specialized_restore',sensitivity:'restricted_identity',humanReadable:'forbidden',retention:'policy_required_before_wiring'})){assert.equal(p[k],v);passed++;}
 assert.equal(policy.IDENTITY_POLICY_PATHS.includes(path),false);passed++;
 assert.equal(classifyPath(path.replace(/\{[^}]+\}/g,'fixture'),policy).action,'manual_required');passed++;
}
assert.equal(classifyPath('stations/fixture/schedule_identity_state/other',policy).action,'unclassified');passed++;
assert.deepEqual(policy.validatePolicies(policy.DATA_POLICIES),[]);passed++;
const rules=fs.readFileSync(new URL('../firestore.rules',import.meta.url),'utf8').replace(/\r\n/g,'\n');
for(const path of paths){assert.ok(rules.includes('match /'+path+' {\n      allow read, write: if false;'));passed++;}
const plan=buildPlan({manifest:{id:'synthetic',created_at:'2026-10-02T00:00:00Z',source_project:'demo-resq',policy_digest:'synthetic'},documents:paths.map(path=>({path:path.replace(/\{[^}]+\}/g,'fixture'),sha256:'synthetic'}))},'demo-restore');
assert.equal(plan.counts.manual_required,9);passed++;
assert.equal(plan.counts.unclassified,0);passed++;
assert.deepEqual(plan.write_order,[]);passed++;
assert.deepEqual(plan.identity_group.documents,[]);passed++;
console.log(JSON.stringify({syntheticOnly:true,passed,automaticWrites:0}));
