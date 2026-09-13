/* ====================================================================
 * schedule-trial-publication-parity.mjs
 *
 * Contract test for the product rule that trial mode executes the same
 * publication lifecycle as live mode while suppressing only the irreversible
 * provider boundary.  This is an in-process runtime test with synthetic data;
 * it does not contact Firestore, Firebase Functions or FCM.
 * ==================================================================== */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFakeDb, seed, req, SHEET, ST, buildRuntime
} from './_schedule-fake.mjs';

const MODE = Object.freeze({ TRIAL: 'shadow', LIVE: 'new' });
const ALIASES = Object.freeze({ 'רועי': 'u1', 'אבטחה': null, 'גיא': 'u5' });
const CHANGED_SHEET = SHEET.replace(
  'שחמון\tיוסי מזרחי\t\tיוסי מזרחי',
  'שחמון\tיוסי מזרחי\tדניאל לוי\tיוסי מזרחי'
);
const ROLLBACK_REASON = 'wrong_assignment';

function directChildren(db, parent, collection) {
  const prefix = parent + '/' + collection + '/';
  return db._paths(prefix)
    .filter((path) => path.slice(prefix.length).indexOf('/') === -1)
    .map((path) => ({ path, value: db._get(path), ref: db.doc(path) }));
}

/* _schedule-fake intentionally implements only the Firestore surface used by
 * ordinary runtime tests.  resumeOutbox uses collectionGroup, so this test adds
 * the smallest deterministic read-only query facade needed to exercise the
 * real resume worker. */
function addCollectionGroup(db) {
  db.collectionGroup = function collectionGroup(name) {
    const filters = [];
    let cap = Infinity;
    const query = {
      where(field, op, value) {
        assert.equal(op, '==', 'the parity harness only supports equality filters');
        filters.push({ field, value });
        return query;
      },
      orderBy() { return query; },
      limit(value) { cap = Number(value); return query; },
      async get() {
        const candidates = db._paths('').filter((path) => {
          const parts = path.split('/');
          return parts.length >= 2 && parts[parts.length - 2] === name;
        });
        const docs = [];
        for (const path of candidates) {
          const value = db._get(path) || {};
          if (!filters.every((item) => value[item.field] === item.value)) continue;
          docs.push(await db.doc(path).get());
          if (docs.length >= cap) break;
        }
        return { docs, size: docs.length, empty: docs.length === 0 };
      }
    };
    return query;
  };
  return db;
}

function setMode(db, mode) {
  const current = db._get(ST + '/schedule_state/runtime') || {};
  db._put(ST + '/schedule_state/runtime', Object.assign({}, current, { mode }));
}

async function importDraft(rt, suffix, paste) {
  const preview = await rt.previewScheduleImport(req({
    month: '2026-09', paste, aliases: ALIASES, accept: {}
  }));
  assert.equal(preview.blocked, false, 'synthetic schedule must be importable');
  const imported = await rt.importScheduleSheet(req({
    request_id: 'import-' + suffix,
    month: '2026-09', paste, aliases: ALIASES, accept: {},
    expected_report_digest: preview.report_digest
  }));
  const draft = await rt.getDraftPreview(req({
    draft_id: imported.draft_id, start: '2026-09-01'
  }));
  return { imported, draft };
}

async function publishDraft(rt, input, suffix) {
  return rt.publish(req({
    request_id: 'publish-' + suffix,
    draft_id: input.imported.draft_id,
    expected_content_digest: input.draft.expected_content_digest,
    gap_acknowledgement: input.draft.gaps && input.draft.gaps.digest
  }));
}

async function rollbackPrevious(rt, db, suffix) {
  const active = db._get(ST + '/schedule_state/active');
  assert.ok(active && active.publication_id && active.previous_publication_id,
    'two publications must create an immediate rollback target');
  const data = {
    request_id: 'rollback-' + suffix,
    expected_active_publication_id: active.publication_id,
    target_publication_id: active.previous_publication_id,
    reason_code: ROLLBACK_REASON
  };
  try {
    return await rt.rollback(req(data));
  } catch (error) {
    if (!error || error.code !== 'gaps-acknowledgement-required') throw error;
    return rt.rollback(req(Object.assign({}, data, {
      gap_acknowledgement: error.detail && error.detail.digest
    })));
  }
}

function auditShape(db) {
  return directChildren(db, ST, 'schedule_audit')
    .map((item) => item.value)
    .sort((a, b) => Number(a.revision || 0) - Number(b.revision || 0))
    .map((value) => ({
      action: value.action,
      revision: value.revision,
      previous: value.previous_publication_id || value.from_publication_id || null,
      target: value.target_publication_id || null,
      by: value.by
    }));
}

function pointerShape(db) {
  const value = db._get(ST + '/schedule_state/active') || {};
  return {
    revision: value.revision,
    has_publication: typeof value.publication_id === 'string',
    has_previous: typeof value.previous_publication_id === 'string',
    has_rollback_target: typeof value.rollback_target_publication_id === 'string'
  };
}

async function deliverPublication(runtime, db, publicationId) {
  const parent = ST + '/schedule_publications/' + publicationId;
  const rows = directChildren(db, parent, 'schedule_outbox');
  for (const row of rows) await runtime.deliverOutbox(row.ref);
  return rows;
}

async function lifecycle(mode, label) {
  const db = addCollectionGroup(createFakeDb());
  let providerCalls = 0;
  const seeded = await seed(db);
  const rt = buildRuntime(db, {
    sendPush: async () => { providerCalls += 1; return { sent: 1 }; }
  });
  setMode(db, mode);

  const firstDraft = await importDraft(rt, label + '-1', SHEET);
  const first = await publishDraft(rt, firstDraft, label + '-1');
  const firstPointer = db._get(ST + '/schedule_state/active');
  assert.ok(firstPointer && firstPointer.publication_id === first.publication_id,
    'trial and live publication must both move the active pointer');

  const secondDraft = await importDraft(rt, label + '-2', CHANGED_SHEET);
  const second = await publishDraft(rt, secondDraft, label + '-2');
  const secondPointer = db._get(ST + '/schedule_state/active');
  assert.equal(secondPointer.previous_publication_id, first.publication_id,
    'the second publication must preserve rollback ancestry');

  const rolled = await rollbackPrevious(rt, db, label);
  const finalPointer = db._get(ST + '/schedule_state/active');
  assert.equal(finalPointer.publication_id, rolled.publication_id);
  assert.equal(finalPointer.rollback_target_publication_id, first.publication_id);

  return {
    db, rt, providerCalls: () => providerCalls,
    first, second, rolled,
    pointer: pointerShape(db), audit: auditShape(db),
    finalPublication: finalPointer.publication_id
  };
}

test('trial publication has the same active pointer, audit and rollback lifecycle as live', async () => {
  const live = await lifecycle(MODE.LIVE, 'live');
  const trial = await lifecycle(MODE.TRIAL, 'trial');

  assert.deepEqual(trial.pointer, live.pointer);
  assert.deepEqual(
    trial.audit.map(({ action, revision, by }) => ({ action, revision, by })),
    live.audit.map(({ action, revision, by }) => ({ action, revision, by }))
  );
  assert.deepEqual(trial.audit.map((item) => item.revision), [1, 2, 3]);
  assert.deepEqual(trial.audit.map((item) => item.action), ['publish', 'publish', 'rollback']);

  const liveRows = await deliverPublication(live.rt, live.db, live.finalPublication);
  assert.ok(liveRows.length > 0, 'live control must contain delivery work');
  assert.ok(live.providerCalls() > 0,
    'live control proves the injected provider boundary is observable');
});

test('every schedule reader uses the active v2 publication in trial mode', async () => {
  const trial = await lifecycle(MODE.TRIAL, 'reader');
  const publicationId = trial.finalPublication;
  const mine = await trial.rt.getMy(req({ date: '2026-09-01' }, 'u1'));
  const day = await trial.rt.getStation(req({ date: '2026-09-02' }, 'u2'));
  const range = await trial.rt.getStationRange(req({
    from: '2026-09-01', to: '2026-09-03'
  }, 'u2'));
  const workdays = await trial.rt.getEffectiveWorkdays(req({
    from: '2026-09-01', to: '2026-09-03', uids: ['u1', 'u2', 'u3']
  }, 'u2'));

  assert.deepEqual([
    mine.mode, mine.active, mine.publication_id, mine.fallback || null,
    day.mode, day.active, day.publication_id, day.fallback || null,
    range.mode, range.active, range.publication_id, range.source, range.fallback || null,
    workdays.source, workdays.fallback || null
  ], [
    MODE.TRIAL, true, publicationId, null,
    MODE.TRIAL, true, publicationId, null,
    MODE.TRIAL, true, publicationId, 'v2', null,
    'publication', null
  ]);
  assert.equal(mine.revision, 3);
  assert.equal(day.revision, 3);
  assert.equal(range.revision, 3);
  assert.ok(Object.values(workdays.by_uid).some((dates) => dates.length > 0),
    'the publication workday projection must contain assigned dates');
});

test('trial creates immutable suppressed_trial deliveries and never calls the provider', async () => {
  const trial = await lifecycle(MODE.TRIAL, 'suppressed');
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const outbox = directChildren(trial.db, parent, 'schedule_outbox');
  assert.ok(outbox.length > 0, 'trial must preserve the complete delivery intent for audit');
  assert.ok(outbox.every((item) => item.value.status === 'suppressed_trial'),
    'trial delivery intents must be terminal suppressed_trial records');
  assert.ok(outbox.every((item) => item.value.attempt === 0),
    'suppressed trial rows must never consume a provider attempt');

  await deliverPublication(trial.rt, trial.db, trial.finalPublication);
  assert.equal(trial.providerCalls(), 0, 'trial must make zero provider calls');
  assert.ok(outbox.every((item) => trial.db._get(item.path).status === 'suppressed_trial'),
    'direct delivery attempts cannot mutate a terminal trial record');
});

test('switching trial to live never flushes suppressed_trial deliveries', async () => {
  const trial = await lifecycle(MODE.TRIAL, 'no-flush');
  const prefix = ST + '/schedule_publications/';
  const before = trial.db._paths(prefix)
    .filter((path) => path.includes('/schedule_outbox/'))
    .map((path) => ({ path, value: trial.db._get(path) }))
    .filter((item) => item.value.status === 'suppressed_trial');
  assert.ok(before.length > 0, 'scenario must contain suppressed trial delivery intents');

  setMode(trial.db, MODE.LIVE);
  await trial.rt.resumeOutbox();
  for (const item of before) await trial.rt.deliverOutbox(trial.db.doc(item.path));

  assert.equal(trial.providerCalls(), 0,
    'mode switch must not turn historic trial intent into a real provider call');
  assert.ok(before.every((item) => trial.db._get(item.path).status === 'suppressed_trial'),
    'suppressed_trial is immutable across a later mode switch');
});
