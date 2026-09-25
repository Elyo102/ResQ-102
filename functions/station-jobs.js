'use strict';

// Multi-station scheduled-job runner (M5 / GAP3).
//
// Enrollment: client-closed config/station_jobs
//   { enabled_station_ids: string[], updated_at_ms, updated_by }
//
// CRITICAL PORT RULE (GAP3): when enrollment is missing or empty, still run
// the legacy Eilat station (DEFAULT_FALLBACK_STATION_ID = eilat_102) so
// hours/guard/sign reminders keep working until migration+rollback is done.
// Tip behavior (empty => 0 runs) is intentionally NOT ported.
//
// After enrollment is populated and migration verified, operators can remove
// the fallback by setting deps.fallbackStationId to null / ''.

const DOC = 'config/station_jobs';
const ID_RE = /^[a-z0-9_-]{2,80}$/;
const DEFAULT_BATCH = 5;
const DEFAULT_FALLBACK_STATION_ID = 'eilat_102';

function createStationJobs(deps) {
  const d = deps || {};
  if (!d.db) throw new TypeError('station-jobs requires db');
  const log = typeof d.log === 'function' ? d.log : () => {};
  const alert = typeof d.alert === 'function' ? d.alert : (event, fields) => log('alert:' + event, fields);
  const batchSize = Number(d.batchSize) > 0 ? Number(d.batchSize) : DEFAULT_BATCH;
  const fallbackStationId = Object.prototype.hasOwnProperty.call(d, 'fallbackStationId')
    ? (d.fallbackStationId ? String(d.fallbackStationId) : '')
    : DEFAULT_FALLBACK_STATION_ID;

  async function readEnrollment() {
    try {
      const snap = await d.db.doc(DOC).get();
      if (!snap.exists) return Object.freeze({ ids: Object.freeze([]), missing: true });
      const data = snap.data() || {};
      const raw = Array.isArray(data.enabled_station_ids) ? data.enabled_station_ids : [];
      const ids = Object.freeze(raw.map(String).filter((id) => ID_RE.test(id)));
      return Object.freeze({ ids, missing: false, updated_by: data.updated_by || '' });
    } catch (e) {
      log('station_jobs_enrollment_unreadable', { code: String((e && e.code) || 'unknown') });
      return Object.freeze({ ids: Object.freeze([]), missing: true, error: true });
    }
  }

  async function forEachEnabled(jobName, fn, opts) {
    if (typeof jobName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{2,60}$/.test(jobName)) {
      throw new TypeError('jobName required');
    }
    if (typeof fn !== 'function') throw new TypeError('fn required');
    const o = opts || {};
    const enrollment = await readEnrollment();
    let ids = enrollment.ids.slice();
    let usedFallback = false;
    if (enrollment.missing || ids.length === 0) {
      alert('station_jobs_empty_enrollment', {
        job: jobName, missing: !!enrollment.missing, fallback: fallbackStationId || null
      });
      if (fallbackStationId && ID_RE.test(fallbackStationId)) {
        ids = [fallbackStationId];
        usedFallback = true;
        log('station_jobs_using_eilat_fallback', { job: jobName, sid: fallbackStationId });
      } else {
        return Object.freeze({ job: jobName, ran: 0, failed: 0, ids: [], usedFallback: false });
      }
    }
    // During migration the legacy station must keep receiving reminders even
    // if an enrollment document accidentally lists only new stations.
    if (fallbackStationId && ID_RE.test(fallbackStationId) && !ids.includes(fallbackStationId)) {
      ids.unshift(fallbackStationId);
      usedFallback = true;
      alert('station_jobs_legacy_station_added', { job: jobName, sid: fallbackStationId });
    }
    let ran = 0, failed = 0;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      await Promise.all(batch.map(async (sid) => {
        try {
          await fn(sid, { job: jobName, usedFallback });
          ran += 1;
        } catch (e) {
          failed += 1;
          log('station_jobs_station_failed', {
            job: jobName, sid, code: String((e && e.code) || 'unknown'),
            message: String((e && e.message) || '').slice(0, 120)
          });
          if (o.onStationError) {
            try { await o.onStationError(sid, e); } catch (ignore) {}
          }
        }
      }));
    }
    if (failed > 0) {
      alert('station_jobs_failed', { job: jobName, failed, ran });
      throw new Error(jobName + ': ' + failed + ' station job(s) failed');
    }
    return Object.freeze({ job: jobName, ran, failed, ids, usedFallback });
  }

  function createSetEnrollmentHandler(h) {
    return async function setStationJobsEnrollment(req) {
      const actor = await h.requireFreshSuper(req);
      const data = (req && req.data) || {};
      const raw = Array.isArray(data.enabled_station_ids) ? data.enabled_station_ids : null;
      if (!raw) throw new d.HttpsError('invalid-argument', 'enabled_station_ids must be an array.');
      if (raw.length > 200) throw new d.HttpsError('invalid-argument', 'too many stations.');
      const ids = [];
      const seen = new Set();
      for (const value of raw) {
        const id = String(value || '');
        if (!ID_RE.test(id)) throw new d.HttpsError('invalid-argument', 'invalid station id.');
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      const t = Date.now();
      await d.db.doc(DOC).set({
        enabled_station_ids: ids,
        updated_at_ms: t,
        updated_by: actor.uid
      }, { merge: true });
      if (h.audit) await h.audit(actor, 'station_jobs_enrollment', { count: ids.length });
      return { ok: true, count: ids.length };
    };
  }

  return Object.freeze({
    readEnrollment, forEachEnabled, createSetEnrollmentHandler, DOC, ID_RE,
    DEFAULT_FALLBACK_STATION_ID
  });
}

module.exports = { createStationJobs, DOC, ID_RE, DEFAULT_FALLBACK_STATION_ID };
