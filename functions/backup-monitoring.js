'use strict';

// Pure backup observation evaluator for ResQ.
// Receives a pre-built observation; performs no IO, Firebase, fetch, or collection reads.
// Outcomes are PASS | ALERT | BLOCK | ERROR. This module does NOT send alerts.

const OUTCOMES = Object.freeze(['PASS', 'ALERT', 'BLOCK', 'ERROR']);

const SEVERITY = Object.freeze({ PASS: 0, ALERT: 1, BLOCK: 2, ERROR: 3 });

const DEFAULT_THRESHOLDS = Object.freeze({
  maxAgeHours: 24,
  maxDurationMs: 60 * 60 * 1000,
  minSizeBytes: 1,
  restoreDrillMaxAgeHours: 24 * 30
});

const KNOWN_BACKUP_TYPES = Object.freeze([
  'firestore', 'auth', 'storage', 'local_bundle', 'sheet', 'archive', 'other'
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

function hoursBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / (60 * 60 * 1000);
}

function bump(current, next) {
  return SEVERITY[next] > SEVERITY[current] ? next : current;
}

function pushReason(reasons, code, detail) {
  reasons.push(detail ? { code: code, detail: detail } : { code: code });
}

/**
 * Evaluate a backup observation.
 * @param {object} observation
 * @param {object} [options]
 * @returns {{ status: string, reasons: Array, details: object }}
 */
function evaluateBackupObservation(observation, options) {
  const opts = Object.assign({}, DEFAULT_THRESHOLDS, options || {});
  const reasons = [];
  let status = 'PASS';
  const details = {};

  if (observation == null || typeof observation !== 'object' || Array.isArray(observation)) {
    return {
      status: 'ERROR',
      reasons: [{ code: 'invalid_observation' }],
      details: { note: 'evaluator_only_no_alert_sent' }
    };
  }

  const nowMs = parseTime(opts.now != null ? opts.now : Date.now());
  if (!Number.isFinite(nowMs)) {
    return {
      status: 'ERROR',
      reasons: [{ code: 'invalid_now' }],
      details: { note: 'evaluator_only_no_alert_sent' }
    };
  }
  details.evaluatedAt = new Date(nowMs).toISOString();

  const lastBackupAt = observation.lastBackupAt;
  const lastMs = lastBackupAt == null || lastBackupAt === '' ? null : parseTime(lastBackupAt);
  if (lastBackupAt != null && lastBackupAt !== '' && !Number.isFinite(lastMs)) {
    status = bump(status, 'ERROR');
    pushReason(reasons, 'invalid_last_backup_time', String(lastBackupAt));
  }

  const declaredStatus = observation.status != null
    ? String(observation.status).toUpperCase()
    : null;
  details.declaredStatus = declaredStatus;

  const missingBackup = observation.missingBackup === true
    || declaredStatus === 'MISSING'
    || lastMs == null;
  if (missingBackup && lastMs == null) {
    status = bump(status, 'BLOCK');
    pushReason(reasons, 'missing_backup');
  }

  if (Number.isFinite(lastMs)) {
    details.lastBackupAt = new Date(lastMs).toISOString();
    details.ageHours = hoursBetween(nowMs, lastMs);
    if (details.ageHours > opts.maxAgeHours) {
      status = bump(status, 'ALERT');
      pushReason(reasons, 'backup_too_old',
        'ageHours=' + details.ageHours.toFixed(2) + ' max=' + opts.maxAgeHours);
    }
    if (lastMs > nowMs + 60 * 1000) {
      status = bump(status, 'ERROR');
      pushReason(reasons, 'last_backup_in_future');
    }
  }

  if (observation.success === false || declaredStatus === 'FAILED') {
    status = bump(status, 'BLOCK');
    pushReason(reasons, 'backup_failed');
  } else if (observation.success != null && typeof observation.success !== 'boolean') {
    status = bump(status, 'ERROR');
    pushReason(reasons, 'invalid_success_flag');
  }

  if (observation.partialSnapshot === true || declaredStatus === 'PARTIAL') {
    status = bump(status, 'ALERT');
    pushReason(reasons, 'partial_snapshot');
  }

  if (observation.manifestPresent === false) {
    status = bump(status, 'BLOCK');
    pushReason(reasons, 'missing_manifest');
  } else if (observation.manifestPresent != null && typeof observation.manifestPresent !== 'boolean') {
    status = bump(status, 'ERROR');
    pushReason(reasons, 'invalid_manifest_flag');
  }

  if (observation.sizeBytes != null) {
    if (typeof observation.sizeBytes !== 'number' || !Number.isFinite(observation.sizeBytes)
        || observation.sizeBytes < 0) {
      status = bump(status, 'ERROR');
      pushReason(reasons, 'invalid_size');
    } else {
      details.sizeBytes = observation.sizeBytes;
      if (observation.sizeBytes < opts.minSizeBytes) {
        status = bump(status, 'ALERT');
        pushReason(reasons, 'size_below_minimum', String(observation.sizeBytes));
      }
    }
  }

  if (observation.checksum != null) {
    if (!isNonEmptyString(observation.checksum)) {
      status = bump(status, 'ALERT');
      pushReason(reasons, 'missing_or_empty_checksum');
    } else if (!/^[a-f0-9]{64}$/i.test(observation.checksum)
        && !/^[a-f0-9]{40}$/i.test(observation.checksum)) {
      status = bump(status, 'ALERT');
      pushReason(reasons, 'checksum_format_unexpected');
    } else {
      details.checksumPresent = true;
    }
  }

  if (observation.destination != null) {
    if (!isNonEmptyString(observation.destination)) {
      status = bump(status, 'ALERT');
      pushReason(reasons, 'empty_destination');
    } else {
      details.destination = String(observation.destination).trim();
    }
  }

  if (observation.durationMs != null) {
    if (typeof observation.durationMs !== 'number' || !Number.isFinite(observation.durationMs)
        || observation.durationMs < 0) {
      status = bump(status, 'ERROR');
      pushReason(reasons, 'invalid_duration');
    } else {
      details.durationMs = observation.durationMs;
      if (observation.durationMs > opts.maxDurationMs) {
        status = bump(status, 'ALERT');
        pushReason(reasons, 'duration_exceeded',
          String(observation.durationMs) + '>' + opts.maxDurationMs);
      }
    }
  }

  if (observation.backupType != null) {
    const type = String(observation.backupType).toLowerCase();
    details.backupType = type;
    if (!KNOWN_BACKUP_TYPES.includes(type)) {
      status = bump(status, 'ALERT');
      pushReason(reasons, 'unknown_backup_type', type);
    }
    if (type === 'auth') {
      if (observation.authHashConfigPresent !== true) {
        status = bump(status, 'BLOCK');
        pushReason(reasons, 'auth_without_hash_config');
      }
    }
    if (type === 'storage') {
      if (observation.storageGenerationPresent !== true) {
        status = bump(status, 'BLOCK');
        pushReason(reasons, 'storage_without_generation');
      }
      if (observation.storageChecksumPresent !== true) {
        status = bump(status, 'BLOCK');
        pushReason(reasons, 'storage_without_checksum');
      }
    }
  }

  if (observation.retention && typeof observation.retention === 'object') {
    const ret = observation.retention;
    if (ret.violation === true) {
      status = bump(status, 'BLOCK');
      pushReason(reasons, 'retention_violation');
    } else if (typeof ret.requiredDays === 'number' && typeof ret.retainedDays === 'number') {
      details.retention = { requiredDays: ret.requiredDays, retainedDays: ret.retainedDays };
      if (ret.retainedDays < ret.requiredDays) {
        status = bump(status, 'BLOCK');
        pushReason(reasons, 'retention_violation',
          'retained=' + ret.retainedDays + ' required=' + ret.requiredDays);
      }
    }
  }

  const drillMs = observation.lastRestoreDrillAt == null || observation.lastRestoreDrillAt === ''
    ? null
    : parseTime(observation.lastRestoreDrillAt);
  if (observation.lastRestoreDrillAt != null && observation.lastRestoreDrillAt !== ''
      && !Number.isFinite(drillMs)) {
    status = bump(status, 'ERROR');
    pushReason(reasons, 'invalid_restore_drill_time');
  } else if (drillMs == null) {
    status = bump(status, 'ALERT');
    pushReason(reasons, 'restore_drill_missing');
  } else {
    details.lastRestoreDrillAt = new Date(drillMs).toISOString();
    details.restoreDrillAgeHours = hoursBetween(nowMs, drillMs);
    if (details.restoreDrillAgeHours > opts.restoreDrillMaxAgeHours) {
      status = bump(status, 'ALERT');
      pushReason(reasons, 'restore_not_drilled_in_time',
        'ageHours=' + details.restoreDrillAgeHours.toFixed(2)
        + ' max=' + opts.restoreDrillMaxAgeHours);
    }
  }

  details.note = 'evaluator_only_no_alert_sent';
  if (!OUTCOMES.includes(status)) status = 'ERROR';

  return Object.freeze({
    status: status,
    reasons: Object.freeze(reasons.slice()),
    details: Object.freeze(details)
  });
}

module.exports = Object.freeze({
  evaluateBackupObservation,
  OUTCOMES,
  DEFAULT_THRESHOLDS,
  KNOWN_BACKUP_TYPES,
  SEVERITY
});
