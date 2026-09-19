'use strict';
/* יעד כתיבה למונים היומיים — הפשטה אחת, שני מימושים.
 *
 * הממשק: { write(aggregateKey, shard, increments, options), readDaily(day, filters),
 *          listExpired(nowMs, limit), remove(aggregateKey) }.
 *
 * - `createFakeMetricsSink()` — זיכרון בלבד, לבדיקות.
 * - `createFirestoreMetricsSink({ db, fieldIncrement, serverTimestamp })` — Firestore.
 *
 * אין כאן שירות אנליטיקה חיצוני. הנתונים הם מונים בלבד, ללא זהות.
 *
 * מבנה ב-Firestore:
 *   metrics_daily/{day}__{event_code}__{release}__{station_hash}        — מסמך אב (מטא-נתונים, expires_at)
 *   metrics_daily/{...}/shards/{0..7}                                    — מונים: count, ok, fail, bucket_<ms>
 * מסמך האב נכתב פעם אחת (ב-`options.isNew`), כדי שיהיה ניתן לשאול לפי יום
 * ולמחוק לפי תפוגה; המונים עצמם מתפזרים על פני 8 shards.
 */

const SHARD_COUNT = 8;
const COLLECTION = 'metrics_daily';
const SHARDS = 'shards';
const KEY_RE = /^\d{4}-\d{2}-\d{2}__[a-z_]{1,40}__[A-Za-z0-9.]{1,24}__[a-f0-9]{64}$/;
const COUNTER_RE = /^(?:count|ok|fail|bucket_\d{1,5})$/;

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function assertKey(aggregateKey) {
  if (typeof aggregateKey !== 'string' || !KEY_RE.test(aggregateKey)) throw new TypeError('invalid aggregate key');
}
function assertShard(shard) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= SHARD_COUNT) throw new TypeError('invalid shard');
}
function assertIncrements(increments) {
  if (!plain(increments) || !Object.keys(increments).length) throw new TypeError('increments required');
  for (const k of Object.keys(increments)) {
    if (!COUNTER_RE.test(k) || !Number.isSafeInteger(increments[k]) || increments[k] < 0) throw new TypeError('invalid increment ' + k);
  }
}
function assertMeta(meta) {
  if (!plain(meta)) throw new TypeError('meta required for a new aggregate');
  for (const k of ['day', 'event_code', 'release', 'station_hash', 'organization_hash']) {
    if (typeof meta[k] !== 'string' || !meta[k]) throw new TypeError('meta.' + k + ' required');
  }
  if (typeof meta.keyed !== 'boolean') throw new TypeError('meta.keyed required');
  if (!(meta.expires_at instanceof Date) || Number.isNaN(meta.expires_at.getTime())) throw new TypeError('meta.expires_at required');
}
function parseKey(aggregateKey) {
  const [day, event_code, release, station_hash] = aggregateKey.split('__');
  return { day, event_code, release, station_hash };
}
function matchesFilters(meta, filters) {
  const f = plain(filters) ? filters : {};
  if (f.event_code && meta.event_code !== f.event_code) return false;
  if (f.release && meta.release !== f.release) return false;
  if (f.station_hash && meta.station_hash !== f.station_hash) return false;
  return true;
}

/* ---------- זיכרון ---------- */
function createFakeMetricsSink() {
  const aggregates = new Map(); // key -> { meta, shards: Map(shard -> counters) }
  const stats = { writes: 0, reads: 0, removes: 0 };
  let failReads = false;
  function write(aggregateKey, shard, increments, options) {
    assertKey(aggregateKey); assertShard(shard); assertIncrements(increments);
    const o = plain(options) ? options : {};
    let row = aggregates.get(aggregateKey);
    if (!row) {
      assertMeta(o.meta);
      row = { meta: Object.assign({}, o.meta), shards: new Map() };
      aggregates.set(aggregateKey, row);
      stats.writes += 1;
    }
    const counters = row.shards.get(shard) || {};
    for (const k of Object.keys(increments)) counters[k] = (counters[k] || 0) + increments[k];
    row.shards.set(shard, counters);
    stats.writes += 1;
  }
  async function readDaily(day, filters) {
    stats.reads += 1;
    if (failReads) throw new Error('sink read failed');
    const out = [];
    for (const [key, row] of aggregates) {
      if (row.meta.day !== day || !matchesFilters(row.meta, filters)) continue;
      out.push({ key, meta: Object.assign({}, row.meta), shards: [...row.shards.values()].map((c) => Object.assign({}, c)) });
    }
    return out;
  }
  async function listExpired(nowMs, limit) {
    const out = [];
    for (const [key, row] of aggregates) {
      if (row.meta.expires_at.getTime() <= nowMs) out.push(key);
      if (out.length >= limit) break;
    }
    return out;
  }
  async function remove(aggregateKey) { assertKey(aggregateKey); if (aggregates.delete(aggregateKey)) stats.removes += 1; }
  return Object.freeze({
    write, readDaily, listExpired, remove, stats,
    _size: () => aggregates.size, _get: (key) => aggregates.get(key) || null,
    _setFailReads: (v) => { failReads = v === true; }
  });
}

/* ---------- Firestore ---------- */
function createFirestoreMetricsSink(deps) {
  const d = plain(deps) ? deps : {};
  if (!d.db || typeof d.db.collection !== 'function' || typeof d.fieldIncrement !== 'function' || typeof d.serverTimestamp !== 'function') {
    throw new TypeError('db, fieldIncrement and serverTimestamp are required');
  }
  const { db, fieldIncrement, serverTimestamp } = d;
  const parentRef = (key) => db.collection(COLLECTION).doc(key);
  const shardRef = (key, shard) => parentRef(key).collection(SHARDS).doc(String(shard));
  /* בתוך טרנזקציה (options.tx) הכתיבה מצטרפת לכתיבות המכסה והפעולה — אטומי. */
  function write(aggregateKey, shard, increments, options) {
    assertKey(aggregateKey); assertShard(shard); assertIncrements(increments);
    const o = plain(options) ? options : {};
    const setter = o.tx ? (ref, v, opt) => o.tx.set(ref, v, opt) : (ref, v, opt) => ref.set(v, opt);
    if (o.isNew === true) {
      assertMeta(o.meta);
      setter(parentRef(aggregateKey), {
        day: o.meta.day, event_code: o.meta.event_code, release: o.meta.release,
        station_hash: o.meta.station_hash, organization_hash: o.meta.organization_hash,
        keyed: o.meta.keyed, expires_at: o.meta.expires_at, created_at: serverTimestamp()
      }, { merge: true });
    }
    const patch = {};
    for (const k of Object.keys(increments)) patch[k] = fieldIncrement(increments[k]);
    patch.updated_at = serverTimestamp();
    setter(shardRef(aggregateKey, shard), patch, { merge: true });
  }
  async function readDaily(day, filters) {
    let q = db.collection(COLLECTION).where('day', '==', day);
    const f = plain(filters) ? filters : {};
    if (f.event_code) q = q.where('event_code', '==', f.event_code);
    if (f.release) q = q.where('release', '==', f.release);
    if (f.station_hash) q = q.where('station_hash', '==', f.station_hash);
    const snap = await q.limit(2000).get();
    const out = [];
    for (const doc of snap.docs) {
      const meta = doc.data() || {};
      const shardsSnap = await parentRef(doc.id).collection(SHARDS).get();
      out.push({
        key: doc.id,
        meta: { day: String(meta.day || ''), event_code: String(meta.event_code || ''), release: String(meta.release || ''),
          station_hash: String(meta.station_hash || ''), organization_hash: String(meta.organization_hash || 'none'),
          keyed: meta.keyed === true, expires_at: meta.expires_at && meta.expires_at.toDate ? meta.expires_at.toDate() : new Date(0) },
        shards: shardsSnap.docs.map((s) => {
          const data = s.data() || {}; const counters = {};
          for (const k of Object.keys(data)) if (COUNTER_RE.test(k) && Number.isSafeInteger(data[k])) counters[k] = data[k];
          return counters;
        })
      });
    }
    return out;
  }
  async function listExpired(nowMs, limit) {
    const snap = await db.collection(COLLECTION).where('expires_at', '<=', new Date(nowMs)).limit(limit).get();
    return snap.docs.map((doc) => doc.id);
  }
  async function remove(aggregateKey) {
    assertKey(aggregateKey);
    const shardsSnap = await parentRef(aggregateKey).collection(SHARDS).get();
    const batch = db.batch();
    for (const s of shardsSnap.docs) batch.delete(s.ref);
    batch.delete(parentRef(aggregateKey));
    await batch.commit();
  }
  return Object.freeze({ write, readDaily, listExpired, remove });
}

module.exports = Object.freeze({
  SHARD_COUNT, COLLECTION, SHARDS, KEY_RE, parseKey, createFakeMetricsSink, createFirestoreMetricsSink
});
