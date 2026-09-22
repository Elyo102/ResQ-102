'use strict';
/* בדיקות יחידה לחוזה הטהור של קליטה בקישור קבוצתי. הרצה: node functions/join-campaign.test.js */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const c = require('./join-campaign');
const qualifications = require('./schedule-qualifications');

let passed = 0; const failed = [];
function test(name, fn) { try { fn(); passed += 1; } catch (e) { failed.push(name + ' :: ' + (e && e.message)); } }
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const deps = { randomBytes: (n) => crypto.randomBytes(n), hash, timingSafeEqual: crypto.timingSafeEqual };
const NOW = 1_800_000_000_000;
const CATALOG = qualifications.mergeCatalog([]);
const throwsCode = (fn, code) => {
  let caught = null; try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, 'expected throw ' + code); assert.equal(caught.name, 'JoinCampaignError'); assert.equal(caught.code, code);
};
function campaign(over) {
  const t = c.newCampaignToken(deps);
  const doc = c.buildCampaignDoc({ campaign_id: t.campaign_id, allowed_shifts: ['A', 'C'], max_registrations: 2, expires_at_ms: NOW + 86400000, label: 'x' },
    { uid: 'creator', role: 'super' }, { station_id: 'eilat', district_id: 'south' }, t.token_hash, NOW);
  return { token: t, doc: Object.assign(doc, over || {}) };
}

test('token: 60 chars, campaign id + secret, hash only stored', () => {
  const t = c.newCampaignToken(deps);
  assert.equal(t.token.length, 60);
  assert.deepEqual(c.parseToken(t.token), { campaign_id: t.campaign_id, secret: t.secret });
  assert.equal(c.parseToken(t.token + 'x'), null);
  assert.equal(c.parseToken(t.token.replace('.', '_')), null);
  assert.equal(c.parseToken(42), null);
  const doc = c.buildCampaignDoc({ campaign_id: t.campaign_id, allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: NOW + 1000000, label: 'l' },
    { uid: 'u', role: 'hr_coordinator' }, { station_id: 'eilat', district_id: 'south' }, t.token_hash, NOW);
  assert.equal(JSON.stringify(doc).includes(t.secret), false);
  assert.equal(doc.token_hash, hash(t.secret));
  assert.ok(c.tokenMatches(t.secret, doc, deps));
  assert.equal(c.tokenMatches(t.secret.slice(0, 42) + (t.secret.endsWith('A') ? 'B' : 'A'), doc, deps), false);
  assert.equal(c.tokenMatches(t.secret, Object.assign({}, doc, { token_hash: 'zz' }), deps), false);
});

test('create input: exact keys, shifts uppercase only, limits', () => {
  const ok = c.normalizeCreateInput({ label: ' קמפיין ', allowed_shifts: ['C', 'A'], max_registrations: 10, expires_at_ms: NOW + 3600000 }, { is_super: false, now_ms: NOW });
  assert.deepEqual(ok.allowed_shifts, ['A', 'C']); assert.equal(ok.label, 'קמפיין'); assert.equal(ok.station_id, '');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['a'], max_registrations: 1, expires_at_ms: NOW + 3600000 }, { is_super: false, now_ms: NOW }), 'shifts');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A', 'A'], max_registrations: 1, expires_at_ms: NOW + 3600000 }, { is_super: false, now_ms: NOW }), 'shifts');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: [], max_registrations: 1, expires_at_ms: NOW + 3600000 }, { is_super: false, now_ms: NOW }), 'shifts');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 501, expires_at_ms: NOW + 3600000 }, { is_super: false, now_ms: NOW }), 'max');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 0, expires_at_ms: NOW + 3600000 }, { is_super: false, now_ms: NOW }), 'max');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: NOW }, { is_super: false, now_ms: NOW }), 'expires');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: NOW + 31 * 86400000 }, { is_super: false, now_ms: NOW }), 'expires');
  // רכזת: station_id נדחה בשמו
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: NOW + 3600000, station_id: 'other' }, { is_super: false, now_ms: NOW }), 'input');
  // super: חובה
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: NOW + 3600000 }, { is_super: true, now_ms: NOW }), 'station');
  assert.equal(c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: NOW + 3600000, station_id: 'eilat' }, { is_super: true, now_ms: NOW }).station_id, 'eilat');
  throwsCode(() => c.normalizeCreateInput({ label: 'x', allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: NOW + 3600000, role: 'commander' }, { is_super: true, now_ms: NOW }), 'input');
});

test('campaign doc: role fixed firefighter, no cap stored, role of creator restricted', () => {
  const { doc } = campaign();
  assert.equal(doc.default_role, 'firefighter'); assert.equal(doc.created_by_cap, undefined); assert.equal(doc.accepted_count, 0); assert.equal(doc.revision, 1);
  const t = c.newCampaignToken(deps);
  throwsCode(() => c.buildCampaignDoc({ campaign_id: t.campaign_id, allowed_shifts: ['A'], max_registrations: 1, expires_at_ms: 1, label: 'l' }, { uid: 'u', role: 'deputy' }, { station_id: 'eilat', district_id: 'south' }, t.token_hash, NOW), 'actor');
});

test('state derivation: revoked > expired > full > paused > active', () => {
  const { doc } = campaign();
  assert.equal(c.deriveState(doc, NOW), 'active');
  assert.equal(c.deriveState(Object.assign({}, doc, { status: 'paused' }), NOW), 'paused');
  assert.equal(c.deriveState(Object.assign({}, doc, { accepted_count: 2 }), NOW), 'full');
  assert.equal(c.deriveState(Object.assign({}, doc, { accepted_count: 2, status: 'paused' }), NOW), 'full');
  assert.equal(c.deriveState(doc, NOW + 86400000), 'expired');
  assert.equal(c.deriveState(Object.assign({}, doc, { status: 'revoked', accepted_count: 2 }), NOW + 86400000 * 2), 'revoked');
  assert.equal(c.deriveState({ schema: 'other' }, NOW), 'not_found');
  assert.equal(c.deriveState(Object.assign({}, doc, { status: 'weird' }), NOW), 'revoked');
});

test('public view exposes no counts, label, hash or people', () => {
  const { doc } = campaign();
  const v = c.publicView(doc, NOW, 'אילת', CATALOG);
  assert.deepEqual(Object.keys(v).sort(), ['allowed_shifts', 'qualification_catalog', 'state', 'station_name']);
  assert.equal(v.state, 'active'); assert.deepEqual(v.allowed_shifts, ['A', 'C']);
  assert.ok(v.qualification_catalog.some((q) => q.key === 'driver' && q.label === 'נהגים'));
  assert.equal(JSON.stringify(v).includes(doc.token_hash), false);
  const paused = c.publicView(Object.assign({}, doc, { status: 'paused' }), NOW, 'אילת', CATALOG);
  assert.equal(paused.state, 'paused'); assert.deepEqual(paused.allowed_shifts, []); assert.deepEqual(paused.qualification_catalog, []);
  assert.deepEqual(c.publicView(null, NOW, '', []), { state: 'not_found' });
});

test('status actions: revision check, revoke irreversible, transitions', () => {
  const { doc } = campaign();
  assert.equal(c.applyStatusAction(doc, 'pause', 1, NOW).status, 'paused');
  throwsCode(() => c.applyStatusAction(doc, 'resume', 1, NOW), 'transition');
  throwsCode(() => c.applyStatusAction(doc, 'pause', 2, NOW), 'revision');
  const revoked = Object.assign({}, doc, c.applyStatusAction(doc, 'revoke', 1, NOW));
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.revision, 2);
  throwsCode(() => c.applyStatusAction(revoked, 'resume', 2, NOW), 'campaign-revoked');
  throwsCode(() => c.applyStatusAction(doc, 'delete', 1, NOW), 'action');
});

const goodInput = (t, over) => Object.assign({
  request_id: 'req_0123456789abcdef', token: t.token, full_name: 'בודק דמה', phone: '050-1234567', shift: 'A',
  qualifications: [{ key: 'driver', valid_until_ms: NOW + 1000000, reference: 'רישיון C' }, { key: 'hazmat' }],
  ack: { correctness: true, terms_version: 'v1', privacy_version: 'v1' }, note: 'הערה'
}, over || {});

test('redemption input: exact keys, forbidden assignment fields rejected by name', () => {
  const { token: t, doc } = campaign();
  const n = c.normalizeRedemptionInput(goodInput(t), doc, CATALOG, NOW);
  assert.equal(n.campaign_id, t.campaign_id); assert.equal(n.secret, t.secret); assert.equal(n.shift, 'A');
  assert.equal(n.declarations.length, 2); assert.equal(n.declarations[0].status, 'declared'); assert.equal(n.declarations[1].valid_until_ms, null);
  for (const k of c.REDEEM_FORBIDDEN) throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { [k]: 'x' }), doc, CATALOG, NOW), 'client-supplied-plan');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { extra: 1 }), doc, CATALOG, NOW), 'input');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { shift: 'B' }), doc, CATALOG, NOW), 'shift');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { shift: 'a' }), doc, CATALOG, NOW), 'shift');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { token: 'bad' }), doc, CATALOG, NOW), 'campaign-token');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { phone: 'abc' }), doc, CATALOG, NOW), 'phone');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { full_name: '' }), doc, CATALOG, NOW), 'full-name');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { ack: { correctness: false, terms_version: 'v1', privacy_version: 'v1' } }), doc, CATALOG, NOW), 'ack');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { ack: { correctness: true, terms_version: 'v1' } }), doc, CATALOG, NOW), 'ack');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { ack: { correctness: true, terms_version: 'made-up', privacy_version: 'made-up' } }), doc, CATALOG, NOW), 'ack-version');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { qualifications: [{ key: 'nope' }] }), doc, CATALOG, NOW), 'qualification-unknown');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { qualifications: [{ key: 'driver' }, { key: 'driver' }] }), doc, CATALOG, NOW), 'qualification-duplicate');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { qualifications: [{ key: 'driver', valid_until_ms: NOW - 1 }] }), doc, CATALOG, NOW), 'qualification-expired');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { qualifications: [{ key: 'driver', status: 'verified' }] }), doc, CATALOG, NOW), 'qualification-shape');
  const inactive = CATALOG.map((q) => q.key === 'driver' ? Object.assign({}, q, { active: false }) : q);
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t), doc, inactive, NOW), 'qualification-unknown');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { qualifications: Array.from({ length: 21 }, (_, i) => ({ key: 'k' + i })) }), doc, CATALOG, NOW), 'qualifications');
  throwsCode(() => c.normalizeRedemptionInput(goodInput(t, { note: 'x'.repeat(301) }), doc, CATALOG, NOW), 'note');
});

test('registrant doc: no secret/hash, no role', () => {
  const { token: t, doc } = campaign();
  const n = c.normalizeRedemptionInput(goodInput(t), doc, CATALOG, NOW);
  const r = c.buildRegistrant({ uid: 'u1', request_id: n.request_id, campaign_id: t.campaign_id, campaign_revision: 1, station_id: 'eilat',
    invite_id: 'inv1', shift: 'A', declarations: n.declarations, note: n.note, ack: n.ack, now_ms: NOW });
  assert.equal(r.schema, 'join-registrant-v1'); assert.equal(r.review_state, 'none'); assert.equal(r.revision, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'role'), false);
  assert.equal(JSON.stringify(r).includes(t.secret), false); assert.equal(JSON.stringify(r).includes(doc.token_hash), false);
  throwsCode(() => c.buildRegistrant({ uid: 'u1', request_id: n.request_id, campaign_id: t.campaign_id, station_id: 'eilat', invite_id: 'i', shift: 'a', declarations: [], ack: n.ack, now_ms: NOW }), 'registrant');
});

test('replay match requires all stored evidence, rejects foreign station/campaign/uid', () => {
  const { doc } = campaign();
  const invite = { invite_id: 'inv1', redeemed_by: 'u1', redeemed_request_id: 'req_0123456789abcdef' };
  const fp = 'a'.repeat(64);
  const operation = { schema_version: 1, uid: 'u1', request_id: 'req_0123456789abcdef', station_id: 'eilat', stage: 'request_created', invite_id: 'inv1',
    operation_fingerprint: 'b'.repeat(64), assignment_ref: { invite_fingerprint: fp }, provenance: { kind: 'join_campaign', campaign_id: doc.campaign_id } };
  const registry = { schema_version: 1, uid: 'u1', station_id: 'eilat', request_id: 'req_0123456789abcdef', invite_id: 'inv1', operation_fingerprint: 'b'.repeat(64) };
  const stages = ['request_created', 'assignment_completed', 'person_linked'];
  const verifyStoredFingerprint = (inv, expected) => { if (expected !== fp) throw new Error('bad'); };
  const base = { operation, registry, invite, uid: 'u1', request_id: 'req_0123456789abcdef', campaign: doc, stages, verifyStoredFingerprint };
  assert.equal(c.replayMatches(base), true);
  assert.equal(c.replayMatches(Object.assign({}, base, { uid: 'u2' })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { campaign: Object.assign({}, doc, { station_id: 'other' }) })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { campaign: Object.assign({}, doc, { campaign_id: 'AAAAAAAAAAAAAAAA' }) })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { registry: Object.assign({}, registry, { extra: 1 }) })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { invite: Object.assign({}, invite, { redeemed_by: 'u2' }) })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { operation: Object.assign({}, operation, { stage: 'weird' }) })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { operation: Object.assign({}, operation, { provenance: { kind: 'invitation' } }) })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { verifyStoredFingerprint: () => { throw new Error('x'); } })), false);
  assert.equal(c.replayMatches(Object.assign({}, base, { invite: null })), false);
});

test('review actions and declaration verification plans', () => {
  const { token: t, doc } = campaign();
  const n = c.normalizeRedemptionInput(goodInput(t), doc, CATALOG, NOW);
  const r = c.buildRegistrant({ uid: 'u1', request_id: n.request_id, campaign_id: t.campaign_id, station_id: 'eilat', invite_id: 'inv1', shift: 'A', declarations: n.declarations, note: '', ack: n.ack, now_ms: NOW });
  const rv = c.normalizeReviewAction({ campaign_id: t.campaign_id, uid: 'u1', action: 'return', expected_revision: 1, reason: 'חסר טלפון' });
  const ch = c.applyReviewAction(r, rv.action, 1, rv.reason, NOW);
  assert.equal(ch.review_state, 'returned'); assert.equal(ch.revision, 2);
  throwsCode(() => c.normalizeReviewAction({ campaign_id: t.campaign_id, uid: 'u1', action: 'return', expected_revision: 1 }), 'reason');
  throwsCode(() => c.applyReviewAction(r, 'remind', 3, '', NOW), 'revision');
  const rn = c.normalizeReviewAction({ campaign_id: t.campaign_id, uid: 'u1', action: 'reject_note', expected_revision: 1, reason: 'אין התאמה' });
  const rc = c.applyReviewAction(r, rn.action, 1, rn.reason, NOW);
  assert.equal(rc.reject_reason, 'אין התאמה'); assert.equal(rc.review_state, undefined); assert.equal(rc.revision, 2);
  throwsCode(() => c.normalizeReviewAction({ campaign_id: t.campaign_id, uid: 'u1', action: 'reject_note', expected_revision: 1 }), 'reason');
  // verify: only pending; declared (before approval) is refused
  const v = c.normalizeVerifyInput({ campaign_id: t.campaign_id, uid: 'u1', key: 'driver', action: 'verify', expected_revision: 1, request_id: 'req_0123456789abcdef' });
  throwsCode(() => c.planDeclarationUpdate(r, v, NOW, 'super1'), 'declaration-not-pending');
  const promoted = Object.assign({}, r, { declarations: c.promoteDeclarations(r).declarations });
  const plan = c.planDeclarationUpdate(promoted, v, NOW, 'super1');
  assert.equal(plan.declarations[0].status, 'verified'); assert.equal(plan.declarations[0].verified_by, 'super1'); assert.equal(plan.declarations[1].status, 'pending_verification');
  throwsCode(() => c.planDeclarationUpdate(promoted, v, NOW + 2000000, 'super1'), 'declaration-expired');
  throwsCode(() => c.normalizeVerifyInput({ campaign_id: t.campaign_id, uid: 'u1', key: 'driver', action: 'reject', expected_revision: 1, request_id: 'req_0123456789abcdef' }), 'reason');
  throwsCode(() => c.normalizeVerifyInput({ campaign_id: t.campaign_id, uid: 'u1', key: 'driver', action: 'reject', reason: 'לא', expected_revision: 1, request_id: 'req_0123456789abcdef' }), 'reason');
  const rej = c.normalizeVerifyInput({ campaign_id: t.campaign_id, uid: 'u1', key: 'hazmat', action: 'reject', reason: 'אין אסמכתא', expected_revision: 1, request_id: 'req_0123456789abcdef' });
  const rp = c.planDeclarationUpdate(promoted, rej, NOW, 'super1');
  assert.equal(rp.declarations[1].status, 'rejected'); assert.equal(rp.declarations[1].reject_reason, 'אין אסמכתא');
  throwsCode(() => c.normalizeVerifyInput({ campaign_id: t.campaign_id, uid: 'u1', key: 'driver', action: 'verify', expected_revision: 1, request_id: 'req_0123456789abcdef', station_id: 'x' }), 'input');
  // effective status: verified+expired
  assert.equal(c.effectiveDeclarationStatus({ status: 'verified', valid_until_ms: NOW - 1 }, NOW), 'expired');
  assert.equal(c.effectiveDeclarationStatus({ status: 'verified', valid_until_ms: NOW + 1 }, NOW), 'verified');
  assert.deepEqual(c.summarizeDeclarations(plan.declarations, NOW), { verified: 1, pending: 1, rejected: 0, expired: 0, declared: 0 });
});

test('readiness: server-computed, ready only with acked challenge and fresh token', () => {
  const th = hash('tok');
  const base = { approved: true, email_verified: true, tokens: [{ token_hash: th }], declarations: [], now_ms: NOW };
  assert.deepEqual(c.computeReadiness(Object.assign({}, base, { device: null })).blockers, ['device_not_ready']);
  const ready = c.computeReadiness(Object.assign({}, base, { device: { status: 'ready', token_hash: th, acked_at_ms: NOW - 5 } }));
  assert.equal(ready.operational_ready, true); assert.equal(ready.ready_at_ms, NOW - 5);
  const changed = c.computeReadiness(Object.assign({}, base, { device: { status: 'ready', token_hash: hash('other'), acked_at_ms: NOW } }));
  assert.equal(changed.operational_ready, false); assert.deepEqual(changed.blockers, ['push_token_changed']);
  const notApproved = c.computeReadiness(Object.assign({}, base, { approved: false, email_verified: false, tokens: [], device: { status: 'ready', token_hash: th } }));
  assert.deepEqual(notApproved.blockers, ['account_not_approved', 'email_not_verified', 'no_push_token', 'push_token_changed']);
  assert.equal(c.computeReadiness(Object.assign({}, base, { device: { status: 'test_sent', token_hash: th } })).device.status, 'test_sent');
  assert.equal(c.computeReadiness(Object.assign({}, base, { device: { status: 'bogus', token_hash: th } })).device.status, 'not_started');
});

test('readiness gates: quota, cooldown, nonce/token/expiry, idempotent ack', () => {
  const g = c.readinessSendGate(null, NOW, 'd1');
  assert.deepEqual(g, { attempts_today: 1, day_key: 'd1' });
  throwsCode(() => c.readinessSendGate({ attempts_today: 3, day_key: 'd1' }, NOW, 'd1'), 'readiness-quota');
  assert.equal(c.readinessSendGate({ attempts_today: 3, day_key: 'd0' }, NOW, 'd1').attempts_today, 1);
  throwsCode(() => c.readinessSendGate({ attempts_today: 1, day_key: 'd1', last_attempt_at_ms: NOW - 1000 }, NOW, 'd1'), 'readiness-cooldown');
  const nh = hash('n'), th = hash('t');
  throwsCode(() => c.readinessAckGate(null, nh, th, NOW), 'readiness-no-challenge');
  throwsCode(() => c.readinessAckGate({ status: 'test_sent', challenge_hash: hash('x'), token_hash: th, challenge_expires_at_ms: NOW + 1 }, nh, th, NOW), 'readiness-nonce');
  throwsCode(() => c.readinessAckGate({ status: 'test_sent', challenge_hash: nh, token_hash: hash('o'), challenge_expires_at_ms: NOW + 1 }, nh, th, NOW), 'readiness-token');
  throwsCode(() => c.readinessAckGate({ status: 'test_sent', challenge_hash: nh, token_hash: th, challenge_expires_at_ms: NOW }, nh, th, NOW), 'readiness-expired');
  assert.deepEqual(c.readinessAckGate({ status: 'test_sent', challenge_hash: nh, token_hash: th, challenge_expires_at_ms: NOW + 1 }, nh, th, NOW), { already: false });
  assert.deepEqual(c.readinessAckGate({ status: 'ready', challenge_hash: nh, token_hash: th, challenge_expires_at_ms: NOW - 1 }, nh, th, NOW), { already: true });
});

test('readiness: unverified or expired declarations block; rejected ones do not', () => {
  const th = hash('tok');
  const base = { approved: true, email_verified: true, tokens: [{ token_hash: th }], device: { status: 'ready', token_hash: th, acked_at_ms: NOW }, now_ms: NOW };
  assert.deepEqual(c.computeReadiness(Object.assign({}, base, { declarations: [{ key: 'driver', status: 'pending_verification' }] })).blockers, ['qualifications_unverified']);
  assert.deepEqual(c.computeReadiness(Object.assign({}, base, { declarations: [{ key: 'driver', status: 'declared' }] })).blockers, ['qualifications_unverified']);
  assert.deepEqual(c.computeReadiness(Object.assign({}, base, { declarations: [{ key: 'driver', status: 'verified', valid_until_ms: NOW - 1 }] })).blockers, ['qualifications_expired']);
  assert.equal(c.computeReadiness(Object.assign({}, base, { declarations: [{ key: 'driver', status: 'verified', valid_until_ms: NOW + 1 }, { key: 'x', status: 'rejected' }] })).operational_ready, true);
});

test('readiness send decision: same request id replays without a new challenge; failed send may be retried', () => {
  const th = hash('tok');
  const dev = { request_id: 'req_0123456789abcdef', token_hash: th, challenge_hash: 'a'.repeat(64), status: 'test_sent', challenge_expires_at_ms: NOW + 5, attempts_today: 1, day_key: 'd', last_attempt_at_ms: NOW };
  assert.deepEqual(c.readinessSendDecision(dev, 'req_0123456789abcdef', th, NOW + 1, 'd'), { replay: true, status: 'test_sent', expires_at_ms: NOW + 5 });
  throwsCode(() => c.readinessSendDecision(dev, 'req_0123456789abcdef', hash('other-device'), NOW + 1, 'd'), 'request-conflict');
  throwsCode(() => c.readinessSendDecision(dev, 'req_other_00000000000', th, NOW + 1, 'd'), 'readiness-cooldown');
  assert.equal(c.readinessSendDecision(Object.assign({}, dev, { status: 'failed' }), 'req_0123456789abcdef', th, NOW + 61000, 'd').replay, false);
  assert.deepEqual(c.readinessSendDecision(null, 'req_0123456789abcdef', th, NOW, 'd'), { replay: false, attempts_today: 1, day_key: 'd' });
  const v = { campaign_id: 'AAAAAAAAAAAAAAAA', uid: 'u1', key: 'driver', action: 'verify', expected_revision: 1 };
  assert.equal(c.verificationIntentFingerprint(v, 'super1', hash), c.verificationIntentFingerprint(Object.assign({}, v), 'super1', hash));
  for (const over of [{ key: 'hazmat' }, { uid: 'u2' }, { action: 'reject' }, { expected_revision: 2 }, { campaign_id: 'BBBBBBBBBBBBBBBB' }]) {
    assert.notEqual(c.verificationIntentFingerprint(Object.assign({}, v, over), 'super1', hash), c.verificationIntentFingerprint(v, 'super1', hash));
  }
  assert.notEqual(c.verificationIntentFingerprint(v, 'super2', hash), c.verificationIntentFingerprint(v, 'super1', hash));
});

test('holdings after verification: engine order, valid_until kept per key, inactive catalog refused', () => {
  const cat = qualifications.mergeCatalog([]);
  const first = c.holdingsAfterVerification({ holdings: null, key: 'driver', valid_until_ms: NOW + 5, catalog: cat });
  assert.deepEqual(first.qualifications, ['driver']); assert.deepEqual(first.valid_until, { driver: NOW + 5 }); assert.equal(first.revision, 1); assert.equal(first.changed, true);
  const second = c.holdingsAfterVerification({ holdings: { qualifications: ['driver'], revision: 1, valid_until: { driver: NOW + 5 } }, key: 'shift_lead', valid_until_ms: null, catalog: cat });
  assert.deepEqual(second.qualifications, ['shift_lead', 'driver']); assert.deepEqual(second.valid_until, { driver: NOW + 5 }); assert.equal(second.revision, 2);
  const same = c.holdingsAfterVerification({ holdings: { qualifications: ['driver'], revision: 3, valid_until: { driver: NOW + 5 } }, key: 'driver', valid_until_ms: NOW + 5, catalog: cat });
  assert.equal(same.changed, false); assert.equal(same.revision, 4);
  throwsCode(() => c.holdingsAfterVerification({ holdings: null, key: 'driver', valid_until_ms: null, catalog: cat.map((q) => q.key === 'driver' ? Object.assign({}, q, { active: false }) : q) }), 'holdings-unknown');
  throwsCode(() => c.holdingsAfterVerification({ holdings: null, key: 'custom_x', valid_until_ms: null, catalog: cat }), 'holdings-unknown');
  // engine-side filter
  assert.deepEqual(qualifications.effectiveHoldings({ qualifications: ['driver', 'hazmat'], valid_until: { driver: NOW - 1 } }, NOW), ['hazmat']);
  assert.deepEqual(qualifications.retainValidUntil({ valid_until: { driver: 5, hazmat: 6 } }, ['hazmat']), { hazmat: 6 });
});

test('whatsapp message contains link and expiry, no token elsewhere', () => {
  const m = c.whatsappMessage('אילת', 'https://x/login.html?join=abc', NOW);
  assert.ok(m.includes('https://x/login.html?join=abc')); assert.ok(m.includes('אילת')); assert.ok(m.includes('תקף עד'));
});

test('assertNoSecret catches nested secret keys', () => {
  throwsCode(() => c.assertNoSecret({ a: { b: { secret: 'x' } } }, 'doc'), 'secret-leak');
  c.assertNoSecret({ token_hash: 'x', nested: { ok: 1 } }, 'doc');
});

console.log('join-campaign.test.js: ' + passed + ' passed, ' + failed.length + ' failed');
failed.forEach((f) => console.log('  FAIL ' + f));
if (failed.length) process.exit(1);
