'use strict';
/* שירות מדדים תפעוליים — קליטה, צבירה יומית, לוח מחוונים למנהל-על, ניקוי.
 *
 * עקרונות:
 * - התחנה נקבעת מה-claims החיים של החשבון בלבד; גוף הבקשה שמכיל תחנה — נדחה.
 * - תחנה, ארגון ו-UID נשמרים כגיבוב בלבד. עם מפתח (RESQ_METRICS_HASH_KEY)
 *   זה HMAC; בלי מפתח זה sha256 רגיל, ואז כל צבירה נושאת `keyed:false` והלוח
 *   מציג "פסאודונים, הפיך במנייה". השכבה אינה טוענת לאנונימיות.
 * - מכסה: 60 קריאות ליום לכל חשבון. מגבלת קרדינליות: עד 60 צבירות חדשות
 *   ליום לכל תחנה. שתיהן נספרות במסמכי `metrics_quota`.
 * - חזרה (replay): אותו request_id עם אותו גוף — `duplicate:true` ללא כתיבה;
 *   גוף אחר — `already-exists` / `request-conflict`.
 * - כל הכתיבות של קריאה אחת (מכסות, רשומת פעולה, מונים) — בטרנזקציה אחת.
 */

const crypto = require('node:crypto');
const catalog = require('./metrics-catalog');
const { SHARD_COUNT } = require('./metrics-sink');

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS_PER_CALL = 20;
const MAX_CALLS_PER_UID_PER_DAY = 60;
const MAX_AGGREGATES_PER_DAY_PER_STATION = 15 * 4;
const MAX_DASHBOARD_DAYS = 30;
const DEFAULT_DASHBOARD_DAYS = 7;
const PRUNE_BATCH = 200;
const REQUEST_ID_RE = /^rd_[a-f0-9]{40}$/;
const STATION_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const OPERATION_SCHEMA = 1;
const SCOPE_PREFIX = 'metrics-scope-v1|';

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** גיבוב היקף: HMAC-SHA256 עם מפתח, או sha256 רגיל בלי מפתח (keyed:false). */
function createScopeHasher(hashKey) {
  const key = typeof hashKey === 'string' ? hashKey : '';
  const keyed = key.length >= 16;
  function hashScope(id) {
    const input = SCOPE_PREFIX + String(id);
    return keyed
      ? crypto.createHmac('sha256', key).update(input, 'utf8').digest('hex')
      : crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  }
  return Object.freeze({ hashScope, keyed });
}

/** טביעת אצבע קנונית של רשימת מאורעות מנורמלים — לזיהוי חזרה. */
function eventsFingerprint(events) {
  const canonical = events.map((e) => [e.event_code, e.result, e.duration_bucket_ms, e.release, e.screen]);
  return crypto.createHash('sha256').update(JSON.stringify(['metrics-v1', canonical]), 'utf8').digest('hex');
}

/** קיבוץ מאורעות לצבירות: (יום, קוד, גרסה, גיבוב תחנה) → תוספות. */
function planIncrements(events, day, stationHash) {
  const groups = new Map();
  for (const e of events) {
    const key = day + '__' + e.event_code + '__' + e.release + '__' + stationHash;
    const inc = groups.get(key) || { count: 0, ok: 0, fail: 0 };
    inc.count += 1;
    inc[e.result] += 1;
    if (e.duration_bucket_ms !== null) {
      const b = 'bucket_' + e.duration_bucket_ms;
      inc[b] = (inc[b] || 0) + 1;
    }
    groups.set(key, inc);
  }
  return groups;
}

function createMetricsService(deps) {
  const d = plain(deps) ? deps : {};
  for (const name of ['db', 'sink', 'fail', 'requireAuth', 'getAuthUser', 'now']) {
    if (d[name] === undefined || d[name] === null) throw new TypeError('metrics dependency is required: ' + name);
  }
  const { db, sink, fail, requireAuth, getAuthUser, now } = d;
  const hasher = createScopeHasher(d.hashKey);
  const pickShard = typeof d.pickShard === 'function' ? d.pickShard : () => crypto.randomInt(SHARD_COUNT);
  const serverTimestamp = typeof d.serverTimestamp === 'function' ? d.serverTimestamp : () => new Date(now());

  const uidQuotaRef = (uidHash, day) => db.doc('metrics_quota/' + uidHash + '_' + day);
  const stationQuotaRef = (stationHash, day) => db.doc('metrics_quota/st_' + stationHash + '_' + day);
  const operationRef = (uidHash, requestId) => db.doc('metrics_operations/' + uidHash + '_' + requestId);
  const orgIndexRef = (sid) => db.doc('organization_station_index/' + sid);
  const dataOf = (snap) => (snap && snap.exists ? (snap.data() || null) : null);

  function rejectStationKeys(input) {
    if (plain(input) && (Object.prototype.hasOwnProperty.call(input, 'station_id') || Object.prototype.hasOwnProperty.call(input, 'stationId'))) {
      fail('invalid-argument', 'התחנה נקבעת לפי ההרשאות של החשבון ואינה נשלחת מהלקוח.', 'client-station');
    }
  }

  /** חבר סגל או מנהל-על — התחנה מה-claims החיים בלבד. */
  async function memberActor(req) {
    const signed = requireAuth(req);
    rejectStationKeys(req && req.data);
    const current = await getAuthUser(signed.uid);
    const live = current && plain(current.customClaims) ? current.customClaims : {};
    if (!current || current.uid !== signed.uid || current.disabled !== false) fail('permission-denied', 'החשבון אינו פעיל.', 'actor-inactive');
    const sid = typeof live.stationId === 'string' ? live.stationId : '';
    if (!STATION_ID_RE.test(sid) || (live.super !== true && typeof live.role !== 'string')) {
      fail('permission-denied', 'נדרש שיוך תחנה חי.', 'actor-station');
    }
    return Object.freeze({ uid: signed.uid, station_id: sid, is_super: live.super === true });
  }

  /** מנהל-על בלבד, מאומת מול ה-claims החיים. */
  async function superActor(req) {
    const signed = requireAuth(req);
    if (!signed.token || signed.token.super !== true) fail('permission-denied', 'לוח המדדים זמין למנהל-על בלבד.', 'super');
    const current = await getAuthUser(signed.uid);
    const live = current && plain(current.customClaims) ? current.customClaims : {};
    if (!current || current.uid !== signed.uid || current.disabled !== false || live.super !== true) {
      fail('permission-denied', 'הרשאת מנהל-על אינה עדכנית.', 'super-stale');
    }
    return Object.freeze({ uid: signed.uid });
  }

  function normalizeRecordInput(input) {
    if (!plain(input)) fail('invalid-argument', 'גוף הבקשה חייב להיות אובייקט.', 'input');
    const keys = Object.keys(input);
    if (keys.length !== 2 || keys.some((k) => k !== 'request_id' && k !== 'events')) {
      fail('invalid-argument', 'מתקבלים מזהה בקשה ורשימת מאורעות בלבד.', 'input');
    }
    if (typeof input.request_id !== 'string' || !REQUEST_ID_RE.test(input.request_id)) fail('invalid-argument', 'מזהה הבקשה אינו תקין.', 'request-id');
    if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > MAX_EVENTS_PER_CALL) {
      fail('invalid-argument', 'רשימת המאורעות חייבת להכיל בין 1 ל-' + MAX_EVENTS_PER_CALL + ' פריטים.', 'input');
    }
    const events = [];
    for (const raw of input.events) {
      try { events.push(catalog.normalizeEvent(raw)); }
      catch (error) {
        if (error && error.name === 'MetricsCatalogError') fail('invalid-argument', error.message, error.reason === 'event-code' ? 'event-code' : 'input');
        throw error;
      }
    }
    return Object.freeze({ request_id: input.request_id, events: Object.freeze(events) });
  }

  async function organizationOf(sid) {
    const row = dataOf(await orgIndexRef(sid).get());
    const org = row && typeof row.organization_id === 'string' && STATION_ID_RE.test(row.organization_id) ? row.organization_id : '';
    return org || 'none';
  }

  /* ---------- קליטה ---------- */
  async function recordMetrics(req) {
    const actor = await memberActor(req);
    const input = normalizeRecordInput(req.data);
    const nowMs = now();
    const day = dayOf(nowMs);
    const organizationId = await organizationOf(actor.station_id);
    const uidHash = hasher.hashScope(actor.uid);
    const stationHash = hasher.hashScope(actor.station_id);
    const organizationHash = organizationId === 'none' ? 'none' : hasher.hashScope(organizationId);
    const fingerprint = eventsFingerprint(input.events);
    const groups = planIncrements(input.events, day, stationHash);
    const expiresAt = new Date(Date.parse(day + 'T00:00:00.000Z') + RETENTION_DAYS * DAY_MS);

    return db.runTransaction(async (tx) => {
      const [opSnap, quotaSnap, stationSnap] = await Promise.all([
        tx.get(operationRef(uidHash, input.request_id)),
        tx.get(uidQuotaRef(uidHash, day)),
        tx.get(stationQuotaRef(stationHash, day))
      ]);
      const operation = dataOf(opSnap);
      if (operation) {
        if (operation.fingerprint !== fingerprint) fail('already-exists', 'אותו מזהה בקשה כבר שימש לגוף אחר.', 'request-conflict');
        return Object.freeze({ ok: true, duplicate: true, accepted: operation.accepted || 0, keyed: hasher.keyed });
      }
      const quota = dataOf(quotaSnap) || {};
      const calls = Number.isSafeInteger(quota.calls) && quota.calls >= 0 ? quota.calls : 0;
      if (calls >= MAX_CALLS_PER_UID_PER_DAY) fail('resource-exhausted', 'מכסת הדיווח היומית של החשבון הושגה.', 'metrics-quota');
      const stationQuota = dataOf(stationSnap) || {};
      const known = plain(stationQuota.aggregate_keys) ? stationQuota.aggregate_keys : {};
      const newKeys = [...groups.keys()].filter((k) => known[k] !== true);
      const created = Number.isSafeInteger(stationQuota.aggregates_created) ? stationQuota.aggregates_created : 0;
      if (created + newKeys.length > MAX_AGGREGATES_PER_DAY_PER_STATION) {
        fail('resource-exhausted', 'מספר הצבירות היומי לתחנה חרג מהמותר.', 'metrics-cardinality');
      }
      const meta = { day, station_hash: stationHash, organization_hash: organizationHash, keyed: hasher.keyed, expires_at: expiresAt };
      for (const [key, increments] of groups) {
        const parts = key.split('__');
        sink.write(key, pickShard(), increments, {
          tx, isNew: known[key] !== true,
          meta: Object.assign({ event_code: parts[1], release: parts[2] }, meta)
        });
      }
      tx.set(uidQuotaRef(uidHash, day), { day, calls: calls + 1, keyed: hasher.keyed, expires_at: new Date(nowMs + 2 * DAY_MS) }, { merge: true });
      const keysPatch = {};
      for (const k of newKeys) keysPatch[k] = true;
      tx.set(stationQuotaRef(stationHash, day), {
        day, aggregates_created: created + newKeys.length, keyed: hasher.keyed,
        aggregate_keys: Object.assign({}, known, keysPatch), expires_at: new Date(nowMs + 2 * DAY_MS)
      }, { merge: true });
      tx.create(operationRef(uidHash, input.request_id), {
        schema_version: OPERATION_SCHEMA, fingerprint, day, accepted: input.events.length,
        aggregates: groups.size, keyed: hasher.keyed, created_at: serverTimestamp(), expires_at: new Date(nowMs + 2 * DAY_MS)
      });
      return Object.freeze({ ok: true, duplicate: false, accepted: input.events.length, aggregates: groups.size, keyed: hasher.keyed });
    });
  }

  /* ---------- לוח מחוונים ---------- */
  function metric(value, extra) {
    return Object.freeze(Object.assign({ value, available: value !== null, partial: false, stale: false, as_of_day: null }, extra || {}));
  }
  function sumShards(rows) {
    const totals = {};
    for (const row of rows) for (const shard of row.shards) for (const k of Object.keys(shard)) totals[k] = (totals[k] || 0) + shard[k];
    return totals;
  }

  async function getMetricsDashboard(req) {
    await superActor(req);
    const input = plain(req && req.data) ? req.data : {};
    if (Object.keys(input).some((k) => k !== 'days')) fail('invalid-argument', 'מתקבל מספר ימים בלבד.', 'input');
    let days = DEFAULT_DASHBOARD_DAYS;
    if (input.days !== undefined) {
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_DASHBOARD_DAYS) fail('invalid-argument', 'מספר הימים חייב להיות בין 1 ל-' + MAX_DASHBOARD_DAYS + '.', 'days');
      days = input.days;
    }
    const nowMs = now();
    const today = dayOf(nowMs);
    const byCode = {};
    for (const code of catalog.EVENT_CODES) byCode[code] = { count: 0, ok: 0, fail: 0, buckets: {}, latest_day: null };
    const failedDays = [];
    let keyedAll = true, unkeyedSeen = false, anyRow = false, latestDay = null;
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = dayOf(nowMs - i * DAY_MS);
      dayList.push(day);
      let rows;
      try { rows = await sink.readDaily(day, {}); }
      catch (ignore) { failedDays.push(day); continue; }
      for (const row of rows) {
        const code = row.meta.event_code;
        if (!Object.prototype.hasOwnProperty.call(byCode, code)) continue;
        anyRow = true;
        if (row.meta.keyed !== true) { keyedAll = false; unkeyedSeen = true; }
        const totals = sumShards([row]);
        const acc = byCode[code];
        acc.count += totals.count || 0; acc.ok += totals.ok || 0; acc.fail += totals.fail || 0;
        for (const k of Object.keys(totals)) if (k.startsWith('bucket_')) acc.buckets[k] = (acc.buckets[k] || 0) + totals[k];
        if (totals.count > 0 && (!acc.latest_day || day > acc.latest_day)) acc.latest_day = day;
        if (totals.count > 0 && (!latestDay || day > latestDay)) latestDay = day;
      }
    }
    const partial = failedDays.length > 0;
    const yesterday = dayOf(nowMs - DAY_MS);
    const staleOf = (asOf) => !!asOf && asOf < yesterday;
    const flags = (asOf) => ({ partial, stale: staleOf(asOf), as_of_day: asOf });
    const countOf = (code) => {
      const acc = byCode[code];
      if (acc.count === 0) return metric(null, Object.assign({ reason: 'no-data' }, flags(null)));
      return metric(acc.count, Object.assign({ ok: acc.ok, fail: acc.fail }, flags(acc.latest_day)));
    };
    const events = {};
    for (const code of catalog.EVENT_CODES) events[code] = countOf(code);
    const delivered = byCode.push_delivered.count, pushFailed = byCode.push_failed.count;
    const denominator = delivered + pushFailed;
    const pushAsOf = [byCode.push_delivered.latest_day, byCode.push_failed.latest_day].filter(Boolean).sort().pop() || null;
    const login = byCode.login_success;
    const derived = {
      registrations_started: countOf('onboarding_started'),
      registrations_completed: countOf('onboarding_completed'),
      devices_ready: countOf('device_readiness_completed'),
      push_success_rate: denominator === 0
        ? metric(null, Object.assign({ reason: 'zero-denominator' }, flags(pushAsOf)))
        : metric(Math.round((delivered / denominator) * 1000) / 1000, Object.assign({ delivered, failed: pushFailed }, flags(pushAsOf))),
      load_time_buckets: login.count === 0
        ? metric(null, Object.assign({ reason: 'no-data' }, flags(null)))
        : metric(Object.freeze(Object.assign({}, login.buckets)), Object.assign({ total: login.count }, flags(login.latest_day))),
      schedule_publish_failures: byCode.schedule_publish_completed.count === 0
        ? metric(null, Object.assign({ reason: 'no-data' }, flags(null)))
        : metric(byCode.schedule_publish_completed.fail, Object.assign({ total: byCode.schedule_publish_completed.count }, flags(byCode.schedule_publish_completed.latest_day))),
      callouts_opened: countOf('callout_started'),
      callouts_closed: countOf('callout_closed'),
      /* אין מקור למשתמשים פעילים בשכבה זו — לא מדווחים 0. */
      active_users_rate: metric(null, { reason: 'no-source', partial: false, stale: false, as_of_day: null })
    };
    return Object.freeze({
      ok: true, days, from_day: dayList[0], to_day: today, as_of_day: latestDay,
      partial, failed_days: Object.freeze(failedDays.slice()), stale: staleOf(latestDay),
      hash_mode: !anyRow ? 'none' : (keyedAll ? 'keyed' : 'unkeyed'), unkeyed_seen: unkeyedSeen,
      events: Object.freeze(events), derived: Object.freeze(derived)
    });
  }

  /* ---------- ניקוי — למשימה מתוזמנת עתידית, לא מחובר ללוח זמנים ---------- */
  async function pruneExpired(options) {
    const o = plain(options) ? options : {};
    const nowMs = Number.isSafeInteger(o.now) ? o.now : now();
    const limit = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, PRUNE_BATCH) : PRUNE_BATCH;
    const keys = await sink.listExpired(nowMs, limit);
    let removed = 0;
    for (const key of keys) { await sink.remove(key); removed += 1; }
    return Object.freeze({ ok: true, removed, limit, more: keys.length >= limit });
  }

  return Object.freeze({ recordMetrics, getMetricsDashboard, pruneExpired, hashScope: hasher.hashScope, keyed: hasher.keyed });
}

module.exports = Object.freeze({
  createMetricsService, createScopeHasher, eventsFingerprint, planIncrements,
  RETENTION_DAYS, MAX_EVENTS_PER_CALL, MAX_CALLS_PER_UID_PER_DAY, MAX_AGGREGATES_PER_DAY_PER_STATION,
  MAX_DASHBOARD_DAYS, PRUNE_BATCH, REQUEST_ID_RE
});
