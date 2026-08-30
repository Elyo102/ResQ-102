'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const invitationsModule = require('./invitations');

const NOW = Date.parse('2026-08-30T06:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const ROLE_RANK = Object.freeze({
  firefighter: 1,
  deputy_team_leader: 2,
  team_leader: 3,
  deputy: 4,
  commander: 5,
  station_commander: 6,
  hr_coordinator: 6,
  district_commander: 7
});

function withinRoleSetterScope(gate, before, desired) {
  if (gate.cap === Infinity) return true;
  const sid = String(gate.sid || '');
  const did = String(gate.did || '');
  const previousSid = String((before || {}).stationId || '');
  const previousDid = String((before || {}).districtId || '');
  return sid !== '' && did !== '' &&
    (!previousSid || previousSid === sid) &&
    (!previousDid || previousDid === did) &&
    String((desired || {}).stationId || '') === sid &&
    String((desired || {}).districtId || '') === did;
}

function assertMayAssign(gate, targetRole, before, targetUid, wantSuper, desired) {
  if (gate.cap === Infinity) return;
  if (wantSuper || !gate.cap || (ROLE_RANK[targetRole] || 0) > gate.cap ||
      !withinRoleSetterScope(gate, before, desired)) {
    const error = new Error('not allowed');
    error.code = 'permission-denied';
    throw error;
  }
}

let randomCounter = 0;
function deterministicRandom(size) {
  randomCounter++;
  return crypto.createHash('sha256').update('seed-' + randomCounter)
    .digest().subarray(0, size);
}

function buildApi(now = NOW) {
  randomCounter = 0;
  return invitationsModule.createInvitations({
    clock: function () { return now; },
    randomBytes: deterministicRandom,
    createHash: function (value) {
      return crypto.createHash('sha256').update(value).digest('hex');
    },
    timingSafeEqual: crypto.timingSafeEqual,
    assertMayAssign,
    withinRoleSetterScope
  });
}

const superGate = Object.freeze({
  auth: { uid: 'u_super' }, cap: Infinity, sid: '', did: ''
});
const hrGate = Object.freeze({
  auth: { uid: 'u_hr' }, cap: 3, sid: 'eilat_102', did: 'south'
});
const baseInput = Object.freeze({
  full_name: 'ישראל ישראלי',
  email: 'New.User@Example.COM',
  phone: '050-0000000',
  station_id: 'eilat_102',
  district_id: 'south',
  role: 'firefighter',
  shift: 'A'
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(fn, code) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.equal(caught && caught.code, code);
}

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('✓ ' + label);
}

(function run() {
  test('dependencies fail closed', function () {
    assert.throws(function () { invitationsModule.createInvitations({}); }, TypeError);
  });

  test('issue creates an exact 72-hour invitation', function () {
    const issued = buildApi().issue(superGate, baseInput);
    assert.equal(issued.doc.expires_at.getTime() - issued.doc.issued_at.getTime(), 72 * HOUR);
    assert.equal(issued.doc.max_uses, 1);
  });

  test('secret is returned once and never stored in the document', function () {
    const issued = buildApi().issue(superGate, baseInput);
    assert.ok(issued.secret.length >= 32);
    assert.ok(/^[a-f0-9]{64}$/.test(issued.doc.secret_hash));
    assert.equal(JSON.stringify(issued.doc).includes(issued.secret), false);
  });

  test('email is normalized by lowercase only', function () {
    const issued = buildApi().issue(superGate, baseInput);
    assert.equal(issued.doc.email, 'new.user@example.com');
  });

  test('malformed email addresses are rejected before issue', function () {
    expectCode(function () {
      buildApi().issue(superGate, Object.assign({}, baseInput, {
        email: 'not-an-email'
      }));
    }, 'invalid-argument');
  });

  test('new values are trimmed before storage', function () {
    const input = Object.assign({}, baseInput, {
      station_id: '  eilat_102  ', district_id: ' south ', shift: ' A '
    });
    const issued = buildApi().issue(superGate, input);
    assert.equal(issued.doc.station_id, 'eilat_102');
    assert.equal(issued.doc.district_id, 'south');
    assert.equal(issued.doc.shift, 'A');
  });

  test('embedded invisible characters are rejected', function () {
    expectCode(function () {
      buildApi().issue(superGate, Object.assign({}, baseInput, {
        station_id: 'eilat_\u200b102'
      }));
    }, 'invalid-argument');
  });

  test('station ids follow the existing station contract', function () {
    const issued = buildApi().issue(superGate, Object.assign({}, baseInput, {
      station_id:'_branch_1'
    }));
    assert.equal(issued.doc.station_id, '_branch_1');
  });

  test('super_admin cannot be issued as an invitation role', function () {
    expectCode(function () {
      buildApi().issue(superGate, Object.assign({}, baseInput, { role: 'super_admin' }));
    }, 'invalid-argument');
  });

  test('a non-super issuer defaults omitted scope to its own claims', function () {
    const input = Object.assign({}, baseInput);
    delete input.station_id;
    delete input.district_id;
    const issued = buildApi().issue(hrGate, input);
    assert.equal(issued.doc.station_id, hrGate.sid);
    assert.equal(issued.doc.district_id, hrGate.did);
  });

  test('a non-super issuer cannot silently target another station', function () {
    expectCode(function () {
      buildApi().issue(hrGate, Object.assign({}, baseInput, { station_id: 'other_99' }));
    }, 'out-of-scope');
  });

  test('partial non-super scope claims fail closed', function () {
    expectCode(function () {
      buildApi().issue({ auth:{uid:'u_hr'}, cap:3, sid:'eilat_102', did:'' }, baseInput);
    }, 'out-of-scope');
  });

  test('the existing role ceiling is enforced', function () {
    expectCode(function () {
      buildApi().issue(hrGate, Object.assign({}, baseInput, { role: 'commander' }));
    }, 'permission-denied');
  });

  test('the injected station scope guard is mandatory', function () {
    const api = invitationsModule.createInvitations({
      clock: function () { return NOW; },
      randomBytes: deterministicRandom,
      createHash: function (value) {
        return crypto.createHash('sha256').update(value).digest('hex');
      },
      timingSafeEqual: crypto.timingSafeEqual,
      assertMayAssign,
      withinRoleSetterScope: function () { return false; }
    });
    expectCode(function () { api.issue(hrGate, baseInput); }, 'out-of-scope');
  });

  test('valid inspect returns only non-personal metadata', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const result = api.inspect(issued.doc, issued.secret);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.meta).sort(), [
      'district_id', 'email_locked', 'expires_at', 'role', 'shift', 'station_id'
    ]);
  });

  for (const [label, mutate] of [
    ['wrong secret', function (doc) { return { doc, secret:'wrong' }; }],
    ['expired invitation', function (doc, secret) {
      doc.expires_at = new Date(NOW - 1); return { doc, secret };
    }],
    ['revoked invitation', function (doc, secret) {
      doc.revoked_at = new Date(NOW); return { doc, secret };
    }],
    ['already redeemed invitation', function (doc, secret) {
      doc.redeemed_by = 'u_old'; return { doc, secret };
    }]
  ]) {
    test(label + ' is indistinguishable to inspect', function () {
      const api = buildApi();
      const issued = api.issue(superGate, baseInput);
      const changed = mutate(Object.assign({}, issued.doc), issued.secret);
      assert.deepEqual(api.inspect(changed.doc, changed.secret), { ok:false, error:'invalid' });
    });
  }

  test('missing invitation is indistinguishable to inspect', function () {
    assert.deepEqual(buildApi().inspect(null, 'anything'), { ok:false, error:'invalid' });
  });

  test('an invitation without max_uses is rejected', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const malformed = Object.assign({}, issued.doc);
    delete malformed.max_uses;
    assert.deepEqual(api.inspect(malformed, issued.secret), { ok:false, error:'invalid' });
  });

  test('an invitation with max_uses other than one is rejected', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const malformed = Object.assign({}, issued.doc, { max_uses:5 });
    assert.deepEqual(api.inspect(malformed, issued.secret), { ok:false, error:'invalid' });
  });

  test('redeem requires a verified email', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    expectCode(function () {
      api.redeem(issued.doc, issued.secret, {
        uid:'u_new', email:'new.user@example.com', email_verified:false
      });
    }, 'email-not-verified');
  });

  test('a locked invitation rejects another verified email', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    expectCode(function () {
      api.redeem(issued.doc, issued.secret, {
        uid:'u_new', email:'other@example.com', email_verified:true
      });
    }, 'invalid-invitation');
  });

  test('a matching verified email can redeem', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const plan = api.redeem(issued.doc, issued.secret, {
      uid:'u_new', email:'NEW.USER@EXAMPLE.COM', email_verified:true
    });
    assert.equal(plan.redeemed_by, 'u_new');
  });

  test('an unlocked invitation accepts a verified account', function () {
    const api = buildApi();
    const input = Object.assign({}, baseInput, { email:'' });
    const issued = api.issue(superGate, input);
    const plan = api.redeem(issued.doc, issued.secret, {
      uid:'u_new', email:'someone@example.com', email_verified:true
    });
    assert.equal(plan.request.email, 'someone@example.com');
  });

  test('redeem request uses locked invitation values, not client values', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const plan = api.redeem(issued.doc, issued.secret, {
      uid:'u_new', email:'new.user@example.com', email_verified:true
    }, {
      station_id:'other_99', district_id:'north', role:'commander', shift:'Z'
    });
    assert.equal(plan.request.stationId, 'eilat_102');
    assert.equal(plan.request.districtId, 'south');
    assert.equal(plan.request.role, 'firefighter');
    assert.equal(plan.request.shift, 'A');
  });

  test('verifyPlan accepts the unchanged fresh document', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const plan = api.redeem(issued.doc, issued.secret, {
      uid:'u_new', email:'new.user@example.com', email_verified:true
    });
    assert.deepEqual(api.verifyPlan(issued.doc, plan), plan.update);
  });

  test('verifyPlan rejects a second use', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const plan = api.redeem(issued.doc, issued.secret, {
      uid:'u_new', email:'new.user@example.com', email_verified:true
    });
    const used = Object.assign({}, issued.doc, plan.update);
    expectCode(function () { api.verifyPlan(used, plan); }, 'invalid-invitation');
  });

  test('verifyPlan rejects revocation that happens after inspection', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const plan = api.redeem(issued.doc, issued.secret, {
      uid:'u_new', email:'new.user@example.com', email_verified:true
    });
    const revoked = Object.assign({}, issued.doc, { revoked_at:new Date(NOW) });
    expectCode(function () { api.verifyPlan(revoked, plan); }, 'invalid-invitation');
  });

  test('verifyPlan rejects a plan copied to another invitation', function () {
    const api = buildApi();
    const first = api.issue(superGate, baseInput);
    const second = api.issue(superGate, Object.assign({}, baseInput, { phone:'050-1111111' }));
    const plan = api.redeem(first.doc, first.secret, {
      uid:'u_new', email:'new.user@example.com', email_verified:true
    });
    expectCode(function () { api.verifyPlan(second.doc, plan); }, 'invalid-invitation');
  });

  test('two concurrent plans cannot both commit', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const auth = { uid:'u_new', email:'new.user@example.com', email_verified:true };
    const first = api.redeem(issued.doc, issued.secret, auth);
    const second = api.redeem(issued.doc, issued.secret, auth);
    const afterFirst = Object.assign({}, issued.doc, api.verifyPlan(issued.doc, first));
    expectCode(function () { api.verifyPlan(afterFirst, second); }, 'invalid-invitation');
  });

  test('super can revoke an unused invitation', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const update = api.revoke(superGate, issued.doc);
    assert.equal(update.revoked_by, 'u_super');
    assert.equal(update.revoked_at.getTime(), NOW);
  });

  test('non-super cannot revoke outside its scope', function () {
    const api = buildApi();
    const issued = api.issue(superGate, Object.assign({}, baseInput, { station_id:'other_99' }));
    expectCode(function () { api.revoke(hrGate, issued.doc); }, 'out-of-scope');
  });

  test('a redeemed invitation cannot be revoked retroactively', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const used = Object.assign({}, issued.doc, { redeemed_by:'u_new' });
    expectCode(function () { api.revoke(superGate, used); }, 'invalid-invitation');
  });

  test('assertApprovable returns invitation-owned assignment values', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const redeemed = Object.assign({}, issued.doc, {
      redeemed_by:'u_new', redeemed_at:new Date(NOW)
    });
    const locked = api.assertApprovable(redeemed, {
      uid:'u_new', email:'new.user@example.com',
      stationId:'other_99', districtId:'north', role:'commander', shift:'Z'
    });
    assert.deepEqual(locked, {
      stationId:'eilat_102', districtId:'south', role:'firefighter', shift:'A'
    });
  });

  test('assertApprovable rejects revoked invitations', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const redeemed = Object.assign({}, issued.doc, {
      redeemed_by:'u_new', revoked_at:new Date(NOW)
    });
    expectCode(function () {
      api.assertApprovable(redeemed, { uid:'u_new', email:'new.user@example.com' });
    }, 'invalid-invitation');
  });

  test('approval rechecks expiry and rejects an expired invitation', function () {
    const api = buildApi(NOW + 100 * HOUR);
    const issued = buildApi().issue(superGate, baseInput);
    const redeemed = Object.assign({}, issued.doc, {
      redeemed_by:'u_new', redeemed_at:new Date(NOW + HOUR)
    });
    expectCode(function () {
      api.assertApprovable(redeemed, {
        uid:'u_new', email:'new.user@example.com'
      });
    }, 'invalid-invitation');
  });

  test('approval is bound to the account that redeemed', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const redeemed = Object.assign({}, issued.doc, { redeemed_by:'u_new' });
    expectCode(function () {
      api.assertApprovable(redeemed, { uid:'u_other', email:'new.user@example.com' });
    }, 'invalid-invitation');
  });

  test('approval is bound to the locked email', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const redeemed = Object.assign({}, issued.doc, { redeemed_by:'u_new' });
    expectCode(function () {
      api.assertApprovable(redeemed, { uid:'u_new', email:'other@example.com' });
    }, 'invalid-invitation');
  });

  test('issue does not mutate caller input', function () {
    const input = clone(baseInput);
    const before = clone(input);
    buildApi().issue(superGate, input);
    assert.deepEqual(input, before);
  });

  test('document contains no super-admin assignment flag', function () {
    const issued = buildApi().issue(superGate, baseInput);
    assert.equal(Object.hasOwn(issued.doc, 'super'), false);
  });

  test('all invalid inspect cases return the same public shape', function () {
    const api = buildApi();
    const issued = api.issue(superGate, baseInput);
    const shapes = [
      api.inspect(null, issued.secret),
      api.inspect(issued.doc, 'bad'),
      api.inspect(Object.assign({}, issued.doc, { revoked_at:new Date(NOW) }), issued.secret),
      api.inspect(Object.assign({}, issued.doc, { redeemed_by:'u' }), issued.secret)
    ];
    shapes.forEach(function (value) {
      assert.deepEqual(value, { ok:false, error:'invalid' });
    });
  });

  assert.ok(passed >= 35, 'the invitation contract must keep at least 35 checks');
  console.log('\n' + passed + ' invitation checks passed.');
})()
