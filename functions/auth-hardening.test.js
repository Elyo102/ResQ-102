'use strict';

const assert = require('assert');
const ah = require('./auth-hardening');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ': ' + (e && e.message)); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ': ' + (e && e.message)); }
}

console.log('auth-hardening');

check('backoff: free then progressive, hard-capped', () => {
  assert.strictEqual(ah.backoffDelayMs(0), 0);
  assert.strictEqual(ah.backoffDelayMs(ah.BACKOFF_FREE_FAILURES), 0);
  assert.strictEqual(ah.backoffDelayMs(ah.BACKOFF_FREE_FAILURES + 1), ah.BACKOFF_BASE_MS);
  assert.strictEqual(ah.backoffDelayMs(99), ah.BACKOFF_CAP_MS);
});

check('employeeKey is employee-number only (spoofed XFF cannot change it)', () => {
  assert.strictEqual(ah.employeeKey('1234'), '1234');
  assert.notStrictEqual(ah.employeeKey('1234'), ah.employeeKey('9999'));
});

check('clientIpSignal uses right-most trusted hop', () => {
  const raw = { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' } };
  assert.strictEqual(ah.clientIpSignal(raw, 1), '3.3.3.3');
  assert.strictEqual(ah.clientIpSignal(raw, 2), '2.2.2.2');
});

check('classifySignInFailure: 429/5xx/TOO_MANY are upstream', () => {
  assert.strictEqual(ah.classifySignInFailure(429, {}), 'upstream');
  assert.strictEqual(ah.classifySignInFailure(503, {}), 'upstream');
  assert.strictEqual(ah.classifySignInFailure(400, { error: { message: 'TOO_MANY_ATTEMPTS_TRY_LATER : x' } }), 'upstream');
  assert.strictEqual(ah.classifySignInFailure(400, { error: { message: 'INVALID_PASSWORD' } }), 'credential');
  assert.strictEqual(ah.classifySignInFailure(400, { error: { message: 'EMAIL_NOT_FOUND' } }), 'credential');
});

(async () => {
  await checkAsync('after many attacker failures, legit delay stays within cap', async () => {
    const h = ah.createAuthHardening({ now: () => 1e6, sleep: async () => {} });
    const delay = h.delayFor({ failed: 50 }, { appCheckValid: true, ip: '9.9.9.9' });
    assert.strictEqual(delay, ah.BACKOFF_CAP_MS);
  });

  await checkAsync('global surge hardens without App Check but never blocks', async () => {
    const h = ah.createAuthHardening({ now: () => 1e6, sleep: async () => {} });
    for (let i = 0; i < ah.GLOBAL_SURGE_FAILURES; i++) h.noteGlobalFailure();
    assert.strictEqual(h.delayFor({ failed: 0 }, { appCheckValid: true, ip: '1.1.1.1' }), 0);
    assert.strictEqual(h.delayFor({ failed: 0 }, { appCheckValid: false, ip: '1.1.1.1' }), ah.BACKOFF_CAP_MS);
  });

  await checkAsync('withFloor pads success and failure to the same floor', async () => {
    let t = 0; const sleeps = [];
    const h = ah.createAuthHardening({ now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    t = 1000;
    await h.withFloor(1500, async () => { t += 100; return 'ok'; });
    assert.strictEqual(sleeps[0], 1400);
    t = 5000; sleeps.length = 0;
    let threw = false;
    try { await h.withFloor(1500, async () => { t += 50; throw new Error('x'); }); }
    catch (e) { threw = e.message === 'x'; }
    assert.ok(threw);
    assert.strictEqual(sleeps[0], 1450);
  });

  await checkAsync('reserveAuthMail enforces per-recipient hourly quota', async () => {
    const store = new Map();
    const db = {
      doc: (p) => ({ path: p }),
      runTransaction: async (fn) => {
        const tx = {
          get: async (ref) => {
            const v = store.get(ref.path);
            return { exists: !!v, data: () => v };
          },
          set: (ref, data) => { store.set(ref.path, Object.assign({}, store.get(ref.path) || {}, data)); }
        };
        return fn(tx);
      }
    };
    const h = ah.createAuthHardening({ now: () => 1_700_000_000_000 });
    for (let i = 0; i < ah.MAIL_PER_RECIPIENT_HOUR; i++) {
      assert.strictEqual(await h.reserveAuthMail(db, null, 'a@b.c', 'reset'), true);
    }
    assert.strictEqual(await h.reserveAuthMail(db, null, 'a@b.c', 'reset'), false);
  });

  console.log(fail ? ('FAIL ' + fail + '/' + (pass + fail)) : ('PASS ' + pass));
  process.exit(fail ? 1 : 0);
})();
