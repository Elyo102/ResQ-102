// 42H.20 §5.4 · "הכל / לא נצפו / קריאות פתע" — פילטרים על מסך ההתראות
// הקיים (alerts.html), לא מנגנון הודעות מקביל חדש.
//
// שני מקורות בלבד, שני מנגנוני צפייה שכבר קיימים ואמיתיים:
//   בלוח מודעות   קבלה אמיתית לכל הודעה, לכל משתמש — bulletin-receipts.js
//                 (`stations/{sid}/bulletin_view_receipts/{messageId}/
//                 bulletin_view_recipients/{uid}`), נכתבת רק כשההודעה
//                 באמת נראתה על המסך (IntersectionObserver ב-bulletin.js).
//   קריאת פתע     מסמך תגובה פרטי לכל נמען — callout.js (`markCalloutSeen`)
//                 כותב `seen_at` על `.../callouts/{id}/responses/{uid}`.
//
// שתי השאילתות כאן זהות בצורתן לשאילתות שכבר קיימות ונבדקות
// (bulletin.js's messagesQuery, callout.js's watchCallouts) — כדי לא
// לדרוש אינדקס Firestore חדש שלא נפרס. "קריאות פתע" בפיד כולל גם
// קריאות פעילות וגם קריאות שנסגרו (active===false): השאילתה מוותרת
// על תנאי ה-active ומשתמשת ב-`{uids array-contains, created_key desc}`
// — אינדקס שכבר קיים ב-firestore.indexes.json (בשימוש גם היום, בלי
// תנאי active, למקורות אחרים) — כך שאין צורך באינדקס מורכב חדש.
//
// 42H.20 · ביקורת Codex, חוסם 3: הקריאה עצמה עברה לשרת (getAlertsFeed).
// הקובץ הזה מחזיק את העזרים הטהורים, את הלואדר החד-קריאה ואת מעקב
// ההצגה שמזין את קבלת הצפייה — ראה למטה.

export const ALERT_FEED_FILTERS = Object.freeze([
  { id: 'all', he: 'הכל' },
  { id: 'unread', he: 'לא נצפו' },
  { id: 'callout', he: 'קריאות פתע' }
]);

const BOARD_MESSAGE_LIMIT = 10;
const CALLOUT_LIMIT = 25;
const FEED_LIMIT = 30;

// --- Pure helpers (unit-tested without a browser or Firestore) ---

export function bulletinFeedItem(boardId, boardName, id, data, viewed, timeMs) {
  const value = data || {};
  return {
    kind: 'bulletin', id: boardId + '/' + id, board_id: boardId, board_name: String(boardName || boardId),
    text: String(value.text || ''), by_name: String(value.by_name || value.author_name || 'חבר צוות'),
    time_ms: Number(timeMs) || 0, viewed: !!viewed
  };
}

export function calloutFeedItem(id, data, viewed, timeMs) {
  const value = data || {};
  return {
    kind: 'callout', id: String(id), text: String(value.text || ''),
    active: value.active !== false, by_name: String(value.by_name || ''),
    time_ms: Number(timeMs) || 0, viewed: !!viewed
  };
}

export function mergeFeedItems(bulletinItems, calloutItems, limitCount) {
  const cap = Number.isFinite(limitCount) && limitCount > 0 ? limitCount : FEED_LIMIT;
  return [].concat(Array.isArray(bulletinItems) ? bulletinItems : [],
    Array.isArray(calloutItems) ? calloutItems : [])
    .sort(function (a, b) { return b.time_ms - a.time_ms; })
    .slice(0, cap);
}

export function applyFeedFilter(items, filterId) {
  const list = Array.isArray(items) ? items : [];
  if (filterId === 'unread') return list.filter(function (item) { return !item.viewed; });
  if (filterId === 'callout') return list.filter(function (item) { return item.kind === 'callout'; });
  return list;
}

// Drives the bell's unread indicator — the exact same filter as the "לא
// נצפו" tab, never a second computation of "unread".
export function unreadFeedCount(items) {
  return applyFeedFilter(items, 'unread').length;
}

// --- Server-backed loader (42H.20 · Codex review, blocker 3) ---
//
// עד כאן הקובץ הזה קרא בעצמו, מהדפדפן, את `bulletin_view_receipts/…/{uid}`
// — נתיב ש-firestore.rules חוסם לחלוטין (allow read, write: if false).
// השגיאה נבלעה, וכל הודעה שנצפתה הוצגה כ"לא נצפתה"; ובנוסף כל רענון
// (login.html, כל 90 שניות) הריץ קריאת מסמך אחת לכל הודעה ולכל קריאת
// פתע (N+1), ומונה שנגזר מ-30 פריטים בלבד.
//
// עכשיו: קריאה שרתית אחת (`getAlertsFeed`, functions/bulletin-receipts.js
// alertsFeed) מחזירה את הפיד עם מצב הצפייה **שלי** בלבד, אחרי אימות
// schema/תוקף של הקבלה בשרת, ו-unread_count שנספר על כל חלון המועמדים.
// הקבלות עצמן נשארות חסומות לדפדפן. כשל = שגיאה ללקוח, לא "unread".

export const FEED_SCHEMA = 'alerts-feed-v1';
const MAX_ITEMS = 30;

function finiteInt(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

// אימות צורת התשובה מהשרת — לא סומכים על JSON כפי שהגיע. תשובה לא
// תקינה זורקת, כדי שהמסך יציג שגיאה ולא "0 לא נצפו" מזויף.
export function normalizeFeedResponse(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!value || value.schema !== FEED_SCHEMA) throw new Error('alerts-feed: unexpected response schema');
  if (!Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw new Error('alerts-feed: items invalid');
  if (!finiteInt(value.unread_count, 0, 100000)) throw new Error('alerts-feed: unread_count invalid');
  const items = value.items.map(function (item) {
    if (!item || typeof item !== 'object') throw new Error('alerts-feed: item invalid');
    if (item.kind === 'bulletin') {
      if (typeof item.board_id !== 'string' || typeof item.id !== 'string' || item.id.indexOf('/') < 1) {
        throw new Error('alerts-feed: bulletin item invalid');
      }
      return bulletinFeedItem(item.board_id, item.board_name, item.id.slice(item.board_id.length + 1),
        { text: item.text, by_name: item.by_name }, item.viewed === true, item.time_ms);
    }
    if (item.kind === 'callout') {
      if (typeof item.id !== 'string' || !item.id) throw new Error('alerts-feed: callout item invalid');
      return calloutFeedItem(item.id, { text: item.text, by_name: item.by_name, active: item.active !== false },
        item.viewed === true, item.time_ms);
    }
    throw new Error('alerts-feed: unknown item kind');
  });
  return { items: items, unread_count: value.unread_count };
}

// `callable` הוא httpsCallable(fns, 'getAlertsFeed') שכבר נבנה על ידי
// הקורא (הזרקה, כדי שהקובץ יישאר נבדק בלי Firebase). קריאה אחת בלבד;
// שום getDoc/getDocs מהדפדפן.
export async function loadAlertsFeed(callable) {
  if (typeof callable !== 'function') throw new TypeError('alerts-feed: callable is required');
  const response = await callable({});
  return normalizeFeedResponse(response && response.data);
}

// --- Display tracking (blocker 3.4 / 8) ---
//
// "הוצג" הוא מה שמסך ההתראות מוכיח, לא מה שהוא מרנדר: פריט נחשב
// כמוצג רק אחרי ≥60% נראות ברצף במשך dwellMs (ברירת מחדל 1000ms) בזמן
// שהלשונית גלויה — אותו כלל בדיוק שכבר אוכף bulletin.js על לוח
// המודעות (observeDisplayedMessages). הקבלה נשלחת פעם אחת לכל פריט
// לכל טעינת מסך; רענון של הרשימה אינו שולח שוב פריט שכבר אושר.
export function createDisplayTracker(options) {
  const opts = options || {};
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const dwellMs = Number.isFinite(opts.dwellMs) ? opts.dwellMs : 1000;
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.6;
  const markViewed = typeof opts.markViewed === 'function' ? opts.markViewed : null;
  const ObserverCtor = opts.IntersectionObserver
    || (typeof IntersectionObserver === 'function' ? IntersectionObserver : null);
  const confirmed = new Set();
  const pending = new Set();
  const timers = new Map();
  let observer = null;
  const hidden = function () { return !doc || doc.visibilityState === 'hidden'; };

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    timers.forEach(function (timer) { clearTimeout(timer); });
    timers.clear();
  }
  function onEntries(entries) {
    entries.forEach(function (entry) {
      const node = entry.target;
      const key = node && node.dataset ? node.dataset.feedId : '';
      if (!key || confirmed.has(key) || pending.has(key)) return;
      if (!entry.isIntersecting || entry.intersectionRatio < threshold || hidden()) {
        clearTimeout(timers.get(key));
        timers.delete(key);
        return;
      }
      if (timers.has(key)) return;
      timers.set(key, setTimeout(async function () {
        timers.delete(key);
        if (hidden() || !node.isConnected) return;
        pending.add(key);
        try {
          await markViewed({ kind: node.dataset.feedKind, id: key, board_id: node.dataset.feedBoard || '',
            message_id: node.dataset.feedMessage || '' });
          confirmed.add(key);
          node.dataset.viewed = 'true';
          if (typeof opts.onConfirmed === 'function') opts.onConfirmed(key);
        } catch (ignore) {
          // הקבלה היא טלמטריה; כשל בה לעולם לא שובר את המסך. הפריט
          // יישאר "טרם נצפה" — ואפשר לנסות שוב בהצגה הבאה.
        } finally {
          pending.delete(key);
        }
      }, dwellMs));
    });
  }
  function observe(container) {
    stop();
    if (!markViewed || !ObserverCtor || hidden() || !container) return;
    observer = new ObserverCtor(onEntries, { root: null, threshold: [threshold] });
    container.querySelectorAll('[data-feed-id][data-viewed="false"]').forEach(function (node) {
      observer.observe(node);
    });
  }
  return { observe: observe, stop: stop, confirmed: confirmed, _onEntries: onEntries };
}
