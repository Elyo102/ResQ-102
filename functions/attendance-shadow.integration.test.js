'use strict';

// Run only through:
// firebase emulators:exec --only firestore --project demo-resq
//   "cd functions && node attendance-shadow.integration.test.js"

const assert = require('node:assert/strict');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to run against a real project.');
  process.exit(2);
}

const functions = require('./index');
const admin = require('firebase-admin');
const engine = require('./attendance-shadow');
const runner = require('./attendance-shadow-runner');
const db = admin.firestore();
const service = runner.createAttendanceShadowService({ db: db, admin: admin });

const SID = 'eilat_102';
const SITE = 'main';
const today = engine.localDateKey(new Date());
const month = today.slice(0, 7);
let passed = 0;

function auth(uid, role, superUser) {
  return {
    uid: uid,
    token: {
      email: superUser ? 'fire102.shits@gmail.com' : uid + '@example.com',
      role: role || '',
      stationId: superUser ? '' : SID,
      shift: role ? 'A' : '',
      super: superUser === true
    }
  };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('✓ ' + name);
  } catch (error) {
    console.error('✗ ' + name);
    throw error;
  }
}

async function rejectsCode(code, promise) {
  try {
    await promise;
    assert.fail('expected callable error ' + code);
  } catch (error) {
    if (error && error.code === 'ERR_ASSERTION') throw error;
    assert.match(String(error && error.code || ''), new RegExp(code + '$'));
  }
}

function rotation(crew, position) {
  return {
    crew: crew,
    position_in_cycle: position,
    cycle_days: 3,
    anchor_date: today,
    shift_start: '07:00',
    shift_end: '07:00',
    shift_hours: 24,
    commander_start: '06:45',
    commander_shift_hours: 24.25,
    special_end: '08:00',
    special_shift_hours: 25,
    is_active: true
  };
}

function sourceInput(date) {
  const people = [
    { id: 'u_ff', full_name: 'לוחם בדיקה', role: 'firefighter', crew: 'A',
      employee_number: '101', stationId: SID, is_active: true },
    { id: 'u_hr', full_name: 'רכזת בדיקה', role: 'hr_coordinator', crew: 'A',
      employee_number: '102', stationId: SID, is_active: true }
  ];
  return {
    date: date, stationId: SID,
    users: people,
    roster: people.map(function (person) { return Object.assign({}, person); }),
    rotations: ['A', 'B', 'C'].map(function (crew, index) {
      return Object.assign({}, rotation(crew, index), { id: crew });
    }),
    board: { command: [], vehicles: [{ id: 'vehicle_1', slots: [
      { id: 'slot_ff', site: SITE }, { id: 'slot_hr', site: SITE }
    ] }] },
    subStations: [{ id: SITE, name: 'ראשית', status: 'active', fixed_hours: 0 }],
    overrides: [], swaps: [],
    shifts: { A: { assign: { slot_ff: 'u_ff', slot_hr: 'u_hr' } }, B: null, C: null },
    config: { default_sub_station: '' }
  };
}

async function seed() {
  const batch = db.batch();
  batch.set(db.doc(`stations/${SID}`), { name: 'תחנת בדיקה' });
  batch.set(db.doc(`stations/${SID}/sub_stations/${SITE}`), {
    name: 'ראשית', status: 'active', fixed_hours: 0
  });
  batch.set(db.doc(`stations/${SID}/config/board`), {
    command: [],
    vehicles: [{ id: 'vehicle_1', slots: [
      { id: 'slot_ff', site: SITE }, { id: 'slot_hr', site: SITE }
    ] }]
  });
  batch.set(db.doc(`stations/${SID}/shifts/A`), {
    assign: { slot_ff: 'u_ff', slot_hr: 'u_hr' }
  });
  ['A', 'B', 'C'].forEach(function (crew, index) {
    batch.set(db.doc(`stations/${SID}/rotations/${crew}`), rotation(crew, index));
  });
  const people = [
    { uid: 'u_ff', name: 'לוחם בדיקה', role: 'firefighter', emp: '101' },
    { uid: 'u_hr', name: 'רכזת בדיקה', role: 'hr_coordinator', emp: '102' }
  ];
  people.forEach(function (person) {
    const value = {
      full_name: person.name, role: person.role, crew: 'A',
      employee_number: person.emp, stationId: SID, is_active: true
    };
    batch.set(db.doc(`stations/${SID}/users/${person.uid}`), value);
    batch.set(db.doc(`stations/${SID}/roster/${person.uid}`), value);
    batch.set(db.doc(`stations/${SID}/attendance/${person.emp}_${today}`), {
      uid: person.uid, emp_number: person.emp, full_name: person.name,
      crew: 'A', date: today, month: month, day_type: 'regular',
      start: '07:00', end: '07:00', end_day: 1, hours: 24,
      sub_station: SITE, status: 'draft'
    });
  });
  await batch.commit();
}

async function attendanceSnapshot() {
  const snap = await db.collection(`stations/${SID}/attendance`).orderBy('__name__').get();
  return snap.docs.map(function (item) { return { id: item.id, value: item.data() }; });
}

function assertNoIdentityValues(value) {
  const forbidden = new Set([
    'לוחם בדיקה', 'רכזת בדיקה', 'u_ff@example.com', 'u_hr@example.com', '101', '102'
  ]);
  function walk(item) {
    if (Array.isArray(item)) return item.forEach(walk);
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string') assert.equal(forbidden.has(item), false,
        'PII-like source value leaked into Shadow output: ' + item);
      return;
    }
    Object.keys(item).forEach(function (key) { walk(item[key]); });
  }
  walk(value);
}

async function main() {
  await seed();
  const superUser = auth('u_super', '', true);
  const hr = auth('u_hr', 'hr_coordinator', false);
  const firefighter = auth('u_ff', 'firefighter', false);

  await test('only super can enable Shadow mode', async function () {
    await rejectsCode('permission-denied', functions.setAttendanceShadowMode.run({
      auth: hr, data: { mode: 'shadow' }
    }));
    const result = await functions.setAttendanceShadowMode.run({
      auth: superUser, data: { mode: 'shadow' }
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'shadow');
  });

  await test('status is limited to Shadow auditors', async function () {
    await rejectsCode('permission-denied', functions.getAttendanceShadowStatus.run({
      auth: firefighter, data: {}
    }));
    const status = await functions.getAttendanceShadowStatus.run({ auth: hr, data: {} });
    assert.equal(status.mode, 'shadow');
    assert.equal(status.last_run, null);
  });

  const beforeAttendance = await attendanceSnapshot();
  let first;
  await test('manual Shadow run seals a canonical capture and report', async function () {
    first = await functions.runAttendanceShadowNow.run({ auth: hr, data: {} });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.entries, 2);
    const runId = `pre_shift__${today}__v41a-1`;
    const run = await db.doc(`stations/${SID}/attendance_shadow_runs/${runId}`).get();
    assert.equal(run.data().status, 'complete');
    assert.equal(run.data().checkpoint, 2);
    const entries = await run.ref.collection('attendance_shadow_entries').get();
    assert.equal(entries.size, 2);
    entries.forEach(function (entry) {
      const value = entry.data();
      assert.equal(engine.privacySafe(value), true);
      assertNoIdentityValues(value);
      assert.match(value.input_hash, /^[a-f0-9]{64}$/);
    });
    const afterStatus = await functions.getAttendanceShadowStatus.run({ auth: hr, data: {} });
    assert.equal(afterStatus.last_run.status, 'complete');
    assert.equal(afterStatus.last_run.entry_count, 2);
    assert.deepEqual(afterStatus.last_run.result_counts, run.data().result_counts);
    assert.deepEqual(afterStatus.last_run.conflict_counts, run.data().conflict_counts);

    const report = await db.doc(
      `stations/${SID}/attendance_shadow_reports/${month}`
    ).get();
    const reportValue = report.data();
    assert.equal(reportValue.status, 'complete');
    assert.equal(reportValue.build_status, 'complete');
    // The first day of a month has no earlier snapshot days to miss, while
    // later days legitimately report missing_snapshot_days in this fixture.
    // Lock the contract instead of a calendar-dependent boolean: the gate
    // passes exactly when no blocking reason exists, and legacy_source stays
    // informational rather than becoming a hidden blocker.
    assert.equal(reportValue.gate_pass, reportValue.gate_reasons.length === 0);
    assert.equal(reportValue.gate_reasons.includes('data_warnings'), false);
    assert.equal(reportValue.auto_activation_allowed, false);
    assert.equal(reportValue.totals.legacy_source_rows, 2);
    assert.equal(reportValue.totals.blocking_warning_rows, 0);
    assert.match(reportValue.active_generation_id, /^\d{4}-\d{2}__[A-Za-z0-9_-]+$/);
    const people = await report.ref.collection('attendance_shadow_generations')
      .doc(reportValue.active_generation_id).collection('attendance_shadow_people').get();
    // Exact matches stay out of the exception list even when their older
    // attendance rows predate the informational `source` field.
    assert.equal(people.size, 0);
    people.forEach(function (person) {
      assert.equal(engine.privacySafe(person.data()), true);
      assertNoIdentityValues(person.data());
    });
  });

  await test('Shadow never changes attendance or monthly payroll reports', async function () {
    assert.deepEqual(await attendanceSnapshot(), beforeAttendance);
    const monthly = await db.collection(`stations/${SID}/monthly_reports`).get();
    assert.equal(monthly.empty, true);
  });

  await test('same-day retry is idempotent for raw evidence', async function () {
    const runId = `pre_shift__${today}__v41a-1`;
    const col = db.collection(
      `stations/${SID}/attendance_shadow_runs/${runId}/attendance_shadow_entries`
    );
    const before = (await col.orderBy('__name__').get()).docs.map(function (item) {
      return { id: item.id, value: item.data() };
    });
    const retry = await functions.runAttendanceShadowNow.run({ auth: hr, data: {} });
    assert.equal(retry.duplicate, true);
    const after = (await col.orderBy('__name__').get()).docs.map(function (item) {
      return { id: item.id, value: item.data() };
    });
    assert.deepEqual(after, before);
  });

  await test('expired owner is replaced and stale partial rows are cleaned', async function () {
    const date = engine.addDays(today, 1);
    const runId = runner.runIdFor(date);
    const plan = engine.buildDailySnapshot(sourceInput(date));
    const runRef = db.doc(`stations/${SID}/attendance_shadow_runs/${runId}`);
    await runRef.set({
      schema_version: 1, status: 'building', lease_owner: 'old_owner',
      lease_until: admin.firestore.Timestamp.fromMillis(Date.now() - 60000),
      started_at: admin.firestore.Timestamp.fromMillis(Date.now() - 120000),
      checkpoint: 0, source_digest: plan.source_digest,
      rows_digest: plan.rows_digest, target_date: date, target_month: date.slice(0, 7)
    });
    await runRef.collection('attendance_shadow_entries').doc('stale').set({
      uid: 'stale', date: date, input_hash: '0'.repeat(64)
    });
    const result = await service.runStation({
      sid: SID, date: date, trigger: 'manual', requestedBy: 'u_hr'
    });
    assert.equal(result.ok, true);
    const run = (await runRef.get()).data();
    assert.equal(run.status, 'complete');
    assert.equal(run.lease_owner, '');
    const rows = await runRef.collection('attendance_shadow_entries').get();
    assert.equal(rows.size, 2);
    assert.equal(rows.docs.some(function (item) { return item.id === 'stale'; }), false);
  });

  await test('remote swap dependencies include endpoint rest overrides', async function () {
    const target = engine.addDays(today, 3);
    const remote = engine.addDays(target, 30);
    const remoteBefore = engine.addDays(remote, -1);
    await db.doc(`stations/${SID}/swaps/remote_swap`).set({
      status: 'approved', from_uid: 'u_ff', to_uid: 'u_hr',
      from_crew: 'A', to_crew: 'A', from_date: target, to_date: remote
    });
    await db.doc(`stations/${SID}/shift_overrides/${remoteBefore}`).set({
      kind: 'standby', crew: '', extra_crews: ['A']
    });
    const result = await service.runStation({
      sid: SID, date: target, trigger: 'manual', requestedBy: 'u_hr'
    });
    assert.equal(result.ok, true);
    const runRef = db.doc(
      `stations/${SID}/attendance_shadow_runs/${runner.runIdFor(target)}`
    );
    const run = (await runRef.get()).data();
    assert.ok(run.source_counts.dependency_dates >= 6);
    const rows = await runRef.collection('attendance_shadow_entries').get();
    assert.equal(rows.size, 2);
    rows.forEach(function (item) {
      assert.ok((item.data().conflict_codes || []).includes('swap_rest_violation'));
    });
  });

  await test('future empty report can never pass the activation gate', async function () {
    const parts = today.split('-').map(Number);
    const futureMonth = new Date(Date.UTC(parts[0], parts[1] + 1, 1))
      .toISOString().slice(0, 7);
    const result = await service.rebuildReport(SID, futureMonth, today);
    assert.equal(result.gatePass, false);
    const report = (await db.doc(
      `stations/${SID}/attendance_shadow_reports/${futureMonth}`
    ).get()).data();
    assert.equal(report.gate_pass, false);
    assert.ok(report.gate_reasons.includes('future_period'));
    assert.ok(report.gate_reasons.includes('no_snapshot_runs'));
    assert.ok(report.gate_reasons.includes('no_snapshot_rows'));
  });

  await test('active report lease blocks overlap and expired build flips only a new generation', async function () {
    const reportMonth = '2099-11';
    const ref = db.doc(`stations/${SID}/attendance_shadow_reports/${reportMonth}`);
    await ref.set({
      schema_version: 1, station_id: SID, month: reportMonth,
      status: 'building', build_status: 'building', build_owner: 'old_report_owner',
      build_generation_id: 'old_build',
      build_lease_until: admin.firestore.Timestamp.fromMillis(Date.now() + 60000)
    });
    await assert.rejects(
      service.rebuildReport(SID, reportMonth, today),
      function (error) { return error && error.code === 'report-in-progress'; }
    );
    await ref.set({
      build_lease_until: admin.firestore.Timestamp.fromMillis(Date.now() - 60000)
    }, { merge: true });
    await service.rebuildReport(SID, reportMonth, today);
    const report = (await ref.get()).data();
    assert.equal(report.status, 'complete');
    assert.notEqual(report.active_generation_id, 'old_build');
    assert.equal(report.build_owner, '');
  });

  await test('oversized identifier array fails before any Shadow row is written', async function () {
    const date = engine.addDays(today, 6);
    const slots = [], assign = {};
    for (let index = 0; index < 101; index++) {
      const id = 'bulk_' + index;
      slots.push({ id: id, site: SITE });
      assign[id] = 'u_ff';
    }
    slots.push({ id: 'slot_hr', site: SITE });
    assign.slot_hr = 'u_hr';
    await db.doc(`stations/${SID}/config/board`).set({
      command: [], vehicles: [{ id: 'bulk_vehicle', slots: slots }]
    });
    await db.doc(`stations/${SID}/shifts/A`).set({ assign: assign });
    await assert.rejects(
      service.runStation({ sid: SID, date: date, trigger: 'manual', requestedBy: 'u_hr' }),
      function (error) { return error && error.code === 'invalid-shadow-entry'; }
    );
    const runRef = db.doc(
      `stations/${SID}/attendance_shadow_runs/${runner.runIdFor(date)}`
    );
    assert.equal((await runRef.get()).data().status, 'failed');
    assert.equal((await runRef.collection('attendance_shadow_entries').get()).empty, true);
  });

  await test('disabling Shadow blocks new runs without touching hours', async function () {
    await functions.setAttendanceShadowMode.run({ auth: superUser, data: { mode: 'off' } });
    await rejectsCode('failed-precondition', functions.runAttendanceShadowNow.run({
      auth: hr, data: {}
    }));
    assert.deepEqual(await attendanceSnapshot(), beforeAttendance);
  });

  console.log('\n' + passed + ' attendance Shadow integration tests passed');
}

main().then(function () { process.exit(0); }).catch(function (error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
