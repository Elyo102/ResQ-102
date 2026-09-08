import { firebaseConfig } from './firebase-config.js?v=42h6';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onIdTokenChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, httpsCallable } from './monitored-functions.js?v=42h6';
import { initAppCheck } from './appcheck.js?v=42h6';
import { createHrHoursUI } from './hr-hours-ui.js?v=42h6';

const app = initializeApp(firebaseConfig);
await initAppCheck(app);
const auth = getAuth(app);
const functions = getFunctions(app, 'europe-west1');
const list = httpsCallable(functions, 'getHrMonthReports');
const detail = httpsCallable(functions, 'getHrEmployeeReport');
const nudge = httpsCallable(functions, 'requestHrHoursNudge');
const nudgeStatus = httpsCallable(functions, 'getHrHoursNudgeStatus');
const nudges = httpsCallable(functions, 'listHrHoursNudges');
const listeners = new Set();
let epoch = 0;
let user = null;
let session = null;
function notify() { for (const listener of listeners) listener(); }
function currentSession() {
  return user && auth.currentUser === user ? session : null;
}
function denied() {
  return Object.assign(new Error('נדרש חיבור עם הרשאת משאבי אנוש.'), { code: 'functions/unauthenticated' });
}
async function call(transport, data) {
  const origin = currentSession();
  const originUser = user;
  if (!origin) throw denied();
  try {
    const result = await transport(data);
    if (currentSession() !== origin || user !== originUser) throw denied();
    return result.data;
  } catch (error) {
    // A revoked live profile must erase already-rendered private data. An old
    // request must never erase a subsequently authenticated user's session.
    if (currentSession() === origin && user === originUser &&
        ['functions/permission-denied', 'functions/unauthenticated'].includes(error?.code)) {
      ++epoch;
      session = null;
      user = null;
      notify();
    }
    throw error;
  }
}
createHrHoursUI(document.getElementById('hr-workspace'), {
  currentSession,
  subscribeIdentity(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  listMonth(data) { return call(list, data); },
  getEmployeeMonth(data) { return call(detail, data); },
  requestNudge(data) { return call(nudge, data); },
  getNudgeStatus(data) { return call(nudgeStatus, data); },
  listNudges(data) { return call(nudges, data); }
});
onIdTokenChanged(auth, async candidate => {
  const generation = ++epoch;
  user = null;
  session = null;
  notify(); // Clear synchronously, before token claims can suspend this turn.
  if (!candidate) return;
  try {
    const { claims } = await candidate.getIdTokenResult();
    if (generation !== epoch || auth.currentUser !== candidate) return;
    if (!claims || (claims.super !== true && claims.role !== 'hr_coordinator') ||
        typeof claims.stationId !== 'string' || !claims.stationId.trim()) return;
    user = candidate;
    session = Object.freeze({ uid: candidate.uid, stationId: claims.stationId,
      role: claims.role, super: claims.super === true, epoch: generation });
    notify();
  } catch (_) {
    // Claims failure remains signed out. No private errors or token logging.
  }
}, () => {
  ++epoch; user = null; session = null; notify();
});
