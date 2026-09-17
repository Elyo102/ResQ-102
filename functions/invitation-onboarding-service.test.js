'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const contract = require('./invitation-onboarding-contract');
const { createInvitationOnboardingService, STAGE_REQUEST_CREATED } =
  require('./invitation-onboarding-service');

let passed = 0;
const failed = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; })
    .catch((e) => { failed.push(name + ' :: ' + (e && e.message)); });
}

/* ------------------------------------------------ תשתית מזויפת */

function fakeDb() {
  const store = new Map();
  const writes = [];
  return {
    _store: store, _writes: writes,
    _put(path, value) { store.set(path, value); },
    doc(path) {
      return {
        path,
        async get() { const v = store.get(path); return { exists: v !== undefined, data: () => v }; }
      };
    },
    async runTransaction(fn) {
      const staged = [];
      const tx = {
        async get(ref) { const v = store.get(ref.path); return { exists: v !== undefined, data: () => v }; },
        set(ref, value, options) { staged.push([ref.path, value, options]); }
      };
      const out = await fn(tx);
      for (const [path, value, options] of staged) {
        writes.push(path);
        if (options && options.merge) store.set(path, Object.assign({}, store.get(path) || {}, value));
        else store.set(path, value);
      }
      return out;
    }
  };
}

class FakeHttpsError extends Error {
  constructor(status, message, code) { super(message); this.name = 'FakeHttpsError'; this.status = status; this.code = code || null; }
}
const fail = (s, m, c) => { throw new FakeHttpsError(s, m, c); };

const SECRET = 'sekret-value-do-not-store';
const INVITE_ID = 'inv_0001';
const INVITE_DOC = Object.freeze({
  invite_id: INVITE_ID, station_id: 'shahmon', district_id: 'south',
  role: 'firefighter', shift: 'A', full_name: 'ישראל ישראלי',
  email: 'a@b.co', phone: '0500000000', revision: 1
});
const fingerprintOf = (invite) =>
  createHash('sha256').update(JSON.stringify([invite.invite_id, invite.revision])).digest('hex');

/* מנוע ההזמנות המוזרק — מדמה את החוזה של functions/invitations.js */
function fakeInvitations(over) {
  const o = over || {};
  return {
    verifyRedemptionReplay(invite, secret, auth, requestId) {
      if (invite.redeemed_by !== auth.uid || invite.redeemed_request_id !== requestId) {
        const e = new Error('invalid replay'); e.name = 'InvitationError'; e.code = 'invalid-invitation'; throw e;
      }
      return this.redeem(invite, secret, auth);
    },
    redeem(invite, secret, auth) {
      if (o.redeemThrows) { const e = new Error(o.redeemThrows); e.name = 'InvitationError'; e.code = o.redeemThrows; throw e; }
      if (secret !== SECRET) { const e = new Error('invitation is invalid'); e.name = 'InvitationError'; e.code = 'invalid-invitation'; throw e; }
      if (auth.email_verified !== true) { const e = new Error('verified email is required'); e.name = 'InvitationError'; e.code = 'email-not-verified'; throw e; }
      return {
        invite_id: invite.invite_id,
        invite_fingerprint: fingerprintOf(invite),
        redeemed_by: auth.uid,
        update: { redeemed_by: auth.uid },
        request: {
          full_name: invite.full_name, email: invite.email, phone: invite.phone,
          stationId: invite.station_id, districtId: invite.district_id,
          role: invite.role, shift: invite.shift
        }
      };
    },
    verifyPlan(invite, plan) {
      if (plan.invite_fingerprint !== fingerprintOf(invite)) {
        const e = new Error('invitation plan is stale'); e.name = 'InvitationError'; e.code = 'invalid-invitation'; throw e;
      }
      return true;
    }
  };
}

function build(over) {
  const o = over || {};
  const db = o.db || fakeDb();
  if (!db._store.has('invitations/' + INVITE_ID)) db._put('invitations/' + INVITE_ID, o.invite || INVITE_DOC);
  let ticks = 0;
  const service = createInvitationOnboardingService({
    db,
    contract,
    invitations: o.invitations || fakeInvitations(),
    registration: { async assignmentState() { if (o.onStateRead) o.onStateRead(); return o.assignment === undefined ? { completed: false } : o.assignment; } },
    identityStore: { async linkState() { return o.link === undefined ? { linked: false } : o.link; } },
    serverTimestamp: () => '__ts_' + (ticks += 1),
    fail,
    requireAuth: (req) => {
      if (!req || !req.auth) fail('unauthenticated', 'נדרשת התחברות.', 'no-auth');
      return req.auth;
    },
    requireSuperAdmin: (req) => {
      if (!req || !req.auth || req.auth.super !== true) fail('permission-denied', 'מנהל-על בלבד.', 'not-super');
      return req.auth;
    }
  });
  return { db, service };
}

const NEW_USER = Object.freeze({ uid: 'uid-new-1', email_verified: true, email: 'a@b.co' });
const REQ_ID = 'onb_20260915_000001';
const redeemReq = (over, auth) => ({
  auth: auth || NEW_USER,
  data: Object.assign({ invite_id: INVITE_ID, secret: SECRET, request_id: REQ_ID }, over || {})
});

async function rejectsWith(fn, status, code) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, 'לא נזרקה שגיאה');
  assert.equal(threw.name, 'FakeHttpsError', 'נזרקה שגיאה אחרת: ' + threw);
  assert.equal(threw.status, status, 'status=' + threw.status + ' expected=' + status);
  if (code) assert.equal(threw.code, code, 'code=' + threw.code + ' expected=' + code);
}

const suite = (async () => {

  /* ------------------------------------------------ מימוש */

  await test('S1 · ארבע הכתיבות בטרנזקציה אחת', async () => {
    const { db, service } = build();
    const out = await service.redeemInvitation(redeemReq());
    assert.equal(out.stage, STAGE_REQUEST_CREATED);
    assert.ok(db._store.get('invitations/' + INVITE_ID).redeemed_by === 'uid-new-1');
    assert.ok(db._store.has('registration_requests/uid-new-1'));
    assert.ok(db._store.has('stations/shahmon/onboarding_operations/' + REQ_ID));
    assert.ok(db._store.has('onboarding_assignment_links/uid-new-1'));
    assert.equal(db._writes.length, 4);
  });

  await test('S2 · מימוש אינו אישור ואינו מעניק הרשאות', async () => {
    const { db, service } = build();
    const out = await service.redeemInvitation(redeemReq());
    assert.equal(out.approved, false);
    assert.equal(out.permissions_granted, false);
    assert.equal(db._store.get('registration_requests/uid-new-1').status, 'pending');
    const text = JSON.stringify([...db._store.entries()]);
    for (const word of ['claims', 'custom_claims', 'approved_at', 'employee_number']) {
      assert.equal(text.includes(word), false, 'המימוש נגע ב-' + word);
    }
  });

  await test('S3 · role אינו נכתב לבקשת ההרשמה', async () => {
    const { db, service } = build();
    await service.redeemInvitation(redeemReq());
    const request = db._store.get('registration_requests/uid-new-1');
    assert.equal(Object.prototype.hasOwnProperty.call(request, 'role'), false);
    assert.equal(JSON.stringify(request).includes('firefighter'), false);
    for (const key of Object.keys(request)) {
      assert.ok(contract.REGISTRATION_ALLOWED.includes(key), 'מפתח אסור בבקשה: ' + key);
    }
    assert.match(String(request.created_at), /^__ts_\d+$/);
  });

  await test('S4 · השיוך נשמר בקישור המוגן שברשומת הפעולה', async () => {
    const { db, service } = build();
    await service.redeemInvitation(redeemReq());
    const op = db._store.get('stations/shahmon/onboarding_operations/' + REQ_ID);
    assert.equal(op.assignment_ref.role, 'firefighter');
    assert.equal(op.assignment_ref.station_id, 'shahmon');
    assert.equal(op.uid, 'uid-new-1');
    assert.equal(op.stage, STAGE_REQUEST_CREATED);
  });

  await test('S5 · הסוד אינו נשמר בשום מקום', async () => {
    const { db, service } = build();
    await service.redeemInvitation(redeemReq());
    assert.equal(JSON.stringify([...db._store.entries()]).includes(SECRET), false,
      'סוד ההזמנה נשמר');
  });

  /* ------------------------------------------------ אמינות המקור */

  await test('S6 · מסמך הזמנה, תוכנית מימוש או מקור מהלקוח נדחים', async () => {
    const { service } = build();
    for (const forged of [
      { redeemed: { invite_id: INVITE_ID } },
      { plan: {} },
      { invite: INVITE_DOC },
      { source: 'server_document' },
      { recomputed_fingerprint: 'a'.repeat(64) },
      { role: 'commander' },
      { station_id: 'timna' },
      { assignment_ref: {} }
    ]) {
      await rejectsWith(() => service.redeemInvitation(redeemReq(forged)),
        'invalid-argument', 'client-supplied-plan');
    }
  });

  await test('S7 · הזמנה שאינה קיימת, סוד שגוי, ואימייל לא מאומת', async () => {
    const { db, service } = build();
    db._store.delete('invitations/' + INVITE_ID);
    await rejectsWith(() => service.redeemInvitation(redeemReq()), 'not-found', 'invite-missing');

    const b = build();
    await rejectsWith(() => b.service.redeemInvitation(redeemReq({ secret: 'wrong' })),
      'failed-precondition', 'invalid-invitation');

    const c = build();
    await rejectsWith(() => c.service.redeemInvitation(
      redeemReq({}, { uid: 'uid-new-1', email_verified: false })),
      'failed-precondition', 'email-not-verified');
  });

  await test('S8 · תוכנית מיושנת מול המסמך השמור נדחית', async () => {
    const { db, service } = build();
    // ההזמנה השמורה השתנתה אחרי שהתוכנית נוצרה — verifyPlan חייב לתפוס
    const stale = {
      redeem: fakeInvitations().redeem,
      verifyPlan() { const e = new Error('invitation plan is stale'); e.name = 'InvitationError'; e.code = 'invalid-invitation'; throw e; }
    };
    const b = build({ db: fakeDb(), invitations: stale });
    await rejectsWith(() => b.service.redeemInvitation(redeemReq()),
      'failed-precondition', 'invalid-invitation');
    void db;
  });

  await test('S9 · ללא התחברות — נחסם', async () => {
    const { service } = build();
    await rejectsWith(() => service.redeemInvitation({ data: {} }), 'unauthenticated', 'no-auth');
  });

  /* ------------------------------------------------ התאוששות וכפילות */

  await test('S10 · ניסיון חוזר זהה אינו כותב שוב ואינו מקשר פעמיים', async () => {
    const { db, service } = build();
    await service.redeemInvitation(redeemReq());
    const after = db._writes.length;
    const again = await service.redeemInvitation(redeemReq());
    assert.equal(again.replayed, true);
    assert.equal(db._writes.length, after, 'הניסיון החוזר כתב שוב');
  });

  await test('S11 · אותו מזהה פעולה עם כוונה אחרת נדחה', async () => {
    const { db, service } = build();
    await service.redeemInvitation(redeemReq());
    const op = db._store.get('stations/shahmon/onboarding_operations/' + REQ_ID);
    db._put('stations/shahmon/onboarding_operations/' + REQ_ID,
      Object.assign({}, op, { operation_fingerprint: 'b'.repeat(64) }));
    await rejectsWith(() => service.redeemInvitation(redeemReq()),
      'failed-precondition', 'onboarding-intent-changed');
  });

  await test('S12 · הזמנה שמומשה בחשבון אחר אינה נלקחת', async () => {
    const { db, service } = build();
    db._put('invitations/' + INVITE_ID, Object.assign({}, INVITE_DOC, { redeemed_by: 'uid-someone-else' }));
    await rejectsWith(() => service.redeemInvitation(redeemReq()),
      'failed-precondition', 'invite-spent');
  });

  await test('S13 · בקשת הרשמה של פעולה אחרת אינה נדרסת', async () => {
    const { db, service } = build();
    db._put('registration_requests/uid-new-1', {
      request_id: 'onb_someone_else_00001', stationId: 'shahmon', districtId: 'south',
      shift: 'A', status: 'pending', full_name: 'x', email: 'a@b.co', phone: '', created_at: 1
    });
    await rejectsWith(() => service.redeemInvitation(redeemReq()),
      'failed-precondition', 'registration-foreign');
    assert.equal(db._store.get('registration_requests/uid-new-1').request_id, 'onb_someone_else_00001');
  });

  await test('S14 · בקשה קיימת של אותה פעולה שאינה תואמת לקישור נדחית', async () => {
    const { db, service } = build();
    db._put('registration_requests/uid-new-1', {
      request_id: REQ_ID, stationId: 'timna', districtId: 'south', shift: 'A',
      status: 'pending', full_name: 'x', email: 'a@b.co', phone: '', created_at: 1
    });
    await rejectsWith(() => service.redeemInvitation(redeemReq()),
      'failed-precondition', 'assignment-divergence');
  });

  /* ------------------------------------------------ resume */

  const resumeReq = { auth: { uid: 'uid-super-1', super: true }, data: { station_id: 'shahmon', request_id: REQ_ID } };

  await test('S15 · קיום בקשה אינו אישור — ממתינים לאישור, חסום', async () => {
    const { db, service } = build({ assignment: { completed: false } });
    await service.redeemInvitation(redeemReq());
    const out = await service.resumeOnboarding(resumeReq);
    assert.equal(out.step, 'await_approval');
    assert.equal(out.blocked, true);
    assert.equal(out.approved, false);
    void db;
  });

  await test('S16 · מנגנון שאינו מחזיר מצב מפורש — נכשל סגור', async () => {
    for (const bad of [null, {}, { completed: 'yes' }, { completed: 1 }]) {
      const { service } = build({ assignment: bad });
      await service.redeemInvitation(redeemReq());
      await rejectsWith(() => service.resumeOnboarding(resumeReq),
        'failed-precondition', 'assignment-state-unavailable');
    }
  });

  await test('S17 · אושר ואין אדם לקשר → הושלם', async () => {
    const { service } = build({ assignment: { completed: true } });
    await service.redeemInvitation(redeemReq());
    const out = await service.resumeOnboarding(resumeReq);
    assert.equal(out.step, 'complete');
    assert.equal(out.approved, true);
  });

  await test('S18 · מצב הקליטה מהקורא נדחה, וכך גם מי שאינו מנהל-על', async () => {
    const { service } = build();
    await service.redeemInvitation(redeemReq());
    await rejectsWith(() => service.resumeOnboarding({
      auth: { uid: 'uid-super-1', super: true },
      data: { station_id: 'shahmon', request_id: REQ_ID, assignment_completed: true }
    }), 'invalid-argument', 'state-from-client');
    await rejectsWith(() => service.resumeOnboarding({
      auth: { uid: 'uid-new-1', super: false }, data: { station_id: 'shahmon', request_id: REQ_ID }
    }), 'permission-denied', 'not-super');
  });

  await test('S19 · פעולה שאינה קיימת', async () => {
    const { service } = build();
    await rejectsWith(() => service.resumeOnboarding(resumeReq), 'not-found', 'operation-missing');
  });

  await test('S20 · תלות חסרה נדחית בהקמת השירות', async () => {
    assert.throws(() => createInvitationOnboardingService({ db: {}, contract }), TypeError);
    assert.throws(() => createInvitationOnboardingService(null), TypeError);
  });

  await test('S21 · malformed resume operation fails before state adapters', async () => {
    for (const change of [op => op.station_id = 'another_station', op => op.request_id = 'another_request_0001',
      op => op.uid = 'another_uid', op => op.assignment_ref = { ...op.assignment_ref, person_id: 'person_1' },
      op => op.assignment_ref = { ...op.assignment_ref, uid: 'another_uid' },
      op => op.stage = 'unknown', op => op.schema_version = 2]) {
      let reads = 0;
      const { db, service } = build({ onStateRead: () => { reads++; } });
      await service.redeemInvitation(redeemReq());
      change(db._store.get('stations/shahmon/onboarding_operations/' + REQ_ID));
      await rejectsWith(() => service.resumeOnboarding(resumeReq), 'failed-precondition', 'operation-shape');
      assert.equal(reads, 0);
    }
  });
  await test('S22 · unknown resume input cannot reach state adapters', async () => {
    let reads = 0;
    const { service } = build({ onStateRead: () => { reads++; } });
    await service.redeemInvitation(redeemReq());
    await rejectsWith(() => service.resumeOnboarding({ ...resumeReq, data: { ...resumeReq.data, person_id: 'sp_person_0001' } }), 'invalid-argument', 'state-from-client');
    assert.equal(reads, 0);
  });
})();

suite.then(() => {
  console.log('invitation-onboarding-service: ' + passed + ' tests passed'
    + (failed.length ? ', ' + failed.length + ' FAILED' : ''));
  for (const f of failed) console.log('  FAIL ' + f);
  if (failed.length) process.exit(1);
});
