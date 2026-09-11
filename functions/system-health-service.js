'use strict';

const scope = require('./health-scope');

const DEFAULT_RESERVE_MS = 45_000;
const DEFAULT_PER_STATION_MS = 5_000;

function requirePort(value, name) {
  if (typeof value !== 'function') throw new TypeError(name + ' port is required');
  return value;
}

function createSystemHealthService(deps) {
  const value = deps || {};
  const clock = requirePort(value.clock, 'clock');
  const listStations = requirePort(value.listStations, 'listStations');
  const readGlobalSilent = requirePort(value.readGlobalSilent, 'readGlobalSilent');
  const readStationSilent = requirePort(value.readStationSilent, 'readStationSilent');
  const claimCycle = requirePort(value.claimCycle, 'claimCycle');
  const saveGlobal = requirePort(value.saveGlobal, 'saveGlobal');
  const scanGlobal = requirePort(value.scanGlobal, 'scanGlobal');
  const scanStation = requirePort(value.scanStation, 'scanStation');
  const saveReport = requirePort(value.saveReport, 'saveReport');
  const checkpoint = requirePort(value.checkpoint, 'checkpoint');
  const readReports = requirePort(value.readReports, 'readReports');
  const finishCycle = requirePort(value.finishCycle, 'finishCycle');
  const publishComplete = requirePort(value.publishComplete, 'publishComplete');
  const releaseCycle = requirePort(value.releaseCycle, 'releaseCycle');
  const reserveMs = Number.isFinite(value.reserve_ms) ? value.reserve_ms : DEFAULT_RESERVE_MS;
  const perStationMs = Number.isFinite(value.per_station_ms) ? value.per_station_ms : DEFAULT_PER_STATION_MS;

  async function run(input) {
    const options = input || {};
    const runId = String(options.run_id || '');
    const deadlineMs = options.deadline_ms;
    if (!scope.RUN_ID_RE.test(runId)) throw new TypeError('invalid run_id');
    if (!Number.isFinite(deadlineMs) || deadlineMs <= clock()) throw new TypeError('invalid deadline_ms');

    const initial = await listStations({ deadline_ms: deadlineMs });
    if (!initial || initial.complete !== true || !Array.isArray(initial.stations)) {
      const error = new Error('health-inventory-incomplete');
      error.code = 'health-inventory-incomplete';
      throw error;
    }
    const cycle = scope.openCycle({ run_id: runId, stations: initial.stations });
    const lease = await claimCycle({ cycle, deadline_ms: deadlineMs });
    if (lease && lease.completed === true && lease.summary) {
      return Object.freeze({ ...lease.summary, published: lease.published === true, resumed: true });
    }
    if (!lease || lease.acquired !== true) {
      return Object.freeze({ cycle_id: runId, verdict: 'already-running', published: false });
    }

    let cursor = null;
    let globalFindings = Array.isArray(lease.global_findings) ? lease.global_findings : [];
    try {
      if (!globalFindings.every(scope.validFinding)) throw new TypeError('invalid stored global findings');
      if (lease.global_complete !== true) {
        globalFindings = await scanGlobal({ cycle_id: runId, lease_token: lease.lease_token,
          deadline_ms: deadlineMs });
        if (!Array.isArray(globalFindings) || !globalFindings.every(scope.validFinding)) {
          throw new TypeError('invalid global findings');
        }
        await saveGlobal({ cycle_id: runId, lease_token: lease.lease_token,
          findings: globalFindings, deadline_ms: deadlineMs });
      }

      let reports = await readReports({ cycle_id: runId, deadline_ms: deadlineMs });
      const successful = new Set(reports.filter((report) => report && report.cycle_id === runId
        && report.ok === true && Array.isArray(report.findings)
        && report.findings.every(scope.validFinding)).map((report) => report.station_id));
      const lastStation = cycle.inventory[cycle.inventory.length - 1] || null;
      while (cursor !== lastStation && clock() < deadlineMs - reserveMs) {
        const current = await listStations({ deadline_ms: deadlineMs });
        if (!current || current.complete !== true || !Array.isArray(current.stations)
            || !scope.inventoryMatches(cycle, current.stations)) {
          const summary = { cycle_id: runId, verdict: scope.VERDICT.RESTART_REQUIRED,
            findings: 0, reported: 0, missing: [], rejected: [] };
          await finishCycle({ cycle, lease_token: lease.lease_token, summary, deadline_ms: deadlineMs });
          return Object.freeze({ ...summary, published: false });
        }
        const globalSilent = await readGlobalSilent({ deadline_ms: deadlineMs });
        const remaining = Math.max(0, deadlineMs - reserveMs - clock());
        const page = scope.planPage(cycle, {
          cursor,
          stations_now: current.stations,
          global_silent: globalSilent === true,
          budget_ms: remaining,
          per_station_ms: perStationMs
        });
        if (page.verdict === scope.VERDICT.BUDGET_EXHAUSTED) break;
        if (page.verdict === scope.VERDICT.RESTART_REQUIRED) {
          const summary = { cycle_id: runId, verdict: scope.VERDICT.RESTART_REQUIRED,
            findings: 0, reported: 0, missing: [], rejected: [] };
          await finishCycle({ cycle, lease_token: lease.lease_token, summary, deadline_ms: deadlineMs });
          return Object.freeze({ ...summary, published: false });
        }
        for (const station of page.scan) {
          if (clock() >= deadlineMs - reserveMs) break;
          cursor = station.station_id;
          if (successful.has(station.station_id)) continue;
          let result;
          try {
            const stationSilent = await readStationSilent({ station_id: station.station_id,
              deadline_ms: deadlineMs - reserveMs });
            const silence = scope.silence(globalSilent === true, stationSilent === true);
            const scanTarget = { station_id: station.station_id, silent: silence.silent,
              silence_reason: silence.reason };
            const findings = await scanStation({ cycle_id: runId, station: scanTarget,
              deadline_ms: deadlineMs - reserveMs });
            result = { cycle_id: runId, station_id: station.station_id,
              ok: Array.isArray(findings) && findings.every(scope.validFinding),
              findings: Array.isArray(findings) ? findings : [],
              silent: silence.silent,
              silence_reason: silence.reason,
              error_code: Array.isArray(findings) ? null : 'invalid-findings' };
          } catch (error) {
            result = { cycle_id: runId, station_id: station.station_id, ok: false,
              findings: [], silent: station.silent === true,
              silence_reason: station.silence_reason || null,
              error_code: String(error && error.code || 'scan-failed').slice(0, 80) };
          }
          await saveReport({ cycle_id: runId, lease_token: lease.lease_token,
            report: result, deadline_ms: deadlineMs });
          if (result.ok === true) successful.add(station.station_id);
          await checkpoint({ cycle_id: runId, lease_token: lease.lease_token,
            cursor, deadline_ms: deadlineMs });
        }
        if (page.page_is_last && cursor === page.scan[page.scan.length - 1].station_id) break;
        if (!page.scan.length) break;
      }

      const finalInventory = await listStations({ deadline_ms: deadlineMs });
      reports = await readReports({ cycle_id: runId, deadline_ms: deadlineMs });
      let summary;
      if (!finalInventory || finalInventory.complete !== true || !Array.isArray(finalInventory.stations)) {
        summary = { cycle_id: runId, verdict: scope.VERDICT.PARTIAL,
          findings: 0, reported: 0, missing: cycle.inventory.slice(), rejected: [] };
      } else {
        summary = scope.summarizeCycle(cycle, reports, { stations_now: finalInventory.stations });
        const globalCount = globalFindings.length;
        summary = Object.freeze({ ...summary,
          verdict: summary.verdict === scope.VERDICT.ALL_CLEAR && globalCount
            ? scope.VERDICT.FINDINGS : summary.verdict,
          findings: summary.findings + globalCount,
          global_findings: globalCount });
      }
      const conclusive = summary.verdict === scope.VERDICT.ALL_CLEAR || summary.verdict === scope.VERDICT.FINDINGS;
      if (conclusive) {
        await publishComplete({ cycle, lease_token: lease.lease_token, summary,
          reports, deadline_ms: deadlineMs });
      }
      await finishCycle({ cycle, lease_token: lease.lease_token, summary, deadline_ms: deadlineMs });
      if (!conclusive && summary.verdict === scope.VERDICT.PARTIAL) {
        const error = new Error('health-cycle-partial');
        error.code = 'health-cycle-partial';
        throw error;
      }
      return Object.freeze({ ...summary, published: conclusive });
    } finally {
      await releaseCycle({ cycle_id: runId, lease_token: lease.lease_token }).catch(() => {});
    }
  }

  return Object.freeze({ run });
}

module.exports = Object.freeze({
  createSystemHealthService,
  DEFAULT_RESERVE_MS,
  DEFAULT_PER_STATION_MS
});
