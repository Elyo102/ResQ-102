'use strict';

// Additional station fence, not a replacement for recipient identity, global
// runtime policy, owner-only lab checks, preferences, or outbox idempotency.
// No provider is called here. Every provider path must invoke this fence using
// a fresh global recipient verdict before this module can protect production.
const DEFAULT_LEGACY_IDS = Object.freeze(['eilat_102']);
const ID_RE = /^[a-z0-9_-]{2,80}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const verdict = (allowed, reason) => Object.freeze({ allowed, reason });

function stationDeliveryDecision({ stationId, exists, station, globalSuppressed,
  legacyStationIds = DEFAULT_LEGACY_IDS } = {}) {
  if (typeof stationId !== 'string' || !ID_RE.test(stationId)) return verdict(false, 'station-id-invalid');
  if (typeof globalSuppressed !== 'boolean') return verdict(false, 'global-state-unavailable');
  if (globalSuppressed) return verdict(false, 'global-silence');
  if (!Array.isArray(legacyStationIds) || legacyStationIds.some(id => typeof id !== 'string' || !ID_RE.test(id))) {
    return verdict(false, 'legacy-policy-invalid');
  }
  const legacy = legacyStationIds.includes(stationId);
  if (exists === false) {
    if (station !== null) return verdict(false, 'station-state-invalid');
    return legacy ? verdict(true, 'legacy-station') : verdict(false, 'station-missing');
  }
  if (exists !== true || !plain(station)) return verdict(false, 'station-state-invalid');
  if (own(station, 'station_id') && station.station_id !== stationId) return verdict(false, 'station-scope-mismatch');
  if (own(station, 'active') && typeof station.active !== 'boolean') return verdict(false, 'station-active-invalid');
  if (station.active === false || station.archived === true) return verdict(false, 'station-inactive');
  if (own(station, 'silent') && typeof station.silent !== 'boolean') return verdict(false, 'station-silence-invalid');

  // Partial markers are not a way to fall back into legacy behaviour.
  const provisioned = own(station, 'template_id') || own(station, 'provision_request_id');
  if (provisioned) {
    if (station.template_id !== 'fire-station-v1'
      || typeof station.provision_request_id !== 'string'
      || !/^[A-Za-z0-9_-]{8,120}$/.test(station.provision_request_id)
      || station.schema_version !== 1 || station.station_id !== stationId
      || typeof station.silent !== 'boolean') return verdict(false, 'provision-state-invalid');
    if (station.status !== 'ready' || station.active !== true) return verdict(false, 'station-not-ready');
  } else {
    if (own(station, 'status') && !['ready', 'active'].includes(station.status)) return verdict(false, 'station-not-ready');
    if (!legacy && station.active !== true) return verdict(false, 'station-active-unavailable');
  }
  // The global recipient allow-list never exempts station-level silence.
  if (station.silent === true) return verdict(false, 'station-silence');
  return verdict(true, provisioned ? 'ready-station' : 'legacy-station');
}

function createStationDeliveryFence({ db, legacyStationIds = DEFAULT_LEGACY_IDS } = {}) {
  if (!db || typeof db.doc !== 'function') throw new TypeError('Station delivery fence requires db.doc.');
  if (!Array.isArray(legacyStationIds) || legacyStationIds.some(id => typeof id !== 'string' || !ID_RE.test(id))) {
    throw new TypeError('Station delivery fence requires explicit valid legacy IDs.');
  }
  const legacyIds = Object.freeze([...legacyStationIds]);
  async function check({ stationId, globalSuppressed, tx } = {}) {
    if (typeof stationId !== 'string' || !ID_RE.test(stationId)) return verdict(false, 'station-id-invalid');
    if (typeof globalSuppressed !== 'boolean') return verdict(false, 'global-state-unavailable');
    if (globalSuppressed) return verdict(false, 'global-silence');
    try {
      if (tx !== undefined && (!tx || typeof tx.get !== 'function')) return verdict(false, 'station-reader-invalid');
      const ref = db.doc('stations/' + stationId);
      const snap = tx ? await tx.get(ref) : await ref.get();
      if (!snap || typeof snap.exists !== 'boolean' || (snap.exists && typeof snap.data !== 'function')) {
        return verdict(false, 'station-state-invalid');
      }
      return stationDeliveryDecision({ stationId, exists: snap.exists,
        station: snap.exists ? snap.data() : null, globalSuppressed,
        legacyStationIds: legacyIds });
    } catch (_) {
      // A read failure is NOT a missing document, even for the legacy station.
      return verdict(false, 'station-state-unavailable');
    }
  }
  return Object.freeze({ check });
}

module.exports = Object.freeze({ DEFAULT_LEGACY_IDS, stationDeliveryDecision, createStationDeliveryFence });
