import { firebaseConfig } from './firebase-config.js?v=42h7';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onIdTokenChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, doc, query, where, limit, getDocsFromServer, getDocFromServer } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from './monitored-functions.js?v=42h7';
import { initAppCheck } from './appcheck.js?v=42h7';
import { MEMBER_ROLES } from './roles.js?v=42h7';
import { createHrDocumentsUI } from './hr-documents-ui.js?v=42h7';

import { createHrAttachmentsUI } from './hr-attachments-ui.js?v=42h7';

const app = initializeApp(firebaseConfig);
await initAppCheck(app);
const auth = getAuth(app), db = getFirestore(app), functions = getFunctions(app, 'europe-west1');
const names = { publish: 'publishHrDocument', revise: 'reviseHrDocument', listMine: 'listMyHrDocuments',
  listProcedures: 'listHrProcedures', listManaged: 'listManagedHrDocuments', get: 'getHrDocument',
  markOpened: 'markHrDocumentOpened', acknowledge: 'acknowledgeHrDocument', listReceipts: 'listHrDocumentReceipts', nudge: 'nudgeHrDocument' };
const transports = Object.fromEntries(Object.entries(names).map(([method, name]) => [method, httpsCallable(functions, name)]));
const listeners = new Set();
let epoch = 0, user = null, session = null;
const currentSession = () => user && auth.currentUser === user ? session : null;
const notify = () => { for (const listener of listeners) listener(); };
const denied = () => Object.assign(new Error('נדרש חיבור עדכני כעובד תחנה פעיל.'), { code: 'functions/unauthenticated' });
const manager = s => s?.super === true || s?.role === 'hr_coordinator';
const uid = v => typeof v === 'string' && /^[^\u0000-\u001f\u007f/]{1,128}$/.test(v);
function originManager() { const s = currentSession(); if (!s || !manager(s)) throw denied(); return s; }
function checkOrigin(s) { if (currentSession() !== s) throw denied(); }

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
function sameStation(p, sid) {
  if (!p || typeof p !== 'object') return false;
  const values = [];
  for (const key of ['stationId', 'station_id', 'station']) {
    if (!Object.hasOwn(p, key) || p[key] == null || p[key] === '') continue;
    if (typeof p[key] !== 'string' || !/^[A-Za-z0-9_-]{2,120}$/.test(p[key].trim())) return false;
    values.push(p[key].trim());
  }
  return values.length > 0 && values.every(value => value === sid);
}
async function searchPeople({ name }) {
  const s = originManager();
  if (typeof name !== 'string' || name.length > 80) throw new Error('invalid search');
  const key = name.trim().toLowerCase().replace(/["'`׳״]/g, '');
  if (key.length < 2) throw new Error('invalid search');
  // Existing approved directory search, not an Auth scan or new audience API.
  const page = await getDocsFromServer(query(collection(db, 'directory'), where('name_prefixes', 'array-contains', key), limit(25)));
  checkOrigin(s);
  const items = page.docs.flatMap(snap => {
    const p = snap.data();
    if (!uid(snap.id) || !sameStation(p, s.stationId) || p.active === false || p.is_active === false || !MEMBER_ROLES.includes(p.role)
      || typeof p.full_name !== 'string' || !p.full_name.trim()) return [];
    return [{ uid: snap.id, name: p.full_name.slice(0, 200), crew: typeof p.crew === 'string' ? p.crew.slice(0, 40) : '' }];
  });
  return { items, limited: page.docs.length >= 25 };
}
async function lookupNames({ uids }) {
  const s = originManager();
  if (!Array.isArray(uids) || uids.length > 25 || uids.some(v => !uid(v))) throw new Error('invalid name lookup');
  const unique = [...new Set(uids)];
  const values = await Promise.allSettled(unique.map(value => getDocFromServer(doc(db, 'directory', value))));
  checkOrigin(s);
  const result = {};
  values.forEach((item, i) => {
    if (item.status !== 'fulfilled' || !item.value.exists()) return;
    const p = item.value.data();
    if (sameStation(p, s.stationId) && typeof p.full_name === 'string' && p.full_name.trim()) {
      Object.defineProperty(result, unique[i], { value: p.full_name.slice(0, 200), enumerable: true });
    }
  });
  return result; // Missing/moved/unavailable names never remove receipt rows.
}
createHrDocumentsUI(document.getElementById('hr-documents'), {
  mountAttachments, currentSession, subscribeIdentity(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  ...Object.fromEntries(Object.keys(names).map(method => [method, data => call(method, data)])), searchPeople, lookupNames
});
onIdTokenChanged(auth, async candidate => {
  const generation = ++epoch; user = null; session = null; notify();
  if (!candidate) return;
  try {
    const { claims } = await candidate.getIdTokenResult();
    if (generation !== epoch || auth.currentUser !== candidate) return;
    if (!claims || (claims.super !== true && !MEMBER_ROLES.includes(claims.role)) || typeof claims.stationId !== 'string' || !claims.stationId.trim()) return;
    const serverEpoch = await attachmentEpoch(candidate, claims);
    if (generation !== epoch || auth.currentUser !== candidate) return;
    user = candidate; session = Object.freeze({ uid: candidate.uid, stationId: claims.stationId, role: claims.role, super: claims.super === true, epoch: generation, attachmentEpoch: serverEpoch }); notify();
  } catch (_) { /* No identity or private error logging. */ }
}, () => { ++epoch; user = null; session = null; notify(); });
