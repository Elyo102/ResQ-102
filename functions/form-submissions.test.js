'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFakeFirestore } = require('./fixtures/fake-firestore');
const { createFormSubmissions } = require('./form-submissions');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const SID = 'alpha_1';
const UID = 'user.with.dot';
const NOW = '2026-09-13T08:15:00.000Z';
const NOW_MS = Date.parse(NOW);
const AUTH_TIME = Math.floor(NOW_MS / 1000) - 60;
const PROFILE_PATH = `stations/${SID}/users/${UID}`;
const PROFILE = Object.freeze({
  stationId: SID, station: SID, role: 'firefighter', active: true,
  is_active: true, employee_number: '9001', full_name: 'עובד בדיקה',
  crew: 'C', shift: 'C'
});
const TOKEN = Object.freeze({
  stationId: SID, role: 'firefighter', emp: 'stale', shift: 'A', auth_time: AUTH_TIME
});
const hash = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const bad = (code) => (error) => error && error.code === code;

function signature(type = 'png', length = 160) {
  if (type === 'png') {
    return 'data:image/png;base64,'
      + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  }
  if (type === 'jpeg' && length <= 400000) {
    const bytes = Buffer.concat([
      Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x2a]), Buffer.alloc(40),
      Buffer.from([0xff,0xc0,0x00,0x0b,0x08,0x00,0x01,0x00,0x01,0x01,0x01,0x11,0x00]),
      Buffer.from([0xff,0xda,0x00,0x08,0x01,0x01,0x00,0x00,0x3f,0x00,0x01,0xff,0xd9])
    ]);
    return 'data:image/jpeg;base64,' + bytes.toString('base64');
  }
  const prefix = `data:image/${type};base64,`;
  return prefix + 'A'.repeat(Math.max(0, length - prefix.length));
}

function leaveValues(patch = {}) {
  return {
    from: '2026-09-14', to: '2026-09-16', where: 'בארץ', phone: '', why: '',
    ...patch
  };
}

function input(patch = {}) {
  return {
    request_id: 'form-request-0001', form_id: 'leave', values: leaveValues(),
    signature_image: signature(), ...patch
  };
}

function request(data = input(), uid = UID, token = TOKEN) {
  return { auth: { uid, token }, data };
}

function fixture(seed = {}, options = {}) {
  const db = createFakeFirestore({ [PROFILE_PATH]: PROFILE, ...seed });
  db.setClock(NOW);
  const authUsers = {
    [UID]: { uid: UID, disabled: false, customClaims: { stationId: SID, role: 'firefighter' } },
    'second.user': { uid: 'second.user', disabled: false,
      customClaims: { stationId: SID, role: 'firefighter' } },
    'super.uid': { uid: 'super.uid', disabled: false,
      customClaims: { stationId: SID, role: '', super: true } },
    ...(options.authUsers || {})
  };
  const auth = { async getUser(uid) {
    if (!authUsers[uid]) { const error = new Error('missing user'); error.code = 'auth/user-not-found'; throw error; }
    return authUsers[uid];
  } };
  const service = createFormSubmissions({
    db, auth, HttpsError, serverTimestamp: db.FieldValue.serverTimestamp,
    clock: options.clock || (() => NOW_MS)
  });
  return { db, service, authUsers };
}

function submissionKeys(db) {
  return db.keys().filter((key) => /\/submissions\//.test(key));
}
function operationKeys(db) {
  return db.keys().filter((key) => /\/form_submission_operations\//.test(key));
}
function only(array, message) {
  assert.equal(array.length, 1, message);
  return array[0];
}
function assertNoPrivateReceiptData(value) {
  const text = JSON.stringify(value || {});
  for (const forbidden of [
    'values', 'signature_image', 'signature', 'form_he', 'kind', 'is_private',
    'by_name', 'by_emp', 'employee_number', 'phone', 'why', 'what', 'hurt'
  ]) assert.equal(text.includes(`"${forbidden}"`), false, `receipt leaks ${forbidden}`);
}

test('F1: first commit stores one canonical submission and one private receipt atomically', async () => {
  const { db, service } = fixture();
  const out = await service.submit(request());
  assert.equal(out.committed, true);
  assert.equal(out.duplicate, false);
  assert.match(out.submission_id, /^[A-Za-z0-9_-]{8,120}$/);
  assert.deepEqual(submissionKeys(db), [`stations/${SID}/submissions/${out.submission_id}`]);
  const opKey = only(operationKeys(db), 'one operation receipt');
  const saved = db.read(submissionKeys(db)[0]);
  assert.deepEqual(saved.values, leaveValues());
  assert.equal(saved.form_id, 'leave');
  assert.equal(saved.form_he, 'בקשת חופשה');
  assert.equal(saved.kind, 'vacation');
  assert.equal(saved.is_private, false);
  assert.equal(saved.status, 'submitted');
  assert.equal(saved.by_uid, UID);
  assert.equal(saved.by_name, PROFILE.full_name);
  assert.equal(saved.by_emp, PROFILE.employee_number);
  assert.equal(saved.crew, PROFILE.crew);
  assert.equal(saved.signature, input().signature_image);
  assert.deepEqual(saved.signatures.employee, {
    image: input().signature_image, uid: UID, name: PROFILE.full_name,
    emp: PROFILE.employee_number, role: PROFILE.role, at: NOW
  });
  assert.equal(saved.created_key, NOW);
  assert.equal(saved.created_at, NOW);
  const receipt = db.read(opKey);
  assert.equal(receipt.station_id, SID);
  assert.equal(receipt.actor_uid, UID);
  assert.equal(receipt.request_id, input().request_id);
  assert.equal(receipt.submission_id, out.submission_id);
  assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
  assertNoPrivateReceiptData(receipt);
  assertNoPrivateReceiptData(out);
});

test('F2/F3: exact replay is one write; changed payload under the id conflicts', async () => {
  const { db, service } = fixture();
  const first = await service.submit(request());
  const writes = db.writes.length;
  assert.deepEqual(await service.submit(request()), {
    committed: true, duplicate: true, submission_id: first.submission_id
  });
  assert.equal(db.writes.length, writes);
  for (const changed of [
    input({ form_id: 'noclock', values: { date: '2026-09-14', in: '08:00', out: '16:00', why: 'תקלה' } }),
    input({ values: leaveValues({ why: 'תוכן אחר' }) }),
    input({ signature_image: signature('jpeg', 160) })
  ]) await assert.rejects(service.submit(request(changed)), bad('already-exists'));
  assert.equal(db.writes.length, writes);
});

test('F4/F5: a lost response reconciles committed; an unseen id remains unobserved', async () => {
  const { db, service } = fixture();
  const real = db.runTransaction.bind(db);
  let lose = true;
  db.runTransaction = async (work) => {
    const result = await real(work);
    if (lose) { lose = false; throw new Error('synthetic response lost after commit'); }
    return result;
  };
  await assert.rejects(service.submit(request()), /response lost/);
  const committed = await service.status(request({ request_id: input().request_id }));
  assert.equal(committed.status, 'committed');
  assert.match(committed.submission_id, /^[A-Za-z0-9_-]{8,120}$/);
  assertNoPrivateReceiptData(committed);
  const writes = db.writes.length;
  const replay = await service.submit(request());
  assert.equal(replay.duplicate, true);
  assert.equal(replay.submission_id, committed.submission_id);
  assert.equal(db.writes.length, writes);
  const unseen = await service.status(request({ request_id: 'form-request-unseen' }));
  assert.deepEqual(unseen, { status: 'unobserved' });
  assert.equal(unseen.failed, undefined);
});

test('F6/F7: request id is actor scoped and every payload field participates in replay identity', async () => {
  const other = 'second.user';
  const otherPath = `stations/${SID}/users/${other}`;
  const { db, service } = fixture({ [otherPath]: { ...PROFILE, employee_number: '9002', full_name: 'עובד שני' } });
  const one = await service.submit(request());
  const two = await service.submit(request(input(), other));
  assert.notEqual(one.submission_id, two.submission_id);
  assert.equal(submissionKeys(db).length, 2);
  for (const patch of [
    { request_id: 'form-request-0001', values: leaveValues({ phone: '0500000000' }) },
    { request_id: 'form-request-0001', values: leaveValues({ from: '2026-09-15' }) }
  ]) await assert.rejects(service.submit(request(input(patch))), bad('already-exists'));
});

test('F8: client identity and derived document fields are rejected from input', async () => {
  const { db, service } = fixture();
  for (const extra of [
    { station_id: 'beta_2' }, { stationId: 'beta_2' }, { by_uid: 'other' },
    { by_name: 'מתחזה' }, { by_emp: '1' }, { crew: 'A' }, { role: 'commander' },
    { status: 'approved' }, { form_he: 'מזויף' }, { kind: 'vacation' },
    { is_private: false }, { created_key: NOW }, { created_at: NOW }
  ]) await assert.rejects(service.submit(request({ ...input(), ...extra })), bad('invalid-argument'));
  assert.equal(db.writes.length, 0);
});

test('F8: live membership is checked before first commit, replay and status', async () => {
  const brokenProfiles = [
    null, { ...PROFILE, active: false }, { ...PROFILE, is_active: false },
    { ...PROFILE, stationId: 'beta_2' }, { ...PROFILE, station: 'beta_2' },
    { ...PROFILE, role: 'commander' }
  ];
  for (const profile of brokenProfiles) {
    const f = fixture();
    await f.service.submit(request());
    f.db.write(PROFILE_PATH, profile);
    const writes = f.db.writes.length;
    await assert.rejects(f.service.submit(request()), bad('permission-denied'));
    await assert.rejects(f.service.status(request({ request_id: input().request_id })), bad('permission-denied'));
    await assert.rejects(f.service.submit(request(input({ request_id: 'form-request-0002' }))), bad('permission-denied'));
    assert.equal(f.db.writes.length, writes);
  }
});

test('F9: super requires a signed station id and cannot manufacture it from email or role', async () => {
  const { db, service } = fixture({}, {});
  const verified = { super: true, role: '', stationId: SID, auth_time: AUTH_TIME };
  const out = await service.submit(request(input({ request_id: 'super-form-request' }), 'super.uid', verified));
  assert.equal(out.committed, true);
  assert.ok(db.read(`stations/${SID}/submissions/${out.submission_id}`));
  for (const token of [
    { super: true, role: '', stationId: '', auth_time: AUTH_TIME },
    { super: false, role: 'super_admin', stationId: SID, auth_time: AUTH_TIME },
    { super: false, role: '', stationId: SID, email: 'fire102.shits@gmail.com', auth_time: AUTH_TIME }
  ]) await assert.rejects(
    service.submit(request(input({ request_id: 'super-form-denied' }), 'super.uid', token))
  );
});

test('F10/F15: corrupt or one-sided operation state fails closed', async () => {
  for (const mutation of ['receipt-actor', 'receipt-fingerprint', 'missing-submission', 'missing-receipt']) {
    const { db, service } = fixture();
    const out = await service.submit(request());
    const opKey = only(operationKeys(db));
    const subKey = only(submissionKeys(db));
    if (mutation === 'receipt-actor') db.write(opKey, { ...db.read(opKey), actor_uid: 'other' });
    if (mutation === 'receipt-fingerprint') db.write(opKey, { ...db.read(opKey), fingerprint: '0'.repeat(64) });
    if (mutation === 'missing-submission') {
      await db.runTransaction(async (tx) => tx.delete(db.doc(subKey)));
    }
    if (mutation === 'missing-receipt') {
      await db.runTransaction(async (tx) => tx.delete(db.doc(opKey)));
    }
    await assert.rejects(service.submit(request()), (error) =>
      error && ['failed-precondition', 'internal', 'already-exists'].includes(error.code));
    await assert.rejects(service.status(request({ request_id: input().request_id })), (error) =>
      error && ['failed-precondition', 'internal'].includes(error.code));
    assert.equal(out.committed, true);
  }
});

test('F11: PNG/JPEG signature boundaries pass; bad size, type and shape fail without writes', async () => {
  for (const image of [signature('png', 104), signature('jpeg', 400000)]) {
    const { service } = fixture();
    assert.equal((await service.submit(request(input({ signature_image: image })))).committed, true);
  }
  for (const image of [
    'data:image/png;base64,' + Buffer.alloc(24).toString('base64'),
    signature('jpeg', 400004), signature('gif', 160),
    'data:image/png;base64,' + '%'.repeat(140),
    'data:image/png;base64,' + 'A'.repeat(140), '', null, 123
  ]) {
    const { db, service } = fixture();
    await assert.rejects(service.submit(request(input({ signature_image: image }))), bad('invalid-argument'));
    assert.equal(db.writes.length, 0);
  }
});

const FORMS = Object.freeze([
  ['leave', leaveValues(), 'בקשת חופשה', 'vacation', false],
  ['noclock', { date: '2026-09-14', in: '23:00', out: '07:00', why: 'משמרת לילה' },
    'דוח אי החתמת כרטיס', 'missed_punch', false],
  ['injury', { date: '2026-09-14', time: '09:30', where: 'רחבה', what: 'נפילה', hurt: 'יד', med: 'כן' },
    'דוח פציעה', 'form', true],
  ['damage_rep', { date: '2026-09-14', where: 'מחסן', what: 'ארון', who: '', how: 'פגיעה' },
    'דוח נזק', 'form', false]
]);

test('F12/F14: all four canonical form shapes preserve display, privacy and signature contracts', async () => {
  for (let i = 0; i < FORMS.length; i++) {
    const [formId, values, formHe, kind, isPrivate] = FORMS[i];
    const { db, service } = fixture();
    const data = input({ request_id: `canonical-form-${i}`, form_id: formId, values });
    const out = await service.submit(request(data));
    const saved = db.read(`stations/${SID}/submissions/${out.submission_id}`);
    assert.equal(saved.form_he, formHe);
    assert.equal(saved.kind, kind);
    assert.equal(saved.is_private, isPrivate);
    assert.deepEqual(saved.values, values);
    assert.equal(saved.signature, data.signature_image);
    assert.equal(saved.signatures.employee.image, data.signature_image);
  }
});

test('F12: optional omissions canonicalize to empty strings and object key order does not change replay', async () => {
  const { service } = fixture();
  const minimal = { from: '2026-09-14', to: '2026-09-16', where: 'בארץ' };
  const first = await service.submit(request(input({ values: minimal })));
  const reordered = { why: '', where: 'בארץ', to: '2026-09-16', phone: '', from: '2026-09-14' };
  const replay = await service.submit(request(input({ values: reordered })));
  assert.equal(replay.duplicate, true);
  assert.equal(replay.submission_id, first.submission_id);
});

test('F12: form ids, exact keys, primitive types and field values are validated server-side', async () => {
  const invalid = [
    input({ form_id: 'unknown' }), input({ values: { ...leaveValues(), hidden: 'x' } }),
    input({ values: { ...leaveValues(), phone: 5 } }), input({ values: [] }),
    input({ values: leaveValues({ from: '' }) }), input({ values: leaveValues({ from: '14/09/2026' }) }),
    input({ values: leaveValues({ from: '2026-02-30' }) }), input({ values: leaveValues({ to: '2026-09-13' }) }),
    input({ values: leaveValues({ where: 'בחול' }) }),
    input({ form_id: 'noclock', values: { date: '2026-09-14', in: '24:00', out: '07:00', why: 'x' } }),
    input({ form_id: 'injury', values: { ...FORMS[2][1], med: 'אולי' } })
  ];
  for (let i = 0; i < invalid.length; i++) {
    const { db, service } = fixture();
    await assert.rejects(service.submit(request({ ...invalid[i], request_id: `invalid-form-${String(i).padStart(4, '0')}` })), bad('invalid-argument'));
    assert.equal(db.writes.length, 0);
  }
});

test('F12: text, phone and long fields enforce the approved limits without truncation', async () => {
  const accepted = [
    input({ values: leaveValues({ phone: '1'.repeat(300), why: 'א'.repeat(4000) }) }),
    input({ form_id: 'injury', values: { ...FORMS[2][1], where: 'א'.repeat(300), what: 'ב'.repeat(4000), hurt: 'ג'.repeat(300) } })
  ];
  for (let i = 0; i < accepted.length; i++) {
    const { service } = fixture();
    assert.equal((await service.submit(request({ ...accepted[i], request_id: `form-limit-pass-${i}000` }))).committed, true);
  }
  const rejected = [
    input({ values: leaveValues({ phone: '1'.repeat(301) }) }),
    input({ values: leaveValues({ why: 'א'.repeat(4001) }) }),
    input({ form_id: 'injury', values: { ...FORMS[2][1], where: 'א'.repeat(301) } })
  ];
  for (let i = 0; i < rejected.length; i++) {
    const { db, service } = fixture();
    await assert.rejects(service.submit(request({ ...rejected[i], request_id: `form-limit-fail-${i}000` })), bad('invalid-argument'));
    assert.equal(db.writes.length, 0);
  }
});

test('F12: canonical values use a 16 KiB UTF-8 boundary', async () => {
  const base = { date: '2026-09-14', where: 'מחסן', what: '', who: '', how: '' };
  function jsonBytes(values) { return Buffer.byteLength(JSON.stringify(values), 'utf8'); }
  function withExactTarget(target) {
    const fixed = jsonBytes(base);
    const room = target - fixed;
    assert.ok(room >= 0 && room % 2 === 0);
    let letters = room / 2;
    const values = { ...base };
    for (const key of ['what', 'who', 'how']) {
      const count = Math.min(4000, letters);
      values[key] = 'א'.repeat(count);
      letters -= count;
    }
    assert.equal(letters, 0);
    assert.ok(values.how.length > 0, 'required long field remains populated');
    return values;
  }
  // JSON escaping is ASCII while each Hebrew letter is two UTF-8 bytes.
  const atLimit = withExactTarget(16 * 1024);
  const overLimit = { ...atLimit, what: atLimit.what + 'א' };
  assert.equal(jsonBytes(atLimit), 16 * 1024);
  assert.equal(jsonBytes(overLimit), 16 * 1024 + 2);
  const okFixture = fixture();
  assert.equal((await okFixture.service.submit(request(input({
    request_id: 'values-byte-limit-pass', form_id: 'damage_rep', values: atLimit
  })))).committed, true);
  const badFixture = fixture();
  await assert.rejects(badFixture.service.submit(request(input({
    request_id: 'values-byte-limit-fail', form_id: 'damage_rep', values: overLimit
  }))), bad('invalid-argument'));
  assert.equal(badFixture.db.writes.length, 0);
});

test('F12: leave range accepts 400 inclusive days and rejects 401', async () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = (days) => new Date(start.getTime() + (days - 1) * 86400000).toISOString().slice(0, 10);
  const accepted = fixture();
  assert.equal((await accepted.service.submit(request(input({
    values: leaveValues({ from: '2026-01-01', to: end(400) })
  })))).committed, true);
  const rejected = fixture();
  await assert.rejects(rejected.service.submit(request(input({
    values: leaveValues({ from: '2026-01-01', to: end(401) })
  }))), bad('invalid-argument'));
  assert.equal(rejected.db.writes.length, 0);
});

test('F13/F16: malformed authentication and absent canonical station never write', async () => {
  const { db, service } = fixture();
  for (const req of [
    { data: input() },
    request(input(), UID, { ...TOKEN, stationId: '' }),
    request(input(), UID, { ...TOKEN, role: '' })
  ]) await assert.rejects(service.submit(req));
  assert.equal(db.writes.length, 0);
});

test('F15: a failure while staging either document rolls back the entire transaction', async () => {
  const { db, service } = fixture();
  const real = db.runTransaction.bind(db);
  db.runTransaction = (work) => real((tx) => work(new Proxy(tx, {
    get(target, key) {
      if (key === 'create') return (ref, value) => {
        if (/\/form_submission_operations\//.test(ref.path)) throw new Error('synthetic receipt write failure');
        return target.create(ref, value);
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  })));
  await assert.rejects(service.submit(request()), /receipt write failure/);
  assert.equal(submissionKeys(db).length, 0);
  assert.equal(operationKeys(db).length, 0);
  assert.equal(db.writes.length, 0);
});

test('F17: status is read-only and never turns an unknown operation into a failure record', async () => {
  const { db, service } = fixture();
  const before = db.writes.length;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await service.status(request({ request_id: `unseen-status-${i}000` })), { status: 'unobserved' });
  }
  assert.equal(db.writes.length, before);
  assert.equal(operationKeys(db).length, 0);
});
