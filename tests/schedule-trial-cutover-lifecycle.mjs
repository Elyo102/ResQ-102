/* ====================================================================
 * schedule-trial-cutover-lifecycle.mjs
 *
 * One real-runtime, in-memory lifecycle for the boundary that cannot be
 * proved by source checks:
 *
 *   last live publication -> trial revision A -> trial revision B
 *   -> discover one candidate -> signed preview -> promote -> live delivery
 *
 * The two trial revisions contain cumulative changes made to different
 * people.  Promotion therefore has to notify against the last live baseline,
 * not merely against the immediately preceding trial revision.  Historic
 * suppressed_trial rows are immutable audit evidence and may never become a
 * delivery queue.
 *
 * This test uses synthetic data and never contacts Firebase or FCM.
 * ==================================================================== */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFakeDb, seed, req, SHEET, ST, MGR, buildRuntime
} from './_schedule-fake.mjs';

const ALIASES = Object.freeze({ 'רועי': 'u1', 'אבטחה': null, 'גיא': 'u5' });
const TRIAL_A = SHEET.replace(
  'שחמון\tיוסי מזרחי\t\tיוסי מזרחי',
  'שחמון\tיוסי מזרחי\tדניאל לוי\tיוסי מזרחי'
);
const TRIAL_B = TRIAL_A.replace(
  'יטבתה\t\tגיא\t',
  'יטבתה\t\tגיא\tנועם דהן'
);

function setMode(db, mode) {
  const current = db._get(ST + '/schedule_state/runtime') || {};
  db._put(ST + '/schedule_state/runtime', Object.assign({}, current, { mode }));
}

function command(data) {
  return {
    auth: {
      uid: 'uid-commander',
      token: { stationId: 'station_102', role: 'commander', name: 'מפקד בדיקה' }
    },
    data: data || {}
  };
}

function directChildren(db, parent, collection) {
  const prefix = parent + '/' + collection + '/';
  return db._paths(prefix)
    .filter((path) => path.slice(prefix.length).indexOf('/') === -1)
    .map((path) => ({ path, ref: db.doc(path), value: db._get(path) }));
}

function rowsFor(db, publicationId) {
  return directChildren(db, ST + '/schedule_publications/' + publicationId, 'schedule_outbox');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((key) => { out[key] = canonical(value[key]); });
    return out;
  }
  return value;
}

function frozenRows(rows) {
  return rows.map((row) => ({ path: row.path, value: canonical(row.value) }));
}

function people(rows) {
  return new Set(rows.map((row) => row.value.person));
}

function sorted(set) {
  return Array.from(set).sort();
}

function assertCandidateMatchesActive(candidate, candidateMeta, activePointer, activeMeta) {
  assert.ok(candidate && candidate.ambiguous !== true,
    'trial lifecycle must expose one unambiguous promotable candidate');
  assert.equal(candidate.prepared_count, 1,
    'exactly one candidate must be eligible for promotion');
  assert.ok(candidateMeta, 'candidate publication must exist');
  assert.equal(candidateMeta.trial_source_publication_id, activePointer.publication_id,
    'candidate must be derived from the active trial, not another prepared publication');
  assert.equal(candidateMeta.content_digest, activeMeta.content_digest,
    'candidate must carry the active trial snapshot, not an older revision');
  assert.equal(candidate.content_hash, activeMeta.content_hash,
    'candidate content must be the latest signed trial snapshot');
}

function assertLiveBaselineCoverage(actualPeople, expectedPeople, earlierOnly) {
  assert.deepEqual(sorted(actualPeople), sorted(expectedPeople),
    'live delivery must cover the cumulative baseline-to-latest delta');
  for (const person of earlierOnly) {
    assert.ok(actualPeople.has(person),
      'a change introduced in the earlier trial revision was lost at promotion: ' + person);
  }
}

function assertSuppressedHistoryUnchanged(actual, expected) {
  assert.deepEqual(actual, expected, 'suppressed_trial history changed during cutover');
}

test('lifecycle assertions kill the four unsafe cutover mutations', () => {
  const activePointer = { publication_id: 'trial-b' };
  const activeMeta = { content_digest: 'digest-b', content_hash: 'hash-b' };
  const candidate = { publication_id: 'candidate-b', prepared_count: 1, content_hash: 'hash-b' };
  const validCandidateMeta = {
    trial_source_publication_id: 'trial-b', content_digest: 'digest-b'
  };
  assert.doesNotThrow(() => assertCandidateMatchesActive(
    candidate, validCandidateMeta, activePointer, activeMeta
  ));

  assert.throws(() => assertCandidateMatchesActive(candidate, {
    trial_source_publication_id: 'trial-a', content_digest: 'digest-b'
  }, activePointer, activeMeta), /active trial/,
  'M1: a shape-valid candidate linked to a non-active trial must be caught');

  const fullDelta = new Set(['changed-in-a', 'changed-in-b']);
  const earlierOnly = new Set(['changed-in-a']);
  assert.throws(() => assertLiveBaselineCoverage(
    new Set(['changed-in-b']), fullDelta, earlierOnly
  ), /cumulative baseline-to-latest/,
  'M2: computing recipients only from the previous trial revision must be caught');

  const frozen = [{ path: 'trial-a/outbox/n1', value: { status: 'suppressed_trial' } }];
  assert.throws(() => assertSuppressedHistoryUnchanged(
    [{ path: 'trial-a/outbox/n1', value: { status: 'queued' } }], frozen
  ), /suppressed_trial history changed/,
  'M3: releasing or converting a suppressed_trial row must be caught');

  assert.throws(() => assertCandidateMatchesActive(candidate, {
    trial_source_publication_id: 'trial-a', content_digest: 'digest-a'
  }, activePointer, activeMeta), /active trial|active trial snapshot/,
  'M4: selecting an older prepared candidate must be caught');
});

async function draftAndPublish(rt, label, paste) {
  const preview = await rt.previewScheduleImport(req({
    month: '2026-09', paste, aliases: ALIASES, accept: {}
  }));
  assert.equal(preview.blocked, false, label + ': fixture must be importable');
  const imported = await rt.importScheduleSheet(req({
    request_id: 'import-' + label,
    month: '2026-09', paste, aliases: ALIASES, accept: {},
    expected_report_digest: preview.report_digest
  }));
  const draft = await rt.getDraftPreview(req({
    draft_id: imported.draft_id, start: '2026-09-01'
  }));
  const published = await rt.publish(req({
    request_id: 'publish-' + label,
    draft_id: imported.draft_id,
    expected_content_digest: draft.expected_content_digest,
    gap_acknowledgement: draft.gaps && draft.gaps.digest
  }));
  return { imported, draft, published };
}

async function deliverRows(rt, rows) {
  for (const row of rows) await rt.deliverOutbox(row.ref);
}

async function unconfiguredWorkbookTrial(label) {
  const db = createFakeDb();
  for (const [uid, role] of [[MGR, 'firefighter'], ['uid-commander', 'commander']]) {
    db._put(ST + '/users/' + uid, { station_id:'station_102', station:'station_102',
      is_active:true, active:true, role, full_name:uid });
  }
  db._put(ST + '/schedule_access/' + MGR, { schema_version:1, station_id:'station_102',
    uid:MGR, roles:['schedule_manager'], active:true, revision:1 });
  db._put(ST + '/schedule_state/runtime', { mode:'shadow' });
  ['A','B','C'].forEach((crew, position) => db._put(ST + '/rotations/' + crew,
    { anchor_date:'2026-09-01', cycle_days:3, position_in_cycle:position, crew, is_active:true }));
  const deliveries = [];
  const rt = buildRuntime(db, { sendPush:async (...args) => {
    deliveries.push(args); return { sent:1 };
  } });
  const result = await draftAndPublish(rt, label, SHEET);
  const candidates = directChildren(db, ST, 'schedule_publications')
    .filter(row => row.value.status === 'prepared'
      && row.value.trial_source_publication_id === result.published.publication_id);
  assert.equal(candidates.length, 1);
  return { db, rt, deliveries, result, candidate:candidates[0] };
}

test('unconfigured workbook trial promotes its own signed basis without notifying external people', async () => {
  const { db, rt, deliveries, result, candidate } = await unconfiguredWorkbookTrial('workbook-cutover');
  assert.equal(candidate.value.workbook_managed, true);
  assert.equal(rowsFor(db, candidate.ref.id).length, 0,
    'external person IDs must never become live push recipients');
  assert.ok(db._paths(ST + '/schedule_people/').length > 1);
  const report = await rt.previewCutover(command({ candidate_publication_id:candidate.ref.id }));
  assert.equal(report.blocked, false);
  const promoted = await rt.promoteToNew(command({ request_id:'promote-workbook-cutover',
    candidate_publication_id:candidate.ref.id, expected_mode:'shadow',
    expected_preflight_signature:report.signature,
    accept_changes:report.changes && report.changes.count > 0 ? report.signature : null }));
  assert.equal(promoted.mode, 'new');
  assert.equal(db._get(ST + '/schedule_state/active').publication_id, candidate.ref.id);
  assert.equal(db._get(candidate.path).content_digest,
    db._get(ST + '/schedule_publications/' + result.published.publication_id).content_digest);
  const config = db._get(ST + '/schedule_state/runtime');
  assert.equal(config.active_policy_id || null, null);
  assert.equal(config.active_source_id || null, null);
  const range = await rt.getStationRange(req({ from:result.imported.from, to:result.imported.to }));
  assert.ok(range.days.some(day => day.sub_stations.some(station =>
    station.people.some(person => person.person === 'יוסי מזרחי'))));
  await deliverRows(rt, rowsFor(db, candidate.ref.id));
  assert.equal(deliveries.length, 0);
});

test('old workbook candidate without basis marker is rejected without rewriting evidence', async () => {
  const { db, rt, result, candidate } = await unconfiguredWorkbookTrial('workbook-old-candidate');
  const old = { ...db._get(candidate.path) };
  delete old.workbook_managed;
  db._put(candidate.path, old);
  const evidence = directChildren(db, ST, 'schedule_publications').map(row => ({
    path:row.path, value:canonical(row.value), outbox:frozenRows(rowsFor(db, row.ref.id))
  }));
  await assert.rejects(rt.publish(req({ request_id:'publish-workbook-old-candidate',
    draft_id:result.imported.draft_id, expected_content_digest:result.draft.expected_content_digest,
    gap_acknowledgement:result.draft.gaps && result.draft.gaps.digest })),
  error => error.code === 'trial-candidate-stale');
  assert.deepEqual(directChildren(db, ST, 'schedule_publications').map(row => ({
    path:row.path, value:canonical(row.value), outbox:frozenRows(rowsFor(db, row.ref.id))
  })), evidence);
});

test('latest trial revision is the sole promotable candidate and cutover delivers the full live delta', async () => {
  const db = createFakeDb();
  await seed(db);
  db._put(ST + '/users/uid-commander', {
    station_id: 'station_102', station: 'station_102',
    is_active: true, active: true, role: 'commander', full_name: 'מפקד בדיקה'
  });

  const deliveries = [];
  const rt = buildRuntime(db, {
    sendPush: async (stationId, person, type, title, body, url, important) => {
      deliveries.push({ stationId, person, type, title, body, url, important });
      return { sent: 1 };
    }
  });

  // Establish an actual live publication.  Its delivery is completed and then
  // excluded from the assertions below; it is the comparison baseline.
  setMode(db, 'new');
  const baseline = await draftAndPublish(rt, 'baseline', SHEET);
  const baselineId = baseline.published.publication_id;
  await deliverRows(rt, rowsFor(db, baselineId));
  deliveries.length = 0;

  setMode(db, 'shadow');
  const first = await draftAndPublish(rt, 'trial-a', TRIAL_A);
  const firstRows = rowsFor(db, first.published.publication_id);
  assert.ok(firstRows.length > 0, 'trial A must contain a real changed-person intent');
  assert.ok(firstRows.every((row) => row.value.status === 'suppressed_trial'));
  const firstPeople = people(firstRows);
  const firstPrepared = directChildren(db, ST, 'schedule_publications')
    .filter((row) => row.value.status === 'prepared'
      && row.value.trial_source_publication_id === first.published.publication_id);
  assert.equal(firstPrepared.length, 1,
    'trial A must leave one old prepared candidate for the stale-candidate regression');

  const second = await draftAndPublish(rt, 'trial-b', TRIAL_B);
  const secondRows = rowsFor(db, second.published.publication_id);
  assert.ok(secondRows.length > 0, 'trial B must contain a second changed-person intent');
  assert.ok(secondRows.every((row) => row.value.status === 'suppressed_trial'));
  assert.equal(deliveries.length, 0, 'neither trial revision may cross the provider boundary');
  const secondPeople = people(secondRows);

  const earlierOnly = new Set([...firstPeople].filter((person) => !secondPeople.has(person)));
  assert.ok(earlierOnly.size > 0,
    'fixture must include a person changed in trial A but not in the trial-B delta');
  const sequentialUnion = new Set([...firstPeople, ...secondPeople]);
  const immutableTrialRows = frozenRows(firstRows.concat(secondRows));

  // The command view is the public discovery contract.  Older trial revisions
  // must not remain competing candidates after a newer revision is published.
  const activeTrialPointer = db._get(ST + '/schedule_state/active');
  assert.equal(activeTrialPointer.publication_id, second.published.publication_id,
    'fixture must make trial B the active trial before candidate discovery');
  const options = await rt.getModeOptions(command({}));
  const latestMeta = db._get(ST + '/schedule_publications/' + second.published.publication_id);
  const candidateMeta = db._get(ST + '/schedule_publications/' + options.candidate.publication_id);
  assertCandidateMatchesActive(options.candidate, candidateMeta, activeTrialPointer, latestMeta);
  assert.notEqual(options.candidate.publication_id, firstPrepared[0].ref.id,
    'the prepared candidate from trial A must not displace the active trial-B candidate');
  assert.equal((db._get(firstPrepared[0].path) || {}).status, 'prepared',
    'the regression must exercise an old prepared candidate that still exists');

  const report = await rt.previewCutover(command({
    candidate_publication_id: options.candidate.publication_id
  }));
  assert.equal(typeof report.signature, 'string');
  assert.ok(report.signature.length > 0, 'cutover preview must be signed');
  assert.equal(report.blocked, false, 'synthetic latest trial must be promotable');

  const promoted = await rt.promoteToNew(command({
    request_id: 'promote-latest-trial',
    candidate_publication_id: options.candidate.publication_id,
    expected_mode: 'shadow',
    expected_preflight_signature: report.signature,
    accept_changes: report.changes && report.changes.count > 0 ? report.signature : null
  }));
  assert.equal(promoted.mode, 'new');
  assert.equal(promoted.publication_id, options.candidate.publication_id,
    'promotion must activate the candidate that was reviewed');

  const pointer = db._get(ST + '/schedule_state/active');
  assert.equal(pointer.publication_id, promoted.publication_id);
  assert.equal(pointer.content_digest, latestMeta.content_digest);
  assert.equal((db._get(ST + '/schedule_state/runtime') || {}).mode, 'new');

  // Promotion releases live rows but does not itself cross the provider
  // boundary.  Deliver only rows belonging to the promoted publication.
  const promotedRows = rowsFor(db, promoted.publication_id)
    .filter((row) => row.value.delivery_policy === 'live');
  assert.ok(promotedRows.length > 0, 'promotion must create/release a live delivery delta');
  assert.ok(promotedRows.every((row) => row.value.delivery_allowed === true));
  await deliverRows(rt, promotedRows);
  assert.ok(promotedRows.every((row) => (db._get(row.path) || {}).status === 'sent'),
    'every released live row must reach a terminal sent receipt in this fixture');

  const deliveredPeople = new Set(deliveries.map((item) => item.person));
  assertLiveBaselineCoverage(deliveredPeople, sequentialUnion, earlierOnly);
  assert.equal(new Set(deliveries.map((item) => item.person)).size, deliveries.length,
    'cutover must not deliver twice to one changed person');

  // The historic suppressed intents are audit evidence.  Neither promotion,
  // release nor direct delivery may rewrite or flush them.
  assertSuppressedHistoryUnchanged(
    frozenRows(firstRows.concat(secondRows).map((row) => ({
      path: row.path, ref: row.ref, value: db._get(row.path)
    }))),
    immutableTrialRows
  );
});
