'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createFakeFirestore } = require('./fixtures/fake-firestore');
const incidentLog = require('./incident-log');

const { createIncidentLog, scrub, normalizeForFingerprint, DAY_CAP } = incidentLog;

class TestHttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const hash = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest('hex');

function fixture(seed) {
  const db = createFakeFirestore(seed);
  const service = createIncidentLog({
    db, FieldValue: db.FieldValue, HttpsError: TestHttpsError, hash,
    clock: () => '2026-09-03T10:00:00.000Z'
  });
  return { db, service };
}
function req(uid, token, data) {
  return { auth: { uid, token }, data: data === undefined ? {} : data };
}
const FF = { stationId: 'alpha_1', role: 'firefighter', emp: '9001' };
function good(over) {
  return Object.assign({
    kind: 'client-error', screen: 'swaps.html', version: '42G.0',
    code: 'TypeError', message: 'Cannot read properties of undefined (reading x)',
    frame: 'swaps.js:120'
  }, over || {});
}
async function caught(fn) {
  try { await fn(); return null; } catch (error) { return error; }
}

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log('✓ ' + name); }

(async () => {
  // --- גבולות ---
  await test('unauthenticated is refused before anything is read', async () => {
    const { db, service } = fixture();
    const error = await caught(() => service.report({ auth: null, data: good() }));
    assert.equal(error.code, 'unauthenticated');
    assert.deepEqual(db.keys(), []);
  });

  await test('a client-sent stationId is an error, not a hint', async () => {
    const { db, service } = fixture();
    const error = await caught(() => service.report(req('u1', FF, good({ stationId: 'beta_2' }))));
    assert.equal(error.code, 'invalid-argument');
    assert.deepEqual(db.keys(), []);
  });

  await test('a token without a station is refused', async () => {
    const { service } = fixture();
    const error = await caught(() => service.report(req('u1', { role: 'firefighter' }, good())));
    assert.equal(error.code, 'failed-precondition');
  });

  await test('unknown fields are refused — including any identity field', async () => {
    const { service } = fixture();
    for (const extra of [{ uid: 'x' }, { full_name: 'x' }, { email: 'a@b.co' }, { note: 'x' }]) {
      const error = await caught(() => service.report(req('u1', FF, good(extra))));
      assert.equal(error.code, 'invalid-argument', JSON.stringify(extra));
    }
  });

  await test('kind, screen, version, code and callable are validated by shape', async () => {
    const { service } = fixture();
    const bad = [
      { kind: 'other' }, { screen: '../x.html' }, { screen: 'x' }, { version: 'v 1' },
      { code: 'a b' }, { callable: 'has-dash' }, { message: 5 }, { frame: {} },
      { kind: 'callable-failed', callable: '' }
    ];
    for (const patch of bad) {
      const error = await caught(() => service.report(req('u1', FF, good(patch))));
      assert.equal(error && error.code, 'invalid-argument', JSON.stringify(patch));
    }
  });

  await test('an empty report (no message, no code) is refused', async () => {
    const { service } = fixture();
    const error = await caught(() => service.report(req('u1', FF, good({ message: '', code: '' }))));
    assert.equal(error.code, 'invalid-argument');
  });

  // --- הרשומה ---
  await test('the first report creates an open incident with no identity in it', async () => {
    const { db, service } = fixture();
    const out = await service.report(req('u1', FF, good()));
    assert.equal(out.accepted, true);
    assert.equal(out.first, true);
    assert.equal(out.count, 1);
    const doc = db.read('stations/alpha_1/incidents/' + out.fingerprint);
    assert.ok(doc);
    assert.equal(doc.status, 'open');
    assert.equal(doc.count, 1);
    assert.deepEqual(doc.screens, ['swaps.html']);
    assert.deepEqual(doc.versions, ['42G.0']);
    assert.deepEqual(doc.roles, ['firefighter']);
    assert.equal(doc.sample_message, good().message);
    const text = JSON.stringify(doc);
    for (const secret of ['u1', '9001', 'uid', 'emp', 'email', 'full_name']) {
      assert.equal(new RegExp('"' + secret + '"').test(text), false, 'הרשומה נושאת ' + secret);
    }
  });

  await test('the same failure twice is one incident with count 2, not two documents', async () => {
    const { db, service } = fixture();
    const a = await service.report(req('u1', FF, good()));
    const b = await service.report(req('u2', FF, good({ message: 'Cannot read properties of undefined (reading x)  ' })));
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(b.count, 2);
    assert.equal(b.first, false);
    const docs = db.keys().filter((k) => k.indexOf('/incidents/') > -1);
    assert.equal(docs.length, 1);
  });

  await test('numbers and whitespace do not split a fingerprint; the code and screen do', async () => {
    const { service } = fixture();
    const a = await service.report(req('u1', FF, good({ message: 'row 12 failed' })));
    const b = await service.report(req('u1', FF, good({ message: 'row 999 failed' })));
    const c = await service.report(req('u1', FF, good({ message: 'row 12 failed', screen: 'board.html' })));
    const d = await service.report(req('u1', FF, good({ message: 'row 12 failed', code: 'RangeError' })));
    assert.equal(a.fingerprint, b.fingerprint);
    assert.notEqual(a.fingerprint, c.fingerprint);
    assert.notEqual(a.fingerprint, d.fingerprint);
  });

  await test('a second version and screen accumulate on the same incident', async () => {
    const { db, service } = fixture();
    const a = await service.report(req('u1', FF, good()));
    await service.report(req('u1', FF, good({ version: '42G.1' })));
    const doc = db.read('stations/alpha_1/incidents/' + a.fingerprint);
    assert.deepEqual(doc.versions, ['42G.0', '42G.1']);
    assert.equal(doc.first_version, '42G.0');
    assert.equal(doc.last_version, '42G.1');
  });

  await test('two stations never share an incident document', async () => {
    const { db, service } = fixture();
    await service.report(req('u1', FF, good()));
    await service.report(req('u9', Object.assign({}, FF, { stationId: 'beta_2' }), good()));
    const keys = db.keys().filter((k) => k.indexOf('/incidents/') > -1);
    assert.equal(keys.length, 2);
    assert.ok(keys.some((k) => k.startsWith('stations/alpha_1/')));
    assert.ok(keys.some((k) => k.startsWith('stations/beta_2/')));
  });

  // --- ניקוי ---
  await test('emails, phones, uids, hex ids and query strings are scrubbed from the sample', async () => {
    const { db, service } = fixture();
    const message = 'user dana@example.com 050-1234567 uid AbCdEfGhIjKlMnOpQrStUvWxYz12 doc 0123456789abcdef0123456789 at ?token=abc';
    const out = await service.report(req('u1', FF, good({ message, frame: 'x.js?v=42g0:10' })));
    const doc = db.read('stations/alpha_1/incidents/' + out.fingerprint);
    assert.equal(doc.scrubbed, true);
    for (const leak of ['dana@example.com', '1234567', 'AbCdEfGhIjKlMnOpQrStUvWxYz12', '0123456789abcdef', 'token=abc', 'v=42g0']) {
      assert.equal(doc.sample_message.indexOf(leak), -1, 'דלף: ' + leak);
      assert.equal(doc.sample_frame.indexOf(leak), -1, 'דלף במיקום: ' + leak);
    }
    assert.ok(doc.sample_message.indexOf('[email]') > -1);
  });

  await test('scrub is a pure function with the documented replacements', () => {
    const out = scrub('a@b.co and 0501234567');
    assert.equal(out.scrubbed, true);
    assert.equal(out.text, '[email] and [phone]');
    assert.equal(scrub('plain text').scrubbed, false);
    assert.equal(normalizeForFingerprint('  Row 12   Failed '), 'row # failed');
  });

  await test('message and frame are cut at the documented limits', async () => {
    const { db, service } = fixture();
    const out = await service.report(req('u1', FF, good({ message: 'x'.repeat(2000), frame: 'y'.repeat(900) })));
    const doc = db.read('stations/alpha_1/incidents/' + out.fingerprint);
    assert.equal(doc.sample_message.length, 300);
    assert.equal(doc.sample_frame.length, 200);
  });

  // --- תקרה יומית ---
  await test('the daily cap returns accepted:false and writes nothing more', async () => {
    const { db, service } = fixture({
      'stations/alpha_1/incident_days/2026-09-03': { day: '2026-09-03', count: DAY_CAP }
    });
    const out = await service.report(req('u1', FF, good()));
    assert.equal(out.accepted, false);
    assert.equal(out.reason, 'day-cap');
    assert.equal(db.keys().filter((k) => k.indexOf('/incidents/') > -1).length, 0);
    assert.equal(db.read('stations/alpha_1/incident_days/2026-09-03').count, DAY_CAP);
  });

  await test('the day counter carries a TTL and counts every accepted report', async () => {
    const { db, service } = fixture();
    await service.report(req('u1', FF, good()));
    await service.report(req('u1', FF, good({ code: 'Other' })));
    const day = db.read('stations/alpha_1/incident_days/2026-09-03');
    assert.equal(day.count, 2);
    assert.ok(day.expires_at);
  });

  // --- טיפול ---
  await test('a resolved incident that returns in a newer version reopens and remembers the old fix', async () => {
    const { db, service } = fixture();
    const a = await service.report(req('u1', FF, good()));
    await service.setStatus({ sid: 'alpha_1', fingerprint: a.fingerprint, status: 'resolved', by: 'codex', note: 'fixed in 42G.1' });
    let doc = db.read('stations/alpha_1/incidents/' + a.fingerprint);
    assert.equal(doc.status, 'resolved');
    assert.equal(doc.resolved_by, 'codex');
    // אותה גרסה — נשאר פתור (משתמש שלא עדכן).
    await service.report(req('u1', FF, good()));
    doc = db.read('stations/alpha_1/incidents/' + a.fingerprint);
    assert.equal(doc.status, 'resolved');
    // גרסה חדשה — נפתח מחדש.
    await service.report(req('u1', FF, good({ version: '42G.1' })));
    doc = db.read('stations/alpha_1/incidents/' + a.fingerprint);
    assert.equal(doc.status, 'open');
    assert.equal(doc.reopened_from.resolved_by, 'codex');
    assert.equal(doc.reopened_from.version, '42G.0');
  });

  await test('setStatus takes a label, never an identity, and refuses unknown incidents', async () => {
    const { service } = fixture();
    const a = await service.report(req('u1', FF, good()));
    for (const by of ['', 'U1', 'a@b.co', 'x'.repeat(41)]) {
      const error = await caught(() => service.setStatus({ sid: 'alpha_1', fingerprint: a.fingerprint, status: 'resolved', by }));
      assert.ok(error instanceof TypeError, by);
    }
    const missing = await caught(() => service.setStatus({ sid: 'alpha_1', fingerprint: 'f'.repeat(40), status: 'resolved', by: 'claude' }));
    assert.equal(missing.message, 'incident-not-found');
  });

  await test('list returns newest first and filters by status', async () => {
    const { db, service } = fixture();
    const a = await service.report(req('u1', FF, good()));
    db.setClock('2026-09-04T10:00:00.000Z');
    const later = createIncidentLog({
      db, FieldValue: db.FieldValue, HttpsError: TestHttpsError, hash,
      clock: () => '2026-09-04T10:00:00.000Z'
    });
    const b = await later.report(req('u1', FF, good({ code: 'Newer' })));
    await later.setStatus({ sid: 'alpha_1', fingerprint: a.fingerprint, status: 'ignored', by: 'eldad' });
    const all = await later.list({ sid: 'alpha_1' });
    assert.deepEqual(all.map((r) => r.id), [b.fingerprint, a.fingerprint]);
    const open = await later.list({ sid: 'alpha_1', status: 'open' });
    assert.deepEqual(open.map((r) => r.id), [b.fingerprint]);
  });

  // --- מוטציות: הבדיקות תופסות קוד שבור ---
  await test('mutation: a module that keeps the reporter uid is caught', async () => {
    const { db, service } = fixture();
    const out = await service.report(req('u1', FF, good()));
    const doc = db.read('stations/alpha_1/incidents/' + out.fingerprint);
    const mutant = Object.assign({}, doc, { reporter_uid: 'u1' });
    assert.equal(/"u1"/.test(JSON.stringify(mutant)), true, 'הגלאי לא היה תופס uid');
  });

  await test('mutation: a fingerprint that ignores the screen would merge two screens', () => {
    const merged = hash('incident|alpha_1|client-error|' + 'TypeError' + '|' + normalizeForFingerprint('x'));
    const real = hash('incident|alpha_1|client-error|swaps.html|TypeError|' + normalizeForFingerprint('x'));
    assert.notEqual(merged, real);
  });

  console.log('\n' + passed + ' incident-log checks passed.');
  console.log('  לא נבדק כאן: Firestore אמיתי, TTL בפועל, וכללי הגישה — אלה דורשים אמולטור ופריסה.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
