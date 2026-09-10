'use strict';

// UNEXPORTED domain slice: no callable, SDK initialization, dispatcher or rules.
// Trusted integration ports are mandatory: readConfig(tx, {stationId,
// subStationIds, targetRole}) reads only; calculate(record, config) synchronously returns
// exactly DERIVED; monthAt(serverMilliseconds) returns the Jerusalem month.
// Their canonical calculation/configuration provenance is an integration gate,
// not something a synthetic calculator test can establish.
//
// correctOneDay data: common + operation(create/update/delete), date,
// expected_version ({seconds,nanoseconds} | 'absent'), patch (not for delete).
// correctMonthRecalc data: common + days:[{date,expected_version}], the complete
// existing month (1..31 rows). common: target_uid, employee_number, month,
// reason, request_id. There is deliberately no client station or derived field.
// The report is read, NEVER rewritten: submission, stored totals and approval
// remain distinct from corrected current attendance. No employee consent gate.

const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity, MEMBER_ROLES } = require('./ops-member-identity');
const { monthKey } = require('./hr-hours-model');
const COLLECTIONS = Object.freeze({
  events: 'attendance_correction_events', receipts: 'attendance_correction_receipts',
  jobs: 'attendance_correction_notification_jobs'
});
const LIMITS = Object.freeze({ days: 31, evidenceBytes: 128 * 1024, text: 4000 });
const EDITABLE = Object.freeze(['day_type', 'shape', 'start', 'end', 'end_day',
  'start2', 'end2', 'end_day2', 'sub_station', 'overtime_reason', 'notes', 'reason']);
const DERIVED = Object.freeze(['hours', 'day_type_he', 'site_name', 'reason_required']);
const DAY_TYPES = ['regular', 'swap', 'extra', 'meeting', 'guard', 'vacation', 'sick', 'reserve'];
const SHAPES = ['regular', 'continued', 'split'];
// Canonical local profile roles, not caller claims or role-rank entitlement.
const TARGET_ROLES = Object.freeze(MEMBER_ROLES.concat(['district_commander']));
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const COMMON = ['target_uid', 'employee_number', 'month', 'reason', 'request_id'];

function createAttendanceCorrections({ db, auth, HttpsError, serverTimestamp,
  clock = Date.now, readConfig, calculate, monthAt, hooks = {} }) {
  if (!db || typeof db.runTransaction !== 'function' || !auth || typeof auth.getUser !== 'function'
    || [HttpsError, serverTimestamp, clock, readConfig, calculate, monthAt].some(v => typeof v !== 'function')) {
    throw new TypeError('Database, Auth, error/time and trusted calculation/config/month ports are required');
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const fail = (code, message) => { throw new HttpsError(code, message); };
  function shape(v, keys, required = keys, code = 'invalid-argument') {
    if (!plain(v) || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !keys.includes(k)
      || !own(Object.getOwnPropertyDescriptor(v, k), 'value'))
      || required.some(k => !own(v, k))) fail(code, 'Invalid closed record.');
  }
  function employee(v) {
    if (typeof v !== 'string' || !v || v.length > 64 || /[\u0000-\u001f\u007f/]/.test(v)) fail('invalid-argument', 'Invalid employee number.');
    return v;
  }
  function sameEmployee(value, expected) {
    return (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
      && String(value) === expected;
  }
  function day(v, month) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !v.startsWith(month + '-')) fail('invalid-argument', 'Invalid date.');
    const parsed = new Date(v + 'T00:00:00.000Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) fail('invalid-argument', 'Invalid calendar date.');
    return v;
  }
  function version(v, allowAbsent) {
    if (v === 'absent' && allowAbsent) return v;
    shape(v, ['seconds', 'nanoseconds']);
    if (!Number.isSafeInteger(v.seconds) || v.seconds < -62135596800 || v.seconds > 253402300799
      || !Number.isInteger(v.nanoseconds) || v.nanoseconds < 0 || v.nanoseconds >= 1e9) fail('invalid-argument', 'Invalid record version.');
    return { seconds: v.seconds, nanoseconds: v.nanoseconds };
  }
  function snapshotVersion(s) {
    if (!s.exists) return 'absent';
    if (!s.updateTime) fail('failed-precondition', 'Stored version is unavailable.');
    return version({ seconds: s.updateTime.seconds, nanoseconds: s.updateTime.nanoseconds }, false);
  }
  function field(k, v) {
    if (k === 'day_type') return typeof v === 'string' && DAY_TYPES.includes(v);
    if (k === 'shape') return typeof v === 'string' && SHAPES.includes(v);
    if (k === 'end_day' || k === 'end_day2') return Number.isInteger(v) && [0, 1, 2].includes(v);
    if (['start', 'end', 'start2', 'end2'].includes(k)) return typeof v === 'string' && (v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v));
    if (k === 'sub_station') return typeof v === 'string' && (v === '' || access.validId(v));
    return typeof v === 'string' && v.length <= LIMITS.text && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
  }
  function patch(v, create) {
    shape(v, EDITABLE, create ? ['day_type'] : []);
    if (!Object.keys(v).length || Object.entries(v).some(([k, x]) => !field(k, x))) fail('invalid-argument', 'Invalid editable attendance fields.');
    return Object.fromEntries(EDITABLE.filter(k => own(v, k)).map(k => [k, v[k]]));
  }
  function request(req, recalc) {
    const ctx = identity.context(req);
    if (!ctx.super && ctx.role !== 'hr_coordinator') fail('permission-denied', 'HR correction authority is required.');
    const d = req.data;
    shape(d, COMMON.concat(recalc ? ['days'] : ['date', 'operation', 'expected_version', 'patch']),
      COMMON.concat(recalc ? ['days'] : ['date', 'operation', 'expected_version']));
    if (!access.validUid(d.target_uid)) fail('invalid-argument', 'Invalid target.');
    employee(d.employee_number);
    try { monthKey(d.month); } catch (_) { fail('invalid-argument', 'Invalid month.'); }
    if (typeof d.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(d.request_id)) fail('invalid-argument', 'Invalid request id.');
    if (typeof d.reason !== 'string') fail('invalid-argument', 'A correction reason is required.');
    const reason = d.reason.normalize('NFC').trim();
    if (reason.length < 20 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) fail('invalid-argument', 'Correction reason must contain 20 to 500 characters.');
    const authTime = req.auth.token.auth_time;
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) fail('unauthenticated', 'Refresh sign-in.');
    let operation, rows;
    if (recalc) {
      operation = 'recalculate';
      if (!Array.isArray(d.days) || !d.days.length || d.days.length > LIMITS.days) fail('invalid-argument', 'Recalculation needs 1 to 31 existing dates.');
      rows = d.days.map(r => { shape(r, ['date', 'expected_version']); return { date: day(r.date, d.month), expected_version: version(r.expected_version, false) }; });
    } else {
      operation = d.operation;
      if (!['create', 'update', 'delete'].includes(operation) || (operation === 'delete' && own(d, 'patch'))) fail('invalid-argument', 'Invalid correction operation.');
      const expected = version(d.expected_version, operation === 'create');
      if ((operation === 'create') !== (expected === 'absent')) fail('invalid-argument', 'Creation requires an absent precondition.');
      rows = [{ date: day(d.date, d.month), expected_version: expected,
        ...(operation === 'delete' ? {} : { patch: patch(d.patch, operation === 'create') }) }];
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    if (new Set(rows.map(r => r.date)).size !== rows.length) fail('invalid-argument', 'Duplicate dates.');
    const intent = { station_id: ctx.sid, actor_uid: ctx.uid, target_uid: d.target_uid,
      employee_number: d.employee_number, month: d.month, operation, reason, rows };
    return { ctx, authTime, intent, requestId: d.request_id, fingerprint: hash(intent),
      id: hash(['attendance-correction-v1', ctx.sid, ctx.uid, d.request_id]) };
  }
  async function live(tx, r) {
    let user;
    try { user = await auth.getUser(r.ctx.uid); }
    catch (e) { fail(e && e.code === 'auth/user-not-found' ? 'permission-denied' : 'unavailable', 'Current authentication is unavailable.'); }
    const c = user && user.customClaims;
    if (!user || user.uid !== r.ctx.uid || user.disabled === true || !plain(c)
      || c.stationId !== r.ctx.sid || (c.super === true) !== r.ctx.super
      || (!r.ctx.super && c.role !== 'hr_coordinator')) fail('permission-denied', 'Current correction authority changed.');
    if (own(user, 'tokensValidAfterTime')) {
      const at = typeof user.tokensValidAfterTime === 'string' ? Date.parse(user.tokensValidAfterTime) : NaN;
      if (!Number.isFinite(at)) fail('unavailable', 'Authentication revocation state is invalid.');
      if (r.authTime * 1000 < at) fail('permission-denied', 'Sign-in was revoked.');
    }
    await identity.requireLive(tx, r.ctx);
    return { name: typeof user.displayName === 'string' && user.displayName.length <= 500 ? user.displayName : r.ctx.uid };
  }
  async function target(tx, r, root) {
    const s = await tx.get(root.collection('users').doc(r.intent.target_uid));
    const p = s.exists ? s.data() : null;
    if (!plain(p) || !access.liveStation(p).ok || access.liveStation(p).stationId !== r.ctx.sid
      || !sameEmployee(p.employee_number, r.intent.employee_number)
      || typeof p.role !== 'string' || !TARGET_ROLES.includes(p.role)
      || (own(p, 'uid') && p.uid !== r.intent.target_uid)
      || ['active', 'is_active'].some(k => own(p, k) && typeof p[k] !== 'boolean')) fail('failed-precondition', 'Canonical local employee binding is unavailable.');
    const inactive = p.active === false || p.is_active === false;
    if (!inactive) {
      const [i, d] = await Promise.all([tx.get(db.collection('emp_index').doc(r.intent.employee_number)), tx.get(db.collection('directory').doc(r.intent.target_uid))]);
      const index = i.exists ? i.data() : null, directory = d.exists ? d.data() : null;
      if (!plain(index) || index.uid !== r.intent.target_uid || index.stationId !== r.ctx.sid
        || index.active === false || index.retired === true || index.status === 'retired'
        || !access.activeMember(directory, r.ctx.sid)
        || (own(directory, 'uid') && directory.uid !== r.intent.target_uid)
        || (own(directory, 'employee_number') && !sameEmployee(directory.employee_number, r.intent.employee_number))) fail('failed-precondition', 'Active employee binding is unavailable.');
    }
    // Historical content stays anchored locally; never borrow a transferred
    // person's new-station directory name, crew or attendance.
    return { inactive, role: p.role, version: snapshotVersion(s), full_name: typeof p.full_name === 'string' ? p.full_name : '', crew: typeof p.crew === 'string' ? p.crew : '' };
  }
  function time() {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(new Date(at).getTime())) fail('failed-precondition', 'Invalid server clock.');
    return at;
  }
  function millis(v) {
    if (!v || !Number.isSafeInteger(v.seconds) || !Number.isInteger(v.nanoseconds)
      || v.nanoseconds < 0 || v.nanoseconds >= 1e9) return NaN;
    return v.seconds * 1000 + v.nanoseconds / 1e6;
  }
  function reportGate(s, r, p, at, importedRows) {
    if (!s.exists) {
      let current;
      try { current = monthAt(at); monthKey(current); } catch (_) { fail('failed-precondition', 'Trusted current month is unavailable.'); }
      if (r.intent.operation !== 'create' || p.inactive || current !== r.intent.month) fail('failed-precondition', 'A suitable report is required.');
      return;
    }
    const v = s.data();
    if (!plain(v) || (own(v, 'uid') && v.uid !== r.intent.target_uid) || !sameEmployee(v.emp_number, r.intent.employee_number)
      || v.month !== r.intent.month || !['draft', 'submitted'].includes(v.status)) fail('failed-precondition', 'Report is invalid or must be reopened.');
    if (p.inactive || importedRows) {
      const reopened = millis(v.reopened_at), approved = own(v, 'approved_at') ? millis(v.approved_at) : null;
      if (r.intent.operation === 'create' || !access.validUid(v.reopened_by)
        || !Number.isFinite(reopened) || reopened < 0 || reopened > at
        || (approved !== null && (!Number.isFinite(approved) || approved >= reopened))) fail('failed-precondition', 'Historical correction requires valid reopening evidence.');
    }
  }
  function rowGate(s, expected, r) {
    if (JSON.stringify(snapshotVersion(s)) !== JSON.stringify(expected.expected_version)) fail('aborted', 'Attendance changed; refresh before correcting.');
    if (!s.exists) return null;
    const v = s.data();
    if (!plain(v) || (own(v, 'uid') && v.uid !== r.intent.target_uid) || !sameEmployee(v.emp_number, r.intent.employee_number)
      || v.date !== expected.date || v.month !== r.intent.month
      || (own(v, 'status') && !['draft', 'submitted', 'imported'].includes(v.status))) fail('failed-precondition', 'Attendance identity or lock state is invalid.');
    return v;
  }
  function derived(record, config) {
    const out = calculate(record, config);
    shape(out, DERIVED, DERIVED, 'failed-precondition');
    if (typeof out.hours !== 'number' || !Number.isFinite(out.hours) || out.hours < 0
      || !['day_type_he', 'site_name'].every(k => typeof out[k] === 'string' && out[k].length <= 500)
      || typeof out.reason_required !== 'boolean') fail('failed-precondition', 'Trusted calculation output is invalid.');
    return { ...out };
  }
  // Lossless, tagged evidence for supported Firestore values. All fields,
  // including unknown legacy fields, are included. Unsupported types or large
  // payloads fail before writes, never silently drop or truncate evidence.
  function evidence(value, commitTime, depth = 0) {
    if (depth > 20) fail('resource-exhausted', 'Correction evidence is too deep.');
    if (value === commitTime) return { type: 'commit_timestamp' };
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return { type: typeof value, value };
    if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
    if (Array.isArray(value)) return { type: 'array', value: value.map(v => evidence(v, commitTime, depth + 1)) };
    // Firestore forbids direct array children. Object entries preserve every
    // literal key (including dots/empty keys) without array-of-array tuples.
    if (plain(value)) return { type: 'map', value: Object.keys(value).sort().map(k => ({ key: k, value: evidence(value[k], commitTime, depth + 1) })) };
    if (value && typeof value.toDate === 'function' && Number.isFinite(millis(value))) return { type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
    fail('failed-precondition', 'A stored value cannot be represented faithfully in correction evidence.');
  }
  function bounded(value) {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.evidenceBytes) fail('resource-exhausted', 'Correction evidence exceeds its byte limit.');
  }
  async function execute(req, recalc) {
    const r = request(req, recalc), root = db.collection('stations').doc(r.ctx.sid);
    const eventRef = root.collection(COLLECTIONS.events).doc(r.id), receiptRef = root.collection(COLLECTIONS.receipts).doc(r.id);
    const jobRef = root.collection(COLLECTIONS.jobs).doc(r.id);
    return db.runTransaction(async tx => {
      await live(tx, r);
      const person = await target(tx, r, root), receipt = await tx.get(receiptRef);
      if (receipt.exists) {
        const prior = receipt.data();
        shape(prior, ['schema', 'correction_id', 'station_id', 'actor_uid', 'target_uid', 'employee_number', 'month', 'request_id', 'fingerprint', 'changed_count'], undefined, 'failed-precondition');
        if (prior.schema !== 'attendance-correction-receipt-v1' || prior.correction_id !== r.id || prior.station_id !== r.ctx.sid
          || prior.actor_uid !== r.ctx.uid || prior.request_id !== r.requestId) fail('failed-precondition', 'Stored receipt is invalid.');
        if (prior.fingerprint !== r.fingerprint || prior.target_uid !== r.intent.target_uid
          || prior.employee_number !== r.intent.employee_number || prior.month !== r.intent.month) fail('already-exists', 'Request id belongs to another correction.');
        const event = await tx.get(eventRef);
        if (!Number.isInteger(prior.changed_count) || prior.changed_count !== r.intent.rows.length
          || !event.exists || event.data().fingerprint !== r.fingerprint || event.data().correction_id !== r.id) fail('failed-precondition', 'Correction evidence is incomplete.');
        // Durable replay never requires or recreates a transient dispatch job.
        // intent_only describes the original registration, not current delivery.
        await live(tx, r);
        const finalPerson = await target(tx, r, root);
        if (JSON.stringify(finalPerson) !== JSON.stringify(person)) fail('aborted', 'Employee changed during replay.');
        return { correction_id: r.id, changed_count: prior.changed_count, outcome: 'recorded', notification_status: 'intent_only', duplicate: true };
      }
      const report = await tx.get(root.collection('monthly_reports').doc(r.intent.employee_number + '_' + r.intent.month));
      let snapshots;
      if (recalc) {
        const found = await tx.get(root.collection('attendance').where('emp_number', '==', r.intent.employee_number).where('month', '==', r.intent.month).limit(LIMITS.days + 1));
        const byId = new Map(found.docs.map(s => [s.id, s]));
        if (found.docs.length !== r.intent.rows.length) fail('aborted', 'The month row set changed.');
        snapshots = r.intent.rows.map(row => byId.get(r.intent.employee_number + '_' + row.date));
        if (snapshots.some(s => !s)) fail('failed-precondition', 'Month contains noncanonical attendance rows.');
      } else snapshots = [await tx.get(root.collection('attendance').doc(r.intent.employee_number + '_' + r.intent.rows[0].date))];
      const before = snapshots.map((s, i) => rowGate(s, r.intent.rows[i], r));
      const importedRows = before.some(v => v && v.status === 'imported');
      reportGate(report, r, person, time(), importedRows);
      const prepared = before.map((v, i) => r.intent.operation === 'delete' ? null : {
        ...(v || { uid: r.intent.target_uid, emp_number: r.intent.employee_number,
          full_name: person.full_name, crew: person.crew, date: r.intent.rows[i].date, month: r.intent.month,
          status: 'draft', shape: 'regular', start: '', end: '', end_day: 0, start2: '', end2: '', end_day2: 0,
          sub_station: '', notes: '', overtime_reason: '' }), ...(r.intent.rows[i].patch || {})
      });
      const config = r.intent.operation === 'delete' ? null : await readConfig(tx, {
        stationId: r.ctx.sid, targetRole: person.role,
        subStationIds: [...new Set(prepared.map(v => v.sub_station || ''))].sort()
      });
      if (r.intent.operation !== 'delete' && !plain(config)) fail('failed-precondition', 'Trusted calculation configuration is unavailable.');
      // Calculators receive independent bounded values; mutation of their input
      // cannot alter the copied legacy record, request or the stored evidence.
      const outputs = prepared.map(v => v === null ? null : derived(structuredClone(v), structuredClone(config)));
      if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ operation: r.intent.operation });
      const actor = await live(tx, r);
      const finalPerson = await target(tx, r, root);
      if (JSON.stringify(finalPerson) !== JSON.stringify(person)) fail('aborted', 'Employee changed during correction.');
      const at = time();
      reportGate(report, r, finalPerson, at, importedRows); // Current-month decision after async ports/hooks.
      const committedAt = serverTimestamp();
      if (!committedAt || typeof committedAt !== 'object') fail('failed-precondition', 'Server timestamp is unavailable.');
      const after = prepared.map((v, i) => v === null ? null : { ...v, ...outputs[i], edited_by: r.ctx.uid, edited_by_name: actor.name,
        edited_at: committedAt, updated_at: committedAt });
      const event = { schema: 'attendance-correction-event-v1', correction_id: r.id, station_id: r.ctx.sid,
        actor_uid: r.ctx.uid, actor_name: actor.name, actor_role: r.ctx.role, actor_auth_time: r.authTime,
        target_uid: r.intent.target_uid, employee_number: r.intent.employee_number, month: r.intent.month,
        operation: r.intent.operation, reason: r.intent.reason, request_id: r.requestId, fingerprint: r.fingerprint,
        created_at_ms: at, committed_at: committedAt, evidence_encoding: 'tagged-firestore-v2',
        calculation_config: evidence(config, committedAt),
        changes: snapshots.map((s, i) => ({ date: r.intent.rows[i].date, record_id: s.id,
          before_version: snapshotVersion(s), before: evidence(before[i], committedAt), after: evidence(after[i], committedAt) })) };
      // Include envelope and timestamp representation in the strict byte cap.
      bounded({ ...event, committed_at: { type: 'commit_timestamp' } });
      const savedReceipt = { schema: 'attendance-correction-receipt-v1', correction_id: r.id,
        station_id: r.ctx.sid, actor_uid: r.ctx.uid, target_uid: r.intent.target_uid,
        employee_number: r.intent.employee_number, month: r.intent.month, request_id: r.requestId,
        fingerprint: r.fingerprint, changed_count: snapshots.length };
      const notification = { schema: 'attendance-correction-notification-v1', event_id: r.id,
        station_id: r.ctx.sid, actor_uid: r.ctx.uid, actor_auth_time: r.authTime,
        recipient_uid: r.intent.target_uid, employee_number: r.intent.employee_number, month: r.intent.month,
        type: 'attendance_corrected', audience: 'person', status: 'policy_pending', delivery_status: 'intent_only',
        created_at_ms: at, send_now: false, consent_expires_at_ms: 0, routine_after_quiet: true, exclude_actor: false };
      // Every transaction read (including replay/final authority) precedes writes.
      snapshots.forEach((s, i) => { if (after[i] === null) tx.delete(s.ref); else if (!s.exists) tx.create(s.ref, after[i]); else tx.set(s.ref, after[i]); });
      tx.create(eventRef, event); tx.create(receiptRef, savedReceipt); tx.create(jobRef, notification);
      return { correction_id: r.id, changed_count: snapshots.length, outcome: 'recorded', notification_status: 'intent_only', duplicate: false };
    });
  }
  return Object.freeze({ correctOneDay: req => execute(req, false), correctMonthRecalc: req => execute(req, true) });
}

module.exports = Object.freeze({ createAttendanceCorrections, COLLECTIONS, LIMITS, EDITABLE, DERIVED, TARGET_ROLES });
