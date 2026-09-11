'use strict';

// Canonical station-id contract shared with index.js.
const STATION_ID_RE = /^[a-z0-9_-]{2,80}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{12,128}$/;
const FINDING_CODE_RE = /^[A-Z0-9_]{2,80}$/;
const LEVELS = Object.freeze(['stop', 'warn', 'info']);
const VERDICT = Object.freeze({
  ALL_CLEAR: 'all_clear',
  FINDINGS: 'findings',
  PARTIAL: 'partial',
  EMPTY: 'empty',
  RESTART_REQUIRED: 'restart_required',
  INVALID: 'invalid',
  BUDGET_EXHAUSTED: 'budget_exhausted'
});

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Non-cryptographic change detector only. Exact equality is authoritative.
function inventoryFingerprint(ids) {
  const text = JSON.stringify(ids);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function normalizeStations(stations) {
  if (!Array.isArray(stations)) throw new TypeError('stations must be an array');
  const seen = new Set();
  const rows = stations.map((item, index) => {
    if (!plain(item)) throw new TypeError('station must be an object at ' + index);
    const stationId = String(item.station_id || '');
    if (!STATION_ID_RE.test(stationId)) throw new TypeError('invalid station_id at ' + index);
    if (seen.has(stationId)) throw new TypeError('duplicate station: ' + stationId);
    seen.add(stationId);
    return { station_id: stationId, silent: item.silent === true };
  });
  rows.sort((a, b) => a.station_id.localeCompare(b.station_id, 'en'));
  return rows;
}

function sameInventory(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function silence(globalSilent, stationSilent) {
  const global = globalSilent === true;
  const station = stationSilent === true;
  return Object.freeze({
    silent: global || station,
    reason: global && station ? 'global+station' : global ? 'global' : station ? 'station' : null
  });
}

function openCycle(input) {
  const value = input || {};
  const runId = String(value.run_id || '');
  if (!RUN_ID_RE.test(runId)) throw new TypeError('run_id must be unique and valid');
  const rows = normalizeStations(value.stations);
  const inventory = rows.map((row) => row.station_id);
  return Object.freeze({
    schema_version: 2,
    cycle_id: runId,
    inventory: Object.freeze(inventory),
    inventory_fingerprint: inventoryFingerprint(inventory),
    total: inventory.length
  });
}

function validateCycle(cycle) {
  if (!plain(cycle) || cycle.schema_version !== 2 || !RUN_ID_RE.test(String(cycle.cycle_id || ''))
      || !Array.isArray(cycle.inventory) || !Number.isSafeInteger(cycle.total)
      || cycle.total !== cycle.inventory.length) {
    throw new TypeError('invalid cycle');
  }
  const rows = normalizeStations(cycle.inventory.map((stationId) => ({ station_id: stationId })));
  const ids = rows.map((row) => row.station_id);
  if (!sameInventory(ids, cycle.inventory)
      || inventoryFingerprint(ids) !== cycle.inventory_fingerprint) {
    throw new TypeError('inconsistent cycle');
  }
  return cycle;
}

function inventoryMatches(cycle, stations) {
  validateCycle(cycle);
  const ids = normalizeStations(stations).map((row) => row.station_id);
  return sameInventory(cycle.inventory, ids);
}

function planPage(cycle, input) {
  validateCycle(cycle);
  const value = input || {};
  const budgetMs = value.budget_ms;
  const perStationMs = value.per_station_ms;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new TypeError('invalid budget_ms');
  if (!Number.isFinite(perStationMs) || perStationMs <= 0) throw new TypeError('invalid per_station_ms');
  if (!Array.isArray(value.stations_now)) throw new TypeError('stations_now is required');
  if (!inventoryMatches(cycle, value.stations_now)) {
    return Object.freeze({ verdict: VERDICT.RESTART_REQUIRED, cycle_id: cycle.cycle_id,
      scan: Object.freeze([]), next_cursor: null, page_is_last: false, budget_exhausted: false });
  }
  if (!cycle.total) throw new TypeError('empty cycle cannot be paged');

  const currentRows = normalizeStations(value.stations_now);
  const currentById = new Map(currentRows.map((row) => [row.station_id, row]));
  const cursor = value.cursor == null ? null : String(value.cursor);
  let from = 0;
  if (cursor !== null) {
    if (!STATION_ID_RE.test(cursor)) throw new TypeError('invalid cursor');
    const at = cycle.inventory.indexOf(cursor);
    if (at < 0) throw new TypeError('cursor is not in cycle inventory');
    from = at + 1;
    if (from >= cycle.total) throw new TypeError('cursor has no continuation');
  }

  const capacity = Math.floor(budgetMs / perStationMs);
  if (capacity < 1) {
    return Object.freeze({ verdict: VERDICT.BUDGET_EXHAUSTED, cycle_id: cycle.cycle_id,
      scan: Object.freeze([]), next_cursor: cursor, page_is_last: false, budget_exhausted: true });
  }
  const ids = cycle.inventory.slice(from, Math.min(cycle.total, from + capacity));
  const scan = ids.map((stationId) => {
    const row = currentById.get(stationId);
    const state = silence(value.global_silent, row && row.silent);
    return Object.freeze({ station_id: stationId, silent: state.silent, silence_reason: state.reason });
  });
  const pageIsLast = from + scan.length >= cycle.total;
  return Object.freeze({
    verdict: null,
    cycle_id: cycle.cycle_id,
    scan: Object.freeze(scan),
    next_cursor: pageIsLast ? null : scan[scan.length - 1].station_id,
    page_is_last: pageIsLast,
    budget_exhausted: false
  });
}

function validFinding(value) {
  return plain(value) && LEVELS.includes(value.level)
    && FINDING_CODE_RE.test(String(value.code || ''))
    && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 200
    && typeof value.detail === 'string' && value.detail.length <= 2000;
}

function summarizeCycle(cycle, reports, options) {
  validateCycle(cycle);
  if (!Array.isArray(reports)) throw new TypeError('reports must be an array');
  const opts = options || {};
  if (!Array.isArray(opts.stations_now)) throw new TypeError('stations_now is required');
  const base = { cycle_id: cycle.cycle_id, total: cycle.total };
  if (!inventoryMatches(cycle, opts.stations_now)) {
    return Object.freeze(Object.assign({}, base, { verdict: VERDICT.RESTART_REQUIRED,
      findings: 0, reported: 0, missing: Object.freeze([]), rejected: Object.freeze([]) }));
  }
  if (!cycle.total) {
    return Object.freeze(Object.assign({}, base, { verdict: VERDICT.EMPTY,
      findings: 0, reported: 0, missing: Object.freeze([]), rejected: Object.freeze([]) }));
  }

  const inventory = new Set(cycle.inventory);
  const accepted = new Map();
  const rejected = [];
  let findings = 0;
  reports.forEach((item, at) => {
    const row = plain(item) ? item : {};
    const stationId = String(row.station_id || '');
    let reason = null;
    if (row.cycle_id !== cycle.cycle_id) reason = 'cycle-mismatch';
    else if (!inventory.has(stationId)) reason = 'not-in-inventory';
    else if (accepted.has(stationId)) reason = 'duplicate';
    else if (row.ok !== true) reason = 'scan-incomplete';
    else if (!Array.isArray(row.findings) || !row.findings.every(validFinding)) reason = 'invalid-findings';
    if (reason) { rejected.push(Object.freeze({ at, station_id: stationId, reason })); return; }
    accepted.set(stationId, row.findings.length);
    findings += row.findings.length;
  });
  const missing = cycle.inventory.filter((stationId) => !accepted.has(stationId));
  const verdict = missing.length ? VERDICT.PARTIAL
    : rejected.length ? VERDICT.INVALID
      : findings ? VERDICT.FINDINGS : VERDICT.ALL_CLEAR;
  return Object.freeze(Object.assign({}, base, {
    verdict,
    findings,
    reported: accepted.size,
    missing: Object.freeze(missing),
    rejected: Object.freeze(rejected)
  }));
}

module.exports = Object.freeze({
  VERDICT, STATION_ID_RE, RUN_ID_RE, FINDING_CODE_RE, LEVELS,
  inventoryFingerprint, normalizeStations, sameInventory, silence,
  openCycle, validateCycle, inventoryMatches, planPage, validFinding, summarizeCycle
});
