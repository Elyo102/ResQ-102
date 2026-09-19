'use strict';
/* בדיקות החוזה הטהור של שכבת ה-SaaS. הרצה: node functions/saas-contract.test.js */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('./saas-contract');

const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
let passed = 0; const failed = [];
function test(name, fn) { try { fn(); passed += 1; } catch (e) { failed.push(name + ' :: ' + (e && (e.stack || e.message))); } }
function throwsCode(fn, code, httpCode) {
  let caught = null; try { fn(); } catch (e) { caught = e; }
  assert.ok(caught, 'expected SaasError ' + code);
  assert.equal(caught.name, 'SaasError'); assert.equal(caught.code, code, 'code ' + caught.code + ' expected ' + code);
  if (httpCode) assert.equal(caught.httpCode, httpCode);
}
const RID = 'req_0123456789abcdef';
const sub = (over) => Object.assign({ schema: C.SUBSCRIPTION_SCHEMA, subscription_id: 'sub_1', organization_id: 'org_a', plan_id: 'station', status: 'active', revision: 3 }, over || {});

test('catalog is frozen, placeholder-labelled, and every plan carries all four metrics', () => {
  assert.ok(Object.isFrozen(C.PLANS) && Object.isFrozen(C.PLANS.station));
  for (const id of C.PLAN_IDS) { assert.equal(C.PLANS[id].placeholder_not_agreed, true); C.METRICS.forEach((m) => assert.ok(Number.isInteger(C.PLANS[id][m]) && C.PLANS[id][m] > 0)); }
  assert.deepEqual(C.STATUSES, ['evaluation', 'active', 'suspended', 'cancelled']);
  assert.equal(C.STATUSES.indexOf('trial'), -1, 'trial is reserved for the push/callout trial mode');
});
test('create input: exact keys, slug ids, plan from catalog only', () => {
  const out = C.validateOrganizationInput({ request_id: RID, organization_id: 'org_a', name: '  ארגון  בדיקה ', district_id: 'south', plan_id: 'station' });
  assert.equal(out.name, 'ארגון בדיקה'); assert.equal(out.plan_id, 'station');
  throwsCode(() => C.validateOrganizationInput({ request_id: RID, organization_id: 'Org A', name: 'x', district_id: 'south', plan_id: 'station' }), 'organization-id', 'invalid-argument');
  throwsCode(() => C.validateOrganizationInput({ request_id: RID, organization_id: 'org_a', name: 'x', district_id: 'south', plan_id: 'gold' }), 'plan', 'invalid-argument');
  throwsCode(() => C.validateOrganizationInput({ request_id: 'short', organization_id: 'org_a', name: 'x', district_id: 'south', plan_id: 'station' }), 'request-id', 'invalid-argument');
  throwsCode(() => C.validateOrganizationInput({ request_id: RID, organization_id: 'org_a', name: 'x', district_id: 'south', plan_id: 'station', extra: 1 }), 'input', 'invalid-argument');
  throwsCode(() => C.validateOrganizationInput(null), 'input', 'invalid-argument');
});
test('client-supplied commercial fields are rejected by name with reason input', () => {
  for (const k of ['amount', 'price', 'discount', 'currency', 'payment_status', 'status', 'limits', 'provider_subscription_id']) {
    const input = { request_id: RID, organization_id: 'org_a', name: 'x', district_id: 'south', plan_id: 'station' }; input[k] = 1;
    let caught = null; try { C.validateOrganizationInput(input); } catch (e) { caught = e; }
    assert.ok(caught && caught.code === 'input' && caught.httpCode === 'invalid-argument' && caught.message.includes('השדה ' + k), 'commercial key must be rejected by name: ' + k);
    const change = { request_id: RID, organization_id: 'org_a', plan_id: 'district', expected_revision: 1 }; change[k] = 'x';
    caught = null; try { C.validatePlanChangeInput(change); } catch (e) { caught = e; }
    assert.ok(caught && caught.code === 'input' && caught.message.includes('השדה ' + k), 'commercial key must be rejected by name on plan change: ' + k);
  }
});
test('unsafe keys (__proto__/constructor/prototype) are rejected at any depth', () => {
  const evil = JSON.parse('{"request_id":"' + RID + '","organization_id":"org_a","name":"x","district_id":"south","plan_id":"station","__proto__":{"x":1}}');
  throwsCode(() => C.validateOrganizationInput(evil), 'input', 'invalid-argument');
  throwsCode(() => C.assertSafeKeys({ a: { b: { constructor: 1 } } }, 'x'), 'input', 'invalid-argument');
  throwsCode(() => C.buildAuditEvent({ event_id: 'e', organization_id: 'o', action: 'a', details: JSON.parse('{"prototype":1}'), now_ms: 1 }), 'input');
});
test('quotaCheck: within, at limit, over, per metric, negative delta rejected', () => {
  const p = C.PLANS.evaluation;
  assert.equal(C.quotaCheck(p, { stations: 0 }, { stations: 1 }).ok, true);
  assert.equal(C.quotaCheck(p, { stations: 1 }, { stations: 1 }).ok, false);
  const r = C.quotaCheck(p, { pushes_per_month: 4999, storage_mb: 100 }, { pushes_per_month: 2 });
  assert.equal(r.ok, false); assert.deepEqual(r.violations.map((v) => v.metric), ['pushes_per_month']);
  assert.equal(r.violations[0].limit, 5000); assert.equal(r.violations[0].current, 4999);
  throwsCode(() => C.quotaCheck(p, {}, { stations: -1 }), 'delta', 'invalid-argument');
  assert.equal(C.quotaCheck(p, null, null).ok, true);
});
test('quotaView reports used/remaining/over for each metric, stations from count', () => {
  const v = C.quotaView(C.PLANS.station, { pushes_per_month: 50001 }, 1);
  assert.equal(v.length, 4); assert.equal(v[0].metric, 'stations'); assert.equal(v[0].used, 1); assert.equal(v[0].remaining, 0);
  assert.equal(v.find((x) => x.metric === 'pushes_per_month').over, true);
});
test('status transitions: table matches the closed product rules', () => {
  const ok = (from, action) => C.applyStatusAction(sub({ status: from }), action, 3, 5, { is_super: true }).status;
  assert.equal(ok('evaluation', 'activate'), 'active');
  assert.equal(ok('active', 'suspend'), 'suspended');
  assert.equal(ok('evaluation', 'suspend'), 'suspended');
  assert.equal(ok('suspended', 'reactivate'), 'active');
  assert.equal(ok('active', 'cancel'), 'cancelled');
  assert.equal(ok('cancelled', 'reactivate'), 'active');
  throwsCode(() => C.applyStatusAction(sub({ status: 'active' }), 'activate', 3, 5, { is_super: true }), 'transition');
  throwsCode(() => C.applyStatusAction(sub({ status: 'cancelled' }), 'suspend', 3, 5, { is_super: true }), 'transition');
  throwsCode(() => C.applyStatusAction(sub({ status: 'cancelled' }), 'cancel', 3, 5, { is_super: true }), 'transition');
  throwsCode(() => C.applyStatusAction(sub(), 'explode', 3, 5, { is_super: true }), 'action', 'invalid-argument');
});
test('cancelled reactivation requires a super actor; revision mismatch is failed-precondition', () => {
  throwsCode(() => C.applyStatusAction(sub({ status: 'cancelled' }), 'reactivate', 3, 5, { is_super: false }), 'cancelled-reactivation', 'permission-denied');
  throwsCode(() => C.applyStatusAction(sub({ status: 'cancelled' }), 'reactivate', 3, 5, null), 'cancelled-reactivation', 'permission-denied');
  throwsCode(() => C.applyStatusAction(sub(), 'suspend', 2, 5, { is_super: true }), 'revision-mismatch', 'failed-precondition');
  const out = C.applyStatusAction(sub(), 'suspend', 3, 5, { is_super: true });
  assert.equal(out.revision, 4); assert.equal(out.updated_at_ms, 5);
});
test('plan change: revision, unchanged, downgrade below attached stations, suspended/cancelled cannot upgrade', () => {
  assert.equal(C.applyPlanChange(sub(), 'district', 3, 1, 5).plan_id, 'district');
  assert.equal(C.applyPlanChange(sub(), 'district', 3, 1, 5).upgrade, true);
  throwsCode(() => C.applyPlanChange(sub(), 'district', 2, 1, 5), 'revision-mismatch', 'failed-precondition');
  throwsCode(() => C.applyPlanChange(sub(), 'station', 3, 1, 5), 'plan-unchanged');
  throwsCode(() => C.applyPlanChange(sub({ plan_id: 'district' }), 'station', 3, 2, 5), 'quota-exceeded', 'resource-exhausted');
  throwsCode(() => C.applyPlanChange(sub({ status: 'suspended' }), 'district', 3, 1, 5), 'subscription-suspended');
  throwsCode(() => C.applyPlanChange(sub({ status: 'cancelled' }), 'district', 3, 1, 5), 'subscription-cancelled');
  assert.equal(C.applyPlanChange(sub({ status: 'suspended' }), 'evaluation', 3, 1, 5).plan_id, 'evaluation', 'downgrade while suspended is allowed');
  throwsCode(() => C.applyPlanChange(sub(), 'gold', 3, 1, 5), 'plan', 'invalid-argument');
});
test('webhook mapping is server-side only and never revives a cancelled subscription', () => {
  assert.equal(C.webhookStatusFor('checkout.completed', 'evaluation'), 'active');
  assert.equal(C.webhookStatusFor('payment.failed', 'active'), 'suspended');
  assert.equal(C.webhookStatusFor('payment.recovered', 'suspended'), 'active');
  assert.equal(C.webhookStatusFor('subscription.cancelled', 'active'), 'cancelled');
  assert.equal(C.webhookStatusFor('checkout.completed', 'cancelled'), null);
  assert.equal(C.webhookStatusFor('payment.recovered', 'cancelled'), null);
  assert.equal(C.webhookStatusFor('payment.recovered', 'active'), null);
  throwsCode(() => C.webhookStatusFor('plan.updated', 'active'), 'webhook-event', 'invalid-argument');
});
test('suspended and cancelled block new commercial resources', () => {
  C.assertCanCreateCommercialResource(sub({ status: 'evaluation' }));
  C.assertCanCreateCommercialResource(sub({ status: 'active' }));
  throwsCode(() => C.assertCanCreateCommercialResource(sub({ status: 'suspended' })), 'subscription-suspended');
  throwsCode(() => C.assertCanCreateCommercialResource(sub({ status: 'cancelled' })), 'subscription-cancelled');
});
test('intent fingerprints are sha256, stable, and sensitive to every field', () => {
  const change = { organization_id: 'org_a', plan_id: 'district', expected_revision: 2 };
  const a = C.planChangeIntentFingerprint(change, 'super1', hash);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, C.planChangeIntentFingerprint(change, 'super1', hash));
  assert.notEqual(a, C.planChangeIntentFingerprint(Object.assign({}, change, { plan_id: 'enterprise' }), 'super1', hash));
  assert.notEqual(a, C.planChangeIntentFingerprint(Object.assign({}, change, { expected_revision: 3 }), 'super1', hash));
  assert.notEqual(a, C.planChangeIntentFingerprint(change, 'super2', hash));
  assert.notEqual(C.statusIntentFingerprint({ organization_id: 'o', action: 'suspend', expected_revision: 1 }, 'u', hash), C.statusIntentFingerprint({ organization_id: 'o', action: 'cancel', expected_revision: 1 }, 'u', hash));
  throwsCode(() => C.planChangeIntentFingerprint(change, 'u', () => 'nope'), 'hash', 'internal');
});
test('usage period is YYYY-MM in UTC; usage input rejects stations metric and bad amounts', () => {
  assert.equal(C.usagePeriod(Date.UTC(2027, 0, 15)), '2027-01');
  assert.equal(C.usagePeriod(Date.UTC(2026, 11, 31, 23, 59)), '2026-12');
  assert.ok(C.PERIOD_RE.test(C.usagePeriod(1_800_000_000_000)));
  assert.equal(C.validateUsageInput({ request_id: RID, station_id: 'eilat_102', metric: 'pushes_per_month', amount: 3 }).amount, 3);
  throwsCode(() => C.validateUsageInput({ request_id: RID, station_id: 'eilat_102', metric: 'stations', amount: 1 }), 'metric', 'invalid-argument');
  throwsCode(() => C.validateUsageInput({ request_id: RID, station_id: 'eilat_102', metric: 'storage_mb', amount: 0 }), 'amount', 'invalid-argument');
  throwsCode(() => C.validateUsageInput({ request_id: RID, station_id: 'eilat_102', metric: 'storage_mb', amount: 1.5 }), 'amount', 'invalid-argument');
});
test('list input bounded to 50 with optional slug cursor; overview exact key', () => {
  assert.equal(C.validateListInput(undefined).limit, 50);
  assert.equal(C.validateListInput({ limit: 500 }).limit, 50);
  assert.equal(C.validateListInput({ limit: 5, cursor: 'org_a' }).cursor, 'org_a');
  throwsCode(() => C.validateListInput({ cursor: 'Bad Cursor' }), 'organization-id', 'invalid-argument');
  throwsCode(() => C.validateOverviewInput({ organization_id: 'org_a', station_id: 'x' }), 'input', 'invalid-argument');
});
test('webhook input: bounded payload string + hex64 signature', () => {
  const sig = 'a'.repeat(64);
  assert.equal(C.validateWebhookInput({ request_id: RID, organization_id: 'org_a', payload: '{}', signature: sig }).signature, sig);
  throwsCode(() => C.validateWebhookInput({ request_id: RID, organization_id: 'org_a', payload: {}, signature: sig }), 'webhook-payload', 'invalid-argument');
  throwsCode(() => C.validateWebhookInput({ request_id: RID, organization_id: 'org_a', payload: '{}', signature: 'zz' }), 'webhook-signature', 'invalid-argument');
  throwsCode(() => C.validateWebhookInput({ request_id: RID, organization_id: 'org_a', payload: 'x'.repeat(5000), signature: sig }), 'webhook-payload', 'invalid-argument');
});
test('documents: org holds ids only (no station data), subscription starts in evaluation, audit event keeps scalars only', () => {
  const created = C.validateOrganizationInput({ request_id: RID, organization_id: 'org_a', name: 'x', district_id: 'south', plan_id: 'district' });
  const org = C.buildOrganizationDoc(created, 'super1', 'sub_1', 7);
  assert.deepEqual(org.station_ids, []); assert.equal(org.current_subscription_id, 'sub_1'); assert.equal(org.revision, 1);
  assert.equal(Object.keys(org).some((k) => /name_|claims|role/.test(k)), false);
  const s = C.buildSubscriptionDoc(created, 'sub_1', 'cus_1', 7);
  assert.equal(s.status, 'evaluation'); assert.equal(s.provider_subscription_id, null); assert.equal(s.plan_id, 'district');
  const ev = C.buildAuditEvent({ event_id: 'e1', organization_id: 'org_a', action: 'x', actor_uid: 'u', request_id: RID, details: { code: 'provider_x', nested: { secret: 1 }, msg: 'y'.repeat(500) }, now_ms: 7 });
  assert.equal(ev.details.nested, undefined); assert.equal(ev.details.msg.length, 120); assert.equal(ev.details.code, 'provider_x');
  assert.equal(Object.getPrototypeOf(ev.details), Object.prototype);
});
test('views expose no provider ids', () => {
  const v = C.subscriptionView(sub({ provider_subscription_id: 'sub_000001', provider_customer_id: 'cus_1' }));
  assert.equal(v.provider_linked, true); assert.equal('provider_subscription_id' in v, false); assert.equal('provider_customer_id' in v, false);
});
test('module surface is frozen', () => { assert.ok(Object.isFrozen(C)); assert.ok(Object.isFrozen(C.TRANSITIONS)); assert.ok(Object.isFrozen(C.WEBHOOK_STATUS)); });

console.log('saas-contract.test.js: ' + passed + ' passed, ' + failed.length + ' failed');
failed.forEach((f) => console.log('  FAIL ' + f));
if (failed.length) process.exit(1);
