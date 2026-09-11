'use strict';

const access = require('./schedule-access');
const diagnosisCore = require('./maintenance-diagnosis');
const { DAY_CAP } = require('./incident-log');

const MODES = Object.freeze(['OFF', 'OBSERVE']);
const MODE_FIELDS = Object.freeze(['mode', 'expected_revision']);
const MAX_ITEMS = 200;
const ANALYSIS_COOLDOWN_MS = 60 * 1000;
const HEALTH_STALE_MS = 36 * 60 * 60 * 1000;
const OPERATIONAL_STATES = Object.freeze(['LIVE', 'SILENT', 'UNKNOWN']);
const HEALTH_STATES = Object.freeze(['HEALTHY', 'DEGRADED', 'CRITICAL', 'UNKNOWN']);
const PLATFORM_STATES = Object.freeze(['AVAILABLE', 'STALE', 'MISSING']);
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const CONFIG_PATH = (sid) => 'stations/' + sid + '/maintenance/config';

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value, allowed) {
  return plain(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}
function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}
function titleCode(code) {
  const map = {
    CLIENT_AUTH_DENIED:'הרשאה נדחתה', CALLABLE_UNAVAILABLE:'שירות אינו זמין',
    CALLABLE_DEADLINE:'שירות חרג מזמן התגובה', RESOURCE_EXHAUSTED:'לחץ על מכסת שירות',
    DATA_LOSS:'חשד לפגיעה בשלמות נתונים', CLIENT_RUNTIME_ERROR:'שגיאת מסך',
    UNHANDLED_REJECTION:'פעולת מסך נכשלה ללא טיפול',
    MAIL_DELIVERY_FAILURES:'כשלי מסירת דואר', SCHEDULED_TASK_SILENT:'משימה מתוזמנת שתקה',
    RUNTIME_SILENT_MODE:'המערכת במצב ניסוי', SNAPSHOT_DATA_LOSS:'ירידה חדה בנתוני התצלום',
    ORPHAN_EMPLOYEE_INDEX:'מפתח עובד יתום', DOCUMENT_SIZE_WARNING:'מסמך מתקרב למגבלת גודל',
    COLLECTION_GROWTH_WARNING:'אוסף גדל ודורש סינון', HEALTH_CHECK_STALE:'בדיקת הבריאות לא עדכנית',
    BACKUP_QUARANTINED:'גיבוי נמצא בהסגר'
  };
  return map[code] || 'אירוע טכני';
}
function incidentSignal(row, nowMs = Date.now()) {
  const code = String(row && row.code || '');
  const kind = String(row && row.kind || '');
  let mapped = '';
  if (code === 'functions/permission-denied' || code === 'functions/unauthenticated') mapped = 'CLIENT_AUTH_DENIED';
  else if (code === 'functions/unavailable' || code === 'functions/internal') mapped = 'CALLABLE_UNAVAILABLE';
  else if (code === 'functions/deadline-exceeded') mapped = 'CALLABLE_DEADLINE';
  else if (code === 'functions/resource-exhausted') mapped = 'RESOURCE_EXHAUSTED';
  else if (code === 'functions/data-loss') mapped = 'DATA_LOSS';
  else if (kind === 'unhandled-rejection') mapped = 'UNHANDLED_REJECTION';
  else if (kind === 'client-error' || code === 'Error' || code === 'TypeError'
      || code === 'ReferenceError' || code === 'SyntaxError' || code === 'RangeError') mapped = 'CLIENT_RUNTIME_ERROR';
  else if (kind === 'callable-failed') mapped = 'CALLABLE_UNAVAILABLE';
  if (!mapped) return null;
  const last = iso(row.last_seen_iso);
  return {
    source:'incident', code:mapped, count:safeCount(row.count),
    age_minutes:last ? Math.min(525600, Math.max(0, Math.floor((nowMs - Date.parse(last)) / 60000))) : 525600
  };
}
function healthCode(title) {
  const value = String(title || '');
  if (/מיילים נכשלו/.test(value)) return 'MAIL_DELIVERY_FAILURES';
  if (/nightly|משימה|תצלום אוספים/.test(value)) return 'SCHEDULED_TASK_SILENT';
  if (/מספרי עובד/.test(value)) return 'ORPHAN_EMPLOYEE_INDEX';
  if (/שוקל \d+KB/.test(value)) return 'DOCUMENT_SIZE_WARNING';
  if (/אוסף .* מסמכים/.test(value)) return 'COLLECTION_GROWTH_WARNING';
  if (/גיבוי.*הסגר/.test(value)) return 'BACKUP_QUARANTINED';
  return null;
}
function timestampIso(value) {
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return iso(value);
}
function healthSignals(doc, nowMs) {
  const data = doc && typeof doc.data === 'function' ? (doc.data() || {}) : {};
  const ranAt = timestampIso(data.ran_at);
  const age = ranAt
    ? Math.min(525600, Math.max(0, Math.floor((nowMs - Date.parse(ranAt)) / 60000)))
    : 525600;
  const rows = Array.isArray(data.findings) ? data.findings : [];
  const signals = rows.map((finding) => {
    const code = plain(finding) && diagnosisCore.HEALTH_CODES.includes(finding.code)
      ? finding.code : (plain(finding) ? healthCode(finding.title) : null);
    // Runtime silence is an intentional operating mode, not a technical
    // incident. Historical snapshots may still contain the old finding, but
    // the dashboard must never count it as a fault.
    return code && code !== 'RUNTIME_SILENT_MODE'
      ? { source:'health', code, count:1, age_minutes:age } : null;
  }).filter(Boolean);
  if (!ranAt || nowMs - Date.parse(ranAt) > HEALTH_STALE_MS) {
    signals.push({ source:'health', code:'HEALTH_CHECK_STALE', count:1, age_minutes:age });
  }
  return signals;
}

function createMaintenanceService(deps) {
  const { db, auth, HttpsError, incidentLog, clock, serverTimestamp } = deps || {};
  if (!db || typeof db.doc !== 'function' || !auth || typeof auth.getUser !== 'function'
      || typeof db.runTransaction !== 'function' || typeof HttpsError !== 'function'
      || !incidentLog || typeof incidentLog.list !== 'function'
      || typeof clock !== 'function' || typeof serverTimestamp !== 'function') {
    throw new TypeError('maintenance service dependencies required');
  }
  async function requireSuper(req) {
    const signed = req && req.auth;
    if (!signed || !access.validUid(signed.uid)) throw new HttpsError('unauthenticated', 'צריך להיות מחובר.');
    const sid = signed.token && signed.token.stationId;
    if (signed.token.super !== true || !access.validId(sid)) throw new HttpsError('permission-denied', 'מרכז התחזוקה זמין למנהל־העל בלבד.');
    const live = await auth.getUser(signed.uid);
    const claims = live && live.customClaims || {};
    if (claims.super !== true || claims.stationId !== sid || live.disabled === true) throw new HttpsError('permission-denied', 'הרשאת מנהל־העל השתנתה.');
    return Object.freeze({ uid:signed.uid, sid });
  }
  async function config(sid) {
    const snap = await db.doc(CONFIG_PATH(sid)).get();
    const row = snap.exists ? (snap.data() || {}) : {};
    return { mode:MODES.includes(row.mode) ? row.mode : 'OFF',
      revision:Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0,
      last_analysis_ms:Number.isSafeInteger(row.last_analysis_ms) && row.last_analysis_ms >= 0 ? row.last_analysis_ms : null };
  }
  async function load(ctx) {
    const now = new Date(clock());
    if (!Number.isFinite(now.getTime())) throw new HttpsError('internal', 'שעון התחזוקה אינו תקין.');
    const [cfg, incidents, healthSnap, daySnap, runtimeSnap, heartbeatSnap] = await Promise.all([
      config(ctx.sid),
      incidentLog.list({ sid:ctx.sid, status:'open', limit:MAX_ITEMS }),
      db.collection('stations/' + ctx.sid + '/health').orderBy('date','desc').limit(1).get(),
      db.doc('stations/' + ctx.sid + '/incident_days/' + now.toISOString().slice(0,10)).get(),
      db.doc('config/runtime').get(),
      db.doc('system/heartbeat').get()
    ]);
    const latestHealth = healthSnap.empty ? null : healthSnap.docs[0];
    const health = latestHealth ? healthSignals(latestHealth, now.getTime()) : [{
      source:'health', code:'HEALTH_CHECK_STALE', count:1, age_minutes:525600
    }];
    const signals = incidents.map((row) => incidentSignal(row, now.getTime())).filter(Boolean).concat(health);
    const diagnosis = diagnosisCore.diagnoseMaintenance({ signals });
    const itemByCode = new Map();
    incidents.forEach((row) => {
      const signal = incidentSignal(row, now.getTime()); if (!signal) return;
      const rule = diagnosisCore.diagnoseMaintenance({ signals:[signal] });
      const old = itemByCode.get(signal.code);
      const next = {
        id:signal.code, severity:rule.severity, title_code:titleCode(signal.code),
        runbook_code:rule.runbook_codes[0], count:signal.count,
        screen:row.first_screen || 'unknown', version:row.last_version || 'unknown',
        ai_state:'deterministic'
      };
      if (old) next.count = Math.min(1_000_000, old.count + next.count);
      itemByCode.set(signal.code, next);
    });
    health.forEach((signal) => {
      const rule = diagnosisCore.diagnoseMaintenance({ signals:[signal] });
      const key = 'health:' + signal.code;
      const old = itemByCode.get(key);
      itemByCode.set(key, {
        id:key, severity:rule.severity, title_code:titleCode(signal.code),
        runbook_code:rule.runbook_codes[0], count:Math.min(1_000_000, (old ? old.count : 0) + signal.count), screen:'server',
        version:'42H.14', ai_state:'deterministic'
      });
    });
    const items = [...itemByCode.values()].sort((a,b) =>
      diagnosisCore.SEVERITIES.indexOf(a.severity)-diagnosisCore.SEVERITIES.indexOf(b.severity)
      || b.count-a.count).slice(0,MAX_ITEMS);
    const counts = { P0:0, P1:0, P2:0, P3:0, open:incidents.length, dropped:0 };
    items.forEach((row) => { counts[row.severity] += 1; });
    const day = daySnap.exists ? (daySnap.data() || {}) : {};
    counts.dropped = safeCount(day.count) >= DAY_CAP ? 1 : 0;
    const runtime = runtimeSnap.exists ? (runtimeSnap.data() || {}) : null;
    const operationalState = runtime === null ? 'UNKNOWN' : runtime.silent === true ? 'SILENT' : 'LIVE';
    const lastHealthAt = latestHealth ? timestampIso((latestHealth.data() || {}).ran_at) : null;
    const healthFreshness = lastHealthAt && now.getTime() - Date.parse(lastHealthAt) <= HEALTH_STALE_MS
      ? 'FRESH' : latestHealth ? 'STALE' : 'MISSING';
    const healthState = healthFreshness !== 'FRESH' ? 'UNKNOWN'
      : counts.P0 > 0 ? 'CRITICAL'
      : counts.P1 > 0 || counts.P2 > 0 ? 'DEGRADED' : 'HEALTHY';
    const heartbeatAt = heartbeatSnap.exists ? timestampIso((heartbeatSnap.data() || {}).at) : null;
    const platformState = !heartbeatAt ? 'MISSING'
      : now.getTime() - Date.parse(heartbeatAt) <= HEARTBEAT_STALE_MS ? 'AVAILABLE' : 'STALE';
    return {
      schema_version:1, station_id:ctx.sid, mode:cfg.mode, config_revision:cfg.revision, counts,
      operational_state:operationalState, health_state:healthState, health_freshness:healthFreshness,
      platform_state:platformState, last_heartbeat_at:heartbeatAt,
      open_count_scope:'open_within_newest_' + MAX_ITEMS + '_incidents', open_count_is_partial:true,
      last_health_at:lastHealthAt,
      analysis_kind:'deterministic', diagnosis_fingerprint:diagnosis.fingerprint, items
    };
  }
  async function getDashboard(req) {
    return load(await requireSuper(req));
  }
  async function setMode(req) {
    const ctx = await requireSuper(req);
    const data = req && req.data;
    if (!exactKeys(data, MODE_FIELDS) || Object.keys(data).length !== MODE_FIELDS.length
        || !MODES.includes(data.mode) || !Number.isSafeInteger(data.expected_revision) || data.expected_revision < 0) {
      throw new HttpsError('invalid-argument', 'מצב התחזוקה אינו תקין.');
    }
    await db.runTransaction(async (tx) => {
      const ref = db.doc(CONFIG_PATH(ctx.sid));
      const snap = await tx.get(ref); const row = snap.exists ? (snap.data() || {}) : {};
      const revision = Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : 0;
      if (revision !== data.expected_revision) throw new HttpsError('aborted', 'מצב התחזוקה השתנה. יש לרענן.');
      tx.set(ref, { mode:data.mode, revision:revision + 1, updated_at:serverTimestamp(),
        updated_by:ctx.uid, ai_enabled:false, production_mutations_enabled:false }, { merge:true });
    });
    return load(ctx);
  }
  async function runAnalysis(req) {
    const ctx = await requireSuper(req);
    const view = await load(ctx); const now = new Date(clock());
    await db.runTransaction(async (tx) => {
      const ref = db.doc(CONFIG_PATH(ctx.sid));
      const snap = await tx.get(ref); const row = snap.exists ? (snap.data() || {}) : {};
      if (row.mode !== 'OBSERVE') throw new HttpsError('failed-precondition', 'יש להעביר את המערכת למצב תצפית לפני אבחון.');
      const last = Number.isSafeInteger(row.last_analysis_ms) ? row.last_analysis_ms : null;
      if (last !== null && now.getTime() - last < ANALYSIS_COOLDOWN_MS) {
        throw new HttpsError('resource-exhausted', 'האבחון כבר הורץ בדקה האחרונה.');
      }
      tx.set(ref, { last_analysis_ms:now.getTime(), last_analysis_at:serverTimestamp(),
        last_analysis_by:ctx.uid }, { merge:true });
    });
    return Object.assign({}, view, { analyzed_at:now.toISOString() });
  }
  return Object.freeze({ getDashboard, setMode, runAnalysis, requireSuper, load });
}

module.exports = Object.freeze({
  createMaintenanceService, MODES, MAX_ITEMS, ANALYSIS_COOLDOWN_MS, HEALTH_STALE_MS,
  HEARTBEAT_STALE_MS, OPERATIONAL_STATES, HEALTH_STATES, PLATFORM_STATES,
  incidentSignal, healthCode, healthSignals, timestampIso, titleCode
});
