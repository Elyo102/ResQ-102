/**
 * Read-only 42H.42 release inventory. This file has no deploy mode.
 * It never stores service configuration, tokens, source data or Rules contents.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = 'station-102';
const PAGES_REMOTE = 'https://github.com/Elyo102/ResQ-102.git';
const PAGES_REF = 'refs/heads/codex/pages-public-42h7';
const BASE_RULES_SHA256 = '611226c86fe5dbb1d33bc1e48b0f716679f813499fc5c5dc6cd441ddeffa1c0b';
const CANDIDATE_RULES_SHA256 = '1da8063c8e93a2c7374e7e88fed2220c03b9fc8a5c1fccc0c587bb8497db52e7';
const BASE_HOSTING_VERSION = 'e3441d60ea17af77';
const BASE_PAGES_SHA = '2a5fb043c91b040051e08bfec472f1feecf5571c';
const EXPECTED_NEW = Object.freeze([
  'appendFaultPhotos', 'approvalMailStatus', 'getScheduleSourceRoster',
  'listOperationalVehicleStations', 'recordVehicleEquipmentEvent',
  'restoreVehicleCompartmentPhoto', 'saveVehicleCompartmentItem',
  'saveVehicleCompartmentPhoto', 'transitionVehicleEquipmentEvent'
].sort());
const APPROVED_TARGETS = Object.freeze([
  ...EXPECTED_NEW, 'activateScheduleMonthAuthority', 'approveRegistration',
  'previewScheduleSource', 'recordMetrics', 'reportIncident',
  'resumeIdentityOperation', 'saveScheduleSource'
].sort());
const APPROVED_BATCHES = Object.freeze([
  ['appendFaultPhotos', 'listOperationalVehicleStations', 'recordVehicleEquipmentEvent',
    'transitionVehicleEquipmentEvent', 'saveVehicleCompartmentItem',
    'saveVehicleCompartmentPhoto', 'restoreVehicleCompartmentPhoto'],
  ['getScheduleSourceRoster', 'previewScheduleSource', 'saveScheduleSource',
    'activateScheduleMonthAuthority'],
  ['approvalMailStatus', 'approveRegistration', 'resumeIdentityOperation'],
  ['reportIncident', 'recordMetrics']
]);
const EXPECTED_FIELD_ADDS = Object.freeze([
  'blobs|data', 'fault_photo_quotas|expires_at',
  'photos|data', 'vehicle_event_quotas|expires_at'
].sort());
const NEW_OPTION_HASHES = Object.freeze({
  appendFaultPhotos:'10ef8091a543492c65fc995d9c3d532021be0cbbf98e12a3d295d7b4e57e1dd8',
  approvalMailStatus:'aa489c93090508ef589c61b7b50c02ed1ea6df2cb6f6c8be45da774c052509fe',
  getScheduleSourceRoster:'e1ffc7ea57bc141e6514f16b0cf04785d660beb887646467041ae0933a1a5eb2',
  listOperationalVehicleStations:'c90c9177aec48fd05029166dbea8a810a167b3b21a399475514f6ea609b63d9a',
  recordVehicleEquipmentEvent:'c90c9177aec48fd05029166dbea8a810a167b3b21a399475514f6ea609b63d9a',
  restoreVehicleCompartmentPhoto:'781ce0a4a14a5364f34e22c6a57c39afcd830113b49a2f6fe3c10394cbe655e2',
  saveVehicleCompartmentItem:'c90c9177aec48fd05029166dbea8a810a167b3b21a399475514f6ea609b63d9a',
  saveVehicleCompartmentPhoto:'781ce0a4a14a5364f34e22c6a57c39afcd830113b49a2f6fe3c10394cbe655e2',
  transitionVehicleEquipmentEvent:'c90c9177aec48fd05029166dbea8a810a167b3b21a399475514f6ea609b63d9a'
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const normalizeRules = value => value.replace(/\r\n/g, '\n').trimEnd();
const toId = name => String(name || '').split('/').at(-1);

function git(args) {
  // Local worktrees can be owned by the sandbox account while the Firebase
  // credential belongs to the interactive Windows account. Do not change
  // global Git configuration to bridge that read-only ownership difference.
  return execFileSync('git', ['-c', `safe.directory=${ROOT.replace(/\\/g, '/')}`, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true
  }).trim();
}

export function exportCallMetadata(source) {
  const require = createRequire(path.join(ROOT, 'tests', 'package.json'));
  const acorn = require('acorn');
  const ast = acorn.parse(source, { ecmaVersion:'latest', sourceType:'script' });
  const result = {};
  for (const statement of ast.body) {
    const assignment = statement.type === 'ExpressionStatement' ? statement.expression : null;
    const left = assignment?.left, call = assignment?.right;
    if (assignment?.type !== 'AssignmentExpression' || left?.type !== 'MemberExpression' ||
        left.object?.name !== 'exports' || left.property?.type !== 'Identifier' ||
        call?.type !== 'CallExpression' || call.callee?.type !== 'Identifier') continue;
    const optionsNode = call.arguments[0];
    const properties = optionsNode?.type === 'ObjectExpression' ? optionsNode.properties : [];
    const region = properties.find(property => property.type === 'Property' &&
      !property.computed && (property.key.name || property.key.value) === 'region');
    if (Object.hasOwn(result, left.property.name)) throw new Error(`duplicate export assignment: ${left.property.name}`);
    result[left.property.name] = { kind:call.callee.name,
      options:optionsNode ? source.slice(optionsNode.start, optionsNode.end) : '',
      options_literal:optionsNode?.type === 'ObjectExpression' &&
        properties.every(property => property.type === 'Property' && !property.computed),
      region_safe:!region || (region.value.type === 'Literal' && region.value.value === 'europe-west1') };
  }
  return result;
}

export function globalOptionsSafe(source) {
  const require = createRequire(path.join(ROOT, 'tests', 'package.json'));
  const ast = require('acorn').parse(source, { ecmaVersion:'latest', sourceType:'script' });
  const calls = ast.body.filter(statement => statement.type === 'ExpressionStatement' &&
    statement.expression.type === 'CallExpression' &&
    statement.expression.callee.name === 'setGlobalOptions');
  if (calls.length !== 1) return false;
  const argument = calls[0].expression.arguments[0];
  if (argument?.type !== 'ObjectExpression' || argument.properties.length !== 2) return false;
  const values = Object.fromEntries(argument.properties.map(property => [
    property.type === 'Property' && !property.computed ? property.key.name || property.key.value : '',
    property.value?.type === 'Literal' ? property.value.value : null
  ]));
  return values.region === 'europe-west1' && values.maxInstances === 10;
}

function indexKey(index) {
  const group = index.collectionGroup || String(index.name || '').match(/collectionGroups\/([^/]+)/)?.[1];
  return `${group}|${index.queryScope}|${(index.fields || [])
    .filter(field => field.fieldPath !== '__name__')
    .map(field => `${field.fieldPath}:${field.order || field.arrayConfig || JSON.stringify(field.vectorConfig || '')}`)
    .join(',')}|${index.apiScope || ''}|${index.density || 'SPARSE_ALL'}|${index.multikey || false}|${index.unique || false}`;
}

function fieldKey(field) {
  const group = field.collectionGroup || String(field.name || '').match(/collectionGroups\/([^/]+)/)?.[1];
  const name = field.fieldPath || String(field.name || '').split('/fields/')[1];
  return `${group}|${name}`;
}

function fieldIndexModes(field) {
  return (field.indexes || []).map(index =>
    `${index.queryScope}:${index.order || index.arrayConfig || ''}|${index.apiScope || ''}|${index.density || 'SPARSE_ALL'}|${index.multikey || false}|${index.unique || false}`).sort();
}

export function assessSnapshot(snapshot, candidate) {
  const errors = [];
  const expected = candidate.targets;
  const live = snapshot.live || {};
  if (snapshot.schema !== 1 || snapshot.project !== PROJECT) errors.push('snapshot_project_or_schema');
  if (snapshot.candidate_sha !== candidate.sha || snapshot.candidate_tree !== candidate.tree) errors.push('snapshot_candidate_mismatch');
  const age = Date.now() - Date.parse(snapshot.captured_at || '');
  if (!Number.isFinite(age) || age < -60000 || age > 10 * 60000) errors.push('snapshot_stale');
  if (!/^[0-9a-f]{40}$/.test(candidate.sha) || !/^[0-9a-f]{40}$/.test(candidate.tree)) errors.push('invalid_git_identity');
  if (candidate.version !== '42H.42') errors.push('wrong_release_version');
  if (candidate.global_options_safe !== true) errors.push('candidate_global_options_changed');
  if (candidate.rules_sha256 !== CANDIDATE_RULES_SHA256) errors.push('candidate_rules_changed');
  if (!Array.isArray(expected) || expected.length === 0 || new Set(expected).size !== expected.length ||
      expected.some(id => !/^[A-Za-z][A-Za-z0-9]*$/.test(id))) errors.push('invalid_function_targets');
  if (JSON.stringify([...(expected || [])].sort()) !== JSON.stringify(APPROVED_TARGETS)) {
    errors.push('unapproved_function_targets');
  }
  if (!Array.isArray(candidate.batches) || candidate.batches.length === 0 ||
      candidate.batches.some(batch => !Array.isArray(batch) || !batch.length || batch.length > 10) ||
      JSON.stringify(candidate.batches.flat().sort()) !== JSON.stringify([...expected].sort())) {
    errors.push('invalid_function_batches');
  }
  if (JSON.stringify(candidate.batches) !== JSON.stringify(APPROVED_BATCHES)) {
    errors.push('unapproved_function_batch_order');
  }
  if (live.hosting?.version_name !== `projects/${PROJECT}/sites/${PROJECT}/versions/${BASE_HOSTING_VERSION}` ||
      live.hosting?.version_id !== BASE_HOSTING_VERSION ||
      live.hosting?.status !== 'FINALIZED' || live.hosting?.public_version !== '42H.39') {
    errors.push('hosting_baseline_missing');
  }
  if (live.pages?.sha !== BASE_PAGES_SHA || live.pages?.ref !== PAGES_REF) errors.push('pages_baseline_missing');
  if (!String(live.rules?.ruleset_name || '').startsWith(`projects/${PROJECT}/rulesets/`) ||
      live.rules?.sha256 !== BASE_RULES_SHA256) errors.push('rules_baseline_drift');
  if ((live.unreachable_regions || []).length) errors.push('unreachable_function_regions');
  const functions = new Map((live.functions || []).map(fn => [fn.id, fn]));
  if (functions.size !== 208 || functions.size !== (live.functions || []).length ||
      (live.functions || []).some(fn => fn.region !== 'europe-west1')) {
    errors.push('live_function_inventory_incomplete');
  }
  for (const fn of live.functions || []) {
    if (fn.state !== 'ACTIVE' || fn.reconciling === true || !fn.run_revision ||
        fn.traffic_percent !== 100 || fn.latest_ready_revision !== fn.run_revision ||
        fn.revision_ready !== true) errors.push(`live_function_rollout_unready:${fn.id}`);
  }
  const newNames = candidate.exports.filter(id => !functions.has(id)).sort();
  if (JSON.stringify(newNames) !== JSON.stringify(EXPECTED_NEW)) errors.push('new_function_set_mismatch');
  if ((live.functions || []).some(fn => !candidate.exports.includes(fn.id))) errors.push('candidate_removes_live_function');
  if (EXPECTED_NEW.some(id => !expected?.includes(id))) errors.push('new_function_target_omitted');
  for (const id of expected || []) {
    if (candidate.export_kinds?.[id] !== 'onCall' ||
        candidate.export_options_literal?.[id] !== true ||
        candidate.export_region_safe?.[id] !== true ||
        candidate.export_options_unchanged?.[id] !== true) errors.push(`candidate_trigger_or_options_changed:${id}`);
    const fn = functions.get(id);
    if (!fn) {
      if (!EXPECTED_NEW.includes(id)) errors.push(`unrecognized_new_function:${id}`);
      continue;
    }
    if (fn.state !== 'ACTIVE' || fn.region !== 'europe-west1' || !fn.trigger || !fn.run_revision ||
        fn.traffic_percent !== 100 || fn.latest_ready_revision !== fn.run_revision ||
        fn.reconciling === true || !fn.generation || fn.generation !== fn.observed_generation ||
        fn.terminal_state !== 'CONDITION_SUCCEEDED' || fn.revision_ready !== true) {
      errors.push(`function_baseline_unready:${id}`);
    }
    const source = fn.rollback_source;
    if (!source || !source.bucket || !source.object ||
        !/^[1-9][0-9]*$/.test(String(source.generation || '')) ||
        !/^[1-9][0-9]*$/.test(String(source.size || '')) ||
        !source.crc32c || !source.md5Hash ||
        !/^[^\s]+@sha256:[0-9a-f]{64}$/.test(String(fn.run_image || ''))) {
      errors.push(`function_rollback_artifact_unproven:${id}`);
    }
    if (fn.trigger !== 'http') errors.push(`trigger_requires_separate_rollback:${id}`);
  }
  const liveIndexKeys = new Set((live.indexes || []).map(indexKey));
  const wantedIndexKeys = new Set((candidate.indexes || []).map(indexKey));
  if ((live.indexes || []).some(index => index.state !== 'READY')) errors.push('live_index_not_ready');
  if (liveIndexKeys.size !== (live.indexes || []).length ||
      wantedIndexKeys.size !== (candidate.indexes || []).length) errors.push('duplicate_index');
  const indexAdds = [...wantedIndexKeys].filter(key => !liveIndexKeys.has(key));
  const indexRemoves = [...liveIndexKeys].filter(key => !wantedIndexKeys.has(key));
  if (indexRemoves.length) errors.push('index_removal_detected');
  if (JSON.stringify(indexAdds) !== JSON.stringify([
    'faults|COLLECTION|vehicle_id:ASCENDING,created_key:DESCENDING||SPARSE_ALL|false|false'
  ])) errors.push('unexpected_index_delta');
  const liveFields = new Map((live.field_overrides || []).map(field => [fieldKey(field), field]));
  const candidateFields = new Map((candidate.field_overrides || []).map(field => [fieldKey(field), field]));
  if (liveFields.size !== (live.field_overrides || []).length ||
      candidateFields.size !== (candidate.field_overrides || []).length) errors.push('duplicate_field_override');
  if ([...liveFields.keys()].some(key => !candidateFields.has(key))) errors.push('field_override_removal_detected');
  for (const [key, field] of liveFields) {
    const candidateTtl = candidateFields.get(key)?.ttl;
    if (candidateTtl !== undefined && typeof candidateTtl !== 'boolean') errors.push(`invalid_ttl_value:${key}`);
    if ((field.ttl === true) !== (candidateTtl === true)) errors.push(`ttl_changed:${key}`);
    if (field.ttl === true && field.ttl_state !== 'ACTIVE') errors.push(`live_ttl_not_active:${key}`);
    if ((field.indexes || []).some(index => index.state !== 'READY')) errors.push(`live_field_index_not_ready:${key}`);
    if (JSON.stringify(fieldIndexModes(field)) !== JSON.stringify(fieldIndexModes(candidateFields.get(key) || {}))) {
      errors.push(`field_index_changed:${key}`);
    }
  }
  const fieldAdds = [...candidateFields.keys()].filter(key => !liveFields.has(key)).sort();
  if (JSON.stringify(fieldAdds) !== JSON.stringify(EXPECTED_FIELD_ADDS) ||
      fieldAdds.some(key => candidateFields.get(key)?.ttl === true || fieldIndexModes(candidateFields.get(key)).length)) {
    errors.push('unexpected_field_override_delta');
  }
  return { ok: errors.length === 0, errors, index_additions: indexAdds,
    field_additions: fieldAdds,
    function_count: functions.size, target_count: (expected || []).length,
    batches: (candidate.batches || []).map(batch => batch.length) };
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--candidate', '--targets', '--output'].includes(argv[i]) || !argv[i + 1]) throw new Error('invalid arguments');
    values[argv[i]] = argv[i + 1];
  }
  if (!values['--candidate'] || !values['--targets'] || !values['--output']) throw new Error('candidate, targets and output required');
  if (!/^[0-9a-f]{40}$/.test(values['--candidate'])) throw new Error('candidate must be full SHA');
  const output = path.resolve(values['--output']);
  const tempRoot = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(output));
  if (!(parent === tempRoot || parent.startsWith(tempRoot + path.sep)) ||
      !/^resq-release-preflight-[0-9a-f]{12}\.json$/.test(path.basename(output))) {
    throw new Error('ledger output must use a dedicated file under real OS temp directory');
  }
  return { sha: values['--candidate'], targetsPath: path.resolve(values['--targets']), output };
}

function firebaseLib() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'firebase-tools', 'lib'),
    path.join(ROOT, '..', 'firebase-cli-runtime', 'node_modules', 'firebase-tools', 'lib')
  ];
  const lib = candidates.find(dir => fs.existsSync(path.join(dir, 'auth.js')));
  if (!lib) throw new Error('firebase-tools runtime unavailable');
  const version = JSON.parse(fs.readFileSync(path.join(lib, '..', 'package.json'), 'utf8')).version;
  if (version !== '15.28.1') throw new Error('firebase-tools version mismatch');
  return { require:createRequire(path.join(lib, 'auth.js')), version };
}

export async function pagedFirestore(api, endpoint, key, { filter = '', pageSize = 1000 } = {}) {
  const rows = [], tokens = new Set();
  let pageToken = '';
  do {
    if (tokens.has(pageToken)) throw new Error(`Firestore ${key} pagination loop`);
    tokens.add(pageToken);
    const queryParams = { pageSize };
    if (pageToken) queryParams.pageToken = pageToken;
    if (filter) queryParams.filter = filter;
    const response = await api.apiClient.get(endpoint, { queryParams });
    if (response.status !== 200 || !Array.isArray(response.body?.[key] || [])) {
      throw new Error(`Firestore ${key} list failed`);
    }
    rows.push(...(response.body[key] || []));
    if (rows.length > 10000) throw new Error(`Firestore ${key} inventory too large`);
    pageToken = response.body.nextPageToken || '';
  } while (pageToken);
  return rows;
}

async function captureLive(targets) {
  const runtime = firebaseLib();
  const require = runtime.require;
  const auth = require('./auth.js');
  const options = { project: PROJECT };
  auth.setActiveAccount(options, auth.getGlobalDefaultAccount());
  await require('./requireAuth.js').requireAuth(options);
  const hosting = await require('./hosting/api.js').getChannel(PROJECT, PROJECT, 'live');
  const rules = require('./gcp/rules.js');
  const release = (await rules.listAllReleases(PROJECT)).find(item => item.name === `projects/${PROJECT}/releases/cloud.firestore`);
  if (!release) throw new Error('live Firestore Rules release missing');
  const files = await rules.getRulesetContent(release.rulesetName);
  if (files.length !== 1 || files[0].name !== 'firestore.rules') throw new Error('unexpected live Rules files');
  const api = new (require('./firestore/api.js').FirestoreApi)();
  const parent = `projects/${PROJECT}/databases/(default)/collectionGroups/-`;
  const publicResponse = await fetch(`https://${PROJECT}.web.app/version.json?preflight=${Date.now()}`, {
    headers:{ 'Cache-Control':'no-cache' }, signal:AbortSignal.timeout(15000)
  });
  if (!publicResponse.ok) throw new Error('public Hosting version unavailable');
  const publicVersion = await publicResponse.json();
  const [indexes, fieldOverrides, fnResult, services] = await Promise.all([
    pagedFirestore(api, `/${parent}/indexes`, 'indexes', { pageSize:0 }),
    pagedFirestore(api, `/${parent}/fields`, 'fields', {
      filter:'indexConfig.usesAncestorConfig=false OR ttlConfig:*', pageSize:0 }),
    require('./gcp/cloudfunctionsv2.js').listAllFunctions(PROJECT),
    require('./gcp/runv2.js').listServices(PROJECT)
  ]);
  const servicesByName = new Map(services.map(service => [service.name, service]));
  const revisionClient = new (require('./apiv2.js').Client)({
    urlPrefix:require('./api.js').runOrigin(), auth:true, apiVersion:'v2'
  });
  const readyRevisions = new Map();
  // Read every active revision, not just the functions in this release. A
  // concurrent rollout elsewhere makes a full-stack cutover unsafe.
  for (let offset = 0; offset < fnResult.functions.length; offset += 8) {
    await Promise.all(fnResult.functions.slice(offset, offset + 8).map(async fn => {
    const id = toId(fn.name);
    const service = servicesByName.get(fn.serviceConfig?.service);
    const traffic = service?.trafficStatuses || [];
    const active = traffic.length === 1 && traffic[0].percent === 100 ? traffic[0].revision : null;
    if (!active) return;
    const response = await revisionClient.get(`${service.name}/revisions/${active}`);
    const ready = response.status === 200 &&
      response.body?.name === `${service.name}/revisions/${active}` &&
      response.body?.conditions?.some(condition =>
        condition.type === 'Ready' && condition.state === 'CONDITION_SUCCEEDED');
    readyRevisions.set(id, { ready, image:response.body?.containers?.[0]?.image || null });
    }));
  }
  const gcsClient = new (require('./apiv2.js').Client)({
    urlPrefix:require('./api.js').storageOrigin(), auth:true, apiVersion:'storage/v1'
  });
  const rollbackSources = new Map();
  for (const id of targets) {
    const fn = fnResult.functions.find(item => toId(item.name) === id);
    if (!fn) continue;
    const source = fn.buildConfig?.source?.storageSource;
    const resolved = fn.buildConfig?.sourceProvenance?.resolvedStorageSource;
    if (!resolved?.bucket || !resolved?.object || !/^[1-9][0-9]*$/.test(String(resolved.generation || '')) ||
        source?.bucket !== resolved.bucket || source?.object !== resolved.object ||
        String(source?.generation) !== String(resolved.generation)) continue;
    const object = await gcsClient.get(`/b/${encodeURIComponent(resolved.bucket)}/o/${encodeURIComponent(resolved.object)}`, {
      queryParams:{ generation:String(resolved.generation) }
    });
    if (object.status !== 200 || object.body?.bucket !== resolved.bucket ||
        object.body?.name !== resolved.object ||
        String(object.body?.generation) !== String(resolved.generation)) continue;
    rollbackSources.set(id, { bucket:resolved.bucket, object:resolved.object,
      generation:String(resolved.generation), size:String(object.body.size || ''),
      crc32c:object.body.crc32c || null, md5Hash:object.body.md5Hash || null,
      build:fn.buildConfig?.build || null });
  }
  const functions = fnResult.functions.map(fn => {
    const service = servicesByName.get(fn.serviceConfig?.service);
    const traffic = service?.trafficStatuses || [];
    const active = traffic.length === 1 && traffic[0].percent === 100 ? traffic[0].revision : null;
    return { id:toId(fn.name), region:fn.name.split('/locations/')[1]?.split('/')[0],
      state:fn.state, trigger:fn.eventTrigger?.eventType || 'http',
      service_name:service?.name || null,
      run_revision:active, traffic_percent:traffic[0]?.percent || 0,
      latest_ready_revision:toId(service?.latestReadyRevision),
      generation:service?.generation, observed_generation:service?.observedGeneration,
      reconciling:service?.reconciling || false,
      revision_ready:readyRevisions.get(toId(fn.name))?.ready || false,
      run_image:targets.includes(toId(fn.name)) ? readyRevisions.get(toId(fn.name))?.image || null : null,
      rollback_source:rollbackSources.get(toId(fn.name)) || null,
      terminal_state:service?.terminalCondition?.state || null,
      latest_created_revision:toId(service?.latestCreatedRevision),
      config_sha256:sha256(JSON.stringify({
        runtime:fn.buildConfig?.runtime, memory:fn.serviceConfig?.availableMemory,
        timeout:fn.serviceConfig?.timeoutSeconds, min:fn.serviceConfig?.minInstanceCount,
        max:fn.serviceConfig?.maxInstanceCount, concurrency:fn.serviceConfig?.maxInstanceRequestConcurrency,
        cpu:fn.serviceConfig?.availableCpu, ingress:fn.serviceConfig?.ingressSettings,
        serviceAccount:fn.serviceConfig?.serviceAccountEmail,
        secretRefs:(fn.serviceConfig?.secretEnvironmentVariables || []).map(item =>
          ({ key:item.key, secret:item.secret, version:item.version })).sort((a,b) => a.key.localeCompare(b.key)),
        eventType:fn.eventTrigger?.eventType || null
      })) };
  });
  const ref = execFileSync('git', ['ls-remote', PAGES_REMOTE, PAGES_REF], {
    cwd:ROOT, encoding:'utf8', timeout:30000, windowsHide:true
  }).trim();
  const pagesSha = ref.split(/\s+/)[0];
  return { firebase_tools_version:runtime.version,
    hosting: { version_name:hosting?.release?.version?.name,
      version_id:toId(hosting?.release?.version?.name), status:hosting?.release?.version?.status,
      public_version:publicVersion.v },
    pages: { sha:pagesSha, ref:PAGES_REF },
    rules: { ruleset_name:release.rulesetName, sha256:sha256(normalizeRules(files[0].content)) },
    indexes:indexes.map(item => ({ collectionGroup:item.name.match(/collectionGroups\/([^/]+)/)?.[1],
      queryScope:item.queryScope, state:item.state, apiScope:item.apiScope,
      density:item.density, multikey:item.multikey, unique:item.unique,
      fields:item.fields.map(field => ({fieldPath:field.fieldPath,
        order:field.order, arrayConfig:field.arrayConfig, vectorConfig:field.vectorConfig})) })),
    field_overrides:fieldOverrides.filter(item => !item.name.includes('__default__')).map(item => ({
      collectionGroup:item.name.match(/collectionGroups\/([^/]+)/)?.[1],
      fieldPath:item.name.split('/fields/')[1], ttl:!!item.ttlConfig,
      ttl_state:item.ttlConfig?.state || null,
      indexes:(item.indexConfig?.indexes || []).map(index => {
        const own = index.fields?.find(field => field.fieldPath === item.name.split('/fields/')[1]);
        return { queryScope:index.queryScope, order:own?.order, arrayConfig:own?.arrayConfig,
          state:index.state, apiScope:index.apiScope, density:index.density,
          multikey:index.multikey, unique:index.unique };
      }) })),
    functions, unreachable_regions:fnResult.unreachable
  };
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (process.versions.node.split('.')[0] !== '22') throw new Error('Node 22 required');
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('candidate tree is dirty');
  if (git(['rev-parse', 'HEAD']) !== args.sha) throw new Error('candidate SHA differs from HEAD');
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  if (args.targetsPath !== path.join(ROOT, 'release-targets-42h42.json')) {
    throw new Error('target manifest must be the tracked canonical file');
  }
  const targetBytes = fs.readFileSync(args.targetsPath);
  const trackedTarget = git(['show', 'HEAD:release-targets-42h42.json']);
  if (targetBytes.toString('utf8').trim() !== trackedTarget) {
    throw new Error('target manifest differs from tracked candidate');
  }
  const targetSpec = JSON.parse(targetBytes);
  // The manifest itself is tracked inside this Git tree. Putting its own
  // commit SHA into the file would create an impossible self-reference.
  if (targetSpec.project !== PROJECT || targetSpec.version !== '42H.42' ||
      targetSpec.scope_id !== 'full-42h42-core-v1') throw new Error('unexpected target manifest');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-manifest.json'), 'utf8'));
  const source = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const candidateRules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const baselineSource = git(['show', '0f75d45:functions/index.js']);
  if (!globalOptionsSafe(source) || !globalOptionsSafe(baselineSource)) {
    throw new Error('candidate global region changed');
  }
  const exportMeta = exportCallMetadata(source);
  const baselineMeta = exportCallMetadata(baselineSource);
  const wanted = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  const candidate = { sha:args.sha, tree, version:manifest.version,
    global_options_safe:globalOptionsSafe(source),
    rules_sha256:sha256(normalizeRules(candidateRules)),
    targets:targetSpec.targets,
    batches:targetSpec.batches, exports:Object.keys(exportMeta),
    export_kinds:Object.fromEntries(targetSpec.targets.map(id => [id, exportMeta[id]?.kind || 'missing'])),
    export_options_literal:Object.fromEntries(targetSpec.targets.map(id => [id,
      exportMeta[id]?.options_literal === true])),
    export_region_safe:Object.fromEntries(targetSpec.targets.map(id => [id,
      exportMeta[id]?.region_safe === true])),
    export_options_unchanged:Object.fromEntries(targetSpec.targets.map(id => [id,
      baselineMeta[id]
        ? baselineMeta[id].kind === exportMeta[id]?.kind &&
          baselineMeta[id].options === exportMeta[id]?.options
        : NEW_OPTION_HASHES[id] === sha256(exportMeta[id]?.options || '')])),
    indexes:wanted.indexes, field_overrides:wanted.fieldOverrides };
  const inputHash = sha256(Buffer.concat([targetBytes, Buffer.from(source),
    Buffer.from(candidateRules), Buffer.from(JSON.stringify(wanted)), Buffer.from(JSON.stringify(manifest))]));
  const live = await captureLive(targetSpec.targets);
  if (git(['status', '--porcelain=v1', '--untracked-files=all']) || git(['rev-parse', 'HEAD']) !== args.sha ||
      git(['rev-parse', 'HEAD^{tree}']) !== tree ||
      inputHash !== sha256(Buffer.concat([fs.readFileSync(args.targetsPath),
        fs.readFileSync(path.join(ROOT, 'functions', 'index.js')),
        fs.readFileSync(path.join(ROOT, 'firestore.rules')),
        Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8')))),
        Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'release-manifest.json'), 'utf8'))))]))) {
    throw new Error('candidate changed during live capture');
  }
  const snapshot = { schema:1, project:PROJECT, captured_at:new Date().toISOString(),
    candidate_sha:args.sha, candidate_tree:tree, live };
  const assessment = assessSnapshot(snapshot, candidate);
  const ledger = { ...snapshot, stage:'READ_ONLY_INVENTORY', production_release_ready:false,
    release_plan: { targets:[...candidate.targets], batches:candidate.batches.map(batch => [...batch]),
      hashes: { targets:sha256(targetBytes), functions_source:sha256(source),
        firestore_rules:candidate.rules_sha256,
        firestore_indexes:sha256(JSON.stringify(wanted)),
        release_manifest:sha256(JSON.stringify(manifest)),
        public_assets:sha256(fs.readFileSync(path.join(ROOT, 'tests', 'public-assets.json'))) },
      rollback_baseline:{ hosting_version:live.hosting.version_id, pages_sha:live.pages.sha,
        ruleset_name:live.rules.ruleset_name,
        existing_functions:live.functions.filter(fn => candidate.targets.includes(fn.id))
          .map(fn => ({id:fn.id, service_name:fn.service_name,
            revision:fn.run_revision, image:fn.run_image,
            source:fn.rollback_source, config_sha256:fn.config_sha256})) }
    }, assessment };
  fs.writeFileSync(args.output, JSON.stringify(ledger, null, 2) + '\n', { flag:'wx', mode:0o600 });
  console.log(JSON.stringify({ ledger:args.output, candidate_sha:args.sha, tree,
    hosting_version:live.hosting.version_id, pages_sha:live.pages.sha,
    live_function_count:live.functions.length, assessment }));
  if (!assessment.ok) throw new Error('preflight failed closed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error('PREFLIGHT_FAILED: ' + String(error.message || error).replace(/ya29\.[^\s]+/g, '[redacted]'));
    process.exitCode = 1;
  });
}
