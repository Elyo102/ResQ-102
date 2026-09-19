// גשר פוש של המעטפת — ממשק אחיד + מימוש מזויף לבדיקות.
//
// ממשק:
//   requestPermission()          → Promise<'granted' | 'denied'>
//   getToken()                   → Promise<string>
//   onMessage(cb)                → unsubscribe()   (הודעה בחזית)
//   onNotificationOpened(cb)     → unsubscribe()   (לחיצה על התראה)
//
// createNativePushBridge אינו ממומש בכוונה. הוא זורק
// 'not-implemented-requires-store-account' כדי שאף בנייה לא תשלח בשקט
// גשר ייצור בלי חשבון חנות, מפתח APNs ו-google-services.json — שאף
// אחד מהם אינו בריפו ולא יהיה.
//
// עד אז: ההתראות מגיעות דרך firebase-messaging-sw.js של ה-PWA, וה-payload
// הוא data בלבד (title/body/url/tag/important) — בדיוק כמו בעובד.

export const NATIVE_NOT_IMPLEMENTED = 'not-implemented-requires-store-account';

const PAYLOAD_FIELDS = ['title', 'body', 'url', 'tag', 'important', 'nonce'];

function sanitizePayload(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const key of PAYLOAD_FIELDS) {
    if (typeof src[key] === 'string' && src[key].length <= 2048) out[key] = src[key];
  }
  return Object.freeze(out);
}

export function createFakePushBridge(options) {
  const o = options || {};
  const seed = typeof o.seed === 'string' && /^[a-z0-9-]{1,40}$/.test(o.seed) ? o.seed : 'default';
  const permissionAnswer = o.permission === 'denied' ? 'denied' : 'granted';
  const messageListeners = new Set();
  const openedListeners = new Set();
  const log = [];
  let permission = 'prompt';
  let tokenIssueCount = 0;

  function token() {
    // דטרמיניסטי: אותו seed → אותו טוקן, בלי אקראיות ובלי זמן.
    return 'fake-native-token-' + seed + '-' + String(tokenIssueCount).padStart(4, '0');
  }

  return {
    kind: 'fake',
    async requestPermission() {
      permission = permissionAnswer;
      log.push({ type: 'permission', value: permission });
      return permission;
    },
    async getToken() {
      if (permission !== 'granted') throw new Error('permission-not-granted');
      tokenIssueCount += 1;
      const t = token();
      log.push({ type: 'token', value: t });
      return t;
    },
    onMessage(cb) {
      if (typeof cb !== 'function') throw new TypeError('onMessage requires a function');
      messageListeners.add(cb);
      return function () { messageListeners.delete(cb); };
    },
    onNotificationOpened(cb) {
      if (typeof cb !== 'function') throw new TypeError('onNotificationOpened requires a function');
      openedListeners.add(cb);
      return function () { openedListeners.delete(cb); };
    },
    // סימולציה לבדיקות בלבד: emit('message', {...}) או emit('opened', {...}).
    emit(kind, payload) {
      const clean = sanitizePayload(payload);
      const set = kind === 'message' ? messageListeners
        : kind === 'opened' ? openedListeners : null;
      if (!set) throw new Error('unknown-emit-kind');
      log.push({ type: 'emit', kind, payload: clean });
      let delivered = 0;
      for (const cb of Array.from(set)) { cb(clean); delivered += 1; }
      return delivered;
    },
    state() {
      return { permission, tokenIssueCount, listeners: messageListeners.size + openedListeners.size,
        log: log.slice() };
    }
  };
}

export function createNativePushBridge() {
  const err = new Error(NATIVE_NOT_IMPLEMENTED);
  err.code = NATIVE_NOT_IMPLEMENTED;
  throw err;
}
