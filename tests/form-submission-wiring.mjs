import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const actual = Object.freeze({
  index: read('functions/index.js'),
  rules: read('firestore.rules'),
  backup: read('functions/backup-policy.js'),
  forms: read('forms.html')
});

function exactly(source, regex, label) {
  const matches = [...source.matchAll(regex)];
  assert.equal(matches.length, 1, label + ' must occur exactly once');
  return matches[0][0];
}

function between(source, start, end, label) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, label + ' boundaries are missing');
  return source.slice(from, to);
}

function validate(sources) {
  const { index, rules, backup, forms } = sources;

  exactly(index,
    /^const formSubmissionsModule = require\((['"])\.\/form-submissions\1\);$/gm,
    'form submission service require');
  exactly(index,
    /const formSubmissions = formSubmissionsModule\.createFormSubmissions\(\{\s*db,\s*auth\s*:\s*admin\.auth\(\),\s*HttpsError,\s*serverTimestamp\s*:\s*\(\)\s*=>\s*FV\.serverTimestamp\(\),\s*clock\s*:\s*\(\)\s*=>\s*Date\.now\(\)\s*\}\);/g,
    'form submission service instantiation');

  const options = exactly(index,
    /const FORM_SUBMISSION_OPTIONS = Object\.freeze\(\{[\s\S]*?\}\);/g,
    'form submission callable options');
  assert.match(options, /\benforceAppCheck\s*:\s*true\b/,
    'form submission callables must enforce App Check');
  assert.doesNotMatch(options, /\benforceAppCheck\s*:\s*false\b/);

  const submitExport = exactly(index,
    /exports\.submitStationForm = onCall\(FORM_SUBMISSION_OPTIONS,\s*\n?\s*req\s*=>\s*formSubmissions\.submit\(req\)\);/g,
    'submitStationForm export');
  const statusExport = exactly(index,
    /exports\.getStationFormSubmissionStatus = onCall\(FORM_SUBMISSION_OPTIONS,\s*\n?\s*req\s*=>\s*formSubmissions\.status\(req\)\);/g,
    'getStationFormSubmissionStatus export');
  assert.ok(submitExport && statusExport);
  assert.equal((index.match(/exports\.(?:submitStationForm|getStationFormSubmissionStatus)\s*=/g) || []).length, 2,
    'exactly two form submission callable exports are required');

  const submissionRules = between(rules,
    'match /submissions/{subId} {',
    'match /form_submission_operations/{operationId} {',
    'submission rules');
  assert.match(submissionRules, /allow create\s*:\s*if false\s*;/,
    'browser must not create submissions directly');
  assert.match(submissionRules,
    /request\.resource\.data\.get\('request_id', ''\)\s*==\s*resource\.data\.get\('request_id', ''\)/,
    'request_id must remain immutable during approval updates');
  assert.match(submissionRules,
    /request\.resource\.data\.get\('request_fingerprint', ''\)\s*==\s*resource\.data\.get\('request_fingerprint', ''\)/,
    'request_fingerprint must remain immutable during approval updates');
  for (const [field, fallback] of [
    ['form_he', "''"], ['kind', "''"], ['is_private', 'false'],
    ['created_key', "''"], ['created_at', 'null']
  ]) {
    const escapedFallback = fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(submissionRules, new RegExp(
      `request\\.resource\\.data\\.get\\('${field}', ${escapedFallback}\\)\\s*==\\s*resource\\.data\\.get\\('${field}', ${escapedFallback}\\)`
    ), field + ' must remain immutable during approval updates');
  }

  // A super claim may lack the station role/employee claims used by ordinary
  // approvers, but it never permits signing with somebody else's uid. Keep
  // the uid equality outside the super exception for both approval stages.
  for (const stage of ['commander', 'station_commander']) {
    const prefix = `request\\.resource\\.data\\.get\\('signatures', \\{\\}\\)\\s*`
      + `\\.get\\('${stage}', \\{\\}\\)`;
    assert.match(submissionRules, new RegExp(
      prefix + `\\.get\\('uid', ''\\)\\s*==\\s*request\\.auth\\.uid\\s*`
      + `&&\\s*\\(isSuper\\(\\)\\s*\\|\\|\\s*\\(`
      + prefix + `\\.get\\('role', ''\\)\\s*==\\s*claim\\('role'\\)\\s*`
      + `&&\\s*` + prefix + `\\.get\\('emp', ''\\)\\s*==\\s*myEmp\\(\\)\\)\\)`
    ), stage + ' signature identity must bind uid, role and employee claim');
  }

  const receiptRules = between(rules,
    'match /form_submission_operations/{operationId} {',
    '// ---------- היתר לרדת מתחת לקו האדום ----------',
    'form submission receipt rules');
  assert.match(receiptRules, /allow read, write\s*:\s*if false\s*;/,
    'private idempotency receipts must be server-only');

  const backupOperation = exactly(backup,
    /policy\('stations\/\{sid\}\/form_submission_operations\/\{operationId\}'[\s\S]*?\n\s*\{ consistencyGroup:'form_submission', humanReadable:'forbidden' \}\),/g,
    'form submission operation backup policy');
  assert.match(backupOperation, /'source_of_truth'/);
  assert.match(backupOperation, /'integrity_group'/);
  assert.match(backupOperation, /'restore_after_parent'/);
  assert.match(backupOperation, /'same_retention_as_submission'/);

  exactly(forms,
    /const submitStationForm = httpsCallable\(functions, 'submitStationForm'\);/g,
    'submit callable client binding');
  exactly(forms,
    /const getStationFormSubmissionStatus = httpsCallable\(functions, 'getStationFormSubmissionStatus'\);/g,
    'status callable client binding');
  const submitFlow = between(forms, 'async function submitForm(){', '// ---------- כרטיס ----------', 'form submission flow');
  assert.match(submitFlow, /await submitStationForm\(submissionIntent\)\s*;/,
    'submission must use the server callable');
  assert.match(submitFlow,
    /await getStationFormSubmissionStatus\(\{\s*request_id\s*:\s*submissionIntent\.request_id\s*\}\)/,
    'ambiguous responses must use the receipt-status callable');
  assert.doesNotMatch(submitFlow, /\b(?:addDoc|setDoc)\s*\(/,
    'submission flow must not write Firestore directly');
}

validate(actual);

function mutate(name, key, before, after) {
  const changed = actual[key].replace(before, after);
  assert.notEqual(changed, actual[key], name + ' mutation did not apply');
  assert.throws(() => validate({ ...actual, [key]: changed }), name + ' mutation survived');
}

const mutations = [
  ['remove service require', 'index', "const formSubmissionsModule = require('./form-submissions');", ''],
  ['disable App Check', 'index', 'enforceAppCheck:true, timeoutSeconds:60', 'enforceAppCheck:false, timeoutSeconds:60'],
  ['bypass submit service', 'index', 'formSubmissions.submit(req)', 'formSubmissions.status(req)'],
  ['bypass status service', 'index', 'formSubmissions.status(req)', 'formSubmissions.submit(req)'],
  ['allow direct create', 'rules', 'allow create: if false;', 'allow create: if member(sid);'],
  ['unlock request id', 'rules',
    "&& request.resource.data.get('request_id', '') == resource.data.get('request_id', '')", ''],
  ['unlock request fingerprint', 'rules',
    "&& request.resource.data.get('request_fingerprint', '') == resource.data.get('request_fingerprint', '')", ''],
  ['unlock form label', 'rules',
    "&& request.resource.data.get('form_he', '') == resource.data.get('form_he', '')", ''],
  ['unlock form kind', 'rules',
    "&& request.resource.data.get('kind', '') == resource.data.get('kind', '')", ''],
  ['unlock privacy classification', 'rules',
    "&& request.resource.data.get('is_private', false) == resource.data.get('is_private', false)", ''],
  ['unlock created key', 'rules',
    "&& request.resource.data.get('created_key', '') == resource.data.get('created_key', '')", ''],
  ['unlock created timestamp', 'rules',
    "&& request.resource.data.get('created_at', null) == resource.data.get('created_at', null)", ''],
  ['unbind commander uid', 'rules',
    ".get('commander', {}).get('uid', '') == request.auth.uid",
    ".get('commander', {}).get('uid', '') != ''"],
  ['unbind commander role', 'rules',
    ".get('commander', {}).get('role', '') == claim('role')",
    ".get('commander', {}).get('role', '') != ''"],
  ['unbind commander employee', 'rules',
    ".get('commander', {}).get('emp', '') == myEmp()",
    ".get('commander', {}).get('emp', '') != ''"],
  ['unbind station commander uid', 'rules',
    ".get('station_commander', {}).get('uid', '') == request.auth.uid",
    ".get('station_commander', {}).get('uid', '') != ''"],
  ['unbind station commander role', 'rules',
    ".get('station_commander', {}).get('role', '') == claim('role')",
    ".get('station_commander', {}).get('role', '') != ''"],
  ['unbind station commander employee', 'rules',
    ".get('station_commander', {}).get('emp', '') == myEmp()",
    ".get('station_commander', {}).get('emp', '') != ''"],
  ['expose operation receipts', 'rules', 'allow read, write: if false;\n      }\n\n\n      // ---------- היתר לרדת מתחת לקו האדום ----------',
    'allow read: if member(sid);\n        allow write: if false;\n      }\n\n\n      // ---------- היתר לרדת מתחת לקו האדום ----------'],
  ['drop operation backup policy', 'backup',
    "policy('stations/{sid}/form_submission_operations/{operationId}'",
    "policy('stations/{sid}/removed_form_submission_operations/{operationId}'"],
  ['replace callable submission with direct write', 'forms',
    'await submitStationForm(submissionIntent);',
    "await addDoc(collection(db, 'stations', SID, 'submissions'), submissionIntent);"],
  ['drop receipt status lookup', 'forms',
    'await getStationFormSubmissionStatus({ request_id:submissionIntent.request_id })',
    'await Promise.resolve({ data:{ status:\'unknown\' } })']
];

for (const args of mutations) mutate(...args);

console.log('form-submission-wiring: PASS; 22/22 focused mutations caught');
