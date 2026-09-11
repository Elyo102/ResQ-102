'use strict';

const diagnosisCore = require('./maintenance-diagnosis');

const DEFAULT_TIMEOUT_MS = 8_000;

function createMaintenanceAiService(deps) {
  const value = deps || {};
  if (typeof value.invokeModel !== 'function') {
    throw new TypeError('invokeModel port is required');
  }
  const timeoutMs = Number.isSafeInteger(value.timeout_ms)
    && value.timeout_ms >= 100 && value.timeout_ms <= 30_000
    ? value.timeout_ms : DEFAULT_TIMEOUT_MS;
  const scheduleTimeout = typeof value.scheduleTimeout === 'function'
    ? value.scheduleTimeout : setTimeout;
  const cancelTimeout = typeof value.cancelTimeout === 'function'
    ? value.cancelTimeout : clearTimeout;

  async function bounded(promise, controller) {
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = scheduleTimeout(() => {
        controller.abort();
        reject(new Error('AI_TIMEOUT'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      if (timer !== null) cancelTimeout(timer);
    }
  }

  function fallback(diagnosis, reason) {
    return Object.freeze({
      source: 'deterministic',
      reason,
      diagnosis
    });
  }

  async function advise(input) {
    const enabled = input && input.enabled === true;
    const diagnosis = input && input.diagnosis;
    let request;
    try {
      request = diagnosisCore.buildAiAdvisoryRequest(diagnosis);
    } catch (_) {
      throw new TypeError('valid deterministic diagnosis is required');
    }
    if (!enabled) return fallback(diagnosis, 'AI_DISABLED');

    try {
      const controller = new AbortController();
      const response = await bounded(
        value.invokeModel(Object.freeze({
          request,
          schema: diagnosisCore.buildAiAdvisorySchema(),
          timeout_ms: timeoutMs,
          signal: controller.signal
        })),
        controller
      );
      const advisory = diagnosisCore.validateAiAdvisory(request, response);
      return Object.freeze({ source: 'ai', reason: 'AI_VALIDATED', diagnosis, advisory });
    } catch (_) {
      return fallback(diagnosis, 'AI_UNAVAILABLE_OR_INVALID');
    }
  }

  return Object.freeze({ advise });
}

module.exports = Object.freeze({ createMaintenanceAiService, DEFAULT_TIMEOUT_MS });
