'use strict';

// Shared RUNTIME App Check gate (security review).
// Deploy: protected callables keep enforceAppCheck:false; this gate decides
// at runtime from client-closed config/app_check_gate (rules: false).
//   monitor (default) — never rejects; classifies every request
//   enforce — rejects anything that is not a valid, unconsumed token
//
// GAP2 COST: ZERO Firestore writes on the per-login / per-reset hot path.
// Classification always goes to structured logs. Daily counters are buffered
// in-memory and flushed to app_check_gate_stats/{yyyy-mm-dd} at most once
// per FLUSH_INTERVAL_MS (hourly). Mode-doc create on first read is one-time.
//
// Exit criterion (setAppCheckGateMode): >=14 full days with >=99.5% valid.
// Super-only fresh-admin callable; rollback to monitor always allowed.
// H2 stays OPEN until OWNER console — App Check alone does not close H2.

const GATE_DOC = 'config/app_check_gate';
const STATS_COLLECTION = 'app_check_gate_stats';
const MODES = Object.freeze(['monitor', 'enforce']);
const CATEGORIES = Object.freeze(['valid', 'consumed', 'invalid', 'missing']);
const EXIT_MIN_DAYS = 14;
const EXIT_MIN_VALID_RATIO = 0.995;
const MONITOR_STALE_DAYS = 21;
const MODE_CACHE_MS = 30 * 1000;
const FLUSH_INTERVAL_MS = 60 * 60 * 1000;
const NAME_RE = /^[A-Za-z][A-Za-z0-9]{2,60}$/;

function appCheckHeaderPresent(req) {
  const raw = req && req.rawRequest;
  if (!raw) return false;
  if (typeof raw.get === 'function') {
    try { if (raw.get('X-Firebase-AppCheck')) return true; } catch (ignore) {}
  }
  const headers = raw.headers || {};
  return !!(headers['x-firebase-appcheck'] || headers['X-Firebase-AppCheck']);
}

function classify(req) {
  const app = req && req.app;
  if (app && typeof app === 'object' && (app.appId || app.token)) {
    return app.alreadyConsumed === true ? 'consumed' : 'valid';
  }
  return appCheckHeaderPresent(req) ? 'invalid' : 'missing';
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function evaluateExit(days, nowMs, monitorSinceMs) {
  const list = Array.isArray(days) ? days : [];
  let valid = 0, total = 0;
  const perCategory = { valid: 0, consumed: 0, invalid: 0, missing: 0 };
  for (const day of list) {
    for (const cat of CATEGORIES) {
      const n = Number((day && day[cat]) || 0);
      if (Number.isFinite(n) && n > 0) {
        perCategory[cat] += n;
        total += n;
        if (cat === 'valid') valid += n;
      }
    }
  }
  const since = Number(monitorSinceMs) || 0;
  const monitoredDays = since > 0 ? Math.floor((nowMs - since) / 86400000) : 0;
  const ratio = total > 0 ? valid / total : 0;
  return Object.freeze({
    monitoredDays, total, valid, ratio, perCategory,
    ready: monitoredDays >= EXIT_MIN_DAYS && total > 0 && ratio >= EXIT_MIN_VALID_RATIO,
    monitorStale: since > 0 && monitoredDays >= MONITOR_STALE_DAYS
  });
}

function createAppCheckGate(deps) {
  const d = deps || {};
  if (!d.db || !d.HttpsError) throw new TypeError('app check gate dependencies are required');
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const log = typeof d.log === 'function' ? d.log : () => {};
  const increment = d.FV && typeof d.FV.increment === 'function' ? (n) => d.FV.increment(n) : null;
  let cached = null, cachedAt = 0;
  let buf = { day: '', totals: Object.create(null), byFn: Object.create(null), lastFlushMs: 0 };
  let flushChain = Promise.resolve();

  async function readState() {
    const t = now();
    if (cached && t - cachedAt < MODE_CACHE_MS) return cached;
    let mode = 'monitor', since = 0;
    try {
      const ref = d.db.doc(GATE_DOC);
      const snap = await ref.get();
      const data = snap && snap.exists ? (snap.data() || {}) : {};
      if (MODES.includes(data.mode)) mode = data.mode;
      since = Number(data.monitor_since_ms) || 0;
      if (!snap || !snap.exists) {
        since = t;
        try { await ref.create({ mode: 'monitor', monitor_since_ms: t, created_by: 'server' }); }
        catch (ignore) {}
      }
    } catch (e) {
      log('app_check_gate_config_unreadable', { reason: 'read-failed' });
    }
    cached = Object.freeze({ mode, monitorSinceMs: since });
    cachedAt = t;
    return cached;
  }

  function buffer(name, category) {
    const day = dayKey(now());
    if (buf.day && buf.day !== day) {
      scheduleFlush(true);
      buf = { day, totals: Object.create(null), byFn: Object.create(null), lastFlushMs: buf.lastFlushMs };
    }
    if (!buf.day) buf.day = day;
    buf.totals[category] = (buf.totals[category] || 0) + 1;
    if (!buf.byFn[name]) buf.byFn[name] = Object.create(null);
    buf.byFn[name][category] = (buf.byFn[name][category] || 0) + 1;
  }

  async function flushNow(force) {
    if (!increment) return;
    const t = now();
    // First observation opens the flush window without writing (GAP2: no
    // per-attempt Firestore write). Subsequent flushes are hourly-bounded.
    if (!force && !buf.lastFlushMs) { buf.lastFlushMs = t; return; }
    if (!force && (t - buf.lastFlushMs) < FLUSH_INTERVAL_MS) return;
    const day = buf.day;
    const totals = buf.totals;
    const byFn = buf.byFn;
    if (!day || Object.keys(totals).length === 0) return;
    buf.totals = Object.create(null);
    buf.byFn = Object.create(null);
    buf.lastFlushMs = t;
    const payload = {};
    for (const cat of Object.keys(totals)) payload[cat] = increment(totals[cat]);
    for (const fn of Object.keys(byFn)) {
      for (const cat of Object.keys(byFn[fn])) {
        payload['by_fn.' + fn + '.' + cat] = increment(byFn[fn][cat]);
      }
    }
    try {
      await d.db.doc(STATS_COLLECTION + '/' + day).set(payload, { merge: true });
      log('app_check_gate_stats_flushed', { day, keys: Object.keys(payload).length });
    } catch (ignore) {}
  }

  function scheduleFlush(force) {
    flushChain = flushChain.then(() => flushNow(!!force)).catch(() => {});
    return flushChain;
  }

  async function check(req, name) {
    if (!NAME_RE.test(String(name || ''))) throw new TypeError('gate name required');
    const category = classify(req);
    const state = await readState();
    log('app_check_gate', {
      fn: name, category, mode: state.mode, header: appCheckHeaderPresent(req)
    });
    buffer(name, category);
    scheduleFlush(false);
    if (state.mode === 'enforce' && category !== 'valid') {
      throw new d.HttpsError('failed-precondition',
        'לא ניתן לאמת את האפליקציה. רענן את הדף ונסה שוב.');
    }
    return Object.freeze({ category, mode: state.mode, valid: category === 'valid' });
  }

  function gated(name, handler) {
    if (!NAME_RE.test(String(name || '')) || typeof handler !== 'function') {
      throw new TypeError('gated(name, handler) requires a callable name and handler');
    }
    return async function gatedHandler(req) {
      const verdict = await check(req, name);
      return handler(req, verdict);
    };
  }

  async function status() {
    await scheduleFlush(true);
    const state = await readState();
    const t = now();
    const days = [];
    try {
      for (let i = 0; i < EXIT_MIN_DAYS + 7; i += 1) {
        const snap = await d.db.doc(STATS_COLLECTION + '/' + dayKey(t - i * 86400000)).get();
        if (snap && snap.exists) days.push(snap.data() || {});
      }
    } catch (ignore) {}
    return Object.freeze({ mode: state.mode, exit: evaluateExit(days, t, state.monitorSinceMs) });
  }

  function createSetModeHandler(h) {
    return async function setAppCheckGateMode(req) {
      const actor = await h.requireFreshSuper(req);
      const data = (req && req.data) || {};
      const mode = String(data.mode || '');
      if (!MODES.includes(mode)) throw new d.HttpsError('invalid-argument', 'מצב לא מוכר.');
      const current = await status();
      if (mode === 'enforce' && !current.exit.ready) {
        throw new d.HttpsError('failed-precondition',
          'תנאי היציאה ממצב ניטור לא התקיימו: נדרשים 14 ימים ולפחות 99.5% בקשות תקינות.');
      }
      const ref = await h.audit(actor, 'app_check_gate_mode', {
        from: current.mode, to: mode, ratio: current.exit.ratio, days: current.exit.monitoredDays
      });
      const t = now();
      const state = await readState();
      const since = mode === 'monitor'
        ? (current.mode === 'monitor' && state.monitorSinceMs ? state.monitorSinceMs : t)
        : state.monitorSinceMs;
      await d.db.doc(GATE_DOC).set({
        mode, monitor_since_ms: since || t, changed_by: actor.uid, changed_at_ms: t
      }, { merge: true });
      cached = null;
      if (h.seal) await h.seal(ref);
      return { ok: true, mode };
    };
  }

  return Object.freeze({
    check, gated, status, readState, createSetModeHandler,
    _flush: () => scheduleFlush(true),
    _resetCache: () => { cached = null; },
    _bufferSnapshot: () => ({ day: buf.day, totals: Object.assign({}, buf.totals) })
  });
}

module.exports = {
  GATE_DOC, STATS_COLLECTION, MODES, CATEGORIES, EXIT_MIN_DAYS, EXIT_MIN_VALID_RATIO,
  MONITOR_STALE_DAYS, FLUSH_INTERVAL_MS,
  appCheckHeaderPresent, classify, evaluateExit, createAppCheckGate
};
