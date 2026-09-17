'use strict';

// Pre-SMTP policy checks only. This does not introduce a delivery lease or
// guarantee exactly-once SMTP delivery after an ambiguous provider response.
const crypto = require('node:crypto');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const result = (allowed, reason, retryable = false, terminal = false) =>
  Object.freeze({ allowed, reason, retryable, terminal });

function createMailDeliveryGuard({ runtimeFresh, stationFence, normalizeRecipients }) {
  if (typeof runtimeFresh !== 'function' || typeof stationFence?.check !== 'function'
      || typeof normalizeRecipients !== 'function') throw new TypeError('Mail guard dependencies required');

  function capture(job) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new TypeError('Mail job required');
    const scoped = own(job, 'station_id');
    const scope = scoped ? job.station_id : null;
    const recipients = ['to', 'cc', 'bcc'].map(key => normalizeRecipients(job[key]));
    const envelope = JSON.stringify([scoped, scope, ...recipients, job.message || {}]);
    return Object.freeze({ scoped, scope, recipients: Object.freeze(recipients.flat()),
      digest: crypto.createHash('sha256').update(envelope).digest('hex') });
  }

  async function check({ original, current }) {
    if (!current) return result(false, 'mail-job-missing', false, true);
    if (['SUCCESS', 'SUPPRESSED', 'ERROR'].includes(current.delivery?.state)) {
      return result(false, 'mail-job-terminal', false, true);
    }
    let now;
    try { now = capture(current); } catch (_) { return result(false, 'mail-envelope-invalid'); }
    if (!original || original.digest !== now.digest || original.scoped !== now.scoped
        || original.scope !== now.scope) return result(false, 'mail-envelope-changed');
    if (!original.scoped) return result(true, 'platform-mail');
    if (typeof original.scope !== 'string' || !/^[a-z0-9_-]{2,80}$/.test(original.scope)) {
      return result(false, 'mail-station-invalid');
    }
    let runtime;
    try { runtime = await runtimeFresh(); }
    catch (_) { return result(false, 'mail-policy-unavailable', true); }
    if (!runtime || typeof runtime.silent !== 'boolean'
        || (runtime.silent && !Array.isArray(runtime.silent_allow))) {
      return result(false, 'mail-policy-unavailable', true);
    }
    const allow = new Set((Array.isArray(runtime.silent_allow) ? runtime.silent_allow : [])
      .map(value => String(value || '').toLowerCase()));
    const globalSuppressed = runtime.silent === true && !original.recipients.every(
      recipient => allow.has(String(recipient).toLowerCase()));
    let verdict;
    try { verdict = await stationFence.check({ stationId: original.scope, globalSuppressed }); }
    catch (_) { return result(false, 'mail-policy-unavailable', true); }
    if (verdict?.allowed === true) return result(true, 'station-mail');
    if (['global-silence', 'station-silence', 'station-inactive', 'station-not-ready'].includes(verdict?.reason)) {
      return result(false, 'mail-policy-suppressed');
    }
    return result(false, 'mail-policy-unavailable', true);
  }
  return Object.freeze({ capture, check });
}
module.exports = { createMailDeliveryGuard };
