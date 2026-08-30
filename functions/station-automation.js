'use strict';

// 42C-1 · שכבת תזמון רב-תחנתית דקה מעל רצי התחנה הקיימים.
// המודול קובע אילו תחנות להריץ ומבודד כשל בין תחנות. הוא אינו
// קורא נתוני תחנה, אינו כותב ואינו שולח הודעות או דואר.

const CONFIG_PATH = 'config/attendance_shadow_v41';
const STATION_ID_RE = /^[a-z0-9_-]{2,80}$/;
const MAX_STATIONS = 50;
const DEFAULT_BUDGET_MS = 8 * 60 * 1000;
const DEFAULT_RESERVE_MS = 30 * 1000;
const CONFIG_READ_ATTEMPTS = 2;
const CONFIG_RETRY_DELAY_MS = 250;

class StationAutomationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'StationAutomationError';
    this.code = code;
  }
}

function isValidStationId(value) {
  return typeof value === 'string' && STATION_ID_RE.test(value);
}

function assertStationId(value, field) {
  if (!isValidStationId(value)) {
    throw new StationAutomationError('invalid-station',
      'Invalid station identifier for ' + field + '.');
  }
  return value;
}

function normalizeStationIds(raw) {
  const seen = Array.isArray(raw)
    ? Array.from(new Set(raw.map(String)))
    : [];
  const valid = seen.filter(isValidStationId);
  return {
    stationIds: valid.slice(0, MAX_STATIONS),
    rejected: seen.filter(function (sid) { return !isValidStationId(sid); }),
    dropped: valid.slice(MAX_STATIONS)
  };
}

function createStationAutomation(options) {
  const opts = options || {};
  const db = opts.db;
  const now = typeof opts.clock === 'function'
    ? opts.clock
    : function () { return Date.now(); };
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };

  if (!db || typeof db.doc !== 'function') {
    throw new StationAutomationError('missing-db',
      'createStationAutomation requires an injected Firestore instance.');
  }

  async function listStations(input) {
    const args = input || {};
    const pilot = assertStationId(args.pilotStationId, 'pilotStationId');
    let snap = null;
    for (let attempt = 0; attempt < CONFIG_READ_ATTEMPTS; attempt += 1) {
      try {
        snap = await db.doc(CONFIG_PATH).get();
        break;
      } catch (error) {
        if (attempt + 1 >= CONFIG_READ_ATTEMPTS) {
          throw new StationAutomationError('config-unavailable',
            'Station automation configuration is unavailable.');
        }
        try {
          await sleep(CONFIG_RETRY_DELAY_MS);
        } catch (ignore) {
          // A failed delay must not expose its raw error or prevent the
          // bounded second configuration read.
        }
      }
    }
    const value = snap && snap.exists ? (snap.data() || {}) : {};
    const mode = value.mode === 'shadow' ? 'shadow' : 'off';
    const normalized = normalizeStationIds(value.station_ids);

    if (mode !== 'shadow' || normalized.stationIds.length === 0) {
      return {
        mode: mode,
        source: 'pilot',
        stationIds: [pilot],
        rejected: normalized.rejected,
        dropped: [],
        truncated: false
      };
    }

    return {
      mode: mode,
      source: 'config',
      stationIds: normalized.stationIds,
      rejected: normalized.rejected,
      dropped: normalized.dropped,
      truncated: normalized.dropped.length > 0
    };
  }

  async function runAllStations(input) {
    const args = input || {};
    const runStation = args.runStation;
    if (typeof runStation !== 'function') {
      throw new StationAutomationError('missing-runner',
        'runAllStations requires a runStation function.');
    }

    if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      throw new StationAutomationError('missing-timeout',
        'runAllStations requires the function timeout in milliseconds.');
    }

    const reserveMs = Number.isFinite(args.reserveMs) && args.reserveMs >= 0
      ? args.reserveMs
      : DEFAULT_RESERVE_MS;
    const requestedBudgetMs = Number.isFinite(args.budgetMs) && args.budgetMs > 0
      ? args.budgetMs
      : DEFAULT_BUDGET_MS;
    const budgetCeilingMs = Math.max(0, args.timeoutMs - reserveMs);
    const budgetMs = Math.min(requestedBudgetMs, budgetCeilingMs);
    const startedAt = now();
    const deadline = startedAt + budgetMs;
    const budgetClamped = budgetMs < requestedBudgetMs;
    const listing = await listStations(args);
    const results = [];
    const succeeded = [];
    const failed = [];
    const notRun = [];
    let budgetExhausted = false;

    for (const sid of listing.stationIds) {
      if (budgetExhausted || now() >= deadline) {
        budgetExhausted = true;
        notRun.push({ station_id: sid, reason: 'budget_exhausted' });
        results.push({
          station_id: sid,
          outcome: 'not_run',
          reason: 'budget_exhausted'
        });
        continue;
      }

      const stationStartedAt = now();
      try {
        await runStation({ sid: sid, stationId: sid });
        succeeded.push(sid);
        results.push({
          station_id: sid,
          outcome: 'succeeded',
          duration_ms: Math.max(0, now() - stationStartedAt)
        });
      } catch (error) {
        const rawCode = String((error && error.code) || 'internal');
        const code = /^[a-z0-9_-]{1,80}$/.test(rawCode) ? rawCode : 'internal';
        failed.push({ station_id: sid, code: code });
        results.push({
          station_id: sid,
          outcome: 'failed',
          duration_ms: Math.max(0, now() - stationStartedAt),
          code: code
        });
      }
    }

    for (const sid of listing.dropped) {
      notRun.push({ station_id: sid, reason: 'station_cap' });
      results.push({
        station_id: sid,
        outcome: 'not_run',
        reason: 'station_cap'
      });
    }

    const finishedAt = now();
    return {
      mode: listing.mode,
      source: listing.source,
      station_ids: listing.stationIds,
      rejected: listing.rejected,
      truncated: listing.truncated,
      results: results,
      succeeded: succeeded,
      failed: failed,
      not_run: notRun,
      counts: {
        total: listing.stationIds.length + listing.dropped.length,
        succeeded: succeeded.length,
        failed: failed.length,
        not_run: notRun.length
      },
      budget_ms: budgetMs,
      timeout_ms: args.timeoutMs,
      reserve_ms: reserveMs,
      budget_requested_ms: requestedBudgetMs,
      budget_clamped: budgetClamped,
      budget_exhausted: budgetExhausted,
      overrun: finishedAt > deadline,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.max(0, finishedAt - startedAt),
      ok: failed.length === 0 && notRun.length === 0
    };
  }

  return {
    listStations: listStations,
    runAllStations: runAllStations
  };
}

module.exports = {
  CONFIG_PATH: CONFIG_PATH,
  STATION_ID_RE: STATION_ID_RE,
  MAX_STATIONS: MAX_STATIONS,
  DEFAULT_BUDGET_MS: DEFAULT_BUDGET_MS,
  CONFIG_READ_ATTEMPTS: CONFIG_READ_ATTEMPTS,
  CONFIG_RETRY_DELAY_MS: CONFIG_RETRY_DELAY_MS,
  StationAutomationError: StationAutomationError,
  isValidStationId: isValidStationId,
  normalizeStationIds: normalizeStationIds,
  createStationAutomation: createStationAutomation
};
