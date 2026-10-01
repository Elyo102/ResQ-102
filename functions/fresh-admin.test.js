'use strict';
const assert = require('assert');
const { createFreshAdmin } = require('./fresh-admin');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ': ' + (e && e.message)); }
}

console.log('fresh-admin');
(async () => {
  await check('rejects disabled account even with super claim on token', async () => {
    const fa = createFreshAdmin({
      auth: { getUser: async () => ({ uid: 'u1', disabled: true, customClaims: { super: true } }) },
      HttpsError
    });
    let code = null;
    try { await fa.requireFreshSuper({ auth: { uid: 'u1', token: { super: true } } }); }
    catch (e) { code = e.code; }
    assert.strictEqual(code, 'permission-denied');
  });

  await check('rejects when live claims dropped super', async () => {
    const fa = createFreshAdmin({
      auth: { getUser: async () => ({ uid: 'u1', disabled: false, customClaims: {} }) },
      HttpsError
    });
    let code = null;
    try { await fa.requireFreshSuper({ auth: { uid: 'u1', token: { super: true } } }); }
    catch (e) { code = e.code; }
    assert.strictEqual(code, 'permission-denied');
  });

  await check('accepts live super', async () => {
    const fa = createFreshAdmin({
      auth: { getUser: async () => ({ uid: 'u1', disabled: false, email: 'a@b.c', customClaims: { super: true } }) },
      HttpsError
    });
    const actor = await fa.requireFreshSuper({ auth: { uid: 'u1', token: { super: true } } });
    assert.strictEqual(actor.uid, 'u1');
  });

  const policy = { ASSIGN_MAX_RANK: { hr: 2 }, KNOWN_DISTRICTS: ['south'] };
  const hr = { role:'hr', stationId:'test_station', districtId:'south' };
  const request = claims => ({ auth: { uid:'u1', token:claims } });
  const helper = user => createFreshAdmin({ auth: { getUser:async () => user }, HttpsError });
  const current = claims => ({ uid:'u1', disabled:false, email:'server@example.test', customClaims:claims });
  await check('live role setter rejects disabled, missing, mismatched and unavailable accounts', async () => {
    for (const user of [null, { ...current(hr), uid:'other' }, { ...current(hr), disabled:true },
      { ...current(hr), disabled:undefined }]) {
      await assert.rejects(helper(user).requireFreshRoleSetter(request(hr), policy), { code:'permission-denied' });
    }
    const unavailable = createFreshAdmin({ auth:{ getUser:async () => { throw Error('unavailable'); } }, HttpsError });
    await assert.rejects(unavailable.requireFreshRoleSetter(request(hr), policy), { code:'permission-denied' });
  });
  await check('live role setter rejects demotion and role/station/district drift', async () => {
    for (const claims of [{}, { role:'firefighter' }, { ...hr, stationId:'other' },
      { ...hr, districtId:'north' }, { ...hr, role:'other' }]) {
      await assert.rejects(helper(current(claims)).requireFreshRoleSetter(request(hr), policy), { code:'permission-denied' });
    }
    await assert.rejects(helper(current({})).requireFreshRoleSetter(request({super:true}), policy), { code:'permission-denied' });
  });
  await check('live HR and super retain allowed scope without stale token privileges', async () => {
    const gate = await helper(current(hr)).requireFreshRoleSetter(request({ ...hr, super:true, email:'old@example.test', removed_privilege:true }), policy);
    assert.equal(gate.cap, 2); assert.equal(gate.sid, 'test_station');
    assert.deepEqual(gate.auth.token, { ...hr, email:'server@example.test' });
    const superGate = await helper(current({super:true})).requireFreshRoleSetter(request({super:true}), policy);
    assert.equal(superGate.cap, Infinity);
    assert.deepEqual(superGate.auth.token, { super:true, email:'server@example.test' });
  });
  await check('actual index gate awaits fresh authorization before resolving any target', async () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
    const gateSource = source.match(/async function requireRoleSetter\(req\) \{[\s\S]*?\n\}/)[0];
    const start = source.indexOf('  const gate = await requireRoleSetter(req);');
    const end = source.indexOf('  const before = user.customClaims || {};', start);
    assert(start > 0 && end > start);
    const prefix = source.slice(start, end);
    let release, targetReads = 0;
    const barrier = new Promise(resolve => { release = resolve; });
    const ctx = { ASSIGN_MAX_RANK:policy.ASSIGN_MAX_RANK, KNOWN_DISTRICTS:policy.KNOWN_DISTRICTS,
      freshAdmin:{ requireFreshRoleSetter:async () => { await barrier; return {auth:{uid:'u1'}}; } },
      resolveUser:async () => { targetReads++; return {uid:'target'}; } };
    require('node:vm').runInNewContext(gateSource + '\nthis.entry = async req => {\n' + prefix + '\nreturn user; };', ctx);
    const pending = ctx.entry({data:{}});
    await Promise.resolve(); assert.equal(targetReads, 0);
    release(); await pending; assert.equal(targetReads, 1);
    ctx.freshAdmin.requireFreshRoleSetter = async () => { throw new HttpsError('permission-denied', 'denied'); };
    await assert.rejects(ctx.entry({data:{}}), {code:'permission-denied'});
    assert.equal(targetReads, 1, 'denied actor never reaches target lookup');
  });
  console.log(fail ? ('FAIL ' + fail) : ('PASS ' + pass));
  process.exit(fail ? 1 : 0);
})();
