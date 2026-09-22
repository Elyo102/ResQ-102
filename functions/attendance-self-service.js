'use strict';

// Server-authoritative employee attendance writes. The browser supplies only
// editable facts and an optimistic version; identity, station, employee
// number, role, derived hours and timestamps are resolved inside one
// transaction. Durable receipts make retries exact without duplicating work.
const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity, MEMBER_ROLES } = require('./ops-member-identity');
const { monthKey } = require('./hr-hours-model');
const { EDITABLE, DERIVED, TARGET_ROLES, COLLECTIONS } = require('./attendance-corrections');

const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const RETAINED_DAY_FIELDS = Object.freeze([
  'uid', 'emp_number', 'full_name', 'crew', 'date', 'month', 'status',
  ...EDITABLE, ...DERIVED
]);

function createAttendanceSelfService({ db, auth, HttpsError, serverTimestamp,
  clock = Date.now, monthAt, readConfig, calculate }) {
  if (!db || typeof db.runTransaction !== 'function' || !auth || typeof auth.getUser !== 'function'
      || [HttpsError, serverTimestamp, clock, monthAt, readConfig, calculate].some(v => typeof v !== 'function')) {
    throw new TypeError('Attendance self-service requires trusted database, identity, time and calculation ports');
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const fail = (code, message) => { throw new HttpsError(code, message); };
  function shape(v, allowed, required = allowed) {
    if (!plain(v) || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !allowed.includes(k)
        || !own(Object.getOwnPropertyDescriptor(v, k), 'value')) || required.some(k => !own(v, k))) {
      fail('invalid-argument', 'Invalid closed attendance request');
    }
  }
  function date(v) {
    const parsed = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00Z') : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
      fail('invalid-argument', 'Invalid attendance date');
    }
    return v;
  }
  function version(v, absent) {
    if (absent && v === 'absent') return v;
    shape(v, ['seconds', 'nanoseconds']);
    if (!Number.isSafeInteger(v.seconds) || !Number.isInteger(v.nanoseconds)
        || v.nanoseconds < 0 || v.nanoseconds >= 1e9) fail('invalid-argument', 'Invalid attendance version');
    return { seconds: v.seconds, nanoseconds: v.nanoseconds };
  }
  function snapVersion(s) {
    if (!s.exists) return 'absent';
    if (!s.updateTime) fail('failed-precondition', 'Attendance version unavailable');
    return version({ seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds });
  }
  function editable(v) {
    shape(v, EDITABLE, ['day_type']);
    if (typeof v.day_type !== 'string' || !['regular', 'swap', 'extra', 'meeting', 'guard', 'vacation', 'sick', 'reserve'].includes(v.day_type)) {
      fail('invalid-argument', 'Invalid attendance day type');
    }
    const out = {};
    for (const key of EDITABLE) if (own(v, key)) {
      const value = v[key];
      if (['end_day', 'end_day2'].includes(key)) {
        if (!Number.isInteger(value) || ![0, 1, 2].includes(value)) fail('invalid-argument', 'Invalid attendance day offset');
      } else if (['start', 'end', 'start2', 'end2'].includes(key)) {
        if (typeof value !== 'string' || (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) fail('invalid-argument', 'Invalid attendance time');
      } else if (key === 'sub_station') {
        if (typeof value !== 'string' || (value && !access.validId(value))) fail('invalid-argument', 'Invalid attendance site');
      } else if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        fail('invalid-argument', 'Invalid attendance text');
      }
      out[key] = value;
    }
    return out;
  }
  function request(req) {
    const ctx = identity.context(req);
    shape(req.data, ['date', 'operation', 'expected_version', 'patch', 'request_id'],
      ['date', 'operation', 'expected_version', 'request_id']);
    const d = req.data, operation = d.operation;
    if (!['save', 'delete'].includes(operation) || (operation === 'delete' && own(d, 'patch'))) {
      fail('invalid-argument', 'Invalid attendance operation');
    }
    const day = date(d.date), month = day.slice(0, 7);
    try { monthKey(month); } catch (_) { fail('invalid-argument', 'Invalid attendance month'); }
    const expected = version(d.expected_version, operation === 'save');
    if (operation === 'delete' && expected === 'absent') fail('invalid-argument', 'Cannot delete an absent attendance day');
    if (typeof d.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(d.request_id)) fail('invalid-argument', 'Invalid request id');
    const intent = { station_id: ctx.sid, actor_uid: ctx.uid, date: day, month,
      operation, expected_version: expected, ...(operation === 'save' ? { patch: editable(d.patch) } : {}) };
    return { ctx, data: d, intent, fingerprint: hash(intent),
      id: hash(['attendance-self-v1', ctx.sid, ctx.uid, d.request_id]) };
  }
  async function live(tx, r) {
    let user;
    try { user = await auth.getUser(r.ctx.uid); } catch (_) { fail('unavailable', 'Current authentication unavailable'); }
    const claims = user && user.customClaims;
    if (!user || user.disabled === true || !plain(claims) || claims.stationId !== r.ctx.sid
        || (r.ctx.super ? claims.super !== true : claims.role !== r.ctx.role)) {
      fail('permission-denied', 'Current attendance authority changed');
    }
    let profile;
    if (r.ctx.super) {
      // מנהל מערכת יכול להיות גם עובד תחנה. סמכות super לבדה אינה
      // מייצרת דוח אישי: נדרש פרופיל עובד חי באותה תחנה, עם מספר עובד
      // ותפקיד עובד תקין. הפעולה נשארת על ה-UID שלו בלבד.
      const ref = db.collection('stations').doc(r.ctx.sid).collection('users').doc(r.ctx.uid);
      const snap = await tx.get(ref), member = snap.exists ? snap.data() : null;
      if (!access.activeMember(member, r.ctx.sid) || !MEMBER_ROLES.includes(member.role)) {
        fail('failed-precondition', 'Employee attendance identity unavailable');
      }
      const emp = member.employee_number;
      profile = Object.freeze({ uid:r.ctx.uid, sid:r.ctx.sid, role:member.role,
        employee_number:typeof emp === 'string' || typeof emp === 'number' ? String(emp).slice(0, 20) : '',
        full_name:typeof member.full_name === 'string' ? member.full_name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) : '',
        crew:typeof member.crew === 'string' ? member.crew.trim().slice(0, 16) :
          typeof member.shift === 'string' ? member.shift.trim().slice(0, 16) : '' });
    } else {
      profile = await identity.requireLive(tx, r.ctx);
    }
    if (!profile.employee_number || !TARGET_ROLES.includes(profile.role)) fail('failed-precondition', 'Employee attendance identity unavailable');
    return profile;
  }
  function derived(record, config) {
    let out;
    try { out = calculate(structuredClone(record), structuredClone(config)); }
    catch (_) { fail('failed-precondition', 'Attendance calculation is incomplete'); }
    shape(out, DERIVED);
    if (typeof out.hours !== 'number' || !Number.isFinite(out.hours) || out.hours < 0
        || typeof out.day_type_he !== 'string' || typeof out.site_name !== 'string'
        || typeof out.reason_required !== 'boolean') fail('failed-precondition', 'Attendance calculation is invalid');
    return out;
  }
  function retainedDay(record) {
    if (!plain(record)) return null;
    const out = {};
    for (const key of RETAINED_DAY_FIELDS) if (own(record, key)) out[key] = structuredClone(record[key]);
    return out;
  }
  async function mutateDay(req) {
    const r = request(req), root = db.collection('stations').doc(r.ctx.sid);
    return db.runTransaction(async tx => {
      const person = await live(tx, r);
      const rowRef = root.collection('attendance').doc(person.employee_number + '_' + r.intent.date);
      const reportRef = root.collection('monthly_reports').doc(person.employee_number + '_' + r.intent.month);
      const receiptRef = root.collection(COLLECTIONS.receipts).doc(r.id);
      const [receipt, row, report] = await Promise.all([tx.get(receiptRef), tx.get(rowRef), tx.get(reportRef)]);
      if (receipt.exists) {
        const v = receipt.data();
        if (!plain(v) || v.schema !== 'attendance-self-receipt-v1' || v.fingerprint !== r.fingerprint
            || v.actor_uid !== r.ctx.uid || v.request_id !== r.data.request_id) fail('already-exists', 'Request id belongs to another attendance action');
        await live(tx, r);
        return { operation_id: r.id, outcome: 'recorded', duplicate: true, operation: v.operation };
      }
      if (!same(snapVersion(row), r.intent.expected_version)) fail('aborted', 'Attendance changed; reload before saving');
      const before = row.exists ? row.data() : null;
      if (before && (!plain(before) || String(before.emp_number) !== person.employee_number
          || (own(before, 'uid') && before.uid !== r.ctx.uid) || before.date !== r.intent.date
          || before.month !== r.intent.month || (own(before, 'status') && before.status !== 'draft'))) {
        fail('failed-precondition', 'Attendance row is locked or has invalid identity');
      }
      if (report.exists) {
        const v = report.data();
        if (!plain(v) || String(v.emp_number) !== person.employee_number || v.month !== r.intent.month
            || (own(v, 'uid') && v.uid !== r.ctx.uid) || (own(v, 'status') && v.status !== 'draft')) {
          fail('failed-precondition', 'Monthly report is locked');
        }
      } else if (monthAt(clock()) !== r.intent.month) {
        fail('failed-precondition', 'A report is required for a historical month');
      }
      const commit = serverTimestamp();
      if (!commit || typeof commit !== 'object') fail('failed-precondition', 'Server timestamp unavailable');
      if (r.intent.operation === 'delete') {
        // A cancelled draft disappears from the active month, but its bounded
        // before-image remains in the server-only durable receipt. This keeps
        // the hours audit trail without exposing deleted content to the client.
        await live(tx, r);
        tx.delete(rowRef);
      }
      else {
        const base = before || { uid: r.ctx.uid, emp_number: person.employee_number, full_name: person.full_name,
          crew: person.crew, date: r.intent.date, month: r.intent.month, status: 'draft', reported_at: commit };
        const candidate = { ...base, ...r.intent.patch, uid: r.ctx.uid, emp_number: person.employee_number,
          full_name: person.full_name, crew: person.crew, date: r.intent.date, month: r.intent.month,
          status: 'draft', updated_at: commit };
        const config = await readConfig(tx, { stationId: r.ctx.sid, targetRole: person.role,
          subStationIds: candidate.sub_station ? [candidate.sub_station] : [] });
        const output = derived(candidate, config);
        await live(tx, r);
        tx.set(rowRef, { ...candidate, ...output });
      }
      tx.create(receiptRef, { schema: 'attendance-self-receipt-v1', operation_id: r.id,
        station_id: r.ctx.sid, actor_uid: r.ctx.uid, employee_number: person.employee_number,
        date: r.intent.date, month: r.intent.month, operation: r.intent.operation,
        request_id: r.data.request_id, fingerprint: r.fingerprint, committed_at: commit,
        ...(r.intent.operation === 'delete' ? { deleted_before: retainedDay(before) } : {}) });
      return { operation_id: r.id, outcome: 'recorded', duplicate: false, operation: r.intent.operation };
    });
  }
  async function readMonth(req) {
    const ctx = identity.context(req);
    shape(req.data, ['month']);
    let month;
    try { month = monthKey(req.data.month); } catch (_) { fail('invalid-argument', 'Invalid attendance month'); }
    const r = { ctx };
    const root = db.collection('stations').doc(ctx.sid);
    return db.runTransaction(async tx => {
      const person = await live(tx, r);
      const query = root.collection('attendance').where('emp_number', '==', person.employee_number)
        .where('month', '==', month).limit(32);
      const reportRef = root.collection('monthly_reports').doc(person.employee_number + '_' + month);
      const [rows, report] = await Promise.all([tx.get(query), tx.get(reportRef)]);
      if (!rows || !Array.isArray(rows.docs) || rows.docs.length > 31) fail('failed-precondition', 'Attendance month is invalid');
      const days = rows.docs.map(s => {
        const value = s.data();
        if (!plain(value) || String(value.emp_number) !== person.employee_number
            || (own(value, 'uid') && value.uid !== ctx.uid) || value.month !== month
            || date(value.date) !== value.date) fail('failed-precondition', 'Attendance row identity is invalid');
        return { record_id: s.id, expected_version: snapVersion(s), record: value };
      }).sort((a, b) => String(a.record.date).localeCompare(String(b.record.date)));
      let reportValue = null;
      if (report.exists) {
        const value = report.data();
        if (!plain(value) || String(value.emp_number) !== person.employee_number || value.month !== month
            || (own(value, 'uid') && value.uid !== ctx.uid)) fail('failed-precondition', 'Monthly report identity is invalid');
        reportValue = { expected_version: snapVersion(report), record: value };
      }
      await live(tx, r);
      return { station_id: ctx.sid, employee_number: person.employee_number, month, days, report: reportValue };
    });
  }
  function monthRequest(req) {
    const ctx = identity.context(req);
    const d = req.data;
    if (!plain(d) || !['fill', 'recalculate', 'submit', 'unsubmit'].includes(d.operation)) {
      fail('invalid-argument', 'Invalid attendance month operation');
    }
    const common = ['month', 'operation', 'request_id'];
    const allowed = d.operation === 'fill' ? [...common, 'entries']
      : d.operation === 'recalculate' ? [...common, 'days']
      : d.operation === 'submit' ? [...common, 'days', 'expected_report_version']
      : [...common, 'expected_report_version'];
    shape(d, allowed);
    let month;
    try { month = monthKey(d.month); } catch (_) { fail('invalid-argument', 'Invalid attendance month'); }
    if (typeof d.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(d.request_id)) fail('invalid-argument', 'Invalid request id');
    let entries, days, reportVersion;
    if (d.operation === 'fill') {
      if (!Array.isArray(d.entries) || !d.entries.length || d.entries.length > 31) fail('invalid-argument', 'Invalid attendance entries');
      entries = d.entries.map(v => { shape(v, ['date', 'patch']); const day = date(v.date);
        if (day.slice(0, 7) !== month) fail('invalid-argument', 'Attendance entry is outside month');
        return { date: day, patch: editable(v.patch) }; });
    } else if (['recalculate', 'submit'].includes(d.operation)) {
      if (!Array.isArray(d.days) || !d.days.length || d.days.length > 31) fail('invalid-argument', 'Invalid attendance days');
      days = d.days.map(v => { shape(v, ['date', 'expected_version']); const day = date(v.date);
        if (day.slice(0, 7) !== month) fail('invalid-argument', 'Attendance day is outside month');
        return { date: day, expected_version: version(v.expected_version, false) }; });
    }
    const list = entries || days || [];
    if (new Set(list.map(v => v.date)).size !== list.length
        || list.some((v, i) => i && list[i - 1].date >= v.date)) fail('invalid-argument', 'Attendance days must be unique and sorted');
    if (['submit', 'unsubmit'].includes(d.operation)) reportVersion = version(d.expected_report_version, d.operation === 'submit');
    const intent = { station_id: ctx.sid, actor_uid: ctx.uid, month, operation: d.operation,
      ...(entries ? { entries } : {}), ...(days ? { days } : {}),
      ...(reportVersion ? { expected_report_version: reportVersion } : {}) };
    return { ctx, data: d, intent, fingerprint: hash(intent),
      id: hash(['attendance-self-month-v1', ctx.sid, ctx.uid, d.request_id]) };
  }
  async function mutateMonth(req) {
    const r = monthRequest(req), root = db.collection('stations').doc(r.ctx.sid);
    return db.runTransaction(async tx => {
      const person = await live(tx, r);
      const reportRef = root.collection('monthly_reports').doc(person.employee_number + '_' + r.intent.month);
      const receiptRef = root.collection(COLLECTIONS.receipts).doc(r.id);
      const query = root.collection('attendance').where('emp_number', '==', person.employee_number)
        .where('month', '==', r.intent.month).limit(32);
      const [receipt, rows, report] = await Promise.all([tx.get(receiptRef), tx.get(query), tx.get(reportRef)]);
      if (receipt.exists) {
        const v = receipt.data();
        if (!plain(v) || v.schema !== 'attendance-self-month-receipt-v1' || v.fingerprint !== r.fingerprint
            || v.actor_uid !== r.ctx.uid || v.request_id !== r.data.request_id) fail('already-exists', 'Request id belongs to another attendance action');
        await live(tx, r);
        return { operation_id: r.id, outcome: 'recorded', duplicate: true,
          operation: v.operation, changed_count: v.changed_count, status: v.status || null };
      }
      if (!rows || !Array.isArray(rows.docs) || rows.docs.length > 31) fail('failed-precondition', 'Attendance month is invalid');
      const byDate = new Map();
      for (const s of rows.docs) {
        const value = s.data();
        if (!plain(value) || String(value.emp_number) !== person.employee_number
            || (own(value, 'uid') && value.uid !== r.ctx.uid) || value.month !== r.intent.month
            || date(value.date) !== value.date || byDate.has(value.date)) fail('failed-precondition', 'Attendance row identity is invalid');
        byDate.set(value.date, { snap: s, value });
      }
      const reportValue = report.exists ? report.data() : null;
      if (reportValue && (!plain(reportValue) || String(reportValue.emp_number) !== person.employee_number
          || reportValue.month !== r.intent.month || (own(reportValue, 'uid') && reportValue.uid !== r.ctx.uid))) {
        fail('failed-precondition', 'Monthly report identity is invalid');
      }
      const reportState = reportValue && own(reportValue, 'status') ? reportValue.status : 'draft';
      const commit = serverTimestamp();
      if (!commit || typeof commit !== 'object') fail('failed-precondition', 'Server timestamp unavailable');
      let changed = 0, status = null;
      if (r.intent.operation === 'fill') {
        if (reportState !== 'draft') fail('failed-precondition', 'Monthly report is locked');
        const sites = [...new Set(r.intent.entries.map(v => v.patch.sub_station).filter(Boolean))];
        const config = await readConfig(tx, { stationId: r.ctx.sid, targetRole: person.role, subStationIds: sites });
        await live(tx, r);
        for (const entry of r.intent.entries) if (!byDate.has(entry.date)) {
          const candidate = { uid: r.ctx.uid, emp_number: person.employee_number, full_name: person.full_name,
            crew: person.crew, date: entry.date, month: r.intent.month, status: 'draft', reported_at: commit,
            updated_at: commit, ...entry.patch };
          tx.create(root.collection('attendance').doc(person.employee_number + '_' + entry.date),
            { ...candidate, ...derived(candidate, config) }); changed++;
        }
      } else if (r.intent.operation === 'recalculate') {
        if (reportState !== 'draft' || r.intent.days.length !== byDate.size) fail('failed-precondition', 'Monthly report is locked or incomplete');
        const sites = [...new Set([...byDate.values()].map(v => v.value.sub_station).filter(Boolean))];
        const config = await readConfig(tx, { stationId: r.ctx.sid, targetRole: person.role, subStationIds: sites });
        await live(tx, r);
        for (const day of r.intent.days) {
          const row = byDate.get(day.date);
          if (!row || !same(snapVersion(row.snap), day.expected_version) || row.value.status !== 'draft') fail('aborted', 'Attendance changed; reload before recalculating');
          const output = derived(row.value, config);
          if (DERIVED.some(k => !same(row.value[k], output[k]))) {
            tx.set(row.snap.ref, { ...row.value, ...output, updated_at: commit }); changed++;
          }
        }
      } else if (r.intent.operation === 'submit') {
        if (!same(snapVersion(report), r.intent.expected_report_version) || reportState !== 'draft'
            || r.intent.days.length !== byDate.size) fail('aborted', 'Monthly report changed; reload before submitting');
        const sites = [...new Set([...byDate.values()].map(v => v.value.sub_station).filter(Boolean))];
        const config = await readConfig(tx, { stationId: r.ctx.sid, targetRole: person.role, subStationIds: sites });
        let total = 0;
        const updates = [];
        for (const day of r.intent.days) {
          const row = byDate.get(day.date);
          if (!row || !same(snapVersion(row.snap), day.expected_version) || row.value.status !== 'draft'
              || !Number.isFinite(Number(row.value.hours))) fail('aborted', 'Attendance changed; reload before submitting');
          const output = derived(row.value, config);
          total += output.hours;
          if (DERIVED.some(k => !same(row.value[k], output[k]))) {
            updates.push({ ref: row.snap.ref, value: { ...row.value, ...output, updated_at: commit } });
          }
        }
        status = 'submitted';
        await live(tx, r);
        for (const update of updates) tx.set(update.ref, update.value);
        tx.set(reportRef, { ...(reportValue || {}), uid: r.ctx.uid, emp_number: person.employee_number,
          full_name: person.full_name, crew: person.crew, month: r.intent.month, status,
          days: r.intent.days.map(v => v.date), total_hours: Math.round(total * 100) / 100,
          submitted_at: commit, updated_at: commit }); changed = 1;
      } else {
        if (!report.exists || !same(snapVersion(report), r.intent.expected_report_version)
            || reportState !== 'submitted') fail('aborted', 'Monthly report changed; reload before reopening');
        status = 'draft';
        await live(tx, r);
        tx.set(reportRef, { ...reportValue, status, updated_at: commit }); changed = 1;
      }
      tx.create(receiptRef, { schema: 'attendance-self-month-receipt-v1', operation_id: r.id,
        station_id: r.ctx.sid, actor_uid: r.ctx.uid, employee_number: person.employee_number,
        month: r.intent.month, operation: r.intent.operation, changed_count: changed, status,
        request_id: r.data.request_id, fingerprint: r.fingerprint, committed_at: commit });
      return { operation_id: r.id, outcome: 'recorded', duplicate: false,
        operation: r.intent.operation, changed_count: changed, status };
    });
  }
  return Object.freeze({ mutateDay, readMonth, mutateMonth });
}

module.exports = Object.freeze({ createAttendanceSelfService });
