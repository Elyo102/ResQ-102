'use strict';

const scope = require('./health-scope');

const PAGE_SIZE = 200;
const MAX_STATIONS = 200;
const MAX_EMP_INDEX = 5000;
const LEASE_MS = 90_000;
const RETENTION_MS = 31 * 86400000;
const SCREEN_READ_WARN = 3000;
const DOC_WARN_BYTES = 700000;
const WHOLE_READ_COLS = Object.freeze(['faults', 'guards', 'swaps']);

function finding(level, code, title, detail) {
  return Object.freeze({ level, code, title: String(title).slice(0, 200), detail: String(detail || '').slice(0, 2000) });
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function activeStation(doc, knownDistricts) {
  const value = doc.data() || {};
  return value.active === true && knownDistricts.includes(String(value.districtId || ''));
}

function createFirestoreHealthPorts(deps) {
  const value = deps || {};
  const { db, FieldValue, FieldPath, clock, randomId, builtins, knownDistricts, activeIndex } = value;
  if (!db || typeof db.doc !== 'function' || typeof db.runTransaction !== 'function'
      || !FieldValue || typeof FieldValue.serverTimestamp !== 'function'
      || !FieldPath || typeof FieldPath.documentId !== 'function'
      || typeof clock !== 'function' || typeof randomId !== 'function'
      || !builtins || !Array.isArray(knownDistricts) || typeof activeIndex !== 'function') {
    throw new TypeError('system health Firestore dependencies required');
  }

  function actualCycleRef(cycleId) { return db.doc('system_health_cycles/' + cycleId); }
  function assertLease(row, token) {
    if (String(row.lease_token || '') !== String(token || '') || Number(row.lease_until_ms || 0) <= clock()) {
      const error = new Error('health-cycle-lease-lost'); error.code = 'lease-lost'; throw error;
    }
  }

  async function listStations({ deadline_ms: deadlineMs }) {
    const byId = new Map();
    let complete = true;
    const builtinIds = Object.keys(builtins);
    const [page, ...builtinSnaps] = await Promise.all([
      db.collection('stations').where('active', '==', true).limit(MAX_STATIONS + 1).get(),
      ...builtinIds.map((id) => db.doc('stations/' + id).get())
    ]);
    builtinIds.forEach((id, at) => {
      const snap = builtinSnaps[at];
      const row = snap.exists ? (snap.data() || {}) : builtins[id];
      if (!row || row.active !== true) return;
      if (!scope.STATION_ID_RE.test(id) || !knownDistricts.includes(String(row.districtId || ''))) complete = false;
      else byId.set(id, row);
    });
    if (page.size > MAX_STATIONS) complete = false;
    for (const doc of page.docs || []) {
      const id = String(doc.id || '');
      if (!scope.STATION_ID_RE.test(id) || !activeStation(doc, knownDistricts)) complete = false;
      else byId.set(id, doc.data() || {});
    }
    if (clock() >= deadlineMs - 5000 || byId.size > MAX_STATIONS) complete = false;
    const ids = [...byId.keys()].sort();
    if (!complete) return { complete: false, stations: [] };
    return { complete: true, stations: ids.map((id) => ({ station_id: id, silent: false })) };
  }

  async function readGlobalSilent() {
    const snap = await db.doc('config/runtime').get();
    return snap.exists && (snap.data() || {}).silent === true;
  }

  async function readStationSilent({ station_id: stationId }) {
    if (!scope.STATION_ID_RE.test(String(stationId || ''))) throw new TypeError('invalid station_id');
    const snap = await db.doc('stations/' + stationId + '/config/mode').get();
    const row = snap.exists ? (snap.data() || {}) : {};
    return row.mode === 'silent' || row.silent === true;
  }

  async function claimCycle({ cycle }) {
    const ref = actualCycleRef(cycle.cycle_id);
    const token = randomId();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const row = snap.exists ? (snap.data() || {}) : {};
      if (row.status === 'complete' && row.summary) {
        return { acquired: false, completed: true, summary: row.summary, published: row.published === true };
      }
      if (snap.exists && (row.inventory_fingerprint !== cycle.inventory_fingerprint
          || JSON.stringify(row.inventory || []) !== JSON.stringify(cycle.inventory))) {
        throw new Error('health-cycle-inventory-mismatch');
      }
      if (Number(row.lease_until_ms || 0) > clock() && row.lease_token) return { acquired: false };
      tx.set(ref, {
        schema_version: 2,
        cycle_id: cycle.cycle_id,
        inventory: cycle.inventory,
        inventory_fingerprint: cycle.inventory_fingerprint,
        total: cycle.total,
        status: row.status || 'running',
        cursor: row.cursor || null,
        global_complete: row.global_complete === true,
        lease_token: token,
        lease_until_ms: clock() + LEASE_MS,
        expires_at: new Date(clock() + RETENTION_MS),
        updated_at: FieldValue.serverTimestamp(),
        created_at: row.created_at || FieldValue.serverTimestamp()
      }, { merge: true });
      return { acquired: true, cursor: row.cursor || null, global_complete: row.global_complete === true,
        global_findings: Array.isArray(row.global_findings) ? row.global_findings : [],
        lease_token: token };
    });
  }

  async function saveGlobal({ cycle_id: cycleId, lease_token: token, findings }) {
    const ref = actualCycleRef(cycleId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref); const row = snap.exists ? (snap.data() || {}) : {};
      assertLease(row, token);
      tx.set(ref, { global_complete: true, global_findings: findings,
        lease_until_ms: clock() + LEASE_MS, updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  async function saveReport({ cycle_id: cycleId, lease_token: token, report }) {
    const parent = actualCycleRef(cycleId);
    const ref = parent.collection('system_health_reports').doc(report.station_id);
    await db.runTransaction(async (tx) => {
      const [parentSnap, existing] = await Promise.all([tx.get(parent), tx.get(ref)]);
      const row = parentSnap.exists ? (parentSnap.data() || {}) : {};
      assertLease(row, token);
      if (!existing.exists || (existing.data() || {}).ok !== true) {
        tx.set(ref, { ...report, recorded_at: FieldValue.serverTimestamp(),
          expires_at: new Date(clock() + RETENTION_MS) });
      }
      tx.set(parent, { lease_until_ms: clock() + LEASE_MS, updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  async function checkpoint({ cycle_id: cycleId, lease_token: token, cursor }) {
    const ref = actualCycleRef(cycleId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref); const row = snap.exists ? (snap.data() || {}) : {};
      assertLease(row, token);
      tx.set(ref, { cursor, lease_until_ms: clock() + LEASE_MS,
        updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  async function readReports({ cycle_id: cycleId }) {
    const snap = await actualCycleRef(cycleId).collection('system_health_reports').get();
    return (snap.docs || []).map((doc) => doc.data() || {});
  }

  async function finishCycle({ cycle, lease_token: token, summary }) {
    const ref = actualCycleRef(cycle.cycle_id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref); const row = snap.exists ? (snap.data() || {}) : {};
      assertLease(row, token);
      const complete = summary.verdict === scope.VERDICT.ALL_CLEAR || summary.verdict === scope.VERDICT.FINDINGS;
      tx.set(ref, { status: complete ? 'complete' : summary.verdict,
        summary: { verdict: summary.verdict, findings: summary.findings,
          reported: summary.reported, total: summary.total,
          missing: (summary.missing || []).slice(0, MAX_STATIONS),
          rejected: (summary.rejected || []).slice(0, 50) },
        completed_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  async function publishComplete({ cycle, lease_token: token, summary, reports }) {
    if (cycle.total > MAX_STATIONS) throw new Error('health-cycle-too-large-to-publish');
    const ref = actualCycleRef(cycle.cycle_id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref); const row = snap.exists ? (snap.data() || {}) : {};
      assertLease(row, token);
      if (row.published === true) return;
      const activeQuery = db.collection('stations').where('active', '==', true).limit(MAX_STATIONS + 1);
      const activeSnap = await tx.get(activeQuery);
      const byId = new Map();
      let validInventory = activeSnap.size <= MAX_STATIONS;
      const builtinIds = Object.keys(builtins);
      const builtinSnaps = await Promise.all(builtinIds.map((id) => tx.get(db.doc('stations/' + id))));
      builtinIds.forEach((id, at) => {
        const snapForBuiltin = builtinSnaps[at];
        const builtin = snapForBuiltin.exists ? (snapForBuiltin.data() || {}) : builtins[id];
        if (!builtin || builtin.active !== true) return;
        if (!scope.STATION_ID_RE.test(id) || !knownDistricts.includes(String(builtin.districtId || ''))) validInventory = false;
        else byId.set(id, builtin);
      });
      for (const doc of activeSnap.docs || []) {
        const id = String(doc.id || '');
        if (!scope.STATION_ID_RE.test(id) || !activeStation(doc, knownDistricts)) validInventory = false;
        else byId.set(id, doc.data() || {});
      }
      const currentInventory = [...byId.keys()].sort();
      if (!validInventory || currentInventory.length > MAX_STATIONS
          || !scope.sameInventory(cycle.inventory, currentInventory)) {
        const error = new Error('health-cycle-inventory-drift');
        error.code = 'inventory-drift';
        throw error;
      }
      const globals = Array.isArray(row.global_findings) ? row.global_findings : [];
      const today = dateKey(new Date(clock()));
      reports.forEach((report) => {
        if (!report || report.ok !== true || !scope.STATION_ID_RE.test(String(report.station_id || ''))) return;
        const findings = globals.concat(report.findings || []).slice(0, 200);
        tx.set(db.doc('stations/' + report.station_id + '/health_shadow/' + today), {
          schema_version: 2, shadow: true, cycle_id: cycle.cycle_id, date: today,
          findings, stop: findings.filter((item) => item.level === 'stop').length,
          warn: findings.filter((item) => item.level === 'warn').length,
          silent: report.silent === true, silence_reason: report.silence_reason || null,
          ran_at: FieldValue.serverTimestamp(), expires_at: new Date(clock() + RETENTION_MS)
        });
      });
      tx.set(ref, { published: true, published_at: FieldValue.serverTimestamp(),
        summary_verdict: summary.verdict }, { merge: true });
    });
  }

  async function releaseCycle({ cycle_id: cycleId, lease_token: token }) {
    const ref = actualCycleRef(cycleId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref); if (!snap.exists) return;
      const row = snap.data() || {}; if (row.lease_token !== token) return;
      tx.set(ref, { lease_token: null, lease_until_ms: 0, updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  async function scanStation({ station, deadline_ms: deadlineMs }) {
    const now = new Date(clock());
    const sid = station.station_id;
    const found = [];
    async function check(name, fn) {
      if (clock() >= deadlineMs) throw Object.assign(new Error('station-scan-deadline'), { code: 'deadline' });
      try { await fn(); } catch (error) {
        found.push(finding('warn', 'SCHEDULED_TASK_SILENT', 'בדיקה נכשלה · ' + name,
          String(error && error.code || error && error.message || 'scan-failed').slice(0, 120)));
      }
    }
    let latestBackup = null;
    await check('גודל אוספים', async () => {
      const snap = await db.collection('stations/' + sid + '/backups').orderBy('date', 'desc').limit(1).get();
      if (snap.empty) {
        found.push(finding('warn', 'SCHEDULED_TASK_SILENT', 'אין תצלום אוספים', 'התצלום הלילי עדיין לא כתב רשומה.'));
        return;
      }
      latestBackup = snap.docs[0].data() || {};
      if (Array.isArray(latestBackup.drops) && latestBackup.drops.length) {
        found.push(finding('stop', 'SNAPSHOT_DATA_LOSS', 'ירידה חדה בנתוני התצלום', 'נדרשת בדיקת שלמות נתונים ידנית.'));
      }
      const counts = latestBackup.counts || {};
      WHOLE_READ_COLS.forEach((name) => {
        const count = counts[name];
        if (typeof count === 'number' && count >= SCREEN_READ_WARN) {
          found.push(finding('warn', 'COLLECTION_GROWTH_WARNING', 'אוסף ' + name + ' הגיע ל-' + count + ' מסמכים',
            'מסך אחד קורא אוסף גדול ללא סינון מספק.'));
        }
      });
    });
    await check('גודל מסמכים', async () => {
      for (const collectionName of ['hr_reports', 'scans']) {
        const snap = await db.collection('stations/' + sid + '/' + collectionName)
          .orderBy(FieldPath.documentId(), 'desc').limit(3).get();
        (snap.docs || []).forEach((doc) => {
          let bytes = 0;
          try { bytes = Buffer.byteLength(JSON.stringify(doc.data() || {}), 'utf8'); } catch (_) { return; }
          if (bytes >= DOC_WARN_BYTES) found.push(finding('warn', 'DOCUMENT_SIZE_WARNING',
            collectionName + '/' + doc.id + ' מתקרב למגבלת הגודל', Math.round(bytes / 1024) + 'KB'));
        });
      }
    });
    await check('משימות מתוזמנות', async () => {
      const twoDays = new Date(now.getTime() - 2 * 86400000);
      const scan = await db.doc('stations/' + sid + '/scans/' + monthKey(now)).get();
      const ranAt = scan.exists ? (scan.data() || {}).ran_at : null;
      if (!ranAt || typeof ranAt.toDate !== 'function' || ranAt.toDate() < twoDays) {
        found.push(finding('warn', 'SCHEDULED_TASK_SILENT', 'nightlyScan לא רץ ביומיים האחרונים', 'סריקת חריגות השעות אינה עדכנית.'));
      }
      const last = latestBackup && String(latestBackup.date || '');
      if (!last || last < dateKey(twoDays)) {
        found.push(finding('warn', 'SCHEDULED_TASK_SILENT', 'nightlySnapshot אינו עדכני', 'התצלום היומי אינו עדכני.'));
      }
    });
    return found;
  }

  async function renewLease(cycleId, token) {
    const ref = actualCycleRef(cycleId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref); const row = snap.exists ? (snap.data() || {}) : {};
      assertLease(row, token);
      tx.set(ref, { lease_until_ms: clock() + LEASE_MS,
        updated_at: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  async function scanGlobal({ cycle_id: cycleId, lease_token: token, deadline_ms: deadlineMs }) {
    const now = new Date(clock());
    const found = [];
    const runtime = await db.doc('config/runtime').get();
    if (runtime.exists && (runtime.data() || {}).silent === true) {
      found.push(finding('stop', 'RUNTIME_SILENT_MODE', 'המערכת עדיין במצב ניסוי', 'השתקה ארגונית פעילה.'));
    }
    const mail = await db.collection('mail_failures').where('at', '>=', new Date(now.getTime() - 86400000)).limit(50).get();
    if (!mail.empty) found.push(finding('warn', 'MAIL_DELIVERY_FAILURES', mail.size + ' מיילים נכשלו ביממה האחרונה',
      'הפרטים האישיים נשארו ברשומת המקור ואינם מועתקים לדוח התחנות.'));

    let cursor = null;
    let scanned = 0;
    const orphans = [];
    let exhausted = false;
    while (scanned < MAX_EMP_INDEX) {
      if (clock() >= deadlineMs - 10_000) {
        throw Object.assign(new Error('emp-index-scan-deadline'), { code: 'deadline' });
      }
      let query = db.collection('emp_index').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
      if (cursor !== null) query = query.startAfter(cursor);
      const page = await query.get();
      const active = (page.docs || []).filter((doc) => activeIndex(doc.data() || {}));
      for (let at = 0; at < active.length; at += 100) {
        const slice = active.slice(at, at + 100);
        const checks = slice.map((doc) => {
          const row = doc.data() || {};
          const stationId = String(row.stationId || '');
          const uid = String(row.uid || '');
          if (!scope.STATION_ID_RE.test(stationId) || !/^[^/]{1,128}$/.test(uid)) {
            orphans.push(doc.id);
            return null;
          }
          return { doc, ref: db.doc('stations/' + stationId + '/users/' + uid) };
        });
        const validChecks = checks.filter(Boolean);
        const refs = validChecks.map((item) => item.ref);
        const users = typeof db.getAll === 'function' ? await db.getAll(...refs) : await Promise.all(refs.map((ref) => ref.get()));
        users.forEach((user, index) => { if (!user.exists) orphans.push(validChecks[index].doc.id); });
      }
      scanned += page.size;
      await renewLease(cycleId, token);
      if (page.size < PAGE_SIZE) { exhausted = true; break; }
      cursor = page.docs[page.docs.length - 1].id;
    }
    if (!exhausted && scanned >= MAX_EMP_INDEX) {
      const extra = await db.collection('emp_index').orderBy(FieldPath.documentId()).startAfter(cursor).limit(1).get();
      if (!extra.empty) throw Object.assign(new Error('emp-index-scan-cap'), { code: 'resource-exhausted' });
    }
    if (orphans.length) found.push(finding('warn', 'ORPHAN_EMPLOYEE_INDEX', orphans.length + ' מספרי עובד מצביעים על משתמש חסר',
      'הדוח אינו כולל שמות, כתובות או מספרי עובד.'));
    return found;
  }

  return Object.freeze({ listStations, readGlobalSilent, readStationSilent, claimCycle, saveGlobal, scanGlobal,
    scanStation, saveReport, checkpoint, readReports, finishCycle, publishComplete, releaseCycle });
}

module.exports = Object.freeze({
  createFirestoreHealthPorts, PAGE_SIZE, MAX_STATIONS, MAX_EMP_INDEX, LEASE_MS,
  SCREEN_READ_WARN, DOC_WARN_BYTES, WHOLE_READ_COLS, RETENTION_MS, finding, monthKey, dateKey, activeStation
});
