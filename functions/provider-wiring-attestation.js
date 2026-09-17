'use strict';

// A receipt for the frozen source snapshot whose provider boundaries were
// tested. It is NOT proof of physical delivery, an authorization mechanism,
// or a substitute for current station/runtime policy. Never regenerate at
// boot/CI: source changes invalidate the previous receipt deliberately.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SOURCES = Object.freeze([
  'index.js', 'station-delivery-fence.js', 'schedule-runtime.js',
  'personal-live-lab.js', 'hr-hours-dispatch.js', 'hr-domain-dispatch.js',
  'mail-delivery-guard.js', 'provider-wiring-attestation.js'
]);
const PROVIDERS = Object.freeze([
  'ordinary-push-and-callout', 'schedule-outbox', 'guard-outbox',
  'personal-live-lab', 'hr-hours', 'hr-domain', 'smtp'
]);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const sameKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => own(value, key));
function hash(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) {
    throw new TypeError('Provider source size/type invalid');
  }
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
function sourceReader(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }

function verifyProviderWiringAttestation({ readText = sourceReader } = {}) {
  try {
    const text = readText('provider-wiring-attestation.json');
    if (typeof text !== 'string' || text.length > 16000) throw Error('receipt-size');
    const receipt = JSON.parse(text);
    if (!sameKeys(receipt, ['schema_version', 'normalization', 'providers', 'sources'])
        || receipt.schema_version !== 1 || receipt.normalization !== 'utf8-lf'
        || !Array.isArray(receipt.providers)
        || JSON.stringify(receipt.providers) !== JSON.stringify(PROVIDERS)
        || !sameKeys(receipt.sources, SOURCES)) throw Error('receipt-shape');
    for (const name of SOURCES) {
      const expected = receipt.sources[name];
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)
          || hash(readText(name)) !== expected) throw Error('source-mismatch');
    }
    return Object.freeze({ valid: true, reason: 'tested-source-receipt-matches' });
  } catch (_) {
    return Object.freeze({ valid: false, reason: 'provider-source-receipt-unavailable-or-stale' });
  }
}

// Produce a CANDIDATE only. The release operator may record it with apply_patch
// after registered boundary tests pass on this same frozen snapshot. This
// function never writes a file and never asserts that tests were executed.
function candidateProviderWiringReceipt({ readText = sourceReader } = {}) {
  return { schema_version: 1, normalization: 'utf8-lf', providers: [...PROVIDERS],
    sources: Object.fromEntries(SOURCES.map(name => [name, hash(readText(name))])) };
}
module.exports = { SOURCES, PROVIDERS, verifyProviderWiringAttestation, candidateProviderWiringReceipt };
