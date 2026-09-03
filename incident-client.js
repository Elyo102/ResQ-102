/* ======================================================================
 * דיווח תקלות מהדפדפן → `reportIncident`.
 *
 * כל מסך כבר מציג שגיאות בפס אדום (ה-IIFE בראש ה-body). הפס מציג;
 * המודול הזה **מדווח**. הוא מאזין לאותם שני אירועים — `error`
 * ו-`unhandledrejection` — ומוסיף דיווח על קריאת שרת שנכשלה דרך
 * `wrapCallable`.
 *
 * מה יוצא מכאן: סוג, מסך, גרסה, קוד, הודעה (עד 300 תווים), ומיקום
 * (קובץ:שורה, בלי מחרוזת שאילתה). ⭐ לא uid, לא שם, לא דוא"ל — השרת
 * דוחה כל שדה נוסף, ומנקה דפוסים גם ממה שכן נשלח.
 *
 * מה לא יוצא מכאן: אותה תקלה פעמיים באותו דף (מונע לולאה), יותר
 * מ-`maxPerLoad` דיווחים לטעינה, וכישלון של הדיווח עצמו — כישלון
 * כזה נבלע בשקט, כי דיווח שנכשל ומייצר דחייה חדשה הוא לולאה.
 * ====================================================================== */

const MAX_MESSAGE = 300;
const MAX_FRAME = 200;
const SKIP_CODES = ['functions/unauthenticated'];

function cut(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

/* קובץ:שורה מהשורה הראשונה ב-stack שמצביעה על קובץ שלנו. מסירים
 * מקור (origin) ומחרוזת שאילתה; הם אינם מזהים את התקלה. */
export function topFrame(error, fallback) {
  const stack = error && typeof error.stack === 'string' ? error.stack : '';
  const lines = stack.split('\n');
  for (const line of lines) {
    const m = line.match(/([A-Za-z0-9_.\-]+\.(?:m?js|html))(?:\?[^:)\s]*)?:(\d+)(?::\d+)?/);
    if (m) return cut(m[1] + ':' + m[2], MAX_FRAME);
  }
  return cut(fallback || '', MAX_FRAME);
}

export function screenName(href) {
  const path = String(href || (typeof location !== 'undefined' ? location.pathname : '') || '');
  const file = path.split('/').pop() || 'index.html';
  return /^[a-z0-9-]{1,48}\.html$/.test(file) ? file : 'index.html';
}

/* בונה את גוף הדיווח. טהור, נבדק לבד. */
export function buildReport(kind, error, context) {
  const ctx = context || {};
  const err = error && typeof error === 'object' ? error : { message: String(error == null ? '' : error) };
  const code = cut(err.code || err.name || '', 80).replace(/[^A-Za-z0-9_\-/.:]/g, '');
  const message = cut(err.message || '', MAX_MESSAGE);
  return {
    kind,
    screen: screenName(ctx.href),
    version: cut(ctx.version || '0', 24),
    code,
    message: message || (code ? '' : 'unknown'),
    frame: topFrame(err, ctx.frame),
    callable: cut(ctx.callable || '', 64)
  };
}

export function createIncidentReporter(options) {
  const o = options || {};
  const callable = typeof o.report === 'function' ? o.report : null;
  const version = o.version || '0';
  const maxPerLoad = Number(o.maxPerLoad || 10);
  const seen = new Set();
  let sent = 0;
  let installed = false;

  async function send(kind, error, context) {
    if (!callable) return false;
    const body = buildReport(kind, error, Object.assign({ version }, context || {}));
    if (kind === 'callable-failed' && SKIP_CODES.indexOf(body.code) !== -1) return false;
    const key = body.kind + '|' + body.screen + '|' + body.code + '|' + body.message.replace(/\d+/g, '#');
    if (seen.has(key) || sent >= maxPerLoad) return false;
    seen.add(key);
    sent += 1;
    try {
      await callable(body);
      return true;
    } catch (ignore) {
      return false;
    }
  }

  function install(target) {
    const win = target || (typeof window !== 'undefined' ? window : null);
    if (!win || installed) return;
    installed = true;
    win.addEventListener('error', (e) => {
      const err = e && e.error ? e.error : { message: e && e.message, name: 'Error' };
      send('client-error', err, { frame: (e && e.filename ? screenName(e.filename) : '') + ':' + (e && e.lineno || 0) });
    });
    win.addEventListener('unhandledrejection', (e) => {
      send('unhandled-rejection', e && e.reason, {});
    });
  }

  /* עוטף `httpsCallable(fns, name)`: כישלון מדווח ואז נזרק הלאה כרגיל. */
  function wrapCallable(name, fn) {
    return async function wrapped(data) {
      try {
        return await fn(data);
      } catch (error) {
        send('callable-failed', error, { callable: name });
        throw error;
      }
    };
  }

  return Object.freeze({
    install,
    wrapCallable,
    report: (error, context) => send('manual', error, context || {}),
    stats: () => ({ sent, seen: seen.size, maxPerLoad })
  });
}

/* חיבור בשורה אחת מתוך מסך:
 *   const incidents = installIncidentReporter({ fns, httpsCallable, version: APP_VERSION });
 * ואז `incidents.wrapCallable('name', httpsCallable(fns, 'name'))` לפעולות שרוצים לעקוב אחריהן. */
export function installIncidentReporter(options) {
  const o = options || {};
  const report = o.fns && typeof o.httpsCallable === 'function'
    ? o.httpsCallable(o.fns, 'reportIncident') : null;
  const reporter = createIncidentReporter({
    report: report ? (body) => report(body) : null,
    version: o.version,
    maxPerLoad: o.maxPerLoad
  });
  reporter.install(o.window);
  return reporter;
}
