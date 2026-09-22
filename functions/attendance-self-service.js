'use strict';

// Server-authoritative employee attendance writes. The browser supplies only
// editable facts and an optimistic version; identity, station, employee
// number, role, derived hours and timestamps are resolved inside one
// transaction. Durable receipts make retries exact without duplicating work.
const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { monthKey } = require('./hr-hours-model');
const { EDITABLE, DERIVED, TARGET_ROLES, COLLECTIONS } = require('./attendance-corrections');

const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

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
    if (ctx.super) fail('permission-denied', 'A station employee profile is required');
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
        || claims.role !== r.ctx.role) fail('permission-denied', 'Current attendance authority changed');
    const profile = await identity.requireLive(tx, r.ctx);
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
      if (r.intent.operation === 'delete') tx.delete(rowRef);
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
        request_id: r.data.request_id, fingerprint: r.fingerprint, committed_at: commit });
      return { operation_id: r.id, outcome: 'recorded', duplicate: false, operation: r.intent.operation };
    });
  }
  return Object.freeze({ mutateDay });
}

module.exports = Object.freeze({ createAttendanceSelfService });
