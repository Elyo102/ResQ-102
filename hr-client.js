import { firebaseConfig } from './firebase-config.js?v=42h11';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onIdTokenChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, query, where, limit, getDocsFromServer } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from './monitored-functions.js?v=42h11';
import { initAppCheck } from './appcheck.js?v=42h11';
import { createHrHoursUI } from './hr-hours-ui.js?v=42h11';
import { createMonthArchiveUI } from './hr-month-archive-ui.js?v=42h11';
import { buildLocalMonthFiles } from './hr-month-archive.js?v=42h11';
import { createLocalExportUI } from './hr-local-export-ui.js?v=42h11';
import { createHrWorkforceUI } from './hr-workforce-ui.js?v=42h11';
import { MEMBER_ROLES } from './roles.js?v=42h11';

const app = initializeApp(firebaseConfig);
await initAppCheck(app);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'europe-west1');
const list = httpsCallable(functions, 'getHrMonthReports');
const detail = httpsCallable(functions, 'getHrEmployeeReport');
const review = httpsCallable(functions, 'saveHrEmployeeReview');
const nudge = httpsCallable(functions, 'requestHrHoursNudge');
const nudgeStatus = httpsCallable(functions, 'getHrHoursNudgeStatus');
const nudges = httpsCallable(functions, 'listHrHoursNudges');
const listWorkforce = httpsCallable(functions, 'listHrWorkforceCases');
const createWorkforce = httpsCallable(functions, 'createHrWorkforceCase');
const updateWorkforce = httpsCallable(functions, 'updateHrWorkforceCase');
const remindWorkforce = httpsCallable(functions, 'queueHrWorkforceReminder');
const listeners = new Set();
let epoch = 0;
let user = null;
let session = null;
const REPORT_TTL_MS = 30000, REPORT_CACHE_ENTRIES = 10, REPORT_CACHE_BYTES = 512 * 1024;
const reportCache = new Map(), latestReportFetch = new Map();
let cacheOwner = null, cacheGeneration = 0, fetchSequence = 0, cacheBytes = 0;
function clearReportCache() {
  ++cacheGeneration; reportCache.clear(); latestReportFetch.clear(); cacheBytes = 0; cacheOwner = null;
}
function notify() { clearReportCache(); for (const listener of listeners) listener(); }
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
function removeReport(key) {
  const entry = reportCache.get(key);
  if (entry) { cacheBytes -= entry.bytes; reportCache.delete(key); }
}
async function getEmployeeMonth(data, { forceFresh = false } = {}) {
  const origin = currentSession(), originUser = user;
  if (!origin) { clearReportCache(); throw denied(); }
  if (cacheOwner !== origin || forceFresh) { clearReportCache(); cacheOwner = origin; }
  const key = JSON.stringify([origin.stationId, data.month, data.uid]), at = Date.now();
  // TTL is a reuse deadline, not a promise to discover remote revocation or
  // remove a report already rendered on screen. No stale/offline fallback.
  for (const [id, entry] of reportCache) if (at < entry.fetchedAt || at >= entry.expiresAt) removeReport(id);
  const cached = reportCache.get(key);
  if (cached) {
    if (currentSession() !== origin || user !== originUser) { clearReportCache(); throw denied(); }
    reportCache.delete(key); reportCache.set(key, cached); // LRU only; never extend TTL.
    return { report: structuredClone(cached.report), freshness: { source: 'memory', fetched_at_ms: cached.fetchedAt, expires_at_ms: cached.expiresAt } };
  }
  const generation = cacheGeneration, sequence = ++fetchSequence;
  latestReportFetch.set(key, sequence);
  try {
    const report = await call(detail, data), fetchedAt = Date.now(), expiresAt = fetchedAt + REPORT_TTL_MS;
    if (!report || report.uid !== data.uid || report.month !== data.month || !Array.isArray(report.rows) || report.rows.length > 31) throw new Error('Invalid report response.');
    const bytes = new TextEncoder().encode(JSON.stringify(report)).byteLength;
    if (currentSession() !== origin || user !== originUser) throw denied();
    if (generation === cacheGeneration && cacheOwner === origin && latestReportFetch.get(key) === sequence && bytes <= REPORT_CACHE_BYTES) {
      removeReport(key);
      reportCache.set(key, { report: structuredClone(report), bytes, fetchedAt, expiresAt }); cacheBytes += bytes;
      while (reportCache.size > REPORT_CACHE_ENTRIES || cacheBytes > REPORT_CACHE_BYTES) removeReport(reportCache.keys().next().value);
    }
    return { report: structuredClone(report), freshness: { source: 'server', fetched_at_ms: fetchedAt, expires_at_ms: expiresAt } };
  } finally {
    if (generation === cacheGeneration && latestReportFetch.get(key) === sequence) latestReportFetch.delete(key);
  }
}
window.addEventListener('pagehide', clearReportCache);
async function reviewEmployeeMonth(data) {
  const origin=currentSession(),originUser=user;
  if(!origin)throw denied();
  const result=await call(review,data);
  // call() fences transport; this second fence owns effects after our await.
  if(currentSession()!==origin || user!==originUser)throw denied();
  clearReportCache();
  return result;
}
const hoursAdapter = {
  currentSession,
  subscribeIdentity(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  listMonth(data) { return call(list, data); },
  getEmployeeMonth,
  reviewEmployeeMonth,
  clearReportCache,
  requestNudge(data) { return call(nudge, data); },
  getNudgeStatus(data) { return call(nudgeStatus, data); },
  listNudges(data) { return call(nudges, data); }
};
createHrHoursUI(document.getElementById('hr-workspace'), hoursAdapter);
createMonthArchiveUI(document.getElementById('hr-workspace'), hoursAdapter);
createLocalExportUI(document.querySelector('[data-hr-local-export]'), {
  ...hoursAdapter,
  exportFiles(month, { guard }) { return buildLocalMonthFiles(hoursAdapter, month, { guard }); }
}, { monthElement: document.querySelector('[data-hr="month"]') });
function sameStation(value, sid) {
  if (!value || typeof value !== 'object') return false;
  const ids = ['stationId','station_id','station'].flatMap(k => typeof value[k] === 'string' && value[k].trim() ? [value[k].trim()] : []);
  return ids.length > 0 && ids.every(id => id === sid);
}
async function searchPeople({ name }) {
  const origin=currentSession(),originUser=user;
  if(!origin || typeof name!=='string')throw denied();
  const key=name.trim().toLowerCase().replace(/["'`׳״]/g,'');
  if(key.length<2||key.length>80)throw new Error('invalid search');
  const snap=await getDocsFromServer(query(collection(db,'directory'),where('name_prefixes','array-contains',key),limit(25)));
  if(currentSession()!==origin||user!==originUser)throw denied();
  return {items:snap.docs.flatMap(doc=>{const p=doc.data();return sameStation(p,origin.stationId)&&p.active!==false&&p.is_active!==false&&MEMBER_ROLES.includes(p.role)&&typeof p.full_name==='string'&&p.full_name.trim()
    ?[{uid:doc.id,name:p.full_name.slice(0,160),crew:typeof p.crew==='string'?p.crew.slice(0,40):'',employee_number:String(p.employee_number??'').slice(0,64)}]:[];}),limited:snap.docs.length>=25};
}
createHrWorkforceUI(document.querySelector('[data-hr-workforce]'), {
  currentSession, subscribeIdentity(listener){listeners.add(listener);return()=>listeners.delete(listener);}, searchPeople,
  listCases:data=>call(listWorkforce,data), createCase:data=>call(createWorkforce,data), updateCase:data=>call(updateWorkforce,data),
  queueReminder:data=>call(remindWorkforce,data)
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
