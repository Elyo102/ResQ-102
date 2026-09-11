import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { performance } from 'node:perf_hooks';

// Deterministic solver-readiness test. It does not measure concurrent users,
// Firestore, Functions, Auth, FCM, queues, quotas or cloud cost. Timing is only
// reported as a local observation and is never a release assertion.
const engineSource = fs.readFileSync(new URL('../functions/schedule-calendar-engine.js', import.meta.url), 'utf8');

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}

function assertPureSource(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const forbidden = [];
  walk(ast, (node, parent) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') forbidden.push(node.type);
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (callee?.type === 'Identifier' && ['require', 'fetch', 'eval'].includes(callee.name)) forbidden.push(callee.name);
      if (callee?.type === 'MemberExpression') {
        const object = callee.object?.name;
        const property = callee.computed ? callee.property?.value : callee.property?.name;
        if ((object === 'module' && property === 'require')
            || (object === 'globalThis' && ['fetch', 'WebSocket', 'XMLHttpRequest'].includes(property))) {
          forbidden.push(object + '.' + property);
        }
      }
    }
    if (node.type === 'Identifier' && [
      'require', 'process', 'fetch', 'eval', 'Function', 'globalThis', 'XMLHttpRequest', 'WebSocket'
    ].includes(node.name)) {
      const plainProperty = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const objectKey = parent?.type === 'Property' && parent.key === node && !parent.computed;
      if (!plainProperty && !objectKey) forbidden.push(node.name);
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier'
        && node.object.name === 'module') {
      const property = node.computed ? node.property?.value : node.property?.name;
      if (property !== 'exports') forbidden.push('module.' + String(property));
    }
    if (node.type === 'Identifier' && node.name === 'module') {
      const directExports = parent?.type === 'MemberExpression' && parent.object === node
        && (parent.computed ? parent.property?.value === 'exports' : parent.property?.name === 'exports');
      if (!directExports) forbidden.push('module alias');
    }
    if (node.type === 'MemberExpression') {
      const property = node.computed ? node.property?.value : node.property?.name;
      if (property === 'constructor') forbidden.push('constructor escape');
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier'
        && node.object.name === 'globalThis') forbidden.push('globalThis member');
  });
  assert.deepEqual(forbidden, [], 'calendar engine contains an I/O or module edge: ' + forbidden.join(', '));
}

for (const bad of [
  "require('firebase-admin')", "module.require('fs')", "import('firebase-admin')",
  "fetch('https://example.invalid')", "globalThis.fetch('https://example.invalid')",
  'process.env.SECRET', "new WebSocket('wss://example.invalid')",
  "const load=require; function dormant(){return load('fs')}",
  "const net=fetch; function dormant(){return net('https://example.invalid')}",
  "globalThis['fe'+'tch']('https://example.invalid')",
  "const g=globalThis; function dormant(){return g.fetch('https://example.invalid')}",
  "const m=module; function dormant(){return m.require('fs')}",
  "module.constructor.constructor('return process')()",
  "require.constructor('return process')()",
  "module.exports={createCalendarEngine:({clock})=>({planPeriod:()=>clock.constructor('return process')().version})}"
]) assert.throws(() => assertPureSource(bad));
for (const harmless of [
  "// require('fs')\nconst x = 1;", "const x = \"import('firebase-admin')\";",
  'const x = `fetch(https://example.invalid)`;', 'const x = { process: 1, fetch: 2 };'
]) assert.doesNotThrow(() => assertPureSource(harmless));
assertPureSource(engineSource);

function loadEngineSource(source) {
  assertPureSource(source);
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }
  });
  const wrapped = new vm.Script(
    "'use strict'; const module = { exports: {} };\n"
    + '(function(module, exports, require, process, fetch, XMLHttpRequest, WebSocket){\n' + source
    + '\n})(module, module.exports, undefined, undefined, undefined, undefined, undefined); module.exports;',
    { filename: 'schedule-calendar-engine.js', importModuleDynamically: () => Promise.reject(new Error('dynamic import denied')) }
  );
  return wrapped.runInContext(context);
}
const { createCalendarEngine } = loadEngineSource(engineSource);
assert.equal(typeof createCalendarEngine, 'function');

const DAYS = Array.from({ length: 31 }, (_, index) =>
  '2026-10-' + String(index + 1).padStart(2, '0'));
const GROUPS = ['A', 'B', 'C'];
const SOURCE = 'capacity-r2';

function person(stationId, id, sub, group, roles, active = true) {
  return {
    id: stationId + '-' + id, station_id: stationId, sub_station: sub, group, roles, active,
    source_snapshot: stationId + '-snapshot', source_version: SOURCE,
    contract_station_id: stationId, source_revision: 'capacity-revision',
    source_digest: stationId + '-source-digest', source_complete: true
  };
}

function stationFixture(stationId) {
  const roster = [];
  for (const group of GROUPS) {
    for (let i = 0; i < 20; i += 1) {
      const roles = i < 2 ? ['commander'] : i < 6 ? ['driver']
        : i < 10 ? ['driver', 'firefighter'] : ['firefighter'];
      roster.push(person(stationId, `main-${group}-${i}`, 'main', group, roles));
    }
    for (let i = 0; i < 13; i += 1) {
      const roles = i < 2 ? ['driver'] : i < 5 ? ['driver', 'firefighter'] : ['firefighter'];
      roster.push(person(stationId, `edge-${group}-${i}`, 'edge', group, roles));
    }
  }
  roster.push(person(stationId, 'inactive-spare', 'edge', 'A', ['driver', 'firefighter'], false));
  assert.equal(roster.length, 100);
  const availability = Object.create(null);
  availability[stationId + '-main-A-0'] = { [DAYS[0]]: { kind: 'medical-private-sentinel' } };
  availability[stationId + '-edge-B-0'] = { [DAYS[1]]: true };
  const locked = { main: { [DAYS[0]]: [{ person: stationId + '-main-A-10', role: 'firefighter' }] } };
  const policy = {
    station_id: stationId, version: SOURCE, digest: stationId + '-policy-digest',
    sub_stations: {
      main: { label: 'main', minimum: 10, requirements: [
        { role: 'commander', label: 'commander', count: 1, required: true },
        { role: 'driver', label: 'driver', count: 2, required: true },
        { role: 'firefighter', label: 'firefighter', count: 7, required: true }
      ] },
      edge: { label: 'edge', minimum: 5, requirements: [
        { role: 'driver', label: 'driver', count: 1, required: true },
        { role: 'firefighter', label: 'firefighter', count: 4, required: true }
      ] }
    },
    rest: { min_gap_days: 2 },
    rotation: { groups: GROUPS, anchor: DAYS[0], days_per_group: 1, strict: true },
    max_shifts_per_month: 4
  };
  return { stationId, roster, availability, locked, policy };
}

function planInput(fixture) {
  return {
    station_id: fixture.stationId, source_snapshot: fixture.stationId + '-snapshot', source_version: SOURCE,
    contract_station_id: fixture.stationId, source_revision: 'capacity-revision',
    source_digest: fixture.stationId + '-source-digest', policy_digest: fixture.stationId + '-policy-digest',
    source_complete: true, availability: fixture.availability, locked: fixture.locked, carry: {},
    days: DAYS, roster: fixture.roster
  };
}

function groupForDay(index) { return GROUPS[index % GROUPS.length]; }

function validatePlan(fixture, result) {
  assert.equal(result.station_id, fixture.stationId);
  assert.equal(result.source_snapshot, fixture.stationId + '-snapshot');
  assert.equal(result.source_version, SOURCE);
  assert.equal(result.source_complete, true);
  assert.equal(result.rows.length, DAYS.length * 2);
  const people = new Map(fixture.roster.map((row) => [row.id, row]));
  const previous = new Map();
  const loads = new Map();
  for (let dayIndex = 0; dayIndex < DAYS.length; dayIndex += 1) {
    const date = DAYS[dayIndex];
    const rows = result.rows.filter((row) => row.date === date);
    assert.equal(rows.length, 2);
    const used = new Set();
    for (const row of rows) {
      assert.equal(row.station_id, fixture.stationId);
      assert.equal(row.complete, true);
      assert.equal(row.gaps.length, 0);
      assert.equal(row.rejected_manual.length, 0);
      assert.equal(row.slots.length, row.minimum);
      const need = new Map(fixture.policy.sub_stations[row.sub_station].requirements.map((r) => [r.role, r.count]));
      for (const slot of row.slots) {
        assert.equal(used.has(slot.person), false, 'one person was assigned twice on ' + date);
        used.add(slot.person);
        const p = people.get(slot.person);
        assert.ok(p && p.active === true);
        assert.equal(p.station_id, fixture.stationId);
        assert.equal(p.sub_station, row.sub_station);
        assert.ok(p.roles.includes(slot.role));
        assert.equal(p.group, groupForDay(dayIndex));
        assert.equal(Boolean(fixture.availability[p.id]?.[date]), false);
        const prior = previous.get(p.id);
        if (prior !== undefined) assert.ok(dayIndex - prior > 2, 'rest gap violated');
        previous.set(p.id, dayIndex);
        const nextLoad = (loads.get(p.id) || 0) + 1;
        loads.set(p.id, nextLoad);
        assert.equal(slot.over_limit === true, nextLoad > fixture.policy.max_shifts_per_month);
        need.set(slot.role, need.get(slot.role) - 1);
      }
      assert.deepEqual([...need.values()], [...need.values()].map(() => 0));
    }
  }
  assert.equal(result.summary.filled, DAYS.length * 15);
  assert.equal(result.summary.blocking_gaps, 0);
  assert.equal(result.summary.rejected_manual, 0);
  assert.equal(result.rows.some((row) => row.slots.some((slot) => slot.source === 'manual')), true);
  assert.equal(result.rows.some((row) => row.slots.some((slot) => slot.over_limit === true)), true);
}

function runFixture(fixture) {
  const input = planInput(fixture);
  const before = JSON.stringify(input);
  const result = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: fixture.policy })
    .planPeriod(input);
  assert.equal(JSON.stringify(input), before, 'solver mutated its input');
  validatePlan(fixture, result);
  const repeat = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: fixture.policy })
    .planPeriod(structuredClone(input));
  assert.deepEqual(result, repeat, 'same constrained input must be deterministic');
  return result;
}

const started = performance.now();
const fixtures = Array.from({ length: 30 }, (_, index) =>
  stationFixture('capacity-station-' + String(index + 1).padStart(2, '0')));
const allIds = fixtures.flatMap((fixture) => fixture.roster.map((row) => row.id));
assert.equal(allIds.length, 3000);
assert.equal(new Set(allIds).size, 3000);
assert.ok(fixtures.every((fixture) => Object.keys(fixture.availability).length > 0));
assert.ok(fixtures.every((fixture) => Object.keys(fixture.locked).length > 0));
assert.ok(fixtures.every((fixture) => fixture.roster.some((row) => !row.active)));
const stationRuns = fixtures.map((fixture) => runFixture(fixture));
const observationMs = performance.now() - started;

// One large station is an algorithmic edge check only. It is not evidence for
// a supported tenant size or concurrent service capacity.
const largeStationId = 'capacity-large-station';
const largeRoster = Array.from({ length: 3000 }, (_, index) => person(
  largeStationId, 'person-' + String(index).padStart(4, '0'), 'main', GROUPS[index % 3], ['firefighter']
));
const largePolicy = {
  station_id: largeStationId, version: SOURCE, digest: largeStationId + '-policy-digest',
  sub_stations: { main: { label: 'main', minimum: 300, requirements: [
    { role: 'firefighter', label: 'firefighter', count: 300, required: true }
  ] } },
  rest: { min_gap_days: 2 },
  rotation: { groups: GROUPS, anchor: DAYS[0], days_per_group: 1, strict: true },
  max_shifts_per_month: 4
};
const largeFixture = {
  stationId: largeStationId, roster: largeRoster, availability: {}, locked: {}, policy: largePolicy
};
const candidateEdgeUpperBound = DAYS.length * 300 * largeRoster.length;
assert.ok(candidateEdgeUpperBound < 50_000_000);
const largeResult = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: largePolicy })
  .planPeriod(planInput(largeFixture));
assert.equal(largeResult.summary.filled, DAYS.length * 300);
assert.equal(largeResult.summary.blocking_gaps, 0);
for (let index = 0; index < largeResult.rows.length; index += 1) {
  const row = largeResult.rows[index];
  assert.equal(new Set(row.slots.map((slot) => slot.person)).size, row.slots.length);
  assert.ok(row.slots.every((slot) => largeRoster[Number(slot.person.slice(-4))]?.group === groupForDay(index)));
}

const scarcity = stationFixture('capacity-scarcity');
scarcity.availability[scarcity.stationId + '-main-A-1'] = { [DAYS[0]]: true };
const scarcityResult = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: scarcity.policy })
  .planPeriod(planInput(scarcity));
assert.equal(scarcityResult.summary.blocking_gaps, 1);
assert.equal(scarcityResult.summary.open_rows, 1);
const firstMain = scarcityResult.rows.find((row) => row.date === DAYS[0] && row.sub_station === 'main');
assert.equal(JSON.stringify(firstMain.gaps.map((gap) => gap.role)), JSON.stringify(['commander']));
assert.ok(firstMain.gaps[0].reasons.some((reason) => reason.code === 'not_available'));
assert.doesNotMatch(JSON.stringify(scarcityResult), /medical-private-sentinel/i);

const restPolicy = {
  station_id: 'capacity-rest', version: SOURCE, digest: 'capacity-rest-policy-digest',
  sub_stations: { main: { label: 'main', minimum: 1, requirements: [
    { role: 'firefighter', label: 'firefighter', count: 1, required: true }
  ] } },
  rest: { min_gap_days: 1 }, rotation: null, max_shifts_per_month: null
};
const restFixture = {
  stationId: 'capacity-rest', policy: restPolicy, availability: {}, locked: {},
  roster: [person('capacity-rest', 'only', 'main', 'A', ['firefighter'])]
};
const restBlocked = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: restPolicy })
  .planPeriod({ ...planInput(restFixture), days: [DAYS[0], DAYS[1]] });
assert.equal(restBlocked.rows[1].slots.length, 0);
assert.ok(restBlocked.rows[1].gaps[0].reasons.some((reason) => reason.code === 'rest'));
const restBoundary = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: restPolicy })
  .planPeriod({ ...planInput(restFixture), days: [DAYS[0], DAYS[2]] });
assert.equal(restBoundary.rows[1].slots.length, 1);

const overlapPolicy = {
  station_id: 'capacity-overlap', version: SOURCE, digest: 'capacity-overlap-policy-digest',
  sub_stations: { main: { label: 'main', minimum: 2, requirements: [
    { role: 'driver', label: 'driver', count: 1, required: true },
    { role: 'firefighter', label: 'firefighter', count: 1, required: true }
  ] } },
  rest: { min_gap_days: 0 }, rotation: null, max_shifts_per_month: null
};
const overlapFixture = {
  stationId: 'capacity-overlap', policy: overlapPolicy, availability: {}, locked: {}, roster: [
    person('capacity-overlap', 'a-versatile', 'main', 'A', ['driver', 'firefighter']),
    person('capacity-overlap', 'z-driver', 'main', 'A', ['driver']),
    person('capacity-overlap', 'z-firefighter', 'main', 'A', ['firefighter'])
  ]
};
overlapFixture.availability['capacity-overlap-z-firefighter'] = { [DAYS[0]]: true };
const overlapInput = {
  ...planInput(overlapFixture),
  days: [DAYS[0]],
  carry: { load: { 'capacity-overlap-z-driver': 1 }, lastDay: {}, byRole: {} }
};
const overlapResult = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: overlapPolicy })
  .planPeriod(overlapInput);
assert.equal(overlapResult.summary.filled, 2);
assert.ok(overlapResult.rows[0].slots.some((slot) => slot.person.endsWith('a-versatile') && slot.role === 'firefighter'));
const noReassignmentSource = engineSource.replace(
  'if (augment(current, seenPeople, seenDemands)) {',
  'if (false) {'
);
assert.notEqual(noReassignmentSource, engineSource, 'augmenting-path mutation must reach the engine');
const noReassignmentEngine = loadEngineSource(noReassignmentSource).createCalendarEngine({
  clock: () => '2026-10-01T00:00:00.000Z', policy: overlapPolicy
});
const noReassignmentResult = noReassignmentEngine.planPeriod({
  ...overlapInput
});
assert.equal(noReassignmentResult.summary.blocking_gaps, 1,
  'removing recursive reassignment must break the adversarial overlap graph');
const baselineFixture = fixtures[0];
const baseline = stationRuns[0];
for (const mutate of [
  (out) => { out.rows[0].slots[1].person = out.rows[0].slots[0].person; },
  (out) => { out.rows[0].slots[0].role = 'not-qualified'; },
  (out) => { out.rows[0].slots[0].person = baselineFixture.stationId + '-inactive-spare'; },
  (out) => { out.rows[0].slots[0].person = baselineFixture.stationId + '-main-B-2'; },
  (out) => { out.rows[0].sub_station = 'edge'; }
]) {
  const broken = structuredClone(baseline);
  mutate(broken);
  assert.throws(() => validatePlan(baselineFixture, broken));
}

const duplicateFixture = stationFixture('capacity-duplicate');
duplicateFixture.roster[1] = structuredClone(duplicateFixture.roster[0]);
assert.throws(() => createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: duplicateFixture.policy })
  .planPeriod(planInput(duplicateFixture)));

const missingGroupFixture = structuredClone(baselineFixture);
const firstAssignedId = baseline.rows[0].slots[0].person;
delete missingGroupFixture.roster.find((row) => row.id === firstAssignedId).group;
assert.throws(() => validatePlan(missingGroupFixture, baseline),
  'the oracle must reject an assigned person whose rotation group is missing');

const noAvailabilityFixture = structuredClone(baselineFixture);
noAvailabilityFixture.availability = {};
const noAvailabilityResult = createCalendarEngine({ clock: () => '2026-10-01T00:00:00.000Z', policy: noAvailabilityFixture.policy })
  .planPeriod(planInput(noAvailabilityFixture));
const commanderOf = (result) => result.rows.find((row) => row.date === DAYS[0] && row.sub_station === 'main')
  .slots.find((slot) => slot.role === 'commander').person;
assert.notEqual(commanderOf(noAvailabilityResult), commanderOf(baseline));

console.log('Synthetic constrained solver readiness PASS ' + JSON.stringify({
  synthetic_users: allIds.length, stations: fixtures.length, days: DAYS.length,
  constrained_filled_assignments: stationRuns.reduce((sum, run) => sum + run.summary.filled, 0),
  scarcity_blocking_gaps: scarcityResult.summary.blocking_gaps,
  single_station_records: largeRoster.length,
  single_station_candidate_edge_upper_bound: candidateEdgeUpperBound,
  local_observation_ms: Math.round(observationMs), scope: 'pure_calendar_solver_correctness_only'
}));
