'use strict';

// Pure advisory core. It has no database, network, shell, deployment or write port.
// Product adapters must translate telemetry into this finite vocabulary before use.
const crypto = require('node:crypto');

const SOURCES = Object.freeze(['incident', 'health']);
const INCIDENT_CODES = Object.freeze([
  'CLIENT_AUTH_DENIED',
  'CALLABLE_UNAVAILABLE',
  'CALLABLE_DEADLINE',
  'RESOURCE_EXHAUSTED',
  'DATA_LOSS',
  'CLIENT_RUNTIME_ERROR',
  'UNHANDLED_REJECTION'
]);
const HEALTH_CODES = Object.freeze([
  'MAIL_DELIVERY_FAILURES',
  'RUNTIME_SILENT_MODE',
  'SNAPSHOT_DATA_LOSS',
  'SCHEDULED_TASK_SILENT',
  'ORPHAN_EMPLOYEE_INDEX',
  'DOCUMENT_SIZE_WARNING',
  'COLLECTION_GROWTH_WARNING',
  'HEALTH_CHECK_STALE',
  'BACKUP_QUARANTINED'
]);
const SIGNAL_CODES = Object.freeze([...INCIDENT_CODES, ...HEALTH_CODES]);
const SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
const STATES = Object.freeze(['OBSERVE', 'SUGGEST']);
const RUNBOOK_CODES = Object.freeze([
  'ESCALATE_DATA_INTEGRITY_MANUAL',
  'REVIEW_BACKUP_QUARANTINE',
  'REVIEW_RUNTIME_MODE',
  'REVIEW_SCHEDULER_EXECUTION',
  'REVIEW_CAPACITY',
  'CHECK_SERVICE_AVAILABILITY',
  'REVIEW_AUTH_CONFIGURATION',
  'REVIEW_MAIL_QUEUE',
  'REBUILD_EMPLOYEE_INDEX_DRY_RUN',
  'REVIEW_DOCUMENT_SIZES',
  'REVIEW_COLLECTION_GROWTH',
  'MONITOR_CLIENT_ERRORS',
  'WAIT_AND_RECHECK'
]);
const ASSESSMENT_CODES = Object.freeze([
  'DATA_INTEGRITY_RISK', 'BACKUP_REQUIRES_REVIEW', 'SCHEDULER_REQUIRES_REVIEW',
  'CAPACITY_PRESSURE', 'SERVICE_DEGRADED', 'AUTH_CONFIGURATION_REVIEW',
  'MAIL_QUEUE_REVIEW', 'EMPLOYEE_INDEX_REVIEW', 'DOCUMENT_SIZE_REVIEW',
  'COLLECTION_GROWTH_REVIEW', 'CLIENT_STABILITY_REVIEW', 'NO_ACTIONABLE_FINDING'
]);
const CONFIDENCE_CODES = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);
const SIGNAL_FIELDS = Object.freeze(['source', 'code', 'count', 'age_minutes']);
const ROOT_FIELDS = Object.freeze(['signals']);
const MAX_SIGNALS = 64;
const MAX_COUNT = 1_000_000;
const MAX_AGE_MINUTES = 525_600;
const AI_POLICY = Object.freeze({
  daily_limit: 20,
  cooldown_ms: 15 * 60 * 1000,
  failure_threshold: 3,
  circuit_reset_ms: 60 * 60 * 1000
});
const BREAKER_STATES = Object.freeze(['CLOSED', 'OPEN', 'HALF_OPEN']);
const OUTCOMES = Object.freeze(['SUCCESS', 'FAILURE']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const RULES = Object.freeze({
  DATA_LOSS: ['P0', 'SUGGEST', 'ESCALATE_DATA_INTEGRITY_MANUAL', 'DATA_INTEGRITY_RISK'],
  SNAPSHOT_DATA_LOSS: ['P0', 'SUGGEST', 'ESCALATE_DATA_INTEGRITY_MANUAL', 'DATA_INTEGRITY_RISK'],
  RUNTIME_SILENT_MODE: ['P0', 'SUGGEST', 'REVIEW_RUNTIME_MODE', 'SERVICE_DEGRADED'],
  BACKUP_QUARANTINED: ['P1', 'SUGGEST', 'REVIEW_BACKUP_QUARANTINE', 'BACKUP_REQUIRES_REVIEW'],
  SCHEDULED_TASK_SILENT: ['P1', 'SUGGEST', 'REVIEW_SCHEDULER_EXECUTION', 'SCHEDULER_REQUIRES_REVIEW'],
  RESOURCE_EXHAUSTED: ['P1', 'SUGGEST', 'REVIEW_CAPACITY', 'CAPACITY_PRESSURE'],
  CALLABLE_UNAVAILABLE: ['P2', 'SUGGEST', 'CHECK_SERVICE_AVAILABILITY', 'SERVICE_DEGRADED'],
  CALLABLE_DEADLINE: ['P2', 'SUGGEST', 'CHECK_SERVICE_AVAILABILITY', 'SERVICE_DEGRADED'],
  CLIENT_AUTH_DENIED: ['P2', 'SUGGEST', 'REVIEW_AUTH_CONFIGURATION', 'AUTH_CONFIGURATION_REVIEW'],
  MAIL_DELIVERY_FAILURES: ['P2', 'SUGGEST', 'REVIEW_MAIL_QUEUE', 'MAIL_QUEUE_REVIEW'],
  ORPHAN_EMPLOYEE_INDEX: ['P2', 'SUGGEST', 'REBUILD_EMPLOYEE_INDEX_DRY_RUN', 'EMPLOYEE_INDEX_REVIEW'],
  DOCUMENT_SIZE_WARNING: ['P2', 'SUGGEST', 'REVIEW_DOCUMENT_SIZES', 'DOCUMENT_SIZE_REVIEW'],
  COLLECTION_GROWTH_WARNING: ['P2', 'SUGGEST', 'REVIEW_COLLECTION_GROWTH', 'COLLECTION_GROWTH_REVIEW'],
  HEALTH_CHECK_STALE: ['P2', 'SUGGEST', 'WAIT_AND_RECHECK', 'SERVICE_DEGRADED'],
  CLIENT_RUNTIME_ERROR: ['P3', 'OBSERVE', 'MONITOR_CLIENT_ERRORS', 'CLIENT_STABILITY_REVIEW'],
  UNHANDLED_REJECTION: ['P3', 'OBSERVE', 'MONITOR_CLIENT_ERRORS', 'CLIENT_STABILITY_REVIEW']
});

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, allowed) {
  return plain(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function safeInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError('invalid ' + label);
  }
  return value;
}
function sourceAllows(source, code) {
  return source === 'incident' ? INCIDENT_CODES.includes(code) : HEALTH_CODES.includes(code);
}
function validDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeEvidence(input) {
  if (!exactKeys(input, ROOT_FIELDS) || Object.keys(input).length !== 1
      || !Array.isArray(input.signals) || input.signals.length > MAX_SIGNALS) {
    throw new TypeError('invalid maintenance evidence envelope');
  }
  const merged = new Map();
  for (const signal of input.signals) {
    if (!exactKeys(signal, SIGNAL_FIELDS) || Object.keys(signal).length !== SIGNAL_FIELDS.length
        || !SOURCES.includes(signal.source) || !SIGNAL_CODES.includes(signal.code)
        || !sourceAllows(signal.source, signal.code)) {
      throw new TypeError('invalid maintenance signal');
    }
    const count = safeInteger(signal.count, 0, MAX_COUNT, 'signal count');
    const age = safeInteger(signal.age_minutes, 0, MAX_AGE_MINUTES, 'signal age');
    const key = signal.source + ':' + signal.code;
    const old = merged.get(key);
    merged.set(key, Object.freeze({
      source: signal.source,
      code: signal.code,
      count: Math.min(MAX_COUNT, count + (old ? old.count : 0)),
      age_minutes: Math.min(age, old ? old.age_minutes : age)
    }));
  }
  return Object.freeze([...merged.values()].sort((a, b) =>
    a.source.localeCompare(b.source) || a.code.localeCompare(b.code)));
}

function evidenceFingerprint(evidence) {
  if (!Array.isArray(evidence)) throw new TypeError('normalized evidence is required');
  const verified = normalizeEvidence({ signals: evidence });
  if (JSON.stringify(verified) !== JSON.stringify(evidence)) {
    throw new TypeError('normalized evidence is required');
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(['maintenance-evidence-v1', evidence]))
    .digest('hex');
}

function diagnoseMaintenance(input) {
  const evidence = normalizeEvidence(input);
  const active = evidence.filter((row) => row.count > 0);
  const ranked = active.map((row) => ({ row, rule: RULES[row.code] }))
    .sort((a, b) => SEVERITIES.indexOf(a.rule[0]) - SEVERITIES.indexOf(b.rule[0])
      || a.row.code.localeCompare(b.row.code));
  const primary = ranked[0];
  const result = primary ? {
    schema_version: 1,
    fingerprint: evidenceFingerprint(evidence),
    severity: primary.rule[0],
    state: primary.rule[1],
    assessment_code: primary.rule[3],
    runbook_codes: Object.freeze([...new Set(ranked.map((item) => item.rule[2]))].slice(0, 8)),
    evidence
  } : {
    schema_version: 1,
    fingerprint: evidenceFingerprint(evidence),
    severity: 'P3',
    state: 'OBSERVE',
    assessment_code: 'NO_ACTIONABLE_FINDING',
    runbook_codes: Object.freeze(['WAIT_AND_RECHECK']),
    evidence
  };
  return Object.freeze(result);
}

function validInvocationState(state) {
  return exactKeys(state, ['day', 'used_today', 'last_invoked_ms', 'breaker'])
    && validDay(state.day)
    && Number.isSafeInteger(state.used_today) && state.used_today >= 0
    && (state.last_invoked_ms === null || (Number.isSafeInteger(state.last_invoked_ms) && state.last_invoked_ms >= 0))
    && exactKeys(state.breaker, ['state', 'failures', 'opened_at_ms'])
    && BREAKER_STATES.includes(state.breaker.state)
    && Number.isSafeInteger(state.breaker.failures) && state.breaker.failures >= 0
    && (state.breaker.opened_at_ms === null
      || (Number.isSafeInteger(state.breaker.opened_at_ms) && state.breaker.opened_at_ms >= 0));
}

function planAiInvocation(options) {
  if (!exactKeys(options, ['now_ms', 'day', 'state']) || !validDay(options.day)
      || !Number.isSafeInteger(options.now_ms) || options.now_ms < 0
      || !validInvocationState(options.state)) throw new TypeError('invalid AI invocation state');
  const sameDay = options.state.day === options.day;
  const used = sameDay ? options.state.used_today : 0;
  const last = sameDay ? options.state.last_invoked_ms : null;
  const breaker = options.state.breaker;
  if (used >= AI_POLICY.daily_limit) return Object.freeze({ allowed: false, reason: 'DAILY_BUDGET_EXHAUSTED' });
  if (breaker.state === 'OPEN') {
    if (breaker.opened_at_ms === null || options.now_ms - breaker.opened_at_ms < AI_POLICY.circuit_reset_ms) {
      return Object.freeze({ allowed: false, reason: 'CIRCUIT_OPEN' });
    }
    return Object.freeze({ allowed: true, reason: 'HALF_OPEN_PROBE', next_breaker_state: 'HALF_OPEN' });
  }
  if (breaker.state === 'HALF_OPEN') return Object.freeze({ allowed: false, reason: 'HALF_OPEN_PROBE_IN_FLIGHT' });
  if (last !== null && options.now_ms - last < AI_POLICY.cooldown_ms) {
    return Object.freeze({ allowed: false, reason: 'COOLDOWN' });
  }
  return Object.freeze({ allowed: true, reason: 'READY', next_breaker_state: 'CLOSED' });
}

function planAiOutcome(options) {
  if (!exactKeys(options, ['now_ms', 'breaker', 'outcome'])
      || !Number.isSafeInteger(options.now_ms) || options.now_ms < 0
      || !exactKeys(options.breaker, ['state', 'failures', 'opened_at_ms'])
      || !BREAKER_STATES.includes(options.breaker.state)
      || !Number.isSafeInteger(options.breaker.failures) || options.breaker.failures < 0
      || (options.breaker.opened_at_ms !== null
        && (!Number.isSafeInteger(options.breaker.opened_at_ms) || options.breaker.opened_at_ms < 0))
      || !OUTCOMES.includes(options.outcome)) throw new TypeError('invalid AI outcome');
  if (options.outcome === 'SUCCESS') {
    return Object.freeze({ state: 'CLOSED', failures: 0, opened_at_ms: null });
  }
  const failures = Math.min(Number.MAX_SAFE_INTEGER, options.breaker.failures + 1);
  return failures >= AI_POLICY.failure_threshold
    ? Object.freeze({ state: 'OPEN', failures, opened_at_ms: options.now_ms })
    : Object.freeze({ state: 'CLOSED', failures, opened_at_ms: null });
}

function buildAiAdvisorySchema() {
  return Object.freeze({
    type: 'object', additionalProperties: false,
    required: ['schema_version', 'fingerprint', 'assessment_code', 'severity', 'state',
      'runbook_codes', 'confidence', 'evidence_codes'],
    properties: Object.freeze({
      schema_version: Object.freeze({ type: 'integer', const: 1 }),
      fingerprint: Object.freeze({ type: 'string', pattern: '^[a-f0-9]{64}$' }),
      assessment_code: Object.freeze({ type: 'string', enum: ASSESSMENT_CODES }),
      severity: Object.freeze({ type: 'string', enum: SEVERITIES }),
      state: Object.freeze({ type: 'string', enum: STATES }),
      runbook_codes: Object.freeze({ type: 'array', minItems: 1, maxItems: 8, uniqueItems: true,
        items: Object.freeze({ type: 'string', enum: RUNBOOK_CODES }) }),
      confidence: Object.freeze({ type: 'string', enum: CONFIDENCE_CODES }),
      evidence_codes: Object.freeze({ type: 'array', maxItems: MAX_SIGNALS, uniqueItems: true,
        items: Object.freeze({ type: 'string', enum: SIGNAL_CODES }) })
    })
  });
}

function buildAiAdvisoryRequest(diagnosis) {
  if (!plain(diagnosis) || diagnosis.schema_version !== 1
      || typeof diagnosis.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(diagnosis.fingerprint)
      || !SEVERITIES.includes(diagnosis.severity) || !STATES.includes(diagnosis.state)
      || !ASSESSMENT_CODES.includes(diagnosis.assessment_code)
      || !Array.isArray(diagnosis.runbook_codes) || diagnosis.runbook_codes.length < 1
      || diagnosis.runbook_codes.length > 8
      || diagnosis.runbook_codes.some((code) => !RUNBOOK_CODES.includes(code))
      || !Array.isArray(diagnosis.evidence)) throw new TypeError('invalid diagnosis');
  const evidence = normalizeEvidence({ signals: diagnosis.evidence }).map((row) => Object.freeze({
    source: row.source, code: row.code, count: row.count, age_minutes: row.age_minutes
  }));
  if (evidenceFingerprint(evidence) !== diagnosis.fingerprint) throw new TypeError('invalid diagnosis fingerprint');
  // No prose, identity, URL, stack, employee data or arbitrary instruction is included.
  return Object.freeze({
    schema_version: 1,
    fingerprint: diagnosis.fingerprint,
    deterministic_assessment_code: diagnosis.assessment_code,
    deterministic_severity: diagnosis.severity,
    allowed_states: STATES,
    allowed_runbook_codes: diagnosis.runbook_codes,
    evidence: Object.freeze(evidence)
  });
}

module.exports = Object.freeze({
  SOURCES, INCIDENT_CODES, HEALTH_CODES, SIGNAL_CODES, SEVERITIES, STATES,
  RUNBOOK_CODES, ASSESSMENT_CODES, CONFIDENCE_CODES, AI_POLICY,
  normalizeEvidence, evidenceFingerprint, diagnoseMaintenance,
  planAiInvocation, planAiOutcome, buildAiAdvisorySchema, buildAiAdvisoryRequest
});
