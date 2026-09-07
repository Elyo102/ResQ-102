'use strict';

// Read-only service for the HR callables. Report contents never grant
// identity or authority. Historical reads stay anchored to the old local user.
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { monthKey, projectEmployeeHours, HrHoursInputError } = require('./hr-hours-model');
const PAGE_SIZE = 25;
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const text = value => typeof value === 'string' ? value : '';
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function createHrHoursService({ db, HttpsError, hooks = {} }) {
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const error = (code, message) => new HttpsError(code, message);
  function request(req, keys) {
    const ctx = identity.context(req);
    if (!ctx.super && ctx.role !== 'hr_coordinator') throw error('permission-denied', 'נדרשת הרשאת משאבי אנוש.');
    const data = req.data;
    if (!plain(data) || Object.keys(data).some(k => !keys.includes(k))) throw error('invalid-argument', 'בקשה לא תקינה.');
    try { monthKey(data.month); } catch (_) { throw error('invalid-argument', 'חודש לא תקין.'); }
    return { ctx, data };
  }
  function stamp(snap) {
    if (!snap.exists) return 'missing';
    if (!snap.updateTime) throw error('internal', 'לא ניתן לאמת את גרסת הנתונים.');
    return snap.updateTime.seconds + ':' + snap.updateTime.nanoseconds;
  }
  function remember(fences, snap) { fences.set(snap.ref.path, { ref: snap.ref, version: stamp(snap) }); }
  function person(snap, sid) {
    const value = snap.exists ? snap.data() : null;
    if (!plain(value) || !access.validUid(snap.id) || !access.liveStation(value).ok
      || access.liveStation(value).stationId !== sid) throw new HrHoursInputError('local-person-invalid');
    const n = value.employee_number;
    if (!['string', 'number'].includes(typeof n) || (typeof n === 'number' && !Number.isFinite(n))) throw new HrHoursInputError('employee-number-invalid');
    const emp = String(n);
    if (!emp || emp.length > 64 || /[\u0000-\u001f\u007f/]/.test(emp)) throw new HrHoursInputError('employee-number-invalid');
    return { uid: snap.id, employee_number: emp, full_name: text(value.full_name),
      crew: text(value.crew), historical: value.active === false || value.is_active === false };
  }
  async function binding(tx, fences, snap, ctx) {
    remember(fences, snap);
    const p = person(snap, ctx.sid);
    if (!p.historical) {
      const [index, directory] = await Promise.all([
        tx.get(db.collection('emp_index').doc(p.employee_number)),
        tx.get(db.collection('directory').doc(p.uid))
      ]);
      remember(fences, index); remember(fences, directory);
      const i = index.exists ? index.data() : null, d = directory.exists ? directory.data() : null;
      if (!plain(i) || i.uid !== p.uid || i.stationId !== ctx.sid || i.active === false
        || i.retired === true || i.status === 'retired' || !access.activeMember(d, ctx.sid)) {
        throw new HrHoursInputError('person-binding-unavailable');
      }
      // Name/crew can be updated locally without synchronizing directory.
    }
    return p;
  }
  async function finalize(ctx, fences) {
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize();
    // A fresh read after the data transaction detects revocation/transfer during
    // loading. No claim that a read can prevent changes after this boundary.
    await db.runTransaction(async tx => {
      await identity.requireLive(tx, ctx);
      const entries = [...fences.values()];
      const current = await Promise.all(entries.map(f => tx.get(f.ref)));
      if (current.some((snap, i) => stamp(snap) !== entries[i].version)) {
        throw error('aborted', 'פרטי העובדים השתנו בזמן הטעינה. יש לרענן את הדוח.');
      }
    });
  }
  function unavailable(snap, issue) {
    const v = snap.data() || {};
    return { uid: snap.id, full_name: text(v.full_name), crew: text(v.crew),
      historical: v.active === false || v.is_active === false,
      state: 'unavailable', issue, reminder_eligible: false };
  }
  async function listMonth(req) {
    const { ctx, data } = request(req, ['month', 'cursor']);
    if (own(data, 'cursor') && !access.validUid(data.cursor)) throw error('invalid-argument', 'סמן עמוד לא תקין.');
    const root = db.collection('stations').doc(ctx.sid), fences = new Map();
    const response = await db.runTransaction(async tx => {
      // SDK retry must not keep versions from a previous attempt.
      fences.clear();
      await identity.requireLive(tx, ctx);
      let query = root.collection('users').orderBy('__name__').limit(PAGE_SIZE + 1);
      if (data.cursor) query = query.startAfter(data.cursor);
      const page = await tx.get(query), scanned = page.docs.slice(0, PAGE_SIZE);
      const items = await Promise.all(scanned.map(async snap => {
        try {
          const p = await binding(tx, fences, snap, ctx);
          const report = await tx.get(root.collection('monthly_reports').doc(p.employee_number + '_' + data.month));
          const value = projectEmployeeHours({ month: data.month, employee: p,
            report: report.exists ? report.data() : null, attendance: [] });
          return { uid: p.uid, employee_number: p.employee_number, full_name: p.full_name,
            crew: p.crew, historical: p.historical, state: value.state, label: value.label,
            stored_total_hours: value.stored_total_hours,
            declared_days: value.declared_day_keys === null ? null : value.declared_day_keys.length,
            reminder_eligible: !p.historical && ['missing', 'draft'].includes(value.state) };
        } catch (e) {
          if (e instanceof HrHoursInputError) return unavailable(snap, e.code);
          throw e; // Failed reads and authorization are never missing reports.
        }
      }));
      return { month: data.month, items,
        next_cursor: page.docs.length > PAGE_SIZE ? scanned[scanned.length - 1].id : null };
    });
    await finalize(ctx, fences);
    return response;
  }
  async function getEmployeeMonth(req) {
    const { ctx, data } = request(req, ['month', 'uid']);
    if (!access.validUid(data.uid)) throw error('invalid-argument', 'משתמש לא תקין.');
    const root = db.collection('stations').doc(ctx.sid), fences = new Map();
    let response;
    try {
      response = await db.runTransaction(async tx => {
        fences.clear();
        await identity.requireLive(tx, ctx);
        const snap = await tx.get(root.collection('users').doc(data.uid));
        if (!snap.exists) throw error('not-found', 'העובד אינו מופיע ברישומי התחנה.');
        const p = await binding(tx, fences, snap, ctx);
        const [report, attendance] = await Promise.all([
          tx.get(root.collection('monthly_reports').doc(p.employee_number + '_' + data.month)),
          tx.get(root.collection('attendance').where('emp_number', '==', p.employee_number)
            .where('month', '==', data.month).limit(32))
        ]);
        if (attendance.docs.length > 31) throw error('failed-precondition', 'נמצאו יותר מדי רשומות לחודש; נדרשת בדיקת הנתונים.');
        const value = projectEmployeeHours({ month: data.month, employee: p,
          report: report.exists ? report.data() : null, attendance: attendance.docs.map(d => d.data()) });
        return { ...value, historical: p.historical,
          reminder_eligible: !p.historical && ['missing', 'draft'].includes(value.state) };
      });
    } catch (e) {
      if (e instanceof HrHoursInputError) throw error('failed-precondition', 'נתוני הדוח דורשים בדיקה (' + e.code + ').');
      throw e;
    }
    await finalize(ctx, fences);
    return response;
  }
  return Object.freeze({ listMonth, getEmployeeMonth });
}
module.exports = Object.freeze({ createHrHoursService, PAGE_SIZE });
