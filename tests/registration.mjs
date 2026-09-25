import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'login.html'), 'utf8');
const rules = fs.readFileSync(path.join(here, '..', 'firestore.rules'), 'utf8');
const identity = fs.readFileSync(path.join(here, '..', 'functions', 'identity-coordinator.js'), 'utf8');

let passed = 0;
function ok(name, value) {
  if (!value) throw new Error('FAIL: ' + name);
  passed++;
  console.log('✓ ' + name);
}

const flowMatch = html.match(
  /async function submitFirst\(\) \{([\s\S]*?)\/\/ ---------- ניתוב ----------/
);
ok('registration handler is present', !!flowMatch);
const flow = flowMatch ? flowMatch[1] : '';
const writePos = flow.indexOf('await batch.commit()');

ok('re-submit control exists', /id="btnResubmit"/.test(html));
ok('re-submit has an explicit recovery control', /id="btnResubmitCancel"/.test(html));
ok('re-submit keeps the existing signed-in user',
   /resubmitUser\.uid === auth\.currentUser\.uid/.test(flow));
ok('server identity is checked before a re-submit',
   flow.indexOf('await callWho({})') !== -1 &&
   flow.indexOf('await callWho({})') < writePos);
ok('server uid must match the signed-in uid',
   /live\.uid !== applicant\.uid/.test(flow));
ok('a live server assignment prevents a request write',
   /hasServerAssignment\(serverClaims\)/.test(flow));
ok('only a complete live assignment is treated as approved',
   /hasCompleteServerAssignment\(serverClaims\)/.test(flow));
ok('a partial live assignment fails closed without a reload loop',
   /showAssignmentRecovery\(applicant\)/.test(flow));
ok('an existing pending request is not overwritten',
   /const pending = await getDoc[\s\S]*?if \(pending\.exists\(\)\)[\s\S]*?return;/.test(flow));
ok('only a newly-created Auth account is marked for cleanup',
   /createdNow = true/.test(flow) &&
   /if \(createdNow && applicant && absenceConfirmed\)/.test(flow));
ok('an existing Auth account is never deleted on write failure',
   !/if \(applicant\)[^{]*\{[^}]*deleteUser/.test(flow));
ok('write failure is verified before any Auth cleanup',
   flow.indexOf('const verification = await getDocFromServer(requestRef)') !== -1 &&
   flow.indexOf('const verification = await getDocFromServer(requestRef)') <
     flow.indexOf('await deleteUser(applicant)'));
ok('uncertain write result preserves the Auth account',
   /else if \(!absenceConfirmed\)[\s\S]*?showRegistrationRecovery\(applicant\)/.test(flow));
ok('double-click protection disables the submit button',
   flow.indexOf('btn.disabled = true') < writePos);
ok('registration offers one terms action and does not record marketing consent',
   /id="btnFirst"[^>]*>שלח בקשה ואשר תקנון/.test(html) &&
   !/id="btnFirstMarketing"/.test(html) &&
   /\$\('btnFirst'\)\.onclick = submitFirst/.test(flow) &&
   /marketing_opt_in: false/.test(flow));
ok('operator contact and full terms are available before submission',
   /אלדד יונה/.test(html) && /fire102\.shits@gmail\.com/.test(html) &&
   /href="\.\/terms\.html"/.test(html));
ok('rules require the same versioned legal choice on a new request',
   /legal_consent\.terms_version == '1\.3'/.test(rules) &&
   /legal_consent\.privacy_version == '2026-09-24'/.test(rules) &&
   /legal_consent\.marketing_opt_in is bool/.test(rules));
ok('registration receipt is atomically committed and approval retains consent metadata',
   /batch\.set\(doc\(db, 'registration_consents'/.test(flow) &&
   /await batch\.commit\(\)/.test(flow) &&
   /registration_consent: consentReceipt \?/.test(identity) &&
   /registration_terms_active\/' \+ params\.uid/.test(identity));
ok('existing-email guidance returns the user to normal login',
   /email-already-in-use[\s\S]*?היכנס עם המייל והסיסמה/.test(flow));
ok('station-code entry is absent while server join is disabled',
   !/id="fCode"/.test(html) && !/joinWithCode/.test(flow));
ok('initial routing rejects every incomplete nonempty assignment',
   /hasServerAssignment\(claims\) && !hasCompleteServerAssignment\(claims\)/.test(html));

const policyMatch = html.match(
  /function hasServerAssignment\(claims\)\{([\s\S]*?)\n\}/
);
ok('server-assignment policy is present', !!policyMatch);
const hasAssignment = new Function('claims', policyMatch ? policyMatch[1] : 'return true;');
ok('empty server claims may re-submit', hasAssignment({}) === false);
ok('employee claim blocks re-submit', hasAssignment({ emp:'17' }) === true);
ok('role claim blocks re-submit', hasAssignment({ role:'firefighter' }) === true);
ok('station claim blocks re-submit', hasAssignment({ stationId:'eilat_102' }) === true);
ok('district claim blocks re-submit', hasAssignment({ districtId:'south' }) === true);
ok('shift claim blocks re-submit', hasAssignment({ shift:'A' }) === true);
ok('super claim blocks re-submit', hasAssignment({ super:true }) === true);

const completeMatch = html.match(
  /function hasCompleteServerAssignment\(claims\)\{([\s\S]*?)\n\}/
);
ok('complete-assignment policy is present', !!completeMatch);
const hasComplete = new Function('claims', 'VALID_ROLES',
  completeMatch ? completeMatch[1] : 'return true;');
const roles = ['firefighter', 'commander'];
ok('employee number alone is not a complete assignment',
   hasComplete({ emp:'17' }, roles) === false);
ok('employee, valid role and station are a complete assignment',
   hasComplete({ emp:'17', role:'firefighter', stationId:'eilat_102' }, roles) === true);
ok('complete assignment does not require a shift',
   hasComplete({ emp:'17', role:'commander', stationId:'eilat_102', shift:'' }, roles) === true);
ok('unknown role is not a complete assignment',
   hasComplete({ emp:'17', role:'unknown', stationId:'eilat_102' }, roles) === false);
ok('verified super is a complete assignment without employee number',
   hasComplete({ super:true }, roles) === true);

console.log('Registration lifecycle checks passed: ' + passed);
