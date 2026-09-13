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

const MODE = Object.freeze({ OFF: 'off', TRIAL: 'shadow', LIVE: 'new' });
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

function databaseShape(db) {
  return db._paths('').map((path) => ({ path, value: db._get(path) }));
}

async function deliverPublication(runtime, db, publicationId) {
  const parent = ST + '/schedule_publications/' + publicationId;
  const rows = directChildren(db, parent, 'schedule_outbox');
  for (const row of rows) await runtime.deliverOutbox(row.ref);
  return rows;
}

async function lifecycle(mode, label, options = {}) {
  const db = addCollectionGroup(createFakeDb());
  if (typeof options.onDb === 'function') options.onDb(db);
  let providerCalls = 0;
  const seeded = await seed(db);
  if (options.control) {
    const activationAuthTimeMs = Number(options.control.activation_auth_time_ms
      || Date.parse('2026-08-25T05:00:00.000Z'));
    db._put(ST + '/live_lab_config/current', {
      schema: 'personal-live-lab-v2', enabled: true, allowed_uid: options.control.uid,
      generation: options.control.generation,
      activation_auth_time_ms: activationAuthTimeMs,
      expires_at_ms: options.control.expires_at_ms
    });
  }
  const rt = buildRuntime(db, {
    sendPush: async (...args) => {
      providerCalls += 1;
      if (typeof options.sendPush === 'function') return options.sendPush(...args);
      return { sent: 1 };
    },
    getAuthUser: options.getAuthUser || (async (uid) => ({ uid, disabled: false,
      tokensValidAfterTime: '2026-08-25T04:00:00.000Z',
      customClaims: { super: true, personal_lab_control: true,
        stationId: ST.slice('stations/'.length) } })),
    beforeOutboxSend: options.beforeOutboxSend
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

test('switching live to trial cancels every unfinished live delivery without calling the provider', async () => {
  for (const status of ['queued', 'retry', 'sending']) {
    const live = await lifecycle(MODE.LIVE, 'live-to-trial-' + status);
    const parent = ST + '/schedule_publications/' + live.finalPublication;
    const rows = directChildren(live.db, parent, 'schedule_outbox');
    assert.ok(rows.length > 0, status + ' scenario must contain live delivery work');
    for (const row of rows) {
      live.db._put(row.path, Object.assign({}, row.value, {
        status,
        next_attempt_at: status === 'retry' ? new Date(0) : null,
        lease_until: status === 'sending' ? new Date(0) : null,
        lease_token: status === 'sending' ? 'expired-lease' : null
      }));
    }

    setMode(live.db, MODE.TRIAL);
    await live.rt.resumeOutbox();

    assert.equal(live.providerCalls(), 0,
      status + ' live work must never cross the provider boundary in trial mode');
    assert.ok(rows.every((row) => live.db._get(row.path).status === 'cancelled'),
      status + ' live work must become terminal after the mode transition');
    assert.ok(rows.every((row) => live.db._get(row.path).cancel_reason === 'delivery-forbidden'));
  }
});

test('trial sends a schedule push only to the active personal control account', async () => {
  const control = { uid: 'u2', generation: 7, expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  const trial = await lifecycle(MODE.TRIAL, 'control', { control });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const rows = directChildren(trial.db, parent, 'schedule_outbox');
  const controlRows = rows.filter((item) => item.value.delivery_policy === 'trial_control');
  const suppressed = trial.db._paths(ST + '/schedule_publications/')
    .filter((path) => path.includes('/schedule_outbox/'))
    .map((path) => ({ path, value: trial.db._get(path) }))
    .filter((item) => item.value.delivery_policy === 'suppressed_trial');
  assert.equal(controlRows.length, 1, 'only the changed control user may cross the trial boundary');
  assert.equal(controlRows[0].value.person, control.uid);
  assert.equal(controlRows[0].value.control_generation, control.generation);
  assert.ok(suppressed.length > 0, 'all non-control intents remain auditable and terminal');

  await deliverPublication(trial.rt, trial.db, trial.finalPublication);
  assert.equal(trial.providerCalls(), 1);
  assert.equal(trial.db._get(controlRows[0].path).status, 'sent');
  assert.ok(suppressed.every((item) => trial.db._get(item.path).status === 'suppressed_trial'));
});

test('revoking the personal control fence immediately before send fails closed', async () => {
  const control = { uid: 'u2', generation: 11, expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  let dbRef = null;
  const trial = await lifecycle(MODE.TRIAL, 'revoked-control', {
    control,
    beforeOutboxSend: async () => {
      dbRef._put(ST + '/live_lab_config/current', Object.assign({},
        dbRef._get(ST + '/live_lab_config/current'), { enabled: false }));
    }
  });
  dbRef = trial.db;
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const controlRow = directChildren(trial.db, parent, 'schedule_outbox')
    .find((item) => item.value.delivery_policy === 'trial_control');
  assert.ok(controlRow, 'scenario must stage one control delivery');

  await trial.rt.deliverOutbox(controlRow.ref);
  assert.equal(trial.providerCalls(), 0);
  assert.equal(trial.db._get(controlRow.path).status, 'cancelled');
});

test('disabling the control account immediately before send fails closed', async () => {
  const control = { uid: 'u2', generation: 12, expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  let disabled = false;
  const trial = await lifecycle(MODE.TRIAL, 'disabled-control', {
    control,
    beforeOutboxSend: async () => { disabled = true; },
    getAuthUser: async (uid) => ({ uid, disabled,
      tokensValidAfterTime: '2026-08-25T04:00:00.000Z',
      customClaims: { super: true, personal_lab_control: true,
        stationId: ST.slice('stations/'.length) } })
  });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const controlRow = directChildren(trial.db, parent, 'schedule_outbox')
    .find((item) => item.value.delivery_policy === 'trial_control');
  assert.ok(controlRow, 'scenario must stage one control delivery');

  await trial.rt.deliverOutbox(controlRow.ref);
  assert.equal(trial.providerCalls(), 0);
  assert.equal(trial.db._get(controlRow.path).status, 'cancelled');
});

test('expired or generation-mismatched control configuration sends nothing', async () => {
  for (const [label, control, mutate] of [
    ['expired', { uid: 'u2', generation: 1, expires_at_ms: Date.parse('2026-08-25T06:00:00.000Z') }, null],
    ['generation', { uid: 'u2', generation: 2, expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') },
      (db) => db._put(ST + '/live_lab_config/current', {
        schema: 'personal-live-lab-v2', enabled: true, allowed_uid: 'u2', generation: 3,
        activation_auth_time_ms: Date.parse('2026-08-25T05:00:00.000Z'),
        expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z')
      })]
  ]) {
    const trial = await lifecycle(MODE.TRIAL, label, { control });
    if (mutate) mutate(trial.db);
    await deliverPublication(trial.rt, trial.db, trial.finalPublication);
    assert.equal(trial.providerCalls(), 0, label + ' config must make zero provider calls');
  }
});

test('a temporary Auth lookup failure retries the same control row and sends once', async () => {
  const control = { uid: 'u2', generation: 21, expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  let atSendBoundary = false;
  let temporaryFailures = 0;
  const trial = await lifecycle(MODE.TRIAL, 'temporary-auth', {
    control,
    beforeOutboxSend: async () => { atSendBoundary = true; },
    getAuthUser: async (uid) => {
      if (atSendBoundary && temporaryFailures === 0) {
        temporaryFailures += 1;
        const error = new Error('synthetic transient Auth outage');
        error.code = 'auth/internal-error';
        throw error;
      }
      return { uid, disabled: false,
        tokensValidAfterTime: '2026-08-25T04:00:00.000Z',
        customClaims: { super: true, personal_lab_control: true,
          stationId: ST.slice('stations/'.length) } };
    }
  });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const controlRow = directChildren(trial.db, parent, 'schedule_outbox')
    .find((item) => item.value.delivery_policy === 'trial_control');
  assert.ok(controlRow, 'scenario must stage one control delivery');

  await trial.rt.deliverOutbox(controlRow.ref);
  const afterFailure = trial.db._get(controlRow.path);
  assert.equal(afterFailure.status, 'retry');
  assert.equal(afterFailure.attempt, 1);
  assert.equal(trial.providerCalls(), 0);

  trial.db._put(controlRow.path, Object.assign({}, afterFailure, { next_attempt_at: new Date(0) }));
  await trial.rt.resumeOutbox();
  assert.equal(trial.db._get(controlRow.path).status, 'queued',
    'the first recovery pass makes the due retry claimable without sending inline');
  await trial.rt.resumeOutbox();
  assert.equal(trial.db._get(controlRow.path).status, 'sent');
  assert.equal(trial.providerCalls(), 1, 'retry must cross the provider boundary exactly once');
  assert.equal(temporaryFailures, 1);
});

test('removing personal_lab_control immediately before send calls no provider', async () => {
  const control = { uid: 'u2', generation: 22, expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  let revoked = false;
  const trial = await lifecycle(MODE.TRIAL, 'claim-revoked', {
    control,
    beforeOutboxSend: async () => { revoked = true; },
    getAuthUser: async (uid) => ({ uid, disabled: false,
      tokensValidAfterTime: '2026-08-25T04:00:00.000Z',
      customClaims: { super: true, personal_lab_control: !revoked,
        stationId: ST.slice('stations/'.length) } })
  });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const controlRow = directChildren(trial.db, parent, 'schedule_outbox')
    .find((item) => item.value.delivery_policy === 'trial_control');
  assert.ok(controlRow);

  await trial.rt.deliverOutbox(controlRow.ref);
  assert.equal(trial.providerCalls(), 0);
  assert.equal(trial.db._get(controlRow.path).status, 'cancelled');
  assert.equal(trial.db._get(controlRow.path).cancel_reason, 'trial-control-inactive');
});

test('tokens revoked after control activation call no provider', async () => {
  const activation = Date.parse('2026-08-25T05:00:00.000Z');
  const control = { uid: 'u2', generation: 23, activation_auth_time_ms: activation,
    expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  let revoked = false;
  const trial = await lifecycle(MODE.TRIAL, 'tokens-revoked', {
    control,
    beforeOutboxSend: async () => { revoked = true; },
    getAuthUser: async (uid) => ({ uid, disabled: false,
      tokensValidAfterTime: revoked
        ? '2026-08-25T05:00:01.000Z' : '2026-08-25T04:00:00.000Z',
      customClaims: { super: true, personal_lab_control: true,
        stationId: ST.slice('stations/'.length) } })
  });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const controlRow = directChildren(trial.db, parent, 'schedule_outbox')
    .find((item) => item.value.delivery_policy === 'trial_control');
  assert.ok(controlRow);
  assert.equal(controlRow.value.control_auth_time_ms, activation);

  await trial.rt.deliverOutbox(controlRow.ref);
  assert.equal(trial.providerCalls(), 0);
  assert.equal(trial.db._get(controlRow.path).status, 'cancelled');
  assert.equal(trial.db._get(controlRow.path).cancel_reason, 'trial-control-inactive');
});

test('temporary Auth during trial staging retries the same publication intent', async () => {
  const db = addCollectionGroup(createFakeDb());
  await seed(db); setMode(db, MODE.TRIAL);
  const activation = Date.parse('2026-08-25T05:00:00.000Z');
  db._put(ST + '/live_lab_config/current', {
    schema: 'personal-live-lab-v2', enabled: true, allowed_uid: 'u2', generation: 31,
    activation_auth_time_ms: activation, expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z')
  });
  let authCalls = 0;
  const rt = buildRuntime(db, { getAuthUser: async uid => {
    authCalls++;
    if (authCalls === 1) { const error = new Error('temporary'); error.code = 'auth/internal-error'; throw error; }
    return { uid, disabled: false, tokensValidAfterTime: '2026-08-25T04:00:00.000Z',
      customClaims: { super: true, personal_lab_control: true,
        stationId: ST.slice('stations/'.length) } };
  } });
  const draft = await importDraft(rt, 'staging-auth-retry', SHEET);
  const payload = { request_id: 'publish-staging-auth-retry', draft_id: draft.imported.draft_id,
    expected_content_digest: draft.draft.expected_content_digest,
    gap_acknowledgement: draft.draft.gaps && draft.draft.gaps.digest };
  await assert.rejects(rt.publish(req(payload)), error => error && error.code === 'TRIAL_AUTH_TEMPORARY');
  const receipt = await rt.publish(req(payload));
  assert.equal(receipt.trial_control_notifications, 1);
});

test('revocation after the transactional send fence still blocks the provider', async () => {
  const control = { uid: 'u2', generation: 32,
    expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  let deliveryPhase = false;
  let deliveryAuthCalls = 0;
  const trial = await lifecycle(MODE.TRIAL, 'post-transaction-revoke', {
    control,
    beforeOutboxSend: async () => { deliveryPhase = true; },
    getAuthUser: async uid => {
      if (deliveryPhase) deliveryAuthCalls++;
      return { uid, disabled: false,
        tokensValidAfterTime: '2026-08-25T04:00:00.000Z',
        customClaims: { super: true,
          personal_lab_control: !deliveryPhase || deliveryAuthCalls < 2,
          stationId: ST.slice('stations/'.length) } };
    }
  });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const row = directChildren(trial.db, parent, 'schedule_outbox')
    .find(item => item.value.delivery_policy === 'trial_control');
  assert.ok(row);
  await trial.rt.deliverOutbox(row.ref);
  assert.equal(trial.providerCalls(), 0);
  assert.equal(trial.db._get(row.path).cancel_reason, 'trial-control-inactive');
});

test('trial config disabled during the Auth fence is rechecked before provider', async () => {
  const control = { uid: 'u2', generation: 33,
    expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  let liveDb = null, deliveryPhase = false, deliveryAuthCalls = 0;
  const trial = await lifecycle(MODE.TRIAL, 'post-auth-config-disable', {
    control,
    onDb: db => { liveDb = db; },
    beforeOutboxSend: async () => { deliveryPhase = true; },
    getAuthUser: async uid => {
      if (deliveryPhase && ++deliveryAuthCalls === 2) {
        const path = ST + '/live_lab_config/current';
        liveDb._put(path, Object.assign({}, liveDb._get(path), { enabled: false }));
      }
      return { uid, disabled: false, tokensValidAfterTime: '2026-08-25T04:00:00.000Z',
        customClaims: { super: true, personal_lab_control: true,
          stationId: ST.slice('stations/'.length) } };
    }
  });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const row = directChildren(trial.db, parent, 'schedule_outbox')
    .find(item => item.value.delivery_policy === 'trial_control');
  assert.ok(row);
  await trial.rt.deliverOutbox(row.ref);
  assert.equal(trial.providerCalls(), 0);
  assert.equal(trial.db._get(row.path).cancel_reason, 'delivery-forbidden');
});

test('only the final retried send-fence callback may authorize the provider', async () => {
  const control = { uid: 'u2', generation: 33,
    expires_at_ms: Date.parse('2026-08-25T07:00:00.000Z') };
  const trial = await lifecycle(MODE.TRIAL, 'transaction-retry-leak', { control });
  const parent = ST + '/schedule_publications/' + trial.finalPublication;
  const row = directChildren(trial.db, parent, 'schedule_outbox')
    .find((item) => item.value.delivery_policy === 'trial_control');
  assert.ok(row);

  const rawTransaction = trial.db.runTransaction.bind(trial.db);
  let deliveryTransactions = 0;
  trial.db.runTransaction = async (fn) => {
    deliveryTransactions += 1;
    if (deliveryTransactions !== 3) return rawTransaction(fn);
    const marker = new Error('synthetic-transaction-retry');
    try {
      return await rawTransaction(async (tx) => {
        const result = await fn(tx);
        assert.equal(result, true, 'the discarded attempt must first authorize');
        throw marker;
      });
    } catch (error) {
      if (error !== marker) throw error;
      const configPath = ST + '/live_lab_config/current';
      trial.db._put(configPath, { ...trial.db._get(configPath), enabled: false });
      return rawTransaction(fn);
    }
  };

  await trial.rt.deliverOutbox(row.ref);
  assert.equal(trial.providerCalls(), 0);
  assert.equal(trial.db._get(row.path).cancel_reason, 'delivery-forbidden');
});

test('lost publish response replays its receipt after shadow to new without side effects', async () => {
  const db = addCollectionGroup(createFakeDb());
  await seed(db);
  const rt = buildRuntime(db);
  setMode(db, MODE.TRIAL);
  const draft = await importDraft(rt, 'publish-lost-response', SHEET);
  const payload = {
    request_id: 'publish-lost-response',
    draft_id: draft.imported.draft_id,
    expected_content_digest: draft.draft.expected_content_digest,
    gap_acknowledgement: draft.draft.gaps && draft.draft.gaps.digest
  };
  const receipt = await rt.publish(req(payload));
  setMode(db, MODE.OFF);
  db._del(ST + '/schedule_drafts/' + draft.imported.draft_id);
  const before = databaseShape(db);

  const replay = await rt.publish(req(payload));
  assert.equal(replay.duplicate, true);
  assert.deepEqual(Object.assign({}, replay, { duplicate: false }), receipt);
  assert.deepEqual(databaseShape(db), before, 'receipt replay must perform no write side effects');
});

test('lost rollback response replays its receipt after shadow to new without side effects', async () => {
  const trial = await lifecycle(MODE.TRIAL, 'rollback-lost-response');
  const publication = trial.db._get(
    ST + '/schedule_publications/' + trial.rolled.publication_id
  );
  const payload = {
    request_id: publication.request_id,
    expected_active_publication_id: publication.rollback_from_publication_id,
    target_publication_id: publication.rollback_target_publication_id,
    reason_code: publication.rollback_reason_code,
    gap_acknowledgement: publication.gap_report && publication.gap_report.acknowledgement
  };
  setMode(trial.db, MODE.OFF);
  const before = databaseShape(trial.db);

  const replay = await trial.rt.rollback(req(payload));
  assert.equal(replay.duplicate, true);
  assert.deepEqual(Object.assign({}, replay, { duplicate: false }), trial.rolled);
  assert.deepEqual(databaseShape(trial.db), before,
    'rollback receipt replay must perform no write side effects');
});

test('changing the gap acknowledgement conflicts with the committed request id', async () => {
  const db = addCollectionGroup(createFakeDb());
  await seed(db);
  const rt = buildRuntime(db);
  setMode(db, MODE.TRIAL);
  const draft = await importDraft(rt, 'gap-intent', SHEET);
  const payload = {
    request_id: 'publish-gap-intent',
    draft_id: draft.imported.draft_id,
    expected_content_digest: draft.draft.expected_content_digest,
    gap_acknowledgement: draft.draft.gaps && draft.draft.gaps.digest
  };
  await rt.publish(req(payload));

  await assert.rejects(rt.publish(req(Object.assign({}, payload, {
    gap_acknowledgement: String(payload.gap_acknowledgement || '') + '-changed'
  }))), (error) => error && error.code === 'publication-conflict');
});
