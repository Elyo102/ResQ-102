'use strict';

// H2 hardening for the three unauthenticated auth callables
// (loginWithEmployeeNumber, requestPasswordReset, unlockAccount).
//
// Design constraints from the security review (all enforced + tested in
// auth-hardening.test.js):
//  * Per-employee-number throttle is a PROGRESSIVE BACKOFF with a small cap
//    (BACKOFF_CAP_MS). There is no hard lockout: an attacker who knows a
//    commander's employee number can slow the commander down by at most the
//    cap, never lock the account out during an emergency.
//  * The per-employee key is derived from the employee number ONLY. Nothing
//    from the request (X-Forwarded-For, user agent) enters it.
//  * The client IP (last trusted hop) is only an ADDITIONAL in-memory signal.
//    It is hashed with a per-process random salt and never stored.
//  * The global surge signal only HARDENS (extra delay for requests without a
//    valid App Check token). It never blocks: a whole station behind one NAT
//    must still be able to log in during an emergency.
//  * Only real credential failures are counted. 429 / 5xx /
//    TOO_MANY_ATTEMPTS_TRY_LATER from Identity Toolkit are upstream problems,
//    not evidence of guessing.
//  * Responses are uniform and padded to a constant time floor so existing
//    and non-existing employee numbers are indistinguishable.

const crypto = require('crypto');

const BACKOFF_FREE_FAILURES = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 3000;
const WARN_AFTER_FAILURES = 8;
const WARN_PUSH_COOLDOWN_MS = 30 * 60 * 1000;
const LOGIN_FLOOR_MS = 1500;
const RESET_FLOOR_MS = 2000;
const UNLOCK_FLOOR_MS = 600;
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_SURGE_FAILURES = 120;
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_SUSPICIOUS_DISTINCT_EMPS = 12;
const IP_TABLE_MAX = 5000;
const MAIL_PER_RECIPIENT_HOUR = 3;
const MAIL_PER_RECIPIENT_DAY = 6;
// Gmail SMTP allows ~500 messages/day for a consumer account. Auth mail may use
// at most this many per Israel day, which keeps the rest for HR reports.
const AUTH_MAIL_DAILY_BUDGET = 150;

const CREDENTIAL_FAILURES = new Set([
  'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'EMAIL_NOT_FOUND',
  'USER_DISABLED', 'INVALID_EMAIL', 'MISSING_PASSWORD'
]);

function backoffDelayMs(failures) {
  const n = Number(failures) || 0;
  if (n <= BACKOFF_FREE_FAILURES) return 0;
  const exp = Math.min(20, n - BACKOFF_FREE_FAILURES - 1);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, exp));
}

// Identity Toolkit error body: { error: { code: 400, message: 'INVALID_PASSWORD' } }
// message can carry a suffix, e.g. 'TOO_MANY_ATTEMPTS_TRY_LATER : ...'.
function classifySignInFailure(status, body) {
  const s = Number(status) || 0;
  const raw = body && body.error && typeof body.error.message === 'string' ? body.error.message : '';
  const code = raw.split(/[\s:]/)[0];
  if (s === 429 || s >= 500 || code === 'TOO_MANY_ATTEMPTS_TRY_LATER' || code === 'QUOTA_EXCEEDED') {
    return 'upstream';
  }
  if (s === 400 && CREDENTIAL_FAILURES.has(code)) return 'credential';
  if (s === 400 && code === '') return 'credential';
  return 'upstream';
}

// Employee-number key. Only the employee number goes in; the request cannot
// influence it (test: spoofed X-Forwarded-For does not change it).
function employeeKey(emp) {
  return String(emp || '');
}

// Cloud Functions v2 runs behind Google's front end, which APPENDS the client
// address it saw to X-Forwarded-For. Everything to the left of that entry is
// client-controlled. We therefore take the entry `trustedHops` from the right.
// OWNER/staging: verify the hop count in staging logs before relying on it.
function clientIpSignal(rawRequest, trustedHops) {
  const hops = Number.isInteger(trustedHops) && trustedHops > 0 ? trustedHops : 1;
  const headers = (rawRequest && rawRequest.headers) || {};
  const xff = String(headers['x-forwarded-for'] || '');
  const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= hops) return parts[parts.length - hops];
  return String((rawRequest && (rawRequest.ip || (rawRequest.socket && rawRequest.socket.remoteAddress))) || '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function israelDay(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(nowMs));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

function createAuthHardening(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const sleep = typeof d.sleep === 'function' ? d.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const log = typeof d.log === 'function' ? d.log : () => {};
  const salt = crypto.randomBytes(16).toString('hex');
  const ipTable = new Map();
  let globalWindowStart = 0;
  let globalFailures = 0;

  function noteGlobalFailure() {
    const t = now();
    if (t - globalWindowStart > GLOBAL_WINDOW_MS) { globalWindowStart = t; globalFailures = 0; }
    globalFailures += 1;
  }

  function globalSurge() {
    const t = now();
    if (t - globalWindowStart > GLOBAL_WINDOW_MS) return false;
    return globalFailures >= GLOBAL_SURGE_FAILURES;
  }

  function ipBucket(ip) {
    return ip ? sha256(salt + ':' + ip).slice(0, 24) : '';
  }

  function noteIpFailure(ip, empKey) {
    const key = ipBucket(ip);
    if (!key) return;
    const t = now();
    let entry = ipTable.get(key);
    if (!entry || t - entry.start > IP_WINDOW_MS) entry = { start: t, emps: new Set() };
    entry.emps.add(sha256(salt + ':emp:' + empKey).slice(0, 16));
    ipTable.set(key, entry);
    if (ipTable.size > IP_TABLE_MAX) ipTable.delete(ipTable.keys().next().value);
  }

  function ipSuspicious(ip) {
    const entry = ipTable.get(ipBucket(ip));
    if (!entry || now() - entry.start > IP_WINDOW_MS) return false;
    return entry.emps.size >= IP_SUSPICIOUS_DISTINCT_EMPS;
  }

  // Artificial delay before the password is checked. Never above the cap.
  function delayFor(state, signals) {
    const s = signals || {};
    let delay = backoffDelayMs(state && state.failed);
    if (!s.appCheckValid && (globalSurge() || ipSuspicious(s.ip))) delay = BACKOFF_CAP_MS;
    return Math.min(BACKOFF_CAP_MS, delay);
  }

  async function withFloor(floorMs, fn) {
    const started = now();
    let result, error, failed = false;
    try { result = await fn(); } catch (e) { error = e; failed = true; }
    const elapsed = now() - started;
    if (elapsed < floorMs) await sleep(floorMs - elapsed);
    if (failed) throw error;
    return result;
  }

  // Per-recipient + global auth-mail quota. Returns true only if the mail may
  // be queued. Recipient identity is stored only as a hash.
  async function reserveAuthMail(db, FV, email, kind) {
    if (!db || !email) return false;
    const t = now();
    const recipient = db.doc('auth_mail_quota/' + sha256(String(email).toLowerCase()));
    const budget = db.doc('auth_mail_budget/' + israelDay(t));
    return db.runTransaction(async (tx) => {
      const [r, b] = await Promise.all([tx.get(recipient), tx.get(budget)]);
      const rd = r.exists ? r.data() || {} : {};
      const sent = (Array.isArray(rd.sent_ms) ? rd.sent_ms : []).filter((x) => Number.isFinite(x) && t - x < 86400000);
      const lastHour = sent.filter((x) => t - x < 3600000).length;
      const used = Number((b.exists ? (b.data() || {}).count : 0) || 0);
      if (lastHour >= MAIL_PER_RECIPIENT_HOUR || sent.length >= MAIL_PER_RECIPIENT_DAY) {
        log('auth_mail_quota_recipient', { kind });
        return false;
      }
      if (used >= AUTH_MAIL_DAILY_BUDGET) {
        log('auth_mail_quota_global', { kind });
        return false;
      }
      tx.set(recipient, { sent_ms: sent.concat([t]).slice(-MAIL_PER_RECIPIENT_DAY),
        expires_at: new Date(t + 2 * 86400000) }, { merge: true });
      tx.set(budget, { count: used + 1, expires_at: new Date(t + 3 * 86400000),
        updated_at: FV ? FV.serverTimestamp() : new Date(t) }, { merge: true });
      return true;
    });
  }

  return Object.freeze({
    delayFor, withFloor, reserveAuthMail, noteGlobalFailure, noteIpFailure,
    globalSurge, ipSuspicious,
    _debug: () => ({ globalFailures, ipEntries: ipTable.size })
  });
}

module.exports = {
  BACKOFF_FREE_FAILURES, BACKOFF_BASE_MS, BACKOFF_CAP_MS, WARN_AFTER_FAILURES,
  WARN_PUSH_COOLDOWN_MS, LOGIN_FLOOR_MS, RESET_FLOOR_MS, UNLOCK_FLOOR_MS,
  GLOBAL_SURGE_FAILURES, IP_SUSPICIOUS_DISTINCT_EMPS, MAIL_PER_RECIPIENT_HOUR,
  MAIL_PER_RECIPIENT_DAY, AUTH_MAIL_DAILY_BUDGET,
  backoffDelayMs, classifySignInFailure, employeeKey, clientIpSignal, sha256,
  israelDay, createAuthHardening
};
