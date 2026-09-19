'use strict';
/* קטלוג מדדים תפעוליים — אוצר מילים סגור בלבד.
 *
 * שכבת המדדים סופרת אירועים טכניים בלבד. אין בה שדות חופשיים: כל שדה
 * מאורע הוא ערך מתוך רשימה סגורה או מספר שמעוגל למדרגה. שם, דוא"ל,
 * טלפון, מספר עובד, UID גולמי, טוקן פוש, טקסט הודעה, סיבה רפואית, טקסט
 * טופס, stack או כתובת אינטרנט — אינם יכולים להיכנס בבנייה, ובנוסף
 * `assertNoPii` דוחה כל ערך שנראה כמו מידע אישי, כהגנה בעומק.
 *
 * הגרסאות והמסכים נלקחים מחוזה הטלמטריה הקיים ולא משוכפלים.
 */

const telemetry = require('./ops-telemetry-contract');

const EVENT_CODES = Object.freeze([
  'login_success', 'login_failure',
  'onboarding_started', 'onboarding_completed',
  'device_readiness_started', 'device_readiness_completed',
  'push_queued', 'push_delivered', 'push_failed',
  'schedule_import_started', 'schedule_import_completed', 'schedule_publish_completed',
  'callout_started', 'callout_closed',
  'client_error'
]);
const RESULTS = Object.freeze(['ok', 'fail']);
const FIELDS = Object.freeze(['event_code', 'result', 'duration_bucket_ms', 'release', 'screen']);
const DURATION_BUCKETS_MS = Object.freeze([0, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]);
const MAX_BUCKET_MS = DURATION_BUCKETS_MS[DURATION_BUCKETS_MS.length - 1];
const { VERSIONS, SCREENS } = telemetry;

/* שמות שדות שאסורים בבנייה. הרשימה משמשת את בדיקת המקור ואת assertNoPii. */
const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'name', 'full_name', 'email', 'phone', 'employee_number', 'emp', 'uid', 'token', 'push_token',
  'message', 'text', 'reason', 'medical', 'form', 'stack', 'url', 'href', 'query', 'station_id', 'stationId'
]);

const MAX_STRING_LENGTH = 32;
const PII_PATTERNS = Object.freeze([
  /@/, /\d{6,}/, /http/i, /\?/, /[֐-׿]/
]);

class MetricsCatalogError extends Error {
  constructor(reason, message) { super(message); this.name = 'MetricsCatalogError'; this.reason = reason; this.httpCode = 'invalid-argument'; }
}
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** עיגול כלפי מעלה למדרגה הקרובה; מעבר למדרגה האחרונה נחתך אליה. */
function bucketOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  for (const bucket of DURATION_BUCKETS_MS) if (ms <= bucket) return bucket;
  return MAX_BUCKET_MS;
}

/** הגנה בעומק: מחרוזת ארוכה, @, שש ספרות רצופות, http, ? או עברית — נדחים בכל שדה שאינו enum. */
function assertNoPii(event) {
  if (!plain(event)) throw new MetricsCatalogError('input', 'מאורע חייב להיות אובייקט.');
  for (const key of Object.keys(event)) {
    if (FORBIDDEN_FIELD_NAMES.indexOf(key) !== -1) throw new MetricsCatalogError('input', 'שדה אסור במאורע: ' + key);
    const value = event[key];
    if (typeof value === 'string') {
      if (value.length > MAX_STRING_LENGTH) throw new MetricsCatalogError('pii', 'ערך ארוך מדי בשדה ' + key);
      if (PII_PATTERNS.some((re) => re.test(value))) throw new MetricsCatalogError('pii', 'ערך חופשי אינו מותר בשדה ' + key);
    } else if (typeof value !== 'number' && value !== undefined) {
      throw new MetricsCatalogError('input', 'סוג ערך אינו מותר בשדה ' + key);
    }
  }
  return true;
}

/** מנרמל מאורע אחד לצורה הסגורה. כל סטייה — שגיאת קלט; קוד לא מוכר — שגיאת event-code. */
function normalizeEvent(event) {
  if (!plain(event)) throw new MetricsCatalogError('input', 'מאורע חייב להיות אובייקט.');
  const keys = Object.keys(event);
  if (keys.some((k) => FIELDS.indexOf(k) === -1)) throw new MetricsCatalogError('input', 'מאורע מכיל שדה שאינו בקטלוג.');
  assertNoPii(event);
  if (typeof event.event_code !== 'string' || EVENT_CODES.indexOf(event.event_code) === -1) {
    throw new MetricsCatalogError('event-code', 'קוד מאורע אינו מוכר.');
  }
  if (event.result !== undefined && RESULTS.indexOf(event.result) === -1) throw new MetricsCatalogError('input', 'תוצאה חייבת להיות ok או fail.');
  let bucket = null;
  if (event.duration_bucket_ms !== undefined) {
    bucket = bucketOf(event.duration_bucket_ms);
    if (bucket === null) throw new MetricsCatalogError('input', 'משך חייב להיות מספר אי-שלילי.');
  }
  if (event.release !== undefined && typeof event.release !== 'string') throw new MetricsCatalogError('input', 'גרסה חייבת להיות מחרוזת.');
  if (event.screen !== undefined && typeof event.screen !== 'string') throw new MetricsCatalogError('input', 'מסך חייב להיות מחרוזת.');
  return Object.freeze({
    event_code: event.event_code,
    result: event.result === undefined ? 'ok' : event.result,
    duration_bucket_ms: bucket,
    release: telemetry.finite(event.release, VERSIONS),
    screen: telemetry.finite(event.screen, SCREENS)
  });
}

module.exports = Object.freeze({
  EVENT_CODES, RESULTS, FIELDS, DURATION_BUCKETS_MS, MAX_BUCKET_MS, VERSIONS, SCREENS,
  FORBIDDEN_FIELD_NAMES, MAX_STRING_LENGTH, MetricsCatalogError, bucketOf, assertNoPii, normalizeEvent
});
