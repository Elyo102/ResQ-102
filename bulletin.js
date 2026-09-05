// לוח המודעות התחנתי.
//
// הקריאה נעשית ישירות מ-Firestore, אך תמיד מתת-התחנה שנבחרה
// ובחלון של 30 הודעות. כתיבה והסתרה אינן נעשות מהדפדפן: הן
// עוברות דרך Cloud Functions שמאמתות זהות, תפקיד ותוכן בצד השרת.

import { subStationAvailable } from './stations.js?v=42h2';
export { subStationAvailable };

const PAGE_SIZE = 30;
const REPLY_PAGE_SIZE = 20;
const MAX_TEXT = 2000;
const MAX_REPLY_TEXT = 1000;
const SELECTED_BOARD_PREFIX = 'resq_bulletin_board:';
const LEGACY_DRAFT_PREFIX = 'resq_bulletin_draft:';
const DRAFT_PREFIX = 'resq_bulletin_draft:v2:';
const LEGACY_READ_PREFIX = 'resq_bulletin_read:';
const READ_PREFIX = 'resq_bulletin_read:v2:';

export const CATEGORIES = Object.freeze([
  Object.freeze({ id: 'general',     label: 'כללי',         icon: '📌' }),
  Object.freeze({ id: 'supplies',    label: 'אספקה',        icon: '🧺' }),
  Object.freeze({ id: 'equipment',   label: 'ציוד',         icon: '🧰' }),
  Object.freeze({ id: 'vehicle',     label: 'רכב',          icon: '🚒' }),
  Object.freeze({ id: 'maintenance', label: 'טיפול ותחזוקה', icon: '🛠️' })
]);

const CATEGORY_BY_ID = CATEGORIES.reduce(function (all, item) {
  all[item.id] = item;
  return all;
}, {});

function storagePart(value) {
  return encodeURIComponent(String(value || ''));
}

export function draftStorageKey(uid, stationId, subStationId) {
  return DRAFT_PREFIX + [uid, stationId, subStationId]
    .map(storagePart).join(':');
}

// למפתחות הישנים אין UID, ולכן אי אפשר לדעת למי הטיוטה שייכת.
// מוחקים אותם בלי לקרוא או להעביר את הערך למשתמש המחובר. איסוף
// המפתחות נעשה לפני המחיקה כדי ששינוי האינדקסים לא ידלג על פריט.
export function purgeLegacyBulletinDrafts(storage) {
  let target = storage;
  if (!target) {
    try { target = localStorage; } catch (ignore) { return 0; }
  }
  const keys = [];
  try {
    for (let i = 0; i < target.length; i++) {
      const key = target.key(i);
      if (typeof key === 'string' && key.indexOf(LEGACY_DRAFT_PREFIX) === 0 &&
          key.indexOf(DRAFT_PREFIX) !== 0) keys.push(key);
    }
    keys.forEach(function (key) { target.removeItem(key); });
  } catch (ignore) {
    return 0;
  }
  return keys.length;
}

// סימוני הקריאה הישנים שותפו לכל מי שנכנס מאותו דפדפן. אין
// בהם תוכן פרטי, אך אסור לאמץ אותם למשתמש הבא ולהעלים לו badge.
export function purgeLegacyBulletinReads(storage) {
  let target = storage;
  if (!target) {
    try { target = localStorage; } catch (ignore) { return 0; }
  }
  const keys = [];
  try {
    for (let i = 0; i < target.length; i++) {
      const key = target.key(i);
      if (typeof key === 'string' && key.indexOf(LEGACY_READ_PREFIX) === 0 &&
          key.indexOf(READ_PREFIX) !== 0) keys.push(key);
    }
    keys.forEach(function (key) { target.removeItem(key); });
  } catch (ignore) {
    return 0;
  }
  return keys.length;
}

export function readStorageKey(uid, stationId, subStationId) {
  return READ_PREFIX + [uid, stationId, subStationId]
    .map(storagePart).join(':');
}

export function messageTimeMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') {
    const n = Number(value.toMillis());
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value.toDate === 'function') {
    const d = value.toDate();
    const n = d instanceof Date ? d.getTime() : 0;
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value === 'object' && Number.isFinite(Number(value.seconds))) {
    const ms = Number(value.seconds) * 1000 +
      Math.floor(Number(value.nanoseconds || 0) / 1000000);
    return Number.isFinite(ms) ? ms : 0;
  }
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dataOf(message) {
  return message && message.data && typeof message.data !== 'function'
    ? message.data : (message || {});
}

function timeOfMessage(message) {
  const data = dataOf(message);
  return messageTimeMs(data.created_at) || messageTimeMs(data.created_key);
}

export function validateBulletinText(value) {
  const text = String(value == null ? '' : value).normalize('NFC').trim();
  if (!text) return { ok: false, text: '', error: 'empty' };
  if (text.length > MAX_TEXT) return { ok: false, text: text, error: 'too_long' };
  return { ok: true, text: text, error: '' };
}

export function sortBulletinMessages(messages) {
  return Array.from(Array.isArray(messages) ? messages : []).sort(function (a, b) {
    const delta = timeOfMessage(b) - timeOfMessage(a);
    if (delta) return delta;
    return String((b && b.id) || '').localeCompare(String((a && a.id) || ''));
  });
}

export function newestBulletinTime(messages) {
  return (Array.isArray(messages) ? messages : []).reduce(function (latest, message) {
    return Math.max(latest, timeOfMessage(message));
  }, 0);
}

export function bulletinUnreadCount(messages, since, myUid) {
  const marker = Number(since || 0);
  if (!Number.isFinite(marker) || marker <= 0) return 0;
  return (Array.isArray(messages) ? messages : []).reduce(function (count, message) {
    const data = dataOf(message);
    if (data.hidden === true) return count;
    if (myUid && data.by_uid === myUid) return count;
    return count + (timeOfMessage(message) > marker ? 1 : 0);
  }, 0);
}

let state = null;

function byId(id) {
  return document.getElementById(id);
}

function safeRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch (ignore) {
    return fallback;
  }
}

function safeWrite(key, value) {
  try { localStorage.setItem(key, value); } catch (ignore) {}
}

function safeHas(key) {
  try { return localStorage.getItem(key) !== null; }
  catch (ignore) { return false; }
}

function safeRemove(key) {
  try { localStorage.removeItem(key); } catch (ignore) {}
}

function newRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' +
      hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  // בלי מקור אקראיות קריפטוגרפי לא ממציאים מזהה חלש. הטיוטה
  // תישאר במכשיר והמשתמש יקבל הסבר במקום להסתכן בכפילויות.
  return '';
}

function selectedBoardKey() {
  return SELECTED_BOARD_PREFIX + state.stationId;
}

function selectedAudience() {
  if (!state || !state.canShiftCommand) return 'board';
  const checked = document.querySelector(
    'input[name="bulletinAudience"]:checked'
  );
  return checked && checked.value === 'station' ? 'station' : 'board';
}

function updateAudienceUi(resetApproval) {
  if (!state) return;
  const board = state.boards.find(function (item) {
    return item.id === state.activeBoard;
  });
  byId('bulletinCurrentBoardName').textContent = board ? board.name : 'הנבחר';
  byId('bulletinAllBoardsCount').textContent = String(state.boards.length);
  byId('bulletinBroadcastTargets').textContent = state.boards.length
    ? 'היעדים: ' + state.boards.map(function (item) { return item.name; }).join(' · ')
    : 'אין כרגע תחנות פעילות.';
  const broad = selectedAudience() === 'station';
  byId('bulletinBroadcastConfirm').classList.toggle('hide', !broad);
  if (resetApproval) byId('bulletinBroadcastApproved').checked = false;
  if (!state.publishing) {
    byId('bulletinSubmit').textContent = broad
      ? 'פרסם ל־' + state.boards.length + ' תחנות'
      : 'פרסם הודעה';
  }
}

function setAudience(value, resetApproval) {
  const allowed = state && state.canShiftCommand && value === 'station'
    ? 'station' : 'board';
  const input = document.querySelector(
    'input[name="bulletinAudience"][value="' + allowed + '"]'
  );
  if (input) input.checked = true;
  updateAudienceUi(resetApproval !== false);
}

function readDraft(boardId) {
  const fallback = {
    text: '', category: 'general', audience: 'board',
    requestId: '', attemptedFingerprint: ''
  };
  try {
    const value = JSON.parse(safeRead(
      draftStorageKey(state.user.uid, state.stationId, boardId), ''
    ) || 'null');
    if (!value || typeof value !== 'object') return fallback;
    return {
      text: typeof value.text === 'string' ? value.text.slice(0, MAX_TEXT) : '',
      category: CATEGORY_BY_ID[value.category] ? value.category : 'general',
      audience: value.audience === 'station' ? 'station' : 'board',
      requestId: typeof value.requestId === 'string' ? value.requestId : '',
      attemptedFingerprint: typeof value.attemptedFingerprint === 'string'
        ? value.attemptedFingerprint : ''
    };
  } catch (ignore) {
    return fallback;
  }
}

function persistDraft() {
  if (!state || !state.activeBoard) return;
  const text = byId('bulletinText').value.slice(0, MAX_TEXT);
  const category = CATEGORY_BY_ID[byId('bulletinCategory').value]
    ? byId('bulletinCategory').value : 'general';
  const audience = selectedAudience();
  if (text && !state.draftRequestId) state.draftRequestId = newRequestId();

  if (!text && !state.draftRequestId) {
    safeRemove(draftStorageKey(state.user.uid, state.stationId, state.activeBoard));
    return;
  }
  safeWrite(draftStorageKey(state.user.uid, state.stationId, state.activeBoard), JSON.stringify({
    text: text,
    category: category,
    audience: audience,
    requestId: state.draftRequestId,
    attemptedFingerprint: state.attemptedFingerprint
  }));
}

function currentDraftFingerprint() {
  return selectedAudience() + '\n' + byId('bulletinCategory').value + '\n' +
    validateBulletinText(byId('bulletinText').value).text;
}

function renewIdentityAfterEdit() {
  if (!state || !state.attemptedFingerprint) return;
  if (currentDraftFingerprint() === state.attemptedFingerprint) return;
  state.draftRequestId = newRequestId();
  state.attemptedFingerprint = '';
}

function restoreDraft(boardId) {
  const draft = readDraft(boardId);
  state.draftRequestId = draft.requestId;
  state.attemptedFingerprint = draft.attemptedFingerprint;
  byId('bulletinText').value = draft.text;
  byId('bulletinCategory').value = draft.category;
  setAudience(draft.audience, true);
  updateCharCount();
  setFormStatus(draft.text ? 'הטיוטה שלך נשמרה במכשיר.' : '', 'info');
}

function clearDraft(boardId) {
  safeRemove(draftStorageKey(state.user.uid, state.stationId, boardId));
  state.draftRequestId = '';
  state.attemptedFingerprint = '';
  byId('bulletinText').value = '';
  byId('bulletinCategory').value = 'general';
  setAudience('board', true);
  updateCharCount();
}

function updateCharCount() {
  const count = byId('bulletinText').value.normalize('NFC').length;
  byId('bulletinCharCount').textContent = count + ' / ' + MAX_TEXT;
}

function setStatus(text, kind, retry) {
  if (!state) return;
  const box = byId('bulletinStatus');
  box.textContent = text || '';
  box.className = 'bulletin-status' + (text ? ' is-visible' : '') +
    (kind ? ' ' + kind : '');
  const button = byId('bulletinRetry');
  button.classList.toggle('hide', !retry);
}

function setFormStatus(text, kind) {
  const box = byId('bulletinFormStatus');
  box.textContent = text || '';
  box.className = 'bulletin-form-status' + (text ? ' is-visible' : '') +
    (kind ? ' ' + kind : '');
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

function categoryOf(id) {
  return CATEGORY_BY_ID[id] || CATEGORY_BY_ID.general;
}

function timeParts(data) {
  let ms = messageTimeMs(data.created_at);
  if (!ms) ms = messageTimeMs(data.created_key);
  if (!ms) return { text: 'כעת', iso: '', ms: 0 };

  const date = new Date(ms);
  const now = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const clock = date.toLocaleTimeString('he-IL', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  let prefix = date.toLocaleDateString('he-IL', {
    day: 'numeric', month: 'numeric', year: 'numeric'
  });
  if (day === today) prefix = 'היום';
  else if (day === today - 86400000) prefix = 'אתמול';
  return { text: prefix + ', ' + clock, iso: date.toISOString(), ms: ms };
}

function messageRecord(snapshot) {
  const data = snapshot && typeof snapshot.data === 'function'
    ? (snapshot.data() || {}) : {};
  return { id: snapshot.id, data: data, snapshot: snapshot };
}

function replyDraftKey(boardId, messageId) {
  return String(boardId || '') + ':' + String(messageId || '');
}

function domToken(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, function (character) {
    return '_' + character.codePointAt(0).toString(16) + '_';
  });
}

function replyThreadDomId(boardId, messageId) {
  return 'bulletinThread-' + domToken(boardId) + '-' + domToken(messageId);
}

function replyFocusKey(kind, messageId) {
  return String(kind || 'control') + ':' + String(messageId || '');
}

function feedFocusSnapshot(feed) {
  const active = document.activeElement;
  if (!feed || !active || !feed.contains(active)) return null;
  const key = String(active.dataset && active.dataset.bulletinFocus || '');
  if (!key) return null;
  const snapshot = { key: key };
  if (typeof active.selectionStart === 'number') {
    snapshot.selectionStart = active.selectionStart;
    snapshot.selectionEnd = active.selectionEnd;
  }
  return snapshot;
}

function restoreFeedFocus(feed, requested) {
  const focus = typeof requested === 'string' ? { key: requested } : requested;
  if (!feed || !focus || !focus.key) return;
  const target = Array.from(feed.querySelectorAll('[data-bulletin-focus]'))
    .find(function (node) { return node.dataset.bulletinFocus === focus.key; });
  if (!target || target.disabled) return;
  try { target.focus({ preventScroll: true }); } catch (ignore) { target.focus(); }
  if (typeof focus.selectionStart === 'number' &&
      typeof target.setSelectionRange === 'function') {
    const end = typeof focus.selectionEnd === 'number'
      ? focus.selectionEnd : focus.selectionStart;
    try { target.setSelectionRange(focus.selectionStart, end); } catch (ignore) {}
  }
}

function replyDraft(boardId, messageId) {
  const key = replyDraftKey(boardId, messageId);
  if (!state.replyDrafts[key]) {
    state.replyDrafts[key] = {
      text: '', requestId: '', attemptedText: ''
    };
  }
  return state.replyDrafts[key];
}

function mergedReplies(thread) {
  const all = new Map();
  (thread.liveDocs || []).concat(thread.olderDocs || []).forEach(function (item) {
    if (!item || !item.id || item.data.hidden === true) return;
    all.set(item.id, item);
  });
  return Array.from(all.values()).sort(function (a, b) {
    const delta = messageTimeMs(a.data.created_at) - messageTimeMs(b.data.created_at);
    if (delta) return delta;
    return String(a.id).localeCompare(String(b.id));
  });
}

function stopReplyListener() {
  if (!state) return;
  state.replyGeneration++;
  if (!state.replyUnsubscribe) return;
  try { state.replyUnsubscribe(); } catch (ignore) {}
  state.replyUnsubscribe = null;
}

function repliesQuery(thread, cursor) {
  const sdk = state.sdk;
  const base = sdk.collection(
    state.db, 'stations', state.stationId, 'sub_stations', thread.boardId,
    'bulletin_messages', thread.messageId, 'bulletin_replies'
  );
  const clauses = [
    sdk.where('hidden', '==', false),
    sdk.orderBy('created_at', 'desc')
  ];
  if (cursor) clauses.push(sdk.startAfter(cursor));
  clauses.push(sdk.limit(REPLY_PAGE_SIZE));
  return sdk.query(base, ...clauses);
}

function subscribeReplies() {
  if (!state || !state.replyThread || document.visibilityState === 'hidden') return;
  stopReplyListener();
  const owner = state;
  const thread = state.replyThread;
  // חזרה מרקע יכולה לבטל getDocs שכבר יצא. פתיחת המאזין מחדש
  // מבטלת את העמוד הישן ומשחררת מיד כפתור שנשאר במצב טעינה.
  thread.paginationRevision++;
  thread.loadingOlder = false;
  const generation = ++state.replyGeneration;
  thread.loading = true;
  thread.status = '';
  renderFeed();
  state.replyUnsubscribe = state.sdk.onSnapshot(
    repliesQuery(thread),
    function (snapshot) {
      if (state !== owner || state.replyThread !== thread ||
          generation !== state.replyGeneration) return;
      const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
      const next = docs.map(messageRecord);
      const previousIds = thread.liveDocs.map(function (item) { return item.id; });
      const nextIds = next.map(function (item) { return item.id; });
      const changed = previousIds.length > 0 &&
        (previousIds.length !== nextIds.length || previousIds.some(function (id, index) {
          return id !== nextIds[index];
        }));
      if (changed) {
        thread.olderDocs = [];
        thread.paginationRevision++;
        thread.loadingOlder = false;
      }
      thread.liveDocs = next;
      thread.hasMore = docs.length === REPLY_PAGE_SIZE;
      thread.loading = false;
      thread.loaded = true;
      thread.status = snapshot.metadata && snapshot.metadata.fromCache
        ? 'מוצגות תגובות שמורות מהמכשיר.' : '';
      renderFeed();
    },
    function () {
      if (state !== owner || state.replyThread !== thread ||
          generation !== state.replyGeneration) return;
      thread.loading = false;
      thread.loaded = true;
      thread.status = 'לא הצלחנו לטעון את התגובות. אפשר לנסות שוב.';
      thread.statusKind = 'error';
      renderFeed();
    }
  );
}

async function loadOlderReplies() {
  if (!state || !state.replyThread || state.replyThread.loadingOlder) return;
  const owner = state;
  const thread = state.replyThread;
  const cursorRecord = thread.olderDocs.length
    ? thread.olderDocs[thread.olderDocs.length - 1]
    : thread.liveDocs[thread.liveDocs.length - 1];
  if (!cursorRecord || !cursorRecord.snapshot) {
    thread.hasMore = false;
    renderFeed();
    return;
  }
  const generation = state.replyGeneration;
  const paginationRevision = thread.paginationRevision;
  thread.loadingOlder = true;
  renderFeed();
  try {
    const snapshot = await state.sdk.getDocs(repliesQuery(thread, cursorRecord.snapshot));
    if (state !== owner || state.replyThread !== thread ||
        generation !== state.replyGeneration ||
        paginationRevision !== thread.paginationRevision) return;
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
    thread.olderDocs = thread.olderDocs.concat(docs.map(messageRecord));
    thread.hasMore = docs.length === REPLY_PAGE_SIZE;
  } catch (ignore) {
    if (state === owner && state.replyThread === thread &&
        generation === state.replyGeneration &&
        paginationRevision === thread.paginationRevision) {
      thread.status = 'לא הצלחנו לטעון תגובות קודמות.';
      thread.statusKind = 'error';
    }
  } finally {
    if (state === owner && state.replyThread === thread &&
        generation === state.replyGeneration &&
        paginationRevision === thread.paginationRevision) {
      thread.loadingOlder = false;
      renderFeed();
    }
  }
}

function openReplyThread(item, composing) {
  if (!state || !state.activeBoard) return;
  const same = state.replyThread &&
    state.replyThread.boardId === state.activeBoard &&
    state.replyThread.messageId === item.id;
  if (!same) {
    stopReplyListener();
    state.replyThread = {
      boardId: state.activeBoard,
      messageId: item.id,
      liveDocs: [],
      olderDocs: [],
      hasMore: false,
      loading: true,
      loadingOlder: false,
      paginationRevision: 0,
      loaded: false,
      composing: !!composing,
      status: '',
      statusKind: ''
    };
    renderFeed();
    subscribeReplies();
  } else {
    state.replyThread.composing = state.replyThread.composing || !!composing;
    renderFeed();
  }
}

function toggleReplyThread(item) {
  const same = state && state.replyThread &&
    state.replyThread.boardId === state.activeBoard &&
    state.replyThread.messageId === item.id;
  if (same) {
    stopReplyListener();
    state.replyThread = null;
    renderFeed(replyFocusKey('toggle', item.id));
    return;
  }
  openReplyThread(item, false);
}

function openReplyComposer(item) {
  if (!state || !state.canShiftCommand) return;
  openReplyThread(item, true);
  requestAnimationFrame(function () {
    const article = Array.from(document.querySelectorAll('[data-message-id]'))
      .find(function (node) { return node.dataset.messageId === item.id; });
    const field = article && article.querySelector('.bulletin-reply-form textarea');
    if (field) field.focus();
  });
}

async function publishReply(event, item) {
  event.preventDefault();
  if (!state || !state.canShiftCommand || state.replyPublishing ||
      !state.replyThread || state.replyThread.messageId !== item.id) return;
  const thread = state.replyThread;
  const draft = replyDraft(thread.boardId, item.id);
  const text = String(draft.text || '').normalize('NFC').trim();
  if (!text) {
    thread.status = 'כתוב תגובה לפני השליחה.';
    thread.statusKind = 'error';
    renderFeed();
    return;
  }
  if (text.length > MAX_REPLY_TEXT) {
    thread.status = 'התגובה ארוכה מדי. אפשר לכתוב עד ' +
      MAX_REPLY_TEXT + ' תווים.';
    thread.statusKind = 'error';
    renderFeed();
    return;
  }
  if (navigator.onLine === false) {
    thread.status = 'אין כרגע חיבור. התגובה נשמרה במסך ואפשר לנסות שוב.';
    thread.statusKind = 'error';
    renderFeed();
    return;
  }
  if (!draft.requestId) draft.requestId = newRequestId();
  if (!draft.requestId) {
    thread.status = 'הדפדפן אינו יכול ליצור מזהה תגובה בטוח.';
    thread.statusKind = 'error';
    renderFeed();
    return;
  }

  const owner = state;
  const boardId = thread.boardId;
  const requestId = draft.requestId;
  draft.attemptedText = text;
  state.replyPublishing = true;
  thread.status = 'שולח את התגובה…';
  thread.statusKind = '';
  renderFeed();
  try {
    await state.replyMessage({
      subStationId: boardId,
      messageId: item.id,
      text: text,
      requestId: requestId
    });
    if (state !== owner || state.replyThread !== thread) return;
    delete state.replyDrafts[replyDraftKey(boardId, item.id)];
    thread.composing = false;
    thread.status = 'התגובה פורסמה.';
    thread.statusKind = 'success';
  } catch (error) {
    if (state !== owner || state.replyThread !== thread) return;
    const code = String((error && error.code) || '');
    if (code.indexOf('already-exists') !== -1) {
      draft.requestId = newRequestId();
      draft.attemptedText = '';
      thread.status = 'הבקשה הקודמת כבר טופלה. בדוק אם התגובה מופיעה; אם לא, נסה שוב.';
    } else if (code.indexOf('permission-denied') !== -1) {
      thread.status = 'ההרשאה השתנתה. התחבר מחדש לפני כתיבת תגובה.';
    } else if (code.indexOf('resource-exhausted') !== -1) {
      thread.status = 'נשלחו יותר מדי תגובות בזמן קצר. המתן ונסה שוב.';
    } else {
      thread.status = 'התגובה לא הושלמה. הטקסט נשמר במסך ואפשר לנסות שוב.';
    }
    thread.statusKind = 'error';
  } finally {
    if (state === owner) {
      state.replyPublishing = false;
      renderFeed();
    }
  }
}

async function hideReply(item, reply, button) {
  if (!state || !state.isSuper || button.disabled) return;
  if (!window.confirm('להסתיר את התגובה? הפעולה תישמר בתיעוד.')) return;
  const owner = state;
  const thread = state.replyThread;
  button.disabled = true;
  button.textContent = 'מסתיר…';
  try {
    await state.hideReply({
      sid: state.stationId,
      subStationId: thread.boardId,
      messageId: item.id,
      replyId: reply.id
    });
    if (state !== owner || state.replyThread !== thread) return;
    thread.liveDocs = thread.liveDocs.filter(function (x) { return x.id !== reply.id; });
    thread.olderDocs = thread.olderDocs.filter(function (x) { return x.id !== reply.id; });
    thread.paginationRevision++;
    thread.loadingOlder = false;
    thread.status = 'התגובה הוסתרה.';
    thread.statusKind = 'success';
    renderFeed();
  } catch (ignore) {
    if (state !== owner || state.replyThread !== thread) return;
    thread.status = 'הסתרת התגובה לא הושלמה.';
    thread.statusKind = 'error';
    renderFeed();
  }
}

function renderReplyThread(item) {
  const thread = state.replyThread;
  const section = document.createElement('section');
  section.className = 'bulletin-thread';
  section.dataset.testid = 'bulletin-thread';
  section.id = replyThreadDomId(thread.boardId, item.id);

  const title = document.createElement('h3');
  title.className = 'bulletin-thread-title';
  title.id = section.id + '-title';
  title.textContent = 'תגובות';
  section.setAttribute('aria-labelledby', title.id);
  section.appendChild(title);

  const replies = mergedReplies(thread);
  const list = document.createElement('div');
  list.className = 'bulletin-replies';
  replies.forEach(function (reply) {
    const data = reply.data || {};
    const card = document.createElement('div');
    card.className = 'bulletin-reply';
    card.dataset.replyId = reply.id;
    card.dataset.testid = 'bulletin-reply';
    const head = document.createElement('div');
    head.className = 'bulletin-reply-head';
    addText(head, 'bulletin-reply-name', data.by_name || 'חבר צוות');
    const role = state.roleLabels[data.by_role] || data.by_role || '';
    const crew = data.by_crew ? 'משמרת ' + data.by_crew : '';
    const detail = [role, crew].filter(Boolean).join(' · ');
    if (detail) addText(head, 'bulletin-reply-role', detail);
    const when = timeParts(data);
    const time = document.createElement('time');
    time.className = 'bulletin-reply-time';
    time.textContent = when.text;
    if (when.iso) time.dateTime = when.iso;
    head.appendChild(time);
    card.appendChild(head);
    const body = document.createElement('p');
    body.className = 'bulletin-reply-text';
    body.textContent = typeof data.text === 'string' ? data.text : '';
    card.appendChild(body);
    if (state.isSuper) {
      const footer = document.createElement('div');
      footer.className = 'bulletin-reply-footer';
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'bulletin-hide-reply';
      hide.textContent = 'הסתר תגובה';
      hide.onclick = function () { hideReply(item, reply, hide); };
      footer.appendChild(hide);
      card.appendChild(footer);
    }
    list.appendChild(card);
  });
  section.appendChild(list);

  if (thread.loading && !thread.loaded) {
    addText(section, 'bulletin-reply-state', 'טוען תגובות…');
  } else if (!replies.length) {
    addText(section, 'bulletin-reply-state', 'עדיין אין תגובות להודעה.');
  }
  if (thread.hasMore) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'bulletin-reply-more';
    more.textContent = thread.loadingOlder ? 'טוען…' : 'טען תגובות קודמות';
    more.disabled = thread.loadingOlder;
    more.onclick = loadOlderReplies;
    section.appendChild(more);
  }

  if (state.canShiftCommand && thread.composing) {
    const draft = replyDraft(thread.boardId, item.id);
    const form = document.createElement('form');
    form.className = 'bulletin-reply-form';
    form.dataset.testid = 'bulletin-reply-form';
    const label = document.createElement('label');
    label.textContent = 'תגובה פיקודית';
    const field = document.createElement('textarea');
    field.maxLength = MAX_REPLY_TEXT;
    field.rows = 3;
    field.value = draft.text;
    field.placeholder = 'כתוב תשובה ברורה וקצרה';
    label.htmlFor = 'bulletinReplyText-' + item.id;
    field.id = label.htmlFor;
    field.dataset.bulletinFocus = replyFocusKey('field', item.id);
    field.oninput = function () {
      const next = field.value.slice(0, MAX_REPLY_TEXT);
      if (draft.attemptedText && next.normalize('NFC').trim() !== draft.attemptedText) {
        draft.requestId = newRequestId();
        draft.attemptedText = '';
      }
      draft.text = next;
      thread.status = '';
      thread.statusKind = '';
    };
    form.appendChild(label);
    form.appendChild(field);
    const actions = document.createElement('div');
    actions.className = 'bulletin-reply-form-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.dataset.bulletinFocus = replyFocusKey('submit', item.id);
    submit.textContent = state.replyPublishing ? 'שולח…' : 'פרסם תגובה';
    submit.disabled = state.replyPublishing;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'bulletin-reply-cancel';
    cancel.dataset.bulletinFocus = replyFocusKey('cancel', item.id);
    cancel.textContent = 'ביטול';
    cancel.disabled = state.replyPublishing;
    cancel.onclick = function () {
      thread.composing = false;
      renderFeed(replyFocusKey('action', item.id));
    };
    actions.appendChild(submit);
    actions.appendChild(cancel);
    form.appendChild(actions);
    form.onsubmit = function (event) { publishReply(event, item); };
    section.appendChild(form);
  }

  if (thread.status) {
    const status = addText(section,
      'bulletin-reply-status' + (thread.statusKind ? ' ' + thread.statusKind : ''),
      thread.status
    );
    status.setAttribute('role', thread.statusKind === 'error' ? 'alert' : 'status');
  }
  return section;
}

function mergedMessages() {
  const all = new Map();
  state.liveDocs.concat(state.olderDocs).forEach(function (item) {
    if (!item || !item.id || item.data.hidden === true) return;
    all.set(item.id, item);
  });
  return sortBulletinMessages(Array.from(all.values()));
}

function addText(parent, className, text) {
  const node = document.createElement('span');
  if (className) node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function renderMessage(item) {
  const data = item.data || {};
  const category = categoryOf(data.category);
  const article = document.createElement('article');
  article.className = 'bulletin-message category-' + category.id;
  article.dataset.messageId = item.id;
  article.dataset.testid = 'bulletin-message';
  article.setAttribute('aria-label', category.label + ' מאת ' +
    (data.by_name || data.author_name || 'חבר צוות'));

  const top = document.createElement('div');
  top.className = 'bulletin-message-top';

  const categoryChip = document.createElement('span');
  categoryChip.className = 'bulletin-category';
  categoryChip.textContent = category.icon + ' ' + category.label;
  top.appendChild(categoryChip);

  if (data.audience === 'all_sub_stations') {
    const broad = document.createElement('span');
    broad.className = 'bulletin-broadcast-chip';
    broad.textContent = '📣 לכל התחנות';
    broad.setAttribute('aria-label', 'הודעה שהופצה לכל תחנות המשנה');
    top.appendChild(broad);
  }

  const when = timeParts(data);
  const time = document.createElement('time');
  time.className = 'bulletin-time';
  if (when.iso) time.dateTime = when.iso;
  time.textContent = when.text;
  top.appendChild(time);
  article.appendChild(top);

  const author = document.createElement('div');
  author.className = 'bulletin-author';
  addText(author, 'bulletin-author-name',
    data.by_name || data.author_name || (data.kind === 'system' ? 'מערכת ResQ' : 'חבר צוות'));

  const role = state.roleLabels[data.by_role] || data.author_role || data.by_role || '';
  const crew = data.by_crew ? ('משמרת ' + data.by_crew) : '';
  const detail = [role, crew].filter(Boolean).join(' · ');
  if (detail) addText(author, 'bulletin-author-role', detail);
  article.appendChild(author);

  const body = document.createElement('p');
  body.className = 'bulletin-message-text';
  // תוכן משתמש נכנס תמיד דרך textContent. אין כאן innerHTML.
  body.textContent = typeof data.text === 'string' ? data.text : '';
  article.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'bulletin-message-actions';
  if (data.category === 'equipment' || data.category === 'vehicle') {
    const fault = document.createElement('a');
    fault.href = './faults.html';
    fault.textContent = 'דיווח תקלה מסודר';
    fault.setAttribute('aria-label', 'מעבר למסך תקלות עבור הודעה זו');
    actions.appendChild(fault);
  }

  const replyCount = Math.max(0, Math.floor(Number(data.reply_count || 0)));
  const threadOpen = state.replyThread &&
    state.replyThread.boardId === state.activeBoard &&
    state.replyThread.messageId === item.id;
  if (replyCount || threadOpen) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'bulletin-reply-toggle';
    toggle.dataset.testid = 'bulletin-replies-toggle';
    toggle.dataset.bulletinFocus = replyFocusKey('toggle', item.id);
    toggle.textContent = threadOpen
      ? 'סגור תגובות'
      : 'הצג תגובות' + (replyCount ? ' (' + replyCount + ')' : '');
    toggle.setAttribute('aria-expanded', threadOpen ? 'true' : 'false');
    toggle.setAttribute('aria-controls',
      replyThreadDomId(state.activeBoard, item.id));
    toggle.onclick = function () { toggleReplyThread(item); };
    actions.appendChild(toggle);
  }

  if (state.canShiftCommand) {
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'bulletin-reply-action';
    reply.dataset.testid = 'bulletin-reply-action';
    reply.dataset.bulletinFocus = replyFocusKey('action', item.id);
    reply.textContent = 'תגובה';
    reply.setAttribute('aria-label', 'כתיבת תגובה להודעה מאת ' +
      (data.by_name || data.author_name || 'חבר צוות'));
    reply.setAttribute('aria-controls',
      replyThreadDomId(state.activeBoard, item.id));
    reply.setAttribute('aria-expanded',
      threadOpen && state.replyThread.composing ? 'true' : 'false');
    reply.onclick = function () { openReplyComposer(item); };
    actions.appendChild(reply);
  }

  if (state.isSuper) {
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'bulletin-hide-message';
    hide.dataset.testid = 'bulletin-hide';
    hide.textContent = 'הסתר';
    hide.setAttribute('aria-label', 'הסתרת ההודעה מאת ' +
      (data.by_name || data.author_name || 'חבר צוות'));
    hide.onclick = function () { hideMessage(item, hide); };
    actions.appendChild(hide);
  }
  if (actions.childNodes.length) article.appendChild(actions);
  if (threadOpen) article.appendChild(renderReplyThread(item));
  return article;
}

function renderFeed(preferredFocus) {
  if (!state) return;
  const feed = byId('bulletinFeed');
  const focus = preferredFocus || feedFocusSnapshot(feed);
  const messages = mergedMessages();
  feed.replaceChildren();
  messages.forEach(function (item) { feed.appendChild(renderMessage(item)); });
  feed.setAttribute('aria-busy', 'false');

  const empty = byId('bulletinEmpty');
  empty.classList.toggle('hide', messages.length !== 0);
  const more = byId('bulletinLoadMore');
  more.classList.toggle('hide', messages.length === 0 || !state.hasMore);
  restoreFeedFocus(feed, focus);

  if (state.lastLoadFromCache || navigator.onLine === false) {
    setStatus('מציג מידע שמור. ייתכן שיש הודעות חדשות שטרם הגיעו.', 'offline', false);
  } else {
    setStatus('', '', false);
  }
}

function readMarker(boardId) {
  const n = Number(safeRead(
    readStorageKey(state.user.uid, state.stationId, boardId), '0'
  ));
  return Number.isFinite(n) ? n : 0;
}

function scheduleMarkRead() {
  clearTimeout(state.readTimer);
  if (document.visibilityState === 'hidden' || !state.activeBoard) return;
  const boardId = state.activeBoard;
  const owner = state;
  const newest = newestBulletinTime(mergedMessages());
  if (!newest) return;

  state.readTimer = setTimeout(function () {
    if (state !== owner || state.activeBoard !== boardId || document.visibilityState === 'hidden') return;
    safeWrite(readStorageKey(state.user.uid, state.stationId, boardId), String(newest));
    state.unread[boardId] = 0;
    renderTabs();
  }, 900);
}

function updateUnread() {
  if (!state.activeBoard) return;
  const key = readStorageKey(state.user.uid, state.stationId, state.activeBoard);
  if (!safeHas(key)) {
    const newest = newestBulletinTime(state.liveDocs);
    if (newest) safeWrite(key, String(newest));
    state.unread[state.activeBoard] = 0;
    renderTabs();
    return;
  }
  const seen = readMarker(state.activeBoard);
  state.unread[state.activeBoard] = bulletinUnreadCount(
    state.liveDocs, seen, state.user.uid || ''
  );
  renderTabs();
  scheduleMarkRead();
}

function renderTabs() {
  if (!state) return;
  const tabs = byId('boardTabs');
  tabs.replaceChildren();
  state.boards.forEach(function (board, index) {
    const button = document.createElement('button');
    const active = board.id === state.activeBoard;
    button.type = 'button';
    button.className = 'bulletin-board-tab tone-' + (index % 5) +
      (active ? ' is-active' : '');
    button.dataset.boardId = board.id;
    button.dataset.testid = 'bulletin-station-tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.setAttribute('aria-controls', 'bulletinFeed');
    button.tabIndex = active ? 0 : -1;

    const name = document.createElement('span');
    name.className = 'bulletin-tab-name';
    name.textContent = board.name;
    button.appendChild(name);

    const unread = Number(state.unread[board.id] || 0);
    if (unread) {
      const badge = document.createElement('span');
      badge.className = 'bulletin-unread';
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.setAttribute('aria-label', unread + ' הודעות חדשות');
      button.appendChild(badge);
    }

    button.onclick = function () { selectBoard(board.id, false); };
    button.onkeydown = function (event) {
      let target = index;
      if (event.key === 'ArrowLeft') target = (index + 1) % state.boards.length;
      else if (event.key === 'ArrowRight') target =
        (index - 1 + state.boards.length) % state.boards.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = state.boards.length - 1;
      else return;
      event.preventDefault();
      selectBoard(state.boards[target].id, false);
      requestAnimationFrame(function () {
        const next = Array.from(tabs.querySelectorAll('[data-board-id]'))
          .filter(function (item) {
            return item.dataset.boardId === state.boards[target].id;
          })[0];
        if (next) next.focus();
      });
    };
    tabs.appendChild(button);
  });
}

function stopListener() {
  if (!state) return;
  state.generation++;
  if (!state.unsubscribe) return;
  try { state.unsubscribe(); } catch (ignore) {}
  state.unsubscribe = null;
}

function messagesQuery(boardId, cursor) {
  const sdk = state.sdk;
  const base = sdk.collection(
    state.db, 'stations', state.stationId, 'sub_stations', boardId,
    'bulletin_messages'
  );
  const clauses = [
    sdk.where('hidden', '==', false),
    sdk.orderBy('created_at', 'desc')
  ];
  if (cursor) clauses.push(sdk.startAfter(cursor));
  clauses.push(sdk.limit(PAGE_SIZE));
  return sdk.query(base, ...clauses);
}

function subscribeToActive(keepFeed) {
  if (!state || !state.activeBoard || document.visibilityState === 'hidden') return;
  stopListener();
  const boardId = state.activeBoard;
  const owner = state;
  const generation = ++state.generation;
  if (!keepFeed) {
    state.liveDocs = [];
    state.olderDocs = [];
    state.hasMore = false;
    byId('bulletinFeed').replaceChildren();
    byId('bulletinEmpty').classList.add('hide');
  }
  byId('bulletinFeed').setAttribute('aria-busy', 'true');
  setStatus('טוען את הודעות התחנה…', 'loading', false);

  state.unsubscribe = state.sdk.onSnapshot(messagesQuery(boardId), function (snapshot) {
    if (state !== owner || generation !== state.generation || state.activeBoard !== boardId) return;
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
    const nextLive = docs.map(messageRecord);
    const previousIds = state.liveDocs.map(function (item) { return item.id; });
    const nextIds = nextLive.map(function (item) { return item.id; });
    const windowChanged = previousIds.length > 0 &&
      (previousIds.length !== nextIds.length || previousIds.some(function (id, index) {
        return id !== nextIds[index];
      }));

    // עמודים ישנים נבנו על cursor של חלון ה-realtime הקודם.
    // כשזהותו משתנה מבטלים אותם במקום לנחש אם מסמך נדחק או
    // הוסתר, ואז טעינה נוספת מתחילה מרצף נקי וללא חורים.
    if (windowChanged) {
      state.paginationRevision++;
      state.olderDocs = [];
    }
    state.liveDocs = nextLive;
    if (windowChanged || state.olderDocs.length === 0) {
      state.hasMore = docs.length === PAGE_SIZE;
    }
    state.lastLoadFromCache = !!(snapshot.metadata && snapshot.metadata.fromCache);
    renderFeed();
    updateUnread();
  }, function () {
    if (state !== owner || generation !== state.generation || state.activeBoard !== boardId) return;
    byId('bulletinFeed').setAttribute('aria-busy', 'false');
    setStatus('לא הצלחנו לטעון את לוח המודעות. הטיוטה שלך נשמרה.', 'error', true);
  });
}

function selectBoard(boardId, force) {
  if (!state || !state.boards.some(function (b) { return b.id === boardId; })) return;
  if (!force && state.activeBoard === boardId) return;
  if (state.activeBoard) persistDraft();
  stopReplyListener();
  state.replyThread = null;
  stopListener();
  clearTimeout(state.readTimer);
  state.generation++;
  state.activeBoard = boardId;
  state.liveDocs = [];
  state.olderDocs = [];
  state.hasMore = false;
  state.lastLoadFromCache = false;
  safeWrite(selectedBoardKey(), boardId);
  renderTabs();
  restoreDraft(boardId);
  subscribeToActive(false);
}

async function loadBoards() {
  const owner = state;
  let boards = [];
  let hadDocuments = false;
  try {
    const snapshot = await owner.sdk.getDocs(owner.sdk.collection(
      owner.db, 'stations', owner.stationId, 'sub_stations'
    ));
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
    hadDocuments = docs.length > 0;
    docs.forEach(function (item) {
      const data = item.data() || {};
      if (!subStationAvailable(data)) return;
      boards.push({
        id: item.id,
        name: data.name || item.id,
        order: Number(data.order || 0)
      });
    });
  } catch (ignore) {
    // התקנה חדשה או מטמון ריק יכולה עדיין לפתוח את לוח הפיילוט.
    // השרת יחליט אם פרסום לתחנה שבגיבוי מותר בפועל.
  }

  if (!hadDocuments && !boards.length) {
    boards = owner.fallbackBoards.map(function (item, index) {
      return { id: item.id, name: item.name, order: Number(item.order || index + 1) };
    });
  }
  boards.sort(function (a, b) {
    return a.order - b.order || String(a.name).localeCompare(String(b.name), 'he');
  });

  if (state !== owner) return;
  state.boards = boards;
  if (!boards.length) {
    renderTabs();
    byId('bulletinCompose').disabled = true;
    byId('bulletinEmpty').classList.remove('hide');
    byId('bulletinEmpty').textContent = 'אין כרגע תחנות פעילות להצגה.';
    setStatus('', '', false);
    return;
  }

  byId('bulletinCompose').disabled = false;
  const remembered = safeRead(selectedBoardKey(), '');
  const first = boards.some(function (b) { return b.id === remembered; })
    ? remembered : boards[0].id;
  selectBoard(first, true);
}

async function loadOlder() {
  if (!state || state.loadingOlder || !state.activeBoard) return;
  const cursorRecord = state.olderDocs.length
    ? state.olderDocs[state.olderDocs.length - 1]
    : state.liveDocs[state.liveDocs.length - 1];
  if (!cursorRecord || !cursorRecord.snapshot) {
    state.hasMore = false;
    renderFeed();
    return;
  }

  const boardId = state.activeBoard;
  const owner = state;
  const generation = state.generation;
  const revision = state.paginationRevision;
  const button = byId('bulletinLoadMore');
  state.loadingOlder = true;
  button.disabled = true;
  button.textContent = 'טוען…';
  try {
    const snapshot = await state.sdk.getDocs(messagesQuery(boardId, cursorRecord.snapshot));
    if (state !== owner || state.activeBoard !== boardId ||
        state.generation !== generation || state.paginationRevision !== revision) return;
    const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
    state.olderDocs = state.olderDocs.concat(docs.map(messageRecord));
    state.hasMore = docs.length === PAGE_SIZE;
    renderFeed();
  } catch (ignore) {
    if (state === owner && state.activeBoard === boardId &&
        state.generation === generation && state.paginationRevision === revision) {
      setStatus('לא הצלחנו לטעון הודעות קודמות. אפשר לנסות שוב.', 'error', false);
    }
  } finally {
    if (state === owner) {
      state.loadingOlder = false;
      button.disabled = false;
      button.textContent = 'טען הודעות קודמות';
    }
  }
}

function showComposer(moveFocus) {
  if (!state || !state.activeBoard) return;
  const form = byId('bulletinForm');
  form.classList.remove('hide');
  byId('bulletinCompose').setAttribute('aria-expanded', 'true');
  if (moveFocus) byId('bulletinText').focus();
}

function hideComposer() {
  byId('bulletinForm').classList.add('hide');
  byId('bulletinCompose').setAttribute('aria-expanded', 'false');
  byId('bulletinCompose').focus();
}

async function publishMessage(event) {
  event.preventDefault();
  if (!state || state.publishing || !state.activeBoard) return;

  const checked = validateBulletinText(byId('bulletinText').value);
  const text = checked.text;
  const category = byId('bulletinCategory').value;
  const audience = selectedAudience();
  if (checked.error === 'empty') {
    setFormStatus('כתוב הודעה לפני הפרסום.', 'error');
    byId('bulletinText').focus();
    return;
  }
  if (checked.error === 'too_long') {
    setFormStatus('ההודעה ארוכה מדי. אפשר לכתוב עד ' + MAX_TEXT + ' תווים.', 'error');
    return;
  }
  if (!CATEGORY_BY_ID[category]) {
    setFormStatus('בחר סוג הודעה תקין.', 'error');
    return;
  }
  if (audience === 'station') {
    if (!state.canShiftCommand) {
      setFormStatus('אין לחשבון הזה הרשאה להפיץ לכל התחנות.', 'error');
      setAudience('board', true);
      return;
    }
    if (!state.boards.length) {
      setFormStatus('לא נמצאו תחנות פעילות להפצה.', 'error');
      return;
    }
    if (!byId('bulletinBroadcastApproved').checked) {
      setFormStatus('לפני הפצה רחבה צריך לאשר את רשימת התחנות.', 'error');
      byId('bulletinBroadcastApproved').focus();
      return;
    }
  }
  if (navigator.onLine === false) {
    persistDraft();
    setFormStatus('אין כרגע חיבור. הטיוטה נשמרה ואפשר לנסות שוב כשהרשת תחזור.', 'error');
    return;
  }

  if (!state.draftRequestId) state.draftRequestId = newRequestId();
  if (!state.draftRequestId) {
    setFormStatus('הדפדפן אינו יכול ליצור מזהה פרסום בטוח. הטיוטה נשמרה; נסה לעדכן את הדפדפן.', 'error');
    persistDraft();
    return;
  }
  persistDraft();
  const requestId = state.draftRequestId;
  const owner = state;
  state.attemptedFingerprint = currentDraftFingerprint();
  persistDraft();
  const boardId = state.activeBoard;
  const button = byId('bulletinSubmit');
  state.publishing = true;
  button.disabled = true;
  button.textContent = audience === 'station' ? 'מפיץ…' : 'מפרסם…';
  setFormStatus(audience === 'station'
    ? 'מפיץ את ההודעה לכל התחנות…'
    : 'שולח את ההודעה…', 'info');

  try {
    const result = audience === 'station'
      ? await state.broadcastMessage({
        category: category,
        text: text,
        requestId: requestId
      })
      : await state.postMessage({
        subStationId: boardId,
        category: category,
        text: text,
        requestId: requestId
      });
    if (state !== owner || state.activeBoard !== boardId) return;
    clearDraft(boardId);
    setFormStatus('', '');
    hideComposer();
    setStatus(audience === 'station'
      ? 'ההודעה פורסמה ב־' + Number(result && result.data &&
          result.data.targetCount || state.boards.length) + ' תחנות.'
      : 'ההודעה פורסמה.', 'success', false);
  } catch (error) {
    if (state !== owner || state.activeBoard !== boardId) return;
    // הטקסט וה-requestId נשארים כפי שהם. ניסיון נוסף אינו יכול
    // ליצור כפילות גם אם התשובה מהשרת אבדה בדרך.
    persistDraft();
    const code = String((error && error.code) || '');
    let message = code.indexOf('resource-exhausted') !== -1
      ? 'נשלחו יותר מדי הודעות בזמן קצר. המתן רגע ונסה שוב.'
      : code.indexOf('permission-denied') !== -1
        ? 'אין לחשבון הזה הרשאה לפרסם בלוח התחנה.'
        : 'הפרסום לא הושלם. הטיוטה נשמרה ואפשר לנסות שוב.';
    if (code.indexOf('already-exists') !== -1) {
      // אותו מזהה כבר שימש לתוכן אחר. לא שולחים אוטומטית
      // מזהה חדש, כדי לא ליצור כפילות אם התשובה הקודמת אבדה.
      // הלחיצה הבאה תהיה ניסיון מפורש חדש עם מזהה חדש.
      state.draftRequestId = newRequestId();
      state.attemptedFingerprint = '';
      persistDraft();
      message = 'בקשת הפרסום הקודמת כבר טופלה. בדוק אם ההודעה מופיעה בלוח; אם לא, לחץ שוב לפרסום בטוח.';
    }
    setFormStatus(message, 'error');
  } finally {
    if (state === owner) {
      state.publishing = false;
      button.disabled = false;
      updateAudienceUi(false);
    }
  }
}

async function hideMessage(item, button) {
  if (!state || !state.isSuper || button.disabled) return;
  if (!window.confirm('להסתיר את ההודעה מהלוח? הפעולה תישמר בתיעוד.')) return;
  const boardId = state.activeBoard;
  const owner = state;
  button.disabled = true;
  button.textContent = 'מסתיר…';
  try {
    await state.hideMessage({
      sid: state.stationId,
      subStationId: boardId,
      messageId: item.id
    });
    if (state !== owner || state.activeBoard !== boardId) return;
    // הסרה מקומית רק אחרי אישור השרת. ה-listener יאשרר אותה.
    state.liveDocs = state.liveDocs.filter(function (x) { return x.id !== item.id; });
    state.olderDocs = state.olderDocs.filter(function (x) { return x.id !== item.id; });
    renderFeed();
    setStatus('ההודעה הוסתרה.', 'success', false);
  } catch (ignore) {
    if (state !== owner) return;
    button.disabled = false;
    button.textContent = 'הסתר';
    setStatus('ההסתרה לא הושלמה. ההודעה נשארה בלוח.', 'error', false);
  }
}

function handleVisibility() {
  if (!state) return;
  if (document.visibilityState === 'hidden') {
    stopListener();
    stopReplyListener();
    clearTimeout(state.readTimer);
  } else {
    if (state.activeBoard && !state.unsubscribe) subscribeToActive(true);
    if (state.replyThread && !state.replyUnsubscribe) subscribeReplies();
  }
}

function handleOffline() {
  if (!state) return;
  setStatus('אין חיבור לרשת. מוצג המידע האחרון שהגיע למכשיר.', 'offline', false);
}

function handleOnline() {
  if (!state || !state.activeBoard) return;
  if (!state.unsubscribe) subscribeToActive(true);
  else setStatus('החיבור חזר. מעדכן את הלוח…', 'loading', false);
}

function wireEvents() {
  const signal = state.abort.signal;
  byId('bulletinCompose').addEventListener('click', function () {
    const hidden = byId('bulletinForm').classList.contains('hide');
    if (hidden) showComposer(true);
    else hideComposer();
  }, { signal: signal });
  byId('bulletinCancel').addEventListener('click', hideComposer, { signal: signal });
  byId('bulletinText').addEventListener('input', function () {
    updateCharCount();
    renewIdentityAfterEdit();
    persistDraft();
    setFormStatus('', '');
  }, { signal: signal });
  byId('bulletinCategory').addEventListener('change', function () {
    renewIdentityAfterEdit();
    persistDraft();
  }, { signal: signal });
  byId('bulletinAudience').addEventListener('change', function (event) {
    if (!event.target.matches('input[name="bulletinAudience"]')) return;
    updateAudienceUi(true);
    renewIdentityAfterEdit();
    persistDraft();
    setFormStatus('', '');
  }, { signal: signal });
  byId('bulletinBroadcastApproved').addEventListener('change', function () {
    setFormStatus('', '');
  }, { signal: signal });
  byId('bulletinForm').addEventListener('submit', publishMessage, { signal: signal });
  byId('bulletinRetry').addEventListener('click', function () {
    subscribeToActive(true);
  }, { signal: signal });
  byId('bulletinLoadMore').addEventListener('click', loadOlder, { signal: signal });
  document.addEventListener('visibilitychange', handleVisibility, { signal: signal });
  window.addEventListener('pagehide', function () {
    stopListener();
    stopReplyListener();
  }, { signal: signal });
  window.addEventListener('pageshow', handleVisibility, { signal: signal });
  window.addEventListener('offline', handleOffline, { signal: signal });
  window.addEventListener('online', handleOnline, { signal: signal });
}

function renderCategoryOptions() {
  const select = byId('bulletinCategory');
  select.replaceChildren();
  CATEGORIES.forEach(function (category) {
    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = category.icon + ' ' + category.label;
    select.appendChild(option);
  });
}

function renderIdentity() {
  const profile = state.profile || {};
  const claims = state.claims || {};
  const name = profile.full_name || state.user.displayName || state.user.email || '';
  const role = state.roleLabels[claims.role] || claims.role || '';
  const crew = claims.shift ? ('משמרת ' + claims.shift) : '';
  byId('bulletinIdentity').textContent = [name, role, crew].filter(Boolean).join(' · ');
}

// options: { db, functions, user, claims, stationId, profile,
//            sdk, roleLabels, fallbackBoards, canAccess }
export function initBulletin(options) {
  destroyBulletin();
  if (!byId('bulletinBoard')) return null;

  const opts = options || {};
  purgeLegacyBulletinDrafts();
  purgeLegacyBulletinReads();
  const claims = opts.claims || {};
  const isSuper = claims.super === true || claims.role === 'super_admin';
  const canShiftCommand = isSuper ||
    claims.role === 'commander' || claims.role === 'deputy';
  state = {
    db: opts.db,
    functions: opts.functions,
    user: opts.user || {},
    claims: claims,
    stationId: String(opts.stationId || ''),
    profile: opts.profile || {},
    sdk: opts.sdk || {},
    roleLabels: opts.roleLabels || {},
    fallbackBoards: Array.isArray(opts.fallbackBoards) ? opts.fallbackBoards : [],
    boards: [],
    activeBoard: '',
    liveDocs: [],
    olderDocs: [],
    unread: {},
    unsubscribe: null,
    generation: 0,
    paginationRevision: 0,
    readTimer: 0,
    hasMore: false,
    loadingOlder: false,
    lastLoadFromCache: false,
    draftRequestId: '',
    attemptedFingerprint: '',
    publishing: false,
    replyPublishing: false,
    replyThread: null,
    replyDrafts: {},
    replyUnsubscribe: null,
    replyGeneration: 0,
    canAccess: opts.canAccess !== false,
    isSuper: isSuper,
    canShiftCommand: canShiftCommand,
    postMessage: null,
    broadcastMessage: null,
    replyMessage: null,
    hideMessage: null,
    hideReply: null,
    abort: new AbortController()
  };

  renderIdentity();
  byId('bulletinPrivacy').classList.remove('hide');
  byId('boardTabs').classList.remove('hide');
  byId('bulletinFeed').classList.remove('hide');
  byId('bulletinCompose').classList.remove('hide');
  byId('bulletinForm').classList.add('hide');
  byId('bulletinCompose').setAttribute('aria-expanded', 'false');
  byId('bulletinCompose').disabled = true;
  byId('bulletinEmpty').textContent =
    'עדיין אין הודעות בלוח הזה. אפשר להיות הראשון שמעדכן את המשמרת.';
  byId('bulletinEmpty').classList.add('hide');
  byId('bulletinLoadMore').classList.add('hide');
  byId('bulletinRetry').classList.add('hide');
  byId('bulletinAudience').classList.toggle('hide', !state.canShiftCommand);
  setAudience('board', true);

  // תפקיד תקף שאינו חבר תחנה (כגון מפקד מחוז) מקבל מסך
  // מפורש ולא לוח מדומה שייכשל רק אחרי לחיצה. חשוב שהחזרה הזו
  // תהיה לפני יצירת callables, קריאת תחנות או listener.
  if (!state.canAccess) {
    byId('bulletinPrivacy').classList.add('hide');
    byId('boardTabs').replaceChildren();
    byId('boardTabs').classList.add('hide');
    byId('bulletinFeed').replaceChildren();
    byId('bulletinFeed').classList.add('hide');
    byId('bulletinFeed').setAttribute('aria-busy', 'false');
    byId('bulletinCompose').classList.add('hide');
    byId('bulletinEmpty').textContent = 'לוח המודעות זמין לחברי התחנה בלבד.';
    byId('bulletinEmpty').classList.remove('hide');
    setStatus('', '', false);
    return { destroy: destroyBulletin };
  }

  state.postMessage = opts.sdk.httpsCallable(opts.functions, 'postBulletinMessage');
  if (state.canShiftCommand) {
    state.broadcastMessage = opts.sdk.httpsCallable(
      opts.functions, 'broadcastBulletinMessage'
    );
    state.replyMessage = opts.sdk.httpsCallable(
      opts.functions, 'replyToBulletinMessage'
    );
  }
  if (state.isSuper) {
    state.hideMessage = opts.sdk.httpsCallable(opts.functions, 'hideBulletinMessage');
    state.hideReply = opts.sdk.httpsCallable(opts.functions, 'hideBulletinReply');
  }
  renderCategoryOptions();
  wireEvents();
  byId('bulletinFeed').setAttribute('aria-busy', 'true');
  setStatus('טוען את תחנות המשנה…', 'loading', false);
  const owner = state;
  loadBoards().catch(function () {
    if (state === owner) setStatus('לא הצלחנו לטעון את תחנות המשנה.', 'error', true);
  });
  return { destroy: destroyBulletin };
}

export function destroyBulletin() {
  if (!state) return;
  persistDraft();
  stopListener();
  stopReplyListener();
  clearTimeout(state.readTimer);
  state.generation++;
  state.abort.abort();
  state = null;
}
