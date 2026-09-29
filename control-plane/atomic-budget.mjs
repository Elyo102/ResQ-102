// Isolated Firestore REST adapter. No credentials, HTTP or provider calls here.
// serverNow MUST come from a fresh authenticated server readTime, not Date.now.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const BUDGET_PROJECT = 'resq-agent-control-20260928';
export const BUDGET_ROOT = `projects/${BUDGET_PROJECT}/databases/(default)/documents/`;
export const POLICY_PATH = 'resq_budget_state/policy';
export const CAP_MICRO_USD = 20_000_000;
const CHARGE = 250_000, MAX_BYTES = 60_000, MAX_OUTPUT = 2200;
const TTL_MS = 20_000, BLACKOUT_MS = 120_000;
const providers = ['Claude', 'Grok', 'Gemini'];
const hash = /^[a-f0-9]{64}$/;
const plain = v => v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = code => { throw new Error(code); };
function keys(value, expected) {
  if (!plain(value) || Reflect.ownKeys(value).length !== expected.length
      || expected.some(k => !Object.hasOwn(value, k))) fail('BUDGET_INVALID_DATA');
}
function value(field, type) { keys(field, [type]); return field[type]; }
function integer(field) {
  const raw = value(field, 'integerValue');
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) fail('BUDGET_INVALID_DATA');
  const n = Number(raw); if (!Number.isSafeInteger(n)) fail('BUDGET_INVALID_DATA'); return n;
}
function string(field) { const s = value(field, 'stringValue'); if (typeof s !== 'string') fail('BUDGET_INVALID_DATA'); return s; }
function timestamp(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(raw)) fail('BUDGET_INVALID_DATA');
  const n = Date.parse(raw); if (!Number.isSafeInteger(n) || n < 0) fail('BUDGET_INVALID_DATA'); return n;
}
function instant(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 253402300799999) fail('BUDGET_INVALID_CLOCK');
  return n;
}
function monthAt(at) {
  const d = new Date(instant(at)), year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
  const next = new Date(at); next.setUTCDate(1); next.setUTCHours(0, 0, 0, 0); next.setUTCMonth(next.getUTCMonth() + 1);
  if (next.getTime() - at <= BLACKOUT_MS) fail('BUDGET_MONTH_BLACKOUT');
  return { year, month, monthId: `month_${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}` };
}
function document(doc, path) {
  if (!plain(doc) || doc.name !== BUDGET_ROOT + path || !plain(doc.fields)) fail('BUDGET_INVALID_DATA');
  timestamp(doc.updateTime); return doc.fields;
}
function policy(doc) {
  const f = document(doc, POLICY_PATH);
  keys(f, ['enabled', 'version', 'chargeMicroUsd', 'maxBytes', 'maxOutputTokens', 'models']);
  const enabled = value(f.enabled, 'booleanValue');
  if (typeof enabled !== 'boolean') fail('BUDGET_INVALID_DATA');
  if (!enabled) fail('BUDGET_DISABLED');
  const version = string(f.version);
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(version) || integer(f.chargeMicroUsd) !== CHARGE
      || integer(f.maxBytes) !== MAX_BYTES || integer(f.maxOutputTokens) !== MAX_OUTPUT) fail('BUDGET_INVALID_POLICY');
  const map = value(f.models, 'mapValue'); keys(map, ['fields']); keys(map.fields, providers);
  const models = Object.fromEntries(providers.map(p => {
    const model = string(map.fields[p]); if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(model)) fail('BUDGET_INVALID_POLICY');
    return [p, model];
  }));
  return { version, models };
}
function pinRequest(input) {
  keys(input, ['id', 'provider', 'model', 'requestDigest', 'requestBody', 'maxOutputTokens']);
  const d = Object.getOwnPropertyDescriptors(input);
  if (Object.values(d).some(x => !Object.hasOwn(x, 'value'))) fail('BUDGET_INVALID_REQUEST');
  const r = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value]));
  if (typeof r.id !== 'string' || typeof r.requestDigest !== 'string' || !hash.test(r.id) || !hash.test(r.requestDigest) || !providers.includes(r.provider)
      || typeof r.model !== 'string' || typeof r.requestBody !== 'string'
      || !Number.isSafeInteger(r.maxOutputTokens) || r.maxOutputTokens < 1 || r.maxOutputTokens > MAX_OUTPUT) fail('BUDGET_INVALID_REQUEST');
  const inputBytes = Buffer.byteLength(r.requestBody, 'utf8');
  if (inputBytes < 1 || inputBytes > MAX_BYTES
      || createHash('sha256').update(r.requestBody).digest('hex') !== r.requestDigest) fail('BUDGET_INVALID_REQUEST');
  return Object.freeze({ ...r, inputBytes });
}
const s = stringValue => ({ stringValue });
const i = n => ({ integerValue: String(n) });

export function createAtomicBudget({ transport, monotonic = () => performance.now() } = {}) {
  if (!transport || ['get', 'commit', 'serverNow'].some(k => typeof transport[k] !== 'function')
      || typeof monotonic !== 'function') fail('BUDGET_TRANSPORT_REQUIRED');
  const permits = new WeakMap();
  const mono = () => { const n = monotonic(); if (!Number.isFinite(n) || n < 0) fail('BUDGET_INVALID_CLOCK'); return n; };
  async function get(path) {
    try { const result = await transport.get(path); if (result === undefined) fail('BUDGET_INVALID_DATA'); return result; } catch (e) { if (e?.status === 404) return null; fail('BUDGET_READ_FAILED'); }
  }
  function estimated(sample) {
    const elapsed = mono() - sample.started;
    if (elapsed < 0) fail('BUDGET_INVALID_CLOCK');
    // Count the complete sampling round trip conservatively toward expiry.
    return sample.server + Math.ceil(elapsed);
  }
  function live(sample, expiresAt, monthId) {
    const at = estimated(sample);
    if (at >= expiresAt) fail('BUDGET_PERMIT_EXPIRED');
    if (monthAt(at).monthId !== monthId) fail('BUDGET_PERMIT_EXPIRED');
  }
  return Object.freeze({
    async reserveRequest(input) {
      const r = pinRequest(input);
      let pDoc, opDoc;
      const opPath = `${POLICY_PATH}/operations/${r.id}`;
      [pDoc, opDoc] = await Promise.all([get(POLICY_PATH), get(opPath)]);
      if (!pDoc) fail('BUDGET_POLICY_MISSING');
      const p = policy(pDoc);
      if (p.models[r.provider] !== r.model) fail('BUDGET_MODEL_DENIED');
      if (opDoc !== null && opDoc !== undefined) {
        const f = document(opDoc, opPath);
        keys(f, ['provider', 'model', 'policyVersion', 'requestDigest', 'chargedMicroUsd', 'year', 'month', 'monthId', 'createdAt', 'expiresAt', 'inputBytes', 'maxOutputTokens']);
        const yr = integer(f.year), mo = integer(f.month);
        if (mo < 1 || mo > 12 || yr < 1970 || yr > 9999
            || string(f.monthId) !== `month_${yr}-${String(mo).padStart(2, '0')}`
            || integer(f.chargedMicroUsd) !== CHARGE
            || timestamp(value(f.expiresAt, 'timestampValue')) <= timestamp(value(f.createdAt, 'timestampValue'))) fail('BUDGET_INVALID_DATA');
        if (string(f.provider) !== r.provider || string(f.model) !== r.model || string(f.policyVersion) !== p.version
            || string(f.requestDigest) !== r.requestDigest || integer(f.inputBytes) !== r.inputBytes
            || integer(f.maxOutputTokens) !== r.maxOutputTokens) fail('BUDGET_RESERVATION_CONFLICT');
        return Object.freeze({ dispatch: false, id: r.id, requestDigest: r.requestDigest, reason: 'ALREADY_RESERVED' });
      }
      const started = mono();
      let server; try { server = instant(await transport.serverNow()); } catch { fail('BUDGET_SERVER_TIME_UNAVAILABLE'); }
      const sample = { started, server };
      const scope = monthAt(estimated(sample));
      const expiresAt = server + TTL_MS;
      const monthPath = `resq_budget_state/${scope.monthId}`;
      const monthDoc = await get(monthPath);
      if (!monthDoc) fail('BUDGET_MONTH_MISSING');
      const f = document(monthDoc, monthPath);
      keys(f, ['year', 'month', 'chargedMicroUsd', 'lastOperationId']);
      const charged = integer(f.chargedMicroUsd), last = string(f.lastOperationId);
      if (integer(f.year) !== scope.year || integer(f.month) !== scope.month
          || charged > CAP_MICRO_USD || charged % CHARGE !== 0
          || (charged === 0 ? last !== '' : !hash.test(last))) fail('BUDGET_INVALID_DATA');
      if (charged > CAP_MICRO_USD - CHARGE) fail('BUDGET_CAP_REACHED');
      live(sample, expiresAt, scope.monthId);
      const fields = { provider: s(r.provider), model: s(r.model), policyVersion: s(p.version), requestDigest: s(r.requestDigest),
        chargedMicroUsd: i(CHARGE), year: i(scope.year), month: i(scope.month), monthId: s(scope.monthId),
        expiresAt: { timestampValue: new Date(expiresAt).toISOString() }, inputBytes: i(r.inputBytes), maxOutputTokens: i(r.maxOutputTokens) };
      const writes = [
        { update: { name: BUDGET_ROOT + monthPath, fields: { chargedMicroUsd: i(charged + CHARGE), lastOperationId: s(r.id) } },
          updateMask: { fieldPaths: ['chargedMicroUsd', 'lastOperationId'] }, currentDocument: { updateTime: monthDoc.updateTime } },
        { update: { name: BUDGET_ROOT + opPath, fields }, currentDocument: { exists: false },
          updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }] }
      ];
      let committed;
      try { committed = await transport.commit(writes); } catch { fail('BUDGET_COMMIT_UNKNOWN'); }
      if (!plain(committed) || !Array.isArray(committed.writeResults) || committed.writeResults.length !== 2) fail('BUDGET_COMMIT_UNKNOWN');
      let commitAt; try { commitAt = timestamp(committed.commitTime); } catch { fail('BUDGET_COMMIT_UNKNOWN'); }
      if (commitAt < server || commitAt >= expiresAt || monthAt(commitAt).monthId !== scope.monthId) fail('BUDGET_COMMIT_UNKNOWN');
      live(sample, expiresAt, scope.monthId);
      const permit = Object.freeze({ dispatch: true, id: r.id, requestDigest: r.requestDigest, expiresAtMs: expiresAt });
      permits.set(permit, { sample, expiresAt, monthId: scope.monthId });
      return permit;
    },
    assertDispatch(permit) {
      const info = permits.get(permit);
      if (!info) fail('BUDGET_PERMIT_INVALID');
      permits.delete(permit); // A failed/expired check can never be tried again.
      live(info.sample, info.expiresAt, info.monthId);
      return true;
    }
  });
}
