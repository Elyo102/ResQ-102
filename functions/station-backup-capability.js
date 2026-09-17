'use strict';

// Conservative checks of the already configured database-wide backup policy.
// This is not a restore test, an SLA, or coverage for Auth/Storage/TTL policies.
const PITR_SECONDS = 7 * 86400;
const RETENTION_SECONDS = 98 * 86400;
const MAX_BACKUP_AGE_MS = 48 * 3600000;
const WEEKDAYS = new Set(['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const duration = value => {
  const seconds = typeof value === 'string' && /^\d+(?:\.\d{1,9})?s$/.test(value)
    ? Number(value.slice(0, -1)) : NaN;
  return Number.isFinite(seconds) ? seconds : NaN;
};
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value)
  ? Date.parse(value) : NaN;
const result = (ready, reason) => Object.freeze({ ready, reason });

function createStationBackupCapability({ firestoreApi, projectId, databaseId = '(default)',
  now = Date.now, timeoutMs = 8000 } = {}) {
  if (!firestoreApi || typeof firestoreApi.projects?.databases?.get !== 'function' ||
      typeof firestoreApi.projects?.databases?.backupSchedules?.list !== 'function' ||
      typeof firestoreApi.projects?.locations?.backups?.list !== 'function' ||
      typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId) ||
      databaseId !== '(default)' || typeof now !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
    throw new TypeError('validated backup capability dependencies required');
  }
  const databaseName = `projects/${projectId}/databases/${databaseId}`;
  const databases = firestoreApi.projects.databases;
  const backups = firestoreApi.projects.locations.backups;

  async function readBackupCapability() {
    const at = now();
    if (!Number.isSafeInteger(at) || at <= 0) return result(false, 'invalid-clock');
    const controller = new AbortController();
    let timer;
    const options = { timeout:timeoutMs, retry:false, signal:controller.signal,
      maxContentLength:1024 * 1024 };
    async function read(resource, method, params) {
      if (controller.signal.aborted) throw new Error('backup-read-aborted');
      const response = await resource[method](params, options);
      if (controller.signal.aborted) throw new Error('backup-read-aborted');
      return response?.data;
    }
    // Both list APIs in the pinned SDK are non-paginated. Unexpected partial
    // responses fail closed; no server-side configuration changes are attempted.
    async function inspect() {
      const database = await read(databases, 'get', { name:databaseName });
      if (!object(database) || database.name !== databaseName ||
          typeof database.uid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(database.uid) ||
          typeof database.locationId !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(database.locationId)) {
        return result(false, 'database-identity-unverified');
      }
      if (database.pointInTimeRecoveryEnablement !== 'POINT_IN_TIME_RECOVERY_ENABLED' ||
          !(duration(database.versionRetentionPeriod) >= PITR_SECONDS)) {
        return result(false, 'pitr-policy-unmet');
      }
      const schedulesResponse = await read(databases.backupSchedules, 'list', { parent:databaseName });
      if (!object(schedulesResponse) || schedulesResponse.nextPageToken ||
          !Array.isArray(schedulesResponse.backupSchedules) || schedulesResponse.backupSchedules.length > 32) {
        return result(false, 'schedule-response-unverified');
      }
      let daily = false, weekly = false;
      for (const schedule of schedulesResponse.backupSchedules) {
        if (!object(schedule) || typeof schedule.name !== 'string' ||
            !schedule.name.startsWith(databaseName + '/backupSchedules/') ||
            !/^[A-Za-z0-9_-]+$/.test(schedule.name.slice((databaseName + '/backupSchedules/').length))) {
          return result(false, 'schedule-response-unverified');
        }
        if (!(duration(schedule.retention) >= RETENTION_SECONDS)) continue;
        const hasDaily = object(schedule.dailyRecurrence);
        const hasWeekly = object(schedule.weeklyRecurrence) && WEEKDAYS.has(schedule.weeklyRecurrence.day);
        if (hasDaily && !schedule.weeklyRecurrence) daily = true;
        if (hasWeekly && !schedule.dailyRecurrence) weekly = true;
      }
      if (!daily || !weekly) return result(false, 'schedule-policy-unmet');
      const parent = `projects/${projectId}/locations/${database.locationId}`;
      const response = await read(backups, 'list', { parent });
      if (!object(response) || response.nextPageToken ||
          (response.unreachable != null && (!Array.isArray(response.unreachable) || response.unreachable.length)) ||
          !Array.isArray(response.backups) || response.backups.length > 4096) {
        return result(false, 'backup-response-unverified');
      }
      const ready = response.backups.some(backup => {
        if (!object(backup) || backup.database !== databaseName || backup.databaseUid !== database.uid ||
            backup.state !== 'READY' || typeof backup.name !== 'string' ||
            !backup.name.startsWith(parent + '/backups/') ||
            !/^[A-Za-z0-9_-]+$/.test(backup.name.slice((parent + '/backups/').length))) return false;
        const snapshot = timestamp(backup.snapshotTime), expires = timestamp(backup.expireTime);
        return Number.isFinite(snapshot) && Number.isFinite(expires) && snapshot <= at &&
          at - snapshot <= MAX_BACKUP_AGE_MS && expires > at && expires > snapshot;
      });
      return ready ? result(true, 'database-backup-verified') : result(false, 'recent-ready-backup-missing');
    }
    try {
      return await Promise.race([inspect(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('backup-read-timeout')); }, timeoutMs);
      })]);
    } catch (_) {
      return result(false, 'backup-verification-unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return Object.freeze({ readBackupCapability });
}

module.exports = { createStationBackupCapability };
