'use strict';

const assert = require('node:assert/strict');
const { createRegistrationTermsConsentService } = require('./registration-terms-consent-service');

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fixture(request = { status: 'pending' }, customClaims = {}) {
  const uid = 'member1';
  const data = new Map([['registration_requests/' + uid, { ...request }]]);
  let seq = 0;
  const db = {
    doc: path => ({ path }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(ref) {
          assert.equal(writes.length, 0, 'Firestore reads must precede writes');
          return { exists: data.has(ref.path), data: () => data.get(ref.path) };
        },
        set(ref, value, opts) { writes.push(['set', ref.path, value, opts]); },
        create(ref, value) { writes.push(['create', ref.path, value]); },
        update(ref, value) { writes.push(['update', ref.path, value]); }
      };
      const result = await fn(tx);
      for (const [mode, path, value, opts] of writes) {
        if (mode === 'create' && data.has(path)) throw new Error('already exists');
        if (mode === 'update' && !data.has(path)) throw new Error('missing document');
        data.set(path, opts?.merge || mode === 'update' ? { ...data.get(path), ...value } : value);
      }
      return result;
    }
  };
  const handler = createRegistrationTermsConsentService({
    db, auth: { getUser: async requested => ({ uid: requested, disabled: false, emailVerified: true, customClaims }) },
    HttpsError, serverTimestamp: () => 1000 + ++seq, randomId: () => 'fresh_request_id_123456'
  });
  const call = (action, marketing_opt_in, authUid = uid) => handler({
    auth: { uid: authUid }, data: action === 'status' ? { action } : { action, marketing_opt_in }
  });
  return { data, call, handler, uid };
}

async function main() {
  let checks = 0;
  const test = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
  await test('old pending request gets stable id and immutable current receipt', async () => {
    const f = fixture();
    assert.equal((await f.call('status')).accepted, false);
    assert.equal((await f.call('accept', false)).accepted, true);
    const rid = f.data.get('registration_requests/member1').request_id;
    assert.equal(rid, 'fresh_request_id_123456');
    assert.deepEqual(f.data.get('registration_consents/member1/events/' + rid), {
      uid: 'member1', request_id: rid, terms_version: '1.3', privacy_version: '2026-09-24',
      marketing_opt_in: false, accepted_at: 1001, source: 'existing_request_reconsent'
    });
    assert.equal((await f.call('status')).accepted, true);
  });
  await test('same retry succeeds without a second receipt, changed choice is denied', async () => {
    const f = fixture({ status: 'pending', request_id: 'request_id_123456789' });
    await f.call('accept', true);
    assert.equal((await f.call('accept', true)).replayed, true);
    await assert.rejects(f.call('accept', false), e => e.code === 'failed-precondition');
  });
  await test('processing request requires matching active approval operation', async () => {
    const f = fixture({ status: 'processing', request_id: 'request_id_123456789' });
    await assert.rejects(f.call('accept', false), e => e.code === 'failed-precondition');
    f.data.set('identity_operations/member1', { kind: 'approve', status: 'processing', request_id: 'request_id_123456789' });
    assert.equal((await f.call('accept', false)).accepted, true);
  });
  await test('completed or foreign operation is not re-consented', async () => {
    const f = fixture({ status: 'pending', request_id: 'request_id_123456789' });
    f.data.set('identity_operations/member1', { kind: 'approve', status: 'completed' });
    await assert.rejects(f.call('accept', false), e => e.code === 'failed-precondition');
    f.data.set('registration_requests/member1', { status: 'assigned', request_id: 'request_id_123456789' });
    await assert.rejects(f.call('accept', false), e => e.code === 'failed-precondition');
  });
  await test('invalid old receipt and changed current choice fail closed', async () => {
    const f = fixture({ status: 'pending', request_id: 'request_id_123456789', legal_consent: {
      terms_version: '1.3', privacy_version: '2026-09-24', marketing_opt_in: false
    } });
    await assert.rejects(f.call('accept', true), e => e.code === 'failed-precondition');
    f.data.set('registration_consents/member1/events/request_id_123456789', { terms_version: '1.2' });
    await assert.rejects(f.call('accept', false), e => e.code === 'failed-precondition');
  });
  await test('no authentication and malformed choice are denied', async () => {
    const f = fixture();
    await assert.rejects(f.handler({ data: { action: 'accept', marketing_opt_in: false } }), e => e.code === 'unauthenticated');
    await assert.rejects(f.call('accept', 'yes'), e => e.code === 'invalid-argument');
  });
  await test('already approved user explicitly accepts without marketing, receipt and marker are atomic', async () => {
    const f = fixture(null, { emp: '102' });
    assert.equal((await f.call('status')).accepted, false);
    assert.equal((await f.call('accept', false)).accepted, true);
    const receipt = f.data.get('registration_consents/member1/events/terms-v1.3-approved');
    const marker = f.data.get('registration_terms_active/member1');
    assert.equal(receipt.marketing_opt_in, false);
    assert.equal(receipt.terms_version, '1.3');
    assert.equal(marker.receipt_path, 'registration_consents/member1/events/terms-v1.3-approved');
    assert.equal((await f.call('status')).accepted, true);
    assert.equal((await f.call('accept', false)).replayed, true);
    await assert.rejects(f.call('accept', true), e => e.code === 'failed-precondition');
  });
  await test('previous approved 1.3 registration receipt repairs missing marker', async () => {
    const f = fixture(null, { super: true });
    f.data.set('identity_operations/member1', { status: 'completed', request_id: 'request-1' });
    f.data.set('registration_consents/member1/events/request-1', {
      uid: 'member1', request_id: 'request-1', terms_version: '1.3',
      privacy_version: '2026-09-24', marketing_opt_in: true, accepted_at: 99
    });
    assert.equal((await f.call('status')).accepted, true);
    assert.equal(f.data.get('registration_terms_active/member1').receipt_path,
      'registration_consents/member1/events/request-1');
  });
  await test('role change does not erase approval because marker resolves original receipt', async () => {
    const f = fixture(null, { emp: '102', role: 'commander' });
    f.data.set('identity_operations/member1', { status: 'completed', kind: 'assign', request_id: '' });
    f.data.set('registration_consents/member1/events/original-request', {
      uid: 'member1', request_id: 'original-request', terms_version: '1.3',
      privacy_version: '2026-09-24', marketing_opt_in: false, accepted_at: 99
    });
    f.data.set('registration_terms_active/member1', { uid: 'member1', consent_key: '1.3|2026-09-24', terms_version: '1.3',
      privacy_version: '2026-09-24',
      receipt_path: 'registration_consents/member1/events/original-request', activated_at: 100 });
    assert.equal((await f.call('status')).accepted, true);
    assert.equal((await f.call('accept', false)).replayed, true);
  });
  await test('legacy marker is upgraded only after its immutable receipt is verified', async () => {
    const f = fixture(null, { emp: '102' });
    const path = 'registration_consents/member1/events/old-request';
    f.data.set(path, { uid:'member1', request_id:'old-request', terms_version:'1.3',
      privacy_version:'2026-09-24', marketing_opt_in:false, accepted_at:99 });
    f.data.set('registration_terms_active/member1', { uid:'member1', terms_version:'1.3',
      privacy_version:'2026-09-24', receipt_path:path, activated_at:100 });
    assert.equal((await f.call('status')).accepted, true);
    assert.deepEqual(f.data.get('registration_terms_active/member1'), { uid:'member1',
      consent_key:'1.3|2026-09-24', terms_version:'1.3', privacy_version:'2026-09-24',
      receipt_path:path, activated_at:100 });
    await assert.rejects(f.call('accept', true), e => e.code === 'failed-precondition');
  });
  await test('corrupt legacy marker or receipt is never upgraded', async () => {
    const f = fixture(null, { emp:'102' });
    const path = 'registration_consents/member1/events/old-request';
    f.data.set('registration_terms_active/member1', { uid:'member1', terms_version:'1.3',
      privacy_version:'2026-09-24', receipt_path:path, activated_at:100 });
    f.data.set(path, { uid:'member1', request_id:'other-request', terms_version:'1.3',
      privacy_version:'2026-09-24', marketing_opt_in:false, accepted_at:99 });
    await assert.rejects(f.call('status'), e => e.code === 'failed-precondition');
    assert.equal(f.data.get('registration_terms_active/member1').consent_key, undefined);
    f.data.set(path, { uid:'other-user', request_id:'old-request', terms_version:'1.3',
      privacy_version:'2026-09-24', marketing_opt_in:false, accepted_at:99 });
    await assert.rejects(f.call('status'), e => e.code === 'failed-precondition');
    assert.equal(f.data.get('registration_terms_active/member1').consent_key, undefined);
  });
  await test('unapproved and corrupt approved receipts do not activate access', async () => {
    const f = fixture(null);
    await assert.rejects(f.call('accept', false), e => e.code === 'failed-precondition');
    const approved = fixture(null, { emp: '102' });
    approved.data.set('registration_consents/member1/events/terms-v1.3-approved', {
      uid: 'member1', terms_version: '1.2', accepted_at: 100
    });
    await assert.rejects(approved.call('status'), e => e.code === 'failed-precondition');
    assert.equal(approved.data.has('registration_terms_active/member1'), false);
  });
  console.log('registration-terms-consent-service: ' + checks + ' PASS');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
