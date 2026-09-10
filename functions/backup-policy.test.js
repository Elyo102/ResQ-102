'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const backupPolicy = require('./backup-policy');
const firestoreIndexes = require('../firestore.indexes.json');

test('policy manifest is internally valid and path-unique', () => {
  assert.deepEqual(backupPolicy.validatePolicies(backupPolicy.DATA_POLICIES), []);
  assert.equal(new Set(backupPolicy.DATA_POLICIES.map((p) => p.path)).size,
    backupPolicy.DATA_POLICIES.length);
});

test('missing or empty policy manifests fail closed', () => {
  assert.deepEqual(backupPolicy.validatePolicies(null), ['invalid_manifest']);
  assert.deepEqual(backupPolicy.validatePolicies([]), ['empty_manifest']);
});

test('root config and station config are distinct policies', () => {
  const root = backupPolicy.getPolicy('config/{docId}');
  const station = backupPolicy.getPolicy('stations/{sid}/config/{docId}');
  assert.ok(root);
  assert.ok(station);
  assert.notEqual(root.path, station.path);
  assert.equal(root.scope, 'root');
  assert.equal(station.scope, 'station');
});

test('schedule qualification state is backed up, restorable, and retained by its data class', () => {
  const catalog = backupPolicy.getPolicy('stations/{sid}/schedule_qualifications/{qualificationId}');
  const holdings = backupPolicy.getPolicy('stations/{sid}/schedule_person_qualifications/{uid}');
  const audit = backupPolicy.getPolicy('stations/{sid}/schedule_qualification_audit/{entryId}');
  assert.ok(catalog);
  assert.ok(holdings);
  assert.ok(audit);
  assert.deepEqual([
    catalog.classification, catalog.monitorPolicy, catalog.backupPolicy,
    catalog.restorePolicy, catalog.retention, catalog.humanReadable
  ], [
    'source_of_truth', 'count_any_loss', 'managed_export',
    'restore', 'policy_required_before_wiring', 'redacted'
  ]);
  assert.deepEqual([
    holdings.classification, holdings.monitorPolicy, holdings.backupPolicy,
    holdings.restorePolicy, holdings.retention, holdings.humanReadable
  ], [
    'source_of_truth', 'count_drop', 'managed_export',
    'restore', 'policy_required_before_wiring', 'forbidden'
  ]);
  assert.deepEqual([
    audit.classification, audit.monitorPolicy, audit.backupPolicy,
    audit.restorePolicy, audit.retention, audit.humanReadable
  ], [
    'audit_log', 'activity', 'managed_export',
    'restore', 'audit_retention_policy_required', 'forbidden'
  ]);
});

test('identity data is one restore-consistency group', () => {
  const expected = [
    'registration_requests/{uid}', 'emp_index/{emp}',
    'emp_reservations/{emp}', 'identity_operations/{uid}',
    'meta/{docId}', 'station_transfer_requests/{requestId}',
    'station_transfer_locks/{uid}',
    'stations/{sid}/pending_users/{code}',
    'stations/{sid}/users/{uid}', 'stations/{sid}/roster/{uid}'
  ].sort();
  assert.deepEqual(backupPolicy.IDENTITY_POLICY_PATHS, expected);
  for (const path of expected) {
    const item = backupPolicy.getPolicy(path);
    assert.ok(item, path);
    assert.equal(item.consistencyGroup, backupPolicy.IDENTITY_CONSISTENCY_GROUP);
    assert.equal(item.restorePolicy, 'restore_with_identity_reconciliation');
  }
});

test('station transfer locks are lifecycle-bound identity state, not TTL data', () => {
  const item = backupPolicy.getPolicy('station_transfer_locks/{uid}');
  assert.ok(item);
  assert.equal(item.classification, 'temporary');
  assert.equal(item.monitorPolicy, 'integrity_group');
  assert.equal(item.backupPolicy, 'identity_consistency_export');
  assert.equal(item.restorePolicy, 'restore_with_identity_reconciliation');
  assert.equal(item.retention, 'lifecycle_bound_active_pointer');
  assert.equal(item.consistencyGroup, backupPolicy.IDENTITY_CONSISTENCY_GROUP);
  assert.equal(firestoreIndexes.fieldOverrides.some((override) =>
    override.collectionGroup === 'station_transfer_locks' && override.ttl === true), false);
});

test('active station-transfer ownership and station lists have deployed indexes', () => {
  ['target_uid', 'source_station_id', 'target_station_id'].forEach((fieldPath) => {
    assert.equal(firestoreIndexes.indexes.some((index) =>
      index.collectionGroup === 'station_transfer_requests' &&
      index.queryScope === 'COLLECTION' &&
      JSON.stringify(index.fields) === JSON.stringify([
        { fieldPath, order:'ASCENDING' },
        { fieldPath:'status', order:'ASCENDING' }
      ])), true, 'missing station-transfer index for ' + fieldPath);
  });
});

test('activity monitoring requires an explicit contract and detects silence', () => {
  const path = 'admin_audit/{entryId}';
  assert.deepEqual(backupPolicy.assessSnapshot({
    path, current:{ ok:true, latestActivityAtMs:1000 }
  }), { status:'BLOCK', reasons:['activity_contract_missing'] });
  assert.deepEqual(backupPolicy.assessSnapshot({
    path,
    activityContract:{ checkedAtMs:5000, maxSilenceMs:2000 },
    current:{ ok:true, latestActivityAtMs:1000 }
  }), { status:'ALERT', reasons:['activity_stale'] });
  assert.deepEqual(backupPolicy.assessSnapshot({
    path,
    activityContract:{ checkedAtMs:5000, maxSilenceMs:5000 },
    current:{ ok:true, latestActivityAtMs:1000 }
  }), { status:'PASS', reasons:[] });
});

test('identity monitoring requires the full group and consistency result', () => {
  const path = 'emp_index/{emp}';
  assert.deepEqual(backupPolicy.assessSnapshot({
    path, current:{ ok:true, memberPaths:[], consistent:true }
  }), { status:'BLOCK', reasons:['integrity_contract_missing'] });
  const requiredPaths = backupPolicy.IDENTITY_POLICY_PATHS;
  assert.deepEqual(backupPolicy.assessSnapshot({
    path, integrityContract:{ requiredPaths },
    current:{ ok:true, memberPaths:['emp_index/{emp}'], consistent:false }
  }), {
    status:'ALERT',
    reasons:requiredPaths.filter((member) => member !== 'emp_index/{emp}')
      .map((member) => 'missing_integrity_member:' + member)
      .concat('identity_group_inconsistent')
  });
  assert.deepEqual(backupPolicy.assessSnapshot({
    path, integrityContract:{ requiredPaths },
    current:{ ok:true, memberPaths:[7, 'emp_index/{emp}'], consistent:true }
  }), { status:'BLOCK', reasons:['integrity_contract_invalid'] });
  assert.deepEqual(backupPolicy.assessSnapshot({
    path, integrityContract:{ requiredPaths:['emp_index/{emp}'] },
    current:{ ok:true, memberPaths:['emp_index/{emp}'], consistent:true }
  }), { status:'BLOCK', reasons:['integrity_contract_incomplete'] });
});

test('tokens and sensitive media are never human-readable exports', () => {
  for (const item of backupPolicy.DATA_POLICIES) {
    if (item.classification === 'secret_token') {
      assert.equal(item.backupPolicy, 'exclude', item.path);
    }
    if (item.sensitivity === 'secret' || item.sensitivity === 'sensitive_media') {
      assert.equal(item.humanReadable, 'forbidden', item.path);
    }
    if (item.sensitivity === 'restricted_identity') {
      assert.equal(item.humanReadable, 'forbidden', item.path);
    }
  }
});

test('human-readable export mode is an enum and photos stay out of Sheets', () => {
  const altered = backupPolicy.DATA_POLICIES.map((item, index) => index ? item :
    Object.assign({}, item, { humanReadable:'totally-public' }));
  assert.ok(backupPolicy.validatePolicies(altered).some((error) =>
    error.includes('invalid humanReadable')));
  const views = backupPolicy.getPolicy('stations/{sid}/vehicle_views/{viewId}');
  assert.equal(views.classification, 'large_media');
  assert.equal(views.backupPolicy, 'specialized_media_export');
  assert.equal(views.humanReadable, 'forbidden');
});

test('shift monitor catches 3 to 2 and 3 to 0', () => {
  const path = 'stations/{sid}/shifts/{crew}';
  const previous = { ok:true, count:3, ids:['A', 'B', 'C'], invalidIds:[] };
  const two = backupPolicy.assessSnapshot({
    path, stationId:'s1', contractStationId:'s1', previous,
    expectedIds:['A', 'B', 'C'],
    current:{ ok:true, count:2, ids:['A', 'C'], invalidIds:[] }
  });
  const zero = backupPolicy.assessSnapshot({
    path, stationId:'s1', contractStationId:'s1', previous,
    expectedIds:['A', 'B', 'C'],
    current:{ ok:true, count:0, ids:[], invalidIds:[] }
  });
  assert.equal(two.status, 'ALERT');
  assert.deepEqual(two.reasons, ['missing_expected_id:B']);
  assert.equal(zero.status, 'ALERT');
  assert.deepEqual(zero.reasons, [
    'missing_expected_id:A', 'missing_expected_id:B', 'missing_expected_id:C'
  ]);
});

test('shift monitor catches invalid content even when all three ids remain', () => {
  const result = backupPolicy.assessSnapshot({
    path:'stations/{sid}/shifts/{crew}',
    stationId:'s1', contractStationId:'s1',
    expectedIds:['A', 'B', 'C'],
    current:{ ok:true, count:3, ids:['A', 'B', 'C'], invalidIds:['B'] }
  });
  assert.deepEqual(result, { status:'ALERT', reasons:['invalid_shape:B'] });
});

test('expected-id monitor fails closed without station policy', () => {
  const result = backupPolicy.assessSnapshot({
    path:'stations/{sid}/shifts/{crew}',
    stationId:'s1', contractStationId:'s1',
    current:{ ok:true, count:3, ids:['A', 'B', 'C'], invalidIds:[] }
  });
  assert.deepEqual(result, { status:'BLOCK', reasons:['expected_ids_missing'] });
});

test('snapshot read error is not converted to zero or PASS', () => {
  const result = backupPolicy.assessSnapshot({
    path:'stations/{sid}/shifts/{crew}',
    expectedIds:['A', 'B', 'C'], current:{ ok:false }
  });
  assert.deepEqual(result, { status:'ERROR', reasons:['current_snapshot_failed'] });
});

test('required root mode document cannot silently disappear', () => {
  assert.deepEqual(backupPolicy.assessSnapshot({
    path:'config/mode', current:{ ok:true, exists:false, valid:false }
  }), {
    status:'ALERT',
    reasons:['required_document_missing', 'required_document_invalid']
  });
});

test('snapshot contracts fail closed on missing counts, shapes and extra ids', () => {
  assert.deepEqual(backupPolicy.assessSnapshot({
    path:'stations/{sid}/quals/{qid}', stationId:'s1', contractStationId:'s1',
    current:{ ok:true }
  }), { status:'BLOCK', reasons:['current_count_invalid'] });
  assert.deepEqual(backupPolicy.assessSnapshot({
    path:'salary_rules/{versionId}', previous:{ ok:false },
    current:{ ok:true, count:1 }
  }), { status:'ERROR', reasons:['previous_snapshot_failed'] });
  assert.deepEqual(backupPolicy.assessSnapshot({
    path:'config/mode', current:{ ok:true, exists:true }
  }), { status:'BLOCK', reasons:['document_shape_contract_invalid'] });
  assert.deepEqual(backupPolicy.assessSnapshot({
    path:'stations/{sid}/shifts/{crew}',
    stationId:'s1', contractStationId:'s1', expectedIds:['A', 'B', 'C'],
    current:{ ok:true, ids:['A', 'B', 'C', 'D'], invalidIds:[] }
  }), { status:'ALERT', reasons:['unexpected_id:D'] });
});

test('the same policy works for two different station contracts', () => {
  const path = 'stations/{sid}/shifts/{crew}';
  const first = backupPolicy.assessSnapshot({
    path, stationId:'station-a', contractStationId:'station-a',
    expectedIds:['A', 'B', 'C'],
    current:{ ok:true, ids:['A', 'B', 'C'], invalidIds:[] }
  });
  const second = backupPolicy.assessSnapshot({
    path, stationId:'station-b', contractStationId:'station-b',
    expectedIds:['north', 'south'],
    current:{ ok:true, ids:['north', 'south'], invalidIds:[] }
  });
  assert.equal(first.status, 'PASS');
  assert.equal(second.status, 'PASS');
  assert.deepEqual(backupPolicy.assessSnapshot({
    path, stationId:'station-a', contractStationId:'station-b',
    expectedIds:['A', 'B', 'C'],
    current:{ ok:true, ids:['A', 'B', 'C'], invalidIds:[] }
  }), { status:'BLOCK', reasons:['station_contract_mismatch'] });
});

test('unclassified paths block instead of inheriting an unsafe default', () => {
  assert.deepEqual(backupPolicy.assessSnapshot({
    path:'stations/{sid}/unknown/{id}', current:{ ok:true }
  }), { status:'BLOCK', reasons:['unclassified_path'] });
});

const hrDurablePaths = [
  ['stations/{sid}/hr_requests/{requestId}', 'source_of_truth', 'count_drop', 'restore'],
  ['stations/{sid}/hr_requests/{requestId}/events/{eventId}', 'source_of_truth', 'count_drop', 'restore_after_parent'],
  ['stations/{sid}/hr_request_operations/{operationId}', 'source_of_truth', 'count_drop', 'restore_after_parent'],
  ['stations/{sid}/hr_documents/{documentId}', 'source_of_truth', 'count_drop', 'restore'],
  ['stations/{sid}/hr_documents/{documentId}/revisions/{revision}', 'source_of_truth', 'count_drop', 'restore_after_parent'],
  ['stations/{sid}/hr_documents/{documentId}/revisions/{revision}/receipts/{uid}', 'audit_log', 'activity', 'restore_after_parent'],
  ['stations/{sid}/hr_document_operations/{operationId}', 'source_of_truth', 'count_drop', 'restore_after_parent']
];
const hrControlPaths = [
  'stations/{sid}/hr_nudge_actions/{actionId}',
  'stations/{sid}/hr_nudge_intents/{intentId}',
  'stations/{sid}/hr_request_notification_jobs/{jobId}',
  'stations/{sid}/hr_document_notification_jobs/{jobId}',
  'stations/{sid}/hr_domain_notification_intents/{intentId}',
  'hr_nudge_bulk_locks/{lockId}',
  'hr_nudge_actor_quotas/{quotaId}',
  'hr_request_actor_quotas/{quotaId}',
  'hr_document_actor_quotas/{quotaId}'
];
const hrAttachmentPaths = [
  'stations/{sid}/hr_attachments/{attachmentId}',
  'stations/{sid}/hr_attachment_ledgers/{ledgerId}',
  'hr_attachment_actor_quotas/{quotaId}'
];
const hrReviewPaths = [
  'stations/{sid}/hr_hours_review_events/{reviewId}',
  'stations/{sid}/hr_hours_reviews/{summaryId}',
  'hr_hours_review_actor_quotas/{quotaId}'
];
const hrReviewJobPath = 'stations/{sid}/hr_hours_review_notification_jobs/{jobId}';
const correctionPaths = [
  'stations/{sid}/attendance_correction_events/{correctionId}',
  'stations/{sid}/attendance_correction_receipts/{correctionId}',
  'stations/{sid}/attendance_correction_notification_jobs/{jobId}'
];
const hrPaths = hrDurablePaths.map(([path]) => path).concat(hrControlPaths, hrAttachmentPaths, hrReviewPaths, hrReviewJobPath, correctionPaths);

test('exact twenty-six private HR/correction paths are classified with no readable or automatic-retention permission', () => {
  const actual = backupPolicy.DATA_POLICIES.filter(item => item.path.split('/').some(
    segment => segment.startsWith('hr_') && segment !== 'hr_reports') || correctionPaths.includes(item.path));
  assert.equal(hrPaths.length, 26);
  assert.deepEqual(actual.map(item => item.path).sort(), [...hrPaths].sort());
  for (const path of hrPaths) {
    const item = backupPolicy.getPolicy(path);
    assert.ok(item, path);
    assert.equal(item.scope, path.startsWith('stations/') ? 'station' : 'root', path);
    assert.equal(item.sensitivity, 'restricted_identity', path);
    assert.equal(item.humanReadable, 'forbidden', path);
    assert.equal(item.retention, 'policy_required_before_wiring', path);
    const collectionGroup = path.split('/').at(-2);
    assert.equal(firestoreIndexes.fieldOverrides.some(override =>
      override.collectionGroup === collectionGroup && override.ttl === true), false, path + ' must not gain TTL');
  }
});

test('correction evidence and receipts are durable; notification work cannot restore active delivery', () => {
  for (const path of correctionPaths.slice(0, 2)) {
    const p = backupPolicy.getPolicy(path);
    assert.deepEqual([p.classification, p.monitorPolicy, p.backupPolicy, p.restorePolicy],
      ['source_of_truth', 'count_drop', 'managed_export', 'specialized_restore']);
    assert.match(p.reason, /Coherent same-snapshot event\/receipt\/attendance restore remains unresolved/);
    assert.match(p.reason, /preserve original versions and attribution/);
    assert.match(p.reason, /no export, restore or deletion activated/);
    assert.match(p.reason, /never replay notifications/);
  }
  assert.match(backupPolicy.getPolicy(correctionPaths[0]).reason, /survives row deletion/);
  assert.match(backupPolicy.getPolicy(correctionPaths[1]).reason, /independent of transient notification jobs/);
  const job = backupPolicy.getPolicy(correctionPaths[2]);
  assert.deepEqual([job.classification, job.monitorPolicy, job.backupPolicy, job.restorePolicy],
    ['temporary', 'none', 'exclude', 'do_not_restore']);
  assert.match(job.reason, /never restore into an active queue/);
  assert.match(job.reason, /exclusion activates no deletion/);
});

test('inspection receipts, summary and quota have separate prospective restore contracts', () => {
  const job=backupPolicy.getPolicy(hrReviewJobPath);
  assert.deepEqual([job.classification,job.monitorPolicy,job.backupPolicy,job.restorePolicy],['temporary','none','exclude','do_not_restore']);
  assert.match(job.reason,/never restore into an active queue/);
  assert.match(job.reason,/exclusion activates no deletion/);
  const expected = [
    ['source_of_truth','count_drop','managed_export','specialized_restore'],
    ['derived','required_document_shape','managed_export','specialized_restore'],
    ['temporary','none','exclude','do_not_restore']
  ];
  hrReviewPaths.forEach((path,i) => {
    const p=backupPolicy.getPolicy(path);
    assert.deepEqual([p.classification,p.monitorPolicy,p.backupPolicy,p.restorePolicy],expected[i]);
    if(i<2) {
      assert.match(p.reason,/Preserve original reviewed_revision/);
      assert.match(p.reason,/restored Firestore updateTime cannot manufacture current inspection/);
      assert.match(p.reason,/restore remains unresolved/);
      assert.match(p.reason,/no export, restore or deletion activated/);
      assert.match(p.reason,/never replay notifications/);
    } else assert.match(p.reason,/exclusion activates no deletion/);
  });
});

test('seven durable HR entries are prospective parent-dependent classifications, not an implemented restore', () => {
  assert.equal(hrDurablePaths.length, 7);
  for (const [path, classification, monitor, restore] of hrDurablePaths) {
    const item = backupPolicy.getPolicy(path);
    assert.deepEqual([item.classification, item.monitorPolicy, item.backupPolicy, item.restorePolicy],
      [classification, monitor, 'managed_export', restore], path);
    assert.match(item.reason, /no export, restore or deletion activated/i, path);
  }
  for (const path of ['stations/{sid}/hr_request_operations/{operationId}', 'stations/{sid}/hr_document_operations/{operationId}']) {
    const item = backupPolicy.getPolicy(path);
    assert.match(item.reason, /coherent same-snapshot/i);
    assert.match(item.reason, /procedure remains unresolved/i);
  }
});

test('nine HR control/queue entries are excluded, never restore active delivery or erase unknown outcomes', () => {
  assert.equal(hrControlPaths.length, 9);
  for (const path of hrControlPaths) {
    const item = backupPolicy.getPolicy(path);
    assert.deepEqual([item.classification, item.monitorPolicy, item.backupPolicy, item.restorePolicy],
      ['temporary', 'none', 'exclude', 'do_not_restore'], path);
    assert.match(item.reason, /exclusion activates no deletion/i, path);
  }
});

test('attachment metadata requires specialized coherent restore; quota exclusion activates no deletion', () => {
  for (const path of hrAttachmentPaths.slice(0, 2)) {
    const item = backupPolicy.getPolicy(path);
    assert.deepEqual([item.classification, item.monitorPolicy, item.backupPolicy, item.restorePolicy],
      ['source_of_truth', 'count_drop', 'managed_export', 'specialized_restore'], path);
    assert.match(item.reason, /parent\/revision\/object-generation\/ledger restore.*unresolved/i);
    assert.match(item.reason, /no export, restore or deletion activated/i);
  }
  const ledger = backupPolicy.getPolicy(hrAttachmentPaths[1]);
  assert.match(ledger.reason, /uncertain writes/i);
  assert.match(ledger.reason, /not rebuildable from ready files or disposable on expiry/i);
  const quota = backupPolicy.getPolicy(hrAttachmentPaths[2]);
  assert.deepEqual([quota.classification, quota.monitorPolicy, quota.backupPolicy, quota.restorePolicy],
    ['temporary', 'none', 'exclude', 'do_not_restore']);
  assert.match(quota.reason, /exclusion activates no deletion/i);
});

test('every private HR classification rejects a human-readable mutation', () => {
  for (const path of hrPaths) {
    for (const humanReadable of ['allowed', 'redacted']) {
      const modified = { ...backupPolicy.getPolicy(path), humanReadable };
      assert.ok(backupPolicy.validatePolicies([modified]).some(error =>
        error.includes('identity data must be forbidden')), path + '/' + humanReadable);
    }
  }
});
