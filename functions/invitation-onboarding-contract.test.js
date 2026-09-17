'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const c = require('./invitation-onboarding-contract');

let passed = 0;
const failed = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { failed.push(name + ' :: ' + (e && e.message)); }
}
function throwsCode(fn, code, hint) {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof c.OnboardingContractError, 'not an OnboardingContractError: ' + e);
    assert.equal(e.code, code, (hint || '') + ' code=' + e.code + ' expected=' + code);
    return true;
  }, hint);
}

const FP = 'f'.repeat(64);
const INVITE = Object.freeze({ invite_id: 'inv_0001', station_id: 'shahmon', district_id: 'south' });
const REDEEMED = Object.freeze({
  invite_id: 'inv_0001',
  invite_fingerprint: FP,
  redeemed_by: 'uid-new-1',
  request: Object.freeze({
    full_name: 'ישראל ישראלי', email: 'a@b.co', phone: '0500000000',
    stationId: 'shahmon', districtId: 'south', role: 'firefighter', shift: 'A'
  })
});
const AUTH = Object.freeze({ uid: 'uid-new-1', email_verified: true, email: 'a@b.co' });
const INPUT = Object.freeze({
  source: 'server_document',
  invite: INVITE,
  redeemed: REDEEMED,
  recomputed_fingerprint: FP,
  auth: AUTH,
  request_id: 'onb_20260915_000001'
});
const withInput = (over) => Object.assign({}, INPUT, over || {});
const withRedeemed = (over) => withInput({
  redeemed: Object.assign({}, REDEEMED, over || {})
});
const withRequest = (over) => withInput({
  redeemed: Object.assign({}, REDEEMED, { request: Object.assign({}, REDEEMED.request, over || {}) })
});

/* ------------------------------------------------ הפיצול */

test('T1 · בקשת ההרשמה מכילה רק מפתחות מותרים, ו-created_at נמסר מהשרת', () => {
  const plan = c.splitRedemption(INPUT);
  for (const key of Object.keys(plan.registration_request)) {
    assert.ok(c.REGISTRATION_ALLOWED.includes(key), 'מפתח לא מותר: ' + key);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(plan.registration_request, 'created_at'), false);
  assert.deepEqual([...plan.registration_server_supplied], ['created_at']);
  assert.equal(plan.registration_request.status, 'pending');
});

test('T2 · role אינו במסמך שהלקוח כותב', () => {
  const plan = c.splitRedemption(INPUT);
  assert.deepEqual([...c.REQUEST_FORBIDDEN], ['role']);
  for (const field of c.REQUEST_FORBIDDEN) {
    assert.equal(Object.prototype.hasOwnProperty.call(plan.registration_request, field), false,
      'שדה אסור דלף לבקשה: ' + field);
  }
  assert.equal(JSON.stringify(plan.registration_request).includes('firefighter'), false,
    'התפקיד מופיע בבקשה שהלקוח כותב');
});

test('T2b · תחנה, מחוז ומשמרת מותרים בבקשה אך סמכותם היא הקישור המוגן', () => {
  const plan = c.splitRedemption(INPUT);
  assert.deepEqual([...c.ASSIGNMENT_AUTHORITY], ['role', 'station_id', 'district_id', 'shift']);
  // הכללים מחייבים אותם בבקשה - הם קיימים בה
  for (const key of ['stationId', 'districtId', 'shift']) {
    assert.ok(Object.prototype.hasOwnProperty.call(plan.registration_request, key),
      'הכללים מחייבים את ' + key + ' בבקשה');
  }
  // וחייבים להיות זהים לקישור, כדי שבקשה שעברה שינוי תתגלה
  assert.equal(plan.registration_request.stationId, plan.assignment_ref.station_id);
  assert.equal(plan.registration_request.districtId, plan.assignment_ref.district_id);
  assert.equal(plan.registration_request.shift, plan.assignment_ref.shift);
});

test('T3 · הקישור המוגן נושא את השיוך ואת טביעת אצבע הבקשה', () => {
  const plan = c.splitRedemption(INPUT);
  const ref = plan.assignment_ref;
  assert.equal(ref.role, 'firefighter');
  assert.equal(ref.station_id, 'shahmon');
  assert.equal(ref.district_id, 'south');
  assert.equal(ref.shift, 'A');
  assert.equal(ref.uid, 'uid-new-1');
  assert.equal(ref.invite_id, 'inv_0001');
  assert.match(ref.registration_fingerprint, /^[a-f0-9]{64}$/);
});

test('T4 · אין סוד בשום פלט', () => {
  const plan = c.splitRedemption(INPUT);
  const text = JSON.stringify(plan).toLowerCase();
  for (const word of ['secret', 'token', 'password']) {
    assert.equal(text.includes(word), false, 'הפלט מכיל ' + word);
  }
  assert.equal(c.assertNoSecret(plan, 'test'), true);
});

test('T5 · הפלטים קפואים', () => {
  const plan = c.splitRedemption(INPUT);
  for (const obj of [plan, plan.registration_request, plan.assignment_ref]) {
    assert.equal(Object.isFrozen(obj), true);
  }
  assert.throws(() => { plan.assignment_ref.role = 'commander'; }, TypeError);
});

/* ------------------------------------------------ אמינות המקור */

test('T6 · מקור שאינו מסמך שרת נדחה — כולל אובייקט מהדפדפן', () => {
  throwsCode(() => c.splitRedemption(withInput({ source: 'client' })), 'untrusted-source');
  throwsCode(() => c.splitRedemption(withInput({ source: undefined })), 'untrusted-source');
  const noSource = Object.assign({}, INPUT); delete noSource.source;
  throwsCode(() => c.splitRedemption(noSource), 'untrusted-source');
});

test('T7 · טביעת אצבע שלא חושבה מחדש, או שאינה תואמת, נדחית', () => {
  throwsCode(() => c.splitRedemption(withInput({ recomputed_fingerprint: '' })), 'fingerprint-missing');
  throwsCode(() => c.splitRedemption(withInput({ recomputed_fingerprint: 'a'.repeat(64) })),
    'fingerprint-mismatch');
  throwsCode(() => c.splitRedemption(withRedeemed({ invite_fingerprint: 'b'.repeat(64) })),
    'fingerprint-mismatch');
});

test('T8 · מזהה הזמנה שאינו תואם למסמך נדחה', () => {
  throwsCode(() => c.splitRedemption(withRedeemed({ invite_id: 'inv_0002' })), 'invite-id-mismatch');
});

test('T9 · תחנת ההזמנה גוברת — תוכנית עם תחנה אחרת נדחית', () => {
  throwsCode(() => c.splitRedemption(withRequest({ stationId: 'timna' })), 'invite-station-mismatch');
});

test('T10 · אימייל לא מאומת, או ממַמש שאינו בעל החשבון, נדחים', () => {
  throwsCode(() => c.splitRedemption(withInput({ auth: { uid: 'uid-new-1', email_verified: false } })),
    'email-unverified');
  throwsCode(() => c.splitRedemption(withInput({ auth: { uid: 'uid-other', email_verified: true } })),
    'redeemer-mismatch');
});

test('T11 · שדות פסולים נדחים עם הקוד שלהם', () => {
  throwsCode(() => c.splitRedemption(withInput({ request_id: 'short' })), 'request-id');
  throwsCode(() => c.splitRedemption(withRequest({ stationId: 'Shahmon' })), 'station-id');
  throwsCode(() => c.splitRedemption(withRequest({ districtId: '' })), 'district-id');
  throwsCode(() => c.splitRedemption(withRequest({ role: 'Firefighter' })), 'role');
  throwsCode(() => c.splitRedemption(withRequest({ role: '' })), 'role');
  throwsCode(() => c.splitRedemption(withRequest({ full_name: 'x\u0000' })), 'full-name');
  throwsCode(() => c.splitRedemption(withRequest({ email: '   ' })), 'email');
  throwsCode(() => c.splitRedemption(null), 'redemption-shape');
});

test('T12 · assertNoSecret תופס סוד בכל עומק', () => {
  throwsCode(() => c.assertNoSecret({ a: { b: { secret: 'x' } } }, 'test'), 'secret-leak');
  throwsCode(() => c.assertNoSecret({ invite_secret: 'x' }, 'test'), 'secret-leak');
  throwsCode(() => c.assertNoSecret({ a: [{ token: 'x' }] }, 'test'), 'secret-leak');
  assert.equal(c.assertNoSecret({ a: { b: 1 } }, 'test'), true);
});

test('T13a · בקשה שמורה חייבת לתאום את הקישור המוגן', () => {
  const plan = c.splitRedemption(INPUT);
  const ref = plan.assignment_ref;
  const stored = Object.assign({}, plan.registration_request);
  assert.equal(c.assertRequestMatchesLink(stored, ref), true);
  throwsCode(() => c.assertRequestMatchesLink(
    Object.assign({}, stored, { stationId: 'timna' }), ref), 'assignment-divergence');
  throwsCode(() => c.assertRequestMatchesLink(
    Object.assign({}, stored, { districtId: 'north' }), ref), 'assignment-divergence');
  throwsCode(() => c.assertRequestMatchesLink(
    Object.assign({}, stored, { shift: 'B' }), ref), 'assignment-divergence');
  throwsCode(() => c.assertRequestMatchesLink(
    Object.assign({}, stored, { role: 'commander' }), ref), 'assignment-leak');
  throwsCode(() => c.assertRequestMatchesLink(null, ref), 'existing-shape');
});

/* ------------------------------------------------ אין דריסה של בקשה זרה */

test('T13 · בקשה קיימת של פעולה אחרת אינה נדרסת', () => {
  const plan = c.splitRedemption(INPUT);
  assert.deepEqual({ ...c.mayWriteRegistration(null, plan) }, { allowed: true, reason: 'absent' });
  assert.deepEqual({ ...c.mayWriteRegistration({ ...plan.registration_request }, plan) },
    { allowed: true, reason: 'same-operation' });
  assert.deepEqual({ ...c.mayWriteRegistration({ request_id: 'onb_someone_else_0001' }, plan) },
    { allowed: false, reason: 'foreign-operation' });
  throwsCode(() => c.mayWriteRegistration('x', plan), 'existing-shape');
});

/* ------------------------------------------------ התאוששות בשלושה מצבים */

test('T14 · אין בקשה → יוצרים בקשה', () => {
  assert.deepEqual({ ...c.nextOnboardingStep({ request_created: false }) },
    { step: 'create_request', stage: null, blocked: false });
});

test('T15 · קיום בקשה אינו אישור — מצב לא ידוע נדחה, לא מונח', () => {
  throwsCode(() => c.nextOnboardingStep({ request_created: true }), 'assignment-state-unknown');
  throwsCode(() => c.nextOnboardingStep({ request_created: true, assignment_completed: 'yes' }),
    'assignment-state-unknown');
  throwsCode(() => c.nextOnboardingStep({ request_created: true, assignment_completed: 1 }),
    'assignment-state-unknown');
  throwsCode(() => c.nextOnboardingStep({}), 'stage-unknown');
  throwsCode(() => c.nextOnboardingStep(null), 'state-shape');
});

test('T16 · בקשה קיימת ואישור טרם ניתן → ממתינים לאישור, חסום', () => {
  assert.deepEqual({ ...c.nextOnboardingStep({ request_created: true, assignment_completed: false }) },
    { step: 'await_approval', stage: 'request_created', blocked: true });
});

test('T17 · אושר, נדרש קישור אדם וטרם קושר → מקשרים', () => {
  assert.deepEqual({ ...c.nextOnboardingStep({
    request_created: true, assignment_completed: true, person_required: true, person_linked: false }) },
    { step: 'link_person', stage: 'assignment_completed', blocked: false });
  throwsCode(() => c.nextOnboardingStep({
    request_created: true, assignment_completed: true, person_required: true }), 'link-state-unknown');
});

test('T18 · אושר ואין אדם לקשר → הושלם', () => {
  assert.deepEqual({ ...c.nextOnboardingStep({
    request_created: true, assignment_completed: true, person_required: false }) },
    { step: 'complete', stage: 'assignment_completed', blocked: false });
  assert.deepEqual({ ...c.nextOnboardingStep({
    request_created: true, assignment_completed: true, person_required: true, person_linked: true }) },
    { step: 'complete', stage: 'person_linked', blocked: false });
});

test('T19 · שלושת השלבים מוצהרים ונפרדים', () => {
  assert.deepEqual([...c.ONBOARDING_STAGES],
    ['request_created', 'assignment_completed', 'person_linked']);
});

/* ------------------------------------------------ טוהר מבני */

test('T20 · תלות אחת בלבד, ואין שעון ואין אקראיות', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'invitation-onboarding-contract.js'), 'utf8');
  const requires = [...raw.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['node:crypto'], 'תלות נוספת: ' + requires.join(', '));
  // הערות אינן קוד. סריקה על מקור גולמי נכשלת על המילה firestore שבהערה —
  // בדיוק הפגם שחסמתי אצל אחרים. מסירים הערות לפני הסריקה.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((line) => line.replace(/\/\/.*$/, ' ')).join('\n');
  assert.equal(/\bfirestore\b/i.test(code), false, 'הקוד מכיל firestore');
  for (const banned of ['firebase', 'admin.', 'Math.random', 'Date.now', 'new Date(']) {
    assert.equal(code.includes(banned), false, 'הקוד מכיל ' + banned);
  }
});

test('T20b · הסרת ההערות עצמה נבדקת — אחרת הבדיקה לא בודקת דבר', () => {
  const strip = (raw) => raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((line) => line.replace(/\/\/.*$/, ' ')).join('\n');
  assert.equal(/\bfirestore\b/i.test(strip('/* firestore.rules */\nconst a = 1;')), false);
  assert.equal(/\bfirestore\b/i.test(strip('// firestore\nconst a = 1;')), false);
  assert.equal(/\bfirestore\b/i.test(strip('const x = firestore.doc();')), true,
    'הסרת ההערות בלעה גם קוד אמיתי');
});

test('T21 · טביעת אצבע הבקשה משתנה עם כל שדה בבקשה', () => {
  const base = c.splitRedemption(INPUT).assignment_ref.registration_fingerprint;
  for (const over of [{ full_name: 'אחר' }, { email: 'z@b.co' }, { phone: '0511111111' }, { shift: 'B' }]) {
    assert.notEqual(c.splitRedemption(withRequest(over)).assignment_ref.registration_fingerprint, base,
      'שדה מחוץ לטביעת האצבע: ' + Object.keys(over)[0]);
  }
});

test('T22 · טביעת אצבע הפעולה שונה כששינוי נוגע רק בשיוך', () => {
  const base = c.splitRedemption(INPUT).operation_fingerprint;
  assert.notEqual(c.splitRedemption(withRequest({ role: 'commander' })).operation_fingerprint, base);
});

test('Full immutable registration projection rejects name/email/phone/request tampering', () => {
  const plan = c.splitRedemption(INPUT);
  for (const key of ['full_name', 'email', 'phone', 'request_id']) {
    throwsCode(() => c.assertRequestMatchesLink({ ...plan.registration_request, [key]: 'changed' }, plan.assignment_ref), 'registration-divergence');
  }
  assert.equal(c.assertRequestMatchesLink({ ...plan.registration_request, status: 'processing', created_at: new Date(), server_generation: 'server' }, plan.assignment_ref), true);
  assert.equal(c.mayWriteRegistration({ ...plan.registration_request, status: 'processing' }, plan).allowed, false);
});
test('Person link comes only from valid server invitation and participates in intent', () => {
  const base = c.splitRedemption(INPUT);
  const linked = c.splitRedemption(withInput({ invite: { ...INVITE, person_id: 'sp_person_0001' } }));
  assert.equal(linked.assignment_ref.person_id, 'sp_person_0001');
  assert.equal(linked.registration_request.person_id, undefined);
  assert.notEqual(base.operation_fingerprint, linked.operation_fingerprint);
  throwsCode(() => c.splitRedemption(withInput({ invite: { ...INVITE, person_id: '../escape' } })), 'person-id');
  throwsCode(() => c.splitRedemption(withInput({ invite: { ...INVITE, person_id: 'person_1' } })), 'person-id');
});
console.log('invitation-onboarding-contract: ' + passed + ' tests passed'
  + (failed.length ? ', ' + failed.length + ' FAILED' : ''));
for (const f of failed) console.log('  FAIL ' + f);
if (failed.length) process.exit(1);
