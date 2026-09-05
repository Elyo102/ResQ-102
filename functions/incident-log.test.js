'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFakeFirestore } = require('./fixtures/fake-firestore');
const { createIncidentLog, DAY_CAP, safeIncident, LIMITS } = require('./incident-log');
const catalog = require('./ops-telemetry-contract');
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const member = { stationId: 'alpha_1', role: 'firefighter', is_active: true, employee_number: '9001' };
const req = (data = {}, extra = {}) => ({ auth: { uid: 'user.with.dot', token: { ...member, ...extra } },
  data: { kind: 'client-error', screen: 'swaps.html', version: '42G.0', code: 'TypeError', callable: 'unknown', ...data } });
function fixture(seed = {}, withProfile = true) {
  const db = createFakeFirestore({
    ...(withProfile ? { 'stations/alpha_1/users/user.with.dot': member } : {}),
    ...seed
  });
  const service = createIncidentLog({ db, FieldValue: db.FieldValue, HttpsError, hash, clock: () => '2026-09-03T10:00:00.000Z' });
  return { db, service };
}
const bad = (code) => (error) => error.code === code;

test('caller must authenticate with a canonical station; email and role cannot impersonate super', async () => {
  const { db, service } = fixture();
  await assert.rejects(service.report({ data: req().data }), bad('unauthenticated'));
  for (const extra of [{ stationId: '' }, { stationId: '../alpha' }, { role: '' },
    { role: 'super_admin', super: false },
    { role: '', super: false, email: 'fire102.shits@gmail.com' }]) {
    await assert.rejects(service.report(req({}, extra)));
  }
  assert.equal(db.writes.length, 0);
});
test('verified super uses only the signed station and works without a live profile or member role', async () => {
  const { db, service } = fixture({}, false);
  const claims = { stationId: 'alpha_1', role: '', super: true, email: 'ordinary@example.invalid' };
  const out = await service.report(req({}, claims));
  assert.equal(out.accepted, true);
  const path = 'stations/alpha_1/incidents/' + out.fingerprint;
  assert.deepEqual(db.read(path).roles, ['super_admin']);
  assert.equal(db.keys().some((key) => key.startsWith('stations/beta_2/')), false);
  await assert.rejects(service.report(req({ stationId: 'beta_2' }, claims)), bad('invalid-argument'));
  await assert.rejects(service.report(req({}, { ...claims, stationId: '' })), bad('failed-precondition'));
});
test('verified super remains subject to the station daily incident cap', async () => {
  const day = 'stations/alpha_1/incident_days/2026-09-03';
  const { db, service } = fixture({ [day]: { count: DAY_CAP } }, false);
  const out = await service.report(req({}, { stationId: 'alpha_1', role: '', super: true }));
  assert.deepEqual(out, { accepted: false, reason: 'day-cap', fingerprint: out.fingerprint });
  assert.equal(db.writes.length, 0);
});
test('valid dotted UID produces finite incident with no identity', async () => {
  const { db, service } = fixture();
  const out = await service.report(req());
  assert.equal(out.accepted, true);
  assert.equal(out.count, 1);
  const doc = db.read('stations/alpha_1/incidents/' + out.fingerprint);
  for (const text of ['user.with.dot', '9001', 'employee_number', 'sample_message', 'last_message', 'last_frame']) {
    assert.equal(JSON.stringify(doc).includes(text), false);
  }
  assert.equal(doc.code, 'TypeError');
  assert.equal(doc.schema_version, 2);
  assert.equal(Object.hasOwn(doc, 'expires_at'), false);
});
test('no live card, inactivity, contradictory stations and changed live role all deny writes', async () => {
  for (const profile of [null, { ...member, active: false }, { ...member, is_active: false },
    { ...member, stationId: 'beta_2' }, { ...member, station: 'beta_2' }, { role: 'firefighter' },
    { ...member, role: 'commander' }]) {
    const { db, service } = fixture({ 'stations/alpha_1/users/user.with.dot': profile });
    await assert.rejects(service.report(req()), bad('permission-denied'));
    assert.equal(db.writes.length, 0);
  }
});
test('raw message/frame/note, client identity and station aliases are rejected, not scrubbed', async () => {
  const { db, service } = fixture();
  for (const key of ['message', 'frame', 'note', 'uid', 'employee_number', 'stationId', 'station_id', 'extra']) {
    await assert.rejects(service.report(req({ [key]: 'דנה user.with.dot 050-1234567 מחלה' })), bad('invalid-argument'));
  }
  assert.equal(db.writes.length, 0);
});
test('every metadata field maps arbitrary PII to finite unknown; kinds reject unknown', async () => {
  const { db, service } = fixture();
  for (const field of ['screen', 'version', 'code', 'callable']) {
    for (const value of ['דנה', 'user.with.dot', 'person@example.com', '0501234567', 'private.html',
      '<script>alert(1)</script>', { private: 'דנה' }]) {
      const out = await service.report(req({ [field]: value }));
      const doc = db.read('stations/alpha_1/incidents/' + out.fingerprint);
      assert.equal(JSON.stringify(doc).includes(typeof value === 'string' ? value : 'דנה'), false);
    }
  }
  await assert.rejects(service.report(req({ kind: 'דנה' })), bad('invalid-argument'));
});
test('fingerprint includes screen and callable but not free text or reporter identity', () => {
  const { service } = fixture();
  const a = service.planIncident('alpha_1', 'firefighter', req().data);
  const b = service.planIncident('alpha_1', 'commander', req().data);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, service.planIncident('alpha_1', 'firefighter', req({ screen: 'forms.html' }).data).fingerprint);
  assert.notEqual(a.fingerprint, service.planIncident('alpha_1', 'firefighter', req({ callable: 'submitFeedback' }).data).fingerprint);
});
test('aggregation increments transactionally and has bounded finite arrays', async () => {
  const { db, service } = fixture();
  const first = await service.report(req());
  const ref = 'stations/alpha_1/incidents/' + first.fingerprint;
  db.write(ref, { ...db.read(ref), screens: [...catalog.SCREENS, 'דנה'],
    versions: ['private', ...catalog.VERSIONS], roles: ['private', 'firefighter'], secret: 'דנה' });
  const next = await service.report(req());
  const doc = db.read(ref);
  assert.equal(next.count, 2);
  assert.equal(next.first, false);
  assert.ok(doc.screens.length <= LIMITS.screensPerIncident);
  assert.ok(doc.versions.every((v) => catalog.VERSIONS.includes(v)));
  assert.equal(JSON.stringify(doc).includes('דנה'), false);
  assert.equal('secret' in doc, false);
});
test('day cap and corrupt quota are fail closed with no partial write', async () => {
  for (const quota of [DAY_CAP, -1, '2', null]) {
    const { db, service } = fixture({ 'stations/alpha_1/incident_days/2026-09-03': { count: quota } });
    if (quota === DAY_CAP) assert.equal((await service.report(req())).reason, 'day-cap');
    else await assert.rejects(service.report(req()), bad('failed-precondition'));
    assert.equal(db.writes.length, 0);
  }
});
test('even cap response validates live membership first', async () => {
  const { service } = fixture({ 'stations/alpha_1/incident_days/2026-09-03': { count: DAY_CAP },
    'stations/alpha_1/users/user.with.dot': { ...member, active: false } });
  await assert.rejects(service.report(req()), bad('permission-denied'));
});
test('identity is read inside the transaction, not only before it', async () => {
  const { db, service } = fixture();
  const transaction = db.runTransaction.bind(db);
  db.runTransaction = (fn) => {
    db.write('stations/alpha_1/users/user.with.dot', { ...member, active: false });
    return transaction(fn);
  };
  await assert.rejects(service.report(req()), bad('permission-denied'));
  assert.equal(db.writes.length, 0);
});
test('status accepts finite note code/handler, not arbitrary note or personal label', async () => {
  const { db, service } = fixture();
  const out = await service.report(req());
  const options = { sid: 'alpha_1', fingerprint: out.fingerprint, status: 'resolved', by: 'operator', note_code: 'fixed' };
  for (const patch of [{ note: 'דנה מחלה' }, { by: 'eldad' }, { note_code: 'דנה' }, { status: 'private' }]) {
    await assert.rejects(service.setStatus({ ...options, ...patch }), TypeError);
  }
  const ref = 'stations/alpha_1/incidents/' + out.fingerprint;
  db.write(ref, { ...db.read(ref), expires_at: '2020-01-01T00:00:00.000Z' });
  await service.setStatus(options);
  assert.equal(db.read('stations/alpha_1/incidents/' + out.fingerprint).note_code, 'fixed');
  assert.equal(Object.hasOwn(db.read(ref), 'expires_at'), false);
  assert.equal((await service.report(req())).count, 2);
  assert.equal(db.read('stations/alpha_1/incidents/' + out.fingerprint).status, 'resolved');
  await service.report(req({ version: 'unknown' }));
  assert.equal(db.read('stations/alpha_1/incidents/' + out.fingerprint).status, 'open');
  assert.equal(Object.hasOwn(db.read(ref), 'expires_at'), false);
});

test('manual deletion requires resolved state and the exact reviewed version', async () => {
  const { db, service } = fixture();
  const out = await service.report(req());
  const other = await service.report(req({ code: 'ReferenceError' }));
  const path = 'stations/alpha_1/incidents/' + out.fingerprint;
  const options = { sid: 'alpha_1', fingerprint: out.fingerprint, by: 'operator', expected_count: 1,
    expected_last_seen_iso: '2026-09-03T10:00:00.000Z', expected_resolved_at: '2026-09-03T10:00:00.000Z' };
  await assert.rejects(service.removeResolved(options), /incident-not-resolved/);
  await service.setStatus({ sid: 'alpha_1', fingerprint: out.fingerprint, status: 'ignored', by: 'operator' });
  await assert.rejects(service.removeResolved(options), /incident-not-resolved/);
  await service.setStatus({ sid: 'alpha_1', fingerprint: out.fingerprint, status: 'resolved', by: 'operator' });
  for (const patch of [{ expected_count: 2 }, { expected_last_seen_iso: '2026-09-02T10:00:00.000Z' },
    { expected_resolved_at: '2026-09-02T10:00:00.000Z' }]) {
    await assert.rejects(service.removeResolved({ ...options, ...patch }), /incident-changed/);
  }
  for (const patch of [{ by: 'claude' }, { sid: '../alpha' }, { fingerprint: {} }, { expected_count: '1' },
    { expected_last_seen_iso: 'bad' }, { extra: true }]) {
    await assert.rejects(service.removeResolved({ ...options, ...patch }), TypeError);
  }
  await service.report(req()); // Same-version recurrence increments count even if still marked resolved.
  await assert.rejects(service.removeResolved(options), /incident-changed/);
  assert.ok(db.read(path));
  assert.deepEqual(await service.removeResolved({ ...options, expected_count: 2 }),
    { deleted: true, fingerprint: out.fingerprint });
  assert.equal(db.read(path), null);
  assert.ok(db.read('stations/alpha_1/incidents/' + other.fingerprint));
  assert.equal(db.read('stations/alpha_1/incident_days/2026-09-03').count, 3);
  await assert.rejects(service.removeResolved(options), /incident-not-found/);
});

test('a new report strips a legacy expiry rather than extending it', async () => {
  const { db, service } = fixture();
  const out = await service.report(req());
  const path = 'stations/alpha_1/incidents/' + out.fingerprint;
  db.write(path, { ...db.read(path), expires_at: '2020-01-01T00:00:00.000Z' });
  await service.report(req());
  assert.equal(Object.hasOwn(db.read(path), 'expires_at'), false);
});
test('safe projection excludes legacy raw fields and arbitrary nested metadata', () => {
  const out = safeIncident('f'.repeat(40), { code: 'דנה', note: 'דנה', sample_message: 'דנה',
    resolved_by: 'דנה', screens: ['דנה'], roles: ['דנה'], reopened_from: { private: 'דנה' } });
  assert.equal(JSON.stringify(out).includes('דנה'), false);
});
test('list uses bounded newest page and projects all stored fields safely', async () => {
  const { db, service } = fixture();
  const a = await service.report(req());
  await service.report(req({ code: 'ReferenceError' }));
  const ref = 'stations/alpha_1/incidents/' + a.fingerprint;
  db.write(ref, { ...db.read(ref), message: 'דנה', note: 'דנה', reporter_uid: 'private' });
  const rows = await service.list({ sid: 'alpha_1', limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes('דנה'), false);
  for (const limit of [0, -1, 501, Infinity, '5']) await assert.rejects(service.list({ sid: 'alpha_1', limit }), TypeError);
});
