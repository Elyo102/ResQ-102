'use strict';

// Pure data-protection policy for ResQ. This module performs no Firestore,
// Google Sheets, Auth or network access. Wiring is intentionally deferred
// until multi-station ownership, privacy and restore procedures are approved.

const REQUIRED_FIELDS = Object.freeze([
  'path', 'scope', 'classification', 'monitorPolicy', 'backupPolicy',
  'restorePolicy', 'sensitivity', 'retention', 'reason', 'humanReadable'
]);

const ALLOWED = Object.freeze({
  scope:new Set(['root', 'station']),
  classification:new Set([
    'source_of_truth', 'derived', 'temporary', 'secret_token',
    'audit_log', 'large_media', 'monitor_state'
  ]),
  monitorPolicy:new Set([
    'expected_ids_and_shape', 'required_document_shape',
    'count_any_loss', 'count_drop',
    'activity', 'integrity_group', 'none'
  ]),
  backupPolicy:new Set([
    'managed_export', 'identity_consistency_export', 'rebuild', 'exclude',
    'specialized_media_export'
  ]),
  restorePolicy:new Set([
    'restore', 'restore_with_identity_reconciliation', 'rebuild',
    'do_not_restore', 'restore_after_parent', 'specialized_restore'
  ]),
  sensitivity:new Set([
    'operational', 'confidential', 'restricted_identity',
    'secret', 'sensitive_media'
  ]),
  humanReadable:new Set(['allowed', 'redacted', 'forbidden'])
});

const IDENTITY_CONSISTENCY_GROUP = 'identity_and_auth';

function policy(path, scope, classification, monitorPolicy, backupPolicy,
                restorePolicy, sensitivity, retention, reason, extra) {
  return Object.freeze(Object.assign({
    path, scope, classification, monitorPolicy, backupPolicy,
    restorePolicy, sensitivity, retention, reason
  }, extra || {}));
}

const DATA_POLICIES = Object.freeze([
  // Server-only operational reporting. This policy classifies data; it does
  // not enable a managed backup, export, scheduler or paid retention service.
  policy('stations/{sid}/incidents/{fingerprint}', 'station', 'monitor_state',
    'activity', 'exclude', 'do_not_restore', 'operational', 'manual_after_resolution',
    'Finite technical categories; no automatic expiry, manual deletion only after treatment.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/incident_days/{day}', 'station', 'temporary',
    'none', 'exclude', 'do_not_restore', 'operational', 'ttl_3_days',
    'Station reporting quota, not durable business data.', { humanReadable:'redacted' }),
  policy('stations/{sid}/feedback/{feedbackId}', 'station', 'source_of_truth',
    'activity', 'managed_export', 'restore', 'restricted_identity',
    'ttl_30_days_or_manual', 'Private feedback expires after 30 days or explicit manual deletion; exports require separate retention.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/feedback_quota/{quotaId}', 'station', 'temporary',
    'none', 'exclude', 'do_not_restore', 'restricted_identity', 'ttl_3_days',
    'Per-author feedback quota includes identity.', { humanReadable:'forbidden' }),
  // Root identity and control plane.
  policy('registration_requests/{uid}', 'root', 'source_of_truth',
    'integrity_group', 'identity_consistency_export',
    'restore_with_identity_reconciliation', 'restricted_identity',
    'policy_required_before_wiring', 'Pending onboarding requests.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('emp_index/{emp}', 'root', 'source_of_truth', 'integrity_group',
    'identity_consistency_export', 'restore_with_identity_reconciliation',
    'restricted_identity', 'policy_required_before_wiring',
    'Employee-number ownership index.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('emp_reservations/{emp}', 'root', 'temporary', 'integrity_group',
    'identity_consistency_export', 'restore_with_identity_reconciliation',
    'restricted_identity', 'ttl_policy_required',
    'Active employee-number reservations participate in identity transactions.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('identity_operations/{uid}', 'root', 'source_of_truth',
    'integrity_group', 'identity_consistency_export',
    'restore_with_identity_reconciliation', 'restricted_identity',
    'policy_required_before_wiring', 'Identity transaction plans and state.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('station_transfer_requests/{requestId}', 'root', 'source_of_truth',
    'integrity_group', 'identity_consistency_export',
    'restore_with_identity_reconciliation', 'restricted_identity',
    'policy_required_before_wiring',
    'Pending transfer state and completed station-transfer audit evidence.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('station_transfer_locks/{uid}', 'root', 'temporary', 'integrity_group',
    'identity_consistency_export', 'restore_with_identity_reconciliation',
    'restricted_identity', 'lifecycle_bound_active_pointer',
    'Active transfer ownership must remain consistent with its canonical request.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('login_attempts/{emp}', 'root', 'temporary', 'none', 'exclude',
    'do_not_restore', 'secret', 'ttl_policy_required',
    'Rate-limit state must not be restored as durable identity data.',
    { humanReadable:'forbidden' }),
  policy('meta/{docId}', 'root', 'source_of_truth', 'expected_ids_and_shape',
    'identity_consistency_export', 'restore_with_identity_reconciliation',
    'restricted_identity',
    'policy_required_before_wiring',
    'System counters, including employee-number allocation.',
    { requiredIdsSource:'server_policy.meta_required_ids',
      consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('mail/{docId}', 'root', 'temporary', 'none', 'exclude',
    'do_not_restore', 'secret', 'ttl_policy_required',
    'Delivery queue items may contain addresses and message bodies.',
    { humanReadable:'forbidden' }),
  policy('mail_failures/{docId}', 'root', 'audit_log', 'activity',
    'managed_export', 'restore', 'secret', 'policy_required_before_wiring',
    'Delivery failures are security-sensitive operational evidence.',
    { humanReadable:'forbidden' }),
  policy('unlock_tokens/{token}', 'root', 'secret_token', 'none', 'exclude',
    'do_not_restore', 'secret', 'ttl_policy_required',
    'Live unlock tokens must never be copied to a readable export.',
    { humanReadable:'forbidden' }),
  policy('config/mode', 'root', 'source_of_truth', 'required_document_shape',
    'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Global runtime mode.',
    { humanReadable:'redacted' }),
  policy('config/{docId}', 'root', 'source_of_truth',
    'expected_ids_and_shape', 'managed_export', 'restore', 'secret',
    'policy_required_before_wiring',
    'Global configuration may include operational secrets.',
    { requiredIdsSource:'server_policy.root_config_required_ids', humanReadable:'forbidden' }),
  policy('silenced/{entryId}', 'root', 'audit_log', 'activity',
    'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Suppressed-alert audit trail.',
    { humanReadable:'redacted' }),
  policy('join_attempts/{uid}', 'root', 'temporary', 'none', 'exclude',
    'do_not_restore', 'secret', 'ttl_policy_required',
    'Join-code rate-limit state.', { humanReadable:'forbidden' }),
  policy('directory/{uid}', 'root', 'derived', 'count_drop', 'rebuild',
    'rebuild', 'restricted_identity', 'rebuild_not_retain',
    'Search projection rebuilt from approved station identities.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('salary_rules/{versionId}', 'root', 'source_of_truth',
    'count_any_loss', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Versioned salary calculation rules.',
    { humanReadable:'redacted' }),
  policy('admin_audit/{entryId}', 'root', 'audit_log', 'activity',
    'managed_export', 'restore', 'restricted_identity',
    'audit_retention_policy_required', 'Administrative security audit trail.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}', 'root', 'source_of_truth', 'count_any_loss',
    'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Station registry and district ownership.',
    { humanReadable:'redacted' }),

  // Station-owned data. Full paths deliberately distinguish root config from
  // station config and make cross-station leakage visible during review.
  policy('stations/{sid}/pending_users/{code}', 'station', 'temporary',
    'integrity_group', 'identity_consistency_export',
    'restore_with_identity_reconciliation', 'restricted_identity',
    'ttl_policy_required', 'Legacy/pending onboarding identity records.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('stations/{sid}/users/{uid}', 'station', 'source_of_truth',
    'integrity_group', 'identity_consistency_export',
    'restore_with_identity_reconciliation', 'restricted_identity',
    'policy_required_before_wiring', 'Station identity and authorization mirror.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('stations/{sid}/sub_stations/{subId}', 'station', 'source_of_truth',
    'count_any_loss', 'managed_export', 'restore', 'operational',
    'policy_required_before_wiring', 'Station-endpoint structure.',
    { humanReadable:'allowed' }),
  policy('stations/{sid}/sub_stations/{subId}/bulletin_messages/{messageId}',
    'station', 'source_of_truth', 'count_drop', 'managed_export', 'restore',
    'confidential', 'policy_required_before_wiring', 'Bulletin history.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/sub_stations/{subId}/bulletin_messages/{messageId}/bulletin_replies/{replyId}',
    'station', 'source_of_truth', 'count_drop', 'managed_export',
    'restore_after_parent', 'confidential', 'policy_required_before_wiring',
    'Replies must be restored only after their parent message.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/shifts/{crew}', 'station', 'source_of_truth',
    'expected_ids_and_shape', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Canonical shift documents.',
    { requiredIdsSource:'station_policy.shift_ids', humanReadable:'redacted' }),
  policy('stations/{sid}/shifts/{crew}/{document=**}', 'station',
    'source_of_truth', 'expected_ids_and_shape', 'managed_export',
    'restore_after_parent', 'confidential', 'policy_required_before_wiring',
    'Future nested shift data is covered explicitly.',
    { requiredIdsSource:'station_policy.shift_nested_contract', humanReadable:'redacted' }),
  policy('stations/{sid}/presence/{uid}', 'station', 'temporary', 'none',
    'exclude', 'do_not_restore', 'restricted_identity', 'ttl_policy_required',
    'Online-presence state is transient.', { humanReadable:'forbidden' }),
  policy('stations/{sid}/roster/{uid}', 'station', 'source_of_truth',
    'integrity_group', 'identity_consistency_export',
    'restore_with_identity_reconciliation', 'restricted_identity',
    'policy_required_before_wiring', 'Operational roster and identity assignment.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('stations/{sid}/quals/{qid}', 'station', 'source_of_truth',
    'count_any_loss', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Qualification definitions.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/member_quals/{uid}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'restricted_identity',
    'policy_required_before_wiring', 'Member qualification assignments.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/config/{docId}', 'station', 'source_of_truth',
    'expected_ids_and_shape', 'managed_export', 'restore', 'secret',
    'policy_required_before_wiring', 'Station-specific configuration.',
    { requiredIdsSource:'station_policy.config_required_ids', humanReadable:'forbidden' }),
  policy('stations/{sid}/units/{unitId}', 'station', 'source_of_truth',
    'count_any_loss', 'managed_export', 'restore', 'operational',
    'policy_required_before_wiring', 'Operational unit definitions.',
    { humanReadable:'allowed' }),
  policy('stations/{sid}/vehicles/{vehicleId}', 'station', 'source_of_truth',
    'count_any_loss', 'managed_export', 'restore', 'operational',
    'policy_required_before_wiring', 'Vehicle inventory.',
    { humanReadable:'allowed' }),
  policy('stations/{sid}/backups/{dateId}', 'station', 'monitor_state',
    'none', 'exclude', 'do_not_restore', 'operational',
    'monitor_retention_policy_required', 'Monitoring snapshots are not source data.',
    { humanReadable:'allowed' }),
  policy('stations/{sid}/vehicle_views/{viewId}', 'station', 'large_media',
    'count_drop', 'specialized_media_export', 'specialized_restore',
    'sensitive_media', 'media_retention_policy_required',
    'Vehicle inspection views may embed large photographs.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/submissions/{subId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'restricted_identity',
    'policy_required_before_wiring', 'Submitted operational forms.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/redline_waivers/{wId}', 'station', 'audit_log',
    'count_any_loss', 'managed_export', 'restore', 'restricted_identity',
    'audit_retention_policy_required', 'Safety waiver audit trail.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/handovers/{hoId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Shift handover records.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/faults/{faultId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Fault and damage history.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/faults/{faultId}/photos/{photoId}', 'station',
    'large_media', 'count_drop', 'specialized_media_export',
    'specialized_restore', 'sensitive_media', 'media_retention_policy_required',
    'Fault photographs require binary-safe storage, not Sheets.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/rotations/{rotationId}', 'station', 'source_of_truth',
    'expected_ids_and_shape', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Rotation definitions drive scheduling.',
    { requiredIdsSource:'station_policy.rotation_contract', humanReadable:'redacted' }),
  policy('stations/{sid}/shift_overrides/{overrideId}', 'station',
    'source_of_truth', 'count_drop', 'managed_export', 'restore',
    'restricted_identity', 'policy_required_before_wiring',
    'Manual schedule overrides.', { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_state/{stateId}', 'station',
    'source_of_truth', 'required_document_shape', 'managed_export', 'restore',
    'confidential', 'policy_required_before_wiring',
    'Schedule runtime mode and active immutable publication pointer.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/schedule_access/{uid}', 'station',
    'source_of_truth', 'integrity_group', 'managed_export', 'restore',
    'restricted_identity', 'policy_required_before_wiring',
    'Live, station-scoped schedule-manager appointments.',
    { consistencyGroup:IDENTITY_CONSISTENCY_GROUP, humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_policies/{policyId}', 'station',
    'source_of_truth', 'count_any_loss', 'managed_export', 'restore',
    'confidential', 'policy_required_before_wiring',
    'Versioned station staffing, rest and rotation policy.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/schedule_sources/{sourceId}', 'station',
    'source_of_truth', 'count_any_loss', 'managed_export', 'restore',
    'restricted_identity', 'policy_required_before_wiring',
    'Signed server-owned source snapshot used by the schedule engine.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_sources/{sourceId}/{document=**}', 'station',
    'source_of_truth', 'count_drop', 'managed_export', 'restore_after_parent',
    'restricted_identity', 'policy_required_before_wiring',
    'Roster, availability, locked assignments and events inside a source snapshot.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_drafts/{draftId}', 'station',
    'derived', 'count_drop', 'rebuild', 'rebuild', 'restricted_identity',
    'rebuild_not_retain', 'Schedule drafts are reproducible from signed source and policy.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_drafts/{draftId}/{document=**}', 'station',
    'derived', 'count_drop', 'rebuild', 'rebuild', 'restricted_identity',
    'rebuild_not_retain', 'Draft rows and events are reproducible projections.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_publications/{publicationId}', 'station',
    'source_of_truth', 'count_any_loss', 'managed_export', 'restore',
    'restricted_identity', 'legal_retention_policy_required',
    'Immutable published schedules are operational history.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_publications/{publicationId}/rows/{rowId}', 'station',
    'source_of_truth', 'count_drop', 'managed_export', 'restore_after_parent',
    'restricted_identity', 'legal_retention_policy_required',
    'Immutable published schedule rows.', { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_publications/{publicationId}/events/{eventId}', 'station',
    'source_of_truth', 'count_drop', 'managed_export', 'restore_after_parent',
    'restricted_identity', 'legal_retention_policy_required',
    'Immutable published schedule events.', { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_publications/{publicationId}/people/{uid}', 'station',
    'source_of_truth', 'count_drop', 'managed_export', 'restore_after_parent',
    'restricted_identity', 'legal_retention_policy_required',
    'Immutable display-name and qualification projection for a publication.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_publications/{publicationId}/schedule_outbox/{notificationId}', 'station',
    'temporary', 'none', 'exclude', 'do_not_restore', 'secret',
    'ttl_policy_required', 'Push delivery queue is transient and can contain internal change detail.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_responses/{responseId}', 'station',
    'source_of_truth', 'count_drop', 'managed_export', 'restore',
    'restricted_identity', 'legal_retention_policy_required',
    'Firefighter confirmations and declines for active assignments.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_audit/{entryId}', 'station',
    'audit_log', 'activity', 'managed_export', 'restore',
    'restricted_identity', 'audit_retention_policy_required',
    'Schedule publication and rollback audit trail.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_policy_operations/{requestId}', 'station',
    'temporary', 'none', 'exclude', 'do_not_restore', 'secret',
    'ttl_policy_required',
    'Idempotency records for server-only station-policy writes.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_policy_audit/{entryId}', 'station',
    'audit_log', 'activity', 'managed_export', 'restore',
    'restricted_identity', 'audit_retention_policy_required',
    'Who changed the station manning rules, when, and by how much.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_mode_operations/{requestId}', 'station',
    'temporary', 'none', 'exclude', 'do_not_restore', 'secret',
    'ttl_policy_required',
    'Idempotency records for server-only schedule engine mode changes.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_mode_audit/{entryId}', 'station',
    'audit_log', 'activity', 'managed_export', 'restore',
    'restricted_identity', 'audit_retention_policy_required',
    'Who turned the schedule engine on or off, when, and why.',
    { humanReadable:'forbidden' }),
  // ⭐ דוח ה-preflight של המעבר לחי. ספירות, digests וקודי סיבה —
  // אין בו שם ואין uid, וזה בכוונה: הוא נשמר, מוצג ונכנס ליומן.
  policy('stations/{sid}/schedule_preflight/{publicationId}', 'station',
    'derived', 'none', 'managed_export', 'restore',
    'restricted_identity', 'ttl_policy_required',
    'Signed cutover preflight: counts, digests and reason codes only.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_source_operations/{requestId}', 'station',
    'temporary', 'none', 'exclude', 'do_not_restore', 'secret',
    'ttl_policy_required',
    'Idempotency records for server-only personnel-source imports.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/schedule_source_audit/{entryId}', 'station',
    'audit_log', 'activity', 'managed_export', 'restore',
    'restricted_identity', 'audit_retention_policy_required',
    'Personnel-source import counts and rejection codes. Names never enter it.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/postings/{postingId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Operational postings.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/attendance/{docId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'restricted_identity',
    'legal_retention_policy_required', 'Attendance and work-hour records.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/push_tokens/{uid}', 'station', 'secret_token',
    'none', 'exclude', 'do_not_restore', 'secret', 'ttl_policy_required',
    'Push tokens are live credentials.', { humanReadable:'forbidden' }),
  policy('stations/{sid}/signatures/{uid}', 'station', 'large_media',
    'count_drop', 'specialized_media_export', 'specialized_restore',
    'sensitive_media', 'legal_retention_policy_required',
    'Signature images and metadata require restricted binary-safe storage.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/broadcasts/{msgId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'confidential',
    'policy_required_before_wiring', 'Broadcast history.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/guards/{gId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'restricted_identity',
    'policy_required_before_wiring', 'Guard assignments.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/guard_operations/{operationId}', 'station', 'temporary',
    'none', 'exclude', 'do_not_restore', 'secret', 'ttl_policy_required',
    'Idempotency records for server-only guard operations.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/guard_audit/{auditId}', 'station', 'audit_log',
    'activity', 'managed_export', 'restore', 'restricted_identity',
    'audit_retention_policy_required', 'Server-authorized guard operation trace.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/guard_notification_jobs/{jobId}', 'station', 'temporary',
    'none', 'exclude', 'do_not_restore', 'secret', 'ttl_policy_required',
    'Private staged fan-out for guard-assignment notifications.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/guard_outbox/{outboxId}', 'station', 'temporary',
    'none', 'exclude', 'do_not_restore', 'secret', 'ttl_policy_required',
    'Private retry queue for guard-assignment notifications.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/callouts/{coId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'restricted_identity',
    'legal_retention_policy_required', 'Callout and response records.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/swaps/{swapId}', 'station', 'source_of_truth',
    'count_drop', 'managed_export', 'restore', 'restricted_identity',
    'legal_retention_policy_required', 'Shift swap decisions.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/shift_log/{msgId}', 'station', 'audit_log',
    'activity', 'managed_export', 'restore', 'restricted_identity',
    'audit_retention_policy_required', 'Shift activity audit log.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/documents/{docId}', 'station', 'large_media',
    'count_drop', 'specialized_media_export', 'specialized_restore',
    'sensitive_media', 'legal_retention_policy_required',
    'Documents may contain personal or medical information.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/security_events/{eventId}', 'station', 'audit_log',
    'activity', 'managed_export', 'restore', 'secret',
    'audit_retention_policy_required', 'Security event audit trail.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/health/{dateId}', 'station', 'derived', 'activity',
    'rebuild', 'rebuild', 'confidential', 'rebuild_not_retain',
    'Generated health status can be rebuilt from source checks.',
    { humanReadable:'redacted' }),
  policy('stations/{sid}/scans/{monthKey}', 'station', 'derived', 'activity',
    'rebuild', 'rebuild', 'restricted_identity', 'rebuild_not_retain',
    'Nightly scan output is derived from schedules and attendance.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/hr_reports/{monthKey}', 'station', 'audit_log',
    'activity', 'managed_export', 'restore', 'restricted_identity',
    'audit_retention_policy_required', 'HR delivery and report status.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/attendance_shadow_runs/{runId}', 'station',
    'derived', 'activity', 'rebuild', 'rebuild', 'restricted_identity',
    'shadow_retention_policy_required', 'Shadow raw runs are rebuildable.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/attendance_shadow_runs/{runId}/attendance_shadow_entries/{entryId}',
    'station', 'derived', 'none', 'rebuild', 'rebuild',
    'restricted_identity', 'shadow_retention_policy_required',
    'Shadow entries are rebuildable children of a run.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/attendance_shadow_reports/{monthKey}', 'station',
    'derived', 'activity', 'rebuild', 'rebuild', 'restricted_identity',
    'shadow_retention_policy_required', 'Shadow monthly reports are derived.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/attendance_shadow_reports/{monthKey}/attendance_shadow_generations/{generationId}',
    'station', 'derived', 'none', 'rebuild', 'rebuild',
    'restricted_identity', 'shadow_retention_policy_required',
    'Shadow generations are derived build artifacts.',
    { humanReadable:'forbidden' }),
  policy('stations/{sid}/attendance_shadow_reports/{monthKey}/attendance_shadow_generations/{generationId}/attendance_shadow_people/{uid}',
    'station', 'derived', 'none', 'rebuild', 'rebuild',
    'restricted_identity', 'shadow_retention_policy_required',
    'Per-person shadow output is derived.', { humanReadable:'forbidden' }),
  policy('stations/{sid}/attendance_shadow_reports/{monthKey}/attendance_shadow_people/{uid}',
    'station', 'derived', 'none', 'exclude', 'do_not_restore',
    'restricted_identity', 'rebuild_not_retain',
    'Closed legacy shadow path.', { humanReadable:'forbidden' }),
  policy('stations/{sid}/monthly_reports/{docId}', 'station',
    'source_of_truth', 'count_drop', 'managed_export', 'restore',
    'restricted_identity', 'legal_retention_policy_required',
    'Signed monthly work reports.', { humanReadable:'forbidden' })
]);

const IDENTITY_POLICY_PATHS = Object.freeze(DATA_POLICIES
  .filter((item) => item.consistencyGroup === IDENTITY_CONSISTENCY_GROUP &&
    item.backupPolicy === 'identity_consistency_export')
  .map((item) => item.path)
  .sort());

const POLICY_BY_PATH = new Map(DATA_POLICIES.map((item) => [item.path, item]));

function validatePolicies(entriesValue) {
  const errors = [];
  if (!Array.isArray(entriesValue)) return ['invalid_manifest'];
  if (!entriesValue.length) return ['empty_manifest'];
  const entries = entriesValue;
  const seen = new Set();
  for (const item of entries) {
    if (!item || typeof item !== 'object') {
      errors.push('policy entry must be an object');
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (typeof item[field] !== 'string' || !item[field].trim()) {
        errors.push((item.path || '<unknown>') + ': missing ' + field);
      }
    }
    if (seen.has(item.path)) errors.push(item.path + ': duplicate path');
    seen.add(item.path);
    for (const field of ['scope', 'classification', 'monitorPolicy',
      'backupPolicy', 'restorePolicy', 'sensitivity', 'humanReadable']) {
      if (!ALLOWED[field].has(item[field])) {
        errors.push((item.path || '<unknown>') + ': invalid ' + field);
      }
    }
    if (item.classification === 'secret_token' && item.backupPolicy !== 'exclude') {
      errors.push(item.path + ': secret_token must be excluded');
    }
    if ((item.sensitivity === 'secret' || item.sensitivity === 'sensitive_media') &&
        item.humanReadable !== 'forbidden') {
      errors.push(item.path + ': sensitive data must be forbidden in human-readable exports');
    }
    if (item.sensitivity === 'restricted_identity' &&
        item.humanReadable !== 'forbidden') {
      errors.push(item.path + ': identity data must be forbidden in human-readable exports');
    }
    if (item.backupPolicy === 'identity_consistency_export' &&
        item.consistencyGroup !== IDENTITY_CONSISTENCY_GROUP) {
      errors.push(item.path + ': identity export is missing its consistency group');
    }
    if (item.monitorPolicy === 'expected_ids_and_shape' && !item.requiredIdsSource) {
      errors.push(item.path + ': expected-id monitoring needs a server policy source');
    }
  }
  return errors;
}

function getPolicy(pathPattern) {
  return POLICY_BY_PATH.get(String(pathPattern || '')) || null;
}

function assessSnapshot(inputValue) {
  const input = inputValue && typeof inputValue === 'object' ? inputValue : {};
  const item = getPolicy(input.path);
  if (!item) return { status:'BLOCK', reasons:['unclassified_path'] };
  const current = input.current;
  const previous = input.previous;
  if (!current || current.ok !== true) {
    return { status:'ERROR', reasons:['current_snapshot_failed'] };
  }
  if (item.scope === 'station') {
    if (typeof input.stationId !== 'string' || !input.stationId ||
        typeof input.contractStationId !== 'string' || !input.contractStationId) {
      return { status:'BLOCK', reasons:['station_contract_missing'] };
    }
    if (input.stationId !== input.contractStationId) {
      return { status:'BLOCK', reasons:['station_contract_mismatch'] };
    }
  }
  if (item.monitorPolicy === 'none') return { status:'PASS', reasons:[] };

  const reasons = [];
  if (item.monitorPolicy === 'expected_ids_and_shape') {
    const expectedIds = Array.isArray(input.expectedIds) ? input.expectedIds : [];
    if (!expectedIds.length) return { status:'BLOCK', reasons:['expected_ids_missing'] };
    if (expectedIds.some((id) => typeof id !== 'string' || !id) ||
        new Set(expectedIds).size !== expectedIds.length ||
        !Array.isArray(current.ids) || !Array.isArray(current.invalidIds) ||
        current.ids.some((id) => typeof id !== 'string' || !id) ||
        current.invalidIds.some((id) => typeof id !== 'string' || !id)) {
      return { status:'BLOCK', reasons:['expected_ids_contract_invalid'] };
    }
    const ids = new Set(current.ids);
    const expected = new Set(expectedIds);
    for (const id of expectedIds) {
      if (!ids.has(id)) reasons.push('missing_expected_id:' + id);
    }
    for (const id of current.ids) {
      if (!expected.has(id)) reasons.push('unexpected_id:' + id);
    }
    for (const id of current.invalidIds) {
      reasons.push('invalid_shape:' + id);
    }
  } else if (item.monitorPolicy === 'required_document_shape') {
    if (typeof current.exists !== 'boolean' || typeof current.valid !== 'boolean') {
      return { status:'BLOCK', reasons:['document_shape_contract_invalid'] };
    }
    if (current.exists !== true) reasons.push('required_document_missing');
    if (current.valid === false) reasons.push('required_document_invalid');
  } else if (item.monitorPolicy === 'count_any_loss') {
    const now = Number(current.count);
    if (!Number.isInteger(now) || now < 0) {
      return { status:'BLOCK', reasons:['current_count_invalid'] };
    }
    if (previous !== undefined && previous !== null && previous.ok !== true) {
      return { status:'ERROR', reasons:['previous_snapshot_failed'] };
    }
    if (previous && previous.ok === true &&
        (!Number.isInteger(Number(previous.count)) || Number(previous.count) < 0)) {
      return { status:'BLOCK', reasons:['previous_count_invalid'] };
    }
    if (previous && previous.ok === true && now < Number(previous.count)) {
      reasons.push('document_count_decreased');
    }
  } else if (item.monitorPolicy === 'count_drop') {
    const now = Number(current.count);
    if (!Number.isInteger(now) || now < 0) {
      return { status:'BLOCK', reasons:['current_count_invalid'] };
    }
    if (previous !== undefined && previous !== null && previous.ok !== true) {
      return { status:'ERROR', reasons:['previous_snapshot_failed'] };
    }
    if (previous && previous.ok === true) {
      const was = Number(previous.count);
      if (!Number.isInteger(was) || was < 0) {
        return { status:'BLOCK', reasons:['previous_count_invalid'] };
      }
      if (was > 0 && now < was * 0.75) reasons.push('document_count_dropped');
    }
  } else if (item.monitorPolicy === 'activity') {
    const contract = input.activityContract;
    if (!contract || typeof contract !== 'object') {
      return { status:'BLOCK', reasons:['activity_contract_missing'] };
    }
    const maxSilenceMs = Number(contract.maxSilenceMs);
    const checkedAtMs = Number(contract.checkedAtMs);
    if (!Number.isFinite(maxSilenceMs) || maxSilenceMs <= 0 ||
        !Number.isFinite(checkedAtMs)) {
      return { status:'BLOCK', reasons:['activity_contract_invalid'] };
    }
    const latestActivityAtMs = Number(current.latestActivityAtMs);
    if (!Number.isFinite(latestActivityAtMs)) {
      reasons.push('activity_timestamp_missing');
    } else if (latestActivityAtMs > checkedAtMs) {
      reasons.push('activity_timestamp_in_future');
    } else if (checkedAtMs - latestActivityAtMs > maxSilenceMs) {
      reasons.push('activity_stale');
    }
  } else if (item.monitorPolicy === 'integrity_group') {
    const contract = input.integrityContract;
    if (!contract || typeof contract !== 'object') {
      return { status:'BLOCK', reasons:['integrity_contract_missing'] };
    }
    const requiredPaths = contract.requiredPaths;
    const memberPaths = current.memberPaths;
    if (!Array.isArray(requiredPaths) || !requiredPaths.length ||
        requiredPaths.some((path) => typeof path !== 'string' || !path) ||
        new Set(requiredPaths).size !== requiredPaths.length ||
        !Array.isArray(memberPaths) ||
        memberPaths.some((path) => typeof path !== 'string' || !path) ||
        new Set(memberPaths).size !== memberPaths.length ||
        typeof current.consistent !== 'boolean') {
      return { status:'BLOCK', reasons:['integrity_contract_invalid'] };
    }
    const canonicalPaths = IDENTITY_POLICY_PATHS;
    const requiredSet = new Set(requiredPaths);
    if (requiredSet.size !== canonicalPaths.length ||
        canonicalPaths.some((path) => !requiredSet.has(path))) {
      return { status:'BLOCK', reasons:['integrity_contract_incomplete'] };
    }
    const observed = new Set(memberPaths);
    for (const path of requiredPaths) {
      if (!observed.has(path)) reasons.push('missing_integrity_member:' + path);
    }
    if (current.consistent !== true) reasons.push('identity_group_inconsistent');
  } else {
    return { status:'BLOCK', reasons:['monitor_policy_not_implemented'] };
  }
  return { status:reasons.length ? 'ALERT' : 'PASS', reasons };
}

module.exports = {
  DATA_POLICIES,
  IDENTITY_CONSISTENCY_GROUP,
  IDENTITY_POLICY_PATHS,
  assessSnapshot,
  getPolicy,
  validatePolicies
};
