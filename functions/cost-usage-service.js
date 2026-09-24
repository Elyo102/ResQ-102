'use strict';
/* לוח עלות ושימוש — מנהל-על בלבד.
 *
 * שלושה אזורים נפרדים במפורש:
 * 1) עלות בפועל — Billing בלבד. עד חיבור: available:false + «אין מקור» (לעולם לא 0).
 * 2) עומס ושיוך — מ-metrics_daily החלקי (~15 אירועים) עם תגיות כנות; אינו חשבונית.
 * 3) משתמשים — שם/תחנה/lastSignIn (תאריך+שעה) + ספירות קריאות רק מאז measurement_start.
 *
 * אין כתיבות מד מדד לכל בקשת callout. צבירות cost_usage_* נכתבות רק באצווה
 * אידמפוטנטית אטומית (ledger + daily + lifetime בטרנזקציה אחת) ממקור callable_completion / ingest מתוזמן.
 * בלי מזין (feeder) מפורש — אין ספירות קריאות חיות (feeder_status: not_wired).
 * מפתח: RESQ_COST_USAGE_HASH_KEY בלבד (defineSecret / Secret Manager חובה ל-prod). אין נפילה ל-METRICS.
 */
const crypto = require('node:crypto');
const catalog = require('./metrics-catalog');

const RETENTION_DAYS = 90;
const LEDGER_RETENTION_DAYS = 90;
// A replay is refused long before its ledger entry can expire.
const MAX_EVENT_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DASHBOARD_DAYS = 30;
const DEFAULT_DASHBOARD_DAYS = 7;
const CONFIG_PATH = 'cost_usage_config/settings';
const DAILY_COLLECTION = 'cost_usage_daily';
const LIFETIME_COLLECTION = 'cost_usage_lifetime';
const LEDGER_COLLECTION = 'cost_usage_batch_ledger';
const BATCH_CURSOR_PATH = 'cost_usage_config/batch_cursor';
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const PRUNE_BATCH = 200;
const SCOPE_PREFIX = 'cost-usage-scope-v1|';
const EVENT_PREFIX = 'cost-usage-event-v1|';
const MIN_HMAC_KEY_LEN = 16;
const FEATURE_LABELS = Object.freeze({
  login_success: 'כניסה',
  login_failure: 'כניסה שנכשלה',
  onboarding_started: 'קליטה',
  onboarding_completed: 'קליטה הושלמה',
  device_readiness_started: 'מוכנות מכשיר',
  device_readiness_completed: 'מוכנות מכשיר הושלמה',
  push_queued: 'פוש לתור',
  push_delivered: 'פוש נמסר',
  push_failed: 'פוש נכשל',
  schedule_import_started: 'ייבוא סידור',
  schedule_import_completed: 'ייבוא סידור הושלם',
  schedule_publish_completed: 'פרסום סידור',
  callout_started: 'קריאת פתע',
  callout_closed: 'סגירת קריאה',
  client_error: 'שגיאת לקוח'
});

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return null;
  }
  if (value && typeof value.toDate === 'function') {
    try {
      const dte = value.toDate();
      if (dte instanceof Date && !Number.isNaN(dte.getTime())) return dte.toISOString();
    } catch (ignore) { /* ignore */ }
  }
  return null;
}

/** HMAC בלבד. בלי מפתח — hasher=null (שיוך מושבת). אין sha256 הפיך. */
function createAttributionHasher(hashKey) {
  const key = typeof hashKey === 'string' ? hashKey : '';
  if (key.length < MIN_HMAC_KEY_LEN) {
    return Object.freeze({
      ready: false,
      status: 'disabled_no_hmac_secret',
      hashScope() {
        const err = new Error('cost-usage attribution refuses unkeyed hashing');
        err.code = 'attribution-disabled';
        throw err;
      },
      hashEvent() {
        const err = new Error('cost-usage attribution refuses unkeyed hashing');
        err.code = 'attribution-disabled';
        throw err;
      }
    });
  }
  return Object.freeze({
    ready: true,
    status: 'ready',
    hashScope(id) {
      return crypto.createHmac('sha256', key).update(SCOPE_PREFIX + String(id), 'utf8').digest('hex');
    },
    hashEvent(eventId) {
      return crypto.createHmac('sha256', key).update(EVENT_PREFIX + String(eventId), 'utf8').digest('hex');
    }
  });
}

function createCostUsageService(deps) {
  const d = plain(deps) ? deps : {};
  for (const name of ['db', 'fail', 'requireAuth', 'getAuthUser', 'now']) {
    if (d[name] === undefined || d[name] === null) throw new TypeError('cost-usage dependency is required: ' + name);
  }
  const { db, fail, requireAuth, getAuthUser, now } = d;
  const listAuthUsers = typeof d.listAuthUsers === 'function' ? d.listAuthUsers : null;
  const metricsSink = d.metricsSink || null;
  const loadUserProfiles = typeof d.loadUserProfiles === 'function' ? d.loadUserProfiles : async () => ({});
  const billingReader = d.billingReader && typeof d.billingReader.read === 'function'
    ? d.billingReader : null;
  const hasher = createAttributionHasher(d.hashKey);
  const serverTimestamp = typeof d.serverTimestamp === 'function' ? d.serverTimestamp : () => new Date(now());
  const dataOf = (snap) => (snap && snap.exists ? (snap.data() || null) : null);
  const listExpiredHook = typeof d.listExpiredCostUsageDocs === 'function' ? d.listExpiredCostUsageDocs : null;
  const deleteDocsHook = typeof d.deleteCostUsageDocs === 'function' ? d.deleteCostUsageDocs : null;

  if (typeof db.runTransaction !== 'function') {
    throw new TypeError('cost-usage dependency is required: db.runTransaction');
  }

  async function superActor(req) {
    const signed = requireAuth(req);
    if (!signed.token || signed.token.super !== true) {
      fail('permission-denied', 'לוח עלות ושימוש זמין למנהל-על בלבד.', 'super');
    }
    const current = await getAuthUser(signed.uid);
    const live = current && plain(current.customClaims) ? current.customClaims : {};
    if (!current || current.uid !== signed.uid || current.disabled !== false || live.super !== true) {
      fail('permission-denied', 'הרשאת מנהל-על אינה עדכנית.', 'super-stale');
    }
    return Object.freeze({ uid: signed.uid });
  }

  async function readMeasurementConfig() {
    const row = dataOf(await db.doc(CONFIG_PATH).get());
    const raw = row && row.measurement_start_at;
    let startMs = null;
    if (typeof raw === 'string' && raw) {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) startMs = parsed;
    } else if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      startMs = raw.getTime();
    } else if (raw && typeof raw.toDate === 'function') {
      try {
        const dte = raw.toDate();
        if (dte instanceof Date && !Number.isNaN(dte.getTime())) startMs = dte.getTime();
      } catch (ignore) { /* ignore */ }
    }
    const aggregatesPresent = !!(row && row.aggregates_present === true);
    if (startMs === null) {
      return Object.freeze({
        measurement_start_at: null,
        status: 'not_started',
        aggregates_present: aggregatesPresent,
        locked: false,
        coverage: Object.freeze({ state: 'not_started', from: null, to: null, note_he: 'מדידה לא הופעלה עדיין — אין היסטוריה מומצאת.' })
      });
    }
    const startIso = new Date(startMs).toISOString();
    return Object.freeze({
      measurement_start_at: startIso,
      status: 'active',
      aggregates_present: aggregatesPresent,
      locked: true,
      coverage: Object.freeze({
        state: 'since_measurement_start',
        from: startIso,
        to: new Date(now()).toISOString(),
        locked_start: startIso,
        note_he: 'תחילת המדידה נקבעת פעם אחת בשרת ואינה ניתנת לאיפוס דרך הלוח.'
      })
    });
  }

  async function paneActualCost(days) {
    if (billingReader) {
      try {
        const result = await billingReader.read(days);
        if (result && result.id === 'actual_cost' && typeof result.available === 'boolean') {
          return result;
        }
      } catch (_) { /* no provider detail is returned to the browser */ }
    }
    return Object.freeze({
      id: 'actual_cost',
      title_he: 'עלות בפועל',
      source: 'billing',
      badge: 'אין מקור',
      available: false,
      value: null,
      reason: 'billing_not_connected',
      by_service: Object.freeze([]),
      by_day: Object.freeze([]),
      note_he: 'מקור: Billing בלבד. הייצוא וה-IAM עדיין לא מחוברים — מוצג «אין מקור», לא $0 ולא אומדן.'
    });
  }

  function feederStatus() {
    return Object.freeze({
      status: 'not_wired',
      note_he: 'אין מזין חי: אין scheduled job / logging sink שקורא ל-recordAttributedCallsBatch עם event_ids. בלי מזין מפורש — אין ספירות קריאות חיות (לא אפסים מזויפים).',
      ingest: 'callable_completion_batch',
      live_counts: false
    });
  }

  function sumShards(rows) {
    const totals = {};
    for (const row of rows) {
      for (const shard of row.shards || []) {
        for (const k of Object.keys(shard)) totals[k] = (totals[k] || 0) + shard[k];
      }
    }
    return totals;
  }

  async function paneLoadAttribution(days) {
    const nowMs = now();
    const byFeature = {};
    for (const code of catalog.EVENT_CODES) byFeature[code] = { count: 0, stations: new Set(), days_seen: 0 };
    let any = false;
    let failedDays = 0;
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = dayOf(nowMs - i * DAY_MS);
      dayList.push(day);
      if (!metricsSink || typeof metricsSink.readDaily !== 'function') {
        failedDays += 1;
        continue;
      }
      let rows;
      try { rows = await metricsSink.readDaily(day, {}); }
      catch (ignore) { failedDays += 1; continue; }
      const seenCodes = new Set();
      for (const row of rows) {
        const code = row.meta && row.meta.event_code;
        if (!code || !Object.prototype.hasOwnProperty.call(byFeature, code)) continue;
        any = true;
        const totals = sumShards([row]);
        const n = Number.isSafeInteger(totals.count) ? totals.count : 0;
        byFeature[code].count += n;
        if (row.meta.station_hash) byFeature[code].stations.add(row.meta.station_hash);
        seenCodes.add(code);
      }
      for (const code of seenCodes) byFeature[code].days_seen += 1;
    }
    const features = catalog.EVENT_CODES.map((code) => {
      const acc = byFeature[code];
      const has = acc.count > 0;
      return Object.freeze({
        feature: code,
        label_he: FEATURE_LABELS[code] || code,
        count: has ? acc.count : null,
        available: has,
        station_pseudonyms: hasher.ready ? acc.stations.size : null,
        badge: has ? 'שיוך עלות משוער' : 'עומס חלקי/לא נמדד',
        source: 'metrics_daily',
        invoice: false
      });
    });
    return Object.freeze({
      id: 'load_attribution',
      title_he: 'עומס ושיוך',
      source: 'metrics_daily',
      badge: 'עומס חלקי/לא נמדד',
      available: any,
      coverage: 'partial',
      catalog_size: catalog.EVENT_CODES.length,
      partial_note_he: 'metrics_daily = PARTIAL בלבד (~' + catalog.EVENT_CODES.length + ' אירועים בקטלוג). אינו חשבונית ואינו עלות בפועל.',
      badges_legend: Object.freeze([
        Object.freeze({ id: 'actual', label_he: 'עלות בפועל' }),
        Object.freeze({ id: 'estimated', label_he: 'שיוך עלות משוער' }),
        Object.freeze({ id: 'partial', label_he: 'עומס חלקי/לא נמדד' })
      ]),
      from_day: dayList[0] || null,
      to_day: dayList[dayList.length - 1] || null,
      failed_days: failedDays,
      features: Object.freeze(features),
      note_he: 'שיוך משוער מעומס חלקי בלבד. לעולם לא מוצג כחשבונית.'
    });
  }

  async function readLifetimeCounts(uids) {
    if (!hasher.ready || !Array.isArray(uids) || !uids.length) return new Map();
    const out = new Map();
    for (const uid of uids) {
      let hash;
      try { hash = hasher.hashScope(uid); }
      catch (ignore) { continue; }
      const snap = await db.doc(LIFETIME_COLLECTION + '/' + hash).get();
      const row = dataOf(snap);
      if (!row) continue;
      const calls = Number.isSafeInteger(row.calls) && row.calls >= 0 ? row.calls : null;
      if (calls === null) continue;
      out.set(uid, Object.freeze({
        calls,
        since_measurement: row.since_measurement === true,
        updated_at: row.updated_at || null
      }));
    }
    return out;
  }

  async function fetchAuthPage(pageSize, pageToken) {
    if (!listAuthUsers) return { users: [], nextPageToken: null };
    const result = await listAuthUsers({ pageSize, pageToken: pageToken || undefined });
    if (!plain(result) || !Array.isArray(result.users)) {
      fail('internal', 'listAuthUsers must return { users, nextPageToken }.', 'auth-page');
    }
    return {
      users: result.users,
      nextPageToken: typeof result.nextPageToken === 'string' && result.nextPageToken ? result.nextPageToken : null
    };
  }

  async function paneUsers(measurement, paging, feeder) {
    const coverageState = measurement.status === 'active' ? measurement.coverage.state : 'not_started';
    const pageSize = paging.pageSize;
    const pageToken = paging.pageToken;
    const feederNote = feeder.status === 'not_wired'
      ? ' מזין לא מחובר (feeder_status: not_wired) — אין ספירות קריאות חיות.'
      : '';
    if (!listAuthUsers) {
      return Object.freeze({
        id: 'users',
        title_he: 'משתמשים',
        measurement_start_at: measurement.measurement_start_at,
        coverage: coverageState,
        coverage_from: measurement.coverage && measurement.coverage.from || null,
        locked_start: measurement.coverage && measurement.coverage.locked_start || measurement.measurement_start_at,
        attribution_status: hasher.status,
        feeder_status: feeder.status,
        page_size: pageSize,
        next_page_token: null,
        has_more: false,
        users: Object.freeze([]),
        note_he: 'רשימת Auth אינה זמינה בסביבה זו.' + feederNote,
        measurement_source: 'cost_usage_lifetime_batch'
      });
    }
    const page = await fetchAuthPage(pageSize, pageToken);
    const list = page.users;
    // Page-scoped only: profiles + lifetime for current Auth page users (never all users).
    const profiles = await loadUserProfiles(list);
    const profileMap = plain(profiles) ? profiles : {};
    let counts = new Map();
    const canAttribute = hasher.ready && measurement.status === 'active';
    if (canAttribute) {
      counts = await readLifetimeCounts(list.map((u) => u && u.uid).filter(Boolean));
    }
    const users = [];
    for (const u of list) {
      if (!u || typeof u.uid !== 'string') continue;
      const claims = plain(u.customClaims) ? u.customClaims : (plain(u.claims) ? u.claims : {});
      const station = typeof claims.stationId === 'string' ? claims.stationId : '';
      const profile = profileMap[u.uid] || {};
      const displayName = typeof profile.full_name === 'string' && profile.full_name
        ? profile.full_name
        : (typeof u.displayName === 'string' && u.displayName ? u.displayName : (typeof u.email === 'string' ? u.email : '—'));
      const lastSignIn = toIsoTimestamp(
        (u.metadata && u.metadata.lastSignInTime) || u.last_signin || null
      );
      let callCount = null;
      let callCoverage = 'not_measured';
      if (measurement.status !== 'active') {
        callCoverage = 'not_started';
        callCount = null;
      } else if (!hasher.ready) {
        callCoverage = 'attribution_disabled';
        callCount = null;
      } else if (feeder.status === 'not_wired' && !counts.has(u.uid)) {
        // Honest: feeder not wired — still show measured batch counts if present, else not_measured (never fake 0).
        callCoverage = 'not_measured';
        callCount = null;
      } else if (counts.has(u.uid)) {
        callCount = counts.get(u.uid).calls;
        callCoverage = 'since_measurement_start';
      } else {
        callCoverage = 'not_measured';
        callCount = null;
      }
      users.push(Object.freeze({
        display_name: displayName,
        station_id: station || null,
        last_signin: lastSignIn || null,
        disabled: u.disabled === true,
        call_count: callCount,
        call_count_coverage: callCoverage,
        call_count_source: callCoverage === 'since_measurement_start' ? 'cost_usage_lifetime_batch' : null
      }));
    }
    return Object.freeze({
      id: 'users',
      title_he: 'משתמשים',
      measurement_start_at: measurement.measurement_start_at,
      coverage: coverageState,
      coverage_from: measurement.coverage && measurement.coverage.from || null,
      locked_start: measurement.coverage && measurement.coverage.locked_start || measurement.measurement_start_at,
      attribution_status: hasher.status,
      feeder_status: feeder.status,
      page_size: pageSize,
      next_page_token: page.nextPageToken,
      has_more: !!page.nextPageToken,
      users: Object.freeze(users),
      note_he: 'אין UID גולמי במסך. ספירות קריאות ממדוד אצווה אידמפוטנטי אטומי (ledger+daily+lifetime) בלבד. חסר מדידה -> לא מוצג 0. כניסה אחרונה כוללת תאריך ושעה.' + feederNote,
      measurement_source: 'cost_usage_lifetime_batch'
    });
  }

  function parsePaging(input) {
    let pageSize = DEFAULT_PAGE_SIZE;
    if (input.pageSize !== undefined) {
      if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > MAX_PAGE_SIZE) {
        fail('invalid-argument', 'pageSize must be between 1 and ' + MAX_PAGE_SIZE + '.', 'pageSize');
      }
      pageSize = input.pageSize;
    }
    let pageToken = null;
    if (input.pageToken !== undefined && input.pageToken !== null) {
      if (typeof input.pageToken !== 'string' || !input.pageToken) {
        fail('invalid-argument', 'pageToken is invalid.', 'pageToken');
      }
      pageToken = input.pageToken;
    }
    return { pageSize, pageToken };
  }

  async function getCostUsageDashboard(req) {
    await superActor(req);
    const input = plain(req && req.data) ? req.data : {};
    const allowed = new Set(['days', 'pageSize', 'pageToken']);
    if (Object.keys(input).some((k) => !allowed.has(k))) {
      fail('invalid-argument', 'מתקבלים days / pageSize / pageToken בלבד.', 'input');
    }
    let days = DEFAULT_DASHBOARD_DAYS;
    if (input.days !== undefined) {
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_DASHBOARD_DAYS) {
        fail('invalid-argument', 'מספר הימים חייב להיות בין 1 ל-' + MAX_DASHBOARD_DAYS + '.', 'days');
      }
      days = input.days;
    }
    const paging = parsePaging(input);
    const measurement = await readMeasurementConfig();
    const feeder = feederStatus();
    const actual = await paneActualCost(days);
    const load = await paneLoadAttribution(days);
    const users = await paneUsers(measurement, paging, feeder);
    return Object.freeze({
      ok: true,
      days,
      measurement,
      feeder,
      attribution: Object.freeze({
        status: hasher.status,
        ready: hasher.ready,
        key_name: 'RESQ_COST_USAGE_HASH_KEY',
        note_he: hasher.ready
          ? 'HMAC מוכן (RESQ_COST_USAGE_HASH_KEY via defineSecret). אצווה אידמפוטנטית אטומית בלבד - אין כתיבה לכל בקשת callout.'
          : 'שיוך מושבת: חסר RESQ_COST_USAGE_HASH_KEY ב-Secret Manager (defineSecret). אין נפילה ל-METRICS או ל-hash הפיך.'
      }),
      panes: Object.freeze({
        actual_cost: actual,
        load_attribution: load,
        users
      }),
      self_cost_note_he: 'קריאת הלוח: Auth listUsers בעמוד (pageSize) + metrics_daily חלקי לטווח + config + lifetime/profiles רק למשתמשי העמוד (O(pageSize)). אין כתיבות מד מדד בנתיב callout. feeder_status: not_wired — בלי מזין מפורש אין ספירות קריאות חיות.',
      retention: Object.freeze({
        daily_days: RETENTION_DAYS,
        ledger_days: LEDGER_RETENTION_DAYS,
        lifetime: 'keep_while_account_active_explicit_delete',
        prune: 'stub_not_scheduled'
      })
    });
  }

  async function setCostUsageMeasurementStart(req) {
    await superActor(req);
    const input = plain(req && req.data) ? req.data : {};
    if (Object.keys(input).length) {
      fail('invalid-argument', 'תחילת המדידה נקבעת פעם אחת לפי שעון השרת; אין אפשרות לשנות או לאפס אותה כאן.', 'input');
    }
    const configRef = db.doc(CONFIG_PATH);
    return db.runTransaction(async (tx) => {
      const current = dataOf(await tx.get(configRef)) || {};
      const existing = toIsoTimestamp(current.measurement_start_at);
      if (existing) {
        return Object.freeze({ ok: true, measurement_start_at: existing, status: 'active', locked: true, created: false });
      }
      if (current.aggregates_present === true) {
        fail('failed-precondition', 'נמצאו מונים בלי תאריך תחילת מדידה; נדרשת בדיקת מפעיל.', 'orphan-aggregates');
      }
      const start = new Date(now()).toISOString();
      tx.set(configRef, {
        measurement_start_at: start,
        aggregates_present: false,
        updated_at: serverTimestamp(),
        schema: 'cost-usage-config-v1'
      }, { merge: true });
      return Object.freeze({ ok: true, measurement_start_at: start, status: 'active', locked: true, created: true });
    });
  }

  function planDailyExpiry(day) {
    return new Date(Date.parse(day + 'T00:00:00.000Z') + RETENTION_DAYS * DAY_MS);
  }

  function planLedgerExpiry(day) {
    return new Date(Date.parse(day + 'T00:00:00.000Z') + LEDGER_RETENTION_DAYS * DAY_MS);
  }

  function assertCanHashForWrite() {
    if (!hasher.ready) {
      fail('failed-precondition', 'שיוך עלות ושימוש מושבת בלי RESQ_COST_USAGE_HASH_KEY.', 'attribution-disabled');
    }
  }

  function validateBatchEntry(entry, nowMs) {
    if (!plain(entry) || typeof entry.event_id !== 'string' || !entry.event_id || entry.event_id.length > 128) {
      fail('invalid-argument', 'כל פריט חייב event_id ייחודי.', 'input');
    }
    if (typeof entry.subject_id !== 'string' || !Number.isSafeInteger(entry.calls) || entry.calls < 0) {
      fail('invalid-argument', 'כל פריט חייב subject_id ו-calls.', 'input');
    }
    if (typeof entry.feature !== 'string' || !/^[a-z_]{1,40}$/.test(entry.feature)) {
      fail('invalid-argument', 'feature אינו תקין.', 'input');
    }
    const source = typeof entry.source === 'string' && entry.source ? entry.source : 'callable_completion';
    const iso = toIsoTimestamp(entry.occurred_at);
    if (!iso) fail('invalid-argument', 'נדרש occurred_at תקין לכל אירוע.', 'occurred-at');
    const occurredMs = Date.parse(iso);
    if (occurredMs > nowMs || occurredMs < nowMs - MAX_EVENT_AGE_DAYS * DAY_MS) {
      fail('failed-precondition', 'האירוע מחוץ לחלון הקליטה של 30 יום.', 'event-age');
    }
    return { source, occurredMs };
  }

  /**
   * Idempotent batch from callable_completion (or similar ingest).
   * Each accepted event applies ledger + daily + lifetime in ONE Firestore transaction.
   * Crash mid-event rolls back; re-run is exactly-once. Parallel overlapping event_ids: exactly-once.
   * Not on the live request path.
   */
  async function recordAttributedCallsBatch(entries) {
    assertCanHashForWrite();
    if (!Array.isArray(entries) || !entries.length) {
      fail('invalid-argument', 'נדרשת רשימת צבירות.', 'input');
    }
    const nowMs = now();
    let written = 0;
    let skipped = 0;
    let maxOccurredMs = null;
    let lastEventHash = null;

    for (const entry of entries) {
      const { source, occurredMs } = validateBatchEntry(entry, nowMs);
      const day = dayOf(occurredMs);
      const expires = planDailyExpiry(day);
      const ledgerExpires = planLedgerExpiry(day);
      const subjectHash = hasher.hashScope(entry.subject_id);
      const eventHash = hasher.hashEvent(entry.event_id);
      const ledgerRef = db.doc(LEDGER_COLLECTION + '/' + eventHash);
      const dailyId = day + '__' + entry.feature + '__' + subjectHash;
      const dailyRef = db.doc(DAILY_COLLECTION + '/' + dailyId);
      const lifeRef = db.doc(LIFETIME_COLLECTION + '/' + subjectHash);
      const configRef = db.doc(CONFIG_PATH);

      const outcome = await db.runTransaction(async (tx) => {
        const config = dataOf(await tx.get(configRef)) || {};
        const start = toIsoTimestamp(config.measurement_start_at);
        if (!start) fail('failed-precondition', 'תחילת המדידה טרם נקבעה.', 'measurement-not-started');
        if (occurredMs < Date.parse(start)) {
          fail('failed-precondition', 'האירוע קודם לתחילת המדידה.', 'before-measurement-start');
        }
        const existingSnap = await tx.get(ledgerRef);
        if (existingSnap && existingSnap.exists) {
          return { skipped: true };
        }
        const dailySnap = await tx.get(dailyRef);
        const lifeSnap = await tx.get(lifeRef);
        const prevDaily = dataOf(dailySnap) || {};
        const prevDailyCalls = Number.isSafeInteger(prevDaily.calls) ? prevDaily.calls : 0;
        const prevLife = dataOf(lifeSnap) || {};
        const prevCalls = Number.isSafeInteger(prevLife.calls) ? prevLife.calls : 0;

        tx.set(ledgerRef, {
          event_hash: eventHash,
          feature: entry.feature,
          subject_hash: subjectHash,
          calls: entry.calls,
          day,
          source,
          processed_at: serverTimestamp(),
          expires_at: ledgerExpires,
          schema: 'cost-usage-batch-ledger-v1',
          keyed: true
        });
        tx.set(dailyRef, {
          day,
          feature: entry.feature,
          subject_hash: subjectHash,
          calls: prevDailyCalls + entry.calls,
          expires_at: expires,
          schema: 'cost-usage-daily-v1',
          source,
          keyed: true
        }, { merge: true });
        tx.set(lifeRef, {
          subject_hash: subjectHash,
          calls: prevCalls + entry.calls,
          since_measurement: true,
          updated_at: serverTimestamp(),
          schema: 'cost-usage-lifetime-v1',
          source,
          keyed: true
        }, { merge: true });
        tx.set(configRef, {
          aggregates_present: true,
          schema: 'cost-usage-config-v1'
        }, { merge: true });
        return { skipped: false };
      });

      if (outcome.skipped) {
        skipped += 1;
      } else {
        written += 1;
        if (maxOccurredMs === null || occurredMs > maxOccurredMs) maxOccurredMs = occurredMs;
        lastEventHash = eventHash;
      }
    }

    await db.doc(BATCH_CURSOR_PATH).set({
      last_occurred_at: maxOccurredMs !== null ? new Date(maxOccurredMs).toISOString() : null,
      last_event_hash: lastEventHash,
      last_batch_written: written,
      last_batch_skipped: skipped,
      updated_at: serverTimestamp(),
      schema: 'cost-usage-batch-cursor-v1'
    }, { merge: true });
    return Object.freeze({
      ok: true,
      written,
      skipped_duplicates: skipped,
      day: dayOf(nowMs),
      retention_days: RETENTION_DAYS,
      ledger_retention_days: LEDGER_RETENTION_DAYS,
      max_event_age_days: MAX_EVENT_AGE_DAYS,
      source: 'callable_completion',
      idempotent: true,
      atomic: true
    });
  }

  /**
   * Retention prune stub — eligible daily/ledger docs with expires_at <= now.
   * Lifetime kept while account active (explicit delete policy elsewhere).
   * Not wired to production scheduler.
   */
  async function pruneExpiredCostUsage(options) {
    const o = plain(options) ? options : {};
    const nowMs = Number.isSafeInteger(o.now) ? o.now : now();
    const limit = Number.isInteger(o.limit) && o.limit > 0 ? Math.min(o.limit, PRUNE_BATCH) : PRUNE_BATCH;
    let keys = [];
    if (listExpiredHook) {
      keys = await listExpiredHook(nowMs, limit);
    } else if (typeof db.collection === 'function') {
      for (const col of [DAILY_COLLECTION, LEDGER_COLLECTION]) {
        if (keys.length >= limit) break;
        const snap = await db.collection(col).where('expires_at', '<=', new Date(nowMs)).limit(limit - keys.length).get();
        const docs = snap && snap.docs ? snap.docs : [];
        for (const doc of docs) keys.push(col + '/' + doc.id);
      }
    } else {
      fail('failed-precondition', 'אין נתיב listExpired לצבירות.', 'prune-unavailable');
    }
    let removed = 0;
    if (deleteDocsHook) {
      removed = await deleteDocsHook(keys);
    } else {
      for (const path of keys) {
        await db.doc(path).delete();
        removed += 1;
      }
    }
    return Object.freeze({
      ok: true,
      removed,
      limit,
      more: keys.length >= limit,
      collections: Object.freeze([DAILY_COLLECTION, LEDGER_COLLECTION]),
      lifetime_policy: 'keep_while_account_active_explicit_delete',
      scheduled: false
    });
  }

  /** Eligibility helper for tests — does not delete. */
  function isPruneEligible(row, nowMs) {
    if (!plain(row) || !row.expires_at) return false;
    const exp = row.expires_at instanceof Date
      ? row.expires_at.getTime()
      : (typeof row.expires_at.toDate === 'function' ? row.expires_at.toDate().getTime() : Date.parse(row.expires_at));
    return Number.isFinite(exp) && exp <= nowMs;
  }

  return Object.freeze({
    getCostUsageDashboard,
    setCostUsageMeasurementStart,
    recordAttributedCallsBatch,
    pruneExpiredCostUsage,
    isPruneEligible,
    feederStatus,
    attributionReady: hasher.ready,
    attributionStatus: hasher.status,
    hashScope: (...args) => hasher.hashScope(...args),
    hashEvent: (...args) => hasher.hashEvent(...args),
    RETENTION_DAYS,
    LEDGER_RETENTION_DAYS,
    MAX_EVENT_AGE_DAYS,
    PRUNE_BATCH,
    CONFIG_PATH,
    BATCH_CURSOR_PATH,
    DAILY_COLLECTION,
    LIFETIME_COLLECTION,
    LEDGER_COLLECTION,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  });
}

module.exports = Object.freeze({
  createCostUsageService,
  createAttributionHasher,
  RETENTION_DAYS,
  LEDGER_RETENTION_DAYS,
  MAX_EVENT_AGE_DAYS,
  PRUNE_BATCH,
  MAX_DASHBOARD_DAYS,
  DEFAULT_DASHBOARD_DAYS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  CONFIG_PATH: 'cost_usage_config/settings',
  BATCH_CURSOR_PATH: 'cost_usage_config/batch_cursor',
  DAILY_COLLECTION: 'cost_usage_daily',
  LIFETIME_COLLECTION: 'cost_usage_lifetime',
  LEDGER_COLLECTION: 'cost_usage_batch_ledger',
  FEATURE_LABELS,
  MIN_HMAC_KEY_LEN,
  toIsoTimestamp
});
