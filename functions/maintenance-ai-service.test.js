'use strict';

const assert = require('node:assert/strict');
const core = require('./maintenance-diagnosis');
const { createMaintenanceAiService } = require('./maintenance-ai-service');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write('ok - ' + name + '\n');
  } catch (error) {
    process.stderr.write('not ok - ' + name + '\n');
    throw error;
  }
}

const diagnosis = () => core.diagnoseMaintenance({ signals: [
  { source:'health', code:'MAIL_DELIVERY_FAILURES', count:2, age_minutes:4 },
  { source:'incident', code:'CALLABLE_UNAVAILABLE', count:5, age_minutes:1 }
] });

function validResponse(value = diagnosis()) {
  return {
    schema_version:1,
    fingerprint:value.fingerprint,
    assessment_code:value.assessment_code,
    severity:value.severity,
    state:value.state,
    runbook_codes:value.runbook_codes.slice(),
    confidence:'HIGH',
    evidence_codes:value.evidence.map((row) => row.code)
  };
}

(async () => {
  await test('disabled service never invokes the provider', async () => {
    let calls = 0;
    const service = createMaintenanceAiService({ invokeModel:async () => { calls++; } });
    const result = await service.advise({ enabled:false, diagnosis:diagnosis() });
    assert.equal(result.source, 'deterministic');
    assert.equal(result.reason, 'AI_DISABLED');
    assert.equal(calls, 0);
  });

  await test('valid response is accepted without changing the deterministic diagnosis', async () => {
    const source = diagnosis();
    const service = createMaintenanceAiService({ invokeModel:async () => validResponse(source) });
    const result = await service.advise({ enabled:true, diagnosis:source });
    assert.equal(result.source, 'ai');
    assert.equal(result.advisory.fingerprint, source.fingerprint);
    assert.equal(result.diagnosis, source);
  });

  for (const [name, mutate] of [
    ['wrong fingerprint', (r) => { r.fingerprint = 'a'.repeat(64); }],
    ['foreign runbook', (r) => { r.runbook_codes = ['REVIEW_AUTH_CONFIGURATION']; }],
    ['missing evidence', (r) => { r.evidence_codes = r.evidence_codes.slice(0, 1); }],
    ['invented field', (r) => { r.command = 'deploy'; }],
    ['changed assessment', (r) => { r.assessment_code = 'NO_ACTIONABLE_FINDING'; }]
  ]) {
    await test(name + ' fails closed to deterministic output', async () => {
      const source = diagnosis(); const response = validResponse(source); mutate(response);
      const service = createMaintenanceAiService({ invokeModel:async () => response });
      const result = await service.advise({ enabled:true, diagnosis:source });
      assert.equal(result.source, 'deterministic');
      assert.equal(result.reason, 'AI_UNAVAILABLE_OR_INVALID');
    });
  }

  await test('provider failure fails closed without retry', async () => {
    let calls = 0;
    const service = createMaintenanceAiService({ invokeModel:async () => { calls++; throw new Error('offline'); } });
    const result = await service.advise({ enabled:true, diagnosis:diagnosis() });
    assert.equal(result.source, 'deterministic');
    assert.equal(calls, 1);
  });

  await test('timeout fails closed while passing a bounded provider deadline', async () => {
    let observed = 0;
    let cancelled = false;
    let aborted = false;
    const service = createMaintenanceAiService({
      timeout_ms:500,
      invokeModel:async ({ timeout_ms, signal }) => {
        observed = timeout_ms;
        signal.addEventListener('abort', () => { aborted = true; }, { once:true });
        return new Promise(() => {});
      },
      scheduleTimeout:(fn) => { fn(); return 7; },
      cancelTimeout:(handle) => { assert.equal(handle, 7); cancelled = true; }
    });
    const result = await service.advise({ enabled:true, diagnosis:diagnosis() });
    assert.equal(result.source, 'deterministic');
    assert.equal(observed, 500);
    assert.equal(cancelled, true);
    assert.equal(aborted, true);
  });

  await test('successful provider response cancels the timeout handle', async () => {
    let cancelled = false;
    const service = createMaintenanceAiService({
      invokeModel:async ({ signal }) => { assert.equal(signal.aborted, false); return validResponse(); },
      scheduleTimeout:() => 9,
      cancelTimeout:(handle) => { assert.equal(handle, 9); cancelled = true; }
    });
    const result = await service.advise({ enabled:true, diagnosis:diagnosis() });
    assert.equal(result.source, 'ai');
    assert.equal(cancelled, true);
  });

  await test('invalid deterministic input is rejected before the provider boundary', async () => {
    let calls = 0;
    const service = createMaintenanceAiService({ invokeModel:async () => { calls++; } });
    await assert.rejects(() => service.advise({ enabled:true, diagnosis:{ state:'SUGGEST' } }),
      /valid deterministic diagnosis/);
    assert.equal(calls, 0);
  });

  process.stdout.write('maintenance AI service tests passed: ' + passed + '\n');
})().catch((error) => { console.error(error); process.exit(1); });
