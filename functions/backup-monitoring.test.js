'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateBackupObservation,
  OUTCOMES,
  DEFAULT_THRESHOLDS
} = require('./backup-monitoring');

const NOW = '2026-09-23T12:00:00.000Z';
const FRESH = '2026-09-23T06:00:00.000Z';
const OLD = '2026-09-20T06:00:00.000Z';
const DRILL_OK = '2026-09-01T12:00:00.000Z';
const DRILL_OLD = '2026-07-01T12:00:00.000Z';
const HASH = 'a'.repeat(64);

function base(extra) {
  return Object.assign({
    lastBackupAt: FRESH,
    success: true,
    sizeBytes: 1024,
    checksum: HASH,
    destination: 'demo-local/_גיבוי/set-1',
    durationMs: 120000,
    backupType: 'firestore',
    manifestPresent: true,
    partialSnapshot: false,
    lastRestoreDrillAt: DRILL_OK,
    status: 'COMPLETED'
  }, extra || {});
}

function codes(result) {
  return result.reasons.map((r) => r.code);
}

test('healthy observation is PASS and never claims alerts are sent', () => {
  const result = evaluateBackupObservation(base(), { now: NOW });
  assert.equal(result.status, 'PASS');
  assert.equal(result.details.note, 'evaluator_only_no_alert_sent');
  assert.ok(OUTCOMES.includes(result.status));
});

test('null observation is ERROR', () => {
  assert.equal(evaluateBackupObservation(null).status, 'ERROR');
  assert.deepEqual(codes(evaluateBackupObservation(undefined)), ['invalid_observation']);
});

test('missing backup is BLOCK', () => {
  const result = evaluateBackupObservation(base({ lastBackupAt: null, missingBackup: true }), { now: NOW });
  assert.equal(result.status, 'BLOCK');
  assert.ok(codes(result).includes('missing_backup'));
});

test('too-old backup is ALERT', () => {
  const result = evaluateBackupObservation(base({ lastBackupAt: OLD }), { now: NOW, maxAgeHours: 24 });
  assert.equal(result.status, 'ALERT');
  assert.ok(codes(result).includes('backup_too_old'));
});

test('failed backup is BLOCK', () => {
  const result = evaluateBackupObservation(base({ success: false }), { now: NOW });
  assert.equal(result.status, 'BLOCK');
  assert.ok(codes(result).includes('backup_failed'));
});

test('partial snapshot is ALERT', () => {
  const result = evaluateBackupObservation(base({ partialSnapshot: true }), { now: NOW });
  assert.equal(result.status, 'ALERT');
  assert.ok(codes(result).includes('partial_snapshot'));
});

test('missing manifest is BLOCK', () => {
  const result = evaluateBackupObservation(base({ manifestPresent: false }), { now: NOW });
  assert.equal(result.status, 'BLOCK');
  assert.ok(codes(result).includes('missing_manifest'));
});

test('size / checksum / destination / duration evaluated', () => {
  assert.ok(codes(evaluateBackupObservation(base({ sizeBytes: 0 }), { now: NOW, minSizeBytes: 1 }))
    .includes('size_below_minimum'));
  assert.ok(codes(evaluateBackupObservation(base({ checksum: '' }), { now: NOW }))
    .includes('missing_or_empty_checksum'));
  assert.ok(codes(evaluateBackupObservation(base({ destination: '   ' }), { now: NOW }))
    .includes('empty_destination'));
  assert.ok(codes(evaluateBackupObservation(base({ durationMs: DEFAULT_THRESHOLDS.maxDurationMs + 1 }), { now: NOW }))
    .includes('duration_exceeded'));
});

test('auth without hash config is BLOCK', () => {
  const result = evaluateBackupObservation(base({
    backupType: 'auth',
    authHashConfigPresent: false
  }), { now: NOW });
  assert.equal(result.status, 'BLOCK');
  assert.ok(codes(result).includes('auth_without_hash_config'));
});

test('storage without generation or checksum is BLOCK', () => {
  const noGen = evaluateBackupObservation(base({
    backupType: 'storage',
    storageGenerationPresent: false,
    storageChecksumPresent: true
  }), { now: NOW });
  assert.equal(noGen.status, 'BLOCK');
  assert.ok(codes(noGen).includes('storage_without_generation'));

  const noSum = evaluateBackupObservation(base({
    backupType: 'storage',
    storageGenerationPresent: true,
    storageChecksumPresent: false
  }), { now: NOW });
  assert.equal(noSum.status, 'BLOCK');
  assert.ok(codes(noSum).includes('storage_without_checksum'));
});

test('retention violation is BLOCK', () => {
  const result = evaluateBackupObservation(base({
    retention: { requiredDays: 30, retainedDays: 7 }
  }), { now: NOW });
  assert.equal(result.status, 'BLOCK');
  assert.ok(codes(result).includes('retention_violation'));
});

test('restore drill missing or overdue is ALERT', () => {
  const missing = evaluateBackupObservation(base({ lastRestoreDrillAt: null }), { now: NOW });
  assert.equal(missing.status, 'ALERT');
  assert.ok(codes(missing).includes('restore_drill_missing'));

  const overdue = evaluateBackupObservation(base({ lastRestoreDrillAt: DRILL_OLD }), {
    now: NOW,
    restoreDrillMaxAgeHours: 24 * 30
  });
  assert.equal(overdue.status, 'ALERT');
  assert.ok(codes(overdue).includes('restore_not_drilled_in_time'));
});

test('invalid typed fields are ERROR', () => {
  assert.equal(evaluateBackupObservation(base({ sizeBytes: -1 }), { now: NOW }).status, 'ERROR');
  assert.equal(evaluateBackupObservation(base({ durationMs: 'slow' }), { now: NOW }).status, 'ERROR');
  assert.equal(evaluateBackupObservation(base({ lastBackupAt: 'not-a-date' }), { now: NOW }).status, 'ERROR');
});

test('module has no firebase-admin / fetch / STATION_ID hard-codes in source', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'backup-monitoring.js'), 'utf8');
  assert.equal(src.includes('firebase-admin'), false);
  assert.equal(src.includes('STATION_ID'), false);
  assert.equal(src.includes("require('firebase"), false);
  assert.equal(src.includes('fetch('), false);
});
