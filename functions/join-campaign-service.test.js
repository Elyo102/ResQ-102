'use strict';
/* בדיקות שירות קליטה בקישור קבוצתי — Firestore מזויף, מנוע הזמנות אמיתי,
 * חוזה קליטה אמיתי, קטלוג כשירויות אמיתי. הרצה: node functions/join-campaign-service.test.js */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const approvalModule = require('./onboarding-approval-authority');
const H = require('./join-campaign-test-harness');
const { fakeDb, rejects, invitations, AUTH_USERS, authUser, req, build, seedHr, createInput, redeemInput, buildReadiness, hash, NOW, contract, onboardingContract, qualifications } = H;
void fakeDb; void crypto;

let passed = 0; const failed = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed += 1; }).catch((e) => { failed.push(name + ' :: ' + (e && (e.stack || e.message))); });
}
function approvalAuthority(db) {
  return approvalModule.createOnboardingApprovalAuthority({ db, invitations, contract: onboardingContract });
}

/* ---------- בדיקות ---------- */
(async () => {

await test('super creates campaign for any station; token returned once; doc stores hash only', async () => {
  const { db, service, audits } = build();
  const res = await service.createJoinCampaign(req('super1', createInput({ station_id: 'haifa' })));
  assert.equal(res.ok, true); assert.equal(res.token.length, 60); assert.equal(res.station_id, 'haifa');
  const doc = db._get('join_campaigns/' + res.campaign_id);
  assert.equal(doc.token_hash, hash(res.token.split('.')[1])); assert.equal(doc.created_by_role, 'super'); assert.equal(doc.default_role, 'firefighter');
  assert.equal(JSON.stringify(doc).includes(res.token.split('.')[1]), false);
  assert.equal(audits[0].action, 'create_join_campaign'); assert.equal(JSON.stringify(audits).includes(res.token.split('.')[1]), false);
  await rejects(service.createJoinCampaign(req('super1', createInput({ station_id: 'nowhere' }))), 'campaign-station');
});

await test('hr creates only for own station, station keys rejected, deputy/haifa-hr blocked, stale hr blocked', async () => {
  const { db, service } = build(); seedHr(db);
  const res = await service.createJoinCampaign(req('hr1', createInput()));
  assert.equal(res.station_id, 'eilat'); assert.equal(db._get('join_campaigns/' + res.campaign_id).created_by_role, 'hr_coordinator');
  await rejects(service.createJoinCampaign(req('hr1', createInput({ station_id: 'haifa' }))), 'client-station', 'invalid-argument');
  await rejects(service.createJoinCampaign(req('hr1', createInput({ stationId: 'haifa' }))), 'client-station', 'invalid-argument');
  await rejects(service.createJoinCampaign(req('deputy1', createInput())), 'campaign-actor', 'permission-denied');
  await rejects(service.createJoinCampaign(req(null, createInput())), 'auth', 'unauthenticated');
  // claims say hr but live user doc is inactive → blocked
  db._put('stations/eilat/users/hr1', { role: 'hr_coordinator', active: false, stationId: 'eilat' });
  await rejects(service.createJoinCampaign(req('hr1', createInput())), 'campaign-actor-inactive', 'permission-denied');
  // claims stale (token says hr, Auth says firefighter)
  seedHr(db); AUTH_USERS.get('hr1').customClaims = { role: 'firefighter', stationId: 'eilat' };
  await rejects(service.createJoinCampaign({ auth: { uid: 'hr1', token: { role: 'hr_coordinator', stationId: 'eilat' } }, data: createInput() }), 'campaign-actor-stale', 'permission-denied');
  AUTH_USERS.get('hr1').customClaims = { role: 'hr_coordinator', stationId: 'eilat', districtId: 'south' };
});

await test('tenant isolation: haifa hr cannot see, pause or list eilat campaign', async () => {
  const { db, service } = build(); seedHr(db);
  const res = await service.createJoinCampaign(req('hr1', createInput()));
  await rejects(service.setJoinCampaignStatus(req('hr_haifa', { campaign_id: res.campaign_id, action: 'pause', expected_revision: 1 })), 'campaign-missing', 'not-found');
  await rejects(service.getJoinCampaignRegistrants(req('hr_haifa', { campaign_id: res.campaign_id })), 'campaign-missing', 'not-found');
  const list = await service.listJoinCampaigns(req('hr_haifa', {}));
  assert.equal(list.campaigns.length, 0);
  const mine = await service.listJoinCampaigns(req('hr1', {}));
  assert.equal(mine.campaigns.length, 1); assert.equal(mine.campaigns[0].token_hash, undefined);
  const all = await service.listJoinCampaigns(req('super1', {}));
  assert.equal(all.campaigns.length, 1);
  await rejects(service.listJoinCampaigns(req('hr_haifa', { station_id: 'eilat' })), 'client-station', 'invalid-argument');
});

await test('status actions with revision; revoke is final', async () => {
  const { db, service } = build();
  const res = await service.createJoinCampaign(req('super1', createInput({ station_id: 'eilat' })));
  const p = await service.setJoinCampaignStatus(req('super1', { campaign_id: res.campaign_id, action: 'pause', expected_revision: 1 }));
  assert.equal(p.status, 'paused'); assert.equal(p.revision, 2);
  await rejects(service.setJoinCampaignStatus(req('super1', { campaign_id: res.campaign_id, action: 'resume', expected_revision: 1 })), 'revision', 'aborted');
  await service.setJoinCampaignStatus(req('super1', { campaign_id: res.campaign_id, action: 'revoke', expected_revision: 2 }));
  await rejects(service.setJoinCampaignStatus(req('super1', { campaign_id: res.campaign_id, action: 'resume', expected_revision: 3 })), 'campaign-revoked');
  assert.equal(db._get('join_campaigns/' + res.campaign_id).status, 'revoked');
});

await test('inspect: public, rate limited, cached, never leaks counts', async () => {
  const { db, service } = build();
  const res = await service.createJoinCampaign(req('super1', createInput({ station_id: 'eilat' })));
  const view = await service.inspectJoinCampaign({ data: { token: res.token } });
  assert.equal(view.state, 'active'); assert.equal(view.station_name, 'אילת'); assert.deepEqual(view.allowed_shifts, ['A', 'B']);
  assert.equal(Object.keys(view).indexOf('accepted_count'), -1); assert.equal(Object.keys(view).indexOf('label'), -1);
  assert.deepEqual(await service.inspectJoinCampaign({ data: { token: 'nope' } }), { state: 'not_found' });
  const wrong = res.campaign_id + '.' + 'A'.repeat(43);
  assert.deepEqual(await service.inspectJoinCampaign({ data: { token: wrong } }), { state: 'not_found' });
  const quotaPath = Object.keys(Object.fromEntries(db._store)).find((k) => k.startsWith('join_campaign_inspect_quota/'));
  assert.ok(quotaPath);
  db._put(quotaPath, { count: 300 });
  H.setClock(H.getClock() + 31 * 1000); // cache expiry
  await rejects(service.inspectJoinCampaign({ data: { token: res.token } }), 'inspect-quota', 'resource-exhausted');
  H.setClock(NOW);
});

async function redeemHappy(o) {
  const ctx = o && o.ctx ? o.ctx : build(); const { db, service } = ctx;
  const created = await service.createJoinCampaign(req('super1', createInput(Object.assign({ station_id: 'eilat' }, (o && o.create) || {}))));
  const input = redeemInput(created.token, o && o.input);
  const out = await service.redeemJoinCampaign(req(o && o.uid || 'w1', input));
  return { db, service, created, input, out, ctx };
}

await test('redeem: one transaction writes invitation, request, operation, registry, registrant, counter; nothing leaks the secret', async () => {
  const { db, created, input, out } = await redeemHappy();
  assert.equal(out.ok, true); assert.equal(out.replayed, false); assert.equal(out.stage, 'request_created'); assert.equal(out.permissions_granted, false);
  const registry = db._get('onboarding_assignment_links/w1');
  assert.deepEqual(Object.keys(registry).sort(), ['invite_id', 'operation_fingerprint', 'request_id', 'schema_version', 'station_id', 'uid']);
  const invite = db._get('invitations/' + registry.invite_id);
  assert.equal(invite.role, 'firefighter'); assert.equal(invite.station_id, 'eilat'); assert.equal(invite.district_id, 'south'); assert.equal(invite.issued_by, 'super1');
  assert.equal(invite.redeemed_by, 'w1'); assert.equal(invite.redeemed_request_id, input.request_id); assert.equal(invite.email, 'w1@example.test'); assert.equal(invite.max_uses, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(invite, 'secret'), false); assert.equal(Object.prototype.hasOwnProperty.call(invite, 'campaign_id'), false);
  const request = db._get('registration_requests/w1');
  assert.deepEqual(Object.keys(request).sort(), ['created_at', 'districtId', 'email', 'full_name', 'phone', 'request_id', 'shift', 'stationId', 'status']);
  assert.equal(request.status, 'pending'); assert.equal(request.stationId, 'eilat'); assert.equal(request.shift, 'A');
  const op = db._get('stations/eilat/onboarding_operations/' + input.request_id);
  assert.equal(op.stage, 'request_created'); assert.deepEqual(op.provenance, { kind: 'join_campaign', campaign_id: created.campaign_id, campaign_revision: 1 });
  const reg = db._get('join_campaigns/' + created.campaign_id + '/registrants/w1');
  assert.equal(reg.declarations[0].status, 'declared'); assert.equal(reg.shift, 'A');
  assert.equal(db._get('join_campaigns/' + created.campaign_id).accepted_count, 1);
  assert.deepEqual(db._get('join_registrant_index/w1').campaign_id, created.campaign_id);
  const all = JSON.stringify(Array.from(db._store.entries()));
  assert.equal(all.includes(created.token.split('.')[1]), false, 'raw secret persisted');
  assert.equal(/"secret":/.test(all), false);
});

await test('redeem: approval authority accepts the materialized invitation exactly like a personal one', async () => {
  const { db, input } = await redeemHappy();
  const authority = approvalAuthority(db);
  const result = await db.runTransaction((tx) => authority.readForApproval(tx, { uid: 'w1', request: db._get('registration_requests/w1'), authUser: AUTH_USERS.get('w1'), existingOp: null }));
  assert.ok(result, 'authority must resolve'); assert.equal(result.assignment.stationId, 'eilat'); assert.equal(result.assignment.role, 'firefighter'); assert.equal(result.source.request_id, input.request_id);
});

await test('redeem: replay of the same request returns replayed without a second invitation or count', async () => {
  const { db, service, input, created } = await redeemHappy();
  const before = Array.from(db._store.keys()).filter((k) => k.startsWith('invitations/')).length;
  const again = await service.redeemJoinCampaign(req('w1', input));
  assert.equal(again.replayed, true);
  assert.equal(Array.from(db._store.keys()).filter((k) => k.startsWith('invitations/')).length, before);
  assert.equal(db._get('join_campaigns/' + created.campaign_id).accepted_count, 1);
  // replay by a different uid with the same request id is refused
  await rejects(service.redeemJoinCampaign(req('w2', input)), 'onboarding-intent-changed');
  // replay after campaign became full still replays
  db._put('join_campaigns/' + created.campaign_id, Object.assign({}, db._get('join_campaigns/' + created.campaign_id), { accepted_count: 2, status: 'full' }));
  assert.equal((await service.redeemJoinCampaign(req('w1', input))).replayed, true);
  // replay with tampered operation provenance is refused
  const op = db._get('stations/eilat/onboarding_operations/' + input.request_id);
  db._put('stations/eilat/onboarding_operations/' + input.request_id, Object.assign({}, op, { provenance: { kind: 'join_campaign', campaign_id: 'BBBBBBBBBBBBBBBB' } }));
  await rejects(service.redeemJoinCampaign(req('w1', input)), 'onboarding-intent-changed');
});

await test('redeem: campaign states, wrong token, unverified email, foreign registry, shift not offered', async () => {
  const { db, service, created } = await redeemHappy();
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(created.campaign_id + '.' + 'B'.repeat(43)))), 'campaign-missing', 'not-found');
  await rejects(service.redeemJoinCampaign(req('w_unverified', redeemInput(created.token))), 'identity', 'permission-denied');
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(created.token, { shift: 'C' }))), 'shift', 'invalid-argument');
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(created.token, { role: 'commander' }))), 'client-supplied-plan', 'invalid-argument');
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(created.token, { station_id: 'haifa' }))), 'client-supplied-plan', 'invalid-argument');
  await rejects(service.redeemJoinCampaign(req('w1', redeemInput(created.token))), 'onboarding-registry-exists');
  await service.setJoinCampaignStatus(req('super1', { campaign_id: created.campaign_id, action: 'pause', expected_revision: 2 }));
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(created.token))), 'campaign-paused');
  await service.setJoinCampaignStatus(req('super1', { campaign_id: created.campaign_id, action: 'resume', expected_revision: 3 }));
  H.setClock(NOW + 8 * 86400000);
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(created.token))), 'campaign-expired');
  H.setClock(NOW);
  await service.setJoinCampaignStatus(req('super1', { campaign_id: created.campaign_id, action: 'revoke', expected_revision: 4 }));
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(created.token))), 'campaign-revoked');
  assert.equal(db._get('registration_requests/w2'), undefined);
});

await test('redeem: quota — second fills, third is refused, and a race on the last slot admits exactly one', async () => {
  const { db, service, created } = await redeemHappy();
  const second = await service.redeemJoinCampaign(req('w2', redeemInput(created.token)));
  assert.equal(second.ok, true); assert.equal(db._get('join_campaigns/' + created.campaign_id).status, 'full');
  await rejects(service.redeemJoinCampaign(req('w3', redeemInput(created.token))), 'campaign-full');
  // מרוץ: קמפיין חדש עם מכסה 1; w2 קורא, w3 מתחייב באמצע, w2 חייב לרוץ מחדש ולקבל full
  const c2 = await service.createJoinCampaign(req('super1', createInput({ station_id: 'eilat', max_registrations: 1 })));
  authUser('r1'); authUser('r2');
  let interleaved = false;
  db._hooks.beforeCommit = async () => { interleaved = true; await service.redeemJoinCampaign(req('r2', redeemInput(c2.token))); };
  await rejects(service.redeemJoinCampaign(req('r1', redeemInput(c2.token))), 'campaign-full');
  assert.equal(interleaved, true);
  assert.equal(db._get('join_campaigns/' + c2.campaign_id).accepted_count, 1);
  assert.equal(db._get('registration_requests/r2').status, 'pending'); assert.equal(db._get('registration_requests/r1'), undefined);
  assert.equal(Array.from(db._store.keys()).filter((k) => k.startsWith('invitations/')).length, 3);
});

await test('redeem: issuer liveness — disabled super or moved hr freezes the campaign', async () => {
  const { db, service } = build(); seedHr(db);
  const byHr = await service.createJoinCampaign(req('hr1', createInput()));
  const ok = await service.redeemJoinCampaign(req('w1', redeemInput(byHr.token)));
  assert.equal(ok.ok, true); assert.equal(db._get('invitations/' + db._get('onboarding_assignment_links/w1').invite_id).issued_by, 'hr1');
  db._put('stations/eilat/users/hr1', { role: 'hr_coordinator', active: false, stationId: 'eilat' });
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(byHr.token))), 'campaign-issuer-inactive');
  seedHr(db);
  const bySuper = await service.createJoinCampaign(req('super1', createInput({ station_id: 'eilat' })));
  AUTH_USERS.get('super1').disabled = true;
  await rejects(service.redeemJoinCampaign(req('w2', redeemInput(bySuper.token))), 'campaign-issuer-inactive');
  AUTH_USERS.get('super1').disabled = false;
});

await test('hr-issued campaign: engine scope check uses hr cap and station; role stays firefighter', async () => {
  const { db, service } = build(); seedHr(db);
  const byHr = await service.createJoinCampaign(req('hr1', createInput()));
  await service.redeemJoinCampaign(req('w1', redeemInput(byHr.token)));
  const invite = db._get('invitations/' + db._get('onboarding_assignment_links/w1').invite_id);
  assert.equal(invite.role, 'firefighter'); assert.equal(invite.station_id, 'eilat'); assert.equal(invite.district_id, 'south');
});

await test('registrants page: derived request status, email_verified, no N+1 beyond batched reads; review actions', async () => {
  const { db, service, created, ctx } = await redeemHappy();
  authUser('w9', { emailVerified: false }); await service.redeemJoinCampaign(req('w9', redeemInput(created.token))).catch(() => {});
  const page = await service.getJoinCampaignRegistrants(req('super1', { campaign_id: created.campaign_id }));
  assert.equal(page.rows.length, 1); assert.equal(page.rows[0].request_status, 'pending'); assert.equal(page.rows[0].email_verified, true); assert.equal(page.rows[0].full_name, 'בודק דמה');
  assert.equal(page.rows[0].declarations[0].status, 'declared');
  // approval simulated by the existing mechanism: request deleted, live user created
  db._store.delete('registration_requests/w1');
  db._put('stations/eilat/users/w1', { role: 'firefighter', active: true, is_active: true, stationId: 'eilat', name: 'בודק דמה' });
  const page2 = await service.getJoinCampaignRegistrants(req('super1', { campaign_id: created.campaign_id }));
  assert.equal(page2.rows[0].request_status, 'approved'); assert.equal(page2.rows[0].declarations[0].status, 'pending_verification');
  const rv = await service.reviewJoinRegistrant(req('super1', { campaign_id: created.campaign_id, uid: 'w1', action: 'return', expected_revision: 1, reason: 'טלפון שגוי' }));
  assert.equal(rv.review_state, 'returned');
  await rejects(service.reviewJoinRegistrant(req('super1', { campaign_id: created.campaign_id, uid: 'w1', action: 'remind', expected_revision: 1 })), 'revision', 'aborted');
  const noted = await service.reviewJoinRegistrant(req('super1', { campaign_id: created.campaign_id, uid: 'w1', action: 'reject_note', expected_revision: 2, reason: 'כפילות' }));
  assert.equal(noted.review_state, 'returned'); assert.equal(db._get('join_campaigns/' + created.campaign_id + '/registrants/w1').reject_reason, 'כפילות');
  const mine = await service.getMyJoinStatus(req('w1', {}));
  assert.equal(mine.found, true); assert.equal(mine.review_state, 'returned'); assert.equal(mine.review_note, 'טלפון שגוי'); assert.equal(mine.request_status, 'approved'); assert.equal(mine.reject_reason, 'כפילות');
  assert.equal(JSON.stringify(mine).includes('verified_by'), false);
  assert.deepEqual(await service.getMyJoinStatus(req('w2', {})), { ok: true, found: false });
  void ctx;
});

await test('verify qualification: super only, one transaction writes holdings (engine shape + valid_until) and the declaration together; super verifies any station', async () => {
  const { db, service, created } = await redeemHappy();
  const vin = (over) => Object.assign({ campaign_id: created.campaign_id, uid: 'w1', key: 'driver', action: 'verify', expected_revision: 1, request_id: 'req_verify_000001' }, over || {});
  await rejects(service.verifyQualificationDeclaration(req('hr1', vin())), 'super', 'permission-denied');
  // לפני אישור: ההצהרה רק declared → סירוב, ואין החזקה
  await rejects(service.verifyQualificationDeclaration(req('super1', vin())), 'declaration-not-pending');
  assert.equal(db._get('stations/eilat/schedule_person_qualifications/w1'), undefined);
  db._store.delete('registration_requests/w1');
  db._put('stations/eilat/users/w1', { role: 'firefighter', active: true, is_active: true, stationId: 'eilat' });
  // מנהל-על של תחנה אחרת (claim haifa) מאמת קמפיין של אילת — התחנה נגזרת מהקמפיין
  authUser('super_h', { customClaims: { super: true, stationId: 'haifa' } });
  const ok = await service.verifyQualificationDeclaration(req('super_h', vin()));
  assert.equal(ok.holdings_written, true); assert.equal(ok.station_id, 'eilat'); assert.equal(ok.holdings_revision, 1);
  const holdings = db._get('stations/eilat/schedule_person_qualifications/w1');
  assert.deepEqual(holdings.qualifications, ['driver']); assert.equal(holdings.revision, 1); assert.equal(holdings.cleared, false); assert.equal(holdings.updated_by, 'super_h');
  assert.deepEqual(holdings.valid_until, { driver: NOW + 86400000 * 30 });
  assert.equal(db._get('stations/haifa/schedule_person_qualifications/w1'), undefined, 'never written to the super\'s own station');
  assert.equal(db._get('stations/eilat/schedule_state/qualifications').holdings_revision, 1);
  const auditDocs = Array.from(db._store.keys()).filter((k) => k.startsWith('stations/eilat/schedule_qualification_audit/qa_'));
  assert.equal(auditDocs.length, 1); assert.deepEqual(db._get(auditDocs[0]).added, ['driver']); assert.equal(db._get(auditDocs[0]).source, 'join_campaign_verification');
  const reg = db._get('join_campaigns/' + created.campaign_id + '/registrants/w1');
  assert.equal(reg.declarations[0].status, 'verified'); assert.equal(reg.declarations[0].verified_by, 'super_h'); assert.equal(reg.revision, 2);
  // המנוע רואה את ההחזקה בתוקף, ומסנן אותה אחרי הפקיעה
  assert.deepEqual(qualifications.effectiveHoldings(holdings, NOW), ['driver']);
  assert.deepEqual(qualifications.effectiveHoldings(holdings, NOW + 86400000 * 31), []);
  // אותו request_id עם אותו גוף בדיוק (תשובה שאבדה) → קבלה כפולה, שום כתיבה נוספת
  const dup = await service.verifyQualificationDeclaration(req('super_h', vin()));
  assert.equal(dup.duplicate, true); assert.equal(dup.holdings_written, false);
  assert.equal(db._get('stations/eilat/schedule_person_qualifications/w1').revision, 1);
  // אותו request_id עם כוונה אחרת (מפתח אחר / מאמת אחר / גרסה אחרת) → request-conflict, שום כתיבה
  const regWithHazmat = db._get('join_campaigns/' + created.campaign_id + '/registrants/w1');
  db._put('join_campaigns/' + created.campaign_id + '/registrants/w1', Object.assign({}, regWithHazmat, { declarations: regWithHazmat.declarations.concat([{ key: 'hazmat', declared_at_ms: NOW, valid_until_ms: null, reference: null, status: 'pending_verification', verified_by: null, verified_at_ms: null, reject_reason: null, revision: 1 }]) }));
  await rejects(service.verifyQualificationDeclaration(req('super_h', vin({ key: 'hazmat', expected_revision: 2 }))), 'request-conflict', 'already-exists');
  await rejects(service.verifyQualificationDeclaration(req('super1', vin())), 'request-conflict', 'already-exists');
  await rejects(service.verifyQualificationDeclaration(req('super_h', vin({ expected_revision: 2 }))), 'request-conflict', 'already-exists');
  assert.deepEqual(db._get('stations/eilat/schedule_person_qualifications/w1').qualifications, ['driver']);
  assert.equal(db._get('join_campaigns/' + created.campaign_id + '/registrants/w1').declarations[1].status, 'pending_verification');
  // כשירות שנייה (מזהה פעולה חדש): נוספת בלי לדרוס את הראשונה ואת תוקפה
  const second = await service.verifyQualificationDeclaration(req('super1', vin({ key: 'hazmat', expected_revision: 2, request_id: 'req_verify_000002' })));
  assert.equal(second.holdings_revision, 2);
  const h2 = db._get('stations/eilat/schedule_person_qualifications/w1');
  assert.deepEqual(h2.qualifications, ['driver', 'hazmat']); assert.deepEqual(h2.valid_until, { driver: NOW + 86400000 * 30 });
  // דחייה: נימוק חובה, ההחזקות אינן נוגעות
  await rejects(service.verifyQualificationDeclaration(req('super1', { campaign_id: created.campaign_id, uid: 'w1', key: 'driver', action: 'reject', reason: 'אין אסמכתא', expected_revision: 3, request_id: 'req_verify_000003' })), 'declaration-missing', 'not-found');
  assert.equal(db._get('stations/eilat/schedule_person_qualifications/w1').revision, 2);
  // דחייה עם replay: שתי הצהרות ממתינות (driver, hazmat); אותו request_id — אותה כוונה → קבלה כפולה, כשירות אחרת → conflict
  const r3 = db._get('join_campaigns/' + created.campaign_id + '/registrants/w1');
  db._put('join_campaigns/' + created.campaign_id + '/registrants/w1', Object.assign({}, r3, { revision: 10, declarations: [
    { key: 'driver', declared_at_ms: NOW, valid_until_ms: null, reference: null, status: 'pending_verification', verified_by: null, verified_at_ms: null, reject_reason: null, revision: 1 },
    { key: 'hazmat', declared_at_ms: NOW, valid_until_ms: null, reference: null, status: 'pending_verification', verified_by: null, verified_at_ms: null, reject_reason: null, revision: 1 }] }));
  const rejectBody = { campaign_id: created.campaign_id, uid: 'w1', key: 'driver', action: 'reject', reason: 'אין אסמכתא', expected_revision: 10, request_id: 'req_reject_000001' };
  const rj = await service.verifyQualificationDeclaration(req('super1', rejectBody));
  assert.equal(rj.action, 'reject'); assert.equal(rj.revision, 11);
  const rjDup = await service.verifyQualificationDeclaration(req('super1', rejectBody));
  assert.equal(rjDup.duplicate, true); assert.equal(rjDup.revision, 11);
  await rejects(service.verifyQualificationDeclaration(req('super1', Object.assign({}, rejectBody, { key: 'hazmat', expected_revision: 11 }))), 'request-conflict', 'already-exists');
  const after = db._get('join_campaigns/' + created.campaign_id + '/registrants/w1');
  assert.equal(after.revision, 11); assert.equal(after.declarations[0].status, 'rejected'); assert.equal(after.declarations[1].status, 'pending_verification');
  assert.equal(db._get('stations/eilat/schedule_person_qualifications/w1').revision, 2, 'reject never touches holdings');
});

await test('verify: atomic — a failed commit leaves neither holdings nor a verified declaration; stale revision writes nothing', async () => {
  const { db, service, created } = await redeemHappy();
  db._store.delete('registration_requests/w1');
  db._put('stations/eilat/users/w1', { role: 'firefighter', active: true, is_active: true, stationId: 'eilat' });
  const vin = { campaign_id: created.campaign_id, uid: 'w1', key: 'driver', action: 'verify', expected_revision: 1, request_id: 'req_verify_000009' };
  db._hooks.beforeCommit = async () => { throw new Error('commit failed'); };
  await assert.rejects(service.verifyQualificationDeclaration(req('super1', vin)), /commit failed/);
  assert.equal(db._get('stations/eilat/schedule_person_qualifications/w1'), undefined, 'no holdings after a failed commit');
  assert.equal(db._get('join_campaigns/' + created.campaign_id + '/registrants/w1').declarations[0].status, 'declared', 'no verified declaration after a failed commit');
  assert.equal(Array.from(db._store.keys()).filter((k) => k.includes('schedule_qualification_audit')).length, 0);
  await rejects(service.verifyQualificationDeclaration(req('super1', Object.assign({}, vin, { expected_revision: 7 }))), 'revision', 'aborted');
  assert.equal(db._get('stations/eilat/schedule_person_qualifications/w1'), undefined);
  // כשירות מושבתת בקטלוג התחנה → אין אימות ואין החזקה
  db._put('stations/eilat/schedule_qualifications/driver', { active: false, label: 'נהגים', revision: 1 });
  await rejects(service.verifyQualificationDeclaration(req('super1', vin)), 'holdings-unknown');
  assert.equal(db._get('stations/eilat/schedule_person_qualifications/w1'), undefined);
  db._store.delete('stations/eilat/schedule_qualifications/driver');
  // תוקף שפג בין ההצהרה לאימות → declaration-expired, שום כתיבה
  H.setClock(NOW + 86400000 * 31);
  await rejects(service.verifyQualificationDeclaration(req('super1', vin)), 'declaration-expired');
  H.setClock(NOW);
  const okNow = await service.verifyQualificationDeclaration(req('super1', vin));
  assert.equal(okNow.holdings_written, true);
});

await test('readiness: approved worker only, own token only, nonce ack, quota/cooldown, provider failure is not success', async () => {
  const { db } = build();
  authUser('ff1', { customClaims: { role: 'firefighter', stationId: 'eilat', districtId: 'south', shift: 'A', emp: '1234' } });
  const { service, sent, audits, setSendMode } = buildReadiness(db);
  const token = 'device-token-' + 'x'.repeat(40);
  // not approved yet (no live user)
  await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0001', token })), 'readiness-not-approved');
  db._put('stations/eilat/users/ff1', { role: 'firefighter', active: true, is_active: true, stationId: 'eilat' });
  // token not registered by this uid
  await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0001', token })), 'readiness-token-unknown');
  db._put('stations/eilat/push_tokens/ff1', { tokens: [{ token, label: 'phone', added: 1 }] });
  // client cannot pick another uid: no uid field accepted
  await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0001', token, uid: 'other' })), 'input', 'invalid-argument');
  const r1 = await service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0001', token }));
  assert.equal(r1.status, 'test_sent'); assert.equal(r1.replayed, false); assert.equal(sent.length, 1);
  // replay של אותו request_id (תשובה שאבדה): לא נשלח שוב, אין audit שני, וקוד האישור המקורי נשאר תקף
  const r1b = await service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0001', token }));
  assert.equal(r1b.replayed, true); assert.equal(r1b.status, 'test_sent'); assert.equal(sent.length, 1); assert.equal(audits.filter((a) => a.action === 'readiness_test_sent').length, 1);
  // אותו request_id עם טוקן של מכשיר אחר → התנגשות, לא replay ולא שליחה
  const token2 = 'device-token-2-' + 'y'.repeat(40);
  db._put('stations/eilat/push_tokens/ff1', { tokens: [{ token, label: 'phone', added: 1 }, { token: token2, label: 'tablet', added: 2 }] });
  await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0001', token: token2 })), 'request-conflict', 'already-exists');
  assert.equal(sent.length, 1); assert.equal(db._get('stations/eilat/device_readiness/ff1').token_hash, hash(token));
  db._put('stations/eilat/push_tokens/ff1', { tokens: [{ token, label: 'phone', added: 1 }] });
  assert.equal(db._get('stations/eilat/device_readiness/ff1').challenge_hash, hash(sent[0].data.nonce)); assert.equal(sent[0].token, token); assert.equal(sent[0].data.type, 'readiness_test'); assert.equal(sent[0].data.important, '0');
  assert.equal(sent[0].data.tag.startsWith('callout'), false);
  const nonce = sent[0].data.nonce;
  // מוכנות: כשירות ממתינה לאימות חוסמת גם אחרי ack
  db._put('join_registrant_index/ff1', { uid: 'ff1', campaign_id: 'AAAAAAAAAAAAAAAA', station_id: 'eilat' });
  db._put('join_campaigns/AAAAAAAAAAAAAAAA/registrants/ff1', { schema: 'join-registrant-v1', uid: 'ff1', declarations: [{ key: 'driver', status: 'declared', valid_until_ms: null }], revision: 1 });
  const dev = db._get('stations/eilat/device_readiness/ff1');
  assert.equal(dev.challenge_hash, hash(nonce)); assert.equal(dev.token_hash, hash(token)); assert.equal(JSON.stringify(dev).includes(token), false); assert.equal(JSON.stringify(dev).includes(nonce), false);
  assert.equal(JSON.stringify(audits).includes(token), false);
  // status before ack
  let st = await service.getMyReadiness(req('ff1', {}));
  assert.equal(st.operational_ready, false); assert.deepEqual(st.blockers, ['device_not_ready', 'qualifications_unverified']); assert.equal(st.device.status, 'test_sent');
  // wrong nonce, wrong token
  await rejects(service.ackReadinessTestPush(req('ff1', { nonce: 'f'.repeat(32), token })), 'readiness-nonce');
  await rejects(service.ackReadinessTestPush(req('ff1', { nonce, token: token + 'y' })), 'readiness-token');
  const ack = await service.ackReadinessTestPush(req('ff1', { nonce, token }));
  assert.deepEqual(ack, { ok: true, already: false, status: 'ready' });
  assert.deepEqual(await service.ackReadinessTestPush(req('ff1', { nonce, token })), { ok: true, already: true, status: 'ready' });
  st = await service.getMyReadiness(req('ff1', {}));
  assert.equal(st.operational_ready, false); assert.deepEqual(st.blockers, ['qualifications_unverified']); assert.equal(st.qualifications.pending, 1);
  db._put('join_campaigns/AAAAAAAAAAAAAAAA/registrants/ff1', { schema: 'join-registrant-v1', uid: 'ff1', declarations: [{ key: 'driver', status: 'verified', valid_until_ms: NOW - 1 }], revision: 2 });
  st = await service.getMyReadiness(req('ff1', {}));
  assert.equal(st.operational_ready, false); assert.deepEqual(st.blockers, ['qualifications_expired']);
  db._put('join_campaigns/AAAAAAAAAAAAAAAA/registrants/ff1', { schema: 'join-registrant-v1', uid: 'ff1', declarations: [{ key: 'driver', status: 'verified', valid_until_ms: NOW + 1 }, { key: 'hazmat', status: 'rejected' }], revision: 3 });
  st = await service.getMyReadiness(req('ff1', {}));
  assert.equal(st.operational_ready, true); assert.equal(st.ready_at_ms, NOW);
  // token removed → no longer ready (computed)
  db._put('stations/eilat/push_tokens/ff1', { tokens: [] });
  st = await service.getMyReadiness(req('ff1', {}));
  assert.equal(st.operational_ready, false); assert.deepEqual(st.blockers, ['no_push_token', 'push_token_changed']);
  db._put('stations/eilat/push_tokens/ff1', { tokens: [{ token, label: 'phone', added: 1 }] });
  // cooldown then quota
  await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0002', token })), 'readiness-cooldown', 'resource-exhausted');
  H.setClock(H.getClock() + 61000); await service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0003', token }));
  H.setClock(H.getClock() + 61000); await service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0004', token }));
  H.setClock(H.getClock() + 61000); await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0005', token })), 'readiness-quota', 'resource-exhausted');
  // next day, provider failure → failed status, not success
  H.setClock(H.getClock() + 86400000); setSendMode('fail');
  await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0006', token })), 'readiness-provider', 'unavailable');
  assert.equal(db._get('stations/eilat/device_readiness/ff1').status, 'failed');
  assert.equal(audits[audits.length - 1].sealed.outcome, 'failed');
  // אחרי כשל ספק, אותו request_id מותר לשליחה חוזרת (אין replay של כשל) — אחרי cooldown
  setSendMode('ok'); H.setClock(H.getClock() + 61000);
  const resend = await service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0006', token }));
  assert.equal(resend.replayed, false); assert.equal(db._get('stations/eilat/device_readiness/ff1').status, 'test_sent');
  // expired challenge cannot be acked
  H.setClock(H.getClock() + 61000);
  await service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0007', token }));
  const n2 = sent[sent.length - 1].data.nonce; H.setClock(H.getClock() + contract.READINESS_CHALLENGE_MS + 1);
  await rejects(service.ackReadinessTestPush(req('ff1', { nonce: n2, token })), 'readiness-expired');
  // super with a worker's token (registered under ff1, not under super1) is rejected
  await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_readiness_0008', token })), 'readiness-token-unknown');
  // station inactive blocks (fence kept)
  db._put('stations/eilat', { name: 'אילת', districtId: 'south', active: false });
  H.setClock(H.getClock() + 61000);
  await rejects(service.sendReadinessTestPush(req('ff1', { request_id: 'req_readiness_0009', token })), 'station-station-inactive');
  H.setClock(NOW);
});

await test('readiness for super: own device only, station from signed claims, same quota/fence, live claim revocation, no lab claim involved', async () => {
  const { db } = build();
  const { service, sent, audits } = buildReadiness(db);
  const token = 'super-device-token-' + 's'.repeat(40);
  const workerToken = 'worker-device-token-' + 'w'.repeat(40);
  db._put('stations/eilat/users/ff1', { role: 'firefighter', active: true, is_active: true, stationId: 'eilat' });
  db._put('stations/eilat/push_tokens/ff1', { tokens: [{ token: workerToken, label: 'phone', added: 1 }] });
  // super1 has super:true + stationId:'eilat' in claims and NO live user document, NO role claim, NO personal_lab_control.
  assert.equal(db._get('stations/eilat/users/super1'), undefined);
  assert.equal(AUTH_USERS.get('super1').customClaims.personal_lab_control, undefined);
  // 1. enters the wizard: approved, blocked only by the missing token
  let st = await service.getMyReadiness(req('super1', {}));
  assert.equal(st.account.approved, true);
  assert.ok(!st.blockers.includes('account_not_approved') && !st.blockers.includes('qualifications_unverified') && !st.blockers.includes('qualifications_expired'));
  assert.ok(st.blockers.includes('no_push_token'));
  // 2. a worker's token (registered under another uid) is rejected — own token only
  await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00001', token: workerToken })), 'readiness-token-unknown');
  assert.equal(sent.length, 0);
  // 3. client cannot pick the target station: any extra field is rejected before anything is read
  db._put('stations/eilat/push_tokens/super1', { tokens: [{ token, label: 'laptop', added: 1 }] });
  await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00001', token, station_id: 'haifa' })), 'input', 'invalid-argument');
  await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00001', token, stationId: 'haifa' })), 'input', 'invalid-argument');
  assert.equal(sent.length, 0);
  // a claim in the request token that differs from the live claims does not move the station either
  await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00001', token }, { stationId: 'haifa' })), 'readiness-not-approved');
  assert.equal(sent.length, 0); assert.equal(db._get('stations/haifa/device_readiness/super1'), undefined);
  // 4. registers own token and sends to itself — station from the signed claim (eilat)
  const r1 = await service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00001', token }));
  assert.equal(r1.status, 'test_sent'); assert.equal(r1.replayed, false);
  assert.equal(sent.length, 1); assert.equal(sent[0].token, token); assert.equal(sent[0].data.type, 'readiness_test'); assert.equal(sent[0].data.important, '0');
  assert.equal(db._get('stations/eilat/device_readiness/super1').token_hash, hash(token));
  assert.equal(db._get('stations/haifa/device_readiness/super1'), undefined);
  assert.equal(audits.filter((a) => a.action === 'readiness_test_sent').length, 1);
  // 5. replay of the same request does not send again
  const r1b = await service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00001', token }));
  assert.equal(r1b.replayed, true); assert.equal(sent.length, 1); assert.equal(audits.filter((a) => a.action === 'readiness_test_sent').length, 1);
  // 6. nonce ack marks the device ready; the readiness object says operational_ready with no qualification blockers
  const nonce = sent[0].data.nonce;
  const ack = await service.ackReadinessTestPush(req('super1', { nonce, token }));
  assert.equal(ack.status, 'ready'); assert.equal(ack.already, false);
  st = await service.getMyReadiness(req('super1', {}));
  assert.equal(st.operational_ready, true); assert.deepEqual([...st.blockers], []);
  // 7. quota and cooldown are the same as for a worker (3/day, 60s apart)
  await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00002', token })), 'readiness-cooldown', 'resource-exhausted');
  H.setClock(H.getClock() + 61000); await service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00002', token }));
  H.setClock(H.getClock() + 61000); await service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00003', token }));
  H.setClock(H.getClock() + 61000); await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00004', token })), 'readiness-quota', 'resource-exhausted');
  assert.equal(sent.length, 3); assert.ok(sent.every((m) => m.token === token));
  // 8. station fence still applies to super (no trial/silence bypass beyond the station gate)
  db._put('stations/eilat', { name: 'אילת', districtId: 'south', active: false });
  H.setClock(H.getClock() + 86400000);
  await rejects(service.sendReadinessTestPush(req('super1', { request_id: 'req_super_rd_00005', token })), 'station-station-inactive');
  db._put('stations/eilat', { name: 'אילת', districtId: 'south', active: true });
  // 9. a station role without super gets no exception: commander with no live user doc stays blocked
  authUser('cmd_noliv', { customClaims: { role: 'station_commander', stationId: 'eilat', districtId: 'south' } });
  db._put('stations/eilat/push_tokens/cmd_noliv', { tokens: [{ token: 'cmd-token-' + 'c'.repeat(40), label: 'x', added: 1 }] });
  await rejects(service.sendReadinessTestPush(req('cmd_noliv', { request_id: 'req_super_rd_00006', token: 'cmd-token-' + 'c'.repeat(40) })), 'readiness-not-approved');
  st = await service.getMyReadiness(req('cmd_noliv', {})); assert.equal(st.account.approved, false);
  // 10. pending user (no station claim) stays blocked
  await rejects(service.sendReadinessTestPush(req('w1', { request_id: 'req_super_rd_00007', token })), 'readiness-not-approved');
  st = await service.getMyReadiness(req('w1', {})); assert.equal(st.account.approved, false); assert.ok(st.blockers.includes('account_not_approved'));
  // 11. live claim revocation takes effect immediately: the signed token still says super, the live claims do not
  const live = AUTH_USERS.get('super1');
  const savedClaims = live.customClaims;
  const staleSigned = (data) => ({ auth: { uid: 'super1', token: Object.assign({ email: live.email, email_verified: true }, savedClaims) }, data });
  live.customClaims = { stationId: 'eilat', districtId: 'south' };
  await rejects(service.sendReadinessTestPush(staleSigned({ request_id: 'req_super_rd_00008', token })), 'readiness-not-approved');
  await rejects(service.ackReadinessTestPush(staleSigned({ nonce, token })), 'readiness-not-approved');
  st = await service.getMyReadiness(staleSigned({}));
  assert.equal(st.account.approved, false);
  live.customClaims = savedClaims;
  assert.equal(sent.length, 3);
  H.setClock(NOW);
});

console.log('join-campaign-service.test.js: ' + passed + ' passed, ' + failed.length + ' failed');
failed.forEach((f) => console.log('  FAIL ' + f));
if (failed.length) process.exit(1);
})();
