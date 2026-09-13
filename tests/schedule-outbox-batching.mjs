import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFakeDb, seed, buildRuntime, req, SHEET, ST, serviceMod
} from './_schedule-fake.mjs';

const ALIASES = Object.freeze({ 'רועי': 'u1', 'אבטחה': null, 'גיא': 'u5' });

function instrument(db, options = {}) {
  const counts = {
    liveLabReads: 0,
    outboxQueries: 0,
    nonemptyOutboxPages: 0,
    outboxLimits: [],
    outboxTransactionCallbacks: 0,
    committedOutboxPages: 0
  };
  const rawCollection = db.collection.bind(db);
  const rawDoc = db.doc.bind(db);
  const rawTransaction = db.runTransaction.bind(db);
  let retried = false;
  let failed = false;

  function wrapRef(ref) {
    return {
      path: ref.path,
      id: ref.id,
      collection(name) { return wrapQuery(ref.collection(name)); },
      async get() {
        if (ref.path.endsWith('/live_lab_config/current')) counts.liveLabReads += 1;
        return ref.get();
      },
      set(value, opts) { return ref.set(value, opts); },
      update(value) { return ref.update(value); },
      create(value) { return ref.create(value); },
      delete() { return ref.delete(); }
    };
  }

  function wrapQuery(query) {
    return {
      path: query.path,
      where(field, op, value) { return wrapQuery(query.where(field, op, value)); },
      orderBy(...args) { return wrapQuery(query.orderBy(...args)); },
      limit(value) {
        if (query.path.endsWith('/schedule_outbox')) counts.outboxLimits.push(Number(value));
        return wrapQuery(query.limit(value));
      },
      doc(id) { return wrapRef(query.doc(id)); },
      async get() {
        const snap = await query.get();
        if (query.path.endsWith('/schedule_outbox')) {
          counts.outboxQueries += 1;
          if (!snap.empty) counts.nonemptyOutboxPages += 1;
        }
        return snap;
      }
    };
  }

  function txProxy(tx, touched) {
    return {
      get: (ref) => tx.get(ref),
      getAll: (...refs) => tx.getAll(...refs),
      set(ref, value, opts) { tx.set(ref, value, opts); },
      create(ref, value) { tx.create(ref, value); },
      delete(ref) { tx.delete(ref); },
      update(ref, value) {
        if (String(ref && ref.path || '').includes('/schedule_outbox/')) touched.value = true;
        tx.update(ref, value);
      }
    };
  }

  db.collection = (name) => wrapQuery(rawCollection(name));
  db.doc = (path) => wrapRef(rawDoc(path));
  db.runTransaction = async (fn) => {
    if (options.retryActiveGateInvalid && !retried) {
      const marker = new Error('synthetic-active-gate-retry');
      try {
        return await rawTransaction(async (tx) => {
          const result = await fn(txProxy(tx, { value: false }));
          if (result && result.kind === 'live') {
            retried = true;
            throw marker;
          }
          return result;
        });
      } catch (error) {
        if (error !== marker) throw error;
        const runtimePath = ST + '/schedule_state/runtime';
        db._put(runtimePath, { ...db._get(runtimePath), mode: 'off' });
      }
    }
    if (options.retryOneOutboxCallback && !retried) {
      const marker = new Error('synthetic-transaction-retry');
      try {
        return await rawTransaction(async (tx) => {
          const touched = { value: false };
          const result = await fn(txProxy(tx, touched));
          if (touched.value) {
            counts.outboxTransactionCallbacks += 1;
            retried = true;
            throw marker;
          }
          return result;
        });
      } catch (error) {
        if (error !== marker) throw error;
      }
    }

    let touched = false;
    const result = await rawTransaction(async (tx) => {
      const state = { value: false };
      const output = await fn(txProxy(tx, state));
      touched = state.value;
      if (touched) counts.outboxTransactionCallbacks += 1;
      return output;
    });
    if (touched) {
      counts.committedOutboxPages += 1;
      if (!failed && Number(options.failAfterCommittedPage) === counts.committedOutboxPages) {
        failed = true;
        throw new Error('synthetic-release-response-lost');
      }
    }
    return result;
  };
  return counts;
}

function addCollectionGroup(db) {
  db.collectionGroup = function collectionGroup(name) {
    const filters = [];
    let cap = Infinity;
    const query = {
      where(field, op, value) {
        assert.equal(op, '==');
        filters.push({ field, value });
        return query;
      },
      orderBy() { return query; },
      limit(value) { cap = Number(value); return query; },
      async get() {
        const docs = [];
        for (const path of db._paths('')) {
          const parts = path.split('/');
          if (parts[parts.length - 2] !== name) continue;
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

function bulkServiceFactory(count) {
  return function createBulkService(deps) {
    const service = serviceMod.createScheduleService(deps);
    return Object.assign({}, service, {
      publish(input) {
        const planned = service.publish(input);
        const template = planned.notifications[0];
        assert.ok(template, 'fixture must produce at least one real notification');
        const notifications = Array.from({ length: count }, (_, index) => Object.freeze({
          ...template,
          person: 'bulk_' + String(index).padStart(5, '0'),
          dedupe_key: 'bulk-notice-' + String(index).padStart(5, '0')
        }));
        return Object.freeze({ ...planned, notifications: Object.freeze(notifications) });
      }
    });
  };
}

async function importedDraft(rt, suffix) {
  const preview = await rt.previewScheduleImport(req({
    month: '2026-09', paste: SHEET, aliases: ALIASES, accept: {}
  }));
  assert.equal(preview.blocked, false);
  const imported = await rt.importScheduleSheet(req({
    request_id: 'batch-import-' + suffix,
    month: '2026-09', paste: SHEET, aliases: ALIASES, accept: {},
    expected_report_digest: preview.report_digest
  }));
  const draft = await rt.getDraftPreview(req({
    draft_id: imported.draft_id, start: '2026-09-01'
  }));
  return { imported, draft };
}

async function bulkScenario(options = {}) {
  const db = createFakeDb();
  await seed(db);
  const counts = instrument(db, options.instrument);
  const rt = buildRuntime(db, { createService: bulkServiceFactory(3000) });
  const draft = await importedDraft(rt, options.suffix || 'one');
  const config = db._get(ST + '/schedule_state/runtime');
  db._put(ST + '/schedule_state/runtime', { ...config, mode: 'new' });
  const request = req({
    request_id: 'batch-publish-' + (options.suffix || 'one'),
    draft_id: draft.imported.draft_id,
    expected_content_digest: draft.draft.expected_content_digest,
    gap_acknowledgement: draft.draft.gaps && draft.draft.gaps.digest
  });
  return { db, rt, counts, request };
}

test('3,000 blocked deliveries are released in exactly 30 bounded pages', async () => {
  const value = await bulkScenario({ suffix: 'pages' });
  const published = await value.rt.publish(value.request);
  const prefix = ST + '/schedule_publications/' + published.publication_id + '/schedule_outbox/';
  const rows = value.db._paths(prefix);
  assert.equal(rows.length, 3000);
  assert.ok(rows.every((path) => value.db._get(path).status === 'queued'));
  assert.equal(value.counts.nonemptyOutboxPages, 30);
  assert.equal(value.counts.outboxQueries, 31, 'the final bounded query proves exhaustion');
  assert.ok(value.counts.outboxLimits.length >= 31);
  assert.ok(value.counts.outboxLimits.every((limit) => limit === 100));
  assert.equal(value.counts.liveLabReads, 0, 'live release must not read personal lab config');
});

test('a retried release transaction callback does not duplicate or skip a page', async () => {
  const value = await bulkScenario({
    suffix: 'retry', instrument: { retryOneOutboxCallback: true }
  });
  const published = await value.rt.publish(value.request);
  const prefix = ST + '/schedule_publications/' + published.publication_id + '/schedule_outbox/';
  const rows = value.db._paths(prefix);
  assert.equal(rows.length, 3000);
  assert.ok(rows.every((path) => value.db._get(path).status === 'queued'));
  assert.equal(value.counts.nonemptyOutboxPages, 30);
  assert.equal(value.counts.committedOutboxPages, 30);
  assert.equal(value.counts.outboxTransactionCallbacks, 31,
    'one callback retry plus thirty committed pages must be observable');
});

test('a lost response after a committed page is completed by an exact publish retry', async () => {
  const value = await bulkScenario({
    suffix: 'resume', instrument: { failAfterCommittedPage: 7 }
  });
  await assert.rejects(value.rt.publish(value.request), /synthetic-release-response-lost/);
  const publications = value.db._paths(ST + '/schedule_publications/')
    .filter((path) => path.split('/').length === 4)
    .map((path) => ({ path, value: value.db._get(path) }))
    .filter((item) => item.value && item.value.request_id === value.request.data.request_id);
  assert.equal(publications.length, 1);
  const prefix = publications[0].path + '/schedule_outbox/';
  const before = value.db._paths(prefix).map((path) => value.db._get(path).status);
  assert.equal(before.filter((status) => status === 'queued').length, 700);
  assert.equal(before.filter((status) => status === 'blocked').length, 2300);

  const replay = await value.rt.publish(value.request);
  assert.equal(replay.duplicate, true);
  const after = value.db._paths(prefix).map((path) => value.db._get(path).status);
  assert.equal(after.filter((status) => status === 'queued').length, 3000);
  assert.equal(after.filter((status) => status === 'blocked').length, 0);
  assert.equal(value.counts.liveLabReads, 0);
});

test('a prepared live blocked row survives resume without reading live lab config', async () => {
  const db = addCollectionGroup(createFakeDb());
  const counts = instrument(db);
  const publicationId = 'prepared_batch';
  const path = ST + '/schedule_publications/' + publicationId + '/schedule_outbox/n1';
  db._put(ST + '/schedule_state/runtime', { mode: 'shadow' });
  db._put(ST + '/schedule_publications/' + publicationId, {
    station_id: 'station_102', status: 'prepared', revision: 1,
    delivery_allowed: true, delivery_policy: 'live'
  });
  db._put(ST + '/users/u2', {
    stationId: 'station_102', station_id: 'station_102', station: 'station_102',
    active: true, is_active: true, role: 'firefighter'
  });
  db._put(path, {
    station_id: 'station_102', publication_id: publicationId,
    revision: 1, person: 'u2', status: 'blocked', attempt: 0,
    delivery_allowed: true, delivery_policy: 'live',
    expires_at: new Date('2026-08-26T00:00:00.000Z')
  });
  const rt = buildRuntime(db);
  await rt.resumeOutbox();
  const after = db._get(path);
  assert.equal(after.status, 'blocked', JSON.stringify(after));
  assert.equal(counts.liveLabReads, 0);
});

test('only the final retried active-gate callback may release a page', async () => {
  const value = await bulkScenario({
    suffix: 'gate-retry', instrument: { retryActiveGateInvalid: true }
  });
  const published = await value.rt.publish(value.request);
  const prefix = ST + '/schedule_publications/' + published.publication_id + '/schedule_outbox/';
  const states = value.db._paths(prefix).map((path) => value.db._get(path).status);
  assert.equal(states.length, 3000);
  assert.equal(states.filter((status) => status === 'blocked').length, 3000,
    'a valid aborted callback must not leak its live gate into the final invalid retry');
  assert.equal(states.filter((status) => status === 'queued').length, 0);
});
