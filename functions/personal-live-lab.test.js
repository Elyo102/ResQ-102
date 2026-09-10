'use strict';

const assert = require('assert/strict');
const { createPersonalLiveLab } = require('./personal-live-lab');

class E extends Error { constructor(code, message) { super(message); this.code = code; } }
const NOW = 1788998400000;

function fixture(overrides) {
  const calls = { send:0, finish:[], ack:[], activate:[] };
  const state = Object.assign({
    actor:{ uid:'owner', sid:'eilat_102', super:true },
    config:{ enabled:true, allowed_uid:'owner', expires_at_ms:NOW + 60000 },
    token:true, silent:false, reserved:{ duplicate:false, state:'reserved' }, sendResult:'m1'
  }, overrides || {});
  const service = createPersonalLiveLab({
    HttpsError:E, now:() => NOW,
    freshActor:async () => state.actor,
    readConfig:async () => state.config,
    activate:async (...x) => calls.activate.push(x),
    hasToken:async () => state.token,
    isSilent:async () => state.silent,
    reserve:async () => state.reserved,
    sendExact:async () => { calls.send++; if (state.sendError) throw state.sendError; return state.sendResult; },
    finish:async (...x) => calls.finish.push(x),
    ack:async (...x) => calls.ack.push(x)
  });
  const req = data => ({ auth:{ uid:'owner' }, data:data || {} });
  return { service, state, calls, req };
}

async function rejects(code, fn) {
  await assert.rejects(fn, e => e && e.code === code);
}

async function run() {
  {
    const f = fixture();
    assert.deepEqual(await f.service.status(f.req()), { active:true, expires_at_ms:NOW + 60000 });
    assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture({ config:null });
    assert.deepEqual(await f.service.status(f.req()), { active:false, expires_at_ms:0 });
  }
  {
    const f = fixture();
    const r = await f.service.enable(f.req());
    assert.equal(r.active, true); assert.equal(f.calls.activate.length, 1);
    assert.equal(f.calls.activate[0][0], 'eilat_102'); assert.equal(f.calls.activate[0][1], 'owner');
  }
  for (const actor of [null, { uid:'owner',sid:'eilat_102',super:false }, { uid:'',sid:'eilat_102',super:true }]) {
    const f = fixture({ actor }); await rejects('permission-denied', () => f.service.status(f.req()));
  }
  for (const data of [{ token:'short',request_id:'valid_request_id_01' }, { token:'x'.repeat(30),request_id:'bad id' }]) {
    const f = fixture(); await rejects('invalid-argument', () => f.service.send(f.req(data))); assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture({ config:{ enabled:true,allowed_uid:'other',expires_at_ms:NOW+1 } });
    await rejects('failed-precondition', () => f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' })));
    assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture({ token:false });
    await rejects('failed-precondition', () => f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' })));
    assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture({ silent:true });
    await rejects('failed-precondition', () => f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' })));
    assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture({ reserved:{ duplicate:true,state:'accepted' } });
    const r = await f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' }));
    assert.deepEqual(r, { probe_id:'valid_request_id_01',state:'accepted',duplicate:true }); assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture();
    const r = await f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' }));
    assert.equal(r.state, 'accepted'); assert.equal(f.calls.send, 1); assert.equal(f.calls.finish[0][2], 'accepted');
  }
  {
    const f = fixture({ sendError:new Error('network') });
    await rejects('unavailable', () => f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' })));
    assert.equal(f.calls.send, 1); assert.equal(f.calls.finish[0][2], 'unknown');
  }
  {
    const f = fixture(); await f.service.acknowledge(f.req({ probe_id:'valid_request_id_01',stage:'opened' }));
    assert.equal(f.calls.ack[0][3], 'opened');
  }
  {
    const f = fixture(); await rejects('invalid-argument', () => f.service.acknowledge(f.req({ probe_id:'valid_request_id_01',stage:'delivered' })));
  }
  console.log('personal-live-lab: 15 checks passed');
}

run().catch(error => { console.error(error); process.exit(1); });
