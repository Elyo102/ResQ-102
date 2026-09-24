'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const billing = require('./cost-billing-reader');

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const TABLE = 'billing-project.export_data.gcp_billing_export_v1_ABCDEF-123456-ABCDEF';
function configured(overrides = {}) {
  const calls = [];
  const reader = billing.createCostBillingReader({
    enabled: true, table: TABLE, jobProject: 'billing-project',
    projectId: 'station-102', location: 'EU', now: () => NOW,
    query: async (request) => {
      calls.push(request);
      if (request.dryRun) return { totalBytesProcessed: '2048' };
      return { complete: true, rows: [{
        day: '2026-09-23', service: 'Cloud Firestore', currency: 'ILS',
        net_cost: '1.000000001', last_export: '2026-09-24T10:00:00.000Z'
      }] };
    },
    ...overrides
  });
  return { reader, calls };
}

test('disabled reader makes no query and never reports zero cost', async () => {
  const { reader, calls } = configured({ enabled: false });
  const result = await reader.read(7);
  assert.equal(result.available, false);
  assert.equal(result.value, null);
  assert.equal(result.reason, 'billing_not_connected');
  assert.equal(calls.length, 0);
});

test('only an exact safe Billing export identifier and station-102 scope are accepted', async () => {
  for (const patch of [
    { table: 'billing-project.export_data.other_table' },
    { table: TABLE + '` UNION SELECT' },
    { projectId: 'another-project' },
    { location: 'EU; DROP TABLE' },
    { maxBytesBilled: 2 * 1024 * 1024 * 1024 }
  ]) {
    const { reader, calls } = configured(patch);
    assert.equal((await reader.read(7)).available, false);
    assert.equal(calls.length, 0);
  }
});

test('dates and project are typed parameters; a dry-run and byte cap precede the query', async () => {
  const { reader, calls } = configured();
  const result = await reader.read(7);
  assert.equal(result.available, true);
  assert.equal(result.value, '1.000000001');
  assert.equal(result.currency, 'ILS');
  assert.equal(result.as_of, '2026-09-24T10:00:00.000Z');
  assert.equal(result.cost_definition, 'regular_usage_net_of_credits_excludes_tax_and_adjustments');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[1].dryRun, false);
  assert.equal(calls[0].maxBytesBilled, billing.DEFAULT_MAX_BYTES_BILLED);
  assert.equal(calls[0].parameters.project_id, 'station-102');
  assert.equal(calls[0].parameters.end_at, new Date(NOW).toISOString());
  assert.ok(calls[0].sql.includes('cost_type = \'regular\''));
  assert.ok(calls[0].sql.includes('UNNEST(credits)'));
  assert.ok(!calls[0].sql.includes('station-102'));
});

test('budget cap refuses an expensive query without executing it', async () => {
  let executions = 0;
  const { reader } = configured({ query: async ({ dryRun }) => {
    if (!dryRun) executions += 1;
    return { totalBytesProcessed: String(1024 * 1024 * 1024) };
  } });
  const result = await reader.read(7);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'billing_query_over_budget');
  assert.equal(executions, 0);
});

test('empty, unfinished, paged, malformed and multi-currency responses never become zero', async () => {
  for (const response of [
    { complete: true, rows: [] },
    { complete: false, rows: [] },
    { complete: true, pageToken: 'more', rows: [{}] },
    { complete: true, rows: [{ day: '2026-09-23', service: 'Firestore', currency: 'ILS', net_cost: 'bad', last_export: new Date(NOW).toISOString() }] },
    { complete: true, rows: [
      { day: '2026-09-23', service: 'Firestore', currency: 'ILS', net_cost: '1', last_export: new Date(NOW).toISOString() },
      { day: '2026-09-23', service: 'Storage', currency: 'USD', net_cost: '1', last_export: new Date(NOW).toISOString() }
    ] }
  ]) {
    const { reader } = configured({ query: async ({ dryRun }) => dryRun
      ? { totalBytesProcessed: '100' } : response });
    const result = await reader.read(7);
    assert.equal(result.available, false);
    assert.equal(result.value, null);
  }
});

test('provider error and unbounded date range fail closed without leaking details', async () => {
  const { reader, calls } = configured({ query: async () => {
    throw new Error('private BigQuery table and credential');
  } });
  const result = await reader.read(7);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'billing_query_unavailable');
  assert.ok(!JSON.stringify(result).includes('private BigQuery'));
  assert.equal(calls.length, 0);
  assert.equal((await reader.read(31)).reason, 'billing_range_invalid');
});

test('decimal arithmetic retains fractional units without floating-point drift', async () => {
  const { reader } = configured({ query: async ({ dryRun }) => dryRun
    ? { totalBytesProcessed: '100' }
    : { complete: true, rows: [
      { day: '2026-09-23', service: 'Firestore', currency: 'ILS', net_cost: '0.1', last_export: new Date(NOW).toISOString() },
      { day: '2026-09-23', service: 'Storage', currency: 'ILS', net_cost: '0.2', last_export: new Date(NOW).toISOString() }
    ] } });
  assert.equal((await reader.read(7)).value, '0.3');
});
