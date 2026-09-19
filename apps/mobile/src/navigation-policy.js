// מדיניות ניווט של מעטפת החנות — מודול טהור, בלי Capacitor, בלי DOM.
//
// שני תפקידים בלבד:
//   classifyNavigation(url, approvedOrigin) → 'internal' | 'external' | 'blocked'
//   deepLinkTarget(url, approvedOrigin)     → נתיב יחסי בתוך ה-PWA
//
// עיקרון: המודול לעולם אינו מעביר query string שרירותי. הוא בונה את
// היעד מחדש משדות שעברו regex סגור, ומשליך כל השאר.
//
// תבנית הטוקן זהה ל-join-ui.js (16 תווים, נקודה, 43 תווים). התבנית
// הרחבה שהוצעה בתכנון (^[A-Za-z0-9_-]{16,200}$) הייתה דוחה כל טוקן
// אמיתי בגלל הנקודה, ולכן לא אומצה.

export const START_URL = './login.html';
export const JOIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/;
export const READINESS_NONCE_PATTERN = /^[a-f0-9]{32}$/;
export const CUSTOM_SCHEME = 'resq';

const ROUTES = Object.freeze({
  join: Object.freeze({ path: '/login.html', param: 'join', pattern: JOIN_TOKEN_PATTERN,
    build: (v) => './login.html?join=' + v }),
  readiness: Object.freeze({ path: '/device-readiness.html', param: 'readiness_nonce',
    pattern: READINESS_NONCE_PATTERN, build: (v) => './device-readiness.html?readiness_nonce=' + v }),
  alerts: Object.freeze({ path: '/alerts.html', param: null, pattern: null, build: () => './alerts.html' })
});

function parse(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  // תווי בקרה ו-backslash אינם חלק משום קישור שה-PWA מייצרת. WHATWG
  // מנרמל backslash ל-slash בסכמות מיוחדות, וזה בדיוק הבלבול שמנצלים.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  try { return new URL(value); } catch (ignore) { return null; }
}

function parseOrigin(approvedOrigin) {
  const o = parse(approvedOrigin);
  if (!o || o.protocol !== 'https:' || o.username || o.password) return null;
  return o;
}

export function classifyNavigation(url, approvedOrigin) {
  const approved = parseOrigin(approvedOrigin);
  if (!approved) return 'blocked';
  const u = parse(url);
  if (!u) return 'blocked';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'blocked';
  // userinfo לפני @ הוא תרגיל הסוואה: "https://station-102.web.app@evil.com".
  // URL מפענח נכון (המארח הוא evil.com), אבל גם כשהמארח נכון — נחסם.
  if (u.username || u.password) return 'blocked';
  // אותו מארח ב-http או בפורט אחר: לא "חיצוני" אלא ניסיון הורדת דרגה.
  if (u.hostname === approved.hostname && u.origin !== approved.origin) return 'blocked';
  if (u.origin === approved.origin) return 'internal';
  return 'external';
}

function pickRoute(pathname) {
  for (const key of Object.keys(ROUTES)) {
    if (ROUTES[key].path === pathname) return ROUTES[key];
  }
  return null;
}

function buildTarget(route, rawValue) {
  if (!route) return START_URL;
  if (!route.param) return route.build();
  const value = typeof rawValue === 'string' ? rawValue : '';
  if (!route.pattern.test(value)) return START_URL;
  return route.build(value);
}

export function deepLinkTarget(url, approvedOrigin) {
  const u = parse(url);
  if (!u) return START_URL;

  if (u.protocol === CUSTOM_SCHEME + ':') {
    // resq://join?join=<token> · resq://readiness?readiness_nonce=<hex> · resq://alerts
    const host = String(u.hostname || '').toLowerCase();
    const route = ROUTES[host] || null;
    if (!route) return START_URL;
    return buildTarget(route, route.param ? u.searchParams.get(route.param) : '');
  }

  if (classifyNavigation(url, approvedOrigin) !== 'internal') return START_URL;
  const route = pickRoute(u.pathname);
  if (!route) return START_URL;
  return buildTarget(route, route.param ? u.searchParams.get(route.param) : '');
}

export function routeTable() {
  return Object.keys(ROUTES).map((id) => ({
    id, path: ROUTES[id].path, query_param: ROUTES[id].param,
    value_pattern: ROUTES[id].pattern ? ROUTES[id].pattern.source : null
  }));
}
