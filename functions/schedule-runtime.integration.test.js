'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is required; refusing to use a real project.');
  process.exit(2);
}

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-resq' });
const db = admin.firestore();
const { createCalendarEngine } = require('./schedule-calendar-engine');
const { createPublication } = require('./schedule-publication');
const { createScheduleService } = require('./schedule-service');
const { createScheduleRuntime, ScheduleRuntimeError } = require('./schedule-runtime');

const SID = 'schedule_it';
const CLOCK = () => '2026-09-01T06:00:00.000Z';
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const randomId = () => crypto.randomBytes(12).toString('hex');

function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}
function digest(value) { return hash(stable(value)); }
function compareCanonical(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : (a > b ? 1 : 0);
}

const policyBasis = {
  station_id: SID,
  version: 'policy-v1',
  sub_stations: {
    main: {
      label: 'תחנה ראשית', minimum: 2,
      requirements: [
        { role: 'driver', label: 'נהג', count: 1, required: true },
        { role: 'firefighter', label: 'לוחם', count: 1, required: true }
      ]
    }
  },
  rest: { min_gap_days: 0 },
  rotation: null,
  max_shifts_per_month: null
};

const people = [
  ['manager', { sub_station: 'main', active: true, roles: ['driver', 'firefighter'], qualifications: ['נהג'] }],
  ['viewer', { sub_station: 'main', active: true, roles: ['firefighter'], qualifications: ['לוחם'] }],
  ['driver2', { sub_station: 'main', active: true, roles: ['driver', 'firefighter'] }],
  ['fighter2', { sub_station: 'main', active: true, roles: ['firefighter'] }]
];

const events = [
  ['course_sep_1', {
    title: 'קורס בדיקה', date: '2026-09-03', hours: '08:00-12:00',
    people: ['viewer'], cancelled: false
  }]
];

const plannerOverrides = [
  { date: '2026-09-01', sub_station: 'main', person: 'viewer', role: 'firefighter' }
];

function sourceBasis() {
  return {
    station_id: SID,
    version: 'source-v1',
    revision: 'source-r1',
    carry: {},
    counts: { people: people.length, availability: 0, locked: 0, events: events.length },
    people: people.map(([id, data]) => Object.assign({ id }, data))
      .sort((a, b) => compareCanonical(a.id, b.id)),
    availability: {},
    locked: {},
    events: events.map(([id, data]) => Object.assign({ id }, data))
      .sort((a, b) => compareCanonical(a.id, b.id))
  };
}

function runtime(sendPush, hooks) {
  const testHooks = plain(hooks) ? hooks : {};
  return createScheduleRuntime({
    db,
    FieldValue: admin.firestore.FieldValue,
    FieldPath: admin.firestore.FieldPath,
    clock: CLOCK,
    hash,
    randomId,
    createEngine: createCalendarEngine,
    createPublication,
    createService: createScheduleService,
    isSuper: () => false,
    sendPush: sendPush || (async () => ({ sent: 1 })),
    // These optional hooks are a narrowly-scoped race-test seam.  Production
    // leaves them undefined; the runtime must make its own final live checks.
    beforeOutboxSend: testHooks.beforeOutboxSend,
    beforeSnapshotFinalize: testHooks.beforeSnapshotFinalize,
    beforeEffectiveViewRecheck: testHooks.beforeEffectiveViewRecheck,
    beforeLiveGuardViewRecheck: testHooks.beforeLiveGuardViewRecheck
  });
}

function req(uid, role, data, extraToken) {
  return { auth: { uid, token: Object.assign({ stationId: SID, role, name: uid }, extraToken || {}) }, data: data || {} };
}

function station() { return db.collection('stations').doc(SID); }
function activePointer() { return station().collection('schedule_state').doc('active'); }
function managerAccess() { return station().collection('schedule_access').doc('manager'); }

function outboxValue(publicationId, patch) {
  return Object.assign({
    station_id: SID,
    publication_id: publicationId,
    revision: 999,
    person: 'viewer',
    dedupe_key: 'integration_' + randomId(),
    push: { title: 'בדיקת סידור', body: 'עדכון בדיקה' },
    detail: [],
    changed_by: 'manager',
    attempt: 0,
    status: 'queued',
    expires_at: new Date('2026-10-01T00:00:00.000Z'),
    created_at: new Date('2026-09-01T06:00:00.000Z')
  }, patch || {});
}

async function settleOtherUnfinishedOutbox(keepRef) {
  const keepPath = keepRef ? keepRef.path : null;
  const snap = await db.collectionGroup('schedule_outbox').get();
  const batch = db.batch();
  let writes = 0;
  snap.docs.forEach((doc) => {
    const value = doc.data() || {};
    if (value.station_id !== SID || doc.ref.path === keepPath) return;
    if (['blocked', 'retry', 'sending', 'queued'].indexOf(value.status) === -1) return;
    batch.update(doc.ref, {
      status: 'sent', lease_token: null, lease_until: null,
      next_attempt_at: null, updated_at: admin.firestore.FieldValue.serverTimestamp()
    });
    writes += 1;
  });
  if (writes) await batch.commit();
}

// The document trigger fans out the first chunk in production; the scheduled
// recovery owns later chunks.  Calling the same runtime entry point here
// proves the large-recipient path without relying on emulator trigger timing.
async function fanoutGuardJobs(api, guardId) {
  for (let loop = 0; loop < 32; loop += 1) {
    const jobs = await station().collection('guard_notification_jobs')
      .where('guard_id', '==', guardId).get();
    let queued = 0;
    for (const job of jobs.docs) {
      const current = (await job.ref.get()).data() || {};
      if (current.status !== 'queued') continue;
      queued += 1;
      await api.fanoutGuardOutbox(job.ref);
    }
    if (!queued) return;
  }
  throw new Error('guard notification fanout did not settle');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function seed() {
  const station = db.collection('stations').doc(SID);
  await station.set({ name: 'Integration Station' });
  await Promise.all([
    station.collection('users').doc('manager').set({
      station: SID, role: 'commander', full_name: 'מנהל בדיקה'
    }),
    station.collection('users').doc('viewer').set({
      station: SID, role: 'firefighter', full_name: 'כבאי בדיקה'
    }),
    station.collection('users').doc('driver2').set({
      station: SID, role: 'firefighter', full_name: 'נהג בדיקה'
    }),
    station.collection('users').doc('fighter2').set({
      station: SID, role: 'firefighter', full_name: 'לוחם בדיקה'
    }),
    station.collection('users').doc('team_leader').set({
      station: SID, role: 'team_leader', full_name: 'מפקד צוות בדיקה'
    }),
    station.collection('users').doc('deputy_team_leader').set({
      station: SID, role: 'deputy_team_leader', full_name: 'סגן מפקד צוות בדיקה'
    }),
    station.collection('users').doc('commander').set({
      station: SID, role: 'commander', full_name: 'מפקד ללא מינוי'
    }),
    station.collection('users').doc('deputy').set({
      station: SID, role: 'deputy', full_name: 'סגן ללא מינוי'
    }),
    station.collection('users').doc('hr').set({
      station: SID, role: 'hr_coordinator', full_name: 'רכזת ללא מינוי'
    })
  ]);
  await station.collection('schedule_access').doc('manager').set({
    schema_version: 1, station_id: SID, uid: 'manager',
    roles: ['schedule_manager'], active: true, revision: 1
  });
  await station.collection('schedule_policies').doc('policy_v1').set(Object.assign({}, policyBasis, {
    complete: true,
    content_digest: digest(policyBasis)
  }));
  const source = station.collection('schedule_sources').doc('source_v1');
  const basis = sourceBasis();
  const declaredPeople = people.map(([id]) => id);
  assert.notDeepEqual(declaredPeople, basis.people.map((person) => person.id));
  assert.deepEqual(basis.people.map((person) => person.id),
    basis.people.map((person) => person.id).slice().sort(compareCanonical));
  assert.deepEqual(basis.events.map((event) => event.id),
    basis.events.map((event) => event.id).slice().sort(compareCanonical));
  await source.set({
    station_id: SID,
    version: basis.version,
    revision: basis.revision,
    complete: true,
    carry: {},
    person_count: people.length,
    availability_count: 0,
    locked_count: 0,
    event_count: events.length,
    content_digest: digest(basis)
  });
  const batch = db.batch();
  people.forEach(([id, data]) => batch.set(source.collection('people').doc(id), data));
  events.forEach(([id, data]) => batch.set(source.collection('events').doc(id), data));
  await batch.commit();
  const legacy = db.batch();
  [
    ['manager', { full_name: 'מנהל בדיקה', crew: 'A', is_active: true }],
    ['viewer', { full_name: 'כבאי בדיקה', crew: 'A', is_active: true }],
    ['driver2', { full_name: 'נהג בדיקה', crew: 'B', is_active: true }],
    ['fighter2', { full_name: 'לוחם בדיקה', crew: 'C', is_active: true }]
  ].forEach(([uid, value]) => legacy.set(station.collection('roster').doc(uid), value));
  ['A', 'B', 'C'].forEach((crew, position) => legacy.set(station.collection('rotations').doc(crew), {
    anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: position,
    crew, is_active: true
  }));
  await legacy.commit();
  await station.collection('schedule_state').doc('runtime').set({
    mode: 'shadow', active_policy_id: 'policy_v1', active_source_id: 'source_v1'
  });
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('✓ ' + name);
}

(async function run() {
  await seed();
  const api = runtime();

  await test('station spoofing is rejected before any schedule work', async () => {
    await assert.rejects(api.getStatus(req('viewer', 'firefighter', { stationId: 'other' })),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'client-station-forbidden');
  });

  await test('guard signup rejects both client station spellings before reading a guard', async () => {
    for (const field of ['stationId', 'station_id']) {
      await assert.rejects(api.signupGuard(req('viewer', 'firefighter', Object.assign({
        id: 'guard_station_spoof', join: true
      }, { [field]: 'other_station' }))),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'client-station-forbidden', field);
    }
  });

  await test('team leaders can sign up for an open guard but cannot manage it without an appointment', async () => {
    const created = await api.manageGuard(req('manager', 'commander', {
      action: 'create', request_id: 'team_leader_signup_create', details: {
        title: 'אבטחת תפקידי שטח', kind: 'other', place: '', date: '2026-09-19',
        start: '08:00', end: '12:00', slots: 2, need_quals: [], notes: ''
      }
    }));
    assert.match(created.guard_id, /^[A-Za-z0-9_-]+$/);
    const guardRef = station().collection('guards').doc(created.guard_id);
    try {
      for (const [uid, role] of [
        ['team_leader', 'team_leader'],
        ['deputy_team_leader', 'deputy_team_leader']
      ]) {
        const signup = await api.signupGuard(req(uid, role, { id: created.guard_id, join: true }));
        assert.equal(signup.changed, true, uid);
        await assert.rejects(api.manageGuard(req(uid, role, {
          action: 'cancel', request_id: 'team_leader_no_grant_' + uid,
          guard_id: created.guard_id, expected_revision: 1
        })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required', uid);
      }
      const signups = (await guardRef.get()).data().signups || {};
      assert.deepEqual(Object.keys(signups).sort(), ['deputy_team_leader', 'team_leader']);
    } finally {
      await guardRef.delete();
    }
  });

  await test('live user state is required in addition to token claims', async () => {
    await assert.rejects(api.getStatus(req('ghost', 'firefighter')),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'live-user-required');
  });

  await test('primary roles do not implicitly grant schedule editing', async () => {
    for (const [uid, role] of [['commander', 'commander'], ['deputy', 'deputy'], ['hr', 'hr_coordinator']]) {
      const status = await api.getStatus(req(uid, role));
      assert.equal(status.manager, false, uid);
      await assert.rejects(api.getManagerSetup(req(uid, role)),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    }
  });

  await test('a client-writable profile flag alone never grants schedule management', async () => {
    const viewerRef = db.doc('stations/' + SID + '/users/viewer');
    await viewerRef.update({ schedule_manager: true });
    await assert.rejects(api.runPlanner(req('viewer', 'firefighter', {
      request_id: 'self_promote', start: '2026-10-01', months: 1, overrides: []
    }, { schedule_manager: true })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    await viewerRef.update({ schedule_manager: false });
  });

  await test('a live grant enables management and a live revoke removes it without token refresh', async () => {
    const accessRef = db.doc('stations/' + SID + '/schedule_access/viewer');
    await accessRef.set({
      schema_version: 1, station_id: SID, uid: 'viewer',
      roles: ['schedule_manager'], active: true, revision: 1
    });
    assert.equal((await api.getStatus(req('viewer', 'firefighter'))).manager, true);
    await api.getManagerSetup(req('viewer', 'firefighter'));
    await accessRef.update({ roles: [], active: false, revision: 2 });
    assert.equal((await api.getStatus(req('viewer', 'firefighter'))).manager, false);
    await assert.rejects(api.runPlanner(req('viewer', 'firefighter', {
      request_id: 'revoked_manager', start: '2026-10-01', months: 1, overrides: []
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
  });

  await test('off and shadow safely expose the current station and personal legacy schedules', async () => {
    const runtimeRef = station().collection('schedule_state').doc('runtime');
    for (const mode of ['shadow', 'off']) {
      await runtimeRef.update({ mode });
      const stationView = await api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' }));
      assert.equal(stationView.mode, mode);
      assert.equal(stationView.source, 'legacy');
      assert.equal(stationView.day.date, '2026-09-01');
      assert.ok(stationView.day.sub_stations.some((block) =>
        block.people.some((person) => person.uid === 'viewer')));
      const mine = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
      assert.equal(mine.source, 'legacy');
      assert.deepEqual(mine.days.map((day) => day.date), ['2026-09-01']);
      const serialized = JSON.stringify(mine);
      assert.equal(serialized.includes('email'), false);
      assert.equal(serialized.includes('phone'), false);
      assert.equal(serialized.includes('medical'), false);
    }
    await runtimeRef.update({ mode: 'shadow' });
  });

  await test('legacy guards remain flexible while their schedule projection stays private', async () => {
    const runtimeRef = station().collection('schedule_state').doc('runtime');
    const guards = station().collection('guards');
    const inactiveRef = station().collection('roster').doc('inactive');
    const docs = [
      ['guard_empty', {
        title: 'אבטחה פתוחה', date: '2026-09-01', start: '07:00', end: '10:00',
        slots: 2, status: 'open', assigned: []
      }],
      ['guard_partial', {
        title: 'אבטחה חלקית', date: '2026-09-01', start: '12:00', end: '16:00',
        slots: 2, status: 'staffed', assigned: ['inactive', 'foreign_user']
      }],
      ['guard_mine', {
        title: 'אבטחת לילה', date: '2026-09-01', start: '22:00', end: '06:00',
        slots: 2, status: 'staffed', assigned: ['viewer', 'inactive'],
        notes: 'private notes sentinel', place: 'secret place sentinel',
        signups: { viewer: { name: 'private signup sentinel' } },
        need_quals: ['secret_qualification'], by_uid: 'guard_owner',
        by_name: 'guard owner name', kind: 'secret kind', created_at: 'not for schedule',
        future_private_field: 'future private sentinel'
      }],
      ['guard_cancelled', {
        title: 'אבטחה מבוטלת', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'cancelled', assigned: ['viewer']
      }],
      ['guard_bad_uid', {
        title: 'אבטחה פגומה', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'open', assigned: ['viewer', 'uid/bad']
      }],
      ['guard_over_capacity', {
        title: 'אבטחה מעל קיבולת', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'open', assigned: ['viewer', 'driver2']
      }],
      ['guard_foreign_station', {
        title: 'אבטחה מתחנה אחרת', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'open', station_id: 'other_102', assigned: ['viewer']
      }]
    ];
    const write = db.batch();
    write.set(inactiveRef, { full_name: 'אדם לא פעיל', crew: 'A', is_active: false });
    docs.forEach(([id, value]) => write.set(guards.doc(id), value));
    await write.commit();
    try {
      for (const mode of ['shadow', 'off']) {
        await runtimeRef.update({ mode });
        const stationView = await api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' }));
        const stationEvents = stationView.day.events || [];
        assert.deepEqual(stationEvents.map((event) => event.id).sort(),
          ['guard_empty', 'guard_mine', 'guard_partial']);
        const open = stationEvents.find((event) => event.id === 'guard_empty');
        const partial = stationEvents.find((event) => event.id === 'guard_partial');
        const mineEvent = stationEvents.find((event) => event.id === 'guard_mine');
        assert.deepEqual(open.people, []);
        assert.deepEqual(partial.people, []);
        assert.equal(mineEvent.hours, '22:00–06:00');
        assert.deepEqual(mineEvent.people, [{ person: 'כבאי בדיקה', is_me: true }]);
        assert.deepEqual(Object.keys(mineEvent.people[0]).sort(), ['is_me', 'person']);
        assert.equal(mineEvent.includes_me, true);

        const mine = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
        assert.deepEqual(mine.events.map((event) => event.id), ['guard_mine']);
        assert.deepEqual(Object.keys(mine.events[0]).sort(),
          ['answer', 'cancelled', 'change', 'date', 'hours', 'id', 'requires_answer', 'title']);
        const serialized = JSON.stringify({ stationView, mine });
        for (const secret of [
          'private notes sentinel', 'secret place sentinel', 'private signup sentinel',
          'secret_qualification', 'guard_owner', 'guard owner name', 'secret kind',
          'future private sentinel', 'inactive', 'foreign_user'
        ]) assert.equal(serialized.includes(secret), false, secret);
      }
    } finally {
      const remove = db.batch();
      remove.delete(inactiveRef);
      docs.forEach(([id]) => remove.delete(guards.doc(id)));
      await remove.commit();
      await runtimeRef.update({ mode: 'shadow' });
    }
  });

  await test('a live schedule manager can keep guards flexible without reopening a direct-write path', async () => {
    const runtimeRef = station().collection('schedule_state').doc('runtime');
    const guardCollection = station().collection('guards');
    const spy = [];
    const guardApi = runtime(async (...args) => {
      spy.push(args);
      return { sent: 1 };
    });
    const ids = [];
    await runtimeRef.update({ mode: 'off' });
    try {
      await assert.rejects(guardApi.manageGuard(req('commander', 'commander', {
        action: 'create', request_id: 'guard_unappointed_01', details: {
          title: 'לא מורשה', kind: 'other', place: '', date: '2026-09-20',
          start: '08:00', end: '12:00', slots: 1, need_quals: [], notes: ''
        }
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');

      const created = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_flexible_01', details: {
          title: 'אבטחה גמישה', kind: 'other', place: 'מקום בדיקה', date: '2026-09-20',
          start: '22:00', end: '06:00', slots: 1, need_quals: [], notes: 'הערה פנימית'
        }
      }));
      ids.push(created.guard_id);
      assert.equal(created.status, 'open');
      assert.equal(created.revision, 1);
      assert.equal(created.assigned, 0);
      const createdDoc = (await guardCollection.doc(created.guard_id).get()).data() || {};
      assert.equal(createdDoc.status, 'open');
      assert.deepEqual(createdDoc.assigned, []);
      assert.equal(createdDoc.revision, 1);

      const staffed = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_flexible_02', guard_id: created.guard_id,
        expected_revision: 1, uids: ['viewer']
      }));
      assert.equal(staffed.status, 'staffed');
      assert.equal(staffed.revision, 2);
      assert.equal(staffed.added, 1);
      const duplicate = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_flexible_02', guard_id: created.guard_id,
        expected_revision: 1, uids: ['viewer']
      }));
      assert.equal(duplicate.duplicate, true);
      assert.equal((await guardCollection.doc(created.guard_id).get()).data().revision, 2);
      await assert.rejects(guardApi.manageGuard(req('manager', 'commander', {
        action: 'reschedule', request_id: 'guard_flexible_stale', guard_id: created.guard_id,
        expected_revision: 1, details: { date: '2026-09-21' }
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'guard-revision-conflict');

      await fanoutGuardJobs(guardApi, created.guard_id);
      const assignedOutbox = await station().collection('guard_outbox').where('guard_id', '==', created.guard_id).get();
      assert.equal(assignedOutbox.size, 1);
      const firstOutbox = assignedOutbox.docs[0];
      const firstPayload = firstOutbox.data() || {};
      assert.deepEqual(Object.keys(firstPayload).filter((key) =>
        ['notes', 'place', 'title', 'assigned', 'signups', 'need_quals'].indexOf(key) !== -1), []);
      assert.equal((await guardApi.deliverGuardOutbox(firstOutbox.ref)).sent, true);
      assert.equal(spy.length, 1);
      assert.equal(spy[0][0], SID);
      assert.equal(spy[0][1], 'viewer');
      assert.equal(spy[0][2], 'guard_mine');
      assert.equal(JSON.stringify(spy[0]).includes('אבטחה גמישה'), false);
      assert.equal(JSON.stringify(spy[0]).includes('הערה פנימית'), false);

      const moved = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'reschedule', request_id: 'guard_flexible_03', guard_id: created.guard_id,
        expected_revision: 2, details: { date: '2026-09-21' }
      }));
      assert.equal(moved.status, 'staffed');
      assert.equal(moved.revision, 3);
      await fanoutGuardJobs(guardApi, created.guard_id);
      const unstaffed = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_flexible_04', guard_id: created.guard_id,
        expected_revision: 3, uids: []
      }));
      assert.equal(unstaffed.status, 'open');
      assert.equal(unstaffed.revision, 4);
      assert.equal(unstaffed.removed, 1);
      await fanoutGuardJobs(guardApi, created.guard_id);
      const cancelled = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'cancel', request_id: 'guard_flexible_05', guard_id: created.guard_id,
        expected_revision: 4
      }));
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.revision, 5);
      await assert.rejects(guardApi.manageGuard(req('manager', 'commander', {
        action: 'edit', request_id: 'guard_flexible_terminal', guard_id: created.guard_id,
        expected_revision: 5, details: { title: 'אסור' }
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'guard-terminal');

      // A removal remains meaningful after a later edit/cancellation, as long
      // as the person was not assigned again.  It is not silently lost just
      // because the event itself remains operationally flexible.
      const outboxes = await station().collection('guard_outbox').where('guard_id', '==', created.guard_id).get();
      const removed = outboxes.docs.find((doc) => {
        const value = doc.data() || {};
        return value.kind === 'removed' && Number(value.revision) === 4;
      });
      assert.ok(removed);
      assert.equal((await guardApi.deliverGuardOutbox(removed.ref)).sent, true);
      assert.equal(spy.length, 2);

      // A delayed ordinary update, in contrast, must self-cancel after a
      // later revision has replaced it.
      const stale = outboxes.docs.find((doc) => Number((doc.data() || {}).revision) === 3);
      assert.ok(stale);
      const staleResult = await guardApi.deliverGuardOutbox(stale.ref);
      assert.equal(staleResult.skipped, true);
      assert.equal((await stale.ref.get()).data().status, 'cancelled');
    } finally {
      const collections = ['guard_outbox', 'guard_notification_jobs', 'guard_operations', 'guard_audit'];
      for (const name of collections) {
        const snap = await station().collection(name).get();
        const batch = db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        if (!snap.empty) await batch.commit();
      }
      const batch = db.batch();
      ids.forEach((id) => batch.delete(guardCollection.doc(id)));
      if (ids.length) await batch.commit();
      await runtimeRef.update({ mode: 'shadow' });
    }
  });

  await test('a newly open guard uses a generic durable invitation and stays flexible', async () => {
    const guardCollection = station().collection('guards');
    const pushes = [];
    const guardApi = runtime(async (...args) => {
      pushes.push(args);
      return { sent: 1 };
    });
    const ids = [];
    try {
      const created = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_open_notice_01', details: {
          title: 'שם שאסור לדלוף', kind: 'other', place: 'מקום שאסור לדלוף',
          date: '2026-09-28', start: '18:00', end: '22:00', slots: 1,
          need_quals: [], notes: 'הערה שאסור לדלוף'
        }
      }));
      ids.push(created.guard_id);
      // The creation event is deliberately delayed until after an edit.  Its
      // original revision, not the latest one, is the retry/idempotency key.
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'reschedule', request_id: 'guard_open_notice_02',
        guard_id: created.guard_id, expected_revision: 1,
        details: { date: '2026-09-29' }
      }));
      const queued = await guardApi.enqueueGuardOpenNotifications({
        sid: SID, guard_id: created.guard_id, revision: 1
      });
      // All eight active members seeded above receive the generic invitation:
      // this is an open opportunity, not a role-specific appointment.  The
      // list is explicit so adding/removing a recipient cannot silently alter
      // the notification audience.
      assert.deepEqual(queued, { queued: 8, jobs: 1, duplicate: false });
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'reschedule', request_id: 'guard_open_notice_03',
        guard_id: created.guard_id, expected_revision: 2,
        details: { date: '2026-09-30' }
      }));
      const duplicate = await guardApi.enqueueGuardOpenNotifications({
        sid: SID, guard_id: created.guard_id, revision: 1
      });
      assert.deepEqual(duplicate, { duplicate: true, jobs: 0 });
      const jobs = await station().collection('guard_notification_jobs')
        .where('guard_id', '==', created.guard_id).get();
      assert.equal(jobs.size, 2); // manifest + one recipient chunk
      const jobDoc = jobs.docs.find((doc) => (doc.data() || {}).status === 'queued');
      const manifestDoc = jobs.docs.find((doc) => (doc.data() || {}).audience_manifest === true);
      assert.ok(jobDoc);
      assert.ok(manifestDoc);
      const job = jobDoc.data() || {};
      const manifest = manifestDoc.data() || {};
      assert.deepEqual(job.notifications.map((notice) => notice.uid), [
        'commander', 'deputy', 'deputy_team_leader', 'driver2',
        'fighter2', 'hr', 'team_leader', 'viewer'
      ]);
      assert.equal(job.notifications.every((notice) => notice.kind === 'open'), true);
      assert.equal(job.revision, 1);
      assert.equal(manifest.audience_size, 8);
      assert.equal(JSON.stringify(job).includes('שם שאסור לדלוף'), false);
      assert.equal(JSON.stringify(job).includes('מקום שאסור לדלוף'), false);
      assert.equal(JSON.stringify(job).includes('הערה שאסור לדלוף'), false);

      // A quick edit does not erase the invitation: it still directs the
      // recipient to the current schedule, while the text carries no stale
      // date, place, title or personnel data.
      await fanoutGuardJobs(guardApi, created.guard_id);
      const outbox = await station().collection('guard_outbox')
        .where('guard_id', '==', created.guard_id).get();
      assert.equal(outbox.size, 8);
      const notice = outbox.docs.find((doc) => (doc.data() || {}).recipient_uid === 'viewer');
      assert.ok(notice);
      assert.equal((notice.data() || {}).kind, 'open');
      assert.equal(JSON.stringify(notice.data()).includes('שם שאסור לדלוף'), false);
      assert.equal((await guardApi.deliverGuardOutbox(notice.ref)).sent, true);
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0][1], 'viewer');
      assert.equal(pushes[0][2], 'guard_open');
      assert.equal(pushes[0][5], './guards.html');
      assert.equal(pushes[0][6], false);
      assert.equal(JSON.stringify(pushes[0]).includes('שם שאסור לדלוף'), false);
      assert.equal(JSON.stringify(pushes[0]).includes('מקום שאסור לדלוף'), false);
      assert.equal(JSON.stringify(pushes[0]).includes('הערה שאסור לדלוף'), false);

      const cancelled = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_open_notice_04', details: {
          title: 'ביטול לפני פאנאאוט', kind: 'other', place: '',
          date: '2026-09-30', start: '08:00', end: '12:00', slots: 1,
          need_quals: [], notes: ''
        }
      }));
      ids.push(cancelled.guard_id);
      await guardApi.enqueueGuardOpenNotifications({
        sid: SID, guard_id: cancelled.guard_id, revision: 1
      });
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'cancel', request_id: 'guard_open_notice_05',
        guard_id: cancelled.guard_id, expected_revision: 1
      }));
      await fanoutGuardJobs(guardApi, cancelled.guard_id);
      const suppressed = await station().collection('guard_outbox')
        .where('guard_id', '==', cancelled.guard_id).get();
      assert.equal(suppressed.size, 0);

      const inactiveRecipient = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_open_notice_06', details: {
          title: 'נמען שעזב', kind: 'other', place: '',
          date: '2026-10-01', start: '08:00', end: '12:00', slots: 1,
          need_quals: [], notes: ''
        }
      }));
      ids.push(inactiveRecipient.guard_id);
      await guardApi.enqueueGuardOpenNotifications({
        sid: SID, guard_id: inactiveRecipient.guard_id, revision: 1
      });
      await fanoutGuardJobs(guardApi, inactiveRecipient.guard_id);
      const staleRecipient = (await station().collection('guard_outbox')
        .where('guard_id', '==', inactiveRecipient.guard_id).get()).docs
        .find((doc) => (doc.data() || {}).recipient_uid === 'viewer');
      const retryRecipient = (await station().collection('guard_outbox')
        .where('guard_id', '==', inactiveRecipient.guard_id).get()).docs
        .find((doc) => (doc.data() || {}).recipient_uid === 'driver2');
      assert.ok(staleRecipient);
      assert.ok(retryRecipient);
      const viewerRef = station().collection('users').doc('viewer');
      const viewerBefore = (await viewerRef.get()).data() || {};
      await viewerRef.update({ active: false });
      try {
        assert.deepEqual(await guardApi.deliverGuardOutbox(staleRecipient.ref), { skipped: true });
        assert.equal((await staleRecipient.ref.get()).data().status, 'cancelled');
        assert.equal(pushes.length, 1);
      } finally {
        await viewerRef.set(viewerBefore);
      }
      const driverRef = station().collection('users').doc('driver2');
      const driverBefore = (await driverRef.get()).data() || {};
      const unfinished = await station().collection('guard_outbox').get();
      const settle = db.batch();
      unfinished.docs.forEach((doc) => {
        if (doc.ref.path === retryRecipient.ref.path) return;
        const value = doc.data() || {};
        if (['queued', 'retry', 'sending'].indexOf(value.status) !== -1) {
          settle.update(doc.ref, {
            status: 'sent', lease_token: null, lease_until: null, next_attempt_at: null
          });
        }
      });
      await settle.commit();
      await driverRef.update({ active: false });
      try {
        await retryRecipient.ref.update({ status: 'retry', next_attempt_at: null });
        await guardApi.resumeGuardOutbox();
        const retryAfter = (await retryRecipient.ref.get()).data() || {};
        assert.equal(retryAfter.status, 'cancelled');
        assert.equal(retryAfter.cancel_reason, 'recipient-inactive');
        assert.equal(pushes.length, 1);
      } finally {
        await driverRef.set(driverBefore);
      }
    } finally {
      const collections = ['guard_outbox', 'guard_notification_jobs', 'guard_operations', 'guard_audit'];
      for (const name of collections) {
        const snap = await station().collection(name).get();
        const batch = db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        if (!snap.empty) await batch.commit();
      }
      const batch = db.batch();
      ids.forEach((id) => batch.delete(guardCollection.doc(id)));
      if (ids.length) await batch.commit();
    }
  });

  await test('guard signup is transactional with terminal state and preserves a dotted Firebase UID', async () => {
    const guardCollection = station().collection('guards');
    const pushes = [];
    const guardApi = runtime(async (...args) => {
      pushes.push(args);
      return { sent: 1 };
    });
    const ids = [];
    const dottedUser = station().collection('users').doc('dot.user');
    const dottedRoster = station().collection('roster').doc('dot.user');
    await Promise.all([
      dottedUser.set({ station: SID, role: 'firefighter', full_name: 'כבאי עם נקודה' }),
      dottedRoster.set({ crew: 'A', is_active: true, full_name: 'כבאי עם נקודה' })
    ]);
    try {
      const created = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_signup_atomic_01', details: {
          title: 'אבטחת הרשמה', kind: 'other', place: '', date: '2026-09-22',
          start: '08:00', end: '12:00', slots: 2, need_quals: [], notes: ''
        }
      }));
      ids.push(created.guard_id);

      const raced = await Promise.allSettled([
        guardApi.signupGuard(req('viewer', 'firefighter', { id: created.guard_id, join: true })),
        guardApi.manageGuard(req('manager', 'commander', {
          action: 'cancel', request_id: 'guard_signup_atomic_02', guard_id: created.guard_id,
          expected_revision: 1
        }))
      ]);
      assert.equal(raced[1].status, 'fulfilled');
      assert.equal((await guardCollection.doc(created.guard_id).get()).data().status, 'cancelled');
      await assert.rejects(guardApi.signupGuard(req('viewer', 'firefighter', {
        id: created.guard_id, join: false
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'guard-terminal');

      const dotted = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_signup_atomic_03', details: {
          title: 'אבטחת מזהה', kind: 'other', place: '', date: '2026-09-23',
          start: '08:00', end: '12:00', slots: 1, need_quals: [], notes: ''
        }
      }));
      ids.push(dotted.guard_id);
      const signed = await guardApi.signupGuard(req('dot.user', 'firefighter', {
        id: dotted.guard_id, join: true
      }));
      assert.equal(signed.changed, true);
      const signups = (await guardCollection.doc(dotted.guard_id).get()).data().signups || {};
      assert.ok(Object.prototype.hasOwnProperty.call(signups, 'dot.user'));
      assert.equal(Object.prototype.hasOwnProperty.call(signups, 'dot'), false);
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'reschedule', request_id: 'guard_signup_atomic_04', guard_id: dotted.guard_id,
        expected_revision: 1, details: { date: '2026-09-24' }
      }));
      await fanoutGuardJobs(guardApi, dotted.guard_id);
      const dottedOutbox = await station().collection('guard_outbox')
        .where('guard_id', '==', dotted.guard_id).get();
      assert.equal(dottedOutbox.size, 1);
      assert.equal((dottedOutbox.docs[0].data() || {}).recipient_uid, 'dot.user');
      assert.equal((await guardApi.deliverGuardOutbox(dottedOutbox.docs[0].ref)).sent, true);
      assert.equal(pushes[0][1], 'dot.user');

      // Firebase permits a dot in a UID.  Manual staffing and the epoch used
      // to supersede delayed removals must preserve that exact identity too.
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_signup_atomic_05',
        guard_id: dotted.guard_id, expected_revision: 2, uids: ['dot.user']
      }));
      const dottedLegacyView = await guardApi.getStation(req('dot.user', 'firefighter', {
        date: '2026-09-24'
      }));
      const dottedLegacyGuard = dottedLegacyView.day.events
        .find((event) => event.id === dotted.guard_id);
      assert.ok(dottedLegacyGuard);
      assert.deepEqual(dottedLegacyGuard.people, [{ person: 'כבאי עם נקודה', is_me: true }]);
      assert.equal(JSON.stringify(dottedLegacyGuard).includes('dot.user'), false);
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_signup_atomic_06',
        guard_id: dotted.guard_id, expected_revision: 3, uids: []
      }));
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_signup_atomic_07',
        guard_id: dotted.guard_id, expected_revision: 4, uids: ['dot.user']
      }));
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_signup_atomic_08',
        guard_id: dotted.guard_id, expected_revision: 5, uids: []
      }));
      await fanoutGuardJobs(guardApi, dotted.guard_id);
      const dottedGuard = (await guardCollection.doc(dotted.guard_id).get()).data() || {};
      assert.equal((dottedGuard.assignment_epochs || {})['dot.user'], 6);
      const dotRemoval = (await station().collection('guard_outbox')
        .where('guard_id', '==', dotted.guard_id).get()).docs
        .find((doc) => {
          const value = doc.data() || {};
          return value.kind === 'removed' && Number(value.revision) === 6;
        });
      assert.ok(dotRemoval);
      assert.equal((await guardApi.deliverGuardOutbox(dotRemoval.ref)).sent, true);
      assert.equal(pushes[1][1], 'dot.user');
    } finally {
      const collections = ['guard_outbox', 'guard_notification_jobs', 'guard_operations', 'guard_audit'];
      for (const name of collections) {
        const snap = await station().collection(name).get();
        const batch = db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        if (!snap.empty) await batch.commit();
      }
      const batch = db.batch();
      ids.forEach((id) => batch.delete(guardCollection.doc(id)));
      batch.delete(dottedUser);
      batch.delete(dottedRoster);
      await batch.commit();
    }
  });

  await test('a large guard signup list never blocks a flexible reschedule and fans out in chunks', async () => {
    const guardCollection = station().collection('guards');
    const guardApi = runtime();
    const guardId = 'guard_signup_fanout_401';
    const limitGuardId = 'guard_signup_limit_1000';
    const legacyGuardId = 'guard_signup_legacy_1001';
    const limitUser = station().collection('users').doc('limit_user');
    await limitUser.set({ station: SID, role: 'firefighter', full_name: 'כבאי מגבלה' });
    const atLimit = { limit_user: { at: CLOCK() } };
    for (let index = 0; index < 999; index += 1) {
      atLimit['limit_' + String(index).padStart(3, '0')] = { at: CLOCK() };
    }
    await guardCollection.doc(limitGuardId).set({
      title: 'אבטחת תקרה', kind: 'other', place: '', date: '2026-09-24',
      start: '10:00', end: '12:00', slots: 1, need_quals: [], notes: '',
      status: 'open', revision: 1, assigned: [], signups: atLimit
    });
    const signups = {};
    for (let index = 0; index < 401; index += 1) {
      signups['interest_' + String(index).padStart(3, '0')] = { at: CLOCK() };
    }
    await guardCollection.doc(guardId).set({
      title: 'אבטחת עניין רב', kind: 'other', place: '', date: '2026-09-24',
      start: '18:00', end: '22:00', slots: 2, need_quals: [], notes: '',
      status: 'open', revision: 1, assigned: [], signups
    });
    try {
      await assert.rejects(guardApi.signupGuard(req('viewer', 'firefighter', {
        id: limitGuardId, join: true
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'guard-signup-limit');
      const withdrew = await guardApi.signupGuard(req('limit_user', 'firefighter', {
        id: limitGuardId, join: false
      }));
      assert.equal(withdrew.changed, true);

      const moved = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'reschedule', request_id: 'guard_signup_fanout_01', guard_id: guardId,
        expected_revision: 1, details: { date: '2026-09-25' }
      }));
      assert.equal(moved.revision, 2);
      assert.equal(moved.notified_people, 401);
      const job = await station().collection('guard_notification_jobs')
        .where('guard_id', '==', guardId).get();
      assert.equal(job.size, 2);
      assert.deepEqual(job.docs.map((doc) => (doc.data().notifications || []).length).sort((a, b) => a - b),
        [101, 300]);

      await fanoutGuardJobs(guardApi, guardId);
      const completed = await Promise.all(job.docs.map(async (doc) => (await doc.ref.get()).data() || {}));
      assert.ok(completed.every((value) => value.status === 'complete'));
      assert.deepEqual(completed.map((value) => value.cursor).sort((a, b) => a - b), [101, 300]);
      const outbox = await station().collection('guard_outbox').where('guard_id', '==', guardId).get();
      assert.equal(outbox.size, 401);
      assert.ok(outbox.docs.every((doc) => (doc.data() || {}).status === 'queued'));

      // A historical guard can predate the signup cap.  Its cancellation is
      // still an operational action: the recipients are split into jobs, not
      // used as a reason to keep a stale guard alive.
      const legacySignups = {};
      for (let index = 0; index < 1001; index += 1) {
        legacySignups['legacy_' + String(index).padStart(4, '0')] = { at: CLOCK() };
      }
      await guardCollection.doc(legacyGuardId).set({
        title: 'אבטחה היסטורית', kind: 'other', place: '', date: '2026-09-26',
        start: '18:00', end: '22:00', slots: 1, need_quals: [], notes: '',
        status: 'open', revision: 1, assigned: [], signups: legacySignups
      });
      const cancelled = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'cancel', request_id: 'guard_signup_legacy_cancel', guard_id: legacyGuardId,
        expected_revision: 1
      }));
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.notified_people, 1001);
      const legacyJobs = await station().collection('guard_notification_jobs')
        .where('guard_id', '==', legacyGuardId).get();
      assert.equal(legacyJobs.size, 4);
      assert.equal(legacyJobs.docs.reduce((sum, doc) =>
        sum + ((doc.data().notifications || []).length), 0), 1001);
    } finally {
      const collections = ['guard_outbox', 'guard_notification_jobs', 'guard_operations', 'guard_audit'];
      for (const name of collections) {
        const snap = await station().collection(name).get();
        const batch = db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        if (!snap.empty) await batch.commit();
      }
      const batch = db.batch();
      [guardId, limitGuardId, legacyGuardId].forEach((id) => batch.delete(guardCollection.doc(id)));
      batch.delete(limitUser);
      await batch.commit();
    }
  });

  await test('a retained assignee receives the replacement update after a team change', async () => {
    const guardCollection = station().collection('guards');
    const guardApi = runtime();
    const ids = [];
    try {
      const created = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_supersession_01', details: {
          title: 'אבטחת החלפת שיבוץ', kind: 'other', place: '', date: '2026-09-26',
          start: '10:00', end: '14:00', slots: 2, need_quals: [], notes: ''
        }
      }));
      ids.push(created.guard_id);
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_supersession_02', guard_id: created.guard_id,
        expected_revision: 1, uids: ['viewer']
      }));
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_supersession_03', guard_id: created.guard_id,
        expected_revision: 2, uids: ['viewer', 'fighter2']
      }));

      // The original assignment is stale at revision 3.  The newer intent
      // must contain both the new assignee and an update for the person kept
      // on the team, rather than silently dropping that person.
      await fanoutGuardJobs(guardApi, created.guard_id);
      const outbox = await station().collection('guard_outbox')
        .where('guard_id', '==', created.guard_id).get();
      assert.equal(outbox.size, 2);
      const notices = outbox.docs.map((doc) => doc.data() || {});
      assert.ok(notices.some((item) => item.recipient_uid === 'viewer'
        && item.kind === 'updated' && Number(item.revision) === 3));
      assert.ok(notices.some((item) => item.recipient_uid === 'fighter2'
        && item.kind === 'assigned' && Number(item.revision) === 3));
      assert.equal(notices.some((item) => Number(item.revision) === 2), false);
    } finally {
      const collections = ['guard_outbox', 'guard_notification_jobs', 'guard_operations', 'guard_audit'];
      for (const name of collections) {
        const snap = await station().collection(name).get();
        const batch = db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        if (!snap.empty) await batch.commit();
      }
      const batch = db.batch();
      ids.forEach((id) => batch.delete(guardCollection.doc(id)));
      if (ids.length) await batch.commit();
    }
  });

  await test('an old removal cannot revive after the same firefighter is re-added and removed again', async () => {
    const guardCollection = station().collection('guards');
    const guardApi = runtime();
    const ids = [];
    try {
      const created = await guardApi.manageGuard(req('manager', 'commander', {
        action: 'create', request_id: 'guard_removal_epoch_01', details: {
          title: 'אבטחת רצף', kind: 'other', place: '', date: '2026-09-27',
          start: '10:00', end: '14:00', slots: 1, need_quals: [], notes: ''
        }
      }));
      ids.push(created.guard_id);
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_removal_epoch_02', guard_id: created.guard_id,
        expected_revision: 1, uids: ['viewer']
      }));
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_removal_epoch_03', guard_id: created.guard_id,
        expected_revision: 2, uids: []
      }));
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_removal_epoch_04', guard_id: created.guard_id,
        expected_revision: 3, uids: ['viewer']
      }));
      await guardApi.manageGuard(req('manager', 'commander', {
        action: 'set_assignees', request_id: 'guard_removal_epoch_05', guard_id: created.guard_id,
        expected_revision: 4, uids: []
      }));

      await fanoutGuardJobs(guardApi, created.guard_id);
      const guard = (await guardCollection.doc(created.guard_id).get()).data() || {};
      assert.equal((guard.assignment_epochs || {}).viewer, 5);
      const outbox = await station().collection('guard_outbox')
        .where('guard_id', '==', created.guard_id).get();
      assert.equal(outbox.size, 1);
      const removal = outbox.docs[0].data() || {};
      assert.equal(removal.recipient_uid, 'viewer');
      assert.equal(removal.kind, 'removed');
      assert.equal(removal.revision, 5);
      assert.equal(removal.membership_epoch, 5);
    } finally {
      const collections = ['guard_outbox', 'guard_notification_jobs', 'guard_operations', 'guard_audit'];
      for (const name of collections) {
        const snap = await station().collection(name).get();
        const batch = db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        if (!snap.empty) await batch.commit();
      }
      const batch = db.batch();
      ids.forEach((id) => batch.delete(guardCollection.doc(id)));
      if (ids.length) await batch.commit();
    }
  });

  await test('a contradictory station field in the legacy roster fails closed', async () => {
    const ref = station().collection('roster').doc('viewer');
    const before = (await ref.get()).data();
    await ref.update({ station_id: 'other_station' });
    try {
      await assert.rejects(api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'legacy-roster-station');
    } finally {
      await ref.set(before);
    }
  });

  await test('legacy roster reads accept the exact cap and reject one extra record', async () => {
    const roster = station().collection('roster');
    const atCap = [];
    for (let index = 0; index < 496; index += 1) {
      atCap.push(roster.doc('cap_' + String(index).padStart(3, '0')));
    }
    const insert = db.batch();
    atCap.forEach((ref) => insert.set(ref, { is_active: false }));
    await insert.commit();
    try {
      const accepted = await api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' }));
      assert.equal(accepted.source, 'legacy');
      const overflow = roster.doc('cap_overflow');
      await overflow.set({ is_active: false });
      try {
        await assert.rejects(api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
          (error) => error instanceof ScheduleRuntimeError && error.code === 'legacy-roster-too-large');
      } finally {
        await overflow.delete();
      }
    } finally {
      const remove = db.batch();
      atCap.forEach((ref) => remove.delete(ref));
      await remove.commit();
    }
  });

  await test('legacy guard reads reject one record above the bounded per-date cap', async () => {
    const guards = station().collection('guards');
    const refs = [];
    const write = db.batch();
    for (let index = 0; index <= 250; index += 1) {
      const ref = guards.doc('guard_cap_' + String(index).padStart(3, '0'));
      refs.push(ref);
      write.set(ref, {
        title: 'אבטחת תקרה ' + index, date: '2026-09-15', start: '08:00', end: '10:00',
        slots: 1, status: 'open', assigned: []
      });
    }
    await write.commit();
    try {
      await assert.rejects(api.getMy(req('viewer', 'firefighter', { date: '2026-09-15' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'legacy-guards-too-large');
    } finally {
      const remove = db.batch();
      refs.forEach((ref) => remove.delete(ref));
      await remove.commit();
    }
  });

  await test('a legacy override date is authoritative only in its document id', async () => {
    const ref = station().collection('shift_overrides').doc('2026-09-01');
    const before = await ref.get();
    await ref.set({ date: '2026-09-02', kind: 'swap', crew: 'A' });
    try {
      await assert.rejects(api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'legacy-override-date');
      // Station view intentionally includes yesterday/today/tomorrow, so it
      // must stop when its adjacent date is corrupt.  The personal one-day
      // view proves the mismatched payload was not silently moved to 2/9.
      const nextDay = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-02' }));
      assert.equal(nextDay.source, 'legacy');
      assert.deepEqual(nextDay.days, []);
    } finally {
      if (before.exists) await ref.set(before.data() || {});
      else await ref.delete();
    }
  });

  await test('a mode change during a legacy schedule read fails instead of returning stale data', async () => {
    const runtimeRef = station().collection('schedule_state').doc('runtime');
    await runtimeRef.update({ mode: 'shadow' });
    const racing = runtime(null, {
      beforeEffectiveViewRecheck: async (info) => {
        if (info && info.kind === 'legacy') await runtimeRef.update({ mode: 'new' });
      }
    });
    await assert.rejects(racing.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'schedule-mode-changed');
    await runtimeRef.update({ mode: 'shadow' });
  });

  let draftId;
  let previewDigest;
  await test('shadow mode creates a complete immutable draft but cannot publish', async () => {
    const made = await api.runPlanner(req('manager', 'commander', {
      request_id: 'draft_one', start: '2026-09-01', months: 1, overrides: plannerOverrides
    }));
    draftId = made.draft_id;
    assert.ok(draftId);
    const draft = await db.doc('stations/' + SID + '/schedule_drafts/' + draftId).get();
    assert.equal((draft.data() || {}).status, 'complete');
    assert.ok((draft.data() || {}).row_count > 0);
    const preview = await api.getDraftPreview(req('manager', 'commander', {
      draft_id: draftId, start: '2026-09-01'
    }));
    previewDigest = preview.expected_content_digest;
    assert.equal(preview.days.length, 7);
    assert.ok(preview.days.some((day) => day.sub_stations.length > 0));
    await assert.rejects(api.getDraftPreview(req('viewer', 'firefighter', {
      draft_id: draftId, start: '2026-09-01'
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    await assert.rejects(api.publish(req('manager', 'commander', {
      draft_id: draftId, request_id: 'publish_shadow'
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'schedule-mode-blocked');
  });

  await test('the same draft request is idempotent', async () => {
    const again = await api.runPlanner(req('manager', 'commander', {
      request_id: 'draft_one', start: '2026-09-01', months: 1, overrides: plannerOverrides
    }));
    assert.equal(again.duplicate, true);
    assert.equal(again.draft_id, draftId);
  });

  await test('a manual lock rejected after an earlier automatic assignment never stages a draft', async () => {
    const policyRef = station().collection('schedule_policies').doc('policy_v1');
    const sourceRef = station().collection('schedule_sources').doc('source_v1');
    const lockedRef = sourceRef.collection('locked').doc('main');
    const availabilityRef = sourceRef.collection('availability').doc('driver2');
    const changedPolicy = JSON.parse(JSON.stringify(policyBasis));
    changedPolicy.rest.min_gap_days = 1;
    const changedSource = sourceBasis();
    changedSource.availability = { driver2: { '2026-09-01': true } };
    changedSource.locked = {
      main: { '2026-09-02': [{ person: 'manager', role: 'driver' }] }
    };
    changedSource.counts.availability = 1;
    changedSource.counts.locked = 1;
    const requestId = 'manual_rest_rejected';
    const rejectedDraftRef = station().collection('schedule_drafts').doc(
      'd_' + hash(SID + '|manager|' + requestId).slice(0, 40));

    try {
      await policyRef.set(Object.assign({}, changedPolicy, {
        complete: true, content_digest: digest(changedPolicy)
      }));
      await lockedRef.set({ days: changedSource.locked.main });
      await availabilityRef.set({ days: changedSource.availability.driver2 });
      await sourceRef.set({
        station_id: SID,
        version: changedSource.version,
        revision: changedSource.revision,
        complete: true,
        carry: changedSource.carry,
        person_count: changedSource.counts.people,
        availability_count: changedSource.counts.availability,
        locked_count: changedSource.counts.locked,
        event_count: changedSource.counts.events,
        content_digest: digest(changedSource)
      });

      await assert.rejects(api.runPlanner(req('manager', 'commander', {
        request_id: requestId, start: '2026-09-01', months: 1, overrides: []
      })), (error) => error instanceof ScheduleRuntimeError
        && error.code === 'manual-assignment-rejected');
      assert.equal((await rejectedDraftRef.get()).exists, false,
        'a rejected manual lock must fail before staging a draft');
    } finally {
      await Promise.all([lockedRef.delete(), availabilityRef.delete()]);
      const original = sourceBasis();
      await sourceRef.set({
        station_id: SID,
        version: original.version,
        revision: original.revision,
        complete: true,
        carry: original.carry,
        person_count: original.counts.people,
        availability_count: original.counts.availability,
        locked_count: original.counts.locked,
        event_count: original.counts.events,
        content_digest: digest(original)
      });
      await policyRef.set(Object.assign({}, policyBasis, {
        complete: true, content_digest: digest(policyBasis)
      }));
    }
  });

  await test('a changed source count fails closed', async () => {
    const sourceRef = db.doc('stations/' + SID + '/schedule_sources/source_v1');
    await sourceRef.update({ person_count: people.length + 1 });
    await assert.rejects(api.runPlanner(req('manager', 'commander', {
      request_id: 'bad_count', start: '2026-10-01', months: 1, overrides: []
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'source-count-mismatch');
    await sourceRef.update({ person_count: people.length });
  });

  await test('oversized source declarations are blocked before collection reads', async () => {
    const sourceRef = db.doc('stations/' + SID + '/schedule_sources/source_v1');
    await sourceRef.update({ person_count: 20001 });
    await assert.rejects(api.runPlanner(req('manager', 'commander', {
      request_id: 'oversized_source', start: '2026-10-01', months: 1, overrides: []
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'source-count-limit');
    await sourceRef.update({ person_count: people.length });
  });

  await test('a policy changed under the same id makes an old draft stale', async () => {
    await db.doc('stations/' + SID + '/schedule_state/runtime').update({ mode: 'new' });
    const changed = JSON.parse(JSON.stringify(policyBasis));
    changed.sub_stations.main.minimum = 3;
    await db.doc('stations/' + SID + '/schedule_policies/policy_v1').set(Object.assign({}, changed, {
      complete: true, content_digest: digest(changed)
    }));
    await assert.rejects(api.publish(req('manager', 'commander', {
      draft_id: draftId, expected_content_digest: previewDigest,
      request_id: 'publish_stale_policy'
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'draft-source-changed');
    await db.doc('stations/' + SID + '/schedule_policies/policy_v1').set(Object.assign({}, policyBasis, {
      complete: true, content_digest: digest(policyBasis)
    }));
  });

  let publicationId;
  await test('new mode activates one complete publication and only then queues pushes', async () => {
    await assert.rejects(api.publish(req('manager', 'commander', {
      draft_id: draftId, request_id: 'publish_without_preview'
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'draft-preview-required');
    const result = await api.publish(req('manager', 'commander', {
      draft_id: draftId, expected_content_digest: previewDigest, request_id: 'publish_one'
    }));
    publicationId = result.publication_id;
    assert.equal(result.revision, 1);
    const active = (await db.doc('stations/' + SID + '/schedule_state/active').get()).data();
    assert.equal(active.publication_id, publicationId);
    const pub = (await db.doc('stations/' + SID + '/schedule_publications/' + publicationId).get()).data();
    assert.equal(pub.status, 'active');
    const outbox = await db.collection('stations/' + SID + '/schedule_publications/' + publicationId + '/schedule_outbox').get();
    assert.ok(outbox.size > 0);
    assert.ok(outbox.docs.every((doc) => (doc.data() || {}).status === 'queued'));
    assert.ok(outbox.docs.every((doc) => (doc.data() || {}).expires_at));
  });

  await test('publication request is idempotent after activation', async () => {
    const outbox = await db.collection('stations/' + SID + '/schedule_publications/' + publicationId + '/schedule_outbox').limit(1).get();
    await outbox.docs[0].ref.update({ status: 'blocked' });
    const result = await api.publish(req('manager', 'commander', {
      draft_id: draftId, expected_content_digest: previewDigest, request_id: 'publish_one'
    }));
    assert.equal(result.duplicate, true);
    assert.equal(result.publication_id, publicationId);
    assert.equal((await outbox.docs[0].ref.get()).data().status, 'queued');
  });

  await test('new schedule reads bind the active pointer to a complete signed publication', async () => {
    const pointerRef = station().collection('schedule_state').doc('active');
    const pointer = (await pointerRef.get()).data();
    const pubRef = station().collection('schedule_publications').doc(publicationId);
    const publication = (await pubRef.get()).data();
    const expectBlocked = async (code) => {
      await assert.rejects(api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === code);
    };
    await pointerRef.update({ revision: pointer.revision + 1 });
    await expectBlocked('active-publication-pointer-mismatch');
    await pointerRef.set(pointer);
    await pointerRef.update({ content_digest: 'wrong_digest' });
    await expectBlocked('active-publication-pointer-mismatch');
    await pointerRef.set(pointer);
    await pubRef.update({ station_id: 'other_station' });
    await expectBlocked('active-publication-invalid');
    await pubRef.set(publication);
    await pubRef.update({ snapshot_complete: false });
    await expectBlocked('active-publication-invalid');
    await pubRef.set(publication);
  });

  await test('a full publication digest is verified before a one-day view is sliced', async () => {
    const pubRef = station().collection('schedule_publications').doc(publicationId);
    const rows = await pubRef.collection('rows').where('date', '==', '2026-09-02').limit(1).get();
    assert.equal(rows.size, 1);
    const ref = rows.docs[0].ref;
    const before = (await ref.get()).data();
    const changed = JSON.parse(JSON.stringify(before));
    changed.row.slots[0].role = 'tampered_role';
    await ref.set(changed);
    try {
      await assert.rejects(api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'snapshot-digest-mismatch');
    } finally {
      await ref.set(before);
    }
  });

  await test('a mode change during a V2 schedule read fails instead of returning stale data', async () => {
    const runtimeRef = station().collection('schedule_state').doc('runtime');
    const racing = runtime(null, {
      beforeEffectiveViewRecheck: async (info) => {
        if (info && info.kind === 'v2') await runtimeRef.update({ mode: 'shadow' });
      }
    });
    await assert.rejects(racing.getMy(req('viewer', 'firefighter', { date: '2026-09-01' })),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'schedule-mode-changed');
    await runtimeRef.update({ mode: 'new' });
  });

  let assignedDate;
  await test('firefighter can read personal and station views but not run planner', async () => {
    const mine = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
    assert.equal(mine.active, true);
    assert.ok(mine.days.length > 0);
    const eventDay = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-03' }));
    assert.equal(eventDay.events.length, 1);
    assert.ok(mine.pending_answers + eventDay.pending_answers >= 2);
    assignedDate = mine.days[0].date;
    const station = await api.getStation(req('viewer', 'firefighter', { date: assignedDate }));
    assert.equal(station.active, true);
    assert.equal(station.day.date, assignedDate);
    await assert.rejects(api.runPlanner(req('viewer', 'firefighter', {
      request_id: 'forbidden', start: '2026-10-01', months: 1
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
  });

  await test('response checks the active publication and owned assignment atomically', async () => {
    const answer = await api.respond(req('viewer', 'firefighter', {
      request_id: 'answer_one', publication_id: publicationId,
      item_id: assignedDate, answer: 'confirm'
    }));
    assert.equal(answer.duplicate, false);
    const duplicate = await api.respond(req('viewer', 'firefighter', {
      request_id: 'answer_one', publication_id: publicationId,
      item_id: assignedDate, answer: 'confirm'
    }));
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(api.respond(req('viewer', 'firefighter', {
      request_id: 'answer_wrong_day', publication_id: publicationId,
      item_id: '2026-12-31', answer: 'confirm'
    })));
  });

  await test('firefighter can answer only an event assigned to them', async () => {
    const answer = await api.respond(req('viewer', 'firefighter', {
      request_id: 'event_answer_one', publication_id: publicationId,
      item_id: 'course_sep_1', answer: 'confirm'
    }));
    assert.equal(answer.duplicate, false);
    await assert.rejects(api.respond(req('viewer', 'firefighter', {
      request_id: 'event_answer_missing', publication_id: publicationId,
      item_id: 'course_not_owned', answer: 'confirm'
    })));
  });

  let secondPublicationId;
  await test('a second publication can be rolled back only by creating a new revision', async () => {
    const secondDraft = await api.runPlanner(req('manager', 'commander', {
      request_id: 'draft_two', start: '2026-09-01', months: 1,
      overrides: [{ date: '2026-09-02', sub_station: 'main', person: 'viewer', role: 'firefighter' }]
    }));
    const secondPreview = await api.getDraftPreview(req('manager', 'commander', {
      draft_id: secondDraft.draft_id, start: '2026-09-01'
    }));
    const second = await api.publish(req('manager', 'commander', {
      draft_id: secondDraft.draft_id,
      expected_content_digest: secondPreview.expected_content_digest,
      request_id: 'publish_two'
    }));
    secondPublicationId = second.publication_id;
    assert.equal(second.revision, 2);

    const targetPerson = db.doc('stations/' + SID + '/schedule_publications/'
      + publicationId + '/people/viewer');
    const originalPerson = (await targetPerson.get()).data();
    await targetPerson.update({ name: 'tampered' });
    await assert.rejects(api.rollback(req('manager', 'commander', {
      request_id: 'rollback_tampered', expected_active_publication_id: secondPublicationId,
      target_publication_id: publicationId, reason_code: 'wrong_assignment'
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'snapshot-digest-mismatch');
    await targetPerson.set(originalPerson);

    const rolled = await api.rollback(req('manager', 'commander', {
      request_id: 'rollback_one', expected_active_publication_id: secondPublicationId,
      target_publication_id: publicationId, reason_code: 'wrong_assignment'
    }));
    assert.equal(rolled.revision, 3);
    const active = (await db.doc('stations/' + SID + '/schedule_state/active').get()).data();
    assert.equal(active.publication_id, rolled.publication_id);
    assert.equal(active.previous_publication_id, secondPublicationId);
    assert.equal(active.rollback_target_publication_id, publicationId);
    const first = (await db.doc('stations/' + SID + '/schedule_publications/' + publicationId).get()).data();
    const third = (await db.doc('stations/' + SID + '/schedule_publications/' + rolled.publication_id).get()).data();
    assert.equal(third.content_digest, first.content_digest);
    assert.notEqual(rolled.publication_id, publicationId);
  });

  await test('rollback retry is idempotent and old answers are not copied', async () => {
    const active = (await db.doc('stations/' + SID + '/schedule_state/active').get()).data();
    const duplicate = await api.rollback(req('manager', 'commander', {
      request_id: 'rollback_one', expected_active_publication_id: secondPublicationId,
      target_publication_id: publicationId, reason_code: 'wrong_assignment'
    }));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.publication_id, active.publication_id);
    const mineAfter = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
    assert.ok(mineAfter.days.every((day) => !day.answer));
  });

  await test('new schedule keeps live guards flexible, private and separate from responses', async () => {
    const guards = station().collection('guards');
    const inactiveRef = station().collection('roster').doc('inactive_v2');
    const dottedUser = station().collection('users').doc('dot.user');
    const dottedRoster = station().collection('roster').doc('dot.user');
    const docs = [
      ['g_v2_empty', {
        title: 'אבטחה פתוחה', date: '2026-09-01', start: '07:00', end: '10:00',
        slots: 2, status: 'open', assigned: []
      }],
      ['g_v2_partial', {
        title: 'אבטחה חלקית', date: '2026-09-01', start: '12:00', end: '16:00',
        slots: 2, status: 'staffed', assigned: ['inactive_v2', 'foreign_user']
      }],
      ['g_v2_mine', {
        title: 'אבטחת לילה', date: '2026-09-01', start: '22:00', end: '06:00',
        slots: 2, status: 'staffed', assigned: ['viewer', 'inactive_v2'],
        notes: 'private v2 notes sentinel', place: 'secret v2 place sentinel',
        signups: { viewer: { name: 'private v2 signup sentinel' } },
        need_quals: ['secret_v2_qualification'], by_uid: 'guard_owner_v2',
        by_name: 'guard owner v2 name', kind: 'secret v2 kind',
        future_private_field: 'future v2 private sentinel'
      }],
      ['g_v2_dot', {
        title: 'אבטחת מזהה עם נקודה', date: '2026-09-01', start: '18:00', end: '20:00',
        slots: 1, status: 'staffed', assigned: ['dot.user']
      }],
      ['g_v2_cancelled', {
        title: 'אבטחה מבוטלת', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'cancelled', assigned: ['viewer']
      }],
      ['g_v2_bad_uid', {
        title: 'אבטחה פגומה', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'open', assigned: ['viewer', 'uid/bad']
      }],
      ['g_v2_over_capacity', {
        title: 'אבטחה מעל קיבולת', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'open', assigned: ['viewer', 'driver2']
      }],
      ['g_v2_foreign_station', {
        title: 'אבטחה מתחנה אחרת', date: '2026-09-01', start: '08:00', end: '09:00',
        slots: 1, status: 'open', station_id: 'other_102', assigned: ['viewer']
      }]
    ];
    const write = db.batch();
    write.set(inactiveRef, { full_name: 'אדם לא פעיל', crew: 'A', is_active: false });
    write.set(dottedUser, { station: SID, role: 'firefighter', full_name: 'כבאי עם נקודה' });
    write.set(dottedRoster, { full_name: 'כבאי עם נקודה', crew: 'A', is_active: true });
    docs.forEach(([id, value]) => write.set(guards.doc(id), value));
    await write.commit();
    try {
      const pointerBefore = (await activePointer().get()).data();
      const outboxBefore = await station().collection('schedule_publications')
        .doc(pointerBefore.publication_id).collection('schedule_outbox').get();
      const stationView = await api.getStation(req('viewer', 'firefighter', { date: '2026-09-01' }));
      assert.equal(stationView.mode, 'new');
      assert.equal(stationView.day.guards_status, 'ready');
      assert.deepEqual(stationView.day.guards.map((guard) => guard.id).sort(),
        ['g:g_v2_dot', 'g:g_v2_empty', 'g:g_v2_mine', 'g:g_v2_partial']);
      const empty = stationView.day.guards.find((guard) => guard.id === 'g:g_v2_empty');
      const partial = stationView.day.guards.find((guard) => guard.id === 'g:g_v2_partial');
      const mineGuard = stationView.day.guards.find((guard) => guard.id === 'g:g_v2_mine');
      assert.deepEqual(empty.people, []);
      assert.deepEqual(partial.people, []);
      assert.equal(mineGuard.hours, '22:00–06:00');
      assert.deepEqual(mineGuard.people, [{ person: 'כבאי בדיקה', is_me: true }]);
      assert.deepEqual(Object.keys(mineGuard.people[0]).sort(), ['is_me', 'person']);

      const dottedStationView = await api.getStation(req('dot.user', 'firefighter', { date: '2026-09-01' }));
      const dottedGuard = dottedStationView.day.guards.find((guard) => guard.id === 'g:g_v2_dot');
      assert.ok(dottedGuard);
      assert.deepEqual(dottedGuard.people, [{ person: 'כבאי עם נקודה', is_me: true }]);
      assert.equal(JSON.stringify(dottedGuard).includes('dot.user'), false);
      assert.equal(mineGuard.includes_me, true);

      const mine = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
      assert.equal(mine.guards_status, 'ready');
      assert.deepEqual(mine.guards.map((guard) => guard.id), ['g:g_v2_mine']);
      assert.deepEqual(Object.keys(mine.guards[0]).sort(), ['date', 'hours', 'id', 'title']);
      await assert.rejects(api.respond(req('viewer', 'firefighter', {
        request_id: 'guard_response_forbidden', publication_id: pointerBefore.publication_id,
        item_id: 'g:g_v2_mine', answer: 'confirm'
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'item-id');

      const serialized = JSON.stringify({ stationView, mine });
      for (const secret of [
        'private v2 notes sentinel', 'secret v2 place sentinel', 'private v2 signup sentinel',
        'secret_v2_qualification', 'guard_owner_v2', 'guard owner v2 name', 'secret v2 kind',
        'future v2 private sentinel', 'inactive_v2', 'foreign_user'
      ]) assert.equal(serialized.includes(secret), false, secret);

      await guards.doc('g_v2_mine').update({ title: 'אבטחת לילה מעודכנת' });
      const updated = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
      assert.equal(updated.guards[0].title, 'אבטחת לילה מעודכנת');
      assert.deepEqual((await activePointer().get()).data(), pointerBefore);
      assert.equal((await station().collection('schedule_publications').doc(pointerBefore.publication_id)
        .collection('schedule_outbox').get()).size, outboxBefore.size);

      // A postponement is an ordinary live guard edit: it must move between
      // dates without publishing a new immutable schedule revision.
      await guards.doc('g_v2_mine').update({ date: '2026-09-02' });
      const oldDay = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-01' }));
      const newDay = await api.getMy(req('viewer', 'firefighter', { date: '2026-09-02' }));
      assert.deepEqual(oldDay.guards, []);
      assert.deepEqual(newDay.guards.map((guard) => guard.id), ['g:g_v2_mine']);
      assert.equal(newDay.guards[0].title, 'אבטחת לילה מעודכנת');
      assert.ok((await api.getStation(req('viewer', 'firefighter', { date: '2026-09-02' })))
        .day.guards.some((guard) => guard.id === 'g:g_v2_mine'));
      assert.deepEqual((await activePointer().get()).data(), pointerBefore);
      assert.equal((await station().collection('schedule_publications').doc(pointerBefore.publication_id)
        .collection('schedule_outbox').get()).size, outboxBefore.size);

      await guards.doc('g_v2_mine').update({ status: 'cancelled' });
      const cancelled = await api.getStation(req('viewer', 'firefighter', { date: '2026-09-02' }));
      assert.equal(cancelled.day.guards.some((guard) => guard.id === 'g:g_v2_mine'), false);
      assert.deepEqual((await api.getMy(req('viewer', 'firefighter', { date: '2026-09-02' }))).guards, []);
    } finally {
      const remove = db.batch();
      remove.delete(inactiveRef);
      remove.delete(dottedUser);
      remove.delete(dottedRoster);
      docs.forEach(([id]) => remove.delete(guards.doc(id)));
      await remove.commit();
    }
  });

  await test('new schedule preserves the published view when live guard reads exceed their cap', async () => {
    const guards = station().collection('guards');
    const refs = [];
    const write = db.batch();
    for (let index = 0; index <= 250; index += 1) {
      const ref = guards.doc('g_v2_cap_' + String(index).padStart(3, '0'));
      refs.push(ref);
      write.set(ref, {
        title: 'אבטחת תקרה ' + index, date: '2026-09-15', start: '08:00', end: '10:00',
        slots: 1, status: 'open', assigned: []
      });
    }
    await write.commit();
    try {
      const stationView = await api.getStation(req('viewer', 'firefighter', { date: '2026-09-15' }));
      assert.equal(stationView.active, true);
      assert.equal(stationView.day.guards_status, 'unavailable');
      assert.deepEqual(stationView.day.guards, []);
      assert.ok(Array.isArray(stationView.day.sub_stations));
    } finally {
      const remove = db.batch();
      refs.forEach((ref) => remove.delete(ref));
      await remove.commit();
    }
  });

  await test('a V2 pointer change after the live guard sidecar fails closed', async () => {
    const pointerRef = activePointer();
    const before = (await pointerRef.get()).data() || {};
    const racing = runtime(null, {
      beforeLiveGuardViewRecheck: async (info) => {
        if (info && info.kind === 'v2-guards') await pointerRef.update({ revision: before.revision + 1 });
      }
    });
    try {
      await assert.rejects(racing.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'schedule-active-changed');
    } finally {
      await pointerRef.set(before);
    }
  });

  await test('a V2 mode change after the live guard sidecar fails closed', async () => {
    const runtimeRef = station().collection('schedule_state').doc('runtime');
    const racing = runtime(null, {
      beforeLiveGuardViewRecheck: async (info) => {
        if (info && info.kind === 'v2-guards') await runtimeRef.update({ mode: 'shadow' });
      }
    });
    try {
      await assert.rejects(racing.getMy(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'schedule-mode-changed');
    } finally {
      await runtimeRef.update({ mode: 'new' });
    }
  });

  await test('a V2 pointer change during a read fails instead of returning a stale publication', async () => {
    const pointerRef = activePointer();
    const before = (await pointerRef.get()).data() || {};
    const alternate = (await station().collection('schedule_publications').doc(publicationId).get()).data() || {};
    assert.equal(alternate.status, 'active');
    assert.equal(alternate.snapshot_complete, true);
    const racing = runtime(null, {
      beforeEffectiveViewRecheck: async (info) => {
        if (info && info.kind === 'v2') {
          await pointerRef.set(Object.assign({}, before, {
            publication_id: publicationId,
            revision: alternate.revision,
            content_digest: alternate.content_digest
          }));
        }
      }
    });
    try {
      await assert.rejects(racing.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'schedule-active-changed');
      await pointerRef.delete();
      await assert.rejects(racing.getStation(req('viewer', 'firefighter', { date: '2026-09-01' })),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'schedule-active-changed');
    } finally {
      await pointerRef.set(before);
    }
  });

  await test('inactive missing and foreign schedule recipients are cancelled before claim', async () => {
    const active = (await activePointer().get()).data() || {};
    assert.ok(active.publication_id);
    const viewerRef = station().collection('users').doc('viewer');
    const viewerBefore = (await viewerRef.get()).data() || {};
    const foreignRef = station().collection('users').doc('foreign_outbox_recipient');
    let sends = 0;
    const guarded = runtime(async () => { sends += 1; return { sent: 1 }; });
    try {
      await viewerRef.update({ active: false });
      await foreignRef.set({
        station: 'other_station', role: 'firefighter', active: true,
        full_name: 'נמען בתחנה אחרת'
      });
      for (const person of ['viewer', 'missing_outbox_recipient', 'foreign_outbox_recipient']) {
        const ref = station().collection('schedule_publications').doc(active.publication_id)
          .collection('schedule_outbox').doc('n_inactive_' + randomId());
        await ref.set(outboxValue(active.publication_id, {
          revision: Number(active.revision), status: 'queued', person
        }));
        assert.deepEqual(await guarded.deliverOutbox(ref), { skipped: true });
        const after = (await ref.get()).data() || {};
        assert.equal(after.status, 'cancelled', person);
        assert.equal(after.cancel_reason, 'recipient-inactive', person);
      }
      assert.equal(sends, 0);
    } finally {
      await viewerRef.set(viewerBefore);
      await foreignRef.delete();
    }
  });

  await test('station departure after claim is rechecked immediately before schedule push', async () => {
    const active = (await activePointer().get()).data() || {};
    assert.ok(active.publication_id);
    const viewerRef = station().collection('users').doc('viewer');
    const viewerBefore = (await viewerRef.get()).data() || {};
    const ref = station().collection('schedule_publications').doc(active.publication_id)
      .collection('schedule_outbox').doc('n_departure_race_' + randomId());
    await ref.set(outboxValue(active.publication_id, {
      revision: Number(active.revision), status: 'queued', person: 'viewer'
    }));
    await settleOtherUnfinishedOutbox(ref);
    let hooks = 0;
    let sends = 0;
    const guarded = runtime(async () => { sends += 1; return { sent: 1 }; }, {
      beforeOutboxSend: async () => {
        hooks += 1;
        await viewerRef.update({ active: false });
      }
    });
    try {
      assert.deepEqual(await guarded.deliverOutbox(ref), { skipped: true });
      const after = (await ref.get()).data() || {};
      assert.equal(hooks, 1);
      assert.equal(sends, 0);
      assert.equal(after.status, 'cancelled');
      assert.equal(after.cancel_reason, 'recipient-inactive');
    } finally {
      await viewerRef.set(viewerBefore);
    }
  });

  await test('resume cancels inactive retry and expired sending rows without resurrecting them', async () => {
    const active = (await activePointer().get()).data() || {};
    assert.ok(active.publication_id);
    const viewerRef = station().collection('users').doc('viewer');
    const viewerBefore = (await viewerRef.get()).data() || {};
    const retryRef = station().collection('schedule_publications').doc(active.publication_id)
      .collection('schedule_outbox').doc('n_inactive_retry_' + randomId());
    const sendingRef = station().collection('schedule_publications').doc(active.publication_id)
      .collection('schedule_outbox').doc('n_inactive_sending_' + randomId());
    await settleOtherUnfinishedOutbox();
    await Promise.all([
      retryRef.set(outboxValue(active.publication_id, {
        revision: Number(active.revision), status: 'retry', person: 'viewer', next_attempt_at: null
      })),
      sendingRef.set(outboxValue(active.publication_id, {
        revision: Number(active.revision), status: 'sending', person: 'viewer',
        lease_token: 'expired-recipient', lease_until: new Date('2026-08-31T00:00:00.000Z')
      }))
    ]);
    let sends = 0;
    const guarded = runtime(async () => { sends += 1; return { sent: 1 }; });
    try {
      await viewerRef.update({ active: false });
      await guarded.resumeOutbox();
      for (const ref of [retryRef, sendingRef]) {
        const after = (await ref.get()).data() || {};
        assert.equal(after.status, 'cancelled');
        assert.equal(after.cancel_reason, 'recipient-inactive');
      }
      await viewerRef.set(viewerBefore);
      await guarded.resumeOutbox();
      assert.equal((await retryRef.get()).data().status, 'cancelled');
      assert.equal((await sendingRef.get()).data().status, 'cancelled');
      assert.equal(sends, 0);
    } finally {
      await viewerRef.set(viewerBefore);
    }
  });

  await test('zero delivered devices is retried and is never marked sent', async () => {
    const active = (await db.doc('stations/' + SID + '/schedule_state/active').get()).data();
    const outbox = await db.collection('stations/' + SID + '/schedule_publications/'
      + active.publication_id + '/schedule_outbox').limit(1).get();
    assert.ok(outbox.size > 0);
    await outbox.docs[0].ref.update({ status: 'queued' });
    const result = await runtime(async () => ({ sent: 0 })).deliverOutbox(outbox.docs[0].ref);
    assert.equal(result.sent, false);
    assert.equal((await outbox.docs[0].ref.get()).data().status, 'retry');
  });

  await test('off and shadow cancel queued retry and expired sending pushes before delivery', async () => {
    const active = (await db.doc('stations/' + SID + '/schedule_state/active').get()).data();
    const outbox = await db.collection('stations/' + SID + '/schedule_publications/'
      + active.publication_id + '/schedule_outbox').limit(1).get();
    assert.ok(outbox.size > 0);
    const ref = outbox.docs[0].ref;
    let sendCalls = 0;
    const gated = runtime(async () => { sendCalls += 1; return { sent: 1 }; });
    for (const mode of ['off', 'shadow']) {
      await db.doc('stations/' + SID + '/schedule_state/runtime').update({ mode });
      for (const status of ['queued', 'retry', 'sending']) {
        await ref.update({
          status,
          next_attempt_at: null,
          lease_token: status === 'sending' ? 'expired-' + mode : null,
          lease_until: status === 'sending' ? new Date('2026-08-30T00:00:00.000Z') : null,
          cancel_reason: null
        });
        if (status === 'queued') await gated.deliverOutbox(ref);
        else await gated.resumeOutbox();
        const after = (await ref.get()).data();
        assert.equal(after.status, 'cancelled', mode + '/' + status);
        assert.equal(after.cancel_reason, 'runtime-not-new', mode + '/' + status);
      }
    }
    assert.equal(sendCalls, 0);
    await db.doc('stations/' + SID + '/schedule_state/runtime').update({ mode: 'new' });
  });

  await test('an expired sending lease is recovered instead of losing the push forever', async () => {
    const active = (await db.doc('stations/' + SID + '/schedule_state/active').get()).data();
    const outbox = await db.collection('stations/' + SID + '/schedule_publications/'
      + active.publication_id + '/schedule_outbox').limit(1).get();
    assert.ok(outbox.size > 0);
    await outbox.docs[0].ref.update({
      status: 'sending', lease_token: 'stale', lease_until: new Date('2026-08-30T00:00:00.000Z')
    });
    await api.resumeOutbox();
    assert.equal((await outbox.docs[0].ref.get()).data().status, 'queued');
  });

  await test('outbox delivery is cancelled if publication is no longer active', async () => {
    const outbox = await db.collection('stations/' + SID + '/schedule_publications/' + publicationId + '/schedule_outbox').limit(1).get();
    const ref = outbox.docs[0].ref;
    await ref.update({ status: 'queued' });
    const result = await api.deliverOutbox(ref);
    assert.equal(result.skipped, true);
    assert.equal((await ref.get()).data().status, 'cancelled');
  });

  await test('a blocked notification for a staging publication survives outbox resume', async () => {
    const before = (await activePointer().get()).data() || {};
    const stagedId = 'p_stage_' + randomId();
    const stagedRef = station().collection('schedule_publications').doc(stagedId);
    const ref = stagedRef.collection('schedule_outbox').doc('n_stage_' + randomId());
    await stagedRef.set({
      station_id: SID, status: 'staging', operation: 'publish',
      created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    await ref.set(outboxValue(stagedId, { status: 'blocked' }));
    await settleOtherUnfinishedOutbox(ref);
    let sends = 0;
    await runtime(async () => { sends += 1; return { sent: 1 }; }).resumeOutbox();
    const after = (await ref.get()).data() || {};
    assert.equal(after.status, 'blocked');
    assert.equal(sends, 0);
    assert.equal((await activePointer().get()).data().publication_id, before.publication_id);
  });

  await test('an expired notification is cancelled before delivery or resume can send it', async () => {
    const active = (await activePointer().get()).data() || {};
    assert.ok(active.publication_id);
    const ref = station().collection('schedule_publications').doc(active.publication_id)
      .collection('schedule_outbox').doc('n_expired_' + randomId());
    let sends = 0;
    const guarded = runtime(async () => { sends += 1; return { sent: 1 }; });
    await ref.set(outboxValue(active.publication_id, {
      revision: Number(active.revision), status: 'queued',
      expires_at: new Date('2026-08-31T23:59:59.000Z')
    }));
    await settleOtherUnfinishedOutbox(ref);
    await guarded.deliverOutbox(ref);
    let after = (await ref.get()).data() || {};
    assert.equal(after.status, 'cancelled');
    assert.equal(sends, 0);

    await ref.set(outboxValue(active.publication_id, {
      revision: Number(active.revision), status: 'retry', next_attempt_at: null,
      expires_at: new Date('2026-08-31T23:59:59.000Z')
    }));
    await guarded.resumeOutbox();
    after = (await ref.get()).data() || {};
    assert.equal(after.status, 'cancelled');
    assert.equal(sends, 0);
  });

  await test('a pointer change after claim and before send cancels the notification without sending', async () => {
    const pointerRef = activePointer();
    const before = (await pointerRef.get()).data() || {};
    assert.ok(before.publication_id);
    const ref = station().collection('schedule_publications').doc(before.publication_id)
      .collection('schedule_outbox').doc('n_pointer_race_' + randomId());
    await ref.set(outboxValue(before.publication_id, {
      revision: Number(before.revision), status: 'queued'
    }));
    await settleOtherUnfinishedOutbox(ref);
    let hooks = 0;
    let sends = 0;
    const guarded = runtime(async () => { sends += 1; return { sent: 1 }; }, {
      beforeOutboxSend: async () => {
        hooks += 1;
        await pointerRef.set(Object.assign({}, before, {
          publication_id: 'p_pointer_changed_' + randomId()
        }));
      }
    });
    try {
      await guarded.deliverOutbox(ref);
      const after = (await ref.get()).data() || {};
      assert.equal(hooks, 1);
      assert.equal(sends, 0);
      assert.equal(after.status, 'cancelled');
    } finally {
      await pointerRef.set(before);
    }
  });

  await test('concurrent outbox resumes claim a queued notification only once', async () => {
    const active = (await activePointer().get()).data() || {};
    assert.ok(active.publication_id);
    const ref = station().collection('schedule_publications').doc(active.publication_id)
      .collection('schedule_outbox').doc('n_concurrent_' + randomId());
    await ref.set(outboxValue(active.publication_id, {
      revision: Number(active.revision), status: 'queued'
    }));
    await settleOtherUnfinishedOutbox(ref);
    const entered = deferred();
    const release = deferred();
    let sends = 0;
    const concurrent = runtime(async () => {
      sends += 1;
      entered.resolve();
      await release.promise;
      return { sent: 1 };
    });
    const first = concurrent.resumeOutbox();
    const second = concurrent.resumeOutbox();
    try {
      await within(entered.promise, 5000, 'concurrent outbox send');
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(sends, 1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    assert.equal(sends, 1);
    assert.equal(((await ref.get()).data() || {}).status, 'sent');
  });

  await test('revocation during snapshot finalization leaves no complete draft or active publication', async () => {
    const accessRef = managerAccess();
    const accessBefore = (await accessRef.get()).data() || {};
    const activeBefore = (await activePointer().get()).data() || {};
    const revoked = Object.assign({}, accessBefore, {
      roles: [], active: false, revision: Number(accessBefore.revision || 0) + 1
    });

    const draftRequest = 'revoke_draft_finalize_' + randomId();
    const draftId = 'd_' + hash(SID + '|manager|' + draftRequest).slice(0, 40);
    const draftRef = station().collection('schedule_drafts').doc(draftId);
    let draftFinalizers = 0;
    const draftRuntime = runtime(null, {
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'draft') return;
        draftFinalizers += 1;
        await accessRef.set(revoked);
      }
    });
    try {
      await assert.rejects(draftRuntime.runPlanner(req('manager', 'commander', {
        request_id: draftRequest, start: '2026-11-01', months: 1, overrides: []
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-revoked');
      assert.equal(draftFinalizers, 1);
      const draftSnap = await draftRef.get();
      const stagedDraft = draftSnap.exists ? draftSnap.data() || {} : {};
      assert.notEqual(stagedDraft.status, 'complete');
      assert.notEqual(stagedDraft.status, 'active');
      assert.equal((await activePointer().get()).data().publication_id, activeBefore.publication_id);
      const draftQueued = await draftRef.collection('schedule_outbox').where('status', '==', 'queued').get();
      assert.equal(draftQueued.size, 0);
    } finally {
      await accessRef.set(accessBefore);
    }

    const publishDraft = await api.runPlanner(req('manager', 'commander', {
      request_id: 'revoke_publish_draft_' + randomId(), start: '2026-11-01', months: 1, overrides: []
    }));
    const preview = await api.getDraftPreview(req('manager', 'commander', {
      draft_id: publishDraft.draft_id, start: '2026-11-01'
    }));
    const publishRequest = 'revoke_publish_finalize_' + randomId();
    const publicationIdDuringRevoke = 'p_' + hash(SID + '|manager|' + publishRequest).slice(0, 40);
    const publicationRef = station().collection('schedule_publications').doc(publicationIdDuringRevoke);
    let publicationFinalizers = 0;
    const publicationRuntime = runtime(null, {
      beforeSnapshotFinalize: async (info) => {
        if (!info || info.kind !== 'publication') return;
        publicationFinalizers += 1;
        await accessRef.set(revoked);
      }
    });
    try {
      await assert.rejects(publicationRuntime.publish(req('manager', 'commander', {
        draft_id: publishDraft.draft_id,
        expected_content_digest: preview.expected_content_digest,
        request_id: publishRequest
      })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-revoked');
      assert.equal(publicationFinalizers, 1);
      const publicationSnap = await publicationRef.get();
      const stagedPublication = publicationSnap.exists ? publicationSnap.data() || {} : {};
      assert.notEqual(stagedPublication.status, 'complete');
      assert.notEqual(stagedPublication.status, 'active');
      assert.equal((await activePointer().get()).data().publication_id, activeBefore.publication_id);
      const queued = await publicationRef.collection('schedule_outbox').where('status', '==', 'queued').get();
      assert.equal(queued.size, 0);
    } finally {
      await accessRef.set(accessBefore);
    }
  });

  assert.equal(passed, 53);
  console.log('\n53 schedule runtime Firestore integration checks passed.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
