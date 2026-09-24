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
const { CALLABLE_FEATURES } = require('./cost-completion-event');

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
const STATION_DAILY_COLLECTION = 'cost_usage_station_daily';
const GLOBAL_DAILY_COLLECTION = 'cost_usage_global_daily';
const STATION_SHARDS = 16;
const STATION_PAGE_SIZE = 25;
const BATCH_CURSOR_PATH = 'cost_usage_config/batch_cursor';
const FEEDER_STATE_PATH = 'cost_usage_config/feeder';
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
  schedule_range_read: 'קריאת סידור תחנה',
  attendance_month_read: 'קריאת דוח שעות',
  hr_inbox_read: 'קריאת תיבת משאבי אנוש',
  client_error: 'שגיאת לקוח'
});

const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const israelDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
});
function israelDayOf(ms) {
  const parts = Object.fromEntries(israelDayFormatter.formatToParts(new Date(ms))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const shiftCalendarDay = (day, amount) => dayOf(Date.parse(day + 'T00:00:00.000Z') + amount * DAY_MS);
function israelDayStart(day) {
  let low = Date.parse(day + 'T00:00:00.000Z') - DAY_MS;
  let high = low + 2 * DAY_MS;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (israelDayOf(mid) < day) low = mid;
    else high = mid;
  }
  return high;
}

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
    const stationStart = toIsoTimestamp(row && row.station_aggregate_start_at);
    const globalStart = toIsoTimestamp(row && row.global_aggregate_start_at);
    if (startMs === null) {
      return Object.freeze({
        measurement_start_at: null,
        status: 'not_started',
        aggregates_present: aggregatesPresent,
        station_aggregate_start_at: stationStart,
        global_aggregate_start_at: globalStart,
        locked: false,
        coverage: Object.freeze({ state: 'not_started', from: null, to: null, note_he: 'מדידה לא הופעלה עדיין — אין היסטוריה מומצאת.' })
      });
    }
    const startIso = new Date(startMs).toISOString();
    return Object.freeze({
      measurement_start_at: startIso,
      status: 'active',
      aggregates_present: aggregatesPresent,
      station_aggregate_start_at: stationStart,
      global_aggregate_start_at: globalStart,
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

  async function feederStatus() {
    const snap = await db.doc(FEEDER_STATE_PATH).get();
    const row = dataOf(snap) || {};
    const checkedAt = toIsoTimestamp(row.checked_at);
    if (row.schema === 'cost-usage-feeder-v1' && checkedAt
        && Array.isArray(row.measured_callables)
        && row.measured_callables.length === Object.keys(CALLABLE_FEATURES).length
        && row.measured_callables.every((name) => Object.hasOwn(CALLABLE_FEATURES, name))) {
      const lagMs = now() - Date.parse(checkedAt);
      const fresh = lagMs >= 0 && lagMs <= 15 * 60 * 1000;
      const observedAt = toIsoTimestamp(row.last_ingested_at);
      const observedLagMs = observedAt ? now() - Date.parse(observedAt) : Infinity;
      const recentlyObserved = observedLagMs >= 0 && observedLagMs <= 60 * 60 * 1000;
      const status = !fresh ? 'delayed' : row.blocked === true ? 'blocked'
        : row.backlog === true ? 'backlog' : recentlyObserved ? 'active_partial' : 'awaiting_sample';
      return Object.freeze({
        status,
        note_he: status === 'active_partial'
          ? 'נצפתה קליטה לאחרונה לפחות באחת משלוש הקריאות המוגדרות. אין הוכחת כיסוי לכל הקריאות.'
          : 'אין הוכחה למדידה עדכנית ושלמה; יש לבדוק את המזין ואת התור.',
        ingest: 'durable_outbox_batch', live_counts: status === 'active_partial',
        measured_callables: Object.freeze([...row.measured_callables]),
        checked_at: checkedAt, last_ingested_at: observedAt
      });
    }
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
    const feederNote = ' ' + feeder.note_he;
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
    const allowed = new Set(['days', 'pageSize', 'pageToken', 'stationDay', 'stationPageToken']);
    if (Object.keys(input).some((k) => !allowed.has(k))) {
      fail('invalid-argument', 'שדות הבקשה אינם תקינים.', 'input');
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
    const feeder = await feederStatus();
    const actual = await paneActualCost(days);
    const load = await paneLoadAttribution(days);
    const stationCalls = await paneStationCalls(input.stationDay, input.stationPageToken, measurement, feeder);
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
        station_calls: stationCalls,
        users
      }),
      self_cost_note_he: 'קריאת הלוח: Auth listUsers בעמוד + metrics_daily + עד 16 רשומות סך יומי ו-400 רשומות תחנות לעמוד + נתוני משתמשי העמוד. כיסוי הקריאות חלקי; שיוך למשתמשים אינו חשבונית.',
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
        const stationStart = toIsoTimestamp(current.station_aggregate_start_at);
        const globalStart = toIsoTimestamp(current.global_aggregate_start_at);
        const activateAt = stationStart || new Date(now()).toISOString();
        // Old ledgers cannot be replayed into a new total. Begin at the next Israel day.
        const globalAt = globalStart || new Date(israelDayStart(shiftCalendarDay(israelDayOf(now()), 1))).toISOString();
        if (!stationStart || !globalStart) tx.set(configRef, {
          station_aggregate_start_at: activateAt, global_aggregate_start_at: globalAt
        }, { merge: true });
        return Object.freeze({ ok: true, measurement_start_at: existing,
          station_aggregate_start_at: activateAt, global_aggregate_start_at: globalAt,
          status: 'active', locked: true, created: false });
      }
      if (current.aggregates_present === true) {
        fail('failed-precondition', 'נמצאו מונים בלי תאריך תחילת מדידה; נדרשת בדיקת מפעיל.', 'orphan-aggregates');
      }
      const start = new Date(now()).toISOString();
      tx.set(configRef, {
        measurement_start_at: start,
        station_aggregate_start_at: start,
        global_aggregate_start_at: start,
        aggregates_present: false,
        updated_at: serverTimestamp(),
        schema: 'cost-usage-config-v1'
      }, { merge: true });
      return Object.freeze({ ok: true, measurement_start_at: start, station_aggregate_start_at: start,
        global_aggregate_start_at: start,
        status: 'active', locked: true, created: true });
    });
  }

  async function paneStationCalls(requestedDay, pageToken, measurement, feeder) {
    const start = measurement.station_aggregate_start_at;
    const globalStart = measurement.global_aggregate_start_at;
    const today = israelDayOf(now());
    const day = requestedDay === undefined ? today : requestedDay;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
        !Number.isFinite(Date.parse(day + 'T00:00:00.000Z')) ||
        dayOf(Date.parse(day + 'T00:00:00.000Z')) !== day ||
        day > today || day < shiftCalendarDay(today, -(MAX_DASHBOARD_DAYS - 1))) {
      fail('invalid-argument', 'תאריך התחנה חייב להיות יום בישראל ב-30 הימים האחרונים.', 'station-day');
    }
    if (pageToken !== undefined &&
        (typeof pageToken !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(pageToken))) {
      fail('invalid-argument', 'סמן עמוד התחנות אינו תקין.', 'station-page-token');
    }
    const base = {
      id: 'station_calls', title_he: 'קריאות שרת לפי תחנה ויום',
      source: STATION_DAILY_COLLECTION, coverage: 'partial',
      selected_day: day,
      measured_callables: Object.keys(CALLABLE_FEATURES),
      station_aggregate_start_at: start, global_aggregate_start_at: globalStart,
      last_ingested_at: feeder.last_ingested_at || null,
      note_he: 'רק שלוש קריאות שרת מוגדרות נספרות. הסך היומי כולל גם תחנות היסטוריות; הרשימה מציגה עמוד של תחנות רשומות בלבד. אינו חשבונית.'
    };
    if (!start || !hasher.ready) return Object.freeze({ ...base, status: 'not_started', days: Object.freeze([]) });
    const stationQuery = db.collection('stations').orderBy('__name__');
    const pageQuery = pageToken ? stationQuery.startAfter(pageToken) : stationQuery;
    const stationSnap = await pageQuery.limit(STATION_PAGE_SIZE + 1).get();
    const pageDocs = stationSnap && Array.isArray(stationSnap.docs) ? stationSnap.docs : [];
    const visibleDocs = pageDocs.slice(0, STATION_PAGE_SIZE);
    if (visibleDocs.some(doc => !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(doc.id))) {
      return Object.freeze({ ...base, status: 'invalid_data', days: Object.freeze([]) });
    }
    const refs = [];
    const localStart = israelDayStart(day);
    const localEnd = israelDayStart(shiftCalendarDay(day, 1));
    const globalEligible = globalStart && Date.parse(globalStart) < localEnd;
    if (globalEligible) for (let shard = 0; shard < STATION_SHARDS; shard++) {
      refs.push(db.doc(GLOBAL_DAILY_COLLECTION + '/' + day + '__' + shard));
    }
    for (const station of visibleDocs) for (let shard = 0; shard < STATION_SHARDS; shard++) {
      refs.push(db.doc(STATION_DAILY_COLLECTION + '/' + day + '__' + station.id + '__' + shard));
    }
    const snapshots = refs.length ? (typeof db.getAll === 'function'
      ? await db.getAll(...refs) : await Promise.all(refs.map(ref => ref.get()))) : [];
    if (!Array.isArray(snapshots) || snapshots.length !== refs.length) {
      return Object.freeze({ ...base, status: 'invalid_data', days: Object.freeze([]) });
    }
    let offset = 0;
    let total = null;
    if (globalEligible) {
      for (let shard = 0; shard < STATION_SHARDS; shard++) {
        const snap = snapshots[offset++];
        if (!snap.exists) continue;
        const row = snap.data() || {};
        if (row.schema !== 'cost-usage-global-daily-v1' || row.day !== day || row.shard !== shard ||
            !Number.isSafeInteger(row.calls) || row.calls < 0 ||
            !Number.isSafeInteger((total || 0) + row.calls)) {
          return Object.freeze({ ...base, status: 'invalid_data', days: Object.freeze([]) });
        }
        total = (total || 0) + row.calls;
      }
    }
    const stations = [];
    for (const station of visibleDocs) {
      let calls = null;
      for (let shard = 0; shard < STATION_SHARDS; shard++) {
        const snap = snapshots[offset++];
        if (!snap.exists) continue;
        const row = snap.data() || {};
        if (row.schema !== 'cost-usage-station-daily-v1' || row.day !== day ||
            row.station_id !== station.id || row.shard !== shard ||
            !Number.isSafeInteger(row.calls) || row.calls < 0 ||
            !Number.isSafeInteger((calls || 0) + row.calls)) {
          return Object.freeze({ ...base, status: 'invalid_data', days: Object.freeze([]) });
        }
        calls = (calls || 0) + row.calls;
      }
      stations.push(Object.freeze({ station_id: station.id, calls }));
    }
    const globalDay = globalStart ? israelDayOf(Date.parse(globalStart)) : null;
    const coverage = !globalDay || day < globalDay ? 'before_start'
      : Date.parse(globalStart) > localStart ? 'partial_start_day' : 'partial_measured';
    return Object.freeze({ ...base, status: 'partial', selected_day: day,
      next_station_page_token: pageDocs.length > STATION_PAGE_SIZE ? visibleDocs.at(-1).id : null,
      days: Object.freeze([Object.freeze({ day, total: coverage === 'before_start' ? null : total,
        stations: Object.freeze(stations), coverage })]) });
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

  function canonicalEntry(entry, nowMs) {
    if (!plain(entry) || entry.schema !== 'resq_server_completion_v1' || entry.key_version !== 'v1'
        || !/^[a-f0-9]{64}$/.test(entry.event_id || '')
        || !/^[a-f0-9]{64}$/.test(entry.uid_hash || '')
        || !Object.hasOwn(CALLABLE_FEATURES, entry.callable)
        || CALLABLE_FEATURES[entry.callable] !== entry.feature
        || (entry.outcome !== 'ok' && entry.outcome !== 'failed')
        || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(entry.station_id_at_event || '')
        || Object.keys(entry).sort().join('|') !==
          'callable|event_id|feature|key_version|occurred_at|outcome|schema|station_id_at_event|uid_hash') {
      fail('invalid-argument', 'אירוע השלמה אינו עומד בחוזה השרת.', 'completion-schema');
    }
    const iso = toIsoTimestamp(entry.occurred_at);
    if (!iso) fail('invalid-argument', 'נדרש occurred_at תקין לכל אירוע.', 'occurred-at');
    const occurredMs = Date.parse(iso);
    if (occurredMs > nowMs || occurredMs < nowMs - MAX_EVENT_AGE_DAYS * DAY_MS) {
      fail('failed-precondition', 'האירוע מחוץ לחלון הקליטה של 30 יום.', 'event-age');
    }
    return {
      eventHash: entry.event_id,
      subjectHash: entry.uid_hash,
      feature: entry.feature,
      calls: 1,
      source: 'server_completion_v1',
      occurredMs,
      stationId: entry.station_id_at_event,
      outcome: entry.outcome
    };
  }

  /**
   * Idempotent batch from callable_completion (or similar ingest).
   * Each accepted event applies ledger + daily + lifetime in ONE Firestore transaction.
   * Crash mid-event rolls back; re-run is exactly-once. Parallel overlapping event_ids: exactly-once.
   * Not on the live request path.
   */
  async function recordCanonicalBatch(entries) {
    assertCanHashForWrite();
    if (!Array.isArray(entries) || !entries.length) {
      fail('invalid-argument', 'נדרשת רשימת צבירות.', 'input');
    }
    const nowMs = now();
    const configRef = db.doc(CONFIG_PATH);
    const config = dataOf(await configRef.get()) || {};
    const start = toIsoTimestamp(config.measurement_start_at);
    const stationStart = toIsoTimestamp(config.station_aggregate_start_at);
    const globalStart = toIsoTimestamp(config.global_aggregate_start_at);
    if (!start) fail('failed-precondition', 'תחילת המדידה טרם נקבעה.', 'measurement-not-started');
    for (const entry of entries) {
      if (entry.occurredMs < Date.parse(start)) {
        fail('failed-precondition', 'האירוע קודם לתחילת המדידה.', 'before-measurement-start');
      }
    }
    // The first accepted event marks configuration in its own atomic commit.
    // Subsequent events do not contend on the shared configuration document.
    let markerCommitted = config.aggregates_present === true;
    let written = 0;
    let skipped = 0;
    let maxOccurredMs = null;
    let lastEventHash = null;

    for (const entry of entries) {
      const { source, occurredMs, feature, calls, subjectHash, eventHash } = entry;
      const day = dayOf(occurredMs);
      const stationDay = israelDayOf(occurredMs);
      const expires = planDailyExpiry(day);
      const stationExpires = new Date(israelDayStart(shiftCalendarDay(stationDay, RETENTION_DAYS)));
      const ledgerExpires = planLedgerExpiry(day);
      const ledgerRef = db.doc(LEDGER_COLLECTION + '/' + eventHash);
      const dailyId = day + '__' + feature + '__' + subjectHash;
      const dailyRef = db.doc(DAILY_COLLECTION + '/' + dailyId);
      const lifeRef = db.doc(LIFETIME_COLLECTION + '/' + subjectHash);
      const stationShard = entry.stationId && stationStart && occurredMs >= Date.parse(stationStart)
        ? parseInt(eventHash.slice(0, 8), 16) % STATION_SHARDS : null;
      const stationRef = stationShard === null ? null
        : db.doc(STATION_DAILY_COLLECTION + '/' + stationDay + '__' + entry.stationId + '__' + stationShard);
      const globalShard = source === 'server_completion_v1' && stationRef && globalStart &&
        occurredMs >= Date.parse(globalStart) ? parseInt(eventHash.slice(0, 8), 16) % STATION_SHARDS : null;
      const globalRef = globalShard === null ? null
        : db.doc(GLOBAL_DAILY_COLLECTION + '/' + stationDay + '__' + globalShard);
      const fingerprint = hasher.hashEvent(JSON.stringify([eventHash, subjectHash, feature, calls, day, source,
        entry.stationId || '', entry.outcome || '']));

      const outcome = await db.runTransaction(async (tx) => {
        const liveConfig = dataOf(await tx.get(configRef)) || {};
        if (toIsoTimestamp(liveConfig.measurement_start_at) !== start ||
            toIsoTimestamp(liveConfig.station_aggregate_start_at) !== stationStart ||
            toIsoTimestamp(liveConfig.global_aggregate_start_at) !== globalStart) {
          fail('failed-precondition', 'תאריך תחילת המדידה השתנה.', 'measurement-changed');
        }
        const markConfig = !markerCommitted && liveConfig.aggregates_present !== true;
        const existingSnap = await tx.get(ledgerRef);
        if (existingSnap && existingSnap.exists) {
          const existing = dataOf(existingSnap) || {};
          if (existing.fingerprint !== fingerprint) {
            fail('failed-precondition', 'מזהה אירוע חוזר עם תוכן שונה.', 'event-collision');
          }
          return { skipped: true };
        }
        const dailySnap = await tx.get(dailyRef);
        const lifeSnap = await tx.get(lifeRef);
        const stationSnap = stationRef ? await tx.get(stationRef) : null;
        const globalSnap = globalRef ? await tx.get(globalRef) : null;
        const prevDaily = dataOf(dailySnap) || {};
        const prevDailyCalls = Number.isSafeInteger(prevDaily.calls) ? prevDaily.calls : 0;
        const prevLife = dataOf(lifeSnap) || {};
        const prevCalls = Number.isSafeInteger(prevLife.calls) ? prevLife.calls : 0;
        const stationRow = dataOf(stationSnap) || {};
        const stationCalls = Number.isSafeInteger(stationRow.calls) ? stationRow.calls : 0;
        const globalRow = dataOf(globalSnap) || {};
        const globalCalls = Number.isSafeInteger(globalRow.calls) ? globalRow.calls : 0;
        if (!Number.isSafeInteger(prevDailyCalls + calls) || !Number.isSafeInteger(prevCalls + calls) ||
            (stationRef && !Number.isSafeInteger(stationCalls + calls)) ||
            (globalRef && !Number.isSafeInteger(globalCalls + calls))) {
          fail('failed-precondition', 'מונה הקריאות הגיע למגבלת מספר בטוח.', 'count-overflow');
        }

        tx.set(ledgerRef, {
          event_hash: eventHash,
          fingerprint,
          feature,
          subject_hash: subjectHash,
          calls,
          day,
          source,
          processed_at: serverTimestamp(),
          expires_at: ledgerExpires,
          schema: 'cost-usage-batch-ledger-v1',
          keyed: true
        });
        tx.set(dailyRef, {
          day,
          feature,
          subject_hash: subjectHash,
          calls: prevDailyCalls + calls,
          expires_at: expires,
          schema: 'cost-usage-daily-v1',
          source,
          keyed: true
        }, { merge: true });
        tx.set(lifeRef, {
          subject_hash: subjectHash,
          calls: prevCalls + calls,
          since_measurement: true,
          updated_at: serverTimestamp(),
          schema: 'cost-usage-lifetime-v1',
          source,
          keyed: true
        }, { merge: true });
        if (stationRef) tx.set(stationRef, {
          day: stationDay, station_id: entry.stationId, shard: stationShard,
          calls: stationCalls + calls, expires_at: stationExpires,
          schema: 'cost-usage-station-daily-v1', source: 'server_completion_v1'
        }, { merge: true });
        if (globalRef) tx.set(globalRef, {
          day: stationDay, shard: globalShard, calls: globalCalls + calls, expires_at: stationExpires,
          schema: 'cost-usage-global-daily-v1', source: 'server_completion_v1'
        }, { merge: true });
        if (markConfig) tx.set(configRef, { aggregates_present: true, schema: 'cost-usage-config-v1' }, { merge: true });
        return { skipped: false };
      });

      if (outcome.skipped) {
        skipped += 1;
      } else {
        markerCommitted = true;
        written += 1;
        if (maxOccurredMs === null || occurredMs > maxOccurredMs) maxOccurredMs = occurredMs;
        lastEventHash = eventHash;
      }
    }

    await db.doc(BATCH_CURSOR_PATH).set({
      cursor_kind: 'diagnostic_only_not_source_resume',
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
      source: entries.every((entry) => entry.source === entries[0].source) ? entries[0].source : 'mixed',
      idempotent: true,
      atomic: true
    });
  }

  async function recordAttributedCallsBatch(entries) {
    assertCanHashForWrite();
    if (!Array.isArray(entries) || !entries.length) fail('invalid-argument', 'נדרשת רשימת צבירות.', 'input');
    const nowMs = now();
    const canonical = entries.map((entry) => {
      const { source, occurredMs } = validateBatchEntry(entry, nowMs);
      return {
        eventHash: hasher.hashEvent(entry.event_id),
        subjectHash: hasher.hashScope(entry.subject_id),
        feature: entry.feature, calls: entry.calls, source, occurredMs
      };
    });
    return recordCanonicalBatch(canonical);
  }

  async function recordServerCompletionEventsBatch(events) {
    assertCanHashForWrite();
    if (!Array.isArray(events) || !events.length) fail('invalid-argument', 'נדרשת רשימת אירועים.', 'input');
    return recordCanonicalBatch(events.map((event) => canonicalEntry(event, now())));
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
      for (const col of [DAILY_COLLECTION, LEDGER_COLLECTION, STATION_DAILY_COLLECTION, GLOBAL_DAILY_COLLECTION]) {
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
      collections: Object.freeze([DAILY_COLLECTION, LEDGER_COLLECTION, STATION_DAILY_COLLECTION, GLOBAL_DAILY_COLLECTION]),
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
    recordServerCompletionEventsBatch,
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
    FEEDER_STATE_PATH,
    DAILY_COLLECTION,
    STATION_DAILY_COLLECTION,
    GLOBAL_DAILY_COLLECTION,
    STATION_SHARDS,
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
  FEEDER_STATE_PATH: 'cost_usage_config/feeder',
  DAILY_COLLECTION: 'cost_usage_daily',
  STATION_DAILY_COLLECTION: 'cost_usage_station_daily',
  GLOBAL_DAILY_COLLECTION: 'cost_usage_global_daily',
  STATION_SHARDS,
  LIFETIME_COLLECTION: 'cost_usage_lifetime',
  LEDGER_COLLECTION: 'cost_usage_batch_ledger',
  FEATURE_LABELS,
  MIN_HMAC_KEY_LEN,
  toIsoTimestamp
});
