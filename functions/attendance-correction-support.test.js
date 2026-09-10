'use strict';
// Actual support + correction factories and calculator. Strict optimistic,
// atomic in-memory transaction double and synthetic Auth/timestamps only.
// No native Firestore, real Auth, callable, trigger, FCM, network or file writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAttendanceCorrectionSupport, LIMITS, FIELDS } = require('./attendance-correction-support');
const { createAttendanceCorrections, COLLECTIONS } = require('./attendance-corrections');
const { calculateAttendanceDerived } = require('./attendance-hours-calculator');
const { projectEmployeeHours } = require('./hr-hours-model');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toDate() { return new Date(this.seconds * 1000 + this.nanoseconds / 1e6); }
}
class ServerTimestamp {}
const NOW = Date.parse('2026-09-09T09:00:00Z');
const stamp = ms => new Timestamp(Math.floor(ms / 1000), ms % 1000 * 1e6);
function copy(v) {
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (v instanceof ServerTimestamp) return new ServerTimestamp();
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, copy(value)]));
  return v;
}
function materialize(v) {
  if (v instanceof ServerTimestamp) return stamp(NOW);
  if (v instanceof Timestamp || Buffer.isBuffer(v)) return copy(v);
  if (Array.isArray(v)) return v.map(materialize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, materialize(value)]));
  return v;
}
function decode(v) {
  if (v.type === 'map') return Object.fromEntries(v.value.map(({ key, value }) => [key, decode(value)]));
  if (v.type === 'array') return v.value.map(decode);
  if (v.type === 'timestamp') return new Timestamp(v.seconds, v.nanoseconds);
  if (v.type === 'commit_timestamp') return 'COMMIT';
  return v.value;
}
function memoryDb() {
  const state = new Map(); let serial = 1;
  class Ref {
    constructor(path) { this.path = path; this.id = path.split('/').at(-1); }
    collection(name) { return new Query(this.path + '/' + name); }
  }
  class Query {
    constructor(path, filters = [], cap = Infinity, after = null) { Object.assign(this, { path, filters, cap, after }); }
    doc(id) { return new Ref(this.path + '/' + id); }
    where(key, op, value) { assert.equal(op, '=='); return new Query(this.path, [...this.filters, [key, value]], this.cap, this.after); }
    orderBy(key) { assert.equal(key, '__name__'); return new Query(this.path, this.filters, this.cap, this.after); }
    startAfter(id) { assert.equal(typeof id, 'string'); return new Query(this.path, this.filters, this.cap, id); }
    limit(cap) { return new Query(this.path, this.filters, cap, this.after); }
  }
  function snap(ref) {
    const e = state.get(ref.path);
    return { id: ref.id, ref, exists: !!e, updateTime: e ? new Timestamp(e.version, 123456789) : undefined,
      data: () => e ? copy(e.value) : undefined };
  }
  const metrics = { commits: 0, writes: 0, retries: 0, reads: [] };
  const db = {
    collection: name => new Query(name), metrics, failRead: null, failWrite: null,
    seed(path, value) { serial++; if (value === undefined) state.delete(path); else state.set(path, { value: copy(value), version: serial }); },
    value(path) { return state.has(path) ? copy(state.get(path).value) : null; },
    version(path) { return state.has(path) ? { seconds: state.get(path).version, nanoseconds: 123456789 } : 'absent'; },
    entries(collection) { return [...state].filter(([p]) => p.includes('/' + collection + '/')).map(([path, e]) => ({ path, value: copy(e.value) })); },
    dump() { return copy([...state]); },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const reads = new Map(), writes = []; let querySerial = null;
        const tx = {
          async get(ref) {
            assert.equal(writes.length, 0, 'Actual service must finish all reads before writes');
            metrics.reads.push({ path: ref.path, query: ref instanceof Query, filters: ref.filters, cap: ref.cap });
            if (db.failRead?.(ref.path)) throw new HttpsError('unavailable', 'Synthetic database outage');
            if (ref instanceof Query) {
              querySerial = serial;
              const docs = [...state].filter(([p, e]) => p.startsWith(ref.path + '/') && p.split('/').length === ref.path.split('/').length + 1
                && ref.filters.every(([k, value]) => e.value[k] === value) && (ref.after === null || p.split('/').at(-1) > ref.after))
                .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, ref.cap).map(([p]) => snap(new Ref(p)));
              docs.forEach(s => reads.set(s.ref.path, state.get(s.ref.path).version));
              return { docs };
            }
            reads.set(ref.path, state.get(ref.path)?.version || 0); return snap(ref);
          },
          set(ref, value) { queue('set', ref, value); },
          create(ref, value) { queue('create', ref, value); },
          delete(ref) { queue('delete', ref); }
        };
        function queue(op, ref, value) {
          // Models this specific native serialization constraint; it does not
          // make this double a substitute for actual Firestore transactions.
          function noNestedArrays(v, arrayParent = false) {
            if (Array.isArray(v)) { assert.equal(arrayParent, false, 'Firestore cannot store directly nested arrays'); v.forEach(x => noNestedArrays(x, true)); }
            else if (v && typeof v === 'object') Object.values(v).forEach(x => noNestedArrays(x, false));
          }
          if (op !== 'delete') noNestedArrays(value);
          writes.push({ op, path: ref.path, value: copy(value) });
          if (db.failWrite?.(ref.path)) throw new HttpsError('unavailable', 'Synthetic queued-write failure');
        }
        const result = await fn(tx);
        if ((querySerial !== null && querySerial !== serial) || [...reads].some(([p, v]) => (state.get(p)?.version || 0) !== v)) { metrics.retries++; continue; }
        for (const w of writes) if (w.op === 'create' && state.has(w.path)) throw new HttpsError('already-exists', 'Collision');
        for (const w of writes) { serial++; if (w.op === 'delete') state.delete(w.path); else state.set(w.path, { value: materialize(w.value), version: serial }); }
        if (writes.length) { metrics.writes += writes.length; metrics.commits++; }
        return result;
      }
      throw new HttpsError('aborted', 'Synthetic transaction exhausted');
    }
  };
  return db;
}
function fixture() {
  const db = memoryDb(), sid = 'support_station', actor = 'hr_actor', uid = 'employee_A', emp = '1001', month = '2026-09';
  const root = 'stations/' + sid, path = date => root + '/attendance/' + emp + '_' + date;
  const reportPath = root + '/monthly_reports/' + emp + '_' + month;
  const profile = (role, n) => ({ stationId: sid, role, employee_number: n, active: true, full_name: 'Local Name', crew: 'A' });
  db.seed(root + '/users/' + actor, profile('hr_coordinator', '9001'));
  db.seed(root + '/users/' + uid, profile('firefighter', emp));
  db.seed('directory/' + uid, profile('firefighter', emp));
  db.seed('emp_index/' + emp, { uid, stationId: sid, active: true });
  db.seed(reportPath, { uid, emp_number: emp, month, status: 'approved', approved_at: stamp(NOW - 5000),
    approved_by: 'previous_commander', submitted_at: stamp(NOW - 10000), total_hours: 77,
    days: [month + '-01'], declaration: 'existing employee statement', legacy_report: { keep: true } });
  function row(date = month + '-01', patch = {}) {
    db.seed(path(date), { uid, emp_number: emp, month, date, status: 'approved', day_type: 'regular', shape: 'regular',
      start: '08:00', end: '16:00', end_day: 0, sub_station: '', hours: 8, day_type_he: 'רגיל', site_name: '',
      reason_required: false, overtime_reason: '', notes: 'existing notes', legacy_secret: { password: 'NEVER_RETURN' }, ...patch });
  }
  row();
  const records = new Map([actor, uid].map(id => [id, { uid: id, disabled: false, displayName: id === actor ? 'Fresh HR Actor' : 'Employee',
    tokensValidAfterTime: new Date(0).toISOString(), customClaims: { stationId: sid, role: id === actor ? 'hr_coordinator' : 'firefighter' } }]));
  const auth = { async getUser(id) { if (!records.has(id)) throw Object.assign(new Error('missing'), { code: 'auth/user-not-found' }); return copy(records.get(id)); } };
  let time = NOW;
  const ports = { db, auth, HttpsError, serverTimestamp: () => new ServerTimestamp(), clock: () => time,
    monthAt: () => month, hooks: {} };
  const api = () => createAttendanceCorrectionSupport(ports);
  function req(extra = {}, who = actor) {
    return { auth: { uid: who, token: { ...records.get(who)?.customClaims, auth_time: NOW / 1000 - 100 } },
      data: { target_uid: uid, employee_number: emp, month, ...extra } };
  }
  function reopenReq(extra = {}) {
    const days = db.entries('attendance').map(({ value }) => ({ date: value.date, expected_version: db.version(path(value.date)) })).sort((a, b) => a.date.localeCompare(b.date));
    return req({ expected_report_version: db.version(reportPath), days,
      request_id: 'reopen_request_0001', reason: 'An explicit authorized reopening reason', ...extra });
  }
  function inactive() {
    db.seed(root + '/users/' + uid, { ...db.value(root + '/users/' + uid), active: false });
    db.seed('directory/' + uid, { stationId: 'other_station', employee_number: emp, full_name: 'NOT_OLD_TARGET' });
    db.seed('emp_index/' + emp, { stationId: 'other_station', uid });
  }
  function correctionApi() {
    return createAttendanceCorrections({ ...ports, readConfig: async () => ({ siteById: {}, shiftHours: 24 }), calculate: calculateAttendanceDerived });
  }
  async function correct(operation = 'delete', requestId = 'correction_0001') {
    const q = req({ operation, date: month + '-01', expected_version: db.version(path(month + '-01')),
      reason: 'The authorized content correction reason', request_id: requestId,
      ...(operation === 'delete' ? {} : { patch: { end: '17:00' } }) });
    return correctionApi().correctOneDay(q);
  }
  return { db, sid, actor, uid, emp, month, root, path, reportPath, records, ports, api, req, reopenReq, row, inactive, correct, correctionApi,
    time: v => { time = v; }, events: () => db.entries(COLLECTIONS.events), receipts: () => db.entries(COLLECTIONS.receipts), jobs: () => db.entries(COLLECTIONS.jobs) };
}
async function noWrites(f, fn, code) {
  const before = f.db.dump();
  await assert.rejects(fn(), e => e.code === code);
  assert.deepEqual(f.db.dump(), before, 'Failure must not commit queued writes');
}

test('factory requires safe injected ports and performs no reads or writes at construction', () => {
  const f = fixture();
  for (const name of ['db', 'auth', 'HttpsError', 'serverTimestamp', 'clock', 'monthAt']) assert.throws(() => createAttendanceCorrectionSupport({ ...f.ports, [name]: null }), TypeError);
  assert.deepEqual(Object.keys(f.api()), ['getContext', 'reopen', 'listAudit', 'getAudit']);
  assert.equal(f.db.metrics.reads.length, 0); assert.equal(f.db.metrics.writes, 0);
});
test('context binds actual preimage and exact nanosecond version; no legacy secrets or writes', async () => {
  const f = fixture(), v = f.db.version(f.path(f.month + '-01'));
  const context = await f.api().getContext(f.req());
  assert.deepEqual(context.days[0].expected_version, v); assert.equal(context.days[0].record.hours, 8);
  assert.equal(context.report.status, 'approved'); assert.equal(context.eligibility.can_reopen, true);
  assert.equal(context.eligibility.can_recalculate, false); assert.equal(context.days[0].can_correct, false); assert.equal(context.missing_dates.length, 29);
  assert.ok(!JSON.stringify(context).includes('NEVER_RETURN')); assert.equal(f.db.metrics.writes, 0);
  assert.ok(f.db.metrics.reads.some(r => r.path.endsWith('/attendance') && r.cap === 32));
  context.days[0].record.hours = 99; assert.equal(f.db.value(f.path(f.month + '-01')).hours, 8);
});
test('context data remains coherent old snapshot if content changes before final ACL; old CAS then fails', async () => {
  const f = fixture(); let once = true;
  f.ports.hooks.beforeFinalize = () => { if (once) { once = false; f.row(undefined, { hours: 9 }); } };
  const context = await f.api().getContext(f.req());
  assert.equal(context.days[0].record.hours, 8); assert.equal(f.db.value(f.path(f.month + '-01')).hours, 9);
  const q = f.reopenReq({ days: context.days.map(({ date, expected_version }) => ({ date, expected_version })) });
  await noWrites(f, () => f.api().reopen(q), 'aborted');
});
test('context rejects duplicate/noncanonical IDs, overflow and malformed identity instead of returning create authority', async () => {
  for (const kind of ['alias', 'uid', 'month', 'overflow']) {
    const f = fixture();
    if (kind === 'alias') f.db.seed(f.root + '/attendance/old_alias', f.db.value(f.path(f.month + '-01')));
    if (kind === 'uid') f.row(undefined, { uid: null });
    if (kind === 'month') f.row(undefined, { date: '2026-09-31' });
    if (kind === 'overflow') for (let i = 0; i < 32; i++) f.db.seed(f.root + '/attendance/alias_' + i, { emp_number: f.emp, month: f.month });
    await noWrites(f, () => f.api().getContext(f.req()), 'failed-precondition');
  }
});
test('legacy absent UID and station aliases accepted, present invalid UID and nonfinite employee rejected', async () => {
  const f = fixture(), p = f.db.value(f.root + '/users/' + f.uid); delete p.stationId;
  f.db.seed(f.root + '/users/' + f.uid, { ...p, station_id: ' ' + f.sid + ' ' });
  const r = f.db.value(f.path(f.month + '-01')); delete r.uid; f.db.seed(f.path(f.month + '-01'), r);
  const m = f.db.value(f.reportPath); delete m.uid; f.db.seed(f.reportPath, m);
  assert.equal((await f.api().getContext(f.req())).days.length, 1);
  for (const n of [NaN, Infinity]) {
    const g = fixture(); g.db.seed(g.root + '/users/' + g.uid, { ...g.db.value(g.root + '/users/' + g.uid), employee_number: n });
    await noWrites(g, () => g.api().getContext(g.req({ employee_number: String(n) })), 'failed-precondition');
  }
});
test('own ordinary employee may read audit only; commander/role-super/string-super do not gain HR correction authority', async () => {
  const f = fixture();
  assert.deepEqual((await f.api().listAudit(f.req({}, f.uid))).items, []);
  await noWrites(f, () => f.api().getContext(f.req({}, f.uid)), 'permission-denied');
  await noWrites(f, () => f.api().reopen({ ...f.reopenReq(), auth: f.req({}, f.uid).auth }), 'permission-denied');
  for (const claims of [{ role: 'commander' }, { role: 'super_admin' }, { role: 'firefighter', super: 'true' }]) {
    const g = fixture(); g.records.get(g.actor).customClaims = { stationId: g.sid, ...claims };
    await noWrites(g, () => g.api().getContext(g.req()), 'permission-denied');
  }
});
test('signed super retains station scope without a local actor profile', async () => {
  const f = fixture(); f.records.get(f.actor).customClaims = { stationId: f.sid, super: true };
  f.db.seed(f.root + '/users/' + f.actor, undefined);
  assert.equal((await f.api().getContext(f.req())).target_uid, f.uid);
  const result = await f.api().reopen(f.reopenReq()); assert.equal(result.outcome, 'recorded');
  await noWrites(f, () => f.api().getContext({ ...f.req(), auth: { ...f.req().auth, token: { super: true, auth_time: NOW / 1000 } } }), 'failed-precondition');
});
test('closed requests reject station/caller-derived fields and malformed replay/CAS inputs', async () => {
  const f = fixture();
  for (const extra of [{ station_id: f.sid }, { role: 'hr_coordinator' }, { hours: 99 }, { cursor: null }]) {
    await noWrites(f, () => f.api().getContext(f.req(extra)), 'invalid-argument');
  }
  for (const extra of [{ reason: 'short' }, { request_id: 'x' }, { days: [...f.reopenReq().data.days, ...f.reopenReq().data.days] },
    { expected_report_version: { seconds: 1, nanoseconds: 1e9 } }, { days: Array(32).fill(f.reopenReq().data.days[0]) }]) {
    await noWrites(f, () => f.api().reopen(f.reopenReq(extra)), 'invalid-argument');
  }
});
test('disabled/revoked/malformed fresh Auth fails for context and audit', async () => {
  for (const patch of [{ disabled: true }, { tokensValidAfterTime: new Date(NOW + 1).toISOString() }, { tokensValidAfterTime: 'invalid' }]) {
    const f = fixture(); Object.assign(f.records.get(f.actor), patch);
    await noWrites(f, () => f.api().getContext(f.req()), patch.tokensValidAfterTime === 'invalid' ? 'unavailable' : 'permission-denied');
  }
  const f = fixture(); const q = f.req(); delete q.auth.token.auth_time;
  await noWrites(f, () => f.api().listAudit(q), 'unauthenticated');
});
test('final read ACL fence rejects role changes in context and audit reads', async () => {
  for (const mode of ['context', 'list']) {
    const f = fixture(); f.ports.hooks.beforeFinalize = () => { f.records.get(f.actor).customClaims.role = 'firefighter'; };
    await noWrites(f, () => mode === 'context' ? f.api().getContext(f.req()) : f.api().listAudit(f.req()), 'permission-denied');
  }
});
test('approved reopen atomically changes locks/report and records full evidence, not content or consent', async () => {
  const f = fixture(), beforeReport = f.db.value(f.reportPath), beforeRow = f.db.value(f.path(f.month + '-01'));
  const result = await f.api().reopen(f.reopenReq());
  assert.deepEqual(result, { reopen_id: result.reopen_id, outcome: 'recorded', attendance_changed_count: 1, created_report: false, notification_status: 'not_enqueued', duplicate: false });
  const after = f.db.value(f.reportPath), row = f.db.value(f.path(f.month + '-01'));
  assert.equal(after.status, 'draft'); assert.equal(after.reopened_by, f.actor); assert.equal(after.reopened_by_name, 'Fresh HR Actor');
  for (const key of ['approved_at', 'approved_by', 'submitted_at', 'declaration', 'days', 'total_hours', 'legacy_report']) assert.deepEqual(after[key], beforeReport[key]);
  assert.equal(own(after, 'generated_for_correction'), false, 'Existing reports do not acquire a synthetic-origin marker');
  assert.equal(row.status, 'draft'); assert.equal(row.hours, beforeRow.hours); assert.deepEqual(row.legacy_secret, beforeRow.legacy_secret);
  assert.equal(f.db.metrics.commits, 1); assert.equal(f.events().length, 1); assert.equal(f.receipts().length, 1); assert.equal(f.jobs().length, 0);
  const event = f.events()[0].value;
  assert.deepEqual(decode(event.report_change.before), beforeReport); assert.deepEqual(decode(event.changes[0].before), beforeRow);
  assert.equal(decode(event.changes[0].after).status, 'draft'); assert.equal(event.schema, 'attendance-reopen-event-v1');
  assert.ok(!own(event, 'calculation_config'));
});
const own = (v, key) => Object.prototype.hasOwnProperty.call(v, key);
test('imported active history without report gains explicit draft/reopen evidence only; row stays imported', async () => {
  const f = fixture(); f.db.seed(f.reportPath, undefined); f.row(undefined, { status: 'imported', imported_from: 'old_system' });
  const before = f.db.value(f.path(f.month + '-01')), result = await f.api().reopen(f.reopenReq());
  assert.equal(result.created_report, true); assert.equal(result.attendance_changed_count, 0);
  assert.deepEqual(f.db.value(f.path(f.month + '-01')), before);
  const report = f.db.value(f.reportPath);
  assert.equal(report.status, 'draft'); assert.equal(report.reopened_by, f.actor);
  for (const k of ['approved_at', 'approved_by', 'submitted_at', 'declaration']) assert.equal(own(report, k), false);
  assert.deepEqual(report.days, []); assert.equal(report.total_hours, null); assert.equal(report.generated_for_correction, true);
  assert.equal(f.jobs().length, 0);
  const context = await f.api().getContext(f.req()); assert.equal(context.eligibility.can_recalculate, true); assert.equal(context.days[0].can_correct, true);
  const detail = await f.api().getAudit(f.req({ event_id: result.reopen_id }));
  assert.equal(detail.report_change.before, null); assert.deepEqual(detail.report_change.after, { status: 'draft' });
});
test('inactive historical reopen uses old local identity and unlocks existing rows without following transfer', async () => {
  const f = fixture(); f.inactive(); f.db.seed(f.reportPath, undefined);
  const result = await f.api().reopen(f.reopenReq());
  assert.equal(result.created_report, true); assert.equal(f.db.value(f.reportPath).full_name, 'Local Name');
  assert.equal((await f.api().getContext(f.req())).eligibility.can_create, false);
  assert.equal(f.jobs().length, 0);
});
test('missing ordinary report/empty historical month/unknown locks cannot manufacture a reopen', async () => {
  for (const variant of ['ordinary', 'empty', 'unknown']) {
    const f = fixture(); f.db.seed(f.reportPath, undefined);
    if (variant === 'ordinary') f.row(undefined, { status: 'draft' });
    if (variant === 'empty') { f.inactive(); f.db.seed(f.path(f.month + '-01'), undefined); }
    if (variant === 'unknown') { f.inactive(); f.row(undefined, { status: 'unknown' }); }
    await noWrites(f, () => f.api().reopen(f.reopenReq()), 'failed-precondition');
  }
});
test('inconsistent/future approval chronology fails closed without erasing evidence', async () => {
  for (const approved_at of [null, 'not-a-timestamp', stamp(NOW), stamp(NOW + 1000)]) {
    const f = fixture(); f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), approved_at });
    await noWrites(f, () => f.api().reopen(f.reopenReq()), 'failed-precondition');
  }
});
test('report CAS and full row-set CAS reject changed, inserted and deleted rows', async () => {
  for (const variant of ['report', 'changed', 'inserted', 'deleted']) {
    const f = fixture(), q = f.reopenReq();
    if (variant === 'report') f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), total_hours: 88 });
    if (variant === 'changed') f.row(undefined, { hours: 9 });
    if (variant === 'inserted') f.row(f.month + '-02');
    if (variant === 'deleted') f.db.seed(f.path(f.month + '-01'), undefined);
    await noWrites(f, () => f.api().reopen(q), 'aborted');
  }
});
test('concurrent same request converges to one reopen event and receipt, no outbox producer', async () => {
  const f = fixture(), q = f.reopenReq();
  const results = await Promise.all([f.api().reopen(q), f.api().reopen(copy(q))]);
  assert.equal(new Set(results.map(v => v.reopen_id)).size, 1);
  assert.deepEqual(results.map(v => v.duplicate).sort(), [false, true]);
  assert.equal(f.events().length, 1); assert.equal(f.receipts().length, 1); assert.equal(f.jobs().length, 0);
});
test('durable replay reauthorizes before current state/CAS and never recreates any job', async () => {
  const f = fixture(), q = f.reopenReq(); await f.api().reopen(q);
  f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), status: 'approved', approved_at: stamp(NOW - 1) });
  f.db.seed(f.path(f.month + '-01'), undefined);
  const before = f.db.dump(), replay = await f.api().reopen(q);
  assert.equal(replay.duplicate, true); assert.deepEqual(f.db.dump(), before); assert.equal(f.jobs().length, 0);
  await noWrites(f, () => f.api().reopen({ ...q, data: { ...q.data, reason: 'A different authorized reopening reason' } }), 'already-exists');
  f.records.get(f.actor).disabled = true;
  await noWrites(f, () => f.api().reopen(q), 'permission-denied');
});
test('replay requires durable event evidence but no transient job and cannot return corrupted result', async () => {
  const f = fixture(), q = f.reopenReq(); await f.api().reopen(q);
  f.db.seed(f.events()[0].path, undefined); await noWrites(f, () => f.api().reopen(q), 'failed-precondition');
});
test('queued receipt failure rolls back report, rows and already-queued event atomically', async () => {
  const f = fixture(); f.db.failWrite = path => path.includes('/' + COLLECTIONS.receipts + '/');
  await noWrites(f, () => f.api().reopen(f.reopenReq()), 'unavailable');
  assert.equal(f.events().length, 0); assert.equal(f.jobs().length, 0);
});
test('read failures abort rather than producing empty month or empty audit evidence', async () => {
  for (const operation of ['context', 'reopen', 'list']) {
    const f = fixture(); f.db.failRead = path => path.endsWith(operation === 'list' ? '/' + COLLECTIONS.events : '/attendance');
    await noWrites(f, () => operation === 'context' ? f.api().getContext(f.req()) : operation === 'reopen' ? f.api().reopen(f.reopenReq()) : f.api().listAudit(f.req()), 'unavailable');
  }
});
test('final fresh Auth revocation during reopen hook cancels all writes', async () => {
  const f = fixture(); f.ports.hooks.beforeWrites = () => { f.records.get(f.actor).tokensValidAfterTime = new Date(NOW + 1).toISOString(); };
  await noWrites(f, () => f.api().reopen(f.reopenReq()), 'permission-denied');
});
test('oversized or unsupported full reopen evidence is rejected, never truncated', async () => {
  for (const [value, code] of [[Buffer.from('unsupported'), 'failed-precondition'], ['x'.repeat(LIMITS.bytes), 'resource-exhausted']]) {
    const f = fixture(); f.row(undefined, { legacy_payload: value });
    await noWrites(f, () => f.api().reopen(f.reopenReq()), code);
  }
});
test('actual correction deletion remains readable in own/HR audit without the deleted attendance row', async () => {
  const f = fixture(); await f.api().reopen(f.reopenReq());
  const result = await f.correct('delete');
  assert.equal(f.db.value(f.path(f.month + '-01')), null);
  for (const who of [f.actor, f.uid]) {
    const detail = await f.api().getAudit(f.req({ event_id: result.correction_id }, who));
    assert.equal(detail.operation, 'delete'); assert.equal(detail.changes[0].before.hours, 8); assert.equal(detail.changes[0].after, null);
    assert.ok(Object.keys(detail.changes[0].before).every(k => FIELDS.includes(k)));
    for (const secret of ['NEVER_RETURN', 'fingerprint', 'actor_auth_time', 'calculation_config', 'request_id', 'before_version']) assert.ok(!JSON.stringify(detail).includes(secret));
  }
  assert.equal(f.jobs().length, 1, 'Only actual content correction creates its existing job');
});
test('audit routing denies another employee, cross-target cursor and mismatched event bindings', async () => {
  const f = fixture(); const result = await f.api().reopen(f.reopenReq());
  await noWrites(f, () => f.api().listAudit(f.req({ target_uid: f.actor, employee_number: '9001' }, f.uid)), 'permission-denied');
  const event = f.events()[0]; f.db.seed(event.path, { ...event.value, target_uid: 'other_person' });
  await noWrites(f, () => f.api().getAudit(f.req({ event_id: result.reopen_id })), 'failed-precondition');
  await noWrites(f, () => f.api().listAudit(f.req({ cursor: result.reopen_id })), 'failed-precondition');
});
test('audit list is explicit 25+1 ID order with scoped cursor, not a whole-history claim', async () => {
  const f = fixture(); await f.api().reopen(f.reopenReq()); const template = f.events()[0];
  f.db.seed(template.path, undefined);
  for (let i = 1; i <= 27; i++) {
    const id = i.toString(16).padStart(64, '0');
    f.db.seed(f.root + '/' + COLLECTIONS.events + '/' + id, { ...template.value, correction_id: id });
  }
  const first = await f.api().listAudit(f.req()), second = await f.api().listAudit(f.req({ cursor: first.next_cursor }));
  assert.equal(first.items.length, 25); assert.equal(first.next_cursor, (25).toString(16).padStart(64, '0'));
  assert.equal(second.items.length, 2); assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(v => v.event_id)).size, 27);
  assert.ok(f.db.metrics.reads.some(r => r.path.endsWith('/' + COLLECTIONS.events) && r.cap === 26));
});
test('audit subtype/evidence corruption rejects safely rather than exposing arbitrary tagged content', async () => {
  for (const variant of ['schema', 'operation', 'v1', 'entry-array', 'extra-key', 'duplicate-key', 'nested-business']) {
    const f = fixture(); const result = await f.api().reopen(f.reopenReq()); const entry = f.events()[0], event = entry.value;
    if (variant === 'schema') event.schema = 'unrelated-event';
    if (variant === 'operation') event.operation = 'delete';
    if (variant === 'v1') event.evidence_encoding = 'tagged-firestore-v1';
    if (variant === 'entry-array') event.changes[0].before.value[0] = ['hours', { type: 'number', value: 8 }];
    if (variant === 'extra-key') event.changes[0].before.value[0].unexpected = true;
    if (variant === 'duplicate-key') event.changes[0].before.value.push(copy(event.changes[0].before.value[0]));
    if (variant === 'nested-business') event.changes[0].before.value.find(entry => entry.key === 'hours').value = { type: 'map', value: [{ key: 'secret', value: { type: 'string', value: 'NO' } }] };
    f.db.seed(entry.path, event);
    await noWrites(f, () => f.api().getAudit(f.req({ event_id: result.reopen_id })), 'failed-precondition');
  }
});
test('per-day correction and active creation match actual core with an imported sibling; complete recalc stays gated', async () => {
  const f = fixture(); f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), status: 'draft' });
  f.row(undefined, { status: 'draft' }); f.row(f.month + '-02', { status: 'imported' });
  const context = await f.api().getContext(f.req());
  assert.deepEqual(context.days.map(row => row.can_correct), [true, false]);
  assert.equal(context.eligibility.can_recalculate, false); assert.equal(context.eligibility.can_create, true);
  await f.correct('update');
  const core = f.correctionApi();
  await core.correctOneDay(f.req({ operation: 'create', date: f.month + '-03', expected_version: 'absent', patch: { day_type: 'vacation' },
    reason: 'The explicit authorized creation reason', request_id: 'create_next_day_0001' }));
  assert.equal(f.db.value(f.path(f.month + '-03')).hours, 24);
  const latest = await f.api().getContext(f.req());
  await noWrites(f, () => core.correctMonthRecalc(f.req({ days: latest.days.map(({ date, expected_version }) => ({ date, expected_version })),
    reason: 'The complete authorized recalculation reason', request_id: 'recalc_whole_0001' })), 'failed-precondition');
  const g = fixture(); g.db.seed(g.path(g.month + '-01'), undefined); g.db.seed(g.reportPath, { ...g.db.value(g.reportPath), status: 'draft' });
  assert.equal((await g.api().getContext(g.req())).eligibility.can_recalculate, false, 'Empty month is not a recalculation request');
});
test('legacy null primitives survive actual context, core update and audit; new null patch still rejected', async () => {
  const f = fixture(); f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), status: 'draft' });
  f.row(undefined, { status: 'draft', end_day: null, notes: null });
  const context = await f.api().getContext(f.req());
  assert.equal(context.days[0].record.end_day, null); assert.equal(context.days[0].record.notes, null); assert.equal(context.days[0].can_correct, true);
  const result = await f.correct('update');
  const detail = await f.api().getAudit(f.req({ event_id: result.correction_id }));
  assert.equal(detail.changes[0].before.end_day, null); assert.equal(detail.changes[0].after.end_day, null);
  assert.equal(detail.changes[0].before.notes, null); assert.equal(detail.changes[0].after.hours, 9);
  await noWrites(f, () => f.correctionApi().correctOneDay(f.req({ operation: 'update', date: f.month + '-01',
    expected_version: f.db.version(f.path(f.month + '-01')), patch: { end_day: null },
    reason: 'An explicit new invalid null patch reason', request_id: 'invalid_null_0001' })), 'invalid-argument');
  for (const notes of [['nested'], { nested: true }]) {
    const g = fixture(); g.row(undefined, { notes });
    await noWrites(g, () => g.api().getContext(g.req()), 'failed-precondition');
  }
});
test('new imported/inactive historical draft is readable by actual HR projection without inventing declared days or totals', async () => {
  for (const variant of ['imported', 'inactive']) {
    const f = fixture(); f.db.seed(f.reportPath, undefined);
    if (variant === 'imported') f.row(undefined, { status: 'imported', imported_from: 'historical_source' });
    else f.inactive();
    const result = await f.api().reopen(f.reopenReq());
    const report = f.db.value(f.reportPath), attendance = [f.db.value(f.path(f.month + '-01'))];
    const projection = projectEmployeeHours({ month: f.month, report, attendance,
      employee: { uid: f.uid, employee_number: f.emp, full_name: 'Local Name', crew: 'A' } });
    assert.equal(result.created_report, true); assert.equal(report.generated_for_correction, true);
    assert.deepEqual(report.days, []); assert.equal(report.total_hours, null);
    assert.equal(projection.state, 'draft'); assert.equal(projection.next_action, 'employee_confirm');
    assert.deepEqual(projection.declared_day_keys, []); assert.equal(projection.stored_total_hours, null);
    assert.equal(projection.current_detail_total_hours, 8); assert.equal(projection.rows[0].hours, 8);
    assert.equal(projection.rows[0].status, variant === 'imported' ? 'imported' : 'draft');
    assert.deepEqual(projection.warnings, ['detail-day-not-in-report', 'reported-total-missing']);
    for (const k of ['submitted_at', 'approved_at', 'approved_by', 'declaration']) assert.equal(own(report, k), false);
    assert.equal(f.jobs().length, 0, 'Reopening adds no competing notification producer');
  }
});
