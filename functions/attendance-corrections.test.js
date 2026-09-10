'use strict';

// Actual correction domain + actual pure browser hours calculator. Database,
// Auth, trusted configuration/month ports and server timestamps are synthetic.
// The optimistic, atomic transaction double rejects read-after-write and retries
// changed read versions. This is NOT a native Firestore/Auth/callable/FCM gate.
// No SDK import, network, file write, package edit or production initialization.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createAttendanceCorrections, COLLECTIONS, LIMITS, TARGET_ROLES } = require('./attendance-corrections');
let hours, rotation, roles;
before(async () => {
  const source = readFileSync(join(__dirname, '..', 'hours.js'), 'utf8');
  hours = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  rotation = await import('data:text/javascript;base64,' + Buffer.from(readFileSync(join(__dirname, '..', 'rotation.js'), 'utf8')).toString('base64'));
  roles = await import('data:text/javascript;base64,' + Buffer.from(readFileSync(join(__dirname, '..', 'roles.js'), 'utf8')).toString('base64'));
});

class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toDate() { return new Date(this.seconds * 1000 + this.nanoseconds / 1e6); }
}
class ServerTime {}
const NOW = Date.parse('2026-09-09T09:00:00Z');
const stamp = ms => new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
function copy(v) {
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (v instanceof ServerTime) return new ServerTime();
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
}
function materialize(v, commit) {
  if (v instanceof ServerTime) return copy(commit);
  if (v instanceof Timestamp || Buffer.isBuffer(v)) return copy(v);
  if (Array.isArray(v)) return v.map(x => materialize(x, commit));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, materialize(x, commit)]));
  return v;
}
function decode(v) {
  if (v.type === 'map') {
    assert.equal(new Set(v.value.map(entry => entry.key)).size, v.value.length, 'evidence keys are unique');
    return Object.fromEntries(v.value.map(entry => {
      assert.deepEqual(Object.keys(entry).sort(), ['key', 'value']);assert.equal(typeof entry.key, 'string');
      return [entry.key, decode(entry.value)];
    }));
  }
  if (v.type === 'array') return v.value.map(decode);
  if (v.type === 'timestamp') return new Timestamp(v.seconds, v.nanoseconds);
  if (v.type === 'commit_timestamp') return 'COMMIT_TIMESTAMP';
  return v.value;
}
function noDirectArrayChild(value, arrayParent = false) {
  if (Array.isArray(value)) {
    assert.equal(arrayParent, false, 'Firestore forbids direct nested arrays');
    value.forEach(item => noDirectArrayChild(item, true));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => noDirectArrayChild(item, false));
  }
}

function memoryDb() {
  const state = new Map(); let serial = 0;
  const metrics = { reads: 0, writes: 0, commits: 0, retries: 0 };
  class Ref {
    constructor(path) { this.path = path; this.id = path.split('/').at(-1); }
    collection(name) { return new Query(this.path + '/' + name); }
  }
  class Query {
    constructor(path, filters = [], cap = Infinity) { this.path = path; this.filters = filters; this.cap = cap; }
    doc(id) { return new Ref(this.path + '/' + id); }
    where(key, op, value) { assert.equal(op, '=='); return new Query(this.path, this.filters.concat([[key, value]]), this.cap); }
    limit(n) { return new Query(this.path, this.filters, n); }
  }
  function snapshot(ref) {
    const entry = state.get(ref.path);
    return { ref, id: ref.id, exists: !!entry, updateTime: entry ? new Timestamp(entry.version, 0) : undefined,
      data: () => entry ? copy(entry.value) : undefined };
  }
  const db = {
    collection: path => new Query(path), metrics, failRead: null, failWrite: null,
    seed(path, value) { if (value === undefined) state.delete(path); else state.set(path, { value: copy(value), version: ++serial }); serial++; },
    value(path) { return state.has(path) ? copy(state.get(path).value) : null; },
    version(path) { const s = snapshot(new Ref(path)); return s.exists ? { seconds: s.updateTime.seconds, nanoseconds: 0 } : 'absent'; },
    entries(fragment) { return [...state].filter(([k]) => k.includes('/' + fragment + '/')).map(([path, v]) => ({ path, data: copy(v.value) })); },
    dump() { return copy([...state]); },
    async runTransaction(body) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const reads = new Map(), writes = []; let queryVersion = null;
        const tx = {
          async get(ref) {
            assert.equal(writes.length, 0, 'No transaction read is allowed after the first queued write');
            metrics.reads++;
            if (db.failRead && db.failRead(ref.path)) throw new HttpsError('unavailable', 'Synthetic read failure');
            if (ref instanceof Query) {
              queryVersion = serial;
              const docs = [...state].filter(([p, v]) => p.startsWith(ref.path + '/') && p.split('/').length === ref.path.split('/').length + 1
                && ref.filters.every(([k, x]) => v.value[k] === x)).sort(([a], [b]) => a.localeCompare(b)).slice(0, ref.cap).map(([p]) => snapshot(new Ref(p)));
              docs.forEach(s => reads.set(s.ref.path, state.get(s.ref.path).version));
              return { docs };
            }
            reads.set(ref.path, state.get(ref.path)?.version || 0);
            return snapshot(ref);
          },
          create(ref, value) { queue('create', ref, value); },
          set(ref, value) { queue('set', ref, value); },
          delete(ref) { queue('delete', ref); }
        };
        function queue(op, ref, value) {
          noDirectArrayChild(value);
          writes.push({ op, path: ref.path, value: copy(value) });
          if (db.failWrite && db.failWrite(ref.path)) throw new HttpsError('unavailable', 'Synthetic queued write failure');
        }
        const result = await body(tx);
        if ([...reads].some(([p, v]) => (state.get(p)?.version || 0) !== v) || (queryVersion !== null && queryVersion !== serial)) {
          metrics.retries++; continue;
        }
        for (const w of writes) if (w.op === 'create' && state.has(w.path)) throw new HttpsError('already-exists', 'Create collision');
        if (writes.length) {
          const commit = stamp(NOW + serial);
          for (const w of writes) {
            if (w.op === 'delete') state.delete(w.path);
            else state.set(w.path, { value: materialize(w.value, commit), version: ++serial });
          }
          metrics.commits++; metrics.writes += writes.length; serial++;
        }
        return result;
      }
      throw new HttpsError('aborted', 'Synthetic transaction retries exhausted');
    }
  };
  return db;
}
function fixture(options = {}) {
  const db = memoryDb(), sid = 'correction_station', actor = 'hr_actor', uid = 'employee_A', emp = '1001';
  const root = 'stations/' + sid, month = options.month || '2026-09';
  const profiles = new Map([[actor, { uid: actor, disabled: false, displayName: 'Current HR Name',
    customClaims: { stationId: sid, role: 'hr_coordinator' }, tokensValidAfterTime: new Date(0).toISOString() }]]);
  db.seed(root + '/users/' + actor, { stationId: sid, role: 'hr_coordinator', active: true, employee_number: '9000' });
  db.seed(root + '/users/' + uid, { stationId: sid, role: 'firefighter', active: true, employee_number: emp, full_name: 'Local Employee', crew: 'A' });
  db.seed('directory/' + uid, { stationId: sid, role: 'firefighter', active: true, employee_number: emp, uid });
  db.seed('emp_index/' + emp, { stationId: sid, uid, active: true });
  db.seed(root + '/correction_test_config/hours', { fixed_hours: 0, shift_hours: 24, site_name: 'Synthetic Site' });
  const reportPath = root + '/monthly_reports/' + emp + '_' + month;
  db.seed(reportPath, { uid, emp_number: emp, month, status: 'draft', days: [month + '-01'], total_hours: 12, declaration: 'keep employee declaration' });
  const path = date => root + '/attendance/' + emp + '_' + date;
  function row(date = month + '-01', patch = {}) {
    db.seed(path(date), { uid, emp_number: emp, month, date, full_name: 'Historical Name', crew: 'A', status: 'draft',
      day_type: 'regular', shape: 'regular', start: '07:00', end: '19:00', end_day: 0, start2: '', end2: '', end_day2: 0,
      sub_station: 'site_A', hours: 12, day_type_he: 'רגיל', site_name: 'Old Site', reason_required: false,
      notes: 'original notes', overtime_reason: '', updated_at: stamp(NOW - 1000), edited_by_name: 'Old Editor',
      legacy_unknown: { nested: [1, true, null, 'preserve'] }, ...patch });
  }
  row();
  let now = NOW;
  const auth = { async getUser(id) {
    if (!profiles.has(id)) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
    return copy(profiles.get(id));
  } };
  const ports = {
    db, auth, HttpsError, clock: () => now, serverTimestamp: () => new ServerTime(),
    readConfig: async tx => (await tx.get(db.collection(root + '/correction_test_config').doc('hours'))).data(),
    calculate: (record, config) => ({ hours: hours.calcHours(record, config.fixed_hours),
      day_type_he: hours.dayTypeHe(record.day_type), site_name: config.site_name,
      reason_required: hours.reasonWhy(record, config.fixed_hours, config.shift_hours) !== '' }),
    monthAt: at => {
      const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit' }).formatToParts(new Date(at));
      return parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value;
    }, ...options.ports
  };
  const api = () => createAttendanceCorrections(ports);
  const common = { target_uid: uid, employee_number: emp, month, reason: 'A specific authorized correction reason', request_id: 'request_0001' };
  function req(patch = {}) {
    return { auth: { uid: actor, token: { stationId: sid, role: 'hr_coordinator', auth_time: Math.floor(NOW / 1000) - 100 } },
      data: { ...common, operation: 'update', date: month + '-01', expected_version: db.version(path(month + '-01')), patch: { end: '20:00' }, ...patch } };
  }
  function recalc(dates = [month + '-01']) {
    return { auth: req().auth, data: { ...common, days: dates.map(date => ({ date, expected_version: db.version(path(date)) })) } };
  }
  function inactive(markers = true) {
    db.seed(root + '/users/' + uid, { ...db.value(root + '/users/' + uid), active: false });
    db.seed('directory/' + uid, { stationId: 'new_station', uid, employee_number: emp, full_name: 'DO NOT BORROW' });
    db.seed('emp_index/' + emp, { stationId: 'new_station', uid, active: true });
    if (markers) db.seed(reportPath, { ...db.value(reportPath), reopened_by: actor,
      reopened_at: stamp(NOW - 1000), approved_at: stamp(NOW - 2000) });
  }
  return { db, sid, root, actor, uid, emp, month, profiles, ports, api, req, recalc, row, path, reportPath, inactive,
    setNow: v => { now = v; }, events: () => db.entries(COLLECTIONS.events), jobs: () => db.entries(COLLECTIONS.jobs),
    receipts: () => db.entries(COLLECTIONS.receipts) };
}
async function rejectsWithoutWrites(f, request, code, recalc = false) {
  const before = f.db.dump(), writes = f.db.metrics.writes;
  await assert.rejects((recalc ? f.api().correctMonthRecalc(request) : f.api().correctOneDay(request)), e => e.code === code);
  assert.deepEqual(f.db.dump(), before); assert.equal(f.db.metrics.writes, writes);
}

test('factory requires explicit trusted calculator, config and server-month ports', () => {
  const f = fixture();
  for (const key of ['calculate', 'readConfig', 'monthAt', 'serverTimestamp', 'auth', 'db']) assert.throws(() => createAttendanceCorrections({ ...f.ports, [key]: undefined }), TypeError);
});
test('actual calculator update, complete evidence, server attribution, legacy and report preservation', async () => {
  const f = fixture(), before = f.db.value(f.path(f.month + '-01')), report = f.db.value(f.reportPath);
  const result = await f.api().correctOneDay(f.req());
  const after = f.db.value(f.path(f.month + '-01')), event = f.events()[0].data;
  assert.equal(after.hours, 13); assert.equal(after.edited_by, f.actor); assert.equal(after.edited_by_name, 'Current HR Name');
  assert.deepEqual(after.legacy_unknown, before.legacy_unknown); assert.deepEqual(f.db.value(f.reportPath), report);
  assert.deepEqual(decode(event.changes[0].before), before);
  assert.deepEqual(decode(event.changes[0].after).legacy_unknown, before.legacy_unknown);
  assert.equal(decode(event.changes[0].after).updated_at, 'COMMIT_TIMESTAMP');
  assert.equal(event.actor_name, 'Current HR Name'); assert.equal(event.created_at_ms, NOW);
  assert.equal(event.changes[0].record_id, f.emp + '_' + f.month + '-01');
  assert.equal(result.duplicate, false); assert.equal(result.notification_status, 'intent_only');
  assert.equal(f.events().length, 1); assert.equal(f.receipts().length, 1); assert.equal(f.jobs().length, 1);
});
test('generic dedicated intent contains no reason, notes, before/after or delivery claim', async () => {
  const f = fixture(); await f.api().correctOneDay(f.req()); const j = f.jobs()[0].data;
  assert.deepEqual(Object.keys(j).sort(), ['schema','event_id','station_id','actor_uid','actor_auth_time','recipient_uid','employee_number','month','type','audience','status','delivery_status','created_at_ms','send_now','consent_expires_at_ms','routine_after_quiet','exclude_actor'].sort());
  assert.equal(j.schema, 'attendance-correction-notification-v1'); assert.equal(j.type, 'attendance_corrected');
  assert.equal(j.send_now, false); assert.equal(j.consent_expires_at_ms, 0); assert.equal(j.routine_after_quiet, true);
  assert.equal(j.recipient_uid, f.uid); assert.equal(j.delivery_status, 'intent_only');
  assert.equal(JSON.stringify(j).includes('specific authorized'), false);
});
test('v2 evidence round-trips literal keys, nested maps and arrays without Firestore nested arrays', async () => {
  const f = fixture(), legacy = Object.fromEntries([
    ['__proto__', { retained: true }], ['a.b', { inside: [{ items: [null, false, 1.25, 'עברית'] }] }],
    ['', 'empty key'], ['time', new Timestamp(1234, 567890123)]
  ]);
  f.row(f.month + '-01', { legacy_unknown: legacy });
  await f.api().correctOneDay(f.req());const event = f.events()[0].data;
  assert.equal(event.evidence_encoding, 'tagged-firestore-v2');noDirectArrayChild(event);
  assert.deepEqual(decode(event.changes[0].before).legacy_unknown, legacy);
  assert.deepEqual(decode(event.changes[0].after).legacy_unknown, legacy);
  const oldTupleMap = { type: 'map', value: event.changes[0].before.value.map(entry => [entry.key, entry.value]) };
  assert.throws(() => noDirectArrayChild(oldTupleMap), /direct nested arrays/, 'the old tuple representation is rejected');
  const duplicate = { type: 'map', value: [{ key: 'same', value: { type: 'number', value: 1 } }, { key: 'same', value: { type: 'number', value: 2 } }] };
  assert.throws(() => decode(duplicate), /keys are unique/);
});
test('actual canonical fixed-site override is independent from interval duration', async () => {
  const f = fixture();
  f.db.seed(f.root + '/correction_test_config/hours', { fixed_hours: 25, shift_hours: 24, site_name: 'Fixed Site' });
  await f.api().correctOneDay(f.req());
  const row = f.db.value(f.path(f.month + '-01'));
  assert.equal(row.start, '07:00'); assert.equal(row.end, '20:00');
  assert.equal(row.hours, 25); assert.equal(row.reason_required, false);
  assert.equal(decode(f.events()[0].data.calculation_config).fixed_hours, 25);
});
test('active current Jerusalem month may create absent day without fabricating report', async () => {
  const f = fixture(); f.db.seed(f.reportPath, undefined); const date = f.month + '-02';
  await f.api().correctOneDay(f.req({ operation: 'create', date, expected_version: 'absent', patch: { day_type: 'vacation' } }));
  assert.equal(f.db.value(f.path(date)).hours, 24); assert.equal(f.db.value(f.path(date)).status, 'draft');
  assert.equal(f.db.value(f.reportPath), null); assert.equal(decode(f.events()[0].data.changes[0].before), null);
});
test('draft and submitted reports allow correction without employee consent', async () => {
  for (const status of ['draft', 'submitted']) {
    const f = fixture(); f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), status });
    await f.api().correctOneDay(f.req()); assert.equal(f.db.value(f.reportPath).status, status);
  }
});
test('submitted report allows new active row, without changing employee declared days or total', async () => {
  const f = fixture(); f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), status: 'submitted' }); const old = f.db.value(f.reportPath);
  await f.api().correctOneDay(f.req({ operation: 'create', date: f.month + '-02', expected_version: 'absent', patch: { day_type: 'reserve' } }));
  assert.equal(f.db.value(f.path(f.month + '-02')).hours, 8.5); assert.deepEqual(f.db.value(f.reportPath), old);
});
test('delete preserves entire before evidence after attendance disappears', async () => {
  const f = fixture(), before = f.db.value(f.path(f.month + '-01')); const q = f.req({ operation: 'delete' }); delete q.data.patch;
  f.ports.readConfig = () => { throw new Error('Delete must not need calculator/config'); };
  await f.api().correctOneDay(q); assert.equal(f.db.value(f.path(f.month + '-01')), null);
  assert.deepEqual(decode(f.events()[0].data.changes[0].before), before); assert.equal(decode(f.events()[0].data.changes[0].after), null);
});
test('only HR or signed boolean super; no commander/email/string-super shortcut', async () => {
  for (const token of [{ role: 'commander' }, { role: 'station_commander' }, { role: 'firefighter', email: 'admin@example.test' }, { role: 'super_admin', super: 'true' }]) {
    const f = fixture(), q = f.req(); q.auth.token = { ...q.auth.token, ...token }; await rejectsWithoutWrites(f, q, 'permission-denied');
  }
  const f = fixture(), q = f.req(); q.auth.token.super = true; q.auth.token.role = 'unrelated';
  f.profiles.set(f.actor, { uid: f.actor, customClaims: { stationId: f.sid, super: true }, disabled: false });
  f.db.seed(f.root + '/users/' + f.actor, undefined);
  await f.api().correctOneDay(q); assert.equal(f.events()[0].data.actor_role, 'super_admin');
});
test('fresh actor disabled, revoked, malformed marker, changed station/role and profile are denied', async () => {
  for (const [change, code] of [
    [f => { f.profiles.get(f.actor).disabled = true; }, 'permission-denied'],
    [f => { f.profiles.get(f.actor).tokensValidAfterTime = new Date(NOW).toISOString(); }, 'permission-denied'],
    [f => { f.profiles.get(f.actor).tokensValidAfterTime = null; }, 'unavailable'],
    [f => { f.profiles.get(f.actor).customClaims.stationId = 'other_station'; }, 'permission-denied'],
    [f => { f.profiles.get(f.actor).customClaims.role = 'commander'; }, 'permission-denied'],
    [f => { f.db.seed(f.root + '/users/' + f.actor, { stationId: f.sid, role: 'hr_coordinator', active: false }); }, 'permission-denied']
  ]) { const f = fixture(); change(f); await rejectsWithoutWrites(f, f.req(), code); }
});
test('revocation equality matches valid current sign-in, missing auth_time does not', async () => {
  const f = fixture(), q = f.req(); f.profiles.get(f.actor).tokensValidAfterTime = new Date(q.auth.token.auth_time * 1000).toISOString();
  await f.api().correctOneDay(q);
  const g = fixture(), bad = g.req(); delete bad.auth.token.auth_time; await rejectsWithoutWrites(g, bad, 'unauthenticated');
});
test('closed input rejects derived, identity, editor, station, status and malformed editable values', async () => {
  const invalid = [q => { q.data.station_id = 'other'; }, q => { q.data.patch.hours = 900; }, q => { q.data.patch.status = 'approved'; },
    q => { q.data.patch.uid = 'other'; }, q => { q.data.patch.edited_by = 'other'; }, q => { q.data.patch.reason_required = false; },
    q => { q.data.patch.day_type_he = 'invented'; }, q => { q.data.patch.site_name = 'invented'; }, q => { q.data.patch.shape = 'invented'; },
    q => { q.data.patch.end = '25:10'; }, q => { q.data.patch.end_day = '1'; }, q => { q.data.patch.end_day2 = 3; },
    q => { q.data.patch.notes = 'x'.repeat(4001); }, q => { q.data.reason = 'short'; }, q => { q.data.reason = 'x'.repeat(501); },
    q => { q.data.request_id = '../unsafe'; }, q => { q.data.date = '2026-09-31'; }, q => { q.data.month = '2026-13'; },
    q => { q.data.target_uid = ['employee_A']; }, q => { q.data.patch = { end: '20:00', constructor: 'x' }; }];
  for (const mutate of invalid) { const f = fixture(), q = f.req(); mutate(q); await rejectsWithoutWrites(f, q, 'invalid-argument'); }
});
test('explicit version/absent semantics reject unsafe create, update and delete preconditions', async () => {
  for (const edit of [{ operation: 'create' }, { expected_version: 'absent' }, { expected_version: { seconds: 1, nanoseconds: 1e9 } }, { operation: 'delete' }]) {
    const f = fixture(); await rejectsWithoutWrites(f, f.req(edit), 'invalid-argument');
  }
  const f = fixture(); await rejectsWithoutWrites(f, f.req({ operation: 'create', expected_version: 'absent', patch: { day_type: 'regular' } }), 'aborted');
});
test('stored updateTime CAS detects changed preimage, even when editable values look unchanged', async () => {
  const f = fixture(), q = f.req(); f.row(f.month + '-01', { legacy_unknown: { changed: true } });
  await rejectsWithoutWrites(f, q, 'aborted');
});
test('matching replay after approval and deletion returns receipt without status/CAS gate or writes', async () => {
  const f = fixture(), q = f.req(); const first = await f.api().correctOneDay(q);
  f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), status: 'approved' }); f.db.seed(f.path(f.month + '-01'), undefined);
  const writes = f.db.metrics.writes; const replay = await f.api().correctOneDay(q);
  assert.equal(replay.correction_id, first.correction_id); assert.equal(replay.duplicate, true); assert.equal(f.db.metrics.writes, writes);
  const different = copy(q); different.data.reason += ' different'; await rejectsWithoutWrites(f, different, 'already-exists');
});
test('replay still requires current Auth and canonical employee authorization', async () => {
  const f = fixture(), q = f.req(); await f.api().correctOneDay(q);
  f.profiles.get(f.actor).disabled = true; await rejectsWithoutWrites(f, q, 'permission-denied');
  f.profiles.get(f.actor).disabled = false;
  f.db.seed('emp_index/' + f.emp, { uid: 'wrong_uid', stationId: f.sid }); await rejectsWithoutWrites(f, q, 'failed-precondition');
});
test('replay refuses incomplete evidence rather than creating a replacement notification', async () => {
  const f = fixture(), q = f.req(); await f.api().correctOneDay(q); f.db.seed(f.events()[0].path, undefined);
  await rejectsWithoutWrites(f, q, 'failed-precondition');
});
test('transient job cleanup does not break durable replay or recreate a notification', async () => {
  const f = fixture(), q = f.req(); await f.api().correctOneDay(q); f.db.seed(f.jobs()[0].path, undefined);
  const writes = f.db.metrics.writes;
  assert.equal((await f.api().correctOneDay(q)).duplicate, true);
  assert.equal(f.db.metrics.writes, writes); assert.equal(f.jobs().length, 0);
});
test('NFC-normalized reason has stable replay fingerprint', async () => {
  const f = fixture(), q = f.req({ reason: 'Correction for cafe\u0301 attendance hours' });
  await f.api().correctOneDay(q); q.data.reason = q.data.reason.normalize('NFC');
  assert.equal((await f.api().correctOneDay(q)).duplicate, true);
});
test('absent report cannot authorize past/future creation or update/delete', async () => {
  for (const operation of ['update', 'delete']) {
    const f = fixture(); f.db.seed(f.reportPath, undefined); const q = f.req({ operation }); if (operation === 'delete') delete q.data.patch;
    await rejectsWithoutWrites(f, q, 'failed-precondition');
  }
  for (const month of ['2026-08', '2026-10']) {
    const f = fixture({ month }); f.db.seed(f.reportPath, undefined);
    await rejectsWithoutWrites(f, f.req({ operation: 'create', date: month + '-02', expected_version: 'absent', patch: { day_type: 'sick' } }), 'failed-precondition');
  }
});
test('report malformed identity/status and inconsistent approved row fail closed', async () => {
  for (const patch of [{ uid: 'other' }, { emp_number: 'other' }, { month: '2026-08' }, { status: null }, { status: 'approved' }, { status: 'unknown' }]) {
    const f = fixture(); f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), ...patch }); await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
  }
  const f = fixture(); f.row(f.month + '-01', { status: 'approved' }); await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
});
test('final server Jerusalem-month check closes an absent-creation month crossing', async () => {
  const f = fixture(); f.db.seed(f.reportPath, undefined); f.setNow(Date.parse('2026-09-30T20:59:59Z'));
  f.ports.hooks = { beforeWrites: () => f.setNow(Date.parse('2026-09-30T21:00:01Z')) };
  await rejectsWithoutWrites(f, f.req({ operation: 'create', date: '2026-09-02', expected_version: 'absent', patch: { day_type: 'vacation' } }), 'failed-precondition');
});
test('inactive reopened existing row is corrected using old local binding, never new-station identity', async () => {
  const f = fixture(); f.inactive(); await f.api().correctOneDay(f.req());
  assert.equal(f.db.value(f.path(f.month + '-01')).full_name, 'Historical Name');
  assert.equal(JSON.stringify(f.events()).includes('DO NOT BORROW'), false);
});
test('inactive existing delete/recalc allowed after reopen; creation always denied', async () => {
  const f = fixture(); f.inactive(); const q = f.req({ operation: 'delete' }); delete q.data.patch; await f.api().correctOneDay(q);
  const g = fixture(); g.inactive(); await g.api().correctMonthRecalc(g.recalc());
  const h = fixture(); h.inactive(); await rejectsWithoutWrites(h, h.req({ operation: 'create', date: h.month + '-02', expected_version: 'absent', patch: { day_type: 'vacation' } }), 'failed-precondition');
});
test('inactive historical state alone is insufficient; malformed or stale reopening is denied', async () => {
  for (const patch of [{ reopened_at: null }, { reopened_by: '' }, { reopened_at: stamp(NOW + 1) },
    { reopened_at: stamp(NOW - 3000) }, { approved_at: null }, { reopened_at: { seconds: NaN, nanoseconds: 0 } }]) {
    const f = fixture(); f.inactive(); f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), ...patch }); await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
  }
  const f = fixture(); f.inactive(false); await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
});
test('canonical target and attendance binding mismatches fail before writes', async () => {
  for (const change of [f => f.db.seed(f.root + '/users/' + f.uid, { stationId: 'other_station', employee_number: f.emp }),
    f => f.db.seed('directory/' + f.uid, { stationId: f.sid, employee_number: 'other', active: true }),
    f => f.row(f.month + '-01', { uid: 'other' }), f => f.row(f.month + '-01', { month: '2026-08' })]) {
    const f = fixture(); change(f); await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
  }
});
test('legacy UID absence is allowed only through exact local employee/date/month binding', async () => {
  const f = fixture();
  const report = f.db.value(f.reportPath), row = f.db.value(f.path(f.month + '-01'));
  delete report.uid; delete row.uid;
  f.db.seed(f.reportPath, report); f.db.seed(f.path(f.month + '-01'), row);
  await f.api().correctOneDay(f.req());
  assert.equal(Object.hasOwn(f.db.value(f.path(f.month + '-01')), 'uid'), false);
  assert.equal(f.events()[0].data.target_uid, f.uid);
  for (const location of ['report', 'row']) for (const uid of ['', null, 'wrong_uid']) {
    const g = fixture(), path = location === 'report' ? g.reportPath : g.path(g.month + '-01');
    g.db.seed(path, { ...g.db.value(path), uid }); await rejectsWithoutWrites(g, g.req(), 'failed-precondition');
  }
});
test('nonfinite numeric employee fields never satisfy canonical string identity', async () => {
  for (const invalid of [NaN, Infinity, -Infinity]) for (const location of ['local', 'directory', 'report', 'row']) {
    const f = fixture(), emp = String(invalid), q = f.req({ employee_number: emp });
    // All otherwise valid canonical bindings deliberately use the same textual
    // value, so failure discriminates the one numeric/nonfinite field.
    f.db.seed(f.root + '/users/' + f.uid, { stationId: f.sid, role: 'firefighter', active: true, employee_number: emp });
    f.db.seed('directory/' + f.uid, { stationId: f.sid, active: true, uid: f.uid, employee_number: emp });
    f.db.seed('emp_index/' + emp, { stationId: f.sid, active: true, uid: f.uid });
    const reportPath = f.root + '/monthly_reports/' + emp + '_' + f.month;
    const rowPath = f.root + '/attendance/' + emp + '_' + f.month + '-01';
    f.db.seed(reportPath, { ...f.db.value(f.reportPath), emp_number: emp });
    f.db.seed(rowPath, { ...f.db.value(f.path(f.month + '-01')), emp_number: emp });
    const path = location === 'local' ? f.root + '/users/' + f.uid : location === 'directory' ? 'directory/' + f.uid : location === 'report' ? reportPath : rowPath;
    const field = ['local', 'directory'].includes(location) ? 'employee_number' : 'emp_number';
    f.db.seed(path, { ...f.db.value(path), [field]: invalid }); q.data.expected_version = f.db.version(rowPath);
    await rejectsWithoutWrites(f, q, 'failed-precondition');
  }
});
test('active imported rows require reopening evidence and retain imported status', async () => {
  const f = fixture(); f.row(f.month + '-01', { status: 'imported', imported_from: 'shift-eilat' });
  await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
  f.db.seed(f.reportPath, { ...f.db.value(f.reportPath), reopened_by: f.actor, reopened_at: stamp(NOW - 1000), approved_at: stamp(NOW - 2000) });
  await f.api().correctOneDay(f.req());
  assert.equal(f.db.value(f.path(f.month + '-01')).status, 'imported');
  assert.equal(f.db.value(f.path(f.month + '-01')).imported_from, 'shift-eilat');
  const g = fixture(); g.row(g.month + '-01', { status: 'imported' });
  await rejectsWithoutWrites(g, g.recalc(), 'failed-precondition', true);
  const h = fixture(); h.row(h.month + '-01', { status: 'imported' });
  const del = h.req({ operation: 'delete' }); delete del.data.patch;
  await rejectsWithoutWrites(h, del, 'failed-precondition');
});
test('recalculation uses complete actual month, canonical calculator and no report-summary rewrite', async () => {
  const f = fixture(); f.row(f.month + '-02', { day_type: 'vacation', hours: 1 }); const report = f.db.value(f.reportPath);
  const result = await f.api().correctMonthRecalc(f.recalc([f.month + '-01', f.month + '-02']));
  assert.equal(result.changed_count, 2); assert.equal(f.db.value(f.path(f.month + '-02')).hours, 24);
  assert.equal(f.events()[0].data.changes.length, 2); assert.equal(f.jobs().length, 1); assert.deepEqual(f.db.value(f.reportPath), report);
});
test('recalculation detects added/removed/noncanonical rows and rejects duplicate/oversized input', async () => {
  const f = fixture(), stale = f.recalc(); f.row(f.month + '-02'); await rejectsWithoutWrites(f, stale, 'aborted', true);
  const g = fixture(), removed = g.recalc(); g.db.seed(g.path(g.month + '-01'), undefined); await rejectsWithoutWrites(g, removed, 'aborted', true);
  const h = fixture(), canonical = h.recalc(), value = h.db.value(h.path(h.month + '-01'));
  h.db.seed(h.path(h.month + '-01'), undefined); h.db.seed(h.root + '/attendance/legacy_noncanonical', value);
  await rejectsWithoutWrites(h, canonical, 'failed-precondition', true);
  const j = fixture(), dup = j.recalc(); dup.data.days.push(copy(dup.data.days[0])); await rejectsWithoutWrites(j, dup, 'invalid-argument', true);
  const k = fixture(), many = k.recalc(); many.data.days = Array.from({ length: 32 }, () => copy(many.data.days[0])); await rejectsWithoutWrites(k, many, 'invalid-argument', true);
});
test('31 existing days remain bounded and commit one month event/receipt/intent', async () => {
  const f = fixture({ month: '2026-10' }), dates = [];
  for (let i = 1; i <= 31; i++) { const d = '2026-10-' + String(i).padStart(2, '0'); f.row(d); dates.push(d); }
  const result = await f.api().correctMonthRecalc(f.recalc(dates));
  assert.equal(result.changed_count, 31); assert.equal(f.db.metrics.writes, 34);
  assert.equal(f.db.metrics.commits, 1); assert.equal(f.events().length, 1);
});
test('queued event/receipt/intent failure atomically rolls back attendance and all evidence', async () => {
  for (const collection of Object.values(COLLECTIONS)) {
    const f = fixture(); f.db.failWrite = p => p.includes('/' + collection + '/'); await rejectsWithoutWrites(f, f.req(), 'unavailable');
  }
});
test('database/config I/O failure never becomes absence or a partial correction', async () => {
  for (const part of ['/monthly_reports/', '/attendance/', '/directory/', '/emp_index/', '/correction_test_config/']) {
    const f = fixture(); f.db.failRead = p => ('/' + p).includes(part); await rejectsWithoutWrites(f, f.req(), 'unavailable');
  }
});
test('invalid derived output from trusted port is rejected, not silently coerced', async () => {
  for (const change of [{ hours: Infinity }, { hours: NaN }, { hours: -1 }, { hours: '12' }, { reason_required: 'false' }, { site_name: ['name'] }, { extra: 'field' }]) {
    const f = fixture(); f.ports.calculate = () => ({ hours: 12, day_type_he: 'רגיל', site_name: 'site', reason_required: false, ...change });
    await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
  }
  const f = fixture(); f.ports.calculate = async () => ({}); await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
});
test('trusted calculator cannot mutate preserved legacy data through its arguments', async () => {
  const f = fixture(), calc = f.ports.calculate, before = f.db.value(f.path(f.month + '-01')).legacy_unknown;
  f.ports.calculate = (record, config) => { record.legacy_unknown.nested[0] = 'changed'; config.site_name = 'calculation-only'; return calc(record, config); };
  await f.api().correctOneDay(f.req()); assert.deepEqual(f.db.value(f.path(f.month + '-01')).legacy_unknown, before);
  assert.equal(decode(f.events()[0].data.calculation_config).site_name, 'Synthetic Site');
});
test('oversized and unsupported full evidence fail without truncation or mutation', async () => {
  const f = fixture(); f.row(f.month + '-01', { legacy_unknown: 'ח'.repeat(LIMITS.evidenceBytes) }); await rejectsWithoutWrites(f, f.req(), 'resource-exhausted');
  const g = fixture(); g.row(g.month + '-01', { legacy_unknown: Buffer.from('unsupported binary') }); await rejectsWithoutWrites(g, g.req(), 'failed-precondition');
});
test('final fresh Auth revocation aborts mutation and notification', async () => {
  const f = fixture(); f.ports.hooks = { beforeWrites: () => { f.profiles.get(f.actor).disabled = true; } };
  const before = f.db.dump(); await assert.rejects(f.api().correctOneDay(f.req()), e => e.code === 'permission-denied');
  assert.deepEqual(f.db.dump(), before); assert.equal(f.db.metrics.writes, 0);
});
test('target transfer before final binding is denied without correction writes', async () => {
  const f = fixture(); f.ports.hooks = { beforeWrites: () => f.db.seed(f.root + '/users/' + f.uid,
    { ...f.db.value(f.root + '/users/' + f.uid), stationId: 'other_station' }) };
  const before = f.db.value(f.path(f.month + '-01'));
  await assert.rejects(f.api().correctOneDay(f.req()), e => e.code === 'failed-precondition');
  assert.deepEqual(f.db.value(f.path(f.month + '-01')), before); assert.equal(f.db.metrics.writes, 0);
});
test('concurrent distinct corrections with same expected version cannot overwrite each other', async () => {
  const f = fixture(), a = f.req(), b = f.req({ request_id: 'request_0002', patch: { end: '21:00' } });
  const results = await Promise.allSettled([f.api().correctOneDay(a), f.api().correctOneDay(b)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'aborted');
  assert.equal(f.events().length, 1); assert.equal(f.jobs().length, 1); assert.ok(f.db.metrics.retries >= 1);
});
test('concurrent identical replay records one mutation, event, receipt and notification intent', async () => {
  const f = fixture(), q = f.req(); const results = await Promise.all([f.api().correctOneDay(q), f.api().correctOneDay(copy(q))]);
  assert.deepEqual(results.map(r => r.duplicate).sort(), [false, true]);
  assert.equal(f.db.metrics.writes, 4); assert.equal(f.events().length, 1); assert.equal(f.jobs().length, 1);
});
test('employee write between transaction reads and commit forces retry then stale-CAS rejection', async () => {
  const f = fixture(); let once = false;
  f.ports.hooks = { beforeWrites: () => { if (!once) { once = true; f.row(f.month + '-01', { notes: 'employee edit' }); } } };
  await assert.rejects(f.api().correctOneDay(f.req()), e => e.code === 'aborted');
  assert.equal(f.db.value(f.path(f.month + '-01')).notes, 'employee edit'); assert.equal(f.db.metrics.writes, 0); assert.equal(f.events().length, 0);
});
test('target-role vocabulary is exactly the current canonical local role vocabulary', () => {
  assert.deepEqual([...TARGET_ROLES].sort(), [...roles.VALID_ROLES].sort());
});
test('trusted configuration receives canonical target role, never the HR viewer role', async () => {
  for (const role of TARGET_ROLES) {
    const f = fixture();
    f.db.seed(f.root + '/users/' + f.uid, { ...f.db.value(f.root + '/users/' + f.uid), role });
    f.row(f.month + '-01', { end:'07:10', end_day:1 });
    const original = f.ports.readConfig; let seen;
    f.ports.readConfig = async (tx, input) => {
      seen = input;
      // Real browser shiftTimes is the reference only; production readConfig
      // selection/wiring belongs to its separate integration gate.
      return { ...await original(tx), shift_hours:rotation.shiftTimes({}, input.targetRole, false).hours };
    };
    await f.api().correctOneDay(f.req({ patch:{ notes:'only change notes; preserve target hours' } }));
    assert.deepEqual(seen, { stationId:f.sid, targetRole:role, subStationIds:['site_A'] });
    assert.equal(f.db.value(f.path(f.month + '-01')).reason_required, role !== 'commander');
    assert.equal(decode(f.events()[0].data.calculation_config).shift_hours, role === 'commander' ? 24.25 : 24);
  }
});
test('missing or malformed local target role is denied and cannot be supplied by request', async () => {
  for (const role of [undefined, null, '', 'super_admin', 'commander ', ['commander']]) {
    const f = fixture(); const p = f.db.value(f.root + '/users/' + f.uid);
    if (role === undefined) delete p.role; else p.role = role;
    f.db.seed(f.root + '/users/' + f.uid, p); await rejectsWithoutWrites(f, f.req(), 'failed-precondition');
  }
  const f = fixture(); await rejectsWithoutWrites(f, f.req({ targetRole:'commander' }), 'invalid-argument');
});
test('target role change after configuration read aborts final binding and writes', async () => {
  const f = fixture(); let seen;
  const original = f.ports.readConfig;
  f.ports.readConfig = async (tx, input) => { seen = input.targetRole; return original(tx); };
  f.ports.hooks = { beforeWrites:() => f.db.seed(f.root + '/users/' + f.uid,
    { ...f.db.value(f.root + '/users/' + f.uid), role:'commander' }) };
  await assert.rejects(f.api().correctOneDay(f.req()), e => e.code === 'aborted');
  assert.equal(seen, 'firefighter'); assert.equal(f.db.metrics.writes, 0); assert.equal(f.events().length, 0);
});
