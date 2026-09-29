import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBudgetGate, emptyBudgetLedger } from './budget.mjs';

// Test-only serial transaction adapter; deliberately NOT offered for deployment.
function fixture() {
  let state = emptyBudgetLedger(), tail = Promise.resolve(), at = Date.UTC(2026, 8, 28);
  const store = { transaction(fn) {
    const next = tail.then(() => { const draft = structuredClone(state); const result = fn(draft); state = draft; return result; });
    tail = next.catch(() => {}); return next;
  } };
  return { gate: createBudgetGate({store, now:()=>at}), state:()=>state, time:value=>{at=value;} };
}
const request = (id, amount=1_000_000, provider='Claude') => ({id,provider,model:'pinned-model',priceVersion:'approved-v1',worstCaseMicroUsd:amount});
test('missing atomic adapter fails closed',()=>assert.throws(()=>createBudgetGate(),/DURABLE_STORE_REQUIRED/));
test('concurrent providers share one 20 dollar cap',async()=>{
  const f=fixture(); const outcomes=await Promise.allSettled(Array.from({length:30},(_,i)=>f.gate.reserve(request('r'+i,1_000_000,['Claude','Grok','Gemini'][i%3]))));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,20); assert.equal(f.state().months['2026-09'],20_000_000);
});
test('duplicate reservation never authorizes another dispatch',async()=>{
  const f=fixture(); const replies=await Promise.all(Array.from({length:10},()=>f.gate.reserve(request('same'))));
  assert.equal(replies.filter(x=>x.dispatch).length,1);
  await assert.rejects(f.gate.reserve(request('same',2_000_000)),/CONFLICT/);
});
test('unknown outcome and settlement do not refund reserved cost',async()=>{
  const f=fixture(); await f.gate.reserve(request('timeout',10_000_000)); await f.gate.reserve(request('success',10_000_000));
  await f.gate.settle('success',1); await assert.rejects(f.gate.reserve(request('next')),/CAP_REACHED/);
});
test('UTC rollover retains old pending reservation and global replay protection',async()=>{
  const f=fixture(); await f.gate.reserve(request('old',20_000_000)); f.time(Date.UTC(2026,9,1));
  assert.equal((await f.gate.reserve(request('old',20_000_000))).dispatch,false);
  assert.equal((await f.gate.reserve(request('new',20_000_000))).dispatch,true);
  await f.gate.settle('old',2); assert.equal(f.state().months['2026-10'],20_000_000);
});
test('clock rollback blocks reservation and settlement',async()=>{
  const f=fixture(); await f.gate.reserve(request('first')); f.time(0);
  await assert.rejects(f.gate.reserve(request('next')),/CLOCK_ROLLBACK/); await assert.rejects(f.gate.settle('first',1),/CLOCK_ROLLBACK/);
});
test('invalid amount/identity rejected without spending',async()=>{
  const f=fixture(); for(const amount of [-1,0,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER]) await assert.rejects(f.gate.reserve(request('bad',amount)),/INVALID/);
  assert.equal(Object.keys(f.state().months).length,0);
});
test('underestimated price freezes all providers and never masks overrun',async()=>{
  const f=fixture(); await f.gate.reserve(request('under')); assert.equal((await f.gate.settle('under',2_000_000)).blocked,true);
  await assert.rejects(f.gate.reserve(request('grok',1,'Grok')),/BLOCKED/);
  await assert.rejects(f.gate.settle('under',1),/CONFLICT/);
});
test('corrupt month or reservation fails without a ledger mutation',async()=>{
  for (const corrupt of [s=>{s.months['2026-09']=null;},s=>{delete s.operations.first.reserved;},s=>{s.months['2026-09']=0;}]) {
    const f=fixture(); await f.gate.reserve(request('first')); corrupt(f.state()); const before=structuredClone(f.state());
    await assert.rejects(f.gate.reserve(request('next')),/INVALID_LEDGER/);
    await assert.rejects(f.gate.settle('first',1),/INVALID_LEDGER/);
    assert.deepEqual(f.state(),before);
  }
});
