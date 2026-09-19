// מדדים תפעוליים — משדר צד לקוח.
// יוצא מהדפדפן רק מה שבקטלוג הסגור: קוד מאורע, תוצאה, מדרגת משך (מספר),
// גרסה ומסך. שום שם, דוא"ל, טלפון, מספר עובד, UID, טוקן, טקסט, שגיאה או
// כתובת אינם נקראים ואינם נשלחים. השרת אוכף את אותו קטלוג בעצמו.
// המודול אינו מחובר לשום מסך בגרסה זו — ההחלטה על חיבור נפרדת.

export const METRICS_EVENT_CODES = Object.freeze([
  'login_success', 'login_failure',
  'onboarding_started', 'onboarding_completed',
  'device_readiness_started', 'device_readiness_completed',
  'push_queued', 'push_delivered', 'push_failed',
  'schedule_import_started', 'schedule_import_completed', 'schedule_publish_completed',
  'callout_started', 'callout_closed',
  'client_error'
]);
export const METRICS_RESULTS = Object.freeze(['ok', 'fail']);
export const METRICS_DURATION_BUCKETS_MS = Object.freeze([0, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]);
export const METRICS_MAX_BATCH = 20;
export const METRICS_FLUSH_MS = 10000;
const REQUEST_ID_RE = /^rd_[a-f0-9]{40}$/;

function allowed(value, values, fallback) {
  return typeof value === 'string' && values.includes(value) ? value : fallback;
}
export function bucketOf(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  for (const bucket of METRICS_DURATION_BUCKETS_MS) if (ms <= bucket) return bucket;
  return METRICS_DURATION_BUCKETS_MS[METRICS_DURATION_BUCKETS_MS.length - 1];
}
function hex40(random) {
  if (typeof random === 'function') { const v = String(random()); if (/^[a-f0-9]{40}$/.test(v)) return v; }
  const bytes = new Uint8Array(20);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function newRequestId(random) {
  const id = 'rd_' + hex40(random);
  return REQUEST_ID_RE.test(id) ? id : 'rd_' + '0'.repeat(40);
}

/** בונה מאורע סגור. מחזיר null אם הקוד אינו בקטלוג — המאורע נזרק בשקט. */
export function buildEvent(eventCode, options, context) {
  const o = options || {};
  const ctx = context || {};
  if (!allowed(eventCode, METRICS_EVENT_CODES, null)) return null;
  const out = { event_code: eventCode, result: allowed(o.result, METRICS_RESULTS, 'ok') };
  const bucket = bucketOf(o.duration_ms);
  if (bucket !== null) out.duration_bucket_ms = bucket;
  if (typeof ctx.release === 'string' && /^[A-Za-z0-9.]{1,24}$/.test(ctx.release)) out.release = ctx.release;
  if (typeof ctx.screen === 'string' && /^[a-z-]{1,40}\.html$/.test(ctx.screen)) out.screen = ctx.screen;
  return Object.freeze(out);
}

/**
 * createMetricsRecorder({ callable, release, screen, isSignedIn, window, setTimeout, clearTimeout, random })
 * - record(event_code, { result, duration_ms }) — נכנס למאגר; מאגר מלא (20) משוגר מיד.
 * - flush() — שיגור אחד, request_id אחד לכל שיגור. לא מחובר → המאגר מתרוקן בלי שליחה.
 * - install() — visibilitychange (hidden) / pagehide משגרים; טיימר 10 שניות אחרי המאורע הראשון.
 */
export function createMetricsRecorder(options) {
  const o = options || {};
  const callable = typeof o.callable === 'function' ? o.callable : null;
  const isSignedIn = typeof o.isSignedIn === 'function' ? o.isSignedIn : () => false;
  const setT = typeof o.setTimeout === 'function' ? o.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof o.clearTimeout === 'function' ? o.clearTimeout : (id) => clearTimeout(id);
  const context = { release: o.release, screen: o.screen };
  let buffer = [];
  let timer = null;
  let installed = false;
  let inFlight = false;
  const stats = { recorded: 0, dropped: 0, flushes: 0, sent: 0, skipped_signed_out: 0, failed: 0 };

  function clearTimer() { if (timer !== null) { clearT(timer); timer = null; } }
  function armTimer() { if (timer === null) timer = setT(() => { timer = null; void flush(); }, METRICS_FLUSH_MS); }

  async function flush() {
    clearTimer();
    if (!buffer.length || inFlight) return false;
    const events = buffer;
    buffer = [];
    // מנותק — לא שולחים דבר, וגם לא שומרים לשליחה מאוחרת בשם משתמש אחר.
    if (!callable || !isSignedIn()) { stats.skipped_signed_out += 1; stats.dropped += events.length; return false; }
    inFlight = true;
    stats.flushes += 1;
    try {
      await callable({ request_id: newRequestId(o.random), events });
      stats.sent += events.length;
      return true;
    } catch (ignore) {
      stats.failed += 1; stats.dropped += events.length;
      return false;
    } finally {
      inFlight = false;
      if (buffer.length) armTimer();
    }
  }

  function record(eventCode, details) {
    const event = buildEvent(eventCode, details, context);
    if (!event) { stats.dropped += 1; return false; }
    if (!isSignedIn()) { stats.dropped += 1; return false; }
    buffer.push(event);
    stats.recorded += 1;
    if (buffer.length >= METRICS_MAX_BATCH) { void flush(); return true; }
    armTimer();
    return true;
  }

  function install(target) {
    const win = target || o.window || (typeof window !== 'undefined' ? window : null);
    if (!win || installed || typeof win.addEventListener !== 'function') return false;
    installed = true;
    const doc = win.document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') void flush(); });
    }
    win.addEventListener('pagehide', () => { void flush(); });
    return true;
  }

  return Object.freeze({
    record, flush, install,
    pending: () => buffer.length,
    stats: () => Object.assign({}, stats)
  });
}
