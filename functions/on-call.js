'use strict';
// On-call recipients live in top-level config/on_call (client-closed, like
// config/app_check_gate). Shape: { recipients: [{ uid, stationId }], updated_at_ms, updated_by }.
// Alerts (systemHealth, stale heartbeat, dead_letter, incident spikes, stale App Check
// monitor) must fan out to this list — never hard-code Eilat. OFF until OWNER enrolls.
const DOC = 'config/on_call';
function createOnCall(deps) {
  const d = deps || {};
  async function readRecipients() {
    try {
      const snap = await d.db.doc(DOC).get();
      if (!snap.exists) return Object.freeze([]);
      const raw = (snap.data() || {}).recipients;
      return Object.freeze(Array.isArray(raw) ? raw.filter(r => r && r.uid) : []);
    } catch (e) {
      if (d.log) d.log('on_call_unreadable', { code: String((e && e.code) || 'unknown') });
      return Object.freeze([]);
    }
  }
  return Object.freeze({ readRecipients, DOC });
}
module.exports = { createOnCall, DOC };
