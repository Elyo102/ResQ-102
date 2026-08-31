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
const MANAGER_VERSION = 'sm_manager_v20260901_0001';
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

function runtime(sendPush, isSuper) {
  return createScheduleRuntime({
    db,
    FieldValue: admin.firestore.FieldValue,
    clock: CLOCK,
    hash,
    randomId,
    createEngine: createCalendarEngine,
    createPublication,
    createService: createScheduleService,
    isSuper: isSuper || (() => false),
    sendPush: sendPush || (async () => ({ sent: 1 }))
  });
}

function req(uid, role, data, tokenExtra) {
  const managerGrant = uid === 'manager' ? {
    schedule_manager: true,
    schedule_manager_version: MANAGER_VERSION
  } : {};
  return {
    auth: { uid, token: Object.assign({ stationId: SID, role, name: uid }, managerGrant, tokenExtra || {}) },
    data: data || {}
  };
}

async function seed() {
  const station = db.collection('stations').doc(SID);
  await station.set({ name: 'Integration Station' });
  await Promise.all([
    station.collection('users').doc('manager').set({
      // writeProfile in the existing identity coordinator uses this historical
      // field name. The runtime must support it without weakening alias checks.
      station: SID, role: 'commander', full_name: 'מנהל בדיקה'
    }),
    station.collection('users').doc('viewer').set({
      stationId: SID, role: 'firefighter', full_name: 'כבאי בדיקה'
    }),
    station.collection('users').doc('commander_without_grant').set({
      stationId: SID, role: 'commander', full_name: 'מפקד ללא מינוי'
    }),
    station.collection('users').doc('super_without_grant').set({
      stationId: SID, role: 'super_admin', full_name: 'מנהל-על ללא מינוי'
    }),
    station.collection('users').doc('super_with_stale_manager').set({
      stationId: SID, role: 'super_admin', full_name: 'מנהל-על עם מינוי ישן'
    }),
    db.collection('schedule_manager_grants').doc('manager').set({
      uid: 'manager', stationId: SID, active: true, version: MANAGER_VERSION
    }),
    db.collection('schedule_manager_grants').doc('super_with_stale_manager').set({
      uid: 'super_with_stale_manager', stationId: SID, active: true, version: MANAGER_VERSION
    })
  ]);
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

  await test('live user state is required in addition to token claims', async () => {
    await assert.rejects(api.getStatus(req('ghost', 'firefighter')),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'live-user-required');
  });

  await test('every supported station alias works for existing station members', async () => {
    const users = db.collection('stations').doc(SID).collection('users');
    for (const [uid, alias] of [
      ['alias_station_id', { stationId: SID }],
      ['alias_station_id_legacy', { station_id: SID }],
      ['alias_station_legacy', { station: SID }]
    ]) {
      await users.doc(uid).set(Object.assign({ role: 'firefighter', full_name: uid }, alias));
      const status = await api.getStatus(req(uid, 'firefighter'));
      assert.equal(status.manager, false);
    }
    const managerStatus = await api.getStatus(req('manager', 'commander'));
    assert.equal(managerStatus.manager, true);
  });

  await test('missing, malformed, or conflicting station aliases are rejected', async () => {
    const users = db.collection('stations').doc(SID).collection('users');
    for (const [uid, profile] of [
      ['missing_station_alias', {}],
      ['malformed_station_alias', { station: 'not a station id' }],
      ['conflict_station_and_id', { station: SID, stationId: 'other_99' }],
      ['conflict_station_and_legacy_id', { station: SID, station_id: 'other_99' }],
      ['conflict_station_ids', { stationId: SID, station_id: 'other_99' }]
    ]) {
      await users.doc(uid).set(Object.assign({ role: 'firefighter', full_name: uid }, profile));
      await assert.rejects(api.getStatus(req(uid, 'firefighter')),
        (error) => error instanceof ScheduleRuntimeError && error.code === 'live-user-inactive');
    }
  });

  await test('a client-writable profile flag alone never grants schedule management', async () => {
    const viewerRef = db.doc('stations/' + SID + '/users/viewer');
    await viewerRef.update({ schedule_manager: true });
    await assert.rejects(api.runPlanner(req('viewer', 'firefighter', {
      request_id: 'self_promote', start: '2026-10-01', months: 1, overrides: []
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    await viewerRef.update({ schedule_manager: false });
  });

  await test('schedule management requires an exact signed claim and matching live grant', async () => {
    const request = { request_id: 'grant_required', start: '2026-10-01', months: 1, overrides: [] };
    await assert.rejects(api.runPlanner(req('viewer', 'firefighter', request, {
      schedule_manager: true,
      schedule_manager_version: MANAGER_VERSION
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    await assert.rejects(api.runPlanner(req('manager', 'commander', request, {
      schedule_manager: 'true',
      schedule_manager_version: MANAGER_VERSION
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    await assert.rejects(api.runPlanner(req('manager', 'commander', request, {
      schedule_manager: true,
      schedule_manager_version: 'sm_manager_v20260901_replaced'
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
  });

  await test('a commander or super user without the additional appointment cannot edit', async () => {
    const request = { request_id: 'rank_is_not_schedule_authority', start: '2026-10-01', months: 1, overrides: [] };
    await assert.rejects(api.runPlanner(req('commander_without_grant', 'commander', request)),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    const elevated = runtime(undefined, (auth) => auth && auth.token && auth.token.super === true);
    await assert.rejects(elevated.getManagerSetup(req('super_without_grant', 'super_admin', {}, { super: true })),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
    await assert.rejects(elevated.getManagerSetup(req('super_with_stale_manager', 'super_admin', {}, {
      super: true, schedule_manager: true, schedule_manager_version: MANAGER_VERSION
    })), (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
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

  await test('revoking the live grant blocks an already-issued manager token immediately', async () => {
    await db.collection('schedule_manager_grants').doc('manager').update({ active: false });
    await assert.rejects(api.getManagerSetup(req('manager', 'commander')),
      (error) => error instanceof ScheduleRuntimeError && error.code === 'manager-required');
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

  assert.equal(passed, 24);
  console.log('\n24 schedule runtime Firestore integration checks passed.');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
