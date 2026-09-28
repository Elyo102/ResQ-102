// Contract only. Production must inject ONE durable, atomic ledger shared by
// every provider/caller, plus trusted pricing and a server clock. No API calls.
export const MONTHLY_CAP_MICRO_USD = 20_000_000;
const validId = value => typeof value === 'string' && /^[\w.:-]{1,100}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);
const fail = code => { throw new Error(code); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const plain = value => value && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value));
function validateLedger(state) {
  if (!plain(state) || state.schema !== 1 || !plain(state.months) || !plain(state.operations)
    || !Number.isSafeInteger(state.lastAt) || state.lastAt < 0 || typeof state.blocked !== 'boolean') fail('INVALID_LEDGER');
  for (const [month, used] of Object.entries(state.months)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isSafeInteger(used) || used < 0 || used > MONTHLY_CAP_MICRO_USD) fail('INVALID_LEDGER');
  }
  const totals = Object.create(null);
  for (const [id, operation] of Object.entries(state.operations)) {
    if (!validId(id) || !plain(operation) || typeof operation.fingerprint !== 'string'
      || !Object.hasOwn(state.months, operation.month) || !positive(operation.reserved)
      || operation.reserved > MONTHLY_CAP_MICRO_USD || typeof operation.settled !== 'boolean'
      || (operation.settled && (!Number.isSafeInteger(operation.actual) || operation.actual < 0))) fail('INVALID_LEDGER');
    totals[operation.month] = (totals[operation.month] ?? 0) + operation.reserved;
    if (!Number.isSafeInteger(totals[operation.month])) fail('INVALID_LEDGER');
  }
  for (const [month, used] of Object.entries(state.months)) if (used !== (totals[month] ?? 0)) fail('INVALID_LEDGER');
}

export function createBudgetGate({ store, now = Date.now } = {}) {
  if (!store || typeof store.transaction !== 'function') fail('DURABLE_STORE_REQUIRED');
  function clock() {
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(new Date(at).getTime())) fail('INVALID_CLOCK');
    return { at, month: new Date(at).toISOString().slice(0, 7) };
  }
  // transaction callback MUST commit state + result atomically. It must never
  // execute a provider call: storage SDKs can retry this callback themselves.
  return Object.freeze({
    async reserve(input) {
      if (!input || !validId(input.id) || !['Claude','Grok','Gemini'].includes(input.provider)
        || !validId(input.model) || !validId(input.priceVersion) || !positive(input.worstCaseMicroUsd)
        || input.worstCaseMicroUsd > MONTHLY_CAP_MICRO_USD) fail('INVALID_RESERVATION');
      const request = Object.freeze({ id: input.id, provider: input.provider, model: input.model,
        priceVersion: input.priceVersion, worstCaseMicroUsd: input.worstCaseMicroUsd });
      const fingerprint = JSON.stringify(request);
      return store.transaction(state => {
        const { at, month } = clock();
        validateLedger(state);
        if (at < state.lastAt) fail('CLOCK_ROLLBACK');
        if (state.blocked) fail('BUDGET_BLOCKED');
        const previous = Object.hasOwn(state.operations, request.id) ? state.operations[request.id] : undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail('RESERVATION_CONFLICT');
          return { dispatch: false, reason: 'ALREADY_RESERVED' };
        }
        const used = Object.hasOwn(state.months, month) ? state.months[month] : 0;
        if (!Number.isSafeInteger(used) || used < 0) fail('INVALID_LEDGER');
        if (used > MONTHLY_CAP_MICRO_USD - request.worstCaseMicroUsd) fail('MONTHLY_CAP_REACHED');
        state.lastAt = at;
        state.months[month] = used + request.worstCaseMicroUsd;
        state.operations[request.id] = { fingerprint, month, reserved: request.worstCaseMicroUsd, settled: false };
        // Lost response => reservation stays charged; caller must NOT retry API.
        return { dispatch: true, month, reserved: request.worstCaseMicroUsd };
      });
    },
    async settle(id, actualMicroUsd) {
      if (!validId(id) || !Number.isSafeInteger(actualMicroUsd) || actualMicroUsd < 0) fail('INVALID_SETTLEMENT');
      return store.transaction(state => {
        const { at } = clock();
        validateLedger(state);
        if (at < state.lastAt) fail('CLOCK_ROLLBACK');
        const operation = Object.hasOwn(state.operations, id) ? state.operations[id] : undefined;
        if (!operation) fail('UNKNOWN_RESERVATION');
        if (operation.settled) {
          if (operation.actual !== actualMicroUsd) fail('SETTLEMENT_CONFLICT');
          return { settled: true, blocked: state.blocked === true };
        }
        state.lastAt = at;
        operation.settled = true;
        operation.actual = actualMicroUsd;
        // Conservative: never refund. Inaccurate pricing halts ALL providers.
        if (actualMicroUsd > operation.reserved) state.blocked = true;
        return { settled: true, blocked: state.blocked === true };
      });
    }
  });
}

export function emptyBudgetLedger() {
  return { schema: 1, lastAt: 0, months: Object.create(null), operations: Object.create(null), blocked: false };
}
