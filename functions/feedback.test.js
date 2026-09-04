'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFakeFirestore } = require('./fixtures/fake-firestore');
const { createFeedback, LIMITS } = require('./feedback');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const member = { stationId: 'alpha_1', role: 'firefighter', is_active: true, employee_number: 'live-9001' };
const token = { stationId: 'alpha_1', role: 'firefighter', emp: 'stale-7' };
const req = (data = {}, uid = 'user.with.dot', claims = token) => ({ auth: { uid, token: claims }, data: {
  request_id: 'fb_request_0001', screen: 'feedback.html', version: '42G.0',
  category: 'problem', rating: 2, text: 'הכפתור לא מגיב', allow_contact: true, ...data
} });
function fixture(seed = {}, clock = () => '2026-09-03T10:00:00.000Z') {
  const db = createFakeFirestore({ 'stations/alpha_1/users/user.with.dot': member,
    'stations/alpha_1/users/user2': member, ...seed });
  return { db, service: createFeedback({ db, FieldValue: db.FieldValue, HttpsError, hash, clock }) };
}
const bad = (code) => (error) => error.code === code;
test('authentication and station-member role are required with no super fallback', async () => {
  const { service, db } = fixture();
  await assert.rejects(service.submit({ data: req().data }), bad('unauthenticated'));
  for (const claims of [{ ...token, stationId: '' }, { ...token, role: '' },
    { super: true, email: 'fire102.shits@gmail.com', stationId: 'alpha_1' }]) {
    await assert.rejects(service.submit(req({}, 'user.with.dot', claims)));
  }
  assert.equal(db.writes.length, 0);
});
test('shape validation rejects hidden identity, invalid values and oversized text without truncation', async () => {
  const { service, db } = fixture();
  for (const patch of [{ stationId: 'beta_2' }, { station_id: 'beta_2' }, { uid: 'other' },
    { category: 'unknown' }, { rating: '2' }, { rating: 6 }, { text: 'ab' }, { text: 'x'.repeat(1001) },
    { allow_contact: 'yes' }, { request_id: 'bad/id' }, { version: 'x'.repeat(25) }, { screen: '../x' }]) {
    await assert.rejects(service.submit(req(patch)), bad('invalid-argument'));
  }
  assert.equal(db.writes.length, 0);
});
test('feedback stores live identity and intentionally preserves personal text', async () => {
  const { db, service } = fixture();
  const text = 'דנה 050-1234567 ביקשה שאחזור אליה';
  const out = await service.submit(req({ text }));
  assert.match(out.id, /^f_[a-f0-9]{40}$/);
  assert.equal(out.duplicate, false);
  const saved = db.read('stations/alpha_1/feedback/' + out.id);
  assert.equal(saved.employee_number, 'live-9001');
  assert.equal(saved.role, member.role);
  assert.equal(saved.uid, 'user.with.dot');
  assert.equal(saved.text, text);
  assert.equal(saved.allow_contact, true);
  assert.match(saved.intent_hash, /^[a-f0-9]{64}$/);
  assert.equal(saved.expires_at, '2026-10-03T10:00:00.000Z');
});
test('same intent and id replay returns exact id without an extra quota or write', async () => {
  const { db, service } = fixture();
  const a = await service.submit(req());
  const writes = db.writes.length;
  const b = await service.submit(req());
  assert.deepEqual(b, { duplicate: true, id: a.id });
  assert.equal(db.writes.length, writes);
  assert.equal(db.read('stations/alpha_1/feedback_quota/user.with.dot_2026-09-03').count, 1);
});
test('every intent field including consent and version is bound to the request id', async () => {
  const { db, service } = fixture();
  await service.submit(req());
  const writes = db.writes.length;
  for (const patch of [{ screen: 'swaps.html' }, { version: '42G.1' }, { category: 'idea' },
    { rating: 3 }, { rating: null }, { text: 'טקסט אחר' }, { allow_contact: false }]) {
    await assert.rejects(service.submit(req(patch)), bad('already-exists'));
  }
  assert.equal(db.writes.length, writes);
});
test('new request id can store a changed consent without replacing prior feedback', async () => {
  const { db, service } = fixture();
  const a = await service.submit(req());
  const b = await service.submit(req({ request_id: 'fb_request_0002', allow_contact: false }));
  assert.notEqual(a.id, b.id);
  assert.equal(db.read('stations/alpha_1/feedback/' + b.id).allow_contact, false);
  assert.equal(db.read('stations/alpha_1/feedback/' + a.id).allow_contact, true);
});
test('request id is scoped to the authenticated uid', async () => {
  const { service } = fixture();
  assert.notEqual((await service.submit(req())).id, (await service.submit(req({}, 'user2'))).id);
});
test('inactivity, moved/conflicting station and role mismatch deny creation and replay', async () => {
  for (const profile of [null, { ...member, active: false }, { ...member, is_active: false },
    { ...member, stationId: 'beta_2' }, { ...member, station_id: 'beta_2' },
    { ...member, role: 'commander' }, { role: 'firefighter' }]) {
    const { db, service } = fixture();
    await service.submit(req());
    db.write('stations/alpha_1/users/user.with.dot', profile);
    const writes = db.writes.length;
    await assert.rejects(service.submit(req()), bad('permission-denied'));
    await assert.rejects(service.submit(req({ request_id: 'fb_request_0002' })), bad('permission-denied'));
    assert.equal(db.writes.length, writes);
  }
});
test('transaction rechecks identity after entry before returning a saved replay', async () => {
  const { db, service } = fixture();
  await service.submit(req());
  const transaction = db.runTransaction.bind(db);
  db.runTransaction = (fn) => {
    db.write('stations/alpha_1/users/user.with.dot', { ...member, active: false });
    return transaction(fn);
  };
  await assert.rejects(service.submit(req()), bad('permission-denied'));
});
test('replay across midnight does not spend quota for the new day', async () => {
  let now = '2026-09-03T23:59:59.000Z';
  const { db, service } = fixture({}, () => now);
  const a = await service.submit(req());
  const expiry = db.read('stations/alpha_1/feedback/' + a.id).expires_at;
  now = '2026-09-04T00:00:01.000Z';
  assert.deepEqual(await service.submit(req()), { id: a.id, duplicate: true });
  assert.equal(db.read('stations/alpha_1/feedback_quota/user.with.dot_2026-09-04'), null);
  await service.markRead({ sid: 'alpha_1', ids: [a.id], by: 'operator' });
  assert.equal(db.read('stations/alpha_1/feedback/' + a.id).expires_at, expiry);
});

test('manual removal deletes exactly one feedback without refunding quota', async () => {
  const { db, service } = fixture();
  const a = await service.submit(req());
  const b = await service.submit(req({ request_id: 'fb_delete_other_0001' }));
  const options = { sid: 'alpha_1', id: a.id, by: 'operator' };
  const before = db.writes.length;
  for (const patch of [{ by: 'codex' }, { sid: '../alpha' }, { id: '../feedback' }, { all: true }]) {
    await assert.rejects(service.remove({ ...options, ...patch }), TypeError);
  }
  await assert.rejects(service.remove({ ...options, sid: 'beta_2' }), /feedback-not-found/);
  assert.equal(db.writes.length, before);
  assert.deepEqual(await service.remove(options), { deleted: true, id: a.id });
  assert.equal(db.read('stations/alpha_1/feedback/' + a.id), null);
  assert.ok(db.read('stations/alpha_1/feedback/' + b.id));
  assert.equal(db.read('stations/alpha_1/feedback_quota/user.with.dot_2026-09-03').count, 2);
  await assert.rejects(service.remove(options), /feedback-not-found/);
});
test('quota and corrupt quota fail closed; exact replay still works at cap', async () => {
  const { db, service } = fixture();
  const first = await service.submit(req());
  const key = 'stations/alpha_1/feedback_quota/user.with.dot_2026-09-03';
  for (const count of [LIMITS.perUserPerDay, '2', -1]) {
    db.write(key, { count });
    const writes = db.writes.length;
    await assert.rejects(service.submit(req({ request_id: 'fb_request_0002' })));
    assert.equal(db.writes.length, writes);
  }
  assert.deepEqual(await service.submit(req()), { id: first.id, duplicate: true });
});
test('list bounds are enforced in query and since filters use the ordered field', async () => {
  let now = '2026-09-01T10:00:00.000Z';
  const { service } = fixture({}, () => now);
  await service.submit(req());
  now = '2026-09-03T10:00:00.000Z';
  const b = await service.submit(req({ request_id: 'fb_request_0002' }));
  assert.deepEqual((await service.list({ sid: 'alpha_1', since: '2026-09-02', limit: 1 })).map((r) => r.id), [b.id]);
  for (const limit of [0, 501, NaN, '3']) await assert.rejects(service.list({ sid: 'alpha_1', limit }), TypeError);
});
test('markRead is idempotent, bounded, and counts only committed changes', async () => {
  const { service } = fixture();
  const a = await service.submit(req());
  assert.deepEqual(await service.markRead({ sid: 'alpha_1', ids: [a.id, a.id], by: 'operator' }), { marked: 1 });
  assert.deepEqual(await service.markRead({ sid: 'alpha_1', ids: [a.id], by: 'operator' }), { marked: 0 });
  await assert.rejects(service.markRead({ sid: 'alpha_1', ids: Array(501).fill(a.id), by: 'operator' }), TypeError);
});
