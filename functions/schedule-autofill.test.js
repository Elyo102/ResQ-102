'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const engine = require('./schedule-autofill');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  process.stdout.write('✓ ' + name + '\n');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function envelope(extra) {
  return Object.assign({
    station_id: 'station_north',
    contract_station_id: 'station_north',
    snapshot_id: 'snapshot-1',
    source_revision: 'revision-1',
    complete: true
  }, extra);
}

function baseInput() {
  const members = [
    { uid: 'u1', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'commander', qualification_ids: ['q1'], prior_load: 0 },
    { uid: 'u2', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'firefighter', qualification_ids: ['q2'], prior_load: 0 },
    { uid: 'u3', station_id: 'station_north', active: true, home_crew: 'B', role_id: 'firefighter', qualification_ids: ['q1'], prior_load: 0 },
    { uid: 'u4', station_id: 'station_north', active: true, home_crew: 'C', role_id: 'firefighter', qualification_ids: [], prior_load: 0 },
    { uid: 'u5', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'firefighter', qualification_ids: [], prior_load: 0 }
  ];
  return {
    schema_version: 1,
    algorithm_version: 'static-board-mcmf-v1',
    target_kind: 'static_crew_board_v1',
    station_id: 'station_north',
    contract_station_id: 'station_north',
    target_crews: ['A'],
    sources: {
      members: envelope({ items: members }),
      board: envelope({
        command_slots: [{ slot_id: 'c1', required_qualification_id: 'q1' }],
        vehicles: [{
          vehicle_id: 'v1',
          slots: [
            { slot_id: 's1', required_qualification_id: 'q2' },
            { slot_id: 's2', required_qualification_id: '' }
          ]
        }]
      }),
      qualifications: envelope({ ids: ['q1', 'q2'] }),
      current_assignments: envelope({
        by_crew: {
          A: { c1: 'u1', s1: 'u2', s2: 'u5' },
          B: { c1: 'u3' },
          C: { s2: 'u4' }
        }
      }),
      locked_assignments: envelope({ by_crew: { A: { c1: 'u1' }, B: {}, C: {} } }),
      vehicle_statuses: envelope({ items: [{ vehicle_id: 'v1', state: 'ok' }] })
    },
    policies: {
      multi_slot_policy: { mode: 'limit', max_slots_per_person: 1 },
      cross_crew_policy: { mode: 'deny', allow_without_rest_evaluation: false },
      qualification_policy: { mode: 'hard' },
      rest_policy: { mode: 'not_applicable_static_board' },
      vehicle_fault_policy: {
        states: { ok: 'include', minor: 'include', ungraded: 'exclude', limited: 'exclude', blocked: 'exclude' }
      },
      redline_policy: { mode: 'information_only' },
      allowed_roles_by_slot_id: { c1: ['commander'], s1: [], s2: [] },
      preservation_policy: { mode: 'minimize_changes' },
      objective_order: [
        'maximize_hard_constraint_fill', 'minimize_changes',
        'minimize_cross_crew', 'balance_load'
      ],
      tie_break_policy: 'slot_id_then_uid',
      authorization_policy: {
        preview_permission: 'mayPreview', approve_permission: 'mayApprove', apply_permission: 'mayApply'
      }
    }
  };
}

function blockedWith(input, code) {
  const result = engine.planStaticBoard(input);
  assert.equal(result.state, 'blocked');
  assert.ok(result.reason_codes.includes(code), JSON.stringify(result));
}

function assertBlocked(input) {
  const result = engine.planStaticBoard(input);
  assert.equal(result.state, 'blocked', JSON.stringify(result));
  assert.ok(Array.isArray(result.reason_codes) && result.reason_codes.length > 0);
}

test('happy path preserves a valid board and produces no personal fields', function () {
  const result = engine.planStaticBoard(baseInput());
  assert.equal(result.state, 'proposal');
  assert.equal(result.applicable, true);
  assert.deepEqual(result.assignments_by_crew.A, { c1: 'u1', s1: 'u2', s2: 'u5' });
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.assignment_explanations, [
    { crew: 'A', slot_id: 'c1', uid: 'u1', reason_codes: ['LOCKED_ASSIGNMENT_PRESERVED'] },
    { crew: 'A', slot_id: 's1', uid: 'u2', reason_codes: ['CURRENT_ASSIGNMENT_PRESERVED', 'HOME_CREW_ASSIGNMENT'] },
    { crew: 'A', slot_id: 's2', uid: 'u5', reason_codes: ['CURRENT_ASSIGNMENT_PRESERVED', 'HOME_CREW_ASSIGNMENT'] }
  ]);
  assert.equal(engine.privacyViolations(result).length, 0);
  assert.match(result.source_digest, /^[a-f0-9]{64}$/);
  assert.match(result.proposal_digest, /^[a-f0-9]{64}$/);
});

test('output is byte-stable when semantically unordered arrays are reordered', function () {
  const first = baseInput(), second = clone(first);
  second.target_crews.reverse();
  second.sources.members.items.reverse();
  second.sources.members.items.forEach(function (member) { member.qualification_ids.reverse(); });
  second.sources.board.command_slots.reverse();
  second.sources.board.vehicles.reverse();
  second.sources.board.vehicles.forEach(function (vehicle) { vehicle.slots.reverse(); });
  second.sources.qualifications.ids.reverse();
  second.sources.vehicle_statuses.items.reverse();
  second.policies.allowed_roles_by_slot_id.c1.reverse();
  assert.equal(engine.canonicalStringify(engine.planStaticBoard(first)),
    engine.canonicalStringify(engine.planStaticBoard(second)));
});

test('planner never mutates its input', function () {
  const input = baseInput(), before = JSON.stringify(input);
  engine.planStaticBoard(input);
  assert.equal(JSON.stringify(input), before);
});

test('missing and unknown top-level fields block', function () {
  const missing = baseInput(); delete missing.policies;
  blockedWith(missing, 'MISSING_REQUIRED_FIELD');
  const extra = baseInput(); extra.magic = true;
  blockedWith(extra, 'UNKNOWN_FIELD');
});

test('malformed nested values fail closed and never throw', function () {
  [null, [], 'bad'].forEach(function (value) {
    const source = baseInput(); source.sources.board = value;
    assertBlocked(source);
    const policy = baseInput(); policy.policies.multi_slot_policy = value;
    assertBlocked(policy);
    const member = baseInput(); member.sources.members.items[0] = value;
    assertBlocked(member);
  });
  const missingSource = baseInput(); delete missingSource.sources.members;
  assertBlocked(missingSource);
});

test('unsupported schema, algorithm and target block', function () {
  const schema = baseInput(); schema.schema_version = 2;
  blockedWith(schema, 'UNSUPPORTED_SCHEMA_VERSION');
  const algorithm = baseInput(); algorithm.algorithm_version = 'new';
  blockedWith(algorithm, 'UNSUPPORTED_ALGORITHM_VERSION');
  const target = baseInput(); target.target_kind = 'dated_roster';
  blockedWith(target, 'UNSUPPORTED_TARGET_KIND');
});

test('root and every source envelope must match the same station contract', function () {
  const root = baseInput(); root.contract_station_id = 'other';
  blockedWith(root, 'STATION_MISMATCH');
  Object.keys(baseInput().sources).forEach(function (sourceName) {
    const input = baseInput();
    input.sources[sourceName].station_id = 'other';
    input.sources[sourceName].contract_station_id = 'other';
    blockedWith(input, 'STATION_MISMATCH');
  });
});

test('all source envelopes must belong to one common snapshot', function () {
  const input = baseInput();
  input.sources.vehicle_statuses.snapshot_id = 'snapshot-2';
  blockedWith(input, 'SNAPSHOT_MISMATCH');
});

test('incomplete or revision-less sources block', function () {
  const incomplete = baseInput(); incomplete.sources.board.complete = false;
  blockedWith(incomplete, 'INCOMPLETE_SOURCE');
  const revision = baseInput(); revision.sources.members.source_revision = '';
  blockedWith(revision, 'INVALID_SOURCE_REVISION');
});

test('all A B C current and lock snapshots are mandatory', function () {
  const current = baseInput(); delete current.sources.current_assignments.by_crew.C;
  blockedWith(current, 'MISSING_REQUIRED_FIELD');
  const locks = baseInput(); delete locks.sources.locked_assignments.by_crew.B;
  blockedWith(locks, 'MISSING_REQUIRED_FIELD');
});

test('target crews must be a unique non-empty A B C subset', function () {
  const empty = baseInput(); empty.target_crews = [];
  blockedWith(empty, 'INVALID_TARGET_CREWS');
  const duplicate = baseInput(); duplicate.target_crews = ['A', 'A'];
  blockedWith(duplicate, 'INVALID_TARGET_CREWS');
  const unknown = baseInput(); unknown.target_crews = ['D'];
  blockedWith(unknown, 'INVALID_TARGET_CREWS');
});

test('duplicate members slots vehicles and qualifications block', function () {
  const member = baseInput(); member.sources.members.items.push(clone(member.sources.members.items[0]));
  blockedWith(member, 'DUPLICATE_OR_INVALID_MEMBER_ID');
  const slot = baseInput(); slot.sources.board.vehicles[0].slots.push({ slot_id: 'c1', required_qualification_id: '' });
  blockedWith(slot, 'DUPLICATE_OR_INVALID_SLOT_ID');
  const vehicle = baseInput(); vehicle.sources.board.vehicles.push(clone(vehicle.sources.board.vehicles[0]));
  blockedWith(vehicle, 'DUPLICATE_OR_INVALID_VEHICLE_ID');
  const qualification = baseInput(); qualification.sources.qualifications.ids.push('q1');
  blockedWith(qualification, 'DUPLICATE_OR_INVALID_QUALIFICATION_ID');
});

test('unknown and inactive assignment references block', function () {
  const unknownSlot = baseInput(); unknownSlot.sources.current_assignments.by_crew.A.ghost = 'u1';
  blockedWith(unknownSlot, 'UNKNOWN_SLOT_REFERENCE');
  const unknownUser = baseInput(); unknownUser.sources.current_assignments.by_crew.A.s2 = 'ghost';
  blockedWith(unknownUser, 'UNKNOWN_MEMBER_REFERENCE');
  const inactive = baseInput(); inactive.sources.members.items.find(function (m) { return m.uid === 'u5'; }).active = false;
  blockedWith(inactive, 'INACTIVE_MEMBER_REFERENCE');
});

test('unknown qualification references block in members and slots', function () {
  const member = baseInput(); member.sources.members.items[0].qualification_ids = ['ghost'];
  blockedWith(member, 'UNKNOWN_QUALIFICATION_REFERENCE');
  const slot = baseInput(); slot.sources.board.command_slots[0].required_qualification_id = 'ghost';
  blockedWith(slot, 'UNKNOWN_QUALIFICATION_REFERENCE');
});

test('member and slot-policy roles must use canonical system role ids', function () {
  const member = baseInput(); member.sources.members.items[0].role_id = 'comander';
  blockedWith(member, 'INVALID_ROLE_ID');
  const policy = baseInput(); policy.policies.allowed_roles_by_slot_id.c1 = ['comander'];
  blockedWith(policy, 'INVALID_ROLE_POLICY');
});

test('vehicle statuses are complete unique and refer to known vehicles', function () {
  const missing = baseInput(); missing.sources.vehicle_statuses.items = [];
  blockedWith(missing, 'MISSING_VEHICLE_STATUS');
  const duplicate = baseInput(); duplicate.sources.vehicle_statuses.items.push({ vehicle_id: 'v1', state: 'ok' });
  blockedWith(duplicate, 'DUPLICATE_VEHICLE_STATUS');
  const unknown = baseInput(); unknown.sources.vehicle_statuses.items[0].vehicle_id = 'ghost';
  blockedWith(unknown, 'UNKNOWN_VEHICLE_REFERENCE');
});

test('every product policy is mandatory', function () {
  Object.keys(baseInput().policies).forEach(function (key) {
    const input = baseInput(); delete input.policies[key];
    blockedWith(input, 'MISSING_REQUIRED_FIELD');
  });
});

test('unknown or unsupported policy values block instead of defaulting', function () {
  const multi = baseInput(); multi.policies.multi_slot_policy.mode = 'unlimited';
  blockedWith(multi, 'UNSUPPORTED_MULTI_SLOT_POLICY');
  const rest = baseInput(); rest.policies.rest_policy.mode = '48_hours';
  blockedWith(rest, 'UNSUPPORTED_REST_POLICY');
  const redline = baseInput(); redline.policies.redline_policy.mode = 'guess';
  blockedWith(redline, 'UNSUPPORTED_REDLINE_POLICY');
  const tie = baseInput(); tie.policies.tie_break_policy = 'random';
  blockedWith(tie, 'UNSUPPORTED_TIE_BREAK_POLICY');
  const auth = baseInput(); auth.policies.authorization_policy.apply_permission = 'roleRank';
  blockedWith(auth, 'UNSUPPORTED_AUTHORIZATION_CONTRACT');
});

test('role policy must explicitly cover every exact slot id', function () {
  const missing = baseInput(); delete missing.policies.allowed_roles_by_slot_id.s2;
  blockedWith(missing, 'INCOMPLETE_ROLE_POLICY');
  const extra = baseInput(); extra.policies.allowed_roles_by_slot_id.ghost = [];
  blockedWith(extra, 'INCOMPLETE_ROLE_POLICY');
});

test('cross-crew deny leaves a slot unfilled instead of guessing', function () {
  const input = baseInput();
  input.sources.members.items = input.sources.members.items.filter(function (m) { return m.uid !== 'u5'; });
  delete input.sources.current_assignments.by_crew.A.s2;
  const result = engine.planStaticBoard(input);
  assert.equal(result.state, 'proposal');
  assert.equal(result.applicable, false);
  assert.deepEqual(result.unfilled_slots, [{
    crew: 'A', slot_id: 's2', reason_code: 'PERSON_CAPACITY_EXHAUSTED',
    eligible_candidate_count: 2,
    rejection_reasons: [{ reason_code: 'CROSS_CREW_FORBIDDEN', count: 2 }]
  }]);
});

test('cross-crew allow requires an explicit no-rest-evaluation acknowledgement', function () {
  const blocked = baseInput();
  blocked.policies.cross_crew_policy = { mode: 'allow', allow_without_rest_evaluation: false };
  blockedWith(blocked, 'UNSUPPORTED_CROSS_CREW_POLICY');
  const allowed = baseInput();
  allowed.sources.members.items = allowed.sources.members.items.filter(function (m) { return m.uid !== 'u5'; });
  delete allowed.sources.current_assignments.by_crew.A.s2;
  allowed.sources.current_assignments.by_crew.C = {};
  allowed.policies.cross_crew_policy = { mode: 'allow', allow_without_rest_evaluation: true };
  const result = engine.planStaticBoard(allowed);
  assert.equal(result.state, 'proposal');
  assert.equal(result.assignments_by_crew.A.s2, 'u4');
});

test('hard qualification refuses while warning mode marks the proposal non-applicable', function () {
  const hard = baseInput();
  hard.sources.members.items.find(function (m) { return m.uid === 'u2'; }).qualification_ids = [];
  delete hard.sources.current_assignments.by_crew.A.s1;
  const hardResult = engine.planStaticBoard(hard);
  assert.ok(hardResult.unfilled_slots.some(function (row) { return row.slot_id === 's1'; }));
  const warning = clone(hard);
  warning.policies.qualification_policy.mode = 'warning';
  const warningResult = engine.planStaticBoard(warning);
  assert.equal(warningResult.assignments_by_crew.A.s1, 'u2');
  assert.equal(warningResult.applicable, false);
  assert.ok(warningResult.warnings.some(function (row) {
    return row.reason_code === 'QUALIFICATION_MISSING_WARNING';
  }));
});

test('role restrictions are IDs and never inferred from Hebrew labels', function () {
  const input = baseInput();
  input.policies.allowed_roles_by_slot_id.s2 = ['commander'];
  delete input.sources.current_assignments.by_crew.A.s2;
  const result = engine.planStaticBoard(input);
  assert.ok(result.unfilled_slots.some(function (row) { return row.slot_id === 's2'; }));
});

test('vehicle policy explicitly excludes affected slots', function () {
  const input = baseInput();
  input.sources.vehicle_statuses.items[0].state = 'blocked';
  input.sources.locked_assignments.by_crew.A = { c1: 'u1' };
  delete input.sources.current_assignments.by_crew.A.s1;
  delete input.sources.current_assignments.by_crew.A.s2;
  const result = engine.planStaticBoard(input);
  assert.deepEqual(result.unfilled_slots.map(function (row) { return row.slot_id; }), ['s1', 's2']);
});

test('locks must match current and satisfy hard constraints', function () {
  const mismatch = baseInput(); mismatch.sources.locked_assignments.by_crew.A.c1 = 'u2';
  blockedWith(mismatch, 'LOCK_DOES_NOT_MATCH_CURRENT');
  const invalid = baseInput(); invalid.policies.allowed_roles_by_slot_id.c1 = ['firefighter'];
  blockedWith(invalid, 'LOCKED_ASSIGNMENT_INVALID');
});

test('person capacity is global across all three crew boards', function () {
  const input = baseInput();
  input.sources.current_assignments.by_crew.B.s2 = 'u5';
  delete input.sources.current_assignments.by_crew.A.s2;
  const result = engine.planStaticBoard(input);
  assert.ok(result.unfilled_slots.some(function (row) { return row.slot_id === 's2'; }));
});

test('one proposal plans A B and C together without cross-board state leakage', function () {
  const input = baseInput();
  input.target_crews = ['A', 'B', 'C'];
  input.sources.members.items = [];
  input.sources.current_assignments.by_crew = { A: {}, B: {}, C: {} };
  input.sources.locked_assignments.by_crew = { A: {}, B: {}, C: {} };
  ['A', 'B', 'C'].forEach(function (crew) {
    const lower = crew.toLowerCase();
    const commander = lower + '-commander';
    const qualified = lower + '-qualified';
    const general = lower + '-general';
    input.sources.members.items.push(
      { uid: commander, station_id: 'station_north', active: true, home_crew: crew, role_id: 'commander', qualification_ids: ['q1'], prior_load: 0 },
      { uid: qualified, station_id: 'station_north', active: true, home_crew: crew, role_id: 'firefighter', qualification_ids: ['q2'], prior_load: 0 },
      { uid: general, station_id: 'station_north', active: true, home_crew: crew, role_id: 'firefighter', qualification_ids: [], prior_load: 0 }
    );
    input.sources.current_assignments.by_crew[crew] = {
      c1: commander, s1: qualified, s2: general
    };
    input.sources.locked_assignments.by_crew[crew] = { c1: commander };
  });
  const result = engine.planStaticBoard(input);
  assert.equal(result.state, 'proposal');
  assert.equal(result.applicable, true);
  assert.deepEqual(result.assignments_by_crew, input.sources.current_assignments.by_crew);
  assert.equal(result.assignment_explanations.length, 9);
});

test('sequential stations with identical operational ids remain isolated', function () {
  const north = baseInput();
  const south = clone(north);
  south.station_id = 'station_south';
  south.contract_station_id = 'station_south';
  Object.keys(south.sources).forEach(function (sourceName) {
    south.sources[sourceName].station_id = 'station_south';
    south.sources[sourceName].contract_station_id = 'station_south';
  });
  south.sources.members.items.forEach(function (member) {
    member.station_id = 'station_south';
  });
  const northFirst = engine.planStaticBoard(north);
  const southResult = engine.planStaticBoard(south);
  const northSecond = engine.planStaticBoard(north);
  assert.equal(northFirst.station_id, 'station_north');
  assert.equal(southResult.station_id, 'station_south');
  assert.notEqual(northFirst.source_digest, southResult.source_digest);
  assert.equal(engine.canonicalStringify(northFirst), engine.canonicalStringify(northSecond));
});

test('fixed non-target assignments exceeding the global cap block', function () {
  const input = baseInput();
  input.sources.current_assignments.by_crew.B.s1 = 'u3';
  blockedWith(input, 'FIXED_ASSIGNMENTS_EXCEED_PERSON_LIMIT');
});

test('minimize_changes preserves a valid current assignment', function () {
  const input = baseInput();
  input.sources.members.items.push({ uid: 'u0', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'firefighter', qualification_ids: [], prior_load: 0 });
  const result = engine.planStaticBoard(input);
  assert.equal(result.assignments_by_crew.A.s2, 'u5');
});

test('replace_all uses stable slot-id then uid tie breaking', function () {
  const input = baseInput();
  input.sources.members.items.push({ uid: 'u0', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'firefighter', qualification_ids: [], prior_load: 0 });
  input.policies.preservation_policy.mode = 'replace_all';
  const result = engine.planStaticBoard(input);
  assert.equal(result.assignments_by_crew.A.s2, 'u0');
});

test('maximum fill repairs the adversarial versatile-person trap', function () {
  const input = baseInput();
  input.sources.members.items = [
    { uid: 'flex', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'firefighter', qualification_ids: ['q1'], prior_load: 0 },
    { uid: 'plain', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'firefighter', qualification_ids: [], prior_load: 0 }
  ];
  input.sources.board = envelope({
    command_slots: [],
    vehicles: [{ vehicle_id: 'v1', slots: [
      { slot_id: 'a-general', required_qualification_id: '' },
      { slot_id: 'z-rare', required_qualification_id: 'q1' }
    ] }]
  });
  input.sources.qualifications.ids = ['q1'];
  input.sources.current_assignments.by_crew = { A: {}, B: {}, C: {} };
  input.sources.locked_assignments.by_crew = { A: {}, B: {}, C: {} };
  input.policies.allowed_roles_by_slot_id = { 'a-general': [], 'z-rare': [] };
  const result = engine.planStaticBoard(input);
  assert.equal(result.applicable, true);
  assert.deepEqual(result.assignments_by_crew.A, { 'a-general': 'plain', 'z-rare': 'flex' });
});

test('insufficient capacity is an incomplete proposal, not a schema block', function () {
  const input = baseInput();
  input.sources.members.items = input.sources.members.items.filter(function (m) { return m.uid === 'u1'; });
  input.sources.current_assignments.by_crew = { A: { c1: 'u1' }, B: {}, C: {} };
  input.sources.locked_assignments.by_crew = { A: { c1: 'u1' }, B: {}, C: {} };
  const result = engine.planStaticBoard(input);
  assert.equal(result.state, 'proposal');
  assert.equal(result.applicable, false);
  assert.equal(result.unfilled_slots.length, 2);
  assert.ok(result.unfilled_slots.some(function (slot) {
    return slot.reason_code === 'PERSON_CAPACITY_EXHAUSTED' &&
      slot.eligible_candidate_count > 0;
  }));
  assert.ok(result.unfilled_slots.some(function (slot) {
    return slot.reason_code === 'NO_ELIGIBLE_CANDIDATE' &&
      slot.rejection_reasons.some(function (reason) {
        return reason.reason_code === 'QUALIFICATION_MISSING';
      });
  }));
  assert.ok(result.reason_codes.includes('PROPOSAL_INCOMPLETE'));
});

test('recursive privacy guard rejects personal fields at any depth', function () {
  ['name', 'full_name', 'email', 'phone', 'employee_number', 'notes'].forEach(function (key) {
    const input = baseInput();
    input.sources.members.items[0].nested = {}; // also proves unknown fields do not hide PII
    input.sources.members.items[0].nested[key] = 'secret';
    blockedWith(input, 'PII_FIELD_FORBIDDEN');
  });
});

test('technical limits are exported and oversized relations block', function () {
  assert.equal(engine.LIMITS.members, 5000);
  assert.equal(engine.LIMITS.slots, 500);
  assert.equal(engine.LIMITS.candidate_edges, 250000);
  const input = baseInput();
  input.sources.members.items[0].qualification_ids = Array.from({ length: 65 }, function (_, i) { return 'q' + i; });
  input.sources.qualifications.ids = input.sources.members.items[0].qualification_ids.slice();
  blockedWith(input, 'INVALID_MEMBER_QUALIFICATIONS');
});

function loadMutant(before, after) {
  const filename = path.join(__dirname, 'schedule-autofill.js');
  const source = fs.readFileSync(filename, 'utf8');
  assert.ok(source.includes(before), 'mutation target not found');
  const mutated = source.replace(before, after);
  const module = { exports: {} };
  vm.runInNewContext(mutated, {
    module: module, exports: module.exports,
    require: function (name) {
      if (name === 'node:crypto') return require('node:crypto');
      throw new Error('unexpected require ' + name);
    },
    Set: Set, Map: Map, JSON: JSON, Object: Object, Array: Array,
    String: String, Number: Number, Boolean: Boolean, Math: Math, Infinity: Infinity
  }, { filename: 'schedule-autofill.mutant.js' });
  return module.exports;
}

test('mutation probe catches removal of source station isolation', function () {
  const mutant = loadMutant(
    "if (envelope.station_id !== stationId || envelope.contract_station_id !== contractStationId) {",
    'if (false) {'
  );
  const input = baseInput();
  input.sources.qualifications.station_id = 'other';
  input.sources.qualifications.contract_station_id = 'other';
  assert.notEqual(mutant.planStaticBoard(input).state, 'blocked');
  blockedWith(input, 'STATION_MISMATCH');
});

test('mutation probe catches removal of hard qualification enforcement', function () {
  const mutant = loadMutant(
    "if (!hasQualification && policies.qualification_policy.mode === 'hard') {",
    'if (false) {'
  );
  const input = baseInput();
  input.sources.members.items.find(function (m) { return m.uid === 'u2'; }).qualification_ids = [];
  delete input.sources.current_assignments.by_crew.A.s1;
  assert.equal(mutant.planStaticBoard(input).assignments_by_crew.A.s1, 'u2');
  assert.ok(engine.planStaticBoard(input).unfilled_slots.some(function (row) { return row.slot_id === 's1'; }));
});

test('mutation probe catches removal of locked-assignment validation', function () {
  const mutant = loadMutant(
    "if (!check.eligible || check.warning) lockErrors.push('LOCKED_ASSIGNMENT_INVALID');",
    'if (false) lockErrors.push(\'LOCKED_ASSIGNMENT_INVALID\');'
  );
  const input = baseInput(); input.policies.allowed_roles_by_slot_id.c1 = ['firefighter'];
  assert.equal(mutant.planStaticBoard(input).state, 'proposal');
  blockedWith(input, 'LOCKED_ASSIGNMENT_INVALID');
});

test('mutation probe catches inverted deterministic text ordering', function () {
  const mutant = loadMutant(
    'return left < right ? -1 : left > right ? 1 : 0;',
    'return left < right ? 1 : left > right ? -1 : 0;'
  );
  const input = baseInput();
  input.sources.members.items.push({ uid: 'u0', station_id: 'station_north', active: true, home_crew: 'A', role_id: 'firefighter', qualification_ids: [], prior_load: 0 });
  input.policies.preservation_policy.mode = 'replace_all';
  assert.notEqual(mutant.planStaticBoard(input).assignments_by_crew.A.s2,
    engine.planStaticBoard(input).assignments_by_crew.A.s2);
});

function scaleFixture(memberCount, slotCount) {
  const input = baseInput();
  input.sources.members.items = Array.from({ length: memberCount }, function (_, index) {
    return {
      uid: 'u' + String(index).padStart(5, '0'), station_id: 'station_north', active: true,
      home_crew: 'A', role_id: 'firefighter',
      qualification_ids: index < slotCount ? ['scale-q-' + index] : [], prior_load: index % 10
    };
  });
  const slots = Array.from({ length: slotCount }, function (_, index) {
    return {
      slot_id: 'slot-' + String(index).padStart(4, '0'),
      required_qualification_id: 'scale-q-' + index
    };
  });
  input.sources.board = envelope({ command_slots: slots, vehicles: [] });
  input.sources.qualifications.ids = Array.from({ length: slotCount }, function (_, index) {
    return 'scale-q-' + index;
  });
  input.sources.current_assignments.by_crew = { A: {}, B: {}, C: {} };
  input.sources.locked_assignments.by_crew = { A: {}, B: {}, C: {} };
  input.sources.vehicle_statuses.items = [];
  input.policies.allowed_roles_by_slot_id = {};
  slots.forEach(function (slot, index) {
    input.policies.allowed_roles_by_slot_id[slot.slot_id] = [];
  });
  return input;
}

function broadScaleFixture(eligibleCount) {
  const input = scaleFixture(1000, 500);
  input.sources.members.items.forEach(function (member, index) {
    member.role_id = index < eligibleCount ? 'firefighter' : 'commander';
    member.qualification_ids = [];
  });
  input.sources.board.command_slots.forEach(function (slot) {
    slot.required_qualification_id = '';
  });
  input.sources.qualifications.ids = [];
  Object.keys(input.policies.allowed_roles_by_slot_id).forEach(function (slotId) {
    input.policies.allowed_roles_by_slot_id[slotId] = ['firefighter'];
  });
  input.policies.multi_slot_policy.max_slots_per_person = 2;
  return input;
}

test('1,000-member 500-slot planning is bounded and complete', function () {
  const input = scaleFixture(1000, 500);
  const started = process.hrtime.bigint();
  const result = engine.planStaticBoard(input);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.state, 'proposal');
  assert.equal(Object.keys(result.assignments_by_crew.A).length, 500);
  assert.equal(result.applicable, true);
  assert.ok(elapsedMs < 8000, 'elapsed ' + elapsedMs + 'ms');
});

test('5,000-member and 500-slot hard boundary is accepted', function () {
  const result = engine.planStaticBoard(scaleFixture(5000, 500));
  assert.equal(result.state, 'proposal');
  assert.equal(Object.keys(result.assignments_by_crew.A).length, 500);
});

test('1,000-member broad workload near the candidate ceiling is deterministic and complete', function () {
  const input = broadScaleFixture(400); // 200,000 candidate edges (80% of the hard ceiling)
  const started = process.hrtime.bigint();
  const first = engine.planStaticBoard(input);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const second = engine.planStaticBoard(input);
  assert.equal(first.state, 'proposal');
  assert.equal(first.applicable, true);
  assert.equal(Object.keys(first.assignments_by_crew.A).length, 500);
  assert.equal(engine.canonicalStringify(first), engine.canonicalStringify(second));
  assert.ok(elapsedMs < 15000, 'elapsed ' + elapsedMs + 'ms');
});

test('5,001 members and 501 slots are blocked', function () {
  blockedWith(scaleFixture(5001, 1), 'MEMBER_LIMIT_EXCEEDED');
  blockedWith(scaleFixture(501, 501), 'SLOT_LIMIT_EXCEEDED');
});

test('dense candidate graphs are rejected before matching', function () {
  const input = broadScaleFixture(501); // 250,500 possible edges, over the 250,000 ceiling
  const started = process.hrtime.bigint();
  blockedWith(input, 'CANDIDATE_EDGE_LIMIT_EXCEEDED');
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 3000, 'early block elapsed ' + elapsedMs + 'ms');
});

process.stdout.write('schedule-autofill: ' + passed + '/' + passed + ' PASS\n');
