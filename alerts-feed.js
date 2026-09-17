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
// כל השאילתות מוגבלות (limit) ובתחום התחנה בלבד. אין כאן כתיבה,
// ואין שינוי במנגנון הצפייה הקיים — הקובץ הזה רק קורא ומאחד.

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

// --- Firestore-touching loader. `sdk` is dependency-injected (collection,
// doc, getDoc, getDocs, query, where, orderBy, limit) so this stays
// unit-testable, matching bulletin.js's own injectable-SDK convention.
//
// `activeBoardOverride` (optional, {id, messages}) lets a caller that
// already holds a *live* bulletin.js subscription for one board (the home
// screen's bell, via bulletin.js's onMessages hook — see §5.5) hand its
// already-fetched messages in directly instead of this function issuing
// its own query for that board — the whole reason that override exists is
// to guarantee this never opens a second query/listener on a path
// bulletin.js already subscribes to live. Every other board is still
// fetched normally with a bounded one-time getDocs. ---

export async function resolveBulletinViewed(sdk, db, sid, uid, messageDoc, data) {
  const { doc, getDoc } = sdk;
  if (data.by_uid === uid) return true;
  try {
    const receipt = await getDoc(doc(db, 'stations', sid, 'bulletin_view_receipts',
      messageDoc.id, 'bulletin_view_recipients', uid));
    return receipt.exists();
  } catch (ignore) { return false; /* unreadable receipt = not-yet-viewed */ }
}

export async function loadAlertsFeed(sdk, db, sid, uid, messageTimeMs, activeBoardOverride) {
  const { collection, doc, getDoc, getDocs, query, where, orderBy, limit } = sdk;
  const override = activeBoardOverride && activeBoardOverride.id ? activeBoardOverride : null;

  const boardsSnap = await getDocs(collection(db, 'stations', sid, 'sub_stations'));
  const boards = boardsSnap.docs.map(function (d) {
    return { id: d.id, name: (d.data() || {}).name || d.id };
  });

  const bulletinItems = [];
  for (const board of boards) {
    if (override && board.id === override.id) {
      for (const messageDoc of override.messages || []) {
        const data = messageDoc.data ? (messageDoc.data() || {}) : (messageDoc.value || {});
        const id = messageDoc.id;
        const timeMs = messageTimeMs(data.created_at) || messageTimeMs(data.created_key);
        const viewed = await resolveBulletinViewed(sdk, db, sid, uid, { id }, data);
        bulletinItems.push(bulletinFeedItem(board.id, board.name, id, data, viewed, timeMs));
      }
      continue;
    }
    const q = query(
      collection(db, 'stations', sid, 'sub_stations', board.id, 'bulletin_messages'),
      where('hidden', '==', false), orderBy('created_at', 'desc'), limit(BOARD_MESSAGE_LIMIT)
    );
    let snap;
    try { snap = await getDocs(q); } catch (ignore) { continue; }
    for (const messageDoc of snap.docs) {
      const data = messageDoc.data() || {};
      const timeMs = messageTimeMs(data.created_at) || messageTimeMs(data.created_key);
      const viewed = await resolveBulletinViewed(sdk, db, sid, uid, messageDoc, data);
      bulletinItems.push(bulletinFeedItem(board.id, board.name, messageDoc.id, data, viewed, timeMs));
    }
  }

  const calloutItems = [];
  try {
    // כולל active וגם היסטוריות (סגורות) — לא רק פעילות, כדי שהפילטר
    // "קריאות פתע" יציג את כל הקריאות שהמשתמש נמען שלהן, לא רק פתוחות.
    const calloutQuery = query(collection(db, 'stations', sid, 'callouts'),
      where('uids', 'array-contains', uid),
      orderBy('created_key', 'desc'), limit(CALLOUT_LIMIT));
    const calloutSnap = await getDocs(calloutQuery);
    for (const calloutDoc of calloutSnap.docs) {
      const data = calloutDoc.data() || {};
      const timeMs = messageTimeMs(data.created_at) || messageTimeMs(data.created_key);
      let viewed = false;
      try {
        const responseSnap = await getDoc(doc(db, 'stations', sid, 'callouts', calloutDoc.id, 'responses', uid));
        viewed = responseSnap.exists() && !!(responseSnap.data() || {}).seen_at;
      } catch (ignore) { /* unreadable response is treated as not-yet-viewed */ }
      calloutItems.push(calloutFeedItem(calloutDoc.id, data, viewed, timeMs));
    }
  } catch (ignore) { /* callouts are an addition to the feed, never block bulletin items */ }

  return mergeFeedItems(bulletinItems, calloutItems, FEED_LIMIT);
}
