import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFakeDb, SID, ST, hash, stable, digest, MGR, req,
  calendarMod, publicationMod, serviceMod
} from './_schedule-fake.mjs';

/*
 * Acceptance gate for a single 3,000-person station. This is the real schedule
 * runtime over the in-memory Firestore double, not a cloud/emulator load test.
 *
 * The test deliberately ends by exercising the unmodified product. Until the
 * two 1,500-person runtime ceilings are replaced by the production reader, that
 * final assertion is red. The earlier candidate/mutation checks make the target
 * behavior executable without weakening the release gate.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_FILE = resolve(HERE, '..', 'functions', 'schedule-runtime.js');
const runtimeRequire = createRequire(RUNTIME_FILE);
const runtimeSource = fs.readFileSync(RUNTIME_FILE, 'utf8');

const QUAL_1500 = 'const MAX_QUALIFICATION_PEOPLE = 1500;';
const QUAL_3000 = 'const MAX_QUALIFICATION_PEOPLE = 3000;';
const GAP_1500 = 'const MAX_GAP_LIVE_ROSTER = 1500;';
const GAP_3000 = 'const MAX_GAP_LIVE_ROSTER = 3000;';

function replaceExactly(source, from, to) {
  const first = source.indexOf(from);
  assert.notEqual(first, -1, 'mutation anchor missing: ' + from);
  assert.equal(source.indexOf(from, first + from.length), -1, 'mutation anchor is not unique: ' + from);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

function raisedCapacitySource(source) {
  let out = source;
  if (out.includes(QUAL_1500)) out = replaceExactly(out, QUAL_1500, QUAL_3000);
  else assert.ok(out.includes(QUAL_3000), 'qualification capacity constant must remain explicit');
  if (out.includes(GAP_1500)) out = replaceExactly(out, GAP_1500, GAP_3000);
  else assert.ok(out.includes(GAP_3000), 'gap capacity constant must remain explicit');
  return out;
}

function loadRuntimeModule(source) {
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(
    '(function (exports, require, module, __filename, __dirname) {\n' + source + '\n})',
    { filename: RUNTIME_FILE }
  );
  wrapper(module.exports, runtimeRequire, module, RUNTIME_FILE, dirname(RUNTIME_FILE));
  return module.exports;
}

function buildRuntime(runtimeModule, db) {
  return runtimeModule.createScheduleRuntime({
    db,
    FieldValue: { serverTimestamp: () => ({ __ts: true }) },
    FieldPath: Object.assign(function FieldPath() {}, { documentId: () => '__name__' }),
    clock: () => '2026-10-01T00:00:00.000Z',
    hash,
    randomId: (() => { let value = 0; return () => 'capacity-' + (++value); })(),
    createEngine: calendarMod.createCalendarEngine,
    createPublication: publicationMod.createPublication,
    createService: serviceMod.createScheduleService,
    isSuper: () => false,
    sendPush: async () => ({ sent: 1 })
  });
}

function capacityObservedDb(raw) {
  const reads = [];
  const batchCommits = [];
  const rawRef = Symbol('raw-ref');
  const protectedCollection = (path) => /\/(users|schedule_person_qualifications|member_quals)$/.test(String(path || ''));
  const unwrap = (ref) => ref && ref[rawRef] ? ref[rawRef] : ref;

  function wrapSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return Object.assign({}, snapshot, { ref: snapshot.ref ? wrapDoc(snapshot.ref) : snapshot.ref });
  }
  function wrapQuery(query, targeted) {
    return {
      [rawRef]: query,
      path: query.path,
      where(...args) { return wrapQuery(query.where(...args), targeted || args[1] === 'array-contains' || (args[0] === 'cleared' && args[1] === '==' && args[2] === false)); },
      limit(value) { return wrapQuery(query.limit(value), targeted); },
      orderBy(...args) { return wrapQuery(query.orderBy(...args), targeted); },
      doc(id) { return wrapDoc(query.doc(id)); },
      async get() {
        if (protectedCollection(query.path) && !targeted) {
          const error = new Error('full collection scan is forbidden for 3,000-person capacity: ' + query.path);
          error.code = 'capacity-full-scan';
          throw error;
        }
        const snap = await query.get();
        return Object.assign({}, snap, { docs: snap.docs.map(wrapSnapshot) });
      }
    };
  }
  function wrapDoc(ref) {
    return {
      [rawRef]: ref,
      path: ref.path,
      id: ref.id,
      collection(name) { return wrapQuery(ref.collection(name), false); },
      async get() { return wrapSnapshot(await ref.get()); },
      set: (...args) => ref.set(...args),
      update: (...args) => ref.update(...args),
      create: (...args) => ref.create(...args),
      delete: (...args) => ref.delete(...args)
    };
  }
  async function observedGetAll(reader, items, transaction) {
    const args = items.slice();
    const readOptions = args.length && args[args.length - 1] && !args[args.length - 1].path
      ? args.pop() : null;
    const refs = args.map(unwrap);
    const groups = new Set(refs.map((ref) => String(ref.path).replace(/\/[^/]+$/, '')));
    assert.equal(groups.size, 1, 'one capacity chunk must not mix collections');
    const collection = Array.from(groups)[0];
    if (protectedCollection(collection)) {
      assert.ok(refs.length > 0 && refs.length <= 250,
        'capacity reads must use non-empty getAll chunks of at most 250 documents');
      assert.ok(readOptions && Array.isArray(readOptions.fieldMask) && readOptions.fieldMask.length > 0,
        'capacity getAll must project an explicit field mask');
      reads.push({ collection, ids: refs.map((ref) => ref.id), size: refs.length, transaction });
    }
    const snapshots = await Promise.all(refs.map((ref) => reader(ref)));
    return snapshots.map(wrapSnapshot);
  }

  const db = {
    collection(name) { return wrapQuery(raw.collection(name), false); },
    doc(path) { return wrapDoc(raw.doc(path)); },
    batch() {
      const batch = raw.batch();
      let writes = 0;
      return {
        set(ref, ...args) { writes += 1; batch.set(unwrap(ref), ...args); return this; },
        update(ref, ...args) { writes += 1; batch.update(unwrap(ref), ...args); return this; },
        create(ref, ...args) { writes += 1; batch.create(unwrap(ref), ...args); return this; },
        delete(ref) { writes += 1; batch.delete(unwrap(ref)); return this; },
        async commit() { batchCommits.push(writes); return batch.commit(); }
      };
    },
    _put: (...args) => raw._put(...args),
    _del: (...args) => raw._del(...args),
    _get: (...args) => raw._get(...args),
    _paths: (...args) => raw._paths(...args),
    getAll(...items) { return observedGetAll((ref) => ref.get(), items, false); },
    runTransaction(fn) {
      return raw.runTransaction((tx) => fn({
        get: (ref) => tx.get(unwrap(ref)).then(wrapSnapshot),
        getAll: (...items) => observedGetAll((ref) => tx.get(ref), items, true),
        set: (ref, ...args) => tx.set(unwrap(ref), ...args),
        update: (ref, ...args) => tx.update(unwrap(ref), ...args),
        create: (ref, ...args) => tx.create(unwrap(ref), ...args),
        delete: (ref) => tx.delete(unwrap(ref))
      }));
    }
  };
  return { db, reads, batchCommits };
}

function people3000() {
  return Array.from({ length: 3000 }, (_, index) => {
    const uid = index === 0 ? MGR : 'capacity-person-' + String(index).padStart(4, '0');
    return {
      id: uid,
      full_name: 'איש צוות ' + String(index).padStart(4, '0'),
      active: true,
      sub_station: 'main',
      roles: ['ff'],
      group: ['A', 'B', 'C'][index % 3]
    };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function fixture(runtimeModule, observed) {
  const wrapped = observed ? capacityObservedDb(createFakeDb()) : null;
  const db = wrapped ? wrapped.db : createFakeDb();
  const rt = buildRuntime(runtimeModule, db);
  const people = people3000();

  for (const person of people) {
    db._put(ST + '/users/' + person.id, {
      station_id: SID, station: SID, is_active: true, active: true,
      role: 'firefighter', full_name: person.full_name
    });
    db._put(ST + '/schedule_person_qualifications/' + person.id, {
      station_id: SID, uid: person.id, qualifications: ['shift_lead'],
      revision: 1, cleared: false
    });
  }
  db._put(ST + '/schedule_access/' + MGR, {
    schema_version: 1, station_id: SID, uid: MGR,
    roles: ['schedule_manager'], active: true, revision: 1
  });
  ['A', 'B', 'C'].forEach((group, position) => db._put(ST + '/rotations/' + group, {
    anchor_date: '2026-10-01', cycle_days: 3, position_in_cycle: position,
    crew: group, is_active: true
  }));
  db._put(ST + '/schedule_state/runtime', { mode: 'shadow' });
  db._put(ST + '/schedule_state/qualifications', {
    station_id: SID, holdings_revision: 3000
  });
  db._put(ST + '/schedule_qualifications/shift_lead', {
    station_id: SID, key: 'shift_lead', label: 'ראש משמרת', order: 10,
    critical: true, builtin: true, active: true, minimum: 1, revision: 1
  });

  const policy = await rt.savePolicy(req({
    request_id: 'capacity-policy', activate: true,
    draft: {
      sub_stations: {
        main: {
          label: 'תחנה ראשית', minimum: 6,
          requirements: [{ role: 'ff', count: 6, required: true }]
        }
      },
      rest: { min_gap_days: 2 },
      rotation: { groups: ['A', 'B', 'C'], anchor: '2026-10-01', days_per_group: 1, strict: true },
      max_shifts_per_month: 4
    }
  }));

  const sourceId = 'capacity-source';
  const sourcePath = ST + '/schedule_sources/' + sourceId;
  for (const person of people) {
    const stored = { ...person };
    delete stored.id;
    db._put(sourcePath + '/people/' + person.id, stored);
  }
  const basis = {
    station_id: SID, version: 'capacity-v1', revision: 'capacity-r1', carry: {},
    counts: { people: people.length, availability: 0, locked: 0, events: 0 },
    people, availability: {}, locked: {}, events: []
  };
  db._put(sourcePath, {
    station_id: SID, complete: true, version: basis.version, revision: basis.revision,
    person_count: people.length, availability_count: 0, locked_count: 0, event_count: 0,
    carry: {}, content_digest: digest(basis),
    content_key: hash(stable({ station_id: SID, people }))
  });
  db._put(ST + '/schedule_state/runtime', {
    mode: 'shadow', active_policy_id: policy.policy_id, active_source_id: sourceId
  });
  return { db, rt, people, reads: wrapped ? wrapped.reads : [],
    batchCommits: wrapped ? wrapped.batchCommits : [] };
}

async function verifyThreeThousand(runtimeModule, observed) {
  const { rt, people, reads, batchCommits } = await fixture(runtimeModule, observed);
  const qualifications = await rt.getQualificationCatalog(req({}));
  assert.equal(qualifications.people.length, 3000, 'qualification view truncated the active roster');
  assert.equal(qualifications.holders.shift_lead, 3000, 'qualification holders were not counted exactly');
  const temporary = await rt.saveQualification(req({
    request_id:'capacity-temp-qualification', key:'capacity_temp', label:'בדיקת קיבולת זמנית'
  }));
  await rt.deleteQualification(req({
    request_id:'capacity-delete-qualification', key:'capacity_temp', expected_revision:temporary.revision
  }));

  const commitsBeforePlan = batchCommits.length;
  const planned = await rt.runPlanner(req({
    request_id: 'capacity-plan', start: '2026-10-01', months: 12, overrides: []
  }));
  const preview = await rt.getDraftPreview(req({
    draft_id: planned.draft_id, start: '2026-10-01'
  }));
  assert.equal(preview.gaps.summary.critical_gaps, 0, 'qualified 3,000-person roster produced a critical gap');
  assert.equal(preview.gaps.summary.other_gaps, 0, 'qualified 3,000-person roster produced a staffing gap');
  assert.equal(planned.summary.filled, 365 * 6, 'annual planner did not fill the constrained daily minimum');
  if (observed) {
    const annualSnapshotCommits = batchCommits.slice(commitsBeforePlan);
    assert.ok(annualSnapshotCommits.length >= 7,
      'annual 3,000-person snapshot did not span multiple batches');
    assert.ok(annualSnapshotCommits.every((writes) => writes > 0 && writes <= 350),
      'annual snapshot batch exceeded the runtime 350-write safety boundary');
    assert.ok(annualSnapshotCommits.filter((writes) => writes === 350).length >= 9,
      'annual snapshot did not exercise repeated full-size runtime write batches');
    assert.ok(reads.length >= 24, '3,000 records were not read in bounded chunks');
    assert.ok(reads.every((read) => read.size <= 250), 'a capacity chunk exceeded 250 documents');
    const expectedIds = people.map((person) => person.id).sort();
    for (const suffix of ['/users', '/schedule_person_qualifications']) {
      const ids = Array.from(new Set(reads.filter((read) => read.collection.endsWith(suffix))
        .flatMap((read) => read.ids))).sort();
      assert.deepEqual(ids, expectedIds, suffix + ' did not read the exact signed-source uid set');
    }
  }
}

async function verifyMergedHolderCeiling(runtimeModule) {
  const { db, rt, people } = await fixture(runtimeModule, false);
  const legacyUid = people[people.length - 1].id;
  const legacyPath = ST + '/schedule_person_qualifications/' + legacyUid;
  const legacy = db._get(legacyPath);
  delete legacy.cleared;
  db._put(legacyPath, legacy);
  db._put(ST + '/schedule_person_qualifications/departed-capacity-extra', {
    station_id:SID, uid:'departed-capacity-extra', qualifications:['driver'], revision:1, cleared:false
  });
  return rt.getQualificationCatalog(req({}));
}

// Mutation proof: restoring either audited ceiling to 1,500 must be caught.
const raisedForMutation = raisedCapacitySource(runtimeSource);
const qualificationMutation = replaceExactly(raisedForMutation, QUAL_3000, QUAL_1500);
await assert.rejects(
  verifyThreeThousand(loadRuntimeModule(qualificationMutation)),
  (error) => error && error.code === 'qualifications-too-many'
);
const gapMutation = replaceExactly(raisedForMutation, GAP_3000, GAP_1500);
await assert.rejects(
  verifyThreeThousand(loadRuntimeModule(gapMutation)),
  (error) => error && error.code === 'gap-live-roster-too-many'
);

// Mutation proof: deletion must query the requested qualification only. A
// regression to the former station-wide holdings scan is blocked by the same
// observed database used by the 3,000-person release assertion.
const deleteScanMutation = replaceExactly(
  raisedForMutation,
  'const holdings = await loadQualificationHolders(ctx, key);',
  'const holdings = await loadPersonQualifications(ctx);'
);
await assert.rejects(
  verifyThreeThousand(loadRuntimeModule(deleteScanMutation), true),
  (error) => error && error.code === 'capacity-full-scan'
);

// The indexed query and the bounded source compatibility read are merged.
// Their union, not merely either half, remains capped at 3,000 people.
await assert.rejects(
  verifyMergedHolderCeiling(loadRuntimeModule(runtimeSource)),
  (error) => error && error.code === 'qualifications-too-many'
);
const unionGuardMutation = replaceExactly(
  runtimeSource,
  'if (holdings.size > MAX_QUALIFICATION_PEOPLE) {',
  'if (false) {'
);
await assert.doesNotReject(verifyMergedHolderCeiling(loadRuntimeModule(unionGuardMutation)));

// Oracle mutation: a regression to a full users/holdings collection query is
// rejected before it can masquerade as a successful capacity read.
{
  const observed = capacityObservedDb(createFakeDb());
  await assert.rejects(
    observed.db.collection('stations').doc(SID).collection('users').limit(3001).get(),
    (error) => error && error.code === 'capacity-full-scan'
  );
  await assert.rejects(
    observed.db.collection('stations').doc(SID).collection('schedule_person_qualifications').limit(3001).get(),
    (error) => error && error.code === 'capacity-full-scan'
  );
}

// Release assertion: this intentionally fails on the current product until its
// real runtime implements the accepted 3,000-person contract.
await verifyThreeThousand(loadRuntimeModule(runtimeSource), true);

console.log('schedule-capacity-3000-runtime: PASS');
