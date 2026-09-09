import { firebaseConfig } from './firebase-config.js?v=42h7';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onIdTokenChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, httpsCallable } from './monitored-functions.js?v=42h7';
import { initAppCheck } from './appcheck.js?v=42h7';
import { MEMBER_ROLES } from './roles.js?v=42h7';
import { createHrRequestsUI } from './hr-requests-ui.js?v=42h7';

import { createHrAttachmentsUI } from './hr-attachments-ui.js?v=42h7';

const app = initializeApp(firebaseConfig);
await initAppCheck(app);
const auth = getAuth(app), functions = getFunctions(app, 'europe-west1');
const names = { create: 'createHrRequest', list: 'listMyHrRequests', listInbox: 'listHrRequestsInbox',
  get: 'getHrRequest', reply: 'replyHrRequest', setStatus: 'setHrRequestStatus', nudge: 'nudgeHrRequest' };
const transports = Object.fromEntries(Object.entries(names).map(([method, name]) => [method, httpsCallable(functions, name)]));
const listeners = new Set();
let epoch = 0, user = null, session = null;
const notify = () => { for (const listener of listeners) listener(); };
const currentSession = () => user && auth.currentUser === user ? session : null;
const denied = () => Object.assign(new Error('נדרש חיבור עדכני כעובד תחנה פעיל.'), { code: 'functions/unauthenticated' });

const attachmentNames = { reserve: 'reserveHrAttachment', upload: 'uploadHrAttachment',
  resume: 'resumeHrAttachment', list: 'listHrAttachments', download: 'downloadHrAttachment' };
const attachmentTransports = Object.fromEntries(Object.entries(attachmentNames).map(([method, name]) => [method, httpsCallable(functions, name)]));
async function attachmentEpoch(candidate, claims) {
  if (!Number.isSafeInteger(claims.auth_time) || claims.auth_time < 0) return null;
  const bytes = new TextEncoder().encode(JSON.stringify([candidate.uid, claims.stationId,
    claims.super === true ? 'super_admin' : claims.role, claims.super === true]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Object.freeze({ uid: candidate.uid, station_id: claims.stationId, auth_time: claims.auth_time,
    claims_digest: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') });
}
async function attachmentCall(method, data) {
  const origin = currentSession(), originUser = user;
  if (!origin?.attachmentEpoch) throw denied();
  try {
    const { data: result } = await attachmentTransports[method](data);
    if (currentSession() !== origin || user !== originUser) throw denied();
    const expected = origin.attachmentEpoch, actual = result?.epoch;
    if (!actual || !['uid', 'station_id', 'auth_time', 'claims_digest'].every(key => actual[key] === expected[key])) throw denied();
    return result;
  } catch (error) {
    if (currentSession() === origin && user === originUser &&
      ['functions/permission-denied', 'functions/unauthenticated'].includes(error?.code)) {
      ++epoch; user = null; session = null; notify();
    }
    throw error;
  }
}
function mountAttachments(element, callbacks) {
  return createHrAttachmentsUI(element, { ...callbacks, currentSession,
    subscribeIdentity(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    ...Object.fromEntries(Object.keys(attachmentNames).map(method => [method, data => attachmentCall(method, data)])) });
}

async function call(method, data) {
  const origin = currentSession(), originUser = user;
  if (!origin) throw denied();
  try {
    const value = await transports[method](data);
    if (currentSession() !== origin || user !== originUser) throw denied();
    return value.data;
  } catch (error) {
    if (currentSession() === origin && user === originUser &&
      ['functions/permission-denied', 'functions/unauthenticated'].includes(error?.code)) {
      ++epoch; user = null; session = null; notify();
    }
    throw error;
  }
}
createHrRequestsUI(document.getElementById('hr-requests'), {
  mountAttachments, currentSession, subscribeIdentity(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  ...Object.fromEntries(Object.keys(names).map(method => [method, data => call(method, data)]))
});
onIdTokenChanged(auth, async candidate => {
  const generation = ++epoch;
  user = null; session = null; notify();
  if (!candidate) return;
  try {
    const { claims } = await candidate.getIdTokenResult();
    if (generation !== epoch || auth.currentUser !== candidate) return;
    if (!claims || (claims.super !== true && !MEMBER_ROLES.includes(claims.role)) ||
      typeof claims.stationId !== 'string' || !claims.stationId.trim()) return;
    const serverEpoch = await attachmentEpoch(candidate, claims);
    if (generation !== epoch || auth.currentUser !== candidate) return;
    user = candidate;
    session = Object.freeze({ uid: candidate.uid, stationId: claims.stationId,
      role: claims.role, super: claims.super === true, epoch: generation, attachmentEpoch: serverEpoch });
    notify();
  } catch (_) { /* Claims failure remains disconnected; no private error logging. */ }
}, () => { ++epoch; user = null; session = null; notify(); });
