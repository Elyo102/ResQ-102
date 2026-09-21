const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = 'resq_callout_roster_v1:';

function clean(value, max) {
  return String(value == null ? '' : value).normalize('NFC').trim().slice(0, max);
}

export function calloutRosterCacheKey(scope) {
  return CACHE_PREFIX + [scope && scope.uid, scope && scope.sid, scope && scope.crew]
    .map(value => encodeURIComponent(String(value || ''))).join(':');
}

export function readCalloutRosterCache(scope, nowMs = Date.now()) {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return [];
    const key = calloutRosterCacheKey(scope);
    const raw = storage.getItem(key);
    if (!raw) return [];
    const value = JSON.parse(raw);
    const age = Number(nowMs) - Number(value && value.saved_at_ms);
    if (!value || value.schema !== 1 || !Number.isFinite(age) || age < 0 ||
        age > CACHE_TTL_MS || !Array.isArray(value.rows) || value.rows.length > 200) {
      storage.removeItem(key);
      return [];
    }
    const crew = clean(scope && scope.crew, 1);
    return value.rows.filter(row => row && typeof row === 'object').map(row => ({
      uid:clean(row.uid, 128), name:clean(row.name, 120), crew:clean(row.crew, 1)
    })).filter(row => row.uid && row.crew === crew);
  } catch (_) {
    return [];
  }
}

export function writeCalloutRosterCache(scope, rows, nowMs = Date.now()) {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return false;
    const crew = clean(scope && scope.crew, 1);
    const safeRows = (Array.isArray(rows) ? rows : []).slice(0, 200).map(row => ({
      uid:clean(row && row.uid, 128), name:clean(row && row.name, 120), crew:clean(row && row.crew, 1)
    })).filter(row => row.uid && row.crew === crew);
    storage.setItem(calloutRosterCacheKey(scope), JSON.stringify({
      schema:1, saved_at_ms:Number(nowMs), rows:safeRows
    }));
    return true;
  } catch (_) {
    return false;
  }
}

export const CALLOUT_ROSTER_CACHE_TTL_MS = CACHE_TTL_MS;
