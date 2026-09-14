import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'schedule-management.js'), 'utf8');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0, `missing source boundary: ${from}`);
  assert.ok(end > start, `missing source boundary: ${to}`);
  return source.slice(start, end);
}

function ids() {
  let value = 0;
  return {
    crypto: {
      randomUUID() {
        value += 1;
        return String(value).padStart(32, '0');
      }
    }
  };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(error);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

await test('publish keeps one request_id for a lost response and changes it for a new intent', () => {
  const code = section('function requestId(prefix)', '\nfunction node(tag, className, text)');
  const state = { publishRequestId:null, publishRequestKey:null };
  const api = new Function('state', 'globalThis', `${code}\nreturn { requestIdForPublication, resetPublishRequest };`)(state, ids());

  const first = api.requestIdForPublication('draft_a', 'digest_a', 'publish');
  // A transport failure is deliberately represented by doing nothing: no
  // terminal receipt was received, so retained retry state must survive.
  const retry = api.requestIdForPublication('draft_a', 'digest_a', 'publish');
  assert.equal(retry, first, 'lost publish response generated a second request_id');

  const changedIntent = api.requestIdForPublication('draft_b', 'digest_b', 'publish');
  assert.notEqual(changedIntent, retry, 'a different reviewed draft reused the prior request_id');

  api.resetPublishRequest();
  const afterTerminalReceipt = api.requestIdForPublication('draft_b', 'digest_b', 'publish');
  assert.notEqual(afterTerminalReceipt, changedIntent,
    'a terminal publish receipt did not release the completed request_id');
});

await test('planner retries a lost response with the same request_id and releases it after success', async () => {
  const requestIdSource = section('function requestId(prefix)', '\n/* ⭐ 42H.2');
  const plannerSource = section('async function runPlanner()', '\nasync function publishDraft()');
  const calls = [];
  const replies = [
    { reject:Object.assign(new Error('response lost'), { code:'functions/unavailable' }) },
    { data:{ draft_id:'draft_1', from:'2026-10-01', to:'2026-11-30', summary:{ filled:62 } } },
    { data:{ draft_id:'draft_2', from:'2026-10-01', to:'2026-11-30', summary:{ filled:62 } } }
  ];
  const call = {
    async run(payload) {
      calls.push(structuredClone(payload));
      const next = replies.shift();
      if (next.reject) throw next.reject;
      return next;
    }
  };
  const elements = {
    runPlanner:{ disabled:false }, publish:{ disabled:false },
    reviewDraft:{ checked:true, disabled:false },
    draftPreviewCard:{ classList:{ add() {} } },
    startMonth:{ value:'2026-10' }, months:{ value:'2' }
  };
  const state = { busy:false, draft:null, draftPreview:null, plannerPending:null };
  const factory = new Function(
    'state', 'globalThis', 'call', '$', 'authTask', 'authTaskCurrent',
    'resetPublishRequest', 'message', 'overrides', 'renderSummary', 'loadDraftPreview',
    'errorText', 'errorCode', 'receiptOk', 'malformedReceipt', 'updatePublishAvailability',
    'updatePlannerPendingLock', 'scheduleMutationAllowed',
    `${requestIdSource}\n${plannerSource}\nreturn runPlanner;`
  );
  const planner = factory(
    state, ids(), call, (id) => elements[id], () => ({}), () => true,
    () => {}, () => {}, () => [{ date:'2026-10-03', person:'person_1' }],
    () => {}, async () => {}, (error) => String(error && error.message || error),
    (error) => String(error && error.details && error.details.schedule_code || ''),
    (result, fields) => !!result && fields.every((field) => typeof result[field] === 'string' && result[field]),
    () => new Error('malformed receipt'), () => {}, () => {}, () => true
  );

  await planner(); // The operation may have committed, but the response was lost.
  assert.equal(calls.length, 1);
  assert.match(calls[0].request_id, /^draft_/);

  await planner(); // Same form and overrides: resend the same logical request.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request_id, calls[0].request_id,
    'lost planner response generated a second request_id');
  assert.deepEqual(calls[1], calls[0],
    'planner retry changed fields in addition to its request_id');

  await planner(); // The preceding valid receipt ended that intent.
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].request_id, calls[1].request_id,
    'a new planner intent reused a completed request_id');
  assert.deepEqual(
    Object.assign({}, calls[2], { request_id:calls[1].request_id }),
    calls[1],
    'the new-intent assertion changed more than the request_id'
  );
});

await test('rollback retries a lost response with the same request_id and releases it after success', async () => {
  const requestIdSource = section('function requestId(prefix)', '\n/* ⭐ 42H.2');
  const rollbackSource = section('async function rollbackSchedule()', '\nasync function loadSetup(');
  const calls = [];
  const replies = [
    { reject:Object.assign(new Error('response lost'), { code:'functions/unavailable' }) },
    { data:{ publication_id:'rollback_1', revision:8 } },
    { data:{ publication_id:'rollback_2', revision:9 } }
  ];
  const statusAfterFirstSuccess = {
    mode:'new', manager:true,
    active:{ publication_id:'active_2', previous_publication_id:'active_1', revision:8, can_rollback:true }
  };
  const statusAfterSecondSuccess = {
    mode:'new', manager:true,
    active:{ publication_id:'active_3', previous_publication_id:'active_2', revision:9, can_rollback:true }
  };
  const statuses = [statusAfterFirstSuccess, statusAfterSecondSuccess];
  const call = {
    async rollback(payload) {
      calls.push(structuredClone(payload));
      const next = replies.shift();
      if (next.reject) throw next.reject;
      return next;
    },
    async status() { return { data:statuses.shift() }; }
  };
  const rollbackButton = { disabled:false };
  const state = {
    busy:false,
    status:{
      mode:'new', manager:true,
      active:{ publication_id:'active_1', previous_publication_id:'active_0', revision:7, can_rollback:true }
    }
  };
  const factory = new Function(
    'state', 'globalThis', 'call', '$', 'authTask', 'authTaskCurrent', 'confirm',
    'setRollbackAvailability', 'message', 'errorCode', 'gapText', 'errorText',
    'receiptOk', 'malformedReceipt',
    'setMode', 'updateEditAvailability', 'invalidateRange', 'loadMine', 'loadMineRange',
    'loadStationRange', 'scheduleMutationAllowed',
    `${requestIdSource}\n${rollbackSource}\nreturn rollbackSchedule;`
  );
  const rollback = factory(
    state, ids(), call, () => rollbackButton, () => ({}), () => true, () => true,
    () => {}, () => {}, (error) => String(error && error.details && error.details.schedule_code || ''),
    () => '', (error) => String(error && error.message || error),
    (result, fields) => !!result && fields.every((field) => {
      const value = result[field];
      return typeof value === 'string' ? value.length > 0 : Number.isInteger(value);
    }), () => new Error('malformed receipt'), () => {}, () => {},
    () => {}, async () => {}, async () => {}, async () => {}, () => true
  );

  await rollback(); // The server committed or may have committed, but its reply was lost.
  assert.equal(calls.length, 1);
  assert.match(calls[0].request_id, /^rollback_/);

  await rollback(); // Same user intent: resend exactly the same logical request.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request_id, calls[0].request_id,
    'lost rollback response generated a second request_id');
  assert.deepEqual(calls[1], calls[0],
    'rollback retry changed fields in addition to its request_id');

  await rollback(); // Prior success is terminal; the active pointer now defines a new intent.
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].request_id, calls[1].request_id,
    'a new rollback intent reused a completed request_id');
  assert.equal(calls[2].expected_active_publication_id, 'active_2');
  assert.equal(calls[2].target_publication_id, 'active_1');
});

console.log(`schedule request-id retry source: ${passed}/3 passed`);
if (failures.length) throw new AggregateError(failures, `${failures.length} request-id retry assertion(s) failed`);
