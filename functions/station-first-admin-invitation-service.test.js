'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const sdkRequire = require('node:module').createRequire(path.resolve(__dirname, './package.json'));
const { Firestore } = sdkRequire('firebase-admin/firestore');
const { createInvitations } = require('./invitations');
const provisionContract = require('./station-provision-contract');
const { createStationFirstAdminInvitationService } = require('./station-first-admin-invitation-service');
const sdk = new Firestore({ projectId: 'demo-resq-first-admin' });
const fixed = { request_id: 'provision_000000001', station_id: 'station_test', district_id: 'south', display_name: 'Test Station',
  timezone: 'Asia/Jerusalem', template_id: 'fire-station-v1', actor_uid: 'super_1' };
function fixture() {
  const plan = provisionContract.planStationProvision(fixed), store = new Map(), writes = [];
  const stationPath = 'stations/station_test', opPath = stationPath + '/provision_operations/' + fixed.request_id;
  store.set(stationPath, { ...plan.station_doc });
  store.set(opPath, { schema_version: 1, station_id: plan.station_id, request_id: plan.request_id, actor_uid: fixed.actor_uid,
    fingerprint: plan.fingerprint, result_status: 'provisioning', first_admin_invitation_intent: { ...plan.first_admin_invitation_intent } });
  const control = { calls: 0, retry: false, denyAt: 0, beforeTx: null, failCommit: false };
  const snapshot = ref => ({ exists: store.has(ref.path), data: () => structuredClone(store.get(ref.path)) });
  const db = { doc(p) { const ref = sdk.doc(p); return { path: ref.path, get: async () => snapshot(ref) }; },
    async runTransaction(fn) {
      if (control.beforeTx) control.beforeTx();
      async function attempt(commit) {
        const staged = []; let written = false;
        const tx = { async get(ref) { assert.equal(written, false, 'all reads precede writes'); return snapshot(ref); },
          create(ref, data) { written = true; staged.push({ path: ref.path, data, create: true }); },
          set(ref, data, options) { written = true; staged.push({ path: ref.path, data, merge: options?.merge }); } };
        const result = await fn(tx);
        if (commit) {
          if (control.failCommit) throw Error('synthetic commit failure');
          for (const entry of staged) if (entry.create && store.has(entry.path)) throw Error('already exists');
          for (const entry of staged) { store.set(entry.path, structuredClone(entry.merge ? { ...store.get(entry.path), ...entry.data } : entry.data)); writes.push(entry.path); }
        }
        return result;
      }
      if (control.retry) await attempt(false);
      return attempt(true);
    } };
  let randomCalls = 0;
  const engine = createInvitations({ clock: () => 1790000000000, randomBytes(n) { randomCalls++; return crypto.randomBytes(n); },
    createHash: s => crypto.createHash('sha256').update(s).digest('hex'), timingSafeEqual: crypto.timingSafeEqual,
    assertMayAssign(gate, role) { assert.equal(gate.cap, Infinity); assert.equal(role, 'commander'); }, withinRoleSetterScope: () => true });
  const service = createStationFirstAdminInvitationService({ db, invitations: engine, provisionContract,
    async requireSuperAdmin(req) { control.calls++; if (!req.auth || req.auth.uid !== 'super_1' || control.calls === control.denyAt) throw Error('denied'); return { uid: req.auth.uid }; },
    fail(code, message, reason) { throw Object.assign(Error(message), { code, reason }); } });
  const req = { auth: { uid: 'super_1' }, data: { station_id: plan.station_id, provision_request_id: plan.request_id,
    request_id: 'issue_request_000001', full_name: 'Test Admin', email: 'ADMIN@example.test', phone: '', shift: 'A' } };
  return { service, req, store, writes, control, stationPath, opPath, randomCalls: () => randomCalls, engine };
}
test('actual engine issue atomically binds exact association, secret only returned once', async () => {
  const f = fixture(), result = await f.service.issueFirstAdminInvitation(f.req);
  assert.equal(result.secret_available, true); assert.equal(result.replayed, false); assert.ok(result.secret);
  const op = f.store.get(f.opPath), invite = f.store.get('invitations/' + result.invite_id);
  assert.deepEqual(Object.keys(op.first_admin_invitation).sort(), ['schema_version','station_id','provision_request_id','invite_id','invite_fingerprint'].sort());
  assert.equal(op.first_admin_invitation_request_id, f.req.data.request_id);
  assert.equal(invite.role, 'commander'); assert.equal(invite.email, 'admin@example.test');
  assert.equal(JSON.stringify([...f.store.values()]).includes(result.secret), false);
  assert.equal(f.engine.verifyStoredFingerprint(invite, op.first_admin_invitation.invite_fingerprint), true);
  const before = f.writes.length, replay = await f.service.issueFirstAdminInvitation(f.req);
  assert.deepEqual(replay, { ok: true, replayed: true, invite_id: result.invite_id, secret_available: false });
  assert.equal(f.writes.length, before); assert.equal(f.store.get(f.stationPath).silent, true);
});
test('transaction retry reuses one candidate and commits only one invitation', async () => {
  const f = fixture(); f.control.retry = true;
  await f.service.issueFirstAdminInvitation(f.req); assert.equal(f.randomCalls(), 2); assert.equal(f.writes.length, 2);
});
test('commit failure does not persist invitation or association', async () => {
  const f = fixture(); f.control.failCommit = true;
  await assert.rejects(f.service.issueFirstAdminInvitation(f.req)); assert.equal(f.writes.length, 0);
  assert.equal('first_admin_invitation' in f.store.get(f.opPath), false);
});
for (const key of ['request_id','full_name','email','phone','shift']) test('changed replay intent rejected: ' + key, async () => {
  const f = fixture(); await f.service.issueFirstAdminInvitation(f.req);
  f.req.data[key] = { request_id: 'issue_request_000002', full_name: 'Other Admin', email: 'other@example.test', phone: '123', shift: 'B' }[key];
  await assert.rejects(f.service.issueFirstAdminInvitation(f.req)); assert.equal(f.writes.length, 2);
});
for (const mutation of [f => { f.req.data.role = 'station_commander'; }, f => { f.req.data.email = ''; },
  f => { f.req.auth.uid = 'super_2'; }, f => { f.store.get(f.stationPath).active = true; },
  f => { f.store.get(f.stationPath).silent = false; }, f => { f.store.get(f.opPath).fingerprint = 'a'.repeat(64); },
  f => { f.store.get(f.opPath).first_admin_invitation_intent.role = 'station_commander'; },
  f => { f.store.get(f.opPath).first_admin_invitation = null; },
  f => { f.control.denyAt = 2; }, f => { f.control.beforeTx = () => { f.store.get(f.stationPath).districtId = 'north'; }; }]) {
  test('invalid input/source or fresh authority fails before writes ' + mutation.toString(), async () => {
    const f = fixture(); mutation(f); await assert.rejects(f.service.issueFirstAdminInvitation(f.req)); assert.equal(f.writes.length, 0);
  });
}
test('stored invitation tampering does not return a replacement secret', async () => {
  const f = fixture(), result = await f.service.issueFirstAdminInvitation(f.req);
  f.store.get('invitations/' + result.invite_id).role = 'station_commander';
  await assert.rejects(f.service.issueFirstAdminInvitation(f.req)); assert.equal(f.writes.length, 2);
});
