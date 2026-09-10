'use strict';

// Unwired server support. No SDK initialization, callable, notification sender
// or client rules. Context rows and their versions come from ONE transaction.
// Read finalization refreshes ACL, not content: a later edit is caught by CAS.
// Reopen preserves prior submission/approval evidence; it never creates consent.
// No reopen outbox job: the existing approved -> draft report trigger remains
// the only notification producer. Missing-report historical reopening has none.
const { createHash } = require('node:crypto');
const access = require('./schedule-access');
const { createOpsMemberIdentity } = require('./ops-member-identity');
const { monthKey } = require('./hr-hours-model');
const { COLLECTIONS, EDITABLE, DERIVED, TARGET_ROLES } = require('./attendance-corrections');
const LIMITS = Object.freeze({ days: 31, page: 25, bytes: 128 * 1024, text: 4000 });
const FIELDS = Object.freeze([...EDITABLE, ...DERIVED, 'status']);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const EVENT_ID = /^[a-f0-9]{64}$/;

function createAttendanceCorrectionSupport({ db, auth, HttpsError, serverTimestamp,
  clock = Date.now, monthAt, hooks = {} }) {
  if (!db || typeof db.runTransaction !== 'function' || !auth || typeof auth.getUser !== 'function'
      || [HttpsError, serverTimestamp, clock, monthAt].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Database, Auth, error, timestamp, clock and trusted month ports required');
  }
  const identity = createOpsMemberIdentity({ db, HttpsError });
  const fail = (code, message) => { throw new HttpsError(code, message); };
  const corrupt = message => fail('failed-precondition', message);
  function shape(v, allowed, required = allowed) {
    if (!plain(v) || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !allowed.includes(k)
        || !own(Object.getOwnPropertyDescriptor(v, k), 'value')) || required.some(k => !own(v, k))) {
      fail('invalid-argument', 'Invalid closed request');
    }
  }
  function employee(v) {
    if (typeof v !== 'string' || !v || v.length > 64 || /[\u0000-\u001f\u007f/]/.test(v)) fail('invalid-argument', 'Invalid employee number');
    return v;
  }
  const matchesEmployee = (v, expected) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) && String(v) === expected;
  function date(v, month) {
    const parsed = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00Z') : null;
    if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v || v.slice(0, 7) !== month) {
      fail('invalid-argument', 'Invalid calendar day');
    }
    return v;
  }
  function version(v, absent = false) {
    if (absent && v === 'absent') return v;
    shape(v, ['seconds', 'nanoseconds']);
    if (!Number.isSafeInteger(v.seconds) || v.seconds < -62135596800 || v.seconds > 253402300799
        || !Number.isInteger(v.nanoseconds) || v.nanoseconds < 0 || v.nanoseconds >= 1e9) fail('invalid-argument', 'Invalid stored version');
    return { seconds: v.seconds, nanoseconds: v.nanoseconds };
  }
  function token(snap) {
    if (!snap.exists) return 'absent';
    if (!snap.updateTime) corrupt('Stored version unavailable');
    return version({ seconds: snap.updateTime.seconds, nanoseconds: snap.updateTime.nanoseconds });
  }
  function millis(v) {
    if (!v || !Number.isSafeInteger(v.seconds) || !Number.isInteger(v.nanoseconds) || v.nanoseconds < 0 || v.nanoseconds >= 1e9) return NaN;
    return v.seconds * 1000 + v.nanoseconds / 1e6;
  }
  function now() {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isFinite(new Date(at).getTime())) corrupt('Server clock unavailable');
    return at;
  }
  function reason(v) {
    if (typeof v !== 'string') fail('invalid-argument', 'A reason is required');
    const out = v.normalize('NFC').trim();
    if (out.length < 20 || out.length > 500 || /[\u0000-\u001f\u007f]/.test(out)) fail('invalid-argument', 'Reason must contain 20 to 500 characters');
    return out;
  }
  function request(req, mode) {
    const ctx = identity.context(req), hr = ctx.super || ctx.role === 'hr_coordinator';
    if (!hr && ['context', 'reopen'].includes(mode)) fail('permission-denied', 'HR authority required');
    const required = ['target_uid', 'employee_number', 'month'];
    const extra = mode === 'reopen' ? ['expected_report_version', 'days', 'reason', 'request_id']
      : mode === 'list' ? ['cursor'] : mode === 'get' ? ['event_id'] : [];
    shape(req.data, [...required, ...extra], [...required, ...(mode === 'list' ? [] : extra)]);
    const d = req.data;
    if (!access.validUid(d.target_uid)) fail('invalid-argument', 'Invalid target');
    employee(d.employee_number);
    try { monthKey(d.month); } catch (_) { fail('invalid-argument', 'Invalid month'); }
    if (!hr && ctx.uid !== d.target_uid) fail('permission-denied', 'Only your own correction history is available');
    const authTime = req.auth.token.auth_time;
    if (!Number.isSafeInteger(authTime) || authTime < 0 || !Number.isSafeInteger(authTime * 1000)) fail('unauthenticated', 'Refresh sign-in');
    if (mode === 'list' && own(d, 'cursor') && (typeof d.cursor !== 'string' || !EVENT_ID.test(d.cursor))) fail('invalid-argument', 'Invalid cursor');
    if (mode === 'get' && (typeof d.event_id !== 'string' || !EVENT_ID.test(d.event_id))) fail('invalid-argument', 'Invalid event id');
    const r = { ctx, hr, authTime, target: d.target_uid, emp: d.employee_number, month: d.month, data: d };
    if (mode === 'reopen') {
      if (typeof d.request_id !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(d.request_id)) fail('invalid-argument', 'Invalid request id');
      if (!Array.isArray(d.days) || d.days.length > LIMITS.days) fail('invalid-argument', 'At most 31 rows are allowed');
      const days = d.days.map(v => { shape(v, ['date', 'expected_version']); return { date: date(v.date, r.month), expected_version: version(v.expected_version) }; })
        .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      if (new Set(days.map(v => v.date)).size !== days.length) fail('invalid-argument', 'Duplicate dates');
      r.intent = { station_id: ctx.sid, actor_uid: ctx.uid, target_uid: r.target, employee_number: r.emp,
        month: r.month, expected_report_version: version(d.expected_report_version, true), days, reason: reason(d.reason) };
      r.id = hash(['attendance-reopen-v1', ctx.sid, ctx.uid, d.request_id]);
      r.fingerprint = hash(r.intent);
    }
    return r;
  }
  async function live(tx, r) {
    let user;
    try { user = await auth.getUser(r.ctx.uid); }
    catch (e) { fail(e && e.code === 'auth/user-not-found' ? 'permission-denied' : 'unavailable', 'Current authentication unavailable'); }
    const c = user && user.customClaims;
    if (!user || user.uid !== r.ctx.uid || user.disabled === true || !plain(c)
        || c.stationId !== r.ctx.sid || (c.super === true) !== r.ctx.super || (!r.ctx.super && c.role !== r.ctx.role)) fail('permission-denied', 'Current authority changed');
    if (own(user, 'tokensValidAfterTime')) {
      const at = typeof user.tokensValidAfterTime === 'string' ? Date.parse(user.tokensValidAfterTime) : NaN;
      if (!Number.isFinite(at)) fail('unavailable', 'Revocation state invalid');
      if (r.authTime * 1000 < at) fail('permission-denied', 'Sign-in revoked');
    }
    await identity.requireLive(tx, r.ctx);
    return typeof user.displayName === 'string' && user.displayName.length <= 500 ? user.displayName : r.ctx.uid;
  }
  async function target(tx, r) {
    const s = await tx.get(db.collection('stations').doc(r.ctx.sid).collection('users').doc(r.target));
    const p = s.exists ? s.data() : null;
    if (!plain(p) || !access.liveStation(p).ok || access.liveStation(p).stationId !== r.ctx.sid
        || !matchesEmployee(p.employee_number, r.emp) || !TARGET_ROLES.includes(p.role)
        || (own(p, 'uid') && p.uid !== r.target)
        || ['active', 'is_active'].some(k => own(p, k) && typeof p[k] !== 'boolean')) corrupt('Canonical employee binding unavailable');
    const inactive = p.active === false || p.is_active === false;
    if (!inactive) {
      const [index, directory] = await Promise.all([tx.get(db.collection('emp_index').doc(r.emp)), tx.get(db.collection('directory').doc(r.target))]);
      const i = index.exists ? index.data() : null, d = directory.exists ? directory.data() : null;
      if (!plain(i) || i.uid !== r.target || i.stationId !== r.ctx.sid || i.active === false || i.retired === true || i.status === 'retired'
          || !access.activeMember(d, r.ctx.sid) || (own(d, 'uid') && d.uid !== r.target)
          || (own(d, 'employee_number') && !matchesEmployee(d.employee_number, r.emp))) corrupt('Active employee binding unavailable');
    }
    return { version: token(s), inactive, role: p.role,
      full_name: typeof p.full_name === 'string' ? p.full_name : '', crew: typeof p.crew === 'string' ? p.crew : '' };
  }
  function root(r) { return db.collection('stations').doc(r.ctx.sid); }
  function boundRow(v, r, day) {
    if (!plain(v) || !matchesEmployee(v.emp_number, r.emp) || v.month !== r.month
        || (own(v, 'uid') && v.uid !== r.target) || (day && v.date !== day)) corrupt('Stored identity mismatch');
  }
  async function month(tx, r) {
    const [report, found] = await Promise.all([
      tx.get(root(r).collection('monthly_reports').doc(r.emp + '_' + r.month)),
      tx.get(root(r).collection('attendance').where('emp_number', '==', r.emp).where('month', '==', r.month).limit(LIMITS.days + 1))
    ]);
    if (!Array.isArray(found.docs) || found.docs.length > LIMITS.days) corrupt('Month has too many rows');
    if (report.exists) boundRow(report.data(), r);
    const seen = new Set();
    const rows = found.docs.map(s => {
      const v = s.data(); boundRow(v, r);
      let key;
      try { key = date(v.date, r.month); } catch (_) { corrupt('Stored day invalid'); }
      if (s.id !== r.emp + '_' + key || seen.has(key)) corrupt('Noncanonical or duplicate attendance day');
      seen.add(key);
      return { snap: s, value: v, date: key, expected_version: token(s) };
    }).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    return { report, rows };
  }
  // A stored preimage is NOT a new patch. Preserve bounded legacy scalar/null
  // values faithfully (for example null day offsets); the mutation service
  // still validates new patch fields strictly. Never project arbitrary trees.
  function historicalScalar(v) {
    return v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
      || (typeof v === 'string' && v.length <= LIMITS.text);
  }
  function rowDto(value) {
    const result = {};
    for (const k of FIELDS) if (own(value, k)) {
      if (!historicalScalar(value[k])) corrupt('Stored display field invalid');
      result[k] = value[k];
    }
    return result;
  }
  function bounded(v) {
    if (Buffer.byteLength(JSON.stringify(v), 'utf8') > LIMITS.bytes) fail('resource-exhausted', 'Bounded response or evidence is too large');
    return v;
  }
  function reopeningValid(report, at) {
    if (!report || !access.validUid(report.reopened_by)) return false;
    const reopened = millis(report.reopened_at), approved = own(report, 'approved_at') ? millis(report.approved_at) : null;
    return Number.isFinite(reopened) && reopened >= 0 && reopened <= at
      && (approved === null || (Number.isFinite(approved) && approved < reopened));
  }
  function canCorrectRow(row, report, person, at) {
    return !!(report && ['draft', 'submitted'].includes(report.status)
      && (!own(row, 'status') || ['draft', 'submitted', 'imported'].includes(row.status))
      && (!(person.inactive || row.status === 'imported') || reopeningValid(report, at)));
  }
  function eligibility(m, person, at, r) {
    const v = m.report.exists ? m.report.data() : null;
    const imported = m.rows.some(row => row.value.status === 'imported');
    const historical = person.inactive || imported;
    const supportedRows = m.rows.every(row => !own(row.value, 'status') || ['draft', 'submitted', 'approved', 'imported'].includes(row.value.status));
    const opened = reopeningValid(v, at), editableReport = v && ['draft', 'submitted'].includes(v.status);
    let current = false;
    if (!v) { try { current = monthKey(monthAt(at)) === r.month; } catch (_) { corrupt('Trusted month unavailable'); } }
    return {
      can_create: !person.inactive && !!(editableReport || (!v && current)),
      can_recalculate: m.rows.length > 0 && m.rows.every(row => canCorrectRow(row.value, v, person, at)),
      can_reopen: supportedRows && !!((v && v.status === 'approved') || (historical && m.rows.length && (!v || ['draft', 'submitted'].includes(v.status)))),
      historical, reopening_valid: opened
    };
  }
  async function read(req, mode, load) {
    const r = request(req, mode);
    let original;
    const response = await db.runTransaction(async tx => {
      await live(tx, r); original = await target(tx, r);
      return bounded(await load(tx, r, original));
    });
    if (typeof hooks.beforeFinalize === 'function') await hooks.beforeFinalize({ mode });
    await db.runTransaction(async tx => {
      await live(tx, r);
      if (!same(original, await target(tx, r))) fail('aborted', 'Employee changed during read');
    });
    return response;
  }
  function getContext(req) {
    return read(req, 'context', async (tx, r, person) => {
      const m = await month(tx, r), at = now(), v = m.report.exists ? m.report.data() : null;
      const days = m.rows.map(row => ({ date: row.date, record_id: row.snap.id, expected_version: row.expected_version,
        record: rowDto(row.value), can_correct: canCorrectRow(row.value, v, person, at) }));
      const last = new Date(r.month + '-01T00:00:00Z'); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
      const existing = new Set(days.map(row => row.date));
      return { station_id: r.ctx.sid, target_uid: r.target, employee_number: r.emp, month: r.month,
        target: { full_name: person.full_name, crew: person.crew, role: person.role, inactive: person.inactive },
        report: { exists: !!v, status: v && typeof v.status === 'string' ? v.status : null, expected_version: token(m.report) },
        days, missing_dates: Array.from({ length: last.getUTCDate() }, (_, i) => r.month + '-' + String(i + 1).padStart(2, '0')).filter(day => !existing.has(day)),
        eligibility: eligibility(m, person, at, r), snapshot_at_ms: at };
    });
  }
  // Encoding is deliberately compatible with existing correction events, while
  // the reopen subtype has a separate schema/id namespace and report evidence.
  function evidence(v, commit, depth = 0) {
    if (depth > 20) fail('resource-exhausted', 'Evidence nesting exceeds limit');
    if (v === commit) return { type: 'commit_timestamp' };
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return { type: typeof v, value: v };
    if (typeof v === 'number' && Number.isFinite(v)) return { type: 'number', value: v };
    if (Array.isArray(v)) return { type: 'array', value: v.map(x => evidence(x, commit, depth + 1)) };
    if (plain(v)) return { type: 'map', value: Object.keys(v).sort().map(key => ({ key, value: evidence(v[key], commit, depth + 1) })) };
    if (v && typeof v.toDate === 'function' && Number.isFinite(millis(v))) return { type: 'timestamp', seconds: v.seconds, nanoseconds: v.nanoseconds };
    corrupt('Stored evidence cannot be represented without loss');
  }
  async function reopen(req) {
    const r = request(req, 'reopen'), ref = root(r);
    const eventRef = ref.collection(COLLECTIONS.events).doc(r.id), receiptRef = ref.collection(COLLECTIONS.receipts).doc(r.id);
    return db.runTransaction(async tx => {
      await live(tx, r); const person = await target(tx, r), prior = await tx.get(receiptRef);
      if (prior.exists) {
        const v = prior.data(), e = await tx.get(eventRef);
        if (!plain(v) || v.schema !== 'attendance-reopen-receipt-v1' || v.reopen_id !== r.id
            || v.station_id !== r.ctx.sid || v.actor_uid !== r.ctx.uid || v.request_id !== r.data.request_id) corrupt('Invalid reopen receipt');
        if (v.fingerprint !== r.fingerprint || v.target_uid !== r.target || v.employee_number !== r.emp || v.month !== r.month) fail('already-exists', 'Request id reused for another intent');
        if (!e.exists || e.data().schema !== 'attendance-reopen-event-v1' || e.data().fingerprint !== r.fingerprint
            || e.data().correction_id !== r.id || !Number.isInteger(v.attendance_changed_count) || v.attendance_changed_count < 0 || v.attendance_changed_count > LIMITS.days
            || typeof v.created_report !== 'boolean') corrupt('Incomplete reopen evidence');
        await live(tx, r); if (!same(person, await target(tx, r))) fail('aborted', 'Employee changed during replay');
        return { reopen_id: r.id, outcome: 'recorded', attendance_changed_count: v.attendance_changed_count,
          created_report: v.created_report, notification_status: 'not_enqueued', duplicate: true };
      }
      const m = await month(tx, r);
      if (!same(token(m.report), r.intent.expected_report_version)
          || !same(m.rows.map(row => ({ date: row.date, expected_version: row.expected_version })), r.intent.days)) fail('aborted', 'Month changed; reload before reopening');
      if (typeof hooks.beforeWrites === 'function') await hooks.beforeWrites({ stage: 'reopen' });
      const actorName = await live(tx, r), finalPerson = await target(tx, r), at = now();
      if (!same(person, finalPerson)) fail('aborted', 'Employee changed before reopening');
      if (!eligibility(m, person, at, r).can_reopen) corrupt('Report does not have a valid reopening route');
      const beforeReport = m.report.exists ? m.report.data() : null;
      if (beforeReport && own(beforeReport, 'approved_at')
          && (!Number.isFinite(millis(beforeReport.approved_at)) || millis(beforeReport.approved_at) >= at)) corrupt('Approval chronology is invalid');
      const commit = serverTimestamp();
      if (commit === null || commit === undefined || (typeof commit !== 'object' && typeof commit !== 'function')) corrupt('Commit timestamp unavailable');
      // Empty declared days and unknown total satisfy the existing HR reader,
      // without copying attendance into an employee declaration. The marker is
      // provenance only, NEVER authority or a substitute for employee consent.
      const afterReport = { ...(beforeReport || { uid: r.target, emp_number: r.emp, month: r.month, full_name: person.full_name, crew: person.crew,
        days: [], total_hours: null, generated_for_correction: true }),
        status: 'draft', reopened_by: r.ctx.uid, reopened_by_name: actorName, reopened_at: commit, updated_at: commit };
      const changes = m.rows.map(row => {
        const changed = row.value.status === 'approved';
        const after = changed ? { ...row.value, status: 'draft', edited_by: r.ctx.uid, edited_by_name: actorName, edited_at: commit, updated_at: commit } : row.value;
        return { row, changed, after };
      });
      const event = { schema: 'attendance-reopen-event-v1', correction_id: r.id, station_id: r.ctx.sid, actor_uid: r.ctx.uid,
        actor_name: actorName, actor_role: r.ctx.role, actor_auth_time: r.authTime, target_uid: r.target, employee_number: r.emp,
        month: r.month, operation: 'reopen', reason: r.intent.reason, request_id: r.data.request_id, fingerprint: r.fingerprint,
        created_at_ms: at, committed_at: commit, evidence_encoding: 'tagged-firestore-v2',
        report_change: { before_version: token(m.report), before: evidence(beforeReport, commit), after: evidence(afterReport, commit) },
        changes: changes.map(({ row, after }) => ({ date: row.date, record_id: row.snap.id,
          before_version: row.expected_version, before: evidence(row.value, commit), after: evidence(after, commit) })) };
      bounded({ ...event, committed_at: { type: 'commit_timestamp' } });
      const result = { reopen_id: r.id, outcome: 'recorded', attendance_changed_count: changes.filter(x => x.changed).length,
        created_report: !m.report.exists, notification_status: 'not_enqueued', duplicate: false };
      tx.set(m.report.ref, afterReport);
      changes.forEach(({ row, after, changed }) => { if (changed) tx.set(row.snap.ref, after); });
      tx.create(eventRef, event);
      tx.create(receiptRef, { schema: 'attendance-reopen-receipt-v1', reopen_id: r.id, station_id: r.ctx.sid, actor_uid: r.ctx.uid,
        target_uid: r.target, employee_number: r.emp, month: r.month, request_id: r.data.request_id, fingerprint: r.fingerprint,
        attendance_changed_count: result.attendance_changed_count, created_report: result.created_report });
      return result;
    });
  }
  function eventHeader(snap, r) {
    const v = snap.exists ? snap.data() : null;
    if (!plain(v) || !EVENT_ID.test(snap.id) || v.correction_id !== snap.id || v.station_id !== r.ctx.sid
        || v.target_uid !== r.target || v.employee_number !== r.emp || v.month !== r.month
        || !access.validUid(v.actor_uid) || typeof v.actor_name !== 'string' || v.actor_name.length > 500
        || !Number.isSafeInteger(v.created_at_ms) || v.created_at_ms < 0 || v.evidence_encoding !== 'tagged-firestore-v2'
        || !Array.isArray(v.changes) || v.changes.length > LIMITS.days) corrupt('Audit event binding invalid');
    if ((v.schema === 'attendance-correction-event-v1' && !['create', 'update', 'delete', 'recalculate'].includes(v.operation))
        || (v.schema === 'attendance-reopen-event-v1' && v.operation !== 'reopen')
        || !['attendance-correction-event-v1', 'attendance-reopen-event-v1'].includes(v.schema)) corrupt('Unknown audit event subtype');
    if (v.schema === 'attendance-correction-event-v1' && !v.changes.length) corrupt('Empty correction event');
    let why; try { why = reason(v.reason); } catch (_) { corrupt('Invalid audit reason'); }
    if (why !== v.reason) corrupt('Noncanonical audit reason');
    const seen = new Set();
    const dates = v.changes.map(change => {
      if (!plain(change)) corrupt('Invalid audit change');
      let key; try { key = date(change.date, r.month); } catch (_) { corrupt('Invalid audit date'); }
      if (change.record_id !== r.emp + '_' + key || seen.has(key)) corrupt('Invalid audit row identity');
      seen.add(key); return key;
    });
    return { event: v, dto: { event_id: snap.id, operation: v.operation, actor_uid: v.actor_uid, actor_name: v.actor_name,
      created_at_ms: v.created_at_ms, reason: v.reason, dates } };
  }
  // Project ONLY known business scalar fields out of tagged maps. Do not decode
  // unknown legacy trees, timestamps, config, auth data or whole raw documents.
  function projectedEvidence(value, report = false) {
    if (plain(value) && value.type === 'object' && value.value === null) return null; // Existing encoder's typeof null.
    if (!plain(value) || value.type !== 'map' || !Array.isArray(value.value)) corrupt('Invalid audit evidence map');
    const result = {}, seen = new Set(), allowed = report ? ['status'] : FIELDS;
    for (const entry of value.value) {
      if (!plain(entry) || Reflect.ownKeys(entry).length !== 2 || !own(entry, 'key') || !own(entry, 'value')
          || !own(Object.getOwnPropertyDescriptor(entry, 'key'), 'value') || !own(Object.getOwnPropertyDescriptor(entry, 'value'), 'value')
          || typeof entry.key !== 'string' || seen.has(entry.key)) corrupt('Invalid audit evidence key');
      const k = entry.key, v = entry.value; seen.add(k);
      if (!allowed.includes(k)) continue;
      if (!plain(v) || (!['string', 'number', 'boolean'].includes(v.type) && !(v.type === 'object' && v.value === null))
          || typeof v.value !== v.type || !historicalScalar(v.value)) corrupt('Invalid audit business value');
      result[k] = v.value;
    }
    return result;
  }
  function listAudit(req) {
    return read(req, 'list', async (tx, r) => {
      const events = root(r).collection(COLLECTIONS.events);
      let query = events.where('target_uid', '==', r.target).where('month', '==', r.month).orderBy('__name__');
      if (r.data.cursor) { eventHeader(await tx.get(events.doc(r.data.cursor)), r); query = query.startAfter(r.data.cursor); }
      const found = await tx.get(query.limit(LIMITS.page + 1));
      if (!Array.isArray(found.docs) || found.docs.length > LIMITS.page + 1) corrupt('Invalid audit page');
      const page = found.docs.slice(0, LIMITS.page);
      return { station_id: r.ctx.sid, target_uid: r.target, employee_number: r.emp, month: r.month,
        items: page.map(snap => eventHeader(snap, r).dto), next_cursor: found.docs.length > LIMITS.page ? page.at(-1).id : null };
    });
  }
  function getAudit(req) {
    return read(req, 'get', async (tx, r) => {
      const snap = await tx.get(root(r).collection(COLLECTIONS.events).doc(r.data.event_id));
      if (!snap.exists) fail('not-found', 'Audit event unavailable');
      const { event, dto } = eventHeader(snap, r);
      const result = { ...dto, station_id: r.ctx.sid, target_uid: r.target, employee_number: r.emp, month: r.month,
        changes: event.changes.map(change => ({ date: change.date, before: projectedEvidence(change.before), after: projectedEvidence(change.after) })) };
      if (event.schema === 'attendance-reopen-event-v1') {
        if (!plain(event.report_change)) corrupt('Reopen report evidence unavailable');
        result.report_change = { before: projectedEvidence(event.report_change.before, true), after: projectedEvidence(event.report_change.after, true) };
      }
      return result;
    });
  }
  return Object.freeze({ getContext, reopen, listAudit, getAudit });
}

module.exports = Object.freeze({ createAttendanceCorrectionSupport, LIMITS, FIELDS });
