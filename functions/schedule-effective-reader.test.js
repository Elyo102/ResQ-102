'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MODE,
  ScheduleEffectiveReaderError,
  createScheduleEffectiveReader
} = require('./schedule-effective-reader');
const { createOperationalProjection } = require('./schedule-operational-projection');

const SID = 'eilat_102';
const UID = 'alpha';
const DIGEST = 'digest_active_1';
let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('✓ ' + name);
}

async function rejects(action, code) {
  await assert.rejects(action, (error) => error instanceof ScheduleEffectiveReaderError && error.code === code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function request(extra) {
  return {
    auth: { uid: UID, token: { stationId: SID } },
    data: Object.assign({ from: '2026-09-01', to: '2026-09-03' }, extra || {})
  };
}

function roster() {
  return [
    {
      uid: 'alpha', station_id: SID, crew: 'A', active: true, display: 'אלון',
      email: 'alpha@example.test', phone: '0500000000', note: 'never return', medical: 'never return'
    },
    {
      uid: 'bravo', station_id: SID, crew: 'B', active: true, display_name: 'ברק',
      email: 'bravo@example.test', reason: 'not for output'
    },
    { uid: 'charlie', station_id: SID, crew: 'C', active: true, display: 'כרמל' }
  ];
}

function rotations() {
  return [
    { id: 'A', crew: 'A', anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: 0, is_active: true },
    { id: 'B', crew: 'B', anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: 1, is_active: true },
    { id: 'C', crew: 'C', anchor_date: '2026-09-01', cycle_days: 3, position_in_cycle: 2, is_active: true }
  ];
}

function legacyPayload(extra) {
  return Object.assign({
    station_id: SID,
    roster: roster(),
    events: [],
    legacy: {
      rotations: rotations(),
      overrides: [],
      swaps: [],
      availability: { alpha: { '2026-09-02': { reason: 'medical' } } }
    }
  }, extra || {});
}

function v2Plan() {
  return {
    kind: 'schedule-plan', station_id: SID,
    from: '2026-09-01', to: '2026-09-03',
    rows: [
      {
        date: '2026-09-01', station_id: SID, sub_station: 'main', note: 'private row note', slots: [
          { person: 'alpha', role: 'driver', email: 'slot@example.test', medical_note: 'private' }
        ]
      },
      { date: '2026-09-02', station_id: SID, sub_station: 'main', slots: [{ person: 'bravo', role: 'firefighter' }] },
      { date: '2026-09-03', station_id: SID, sub_station: 'main', slots: [{ person: 'charlie', role: 'firefighter' }] }
    ]
  };
}

function activePayload(extra) {
  const value = {
    pointer: { station_id: SID, publication_id: 'pub_1', revision: 7, content_digest: DIGEST },
    publication: {
      id: 'pub_1', publication_id: 'pub_1', station_id: SID, status: 'active', snapshot_complete: true,
      revision: 7, content_digest: DIGEST
    },
    snapshot: { publication_id: 'pub_1', content_digest: DIGEST, plan: v2Plan(), roster: roster() }
  };
  return Object.assign(value, extra || {});
}

function harness(overrides) {
  const calls = { context: 0, runtime: 0, legacy: 0, active: 0 };
  const options = overrides || {};
  const supplied = (key, fallback) => Object.prototype.hasOwnProperty.call(options, key)
    ? options[key] : fallback;
  const state = {
    context: supplied('context', { station_id: SID, uid: UID, active: true }),
    runtime: supplied('runtime', { mode: MODE.SHADOW }),
    legacy: supplied('legacy', legacyPayload()),
    active: supplied('active', activePayload())
  };
  const reader = createScheduleEffectiveReader({
    resolveLiveContext: async () => {
      calls.context += 1;
      return typeof state.context === 'function' ? state.context() : state.context;
    },
    readRuntime: async (ctx) => {
      calls.runtime += 1;
      assert.equal(ctx.station_id, SID);
      return typeof state.runtime === 'function' ? state.runtime(ctx) : state.runtime;
    },
    readLegacy: async (ctx, range) => {
      calls.legacy += 1;
      assert.equal(ctx.station_id, SID);
      assert.match(range.from, /^2026-09-/);
      return typeof state.legacy === 'function' ? state.legacy(ctx, range) : state.legacy;
    },
    readActivePublication: async (ctx, range) => {
      calls.active += 1;
      assert.equal(ctx.station_id, SID);
      assert.match(range.to, /^2026-09-/);
      return typeof state.active === 'function' ? state.active(ctx, range) : state.active;
    },
    createOperationalProjection
  });
  return { reader, calls, state };
}

async function main() {
  await test('off and shadow use legacy only and carry legacy provenance', async () => {
    for (const mode of [MODE.OFF, MODE.SHADOW]) {
      const h = harness({ runtime: { mode } });
      const out = await h.reader.getStation(request());
      assert.equal(out.kind, 'schedule-effective-station-window');
      assert.equal(out.source, 'legacy');
      assert.deepEqual(out.provenance, {
        mode, source: 'legacy', publication_id: null, revision: null, content_digest: null
      });
      assert.equal(h.calls.legacy, 1);
      assert.equal(h.calls.active, 0);
    }
  });

  await test('off and shadow personal windows expose only the requester and no private fields', async () => {
    for (const mode of [MODE.OFF, MODE.SHADOW]) {
      const h = harness({ runtime: { mode } });
      const mine = await h.reader.getMy(request());
      assert.deepEqual(mine.days.map((day) => day.assignments.map((assignment) => assignment.uid)), [
        ['alpha'], [], []
      ]);
      const serialized = JSON.stringify(mine);
      ['bravo@example.test', '0500000000', 'never return', 'medical', 'reason'].forEach((secret) =>
        assert.equal(serialized.includes(secret), false));
      assert.equal(h.calls.legacy, 1);
      assert.equal(h.calls.active, 0);
    }
  });

  await test('legacy guard events are allowlisted for station and narrowed for my view', async () => {
    const legacy = legacyPayload({
      events: [{
        id: 'guard_1', date: '2026-09-01', title: 'אבטחת לילה',
        start: '22:00', end: '06:00', status: 'open',
        people: [{ uid: 'alpha', display: 'אלון' }, { uid: 'bravo', display: 'ברק' }]
      }]
    });
    const h = harness({ legacy });
    const station = await h.reader.getStation(request());
    const mine = await h.reader.getMy(request());
    assert.deepEqual(station.events.map((event) => event.id), ['guard_1']);
    assert.deepEqual(Object.keys(station.events[0]).sort(),
      ['date', 'end', 'id', 'people', 'start', 'status', 'title']);
    assert.deepEqual(station.events[0].people.map((person) => person.uid), ['alpha', 'bravo']);
    assert.deepEqual(mine.events.map((event) => event.id), ['guard_1']);
    assert.deepEqual(mine.events[0].people.map((person) => person.uid), ['alpha']);
    assert.equal(JSON.stringify(mine.events).includes('bravo'), false);
  });

  await test('the effective reader rejects a raw or cancelled guard event instead of leaking it', async () => {
    const raw = legacyPayload({
      events: [{
        id: 'guard_1', date: '2026-09-01', title: 'אבטחה',
        start: '18:00', end: '23:00', status: 'open',
        people: [], notes: 'private sentinel'
      }]
    });
    await rejects(() => harness({ legacy: raw }).reader.getStation(request()), 'projection-event');
    const cancelled = legacyPayload({
      events: [{
        id: 'guard_1', date: '2026-09-01', title: 'אבטחה',
        start: '18:00', end: '23:00', status: 'cancelled', people: []
      }]
    });
    await rejects(() => harness({ legacy: cancelled }).reader.getStation(request()), 'projection-event-status');
  });

  await test('station, uid and publication selectors are rejected before context resolution', async () => {
    const h = harness();
    await rejects(() => h.reader.getMy(request({ station_id: 'other_102' })), 'request-shape');
    await rejects(() => h.reader.getMy(request({ uid: 'bravo' })), 'request-shape');
    await rejects(() => h.reader.getMy(request({ publication_id: 'pub_other' })), 'request-shape');
    assert.equal(h.calls.context, 0);
    assert.equal(h.calls.runtime, 0);
  });

  await test('legacy input must carry the exact server-derived station', async () => {
    const missing = legacyPayload();
    delete missing.station_id;
    await rejects(() => harness({ legacy: missing }).reader.getStation(request()), 'legacy-source-invalid-station');
    const foreign = legacyPayload({ station_id: 'other_102' });
    await rejects(() => harness({ legacy: foreign }).reader.getStation(request()), 'legacy-source-invalid-station');
  });

  await test('an inactive server context is denied before a source read', async () => {
    const h = harness({ context: { station_id: SID, uid: UID, active: false } });
    await rejects(() => h.reader.getStation(request()), 'context-inactive');
    assert.equal(h.calls.runtime, 0);
    assert.equal(h.calls.legacy, 0);
    assert.equal(h.calls.active, 0);
  });

  await test('new mode accepts only an active complete snapshot with matching pointer and digests', async () => {
    const h = harness({ runtime: { mode: MODE.NEW } });
    const out = await h.reader.getStation(request());
    assert.equal(out.source, 'v2');
    assert.deepEqual(out.provenance, {
      mode: MODE.NEW, source: 'v2', publication_id: 'pub_1', revision: 7, content_digest: DIGEST
    });
    assert.deepEqual(out.days[0].assignments, [{
      uid: 'alpha', display: 'אלון', sub_station: 'main', role: 'driver', source: 'v2'
    }]);
    assert.equal(h.calls.active, 1);
    assert.equal(h.calls.legacy, 0);
  });

  await test('new mode has no legacy fallback for missing or invalid active snapshots', async () => {
    const missing = harness({ runtime: { mode: MODE.NEW }, active: null });
    await rejects(() => missing.reader.getStation(request()), 'active-publication-missing');
    assert.equal(missing.calls.legacy, 0);

    const invalid = activePayload();
    invalid.publication.status = 'staging';
    const staging = harness({ runtime: { mode: MODE.NEW }, active: invalid });
    await rejects(() => staging.reader.getStation(request()), 'active-publication-invalid');
    assert.equal(staging.calls.legacy, 0);

    const digestMismatch = activePayload();
    digestMismatch.snapshot.content_digest = 'different_digest';
    const badDigest = harness({ runtime: { mode: MODE.NEW }, active: digestMismatch });
    await rejects(() => badDigest.reader.getStation(request()), 'active-publication-digest-mismatch');
    assert.equal(badDigest.calls.legacy, 0);
  });

  await test('new mode never falls back when an otherwise signed snapshot fails projection', async () => {
    const corrupt = activePayload();
    corrupt.snapshot.plan.rows[0].slots.push({ person: 'alpha', role: 'firefighter' });
    const h = harness({ runtime: { mode: MODE.NEW }, active: corrupt });
    await assert.rejects(() => h.reader.getStation(request()), (error) =>
      error && error.code === 'plan-person-duplicate-day');
    assert.equal(h.calls.legacy, 0);
  });

  await test('new mode rejects a mismatched pointer chain and an unlisted V2 slot', async () => {
    const wrongPointer = activePayload();
    wrongPointer.pointer.station_id = 'other_102';
    const station = harness({ runtime: { mode: MODE.NEW }, active: wrongPointer });
    await rejects(() => station.reader.getStation(request()), 'active-pointer-station');
    assert.equal(station.calls.legacy, 0);

    const wrongPublication = activePayload();
    wrongPublication.publication.publication_id = 'pub_other';
    const publication = harness({ runtime: { mode: MODE.NEW }, active: wrongPublication });
    await rejects(() => publication.reader.getStation(request()), 'active-publication-id');
    assert.equal(publication.calls.legacy, 0);

    const missingRoster = activePayload();
    missingRoster.snapshot.roster = missingRoster.snapshot.roster.filter((person) => person.uid !== 'alpha');
    const roster = harness({ runtime: { mode: MODE.NEW }, active: missingRoster });
    await assert.rejects(() => roster.reader.getStation(request()), (error) =>
      error && error.code === 'plan-person-missing');
    assert.equal(roster.calls.legacy, 0);
  });

  await test('the my window strips all other people and both views strip private fields', async () => {
    const h = harness({ runtime: { mode: MODE.NEW } });
    const station = await h.reader.getStation(request());
    const mine = await h.reader.getMy(request());
    assert.deepEqual(mine.days.map((day) => day.assignments.map((assignment) => assignment.uid)), [
      ['alpha'], [], []
    ]);
    const serialized = JSON.stringify({ station, mine });
    ['alpha@example.test', 'bravo@example.test', '0500000000', 'never return', 'private row note',
      'slot@example.test', 'medical', 'reason'].forEach((secret) => assert.equal(serialized.includes(secret), false));
    station.days.forEach((day) => day.assignments.forEach((assignment) => {
      assert.deepEqual(Object.keys(assignment).sort(), ['display', 'role', 'source', 'sub_station', 'uid']);
    }));
    assert.equal(Object.isFrozen(mine), true);
  });

  await test('date windows are explicit, valid and bounded before any dependency call', async () => {
    const h = harness();
    await rejects(() => h.reader.getStation(request({ from: '2026-09-03', to: '2026-09-01' })), 'range-invalid');
    await rejects(() => h.reader.getStation(request({ from: '2026-01-01', to: '2026-05-01' })), 'range-invalid');
    await rejects(() => h.reader.getStation({ data: { from: '2026-09-01' } }), 'request-shape');
    assert.equal(h.calls.context, 0);
  });

  await test('legacy raw swaps preserve approved first-match order and ignore pending rows', async () => {
    const firstIn = {
      status: 'approved', from_uid: 'bravo', from_crew: 'B', from_date: '2026-09-02',
      to_uid: 'alpha', to_crew: 'A', to_date: '2026-09-01'
    };
    const laterOut = {
      status: 'approved', from_uid: 'alpha', from_crew: 'A', from_date: '2026-09-02',
      to_uid: 'charlie', to_crew: 'C', to_date: '2026-09-03'
    };
    const ordered = legacyPayload();
    ordered.legacy.swaps = [firstIn, laterOut, Object.assign({}, laterOut, { status: 'pending' })];
    const first = harness({ legacy: ordered });
    const firstDay = await first.reader.getStation(request({ from: '2026-09-02', to: '2026-09-02' }));
    assert.equal(firstDay.days[0].assignments.some((assignment) => assignment.uid === 'alpha'), true);

    const reversed = legacyPayload();
    reversed.legacy.swaps = [laterOut, firstIn];
    const second = harness({ legacy: reversed });
    const secondDay = await second.reader.getStation(request({ from: '2026-09-02', to: '2026-09-02' }));
    assert.equal(secondDay.days[0].assignments.some((assignment) => assignment.uid === 'alpha'), false);
  });

  await test('each read follows the current active pointer so rollback is immediately visible', async () => {
    const h = harness({ runtime: { mode: MODE.NEW } });
    const first = await h.reader.getStation(request());
    assert.equal(first.provenance.publication_id, 'pub_1');
    h.state.active = activePayload({
      pointer: { station_id: SID, publication_id: 'pub_rollback', revision: 8, content_digest: 'digest_rollback' },
      publication: {
        id: 'pub_rollback', publication_id: 'pub_rollback', station_id: SID,
        status: 'active', snapshot_complete: true,
        revision: 8, content_digest: 'digest_rollback'
      },
      snapshot: { publication_id: 'pub_rollback', content_digest: 'digest_rollback', plan: v2Plan(), roster: roster() }
    });
    const after = await h.reader.getStation(request());
    assert.equal(after.provenance.publication_id, 'pub_rollback');
    assert.equal(after.provenance.revision, 8);
  });

  await test('the module does not mutate caller data or import storage clients', async () => {
    const payload = activePayload();
    const before = clone(payload);
    const h = harness({ runtime: { mode: MODE.NEW }, active: payload });
    await h.reader.getStation(request());
    assert.deepEqual(payload, before);
    const source = fs.readFileSync(path.join(__dirname, 'schedule-effective-reader.js'), 'utf8');
    assert.doesNotMatch(source, /require\s*\([^)]*(firebase|firestore)|https?:\/\/|fetch\s*\(|Date\.now|\.set\s*\(|\.update\s*\(|\.create\s*\(|\.delete\s*\(/i);
  });

  assert.equal(passed, 16);
  console.log('\n16 schedule effective reader unit checks passed.');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
