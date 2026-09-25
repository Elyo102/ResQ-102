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

  console.log(fail ? ('FAIL ' + fail) : ('PASS ' + pass));
  process.exit(fail ? 1 : 0);
})();
