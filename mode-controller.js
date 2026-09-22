/* Shared runtime-mode controller.
 *
 * One authenticated Firestore listener is shared by every screen through
 * nav.js. mode-bar.js remains a presentation-only module. A normal member gets
 * status only; a signed super gets an action whose authority is revalidated by
 * the callable immediately before the atomic write.
 */
import { getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, onSnapshot }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from './monitored-functions.js?v=42h31';
import { configureModeAction, renderModeBar, stationMode } from './mode-bar.js?v=42h31';

let unsubscribe = null;
let actorKey = '';
let latestRevision = null;
let latestClaims = null;

function requestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return 'runtime_' + globalThis.crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return 'runtime_' + Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function userMessage(error) {
  const code = String(error && error.code || '').replace(/^functions\//, '');
  if (code === 'aborted') return 'המצב השתנה במקביל. הנתונים נטענים מחדש.';
  if (code === 'permission-denied' || code === 'unauthenticated') {
    return 'הרשאת מנהל־העל אינה פעילה. התחבר מחדש ונסה שוב.';
  }
  if (code === 'failed-precondition') return 'מצב המערכת אינו זמין כרגע.';
  if (code === 'unavailable' || code === 'deadline-exceeded') {
    return 'אין כרגע חיבור יציב לשירות. המצב לא שונה.';
  }
  return 'העדכון לא בוצע. מצב המערכת לא השתנה.';
}

function stopListener() {
  if (unsubscribe) {
    try { unsubscribe(); } catch (ignore) {}
  }
  unsubscribe = null;
  actorKey = '';
  latestRevision = null;
  latestClaims = null;
  configureModeAction(null);
}

function configureAction(app) {
  if (!latestClaims || latestClaims.super !== true || !Number.isSafeInteger(latestRevision)) {
    configureModeAction(null);
    return;
  }
  const change = httpsCallable(getFunctions(app, 'europe-west1'), 'setSilentMode');
  configureModeAction(async targetMode => {
    const current = stationMode();
    if ((targetMode !== 'trial' && targetMode !== 'live') || current === targetMode) return;
    const toLive = targetMode === 'live';
    const warning = toLive
      ? 'המערכת כולה עוברת למצב חי.\n\nהתראות, קריאות פתע ומיילים יישלחו לנמענים האמיתיים בכל התחנות.\n\nלהמשיך?'
      : 'המערכת כולה עוברת למצב אימון.\n\nהתראות אמת ייחסמו, ורק חשבון מנהל־העל שמבצע את השינוי יישאר חשבון בדיקה.\n\nלהמשיך?';
    if (!window.confirm(warning)) return;
    try {
      const response = await change({
        silent: targetMode === 'trial',
        expected_revision: latestRevision,
        request_id: requestId()
      });
      const value = response && response.data || {};
      if ((value.mode !== 'trial' && value.mode !== 'live')
          || !Number.isSafeInteger(value.revision) || value.revision < 0) {
        throw Object.assign(new Error('invalid mode response'), { code: 'functions/internal' });
      }
      latestRevision = value.revision;
      // This is the committed server response, not an optimistic repaint.
      renderModeBar(value.mode);
    } catch (error) {
      // A revision conflict is resolved by the already-active snapshot. Never
      // guess which mode won and never paint a requested state on failure.
      console.error('runtime mode update failed', error);
      const wrapped = new Error('runtime mode update failed');
      wrapped.userMessage = userMessage(error);
      throw wrapped;
    }
  });
}

export function startModeController(claims) {
  if (!getApps().length) return;
  const app = getApp();
  const user = getAuth(app).currentUser;
  if (!user) {
    stopListener();
    renderModeBar(null);
    return;
  }

  latestClaims = claims || {};
  if (actorKey === user.uid && unsubscribe) {
    configureAction(app);
    return;
  }
  stopListener();
  actorKey = user.uid;
  latestClaims = claims || {};
  const db = getFirestore(app);
  unsubscribe = onSnapshot(doc(db, 'config', 'mode'), snapshot => {
    const value = snapshot.exists() ? snapshot.data() || {} : {};
    if (value.mode !== 'trial' && value.mode !== 'live') {
      latestRevision = null;
      configureModeAction(null);
      renderModeBar(null);
      return;
    }
    const revision = Number(value.revision);
    latestRevision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    renderModeBar(value.mode);
    configureAction(app);
  }, error => {
    console.error('runtime mode listener failed', error);
    latestRevision = null;
    configureModeAction(null);
    renderModeBar(null);
  });
}

export function stopModeController() {
  stopListener();
  renderModeBar(null);
}
