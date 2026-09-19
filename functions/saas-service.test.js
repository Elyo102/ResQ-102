'use strict';
/* בדיקות שירות ה-SaaS — Firestore מזויף, ספק חיוב מזויף, חוזה אמיתי.
 * הרצה: node functions/saas-service.test.js */

const assert = require('node:assert/strict');
const H = require('./saas-test-harness');
const { rejects, AUTH_USERS, authUser, req, build, rid, createInput, seedOrg, subOf, NOW, contract, createFakeBillingProvider } = H;

let passed = 0; const failed = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed += 1; }).catch((e) => { failed.push(name + ' :: ' + (e && (e.stack || e.message))); });
}
const snapshot = (db) => JSON.stringify(Array.from(db._store.entries()).sort());
const auditEvent = (db, pred) => Array.from(db._store.values()).find((v) => v && v.schema === contract.AUDIT_SCHEMA && pred(v));
const auditActions = (db, oid) => Array.from(db._store.entries()).filter(([p]) => p.startsWith('organizations/' + oid + '/audit/')).map(([, v]) => v.action);

(async () => {

await test('super creates organization: org + subscription(evaluation) + operation + audit; provider customer created once', async () => {
  const { db, service, billing, audits } = build();
  const input = createInput();
  const res = await service.createOrganization(req('super1', input));
  assert.equal(res.ok, true); assert.equal(res.duplicate, false); assert.equal(res.status, 'evaluation'); assert.equal(res.plan_id, 'evaluation');
  const org = db._get('organizations/org_south');
  assert.equal(org.schema, contract.ORG_SCHEMA); assert.deepEqual(org.station_ids, []); assert.equal(org.created_by, 'super1');
  const sub = subOf(db, 'org_south');
  assert.equal(sub.status, 'evaluation'); assert.equal(sub.provider_customer_id, 'cus_000001'); assert.equal(sub.provider_subscription_id, null);
  assert.ok(db._get('saas_operations/org_south_' + input.request_id));
  assert.deepEqual(auditActions(db, 'org_south'), ['create_organization']);
  assert.equal(audits[0].action, 'saas_create_organization'); assert.equal(audits[0].sealed.duplicate, false);
  assert.equal(billing._calls.filter((c) => c.method === 'createCustomer').length, 1);
});

await test('non-super actors are denied: hr, commander, firefighter, unauthenticated — station claims do not help', async () => {
  const { service } = build();
  await rejects(service.createOrganization(req('hr_eilat', createInput())), 'saas-actor', 'permission-denied');
  await rejects(service.createOrganization(req('cmd_haifa', createInput())), 'saas-actor', 'permission-denied');
  await rejects(service.getOrganizationOverview(req('ff_eilat', { organization_id: 'org_south' })), 'saas-actor', 'permission-denied');
  await rejects(service.listOrganizations(req('hr_eilat', {})), 'saas-actor', 'permission-denied');
  await rejects(service.createOrganization(req(null, createInput())), 'auth', 'unauthenticated');
});

await test('signed super token with revoked live claims is denied (stale) — and a disabled super too', async () => {
  const { service } = build();
  const live = AUTH_USERS.get('super1'); const saved = live.customClaims;
  live.customClaims = { stationId: 'eilat_102' };
  await rejects(service.createOrganization({ auth: { uid: 'super1', token: { super: true, email: 'x' } }, data: createInput() }), 'saas-actor-stale', 'permission-denied');
  live.customClaims = saved; live.disabled = true;
  await rejects(service.createOrganization(req('super1', createInput())), 'saas-actor-stale', 'permission-denied');
  live.disabled = false;
});

await test('client cannot send price/amount/discount/currency/payment status — reason input, nothing written', async () => {
  const { db, service } = build();
  const before = snapshot(db);
  for (const k of ['amount', 'price', 'discount', 'currency', 'payment_status']) {
    const input = createInput(); input[k] = 10;
    await rejects(service.createOrganization(req('super1', input)), 'input', 'invalid-argument');
  }
  await rejects(service.changeSubscriptionPlan(req('super1', { request_id: rid(), organization_id: 'org_south', plan_id: 'district', expected_revision: 1, price: 0 })), 'input', 'invalid-argument');
  assert.equal(snapshot(db), before);
});

await test('identical replay returns the prior receipt with duplicate:true and writes nothing; provider not called again', async () => {
  const { db, service, billing } = build();
  const input = createInput();
  const first = await service.createOrganization(req('super1', input));
  const writes = db._stats.writes, before = snapshot(db), calls = billing._calls.length;
  const again = await service.createOrganization(req('super1', input));
  assert.equal(again.duplicate, true); assert.equal(again.subscription_id, first.subscription_id); assert.equal(again.organization_id, 'org_south');
  assert.equal(db._stats.writes, writes); assert.equal(snapshot(db), before); assert.equal(billing._calls.length, calls);
});

await test('same request_id with a different intent is a request-conflict (already-exists)', async () => {
  const { service } = build();
  const input = createInput();
  await service.createOrganization(req('super1', input));
  await rejects(service.createOrganization(req('super1', Object.assign({}, input, { name: 'שם אחר' }))), 'request-conflict', 'already-exists');
  await rejects(service.createOrganization(req('super1', Object.assign({}, input, { plan_id: 'district' }))), 'request-conflict', 'already-exists');
  const { oid } = await seedOrg(build(), {});
  void oid;
});

await test('duplicate organization id with a fresh request is organization-exists', async () => {
  const { service } = build();
  await service.createOrganization(req('super1', createInput()));
  await rejects(service.createOrganization(req('super1', createInput({ request_id: rid('x') }))), 'organization-exists', 'already-exists');
});

await test('provider failure on createCustomer: no organization, no subscription, audit records the provider code only', async () => {
  const { db, service, billing, audits } = build();
  billing.failNext('createCustomer');
  const input = createInput();
  await rejects(service.createOrganization(req('super1', input)), 'provider', 'unavailable');
  assert.equal(db._get('organizations/org_south'), undefined);
  assert.equal(db._get('saas_operations/org_south_' + input.request_id), undefined);
  const events = auditActions(db, 'org_south');
  assert.deepEqual(events, ['provider_error']);
  const ev = auditEvent(db, (v) => v.action === 'provider_error');
  assert.equal(ev.details.provider_error, 'provider_createCustomer_failed'); assert.equal(JSON.stringify(ev).includes('message'), false);
  assert.equal(audits[0].sealed.provider_error, 'provider_createCustomer_failed');
  // retry with the same request id succeeds (the failed attempt was not committed)
  const ok = await service.createOrganization(req('super1', input));
  assert.equal(ok.duplicate, false); assert.ok(db._get('organizations/org_south'));
});

await test('attach station: index written, quota counted, station data never copied; attach is idempotent per request', async () => {
  const ctx = build(); const { db, service } = ctx;
  await service.createOrganization(req('super1', createInput({ plan_id: 'district' })));
  const a = { request_id: rid('a'), organization_id: 'org_south', station_id: 'eilat_102' };
  const res = await service.attachStationToOrganization(req('super1', a));
  assert.equal(res.station_count, 1); assert.deepEqual(db._get('organizations/org_south').station_ids, ['eilat_102']);
  assert.equal(db._get('organization_station_index/eilat_102').organization_id, 'org_south');
  assert.equal(JSON.stringify(db._get('organizations/org_south')).includes('תחנה א׳'), false, 'station name must not be copied');
  const again = await service.attachStationToOrganization(req('super1', a));
  assert.equal(again.duplicate, true); assert.equal(db._get('organizations/org_south').station_ids.length, 1);
  await rejects(service.attachStationToOrganization(req('super1', Object.assign({}, a, { request_id: rid('b') }))), 'station-attached', 'already-exists');
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid('c'), organization_id: 'org_south', station_id: 'closed_104' })), 'station-inactive');
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid('d'), organization_id: 'org_south', station_id: 'haifa_201' })), 'station-district');
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid('e'), organization_id: 'org_south', station_id: 'nowhere_9' })), 'station-inactive');
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid('f'), organization_id: 'org_none', station_id: 'eilat_102' })), 'organization-missing', 'not-found');
});

await test('a station already indexed to organization A cannot be attached to organization B (client cannot pick the org)', async () => {
  const { db, service } = build();
  await service.createOrganization(req('super1', createInput({ organization_id: 'org_a' })));
  await service.createOrganization(req('super1', createInput({ organization_id: 'org_b', request_id: rid('b') })));
  await service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: 'org_a', station_id: 'eilat_102' }));
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: 'org_b', station_id: 'eilat_102' })), 'station-owned-elsewhere');
  assert.deepEqual(db._get('organizations/org_b').station_ids, []);
  assert.equal(db._get('organization_station_index/eilat_102').organization_id, 'org_a');
});

await test('station quota: evaluation plan allows one station; second attach is quota-exceeded', async () => {
  const { service } = build();
  await service.createOrganization(req('super1', createInput()));
  await service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: 'org_south', station_id: 'eilat_102' }));
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: 'org_south', station_id: 'beersheba_103' })), 'quota-exceeded', 'resource-exhausted');
});

await test('activate (super simulation): evaluation → active via provider checkout; provider subscription id stored, not exposed in views', async () => {
  const ctx = build(); const { db, service, billing } = ctx;
  const { oid } = await seedOrg(ctx, { activate: false });
  const r = await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'activate', expected_revision: 1 }));
  assert.equal(r.status, 'active'); assert.equal(r.revision, 2); assert.equal(r.simulated, true);
  assert.equal(subOf(db, oid).provider_subscription_id, 'sub_000001');
  assert.equal(billing._calls.filter((c) => c.method === 'createCheckout').length, 1);
  const view = await service.getOrganizationOverview(req('super1', { organization_id: oid }));
  assert.equal(view.subscription.provider_linked, true); assert.equal(JSON.stringify(view).includes('sub_000001'), false);
});

await test('provider failure on checkout never yields active: status stays evaluation, revision unchanged, audit has provider code only', async () => {
  const ctx = build(); const { db, service, billing, audits } = ctx;
  const { oid } = await seedOrg(ctx, { activate: false });
  billing.failNext('createCheckout');
  const before = subOf(db, oid);
  const input = { request_id: rid(), organization_id: oid, action: 'activate', expected_revision: 1 };
  await rejects(service.setSubscriptionStatus(req('super1', input)), 'provider', 'unavailable');
  const after = subOf(db, oid);
  assert.equal(after.status, 'evaluation'); assert.equal(after.revision, before.revision); assert.equal(after.provider_subscription_id, null);
  assert.equal(db._get('saas_operations/' + oid + '_' + input.request_id), undefined, 'a failed attempt is not a committed operation');
  const ev = auditEvent(db, (v) => v.action === 'provider_error' && v.organization_id === oid);
  assert.equal(ev.details.provider_error, 'provider_createCheckout_failed'); assert.equal(ev.details.status, 'evaluation');
  assert.equal(audits[audits.length - 1].sealed.provider_error, 'provider_createCheckout_failed');
  // the next attempt (provider healthy) with the same request id activates
  const ok = await service.setSubscriptionStatus(req('super1', input));
  assert.equal(ok.status, 'active'); assert.equal(ok.duplicate, false);
});

await test('status transitions via service: suspend, reactivate, cancel; illegal transitions rejected; replay honoured', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, {});
  await rejects(service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'activate', expected_revision: 2 })), 'transition');
  const s = await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'suspend', expected_revision: 2 }));
  assert.equal(s.status, 'suspended'); assert.equal(subOf(db, oid).status, 'suspended');
  const r = { request_id: rid(), organization_id: oid, action: 'reactivate', expected_revision: 3 };
  const re = await service.setSubscriptionStatus(req('super1', r)); assert.equal(re.status, 'active');
  const dup = await service.setSubscriptionStatus(req('super1', r)); assert.equal(dup.duplicate, true); assert.equal(dup.status, 'active');
  assert.equal(subOf(db, oid).revision, 4);
  const c = await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'cancel', expected_revision: 4 }));
  assert.equal(c.status, 'cancelled');
  assert.equal(ctx.billing._subscriptions.get('sub_000001').status, 'cancelled', 'provider subscription cancelled too');
  await rejects(service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'suspend', expected_revision: 5 })), 'transition');
  const back = await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'reactivate', expected_revision: 5 }));
  assert.equal(back.status, 'active', 'super may reactivate a cancelled subscription');
});

await test('expected_revision mismatch → failed-precondition / revision-mismatch, nothing written', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, {});
  const before = snapshot(db);
  await rejects(service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'suspend', expected_revision: 1 })), 'revision-mismatch', 'failed-precondition');
  await rejects(service.changeSubscriptionPlan(req('super1', { request_id: rid(), organization_id: oid, plan_id: 'district', expected_revision: 9 })), 'revision-mismatch', 'failed-precondition');
  assert.equal(snapshot(db), before);
});

await test('plan change: upgrade with revision; replay; conflict on different plan; downgrade below attached stations blocked', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, { plan_id: 'district', stations: ['eilat_102', 'beersheba_103'] });
  const change = { request_id: rid(), organization_id: oid, plan_id: 'enterprise', expected_revision: 2 };
  const r = await service.changeSubscriptionPlan(req('super1', change));
  assert.equal(r.plan_id, 'enterprise'); assert.equal(r.revision, 3); assert.equal(subOf(db, oid).plan_id, 'enterprise');
  const dup = await service.changeSubscriptionPlan(req('super1', change)); assert.equal(dup.duplicate, true);
  await rejects(service.changeSubscriptionPlan(req('super1', Object.assign({}, change, { plan_id: 'station' }))), 'request-conflict', 'already-exists');
  await rejects(service.changeSubscriptionPlan(req('super1', { request_id: rid(), organization_id: oid, plan_id: 'station', expected_revision: 3 })), 'quota-exceeded', 'resource-exhausted');
  const down = await service.changeSubscriptionPlan(req('super1', { request_id: rid(), organization_id: oid, plan_id: 'district', expected_revision: 3 }));
  assert.equal(down.plan_id, 'district');
  const ev = auditEvent(db, (v) => v.action === 'change_plan' && v.organization_id === oid);
  assert.equal(ev.details.from_plan_id, 'district'); assert.equal(ev.details.upgrade, true);
});

await test('suspended: blocks attach and plan upgrade, deletes nothing, keeps every document and the station index', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, { plan_id: 'district' });
  await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'suspend', expected_revision: 2 }));
  const before = snapshot(db);
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: oid, station_id: 'beersheba_103' })), 'subscription-suspended');
  await rejects(service.changeSubscriptionPlan(req('super1', { request_id: rid(), organization_id: oid, plan_id: 'enterprise', expected_revision: 3 })), 'subscription-suspended');
  assert.equal(snapshot(db), before, 'suspension paths must not write or delete');
  assert.deepEqual(db._get('organizations/' + oid).station_ids, ['eilat_102']);
  assert.equal(db._get('organization_station_index/eilat_102').organization_id, oid);
  // usage still records (operational flows are untouched) — it is only reported as over/under quota
  const u = await service.addUsage({ request_id: rid('u'), station_id: 'eilat_102', metric: 'pushes_per_month', amount: 10 });
  assert.equal(u.ok, true); assert.equal(u.total, 10);
});

await test('cancelled: same blocks as suspended; no deletion; overview still readable', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, { plan_id: 'district' });
  await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'cancel', expected_revision: 2 }));
  const before = snapshot(db);
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: oid, station_id: 'beersheba_103' })), 'subscription-cancelled');
  await rejects(service.changeSubscriptionPlan(req('super1', { request_id: rid(), organization_id: oid, plan_id: 'enterprise', expected_revision: 3 })), 'subscription-cancelled');
  assert.equal(snapshot(db), before);
  const view = await service.getOrganizationOverview(req('super1', { organization_id: oid }));
  assert.equal(view.subscription.status, 'cancelled'); assert.deepEqual(view.organization.station_ids, ['eilat_102']);
});

await test('usage: station A consumes only its own organization; station B (other org) and unindexed station never touch it', async () => {
  const ctx = build(); const { db, service } = ctx;
  await seedOrg(ctx, { create: { organization_id: 'org_a' }, stations: ['eilat_102'] });
  await seedOrg(ctx, { create: { organization_id: 'org_b', request_id: rid('b') }, stations: ['beersheba_103'] });
  const period = contract.usagePeriod(NOW);
  const a = await service.addUsage({ request_id: rid('ua'), station_id: 'eilat_102', metric: 'pushes_per_month', amount: 7 });
  assert.equal(a.organization_id, 'org_a'); assert.equal(a.period, period);
  const b = await service.addUsage({ request_id: rid('ub'), station_id: 'beersheba_103', metric: 'pushes_per_month', amount: 5 });
  assert.equal(b.organization_id, 'org_b');
  assert.equal(db._get('organizations/org_a/usage/' + period).pushes_per_month, 7);
  assert.equal(db._get('organizations/org_b/usage/' + period).pushes_per_month, 5);
  await rejects(service.addUsage({ request_id: rid('uc'), station_id: 'haifa_201', metric: 'pushes_per_month', amount: 1 }), 'station-unindexed', 'not-found');
  assert.equal(db._get('organizations/org_a/usage/' + period).pushes_per_month, 7);
  assert.equal(db._get('organizations/org_b/usage/' + period).pushes_per_month, 5);
});

await test('usage is idempotent per request_id and flags over-quota without blocking', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, { plan_id: 'evaluation' });
  const u = { request_id: rid('u'), station_id: 'eilat_102', metric: 'pushes_per_month', amount: 4999 };
  const first = await service.addUsage(u); assert.equal(first.total, 4999); assert.equal(first.over_quota, false);
  const writes = db._stats.writes;
  const dup = await service.addUsage(u); assert.equal(dup.duplicate, true); assert.equal(dup.total, 4999); assert.equal(db._stats.writes, writes);
  await rejects(service.addUsage(Object.assign({}, u, { amount: 1 })), 'request-conflict', 'already-exists');
  const over = await service.addUsage({ request_id: rid('v'), station_id: 'eilat_102', metric: 'pushes_per_month', amount: 2 });
  assert.equal(over.total, 5001); assert.equal(over.over_quota, true);
  const view = await service.getOrganizationOverview(req('super1', { organization_id: oid }));
  assert.equal(view.quotas.find((q) => q.metric === 'pushes_per_month').over, true);
  assert.equal(view.usage.pushes_per_month, 5001);
});

await test('usage period rolls over by month (UTC)', async () => {
  const ctx = build(); const { db, service } = ctx;
  await seedOrg(ctx, {});
  await service.addUsage({ request_id: rid('m1'), station_id: 'eilat_102', metric: 'storage_mb', amount: 3 });
  H.setClock(NOW + 40 * 86400000);
  await service.addUsage({ request_id: rid('m2'), station_id: 'eilat_102', metric: 'storage_mb', amount: 4 });
  const p1 = contract.usagePeriod(NOW), p2 = contract.usagePeriod(NOW + 40 * 86400000);
  assert.notEqual(p1, p2);
  assert.equal(db._get('organizations/org_south/usage/' + p1).storage_mb, 3);
  assert.equal(db._get('organizations/org_south/usage/' + p2).storage_mb, 4);
  H.setClock(NOW);
});

await test('overview: bounded to 50 audit events, newest first; unknown org not-found; org B not visible through org A id', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, {});
  for (let i = 0; i < 60; i++) db._put('organizations/' + oid + '/audit/ev_pad_' + i, { schema: contract.AUDIT_SCHEMA, event_id: 'ev_pad_' + i, organization_id: oid, action: 'pad', actor_uid: 'x', request_id: null, details: {}, at_ms: NOW + 1000 + i });
  const view = await service.getOrganizationOverview(req('super1', { organization_id: oid }));
  assert.equal(view.audit.length, 50); assert.equal(view.audit[0].at_ms, NOW + 1059);
  assert.equal(view.plan.placeholder_not_agreed, true); assert.equal(view.usage.period, contract.usagePeriod(NOW));
  assert.equal(view.quotas.find((q) => q.metric === 'stations').used, 1);
  await rejects(service.getOrganizationOverview(req('super1', { organization_id: 'org_other' })), 'organization-missing', 'not-found');
  await rejects(service.getOrganizationOverview(req('super1', { organization_id: '../x' })), 'organization-id', 'invalid-argument');
});

await test('list organizations: bounded to 50 with cursor paging', async () => {
  const { db, service } = build();
  for (let i = 0; i < 60; i++) db._put('organizations/org_' + String(i).padStart(3, '0'), { schema: contract.ORG_SCHEMA, organization_id: 'org_' + String(i).padStart(3, '0'), name: 'n', district_id: 'south', station_ids: [], current_subscription_id: 's', revision: 1, created_at_ms: 1, updated_at_ms: 1 });
  const p1 = await service.listOrganizations(req('super1', {}));
  assert.equal(p1.organizations.length, 50); assert.equal(p1.next_cursor, 'org_049');
  const p2 = await service.listOrganizations(req('super1', { cursor: p1.next_cursor, limit: 500 }));
  assert.equal(p2.organizations.length, 10); assert.equal(p2.next_cursor, null);
  const p3 = await service.listOrganizations(req('super1'));
  assert.equal(p3.organizations.length, 50);
});

await test('webhook: valid signature moves status through the server mapping; plan/limits in payload are ignored', async () => {
  const ctx = build(); const { db, service, billing } = ctx;
  const { oid } = await seedOrg(ctx, {});
  const payload = JSON.stringify({ type: 'payment.failed', provider_subscription_id: 'sub_000001', plan_id: 'enterprise', limits: { stations: 999 }, amount: 0 });
  const r = await service.simulateBillingWebhook(req('super1', { request_id: rid('w'), organization_id: oid, payload, signature: billing.signWebhook(payload) }));
  assert.equal(r.status, 'suspended'); assert.equal(r.changed, true);
  const sub = subOf(db, oid);
  assert.equal(sub.status, 'suspended'); assert.equal(sub.plan_id, 'station', 'plan untouched by payload'); assert.equal(sub.revision, 3);
  assert.equal(JSON.stringify(sub).includes('999'), false);
  const recover = JSON.stringify({ type: 'payment.recovered', provider_subscription_id: 'sub_000001' });
  const r2 = await service.simulateBillingWebhook(req('super1', { request_id: rid('w2'), organization_id: oid, payload: recover, signature: billing.signWebhook(recover) }));
  assert.equal(r2.status, 'active');
});

await test('webhook: bad signature rejected, nothing written; foreign subscription id mismatch; cancelled never revived; replay', async () => {
  const ctx = build(); const { db, service, billing } = ctx;
  const { oid } = await seedOrg(ctx, {});
  const payload = JSON.stringify({ type: 'checkout.completed', provider_subscription_id: 'sub_000001' });
  const subBefore = JSON.stringify(subOf(db, oid));
  await rejects(service.simulateBillingWebhook(req('super1', { request_id: rid(), organization_id: oid, payload, signature: 'a'.repeat(64) })), 'webhook-signature', 'permission-denied');
  await rejects(service.simulateBillingWebhook(req('super1', { request_id: rid(), organization_id: oid, payload: payload + ' ', signature: billing.signWebhook(payload) })), 'webhook-signature', 'permission-denied');
  assert.equal(JSON.stringify(subOf(db, oid)), subBefore);
  assert.ok(auditActions(db, oid).includes('webhook_rejected'));
  const foreign = JSON.stringify({ type: 'checkout.completed', provider_subscription_id: 'sub_999999' });
  await rejects(service.simulateBillingWebhook(req('super1', { request_id: rid(), organization_id: oid, payload: foreign, signature: billing.signWebhook(foreign) })), 'webhook-mismatch');
  await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'cancel', expected_revision: 2 }));
  const w = { request_id: rid(), organization_id: oid, payload, signature: billing.signWebhook(payload) };
  const r = await service.simulateBillingWebhook(req('super1', w));
  assert.equal(r.status, 'cancelled'); assert.equal(r.changed, false);
  const dup = await service.simulateBillingWebhook(req('super1', w)); assert.equal(dup.duplicate, true);
  await rejects(service.simulateBillingWebhook(req('hr_eilat', w)), 'saas-actor', 'permission-denied');
});

await test('webhook composed shape (event_type): server composes + signs via the fake provider, then verifies; unlinked subscription refused', async () => {
  const ctx = build(); const { db, service, billing } = ctx;
  const { oid } = await seedOrg(ctx, { activate: false });
  await rejects(service.simulateBillingWebhook(req('super1', { request_id: rid(), organization_id: oid, event_type: 'payment.failed' })), 'webhook-unlinked');
  await service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'activate', expected_revision: 1 }));
  const w = { request_id: rid(), organization_id: oid, event_type: 'payment.failed' };
  const r = await service.simulateBillingWebhook(req('super1', w));
  assert.equal(r.status, 'suspended'); assert.equal(subOf(db, oid).status, 'suspended');
  assert.ok(billing._calls.some((c) => c.method === 'verifyWebhook'));
  const dup = await service.simulateBillingWebhook(req('super1', w)); assert.equal(dup.duplicate, true);
  await rejects(service.simulateBillingWebhook(req('super1', Object.assign({}, w, { event_type: 'payment.recovered' }))), 'request-conflict', 'already-exists');
  await rejects(service.simulateBillingWebhook(req('super1', { request_id: rid(), organization_id: oid, event_type: 'plan.updated' })), 'webhook-event', 'invalid-argument');
  // a provider without signWebhook (real provider) refuses the composed shape
  const real = build({ billing: Object.freeze({ createCustomer: billing.createCustomer, createCheckout: billing.createCheckout, getSubscription: billing.getSubscription, cancelSubscription: billing.cancelSubscription, verifyWebhook: billing.verifyWebhook }) });
  real.db._put('organizations/' + oid, db._get('organizations/' + oid)); real.db._put('organizations/' + oid + '/subscriptions/' + db._get('organizations/' + oid).current_subscription_id, subOf(db, oid));
  await rejects(real.service.simulateBillingWebhook(req('super1', { request_id: rid(), organization_id: oid, event_type: 'payment.recovered' })), 'webhook-sign-unavailable');
});

await test('input shape: unknown keys and station/org key smuggling rejected on every callable', async () => {
  const ctx = build(); const { service } = ctx;
  const { oid } = await seedOrg(ctx, {});
  await rejects(service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'suspend', expected_revision: 2, station_id: 'x' })), 'input', 'invalid-argument');
  await rejects(service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'explode', expected_revision: 2 })), 'action', 'invalid-argument');
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: oid, station_id: 'eilat_102', organization_name: 'x' })), 'input', 'invalid-argument');
  await rejects(service.attachStationToOrganization(req('super1', { request_id: rid(), organization_id: oid, station_id: 'Eilat 102' })), 'station-id', 'invalid-argument');
  await rejects(service.createOrganization(req('super1', JSON.parse('{"request_id":"' + rid() + '","organization_id":"org_x","name":"x","district_id":"south","plan_id":"station","__proto__":{"super":true}}'))), 'input', 'invalid-argument');
  await rejects(service.getOrganizationOverview(req('super1', null)), 'input', 'invalid-argument');
});

await test('no operational collections are touched: only organizations/**, organization_station_index, saas_operations (plus read of stations)', async () => {
  const ctx = build(); const { db, service } = ctx;
  const { oid } = await seedOrg(ctx, { plan_id: 'district' });
  await service.changeSubscriptionPlan(req('super1', { request_id: rid(), organization_id: oid, plan_id: 'enterprise', expected_revision: 2 }));
  await service.addUsage({ request_id: rid('u'), station_id: 'eilat_102', metric: 'active_users', amount: 12 });
  const paths = Array.from(db._store.keys()).filter((p) => !p.startsWith('stations/'));
  assert.ok(paths.length > 0);
  assert.ok(paths.every((p) => /^(organizations\/|organization_station_index\/|saas_operations\/)/.test(p)), paths.join('\n'));
  assert.equal(db._get('stations/eilat_102').name, 'תחנה א׳', 'station document untouched');
  assert.equal(Object.keys(db._get('stations/eilat_102')).length, 4);
});

await test('no PII or provider text in organization audit events; audit event ids are deterministic per request', async () => {
  const ctx = build(); const { db, service, billing } = ctx;
  const { oid } = await seedOrg(ctx, { activate: false });
  billing.failNext('createCheckout');
  await rejects(service.setSubscriptionStatus(req('super1', { request_id: rid(), organization_id: oid, action: 'activate', expected_revision: 1 })), 'provider', 'unavailable');
  const events = Array.from(db._store.entries()).filter(([p]) => p.startsWith('organizations/' + oid + '/audit/')).map(([, v]) => v);
  for (const ev of events) {
    assert.equal(ev.schema, contract.AUDIT_SCHEMA);
    assert.equal(JSON.stringify(ev).includes('@example.test'), false);
    assert.equal(JSON.stringify(ev).includes('failed'), ev.action === 'provider_error');
    assert.ok(Object.values(ev.details).every((v) => typeof v !== 'object' || v === null));
  }
  const ids = new Set(events.map((e) => e.event_id)); assert.equal(ids.size, events.length);
});

await test('billing provider interface is enforced at construction and a provider without verifyWebhook is refused', async () => {
  const { createSaasService } = require('./saas-service');
  const good = build();
  assert.throws(() => createSaasService({ db: good.db, contract, billing: { createCustomer() {} }, fail: H.fail, requireAuth() {}, getAuthUser() {}, openAudit() {}, sealAudit() {}, now() {}, hash: H.hash, serverTimestamp() {}, randomId() {} }), /billing method is required: createCheckout/);
  assert.throws(() => createSaasService({ db: good.db, contract }), /dependency is required: billing/);
  const fake = createFakeBillingProvider({ webhook_secret: 's' });
  assert.throws(() => fake.failNext('nope'), /unknown method/);
  fake.failNext('getSubscription');
  await assert.rejects(fake.getSubscription({ provider_subscription_id: 'x' }), (e) => e.code === 'provider_getSubscription_failed');
  assert.equal(await fake.getSubscription({ provider_subscription_id: 'x' }), null);
  authUser('super2', { customClaims: { super: true } });
  const other = await good.service.listOrganizations(req('super2', {}));
  assert.equal(other.ok, true);
});

await test('the layer is OFF by default: every callable refuses with saas-disabled and writes nothing', async () => {
  const ctx = build({ enabled: false });
  const before = ctx.db._store.size;
  const calls = [
    () => ctx.service.createOrganization(req('super1', createInput({ organization_id: 'org_off' }))),
    () => ctx.service.attachStationToOrganization(req('super1', { request_id: rid('a'), organization_id: 'org_off', station_id: 'eilat_102' })),
    () => ctx.service.changeSubscriptionPlan(req('super1', { request_id: rid('p'), organization_id: 'org_off', plan_id: 'district', expected_revision: 1 })),
    () => ctx.service.setSubscriptionStatus(req('super1', { request_id: rid('s'), organization_id: 'org_off', action: 'activate', expected_revision: 1 })),
    () => ctx.service.simulateBillingWebhook(req('super1', { request_id: rid('w'), organization_id: 'org_off', event_type: 'subscription.activated' })),
    () => ctx.service.getOrganizationOverview(req('super1', { organization_id: 'org_off' })),
    () => ctx.service.listOrganizations(req('super1', {})),
    () => ctx.service.addUsage({ request_id: rid('u'), station_id: 'eilat_102', metric: 'pushes_per_month', amount: 1 })
  ];
  for (const call of calls) await rejects(call(), 'saas-disabled', 'failed-precondition');
  assert.equal(ctx.db._store.size, before, 'a disabled layer wrote a document');
  assert.equal(ctx.billing._calls.length, 0, 'a disabled layer talked to the billing provider');
  assert.equal(ctx.service.enabled, false);
  // רק true מפעיל: כל ערך אחר נשאר כבוי.
  for (const value of [undefined, 'true', 1, null, {}]) {
    assert.equal(build({ enabled: value }).service.enabled, value === true, 'enabled: ' + JSON.stringify(value));
  }
});

await test('cold start between creation and activation: in-memory provider state is lost and activation fails closed', async () => {
  /* הספק המזויף שומר לקוחות ומנויים ב-Map של התהליך. מופע שני של
   * הפונקציה (cold start) מתחיל עם Map ריק, בעוד Firestore זוכר את
   * הארגון. זו בדיוק ההתנהגות הלא עקבית שבגללה השכבה כבויה: יצירה
   * מצליחה, ההפעלה שאחריה נכשלת — והמנוי אינו הופך לפעיל. */
  const instanceOne = build();
  const created = await instanceOne.service.createOrganization(req('super1', createInput({ organization_id: 'org_cold' })));
  await instanceOne.service.attachStationToOrganization(req('super1', { request_id: rid('a'), organization_id: created.organization_id, station_id: 'eilat_102' }));
  assert.ok(instanceOne.billing._customers.size > 0, 'the first instance holds the provider customer in memory');

  // מופע שני: אותו Firestore, ספק חדש וריק.
  const instanceTwo = build({ db: instanceOne.db, billing: createFakeBillingProvider() });
  assert.equal(instanceTwo.billing._customers.size, 0, 'a cold start starts with an empty provider');
  await rejects(instanceTwo.service.setSubscriptionStatus(req('super1',
    { request_id: rid('s'), organization_id: created.organization_id, action: 'activate', expected_revision: 1 })), 'provider', 'unavailable');
  assert.notEqual(subOf(instanceTwo.db, created.organization_id).status, 'active',
    'a subscription must not become active when the provider lost its state');
  assert.equal(subOf(instanceTwo.db, created.organization_id).status, 'evaluation');
});

console.log('saas-service.test.js: ' + passed + ' passed, ' + failed.length + ' failed');
failed.forEach((f) => console.log('  FAIL ' + f));
if (failed.length) process.exit(1);
})();
