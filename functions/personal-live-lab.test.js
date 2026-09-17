'use strict';

const assert = require('assert/strict');
const { createPersonalLiveLab } = require('./personal-live-lab');

class E extends Error { constructor(code, message) { super(message); this.code = code; } }
const NOW = 1788998400000;
const AUTH_MS = NOW - 60000;

function fixture(overrides) {
  const calls = { actor:0, config:0, token:0, send:0, policy:[], finish:[], ack:[], activate:[], reserve:[] };
  const state = Object.assign({
    actor:{ uid:'owner', sid:'eilat_102', super:true, personal_lab_control:true,
      activation_auth_time_ms:AUTH_MS },
    config:{ schema:'personal-live-lab-v2', enabled:true, allowed_uid:'owner', generation:1,
      activation_auth_time_ms:AUTH_MS, expires_at_ms:NOW + 60000 },
    token:true, silent:false, reserved:{ duplicate:false, state:'reserved' }, sendResult:'m1'
  }, overrides || {});
  const service = createPersonalLiveLab({
    HttpsError:E, now:() => NOW,
    freshActor:async () => {
      calls.actor++;
      return typeof state.freshActor === 'function' ? state.freshActor(calls.actor, state) : state.actor;
    },
    readConfig:async () => {
      calls.config++;
      return typeof state.readConfig === 'function' ? state.readConfig(calls.config, state) : state.config;
    },
    activate:async (...x) => calls.activate.push(x),
    hasToken:async () => {
      calls.token++;
      return typeof state.hasToken === 'function' ? state.hasToken(calls.token, state) : state.token;
    },
    isSilent:async () => state.silent,
    assertStationDelivery:async scope => {
      calls.policy.push(scope);
      if (typeof state.assertStationDelivery === 'function') {
        await state.assertStationDelivery(calls.policy.length, state, scope);
      }
    },
    reserve:async input => {
      calls.reserve.push(input);
      if (typeof state.afterReserve === 'function') state.afterReserve(state, input);
      return typeof state.reserved === 'function'
        ? state.reserved(calls.reserve.length, state) : state.reserved;
    },
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
  const otherwiseComplete = { HttpsError:E };
  for (const name of ['freshActor','readConfig','activate','hasToken','isSilent',
    'reserve','sendExact','finish','ack']) otherwiseComplete[name] = async () => {};
  assert.throws(() => createPersonalLiveLab(otherwiseComplete), /dependenc/i,
    'station delivery gate must be a required dependency');
  for (const deniedCall of [1, 2]) {
    const f = fixture({ assertStationDelivery:async call => {
      if (call === deniedCall) throw new E('failed-precondition', 'station policy');
    } });
    await rejects('failed-precondition', () => f.service.send(f.req({
      token:'x'.repeat(30), request_id:'valid_request_id_01'
    })));
    assert.equal(f.calls.reserve.length, deniedCall - 1);
    assert.equal(f.calls.send, 0);
    assert.equal(f.calls.finish.length, 0, 'known unsent policy denial must not stamp unknown');
    for (const scope of f.calls.policy) assert.deepEqual(scope, { sid:'eilat_102',uid:'owner' });
  }
  {
    const f = fixture({
      assertStationDelivery:async call => {
        if (call === 2) throw new E('unavailable', 'station read unavailable');
      },
      reserved:call => ({ duplicate:call > 1,state:'reserved' })
    });
    const request = f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' });
    await rejects('unavailable', () => f.service.send(request));
    assert.equal(f.calls.send, 0);
    assert.equal(f.calls.finish.length, 0);
    assert.equal((await f.service.send(request)).state, 'accepted');
    assert.equal(f.calls.send, 1, 'reserved known-unsent retry sends once after policy recovery');
  }
  {
    const f = fixture({ assertStationDelivery:async (call, state) => {
      if (call === 2) {
        await Promise.resolve();
        state.actor = { ...state.actor,personal_lab_control:false };
      }
    } });
    await rejects('permission-denied', () => f.service.send(f.req({
      token:'x'.repeat(30),request_id:'valid_request_id_01'
    })));
    assert.equal(f.calls.send, 0, 'Auth must remain the final check after asynchronous policy gate');
    assert.equal(f.calls.finish.length, 0);
  }
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
    const f = fixture({ config:{ enabled:true, allowed_uid:'owner', generation:1,
      activation_auth_time_ms:AUTH_MS, expires_at_ms:NOW + 60000 } });
    assert.deepEqual(await f.service.status(f.req()), { active:false, expires_at_ms:0 });
  }
  {
    const f = fixture({ config:{ schema:'personal-live-lab-v2', enabled:true, allowed_uid:'owner', generation:1,
      activation_auth_time_ms:AUTH_MS - 1, expires_at_ms:NOW + 60000 } });
    assert.deepEqual(await f.service.status(f.req()), { active:false, expires_at_ms:0 });
  }
  {
    const f = fixture();
    const r = await f.service.enable(f.req());
    assert.equal(r.active, true); assert.equal(f.calls.activate.length, 1);
    assert.equal(f.calls.activate[0][0], 'eilat_102'); assert.equal(f.calls.activate[0][1], 'owner');
    assert.equal(f.calls.activate[0][4], AUTH_MS);
  }
  for (const actor of [null,
    { uid:'owner',sid:'eilat_102',super:false,personal_lab_control:true,activation_auth_time_ms:AUTH_MS },
    { uid:'owner',sid:'eilat_102',super:true,personal_lab_control:false,activation_auth_time_ms:AUTH_MS },
    { uid:'',sid:'eilat_102',super:true,personal_lab_control:true,activation_auth_time_ms:AUTH_MS }]) {
    const f = fixture({ actor }); await rejects('permission-denied', () => f.service.status(f.req()));
  }
  for (const data of [{ token:'short',request_id:'valid_request_id_01' }, { token:'x'.repeat(30),request_id:'bad id' }]) {
    const f = fixture(); await rejects('invalid-argument', () => f.service.send(f.req(data))); assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture({ config:{ schema:'personal-live-lab-v2',enabled:true,allowed_uid:'other',generation:1,
      activation_auth_time_ms:AUTH_MS,expires_at_ms:NOW+1 } });
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
    const f = fixture();
    await f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' }));
    assert.equal(f.calls.reserve.length, 1);
    assert.equal(f.calls.reserve[0].generation, 1);
    assert.equal(f.calls.reserve[0].activation_auth_time_ms, AUTH_MS);
  }
  {
    const f = fixture({ afterReserve:state => {
      state.actor = { ...state.actor, activation_auth_time_ms:AUTH_MS + 1000 };
    } });
    await rejects('permission-denied', () => f.service.send(f.req({
      token:'x'.repeat(30), request_id:'valid_request_id_01'
    })));
    assert.equal(f.calls.send, 0);
  }
  {
    const f = fixture({ reserved:{ duplicate:true,state:'accepted' } });
    const r = await f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' }));
    assert.deepEqual(r, { probe_id:'valid_request_id_01',state:'accepted',duplicate:true }); assert.equal(f.calls.send, 0);
  }
  {
    let recovered = false;
    const temporary = new Error('temporary Auth outage'); temporary.code = 'auth/internal-error';
    const f = fixture({
      freshActor:call => {
        if (call === 2 && !recovered) { recovered = true; throw temporary; }
        return { uid:'owner',sid:'eilat_102',super:true,personal_lab_control:true,
          activation_auth_time_ms:AUTH_MS };
      },
      reserved:call => call === 1
        ? { duplicate:false,state:'reserved' } : { duplicate:true,state:'reserved' }
    });
    await rejects('auth/internal-error', () => f.service.send(f.req({
      token:'x'.repeat(30),request_id:'valid_request_id_01'
    })));
    const replay = await f.service.send(f.req({ token:'x'.repeat(30),request_id:'valid_request_id_01' }));
    assert.equal(replay.state, 'accepted'); assert.equal(f.calls.send, 1);
  }
  {
    const f = fixture({ hasToken:call => {
      if (call === 2) f.state.actor = { ...f.state.actor, personal_lab_control:false };
      return true;
    } });
    await rejects('permission-denied', () => f.service.send(f.req({
      token:'x'.repeat(30),request_id:'valid_request_id_01'
    })));
    assert.equal(f.calls.send, 0, 'final Auth revocation must stop before provider');
  }
  {
    const f = fixture({ readConfig:call => {
      if (call === 3) f.state.actor = { ...f.state.actor, personal_lab_control:false };
      return f.state.config;
    } });
    await rejects('permission-denied', () => f.service.send(f.req({
      token:'x'.repeat(30),request_id:'valid_request_id_01'
    })));
    assert.equal(f.calls.send, 0, 'Auth revoked during final config read must stop provider');
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
  console.log('personal-live-lab: contract checks passed');
}

run().catch(error => { console.error(error); process.exit(1); });
