import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessSnapshot, exportCallMetadata, globalOptionsSafe, pagedFirestore } from '../release-preflight-42h42.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const newNames = [
  'appendFaultPhotos', 'approvalMailStatus', 'getScheduleSourceRoster',
  'listOperationalVehicleStations', 'recordVehicleEquipmentEvent',
  'restoreVehicleCompartmentPhoto', 'saveVehicleCompartmentItem',
  'saveVehicleCompartmentPhoto', 'transitionVehicleEquipmentEvent'
];
const existingNames = [
  'activateScheduleMonthAuthority', 'approveRegistration',
  'previewScheduleSource', 'recordMetrics', 'reportIncident',
  'resumeIdentityOperation', 'saveScheduleSource'
];
const targets = [...newNames, ...existingNames];
const approvedBatches = [
  ['appendFaultPhotos', 'listOperationalVehicleStations', 'recordVehicleEquipmentEvent',
    'transitionVehicleEquipmentEvent', 'saveVehicleCompartmentItem',
    'saveVehicleCompartmentPhoto', 'restoreVehicleCompartmentPhoto'],
  ['getScheduleSourceRoster', 'previewScheduleSource', 'saveScheduleSource',
    'activateScheduleMonthAuthority'],
  ['approvalMailStatus', 'approveRegistration', 'resumeIdentityOperation'],
  ['reportIncident', 'recordMetrics']
];
const functions = Array.from({ length:208 }, (_, index) => ({
  id:existingNames[index] || `existing${index}`,
  state:'ACTIVE', region:'europe-west1', trigger:'http',
  run_revision:`revision${index}`, latest_ready_revision:`revision${index}`,
  traffic_percent:100, generation:'1', observed_generation:'1',
  terminal_state:'CONDITION_SUCCEEDED', revision_ready:true, reconciling:false
}));
const oldIndexes = [{ collectionGroup:'faults', queryScope:'COLLECTION',
  state:'READY', fields:[{ fieldPath:'status', order:'ASCENDING' }] }];
const newIndex = { collectionGroup:'faults', queryScope:'COLLECTION',
  fields:[{ fieldPath:'vehicle_id', order:'ASCENDING' },
    { fieldPath:'created_key', order:'DESCENDING' }] };
const oldField = { collectionGroup:'audit', fieldPath:'expires_at', ttl:true, ttl_state:'ACTIVE' };
const addedField = { collectionGroup:'photos', fieldPath:'data', ttl:false };
const fieldAdds = [addedField,
  { collectionGroup:'blobs', fieldPath:'data', ttl:false },
  { collectionGroup:'fault_photo_quotas', fieldPath:'expires_at', ttl:false },
  { collectionGroup:'vehicle_event_quotas', fieldPath:'expires_at', ttl:false }];
const sha = 'a'.repeat(40), tree = 'b'.repeat(40);

function fixtures() {
  return structuredClone({
    candidate: { sha, tree, version:'42H.42',
      global_options_safe:true,
      rules_sha256:'1da8063c8e93a2c7374e7e88fed2220c03b9fc8a5c1fccc0c587bb8497db52e7',
      exports:[...functions.map(fn => fn.id), ...newNames],
      targets, batches:approvedBatches,
      export_kinds:Object.fromEntries(targets.map(id => [id, 'onCall'])),
      export_options_literal:Object.fromEntries(targets.map(id => [id, true])),
      export_region_safe:Object.fromEntries(targets.map(id => [id, true])),
      export_options_unchanged:Object.fromEntries(targets.map(id => [id, true])),
      indexes:[...oldIndexes, newIndex], field_overrides:[oldField, ...fieldAdds] },
    snapshot: { schema:1, project:'station-102', captured_at:new Date().toISOString(),
      candidate_sha:sha, candidate_tree:tree,
      live: { hosting:{ version_name:'projects/station-102/sites/station-102/versions/e3441d60ea17af77',
          version_id:'e3441d60ea17af77', status:'FINALIZED', public_version:'42H.39' },
        pages:{ sha:'2a5fb043c91b040051e08bfec472f1feecf5571c',
          ref:'refs/heads/codex/pages-public-42h7' },
        rules:{ ruleset_name:'projects/station-102/rulesets/r1',
          sha256:'611226c86fe5dbb1d33bc1e48b0f716679f813499fc5c5dc6cd441ddeffa1c0b' },
        unreachable_regions:[], functions, indexes:oldIndexes, field_overrides:[oldField] }
    }
  });
}

let passed = 0;
function check(name, mutate, expected) {
  const { candidate, snapshot } = fixtures();
  mutate(candidate, snapshot);
  const result = assessSnapshot(snapshot, candidate);
  assert.equal(result.ok, !expected, name);
  if (expected) assert(result.errors.some(error => error.startsWith(expected)), `${name}: ${result.errors}`);
  passed++;
}

check('valid additive plan', () => {}, null);
check('wrong target project', (_, snapshot) => { snapshot.project = 'other'; }, 'snapshot_project_or_schema');
check('candidate Rules changed', candidate => { candidate.rules_sha256 = 'e'.repeat(64); }, 'candidate_rules_changed');
check('unsafe global options', candidate => { candidate.global_options_safe = false; }, 'candidate_global_options_changed');
check('stale snapshot', (_, snapshot) => { snapshot.captured_at = '2020-01-01T00:00:00Z'; }, 'snapshot_stale');
check('SHA drift', (_, snapshot) => { snapshot.candidate_sha = 'c'.repeat(40); }, 'snapshot_candidate_mismatch');
check('Rules drift', (_, snapshot) => { snapshot.live.rules.sha256 = 'd'.repeat(64); }, 'rules_baseline_drift');
check('Hosting missing', (_, snapshot) => { snapshot.live.hosting.status = 'CREATED'; }, 'hosting_baseline_missing');
check('Pages missing', (_, snapshot) => { snapshot.live.pages.sha = ''; }, 'pages_baseline_missing');
check('new function omitted from targets', candidate => {
  candidate.targets = candidate.targets.filter(id => id !== newNames[0]);
  candidate.batches = candidate.batches.map(batch => batch.filter(id => id !== newNames[0]));
}, 'new_function_target_omitted');
check('batch too broad', candidate => {
  candidate.targets.push('existing2');
  candidate.batches = [candidate.targets];
}, 'invalid_function_batches');
check('batches reshuffled', candidate => {
  candidate.batches = [candidate.batches.flat().slice(0, 8), candidate.batches.flat().slice(8)];
}, 'unapproved_function_batch_order');
check('existing function removed from source', candidate => {
  candidate.exports = candidate.exports.filter(id => id !== 'existing11');
}, 'candidate_removes_live_function');
check('old revision unavailable', (_, snapshot) => {
  snapshot.live.functions[0] = { ...snapshot.live.functions[0], latest_ready_revision:'another' };
}, 'function_baseline_unready');
check('event trigger needs separate rollback', (_, snapshot) => {
  snapshot.live.functions[0] = { ...snapshot.live.functions[0], trigger:'google.cloud.firestore.document.v1.written' };
}, 'trigger_requires_separate_rollback');
check('existing index removal', candidate => { candidate.indexes = [newIndex]; }, 'index_removal_detected');
check('unreviewed new index', candidate => {
  candidate.indexes.push({ collectionGroup:'users', queryScope:'COLLECTION',
    fields:[{ fieldPath:'email', order:'ASCENDING' }] });
}, 'unexpected_index_delta');
check('active TTL removal', candidate => { candidate.field_overrides[0] = { ...oldField, ttl:false }; }, 'ttl_changed');
check('existing field index changes', candidate => {
  candidate.field_overrides[0] = { ...oldField, indexes:[{ order:'ASCENDING', queryScope:'COLLECTION' }] };
}, 'field_index_changed');
check('unreachable region', (_, snapshot) => { snapshot.live.unreachable_regions = ['asia-east1']; }, 'unreachable_function_regions');
check('unapproved old function', candidate => {
  candidate.targets.push('existing11');
  candidate.batches.push(['existing11']);
}, 'unapproved_function_targets');
check('candidate changes trigger', candidate => {
  candidate.export_kinds.approveRegistration = 'onSchedule';
}, 'candidate_trigger_or_options_changed');
check('new function changes region', candidate => {
  candidate.export_region_safe.appendFaultPhotos = false;
}, 'candidate_trigger_or_options_changed');
check('candidate changes callable options', candidate => {
  candidate.export_options_unchanged.approveRegistration = false;
}, 'candidate_trigger_or_options_changed');
check('dynamic callable options', candidate => {
  candidate.export_options_literal.approveRegistration = false;
}, 'candidate_trigger_or_options_changed');
check('failed service rollout', (_, snapshot) => {
  snapshot.live.functions[0] = { ...snapshot.live.functions[0], terminal_state:'CONDITION_FAILED' };
}, 'function_baseline_unready');
check('duplicate function ID in second region', (_, snapshot) => {
  snapshot.live.functions[9] = { ...snapshot.live.functions[9], id:existingNames[0], region:'us-central1' };
}, 'live_function_inventory_incomplete');
check('unexpected new TTL', candidate => {
  candidate.field_overrides[1] = { ...candidate.field_overrides[1], ttl:true };
}, 'unexpected_field_override_delta');
check('live index building', (_, snapshot) => {
  snapshot.live.indexes[0].state = 'CREATING';
}, 'live_index_not_ready');
check('live TTL not active', (_, snapshot) => {
  snapshot.live.field_overrides[0].ttl_state = 'CREATING';
}, 'live_ttl_not_active');
check('non-target function deploying', (_, snapshot) => {
  snapshot.live.functions[25].state = 'DEPLOYING';
}, 'live_function_rollout_unready');
check('non-target function traffic split', (_, snapshot) => {
  snapshot.live.functions[25].traffic_percent = 50;
}, 'live_function_rollout_unready');

// The CLI has no execute mode; an accidental execute flag must fail before
// acquiring Firebase auth or spawning a production command.
const node = process.execPath;
assert.throws(() => execFileSync(node, [path.join(root, 'release-preflight-42h42.mjs'), '--execute'],
  { cwd:root, stdio:'pipe' }));
passed++;
const currentSource = fs.readFileSync(path.join(root, 'functions', 'index.js'), 'utf8');
const oldSource = execFileSync('git', ['show', '0f75d45:functions/index.js'],
  { cwd:root, encoding:'utf8' });
const currentMeta = exportCallMetadata(currentSource);
const oldMeta = exportCallMetadata(oldSource);
const spoofed = exportCallMetadata('// exports.removed = onCall({region:"europe-west1"}, fn);\n'
  + 'exports.retained = onCall({region:"europe-west1"}, fn);');
assert.deepEqual(Object.keys(spoofed), ['retained'], 'comment must not mask removed live export');
assert.equal(globalOptionsSafe(currentSource), true);
assert.equal(globalOptionsSafe(oldSource), true);
for (const input of [
  "setGlobalOptions({ region:['europe-west1','us-central1'], maxInstances:10 });",
  "setGlobalOptions({ region:'europe-west1b', maxInstances:10 });",
  "setGlobalOptions({ region:'europe-west1', maxInstances:100 });",
  "setGlobalOptions({ region:process.env.REGION, maxInstances:10 });"
]) assert.equal(globalOptionsSafe(input), false);
for (const id of targets) {
  assert.equal(currentMeta[id]?.kind, 'onCall', `${id} must remain callable`);
  assert(!/region\s*:\s*['"](?!europe-west1)/.test(currentMeta[id].options), `${id} moved region`);
  if (oldMeta[id]) assert.equal(currentMeta[id].options, oldMeta[id].options, `${id} changed options`);
  passed++;
}
const fieldQueries = [];
const fieldsApi = { apiClient:{ async get(_endpoint, { queryParams }) {
  fieldQueries.push(queryParams);
  return { status:200, body:fieldQueries.length === 1
    ? { fields:[{ name:'first' }], nextPageToken:'next' }
    : { fields:[{ name:'second' }] } };
} } };
assert.equal((await pagedFirestore(fieldsApi, '/fields', 'fields',
  { filter:'indexConfig.usesAncestorConfig=false OR ttlConfig:*', pageSize:0 })).length, 2);
assert.equal(fieldQueries[0].pageSize, 0);
assert.equal(fieldQueries[1].pageToken, 'next');
assert.equal(fieldQueries[1].filter, 'indexConfig.usesAncestorConfig=false OR ttlConfig:*');
passed++;
const indexQueries = [];
const indexRows = await pagedFirestore({ apiClient:{ async get(_endpoint, { queryParams }) {
  indexQueries.push(queryParams); return { status:200, body:indexQueries.length === 1
    ? { indexes:[{ name:'first' }], nextPageToken:'next' }
    : { indexes:[{ name:'second' }] } };
} } }, '/indexes', 'indexes', { pageSize:0 });
assert.equal(indexQueries[0].pageSize, 0);
assert.equal(indexQueries[1].pageToken, 'next');
assert.equal(indexRows.length, 2);
passed++;
await assert.rejects(pagedFirestore({ apiClient:{ async get() {
  return { status:400, body:{} };
} } }, '/fields', 'fields', { pageSize:0 }), /list failed/);
passed++;
await assert.rejects(pagedFirestore({ apiClient:{ async get() {
  return { status:200, body:{ fields:[], nextPageToken:'again' } };
} } }, '/fields', 'fields', { pageSize:0 }), /pagination loop/);
passed++;
console.log(`release preflight 42H.42: ${passed}/${passed} passed`);
