'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFakeFirestore } = require('./fixtures/fake-firestore');
const { createFeedback, LIMITS } = require('./feedback');

class TestHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const hash = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

function fixture(seed, clock) {
  const db = createFakeFirestore(seed);
  const service = createFeedback({
    db, FieldValue: db.FieldValue, HttpsError: TestHttpsError, hash,
    clock: clock || (() => '2026-09-03T10:00:00.000Z')
  });
  return { db, service };
}
function req(uid, token, data) {
  return { auth: { uid, token }, data: data === undefined ? {} : data };
}
const FF = { stationId: 'alpha_1', role: 'firefighter', emp: '9001' };
function good(over) {
  return Object.assign({
    request_id: 'fb_request_0001', screen: 'swaps.html', version: '42G.0',
    category: 'problem', rating: 2, text: 'הכפתור של ההחלפה לא מגיב בטלפון', allow_contact: true
  }, over || {});
}
async function caught(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}
let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('✓ ' + name); }

(async () => {
  await test('unauthenticated is refused and nothing is written', async () => {
    const { db, service } = fixture();
    const error = await caught(() => service.submit({ auth: null, data: good() }));
    assert.equal(error.code, 'unauthenticated');
    assert.deepEqual(db.keys(), []);
  });

  await test('a client-sent stationId is refused', async () => {
    const { service } = fixture();
    const error = await caught(() => service.submit(req('u1', FF, good({ stationId: 'beta_2' }))));
    assert.equal(error.code, 'invalid-argument');
  });

  await test('shape is enforced: category, rating, text length, request id, allow_contact', async () => {
    const { service } = fixture();
    const bad = [
      { category: 'rant' }, { rating: 6 }, { rating: 0 }, { rating: 'x' }, { text: 'ok' },
      { text: 7 }, { request_id: 'short' }, { request_id: 'has space here' },
      { allow_contact: 'yes' }, { screen: 'x' }, { extra: 1 }
    ];
    for (const patch of bad) {
      const error = await caught(() => service.submit(req('u1', FF, good(patch))));
      assert.equal(error && error.code, 'invalid-argument', JSON.stringify(patch));
    }
  });

  await test('a submission is stored with the writer identity — this is the decision', async () => {
    const { db, service } = fixture();
    const out = await service.submit(req('u1', FF, good()));
    assert.equal(out.duplicate, false);
    const doc = db.read('stations/alpha_1/feedback/' + out.id);
    assert.equal(doc.uid, 'u1');
    assert.equal(doc.role, 'firefighter');
    assert.equal(doc.employee_number, '9001');
    assert.equal(doc.category, 'problem');
    assert.equal(doc.rating, 2);
    assert.equal(doc.text, good().text);
    assert.equal(doc.allow_contact, true);
    assert.equal(doc.status, 'new');
    assert.equal(doc.read_at, null);
  });

  await test('the text is stored as written — no scrubbing of what a person said', async () => {
    const { db, service } = fixture();
    const text = 'דנה 050-1234567 אמרה שהמסך לא נטען';
    const out = await service.submit(req('u1', FF, good({ text })));
    assert.equal(db.read('stations/alpha_1/feedback/' + out.id).text, text);
  });

  await test('rating is optional and stored as null when absent', async () => {
    const { db, service } = fixture();
    const out = await service.submit(req('u1', FF, good({ rating: undefined })));
    assert.equal(db.read('stations/alpha_1/feedback/' + out.id).rating, null);
  });

  await test('the same request twice is one document and a duplicate reply', async () => {
    const { db, service } = fixture();
    const a = await service.submit(req('u1', FF, good()));
    const b = await service.submit(req('u1', FF, good({ text: 'טקסט אחר באותה בקשה' })));
    assert.equal(b.duplicate, true);
    assert.equal(a.id, b.id);
    assert.equal(db.keys().filter((k) => k.indexOf('/feedback/') > -1).length, 1);
    assert.equal(db.read('stations/alpha_1/feedback_quota/u1_2026-09-03').count, 1);
  });

  await test('the same request id from another user is a different document', async () => {
    const { db, service } = fixture();
    await service.submit(req('u1', FF, good()));
    await service.submit(req('u2', FF, good()));
    assert.equal(db.keys().filter((k) => k.indexOf('/feedback/') > -1).length, 2);
  });

  await test('the daily quota per user is enforced and the refusal writes nothing', async () => {
    const { db, service } = fixture({
      'stations/alpha_1/feedback_quota/u1_2026-09-03': { uid: 'u1', day: '2026-09-03', count: LIMITS.perUserPerDay }
    });
    const error = await caught(() => service.submit(req('u1', FF, good())));
    assert.equal(error.code, 'resource-exhausted');
    assert.equal(db.keys().filter((k) => k.indexOf('/feedback/') > -1).length, 0);
    // ומשתמש אחר אינו מוגבל על ידי המכסה של הראשון.
    const other = await service.submit(req('u2', FF, good()));
    assert.equal(other.duplicate, false);
  });

  await test('list returns newest first and honours since', async () => {
    const { db } = fixture();
    const early = createFeedback({ db, FieldValue: db.FieldValue, HttpsError: TestHttpsError, hash, clock: () => '2026-09-01T10:00:00.000Z' });
    const late = createFeedback({ db, FieldValue: db.FieldValue, HttpsError: TestHttpsError, hash, clock: () => '2026-09-03T10:00:00.000Z' });
    const a = await early.submit(req('u1', FF, good({ request_id: 'fb_request_0001' })));
    const b = await late.submit(req('u1', FF, good({ request_id: 'fb_request_0002' })));
    const rows = await late.list({ sid: 'alpha_1' });
    assert.deepEqual(rows.map((r) => r.id), [b.id, a.id]);
    const recent = await late.list({ sid: 'alpha_1', since: '2026-09-02' });
    assert.deepEqual(recent.map((r) => r.id), [b.id]);
  });

  await test('markRead stamps a label, is idempotent, and ignores malformed ids', async () => {
    const { db, service } = fixture();
    const a = await service.submit(req('u1', FF, good()));
    const first = await service.markRead({ sid: 'alpha_1', ids: [a.id, '../x', 'f_zz'], by: 'claude' });
    assert.equal(first.marked, 1);
    const doc = db.read('stations/alpha_1/feedback/' + a.id);
    assert.equal(doc.status, 'read');
    assert.equal(doc.read_by, 'claude');
    const again = await service.markRead({ sid: 'alpha_1', ids: [a.id], by: 'codex' });
    assert.equal(again.marked, 0);
    assert.equal(db.read('stations/alpha_1/feedback/' + a.id).read_by, 'claude');
    const bad = await caught(() => service.markRead({ sid: 'alpha_1', ids: [a.id], by: 'u1@x.co' }));
    assert.ok(bad instanceof TypeError);
  });

  console.log('\n' + passed + ' feedback checks passed.');
  console.log('  לא נבדק כאן: Firestore אמיתי, TTL בפועל, וכללי הגישה — אלה דורשים אמולטור ופריסה.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
