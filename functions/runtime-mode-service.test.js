'use strict';

const assert = require('assert/strict');
const { createRuntimeModeService } = require('./runtime-mode-service');

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function fixture(options = {}) {
  const rows = new Map(Object.entries(options.rows || {
    'config/runtime': { silent: true, silent_allow: ['old'], mode_revision: 4 },
    'config/mode': { mode: 'trial', revision: 4 }
  }).map(([key, value]) => [key, clone(value)]));
  let freshCalls = 0;
  let commitCalls = 0;
  const ref = path => ({ path, async get() {
    const value = rows.get(path);
    return { exists: value !== undefined, data: () => clone(value) };
  } });
  const db = {
    doc: ref,
    async runTransaction(body) {
      const writes = [];
      const tx = {
        get: target => target.get(),
        set(target, patch) { writes.push([target.path, clone(patch)]); }
      };
      const result = await body(tx);
      commitCalls++;
      if (options.failCommit) throw Object.assign(new Error('commit failed'), { code: 'aborted' });
      for (const [path, patch] of writes) rows.set(path, { ...(rows.get(path) || {}), ...patch });
      return result;
    }
  };
  const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
  const service = createRuntimeModeService({
    db, fail, serverTimestamp: () => 123,
    freshActor: async () => {
      freshCalls++;
      if (options.revoked) fail('permission-denied', 'revoked');
      return { uid: 'super_uid', email: 'super@example.test' };
    }
  });
  const req = data => ({ data });
  return { service, rows, req, freshCalls: () => freshCalls, commitCalls: () => commitCalls };
}

async function rejects(code, action) {
  await assert.rejects(action, error => error && error.code === code);
}

(async () => {
  let passed = 0;
  const test = async (name, body) => { await body(); passed++; console.log('✓ ' + name); };
  const intent = (overrides = {}) => ({
    silent: false, expected_revision: 4, request_id: 'runtime_mode_req_001', ...overrides
  });

  await test('read returns a truthful mode and compatible legacy revision', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.read(), {
      silent: true, mode: 'trial', revision: 4, allow: ['old']
    });
    const legacy = fixture({ rows: {
      'config/runtime': { silent: false, silent_allow: [] },
      'config/mode': { mode: 'live' }
    } });
    assert.equal((await legacy.service.read()).revision, 0);
  });

  await test('invalid or client-controlled allow input is rejected', async () => {
    const f = fixture();
    await rejects('invalid-argument', () => f.service.set(f.req({ ...intent(), allow: ['attacker'] })));
    await rejects('invalid-argument', () => f.service.set(f.req({ ...intent(), request_id: 'short' })));
    assert.equal(f.freshCalls(), 0);
  });

  await test('live transition atomically writes runtime and public mode', async () => {
    const f = fixture();
    const result = await f.service.set(f.req(intent()));
    assert.deepEqual(result, {
      ok: true, silent: false, mode: 'live', revision: 5,
      allow: [], duplicate: false, changed: true
    });
    assert.equal(f.rows.get('config/runtime').silent, false);
    assert.equal(f.rows.get('config/runtime').mode_revision, 5);
    assert.deepEqual(f.rows.get('config/runtime').silent_allow, []);
    assert.equal(f.rows.get('config/mode').mode, 'live');
    assert.equal(f.rows.get('config/mode').revision, 5);
  });

  await test('training allowlist is derived only from the fresh actor', async () => {
    const f = fixture({ rows: {
      'config/runtime': { silent: false, silent_allow: ['foreign'], mode_revision: 7 },
      'config/mode': { mode: 'live', revision: 7 }
    } });
    const result = await f.service.set(f.req(intent({ silent: true, expected_revision: 7 })));
    assert.deepEqual(result.allow, ['super_uid', 'super@example.test']);
    assert.deepEqual(f.rows.get('config/runtime').silent_allow,
      ['super_uid', 'super@example.test']);
  });

  await test('failed atomic commit changes neither document', async () => {
    const f = fixture({ failCommit: true });
    const beforeRuntime = clone(f.rows.get('config/runtime'));
    const beforePublic = clone(f.rows.get('config/mode'));
    await assert.rejects(() => f.service.set(f.req(intent())));
    assert.deepEqual(f.rows.get('config/runtime'), beforeRuntime);
    assert.deepEqual(f.rows.get('config/mode'), beforePublic);
  });

  await test('stale revision fails closed without writes', async () => {
    const f = fixture();
    await rejects('aborted', () => f.service.set(f.req(intent({ expected_revision: 3 }))));
    assert.equal(f.commitCalls(), 0);
    assert.equal(f.rows.get('config/runtime').silent, true);
  });

  await test('same request replays its receipt without a second revision', async () => {
    const f = fixture();
    const first = await f.service.set(f.req(intent()));
    const replay = await f.service.set(f.req(intent()));
    assert.equal(first.revision, 5);
    assert.equal(replay.revision, 5);
    assert.equal(replay.duplicate, true);
    assert.equal(f.rows.get('config/runtime').mode_revision, 5);
    assert.equal(f.freshCalls(), 2, 'a replay must revalidate the live super');
  });

  await test('same request id with another intent is a conflict', async () => {
    const f = fixture();
    await f.service.set(f.req(intent()));
    await rejects('already-exists', () => f.service.set(f.req(intent({ silent: true }))));
  });

  await test('revoked super receives no replay receipt and no commit', async () => {
    const f = fixture({ revoked: true });
    await rejects('permission-denied', () => f.service.set(f.req(intent())));
    assert.equal(f.commitCalls(), 0);
  });

  await test('same-state request is idempotently recorded without revision inflation', async () => {
    const f = fixture();
    const same = intent({ silent: true });
    const first = await f.service.set(f.req(same));
    const replay = await f.service.set(f.req(same));
    assert.equal(first.changed, false);
    assert.equal(first.revision, 4);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.revision, 4);
  });

  console.log('Runtime mode service: ' + passed + ' PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
